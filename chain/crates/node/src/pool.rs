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
use blockle_core::{display_hash, AuxPow, Block, Transaction};
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
                    "next_bits": format!("{:08x}", chain.next_bits_for_at(lane, now_unix() as i64)),
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
    let pending: Arc<Mutex<HashMap<String, (Block, String)>>> = Arc::new(Mutex::new(HashMap::new()));
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

fn handle(node: Arc<Node>, pending: Arc<Mutex<HashMap<String, (Block, String)>>>, mut stream: TcpStream) {
    let Some((method_line, body)) = read_http_request(&mut stream) else { return };
    let mut parts = method_line.split_whitespace();
    let http_method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/").to_string();
    if http_method == "GET" {
        let (status, payload) = explorer_get(&node, &path);
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        return;
    }
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
        "submitrawtransaction" => submitrawtransaction(&node, &params),
        "callcontract" => callcontract(&node, &params),
        "tokeninfo" => tokeninfo(&node, &params),
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

/// Accept a light-wallet transaction: `submitrawtransaction [raw_hex]` where
/// raw_hex is the bincode-serialized transaction. The node fully validates it
/// (signatures, UTXOs, fees) before adding it to the mempool and gossiping.
fn submitrawtransaction(node: &Arc<Node>, params: &Value) -> Result<Value, String> {
    let raw_hex = params
        .get(0)
        .and_then(|v| v.as_str())
        .ok_or_else(|| "expected [raw_hex]".to_string())?;
    let raw = hex::decode(raw_hex).map_err(|_| "raw transaction is not valid hex".to_string())?;
    let tx: Transaction =
        bincode::deserialize(&raw).map_err(|_| "could not decode transaction".to_string())?;
    let txid = hex::encode(tx.txid());
    if node.submit_tx(tx, None) {
        Ok(json!({ "accepted": true, "txid": txid }))
    } else {
        Err("transaction rejected — invalid, double-spend, or already in the mempool".to_string())
    }
}

/// JSON-RPC params may arrive as `[obj]` or bare `obj`; normalize to the obj.
fn first_obj(params: &Value) -> Value {
    if let Some(a) = params.as_array() {
        a.first().cloned().unwrap_or(Value::Null)
    } else {
        params.clone()
    }
}

fn parse_hash32(s: &str) -> Result<[u8; 32], String> {
    let b = hex::decode(s).map_err(|_| "expected hex".to_string())?;
    if b.len() != 32 {
        return Err("expected 32-byte (64 hex char) value".to_string());
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&b);
    Ok(a)
}

/// Read-only contract view call. Executes the contract against current state
/// via `Chain::simulate_call` (clones+discards state — no chain mutation) and
/// returns the raw return bytes plus a convenience LE-u64 decode.
///   params: { contract: <64hex>, calldata: <hex>, caller?: <64hex>, gas?: u64 }
fn callcontract(node: &Arc<Node>, params: &Value) -> Result<Value, String> {
    let o = first_obj(params);
    let contract = parse_hash32(o.get("contract").and_then(|v| v.as_str()).unwrap_or(""))?;
    let calldata = hex::decode(o.get("calldata").and_then(|v| v.as_str()).unwrap_or(""))
        .map_err(|_| "calldata must be hex".to_string())?;
    let caller = match o.get("caller").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => parse_hash32(s)?,
        _ => [0u8; 32],
    };
    let gas = o.get("gas").and_then(|v| v.as_u64()).unwrap_or(10_000_000);
    let (chain, _) = node.snapshot();
    let r = chain.simulate_call(&contract, caller, &calldata, 0, gas);
    let mut u64v: Option<u64> = None;
    if r.return_data.len() >= 8 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&r.return_data[..8]);
        u64v = Some(u64::from_le_bytes(b));
    }
    Ok(json!({
        "success": r.success,
        "gasUsed": r.gas_used,
        "returnHex": hex::encode(&r.return_data),
        "u64": u64v,
    }))
}

/// Convenience reader for BLOCK-20 tokens: runs the standard getters and
/// returns metadata + (optional) a balance for `holder`.
///   params: { contract: <64hex>, holder?: <64hex address> }
/// BLOCK-20 selectors: 1 balanceOf(addr32) · 3 totalSupply() · 4 decimals()
/// · 5 name() · 6 symbol().
fn tokeninfo(node: &Arc<Node>, params: &Value) -> Result<Value, String> {
    let o = first_obj(params);
    let contract = parse_hash32(o.get("contract").and_then(|v| v.as_str()).unwrap_or(""))?;
    let (chain, _) = node.snapshot();
    let call = |sel: u8, extra: &[u8]| -> blockle_chain::contracts::CallResult {
        let mut input = vec![sel];
        input.extend_from_slice(extra);
        chain.simulate_call(&contract, [0u8; 32], &input, 0, 10_000_000)
    };
    let as_u64 = |r: &blockle_chain::contracts::CallResult| -> Option<u64> {
        if r.success && r.return_data.len() >= 8 {
            let mut b = [0u8; 8];
            b.copy_from_slice(&r.return_data[..8]);
            Some(u64::from_le_bytes(b))
        } else {
            None
        }
    };
    let as_str = |r: &blockle_chain::contracts::CallResult| -> Option<String> {
        if r.success {
            String::from_utf8(r.return_data.clone())
                .ok()
                .map(|s| s.trim_end_matches('\u{0}').to_string())
        } else {
            None
        }
    };
    let name = as_str(&call(5, &[]));
    let symbol = as_str(&call(6, &[]));
    let decimals = as_u64(&call(4, &[]));
    let total = as_u64(&call(3, &[]));
    let is_token = name.is_some() || symbol.is_some() || total.is_some();
    let balance = o.get("holder").and_then(|v| v.as_str()).and_then(|h| {
        parse_hash32(h).ok().and_then(|addr| as_u64(&call(1, &addr)))
    });
    Ok(json!({
        "contract": hex::encode(contract),
        "isToken": is_token,
        "name": name,
        "symbol": symbol,
        "decimals": decimals,
        "totalSupply": total,
        "balance": balance,
    }))
}

fn createauxblock(
    node: &Arc<Node>,
    pending: &Arc<Mutex<HashMap<String, (Block, String)>>>,
    params: &Value,
) -> Result<Value, String> {
    // Namecoin-style callers send []; ours send [address] or
    // [address, algo]. Default: the node wallet + sha256d.
    let algo = params
        .get(1)
        .and_then(|v| v.as_str())
        .unwrap_or("sha256d")
        .to_string();
    let address: Address = match params.get(0).and_then(|v| v.as_str()) {
        Some(addr_s) => decode_address(addr_s).map_err(|_| "bad BLOCK payout address".to_string())?,
        None => node
            .config
            .mine_to
            .ok_or("no default payout address — pass one or start the node with a wallet")?,
    };
    let lane_ok = algo == "equihash"
        || blockle_pow::parent::FIXED_HEADER_ALGOS.contains(&algo.as_str());
    if !lane_ok {
        return Err(format!("unknown parent algorithm {algo}"));
    }
    let mut block = node
        .block_template_split(&[(address, 10_000)])
        .map_err(|e| e.to_string())?;
    let (chain, _) = node.snapshot();
    block.header.bits = chain.next_bits_for_at(&algo, block.header.time as i64);
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
    pending.lock().unwrap().insert(hash.clone(), (block.clone(), algo.clone()));
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
    pending: &Arc<Mutex<HashMap<String, (Block, String)>>>,
    params: &Value,
) -> Result<Value, String> {
    let hash = params
        .get(0)
        .and_then(|v| v.as_str())
        .ok_or("params: [hash, auxpow]")?;
    let (mut block, algo) = pending
        .lock()
        .unwrap()
        .get(hash)
        .cloned()
        .ok_or("unknown aux work (expired?)")?;
    let auxpow: AuxPow = match params.get(1) {
        // Our native JSON form…
        Some(v @ Value::Object(_)) => {
            serde_json::from_value(v.clone()).map_err(|e| format!("bad auxpow: {e}"))?
        }
        // …or the Namecoin hex blob merged-mining software produces
        // (coinbase tx ‖ parent hash ‖ branches ‖ 80-byte parent header);
        // the parent algorithm comes from the matching createauxblock.
        Some(Value::String(hexblob)) => {
            let raw = hex::decode(hexblob.trim()).map_err(|_| "bad auxpow hex")?;
            parse_namecoin_auxpow(&raw, &algo)?
        }
        _ => return Err("params: [hash, auxpow]".into()),
    };
    block.aux_pow = Some(auxpow);
    if node.submit_block(block, None) {
        println!("[aux] merged-mined block {hash} accepted");
        Ok(json!(true))
    } else {
        Err("block rejected".into())
    }
}

fn read_http_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let (head, body) = read_http_raw(stream)?;
    let first = head.lines().next().unwrap_or("").to_string();
    Some((first, body))
}

fn read_http_raw(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
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

/// Length of a serialized legacy bitcoin transaction starting at `b[0]`.
fn legacy_tx_len(b: &[u8]) -> Option<usize> {
    let mut pos = 4usize; // version
    let (vin, n) = read_varint(b, pos)?;
    pos = n;
    for _ in 0..vin {
        pos += 36; // prevout
        let (slen, n) = read_varint(b, pos)?;
        pos = n + slen as usize + 4; // script + sequence
    }
    let (vout, n) = read_varint(b, pos)?;
    pos = n;
    for _ in 0..vout {
        pos += 8; // value
        let (slen, n) = read_varint(b, pos)?;
        pos = n + slen as usize;
    }
    pos += 4; // locktime
    (pos <= b.len()).then_some(pos)
}

fn read_varint(b: &[u8], pos: usize) -> Option<(u64, usize)> {
    match *b.get(pos)? {
        n @ 0..=0xfc => Some((n as u64, pos + 1)),
        0xfd => Some((u16::from_le_bytes(b.get(pos + 1..pos + 3)?.try_into().ok()?) as u64, pos + 3)),
        0xfe => Some((u32::from_le_bytes(b.get(pos + 1..pos + 5)?.try_into().ok()?) as u64, pos + 5)),
        _ => Some((u64::from_le_bytes(b.get(pos + 1..pos + 9)?.try_into().ok()?), pos + 9)),
    }
}

/// Parse the Namecoin merged-mining proof wire format into our [`AuxPow`].
fn parse_namecoin_auxpow(raw: &[u8], algo: &str) -> Result<AuxPow, String> {
    let bad = |m: &str| m.to_string();
    let cb_len = legacy_tx_len(raw).ok_or_else(|| bad("malformed parent coinbase"))?;
    let coinbase = raw[..cb_len].to_vec();
    let mut pos = cb_len;
    let _parent_hash = raw.get(pos..pos + 32).ok_or_else(|| bad("truncated"))?;
    pos += 32;
    let (n, p2) = read_varint(raw, pos).ok_or_else(|| bad("truncated"))?;
    pos = p2;
    let mut coinbase_branch = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let h: [u8; 32] = raw
            .get(pos..pos + 32)
            .and_then(|x| x.try_into().ok())
            .ok_or_else(|| bad("truncated branch"))?;
        coinbase_branch.push(h);
        pos += 32;
    }
    pos += 4; // coinbase index (always 0)
    let (n, p2) = read_varint(raw, pos).ok_or_else(|| bad("truncated"))?;
    pos = p2;
    let mut chain_branch = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let h: [u8; 32] = raw
            .get(pos..pos + 32)
            .and_then(|x| x.try_into().ok())
            .ok_or_else(|| bad("truncated branch"))?;
        chain_branch.push(h);
        pos += 32;
    }
    let chain_index = u32::from_le_bytes(
        raw.get(pos..pos + 4)
            .and_then(|x| x.try_into().ok())
            .ok_or_else(|| bad("truncated index"))?,
    );
    pos += 4;
    let parent_header = raw.get(pos..).ok_or_else(|| bad("missing header"))?.to_vec();
    if parent_header.len() != 80 {
        return Err(bad("parent header must be 80 bytes in the blob form"));
    }
    Ok(AuxPow {
        parent_algo: algo.to_string(),
        parent_header,
        parent_coinbase: coinbase,
        coinbase_branch,
        chain_branch,
        chain_index,
    })
}

// ================================================================================================
// Explorer API (GET endpoints on the aux/work listener)
// ================================================================================================

fn jhash(h: &[u8; 32]) -> String {
    display_hash(h)
}

/// Resolve every historical outpoint to (recipient, amount) — the chain is
/// the index. Linear, fine at prototype scale.
fn outpoint_index(chain: &Chain) -> HashMap<(blockle_core::Hash32, u32), (Address, u64)> {
    let mut map = HashMap::new();
    for b in &chain.blocks {
        for tx in &b.transactions {
            let txid = tx.txid();
            for (vout, o) in tx.outputs.iter().enumerate() {
                map.insert((txid, vout as u32), (o.recipient, o.amount));
            }
        }
    }
    map
}

fn tx_kind(tx: &blockle_core::Transaction) -> &'static str {
    if tx.is_coinbase() {
        "coinbase"
    } else if tx.shielded.is_some() {
        "shielded"
    } else if tx.contract.is_some() {
        "contract"
    } else {
        "transfer"
    }
}

fn tx_json(
    chain: &Chain,
    idx: &HashMap<(blockle_core::Hash32, u32), (Address, u64)>,
    tx: &blockle_core::Transaction,
    height: Option<u64>,
    time: Option<u32>,
) -> Value {
    let txid = tx.txid();
    let inputs: Vec<Value> = tx
        .inputs
        .iter()
        .map(|i| {
            let resolved = idx.get(&(i.prev.txid, i.prev.vout));
            json!({
                "prev_txid": jhash(&i.prev.txid),
                "prev_vout": i.prev.vout,
                "address": resolved.map(|(a, _)| encode_address(a)),
                "amount": resolved.map(|(_, v)| *v),
            })
        })
        .collect();
    let outputs: Vec<Value> = tx
        .outputs
        .iter()
        .enumerate()
        .map(|(vout, o)| {
            json!({
                "vout": vout,
                "address": encode_address(&o.recipient),
                "amount": o.amount,
            })
        })
        .collect();
    let in_total: u64 = tx
        .inputs
        .iter()
        .filter_map(|i| idx.get(&(i.prev.txid, i.prev.vout)).map(|(_, v)| *v))
        .sum();
    let out_total: u64 = tx.outputs.iter().map(|o| o.amount).sum();
    let fee = if tx.is_coinbase() || tx.shielded.is_some() {
        None
    } else {
        in_total.checked_sub(out_total)
    };
    let confirmations = height
        .and_then(|h| chain.height().map(|tip| tip - h + 1));
    json!({
        "txid": jhash(&txid),
        "kind": tx_kind(tx),
        "block_height": height,
        "time": time,
        "confirmations": confirmations,
        "inputs": inputs,
        "outputs": outputs,
        "total_out": out_total,
        "fee": fee,
        "shielded": tx.shielded.as_ref().map(|b| json!({
            "spends": b.spends.len(),
            "outputs": b.outputs.len(),
            "hidden_transfers": b.transfers.len(),
            "note": "amounts in the shielded pool are not visible on chain",
        })),
        "contract": tx.contract.is_some(),
        "size": tx.serialized_size(),
    })
}

fn block_summary(chain: &Chain, height: usize, b: &Block) -> Value {
    let reward: u64 = b.transactions[0].outputs.iter().map(|o| o.amount).sum();
    json!({
        "height": height,
        "hash": jhash(&b.header.hash()),
        "time": b.header.time,
        "lane": Chain::lane_of(b),
        "txs": b.transactions.len(),
        "reward": reward,
        "miner": b.transactions[0].outputs.first().map(|o| encode_address(&o.recipient)),
        "size": b.serialized_size(),
    })
}

fn explorer_get(node: &Arc<Node>, path: &str) -> (&'static str, String) {
    let (chain, mempool) = node.snapshot();
    let ok = |v: Value| ("200 OK", v.to_string());
    let err404 = |m: &str| ("404 Not Found", json!({"error": m}).to_string());
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let qget = |k: &str| {
        query
            .split('&')
            .find_map(|kv| kv.split_once('=').filter(|(key, _)| *key == k).map(|(_, v)| v))
    };

    match route {
        "/explorer/stats" => {
            let supply: u64 = chain
                .blocks
                .iter()
                .map(|b| b.transactions[0].outputs.iter().map(|o| o.amount).sum::<u64>())
                .sum();
            let lanes: Vec<Value> = chain
                .lanes()
                .iter()
                .map(|lane| {
                    let blocks: Vec<(usize, &Block)> = chain
                        .blocks
                        .iter()
                        .enumerate()
                        .filter(|(_, b)| Chain::lane_of(b) == *lane)
                        .collect();
                    let avg_interval = if blocks.len() >= 2 {
                        let times: Vec<i64> =
                            blocks.iter().map(|(_, b)| b.header.time as i64).collect();
                        Some((times.last().unwrap() - times.first().unwrap()) / (times.len() as i64 - 1).max(1))
                    } else {
                        None
                    };
                    json!({
                        "lane": lane,
                        "blocks": blocks.len(),
                        "next_bits": format!("{:08x}", chain.next_bits_for_at(lane, now_unix() as i64)),
                        "last_block_height": blocks.last().map(|(h, _)| h),
                        "avg_interval_secs": avg_interval,
                    })
                })
                .collect();
            ok(json!({
                "name": chain.params.name,
                "ticker": chain.params.ticker,
                "height": chain.height(),
                "tip": chain.blocks.last().map(|b| json!({
                    "hash": jhash(&b.header.hash()), "time": b.header.time})),
                "supply": supply,
                "premine": chain.params.premine,
                "mined": supply.saturating_sub(chain.params.premine),
                "subsidy": chain.params.block_subsidy(chain.blocks.len() as u64),
                "halving_interval": chain.params.halving_interval,
                "utxos": chain.utxos.len(),
                "mempool": mempool.len(),
                "lanes": lanes,
            }))
        }
        "/explorer/blocks" => {
            let tip = chain.blocks.len().saturating_sub(1);
            let from: usize = qget("from").and_then(|v| v.parse().ok()).unwrap_or(tip);
            let limit: usize = qget("limit").and_then(|v| v.parse().ok()).unwrap_or(25).min(50);
            let from = from.min(tip);
            let blocks: Vec<Value> = (0..=from)
                .rev()
                .take(limit)
                .filter_map(|h| chain.blocks.get(h).map(|b| block_summary(&chain, h, b)))
                .collect();
            ok(json!({"tip": tip, "from": from, "blocks": blocks}))
        }
        p if p.starts_with("/explorer/block/") => {
            let id = &p["/explorer/block/".len()..];
            let found = if let Ok(h) = id.parse::<usize>() {
                chain.blocks.get(h).map(|b| (h, b))
            } else {
                chain
                    .blocks
                    .iter()
                    .enumerate()
                    .find(|(_, b)| jhash(&b.header.hash()) == id)
            };
            let Some((height, b)) = found else { return err404("no such block") };
            let idx = outpoint_index(&chain);
            let txs: Vec<Value> = b
                .transactions
                .iter()
                .map(|t| tx_json(&chain, &idx, t, Some(height as u64), Some(b.header.time)))
                .collect();
            let aux = b.aux_pow.as_ref().map(|a| json!({
                "parent_algo": a.parent_algo,
                "parent_header_size": a.parent_header.len(),
                "parent_pow_hash": blockle_pow::parent::pow_hash(&a.parent_algo, &a.parent_header)
                    .map(|h| jhash(&h)),
                "chain_index": a.chain_index,
                "commitment_tree_depth": a.chain_branch.len(),
            }));
            ok(json!({
                "height": height,
                "hash": jhash(&b.header.hash()),
                "prev_hash": jhash(&b.header.prev_hash),
                "merkle_root": jhash(&b.header.merkle_root),
                "time": b.header.time,
                "bits": format!("{:08x}", b.header.bits),
                "nonce": hex::encode(b.header.nonce),
                "solution_bytes": b.header.solution.len(),
                "lane": Chain::lane_of(b),
                "aux_pow": aux,
                "size": b.serialized_size(),
                "confirmations": chain.height().map(|t| t - height as u64 + 1),
                "txs": txs,
            }))
        }
        p if p.starts_with("/explorer/tx/") => {
            let id = &p["/explorer/tx/".len()..];
            let idx = outpoint_index(&chain);
            for (h, b) in chain.blocks.iter().enumerate() {
                for tx in &b.transactions {
                    if jhash(&tx.txid()) == id {
                        return ok(json!({
                            "block_hash": jhash(&b.header.hash()),
                            "tx": tx_json(&chain, &idx, tx, Some(h as u64), Some(b.header.time)),
                        }));
                    }
                }
            }
            for tx in &mempool {
                if jhash(&tx.txid()) == id {
                    return ok(json!({
                        "block_hash": null,
                        "tx": tx_json(&chain, &idx, tx, None, None),
                    }));
                }
            }
            err404("no such transaction")
        }
        p if p.starts_with("/explorer/address/") => {
            let addr_s = &p["/explorer/address/".len()..];
            let Ok(addr) = decode_address(addr_s) else { return err404("bad address") };
            let idx = outpoint_index(&chain);
            let mut history = Vec::new();
            let mut received = 0u64;
            let mut sent = 0u64;
            for (h, b) in chain.blocks.iter().enumerate() {
                for tx in &b.transactions {
                    let got: u64 = tx
                        .outputs
                        .iter()
                        .filter(|o| o.recipient == addr)
                        .map(|o| o.amount)
                        .sum();
                    let spent: u64 = tx
                        .inputs
                        .iter()
                        .filter_map(|i| idx.get(&(i.prev.txid, i.prev.vout)))
                        .filter(|(a, _)| *a == addr)
                        .map(|(_, v)| *v)
                        .sum();
                    if got == 0 && spent == 0 {
                        continue;
                    }
                    received += got;
                    sent += spent;
                    history.push(json!({
                        "txid": jhash(&tx.txid()),
                        "height": h,
                        "time": b.header.time,
                        "kind": tx_kind(tx),
                        "net": got as i128 - spent as i128,
                    }));
                }
            }
            let cut = history.len().saturating_sub(100);
            ok(json!({
                "address": addr_s,
                "balance": chain.balance(&addr),
                "utxos": chain.utxos.values().filter(|e| e.output.recipient == addr).count(),
                "total_received": received,
                "total_sent": sent,
                "tx_count": history.len(),
                "history": history.split_off(cut).into_iter().rev().collect::<Vec<_>>(),
            }))
        }
        p if p.starts_with("/explorer/utxos/") => {
            let addr_s = &p["/explorer/utxos/".len()..];
            let Ok(addr) = decode_address(addr_s) else { return err404("bad address") };
            // Spendable (mature) outputs, so a light wallet can build inputs.
            // txid is RAW hex (not display-reversed) so it round-trips straight
            // back into an OutPoint when the wallet rebuilds the transaction.
            let spendable = chain.spendable_utxos(&addr);
            let total: u64 = spendable.iter().map(|(_, e)| e.output.amount).sum();
            let utxos: Vec<Value> = spendable
                .into_iter()
                .map(|(op, e)| {
                    json!({
                        "txid": hex::encode(op.txid),
                        "vout": op.vout,
                        "amount": e.output.amount,
                    })
                })
                .collect();
            ok(json!({
                "address": addr_s,
                "spendable": total,
                "count": utxos.len(),
                "utxos": utxos,
            }))
        }
        "/explorer/peers" => {
            let peers: Vec<Value> = node
                .peer_list()
                .into_iter()
                .map(|(id, listen, src)| json!({ "id": id, "address": listen, "ip": src }))
                .collect();
            ok(json!({ "count": peers.len(), "known": node.known_addr_count(), "peers": peers }))
        }
        "/explorer/richlist" => {
            let mut bal: HashMap<blockle_core::keys::Address, u64> = HashMap::new();
            for e in chain.utxos.values() {
                *bal.entry(e.output.recipient).or_insert(0) += e.output.amount;
            }
            let supply: u64 = chain
                .blocks
                .iter()
                .map(|b| b.transactions[0].outputs.iter().map(|o| o.amount).sum::<u64>())
                .sum();
            let holders = bal.len();
            let mut v: Vec<(blockle_core::keys::Address, u64)> = bal.into_iter().collect();
            v.sort_by(|a, b| b.1.cmp(&a.1));
            v.truncate(100);
            let rows: Vec<Value> = v
                .iter()
                .enumerate()
                .map(|(i, (addr, amt))| {
                    json!({
                        "rank": i + 1,
                        "address": encode_address(addr),
                        "balance": amt,
                        "pct": if supply > 0 { *amt as f64 / supply as f64 * 100.0 } else { 0.0 },
                    })
                })
                .collect();
            ok(json!({ "count": rows.len(), "supply": supply, "holders": holders, "richlist": rows }))
        }
        "/explorer/mempool" => {
            let idx = outpoint_index(&chain);
            let txs: Vec<Value> = mempool
                .iter()
                .map(|t| tx_json(&chain, &idx, t, None, None))
                .collect();
            ok(json!({"count": txs.len(), "txs": txs}))
        }
        p if p.starts_with("/explorer/search/") => {
            let q = p["/explorer/search/".len()..].trim().to_string();
            if q.chars().all(|c| c.is_ascii_digit()) && !q.is_empty() {
                if chain.blocks.len() > q.parse::<usize>().unwrap_or(usize::MAX) {
                    return ok(json!({"type": "block", "id": q}));
                }
                return err404("no block at that height");
            }
            if q.starts_with("block1") {
                if decode_address(&q).is_ok() {
                    return ok(json!({"type": "address", "id": q}));
                }
                return err404("bad address");
            }
            if q.len() == 64 && q.chars().all(|c| c.is_ascii_hexdigit()) {
                if chain.blocks.iter().any(|b| jhash(&b.header.hash()) == q) {
                    return ok(json!({"type": "block", "id": q}));
                }
                let is_tx = chain
                    .blocks
                    .iter()
                    .flat_map(|b| b.transactions.iter())
                    .chain(mempool.iter())
                    .any(|t| jhash(&t.txid()) == q);
                if is_tx {
                    return ok(json!({"type": "tx", "id": q}));
                }
                return err404("no block or transaction with that hash");
            }
            err404("unrecognized query (height, hash, txid, or block1… address)")
        }
        _ => err404("unknown endpoint"),
    }
}
