//! BLOCK-721 — Blockle's NFT standard, as a VM-assembly contract. Conformance
//! suite: deploy, init-once, minter-gated mint, ownerOf, owner-gated transfer,
//! balance accounting, and the revert cases (non-minter mint, duplicate id,
//! non-owner transfer).

use blockle_chain::block721::block721_bytecode;
use blockle_chain::contracts::{self, ContractInfo, ContractMap, StorageMap};

fn u64_of(d: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[..8]);
    u64::from_le_bytes(b)
}

const GAS: u64 = 10_000_000;

#[test]
fn block721_conformance() {
    let code = block721_bytecode("World Items", "WRLD-ITEM");
    let id = [0x21u8; 32];
    let alice = [0xAAu8; 32]; // deployer / minter
    let bob = [0xBBu8; 32];
    let carol = [0xCCu8; 32];
    let id1 = [0x01u8; 32];
    let id2 = [0x02u8; 32];

    let mut contracts: ContractMap = ContractMap::new();
    let mut storage: StorageMap = StorageMap::new();
    contracts.insert(id, ContractInfo { code, balance: 0 });

    let call = |sel: u8, args: &[u8], sender: [u8; 32], c: &mut ContractMap, s: &mut StorageMap| {
        let mut input = vec![sel];
        input.extend_from_slice(args);
        contracts::execute_call(&id, &input, 0, GAS, sender, 1, c, s)
    };
    let two = |a: &[u8; 32], b: &[u8; 32]| {
        let mut v = Vec::with_capacity(64);
        v.extend_from_slice(a);
        v.extend_from_slice(b);
        v
    };

    // metadata
    assert_eq!(
        String::from_utf8(call(5, &[], alice, &mut contracts, &mut storage).return_data).unwrap(),
        "World Items"
    );
    assert_eq!(
        String::from_utf8(call(6, &[], alice, &mut contracts, &mut storage).return_data).unwrap(),
        "WRLD-ITEM"
    );

    // supply starts at 0
    assert_eq!(u64_of(&call(3, &[], alice, &mut contracts, &mut storage).return_data), 0);

    // init once; re-init reverts
    assert!(call(0, &[], alice, &mut contracts, &mut storage).success, "init");
    assert!(!call(0, &[], alice, &mut contracts, &mut storage).success, "re-init reverts");

    // a non-minter cannot mint
    assert!(!call(8, &two(&id1, &bob), bob, &mut contracts, &mut storage).success, "non-minter mint reverts");

    // the minter (alice) mints id1 -> bob
    assert!(call(8, &two(&id1, &bob), alice, &mut contracts, &mut storage).success, "mint id1->bob");
    assert_eq!(call(7, &id1, alice, &mut contracts, &mut storage).return_data, bob.to_vec(), "ownerOf id1 == bob");
    assert_eq!(u64_of(&call(1, &bob, bob, &mut contracts, &mut storage).return_data), 1, "bob balance 1");
    assert_eq!(u64_of(&call(3, &[], alice, &mut contracts, &mut storage).return_data), 1, "supply 1");

    // minting the same id again reverts
    assert!(!call(8, &two(&id1, &carol), alice, &mut contracts, &mut storage).success, "duplicate id reverts");

    // a non-owner cannot transfer id1
    assert!(!call(2, &two(&id1, &carol), carol, &mut contracts, &mut storage).success, "non-owner transfer reverts");

    // the owner (bob) transfers id1 -> carol
    assert!(call(2, &two(&id1, &carol), bob, &mut contracts, &mut storage).success, "transfer id1 bob->carol");
    assert_eq!(call(7, &id1, alice, &mut contracts, &mut storage).return_data, carol.to_vec(), "ownerOf id1 == carol");
    assert_eq!(u64_of(&call(1, &bob, bob, &mut contracts, &mut storage).return_data), 0, "bob balance 0");
    assert_eq!(u64_of(&call(1, &carol, carol, &mut contracts, &mut storage).return_data), 1, "carol balance 1");

    // bob can no longer transfer what he sold
    assert!(!call(2, &two(&id1, &bob), bob, &mut contracts, &mut storage).success, "ex-owner transfer reverts");

    // a second mint bumps supply + balance independently
    assert!(call(8, &two(&id2, &alice), alice, &mut contracts, &mut storage).success, "mint id2->alice");
    assert_eq!(u64_of(&call(3, &[], alice, &mut contracts, &mut storage).return_data), 2, "supply 2");
    assert_eq!(u64_of(&call(1, &alice, alice, &mut contracts, &mut storage).return_data), 1, "alice balance 1");
}
