//! BLOCK-20 — the Blockle fungible-token standard, as a VM-assembly contract.
//!
//! Blockle Script can't express an address→balance mapping (single-u64 slots
//! only), so BLOCK-20 is emitted as raw VM assembly: balances live at
//! `BLAKE2B(0x01 ‖ address)`, metadata (name/symbol/decimals/totalSupply) is
//! baked into the code as constants, and an init() mints the whole supply to
//! the deployer exactly once.
//!
//! Selectors (calldata[0]):
//!   0 init()                     — mint supply to caller, once
//!   1 balanceOf(addr:32) -> u64
//!   2 transfer(to:32, amount:u64 LE) -> 1
//!   3 totalSupply() -> u64
//!   4 decimals() -> u64
//!   5 name() -> bytes
//!   6 symbol() -> bytes
//!
//! This test is the standard's conformance suite: deploy, init, transfer,
//! over-spend revert, re-init revert, and metadata reads.

use blockle_chain::contracts::{self, ContractInfo, ContractMap, StorageMap};
use blockle_vm::asm;

/// Emit the BLOCK-20 assembly for a specific token, with metadata + supply
/// baked in as constants.
pub fn block20_asm(name: &str, symbol: &str, decimals: u64, supply: u64) -> String {
    // byte-write helper: store each byte of `s` at STRBUF+i, then RETURN it.
    fn return_bytes(label: &str, s: &str, strbuf: u64) -> String {
        let mut out = format!("{label}:\n");
        for (i, b) in s.bytes().enumerate() {
            out += &format!("  PUSH {}\n  PUSH8 {}\n  MSTORE8\n", strbuf + i as u64, b);
        }
        out += &format!("  PUSH {strbuf}\n  PUSH8 {}\n  RETURN\n", s.len());
        out
    }
    // return a baked u64 constant
    fn return_u64(label: &str, v: u64, scratch: u64) -> String {
        format!(
            "{label}:\n  PUSH {scratch}\n  PUSH {v}\n  MSTORE64\n  PUSH {scratch}\n  PUSH8 8\n  RETURN\n"
        )
    }

    // memory map
    let sel = 0x00; // selector byte
    let keya = 0x40; // computed storage key (32)
    let val = 0x80; // u64 scratch (8)
    let hbuf = 0xC0; // hash input: [slot ‖ addr] (33)
    let amt = 0x100; // amount (8)
    let nf = 0xA0; // newFrom
    let nt = 0xB0; // newTo
    let one = 0xA8; // return-1 scratch
    let flag = 0x90; // init flag scratch
    let fixed = 0x240; // fixed (zeroed) key region (32)
    let strbuf = 0x300; // name/symbol out

    let mut a = String::new();
    // ---- dispatcher ----
    a += &format!(
        "  PUSH {sel}\n  PUSH8 0\n  PUSH8 1\n  CALLDATACOPY\n  PUSH {sel}\n  MLOAD8\n"
    );
    for (s, label) in [
        (0u64, "fn_init"),
        (1, "fn_balanceOf"),
        (2, "fn_transfer"),
        (3, "fn_totalSupply"),
        (4, "fn_decimals"),
        (5, "fn_name"),
        (6, "fn_symbol"),
    ] {
        // selector is kept on the stack via DUP
        a += &format!("  DUP 0\n  PUSH8 {s}\n  EQ\n  PUSH @{label}\n  JUMPI\n");
    }
    a += "  PUSH @revert\n  JUMP\n";

    // ---- balances-key helper is inlined where needed ----
    // builds key at `keya` from address already at hbuf+1, slot=1
    let build_bal_key = format!(
        "  PUSH {hbuf}\n  PUSH8 1\n  MSTORE8\n  PUSH {hbuf}\n  PUSH8 33\n  PUSH {keya}\n  BLAKE2B\n"
    );

    // ---- fn_init ----
    a += "fn_init:\n";
    // guard: if flag slot(7) != 0 -> revert
    a += &format!("  PUSH {fixed}\n  PUSH8 7\n  MSTORE8\n");
    a += &format!("  PUSH {flag}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {fixed}\n  PUSH {flag}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {flag}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    // caller -> hbuf+1 ; build key ; balances[caller] = supply
    a += &format!("  PUSH {}\n  CALLER\n", hbuf + 1);
    a += &build_bal_key;
    a += &format!("  PUSH {val}\n  PUSH {supply}\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {val}\n  PUSH8 8\n  SSTORE\n");
    // set flag=1
    a += &format!("  PUSH {fixed}\n  PUSH8 7\n  MSTORE8\n");
    a += &format!("  PUSH {flag}\n  PUSH8 1\n  MSTORE64\n");
    a += &format!("  PUSH {fixed}\n  PUSH {flag}\n  PUSH8 8\n  SSTORE\n");
    // return 1
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_balanceOf ----
    a += "fn_balanceOf:\n";
    a += &format!("  PUSH {}\n  PUSH8 1\n  PUSH8 32\n  CALLDATACOPY\n", hbuf + 1);
    a += &build_bal_key;
    a += &format!("  PUSH {val}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {val}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_transfer ----
    a += "fn_transfer:\n";
    // amount <- calldata[33..41]
    a += &format!("  PUSH {amt}\n  PUSH8 33\n  PUSH8 8\n  CALLDATACOPY\n");
    // fromKey from caller
    a += &format!("  PUSH {}\n  CALLER\n", hbuf + 1);
    a += &build_bal_key;
    // fromBal -> val
    a += &format!("  PUSH {val}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {val}\n  SLOAD\n  POP\n");
    // require fromBal >= amount  (revert if fromBal < amount)
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  LT\n  PUSH @revert\n  JUMPI\n");
    // newFrom = fromBal - amount ; store
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n");
    a += &format!("  PUSH {nf}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nf}\n  PUSH8 8\n  SSTORE\n");
    // toKey from calldata `to`
    a += &format!("  PUSH {}\n  PUSH8 1\n  PUSH8 32\n  CALLDATACOPY\n", hbuf + 1);
    a += &build_bal_key;
    // toBal -> nt region, newTo = toBal + amount
    a += &format!("  PUSH {nt}\n  PUSH8 0\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nt}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {nt}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  ADD\n");
    a += &format!("  PUSH {nt}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nt}\n  PUSH8 8\n  SSTORE\n");
    // return 1
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- metadata getters ----
    a += &return_u64("fn_totalSupply", supply, val);
    a += &return_u64("fn_decimals", decimals, val);
    a += &return_bytes("fn_name", name, strbuf);
    a += &return_bytes("fn_symbol", symbol, strbuf);

    // ---- revert ----
    a += "revert:\n  PUSH8 0\n  PUSH8 0\n  REVERT\n";
    a
}

fn block20_bytecode(name: &str, symbol: &str, decimals: u64, supply: u64) -> Vec<u8> {
    asm::assemble(&block20_asm(name, symbol, decimals, supply))
        .unwrap_or_else(|e| panic!("BLOCK-20 asm failed to assemble: {e:?}\n\n{}", block20_asm(name, symbol, decimals, supply)))
}

fn u64_of(data: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[..8]);
    u64::from_le_bytes(b)
}

const GAS: u64 = 10_000_000;

#[test]
fn block20_conformance() {
    let code = block20_bytecode("Blockle Meme", "MEME", 8, 1_000_000);
    let id = [0x11u8; 32];
    let alice = [0xAAu8; 32];
    let bob = [0xBBu8; 32];

    let mut contracts: ContractMap = ContractMap::new();
    let mut storage: StorageMap = StorageMap::new();
    contracts.insert(id, ContractInfo { code: code.clone(), balance: 0 });

    let call = |sel: u8, args: &[u8], sender: [u8; 32], c: &mut ContractMap, s: &mut StorageMap| {
        let mut input = vec![sel];
        input.extend_from_slice(args);
        contracts::execute_call(&id, &input, 0, GAS, sender, 1, c, s)
    };

    // metadata
    let name = call(5, &[], alice, &mut contracts, &mut storage);
    assert!(name.success);
    assert_eq!(String::from_utf8(name.return_data.clone()).unwrap(), "Blockle Meme");
    let sym = call(6, &[], alice, &mut contracts, &mut storage);
    assert_eq!(String::from_utf8(sym.return_data.clone()).unwrap(), "MEME");
    let dec = call(4, &[], alice, &mut contracts, &mut storage);
    assert_eq!(u64_of(&dec.return_data), 8);
    let total = call(3, &[], alice, &mut contracts, &mut storage);
    assert_eq!(u64_of(&total.return_data), 1_000_000);

    // before init, balances are zero
    let b0 = call(1, &alice, alice, &mut contracts, &mut storage);
    assert_eq!(u64_of(&b0.return_data), 0);

    // init mints the whole supply to the deployer (alice)
    let init = call(0, &[], alice, &mut contracts, &mut storage);
    assert!(init.success, "init failed");
    let ba = call(1, &alice, alice, &mut contracts, &mut storage);
    assert_eq!(u64_of(&ba.return_data), 1_000_000);

    // re-init must revert (supply can't be minted twice)
    let reinit = call(0, &[], alice, &mut contracts, &mut storage);
    assert!(!reinit.success, "re-init should revert");

    // transfer 250_000 alice -> bob
    let mut args = Vec::new();
    args.extend_from_slice(&bob);
    args.extend_from_slice(&250_000u64.to_le_bytes());
    let t = call(2, &args, alice, &mut contracts, &mut storage);
    assert!(t.success, "transfer failed");
    assert_eq!(u64_of(&call(1, &alice, alice, &mut contracts, &mut storage).return_data), 750_000);
    assert_eq!(u64_of(&call(1, &bob, bob, &mut contracts, &mut storage).return_data), 250_000);

    // overspend reverts and changes nothing
    let mut big = Vec::new();
    big.extend_from_slice(&alice);
    big.extend_from_slice(&999_999_999u64.to_le_bytes());
    let over = call(2, &big, bob, &mut contracts, &mut storage);
    assert!(!over.success, "overspend should revert");
    assert_eq!(u64_of(&call(1, &bob, bob, &mut contracts, &mut storage).return_data), 250_000);
}
