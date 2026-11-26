//! Chain state and full consensus validation.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use blockle_core::hash::Hash32;
use blockle_core::keys::{pubkey_to_address, verify_signature};
use blockle_core::{auxpow, sha256d, AuxPow, Block, BlockHeader, ContractAction, OutPoint, Transaction, TxOutput};
use blockle_pow::parent;
use blockle_pow::difficulty::{
    block_work, energy_work, hash_meets_target, lwma_coupled_next_bits, lwma_next_bits,
};
use blockle_pow::{energy_coeff, max_energy_coeff, ENERGY_COEFF_SCALE};
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
    /// BEHIND AN Arc PER BLOCK ON PURPOSE.
    ///
    /// This was `Vec<Block>`, which made `Chain::clone()` deep-copy every
    /// transaction of every block — 954 MB of block bodies at height 82,000.
    /// That cost was paid on the reorg path (`blocks[..start].to_vec()` under
    /// the state lock) and, worse, it made *retaining a previous Chain* for the
    /// bounded reorg impossible: any retained copy raises the `Arc<Chain>`
    /// refcount in `p2p::SharedState`, so the next `Arc::make_mut` on a block
    /// connect would deep-copy a gigabyte — re-creating the glibc-arena RSS
    /// blowup (24.8 GB RSS for a 441 MB chain) that the `Arc<Chain>` there was
    /// introduced to fix.
    ///
    /// With `Arc<Block>` a clone copies one pointer per block (82k × 8 B =
    /// 0.66 MB) plus the state maps, which is what makes the snapshot ring in
    /// `p2p::SharedState::snaps` affordable. Callers keep using the elements as
    /// `Block` through `Deref`.
    pub blocks: Vec<Arc<Block>>,
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
    /// Derived (non-consensus) BLOCK-721 ownership index: (contract, token id)
    /// -> current owner. Rebuilt from Transfer events as blocks connect.
    ///
    /// A reorg never *un-indexes* anything: it replays forward from a state
    /// that predates the fork (a retained prefix snapshot, or `from_blocks`
    /// from genesis for forks deeper than the snapshot horizon), so the index
    /// is reconstructed rather than patched. The wrong conclusion to draw from
    /// the bounded-reorg change is that this comment's old claim ("a reorg
    /// replays via `from_blocks`") still holds literally — it does not; the
    /// *property* it relied on (forward replay only, never rollback) is what
    /// still holds, and is why there is no un-index path to get wrong.
    pub nft_owner: HashMap<([u8; 32], [u8; 32]), [u8; 32]>,
    /// Blockle Intelligence consensus state (subnet/neuron registries). Empty and
    /// inert until `params.intel_activation_height`. See crate::intel.
    pub intel: crate::intel::IntelState,
    /// Prefix sums of the fork-choice work metric: `work_prefix[n]` is the
    /// total work of `blocks[..n]`, so `work_prefix.len() == blocks.len() + 1`
    /// and `work_prefix[0] == 0`.
    ///
    /// WHY A PREFIX VECTOR AND NOT JUST A RUNNING TOTAL: `total_work()` used to
    /// fold over every block on every call, and p2p calls it 3-4 times per
    /// adoption, once per `Tip` message and once per `Headers` message. A
    /// running scalar would fix that, but the *header gate* additionally needs
    /// the work of a PREFIX of our chain (the part a fork would retain). That
    /// gate used to compute the prefix with raw `block_work` while comparing
    /// against the energy-weighted `total_work()` — a unit mismatch that both
    /// stalled syncing nodes forever and triggered hundreds of pointless
    /// from-genesis rebuilds an hour. With prefix sums the gate reads the
    /// weighted prefix in O(1) and the mismatch cannot be reintroduced.
    ///
    /// Stable under extension because the weighting keys off a fixed
    /// activation height (`params.cross_algo_activation_height`), never off the
    /// current tip; truncated and rebuilt by `from_blocks` on a reorg.
    work_prefix: Vec<U256>,
    /// Heights of the blocks belonging to each mining lane, ascending.
    ///
    /// WHY THIS EXISTS: `next_bits_for` / `lane_last_time` need the most recent
    /// `lwma_window + 1` blocks OF ONE LANE, and an idle lane's 18th-most-recent
    /// block can be thousands of blocks back — so, unlike the coupled retarget,
    /// a fixed tail of `blocks` is NOT sufficient and the obvious "just take the
    /// last 18 blocks" optimisation is wrong. Without this index every
    /// `connect_block` filtered the whole chain (measured 1.2 ms of the 1.4 ms
    /// per-block cost at height 58,000), which is what made `from_blocks`
    /// ~O(n^1.6) and a node restart a 17-minute replay.
    ///
    /// Consensus-affecting: `next_bits_for_at` is enforced as
    /// `header.bits != expected_bits`, so a stale or mis-ordered index is a
    /// chain split. It is an owned field, so `Clone` carries it exactly and
    /// `from_blocks` rebuilds it from the same `connect_block` calls; debug
    /// builds cross-check it against a full reverse walk on every connect, and
    /// `tests/reorg_equivalence.rs` checks it height-by-height, lane-by-lane
    /// against the retained full-scan implementation over real mainnet blocks.
    lane_pos: HashMap<&'static str, Vec<u32>>,
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
            nft_owner: HashMap::new(),
            intel: crate::intel::IntelState::default(),
            work_prefix: vec![U256::zero()],
            lane_pos: HashMap::new(),
        }
    }

    /// Rebuild a chain by re-validating every stored block.
    ///
    /// This is the REFERENCE IMPLEMENTATION of chain assembly and is kept
    /// deliberately: it is both the fallback for forks deeper than the reorg
    /// snapshot horizon and the differential oracle every bounded-reorg test
    /// compares against. Do not delete it in the name of having one path.
    pub fn from_blocks(params: ChainParams, blocks: Vec<Block>) -> Result<Self, ChainError> {
        let mut chain = Chain::new(params);
        for block in blocks {
            chain.connect_block(block)?;
        }
        Ok(chain)
    }

    /// [`Chain::from_blocks`], but also handing back validated PREFIX states
    /// taken every `interval` blocks over the last `keep` of them.
    ///
    /// WHY THIS EXISTS: the bounded-reorg path replays forward from a retained
    /// prefix, and a prefix state cannot be recovered from the tip state after
    /// the fact — connecting blocks mutates the maps in place, so by the time
    /// you hold the tip, height-32's state is gone. The only cheap moment to
    /// capture it is while passing through it.
    ///
    /// And a node that starts up already at the tip has no other chance.
    /// `Node::new` began with an empty ring, so a restarted node fell back to
    /// the from-genesis rebuild for even a depth-1 fork — which is 17 minutes
    /// at height 82,000, retried every 10 seconds, forever. That is the
    /// reported "stuck at 57999, reinstall did not help": reinstalling
    /// preserves the datadir, so the restart put it straight back into the
    /// same hole. See `a_node_restarted_from_its_datadir_has_no_replay_base`.
    ///
    /// COSTS NOTHING EXTRA. The startup replay already connects every block
    /// from genesis; this adds one `Arc` clone per `interval` blocks, and the
    /// deep copy it implies is deferred to the next `Arc::make_mut` — which is
    /// the state maps, not the block bodies.
    pub fn from_blocks_with_prefixes(
        params: ChainParams,
        blocks: Vec<Block>,
        interval: u64,
        keep: usize,
    ) -> Result<(Self, Vec<Arc<Self>>), ChainError> {
        let mut chain = Chain::new(params);
        let mut prefixes: VecDeque<Arc<Self>> = VecDeque::new();
        for block in blocks {
            chain.connect_block(block)?;
            let len = chain.blocks.len() as u64;
            if interval != 0 && len % interval == 0 {
                prefixes.push_back(Arc::new(chain.clone()));
                while prefixes.len() > keep {
                    prefixes.pop_front();
                }
            }
        }
        Ok((chain, prefixes.into_iter().collect()))
    }

    /// [`Chain::from_blocks`] over already-shared blocks — identical validation,
    /// without copying each block body to hand it over.
    pub fn from_arc_blocks(
        params: ChainParams,
        blocks: Vec<Arc<Block>>,
    ) -> Result<Self, ChainError> {
        let mut chain = Chain::new(params);
        for block in blocks {
            chain.connect_block_arc(block)?;
        }
        Ok(chain)
    }

    pub fn height(&self) -> Option<u64> {
        self.blocks.len().checked_sub(1).map(|h| h as u64)
    }

    pub fn tip_hash(&self) -> Hash32 {
        self.blocks.last().map(|b| b.header.hash()).unwrap_or([0u8; 32])
    }

    /// Total accumulated proof-of-work — the fork-choice metric. From
    /// `cross_algo_activation_height` each block's contribution is
    /// ENERGY-WEIGHTED (`block_work × lane energy coefficient`), so the heaviest
    /// chain is the one backed by the most real power draw, not the most raw
    /// hashes. Pre-fork blocks keep counting at their raw work so history is
    /// unchanged.
    /// O(1): the last entry of `work_prefix`. Was an O(height) fold — see the
    /// `work_prefix` field comment for why that mattered.
    pub fn total_work(&self) -> U256 {
        *self.work_prefix.last().expect("work_prefix is never empty")
    }

    /// Accumulated work of `blocks[..n]` — the work a fork rooted at height `n`
    /// would RETAIN. O(1), and in the same energy-weighted units as
    /// [`Chain::total_work`], which is the whole point: scoring the retained
    /// prefix in raw `block_work` while comparing against a weighted total is
    /// exactly the bug that stalled every fresh install at a fixed height.
    ///
    /// `n` is clamped to the chain length.
    pub fn work_upto(&self, n: usize) -> U256 {
        self.work_prefix[n.min(self.blocks.len())]
    }

    /// One block's contribution to the fork-choice metric at `height`.
    /// Energy-weighted at/above `cross_algo_activation_height`, raw below it,
    /// so history is unchanged. Single source of truth for `work_prefix`.
    fn block_fork_work(&self, height: u64, lane: &'static str, bits: u32) -> U256 {
        if height >= self.params.cross_algo_activation_height {
            energy_work(bits, energy_coeff(lane), ENERGY_COEFF_SCALE)
        } else {
            block_work(bits)
        }
    }

    /// UPPER BOUND on the fork-choice work a block could contribute at
    /// `height`, given only its header.
    ///
    /// WHY A BOUND AND NOT THE VALUE. The fork-choice metric is energy-weighted
    /// above `cross_algo_activation_height`, and the weight comes from the
    /// block's LANE — which `lane_of` reads from `block.aux_pow.parent_algo`,
    /// i.e. from the block BODY. A `BlockHeader` does not carry its lane, and a
    /// merged-mined header is indistinguishable from any other merged header
    /// (empty solution, zero nonce). So a peer's announced headers CANNOT be
    /// scored exactly — the coefficients span sha256d 5_420 to native
    /// 1_021_700_000_000_000, a factor of 1.9e11, so guessing is not an option
    /// either.
    ///
    /// THE WRONG CONCLUSION, AND THE BUG IT CAUSED: that the header pre-gate
    /// can just sum `block_work` and compare against `total_work()`. Those are
    /// different units above the activation height. Measured on real mainnet
    /// blocks, our own weighted total overtook the raw sum by 9.8e16 around
    /// height 57,000 — more than the ~4.9e16 of raw work a full 2000-block
    /// batch adds — so from then on EVERY announced batch scored as lighter and
    /// the gate took a silent `return`. No log, no `GetBlocks`, no error: a
    /// fresh wallet synced to a fixed height and reported "stuck updating"
    /// forever, surviving a reinstall, because the data is immutable. Nodes
    /// stalled at 57999, 57370 and 56999 depending only on where their
    /// 2000-block batch boundary happened to land.
    ///
    /// So this returns the most generous value any lane could justify. It is
    /// ONE-SIDED BY DESIGN: it may overestimate (we fetch blocks we end up
    /// rejecting, which is cheap), and it may never underestimate (which would
    /// be the stall). The authoritative comparison stays in the adoption gate,
    /// where full blocks are in hand and `total_work()` is exact.
    pub fn header_work_upper_bound(&self, height: u64, bits: u32) -> U256 {
        if height >= self.params.cross_algo_activation_height {
            energy_work(bits, max_energy_coeff(), ENERGY_COEFF_SCALE)
        } else {
            block_work(bits)
        }
    }

    /// Recompute the fork-choice total by folding over every block — the
    /// pre-`work_prefix` implementation, retained as the differential oracle
    /// for `work_prefix` (asserted per connect in debug builds, and
    /// height-by-height in `tests/reorg_equivalence.rs`).
    pub fn recompute_total_work(&self) -> U256 {
        let act = self.params.cross_algo_activation_height;
        self.blocks.iter().enumerate().fold(U256::zero(), |acc, (h, b)| {
            let w = if (h as u64) >= act {
                energy_work(b.header.bits, energy_coeff(Self::lane_of(b)), ENERGY_COEFF_SCALE)
            } else {
                block_work(b.header.bits)
            };
            acc.saturating_add(w)
        })
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
    /// BOUNDED, AND NOT BY TAKING THE LAST N BLOCKS. `lwma_next_bits` reads only
    /// `lwma_window + 1` (= 18 on mainnet) entries and returns `pow_limit` when
    /// given fewer, so handing it the lane's last 18 blocks is the same input —
    /// but those 18 are not in any fixed window of `blocks`: an idle lane's
    /// 18th-most-recent block can be thousands of blocks back. Hence
    /// `lane_pos`. The old code filtered the entire chain here on every single
    /// `connect_block`.
    pub fn next_bits_for(&self, lane: &str) -> u32 {
        let spacing = self.params.target_spacing * self.lanes().len() as u64;
        let want = self.params.lwma_window + 1;
        let headers: Vec<(u32, i64)> = match self.lane_pos.get(lane) {
            Some(pos) => pos[pos.len().saturating_sub(want)..]
                .iter()
                .map(|h| {
                    let b = &self.blocks[*h as usize];
                    (b.header.bits, b.header.time as i64)
                })
                .collect(),
            None => Vec::new(),
        };
        lwma_next_bits(spacing, self.params.lwma_window, self.params.pow_limit, &headers)
    }

    /// The pre-`lane_pos` whole-chain filter, kept as the differential oracle
    /// for [`Chain::next_bits_for`]. Consensus-critical equality: a single
    /// disagreement is a chain split, so this is checked height-by-height and
    /// lane-by-lane over real mainnet blocks in `tests/reorg_equivalence.rs`.
    pub fn next_bits_for_fullscan(&self, lane: &str) -> u32 {
        let spacing = self.params.target_spacing * self.lanes().len() as u64;
        let headers: Vec<(u32, i64)> = self
            .blocks
            .iter()
            .filter(|b| Self::lane_of(b) == lane)
            .map(|b| (b.header.bits, b.header.time as i64))
            .collect();
        lwma_next_bits(spacing, self.params.lwma_window, self.params.pow_limit, &headers)
    }

    /// Cross-algorithm **coupled** difficulty for `lane` (active at/above
    /// `cross_algo_activation_height`). All lanes share one base difficulty,
    /// retargeted over the most recent blocks across EVERY lane at the whole-
    /// chain spacing and weighted by each block's benchmark energy coefficient;
    /// the base is then re-scaled to this lane's coefficient. An efficient lane
    /// must out-hash an inefficient one by exactly their energy-per-hash ratio,
    /// so real power draw per block is equalised across lanes. See
    /// `docs/CROSS-ALGO-COUPLING.md`.
    pub fn next_bits_coupled(&self, lane: &str) -> u32 {
        self.coupled_bits_for_coeff(energy_coeff(lane))
    }

    /// Shared body of the coupled retarget, bounded to the `lwma_window + 1`
    /// most recent blocks ACROSS ALL LANES (unlike the per-lane retarget, a
    /// fixed tail of `blocks` IS the right window here, because every block
    /// counts). `lwma_coupled_next_bits` slices the last `window + 1` entries
    /// itself and returns `pow_limit` when given fewer, so a shorter tail is
    /// the same input in both branches — bit-identical by construction.
    ///
    /// This used to build a `Vec` over EVERY block to read 18 of them: ~4,600×
    /// waste at height 82,000, measured at 1.2 ms of the 1.4 ms cost of a
    /// single `connect_block`. That one line is most of why `from_blocks` was
    /// ~O(n^1.6) and a node restart cost 17 minutes.
    fn coupled_bits_for_coeff(&self, lane_coeff: u64) -> u32 {
        let want = self.params.lwma_window + 1;
        let tail = &self.blocks[self.blocks.len().saturating_sub(want)..];
        let headers: Vec<(u32, i64, u64)> = tail
            .iter()
            .map(|b| (b.header.bits, b.header.time as i64, energy_coeff(Self::lane_of(b))))
            .collect();
        lwma_coupled_next_bits(
            self.params.target_spacing,
            self.params.lwma_window,
            self.params.pow_limit,
            ENERGY_COEFF_SCALE,
            &headers,
            lane_coeff,
        )
    }

    /// Whole-chain version of [`Chain::next_bits_coupled`], retained as its
    /// differential oracle. See `next_bits_for_fullscan`.
    pub fn next_bits_coupled_fullscan(&self, lane: &str) -> u32 {
        let headers: Vec<(u32, i64, u64)> = self
            .blocks
            .iter()
            .map(|b| (b.header.bits, b.header.time as i64, energy_coeff(Self::lane_of(b))))
            .collect();
        lwma_coupled_next_bits(
            self.params.target_spacing,
            self.params.lwma_window,
            self.params.pow_limit,
            ENERGY_COEFF_SCALE,
            &headers,
            energy_coeff(lane),
        )
    }

    /// The shared **global difficulty coefficient** of the energy-coupled
    /// retarget: the coupled target for a hypothetical median lane (energy
    /// coefficient = 1.0). Every lane's own target is this base scaled by its
    /// energy coefficient, so this single number is the chain's unified
    /// energy-difficulty. Exposed by the explorer alongside each lane's own
    /// computed difficulty (informational before activation, authoritative
    /// after). See `docs/CROSS-ALGO-COUPLING.md`.
    pub fn coupled_base_bits(&self) -> u32 {
        self.coupled_bits_for_coeff(ENERGY_COEFF_SCALE)
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

    /// Timestamp of the most recent block mined on `lane`, if any. O(1) via
    /// `lane_pos` instead of a reverse walk that, for a lane that has gone
    /// quiet, scanned back thousands of blocks — on every `connect_block`.
    fn lane_last_time(&self, lane: &str) -> Option<i64> {
        let t = self
            .lane_pos
            .get(lane)
            .and_then(|pos| pos.last())
            .map(|h| self.blocks[*h as usize].header.time as i64);
        // The index is consensus-affecting (it feeds the quiet-lane decay,
        // which feeds `expected_bits`), so debug builds verify it against the
        // no-index reverse walk it replaced.
        //
        // CAPPED AT 4096 BLOCKS ON PURPOSE: the oracle is O(height), so running
        // it unconditionally would reintroduce the very O(n²) shape this change
        // removes — and would make the height-independence assertion in
        // `tests/reorg_equivalence.rs` measure the assertion instead of the
        // code. Every ordinary test chain is far shorter than the cap, so the
        // check is live where it can run cheaply; the long chains are covered
        // by that test's explicit height-by-height differential instead.
        debug_assert!(
            self.blocks.len() > 4096 || t == self.lane_last_time_fullscan(lane),
            "lane_pos disagrees with a full reverse walk for lane {lane}"
        );
        t
    }

    /// Reverse-walk version of [`Chain::lane_last_time`] — needs no index, so it
    /// can validate the index. Kept as the oracle, used by `debug_assert`.
    fn lane_last_time_fullscan(&self, lane: &str) -> Option<i64> {
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
        let height = self.blocks.len() as u64;
        // At/above the activation height, lanes are energy-coupled; below it they
        // retarget independently (unchanged history).
        let base = if height >= self.params.cross_algo_activation_height {
            self.next_bits_coupled(lane)
        } else {
            self.next_bits_for(lane)
        };
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

    /// [`Chain::next_bits_for_at`] computed entirely from whole-chain scans —
    /// the differential oracle for the ENFORCED difficulty function.
    ///
    /// Worth having separately from the oracles for its two parts, because
    /// `next_bits_for_at` depends on TWO bounded indexes at once: the LWMA base
    /// (via `lane_pos`) and the decay's "when did this lane last appear"
    /// (via `lane_pos` again, through `lane_last_time`). Checking each part in
    /// isolation would miss a disagreement in how they compose, and this is the
    /// function `connect_block` enforces as `header.bits != expected_bits` — so
    /// a difference here is a chain split, not a slow path.
    ///
    /// Test-only in practice: it is O(height) by construction.
    pub fn next_bits_for_at_via_fullscan(&self, lane: &str, now_ts: i64) -> u32 {
        let height = self.blocks.len() as u64;
        let base = if height >= self.params.cross_algo_activation_height {
            self.next_bits_coupled_fullscan(lane)
        } else {
            self.next_bits_for_fullscan(lane)
        };
        if height < self.params.decay_activation_height {
            return base;
        }
        match self.lane_last_time_fullscan(lane) {
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

    /// Can this entry be spent at the next height? Public because the mempool
    /// view (see `crate::mempool`) has to make the same maturity judgement
    /// the funding path does, and two copies of a coinbase-maturity rule is
    /// one copy too many.
    pub fn is_spendable_now(&self, entry: &UtxoEntry) -> bool {
        self.is_mature(entry, self.blocks.len() as u64)
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
            Some(ContractAction::LaunchToken { code, gas_limit, .. })
            | Some(ContractAction::LaunchNft { code, gas_limit, .. }) => {
                if code.is_empty() || code.len() > self.params.max_contract_code {
                    return Err(ChainError::ContractRules("bad code size".into()));
                }
                if *gas_limit > self.params.block_gas_limit {
                    return Err(ChainError::ContractRules("gas limit too high".into()));
                }
            }
            // Blockle Intelligence actions — HEIGHT-GATED (backwards compatible): rejected
            // below the activation height so pre-fork blocks validate unchanged.
            Some(ContractAction::Intel(a)) => {
                if height < self.params.intel_activation_height {
                    return Err(ChainError::ContractRules(
                        "intelligence actions are not active until the activation height".into(),
                    ));
                }
                // Unbonding activates at its own, later height (backwards compatible —
                // pre-unbond-height blocks reject the new action unchanged).
                if matches!(a, blockle_core::transaction::IntelAction::NeuronDeregister { .. })
                    && height < self.params.intel_unbond_height
                {
                    return Err(ChainError::ContractRules(
                        "neuron deregistration is not active until the unbond height".into(),
                    ));
                }
                if a.gas_limit() > self.params.block_gas_limit {
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
        intel: &mut crate::intel::IntelState,
        unbond_cooldown: u64,
    ) -> Vec<([u8; 32], Vec<u8>)> {
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
        let (mut payouts, logs) = match &tx.contract {
            // Atomic deploy + mint + pool — one tx, one block, no race.
            Some(ContractAction::LaunchToken { code, block_amt, token_amt, gas_limit }) => {
                Self::apply_launch_token(
                    tx, txid, height, code, *block_amt, *token_amt, *gas_limit, contracts, storage,
                    pools,
                )
            }
            // Atomic NFT collection launch — deploy + init (set minter), one block.
            Some(ContractAction::LaunchNft { code, gas_limit }) => {
                let cid = contracts::contract_id(txid);
                contracts.insert(cid, contracts::ContractInfo { code: code.to_vec(), balance: 0 });
                let caller = blockle_core::keys::pubkey_to_address(&tx.inputs[0].pubkey);
                let init = contracts::execute_call(&cid, &[0u8], 0, *gas_limit, caller, height, contracts, storage);
                let logs: Vec<([u8; 32], Vec<u8>)> = if init.success {
                    init.logs.into_iter().map(|l| (cid, l)).collect()
                } else {
                    Vec::new()
                };
                (Vec::new(), logs)
            }
            // Blockle Intelligence native action (height-gated in check_transaction).
            Some(ContractAction::Intel(a)) => {
                (crate::intel::apply_intel_action(intel, a, tx, height, unbond_cooldown), Vec::new())
            }
            _ => {
                let effects = contracts::apply_contract_action(tx, txid, height, contracts, storage);
                let mut p = effects.payouts;
                if let Some(action) = &tx.contract {
                    if matches!(
                        action,
                        ContractAction::PoolCreate { .. }
                            | ContractAction::PoolAdd { .. }
                            | ContractAction::PoolRemove { .. }
                            | ContractAction::PoolSwapBuy { .. }
                            | ContractAction::PoolSwapSell { .. }
                    ) {
                        p.extend(crate::pools::apply_pool_action(action, tx, height, pools, storage));
                    }
                }
                (p, effects.logs)
            }
        };
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
        logs
    }

    /// Apply `ContractAction::LaunchToken`: deploy the code, run its `init()`
    /// (selector 0 — mints the baked supply to the sender), then seed the AMM
    /// pool with `block_amt` BLOCK + `token_amt` of that fresh supply. All three
    /// happen here, in order, against the same in-block state, so the pool can
    /// never fire before the mint. If deploy/init fails or the pool can't be
    /// created, `block_amt` is refunded. Returns (BLOCK payouts, event logs).
    #[allow(clippy::too_many_arguments)]
    fn apply_launch_token(
        tx: &Transaction,
        txid: &Hash32,
        height: u64,
        code: &[u8],
        block_amt: u64,
        token_amt: u64,
        gas_limit: u64,
        contracts: &mut ContractMap,
        storage: &mut StorageMap,
        pools: &mut crate::pools::PoolState,
    ) -> (Vec<([u8; 32], u64)>, Vec<([u8; 32], Vec<u8>)>) {
        let cid = contracts::contract_id(txid);
        contracts.insert(cid, contracts::ContractInfo { code: code.to_vec(), balance: 0 });
        let caller = blockle_core::keys::pubkey_to_address(&tx.inputs[0].pubkey);
        // init() — selector 0 — mints the baked supply to the caller.
        let init = contracts::execute_call(&cid, &[0u8], 0, gas_limit, caller, height, contracts, storage);
        let logs: Vec<([u8; 32], Vec<u8>)> = if init.success {
            init.logs.into_iter().map(|l| (cid, l)).collect()
        } else {
            Vec::new()
        };
        if !init.success {
            // deploy stands, but no supply was minted — refund the seed BLOCK.
            return (vec![(caller, block_amt)], logs);
        }
        let payouts = crate::pools::launch_pool(cid, caller, block_amt, token_amt, height, pools, storage);
        (payouts, logs)
    }

    /// Validate `block` as the next block and connect it.
    pub fn connect_block(&mut self, block: Block) -> Result<(), ChainError> {
        self.connect_block_arc(Arc::new(block))
    }

    /// [`Chain::connect_block`] over an already-shared block. Identical checks in
    /// identical order — this is the single state transition of `Chain`, and
    /// both `from_blocks` and the bounded reorg replay are nothing but loops
    /// over it, which is what makes them the same function of the same inputs.
    pub fn connect_block_arc(&mut self, block: Arc<Block>) -> Result<(), ChainError> {
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
        if block.serialized_size() > self.params.max_block_size_at(height) {
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
        let mut iview = self.intel.clone();
        let mut fees: u64 = 0;
        let mut gas_total: u64 = 0;
        let mut block_logs: Vec<([u8; 32], Vec<u8>)> = Vec::new();
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
            let logs = Self::apply_tx_effects(
                tx, &txid, height, &mut view, &mut cview, &mut sview, &mut pview, &mut nview,
                &mut lview, &mut iview, self.params.intel_epoch_len,
            );
            block_logs.extend(logs);
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
        // Intelligence α-split (spec §3.4): once active (and not genesis), redirect
        // `intel_alpha_bps` of the subsidy away from the coinbase into the emission pool.
        // Supply schedule unchanged — the withheld α is paid out later via NeuronClaim.
        let subsidy = self.params.block_subsidy(height);
        let intel_on = height >= self.params.intel_activation_height && height > 0;
        let intel_share = if intel_on {
            (subsidy as u128 * self.params.intel_alpha_bps as u128 / 10_000) as u64
        } else {
            0
        };
        let miner_subsidy = subsidy - intel_share;
        let allowed = miner_subsidy.checked_add(fees).ok_or(ChainError::ValueOutOfRange)?;
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

        // Accrue the withheld α; on an epoch boundary, run EmissionEpoch (deterministic).
        if intel_on {
            iview.pool = iview.pool.saturating_add(intel_share);
            if height % self.params.intel_epoch_len == 0 {
                let seed = crate::intel::epoch_beacon(&self.tip_hash());
                crate::intel::run_emission_epoch(&mut iview, seed, height);
            }
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
        self.intel = iview;
        self.index_nft_logs(&block_logs);
        // Derived indexes, maintained in the same commit so they can never
        // describe a block that failed validation. Order matters only in that
        // all three must agree on `height`.
        let fork_work = self.block_fork_work(height, lane, block.header.bits);
        let prev_work = *self.work_prefix.last().expect("work_prefix is never empty");
        self.blocks.push(block);
        self.work_prefix.push(prev_work.saturating_add(fork_work));
        self.lane_pos.entry(lane).or_default().push(height as u32);
        debug_assert_eq!(self.work_prefix.len(), self.blocks.len() + 1);
        debug_assert!(
            self.blocks.len() > 4096 || self.total_work() == self.recompute_total_work(),
            "work_prefix disagrees with a full fold over the chain"
        );
        Ok(())
    }

    /// Fold BLOCK-721 Transfer events into the ownership index. Each Transfer
    /// log is `[tag=1 ‖ from(32) ‖ to(32) ‖ id(32)]` (97 bytes); any other log
    /// shape is ignored. A mint has `from = 0`; we key purely on (contract, id)
    /// and set the new owner, which handles mints and transfers uniformly.
    fn index_nft_logs(&mut self, logs: &[([u8; 32], Vec<u8>)]) {
        for (contract, log) in logs {
            if log.len() != 97 || log[0] != 1 {
                continue;
            }
            let mut to = [0u8; 32];
            let mut id = [0u8; 32];
            to.copy_from_slice(&log[33..65]);
            id.copy_from_slice(&log[65..97]);
            self.nft_owner.insert((*contract, id), to);
        }
    }

    /// All BLOCK-721 tokens currently owned by `address`, as (contract, token
    /// id) pairs. Linear over the index — fine at prototype scale, matching the
    /// explorer's other on-demand scans.
    #[allow(clippy::type_complexity)]
    pub fn nfts_of(&self, address: &[u8; 32]) -> Vec<([u8; 32], [u8; 32])> {
        let mut out: Vec<([u8; 32], [u8; 32])> = self
            .nft_owner
            .iter()
            .filter(|(_, owner)| *owner == address)
            .map(|((contract, id), _)| (*contract, *id))
            .collect();
        out.sort_unstable();
        out
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

    /// A single hash committing to EVERY piece of this chain's state: the block
    /// sequence plus every mutable map, in a canonical (key-sorted) order so
    /// `HashMap` iteration order cannot affect it.
    ///
    /// WHY THIS EXISTS. `header.state_root` is forced to zero in this protocol
    /// version (`ChainError::BadStateRoot`), so there is NO protocol-level
    /// detection of two nodes' state diverging: a node can hold a wrong UTXO
    /// set forever and still accept and serve every block. That is tolerable
    /// while a reorg is a from-genesis rebuild, and it is NOT tolerable once
    /// reorgs replay forward from a retained snapshot — so this is the
    /// out-of-band check that makes the optimisation auditable. It is what the
    /// equivalence tests compare, what `--selfcheck-reorg` compares on every
    /// adoption, and what an operator should compare across the pool node, the
    /// exchange node and a freshly synced wallet before trusting a release.
    ///
    /// NON-CONSENSUS: nothing validates against it, and changing it breaks no
    /// block. Promoting it to a real `state_root` at a future fork height is
    /// the long-term answer; until then it is a diagnostic.
    pub fn state_fingerprint(&self) -> Hash32 {
        // EXHAUSTIVE DESTRUCTURING WITH NO `..` ON PURPOSE. Adding a field to
        // `Chain` is a COMPILE ERROR until it is accounted for here. Without
        // that, a new piece of state would silently fall outside the
        // fingerprint and quietly disarm every differential test and the
        // adoption self-check at the same time — the failure would be a wrong
        // balance months later, not a red test.
        let Chain {
            params,
            blocks,
            utxos,
            contracts,
            contract_storage,
            pools,
            note_leaves,
            note_anchors,
            nullifiers,
            nft_owner,
            intel,
            work_prefix,
            lane_pos,
        } = self;

        let mut acc: Vec<u8> = Vec::new();
        let mut rec = |tag: &str, body: &[u8]| {
            let mut buf = Vec::with_capacity(tag.len() + 1 + body.len());
            buf.extend_from_slice(tag.as_bytes());
            buf.push(0);
            buf.extend_from_slice(body);
            // Hash each record so the accumulator stays O(records × 32 B)
            // rather than materialising every contract's code at once.
            acc.extend_from_slice(&blockle_core::hash::blake2b_256(&buf));
        };

        // Identity + block sequence. Committing to every header hash (not just
        // the tip) makes this a commitment to the chain itself, so a test
        // comparing fingerprints is comparing the assembled block list too.
        rec("net", params.name.as_bytes());
        rec("height", &(blocks.len() as u64).to_le_bytes());
        for b in blocks {
            rec("block", &b.header.hash());
        }

        // Derived indexes are included so a divergence in them is visible,
        // not just a divergence in the state they accelerate.
        rec("work", &{
            let mut w = [0u8; 32];
            work_prefix.last().copied().unwrap_or_else(U256::zero).to_big_endian(&mut w);
            w
        });
        let mut lanes: Vec<(&&str, &Vec<u32>)> = lane_pos.iter().collect();
        lanes.sort_unstable_by_key(|(l, _)| **l);
        for (lane, pos) in lanes {
            rec("lane", format!("{lane}:{}:{:?}", pos.len(), pos.last()).as_bytes());
        }

        // UTXO set.
        let mut u: Vec<(&OutPoint, &UtxoEntry)> = utxos.iter().collect();
        u.sort_unstable_by_key(|(o, _)| (o.txid, o.vout));
        for (o, e) in u {
            rec("utxo", format!("{}:{}:{:?}", hex::encode(o.txid), o.vout, e).as_bytes());
        }

        // Contracts + their storage.
        let mut c: Vec<_> = contracts.iter().collect();
        c.sort_unstable_by_key(|(id, _)| **id);
        for (id, info) in c {
            rec("contract", format!("{}:{:?}", hex::encode(id), info).as_bytes());
        }
        let mut s: Vec<_> = contract_storage.iter().collect();
        s.sort_unstable_by_key(|(k, _)| **k);
        for ((id, slot), val) in s {
            rec(
                "storage",
                format!("{}:{}:{}", hex::encode(id), hex::encode(slot), hex::encode(val)).as_bytes(),
            );
        }

        // Native AMM.
        let crate::pools::PoolState { pools: pmap, lp } = pools;
        let mut p: Vec<_> = pmap.iter().collect();
        p.sort_unstable_by_key(|(id, _)| **id);
        for (id, pool) in p {
            rec("pool", format!("{}:{:?}", hex::encode(id), pool).as_bytes());
        }
        let mut l: Vec<_> = lp.iter().collect();
        l.sort_unstable_by_key(|(k, _)| **k);
        for ((pool, who), pos) in l {
            rec(
                "lp",
                format!("{}:{}:{:?}", hex::encode(pool), hex::encode(who), pos).as_bytes(),
            );
        }

        // Shielded pool. `note_leaves` is ordered (insertion order is
        // consensus); the two sets are not, so they are sorted.
        for leaf in note_leaves {
            rec("leaf", leaf);
        }
        let mut a: Vec<&Hash32> = note_anchors.iter().collect();
        a.sort_unstable();
        for anchor in a {
            rec("anchor", anchor);
        }
        let mut n: Vec<&Hash32> = nullifiers.iter().collect();
        n.sort_unstable();
        for nf in n {
            rec("nullifier", nf);
        }

        // Derived NFT ownership index.
        let mut o: Vec<_> = nft_owner.iter().collect();
        o.sort_unstable_by_key(|(k, _)| **k);
        for ((contract, id), owner) in o {
            rec(
                "nft",
                format!(
                    "{}:{}:{}",
                    hex::encode(contract),
                    hex::encode(id),
                    hex::encode(owner)
                )
                .as_bytes(),
            );
        }

        // Blockle Intelligence. Destructured exhaustively for the same reason
        // `Chain` is.
        let crate::intel::IntelState {
            subnets,
            neurons,
            pool,
            emission_ledger,
            commits,
            revealed,
            bonds,
            last_epoch_seed,
            pov,
        } = intel;
        for sn in subnets {
            rec("subnet", format!("{sn:?}").as_bytes());
        }
        for ne in neurons {
            rec("neuron", format!("{ne:?}").as_bytes());
        }
        rec("intelpool", &pool.to_le_bytes());
        rec("epochseed", last_epoch_seed);
        let mut el: Vec<_> = emission_ledger.iter().collect();
        el.sort_unstable_by_key(|(k, _)| **k);
        for (who, amt) in el {
            rec("emission", format!("{}:{amt}", hex::encode(who)).as_bytes());
        }
        let mut cm: Vec<_> = commits.iter().collect();
        cm.sort_unstable_by_key(|(k, _)| **k);
        for (k, v) in cm {
            rec("commit", format!("{k:?}:{}", hex::encode(v)).as_bytes());
        }
        let mut rv: Vec<_> = revealed.iter().collect();
        rv.sort_unstable_by_key(|(k, _)| **k);
        for (k, v) in rv {
            rec("reveal", format!("{k:?}:{v:?}").as_bytes());
        }
        let mut bd: Vec<_> = bonds.iter().collect();
        bd.sort_unstable_by_key(|(k, _)| **k);
        for (k, v) in bd {
            rec("bond", format!("{k:?}:{v:?}").as_bytes());
        }
        let mut pv: Vec<_> = pov.iter().collect();
        pv.sort_unstable();
        for k in pv {
            rec("pov", format!("{k:?}").as_bytes());
        }

        blockle_core::hash::blake2b_256(&acc)
    }
}

#[cfg(test)]
mod nft_index_tests {
    use super::*;

    // Build a BLOCK-721 Transfer log: [tag=1 ‖ from(32) ‖ to(32) ‖ id(32)].
    fn transfer_log(from: [u8; 32], to: [u8; 32], id: [u8; 32]) -> Vec<u8> {
        let mut v = Vec::with_capacity(97);
        v.push(1);
        v.extend_from_slice(&from);
        v.extend_from_slice(&to);
        v.extend_from_slice(&id);
        v
    }

    #[test]
    fn index_tracks_mints_and_transfers() {
        let mut chain = Chain::new(ChainParams::testnet());
        let nft = [0x21u8; 32];
        let zero = [0u8; 32];
        let bob = [0xBBu8; 32];
        let carol = [0xCCu8; 32];
        let id1 = [0x01u8; 32];
        let id2 = [0x02u8; 32];

        // mint id1 -> bob, mint id2 -> carol
        chain.index_nft_logs(&[
            (nft, transfer_log(zero, bob, id1)),
            (nft, transfer_log(zero, carol, id2)),
        ]);
        assert_eq!(chain.nfts_of(&bob), vec![(nft, id1)]);
        assert_eq!(chain.nfts_of(&carol), vec![(nft, id2)]);

        // bob transfers id1 -> carol; carol now holds both, bob none
        chain.index_nft_logs(&[(nft, transfer_log(bob, carol, id1))]);
        assert!(chain.nfts_of(&bob).is_empty());
        assert_eq!(chain.nfts_of(&carol), vec![(nft, id1), (nft, id2)]);

        // a non-Transfer log (wrong len / wrong tag) is ignored
        chain.index_nft_logs(&[(nft, vec![1, 2, 3]), (nft, transfer_log(carol, bob, id2))]);
        assert_eq!(chain.nfts_of(&bob), vec![(nft, id2)]);
    }
}
