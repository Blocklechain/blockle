//! Minimal HTTP/1.1 primitives over std TCP — enough for JSON-RPC clients,
//! the simulated chain's RPC server, and the dashboard. No async runtime,
//! no TLS (pools talk to their own nodes on localhost/LAN).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

/// Parse `http://host:port[/path]` into (host:port, path).
pub fn parse_url(url: &str) -> Result<(String, String)> {
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

/// POST a body and return the response body. Timeouts keep probing snappy.
pub fn post(url: &str, content_type: &str, body: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    let (hostport, path) = parse_url(url)?;
    let mut stream = TcpStream::connect(&hostport)
        .map_err(|e| anyhow!("cannot connect to {hostport}: {e}"))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    read_response(&mut stream)
}

fn read_response(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut reader = BufReader::new(stream);
    let mut status = String::new();
    reader.read_line(&mut status)?;
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .map(|v| v.trim().to_string())
        {
            content_length = v.parse().ok();
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

/// A parsed inbound HTTP request (server side).
pub struct Request {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
}

/// Read one request from an accepted connection.
pub fn read_request(stream: &mut TcpStream) -> Result<Request> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut start = String::new();
    reader.read_line(&mut start)?;
    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .map(|v| v.trim().to_string())
        {
            content_length = v.parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok(Request { method, path, body })
}

/// Write a response with a body.
pub fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
