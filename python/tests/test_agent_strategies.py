"""Strategy-planner tests for the in-wallet agent.

Covers each of the five strategies (arbitrage / dca / grid / rebalance /
momentum) per docs/AGENT-STRATEGIES.md §6, plus a cross-language PARITY check:
every case in the shared ``docs/strategy-vectors.json`` oracle is replayed
through ``Strategy.plan`` and the decision-relevant fields of each Intent must
match the frozen expectations exactly. Strategies are pure PLANNERS — plan is
read-only and the ctx exposes no commit.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from blockle.agent import strategies as S

VECTORS = Path(__file__).resolve().parents[2] / "docs" / "strategy-vectors.json"


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# ctx built from a shared-fixture market snapshot                             #
# --------------------------------------------------------------------------- #

def build_ctx(case):
    ctx = {}
    if "prices" in case:
        pr = case["prices"]
        ctx["prices"] = lambda syms, pr=pr: {s: pr.get(s) for s in syms}
    ctx["mainnet"] = case.get("mainnet", False)
    if "now" in case:
        ctx["now"] = lambda n=case["now"]: n
    if "venues" in case:
        ctx["listVenues"] = lambda pair, v=case["venues"]: list(v)
    if "book" in case:
        ctx["getBook"] = lambda market, b=case["book"]: b
    if "openOrders" in case:
        ctx["openOrders"] = lambda market, o=case["openOrders"]: o
    if "balances" in case:
        ctx["getBalance"] = lambda chain, toks, b=case["balances"]: b
    # optional test-only hooks
    if "venueQuotes" in case:
        vq = case["venueQuotes"]
        ctx["venueQuote"] = lambda venue, pair, probe, vq=vq: vq.get(venue)
    if "venueTool" in case:
        vt = case["venueTool"]
        ctx["venueTool"] = lambda venue, side, vt=vt: vt.get(venue)
    return ctx


def flat(intent):
    """Flatten an Intent to {tool, **args, estUsd} for fixture comparison."""
    out = {"tool": intent["tool"], "estUsd": intent["estUsd"]}
    out.update(intent["args"])
    return out


# --------------------------------------------------------------------------- #
# cross-language parity oracle                                                #
# --------------------------------------------------------------------------- #

def _load_cases():
    data = json.loads(VECTORS.read_text())
    cases = []
    for strat_name, group in data.items():
        if strat_name.startswith("_") or not isinstance(group, dict):
            continue
        for case_name, case in group.items():
            if not isinstance(case, dict) or "expect" not in case:
                continue
            cases.append((strat_name, case_name, case))
    return cases


@pytest.mark.parametrize("strat_name,case_name,case", _load_cases(),
                         ids=lambda v: v if isinstance(v, str) else "")
def test_strategy_vectors_parity(strat_name, case_name, case):
    strat = S.default_registry().get(strat_name)
    params = strat.validate_params(case["params"])
    intents = run(strat.plan(build_ctx(case), params))
    expected = case["expect"]["intents"]
    assert len(intents) == len(expected), (strat_name, case_name, [flat(i) for i in intents])
    for got, exp in zip(intents, expected):
        f = flat(got)
        for k, v in exp.items():
            assert f.get(k) == v, (strat_name, case_name, k, f.get(k), v, f)


# --------------------------------------------------------------------------- #
# arbitrage                                                                   #
# --------------------------------------------------------------------------- #

def _arb_case(va, vb, params=None):
    base = {"pair": "ETH/USDC", "minEdgeBps": 30, "maxNotionalUsd": 1000,
            "gasBufferUsd": 1, "slippageBps": 5, "agentFeeBps": 5}
    base.update(params or {})
    return {"params": base, "prices": {"USDC": 1}, "venues": [va, vb]}


def _v(vid, ask, bid, feeBps=10, mainnet=False):
    return {"id": vid, "chain": "ethereum", "mainnet": mainnet, "ask": ask, "bid": bid,
            "feeBps": feeBps, "depthBase": "1000000000000000000000"}


def test_arbitrage_emits_balanced_two_leg_pair():
    case = _arb_case(_v("dexA", "2000", "1999"), _v("dexB", "2010", "2030"))
    strat = S.Arbitrage()
    intents = run(strat.plan(build_ctx(case), strat.validate_params(case["params"])))
    assert len(intents) == 2
    buy, sell = intents
    assert buy["args"]["from"] == "USDC" and buy["args"]["to"] == "ETH"
    assert buy["args"]["venue"] == "dexA"
    assert sell["args"]["from"] == "ETH" and sell["args"]["to"] == "USDC"
    assert sell["args"]["venue"] == "dexB"
    assert buy["group"] == sell["group"]           # one tagged pair
    assert buy["estUsd"] == sell["estUsd"] == 1000.0


def test_arbitrage_refuses_when_net_edge_below_threshold():
    # +30 bps gross but 40+40 venue fees + agent + slippage + gas -> net < 30.
    case = _arb_case(_v("dexA", "2000", "1999", feeBps=40), _v("dexB", "2005", "2006", feeBps=40))
    strat = S.Arbitrage()
    assert run(strat.plan(build_ctx(case), strat.validate_params(case["params"]))) == []


def test_arbitrage_single_best_venue_no_edge():
    # dexA has both the lowest ask AND the highest bid -> same venue -> no arb.
    case = _arb_case(_v("dexA", "2000", "2050"), _v("dexB", "2100", "2010"))
    strat = S.Arbitrage()
    assert run(strat.plan(build_ctx(case), strat.validate_params(case["params"]))) == []


def test_arbitrage_skips_unquotable_venue():
    case = _arb_case(_v("dexA", "2000", "2030"), {"id": "dexB"})  # dexB can't quote
    strat = S.Arbitrage()
    assert run(strat.plan(build_ctx(case), strat.validate_params(case["params"]))) == []


def test_arbitrage_marks_mainnet_from_venue_flag():
    case = _arb_case(_v("dexA", "2000", "1999", mainnet=True),
                     _v("dexB", "2010", "2030", mainnet=True))
    strat = S.Arbitrage()
    intents = run(strat.plan(build_ctx(case), strat.validate_params(case["params"])))
    assert all(i["mainnet"] is True for i in intents)


def test_arbitrage_venue_tool_hook_routes_native_rail():
    case = _arb_case(_v("blockle", "2000", "1999"), _v("dexB", "2010", "2030"))
    case["venueTool"] = {"blockle": "buy_block"}
    strat = S.Arbitrage()
    intents = run(strat.plan(build_ctx(case), strat.validate_params(case["params"])))
    assert intents[0]["tool"] == "buy_block" and "usdc" in intents[0]["args"]
    assert intents[1]["tool"] == "swap"


# --------------------------------------------------------------------------- #
# dca                                                                         #
# --------------------------------------------------------------------------- #

def test_dca_fires_once_after_interval():
    strat = S.Dca()
    params = strat.validate_params({"asset": "BLOCK", "intervalSec": 86400, "lastRunAt": 0})
    ctx = {"mainnet": False, "prices": lambda s: {"USDC": 1.0}, "now": lambda: 86400000}
    intents = run(strat.plan(ctx, params))
    assert len(intents) == 1 and intents[0]["args"]["amount"] == "10000000"


def test_dca_silent_before_interval_elapses():
    strat = S.Dca()
    params = strat.validate_params({"asset": "BLOCK", "intervalSec": 86400, "lastRunAt": 0})
    ctx = {"mainnet": False, "prices": lambda s: {"USDC": 1.0}, "now": lambda: 86399999}
    assert run(strat.plan(ctx, params)) == []


def test_dca_no_price_emits_nothing():
    strat = S.Dca()
    params = strat.validate_params({"asset": "BLOCK"})
    ctx = {"mainnet": False, "prices": lambda s: {}, "now": lambda: 10 ** 13}
    assert run(strat.plan(ctx, params)) == []  # never fabricate a price


# --------------------------------------------------------------------------- #
# grid                                                                        #
# --------------------------------------------------------------------------- #

def _grid_case(open_orders=None, levels=4, step=100):
    return {"params": {"market": "BLOCK/USDC", "levels": levels, "stepBps": step,
                       "sizeUsdPerLevel": 10},
            "prices": {"USDC": 1},
            "book": {"bids": [{"price": "0.99"}], "asks": [{"price": "1.01"}]},
            "openOrders": open_orders or []}


def test_grid_buys_first_then_sells_symmetric():
    case = _grid_case()
    strat = S.Grid()
    intents = run(strat.plan(build_ctx(case), strat.validate_params(case["params"])))
    sides = [i["args"]["side"] for i in intents]
    assert sides == ["buy", "buy", "sell", "sell"]          # all buys, then all sells
    prices = [i["args"]["price"] for i in intents]
    assert prices == ["0.99", "0.98", "1.01", "1.02"]
    assert all(i["tool"] == "place_order" and i["args"]["type"] == "limit" for i in intents)


def test_grid_skips_occupied_level():
    case = _grid_case([{"side": "buy", "price": "0.99"}])
    strat = S.Grid()
    intents = run(strat.plan(build_ctx(case), strat.validate_params(case["params"])))
    assert [i["args"]["price"] for i in intents] == ["0.98", "1.01", "1.02"]


def test_grid_clamps_levels_and_never_market_orders():
    assert S.Grid().validate_params({"market": "A/B", "levels": 99})["levels"] == 20
    assert S.Grid().validate_params({"market": "A/B", "levels": 1})["levels"] == 2


# --------------------------------------------------------------------------- #
# rebalance                                                                   #
# --------------------------------------------------------------------------- #

def _bal(sym, dec, amt, chain="block"):
    return {"asset": {"symbol": sym, "decimals": dec, "chain": chain}, "confirmed": amt}


def test_rebalance_sells_overweight_half_the_gap():
    strat = S.Rebalance()
    params = strat.validate_params({"targets": {"BLOCK": 0.5, "USDC": 0.5}, "maxTradeUsd": 1000})
    ctx = {"mainnet": False, "prices": lambda s: {"BLOCK": 1, "USDC": 1},
           "getBalance": lambda c, t: [_bal("BLOCK", 8, "7000000000"),
                                       _bal("USDC", 6, "30000000", "base")]}
    intents = run(strat.plan(ctx, params))
    assert len(intents) == 1
    assert intents[0]["args"] == {"from": "BLOCK", "to": "USDC", "amount": "1000000000"}
    assert intents[0]["estUsd"] == 10.0


def test_rebalance_buys_underweight():
    strat = S.Rebalance()
    params = strat.validate_params({"targets": {"BLOCK": 0.5, "ETH": 0.5}, "maxTradeUsd": 1000})
    ctx = {"mainnet": False, "prices": lambda s: {"BLOCK": 1, "ETH": 1, "USDC": 1},
           "getBalance": lambda c, t: [_bal("BLOCK", 8, "2000000000"),
                                       _bal("ETH", 18, "80" + "0" * 18, "ethereum")]}
    intents = run(strat.plan(ctx, params))
    tags = {i["tag"]: i for i in intents}
    assert tags["rebal:BLOCK"]["args"]["from"] == "USDC"   # buy the underweight asset
    assert tags["rebal:BLOCK"]["args"]["to"] == "BLOCK"


def test_rebalance_in_band_is_noop():
    strat = S.Rebalance()
    params = strat.validate_params({"targets": {"BLOCK": 0.5, "USDC": 0.5}, "bandBps": 500})
    ctx = {"mainnet": False, "prices": lambda s: {"BLOCK": 1, "USDC": 1},
           "getBalance": lambda c, t: [_bal("BLOCK", 8, "5100000000"),
                                       _bal("USDC", 6, "49000000", "base")]}
    assert run(strat.plan(ctx, params)) == []


# --------------------------------------------------------------------------- #
# momentum                                                                    #
# --------------------------------------------------------------------------- #

def test_momentum_buys_on_golden_cross():
    strat = S.Momentum()
    params = strat.validate_params({"market": "BLOCK/USDC", "shortN": 2, "longN": 3,
                                    "tradeUsd": 20, "history": [1, 1, 1, 1, 2]})
    ctx = {"mainnet": False, "prices": lambda s: {"BLOCK": 1, "USDC": 1}}
    intents = run(strat.plan(ctx, params))
    assert len(intents) == 1
    assert intents[0]["args"] == {"from": "USDC", "to": "BLOCK", "amount": "20000000"}


def test_momentum_sells_only_what_is_held_on_death_cross():
    strat = S.Momentum()
    params = strat.validate_params({"market": "BLOCK/USDC", "shortN": 2, "longN": 3,
                                    "tradeUsd": 20, "history": [2, 2, 2, 2, 1]})
    ctx = {"mainnet": False, "prices": lambda s: {"BLOCK": 1, "USDC": 1},
           "getBalance": lambda c, t: [_bal("BLOCK", 8, "500000000")]}  # only 5 BLOCK
    intents = run(strat.plan(ctx, params))
    assert len(intents) == 1
    assert intents[0]["args"] == {"from": "BLOCK", "to": "USDC", "amount": "500000000"}


def test_momentum_nothing_without_cross_or_history():
    strat = S.Momentum()
    p1 = strat.validate_params({"market": "BLOCK/USDC", "shortN": 2, "longN": 3,
                                "history": [1, 1, 1, 1, 1]})
    assert run(strat.plan({"prices": lambda s: {"BLOCK": 1, "USDC": 1}}, p1)) == []
    p2 = strat.validate_params({"market": "BLOCK/USDC", "shortN": 2, "longN": 3,
                                "history": [1, 1]})  # too short
    assert run(strat.plan({"prices": lambda s: {"BLOCK": 1, "USDC": 1}}, p2)) == []


def test_momentum_death_cross_with_no_holdings_emits_nothing():
    strat = S.Momentum()
    params = strat.validate_params({"market": "BLOCK/USDC", "shortN": 2, "longN": 3,
                                    "tradeUsd": 20, "history": [2, 2, 2, 2, 1]})
    ctx = {"mainnet": False, "prices": lambda s: {"BLOCK": 1, "USDC": 1},
           "getBalance": lambda c, t: [_bal("BLOCK", 8, "0")]}
    assert run(strat.plan(ctx, params)) == []


# --------------------------------------------------------------------------- #
# validateParams: fills defaults, clamps, throws on bad input                 #
# --------------------------------------------------------------------------- #

def test_validate_params_fills_defaults_and_rejects_bad_input():
    assert S.Dca().validate_params({"asset": "BLOCK"})["usdPerBuy"] == 10
    assert S.Grid().validate_params({"market": "A/B"})["levels"] == 6
    assert S.Arbitrage().validate_params({})["minEdgeBps"] == 30
    with pytest.raises(ValueError):
        S.Dca().validate_params({})  # missing asset
    with pytest.raises(ValueError):
        S.Momentum().validate_params({"market": "A/B", "shortN": 30, "longN": 10})  # short >= long
    with pytest.raises(ValueError):
        S.Rebalance().validate_params({"targets": {"A": 0.2, "B": 0.2}})  # weights don't sum ~1
    with pytest.raises(ValueError):
        S.Grid().validate_params({"market": "nopair"})  # bad market


def test_registry_lists_all_five():
    assert set(S.default_registry().names()) == {"arbitrage", "dca", "grid", "rebalance", "momentum"}
