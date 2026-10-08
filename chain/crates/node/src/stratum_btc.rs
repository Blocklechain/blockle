//! Dedicated per-algorithm BLOCK pools over classic **bitcoin stratum v1**.
//!
//! An AuxPoW proof never requires the parent header to belong to a real
//! chain — only real work at the lane target plus the coinbase commitment.
//! So SHA-256, Scrypt, X11, Blake and friends can mine BLOCK *directly*:
//! each miner grinds a minimal synthetic 80-byte parent header whose
//! single-transaction "block" is a coinbase committing to a BLOCK template
//! that pays that miner (solo semantics, pool fee in the coinbase split).
//!
//! Dialect: `mining.subscribe` → `[[subs], extranonce1, 4]`,
//! `mining.authorize` (username = BLOCK address[.rig]),
//! `mining.set_difficulty` + `mining.notify` with
//! `[job, prevhash, coinb1, coinb2, merkle_branch, version, nbits, ntime,
//! clean]`, `mining.submit` with `[worker, job, extranonce2, ntime, nonce]`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use blockle_chain::U256;
use blockle_core::keys::{decode_address, encode_address, Address};
use blockle_core::{auxpow, sha256d, AuxPow, Block};
use blockle_pow::difficulty::compact_to_target;
use blockle_pow::parent;

use std::collections::VecDeque;

use crate::p2p::Node;
use crate::stratum::{append_ledger_record, PoolMode, PoolOpts};

const TARGET_SHARE_SECS: u64 = 10;
const RETARGET_SECS: u64 = 30;
/// BIP 310 version-rolling mask every modern SHA-256 ASIC uses.
const STD_VERSION_MASK: u32 = 0x1fff_e000;

struct Client {
    sender: Sender<String>,
    extranonce1: [u8; 4],
    dumped: bool,
    /// Negotiated version-rolling mask (mining.configure / BIP 310);
    /// zero when the miner didn't negotiate.
    version_mask: u32,
    subscribed: bool,
    address: Option<Address>,
    worker: String,
    share_target: U256,
    window_start: Instant,
    window_shares: u32,
    accepted: u64,
    rejected: u64,
}

/// A per-client job: the BLOCK template this parent work commits to, plus
/// the synthetic coinbase halves around the extranonce.
struct DirectJob {
    block: Block,
    coinb1: Vec<u8>,
    coinb2: Vec<u8>,
    version: u32,
    nbits: u32,
    ntime: u32,
}

struct DirectState {
    node: Arc<Node>,
    algo: &'static str,
    opts: PoolOpts,
    clients: Mutex<HashMap<u64, Client>>,
    jobs: Mutex<HashMap<String, (u64, DirectJob)>>,
    /// PPLNS: the shared job every miner works on.
    current_job: Mutex<Option<String>>,
    /// PPLNS rolling share window: (address, difficulty weight).
    shares: Mutex<VecDeque<(Address, f64)>>,
    found: Mutex<Vec<Value>>,
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

/// bitcoin "difficulty 1" target (0x1d00ffff).
fn diff1() -> U256 {
    compact_to_target(0x1d00ffff).expect("static bits")
}

fn target_hex(t: U256) -> String {
    let mut be = [0u8; 32];
    t.to_big_endian(&mut be);
    hex::encode(be)
}

/// Starting share difficulty per algorithm — roughly one share / 10 s for
/// mid-range hardware of that family; vardiff corrects from there.
fn initial_diff(algo: &str) -> u64 {
    match algo {
        "sha256d" => 4096,
        "scrypt" => 16,
        "x11" => 64,
        "kheavyhash" | "blake3" => 1024,
        "eaglesong" | "blake2b" | "blake2s" => 256,
        _ => 64,
    }
}

fn floor_target(state: &DirectState) -> U256 {
    state
        .opts
        .share_floor_target
        .unwrap_or_else(|| diff1() / U256::from(initial_diff(state.algo)))
}

/// Serve a direct BLOCK pool for one fixed-header parent algorithm.
pub fn serve(node: Arc<Node>, addr: String, algo: &'static str, opts: PoolOpts) {
    let state = Arc::new(DirectState {
        node,
        algo,
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
                    println!("[stratum-direct:{algo}] listening on {addr}");
                    l
                }
                Err(e) => {
                    println!("[stratum-direct:{algo}] cannot listen on {addr}: {e}");
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

fn ease_idle_miners(state: &Arc<DirectState>) {
    // A miner that has been silent for 60 s is probably too small for the
    // current difficulty (or its firmware clamped ours): ease ×16 per
    // minute down to difficulty 0.25 so even toy hardware gets traction.
    let min_target = diff1() * U256::from(4u64); // difficulty 0.25
    let mut clients = state.clients.lock().unwrap();
    for c in clients.values_mut() {
        if c.address.is_some()
            && c.accepted == 0
            && c.window_start.elapsed().as_secs() >= 60
        {
            let eased = (c.share_target << 4).min(min_target);
            if eased != c.share_target {
                c.share_target = eased;
                c.window_start = Instant::now();
                let d = u256_f64(diff1()) / u256_f64(c.share_target).max(1.0);
                println!(
                    "[stratum-direct:{}] easing idle miner to difficulty {d:.4}",
                    state.algo
                );
                push(c, json!({"id": null, "method": "mining.set_difficulty", "params": [d]}));
            }
        }
    }
}

fn job_loop(state: Arc<DirectState>) {
    let mut last_gen = u64::MAX;
    let mut last_refresh = Instant::now();
    loop {
        let gen = state.node.tip_generation();
        let fresh = gen != last_gen;
        if fresh || last_refresh.elapsed() > Duration::from_secs(30) {
            last_gen = gen;
            last_refresh = Instant::now();
            ease_idle_miners(&state);
            if state.opts.mode == PoolMode::Pplns {
                if let Some(job) = build_direct_job(&state, state.opts.pool_address) {
                    let n = state.next_job.fetch_add(1, Ordering::SeqCst);
                    let job_id = format!("p{n:x}");
                    let params = notify_params_for(&job_id, &job);
                    let lane_target = compact_to_target(job.nbits).unwrap_or_default();
                    state.jobs.lock().unwrap().insert(job_id.clone(), (n, job));
                    *state.current_job.lock().unwrap() = Some(job_id);
                    let clients = state.clients.lock().unwrap();
                    for c in clients.values().filter(|c| c.subscribed && c.address.is_some()) {
                        send_notify(c, &params, lane_target, fresh);
                    }
                }
            } else {
                let targets: Vec<(u64, Address)> = {
                    let clients = state.clients.lock().unwrap();
                    clients
                        .iter()
                        .filter(|(_, c)| c.subscribed && c.address.is_some())
                        .map(|(id, c)| (*id, c.address.expect("filtered")))
                        .collect()
                };
                for (client_id, addr) in targets {
                    push_job(&state, client_id, addr, fresh);
                }
            }
            let mut jobs = state.jobs.lock().unwrap();
            if jobs.len() > 256 {
                let min_keep = state.next_job.load(Ordering::SeqCst).saturating_sub(256);
                jobs.retain(|_, (n, _)| *n >= min_keep);
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn recipients(state: &DirectState, miner: Address) -> Vec<(Address, u32)> {
    if state.opts.mode == PoolMode::Pplns {
        return vec![(state.opts.pool_address, 10_000)];
    }
    let fee = state.opts.fee_bp.min(10_000);
    if fee > 0 && miner != state.opts.pool_address {
        vec![(miner, 10_000 - fee), (state.opts.pool_address, fee)]
    } else {
        vec![(miner, 10_000)]
    }
}

/// Serialize `height` as a BIP34 coinbase scriptSig prefix: a minimal
/// little-endian CScriptNum, length-prefixed as a data push.
fn bip34_height(height: u64) -> Vec<u8> {
    if height == 0 {
        return vec![0x00]; // OP_0
    }
    let mut n = height;
    let mut bytes = Vec::new();
    while n > 0 {
        bytes.push((n & 0xff) as u8);
        n >>= 8;
    }
    if bytes.last().is_some_and(|b| b & 0x80 != 0) {
        bytes.push(0x00); // keep it positive
    }
    let mut out = vec![bytes.len() as u8]; // small push (len < 0x4c)
    out.extend_from_slice(&bytes);
    out
}

/// Build the synthetic parent coinbase around the extranonce slot and the
/// BLOCK commitment, split for stratum (coinb1 ‖ en1 ‖ en2 ‖ coinb2).
fn build_direct_job(state: &DirectState, addr: Address) -> Option<DirectJob> {
    let mut block = state
        .node
        .block_template_split(&recipients(state, addr))
        .ok()?;
    let (chain, _) = state.node.snapshot();
    // Quiet-lane decay keys off the aux block's own timestamp; nbits (below)
    // must carry the same value, since check_aux_pow verifies the parent PoW
    // against this lane difficulty.
    let bits = chain.next_bits_for_at(state.algo, block.header.time as i64);
    block.header.bits = bits;
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];
    let aux_hash = block.header.hash();
    let commitment = auxpow::mm_commitment(&aux_hash, 1, 0);

    // BIP34 height at the start of the scriptSig, and a non-zero coinbase
    // output (the BLOCK reward), so ASIC firmware coinbase decoders (e.g.
    // ESP-Miner on Bitaxe) can parse the job and show the block header panel.
    // These bytes are cosmetic for consensus — check_aux_pow locates the
    // merge-mining commitment by scanning, not by offset.
    let height = chain.blocks.len() as u64;
    let bip34 = bip34_height(height);
    let reward: u64 = block.transactions[0].outputs.iter().map(|o| o.amount).sum();

    // scriptSig = bip34_height ‖ extranonce1(4) ‖ extranonce2(4) ‖ commitment(44)
    let script_len = bip34.len() + 4 + 4 + commitment.len();
    let mut coinb1 = Vec::new();
    coinb1.extend_from_slice(&1u32.to_le_bytes()); // tx version
    coinb1.push(1); // one input
    coinb1.extend_from_slice(&[0u8; 32]); // null prevout hash
    coinb1.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // prevout index
    coinb1.push(script_len as u8); // script length (always < 0xfd)
    coinb1.extend_from_slice(&bip34); // BIP34 block height push
    // …extranonce1 ‖ extranonce2 go here…
    let mut coinb2 = Vec::new();
    coinb2.extend_from_slice(&commitment);
    coinb2.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // sequence
    coinb2.push(1); // one output
    coinb2.extend_from_slice(&reward.to_le_bytes()); // non-zero value (BLOCK reward)
    coinb2.push(1); // script len
    coinb2.push(0x51); // OP_TRUE
    coinb2.extend_from_slice(&0u32.to_le_bytes()); // locktime

    Some(DirectJob {
        block,
        coinb1,
        coinb2,
        version: 0x2000_0000,
        nbits: bits,
        ntime: now_unix() as u32,
    })
}

fn notify_params_for(job_id: &str, job: &DirectJob) -> Value {
    json!([
        job_id,
        hex::encode([0u8; 32]), // synthetic prevhash
        hex::encode(&job.coinb1),
        hex::encode(&job.coinb2),
        Vec::<String>::new(),
        format!("{:08x}", job.version),
        format!("{:08x}", job.nbits),
        format!("{:08x}", job.ntime),
        true,
    ])
}

fn send_notify(client: &Client, params: &Value, _lane_target: U256, clean: bool) {
    let mut params = params.clone();
    if let Some(a) = params.as_array_mut() {
        if let Some(last) = a.last_mut() {
            *last = json!(clean);
        }
    }
    let d = u256_f64(diff1()) / u256_f64(client.share_target).max(1.0);
    push(client, json!({"id": null, "method": "mining.set_difficulty", "params": [d]}));
    push(client, json!({"id": null, "method": "mining.notify", "params": params}));
}

fn push_job(state: &Arc<DirectState>, client_id: u64, addr: Address, clean: bool) {
    let Some(job) = build_direct_job(state, addr) else { return };
    let n = state.next_job.fetch_add(1, Ordering::SeqCst);
    let job_id = format!("{n:x}-{client_id:x}");
    let params = notify_params_for(&job_id, &job);
    let lane_target = compact_to_target(job.nbits).unwrap_or_default();
    state.jobs.lock().unwrap().insert(job_id, (n, job));
    let clients = state.clients.lock().unwrap();
    if let Some(client) = clients.get(&client_id) {
        send_notify(client, &params, lane_target, clean);
    }
}

fn push(client: &Client, msg: Value) {
    let _ = client.sender.send(msg.to_string());
}

fn handle_client(state: Arc<DirectState>, stream: TcpStream) {
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_else(|_| "?".into());
    let client_id = state.next_client.fetch_add(1, Ordering::SeqCst);
    let mut extranonce1 = [0u8; 4];
    extranonce1.copy_from_slice(&(client_id as u32).to_le_bytes());

    let mut write_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let (tx, rx) = channel::<String>();
    state.clients.lock().unwrap().insert(
        client_id,
        Client {
            sender: tx,
            extranonce1,
            version_mask: 0,
            dumped: false,
            subscribed: false,
            address: None,
            worker: String::new(),
            share_target: floor_target(&state),
            window_start: Instant::now(),
            window_shares: 0,
            accepted: 0,
            rejected: 0,
        },
    );
    println!("[stratum-direct:{}] miner {client_id} connected ({peer})", state.algo);

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
        let ok = reply.is_ok();
        {
            let clients = state.clients.lock().unwrap();
            if let Some(client) = clients.get(&client_id) {
                match &reply {
                    Ok(result) => {
                        push(client, json!({"id": id, "result": result, "error": null}))
                    }
                    Err(msg) => {
                        push(client, json!({"id": id, "result": null, "error": [20, msg, null]}))
                    }
                }
            }
        }
        // Standard stratum ordering: the mining.subscribe / mining.authorize
        // REPLY (carrying extranonce1 / auth result) must reach the miner
        // BEFORE any set_difficulty + notify. Sending work first makes real
        // ASIC firmware (e.g. a Bitaxe / BM1370) receive a job with no
        // extranonce1 and reboot. So we push the initial job only now, after
        // the reply has been enqueued — never from inside the handlers.
        if ok {
            match method {
                "mining.subscribe" => {
                    push_job(&state, client_id, state.opts.pool_address, true);
                }
                "mining.authorize" => {
                    let addr = state
                        .clients
                        .lock()
                        .unwrap()
                        .get(&client_id)
                        .and_then(|c| c.address);
                    if let Some(a) = addr {
                        push_job(&state, client_id, a, true);
                    }
                }
                _ => {}
            }
        }
    }
    state.clients.lock().unwrap().remove(&client_id);
    println!("[stratum-direct:{}] miner {client_id} disconnected ({peer})", state.algo);
    let _ = writer.join();
}

fn handle_request(
    state: &Arc<DirectState>,
    client_id: u64,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    match method {
        "mining.configure" => {
            // BIP 310: modern sha256d ASICs roll header version bits.
            // Without this negotiation their reconstructed headers never
            // match ours and every share dies as "low diff".
            const MASK: u32 = STD_VERSION_MASK;
            let wants_rolling = params
                .get(0)
                .and_then(|v| v.as_array())
                .map(|a| a.iter().any(|x| x.as_str() == Some("version-rolling")))
                .unwrap_or(false);
            if wants_rolling {
                if let Some(c) = state.clients.lock().unwrap().get_mut(&client_id) {
                    c.version_mask = MASK;
                }
                println!(
                    "[stratum-direct:{}] miner {client_id} negotiated version-rolling",
                    state.algo
                );
                Ok(json!({
                    "version-rolling": true,
                    "version-rolling.mask": format!("{MASK:08x}"),
                    "version-rolling.min-bit-count": 2,
                }))
            } else {
                Ok(json!({}))
            }
        }
        "mining.subscribe" => {
            let agent = params
                .get(0)
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            println!(
                "[stratum-direct:{}] miner {client_id} subscribe agent={agent:?}",
                state.algo
            );
            let en1 = {
                let mut clients = state.clients.lock().unwrap();
                let c = clients.get_mut(&client_id).ok_or("gone")?;
                c.subscribed = true;
                c.extranonce1
            };
            // The placeholder job (for subscribe-and-wait validators like
            // MiningRigRentals) is pushed by the caller AFTER this reply is
            // sent, so the miner always receives extranonce1 first.
            Ok(json!([
                [["mining.set_difficulty", "d"], ["mining.notify", "n"]],
                hex::encode(en1),
                4
            ]))
        }
        "mining.authorize" => {
            let worker = params
                .get(0)
                .and_then(|v| v.as_str())
                .ok_or("authorize needs a username")?
                .to_string();
            let addr_part = worker.split('.').next().unwrap_or(&worker);
            let address = decode_address(addr_part).map_err(|_| {
                "authorize with your BLOCK address (block1…) as the username".to_string()
            })?;
            println!(
                "[stratum-direct:{}] miner {client_id} authorized {}",
                state.algo,
                &worker[..24.min(worker.len())]
            );
            {
                let mut clients = state.clients.lock().unwrap();
                let c = clients.get_mut(&client_id).ok_or("gone")?;
                c.address = Some(address);
                c.worker = worker;
            }
            // Fresh job (paying the authorized address) is pushed by the caller
            // after this authorize reply, keeping standard reply-then-work order.
            Ok(json!(true))
        }
        "mining.extranonce.subscribe" => Ok(json!(true)),
        // Accepted but ignored: we set difficulty from the lane target, not the
        // miner's hint. Returning ok avoids a spurious "unknown method" error.
        "mining.suggest_difficulty" | "mining.suggest_target" => Ok(json!(true)),
        "mining.submit" => {
            let p = params.as_array().ok_or("bad params")?;
            if p.len() < 5 {
                return Err("expected [worker, job, extranonce2, ntime, nonce]".into());
            }
            let job_id = p[1].as_str().ok_or("bad job id")?;
            let en2: [u8; 4] = decode_fixed(p[2].as_str().ok_or("bad extranonce2")?)?;
            let ntime = u32::from_str_radix(p[3].as_str().ok_or("bad ntime")?, 16)
                .map_err(|_| "bad ntime hex")?;
            let nonce = u32::from_str_radix(p[4].as_str().ok_or("bad nonce")?, 16)
                .map_err(|_| "bad nonce hex")?;
            // BIP 310 version-rolling: 6th param carries the rolled bits.
            let version_bits = p
                .get(5)
                .and_then(|v| v.as_str())
                .and_then(|h| u32::from_str_radix(h, 16).ok());

            let (en1, worker, miner_addr, vmask) = {
                let clients = state.clients.lock().unwrap();
                let c = clients.get(&client_id).ok_or("gone")?;
                let Some(addr) = c.address else {
                    return Err("authorize before submitting".into());
                };
                (c.extranonce1, c.worker.clone(), addr, c.version_mask)
            };
            let (block, coinbase, header, nbits) = {
                let jobs = state.jobs.lock().unwrap();
                let Some((_, job)) = jobs.get(job_id) else {
                    println!(
                        "[stratum-direct:{}] miner {client_id} submit for UNKNOWN job {job_id:?}",
                        state.algo
                    );
                    return Err("unknown job".into());
                };
                let mut coinbase =
                    Vec::with_capacity(job.coinb1.len() + 8 + job.coinb2.len());
                coinbase.extend_from_slice(&job.coinb1);
                coinbase.extend_from_slice(&en1);
                coinbase.extend_from_slice(&en2);
                coinbase.extend_from_slice(&job.coinb2);
                let merkle = sha256d(&coinbase);
                let _ = vmask;
                let version = match version_bits {
                    Some(bits) => (job.version & !STD_VERSION_MASK) | (bits & STD_VERSION_MASK),
                    None => job.version,
                };
                let mut header = [0u8; 80];
                header[0..4].copy_from_slice(&version.to_le_bytes());
                // prevhash stays zero
                header[36..68].copy_from_slice(&merkle);
                header[68..72].copy_from_slice(&ntime.to_le_bytes());
                header[72..76].copy_from_slice(&job.nbits.to_le_bytes());
                header[76..80].copy_from_slice(&nonce.to_le_bytes());
                (job.block.clone(), coinbase, header, job.nbits)
            };

            let pow = parent::pow_hash(state.algo, &header).ok_or("algo vanished")?;
            let pow_val = U256::from_little_endian(&pow);
            let lane_target = compact_to_target(nbits).unwrap_or_default();
            let share_target = {
                let clients = state.clients.lock().unwrap();
                let c = clients.get(&client_id).ok_or("gone")?;
                c.share_target
            };
            if pow_val > share_target {
                if let Some(c) = state.clients.lock().unwrap().get_mut(&client_id) {
                    c.rejected += 1;
                }
                let first = {
                    let mut clients = state.clients.lock().unwrap();
                    match clients.get_mut(&client_id) {
                        Some(c) if !c.dumped => { c.dumped = true; true }
                        _ => false,
                    }
                };
                if first {
                    let jobs = state.jobs.lock().unwrap();
                    if let Some((_, job)) = jobs.get(job_id) {
                        println!(
                            "[shakedown:{}] miner {client_id} job={job_id}\n  params={}\n  en1={} en2={} ntime={ntime:08x} nonce={nonce:08x} vbits={}\n  job.version={:08x} nbits={:08x} coinb1={}\n  coinb2={} reconstructed_header={}\n  pow={} share_target={}",
                            state.algo,
                            serde_json::to_string(p).unwrap_or_default(),
                            hex::encode(en1), hex::encode(en2),
                            version_bits.map(|v| format!("{v:08x}")).unwrap_or_else(|| "-".into()),
                            job.version, job.nbits,
                            hex::encode(&job.coinb1), hex::encode(&job.coinb2),
                            hex::encode(header),
                            hex::encode(pow), target_hex(share_target),
                        );
                    }
                }
                return Err("low difficulty share".into());
            }
            if state.opts.mode == PoolMode::Pplns {
                let weight =
                    u256_f64(state.node.params().pow_limit) / u256_f64(share_target).max(1.0);
                let mut shares = state.shares.lock().unwrap();
                shares.push_back((miner_addr, weight));
                while shares.len() > state.opts.window {
                    shares.pop_front();
                }
            }
            record_share_and_retarget(state, client_id, lane_target);

            if pow_val <= lane_target {
                let mut full = block;
                full.aux_pow = Some(AuxPow {
                    parent_algo: state.algo.into(),
                    parent_header: header.to_vec(),
                    parent_coinbase: coinbase,
                    coinbase_branch: vec![],
                    chain_branch: vec![],
                    chain_index: 0,
                });
                let height = full
                    .transactions
                    .first()
                    .and_then(|t| t.coinbase_data.get(..8))
                    .and_then(|d| d.try_into().ok().map(u64::from_le_bytes))
                    .unwrap_or_default();
                let hash_hex = {
                    let mut h = full.header.hash();
                    h.reverse();
                    hex::encode(h)
                };
                let reward: u64 = full.transactions[0].outputs.iter().map(|o| o.amount).sum();
                if state.node.submit_block(full, None) {
                    println!(
                        "[stratum-direct:{}:{}] miner {client_id} ({worker}) found BLOCK {height}!",
                        state.algo,
                        state.opts.mode.as_str(),
                    );
                    state.found.lock().unwrap().push(json!({
                        "height": height,
                        "hash": hash_hex,
                        "time": now_unix(),
                        "finder": worker,
                    }));
                    if state.opts.mode == PoolMode::Pplns {
                        if let Some(path) = &state.opts.ledger_path {
                            let shares = state.shares.lock().unwrap();
                            append_ledger_record(
                                path, &shares, height, &hash_hex, reward, state.opts.fee_bp,
                            );
                        }
                    }
                }
            }
            Ok(json!(true))
        }
        other => Err(format!("unknown method {other}")),
    }
}

fn record_share_and_retarget(state: &Arc<DirectState>, client_id: u64, _lane_t: U256) {
    let floor = floor_target(state);
    let mut clients = state.clients.lock().unwrap();
    let Some(c) = clients.get_mut(&client_id) else { return };
    c.accepted += 1;
    c.window_shares += 1;
    let elapsed = c.window_start.elapsed().as_secs();
    if elapsed < RETARGET_SECS {
        return;
    }
    // Multiplicative retarget toward one share / TARGET_SHARE_SECS,
    // clamped to ×256 per step so a 100 TH/s ASIC converges in seconds,
    // never easier than the per-algorithm floor.
    let expected = (elapsed / TARGET_SHARE_SECS).max(1) as u64;
    let old = c.share_target;
    let ratio = (c.window_shares as u64).max(1) as f64 / expected as f64;
    if ratio > 1.5 || ratio < 0.5 {
        let factor = ratio.clamp(1.0 / 256.0, 256.0);
        let scaled = u256_f64(c.share_target) / factor;
        let mut t = U256::zero();
        // reconstruct a U256 from the f64 magnitude (coarse is fine here)
        let exp = scaled.log2().clamp(10.0, 255.0) as u32;
        t = (U256::one() << exp) | (U256::one() << exp.saturating_sub(1));
        c.share_target = t.min(floor);
    }
    c.window_start = Instant::now();
    c.window_shares = 0;
    if c.share_target != old {
        let d = u256_f64(diff1()) / u256_f64(c.share_target).max(1.0);
        push(c, json!({"id": null, "method": "mining.set_difficulty", "params": [d]}));
    }
}

fn stats_loop(state: Arc<DirectState>) {
    loop {
        thread::sleep(Duration::from_secs(15));
        let Some(path) = &state.opts.stats_path else { continue };
        let (miners, workers, accepted, rejected, hashrate, miners_detail) = {
            let clients = state.clients.lock().unwrap();
            let pow_limit = u256_f64(state.node.params().pow_limit);
            let per_client = |c: &Client| {
                let diff = pow_limit / u256_f64(c.share_target).max(1.0);
                diff * c.window_shares as f64 / c.window_start.elapsed().as_secs_f64().max(1.0)
            };
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
            (
                clients.len(),
                clients.values().filter(|c| c.address.is_some()).count(),
                clients.values().map(|c| c.accepted).sum::<u64>(),
                clients.values().map(|c| c.rejected).sum::<u64>(),
                clients.values().map(per_client).sum::<f64>(),
                miners_detail,
            )
        };
        let found = state.found.lock().unwrap();
        let stats = json!({
            "pool": "blockle",
            "coin": "BLOCK",
            "algorithm": state.algo,
            "mode": if state.opts.mode == PoolMode::Pplns { "pplns-direct" } else { "solo-direct" },
            "pplns_window_shares": state.shares.lock().unwrap().len(),
            "endpoint": state.opts.endpoint,
            "fee_percent": state.opts.fee_bp as f64 / 100.0,
            "miners": miners,
            "workers": workers,
            "hashrate_sols_est": hashrate,
            "shares_accepted": accepted,
            "shares_rejected": rejected,
            "miners_detail": miners_detail,
            "blocks_found": found.len(),
            "last_block": found.last(),
            "recent_blocks": found.iter().rev().take(25).collect::<Vec<_>>(),
            "pool_address": encode_address(&state.opts.pool_address),
            "updated": now_unix(),
        });
        drop(found);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, stats.to_string());
    }
}

fn decode_fixed<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let bytes = hex::decode(s).map_err(|_| "bad hex".to_string())?;
    bytes.try_into().map_err(|_| format!("expected {N} bytes"))
}
