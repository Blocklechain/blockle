//! Minimal HTTP client for the settlement executor (batch fetch + biz
//! mark-settled). Plain HTTP, std sockets.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

fn parse_url(url: &str) -> Result<(String, String)> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("only http:// URLs are supported (got {url:?})"))?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if hostport.is_empty() {
        bail!("empty host in {url:?}");
    }
    Ok((hostport.to_string(), path.to_string()))
}

fn read_body(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?; // status
    let mut content_length: Option<usize> = None;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim();
        if h.is_empty() {
            break;
        }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().ok();
        }
    }
    let mut body = Vec::new();
    match content_length {
        Some(n) => {
            body.resize(n, 0);
            reader.read_exact(&mut body)?;
        }
        None => {
            reader.read_to_end(&mut body)?;
        }
    }
    Ok(body)
}

pub fn get(url: &str) -> Result<Vec<u8>> {
    let (hostport, path) = parse_url(url)?;
    let mut stream = TcpStream::connect(&hostport)
        .map_err(|e| anyhow!("cannot connect to {hostport}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n")?;
    read_body(&mut stream)
}

pub fn post_json(url: &str, body: &[u8]) -> Result<Vec<u8>> {
    let (hostport, path) = parse_url(url)?;
    let mut stream = TcpStream::connect(&hostport)
        .map_err(|e| anyhow!("cannot connect to {hostport}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    read_body(&mut stream)
}
