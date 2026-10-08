//! Hashing helpers.
//!
//! Block hashes are double-SHA256 over the serialized header (the convention
//! Equihash ASICs and pool software assume). Everything else — txids, Merkle
//! nodes, addresses — uses Blake2b-256 with a domain-separating
//! personalization. Both are conservative against Grover-style quantum
//! speedups at 256 bits.

use blake2b_simd::Params;
use sha2::{Digest, Sha256};

pub type Hash32 = [u8; 32];

/// Blake2b-256 with the given 16-byte-max personalization.
pub fn blake2b_256_personal(personal: &[u8], data: &[u8]) -> Hash32 {
    let mut out = [0u8; 32];
    let hash = Params::new()
        .hash_length(32)
        .personal(personal)
        .to_state()
        .update(data)
        .finalize();
    out.copy_from_slice(hash.as_bytes());
    out
}

/// General-purpose consensus hash (txids, sighashes).
pub fn blake2b_256(data: &[u8]) -> Hash32 {
    blake2b_256_personal(b"BlklHash", data)
}

/// Un-personalized Blake2b-256 — byte-identical to the VM's `BLAKE2B` opcode.
/// Used to derive BLOCK-20 balance-storage keys (`H(0x01 ‖ address)`) from
/// native code so the native AMM and the token contract share the same slots.
pub fn blake2b_256_raw(data: &[u8]) -> Hash32 {
    let mut out = [0u8; 32];
    let hash = Params::new().hash_length(32).to_state().update(data).finalize();
    out.copy_from_slice(hash.as_bytes());
    out
}

/// Double-SHA256 — the block (header) hash.
pub fn sha256d(data: &[u8]) -> Hash32 {
    let first = Sha256::digest(data);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}

/// Address derivation: full Blake2b-256 of the public key. 32 bytes keeps a
/// post-quantum security margin (Grover leaves ~128 bits of preimage
/// resistance).
pub fn address_hash(pubkey: &[u8]) -> [u8; 32] {
    blake2b_256_personal(b"BlklAddr", pubkey)
}

/// Display convention for block hashes / txids: reversed hex, like Bitcoin,
/// so low-target hashes show their leading zeros.
pub fn display_hash(h: &Hash32) -> String {
    let mut rev = *h;
    rev.reverse();
    hex::encode(rev)
}
