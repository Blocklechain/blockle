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

#[cfg(test)]
mod tests {
    use super::*;

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
}
