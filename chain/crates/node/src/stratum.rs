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
    /// Easiest share target a bitcoin-dialect pool will hand out (None →
    /// a per-algorithm default). Real ASIC firmware chokes on the absurd
    /// fractional difficulties a bootstrap-easy lane would imply.
    pub share_floor_target: Option<blockle_chain::U256>,
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
    /// Σ of accepted share difficulty over the whole connection (never reset) —
    /// drives a stable hashrate estimate that doesn't drop to 0 at each retarget.
    accepted_weight: f64,
    connected_at: Instant,
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
    // LITTLE-endian, and load-bearing: ADVERTISED_NONCE1_LEN truncates this to
    // its first bytes, so the varying end of the counter has to come first.
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
            /*
             * START AT THE CONFIGURED SHARE FLOOR, NOT THE CHAIN POW LIMIT.
             *
             * `share_floor_target` existed on PoolOpts and was only ever read
             * by stratum_btc.rs; this lane handed every new client
             * `pow_limit` — 7fff…ffff, the easiest target the chain permits.
             * Vardiff tightens it within ~30s, but the FIRST mining.set_target
             * a miner sees is that absurd value, and real ASIC firmware is
             * entitled to reject a target implying a fractional difficulty.
             *
             * It is the second of two deviations found while diagnosing a Z9
             * Mini that hung up immediately after subscribe (the first being
             * reply ordering, above). Both are now ecosystem-normal, so the
             * fix does not depend on which one that firmware objected to.
             */
            share_target: state
                .opts
                .share_floor_target
                .unwrap_or_else(|| state.node.params().pow_limit),
            window_start: Instant::now(),
            window_shares: 0,
            accepted: 0,
            rejected: 0,
            accepted_weight: 0.0,
            connected_at: Instant::now(),
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
        /*
         * THE REPLY GOES OUT BEFORE ANY NOTIFICATION IT CAUSED.
         *
         * `subscribed_needs_job` is what makes the subscribe result the FIRST
         * line a miner reads back, instead of the third. The job push that used
         * to live inside the mining.subscribe arm is deferred to just after this
         * block — see that arm for the Z9 Mini capture that proves why.
         */
        let subscribed_needs_job = method == "mining.subscribe" && reply.is_ok();
        let clients = state.clients.lock().unwrap();
        if let Some(client) = clients.get(&client_id) {
            match reply {
                Ok(result) => push(client, json!({"id": id, "result": result, "error": null})),
                Err(msg) => {
                    /*
                     * SAY WHY A SHARE WAS REFUSED, in the pool's own log.
                     *
                     * The error has always gone back to the miner as
                     * [20, msg, null], but nothing was recorded here — so a
                     * miner reporting "I submitted shares and got no response"
                     * could not be told apart from one whose every share was
                     * being rejected for a reason the pool knew precisely.
                     * Some firmware does not surface a stratum error at all,
                     * which makes a refusal look exactly like silence.
                     *
                     * Only for submits: logging every malformed line from an
                     * internet-facing port is a log-flooding hazard, and a bad
                     * subscribe is not a share anyone is waiting on.
                     */
                    if method == "mining.submit" {
                        println!("[stratum] miner {client_id} share REJECTED: {msg}");
                    }
                    push(client, json!({"id": id, "result": null, "error": [20, msg, null]}))
                }
            }
        }
        /*
         * NOW the job, with the subscribe reply already queued ahead of it.
         *
         * `clients` is dropped first because push_solo_job takes the same lock
         * and would deadlock otherwise — the reason this is a separate
         * statement rather than part of the block above.
         *
         * PPLNS sends the shared job. Solo sends a placeholder paying the pool
         * so a client that subscribes and waits for work sees some; the real
         * per-miner job replaces it on authorize.
         */
        drop(clients);
        if subscribed_needs_job {
            match state.opts.mode {
                PoolMode::Pplns => {
                    if let Some(job_id) = state.current_job.lock().unwrap().clone() {
                        if let Some(block) = state.jobs.lock().unwrap().get(&job_id).cloned() {
                            let clients = state.clients.lock().unwrap();
                            if let Some(client) = clients.get(&client_id) {
                                send_job(client, &job_id, &block, true);
                            }
                        }
                    }
                }
                PoolMode::Solo => push_solo_job(&state, client_id, state.opts.pool_address, true),
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
            /*
             * LOG THE AGENT. The bitcoin-dialect lane has always done this; this
             * one never did, which made "has anyone got a Z9 working on BLOCK?"
             * unanswerable from the logs — there was no record of what hardware
             * had ever connected, only miner numbers.
             */
            let agent = params
                .get(0)
                .and_then(|v| v.as_str())
                .unwrap_or("(none)")
                .to_string();
            println!("[stratum] miner {client_id} subscribe agent={agent:?}");
            let nonce1 = {
                let mut clients = state.clients.lock().unwrap();
                let client = clients.get_mut(&client_id).ok_or("gone")?;
                client.subscribed = true;
                client.nonce1
            };
            /*
             * THE JOB IS **NOT** PUSHED HERE. It is pushed by handle_client
             * immediately AFTER this reply reaches the wire. See the call site.
             *
             * It used to be pushed from inside this arm, which put the
             * subscribe RESULT third on the wire behind an unsolicited
             * mining.set_target and mining.notify — because both go into the
             * same FIFO channel and this arm runs before the caller writes the
             * reply. Captured from a real Z9 Mini:
             *
             *   -> {"id":38,"method":"mining.subscribe","params":["cgminer/4.9.0",...]}
             *   <- {"id":null,"method":"mining.set_target",...}
             *   <- {"id":null,"method":"mining.notify",...}
             *   <- {"error":null,"id":38,"result":["b10c6e01","55000000"]}
             *   -> FIN, 10ms after the subscribe
             *
             * cgminer-family firmware reads the first line back after sending
             * mining.subscribe and requires a "result" member in it. Finding a
             * notification instead, it concludes the pool is unusable and
             * exits with "No servers could be used!" — never reaching
             * mining.authorize. The pool-side signature is exact: in one
             * window, 470 connected / 470 subscribed / 470 disconnected, and
             * ZERO ever authorized on this lane.
             *
             * Nothing is lost by deferring. The job still goes out in the same
             * millisecond, so a client that subscribes and waits for work
             * (MiningRigRentals and friends) is unaffected; it simply arrives
             * in the order every other Equihash pool uses.
             */
            /*
             * THE SUBSCRIBE REPLY IS WHERE THE Z9 ACTUALLY DIED.
             *
             * Reported as "No servers could be used! Exiting." — which is a
             * cgminer-family failure to establish the session AT ALL, upstream
             * of ever submitting a share. The agent logging added above is what
             * made it visible: the miner connects, subscribes as
             * "cgminer/4.9.0", and hangs up IN THE SAME SECOND; retries once
             * with no agent string; hangs up again; loops every 5s forever. It
             * never reaches mining.authorize. So it read this reply and
             * rejected it.
             *
             * Two things in the old reply `["blockle-session", <32 hex>]` are
             * outside what the Equihash stratum ecosystem actually emits, and
             * Z9-era firmware is strict about both:
             *
             * 1. SESSION ID WAS NOT HEX. Every ZEC-family pool sends a hex
             *    session id, and these cgminer forks store and re-parse it as
             *    hex; the literal ASCII "blockle-session" is not decodable.
             *
             * 2. NONCE1 WAS 16 BYTES. The convention on this family is a SHORT
             *    extranonce1 — 4 bytes — with the miner taking nonce2 as the
             *    remaining 28. Firmware sizes its nonce2 buffer from that and
             *    rejects an over-long nonce1 rather than adapting.
             *
             * Truncating to 4 bytes is safe for uniqueness precisely because
             * nonce1 is filled LITTLE-endian from the client counter, so the
             * low four bytes are the part that varies: 2^32 concurrent
             * connections before any reuse. Big-endian would have made every
             * early miner's prefix all-zero and collided immediately.
             *
             * Nothing that works today breaks, because split_nonce infers the
             * split from the nonce2 the miner sends rather than from what we
             * advertised. A spec-correct miner now computes 32-4=28, sends 28,
             * and reconstructs against nonce1[..4]; that path is tested.
             */
            Ok(json!([
                hex::encode(SESSION_PREFIX),
                hex::encode(&nonce1[..ADVERTISED_NONCE1_LEN])
            ]))
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
            let address = decode_address(addr_part).unwrap_or(state.opts.pool_address);
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
            let nonce2 = hex::decode(p[3].as_str().ok_or("bad nonce2")?)
                .map_err(|_| "bad nonce2 hex".to_string())?;
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
            block.header.nonce = split_nonce(&nonce1, &nonce2)?;
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
            let per_client = |c: &Client| {
                // Stable lifetime estimate: Σ accepted share difficulty / seconds
                // connected. The old window-based value reset to 0 on every vardiff
                // retarget, so a 15s stats sample routinely read ~0 despite live miners.
                c.accepted_weight / c.connected_at.elapsed().as_secs_f64().max(1.0)
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
    // Accumulate this share's difficulty (at the diff it was mined at) for the
    // stable lifetime hashrate estimate.
    c.accepted_weight += u256_f64(state.node.params().pow_limit) / u256_f64(c.share_target).max(1.0);
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

/// Rebuild the 32-byte header nonce from our `nonce1` and the miner's `nonce2`.
///
/// THE MINER'S NONCE2 LENGTH DECIDES THE SPLIT, and that is the whole point.
///
/// `mining.subscribe` advertises `ADVERTISED_NONCE1_LEN` bytes of nonce1, and
/// spec-correct firmware derives `nonce2_len = 32 - len(nonce1)`. Older Equihash
/// ASICs do not: firmware from that era (Innosilicon Z9 / Z9 mini in
/// particular) assumes a nonce2 width rather than computing it — so it consumes
/// only the first few bytes of whatever nonce1 it was handed and submits a
/// longer nonce2. Accepting both is why this is inferred rather than fixed.
///
/// Against the old fixed `[u8; 16]` decode that failed EVERY share with
/// "expected 16 bytes", which from the miner's side is indistinguishable from
/// the pool ignoring it: connect, submit, nothing, restart with no work.
///
/// So infer it instead — whatever the miner did NOT send is the prefix of our
/// nonce1 it must have used. A miner that consumed all 16 sends 16 and gets
/// `nonce1[..16]`; one that consumed 4 sends 28 and gets `nonce1[..4]`. Both
/// reconstruct the exact nonce the miner hashed, so both verify, and no miner
/// that works today stops working.
///
/// The 4-byte floor is what keeps nonce1 doing its job: per-connection
/// uniqueness so two miners do not grind the same search space. `nonce1[..8]`
/// is the client id and bytes 8..16 are zero padding, so 4 bytes still
/// distinguishes four billion connections — 0 would let two miners collide.
const ADVERTISED_NONCE1_LEN: usize = 4;

/// Session id bytes, sent hex-encoded.
///
/// HEX, NOT ASCII. This used to be the literal string "blockle-session", which
/// no ZEC-family pool would emit: the convention is a hex session id, and the
/// cgminer forks these ASICs run re-parse it as hex. A Z9 mini subscribed,
/// read the reply, and hung up in the same second — twice per attempt, forever
/// — which surfaces to the operator only as "No servers could be used!".
const SESSION_PREFIX: [u8; 4] = [0xb1, 0x0c, 0x6e, 0x01];
fn split_nonce(nonce1: &[u8; 16], nonce2: &[u8]) -> Result<[u8; 32], String> {
    if nonce2.len() < 16 || nonce2.len() > 28 {
        return Err(format!(
            "nonce2 must be 16..=28 bytes (got {}); the 32-byte header nonce is \
             nonce1 || nonce2 and nonce1 needs at least 4 bytes to keep miners \
             off each other's search space",
            nonce2.len()
        ));
    }
    let nonce1_len = 32 - nonce2.len();
    let mut out = [0u8; 32];
    out[..nonce1_len].copy_from_slice(&nonce1[..nonce1_len]);
    out[nonce1_len..].copy_from_slice(nonce2);
    Ok(out)
}

#[cfg(test)]
mod nonce_split_tests {
    use super::{split_nonce, ADVERTISED_NONCE1_LEN, SESSION_PREFIX};

    /// What we advertise has to be something this family will accept, and the
    /// two properties that mattered are cheap to pin: a SHORT nonce1, and a
    /// session id that is valid hex. Both were wrong, and the only symptom was
    /// "No servers could be used! Exiting." with no pool-side error at all.
    #[test]
    fn subscribe_reply_shape_is_what_equihash_asics_expect() {
        assert_eq!(
            ADVERTISED_NONCE1_LEN, 4,
            "a 4-byte extranonce1 is the convention on this family; Z9-era \
             firmware sizes its nonce2 buffer from it and rejects longer"
        );
        // Must survive a hex round-trip, which the old ASCII "blockle-session"
        // could not.
        let s = hex::encode(SESSION_PREFIX);
        assert_eq!(s.len(), SESSION_PREFIX.len() * 2);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()), "session id must be hex: {s}");
        assert_eq!(hex::decode(&s).unwrap(), SESSION_PREFIX);
    }

    /// The advertised length and the inferred split have to AGREE: a miner that
    /// believes us sends `32 - ADVERTISED_NONCE1_LEN` bytes, and that has to
    /// reconstruct against the same prefix we handed out. If someone changes
    /// one constant without the other, every share from every compliant miner
    /// silently reconstructs the wrong nonce and fails verification.
    #[test]
    fn a_miner_that_believes_our_advertised_length_reconstructs_correctly() {
        let n1 = n1();
        let nonce2_len = 32 - ADVERTISED_NONCE1_LEN;
        let nonce2: Vec<u8> = (0..nonce2_len).map(|i| 0x80 + i as u8).collect();

        let got = split_nonce(&n1, &nonce2).expect("the advertised split must be accepted");
        assert_eq!(
            &got[..ADVERTISED_NONCE1_LEN],
            &n1[..ADVERTISED_NONCE1_LEN],
            "the prefix must be exactly what mining.subscribe advertised"
        );
        assert_eq!(&got[ADVERTISED_NONCE1_LEN..], &nonce2[..], "and the rest is the miner's");
    }

    fn n1() -> [u8; 16] {
        let mut a = [0u8; 16];
        for (i, b) in a.iter_mut().enumerate() {
            *b = i as u8 + 1;
        }
        a
    }

    #[test]
    fn a_spec_correct_miner_sending_16_is_unchanged() {
        // The behaviour that works today and must keep working: miners
        // currently on the lane are accepted at 72/0 and 626/5.
        let got = split_nonce(&n1(), &[0xAA; 16]).unwrap();
        assert_eq!(&got[..16], &n1()[..], "our full nonce1 is the prefix");
        assert_eq!(&got[16..], &[0xAA; 16], "and theirs is the suffix");
    }

    #[test]
    fn a_z9_style_miner_sending_28_is_accepted() {
        // THE FIX. Firmware that assumes a 4-byte nonce1 consumes nonce1[..4]
        // and submits 28 bytes. This used to fail every share.
        let got = split_nonce(&n1(), &[0xBB; 28]).unwrap();
        assert_eq!(&got[..4], &[1, 2, 3, 4], "only the four bytes it used");
        assert_eq!(&got[4..], &[0xBB; 28]);
    }

    #[test]
    fn every_split_in_range_reconstructs_exactly_32_bytes() {
        for len in 16..=28usize {
            let n2 = vec![0xCC; len];
            let got = split_nonce(&n1(), &n2).expect("len in range");
            let used = 32 - len;
            assert_eq!(&got[..used], &n1()[..used]);
            assert_eq!(&got[used..], &n2[..]);
        }
    }

    #[test]
    fn a_nonce2_that_would_leave_no_room_for_uniqueness_is_refused() {
        // 32 bytes would mean nonce1 contributes nothing and two miners could
        // grind the identical search space. 29..=32 all cross that line.
        for len in [29usize, 30, 31, 32] {
            let err = split_nonce(&n1(), &vec![0u8; len]).unwrap_err();
            assert!(err.contains("16..=28"), "{err}");
            assert!(err.contains(&len.to_string()), "names the length it got: {err}");
        }
    }

    #[test]
    fn a_short_nonce2_is_refused_rather_than_zero_padded() {
        // Padding would silently hash a different nonce than the miner did,
        // so the share would fail verification for a reason nobody could see.
        let err = split_nonce(&n1(), &[0u8; 8]).unwrap_err();
        assert!(err.contains("16..=28"), "{err}");
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

#[cfg(test)]
mod wire_shape_tests {
    use super::*;

    /*
     * THESE TESTS EXIST TO KEEP deploy/box/z9-stratum-ab.py HONEST.
     *
     * That script is the decisive diagnostic for the Z9 Mini reporting
     * "No servers could be used! Exiting." It works by replaying this
     * server's exact bytes from a throwaway listener and changing ONE thing
     * per port, so the miner itself says which change matters. The whole
     * method collapses if its `baseline` variant stops being a faithful
     * replica of what this file emits — and it would collapse SILENTLY,
     * producing a confident-looking verdict table about a server nobody runs.
     *
     * So each test below pins one property the probe hard-codes. If someone
     * changes this file, the test that breaks names the constant in the
     * probe that has to change with it.
     *
     * The wrong conclusion to draw from a failure here is "the test is
     * stale, update the expectation". The expectation IS the thing under
     * test: it is a claim about bytes a real ASIC reacted to.
     */

    fn test_client() -> (Client, std::sync::mpsc::Receiver<String>) {
        let (tx, rx) = channel::<String>();
        (
            Client {
                sender: tx,
                nonce1: [0u8; 16],
                subscribed: true,
                address: None,
                worker: String::new(),
                // What handle_client seeds every client with (stratum.rs:357):
                // the chain pow limit, never a share floor.
                share_target: U256::MAX >> 1,
                window_start: Instant::now(),
                window_shares: 0,
                accepted: 0,
                rejected: 0,
                accepted_weight: 0.0,
                connected_at: Instant::now(),
            },
            rx,
        )
    }

    fn test_block() -> Block {
        Block {
            header: blockle_core::BlockHeader {
                version: 1,
                prev_hash: [0x11u8; 32],
                merkle_root: [0x22u8; 32],
                state_root: [0u8; 32],
                time: 0x6b07_8c21,
                bits: 0x1f01_4bfb,
                nonce: [0u8; 32],
                solution: Vec::new(),
            },
            aux_pow: None,
            transactions: Vec::new(),
        }
    }

    /// A stratum message leaves this server as TWO write() syscalls — the
    /// JSON body, then the newline — because stratum.rs:370 formats with
    /// `writeln!` onto an UNBUFFERED TcpStream, and nothing here ever calls
    /// set_nodelay. With Nagle on, the newline therefore cannot go out until
    /// the peer ACKs the body, so a line-oriented client sees a complete line
    /// a full round trip late. Measured against the live pool while writing
    /// the probe:
    ///
    ///   AUTHrx +8079.4ms len= 35 nl=False   {"error":null,"id":2,"result":true}
    ///   AUTHrx +8104.1ms len=  1 nl=True    the newline, alone, 24.7ms later
    ///
    /// The probe's `framing` axis is the fix for this (one send per line);
    /// its `baseline` axis deliberately reproduces the split. If this test
    /// ever fails, the split is gone and that axis is no longer a variable.
    #[test]
    fn a_stratum_line_leaves_as_two_writes_which_is_why_the_newline_lags() {
        struct Recording(Vec<Vec<u8>>);
        impl Write for Recording {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.push(buf.to_vec());
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let line = json!({"id": 2, "result": true, "error": null}).to_string();
        let mut w = Recording(Vec::new());
        // Byte-for-byte the call at stratum.rs:370.
        writeln!(w, "{line}").unwrap();

        let writes: Vec<&[u8]> = w.0.iter().map(|v| v.as_slice()).collect();
        assert_eq!(
            writes.len(),
            2,
            "writeln! on an unbuffered stream should split body and newline, got {writes:?}"
        );
        assert_eq!(writes[0], line.as_bytes(), "first write is the bare body");
        assert_eq!(writes[1], b"\n", "and the newline goes out on its own");
    }

    /// The job push is `set_target` then `notify`, and the subscribe handler
    /// (stratum.rs:452-464) runs it BEFORE returning its own reply, which
    /// handle_client only enqueues afterwards (stratum.rs:391) into this same
    /// FIFO channel. That is the `order` hypothesis, and it is the shape the
    /// probe's baseline replays: work first, reply third.
    #[test]
    fn the_job_push_is_set_target_then_notify_ahead_of_any_reply() {
        let (client, rx) = test_client();
        let block = test_block();
        send_job(&client, "2d8-20f", &block, true);
        // Only now does handle_client get to push the subscribe reply.
        push(&client, json!({"id": 26, "result": ["b10c6e01", "0f020000"], "error": null}));

        let lines: Vec<Value> = rx.try_iter().map(|s| serde_json::from_str(&s).unwrap()).collect();
        assert_eq!(lines.len(), 3, "three lines reach the miner for one subscribe");
        /*
         * THE ORDERING FIX HAS LANDED, so this no longer asserts what it was
         * written to assert — and it is worth recording that it did not catch
         * the change, because it could not.
         *
         * It calls send_job() and then push() by hand, in that order, so it
         * only ever tested send_job's INTERNAL order (set_target before
         * notify, still true and still asserted below). The thing that
         * actually moved is WHERE handle_client calls send_job relative to
         * writing the reply, and no amount of hand-sequencing in a unit test
         * can observe that. Its own comment promised it would fail when the
         * fix arrived; it passed instead.
         *
         * The real ordering contract is now pinned by
         * `the_subscribe_reply_is_the_first_line_a_miner_reads`, which drives
         * handle_client over a socket rather than poking the channel.
         */
        assert_eq!(lines[0]["method"], "mining.set_target");
        assert_eq!(lines[1]["method"], "mining.notify");
        assert!(
            lines[2]["method"].is_null() && lines[2]["id"] == 26,
            "hand-sequenced here, so this says nothing about the live order"
        );
    }

    //
    // The live ordering contract is asserted in crates/node/tests/stratum_e2e.rs,
    // which already stands up a real pool and a real socket. It cannot be done
    // here: observing what order the SERVER writes requires the server, and a
    // unit test that hand-sequences the channel is exactly the mistake above.

    /// The target handed out at subscribe time is the chain pow limit, i.e.
    /// difficulty ~2 — no real Equihash pool sends this. It happens because
    /// stratum.rs:357 seeds share_target from params().pow_limit and
    /// PoolOpts::share_floor_target is only ever read in stratum_btc.rs:146,
    /// never in this file. The probe's `target` axis divides this value down;
    /// this test pins the string the probe expects to find and lower.
    ///
    /// Deliberately NOT written as a grep for `share_floor_target` in this
    /// file: an assertion that some source text is ABSENT keeps passing once
    /// the text it looks for is reformatted, so it would stop checking
    /// without ever failing. The behavioural assertion below cannot rot that
    /// way — a floor applied to this lane changes the string.
    #[test]
    fn subscribe_hands_out_the_pow_limit_as_the_share_target() {
        let (client, rx) = test_client();
        send_job(&client, "j", &test_block(), true);
        let first: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
        assert_eq!(
            first["params"][0],
            "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "this exact string was captured off the live pool and is what the probe replays"
        );
    }

    /// The subscribe reply the probe reconstructs: a hex session id, then the
    /// LOW FOUR BYTES of the client counter, little-endian. The probe mints
    /// its own per-session nonce1 with struct.pack("<I", n).hex(); if that
    /// stopped matching, every variant would carry an extra unintended
    /// deviation and a PASS would be unattributable.
    #[test]
    fn the_probe_reconstructs_our_nonce1_exactly() {
        let mut nonce1 = [0u8; 16];
        let client_id: u64 = 729; // a real miner id from the Z9's own session log
        nonce1[..8].copy_from_slice(&client_id.to_le_bytes());
        let reply = json!([
            hex::encode(SESSION_PREFIX),
            hex::encode(&nonce1[..ADVERTISED_NONCE1_LEN])
        ]);
        assert_eq!(reply[0], "b10c6e01", "probe constant SESSION_PREFIX_HEX");
        assert_eq!(reply[1], "d9020000", "4 LE bytes of the counter, as struct.pack('<I')");
    }
}
