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
//!   hash). Blocks on whitelisted chains earn 1 BLOCK credit each —
//!   recorded with their evidence hash, deduplicated, and clearly labeled
//!   as pending on-chain settlement.

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

/// A chain eligible for Proof-of-Blocks credits.
#[derive(Clone, Serialize)]
pub struct WhitelistEntry {
    pub name: String,
    pub aliases: Vec<String>,
    pub algorithm: String,
    /// Minimum verified block difficulty. Launch defaults are set orders of
    /// magnitude below each chain's live mainnet difficulty (legitimate
    /// blocks always clear) but far above farmable vanity-chain levels.
    /// Operators tune via --pob-whitelist.
    pub min_difficulty: f64,
    pub daily_cap_per_pool: u64,
    /// How the chain got listed: founding | community | paid.
    pub listing: String,
}

/// Canonical algorithm key for the per-algorithm emission table.
pub fn canonical_algo(algo: &str) -> &'static str {
    let a = algo.to_lowercase();
    if a.contains("sha-512") {
        "sha-512/256d"
    } else if a.contains("sha-256") || a.contains("sha256") {
        "sha-256d"
    } else if a.contains("scrypt") {
        "scrypt"
    } else if a.contains("randomx") {
        "randomx"
    } else if a.contains("equihash") || a.contains("zelhash") || a.contains("beamhash") {
        "equihash"
    } else if a.contains("etchash") || a.contains("ethash") {
        "ethash"
    } else if a.contains("kawpow") || a.contains("progpow") || a.contains("firopow") {
        "kawpow"
    } else if a.contains("autolykos") {
        "autolykos2"
    } else if a.contains("kheavyhash") {
        "kheavyhash"
    } else if a.contains("x11") {
        "x11"
    } else if a.contains("blake") || a.contains("eaglesong") || a.contains("fishhash") {
        "blake-family"
    } else if a.contains("cuckatoo") || a.contains("verthash") || a.contains("lyra2") {
        "cuckoo-family"
    } else if a.contains("astrobwt") {
        "astrobwt"
    } else if a.contains("octopus") {
        "octopus"
    } else if a.contains("nexapow") {
        "nexapow"
    } else {
        "unknown"
    }
}

/// The per-algorithm emission table: BLOCK **base units** (1 BLOCK = 10^8)
/// minted per unit of verified block difficulty. One weight per algorithm —
/// every chain on that algorithm shares it; there are no per-chain
/// overrides, so the emission rule stays objective. Launch calibrations
/// (flagship chains mint sensible amounts at launch-era difficulties),
/// reviewed against market hashprice data before settlement — NOT a USD
/// peg.
pub fn default_algo_weights() -> HashMap<String, f64> {
    [
        ("sha-256d", 1e-3),     // Bitcoin ~1e14 diff → ~1000 BLOCK/block
        ("sha-512/256d", 1e-3),
        ("scrypt", 5.0),        // Litecoin ~5e8 diff → ~25 BLOCK
        ("randomx", 7.5e-3),    // Monero ~4e11 diff → ~30 BLOCK
        ("equihash", 14.0),     // Zcash ~7e7 diff → ~10 BLOCK
        ("ethash", 7.5e-7),     // ETC ~2e15 diff → ~15 BLOCK
        ("kawpow", 2e3),        // Ravencoin ~1e5 diff → ~2 BLOCK
        ("autolykos2", 2.5e-4),
        ("kheavyhash", 2e-2),
        ("x11", 2.0),
        ("blake-family", 1e-4),
        ("cuckoo-family", 1e2),
        ("astrobwt", 1e-1),
        ("octopus", 1e-3),
        ("nexapow", 1e-2),
        // Unlisted/unknown algorithms: deliberately conservative until
        // reviewed.
        ("unknown", 1e-6),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// Resolve the emission weight for a chain's algorithm string: exact
/// (lowercased) table entry first, then the canonical algorithm family,
/// then the conservative unknown weight.
pub fn resolve_algo_weight(table: &HashMap<String, f64>, algo: &str) -> f64 {
    table
        .get(&algo.to_lowercase())
        .or_else(|| table.get(canonical_algo(algo)))
        .or_else(|| table.get("unknown"))
        .copied()
        .unwrap_or(1e-6)
}

fn entry(name: &str, aliases: &[&str], algo: &str, floor: f64) -> WhitelistEntry {
    WhitelistEntry {
        name: name.into(),
        aliases: aliases.iter().map(|s| s.to_string()).collect(),
        algorithm: algo.into(),
        min_difficulty: floor,
        daily_cap_per_pool: POB_DEFAULT_DAILY_CAP,
        listing: "founding".into(),
    }
}

/// The launch whitelist: the big-name PoW chains.
pub fn default_whitelist() -> Vec<WhitelistEntry> {
    vec![
        entry("Bitcoin", &["btc"], "SHA-256d", 1e12),
        entry("Bitcoin Cash", &["bch", "bitcoincash"], "SHA-256d", 1e10),
        entry("eCash", &["xec"], "SHA-256d", 1e9),
        entry("Namecoin", &["nmc"], "SHA-256d (merged)", 1e10),
        entry("Litecoin", &["ltc"], "Scrypt", 1e6),
        entry("Dogecoin", &["doge"], "Scrypt (merged)", 1e6),
        entry("Monero", &["xmr"], "RandomX", 1e9),
        entry("Zcash", &["zec"], "Equihash", 1e6),
        entry("Horizen", &["zen"], "Equihash", 1e5),
        entry("Bitcoin Gold", &["btg"], "Equihash 144,5", 1e4),
        entry("Komodo", &["kmd"], "Equihash", 1e5),
        entry("Flux", &["zelcash"], "ZelHash", 1e4),
        entry("Ethereum Classic", &["etc"], "Etchash", 1e12),
        entry("Ravencoin", &["rvn"], "KawPow", 1e3),
        entry("Firo", &["xzc", "zcoin"], "FiroPow", 1e2),
        entry("Ergo", &["erg"], "Autolykos2", 1e12),
        entry("Kaspa", &["kas"], "kHeavyHash", 1e10),
        entry("Dash", &["dash"], "X11", 1e6),
        entry("DigiByte", &["dgb"], "multi-algo", 1e6),
        entry("Siacoin", &["sc", "sia"], "Blake2b", 1e12),
        entry("Handshake", &["hns"], "Blake2b+SHA3", 1e6),
        entry("Nervos CKB", &["ckb", "nervos"], "Eaglesong", 1e12),
        entry("Kadena", &["kda"], "Blake2s", 1e12),
        entry("Beam", &["beam"], "BeamHash III", 1e4),
        entry("Grin", &["grin"], "Cuckatoo32", 1e4),
        entry("Vertcoin", &["vtc"], "Verthash", 1e2),
        entry("Monacoin", &["mona"], "Lyra2REv2", 1e3),
        entry("Alephium", &["alph"], "Blake3", 1e9),
        entry("Iron Fish", &["ironfish"], "FishHash", 1e6),
        entry("Dero", &["dero"], "AstroBWT", 1e5),
        entry("Conflux", &["cfx"], "Octopus", 1e9),
        entry("Nexa", &["nexa"], "NexaPow", 1e6),
        entry("Radiant", &["rxd"], "SHA-512/256d", 1e6),
        entry("Peercoin", &["ppc"], "SHA-256d (hybrid)", 1e6),
        // The Blockle incentive chain itself (merged-mined by Blockle pools).
        entry("BLOCK", &["blockle"], "SHA-256d (merged)", 0.0),
    ]
}

fn whitelist_lookup<'a>(list: &'a [WhitelistEntry], chain: &str) -> Option<&'a WhitelistEntry> {
    let c = chain.trim().to_lowercase();
    list.iter().find(|e| {
        e.name.to_lowercase() == c || e.aliases.iter().any(|a| a.to_lowercase() == c)
    })
}

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

/// Lifecycle of a Proof-of-Blocks claim.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", content = "detail")]
pub enum ClaimStatus {
    /// Awaiting independent verification against the pool's public chain RPC.
    Pending,
    /// Verified and credited (1 BLOCK).
    Credited,
    Rejected(String),
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PobClaim {
    pub pool_id: String,
    pub chain: String,
    pub height: u64,
    pub hash: String,
    pub reported_at: u64,
    /// Settlement epoch (UTC day index).
    pub epoch: u64,
    pub status: ClaimStatus,
    /// BLOCK minted for this claim, in base units (1 BLOCK = 10^8):
    /// verified difficulty × the chain's algo_weight.
    #[serde(default)]
    pub credits: u64,
    /// Independently verified block difficulty (emission input).
    #[serde(default)]
    pub difficulty: f64,
    /// Per-algorithm weight applied at credit time (emission audit trail).
    #[serde(default)]
    pub algo_weight_used: f64,
    /// BLOCK-chain transaction that settled this mint (empty = pending).
    #[serde(default)]
    pub settled_txid: String,
    #[serde(default)]
    pub confirmations: u64,
    #[serde(default)]
    pub verify_attempts: u32,
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
    /// Proof-of-Blocks credits (1 BLOCK per *verified* block on a
    /// whitelisted chain).
    #[serde(default)]
    pub pob_credits: u64,
    /// Public RPC used by blockle.biz to independently verify claimed
    /// blocks (optional — without it, claims are never credited).
    #[serde(default)]
    pub chain_rpc: String,
    /// Verification RPCs for merged-mined aux chains: chain name → URL.
    #[serde(default)]
    pub aux_chain_rpcs: HashMap<String, String>,
    /// BLOCK settlement address for PoB payouts.
    #[serde(default)]
    pub payout_address: String,
    /// External pool: not running Blockle software; blockle.biz watches the
    /// chain itself and attributes blocks by coinbase signature.
    #[serde(default)]
    pub external: bool,
    /// Coinbase signature (tag or address fragment) identifying this
    /// external pool's blocks.
    #[serde(default)]
    pub coinbase_tag: String,
    /// Chain-watcher cursor (last inspected height) for external pools.
    #[serde(default)]
    pub watch_height: u64,
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
    pub whitelist: Vec<WhitelistEntry>,
    /// Per-algorithm emission weights (the only emission knob).
    pub algo_weights: HashMap<String, f64>,
    pub pob_claims: Vec<PobClaim>,
    pub github: String,
    /// Shared secret authorizing mark-settled calls (empty = disabled).
    pub settle_key: String,
    pub started: u64,
    pub last_monitor_cycle: u64,
    data_path: PathBuf,
    rate: HashMap<String, u64>, // pool_id -> last heartbeat accepted
}

impl Registry {
    fn load(
        data_path: PathBuf,
        whitelist: Vec<WhitelistEntry>,
        algo_weights: HashMap<String, f64>,
        github: String,
        settle_key: String,
    ) -> Self {
        let pools: HashMap<String, PoolRecord> = fs::read_to_string(&data_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<PoolRecordOnDisk>>(&raw).ok())
            .map(|v| v.into_iter().map(|p| (p.record.id.clone(), p.into_record())).collect())
            .unwrap_or_default();
        let pob_claims: Vec<PobClaim> = fs::read_to_string(
            data_path.with_extension("claims.json"),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
        Registry {
            pools,
            history: HashMap::new(),
            whitelist,
            algo_weights,
            pob_claims,
            github,
            settle_key,
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
        if let Ok(raw) = serde_json::to_string_pretty(&self.pob_claims) {
            let _ = fs::write(self.data_path.with_extension("claims.json"), raw);
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
    pub whitelist: Vec<WhitelistEntry>,
    /// Per-algorithm emission weights (merged over the defaults).
    pub algo_weights: HashMap<String, f64>,
    pub github: String,
    /// Monitoring / verification cycle interval (seconds).
    pub monitor_interval_secs: u64,
    /// Shared secret authorizing mark-settled calls (empty = disabled).
    pub settle_key: String,
    /// Public domain for titles/links (e.g. "blockle.org").
    pub domain: String,
}

pub fn serve(cfg: BizConfig) -> Result<Arc<Mutex<Registry>>> {
    let _ = SITE_DOMAIN.set(if cfg.domain.is_empty() {
        "blockle.biz".into()
    } else {
        cfg.domain.clone()
    });
    let registry = Arc::new(Mutex::new(Registry::load(
        cfg.data_path,
        cfg.whitelist,
        cfg.algo_weights,
        cfg.github,
        cfg.settle_key,
    )));
    let listener = TcpListener::bind(&cfg.listen)
        .map_err(|e| anyhow!("blockle.biz cannot listen on {}: {e}", cfg.listen))?;
    println!("[biz] {} serving on http://{}/", site_domain(), cfg.listen);

    // Monitoring worker: offline detection + active stratum probes +
    // history snapshots + PoB verification + external-pool chain watching.
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
            watch_external_pools(&registry);
            verify_pob_claims(&registry);
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
            "/api/pob/mark-settled" => api_mark_settled(registry, &body),
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
        "/api/pob" => ("200 OK", "application/json", pob_json(&reg).to_string().into_bytes()),
        "/api/explorer" => (
            "200 OK",
            "application/json",
            explorer_json(&reg).to_string().into_bytes(),
        ),
        "/api/explorer/mints" => {
            let mints: Vec<Value> = reg
                .pob_claims
                .iter()
                .rev()
                .filter(|c| c.status == ClaimStatus::Credited)
                .take(200)
                .map(|c| mint_json(&reg, c))
                .collect();
            ("200 OK", "application/json", json!({"mints": mints}).to_string().into_bytes())
        }
        p if p.starts_with("/api/explorer/mint/") => {
            let hash = &p["/api/explorer/mint/".len()..];
            match reg
                .pob_claims
                .iter()
                .find(|c| c.hash == hash && c.status == ClaimStatus::Credited)
            {
                Some(c) => ("200 OK", "application/json", mint_json(&reg, c).to_string().into_bytes()),
                None => jerr("404 Not Found", "no such mint"),
            }
        }
        "/api/pob/settlement-batch" => (
            "200 OK",
            "application/json",
            settlement_batch_json(&reg).to_string().into_bytes(),
        ),
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
        "/pob" => ("200 OK", "text/html; charset=utf-8", page_pob(&reg).into_bytes()),
        "/explorer" => ("200 OK", "text/html; charset=utf-8", page_explorer(&reg).into_bytes()),
        p if p.starts_with("/explorer/mint/") => {
            let hash = &p["/explorer/mint/".len()..];
            match reg
                .pob_claims
                .iter()
                .find(|c| c.hash == hash && c.status == ClaimStatus::Credited)
            {
                Some(c) => (
                    "200 OK",
                    "text/html; charset=utf-8",
                    page_mint(&reg, c).into_bytes(),
                ),
                None => (
                    "404 Not Found",
                    "text/html; charset=utf-8",
                    page_shell("Not found", "<p>No such mint.</p>".into()).into_bytes(),
                ),
            }
        }
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
        payout_address: get("payout_address").unwrap_or_default(),
        aux_chain_rpcs: body
            .get("aux_chain_rpcs")
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|u| (clean(k), clean(u))))
                    .collect()
            })
            .unwrap_or_default(),
        external: body.get("external").and_then(|v| v.as_bool()).unwrap_or(false),
        coinbase_tag: get("coinbase_tag").unwrap_or_default(),
        watch_height: 0,
        fee_percent: fee,
        registered_at: now_unix(),
        last_heartbeat: 0,
        stats: ReportedStats::default(),
        blocks: Vec::new(),
        pob_credits: 0,
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
    let whitelist = reg.whitelist.clone();
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
    // Proof of Blocks: new found blocks become *claims*, globally deduped
    // by (chain, hash). Credits only happen after independent verification
    // by the monitoring worker — never on report.
    let mut claims_opened = 0u64;
    let pool_id_owned = pool.id.clone();
    let mut new_claims: Vec<PobClaim> = Vec::new();
    if let Some(blocks) = body.get("blocks").and_then(|v| v.as_array()) {
        for b in blocks.iter().take(100) {
            let chain = b.get("chain").and_then(|v| v.as_str()).map(clean).unwrap_or_default();
            let hash = b.get("hash").and_then(|v| v.as_str()).map(clean).unwrap_or_default();
            let height = b.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
            if hash.is_empty() || pool.blocks.iter().any(|x| x.hash == hash) {
                continue;
            }
            pool.blocks.push(ReportedBlock { chain: chain.clone(), height, hash: hash.clone(), at: now });
            if pool.blocks.len() > 500 {
                pool.blocks.remove(0);
            }
            if whitelist_lookup(&whitelist, &chain).is_some() {
                new_claims.push(PobClaim {
                    pool_id: pool_id_owned.clone(),
                    chain,
                    height,
                    hash,
                    reported_at: now,
                    epoch: now / 86_400,
                    status: ClaimStatus::Pending,
                    credits: 0,
                    difficulty: 0.0,
                    algo_weight_used: 0.0,
                    settled_txid: String::new(),
                    confirmations: 0,
                    verify_attempts: 0,
                });
                claims_opened += 1;
            }
        }
    }
    pool.last_heartbeat = now;
    for claim in new_claims {
        // Global dedupe: the first pool to claim a (chain, hash) owns it.
        let duplicate = reg
            .pob_claims
            .iter()
            .any(|c| c.hash == claim.hash && c.chain.eq_ignore_ascii_case(&claim.chain));
        if !duplicate {
            reg.pob_claims.push(claim);
        }
    }
    reg.rate.insert(pool_id.to_string(), now);
    reg.persist();
    (
        "200 OK",
        "application/json",
        json!({"ok": true, "pob_claims_opened": claims_opened}).to_string().into_bytes(),
    )
}

/// Record that an epoch's mints were executed on the BLOCK chain.
fn api_mark_settled(registry: &Arc<Mutex<Registry>>, body: &Value) -> (&'static str, &'static str, Vec<u8>) {
    let jerr = |code: &'static str, msg: &str| {
        (code, "application/json", json!({"error": msg}).to_string().into_bytes())
    };
    let mut reg = registry.lock().unwrap();
    if reg.settle_key.is_empty() {
        return jerr("403 Forbidden", "settlement marking is disabled (no --settle-key)");
    }
    if body.get("key").and_then(|k| k.as_str()) != Some(reg.settle_key.as_str()) {
        return jerr("401 Unauthorized", "bad settlement key");
    }
    let Some(epoch) = body.get("epoch").and_then(|e| e.as_u64()) else {
        return jerr("400 Bad Request", "epoch required");
    };
    let txid = body
        .get("txid")
        .and_then(|t| t.as_str())
        .map(clean)
        .unwrap_or_default();
    if txid.is_empty() {
        return jerr("400 Bad Request", "txid required");
    }
    let mut marked = 0u64;
    for c in reg.pob_claims.iter_mut() {
        if c.epoch == epoch && c.status == ClaimStatus::Credited && c.settled_txid.is_empty() {
            c.settled_txid = txid.clone();
            marked += 1;
        }
    }
    reg.persist();
    println!("[biz] epoch {epoch} marked settled ({marked} mints) via tx {txid}");
    (
        "200 OK",
        "application/json",
        json!({"ok": true, "epoch": epoch, "mints_marked": marked}).to_string().into_bytes(),
    )
}

/// Watch the chains of external pools (pools not running Blockle software):
/// walk new blocks over the registered public RPC and attribute any block
/// whose coinbase carries the pool's signature. Opt-in requires zero
/// infrastructure change on the pool's side.
fn watch_external_pools(registry: &Arc<Mutex<Registry>>) {
    let targets: Vec<(String, String, String, u64)> = {
        let reg = registry.lock().unwrap();
        reg.pools
            .values()
            .filter(|p| p.external && !p.chain_rpc.is_empty() && !p.coinbase_tag.is_empty())
            .map(|p| (p.id.clone(), p.chain_rpc.clone(), p.coinbase_tag.clone(), p.watch_height))
            .collect()
    };
    for (pool_id, rpc_url, tag, mut cursor) in targets {
        let rpc = RpcClient::new(&rpc_url);
        let RpcOutcome::Ok(count) = rpc.call("getblockcount", json!([])) else { continue };
        let tip = count.as_u64().unwrap_or(0);
        if cursor == 0 && tip > 10 {
            cursor = tip - 10; // start near the tip on first watch
        }
        let mut found: Vec<(String, u64, String)> = Vec::new(); // (chain, height, hash)
        let tag_hex = hex::encode(tag.as_bytes()).to_lowercase();
        let upper = tip.min(cursor + 20);
        for h in (cursor + 1)..=upper {
            // Resolve the block hash (getblockhash, or getblock-by-height fallback).
            let hash = match rpc.call("getblockhash", json!([h])) {
                RpcOutcome::Ok(v) => v.as_str().map(String::from),
                _ => None,
            };
            let Some(hash) = hash else { continue };
            let RpcOutcome::Ok(block) = rpc.call("getblock", json!([hash.clone()])) else {
                continue;
            };
            // Coinbase bytes: simchain exposes `coinbase_script`; bitcoind
            // verbosity-2 exposes tx[0].hex.
            let coinbase_hex = block
                .get("coinbase_script")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| {
                    block
                        .get("tx")
                        .and_then(|t| t.get(0))
                        .and_then(|t0| t0.get("hex"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                });
            let chain = block
                .get("chain")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_default();
            if let Some(cb) = coinbase_hex {
                if cb.to_lowercase().contains(&tag_hex) {
                    found.push((chain, h, hash));
                }
            }
        }
        let mut reg = registry.lock().unwrap();
        let now = now_unix();
        let fallback_chain = reg.pools.get(&pool_id).map(|p| p.chain.clone()).unwrap_or_default();
        for (chain, height, hash) in found {
            let chain = if chain.is_empty() { fallback_chain.clone() } else { chain };
            let duplicate = reg
                .pob_claims
                .iter()
                .any(|c| c.hash == hash && c.chain.eq_ignore_ascii_case(&chain));
            if duplicate {
                continue;
            }
            println!("[biz] watcher attributed {chain} block {height} to external pool {pool_id}");
            reg.pob_claims.push(PobClaim {
                pool_id: pool_id.clone(),
                chain: chain.clone(),
                height,
                hash: hash.clone(),
                reported_at: now,
                epoch: now / 86_400,
                status: ClaimStatus::Pending,
                credits: 0,
                difficulty: 0.0,
                algo_weight_used: 0.0,
                settled_txid: String::new(),
                confirmations: 0,
                verify_attempts: 0,
            });
            if let Some(pool) = reg.pools.get_mut(&pool_id) {
                pool.blocks.push(ReportedBlock { chain, height, hash, at: now });
            }
        }
        if let Some(pool) = reg.pools.get_mut(&pool_id) {
            pool.watch_height = upper.max(pool.watch_height);
            // A successful watch cycle counts as liveness for external pools.
            pool.last_heartbeat = now;
        }
        reg.persist();
    }
}

/// Independently verify pending PoB claims against each pool's registered
/// public chain RPC, then credit or reject. Called from the monitoring
/// worker; RPC happens outside the registry lock.
fn verify_pob_claims(registry: &Arc<Mutex<Registry>>) {
    // Snapshot pending work.
    let pending: Vec<(usize, String, String, String)> = {
        let reg = registry.lock().unwrap();
        reg.pob_claims
            .iter()
            .enumerate()
            .filter(|(_, c)| c.status == ClaimStatus::Pending)
            .take(50)
            .map(|(i, c)| {
                // Pick the verification RPC for this claim's chain: the
                // pool's primary RPC, or its registered aux-chain RPC.
                let rpc = reg
                    .pools
                    .get(&c.pool_id)
                    .map(|p| {
                        if p.chain.eq_ignore_ascii_case(&c.chain) {
                            p.chain_rpc.clone()
                        } else {
                            p.aux_chain_rpcs
                                .iter()
                                .find(|(k, _)| k.eq_ignore_ascii_case(&c.chain))
                                .map(|(_, v)| v.clone())
                                .unwrap_or_default()
                        }
                    })
                    .unwrap_or_default();
                (i, rpc, c.hash.clone(), c.chain.clone())
            })
            .collect()
    };
    if pending.is_empty() {
        return;
    }
    enum Verdict {
        Confirmed { confirmations: u64, difficulty: f64 },
        NotFound,
        NoRpc,
        RpcError,
    }
    let mut verdicts: Vec<(usize, Verdict)> = Vec::new();
    for (idx, rpc_url, hash, _chain) in &pending {
        if rpc_url.is_empty() {
            verdicts.push((*idx, Verdict::NoRpc));
            continue;
        }
        let rpc = RpcClient::new(rpc_url);
        match rpc.call("getblock", json!([hash])) {
            RpcOutcome::Ok(v) if v.is_object() => {
                let confirmations = v.get("confirmations").and_then(|c| c.as_u64()).unwrap_or(0);
                let difficulty = v.get("difficulty").and_then(|d| d.as_f64()).unwrap_or(0.0);
                verdicts.push((*idx, Verdict::Confirmed { confirmations, difficulty }));
            }
            RpcOutcome::Ok(_) | RpcOutcome::MethodNotFound => verdicts.push((*idx, Verdict::NotFound)),
            RpcOutcome::Error(e) if e.to_lowercase().contains("not found") => {
                verdicts.push((*idx, Verdict::NotFound))
            }
            RpcOutcome::Error(_) => verdicts.push((*idx, Verdict::RpcError)),
        }
    }

    let mut reg = registry.lock().unwrap();
    let now = now_unix();
    let whitelist = reg.whitelist.clone();
    let algo_weights = reg.algo_weights.clone();
    for (idx, verdict) in verdicts {
        // Credits-today count for cap enforcement (computed per claim).
        let (pool_id, chain, epoch) = {
            let c = &reg.pob_claims[idx];
            (c.pool_id.clone(), c.chain.clone(), c.epoch)
        };
        let credited_today = reg
            .pob_claims
            .iter()
            .filter(|c| {
                c.pool_id == pool_id
                    && c.chain.eq_ignore_ascii_case(&chain)
                    && c.epoch == epoch
                    && c.status == ClaimStatus::Credited
            })
            .count() as u64;
        let claim = &mut reg.pob_claims[idx];
        match verdict {
            Verdict::Confirmed { confirmations, difficulty } => {
                claim.confirmations = confirmations;
                claim.verify_attempts += 1;
                if confirmations < POB_MIN_CONFIRMATIONS {
                    continue; // keep pending until deep enough
                }
                let Some(entry) = whitelist_lookup(&whitelist, &claim.chain) else {
                    claim.status = ClaimStatus::Rejected("chain left the whitelist".into());
                    continue;
                };
                if difficulty < entry.min_difficulty {
                    claim.status = ClaimStatus::Rejected(format!(
                        "block difficulty {difficulty:.3e} below the {} floor {:.3e}",
                        entry.name, entry.min_difficulty
                    ));
                    continue;
                }
                if credited_today >= entry.daily_cap_per_pool {
                    claim.status =
                        ClaimStatus::Rejected("daily Proof-of-Blocks cap reached".into());
                    continue;
                }
                claim.status = ClaimStatus::Credited;
                claim.difficulty = difficulty;
                // Emission ∝ verified work: difficulty × the per-ALGORITHM
                // weight (shared by every chain on that algorithm).
                let weight = resolve_algo_weight(&algo_weights, &entry.algorithm);
                let minted = (difficulty * weight).round().clamp(0.0, 1e18) as u64;
                claim.credits = minted;
                claim.algo_weight_used = weight;
                let chain_name = claim.chain.clone();
                if let Some(pool) = reg.pools.get_mut(&pool_id) {
                    pool.pob_credits = pool.pob_credits.saturating_add(minted);
                }
                println!(
                    "[biz] PoB credited: {pool_id} +{} BLOCK (diff {difficulty:.3e}) for a {chain_name} block",
                    fmt_block(minted)
                );
            }
            Verdict::NotFound => {
                claim.verify_attempts += 1;
                if claim.verify_attempts >= POB_MAX_VERIFY_ATTEMPTS {
                    claim.status = ClaimStatus::Rejected(
                        "block not found via the registered verification RPC".into(),
                    );
                }
            }
            Verdict::RpcError => {
                claim.verify_attempts += 1;
                if claim.verify_attempts >= POB_MAX_VERIFY_ATTEMPTS {
                    claim.status =
                        ClaimStatus::Rejected("verification RPC unreachable".into());
                }
            }
            Verdict::NoRpc => {
                if now.saturating_sub(claim.reported_at) > POB_PENDING_GRACE_SECS {
                    claim.status = ClaimStatus::Rejected(
                        "no public verification RPC registered (register with --public-chain-rpc)"
                            .into(),
                    );
                }
            }
        }
    }
    reg.persist();
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
        "pob_credits_base_units": p.pob_credits,
        "pob_credits": fmt_block(p.pob_credits),
        "payout_address": p.payout_address,
        "external": p.external,
        "monitor_mode": if p.external { "watched" } else { "heartbeat" },
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
        "pob_credits_total": reg.pools.values().map(|p| p.pob_credits).sum::<u64>(),
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
                "pob_whitelisted": whitelist_lookup(&reg.whitelist, chain).is_some(),
            })
        })
        .collect();
    json!({"chains": chains})
}

/// The chain-listing policy for Proof-of-Blocks eligibility.
fn listing_policy() -> Value {
    json!({
        "requirements": [
            "proof-of-work consensus (no PoS, no authority chains)",
            "listed on at least one exchange",
            "public, verifiable chain RPC for block verification",
            "real network difficulty above the assigned floor",
        ],
        "fees_usd": {
            "mainstream_fork": 1000,
            "custom_deployment_or_chain": 2000,
            "founding_chains": 0,
        },
        "notes": [
            "the listing fee covers review and monitoring integration; it does not purchase legitimacy and does not waive the technical requirements",
            "founding chains (the built-in major-PoW list) are grandfathered",
            "emission is difficulty-based (minted = verified difficulty x algorithm weight); algorithm weights and difficulty floors are set at review and revisited against market hashprice data before settlement",
        ],
    })
}

fn pob_json(reg: &Registry) -> Value {
    let claims: Vec<Value> = reg
        .pob_claims
        .iter()
        .rev()
        .take(200)
        .map(|c| serde_json::to_value(c).unwrap())
        .collect();
    let credited: u64 = reg
        .pob_claims
        .iter()
        .filter(|c| c.status == ClaimStatus::Credited)
        .map(|c| c.credits)
        .sum();
    let pending = reg.pob_claims.iter().filter(|c| c.status == ClaimStatus::Pending).count();
    let rejected = reg
        .pob_claims
        .iter()
        .filter(|c| matches!(c.status, ClaimStatus::Rejected(_)))
        .count();
    json!({
        "model": "difficulty-based emission: minted BLOCK = verified block difficulty x per-algorithm weight. Difficulty is fetched independently at verification; algo weights only normalize across algorithms and are reviewed against market hashprice data before settlement. NOT a USD peg or redemption promise.",
        "listing_policy": listing_policy(),
        "algorithm_weights": reg.algo_weights.iter().collect::<std::collections::BTreeMap<_, _>>(),
        "whitelist": reg.whitelist,
        "totals": {
            "block_minted_base_units": credited,
            "block_minted": fmt_block(credited),
            "claims_pending": pending,
            "claims_rejected": rejected,
            "claims_total": reg.pob_claims.len(),
        },
        "pools": reg.pools.values().map(|p| json!({
            "pool_id": p.id,
            "pob_credits_base_units": p.pob_credits,
            "pob_credits": fmt_block(p.pob_credits),
            "payout_address": p.payout_address,
            "monitor_mode": if p.external { "watched" } else { "heartbeat" },
        })).collect::<Vec<_>>(),
        "claims": claims,
    })
}

/// Settlement export: credited BLOCK grouped per epoch and payout address —
/// the artifact a future on-chain settlement executor consumes.
fn settlement_batch_json(reg: &Registry) -> Value {
    let mut by_epoch: HashMap<u64, HashMap<String, u64>> = HashMap::new();
    for c in reg
        .pob_claims
        .iter()
        .filter(|c| c.status == ClaimStatus::Credited && c.settled_txid.is_empty())
    {
        let addr = reg
            .pools
            .get(&c.pool_id)
            .map(|p| {
                if p.payout_address.is_empty() {
                    format!("UNSET:{}", p.id)
                } else {
                    p.payout_address.clone()
                }
            })
            .unwrap_or_else(|| format!("UNKNOWN:{}", c.pool_id));
        *by_epoch.entry(c.epoch).or_default().entry(addr).or_default() += c.credits;
    }
    let mut epochs: Vec<Value> = by_epoch
        .into_iter()
        .map(|(epoch, entries)| {
            let total: u64 = entries.values().sum();
            json!({
                "epoch": epoch,
                "entries": entries.into_iter().map(|(address, amount)| json!({
                    "address": address,
                    "amount_base_units": amount,
                    "amount_block": fmt_block(amount),
                })).collect::<Vec<_>>(),
                "total_base_units": total,
                "total_block": fmt_block(total),
            })
        })
        .collect();
    epochs.sort_by_key(|e| e["epoch"].as_u64().unwrap_or(0));
    // Already-settled epochs, with their BLOCK-chain txids.
    let mut settled: HashMap<u64, (String, u64)> = HashMap::new();
    for c in reg
        .pob_claims
        .iter()
        .filter(|c| c.status == ClaimStatus::Credited && !c.settled_txid.is_empty())
    {
        let e = settled.entry(c.epoch).or_insert((c.settled_txid.clone(), 0));
        e.1 += c.credits;
    }
    let mut settled: Vec<Value> = settled
        .into_iter()
        .map(|(epoch, (txid, total))| json!({
            "epoch": epoch, "txid": txid,
            "total_base_units": total, "total_block": fmt_block(total),
        }))
        .collect();
    settled.sort_by_key(|e| e["epoch"].as_u64().unwrap_or(0));
    json!({
        "status": "epochs listed under `epochs` await on-chain settlement",
        "epochs": epochs,
        "settled": settled,
    })
}

/// The BLOCK emission explorer: every mint event with full provenance.
fn explorer_json(reg: &Registry) -> Value {
    let mints: Vec<&PobClaim> = reg
        .pob_claims
        .iter()
        .filter(|c| c.status == ClaimStatus::Credited)
        .collect();
    let total: u64 = mints.iter().map(|c| c.credits).sum();

    // emission by source coin
    let mut by_chain: HashMap<String, (u64, u64, f64)> = HashMap::new(); // blocks, minted, max diff
    for m in &mints {
        let e = by_chain.entry(m.chain.clone()).or_default();
        e.0 += 1;
        e.1 += m.credits;
        e.2 = e.2.max(m.difficulty);
    }
    let whitelist = &reg.whitelist;
    let mut chains: Vec<Value> = by_chain
        .into_iter()
        .map(|(chain, (blocks, minted, max_diff))| {
            let algo = whitelist_lookup(whitelist, &chain)
                .map(|e| e.algorithm.clone())
                .unwrap_or_else(|| "unknown".into());
            json!({
                "chain": chain,
                "algorithm": algo,
                "blocks_credited": blocks,
                "block_minted_base_units": minted,
                "block_minted": fmt_block(minted),
                "share_of_emission": if total > 0 { minted as f64 / total as f64 } else { 0.0 },
                "max_block_difficulty": max_diff,
            })
        })
        .collect();
    chains.sort_by(|a, b| {
        b["block_minted_base_units"].as_u64().cmp(&a["block_minted_base_units"].as_u64())
    });

    // emission by algorithm (canonical family, or the exact custom name
    // when no family matches)
    let mut by_algo: HashMap<String, (u64, u64)> = HashMap::new();
    for m in &mints {
        let algo = whitelist_lookup(whitelist, &m.chain)
            .map(|e| {
                let c = canonical_algo(&e.algorithm);
                if c == "unknown" { e.algorithm.to_lowercase() } else { c.to_string() }
            })
            .unwrap_or_else(|| "unknown".into());
        let e = by_algo.entry(algo).or_default();
        e.0 += 1;
        e.1 += m.credits;
    }
    let algorithms: Vec<Value> = by_algo
        .into_iter()
        .map(|(algo, (blocks, minted))| json!({
            "algorithm": algo,
            "blocks_credited": blocks,
            "block_minted_base_units": minted,
            "block_minted": fmt_block(minted),
        }))
        .collect();

    json!({
        "ledger": "BLOCK's current ledger is the emission ledger: every transaction is a mint from a verified source-chain block (settlement transfers activate with the BLOCK chain).",
        "totals": {
            "block_minted_base_units": total,
            "block_minted": fmt_block(total),
            "mint_events": mints.len(),
            "source_chains": chains.len(),
        },
        "emission_by_chain": chains,
        "emission_by_algorithm": algorithms,
    })
}

fn mint_json(reg: &Registry, c: &PobClaim) -> Value {
    let pool = reg.pools.get(&c.pool_id);
    json!({
        "type": "MINT",
        "source": {
            "chain": c.chain,
            "height": c.height,
            "hash": c.hash,
            "difficulty": c.difficulty,
            "confirmations_at_credit": c.confirmations,
        },
        "emission": {
            "algo_weight_used": c.algo_weight_used,
            "formula": format!("{:.6e} (difficulty) × {:.6e} (algo weight) = {} BLOCK",
                c.difficulty, c.algo_weight_used, fmt_block(c.credits)),
            "amount_base_units": c.credits,
            "amount_block": fmt_block(c.credits),
        },
        "recipient": {
            "pool_id": c.pool_id,
            "payout_address": pool.map(|p| p.payout_address.clone()).unwrap_or_default(),
        },
        "epoch": c.epoch,
        "reported_at": c.reported_at,
        "settlement": if c.settled_txid.is_empty() {
            json!("pending on-chain settlement")
        } else {
            json!({"status": "settled", "block_chain_txid": c.settled_txid})
        },
    })
}

// ================================================================================================
// HTML
// ================================================================================================

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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>⬡</text></svg>">
<title>{title} · {domain}</title><style>{CSS}</style></head><body>
<nav><a class="brand" href="/"><span class="hex">⬡</span>blockle</a>
<a href="/pools">Pools</a><a href="/algorithms">Algorithms</a><a href="/pob">Proof of Blocks</a><a href="/explorer">Explorer</a><a href="/status">Status</a>
<span class="spacer"></span>
<a href="/api">API</a><a href="/developers">Developers</a><a href="/open-source">Open Source</a></nav>
<main>{body}</main>
<footer>{domain} — the public directory and monitoring network for Blockle-deployed PoW mining pools. Statistics marked operator-reported are not independently verified.</footer>
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

fn page_home(reg: &Registry) -> String {
    let st = network_stats(reg);
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let body = format!(
        r##"<div class="hero">
<h1>Deploy PoW mining pools.<br><span class="grad">Monitor them from one place.</span></h1>
<p class="lede">Blockle interrogates any Proof-of-Work chain's RPC, figures out how to mine it, and deploys the full pool — stratum, vardiff, share validation, merged mining, payouts. {domain} is the public directory, statistics, and monitoring network for every Blockle pool.</p>
<div class="cta">
<a class="btn primary" href="/pools">Explore Pools</a>
<a class="btn" href="/developers">Deploy a Pool</a>
<a class="btn" href="{github}">GitHub ↗</a>
</div>
<div class="term"><div class="term-bar"><i></i><i></i><i></i><span>blockle — zsh</span></div>
<pre><code><span class="t-dim">$</span> blockle init https://github.com/example/newcoin
<span class="t-accent">── blockle init ──</span>
<span class="t-dim">1.</span> scanning source… <span class="t-ok">algorithm: SHA-256d</span> · rpc port 8332 · confidence 96%
<span class="t-dim">2.</span> looking for a running node… <span class="t-ok">found at http://127.0.0.1:8332/</span>
<span class="t-ok">✓</span> Block template detected   <span class="t-ok">✓</span> Difficulty & reward
<span class="t-ok">✓</span> Field mapping              <span class="t-ok">✓</span> Submission method
<span class="t-ok">Pool ready.</span>
<span class="t-accent">stratum+tcp://0.0.0.0:3333</span></code></pre></div>
</div>
<h2>Network</h2>
<div class="cards">{c1}{c2}{c3}{c4}{c5}{c6}{c7}</div>
<h2>How it works</h2>
<div class="features">
<div class="feature"><div class="fi">🛰️</div><b>Interrogate</b><p>Three-layer chain detection: RPC dialect census, block-template introspection with field mapping, and algorithm fingerprinting — each finding with evidence and a confidence score.</p></div>
<div class="feature"><div class="fi">⚙️</div><b>Deploy</b><p>One command generates the full pool: stratum v1 with vardiff, full share validation, merged mining (AuxPoW), solo / PPLNS / PROP / PPS payouts, and a dashboard.</p></div>
<div class="feature"><div class="fi">📡</div><b>Monitor</b><p>Register once and heartbeat automatically. Online status and stratum reachability are verified by active probes; everything else is clearly labeled operator-reported.</p></div>
<div class="feature"><div class="fi">⬡</div><b>Earn BLOCK</b><p>Every independently verified block on a whitelisted chain mints BLOCK proportional to its difficulty — settled on the BLOCK chain. <a href="/pob">Proof of Blocks →</a></p></div>
</div>
<p class="note">Hashrate, miner, and block figures are operator-reported by registered pools; online status and stratum reachability are verified by {domain} monitoring. Proof-of-Blocks credits are minted only after independent verification.</p>"##,
        github = reg.github,
        domain = site_domain(),
        c1 = card("Blockle Pools", st["total_pools"].to_string()),
        c2 = card("Online", st["online_pools"].to_string()),
        c3 = card("Chains", st["chains_supported"].to_string()),
        c4 = card("Reported Hashrate", fmt_hashrate(st["total_hashrate_reported"].as_f64().unwrap_or(0.0))),
        c5 = card("Blocks Found", st["blocks_found_reported"].to_string()),
        c6 = card("Active Miners", st["active_miners_reported"].to_string()),
        c7 = card("BLOCK Minted", fmt_block(st["pob_credits_total"].as_u64().unwrap_or(0))),
    );
    page_shell("Blockle", body)
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
<p class="sub"><span class="mono">{pob}</span> BLOCK accrued from verified blocks (emission = difficulty × algorithm weight; pending on-chain settlement).</p>
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
        pob = fmt_block(p.pob_credits),
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
<p class="sub mono">algorithm: {algo}{pob}</p>
<div class="cards">{c1}{c2}{c3}{c4}{c5}</div>
<h2>Blockle Pools Mining This Chain</h2>
<table><tr><th>Pool</th><th>Hashrate*</th><th>Miners*</th><th>Fee</th><th>Status</th></tr>{rows}</table>
<p class="note">* operator-reported.</p>"#,
        algo = info["algorithm"].as_str().unwrap_or("?"),
        pob = if info["pob_whitelisted"].as_bool().unwrap_or(false) {
            " · Proof-of-Blocks whitelisted ✓"
        } else {
            ""
        },
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

fn page_pob(reg: &Registry) -> String {
    let p = pob_json(reg);
    let wl_rows: String = reg
        .whitelist
        .iter()
        .map(|e| {
            format!(
                r#"<tr><td>{}</td><td>{} <span class="badge">{}</span></td><td class="mono">{:.1e}</td><td class="mono">{:.2e}</td><td class="mono">{}</td><td><span class="badge">{}</span></td></tr>"#,
                e.name,
                e.algorithm,
                canonical_algo(&e.algorithm),
                e.min_difficulty,
                resolve_algo_weight(&reg.algo_weights, &e.algorithm),
                e.daily_cap_per_pool,
                e.listing
            )
        })
        .collect();
    let mut aw: Vec<(&String, &f64)> = reg.algo_weights.iter().collect();
    aw.sort_by(|a, b| a.0.cmp(b.0));
    let aw_rows: String = aw
        .iter()
        .map(|(k, v)| format!(r#"<tr><td class="mono">{k}</td><td class="mono">{v:.2e}</td></tr>"#))
        .collect();
    let claim_rows: String = reg
        .pob_claims
        .iter()
        .rev()
        .take(30)
        .map(|c| {
            let (status, detail) = match &c.status {
                ClaimStatus::Pending => ("pending".to_string(), format!("{} conf", c.confirmations)),
                ClaimStatus::Credited => (
                    "credited".to_string(),
                    format!("+{} BLOCK (diff {:.2e})", fmt_block(c.credits), c.difficulty),
                ),
                ClaimStatus::Rejected(r) => ("rejected".to_string(), r.clone()),
            };
            format!(
                r#"<tr><td><a href="/pool/{}">{}</a></td><td>{}</td><td class="mono">{}</td><td class="mono">{}…</td><td>{status}</td><td class="sub">{detail}</td></tr>"#,
                c.pool_id, c.pool_id, c.chain, c.height, &c.hash[..16.min(c.hash.len())]
            )
        })
        .collect();
    let body = format!(
        r#"<h1>Proof of Blocks</h1>
<p class="sub">Every <em>verified</em> block a registered pool finds on a whitelisted chain mints BLOCK proportional to the work it represents: <span class="mono">minted = block&nbsp;difficulty × algorithm&nbsp;weight</span>. The difficulty is fetched independently during verification — a Bitcoin block mints on the order of a thousand BLOCK, a small chain's block a fraction, and nothing is operator-declared. Verification is independent: blockle.biz checks each claimed block against the pool's registered public chain RPC (existence, ≥{conf} confirmations, difficulty floor) before anything is credited. Existing pools can opt in with <strong>zero infrastructure change</strong>: register as an external pool with a coinbase signature, and the chain watcher attributes blocks automatically.</p>
<p class="note">Algorithm weights only normalize difficulty units across PoW algorithms; they are launch calibrations reviewed against market hashprice data before settlement. This is an emission rule, <strong>not</strong> a USD peg or redemption promise. Credits are pending on-chain settlement to the BLOCK chain.</p>
<div class="cards">
<div class="card"><div class="v">{minted}</div><div class="k">BLOCK minted</div></div>
<div class="card"><div class="v">{pending}</div><div class="k">Claims pending</div></div>
<div class="card"><div class="v">{rejected}</div><div class="k">Claims rejected</div></div>
</div>
<h2>Algorithm weights (the only emission knob)</h2>
<p class="sub">One weight per algorithm — every chain on that algorithm shares it. No per-chain overrides exist, so no chain can negotiate its own emission. Operators tune with <code>--algo-weight "randomx=7.5e-3,…"</code>.</p>
<table><tr><th>Algorithm</th><th>BLOCK base units / difficulty unit</th></tr>{aw_rows}</table>
<h2>Whitelisted chains ({n})</h2>
<table><tr><th>Chain</th><th>Algorithm (canonical)</th><th>Difficulty floor</th><th>Resolved weight</th><th>Daily cap/pool</th><th>Listing</th></tr>{wl_rows}</table>
<h2>Getting listed</h2>
<p class="sub">Requirements — all mandatory, no exceptions:</p>
<table>
<tr><td>Consensus</td><td>Proof of Work (no PoS, no authority chains)</td></tr>
<tr><td>Market</td><td>Listed on at least one exchange</td></tr>
<tr><td>Verification</td><td>Public chain RPC blockle.biz can verify blocks against</td></tr>
<tr><td>Difficulty</td><td>Real network difficulty above the assigned floor</td></tr>
</table>
<p class="sub">Listing review fee: <span class="mono">$1,000</span> for mainstream forks (bitcoind-family with standard RPC) · <span class="mono">$2,000</span> for custom deployments and novel chains (includes adapter review). Founding chains above are grandfathered. The fee covers review and monitoring integration — it does not purchase legitimacy, and it never waives the technical requirements. Listed-via-fee chains are labeled <span class="badge">paid</span>.</p>
<h2>Recent claims</h2>
<table><tr><th>Pool</th><th>Chain</th><th>Height</th><th>Hash</th><th>Status</th><th>Detail</th></tr>{claim_rows}</table>
<p><a href="/api/pob">JSON →</a> · <a href="/api/pob/settlement-batch">settlement batch export →</a></p>"#,
        conf = POB_MIN_CONFIRMATIONS,
        minted = p["totals"]["block_minted"].as_str().unwrap_or("0").to_string(),
        pending = p["totals"]["claims_pending"],
        rejected = p["totals"]["claims_rejected"],
        n = reg.whitelist.len(),
    );
    page_shell("Proof of Blocks", body)
}

fn page_explorer(reg: &Registry) -> String {
    let ex = explorer_json(reg);
    let card = |k: &str, v: String| format!(r#"<div class="card"><div class="v">{v}</div><div class="k">{k}</div></div>"#);
    let chain_rows: String = ex["emission_by_chain"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                r#"<tr><td><a href="/chain/{chain}">{chain}</a></td><td>{algo}</td><td class="mono">{blocks}</td><td class="mono">{minted}</td><td class="mono">{share:.1}%</td><td class="mono">{diff:.3e}</td></tr>"#,
                chain = c["chain"].as_str().unwrap_or("?"),
                algo = c["algorithm"].as_str().unwrap_or("?"),
                blocks = c["blocks_credited"],
                minted = c["block_minted"].as_str().unwrap_or("0"),
                share = c["share_of_emission"].as_f64().unwrap_or(0.0) * 100.0,
                diff = c["max_block_difficulty"].as_f64().unwrap_or(0.0),
            )
        })
        .collect();
    let algo_rows: String = ex["emission_by_algorithm"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            format!(
                r#"<tr><td class="mono">{}</td><td class="mono">{}</td><td class="mono">{}</td></tr>"#,
                a["algorithm"].as_str().unwrap_or("?"),
                a["blocks_credited"],
                a["block_minted"].as_str().unwrap_or("0"),
            )
        })
        .collect();
    let tx_rows: String = reg
        .pob_claims
        .iter()
        .rev()
        .filter(|c| c.status == ClaimStatus::Credited)
        .take(40)
        .map(|c| {
            let addr = reg
                .pools
                .get(&c.pool_id)
                .map(|p| p.payout_address.clone())
                .unwrap_or_default();
            format!(
                r#"<tr><td>{when}</td><td><span class="badge">MINT</span></td><td>{chain} #{height}</td><td class="mono"><a href="/explorer/mint/{hash}">{hash_short}…</a></td><td class="mono">{diff:.2e}</td><td class="mono">+{amt}</td><td class="mono">{addr}</td></tr>"#,
                when = ago(c.reported_at),
                chain = c.chain,
                height = c.height,
                hash = c.hash,
                hash_short = &c.hash[..16.min(c.hash.len())],
                diff = c.difficulty,
                amt = fmt_block(c.credits),
                addr = if addr.is_empty() { format!("pool:{}", c.pool_id) } else { addr },
            )
        })
        .collect();
    let settlements: String = {
        let b = settlement_batch_json(reg);
        let pending: String = b["epochs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                format!(
                    r#"<tr><td class="mono">epoch {}</td><td><span class="badge">SETTLEMENT</span></td><td colspan="3" class="mono">{} BLOCK</td><td>pending on-chain execution</td><td></td></tr>"#,
                    e["epoch"], e["total_block"].as_str().unwrap_or("0")
                )
            })
            .collect();
        let done: String = b["settled"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                format!(
                    r#"<tr><td class="mono">epoch {}</td><td><span class="badge">SETTLED ✓</span></td><td colspan="3" class="mono">{} BLOCK</td><td class="mono">tx {}…</td><td></td></tr>"#,
                    e["epoch"],
                    e["total_block"].as_str().unwrap_or("0"),
                    &e["txid"].as_str().unwrap_or("")[..16.min(e["txid"].as_str().unwrap_or("").len())]
                )
            })
            .collect();
        format!("{pending}{done}")
    };
    let body = format!(
        r#"<h1>BLOCK Explorer</h1>
<p class="sub">BLOCK's ledger is currently the <strong>emission ledger</strong>: every transaction is a mint from an independently verified source-chain block, with the full emission math preserved. Transfer transactions activate with on-chain settlement to the BLOCK chain.</p>
<div class="cards">{c1}{c2}{c3}</div>
<h2>Emission by source coin</h2>
<table><tr><th>Coin</th><th>Algorithm</th><th>Blocks credited</th><th>BLOCK minted</th><th>Share</th><th>Max block difficulty</th></tr>{chain_rows}</table>
<h2>Emission by algorithm</h2>
<table><tr><th>Algorithm</th><th>Blocks credited</th><th>BLOCK minted</th></tr>{algo_rows}</table>
<h2>BLOCK transactions</h2>
<table><tr><th>When</th><th>Type</th><th>Source block</th><th>Hash</th><th>Difficulty</th><th>BLOCK</th><th>To</th></tr>{tx_rows}{settlements}</table>
{empty}
<p><a href="/api/explorer">JSON →</a> · <a href="/api/explorer/mints">mint feed →</a></p>"#,
        c1 = card("BLOCK minted", ex["totals"]["block_minted"].as_str().unwrap_or("0").to_string()),
        c2 = card("Mint events", ex["totals"]["mint_events"].to_string()),
        c3 = card("Source coins", ex["totals"]["source_chains"].to_string()),
        empty = if reg.pob_claims.iter().all(|c| c.status != ClaimStatus::Credited) {
            r#"<p class="sub">No mints yet — they appear as registered pools' blocks pass verification.</p>"#
        } else {
            ""
        },
    );
    page_shell("Explorer", body)
}

fn page_mint(reg: &Registry, c: &PobClaim) -> String {
    let m = mint_json(reg, c);
    let body = format!(
        r#"<h1>Mint <span class="badge">pending settlement</span></h1>
<p class="sub mono">{hash}</p>
<h2>Source block</h2>
<table>
<tr><td>Coin</td><td><a href="/chain/{chain}">{chain}</a></td></tr>
<tr><td>Height</td><td class="mono">{height}</td></tr>
<tr><td>Block hash</td><td class="mono">{hash}</td></tr>
<tr><td>Verified difficulty</td><td class="mono">{diff:.6e}</td></tr>
<tr><td>Confirmations at credit</td><td class="mono">{conf}</td></tr>
</table>
<h2>Emission</h2>
<p class="mono" style="font-size:1.05rem">{formula}</p>
<table>
<tr><td>Algorithm weight used</td><td class="mono">{weight:.6e} base units / difficulty unit</td></tr>
<tr><td>Minted</td><td class="mono">{amt} BLOCK ({base} base units)</td></tr>
</table>
<h2>Recipient</h2>
<table>
<tr><td>Pool</td><td><a href="/pool/{pool}">{pool}</a></td></tr>
<tr><td>Payout address</td><td class="mono">{addr}</td></tr>
<tr><td>Settlement epoch</td><td class="mono">{epoch}</td></tr>
<tr><td>Settlement</td><td class="mono">{settled}</td></tr>
</table>
<p><a href="/explorer">← explorer</a> · <a href="/api/explorer/mint/{hash}">JSON →</a></p>"#,
        hash = c.hash,
        chain = c.chain,
        height = c.height,
        diff = c.difficulty,
        conf = c.confirmations,
        formula = m["emission"]["formula"].as_str().unwrap_or(""),
        weight = c.algo_weight_used,
        amt = fmt_block(c.credits),
        base = c.credits,
        pool = c.pool_id,
        addr = m["recipient"]["payout_address"].as_str().unwrap_or(""),
        epoch = c.epoch,
        settled = if c.settled_txid.is_empty() {
            "pending".to_string()
        } else {
            format!("settled on the BLOCK chain · tx {}", c.settled_txid)
        },
    );
    page_shell("Mint", body)
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
GET  /api/pob            Proof-of-Blocks state (whitelist, weights, claims)
GET  /api/pob/settlement-batch   per-epoch settlement export
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
<tr><td>Roadmap</td><td>adapter SDK, more stratum dialects (Equihash, Ethash, RandomX), on-chain Proof-of-Blocks settlement, Blockle Cloud</td></tr>
</table>
<p class="note">The repository link is a configurable placeholder until the official repo is published (--github flag).</p>"#,
        github = reg.github
    );
    page_shell("Open Source", body)
}
