"""Gate-integration tests for the StrategyRunner (docs/AGENT-STRATEGIES.md §6).

The whole point of the strategy layer is that it CANNOT bypass the safety rails.
A strategy only produces Intents; the StrategyRunner dispatches them through the
SAME ``runner.dispatch_prepared`` path the NL runner uses. These tests prove an
auto-mode Intent is still:
  (a) rejected by a session/per-asset USD cap,
  (b) aborted by a kill mid-tick (and the kill blocks the commit),
  (c) subject to confirm above ``autoApproveUnderUsd``,
plus the mainnet gate, the both-legs-or-neither allowlist rule, and the safe
``propose`` default (emit + audit, dispatch nothing).
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import audit as audit_mod
from blockle.agent import policy as policy_mod
from blockle.agent import strategies as strat_mod
from blockle.agent import strategy_runner as sr_mod
from blockle.agent import tools as tools_mod


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# test doubles                                                                #
# --------------------------------------------------------------------------- #

def _tools_ctx(usd_for=None):
    rec = {"sent": [], "fees": []}

    async def execute_swap(built):
        rec["sent"].append(built)
        return {"txid": "0xtrade"}

    async def send_fee(xfer):
        rec["fees"].append(xfer)
        return {"txid": "0xfee"}

    async def get_address(chain):
        return "0x1111111111111111111111111111111111111111"

    async def estimate_usd(asset, amount):
        if usd_for:
            return usd_for(asset, amount)
        return 10.0

    async def place_order(o):
        rec["sent"].append(o)
        return {"orderId": "o1"}

    ctx = {"executeSwap": execute_swap, "sendFee": send_fee, "getAddress": get_address,
           "estimateUsd": estimate_usd, "venues": _venues_stub(),
           "exchange": {"placeOrder": place_order}}
    return ctx, rec


def _venues_stub(treasury_addr="0xtreasury"):
    class V:
        id = "evmdex"
        kind = "aggregator"
        chains = ["base"]

        def supports(self, chain):
            return True

        async def build_swap(self, req):
            fee = {"bps": 5, "chain": "base", "asset": req["from"], "amount": "500",
                   "treasury": treasury_addr}
            return {"venue": "evmdex", "chain": "base", "from": req["from"], "to": req["to"],
                    "amountIn": req["amount"], "amountOut": "990000", "minOut": "985000",
                    "tx": {"chain": "base", "to": "0xrouter", "data": "0x", "value": "0"},
                    "fee": fee,
                    "feeTransfer": {"chain": "base", "to": treasury_addr, "amount": "500",
                                    "asset": req["from"]}}
    v = V()

    class Reg:
        def list(self):
            return [v]

        def get(self, vid):
            return v  # any venue id resolves to the stub

        def for_chain(self, chain):
            return [v]
    return Reg()


class _FixedStrategy:
    """A planner stub that just returns preset Intents (plan is still read-only)."""

    def __init__(self, name, intents):
        self.name = name
        self._intents = intents

    def describe(self):
        return self.name

    def validate_params(self, params=None):
        return dict(params or {})

    async def plan(self, ctx, params):
        return [dict(i) for i in self._intents]


def _swap_intent(amount="1000000", mainnet=False, tag="t:swap", group=None):
    it = {"tool": "swap", "args": {"from": "USDC", "to": "WETH", "amount": amount, "chain": "base"},
          "rationale": "x", "estUsd": 10.0, "strategy": "fix", "tag": tag, "mainnet": mainnet}
    if group is not None:
        it["group"] = group
    return it


def _make_runner(intents, caps=None, confirm=None, mainnet_enabled=False,
                 allowlist=None, auto_under=None, usd_for=None):
    ctx, rec = _tools_ctx(usd_for=usd_for)
    tools = tools_mod.build(ctx)
    audit = audit_mod.create({})
    policy = policy_mod.create({
        "caps": caps or {},
        "confirm": confirm,
        "audit": audit,
        "autoApproveUnderUsd": auto_under,
    })
    policy.set_allowlist(allowlist if allowlist is not None else tools.names())
    registry = strat_mod.Registry({"fix": _FixedStrategy("fix", intents)})
    runner = sr_mod.create({"tools": tools, "policy": policy, "audit": audit,
                            "ctx": {}, "mainnetEnabled": mainnet_enabled,
                            "registry": registry})
    return runner, policy, audit, rec


# --------------------------------------------------------------------------- #
# propose is the safe default                                                 #
# --------------------------------------------------------------------------- #

def test_propose_mode_emits_but_dispatches_nothing():
    runner, policy, audit, rec = _make_runner([_swap_intent()], caps={"sessionUsd": 1000},
                                              confirm=lambda s: True)
    results = run(runner.tick("fix", {}))  # mode defaults to 'propose'
    assert len(results) == 1 and "proposed" in results[0]
    assert rec["sent"] == [] and rec["fees"] == []       # nothing moved
    assert policy.spent_usd == 0
    types = [e.get("type") for e in audit.list()]
    assert "strategy_plan" in types and "strategy_proposal" in types
    assert "executed" not in types


# --------------------------------------------------------------------------- #
# (a) a cap still rejects an auto Intent                                       #
# --------------------------------------------------------------------------- #

def test_auto_intent_rejected_by_session_cap():
    # trade $10 + fee $10 = $20 > $5 cap -> CapExceeded, nothing commits.
    runner, policy, audit, rec = _make_runner([_swap_intent()], caps={"sessionUsd": 5},
                                              confirm=lambda s: True)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert rec["sent"] == [] and rec["fees"] == []
    assert results[0].get("cap") is True
    assert policy.spent_usd == 0


def test_auto_intent_rejected_by_per_asset_cap():
    # USDC per-asset cap below the trade amount -> rejected before commit.
    runner, policy, audit, rec = _make_runner([_swap_intent(amount="1000000")],
                                              caps={"perAsset": {"USDC": "999"}},
                                              confirm=lambda s: True)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert rec["sent"] == []
    assert results[0].get("cap") is True


# --------------------------------------------------------------------------- #
# (b) kill mid-tick aborts the whole tick and blocks the commit                #
# --------------------------------------------------------------------------- #

def test_kill_mid_tick_aborts_and_blocks_commit():
    killed = {"done": False}

    async def confirm(summary):
        # user hits kill while the FIRST Intent's confirm dialog is open
        if not killed["done"]:
            killed["done"] = True
            await runner.policy.kill("killed mid-confirm")
        return True  # "approved", but the kill must win

    runner, policy, audit, rec = _make_runner(
        [_swap_intent(tag="leg1"), _swap_intent(tag="leg2")],
        caps={"sessionUsd": 1000}, confirm=confirm)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert rec["sent"] == [] and rec["fees"] == []       # commit blocked
    assert policy.is_killed() is True
    assert results == []                                 # tick aborted before any result
    types = [e.get("type") for e in audit.list()]
    assert "aborted" in types and "executed" not in types


def test_kill_before_second_intent_stops_remaining():
    calls = {"n": 0}

    async def confirm(summary):
        calls["n"] += 1
        if calls["n"] == 1:
            return True   # first commits
        return True

    runner, policy, audit, rec = _make_runner(
        [_swap_intent(tag="leg1"), _swap_intent(tag="leg2")],
        caps={"sessionUsd": 1000}, confirm=confirm)

    # kill AFTER the first intent by hooking the recording ctx: easier to kill
    # synchronously between intents via a confirm that kills on the 2nd call.
    async def confirm2(summary):
        calls["n"] += 1
        if calls["n"] >= 2:
            await runner.policy.kill("stop")
            return True
        return True

    runner.policy.confirm_fn = confirm2
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    # exactly one trade committed before the kill landed
    assert len(rec["sent"]) == 1


# --------------------------------------------------------------------------- #
# (c) confirm is required above autoApproveUnderUsd                            #
# --------------------------------------------------------------------------- #

def test_confirm_required_above_auto_threshold():
    asked = {"n": 0}

    def confirm(summary):
        asked["n"] += 1
        return False   # declines

    # action is $20 (trade+fee), threshold $5 -> must consult confirm, which declines.
    runner, policy, audit, rec = _make_runner([_swap_intent()], caps={"sessionUsd": 1000},
                                              confirm=confirm, auto_under=5)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert asked["n"] == 1                 # confirm WAS consulted
    assert rec["sent"] == []               # declined -> no commit
    assert "declined" in results[0]


def test_under_auto_threshold_skips_confirm_and_commits():
    asked = {"n": 0}

    def confirm(summary):
        asked["n"] += 1
        return False

    # same $20 action but threshold $100 -> auto-approved, confirm NOT consulted.
    runner, policy, audit, rec = _make_runner([_swap_intent()], caps={"sessionUsd": 1000},
                                              confirm=confirm, auto_under=100)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert asked["n"] == 0                 # confirm skipped under the threshold
    assert len(rec["sent"]) == 1           # committed
    assert "executed" in results[0]


# --------------------------------------------------------------------------- #
# mainnet gate                                                                #
# --------------------------------------------------------------------------- #

def test_mainnet_intent_refused_when_disabled():
    runner, policy, audit, rec = _make_runner([_swap_intent(mainnet=True)],
                                              caps={"sessionUsd": 1000},
                                              confirm=lambda s: True, mainnet_enabled=False)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert rec["sent"] == []
    assert results[0]["reason"] == "mainnet disabled"
    types = [e.get("type") for e in audit.list()]
    assert "mainnet_blocked" in types


def test_mainnet_intent_allowed_when_enabled():
    runner, policy, audit, rec = _make_runner([_swap_intent(mainnet=True)],
                                              caps={"sessionUsd": 1000},
                                              confirm=lambda s: True, mainnet_enabled=True)
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert len(rec["sent"]) == 1
    assert "executed" in results[0]


# --------------------------------------------------------------------------- #
# allowlist: both legs or neither (grouped arbitrage)                          #
# --------------------------------------------------------------------------- #

def test_grouped_arb_drops_both_legs_if_one_tool_not_allowlisted():
    # two legs share a group; the sell leg uses place_order which is NOT on the
    # allowlist -> BOTH legs must be dropped (never a one-legged arb).
    buy = _swap_intent(tag="arb:buy", group="g1")
    sell = {"tool": "place_order",
            "args": {"market": "WETH/USDC", "side": "sell", "amount": "1", "price": "1"},
            "rationale": "x", "estUsd": 10.0, "strategy": "fix", "tag": "arb:sell",
            "mainnet": False, "group": "g1"}
    runner, policy, audit, rec = _make_runner([buy, sell], caps={"sessionUsd": 1000},
                                              confirm=lambda s: True, allowlist=["swap"])
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert rec["sent"] == []                               # neither leg executed
    assert all("blocked" in r for r in results)
    assert all(r["reason"] == "group leg not allowlisted" for r in results)


def test_ungrouped_intent_for_non_allowlisted_tool_is_dropped():
    bad = {"tool": "place_order",
           "args": {"market": "WETH/USDC", "side": "sell", "amount": "1", "price": "1"},
           "rationale": "x", "estUsd": 10.0, "strategy": "fix", "tag": "lone", "mainnet": False}
    runner, policy, audit, rec = _make_runner([bad], caps={"sessionUsd": 1000},
                                              confirm=lambda s: True, allowlist=["swap"])
    results = run(runner.tick("fix", {}, {"mode": "auto"}))
    assert rec["sent"] == []
    assert results[0]["reason"] == "tool not allowlisted"


# --------------------------------------------------------------------------- #
# unknown strategy                                                            #
# --------------------------------------------------------------------------- #

def test_unknown_strategy_raises():
    runner, policy, audit, rec = _make_runner([], caps={"sessionUsd": 1000}, confirm=lambda s: True)
    with pytest.raises(ValueError):
        run(runner.tick("nope", {}))
