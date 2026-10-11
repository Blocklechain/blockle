"""Regression tests for the four Blockle-Bots engine fixes (docs/BLOCKLE-BOTS.md
§2,5-7), ported 1:1 from the JS reference ``blockle-extension/agent/
bot-runner.test.js``. Keeps the Python wallet behaviourally identical to the JS
reference + the authoritative ``docs/bot-vectors.json``.

  * FIX-GRID       — a grid BUY carries only qty (+ level price); it must size from
                     qty*levelPrice and fill (paper) / dispatch (live) EXACTLY like
                     DCA, honouring the allocation cap.
  * FIX-ALLOC-FEE  — the committed-spend ledger bounds trade + the 0.05% agent fee.
  * FIX-CANCEL     — a live fill STORES its orderId onto the level and kill cancels
                     it through the ONE audited dispatch (not a bare commit).
  * FIX-EST        — a live scheduled order with a null USD estimate FAILS CLOSED
                     (skipped:allocation-unknown), never treated as $0.
"""

from __future__ import annotations

import asyncio
import json
import os

from blockle.agent import audit as audit_mod
from blockle.agent import bot_runner as br_mod
from blockle.agent import bots as bots_mod
from blockle.agent import policy as policy_mod

_VECTORS_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "docs", "bot-vectors.json"))
with open(_VECTORS_PATH, "r", encoding="utf-8") as _f:
    VECTORS = json.load(_f)


def run(coro):
    return asyncio.run(coro)


STABLE = {"USDC", "USDT", "DAI", "USD"}


def fake_tools():
    """A value-moving tools registry whose commit() counts broadcasts and returns an
    exchange orderId for place_order (so FIX-CANCEL can record + cancel it)."""
    state = {"commits": 0, "committed": []}

    def mk(name):
        async def prepare(a):
            frm = a.get("from") or a.get("asset") or "X"
            amt = float(a.get("amount")) if a.get("amount") is not None else 0.0
            usd = amt / 1e6 if str(frm).upper() in STABLE else amt / 1e8

            async def commit():
                state["commits"] += 1
                state["committed"].append({"name": name, "args": a, "usd": usd})
                res = {"txid": "tx" + str(state["commits"]), "accepted": True}
                if name == "place_order":
                    res["orderId"] = "ord" + str(state["commits"])
                return res

            return {
                "summary": {"action": name, "from": frm, "to": a.get("to"),
                            "amount": a.get("amount"), "venue": a.get("venue")},
                "value": {"asset": frm, "amount": a.get("amount") or "0", "usd": usd},
                "commit": commit,
            }

        return {"name": name, "valueMoving": True, "prepare": prepare}

    tmap = {"swap": mk("swap"), "place_order": mk("place_order"), "cancel_order": mk("cancel_order")}

    class Reg:
        def get(self, n):
            return tmap.get(n)

        def names(self):
            return list(tmap.keys())

        def value_moving_names(self):
            return list(tmap.keys())

    return state, Reg()


def mk_ctx(price_seq):
    marks = list(price_seq)
    counter = {"i": 0, "t": 0}

    async def prices(symbols=None):
        p = marks[min(counter["i"], len(marks) - 1)]
        counter["i"] += 1
        return {"BLOCK": p, "USDC": 1}

    return {"now": lambda: counter["t"], "network": lambda: "testnet", "prices": prices}


def setup(opts=None):
    opts = opts or {}
    audit = audit_mod.create({})
    session_usd = opts["sessionUsd"] if "sessionUsd" in opts else 1000
    policy = policy_mod.create({"caps": {"sessionUsd": session_usd}, "confirm": opts.get("confirm"),
                                "audit": audit, "onKill": opts.get("onKill")})
    state, tools = fake_tools()
    policy.set_allowlist(tools.names())
    runner = br_mod.create({
        "policy": policy, "tools": tools, "audit": audit, "ctx": opts.get("ctx") or mk_ctx([100]),
        "Bots": bots_mod, "mainnetEnabled": opts.get("mainnetEnabled") is True,
        "discovery": opts.get("discovery"),
    })
    return {"runner": runner, "policy": policy, "tools": tools, "state": state, "audit": audit}


def skips(audit, reason):
    return [e for e in audit.list() if e.get("type") == "bot_skip" and e.get("reason") == reason]


# =========================================================================== #
# FIX-GRID: grid bots fill end-to-end (paper) — a buy level now simulates a    #
# fill instead of throwing (it used to read order.usdSizeUc, which a grid buy  #
# lacks -> KeyError swallowed as bot_error).                                   #
# =========================================================================== #
def test_grid_paper_buy_fills_and_never_broadcasts():
    ctx = mk_ctx([1.00, 0.95])  # seed the ladder at mid 1.00, then dip to 0.95
    S = setup({"ctx": ctx})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "grid", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"lowerPrice": 0.9, "upperPrice": 1.1, "gridCount": 4, "totalUsd": 40}})
    bot.mode = "paper"
    bot.enabled = True

    run(runner.tick_bot(bot.id))  # seeds the ladder (mid 1.00, no fill)
    run(runner.tick_bot(bot.id))  # dip to 0.95 -> a grid BUY fills (used to throw -> bot_error)

    assert state["commits"] == 0, "PAPER grid never broadcasts"
    assert not any(e.get("type") == "bot_error" for e in audit.list()), \
        "a grid buy no longer throws + is swallowed as bot_error"
    assert any(e.get("type") == "bot_paper_fill" and e.get("side") == "buy" and e.get("kind") == "grid"
               for e in audit.list()), "a grid buy simulated a fill"
    ps = bot.state["byPair"]["BLOCK/USDC"]
    assert any(l["heldQty"] > 0 for l in ps["deal"]["levels"]), \
        "inventory is held on the armed sell one grid up"


# =========================================================================== #
# FIX-GRID + allocation: a LIVE grid routes through the ONE dispatch and can   #
# never spend past allocationUsd (the same hard cap DCA respects).            #
# =========================================================================== #
def test_grid_live_routes_one_dispatch_and_respects_allocation():
    ctx = mk_ctx([1.00, 0.80])  # seed at 1.00, then crash: every buy level is fillable

    async def confirm(_s):
        return True

    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "grid", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"lowerPrice": 0.80, "upperPrice": 1.20, "gridCount": 10, "totalUsd": 100}})
    run(runner.arm_live(bot.id, {"allocationUsd": 25}))  # only ~2 x $10 levels fit

    run(runner.tick_bot(bot.id))  # seed ladder (mid 1.00)
    run(runner.tick_bot(bot.id))  # crash: fill until allocation is exhausted, then refuse

    assert state["commits"] >= 1, "a live grid buy broadcast through place_order"
    assert all(c["name"] == "place_order" for c in state["committed"]), \
        "every grid order went through the ONE value-moving dispatch (place_order)"
    d = runner.dashboard(bot.id, {"BLOCK": 0.80})
    assert d["committedUsd"] <= 25 + 1e-9, \
        "cumulative live spend never exceeds allocationUsd, got " + str(d["committedUsd"])
    assert len(skips(audit, "allocation")) >= 1, \
        "an over-allocation level was refused (audited skipped:allocation)"


# =========================================================================== #
# FIX-GRID: the fill-flip still reproduces the AUTHORITATIVE fixture EXACTLY   #
# (the added orderId line must not perturb the deal numbers).                 #
# =========================================================================== #
def test_grid_fill_flip_still_matches_vectors():
    V = VECTORS["grid_ladder"]
    B = bots_mod
    cfg = B.validate_config("grid", V["config"])
    bd = V["decimals"]
    deal = B.new_grid_deal("t", cfg, int(V["midUc"]), bd, 0)
    for st in V["steps"]:
        mark_uc = B.micro_usd(st["markUsd"])
        guard = 0
        while guard < 64:
            guard += 1
            order = B.grid_step(deal, mark_uc)
            if not order:
                break
            if order["side"] == "buy":
                fill = {"side": "buy", "qty": order["qty"], "priceUc": mark_uc,
                        "costUc": B.value_of(order["qty"], mark_uc, bd), "bd": bd, "paper": True}
            else:
                fill = {"side": "sell", "qty": order["qty"], "priceUc": mark_uc,
                        "proceedsUc": B.value_of(order["qty"], mark_uc, bd), "bd": bd, "paper": True}
            B.grid_apply(deal, order, fill, 0)
    assert str(deal["realizedUc"]) == V["realizedUc"]


# =========================================================================== #
# FIX-ALLOC-FEE: the committed-spend ledger bounds the TRUE outflow = trade +  #
# the mandatory 0.05% agent fee (checked before firing, accrued after).       #
# =========================================================================== #
def test_allocation_ledger_accrues_trade_plus_fee():
    ctx = mk_ctx([100])
    S = setup({"ctx": ctx, "sessionUsd": 1000})
    runner, state = S["runner"], S["state"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 200, "maxSafetyOrders": 0, "takeProfitPct": 50}})
    run(runner.arm_live(bot.id, {"allocationUsd": 300}))

    run(runner.tick_bot(bot.id))  # base $200 + 0.05% fee ($0.10) -> committed $200.10
    assert state["commits"] == 1
    d = runner.dashboard(bot.id, {"BLOCK": 100})
    assert abs(d["committedUsd"] - 200.10) < 1e-6, \
        "committed = trade + fee ($200.10), got " + str(d["committedUsd"])
    assert abs(d["remainingUsd"] - 99.90) < 1e-6, \
        "remaining reflects trade + fee, got " + str(d["remainingUsd"])


def test_agent_fee_uc_helper():
    B = bots_mod
    assert B.agent_fee_uc(B.micro_usd(200)) == B.micro_usd(0.10)  # 0.05% of $200 = $0.10
    assert B.agent_fee_uc(0) == 0
    assert B.agent_fee_uc(None) == 0


# =========================================================================== #
# FIX-CANCEL: a LIVE fill records its exchange orderId onto the level, and     #
# KILL cancels it through the ONE audited dispatch (never a bare commit).     #
# =========================================================================== #
def test_kill_records_orderid_and_cancels_through_gate():
    ctx = mk_ctx([1.00, 0.95])

    async def confirm(_s):
        return True

    async def on_kill(_r):
        pass

    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm, "onKill": on_kill})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "grid", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"lowerPrice": 0.9, "upperPrice": 1.1, "gridCount": 4, "totalUsd": 40}})
    run(runner.arm_live(bot.id, {"allocationUsd": 50}))

    run(runner.tick_bot(bot.id))  # seed ladder
    run(runner.tick_bot(bot.id))  # a buy level fills LIVE via place_order -> orderId recorded

    ps = bot.state["byPair"]["BLOCK/USDC"]
    with_id = [l for l in ps["deal"]["levels"] if l.get("orderId")]
    assert len(with_id) >= 1, "the live fill STORED its exchange orderId onto the level"
    order_id = with_id[0]["orderId"]

    commits_before = state["commits"]
    run(runner.kill_all("panic"))

    assert any(e.get("type") == "bot_dispatch" and e.get("tool") == "cancel_order" for e in audit.list()), \
        "the cancel routed through the ONE audited dispatch (not a bare prepare().commit())"
    assert any(c["name"] == "cancel_order" and c["args"].get("orderId") == order_id
               for c in state["committed"]), "kill cancelled exactly the recorded orderId"
    assert state["commits"] > commits_before, "the cancel went through the one shared commit path"


# =========================================================================== #
# FIX-EST: a LIVE scheduled-strategy order with NO usd estimate must FAIL      #
# CLOSED (null estUsd must NOT be treated as $0); a finite one accrues         #
# trade + fee.                                                                #
# =========================================================================== #
def test_scheduled_live_null_estimate_fails_closed():
    ctx = mk_ctx([100])

    class _Strat:
        def validate_params(self, p):
            return p

        async def plan(self, _ctx, _params):
            return [
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "1"},
                 "tag": "no-est", "estUsd": None, "mainnet": False},
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "2"},
                 "tag": "has-est", "estUsd": 10, "mainnet": False},
            ]

    class _Registry:
        def get(self, type_):
            return _Strat() if type_ == "momentum" else None

    class _Strategies:
        def default_registry(self):
            return _Registry()

    S = setup({"ctx": ctx, "sessionUsd": 1000})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    runner.Strategies = _Strategies()
    bot = runner.add({"type": "momentum", "universe": {"pairs": ["BLOCK/USDC"]}, "config": {}})
    run(runner.arm_live(bot.id, {"allocationUsd": 100}))

    rep = run(runner.tick_bot(bot.id))
    ev = rep["events"]
    assert any(e.get("tag") == "no-est" and e.get("skipped") == "allocation-unknown" for e in ev), \
        "the null-estimate order failed closed (not treated as $0)"
    assert any(e.get("tag") == "has-est" and e.get("executed") for e in ev), \
        "the finite-estimate order executed"
    assert len(skips(audit, "allocation-unknown")) == 1, "audited skipped:allocation-unknown"
    assert state["commits"] == 1, "only the finite-estimate order broadcast"
    d = runner.dashboard(bot.id, {"BLOCK": 100})
    assert abs(d["committedUsd"] - 10.005) < 1e-6, \
        "only the finite order accrued (trade $10 + fee $0.005), got " + str(d["committedUsd"])
