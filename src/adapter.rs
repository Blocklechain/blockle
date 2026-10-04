//! The adapter boundary: everything chain-specific lives behind
//! [`PoolAdapter`]; the stratum engine, vardiff, ledger, and dashboard are
//! chain-agnostic.

use anyhow::Result;

use crate::btc::Target;

/// A unit of miner work derived from one chain template.
#[derive(Clone)]
pub struct Job {
    pub id: String,
    pub height: u64,
    /// Chain (block) target — meeting it means a block was found.
    pub block_target: Target,
    /// `mining.notify` params, minus the job id (engine prepends it) and
    /// the trailing clean_jobs flag (engine appends it).
    pub notify_tail: Vec<serde_json::Value>,
    /// True when miners must drop earlier jobs (new tip).
    pub clean: bool,
}

/// A miner's `mining.submit`, already split into fields.
pub struct ShareSubmit {
    pub worker: String,
    pub extranonce1: Vec<u8>,
    pub extranonce2: Vec<u8>,
    pub ntime_hex: String,
    pub nonce_hex: String,
}

/// What the adapter concluded about a submitted share.
pub enum ShareOutcome {
    /// Malformed or failing PoW entirely.
    Rejected(String),
    /// Valid work. `hash_le` lets the engine compare against the share
    /// target; `meets_block` means the adapter already checked the chain
    /// target; `meets_aux` lists merged-mining aux chains whose targets the
    /// share also satisfies.
    Valid { hash_le: [u8; 32], meets_block: bool, meets_aux: Vec<usize> },
}

/// Result of pushing a block to the chain.
pub enum BlockResult {
    Accepted { hash_display: String },
    Rejected(String),
}

pub trait PoolAdapter: Send {
    /// Human-readable chain name.
    fn chain_name(&self) -> String;

    /// Poll the node; return a new job when the template changed (or
    /// `refresh` forces one). `None` = current job still stands.
    fn poll_job(&mut self, refresh: bool) -> Result<Option<Job>>;

    /// Validate a share against `job` (PoW only — the engine applies share
    /// targets).
    fn check_share(&self, job: &Job, submit: &ShareSubmit) -> ShareOutcome;

    /// Assemble and submit the full block for a share that met the chain
    /// target.
    fn submit_block(&self, job: &Job, submit: &ShareSubmit) -> BlockResult;

    /// Size in bytes of the miner-rolled extranonce2.
    fn extranonce2_size(&self) -> usize {
        4
    }

    /// Block reward in base units, if known (for the payout ledger).
    fn block_reward(&self) -> Option<u64>;

    /// Submit a merged-mining (AuxPoW) proof to auxiliary chain `aux_index`.
    fn submit_aux(&self, _job: &Job, _submit: &ShareSubmit, _aux_index: usize) -> BlockResult {
        BlockResult::Rejected("merged mining not supported by this adapter".into())
    }

    /// Names of configured auxiliary (merged-mined) chains.
    fn aux_names(&self) -> Vec<String> {
        vec![]
    }
}
