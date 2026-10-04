//! Core data structures for the Blockle blockchain.
//!
//! Everything consensus-serializable lives here: block headers, blocks,
//! transactions (including the reserved shielded bundle), amounts, keys and
//! bech32m `block1…` addresses, Merkle roots, and the canonical binary
//! encoding used for hashing and signing.

pub mod amount;
pub mod block;
pub mod encode;
pub mod hash;
pub mod keys;
pub mod merkle;
pub mod transaction;

pub use amount::{format_amount, parse_amount, COIN};
pub use block::{Block, BlockHeader};
pub use hash::{blake2b_256, display_hash, sha256d, Hash32};
pub use keys::{decode_address, encode_address, Address, Keypair};
pub use transaction::{
    ContractAction, OutPoint, SettlementEntry, SettlementMint, ShieldedBundle, ShieldedOutput,
    ShieldedSpend, ShieldedTransfer, Transaction, TxInput, TxOutput,
};
