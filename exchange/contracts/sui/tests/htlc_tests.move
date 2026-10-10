#[test_only]
module blockle_htlc::htlc_tests;

use blockle_htlc::htlc::{Self, HTLC};
use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario as ts;
use std::hash;

const MAKER: address = @0xA; // sender / depositor
const TAKER: address = @0xB; // receiver
const FEE: address = @0xFEE; // treasury fee recipient

const AMOUNT: u64 = 1_000_000;
const FEE_BPS: u16 = 10; // 0.1%
const T0: u64 = 1_000_000; // "now" in ms at lock time
const TIMELOCK: u64 = 2_000_000; // deadline in ms

// A fixed 32-byte preimage; the hashlock is derived with the SAME sha256 the
// module uses, so these tests prove the on-chain and off-chain hashes agree.
fun preimage(): vector<u8> {
    x"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
}

fun hashlock(): vector<u8> { hash::sha2_256(preimage()) }

fun fresh_clock(scenario: &mut ts::Scenario, now_ms: u64): clock::Clock {
    let mut c = clock::create_for_testing(ts::ctx(scenario));
    c.set_for_testing(now_ms);
    c
}

/// Lock the escrow as MAKER, leaving a shared HTLC<SUI> on the ledger.
fun do_lock(scenario: &mut ts::Scenario, clk: &clock::Clock) {
    let payment = coin::mint_for_testing<SUI>(AMOUNT, ts::ctx(scenario));
    htlc::lock<SUI>(payment, TAKER, hashlock(), TIMELOCK, FEE_BPS, FEE, clk, ts::ctx(scenario));
}

#[test]
fun lock_then_redeem_pays_receiver_and_fee() {
    let mut scenario = ts::begin(MAKER);
    let clk = fresh_clock(&mut scenario, T0);
    do_lock(&mut scenario, &clk);

    // Anyone may submit redeem; the receiver is fixed on-chain. Submit as TAKER.
    ts::next_tx(&mut scenario, TAKER);
    {
        let h = ts::take_shared<HTLC<SUI>>(&scenario);
        assert!(htlc::amount(&h) == AMOUNT, 100);
        htlc::redeem<SUI>(h, preimage(), &clk, ts::ctx(&mut scenario));
    };

    // Receiver got amount - fee.
    ts::next_tx(&mut scenario, TAKER);
    {
        let paid = ts::take_from_address<Coin<SUI>>(&scenario, TAKER);
        assert!(coin::value(&paid) == AMOUNT - 1_000, 101); // fee = 1e6*10/1e4 = 1000
        ts::return_to_address(TAKER, paid);
    };
    // Fee recipient got the fee.
    {
        let feecoin = ts::take_from_address<Coin<SUI>>(&scenario, FEE);
        assert!(coin::value(&feecoin) == 1_000, 102);
        ts::return_to_address(FEE, feecoin);
    };

    clk.destroy_for_testing();
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = 4, location = blockle_htlc::htlc)]
fun redeem_wrong_preimage_aborts() {
    let mut scenario = ts::begin(MAKER);
    let clk = fresh_clock(&mut scenario, T0);
    do_lock(&mut scenario, &clk);

    ts::next_tx(&mut scenario, TAKER);
    let h = ts::take_shared<HTLC<SUI>>(&scenario);
    htlc::redeem<SUI>(h, b"not the preimage", &clk, ts::ctx(&mut scenario));

    abort 0 // unreachable; redeem aborts first
}

#[test]
#[expected_failure(abort_code = 5, location = blockle_htlc::htlc)]
fun redeem_after_timelock_aborts() {
    let mut scenario = ts::begin(MAKER);
    let clk_lock = fresh_clock(&mut scenario, T0);
    do_lock(&mut scenario, &clk_lock);
    clk_lock.destroy_for_testing();

    ts::next_tx(&mut scenario, TAKER);
    let clk_late = fresh_clock(&mut scenario, TIMELOCK); // now == deadline: too late
    let h = ts::take_shared<HTLC<SUI>>(&scenario);
    htlc::redeem<SUI>(h, preimage(), &clk_late, ts::ctx(&mut scenario));

    abort 0
}

#[test]
fun refund_after_timelock_returns_full_amount() {
    let mut scenario = ts::begin(MAKER);
    let clk_lock = fresh_clock(&mut scenario, T0);
    do_lock(&mut scenario, &clk_lock);
    clk_lock.destroy_for_testing();

    // Sender refunds once the timelock has passed.
    ts::next_tx(&mut scenario, MAKER);
    {
        let clk_late = fresh_clock(&mut scenario, TIMELOCK + 1);
        let h = ts::take_shared<HTLC<SUI>>(&scenario);
        htlc::refund<SUI>(h, &clk_late, ts::ctx(&mut scenario));
        clk_late.destroy_for_testing();
    };

    ts::next_tx(&mut scenario, MAKER);
    {
        let back = ts::take_from_address<Coin<SUI>>(&scenario, MAKER);
        assert!(coin::value(&back) == AMOUNT, 200); // full amount, no fee
        ts::return_to_address(MAKER, back);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = 6, location = blockle_htlc::htlc)]
fun refund_before_timelock_aborts() {
    let mut scenario = ts::begin(MAKER);
    let clk = fresh_clock(&mut scenario, T0);
    do_lock(&mut scenario, &clk);

    ts::next_tx(&mut scenario, MAKER);
    let h = ts::take_shared<HTLC<SUI>>(&scenario);
    htlc::refund<SUI>(h, &clk, ts::ctx(&mut scenario)); // now < timelock

    abort 0
}

#[test]
#[expected_failure(abort_code = 7, location = blockle_htlc::htlc)]
fun refund_by_non_sender_aborts() {
    let mut scenario = ts::begin(MAKER);
    let clk_lock = fresh_clock(&mut scenario, T0);
    do_lock(&mut scenario, &clk_lock);
    clk_lock.destroy_for_testing();

    ts::next_tx(&mut scenario, TAKER); // TAKER is not the sender
    let clk_late = fresh_clock(&mut scenario, TIMELOCK + 1);
    let h = ts::take_shared<HTLC<SUI>>(&scenario);
    htlc::refund<SUI>(h, &clk_late, ts::ctx(&mut scenario));

    abort 0
}

#[test]
#[expected_failure(abort_code = 3, location = blockle_htlc::htlc)]
fun lock_fee_above_cap_aborts() {
    let mut scenario = ts::begin(MAKER);
    let clk = fresh_clock(&mut scenario, T0);
    let payment = coin::mint_for_testing<SUI>(AMOUNT, ts::ctx(&mut scenario));
    htlc::lock<SUI>(payment, TAKER, hashlock(), TIMELOCK, 101, FEE, &clk, ts::ctx(&mut scenario));

    abort 0
}
