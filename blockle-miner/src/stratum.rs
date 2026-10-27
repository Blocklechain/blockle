//! Minimal Stratum v1 client (subscribe / authorize / notify / set_difficulty /
//! submit). Works with any standard Bitcoin-family stratum pool, not just
//! Blockle's — the protocol is identical; only the header PoW hash differs.
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::hash::prevhash_le;

/// A `mining.notify` job (one unit of work from the pool).
#[derive(Clone)]
pub struct Job {
    pub job_id: String,
    pub prev_le: [u8; 32],
    pub coinb1: Vec<u8>,
    pub coinb2: Vec<u8>,
    pub branch: Vec<[u8; 32]>,
    pub version: u32,
    pub nbits: u32,
    pub ntime: u32,
    pub clean: bool,
}

pub fn parse_notify(params: &[Value]) -> Result<Job> {
    let s = |i: usize| -> Result<&str> {
        params.get(i).and_then(|v| v.as_str()).ok_or_else(|| anyhow!("notify param {i} missing"))
    };
    let branch = params
        .get(4)
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("notify merkle branch missing"))?
        .iter()
        .filter_map(|v| hex::decode(v.as_str()?).ok()?.try_into().ok())
        .collect();
    Ok(Job {
        job_id: s(0)?.to_string(),
        prev_le: prevhash_le(s(1)?)?,
        coinb1: hex::decode(s(2)?)?,
        coinb2: hex::decode(s(3)?)?,
        branch,
        version: u32::from_str_radix(s(5)?, 16)?,
        nbits: u32::from_str_radix(s(6)?, 16)?,
        ntime: u32::from_str_radix(s(7)?, 16)?,
        clean: params.get(8).and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// A live stratum connection. The caller owns it on one thread (reads jobs +
/// submits shares); worker threads mine from shared state.
pub struct Conn {
    writer: TcpStream,
    reader: BufReader<TcpStream>,
    next_id: i64,
}

impl Conn {
    pub fn connect(addr: &str) -> Result<Conn> {
        let stream = TcpStream::connect(addr)
            .map_err(|e| anyhow!("cannot reach stratum at {addr}: {e}"))?;
        stream.set_read_timeout(Some(Duration::from_millis(400)))?;
        Ok(Conn {
            writer: stream.try_clone()?,
            reader: BufReader::new(stream),
            next_id: 100,
        })
    }

    pub fn subscribe_and_authorize(&mut self, user: &str, pass: &str) -> Result<()> {
        writeln!(self.writer, "{}", json!({"id":1,"method":"mining.subscribe","params":["blockle-miner/0.1.0"]}))?;
        writeln!(self.writer, "{}", json!({"id":2,"method":"mining.authorize","params":[user, pass]}))?;
        Ok(())
    }

    /// Read one JSON message (None on idle timeout / blank line).
    pub fn read_one(&mut self) -> Result<Option<Value>> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => bail!("pool closed the connection"),
            Ok(_) => {
                if line.trim().is_empty() {
                    return Ok(None);
                }
                Ok(Some(serde_json::from_str(&line)?))
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Submit a found share; returns the request id used (to match the reply).
    pub fn submit(&mut self, user: &str, job_id: &str, extranonce2_hex: &str, ntime: u32, nonce: u32) -> Result<i64> {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(
            self.writer,
            "{}",
            json!({"id": id, "method": "mining.submit",
                   "params": [user, job_id, extranonce2_hex, format!("{ntime:08x}"), format!("{nonce:08x}")]})
        )?;
        Ok(id)
    }
}
