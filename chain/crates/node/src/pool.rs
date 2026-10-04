//! Pool-side node services: the chain-explorer snapshot the website reads,
//! and the merged-mining work interface external parent pools drive.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use std::collections::HashMap;

use blockle_chain::Chain;
use blockle_core::keys::{decode_address, encode_address, Address};
use blockle_core::{display_hash, AuxPow, Block};
use blockle_pow::difficulty::compact_to_target;

use crate::p2p::Node;

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Every 30 s, write a chain snapshot (status + recent blocks) the website
/// renders as the BLOCK explorer.
pub fn spawn_explorer_writer(node: Arc<Node>, path: PathBuf) {
    thread::spawn(move || loop {
        let (chain, mempool) = node.snapshot();
        let p = &chain.params;
        let supply: u64 = chain
            .blocks
            .iter()
            .map(|b| b.transactions[0].outputs.iter().map(|o| o.amount).sum::<u64>())
            .sum();
        let lanes: Vec<Value> = chain
            .lanes()
            .iter()
            .map(|lane| {
                json!({
                    "lane": lane,
                    "next_bits": format!("{:08x}", chain.next_bits_for(lane)),
                    "blocks": chain.blocks.iter().filter(|b| Chain::lane_of(b) == *lane).count(),
                })
            })
            .collect();
        let blocks: Vec<Value> = chain
            .blocks
            .iter()
            .enumerate()
            .rev()
            .take(40)
            .map(|(height, b)| {
                let reward: u64 = b.transactions[0].outputs.iter().map(|o| o.amount).sum();
                json!({
                    "height": height,
                    "hash": display_hash(&b.header.hash()),
                    "time": b.header.time,
                    "lane": Chain::lane_of(b),
                    "txs": b.transactions.len(),
                    "reward": reward,
                    "miner": b.transactions[0]
                        .outputs
                        .first()
                        .map(|o| encode_address(&o.recipient))
                        .unwrap_or_default(),
                })
            })
            .collect();
        let out = json!({
            "name": p.name,
            "ticker": p.ticker,
            "height": chain.height(),
            "tip": chain.blocks.last().map(|b| json!({
                "hash": display_hash(&b.header.hash()),
                "time": b.header.time,
            })),
            "supply": supply,
            "premine": p.premine,
            "mempool": mempool.len(),
            "lanes": lanes,
            "blocks": blocks,
            "updated": now_unix(),
        });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, out.to_string());
        thread::sleep(Duration::from_secs(30));
    });
}

/// Merged-mining work interface (`createauxblock` / `submitauxblock`) for
/// external parent-chain pools. JSON-RPC over HTTP, one method per call:
///
/// - `createauxblock [payout_address, parent_algo]` → `{hash, chainid,
///   bits, target, height}` — a BLOCK template on that algorithm's lane
///   whose coinbase pays the caller.
/// - `submitauxblock [hash, auxpow]` → `true` once the parent proof is
///   attached and the block connects.
pub fn spawn_aux_http(node: Arc<Node>, listen: String) {
    let pending: Arc<Mutex<HashMap<String, Block>>> = Arc::new(Mutex::new(HashMap::new()));
    thread::spawn(move || {
        let listener = match TcpListener::bind(&listen) {
            Ok(l) => {
                println!("[aux] merged-mining work interface on http://{listen}/");
                l
            }
            Err(e) => {
                println!("[aux] cannot listen on {listen}: {e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let node = node.clone();
            let pending = pending.clone();
            thread::spawn(move || handle(node, pending, stream));
        }
    });
}

fn handle(node: Arc<Node>, pending: Arc<Mutex<HashMap<String, Block>>>, mut stream: TcpStream) {
    let Some(body) = read_http_body(&mut stream) else { return };
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "createauxblock" => createauxblock(&node, &pending, &params),
        "submitauxblock" => submitauxblock(&node, &pending, &params),
        "getauxchaininfo" => Ok(json!({
            "chainid": node.params().aux_chain_id,
            "algorithms": blockle_pow::parent::FIXED_HEADER_ALGOS
                .iter()
                .chain(["equihash"].iter())
                .collect::<Vec<_>>(),
        })),
        _ => Err("method not found".to_string()),
    };
    let reply = match result {
        Ok(v) => json!({"id": id, "result": v, "error": null}),
        Err(e) => json!({"id": id, "result": null, "error": {"code": -1, "message": e}}),
    };
    let payload = reply.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
}

fn createauxblock(
    node: &Arc<Node>,
    pending: &Arc<Mutex<HashMap<String, Block>>>,
    params: &Value,
) -> Result<Value, String> {
    let addr_s = params
        .get(0)
        .and_then(|v| v.as_str())
        .ok_or("params: [payout_address, parent_algo]")?;
    let algo = params
        .get(1)
        .and_then(|v| v.as_str())
        .unwrap_or("sha256d")
        .to_string();
    let address: Address =
        decode_address(addr_s).map_err(|_| "bad BLOCK payout address".to_string())?;
    let lane_ok = algo == "equihash"
        || blockle_pow::parent::FIXED_HEADER_ALGOS.contains(&algo.as_str());
    if !lane_ok {
        return Err(format!("unknown parent algorithm {algo}"));
    }
    let mut block = node
        .block_template_split(&[(address, 10_000)])
        .map_err(|e| e.to_string())?;
    let (chain, _) = node.snapshot();
    block.header.bits = chain.next_bits_for(&algo);
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];
    let hash = display_hash(&block.header.hash());
    let height = chain.height().map(|h| h + 1).unwrap_or(0);
    let target = compact_to_target(block.header.bits)
        .map(|t| {
            let mut be = [0u8; 32];
            t.to_big_endian(&mut be);
            hex::encode(be)
        })
        .unwrap_or_default();
    pending.lock().unwrap().insert(hash.clone(), block.clone());
    // Keep the pending set bounded.
    let mut p = pending.lock().unwrap();
    if p.len() > 256 {
        let drop_keys: Vec<String> = p.keys().take(p.len() - 256).cloned().collect();
        for k in drop_keys {
            p.remove(&k);
        }
    }
    Ok(json!({
        "hash": hash,
        "chainid": node.params().aux_chain_id,
        "algorithm": algo,
        "bits": format!("{:08x}", block.header.bits),
        "target": target,
        "height": height,
        "previousblockhash": display_hash(&block.header.prev_hash),
    }))
}

fn submitauxblock(
    node: &Arc<Node>,
    pending: &Arc<Mutex<HashMap<String, Block>>>,
    params: &Value,
) -> Result<Value, String> {
    let hash = params
        .get(0)
        .and_then(|v| v.as_str())
        .ok_or("params: [hash, auxpow]")?;
    let auxpow: AuxPow = serde_json::from_value(
        params.get(1).cloned().ok_or("params: [hash, auxpow]")?,
    )
    .map_err(|e| format!("bad auxpow: {e}"))?;
    let mut block = pending
        .lock()
        .unwrap()
        .get(hash)
        .cloned()
        .ok_or("unknown aux work (expired?)")?;
    block.aux_pow = Some(auxpow);
    if node.submit_block(block, None) {
        println!("[aux] merged-mined block {hash} accepted");
        Ok(json!(true))
    } else {
        Err("block rejected".into())
    }
}

fn read_http_body(stream: &mut TcpStream) -> Option<Vec<u8>> {
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
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
    let len: usize = headers
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
    Some(buf[header_end..].to_vec())
}
