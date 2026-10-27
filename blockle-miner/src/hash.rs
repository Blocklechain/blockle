//! Bitcoin-family block-header + merkle helpers. The coinbase/merkle tree is
//! ALWAYS double-SHA-256 in classic stratum — only the final 80-byte header PoW
//! hash varies by algorithm (see `algo.rs`).
use sha2::{Digest, Sha256};

/// Double SHA-256 (used for coinbase txid + merkle nodes).
pub fn dsha256(data: &[u8]) -> [u8; 32] {
    let h1 = Sha256::digest(data);
    let h2 = Sha256::digest(h1);
    h2.into()
}

/// Undo the stratum prevhash word-swap (4-byte words reversed) back to the
/// little-endian bytes used in the header.
pub fn prevhash_le(stratum_hex: &str) -> anyhow::Result<[u8; 32]> {
    let swapped: Vec<u8> = hex::decode(stratum_hex)?;
    if swapped.len() != 32 {
        anyhow::bail!("prevhash must be 32 bytes");
    }
    let mut le = [0u8; 32];
    for (i, chunk) in swapped.chunks(4).enumerate() {
        le[i * 4] = chunk[3];
        le[i * 4 + 1] = chunk[2];
        le[i * 4 + 2] = chunk[1];
        le[i * 4 + 3] = chunk[0];
    }
    Ok(le)
}

/// Fold a coinbase txid up the merkle branch the pool supplied.
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

/// Assemble the canonical 80-byte block header (all little-endian fields).
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
