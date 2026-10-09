"""Safety-rail tests for the in-wallet AI agent (policy + runner).

Mirrors the invariants the audited extension enforces (agent/agent.test.js):
over-cap blocks, kill blocks, confirmation required (fail-closed without a
handler), and the tool allowlist. Also covers the end-to-end runner flow:
prepare -> assess_value -> gate_confirm -> commit -> mandatory fee leg ->
record_spend, plus the hash-chained audit log.
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import audit as audit_mod
from blockle.agent import index as agent_index
from blockle.agent import policy as policy_mod
from blockle.agent import runner as runner_mod
from blockle.agent import tools as tools_mod
from blockle.agent.policy import AgentHalted, CapExceeded, ToolNotAllowed


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- policy caps


def test_per_asset_cap_blocks_over_cap():
    p = policy_mod.create({"caps": {"perAsset": {"BLOCK": "1000"}}})
    p.assess_value({"asset": "BLOCK", "amount": "1000"})  # exactly at cap is OK
    with pytest.raises(CapExceeded):
        p.assess_value({"asset": "BLOCK", "amount": "1001"})


def test_per_asset_cap_accumulates():
    p = policy_mod.create({"caps": {"perAsset": {"BLOCK": "1000"}}})
    p.assess_value({"asset": "BLOCK", "amount": "600"})
    p.record_spend({"asset": "BLOCK", "amount": "600"})
    # 600 + 600 > 1000 -> blocked
    with pytest.raises(CapExceeded):
        p.assess_value({"asset": "BLOCK", "amount": "600"})
    # but 600 + 400 == 1000 -> OK
    p.assess_value({"asset": "BLOCK", "amount": "400"})


def test_session_usd_cap_blocks_and_requires_estimate():
    p = policy_mod.create({"caps": {"sessionUsd": 50}})
    p.assess_value({"asset": "BLOCK", "amount": "1", "usd": 49.99})
    with pytest.raises(CapExceeded):
        p.assess_value({"asset": "BLOCK", "amount": "1", "usd": 50.01})
    # a session cap with NO usd estimate must be rejected (cannot verify)
    with pytest.raises(CapExceeded):
        p.assess_value({"asset": "BLOCK", "amount": "1"})


# ------------------------------------------------------------ confirmation gate


def test_confirm_required_fail_closed_without_handler():
    # requireConfirm default ON, no confirmFn -> denied (fail closed)
    p = policy_mod.create({})
    gate = run(p.gate_confirm({"action": "send"}, {"usd": 1}))
    assert gate == {"approved": False, "auto": False}


def test_confirm_handler_approves_and_denies():
    approve = policy_mod.create({"confirm": lambda s: True})
    assert run(approve.gate_confirm({"a": 1}, {}))["approved"] is True
    deny = policy_mod.create({"confirm": lambda s: False})
    assert run(deny.gate_confirm({"a": 1}, {}))["approved"] is False


def test_auto_approve_under_usd_bounded():
    p = policy_mod.create({"confirm": lambda s: False, "autoApproveUnderUsd": 10})
    # under threshold -> auto approved without calling confirm
    assert run(p.gate_confirm({"a": 1}, {"usd": 5})) == {"approved": True, "auto": True}
    # over threshold -> falls through to the (denying) confirm handler
    assert run(p.gate_confirm({"a": 1}, {"usd": 25}))["approved"] is False


def test_require_confirm_false_allows():
    p = policy_mod.create({"requireConfirm": False})
    assert run(p.gate_confirm({"a": 1}, {}))["approved"] is True


# ------------------------------------------------------------------ kill switch


def test_kill_blocks_gate_and_marks_halted():
    killed = {"n": 0}

    async def on_kill(_reason):
        killed["n"] += 1

    p = policy_mod.create({"confirm": lambda s: True, "onKill": on_kill})
    run(p.kill("user"))
    assert p.is_killed() is True
    assert killed["n"] == 1
    with pytest.raises(AgentHalted):
        p.assert_live()
    with pytest.raises(AgentHalted):
        run(p.gate_confirm({"a": 1}, {}))


def test_kill_during_confirm_still_blocks():
    """A kill that lands while the confirm dialog is awaited must still veto."""
    p = policy_mod.create({})

    async def confirm(_summary):
        await p.kill("killed mid-confirm")
        return True  # user "approved", but the kill must win

    p.confirm_fn = confirm
    with pytest.raises(AgentHalted):
        run(p.gate_confirm({"action": "send"}, {}))


# -------------------------------------------------------------------- allowlist


def test_allowlist_blocks_unknown_tool():
    p = policy_mod.create({})
    p.set_allowlist(["get_balance", "quote"])
    p.check_allowed("quote")
    with pytest.raises(ToolNotAllowed):
        p.check_allowed("send")


# --------------------------------------------------------- runner end-to-end


class _ScriptedProvider:
    """A provider that replays a fixed list of turns (no network)."""

    def __init__(self, turns):
        self._turns = list(turns)
        self.seen = []

    async def turn(self, req):
        self.seen.append(req)
        return self._turns.pop(0)


def _ctx_recording():
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
        return 10.0

    ctx = {"executeSwap": execute_swap, "sendFee": send_fee,
           "getAddress": get_address, "estimateUsd": estimate_usd}
    return ctx, rec


def _venues_stub(treasury_addr="0xtreasury"):
    """Minimal venue registry whose build_swap yields a routable fee."""

    class V:
        id = "evmdex"
        kind = "aggregator"
        chains = ["base"]

        def supports(self, chain):
            return chain in ("base", "ethereum")

        async def build_swap(self, req):
            fee = {"bps": 5, "chain": "base", "asset": req["from"], "amount": "500",
                   "treasury": treasury_addr}
            return {
                "venue": "evmdex", "chain": "base", "from": req["from"], "to": req["to"],
                "amountIn": req["amount"], "amountOut": "990000", "minOut": "985000",
                "tx": {"chain": "base", "to": "0xrouter", "data": "0x", "value": "0"},
                "fee": fee,
                "feeTransfer": {"chain": "base", "to": treasury_addr, "amount": "500", "asset": req["from"]},
            }

    venue = V()

    class Reg:
        def list(self):
            return [venue]

        def get(self, vid):
            return venue if vid == "evmdex" else None

        def for_chain(self, chain):
            return [venue] if venue.supports(chain) else []

    return Reg()


def _make_agent(provider, ctx, caps, confirm, **extra):
    return agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-test"},
        "caps": caps,
        "confirm": confirm,
        "ctx": ctx,
        **extra,
    }), provider


def test_runner_swap_confirm_commit_and_fee_leg():
    ctx, rec = _ctx_recording()
    ctx["venues"] = _venues_stub()
    provider = _ScriptedProvider([
        {"toolCalls": [{"id": "t1", "name": "swap",
                        "arguments": {"from": "USDC", "to": "WETH", "amount": "1000000",
                                      "chain": "base"}}]},
        {"text": "done"},
    ])
    confirmed = {"n": 0}

    async def confirm(summary):
        confirmed["n"] += 1
        return True

    handle = agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-test"},
        "caps": {"sessionUsd": 1000},
        "confirm": confirm,
        "ctx": ctx,
    })
    # swap the scripted provider in
    handle.runner.provider = provider

    out = run(handle.run("swap it"))
    assert out["reason"] == "end_turn"
    assert confirmed["n"] == 1                 # confirmation gate fired once
    assert rec["sent"] and rec["sent"][0]["venue"] == "evmdex"  # trade committed
    assert rec["fees"] == [{"chain": "base", "to": "0xtreasury",
                            "amount": "500", "asset": "USDC"}]    # mandatory fee leg sent
    # spend recorded for both trade and fee (usd estimate 10 each)
    assert handle.policy.spent_usd == pytest.approx(20.0)
    # audit log is intact + hash-chained, and contains a 'fee' entry
    v = handle.audit.verify()
    assert v["ok"] is True
    types = [e.get("type") for e in handle.audit.list()]
    assert "confirmation" in types and "fee" in types and "executed" in types


def test_runner_declined_confirmation_does_not_commit():
    ctx, rec = _ctx_recording()
    ctx["venues"] = _venues_stub()
    provider = _ScriptedProvider([
        {"toolCalls": [{"id": "t1", "name": "swap",
                        "arguments": {"from": "USDC", "to": "WETH", "amount": "1000000",
                                      "chain": "base"}}]},
        {"text": "ok, cancelled"},
    ])
    handle = agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-test"},
        "caps": {"sessionUsd": 1000},
        "confirm": lambda s: False,   # user declines
        "ctx": ctx,
    })
    handle.runner.provider = provider
    run(handle.run("swap it"))
    assert rec["sent"] == [] and rec["fees"] == []       # nothing moved
    assert handle.policy.spent_usd == 0


def test_runner_over_cap_blocks_commit_as_tool_error():
    ctx, rec = _ctx_recording()
    ctx["venues"] = _venues_stub()
    provider = _ScriptedProvider([
        {"toolCalls": [{"id": "t1", "name": "swap",
                        "arguments": {"from": "USDC", "to": "WETH", "amount": "1000000",
                                      "chain": "base"}}]},
        {"text": "cannot"},
    ])
    # cap below the (trade+fee = $20) action
    handle = agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-test"},
        "caps": {"sessionUsd": 5},
        "confirm": lambda s: True,
        "ctx": ctx,
    })
    handle.runner.provider = provider
    run(handle.run("swap it"))
    assert rec["sent"] == [] and rec["fees"] == []
    # the tool result fed back to the model is an error (recoverable)
    tool_msg = [m for m in handle.runner.messages if m.get("role") == "tool"][0]
    assert tool_msg["results"][0]["isError"] is True
    assert "cap exceeded" in tool_msg["results"][0]["content"].lower()


def test_runner_kill_stops_loop():
    ctx, rec = _ctx_recording()
    ctx["venues"] = _venues_stub()
    provider = _ScriptedProvider([
        {"toolCalls": [{"id": "t1", "name": "swap",
                        "arguments": {"from": "USDC", "to": "WETH", "amount": "1000000",
                                      "chain": "base"}}]},
    ])
    handle = agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-test"},
        "caps": {"sessionUsd": 1000},
        "confirm": lambda s: True,
        "ctx": ctx,
    })
    handle.runner.provider = provider

    async def scenario():
        await handle.kill("user tapped kill")
        return await handle.run("swap it")

    out = run(scenario())
    assert out["stopped"] is True and out["reason"] == "killed"
    assert rec["sent"] == []


def test_fail_closed_when_venue_has_no_fee():
    """A venue that cannot route the 0.05% fee must make the swap refuse."""
    ctx, rec = _ctx_recording()

    class V:
        id = "evmdex"
        kind = "aggregator"
        chains = ["base"]

        def supports(self, chain):
            return True

        async def build_swap(self, req):
            return {"venue": "evmdex", "chain": "base", "from": req["from"], "to": req["to"],
                    "amountIn": req["amount"], "amountOut": "1", "minOut": "1",
                    "fee": None, "feeTransfer": None}  # no fee -> must fail closed

    class Reg:
        def list(self):
            return [V()]

        def get(self, vid):
            return V()

        def for_chain(self, chain):
            return [V()]

    ctx["venues"] = Reg()
    provider = _ScriptedProvider([
        {"toolCalls": [{"id": "t1", "name": "swap",
                        "arguments": {"from": "USDC", "to": "WETH", "amount": "1000000",
                                      "chain": "base"}}]},
        {"text": "refused"},
    ])
    handle = agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-test"},
        "caps": {"sessionUsd": 1000},
        "confirm": lambda s: True,
        "ctx": ctx,
    })
    handle.runner.provider = provider
    run(handle.run("swap it"))
    assert rec["sent"] == []
    tool_msg = [m for m in handle.runner.messages if m.get("role") == "tool"][0]
    assert tool_msg["results"][0]["isError"] is True
    assert "fail closed" in tool_msg["results"][0]["content"].lower()


# ----------------------------------------------------------------- audit chain


def test_audit_hash_chain_tamper_evident():
    a = audit_mod.create({})
    run(a.record({"type": "prompt", "text": "hi"}))
    run(a.record({"type": "tool_call", "name": "quote"}))
    run(a.record({"type": "executed", "name": "quote"}))
    assert a.verify()["ok"] is True
    # tamper with a past entry -> verify breaks
    a.entries[1]["name"] = "send"
    res = a.verify()
    assert res["ok"] is False and res["at"] == 1


def test_tool_registry_schemas_hide_handlers():
    reg = tools_mod.build({})
    for s in reg.schemas():
        assert set(s.keys()) == {"name", "description", "parameters"}
    assert "swap" in reg.value_moving_names()
    assert "quote" not in reg.value_moving_names()
