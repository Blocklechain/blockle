//! Embedded fixed genesis blocks. Every node agrees on block 0 by
//! construction: consensus rejects any mainnet/testnet chain whose first
//! block differs from the embedded one. Regtest mines its own genesis.
//!
//! The mainnet genesis is the real one: mined 2026-10-04, its 210,000 BLOCK
//! premine pays a cold wallet held by the project (keys are NOT in this
//! repository). The testnet genesis remains a dev fixture whose wallet lives
//! in `genesis-wallet-testnet.DO-NOT-USE-IN-PRODUCTION.json` at the repo
//! root.

use blockle_core::Block;

const MAINNET_GENESIS: &str = include_str!("../genesis/mainnet.json");
const TESTNET_GENESIS: &str = include_str!("../genesis/testnet.json");

/// The fixed genesis block for a network, if one is embedded.
pub fn embedded_genesis(network: &str) -> Option<Block> {
    let raw = match network {
        "blockle-main" => MAINNET_GENESIS,
        "blockle-test" => TESTNET_GENESIS,
        _ => return None,
    };
    serde_json::from_str::<Option<Block>>(raw.trim()).ok().flatten()
}
