"""Venue-registry tests: exact 0.05% fee math, per-chain treasury routing, and
the fail-closed guarantee when a trade's chain has no treasury address.

Mirrors blockle-extension/venues.test.js. The treasury fixture uses the SAME
mainnet addresses shipped in exchange/treasury.json.
"""

from __future__ import annotations

import asyncio
import json
import pathlib

import pytest

from blockle.multichain import venues as V


def run(coro):
    return asyncio.run(coro)


# exchange/treasury.json as shipped (public receiving addresses only)
TREASURY = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "exchange" / "treasury.json").read_text())

MAINNET = TREASURY["mainnet"]


# ------------------------------------------------------------------ pure math


def test_fee_amount_5bps_exact():
    # 5 bps = 0.05% ; floor division, exact integer math
    assert V.fee_amount("1000000", 5) == 500
    assert V.fee_amount("1000000000000000000", 5) == 500000000000000  # 1 ETH -> 0.0005 ETH
    assert V.fee_amount("19999", 5) == 9        # floor(19999*5/10000)=9
    assert V.fee_amount("0", 5) == 0


def test_fee_amount_rejects_negative_bps():
    with pytest.raises(ValueError):
        V.fee_amount("1000", -1)


def test_fee_amount_requires_integer_string():
    with pytest.raises(ValueError):
        V.fee_amount("1.5", 5)


def test_apply_slippage_half_pct_default_style():
    # 1% slippage keeps 99%
    assert V.apply_slippage("1000000", 0.01) == "990000"
    # zero / non-finite slippage returns the amount unchanged
    assert V.apply_slippage("1000000", 0) == "1000000"
    assert V.apply_slippage("1000000", None) == "1000000"


def test_amm_quote_constant_product():
    # pool 1000 in / 1000 out, 30 bps fee, swap 100 in
    # inAfterFee = 100*9970/10000 = 99 ; out = 1000*99/(1000+99) = 90
    assert V.amm_quote("100", "1000", "1000", 30) == "90"
    assert V.amm_quote("0", "1000", "1000", 30) == "0"


def test_norm_chain_and_treasury_key_aliases():
    assert V.norm_chain("eth") == "ethereum"
    assert V.norm_chain("BLOCKLE") == "block"
    assert V.treasury_key("btc") == "btc"
    assert V.treasury_key("bitcoin") == "btc"
    assert V.treasury_key("base") == "base"


# ----------------------------------------------------- treasury fee routing


def test_treasury_fee_bps_from_treasury_json():
    t = V.make_treasury(TREASURY)
    assert t.fee_bps == 5  # agentTradeFeeBps


def test_fee_routed_to_correct_chain_address():
    t = V.make_treasury(TREASURY)
    # EVM / Base / ERC-20 -> the base/ethereum treasury address
    ev = t.fee_for("ethereum", "1000000", "USDT")
    assert ev["treasury"] == MAINNET["ethereum"]
    assert ev["amount"] == "500" and ev["bps"] == 5 and ev["chain"] == "ethereum"
    base = t.fee_for("base", "1000000", "USDC")
    assert base["treasury"] == MAINNET["base"]
    # Solana -> the solana treasury address
    sol = t.fee_for("solana", "2000000", "SOL")
    assert sol["treasury"] == MAINNET["solana"]
    assert sol["amount"] == "1000"
    # Bitcoin maps to the btc key
    btc = t.fee_for("bitcoin", "100000000", "BTC")
    assert btc["treasury"] == MAINNET["btc"]


def test_fee_transfer_shape():
    t = V.make_treasury(TREASURY)
    fee = t.fee_for("base", "1000000", "USDC")
    xfer = V.fee_transfer(fee)
    assert xfer == {"chain": "base", "to": MAINNET["base"], "amount": "500", "asset": "USDC"}


# ------------------------------------------------------------- FAIL-CLOSED


def test_fail_closed_no_address_for_chain():
    # a treasury with only a base address must REFUSE to route a solana fee
    t = V.make_treasury({"agentTradeFeeBps": 5, "mainnet": {"base": MAINNET["base"]}})
    t.fee_for("base", "1000000", "USDC")  # OK
    with pytest.raises(ValueError, match="fail-closed"):
        t.fee_for("solana", "1000000", "SOL")


def test_evmdex_build_swap_fails_closed_without_treasury():
    """A real venue.build_swap must raise (not skip the fee) when the trade's
    chain has no treasury address — the swap cannot be built at all."""
    reg = V.create({
        "treasury": {"agentTradeFeeBps": 5, "mainnet": {}},  # no addresses at all
        "evmdex": {"baseUrl": "https://dex.example",
                   "request": lambda req: {"buyAmount": "990000", "to": "0xr", "data": "0x", "value": "0"}},
        "jupiter": {"enabled": False},
    })
    venue = reg.get("evmdex")
    with pytest.raises(ValueError, match="fail-closed"):
        run(venue.build_swap({"from": "USDC", "to": "WETH", "amount": "1000000", "chain": "base"}))


# ----------------------------------------------- registry + venue behaviour


def test_registry_lists_three_venues_and_routes_by_chain():
    reg = V.create({"treasury": TREASURY})
    assert reg.ids() == ["blockle", "evmdex", "jupiter"]
    assert reg.fee_bps if hasattr(reg, "fee_bps") else True  # (guard; see below)
    assert reg.fee_bps == 5
    assert [v.id for v in reg.for_chain("base")] == ["evmdex"]
    assert [v.id for v in reg.for_chain("solana")] == ["jupiter"]
    assert [v.id for v in reg.for_chain("block")] == ["blockle"]


def test_evmdex_quote_and_build_include_fee():
    captured = {}

    def fake_request(req):
        captured["url"] = req["url"]
        return {"buyAmount": "990000", "price": "0.99", "to": "0xrouter",
                "data": "0xabcdef", "value": "0", "allowanceTarget": "0xspender"}

    reg = V.create({
        "treasury": TREASURY,
        "evmdex": {"baseUrl": "https://dex.example", "chains": ["base", "ethereum"],
                   "request": fake_request},
        "jupiter": {"enabled": False},
    })
    venue = reg.get("evmdex")
    q = run(venue.quote("USDC", "WETH", "1000000", {"chain": "base", "slippage": 0.01}))
    assert q["amountOut"] == "990000" and q["minOut"] == "980100"
    assert q["fee"]["treasury"] == MAINNET["base"] and q["fee"]["amount"] == "500"

    built = run(venue.build_swap({"from": "USDC", "to": "WETH", "amount": "1000000", "chain": "base"}))
    assert built["tx"] == {"chain": "base", "to": "0xrouter", "data": "0xabcdef", "value": "0"}
    assert built["feeTransfer"]["to"] == MAINNET["base"]
    assert built["feeTransfer"]["amount"] == "500"
    assert built["autoSend"] is False  # NEVER auto-broadcast


def test_blockle_venue_prices_via_amm_and_routes_block_fee():
    # give the block chain a treasury address so the fee can route
    treasury = {"agentTradeFeeBps": 5, "mainnet": dict(MAINNET, block="block1qtreasuryxyz")}

    async def reserves(frm, to):
        return {"reserveIn": "1000000", "reserveOut": "1000000", "poolFeeBps": 30}

    reg = V.create({
        "treasury": treasury,
        "blockle": {"amm": {"reserves": reserves}},
        "evmdex": {"enabled": False}, "jupiter": {"enabled": False},
    })
    venue = reg.get("blockle")
    q = run(venue.quote("BLOCK", "USDC", "100000", {"slippage": 0.005}))
    assert q["chain"] == "block"
    assert q["fee"]["treasury"] == "block1qtreasuryxyz"
    assert q["fee"]["amount"] == "50"  # 100000 * 5bps
    built = run(venue.build_swap({"from": "BLOCK", "to": "USDC", "amount": "100000"}))
    assert built["intent"]["kind"] == "exchange-swap"
    assert built["autoSend"] is False


def test_jupiter_requires_account_for_build():
    reg = V.create({
        "treasury": TREASURY,
        "jupiter": {"baseUrl": "https://jup.example", "request": lambda req: {"outAmount": "1"}},
        "evmdex": {"enabled": False},
    })
    venue = reg.get("jupiter")
    with pytest.raises(ValueError, match="requires account"):
        run(venue.build_swap({"from": "SOL", "to": "USDC", "amount": "1000000"}))


# ------------------------------------------------- fee-aware routing (levers 1+2)
# Shared vectors ported from blockle-extension/venues.test.js — the Python port
# must match the reference behavior exactly.


def test_price_impact_bps_constant_product_depth():
    # 1000 in against a 1,000,000 reserve -> 1000/1001000 ≈ 9.99 bps
    assert abs(V.price_impact_bps("1000", "1000000") - (1000 / 1001000) * 1e4) < 1e-9
    assert V.price_impact_bps("0", "1000000") == 0      # no size -> no impact
    assert V.price_impact_bps("1000", "0") == 0         # no depth -> fail-open 0


def test_route_cost_bps_all_in_fee_impact_gas():
    # 30 bps pool fee + 10 bps impact + $2 gas over $2000 notional (10 bps) = 50 bps
    assert V.route_cost_bps({"feeBps": 30, "priceImpactBps": 10,
                             "gasUsd": 2, "notionalUsd": 2000}) == 50
    assert V.route_cost_bps({"feeBps": 10}) == 10       # internal rail: fee only
    assert V.route_cost_bps({"feeBps": 30, "gasUsd": 5}) == 30  # gas w/o notional ignored


def test_choose_route_picks_lowest_all_in_cost_not_best_nominal():
    r = V.choose_route([
        {"id": "extAMM", "feeBps": 30, "gasUsd": 2, "notionalUsd": 2000},  # 30 + 10 = 40
        {"id": "stable", "feeBps": 6, "gasUsd": 2, "notionalUsd": 2000},   # 6 + 10 = 16
        {"id": "blockle", "internal": True, "feeBps": 10, "gasUsd": 0},    # 10, no gas
    ])
    assert r["venue"] == "blockle"               # 10 bps beats 16 and 40
    assert r["effectiveCostBps"] == 10
    assert r["roundTripCostBps"] == 20           # 2x one-leg (no gas)
    assert r["internal"] is True


def test_choose_route_internal_preference_only_when_it_can_fill():
    r = V.choose_route([
        {"id": "blockle", "internal": True, "feeBps": 10, "gasUsd": 0, "canFill": False},
        {"id": "stable", "feeBps": 8, "gasUsd": 2, "notionalUsd": 2000},   # 8 + 10 = 18
        {"id": "extAMM", "feeBps": 30, "gasUsd": 2, "notionalUsd": 2000},  # 40
    ])
    assert r["venue"] == "stable"                # internal skipped (no fill)
    assert r["internal"] is False


def test_choose_route_internal_wins_a_cost_tie():
    r = V.choose_route([
        {"id": "extAMM", "feeBps": 10, "gasUsd": 0},
        {"id": "blockle", "internal": True, "feeBps": 10, "gasUsd": 0},
    ])
    assert r["venue"] == "blockle"


def test_choose_route_no_fillable_route_returns_none_and_inf():
    r = V.choose_route([{"id": "blockle", "internal": True, "feeBps": 10, "canFill": False}])
    assert r["chosen"] is None
    assert r["effectiveCostBps"] == float("inf")
    assert r["reason"] == "no-fillable-route"


def test_blockle_venue_internal_flag_fee_and_exposed_effective_cost():
    reg = V.create({
        "treasury": TREASURY,
        "blockle": {"exchange": {"quote": lambda *a, **k: {"amountOut": "4200"}},
                    "assetChain": {"USDC": "base"}},
    })
    bl = reg.get("blockle")
    assert bl.internal is True
    assert bl.feeBps == 10
    q = run(bl.quote("USDC", "BLOCK", "1000000", {}))
    assert q["internal"] is True
    assert q["feeBps"] == 10
    assert q["effectiveCostBps"] == 10   # no reserves wired -> fee only, no impact


def test_blockle_venue_can_fill_is_real_never_assumed():
    yes = V.create({"treasury": TREASURY,
                    "blockle": {"canFill": lambda *a, **k: True}}).get("blockle")
    assert run(yes.can_fill("USDC", "BLOCK", "1000000", {})) is True
    no = V.create({"treasury": TREASURY,
                   "blockle": {"canFill": lambda *a, **k: False}}).get("blockle")
    assert run(no.can_fill("USDC", "BLOCK", "1000000", {})) is False
    # nothing wired -> fail CLOSED (no internal liquidity to assume)
    bare = V.create({"treasury": TREASURY,
                     "blockle": {"amm": {"reserves": lambda *a, **k: {"reserveIn": "1", "reserveOut": "1"}}}}).get("blockle")
    assert run(bare.can_fill("USDC", "BLOCK", "1", {})) is False


def test_registry_exposes_shared_choose_route():
    reg = V.create({"treasury": TREASURY})
    assert callable(reg.choose_route)
    assert reg.choose_route([{"id": "a", "feeBps": 5}, {"id": "b", "feeBps": 9}])["venue"] == "a"
