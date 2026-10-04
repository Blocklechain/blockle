//! Canonical binary encoding for consensus hashing and signing.
//!
//! Fixed-width integers are little-endian; variable-length byte strings are
//! u32-length-prefixed. This encoding is what gets hashed — the JSON used for
//! disk storage is non-consensus.

pub fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_i64(out: &mut Vec<u8>, v: i64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_bytes(out: &mut Vec<u8>, v: &[u8]) {
    put_u32(out, v.len() as u32);
    out.extend_from_slice(v);
}

pub fn put_fixed(out: &mut Vec<u8>, v: &[u8]) {
    out.extend_from_slice(v);
}
