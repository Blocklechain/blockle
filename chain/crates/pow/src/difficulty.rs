//! Compact target encoding (Bitcoin `nBits` style) and LWMA difficulty
//! adjustment, retuned every block.

use primitive_types::U256;

/// Decode a compact-bits value into a 256-bit target.
/// Returns `None` for negative or overflowing encodings.
pub fn compact_to_target(bits: u32) -> Option<U256> {
    let size = bits >> 24;
    let word = bits & 0x007f_ffff;
    if bits & 0x0080_0000 != 0 {
        return None; // sign bit set — never valid for a target
    }
    if word == 0 {
        return Some(U256::zero());
    }
    if size <= 3 {
        Some(U256::from(word >> (8 * (3 - size))))
    } else {
        let shift = 8 * (size - 3);
        if shift > 255 {
            return None;
        }
        let target = U256::from(word) << shift;
        // Reject encodings that lost bits in the shift.
        if (target >> shift).low_u32() != word {
            return None;
        }
        Some(target)
    }
}

/// Approximate a U256 as f64 (keeps the top ~52 significant bits).
fn u256_to_f64(x: U256) -> f64 {
    let bits = x.bits();
    if bits == 0 {
        return 0.0;
    }
    if bits <= 52 {
        return x.low_u64() as f64;
    }
    let shift = bits - 52;
    (x >> shift).low_u64() as f64 * 2f64.powi(shift as i32)
}

/// Standardized difficulty for a compact-bits value: `pow_limit / target`
/// (1.0 at the easiest allowed target, higher as the target tightens). This is
/// the Bitcoin-style difficulty metric, per-lane since each lane sets its own
/// bits. Returns 0.0 for a degenerate target.
pub fn difficulty_from_bits(bits: u32, pow_limit: U256) -> f64 {
    match compact_to_target(bits) {
        Some(target) if !target.is_zero() => u256_to_f64(pow_limit) / u256_to_f64(target),
        _ => 0.0,
    }
}

/// Encode a 256-bit target into compact bits.
pub fn target_to_compact(target: U256) -> u32 {
    let mut size = (target.bits() as u32 + 7) / 8;
    let mut compact = if size <= 3 {
        (target.low_u64() << (8 * (3 - size))) as u32
    } else {
        (target >> (8 * (size - 3))).low_u32()
    };
    if compact & 0x0080_0000 != 0 {
        compact >>= 8;
        size += 1;
    }
    compact | (size << 24)
}

/// Expected work to produce one block at these bits: `2^256 / (target + 1)`.
/// Fork choice sums this over a chain and prefers the larger total.
pub fn block_work(bits: u32) -> U256 {
    match compact_to_target(bits) {
        Some(target) if !target.is_zero() => {
            if target == U256::MAX {
                U256::one()
            } else {
                (!target) / (target + U256::one()) + U256::one()
            }
        }
        _ => U256::zero(),
    }
}

/// Interpret a 32-byte hash as a little-endian integer (Bitcoin/Zcash
/// convention, which ASIC and pool tooling assume) and compare to the target.
pub fn hash_meets_target(hash: &[u8; 32], bits: u32, pow_limit: U256) -> bool {
    match compact_to_target(bits) {
        Some(target) if target <= pow_limit && !target.is_zero() => {
            U256::from_little_endian(hash) <= target
        }
        _ => false,
    }
}

/// LWMA (linearly weighted moving average) next-target calculation.
///
/// `headers` are `(bits, timestamp)` pairs for the chain tip's most recent
/// blocks, oldest first. Until `window + 1` headers exist, the chain stays at
/// `pow_limit`. Solve times are clamped to `[1, 6 * spacing]` so timestamp
/// games and long gaps cannot swing difficulty unboundedly.
pub fn lwma_next_bits(
    spacing: u64,
    window: usize,
    pow_limit: U256,
    headers: &[(u32, i64)],
) -> u32 {
    if headers.len() < window + 1 {
        return target_to_compact(pow_limit);
    }
    let recent = &headers[headers.len() - (window + 1)..];

    let mut weighted_solvetime: u128 = 0;
    let mut avg_target = U256::zero();
    for i in 1..=window {
        let solvetime = (recent[i].1 - recent[i - 1].1).clamp(1, (6 * spacing) as i64);
        weighted_solvetime += solvetime as u128 * i as u128;
        let target = compact_to_target(recent[i].0).unwrap_or(pow_limit);
        avg_target = avg_target + target / U256::from(window as u64);
    }

    // next = avg_target * weighted_solvetime / (spacing * window*(window+1)/2)
    // Divide before multiplying so the intermediate can't overflow 256 bits;
    // the precision loss is far below one compact-bits ulp.
    let denom = spacing as u128 * (window as u128 * (window as u128 + 1) / 2);
    let mut next = (avg_target / U256::from(denom))
        .checked_mul(U256::from(weighted_solvetime))
        .unwrap_or(U256::MAX);
    if next > pow_limit || next.is_zero() {
        next = pow_limit;
    }
    target_to_compact(next)
}

/// Quiet-lane difficulty decay. `base` is the LWMA target for the lane; `gap`
/// is (candidate block time − last block time on that lane). Within `grace`
/// seconds the base target is returned unchanged. Past the grace window the
/// target doubles (difficulty halves) once per `halflife` seconds of overdue
/// time, capped at `pow_limit`.
///
/// This caps the practical inter-block time: when hashrate leaves and a lane
/// goes quiet, its required difficulty decays until a block becomes findable
/// again — so the chain cannot stall indefinitely at a difficulty nobody can
/// still meet.
pub fn decayed_target(base: U256, pow_limit: U256, gap: i64, grace: u64, halflife: u64) -> U256 {
    let base = if base > pow_limit { pow_limit } else { base };
    if gap <= 0 {
        return base;
    }
    let gap = gap as u64;
    if gap <= grace {
        return base;
    }
    let steps = (gap - grace) / halflife.max(1);
    let mut t = base;
    for _ in 0..steps {
        let doubled = t << 1;
        // Stop at the limit (and guard the wraparound at 2^256).
        if doubled >= pow_limit || doubled < t {
            return pow_limit;
        }
        t = doubled;
    }
    if t > pow_limit {
        pow_limit
    } else {
        t
    }
}

/// [`decayed_target`] in compact-bits form, decoding `base_bits` first.
pub fn decayed_next_bits(
    base_bits: u32,
    pow_limit: U256,
    gap: i64,
    grace: u64,
    halflife: u64,
) -> u32 {
    let base = compact_to_target(base_bits).unwrap_or(pow_limit);
    target_to_compact(decayed_target(base, pow_limit, gap, grace, halflife))
}

// ----------------------------------------------------------------------------
// Cross-algorithm difficulty coupling (energy-weighted), activated by height in
// the chain layer. See docs/CROSS-ALGO-COUPLING.md.
//
// The independent per-lane LWMA above drives every lane to the SAME block share
// regardless of how much real energy backs it — so a lane mined by an ultra-
// efficient ASIC earns as much as one mined by power-hungry hardware. The
// coupling fixes that: each lane carries a benchmark-derived "energy per hash"
// coefficient (see `crate::energy_coeff`), and all lanes are retargeted from one
// shared base difficulty scaled by that coefficient. A lane must then expend the
// same REAL ENERGY per block as every other lane, so block production — and thus
// reward and security weight — tracks actual power draw, not raw hashrate.
// ----------------------------------------------------------------------------

/// Overflow-safe `a * mul / div` for a 256-bit target. Multiplies first when the
/// product fits (exact); otherwise divides first, losing a few low bits — far
/// below one compact-bits ulp, and fully deterministic either way. The result is
/// clamped to `pow_limit` and never returned as zero (a zero target is
/// unmineable). `div == 0` yields `pow_limit`.
fn mul_div_target(a: U256, mul: u64, div: u64, pow_limit: U256) -> U256 {
    if div == 0 {
        return pow_limit;
    }
    let m = U256::from(mul);
    let d = U256::from(div);
    let r = match a.checked_mul(m) {
        Some(prod) => prod / d,
        None => (a / d).saturating_mul(m),
    };
    let r = if r > pow_limit { pow_limit } else { r };
    if r.is_zero() {
        U256::one()
    } else {
        r
    }
}

/// Bring a lane's target into the shared "reference frame" by dividing out its
/// energy coefficient: `target * scale / coeff`. A cheap-energy lane (small
/// coeff) normalises UP; an expensive one normalises DOWN — so a single base
/// target can describe them all.
pub fn normalize_target(target: U256, coeff: u64, scale: u64, pow_limit: U256) -> U256 {
    mul_div_target(target, scale, coeff, pow_limit)
}

/// Inverse of [`normalize_target`]: map the shared base target back onto a lane's
/// own target by re-applying its energy coefficient: `base * coeff / scale`.
pub fn denormalize_target(base: U256, coeff: u64, scale: u64, pow_limit: U256) -> U256 {
    mul_div_target(base, coeff, scale, pow_limit)
}

/// Energy-weighted work of a block for fork choice: `block_work * coeff / scale`.
/// Once coupling is active the heaviest chain is the one backed by the most real
/// power, not the one with the most raw hashes.
pub fn energy_work(bits: u32, coeff: u64, scale: u64) -> U256 {
    mul_div_target(block_work(bits), coeff, scale, U256::MAX)
}

/// Cross-algorithm **coupled** LWMA. Unlike [`lwma_next_bits`] (one lane, its own
/// blocks, slow per-lane spacing), this retargets a SINGLE shared base target
/// over the most recent blocks across ALL lanes at the whole-chain `spacing`,
/// weighting each block by its energy coefficient. The returned bits are that
/// base re-scaled to `lane_coeff`, so an efficient lane must out-hash an
/// inefficient one by exactly the ratio of their energy-per-hash — equalising
/// power draw per block.
///
/// `headers` are `(bits, timestamp, coeff)` for the tip's most recent blocks,
/// oldest first, interleaved across lanes in chain order.
pub fn lwma_coupled_next_bits(
    spacing: u64,
    window: usize,
    pow_limit: U256,
    scale: u64,
    headers: &[(u32, i64, u64)],
    lane_coeff: u64,
) -> u32 {
    if headers.len() < window + 1 {
        return target_to_compact(pow_limit);
    }
    let recent = &headers[headers.len() - (window + 1)..];

    let mut weighted_solvetime: u128 = 0;
    let mut avg_base = U256::zero();
    for i in 1..=window {
        let solvetime = (recent[i].1 - recent[i - 1].1).clamp(1, (6 * spacing) as i64);
        weighted_solvetime += solvetime as u128 * i as u128;
        let nt = normalize_target(
            compact_to_target(recent[i].0).unwrap_or(pow_limit),
            recent[i].2,
            scale,
            pow_limit,
        );
        avg_base = avg_base + nt / U256::from(window as u64);
    }

    // Same LWMA shape as `lwma_next_bits`, but on the normalised base target and
    // the whole-chain spacing. Divide before multiplying to keep the 256-bit
    // intermediate from overflowing.
    let denom = spacing as u128 * (window as u128 * (window as u128 + 1) / 2);
    let mut next_base = (avg_base / U256::from(denom))
        .checked_mul(U256::from(weighted_solvetime))
        .unwrap_or(U256::MAX);
    if next_base > pow_limit || next_base.is_zero() {
        next_base = pow_limit;
    }
    let expected = denormalize_target(next_base, lane_coeff, scale, pow_limit);
    target_to_compact(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCALE: u64 = 1_000_000;

    fn limit() -> U256 {
        U256::MAX >> 4
    }

    #[test]
    fn compact_roundtrip() {
        for target in [
            U256::from(1u64),
            U256::from(0xffff_u64) << 208, // Bitcoin's powLimit shape
            limit(),
            U256::from(123_456_789u64),
        ] {
            let bits = target_to_compact(target);
            let back = compact_to_target(bits).unwrap();
            // Compact encoding keeps ~3 bytes of precision; roundtrip of an
            // already-compact value must be exact.
            assert_eq!(target_to_compact(back), bits);
        }
    }

    #[test]
    fn rejects_negative_bits() {
        assert_eq!(compact_to_target(0x0480_0001), None);
    }

    #[test]
    fn work_is_monotonic_in_difficulty() {
        let easy = block_work(target_to_compact(limit()));
        let hard = block_work(target_to_compact(limit() >> 8));
        assert!(hard > easy);
        assert!(easy >= U256::one());
        assert_eq!(block_work(0x0480_0001), U256::zero()); // invalid bits
    }

    #[test]
    fn hash_comparison() {
        let bits = target_to_compact(limit());
        assert!(hash_meets_target(&[0u8; 32], bits, limit()));
        assert!(!hash_meets_target(&[0xff; 32], bits, limit()));
    }

    #[test]
    fn lwma_stays_at_limit_until_window_fills() {
        let bits = lwma_next_bits(600, 17, limit(), &[(0x1f00ffff, 0); 5]);
        assert_eq!(bits, target_to_compact(limit()));
    }

    #[test]
    fn lwma_tightens_on_fast_blocks() {
        let limit_bits = target_to_compact(limit());
        // 18 headers, one second apart — far faster than the 600s target.
        let headers: Vec<(u32, i64)> = (0..18).map(|i| (limit_bits, i as i64)).collect();
        let next = lwma_next_bits(600, 17, limit(), &headers);
        let next_target = compact_to_target(next).unwrap();
        assert!(next_target < limit());
    }

    #[test]
    fn lwma_holds_steady_on_target_spacing() {
        let limit_bits = target_to_compact(limit());
        let headers: Vec<(u32, i64)> = (0..18).map(|i| (limit_bits, i as i64 * 600)).collect();
        let next = lwma_next_bits(600, 17, limit(), &headers);
        let next_target = compact_to_target(next).unwrap();
        // On-target solvetimes keep difficulty within a whisker of current.
        assert!(next_target >= limit() >> 1);
    }

    #[test]
    fn decay_is_a_noop_within_grace() {
        let base = limit() >> 20; // a hard target
        assert_eq!(decayed_target(base, limit(), 500, 1000, 100), base);
        assert_eq!(decayed_target(base, limit(), 1000, 1000, 100), base);
    }

    #[test]
    fn decay_halves_difficulty_per_halflife() {
        let base = limit() >> 20;
        // 3 halflifes past grace → target doubles 3× (difficulty /8).
        let t = decayed_target(base, limit(), 1000 + 3 * 100, 1000, 100);
        assert_eq!(t, base << 3);
    }

    #[test]
    fn decay_caps_at_pow_limit() {
        let base = limit() >> 8;
        // A very long silence can never exceed the easiest allowed target.
        let t = decayed_target(base, limit(), 1_000_000, 1000, 100);
        assert_eq!(t, limit());
        // And compact form round-trips to the limit's bits.
        assert_eq!(
            decayed_next_bits(target_to_compact(base), limit(), 1_000_000, 1000, 100),
            target_to_compact(limit())
        );
    }

    #[test]
    fn decay_never_raises_difficulty() {
        // A base already at the limit stays at the limit (can't get easier).
        assert_eq!(decayed_target(limit(), limit(), 1_000_000, 1000, 100), limit());
    }

    // ---- cross-algorithm coupling ------------------------------------------

    #[test]
    fn normalize_roundtrips_within_compact_precision() {
        let target = limit() >> 30; // a mid-range target
        for coeff in [5_420u64, 464_400, 1_535_600, 111_460_000] {
            let nt = normalize_target(target, coeff, SCALE, limit());
            let back = denormalize_target(nt, coeff, SCALE, limit());
            // round-trip is exact to within one compact-bits encoding.
            assert_eq!(target_to_compact(back), target_to_compact(target), "coeff {coeff}");
        }
    }

    #[test]
    fn energy_work_scales_with_coefficient() {
        let bits = target_to_compact(limit() >> 20);
        let cheap = energy_work(bits, 5_420, SCALE); // efficient lane
        let dear = energy_work(bits, 1_000_000, SCALE); // median lane
        // Same raw work, but the higher-energy-coefficient block counts for more.
        assert!(dear > cheap);
    }

    #[test]
    fn coupled_targets_scale_with_energy_coefficient() {
        // Build window+1 blocks across "lanes", all at the limit, on-spacing.
        // Every block was normalised from the median coeff for this test.
        let limit_bits = target_to_compact(limit());
        let headers: Vec<(u32, i64, u64)> =
            (0..18).map(|i| (limit_bits, i as i64 * 600, SCALE)).collect();

        let eff = lwma_coupled_next_bits(600, 17, limit(), SCALE, &headers, 5_420); // efficient
        let dear = lwma_coupled_next_bits(600, 17, limit(), SCALE, &headers, 111_460_000); // scrypt-class
        let t_eff = compact_to_target(eff).unwrap();
        let t_dear = compact_to_target(dear).unwrap();
        // The efficient lane gets a TIGHTER target (must do more hashes); the
        // energy-hungry lane gets an easier one — equalising energy per block.
        assert!(t_eff < t_dear, "efficient lane must be harder: {t_eff} vs {t_dear}");
    }

    #[test]
    fn coupled_stays_at_limit_until_window_fills() {
        let bits = lwma_coupled_next_bits(600, 17, limit(), SCALE, &[(0x1f00ffff, 0, SCALE); 5], 5_420);
        assert_eq!(bits, target_to_compact(limit()));
    }

    #[test]
    fn coupled_tightens_on_fast_blocks() {
        let limit_bits = target_to_compact(limit());
        // 18 blocks one second apart — far faster than the 600s whole-chain target.
        let headers: Vec<(u32, i64, u64)> =
            (0..18).map(|i| (limit_bits, i as i64, SCALE)).collect();
        let next = lwma_coupled_next_bits(600, 17, limit(), SCALE, &headers, SCALE);
        assert!(compact_to_target(next).unwrap() < limit());
    }
}
