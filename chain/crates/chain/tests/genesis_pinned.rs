//! The fixed genesis blocks are consensus constants.

use blockle_chain::{genesis::embedded_genesis, Chain, ChainError, ChainParams};
use blockle_core::display_hash;

#[test]
fn mainnet_genesis_is_pinned_and_valid() {
    let g = embedded_genesis("blockle-main").expect("embedded mainnet genesis");
    assert_eq!(
        display_hash(&g.header.hash()),
        "069209f0e9e7cb0188975b2bfa0dfa1f7b0a76c0c3ac1da6e091afd263954b4e"
    );
    let mut chain = Chain::new(ChainParams::mainnet());
    chain.connect_block(g).expect("genesis validates");
    assert_eq!(chain.height(), Some(0));
}

#[test]
fn testnet_genesis_is_pinned_and_valid() {
    let g = embedded_genesis("blockle-test").expect("embedded testnet genesis");
    assert_eq!(
        display_hash(&g.header.hash()),
        "6ee0b2e7f36a98ac4a0bf937106cc2b7b9232bdb487c149db0a37de0762ef47a"
    );
    let mut chain = Chain::new(ChainParams::testnet());
    chain.connect_block(g).expect("genesis validates");
}

#[test]
fn rogue_genesis_rejected_on_fixed_networks() {
    // The testnet genesis is a perfectly valid block — but not mainnet's.
    let rogue = embedded_genesis("blockle-test").unwrap();
    let mut chain = Chain::new(ChainParams::mainnet());
    assert!(matches!(chain.connect_block(rogue), Err(ChainError::WrongGenesis)));
}

#[test]
fn regtest_still_mines_its_own_genesis() {
    assert!(embedded_genesis("blockle-regtest").is_none());
}
