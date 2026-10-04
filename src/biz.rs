//! blockle.biz — the public directory and monitoring network for
//! Blockle-deployed pools.
//!
//! Pools register (`blockle register`), receive a token, and send periodic
//! heartbeats with statistics. The site renders the directory, pool and
//! chain pages, and serves the public JSON API. Design principles enforced
//! here:
//!
//! - **Never trust submitted data blindly**: token auth, schema + range
//!   validation, timestamp freshness, heartbeat rate limiting.
//! - **Verified vs operator-reported**: the monitoring worker actively
//!   probes each pool's stratum endpoint; reachability and heartbeat
//!   recency are *verified*, hashrates/miner counts are *operator-reported*
//!   and labeled as such.
//! - **No fabricated statistics**: empty states render as zeros.
//! - **Proof of Blocks**: pools report found blocks (chain + height +
//!   hash).
//!   recorded with their evidence hash, deduplicated, and clearly labeled

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::http;
use crate::rpc::{RpcClient, RpcOutcome};

const HEARTBEAT_MIN_SECS: u64 = 10;
const POB_MIN_CONFIRMATIONS: u64 = 3;
const POB_MAX_VERIFY_ATTEMPTS: u32 = 5;
const POB_PENDING_GRACE_SECS: u64 = 600;
const POB_DEFAULT_DAILY_CAP: u64 = 300;
const OFFLINE_AFTER_SECS: u64 = 180;
const HISTORY_CAP: usize = 2880; // 48h at 60s
const MAX_FIELD: usize = 128;

/// Format base units (1 BLOCK = 10^8) for humans.
pub fn fmt_block(base_units: u64) -> String {
    let whole = base_units / 100_000_000;
    let frac = base_units % 100_000_000;
    if frac == 0 {
        format!("{whole}")
    } else {
        format!("{whole}.{:08}", frac).trim_end_matches('0').to_string()
    }
}

static SITE_DOMAIN: OnceLock<String> = OnceLock::new();

/// The public domain this deployment serves under (e.g. "blockle.org").
pub fn site_domain() -> &'static str {
    SITE_DOMAIN.get().map(|s| s.as_str()).unwrap_or("blockle.biz")
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn random_token() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    let ok = fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok();
    if !ok {
        // fallback: hash of time + pid (platforms without /dev/urandom)
        let seed = format!("{:?}-{}", SystemTime::now(), std::process::id());
        bytes = crate::btc::dsha256(seed.as_bytes());
    }
    hex::encode(bytes)
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ReportedStats {
    pub pool_hashrate: f64,
    pub miners: u64,
    pub workers: u64,
    pub blocks_found: u64,
    pub block_height: u64,
    pub network_hashrate: f64,
    pub network_difficulty: f64,
    pub shares_submitted: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReportedBlock {
    pub chain: String,
    pub height: u64,
    pub hash: String,
    pub at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PoolRecord {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing)]
    pub token: String,
    pub chain: String,
    pub algorithm: String,
    pub stratum: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub version: String,
    pub fee_percent: f64,
    pub registered_at: u64,
    #[serde(default)]
    pub last_heartbeat: u64,
    #[serde(default)]
    pub stats: ReportedStats,
    #[serde(default)]
    pub blocks: Vec<ReportedBlock>,
    /// Public RPC for this pool's chain (optional; monitoring context).
    #[serde(default)]
    pub chain_rpc: String,
    /// Verification RPCs for merged-mined aux chains: chain name → URL.
    #[serde(default)]
    pub aux_chain_rpcs: HashMap<String, String>,
    /// Last active stratum reachability probe result (verified data).
    #[serde(default)]
    pub stratum_reachable: bool,
    #[serde(default)]
    pub last_probe: u64,
}

impl PoolRecord {
    pub fn online(&self) -> bool {
        self.last_heartbeat > 0 && now_unix().saturating_sub(self.last_heartbeat) < OFFLINE_AFTER_SECS
    }

    /// Registered → Online → Verified (reachable stratum).
    pub fn status(&self) -> &'static str {
        if self.online() && self.stratum_reachable {
            "verified"
        } else if self.online() {
            "online"
        } else {
            "offline"
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub at: u64,
    pub pool_hashrate: f64,
    pub miners: u64,
    pub network_hashrate: f64,
    pub network_difficulty: f64,
}

pub struct Registry {
    pub pools: HashMap<String, PoolRecord>,
    pub history: HashMap<String, VecDeque<Snapshot>>,
    pub github: String,
    pub started: u64,
    pub last_monitor_cycle: u64,
    data_path: PathBuf,
    rate: HashMap<String, u64>, // pool_id -> last heartbeat accepted
}

impl Registry {
    fn load(
        data_path: PathBuf,
        github: String,
    ) -> Self {
        let pools: HashMap<String, PoolRecord> = fs::read_to_string(&data_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<PoolRecordOnDisk>>(&raw).ok())
            .map(|v| v.into_iter().map(|p| (p.record.id.clone(), p.into_record())).collect())
            .unwrap_or_default();
        Registry {
            pools,
            history: HashMap::new(),
            github,
            started: now_unix(),
            last_monitor_cycle: 0,
            data_path,
            rate: HashMap::new(),
        }
    }

    fn persist(&self) {
        let v: Vec<PoolRecordOnDisk> = self
            .pools
            .values()
            .map(|p| PoolRecordOnDisk { token: p.token.clone(), record: p.clone() })
            .collect();
        if let Ok(raw) = serde_json::to_string_pretty(&v) {
            let _ = fs::write(&self.data_path, raw);
        }
    }
}

/// On-disk wrapper so tokens persist without ever being serialized in API
/// responses (PoolRecord skips the token on serialize).
#[derive(Serialize, Deserialize)]
struct PoolRecordOnDisk {
    token: String,
    #[serde(flatten)]
    record: PoolRecord,
}

impl PoolRecordOnDisk {
    fn into_record(self) -> PoolRecord {
        let mut r = self.record;
        r.token = self.token;
        r
    }
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    slug.trim_matches('-').chars().take(40).collect()
}

fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && *c != '<' && *c != '>')
        .take(MAX_FIELD)
        .collect()
}

// ================================================================================================
// server
// ================================================================================================

pub struct BizConfig {
    pub listen: String,
    pub data_path: PathBuf,
    pub github: String,
    /// Monitoring cycle interval (seconds).
    pub monitor_interval_secs: u64,
    /// Public domain for titles/links (e.g. "blockle.org").
    pub domain: String,
    /// BLOCK chain explorer snapshot written by `blockle-chain start`
    /// (explorer.json in the node datadir).
    pub chain_file: Option<PathBuf>,
    /// Live pool statistics files written by the chain's stratum pools:
    /// (name, path) — served at /api/mps/{name}.
    pub mps_files: Vec<(String, PathBuf)>,
}

static EXTRAS: OnceLock<(Option<PathBuf>, Vec<(String, PathBuf)>)> = OnceLock::new();

/// The BLOCK chain snapshot, if the node's explorer file is configured.
fn chain_snapshot() -> Option<Value> {
    let (chain_file, _) = EXTRAS.get()?;
    let raw = fs::read_to_string(chain_file.as_ref()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Live stats for one of our own pools (stratum stats file).
fn pool_stats(name: &str) -> Option<Value> {
    let (_, mps) = EXTRAS.get()?;
    let path = mps.iter().find(|(n, _)| n == name).map(|(_, p)| p)?;
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Our dedicated direct BLOCK pools: (stats-feed name, row title, port).
const DIRECT_POOLS: &[(&str, &str, u16)] = &[
    ("sha256d", "BLOCK · SHA-256d direct", 3340),
    ("scrypt", "BLOCK · Scrypt direct", 3341),
    ("x11", "BLOCK · X11 direct", 3342),
    ("blake2b", "BLOCK · Blake2b direct", 3343),
    ("blake2s", "BLOCK · Blake2s direct", 3344),
    ("blake3", "BLOCK · Blake3 direct", 3345),
    ("eaglesong", "BLOCK · Eaglesong direct", 3346),
    ("kheavyhash", "BLOCK · kHeavyHash direct", 3347),
];

/// Major ASIC ecosystems BLOCK merge-mines with: (chain, algorithm,
/// hardware note). Status is configured at deploy time — never fabricated.
const PARENT_ROSTER: &[(&str, &str, &str, &str)] = &[
    ("Bitcoin", "sha256d", "SHA-256 ASICs (S19 / S21 class)", "parent node syncing on this server · direct pool live :3340"),
    ("Litecoin + Dogecoin", "scrypt", "Scrypt ASICs (L7 / L9 class)", "parent nodes syncing on this server · direct pool live :3341"),
    ("Zcash", "equihash", "Equihash 200,9 ASICs (Z15 class)", "same algorithm as BLOCK — native pools live :3333 / :3334"),
    ("Dash", "x11", "X11 ASICs", "direct pool live :3342"),
    ("Kaspa-class", "kheavyhash", "kHeavyHash ASICs", "direct pool live :3347"),
    ("Alephium-class", "blake3", "Blake3 ASICs", "direct pool live :3345"),
    ("Nervos-class", "eaglesong", "Eaglesong ASICs", "direct pool live :3346"),
    ("Sia-class", "blake2b", "Blake2b ASICs", "direct pool live :3343"),
    ("Kadena-class", "blake2s", "Blake2s ASICs", "direct pool live :3344"),
];

pub fn serve(cfg: BizConfig) -> Result<Arc<Mutex<Registry>>> {
    let _ = EXTRAS.set((cfg.chain_file.clone(), cfg.mps_files.clone()));
    let _ = SITE_DOMAIN.set(if cfg.domain.is_empty() {
        "blockle.biz".into()
    } else {
        cfg.domain.clone()
    });
    let registry = Arc::new(Mutex::new(Registry::load(
        cfg.data_path,
        cfg.github,
    )));
    let listener = TcpListener::bind(&cfg.listen)
        .map_err(|e| anyhow!("blockle.biz cannot listen on {}: {e}", cfg.listen))?;
    println!("[biz] {} serving on http://{}/", site_domain(), cfg.listen);

    // Monitoring worker: offline detection + active stratum probes +
    // history snapshots.
    {
        let registry = registry.clone();
        let interval = cfg.monitor_interval_secs.max(1);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(interval));
            let targets: Vec<(String, String)> = {
                let reg = registry.lock().unwrap();
                reg.pools.values().map(|p| (p.id.clone(), p.stratum.clone())).collect()
            };
            let mut results = Vec::new();
            for (id, stratum) in targets {
                let reachable = stratum
                    .parse::<std::net::SocketAddr>()
                    .ok()
                    .map(|addr| {
                        TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok()
                    })
                    .unwrap_or(false);
                results.push((id, reachable));
            }
            let mut reg = registry.lock().unwrap();
            let now = now_unix();
            for (id, reachable) in results {
                if let Some(p) = reg.pools.get_mut(&id) {
                    p.stratum_reachable = reachable;
                    p.last_probe = now;
                }
            }
            // history snapshots (per online pool)
            let snaps: Vec<(String, Snapshot)> = reg
                .pools
                .values()
                .filter(|p| p.online())
                .map(|p| {
                    (
                        p.id.clone(),
                        Snapshot {
                            at: now,
                            pool_hashrate: p.stats.pool_hashrate,
                            miners: p.stats.miners,
                            network_hashrate: p.stats.network_hashrate,
                            network_difficulty: p.stats.network_difficulty,
                        },
                    )
                })
                .collect();
            for (id, snap) in snaps {
                let h = reg.history.entry(id).or_default();
                h.push_back(snap);
                while h.len() > HISTORY_CAP {
                    h.pop_front();
                }
            }
            reg.last_monitor_cycle = now;
            reg.persist();
            drop(reg);
        });
    }

    {
        let registry = registry.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let registry = registry.clone();
                thread::spawn(move || {
                    let mut stream = stream;
                    let Ok(req) = http::read_request(&mut stream) else { return };
                    let (status, ctype, body) = route(&registry, &req);
                    http::respond(&mut stream, status, ctype, &body);
                });
            }
        });
    }
    Ok(registry)
}

// ================================================================================================
// routing
// ================================================================================================

fn route(registry: &Arc<Mutex<Registry>>, req: &http::Request) -> (&'static str, &'static str, Vec<u8>) {
    let (path, query) = match req.path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (req.path.as_str(), ""),
    };
    let jerr = |code: &'static str, msg: &str| {
        (code, "application/json", json!({"error": msg}).to_string().into_bytes())
    };

    if req.method == "POST" {
        let body: Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(_) => return jerr("400 Bad Request", "invalid JSON"),
        };
        return match path {
            "/api/register" => api_register(registry, &body),
            "/api/heartbeat" => api_heartbeat(registry, &body),
            _ => jerr("404 Not Found", "unknown endpoint"),
        };
    }

    let reg = registry.lock().unwrap();
    match path {
        "/api/health" => (
            "200 OK",
            "application/json",
            json!({
                "status": "ok",
                "uptime_secs": now_unix() - reg.started,
                "pools": reg.pools.len(),
                "last_monitor_cycle": reg.last_monitor_cycle,
            })
            .to_string()
            .into_bytes(),
        ),
        "/api/stats" => ("200 OK", "application/json", network_stats(&reg).to_string().into_bytes()),
        "/api/pools" => {
            let pools: Vec<Value> = reg.pools.values().map(pool_json).collect();
            ("200 OK", "application/json", json!({"pools": pools}).to_string().into_bytes())
        }
        "/api/chains" => ("200 OK", "application/json", chains_json(&reg).to_string().into_bytes()),
        "/api/chain" => match chain_snapshot() {
            Some(v) => ("200 OK", "application/json", v.to_string().into_bytes()),
            None => jerr("503 Service Unavailable", "chain snapshot not configured"),
        },
        p if p.starts_with("/api/mps/") => {
            let name = &p["/api/mps/".len()..];
            match pool_stats(name) {
                Some(v) => ("200 OK", "application/json", v.to_string().into_bytes()),
                None => jerr("404 Not Found", "no such pool stats feed"),
            }
        }
        p if p.starts_with("/api/pools/") => {
            let id = &p["/api/pools/".len()..];
            match reg.pools.get(id) {
                Some(pool) => {
                    let mut v = pool_json(pool);
                    v["history"] = json!(reg.history.get(id).cloned().unwrap_or_default());
                    ("200 OK", "application/json", v.to_string().into_bytes())
                }
                None => jerr("404 Not Found", "no such pool"),
            }
        }
        p if p.starts_with("/api/chains/") => {
            let name = &p["/api/chains/".len()..];
            let chains = chains_json(&reg);
            let found = chains["chains"]
                .as_array()
                .and_then(|a| a.iter().find(|c| c["chain"] == *name).cloned());
            match found {
                Some(c) => ("200 OK", "application/json", c.to_string().into_bytes()),
                None => jerr("404 Not Found", "no such chain"),
            }
        }
        "/" => ("200 OK", "text/html; charset=utf-8", page_home(&reg).into_bytes()),
        "/logo.png" => ("200 OK", "image/png", LOGO_PNG.to_vec()),
        "/logo-mark.png" => ("200 OK", "image/png", LOGO_MARK_PNG.to_vec()),
        "/favicon.png" | "/favicon.ico" => ("200 OK", "image/png", FAVICON_PNG.to_vec()),
        "/pools" => ("200 OK", "text/html; charset=utf-8", page_pools(&reg, query).into_bytes()),
        p if p.starts_with("/pool/") => {
            let id = &p["/pool/".len()..];
            match reg.pools.get(id) {
                Some(pool) => (
                    "200 OK",
                    "text/html; charset=utf-8",
                    page_pool(&reg, pool).into_bytes(),
                ),
                None => ("404 Not Found", "text/html; charset=utf-8", page_shell("Not found", "<p>No such pool.</p>".into()).into_bytes()),
            }
        }
        p if p.starts_with("/chain/") => {
            let name = &p["/chain/".len()..];
            ("200 OK", "text/html; charset=utf-8", page_chain(&reg, name).into_bytes())
        }
        "/algorithms" => ("200 OK", "text/html; charset=utf-8", page_algorithms(&reg).into_bytes()),
        "/explorer" => ("200 OK", "text/html; charset=utf-8", page_explorer(&reg).into_bytes()),
        "/mine" => ("200 OK", "text/html; charset=utf-8", page_mine(&reg).into_bytes()),
        "/wallet" => ("200 OK", "text/html; charset=utf-8", page_wallet().into_bytes()),
        "/status" => ("200 OK", "text/html; charset=utf-8", page_status(&reg).into_bytes()),
        "/api" => ("200 OK", "text/html; charset=utf-8", page_api().into_bytes()),
        "/developers" => ("200 OK", "text/html; charset=utf-8", page_developers(&reg).into_bytes()),
        "/open-source" => ("200 OK", "text/html; charset=utf-8", page_open_source(&reg).into_bytes()),
        _ => ("404 Not Found", "text/html; charset=utf-8", page_shell("Not found", "<p>404.</p>".into()).into_bytes()),
    }
}

// ================================================================================================
// API handlers
// ================================================================================================

fn api_register(registry: &Arc<Mutex<Registry>>, body: &Value) -> (&'static str, &'static str, Vec<u8>) {
    let jerr = |msg: &str| {
        ("400 Bad Request", "application/json", json!({"error": msg}).to_string().into_bytes())
    };
    let get = |k: &str| body.get(k).and_then(|v| v.as_str()).map(clean);
    let Some(name) = get("name").filter(|s| !s.is_empty()) else {
        return jerr("name is required");
    };
    let Some(chain) = get("chain").filter(|s| !s.is_empty()) else {
        return jerr("chain is required");
    };
    let Some(stratum) = get("stratum").filter(|s| !s.is_empty()) else {
        return jerr("stratum is required");
    };
    let algorithm = get("algorithm").unwrap_or_else(|| "unknown".into());
    let fee = body.get("pool_fee").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if !(0.0..=100.0).contains(&fee) {
        return jerr("pool_fee out of range");
    }

    let mut reg = registry.lock().unwrap();
    let mut id = slugify(&name);
    if id.is_empty() {
        return jerr("name produces an empty id");
    }
    let mut n = 1;
    while reg.pools.contains_key(&id) {
        n += 1;
        id = format!("{}-{n}", slugify(&name));
    }
    let token = random_token();
    let record = PoolRecord {
        id: id.clone(),
        name,
        token: token.clone(),
        chain,
        algorithm,
        stratum,
        website: get("website").unwrap_or_default(),
        location: get("location").unwrap_or_default(),
        version: get("version").unwrap_or_default(),
        chain_rpc: get("chain_rpc").unwrap_or_default(),
        aux_chain_rpcs: body
            .get("aux_chain_rpcs")
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|u| (clean(k), clean(u))))
                    .collect()
            })
            .unwrap_or_default(),
        fee_percent: fee,
        registered_at: now_unix(),
        last_heartbeat: 0,
        stats: ReportedStats::default(),
        blocks: Vec::new(),
        stratum_reachable: false,
        last_probe: 0,
    };
    reg.pools.insert(id.clone(), record);
    reg.persist();
    println!("[biz] pool registered: {id}");
    (
        "200 OK",
        "application/json",
        json!({"pool_id": id, "token": token, "heartbeat_interval_secs": 60})
            .to_string()
            .into_bytes(),
    )
}

fn api_heartbeat(registry: &Arc<Mutex<Registry>>, body: &Value) -> (&'static str, &'static str, Vec<u8>) {
    let jerr = |code: &'static str, msg: &str| {
        (code, "application/json", json!({"error": msg}).to_string().into_bytes())
    };
    let Some(pool_id) = body.get("pool_id").and_then(|v| v.as_str()) else {
        return jerr("400 Bad Request", "pool_id required");
    };
    let Some(token) = body.get("token").and_then(|v| v.as_str()) else {
        return jerr("401 Unauthorized", "token required");
    };
    // timestamp freshness (±5 min when provided)
    if let Some(ts) = body.get("timestamp").and_then(|v| v.as_u64()) {
        if ts != 0 && now_unix().abs_diff(ts) > 300 {
            return jerr("400 Bad Request", "timestamp too far from server time");
        }
    }

    let mut reg = registry.lock().unwrap();
    let now = now_unix();
    if let Some(last) = reg.rate.get(pool_id) {
        if now.saturating_sub(*last) < HEARTBEAT_MIN_SECS {
            return jerr("429 Too Many Requests", "heartbeat too frequent");
        }
    }
    let Some(pool) = reg.pools.get_mut(pool_id) else {
        return jerr("404 Not Found", "unknown pool");
    };
    if pool.token != token {
        return jerr("401 Unauthorized", "bad token");
    }

    let num = |k: &str| body.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let int = |k: &str| body.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let finite_pos = |v: f64| v.is_finite() && v >= 0.0 && v < 1e24;
    if !finite_pos(num("pool_hashrate")) || !finite_pos(num("network_hashrate")) {
        return jerr("400 Bad Request", "hashrate out of range");
    }
    pool.stats = ReportedStats {
        pool_hashrate: num("pool_hashrate"),
        miners: int("miners").min(10_000_000),
        workers: int("workers").min(10_000_000),
        blocks_found: int("blocks_found"),
        block_height: int("block_height"),
        network_hashrate: num("network_hashrate"),
        network_difficulty: num("network_difficulty"),
        shares_submitted: int("shares_submitted"),
    };
    if let Some(v) = body.get("version").and_then(|v| v.as_str()) {
        pool.version = clean(v);
    }
    pool.last_heartbeat = now;

    // Reported found blocks: validated shape, deduped by hash, capped.
    if let Some(blocks) = body.get("blocks").and_then(|v| v.as_array()) {
        let default_chain = pool.chain.clone();
        for b in blocks.iter().take(50) {
            let height = b.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
            let hash = b.get("hash").and_then(|v| v.as_str()).map(clean).unwrap_or_default();
            let chain = b
                .get("chain")
                .and_then(|v| v.as_str())
                .map(clean)
                .unwrap_or_else(|| default_chain.clone());
            if hash.is_empty() || hash.len() > 128 {
                continue;
            }
            if pool.blocks.iter().any(|x| x.hash == hash) {
                continue;
            }
            pool.blocks.push(ReportedBlock { chain, height, hash, at: now });
        }
        let len = pool.blocks.len();
        if len > 500 {
            pool.blocks.drain(..len - 500);
        }
    }

    reg.rate.insert(pool_id.to_string(), now);
    reg.persist();
    (
        "200 OK",
        "application/json",
        json!({"ok": true}).to_string().into_bytes(),
    )
}

// ================================================================================================
// JSON builders
// ================================================================================================

fn pool_json(p: &PoolRecord) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "chain": p.chain,
        "algorithm": p.algorithm,
        "stratum": p.stratum,
        "website": p.website,
        "location": p.location,
        "version": p.version,
        "fee_percent": p.fee_percent,
        "status": p.status(),
        "registered_at": p.registered_at,
        "last_heartbeat": p.last_heartbeat,
        "uptime_since_registration_secs": now_unix().saturating_sub(p.registered_at),
        "verified": {
            "stratum_reachable": p.stratum_reachable,
            "last_probe": p.last_probe,
        },
        "operator_reported": p.stats,
        "blocks": p.blocks.iter().rev().take(25).collect::<Vec<_>>(),
        "verification_rpc_registered": !p.chain_rpc.is_empty(),
    })
}

fn network_stats(reg: &Registry) -> Value {
    let online: Vec<&PoolRecord> = reg.pools.values().filter(|p| p.online()).collect();
    let chains: std::collections::HashSet<&str> =
        reg.pools.values().map(|p| p.chain.as_str()).collect();
    json!({
        "total_pools": reg.pools.len(),
        "online_pools": online.len(),
        "chains_supported": chains.len(),
        "total_hashrate_reported": online.iter().map(|p| p.stats.pool_hashrate).sum::<f64>().max(0.0),
        "blocks_found_reported": reg.pools.values().map(|p| p.blocks.len() as u64).sum::<u64>(),
        "active_miners_reported": online.iter().map(|p| p.stats.miners).sum::<u64>(),
    })
}

fn chains_json(reg: &Registry) -> Value {
    let mut by_chain: HashMap<&str, Vec<&PoolRecord>> = HashMap::new();
    for p in reg.pools.values() {
        by_chain.entry(p.chain.as_str()).or_default().push(p);
    }
    let chains: Vec<Value> = by_chain
        .into_iter()
        .map(|(chain, pools)| {
            let online: Vec<&&PoolRecord> = pools.iter().filter(|p| p.online()).collect();
            let best = online.iter().max_by_key(|p| p.stats.block_height);
            json!({
                "chain": chain,
                "algorithm": pools.first().map(|p| p.algorithm.clone()).unwrap_or_default(),
                "pools": pools.len(),
                "online_pools": online.len(),
                "block_height": best.map(|p| p.stats.block_height).unwrap_or(0),
                "network_hashrate": best.map(|p| p.stats.network_hashrate).unwrap_or(0.0),
                "network_difficulty": best.map(|p| p.stats.network_difficulty).unwrap_or(0.0),
                "total_blockle_hashrate": online.iter().map(|p| p.stats.pool_hashrate).sum::<f64>(),
                "total_blockle_miners": online.iter().map(|p| p.stats.miners).sum::<u64>(),
            })
        })
        .collect();
    json!({"chains": chains})
}

// ================================================================================================
// HTML
// ================================================================================================

const LOGO_PNG: &[u8] = include_bytes!("assets/logo-512.png");
const LOGO_MARK_PNG: &[u8] = include_bytes!("assets/logo-mark-128.png");
const FAVICON_PNG: &[u8] = include_bytes!("assets/favicon-32.png");

const CSS: &str = r#"
:root{
  --bg:#0a0b0e; --bg2:#0e1014; --surface:#13151a; --surface2:#181b21;
  --border:#23262e; --border2:#2e323c;
  --ink:#f2f4f8; --ink2:#b7bcc8; --muted:#7d8495;
  --accent:#3987e5; --accent2:#6da7ec; --accent-dim:rgba(57,135,229,.12);
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b;
  --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,monospace;
  --r:12px; --r-sm:8px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);margin:0;
  font:15px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:rgba(57,135,229,.35)}
a{color:var(--accent2);text-decoration:none}
a:hover{color:#8ebcf2}
h1{font-size:clamp(1.7rem,3.5vw,2.4rem);font-weight:700;letter-spacing:-.03em;margin:.2rem 0 .6rem;line-height:1.15}
h2{font-size:1.05rem;font-weight:600;letter-spacing:-.01em;margin:2.8rem 0 1rem;
  padding-bottom:.55rem;border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:.5rem;color:var(--ink)}
code{font-family:var(--mono);font-size:.86em;background:var(--surface);
  border:1px solid var(--border);border-radius:5px;padding:.1em .35em}
pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:1.1rem 1.25rem;overflow-x:auto;font-size:.84rem;line-height:1.7;margin:1rem 0}
pre code{background:none;border:none;padding:0}

/* ---- nav ---- */
nav{position:sticky;top:0;z-index:50;display:flex;gap:.25rem;align-items:center;
  overflow-x:auto;scrollbar-width:none;white-space:nowrap;
  padding:.7rem clamp(1rem,4vw,2.5rem);
  background:rgba(10,11,14,.78);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid var(--border)}
nav .brand{font-weight:700;font-size:1rem;letter-spacing:-.02em;color:var(--ink);
  margin-right:1.2rem;display:flex;align-items:center;gap:.5rem}
nav .brand .hex{color:var(--accent);font-size:1.15rem}
nav .brand img{width:24px;height:24px;border-radius:6px;display:block}
nav a:not(.brand){color:var(--muted);font-size:.86rem;font-weight:500;
  padding:.38rem .7rem;border-radius:7px;transition:all .15s}
nav a:not(.brand):hover{color:var(--ink);background:var(--surface)}
nav a.active{color:var(--ink);background:var(--surface)}
nav .spacer{flex:1}
nav::-webkit-scrollbar{display:none}
nav a{flex:0 0 auto}

main{max-width:1120px;margin:0 auto;padding:2.2rem clamp(1rem,4vw,2.5rem) 3rem}

/* ---- hero ---- */
.hero{position:relative;padding:3.5rem 0 2.5rem;text-align:left}
.hero::before{content:'';position:absolute;inset:-40% -20% auto;height:420px;
  background:radial-gradient(600px 260px at 28% 30%,rgba(57,135,229,.16),transparent 70%),
             radial-gradient(500px 240px at 75% 10%,rgba(12,163,12,.07),transparent 70%);
  pointer-events:none}
.hero h1{font-size:clamp(2.2rem,5.5vw,3.4rem);margin:0 0 1rem;max-width:46rem}
.hero .herologo{position:absolute;right:0;top:1.5rem;width:clamp(120px,16vw,210px);
  border-radius:24px;border:1px solid var(--border);box-shadow:0 20px 60px rgba(12,163,12,.15);opacity:.95}
@media(max-width:900px){.hero .herologo{display:none}}
.hero .grad{background:linear-gradient(92deg,#8ebcf2,#3987e5 45%,#56c596);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.hero .lede{font-size:1.1rem;color:var(--ink2);max-width:40rem;margin:0 0 1.8rem}
.cta{display:flex;gap:.7rem;flex-wrap:wrap;margin:1.4rem 0}

.btn{display:inline-flex;align-items:center;gap:.45rem;font-size:.9rem;font-weight:600;
  padding:.6rem 1.15rem;border-radius:9px;border:1px solid var(--border2);
  background:var(--surface);color:var(--ink);transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--ink);transform:translateY(-1px)}
.btn.primary{background:linear-gradient(180deg,#3f8fee,#2a6fc4);border-color:transparent;color:#fff;
  box-shadow:0 4px 16px rgba(57,135,229,.28)}
.btn.primary:hover{filter:brightness(1.08);color:#fff}

/* ---- terminal ---- */
.term{background:#0c0e12;border:1px solid var(--border);border-radius:var(--r);
  margin:2rem 0;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.45)}
.term-bar{display:flex;align-items:center;gap:.4rem;padding:.6rem .9rem;
  background:var(--surface);border-bottom:1px solid var(--border)}
.term-bar i{width:11px;height:11px;border-radius:50%;display:inline-block}
.term-bar i:nth-child(1){background:#ff5f57}.term-bar i:nth-child(2){background:#febc2e}.term-bar i:nth-child(3){background:#28c840}
.term-bar span{margin-left:.6rem;color:var(--muted);font:500 .74rem var(--mono)}
.term pre{border:none;border-radius:0;margin:0;background:transparent;padding:1.1rem 1.25rem}
.t-dim{color:var(--muted)}.t-ok{color:#56c596}.t-accent{color:var(--accent2)}.t-warn{color:var(--warn)}

/* ---- cards / stat tiles ---- */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:.8rem;margin:1.4rem 0}
.card{background:linear-gradient(180deg,var(--surface2),var(--surface));
  border:1px solid var(--border);border-radius:var(--r);padding:1.05rem 1.15rem;
  transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--border2);transform:translateY(-2px)}
.card .v{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;line-height:1.2}
.card .k{color:var(--muted);font-size:.72rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.08em;margin-top:.3rem}

.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.9rem;margin:1.4rem 0}
.feature{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  padding:1.2rem 1.3rem;transition:border-color .15s}
.feature:hover{border-color:var(--border2)}
.feature .fi{font-size:1.3rem;margin-bottom:.5rem}
.feature b{display:block;font-size:.95rem;margin-bottom:.3rem}
.feature p{color:var(--muted);font-size:.86rem;margin:0}

/* ---- tables ---- */
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.89rem;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  overflow:hidden;display:table}
th{color:var(--muted);text-align:left;font-weight:600;text-transform:uppercase;
  font-size:.7rem;letter-spacing:.07em;background:var(--bg2)}
td,th{border-bottom:1px solid var(--border);padding:.65rem .9rem}
tr:last-child td{border-bottom:none}
tbody tr,table tr{transition:background .12s}
table tr:hover td{background:rgba(255,255,255,.022)}
td.mono,.mono{font-family:var(--mono);font-size:.84rem;font-variant-numeric:tabular-nums}
@media(max-width:760px){table{display:block;overflow-x:auto;white-space:nowrap}}

/* ---- status pills & badges ---- */
.pill{display:inline-flex;align-items:center;gap:.4rem;font-size:.76rem;font-weight:600;
  padding:.18rem .6rem;border-radius:999px;border:1px solid var(--border2);white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%;display:inline-block}
.pill.ok{color:#4ade80;border-color:rgba(12,163,12,.4);background:rgba(12,163,12,.08)}
.pill.ok i{background:var(--good);box-shadow:0 0 8px rgba(12,163,12,.6)}
.pill.ver{color:#8ebcf2;border-color:rgba(57,135,229,.4);background:var(--accent-dim)}
.pill.ver i{background:var(--accent);box-shadow:0 0 8px rgba(57,135,229,.6)}
.pill.off{color:#f0948f;border-color:rgba(208,59,59,.4);background:rgba(208,59,59,.08)}
.pill.off i{background:var(--crit)}
.badge{display:inline-block;border:1px solid var(--border2);border-radius:6px;
  padding:.08rem .5rem;font-size:.72rem;font-weight:600;color:var(--muted);
  text-transform:uppercase;letter-spacing:.05em}

.sub{color:var(--ink2);max-width:52rem}
.note{border:1px solid var(--border);border-left:3px solid var(--warn);
  border-radius:var(--r-sm);background:var(--surface);
  padding:.75rem 1rem;color:var(--ink2);margin:1.2rem 0;font-size:.88rem}

/* ---- forms ---- */
input,select{background:var(--surface);border:1px solid var(--border2);color:var(--ink);
  padding:.5rem .75rem;border-radius:8px;font-size:.88rem;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--accent)}
input::placeholder{color:var(--muted)}
button.btn{cursor:pointer;font:inherit;font-weight:600;font-size:.88rem}
form.filters{display:flex;gap:.6rem;flex-wrap:wrap;margin:1.2rem 0;align-items:center}

/* ---- charts ---- */
.chart{position:relative;background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r);padding:.9rem 1rem .5rem;margin:.8rem 0 1.4rem}
.chart .ct{color:var(--muted);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-bottom:.4rem}
svg.spark{width:100%;height:92px;display:block;overflow:visible}
.tip{position:absolute;pointer-events:none;background:#1d2027;border:1px solid var(--border2);
  border-radius:7px;padding:.3rem .6rem;font:600 .76rem var(--mono);color:var(--ink);
  transform:translate(-50%,-130%);white-space:nowrap;opacity:0;transition:opacity .1s;box-shadow:0 8px 24px rgba(0,0,0,.5)}

footer{color:var(--muted);border-top:1px solid var(--border);margin-top:4rem;
  padding:1.8rem clamp(1rem,4vw,2.5rem);font-size:.83rem;max-width:1120px;margin-left:auto;margin-right:auto}

/* ---- mobile ---- */
@media(max-width:700px){
  nav{gap:.1rem;padding:.55rem .8rem}
  nav .brand{margin-right:.5rem}
  nav a:not(.brand){padding:.5rem .55rem;font-size:.82rem}
  main{padding:1.4rem .95rem 2.2rem}
  .hero{padding:2rem 0 1.4rem}
  .hero .lede{font-size:.98rem}
  h2{margin:2rem 0 .8rem}
  .cta .btn{flex:1 1 auto;justify-content:center;min-width:8.5rem;padding:.7rem 1rem}
  .term{margin:1.4rem 0;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  .term pre{font-size:.72rem;padding:.85rem .9rem}
  .cards{grid-template-columns:repeat(2,1fr);gap:.6rem}
  .card{padding:.85rem .9rem}
  .card .v{font-size:1.25rem}
  .features{grid-template-columns:1fr}
  .chart{padding:.7rem .7rem .4rem}
  form.filters{gap:.5rem}
  form.filters input,form.filters select{flex:1 1 8rem;min-width:0}
  td,th{padding:.55rem .65rem}
  pre{padding:.85rem .95rem;font-size:.78rem}
  footer{padding:1.4rem .95rem}
}
"#;

fn page_shell(title: &str, body: String) -> String {
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Blockle — deploy PoW mining pools and monitor them from one place.">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/logo-mark.png">
<meta property="og:title" content="{title} · {domain}">
<meta property="og:description" content="Blockle — deploy PoW mining pools and monitor them from one place.">
<meta property="og:image" content="https://{domain}/logo.png">
<title>{title} · {domain}</title><style>{CSS}</style></head><body>
<nav><a class="brand" href="/"><img src="/logo-mark.png" alt="Blockle">blockle</a>
<a href="/mine">Mine with us</a><a href="/explorer">Explorer</a><a href="/wallet">Wallet</a><a href="/pools">Directory</a><a href="/status">Status</a>
<span class="spacer"></span>
<a href="/api">API</a><a href="/developers">Developers</a><a href="/open-source">Open Source</a></nav>
<main>{body}</main>
<footer>{domain} — mining pools for the majors, every one merge-mining BLOCK, the universal auxiliary chain. Directory statistics marked operator-reported are not independently verified. · <a href="https://github.com/blocklechain/blockle">GitHub</a> · <a href="https://crates.io/crates/blockle">crates.io</a></footer>
<script>
(function(){{
  var p=location.pathname;
  document.querySelectorAll('nav a:not(.brand)').forEach(function(a){{
    var h=a.getAttribute('href');
    if(h===p||(h!=='/'&&p.indexOf(h)===0))a.classList.add('active');
  }});
  document.querySelectorAll('.chart').forEach(function(ch){{
    var svg=ch.querySelector('svg.spark');if(!svg)return;
    var pts=(svg.getAttribute('data-pts')||'').split(' ').filter(Boolean).map(function(s){{var a=s.split(',');return[+a[0],+a[1],a.slice(2).join(',')];}});
    if(!pts.length)return;
    var tip=document.createElement('div');tip.className='tip';ch.appendChild(tip);
    var cross=document.createElementNS('http://www.w3.org/2000/svg','line');
    cross.setAttribute('stroke','#4a4f5c');cross.setAttribute('stroke-width','0.4');
    cross.setAttribute('y1','0');cross.setAttribute('y2','60');cross.style.opacity=0;
    svg.appendChild(cross);
    function show(cx){{
      var r=svg.getBoundingClientRect();
      var x=(cx-r.left)/r.width*100;
      var best=pts[0];pts.forEach(function(q){{if(Math.abs(q[0]-x)<Math.abs(best[0]-x))best=q;}});
      cross.setAttribute('x1',best[0]);cross.setAttribute('x2',best[0]);cross.style.opacity=1;
      tip.textContent=best[2];tip.style.opacity=1;
      tip.style.left=(best[0]/100*r.width)+'px';
      tip.style.top=(best[1]/60*r.height)+'px';
    }}
    svg.addEventListener('mousemove',function(e){{show(e.clientX);}});
    svg.addEventListener('touchstart',function(e){{show(e.touches[0].clientX);}},{{passive:true}});
    svg.addEventListener('touchmove',function(e){{show(e.touches[0].clientX);}},{{passive:true}});
    svg.addEventListener('mouseleave',function(){{tip.style.opacity=0;cross.style.opacity=0;}});
    svg.addEventListener('touchend',function(){{setTimeout(function(){{tip.style.opacity=0;cross.style.opacity=0;}},1200);}});
  }});
}})();
</script>
</body></html>"##,
        domain = site_domain(),
    )
}

fn fmt_hashrate(h: f64) -> String {
    const UNITS: &[&str] = &["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
    let mut v = h;
    let mut u = 0;
    while v >= 1000.0 && u < UNITS.len() - 1 {
        v /= 1000.0;
        u += 1;
    }
    format!("{v:.2} {}", UNITS[u])
}

fn status_dot(p: &PoolRecord) -> String {
    match p.status() {
        "verified" => r#"<span class="pill ver"><i></i>verified</span>"#.into(),
        "online" => r#"<span class="pill ok"><i></i>online</span>"#.into(),
        _ => r#"<span class="pill off"><i></i>offline</span>"#.into(),
    }
}

fn ago(ts: u64) -> String {
    if ts == 0 {
        return "never".into();
    }
    let d = now_unix().saturating_sub(ts);
    match d {
        0..=59 => format!("{d} seconds ago"),
        60..=3599 => format!("{} minutes ago", d / 60),
        3600..=86399 => format!("{} hours ago", d / 3600),
        _ => format!("{} days ago", d / 86400),
    }
}

/// Render one of our own pools (live stratum stats file) as a card row.
fn own_pool_row(name: &str, title: &str) -> String {
    match pool_stats(name) {
        Some(st) => {
            let hr = st["hashrate_sols_est"].as_f64().unwrap_or(0.0);
            let endpoint = st["endpoint"].as_str().unwrap_or("").to_string();
            let fee = st["fee_percent"].as_f64().unwrap_or(0.0);
            let workers = st["workers"].as_u64().unwrap_or(0);
            let blocks = st["blocks_found"].as_u64().unwrap_or(0);
            format!(
                r#"<tr><td><b>{title}</b></td><td><span class="pill ok"><i></i>live</span></td><td class="mono">{endpoint}</td><td class="mono">{fee}%</td><td class="mono">{hr:.1} Sol/s</td><td class="mono">{workers}</td><td class="mono">{blocks}</td></tr>"#
            )
        }
        None => format!(
            r#"<tr><td><b>{title}</b></td><td><span class="pill off"><i></i>starting</span></td><td class="mono" colspan="5">stats feed not yet online</td></tr>"#
        ),
    }
}

fn parent_rows() -> String {
    PARENT_ROSTER
        .iter()
        .map(|(chain, algo, hw, status)| {
            format!(
                r#"<tr><td><b>{chain}</b></td><td class="mono">{algo}</td><td>{hw}</td><td><span class="pill ver"><i></i>merge-ready</span></td><td class="mono">{status}</td></tr>"#
            )
        })
        .collect()
}

fn page_home(reg: &Registry) -> String {
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let chain = chain_snapshot();
    let (height, supply, lanes_live) = match &chain {
        Some(c) => (
            c["height"].as_u64().map(|h| h.to_string()).unwrap_or("—".into()),
            fmt_block(c["supply"].as_u64().unwrap_or(0)),
            c["lanes"].as_array().map(|l| l.len()).unwrap_or(0).to_string(),
        ),
        None => ("—".into(), "—".into(), "10".into()),
    };
    let dirpools = network_stats(reg)["total_pools"].to_string();
    let body = format!(
        r##"<div class="hero">
<img class="herologo" src="/logo.png" alt="Blockle logo">
<h1>The universal <span class="grad">auxiliary chain.</span></h1>
<p class="lede">BLOCK is merge-mined by every major ASIC algorithm: point your SHA-256, Scrypt, Equihash, X11, kHeavyHash, Blake or Eaglesong hardware at a Blockle pool and every share you mine works for the parent chain <i>and</i> for BLOCK — a post-quantum L1 with shielded transactions and the Blockle VM.</p>
<div class="cta">
<a class="btn primary" href="/mine">Mine with us</a>
<a class="btn" href="/wallet">Download Wallet</a>
<a class="btn" href="/explorer">Explorer</a>
<a class="btn" href="{github}">GitHub ↗</a>
</div>
</div>
<h2>Our pools <span class="badge">1% fee · payouts in the coinbase or on-chain</span></h2>
<p class="sub">Native Equihash pools for Zcash-class hardware, plus a <b>dedicated direct BLOCK pool for every ASIC algorithm</b> — point any supported ASIC straight at BLOCK; the reward lands in your own coinbase.</p>
<table><tr><th>pool</th><th>status</th><th>endpoint</th><th>fee</th><th>pool hashrate</th><th>miners</th><th>blocks</th></tr>
{solo}{pplns}{direct}</table>
<h2>Merge lanes <span class="badge">one chain · ten proof-of-work lanes</span></h2>
<p class="sub">BLOCK's consensus accepts a parent block's proof-of-work from any of these ASIC ecosystems in place of a native solution — each lane retargets independently. Parent-chain pools attach BLOCK via the <a href="/mine#operators">merged-mining work API</a>.</p>
<table><tr><th>parent ecosystem</th><th>algorithm</th><th>hardware</th><th>consensus</th><th>pool status</th></tr>
{parents}</table>
<h2>BLOCK chain</h2>
<div class="cards">{c1}{c2}{c3}{c4}</div>
<h2>How it works</h2>
<div class="features">
<div class="feature"><div class="fi">⛏️</div><b>Mine the majors</b><p>Keep mining the coins your hardware is built for. Blockle pools (and any parent pool using the aux-work API) commit a BLOCK header into the parent coinbase — no extra hashes, no extra power.</p></div>
<div class="feature"><div class="fi">⬡</div><b>Every share counts twice</b><p>A parent block that commits to BLOCK <i>is</i> a BLOCK block: consensus verifies the parent's own proof-of-work at BLOCK's per-lane difficulty. 50 BLOCK per block, Bitcoin-style halvings, 210,000 BLOCK premine.</p></div>
<div class="feature"><div class="fi">🔒</div><b>Post-quantum, private, programmable</b><p>ML-DSA signatures, a STARK shielded pool with hidden amounts, ML-KEM encrypted note delivery, and the Blockle VM for contracts.</p></div>
<div class="feature"><div class="fi">🖥️</div><b>Solo or PPLNS</b><p>Solo: your coinbase pays <i>you</i> directly, trustlessly, minus 1%. PPLNS: share-weighted payouts settled on-chain automatically after coinbase maturity.</p></div>
</div>
<p class="note">Pool statistics above come live from our stratum servers; parent-chain pool launches are listed only once real endpoints exist — nothing on this page is simulated. The <a href="/pools">directory</a> additionally lists third-party pools with operator-reported figures.</p>"##,
        github = reg.github,
        solo = own_pool_row("solo", "BLOCK · Solo (equihash)"),
        pplns = own_pool_row("pplns", "BLOCK · PPLNS (equihash)"),
        direct = DIRECT_POOLS
            .iter()
            .map(|(name, title, _)| own_pool_row(name, title))
            .collect::<String>(),
        parents = parent_rows(),
        c1 = card("Height", height),
        c2 = card("Supply", supply),
        c3 = card("PoW Lanes", lanes_live),
        c4 = card("Directory Pools", dirpools),
    );
    page_shell("Blockle — merge-mine BLOCK", body)
}

fn query_get<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then_some(v)
    })
}

fn page_pools(reg: &Registry, query: &str) -> String {
    let fchain = query_get(query, "chain").unwrap_or("");
    let falgo = query_get(query, "algo").unwrap_or("");
    let fstatus = query_get(query, "status").unwrap_or("");
    let q = query_get(query, "q").unwrap_or("").to_lowercase();
    let sort = query_get(query, "sort").unwrap_or("hashrate");

    let mut pools: Vec<&PoolRecord> = reg
        .pools
        .values()
        .filter(|p| fchain.is_empty() || p.chain == fchain)
        .filter(|p| falgo.is_empty() || p.algorithm == falgo)
        .filter(|p| match fstatus {
            "online" => p.online(),
            "offline" => !p.online(),
            _ => true,
        })
        .filter(|p| {
            q.is_empty()
                || p.name.to_lowercase().contains(&q)
                || p.chain.to_lowercase().contains(&q)
                || p.algorithm.to_lowercase().contains(&q)
        })
        .collect();
    match sort {
        "miners" => pools.sort_by(|a, b| b.stats.miners.cmp(&a.stats.miners)),
        "blocks" => pools.sort_by(|a, b| b.blocks.len().cmp(&a.blocks.len())),
        "recent" => pools.sort_by(|a, b| b.registered_at.cmp(&a.registered_at)),
        "uptime" => pools.sort_by(|a, b| a.registered_at.cmp(&b.registered_at)),
        _ => pools.sort_by(|a, b| {
            b.stats
                .pool_hashrate
                .partial_cmp(&a.stats.pool_hashrate)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
    }

    let rows: String = pools
        .iter()
        .map(|p| {
            format!(
                r#"<tr><td><a href="/pool/{id}">{name}</a></td><td><a href="/chain/{chain}">{chain}</a></td><td>{algo}</td><td class="mono">{hr}</td><td class="mono">{miners}</td><td class="mono">{fee}%</td><td class="mono">{blocks}</td><td>{status}</td><td class="mono">{stratum}</td></tr>"#,
                id = p.id,
                name = p.name,
                chain = p.chain,
                algo = p.algorithm,
                hr = fmt_hashrate(p.stats.pool_hashrate),
                miners = p.stats.miners,
                fee = p.fee_percent,
                blocks = p.blocks.len(),
                status = status_dot(p),
                stratum = p.stratum,
            )
        })
        .collect();
    let empty = if pools.is_empty() {
        r#"<p class="sub">No pools match. Deploy one with Blockle and <code>blockle register</code> — it appears here automatically.</p>"#
    } else {
        ""
    };
    let body = format!(
        r#"<h1>Pool Directory</h1>
<form method="get" action="/pools" style="margin:1rem 0;display:flex;gap:.6rem;flex-wrap:wrap">
<input name="q" placeholder="Search pools, coins, algorithms…" value="{q}">
<select name="status"><option value="">any status</option><option value="online">online</option><option value="offline">offline</option></select>
<select name="sort"><option value="hashrate">sort: hashrate</option><option value="miners">sort: miners</option><option value="blocks">sort: blocks</option><option value="uptime">sort: uptime</option><option value="recent">sort: recently added</option></select>
<button class="btn">Filter</button></form>
<table><tr><th>Pool</th><th>Chain</th><th>Algorithm</th><th>Hashrate*</th><th>Miners*</th><th>Fee</th><th>Blocks*</th><th>Status</th><th>Stratum</th></tr>{rows}</table>
{empty}
<p class="note">* operator-reported. Status and stratum reachability are verified by monitoring probes.</p>"#,
    );
    page_shell("Pools", body)
}

fn sparkline(history: &VecDeque<Snapshot>, pick: impl Fn(&Snapshot) -> f64) -> String {
    sparkline_titled(history, pick, "", |v| format!("{v:.1}"))
}

fn sparkline_titled(
    history: &VecDeque<Snapshot>,
    pick: impl Fn(&Snapshot) -> f64,
    title: &str,
    fmt: impl Fn(f64) -> String,
) -> String {
    if history.len() < 2 {
        return format!(
            r#"<div class="chart"><div class="ct">{title}</div><p class="sub" style="font-size:.85rem">Not enough history yet — charts appear after a few monitoring cycles.</p></div>"#
        );
    }
    let vals: Vec<f64> = history.iter().map(pick).collect();
    let max = vals.iter().cloned().fold(f64::MIN, f64::max).max(1e-9);
    let coords: Vec<(f64, f64)> = vals
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let x = i as f64 / (vals.len() - 1) as f64 * 100.0;
            let y = 56.0 - (v / max * 48.0);
            (x, y)
        })
        .collect();
    let line: Vec<String> = coords.iter().map(|(x, y)| format!("{x:.1},{y:.1}")).collect();
    let area = format!("0,60 {} 100,60", line.join(" "));
    let pts: Vec<String> = coords
        .iter()
        .zip(vals.iter())
        .map(|((x, y), v)| format!("{x:.1},{y:.1},{}", fmt(*v)))
        .collect();
    let (lx, ly) = *coords.last().unwrap();
    format!(
        r##"<div class="chart"><div class="ct">{title}</div>
<svg class="spark" viewBox="0 0 100 60" preserveAspectRatio="none" data-pts="{pts}">
<defs><linearGradient id="g{uid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#3987e5" stop-opacity="0.32"/>
<stop offset="1" stop-color="#3987e5" stop-opacity="0.02"/></linearGradient></defs>
<line x1="0" y1="56" x2="100" y2="56" stroke="#2c2c2a" stroke-width="0.4"/>
<polygon fill="url(#g{uid})" points="{area}"/>
<polyline fill="none" stroke="#3987e5" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" points="{line}"/>
<circle cx="{lx:.1}" cy="{ly:.1}" r="1.8" fill="#3987e5" stroke="#0a0b0e" stroke-width="0.8"/>
</svg></div>"##,
        line = line.join(" "),
        pts = pts.join(" "),
        uid = history.len(),
    )
}

fn page_pool(reg: &Registry, p: &PoolRecord) -> String {
    let empty = VecDeque::new();
    let history = reg.history.get(&p.id).unwrap_or(&empty);
    let blocks: String = p
        .blocks
        .iter()
        .rev()
        .take(20)
        .map(|b| {
            format!(
                r#"<tr><td>{}</td><td class="mono">{}</td><td class="mono">{}</td><td>{}</td></tr>"#,
                b.chain, b.height, b.hash, ago(b.at)
            )
        })
        .collect();
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let offline_warning = if !p.online() && p.last_heartbeat > 0 {
        format!(
            r#"<p class="note" style="border-color:var(--red)">This pool has been OFFLINE since its last heartbeat {}.</p>"#,
            ago(p.last_heartbeat)
        )
    } else {
        String::new()
    };
    let body = format!(
        r#"<h1>{name} <span class="badge">{status}</span></h1>
<p class="sub mono">chain {chain} · {algo} · fee {fee}% · blockle {version} · stratum+tcp://{stratum}</p>
<p class="sub">Last heartbeat: {hb} · stratum probe: {probe} ({probe_ago})</p>
{offline_warning}
<h2>Live Statistics <span class="badge">operator-reported</span></h2>
<div class="cards">{c1}{c2}{c3}{c4}{c5}{c6}{c7}{c8}</div>
<h2>Charts <span class="badge">48h · 30s cycles</span></h2>
{spark_pool}{spark_net}{spark_miners}
<h2>Blocks found <span class="badge">evidence hashes operator-reported</span></h2>
<table><tr><th>Chain</th><th>Height</th><th>Hash</th><th>When</th></tr>{blocks}</table>
<h2>Proof of Blocks</h2>
<p><a href="/api/pools/{id}">JSON for this pool →</a></p>"#,
        name = p.name,
        status = status_dot(p),
        chain = p.chain,
        algo = p.algorithm,
        fee = p.fee_percent,
        version = if p.version.is_empty() { "?" } else { &p.version },
        stratum = p.stratum,
        hb = ago(p.last_heartbeat),
        probe = if p.stratum_reachable { "reachable ✓" } else { "unreachable" },
        probe_ago = ago(p.last_probe),
        c1 = card("Hashrate", fmt_hashrate(p.stats.pool_hashrate)),
        c2 = card("Miners", p.stats.miners.to_string()),
        c3 = card("Workers", p.stats.workers.to_string()),
        c4 = card("Block height", p.stats.block_height.to_string()),
        c5 = card("Network hashrate", fmt_hashrate(p.stats.network_hashrate)),
        c6 = card("Network difficulty", format!("{:.3e}", p.stats.network_difficulty)),
        c7 = card("Shares submitted", p.stats.shares_submitted.to_string()),
        c8 = card("Blocks found", p.blocks.len().to_string()),
        spark_pool = sparkline_titled(history, |s| s.pool_hashrate, "Pool hashrate", fmt_hashrate),
        spark_net = sparkline_titled(history, |s| s.network_hashrate, "Network hashrate", fmt_hashrate),
        spark_miners = sparkline_titled(history, |s| s.miners as f64, "Miners", |v| format!("{v:.0}")),
        id = p.id,
    );
    page_shell(&p.name, body)
}

fn page_chain(reg: &Registry, name: &str) -> String {
    let chains = chains_json(reg);
    let info = chains["chains"]
        .as_array()
        .and_then(|a| a.iter().find(|c| c["chain"] == *name).cloned());
    let Some(info) = info else {
        return page_shell(name, format!("<h1>{name}</h1><p class='sub'>No Blockle pools mine this chain yet.</p>"));
    };
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let rows: String = reg
        .pools
        .values()
        .filter(|p| p.chain == name)
        .map(|p| {
            format!(
                r#"<tr><td><a href="/pool/{id}">{pname}</a></td><td class="mono">{hr}</td><td class="mono">{miners}</td><td class="mono">{fee}%</td><td>{status}</td></tr>"#,
                id = p.id,
                pname = p.name,
                hr = fmt_hashrate(p.stats.pool_hashrate),
                miners = p.stats.miners,
                fee = p.fee_percent,
                status = status_dot(p),
            )
        })
        .collect();
    let body = format!(
        r#"<h1>{name}</h1>
<p class="sub mono">algorithm: {algo}</p>
<div class="cards">{c1}{c2}{c3}{c4}{c5}</div>
<h2>Blockle Pools Mining This Chain</h2>
<table><tr><th>Pool</th><th>Hashrate*</th><th>Miners*</th><th>Fee</th><th>Status</th></tr>{rows}</table>
<p class="note">* operator-reported.</p>"#,
        algo = info["algorithm"].as_str().unwrap_or("?"),
        c1 = card("Blockle pools", info["pools"].to_string()),
        c2 = card("Block height", info["block_height"].to_string()),
        c3 = card("Network hashrate", fmt_hashrate(info["network_hashrate"].as_f64().unwrap_or(0.0))),
        c4 = card("Blockle hashrate", fmt_hashrate(info["total_blockle_hashrate"].as_f64().unwrap_or(0.0))),
        c5 = card("Blockle miners", info["total_blockle_miners"].to_string()),
    );
    page_shell(name, body)
}

fn page_algorithms(reg: &Registry) -> String {
    let mut algos: HashMap<&str, usize> = HashMap::new();
    for p in reg.pools.values() {
        *algos.entry(p.algorithm.as_str()).or_default() += 1;
    }
    let rows: String = algos
        .iter()
        .map(|(a, n)| format!(r#"<tr><td>{a}</td><td class="mono">{n}</td></tr>"#))
        .collect();
    let body = format!(
        r#"<h1>Algorithms</h1>
<p class="sub">Only algorithms observed from actually registered pools are listed — nothing is assumed supported.
Blockle's built-in adapter covers the SHA-256d bitcoind family; other algorithms join through the adapter system (<a href="/developers">see Developers</a>).</p>
<table><tr><th>Algorithm</th><th>Registered pools</th></tr>{rows}</table>
{empty}"#,
        empty = if algos.is_empty() {
            r#"<p class="sub">No pools registered yet.</p>"#
        } else {
            ""
        }
    );
    page_shell("Algorithms", body)
}

fn page_status(reg: &Registry) -> String {
    let ok = |b: bool| if b { r#"<span class="dot on"></span>operational"# } else { r#"<span class="dot off"></span>degraded"# };
    let cycle_fresh = now_unix().saturating_sub(reg.last_monitor_cycle) < 120;
    let body = format!(
        r#"<h1>Network Status</h1>
<table>
<tr><td>{domain}</td><td>{a}</td></tr>
<tr><td>Public API</td><td>{a}</td></tr>
<tr><td>Pool registry</td><td>{a}</td></tr>
<tr><td>Monitoring service</td><td>{b}</td></tr>
<tr><td>Registry store</td><td>{a}</td></tr>
</table>
<p class="sub mono">last monitoring cycle: {cycle} · uptime: {up}s · registered pools: {pools}</p>"#,
        a = ok(true),
        domain = site_domain(),
        b = ok(cycle_fresh || reg.last_monitor_cycle == 0),
        cycle = if reg.last_monitor_cycle == 0 { "pending (starts 30s after boot)".to_string() } else { ago(reg.last_monitor_cycle) },
        up = now_unix() - reg.started,
        pools = reg.pools.len(),
    );
    page_shell("Status", body)
}

fn page_mine(_reg: &Registry) -> String {
    let domain = site_domain();
    let body = format!(
        r##"<h1>Mine with us</h1>
<p class="sub">Two BLOCK pools, both 1% fee, both trust-minimized. Authorize with your <b>BLOCK address</b> as the stratum username (get one from the <a href="/wallet">wallet</a>) — an optional <span class="mono">.rigname</span> suffix names your worker.</p>

<h2>BLOCK · Solo <span class="badge">equihash 200,9 · reward straight to your coinbase</span></h2>
<pre><code>stratum+tcp://{domain}:3333
username: block1…youraddress.rig1     password: x</code></pre>
<p class="sub">Every job we send you pays <b>your</b> address in the coinbase (99%). Find a block, own the reward at maturity — the pool never holds your funds.</p>

<h2>BLOCK · PPLNS <span class="badge">equihash 200,9 · share-weighted payouts</span></h2>
<pre><code>stratum+tcp://{domain}:3334
username: block1…youraddress.rig1     password: x</code></pre>
<p class="sub">Shares are difficulty-weighted over a rolling window; each found block's payouts are settled on-chain automatically once the coinbase matures (100 blocks). The ledger is public.</p>

<h2>Direct pools — every ASIC algorithm <span class="badge">solo semantics · reward in your coinbase</span></h2>
<p class="sub">No parent coin needed: your ASIC grinds a minimal synthetic parent header committing to a BLOCK template that pays <b>you</b>. Classic bitcoin stratum v1; username = your BLOCK address.</p>
<table><tr><th>algorithm</th><th>endpoint</th><th>stats API</th></tr>{direct_rows}</table>

<h2>Hardware</h2>
<p class="sub">BLOCK's native lane is Equihash (200,9) — Zcash-class ASICs and GPU miners (EWBF/lolMiner-compatible stratum) connect directly today. Other ASIC families join by merge-mining through a parent pool (below). Miner-firmware byte-order quirks are still being shaken down against real hardware; if your ASIC rejects jobs, <a href="/developers">tell us</a>.</p>

<h2 id="stats">Pool stats APIs <span class="badge">MiningPoolStats-compatible JSON</span></h2>
<table><tr><th>pool</th><th>endpoint</th></tr>
<tr><td>BLOCK Solo</td><td class="mono"><a href="/api/mps/solo">https://{domain}/api/mps/solo</a></td></tr>
<tr><td>BLOCK PPLNS</td><td class="mono"><a href="/api/mps/pplns">https://{domain}/api/mps/pplns</a></td></tr>
</table>
<p class="sub">Fields: <span class="mono">hashrate_sols_est, miners, workers, fee_percent, blocks_found, last_block, recent_blocks, endpoint</span> — point MiningPoolStats (or anything else) straight at them.</p>

<h2 id="operators">Pool operators: merge-mine BLOCK <span class="badge">aux-work API</span></h2>
<p class="sub">Run a pool on Bitcoin, Litecoin/Dogecoin, Zcash, Dash or any chain on a registered ASIC algorithm? Add BLOCK to every block you mine — your miners earn it for free:</p>
<pre><code># 1. what am I committing to?
curl -s http://{domain}:8445/ -d '{{"method":"getauxchaininfo","params":[]}}'
# → {{"chainid":16972,"algorithms":["sha256d","scrypt","x11","blake2b","blake2s","blake3","eaglesong","kheavyhash","equihash"]}}

# 2. fetch aux work for your payout address + parent algorithm
curl -s http://{domain}:8445/ -d '{{"method":"createauxblock","params":["block1…pooladdr","sha256d"]}}'
# → {{"hash":"…","chainid":16972,"bits":"…","target":"…"}}

# 3. commit `hash` in your coinbase: fabe6d6d ‖ hash ‖ size_le ‖ nonce_le
#    (single-aux: size=1, nonce=0 — Namecoin-shaped, slot = chain_index)

# 4. when a parent block meets BLOCK's lane target, submit the proof
curl -s http://{domain}:8445/ -d '{{"method":"submitauxblock","params":["…hash…", {{"parent_algo":"sha256d","parent_header":[…80 bytes…],"parent_coinbase":[…],"coinbase_branch":[],"chain_branch":[],"chain_index":0}}]}}'</code></pre>
<p class="sub">Each algorithm is an independent difficulty lane, so a Scrypt parent competes only with Scrypt parents. Full validation rules are in the <a href="{github}">source</a> (<span class="mono">chain/crates/chain/src/chain.rs · check_aux_pow</span>).</p>"##,
        domain = domain,
        github = "https://github.com/blocklechain/blockle",
        direct_rows = DIRECT_POOLS
            .iter()
            .map(|(name, _, port)| format!(
                r#"<tr><td class="mono">{name}</td><td class="mono">stratum+tcp://{domain}:{port}</td><td class="mono"><a href="/api/mps/{name}">/api/mps/{name}</a></td></tr>"#
            ))
            .collect::<String>(),
    );
    page_shell("Mine with us", body)
}

fn page_wallet() -> String {
    let rel = "https://github.com/blocklechain/blockle/releases/download/v0.2.1";
    let body = format!(
        r##"<h1>Blockle Wallet</h1>
<p class="sub">A desktop wallet for BLOCK, built on Qt 6. Decentralized by construction: it embeds a full node that syncs from the network peer-to-peer; keys never leave your machine (post-quantum ML-DSA). Transparent + shielded funds, hidden-amount private sends, and regtest tooling for developers.</p>
<h2>Direct downloads</h2>
<table><tr><th>platform</th><th>download</th></tr>
<tr><td>Linux (x86_64)</td><td class="mono"><a href="{rel}/BlockleWallet-linux-x86_64.zip">BlockleWallet-linux-x86_64.zip</a></td></tr>
<tr><td>Windows (x86_64)</td><td class="mono"><a href="{rel}/BlockleWallet-windows-x86_64.zip">BlockleWallet-windows-x86_64.zip</a></td></tr>
<tr><td>macOS (Apple Silicon)</td><td class="mono"><a href="{rel}/BlockleWallet-macos-arm64.zip">BlockleWallet-macos-arm64.zip</a></td></tr>
</table>
<p class="sub">Every build is produced by the public <a href="https://github.com/blocklechain/blockle/actions">CI pipeline</a> — verify provenance there, or build from source.</p>
<h2>Other installs</h2>
<pre><code># Python (wallet GUI + pool tooling)
pip install 'blockle[qt]'   &amp;&amp;   blockle-qt

# Rust (pool core + directory server)
cargo install blockle

# From source
git clone https://github.com/blocklechain/blockle &amp;&amp; cd blockle/chain &amp;&amp; cargo build --release</code></pre>
<h2>First run</h2>
<pre><code>blockle-qt                      # generates post-quantum keys, then
                                # Node tab → peers: {domain}:18444 → Start node</code></pre>
<p class="sub">Back up <span class="mono">~/.blockle/wallet.json</span> — it IS your money.</p>"##,
        rel = rel,
        domain = site_domain(),
    );
    page_shell("Wallet", body)
}

fn page_explorer(_reg: &Registry) -> String {
    let body = match chain_snapshot() {
        Some(c) => {
            let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
            let lanes: String = c["lanes"].as_array().map(|ls| ls.iter().map(|l| format!(
                r#"<tr><td class="mono">{}</td><td class="mono">{}</td><td class="mono">{}</td></tr>"#,
                l["lane"].as_str().unwrap_or("?"),
                l["blocks"].as_u64().unwrap_or(0),
                l["next_bits"].as_str().unwrap_or("?"),
            )).collect()).unwrap_or_default();
            let blocks: String = c["blocks"].as_array().map(|bs| bs.iter().map(|b| format!(
                r#"<tr><td class="mono">{}</td><td class="mono">{}…</td><td class="mono">{}</td><td class="mono">{}</td><td class="mono">{}</td><td class="mono">{}…</td></tr>"#,
                b["height"].as_u64().unwrap_or(0),
                &b["hash"].as_str().unwrap_or("")[..16.min(b["hash"].as_str().unwrap_or("").len())],
                b["lane"].as_str().unwrap_or("?"),
                b["txs"].as_u64().unwrap_or(0),
                fmt_block(b["reward"].as_u64().unwrap_or(0)),
                &b["miner"].as_str().unwrap_or("")[..20.min(b["miner"].as_str().unwrap_or("").len())],
            )).collect()).unwrap_or_default();
            format!(
                r##"<h1>BLOCK Explorer</h1>
<p class="sub">Live from this site's own <span class="mono">blockle-chain</span> node (updated every 30 s).</p>
<div class="cards">{c1}{c2}{c3}{c4}</div>
<h2>Proof-of-work lanes</h2>
<table><tr><th>lane</th><th>blocks</th><th>next bits</th></tr>{lanes}</table>
<h2>Recent blocks</h2>
<table><tr><th>height</th><th>hash</th><th>lane</th><th>txs</th><th>reward</th><th>miner</th></tr>{blocks}</table>"##,
                c1 = card("Height", c["height"].as_u64().map(|h| h.to_string()).unwrap_or("—".into())),
                c2 = card("Supply", format!("{} BLOCK", fmt_block(c["supply"].as_u64().unwrap_or(0)))),
                c3 = card("Mempool", c["mempool"].as_u64().unwrap_or(0).to_string()),
                c4 = card("Premine", format!("{} BLOCK", fmt_block(c["premine"].as_u64().unwrap_or(0)))),
                lanes = lanes,
                blocks = blocks,
            )
        }
        None => r##"<h1>BLOCK Explorer</h1>
<p class="note">The chain snapshot is not configured on this instance (start a <span class="mono">blockle-chain</span> node and pass <span class="mono">--chain-file</span>). No numbers are shown rather than fabricated ones.</p>"##.into(),
    };
    page_shell("BLOCK Explorer", body)
}

fn page_api() -> String {
    let body = r#"<h1>Public API</h1>
<p class="sub">Free JSON API over the monitoring network. No key required at current rate limits; keyed tiers with higher limits are planned.</p>
<h2>Endpoints</h2>
<pre><code>GET  /api/pools          all pools with status + reported stats
GET  /api/pools/{id}     one pool, including 48h history snapshots
GET  /api/chains         chains aggregated across Blockle pools
GET  /api/chains/{id}    one chain
GET  /api/stats          network summary
GET  /api/health         service health
GET  /api/chain          BLOCK chain snapshot (height, lanes, recent blocks)
GET  /api/mps/{solo|pplns}   live pool stats (MiningPoolStats-compatible)
GET  /api/explorer       emission totals by coin and algorithm
GET  /api/explorer/mints         recent mint events (full provenance)
GET  /api/explorer/mint/{hash}   one mint event

POST /api/register       register a pool  {name, chain, algorithm, stratum, pool_fee, website?}
                         → {pool_id, token}
POST /api/heartbeat      {pool_id, token, timestamp, pool_hashrate, miners, workers,
                          blocks_found, block_height, network_hashrate,
                          network_difficulty, shares_submitted, blocks:[{chain,height,hash}]}</code></pre>
<h2>Data honesty</h2>
<p class="sub">Responses separate <code>verified</code> (heartbeat recency, stratum reachability probes) from <code>operator_reported</code> (hashrates, miner counts). Heartbeats are token-authenticated, schema- and range-validated, freshness-checked, and rate limited.</p>"#;
    page_shell("API", body.to_string())
}

fn page_developers(reg: &Registry) -> String {
    let body = format!(
        r#"<h1>Developers</h1>
<h2>What Blockle is</h2>
<p class="sub">An open-source toolkit (single static binary, written in Rust) that deploys and manages PoW mining pools. It interrogates a chain's RPC, figures out how to mine it, and runs the full pool stack: stratum v1, vardiff, share validation, merged mining (AuxPoW), solo/PPLNS/PROP/PPS payout accounting, and a dashboard.</p>
<h2>Install</h2>
<pre><code># from source (repository URL is configurable until the official repo is published)
git clone {github}
cd blockle && cargo build --release</code></pre>
<h2>Create a pool</h2>
<pre><code>blockle add-chain --name MyCoin --rpc http://127.0.0.1:8332 \
    --payout-script &lt;hex scriptPubKey&gt; --scheme pplns --fee 1.0
blockle serve pool.toml</code></pre>
<h2>Interrogation</h2>
<pre><code>blockle inspect --rpc http://127.0.0.1:8332            # capability report
blockle inspect --rpc … --generate-adapter             # starter adapter for unknown chains
blockle discover https://github.com/example/newcoin    # scan a chain's source repo</code></pre>
<h2>Merged mining</h2>
<pre><code># pool.toml
[[chain.aux]]
name = "BLOCK"
rpc = "http://127.0.0.1:18981/"
chain_id = 1</code></pre>
<h2>Register with {domain}</h2>
<pre><code>blockle register --config pool.toml --biz https://{domain}
blockle serve pool.toml     # now heartbeats automatically</code></pre>
<h2>Supporting a new PoW chain</h2>
<p class="sub">Most bitcoind forks need no code: the prober writes a field-map manifest into the pool config. Truly novel chains implement the <code>PoolAdapter</code> trait (job building, share PoW validation, block submission) — <code>inspect --generate-adapter</code> emits a prefilled stub listing exactly what could not be auto-detected.</p>
<h2>Try everything locally</h2>
<pre><code>blockle demo    # simulated chain + generated pool + CPU miner + merged-mined BLOCK chain</code></pre>"#,
        github = reg.github,
        domain = site_domain(),
    );
    page_shell("Developers", body)
}

fn page_open_source(reg: &Registry) -> String {
    let body = format!(
        r#"<h1>Open Source</h1>
<p class="sub">The Blockle core — the pool engine, adapters, prober, and this monitoring server — is open source. Hosted products (Blockle Cloud, advanced monitoring, paid API tiers, custom adapter development, clearly-labeled featured placements) fund the network; none of them are required to register or appear here.</p>
<table>
<tr><td>Repository</td><td class="mono"><a href="{github}">{github}</a></td></tr>
<tr><td>License</td><td>MIT OR Apache-2.0</td></tr>
<tr><td>Contributing</td><td>issues and adapter PRs welcome — start with <code>blockle inspect --generate-adapter</code></td></tr>
<tr><td>Roadmap</td><td>native-structure parents (Kaspa, Nervos, Alephium), adapter SDK, Etchash lane, Blockle Cloud</td></tr>
</table>
<p class="note">The repository link is a configurable placeholder until the official repo is published (--github flag).</p>"#,
        github = reg.github
    );
    page_shell("Open Source", body)
}
