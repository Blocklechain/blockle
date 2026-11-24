//! Post-quantum keys and addresses.
//!
//! Transparent spends are authorized by **ML-DSA-44** (FIPS 204, the
//! standardized Dilithium2 — NIST security category 2): 1312-byte public
//! keys, 2420-byte signatures. Addresses are the 32-byte Blake2b hash of a
//! public key, encoded as bech32m with HRP `block` (addresses read
//! `block1…`). Shielded addresses will get their own HRP in the privacy
//! milestone.

use bech32::{Bech32m, Hrp};
use fips204::ml_dsa_44;
use fips204::traits::{KeyGen, SerDes, Signer, Verifier};
use thiserror::Error;

use crate::hash::{address_hash, blake2b_256_personal};

pub const ADDRESS_HRP: &str = "block";
pub const PUBLIC_KEY_LEN: usize = ml_dsa_44::PK_LEN;
pub const SECRET_KEY_LEN: usize = ml_dsa_44::SK_LEN;
pub const SIGNATURE_LEN: usize = ml_dsa_44::SIG_LEN;

/// Domain-separation context for transaction signatures.
const SIG_CONTEXT: &[u8] = b"BlklTxV1";

/// Personalization for hierarchical key derivation. Distinct from every other
/// Blake2b use in the tree (`BlklHash`, `BlklAddr`, `BlklMrkl`) so a derived
/// seed can never collide with a txid, an address hash or a Merkle node.
const HD_PERSONAL: &[u8] = b"BlklHDv1";

/// Bytes in a master seed. One of these backs every address a wallet will ever
/// have, so it is the only thing that needs backing up.
pub const MASTER_SEED_LEN: usize = 32;

pub type Address = [u8; 32];

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("invalid address: {0}")]
    InvalidAddress(String),
    #[error("invalid key material")]
    InvalidKey,
    #[error("signature verification failed")]
    BadSignature,
}

/// An ML-DSA-44 keypair controlling a transparent address.
pub struct Keypair {
    secret: ml_dsa_44::PrivateKey,
    public_bytes: Vec<u8>,
}

impl Keypair {
    pub fn generate() -> Self {
        let (public, secret) = ml_dsa_44::try_keygen().expect("OS RNG available");
        let public_bytes = public.into_bytes().to_vec();
        Keypair { secret, public_bytes }
    }

    /// The keypair at `index` under `master_seed`. Deterministic: the same
    /// seed and index always produce the same address, on any machine.
    ///
    /// # Why this is not BIP32
    ///
    /// Bitcoin's HD derivation leans on a property of elliptic curves —
    /// `pubkey(a + b) == pubkey(a) + pubkey(b)` — which is what lets a watch-
    /// only wallet derive receive addresses from a public key alone. **ML-DSA
    /// has no such structure.** Lattice keys are not points on a group; there
    /// is no public-derivation analogue and pretending otherwise would be
    /// inventing cryptography.
    ///
    /// So this derives the FIPS 204 keygen seed ξ instead:
    ///
    /// ```text
    ///     ξ_i = Blake2b-256("BlklHDv1", master_seed ‖ LE32(index))
    ///     (pk_i, sk_i) = ML-DSA-44.KeyGen_internal(ξ_i)
    /// ```
    ///
    /// `keygen_from_seed` is the standard's own deterministic keygen, not a
    /// re-implementation, so the keys are exactly as sound as freshly
    /// generated ones.
    ///
    /// What this buys: one 32-byte secret backs unlimited addresses, so a
    /// wallet can hand out a fresh address per payment — and an exchange a
    /// fresh address per customer — with one thing to back up.
    ///
    /// What it does NOT buy, stated plainly: **there is no watch-only
    /// derivation.** Deriving address `i` requires the master seed, which is
    /// spending authority. A service that only needs addresses still has to be
    /// given the seed, or be handed addresses by something that holds it.
    ///
    /// Every index is therefore "hardened" in BIP32 terms — the distinction
    /// does not exist here, because the non-hardened variant is impossible.
    pub fn derive(master_seed: &[u8; MASTER_SEED_LEN], index: u32) -> Self {
        let mut material = [0u8; MASTER_SEED_LEN + 4];
        material[..MASTER_SEED_LEN].copy_from_slice(master_seed);
        // Little-endian, fixed width: a varint would let two different indices
        // share a preimage prefix, and fixed width keeps the mapping injective.
        material[MASTER_SEED_LEN..].copy_from_slice(&index.to_le_bytes());
        let xi = blake2b_256_personal(HD_PERSONAL, &material);
        let (public, secret) = ml_dsa_44::KG::keygen_from_seed(&xi);
        Keypair { secret, public_bytes: public.into_bytes().to_vec() }
    }

    pub fn from_bytes(secret: &[u8], public: &[u8]) -> Result<Self, KeyError> {
        let sk: [u8; SECRET_KEY_LEN] = secret.try_into().map_err(|_| KeyError::InvalidKey)?;
        let pk: [u8; PUBLIC_KEY_LEN] = public.try_into().map_err(|_| KeyError::InvalidKey)?;
        let secret = ml_dsa_44::PrivateKey::try_from_bytes(sk).map_err(|_| KeyError::InvalidKey)?;
        // Parse to validate, then keep only the canonical bytes.
        let public = ml_dsa_44::PublicKey::try_from_bytes(pk).map_err(|_| KeyError::InvalidKey)?;
        let public_bytes = public.into_bytes().to_vec();
        Ok(Keypair { secret, public_bytes })
    }

    pub fn secret_bytes(&self) -> Vec<u8> {
        self.secret.clone().into_bytes().to_vec()
    }

    pub fn public_bytes(&self) -> Vec<u8> {
        self.public_bytes.clone()
    }

    pub fn address(&self) -> Address {
        address_hash(&self.public_bytes)
    }

    pub fn sign(&self, msg: &[u8]) -> Vec<u8> {
        self.secret
            .try_sign(msg, SIG_CONTEXT)
            .expect("OS RNG available")
            .to_vec()
    }
}

/// Verify an ML-DSA-44 signature made by `pubkey` over `msg`.
pub fn verify_signature(pubkey: &[u8], msg: &[u8], signature: &[u8]) -> Result<(), KeyError> {
    let pk: [u8; PUBLIC_KEY_LEN] = pubkey.try_into().map_err(|_| KeyError::InvalidKey)?;
    let pk = ml_dsa_44::PublicKey::try_from_bytes(pk).map_err(|_| KeyError::InvalidKey)?;
    let sig: [u8; SIGNATURE_LEN] = signature.try_into().map_err(|_| KeyError::BadSignature)?;
    if pk.verify(msg, &sig, SIG_CONTEXT) {
        Ok(())
    } else {
        Err(KeyError::BadSignature)
    }
}

/// Derive the address committed to by a public key.
pub fn pubkey_to_address(pubkey: &[u8]) -> Address {
    address_hash(pubkey)
}

pub fn encode_address(addr: &Address) -> String {
    let hrp = Hrp::parse(ADDRESS_HRP).expect("static hrp");
    bech32::encode::<Bech32m>(hrp, addr).expect("32 bytes always encodes")
}

pub fn decode_address(s: &str) -> Result<Address, KeyError> {
    let err = || KeyError::InvalidAddress(s.to_string());
    let (hrp, data) = bech32::decode(s).map_err(|_| err())?;
    if hrp.as_str() != ADDRESS_HRP || data.len() != 32 {
        return Err(err());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&data);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------- derivation

    #[test]
    fn derivation_is_deterministic_across_calls() {
        // The whole point: the same seed and index give the same address on
        // any machine, so a wallet restored from a seed finds its money.
        let seed = [7u8; MASTER_SEED_LEN];
        let a = Keypair::derive(&seed, 0);
        let b = Keypair::derive(&seed, 0);
        assert_eq!(a.address(), b.address());
        assert_eq!(a.public_bytes(), b.public_bytes());
        assert_eq!(a.secret_bytes(), b.secret_bytes());
    }

    #[test]
    fn every_index_is_a_different_address() {
        // A collision here would credit one customer's deposit to another.
        let seed = [7u8; MASTER_SEED_LEN];
        let mut seen = std::collections::HashSet::new();
        for i in 0..64u32 {
            assert!(seen.insert(Keypair::derive(&seed, i).address()), "index {i} collided");
        }
        // And the far end of the range, where an off-by-one in the index
        // encoding would show up.
        for i in [u32::MAX, u32::MAX - 1, 1 << 31, 1 << 16] {
            assert!(seen.insert(Keypair::derive(&seed, i).address()), "index {i} collided");
        }
    }

    #[test]
    fn a_different_seed_gives_a_different_address() {
        let a = Keypair::derive(&[1u8; MASTER_SEED_LEN], 0);
        let mut other = [1u8; MASTER_SEED_LEN];
        other[31] = 2; // one bit of difference
        assert_ne!(a.address(), Keypair::derive(&other, 0).address());
    }

    #[test]
    fn derived_keys_actually_sign() {
        // Deriving an address nobody can spend from would be worse than not
        // deriving one at all.
        let kp = Keypair::derive(&[9u8; MASTER_SEED_LEN], 12345);
        let msg = b"spend me";
        let sig = kp.sign(msg);
        verify_signature(&kp.public_bytes(), msg, &sig).expect("derived key signs");
        // And not for someone else's message.
        assert!(verify_signature(&kp.public_bytes(), b"other", &sig).is_err());
    }

    #[test]
    fn derived_keys_round_trip_through_storage() {
        // A derived key has to survive being written to a wallet file and read
        // back, like any other.
        let kp = Keypair::derive(&[3u8; MASTER_SEED_LEN], 77);
        let restored = Keypair::from_bytes(&kp.secret_bytes(), &kp.public_bytes()).unwrap();
        assert_eq!(restored.address(), kp.address());
    }

    #[test]
    fn index_encoding_is_fixed_width() {
        /*
         * GOLDEN VECTOR. This pins the derivation to its exact definition:
         *
         *     xi    = Blake2b-256("BlklHDv1", seed ‖ LE32(index))
         *     key   = ML-DSA-44.KeyGen_internal(xi)
         *
         * If this value ever changes, every address every wallet has ever
         * derived moves, and any coins sitting at them are unreachable with
         * the new code. That makes this test a compatibility lock, not a
         * sanity check — a failure here is never "update the expected value".
         */
        let kp = Keypair::derive(&[0u8; MASTER_SEED_LEN], 0);
        assert_eq!(
            encode_address(&kp.address()),
            GOLDEN_ZERO_SEED_INDEX_0,
            "derivation changed: existing derived addresses would be lost",
        );
    }

    /// Derived from an all-zero seed at index 0. See `index_encoding_is_fixed_width`.
    const GOLDEN_ZERO_SEED_INDEX_0: &str =
        "block1hjz4mvslywly4ma2s9xs6zhpkv60lv2agsa52s4xya5etxrqa2jq3ppzq2";

    #[test]
    fn address_roundtrip() {
        let kp = Keypair::generate();
        let addr = kp.address();
        let s = encode_address(&addr);
        assert!(s.starts_with("block1"), "got {s}");
        assert_eq!(decode_address(&s).unwrap(), addr);
        assert!(decode_address("block1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxxxxxx").is_err());
    }

    #[test]
    fn sign_verify() {
        let kp = Keypair::generate();
        assert_eq!(kp.public_bytes().len(), PUBLIC_KEY_LEN);
        let sig = kp.sign(b"blockle");
        assert_eq!(sig.len(), SIGNATURE_LEN);
        verify_signature(&kp.public_bytes(), b"blockle", &sig).unwrap();
        assert!(verify_signature(&kp.public_bytes(), b"tampered", &sig).is_err());
    }

    #[test]
    fn keypair_restore() {
        let kp = Keypair::generate();
        let restored = Keypair::from_bytes(&kp.secret_bytes(), &kp.public_bytes()).unwrap();
        assert_eq!(kp.address(), restored.address());
        let sig = restored.sign(b"msg");
        verify_signature(&kp.public_bytes(), b"msg", &sig).unwrap();
    }
}
