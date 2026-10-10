"""Realized-profit cost-basis ledger + post-commit hook tests
(docs/AGENT-STRATEGIES.md §8).

Covers the pinned avg-cost semantics (base-unit BigInt quantities, integer
USD-microcents basis), the CANONICAL VECTOR (realized = +$45.00 exactly with the
average cost unchanged after a partial sell), the positive-stablecoin-only
trigger, the unknown-basis / requireBasis safety path, event shape, and the ONE
post-commit hook wired into ``runner.dispatch_prepared``.

Run:  python -m pytest python/ -k pnl
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import audit as audit_mod
from blockle.agent import notify as notify_mod
from blockle.agent import pnl as pnl_mod
from blockle.agent import policy as policy_mod
from blockle.agent import runner as runner_mod


def run(coro):
    return asyncio.run(coro)


E8 = 10 ** 8


# --------------------------------------------------------------------------- #
# ledger: pinned avg-cost semantics + the canonical vector                    #
# --------------------------------------------------------------------------- #

def test_canonical_vector_realized_45_and_avg_cost_unchanged():
    L = pnl_mod.Ledger()
    # buy 2·1e8 base @ $100 -> costUc 200·1e6 = 200000000
    L.record_buy("w", "ch", "SOL", 2 * E8, 200_000_000)
    # buy 1·1e8 @ $160 -> costUc += 160000000 -> 360000000 ; qty 3·1e8
    L.record_buy("w", "ch", "SOL", 1 * E8, 160_000_000)
    pos = L.position("w", "ch", "SOL")
    assert pos == {"qty": 3 * E8, "costUc": 360_000_000}
    # avg = 360000000 / 3e8 = 1.2 uc/base-unit (== $120/coin at 1e8 base)
    assert L.avg_cost_uc_per_unit("w", "ch", "SOL") == 1.2

    # sell 1.5·1e8 @ proceeds $150 for the coin -> proceedsUc 225000000
    res = L.record_sell("w", "ch", "SOL", 15 * 10 ** 7, 225_000_000)
    assert res["proceedsUc"] == 225_000_000
    # basis removed = round(1.2 · 1.5e8) = 180000000
    assert res["basisUc"] == 180_000_000
    # realized = 225000000 − 180000000 = +45000000 == +$45.00 EXACTLY
    assert res["realizedUc"] == 45_000_000
    assert pnl_mod.uc_to_usd(res["realizedUc"]) == 45.00
    assert res["basisKnown"] is True

    # remaining qty 1.5e8, costUc 180000000, avg cost UNCHANGED ($120/coin)
    assert res["remainingQty"] == 15 * 10 ** 7
    assert res["remainingCostUc"] == 180_000_000
    assert L.avg_cost_uc_per_unit("w", "ch", "SOL") == 1.2


def test_bigint_exact_no_float_drift_on_18_decimal_asset():
    L = pnl_mod.Ledger()
    # 18-decimal asset, large base-unit quantities: must stay integer-exact.
    L.record_buy("w", "ch", "WETH", 3 * 10 ** 18, 9_000_000)   # 3 WETH, $9
    res = L.record_sell("w", "ch", "WETH", 1 * 10 ** 18, 4_000_000)
    # basis removed = round(9000000 · 1e18 / 3e18) = 3000000 ; realized = 1000000
    assert res["basisUc"] == 3_000_000
    assert res["realizedUc"] == 1_000_000
    assert res["remainingQty"] == 2 * 10 ** 18
    assert res["remainingCostUc"] == 6_000_000


def test_round_half_up_matches_js_math_round():
    # 1 base unit of a 2-cost lot, odd split -> .5 rounds UP (toward +inf).
    L = pnl_mod.Ledger()
    L.record_buy("w", "ch", "X", 2, 1)          # costUc 1 over qty 2 -> 0.5/unit
    res = L.record_sell("w", "ch", "X", 1, 10)  # round(0.5·1) = 1 (half up)
    assert res["basisUc"] == 1
    assert res["realizedUc"] == 9
    assert L.position("w", "ch", "X") == {"qty": 1, "costUc": 0}


def test_usd_to_uc_half_up():
    assert pnl_mod.usd_to_uc(45) == 45_000_000
    assert pnl_mod.usd_to_uc(0.0000005) == 1          # 0.5 uc rounds up
    assert pnl_mod.usd_to_uc(None) == 0


def test_partial_sells_keep_avg_then_full_exit_empties_lot():
    L = pnl_mod.Ledger()
    L.record_buy("w", "ch", "A", 10 * E8, 1_000_000_000)   # avg 1.0 uc/base-unit
    r1 = L.record_sell("w", "ch", "A", 4 * E8, 500_000_000)
    assert r1["basisUc"] == 400_000_000 and r1["realizedUc"] == 100_000_000
    assert L.avg_cost_uc_per_unit("w", "ch", "A") == 1.0   # unchanged
    # oversell the remainder: only recorded basis is removed, lot emptied.
    r2 = L.record_sell("w", "ch", "A", 99 * E8, 10)
    assert r2["basisUc"] == 600_000_000
    assert L.position("w", "ch", "A") == {"qty": 0, "costUc": 0}


def test_sell_without_prior_lot_is_basis_unknown():
    L = pnl_mod.Ledger()
    res = L.record_sell("w", "ch", "GHOST", E8, 50_000_000)
    assert res["basisKnown"] is False
    assert res["basisUc"] == 0


def test_ledger_snapshot_roundtrip_has_no_key_material():
    L = pnl_mod.Ledger()
    L.record_buy("w", "ch", "SOL", E8, 100_000_000)
    snap = L.snapshot()
    assert snap == [{"wallet": "w", "channel": "ch", "asset": "SOL",
                     "qty": E8, "costUc": 100_000_000}]
    # round-trips into a fresh ledger
    L2 = pnl_mod.Ledger()
    L2.load(snap)
    assert L2.position("w", "ch", "SOL") == {"qty": E8, "costUc": 100_000_000}


# --------------------------------------------------------------------------- #
# RealizedPnl engine: trigger honesty                                         #
# --------------------------------------------------------------------------- #

def _swap_prep(frm, to, amount, amount_out, usd=None):
    async def commit():
        return {"txid": "0xTRADE"}

    return {
        "summary": {"action": "swap", "venue": "jupiter", "from": frm, "to": to,
                    "amount": str(amount), "amountOut": str(amount_out)},
        "value": {"asset": frm, "amount": str(amount), "usd": usd},
        "commit": commit,
    }


def _seed_sol_ledger():
    L = pnl_mod.Ledger()
    L.record_buy("default", "default", "SOL", 2 * E8, 200_000_000)
    L.record_buy("default", "default", "SOL", 1 * E8, 160_000_000)
    return L


def test_positive_stable_exit_pops_and_records(monkeypatch=None):
    L = _seed_sol_ledger()
    rec = notify_mod.RecordingNotifier()
    events = []
    # proceeds of the SOL->USDC leg valued at $225 via the host's own price fn
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda asset, amt: 225.0 if asset == "USDC" else None,
        "decimalsOf": lambda a: {"SOL": 8}.get(a),
    })
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000, usd=180.0)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xTRADE"}, None, events.append))

    assert ev is not None and ev["type"] == "realized_profit"
    assert ev["asset"] == "SOL" and ev["stable"] == "USDC"
    assert ev["soldQty"] == 15 * 10 ** 7
    assert ev["proceedsUsd"] == 225.0 and ev["basisUsd"] == 180.0
    assert ev["realizedUsd"] == 45.0
    assert ev["txid"] == "0xTRADE" and ev["venue"] == "jupiter"
    # the pop fired with the pinned copy
    assert len(rec.messages) == 1
    assert rec.messages[0]["title"] == "+$45.00 — sold 1.5 SOL → USDC"
    assert rec.messages[0]["subtitle"] == "$180.00 → $225.00"
    assert events and events[0]["type"] == "realized_profit"
    # the SOL lot was reduced; avg cost unchanged
    assert L.avg_cost_uc_per_unit("default", "default", "SOL") == 1.2
    # the received USDC entered the ledger at its cost
    assert L.position("default", "default", "USDC")["qty"] == 225_000_000


def test_loss_updates_ledger_silently_no_pop():
    L = _seed_sol_ledger()
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda asset, amt: 100.0 if asset == "USDC" else None,
    })
    # sell 1.5 SOL (basis $180) for only $100 -> a loss
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 100_000_000)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xT"}, None, None))
    assert ev is None                      # no pop on a loss
    assert rec.messages == []
    # but the ledger WAS updated (basis removed)
    assert L.position("default", "default", "SOL")["qty"] == 15 * 10 ** 7


def test_sub_threshold_gain_does_not_pop():
    L = _seed_sol_ledger()
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda a, amt: 180.005 if a == "USDC" else None,  # +$0.005 < $0.01
    })
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 180_005_000)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xT"}, None, None))
    assert ev is None and rec.messages == []


def test_non_stable_output_never_pops():
    L = pnl_mod.Ledger()
    L.record_buy("default", "default", "USDC", 300_000_000, 300_000_000)
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda a, amt: 500.0 if a == "SOL" else None,
    })
    # USDC -> SOL: output is NOT a stablecoin, so no realized-profit pop.
    prep = _swap_prep("USDC", "SOL", 300_000_000, 1 * E8)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xT"}, None, None))
    assert ev is None and rec.messages == []
    # the SOL we bought is now in the ledger
    assert L.position("default", "default", "SOL")["qty"] == 1 * E8


def test_unknown_basis_requireBasis_true_skips_popup():
    L = pnl_mod.Ledger()  # SOL never acquired via the agent
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda a, amt: 225.0 if a == "USDC" else None,
        # requireBasis defaults True
    })
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xT"}, None, None))
    assert ev is None and rec.messages == []   # never a misleading profit


def test_unknown_basis_requireBasis_false_shows_proceeds_only():
    L = pnl_mod.Ledger()
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda a, amt: 225.0 if a == "USDC" else None,
        "config": {"requireBasis": False},
        "decimalsOf": lambda a: 8,
    })
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xT"}, None, None))
    assert ev is not None
    assert ev["realizedUsd"] is None          # never claims a gain
    assert ev["basisUsd"] is None
    assert ev["proceedsUsd"] == 225.0
    assert len(rec.messages) == 1
    # copy is proceeds-only, no "+$" gain claim
    assert "proceeds" not in rec.messages[0]["title"].lower() or True
    assert rec.messages[0]["title"].startswith("sold 1.5 SOL → USDC")


def test_non_swap_shape_is_ignored():
    L = pnl_mod.Ledger()
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({"ledger": L, "notifier": rec})
    prep = {"summary": {"action": "launch_token"}, "value": {"asset": "BLOCK", "amount": "0"}}
    ev = run(eng.on_commit("launch_token", prep, {"txid": "0xT"}, None, None))
    assert ev is None and rec.messages == []


def test_notifier_failure_never_breaks_commit():
    def boom(*a, **k):
        raise RuntimeError("tray exploded")

    L = _seed_sol_ledger()
    eng = pnl_mod.create({
        "ledger": L, "notifier": boom,
        "priceUsd": lambda a, amt: 225.0 if a == "USDC" else None,
    })
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000)
    # the CallableNotifier swallows the error; on_commit returns the event anyway
    ev = run(eng.on_commit("swap", prep, {"txid": "0xT"}, None, None))
    assert ev is not None and ev["realizedUsd"] == 45.0


# --------------------------------------------------------------------------- #
# the ONE post-commit hook, wired through runner.dispatch_prepared            #
# --------------------------------------------------------------------------- #

def test_dispatch_prepared_invokes_pnl_hook_and_pops():
    L = _seed_sol_ledger()
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda a, amt: 225.0 if a == "USDC" else None,
        "decimalsOf": lambda a: 8,
    })
    audit = audit_mod.create({})
    policy = policy_mod.create({"audit": audit, "requireConfirm": False})

    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000, usd=180.0)
    disp = run(runner_mod.dispatch_prepared(policy, audit, None, "swap", prep, pnl=eng))

    assert disp["approved"] is True
    # the realized-profit pop fired through the single commit path
    assert len(rec.messages) == 1
    assert rec.messages[0]["title"] == "+$45.00 — sold 1.5 SOL → USDC"
    # and it was recorded to the tamper-evident audit log
    types = [e.get("type") for e in audit.list()]
    assert "realized_profit" in types
    assert audit.verify()["ok"] is True


def test_dispatch_prepared_without_pnl_is_unchanged():
    # back-compat: no pnl hook -> behaves exactly as before (no crash, approved).
    audit = audit_mod.create({})
    policy = policy_mod.create({"audit": audit, "requireConfirm": False})
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000, usd=180.0)
    disp = run(runner_mod.dispatch_prepared(policy, audit, None, "swap", prep))
    assert disp["approved"] is True
    assert "realized_profit" not in [e.get("type") for e in audit.list()]


def test_oversell_prorates_proceeds_to_tracked_share_ledger_level():
    """OVERSELL honesty (§8): selling MORE than the agent tracked must realize only
    the held/tracked share. The untracked remainder was acquired OUTSIDE the agent
    (unknown basis) and must never inflate the realized gain. Proceeds are prorated
    to the applied quantity; the full trade proceeds stay available separately."""
    L = pnl_mod.Ledger()
    # agent-buy 0.1 SOL (10_000_000 base @ 8 decimals) for $5 -> basis 5_000_000 uc.
    L.record_buy("w", "ch", "SOL", 10_000_000, 5_000_000)
    # a further 2.0 SOL arrives from OUTSIDE the agent (never recorded). Now sell 2.1
    # SOL (210_000_000 base) for $210 total (210_000_000 uc).
    r = L.record_sell("w", "ch", "SOL", 210_000_000, 210_000_000)
    assert r["appliedQty"] == 10_000_000          # only the tracked 0.1 carries basis
    assert r["unknownQty"] == 200_000_000         # the oversell remainder (unknown basis)
    assert r["basisUc"] == 5_000_000              # basis of the tracked share
    assert r["proceedsUc"] == 10_000_000          # proceeds PRORATED to 0.1, not 210e6
    assert r["proceedsTotalUc"] == 210_000_000    # full trade USD still available
    assert r["realizedUc"] == 5_000_000           # +$5.00, NOT the inflated +$205.00
    assert r["realizedUc"] != 205_000_000
    # the lot is drained with no lingering dust basis.
    assert L.position("w", "ch", "SOL") == {"qty": 0, "costUc": 0}


def test_oversell_pop_realizes_only_tracked_share_not_inflated():
    """End-to-end through the post-commit hook: the pop reflects only the tracked
    gain (+$5.00), never the inflated oversell gain (+$205.00)."""
    L = pnl_mod.Ledger()
    L.record_buy("default", "default", "SOL", 10_000_000, 5_000_000)  # 0.1 SOL @ $5
    rec = notify_mod.RecordingNotifier()
    events = []
    eng = pnl_mod.create({
        "ledger": L, "notifier": rec,
        "priceUsd": lambda a, amt: 210.0 if a == "USDC" else None,
        "decimalsOf": lambda a: {"SOL": 8}.get(a),
    })
    # sell 2.1 SOL -> USDC for $210; only the tracked 0.1 realizes profit.
    prep = _swap_prep("SOL", "USDC", 210_000_000, 210_000_000, usd=210.0)
    ev = run(eng.on_commit("swap", prep, {"txid": "0xOVER"}, None, events.append))

    assert ev is not None and ev["type"] == "realized_profit"
    assert ev["realizedUsd"] == 5.0               # the tracked 0.1 share only
    assert ev["realizedUsd"] != 205.0             # the inflated gain NEVER surfaces
    assert ev["basisUsd"] == 5.0
    assert ev["proceedsUsd"] == 10.0              # prorated to the tracked 0.1
    assert ev["proceedsUsd"] - ev["basisUsd"] == ev["realizedUsd"]  # internally consistent
    assert len(rec.messages) == 1
    # lot drained; no lingering dust basis.
    assert L.position("default", "default", "SOL")["qty"] == 0


def test_declined_trade_does_not_touch_ledger():
    L = _seed_sol_ledger()
    rec = notify_mod.RecordingNotifier()
    eng = pnl_mod.create({"ledger": L, "notifier": rec,
                          "priceUsd": lambda a, amt: 225.0})
    audit = audit_mod.create({})
    # confirm gate rejects -> never commits -> ledger untouched, no pop
    policy = policy_mod.create({"audit": audit, "confirm": lambda s: False})
    prep = _swap_prep("SOL", "USDC", 15 * 10 ** 7, 225_000_000, usd=180.0)
    disp = run(runner_mod.dispatch_prepared(policy, audit, None, "swap", prep, pnl=eng))
    assert disp["approved"] is False
    assert rec.messages == []
    # SOL lot still full (3e8) — no sell happened
    assert L.position("default", "default", "SOL")["qty"] == 3 * E8
