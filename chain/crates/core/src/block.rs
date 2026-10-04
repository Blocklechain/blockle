//! Block and block header.
//!
//! The header is deliberately Zcash-shaped so Equihash ASIC/pool tooling can
//! consume it: a 140-byte fixed region (version, prev hash, merkle root, a
//! 32-byte reserved/state root, time, bits, 32-byte nonce) followed by the
//! compactsize-prefixed Equihash solution. The Equihash puzzle input is the
//! first 108 bytes; the nonce is the puzzle's second input; the block hash is
//! double-SHA256 of the full serialization.

use serde::{Deserialize, Serialize};

use crate::hash::{sha256d, Hash32};
use crate::merkle::merkle_root;
use crate::transaction::Transaction;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockHeader {
    pub version: u32,
    pub prev_hash: Hash32,
    pub merkle_root: Hash32,
    /// Commitment to chain state (UTXO/note/contract roots). Zero until the
    /// state-commitment milestone; consensus requires zero for now. Occupies
    /// the reserved-hash slot of the Zcash header layout.
    pub state_root: Hash32,
    pub time: u32,
    /// Compact difficulty target (Bitcoin nBits encoding).
    pub bits: u32,
    pub nonce: [u8; 32],
    /// Equihash solution: big-endian bitstream of (c+1)-bit indices
    /// (1344 bytes on mainnet, like Zcash).
    pub solution: Vec<u8>,
}

/// Bitcoin-style compactsize length prefix.
fn put_compact_size(out: &mut Vec<u8>, n: u64) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        _ => {
            out.push(0xfe);
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
    }
}

impl BlockHeader {
    /// The 108-byte Equihash puzzle input: every header field before the
    /// nonce and solution.
    pub fn equihash_input(&self) -> [u8; 108] {
        let mut out = [0u8; 108];
        out[0..4].copy_from_slice(&self.version.to_le_bytes());
        out[4..36].copy_from_slice(&self.prev_hash);
        out[36..68].copy_from_slice(&self.merkle_root);
        out[68..100].copy_from_slice(&self.state_root);
        out[100..104].copy_from_slice(&self.time.to_le_bytes());
        out[104..108].copy_from_slice(&self.bits.to_le_bytes());
        out
    }

    /// Full wire serialization: 140-byte fixed region + solution.
    pub fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(140 + 3 + self.solution.len());
        out.extend_from_slice(&self.equihash_input());
        out.extend_from_slice(&self.nonce);
        put_compact_size(&mut out, self.solution.len() as u64);
        out.extend_from_slice(&self.solution);
        out
    }

    /// Block id: double-SHA256 of the serialized header, compared to the
    /// difficulty target as a little-endian integer.
    pub fn hash(&self) -> Hash32 {
        sha256d(&self.serialize())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Block {
    pub header: BlockHeader,
    /// Merged-mining proof: present when this block's PoW is a parent
    /// chain's (any registered ASIC algorithm) rather than a native
    /// solution. `default` keeps pre-auxpow JSON (e.g. the embedded
    /// genesis) readable; no `skip_serializing_if` — bincode (the p2p wire
    /// format) is not self-describing and must always see the Option tag.
    #[serde(default)]
    pub aux_pow: Option<crate::auxpow::AuxPow>,
    pub transactions: Vec<Transaction>,
}

impl Block {
    pub fn compute_merkle_root(&self) -> Hash32 {
        let txids: Vec<Hash32> = self.transactions.iter().map(|t| t.txid()).collect();
        merkle_root(&txids)
    }

    pub fn serialized_size(&self) -> usize {
        self.header.serialize().len()
            + self.aux_pow.as_ref().map(|a| a.serialized_size()).unwrap_or(0)
            + self.transactions.iter().map(|t| t.serialized_size()).sum::<usize>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout_is_zcash_shaped() {
        let header = BlockHeader {
            version: 4,
            prev_hash: [1; 32],
            merkle_root: [2; 32],
            state_root: [0; 32],
            time: 1_790_000_000,
            bits: 0x1f07ffff,
            nonce: [3; 32],
            solution: vec![0xaa; 1344],
        };
        assert_eq!(header.equihash_input().len(), 108);
        // 140 fixed + 3-byte compactsize (0xfd + u16) + 1344 solution.
        assert_eq!(header.serialize().len(), 140 + 3 + 1344);
        let mut tampered = header.clone();
        tampered.nonce[0] ^= 1;
        assert_ne!(header.hash(), tampered.hash());
    }
}
