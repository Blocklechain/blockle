//! BLOCK-20 — Blockle's fungible-token standard, emitted as VM assembly.
//! Balances live at `H(0x01 ‖ address)` (the VM's un-personalized Blake2b),
//! metadata + supply are baked in, and `init()` mints the supply to the
//! deployer once. Conformance-tested in tests/block20_token.rs; the native AMM
//! settles token legs against the same storage slots.

use blockle_vm::asm;

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

/// Assemble BLOCK-20 bytecode for a token with the given metadata + supply.
pub fn block20_bytecode(name: &str, symbol: &str, decimals: u64, supply: u64) -> Vec<u8> {
    asm::assemble(&block20_asm(name, symbol, decimals, supply))
        .expect("BLOCK-20 asm assembles")
}
