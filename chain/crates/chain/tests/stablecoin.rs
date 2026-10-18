//! BLOCK-20S (USDB stablecoin) conformance: issuer-only mint/burn with a mutable
//! supply, freeze/blacklist blocking send+receive, global pause, and the
//! non-issuer / frozen / paused revert cases.

use blockle_chain::contracts::{self, ContractInfo, ContractMap, StorageMap};
use blockle_chain::stablecoin::stablecoin_bytecode;

const GAS: u64 = 10_000_000;

fn u64_of(d: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[..8]);
    u64::from_le_bytes(b)
}

#[test]
fn stablecoin_conformance() {
    let code = stablecoin_bytecode("Blockle USD", "USDB", 6);
    let id = [0x5Bu8; 32];
    let issuer = [0xAAu8; 32]; // deployer / issuer
    let alice = [0xA1u8; 32];
    let bob = [0xB0u8; 32];
    let evil = [0xE7u8; 32];

    let mut c: ContractMap = ContractMap::new();
    let mut s: StorageMap = StorageMap::new();
    c.insert(id, ContractInfo { code, balance: 0 });

    let call = |sel: u8, args: &[u8], sender: [u8; 32], c: &mut ContractMap, s: &mut StorageMap| {
        let mut input = vec![sel];
        input.extend_from_slice(args);
        contracts::execute_call(&id, &input, 0, GAS, sender, 1, c, s)
    };
    let two = |a: &[u8; 32], amt: u64| {
        let mut v = Vec::with_capacity(40);
        v.extend_from_slice(a);
        v.extend_from_slice(&amt.to_le_bytes());
        v
    };

    // metadata
    assert_eq!(String::from_utf8(call(5, &[], issuer, &mut c, &mut s).return_data).unwrap(), "Blockle USD");
    assert_eq!(String::from_utf8(call(6, &[], issuer, &mut c, &mut s).return_data).unwrap(), "USDB");
    assert_eq!(u64_of(&call(4, &[], issuer, &mut c, &mut s).return_data), 6, "decimals");

    // init once (issuer = deployer); re-init reverts
    assert!(call(0, &[], issuer, &mut c, &mut s).success, "init");
    assert!(!call(0, &[], issuer, &mut c, &mut s).success, "re-init reverts");
    assert_eq!(u64_of(&call(3, &[], issuer, &mut c, &mut s).return_data), 0, "supply starts 0");

    // a non-issuer cannot mint
    assert!(!call(7, &two(&alice, 1_000_000), alice, &mut c, &mut s).success, "non-issuer mint reverts");

    // issuer mints 100 USDB (100_000000 base) to alice -> supply + balance
    assert!(call(7, &two(&alice, 100_000000), issuer, &mut c, &mut s).success, "mint alice");
    assert_eq!(u64_of(&call(1, &alice, issuer, &mut c, &mut s).return_data), 100_000000, "alice balance");
    assert_eq!(u64_of(&call(3, &[], issuer, &mut c, &mut s).return_data), 100_000000, "supply 100");

    // alice transfers 40 to bob
    assert!(call(2, &two(&bob, 40_000000), alice, &mut c, &mut s).success, "transfer");
    assert_eq!(u64_of(&call(1, &alice, issuer, &mut c, &mut s).return_data), 60_000000, "alice 60");
    assert_eq!(u64_of(&call(1, &bob, issuer, &mut c, &mut s).return_data), 40_000000, "bob 40");

    // overspend reverts
    assert!(!call(2, &two(&bob, 999_000000), alice, &mut c, &mut s).success, "overspend reverts");

    // --- freeze/blacklist ---
    // non-issuer cannot freeze
    assert!(!call(9, &bob, alice, &mut c, &mut s).success, "non-issuer freeze reverts");
    // issuer freezes bob
    assert!(call(9, &bob, issuer, &mut c, &mut s).success, "freeze bob");
    assert_eq!(u64_of(&call(13, &bob, issuer, &mut c, &mut s).return_data), 1, "bob frozen");
    // bob (frozen) cannot send
    assert!(!call(2, &two(&alice, 1_000000), bob, &mut c, &mut s).success, "frozen sender blocked");
    // nobody can send TO bob (frozen) either
    assert!(!call(2, &two(&bob, 1_000000), alice, &mut c, &mut s).success, "frozen recipient blocked");
    // unfreeze -> transfers work again
    assert!(call(10, &bob, issuer, &mut c, &mut s).success, "unfreeze bob");
    assert!(call(2, &two(&alice, 1_000000), bob, &mut c, &mut s).success, "unfrozen can send");

    // --- pause ---
    assert!(!call(11, &[], alice, &mut c, &mut s).success, "non-issuer pause reverts");
    assert!(call(11, &[], issuer, &mut c, &mut s).success, "issuer pause");
    assert_eq!(u64_of(&call(14, &[], issuer, &mut c, &mut s).return_data), 1, "paused");
    assert!(!call(2, &two(&bob, 1_000000), alice, &mut c, &mut s).success, "paused blocks transfer");
    assert!(call(12, &[], issuer, &mut c, &mut s).success, "unpause");
    assert!(call(2, &two(&bob, 1_000000), alice, &mut c, &mut s).success, "unpaused transfer ok");

    // --- burn (redemption): issuer-only, supply drops ---
    assert!(!call(8, &two(&alice, 1_000000), evil, &mut c, &mut s).success, "non-issuer burn reverts");
    let sup_before = u64_of(&call(3, &[], issuer, &mut c, &mut s).return_data);
    let alice_before = u64_of(&call(1, &alice, issuer, &mut c, &mut s).return_data);
    assert!(call(8, &two(&alice, 10_000000), issuer, &mut c, &mut s).success, "burn alice 10");
    assert_eq!(u64_of(&call(1, &alice, issuer, &mut c, &mut s).return_data), alice_before - 10_000000, "alice -10");
    assert_eq!(u64_of(&call(3, &[], issuer, &mut c, &mut s).return_data), sup_before - 10_000000, "supply -10");
    // burning more than held reverts
    assert!(!call(8, &two(&alice, 999_000000), issuer, &mut c, &mut s).success, "over-burn reverts");
}
