//! Share-target math. A pool sends a float difficulty; the target is
//! `diff1 / difficulty`, where diff1 is the classic pdiff-1 target
//! (0x00000000FFFF0000…0000). A 256-bit PoW hash, read little-endian, wins the
//! share when it is <= target. We use big integers so a fractional difficulty
//! from any pool maps to an exact target (no power-of-two rounding).
use num_bigint::BigUint;
use num_traits::Zero;

const DIFF1_HEX: &[u8] = b"00000000FFFF0000000000000000000000000000000000000000000000000000";

/// Exact share target (big-endian 32 bytes) for a pool difficulty.
pub fn target_from_difficulty(difficulty: f64) -> [u8; 32] {
    let d = if difficulty.is_finite() && difficulty > 0.0 { difficulty } else { 1.0 };
    // 6 decimal places of difficulty precision is plenty for any real pool.
    const SCALE: u64 = 1_000_000;
    let d_scaled = ((d * SCALE as f64).round() as u128).max(1);
    let diff1 = BigUint::parse_bytes(DIFF1_HEX, 16).unwrap();
    let target = (diff1 * BigUint::from(SCALE)) / BigUint::from(d_scaled);
    to_be_32(&target)
}

fn to_be_32(n: &BigUint) -> [u8; 32] {
    if n.is_zero() {
        return [0u8; 32];
    }
    let bytes = n.to_bytes_be();
    if bytes.len() >= 32 {
        // difficulty < 1 would overflow 256 bits — clamp to the maximum target.
        return [0xFFu8; 32];
    }
    let mut be = [0u8; 32];
    be[32 - bytes.len()..].copy_from_slice(&bytes);
    be
}

/// Does this PoW hash (raw digest, interpreted little-endian) meet the target?
pub fn meets_target(hash_le: &[u8; 32], target_be: &[u8; 32]) -> bool {
    let mut be = *hash_le;
    be.reverse();
    be <= *target_be
}
