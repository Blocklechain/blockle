//! Blockle Protect anchor registry — a minimal, permissionless on-chain notary.
//!
//! Blockle Protect batches file/manifest commitments into a SHA-384 Merkle tree
//! off-chain and anchors ONLY the 32-byte-truncated Merkle root here (never the
//! files, never keys). This contract records, for each root, the block height at
//! which it was first anchored, so that **anyone** can independently verify a
//! portable proof's root is on-chain with a single read — without trusting the
//! Blockle Protect backend or decoding raw transactions.
//!
//! ABI (calldata = selector byte ‖ args):
//!   * selector 0 `anchor(root[32])`   -> u64 height
//!       Records height[H(1‖root)] = block height, first-write-wins (idempotent:
//!       re-anchoring an existing root returns the ORIGINAL height, preserving
//!       the earliest timestamp). Permissionless — a root is an opaque hash that
//!       reveals nothing, so anyone may notarize one.
//!   * selector 1 `anchored(root[32])` -> u64 height
//!       Read-only view (use the node's `callcontract`): returns the anchor
//!       height, or 0 if the root was never anchored.
//!
//! Storage: height[root] at key H(1 ‖ root) (BLAKE2B over the 33-byte region),
//! matching the stablecoin's `balances` keying so the VM's storage model is
//! reused unchanged. Conformance-tested in tests/anchor_registry.rs.

use blockle_vm::asm;

pub fn anchor_registry_asm() -> String {
    // memory map
    let sel = 0x00; // selector byte
    let keya = 0x40; // computed storage key (32)
    let val = 0x80; // u64 scratch (8)
    let hbuf = 0xC0; // hash input [slot ‖ root(32)] = 33 bytes

    // hash [slot ‖ root(32)] at hbuf -> keya. root must already be at hbuf+1.
    let hash_key = |slot: u64| {
        format!("  PUSH {hbuf}\n  PUSH8 {slot}\n  MSTORE8\n  PUSH {hbuf}\n  PUSH8 33\n  PUSH {keya}\n  BLAKE2B\n")
    };
    // copy the 32-byte root from calldata[1..33] to hbuf+1.
    let root_to_hbuf = format!("  PUSH {}\n  PUSH8 1\n  PUSH8 32\n  CALLDATACOPY\n", hbuf + 1);
    // load the u64 at storage[keya] -> val (zeroed first for short/missing values).
    let sload_val = format!("  PUSH {val}\n  PUSH8 0\n  MSTORE64\n  PUSH {keya}\n  PUSH {val}\n  SLOAD\n  POP\n");

    let mut a = String::new();

    // ---- dispatcher: selector = calldata[0] ----
    a += &format!("  PUSH {sel}\n  PUSH8 0\n  PUSH8 1\n  CALLDATACOPY\n  PUSH {sel}\n  MLOAD8\n");
    for (s, label) in [(0u64, "fn_anchor"), (1, "fn_anchored")] {
        a += &format!("  DUP 0\n  PUSH8 {s}\n  EQ\n  PUSH @{label}\n  JUMPI\n");
    }
    a += "  PUSH @revert\n  JUMP\n";

    // ---- fn_anchor(root[32]) -> height : first-write-wins ----
    a += "fn_anchor:\n";
    a += &root_to_hbuf;
    a += &hash_key(1);
    a += &sload_val;
    // if already anchored (val != 0) -> return the existing height unchanged.
    a += &format!("  PUSH {val}\n  MLOAD64\n  PUSH @anchor_done\n  JUMPI\n");
    // else store the current block height at height[root].
    a += &format!("  PUSH {val}\n  HEIGHT\n  MSTORE64\n  PUSH {keya}\n  PUSH {val}\n  PUSH8 8\n  SSTORE\n");
    a += "anchor_done:\n";
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- fn_anchored(root[32]) -> height : read-only view ----
    a += "fn_anchored:\n";
    a += &root_to_hbuf;
    a += &hash_key(1);
    a += &sload_val;
    a += &format!("  PUSH {val}\n  PUSH8 8\n  RETURN\n");

    // ---- revert ----
    a += "revert:\n  PUSH8 0\n  PUSH8 0\n  REVERT\n";
    a
}

/// Assemble the anchor-registry bytecode (no constructor args — storage starts
/// empty; the registry is permissionless and has no owner).
pub fn anchor_registry_bytecode() -> Vec<u8> {
    asm::assemble(&anchor_registry_asm()).expect("anchor-registry asm assembles")
}
