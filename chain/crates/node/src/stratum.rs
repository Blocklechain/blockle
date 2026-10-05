//! Stratum pool server for Equihash miners (ASICs / mining software).
//!
//! Speaks the Zcash-flavor stratum dialect over line-delimited JSON-RPC:
//! `mining.subscribe` → `[session_id, nonce1]`, `mining.authorize`,
//! server-pushed `mining.set_target` + `mining.notify`, and `mining.submit`
//! with `[worker, job_id, ntime, nonce2, solution]`.
//!
//! Two pool modes, both trust-minimized:
//!
//! - **Solo** — miners authorize with their own BLOCK address as the
//!   username; every job's coinbase pays THAT miner directly (minus the
//!   pool fee), so a found block needs no payout step at all.
//! - **PPLNS** — one shared job paying the pool wallet; accepted shares are
//!   weighted by share difficulty in a rolling window, and every found
//!   block appends a payout record to the ledger that the node's payout
//!   executor settles on-chain once the coinbase matures.
//!
//! Conventions: the 32-byte header nonce is `nonce1 (16 bytes, ours) ||
//! nonce2 (16 bytes, miner's)`; `version`/`ntime`/`nbits` are hex of the
//! little-endian header bytes; `prevhash`/`merkleroot`/`reserved` are hex of
//! the header bytes in internal order; the solution may be sent with or
//! without its compactsize length prefix. Specific miner firmwares may
//! need byte-order flips, which is a config matter once tested against
//! real hardware.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use blockle_chain::U256;
use blockle_core::keys::{decode_address, encode_address, Address};
use blockle_core::Block;
use blockle_pow::difficulty::compact_to_target;
use blockle_pow::equihash;

use crate::p2p::Node;

/// Vardiff tuning: aim for one share every ~10 s per miner, retarget at
/// most every 30 s, never harder than needed nor easier than the chain's
/// pow limit.
const TARGET_SHARE_SECS: u64 = 10;
const RETARGET_SECS: u64 = 30;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PoolMode {
    Solo,
    Pplns,
}

impl PoolMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PoolMode::Solo => "solo",
            PoolMode::Pplns => "pplns",
        }
    }
}

/// Pool configuration for one stratum listener.
#[derive(Clone)]
pub struct PoolOpts {
    pub mode: PoolMode,
    /// Pool fee in basis points (100 = 1%).
    pub fee_bp: u32,
    /// PPLNS share window (number of shares).
    pub window: usize,
    /// Pool wallet address: receives the fee (solo) or the whole coinbase
    /// pending share-weighted payout (PPLNS).
    pub pool_address: Address,
    /// Where to write live pool statistics JSON (for the website / MPS).
    pub stats_path: Option<PathBuf>,
    /// PPLNS payout ledger (JSONL; consumed by the payout executor).
    pub ledger_path: Option<PathBuf>,
    /// Public endpoint label shown in stats (e.g. "blockle.org:3333").
    pub endpoint: String,
}

/// One pending or settled PPLNS payout record.
#[derive(Serialize, Deserialize, Clone)]
pub struct PayoutRecord {
    pub height: u64,
    pub block_hash: String,
    pub time: u64,
    /// Total coinbase value of the found block (base units).
    pub reward: u64,
    pub fee_bp: u32,
    /// (address, base units) owed per miner after the fee.
    pub entries: Vec<(String, u64)>,
    pub paid: bool,
    pub txid: Option<String>,
}

#[derive(Serialize, Clone)]
struct FoundBlock {
    height: u64,
    hash: String,
    time: u64,
    finder: String,
}

struct Client {
    sender: Sender<String>,
    nonce1: [u8; 16],
    subscribed: bool,
    address: Option<Address>,
    worker: String,
    share_target: U256,
    window_start: Instant,
    window_shares: u32,
    accepted: u64,
    rejected: u64,
}

struct StratumState {
    node: Arc<Node>,
    opts: PoolOpts,
    clients: Mutex<HashMap<u64, Client>>,
    jobs: Mutex<HashMap<String, Block>>,
    current_job: Mutex<Option<String>>,
    /// PPLNS rolling share window: (address, difficulty weight).
    shares: Mutex<VecDeque<(Address, f64)>>,
    found: Mutex<Vec<FoundBlock>>,
    next_client: AtomicU64,
    next_job: AtomicU64,
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn u256_f64(v: U256) -> f64 {
    v.0[0] as f64
        + v.0[1] as f64 * 2f64.powi(64)
        + v.0[2] as f64 * 2f64.powi(128)
        + v.0[3] as f64 * 2f64.powi(192)
}

/// Start the stratum pool on `addr` (spawns threads; returns immediately).
pub fn serve(node: Arc<Node>, addr: String, opts: PoolOpts) {
    let state = Arc::new(StratumState {
        node,
        opts,
        clients: Mutex::new(HashMap::new()),
        jobs: Mutex::new(HashMap::new()),
        current_job: Mutex::new(None),
        shares: Mutex::new(VecDeque::new()),
        found: Mutex::new(Vec::new()),
        next_client: AtomicU64::new(1),
        next_job: AtomicU64::new(1),
    });

    {
        let state = state.clone();
        thread::spawn(move || {
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => {
                    println!(
                        "[stratum:{}] listening on {addr}",
                        state.opts.mode.as_str()
                    );
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

    {
        let state = state.clone();
        thread::spawn(move || stats_loop(state));
    }

    thread::spawn(move || job_loop(state));
}

/// Build this pool's coinbase recipients for a given miner.
fn recipients(state: &StratumState, miner: Option<Address>) -> Vec<(Address, u32)> {
    let fee = state.opts.fee_bp.min(10_000);
    match (state.opts.mode, miner) {
        (PoolMode::Solo, Some(addr)) if fee > 0 && addr != state.opts.pool_address => {
            vec![(addr, 10_000 - fee), (state.opts.pool_address, fee)]
        }
        (PoolMode::Solo, Some(addr)) => vec![(addr, 10_000)],
        _ => vec![(state.opts.pool_address, 10_000)],
    }
}

/// Rebuild templates when the tip changes (or periodically for fresh
/// timestamps/mempool) and notify miners. Solo mode builds one job per
/// authorized miner so each coinbase pays its own finder.
fn job_loop(state: Arc<StratumState>) {
    let mut last_gen = u64::MAX;
    let mut last_refresh = Instant::now();
    loop {
        let gen = state.node.tip_generation();
        let tip_changed = gen != last_gen;
        if tip_changed || last_refresh.elapsed() > Duration::from_secs(30) {
            last_gen = gen;
            last_refresh = Instant::now();
            match state.opts.mode {
                PoolMode::Pplns => {
                    if let Ok(block) = state.node.block_template_split(&recipients(&state, None))
                    {
                        let job_id =
                            format!("{:x}", state.next_job.fetch_add(1, Ordering::SeqCst));
                        state.jobs.lock().unwrap().insert(job_id.clone(), block.clone());
                        *state.current_job.lock().unwrap() = Some(job_id.clone());
                        prune_jobs(&state);
                        let clients = state.clients.lock().unwrap();
                        for client in clients.values().filter(|c| c.subscribed) {
                            send_job(client, &job_id, &block, tip_changed);
                        }
                    }
                }
                PoolMode::Solo => {
                    let targets: Vec<(u64, Address)> = {
                        let clients = state.clients.lock().unwrap();
                        clients
                            .iter()
                            .filter(|(_, c)| c.subscribed && c.address.is_some())
                            .map(|(id, c)| (*id, c.address.expect("filtered")))
                            .collect()
                    };
                    for (client_id, addr) in targets {
                        push_solo_job(&state, client_id, addr, tip_changed);
                    }
                    prune_jobs(&state);
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn push_solo_job(state: &Arc<StratumState>, client_id: u64, addr: Address, clean: bool) {
    let Ok(block) = state.node.block_template_split(&recipients(state, Some(addr))) else {
        return;
    };
    let job_id = format!(
        "{:x}-{client_id:x}",
        state.next_job.fetch_add(1, Ordering::SeqCst)
    );
    state.jobs.lock().unwrap().insert(job_id.clone(), block.clone());
    let clients = state.clients.lock().unwrap();
    if let Some(client) = clients.get(&client_id) {
        send_job(client, &job_id, &block, clean);
    }
}

fn prune_jobs(state: &StratumState) {
    let mut jobs = state.jobs.lock().unwrap();
    if jobs.len() > 64 {
        let mut ids: Vec<(u64, String)> = jobs
            .keys()
            .filter_map(|k| {
                let head = k.split('-').next().unwrap_or(k);
                u64::from_str_radix(head, 16).ok().map(|n| (n, k.clone()))
            })
            .collect();
        ids.sort_unstable();
        let cutoff = ids.len().saturating_sub(64);
        for (_, k) in ids.into_iter().take(cutoff) {
            jobs.remove(&k);
        }
    }
}

fn send_job(client: &Client, job_id: &str, block: &Block, clean: bool) {
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
            address: None,
            worker: String::new(),
            share_target: state.node.params().pow_limit,
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
            // PPLNS: send the shared job right away. Solo: the job comes
            // after authorize (we need the miner's address first).
            if state.opts.mode == PoolMode::Pplns {
                if let Some(job_id) = state.current_job.lock().unwrap().clone() {
                    if let Some(block) = state.jobs.lock().unwrap().get(&job_id).cloned() {
                        let clients = state.clients.lock().unwrap();
                        if let Some(client) = clients.get(&client_id) {
                            send_job(client, &job_id, &block, true);
                        }
                    }
                }
            }
            Ok(json!(["blockle-session", hex::encode(nonce1)]))
        }
        "mining.authorize" => {
            let worker = params
                .get(0)
                .and_then(|v| v.as_str())
                .ok_or("authorize needs a username")?
                .to_string();
            // The username is the miner's BLOCK address, optionally with a
            // ".rigname" suffix.
            let addr_part = worker.split('.').next().unwrap_or(&worker);
            let address = decode_address(addr_part).map_err(|_| {
                "authorize with your BLOCK address (block1…) as the username".to_string()
            })?;
            {
                let mut clients = state.clients.lock().unwrap();
                let client = clients.get_mut(&client_id).ok_or("gone")?;
                client.address = Some(address);
                client.worker = worker;
            }
            if state.opts.mode == PoolMode::Solo {
                push_solo_job(state, client_id, address, true);
            }
            Ok(json!(true))
        }
        "mining.extranonce.subscribe" => Ok(json!(true)),
        "mining.submit" => {
            let p = params.as_array().ok_or("bad params")?;
            if p.len() < 5 {
                return Err("expected [worker, job_id, ntime, nonce2, solution]".into());
            }
            let job_id = p[1].as_str().ok_or("bad job id")?;
            let ntime: [u8; 4] = decode_fixed(p[2].as_str().ok_or("bad ntime")?)?;
            let nonce2: [u8; 16] = decode_fixed(p[3].as_str().ok_or("bad nonce2")?)?;
            let solution = hex::decode(p[4].as_str().ok_or("bad solution hex")?)
                .map_err(|_| "bad solution hex".to_string())?;

            let mut block = state
                .jobs
                .lock()
                .unwrap()
                .get(job_id)
                .cloned()
                .ok_or("unknown job")?;
            let (nonce1, miner_addr, worker) = {
                let clients = state.clients.lock().unwrap();
                let c = clients.get(&client_id).ok_or("gone")?;
                (c.nonce1, c.address, c.worker.clone())
            };
            if miner_addr.is_none() {
                return Err("authorize before submitting".into());
            }

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
                (
                    c.share_target.max(block_target(block.header.bits)),
                    block_target(block.header.bits),
                )
            };
            if hash_val > share_target {
                bump_rejected(state, client_id);
                return Err("low difficulty share".into());
            }

            // PPLNS: weight the share by its difficulty in the window.
            if state.opts.mode == PoolMode::Pplns {
                let weight =
                    u256_f64(state.node.params().pow_limit) / u256_f64(share_target).max(1.0);
                let mut shares = state.shares.lock().unwrap();
                shares.push_back((miner_addr.expect("checked"), weight));
                while shares.len() > state.opts.window {
                    shares.pop_front();
                }
            }

            record_share_and_retarget(state, client_id, bt);
            if hash_val <= bt {
                let height = coinbase_height(&block).unwrap_or_default();
                let hash_hex = {
                    let mut h = block.header.hash();
                    h.reverse();
                    hex::encode(h)
                };
                let reward: u64 = block.transactions[0]
                    .outputs
                    .iter()
                    .map(|o| o.amount)
                    .sum();
                if state.node.submit_block(block, None) {
                    println!(
                        "[stratum:{}] miner {client_id} ({worker}) found block {height}!",
                        state.opts.mode.as_str()
                    );
                    state.found.lock().unwrap().push(FoundBlock {
                        height,
                        hash: hash_hex.clone(),
                        time: now_unix(),
                        finder: worker.clone(),
                    });
                    if state.opts.mode == PoolMode::Pplns {
                        append_payout_record(state, height, &hash_hex, reward);
                    }
                }
            }
            Ok(json!(true))
        }
        other => Err(format!("unknown method {other}")),
    }
}

fn coinbase_height(block: &Block) -> Option<u64> {
    let d = &block.transactions.first()?.coinbase_data;
    Some(u64::from_le_bytes(d.get(..8)?.try_into().ok()?))
}

/// Snapshot the PPLNS window into a payout record and append it to the
/// ledger file. Settlement happens later, after coinbase maturity.
fn append_payout_record(state: &Arc<StratumState>, height: u64, hash: &str, reward: u64) {
    let Some(path) = &state.opts.ledger_path else { return };
    let shares = state.shares.lock().unwrap();
    append_ledger_record(path, &shares, height, hash, reward, state.opts.fee_bp);
}

/// Shared PPLNS ledger writer: split `reward` (minus the fee) across the
/// window's difficulty-weighted shares and append one JSONL record. Used by
/// the Equihash pool and every direct-algorithm pool; the node's payout
/// executor settles records regardless of which pool produced them.
pub fn append_ledger_record(
    path: &PathBuf,
    shares: &VecDeque<(Address, f64)>,
    height: u64,
    hash: &str,
    reward: u64,
    fee_bp: u32,
) {
    let mut by_addr: HashMap<Address, f64> = HashMap::new();
    for (addr, w) in shares.iter() {
        *by_addr.entry(*addr).or_default() += w;
    }
    let total: f64 = by_addr.values().sum();
    if total <= 0.0 {
        return;
    }
    let payable = reward as u128 * (10_000 - fee_bp.min(10_000)) as u128 / 10_000;
    let mut entries: Vec<(String, u64)> = by_addr
        .into_iter()
        .map(|(addr, w)| {
            let amount = (payable as f64 * (w / total)) as u64;
            (encode_address(&addr), amount)
        })
        .filter(|(_, amount)| *amount > 0)
        .collect();
    entries.sort();
    let record = PayoutRecord {
        height,
        block_hash: hash.to_string(),
        time: now_unix(),
        reward,
        fee_bp,
        entries,
        paid: false,
        txid: None,
    };
    if let Ok(line) = serde_json::to_string(&record) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| writeln!(f, "{line}"));
    }
}

/// Periodically write live pool statistics for the website / external
/// aggregators (MiningPoolStats-style JSON).
fn stats_loop(state: Arc<StratumState>) {
    loop {
        thread::sleep(Duration::from_secs(15));
        let Some(path) = &state.opts.stats_path else { continue };
        let (miners, workers, accepted, rejected, hashrate, miners_detail) = {
            let clients = state.clients.lock().unwrap();
            let miners = clients.len();
            let workers = clients.values().filter(|c| c.address.is_some()).count();
            let accepted: u64 = clients.values().map(|c| c.accepted).sum();
            let rejected: u64 = clients.values().map(|c| c.rejected).sum();
            let pow_limit = u256_f64(state.node.params().pow_limit);
            let per_client = |c: &Client| {
                let diff = pow_limit / u256_f64(c.share_target).max(1.0);
                diff * c.window_shares as f64 / c.window_start.elapsed().as_secs_f64().max(1.0)
            };
            let hashrate: f64 = clients.values().map(per_client).sum();
            let miners_detail: Vec<serde_json::Value> = clients
                .values()
                .filter(|c| c.address.is_some())
                .map(|c| json!({
                    "worker": c.worker,
                    "hashrate_est": per_client(c),
                    "accepted": c.accepted,
                    "rejected": c.rejected,
                }))
                .collect();
            (miners, workers, accepted, rejected, hashrate, miners_detail)
        };
        let found = state.found.lock().unwrap();
        let last = found.last().cloned();
        let blocks: Vec<&FoundBlock> = found.iter().rev().take(25).collect();
        let stats = json!({
            "pool": "blockle",
            "coin": "BLOCK",
            "algorithm": "equihash",
            "mode": state.opts.mode.as_str(),
            "endpoint": state.opts.endpoint,
            "fee_percent": state.opts.fee_bp as f64 / 100.0,
            "miners": miners,
            "workers": workers,
            "hashrate_sols_est": hashrate,
            "shares_accepted": accepted,
            "shares_rejected": rejected,
            "miners_detail": miners_detail,
            "pplns_window_shares": state.shares.lock().unwrap().len(),
            "blocks_found": found.len(),
            "last_block": last,
            "recent_blocks": blocks,
            "pool_address": encode_address(&state.opts.pool_address),
            "updated": now_unix(),
        });
        drop(found);
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, stats.to_string());
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
    Err("bad solution length".into())
}
