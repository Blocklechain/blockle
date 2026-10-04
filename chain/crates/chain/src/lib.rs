//! Consensus rules, chain state, and mining for the Blockle blockchain.

pub mod chain;
pub mod contracts;
pub mod genesis;
pub mod miner;
pub mod params;

pub use chain::{Chain, ChainError, UtxoEntry};
pub use contracts::{contract_id, CallResult, ContractInfo};
pub use miner::{build_template, build_template_split, mine_block, mine_block_cancellable};
pub use params::ChainParams;
pub use blockle_pow::U256;
