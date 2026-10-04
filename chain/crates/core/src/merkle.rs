//! Merkle root over transaction ids (Blake2b-256, Bitcoin-style pairing:
//! odd levels duplicate the last node).

use crate::hash::{blake2b_256_personal, Hash32};

pub fn merkle_root(txids: &[Hash32]) -> Hash32 {
    if txids.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<Hash32> = txids.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let left = pair[0];
            let right = *pair.last().unwrap(); // duplicates left when odd
            let mut data = [0u8; 64];
            data[..32].copy_from_slice(&left);
            data[32..].copy_from_slice(&right);
            next.push(blake2b_256_personal(b"BlklMrkl", &data));
        }
        level = next;
    }
    level[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        assert_eq!(merkle_root(&[]), [0u8; 32]);
        assert_eq!(merkle_root(&[a]), a);
        assert_ne!(merkle_root(&[a, b]), merkle_root(&[b, a]));
        assert_ne!(merkle_root(&[a, b, c]), merkle_root(&[a, b]));
    }
}
