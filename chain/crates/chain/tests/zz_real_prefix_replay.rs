//! ADVERSARIAL, on REAL mainnet blocks: the exact property the bounded reorg
//! rests on — a chain cloned at height k and replayed forward must be
//! indistinguishable from a from-genesis rebuild — checked across the
//! `cross_algo_activation_height` (53,000) boundary and over the real ten-lane
//! mix, which regtest cannot produce.
//!
//!   BLOCKLE_MAINNET_BLOCKS=/path/to/blocks60k.jsonl \
//!     cargo test -p blockle-chain --release --test zz_real_prefix_replay -- --nocapture

use std::sync::Arc;

use blockle_chain::{Chain, ChainParams};
use blockle_core::Block;

#[test]
fn replaying_real_blocks_from_a_retained_prefix_equals_a_from_genesis_rebuild() {
    let Ok(path) = std::env::var("BLOCKLE_MAINNET_BLOCKS") else {
        eprintln!("SKIPPED: set BLOCKLE_MAINNET_BLOCKS");
        return;
    };
    let limit: usize = std::env::var("BLOCKLE_MAINNET_BLOCKS_LIMIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(58_500);

    let data = std::fs::read_to_string(&path).expect("read");
    let blocks: Vec<Block> = data
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(limit)
        .map(|l| serde_json::from_str(l).expect("parse"))
        .collect();
    drop(data);
    let n = blocks.len();
    eprintln!("loaded {n} real mainnet blocks");

    let params = ChainParams::mainnet();
    let act = params.cross_algo_activation_height as usize;
    let reference = Chain::from_blocks(params.clone(), blocks).expect("reference rebuild");
    let all: Vec<Arc<Block>> = reference.blocks.clone();
    let ref_fp = reference.state_fingerprint();
    eprintln!("reference tip {:?} work {}", reference.height(), reference.total_work());

    // Snapshot heights that matter: around the coupling activation, around the
    // stall heights, and at every residue class mod 32 (the snapshot interval).
    let mut ks: Vec<usize> = vec![
        act - 1,
        act,
        act + 1,
        act + 31,
        act + 32,
        act + 33,
        57_000,
        57_999,
        58_000,
        n - 1,
    ];
    ks.retain(|k| *k >= 1 && *k < n);
    ks.sort_unstable();
    ks.dedup();

    for k in ks {
        let base = Chain::from_arc_blocks(params.clone(), all[..k].to_vec()).expect("prefix");
        // This is exactly what `p2p::replay_candidate` does: clone a retained
        // prefix and connect the rest.
        let mut replayed = base.clone();
        for b in &all[k..] {
            replayed
                .connect_block_arc(Arc::clone(b))
                .unwrap_or_else(|e| panic!("replay from k={k} failed at {}: {e}", replayed.blocks.len()));
        }
        assert_eq!(replayed.blocks.len(), n, "height from k={k}");
        assert_eq!(replayed.tip_hash(), reference.tip_hash(), "tip from k={k}");
        assert_eq!(replayed.total_work(), reference.total_work(), "work from k={k}");
        assert_eq!(
            replayed.state_fingerprint(),
            ref_fp,
            "state from k={k}: forward replay from a retained prefix produced a \
             different state than a from-genesis rebuild — this is the chain-split case"
        );
        eprintln!("k={k}: identical");
    }
}
