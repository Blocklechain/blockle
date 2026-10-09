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
    /// Base URL of the node's explorer API (the aux-work listener),
    /// e.g. http://127.0.0.1:8445 — powers block/tx/address pages.
    pub chain_api: Option<String>,
}

static EXTRAS: OnceLock<(Option<PathBuf>, Vec<(String, PathBuf)>, Option<String>)> = OnceLock::new();

/// The BLOCK chain snapshot, if the node's explorer file is configured.
fn chain_snapshot() -> Option<Value> {
    let (chain_file, _, _) = EXTRAS.get()?;
    let raw = fs::read_to_string(chain_file.as_ref()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Live stats for one of our own pools: a stratum stats file, or (when the
/// configured value is a URL) a pool dashboard's stats endpoint.
fn pool_stats(name: &str) -> Option<Value> {
    let (_, mps, _) = EXTRAS.get()?;
    let path = mps.iter().find(|(n, _)| n == name).map(|(_, p)| p)?;
    let spec = path.to_string_lossy();
    if spec.starts_with("http://") {
        return serde_json::from_slice(&http::get(&spec, Duration::from_secs(4)).ok()?).ok();
    }
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// All configured pool-stat feed names, in configuration order.
fn pool_feed_names() -> Vec<String> {
    EXTRAS
        .get()
        .map(|(_, mps, _)| mps.iter().map(|(n, _)| n.clone()).collect())
        .unwrap_or_default()
}

/// GET from the node's explorer API; None when unconfigured/unreachable.
fn chain_api(path: &str) -> Option<Value> {
    let (_, _, api) = EXTRAS.get()?;
    let base = api.as_ref()?;
    let raw = http::get(&format!("{base}{path}"), Duration::from_secs(5)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// POST a JSON-RPC call to the node's work/submit interface (chain-api base).
fn chain_api_post(body: &[u8]) -> Option<Value> {
    let (_, _, api) = EXTRAS.get()?;
    let base = api.as_ref()?;
    let raw = http::post(&format!("{base}/"), "application/json", body, Duration::from_secs(10)).ok()?;
    serde_json::from_slice(&raw).ok()
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
    ("sha256d-pplns", "BLOCK · SHA-256d PPLNS", 3360),
    ("scrypt-pplns", "BLOCK · Scrypt PPLNS", 3361),
    ("x11-pplns", "BLOCK · X11 PPLNS", 3362),
    ("blake2b-pplns", "BLOCK · Blake2b PPLNS", 3363),
    ("blake2s-pplns", "BLOCK · Blake2s PPLNS", 3364),
    ("blake3-pplns", "BLOCK · Blake3 PPLNS", 3365),
    ("eaglesong-pplns", "BLOCK · Eaglesong PPLNS", 3366),
    ("kheavyhash-pplns", "BLOCK · kHeavyHash PPLNS", 3367),
];

/// Major ASIC ecosystems BLOCK merge-mines with: (chain, algorithm,
/// hardware note). Status is configured at deploy time — never fabricated.
const PARENT_ROSTER: &[(&str, &str, &str, &str)] = &[
    ("Bitcoin", "sha256d", "SHA-256 ASICs (S19 / S21 class)", "parent node syncing on this server · direct pool live :3340"),
    ("Bitcoin Cash", "sha256d", "SHA-256 ASICs", "parent node syncing on this server · direct pool live :3340"),
    ("eCash + Syscoin", "sha256d", "SHA-256 ASICs (merge-stack)", "parent nodes syncing on this server"),
    ("Litecoin + Dogecoin", "scrypt", "Scrypt ASICs (L7 / L9 class)", "parent nodes syncing on this server · direct pool live :3341"),
    ("Zcash-family (Hush)", "equihash", "Equihash 200,9 ASICs (Z15 class)", "parent node syncing · native BLOCK pools live :3333 / :3334"),
    ("Dash", "x11", "X11 ASICs", "parent node syncing on this server · direct pool live :3342"),
    ("DigiByte", "sha256d + scrypt", "multi-algo", "parent node syncing on this server"),
    ("Kaspa-class", "kheavyhash", "kHeavyHash ASICs", "direct pool live :3347"),
    ("Alephium-class", "blake3", "Blake3 ASICs", "direct pool live :3345"),
    ("Nervos-class", "eaglesong", "Eaglesong ASICs", "direct pool live :3346"),
    ("Sia-class", "blake2b", "Blake2b ASICs", "direct pool live :3343"),
    ("Verge", "blake2s", "Blake2s-capable miners", "parent node syncing on this server · direct pool live :3344"),
];

pub fn serve(cfg: BizConfig) -> Result<Arc<Mutex<Registry>>> {
    let _ = EXTRAS.set((cfg.chain_file.clone(), cfg.mps_files.clone(), cfg.chain_api.clone()));
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
            "/api/submit" => {
                // Light wallets POST { raw: "<bincode-hex tx>" }; relay it to
                // the node, which fully validates before mempool + gossip.
                let raw_hex = body.get("raw").and_then(|v| v.as_str()).unwrap_or("");
                if raw_hex.is_empty() {
                    return jerr("400 Bad Request", "missing raw transaction");
                }
                let rpc = json!({"jsonrpc":"1.0","id":"ext","method":"submitrawtransaction","params":[raw_hex]});
                match chain_api_post(rpc.to_string().as_bytes()) {
                    Some(v) => ("200 OK", "application/json", v.to_string().into_bytes()),
                    None => jerr("503 Service Unavailable", "chain api not reachable"),
                }
            }
            // Register a DEX token's logo (IPFS URI) + creation time, so /dex
            // can display it. Keyed by contract id; first registration wins the
            // created timestamp.
            "/api/dex/register" => {
                let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("");
                let logo = body.get("logo").and_then(|v| v.as_str()).unwrap_or("");
                if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
                    return jerr("400 Bad Request", "token must be a 64-hex contract id");
                }
                let path = "/var/lib/blockle-biz/dex-tokens.json";
                let mut map: Value = fs::read_to_string(path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| json!({}));
                let created = map
                    .get(token)
                    .and_then(|e| e.get("created").and_then(|c| c.as_u64()))
                    .unwrap_or_else(now_unix);
                map[token] = json!({ "logo": logo, "created": created });
                let _ = fs::write(path, map.to_string());
                ("200 OK", "application/json", json!({"ok": true}).to_string().into_bytes())
            }
            // Forward a sell settlement to the local settlement service, which
            // verifies the inbound BLOCK on-chain and sends USDC from the
            // reserve. The service holds the key; biz never sees it.
            "/api/buy/settle" => {
                match http::post(
                    "http://127.0.0.1:8790/settle",
                    "application/json",
                    &req.body,
                    Duration::from_secs(90),
                ) {
                    Ok(raw) => ("200 OK", "application/json", raw),
                    Err(_) => jerr("503 Service Unavailable", "settlement service not reachable"),
                }
            }
            // Sign a MoonPay buy-widget URL (production). Body: {"url": "<widget url>"}.
            "/api/moonpay/sign" => {
                let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
                moonpay_sign(url)
            }
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
        p if p.starts_with("/api/explorer/") => {
            let sub = &p["/api/explorer".len()..];
            match chain_api(&format!("/explorer{sub}")) {
                Some(v) => ("200 OK", "application/json", v.to_string().into_bytes()),
                None => jerr("503 Service Unavailable", "chain api not configured"),
            }
        }
        p if p.starts_with("/api/token/") => {
            // Read a BLOCK-20 token by contract id (hex). Optional ?holder=<hex>
            // returns that address's balance too. Proxies the node's read-only
            // `tokeninfo` view call.
            let id = &p["/api/token/".len()..];
            let holder = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("holder="))
                .unwrap_or("");
            let rpc = json!({
                "jsonrpc": "1.0", "id": "tok", "method": "tokeninfo",
                "params": [{ "contract": id, "holder": holder }],
            });
            match chain_api_post(rpc.to_string().as_bytes()) {
                Some(v) => ("200 OK", "application/json", v.to_string().into_bytes()),
                None => ("503 Service Unavailable", "application/json",
                    json!({"error":"chain api not reachable"}).to_string().into_bytes()),
            }
        }
        "/api/dex/pools" => {
            let rpc = json!({"jsonrpc":"1.0","id":"dex","method":"listpools","params":[]});
            match chain_api_post(rpc.to_string().as_bytes()) {
                Some(v) => ("200 OK", "application/json",
                    v.get("result").cloned().unwrap_or(v).to_string().into_bytes()),
                None => ("503 Service Unavailable", "application/json",
                    json!({"error":"chain api not reachable"}).to_string().into_bytes()),
            }
        }
        "/api/dex/tokens" => {
            let body = fs::read_to_string("/var/lib/blockle-biz/dex-tokens.json")
                .unwrap_or_else(|_| "{}".to_string());
            ("200 OK", "application/json", body.into_bytes())
        }
        p if p.starts_with("/api/dex/pool/") => {
            let id = &p["/api/dex/pool/".len()..];
            let rpc = json!({"jsonrpc":"1.0","id":"pool","method":"poolinfo","params":[{"token":id}]});
            match chain_api_post(rpc.to_string().as_bytes()) {
                Some(v) => ("200 OK", "application/json",
                    v.get("result").cloned().unwrap_or(v).to_string().into_bytes()),
                None => ("503 Service Unavailable", "application/json",
                    json!({"error":"chain api not reachable"}).to_string().into_bytes()),
            }
        }
        "/api/dex/history" => {
            // Per-pool price snapshots recorded by the buy-snapshot timer.
            // ?token=<hex> filters to one token's series.
            let token = query.split('&').find_map(|kv| kv.strip_prefix("token=")).unwrap_or("");
            let all: Value = fs::read_to_string("/var/lib/blockle-biz/dex-history.json")
                .ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
            let series = all.get(token).cloned().unwrap_or_else(|| json!([]));
            ("200 OK", "application/json", series.to_string().into_bytes())
        }
        "/dex" => serve_web_file("dex.html", "text/html; charset=utf-8"),
        "/dex.js" => serve_web_file("dex.js", "application/javascript; charset=utf-8"),
        "/launch" => serve_web_file("launch.html", "text/html; charset=utf-8"),
        "/launch.js" => serve_web_file("launch.js", "application/javascript; charset=utf-8"),
        "/token.js" => serve_web_file("token.js", "application/javascript; charset=utf-8"),
        "/robots.txt" => serve_web_file("robots.txt", "text/plain; charset=utf-8"),
        "/sitemap.xml" => serve_web_file("sitemap.xml", "application/xml; charset=utf-8"),
        "/site.webmanifest" => serve_web_file("site.webmanifest", "application/manifest+json"),
        p if p.starts_with("/token/") => serve_web_file("token.html", "text/html; charset=utf-8"),
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
        "/explorer/peers" => ("200 OK", "text/html; charset=utf-8", page_peers().into_bytes()),
        "/explorer/richlist" => ("200 OK", "text/html; charset=utf-8", page_richlist().into_bytes()),
        p if p.starts_with("/explorer/block/") => {
            let id = &p["/explorer/block/".len()..];
            match chain_api(&format!("/explorer/block/{id}")) {
                Some(b) if b.get("error").is_none() => ("200 OK", "text/html; charset=utf-8", page_block(&b).into_bytes()),
                _ => ("404 Not Found", "text/html; charset=utf-8", page_notfound("block", id).into_bytes()),
            }
        }
        p if p.starts_with("/explorer/tx/") => {
            let id = &p["/explorer/tx/".len()..];
            match chain_api(&format!("/explorer/tx/{id}")) {
                Some(t) if t.get("error").is_none() => ("200 OK", "text/html; charset=utf-8", page_tx(&t).into_bytes()),
                _ => ("404 Not Found", "text/html; charset=utf-8", page_notfound("transaction", id).into_bytes()),
            }
        }
        p if p.starts_with("/explorer/address/") => {
            let id = &p["/explorer/address/".len()..];
            match chain_api(&format!("/explorer/address/{id}")) {
                Some(a) if a.get("error").is_none() => ("200 OK", "text/html; charset=utf-8", page_address(&a).into_bytes()),
                _ => ("404 Not Found", "text/html; charset=utf-8", page_notfound("address", id).into_bytes()),
            }
        }
        "/explorer/search" => {
            let q = query_get(query, "q").unwrap_or("").trim();
            match chain_api(&format!("/explorer/search/{q}")) {
                Some(r) if r.get("error").is_none() => {
                    let kind = r["type"].as_str().unwrap_or("");
                    let id = r["id"].as_str().unwrap_or("");
                    let loc = match kind {
                        "block" => format!("/explorer/block/{id}"),
                        "tx" => format!("/explorer/tx/{id}"),
                        "address" => format!("/explorer/address/{id}"),
                        _ => "/explorer".into(),
                    };
                    ("302 Found", "text/html; charset=utf-8",
                     format!("<meta http-equiv=\"refresh\" content=\"0;url={loc}\">").into_bytes())
                }
                _ => ("404 Not Found", "text/html; charset=utf-8", page_notfound("result for", q).into_bytes()),
            }
        }
        "/mine" => ("200 OK", "text/html; charset=utf-8", page_mine(&reg).into_bytes()),
        p if p.starts_with("/mine/") => {
            let name = &p["/mine/".len()..];
            match pool_stats(name) {
                Some(st) => ("200 OK", "text/html; charset=utf-8", page_pool_detail(name, &st).into_bytes()),
                None => ("404 Not Found", "text/html; charset=utf-8", page_notfound("pool", name).into_bytes()),
            }
        }
        "/wallet" => ("200 OK", "text/html; charset=utf-8", page_wallet().into_bytes()),
        "/studio" => ("200 OK", "text/html; charset=utf-8", page_studio().into_bytes()),
        "/studio.js" => serve_web_file("studio.js", "application/javascript; charset=utf-8"),
        // Agent-facing docs: SDK + MCP install, the buy→launch→pool→trade→sell
        // loop, base-unit + fee conventions, and the mainnet legal-review notice.
        "/agents" => serve_web_file("agents.html", "text/html; charset=utf-8"),
        "/blockle_wasm.js" => serve_web_file("blockle_wasm.js", "application/javascript; charset=utf-8"),
        "/blockle.wasm" => serve_web_file("blockle_wasm_bg.wasm", "application/wasm"),
        // Old Transak-backed Buy/Sell page retired (the fiat widget never came
        // online). Being replaced by a non-custodial exchange at
        // exchange.blockle.org — BLOCK/ETH/SOL/USDC/USDT, wallet-to-wallet.
        "/buy" => ("200 OK", "text/html; charset=utf-8", page_shell("Buy / Sell",
            "<section style=\"max-width:640px;margin:60px auto;text-align:center\">\
             <h1>Buy / Sell is moving</h1>\
             <p class=\"muted\">The old fiat buy/sell page has been retired. A new <strong>non-custodial exchange</strong> is on the way — trade BLOCK against ETH, SOL, USDC and USDT wallet-to-wallet, with no custody and nothing to deposit.</p>\
             <p style=\"margin-top:24px\"><a href=\"/dex\" style=\"background:linear-gradient(135deg,#7c5cff,#37e0c8);color:#fff;padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none\">Trade on the DEX →</a></p>\
             <p class=\"muted\" style=\"margin-top:16px;font-size:13px\">Coming soon: exchange.blockle.org</p>\
             </section>".into()).into_bytes()),
        "/api/buy/config" => ("200 OK", "application/json", buy_config().into_bytes()),
        "/api/buy/history" => ("200 OK", "application/json", buy_history().into_bytes()),
        // Sign a MoonPay buy-widget URL for production. The `url` query param is
        // the URL-encoded widget URL; we HMAC-SHA256 its query string with the
        // server-side secret and append &signature=. With no secret configured
        // (e.g. sandbox + pk_test key), the URL is returned unchanged with
        // "signed": false — sandbox widgets work without a signature.
        "/api/moonpay/sign" => {
            let url = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("url="))
                .map(url_decode)
                .unwrap_or_default();
            moonpay_sign(&url)
        }
        "/guide" => ("200 OK", "text/html; charset=utf-8", page_guide().into_bytes()),
        "/status" => ("200 OK", "text/html; charset=utf-8", page_status(&reg).into_bytes()),
        "/api" => ("200 OK", "text/html; charset=utf-8", page_api().into_bytes()),
        "/developers" => ("200 OK", "text/html; charset=utf-8", page_developers(&reg).into_bytes()),
        "/open-source" => ("200 OK", "text/html; charset=utf-8", page_open_source(&reg).into_bytes()),
        "/privacy" => ("200 OK", "text/html; charset=utf-8", page_privacy().into_bytes()),
        "/terms" => ("200 OK", "text/html; charset=utf-8", page_terms().into_bytes()),
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
        "stratum": public_stratum(&p.stratum),
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

/// Public host for all canonical / og:url / JSON-LD / sitemap URLs. Pinned to
/// the production domain so SEO metadata never leaks the blockle.biz runtime
/// default of `site_domain()`.
const PUBLIC_HOST: &str = "blockle.org";

/// Honest, on-brand default description for routes that don't set their own.
const DEFAULT_DESC: &str = "Blockle is a post-quantum (ML-DSA) layer-1: merge-mined by every major ASIC algorithm, with a native AMM DEX, BLOCK-20 tokens and a meme-token launchpad.";

/// FAQPage structured data for /guide.
const GUIDE_FAQ_JSONLD: &str = r##"<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is Blockle?","acceptedAnswer":{"@type":"Answer","text":"Blockle is a post-quantum layer-1 blockchain using ML-DSA-44 (FIPS-204) signatures and bech32m block1… addresses. Its native coin is BLOCK: 1 BLOCK = 100,000,000 base units, with 600-second blocks."}},{"@type":"Question","name":"How do I mine BLOCK?","acceptedAnswer":{"@type":"Answer","text":"BLOCK is merge-mined as a universal auxiliary chain. Point SHA-256, Scrypt, X11, Equihash, kHeavyHash, Eaglesong or other supported hardware at a Blockle pool and you earn BLOCK alongside the parent chain with no extra power."}},{"@type":"Question","name":"What is a BLOCK-20 token?","acceptedAnswer":{"@type":"Answer","text":"BLOCK-20 is Blockle's token standard. Tokens can be created on the launchpad and trade on the native in-consensus AMM DEX, a constant-product market with a 0.30% swap fee and a one-week LP lock."}},{"@type":"Question","name":"How does the Blockle DEX work?","acceptedAnswer":{"@type":"Answer","text":"The DEX is a native constant-product AMM built into consensus. Swaps pay a 0.30% fee to liquidity providers; new pools have a one-week LP lock. It is fully non-custodial."}},{"@type":"Question","name":"Which wallets can I use?","acceptedAnswer":{"@type":"Answer","text":"Blockle ships a Qt desktop wallet, a Flutter mobile wallet and a browser extension. All hold BLOCK and BLOCK-20 tokens with post-quantum ML-DSA keys."}}]}</script>"##;

/// SoftwareApplication structured data for /wallet.
const WALLET_SOFTWARE_JSONLD: &str = r##"<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Blockle Wallet","applicationCategory":"FinanceApplication","operatingSystem":"Windows, macOS, Linux, Android, iOS, Chrome","description":"Non-custodial wallet for the post-quantum Blockle layer-1 — hold BLOCK and BLOCK-20 tokens with ML-DSA keys. Available for Qt desktop, Flutter mobile and as a browser extension.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"isAccessibleForFree":true,"publisher":{"@type":"Organization","name":"Blockle"}}</script>"##;

/// SoftwareApplication structured data for /studio.
const STUDIO_SOFTWARE_JSONLD: &str = r##"<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Blockle Studio","applicationCategory":"DeveloperApplication","operatingSystem":"Web","description":"Browser-based IDE to write, compile and deploy Blockle VM smart contracts on the post-quantum Blockle layer-1.","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"isAccessibleForFree":true,"publisher":{"@type":"Organization","name":"Blockle"}}</script>"##;

/// Full SEO `<head>` + site chrome.
///
/// * `title`          — short page title; the shell appends " · {host}".
/// * `desc`           — meta description (<=160 chars).
/// * `canonical_path` — path WITH QUERY STRIPPED, e.g. "/mine"; "" => omit
///                      canonical + og:url (use for dynamic/non-indexable pages).
/// * `head_extra`     — raw extra `<head>` HTML (per-page JSON-LD blocks); "" if none.
fn page_shell_seo(title: &str, desc: &str, canonical_path: &str, head_extra: &str, body: String) -> String {
    let domain = PUBLIC_HOST;
    let full_title = format!("{title} · {domain}");
    let (canonical_tag, ogurl_tag) = if canonical_path.is_empty() {
        (String::new(), String::new())
    } else {
        let c = format!("https://{domain}{canonical_path}");
        (
            format!("<link rel=\"canonical\" href=\"{c}\">\n"),
            format!("<meta property=\"og:url\" content=\"{c}\">\n"),
        )
    };
    // Site-wide structured data: Organization + WebSite(+SearchAction).
    let site_jsonld = format!(
        r##"<script type="application/ld+json">{{"@context":"https://schema.org","@graph":[{{"@type":"Organization","@id":"https://{domain}/#org","name":"Blockle","url":"https://{domain}/","logo":"https://{domain}/logo.png","sameAs":["https://github.com/blocklechain/blockle","https://discord.gg/tx4MfyD9Vu","https://crates.io/crates/blockle"]}},{{"@type":"WebSite","@id":"https://{domain}/#website","name":"Blockle","url":"https://{domain}/","publisher":{{"@id":"https://{domain}/#org"}},"potentialAction":{{"@type":"SearchAction","target":{{"@type":"EntryPoint","urlTemplate":"https://{domain}/explorer/search?q={{search_term_string}}"}},"query-input":"required name=search_term_string"}}}}]}}</script>"##
    );
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{desc}">
{canonical_tag}<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/logo-mark.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0B0B14">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Blockle">
<meta property="og:locale" content="en_US">
{ogurl_tag}<meta property="og:title" content="{full_title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="https://{domain}/logo.png">
<meta property="og:image:alt" content="Blockle logo">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{full_title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="https://{domain}/logo.png">
{site_jsonld}{head_extra}
<title>{full_title}</title><style>{CSS}</style></head><body>
<nav><a class="brand" href="/"><img src="/logo-mark.png" alt="Blockle logo">blockle</a>
<a href="/mine">Mine with us</a><a href="/guide">Guide</a><a href="/studio">Studio</a><a href="/explorer">Explorer</a><a href="/wallet">Wallet</a><a href="/dex">DEX</a><a href="/launch">Launch</a><a href="/pools">Directory</a><a href="/status">Status</a><a href="https://exchange.blockle.org" style="background:linear-gradient(135deg,#7c5cff,#37e0c8);color:#fff;padding:6px 14px;border-radius:8px;font-weight:700">Exchange</a>
<span class="spacer"></span>
<a href="https://discord.gg/tx4MfyD9Vu">Discord</a><a href="/api">API</a><a href="/developers">Developers</a><a href="/open-source">Open Source</a></nav>
<main>{body}</main>
<footer>{domain} — mining pools for the majors, every one merge-mining BLOCK, the universal auxiliary chain. Directory statistics marked operator-reported are not independently verified. · <a href="https://discord.gg/tx4MfyD9Vu">Discord</a> · <a href="https://github.com/blocklechain/blockle">GitHub</a> · <a href="https://crates.io/crates/blockle">crates.io</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
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
    )
}

/// Backward-compatible wrapper for dynamic/minor pages that only have a title.
/// Emits the generic brand description and NO page-specific canonical.
fn page_shell(title: &str, body: String) -> String {
    page_shell_seo(title, DEFAULT_DESC, "", "", body)
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
        r##"<a href="https://exchange.blockle.org" style="display:block;margin:0 0 20px;padding:13px 18px;border-radius:12px;background:linear-gradient(135deg,#7c5cff,#37e0c8);color:#fff;text-decoration:none;font-weight:600;text-align:center;line-height:1.4">🚀 New — the <b>Blockle Exchange</b>: non-custodial cross-chain swaps for BLOCK · ETH · SOL · USDC · USDT, self-serve listings and agent-first x402. <span style="text-decoration:underline">Trade now →</span></a>
<div class="hero">
<img class="herologo" src="/logo.png" alt="Blockle logo">
<h1>The universal <span class="grad">auxiliary chain.</span></h1>
<p class="lede">BLOCK is merge-mined by every major ASIC algorithm: point your SHA-256, Scrypt, Equihash, X11, kHeavyHash, Blake or Eaglesong hardware at a Blockle pool and every share you mine works for the parent chain <i>and</i> for BLOCK — a post-quantum L1 with shielded transactions and the Blockle VM.</p>
<div class="cta">
<a class="btn primary" href="/mine">Mine with us</a>
<a class="btn" href="/wallet">Download Wallet</a>
<a class="btn" href="/explorer">Explorer</a>
<a class="btn" href="https://discord.gg/tx4MfyD9Vu">Discord ↗</a>
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
    page_shell_seo(
        "Blockle: post-quantum L1, merge-mined, native DEX",
        "Post-quantum (ML-DSA) layer-1 merge-mined by every major ASIC algorithm, with a native AMM DEX, BLOCK-20 tokens and a meme launchpad.",
        "/", "", body)
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
                stratum = public_stratum(&p.stratum),
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
    page_shell_seo(
        "Mining Pool Directory — merge-mine BLOCK",
        "Browse Blockle and third-party mining pools by chain, algorithm and status. Every pool merge-mines BLOCK, the universal auxiliary chain.",
        "/pools", "", body)
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
        stratum = public_stratum(&p.stratum),
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
    page_shell_seo(
        "Network Status — Blockle pools & BLOCK chain",
        "Live status of Blockle mining pools and the BLOCK chain: height, supply, active PoW lanes, pool hashrate and worker counts.",
        "/status", "", body)
}

/// Normalize the two live-stats shapes (chain-node stratum files and
/// AutoPool dashboard stats.json) into one view.
fn norm_stat<'a>(st: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| st.get(*k)).filter(|v| !v.is_null())
}

fn stat_hashrate(st: &Value) -> f64 {
    norm_stat(st, &["hashrate_sols_est", "hashrate_est"]).and_then(|v| v.as_f64()).unwrap_or(0.0)
}

fn stat_miners(st: &Value) -> u64 {
    norm_stat(st, &["workers", "miners_connected", "miners"]).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn stat_blocks_found(st: &Value) -> u64 {
    match norm_stat(st, &["blocks_found"]) {
        Some(Value::Array(a)) => a.len() as u64,
        Some(v) => v.as_u64().unwrap_or(0),
        None => 0,
    }
}

/// Canonical lane name: lowercase, strip separators so "SHA-256d",
/// "sha256d" and "Sha256D" all land in the same group.
fn canonical_algo(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase()
}

fn stat_algo(st: &Value) -> String {
    let raw = norm_stat(st, &["algorithm"]).and_then(|v| v.as_str()).unwrap_or("equihash");
    canonical_algo(raw)
}

/// Replace a bind/unroutable host (0.0.0.0, [::], 127.0.0.1) in a stratum
/// address with the public site domain, preserving the port. Pools bind
/// to 0.0.0.0 but must advertise a reachable host.
fn public_stratum(addr: &str) -> String {
    let body = addr.strip_prefix("stratum+tcp://").unwrap_or(addr);
    let port = body.rsplit(':').next().unwrap_or("");
    let host = body.rsplitn(2, ':').nth(1).unwrap_or(body);
    let needs = host == "0.0.0.0" || host == "[::]" || host == "127.0.0.1" || host == "localhost";
    let hostport = if needs {
        format!("{}:{}", site_domain(), port)
    } else {
        body.to_string()
    };
    format!("stratum+tcp://{hostport}")
}

fn stat_endpoint(st: &Value) -> String {
    let raw = norm_stat(st, &["endpoint", "stratum"]).and_then(|v| v.as_str()).unwrap_or("");
    public_stratum(raw)
}

fn stat_coin(st: &Value) -> String {
    norm_stat(st, &["coin", "chain"]).and_then(|v| v.as_str()).unwrap_or("BLOCK").to_string()
}

/// How the pool's coin is shown to miners: parent pools mine the parent
/// AND BLOCK, so advertise both.
fn display_coin(st: &Value) -> String {
    let c = stat_coin(st);
    if c == "BLOCK" { c } else { format!("{c} + BLOCK") }
}

fn stat_mode(st: &Value) -> String {
    norm_stat(st, &["mode", "scheme"]).and_then(|v| v.as_str()).unwrap_or("solo").to_string()
}

/// Example miner invocation per algorithm family for the pool pages.
/// `addr_hint` is the username placeholder — a BLOCK address for the BLOCK
/// pools, or the parent chain's own address for merged-mining parent pools.
fn miner_example(algo: &str, endpoint: &str, addr_hint: &str) -> String {
    let (prog, extra) = match algo {
        "equihash" => ("<equihash miner (EWBF/lolMiner-class)>", " --pers auto"),
        "scrypt" => ("cgminer --scrypt", ""),
        "x11" => ("<x11 miner>", ""),
        _ => ("cgminer", ""),
    };
    format!("{prog} -o {endpoint} -u {addr_hint}.rig1 -p x{extra}")
}

fn page_pool_detail(name: &str, st: &Value) -> String {
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let algo = stat_algo(st);
    let endpoint = stat_endpoint(st);
    let coin = stat_coin(st);
    let shown = display_coin(st);
    let is_block_pool = coin == "BLOCK";
    let addr_hint = if is_block_pool { "block1YOURADDRESS".to_string() } else { format!("your{coin}ADDRESS") };
    let miners_rows: String = st.get("miners_detail").and_then(|v| v.as_array()).map(|ms| {
        ms.iter().map(|m| format!(
            r#"<tr><td class="mono">{}</td><td class="mono">{:.2}</td><td class="mono">{}</td><td class="mono">{}</td></tr>"#,
            clean(m["worker"].as_str().unwrap_or("?")),
            m["hashrate_est"].as_f64().unwrap_or(0.0),
            m["accepted"].as_u64().unwrap_or(0),
            m["rejected"].as_u64().unwrap_or(0),
        )).collect()
    }).unwrap_or_default();
    let miners_section = if miners_rows.is_empty() {
        r#"<p class="sub">No miners connected right now — be the first.</p>"#.to_string()
    } else {
        format!(
            r#"<p class="sub">Find your rig by the address you authorized with.</p>
<table><tr><th>worker</th><th>hashrate est</th><th>accepted</th><th>rejected</th></tr>{miners_rows}</table>"#
        )
    };
    let blocks_rows: String = st.get("recent_blocks").and_then(|v| v.as_array()).map(|bs| {
        bs.iter().map(|b| {
            let h = b["height"].as_u64().unwrap_or(0);
            let hash = b["hash"].as_str().unwrap_or("");
            let link = if is_block_pool {
                format!(r#"<a href="/explorer/block/{hash}">{}…</a>"#, &hash[..16.min(hash.len())])
            } else {
                format!("{}…", &hash[..16.min(hash.len())])
            };
            format!(
                r#"<tr><td class="mono">{h}</td><td class="mono">{link}</td><td class="mono">{}</td><td class="mono">{}</td></tr>"#,
                clean(b["finder"].as_str().unwrap_or("?")),
                ago_ts(b["time"].as_u64().unwrap_or(0)),
            )
        }).collect()
    }).unwrap_or_default();
    let payout_copy = match stat_mode(st).as_str() {
        "solo" | "solo-direct" => "Solo: every job's coinbase pays <b>your</b> address directly (minus the 1% fee). A block you find is yours at coinbase maturity — the pool never holds your funds.",
        "pplns" => "PPLNS: shares are difficulty-weighted over a rolling window; found blocks settle on-chain to every contributor automatically after coinbase maturity (1% fee).",
        _ => "Payouts per the pool's configured scheme (1% fee).",
    };
    let body = format!(
        r##"<h1>{shown} · {name} <span class="badge">{algo}</span></h1>
<div class="cards">{c1}{c2}{c3}{c4}</div>
<h2>Connect</h2>
<pre><code>{endpoint}
username: {user_line}     password: {pass_line}

# example
{example}</code></pre>
<p class="sub">{payout_note}</p>
<p class="sub">{payout_copy}</p>
<h2>Miners connected <span class="badge">live</span></h2>
{miners_section}
<h2>Recent blocks</h2>
<table><tr><th>height</th><th>hash</th><th>finder</th><th>when</th></tr>{blocks_rows}</table>
<h2>Stats API</h2>
<p class="sub mono"><a href="/api/mps/{name}">https://{domain}/api/mps/{name}</a> — MiningPoolStats-compatible JSON, updated every 15 s.</p>
<p class="sub"><a href="/mine">← all pools</a></p>"##,
        shown = shown,
        name = name,
        algo = algo,
        c1 = card("Pool hashrate", format!("{:.2}", stat_hashrate(st))),
        c2 = card("Miners", stat_miners(st).to_string()),
        c3 = card("Blocks found", stat_blocks_found(st).to_string()),
        c4 = card("Fee", format!("{}%", norm_stat(st, &["fee_percent"]).and_then(|v| v.as_f64()).unwrap_or(1.0))),
        endpoint = endpoint,
        user_line = if is_block_pool { "block1…youraddress.rigname".to_string() } else { format!("your {coin} payout address . rigname") },
        pass_line = if is_block_pool { "x".to_string() } else { format!("x  (or your {coin} address, if your miner fixes the username)") },
        payout_note = if is_block_pool {
            "Mining BLOCK — paid in BLOCK.".to_string()
        } else {
            format!("This pool mines <b>{coin}</b> (you're paid in {coin}) and merge-mines <b>BLOCK</b> for free. Put your {coin} address as the username — all your rigs under one address aggregate for payout.")
        },
        example = miner_example(&algo, &endpoint, &addr_hint),
        payout_copy = payout_copy,
        miners_section = miners_section,
        blocks_rows = blocks_rows,
        domain = site_domain(),
    );
    page_shell(&format!("{shown} {name} pool"), body)
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

<h2>All pools by algorithm <span class="badge">live · click any pool for stats, miner lookup & connect guide</span></h2>
{algo_sections}

<h2>Hardware</h2>
<p class="sub">BLOCK's native lane is Equihash (200,9) — Zcash-class ASICs and GPU miners (EWBF/lolMiner-compatible stratum) connect directly today. Other ASIC families join by merge-mining through a parent pool (below). Miner-firmware byte-order quirks are still being shaken down against real hardware; if your ASIC rejects jobs, tell us on <a href="https://discord.gg/tx4MfyD9Vu">Discord</a>.</p>

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
        algo_sections = {
            // group every configured feed by its live algorithm
            let mut by_algo: Vec<(String, Vec<(String, Value)>)> = Vec::new();
            for name in pool_feed_names() {
                let Some(st) = pool_stats(&name) else { continue };
                let algo = stat_algo(&st);
                match by_algo.iter_mut().find(|(a, _)| *a == algo) {
                    Some((_, v)) => v.push((name, st)),
                    None => by_algo.push((algo, vec![(name, st)])),
                }
            }
            by_algo
                .iter()
                .map(|(algo, pools)| {
                    let rows: String = pools.iter().map(|(name, st)| format!(
                        r#"<tr><td><a href="/mine/{name}"><b>{coin} · {name}</b></a></td><td class="mono">{endpoint}</td><td class="mono">{mode}</td><td class="mono">{hr:.2}</td><td class="mono">{miners}</td><td class="mono">{blocks}</td></tr>"#,
                        name = name,
                        coin = display_coin(st),
                        endpoint = stat_endpoint(st),
                        mode = stat_mode(st),
                        hr = stat_hashrate(st),
                        miners = stat_miners(st),
                        blocks = stat_blocks_found(st),
                    )).collect();
                    format!(
                        r#"<h2 style="margin-top:1.6rem">{algo} <span class="badge">{n} pool{s}</span></h2>
<table><tr><th>pool</th><th>endpoint</th><th>scheme</th><th>hashrate</th><th>miners</th><th>blocks</th></tr>{rows}</table>"#,
                        algo = algo, n = pools.len(), s = if pools.len() == 1 { "" } else { "s" }, rows = rows,
                    )
                })
                .collect::<String>()
        },
    );
    page_shell_seo(
        "Mine BLOCK — merged mining for every ASIC algo",
        "Point SHA-256, Scrypt, Equihash, X11, kHeavyHash or Eaglesong hardware at a Blockle pool and merge-mine BLOCK with no extra power. Solo or PPLNS, 1% fee.",
        "/mine", "", body)
}

/// Serve a static studio asset from the web dir on disk.
fn serve_web_file(name: &str, ct: &'static str) -> (&'static str, &'static str, Vec<u8>) {
    match std::fs::read(format!("/opt/blockle/web/{name}")) {
        Ok(b) => ("200 OK", ct, b),
        Err(_) => ("404 Not Found", "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}

/// /buy configuration — operator-set at /var/lib/blockle-biz/buy-config.json.
/// Falls back to an honest "not configured" default (empty reserve addresses →
/// the page shows "price discovery not started"). Never fabricates values.
///
/// Compliance/payment-rail fields (consumed by services/x402-buy and
/// services/settlement) ship with safe, honest defaults:
///   facilitatorUrl               — "" (no x402 facilitator wired)
///   networkId                    — "base-sepolia" (TESTNET-FIRST)
///   confirmationDepth            — reorg-safety confirmations before payout
///   dailyUsdcCap                 — 0 (no USDC moves until an operator sets it)
///   perSellAvailabilityFraction  — 0 (no sell liquidity exposed until set)
///   mainnet_enabled              — false; flip to true ONLY after a recorded
///                                  legal/compliance review (see AGENTS.md).
// ================================================================================================
// MoonPay URL signing (production security)
// ================================================================================================
//
// MoonPay recommends signing the buy-widget URL's query string with the secret
// key (HMAC-SHA256 → base64 → url-encoded → appended as &signature=). The
// *publishable* key (pk_test_/pk_live_) is embedded client-side; the *secret*
// key is NEVER hardcoded, committed, or logged — it only ever lives here,
// loaded from env MOONPAY_SECRET or /var/lib/blockle-biz/moonpay-secret. For
// sandbox (pk_test) no secret is required and unsigned URLs work; the secret is
// only needed for production (pk_live) signed URLs.

/// Load the MoonPay secret key, preferring the env var over the on-disk file.
/// Returns None when nothing is configured (sandbox path). The value is never
/// logged.
fn moonpay_secret() -> Option<String> {
    if let Ok(s) = std::env::var("MOONPAY_SECRET") {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    fs::read_to_string("/var/lib/blockle-biz/moonpay-secret")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Sign a MoonPay widget URL. With a secret configured, appends
/// `&signature=<urlencoded base64 HMAC-SHA256(secret, query-string)>` and
/// returns `{"url": <signed>, "signed": true}`. Without a secret, returns
/// `{"url": <unchanged>, "signed": false}` (sandbox works unsigned).
fn moonpay_sign(widget_url: &str) -> (&'static str, &'static str, Vec<u8>) {
    let widget_url = widget_url.trim();
    if widget_url.is_empty() {
        return (
            "400 Bad Request",
            "application/json",
            json!({"error": "missing url"}).to_string().into_bytes(),
        );
    }
    let secret = match moonpay_secret() {
        Some(s) => s,
        None => {
            return (
                "200 OK",
                "application/json",
                json!({"url": widget_url, "signed": false}).to_string().into_bytes(),
            );
        }
    };
    // Sign the query string INCLUDING the leading '?'. If the URL somehow has
    // no query string there is nothing meaningful to sign — return unchanged.
    let Some(qs_start) = widget_url.find('?') else {
        return (
            "200 OK",
            "application/json",
            json!({"url": widget_url, "signed": false}).to_string().into_bytes(),
        );
    };
    let query_string = &widget_url[qs_start..];
    let mac = hmac_sha256(secret.as_bytes(), query_string.as_bytes());
    let signature = url_encode(&base64_encode(&mac));
    let signed = format!("{widget_url}&signature={signature}");
    (
        "200 OK",
        "application/json",
        json!({"url": signed, "signed": true}).to_string().into_bytes(),
    )
}

/// HMAC-SHA256 (RFC 2104) over `sha2::Sha256`. Avoids pulling in an `hmac`
/// crate — the block size is 64 bytes, the digest 32.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        let digest = Sha256::digest(key);
        block[..32].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= block[i];
        opad[i] ^= block[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize());
    out
}

/// Standard base64 (RFC 4648, `+`/`/`, `=` padding).
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
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

/// Percent-encode everything that is not an RFC 3986 unreserved character.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Percent-decode a query-param value (also turns '+' into a space).
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn buy_config() -> String {
    const DEFAULT: &str = r#"{
  "ticker": "BLOCK",
  "feeBps": 500,
  "explorerApi": "https://blockle.org/api/explorer",
  "blockReserveAddr": "",
  "usdc": {
    "network": "base",
    "rpc": "https://mainnet.base.org",
    "contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "decimals": 6,
    "reserveAddr": ""
  },
  "offramp": { "provider": "transak", "apiKey": "", "environment": "STAGING", "network": "base", "defaultCryptoCurrency": "USDC" },
  "facilitatorUrl": "",
  "networkId": "base-sepolia",
  "confirmationDepth": 12,
  "dailyUsdcCap": 0,
  "perSellAvailabilityFraction": 0,
  "mainnet_enabled": false
}"#;
    fs::read_to_string("/var/lib/blockle-biz/buy-config.json").unwrap_or_else(|_| DEFAULT.to_string())
}

/// Recorded curve-price snapshots (written by the buy-snapshot timer on the
/// box). Empty array until the reserve is funded and the first snapshot runs.
fn buy_history() -> String {
    fs::read_to_string("/var/lib/blockle-biz/buy-history.json").unwrap_or_else(|_| "[]".to_string())
}

fn page_studio() -> String {
    page_shell_seo(
        "Studio — Blockle smart-contract IDE",
        "Write, compile and deploy Blockle VM smart contracts in the browser — a contract IDE for the post-quantum Blockle layer-1.",
        "/studio", STUDIO_SOFTWARE_JSONLD, STUDIO_HTML.to_string())
}

const STUDIO_HTML: &str = r##"<style>
.studio-intro{color:var(--muted);margin:0 0 16px}
.studio-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.studio-bar select,.studio-bar input{background:var(--surface);border:1px solid var(--line2);color:var(--text);border-radius:10px;padding:9px 12px;font-size:13px}
.cstat{font-size:13px;margin-left:auto;font-family:ui-monospace,monospace}
.cstat.ok{color:#34d399}.cstat.bad{color:#fb7185}
.studio-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:860px){.studio-grid{grid-template-columns:1fr}}
#src{width:100%;height:440px;resize:vertical;background:#0b0e16;border:1px solid var(--line2);border-radius:12px;color:#dfe6f5;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:14px;outline:none;tab-size:2}
#src:focus{border-color:var(--c1)}
.ed-foot{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;min-height:440px;display:flex;flex-direction:column}
.tabs{display:flex;border-bottom:1px solid var(--line)}
.tab-btn{flex:1;background:none;border:0;color:var(--muted);padding:12px;font-weight:600;font-size:13px;cursor:pointer}
.tab-btn.active{color:var(--c1);box-shadow:inset 0 -2px 0 var(--c1)}
.tabpane{padding:14px;overflow:auto;flex:1}
.callrow{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--bg2)}
.cfn{font-size:13px;margin-bottom:8px}.fidx{color:var(--muted);font-family:ui-monospace,monospace}
.cargs{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cargs input{flex:1;min-width:90px;background:var(--surface);border:1px solid var(--line2);color:var(--text);border-radius:8px;padding:7px 9px;font-size:12px}
.btn.sm{padding:7px 14px;font-size:13px}
.res{border:1px solid var(--line2);border-radius:10px;padding:12px;margin-bottom:12px}
.res.ok{border-color:rgba(52,211,153,.4)}.res.bad{border-color:rgba(251,113,133,.4)}
.resline{margin:2px 0;font-size:14px}.resline.bad{color:#fb7185}
.resmeta{color:var(--muted);font-size:12px;margin-top:4px}
.pill.good{color:#34d399;border:1px solid rgba(52,211,153,.4);border-radius:999px;padding:2px 8px;font-size:11px}
.pill.err{color:#fb7185;border:1px solid rgba(251,113,133,.4);border-radius:999px;padding:2px 8px;font-size:11px}
.statehdr{margin:12px 0 6px;font-size:13px}
.sttable{width:100%;border-collapse:collapse;font-size:12px}
.sttable th{text-align:left;color:var(--muted);font-weight:500;padding:4px 6px;border-bottom:1px solid var(--line)}
.sttable td{padding:5px 6px;border-bottom:1px solid var(--line)}
.histnote{font-size:12px;margin-top:10px}
#bytecode,#asm{white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,monospace;background:#0b0e16;border:1px solid var(--line2);border-radius:10px;padding:12px;color:#aeb8d0}
#asm{white-space:pre}
.deploy-net{display:flex;gap:8px;margin-bottom:12px}
.netpill{border:1px solid var(--line2);border-radius:999px;padding:6px 12px;font-size:12px;color:var(--muted)}
.netpill.on{color:var(--c1);border-color:var(--c1)}
#deploy-out{margin-top:12px;font-size:13px;word-break:break-all}
.good{color:#34d399}.bad{color:#fb7185}
.lbl{font-size:12px;color:var(--muted);display:block;margin:10px 0 4px}
</style>
<h1>Studio <span class="badge">contract IDE</span></h1>
<p class="studio-intro">Write Blockle VM contracts, run them in a built-in <b>testnet sandbox</b> (right here, no wallet needed), and deploy to mainnet through the Blockle Wallet extension. Pick an example to start.</p>

<div class="studio-bar">
  <select id="examples" title="Load an example"></select>
  <button class="btn primary" id="compile-btn">Compile ▶</button>
  <span class="cstat" id="compile-status">—</span>
</div>

<div class="studio-grid">
  <div>
    <textarea id="src" spellcheck="false"></textarea>
    <div class="ed-foot"><span>Blockle Script · ⌘/Ctrl+Enter to compile</span><span id="contract-size">—</span></div>
  </div>
  <div class="panel">
    <div class="tabs">
      <button class="tab-btn active" data-pane="testnet">Testnet sandbox</button>
      <button class="tab-btn" data-pane="bytecode">Bytecode</button>
      <button class="tab-btn" data-pane="deploy">Deploy</button>
    </div>
    <div class="tabpane" id="pane-testnet">
      <div id="calls"></div>
      <div id="output"></div>
    </div>
    <div class="tabpane" id="pane-bytecode" hidden>
      <label class="lbl">Bytecode (hex)</label>
      <div id="bytecode"></div>
      <label class="lbl">Assembly</label>
      <div id="asm"></div>
    </div>
    <div class="tabpane" id="pane-deploy" hidden>
      <p class="muted">The testnet sandbox needs no wallet. To deploy on <b>mainnet</b>, the Blockle Wallet extension signs and broadcasts the deploy transaction with your post-quantum key.</p>
      <label class="lbl">Gas limit</label>
      <input class="mono" id="gas" value="200000" style="width:160px;background:var(--surface);border:1px solid var(--line2);color:var(--text);border-radius:10px;padding:9px 12px">
      <div style="margin-top:14px"><button class="btn primary" id="deploy-btn">Deploy to mainnet</button></div>
      <div id="deploy-out"></div>
    </div>
  </div>
</div>

<script src="/blockle_wasm.js"></script>
<script src="/studio.js"></script>"##;

fn page_wallet() -> String {
    let rel = "https://github.com/blocklechain/blockle/releases/download/v0.3.0";
    let body = format!(
        r##"<h1>Blockle Wallet <span class="badge">multi-chain</span></h1>
<p class="sub">One non-custodial wallet for <b>BLOCK, every major EVM network</b> (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche — plus any custom network you add), <b>BTC, LTC, DOGE and Solana</b>. Auto-detects your tokens, an embedded cross-chain exchange, and an optional <b>in-wallet AI trading agent</b> (bring your own Claude/OpenAI key; spend caps + confirm + kill-switch, keys stay on your device). Desktop (Qt 6, embeds a full BLOCK node), mobile (Flutter) and browser extension. Keys never leave your machine.</p>
<p class="sub" style="font-size:13px"><b>Security note:</b> BLOCK uses post-quantum ML-DSA-44 signatures; BTC/LTC/DOGE/EVM/Solana use their standard ECDSA/ed25519 signatures, held in an encrypted (scrypt + AES-256-GCM) vault. Beta — test with small amounts.</p>
<h2>Direct downloads</h2>
<table><tr><th>platform</th><th>download</th></tr>
<tr><td>Linux (x86_64)</td><td class="mono"><a href="{rel}/BlockleWallet-linux-x86_64.zip">BlockleWallet-linux-x86_64.zip</a></td></tr>
<tr><td>Windows (x86_64)</td><td class="mono"><a href="{rel}/BlockleWallet-windows-x86_64.zip">BlockleWallet-windows-x86_64.zip</a></td></tr>
<tr><td>macOS (Apple Silicon)</td><td class="mono"><a href="{rel}/BlockleWallet-macos-arm64.zip">BlockleWallet-macos-arm64.zip</a></td></tr>
<tr><td>Android (sideload)</td><td class="mono"><a href="{rel}/BlockleWallet-android.apk">BlockleWallet-android.apk</a></td></tr>
</table>
<p class="sub">Every build is produced by the public <a href="https://github.com/blocklechain/blockle/actions">CI pipeline</a> — verify provenance there, or build from source.</p>

<h2>Browser extension <span class="badge">beta</span></h2>
<p class="sub">The full multi-chain wallet in your browser — BLOCK (ML-DSA-44 keys compiled to WebAssembly) plus EVM/BTC/LTC/DOGE/Solana, token auto-detect, the embedded exchange and the AI trading agent, in a password-locked vault. Also exposes a <span class="mono">window.blockle</span> provider for dApps.</p>
<table><tr><th>browser</th><th>download</th></tr>
<tr><td>Chrome · Edge · Brave</td><td class="mono"><a href="{rel}/BlockleWallet-extension.zip">BlockleWallet-extension.zip</a></td></tr>
</table>
<p class="sub">Install (unpacked, while in beta):</p>
<pre><code>1. Download and unzip BlockleWallet-extension.zip
2. Open  chrome://extensions   (or edge://extensions , brave://extensions)
3. Turn on  Developer mode  (top-right)
4. Click  Load unpacked  and select the  blockle-wallet  folder
5. Pin "Blockle Wallet" and open it — create a wallet with a password</code></pre>
<p class="sub">For dApp developers: once a user connects, call
<span class="mono">window.blockle.connect()</span>,
<span class="mono">.getBalance()</span>,
<span class="mono">.signMessage(msg)</span>, and listen for
<span class="mono">accountsChanged</span> events.</p>

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
    page_shell_seo(
        "Blockle Wallet — desktop, mobile & extension",
        "Download the Blockle wallet for Qt desktop, Flutter mobile and browser extension. Hold BLOCK and BLOCK-20 tokens with post-quantum ML-DSA keys.",
        "/wallet", WALLET_SOFTWARE_JSONLD, body)
}

const LEGAL_EFFECTIVE: &str = "9 October 2026";

fn page_privacy() -> String {
    let body = format!(
        r##"<h1>Privacy Policy</h1>
<p class="sub">Effective {date}. Blockle is non-custodial, open-source software. This policy explains the little data the Blockle website and apps touch. It is written in plain language and is not legal advice.</p>

<h2>The short version</h2>
<ul>
<li><b>We never hold your keys, seeds, funds, or wallet passwords.</b> They are generated and stored <b>on your device</b>, encrypted (scrypt + AES-256-GCM), and are never transmitted to us.</li>
<li><b>We do not perform KYC</b> and do not collect your name, email, or identity to use the wallets or the non-custodial exchange.</li>
<li>Your AI-agent provider key (if you connect one) stays in your device's encrypted vault and is sent only to the AI provider you chose (e.g. Anthropic/OpenAI), never to us.</li>
</ul>

<h2>What is processed</h2>
<ul>
<li><b>Public blockchain data.</b> Transactions you broadcast are recorded on public ledgers (BLOCK and the chains you use). That data is public and permanent by design — not controlled by us.</li>
<li><b>Server logs.</b> Like any website, blockle.org and exchange.blockle.org web servers log standard request metadata (IP address, timestamp, user agent, URL) transiently for security and operations.</li>
<li><b>Node / RPC / indexer calls.</b> To show balances and tokens the apps query configurable providers (public RPCs, Esplora, and — if you enable it — Alchemy). Those third parties receive the addresses/requests you look up under their own policies. You can change or self-host every endpoint in settings.</li>
<li><b>Optional, anonymized agent telemetry.</b> The in-wallet agent can send <b>anonymized, bucketed</b> performance stats (strategy, venue, P&amp;L %, size bucket) to improve the product. It is <b>off by default</b>, contains <b>no keys, seeds, credentials, or raw addresses</b>, uses a rotating pseudonymous id, and you can leave it off.</li>
</ul>

<h2>What we do NOT collect</h2>
<p>Private keys, seed phrases, wallet passwords, AI provider credentials, and personal identity information. There is no account to create to use the wallets.</p>

<h2>Cookies</h2>
<p>The marketing site uses only essential cookies/local storage needed for the pages to work. The exchange uses a session cookie after you sign in with your wallet signature.</p>

<h2>Your choices</h2>
<p>Use your own RPC/indexer endpoints, keep agent telemetry off, and remember that on-chain activity is public. You control your keys and data on your device.</p>

<h2>Contact</h2>
<p>Questions: <a href="https://discord.gg/tx4MfyD9Vu">Discord</a> or <a href="{github}">GitHub</a>.</p>

<p class="sub" style="font-size:13px;margin-top:24px">See also our <a href="/terms">Terms of Service</a>.</p>"##,
        date = LEGAL_EFFECTIVE,
        github = "https://github.com/blocklechain/blockle",
    );
    page_shell_seo(
        "Privacy Policy",
        "How the non-custodial Blockle website and wallets handle data — we never hold your keys, funds, or identity; minimal, mostly on-device.",
        "/privacy", "", body)
}

fn page_terms() -> String {
    let body = format!(
        r##"<h1>Terms of Service</h1>
<p class="sub">Effective {date}. These terms govern your use of the Blockle open-source software, website, and the non-custodial exchange. By using them you agree to the following. This is not legal or financial advice.</p>

<h2>1. Non-custodial, self-responsibility</h2>
<p>Blockle software is <b>non-custodial</b>: you alone hold your keys and control your funds. We cannot access, freeze, recover, or reverse your keys or transactions. <b>If you lose your seed/password, your funds are permanently lost.</b> Back up your secrets. On-chain transactions are irreversible.</p>

<h2>2. "As is", no warranty</h2>
<p>The software is provided <b>“AS IS”, without warranty of any kind</b>, express or implied. It is open-source and, where labelled, <b>beta</b> — it may contain bugs. Test with small amounts. To the maximum extent permitted by law, the authors and contributors are <b>not liable</b> for any loss (including loss of funds) arising from use of the software.</p>

<h2>3. Crypto risk</h2>
<p>Digital assets are volatile and risky. Smart-contract, bridge, network, counterparty, and regulatory risks can cause total loss. You are solely responsible for your decisions. Nothing here is investment advice.</p>

<h2>4. The in-wallet AI agent</h2>
<p>The optional AI trading agent acts <b>only on your instructions and under your configured limits</b> (spending caps, confirmations, kill switch) using an AI provider key you supply. You are responsible for its configuration and for every action you authorize. AI output can be wrong; the agent is experimental. We are not responsible for trades it executes with your authorization.</p>

<h2>5. Exchange</h2>
<p>The exchange is a <b>non-custodial</b> venue: trades settle wallet-to-wallet via atomic swaps; we never hold user funds. A small protocol fee may apply per trade/listing as shown in the interface. You are responsible for the assets you list and trade.</p>

<h2>6. Your compliance</h2>
<p>You are responsible for complying with the laws of your jurisdiction, including tax, securities, and sanctions law. You must <b>not</b> use Blockle if you are barred by applicable sanctions or law, and must not use it for illegal activity, fraud, or to evade KYC/sanctions/geographic restrictions. Some features may be gated or unavailable in certain regions.</p>

<h2>7. No intermediary / open source</h2>
<p>Blockle is open-source software (see <a href="{github}">GitHub</a>). Running a public website or interface does not make us a custodian, broker, exchange operator, or money transmitter for your self-custodied activity. You may inspect, build, and run the code yourself.</p>

<h2>8. Changes</h2>
<p>These terms may be updated; the effective date above reflects the latest version. Continued use means acceptance. If any provision is unenforceable, the rest remains in effect.</p>

<p class="sub" style="font-size:13px;margin-top:24px">See also our <a href="/privacy">Privacy Policy</a>.</p>"##,
        date = LEGAL_EFFECTIVE,
        github = "https://github.com/blocklechain/blockle",
    );
    page_shell_seo(
        "Terms of Service",
        "Terms for the non-custodial Blockle software, wallets, and exchange — as-is, you control your keys, crypto risk, and your own legal compliance.",
        "/terms", "", body)
}

fn kv(rows: &[(&str, String)]) -> String {
    let body: String = rows
        .iter()
        .map(|(k, v)| format!(r#"<tr><td style="color:var(--muted)">{k}</td><td class="mono">{v}</td></tr>"#))
        .collect();
    format!("<table>{body}</table>")
}

fn ago_ts(ts: u64) -> String {
    if ts == 0 { return "—".into(); }
    ago(ts)
}

fn explorer_search_box() -> String {
    r##"<form class="filters" method="get" action="/explorer/search">
<input type="text" name="q" placeholder="height · block hash · txid · block1… address" style="flex:1;min-width:16rem">
<button class="btn primary" type="submit">Search</button></form>
<p class="sub" style="margin-top:.4rem"><a href="/explorer">Blocks</a> · <a href="/explorer/richlist">Rich list</a> · <a href="/explorer/peers">Peers</a></p>"##.into()
}

fn page_peers() -> String {
    let body = match chain_api("/explorer/peers") {
        Some(d) => {
            let rows: String = d["peers"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| {
                    format!(
                        r#"<tr><td class="mono">{id}</td><td class="mono">{addr}</td><td class="mono">{ip}</td></tr>"#,
                        id = p["id"],
                        addr = p["address"].as_str().unwrap_or("—"),
                        ip = p["ip"].as_str().unwrap_or("—"),
                    )
                })
                .collect();
            format!(
                r##"{search}<h1>Network peers</h1>
<p class="sub">Connected to <b>{conn}</b> peer(s); learned <b>{known}</b> dialable address(es) via gossip. Peers advertise their real address (source IP + port), so the network propagates as a mesh — every reachable node is discoverable, not just the seed.</p>
<table><tr><th>peer</th><th>address</th><th>source ip</th></tr>{rows}</table>
<p class="sub"><a href="/explorer">← explorer home</a> · <a href="/explorer/richlist">rich list →</a></p>"##,
                search = explorer_search_box(),
                conn = d["count"],
                known = d["known"],
                rows = rows,
            )
        }
        None => "<h1>Network peers</h1><p class=\"sub\">Peer data is unavailable right now.</p>".into(),
    };
    page_shell("Peers", body)
}

fn page_richlist() -> String {
    let body = match chain_api("/explorer/richlist") {
        Some(d) => {
            let rows: String = d["richlist"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    let addr = r["address"].as_str().unwrap_or("");
                    let short = &addr[..24.min(addr.len())];
                    format!(
                        r#"<tr><td class="mono">{rank}</td><td class="mono"><a href="/explorer/address/{addr}">{short}…</a></td><td class="mono">{bal} BLOCK</td><td class="mono">{pct:.2}%</td></tr>"#,
                        rank = r["rank"],
                        addr = addr,
                        short = short,
                        bal = fmt_block(r["balance"].as_u64().unwrap_or(0)),
                        pct = r["pct"].as_f64().unwrap_or(0.0),
                    )
                })
                .collect();
            format!(
                r##"{search}<h1>Rich list</h1>
<p class="sub"><b>{holders}</b> holders · circulating supply <b>{supply} BLOCK</b>. Top 100 addresses by balance.</p>
<table><tr><th>#</th><th>address</th><th>balance</th><th>share</th></tr>{rows}</table>
<p class="sub"><a href="/explorer">← explorer home</a> · <a href="/explorer/peers">peers →</a></p>"##,
                search = explorer_search_box(),
                holders = d["holders"],
                supply = fmt_block(d["supply"].as_u64().unwrap_or(0)),
                rows = rows,
            )
        }
        None => "<h1>Rich list</h1><p class=\"sub\">Rich-list data is unavailable right now.</p>".into(),
    };
    page_shell("Rich list", body)
}

fn page_block(b: &Value) -> String {
    let txs: String = b["txs"].as_array().map(|ts| ts.iter().map(|t| format!(
        r#"<tr><td class="mono"><a href="/explorer/tx/{id}">{short}…</a></td><td>{kind}</td><td class="mono">{nin}</td><td class="mono">{nout}</td><td class="mono">{out} BLOCK</td><td class="mono">{fee}</td></tr>"#,
        id = t["txid"].as_str().unwrap_or(""),
        short = &t["txid"].as_str().unwrap_or("")[..20.min(t["txid"].as_str().unwrap_or("").len())],
        kind = t["kind"].as_str().unwrap_or("?"),
        nin = t["inputs"].as_array().map(|a| a.len()).unwrap_or(0),
        nout = t["outputs"].as_array().map(|a| a.len()).unwrap_or(0),
        out = fmt_block(t["total_out"].as_u64().unwrap_or(0)),
        fee = t["fee"].as_u64().map(|f| fmt_block(f)).unwrap_or_else(|| "—".into()),
    )).collect()).unwrap_or_default();
    let aux = match b.get("aux_pow").filter(|a| !a.is_null()) {
        Some(a) => format!(
            r#"<h2>Merged-mining proof</h2>{}"#,
            kv(&[
                ("parent algorithm", a["parent_algo"].as_str().unwrap_or("?").into()),
                ("parent pow hash", a["parent_pow_hash"].as_str().unwrap_or("?").into()),
                ("parent header size", format!("{} bytes", a["parent_header_size"].as_u64().unwrap_or(0))),
                ("commitment slot", a["chain_index"].as_u64().unwrap_or(0).to_string()),
            ])
        ),
        None => String::new(),
    };
    let height = b["height"].as_u64().unwrap_or(0);
    let body = format!(
        r##"{search}<h1>Block {height}</h1>
<p class="sub mono">{hash}</p>
{meta}
{aux}
<h2>Transactions ({ntx})</h2>
<table><tr><th>txid</th><th>kind</th><th>in</th><th>out</th><th>value</th><th>fee</th></tr>{txs}</table>
<p class="sub"><a href="/explorer/block/{prev_link}">← previous block</a> · <a href="/explorer">explorer home</a></p>"##,
        search = explorer_search_box(),
        height = height,
        hash = b["hash"].as_str().unwrap_or(""),
        meta = kv(&[
            ("lane", b["lane"].as_str().unwrap_or("?").into()),
            ("time", format!("{} ({})", b["time"].as_u64().unwrap_or(0), ago_ts(b["time"].as_u64().unwrap_or(0)))),
            ("confirmations", b["confirmations"].as_u64().unwrap_or(0).to_string()),
            ("difficulty", human_diff(b["difficulty"].as_f64().unwrap_or(0.0))),
            ("size", format!("{} bytes", b["size"].as_u64().unwrap_or(0))),
            ("merkle root", b["merkle_root"].as_str().unwrap_or("?").into()),
            ("previous block", b["prev_hash"].as_str().unwrap_or("?").into()),
            ("native solution", format!("{} bytes", b["solution_bytes"].as_u64().unwrap_or(0))),
        ]),
        aux = aux,
        ntx = b["txs"].as_array().map(|a| a.len()).unwrap_or(0),
        txs = txs,
        prev_link = height.saturating_sub(1),
    );
    let crumb = format!(
        r##"<script type="application/ld+json">{{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{{"@type":"ListItem","position":1,"name":"Explorer","item":"https://{d}/explorer"}},{{"@type":"ListItem","position":2,"name":"Block {height}","item":"https://{d}/explorer/block/{height}"}}]}}</script>"##,
        d = PUBLIC_HOST);
    page_shell_seo(
        &format!("Block {height} — BLOCK Explorer"),
        &format!("Block {height} on the Blockle (BLOCK) chain: timestamp, transactions, size, PoW lane and merge-mining AuxPoW details."),
        &format!("/explorer/block/{height}"), &crumb, body)
}

fn page_tx(t: &Value) -> String {
    let tx = &t["tx"];
    let inputs: String = tx["inputs"].as_array().map(|is| if is.is_empty() {
        r#"<tr><td colspan="3" style="color:var(--muted)">none — this transaction creates new coins (coinbase)</td></tr>"#.to_string()
    } else {
        is.iter().map(|i| format!(
            r#"<tr><td class="mono"><a href="/explorer/tx/{ptx}">{pshort}…</a>:{vout}</td><td class="mono">{addr}</td><td class="mono">{amt}</td></tr>"#,
            ptx = i["prev_txid"].as_str().unwrap_or(""),
            pshort = &i["prev_txid"].as_str().unwrap_or("")[..16.min(i["prev_txid"].as_str().unwrap_or("").len())],
            vout = i["prev_vout"].as_u64().unwrap_or(0),
            addr = i["address"].as_str().map(|a| format!(r#"<a href="/explorer/address/{a}">{}…</a>"#, &a[..24.min(a.len())])).unwrap_or_else(|| "?".into()),
            amt = i["amount"].as_u64().map(fmt_block).unwrap_or_else(|| "?".into()),
        )).collect()
    }).unwrap_or_default();
    let outputs: String = tx["outputs"].as_array().map(|os| os.iter().map(|o| format!(
        r#"<tr><td class="mono">{vout}</td><td class="mono"><a href="/explorer/address/{addr}">{ashort}…</a></td><td class="mono">{amt} BLOCK</td></tr>"#,
        vout = o["vout"].as_u64().unwrap_or(0),
        addr = o["address"].as_str().unwrap_or(""),
        ashort = &o["address"].as_str().unwrap_or("")[..24.min(o["address"].as_str().unwrap_or("").len())],
        amt = fmt_block(o["amount"].as_u64().unwrap_or(0)),
    )).collect()).unwrap_or_default();
    let shielded = match tx.get("shielded").filter(|x| !x.is_null()) {
        Some(sh) => format!(
            r#"<h2>Shielded activity</h2><p class="note">{} spend(s), {} output(s), {} hidden-amount transfer(s). {}</p>"#,
            sh["spends"].as_u64().unwrap_or(0),
            sh["outputs"].as_u64().unwrap_or(0),
            sh["hidden_transfers"].as_u64().unwrap_or(0),
            sh["note"].as_str().unwrap_or(""),
        ),
        None => String::new(),
    };
    let txid = tx["txid"].as_str().unwrap_or("");
    let block_row = match tx["block_height"].as_u64() {
        Some(h) => format!(r#"<a href="/explorer/block/{h}">block {h}</a>"#),
        None => "mempool (unconfirmed)".into(),
    };
    let body = format!(
        r##"{search}<h1>Transaction</h1>
<p class="sub mono">{txid}</p>
{meta}
{shielded}
<h2>Inputs</h2>
<table><tr><th>outpoint</th><th>address</th><th>amount</th></tr>{inputs}</table>
<h2>Outputs</h2>
<table><tr><th>#</th><th>address</th><th>amount</th></tr>{outputs}</table>"##,
        search = explorer_search_box(),
        txid = txid,
        meta = kv(&[
            ("kind", tx["kind"].as_str().unwrap_or("?").into()),
            ("in block", block_row),
            ("confirmations", tx["confirmations"].as_u64().map(|c| c.to_string()).unwrap_or_else(|| "0".into())),
            ("total output", format!("{} BLOCK", fmt_block(tx["total_out"].as_u64().unwrap_or(0)))),
            ("fee", tx["fee"].as_u64().map(|f| format!("{} BLOCK", fmt_block(f))).unwrap_or_else(|| "—".into())),
            ("size", format!("{} bytes", tx["size"].as_u64().unwrap_or(0))),
            ("contract action", if tx["contract"].as_bool().unwrap_or(false) { "yes".into() } else { "no".to_string() }),
        ]),
        shielded = shielded,
        inputs = inputs,
        outputs = outputs,
    );
    let crumb = format!(
        r##"<script type="application/ld+json">{{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{{"@type":"ListItem","position":1,"name":"Explorer","item":"https://{d}/explorer"}},{{"@type":"ListItem","position":2,"name":"Transaction","item":"https://{d}/explorer/tx/{txid}"}}]}}</script>"##,
        d = PUBLIC_HOST, txid = txid);
    page_shell_seo(
        "Transaction — BLOCK Explorer",
        "A Blockle (BLOCK) transaction: inputs, outputs, fee and confirmations on the post-quantum layer-1.",
        &format!("/explorer/tx/{txid}"), &crumb, body)
}

fn page_address(a: &Value) -> String {
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let history: String = a["history"].as_array().map(|hs| hs.iter().map(|h| {
        let net = h["net"].as_i64().unwrap_or(0);
        let sign = if net < 0 { "-" } else { "+" };
        format!(
            r#"<tr><td class="mono">{height}</td><td class="mono"><a href="/explorer/tx/{txid}">{tshort}…</a></td><td>{kind}</td><td class="mono" style="color:{color}">{sign}{amt} BLOCK</td><td class="mono">{when}</td></tr>"#,
            height = h["height"].as_u64().unwrap_or(0),
            txid = h["txid"].as_str().unwrap_or(""),
            tshort = &h["txid"].as_str().unwrap_or("")[..16.min(h["txid"].as_str().unwrap_or("").len())],
            kind = h["kind"].as_str().unwrap_or("?"),
            color = if net < 0 { "#f0948f" } else { "#4ade80" },
            sign = sign,
            amt = fmt_block(net.unsigned_abs()),
            when = ago_ts(h["time"].as_u64().unwrap_or(0)),
        )
    }).collect()).unwrap_or_default();
    let body = format!(
        r##"{search}<h1>Address</h1>
<p class="sub mono">{addr}</p>
<div class="cards">{c1}{c2}{c3}{c4}</div>
<h2>History <span class="badge">latest {n}</span></h2>
<table><tr><th>height</th><th>txid</th><th>kind</th><th>net</th><th>when</th></tr>{history}</table>"##,
        search = explorer_search_box(),
        addr = a["address"].as_str().unwrap_or(""),
        c1 = card("Balance", format!("{} BLOCK", fmt_block(a["balance"].as_u64().unwrap_or(0)))),
        c2 = card("Received", fmt_block(a["total_received"].as_u64().unwrap_or(0))),
        c3 = card("Sent", fmt_block(a["total_sent"].as_u64().unwrap_or(0))),
        c4 = card("Transactions", a["tx_count"].as_u64().unwrap_or(0).to_string()),
        n = a["history"].as_array().map(|h| h.len()).unwrap_or(0),
        history = history,
    );
    let addr = a["address"].as_str().unwrap_or("");
    let crumb = format!(
        r##"<script type="application/ld+json">{{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{{"@type":"ListItem","position":1,"name":"Explorer","item":"https://{d}/explorer"}},{{"@type":"ListItem","position":2,"name":"Address","item":"https://{d}/explorer/address/{addr}"}}]}}</script>"##,
        d = PUBLIC_HOST, addr = addr);
    page_shell_seo(
        "Address — BLOCK Explorer",
        "Blockle (BLOCK) address: balance, BLOCK-20 token holdings and transaction history. Post-quantum bech32m block1… address.",
        &format!("/explorer/address/{addr}"), &crumb, body)
}

fn page_notfound(what: &str, id: &str) -> String {
    page_shell("Not found", format!(
        r##"{search}<h1>Not found</h1><p class="note">No {what} <span class="mono">{id}</span> on this chain.</p><p class="sub"><a href="/explorer">← explorer</a></p>"##,
        search = explorer_search_box(), what = what, id = clean(id),
    ))
}

/// Standardized (Bitcoin-style) difficulty, formatted for humans.
fn human_diff(d: f64) -> String {
    if !d.is_finite() || d <= 0.0 {
        "—".into()
    } else if d >= 1e6 {
        format!("{d:.3e}")
    } else if d >= 1.0 {
        format!("{d:.3}")
    } else {
        format!("{d:.6}")
    }
}

fn page_explorer(_reg: &Registry) -> String {
    let body = match chain_snapshot() {
        Some(c) => {
            let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
            let lanes: String = c["lanes"].as_array().map(|ls| ls.iter().map(|l| format!(
                r#"<tr><td class="mono">{}</td><td class="mono">{}</td><td class="mono">{}</td></tr>"#,
                l["lane"].as_str().unwrap_or("?"),
                l["blocks"].as_u64().unwrap_or(0),
                human_diff(l["next_difficulty"].as_f64().unwrap_or(0.0)),
            )).collect()).unwrap_or_default();
            let blocks: String = c["blocks"].as_array().map(|bs| bs.iter().map(|b| format!(
                r#"<tr><td class="mono"><a href="/explorer/block/{h}">{h}</a></td><td class="mono"><a href="/explorer/block/{hash}">{hshort}…</a></td><td class="mono">{lane}</td><td class="mono">{diff}</td><td class="mono">{txs}</td><td class="mono">{reward}</td><td class="mono"><a href="/explorer/address/{miner}">{mshort}…</a></td></tr>"#,
                h = b["height"].as_u64().unwrap_or(0),
                hash = b["hash"].as_str().unwrap_or(""),
                hshort = &b["hash"].as_str().unwrap_or("")[..16.min(b["hash"].as_str().unwrap_or("").len())],
                lane = b["lane"].as_str().unwrap_or("?"),
                diff = human_diff(b["difficulty"].as_f64().unwrap_or(0.0)),
                txs = b["txs"].as_u64().unwrap_or(0),
                reward = fmt_block(b["reward"].as_u64().unwrap_or(0)),
                miner = b["miner"].as_str().unwrap_or(""),
                mshort = &b["miner"].as_str().unwrap_or("")[..20.min(b["miner"].as_str().unwrap_or("").len())],
            )).collect()).unwrap_or_default();
            format!(
                r##"<h1>BLOCK Explorer</h1>
<p class="sub">Live from this site's own <span class="mono">blockle-chain</span> node. Search any height, block hash, transaction id, or address.</p>
{search}
<div class="cards">{c1}{c2}{c3}{c4}</div>
<h2>Proof-of-work lanes</h2>
<p class="sub">Each algorithm retargets independently, so difficulty differs per lane.</p>
<table><tr><th>lane</th><th>blocks</th><th>difficulty</th></tr>{lanes}</table>
<h2>Recent blocks</h2>
<table><tr><th>height</th><th>hash</th><th>lane</th><th>difficulty</th><th>txs</th><th>reward</th><th>miner</th></tr>{blocks}</table>"##,
                search = explorer_search_box(),
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
    page_shell_seo(
        "BLOCK Explorer — blocks, txs & addresses",
        "Explore the Blockle chain: blocks, transactions, addresses, rich list and peers across the 9-lane multi-algo merge-mined BLOCK network.",
        "/explorer", "", body)
}

fn page_guide() -> String {
    let body = GUIDE_HTML.replace("{domain}", &site_domain());
    page_shell_seo(
        "Blockle Guide — mine, wallet, tokens & DEX",
        "How to set up a Blockle wallet, start merge-mining BLOCK, create BLOCK-20 tokens, add liquidity and trade on the native AMM DEX.",
        "/guide", GUIDE_FAQ_JSONLD, body)
}

/// The how-to guide. Plain raw string (not a format! template) so the JSON /
/// shell snippets can use literal braces; `{domain}` is substituted at render.
const GUIDE_HTML: &str = r##"<h1>Blockle Guide</h1>
<p class="lede">Everything you can do with BLOCK — the universal auxiliary chain — in one place: get a wallet, mine BLOCK directly with any ASIC algorithm, merge-mine it for free alongside a major coin, run your own pool, and explore the chain. Pick a section below.</p>

<div class="feature"><div class="fi">◆</div><b>Two ways to earn BLOCK</b><p><b>Mine it directly</b> — point hardware at a BLOCK pool and the reward is yours. Or <b>merge-mine it free</b> — mine a parent coin (Bitcoin, Litecoin, Dash, Perbug…) and every share also works for BLOCK at no extra energy cost.</p></div>

<h2>Contents</h2>
<p class="sub">
<a href="#what">1. What BLOCK is</a> ·
<a href="#wallet">2. Get a wallet &amp; address</a> ·
<a href="#direct">3. Mine BLOCK directly</a> ·
<a href="#merge">4. Merge-mine via a parent</a> ·
<a href="#scheme">5. Solo vs PPLNS</a> ·
<a href="#hardware">6. Point your hardware</a> ·
<a href="#send">7. Send &amp; receive</a> ·
<a href="#operator">8. Run your own pool</a> ·
<a href="#parent">9. Run a parent node</a> ·
<a href="#explorer">10. Explorer &amp; APIs</a> ·
<a href="#fees">11. Fees</a> ·
<a href="#trouble">12. Troubleshooting</a> ·
<a href="#links">13. Links</a>
</p>

<h2 id="what">1. What BLOCK is</h2>
<p class="sub">BLOCK is a layer-1 built to be merge-mined by <b>every major ASIC algorithm</b>. Its consensus accepts a parent block's proof-of-work — SHA-256d, Scrypt, X11, Equihash, Blake2b/2s/3, Eaglesong or kHeavyHash — in place of a native solution, each as an independent difficulty lane. It pays <b>50 BLOCK</b> per block with Bitcoin-style halvings (210,000-block interval), a 210,000 BLOCK premine, post-quantum signatures (ML-DSA), a shielded pool for private sends, and the Blockle VM. You never mine BLOCK <i>instead</i> of something — you mine it <i>as well</i>.</p>
<div class="feature"><div class="fi">∞</div><b>The chain can't stall</b><p>Because any lane can spike in difficulty when a big miner arrives and then leaves, BLOCK's consensus <b>decays a quiet lane's difficulty over time</b>: once a lane goes silent past a grace window, the work it demands halves at a steady cadence until a block is found again — all the way down to the minimum if needed. That caps the practical time between blocks, so a lane that loses its hashrate always becomes mineable again instead of freezing the chain.</p></div>

<h2 id="wallet">2. Get a wallet &amp; address</h2>
<p class="sub">You need a BLOCK address (starts with <span class="mono">block1…</span>) to be paid. Get one from the desktop wallet or the CLI.</p>
<p class="sub"><b>Desktop wallet:</b> download it from the <a href="/wallet">Wallet page</a> (Linux / Windows / macOS Apple Silicon), launch it, and copy your address from the <b>Receive</b> tab. It embeds a full node and syncs peer-to-peer — your keys never leave your machine.</p>
<p class="sub"><b>CLI:</b></p>
<pre><code># install the node + wallet binary
cargo install blockle-node

# print a fresh mainnet address
blockle-chain --datadir ~/.blockle --network mainnet address</code></pre>
<p class="sub">Back up <span class="mono">~/.blockle/wallet.json</span> (or the desktop wallet's <span class="mono">wallet.json</span>) somewhere safe and offline — <b>it is your money</b>. Nobody can recover it for you.</p>

<h2 id="direct">3. Mine BLOCK directly</h2>
<p class="sub">Point any supported ASIC or GPU straight at a BLOCK pool. The block reward lands in <b>your</b> coinbase (solo) or is shared by the pool (PPLNS). Use your <span class="mono">block1…</span> address as the stratum <b>username</b>; the password can be anything (<span class="mono">x</span>).</p>
<p class="sub"><b>Native Equihash (200,9)</b> — Zcash-class ASICs (Z15) and GPU miners (EWBF / lolMiner):</p>
<pre><code>stratum+tcp://{domain}:3333     # Solo
stratum+tcp://{domain}:3334     # PPLNS
username: your block1… address   password: x</code></pre>
<p class="sub"><b>Dedicated direct pool for every ASIC algorithm</b> — one stratum port per lane, solo and PPLNS:</p>
<table><tr><th>algorithm</th><th>hardware</th><th>solo</th><th>PPLNS</th></tr>
<tr><td>SHA-256d</td><td class="mono">S19 / S21, Bitaxe</td><td class="mono">:3340</td><td class="mono">:3360</td></tr>
<tr><td>Scrypt</td><td class="mono">L7 / L9</td><td class="mono">:3341</td><td class="mono">:3361</td></tr>
<tr><td>X11</td><td class="mono">Dash ASICs</td><td class="mono">:3342</td><td class="mono">:3362</td></tr>
<tr><td>Blake2b</td><td class="mono">Sia-class</td><td class="mono">:3343</td><td class="mono">:3363</td></tr>
<tr><td>Blake2s</td><td class="mono">—</td><td class="mono">:3344</td><td class="mono">:3364</td></tr>
<tr><td>Blake3</td><td class="mono">Alephium-class</td><td class="mono">:3345</td><td class="mono">:3365</td></tr>
<tr><td>Eaglesong</td><td class="mono">CKB ASICs</td><td class="mono">:3346</td><td class="mono">:3366</td></tr>
<tr><td>kHeavyHash</td><td class="mono">Kaspa ASICs</td><td class="mono">:3347</td><td class="mono">:3367</td></tr>
</table>
<p class="sub">All ports are on <span class="mono">{domain}</span>, e.g. <span class="mono">stratum+tcp://{domain}:3340</span>. These are direct BLOCK pools — you are mining BLOCK only, no parent coin involved. See every pool with live stats on the <a href="/mine">Mine page</a>.</p>

<h2 id="merge">4. Merge-mine BLOCK via a parent coin</h2>
<p class="sub">This is the point of BLOCK. Point your hardware at a <b>parent pool</b> and you mine the parent coin <i>and</i> BLOCK at the same time — the same share counts for both, so BLOCK is free hashrate. Your stratum <b>username is your payout address on the parent chain</b> (that's the coin you're paid in); BLOCK is merge-mined alongside every block the pool finds.</p>
<table><tr><th>parent pool</th><th>algorithm</th><th>solo</th><th>PPLNS</th><th>you're paid in</th></tr>
<tr><td><b>Perbug + BLOCK</b></td><td class="mono">sha256d</td><td class="mono">:3357</td><td class="mono">:3377</td><td>PERBUG (+ BLOCK)</td></tr>
<tr><td><b>Dash + BLOCK</b></td><td class="mono">x11</td><td class="mono">:3356</td><td class="mono">:3376</td><td>DASH (+ BLOCK)</td></tr>
</table>
<p class="sub">More parent pools (Bitcoin, Bitcoin Cash, eCash, Syscoin, Litecoin, Dogecoin) come online automatically as their nodes finish syncing on our server — the live set is always on the <a href="/mine">Mine page</a>, grouped by algorithm. Example: connect an L7 to the Litecoin pool when it is live and you mine LTC + BLOCK together.</p>
<pre><code># example: mine Dash + BLOCK (PPLNS), paid in DASH
stratum+tcp://{domain}:3376
username: your Dash (X…) address   password: x</code></pre>

<h2 id="scheme">5. Solo vs PPLNS — which to pick</h2>
<p class="sub"><b>Solo</b> — when you find a block you keep the <b>entire</b> reward (the coinbase pays the finder directly). High variance: you may wait a long time, then get a whole block at once. Best for large hashrate.</p>
<p class="sub"><b>PPLNS</b> — payouts are shared across recent contributors weighted by submitted shares, paid out from blocks the pool finds. Steadier, lower-variance income. Best for small and mid-size miners.</p>
<p class="sub">Both carry the same <b>1% fee</b> (see <a href="#fees">Fees</a>). Every algorithm and every parent pool offers both — just pick the matching port above.</p>

<h2 id="hardware">6. Point your hardware (quick recipes)</h2>
<p class="sub">In your miner's pool/stratum settings, set <b>URL</b>, <b>worker/username</b>, and <b>password</b>. Version-rolling (BIP-310) and vardiff are negotiated automatically.</p>
<table><tr><th>hardware</th><th>URL</th><th>username</th></tr>
<tr><td>Bitaxe / S19 (SHA-256d)</td><td class="mono">stratum+tcp://{domain}:3340</td><td class="mono">block1… (BLOCK)</td></tr>
<tr><td>Antminer L7 (Scrypt)</td><td class="mono">stratum+tcp://{domain}:3341</td><td class="mono">block1… (BLOCK)</td></tr>
<tr><td>Dash ASIC (X11) — also earn DASH</td><td class="mono">stratum+tcp://{domain}:3356</td><td class="mono">X… (Dash addr)</td></tr>
<tr><td>Equihash GPU / Z15</td><td class="mono">stratum+tcp://{domain}:3333</td><td class="mono">block1… (BLOCK)</td></tr>
</table>
<p class="sub">Rule of thumb: a <span class="mono">:334x</span>/<span class="mono">:336x</span> port = direct BLOCK (username is a BLOCK address); a parent port (Perbug/Dash and friends) = you're paid in the parent coin, so the username is your <i>parent</i> address.</p>

<h2 id="send">7. Send &amp; receive BLOCK</h2>
<p class="sub">In the desktop wallet: <b>Receive</b> shows your address and a QR code; <b>Send</b> takes a destination address and amount. Toggle <b>shielded</b> for a private, hidden-amount transfer through the STARK shielded pool.</p>
<pre><code># CLI equivalents
blockle-chain --datadir ~/.blockle balance
blockle-chain --datadir ~/.blockle send block1…recipient 12.5</code></pre>
<p class="sub">If a send fails with <span class="mono">insufficient spendable funds</span>, your coins may still be maturing (coinbase rewards need confirmations) or you forgot to leave room for the network fee — wait for confirmations or lower the amount.</p>

<h2 id="operator">8. Run your own pool &amp; merge-mine BLOCK</h2>
<p class="sub">Already run a pool on Bitcoin, Litecoin, Dash, Zcash — or any chain on a supported algorithm? Add BLOCK to every block you mine and your miners earn it for free. Two paths:</p>
<p class="sub"><b>A. Use the Blockle pool engine</b> (adapters, stratum, payouts, dashboard built in):</p>
<pre><code># 1. generate a pool config pointed at your parent node's RPC
blockle add-chain --name Litecoin \
  --rpc http://user:pass@127.0.0.1:9332/ \
  --out ltc.toml --scheme pplns \
  --stratum 0.0.0.0:3374 --dashboard 127.0.0.1:4874 \
  --fee 1.0 --blockle-address block1…yourpooladdr

# 2. add BLOCK as an aux chain in ltc.toml
#    [[chain.aux]]
#    name = "BLOCK"
#    rpc = "http://{domain}:8445/"
#    chain_id = 16972
#    payout_address = "block1…yourpooladdr"
#    algorithm = "scrypt"

# 3. run it, then register so it appears in the public directory
blockle serve ltc.toml
blockle register --config ltc.toml --biz https://{domain} \
  --public-stratum {domain}:3374</code></pre>
<p class="sub"><b>B. Bring your own pool software</b> — talk to BLOCK's merged-mining work API directly (Namecoin-style, chain id 16972):</p>
<pre><code># discover the lanes BLOCK accepts
curl -s http://{domain}:8445/ -d '{"method":"getauxchaininfo","params":[]}'
# → {"chainid":16972,"algorithms":["sha256d","scrypt","x11","blake2b","blake2s","blake3","eaglesong","kheavyhash","equihash"]}

# fetch aux work for your payout address + your parent algorithm
curl -s http://{domain}:8445/ -d '{"method":"createauxblock","params":["block1…pooladdr","scrypt"]}'

# submit when your parent block commits the BLOCK hash
curl -s http://{domain}:8445/ -d '{"method":"submitauxblock","params":["…hash…", {"parent_algo":"scrypt","parent_header":[],"parent_coinbase":[],"coinbase_branch":[],"chain_branch":[],"chain_index":0}]}'</code></pre>
<p class="sub">Full validation rules: <span class="mono">chain/crates/chain/src/chain.rs · check_aux_pow</span> in the <a href="https://github.com/blocklechain/blockle">source</a>.</p>

<h2 id="parent">9. Run a parent node (pruned)</h2>
<p class="sub">Pools need a parent daemon serving <span class="mono">getblocktemplate</span>. Pruned nodes work fine for mining (no history required) and keep disk small enough to run several on one box.</p>
<pre><code># generate a pruned config + systemd unit for a parent coin
blockle parent-node --coin litecoin --prune 2000 --out ./ltc-node

# supported: bitcoin · litecoin · dogecoin · dash · bitcoincash · digibyte
# then install the official daemon, start it, and point add-chain at its RPC</code></pre>
<p class="sub">For a block explorer, use the built-in <span class="mono">blockle explorer --rpc …</span> (Bitcoin-family) or Eiquidus against the node's JSON-RPC.</p>

<h2 id="explorer">10. Explorer &amp; APIs</h2>
<p class="sub">Browse blocks, transactions and addresses — including each block's merged-mining proof and lane — on the <a href="/explorer">BLOCK explorer</a>. Search by height, block hash, txid or <span class="mono">block1…</span> address.</p>
<p class="sub">Every pool exposes <b>MiningPoolStats-compatible JSON</b> and BLOCK runs a <b>Bitcoin-compatible JSON-RPC</b> (getblockchaininfo, getblock, getrawtransaction, …) so existing tooling works unchanged. See the <a href="/api">API page</a> for endpoints and the <a href="/developers">Developers page</a> for integration.</p>

<h2 id="fees">11. Fees</h2>
<p class="sub">A flat <b>1% fee</b> on every pool — solo and PPLNS, BLOCK-direct and every parent chain, no exceptions. The merge-mined BLOCK you earn on a parent pool carries no extra fee.</p>

<h2 id="trouble">12. Troubleshooting</h2>
<table><tr><th>symptom</th><th>fix</th></tr>
<tr><td>ASIC connects but 0% accepted</td><td>Make sure the port matches your algorithm, and that version-rolling is enabled on the miner. If it persists, tell us on <a href="https://discord.gg/tx4MfyD9Vu">Discord</a> with your model — some firmware byte-orders are still being shaken down against real hardware.</td></tr>
<tr><td>0 hashrate on the dashboard</td><td>Your username must be a <i>valid address</i> for that pool (BLOCK address on direct pools, parent address on parent pools). An invalid username is rejected.</td></tr>
<tr><td>Wallet not syncing</td><td>Check the Node tab has peers; add <span class="mono">{domain}:18444</span> as a peer and restart the node.</td></tr>
<tr><td>"insufficient spendable funds"</td><td>Coins are still maturing or you left no room for the fee — wait for confirmations or send a smaller amount.</td></tr>
</table>

<h2 id="links">13. Links</h2>
<p class="sub">
<a href="/mine">Mine</a> ·
<a href="/explorer">Explorer</a> ·
<a href="/wallet">Wallet</a> ·
<a href="/api">API</a> ·
<a href="/developers">Developers</a> ·
<a href="https://discord.gg/tx4MfyD9Vu">Discord</a> ·
<a href="https://github.com/blocklechain/blockle">GitHub</a> ·
<a href="https://crates.io/crates/blockle">crates.io</a>
</p>"##;

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
                          network_difficulty, shares_submitted, blocks:[{chain,height,hash}]}

GET  /api/moonpay/sign?url=<encoded widget url>   sign a MoonPay buy-widget URL
POST /api/moonpay/sign   {url}  → {url, signed}    (same, URL in the JSON body)</code></pre>
<p class="sub">MoonPay URL signing for the wallets' "Buy with card" flow. A <code>pk_test_</code>
publishable key uses the MoonPay sandbox, whose widget URLs work <em>unsigned</em>; when no
server-side secret is configured this endpoint returns the URL unchanged with
<code>"signed": false</code>. A signature is only required for production (<code>pk_live_</code>)
URLs: configure the MoonPay secret server-side (env <code>MOONPAY_SECRET</code> or
<code>/var/lib/blockle-biz/moonpay-secret</code>) and the endpoint appends
<code>&amp;signature=</code> (base64 HMAC-SHA256 of the query string). The secret never leaves
the server and is never logged.</p>
<h2>Data honesty</h2>
<p class="sub">Responses separate <code>verified</code> (heartbeat recency, stratum reachability probes) from <code>operator_reported</code> (hashrates, miner counts). Heartbeats are token-authenticated, schema- and range-validated, freshness-checked, and rate limited.</p>"#;
    page_shell_seo(
        "Public API — Blockle pool & chain data",
        "Free JSON API for Blockle: pool directory, per-pool and per-chain stats, and live BLOCK chain data. No key required.",
        "/api", "", body.to_string())
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
    page_shell_seo(
        "Developers — build on Blockle",
        "Build on Blockle: Rust crate, JSON API, WASM, the Blockle VM and BLOCK-20 token standard for the post-quantum layer-1.",
        "/developers", "", body)
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
    page_shell_seo(
        "Open Source — the Blockle codebase",
        "Blockle is open source (crates.io + GitHub): the node, wallet, pools, explorer and site. Read, audit and build on the code.",
        "/open-source", "", body)
}
