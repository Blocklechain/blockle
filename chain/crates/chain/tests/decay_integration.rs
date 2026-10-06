//! Quiet-lane difficulty decay: once a lane goes silent past the grace
//! window, the difficulty it demands of the next block decays over time, so
//! the chain can't stall at a difficulty nobody can still meet.

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_pow::difficulty::{compact_to_target, target_to_compact};

/// Mine `n` native blocks fast so LWMA tightens the native target below the
/// pow limit — giving the decay something to decay from.
fn tightened_chain(n: usize) -> (Chain, i64) {
    let mut chain = Chain::new(ChainParams::regtest());
    let addr = [7u8; 32];
    let mut last_time = 0i64;
    for _ in 0..n {
        let (block, _) = mine_block(&chain, addr, &[]).expect("mine native");
        last_time = block.header.time as i64;
        chain.connect_block(block).expect("connects");
    }
    (chain, last_time)
}

#[test]
fn quiet_lane_difficulty_decays_past_grace() {
    let (chain, last) = tightened_chain(25);
    let limit = chain.params.pow_limit;

    let base_bits = chain.next_bits_for("native");
    let base = compact_to_target(base_bits).unwrap();
    // Fast mining must have pushed native difficulty below the easiest target.
    assert!(base < limit, "LWMA did not tighten difficulty (base == limit)");

    // Within the grace window the demanded difficulty is unchanged.
    let within = chain.next_bits_for_at("native", last + 5);
    assert_eq!(within, base_bits, "difficulty moved inside the grace window");

    // Well past the grace window it decays — a strictly easier (larger) target.
    let decayed = compact_to_target(chain.next_bits_for_at("native", last + 10_000)).unwrap();
    assert!(decayed > base, "difficulty did not decay after a long silence");
    assert!(decayed <= limit, "decay overshot the pow limit");

    // An effectively unbounded silence decays all the way to the pow limit —
    // this is the cap on inter-block time that keeps the chain alive. Compare
    // compact bits: pow_limit itself isn't exactly 24-bit-mantissa representable.
    let floored_bits = chain.next_bits_for_at("native", last + 1_000_000_000);
    assert_eq!(floored_bits, target_to_compact(limit), "decay did not reach the pow limit");
}
