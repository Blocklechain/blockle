//! BLOCK-20S — Blockle's **regulated stablecoin** standard (e.g. USDB, the
//! USD-pegged Blockle Dollar issued by the licensed money transmitter). It is a
//! BLOCK-20 fungible token PLUS the issuer/compliance controls a regulated
//! stablecoin needs:
//!
//!   * **Issuer-only mint/burn** — supply is MUTABLE (unlike a BLOCK-20 whose
//!     supply is baked). The issuer mints against verified USD reserves and
//!     burns on redemption, so on-chain supply tracks custodied backing.
//!   * **Freeze / blacklist** — the issuer can freeze an address; frozen
//!     addresses can neither send nor receive (sanctions / law-enforcement).
//!   * **Global pause** — the issuer can halt all holder transfers.
//!   * The issuer is fixed to the deployer at `init()`.
//!
//! Supply/peg integrity is NOT enforced on-chain (the chain can't see USD
//! reserves) — it is enforced by the gated issuance service, which only mints
//! against verified deposits so supply <= reserves always. This contract is the
//! on-chain token + the issuer's enforcement controls.
//!
//! Storage (VM un-personalized BLAKE2B over `[slot ‖ addr]`, 33 bytes):
//!   * balances   H(1 ‖ addr)  -> u64
//!   * isIssuer   H(6 ‖ addr)  -> u64 flag (1 = issuer)
//!   * frozen     H(9 ‖ addr)  -> u64 flag (1 = frozen)
//! Singletons (storage key = the 32-byte region `[slot,0,…,0]`):
//!   * initFlag   slot 7
//!   * supply     slot 8
//!   * paused     slot 10
//!
//! Conformance-tested in tests/stablecoin.rs.

use blockle_vm::asm;

pub fn stablecoin_asm(name: &str, symbol: &str, decimals: u64) -> String {
    fn return_bytes(label: &str, s: &str, strbuf: u64) -> String {
        let mut out = format!("{label}:\n");
        for (i, b) in s.bytes().enumerate() {
            out += &format!("  PUSH {}\n  PUSH8 {}\n  MSTORE8\n", strbuf + i as u64, b);
        }
        out += &format!("  PUSH {strbuf}\n  PUSH8 {}\n  RETURN\n", s.len());
        out
    }
    fn return_u64_const(label: &str, v: u64, scratch: u64) -> String {
        format!("{label}:\n  PUSH {scratch}\n  PUSH {v}\n  MSTORE64\n  PUSH {scratch}\n  PUSH8 8\n  RETURN\n")
    }

    // memory map (mirrors block20 + a couple extra scratch regions)
    let sel = 0x00;
    let keya = 0x40; // computed storage key (32)
    let val = 0x80; // u64 scratch (8)
    let flag = 0x90; // singleton/flag scratch (8)
    let nf = 0xA0; // newFrom (8)
    let one = 0xA8; // return-1 scratch (8)
    let nt = 0xB0; // newTo (8)
    let hbuf = 0xC0; // hash input [slot ‖ addr] (33)
    let amt = 0x100; // amount (8)
    let sup = 0x110; // supply scratch (8)
    let idbuf = 0x120; // redeem id scratch (8)
    let inc = 0x128; // id+1 scratch (8)
    let zbuf = 0x130; // zero (8)
    let refbuf = 0x140; // payoutRef (32)
    let frombuf = 0x160; // caller for redeem record (32)
    let recbuf = 0x1A0; // redeemRecord output: [from(32) ‖ ref(32) ‖ amount(8) ‖ fulfilled(8)] = 80
    let fixed = 0x240; // fixed (zeroed) 32-byte key region
    let strbuf = 0x300; // name/symbol out

    // ---- reusable asm snippets --------------------------------------------
    // hash [slot ‖ addr(32)] at hbuf -> keya. addr must already be at hbuf+1.
    let hash_key = |slot: u64| {
        format!("  PUSH {hbuf}\n  PUSH8 {slot}\n  MSTORE8\n  PUSH {hbuf}\n  PUSH8 33\n  PUSH {keya}\n  BLAKE2B\n")
    };
    let caller_to_hbuf = format!("  PUSH {}\n  CALLER\n", hbuf + 1);
    let cd_addr_to_hbuf = |off: u64| format!("  PUSH {}\n  PUSH8 {off}\n  PUSH8 32\n  CALLDATACOPY\n", hbuf + 1);
    // load the u64 at storage[keya] -> dst (zeroed first for short/missing values)
    let sload_key = |dst: u64| format!("  PUSH {dst}\n  PUSH8 0\n  MSTORE64\n  PUSH {keya}\n  PUSH {dst}\n  SLOAD\n  POP\n");
    // singleton helpers: key = fixed region with byte0 = slot
    let set_fixed_slot = |slot: u64| format!("  PUSH {fixed}\n  PUSH8 {slot}\n  MSTORE8\n");
    let sload_singleton = |slot: u64, dst: u64| {
        format!("{}  PUSH {dst}\n  PUSH8 0\n  MSTORE64\n  PUSH {fixed}\n  PUSH {dst}\n  SLOAD\n  POP\n", set_fixed_slot(slot))
    };
    let sstore_singleton = |slot: u64, src: u64| format!("{}  PUSH {fixed}\n  PUSH {src}\n  PUSH8 8\n  SSTORE\n", set_fixed_slot(slot));
    // revert if the CALLER is not an issuer (isIssuer flag at slot 6 == 0)
    let require_issuer = format!(
        "{caller}{hash}{load}  PUSH {val}\n  MLOAD64\n  ISZERO\n  PUSH @revert\n  JUMPI\n",
        caller = caller_to_hbuf, hash = hash_key(6), load = sload_key(val)
    );
    // revert if the 32-byte addr at hbuf+1 is frozen (frozen flag slot 9 != 0).
    // (caller must place the address at hbuf+1 before invoking.)
    let require_not_frozen = format!(
        "{hash}{load}  PUSH {val}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n",
        hash = hash_key(9), load = sload_key(val)
    );
    // id-keyed storage: hash [slot ‖ id(8)] at hbuf -> keya. id must be at hbuf+1.
    let hash_key_id = |slot: u64| {
        format!("  PUSH {hbuf}\n  PUSH8 {slot}\n  MSTORE8\n  PUSH {hbuf}\n  PUSH8 9\n  PUSH {keya}\n  BLAKE2B\n")
    };
    // copy the u64 at mem[src] -> hbuf+1 (the id for an id-keyed hash)
    let id_from_scratch = |src: u64| format!("  PUSH {}\n  PUSH {src}\n  MLOAD64\n  MSTORE64\n", hbuf + 1);
    // copy calldata[1..9] (an 8-byte id arg) -> hbuf+1
    let id_from_calldata = format!("  PUSH {}\n  PUSH8 1\n  PUSH8 8\n  CALLDATACOPY\n", hbuf + 1);

    let mut a = String::new();
    // ---- dispatcher ----
    a += &format!("  PUSH {sel}\n  PUSH8 0\n  PUSH8 1\n  CALLDATACOPY\n  PUSH {sel}\n  MLOAD8\n");
    for (s, label) in [
        (0u64, "fn_init"),
        (1, "fn_balanceOf"),
        (2, "fn_transfer"),
        (3, "fn_totalSupply"),
        (4, "fn_decimals"),
        (5, "fn_name"),
        (6, "fn_symbol"),
        (7, "fn_mint"),
        (8, "fn_burn"),
        (9, "fn_freeze"),
        (10, "fn_unfreeze"),
        (11, "fn_pause"),
        (12, "fn_unpause"),
        (13, "fn_isFrozen"),
        (14, "fn_isPaused"),
        (15, "fn_redeem"),
        (16, "fn_redeemCount"),
        (17, "fn_redeemRecord"),
        (18, "fn_markRedeemed"),
    ] {
        a += &format!("  DUP 0\n  PUSH8 {s}\n  EQ\n  PUSH @{label}\n  JUMPI\n");
    }
    a += "  PUSH @revert\n  JUMP\n";

    // ---- fn_init : issuer = deployer; set once ----
    a += "fn_init:\n";
    // guard: initFlag(7) != 0 -> revert
    a += &sload_singleton(7, flag);
    a += &format!("  PUSH {flag}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    // isIssuer[caller] = 1
    a += &caller_to_hbuf;
    a += &hash_key(6);
    a += &format!("  PUSH {val}\n  PUSH8 1\n  MSTORE64\n  PUSH {keya}\n  PUSH {val}\n  PUSH8 8\n  SSTORE\n");
    // supply(8) = 0 ; paused(10) = 0 ; initFlag(7) = 1
    a += &format!("  PUSH {sup}\n  PUSH8 0\n  MSTORE64\n");
    a += &sstore_singleton(8, sup);
    a += &format!("  PUSH {flag}\n  PUSH8 0\n  MSTORE64\n");
    a += &sstore_singleton(10, flag);
    a += &format!("  PUSH {flag}\n  PUSH8 1\n  MSTORE64\n");
    a += &sstore_singleton(7, flag);
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_balanceOf(addr) ----
    a += "fn_balanceOf:\n";
    a += &cd_addr_to_hbuf(1);
    a += &hash_key(1);
    a += &sload_key(val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_transfer(to, amt) : !paused, !frozen(caller), !frozen(to) ----
    a += "fn_transfer:\n";
    // require !paused
    a += &sload_singleton(10, flag);
    a += &format!("  PUSH {flag}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    // amount <- calldata[33..41]
    a += &format!("  PUSH {amt}\n  PUSH8 33\n  PUSH8 8\n  CALLDATACOPY\n");
    // require !frozen(caller)
    a += &caller_to_hbuf;
    a += &require_not_frozen;
    // require !frozen(to)
    a += &cd_addr_to_hbuf(1);
    a += &require_not_frozen;
    // fromKey (caller, slot 1)
    a += &caller_to_hbuf;
    a += &hash_key(1);
    a += &sload_key(val);
    // require fromBal >= amount
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  LT\n  PUSH @revert\n  JUMPI\n");
    // newFrom = fromBal - amount ; store
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n  PUSH {nf}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nf}\n  PUSH8 8\n  SSTORE\n");
    // toKey (calldata to, slot 1) ; newTo = toBal + amount
    a += &cd_addr_to_hbuf(1);
    a += &hash_key(1);
    a += &sload_key(nt);
    a += &format!("  PUSH {nt}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  ADD\n  PUSH {nt}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nt}\n  PUSH8 8\n  SSTORE\n");
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_totalSupply : from storage (mutable) ----
    a += "fn_totalSupply:\n";
    a += &sload_singleton(8, val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- metadata getters ----
    a += &return_u64_const("fn_decimals", decimals, val);
    a += &return_bytes("fn_name", name, strbuf);
    a += &return_bytes("fn_symbol", symbol, strbuf);

    // ---- fn_mint(to, amt) : issuer-only ; balances[to]+=amt ; supply+=amt ----
    a += "fn_mint:\n";
    a += &require_issuer;
    a += &format!("  PUSH {amt}\n  PUSH8 33\n  PUSH8 8\n  CALLDATACOPY\n");
    // balances[to] += amt
    a += &cd_addr_to_hbuf(1);
    a += &hash_key(1);
    a += &sload_key(nt);
    a += &format!("  PUSH {nt}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  ADD\n  PUSH {nt}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nt}\n  PUSH8 8\n  SSTORE\n");
    // supply += amt
    a += &sload_singleton(8, sup);
    a += &format!("  PUSH {sup}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  ADD\n  PUSH {sup}\n  SWAP 1\n  MSTORE64\n");
    a += &sstore_singleton(8, sup);
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_burn(from, amt) : issuer-only ; balances[from]-=amt ; supply-=amt ----
    a += "fn_burn:\n";
    a += &require_issuer;
    a += &format!("  PUSH {amt}\n  PUSH8 33\n  PUSH8 8\n  CALLDATACOPY\n");
    a += &cd_addr_to_hbuf(1);
    a += &hash_key(1);
    a += &sload_key(val);
    // require fromBal >= amt
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  LT\n  PUSH @revert\n  JUMPI\n");
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n  PUSH {nf}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nf}\n  PUSH8 8\n  SSTORE\n");
    // supply -= amt
    a += &sload_singleton(8, sup);
    a += &format!("  PUSH {sup}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n  PUSH {sup}\n  SWAP 1\n  MSTORE64\n");
    a += &sstore_singleton(8, sup);
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_freeze(addr) / fn_unfreeze(addr) : issuer-only ----
    for (label, v) in [("fn_freeze", 1u64), ("fn_unfreeze", 0u64)] {
        a += &format!("{label}:\n");
        a += &require_issuer;
        a += &cd_addr_to_hbuf(1);
        a += &hash_key(9);
        a += &format!("  PUSH {val}\n  PUSH8 {v}\n  MSTORE64\n  PUSH {keya}\n  PUSH {val}\n  PUSH8 8\n  SSTORE\n");
        a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");
    }

    // ---- fn_pause / fn_unpause : issuer-only ----
    for (label, v) in [("fn_pause", 1u64), ("fn_unpause", 0u64)] {
        a += &format!("{label}:\n");
        a += &require_issuer;
        a += &format!("  PUSH {flag}\n  PUSH8 {v}\n  MSTORE64\n");
        a += &sstore_singleton(10, flag);
        a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");
    }

    // ---- fn_isFrozen(addr) -> u64 ----
    a += "fn_isFrozen:\n";
    a += &cd_addr_to_hbuf(1);
    a += &hash_key(9);
    a += &sload_key(val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_isPaused -> u64 ----
    a += "fn_isPaused:\n";
    a += &sload_singleton(10, val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_redeem(payoutRef:32, amt) : caller-initiated off-ramp ----
    // Burns the CALLER's own USDB (trustless — no treasury custody) and records
    // an on-chain redeem request {from, payoutRef, amount, fulfilled=0}. The
    // off-chain issuer service watches these (via redeemCount/redeemRecord),
    // pays the USD out through PayPal, then calls markRedeemed(id).
    // calldata: payoutRef@1 (32), amount@33 (8).
    a += "fn_redeem:\n";
    // require !paused
    a += &sload_singleton(10, flag);
    a += &format!("  PUSH {flag}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    // amount <- calldata[33..41]
    a += &format!("  PUSH {amt}\n  PUSH8 33\n  PUSH8 8\n  CALLDATACOPY\n");
    // require !frozen(caller)
    a += &caller_to_hbuf;
    a += &require_not_frozen;
    // balances[caller] -= amount
    a += &caller_to_hbuf;
    a += &hash_key(1);
    a += &sload_key(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  LT\n  PUSH @revert\n  JUMPI\n");
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n  PUSH {nf}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {keya}\n  PUSH {nf}\n  PUSH8 8\n  SSTORE\n");
    // supply -= amount
    a += &sload_singleton(8, sup);
    a += &format!("  PUSH {sup}\n  MLOAD64\n  PUSH {amt}\n  MLOAD64\n  SUB\n  PUSH {sup}\n  SWAP 1\n  MSTORE64\n");
    a += &sstore_singleton(8, sup);
    // id = redeemCount (slot 11)
    a += &sload_singleton(11, idbuf);
    // from(caller) @ H(12 ‖ id)
    a += &format!("  PUSH {frombuf}\n  CALLER\n");
    a += &id_from_scratch(idbuf);
    a += &hash_key_id(12);
    a += &format!("  PUSH {keya}\n  PUSH {frombuf}\n  PUSH8 32\n  SSTORE\n");
    // payoutRef (calldata[1..33]) @ H(13 ‖ id)
    a += &format!("  PUSH {refbuf}\n  PUSH8 1\n  PUSH8 32\n  CALLDATACOPY\n");
    a += &id_from_scratch(idbuf);
    a += &hash_key_id(13);
    a += &format!("  PUSH {keya}\n  PUSH {refbuf}\n  PUSH8 32\n  SSTORE\n");
    // amount @ H(14 ‖ id)
    a += &id_from_scratch(idbuf);
    a += &hash_key_id(14);
    a += &format!("  PUSH {keya}\n  PUSH {amt}\n  PUSH8 8\n  SSTORE\n");
    // fulfilled = 0 @ H(15 ‖ id)
    a += &format!("  PUSH {zbuf}\n  PUSH8 0\n  MSTORE64\n");
    a += &id_from_scratch(idbuf);
    a += &hash_key_id(15);
    a += &format!("  PUSH {keya}\n  PUSH {zbuf}\n  PUSH8 8\n  SSTORE\n");
    // redeemCount = id + 1
    a += &format!("  PUSH {idbuf}\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH {inc}\n  SWAP 1\n  MSTORE64\n");
    a += &sstore_singleton(11, inc);
    // return id
    a += &format!("  PUSH {idbuf}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_redeemCount() -> u64 ----
    a += "fn_redeemCount:\n";
    a += &sload_singleton(11, val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_redeemRecord(id) -> [from(32) ‖ ref(32) ‖ amount(8) ‖ fulfilled(8)] ----
    a += "fn_redeemRecord:\n";
    a += &id_from_calldata;
    a += &hash_key_id(12);
    a += &format!("  PUSH {keya}\n  PUSH {recbuf}\n  SLOAD\n  POP\n");
    a += &hash_key_id(13);
    a += &format!("  PUSH {keya}\n  PUSH {}\n  SLOAD\n  POP\n", recbuf + 32);
    a += &hash_key_id(14);
    a += &format!("  PUSH {keya}\n  PUSH {}\n  SLOAD\n  POP\n", recbuf + 64);
    a += &hash_key_id(15);
    a += &format!("  PUSH {keya}\n  PUSH {}\n  SLOAD\n  POP\n", recbuf + 72);
    a += &format!("  PUSH {recbuf}\n  PUSH8 80\n  RETURN\n");

    // ---- fn_markRedeemed(id) : issuer-only ; fulfilled[id] = 1 ----
    a += "fn_markRedeemed:\n";
    a += &require_issuer;
    a += &id_from_calldata;
    a += &hash_key_id(15);
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {keya}\n  PUSH {one}\n  PUSH8 8\n  SSTORE\n");
    a += &format!("  PUSH {one}\n  PUSH8 1\n  MSTORE64\n  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- revert ----
    a += "revert:\n  PUSH8 0\n  PUSH8 0\n  REVERT\n";
    a
}

/// Assemble BLOCK-20S (stablecoin) bytecode. Supply starts at 0; the issuer
/// (= deployer, set at `init()`) mints against verified reserves.
pub fn stablecoin_bytecode(name: &str, symbol: &str, decimals: u64) -> Vec<u8> {
    asm::assemble(&stablecoin_asm(name, symbol, decimals)).expect("BLOCK-20S asm assembles")
}
