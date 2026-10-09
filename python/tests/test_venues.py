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
