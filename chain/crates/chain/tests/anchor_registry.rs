//! Blockle Protect anchor-registry conformance: first-anchor records the block
//! height, `anchored` reads it back, re-anchoring is idempotent (keeps the
//! earliest height), distinct roots are independent, and an un-anchored root
//! reads 0.

use blockle_chain::anchor_registry::anchor_registry_bytecode;
use blockle_chain::contracts::{self, ContractInfo, ContractMap, StorageMap};

const GAS: u64 = 10_000_000;

fn u64_of(d: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[..8]);
    u64::from_le_bytes(b)
}

#[test]
fn anchor_registry_conformance() {
    let code = anchor_registry_bytecode();
    let id = [0x5Bu8; 32];
    let anyone = [0xA1u8; 32];
    let other = [0xB0u8; 32];
    let root_a = [0x11u8; 32];
    let root_b = [0x22u8; 32];

    let mut c: ContractMap = ContractMap::new();
    let mut s: StorageMap = StorageMap::new();
    c.insert(id, ContractInfo { code, balance: 0 });

    // call(selector, root, sender, height)
    let call = |sel: u8, root: &[u8; 32], sender: [u8; 32], height: u64,
                c: &mut ContractMap, s: &mut StorageMap| {
        let mut input = vec![sel];
        input.extend_from_slice(root);
        contracts::execute_call(&id, &input, 0, GAS, sender, height, c, s)
    };

    // un-anchored root reads 0
    assert_eq!(u64_of(&call(1, &root_a, anyone, 100, &mut c, &mut s).return_data), 0,
        "unknown root -> 0");

    // anyone can anchor; records the block height
    let r = call(0, &root_a, anyone, 4242, &mut c, &mut s);
    assert!(r.success, "anchor succeeds");
    assert_eq!(u64_of(&r.return_data), 4242, "anchor returns the height it recorded");
    assert_eq!(u64_of(&call(1, &root_a, other, 9000, &mut c, &mut s).return_data), 4242,
        "anchored(root_a) == 4242 regardless of who/when reads");

    // re-anchoring is idempotent: keeps the ORIGINAL height (first-write-wins)
    let r2 = call(0, &root_a, other, 8888, &mut c, &mut s);
    assert!(r2.success, "re-anchor succeeds");
    assert_eq!(u64_of(&r2.return_data), 4242, "re-anchor keeps the earliest height");
    assert_eq!(u64_of(&call(1, &root_a, anyone, 1, &mut c, &mut s).return_data), 4242,
        "height unchanged after re-anchor");

    // a different root is independent and still un-anchored
    assert_eq!(u64_of(&call(1, &root_b, anyone, 1, &mut c, &mut s).return_data), 0,
        "distinct root still 0");
    let r3 = call(0, &root_b, anyone, 5555, &mut c, &mut s);
    assert!(r3.success && u64_of(&r3.return_data) == 5555, "anchor root_b at 5555");
    assert_eq!(u64_of(&call(1, &root_a, anyone, 1, &mut c, &mut s).return_data), 4242,
        "root_a untouched by root_b");

    // unknown selector reverts
    assert!(!call(9, &root_a, anyone, 1, &mut c, &mut s).success, "bad selector reverts");
}
