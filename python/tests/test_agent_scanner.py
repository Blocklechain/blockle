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
