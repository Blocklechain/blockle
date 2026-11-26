//! MEASUREMENT HARNESS (not shipped logic): the reorg path, before vs after.
//!
//! BEFORE = what `handle_blocks` used to do for every fork, however shallow:
//!   deep-copy `blocks[..start]`, then `Chain::from_blocks` over the whole lot
//!   — `connect_block` in a loop from genesis.
//!
//! AFTER = what the bounded path does: clone the newest retained snapshot
//!   (state maps only; block bodies are shared behind `Arc<Block>`), then
//!   `connect_block` forward over the blocks between the snapshot and the fork
//!   point, plus the fork itself.
//!
//! Both are measured against the SAME real mainnet blocks and at the same fork
//! depth, so the only thing varying is the mechanism. Usage:
//!   reorg_ab <blocks.jsonl> <height> [snap_interval] [fork_depth]

use std::sync::Arc;
use std::time::Instant;

use blockle_chain::{Chain, ChainParams};
use blockle_core::Block;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let height: usize = args[2].parse().expect("height");
    let snap_interval: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(32);
    let depth: usize = args.get(4).map(|s| s.parse().unwrap()).unwrap_or(1);

    let data = std::fs::read_to_string(path).expect("read blocks");
    let master: Vec<Arc<Block>> = data
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(height)
        .map(|l| Arc::new(serde_json::from_str(l).expect("parse block")))
        .collect();
    drop(data);
    assert!(master.len() >= height, "only {} blocks available", master.len());
    let params = ChainParams::mainnet();
    eprintln!("loaded {} real mainnet blocks", master.len());

    // The fork point a peer announcing a depth-`depth` fork would give us.
    let start = height - depth;

    // ---- BEFORE: from-genesis rebuild of prefix + fork ----
    let t = Instant::now();
    let prefix: Vec<Arc<Block>> = master[..start].to_vec();
    let clone_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let mut cand = Chain::from_arc_blocks(params.clone(), prefix).expect("prefix rebuilds");
    // The fork's own blocks. Using our own blocks here keeps the comparison
    // honest: both paths connect exactly the same number of blocks on top.
    for b in &master[start..] {
        cand.connect_block_arc(Arc::clone(b)).expect("connects");
    }
    let before_ms = t.elapsed().as_secs_f64() * 1000.0;
    let before_tip = cand.tip_hash();
    let before_fp = cand.state_fingerprint();

    // ---- AFTER: clone the newest snapshot at/below the fork point, replay forward ----
    // Build the chain once (this is the node's live chain, already validated)
    // and retain a snapshot the way `record_snapshot` does.
    let live = Chain::from_arc_blocks(params.clone(), master[..height].to_vec()).expect("live");
    let snap_at = (start / snap_interval) * snap_interval;
    let snapshot: Arc<Chain> = Arc::new(
        Chain::from_arc_blocks(params.clone(), master[..snap_at].to_vec()).expect("snapshot"),
    );
    assert_eq!(live.blocks.len(), height);

    let t = Instant::now();
    let mut cand2: Chain = (*snapshot).clone();
    let snap_clone_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    for b in &master[snap_at..] {
        cand2.connect_block_arc(Arc::clone(b)).expect("connects");
    }
    let after_ms = t.elapsed().as_secs_f64() * 1000.0;

    assert_eq!(cand2.tip_hash(), before_tip, "the two paths disagree on the tip");
    assert_eq!(
        cand2.state_fingerprint(),
        before_fp,
        "the two paths disagree on STATE — this is the chain-split case"
    );

    println!("height {height}, fork depth {depth}, snapshot interval {snap_interval}");
    println!("  snapshot chosen at height {snap_at} ({} blocks to replay)", height - snap_at);
    println!("  BEFORE  prefix clone {clone_ms:9.2} ms   rebuild {before_ms:10.2} ms   blocks connected {height}");
    println!("  AFTER   snap clone   {snap_clone_ms:9.2} ms   replay  {after_ms:10.2} ms   blocks connected {}", height - snap_at);
    println!("  speedup {:.0}x (rebuild+clone vs replay+clone)", (before_ms + clone_ms) / (after_ms + snap_clone_ms).max(0.0001));
    println!("  state fingerprints MATCH ({})", hex::encode(&before_fp[..8]));
}
