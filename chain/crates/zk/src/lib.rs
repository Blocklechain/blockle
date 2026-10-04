//! Blockle's shielded pool cryptography.
//!
//! - [`note`]: Rescue note commitments `C = H(N, v, r)` and the depth-15
//!   append-only commitment tree.
//! - [`spend`]: the STARK spend circuit — proves a commitment is in the tree
//!   under a public root, revealing only the nullifier `N` and value `v`
//!   while keeping the blinding and tree position private (ownership
//!   unlinkability; amounts are public in v1).
//! - Proofs are STARKs over hash functions only (winterfell): transparent
//!   setup, post-quantum-aligned, matching Blockle's ML-DSA signatures.
//!
//! The Rescue arithmetization is vendored from winterfell's examples
//! (MIT licensed, Copyright (c) Facebook, Inc. and its affiliates).

pub mod note;
pub mod rescue;
pub mod spend;
pub mod transfer;
mod utils;

use thiserror::Error;

pub use note::{
    bytes_to_felts, bytes_to_felts_reduced, commitment, empty_root, felts_to_bytes, random_felt,
    NoteTree, MAX_NOTES,
};
pub use spend::{prove_spend, verify_spend, TREE_DEPTH};
pub use transfer::{prove_transfer, verify_transfer, NoteOpening};
pub use winterfell::math::fields::f128::BaseElement;
pub use winterfell::math::StarkField;

#[derive(Debug, Error)]
pub enum ZkError {
    #[error("non-canonical field element encoding")]
    NonCanonical,
    #[error("note tree is full")]
    TreeFull,
    #[error("tree error: {0}")]
    Tree(String),
    #[error("bad witness: {0}")]
    BadWitness(String),
    #[error("prover error: {0}")]
    Prover(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use winterfell::math::fields::f128::BaseElement;

    fn setup() -> ([BaseElement; 2], u64, BaseElement, [u8; 32], NoteTree) {
        let nullifier = [BaseElement::new(11), BaseElement::new(22)];
        let value = 1_234_567u64;
        let blinding = BaseElement::new(33);
        let c = commitment(nullifier, value, blinding);
        // a few decoy notes around ours
        let decoy1 = commitment([BaseElement::new(5), BaseElement::new(6)], 9, BaseElement::new(7));
        let decoy2 = commitment([BaseElement::new(8), BaseElement::new(9)], 1, BaseElement::new(2));
        let tree = NoteTree::from_leaves(&[decoy1, c, decoy2]).unwrap();
        (nullifier, value, blinding, c, tree)
    }

    #[test]
    fn spend_proof_roundtrip_and_rejections() {
        let (nullifier, value, blinding, _c, tree) = setup();
        let sighash = bytes_to_felts_reduced(&[0x42; 32]);
        let branch = tree.branch(1).unwrap();
        let root = bytes_to_felts(&tree.root()).unwrap();

        let proof = prove_spend(
            nullifier,
            BaseElement::new(value as u128),
            blinding,
            branch,
            1,
            sighash,
        )
        .unwrap();

        // valid
        assert!(verify_spend(&proof, root, nullifier, BaseElement::new(value as u128), sighash));
        // wrong nullifier
        assert!(!verify_spend(
            &proof,
            root,
            [nullifier[1], nullifier[0]],
            BaseElement::new(value as u128),
            sighash
        ));
        // wrong value (inflation attempt)
        assert!(!verify_spend(
            &proof,
            root,
            nullifier,
            BaseElement::new(value as u128 + 1),
            sighash
        ));
        // wrong root (note not in that tree)
        let other_root = bytes_to_felts(&empty_root()).unwrap();
        assert!(!verify_spend(
            &proof,
            other_root,
            nullifier,
            BaseElement::new(value as u128),
            sighash
        ));
        // different transaction (sighash binding)
        let other_sighash = bytes_to_felts_reduced(&[0x43; 32]);
        assert!(!verify_spend(
            &proof,
            root,
            nullifier,
            BaseElement::new(value as u128),
            other_sighash
        ));
        // corrupted proof bytes
        let mut bad = proof.clone();
        let mid = bad.len() / 2;
        bad[mid] ^= 1;
        assert!(!verify_spend(&bad, root, nullifier, BaseElement::new(value as u128), sighash));
    }
}
