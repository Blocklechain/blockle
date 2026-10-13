"""agent/scanner-runner integration — the `scanner` bot type routes its chosen
Intents through the SAME value-moving gate as every other bot (docs/AGENT-SCAN.md
§3-4): PAPER never broadcasts; LIVE within allocation auto-approves + commits; the
hard allocation cap still blocks an over-allocation scanner trade; kill stops it
instantly; the tool allowlist still governs; a DANGER-severity pre-sign still forces
a confirm (declined => no broadcast); the mainnet gate still refuses a mainnet
trade. No synthetic prices.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from blockle.agent import audit as audit_mod
from blockle.agent import bot_runner as br_mod
from blockle.agent import bot_templates as bt_mod
from blockle.agent import bots as bots_mod
from blockle.agent import policy as policy_mod
from blockle.agent import scanner as scanner_mod
from blockle.agent import strategies as strategies_mod

VEC = json.loads((Path(__file__).resolve().parents[2] / "docs" / "scan-vectors.json").read_text())
UNIVERSE = VEC["scanner"]["universe"]
SCANNER_CFG = VEC["scanner"]["config"]


def run(coro):
    return asyncio.run(coro)


def fake_tools(opts=None):
    """A value-moving tools registry whose commit() counts broadcasts. Every vector
    leg is ~$1000. A tool can be told to force a DANGER confirm for a given `to`."""
    opts = opts or {}
    state = {"commits": 0, "committed": []}

    def mk(name):
        async def prepare(a):
            frm = a.get("from") or a.get("asset") or "X"
            danger = opts.get("dangerTo") and a.get("to") == opts["dangerTo"]

            async def commit():
                state["commits"] += 1
                state["committed"].append({"name": name, "args": a})
                return {"txid": "tx" + str(state["commits"]), "accepted": True}

            return {
                "summary": {"action": name, "from": frm, "to": a.get("to"),
                            "amount": a.get("amount"), "venue": a.get("venue")},
                "value": {"asset": frm, "amount": a.get("amount") or "0", "usd": 1000},
                "forceConfirm": bool(danger),
                "security": {"severity": "danger", "warnings": [{"code": "known-drainer"}]} if danger else None,
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


def mk_ctx(extra=None):
    ctx = {
        "_t": 0,
        "now": lambda: 0,
        "network": lambda: "testnet",
        "scanUniverse": (lambda cfg=None: UNIVERSE),
    }
    if extra:
        ctx.update(extra)
    return ctx


def setup(opts=None):
    opts = opts or {}
    audit = audit_mod.create({})
    session_usd = opts["sessionUsd"] if "sessionUsd" in opts else 100000
    policy = policy_mod.create({"caps": {"sessionUsd": session_usd}, "confirm": opts.get("confirm"),
                                "audit": audit, "onKill": opts.get("onKill")})
    if opts.get("tools") is not None:
        state, tools = opts["tools"]
    else:
        state, tools = fake_tools()
    policy.set_allowlist(opts.get("allowlist") or tools.names())
    runner = br_mod.create({
        "policy": policy, "tools": tools, "audit": audit, "ctx": opts.get("ctx") or mk_ctx(),
        "Bots": bots_mod, "Scanner": scanner_mod, "Strategies": strategies_mod,
        "mainnetEnabled": opts.get("mainnetEnabled") is True,
    })
    return {"runner": runner, "policy": policy, "tools": tools, "state": state, "audit": audit}


def add_scanner(runner, overrides=None):
    spec = {"type": "scanner", "config": dict(SCANNER_CFG)}
    spec.update(overrides or {})
    return runner.add(spec)


def audit_types(audit, type_):
    return [e for e in audit.list() if e.get("type") == type_]


# ===========================================================================
# PAPER: the scanner scans + records paper intents but NEVER broadcasts
# ===========================================================================
def test_scanner_paper_scans_but_never_broadcasts():
    S = setup()
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = add_scanner(runner)
    bot.mode = "paper"
    bot.enabled = True

    report = run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert len(audit_types(audit, "scanner_scan")) == 1
    assert len(audit_types(audit, "bot_paper_intent")) == 3
    assert report["scan"]["worthy"] == ["MOM/USDC", "ETH/USDC"]


# ===========================================================================
# LIVE within allocation: auto-approves + broadcasts the worthy pairs' Intents
# ===========================================================================
def test_scanner_live_within_allocation_broadcasts_through_one_gate():
    asked = {"n": 0}

    async def confirm(_summary):
        asked["n"] += 1
        return True

    S = setup({"confirm": confirm})
    runner, state = S["runner"], S["state"]
    bot = add_scanner(runner)
    run(runner.arm_live(bot.id, {"allocationUsd": 5000}))

    run(runner.tick_bot(bot.id))
    assert asked["n"] == 0  # within allocation auto-approves — confirm NOT asked
    assert state["commits"] == 3  # MOM buy + ETH arb buy + ETH arb sell


# ===========================================================================
# ALLOCATION CAP: an over-allocation scanner trade is refused like any bot
# ===========================================================================
def test_scanner_allocation_cap_only_fitting_pair_trades():
    S = setup()
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = add_scanner(runner)
    run(runner.arm_live(bot.id, {"allocationUsd": 1200}))

    run(runner.tick_bot(bot.id))
    assert state["commits"] == 1
    assert state["committed"][0]["args"]["to"] == "MOM"
    scan = audit_types(audit, "scanner_scan")[0]
    assert any(s == "ETH/USDC:allocation" for s in scan["skipped"])


# ===========================================================================
# KILL: stops the scanner instantly — no scan, no broadcast
# ===========================================================================
def test_scanner_kill_never_scans_or_trades():
    S = setup()
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = add_scanner(runner)
    run(runner.arm_live(bot.id, {"allocationUsd": 5000}))
    run(runner.kill_all("test"))

    report = run(runner.tick_bot(bot.id))
    assert report["skipped"] == "disabled"
    assert state["commits"] == 0
    assert len(audit_types(audit, "scanner_scan")) == 0


# ===========================================================================
# ALLOWLIST: an un-allowlisted tool is an audit note, never an ungated trade
# ===========================================================================
def test_scanner_allowlist_blocks_untrusted_tool():
    S = setup({"allowlist": ["cancel_order"]})  # swap NOT allowed
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = add_scanner(runner)
    run(runner.arm_live(bot.id, {"allocationUsd": 5000}))

    run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert len(audit_types(audit, "bot_blocked")) >= 1


# ===========================================================================
# DANGER pre-sign: a danger forces a confirm; declined => no broadcast
# ===========================================================================
def test_scanner_danger_pre_sign_forces_confirm_and_decline_blocks():
    asked = {"n": 0}

    async def confirm(_summary):
        asked["n"] += 1
        return False

    tools = fake_tools({"dangerTo": "MOM"})
    S = setup({"tools": tools, "confirm": confirm})
    runner, audit = S["runner"], S["audit"]
    bot = add_scanner(runner)
    run(runner.arm_live(bot.id, {"allocationUsd": 5000}))

    run(runner.tick_bot(bot.id))
    assert asked["n"] >= 1
    assert not any(c["args"].get("to") == "MOM" for c in tools[0]["committed"])
    assert any(e.get("severity") == "danger" for e in audit_types(audit, "security_inspection"))


# ===========================================================================
# MAINNET gate: a mainnet scanner trade is refused when mainnetEnabled=False
# ===========================================================================
def test_scanner_mainnet_gate_refuses_when_off():
    ctx = mk_ctx({"network": lambda: "mainnet"})
    S = setup({"ctx": ctx, "mainnetEnabled": False})
    runner, state, audit = S["runner"], S["state"], S["audit"]
    bot = add_scanner(runner)
    try:
        run(runner.arm_live(bot.id, {"allocationUsd": 5000}))
    except Exception:
        pass
    run(runner.tick_bot(bot.id))
    assert state["commits"] == 0
    assert any(e.get("reason") == "mainnet" for e in audit_types(audit, "bot_skip"))


# ===========================================================================
# UI data path: the template lands paper/testnet/disabled; the dashboard
# surfaces the last-scan candidates + scores for the cockpit card.
# ===========================================================================
def test_scan_and_trade_template_lands_paper_disabled_testnet():
    spec = bt_mod.from_template("scan_and_trade")
    bot = bots_mod.Bot(spec)
    assert bot.type == "scanner"
    assert bot.mode == "paper"
    assert bot.enabled is False
    assert bot.network == "testnet"
    assert float(bot.allocation_usd) == 0.0
    assert "autopilot" in bot.describe().lower() or "scans" in bot.describe().lower()


def test_dashboard_surfaces_scan_snapshot_for_cockpit_card():
    S = setup()
    runner = S["runner"]
    bot = add_scanner(runner)
    bot.mode = "paper"
    bot.enabled = True
    run(runner.tick_bot(bot.id))
    dash = runner.dashboard(bot.id)
    assert dash["type"] == "scanner"
    assert dash["scan"] is not None
    assert dash["scan"]["worthy"] == ["MOM/USDC", "ETH/USDC"]
    assert len(dash["scan"]["candidates"]) == 5
