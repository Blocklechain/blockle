//! The on-disk wallet format, with optional Bitcoin-Core-style encryption.
//!
//! Plain wallets keep `secret_hex` / `kem_secret_hex` as before. Encrypted
//! wallets replace them with ChaCha20-Poly1305 ciphertexts under a key
//! derived from the passphrase with scrypt (N=2^15, r=8, p=1); public
//! material (address, public keys) stays readable so a locked wallet can
//! still receive, watch, and render balances.

use anyhow::{anyhow, bail, Result};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct WalletFile {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret_hex: String,
    pub public_hex: String,
    pub address: String,
    /// ML-KEM-768 keys for receiving encrypted shielded notes.
    #[serde(default)]
    pub kem_public_hex: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kem_secret_hex: String,
    /// Passphrase encryption (Bitcoin-Core-style `encryptwallet`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub encrypted: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kdf: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub salt_hex: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub enc_secret_hex: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub enc_kem_secret_hex: String,
}

mod rand_core_compat {
    use chacha20poly1305::aead::rand_core::RngCore;
    pub fn fill_salt() -> [u8; 16] {
        let mut salt = [0u8; 16];
        chacha20poly1305::aead::OsRng.fill_bytes(&mut salt);
        salt
    }
}

const KDF_NAME: &str = "scrypt-32768-8-1";

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Key> {
    let params = scrypt::Params::new(15, 8, 1, 32).expect("static scrypt params");
    let mut key = [0u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut key)
        .map_err(|e| anyhow!("kdf: {e}"))?;
    Ok(Key::from(key))
}

fn seal(key: &Key, plain: &[u8]) -> Result<String> {
    let cipher = ChaCha20Poly1305::new(key);
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plain)
        .map_err(|_| anyhow!("encryption failed"))?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(hex::encode(out))
}

fn open_sealed(key: &Key, sealed_hex: &str) -> Result<Vec<u8>> {
    let raw = hex::decode(sealed_hex).map_err(|_| anyhow!("corrupt ciphertext"))?;
    if raw.len() < 12 {
        bail!("corrupt ciphertext");
    }
    let (nonce, ct) = raw.split_at(12);
    ChaCha20Poly1305::new(key)
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| anyhow!("wrong passphrase (or corrupt wallet)"))
}

impl WalletFile {
    /// The ML-DSA (and, when present, ML-KEM) secrets, decrypting with the
    /// passphrase when the wallet is locked.
    pub fn secrets(&self, passphrase: Option<&str>) -> Result<(Vec<u8>, Vec<u8>)> {
        if !self.encrypted {
            return Ok((
                hex::decode(&self.secret_hex)?,
                hex::decode(&self.kem_secret_hex).unwrap_or_default(),
            ));
        }
        let pass = passphrase.ok_or_else(|| {
            anyhow!("wallet is encrypted — pass --passphrase or set BLOCKLE_WALLET_PASSPHRASE")
        })?;
        if self.kdf != KDF_NAME {
            bail!("unknown wallet kdf {:?}", self.kdf);
        }
        let salt = hex::decode(&self.salt_hex)?;
        let key = derive_key(pass, &salt)?;
        let secret = open_sealed(&key, &self.enc_secret_hex)?;
        let kem = if self.enc_kem_secret_hex.is_empty() {
            vec![]
        } else {
            open_sealed(&key, &self.enc_kem_secret_hex)?
        };
        Ok((secret, kem))
    }

    /// Encrypt the wallet under `passphrase` (no-op error if already).
    pub fn encrypt(&mut self, passphrase: &str) -> Result<()> {
        if self.encrypted {
            bail!("wallet is already encrypted (use change-passphrase)");
        }
        if passphrase.is_empty() {
            bail!("refusing an empty passphrase");
        }
        let salt = rand_core_compat::fill_salt();
        let key = derive_key(passphrase, &salt)?;
        self.enc_secret_hex = seal(&key, &hex::decode(&self.secret_hex)?)?;
        if !self.kem_secret_hex.is_empty() {
            self.enc_kem_secret_hex = seal(&key, &hex::decode(&self.kem_secret_hex)?)?;
        }
        self.secret_hex.clear();
        self.kem_secret_hex.clear();
        self.salt_hex = hex::encode(salt);
        self.kdf = KDF_NAME.into();
        self.encrypted = true;
        Ok(())
    }

    /// Remove encryption (requires the current passphrase).
    pub fn decrypt(&mut self, passphrase: &str) -> Result<()> {
        if !self.encrypted {
            bail!("wallet is not encrypted");
        }
        let (secret, kem) = self.secrets(Some(passphrase))?;
        self.secret_hex = hex::encode(secret);
        self.kem_secret_hex = if kem.is_empty() { String::new() } else { hex::encode(kem) };
        self.encrypted = false;
        self.kdf.clear();
        self.salt_hex.clear();
        self.enc_secret_hex.clear();
        self.enc_kem_secret_hex.clear();
        Ok(())
    }

    /// Re-encrypt under a new passphrase.
    pub fn change_passphrase(&mut self, old: &str, new: &str) -> Result<()> {
        self.decrypt(old)?;
        self.encrypt(new)
    }

    /// Store a (new) KEM secret, encrypting it if the wallet is locked.
    pub fn set_kem_secret(
        &mut self,
        kem_public: &[u8],
        kem_secret: &[u8],
        passphrase: Option<&str>,
    ) -> Result<()> {
        self.kem_public_hex = hex::encode(kem_public);
        if self.encrypted {
            let pass = passphrase.ok_or_else(|| {
                anyhow!("wallet is encrypted — passphrase needed to store new keys")
            })?;
            let salt = hex::decode(&self.salt_hex)?;
            let key = derive_key(pass, &salt)?;
            // Verify the passphrase against the existing secret first.
            open_sealed(&key, &self.enc_secret_hex)?;
            self.enc_kem_secret_hex = seal(&key, kem_secret)?;
        } else {
            self.kem_secret_hex = hex::encode(kem_secret);
        }
        Ok(())
    }
}
