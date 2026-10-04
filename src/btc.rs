//! Bitcoin-family primitives: double-SHA256, compact difficulty targets,
//! varints, byte-order helpers, coinbase construction, and merkle branches —
//! everything a stratum v1 pool needs to assemble and validate work.

use sha2::{Digest, Sha256};

/// Double SHA-256.
pub fn dsha256(data: &[u8]) -> [u8; 32] {
    let h1 = Sha256::digest(data);
    let h2 = Sha256::digest(h1);
    h2.into()
}

/// 256-bit big-endian target.
pub type Target = [u8; 32];

/// Difficulty-1 target (Bitcoin's `0x1d00ffff`): 0xffff << 208.
pub fn diff1_target() -> Target {
    let mut t = [0u8; 32];
    t[4] = 0xff;
    t[5] = 0xff;
    t
}

/// Decode compact bits into a big-endian target.
pub fn compact_to_target(bits: u32) -> Target {
    let size = (bits >> 24) as usize;
    let word = bits & 0x007f_ffff;
    let mut t = [0u8; 32];
    let bytes = word.to_be_bytes(); // [0, b1, b2, b3]
    for i in 0..3 {
        let pos = 32usize.checked_sub(size).map(|p| p + i);
        if let Some(pos) = pos {
            if pos < 32 {
                t[pos] = bytes[i + 1];
            }
        }
    }
    t
}

/// Target for share difficulty 2^k. Negative k means difficulty below 1
/// (easier than diff1 — stratum difficulty is allowed to be fractional).
pub fn share_target(k: i32) -> Target {
    if k >= 0 {
        shift_right(diff1_target(), k as u32)
    } else {
        shift_left(diff1_target(), (-k) as u32)
    }
}

pub fn shift_left(t: Target, bits: u32) -> Target {
    let mut out = [0u8; 32];
    let byte_shift = (bits / 8) as usize;
    let bit_shift = bits % 8;
    for i in 0..32 {
        let src = i + byte_shift;
        if src >= 32 {
            continue;
        }
        let mut v = t[src] << bit_shift;
        if bit_shift > 0 && src + 1 < 32 {
            v |= t[src + 1] >> (8 - bit_shift);
        }
        out[i] = v;
    }
    // Saturate: if we shifted meaningful bits off the top, use the max target.
    let dropped = (0..byte_shift.min(32)).any(|i| t[i] != 0);
    if dropped {
        return [0xff; 32];
    }
    out
}

pub fn shift_right(t: Target, bits: u32) -> Target {
    let mut out = [0u8; 32];
    let byte_shift = (bits / 8) as usize;
    let bit_shift = bits % 8;
    for i in (0..32).rev() {
        if i < byte_shift {
            continue;
        }
        let src = i - byte_shift;
        let mut v = t[src] >> bit_shift;
        if bit_shift > 0 && src > 0 {
            v |= t[src - 1] << (8 - bit_shift);
        }
        out[i] = v;
    }
    out
}

/// Numeric comparison of a double-SHA256 block hash (internal byte order,
/// i.e. little-endian) against a big-endian target.
pub fn hash_meets_target(hash_le: &[u8; 32], target: &Target) -> bool {
    let mut be = *hash_le;
    be.reverse();
    &be[..] <= &target[..]
}

/// Approximate numeric value of a target (for difficulty ratios).
pub fn target_to_f64(t: &Target) -> f64 {
    let mut v = 0.0f64;
    for &b in t.iter() {
        v = v * 256.0 + b as f64;
    }
    v
}

/// Network difficulty implied by a block target (relative to difficulty 1).
pub fn network_difficulty(block_target: &Target) -> f64 {
    let bt = target_to_f64(block_target);
    if bt <= 0.0 {
        return 1.0;
    }
    (target_to_f64(&diff1_target()) / bt).max(1e-12)
}

/// Bitcoin varint (compactsize).
pub fn varint(n: u64) -> Vec<u8> {
    match n {
        0..=0xfc => vec![n as u8],
        0xfd..=0xffff => {
            let mut v = vec![0xfd];
            v.extend_from_slice(&(n as u16).to_le_bytes());
            v
        }
        0x1_0000..=0xffff_ffff => {
            let mut v = vec![0xfe];
            v.extend_from_slice(&(n as u32).to_le_bytes());
            v
        }
        _ => {
            let mut v = vec![0xff];
            v.extend_from_slice(&n.to_le_bytes());
            v
        }
    }
}

/// RPC display hex (big-endian) → internal little-endian bytes.
pub fn display_to_le(hex_str: &str) -> Option<[u8; 32]> {
    let mut b: [u8; 32] = hex::decode(hex_str).ok()?.try_into().ok()?;
    b.reverse();
    Some(b)
}

pub fn le_to_display(le: &[u8; 32]) -> String {
    let mut b = *le;
    b.reverse();
    hex::encode(b)
}

/// Stratum v1 prevhash encoding: little-endian bytes with each 32-bit word
/// byte-swapped.
pub fn stratum_prevhash(le: &[u8; 32]) -> String {
    let mut out = [0u8; 32];
    for (i, chunk) in le.chunks(4).enumerate() {
        out[i * 4] = chunk[3];
        out[i * 4 + 1] = chunk[2];
        out[i * 4 + 2] = chunk[1];
        out[i * 4 + 3] = chunk[0];
    }
    hex::encode(out)
}

/// BIP34 height push for the coinbase script.
pub fn height_script(height: u64) -> Vec<u8> {
    let mut le = height.to_le_bytes().to_vec();
    while le.len() > 1 && *le.last().unwrap() == 0 {
        le.pop();
    }
    // Avoid the sign bit being interpreted as negative.
    if le.last().map(|b| b & 0x80 != 0).unwrap_or(false) {
        le.push(0);
    }
    let mut out = vec![le.len() as u8];
    out.extend_from_slice(&le);
    out
}

/// Build the two coinbase halves for stratum: the extranonce
/// (extranonce1 ‖ extranonce2) is spliced between them by the miner.
pub fn coinbase_parts(
    height: u64,
    extranonce_len: usize,
    tag: &[u8],
    value: u64,
    payout_script: &[u8],
) -> (Vec<u8>, Vec<u8>) {
    let script_prefix = {
        let mut s = height_script(height);
        s.extend_from_slice(tag);
        s
    };
    let script_len = script_prefix.len() + extranonce_len;
    assert!(script_len <= 100, "coinbase script too long");

    let mut coinb1 = Vec::new();
    coinb1.extend_from_slice(&1u32.to_le_bytes()); // tx version
    coinb1.push(1); // input count
    coinb1.extend_from_slice(&[0u8; 32]); // null prevout hash
    coinb1.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // prevout index
    coinb1.push(script_len as u8);
    coinb1.extend_from_slice(&script_prefix);
    // … extranonce goes here …
    let mut coinb2 = Vec::new();
    coinb2.extend_from_slice(&0xffff_ffffu32.to_le_bytes()); // sequence
    coinb2.push(1); // output count
    coinb2.extend_from_slice(&value.to_le_bytes());
    coinb2.extend_from_slice(&varint(payout_script.len() as u64));
    coinb2.extend_from_slice(payout_script);
    coinb2.extend_from_slice(&0u32.to_le_bytes()); // locktime
    (coinb1, coinb2)
}

/// Stratum merkle branch for the coinbase (leaf 0): fold the coinbase txid
/// through these to get the merkle root.
/// `txids_le` are the non-coinbase txids in internal byte order.
pub fn merkle_branch(txids_le: &[[u8; 32]]) -> Vec<[u8; 32]> {
    let mut branch = Vec::new();
    let mut layer: Vec<[u8; 32]> = txids_le.to_vec();
    while !layer.is_empty() {
        branch.push(layer[0]);
        let rest = &layer[1..];
        let mut next = Vec::new();
        let mut i = 0;
        while i < rest.len() {
            let a = rest[i];
            let b = if i + 1 < rest.len() { rest[i + 1] } else { rest[i] };
            let mut data = [0u8; 64];
            data[..32].copy_from_slice(&a);
            data[32..].copy_from_slice(&b);
            next.push(dsha256(&data));
            i += 2;
        }
        layer = next;
    }
    branch
}

/// Fold a coinbase txid through a merkle branch to the root (all LE).
pub fn merkle_root_from_branch(coinbase_txid_le: [u8; 32], branch: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = coinbase_txid_le;
    for node in branch {
        let mut data = [0u8; 64];
        data[..32].copy_from_slice(&acc);
        data[32..].copy_from_slice(node);
        acc = dsha256(&data);
    }
    acc
}

/// Assemble an 80-byte header from LE-ready components.
pub fn header_bytes(
    version: u32,
    prev_le: &[u8; 32],
    merkle_le: &[u8; 32],
    ntime: u32,
    nbits: u32,
    nonce: u32,
) -> [u8; 80] {
    let mut h = [0u8; 80];
    h[0..4].copy_from_slice(&version.to_le_bytes());
    h[4..36].copy_from_slice(prev_le);
    h[36..68].copy_from_slice(merkle_le);
    h[68..72].copy_from_slice(&ntime.to_le_bytes());
    h[72..76].copy_from_slice(&nbits.to_le_bytes());
    h[76..80].copy_from_slice(&nonce.to_le_bytes());
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_roundtrips_known_values() {
        // Bitcoin's difficulty-1 bits.
        let t = compact_to_target(0x1d00ffff);
        assert_eq!(t, diff1_target());
        // An easy regtest-style target: 0x207fffff → 0x7fffff << (8*(32-3))
        let t = compact_to_target(0x207fffff);
        assert_eq!(t[0], 0x7f);
        assert_eq!(t[1], 0xff);
        assert_eq!(t[2], 0xff);
        assert!(t[3..].iter().all(|&b| b == 0));
    }

    #[test]
    fn share_targets_halve() {
        let d1 = share_target(0);
        let d2 = share_target(1);
        assert_eq!(d1, diff1_target());
        assert_eq!(d2[4], 0x7f);
        assert_eq!(d2[5], 0xff);
        assert_eq!(d2[6], 0x80);
    }

    #[test]
    fn varints() {
        assert_eq!(varint(0), vec![0]);
        assert_eq!(varint(0xfc), vec![0xfc]);
        assert_eq!(varint(0xfd), vec![0xfd, 0xfd, 0x00]);
        assert_eq!(varint(0x10000), vec![0xfe, 0, 0, 1, 0]);
    }

    #[test]
    fn height_scripts() {
        assert_eq!(height_script(1), vec![1, 1]);
        assert_eq!(height_script(0x80), vec![2, 0x80, 0x00]);
        assert_eq!(height_script(0x1234), vec![2, 0x34, 0x12]);
    }

    #[test]
    fn merkle_branch_folds_to_root() {
        // Tree over [cb, t1, t2, t3]: root = dsha(dsha(cb‖t1) ‖ dsha(t2‖t3)).
        let cb = [1u8; 32];
        let t1 = [2u8; 32];
        let t2 = [3u8; 32];
        let t3 = [4u8; 32];
        let branch = merkle_branch(&[t1, t2, t3]);
        assert_eq!(branch.len(), 2);
        let via_branch = merkle_root_from_branch(cb, &branch);

        let pair = |a: [u8; 32], b: [u8; 32]| {
            let mut d = [0u8; 64];
            d[..32].copy_from_slice(&a);
            d[32..].copy_from_slice(&b);
            dsha256(&d)
        };
        let expected = pair(pair(cb, t1), pair(t2, t3));
        assert_eq!(via_branch, expected);
    }

    #[test]
    fn hash_target_comparison() {
        let easy = compact_to_target(0x207fffff);
        assert!(hash_meets_target(&[0u8; 32], &easy));
        let mut high = [0u8; 32];
        high[31] = 0xff; // LE: top byte of the BE value
        assert!(!hash_meets_target(&high, &easy));
    }

    #[test]
    fn stratum_prevhash_word_swaps() {
        let mut le = [0u8; 32];
        le[0] = 0xaa;
        le[1] = 0xbb;
        le[2] = 0xcc;
        le[3] = 0xdd;
        let s = stratum_prevhash(&le);
        assert!(s.starts_with("ddccbbaa"));
    }
}

// MERGED MINING (AuxPoW)
// ================================================================================================

/// Magic prefix marking the merged-mining commitment in a parent coinbase.
pub const MM_MAGIC: [u8; 4] = [0xfa, 0xbe, b'm', b'm'];

/// Slot of an aux chain in the aux merkle tree (Namecoin's expected-index
/// derivation with nonce 0).
pub fn aux_slot(chain_id: u32, tree_size: u32, nonce: u32) -> u32 {
    let mut rand = nonce;
    rand = rand.wrapping_mul(1103515245).wrapping_add(12345);
    rand = rand.wrapping_add(chain_id);
    rand = rand.wrapping_mul(1103515245).wrapping_add(12345);
    rand % tree_size
}

/// Build the aux merkle tree: returns (root, per-slot leaves) for the given
/// (chain_id, aux_hash) pairs. Tree size = next power of two covering the
/// highest occupied slot; empty slots are zero.
pub fn aux_tree(entries: &[(u32, [u8; 32])]) -> ([u8; 32], Vec<[u8; 32]>, u32) {
    let mut size = 1u32;
    loop {
        let mut slots: Vec<Option<usize>> = vec![None; size as usize];
        let mut ok = true;
        for (i, (chain_id, _)) in entries.iter().enumerate() {
            let s = aux_slot(*chain_id, size, 0) as usize;
            if slots[s].is_some() {
                ok = false;
                break;
            }
            slots[s] = Some(i);
        }
        if ok {
            let mut leaves = vec![[0u8; 32]; size as usize];
            for (s, e) in slots.iter().enumerate() {
                if let Some(i) = e {
                    leaves[s] = entries[*i].1;
                }
            }
            let root = merkle_root_of_leaves(&leaves);
            return (root, leaves, size);
        }
        size *= 2;
    }
}

fn merkle_root_of_leaves(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity(layer.len() / 2);
        for pair in layer.chunks(2) {
            let mut d = [0u8; 64];
            d[..32].copy_from_slice(&pair[0]);
            d[32..].copy_from_slice(&pair[pair.len() - 1]);
            next.push(dsha256(&d));
        }
        layer = next;
    }
    layer[0]
}

/// Merkle branch for `index` within `leaves` (bitcoin pairing rules).
pub fn branch_for_index(leaves: &[[u8; 32]], mut index: usize) -> Vec<[u8; 32]> {
    let mut branch = Vec::new();
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        let sib = index ^ 1;
        branch.push(*layer.get(sib).unwrap_or(&layer[index]));
        let mut next = Vec::with_capacity(layer.len() / 2);
        for pair in layer.chunks(2) {
            let mut d = [0u8; 64];
            d[..32].copy_from_slice(&pair[0]);
            d[32..].copy_from_slice(&pair[pair.len() - 1]);
            next.push(dsha256(&d));
        }
        layer = next;
        index /= 2;
    }
    branch
}

/// Fold a leaf through a branch using the index to pick sides.
pub fn fold_branch(leaf: [u8; 32], branch: &[[u8; 32]], mut index: usize) -> [u8; 32] {
    let mut acc = leaf;
    for node in branch {
        let mut d = [0u8; 64];
        if index & 1 == 0 {
            d[..32].copy_from_slice(&acc);
            d[32..].copy_from_slice(node);
        } else {
            d[..32].copy_from_slice(node);
            d[32..].copy_from_slice(&acc);
        }
        acc = dsha256(&d);
        index /= 2;
    }
    acc
}

/// The coinbase-script commitment: MM_MAGIC ‖ aux_root ‖ size_le ‖ nonce_le.
pub fn mm_commitment(aux_root: &[u8; 32], tree_size: u32, nonce: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44);
    out.extend_from_slice(&MM_MAGIC);
    out.extend_from_slice(aux_root);
    out.extend_from_slice(&tree_size.to_le_bytes());
    out.extend_from_slice(&nonce.to_le_bytes());
    out
}

/// Serialized AuxPoW proof (Namecoin wire shape): parent coinbase tx ‖
/// parent block hash ‖ coinbase branch ‖ aux branch ‖ parent header.
#[allow(clippy::too_many_arguments)]
pub fn auxpow_bytes(
    parent_coinbase: &[u8],
    parent_hash_le: &[u8; 32],
    coinbase_branch: &[[u8; 32]],
    aux_branch: &[[u8; 32]],
    aux_index: u32,
    parent_header: &[u8; 80],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(parent_coinbase);
    out.extend_from_slice(parent_hash_le);
    out.extend_from_slice(&varint(coinbase_branch.len() as u64));
    for h in coinbase_branch {
        out.extend_from_slice(h);
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // coinbase is leaf 0
    out.extend_from_slice(&varint(aux_branch.len() as u64));
    for h in aux_branch {
        out.extend_from_slice(h);
    }
    out.extend_from_slice(&aux_index.to_le_bytes());
    out.extend_from_slice(parent_header);
    out
}

#[cfg(test)]
mod aux_tests {
    use super::*;

    #[test]
    fn aux_tree_single_chain() {
        let hash = [7u8; 32];
        let (root, leaves, size) = aux_tree(&[(1, hash)]);
        assert_eq!(size, 1);
        assert_eq!(leaves.len(), 1);
        assert_eq!(root, hash);
    }

    #[test]
    fn aux_tree_multi_chain_distinct_slots() {
        let entries = vec![(1u32, [1u8; 32]), (7u32, [2u8; 32]), (9u32, [3u8; 32])];
        let (root, leaves, size) = aux_tree(&entries);
        assert!(size.is_power_of_two());
        // every chain folds to the same root from its slot
        for (cid, h) in &entries {
            let slot = aux_slot(*cid, size, 0) as usize;
            assert_eq!(leaves[slot], *h);
            let branch = branch_for_index(&leaves, slot);
            assert_eq!(fold_branch(*h, &branch, slot), root);
        }
    }
}
