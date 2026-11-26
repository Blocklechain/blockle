//! THE FETCH GATE MUST NEVER UNDERESTIMATE — the 57999 stall, as a property.
//!
//! The worst bug this codebase has had was a comparison between two different
//! units. `handle_headers` decided whether a peer's announced batch was worth
//! fetching by summing RAW `block_work` over the prefix it would retain plus
//! the announced headers, and comparing that against `Chain::total_work()`,
//! which is ENERGY-WEIGHTED at and above `cross_algo_activation_height`.
//!
//! Below the activation height the two are the same number, so it worked.
//! Above it they drift, and on the real chain the weighted total overtook the
//! raw sum by ~9.8e16 near height 57,000 — more than the ~4.9e16 of raw work a
//! whole 2000-block batch contributes. Every announced batch then scored as
//! lighter forever, the gate took a bare `return`, and a wallet sat at a fixed
//! height reporting "stuck updating". Reinstalling could not help: the blocks
//! are immutable, so the arithmetic comes out the same every time.
//!
//! The fix replaced the raw sum with `work_upto` (the exact weighted work of
//! the retained prefix) plus `header_work_upper_bound` per announced header.
//! Headers CANNOT be weighted exactly — the lane lives in the block body and
//! merge-mined headers are indistinguishable — so the gate asks only "could
//! this possibly be heavier?" and the bound must therefore err HIGH. An
//! overestimate costs one cheap fetch. An underestimate is the stall.
//!
//! That one-sided property is what this file pins. The end-to-end stall itself
//! was reproduced against 60k real mainnet blocks with the `reorgbench`
//! `syncsim` mode (stalls at 57999 from genesis; at 57370 when seeded at the
//! exchange node's observed start height 53371 — that node's real stranded
//! height). Real blocks cannot live in a unit test, so what lives here is the
//! invariant whose violation produced it.

use blockle_chain::{Chain, ChainParams};
use blockle_pow::difficulty::{block_work, energy_work};
use blockle_pow::{energy_coeff, max_energy_coeff, ENERGY_COEFF_SCALE, ENERGY_LANES};

/// Compact-target bits spanning easy to hard, so the bound is checked across
/// the whole range rather than at one convenient difficulty.
const BITS: [u32; 5] = [0x1f00ffff, 0x1e0fffff, 0x1d00ffff, 0x1c00ffff, 0x1b0404cb];

#[test]
fn the_header_bound_dominates_every_lane_at_every_difficulty() {
    /*
     * THE INVARIANT. For a header the gate cannot attribute to a lane, the
     * bound it uses must be >= the weight that header would carry once its
     * body arrives and names ANY lane. The native lane is what made this
     * urgent: its coefficient is 1.0217e15 against sha256d's 5,420 — eleven
     * orders of magnitude — and 2,903 of the 5,000 blocks above the activation
     * height on the real chain were native, which is the entire divergence.
     */
    let max = max_energy_coeff();
    for lane in ENERGY_LANES {
        let coeff = energy_coeff(lane);
        assert!(
            coeff <= max,
            "lane {lane} has energy coefficient {coeff}, above max_energy_coeff() {max} — the \
             fetch gate would underestimate a batch of these headers and could silently refuse \
             to sync past them"
        );
        for bits in BITS {
            let actual = energy_work(bits, coeff, ENERGY_COEFF_SCALE);
            let bound = energy_work(bits, max, ENERGY_COEFF_SCALE);
            assert!(
                actual <= bound,
                "lane {lane} at bits {bits:#x}: weighted work {actual} exceeds the header upper \
                 bound {bound}"
            );
        }
    }
}

#[test]
fn an_unknown_lane_cannot_outweigh_the_bound() {
    // `energy_coeff` falls back to ENERGY_COEFF_SCALE for a lane it does not
    // know, so a future lane added to the matcher but not to ENERGY_LANES is
    // weighted at 1.0x and stays under the bound. If someone adds a lane with
    // a HIGHER coefficient and forgets ENERGY_LANES, the test above fails.
    assert_eq!(energy_coeff("a-lane-that-does-not-exist"), ENERGY_COEFF_SCALE);
    assert!(ENERGY_COEFF_SCALE <= max_energy_coeff());
}

#[test]
fn below_the_activation_height_the_bound_is_exactly_raw_work() {
    /*
     * History must not move. Below the activation height the gate and the
     * chain both use raw `block_work`, so the bound has to be EQUAL, not
     * merely >= — a bound that overestimated down here would make the node
     * fetch forks it can already prove are lighter, on every batch of a
     * from-genesis sync.
     */
    let chain = Chain::new(ChainParams::mainnet());
    let act = ChainParams::mainnet().cross_algo_activation_height;
    assert!(act > 0, "mainnet activates the coupling above genesis");
    for bits in BITS {
        assert_eq!(
            chain.header_work_upper_bound(act - 1, bits),
            block_work(bits),
            "below the activation height the bound must be raw work exactly"
        );
        assert_eq!(
            chain.header_work_upper_bound(act, bits),
            energy_work(bits, max_energy_coeff(), ENERGY_COEFF_SCALE),
            "at the activation height the bound must switch to the weighted maximum"
        );
    }
}

#[test]
fn work_upto_agrees_with_the_chain_total_at_the_tip() {
    // `work_upto(len)` is what the gate uses for the retained prefix; if it
    // disagreed with `total_work()` at the tip, the gate would be comparing
    // against a different chain than the one it holds -- the same class of
    // mismatch, one level down. An empty chain is the degenerate case that
    // must also hold.
    let chain = Chain::new(ChainParams::mainnet());
    assert_eq!(chain.work_upto(0), chain.total_work());
    assert_eq!(chain.work_upto(chain.blocks.len()), chain.total_work());
    // And it must be monotonic, since it is a prefix sum of non-negative work.
    let mut prev = chain.work_upto(0);
    for n in 0..=chain.blocks.len() {
        let w = chain.work_upto(n);
        assert!(w >= prev, "work_upto went backwards at {n}");
        prev = w;
    }
}
