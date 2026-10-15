"""tests/test_agent_command.py — the NATURAL-LANGUAGE COMMAND BAR router.

Faithful port of ``blockle-extension/agent/command.test.js``. The command bar
adds NO new power: a MOCK agent only PROPOSES tool-calls over the EXISTING
registry (:func:`tools.build`), and the EXISTING gate (policy +
``runner.dispatch_prepared``) enforces every fund move. These tests inject a
mock provider (canned tool-calls / answers) and assert the safety contract
holds end-to-end:

  1. a send intent routes through the ONE gate; a declined confirm => zero commits
  2. "alice.eth" is resolved and the RESOLVED address is inspected/confirmed/sent
  3. a "rebalance" yielding multiple swaps gates EACH step
  4. a bot-P&L query answers from the real dashboard/ledger for a 7-day window,
     and an unavailable source => honest "unavailable" (never fabricated)
  5. a query cannot invoke send/swap (read-only tool set)
  6. THE INVARIANT — a huge send proposed via NL is hard-capped by the gate and
     never commits, exactly like any other agent call
  7. the command router drives value through runner.dispatch_prepared — no
     second broadcast path was introduced by the command bar
"""

from __future__ import annotations

import asyncio
import inspect

from blockle.agent import command as command_mod
from blockle.agent import policy as policy_mod
from blockle.agent import runner as runner_mod
from blockle.agent import tools as tools_mod

DAY_MS = 86400000
RAW_EOA = "0x" + "a" * 40
RESOLVED = "0x" + "b" * 40


def run(coro):
    return asyncio.run(coro)


class _MockAgent:
    """A mock provider. A classification call offers NO tools -> answer with the
    scripted `intent`. Any call that offers tools replays the next scripted turn
    ({text?, toolCalls?}), exactly like a real provider.turn would."""

    def __init__(self, intent="query", turns=None):
        self._intent = intent
        self._turns = list(turns or [])
        self._i = 0

    async def turn(self, req):
        tools = req.get("tools")
        if not tools:
            return {"intent": self._intent}
        if self._i < len(self._turns):
            t = self._turns[self._i]
            self._i += 1
            return t
        return {"text": "done"}


def _make_ctx(over=None):
    """A minimal wallet wiring ctx for tools.build. Counts broadcasts/commits so a
    test can prove nothing moved. Overridable per test."""
    over = over or {}
    calls = {"broadcast": 0, "buildSend": 0, "swap": 0, "confirm": 0}

    async def get_address(chain):
        return "0xADDR"

    async def get_balance(chain, tokens=None):
        return [{"asset": {"symbol": str(chain).upper(), "decimals": 18},
                 "confirmed": "5000000000000000000"}]

    async def estimate_usd(sym, amt):
        if "estimateUsd" in over:
            return await _maybe(over["estimateUsd"](sym, amt))
        return 100.0

    async def build_send(chain, p):
        calls["buildSend"] += 1
        if "buildSend" in over:
            return await _maybe(over["buildSend"](chain, p))
        return {"fee": "21000", "txid": "0xbuilt"}

    async def broadcast(chain, built):
        calls["broadcast"] += 1
        if "broadcast" in over:
            return await _maybe(over["broadcast"](chain, built))
        return {"txid": "0xtx", "accepted": True}

    async def inspect(chain, intent):
        if "inspect" in over:
            return await _maybe(over["inspect"](chain, intent))
        return None

    ctx = {
        "getAddress": get_address,
        "getBalance": get_balance,
        "estimateUsd": estimate_usd,
        "buildSend": build_send,
        "broadcast": broadcast,
        "inspect": inspect,
    }
    if "venues" in over:
        ctx["venues"] = over["venues"]
    if "executeSwap" in over:
        ctx["executeSwap"] = over["executeSwap"]
    if "sendFee" in over:
        ctx["sendFee"] = over["sendFee"]
    ctx["_calls"] = calls
    return ctx


async def _maybe(v):
    if inspect.isawaitable(v):
        return await v
    return v


def _venue_stub(swap_counter, treasury="0xtreasury"):
    class V:
        id = "evmdex"
        kind = "aggregator"
        chains = ["base"]

        def supports(self, chain):
            return chain in ("base", "ethereum")

        async def build_swap(self, req):
            fee = {"bps": 5, "chain": "base", "asset": req["from"], "amount": "500",
                   "treasury": treasury}
            return {
                "venue": "evmdex", "chain": "base", "from": req["from"], "to": req["to"],
                "amountIn": req["amount"], "amountOut": "990000", "minOut": "985000",
                "tx": {"chain": "base", "to": "0xrouter", "data": "0x", "value": "0"},
                "fee": fee,
                "feeTransfer": {"chain": "base", "to": treasury, "amount": "500", "asset": req["from"]},
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


# ---------------------------------------------------------------------------
# 1. a send intent routes through the ONE gate; declined confirm => zero commits
# ---------------------------------------------------------------------------
def test_send_intent_goes_through_the_one_gate_declined_commits_nothing():
    ctx = _make_ctx()

    def confirm(_s):
        ctx["_calls"]["confirm"] += 1
        return False

    policy = policy_mod.create({"confirm": confirm})
    provider = _MockAgent(intent="action", turns=[
        {"toolCalls": [{"id": "1", "name": "send",
                        "arguments": {"chain": "ethereum", "to": RAW_EOA,
                                      "amount": "100000000000000000"}}]},
        {"text": "I did not send anything — you declined."},
    ])
    router = command_mod.create({"provider": provider,
                                 "tools": tools_mod.build(ctx), "policy": policy})

    r = run(router.run("send 0.1 ETH to " + RAW_EOA))
    assert r["intent"] == "action"
    assert ctx["_calls"]["confirm"] == 1, "the human was asked to confirm"
    assert ctx["_calls"]["broadcast"] == 0, "a declined confirm must broadcast NOTHING"
    step = next(s for s in r["steps"] if s["name"] == "send")
    assert step["status"] == "declined"


# ---------------------------------------------------------------------------
# 2. a name is resolved and the RESOLVED address is inspected/confirmed/sent
# ---------------------------------------------------------------------------
def test_name_resolved_and_resolved_address_used_throughout():
    seen = {}

    async def build_send(chain, p):
        seen["built"] = p["to"]
        return {"fee": "21000", "txid": "0xbuilt"}

    async def do_inspect(chain, intent):
        seen["inspected"] = intent.get("to")
        return None

    async def do_broadcast(chain, built):
        seen["broadcastTxid"] = built.get("txid")
        return {"txid": "0xtx", "accepted": True}

    ctx = _make_ctx({"buildSend": build_send, "inspect": do_inspect, "broadcast": do_broadcast})

    def confirm(s):
        seen["confirmed"] = s.get("to")
        return True

    policy = policy_mod.create({"confirm": confirm})

    async def resolve_name(input_, chain, _ctx=None):
        if input_ == "alice.eth":
            return {"address": RESOLVED, "source": "ens", "name": input_}
        return None

    events = []
    provider = _MockAgent(intent="action", turns=[
        {"toolCalls": [{"id": "1", "name": "send",
                        "arguments": {"chain": "ethereum", "to": "alice.eth",
                                      "amount": "100000000000000000"}}]},
        {"text": "Sent to alice.eth."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(ctx),
                                 "policy": policy, "resolveName": resolve_name,
                                 "onEvent": lambda e: events.append(e)})

    run(router.run("send 0.1 ETH to alice.eth"))

    assert seen["built"] == RESOLVED, "the built tx goes to the RESOLVED address"
    assert seen["inspected"] == RESOLVED, "the security inspection sees the RESOLVED address"
    assert seen["confirmed"] == RESOLVED, "the human confirms the RESOLVED address"
    assert ctx["_calls"]["broadcast"] == 1
    res = next((e for e in events if e.get("type") == "resolved"), None)
    assert res and res["input"] == "alice.eth" and res["address"] == RESOLVED and res["source"] == "ens", \
        "a resolved event surfaced the name -> address mapping to the UI"


def test_recipient_name_that_does_not_resolve_is_a_hard_error():
    ctx = _make_ctx()
    policy = policy_mod.create({"confirm": lambda s: True})

    async def resolve_name(input_, chain, _ctx=None):
        return None  # nothing resolves

    provider = _MockAgent(intent="action", turns=[
        {"toolCalls": [{"id": "1", "name": "send",
                        "arguments": {"chain": "ethereum", "to": "nobody.eth", "amount": "1"}}]},
        {"text": "Could not resolve the recipient."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(ctx),
                                 "policy": policy, "resolveName": resolve_name})
    r = run(router.run("send 1 wei to nobody.eth"))
    assert ctx["_calls"]["broadcast"] == 0
    step = next(s for s in r["steps"] if s["name"] == "send")
    assert step["status"] == "error"
    assert "resolve" in step["error"].lower()


# ---------------------------------------------------------------------------
# 3. a "rebalance" yielding multiple swaps gates EACH step
# ---------------------------------------------------------------------------
def test_rebalance_sequence_of_swaps_each_gets_its_own_confirm():
    swap_count = {"n": 0}

    async def execute_swap(built):
        swap_count["n"] += 1
        return {"txid": "0xswap" + str(swap_count["n"]), "accepted": True}

    async def send_fee(xfer):
        return {"txid": "0xfee"}

    ctx = _make_ctx({
        "estimateUsd": lambda sym, amt: 10.0,
        "venues": _venue_stub(swap_count),
        "executeSwap": execute_swap,
        "sendFee": send_fee,
    })

    gate = {"n": 0}

    def confirm(_s):
        gate["n"] += 1
        return True

    policy = policy_mod.create({"confirm": confirm})
    events = []
    provider = _MockAgent(intent="action", turns=[
        {"toolCalls": [
            {"id": "1", "name": "swap", "arguments": {"from": "USDC", "to": "ETH", "amount": "60000000"}},
            {"id": "2", "name": "swap", "arguments": {"from": "ETH", "to": "USDC", "amount": "40000000"}},
        ]},
        {"text": "Rebalanced to 60/40."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(ctx),
                                 "policy": policy, "onEvent": lambda e: events.append(e)})

    r = run(router.run("rebalance to 60/40 stables"))
    assert gate["n"] == 2, "EACH of the two swaps triggered its OWN confirm sheet"
    assert swap_count["n"] == 2, "both legs committed after their individual confirms"
    plan = next((e for e in events if e.get("type") == "plan"), None)
    assert plan and len(plan["steps"]) == 2, "the multi-step plan was surfaced before executing"
    assert len([s for s in r["steps"] if s["status"] == "committed"]) == 2


# ---------------------------------------------------------------------------
# 4. a bot-P&L query answers from the real dashboard/ledger for a 7-day window,
#    and an unavailable source => honest "unavailable" (never fabricated)
# ---------------------------------------------------------------------------
def test_bot_pnl_query_reads_real_engine_over_7_day_window_never_fabricates():
    NOW = 1_700_000_000_000
    since_seen = {}

    async def bots_pnl(opts):
        since_seen["sinceMs"] = opts.get("sinceMs")
        since_seen["days"] = opts.get("days")
        return {
            "realizedUsd": 42.5,
            "bots": [
                {"id": "b1", "name": "DCA BLOCK", "realizedUsd": 42.5, "unrealizedUsd": 3.0},
                {"id": "b2", "name": "Grid ETH", "realizedUsd": -5.0, "unrealizedUsd": 1.0},
            ],
        }

    policy = policy_mod.create({"confirm": lambda s: True})
    provider = _MockAgent(intent="query", turns=[
        {"toolCalls": [{"id": "1", "name": "bots_pnl", "arguments": {"days": 7}}]},
        {"text": "DCA BLOCK made the most this week: +$42.50 realized."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(_make_ctx()),
                                 "policy": policy, "engines": {"botsPnl": bots_pnl},
                                 "now": lambda: NOW})

    r = run(router.run("which bot made money this week?"))
    assert r["intent"] == "query"
    assert since_seen, "the real bot-P&L engine was consulted"
    assert since_seen["days"] == 7, "a 7-day 'this week' window"
    assert since_seen["sinceMs"] == NOW - 7 * DAY_MS, \
        "window start = now - 7 days (clock injected, not fabricated)"

    # the engine tool returns ONLY the engine's own numbers (no fabrication).
    tool = router._query_registry().get("bots_pnl")
    out = run(tool["run"]({"days": 7}))
    assert out["available"] is True
    assert out["windowDays"] == 7
    assert out["realizedUsd"] == 42.5
    assert out["bots"][0]["realizedUsd"] == 42.5


def test_bot_pnl_query_with_no_engine_answers_honest_unavailable():
    policy = policy_mod.create({"confirm": lambda s: True})
    provider = _MockAgent(intent="query", turns=[
        {"toolCalls": [{"id": "1", "name": "bots_pnl", "arguments": {"days": 7}}]},
        {"text": "I cannot tell right now — bot P&L is unavailable."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(_make_ctx()),
                                 "policy": policy, "engines": {}})  # none wired

    run(router.run("which bot made money this week?"))
    tool = router._query_registry().get("bots_pnl")
    out = run(tool["run"]({"days": 7}))
    assert out["available"] is False, "an unavailable source is reported honestly"
    assert "realizedUsd" not in out, "no fabricated P&L number is invented when unavailable"
    assert "unavailable" in out["reason"].lower() or "not available" in out["reason"].lower()


def test_net_worth_query_reads_real_portfolio_engine():
    async def net_worth():
        return {"totalUsd": 12345.67, "byChain": {"ethereum": 10000.0, "block": 2345.67},
                "unpriced": [], "asOf": 1_700_000_000_000}

    policy = policy_mod.create({"confirm": lambda s: True})
    provider = _MockAgent(intent="query", turns=[
        {"toolCalls": [{"id": "1", "name": "net_worth", "arguments": {}}]},
        {"text": "Your net worth is about $12,345.67."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(_make_ctx()),
                                 "policy": policy, "engines": {"netWorth": net_worth}})

    r = run(router.run("what is my net worth?"))
    assert r["intent"] == "query"
    tool = router._query_registry().get("net_worth")
    out = run(tool["run"]({}))
    assert out["available"] is True
    assert out["totalUsd"] == 12345.67


# ---------------------------------------------------------------------------
# 5. a query cannot invoke send/swap (read-only tool set)
# ---------------------------------------------------------------------------
def test_query_runs_in_read_only_tool_set_proposed_send_is_blocked():
    ctx = _make_ctx()
    policy = policy_mod.create({"confirm": lambda s: True})  # would approve, but send is unreachable
    events = []
    # the mock agent MISBEHAVES: during a query it proposes a value-moving send.
    provider = _MockAgent(intent="query", turns=[
        {"toolCalls": [{"id": "1", "name": "send",
                        "arguments": {"chain": "ethereum", "to": RAW_EOA, "amount": "1"}}]},
        {"text": "I can only answer questions here."},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(ctx),
                                 "policy": policy, "onEvent": lambda e: events.append(e)})

    run(router.run("how much ETH do I have?"))
    assert ctx["_calls"]["broadcast"] == 0, "a query can never reach a value-moving tool"
    err = next((e for e in events if e.get("type") == "tool_error" and e.get("name") == "send"), None)
    assert err, "the stripped send tool was rejected by the allowlist"
    assert "allow" in err["error"].lower()

    # and the read-only registry never even OFFERS a value-moving tool to the model.
    schemas = [s["name"] for s in router._query_registry().schemas()]
    assert "send" not in schemas and "swap" not in schemas, \
        "value tools are not offered during a query"


# ---------------------------------------------------------------------------
# 6. THE INVARIANT — a huge send proposed via NL is hard-capped and never commits
# ---------------------------------------------------------------------------
def test_invariant_huge_nl_send_is_hard_capped_and_commits_nothing():
    def est(sym, amt):
        return (float(amt) / 1e18) * 2000  # ~$2000/ETH

    ctx = _make_ctx({"estimateUsd": est})

    def confirm(_s):
        ctx["_calls"]["confirm"] += 1
        return True

    policy = policy_mod.create({"caps": {"sessionUsd": 100}, "confirm": confirm})
    events = []
    provider = _MockAgent(intent="action", turns=[
        # 1000 ETH == ~$2,000,000, far over the $100 session cap
        {"toolCalls": [{"id": "1", "name": "send",
                        "arguments": {"chain": "ethereum", "to": RAW_EOA,
                                      "amount": "1000000000000000000000"}}]},
        {"text": "done"},
    ])
    router = command_mod.create({"provider": provider, "tools": tools_mod.build(ctx),
                                 "policy": policy, "onEvent": lambda e: events.append(e)})

    r = run(router.run("send 1000 ETH to " + RAW_EOA))
    assert ctx["_calls"]["broadcast"] == 0, "the hard cap blocked the send BEFORE any broadcast"
    assert ctx["_calls"]["confirm"] == 0, \
        "the cap rejects pre-confirm — the human is never asked to approve an over-cap move"
    err = next((e for e in events if e.get("type") == "step_error" and e.get("name") == "send"), None)
    assert err, "the step errored"
    assert "cap" in err["error"].lower(), "it failed with a cap-exceeded error, like any other agent call"
    step = next(s for s in r["steps"] if s["name"] == "send")
    assert step["status"] == "error"


# ---------------------------------------------------------------------------
# 7. the command router drives value through runner.dispatch_prepared (no 2nd path)
# ---------------------------------------------------------------------------
def test_command_router_drives_value_through_runner_dispatch_prepared():
    assert callable(getattr(runner_mod, "dispatch_prepared", None))
    assert "dispatch_prepared" in inspect.getsource(command_mod.CommandRouter)
