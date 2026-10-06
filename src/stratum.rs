//! The chain-agnostic stratum v1 engine: sessions, job broadcasting,
//! per-miner vardiff, share validation (PoW via the adapter, targets here),
//! and the share/block ledger.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::adapter::{BlockResult, Job, PoolAdapter, ShareOutcome, ShareSubmit};
use crate::btc;
use crate::ledger::{Ledger, Scheme};

const TARGET_SHARE_SECS: u64 = 10;
const RETARGET_SECS: u64 = 30;
const JOB_POLL_MS: u64 = 2000;
/// Disconnect a miner after this many consecutive invalid shares.
const BAN_AFTER_REJECTS: u32 = 20;

struct Session {
    sender: Sender<String>,
    extranonce1: [u8; 4],
    /// Resolved payout key: the miner's address in this chain (password
    /// if supplied there, else the username's address part). Ledger
    /// balances accrue here so all of an address's rigs aggregate.
    worker: Option<String>,
    /// Full stratum username, for display/logs.
    label: Option<String>,
    /// Share difficulty = 2^diff_k (negative = fractional difficulty).
    diff_k: i32,
    window_start: Instant,
    window_shares: u32,
    consecutive_rejects: u32,
}

pub struct Engine {
    adapter: Mutex<Box<dyn PoolAdapter>>,
    pub chain_name: String,
    extranonce2_size: usize,
    sessions: Mutex<HashMap<u64, Session>>,
    jobs: Mutex<HashMap<String, Job>>,
    current_job: Mutex<Option<Job>>,
    pub ledger: Mutex<Ledger>,
    next_session: AtomicU64,
    pub stratum_listen: String,
    /// Parent-chain PoW algorithm (e.g. "sha256d", "x11"). Empty for the
    /// native BLOCK equihash pools, which the site groups as equihash.
    pub algorithm: String,
}

impl Engine {
    pub fn new(
        adapter: Box<dyn PoolAdapter>,
        stratum_listen: &str,
        scheme: Scheme,
        fee_percent: f64,
        algorithm: &str,
    ) -> Arc<Self> {
        let chain_name = adapter.chain_name();
        let extranonce2_size = adapter.extranonce2_size();
        Arc::new(Engine {
            adapter: Mutex::new(adapter),
            chain_name,
            extranonce2_size,
            sessions: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            current_job: Mutex::new(None),
            ledger: Mutex::new(Ledger::new(scheme, fee_percent)),
            next_session: AtomicU64::new(1),
            stratum_listen: stratum_listen.to_string(),
            algorithm: algorithm.to_string(),
        })
    }

    /// Start the stratum listener and the template poll loop (non-blocking).
    pub fn start(self: &Arc<Self>) -> Result<()> {
        let listener = TcpListener::bind(&self.stratum_listen)
            .map_err(|e| anyhow!("stratum cannot listen on {}: {e}", self.stratum_listen))?;
        println!(
            "[pool] stratum+tcp://{}  (chain: {})",
            self.stratum_listen, self.chain_name
        );
        {
            let engine = self.clone();
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let engine = engine.clone();
                    thread::spawn(move || engine.handle_miner(stream));
                }
            });
        }
        {
            let engine = self.clone();
            thread::spawn(move || loop {
                engine.poll_once(false);
                thread::sleep(Duration::from_millis(JOB_POLL_MS));
            });
        }
        Ok(())
    }

    fn poll_once(&self, refresh: bool) {
        let result = self.adapter.lock().unwrap().poll_job(refresh);
        match result {
            Ok(Some(job)) => {
                println!(
                    "[pool] new job {} (height {}{})",
                    job.id,
                    job.height,
                    if job.clean { ", clean" } else { "" }
                );
                self.jobs.lock().unwrap().insert(job.id.clone(), job.clone());
                let mut jobs = self.jobs.lock().unwrap();
                if jobs.len() > 32 {
                    let keep: Vec<String> = {
                        let mut ids: Vec<u64> = jobs
                            .keys()
                            .filter_map(|k| u64::from_str_radix(k, 16).ok())
                            .collect();
                        ids.sort_unstable();
                        ids.iter().rev().take(32).map(|i| format!("{i:x}")).collect()
                    };
                    jobs.retain(|k, _| keep.contains(k));
                }
                drop(jobs);
                *self.current_job.lock().unwrap() = Some(job.clone());
                self.broadcast_job(&job);
            }
            Ok(None) => {}
            Err(e) => println!("[pool] template poll failed: {e}"),
        }
    }

    fn notify_msg(job: &Job) -> String {
        let mut params = vec![json!(job.id)];
        params.extend(job.notify_tail.clone());
        params.push(json!(job.clean));
        json!({"id": null, "method": "mining.notify", "params": params}).to_string()
    }

    fn diff_msg(diff_k: i32) -> String {
        json!({"id": null, "method": "mining.set_difficulty", "params": [2f64.powi(diff_k)]})
            .to_string()
    }

    /// Starting share difficulty for a new miner: just below the chain's
    /// network difficulty (so test chains and CPU miners get instant shares)
    /// but never above 2^12 to start.
    fn initial_diff_k(&self) -> i32 {
        let Some(job) = self.current_job.lock().unwrap().clone() else { return 0 };
        let net = btc::network_difficulty(&job.block_target);
        (net.log2().floor() as i32).clamp(-40, 12)
    }

    fn broadcast_job(&self, job: &Job) {
        let sessions = self.sessions.lock().unwrap();
        let msg = Self::notify_msg(job);
        for s in sessions.values() {
            let _ = s.sender.send(msg.clone());
        }
    }

    fn handle_miner(self: Arc<Self>, stream: TcpStream) {
        let peer = stream
            .peer_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| "?".into());
        let sid = self.next_session.fetch_add(1, Ordering::SeqCst);
        let mut extranonce1 = [0u8; 4];
        extranonce1.copy_from_slice(&(sid as u32).to_be_bytes());

        let mut write_half = match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        };
        let (tx, rx) = channel::<String>();
        self.sessions.lock().unwrap().insert(
            sid,
            Session {
                sender: tx,
                extranonce1,
                worker: None,
                label: None,
                diff_k: 0,
                window_start: Instant::now(),
                window_shares: 0,
                consecutive_rejects: 0,
            },
        );
        println!("[pool] miner {sid} connected ({peer})");

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
            let params = req.get("params").cloned().unwrap_or(json!([]));
            let reply = self.dispatch(sid, method, &params);
            let sessions = self.sessions.lock().unwrap();
            if let Some(s) = sessions.get(&sid) {
                let msg = match reply {
                    Ok(result) => json!({"id": id, "result": result, "error": null}),
                    Err(e) => json!({"id": id, "result": null, "error": [20, e, null]}),
                };
                let _ = s.sender.send(msg.to_string());
            }
        }

        self.sessions.lock().unwrap().remove(&sid);
        println!("[pool] miner {sid} disconnected ({peer})");
        let _ = writer.join();
    }

    fn dispatch(&self, sid: u64, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "mining.subscribe" => {
                let start_k = self.initial_diff_k();
                let (en1, diff_k) = {
                    let mut sessions = self.sessions.lock().unwrap();
                    let s = sessions.get_mut(&sid).ok_or("gone")?;
                    s.diff_k = start_k;
                    (s.extranonce1, s.diff_k)
                };
                // Push difficulty + current job right after the response.
                let sessions = self.sessions.lock().unwrap();
                if let Some(s) = sessions.get(&sid) {
                    let _ = s.sender.send(Self::diff_msg(diff_k));
                    if let Some(job) = self.current_job.lock().unwrap().as_ref() {
                        let _ = s.sender.send(Self::notify_msg(job));
                    }
                }
                Ok(json!([
                    [["mining.set_difficulty", "1"], ["mining.notify", "1"]],
                    hex::encode(en1),
                    self.extranonce2_size,
                ]))
            }
            "mining.authorize" => {
                // Convention: username is the miner's payout address in
                // THIS chain (optionally address.rigname). A payout address
                // may instead be supplied in the password field (for mining
                // software / rentals that fix the username).
                let username = params
                    .get(0)
                    .and_then(|v| v.as_str())
                    .unwrap_or("anonymous")
                    .to_string();
                let password = params.get(1).and_then(|v| v.as_str()).unwrap_or("");
                let payout = if !password.is_empty()
                    && password != "x"
                    && password.len() > 8
                {
                    password.to_string()
                } else {
                    username.split('.').next().unwrap_or(&username).to_string()
                };
                println!("[pool] authorize: payout={payout} (user={username:?})");
                if let Some(s) = self.sessions.lock().unwrap().get_mut(&sid) {
                    s.worker = Some(payout);
                    s.label = Some(username);
                }
                Ok(json!(true))
            }
            "mining.extranonce.subscribe" => Ok(json!(true)),
            "mining.submit" => self.handle_submit(sid, params),
            other => Err(format!("unknown method {other}")),
        }
    }

    fn handle_submit(&self, sid: u64, params: &Value) -> Result<Value, String> {
        let p = params.as_array().ok_or("bad params")?;
        if p.len() < 5 {
            return Err("expected [worker, job_id, extranonce2, ntime, nonce]".into());
        }
        let job_id = p[1].as_str().ok_or("bad job id")?;
        let extranonce2 =
            hex::decode(p[2].as_str().ok_or("bad extranonce2")?).map_err(|_| "bad hex")?;
        if extranonce2.len() != self.extranonce2_size {
            return Err(format!("extranonce2 must be {} bytes", self.extranonce2_size));
        }
        let (worker, en1, diff_k) = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions.get(&sid).ok_or("gone")?;
            (
                s.worker.clone().unwrap_or_else(|| "anonymous".into()),
                s.extranonce1,
                s.diff_k,
            )
        };
        let job = self
            .jobs
            .lock()
            .unwrap()
            .get(job_id)
            .cloned()
            .ok_or("unknown or stale job")?;
        let submit = ShareSubmit {
            worker: worker.clone(),
            extranonce1: en1.to_vec(),
            extranonce2,
            ntime_hex: p[3].as_str().ok_or("bad ntime")?.to_string(),
            nonce_hex: p[4].as_str().ok_or("bad nonce")?.to_string(),
        };

        let outcome = self.adapter.lock().unwrap().check_share(&job, &submit);
        let (hash, meets_block, aux_hits) = match outcome {
            ShareOutcome::Rejected(reason) => {
                self.register_reject(sid, &worker);
                return Err(reason);
            }
            ShareOutcome::Valid { hash_le, meets_block, meets_aux } => {
                (hash_le, meets_block, meets_aux)
            }
        };
        // Shares may never be required to be harder than blocks.
        let share_t = btc::share_target(diff_k);
        let effective = if job.block_target > share_t { job.block_target } else { share_t };
        if !btc::hash_meets_target(&hash, &effective) {
            self.register_reject(sid, &worker);
            return Err("low difficulty share".into());
        }

        let net_diff = btc::network_difficulty(&job.block_target);
        let reward = self.adapter.lock().unwrap().block_reward().unwrap_or(0);
        self.ledger.lock().unwrap().accept_share(
            &worker,
            2f64.powi(diff_k),
            net_diff,
            reward,
        );
        if let Some(s) = self.sessions.lock().unwrap().get_mut(&sid) {
            s.consecutive_rejects = 0;
        }
        self.vardiff(sid);

        if meets_block {
            let result = self.adapter.lock().unwrap().submit_block(&job, &submit);
            match result {
                BlockResult::Accepted { hash_display } => {
                    let reward =
                        self.adapter.lock().unwrap().block_reward().unwrap_or(0);
                    println!(
                        "[pool] *** BLOCK FOUND *** {} height {} by {worker}: {hash_display}",
                        self.chain_name, job.height
                    );
                    self.ledger.lock().unwrap().record_block(
                        &self.chain_name,
                        job.height,
                        hash_display,
                        &worker,
                        reward,
                    );
                }
                BlockResult::Rejected(reason) => {
                    println!("[pool] block submit rejected: {reason}");
                }
            }
        }
        // Merged-mining: the same share may solve auxiliary chains.
        if !aux_hits.is_empty() {
            let aux_names = self.adapter.lock().unwrap().aux_names();
            for idx in aux_hits {
                let result = self.adapter.lock().unwrap().submit_aux(&job, &submit, idx);
                let name = aux_names.get(idx).cloned().unwrap_or_else(|| format!("aux{idx}"));
                match result {
                    BlockResult::Accepted { hash_display } => {
                        println!(
                            "[pool] *** AUX BLOCK FOUND *** {name} by {worker}: {hash_display}"
                        );
                        self.ledger.lock().unwrap().record_block(
                            &name,
                            0,
                            hash_display,
                            &worker,
                            0,
                        );
                    }
                    BlockResult::Rejected(reason) => {
                        println!("[pool] aux submit to {name} rejected: {reason}");
                    }
                }
            }
        }
        if meets_block {
            self.poll_once(true);
        }
        Ok(json!(true))
    }

    fn register_reject(&self, sid: u64, worker: &str) {
        self.ledger.lock().unwrap().reject_share(worker);
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.get_mut(&sid) {
            s.consecutive_rejects += 1;
            if s.consecutive_rejects >= BAN_AFTER_REJECTS {
                println!("[pool] miner {sid} banned after {BAN_AFTER_REJECTS} consecutive invalid shares");
                // Dropping the session closes the writer channel → the
                // connection shuts down.
                sessions.remove(&sid);
            }
        }
    }

    fn vardiff(&self, sid: u64) {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(s) = sessions.get_mut(&sid) else { return };
        s.window_shares += 1;
        let elapsed = s.window_start.elapsed().as_secs();
        if elapsed < RETARGET_SECS {
            return;
        }
        let expected = (elapsed / TARGET_SHARE_SECS).max(1) as u32;
        let old = s.diff_k;
        if s.window_shares > expected * 2 {
            s.diff_k += 1;
        } else if s.window_shares * 2 < expected && s.diff_k > -40 {
            s.diff_k -= 1;
        }
        s.window_start = Instant::now();
        s.window_shares = 0;
        if s.diff_k != old {
            println!("[pool] miner {sid} vardiff → {}", 2f64.powi(s.diff_k));
            let _ = s.sender.send(Self::diff_msg(s.diff_k));
        }
    }

    /// Current chain height as seen by the newest job.
    pub fn current_height(&self) -> Option<u64> {
        self.current_job.lock().unwrap().as_ref().map(|j| j.height)
    }

    /// Network difficulty implied by the current job's block target.
    pub fn network_difficulty(&self) -> f64 {
        self.current_job
            .lock()
            .unwrap()
            .as_ref()
            .map(|j| btc::network_difficulty(&j.block_target))
            .unwrap_or(0.0)
    }

    /// Snapshot for blockle.biz heartbeats:
    /// (hashrate, miners, workers, shares, blocks `(chain, height, hash)`).
    pub fn heartbeat_snapshot(&self) -> (f64, u64, u64, u64, Vec<(String, u64, String)>) {
        let ledger = self.ledger.lock().unwrap();
        let shares: u64 = ledger.workers.values().map(|w| w.accepted).sum();
        let blocks = ledger
            .blocks
            .iter()
            .rev()
            .take(50)
            .map(|b| (b.chain.clone(), b.height, b.hash.clone()))
            .collect();
        (
            ledger.hashrate(),
            self.session_count() as u64,
            ledger.workers.len() as u64,
            shares,
            blocks,
        )
    }

    pub fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}
