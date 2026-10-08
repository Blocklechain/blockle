//! Chain state and full consensus validation.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use blockle_core::hash::Hash32;
use blockle_core::keys::{pubkey_to_address, verify_signature};
use blockle_core::{auxpow, sha256d, AuxPow, Block, BlockHeader, ContractAction, OutPoint, Transaction, TxOutput};
use blockle_pow::parent;
use blockle_pow::difficulty::{block_work, hash_meets_target, lwma_next_bits};
use blockle_pow::equihash;
use blockle_pow::U256;
use thiserror::Error;

use crate::contracts::{self, ContractMap, StorageMap};
use crate::params::ChainParams;

#[derive(Debug, Error)]
pub enum ChainError {
    #[error("bad previous-block hash")]
    BadPrevHash,
    #[error("bad difficulty bits (got {got:#010x}, expected {expected:#010x})")]
    BadBits { got: u32, expected: u32 },
    #[error("timestamp {0} not after median-time-past {1}")]
    TimeTooOld(i64, i64),
    #[error("timestamp too far in the future")]
    TimeTooNew,
    #[error("merged-mining proof invalid: {0}")]
    BadAuxPow(String),
    #[error("invalid equihash solution: {0}")]
    BadEquihash(#[from] equihash::EquihashError),
    #[error("header hash does not meet difficulty target")]
    InsufficientWork,
    #[error("bad merkle root")]
    BadMerkleRoot,
    #[error("state root must be zero in this protocol version")]
    BadStateRoot,
    #[error("block exceeds maximum size")]
    BlockTooLarge,
    #[error("block must start with exactly one coinbase")]
    BadCoinbase,
    #[error("coinbase pays {paid} but only {allowed} is allowed")]
    CoinbaseOverpays { paid: u64, allowed: u64 },
    #[error("shielded rule violated: {0}")]
    ShieldedRules(String),
    #[error("shielded spend proof failed verification")]
    BadSpendProof,
    #[error("nullifier already spent")]
    NullifierReused,
    #[error("unknown note-tree anchor")]
    UnknownAnchor,
    #[error("block 0 does not match this network's fixed genesis")]
    WrongGenesis,
    #[error("transaction {0} is malformed")]
    MalformedTx(String),
    #[error("input spends unknown or already-spent output")]
    MissingUtxo,
    #[error("coinbase output spent before maturity")]
    ImmatureSpend,
    #[error("input signature or key invalid")]
    BadInputAuth,
    #[error("transaction outputs exceed inputs")]
    ValueOutOfRange,
    #[error("duplicate spend within block")]
    DoubleSpend,
    #[error("contract rule violated: {0}")]
    ContractRules(String),
    #[error("block exceeds gas limit")]
    BlockGasLimit,
}

#[derive(Clone, Debug)]
pub struct UtxoEntry {
    pub output: TxOutput,
    pub height: u64,
    pub coinbase: bool,
}

/// Fully-validated chain plus its UTXO set. Prototype scope: the whole chain
/// lives in memory and persistence is the caller's job.
#[derive(Clone)]
pub struct Chain {
    pub params: ChainParams,
    pub blocks: Vec<Block>,
    pub utxos: HashMap<OutPoint, UtxoEntry>,
    pub contracts: ContractMap,
    pub contract_storage: StorageMap,
    pub pools: crate::pools::PoolState,
    /// Shielded pool: note commitments in insertion order.
    pub note_leaves: Vec<Hash32>,
    /// Note-tree roots as of the end of every block (valid spend anchors).
    pub note_anchors: HashSet<Hash32>,
    /// Revealed nullifiers (spent notes).
    pub nullifiers: HashSet<Hash32>,
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before 1970")
        .as_secs() as i64
}

impl Chain {
    pub fn new(params: ChainParams) -> Self {
        let mut note_anchors = HashSet::new();
        note_anchors.insert(blockle_zk::empty_root());
        Chain {
            params,
            blocks: Vec::new(),
            utxos: HashMap::new(),
            contracts: HashMap::new(),
            contract_storage: HashMap::new(),
            pools: crate::pools::PoolState::default(),
            note_leaves: Vec::new(),
            note_anchors,
            nullifiers: HashSet::new(),
        }
    }

    /// Rebuild a chain by re-validating every stored block.
    pub fn from_blocks(params: ChainParams, blocks: Vec<Block>) -> Result<Self, ChainError> {
        let mut chain = Chain::new(params);
        for block in blocks {
            chain.connect_block(block)?;
        }
        Ok(chain)
    }

    pub fn height(&self) -> Option<u64> {
        self.blocks.len().checked_sub(1).map(|h| h as u64)
    }

    pub fn tip_hash(&self) -> Hash32 {
        self.blocks.last().map(|b| b.header.hash()).unwrap_or([0u8; 32])
    }

    /// Total accumulated proof-of-work — the fork-choice metric.
    pub fn total_work(&self) -> U256 {
        self.blocks
            .iter()
            .fold(U256::zero(), |acc, b| acc.saturating_add(block_work(b.header.bits)))
    }

    /// Median timestamp of the last 11 blocks.
    pub fn median_time_past(&self) -> i64 {
        let mut times: Vec<i64> = self
            .blocks
            .iter()
            .rev()
            .take(11)
            .map(|b| b.header.time as i64)
            .collect();
        if times.is_empty() {
            return 0;
        }
        times.sort_unstable();
        times[times.len() / 2]
    }

    /// Expected difficulty bits for the next block (LWMA, per-block).
    /// Native-lane difficulty (see [`Chain::next_bits_for`]).
    pub fn next_bits(&self) -> u32 {
        self.next_bits_for("native")
    }

    /// The mining lane a block belongs to: `"native"` for its own Equihash
    /// solution, otherwise the merged-mining parent algorithm.
    pub fn lane_of(block: &Block) -> &'static str {
        match &block.aux_pow {
            None => "native",
            Some(ap) => {
                if ap.parent_algo == "equihash" {
                    return "equihash";
                }
                parent::FIXED_HEADER_ALGOS
                    .iter()
                    .find(|a| **a == ap.parent_algo)
                    .copied()
                    .unwrap_or("unknown")
            }
        }
    }

    /// All mining lanes this chain accepts: the native solver plus every
    /// registered ASIC parent algorithm.
    pub fn lanes(&self) -> Vec<&'static str> {
        let mut lanes = vec!["native"];
        if self.params.aux_pow {
            lanes.extend(parent::FIXED_HEADER_ALGOS);
            lanes.push("equihash");
        }
        lanes
    }

    /// Per-lane LWMA difficulty: each lane retargets over its own blocks at
    /// `target_spacing × lane_count`, so the lanes together emit one block
    /// per `target_spacing` while staying independently calibrated to their
    /// hardware (an S19's sha256d and an L7's scrypt share nothing).
    pub fn next_bits_for(&self, lane: &str) -> u32 {
        let spacing = self.params.target_spacing * self.lanes().len() as u64;
        let headers: Vec<(u32, i64)> = self
            .blocks
            .iter()
            .filter(|b| Self::lane_of(b) == lane)
            .map(|b| (b.header.bits, b.header.time as i64))
            .collect();
        lwma_next_bits(spacing, self.params.lwma_window, self.params.pow_limit, &headers)
    }

    /// Grace window and halflife (seconds) for the quiet-lane difficulty decay
    /// at a given block height. Two schedules so the live fork doesn't rewrite
    /// history: below `decay_v2_height` the original v1 schedule (grace = twice
    /// the per-lane spacing; halve every chain interval); at/above it the
    /// faster v2 schedule (grace = two chain intervals; halve every half
    /// interval) so a quiet lane recovers in minutes instead of hours.
    fn decay_params(&self, height: u64) -> (u64, u64) {
        let s = self.params.target_spacing.max(1);
        if height >= self.params.decay_v2_height {
            // v2: grace of one block interval, difficulty halving every fifth
            // of an interval — a quiet lane recovers within an hour even from
            // a badly-overshot difficulty (mainnet: 10min grace, ~2min halving).
            (s, (s / 5).max(1))
        } else {
            // v1 (frozen for blocks mined before the v2 activation height):
            // grace = twice the per-lane spacing, halve every chain interval.
            let spacing = s * self.lanes().len() as u64;
            (2 * spacing, s)
        }
    }

    /// Timestamp of the most recent block mined on `lane`, if any.
    fn lane_last_time(&self, lane: &str) -> Option<i64> {
        self.blocks
            .iter()
            .rev()
            .find(|b| Self::lane_of(b) == lane)
            .map(|b| b.header.time as i64)
    }

    /// Difficulty bits required for the next block on `lane` given the
    /// candidate block's timestamp: the LWMA target (see [`Chain::next_bits_for`]),
    /// plus the quiet-lane decay once the lane has been silent past the grace
    /// window. Pure LWMA below `decay_activation_height`.
    pub fn next_bits_for_at(&self, lane: &str, now_ts: i64) -> u32 {
        let base = self.next_bits_for(lane);
        let height = self.blocks.len() as u64;
        if height < self.params.decay_activation_height {
            return base;
        }
        match self.lane_last_time(lane) {
            Some(last) => {
                let (grace, halflife) = self.decay_params(height);
                blockle_pow::difficulty::decayed_next_bits(
                    base,
                    self.params.pow_limit,
                    now_ts - last,
                    grace,
                    halflife,
                )
            }
            None => base,
        }
    }

    /// Validate a merged-mining proof: the parent header's PoW (under the
    /// parent's own algorithm) must meet OUR lane difficulty, and its
    /// coinbase must commit to this block's header hash through the
    /// Namecoin-shaped commitment tree.
    fn check_aux_pow(&self, header: &BlockHeader, ap: &AuxPow) -> Result<(), ChainError> {
        let bad = |m: &str| ChainError::BadAuxPow(m.into());
        if !header.solution.is_empty() || header.nonce != [0u8; 32] {
            return Err(bad("aux blocks must carry no native solution"));
        }
        let pow_hash = match ap.parent_algo.as_str() {
            "equihash" => {
                if ap.parent_header.len() < 141 {
                    return Err(bad("equihash parent header too short"));
                }
                let input = &ap.parent_header[..108];
                let nonce: [u8; 32] = ap.parent_header[108..140]
                    .try_into()
                    .expect("length checked");
                let (sol_len, sol_start) = match ap.parent_header[140] {
                    n @ 0..=252 => (n as usize, 141usize),
                    253 => {
                        if ap.parent_header.len() < 143 {
                            return Err(bad("equihash parent header truncated"));
                        }
                        let n = u16::from_le_bytes(
                            ap.parent_header[141..143].try_into().expect("len"),
                        );
                        (n as usize, 143usize)
                    }
                    _ => return Err(bad("oversized parent solution")),
                };
                if ap.parent_header.len() != sol_start + sol_len {
                    return Err(bad("equihash parent header length mismatch"));
                }
                let sol = &ap.parent_header[sol_start..];
                let indices = equihash::unpack_solution(&self.params.equihash, sol)
                    .map_err(|_| bad("parent equihash solution malformed"))?;
                equihash::verify(&self.params.equihash, input, &nonce, &indices)
                    .map_err(|_| bad("parent equihash solution invalid"))?;
                sha256d(&ap.parent_header)
            }
            algo => parent::pow_hash(algo, &ap.parent_header)
                .ok_or_else(|| bad("unknown parent algorithm or bad header length"))?,
        };
        if !hash_meets_target(&pow_hash, header.bits, self.params.pow_limit) {
            return Err(ChainError::InsufficientWork);
        }

        let (root, size, cnonce) = auxpow::find_commitment(&ap.parent_coinbase)
            .ok_or_else(|| bad("no merged-mining commitment in parent coinbase"))?;
        if !size.is_power_of_two() || ap.chain_branch.len() as u32 != size.trailing_zeros() {
            return Err(bad("commitment tree size/branch mismatch"));
        }
        if auxpow::aux_slot(self.params.aux_chain_id, size, cnonce) != ap.chain_index {
            return Err(bad("chain index does not match slot derivation"));
        }
        // Standard Namecoin-style merge-mining pools (Myriad, Doichain,
        // Syscoin, Unobtanium…) write the aux merkle root BYTE-REVERSED after
        // the magic — hashes are uint256 internally and many codebases emit
        // the display (reversed) order. Our own pools write it unreversed.
        // Accept either orientation so an existing multi-coin pool can add
        // BLOCK at chain id 16972 without maintaining a special coinbase.
        let folded = auxpow::fold_branch(header.hash(), &ap.chain_branch, ap.chain_index);
        let mut root_rev = root;
        root_rev.reverse();
        if folded != root && folded != root_rev {
            return Err(bad("header hash does not fold to committed root"));
        }

        let txid = sha256d(&ap.parent_coinbase);
        let parent_root = auxpow::parent_merkle_root(&ap.parent_header)
            .ok_or_else(|| bad("parent header too short for merkle root"))?;
        if auxpow::fold_coinbase_branch(txid, &ap.coinbase_branch) != parent_root {
            return Err(bad("coinbase not proven in parent block"));
        }
        Ok(())
    }

    pub fn balance(&self, address: &[u8; 32]) -> u64 {
        self.utxos
            .values()
            .filter(|e| &e.output.recipient == address)
            .map(|e| e.output.amount)
            .sum()
    }

    pub fn spendable_utxos(&self, address: &[u8; 32]) -> Vec<(OutPoint, UtxoEntry)> {
        let next_height = self.blocks.len() as u64;
        self.utxos
            .iter()
            .filter(|(_, e)| &e.output.recipient == address)
            .filter(|(_, e)| self.is_mature(e, next_height))
            .map(|(op, e)| (*op, e.clone()))
            .collect()
    }

    fn is_mature(&self, entry: &UtxoEntry, spend_height: u64) -> bool {
        // Genesis premine is an allocation, not a mining reward — exempt.
        if !entry.coinbase || entry.height == 0 {
            return true;
        }
        spend_height >= entry.height + self.params.coinbase_maturity
    }

    /// Stateless + contextual checks on a non-coinbase transaction against the
    /// provided UTXO view. Returns the fee.
    pub fn check_transaction(
        &self,
        tx: &Transaction,
        view: &HashMap<OutPoint, UtxoEntry>,
        height: u64,
    ) -> Result<u64, ChainError> {
        self.check_shielded(tx)?;
        match &tx.contract {
            None => {}
            Some(ContractAction::Deploy { code, gas_limit }) => {
                if code.is_empty() || code.len() > self.params.max_contract_code {
                    return Err(ChainError::ContractRules("bad code size".into()));
                }
                if *gas_limit > self.params.block_gas_limit {
                    return Err(ChainError::ContractRules("gas limit too high".into()));
                }
            }
            Some(ContractAction::Call { input, gas_limit, .. }) => {
                if input.len() > self.params.max_contract_input {
                    return Err(ChainError::ContractRules("input too large".into()));
                }
                if *gas_limit > self.params.block_gas_limit {
                    return Err(ChainError::ContractRules("gas limit too high".into()));
                }
            }
            // Native AMM pool actions — bound gas like other actions. Economic
            // validity (balances, slippage, lock) is enforced at apply time,
            // which refunds the BLOCK value if the action can't execute.
            Some(action) => {
                if action.gas_limit() > self.params.block_gas_limit {
                    return Err(ChainError::ContractRules("gas limit too high".into()));
                }
            }
        }
        let has_spends = tx
            .shielded
            .as_ref()
            .is_some_and(|b| !b.spends.is_empty() || !b.transfers.is_empty());
        let has_shielded_outputs = tx
            .shielded
            .as_ref()
            .is_some_and(|b| !b.outputs.is_empty() || !b.transfers.is_empty());
        if tx.inputs.is_empty() && !has_spends {
            return Err(ChainError::MalformedTx("no funding inputs".into()));
        }
        if tx.outputs.is_empty() && !has_shielded_outputs {
            return Err(ChainError::MalformedTx("no outputs".into()));
        }
        if tx.contract.is_some() && tx.inputs.is_empty() {
            // Contract actions need a transparent sender (refund address).
            return Err(ChainError::ContractRules("contract action needs a transparent input".into()));
        }
        if !tx.coinbase_data.is_empty() {
            return Err(ChainError::MalformedTx("coinbase_data on regular tx".into()));
        }
        if tx.outputs.iter().any(|o| o.amount == 0) {
            return Err(ChainError::MalformedTx("zero-value output".into()));
        }
        let mut spent: Vec<OutPoint> = Vec::new();
        let mut total_in: u64 = 0;
        let sighash = tx.sighash();
        for input in &tx.inputs {
            if spent.contains(&input.prev) {
                return Err(ChainError::DoubleSpend);
            }
            spent.push(input.prev);
            let entry = view.get(&input.prev).ok_or(ChainError::MissingUtxo)?;
            if !self.is_mature(entry, height) {
                return Err(ChainError::ImmatureSpend);
            }
            if pubkey_to_address(&input.pubkey) != entry.output.recipient {
                return Err(ChainError::BadInputAuth);
            }
            verify_signature(&input.pubkey, &sighash, &input.signature)
                .map_err(|_| ChainError::BadInputAuth)?;
            total_in = total_in
                .checked_add(entry.output.amount)
                .ok_or(ChainError::ValueOutOfRange)?;
        }
        let total_out = tx.total_output().ok_or(ChainError::ValueOutOfRange)?;
        let action_value = tx.contract.as_ref().map(|a| a.value()).unwrap_or(0);
        let z_in = tx.shielded_in().ok_or(ChainError::ValueOutOfRange)?;
        let z_out = tx.shielded_out().ok_or(ChainError::ValueOutOfRange)?;
        let transfer_fees = tx.transfer_fees().ok_or(ChainError::ValueOutOfRange)?;
        let fee = total_in
            .checked_add(z_in)
            .and_then(|v| v.checked_sub(total_out))
            .and_then(|v| v.checked_sub(action_value))
            .and_then(|v| v.checked_sub(z_out))
            .and_then(|v| v.checked_add(transfer_fees))
            .ok_or(ChainError::ValueOutOfRange)?;
        // Gas is prepaid: the fee must cover the full gas limit.
        if let Some(action) = &tx.contract {
            let gas_cost = action
                .gas_limit()
                .checked_mul(self.params.gas_price)
                .ok_or(ChainError::ValueOutOfRange)?;
            if fee < gas_cost {
                return Err(ChainError::ContractRules(format!(
                    "fee {fee} does not cover gas {gas_cost}"
                )));
            }
        }
        Ok(fee)
    }


    /// Validate a transaction's shielded bundle against chain-level state:
    /// canonical encodings, known anchors, unused nullifiers, pool capacity,
    /// and the STARK spend proofs (each bound to this tx's sighash).
    fn check_shielded(&self, tx: &Transaction) -> Result<(), ChainError> {
        let Some(bundle) = &tx.shielded else { return Ok(()) };
        let rules = |m: &str| ChainError::ShieldedRules(m.into());
        if bundle.spends.is_empty() && bundle.outputs.is_empty() && bundle.transfers.is_empty() {
            return Err(rules("empty shielded bundle"));
        }
        let new_notes = bundle.outputs.len() + 2 * bundle.transfers.len();
        if self.note_leaves.len() + new_notes > blockle_zk::MAX_NOTES {
            return Err(rules("note tree is full"));
        }
        let sighash = blockle_zk::bytes_to_felts_reduced(&tx.sighash());
        let mut seen: Vec<Hash32> = Vec::new();
        for spend in &bundle.spends {
            if spend.value == 0 {
                return Err(rules("zero-value spend"));
            }
            let nullifier = blockle_zk::bytes_to_felts(&spend.nullifier)
                .map_err(|_| rules("non-canonical nullifier"))?;
            let anchor = blockle_zk::bytes_to_felts(&spend.anchor)
                .map_err(|_| rules("non-canonical anchor"))?;
            if !self.note_anchors.contains(&spend.anchor) {
                return Err(ChainError::UnknownAnchor);
            }
            if self.nullifiers.contains(&spend.nullifier) || seen.contains(&spend.nullifier) {
                return Err(ChainError::NullifierReused);
            }
            seen.push(spend.nullifier);
            if !blockle_zk::verify_spend(
                &spend.proof,
                anchor,
                nullifier,
                blockle_zk::BaseElement::new(spend.value as u128),
                sighash,
            ) {
                return Err(ChainError::BadSpendProof);
            }
        }
        for output in &bundle.outputs {
            if output.value == 0 {
                return Err(rules("zero-value shielded output"));
            }
            blockle_zk::bytes_to_felts(&output.commitment)
                .map_err(|_| rules("non-canonical commitment"))?;
        }
        for t in &bundle.transfers {
            if t.memo.len() > 4096 {
                return Err(rules("memo too large"));
            }
            let nullifier = blockle_zk::bytes_to_felts(&t.nullifier)
                .map_err(|_| rules("non-canonical nullifier"))?;
            let anchor = blockle_zk::bytes_to_felts(&t.anchor)
                .map_err(|_| rules("non-canonical anchor"))?;
            let c1 = blockle_zk::bytes_to_felts(&t.commitment1)
                .map_err(|_| rules("non-canonical commitment"))?;
            let c2 = blockle_zk::bytes_to_felts(&t.commitment2)
                .map_err(|_| rules("non-canonical commitment"))?;
            if !self.note_anchors.contains(&t.anchor) {
                return Err(ChainError::UnknownAnchor);
            }
            if self.nullifiers.contains(&t.nullifier) || seen.contains(&t.nullifier) {
                return Err(ChainError::NullifierReused);
            }
            seen.push(t.nullifier);
            if !blockle_zk::verify_transfer(&t.proof, anchor, nullifier, c1, c2, t.fee, sighash) {
                return Err(ChainError::BadSpendProof);
            }
        }
        Ok(())
    }

    /// Apply a validated transaction's effects — spend inputs, create
    /// outputs, run any contract action, mint payout/refund UTXOs, record
    /// nullifiers, append note commitments — to the given state views.
    /// Shared by block validation and the miner so both compute identical
    /// state.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_tx_effects(
        tx: &Transaction,
        txid: &Hash32,
        height: u64,
        utxos: &mut HashMap<OutPoint, UtxoEntry>,
        contracts: &mut ContractMap,
        storage: &mut StorageMap,
        pools: &mut crate::pools::PoolState,
        nullifiers: &mut HashSet<Hash32>,
        note_leaves: &mut Vec<Hash32>,
    ) {
        if let Some(bundle) = &tx.shielded {
            for spend in &bundle.spends {
                nullifiers.insert(spend.nullifier);
            }
            for output in &bundle.outputs {
                note_leaves.push(output.commitment);
            }
            for t in &bundle.transfers {
                nullifiers.insert(t.nullifier);
                note_leaves.push(t.commitment1);
                note_leaves.push(t.commitment2);
            }
        }
        for input in &tx.inputs {
            utxos.remove(&input.prev);
        }
        for (vout, output) in tx.outputs.iter().enumerate() {
            utxos.insert(
                OutPoint { txid: *txid, vout: vout as u32 },
                UtxoEntry { output: output.clone(), height, coinbase: false },
            );
        }
        let mut payouts = contracts::apply_contract_action(tx, txid, height, contracts, storage);
        if let Some(action) = &tx.contract {
            if matches!(
                action,
                ContractAction::PoolCreate { .. }
                    | ContractAction::PoolAdd { .. }
                    | ContractAction::PoolRemove { .. }
                    | ContractAction::PoolSwapBuy { .. }
                    | ContractAction::PoolSwapSell { .. }
            ) {
                payouts.extend(crate::pools::apply_pool_action(action, tx, height, pools, storage));
            }
        }
        let pay_txid = contracts::payout_txid(txid);
        for (vout, (recipient, amount)) in payouts.into_iter().enumerate() {
            utxos.insert(
                OutPoint { txid: pay_txid, vout: vout as u32 },
                UtxoEntry {
                    output: TxOutput { recipient, amount },
                    height,
                    coinbase: false,
                },
            );
        }
    }

    /// Validate `block` as the next block and connect it.
    pub fn connect_block(&mut self, block: Block) -> Result<(), ChainError> {
        let height = self.blocks.len() as u64;
        let header = &block.header;

        // -- Header context --
        if header.prev_hash != self.tip_hash() {
            return Err(ChainError::BadPrevHash);
        }
        // Networks with an embedded genesis accept exactly that block 0.
        if height == 0 {
            if let Some(genesis) = crate::genesis::embedded_genesis(&self.params.name) {
                if block.header.hash() != genesis.header.hash() {
                    return Err(ChainError::WrongGenesis);
                }
            }
        }
        let lane = Self::lane_of(&block);
        if lane == "unknown" {
            return Err(ChainError::BadAuxPow("unknown parent algorithm".into()));
        }
        if block.aux_pow.is_some() && !self.params.aux_pow {
            return Err(ChainError::BadAuxPow("merged mining not enabled".into()));
        }
        let expected_bits = self.next_bits_for_at(lane, header.time as i64);
        if header.bits != expected_bits {
            return Err(ChainError::BadBits { got: header.bits, expected: expected_bits });
        }
        let mtp = self.median_time_past();
        if height > 0 && (header.time as i64) <= mtp {
            return Err(ChainError::TimeTooOld(header.time as i64, mtp));
        }
        if header.time as i64 > now_unix() + self.params.max_future_drift {
            return Err(ChainError::TimeTooNew);
        }
        if header.state_root != [0u8; 32] {
            return Err(ChainError::BadStateRoot);
        }

        // -- Proof of work: native Equihash, or a parent chain's via AuxPoW --
        match &block.aux_pow {
            None => {
                let indices = equihash::unpack_solution(&self.params.equihash, &header.solution)?;
                equihash::verify(
                    &self.params.equihash,
                    &header.equihash_input(),
                    &header.nonce,
                    &indices,
                )?;
                if !hash_meets_target(&header.hash(), header.bits, self.params.pow_limit) {
                    return Err(ChainError::InsufficientWork);
                }
            }
            Some(ap) => self.check_aux_pow(header, ap)?,
        }

        // -- Block body --
        if block.serialized_size() > self.params.max_block_size {
            return Err(ChainError::BlockTooLarge);
        }
        if block.transactions.is_empty() || !block.transactions[0].is_coinbase() {
            return Err(ChainError::BadCoinbase);
        }
        if block.transactions[1..].iter().any(|t| t.is_coinbase()) {
            return Err(ChainError::BadCoinbase);
        }
        if block.compute_merkle_root() != header.merkle_root {
            return Err(ChainError::BadMerkleRoot);
        }

        // -- Transactions --
        let mut view = self.utxos.clone();
        let mut cview = self.contracts.clone();
        let mut sview = self.contract_storage.clone();
        let mut pview = self.pools.clone();
        let mut nview = self.nullifiers.clone();
        let mut lview = self.note_leaves.clone();
        let mut fees: u64 = 0;
        let mut gas_total: u64 = 0;
        for tx in &block.transactions[1..] {
            let fee = self.check_transaction(tx, &view, height)?;
            fees = fees.checked_add(fee).ok_or(ChainError::ValueOutOfRange)?;
            // check_transaction sees only chain-level nullifiers; catch
            // duplicates across transactions within this block here.
            if tx.nullifiers().iter().any(|n| nview.contains(n)) {
                return Err(ChainError::NullifierReused);
            }
            if let Some(action) = &tx.contract {
                gas_total = gas_total
                    .checked_add(action.gas_limit())
                    .ok_or(ChainError::ValueOutOfRange)?;
                if gas_total > self.params.block_gas_limit {
                    return Err(ChainError::BlockGasLimit);
                }
            }
            let txid = tx.txid();
            Self::apply_tx_effects(
                tx, &txid, height, &mut view, &mut cview, &mut sview, &mut pview, &mut nview,
                &mut lview,
            );
        }

        // -- Coinbase amount --
        let coinbase = &block.transactions[0];
        if coinbase.shielded.is_some() {
            return Err(ChainError::ShieldedRules("shielded bundle on coinbase".into()));
        }
        if coinbase.contract.is_some() {
            return Err(ChainError::ContractRules("contract action on coinbase".into()));
        }
        let paid = coinbase.total_output().ok_or(ChainError::ValueOutOfRange)?;
        let allowed = self
            .params
            .block_subsidy(height)
            .checked_add(fees)
            .ok_or(ChainError::ValueOutOfRange)?;
        if paid > allowed {
            return Err(ChainError::CoinbaseOverpays { paid, allowed });
        }
        let coinbase_txid = coinbase.txid();
        for (vout, output) in coinbase.outputs.iter().enumerate() {
            view.insert(
                OutPoint { txid: coinbase_txid, vout: vout as u32 },
                UtxoEntry { output: output.clone(), height, coinbase: true },
            );
        }

        // Commit; if the note tree grew, its new root becomes a valid anchor
        // from the next block onward.
        if lview.len() != self.note_leaves.len() {
            let tree = blockle_zk::NoteTree::from_leaves(&lview)
                .map_err(|e| ChainError::ShieldedRules(e.to_string()))?;
            self.note_anchors.insert(tree.root());
        }
        self.utxos = view;
        self.contracts = cview;
        self.contract_storage = sview;
        self.pools = pview;
        self.nullifiers = nview;
        self.note_leaves = lview;
        self.blocks.push(block);
        Ok(())
    }

    /// Dry-run a contract call against current state (no mutation). Used by
    /// `blockle contract simulate`.
    pub fn simulate_call(
        &self,
        contract: &Hash32,
        caller: [u8; 32],
        input: &[u8],
        value: u64,
        gas_limit: u64,
    ) -> contracts::CallResult {
        let mut cview = self.contracts.clone();
        let mut sview = self.contract_storage.clone();
        contracts::execute_call(
            contract,
            input,
            value,
            gas_limit,
            caller,
            self.blocks.len() as u64,
            &mut cview,
            &mut sview,
        )
    }
}
