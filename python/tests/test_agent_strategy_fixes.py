"""Regression tests locking the verifier-found strategy-engine fixes.

Each test pins ONE fix from docs/AGENT-STRATEGIES.md (§0 safety, §3.1 arbitrage,
§5 fees). Cross-language vectors are kept INLINE here (the shared
docs/strategy-vectors.json is intentionally untouched this round to avoid a
parallel-write conflict). These sit alongside the existing strategy +
strategy-gate suites, all of which must stay green.

  FIX-1  arb depth/gas: recompute USD costs on the depth-CLAMPED notional,
         re-run the minEdge test on the clamped size, and set each leg's estUsd
         to the clamped notional (not the full probe).
  FIX-2  agent-fee pin: the arb edge math charges the REAL fixed 2*AGENT_FEE_BPS;
         agentFeeBps floors at AGENT_FEE_BPS, slippage at MIN_SLIPPAGE_BPS.
  FIX-3  mainnet backstop: ctx.network()=="mainnet" refuses every strategy's
         Intent when mainnetEnabled=false (not only venue-flagged arb).
  FIX-4  BigInt-exact usd->base: integer/Decimal scaling loses no low digits.
  FIX-5  mode fail-safe: dispatch ONLY when mode=="auto"; anything else proposes.
  FIX-6  structural gate: a non-value-moving/unknown tool in auto mode is dropped
         with an audited "blocked" note, never prepared/committed, never crashes.
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import audit as audit_mod
from blockle.agent import policy as policy_mod
from blockle.agent import strategies as S
from blockle.agent import strategy_runner as sr_mod


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# arbitrage snapshot helpers (inline, not from the shared vectors file)        #
# --------------------------------------------------------------------------- #

def _v(vid, ask, bid, feeBps=0, mainnet=False, depth="1000000000000000000000"):
    return {"id": vid, "chain": "ethereum", "mainnet": mainnet, "ask": ask,
            "bid": bid, "feeBps": feeBps, "depthBase": depth}


def _arb_ctx(va, vb):
    return {"mainnet": False, "prices": lambda syms: {s: {"USDC": 1}.get(s) for s in syms},
            "listVenues": lambda pair, v=[va, vb]: list(v)}


def _plan_arb(params, va, vb):
    strat = S.Arbitrage()
    p = strat.validate_params(params)
    return run(strat.plan(_arb_ctx(va, vb), p))


# --------------------------------------------------------------------------- #
# FIX-1 — recompute on clamped notional; estUsd = clamped notional             #
# --------------------------------------------------------------------------- #

def test_fix1_fat_gross_edge_but_tiny_depth_emits_nothing():
    # PoC from the brief: ask 100 / bid 105 (500 bps gross), maxNotionalUsd 50,
    # gasBufferUsd 2, but each venue only has ~0.01 unit of depth. The executable
    # notional clamps to ~$1, so the $2 gas buffer alone is ~20000 bps -> the real
    # net edge is deeply negative and NOTHING may be emitted.
    tiny = "10000000000000000"  # 0.01 ETH in 1e18 base units
    params = {"pair": "ETH/USDC", "minEdgeBps": 30, "maxNotionalUsd": 50,
              "gasBufferUsd": 2, "agentFeeBps": 5, "slippageBps": 10}
    buy = _v("dexA", "100", "99", depth=tiny)
    sell = _v("dexB", "101", "105", depth=tiny)
    assert _plan_arb(params, buy, sell) == []


def test_fix1_same_snapshot_with_deep_books_does_emit():
    # Control: identical prices, but deep books -> the clamp no longer bites and
    # the edge clears. Proves the refusal above is the depth/gas recompute, not a
    # too-small gross edge.
    params = {"pair": "ETH/USDC", "minEdgeBps": 30, "maxNotionalUsd": 50,
              "gasBufferUsd": 2, "agentFeeBps": 5, "slippageBps": 10}
    buy = _v("dexA", "100", "99")
    sell = _v("dexB", "101", "105")
    intents = _plan_arb(params, buy, sell)
    assert len(intents) == 2
    assert intents[0]["estUsd"] == 50.0 and intents[1]["estUsd"] == 50.0


def test_fix1_estusd_is_the_clamped_notional_not_the_full_probe():
    # Depth clamps the executable size to $10 even though maxNotionalUsd is $50;
    # a huge gross edge keeps it profitable. estUsd on BOTH legs must be the
    # clamped $10, never the $50 probe.
    tenth = "100000000000000000"  # 0.1 ETH -> depth_usd = 0.1 * price
    params = {"pair": "ETH/USDC", "minEdgeBps": 0, "maxNotionalUsd": 50,
              "gasBufferUsd": 0.01, "agentFeeBps": 5, "slippageBps": 10}
    buy = _v("dexA", "100", "99", depth=tenth)      # depth_usd = 0.1*100 = $10
    sell = _v("dexB", "101", "200", depth=tenth)    # huge bid -> big gross edge
    intents = _plan_arb(params, buy, sell)
    assert len(intents) == 2
    assert intents[0]["estUsd"] == 10.0 and intents[1]["estUsd"] == 10.0


# --------------------------------------------------------------------------- #
# FIX-2 — agent-fee pin + slippage floor                                       #
# --------------------------------------------------------------------------- #

def test_fix2_validate_floors_agent_fee_and_slippage():
    p = S.Arbitrage().validate_params(
        {"pair": "ETH/USDC", "agentFeeBps": 0, "slippageBps": 0})
    assert p["agentFeeBps"] == S.AGENT_FEE_BPS       # never below the real on-chain fee
    assert p["slippageBps"] == S.MIN_SLIPPAGE_BPS    # conservative non-zero floor


def test_fix2_agent_fee_zero_with_edge_under_true_fee_emits_nothing():
    # agentFeeBps:0 + slippageBps:0 (both would understate cost). Gross edge is
    # 15 bps — under the pinned 2*5=10 agent bps + 10 slippage bps = 20. With the
    # OLD caller-tunable 0-fee math this loss-maker would be emitted; the pin must
    # price it negative and emit NOTHING.
    params = {"pair": "ETH/USDC", "minEdgeBps": 0, "maxNotionalUsd": 1000,
              "gasBufferUsd": 0, "agentFeeBps": 0, "slippageBps": 0}
    buy = _v("dexA", "10000", "9000")
    sell = _v("dexB", "10001", "10015")   # (10015-10000)/10000 = 15 bps gross
    assert _plan_arb(params, buy, sell) == []


def test_fix2_same_snapshot_clears_once_gross_edge_exceeds_pinned_cost():
    # Control: widen the bid so gross = 50 bps > 20 bps pinned cost -> emits.
    params = {"pair": "ETH/USDC", "minEdgeBps": 0, "maxNotionalUsd": 1000,
              "gasBufferUsd": 0, "agentFeeBps": 0, "slippageBps": 0}
    buy = _v("dexA", "10000", "9000")
    sell = _v("dexB", "10001", "10050")   # 50 bps gross
    assert len(_plan_arb(params, buy, sell)) == 2


# --------------------------------------------------------------------------- #
# FIX-4 — BigInt-exact usd->base                                               #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("usd,price,decimals,expected", [
    (123.456789, 1, 18, 123456789000000000000),   # the brief's exact vector
    ("123.456789", 1, 18, 123456789000000000000),  # string input, same result
    (10, 1, 6, 10000000),                           # 6-dp stable
    (1, 2000, 18, 500000000000000),                 # $1 of a $2000 asset, exact
])
def test_fix4_usd_to_base_is_exact_no_low_digit_loss(usd, price, decimals, expected):
    assert S._usd_to_base(usd, price, decimals) == expected


# --------------------------------------------------------------------------- #
# runner test doubles for FIX-3 / FIX-5 / FIX-6                                 #
# --------------------------------------------------------------------------- #

class _StubTools:
    """Minimal tools registry: .get(name) + .names(). The value-moving entries
    carry a prepare() that records nothing (dispatch is never reached in these
    tests — the Intents are gated out first)."""

    def __init__(self, mapping):
        self._m = dict(mapping)

    def get(self, name):
        return self._m.get(name)

    def names(self):
        return list(self._m.keys())


def _swap_tool():
    async def prepare(args):  # pragma: no cover - never reached (gated first)
        return {"summary": "swap", "actions": []}
    return {"valueMoving": True, "prepare": prepare}


def _build_runner(intents, ctx, tools_map, allowlist, mainnet_enabled=False):
    audit = audit_mod.create({})
    policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "confirm": lambda s: True,
                                "audit": audit})
    tools = _StubTools(tools_map)
    policy.set_allowlist(allowlist)

    class _Fixed:
        name = "fix"

        def describe(self):
            return "fix"

        def validate_params(self, params=None):
            return dict(params or {})

        async def plan(self, c, p):
            return [dict(i) for i in intents]

    registry = S.Registry({"fix": _Fixed()})
    runner = sr_mod.create({"tools": tools, "policy": policy, "audit": audit,
                            "ctx": ctx, "mainnetEnabled": mainnet_enabled,
                            "registry": registry})
    return runner, policy, audit


def _swap_intent(mainnet=False, tool="swap", tag="t"):
    return {"tool": tool, "args": {"from": "USDC", "to": "WETH", "amount": "1000000"},
            "rationale": "x", "estUsd": 10.0, "strategy": "fix", "tag": tag,
            "mainnet": mainnet}


# --------------------------------------------------------------------------- #
# FIX-3 — chain-level mainnet backstop (covers venue-less strategies)          #
# --------------------------------------------------------------------------- #

def test_fix3_ctx_network_mainnet_refuses_venueless_swap_in_auto():
    # Intent is NOT flagged mainnet (a venue-less swap auto-routed at commit), but
    # ctx.network()=="mainnet" -> the runner's chain-level backstop must refuse it
    # when mainnetEnabled=false. No execution; an audited mainnet_blocked note.
    ctx = {"network": lambda: "mainnet"}
    runner, policy, audit = _build_runner(
        [_swap_intent(mainnet=False)], ctx, {"swap": _swap_tool()}, ["swap"],
        mainnet_enabled=False)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert results[0]["reason"] == "mainnet disabled"
    assert "mainnet_blocked" in [e.get("type") for e in audit.list()]


def test_fix3_real_dca_on_mainnet_ctx_is_refused():
    # The real dca planner emits a venue-less swap; on a mainnet ctx it is flagged
    # mainnet AND backstopped, so auto mode with mainnetEnabled=false refuses it.
    ctx = {"network": lambda: "mainnet",
           "prices": lambda syms: {s: {"USDC": 1.0}.get(s) for s in syms},
           "now": lambda: 10 ** 13}
    audit = audit_mod.create({})
    policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "confirm": lambda s: True,
                                "audit": audit})
    tools = _StubTools({"swap": _swap_tool()})
    policy.set_allowlist(["swap"])
    runner = sr_mod.create({"tools": tools, "policy": policy, "audit": audit, "ctx": ctx,
                            "mainnetEnabled": False, "registry": S.default_registry()})
    results = run(runner.tick("dca", {"asset": "BLOCK", "intervalSec": 86400, "lastRunAt": 0},
                              {"mode": "auto"}))
    assert results and results[0].get("reason") == "mainnet disabled"
    assert "mainnet_blocked" in [e.get("type") for e in audit.list()]


def test_fix3_real_rebalance_on_mainnet_ctx_is_refused():
    ctx = {"network": lambda: "mainnet",
           "prices": lambda syms: {s: {"BLOCK": 1, "USDC": 1}.get(s) for s in syms},
           "getBalance": lambda c, t: [
               {"asset": {"symbol": "BLOCK", "decimals": 8}, "confirmed": "7000000000"},
               {"asset": {"symbol": "USDC", "decimals": 6}, "confirmed": "30000000"}]}
    audit = audit_mod.create({})
    policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "confirm": lambda s: True,
                                "audit": audit})
    tools = _StubTools({"swap": _swap_tool()})
    policy.set_allowlist(["swap"])
    runner = sr_mod.create({"tools": tools, "policy": policy, "audit": audit, "ctx": ctx,
                            "mainnetEnabled": False, "registry": S.default_registry()})
    results = run(runner.tick("rebalance", {"targets": {"BLOCK": 0.5, "USDC": 0.5},
                                            "maxTradeUsd": 1000}, {"mode": "auto"}))
    assert results and results[0].get("reason") == "mainnet disabled"
    assert "mainnet_blocked" in [e.get("type") for e in audit.list()]


# --------------------------------------------------------------------------- #
# FIX-5 — mode fail-safe (dispatch only when mode=="auto")                      #
# --------------------------------------------------------------------------- #

def test_fix5_dryrun_mode_dispatches_nothing_and_proposes():
    ctx = {}
    runner, policy, audit = _build_runner(
        [_swap_intent()], ctx, {"swap": _swap_tool()}, ["swap"])
    results = run(runner.tick("fix", {}, {"mode": "dryrun"}))
    assert "proposed" in results[0]                       # fails safe to propose
    assert policy.spent_usd == 0
    types = [e.get("type") for e in audit.list()]
    assert "strategy_proposal" in types and "executed" not in types


def test_fix5_empty_mode_also_proposes():
    runner, policy, audit = _build_runner(
        [_swap_intent()], {}, {"swap": _swap_tool()}, ["swap"])
    results = run(runner.tick("fix", {}, {"mode": ""}))
    assert "proposed" in results[0]
    assert policy.spent_usd == 0


# --------------------------------------------------------------------------- #
# FIX-6 — structural gate invariant                                            #
# --------------------------------------------------------------------------- #

def test_fix6_allowlisted_but_readonly_tool_is_blocked_not_executed():
    # 'readonly' is ON the allowlist but is NOT value-moving. In auto mode it must
    # be dropped with an audited 'blocked' note and never prepared/committed.
    ro = _swap_intent(tool="readonly", tag="ro")
    runner, policy, audit = _build_runner(
        [ro], {}, {"readonly": {"valueMoving": False}}, ["readonly"])
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert "blocked" in results[0] and results[0]["reason"] == "tool not value-moving"
    blocked = [e for e in audit.list() if e.get("type") == "blocked"]
    assert blocked and blocked[-1]["reason"] == "tool not value-moving"
    assert policy.spent_usd == 0
    assert "executed" not in [e.get("type") for e in audit.list()]


def test_fix6_unknown_tool_in_auto_does_not_crash_the_tick():
    # A mis-flagged / unknown tool name must be dropped (blocked), not raise.
    unknown = _swap_intent(tool="ghost", tag="g")
    runner, policy, audit = _build_runner(
        [unknown], {}, {"swap": _swap_tool()}, ["swap", "ghost"])
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert "blocked" in results[0] and results[0]["reason"] == "tool not value-moving"
    assert policy.spent_usd == 0
