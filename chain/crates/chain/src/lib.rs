//! Consensus rules, chain state, and mining for the Blockle blockchain.

pub mod anchor_registry;
pub mod block20;
pub mod block721;
pub mod stablecoin;
pub mod chain;
pub mod clawback;
pub mod contracts;
pub mod genesis;
pub mod intel;
pub mod intel_consensus;
pub mod mempool;
pub mod miner;
pub mod params;
pub mod pools;

pub use chain::{Chain, ChainError, UtxoEntry};
pub use mempool::{
    ancestor_count, pending_spends, pending_view, spendable_with_pending, topo_order,
    MAX_PENDING_CHAIN,
};
pub use contracts::{contract_id, CallResult, ContractInfo};
pub use miner::{build_template, build_template_split, mine_block, mine_block_cancellable};
pub use params::ChainParams;
pub use blockle_pow::U256;
