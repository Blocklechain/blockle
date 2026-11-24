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
    /// The HD master seed, 32 bytes, hex.
    ///
    /// Absent on wallets created before derivation existed — those keep
    /// working exactly as they did, with their single key, and can adopt a
    /// seed later (`wallet init-seed`) WITHOUT their existing address or
    /// funds moving. See `set_master_seed`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub seed_hex: String,
    /// Sealed form of the same, when the wallet is encrypted.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub enc_seed_hex: String,
    /// The next index `derive --next` will hand out.
    ///
    /// A HINT, NOT A LEDGER. Addresses are a pure function of (seed, index),
    /// so losing this counter costs nothing but reuse — and reusing an index
    /// is not a loss of funds, just a loss of privacy and, for an exchange,
    /// of attribution. Recovery from seed alone scans indices rather than
    /// trusting this.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub next_index: u32,
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

fn is_zero(n: &u32) -> bool {
    *n == 0
}

mod rand_core_compat {
    use chacha20poly1305::aead::rand_core::RngCore;
    pub fn fill_salt() -> [u8; 16] {
        let mut salt = [0u8; 16];
        chacha20poly1305::aead::OsRng.fill_bytes(&mut salt);
        salt
    }
}

/// A fresh 32-byte HD master seed from the OS.
///
/// Uses the same `OsRng` the wallet's encryption already relies on, rather
/// than pulling in a second randomness crate — one source of entropy in the
/// wallet is one thing to audit.
pub fn fresh_master_seed() -> [u8; 32] {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut seed = [0u8; 32];
    chacha20poly1305::aead::OsRng.fill_bytes(&mut seed);
    seed
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
        // THE SEED IS SPENDING AUTHORITY FOR EVERY DERIVED ADDRESS, so it is
        // sealed with the same key as the primary secret. Leaving it in the
        // clear would make "encrypt the wallet" protect one address and leave
        // the other thousand readable.
        if !self.seed_hex.is_empty() {
            self.enc_seed_hex = seal(&key, &hex::decode(&self.seed_hex)?)?;
        }
        self.secret_hex.clear();
        self.kem_secret_hex.clear();
        self.seed_hex.clear();
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
        let seed = self.master_seed(Some(passphrase))?;
        self.secret_hex = hex::encode(secret);
        self.kem_secret_hex = if kem.is_empty() { String::new() } else { hex::encode(kem) };
        self.seed_hex = seed.map(hex::encode).unwrap_or_default();
        self.encrypted = false;
        self.kdf.clear();
        self.salt_hex.clear();
        self.enc_secret_hex.clear();
        self.enc_kem_secret_hex.clear();
        self.enc_seed_hex.clear();
        Ok(())
    }

    /// Re-encrypt under a new passphrase.
    pub fn change_passphrase(&mut self, old: &str, new: &str) -> Result<()> {
        self.decrypt(old)?;
        self.encrypt(new)
    }

    /// The HD master seed, decrypting if the wallet is locked.
    ///
    /// `None` means this wallet predates derivation and has not adopted a
    /// seed — a distinct answer from "wrong passphrase", which errors.
    pub fn master_seed(&self, passphrase: Option<&str>) -> Result<Option<[u8; 32]>> {
        let raw = if self.encrypted {
            if self.enc_seed_hex.is_empty() {
                return Ok(None);
            }
            let pass = passphrase.ok_or_else(|| {
                anyhow!("wallet is encrypted — pass --passphrase or set BLOCKLE_WALLET_PASSPHRASE")
            })?;
            let salt = hex::decode(&self.salt_hex)?;
            open_sealed(&derive_key(pass, &salt)?, &self.enc_seed_hex)?
        } else {
            if self.seed_hex.is_empty() {
                return Ok(None);
            }
            hex::decode(&self.seed_hex)?
        };
        let seed: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("master seed is {} bytes, expected 32", raw.len()))?;
        Ok(Some(seed))
    }

    /// Adopt a master seed, sealing it if the wallet is locked.
    ///
    /// REFUSES TO REPLACE AN EXISTING ONE. Overwriting a seed orphans every
    /// address derived from the old one — the coins are still there and
    /// nothing in the wallet can reach them. That is a restore operation, not
    /// a setting, and it should go through import with the old seed in hand.
    pub fn set_master_seed(&mut self, seed: &[u8; 32], passphrase: Option<&str>) -> Result<()> {
        if self.master_seed(passphrase)?.is_some() {
            bail!(
                "this wallet already has a master seed. Replacing it would orphan \
                 every address derived from the old one — those coins would still \
                 exist and nothing here could spend them."
            );
        }
        if self.encrypted {
            let pass = passphrase.ok_or_else(|| {
                anyhow!("wallet is encrypted — passphrase needed to store a seed")
            })?;
            let salt = hex::decode(&self.salt_hex)?;
            let key = derive_key(pass, &salt)?;
            // Check the passphrase against the existing secret before writing,
            // so a typo cannot leave a seed nobody can decrypt.
            open_sealed(&key, &self.enc_secret_hex)?;
            self.enc_seed_hex = seal(&key, seed)?;
        } else {
            self.seed_hex = hex::encode(seed);
        }
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use blockle_core::Keypair;

    fn plain() -> WalletFile {
        let kp = Keypair::generate();
        WalletFile {
            secret_hex: hex::encode(kp.secret_bytes()),
            public_hex: hex::encode(kp.public_bytes()),
            address: blockle_core::encode_address(&kp.address()),
            ..WalletFile::default()
        }
    }

    #[test]
    fn a_wallet_without_a_seed_says_so_rather_than_erroring() {
        // Wallets created before derivation existed are not broken, they just
        // have one address. Treating that as an error would make every
        // pre-existing wallet look corrupt.
        assert!(plain().master_seed(None).unwrap().is_none());
    }

    #[test]
    fn a_seed_round_trips_through_the_plain_file() {
        let mut wf = plain();
        let seed = [42u8; 32];
        wf.set_master_seed(&seed, None).unwrap();
        assert_eq!(wf.master_seed(None).unwrap(), Some(seed));
    }

    #[test]
    fn encryption_covers_the_seed() {
        /*
         * THE SEED IS SPENDING AUTHORITY FOR EVERY DERIVED ADDRESS.
         *
         * If `encrypt` sealed the primary secret and left the seed in the
         * clear, "encrypt the wallet" would protect one address and leave the
         * other thousand readable to anyone with the file.
         */
        let mut wf = plain();
        wf.set_master_seed(&[7u8; 32], None).unwrap();
        wf.encrypt("correct horse battery staple").unwrap();

        assert!(wf.seed_hex.is_empty(), "no plaintext seed may remain");
        assert!(!wf.enc_seed_hex.is_empty());
        // And it is not sitting in the serialized form either.
        let json = serde_json::to_string(&wf).unwrap();
        assert!(!json.contains(&hex::encode([7u8; 32])), "seed leaked into the file");

        // Locked: no passphrase, no seed.
        assert!(wf.master_seed(None).is_err());
        assert!(wf.master_seed(Some("wrong")).is_err());
        assert_eq!(
            wf.master_seed(Some("correct horse battery staple")).unwrap(),
            Some([7u8; 32])
        );
    }

    #[test]
    fn decrypt_restores_the_seed_alongside_the_key() {
        let mut wf = plain();
        wf.set_master_seed(&[3u8; 32], None).unwrap();
        wf.encrypt("pass").unwrap();
        wf.decrypt("pass").unwrap();
        assert_eq!(wf.master_seed(None).unwrap(), Some([3u8; 32]));
        assert!(wf.enc_seed_hex.is_empty());
    }

    #[test]
    fn changing_the_passphrase_keeps_the_seed_reachable() {
        let mut wf = plain();
        wf.set_master_seed(&[5u8; 32], None).unwrap();
        wf.encrypt("old").unwrap();
        wf.change_passphrase("old", "new").unwrap();
        assert!(wf.master_seed(Some("old")).is_err());
        assert_eq!(wf.master_seed(Some("new")).unwrap(), Some([5u8; 32]));
    }

    #[test]
    fn a_seed_is_never_silently_replaced() {
        /*
         * Overwriting a seed orphans every address derived from the old one:
         * the coins are still on chain and nothing in the wallet can reach
         * them. That is a restore, not a setting.
         */
        let mut wf = plain();
        wf.set_master_seed(&[1u8; 32], None).unwrap();
        let err = wf.set_master_seed(&[2u8; 32], None).unwrap_err().to_string();
        assert!(err.contains("already has a master seed"), "{err}");
        assert!(err.contains("orphan"), "it explains the consequence: {err}");
        assert_eq!(wf.master_seed(None).unwrap(), Some([1u8; 32]), "unchanged");
    }

    #[test]
    fn a_locked_wallet_will_not_take_a_seed_on_a_wrong_passphrase() {
        // Writing one under the wrong key would store a seed nobody can
        // decrypt — silently losing every address derived from it later.
        let mut wf = plain();
        wf.encrypt("right").unwrap();
        assert!(wf.set_master_seed(&[9u8; 32], Some("wrong")).is_err());
        assert!(wf.enc_seed_hex.is_empty(), "nothing written on failure");
        wf.set_master_seed(&[9u8; 32], Some("right")).unwrap();
        assert_eq!(wf.master_seed(Some("right")).unwrap(), Some([9u8; 32]));
    }

    #[test]
    fn the_cursor_is_omitted_when_zero_so_old_files_stay_byte_identical() {
        // A wallet that has never derived should serialize exactly as it did
        // before this field existed.
        let json = serde_json::to_string(&plain()).unwrap();
        assert!(!json.contains("next_index"));
        assert!(!json.contains("seed_hex"));
    }
}
