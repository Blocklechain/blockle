//! A built-in CPU miner speaking stratum v1 — used by `blockle demo` and the
//! end-to-end tests to prove a generated pool actually produces blocks.
//! It is a real external client: plain TCP, JSON lines, no shared state with
//! the pool.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::btc;

pub struct MinerReport {
    pub shares_accepted: u64,
    pub shares_rejected: u64,
}

struct NotifyJob {
    job_id: String,
    prev_le: [u8; 32],
    coinb1: Vec<u8>,
    coinb2: Vec<u8>,
    branch: Vec<[u8; 32]>,
    version: u32,
    nbits: u32,
    ntime: u32,
}

fn parse_notify(params: &[Value]) -> Result<NotifyJob> {
    let s = |i: usize| -> Result<&str> {
        params
            .get(i)
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("notify param {i} missing"))
    };
    let branch = params
        .get(4)
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("notify branch missing"))?
        .iter()
        .filter_map(|v| {
            let bytes = hex::decode(v.as_str()?).ok()?;
            let h: [u8; 32] = bytes.try_into().ok()?;
            Some(h)
        })
        .collect();
    Ok(NotifyJob {
        job_id: s(0)?.to_string(),
        prev_le: prevhash_le(s(1)?)?,
        coinb1: hex::decode(s(2)?)?,
        coinb2: hex::decode(s(3)?)?,
        branch,
        version: u32::from_str_radix(s(5)?, 16)?,
        nbits: u32::from_str_radix(s(6)?, 16)?,
        ntime: u32::from_str_radix(s(7)?, 16)?,
    })
}

/// Undo the stratum prevhash word-swap back to LE bytes.
fn prevhash_le(stratum_hex: &str) -> Result<[u8; 32]> {
    let swapped: [u8; 32] = hex::decode(stratum_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad prevhash length"))?;
    let mut le = [0u8; 32];
    for (i, chunk) in swapped.chunks(4).enumerate() {
        le[i * 4] = chunk[3];
        le[i * 4 + 1] = chunk[2];
        le[i * 4 + 2] = chunk[1];
        le[i * 4 + 3] = chunk[0];
    }
    Ok(le)
}

struct Client {
    writer: TcpStream,
    reader: BufReader<TcpStream>,
    extranonce1: Vec<u8>,
    extranonce2_size: usize,
    diff_k: i32,
    job: Option<NotifyJob>,
    accepted: u64,
    rejected: u64,
    next_id: i64,
}

impl Client {
    /// Process one inbound message. Returns the id of an answered request,
    /// if it was a reply.
    fn process(&mut self, msg: &Value) -> Option<i64> {
        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            match method {
                "mining.set_difficulty" => {
                    let d = msg["params"][0].as_f64().unwrap_or(1.0);
                    self.diff_k = d.max(f64::MIN_POSITIVE).log2().round() as i32;
                }
                "mining.notify" => {
                    if let Ok(j) = parse_notify(msg["params"].as_array().unwrap_or(&vec![])) {
                        self.job = Some(j);
                    }
                }
                _ => {}
            }
            return None;
        }
        let id = msg.get("id").and_then(|i| i.as_i64())?;
        if id == 1 {
            if let Some(r) = msg.get("result").and_then(|r| r.as_array()) {
                self.extranonce1 = hex::decode(r[1].as_str().unwrap_or_default()).unwrap_or_default();
                self.extranonce2_size = r[2].as_u64().unwrap_or(4) as usize;
            }
        } else if id >= 10 {
            // a share reply
            if msg.get("result") == Some(&json!(true)) {
                self.accepted += 1;
            } else {
                self.rejected += 1;
            }
        }
        Some(id)
    }

    fn read_one(&mut self) -> Result<Option<Value>> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => bail!("pool closed the connection"),
            Ok(_) => {
                if line.trim().is_empty() {
                    return Ok(None);
                }
                Ok(Some(serde_json::from_str(&line)?))
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

/// Mine against a stratum endpoint until `shares_wanted` accepted shares or
/// the deadline.
pub fn mine(
    stratum_addr: &str,
    worker: &str,
    shares_wanted: u64,
    timeout: Duration,
) -> Result<MinerReport> {
    let stream = TcpStream::connect(stratum_addr)
        .map_err(|e| anyhow!("cannot reach stratum at {stratum_addr}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    let mut c = Client {
        writer: stream.try_clone()?,
        reader: BufReader::new(stream),
        extranonce1: Vec::new(),
        extranonce2_size: 4,
        diff_k: 0,
        job: None,
        accepted: 0,
        rejected: 0,
        next_id: 10,
    };
    writeln!(c.writer, "{}", json!({"id": 1, "method": "mining.subscribe", "params": ["blockle-demo-miner/1.0"]}))?;
    writeln!(c.writer, "{}", json!({"id": 2, "method": "mining.authorize", "params": [worker, "x"]}))?;

    let deadline = Instant::now() + timeout;
    let mut attempt: u64 = 0;

    // Handshake: wait until we have extranonce, difficulty, and a job.
    while c.extranonce1.is_empty() || c.job.is_none() {
        if Instant::now() > deadline {
            bail!("handshake timed out");
        }
        if let Some(msg) = c.read_one()? {
            c.process(&msg);
        }
    }

    while c.accepted < shares_wanted {
        if Instant::now() > deadline {
            bail!("miner timed out ({} accepted, {} rejected)", c.accepted, c.rejected);
        }
        // Drain any pushes (new jobs / difficulty changes).
        while let Some(msg) = c.read_one()? {
            c.process(&msg);
        }

        let target = btc::share_target(c.diff_k);
        let (job_id, mut extranonce2, root, prev_le, version, nbits, ntime) = {
            let j = c.job.as_ref().expect("job present after handshake");
            let mut extranonce2 = vec![0u8; c.extranonce2_size];
            let bytes = attempt.to_le_bytes();
            let n = extranonce2.len().min(8);
            extranonce2[..n].copy_from_slice(&bytes[..n]);
            let mut coinbase = j.coinb1.clone();
            coinbase.extend_from_slice(&c.extranonce1);
            coinbase.extend_from_slice(&extranonce2);
            coinbase.extend_from_slice(&j.coinb2);
            let root = btc::merkle_root_from_branch(btc::dsha256(&coinbase), &j.branch);
            (j.job_id.clone(), extranonce2, root, j.prev_le, j.version, j.nbits, j.ntime)
        };
        attempt += 1;

        let mut found = None;
        for nonce in 0u32..2_000_000 {
            let header = btc::header_bytes(version, &prev_le, &root, ntime, nbits, nonce);
            if btc::hash_meets_target(&btc::dsha256(&header), &target) {
                found = Some(nonce);
                break;
            }
        }
        let Some(nonce) = found else { continue };

        let id = c.next_id;
        c.next_id += 1;
        writeln!(
            c.writer,
            "{}",
            json!({"id": id, "method": "mining.submit",
                   "params": [worker, job_id, hex::encode(&extranonce2),
                               format!("{ntime:08x}"), format!("{nonce:08x}")]})
        )?;
        let _ = extranonce2.pop();

        // Wait for this share's reply (processing pushes meanwhile).
        let reply_deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if Instant::now() > reply_deadline {
                break;
            }
            match c.read_one()? {
                Some(msg) => {
                    if c.process(&msg) == Some(id) {
                        break;
                    }
                }
                None => continue,
            }
        }
    }
    Ok(MinerReport { shares_accepted: c.accepted, shares_rejected: c.rejected })
}
