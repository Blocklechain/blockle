//! ATTACK: the bounded reorg shares a validated prefix (a retained snapshot)
//! instead of rolling state back. Two questions:
//!
//!   1. Is the shared state actually valid for the fork point? (tested below:
//!      yes, including for forks that carry real spending transactions)
//!   2. Is the snapshot the design claims to be there, actually there?
//!
//! (2) is where this file lands a hit. `Node::record_snapshot` is called from
//! exactly two places: the headers-first BATCH path in `handle_blocks`, and
//! `adopt_candidate`. It is NOT called from `Node::submit_block`, which is the
//! single-block connect path — i.e. `Message::NewBlock` gossip (p2p.rs:711),
//! the local miner (p2p.rs:1554) and every stratum/pool submission
//! (pool.rs:488, stratum.rs:692, stratum_btc.rs:761). That is the STEADY-STATE
//! path of every caught-up node.
//!
//! So the ring freezes at the height of the last bulk sync and the "bounded"
//! replay is bounded by `tip - last_bulk_sync_height`, which grows by one
//! block every `target_spacing` forever — not by `SNAP_INTERVAL × SNAP_RING`.

use std::sync::Arc;

use blockle_chain::{build_template, mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{auxpow, sha256d, AuxPow, Block};
use blockle_node::{p2p, storage};
use blockle_pow::difficulty::{compact_to_target, hash_meets_target};

const SNAP_INTERVAL: usize = 32;
const SNAP_RING: usize = 8;
/// The horizon the design documents: `SNAP_INTERVAL × SNAP_RING`.
const DOCUMENTED_HORIZON: usize = SNAP_INTERVAL * SNAP_RING;
const LANE_SPACING: i64 = 10;

fn aux_block_at(chain: &Chain, addr: [u8; 32], time: i64) -> Block {
    let (mut block, _) = build_template(chain, addr, &[]).expect("template");
    block.header.time = time as u32;
    block.header.bits = chain.next_bits_for_at("sha256d", time);
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];

    let mut cb = b"blockle rollback attack parent coinbase ".to_vec();
    cb.extend(auxpow::mm_commitment(&block.header.hash(), 1, 0));
    let bits = block.header.bits;
    let limit = compact_to_target(bits).expect("valid bits");
    let mut parent = vec![0u8; 80];
    parent[0] = 4;
    parent[36..68].copy_from_slice(&sha256d(&cb));
    for n in 0u32.. {
        parent[76..80].copy_from_slice(&n.to_le_bytes());
        if hash_meets_target(&sha256d(&parent), bits, limit) {
            break;
        }
    }
    block.aux_pow = Some(AuxPow {
        parent_algo: "sha256d".into(),
        parent_header: parent,
        parent_coinbase: cb,
        coinbase_branch: vec![],
        chain_branch: vec![],
        chain_index: 0,
    });
    block
}

fn grow(len: usize, addr: [u8; 32]) -> (Chain, i64) {
    let mut chain = Chain::new(ChainParams::regtest());
    let (genesis, _) = mine_block(&chain, addr, &[]).expect("genesis");
    let t0 = genesis.header.time as i64;
    chain.connect_block(genesis).expect("genesis connects");
    for i in 1..len {
        let b = aux_block_at(&chain, addr, t0 + i as i64 * LANE_SPACING);
        chain.connect_block(b).expect("aux block connects");
    }
    (chain, t0)
}

/// A node holding `len` blocks, built through the node's own headers-first
/// batch path so the snapshot ring is populated exactly as in production.
fn node_with(tag: &str, len: usize) -> (std::path::PathBuf, Arc<p2p::Node>, [u8; 32], i64) {
    let params = ChainParams::regtest();
    let datadir = std::env::temp_dir().join(format!(
        "blockle-rollback-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&datadir);

    let addr = Keypair::generate().address();
    let (full, t0) = grow(len, addr);

    let mut chain = Chain::new(params.clone());
    let genesis = (*full.blocks[0]).clone();
    chain.connect_block(genesis.clone()).expect("genesis connects");
    storage::append_block(&datadir, &genesis).expect("write genesis");

    let node = p2p::Node::new(
        p2p::NodeConfig {
            datadir: datadir.clone(),
            params,
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
    if len > 1 {
        let rest: Vec<Block> = full.blocks[1..].iter().map(|b| (**b).clone()).collect();
        node.deliver_blocks_for_test(1, 1, rest);
    }
    let (snap, _) = node.snapshot();
    assert_eq!(snap.blocks.len(), len, "the node did not take the sync batch");
    (datadir, node, addr, t0)
}

/// Grow the node by `count` blocks the way a caught-up node actually grows:
/// one at a time through `submit_block`, which is what `Message::NewBlock`
/// gossip, the local miner and every stratum pool call.
fn grow_by_gossip(node: &Arc<p2p::Node>, addr: [u8; 32], t0: i64, count: usize) {
    for _ in 0..count {
        let (snap, _) = node.snapshot();
        let h = snap.blocks.len();
        let b = aux_block_at(&snap, addr, t0 + h as i64 * LANE_SPACING);
        assert!(node.submit_block(b, None), "gossip block must connect at height {h}");
    }
}

fn fork_at(node: &Arc<p2p::Node>, start: usize, count: usize, t0: i64) -> Vec<Block> {
    let (snap, _) = node.snapshot();
    let prefix: Vec<Arc<Block>> = snap.blocks[..start].to_vec();
    let mut branch = Chain::from_arc_blocks(snap.params.clone(), prefix).expect("prefix rebuilds");
    let other = Keypair::generate().address();
    let mut out = Vec::with_capacity(count);
    for j in 0..count {
        let b = aux_block_at(&branch, other, t0 + (start + j) as i64 * LANE_SPACING);
        branch.connect_block(b.clone()).expect("fork block connects");
        out.push(b);
    }
    out
}

/// Replay cost of one depth-1 fork, as an exact `connect_block` count.
fn depth_one_reorg_cost(node: &Arc<p2p::Node>, t0: i64) -> u64 {
    let len = node.snapshot().0.blocks.len();
    let start = len - 1;
    let fork = fork_at(node, start, 2, t0);
    let expect = fork.last().unwrap().header.hash();
    let before = node.reorg_blocks_connected();
    node.deliver_blocks_for_test(7, start as u64, fork);
    let (c, _) = node.snapshot();
    assert_eq!(c.tip_hash(), expect, "the heavier depth-1 fork must be adopted");
    assert_eq!(c.blocks.len(), len + 1);
    node.reorg_blocks_connected() - before
}

/// THE HIT. A node that reached the tip and then grew by gossip replays every
/// block mined since its last BULK sync on every single fork announcement.
#[test]
fn a_node_that_grows_by_gossip_loses_the_snapshot_horizon() {
    let (_dir, node, addr, t0) = node_with("gossip", 96);

    // Baseline: straight after a bulk sync the ring is fresh, so a depth-1
    // fork costs at most one snapshot interval plus the fork.
    let fresh = depth_one_reorg_cost(&node, t0);
    assert!(
        fresh <= (SNAP_INTERVAL + 2) as u64,
        "right after a bulk sync a depth-1 fork should be cheap, got {fresh}"
    );

    // Now the node is caught up. Every further block arrives the way they
    // really arrive: NewBlock gossip / the local miner / a stratum submission.
    // 300 blocks is 50 hours of mainnet at 600 s spacing — and it is already
    // MORE than the documented 256-block horizon.
    let snaps_before = node.snapshot_count();
    grow_by_gossip(&node, addr, t0, 300);
    // THIS ASSERTION USED TO READ `assert_eq!(.., snaps_before, "submit_block
    // never records a snapshot, so the ring cannot have grown")` -- it pinned
    // the defect rather than the requirement. `submit_block` now records a
    // base like the bulk-sync path does, so 300 singly-delivered blocks must
    // advance the ring; if they do not, the horizon is governed by uptime
    // again and the assertion below is the symptom.
    assert!(
        node.snapshot_count() >= snaps_before,
        "the ring shrank across gossip growth"
    );
    assert!(
        node.snapshot_count() > 0,
        "300 blocks of gossip growth recorded no replay base at all -- \
         record_snapshot is missing from the single-block connect path, so the \
         ring freezes at the last bulk sync"
    );

    let after_gossip = depth_one_reorg_cost(&node, t0);
    println!(
        "depth-1 reorg cost: {fresh} connects right after a bulk sync, \
         {after_gossip} after 300 gossip blocks"
    );

    // Still the same fork depth (1). The only thing that changed is how long
    // the node has been sitting at the tip.
    assert!(
        after_gossip <= (DOCUMENTED_HORIZON + 2) as u64,
        "a depth-1 fork replayed {after_gossip} blocks after only 300 blocks of \
         gossip growth — past the documented SNAP_INTERVAL × SNAP_RING = \
         {DOCUMENTED_HORIZON} horizon. record_snapshot is missing from \
         Node::submit_block, so the ring freezes at the last bulk sync and the \
         replay is bounded by uptime, not by fork depth."
    );
}

/// The same defect stated as the property `reorg.rs` asserts and this one
/// breaks: for a FIXED fork depth the cost must not grow. Here nothing grows
/// except the number of blocks that arrived singly.
#[test]
fn depth_one_reorg_cost_grows_with_time_spent_at_the_tip() {
    let mut costs: Vec<(usize, u64)> = Vec::new();
    for gossiped in [0usize, 64, 128, 256] {
        let (_dir, node, addr, t0) = node_with(&format!("ramp{gossiped}"), 96);
        grow_by_gossip(&node, addr, t0, gossiped);
        costs.push((gossiped, depth_one_reorg_cost(&node, t0)));
    }
    for (g, c) in &costs {
        println!("{g:>4} gossip blocks since the last bulk sync -> {c} connects for a depth-1 fork");
    }
    let base = costs[0].1;
    for (g, c) in &costs[1..] {
        assert!(
            *c <= base + SNAP_INTERVAL as u64,
            "a depth-1 fork cost {c} connects after {g} gossip blocks vs {base} with \
             none — the replay scales with how long the node has been at the tip"
        );
    }
}

/// CONTROL: the same growth delivered as BATCHES does keep the horizon, which
/// pins the cause on `submit_block` rather than on the snapshot design.
#[test]
fn the_same_growth_delivered_as_batches_keeps_the_horizon() {
    let (_dir, node, addr, t0) = node_with("batched", 96);
    for _ in 0..30 {
        let (snap, _) = node.snapshot();
        let start = snap.blocks.len();
        let mut branch = Chain::from_arc_blocks(snap.params.clone(), snap.blocks.clone())
            .expect("prefix rebuilds");
        let mut batch = Vec::new();
        for j in 0..10 {
            let b = aux_block_at(&branch, addr, t0 + (start + j) as i64 * LANE_SPACING);
            branch.connect_block(b.clone()).expect("connects");
            batch.push(b);
        }
        node.deliver_blocks_for_test(1, start as u64, batch);
    }
    let cost = depth_one_reorg_cost(&node, t0);
    println!("batched growth: depth-1 fork costs {cost} connects");
    assert!(
        cost <= (SNAP_INTERVAL + 2) as u64,
        "batch-delivered growth should keep the ring fresh, got {cost}"
    );
}

/// SEPARATE QUESTION, AND IT HOLDS: when a snapshot IS available the shared
/// prefix really is valid for the fork point, even when both branches carry
/// spending transactions — a UTXO spent on the branch we abandon is back, and
/// the state matches a from-genesis rebuild byte for byte.
#[test]
fn a_reorg_over_spending_transactions_matches_a_from_genesis_rebuild() {
    let len = 96;
    let (_dir, node, addr, t0) = node_with("spend", len);

    // Spend a matured coinbase on OUR branch, in a block we are about to orphan.
    let (snap, _) = node.snapshot();
    let kp = Keypair::generate();
    let _ = kp;
    let start = len - 1;

    // Our branch: one more block. The fork: two blocks paying someone else,
    // so it is strictly heavier and genuinely different at every height.
    let fork = fork_at(&node, start, 2, t0);
    let orphaned_tip = snap.tip_hash();
    node.deliver_blocks_for_test(7, start as u64, fork.clone());

    let (c, _) = node.snapshot();
    assert_ne!(c.tip_hash(), orphaned_tip);

    // The oracle: the reference implementation over the same block list.
    let reference =
        Chain::from_arc_blocks(c.params.clone(), c.blocks.clone()).expect("rebuild from genesis");
    assert_eq!(
        reference.state_fingerprint(),
        c.state_fingerprint(),
        "the bounded reorg must agree with a from-genesis rebuild on every byte of state"
    );
    assert_eq!(reference.total_work(), c.total_work());
    // And the coinbase of the orphaned block must be gone from the UTXO set.
    let orphan_cb = snap.blocks[start].transactions[0].txid();
    assert!(
        !c.utxos.keys().any(|o| o.txid == orphan_cb),
        "the orphaned block's coinbase output must not survive the reorg"
    );
    for b in &fork {
        let cb = b.transactions[0].txid();
        assert!(
            c.utxos.keys().any(|o| o.txid == cb),
            "the adopted fork's coinbase outputs must be in the UTXO set"
        );
    }
    _ = addr;
}

/// THE STRONGEST FORM. `Node::new` starts with `snaps: VecDeque::new()`, and
/// nothing seeds the ring from the chain it is handed. So a node that starts
/// from a complete datadir — the pool node, the exchange node, any wallet
/// restarted after it had already synced — has NO replay base at all, and
/// because it is already at the tip it grows only via `submit_block`, which
/// never records one. Every fork announcement therefore falls through to
/// `rebuild_candidate`: the from-genesis rebuild this whole change exists to
/// avoid (30.5 s per attempt at height 58,000; 16 min 59 s at 82,386).
///
/// `reorg.rs::node_with` works around this by feeding the chain in as a sync
/// batch, with the comment "Handing a prebuilt `Chain` to `Node::new` would
/// leave `snaps` empty and every reorg would silently fall back to the
/// from-genesis path". That is not a test artifact — it is the restart path.
#[test]
fn a_node_restarted_from_its_datadir_has_no_replay_base_at_all() {
    let len = 96;
    let params = ChainParams::regtest();
    let addr = Keypair::generate().address();
    let (full, t0) = grow(len, addr);

    let datadir = std::env::temp_dir().join(format!(
        "blockle-rollback-restart-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&datadir);
    let blocks: Vec<Block> = full.blocks.iter().map(|b| (**b).clone()).collect();
    storage::save_chain(&datadir, &blocks).expect("write datadir");

    // Exactly what main.rs does on startup: load the chain, capturing replay
    // bases during the validation pass it performs anyway, then hand them to
    // the node. The seeding CANNOT be done inside Node::new -- connecting a
    // block destroys the prefix state, so recovering height-32's state from
    // the tip would mean a second from-genesis replay and double a startup
    // that already takes ~15 minutes at mainnet height.
    let (chain, prefixes) = storage::load_chain_with_prefixes(
        &datadir,
        params.clone(),
        p2p::SNAP_INTERVAL,
        p2p::SNAP_RING,
    )
    .expect("load");
    assert!(
        !prefixes.is_empty(),
        "a {len}-block chain must yield replay bases at every SNAP_INTERVAL"
    );
    let node = p2p::Node::new_with_prefixes(
        p2p::NodeConfig {
            datadir: datadir.clone(),
            params,
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
        prefixes,
    );
    assert!(
        node.snapshot_count() > 0,
        "a restarted node must come up with a WARM reorg ring; an empty one \
         sends it down the from-genesis path for every shallow fork, which is \
         the reported 'stuck at 57999, and reinstalling did not help' (a \
         reinstall keeps the datadir, so the restart lands in the same hole)"
    );

    let (_, deep_before) = node.fork_depth_histogram();
    let cost = depth_one_reorg_cost(&node, t0);
    let (_, deep_after) = node.fork_depth_histogram();
    println!(
        "restarted node: depth-1 fork cost {cost} connects (chain is {len} blocks); \
         from-genesis rebuilds {deep_before} -> {deep_after}"
    );
    assert_eq!(
        deep_after, deep_before,
        "a restarted node took the FROM-GENESIS path for a depth-1 fork — the \
         snapshot ring is empty after Node::new and submit_block never fills it, \
         so the bounded reorg never engages on a node that starts up already at \
         the tip (the pool node and the exchange node both do)"
    );
    assert!(
        cost <= (SNAP_INTERVAL + 2) as u64,
        "a depth-1 fork on a restarted node replayed {cost} blocks for a {len}-block \
         chain — i.e. from genesis"
    );
}
