//! `blockle discover` — scan a chain's source repository (local path or git
//! URL) for mining-relevant parameters: algorithm, RPC methods, ports,
//! rewards, block timing. Pure text analysis; nothing from the repo is
//! executed.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Result};

const MAX_FILE_BYTES: u64 = 512 * 1024;
const SCAN_EXTS: &[&str] = &[
    "rs", "c", "cc", "cpp", "h", "hpp", "py", "go", "js", "ts", "md", "conf", "cfg", "toml",
    "json", "yaml", "yml",
];

pub struct Finding {
    pub what: String,
    pub evidence: String,
}

pub struct DiscoverReport {
    pub algorithm: Option<String>,
    pub findings: Vec<Finding>,
    pub confidence: u32,
    /// Concrete RPC port numbers captured from the source.
    pub rpc_ports: Vec<u16>,
}

/// Clone (shallow) if `source` looks like a URL, else use it as a path.
pub fn obtain_source(source: &str, scratch: &Path) -> Result<PathBuf> {
    if source.starts_with("http://") || source.starts_with("https://") || source.starts_with("git@")
    {
        let dest = scratch.join("blockle-discover");
        let _ = fs::remove_dir_all(&dest);
        let status = Command::new("git")
            .args(["clone", "--depth", "1", source])
            .arg(&dest)
            .status()
            .map_err(|e| anyhow!("git not available: {e}"))?;
        if !status.success() {
            bail!("git clone of {source} failed");
        }
        Ok(dest)
    } else {
        let p = PathBuf::from(source);
        if !p.exists() {
            bail!("{source} is neither a URL nor an existing path");
        }
        Ok(p)
    }
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "target" || name == "node_modules" || name == "depends"
        {
            continue;
        }
        if path.is_dir() {
            walk(&path, files);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| SCAN_EXTS.contains(&e))
            .unwrap_or(false)
        {
            files.push(path);
        }
    }
}

pub fn discover(root: &Path) -> DiscoverReport {
    let mut files = Vec::new();
    walk(root, &mut files);

    // (algorithm label, signatures)
    let algo_sigs: &[(&str, &[&str])] = &[
        ("Equihash", &["equihash", "EquihashSolver", "ZcashPoW", "n_solution", "nSolution"]),
        ("RandomX", &["randomx", "RandomX", "rx_slow_hash"]),
        ("Scrypt", &["scrypt_1024_1_1_256", "scrypt("]),
        ("Ethash", &["ethash", "hashimoto"]),
        ("KawPow/ProgPoW", &["kawpow", "progpow"]),
        ("SHA-256d", &["sha256d", "CHash256", "double-sha256", "Hash(pbegin"]),
        ("Yespower", &["yespower"]),
        ("Autolykos", &["autolykos"]),
    ];
    let param_sigs: &[(&str, &[&str])] = &[
        ("getblocktemplate RPC", &["getblocktemplate"]),
        ("submitblock RPC", &["submitblock"]),
        ("ethereum work RPC", &["eth_getWork"]),
        ("monero template RPC", &["get_block_template"]),
        ("stratum support", &["stratum"]),
        ("block subsidy logic", &["GetBlockSubsidy", "block_subsidy", "nSubsidy", "blockreward"]),
        ("target spacing", &["nPowTargetSpacing", "target_spacing", "BLOCK_TIME", "block_interval"]),
        ("genesis construction", &["CreateGenesisBlock", "genesis_block", "genesis.json"]),
        ("default RPC port", &["rpcport", "nRPCPort", "DEFAULT_RPC_PORT", "rpc_port"]),
        ("default P2P port", &["nDefaultPort", "DEFAULT_P2P_PORT", "p2p_port"]),
        ("difficulty adjustment", &["LWMA", "GetNextWorkRequired", "DarkGravity", "difficulty_adjust"]),
        ("halving schedule", &["halving", "nSubsidyHalvingInterval"]),
    ];

    let mut algo_scores: Vec<(usize, &str, String)> = Vec::new();
    let mut findings = Vec::new();
    let mut matched_params = 0;
    let mut rpc_ports: Vec<u16> = Vec::new();
    let port_re = regex_lite(&["rpcport", "RPCPort", "rpc_port", "RPC_PORT"]);

    let mut algo_hits: std::collections::HashMap<&str, (usize, String)> =
        std::collections::HashMap::new();
    let mut param_hits: std::collections::HashMap<&str, (usize, String)> =
        std::collections::HashMap::new();

    for file in &files {
        let Ok(meta) = fs::metadata(file) else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(file) else { continue };
        let rel = file.strip_prefix(root).unwrap_or(file).display().to_string();
        for (label, sigs) in algo_sigs {
            for sig in *sigs {
                if content.contains(sig) {
                    let entry = algo_hits.entry(label).or_insert((0, rel.clone()));
                    entry.0 += content.matches(sig).count();
                }
            }
        }
        for (label, sigs) in param_sigs {
            for sig in *sigs {
                if content.contains(sig) {
                    param_hits.entry(label).or_insert((0, format!("{sig:?} in {rel}"))).0 += 1;
                }
            }
        }
        for port in port_re(&content) {
            if !rpc_ports.contains(&port) && port > 1024 {
                rpc_ports.push(port);
            }
        }
    }

    for (label, (count, first)) in &algo_hits {
        algo_scores.push((*count, label, first.clone()));
    }
    algo_scores.sort_by(|a, b| b.0.cmp(&a.0));
    let algorithm = algo_scores.first().map(|(count, label, file)| {
        findings.push(Finding {
            what: format!("Algorithm: {label}"),
            evidence: format!("{count} signature hit(s), e.g. {file}"),
        });
        label.to_string()
    });
    for (label, (count, evidence)) in &param_hits {
        matched_params += 1;
        findings.push(Finding {
            what: label.to_string(),
            evidence: format!("{count} file(s), e.g. {evidence}"),
        });
    }

    let mut confidence = 0u32;
    if algorithm.is_some() {
        confidence += 40;
    }
    confidence += (matched_params as u32 * 6).min(50);
    if files.is_empty() {
        confidence = 0;
    }
    rpc_ports.truncate(5);
    if !rpc_ports.is_empty() {
        findings.push(Finding {
            what: format!("RPC port candidates: {rpc_ports:?}"),
            evidence: "numeric literals near rpcport identifiers".into(),
        });
    }
    DiscoverReport { algorithm, findings, confidence: confidence.min(96), rpc_ports }
}

/// Tiny regex-free matcher: find numbers within 40 chars after any of the
/// given markers.
fn regex_lite(markers: &'static [&'static str]) -> impl Fn(&str) -> Vec<u16> {
    move |content: &str| {
        let mut out = Vec::new();
        for marker in markers {
            for (pos, _) in content.match_indices(marker) {
                let window = &content[pos..(pos + 40).min(content.len())];
                let digits: String = window
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(n) = digits.parse::<u16>() {
                    out.push(n);
                }
            }
        }
        out
    }
}
