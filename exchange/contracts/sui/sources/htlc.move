/// Sui leg of the Blockle cross-chain atomic-swap exchange.
///
/// A non-custodial hash-timelocked contract (HTLC) generic over any Sui coin
/// type `T` (native SUI is `Coin<SUI>`; USDC-on-Sui and other coins drop in
/// with no code change). The escrowed coin lives inside a **shared object**
/// that can only pay its receiver (on preimage reveal, before the timelock) or
/// refund its sender (after the timelock). The relay never holds the object,
/// the coin, or any key — it only coordinates the hashlock/preimage handshake.
///
/// Protocol hash: **SHA-256** (`std::hash::sha2_256`), identical to the EVM,
/// Solana and BTC legs, so one preimage `s` with `H = sha256(s)` opens every
/// leg of a swap. See `../PROTOCOL.md`.
///
/// Protocol fee: a configurable basis-point fee (hard-capped at
/// `MAX_FEE_BPS` = 1.00%) is taken ONLY on `redeem` (the happy path) and sent
/// to the `fee_recipient` recorded at lock time (the treasury address, passed
/// in by the caller — never hardcoded). `refund` takes NO fee: a failed swap
/// makes the sender whole.
///
/// One-shot by construction: `redeem` and `refund` consume the shared object by
/// value and delete it, so a second call has nothing to act on — double-spend /
/// double-refund are impossible without any explicit state flag.
///
/// Testnet-first / mainnet gating: a Sui package is published per-network, so
/// the mainnet switch lives at the deploy + relay-config boundary (see
/// `scripts/deploy.sh` and the relay), not in this module. The money paths here
/// are pure and network-agnostic.
module blockle_htlc::htlc;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use std::hash;

/// 1.00% hard cap on the settlement fee, mirroring the EVM/Solana legs so a
/// misconfiguration can never confiscate a trade.
const MAX_FEE_BPS: u16 = 100;

// --- error codes ---
const EBadHashlockLen: u64 = 0; // hashlock is not exactly 32 bytes
const EBadTimelock: u64 = 1; // timelock is not in the future at lock time
const EZeroAmount: u64 = 2; // nothing to escrow
const EFeeTooHigh: u64 = 3; // fee_bps exceeds MAX_FEE_BPS
const EInvalidPreimage: u64 = 4; // sha256(preimage) != hashlock
const ETimelockExpired: u64 = 5; // redeem attempted at/after the timelock
const ETimelockNotExpired: u64 = 6; // refund attempted before the timelock
const EWrongSender: u64 = 7; // refund caller is not the recorded sender

/// The escrow. Shared so either party (or a coordinator) can submit the
/// redeem/refund transaction; the asserts guarantee funds can only ever reach
/// the recorded `receiver` (redeem) or `sender` (refund).
public struct HTLC<phantom T> has key {
    id: UID,
    sender: address,
    receiver: address,
    escrow: Balance<T>,
    /// H = sha256(preimage), 32 bytes.
    hashlock: vector<u8>,
    /// Wall-clock deadline in milliseconds (Sui `Clock`). Pairs directly with
    /// the EVM/Solana unix-second timelocks (×1000). The protocol's T2 < T1
    /// rule is enforced off-chain by the relay when it sizes each leg.
    timelock_ms: u64,
    fee_bps: u16,
    fee_recipient: address,
}

// --- events (indexed by the relay to drive the swap state machine) ---

public struct Locked has copy, drop {
    htlc_id: ID,
    sender: address,
    receiver: address,
    amount: u64,
    hashlock: vector<u8>,
    timelock_ms: u64,
}

/// Emitted on settlement. `preimage` is published on-chain here — this is the
/// reveal the counterparty reads to claim the other leg.
public struct Redeemed has copy, drop {
    htlc_id: ID,
    preimage: vector<u8>,
    payout: u64,
    fee: u64,
}

public struct Refunded has copy, drop {
    htlc_id: ID,
    amount: u64,
}

/// Lock `payment` into a fresh shared HTLC. `receiver` claims with the preimage
/// of `hashlock` before `timelock_ms`; otherwise `sender` refunds after it.
/// `fee_recipient` is the treasury address the settlement fee pays to.
public entry fun lock<T>(
    payment: Coin<T>,
    receiver: address,
    hashlock: vector<u8>,
    timelock_ms: u64,
    fee_bps: u16,
    fee_recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(hashlock.length() == 32, EBadHashlockLen);
    assert!(fee_bps <= MAX_FEE_BPS, EFeeTooHigh);
    assert!(timelock_ms > clock.timestamp_ms(), EBadTimelock);
    let amount = payment.value();
    assert!(amount > 0, EZeroAmount);

    let htlc = HTLC<T> {
        id: object::new(ctx),
        sender: ctx.sender(),
        receiver,
        escrow: payment.into_balance(),
        hashlock,
        timelock_ms,
        fee_bps,
        fee_recipient,
    };
    event::emit(Locked {
        htlc_id: object::id(&htlc),
        sender: htlc.sender,
        receiver,
        amount,
        hashlock,
        timelock_ms,
    });
    transfer::share_object(htlc);
}

/// Settle: reveal `preimage` such that `sha256(preimage) == hashlock`, before
/// the timelock. Pays `receiver` the amount minus the fee, pays the fee to
/// `fee_recipient`, and destroys the escrow. Anyone may submit this tx — the
/// funds can only move to the recorded `receiver`.
public entry fun redeem<T>(
    htlc: HTLC<T>,
    preimage: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let HTLC {
        id,
        sender: _,
        receiver,
        escrow,
        hashlock,
        timelock_ms,
        fee_bps,
        fee_recipient,
    } = htlc;

    // Withdraw is only valid WHILE now < timelock (matches EVM/Solana): after
    // the deadline only refund remains, removing the withdraw/refund race.
    assert!(clock.timestamp_ms() < timelock_ms, ETimelockExpired);
    assert!(hash::sha2_256(preimage) == hashlock, EInvalidPreimage);

    let htlc_id = id.to_inner();
    let mut bal = escrow;
    let amount = bal.value();
    let fee = (((amount as u128) * (fee_bps as u128)) / 10000u128) as u64;
    let payout = amount - fee;

    if (fee > 0) {
        transfer::public_transfer(coin::from_balance(bal.split(fee), ctx), fee_recipient);
    };
    transfer::public_transfer(coin::from_balance(bal, ctx), receiver);

    event::emit(Redeemed { htlc_id, preimage, payout, fee });
    id.delete();
}

/// Refund the full escrow to `sender` once the timelock has passed. No fee is
/// taken on a failed swap. Restricted to the recorded `sender` for parity with
/// the other legs; the funds could only ever return to `sender` regardless.
public entry fun refund<T>(htlc: HTLC<T>, clock: &Clock, ctx: &mut TxContext) {
    let HTLC {
        id,
        sender,
        receiver: _,
        escrow,
        hashlock: _,
        timelock_ms,
        fee_bps: _,
        fee_recipient: _,
    } = htlc;

    assert!(clock.timestamp_ms() >= timelock_ms, ETimelockNotExpired);
    assert!(ctx.sender() == sender, EWrongSender);

    let htlc_id = id.to_inner();
    let amount = escrow.value();
    transfer::public_transfer(coin::from_balance(escrow, ctx), sender);
    event::emit(Refunded { htlc_id, amount });
    id.delete();
}

// --- read-only accessors (handy for the relay/tests; the shared object is
//     also directly readable over RPC) ---

public fun amount<T>(h: &HTLC<T>): u64 { h.escrow.value() }

public fun hashlock<T>(h: &HTLC<T>): vector<u8> { h.hashlock }

public fun timelock_ms<T>(h: &HTLC<T>): u64 { h.timelock_ms }

public fun sender<T>(h: &HTLC<T>): address { h.sender }

public fun receiver<T>(h: &HTLC<T>): address { h.receiver }

public fun fee_bps<T>(h: &HTLC<T>): u16 { h.fee_bps }

public fun fee_recipient<T>(h: &HTLC<T>): address { h.fee_recipient }

/// Exposed so the relay/client can enforce the cap off-chain too.
public fun max_fee_bps(): u16 { MAX_FEE_BPS }
