//! Chain interrogation: connect to an unknown node's RPC and figure out how
//! to mine it.
//!
//! Three layers, so novel chains degrade gracefully instead of failing:
//!
//! 1. **Dialect census** — try the signature methods of each RPC family
//!    (bitcoind, ethereum, monero) and record exactly what answered.
//! 2. **Template introspection** — fetch the block template and map its
//!    actual JSON onto a normalized schema by field-name synonyms *and*
//!    value shape (64-hex ⇒ hash, 8-hex ⇒ compact bits, integer named
//!    `*height*` ⇒ height, …). Renamed fields on forks are handled here,
//!    producing a concrete [`FieldMap`] the generic adapter executes.
//! 3. **Algorithm fingerprinting** — subversion strings, solutions-vs-hashes
//!    rate fields, seed hashes, work-array shapes, nonce ranges.
//!
//! Everything lands in a [`ChainProfile`] with per-finding confidence; what
//! can't be inferred is listed explicitly and pre-stubbed by
//! `inspect --generate-adapter`.

use std::fmt;

use serde_json::{json, Value};

use crate::adapters::bitcoin::FieldMap;
use crate::rpc::{RpcClient, RpcOutcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    BitcoindLike,
    EthereumLike,
    MoneroLike,
    Unknown,
}

impl fmt::Display for Dialect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Dialect::BitcoindLike => "bitcoind-style JSON-RPC",
            Dialect::EthereumLike => "ethereum-style JSON-RPC",
            Dialect::MoneroLike => "monero-style JSON-RPC",
            Dialect::Unknown => "unknown",
        };
        write!(f, "{s}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Sha256d,
    Equihash,
    RandomX,
    Ethash,
    Scrypt,
    Unknown,
}

impl fmt::Display for Algorithm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Algorithm::Sha256d => "SHA-256d",
            Algorithm::Equihash => "Equihash",
            Algorithm::RandomX => "RandomX",
            Algorithm::Ethash => "Ethash",
            Algorithm::Scrypt => "Scrypt",
            Algorithm::Unknown => "unknown",
        };
        write!(f, "{s}")
    }
}

pub struct ChainProfile {
    pub rpc_url: String,
    pub dialect: Dialect,
    pub chain: Option<String>,
    pub subversion: Option<String>,
    pub height: Option<u64>,
    pub difficulty: Option<f64>,
    pub reward: Option<u64>,
    pub algorithm: Algorithm,
    pub algorithm_hints: Vec<String>,
    pub template_method: Option<String>,
    pub submit_method: Option<String>,
    pub field_map: Option<FieldMap>,
    pub template_sample: Option<Value>,
    pub unknowns: Vec<String>,
    pub confidence: u32,
}

/// Is this a plausible pool target with the built-in bitcoin-family adapter?
impl ChainProfile {
    pub fn ready_for_builtin_adapter(&self) -> bool {
        self.dialect == Dialect::BitcoindLike
            && self.algorithm == Algorithm::Sha256d
            && self.field_map.is_some()
            && self.submit_method.is_some()
    }
}

fn is_hex_of_len(v: &Value, len: usize) -> bool {
    v.as_str()
        .map(|s| s.len() == len && s.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or(false)
}

/// Find a field by synonym list, falling back to shape + name-fragment.
fn find_field(obj: &Value, synonyms: &[&str], fragment: &str, shape: impl Fn(&Value) -> bool) -> Option<String> {
    let map = obj.as_object()?;
    for s in synonyms {
        if let Some(v) = map.get(*s) {
            if shape(v) {
                return Some((*s).to_string());
            }
        }
    }
    for (k, v) in map {
        if k.to_lowercase().contains(fragment) && shape(v) {
            return Some(k.clone());
        }
    }
    None
}

pub fn probe(rpc_url: &str) -> ChainProfile {
    let rpc = RpcClient::new(rpc_url);
    let mut p = ChainProfile {
        rpc_url: rpc_url.to_string(),
        dialect: Dialect::Unknown,
        chain: None,
        subversion: None,
        height: None,
        difficulty: None,
        reward: None,
        algorithm: Algorithm::Unknown,
        algorithm_hints: Vec::new(),
        template_method: None,
        submit_method: None,
        field_map: None,
        template_sample: None,
        unknowns: Vec::new(),
        confidence: 0,
    };

    // ---- layer 1: dialect census ----
    if let RpcOutcome::Ok(info) = rpc.call("getblockchaininfo", json!([])) {
        p.dialect = Dialect::BitcoindLike;
        p.chain = info.get("chain").and_then(|v| v.as_str()).map(String::from);
        p.height = info.get("blocks").and_then(|v| v.as_u64());
        p.difficulty = info.get("difficulty").and_then(|v| v.as_f64());
    } else if let RpcOutcome::Ok(v) = rpc.call("eth_blockNumber", json!([])) {
        p.dialect = Dialect::EthereumLike;
        p.height = v
            .as_str()
            .and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok());
        if let RpcOutcome::Ok(id) = rpc.call("eth_chainId", json!([])) {
            p.chain = id.as_str().map(String::from);
        }
        if let RpcOutcome::Ok(work) = rpc.call("eth_getWork", json!([])) {
            if work.as_array().map(|a| a.len() >= 3).unwrap_or(false) {
                p.algorithm = Algorithm::Ethash;
                p.algorithm_hints.push("eth_getWork returns a 3-hash work array".into());
                p.template_method = Some("eth_getWork".into());
                p.submit_method = Some("eth_submitWork".into());
            }
        }
    } else if let RpcOutcome::Ok(info) = rpc.call("get_info", json!({})) {
        p.dialect = Dialect::MoneroLike;
        p.height = info.get("height").and_then(|v| v.as_u64());
        p.algorithm = Algorithm::RandomX;
        p.algorithm_hints.push("monero-style get_info".into());
        p.template_method = Some("get_block_template".into());
        p.submit_method = Some("submit_block".into());
    }

    if p.dialect == Dialect::Unknown {
        p.unknowns.push("RPC dialect not recognized (tried bitcoind, ethereum, monero signatures)".into());
        return p;
    }
    p.confidence = 25;

    if p.dialect != Dialect::BitcoindLike {
        p.unknowns
            .push("built-in pool engine currently speaks bitcoind-family work; adapter stub required".into());
        p.confidence += 25;
        return p;
    }

    // ---- bitcoind family: deeper census ----
    if let RpcOutcome::Ok(info) = rpc.call("getnetworkinfo", json!([])) {
        p.subversion = info.get("subversion").and_then(|v| v.as_str()).map(String::from);
    }
    let mining_info = match rpc.call("getmininginfo", json!([])) {
        RpcOutcome::Ok(v) => Some(v),
        _ => None,
    };

    // ---- layer 2: template introspection ----
    let template = [json!([{ "rules": ["segwit"] }]), json!([{}]), json!([])]
        .iter()
        .find_map(|params| match rpc.call("getblocktemplate", params.clone()) {
            RpcOutcome::Ok(v) if v.is_object() => Some(v),
            _ => None,
        });
    let Some(tpl) = template else {
        p.unknowns.push("getblocktemplate unavailable — template method unknown".into());
        return p;
    };
    p.template_method = Some("getblocktemplate".into());
    p.confidence += 20;

    let hex64 = |v: &Value| is_hex_of_len(v, 64);
    let is_int = |v: &Value| v.is_u64();
    let bits_shape = |v: &Value| is_hex_of_len(v, 8);

    let mut map = FieldMap::default();
    let mut mapped = true;
    match find_field(&tpl, &["previousblockhash", "previous_block_hash", "prevhash", "prev_hash"], "prev", hex64) {
        Some(f) => map.prev_hash = f,
        None => {
            mapped = false;
            p.unknowns.push("could not locate previous-block-hash field in template".into());
        }
    }
    match find_field(&tpl, &["height", "block_height"], "height", is_int) {
        Some(f) => map.height = f,
        None => {
            mapped = false;
            p.unknowns.push("could not locate height field in template".into());
        }
    }
    match find_field(&tpl, &["bits", "nbits"], "bits", bits_shape) {
        Some(f) => map.bits = f,
        None => {
            mapped = false;
            p.unknowns.push("could not locate compact-bits field in template".into());
        }
    }
    if let Some(f) = find_field(&tpl, &["curtime", "current_time", "time", "mintime"], "time", is_int) {
        map.curtime = f;
    }
    if let Some(f) = find_field(&tpl, &["version"], "version", is_int) {
        map.version = f;
    }
    match find_field(
        &tpl,
        &["coinbasevalue", "coinbase_value", "reward", "blockreward", "subsidy"],
        "reward",
        is_int,
    ) {
        Some(f) => {
            p.reward = tpl.get(&f).and_then(|v| v.as_u64());
            map.coinbase_value = f;
        }
        None => p.unknowns.push("block reward not visible in template (payouts need manual config)".into()),
    }
    if let Some(f) = find_field(&tpl, &["transactions", "txs"], "transaction", |v| v.is_array()) {
        map.transactions = f;
    }
    if mapped {
        p.field_map = Some(map);
        p.confidence += 15;
    }
    p.height = p.height.or_else(|| {
        p.field_map
            .as_ref()
            .and_then(|m| tpl.get(&m.height))
            .and_then(|v| v.as_u64())
            .map(|h| h.saturating_sub(1))
    });

    // submission method
    for m in ["submitblock", "submit_block", "submitwork"] {
        match rpc.call(m, json!([])) {
            RpcOutcome::MethodNotFound => continue,
            // Exists (it errored about params / deserialization, not absence).
            _ => {
                p.submit_method = Some(m.to_string());
                break;
            }
        }
    }
    if p.submit_method.is_some() {
        p.confidence += 15;
    } else {
        p.unknowns.push("no block submission method responded".into());
    }

    // ---- layer 3: algorithm fingerprinting ----
    let mut algo = Algorithm::Unknown;
    if let Some(sub) = &p.subversion {
        let s = sub.to_lowercase();
        if s.contains("satoshi") {
            algo = Algorithm::Sha256d;
            p.algorithm_hints.push(format!("subversion {sub:?} (Satoshi lineage)"));
        } else if s.contains("magicbean") || s.contains("zcash") {
            algo = Algorithm::Equihash;
            p.algorithm_hints.push(format!("subversion {sub:?} (Zcash lineage)"));
        } else if s.contains("litecoin") {
            algo = Algorithm::Scrypt;
            p.algorithm_hints.push(format!("subversion {sub:?}"));
        }
    }
    if let Some(mi) = &mining_info {
        if mi.get("networksolps").is_some() {
            algo = Algorithm::Equihash;
            p.algorithm_hints.push("getmininginfo reports solutions/s (Equihash family)".into());
        } else if mi.get("networkhashps").is_some() && algo == Algorithm::Unknown {
            algo = Algorithm::Sha256d;
            p.algorithm_hints.push("getmininginfo reports hashes/s".into());
        }
    }
    if tpl.get("seed_hash").is_some() || tpl.get("seedhash").is_some() {
        algo = Algorithm::RandomX;
        p.algorithm_hints.push("template carries a seed hash (RandomX family)".into());
    }
    if tpl.get("solution").is_some() || tpl.get("equihash").is_some() {
        algo = Algorithm::Equihash;
        p.algorithm_hints.push("template carries an Equihash solution field".into());
    }
    if let Some(algo_field) = tpl.get("algo").or_else(|| tpl.get("algorithm")).and_then(|v| v.as_str()) {
        p.algorithm_hints.push(format!("template declares algorithm {algo_field:?}"));
        algo = match algo_field.to_lowercase().as_str() {
            "sha256" | "sha256d" => Algorithm::Sha256d,
            "scrypt" => Algorithm::Scrypt,
            "equihash" => Algorithm::Equihash,
            "randomx" => Algorithm::RandomX,
            "ethash" => Algorithm::Ethash,
            _ => Algorithm::Unknown,
        };
    }
    if algo == Algorithm::Unknown {
        // A bitcoind-shaped template with 8-hex bits and no contrary hints is
        // overwhelmingly sha256d-family; say so but at reduced confidence.
        algo = Algorithm::Sha256d;
        p.algorithm_hints.push("defaulted from bitcoind-shaped template (verify!)".into());
        p.unknowns.push("PoW algorithm inferred, not confirmed — mine a test block before going live".into());
        p.confidence += 10;
    } else {
        p.confidence += 25;
    }
    p.algorithm = algo;
    p.template_sample = Some(tpl);
    p.confidence = p.confidence.min(100);
    p
}

impl ChainProfile {
    /// Machine-readable profile (used by `inspect --json` and the Python
    /// wrapper).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "rpc_url": self.rpc_url,
            "dialect": self.dialect.to_string(),
            "chain": self.chain,
            "subversion": self.subversion,
            "height": self.height,
            "difficulty": self.difficulty,
            "reward": self.reward,
            "algorithm": self.algorithm.to_string(),
            "algorithm_hints": self.algorithm_hints,
            "template_method": self.template_method,
            "submit_method": self.submit_method,
            "field_map": self.field_map.as_ref().map(|m| serde_json::to_value(m).unwrap()),
            "unknowns": self.unknowns,
            "confidence": self.confidence,
            "ready_for_builtin_adapter": self.ready_for_builtin_adapter(),
        })
    }
}

/// Render the interrogation checklist.
pub fn print_checklist(p: &ChainProfile, name: &str) {
    println!("Analyzing {name}...");
    let mark = |ok: bool| if ok { "✓" } else { "✗" };
    println!("{} RPC connection", mark(p.dialect != Dialect::Unknown));
    println!(
        "{} Chain detected{}",
        mark(p.dialect != Dialect::Unknown),
        match (&p.chain, &p.subversion) {
            (Some(c), Some(s)) => format!(" ({c}, {s})"),
            (Some(c), None) => format!(" ({c})"),
            _ => format!(" ({})", p.dialect),
        }
    );
    match p.height {
        Some(h) => println!("✓ Current block: {h}"),
        None => println!("✗ Current block"),
    }
    println!("{} Block template detected{}", mark(p.template_method.is_some()),
        p.template_method.as_deref().map(|m| format!(" ({m})")).unwrap_or_default());
    match p.difficulty {
        Some(d) => println!("✓ Difficulty detected ({d:.3e})"),
        None => println!("✗ Difficulty detected"),
    }
    match p.reward {
        Some(r) => println!("✓ Reward detected ({} base units)", r),
        None => println!("⚠ Reward not visible"),
    }
    println!("{} Template field mapping", mark(p.field_map.is_some()));
    println!(
        "{} PoW algorithm: {}{}",
        if p.algorithm == Algorithm::Unknown { "✗" } else { "✓" },
        p.algorithm,
        if p.algorithm_hints.is_empty() {
            String::new()
        } else {
            format!("  [{}]", p.algorithm_hints.join("; "))
        }
    );
    println!(
        "{} Block submission method{}",
        mark(p.submit_method.is_some()),
        p.submit_method.as_deref().map(|m| format!(" ({m})")).unwrap_or_default()
    );
    for u in &p.unknowns {
        println!("⚠ {u}");
    }
    println!("Confidence: {}%", p.confidence);
}
