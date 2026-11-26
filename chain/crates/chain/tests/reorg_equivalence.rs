//! Differential tests for the two bounded indexes the reorg work depends on:
//! the per-lane retarget index (`lane_pos`) and the work prefix sums
//! (`work_prefix`).
//!
//! WHY THESE NEED A TEST OF THEIR OWN, SEPARATELY FROM THE REORG TESTS.
//!
//! Bounding the reorg path was the point of the change, but it is only fast if
//! `connect_block` itself is cheap, and it was not: `next_bits_for` and
//! `next_bits_coupled` each built a `Vec` over the ENTIRE chain on every single
//! block. Measured at height 58,000 that was 1.2 ms of the 1.4 ms it cost to
//! connect one block — so `Chain::from_blocks` was ~O(n^1.6), a node restart
//! replayed the chain in 16 min 59 s, and even the "already fixed" append-only
//! sync path was still quadratic over a full sync.
//!
//! The fix replaced those whole-chain scans with maintained indexes. That makes
//! them CONSENSUS-CRITICAL IN A WAY THE REORG CHANGE IS NOT. The reorg path
//! only has to agree with `from_blocks`, and it does so by construction because
//! it calls the same `connect_block`. But `next_bits_for_at` is enforced as
//! `header.bits != expected_bits`: if a maintained index is ever stale or
//! mis-ordered by one entry, two nodes compute different expected bits, reject
//! each other's blocks, and the chain splits. There is no graceful degradation.
//!
//! THE WRONG FIX, NAMED. The tempting bound is "just read the last 18 blocks",
//! since `lwma_next_bits` only looks at `lwma_window + 1` entries. That is
//! correct for the COUPLED rule, which reads the chain's own tail — and WRONG
//! for the per-lane rule, because a lane's 18th-most-recent block is not in any
//! fixed window of `blocks`: an idle lane's can be thousands of blocks back.
//! Hence `lane_pos`, and hence the emphasis below on lanes that are idle, rare,
//! or have never produced a block at all.
//!
//! So every bounded function is compared against the whole-chain implementation
//! it replaced, which is retained in `chain.rs` as `*_fullscan` precisely to be
//! the oracle here. The comparison is made at EVERY height, for EVERY lane,
//! including the coupled rule at heights where it is not the enforced one — the
//! differential does not care which rule `connect_block` happens to apply, and
//! checking both doubles the coverage for free.

use std::sync::Arc;

use blockle_chain::{build_template, mine_block, Chain, ChainParams};
use blockle_core::{auxpow, sha256d, AuxPow, Block};
use blockle_pow::difficulty::{compact_to_target, hash_meets_target};
use blockle_pow::scrypt_pow_hash;

/// Per-lane cadence the retarget expects: `target_spacing × lanes()`.
const LANE_SPACING: i64 = 10;

/// One fully valid merge-mined block on `lane`, stamped at `time`.
///
/// Timestamps are explicit because the retarget keys off the gap between a
/// lane's blocks; mined "instantly", regtest difficulty ramps away without
/// bound and the grind stops being affordable.
fn aux_block_at(chain: &Chain, addr: [u8; 32], lane: &str, time: i64) -> Block {
    let (mut block, _) = build_template(chain, addr, &[]).expect("template");
    block.header.time = time as u32;
    block.header.bits = chain.next_bits_for_at(lane, time);
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];

    let mut cb = b"blockle equivalence test parent ".to_vec();
    cb.extend(auxpow::mm_commitment(&block.header.hash(), 1, 0));
    let bits = block.header.bits;
    let limit = compact_to_target(bits).expect("valid bits");
    let pow: fn(&[u8]) -> [u8; 32] = match lane {
        "scrypt" => scrypt_pow_hash,
        _ => |h: &[u8]| sha256d(h),
    };
    let mut parent = vec![0u8; 80];
    parent[0] = 4;
    parent[36..68].copy_from_slice(&sha256d(&cb));
    for n in 0u32.. {
        parent[76..80].copy_from_slice(&n.to_le_bytes());
        if hash_meets_target(&pow(&parent), bits, limit) {
            break;
        }
    }
    block.aux_pow = Some(AuxPow {
        parent_algo: lane.into(),
        parent_header: parent,
        parent_coinbase: cb,
        coinbase_branch: vec![],
        chain_branch: vec![],
        chain_index: 0,
    });
    block
}

/// Assert every bounded index agrees with the whole-chain implementation it
/// replaced, for every lane this chain accepts — including lanes that have
/// never produced a block, which is where a fixed-window bound goes wrong.
fn assert_indexes_match_fullscan(chain: &Chain, ctx: &str) {
    for lane in chain.lanes() {
        assert_eq!(
            chain.next_bits_for(lane),
            chain.next_bits_for_fullscan(lane),
            "{ctx}: per-lane LWMA disagrees with the full-chain scan for lane \
             {lane}. This is a chain split: `header.bits` is enforced against \
             this value."
        );
        assert_eq!(
            chain.next_bits_coupled(lane),
            chain.next_bits_coupled_fullscan(lane),
            "{ctx}: coupled LWMA disagrees with the full-chain scan for lane \
             {lane}"
        );
    }
    assert_eq!(
        chain.total_work(),
        chain.recompute_total_work(),
        "{ctx}: work_prefix disagrees with a full fold over every block. The \
         fork-choice decision is made on this number."
    );
}

#[test]
fn bounded_retarget_matches_the_full_scan_at_every_height() {
    // A deliberately lopsided lane mix: sha256d carries most blocks, scrypt
    // appears rarely, and the other eight lanes never appear at all. The rare
    // and absent lanes are the point — that is where "take the last 18 blocks"
    // silently returns the wrong answer.
    let addr = [11u8; 32];
    let mut chain = Chain::new(ChainParams::regtest());
    let (genesis, _) = mine_block(&chain, addr, &[]).expect("genesis");
    let t0 = genesis.header.time as i64;
    chain.connect_block(genesis).expect("genesis connects");
    assert_indexes_match_fullscan(&chain, "height 0");

    // 9 s of block spacing with sha256d on ~9 of every 10 blocks puts that
    // lane's own blocks ~10 s apart, which is the cadence that holds it at
    // pow_limit. scrypt's lane spacing works out to ~90 s, so its target is
    // clamped to pow_limit — also cheap to grind.
    for i in 1..260usize {
        let lane = if i % 10 == 0 { "scrypt" } else { "sha256d" };
        let b = aux_block_at(&chain, addr, lane, t0 + i as i64 * 9);
        chain.connect_block(b).unwrap_or_else(|e| panic!("block {i} ({lane}): {e}"));
        assert_indexes_match_fullscan(&chain, &format!("height {i} (just added {lane})"));
    }

    // The mix has to be real, or the idle-lane case was never exercised.
    let mut counts = std::collections::HashMap::new();
    for b in &chain.blocks {
        *counts.entry(Chain::lane_of(b)).or_insert(0usize) += 1;
    }
    assert!(counts["sha256d"] > 200, "sha256d should dominate: {counts:?}");
    assert!(counts["scrypt"] >= 25, "scrypt should be rare but present: {counts:?}");
    assert_eq!(counts.get("x11"), None, "x11 must stay idle for this test to mean anything");
}

#[test]
fn bounded_retarget_matches_the_full_scan_across_a_decay_window() {
    // `next_bits_for_at` adds the quiet-lane decay, which is a function of the
    // candidate's own timestamp rather than of the chain. The bounded index has
    // to be right for timestamps far past the last block too — that is the path
    // a miner takes when a lane has gone silent.
    let addr = [12u8; 32];
    let mut chain = Chain::new(ChainParams::regtest());
    let (genesis, _) = mine_block(&chain, addr, &[]).expect("genesis");
    let t0 = genesis.header.time as i64;
    chain.connect_block(genesis).expect("genesis connects");
    for i in 1..40usize {
        let b = aux_block_at(&chain, addr, "sha256d", t0 + i as i64 * LANE_SPACING);
        chain.connect_block(b).expect("connects");
    }

    let tip_time = chain.blocks.last().unwrap().header.time as i64;
    for ahead in [0i64, 1, 60, 600, 3600, 86_400, 7 * 86_400] {
        let ts = tip_time + ahead;
        for lane in chain.lanes() {
            // `next_bits_for_at` is the enforced function; it composes the
            // bounded LWMA with the decay. Recomputing it from the full-scan
            // LWMA must give the same answer, or a miner and a validator
            // disagree about a silent lane.
            let bounded = chain.next_bits_for_at(lane, ts);
            let recomputed = chain.next_bits_for_at_via_fullscan(lane, ts);
            assert_eq!(
                bounded, recomputed,
                "lane {lane} at tip+{ahead}s: decay applied to the bounded LWMA \
                 disagrees with decay applied to the full-chain scan"
            );
        }
    }
}

#[test]
fn replaying_from_a_retained_prefix_equals_a_from_genesis_rebuild() {
    // The property the bounded reorg rests on, at the `Chain` level and
    // independent of p2p: a chain cloned at height k and replayed forward is
    // indistinguishable from one built from genesis over the same blocks.
    //
    // Offsets cover every residue class mod 32 (the snapshot interval) so an
    // off-by-one in the snapshot arithmetic cannot hide in an aligned case.
    let addr = [13u8; 32];
    let mut chain = Chain::new(ChainParams::regtest());
    let (genesis, _) = mine_block(&chain, addr, &[]).expect("genesis");
    let t0 = genesis.header.time as i64;
    chain.connect_block(genesis).expect("genesis connects");
    for i in 1..200usize {
        let lane = if i % 10 == 0 { "scrypt" } else { "sha256d" };
        let b = aux_block_at(&chain, addr, lane, t0 + i as i64 * 9);
        chain.connect_block(b).expect("connects");
    }
    let params = chain.params.clone();
    let all: Vec<Arc<Block>> = chain.blocks.clone();

    for k in [1usize, 2, 31, 32, 33, 64, 65, 97, 128, 159, 160, 191, 199] {
        let base = Chain::from_arc_blocks(params.clone(), all[..k].to_vec())
            .expect("prefix rebuilds");
        let mut replayed = base.clone();
        for b in &all[k..] {
            replayed.connect_block_arc(Arc::clone(b)).expect("replays");
        }
        let reference = Chain::from_arc_blocks(params.clone(), all.clone())
            .expect("reference rebuilds");

        assert_eq!(replayed.blocks.len(), reference.blocks.len(), "height from k={k}");
        assert_eq!(replayed.tip_hash(), reference.tip_hash(), "tip from k={k}");
        assert_eq!(replayed.total_work(), reference.total_work(), "work from k={k}");
        assert_eq!(
            replayed.state_fingerprint(),
            reference.state_fingerprint(),
            "state from k={k}: replaying forward from a retained prefix produced \
             a different state than a from-genesis rebuild. This is the \
             chain-split case the snapshot reorg would hit."
        );
    }
}

#[test]
fn bounded_retarget_matches_the_full_scan_on_real_mainnet_blocks() {
    // THE ONE THAT ACTUALLY COVERS CONSENSUS AS DEPLOYED.
    //
    // The regtest tests above use two lanes and stay below
    // `cross_algo_activation_height` (53,000 on mainnet), so they never exercise
    // the COUPLED rule as the enforced one, nor the real ten-lane mix, nor the
    // real idle-lane gaps. Only mainnet blocks do, and the divergence that
    // caused this whole investigation lives at heights 53,000-58,000.
    //
    // Opt-in, because it needs a ~605 MB block file this repo does not carry:
    //   BLOCKLE_MAINNET_BLOCKS=/path/to/blocks60k.jsonl \
    //     cargo test -p blockle-chain --release --test reorg_equivalence -- --nocapture
    // Pulled from a node's datadir with `head -n 60001 blocks.jsonl`.
    let Ok(path) = std::env::var("BLOCKLE_MAINNET_BLOCKS") else {
        eprintln!(
            "SKIPPED: set BLOCKLE_MAINNET_BLOCKS to a blocks.jsonl to run the \
             real-chain retarget differential. The regtest differentials above \
             still ran, but they do not cover the coupled rule as enforced."
        );
        return;
    };
    let limit: usize = std::env::var("BLOCKLE_MAINNET_BLOCKS_LIMIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60_001);

    let data = std::fs::read_to_string(&path).expect("read mainnet blocks");
    let blocks: Vec<Block> = data
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(limit)
        .map(|l| serde_json::from_str(l).expect("parse block"))
        .collect();
    drop(data);
    eprintln!("replaying {} real mainnet blocks", blocks.len());

    let params = ChainParams::mainnet();
    let activation = params.cross_algo_activation_height;
    let mut chain = Chain::new(params);
    let mut crossed = false;
    let mut checked = 0usize;
    let mut checked_above_activation = 0usize;

    // WHY THIS SAMPLES INSTEAD OF CHECKING EVERY HEIGHT. The oracle is the
    // whole-chain scan — that is the entire point of it — so it costs O(height)
    // per call, ~24 ms across ten lanes at height 58,000. Checking all 60,001
    // heights would be O(n^2): about 200 hours. So the schedule is dense where
    // the risk is and sparse where it is not:
    //   * every height below 2,000 — the window where the LWMA is still filling
    //     and the lane indexes are shortest and most fragile;
    //   * every height in a band around `cross_algo_activation_height` — the
    //     rule changes there, which is exactly where a bounded index and a full
    //     scan are most likely to part company, and where the raw-vs-weighted
    //     work divergence that stranded two nodes begins;
    //   * every 251st height elsewhere (prime, so it does not resonate with the
    //     32-block snapshot interval or the 17-block LWMA window).
    let dense_lo = activation.saturating_sub(200);
    let dense_hi = activation + 400;
    for (h, b) in blocks.into_iter().enumerate() {
        chain
            .connect_block(b)
            .unwrap_or_else(|e| panic!("real mainnet block {h} failed to connect: {e}"));
        let hh = h as u64;
        if hh >= activation {
            crossed = true;
        }
        let interesting =
            hh < 2_000 || (hh >= dense_lo && hh <= dense_hi) || hh % 251 == 0 || hh + 1 == limit as u64;
        if interesting {
            assert_indexes_match_fullscan(&chain, &format!("mainnet height {h}"));
            checked += 1;
            if hh >= activation {
                checked_above_activation += 1;
            }
        }
    }
    eprintln!(
        "checked {checked} heights against the full-chain oracle ({checked_above_activation} \
         of them at/above the coupling activation height {activation})"
    );
    assert!(
        crossed,
        "the file stopped below cross_algo_activation_height ({activation}), so \
         the coupled rule was never exercised as the enforced one"
    );
    assert!(
        checked_above_activation > 100,
        "only {checked_above_activation} checked heights were at/above the \
         activation height; the coupled rule needs real coverage"
    );
}
