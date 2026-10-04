//! Embedded fixed genesis blocks. Every node agrees on block 0 by
//! construction: consensus rejects any mainnet/testnet chain whose first
//! block differs from the embedded one. Regtest mines its own genesis.
//!
//! The genesis premine is paid to a dedicated genesis wallet whose keys live
//! in `genesis-wallet-<net>.DO-NOT-USE-IN-PRODUCTION.json` at the repo root —
//! a real launch regenerates both the wallet and these blocks.

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
