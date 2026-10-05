//! A Bitcoin-compatible JSON-RPC server for the BLOCK chain.
//!
//! Implements the bitcoind method surface that block explorers (Eiquidus),
//! wallets, and mining/monitoring tooling expect — `getblockchaininfo`,
//! `getblock`, `getrawtransaction`, `getrawmempool`, `getmininginfo`, and
//! friends — translating BLOCK's data model (bech32 `block1…` addresses,
//! 1e8 base units, AuxPoW-or-native blocks, shielded bundles) into the
//! familiar bitcoind JSON shapes. Reads are served from a live chain
//! snapshot; this is a read/monitoring RPC, not a wallet RPC.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};

use blockle_chain::{Chain, U256};
use blockle_core::keys::encode_address;
use blockle_core::{display_hash, Block, Hash32, Transaction};
use blockle_pow::difficulty::compact_to_target;

use crate::p2p::Node;

const COIN: f64 = 100_000_000.0;

pub struct RpcAuth {
    pub user: String,
    pub pass: String,
}

/// Start the JSON-RPC server (spawns a thread; returns immediately).
pub fn serve(node: Arc<Node>, listen: String, auth: Option<RpcAuth>) {
    let token = auth.map(|a| base64(format!("{}:{}", a.user, a.pass).as_bytes()));
    thread::spawn(move || {
        let listener = match TcpListener::bind(&listen) {
            Ok(l) => {
                println!("[rpc] bitcoin-compatible JSON-RPC on http://{listen}/");
                l
            }
            Err(e) => {
                println!("[rpc] cannot listen on {listen}: {e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let node = node.clone();
            let token = token.clone();
            thread::spawn(move || handle(node, token, stream));
        }
    });
}

fn handle(node: Arc<Node>, token: Option<String>, mut stream: TcpStream) {
    let Some((headers, body)) = read_http(&mut stream) else { return };
    // Optional HTTP basic auth.
    if let Some(expected) = &token {
        let got = headers
            .lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("authorization: basic ").map(|v| v.trim().to_string()));
        if got.as_deref() != Some(expected.as_str()) {
            let _ = write!(stream, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
    }
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    // Support a single call or a batch.
    let reply = if let Some(arr) = req.as_array() {
        Value::Array(arr.iter().map(|r| dispatch(&node, r)).collect())
    } else {
        dispatch(&node, &req)
    };
    let payload = reply.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
}

fn dispatch(node: &Arc<Node>, req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!([]));
    match call(node, method, &params) {
        Ok(result) => json!({"result": result, "error": null, "id": id}),
        Err((code, msg)) => json!({"result": null, "error": {"code": code, "message": msg}, "id": id}),
    }
}

type RpcErr = (i64, String);
fn err(code: i64, msg: &str) -> RpcErr {
    (code, msg.to_string())
}

fn difficulty_from_bits(bits: u32) -> f64 {
    // bitcoin convention: diff1 target / current target.
    let diff1 = compact_to_target(0x1d00ffff).unwrap_or_default();
    let cur = compact_to_target(bits).unwrap_or(U256::one());
    if cur.is_zero() {
        return 0.0;
    }
    u256_f64(diff1) / u256_f64(cur).max(1.0)
}

fn u256_f64(v: U256) -> f64 {
    v.0[0] as f64 + v.0[1] as f64 * 2f64.powi(64) + v.0[2] as f64 * 2f64.powi(128) + v.0[3] as f64 * 2f64.powi(192)
}

fn call(node: &Arc<Node>, method: &str, params: &Value) -> Result<Value, RpcErr> {
    let p = |i: usize| params.get(i).cloned().unwrap_or(Value::Null);
    match method {
        "getblockcount" => {
            let (chain, _) = node.snapshot();
            Ok(json!(chain.height().unwrap_or(0)))
        }
        "getbestblockhash" => {
            let (chain, _) = node.snapshot();
            Ok(json!(chain.blocks.last().map(|b| display_hash(&b.header.hash())).unwrap_or_default()))
        }
        "getblockchaininfo" => {
            let (chain, _) = node.snapshot();
            let tip = chain.blocks.last();
            let bits = tip.map(|b| b.header.bits).unwrap_or(0);
            Ok(json!({
                "chain": net_name(&chain),
                "blocks": chain.height().unwrap_or(0),
                "headers": chain.height().unwrap_or(0),
                "bestblockhash": tip.map(|b| display_hash(&b.header.hash())).unwrap_or_default(),
                "difficulty": difficulty_from_bits(bits),
                "mediantime": chain.median_time_past(),
                "time": tip.map(|b| b.header.time).unwrap_or(0),
                "verificationprogress": 1.0,
                "initialblockdownload": false,
                "chainwork": hex::encode({ let mut be=[0u8;32]; chain.total_work().to_big_endian(&mut be); be }),
                "size_on_disk": 0,
                "pruned": false,
                "warnings": "",
            }))
        }
        "getdifficulty" => {
            let (chain, _) = node.snapshot();
            Ok(json!(difficulty_from_bits(chain.blocks.last().map(|b| b.header.bits).unwrap_or(0))))
        }
        "getmininginfo" => {
            let (chain, mempool) = node.snapshot();
            let bits = chain.blocks.last().map(|b| b.header.bits).unwrap_or(0);
            let diff = difficulty_from_bits(bits);
            // networkhashps ≈ difficulty * 2^32 / spacing.
            let nethash = diff * 4_294_967_296.0 / chain.params.target_spacing.max(1) as f64;
            Ok(json!({
                "blocks": chain.height().unwrap_or(0),
                "difficulty": diff,
                "networkhashps": nethash,
                "pooledtx": mempool.len(),
                "chain": net_name(&chain),
                "warnings": "",
            }))
        }
        "getnetworkinfo" => Ok(json!({
            "version": 300200,
            "subversion": "/Blockle:0.2/",
            "protocolversion": 2,
            "connections": node.peer_count(),
            "networkactive": true,
            "warnings": "",
        })),
        "getconnectioncount" => Ok(json!(node.peer_count())),
        "getblockhash" => {
            let h = p(0).as_u64().ok_or_else(|| err(-1, "height required"))?;
            let (chain, _) = node.snapshot();
            chain
                .blocks
                .get(h as usize)
                .map(|b| json!(display_hash(&b.header.hash())))
                .ok_or_else(|| err(-8, "block height out of range"))
        }
        "getblockheader" => {
            let (chain, _) = node.snapshot();
            let (h, b) = find_block(&chain, &p(0)).ok_or_else(|| err(-5, "block not found"))?;
            let verbose = p(1).as_bool().unwrap_or(true);
            if !verbose {
                return Ok(json!(hex::encode(b.header.serialize())));
            }
            Ok(block_header_json(&chain, h, b))
        }
        "getblock" => {
            let (chain, _) = node.snapshot();
            let (h, b) = find_block(&chain, &p(0)).ok_or_else(|| err(-5, "block not found"))?;
            let verbosity = match p(1) {
                Value::Bool(false) => 0,
                Value::Bool(true) | Value::Null => 1,
                v => v.as_u64().unwrap_or(1) as u8,
            };
            if verbosity == 0 {
                return Ok(json!(hex::encode(block_bytes(b))));
            }
            let mut j = block_header_json(&chain, h, b);
            let obj = j.as_object_mut().unwrap();
            obj.insert("size".into(), json!(b.serialized_size()));
            obj.insert("nTx".into(), json!(b.transactions.len()));
            if verbosity >= 2 {
                let idx = outpoint_index(&chain);
                obj.insert(
                    "tx".into(),
                    json!(b.transactions.iter().map(|t| tx_json(&chain, &idx, t, Some(h), Some(b.header.time))).collect::<Vec<_>>()),
                );
            } else {
                obj.insert("tx".into(), json!(b.transactions.iter().map(|t| display_hash(&t.txid())).collect::<Vec<_>>()));
            }
            Ok(j)
        }
        "getrawtransaction" => {
            let txid = p(0).as_str().ok_or_else(|| err(-1, "txid required"))?.to_string();
            let verbose = matches!(p(1), Value::Bool(true)) || p(1).as_u64() == Some(1);
            let (chain, mempool) = node.snapshot();
            let idx = outpoint_index(&chain);
            for (h, b) in chain.blocks.iter().enumerate() {
                for t in &b.transactions {
                    if display_hash(&t.txid()) == txid {
                        return Ok(if verbose {
                            let mut j = tx_json(&chain, &idx, t, Some(h as u64), Some(b.header.time));
                            j.as_object_mut().unwrap().insert("blockhash".into(), json!(display_hash(&b.header.hash())));
                            j
                        } else {
                            json!(hex::encode(t.encode(false)))
                        });
                    }
                }
            }
            for t in &mempool {
                if display_hash(&t.txid()) == txid {
                    return Ok(if verbose {
                        tx_json(&chain, &idx, t, None, None)
                    } else {
                        json!(hex::encode(t.encode(false)))
                    });
                }
            }
            Err(err(-5, "No such mempool or blockchain transaction"))
        }
        "getrawmempool" => {
            let (_, mempool) = node.snapshot();
            Ok(json!(mempool.iter().map(|t| display_hash(&t.txid())).collect::<Vec<_>>()))
        }
        "uptime" => Ok(json!(0)),
        "ping" => Ok(Value::Null),
        "help" => Ok(json!("Blockle bitcoin-compatible RPC: getblockchaininfo getblockcount getbestblockhash getblockhash getblock getblockheader getrawtransaction getrawmempool getmininginfo getnetworkinfo getconnectioncount getdifficulty")),
        other => Err(err(-32601, &format!("Method not found: {other}"))),
    }
}

fn net_name(chain: &Chain) -> &'static str {
    match chain.params.name.as_str() {
        "blockle-main" => "main",
        "blockle-test" => "test",
        _ => "regtest",
    }
}

fn find_block<'a>(chain: &'a Chain, id: &Value) -> Option<(u64, &'a Block)> {
    if let Some(s) = id.as_str() {
        return chain
            .blocks
            .iter()
            .enumerate()
            .find(|(_, b)| display_hash(&b.header.hash()) == s)
            .map(|(h, b)| (h as u64, b));
    }
    if let Some(h) = id.as_u64() {
        return chain.blocks.get(h as usize).map(|b| (h, b));
    }
    None
}

fn block_bytes(b: &Block) -> Vec<u8> {
    let mut out = b.header.serialize();
    for t in &b.transactions {
        out.extend(t.encode(false));
    }
    out
}

fn block_header_json(chain: &Chain, height: u64, b: &Block) -> Value {
    let tip = chain.height().unwrap_or(0);
    let h = &b.header;
    json!({
        "hash": display_hash(&h.hash()),
        "confirmations": tip.saturating_sub(height) + 1,
        "height": height,
        "version": h.version,
        "versionHex": format!("{:08x}", h.version),
        "merkleroot": display_hash(&h.merkle_root),
        "time": h.time,
        "mediantime": h.time,
        "nonce": u32::from_le_bytes(h.nonce[..4].try_into().unwrap_or([0;4])),
        "bits": format!("{:08x}", h.bits),
        "difficulty": difficulty_from_bits(h.bits),
        "previousblockhash": display_hash(&h.prev_hash),
        "nextblockhash": chain.blocks.get(height as usize + 1).map(|nb| display_hash(&nb.header.hash())),
        "lane": Chain::lane_of(b),
    })
}

fn outpoint_index(chain: &Chain) -> HashMap<(Hash32, u32), (String, u64)> {
    let mut m = HashMap::new();
    for b in &chain.blocks {
        for t in &b.transactions {
            let txid = t.txid();
            for (vout, o) in t.outputs.iter().enumerate() {
                m.insert((txid, vout as u32), (encode_address(&o.recipient), o.amount));
            }
        }
    }
    m
}

fn tx_json(
    chain: &Chain,
    idx: &HashMap<(Hash32, u32), (String, u64)>,
    tx: &Transaction,
    height: Option<u64>,
    time: Option<u32>,
) -> Value {
    let txid = display_hash(&tx.txid());
    let is_coinbase = tx.is_coinbase();
    let mut vin: Vec<Value> = Vec::new();
    if is_coinbase {
        vin.push(json!({"coinbase": hex::encode(&tx.coinbase_data), "sequence": 4294967295u32}));
    } else {
        for i in &tx.inputs {
            let resolved = idx.get(&(i.prev.txid, i.prev.vout));
            vin.push(json!({
                "txid": display_hash(&i.prev.txid),
                "vout": i.prev.vout,
                "prevout": resolved.map(|(a, v)| json!({"value": *v as f64 / COIN, "scriptPubKey": {"address": a}})),
                "sequence": 4294967295u32,
            }));
        }
    }
    let vout: Vec<Value> = tx
        .outputs
        .iter()
        .enumerate()
        .map(|(n, o)| {
            json!({
                "value": o.amount as f64 / COIN,
                "n": n,
                "scriptPubKey": {"address": encode_address(&o.recipient), "type": "witness_v0_keyhash"},
            })
        })
        .collect();
    let confirmations = height.and_then(|h| chain.height().map(|t| t.saturating_sub(h) + 1));
    json!({
        "txid": txid,
        "hash": display_hash(&tx.txid()),
        "version": tx.version,
        "size": tx.serialized_size(),
        "vin": vin,
        "vout": vout,
        "time": time,
        "blocktime": time,
        "confirmations": confirmations,
        "shielded": tx.shielded.as_ref().map(|b| json!({
            "spends": b.spends.len(), "outputs": b.outputs.len(), "transfers": b.transfers.len(),
        })),
    })
}

// ---------- minimal HTTP ----------

fn read_http(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end;
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
        if buf.len() > 1 << 20 {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let len: usize = head
        .to_lowercase()
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + len {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    Some((head, buf[header_end..].to_vec()))
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
