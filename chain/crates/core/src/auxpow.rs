//! Merged-mining (AuxPoW) primitives.
//!
//! BLOCK is designed to be merge-mined by the major ASIC ecosystems: a
//! parent-chain block (Bitcoin-family SHA-256d, Litecoin-family Scrypt, or
//! Zcash-family Equihash) commits to a BLOCK header hash in its coinbase,
//! and that parent proof-of-work — at BLOCK's own per-lane difficulty —
//! stands in for a native solution.
//!
//! Wire shapes follow the Namecoin conventions used across merged-mining
//! pools: the coinbase carries `MM_MAGIC ‖ aux_root ‖ tree_size_le ‖
//! nonce_le`, the aux chain's slot in the commitment tree is derived from
//! its chain id, and all merkle folding is double-SHA256.

use serde::{Deserialize, Serialize};

use crate::hash::{sha256d, Hash32};

/// Magic prefix marking the merged-mining commitment in a parent coinbase.
pub const MM_MAGIC: [u8; 4] = [0xfa, 0xbe, b'm', b'm'];

/// Parent-chain PoW algorithms accepted for merged mining.
pub const PARENT_ALGOS: [&str; 3] = ["sha256d", "scrypt", "equihash"];

/// A merged-mining proof attached to a BLOCK block: the parent header whose
/// PoW covers us, the parent coinbase carrying the commitment, and the two
/// merkle branches linking everything together.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuxPow {
    /// Parent PoW algorithm: `"sha256d"`, `"scrypt"`, or `"equihash"`.
    pub parent_algo: String,
    /// Raw parent block header: 80 bytes for sha256d/scrypt parents, or the
    /// Zcash layout (140 bytes + compact-size solution) for equihash.
    pub parent_header: Vec<u8>,
    /// Raw parent coinbase transaction bytes (Bitcoin serialization).
    pub parent_coinbase: Vec<u8>,
    /// Double-SHA256 branch from the coinbase txid up to the parent merkle
    /// root. The coinbase is always leaf 0, so folding is always-left.
    pub coinbase_branch: Vec<Hash32>,
    /// Branch through the aux-chain commitment tree to the committed root.
    pub chain_branch: Vec<Hash32>,
    /// Our slot in the commitment tree.
    pub chain_index: u32,
}

impl AuxPow {
    /// Conservative size bound used for block-size accounting.
    pub fn serialized_size(&self) -> usize {
        self.parent_header.len()
            + self.parent_coinbase.len()
            + 32 * (self.coinbase_branch.len() + self.chain_branch.len())
            + 64
    }
}

/// Slot of an aux chain in the commitment tree (Namecoin's expected-index
/// derivation).
pub fn aux_slot(chain_id: u32, tree_size: u32, nonce: u32) -> u32 {
    let mut rand = nonce;
    rand = rand.wrapping_mul(1103515245).wrapping_add(12345);
    rand = rand.wrapping_add(chain_id);
    rand = rand.wrapping_mul(1103515245).wrapping_add(12345);
    rand % tree_size.max(1)
}

/// Fold a leaf up a double-SHA256 merkle branch using bitcoin pairing rules
/// (`index` selects left/right at each level).
pub fn fold_branch(leaf: Hash32, branch: &[Hash32], mut index: u32) -> Hash32 {
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
        acc = sha256d(&d);
        index /= 2;
    }
    acc
}

/// Fold the coinbase txid to the parent merkle root; the coinbase is always
/// the first transaction, so every step hashes `acc ‖ sibling`.
pub fn fold_coinbase_branch(txid: Hash32, branch: &[Hash32]) -> Hash32 {
    let mut acc = txid;
    for node in branch {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&acc);
        d[32..].copy_from_slice(node);
        acc = sha256d(&d);
    }
    acc
}

/// The commitment layout written into parent coinbases:
/// `MM_MAGIC ‖ aux_root ‖ tree_size_le ‖ nonce_le`.
pub fn mm_commitment(aux_root: &Hash32, tree_size: u32, nonce: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(44);
    out.extend_from_slice(&MM_MAGIC);
    out.extend_from_slice(aux_root);
    out.extend_from_slice(&tree_size.to_le_bytes());
    out.extend_from_slice(&nonce.to_le_bytes());
    out
}

/// Locate the merged-mining commitment in raw coinbase bytes. Returns
/// `(aux_root, tree_size, nonce)` for the FIRST magic occurrence.
pub fn find_commitment(coinbase: &[u8]) -> Option<(Hash32, u32, u32)> {
    let pos = coinbase.windows(4).position(|w| w == MM_MAGIC)?;
    if coinbase.len() < pos + 44 {
        return None;
    }
    let root: Hash32 = coinbase[pos + 4..pos + 36].try_into().ok()?;
    let size = u32::from_le_bytes(coinbase[pos + 36..pos + 40].try_into().ok()?);
    let nonce = u32::from_le_bytes(coinbase[pos + 40..pos + 44].try_into().ok()?);
    Some((root, size, nonce))
}

/// Merkle root field of a parent header — bytes 36..68 in both the 80-byte
/// Bitcoin layout and the Zcash layout (version ‖ prev ‖ merkle ‖ …).
pub fn parent_merkle_root(header: &[u8]) -> Option<Hash32> {
    header.get(36..68)?.try_into().ok()
}
