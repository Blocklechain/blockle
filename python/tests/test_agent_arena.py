"""Blockle ARENA — the play-money gamified sandbox (blockle/agent/arena.py,
docs/BLOCKLE-BOTS.md §9). Python port of ``blockle-extension/agent/arena.test.js``.

Proves:
  * an Arena run NEVER touches commit/broadcast/gate/reserve (spies stay at 0);
    arena.py structurally depends ONLY on the PURE deal engine + templates.
  * PLAY funds can never convert/withdraw/exchange for anything real.
  * the canonical (scenario, botConfig) -> score vectors match the shared fixture
    docs/arena-vectors.json EXACTLY (byte-for-byte integer math).
  * the score PENALIZES drawdown: a reckless high-return/high-DD run scores BELOW
    a steadier one.
  * "use this for real" yields a paper + disabled + testnet bot (never auto-live).
"""

from __future__ import annotations

import json
import os

import pytest

from blockle.agent import arena as A
from blockle.agent import bots as B
from blockle.agent import bot_templates as T

_ARENA_DIR = os.path.dirname(A.__file__)
_VECTORS_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "docs", "arena-vectors.json"))
with open(_VECTORS_PATH, "r", encoding="utf-8") as _f:
    V = json.load(_f)


# ========================================================================= #
# honesty + labels
# ========================================================================= #
def test_disclaimer_is_persistent_honest_nonempty_constant():
    assert isinstance(A.DISCLAIMER, str)
    assert "simulation" in A.DISCLAIMER.lower()
    assert "not financial advice" in A.DISCLAIMER.lower()
    assert A.DISCLAIMER == V["disclaimer"]
    assert A.PLAY_LABEL == "PLAY"
    assert A.DEFAULT_GRANT == 10000
    assert A.SIMULATION_ONLY is True


# ========================================================================= #
# PLAY balance can NEVER become real
# ========================================================================= #
def test_playbalance_starts_at_grant_and_can_never_convert_to_real():
    pb = A.PlayBalance()
    assert pb.label == "PLAY"
    assert pb.real is False
    assert pb.convertible is False
    assert str(pb.grant_uc) == str(B.micro_usd(10000))
    assert str(pb.balance_uc) == str(B.micro_usd(10000))
    # the three real-world off-ramps all raise — structurally impossible to exit.
    with pytest.raises(Exception, match="never be converted"):
        pb.convert_to_real()
    with pytest.raises(Exception, match="never be converted"):
        pb.withdraw()
    with pytest.raises(Exception, match="never be converted"):
        pb.exchange()
    # custom grant is labeled + virtual too
    pb2 = A.PlayBalance(500)
    assert str(pb2.grant_uc) == str(B.micro_usd(500))
    assert pb2.to_json()["real"] is False
    assert pb2.to_json()["convertible"] is False


def test_applying_play_pnl_moves_only_play_balance_never_real():
    pb = A.PlayBalance(1000)
    pb.apply_pnl(B.micro_usd(250))
    assert str(pb.balance_uc) == str(B.micro_usd(1250))
    pb.apply_pnl(-B.micro_usd(400))
    assert str(pb.balance_uc) == str(B.micro_usd(850))
    assert pb.real is False


# ========================================================================= #
# STRUCTURAL safety — Arena never calls commit/broadcast/gate/reserve
# ========================================================================= #
def test_arena_module_depends_only_on_pure_engine_and_templates():
    with open(os.path.join(_ARENA_DIR, "arena.py"), "r", encoding="utf-8") as f:
        src = f.read()
    # it must not pull in the live dispatch / gate / runner modules. Scan only
    # real import statements (ignore prose in the module docstring/comments).
    import_lines = [ln.strip() for ln in src.splitlines()
                    if ln.strip().startswith(("import ", "from "))]
    joined = "\n".join(import_lines)
    assert "bot_runner" not in joined, "arena must not import bot_runner"
    assert " runner" not in joined and "import runner" not in joined, "arena must not import runner"
    assert "policy" not in joined, "arena must not import policy"
    assert "tools" not in joined, "arena must not import tools"
    # and it must expose no commit/broadcast/reserve/dispatch surface
    for k in dir(A):
        if k.startswith("_"):
            continue
        low = k.lower()
        assert not any(bad in low for bad in ("commit", "broadcast", "reserve", "dispatch")), \
            "arena exposes no gate surface: " + k


def test_an_arena_run_never_invokes_any_gate_or_broadcast_spy():
    # Poison the environment: pass spies for every value-moving fn. Arena has no
    # code path to them, so each must stay at ZERO calls.
    calls = {"commit": 0, "broadcast": 0, "gateConfirm": 0, "recordSpend": 0,
             "reserve": 0, "dispatch": 0, "sign": 0}

    def make_spy(name):
        def spy(*a, **k):
            calls[name] += 1
            raise RuntimeError("Arena must never call " + name)
        return spy

    guard = {k: make_spy(k) for k in calls}

    prof = A.ArenaProfile()
    for scenario in A.SCENARIOS:
        prof.run({"scenario": scenario, "vectors": V,
                  "bot": {"type": "dca", "config": V["canonical"][0]["botConfig"],
                          "pair": "BLOCK/USDC", "decimals": 8}, "guard": guard})
    for k in calls:
        assert calls[k] == 0, k + " was called"
    # every run is labeled PLAY and not real
    assert prof.play_balance.real is False


# ========================================================================= #
# scenario feed — loaded from the authoritative fixture (not RNG-regenerated)
# ========================================================================= #
def test_scenario_paths_load_from_shared_fixture():
    paths = A.load_scenarios(V)
    assert sorted(paths.keys()) == sorted(A.SCENARIOS)
    for s in A.SCENARIOS:
        assert isinstance(paths[s], list) and len(paths[s]) >= 100, s + " has a full path"
        assert A.price_path(V, s) == V["scenarios"][s]


# ========================================================================= #
# CANONICAL score vectors — identical integer math across all three wallets
# ========================================================================= #
def test_canonical_scenario_botconfig_score_vectors_match_fixture_exactly():
    assert len(V["canonical"]) >= 1, "fixture has at least one canonical vector"
    for vec in V["canonical"]:
        res = A.run_scenario({
            "scenario": vec["scenario"], "prices": V["scenarios"][vec["scenario"]],
            "bot": {"type": vec["type"], "config": vec["botConfig"],
                    "pair": vec["pair"], "decimals": vec["decimals"]},
        })
        assert res["score"] == vec["expectedScore"], vec["scenario"] + " score"
        assert str(res["scoreTenths"]) == vec["expectedScoreTenths"], vec["scenario"] + " scoreTenths"
        assert str(res["finalPnlUc"]) == vec["expectedPnlUc"], vec["scenario"] + " pnlUc"
        assert str(res["maxDrawdownUc"]) == vec["expectedMaxDdUc"], vec["scenario"] + " maxDdUc"
        assert str(res["maxCostBasisUc"]) == vec["expectedMaxCostBasisUc"], vec["scenario"] + " maxCostBasisUc"
        assert len(res["fills"]) == vec["expectedFillCount"], vec["scenario"] + " fillCount"
        assert res["dealCount"] == vec["expectedDealCount"], vec["scenario"] + " dealCount"


def test_score_formula_is_pinned_round1_integer_math():
    # +10% return, 0 drawdown -> 10.0
    assert A.score(B.micro_usd(100), 0, B.micro_usd(1000)) == {"scoreTenths": 100, "score": 10}
    # +10% return, 20% drawdown -> 10 - 0.5*20 = 0.0
    assert A.score(B.micro_usd(100), B.micro_usd(200), B.micro_usd(1000)) == {"scoreTenths": 0, "score": 0}
    # -5% return, 10% drawdown -> -5 - 5 = -10.0
    assert A.score(-B.micro_usd(50), B.micro_usd(100), B.micro_usd(1000)) == {"scoreTenths": -100, "score": -10}
    # no capital deployed -> 0 (no division by zero)
    assert A.score(0, 0, 0) == {"scoreTenths": 0, "score": 0}
    # half-away-from-zero rounding to tenths: ret 3.33% -> 3.3
    r = A.score(B.micro_usd(100), 0, B.micro_usd(3000))
    assert r["score"] == 3.3


# ========================================================================= #
# the score PENALIZES DRAWDOWN — reckless high-DD scores below steady
# ========================================================================= #
def test_reckless_high_dd_run_scores_below_steadier_one():
    dp = V["ddPenalty"]
    steady = A.run_scenario({"prices": dp["prices"], "maxDeals": dp["maxDeals"],
                             "bot": {"type": "dca", "config": dp["steady"]["botConfig"],
                                     "pair": dp["pair"], "decimals": dp["decimals"]}})
    reckless = A.run_scenario({"prices": dp["prices"], "maxDeals": dp["maxDeals"],
                               "bot": {"type": "dca", "config": dp["reckless"]["botConfig"],
                                       "pair": dp["pair"], "decimals": dp["decimals"]}})

    # exact fixture match
    assert steady["score"] == dp["steady"]["expectedScore"]
    assert reckless["score"] == dp["reckless"]["expectedScore"]
    assert str(steady["finalPnlUc"]) == dp["steady"]["expectedPnlUc"]
    assert str(reckless["finalPnlUc"]) == dp["reckless"]["expectedPnlUc"]
    assert str(steady["maxDrawdownUc"]) == dp["steady"]["expectedMaxDdUc"]
    assert str(reckless["maxDrawdownUc"]) == dp["reckless"]["expectedMaxDdUc"]
    assert str(steady["maxCostBasisUc"]) == dp["steady"]["expectedMaxCostBasisUc"]
    assert str(reckless["maxCostBasisUc"]) == dp["reckless"]["expectedMaxCostBasisUc"]
    assert str(steady["retTenthPct"]) == dp["steady"]["retTenthPct"]
    assert str(reckless["retTenthPct"]) == dp["reckless"]["retTenthPct"]
    assert str(steady["ddTenthPct"]) == dp["steady"]["ddTenthPct"]
    assert str(reckless["ddTenthPct"]) == dp["reckless"]["ddTenthPct"]

    # the property: reckless OUT-RETURNS but UNDER-SCORES (because of its drawdown)
    assert reckless["finalPnlUc"] > steady["finalPnlUc"], "reckless out-returns (raw PnL)"
    assert reckless["retTenthPct"] > steady["retTenthPct"], "reckless out-returns (retPct)"
    assert reckless["maxDrawdownUc"] > steady["maxDrawdownUc"], "reckless has larger drawdown"
    assert reckless["score"] < steady["score"], "yet reckless scores BELOW steady"


# ========================================================================= #
# XP + levels (advisory), missions, badges
# ========================================================================= #
def test_xp_accrues_and_levels_unlock_advanced_params():
    assert A.level_for_xp(0)["level"] == 1
    assert "dca" in A.level_for_xp(0)["unlocks"]
    assert A.level_for_xp(50)["level"] == 2
    assert "advanced-params" in A.level_for_xp(150)["unlocks"]
    assert A.level_for_xp(1000)["level"] == 5
    # a run always grants at least the participation XP
    res = A.run_scenario({"scenario": "bull", "prices": V["scenarios"]["bull"],
                          "bot": {"type": "dca", "config": V["canonical"][2]["botConfig"],
                                  "pair": "BLOCK/USDC", "decimals": 8}})
    res["scenario"] = "bull"
    assert A.xp_for_run(res) >= 10


def test_missions_have_clear_win_conditions_crash_survivor():
    assert len(A.MISSIONS) >= 3
    # reckless on crash finishes green -> survive_crash_green
    reck = A.run_scenario({"scenario": "crash", "prices": V["scenarios"]["crash"],
                           "bot": {"type": "dca", "config": V["canonical"][1]["botConfig"],
                                   "pair": "BLOCK/USDC", "decimals": 8}})
    reck["scenario"] = "crash"
    assert reck["finalPnlUc"] > 0, "reckless crash run is green"
    assert A.check_mission("survive_crash_green", reck), "survive_crash_green completes"
    assert "survive_crash_green" in A.completed_missions(reck)


def test_badges_unlock_over_a_profile():
    prof = A.ArenaProfile()
    first = prof.run({"scenario": "bull", "vectors": V,
                      "bot": {"type": "dca", "config": V["canonical"][2]["botConfig"],
                              "pair": "BLOCK/USDC", "decimals": 8}})
    assert "first_run" in prof.badges
    assert first["xpGained"] >= 10
    # play every remaining scenario -> Globetrotter
    for s in ["crab", "bear", "crash", "pump"]:
        prof.run({"scenario": s, "vectors": V,
                  "bot": {"type": "dca", "config": V["canonical"][0]["botConfig"],
                          "pair": "BLOCK/USDC", "decimals": 8}})
    assert "all_scenarios" in prof.badges


# ========================================================================= #
# local-first leaderboard (NO network/global board in v1)
# ========================================================================= #
def test_leaderboard_is_local_first_personal_best_on_device():
    lb = A.Leaderboard()
    lb.add({"scenario": "bull", "score": 12.3, "scoreTenths": 123, "name": "a"})
    lb.add({"scenario": "bull", "score": 44.0, "scoreTenths": 440, "name": "b"})
    lb.add({"scenario": "bull", "score": 7.1, "scoreTenths": 71, "name": "c"})
    assert lb.personal_best("bull")["name"] == "b"   # highest score first
    assert len(lb.top("bull", 2)) == 2
    assert lb.top("bull")[0]["name"] == "b"
    assert lb.to_json()["local"] is True
    assert lb.to_json()["global"] is False           # v1: no global board


def test_arenaprofile_records_a_personal_best_on_local_board():
    prof = A.ArenaProfile()
    prof.run({"scenario": "bull", "vectors": V,
              "bot": {"type": "dca", "config": V["canonical"][2]["botConfig"],
                      "pair": "BLOCK/USDC", "decimals": 8}})
    pb = prof.leaderboard.personal_best("bull")
    assert pb, "has a personal best for bull"
    assert isinstance(pb["score"], (int, float))


# ========================================================================= #
# "USE THIS FOR REAL" — exports a template; import lands paper+disabled+testnet
# ========================================================================= #
def test_use_this_for_real_yields_paper_disabled_testnet_bot():
    # design an Arena config, export it, then use-for-real
    template = A.export_as_template({"type": "dca", "config": V["canonical"][0]["botConfig"],
                                     "pair": "BLOCK/USDC"})
    assert template["kind"] == "blockle-bot-template"

    bot = A.use_for_real(template)
    assert bot.mode == "paper", "imported bot is paper"
    assert bot.enabled is False, "imported bot is disabled"
    assert bot.network == "testnet", "imported bot is testnet"
    assert bot.allocationUsd == 0, "imported bot has zero allocation"

    # even a template that LIES about being live lands paper+disabled+testnet
    liar = dict(template)
    liar.update({"mode": "live", "enabled": True, "network": "mainnet", "allocationUsd": 999999})
    bot2 = A.use_for_real(liar)
    assert bot2.mode == "paper"
    assert bot2.enabled is False
    assert bot2.network == "testnet"
    assert bot2.allocationUsd == 0


# ========================================================================= #
# determinism — a given (scenario, config) always yields the same fills + score
# ========================================================================= #
def test_runs_are_deterministic():
    def mk():
        return A.run_scenario({"scenario": "pump", "prices": V["scenarios"]["pump"],
                               "bot": {"type": "dca", "config": V["canonical"][0]["botConfig"],
                                       "pair": "BLOCK/USDC", "decimals": 8}})
    a, b = mk(), mk()
    assert a["score"] == b["score"]
    assert str(a["finalPnlUc"]) == str(b["finalPnlUc"])
    assert str(a["maxDrawdownUc"]) == str(b["maxDrawdownUc"])
    assert json.dumps(a["fills"]) == json.dumps(b["fills"])
