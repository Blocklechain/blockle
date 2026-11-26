//! The reorg path: a fork rooted below our tip must be resolved by replaying
//! forward from a retained prefix snapshot, not by re-validating the chain from
//! genesis.
//!
//! WHY THIS FILE EXISTS.
//!
//! `handle_blocks` used to resolve every fork with
//! `Chain::from_blocks(blocks[..start] ++ fork)`, and `from_blocks` is
//! `connect_block` in a loop from genesis. Its comment called the reorg path
//! "Rare". That assumption was the bug, in two separate ways:
//!
//!   * IT IS NOT RARE. The headers message starts at the FORK POINT, so a peer
//!     whose chain diverges even ONE block below our tip lands here. The
//!     stranded exchange node's own log shows start_height 53371 against tip
//!     53372. In one 6-hour window the live pool node took this path 418 times
//!     and adopted 7 of them — about 60 entries an hour, not "rare".
//!
//!   * IT COST O(HEIGHT) PER ATTEMPT. Measured on real mainnet blocks: 30.5 s
//!     per attempt at height 58,000 — as much as the entire from-genesis sync
//!     up to that height — and 16 min 59 s at height 82,386. The heartbeat
//!     retries every 10 s, so the work was obsolete long before it finished.
//!     Two nodes sat at 100% of one core making no progress: a Windows wallet
//!     stuck at height 57999 across a reinstall, and the exchange's own wallet
//!     stranded at 53,372 until its block file was replaced by hand.
//!
//! So the properties worth testing are not "is it faster". They are:
//!
//!   * EQUIVALENCE — the cheap path must produce exactly what `from_blocks`
//!     would. It is the same function (`connect_block`) over the same blocks,
//!     and `reorg_matches_a_from_genesis_rebuild_exactly` checks that against
//!     the reference implementation rather than taking it on faith.
//!   * FORK CHOICE UNCHANGED — strictly heavier by `total_work`, nothing else.
//!   * ATOMICITY — a fork that fails validation must leave the chain untouched,
//!     asserted on the state fingerprint and not just on the height.
//!   * COST DEPENDS ON FORK DEPTH, NOT ON CHAIN HEIGHT. This is the one the
//!     original code got wrong, so it is asserted as an exact count rather
//!     than a duration. See `reorg_cost_does_not_grow_with_chain_height`.
//!
//! HOW THESE CHAINS ARE BUILT, because it is not obvious and it matters.
//! Native blocks need a real Equihash solution, and regtest difficulty
//! self-equilibrates (LWMA targets `target_spacing`) to roughly one second of
//! solving per block — measured 1.17 s/block, which makes a 300-block test
//! chain impossible. So these chains are merge-mined on the `sha256d` lane,
//! where the proof is one grind of an 80-byte parent header, and the block
//! timestamps are spaced `target_spacing × lanes()` = 10 s apart, which is
//! exactly the per-lane cadence the retarget expects. Difficulty therefore
//! stays pinned at `pow_limit`, each grind is ~16 hashes, and 300 blocks build
//! in about 6 ms instead of 6 minutes. These are fully validated blocks, not
//! stubs — `connect_block` accepts them through the normal AuxPoW path.

use std::sync::Arc;

use blockle_chain::{build_template, mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{auxpow, sha256d, AuxPow, Block};
use blockle_node::{p2p, storage};
use blockle_pow::difficulty::{compact_to_target, hash_meets_target};

/// `SNAP_INTERVAL` in p2p.rs. Not public; mirrored here so the expected replay
/// cost can be stated exactly. If it changes there, these tests will say so.
const SNAP_INTERVAL: usize = 32;

/// Seconds between blocks on one lane: `target_spacing × lanes()`. Keeping to
/// this cadence is what holds difficulty at `pow_limit` and keeps the grind
/// trivial — see the module comment.
const LANE_SPACING: i64 = 10;

/// Build one fully valid merge-mined (`sha256d`) block on `chain`'s tip,
/// stamped at `time` and paying `addr`.
///
/// `time` is explicit rather than wall-clock because the retarget keys off the
/// gap between a lane's blocks: let these be mined "instantly" and difficulty
/// ramps away without bound (measured: pow_limit to 1d20ba38 in 90 blocks,
/// at which point one block needs 256M hashes).
fn aux_block_at(chain: &Chain, addr: [u8; 32], time: i64) -> Block {
    let (mut block, _) = build_template(chain, addr, &[]).expect("template");
    // Stamp the time first, then derive bits from it — the same order
    // `build_template` uses, because the quiet-lane decay is a function of the
    // block's own timestamp and the validator recomputes bits from it.
    block.header.time = time as u32;
    block.header.bits = chain.next_bits_for_at("sha256d", time);
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];

    // The parent coinbase commits to this block's header hash, so it has to be
    // built after every header field is final.
    let mut cb = b"blockle reorg test parent coinbase ".to_vec();
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

/// A chain of `len` blocks: a native genesis plus merge-mined blocks on the
/// 10 s lane cadence. Returns the chain and the genesis timestamp, which is
/// the time base every later block and every fork is stamped against.
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

/// A node holding `len` blocks, built THROUGH the node's own sync path so the
/// snapshot ring is populated the way it is in production.
///
/// Handing a prebuilt `Chain` to `Node::new` would leave `snaps` empty and
/// every reorg would silently fall back to the from-genesis path — the tests
/// would pass while testing nothing. So the genesis goes in at construction and
/// everything above it arrives as a sync batch.
fn node_with(tag: &str, len: usize) -> (std::path::PathBuf, Arc<p2p::Node>, [u8; 32], i64) {
    node_with_opts(tag, len, false, false)
}

/// As [`node_with`], but able to force the from-genesis reorg path via
/// `--reorg-authority`. That flag is the operator escape hatch; here it doubles
/// as the way to run the ORIGINAL buggy behaviour on demand, which is what lets
/// `the_from_genesis_path_is_height_dependent` prove these tests can tell the
/// two apart.
fn node_with_opts(
    tag: &str,
    len: usize,
    reorg_authority: bool,
    selfcheck_reorg: bool,
) -> (std::path::PathBuf, Arc<p2p::Node>, [u8; 32], i64) {
    let params = ChainParams::regtest();
    let datadir = std::env::temp_dir().join(format!(
        "blockle-reorg-{tag}-{}-{:?}",
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

    // Port 0 is never bound: run() is not called, so nothing listens.
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
            reorg_authority,
            selfcheck_reorg,
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

/// Blocks replacing everything from `start` onward: `count` merge-mined blocks
/// built on the node's own chain truncated to `start`, paying a different
/// address so they are genuinely different blocks at the same heights.
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

/// Everything that must be identical for "the node was left untouched" to be
/// a real claim rather than a height check.
fn fingerprint(node: &Arc<p2p::Node>) -> (Option<u64>, [u8; 32], [u8; 32], String) {
    let (c, _) = node.snapshot();
    (c.height(), c.tip_hash(), c.state_fingerprint(), c.total_work().to_string())
}

#[test]
fn depth_one_reorg_is_adopted_and_stays_cheap() {
    // THE CASE FROM THE REAL LOG: start_height 53371 against tip 53372, i.e.
    // start = tip - 1. One block of ours is replaced by two of theirs, so the
    // fork is strictly heavier by exactly one block of work.
    let len = 96;
    let (_dir, node, _addr, t0) = node_with("depth1", len);
    let start = len - 1;
    let fork = fork_at(&node, start, 2, t0);
    let expect_tip = fork.last().unwrap().header.hash();

    let before = node.reorg_blocks_connected();
    let (_, deep_before) = node.fork_depth_histogram();
    node.deliver_blocks_for_test(7, start as u64, fork);

    let (c, _) = node.snapshot();
    assert_eq!(c.blocks.len(), len + 1, "the heavier fork must be adopted");
    assert_eq!(c.tip_hash(), expect_tip, "tip must be the fork's last block");

    let (_, deep_after) = node.fork_depth_histogram();
    assert_eq!(
        deep_after, deep_before,
        "a depth-1 fork must NOT fall back to a from-genesis rebuild — that \
         fallback is what cost 17 minutes per attempt on the live node"
    );
    // The bounded path replays our own blocks back to the newest snapshot, then
    // the fork. The snapshot ring is every SNAP_INTERVAL blocks, so that is at
    // most SNAP_INTERVAL of ours plus the fork itself — and critically it is
    // not a function of `len`.
    let replayed = node.reorg_blocks_connected() - before;
    assert!(
        replayed <= (SNAP_INTERVAL + 2) as u64,
        "replayed {replayed} blocks for a depth-1 fork; the bounded path must \
         stay within one snapshot interval ({SNAP_INTERVAL}) plus the fork"
    );
}

#[test]
fn deeper_reorg_is_adopted_correctly() {
    // Deep enough to span several snapshot boundaries, still inside the
    // horizon. 41 blocks replace 40, so it is heavier by one block of work.
    let len = 352;
    let (_dir, node, _addr, t0) = node_with("deep", len);
    let start = len - 40;
    let fork = fork_at(&node, start, 41, t0);
    let expect_tip = fork.last().unwrap().header.hash();

    let (_, deep_before) = node.fork_depth_histogram();
    node.deliver_blocks_for_test(7, start as u64, fork);

    let (c, _) = node.snapshot();
    assert_eq!(c.blocks.len(), len + 1);
    assert_eq!(c.tip_hash(), expect_tip);
    assert_eq!(
        node.fork_depth_histogram().1, deep_before,
        "a 40-deep fork is well inside the snapshot horizon and must not \
         trigger a from-genesis rebuild"
    );
}

#[test]
fn a_fork_that_is_not_heavier_is_rejected_and_changes_nothing() {
    // Equal length, therefore equal work: every block here carries the same
    // bits (pinned at pow_limit), so one-for-one replacement ties. The gate is
    // STRICTLY heavier, so a tie must lose — otherwise peers could flap a
    // chain's tip back and forth forever at no cost.
    let len = 96;
    let (_dir, node, _addr, t0) = node_with("lighter", len);
    let start = len - 1;
    let fork = fork_at(&node, start, 1, t0);

    let before = fingerprint(&node);
    let (c, _) = node.snapshot();
    assert_eq!(
        Chain::from_arc_blocks(c.params.clone(), {
            let mut v = c.blocks[..start].to_vec();
            v.extend(fork.iter().cloned().map(Arc::new));
            v
        })
        .expect("the fork is valid, just not heavier")
        .total_work(),
        c.total_work(),
        "this test is only meaningful if the fork really does tie on work"
    );

    node.deliver_blocks_for_test(7, start as u64, fork);
    assert_eq!(fingerprint(&node), before, "a tie must leave the chain alone");
}

#[test]
fn a_fork_containing_an_invalid_block_leaves_the_chain_byte_identical() {
    let len = 96;
    let (_dir, node, _addr, t0) = node_with("invalid", len);
    let start = len - 1;
    // Heavier than ours by two blocks of work, so it would certainly be adopted
    // if it validated — the rejection has to come from validation, not from the
    // work gate, or this test proves nothing.
    let mut fork = fork_at(&node, start, 3, t0);

    // Break the PROOF OF WORK of the middle block by regrinding its parent
    // header nonce to a value that does not meet the target. The BLOCK header
    // is untouched, so the block still links correctly and still hashes to what
    // the sync announced — the only thing wrong with it is that its proof is
    // invalid, which is exactly the case a peer could actually feed us.
    let bad = &mut fork[1];
    let ap = bad.aux_pow.as_mut().expect("merge-mined");
    let bits = bad.header.bits;
    let limit = compact_to_target(bits).expect("valid bits");
    let mut n = 0u32;
    loop {
        ap.parent_header[76..80].copy_from_slice(&n.to_le_bytes());
        if !hash_meets_target(&sha256d(&ap.parent_header), bits, limit) {
            break;
        }
        n += 1;
    }

    let before = fingerprint(&node);
    node.deliver_blocks_for_test(7, start as u64, fork);
    let after = fingerprint(&node);

    // Height, tip, total work AND the full state fingerprint — the UTXO set,
    // contracts, contract storage, pools, note leaves and anchors, nullifiers,
    // the NFT ownership index and the intel registries. A reorg that half-applied
    // a fork would still have the right height.
    assert_eq!(
        after, before,
        "an invalid fork must leave the chain completely untouched; validation \
         happens on a separate candidate for exactly this reason"
    );
}

#[test]
fn reorg_matches_a_from_genesis_rebuild_exactly() {
    // THE TEST THAT MAKES THE OPTIMISATION SAFE. The bounded path and
    // `Chain::from_blocks` must be the same function of the same blocks, so
    // this builds the adopted chain both ways and compares everything, not
    // just the tip.
    let len = 352;
    let (_dir, node, _addr, t0) = node_with("equiv", len);

    // Several depths, including the boundaries the snapshot interval creates:
    // one below an interval, exactly on it, one above, and a couple of odd
    // offsets so the common-block run is not always the same length.
    for depth in [1usize, 2, 5, 31, 32, 33, 64, 70] {
        let (before, _) = node.snapshot();
        let start = before.blocks.len() - depth;
        let fork = fork_at(&node, start, depth + 1, t0);

        // The exact block list the node should end up holding.
        let mut expected_blocks: Vec<Arc<Block>> = before.blocks[..start].to_vec();
        expected_blocks.extend(fork.iter().cloned().map(Arc::new));
        let reference = Chain::from_arc_blocks(before.params.clone(), expected_blocks)
            .expect("the reference rebuild must succeed");

        let (_, deep_before) = node.fork_depth_histogram();
        node.deliver_blocks_for_test(7, start as u64, fork);
        let (got, _) = node.snapshot();

        // Without this the test could pass vacuously by falling back to the
        // from-genesis path and comparing `from_blocks` against itself.
        assert_eq!(
            node.fork_depth_histogram().1, deep_before,
            "depth {depth} took the from-genesis fallback, so this iteration \
             compared the reference implementation against itself and proved \
             nothing about the bounded path"
        );
        assert_eq!(got.blocks.len(), reference.blocks.len(), "height, depth {depth}");
        assert_eq!(got.tip_hash(), reference.tip_hash(), "tip, depth {depth}");
        assert_eq!(
            got.total_work(),
            reference.total_work(),
            "total_work, depth {depth} — the fork-choice metric itself must agree"
        );
        assert_eq!(
            got.state_fingerprint(),
            reference.state_fingerprint(),
            "state fingerprint, depth {depth}: the bounded reorg produced a \
             different state than a from-genesis rebuild of the same blocks. \
             This is the chain-split case; do not relax this assertion."
        );
        // The block sequences must match element for element, not merely hash
        // to the same tip.
        for (i, (a, b)) in got.blocks.iter().zip(reference.blocks.iter()).enumerate() {
            assert_eq!(a.header.hash(), b.header.hash(), "block {i}, depth {depth}");
        }
    }
}

#[test]
fn the_selfcheck_canary_agrees_and_still_adopts() {
    // `--selfcheck-reorg` is the mechanism that is supposed to run on the box
    // for a week before the bounded path is trusted silently: every adoption is
    // ALSO built from genesis and the two state fingerprints must match, or the
    // adoption is refused. It is worth a test of its own because a canary that
    // is itself broken is worse than no canary — if it refused good forks the
    // node would stall, and if it compared nothing it would bless anything.
    let len = 96;
    let (_dir, node, _addr, t0) = node_with_opts("selfcheck", len, false, true);
    let start = len - 1;
    let fork = fork_at(&node, start, 2, t0);
    let expect_tip = fork.last().unwrap().header.hash();

    node.deliver_blocks_for_test(7, start as u64, fork);

    let (c, _) = node.snapshot();
    assert_eq!(
        c.tip_hash(), expect_tip,
        "the canary refused a fork that a from-genesis rebuild agrees with"
    );
    assert_eq!(c.blocks.len(), len + 1);
}

#[test]
fn a_fork_deeper_than_the_snapshot_horizon_is_still_adopted() {
    // THE BOUND IS ON THE MECHANISM, NOT ON WHICH FORKS ARE ACCEPTABLE.
    // Nothing becomes invalid for being deep: a fork below the snapshot
    // horizon falls back to `Chain::from_blocks` — the original path, kept
    // deliberately — and is adopted under exactly the same work rule.
    let len = 352;
    let (_dir, node, _addr, t0) = node_with("horizon", len);
    let start = 8; // far below the oldest retained snapshot
    let fork = fork_at(&node, start, len - start + 1, t0);
    let expect_tip = fork.last().unwrap().header.hash();

    let (_, deep_before) = node.fork_depth_histogram();
    node.deliver_blocks_for_test(7, start as u64, fork);

    let (c, _) = node.snapshot();
    assert_eq!(c.blocks.len(), len + 1, "a deep fork must still be adopted");
    assert_eq!(c.tip_hash(), expect_tip);
    assert_eq!(
        node.fork_depth_histogram().1,
        deep_before + 1,
        "a fork below the horizon should have used the from-genesis fallback"
    );
}

#[test]
fn reorg_cost_does_not_grow_with_chain_height() {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
    //
    // The defect was not "reorgs are slow" — it was that a reorg's cost was a
    // function of CHAIN HEIGHT rather than of fork depth, because the candidate
    // was rebuilt from genesis every time. So this fixes the fork depth and
    // varies only the height, and asserts the number of blocks actually
    // re-validated is IDENTICAL. Under the old code it would have been 97 and
    // 353 instead of equal.
    //
    // A count, not a duration, on purpose: at the heights a unit test can build,
    // a from-genesis rebuild is only milliseconds, so a timing assertion loose
    // enough to survive a loaded CI box would have passed on the buggy code and
    // only failed in production at height 58,000.
    //
    // Both heights are chosen ≡ 0 (mod SNAP_INTERVAL) so the distance from the
    // fork point back to the newest usable snapshot is the same in both cases,
    // and the comparison is exact rather than approximate.
    let short_len = 3 * SNAP_INTERVAL; // 96
    let tall_len = 11 * SNAP_INTERVAL; // 352
    assert_eq!(short_len % SNAP_INTERVAL, 0);
    assert_eq!(tall_len % SNAP_INTERVAL, 0);

    let cost = |tag: &str, len: usize| -> u64 {
        let (_dir, node, _addr, t0) = node_with(tag, len);
        let start = len - 1; // fork depth 1 in both cases
        let fork = fork_at(&node, start, 2, t0);
        let before = node.reorg_blocks_connected();
        node.deliver_blocks_for_test(7, start as u64, fork);
        let (c, _) = node.snapshot();
        assert_eq!(c.blocks.len(), len + 1, "the fork must have been adopted at len {len}");
        node.reorg_blocks_connected() - before
    };

    let short = cost("perf-short", short_len);
    let tall = cost("perf-tall", tall_len);

    assert_eq!(
        short, tall,
        "a depth-1 reorg re-validated {short} blocks at height {short_len} but \
         {tall} at height {tall_len}. The reorg path's cost must depend on fork \
         depth, not on chain height — that dependency is what stalled every \
         fresh wallet install and burned ~5.5 cores on the pool node."
    );
    assert!(
        tall < tall_len as u64,
        "a depth-1 reorg re-validated {tall} blocks on a {tall_len}-block chain, \
         which means it is still rebuilding from genesis"
    );
}

#[test]
fn the_from_genesis_path_is_height_dependent() {
    // THE MUTATION PROOF for the test above. A test that passes is worthless
    // unless it would have FAILED on the broken code, so this runs the broken
    // code on purpose — `--reorg-authority` forces the from-genesis rebuild
    // that every reorg used to take — and pins its signature: the number of
    // blocks re-validated for a depth-1 fork equals the chain height, and grows
    // one-for-one with it.
    //
    // Keeping this as a live test (rather than a comment claiming the other
    // test is strict) means the cost counter cannot quietly stop measuring
    // anything: if `reorg_blocks_connected` were ever wired to something that
    // does not track real work, this test goes red too.
    let short_len = 3 * SNAP_INTERVAL; // 96
    let tall_len = 11 * SNAP_INTERVAL; // 352

    let cost = |tag: &str, len: usize| -> u64 {
        let (_dir, node, _addr, t0) = node_with_opts(tag, len, true, false);
        let start = len - 1;
        let fork = fork_at(&node, start, 2, t0);
        let before = node.reorg_blocks_connected();
        node.deliver_blocks_for_test(7, start as u64, fork);
        let (c, _) = node.snapshot();
        // Still correct, just ruinously expensive — that is why it stayed
        // hidden until the chain got tall.
        assert_eq!(c.blocks.len(), len + 1, "the authority path must still adopt");
        node.reorg_blocks_connected() - before
    };

    let short = cost("auth-short", short_len);
    let tall = cost("auth-tall", tall_len);

    // start (= len - 1 retained blocks) + 2 fork blocks, re-validated from
    // genesis every single time.
    assert_eq!(short, short_len as u64 + 1, "from-genesis cost at height {short_len}");
    assert_eq!(tall, tall_len as u64 + 1, "from-genesis cost at height {tall_len}");
    assert!(
        tall > short * 3,
        "the from-genesis path must demonstrably scale with height, or the \
         bounded-path assertion is not actually testing anything"
    );
}
