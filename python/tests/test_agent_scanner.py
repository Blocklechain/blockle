"""agent/scanner tests — the Scan-&-Trade (Autopilot) evaluator. Pins the shared
contract (docs/scan-vectors.json): a cost-positive arb pair is traded; a
gross-positive-but-net-negative pair is NOT; a sub-minProfitBps pair is skipped;
a flagged token is never scored/traded; ranking + emitted Intents are exact; the
maxConcurrentPairs + allocation bounds hold. No synthetic prices. These outputs
match the JS reference (blockle-extension/agent/scanner.js) byte-for-byte.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from blockle.agent import scanner as Scanner
from blockle.agent import strategies as Strategies

VEC = json.loads((Path(__file__).resolve().parents[2] / "docs" / "scan-vectors.json").read_text())


def run(coro):
    return asyncio.run(coro)


def scan(universe, config, opts=None):
    o = dict(opts or {})
    o["Strategies"] = Strategies
    return run(Scanner.scan_and_score(universe, config, o))


# ===========================================================================
# SHARED VECTOR: the snapshot -> the exact ranked worthy set + scores + Intents
# ===========================================================================
def test_scan_vectors_exact_ranked_scores_and_intents():
    sv = VEC["scanner"]
    result = scan(sv["universe"], sv["config"], sv["opts"])

    assert len(result["candidates"]) == len(sv["expect"]["ranked"])
    for i, exp in enumerate(sv["expect"]["ranked"]):
        got = result["candidates"][i]
        assert got["pair"] == exp["pair"], f"rank {i} pair"
        assert got["strategy"] == exp["strategy"], f"{exp['pair']} strategy"
        assert got["edgeBps"] == exp["edgeBps"], f"{exp['pair']} edgeBps"
        assert got["score"] == exp["score"], f"{exp['pair']} score"
        assert got["reason"] == exp["reason"], f"{exp['pair']} reason"
        assert bool(got.get("traded")) == bool(exp.get("traded")), f"{exp['pair']} traded"

    assert [w["pair"] for w in result["worthy"]] == sv["expect"]["worthy"]
    assert result["skipped"] == sv["expect"]["skipped"]

    assert len(result["intents"]) == len(sv["expect"]["intents"])
    for i, exp in enumerate(sv["expect"]["intents"]):
        got = result["intents"][i]
        assert got["tool"] == exp["tool"], f"intent {i} tool"
        assert got["args"] == exp["args"], f"intent {i} args"
        assert got["estUsd"] == exp["estUsd"], f"intent {i} estUsd"
        assert got["tag"] == exp["tag"], f"intent {i} tag"
        assert got["strategy"] == exp["strategy"], f"intent {i} strategy"
        assert got["scannerPair"] == exp["scannerPair"], f"intent {i} scannerPair"

    assert result["allocationUsd"] == sv["expect"]["allocationUsd"]
    assert result["remainingUsd"] == sv["expect"]["remainingUsd"]


# ===========================================================================
# SAFETY: cost-positive traded; gross-positive-but-net-negative NOT; sub-threshold
# ===========================================================================
def test_cost_positive_arbitrage_is_traded():
    sv = VEC["scanner"]
    result = scan(sv["universe"], sv["config"], sv["opts"])
    eth = next(c for c in result["candidates"] if c["pair"] == "ETH/USDC")
    assert eth["reason"] == "worthy"
    assert eth["traded"]
    assert eth["edgeBps"] > sv["config"]["minProfitBps"]
    assert any(it["tag"] == "arb:ETH/USDC:dexA->dexB:buy" for it in result["intents"])
    assert any(it["tag"] == "arb:ETH/USDC:dexA->dexB:sell" for it in result["intents"])


def test_gross_positive_but_net_negative_is_never_traded():
    sv = VEC["scanner"]
    result = scan(sv["universe"], sv["config"], sv["opts"])
    blk = next(c for c in result["candidates"] if c["pair"] == "BLOCK/USDC")
    assert blk["reason"] == "net-negative"
    assert blk["edgeBps"] == -15
    assert blk["score"] == 0
    assert not blk["traded"]
    assert not any(str(it.get("scannerPair")) == "BLOCK/USDC" for it in result["intents"])


def test_sub_min_profit_pair_is_skipped():
    sv = VEC["scanner"]
    result = scan(sv["universe"], sv["config"], sv["opts"])
    sol = next(c for c in result["candidates"] if c["pair"] == "SOL/USDC")
    assert sol["reason"] == "below-threshold"
    assert sol["edgeBps"] > 0 and sol["score"] < sv["config"]["minProfitBps"]
    assert not sol["traded"]
    assert not any(str(it.get("scannerPair")) == "SOL/USDC" for it in result["intents"])


def test_flagged_candidate_is_never_scored_or_traded():
    sv = VEC["scanner"]
    result = scan(sv["universe"], sv["config"], sv["opts"])
    scam = next(c for c in result["candidates"] if c["pair"] == "SCAM/USDC")
    assert scam["reason"] == "flagged"
    assert scam["strategy"] is None
    assert scam["score"] == 0
    assert not any(str(it.get("scannerPair")) == "SCAM/USDC" for it in result["intents"])


# ===========================================================================
# NEVER FABRICATE: no venue data / no history => no signal, score 0, no Intent
# ===========================================================================
def test_no_market_data_produces_no_signal_and_no_intent():
    result = scan([{"chain": "ethereum", "pair": "NODATA/USDC", "prices": {"USDC": 1}}],
                  VEC["scanner"]["config"], {"allocationUsd": 5000})
    assert result["candidates"][0]["reason"] == "no-signal"
    assert result["candidates"][0]["score"] == 0
    assert len(result["intents"]) == 0


# ===========================================================================
# maxConcurrentPairs + allocation bound the selection
# ===========================================================================
def test_max_concurrent_caps_traded_pairs():
    sv = VEC["scanner"]
    cfg = dict(sv["config"], maxConcurrentPairs=1)
    result = scan(sv["universe"], cfg, {"allocationUsd": 5000})
    assert len(result["worthy"]) == 1
    assert result["worthy"][0]["pair"] == "MOM/USDC"
    eth = next(c for c in result["candidates"] if c["pair"] == "ETH/USDC")
    assert eth["reason"] == "max-concurrent"


def test_remaining_allocation_bounds_how_many_pairs_trade():
    sv = VEC["scanner"]
    result = scan(sv["universe"], sv["config"], {"allocationUsd": 1500, "committedUsd": 0})
    assert [w["pair"] for w in result["worthy"]] == ["MOM/USDC"]
    eth = next(c for c in result["candidates"] if c["pair"] == "ETH/USDC")
    assert eth["reason"] == "allocation"


# ===========================================================================
# config floors: slippage/agent-fee can never be configured below reality
# ===========================================================================
def test_slippage_and_agent_fee_floors():
    cfg = Scanner.validate_config({"slippageBps": 0, "agentFeeBps": 0})
    assert cfg["slippageBps"] >= 5
    assert cfg["agentFeeBps"] >= 5


# ===========================================================================
# PROFIT CURRENCY — the settlement/quote asset the autopilot realizes profit
# INTO, denominates P&L in, and routes take-profit exits to. Defaults to USDC.
# Matches the JS reference (blockle-extension/agent/scanner.js) behavior.
# ===========================================================================
def test_profit_currency_defaults_to_usdc_and_normalizes_a_user_choice():
    assert Scanner.validate_config({})["profitCurrency"] == "USDC"
    assert Scanner.validate_config({"profitCurrency": "usdt"})["profitCurrency"] == "USDT"
    assert Scanner.validate_config({"profitCurrency": "  dai "})["profitCurrency"] == "DAI"
    assert Scanner.validate_config({"profitCurrency": ""})["profitCurrency"] == "USDC"


def test_scanner_with_profit_currency_usdc_realizes_pnl_and_exits_in_usdc():
    sv = VEC["scanner"]
    cfg = dict(sv["config"])
    cfg["profitCurrency"] = "USDC"
    result = scan(sv["universe"], cfg, sv["opts"])

    # the run denominates everything into the profit currency.
    assert result["profitCurrency"] == "USDC"
    assert len(result["worthy"]) >= 1

    # EVERY worthy pair realizes its (net-positive) expected P&L INTO USDC.
    for w in result["worthy"]:
        assert w.get("realized"), f"{w['pair']} carries a realized-P&L block"
        assert w["realized"]["currency"] == "USDC"
        assert w["realized"]["profit"] > 0, f"{w['pair']} realizes a net-positive profit"

    # the take-profit EXIT legs (the realize/sell legs) settle to USDC.
    exits = [it for it in result["intents"] if it.get("exit")]
    assert len(exits) >= 1, "at least one take-profit / realize exit leg exists"
    for e in exits:
        assert e["settleTo"] == "USDC"
        assert str(e["tag"]).endswith(":sell")
    # every emitted intent is tagged with the settlement currency.
    for it in result["intents"]:
        assert it["settleTo"] == "USDC"


def test_profit_currency_equal_to_quote_matches_the_pinned_scan_vectors():
    # When the chosen profit currency IS the pair quote (USDC here) there is no
    # settlement hop: the ranking, worthy set, scores AND the emitted intent args
    # are byte-identical to the default — this is the shared-vector parity guarantee.
    sv = VEC["scanner"]
    base = scan(sv["universe"], sv["config"], sv["opts"])
    with_usdc = scan(sv["universe"], dict(sv["config"], profitCurrency="USDC"), sv["opts"])
    assert [w["pair"] for w in with_usdc["worthy"]] == [w["pair"] for w in base["worthy"]]
    assert [[c["pair"], c["score"], c["reason"]] for c in with_usdc["candidates"]] == \
        [[c["pair"], c["score"], c["reason"]] for c in base["candidates"]]
    assert len(with_usdc["intents"]) == len(base["intents"])
    for i, it in enumerate(with_usdc["intents"]):
        assert it["args"] == base["intents"][i]["args"]


def test_profit_currency_changes_the_exit_intent_output_asset():
    # REAL EXECUTION (not a label): choosing a profit currency that differs from the
    # pair quote MUST change the emitted swap args — the take-profit EXIT leg's
    # OUTPUT asset becomes the profit currency, routed through the existing venue
    # layer. This replaces the old "args are unchanged across profit currencies"
    # assertion (which was the label-only behavior).
    sv = VEC["scanner"]
    usdc = scan(sv["universe"], dict(sv["config"], profitCurrency="USDC"), sv["opts"])
    dai = scan(sv["universe"], dict(sv["config"], profitCurrency="DAI"), sv["opts"])

    usdc_exits = [it for it in usdc["intents"] if it.get("exit")]
    dai_exits = [it for it in dai["intents"] if it.get("exit")]
    assert usdc_exits and dai_exits, "both runs emit at least one take-profit exit leg"

    # the exit leg's OUTPUT asset is exactly the chosen profit currency, and it
    # ACTUALLY DIFFERS once the profit currency differs from the native quote.
    for e in usdc_exits:
        assert e["args"]["to"] == "USDC"
    for e in dai_exits:
        assert e["args"]["to"] == "DAI"
        assert e.get("settleHop") is True  # venue routes native-quote -> DAI

    by_tag_usdc = {it["tag"]: it for it in usdc["intents"]}
    changed = False
    for e in dai_exits:
        other = by_tag_usdc.get(e["tag"])
        assert other is not None
        if e["args"] != other["args"]:
            changed = True
            assert e["args"]["to"] != other["args"]["to"]  # the output asset moved
    assert changed, "the emitted exit swap args change with the profit currency"


def test_pair_net_negative_after_settlement_is_not_traded():
    # A pair that clears in its native quote but goes net-negative once the cost of
    # settling into the profit currency (extra venue fee + agent leg + slippage) is
    # charged MUST be skipped — not traded, no intents emitted for it.
    sv = VEC["scanner"]
    native = scan(sv["universe"], dict(sv["config"], profitCurrency="USDC"), sv["opts"])
    assert "ETH/USDC" in [w["pair"] for w in native["worthy"]]  # worthy in its native quote

    # a punitive settlement fee into a DIFFERENT currency flips it net-negative.
    settled = scan(sv["universe"],
                   dict(sv["config"], profitCurrency="DAI", settlementVenueFeeBps=100000),
                   sv["opts"])
    eth = next(c for c in settled["candidates"] if c["pair"] == "ETH/USDC")
    assert eth["reason"] == "net-negative"
    assert not eth["traded"]
    assert not any(str(it.get("scannerPair")) == "ETH/USDC" for it in settled["intents"])


def test_no_route_to_profit_currency_is_skipped_not_fabricated():
    # If a candidate has no priceable route to the profit currency, SKIP it
    # (audited) — never invent a price to force a trade.
    sv = VEC["scanner"]
    eth = next(c for c in sv["universe"] if c["pair"] == "ETH/USDC")
    # WBTC is not a stablecoin and no price is provided for it on this candidate.
    result = scan([dict(eth)], dict(sv["config"], profitCurrency="WBTC"), sv["opts"])
    row = result["candidates"][0]
    assert row["reason"] == "no-settle-route"
    assert not row.get("traded")
    assert result["intents"] == []


def test_popup_and_pnl_read_the_real_settled_currency():
    # The realized-profit block + the asset the pop-up/P&L would read (the committed
    # trade's OUTPUT asset) are the SAME and equal the chosen profit currency — they
    # are kept consistent, not a separate label over an unchanged output.
    sv = VEC["scanner"]
    result = scan(sv["universe"], dict(sv["config"], profitCurrency="DAI"), sv["opts"])
    assert result["profitCurrency"] == "DAI"
    assert result["worthy"]
    for w in result["worthy"]:
        assert w["realized"]["currency"] == "DAI"
        assert w["realized"]["profit"] > 0

    # pnl.on_commit reads swap `args["to"]` as the received (settled) asset; every
    # exit leg's output asset is DAI, so the pop-up reports the real settled currency.
    exits = [it for it in result["intents"] if it.get("exit")]
    assert exits
    for e in exits:
        assert e["args"]["to"] == result["profitCurrency"] == e["settleTo"]
