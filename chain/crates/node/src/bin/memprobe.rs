//! Where the node's memory actually goes.
//!
//!     memprobe <blocks.jsonl> [max-blocks] [--every N]
//!
//! The running node holds 24.8 GB for a chain whose serialized form is 804 MB.
//! A 30× blowup is not struct overhead, so this connects real blocks one at a
//! time and reports, every N of them, both the process RSS and the size of
//! every collection `Chain` keeps. Whichever counter tracks the RSS curve is
//! the thing to fix — and the rest can then be left alone, which matters when
//! the alternative is rewriting storage on a live mining node.
//!
//! It is a diagnostic, not a product: it loads a prefix of the chain so the
//! measurement fits on a machine that is not the one with the problem.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use blockle_chain::Chain;
use blockle_core::Block;
use blockle_chain::ChainParams;

/// Resident set size in bytes, read from the OS rather than estimated.
#[cfg(target_os = "linux")]
fn rss_bytes() -> u64 {
    let s = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let pages: u64 = s.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    pages * 4096
}

#[cfg(target_os = "macos")]
fn rss_bytes() -> u64 {
    // No /proc. `ps` is enough for a diagnostic and avoids a mach dependency.
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
        .unwrap_or(0)
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path: PathBuf = match args.next() {
        Some(p) => p.into(),
        None => {
            eprintln!("usage: memprobe <blocks.jsonl> [max-blocks] [--every N]");
            std::process::exit(64);
        }
    };
    let rest: Vec<String> = args.collect();
    let max: usize = rest
        .iter()
        .find(|a| !a.starts_with("--"))
        .and_then(|a| a.parse().ok())
        .unwrap_or(usize::MAX);
    let every: usize = rest
        .iter()
        .position(|a| a == "--every")
        .and_then(|i| rest.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(2_500);

    let file = File::open(&path).unwrap_or_else(|e| {
        eprintln!("cannot read {}: {e}", path.display());
        std::process::exit(66);
    });

    let params = ChainParams::by_name("mainnet").expect("mainnet params");
    let mut chain = Chain::new(params);
    let base = rss_bytes();
    println!(
        "{:>7}  {:>9}  {:>9}  {:>10}  {:>8}  {:>8}  {:>8}  {:>7}",
        "height", "rss MB", "per blk", "utxos", "notes", "anchors", "nullif", "nfts"
    );

    let mut connected = 0usize;
    for line in BufReader::new(file).lines() {
        if connected >= max {
            break;
        }
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(e) => {
                eprintln!("read error after {connected} blocks: {e}");
                break;
            }
        };
        let block: Block = match serde_json::from_str(&line) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("block {connected} does not parse: {e}");
                break;
            }
        };
        if let Err(e) = chain.connect_block(block) {
            eprintln!("block {connected} rejected: {e:?}");
            break;
        }
        connected += 1;

        if connected % every == 0 {
            let rss = rss_bytes();
            let grown = rss.saturating_sub(base);
            println!(
                "{:>7}  {:>9.0}  {:>9.1}  {:>10}  {:>8}  {:>8}  {:>8}  {:>7}",
                connected,
                mb(rss),
                // The number that matters: if this is flat, memory scales with
                // the chain and the fix is storage. If it climbs, something is
                // accumulating faster than the chain grows.
                mb(grown) * 1024.0 / connected as f64,
                chain.utxos.len(),
                chain.note_leaves.len(),
                chain.note_anchors.len(),
                chain.nullifiers.len(),
                chain.nft_owner.len(),
            );
        }
    }

    let rss = rss_bytes();
    println!();
    println!("connected {connected} blocks");
    println!("  rss                {:.0} MB", mb(rss));
    println!("  per block          {:.1} KB", mb(rss.saturating_sub(base)) * 1024.0 / connected.max(1) as f64);
    println!("  blocks held        {}", chain.blocks.len());
    println!("  utxos              {}", chain.utxos.len());
    println!("  note leaves        {}", chain.note_leaves.len());
    println!("  note anchors       {}  <- one per block, by design", chain.note_anchors.len());
    println!("  nullifiers         {}", chain.nullifiers.len());
    println!("  nft owners         {}", chain.nft_owner.len());
    println!("  contracts          {}", chain.contracts.len());
    println!("  contract storage   {}", chain.contract_storage.len());
    println!("  amm pools          {}", chain.pools.pools.len());

    // The serialized weight of what is being held, for comparison with RSS.
    // A large gap between the two is the signal that the in-memory shape, not
    // the amount of data, is the problem.
    let serialized: usize = chain
        .blocks
        .iter()
        .map(|b| bincode::serialize(b).map(|v| v.len()).unwrap_or(0))
        .sum();
    println!("  blocks serialized  {:.0} MB", mb(serialized as u64));
    println!(
        "  inflation          {:.1}x",
        rss.saturating_sub(base) as f64 / serialized.max(1) as f64
    );
}
