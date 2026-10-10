"""Regression locks for the agent-trading audit fixes.

- swap FAILS CLOSED when no venue registry is wired (no fee-free commit path).
- buy_block REJECTS an x402 challenge that demands more / a different asset than
  the confirmed amount.
- a FAILED fee transfer is NOT counted as spend and is surfaced as 'fee_failed'.
- a fee paid in a DIFFERENT asset is cap-pre-checked against its own per-asset cap.
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import audit as audit_mod
from blockle.agent import policy as policy_mod
from blockle.agent import runner as runner_mod
from blockle.agent import tools as tools_mod
from blockle.agent.policy import CapExceeded


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------- swap fallback fail-closed

def test_swap_without_venue_registry_fails_closed():
    reg = tools_mod.build({})  # no venues wired
    swap = reg.get("swap")
    with pytest.raises(ValueError, match="fail closed"):
        run(swap["prepare"]({"from": "USDC", "to": "WETH", "amount": "1000000"}))


# ----------------------------------------------- buy_block x402 challenge guard

def _buy_ctx(challenge, paid=True):
    state = {"paid": []}

    async def buy_block(usdc, *rest):
        if not rest or rest == (None,):
            return {"paymentRequired": True, "challenge": challenge}
        return {"settled": True}

    async def pay_x402(ch):
        state["paid"].append(ch)
        return {"paymentTxid": "0xpay", "chain": "base"} if paid else None

    ctx = {"exchange": {"buyBlock": buy_block}, "payX402Usdc": pay_x402}
    return ctx, state


def test_buy_block_rejects_overcharging_challenge():
    # confirmed 1_000_000 USDC but the seller's challenge demands 2_000_000 -> reject
    ctx, state = _buy_ctx({"amount": "2000000", "asset": "USDC"})
    reg = tools_mod.build(ctx)
    prep = run(reg.get("buy_block")["prepare"]({"usdc": "1000000"}))
    with pytest.raises(ValueError, match="more USDC"):
        run(prep["commit"]())
    assert state["paid"] == []  # never paid the oversized challenge


def test_buy_block_rejects_non_usdc_challenge():
    ctx, state = _buy_ctx({"amount": "1000000", "asset": "DAI"})
    reg = tools_mod.build(ctx)
    prep = run(reg.get("buy_block")["prepare"]({"usdc": "1000000"}))
    with pytest.raises(ValueError, match="non-USDC"):
        run(prep["commit"]())
    assert state["paid"] == []


def test_buy_block_settles_matching_challenge():
    ctx, state = _buy_ctx({"amount": "1000000", "asset": "USDC"})
    reg = tools_mod.build(ctx)
    prep = run(reg.get("buy_block")["prepare"]({"usdc": "1000000"}))
    res = run(prep["commit"]())
    assert res["paid"] is True and res["paymentTxid"] == "0xpay"
    assert len(state["paid"]) == 1  # the in-bounds challenge was settled


# ----------------------------------------- failed fee is not recorded as spend

def _prep_with_fee(fee_commit, fee_value=None):
    committed = {"trade": 0, "fee": 0}

    async def commit():
        committed["trade"] += 1
        return {"txid": "0xtrade"}

    prep = {
        "summary": {"action": "swap"},
        "value": {"asset": "USDC", "amount": "1000000", "usd": 10.0},
        "commit": commit,
        "fee": {"bps": 5, "chain": "base", "asset": "BLOCK", "amount": "500", "treasury": "0xt"},
        "feeValue": fee_value or {"asset": "BLOCK", "amount": "500", "usd": 0.01},
        "commitFee": fee_commit,
    }
    return prep, committed


def test_failed_fee_transfer_not_counted_as_spend_and_surfaced():
    async def failing_fee():
        raise RuntimeError("treasury unreachable")

    prep, committed = _prep_with_fee(failing_fee)
    audit = audit_mod.create({})
    policy = policy_mod.create({"audit": audit, "requireConfirm": False})

    disp = run(runner_mod.dispatch_prepared(policy, audit, None, "swap", prep))
    assert disp["approved"] is True
    assert committed["trade"] == 1                    # the trade DID execute
    # only the trade's $10 is spent; the failed fee is NOT accrued
    assert policy.spent_usd == 10.0
    assert policy.spent_by_asset.get("BLOCK", 0) == 0
    types = [e.get("type") for e in audit.list()]
    assert "fee_failed" in types


def test_fee_with_no_txid_treated_as_failed():
    async def no_txid_fee():
        return {"ok": True}  # committed but returned no txid

    prep, committed = _prep_with_fee(no_txid_fee)
    audit = audit_mod.create({})
    policy = policy_mod.create({"audit": audit, "requireConfirm": False})
    run(runner_mod.dispatch_prepared(policy, audit, None, "swap", prep))
    assert policy.spent_by_asset.get("BLOCK", 0) == 0
    assert "fee_failed" in [e.get("type") for e in audit.list()]


# ------------------------------------- cross-asset fee gets its own cap check

def test_cross_asset_fee_is_cap_pre_checked():
    async def ok_fee():
        return {"txid": "0xfee"}

    # fee is 500 base units of BLOCK, but the BLOCK per-asset cap is 100 -> the
    # fee leg (different asset than the USDC trade) must be rejected up front.
    prep, committed = _prep_with_fee(ok_fee)
    audit = audit_mod.create({})
    policy = policy_mod.create({"caps": {"perAsset": {"BLOCK": "100"}}, "audit": audit})

    with pytest.raises(CapExceeded):
        run(runner_mod.dispatch_prepared(policy, audit, None, "swap", prep))
    assert committed["trade"] == 0  # nothing committed — blocked before commit
