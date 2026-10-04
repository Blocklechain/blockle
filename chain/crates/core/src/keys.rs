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
use fips204::traits::{SerDes, Signer, Verifier};
use thiserror::Error;

use crate::hash::address_hash;

pub const ADDRESS_HRP: &str = "block";
pub const PUBLIC_KEY_LEN: usize = ml_dsa_44::PK_LEN;
pub const SECRET_KEY_LEN: usize = ml_dsa_44::SK_LEN;
pub const SIGNATURE_LEN: usize = ml_dsa_44::SIG_LEN;

/// Domain-separation context for transaction signatures.
const SIG_CONTEXT: &[u8] = b"BlklTxV1";

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
