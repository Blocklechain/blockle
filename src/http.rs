//! Minimal HTTP/1.1 primitives over std TCP — enough for JSON-RPC clients,
//! the simulated chain's RPC server, and the dashboard. No async runtime,
//! no TLS (pools talk to their own nodes on localhost/LAN).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

/// Connect with the caller's deadline applied to the CONNECT too.
///
/// `TcpStream::connect` has no timeout — it waits as long as the OS will,
/// which for a SYN that is accepted into a backlog and never served, or a host
/// that drops packets, is minutes. The read and write deadlines below were
/// always set, so this was the one unbounded wait left in the path: the site
/// calls the node's explorer API on 8445 to render pages, and the node does not
/// serve that port until it has replayed the whole chain (~17 minutes after a
/// restart). blockle-biz then stopped answering at all — active, no log output,
/// nginx returning 504 on blockle.org — and came back instantly on restart.
///
/// `connect_timeout` needs a resolved SocketAddr rather than a host string, so
/// resolution happens here and the FIRST address is used. That is the same
/// choice `TcpStream::connect` makes implicitly; the difference is that a
/// failure to resolve is now an error with the host in it instead of a hang.
///
/// biz.rs's pool monitor already did this (`TcpStream::connect_timeout`, 3s).
/// This file did not, and the inconsistency is what made a routine node
/// restart take the website down with it.
fn connect_with_timeout(hostport: &str, timeout: Duration) -> Result<TcpStream> {
    let addr = hostport
        .to_socket_addrs()
        .map_err(|e| anyhow!("cannot resolve {hostport}: {e}"))?
        .next()
        .ok_or_else(|| anyhow!("{hostport} resolved to no addresses"))?;
    TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| anyhow!("cannot connect to {hostport} within {timeout:?}: {e}"))
}

/// Parse `http://host:port[/path]` into (host:port, path).
pub fn parse_url(url: &str) -> Result<(String, String)> {
    let (host, path, _) = parse_url_auth(url)?;
    Ok((host, path))
}

/// Like [`parse_url`] but also extracts `user:pass@` credentials as a
/// ready-made basic-auth token (bitcoind-style RPC URLs).
pub fn parse_url_auth(url: &str) -> Result<(String, String, Option<String>)> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("only http:// URLs are supported (got {url:?})"))?;
    let (mut hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let mut auth = None;
    if let Some(at) = hostport.rfind('@') {
        auth = Some(base64(hostport[..at].as_bytes()));
        hostport = &hostport[at + 1..];
    }
    if hostport.is_empty() {
        bail!("empty host in {url:?}");
    }
    Ok((hostport.to_string(), path.to_string(), auth))
}

fn base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// POST a body and return the response body. Timeouts keep probing snappy.
pub fn get(url: &str, timeout: Duration) -> Result<Vec<u8>> {
    let (host, path) = parse_url(url)?;
    let mut stream = connect_with_timeout(&host, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )?;
    read_response(&mut stream)
}

pub fn post(url: &str, content_type: &str, body: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    let (hostport, path, auth) = parse_url_auth(url)?;
    let mut stream = connect_with_timeout(&hostport, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let auth_header = auth
        .map(|a| format!("Authorization: Basic {a}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: {hostport}\r\n{auth_header}Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
    // Baseline security headers on every response: nosniff stops MIME-sniffing an asset
    // into executable HTML; SAMEORIGIN blocks cross-origin framing/clickjacking (matters
    // most for the key-holding /wallet page). The wallet page adds a strict CSP via meta.
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: SAMEORIGIN\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
