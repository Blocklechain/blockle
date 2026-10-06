//! Chain parameters.

use blockle_core::amount::COIN;
use blockle_pow::equihash;
use blockle_pow::U256;

#[derive(Clone, Debug)]
pub struct ChainParams {
    pub name: String,
    pub ticker: String,
    pub equihash: equihash::Params,
    /// Target seconds between blocks (combined across all mining lanes).
    pub target_spacing: u64,
    /// Accept merged-mining (AuxPoW) blocks from parent chains.
    pub aux_pow: bool,
    /// This chain's id in merged-mining commitment trees.
    pub aux_chain_id: u32,
    /// LWMA difficulty window (blocks).
    pub lwma_window: usize,
    /// Height from which the quiet-lane difficulty decay is enforced. Blocks
    /// below this validate with pure LWMA (preserving pre-fork history); at
    /// and above it, a lane's required difficulty decays once it goes silent
    /// past the grace window, so the chain cannot stall when hashrate leaves.
    pub decay_activation_height: u64,
    /// Easiest allowed target.
    pub pow_limit: U256,
    /// Subsidy for block 1 (base units). Halves every `halving_interval`.
    pub initial_subsidy: u64,
    pub halving_interval: u64,
    /// One-time allocation paid by the genesis coinbase (base units).
    pub premine: u64,
    /// Blocks before a mined coinbase is spendable. The genesis premine is
    /// exempt — it is an allocation, not a mining reward.
    pub coinbase_maturity: u64,
    pub max_block_size: usize,
    /// Max seconds a block timestamp may lead local time.
    pub max_future_drift: i64,
    pub coinbase_tag: Vec<u8>,
    /// Base units of BLOCK per unit of VM gas (prepaid via the fee).
    pub gas_price: u64,
    /// Sum of transaction gas limits allowed per block.
    pub block_gas_limit: u64,
    pub max_contract_code: usize,
    pub max_contract_input: usize,
}

impl ChainParams {
    /// Mainnet: 10-minute blocks, Bitcoin's emission schedule (50 BLOCK
    /// halving every 210,000 blocks → ~21M mined), a 210,000 BLOCK genesis
    /// premine, and **Equihash (200, 9) with the Zcash wire construction** so
    /// existing Equihash ASICs can mine it from day 1.
    ///
    /// `pow_limit` starts generous so the chain can bootstrap on CPU; LWMA
    /// retargets every block, so real hashrate tightens difficulty within one
    /// window.
    pub fn mainnet() -> Self {
        ChainParams {
            name: "blockle-main".into(),
            ticker: "BLOCK".into(),
            equihash: equihash::Params::new(200, 9).expect("valid params"),
            target_spacing: 600,
            aux_pow: true,
            aux_chain_id: 16972,
            lwma_window: 17,
            // Live-chain fork point: enforced from the first block after the
            // current tip so blocks 0..=297 keep validating under pure LWMA.
            decay_activation_height: 298,
            pow_limit: U256::MAX >> 1,
            initial_subsidy: 50 * COIN,
            halving_interval: 210_000,
            premine: 210_000 * COIN,
            coinbase_maturity: 100,
            max_block_size: 2_000_000,
            max_future_drift: 2 * 60 * 60,
            coinbase_tag: b"Blockle".to_vec(),
            gas_price: 10,
            block_gas_limit: 10_000_000,
            max_contract_code: 24_576,
            max_contract_input: 8_192,
        }
    }

    /// Small, fast parameters for tests and local development. The 1-second
    /// spacing keeps difficulty flat under continuous CPU mining (classic
    /// regtest behavior).
    pub fn regtest() -> Self {
        ChainParams {
            name: "blockle-regtest".into(),
            equihash: equihash::Params::new(48, 5).expect("valid params"),
            coinbase_maturity: 5,
            pow_limit: U256::MAX >> 4,
            target_spacing: 1,
            aux_pow: true,
            aux_chain_id: 16972,
            // Exercise the decay from genesis in tests/dev.
            decay_activation_height: 0,
            ..Self::mainnet()
        }
    }

    /// Public test network: identical ASIC-class parameters, separate chain
    /// identity and faster maturity so testing coins move sooner.
    pub fn testnet() -> Self {
        ChainParams {
            name: "blockle-test".into(),
            coinbase_maturity: 10,
            decay_activation_height: 0,
            ..Self::mainnet()
        }
    }

    /// Look up built-in parameters by network name.
    pub fn by_name(name: &str) -> Option<Self> {
        match name {
            "mainnet" | "main" | "blockle-main" => Some(Self::mainnet()),
            "testnet" | "test" | "blockle-test" => Some(Self::testnet()),
            "regtest" | "blockle-regtest" => Some(Self::regtest()),
            _ => None,
        }
    }

    /// Mining + premine subsidy schedule.
    pub fn block_subsidy(&self, height: u64) -> u64 {
        if height == 0 {
            return self.premine;
        }
        let halvings = height / self.halving_interval;
        if halvings >= 64 {
            0
        } else {
            self.initial_subsidy >> halvings
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitcoin_schedule_with_premine() {
        let p = ChainParams::mainnet();
        assert_eq!(p.block_subsidy(0), 210_000 * COIN);
        assert_eq!(p.block_subsidy(1), 50 * COIN);
        assert_eq!(p.block_subsidy(209_999), 50 * COIN);
        assert_eq!(p.block_subsidy(210_000), 25 * COIN);
        assert_eq!(p.block_subsidy(420_000), 1_250_000_000);
        assert_eq!(p.block_subsidy(64 * 210_000), 0);
    }

    #[test]
    fn mainnet_is_asic_shaped() {
        let p = ChainParams::mainnet();
        assert_eq!((p.equihash.n, p.equihash.k), (200, 9));
        assert_eq!(p.equihash.solution_bytes(), 1344);
    }

    #[test]
    fn network_lookup() {
        assert!(ChainParams::by_name("mainnet").is_some());
        assert!(ChainParams::by_name("regtest").is_some());
        assert!(ChainParams::by_name("nope").is_none());
    }
}
