//! BLOCK-721 — Blockle's non-fungible-token (NFT) standard, emitted as VM
//! assembly (same approach as `block20`). Used by Blockle WORLD for in-game
//! items and by the NFT marketplace.
//!
//! Storage (keys = the VM's un-personalized Blake2b over `slot ‖ data`):
//!   balanceOf : H(0x01 ‖ owner32)        -> u64   (how many NFTs an address holds)
//!   ownerOf   : H(0x02 ‖ tokenId32)      -> 32    (owner address of a token)
//!   exists    : H(0x04 ‖ tokenId32)      -> u64   (1 once minted)
//!   owns      : H(0x05 ‖ owner32 ‖ id32) -> u64   (membership flag; avoids 32-byte compares)
//!   isMinter  : H(0x06 ‖ addr32)         -> u64   (1 for authorized minters)
//!   supply    : fixed slot 8             -> u64   (total minted)
//!   initFlag  : fixed slot 7             -> u64   (init-once guard)
//!
//! Selectors (calldata[0]):
//!   0 init()                         — set caller as minter, once
//!   1 balanceOf(owner:32) -> u64
//!   2 transfer(id:32, to:32) -> 1    — caller must own `id`
//!   3 totalSupply() -> u64
//!   5 name() -> bytes
//!   6 symbol() -> bytes
//!   7 ownerOf(id:32) -> 32
//!   8 mint(id:32, to:32) -> 1        — caller must be a minter; `id` must be new
//!
//! Ownership + minter checks are u64 membership-flag loads (never a 32-byte
//! equality), and every key input is copied straight from calldata/CALLER into
//! the hash buffer — so the asm stays within the exact primitives BLOCK-20 uses
//! (the VM has no memory-to-memory copy).

use blockle_vm::asm;

pub fn block721_asm(name: &str, symbol: &str) -> String {
    fn return_bytes(label: &str, s: &str, strbuf: u64) -> String {
        let mut out = format!("{label}:\n");
        for (i, b) in s.bytes().enumerate() {
            out += &format!("  PUSH {}\n  PUSH8 {}\n  MSTORE8\n", strbuf + i as u64, b);
        }
        out += &format!("  PUSH {strbuf}\n  PUSH8 {}\n  RETURN\n", s.len());
        out
    }

    // memory map
    let sel = 0x00; // selector byte
    let keya = 0x40; // computed storage key (32)
    let val = 0x80; // u64 scratch (8)
    let one = 0xA0; // generic u64 scratch (8)
    let n1 = 0xA8; // adjusted-balance scratch (8)
    let fixed = 0x100; // fixed (zeroed) key region for singleton slots (32)
    let hbuf = 0x140; // hash input: [slot ‖ a(32) ‖ b(32)] (<=65)
    let owner = 0x200; // 32-byte owner value (ownerOf return)
    let tobuf = 0x240; // `to` address from calldata (32), used as an SSTORE value
    let strbuf = 0x300; // name/symbol out
    let evt = 0x380; // Transfer event buffer: [tag(1) ‖ from(32) ‖ to(32) ‖ id(32)] = 97

    // calldata helpers: copy a 32-byte field from calldata[off..off+32] into mem[dst]
    let cd32 = |dst: u64, off: u64| format!("  PUSH {dst}\n  PUSH8 {off}\n  PUSH8 32\n  CALLDATACOPY\n");
    // write CALLER (32 bytes) into mem[dst]
    let caller_to = |dst: u64| format!("  PUSH {dst}\n  CALLER\n");

    let mut a = String::new();

    // ---- dispatcher ----
    a += &format!("  PUSH {sel}\n  PUSH8 0\n  PUSH8 1\n  CALLDATACOPY\n  PUSH {sel}\n  MLOAD8\n");
    for (s, label) in [
        (0u64, "fn_init"),
        (1, "fn_balanceOf"),
        (2, "fn_transfer"),
        (3, "fn_totalSupply"),
        (5, "fn_name"),
        (6, "fn_symbol"),
        (7, "fn_ownerOf"),
        (8, "fn_mint"),
    ] {
        a += &format!("  DUP 0\n  PUSH8 {s}\n  EQ\n  PUSH @{label}\n  JUMPI\n");
    }
    a += "  PUSH @revert\n  JUMP\n";

    // key builders: hash `len` bytes at hbuf (slot byte written first) -> keya
    let key = |slot: u64, len: u64| {
        format!("  PUSH {hbuf}\n  PUSH8 {slot}\n  MSTORE8\n  PUSH {hbuf}\n  PUSH8 {len}\n  PUSH {keya}\n  BLAKE2B\n")
    };
    // load u64 at storage[keya] -> dst (0 if unset)
    let load_u64 = |dst: u64| format!("  PUSH {dst}\n  PUSH8 0\n  MSTORE64\n  PUSH {keya}\n  PUSH {dst}\n  SLOAD\n  POP\n");
    // load u64 from a SINGLETON fixed-slot key (the 32-byte `fixed` region) -> dst
    let load_fixed = |dst: u64| format!("  PUSH {dst}\n  PUSH8 0\n  MSTORE64\n  PUSH {fixed}\n  PUSH {dst}\n  SLOAD\n  POP\n");
    // store u64 value at scratch `src` into storage[keya]
    let store_u64 = |src: u64| format!("  PUSH {keya}\n  PUSH {src}\n  PUSH8 8\n  SSTORE\n");
    let set_u64 = |dst: u64, v: u64| format!("  PUSH {dst}\n  PUSH {v}\n  MSTORE64\n");

    // ---- fn_init : set caller as a minter, once ----
    a += "fn_init:\n";
    a += &format!("  PUSH {fixed}\n  PUSH8 7\n  MSTORE8\n");
    a += &load_fixed(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n"); // reverts if already initialised
    // isMinter[caller] = 1
    a += &caller_to(hbuf + 1);
    a += &key(6, 33);
    a += &set_u64(one, 1);
    a += &store_u64(one);
    // initFlag(7) = 1
    a += &format!("  PUSH {fixed}\n  PUSH8 7\n  MSTORE8\n");
    a += &set_u64(one, 1);
    a += &format!("  PUSH {fixed}\n  PUSH {one}\n  PUSH8 8\n  SSTORE\n");
    // supply(8) = 0
    a += &format!("  PUSH {fixed}\n  PUSH8 8\n  MSTORE8\n");
    a += &set_u64(val, 0);
    a += &format!("  PUSH {fixed}\n  PUSH {val}\n  PUSH8 8\n  SSTORE\n");
    a += &set_u64(one, 1);
    a += &format!("  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_balanceOf(owner:32) ----
    a += "fn_balanceOf:\n";
    a += &cd32(hbuf + 1, 1);
    a += &key(1, 33);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_ownerOf(id:32) -> 32 ----
    a += "fn_ownerOf:\n";
    a += &cd32(hbuf + 1, 1);
    a += &key(2, 33);
    a += &format!("  PUSH {keya}\n  PUSH {owner}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {owner}\n  PUSH8 32\n  RETURN\n");

    // ---- fn_totalSupply() ----
    a += "fn_totalSupply:\n";
    a += &format!("  PUSH {fixed}\n  PUSH8 8\n  MSTORE8\n");
    a += &load_fixed(val);
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_mint(id:32, to:32) ----  calldata: id@1, to@33
    a += "fn_mint:\n";
    a += &cd32(tobuf, 33); // stash `to` for owner-value SSTORE
    // require isMinter[caller] == 1
    a += &caller_to(hbuf + 1);
    a += &key(6, 33);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH8 0\n  EQ\n  PUSH @revert\n  JUMPI\n");
    // require exists[id] == 0
    a += &cd32(hbuf + 1, 1);
    a += &key(4, 33);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    // ownerOf[id] = to
    a += &cd32(hbuf + 1, 1);
    a += &key(2, 33);
    a += &format!("  PUSH {keya}\n  PUSH {tobuf}\n  PUSH8 32\n  SSTORE\n");
    // exists[id] = 1
    a += &cd32(hbuf + 1, 1);
    a += &key(4, 33);
    a += &set_u64(one, 1);
    a += &store_u64(one);
    // owns[to ‖ id] = 1
    a += &cd32(hbuf + 1, 33); // to
    a += &cd32(hbuf + 33, 1); // id
    a += &key(5, 65);
    a += &set_u64(one, 1);
    a += &store_u64(one);
    // balanceOf[to] += 1
    a += &cd32(hbuf + 1, 33);
    a += &key(1, 33);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH {n1}\n  SWAP 1\n  MSTORE64\n");
    a += &store_u64(n1);
    // supply += 1
    a += &format!("  PUSH {fixed}\n  PUSH8 8\n  MSTORE8\n");
    a += &format!("  PUSH {val}\n  PUSH8 0\n  MSTORE64\n  PUSH {fixed}\n  PUSH {val}\n  SLOAD\n  POP\n");
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH {n1}\n  SWAP 1\n  MSTORE64\n");
    a += &format!("  PUSH {fixed}\n  PUSH {n1}\n  PUSH8 8\n  SSTORE\n");
    // emit Transfer(from=0, to, id): [tag=1 ‖ from(32, zero) ‖ to(32) ‖ id(32)] (97 bytes).
    // LOG pops (len, off) so push off then len. The `from` slot stays zero (fresh memory).
    a += &format!("  PUSH {evt}\n  PUSH8 1\n  MSTORE8\n");
    a += &cd32(evt + 33, 33); // to
    a += &cd32(evt + 65, 1); // id
    a += &format!("  PUSH {evt}\n  PUSH 97\n  LOG\n");
    a += &set_u64(one, 1);
    a += &format!("  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_transfer(id:32, to:32) ----  calldata: id@1, to@33
    a += "fn_transfer:\n";
    a += &cd32(tobuf, 33); // stash `to` for owner-value SSTORE
    // require owns[caller ‖ id] == 1
    a += &caller_to(hbuf + 1);
    a += &cd32(hbuf + 33, 1);
    a += &key(5, 65);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH8 0\n  EQ\n  PUSH @revert\n  JUMPI\n");
    // owns[caller ‖ id] = 0
    a += &caller_to(hbuf + 1);
    a += &cd32(hbuf + 33, 1);
    a += &key(5, 65);
    a += &set_u64(val, 0);
    a += &store_u64(val);
    // owns[to ‖ id] = 1
    a += &cd32(hbuf + 1, 33);
    a += &cd32(hbuf + 33, 1);
    a += &key(5, 65);
    a += &set_u64(one, 1);
    a += &store_u64(one);
    // ownerOf[id] = to
    a += &cd32(hbuf + 1, 1);
    a += &key(2, 33);
    a += &format!("  PUSH {keya}\n  PUSH {tobuf}\n  PUSH8 32\n  SSTORE\n");
    // balanceOf[caller] -= 1
    a += &caller_to(hbuf + 1);
    a += &key(1, 33);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH 1\n  SUB\n  PUSH {n1}\n  SWAP 1\n  MSTORE64\n");
    a += &store_u64(n1);
    // balanceOf[to] += 1
    a += &cd32(hbuf + 1, 33);
    a += &key(1, 33);
    a += &load_u64(val);
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH 1\n  ADD\n  PUSH {n1}\n  SWAP 1\n  MSTORE64\n");
    a += &store_u64(n1);
    // emit Transfer(from=caller, to, id): [tag=1 ‖ from(32) ‖ to(32) ‖ id(32)] (97 bytes)
    a += &format!("  PUSH {evt}\n  PUSH8 1\n  MSTORE8\n");
    a += &caller_to(evt + 1); // from = caller
    a += &cd32(evt + 33, 33); // to
    a += &cd32(evt + 65, 1); // id
    a += &format!("  PUSH {evt}\n  PUSH 97\n  LOG\n");
    a += &set_u64(one, 1);
    a += &format!("  PUSH {one}\n  PUSH8 8\n  RETURN\n");

    // ---- metadata ----
    a += &return_bytes("fn_name", name, strbuf);
    a += &return_bytes("fn_symbol", symbol, strbuf);

    // ---- revert ----
    a += "revert:\n  PUSH8 0\n  PUSH8 0\n  REVERT\n";
    a
}

/// Assemble BLOCK-721 bytecode for an NFT collection with the given metadata.
pub fn block721_bytecode(name: &str, symbol: &str) -> Vec<u8> {
    asm::assemble(&block721_asm(name, symbol)).expect("BLOCK-721 asm assembles")
}
