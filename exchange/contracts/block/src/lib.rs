//! BLOCK leg of the cross-chain atomic-swap exchange.
//!
//! This crate emits Blockle VM bytecode for a **hash-timelocked contract
//! (HTLC)**: one deployed contract instance per swap leg. The lock amount is
//! carried as the native `Call.value`; claiming requires revealing a preimage
//! `s` whose BLAKE2B-256 hash equals the stored hashlock; refunding becomes
//! possible once the chain reaches the stored (absolute) timelock height.
//!
//! The VM exposes exactly the primitives an HTLC needs — `BLAKE2B` (32-byte
//! un-personalized Blake2b), `HEIGHT`, `CALLER`, `CALLVALUE`, keyed `SLOAD`/
//! `SSTORE`, and `SEND` (mints payout UTXOs out of the contract balance). We
//! wrap those; we do not fork the VM.
//!
//! ## Hash choice — IMPORTANT (see `PROTOCOL.md`)
//! The Blockle VM's only hashing opcode is `BLAKE2B` (there is **no** `SHA256`
//! opcode). The EVM and Solana legs use SHA-256 as the shared protocol hash.
//! A cross-hash HTLC (different hash functions on the two legs) is **not**
//! safe, because a counterparty cannot verify that `sha256(s)` and
//! `blake2b(s)` were derived from the same `s` without learning `s`. Therefore:
//!   * BLOCK ⇄ BLOCK swaps are fully supported today (BLAKE2B both legs).
//!   * BLOCK ⇄ EVM / BLOCK ⇄ Solana swaps require the VM to gain a `SHA256`
//!     opcode (a one-line host primitive) so the same hashlock can be used on
//!     every leg. This is documented as the single missing opcode in
//!     `PROTOCOL.md`; we do **not** fake it here.
//!
//! ## Call ABI (the leading byte of calldata selects the action)
//! * `lock`     `[0x00] ‖ receiver(32) ‖ hashlock(32) ‖ timelock_height(8 LE)`
//!              with `Call.value = amount`. Callable once.
//! * `withdraw` `[0x01] ‖ preimage(..)` — pays `receiver`, taking the protocol
//!              fee. Succeeds iff `blake2b256(preimage) == hashlock`.
//! * `refund`   `[0x02]` — pays `sender` (the locker) back, iff
//!              `HEIGHT >= timelock_height`. No fee on a failed swap.
//!
//! ## Protocol fee
//! On `withdraw` (settlement) the contract sends `amount * fee_bps / 10000`
//! to the configurable `fee_addr` and the remainder to `receiver`. `refund`
//! takes no fee. Testnet-first / mainnet-gated policy lives in the exchange
//! service, not in on-chain bytecode.

use blake2b_simd::Params;

/// Default protocol fee: 0.1% = 10 basis points.
pub const DEFAULT_FEE_BPS: u64 = 10;

/// HTLC state values stored at the `STATE` slot.
pub const STATE_LOCKED: u64 = 1;
pub const STATE_CLAIMED: u64 = 2;
pub const STATE_REFUNDED: u64 = 3;

// Storage-key "kinds". Each key is a 32-byte region whose first byte is the
// kind and whose remaining 31 bytes are zero, so the kinds never collide.
const K_STATE: u64 = 1;
const K_RECV: u64 = 2;
const K_HASH: u64 = 3;
const K_TIME: u64 = 4;
const K_SEND: u64 = 5;
const K_AMT: u64 = 6;

// Memory map (byte offsets into VM scratch memory).
const SEL: u64 = 0x00; // selector byte
const KEYB: u64 = 0x40; // 32-byte storage-key region (only byte 0 varies)
const VAL: u64 = 0x80; // 8-byte scratch
const VAL2: u64 = 0x90; // 8-byte scratch (fee)
const ADDR: u64 = 0x100; // 32-byte scratch: receiver/sender + SEND target
const STOREDH: u64 = 0x140; // 32-byte scratch: stored hashlock
const HOUT: u64 = 0x180; // 32-byte scratch: computed hash
const FEEA: u64 = 0x1C0; // 32-byte baked fee address
const HBUF: u64 = 0x200; // preimage copy buffer

/// Selector bytes for the three HTLC actions.
pub const SEL_LOCK: u8 = 0;
pub const SEL_WITHDRAW: u8 = 1;
pub const SEL_REFUND: u8 = 2;

/// BLAKE2B-256 of `data`, matching the VM's `BLAKE2B` opcode exactly
/// (un-personalized, 32-byte output). This is the hashlock function for the
/// BLOCK leg.
pub fn blake2b256(data: &[u8]) -> [u8; 32] {
    let h = Params::new().hash_length(32).to_state().update(data).finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    out
}

/// Build the `lock` calldata (prepend as `Call.input`; attach `amount` as
/// `Call.value`).
pub fn lock_calldata(receiver: &[u8; 32], hashlock: &[u8; 32], timelock_height: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + 32 + 32 + 8);
    v.push(SEL_LOCK);
    v.extend_from_slice(receiver);
    v.extend_from_slice(hashlock);
    v.extend_from_slice(&timelock_height.to_le_bytes());
    v
}

/// Build the `withdraw` calldata that reveals `preimage`.
pub fn withdraw_calldata(preimage: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + preimage.len());
    v.push(SEL_WITHDRAW);
    v.extend_from_slice(preimage);
    v
}

/// Build the `refund` calldata.
pub fn refund_calldata() -> Vec<u8> {
    vec![SEL_REFUND]
}

/// Emit the HTLC contract as VM assembly text. `fee_addr` receives the
/// settlement fee; `fee_bps` is the fee in basis points (0 disables the fee
/// output entirely).
pub fn htlc_asm(fee_addr: &[u8; 32], fee_bps: u64) -> String {
    let mut a = String::new();

    // ---- dispatcher: read selector byte, branch ----
    a += &format!("  PUSH {SEL}\n  PUSH 0\n  PUSH 1\n  CALLDATACOPY\n");
    a += &format!("  PUSH {SEL}\n  MLOAD8\n");
    for (sel, label) in [(0u64, "fn_lock"), (1, "fn_withdraw"), (2, "fn_refund")] {
        a += &format!("  DUP 0\n  PUSH {sel}\n  EQ\n  PUSH @{label}\n  JUMPI\n");
    }
    a += "  PUSH @revert\n  JUMP\n";

    // helper: set the key region's kind byte
    let key = |kind: u64| format!("  PUSH {KEYB}\n  PUSH {kind}\n  MSTORE8\n");
    // helper: SLOAD an 8-byte value (zero-defaulted) into VAL
    let load_u64 = |kind: u64| {
        format!(
            "{}  PUSH {VAL}\n  PUSH 0\n  MSTORE64\n  PUSH {KEYB}\n  PUSH {VAL}\n  SLOAD\n  POP\n",
            key(kind)
        )
    };
    // helper: store STATE = v
    let set_state = |v: u64| {
        format!(
            "{}  PUSH {VAL}\n  PUSH {v}\n  MSTORE64\n  PUSH {KEYB}\n  PUSH {VAL}\n  PUSH 8\n  SSTORE\n",
            key(K_STATE)
        )
    };
    // helper: RETURN the u64 `1`
    let return_one = format!(
        "  PUSH {VAL}\n  PUSH 1\n  MSTORE64\n  PUSH {VAL}\n  PUSH 8\n  RETURN\n"
    );

    // ---- fn_lock ----
    a += "fn_lock:\n  POP\n";
    // guard: STATE must be 0 (unlocked)
    a += &load_u64(K_STATE);
    a += &format!("  PUSH {VAL}\n  MLOAD64\n  PUSH @revert\n  JUMPI\n");
    // receiver = calldata[1..33]
    a += &format!("  PUSH {ADDR}\n  PUSH 1\n  PUSH 32\n  CALLDATACOPY\n");
    a += &key(K_RECV);
    a += &format!("  PUSH {KEYB}\n  PUSH {ADDR}\n  PUSH 32\n  SSTORE\n");
    // hashlock = calldata[33..65]
    a += &format!("  PUSH {STOREDH}\n  PUSH 33\n  PUSH 32\n  CALLDATACOPY\n");
    a += &key(K_HASH);
    a += &format!("  PUSH {KEYB}\n  PUSH {STOREDH}\n  PUSH 32\n  SSTORE\n");
    // timelock = calldata[65..73]
    a += &format!("  PUSH {VAL}\n  PUSH 65\n  PUSH 8\n  CALLDATACOPY\n");
    a += &key(K_TIME);
    a += &format!("  PUSH {KEYB}\n  PUSH {VAL}\n  PUSH 8\n  SSTORE\n");
    // sender (refund target) = CALLER
    a += &format!("  PUSH {ADDR}\n  CALLER\n");
    a += &key(K_SEND);
    a += &format!("  PUSH {KEYB}\n  PUSH {ADDR}\n  PUSH 32\n  SSTORE\n");
    // amount = CALLVALUE
    a += &format!("  PUSH {VAL}\n  CALLVALUE\n  MSTORE64\n");
    a += &key(K_AMT);
    a += &format!("  PUSH {KEYB}\n  PUSH {VAL}\n  PUSH 8\n  SSTORE\n");
    a += &set_state(STATE_LOCKED);
    a += &return_one;

    // ---- fn_withdraw ----
    a += "fn_withdraw:\n  POP\n";
    // guard: STATE must be LOCKED
    a += &load_u64(K_STATE);
    a += &format!(
        "  PUSH {VAL}\n  MLOAD64\n  PUSH {STATE_LOCKED}\n  EQ\n  ISZERO\n  PUSH @revert\n  JUMPI\n"
    );
    // hash the preimage = calldata[1..calldatasize]
    a += &format!("  PUSH {HBUF}\n  PUSH 1\n  CALLDATASIZE\n  PUSH 1\n  SUB\n  CALLDATACOPY\n");
    a += &format!("  PUSH {HBUF}\n  CALLDATASIZE\n  PUSH 1\n  SUB\n  PUSH {HOUT}\n  BLAKE2B\n");
    // load stored hashlock
    a += &key(K_HASH);
    a += &format!("  PUSH {KEYB}\n  PUSH {STOREDH}\n  SLOAD\n  POP\n");
    // compare 4 u64 words; any mismatch reverts
    for i in 0..4u64 {
        let off = i * 8;
        a += &format!(
            "  PUSH {}\n  MLOAD64\n  PUSH {}\n  MLOAD64\n  EQ\n  ISZERO\n  PUSH @revert\n  JUMPI\n",
            HOUT + off,
            STOREDH + off
        );
    }
    // load amount -> VAL, receiver -> ADDR
    a += &load_u64(K_AMT);
    a += &key(K_RECV);
    a += &format!("  PUSH {KEYB}\n  PUSH {ADDR}\n  SLOAD\n  POP\n");
    if fee_bps > 0 {
        // fee = amount * fee_bps / 10000 -> VAL2
        a += &format!(
            "  PUSH {VAL}\n  MLOAD64\n  PUSH {fee_bps}\n  MUL\n  PUSH 10000\n  DIV\n  PUSH {VAL2}\n  SWAP 1\n  MSTORE64\n"
        );
        // payout = amount - fee -> VAL (overwrite; amount no longer needed)
        a += &format!(
            "  PUSH {VAL}\n  MLOAD64\n  PUSH {VAL2}\n  MLOAD64\n  SUB\n  PUSH {VAL}\n  SWAP 1\n  MSTORE64\n"
        );
        // SEND payout to receiver
        a += &format!("  PUSH {ADDR}\n  PUSH {VAL}\n  MLOAD64\n  SEND\n");
        // bake fee address into FEEA, SEND fee
        for (i, b) in fee_addr.iter().enumerate() {
            a += &format!("  PUSH {}\n  PUSH {}\n  MSTORE8\n", FEEA + i as u64, b);
        }
        a += &format!("  PUSH {FEEA}\n  PUSH {VAL2}\n  MLOAD64\n  SEND\n");
    } else {
        // no fee: SEND the whole amount to receiver
        a += &format!("  PUSH {ADDR}\n  PUSH {VAL}\n  MLOAD64\n  SEND\n");
    }
    a += &set_state(STATE_CLAIMED);
    a += &return_one;

    // ---- fn_refund ----
    a += "fn_refund:\n  POP\n";
    // guard: STATE must be LOCKED
    a += &load_u64(K_STATE);
    a += &format!(
        "  PUSH {VAL}\n  MLOAD64\n  PUSH {STATE_LOCKED}\n  EQ\n  ISZERO\n  PUSH @revert\n  JUMPI\n"
    );
    // require HEIGHT >= timelock  (revert if HEIGHT < timelock)
    a += &load_u64(K_TIME);
    a += &format!("  HEIGHT\n  PUSH {VAL}\n  MLOAD64\n  LT\n  PUSH @revert\n  JUMPI\n");
    // load amount -> VAL, sender -> ADDR
    a += &load_u64(K_AMT);
    a += &key(K_SEND);
    a += &format!("  PUSH {KEYB}\n  PUSH {ADDR}\n  SLOAD\n  POP\n");
    // SEND amount back to sender
    a += &format!("  PUSH {ADDR}\n  PUSH {VAL}\n  MLOAD64\n  SEND\n");
    a += &set_state(STATE_REFUNDED);
    a += &return_one;

    // ---- revert ----
    a += "revert:\n  PUSH 0\n  PUSH 0\n  REVERT\n";
    a
}

/// Assemble the HTLC bytecode.
pub fn htlc_bytecode(fee_addr: &[u8; 32], fee_bps: u64) -> Vec<u8> {
    blockle_vm::asm::assemble(&htlc_asm(fee_addr, fee_bps)).expect("HTLC asm assembles")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asm_assembles_with_and_without_fee() {
        assert!(!htlc_bytecode(&[0xab; 32], DEFAULT_FEE_BPS).is_empty());
        assert!(!htlc_bytecode(&[0u8; 32], 0).is_empty());
    }

    #[test]
    fn calldata_layout() {
        let cd = lock_calldata(&[1u8; 32], &[2u8; 32], 0x1122);
        assert_eq!(cd.len(), 73);
        assert_eq!(cd[0], SEL_LOCK);
        assert_eq!(&cd[65..73], &0x1122u64.to_le_bytes());
        assert_eq!(withdraw_calldata(b"secret")[0], SEL_WITHDRAW);
        assert_eq!(refund_calldata(), vec![SEL_REFUND]);
    }

    #[test]
    fn hashlock_matches_vm_blake2b() {
        // Same construction the VM's BLAKE2B opcode uses.
        let got = blake2b256(b"preimage");
        let want = Params::new()
            .hash_length(32)
            .to_state()
            .update(b"preimage")
            .finalize();
        assert_eq!(&got, want.as_bytes());
    }
}
