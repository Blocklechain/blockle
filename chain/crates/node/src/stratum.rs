//! Stratum server for Equihash miners (ASICs / mining software).
//!
//! Speaks the Zcash-flavor stratum dialect over line-delimited JSON-RPC:
//! `mining.subscribe` → `[session_id, nonce1]`, `mining.authorize`,
//! server-pushed `mining.set_target` + `mining.notify`, and `mining.submit`
//! with `[worker, job_id, ntime, nonce2, solution]`.
//!
//! Conventions: the 32-byte header nonce is `nonce1 (16 bytes, ours) ||
//! nonce2 (16 bytes, miner's)`; `version`/`ntime`/`nbits` are hex of the
//! little-endian header bytes; `prevhash`/`merkleroot`/`reserved` are hex of
//! the header bytes in internal order; the solution may be sent with or
//! without its compactsize length prefix. This is a **solo** endpoint: a
//! submit is accepted only if it is a fully valid block, which is then
//! connected and gossiped like any other. (Share-difficulty accounting for
//! pools is a later step; specific miner firmwares may also need byte-order
//! flips, which is a config matter once tested against real hardware.)

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use blockle_chain::U256;
use blockle_core::Block;
use blockle_pow::difficulty::compact_to_target;
use blockle_pow::equihash;

use crate::p2p::Node;

/// Vardiff tuning: aim for one share every ~10 s per miner, retarget at
/// most every 30 s, never harder than needed nor easier than the chain's
/// pow limit.
const TARGET_SHARE_SECS: u64 = 10;
const RETARGET_SECS: u64 = 30;

struct Client {
    sender: Sender<String>,
    nonce1: [u8; 16],
    subscribed: bool,
    share_target: U256,
    window_start: Instant,
    window_shares: u32,
    accepted: u64,
    rejected: u64,
}

struct StratumState {
    node: Arc<Node>,
    clients: Mutex<HashMap<u64, Client>>,
    jobs: Mutex<HashMap<String, Block>>,
    current_job: Mutex<Option<String>>,
    next_client: AtomicU64,
    next_job: AtomicU64,
}

/// Start the stratum server on `addr` (spawns threads; returns immediately).
pub fn serve(node: Arc<Node>, addr: String) {
    let state = Arc::new(StratumState {
        node,
        clients: Mutex::new(HashMap::new()),
        jobs: Mutex::new(HashMap::new()),
        current_job: Mutex::new(None),
        next_client: AtomicU64::new(1),
        next_job: AtomicU64::new(1),
    });

    {
        let state = state.clone();
        thread::spawn(move || {
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => {
                    println!("[stratum] listening on {addr}");
                    l
                }
                Err(e) => {
                    println!("[stratum] cannot listen on {addr}: {e}");
                    return;
                }
            };
            for stream in listener.incoming().flatten() {
                let state = state.clone();
                thread::spawn(move || handle_client(state, stream));
            }
        });
    }

    thread::spawn(move || job_loop(state));
}

/// Rebuild the template when the tip changes (or periodically for fresh
/// timestamps/mempool) and notify miners.
fn job_loop(state: Arc<StratumState>) {
    let mut last_gen = u64::MAX;
    let mut last_refresh = Instant::now();
    loop {
        let gen = state.node.tip_generation();
        let tip_changed = gen != last_gen;
        if tip_changed || last_refresh.elapsed() > Duration::from_secs(30) {
            match state.node.block_template() {
                Ok(block) => {
                    last_gen = gen;
                    last_refresh = Instant::now();
                    let job_id =
                        format!("{:x}", state.next_job.fetch_add(1, Ordering::SeqCst));
                    state.jobs.lock().unwrap().insert(job_id.clone(), block.clone());
                    *state.current_job.lock().unwrap() = Some(job_id.clone());
                    // Keep only recent jobs.
                    let mut jobs = state.jobs.lock().unwrap();
                    if jobs.len() > 8 {
                        let keep: Vec<String> = {
                            let mut ids: Vec<u64> = jobs
                                .keys()
                                .filter_map(|k| u64::from_str_radix(k, 16).ok())
                                .collect();
                            ids.sort_unstable();
                            ids.iter().rev().take(8).map(|i| format!("{i:x}")).collect()
                        };
                        jobs.retain(|k, _| keep.contains(k));
                    }
                    drop(jobs);
                    broadcast_job(&state, &job_id, &block, tip_changed);
                }
                Err(e) => {
                    if tip_changed {
                        println!("[stratum] no template yet: {e}");
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn notify_params(job_id: &str, block: &Block, clean: bool) -> Value {
    let h = &block.header;
    json!([
        job_id,
        hex::encode(h.version.to_le_bytes()),
        hex::encode(h.prev_hash),
        hex::encode(h.merkle_root),
        hex::encode(h.state_root),
        hex::encode(h.time.to_le_bytes()),
        hex::encode(h.bits.to_le_bytes()),
        clean,
    ])
}

fn target_hex_u256(target: U256) -> String {
    let mut be = [0u8; 32];
    target.to_big_endian(&mut be);
    hex::encode(be)
}

fn block_target(bits: u32) -> U256 {
    compact_to_target(bits).unwrap_or_default()
}

fn push(client: &Client, msg: Value) {
    let _ = client.sender.send(msg.to_string());
}

fn broadcast_job(state: &StratumState, job_id: &str, block: &Block, clean: bool) {
    let clients = state.clients.lock().unwrap();
    for client in clients.values().filter(|c| c.subscribed) {
        // Shares may be easier than blocks, but never harder.
        let share = client.share_target.max(block_target(block.header.bits));
        push(
            client,
            json!({"id": null, "method": "mining.set_target", "params": [target_hex_u256(share)]}),
        );
        push(
            client,
            json!({"id": null, "method": "mining.notify", "params": notify_params(job_id, block, clean)}),
        );
    }
}

fn handle_client(state: Arc<StratumState>, stream: TcpStream) {
    let peer = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "?".into());
    let client_id = state.next_client.fetch_add(1, Ordering::SeqCst);
    let mut nonce1 = [0u8; 16];
    nonce1[..8].copy_from_slice(&client_id.to_le_bytes());

    let mut write_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let (tx, rx) = channel::<String>();
    state.clients.lock().unwrap().insert(
        client_id,
        Client {
            sender: tx,
            nonce1,
            subscribed: false,
            share_target: state.node.params().pow_limit, // easiest; vardiff tightens
            window_start: Instant::now(),
            window_shares: 0,
            accepted: 0,
            rejected: 0,
        },
    );
    println!("[stratum] miner {client_id} connected ({peer})");

    let writer = thread::spawn(move || {
        for line in rx {
            if writeln!(write_half, "{line}").is_err() || write_half.flush().is_err() {
                break;
            }
        }
        let _ = write_half.shutdown(std::net::Shutdown::Both);
    });

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { break };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        let reply = handle_request(&state, client_id, method, &params);
        let clients = state.clients.lock().unwrap();
        if let Some(client) = clients.get(&client_id) {
            match reply {
                Ok(result) => push(client, json!({"id": id, "result": result, "error": null})),
                Err(msg) => {
                    push(client, json!({"id": id, "result": null, "error": [20, msg, null]}))
                }
            }
        }
    }

    state.clients.lock().unwrap().remove(&client_id);
    println!("[stratum] miner {client_id} disconnected ({peer})");
    let _ = writer.join();
}

fn handle_request(
    state: &Arc<StratumState>,
    client_id: u64,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    match method {
        "mining.subscribe" => {
            let nonce1 = {
                let mut clients = state.clients.lock().unwrap();
                let client = clients.get_mut(&client_id).ok_or("gone")?;
                client.subscribed = true;
                client.nonce1
            };
            // Send the current job right after the subscribe response.
            if let Some(job_id) = state.current_job.lock().unwrap().clone() {
                if let Some(block) = state.jobs.lock().unwrap().get(&job_id).cloned() {
                    let clients = state.clients.lock().unwrap();
                    if let Some(client) = clients.get(&client_id) {
                        let share = client.share_target.max(block_target(block.header.bits));
                        push(
                            client,
                            json!({"id": null, "method": "mining.set_target",
                                   "params": [target_hex_u256(share)]}),
                        );
                        push(
                            client,
                            json!({"id": null, "method": "mining.notify",
                                   "params": notify_params(&job_id, &block, true)}),
                        );
                    }
                }
            }
            Ok(json!(["blockle-session", hex::encode(nonce1)]))
        }
        "mining.authorize" => Ok(json!(true)),
        "mining.extranonce.subscribe" => Ok(json!(true)),
        "mining.submit" => {
            let p = params.as_array().ok_or("bad params")?;
            if p.len() < 5 {
                return Err("expected [worker, job_id, ntime, nonce2, solution]".into());
            }
            let job_id = p[1].as_str().ok_or("bad job id")?;
            let ntime: [u8; 4] = decode_fixed(p[2].as_str().ok_or("bad ntime")?)?;
            let nonce2: [u8; 16] = decode_fixed(p[3].as_str().ok_or("bad nonce2")?)?;
            let solution = hex::decode(p[4].as_str().ok_or("bad solution")?)
                .map_err(|_| "bad solution hex".to_string())?;

            let mut block = state
                .jobs
                .lock()
                .unwrap()
                .get(job_id)
                .cloned()
                .ok_or("unknown job")?;
            let nonce1 = state
                .clients
                .lock()
                .unwrap()
                .get(&client_id)
                .map(|c| c.nonce1)
                .ok_or("gone")?;

            let expected = state.node.params().equihash.solution_bytes();
            let solution = strip_compact_size(solution, expected)?;

            block.header.time = u32::from_le_bytes(ntime);
            block.header.nonce[..16].copy_from_slice(&nonce1);
            block.header.nonce[16..].copy_from_slice(&nonce2);
            block.header.solution = solution;

            // A share must be a valid Equihash solution …
            let params = state.node.params();
            let share_ok = equihash::unpack_solution(&params.equihash, &block.header.solution)
                .ok()
                .map(|indices| {
                    equihash::verify(
                        &params.equihash,
                        &block.header.equihash_input(),
                        &block.header.nonce,
                        &indices,
                    )
                    .is_ok()
                })
                .unwrap_or(false);
            if !share_ok {
                bump_rejected(state, client_id);
                return Err("invalid equihash solution".into());
            }
            // … whose header hash meets the client's share target.
            let hash_val = U256::from_little_endian(&block.header.hash());
            let (share_target, bt) = {
                let clients = state.clients.lock().unwrap();
                let c = clients.get(&client_id).ok_or("gone")?;
                (c.share_target.max(block_target(block.header.bits)), block_target(block.header.bits))
            };
            if hash_val > share_target {
                bump_rejected(state, client_id);
                return Err("low difficulty share".into());
            }

            record_share_and_retarget(state, client_id, bt);
            if hash_val <= bt && state.node.submit_block(block, None) {
                println!("[stratum] miner {client_id} found a block!");
            }
            Ok(json!(true))
        }
        other => Err(format!("unknown method {other}")),
    }
}

fn bump_rejected(state: &Arc<StratumState>, client_id: u64) {
    if let Some(c) = state.clients.lock().unwrap().get_mut(&client_id) {
        c.rejected += 1;
    }
}

/// Count an accepted share and retarget the client's share difficulty
/// (vardiff). Pushes a new `mining.set_target` when the target moves.
fn record_share_and_retarget(state: &Arc<StratumState>, client_id: u64, block_t: U256) {
    let mut clients = state.clients.lock().unwrap();
    let Some(c) = clients.get_mut(&client_id) else { return };
    c.accepted += 1;
    c.window_shares += 1;
    let elapsed = c.window_start.elapsed().as_secs();
    if elapsed < RETARGET_SECS {
        return;
    }
    let expected = (elapsed / TARGET_SHARE_SECS).max(1) as u32;
    let old = c.share_target;
    if c.window_shares > expected * 2 {
        c.share_target = c.share_target >> 1; // too many shares → harder
    } else if c.window_shares * 2 < expected {
        c.share_target = (c.share_target << 1).min(state.node.params().pow_limit);
    }
    c.share_target = c.share_target.max(block_t);
    c.window_start = Instant::now();
    c.window_shares = 0;
    if c.share_target != old {
        println!(
            "[stratum] miner {client_id} vardiff retarget ({} accepted / {} rejected)",
            c.accepted, c.rejected
        );
        push(
            c,
            json!({"id": null, "method": "mining.set_target",
                   "params": [target_hex_u256(c.share_target)]}),
        );
    }
}

fn decode_fixed<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let bytes = hex::decode(s).map_err(|_| "bad hex".to_string())?;
    bytes.try_into().map_err(|_| format!("expected {N} bytes"))
}

/// Miners may include the serialized compactsize length prefix; accept both.
fn strip_compact_size(solution: Vec<u8>, expected: usize) -> Result<Vec<u8>, String> {
    if solution.len() == expected {
        return Ok(solution);
    }
    if solution.len() == expected + 1 && solution[0] as usize == expected {
        return Ok(solution[1..].to_vec());
    }
    if solution.len() == expected + 3
        && solution[0] == 0xfd
        && u16::from_le_bytes([solution[1], solution[2]]) as usize == expected
    {
        return Ok(solution[3..].to_vec());
    }
    Err(format!("solution must be {expected} bytes (got {})", solution.len()))
}
