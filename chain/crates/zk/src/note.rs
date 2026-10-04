//! Note commitments and the append-only note commitment tree.

use winterfell::crypto::Hasher;
use winterfell::math::{fields::f128::BaseElement, FieldElement, StarkField};

use crate::rescue::{Hash, Rescue128};
use crate::spend::TREE_DEPTH;
use crate::ZkError;

pub const MAX_NOTES: usize = 1 << TREE_DEPTH;

/// Decode 32 bytes as two canonical field elements (16 bytes LE each).
/// Rejects non-canonical encodings so nullifiers/commitments have exactly
/// one byte representation.
pub fn bytes_to_felts(bytes: &[u8; 32]) -> Result<[BaseElement; 2], ZkError> {
    let mut out = [BaseElement::ZERO; 2];
    for (i, chunk) in bytes.chunks_exact(16).enumerate() {
        let v = u128::from_le_bytes(chunk.try_into().expect("16-byte chunk"));
        if v >= BaseElement::MODULUS {
            return Err(ZkError::NonCanonical);
        }
        out[i] = BaseElement::new(v);
    }
    Ok(out)
}

pub fn felts_to_bytes(felts: &[BaseElement; 2]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&felts[0].as_int().to_le_bytes());
    out[16..].copy_from_slice(&felts[1].as_int().to_le_bytes());
    out
}

/// Reduce arbitrary 32 bytes (e.g. a sighash) into two field elements.
/// Non-injective but deterministic — used only for transcript binding.
pub fn bytes_to_felts_reduced(bytes: &[u8; 32]) -> [BaseElement; 2] {
    let a = u128::from_le_bytes(bytes[..16].try_into().expect("16 bytes"));
    let b = u128::from_le_bytes(bytes[16..].try_into().expect("16 bytes"));
    [BaseElement::new(a), BaseElement::new(b)]
}

/// The note commitment: `Rescue(N0, N1, value, blinding)`.
pub fn commitment(
    nullifier: [BaseElement; 2],
    value: u64,
    blinding: BaseElement,
) -> [u8; 32] {
    let digest = Rescue128::digest(&[
        nullifier[0],
        nullifier[1],
        BaseElement::new(value as u128),
        blinding,
    ]);
    felts_to_bytes(&digest.to_elements())
}

/// Generate a uniformly random canonical field element from OS randomness.
pub fn random_felt() -> BaseElement {
    use rand::RngCore;
    let mut rng = rand::rngs::OsRng;
    loop {
        let mut bytes = [0u8; 16];
        rng.fill_bytes(&mut bytes);
        let v = u128::from_le_bytes(bytes);
        if v < BaseElement::MODULUS {
            return BaseElement::new(v);
        }
    }
}

/// The append-only commitment tree, logically padded with all-zero leaves to
/// `MAX_NOTES`. Sparse implementation: empty subtrees use precomputed
/// hashes, so root/branch cost scales with the number of real notes, not
/// with `2^DEPTH`.
pub struct NoteTree {
    leaves: Vec<Hash>,
    empties: Vec<Hash>, // empties[level] = root of an all-empty subtree
}

impl NoteTree {
    pub fn from_leaves(leaves: &[[u8; 32]]) -> Result<Self, ZkError> {
        if leaves.len() > MAX_NOTES {
            return Err(ZkError::TreeFull);
        }
        let mut hashes = Vec::with_capacity(leaves.len());
        for leaf in leaves {
            let felts = bytes_to_felts(leaf)?;
            hashes.push(Hash::new(felts[0], felts[1]));
        }
        let mut empties = vec![Hash::new(BaseElement::ZERO, BaseElement::ZERO)];
        for level in 0..TREE_DEPTH {
            let e = empties[level];
            empties.push(Rescue128::merge(&[e, e]));
        }
        Ok(NoteTree { leaves: hashes, empties })
    }

    /// Root of the subtree at `level` whose leftmost leaf is `start`.
    fn subtree(&self, level: usize, start: usize) -> Hash {
        if start >= self.leaves.len() {
            return self.empties[level];
        }
        if level == 0 {
            return self.leaves[start];
        }
        let half = 1usize << (level - 1);
        let left = self.subtree(level - 1, start);
        let right = self.subtree(level - 1, start + half);
        Rescue128::merge(&[left, right])
    }

    pub fn root(&self) -> [u8; 32] {
        felts_to_bytes(&self.subtree(TREE_DEPTH, 0).to_elements())
    }

    /// Full branch for a leaf: `[leaf, sibling_0, …, sibling_{DEPTH-1}]`.
    pub fn branch(&self, index: usize) -> Result<Vec<Hash>, ZkError> {
        if index >= self.leaves.len() {
            return Err(ZkError::Tree("leaf index out of range".into()));
        }
        let mut out = vec![self.leaves[index]];
        for level in 0..TREE_DEPTH {
            let sibling = (index >> level) ^ 1;
            out.push(self.subtree(level, sibling << level));
        }
        Ok(out)
    }
}

/// Root of the empty tree (the genesis anchor).
pub fn empty_root() -> [u8; 32] {
    NoteTree::from_leaves(&[]).expect("empty tree").root()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_encoding_enforced() {
        let felts = [BaseElement::new(7), BaseElement::new(9)];
        let bytes = felts_to_bytes(&felts);
        assert_eq!(bytes_to_felts(&bytes).unwrap(), felts);
        let bad = [0xffu8; 32]; // 2^128-1 > modulus
        assert!(matches!(bytes_to_felts(&bad), Err(ZkError::NonCanonical)));
    }

    #[test]
    fn commitments_differ_by_blinding() {
        let n = [BaseElement::new(1), BaseElement::new(2)];
        let a = commitment(n, 100, BaseElement::new(3));
        let b = commitment(n, 100, BaseElement::new(4));
        assert_ne!(a, b);
    }

    #[test]
    fn tree_roots_change_with_leaves() {
        let empty = empty_root();
        let n = [BaseElement::new(1), BaseElement::new(2)];
        let c = commitment(n, 5, BaseElement::new(9));
        let one = NoteTree::from_leaves(&[c]).unwrap().root();
        assert_ne!(empty, one);
        // branch has leaf + TREE_DEPTH siblings
        let branch = NoteTree::from_leaves(&[c]).unwrap().branch(0).unwrap();
        assert_eq!(branch.len(), TREE_DEPTH + 1);
    }
}
