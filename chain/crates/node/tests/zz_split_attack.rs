//! ADVERSARIAL: try to make the bounded reorg path adopt a different chain, or
//! compute different state, than `Chain::from_blocks` would.
//!
//! Unlike `tests/reorg.rs`, these chains are MULTI-LANE and run ABOVE
//! `cross_algo_activation_height`, so the energy-weighted fork-choice metric
//! and the coupled retarget are the enforced rules.

use std::sync::Arc;

use blockle_chain::{build_template, mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{auxpow, sha256d, AuxPow, Block};
use blockle_node::{p2p, storage};
use blockle_pow::difficulty::{compact_to_target, hash_meets_target};
use blockle_pow::parent;

/// Coupling active from block 8 so nearly the whole chain — and every fork —
/// sits above the activation height.
const ACT: u64 = 8;
/// Lane cadence. Any value >= 6 * target_spacing pins the coupled base at
/// pow_limit, which is what keeps the grind affordable.
const SPACING: i64 = 9;

fn params() -> ChainParams {
    ChainParams { cross_algo_activation_height: ACT, ..ChainParams::regtest() }
}

fn aux_block_at(chain: &Chain, addr: [u8; 32], lane: &str, time: i64) -> Block {
    let (mut block, _) = build_template(chain, addr, &[]).expect("template");
    block.header.time = time as u32;
    block.header.bits = chain.next_bits_for_at(lane, time);
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];

    let mut cb = b"blockle split attack parent coinbase ".to_vec();
    cb.extend(auxpow::mm_commitment(&block.header.hash(), 1, 0));
    let bits = block.header.bits;
    let limit = compact_to_target(bits).expect("valid bits");
    let mut parent_hdr = vec![0u8; 80];
    parent_hdr[0] = 4;
    parent_hdr[36..68].copy_from_slice(&sha256d(&cb));
    let mut found = false;
    for n in 0u32.. {
        parent_hdr[76..80].copy_from_slice(&n.to_le_bytes());
        let h = parent::pow_hash(lane, &parent_hdr).expect("known lane");
        if hash_meets_target(&h, bits, limit) {
            found = true;
            break;
        }
    }
    assert!(found, "grind for lane {lane} did not terminate");
    block.aux_pow = Some(AuxPow {
        parent_algo: lane.into(),
        parent_header: parent_hdr,
        parent_coinbase: cb,
        coinbase_branch: vec![],
        chain_branch: vec![],
        chain_index: 0,
    });
    block
}

/// Lane for block `i` under mix `m`. Different mixes give chains of the same
/// LENGTH but different energy-weighted WORK, which is what makes the
/// weighted fork choice the thing being tested.
fn lane_for(i: usize, m: usize) -> &'static str {
    match m {
        // sha256d-heavy with a periodic x11.
        0 => {
            if i % 4 == 0 {
                "x11"
            } else {
                "sha256d"
            }
        }
        // x11-heavy: much more energy-weighted work per block.
        1 => {
            if i % 5 == 0 {
                "sha256d"
            } else {
                "x11"
            }
        }
        _ => "sha256d",
    }
}

fn grow(len: usize, addr: [u8; 32], mix: usize) -> (Chain, i64) {
    let mut chain = Chain::new(params());
    let (genesis, _) = mine_block(&chain, addr, &[]).expect("genesis");
    let t0 = genesis.header.time as i64;
    chain.connect_block(genesis).expect("genesis connects");
    for i in 1..len {
        let b = aux_block_at(&chain, addr, lane_for(i, mix), t0 + i as i64 * SPACING);
        chain.connect_block(b).unwrap_or_else(|e| panic!("block {i}: {e}"));
    }
    (chain, t0)
}

fn node_with(tag: &str, len: usize) -> (std::path::PathBuf, Arc<p2p::Node>, i64) {
    let datadir = std::env::temp_dir().join(format!(
        "blockle-split-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&datadir);
    let addr = Keypair::generate().address();
    let (full, t0) = grow(len, addr, 0);

    let mut chain = Chain::new(params());
    let genesis = (*full.blocks[0]).clone();
    chain.connect_block(genesis.clone()).expect("genesis connects");
    storage::append_block(&datadir, &genesis).expect("write genesis");

    let node = p2p::Node::new(
        p2p::NodeConfig {
            datadir: datadir.clone(),
            params: params(),
            listen: "127.0.0.1:0".to_string(),
            connect: vec![],
            mine_to: None,
            local_mine: false,
            mine_blocks: None,
            mine_interval: None,
            pools: vec![],
            reorg_authority: false,
            selfcheck_reorg: false,
        },
        chain,
        vec![],
    );
    let rest: Vec<Block> = full.blocks[1..].iter().map(|b| (**b).clone()).collect();
    node.deliver_blocks_for_test(1, 1, rest);
    let (snap, _) = node.snapshot();
    assert_eq!(snap.blocks.len(), len);
    (datadir, node, t0)
}

/// `count` blocks replacing everything from `start`, built on the node's own
/// prefix with lane mix `mix`.
fn fork_at(node: &Arc<p2p::Node>, start: usize, count: usize, t0: i64, mix: usize) -> Vec<Block> {
    let (snap, _) = node.snapshot();
    let prefix: Vec<Arc<Block>> = snap.blocks[..start].to_vec();
    let mut branch = Chain::from_arc_blocks(snap.params.clone(), prefix).expect("prefix rebuilds");
    let other = Keypair::generate().address();
    let mut out = Vec::with_capacity(count);
    for j in 0..count {
        let b = aux_block_at(&branch, other, lane_for(start + j, mix), t0 + (start + j) as i64 * SPACING);
        branch.connect_block(b.clone()).expect("fork block connects");
        out.push(b);
    }
    out
}

/// The whole point: the node's chain must be byte-identical to what a
/// from-genesis rebuild over the same blocks produces.
fn assert_equals_from_genesis(node: &Arc<p2p::Node>, ctx: &str) {
    let (c, _) = node.snapshot();
    let blocks: Vec<Block> = c.blocks.iter().map(|b| (**b).clone()).collect();
    let reference = Chain::from_blocks(c.params.clone(), blocks).expect("rebuild");
    assert_eq!(c.tip_hash(), reference.tip_hash(), "{ctx}: tip");
    assert_eq!(c.total_work(), reference.total_work(), "{ctx}: total_work");
    assert_eq!(c.utxos.len(), reference.utxos.len(), "{ctx}: utxo count");
    assert_eq!(c.pools, reference.pools, "{ctx}: pools");
    assert_eq!(
        c.state_fingerprint(),
        reference.state_fingerprint(),
        "{ctx}: the node's state differs from a from-genesis rebuild of its own blocks"
    );
    // And the index the retarget is enforced against.
    for lane in c.lanes() {
        assert_eq!(
            c.next_bits_for(lane),
            c.next_bits_for_fullscan(lane),
            "{ctx}: lane_pos disagrees with a full scan for {lane}"
        );
        assert_eq!(
            c.next_bits_coupled(lane),
            c.next_bits_coupled_fullscan(lane),
            "{ctx}: coupled retarget disagrees with a full scan for {lane}"
        );
    }
}

fn assert_disk_matches_memory(datadir: &std::path::Path, node: &Arc<p2p::Node>, ctx: &str) {
    let (c, _) = node.snapshot();
    let on_disk = storage::load_chain(datadir, c.params.clone())
        .unwrap_or_else(|e| panic!("{ctx}: the chain on disk no longer validates: {e}"));
    assert_eq!(
        on_disk.state_fingerprint(),
        c.state_fingerprint(),
        "{ctx}: blocks.jsonl reloads to a different chain than the node holds in memory \
         (height {:?} vs {:?})",
        on_disk.height(),
        c.height()
    );
}

#[test]
fn weighted_fork_choice_reorgs_match_a_from_genesis_rebuild() {
    let (datadir, node, t0) = node_with("weighted", 120);
    assert_equals_from_genesis(&node, "before any reorg");
    assert_disk_matches_memory(&datadir, &node, "before any reorg");

    // Depths chosen to straddle the snapshot interval (32) in both directions.
    for (peer, depth) in [(2u64, 1usize), (3, 5), (4, 33), (5, 70)] {
        let (snap, _) = node.snapshot();
        let len = snap.blocks.len();
        let start = len - depth;
        // Same length, x11-heavy: strictly MORE energy-weighted work at the
        // same height, so this is adopted purely on the weighted metric.
        let fork = fork_at(&node, start, depth, t0, 1);
        let before = node.fork_depth_histogram().1;
        node.deliver_blocks_for_test(peer, start as u64, fork);
        let after = node.fork_depth_histogram().1;
        let (c, _) = node.snapshot();
        assert_eq!(c.blocks.len(), len, "depth {depth}: height should be unchanged");
        println!(
            "depth {depth}: deep-rebuilds {before} -> {after}, bounded={} ",
            before == after
        );
        assert_equals_from_genesis(&node, &format!("after a depth-{depth} weighted reorg"));
        assert_disk_matches_memory(&datadir, &node, &format!("after a depth-{depth} reorg"));
    }
    let _ = std::fs::remove_dir_all(&datadir);
}

#[test]
fn re_adding_previously_disconnected_blocks_matches_a_rebuild() {
    let (datadir, node, t0) = node_with("readd", 100);
    let (snap, _) = node.snapshot();
    let original: Vec<Block> = snap.blocks.iter().map(|b| (**b).clone()).collect();
    let len = original.len();

    // 1. Reorg away from the last 6 blocks onto a same-length heavier branch.
    let start = len - 6;
    let branch_b = fork_at(&node, start, 6, t0, 1);
    node.deliver_blocks_for_test(2, start as u64, branch_b);
    let (c, _) = node.snapshot();
    assert_ne!(
        c.tip_hash(),
        original[len - 1].header.hash(),
        "the first reorg did not actually switch branches"
    );
    assert_equals_from_genesis(&node, "after switching to branch B");

    // 2. Now re-add the ORIGINAL blocks, extended far enough to outweigh B.
    //    Every block in `original[start..]` was disconnected a moment ago.
    let mut branch_a = Chain::from_blocks(params(), original[..start].to_vec()).expect("prefix");
    let mut readd: Vec<Block> = Vec::new();
    for b in &original[start..] {
        branch_a.connect_block(b.clone()).expect("original block re-connects");
        readd.push(b.clone());
    }
    let extra = Keypair::generate().address();
    for j in 0..12usize {
        let h = len + j;
        let b = aux_block_at(&branch_a, extra, lane_for(h, 1), t0 + h as i64 * SPACING);
        branch_a.connect_block(b.clone()).expect("extension connects");
        readd.push(b);
    }
    node.deliver_blocks_for_test(3, start as u64, readd);
    let (c, _) = node.snapshot();
    assert_eq!(
        c.blocks[len - 1].header.hash(),
        original[len - 1].header.hash(),
        "the re-added original blocks were not adopted"
    );
    assert_equals_from_genesis(&node, "after re-adding the previously disconnected blocks");
    assert_disk_matches_memory(&datadir, &node, "after re-adding");
    let _ = std::fs::remove_dir_all(&datadir);
}

#[test]
fn a_fork_rooted_at_the_coupling_activation_height_matches_a_rebuild() {
    // The rule changes at ACT. A fork rooted exactly there replays the first
    // coupled block from a snapshot that was taken under the pre-coupling rule.
    let (datadir, node, t0) = node_with("activation", 60);
    for (peer, start) in [(2u64, ACT as usize - 1), (3, ACT as usize), (4, ACT as usize + 1)] {
        let (snap, _) = node.snapshot();
        let len = snap.blocks.len();
        let fork = fork_at(&node, start, len - start + 3, t0, 1);
        node.deliver_blocks_for_test(peer, start as u64, fork);
        assert_equals_from_genesis(&node, &format!("after a fork rooted at {start}"));
        assert_disk_matches_memory(&datadir, &node, &format!("after a fork rooted at {start}"));
    }
    let _ = std::fs::remove_dir_all(&datadir);
}

#[test]
fn many_successive_reorgs_keep_the_snapshot_ring_honest() {
    let (datadir, node, t0) = node_with("churn", 150);
    let mut peer = 2u64;
    for round in 0..14usize {
        let (snap, _) = node.snapshot();
        let len = snap.blocks.len();
        let depth = 1 + (round * 7) % 40;
        let start = len - depth;
        // Grow by one so each round is strictly heavier regardless of lanes.
        let fork = fork_at(&node, start, depth + 1, t0, round % 2);
        node.deliver_blocks_for_test(peer, start as u64, fork);
        peer += 1;
        assert_equals_from_genesis(&node, &format!("round {round} (depth {depth})"));
        assert_disk_matches_memory(&datadir, &node, &format!("round {round}"));
    }
    println!(
        "snapshots retained: {}, deep rebuilds: {}",
        node.snapshot_count(),
        node.fork_depth_histogram().1
    );
    let _ = std::fs::remove_dir_all(&datadir);
}
