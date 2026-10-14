"""Gate-integration tests for the BotRunner (docs/BLOCKLE-BOTS.md §5-7).

The BotRunner routes bot orders through the SAME value-moving gate as the NL
runner + StrategyRunner (``runner.dispatch_prepared``). These tests prove:
  * the FULLY-AUTO-WITHIN-ALLOCATION gate is non-bypassable — a live order that
    would exceed allocationUsd does NOT fire and is NEVER prompted (audited
    skipped:allocation);
  * arming live without a finite allocation (<= the session cap) fails closed;
  * kill stops ALL bots + locks the vault;
  * PAPER never broadcasts;
  * a mainnet bot is refused when mainnetEnabled=False;
  * import lands paper + disabled;
  * a signal bot consumes the discovery feed;
  * no synthetic prices — a missing mark skips the tick.
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import audit as audit_mod
from blockle.agent import bot_runner as br_mod
from blockle.agent import bot_templates as bt_mod
from blockle.agent import bots as bots_mod
from blockle.agent import policy as policy_mod


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# test doubles                                                                #
# --------------------------------------------------------------------------- #

STABLE = {"USDC", "USDT", "DAI", "USD"}


def fake_tools():
    """A value-moving tools registry whose commit() counts broadcasts. It derives a
    USD value from the amount (stable `from` => amount/1e6, else amount/1e8) so the
    policy's USD-cap + auto-approve path exercises exactly as with the real swap."""
    state = {"commits": 0, "committed": []}

    def mk(name):
        async def prepare(a):
            frm = a.get("from") or a.get("asset") or "X"
            amt = float(a.get("amount")) if a.get("amount") is not None else 0.0
            usd = amt / 1e6 if str(frm).upper() in STABLE else amt / 1e8

            async def commit():
                state["commits"] += 1
                state["committed"].append({"name": name, "args": a, "usd": usd})
                return {"txid": "tx" + str(state["commits"]), "accepted": True}

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

    def now():
        return counter["t"]

    def network():
        return "testnet"

    async def prices(symbols=None):
        p = marks[min(counter["i"], len(marks) - 1)]
        counter["i"] += 1
        return {"BLOCK": p, "USDC": 1}

    return {"now": now, "network": network, "prices": prices}


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
# PAPER mode never broadcasts (and still records a simulated deal + pnl)       #
# =========================================================================== #
def test_paper_dca_never_broadcasts():
    ctx = mk_ctx([100, 90, 97])
    S = setup({"ctx": ctx})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 100, "safetyOrderUsd": 100, "maxSafetyOrders": 1,
                                 "safetyStepPct": 2, "takeProfitPct": 2}})
    bot.mode = "paper"
    bot.enabled = True

    run(runner.tick_bot(bot.id))  # base order
    run(runner.tick_bot(bot.id))  # safety order
    run(runner.tick_bot(bot.id))  # take-profit close

    assert state["commits"] == 0
    assert any(e.get("type") == "bot_paper_fill" for e in audit.list())
    d = runner.dashboard(bot.id, {"BLOCK": 94.2})
    assert d["mode"] == "paper"
    assert d["totalDeals"] >= 1


# =========================================================================== #
# LIVE within allocation: auto-approves through the ONE gate (no prompt)       #
# =========================================================================== #
def test_live_within_allocation_auto_approves_and_commits():
    asked = {"n": 0}

    async def confirm(_summary):
        asked["n"] += 1
        return True

    ctx = mk_ctx([100])
    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm})
    runner, state = S["runner"], S["state"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 20, "maxSafetyOrders": 0, "takeProfitPct": 5}})
    run(runner.arm_live(bot.id, {"allocationUsd": 50}))

    run(runner.tick_bot(bot.id))  # base order $20 <= remaining $50 -> auto
    assert asked["n"] == 0
    assert state["commits"] == 1
    d = runner.dashboard(bot.id, {"BLOCK": 100})
    assert round(d["committedUsd"]) == 20
    assert round(d["remainingUsd"]) == 30


# =========================================================================== #
# ALLOCATION GATE (critical): over-allocation order does NOT fire / no prompt  #
# =========================================================================== #
def test_allocation_gate_refuses_without_prompt():
    asked = {"n": 0}

    async def confirm(_summary):
        asked["n"] += 1
        return True

    ctx = mk_ctx([100, 90])
    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 8, "safetyOrderUsd": 5, "maxSafetyOrders": 3,
                                 "safetyStepPct": 2, "takeProfitPct": 50}})
    run(runner.arm_live(bot.id, {"allocationUsd": 10}))

    run(runner.tick_bot(bot.id))  # base $8 -> commits (auto)
    run(runner.tick_bot(bot.id))  # safety $5 -> would exceed $10 -> skipped:allocation

    assert state["commits"] == 1
    assert asked["n"] == 0
    assert len(skips(audit, "allocation")) == 1
    d = runner.dashboard(bot.id, {"BLOCK": 90})
    assert round(d["committedUsd"]) == 8


def test_allocation_gate_backstop_even_if_confirm_says_yes():
    async def confirm(_s):
        return True

    ctx = mk_ctx([100, 90])
    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 8, "safetyOrderUsd": 5, "maxSafetyOrders": 3,
                                 "safetyStepPct": 2, "takeProfitPct": 50}})
    run(runner.arm_live(bot.id, {"allocationUsd": 10}))
    run(runner.tick_bot(bot.id))
    run(runner.tick_bot(bot.id))
    assert state["commits"] == 1
    assert len(skips(audit, "allocation")) == 1


# =========================================================================== #
# Arming a LIVE bot fails closed without a finite allocation <= session cap    #
# =========================================================================== #
def test_arm_live_fails_closed_when_allocation_zero():
    S = setup({"sessionUsd": 1000})
    runner = S["runner"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]}})
    with pytest.raises(ValueError, match="allocationUsd must be > 0"):
        run(runner.arm_live(bot.id, {"allocationUsd": 0}))
    assert bot.mode == "paper"
    assert bot.enabled is False


def test_arm_live_fails_closed_without_session_cap():
    S = setup({"sessionUsd": None})
    runner = S["runner"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]}})
    with pytest.raises(ValueError, match="session USD cap is required"):
        run(runner.arm_live(bot.id, {"allocationUsd": 50}))


def test_arm_live_fails_closed_when_allocation_exceeds_session_cap():
    S = setup({"sessionUsd": 50})
    runner = S["runner"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]}})
    with pytest.raises(ValueError, match="exceeds the policy session cap"):
        run(runner.arm_live(bot.id, {"allocationUsd": 100}))


def test_arm_live_fails_closed_on_mainnet_when_disabled():
    S = setup({"sessionUsd": 1000, "mainnetEnabled": False})
    runner = S["runner"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]}, "network": "mainnet"})
    with pytest.raises(ValueError, match="mainnet"):
        run(runner.arm_live(bot.id, {"allocationUsd": 50}))


# =========================================================================== #
# mainnet gate: a live mainnet bot's order is refused when mainnetEnabled=False #
# =========================================================================== #
def test_mainnet_gate_blocks_order_when_disabled():
    async def confirm(_s):
        return True

    ctx = mk_ctx([100])
    S = setup({"ctx": ctx, "sessionUsd": 1000, "mainnetEnabled": False, "confirm": confirm})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 20, "maxSafetyOrders": 0}})
    # force a live mainnet bot directly (arming would fail closed — tested above)
    bot.mode = "live"
    bot.enabled = True
    bot.network = "mainnet"
    bot.allocation_usd = 50
    run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert len(skips(audit, "mainnet")) == 1


# =========================================================================== #
# KILL: stops ALL bots, (best-effort) cancels orders, and locks the vault      #
# =========================================================================== #
def test_kill_stops_all_bots_and_locks_vault():
    vault = {"locked": False}

    async def on_kill(_reason):
        vault["locked"] = True

    async def confirm(_s):
        return True

    ctx = mk_ctx([100])
    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm, "onKill": on_kill})
    runner, policy, state = S["runner"], S["policy"], S["state"]
    a = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                    "config": {"baseOrderUsd": 20, "maxSafetyOrders": 0}})
    b = runner.add({"type": "grid", "universe": {"pairs": ["BLOCK/USDC"]},
                    "config": {"lowerPrice": 0.9, "upperPrice": 1.1, "gridCount": 4, "totalUsd": 40}})
    run(runner.arm_live(a.id, {"allocationUsd": 50}))
    run(runner.enable_paper(b.id))

    run(runner.kill_all("panic"))

    assert policy.is_killed() is True
    assert vault["locked"] is True
    assert a.enabled is False
    assert b.enabled is False
    commits_before = state["commits"]
    r = run(runner.tick_bot(a.id))
    assert state["commits"] == commits_before
    assert r.get("killed") or r.get("skipped")


# =========================================================================== #
# import lands paper + disabled (and never auto-armed) — at the runner boundary #
# =========================================================================== #
def test_import_lands_paper_disabled_zero_allocation():
    S = setup({"sessionUsd": 1000})
    runner, state = S["runner"], S["state"]
    tpl = {"kind": "blockle-bot-template", "type": "dca", "name": "x",
           "universe": {"pairs": ["BLOCK/USDC"]}, "config": {"baseOrderUsd": 20},
           "mode": "live", "enabled": True, "allocationUsd": 999}
    bot = bt_mod.import_template(tpl)
    runner.add(bot)
    assert bot.mode == "paper"
    assert bot.enabled is False
    assert bot.allocation_usd == 0
    run(runner.tick_all())
    assert state["commits"] == 0


# =========================================================================== #
# signal bot: consumes the discovery feed and spawns a template per signal      #
# =========================================================================== #
def test_signal_bot_spawns_paper_deal_from_discovery():
    ctx = mk_ctx([100, 100, 100])

    class Disc:
        async def scan(self):
            return [{"pair": "BLOCK/USDC", "approved": True, "score": 0.9},
                    {"pair": "SCAM/USDC", "approved": False, "score": 0.9}]

    S = setup({"ctx": ctx, "sessionUsd": 1000, "discovery": Disc()})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "signal", "config": {"source": "discovery", "maxConcurrent": 2,
                                                   "onSignal": {"type": "dca", "config": {"baseOrderUsd": 10,
                                                                                          "maxSafetyOrders": 0}}}})
    bot.mode = "paper"
    bot.enabled = True
    run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert any(e.get("type") == "bot_signal" and e.get("pair") == "BLOCK/USDC" for e in audit.list())
    assert not any(e.get("type") == "bot_signal" and e.get("pair") == "SCAM/USDC" for e in audit.list())


# =========================================================================== #
# no synthetic prices: a missing mark skips the tick (audited)                 #
# =========================================================================== #
def test_no_synthetic_prices_skips_tick():
    async def prices(symbols=None):
        return {}

    ctx = {"now": lambda: 0, "network": lambda: "testnet", "prices": prices}
    S = setup({"ctx": ctx, "sessionUsd": 1000})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
                      "config": {"baseOrderUsd": 20}})
    bot.mode = "paper"
    bot.enabled = True
    run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert len(skips(audit, "price")) >= 1


# =========================================================================== #
# FIX-EST: a LIVE scheduled (rebalance/momentum) order must carry a FINITE,    #
# POSITIVE USD estimate or it FAILS CLOSED. null/NaN/inf coerce to $0 and a    #
# NEGATIVE estimate would accrue negative and EXPAND the allocation ledger —   #
# both would defeat the hard cap, so all are rejected (skipped).               #
# =========================================================================== #
def test_scheduled_live_nonfinite_or_negative_est_fails_closed():
    class _FakeStrat:
        def validate_params(self, cfg):
            return dict(cfg)

        async def plan(self, ctx, params):
            return [
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "1"}, "tag": "no-est", "estUsd": None, "mainnet": False},
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "9"}, "tag": "neg-est", "estUsd": -1000, "mainnet": False},
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "9"}, "tag": "nan-est", "estUsd": float("nan"), "mainnet": False},
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "9"}, "tag": "inf-est", "estUsd": float("inf"), "mainnet": False},
                {"tool": "swap", "args": {"from": "USDC", "to": "BLOCK", "amount": "2"}, "tag": "has-est", "estUsd": 10, "mainnet": False},
            ]

    class _FakeReg:
        def get(self, _type):
            return _FakeStrat()

    class _FakeStrategies:
        def default_registry(self):
            return _FakeReg()

    S = setup({"ctx": mk_ctx([100]), "sessionUsd": 1000})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    runner.Strategies = _FakeStrategies()
    bot = runner.add({"type": "momentum", "universe": {"pairs": ["BLOCK/USDC"]}, "config": {}})
    run(runner.arm_live(bot.id, {"allocationUsd": 100}))

    rep = run(runner.tick_bot(bot.id))
    ev = rep["events"]
    for tag in ("no-est", "neg-est", "nan-est", "inf-est"):
        assert any(e.get("tag") == tag and e.get("skipped") == "allocation-unknown" for e in ev), \
            tag + " must fail closed, not slip past the allocation cap"
    assert any(e.get("tag") == "has-est" and e.get("executed") for e in ev)
    assert state["commits"] == 1, "only the finite-positive estimate broadcast"
    # the ledger must never go negative / expand: exactly trade $10 + 0.05% fee accrued
    d = runner.dashboard(bot.id, {"BLOCK": 100})
    assert abs(d["committedUsd"] - 10.005) < 1e-6
    assert d["remainingUsd"] <= 100


# =========================================================================== #
# FIX-KILL: per-bot STOP / REMOVE, the background scheduler, and kill-all must  #
# genuinely halt a running bot (docs/BLOCKLE-BOTS.md §5).                       #
# =========================================================================== #
def _dca_spec(poll_sec=1):
    return {"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]},
            "config": {"baseOrderUsd": 50}, "pollSec": poll_sec}


def test_per_bot_stop_halts_disables_and_scheduler_skips():
    S = setup({"ctx": mk_ctx([100])})
    runner = S["runner"]
    bot = runner.add(_dca_spec())
    bot.mode = "paper"
    bot.enabled = True
    out = run(runner.stop(bot.id))
    assert out.enabled is False, "stop sets enabled=False"
    # it persists + the scheduler skips a disabled bot (tick is a clean no-op)
    rep = run(runner.tick_bot(bot.id))
    assert rep == {"bot": bot.id, "skipped": "disabled"}
    # the dashboard status reads 'stopped'
    assert runner.dashboard(bot.id)["status"] == "stopped"
    # a stop on an unknown bot fails closed
    with pytest.raises(ValueError):
        run(runner.stop("nope"))


def test_per_bot_remove_deletes_from_store():
    S = setup({"ctx": mk_ctx([100])})
    runner = S["runner"]
    bot = runner.add(_dca_spec())
    bot.enabled = True
    assert runner.get(bot.id) is not None
    assert run(runner.remove(bot.id)) is True
    assert runner.get(bot.id) is None
    assert runner.list() == []
    # removing an already-gone bot is a clean False (idempotent)
    assert run(runner.remove(bot.id)) is False


def test_scheduler_ticks_enabled_bot_then_stops_when_idle():
    async def main():
        audit = audit_mod.create({})
        policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "audit": audit})
        state, tools = fake_tools()
        policy.set_allowlist(tools.names())

        async def prices(symbols=None):
            return {"BLOCK": 100, "USDC": 1}

        # real wall-clock `now` (no ctx override) so pollSec due-logic fires.
        runner = br_mod.create({"policy": policy, "tools": tools, "audit": audit,
                                "ctx": {"network": lambda: "testnet", "prices": prices},
                                "Bots": bots_mod, "schedulerBaseSec": 0.01})
        bot = runner.add(_dca_spec(poll_sec=1))
        assert runner._scheduler_task is None
        await runner.enable_paper(bot.id)             # arming starts the scheduler
        assert runner._scheduler_task is not None

        for _ in range(100):
            await asyncio.sleep(0.01)
            if (bot.state.get("lastTickAt") or 0) > 0:
                break
        assert (bot.state.get("lastTickAt") or 0) > 0, "the scheduler actually ticked the bot"

        # STOP it -> no enabled bots remain -> the scheduler stops.
        await runner.stop(bot.id)
        assert bot.enabled is False
        assert runner._scheduler_task is None
        last = bot.state.get("lastTickAt")
        await asyncio.sleep(0.05)
        assert bot.state.get("lastTickAt") == last, "a stopped bot is never ticked again"

    run(main())


def test_kill_all_stops_scheduler_and_disables_every_bot():
    killed = {"n": 0}

    async def on_kill(_r=None):
        killed["n"] += 1

    async def main():
        audit = audit_mod.create({})
        policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "audit": audit, "onKill": on_kill})
        state, tools = fake_tools()
        policy.set_allowlist(tools.names())

        async def prices(symbols=None):
            return {"BLOCK": 100, "USDC": 1}

        runner = br_mod.create({"policy": policy, "tools": tools, "audit": audit,
                                "ctx": {"network": lambda: "testnet", "prices": prices},
                                "Bots": bots_mod, "schedulerBaseSec": 0.01})
        a = runner.add(_dca_spec()); b = runner.add(_dca_spec())
        await runner.enable_paper(a.id)
        await runner.enable_paper(b.id)
        assert runner._scheduler_task is not None
        await asyncio.sleep(0.03)
        await runner.kill_all("panic")
        assert runner._killed is True
        assert runner._scheduler_task is None, "kill-all stops the scheduler"
        assert all(x.enabled is False for x in runner.list())
        assert killed["n"] == 1, "kill-all locked the vault via policy.kill"
        # a tick after kill is a clean no-op, never a throw
        assert run_is_noop(await runner.tick_bot(a.id))

    def run_is_noop(rep):
        return rep.get("skipped") == "disabled" or rep.get("killed") is True

    run(main())


# =========================================================================== #
# UNIFORM SETTLEMENT STEP (every lane honors profitCurrency in the exit path)  #
#                                                                              #
# A realized SELL/exit lands proceeds in the pair's native quote. When that    #
# != the bot profitCurrency the deal-engine exit path emits ONE additional     #
# gated settlement swap converting the proceeds INTO the profitCurrency (same  #
# allocation envelope / allowlist / 0.05% fee / mainnet gate). HONESTY: no      #
# route => leave native + report the ACTUAL output; output already == pc =>     #
# skip the redundant hop; PAPER records but NEVER broadcasts.                   #
# =========================================================================== #
def _mark_ctx(mark_holder, extra_prices=None):
    """A ctx whose marks are driven by a mutable holder (so grid fills are
    deterministic even though the settlement step fetches prices again)."""
    base_prices = {"USDC": 1, "DAI": 1}
    base_prices.update(extra_prices or {})

    async def prices(symbols=None):
        return dict(base_prices, BLOCK=mark_holder["m"])

    return {"now": lambda: 0, "network": lambda: "testnet", "prices": prices}


def _run_grid_to_a_sell(profit_currency, extra_prices=None, confirm=None):
    """Arm a live grid BLOCK/USDC bot and tick it through a buy then a sell level.
    Returns (S, bot, report_of_sell_tick)."""
    mark = {"m": 1.0}
    ctx = _mark_ctx(mark, extra_prices)
    S = setup({"ctx": ctx, "sessionUsd": 1000, "confirm": confirm or (lambda _s: _yes())})
    runner = S["runner"]
    spec = {"type": "grid", "universe": {"pairs": ["BLOCK/USDC"]},
            "config": {"lowerPrice": 0.9, "upperPrice": 1.1, "gridCount": 4, "totalUsd": 40}}
    if profit_currency is not None:
        spec["profitCurrency"] = profit_currency
    bot = runner.add(spec)
    run(runner.arm_live(bot.id, {"allocationUsd": 200}))
    run(runner.tick_bot(bot.id))     # seed the grid at mid=1.0 (no fills)
    mark["m"] = 0.95
    run(runner.tick_bot(bot.id))     # a buy level fills
    mark["m"] = 1.05
    rep = run(runner.tick_bot(bot.id))  # a sell level fills -> realize in USDC
    return S, bot, rep


async def _yes():
    return True


def _swaps(state, to=None):
    return [c for c in state["committed"] if c["name"] == "swap" and (to is None or c["args"].get("to") == to)]


def _sell_events(rep):
    return [e for e in (rep.get("events") or []) if e.get("side") == "sell"]


def test_grid_sell_settles_proceeds_into_profit_currency_live():
    S, bot, rep = _run_grid_to_a_sell("DAI")
    state, audit = S["state"], S["audit"]
    assert bot.profit_currency == "DAI"
    assert _sell_events(rep), "a grid sell level actually fired this tick"

    # ONE additional settlement swap, native quote (USDC) -> profitCurrency (DAI),
    # committed through the SAME gate (it broadcast: not paper).
    settle = _swaps(state, to="DAI")
    assert len(settle) >= 1, "the realized grid sell settles its USDC proceeds into DAI"
    assert all(c["args"].get("from") == "USDC" for c in settle)
    assert any(e.get("type") == "bot_settlement" and e.get("to") == "DAI" and not e.get("paper")
               for e in audit.list())
    # the realized record reports the FINAL settled currency = profitCurrency.
    assert all(e.get("settleCurrency") == "DAI" and e.get("settled") for e in _sell_events(rep))


def test_grid_sell_skips_redundant_hop_when_quote_is_profit_currency():
    # profitCurrency == the native quote (USDC): the sell IS the realize leg, so
    # NO extra settlement swap is emitted (the arb-parity "already settled" case).
    S, bot, rep = _run_grid_to_a_sell("USDC")
    state, audit = S["state"], S["audit"]
    assert _sell_events(rep)
    assert _swaps(state) == [], "no redundant settlement hop when output already == profitCurrency"
    assert not any(e.get("type") == "bot_settlement" for e in audit.list())
    assert all(e.get("settleCurrency") == "USDC" for e in _sell_events(rep))


def test_grid_sell_no_route_keeps_native_currency_honest():
    # No priceable route to the profit currency (WBTC is not a stablecoin and no
    # quote is provided): DO NOT fabricate. Leave proceeds in USDC and report the
    # ACTUAL output as the realized currency — the label never lies.
    S, bot, rep = _run_grid_to_a_sell("WBTC")  # no WBTC price in ctx
    state, audit = S["state"], S["audit"]
    assert _sell_events(rep)
    assert _swaps(state, to="WBTC") == [], "never a fabricated hop into an unroutable currency"
    assert any(e.get("type") == "bot_settle_skip" and e.get("reason") == "no-route"
               for e in audit.list())
    assert all(e.get("settleCurrency") == "USDC" and not e.get("settled") for e in _sell_events(rep))


def test_grid_paper_settlement_records_but_never_broadcasts():
    mark = {"m": 1.0}
    ctx = _mark_ctx(mark)
    S = setup({"ctx": ctx, "sessionUsd": 1000})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = runner.add({"type": "grid", "universe": {"pairs": ["BLOCK/USDC"]}, "profitCurrency": "DAI",
                      "config": {"lowerPrice": 0.9, "upperPrice": 1.1, "gridCount": 4, "totalUsd": 40}})
    bot.mode = "paper"
    bot.enabled = True
    run(runner.tick_bot(bot.id))
    mark["m"] = 0.95
    run(runner.tick_bot(bot.id))
    mark["m"] = 1.05
    rep = run(runner.tick_bot(bot.id))

    assert state["commits"] == 0, "PAPER never broadcasts — not even the settlement"
    assert any(e.get("type") == "bot_settlement" and e.get("paper") is True for e in audit.list())
    assert all(e.get("settleCurrency") == "DAI" for e in _sell_events(rep))


# ---- momentum (scheduled) exit lane: proceeds settle through _dispatch_intents --
class _FakeSellStrat:
    """A momentum strategy whose plan emits ONE take-profit (death-cross) SELL exit
    leg landing proceeds in the native quote (USDC)."""
    def validate_params(self, cfg):
        return dict(cfg)

    async def plan(self, ctx, params):
        return [{"tool": "swap", "args": {"from": "BLOCK", "to": "USDC", "amount": "5"},
                 "tag": "mom:BLOCK/USDC:sell", "estUsd": 20, "mainnet": False}]


class _FakeSellStrategies:
    def default_registry(self):
        class _Reg:
            def get(self, _type):
                return _FakeSellStrat()
        return _Reg()


def _momentum_bot(runner, profit_currency):
    return runner.add({"type": "momentum", "universe": {"pairs": ["BLOCK/USDC"]},
                       "profitCurrency": profit_currency, "config": {}})


def test_momentum_exit_settles_proceeds_into_profit_currency_live():
    S = setup({"ctx": mk_ctx([100]), "sessionUsd": 1000, "confirm": lambda _s: _yes()})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    runner.Strategies = _FakeSellStrategies()
    bot = _momentum_bot(runner, "DAI")
    run(runner.arm_live(bot.id, {"allocationUsd": 100}))

    rep = run(runner.tick_bot(bot.id))
    # the exit leg executed, then ONE settlement swap USDC -> DAI committed.
    assert any(e.get("tag") == "mom:BLOCK/USDC:sell" and e.get("executed") for e in rep["events"])
    settle = _swaps(state, to="DAI")
    assert len(settle) == 1 and settle[0]["args"]["from"] == "USDC"
    assert any(e.get("type") == "bot_settlement" and e.get("to") == "DAI" and not e.get("paper")
               for e in audit.list())
    ev = next(e for e in rep["events"] if e.get("tag") == "mom:BLOCK/USDC:sell")
    assert ev["settleCurrency"] == "DAI" and ev["settled"]


def test_momentum_exit_no_route_keeps_native_currency():
    S = setup({"ctx": mk_ctx([100]), "sessionUsd": 1000, "confirm": lambda _s: _yes()})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    runner.Strategies = _FakeSellStrategies()
    bot = _momentum_bot(runner, "WBTC")  # unroutable profit currency
    run(runner.arm_live(bot.id, {"allocationUsd": 100}))

    rep = run(runner.tick_bot(bot.id))
    assert _swaps(state, to="WBTC") == []
    assert any(e.get("type") == "bot_settle_skip" and e.get("reason") == "no-route" for e in audit.list())
    ev = next(e for e in rep["events"] if e.get("tag") == "mom:BLOCK/USDC:sell")
    assert ev["settleCurrency"] == "USDC" and ev["settled"] is False  # the label never lies


def test_momentum_paper_settlement_records_but_never_broadcasts():
    S = setup({"ctx": mk_ctx([100]), "sessionUsd": 1000})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    runner.Strategies = _FakeSellStrategies()
    bot = _momentum_bot(runner, "DAI")
    bot.mode = "paper"
    bot.enabled = True

    rep = run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert any(e.get("type") == "bot_settlement" and e.get("paper") is True for e in audit.list())
    ev = next(e for e in rep["events"] if e.get("tag") == "mom:BLOCK/USDC:sell")
    assert ev["settleCurrency"] == "DAI"
