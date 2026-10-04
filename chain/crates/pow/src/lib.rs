//! Proof-of-work for the Blockle blockchain.
//!
//! Two pieces live here:
//! - [`equihash`]: a memory-hard Equihash implementation (Wagner's algorithm)
//!   used as the PoW puzzle. Blockle defines its own canonical Equihash
//!   construction (Blake2b-personalized, byte-aligned collision rounds); it is
//!   deliberately *not* wire-compatible with Zcash.
//! - [`difficulty`]: Bitcoin-style compact target encoding plus an LWMA
//!   difficulty adjustment that retunes every block.

pub mod difficulty;
pub mod equihash;

pub use primitive_types::U256;

/// Litecoin-style scrypt proof-of-work hash: scrypt(N=1024, r=1, p=1) of
/// the 80-byte header, with the header itself as salt.
pub fn scrypt_pow_hash(header: &[u8]) -> [u8; 32] {
    let params = scrypt::Params::new(10, 1, 1, 32).expect("static scrypt params");
    let mut out = [0u8; 32];
    scrypt::scrypt(header, header, &params, &mut out).expect("output length is nonzero");
    out
}

/// Parent-chain PoW registry for merged mining: every major ASIC algorithm,
/// applied to a bitcoin-family 80-byte parent header. Equihash parents are
/// validated separately (variable-length Zcash headers with a solution).
pub mod parent {
    use sha2::{Digest, Sha256};
    use tiny_keccak::{CShake, Hasher as KeccakHasher};

    /// Fixed-header ASIC algorithms accepted for merged-mining parents
    /// (plus `"equihash"`, which carries a variable-length header).
    pub const FIXED_HEADER_ALGOS: [&str; 8] =
        ["sha256d", "scrypt", "x11", "blake2b", "blake2s", "blake3", "eaglesong", "kheavyhash"];

    fn sha256d(data: &[u8]) -> [u8; 32] {
        let a = Sha256::digest(data);
        Sha256::digest(a).into()
    }

    /// kHeavyHash-style keccak/matrix proof of work over an 80-byte header
    /// (HeavyHash construction: cSHAKE256 → 64×64 4-bit matrix product →
    /// xor → cSHAKE256). Defined here for bitcoin-family parents; bit-exact
    /// Kaspa-native headers are a separate adapter (different structure).
    fn kheavyhash(header: &[u8]) -> [u8; 32] {
        let mut pre = [0u8; 32];
        let mut h = CShake::v256(b"", b"ProofOfWorkHash");
        h.update(header);
        h.finalize(&mut pre);

        // Matrix from a cSHAKE256 stream seeded by the pre-hash.
        let mut stream = [0u8; 2048]; // 64*64 nibbles
        let mut g = CShake::v256(b"", b"HeavyHash");
        g.update(&pre);
        g.finalize(&mut stream);

        // v = nibbles of pre; p[i] = sum_j M[i][j] * v[j], take high nibbles.
        let v: Vec<u16> = pre
            .iter()
            .flat_map(|b| [(b >> 4) as u16, (b & 0x0f) as u16])
            .collect();
        let mut product = [0u8; 32];
        for i in 0..64 {
            let mut sum: u32 = 0;
            for j in 0..64 {
                let byte = stream[(i * 64 + j) / 2];
                let m = if j % 2 == 0 { byte >> 4 } else { byte & 0x0f };
                sum += m as u32 * v[j] as u32;
            }
            let nib = ((sum >> 10) & 0x0f) as u8;
            if i % 2 == 0 {
                product[i / 2] |= nib << 4;
            } else {
                product[i / 2] |= nib;
            }
        }
        let xored: Vec<u8> = pre.iter().zip(product.iter()).map(|(a, b)| a ^ b).collect();
        let mut out = [0u8; 32];
        let mut f = CShake::v256(b"", b"HeavyHash");
        f.update(&xored);
        f.finalize(&mut out);
        out
    }

    /// PoW hash of an 80-byte parent header under `algo`. `None` for
    /// unknown algorithms (callers reject the proof).
    pub fn pow_hash(algo: &str, header: &[u8]) -> Option<[u8; 32]> {
        if header.len() != 80 {
            return None;
        }
        Some(match algo {
            "sha256d" => sha256d(header),
            "scrypt" => super::scrypt_pow_hash(header),
            "x11" => rs_x11_hash::get_x11_hash(header),
            "blake2b" => {
                let h = blake2b_simd::Params::new().hash_length(32).hash(header);
                let mut out = [0u8; 32];
                out.copy_from_slice(h.as_bytes());
                out
            }
            "blake2s" => {
                use blake2::{Blake2s256, Digest as B2Digest};
                Blake2s256::digest(header).into()
            }
            "blake3" => *blake3::hash(header).as_bytes(),
            "eaglesong" => {
                let mut out = [0u8; 32];
                eaglesong::eaglesong(header, &mut out);
                out
            }
            "kheavyhash" => kheavyhash(header),
            _ => return None,
        })
    }
}
