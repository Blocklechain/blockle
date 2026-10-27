//! Multi-threaded CPU mining. The main thread owns the stratum socket (reads
//! jobs + difficulty, submits shares); N worker threads each mine a disjoint
//! slice of the extranonce2 space against the current job, so no two workers
//! ever hash the same header.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use serde_json::{json, Value};

use crate::algo::Algo;
use crate::hash::{dsha256, header_bytes, merkle_root_from_branch};
use crate::stratum::{parse_notify, Conn, Job};
use crate::target::{meets_target, target_from_difficulty};

pub struct Options {
    pub addr: String,
    pub user: String,
    pub pass: String,
    pub algo: Algo,
    pub threads: usize,
}

struct JobState {
    job: Option<Job>,
    extranonce1: Vec<u8>,
    extranonce2_size: usize,
    target_be: [u8; 32],
}

struct Shared {
    state: Mutex<JobState>,
    epoch: AtomicU64, // bumped on every new job / difficulty change
    running: AtomicBool,
    hashes: AtomicU64, // total hashes, for the hashrate readout
}

struct Found {
    epoch: u64,
    job_id: String,
    extranonce2_hex: String,
    ntime: u32,
    nonce: u32,
}

pub fn run(opts: Options) -> Result<()> {
    let threads = opts.threads.max(1);
    let mut conn = Conn::connect(&opts.addr)?;
    conn.subscribe_and_authorize(&opts.user, &opts.pass)?;

    let shared = Arc::new(Shared {
        state: Mutex::new(JobState {
            job: None,
            extranonce1: Vec::new(),
            extranonce2_size: 4,
            target_be: target_from_difficulty(1.0),
        }),
        epoch: AtomicU64::new(0),
        running: AtomicBool::new(true),
        hashes: AtomicU64::new(0),
    });

    // Handshake: wait for extranonce (subscribe result) + a first job.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() > deadline {
            bail!("handshake timed out — is {} a reachable stratum pool?", opts.addr);
        }
        let ready = {
            let st = shared.state.lock().unwrap();
            !st.extranonce1.is_empty() && st.job.is_some()
        } || {
            // extranonce1 may legitimately be empty on some pools; only require a job then.
            let st = shared.state.lock().unwrap();
            st.job.is_some() && st.extranonce2_size > 0 && handshake_seen(&shared)
        };
        if ready {
            break;
        }
        if let Some(msg) = conn.read_one()? {
            apply_message(&shared, &conn, &msg, opts.algo);
        }
    }
    eprintln!(
        "[blockle-miner] connected · algo={} · threads={} · mining to {}",
        opts.algo.name(), threads, shorten(&opts.user)
    );

    // Workers.
    let (tx, rx): (Sender<Found>, Receiver<Found>) = mpsc::channel();
    let mut handles = Vec::new();
    for wid in 0..threads {
        let sh = shared.clone();
        let tx = tx.clone();
        let algo = opts.algo;
        handles.push(thread::spawn(move || worker(wid, threads, sh, tx, algo)));
    }
    drop(tx);

    // Coordinator loop.
    let mut accepted = 0u64;
    let mut rejected = 0u64;
    let mut last_report = Instant::now();
    let mut last_hashes = 0u64;
    loop {
        // 1. Drain stratum messages (new jobs, difficulty, share replies).
        while let Some(msg) = conn.read_one()? {
            if let Some(ok) = apply_message(&shared, &conn, &msg, opts.algo) {
                if ok { accepted += 1 } else { rejected += 1 }
                eprintln!("[share] {} accepted · {} rejected", accepted, rejected);
            }
        }
        // 2. Submit any shares workers found for the CURRENT epoch.
        let epoch = shared.epoch.load(Ordering::Relaxed);
        while let Ok(f) = rx.try_recv() {
            if f.epoch != epoch {
                continue; // stale (job changed before we submitted) — drop it
            }
            conn.submit(&opts.user, &f.job_id, &f.extranonce2_hex, f.ntime, f.nonce)?;
        }
        // 3. Periodic hashrate readout.
        if last_report.elapsed() >= Duration::from_secs(5) {
            let now = shared.hashes.load(Ordering::Relaxed);
            let hps = (now - last_hashes) as f64 / last_report.elapsed().as_secs_f64();
            eprintln!("[rate] {} · {} accepted / {} rejected", human_hps(hps), accepted, rejected);
            last_hashes = now;
            last_report = Instant::now();
        }
    }
}

/// Has the subscribe reply (id 1) been applied? We track it by a non-default
/// extranonce2_size OR a non-empty extranonce1; pools always send one.
fn handshake_seen(shared: &Shared) -> bool {
    let st = shared.state.lock().unwrap();
    !st.extranonce1.is_empty() || st.extranonce2_size != 4 || st.job.is_some()
}

/// Apply one inbound message. Returns Some(accepted) for a share reply.
fn apply_message(shared: &Shared, _conn: &Conn, msg: &Value, _algo: Algo) -> Option<bool> {
    if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
        match method {
            "mining.set_difficulty" => {
                let d = msg["params"][0].as_f64().unwrap_or(1.0);
                {
                    let mut st = shared.state.lock().unwrap();
                    st.target_be = target_from_difficulty(d);
                }
                shared.epoch.fetch_add(1, Ordering::Relaxed);
            }
            "mining.notify" => {
                if let Ok(j) = parse_notify(msg["params"].as_array().unwrap_or(&vec![])) {
                    let mut st = shared.state.lock().unwrap();
                    st.job = Some(j);
                    drop(st);
                    shared.epoch.fetch_add(1, Ordering::Relaxed);
                }
            }
            _ => {}
        }
        return None;
    }
    // A reply to one of our requests.
    let id = msg.get("id").and_then(|i| i.as_i64())?;
    if id == 1 {
        // subscribe result: [ [..subscriptions..], extranonce1, extranonce2_size ]
        if let Some(r) = msg.get("result").and_then(|r| r.as_array()) {
            let mut st = shared.state.lock().unwrap();
            st.extranonce1 = r.get(1).and_then(|v| v.as_str()).and_then(|s| hex::decode(s).ok()).unwrap_or_default();
            st.extranonce2_size = r.get(2).and_then(|v| v.as_u64()).unwrap_or(4) as usize;
        }
        return None;
    }
    if id >= 100 {
        return Some(msg.get("result") == Some(&json!(true)));
    }
    None
}

fn worker(wid: usize, nthreads: usize, shared: Arc<Shared>, tx: Sender<Found>, algo: Algo) {
    const CHECK_EVERY: u32 = 1 << 14;
    while shared.running.load(Ordering::Relaxed) {
        // Snapshot the current job.
        let (job, en1, en2size, target, epoch) = {
            let st = shared.state.lock().unwrap();
            match &st.job {
                Some(j) => (j.clone(), st.extranonce1.clone(), st.extranonce2_size, st.target_be, shared.epoch.load(Ordering::Relaxed)),
                None => {
                    drop(st);
                    thread::sleep(Duration::from_millis(50));
                    continue;
                }
            }
        };

        // This worker's extranonce2 lane: wid, wid+N, wid+2N, …
        let mut en2val = wid as u64;
        while shared.epoch.load(Ordering::Relaxed) == epoch && shared.running.load(Ordering::Relaxed) {
            let mut en2 = vec![0u8; en2size];
            let b = en2val.to_le_bytes();
            let n = en2size.min(8);
            en2[..n].copy_from_slice(&b[..n]);

            let mut coinbase = job.coinb1.clone();
            coinbase.extend_from_slice(&en1);
            coinbase.extend_from_slice(&en2);
            coinbase.extend_from_slice(&job.coinb2);
            let root = merkle_root_from_branch(dsha256(&coinbase), &job.branch);
            let en2_hex = hex::encode(&en2);

            let mut nonce: u32 = 0;
            loop {
                let header = header_bytes(job.version, &job.prev_le, &root, job.ntime, job.nbits, nonce);
                if meets_target(&algo.pow_hash(&header), &target) {
                    let _ = tx.send(Found {
                        epoch,
                        job_id: job.job_id.clone(),
                        extranonce2_hex: en2_hex.clone(),
                        ntime: job.ntime,
                        nonce,
                    });
                }
                if nonce % CHECK_EVERY == 0 {
                    shared.hashes.fetch_add(CHECK_EVERY as u64, Ordering::Relaxed);
                    if shared.epoch.load(Ordering::Relaxed) != epoch || !shared.running.load(Ordering::Relaxed) {
                        break;
                    }
                }
                if nonce == u32::MAX {
                    break;
                }
                nonce += 1;
            }
            en2val += nthreads as u64;
        }
    }
}

fn shorten(s: &str) -> String {
    if s.len() > 24 { format!("{}…{}", &s[..12], &s[s.len() - 8..]) } else { s.to_string() }
}

fn human_hps(h: f64) -> String {
    if h >= 1e9 { format!("{:.2} GH/s", h / 1e9) }
    else if h >= 1e6 { format!("{:.2} MH/s", h / 1e6) }
    else if h >= 1e3 { format!("{:.2} kH/s", h / 1e3) }
    else { format!("{:.0} H/s", h) }
}
