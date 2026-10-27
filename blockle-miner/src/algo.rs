//! Supported proof-of-work algorithms. Each hashes the 80-byte block header and
//! returns a 32-byte digest, which the caller reads little-endian and compares
//! to the share target. Adding an algorithm is just another arm here.
use anyhow::{bail, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algo {
    Sha256d,
    Scrypt,
    X11,
    Blake2b,
    Blake2s,
    Blake3,
}

impl Algo {
    /// All algorithms, with their primary name and the coin families that use them.
    pub const ALL: &'static [(Algo, &'static str, &'static str)] = &[
        (Algo::Sha256d, "sha256d", "Bitcoin, Perbug, Bitcoin Cash"),
        (Algo::Scrypt, "scrypt", "Litecoin, Dogecoin"),
        (Algo::X11, "x11", "Dash"),
        (Algo::Blake2b, "blake2b", "Blake2b-256 header pools"),
        (Algo::Blake2s, "blake2s", "Blake2s-256 header pools"),
        (Algo::Blake3, "blake3", "Blake3 header pools"),
    ];

    pub fn name(self) -> &'static str {
        Self::ALL.iter().find(|(a, _, _)| *a == self).map(|(_, n, _)| *n).unwrap_or("?")
    }

    pub fn parse(s: &str) -> Result<Algo> {
        let k = s.trim().to_lowercase();
        Ok(match k.as_str() {
            "sha256d" | "sha256" | "sha-256" | "sha-256d" => Algo::Sha256d,
            "scrypt" | "scrypt-n" | "ltc" => Algo::Scrypt,
            "x11" => Algo::X11,
            "blake2b" | "blake2b-256" | "b2b" => Algo::Blake2b,
            "blake2s" | "blake2s-256" | "b2s" => Algo::Blake2s,
            "blake3" | "b3" => Algo::Blake3,
            other => bail!(
                "unknown algorithm '{other}'. Supported: {}",
                Self::ALL.iter().map(|(_, n, _)| *n).collect::<Vec<_>>().join(", ")
            ),
        })
    }

    /// Hash the 80-byte header with this algorithm.
    pub fn pow_hash(self, header: &[u8]) -> [u8; 32] {
        match self {
            Algo::Sha256d => crate::hash::dsha256(header),
            Algo::Scrypt => scrypt_1024_1_1_256(header),
            Algo::X11 => x11(header),
            Algo::Blake2b => blake2b_256(header),
            Algo::Blake2s => blake2s_256(header),
            Algo::Blake3 => *blake3::hash(header).as_bytes(),
        }
    }
}

/// Litecoin/Dogecoin scrypt: scrypt(header, header, N=1024, r=1, p=1) -> 32 bytes.
fn scrypt_1024_1_1_256(header: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let params = scrypt::Params::new(10, 1, 1, 32).expect("valid scrypt params");
    scrypt::scrypt(header, header, &params, &mut out).expect("scrypt output len");
    out
}

fn x11(header: &[u8]) -> [u8; 32] {
    rs_x11_hash::get_x11_hash(header)
}

fn blake2b_256(header: &[u8]) -> [u8; 32] {
    use blake2::digest::consts::U32;
    use blake2::{Blake2b, Digest};
    let mut h = Blake2b::<U32>::new();
    h.update(header);
    h.finalize().into()
}

fn blake2s_256(header: &[u8]) -> [u8; 32] {
    use blake2::{Blake2s256, Digest};
    let mut h = Blake2s256::new();
    h.update(header);
    h.finalize().into()
}
