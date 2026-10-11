"""Blockle Bots DEAL ENGINE (blockle/agent/bots.py) + model/store + templates.

The deal-engine tests assert the Python engine reproduces the AUTHORITATIVE shared
fixture ``docs/bot-vectors.json`` EXACTLY (base-unit int qty, micro-dollar integer
basis) — the SAME numbers the JS reference (``blockle-extension/agent``) and the
Dart wallet assert against. See docs/BLOCKLE-BOTS.md §7.
"""

from __future__ import annotations

import json
import os

import pytest

from blockle.agent import bots as B
from blockle.agent import bot_templates as T

_VECTORS_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "docs", "bot-vectors.json"))
with open(_VECTORS_PATH, "r", encoding="utf-8") as _f:
    VECTORS = json.load(_f)


# paper-fill a decided order exactly as BotRunner._execute_order does (paper path)
def fill_buy(order, mark_uc, bd):
    qty = B.qty_for_usd(order["usdSizeUc"], mark_uc, bd)
    return {"side": "buy", "qty": qty, "priceUc": mark_uc, "costUc": B.value_of(qty, mark_uc, bd),
            "bd": bd, "paper": True}


def fill_sell(order, mark_uc, bd):
    return {"side": "sell", "qty": order["qty"], "priceUc": mark_uc,
            "proceedsUc": B.value_of(order["qty"], mark_uc, bd), "bd": bd, "paper": True}


def s(x):
    return None if x is None else str(x)


# =========================================================================== #
# money/qty helpers — the pinned rounding (shared with pnl.py semantics)      #
# =========================================================================== #
def test_money_helpers():
    assert str(B.micro_usd(200)) == "200000000"
    assert str(B.micro_usd(0.01)) == "10000"
    # $100 at $90/coin, 8 decimals -> floor(100e6*1e8/90e6) = 111111111
    assert str(B.qty_for_usd(B.micro_usd(100), B.micro_usd(90), 8)) == "111111111"
    assert str(B.value_of(111111111, B.micro_usd(90), 8)) == "100000000"
    assert str(B.avg_entry_of(B.micro_usd(200), 200000000, 8)) == "100000000"
    # applyBps: -1000 bps (−10%) of $100 = $90
    assert str(B.apply_bps(B.micro_usd(100), -1000)) == "90000000"
    assert B.pct_to_bps(2.5) == 250


# =========================================================================== #
# (1) DCA deal: base -> N safety -> take-profit close — EXACT fixture match    #
# =========================================================================== #
def test_vector_dca_deal():
    V = VECTORS["dca_deal"]
    cfg = B.validate_config("dca", V["config"])
    bcfg = B.dca_bps(cfg)
    bd = V["decimals"]
    deal = B.new_dca_deal("t", 0)
    got = []
    for m_usd in V["priceSeriesUsd"]:
        mark_uc = B.micro_usd(m_usd)
        B.dca_observe(deal, mark_uc)
        guard = 0
        while guard < 64:
            guard += 1
            order = B.dca_step(deal, bcfg, mark_uc)
            if not order:
                break
            if order["action"] == "arm":
                order["_markUc"] = mark_uc
                B.dca_apply(deal, bcfg, order, None, 0)
                continue
            fill = fill_buy(order, mark_uc, bd) if order["side"] == "buy" else fill_sell(order, mark_uc, bd)
            B.dca_apply(deal, bcfg, order, fill, 0)
            got.append({"kind": order["kind"], "side": order["side"], "priceUc": s(mark_uc),
                        "qty": s(fill["qty"]), "costUc": s(fill.get("costUc")),
                        "proceedsUc": s(fill.get("proceedsUc")), "avgEntryUc": s(deal["avgEntryUc"]),
                        "filledQty": s(deal["filledQty"])})
            if deal["status"] == "closed":
                break
    assert got == V["fills"]
    assert s(deal["realizedUc"]) == V["realizedUc"]
    assert deal["reason"] == V["closedReason"]
    assert len([f for f in got if f["side"] == "buy"]) == 3
    assert len([f for f in got if f["side"] == "sell"]) == 1


# =========================================================================== #
# (2) trailing-TP: arm at +tp, ride the peak, sell on the pullback            #
# =========================================================================== #
def test_vector_trailing_tp():
    V = VECTORS["trailing_tp"]
    cfg = B.validate_config("dca", V["config"])
    bcfg = B.dca_bps(cfg)
    bd = V["decimals"]
    deal = B.new_dca_deal("t", 0)
    got = []
    events = []
    for m_usd in V["priceSeriesUsd"]:
        mark_uc = B.micro_usd(m_usd)
        B.dca_observe(deal, mark_uc)
        guard = 0
        while guard < 64:
            guard += 1
            order = B.dca_step(deal, bcfg, mark_uc)
            if not order:
                break
            if order["action"] == "arm":
                order["_markUc"] = mark_uc
                B.dca_apply(deal, bcfg, order, None, 0)
                events.append({"at": m_usd, "event": "trailing-armed", "peakUc": s(deal["peakUc"])})
                continue
            fill = fill_buy(order, mark_uc, bd) if order["side"] == "buy" else fill_sell(order, mark_uc, bd)
            B.dca_apply(deal, bcfg, order, fill, 0)
            got.append({"kind": order["kind"], "side": order["side"], "priceUc": s(mark_uc),
                        "qty": s(fill["qty"]), "costUc": s(fill.get("costUc")),
                        "proceedsUc": s(fill.get("proceedsUc")), "avgEntryUc": s(deal["avgEntryUc"])})
            if deal["status"] == "closed":
                break
    assert got == V["fills"]
    assert events == V["events"]
    assert s(deal["realizedUc"]) == V["realizedUc"]  # +$14.00
    # the sell price is the trailing stop (peak 120 − 5% = 114), NOT the +10% target
    assert got[-1]["priceUc"] == "114000000"


# =========================================================================== #
# (3) grid ladder + fill-flip                                                 #
# =========================================================================== #
def test_vector_grid_ladder():
    V = VECTORS["grid_ladder"]
    cfg = B.validate_config("grid", V["config"])
    bd = V["decimals"]
    mid_uc = int(V["midUc"])
    deal = B.new_grid_deal("t", cfg, mid_uc, bd, 0)
    ladder = [{"i": l["i"], "priceUc": s(l["priceUc"]), "sizeUc": s(l["sizeUc"]), "qty": s(l["qty"]),
               "side": l["side"], "status": l["status"]} for l in deal["levels"]]
    assert ladder == V["ladder"]

    steps = []
    for st in V["steps"]:
        mark_uc = B.micro_usd(st["markUsd"])
        guard = 0
        tick_fills = []
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
            tick_fills.append({"level": order["levelIndex"], "side": order["side"], "priceUc": s(mark_uc),
                               "qty": s(fill["qty"]), "costUc": s(fill.get("costUc")),
                               "proceedsUc": s(fill.get("proceedsUc"))})
        steps.append({"markUsd": st["markUsd"], "fills": tick_fills,
                      "levels": [{"i": l["i"], "side": l["side"], "status": l["status"],
                                  "heldQty": s(l["heldQty"])} for l in deal["levels"]],
                      "realizedUc": s(deal["realizedUc"])})
    assert steps == V["steps"]
    assert s(deal["realizedUc"]) == V["realizedUc"]


# =========================================================================== #
# (4) smarttrade split take-profit                                            #
# =========================================================================== #
def test_vector_smarttrade_split_tp():
    V = VECTORS["smarttrade_split_tp"]
    cfg = B.validate_config("smarttrade", V["config"])
    bd = V["decimals"]
    deal = B.new_smart_trade_deal("t", cfg, 0)
    got = []
    for m_usd in V["priceSeriesUsd"]:
        mark_uc = B.micro_usd(m_usd)
        guard = 0
        while guard < 64:
            guard += 1
            order = B.smart_step(deal, cfg, mark_uc)
            if not order:
                break
            fill = fill_buy(order, mark_uc, bd) if order["side"] == "buy" else fill_sell(order, mark_uc, bd)
            B.smart_apply(deal, cfg, order, fill, 0)
            got.append({"kind": order["kind"], "side": order["side"], "priceUc": s(mark_uc),
                        "qty": s(fill["qty"]), "costUc": s(fill.get("costUc")),
                        "proceedsUc": s(fill.get("proceedsUc")), "avgEntryUc": s(deal["avgEntryUc"]),
                        "remainingQty": s(deal["remainingQty"]), "realizedUc": s(deal["realizedUc"])})
            if deal["status"] == "closed":
                break
    assert got == V["fills"]
    assert s(deal["realizedUc"]) == V["realizedUc"]  # +$15.00
    assert str(deal["remainingQty"]) == "0"


def test_grid_whole_grid_take_profit_liquidates_and_closes():
    cfg = B.validate_config("grid", {"lowerPrice": 0.90, "upperPrice": 1.10, "gridCount": 5,
                                     "totalUsd": 50, "takeProfitPct": 10})
    bcfg = B.grid_bcfg(cfg)
    bd = 8
    deal = B.new_grid_deal("g", cfg, B.micro_usd(1.00), bd, 0)

    def paper_fill(order, mark_uc):
        if order["side"] == "buy":
            return {"side": "buy", "qty": order["qty"], "priceUc": mark_uc,
                    "costUc": B.value_of(order["qty"], mark_uc, bd), "paper": True}
        return {"side": "sell", "qty": order["qty"], "priceUc": mark_uc,
                "proceedsUc": B.value_of(order["qty"], mark_uc, bd), "paper": True}

    def run(m_usd):
        mark_uc = B.micro_usd(m_usd)
        g = 0
        while g < 64:
            g += 1
            o = B.grid_step(deal, mark_uc, bcfg)
            if not o:
                break
            B.grid_apply(deal, o, paper_fill(o, mark_uc), 0)

    run(0.95)  # buy the 0.95 level, arm a sell one grid up
    assert any(l["heldQty"] > 0 for l in deal["levels"])
    run(1.20)  # whole-grid TP: value >> basis*1.10 -> liquidate + close
    assert deal["status"] == "closed"
    assert deal["reason"] == "grid_exit"
    assert deal["realizedUc"] > 0
    assert not any(l["heldQty"] > 0 for l in deal["levels"])


# =========================================================================== #
# Bot model + BotStore: defaults, persistence, restart survival               #
# =========================================================================== #
def test_bot_defaults():
    b = B.Bot({"type": "dca", "universe": {"pairs": ["SOL/USDC"]}})
    assert b.mode == "paper"
    assert b.enabled is False
    assert b.network == "testnet"
    assert b.allocation_usd == 0
    assert b.config["maxSafetyOrders"] == 3
    assert b.config["takeProfitPct"] == 2


def test_bot_unknown_type_and_grid_range():
    with pytest.raises(ValueError, match="unknown bot type"):
        B.Bot({"type": "nope"})
    with pytest.raises(ValueError, match="lowerPrice < upperPrice"):
        B.Bot({"type": "grid", "config": {"lowerPrice": 2, "upperPrice": 1}})


class _MemStore:
    def __init__(self):
        self.mem = {}

    async def set(self, o):
        self.mem.update(o)

    async def get(self, keys):
        return {k: self.mem.get(k) for k in keys}


def test_botstore_snapshot_load_survives_restart():
    import asyncio

    store = _MemStore()
    s1 = B.BotStore({"store": store, "wallet": "w", "channel": "c"})
    bot = s1.add({"type": "dca", "universe": {"pairs": ["BLOCK/USDC"]}, "allocationUsd": 50})
    bot.state["byPair"]["BLOCK/USDC"] = {"deal": B.new_dca_deal("d", 0), "lastCloseAt": 0}
    bot.state["byPair"]["BLOCK/USDC"]["deal"]["filledQty"] = 123456789
    bot.state["byPair"]["BLOCK/USDC"]["deal"]["costUc"] = 987654321
    bot.state["committedUc"] = 25000000
    asyncio.run(s1.persist())

    s2 = B.BotStore({"store": store, "wallet": "w", "channel": "c"})
    asyncio.run(s2.restore())
    got = s2.get(bot.id)
    assert got is not None
    assert got.state["byPair"]["BLOCK/USDC"]["deal"]["filledQty"] == 123456789  # int round-trips
    assert got.state["byPair"]["BLOCK/USDC"]["deal"]["costUc"] == 987654321
    assert got.state["committedUc"] == 25000000
    assert got.allocation_usd == 50


def test_botstore_scoping_keeps_wallet_channel_separate():
    import asyncio

    store = _MemStore()
    a = B.BotStore({"store": store, "wallet": "w1", "channel": "c"})
    bb = B.BotStore({"store": store, "wallet": "w2", "channel": "c"})
    a.add({"type": "dca", "universe": {"pairs": ["X/USDC"]}})
    asyncio.run(a.persist())
    asyncio.run(bb.persist())
    a2 = B.BotStore({"store": store, "wallet": "w1", "channel": "c"})
    asyncio.run(a2.restore())
    b2 = B.BotStore({"store": store, "wallet": "w2", "channel": "c"})
    asyncio.run(b2.restore())
    assert len(a2.list()) == 1
    assert len(b2.list()) == 0


def test_persisted_state_carries_no_key_material():
    bot = B.Bot({"type": "dca", "universe": {"pairs": ["X/USDC"]}})
    blob = json.dumps(bot.to_json(), default=str)
    for bad in ("seed", "mnemonic", "privateKey", "apiKey", "secret", "password"):
        assert bad.lower() not in blob.lower()


# =========================================================================== #
# Templates: starter set + export/import (import lands paper + disabled)       #
# =========================================================================== #
def test_templates_starter_set_builds_paper_disabled():
    names = [t["key"] for t in T.list()]
    for key in ("conservative_dca", "aggressive_dca", "wide_grid", "scalp_grid", "block_accumulator"):
        assert key in names
        spec = T.from_template(key, {"pair": "BLOCK/USDC"})
        bot = B.Bot(spec)
        assert bot.mode == "paper"
        assert bot.enabled is False
        assert bot.allocation_usd == 0


def test_templates_export_import_round_trip_lands_paper():
    src = B.Bot({"type": "dca", "name": "My DCA", "universe": {"pairs": ["SOL/USDC"]},
                 "config": {"baseOrderUsd": 42, "takeProfitPct": 3}, "mode": "live", "enabled": True,
                 "allocationUsd": 100, "network": "mainnet"})
    tpl = T.export_bot(src)
    assert tpl["kind"] == "blockle-bot-template"
    assert "allocationUsd" not in tpl
    assert "mode" not in tpl

    imported = T.import_template(json.dumps(tpl))
    assert imported.type == "dca"
    assert imported.config["baseOrderUsd"] == 42
    assert imported.config["takeProfitPct"] == 3
    # HARD safety: import never auto-arms, never carries live funds/mainnet
    assert imported.mode == "paper"
    assert imported.enabled is False
    assert imported.network == "testnet"
    assert imported.allocation_usd == 0


def test_templates_malicious_live_funded_json_lands_paper_disabled_zero_alloc():
    evil = {"kind": "blockle-bot-template", "type": "dca", "name": "evil",
            "universe": {"pairs": ["X/USDC"]}, "config": {}, "mode": "live", "enabled": True,
            "allocationUsd": 1000000, "network": "mainnet"}
    b = T.import_template(evil)
    assert b.mode == "paper"
    assert b.enabled is False
    assert b.allocation_usd == 0
    assert b.network == "testnet"
