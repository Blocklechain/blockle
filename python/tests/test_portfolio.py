"""test_portfolio.py — WALLET PORTFOLIO net worth + daily snapshot (§1/§2.1).

Run: cd python && python -m pytest tests/test_portfolio.py -q

Asserts the Python port (``blockle/multichain/portfolio.py``) against the
AUTHORITATIVE shared fixture ``docs/portfolio-vectors.json`` (the exact
micro-dollar aggregation the JS reference + Dart port reproduce identically)
plus unit tests for the integer money math, the never-guess unpriced rule, and
the append-only dedup-by-day snapshot store.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from blockle.multichain import portfolio as P

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "docs" / "portfolio-vectors.json").read_text())


def run(coro):
    return asyncio.run(coro)


# build the injected ctx from the PLAIN netWorth fixture (no functions stored).
def nw_ctx(nw):
    async def get_holdings(chain, address=None):
        return nw["holdingsByChain"].get(chain, [])
    return {"asOf": nw["asOf"], "priceUsd": nw["priceUsd"], "getHoldings": get_holdings}


# ===========================================================================
# 1. CANONICAL NET-WORTH VECTOR — exact micro-dollar total + byChain bps
# ===========================================================================
def test_vector_net_worth_aggregates_priced_excludes_unpriced_exact_micro():
    nw = VECTORS["netWorth"]
    pf = run(P.portfolio(nw["accounts"], nw_ctx(nw)))
    e = nw["expect"]

    assert pf["totalUsdMicro"] == e["totalUsdMicro"], "exact micro-dollar total"
    assert pf["totalUsd"] == e["totalUsd"], "convenience dollar total"
    assert pf["asOf"] == nw["asOf"], "injected asOf echoed, never a clock call"

    # byChain: value + basis points of total, value-desc order
    assert len(pf["byChain"]) == len(e["byChain"]), "byChain chain count (unpriced chain absent)"
    for i in range(len(e["byChain"])):
        assert pf["byChain"][i]["chain"] == e["byChain"][i]["chain"]
        assert pf["byChain"][i]["usdMicro"] == e["byChain"][i]["usdMicro"]
        assert pf["byChain"][i]["pctBps"] == e["byChain"][i]["pctBps"]
    # basis points sum to 10000 across priced chains (exact split, no drift)
    assert sum(c["pctBps"] for c in pf["byChain"]) == 10000, "pct basis points sum to 100%"

    # priced holdings in value order with exact per-holding micro-dollars
    priced = [h for h in pf["holdings"] if h["pricedOk"]]
    assert len(priced) == len(e["holdings"])
    for i in range(len(e["holdings"])):
        assert priced[i]["chain"] == e["holdings"][i]["chain"]
        assert priced[i]["symbol"] == e["holdings"][i]["symbol"]
        assert priced[i]["usdMicro"] == e["holdings"][i]["usdMicro"]

    # the unpriced holding is SHOWN but NEVER counted and NEVER guessed as 0
    assert len(pf["unpriced"]) == len(e["unpriced"])
    assert pf["unpriced"][0]["chain"] == e["unpriced"][0]["chain"]
    assert pf["unpriced"][0]["symbol"] == e["unpriced"][0]["symbol"]
    assert pf["unpriced"][0]["amountBase"] == e["unpriced"][0]["amountBase"]
    unpriced_in_holdings = next(h for h in pf["holdings"] if not h["pricedOk"])
    assert unpriced_in_holdings["usdMicro"] is None, "unpriced holding has null usd (not 0)"


# ===========================================================================
# integer money math — int exact, half-away-from-zero, never a float guess
# ===========================================================================
def test_micro_usd_round_half_away_from_zero():
    assert P.micro_usd(2000) == 2000000000
    assert P.micro_usd(0.5) == 500000
    assert P.micro_usd(1) == 1000000
    assert P.micro_usd(None) is None, "unknown price stays null (never 0)"


def test_holding_micro_exact_base_unit_to_micro_dollar():
    assert str(P.holding_micro("1000000000000000000", 18, 2000)) == "2000000000"
    assert str(P.holding_micro("500000000", 6, 1)) == "500000000"
    assert str(P.holding_micro("1000000000", 8, 0.5)) == "5000000"
    assert P.holding_micro("123", 6, None) is None, "no price => null, not zero"


def test_portfolio_all_unpriced_wallet_is_total_zero_no_fabrication():
    async def get_holdings(chain, address=None):
        return [{"asset": {"symbol": "XYZ", "decimals": 6}, "confirmed": "5"}]
    pf = run(P.portfolio([{"chain": "solana", "address": "x"}],
                         {"priceUsd": {}, "getHoldings": get_holdings}))
    assert pf["totalUsdMicro"] == "0"
    assert len(pf["byChain"]) == 0
    assert len(pf["unpriced"]) == 1


# ===========================================================================
# §2.1 DAILY SNAPSHOT STORE — append-only, dedup by UTC day, injected clock
# ===========================================================================
def test_vector_snapshot_store_dedups_by_day():
    ss = VECTORS["snapshotStore"]
    hist = list(ss["start"])
    for a in ss["appends"]:
        hist = P.record_snapshot(hist, a)
    assert len(hist) == len(ss["expect"]["points"]), "one point per distinct day"
    for i in range(len(ss["expect"]["points"])):
        assert hist[i]["day"] == ss["expect"]["points"][i]["day"]
        assert hist[i]["totalUsdMicro"] == ss["expect"]["points"][i]["totalUsdMicro"]


def test_record_snapshot_pure_never_mutates_and_sorted():
    h0 = []
    h1 = P.record_snapshot(h0, {"ts": 1700100000000, "totalUsdMicro": "10"})
    h2 = P.record_snapshot(h1, {"ts": 1700000000000, "totalUsdMicro": "20"})
    assert len(h0) == 0, "input untouched"
    assert len(h1) == 1
    assert len(h2) == 2
    assert h2[0]["ts"] < h2[1]["ts"], "sorted ascending by ts"


def test_sparkline_last_n_points():
    hist = []
    for d in range(40):
        hist = P.record_snapshot(hist, {"ts": d * P.DAY_MS, "totalUsdMicro": str(d * 1000000)})
    sp = P.sparkline(hist, 30)
    assert len(sp) == 30
    assert sp[-1]["usd"] == 39, "last point in dollars"
    assert sp[0]["totalUsdMicro"] == "10000000"
