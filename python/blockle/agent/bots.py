"""agent/bots.py — the Blockle Bots ENGINE CORE (shared spec docs/BLOCKLE-BOTS.md
§1-6). Faithful Python port of ``blockle-extension/agent/bots.js`` (the REFERENCE
implementation). A persistent, non-custodial "3Commas for DEXes" layered on the
in-wallet agent + strategy engine; the numbers here match the JS reference EXACTLY
(checked against the shared fixture ``docs/bot-vectors.json``).

SAFETY MODEL (non-negotiable, inherited from AGENT-STRATEGIES.md §0):
  A bot is a PLANNER + a deal STATE MACHINE. It NEVER signs, broadcasts, or
  touches keys. Every LIVE order is routed by the :class:`BotRunner`
  (:mod:`bot_runner`) through the ONE value-moving dispatch
  (:func:`runner.dispatch_prepared`: cap -> confirm -> commit -> fee ->
  record_spend, with the mandatory 0.05% fee + caps + allowlist + kill +
  hash-chained audit + mainnet gate). There is no second broadcast path. PAPER
  mode simulates fills at the ctx quote and touches NONE of that.

This module holds the pure, deterministic pieces:
  * money/qty helpers (base-unit int qty, micro-dollar integer basis — the SAME
    rounding as the §8 pnl ledger, so JS/Dart/Python reproduce the fixture).
  * the DEAL ENGINE state machines (dca / grid / smarttrade), expressed as a pure
    ``step(state, mark_uc) -> order?`` + ``apply(state, order, fill)`` pair so the
    BotRunner can interpose the gate between "decide" and "apply fill".
  * the :class:`Bot` model + :class:`BotStore` (persist bots + deal state per
    wallet/channel; survives restart; NEVER any key/seed/LLM-cred material).

NO key material, seeds, or LLM credentials are ever stored here — only bot config
+ deal state + the per-bot committed-spend allocation ledger, persisted ALONGSIDE
the audit log.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from ..multichain._util import is_finite, js_round, maybe_await

# =========================================================================== #
# exact integer money + qty helpers (match pnl.py / strategies.py semantics)  #
# =========================================================================== #
# Micro-dollars: uc = round(usd * 1e6)  (1e6 per $1, so $200 -> 200000000).
# Prices are carried as USD-per-whole-coin in micro-dollars (price_uc).
# Quantities are base units (int), scaled by 10^decimals.


def micro_usd(usd: Any) -> int:
    if usd is None or not is_finite(usd):
        return 0
    return js_round(float(usd) * 1e6)


def uc_to_usd(uc: Optional[int]) -> Optional[float]:
    return None if uc is None else float(uc) / 1e6


def div_round(num: int, den: int) -> int:
    """round(num / den), half-away-from-zero. ``den`` must be > 0."""
    if den <= 0:
        raise ValueError("div_round: denominator must be > 0")
    if num >= 0:
        return (num + den // 2) // den
    return -(((-num) + den // 2) // den)


def pow10(n: int) -> int:
    return 10 ** int(n)


def pct_to_bps(pct: Any) -> int:
    """percent (human, e.g. 2 means 2%) -> integer basis points (200)."""
    return js_round(float(pct) * 100)


def qty_for_usd(usd_size_uc: int, price_uc: int, bd: int) -> int:
    """base units bought/sold for ``usd_size_uc`` at ``price_uc`` (USD/coin), base
    decimals ``bd``. FLOORS — the SAME floor convention as strategies.usd_to_base."""
    if price_uc <= 0 or usd_size_uc <= 0:
        return 0
    return (usd_size_uc * pow10(bd)) // price_uc


def value_of(qty: int, price_uc: int, bd: int) -> int:
    """exact micro-dollar value of ``qty`` base units at ``price_uc``, decimals ``bd``."""
    if qty <= 0 or price_uc <= 0:
        return 0
    return div_round(qty * price_uc, pow10(bd))


def avg_entry_of(cost_uc: int, qty: int, bd: int) -> int:
    """weighted average entry (USD/coin, micro-dollars) of ``cost_uc`` over ``qty``."""
    if qty <= 0:
        return 0
    return div_round(cost_uc * pow10(bd), qty)


def apply_bps(price_uc: int, bps: Any) -> int:
    """apply a bps delta to a price: price_uc * (10000 + bps) / 10000. bps may be < 0."""
    return div_round(price_uc * (10000 + js_round(bps)), 10000)


def scaled_usd_uc(usd: Any, volume_scale: Any, k: int) -> int:
    """scale a USD size by volume_scale^k and return micro-dollars. Documented
    rounding so JS/Dart/Python land on the same integer."""
    f = float(usd) * (float(volume_scale) ** k)
    return js_round(f * 1e6)


# The mandatory agent fee is 0.05% (= 5 bps) of the trade, skimmed on-chain to the
# treasury as part of the SAME gated action (tools swap / runner fee leg). The
# per-bot allocation ledger must bound the TRUE outflow = trade + fee, so it
# cap-checks + accrues trade+fee. int-exact, half-away-from-zero.
AGENT_FEE_BPS = 5


def agent_fee_uc(trade_uc: Optional[int]) -> int:
    if trade_uc is None or trade_uc <= 0:
        return 0
    return div_round(trade_uc * AGENT_FEE_BPS, 10000)


def split_pair(pair: Any) -> List[str]:
    parts = str(pair or "").upper().split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("bad pair (want BASE/QUOTE): " + str(pair))
    return [parts[0], parts[1]]


DEFAULT_DECIMALS = {
    "BLOCK": 8, "BTC": 8, "LTC": 8, "DOGE": 8,
    "USDC": 6, "USDT": 6, "DAI": 6, "USD": 2, "USDBC": 6, "PYUSD": 6,
    "ETH": 18, "WETH": 18, "SOL": 9,
}


def decimals_for(sym: Any, overrides: Optional[Dict[str, Any]] = None) -> int:
    key = str(sym).upper()
    if overrides is not None:
        o = overrides.get(key)
        if o is not None:
            return int(o)
    d = DEFAULT_DECIMALS.get(key)
    return d if d is not None else 8


# =========================================================================== #
# config validation + defaults per bot type                                   #
# =========================================================================== #

TYPES = ["dca", "grid", "smarttrade", "signal", "rebalance", "momentum"]


def _num(v: Any, dflt: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return float(dflt)
    if not is_finite(n):
        return float(dflt)
    return n


def clamp_num(v: Any, lo: float, hi: float, dflt: float) -> float:
    n = _num(v, dflt)
    return max(lo, min(hi, n))


def clamp_int(v: Any, lo: float, hi: float, dflt: float) -> int:
    return int(clamp_num(v, lo, hi, dflt))  # trunc toward zero (values here are >= 0)


def validate_dca_config(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    c = c or {}
    start = c.get("startCondition")
    return {
        "baseOrderUsd": max(0.0, _num(c.get("baseOrderUsd", 20), 20)),
        "safetyOrderUsd": max(0.0, _num(c.get("safetyOrderUsd", 20), 20)),
        "maxSafetyOrders": clamp_int(c.get("maxSafetyOrders", 3), 0, 50, 3),
        "safetyStepPct": max(0.0, _num(c.get("safetyStepPct", 2), 2)),
        "safetyStepScale": max(0.01, _num(c.get("safetyStepScale", 1.0), 1.0)),
        "safetyVolumeScale": clamp_num(c.get("safetyVolumeScale", 1.0), 0.01, 3, 1.0),
        "takeProfitPct": max(0.0, _num(c.get("takeProfitPct", 2), 2)),
        "trailingTpPct": max(0.0, _num(c.get("trailingTpPct", 0), 0)),
        "stopLossPct": max(0.0, _num(c.get("stopLossPct", 0), 0)),
        "cooldownSec": max(0, int(_num(c.get("cooldownSec", 0), 0))),
        "startCondition": start if start in ("asap", "signal", "dip") else "asap",
        "dipPct": max(0.0, _num(c.get("dipPct", 0), 0)),
    }


def validate_grid_config(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    c = c or {}
    if c.get("lowerPrice") is None or c.get("upperPrice") is None:
        raise ValueError("grid requires lowerPrice and upperPrice")
    lower = float(c["lowerPrice"])
    upper = float(c["upperPrice"])
    if not (lower > 0) or not (upper > lower):
        raise ValueError("grid requires 0 < lowerPrice < upperPrice")
    return {
        "lowerPrice": lower, "upperPrice": upper,
        "gridCount": clamp_int(c.get("gridCount", 6), 2, 50, 6),
        "totalUsd": max(0.0, _num(c.get("totalUsd", 60), 60)),
        "takeProfitPct": max(0.0, _num(c.get("takeProfitPct", 0), 0)),
        "stopLossPct": max(0.0, _num(c.get("stopLossPct", 0), 0)),
    }


def validate_smart_trade_config(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    c = c or {}
    entry = c.get("entry") if isinstance(c.get("entry"), dict) else {"kind": "market"}
    kind = entry.get("kind") if entry.get("kind") in ("market", "limit", "ladder") else "market"
    tps = c.get("takeProfits")
    if not (isinstance(tps, list) and len(tps)):
        tps = [{"pct": 5, "sharePct": 100}]
    tps = [{"pct": max(0.0, _num(t.get("pct"), 0)),
            "sharePct": clamp_num(t.get("sharePct"), 0, 100, 100)} for t in tps]
    sl = c.get("stopLoss") if isinstance(c.get("stopLoss"), dict) else {"pct": 0, "trailing": False}
    return {
        "amountUsd": max(0.0, _num(c.get("amountUsd", 20), 20)),
        "entry": {"kind": kind, "price": float(entry["price"]) if entry.get("price") is not None else None},
        "takeProfits": tps,
        "stopLoss": {"pct": max(0.0, _num(sl.get("pct", 0), 0)), "trailing": bool(sl.get("trailing"))},
    }


def validate_signal_config(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    c = c or {}
    on_signal = c.get("onSignal") if isinstance(c.get("onSignal"), dict) else {"type": "dca", "config": {}}
    t = on_signal.get("type") if on_signal.get("type") in TYPES else "dca"
    return {
        "source": c.get("source") if c.get("source") in ("discovery", "inbox", "both") else "discovery",
        "maxConcurrent": clamp_int(c.get("maxConcurrent", 3), 1, 50, 3),
        "minScore": clamp_num(c.get("minScore", 0), 0, 1, 0),
        "onSignal": {"type": t, "config": validate_config(t, on_signal.get("config") or {})},
    }


def validate_scheduled_config(c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    # rebalance / momentum reuse the strategy planners; carry their params through.
    return dict(c or {})


def validate_config(type_: str, c: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if type_ == "dca":
        return validate_dca_config(c)
    if type_ == "grid":
        return validate_grid_config(c)
    if type_ == "smarttrade":
        return validate_smart_trade_config(c)
    if type_ == "signal":
        return validate_signal_config(c)
    if type_ in ("rebalance", "momentum"):
        return validate_scheduled_config(c)
    raise ValueError("unknown bot type: " + str(type_))


def dca_bps(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """bps-converted copy of a dca config (internal engine use)."""
    return {
        "baseOrderUsd": cfg["baseOrderUsd"],
        "safetyOrderUsd": cfg["safetyOrderUsd"],
        "maxSafetyOrders": cfg["maxSafetyOrders"],
        "safetyStepBps": pct_to_bps(cfg["safetyStepPct"]),
        "safetyStepScale": cfg["safetyStepScale"],
        "safetyVolumeScale": cfg["safetyVolumeScale"],
        "takeProfitBps": pct_to_bps(cfg["takeProfitPct"]),
        "trailingTpBps": pct_to_bps(cfg["trailingTpPct"]),
        "stopLossBps": pct_to_bps(cfg["stopLossPct"]),
    }


# =========================================================================== #
# DEAL ENGINE — DCA (§2.1 flagship)                                           #
# =========================================================================== #
# A deal is one open->manage->close lifecycle. The engine is PURE: dca_step
# reads (deal, mark_uc) and returns the next order (or None); dca_apply records a
# completed fill into the deal. The BotRunner interposes the gate between them.


def new_dca_deal(id_: str, now: int = 0) -> Dict[str, Any]:
    return {
        "id": id_, "type": "dca", "status": "pending", "openedAt": now or 0, "closedAt": None,
        "fills": [], "filledQty": 0, "costUc": 0, "avgEntryUc": 0,
        "safetyOrdersUsed": 0, "curStepBps": 0, "nextTriggerUc": 0,
        "peakUc": 0, "tpArmed": False, "realizedUc": 0, "reason": None,
    }


def dca_observe(deal: Dict[str, Any], mark_uc: int) -> Dict[str, Any]:
    """Update peak while a trailing stop is armed (no fill)."""
    if deal["tpArmed"] and mark_uc > deal["peakUc"]:
        deal["peakUc"] = mark_uc
    return deal


def dca_step(deal: Dict[str, Any], bcfg: Dict[str, Any], mark_uc: int) -> Optional[Dict[str, Any]]:
    """Decide the SINGLE next action for a DCA deal at ``mark_uc``. Returns an order
    dict (``{action, side, usdSizeUc?, qty?, kind}``) or ``None``. ``action:'arm'``
    carries no side — it is a pure trailing-stop arming (applyFill records it with
    fill=None). The BotRunner loops dca_step until it returns None."""
    if deal["status"] == "closed":
        return None
    if deal["status"] == "pending" or deal["filledQty"] <= 0:
        return {"action": "base", "side": "buy", "kind": "base", "usdSizeUc": micro_usd(bcfg["baseOrderUsd"])}

    # --- take-profit (plain or trailing) ------------------------------------
    tp_target = apply_bps(deal["avgEntryUc"], bcfg["takeProfitBps"])
    if bcfg["trailingTpBps"] > 0:
        if deal["tpArmed"]:
            stop = apply_bps(deal["peakUc"], -bcfg["trailingTpBps"])
            if mark_uc <= stop:
                return {"action": "tp", "side": "sell", "kind": "tp", "qty": deal["filledQty"]}
        elif mark_uc >= tp_target:
            return {"action": "arm", "side": None, "kind": "arm"}  # arm trailing, no fill
    elif mark_uc >= tp_target:
        return {"action": "tp", "side": "sell", "kind": "tp", "qty": deal["filledQty"]}

    # --- stop-loss ----------------------------------------------------------
    if bcfg["stopLossBps"] > 0:
        sl = apply_bps(deal["avgEntryUc"], -bcfg["stopLossBps"])
        if mark_uc <= sl:
            return {"action": "sl", "side": "sell", "kind": "sl", "qty": deal["filledQty"]}

    # --- safety order ladder ------------------------------------------------
    if deal["safetyOrdersUsed"] < bcfg["maxSafetyOrders"] and mark_uc <= deal["nextTriggerUc"]:
        k = deal["safetyOrdersUsed"]  # first SO uses volumeScale^0
        return {"action": "safety", "side": "buy", "kind": "safety",
                "usdSizeUc": scaled_usd_uc(bcfg["safetyOrderUsd"], bcfg["safetyVolumeScale"], k)}
    return None


def dca_apply(deal: Dict[str, Any], bcfg: Dict[str, Any], order: Dict[str, Any],
              fill: Optional[Dict[str, Any]], now: int = 0) -> Dict[str, Any]:
    """Record a completed fill into the DCA deal. For a buy fill:
    ``fill = {qty, priceUc, costUc}``. For a sell (tp/sl):
    ``{qty, priceUc, proceedsUc}``. For an 'arm' order, ``fill`` is None."""
    if order["action"] == "arm":
        deal["tpArmed"] = True
        if deal["peakUc"] < order["_markUc"]:
            deal["peakUc"] = order["_markUc"]
        return deal
    if order["side"] == "buy":
        deal["status"] = "open"
        deal["filledQty"] += fill["qty"]
        deal["costUc"] += fill["costUc"]
        deal["avgEntryUc"] = avg_entry_of(deal["costUc"], deal["filledQty"], fill["bd"])
        if order["kind"] == "base":
            deal["openedAt"] = now or deal["openedAt"]
            deal["safetyOrdersUsed"] = 0
            deal["curStepBps"] = bcfg["safetyStepBps"]
        else:
            deal["safetyOrdersUsed"] += 1
            deal["curStepBps"] = js_round(deal["curStepBps"] * bcfg["safetyStepScale"])
        deal["nextTriggerUc"] = apply_bps(fill["priceUc"], -deal["curStepBps"])
        deal["fills"].append({"side": "buy", "kind": order["kind"], "priceUc": fill["priceUc"],
                              "qty": fill["qty"], "costUc": fill["costUc"], "ts": now or 0,
                              "paper": bool(fill.get("paper")), "txid": fill.get("txid")})
    else:
        deal["status"] = "closed"
        deal["closedAt"] = now or 0
        deal["reason"] = order["kind"]  # 'tp' | 'sl'
        deal["realizedUc"] = (fill.get("proceedsUc") or 0) - deal["costUc"]
        deal["fills"].append({"side": "sell", "kind": order["kind"], "priceUc": fill["priceUc"],
                              "qty": fill["qty"], "proceedsUc": fill.get("proceedsUc"), "ts": now or 0,
                              "paper": bool(fill.get("paper")), "txid": fill.get("txid")})
    return deal


# =========================================================================== #
# DEAL ENGINE — GRID (§2.2)                                                    #
# =========================================================================== #
# A ladder of limit levels between lower/upper. A buy level that fills arms a
# sell one grid UP; a sell that fills arms a buy one grid DOWN (fill-flip).
# Level state persists. No market orders.


def grid_build(cfg: Dict[str, Any], mid_uc: int, bd: int) -> List[Dict[str, Any]]:
    n = cfg["gridCount"]
    lower_uc = micro_usd(cfg["lowerPrice"])
    upper_uc = micro_usd(cfg["upperPrice"])
    span_uc = upper_uc - lower_uc
    size_uc = div_round(micro_usd(cfg["totalUsd"]), n)
    levels = []
    for i in range(n):
        price_uc = lower_uc + div_round(span_uc * i, n - 1)
        # seed: buy below mid, sell above mid; skip a level exactly at mid.
        side = None
        if price_uc < mid_uc:
            side = "buy"
        elif price_uc > mid_uc:
            side = "sell"
        qty = qty_for_usd(size_uc, price_uc, bd)
        levels.append({"i": i, "priceUc": price_uc, "sizeUc": size_uc, "qty": qty,
                       "side": side, "status": "open" if side else "idle", "heldQty": 0})
    return levels


def new_grid_deal(id_: str, cfg: Dict[str, Any], mid_uc: int, bd: int, now: int = 0) -> Dict[str, Any]:
    return {
        "id": id_, "type": "grid", "status": "open", "openedAt": now or 0, "closedAt": None, "bd": bd,
        "levels": grid_build(cfg, mid_uc, bd), "fills": [], "realizedUc": 0,
    }


def grid_bcfg(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """bps-converted copy of a grid config (for the optional whole-grid TP/SL exit)."""
    out = dict(cfg)
    out["_tpBps"] = pct_to_bps(cfg.get("takeProfitPct") or 0)
    out["_slBps"] = pct_to_bps(cfg.get("stopLossPct") or 0)
    return out


def grid_step(deal: Dict[str, Any], mark_uc: int, bcfg: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Decide the next fillable grid level at ``mark_uc``: a BUY level fills when
    mark_uc <= its price; a SELL level when mark_uc >= its price. An optional
    WHOLE-GRID take-profit/stop-loss liquidates all held levels (no re-arm)."""
    if deal["status"] == "closed":
        return None

    # --- optional whole-grid TP/SL exit -------------------------------------
    if bcfg and ((bcfg.get("_tpBps", 0) > 0) or (bcfg.get("_slBps", 0) > 0)):
        held = 0
        basis = 0
        for lv in deal["levels"]:
            if lv["heldQty"] > 0:
                held += lv["heldQty"]
                basis += (lv.get("_costUc") or 0)
        if held > 0 and basis > 0:
            val = value_of(held, mark_uc, deal["bd"])
            tp_hit = bcfg.get("_tpBps", 0) > 0 and val >= div_round(basis * (10000 + bcfg["_tpBps"]), 10000)
            sl_hit = bcfg.get("_slBps", 0) > 0 and val <= div_round(basis * (10000 - bcfg["_slBps"]), 10000)
            if tp_hit or sl_hit:
                for lv in deal["levels"]:
                    if lv["heldQty"] > 0:
                        return {"action": "sell", "side": "sell", "kind": "grid_exit", "exit": True,
                                "levelIndex": lv["i"], "qty": lv["heldQty"], "_levelPriceUc": lv["priceUc"]}

    # buys first (deterministic order): lowest index that is fillable.
    for lv in deal["levels"]:
        if lv["status"] == "open" and lv["side"] == "buy" and mark_uc <= lv["priceUc"]:
            return {"action": "buy", "side": "buy", "kind": "grid", "levelIndex": lv["i"],
                    "qty": lv["qty"], "_levelPriceUc": lv["priceUc"]}
    for lv in deal["levels"]:
        if lv["status"] == "open" and lv["side"] == "sell" and mark_uc >= lv["priceUc"] and lv["heldQty"] > 0:
            return {"action": "sell", "side": "sell", "kind": "grid", "levelIndex": lv["i"],
                    "qty": lv["heldQty"], "_levelPriceUc": lv["priceUc"]}
    return None


def grid_apply(deal: Dict[str, Any], order: Dict[str, Any], fill: Dict[str, Any], now: int = 0) -> Dict[str, Any]:
    """Record a grid fill + perform the fill-flip. fill = {qty, priceUc, costUc|proceedsUc}."""
    lv = deal["levels"][order["levelIndex"]]
    # Record the exchange orderId of the live order we just placed onto its level
    # so KILL's best-effort _cancel_open_orders can find + cancel it (paper = None).
    if fill and fill.get("orderId") is not None:
        lv["orderId"] = fill["orderId"]
    if order.get("exit"):
        realized = (fill.get("proceedsUc") or 0) - (lv.get("_costUc") or 0)
        deal["realizedUc"] += realized
        lv["status"] = "exited"
        lv["heldQty"] = 0
        lv["_costUc"] = 0
        deal["fills"].append({"side": "sell", "kind": "grid_exit", "level": lv["i"],
                              "priceUc": fill["priceUc"], "qty": fill["qty"], "proceedsUc": fill.get("proceedsUc"),
                              "realizedUc": realized, "ts": now or 0, "paper": bool(fill.get("paper")),
                              "txid": fill.get("txid")})
        if not any(l["heldQty"] > 0 for l in deal["levels"]):
            deal["status"] = "closed"
            deal["closedAt"] = now or 0
            deal["reason"] = "grid_exit"
        return deal
    if order["side"] == "buy":
        lv["status"] = "filled"
        lv["heldQty"] = 0          # inventory moves to the armed SELL one grid up
        lv["_costUc"] = 0          #   (held ONCE — never double-counted in aggregation)
        deal["fills"].append({"side": "buy", "kind": "grid", "level": lv["i"], "priceUc": fill["priceUc"],
                              "qty": fill["qty"], "costUc": fill["costUc"], "ts": now or 0,
                              "paper": bool(fill.get("paper")), "txid": fill.get("txid")})
        # arm a SELL one grid up carrying the bought inventory + its cost basis
        if order["levelIndex"] + 1 < len(deal["levels"]):
            up = deal["levels"][order["levelIndex"] + 1]
            up["side"] = "sell"
            up["status"] = "open"
            up["heldQty"] = fill["qty"]
            up["_costUc"] = fill["costUc"]
    else:
        lv["status"] = "open"     # level is freed, ready to buy again if flipped back
        lv["side"] = "sell"
        realized = (fill.get("proceedsUc") or 0) - (lv.get("_costUc") or 0)
        deal["realizedUc"] += realized
        lv["heldQty"] = 0
        lv["_costUc"] = 0
        deal["fills"].append({"side": "sell", "kind": "grid", "level": lv["i"], "priceUc": fill["priceUc"],
                              "qty": fill["qty"], "proceedsUc": fill.get("proceedsUc"), "realizedUc": realized,
                              "ts": now or 0, "paper": bool(fill.get("paper")), "txid": fill.get("txid")})
        # arm a BUY one grid down
        if order["levelIndex"] - 1 >= 0:
            down = deal["levels"][order["levelIndex"] - 1]
            down["side"] = "buy"
            down["status"] = "open"
    return deal


# =========================================================================== #
# DEAL ENGINE — SMARTTRADE (§2.3)                                              #
# =========================================================================== #
# One managed position: an entry fill, then split take-profits (each sells a
# share of the ORIGINAL position), plus an optional stop-loss (trailing opt.).


def new_smart_trade_deal(id_: str, cfg: Dict[str, Any], now: int = 0) -> Dict[str, Any]:
    return {
        "id": id_, "type": "smarttrade", "status": "pending", "openedAt": now or 0, "closedAt": None,
        "fills": [], "entryQty": 0, "entryCostUc": 0, "avgEntryUc": 0, "remainingQty": 0,
        "tpsHit": [False for _ in cfg["takeProfits"]], "peakUc": 0, "slArmed": False,
        "realizedUc": 0, "reason": None,
    }


def smart_step(deal: Dict[str, Any], cfg: Dict[str, Any], mark_uc: int) -> Optional[Dict[str, Any]]:
    if deal["status"] == "closed":
        return None
    if deal["status"] == "pending" or deal["entryQty"] <= 0:
        return {"action": "entry", "side": "buy", "kind": "entry", "usdSizeUc": micro_usd(cfg["amountUsd"])}
    # staged take-profits (in configured order)
    sl_bps = pct_to_bps(cfg["stopLoss"]["pct"])
    if cfg["stopLoss"]["trailing"] and sl_bps > 0 and mark_uc > deal["peakUc"]:
        deal["peakUc"] = mark_uc
    for t in range(len(cfg["takeProfits"])):
        if deal["tpsHit"][t]:
            continue
        target = apply_bps(deal["avgEntryUc"], pct_to_bps(cfg["takeProfits"][t]["pct"]))
        if mark_uc >= target:
            share_bps = pct_to_bps(cfg["takeProfits"][t]["sharePct"])
            qty = div_round(deal["entryQty"] * share_bps, 10000)
            if qty > deal["remainingQty"]:
                qty = deal["remainingQty"]
            return {"action": "tp", "side": "sell", "kind": "tp", "qty": qty, "tpIndex": t}
    # stop-loss (plain from avg, or trailing from peak)
    if sl_bps > 0 and deal["remainingQty"] > 0:
        stop = apply_bps(deal["peakUc"], -sl_bps) if cfg["stopLoss"]["trailing"] else apply_bps(deal["avgEntryUc"], -sl_bps)
        if mark_uc <= stop:
            return {"action": "sl", "side": "sell", "kind": "sl", "qty": deal["remainingQty"]}
    return None


def smart_apply(deal: Dict[str, Any], cfg: Dict[str, Any], order: Dict[str, Any],
                fill: Dict[str, Any], now: int = 0) -> Dict[str, Any]:
    if order["side"] == "buy":
        deal["status"] = "open"
        deal["entryQty"] = fill["qty"]
        deal["entryCostUc"] = fill["costUc"]
        deal["remainingQty"] = fill["qty"]
        deal["avgEntryUc"] = avg_entry_of(fill["costUc"], fill["qty"], fill["bd"])
        deal["peakUc"] = fill["priceUc"]
        deal["openedAt"] = now or deal["openedAt"]
        deal["fills"].append({"side": "buy", "kind": "entry", "priceUc": fill["priceUc"], "qty": fill["qty"],
                              "costUc": fill["costUc"], "ts": now or 0, "paper": bool(fill.get("paper")),
                              "txid": fill.get("txid")})
        return deal
    # a sell: TP share or SL remainder
    basis_uc = value_of(fill["qty"], deal["avgEntryUc"], fill["bd"])
    realized = (fill.get("proceedsUc") or 0) - basis_uc
    deal["realizedUc"] += realized
    deal["remainingQty"] -= fill["qty"]
    if order["kind"] == "tp":
        deal["tpsHit"][order["tpIndex"]] = True
    deal["fills"].append({"side": "sell", "kind": order["kind"], "priceUc": fill["priceUc"], "qty": fill["qty"],
                          "proceedsUc": fill.get("proceedsUc"), "basisUc": basis_uc, "realizedUc": realized,
                          "ts": now or 0, "paper": bool(fill.get("paper")), "txid": fill.get("txid")})
    if deal["remainingQty"] <= 0:
        deal["status"] = "closed"
        deal["closedAt"] = now or 0
        deal["reason"] = order["kind"]
    return deal


# =========================================================================== #
# engine registry — a uniform surface the BotRunner drives                    #
# =========================================================================== #
ENGINES: Dict[str, Dict[str, Any]] = {
    "dca": {
        "new_deal": new_dca_deal, "observe": dca_observe, "step": dca_step, "apply": dca_apply,
        "bcfg": dca_bps,
    },
    "grid": {
        "new_deal": new_grid_deal, "observe": (lambda d, m: d), "step": grid_step, "apply": grid_apply,
        "bcfg": grid_bcfg,
    },
    "smarttrade": {
        "new_deal": new_smart_trade_deal, "observe": (lambda d, m: d), "step": smart_step, "apply": smart_apply,
    },
}


# =========================================================================== #
# Bot model                                                                   #
# =========================================================================== #

_id_seq = 0


def gen_id(prefix: Optional[str] = None) -> str:
    global _id_seq
    _id_seq += 1
    ms = int(time.time() * 1000)
    return (prefix or "bot") + "_" + _base36(ms) + "_" + _base36(_id_seq)


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    n = abs(n)
    while n:
        out = digits[n % 36] + out
        n //= 36
    return out


# state (de)serialization: int <-> string on known money keys ----------------
BIGINT_KEYS = {
    "priceUc", "qty", "costUc", "proceedsUc", "avgEntryUc", "nextTriggerUc", "peakUc",
    "realizedUc", "usdSizeUc", "filledQty", "sizeUc", "committedUc", "maxDrawdownUc",
    "heldQty", "entryQty", "entryCostUc", "remainingQty", "basisUc", "_costUc",
    "_levelPriceUc", "_markUc", "_peakRealizedUc",
}


def encode_state(o: Any, key: Optional[str] = None) -> Any:
    if isinstance(o, list):
        return [encode_state(v) for v in o]
    if isinstance(o, dict):
        return {k: encode_state(v, k) for k, v in o.items()}
    if key in BIGINT_KEYS and isinstance(o, int) and not isinstance(o, bool):
        return str(o)
    return o


def decode_state(o: Any, key: Optional[str] = None) -> Any:
    if isinstance(o, list):
        return [decode_state(v) for v in o]
    if isinstance(o, dict):
        return {k: decode_state(v, k) for k, v in o.items()}
    if key in BIGINT_KEYS and o is not None and not isinstance(o, (dict, list)):
        return int(o)
    return o


class Bot:
    def __init__(self, spec: Optional[Dict[str, Any]] = None):
        spec = spec or {}
        if spec.get("type") not in TYPES:
            raise ValueError("unknown bot type: " + str(spec.get("type")))
        self.id = spec.get("id") or gen_id(spec.get("type"))
        self.name = spec.get("name") or (spec["type"] + " bot")
        self.type = spec["type"]
        self.universe = spec.get("universe") or {"pairs": []}
        self.chain_prefs = spec.get("chainPrefs")
        self.venue_prefs = spec.get("venuePrefs")
        self.config = validate_config(spec["type"], spec.get("config") or {})
        self.allocation_usd = float(spec["allocationUsd"]) if spec.get("allocationUsd") is not None else 0.0
        # SAFETY DEFAULTS (§5): paper + disabled + testnet.
        self.mode = "live" if spec.get("mode") == "live" else "paper"
        self.enabled = spec.get("enabled") is True
        self.network = "mainnet" if spec.get("network") == "mainnet" else "testnet"
        self.poll_sec = max(1, int(float(spec["pollSec"]))) if spec.get("pollSec") is not None else 60
        self.cooldown_sec = max(0, int(float(spec["cooldownSec"]))) if spec.get("cooldownSec") is not None else 0
        self.created_at = float(spec["createdAt"]) if spec.get("createdAt") is not None else int(time.time() * 1000)
        self.wallet = spec.get("wallet") or "default"
        self.channel = spec.get("channel") or "default"
        self.state = spec.get("state") if spec.get("state") is not None else Bot.fresh_state()

    @staticmethod
    def fresh_state() -> Dict[str, Any]:
        return {
            "byPair": {},         # pairKey -> { deal, levels, lastCloseAt }
            "closedDeals": [],    # archived closed deals (dashboard history)
            "realizedUc": 0,      # cumulative realized (micro-dollars)
            "committedUc": 0,     # per-bot committed LIVE spend (allocation ledger)
            "dealCount": 0, "winCount": 0, "lossCount": 0,
            "maxDrawdownUc": 0,
            "inbox": [],          # signal bot local inbox
            "cursor": 0,          # signal bot processed-count cursor
            "lastTickAt": 0,
        }

    def pairs(self) -> List[str]:
        if self.universe and isinstance(self.universe.get("pairs"), list):
            return list(self.universe["pairs"])
        return []

    def describe(self) -> str:
        """Plain-language one-liner for the create preview (§5a)."""
        c = self.config
        if self.type == "dca":
            p = (self.pairs() or ["?"])[0]
            base = split_pair(str(p))[0] if "/" in str(p) else str(p)
            s = ("Buys $" + _plain(c["baseOrderUsd"]) + " of " + base + ", adds up to " +
                 _plain(c["maxSafetyOrders"]) + " times if it dips " + _plain(c["safetyStepPct"]) +
                 "%, takes profit at +" + _plain(c["takeProfitPct"]) + "%")
            if c["trailingTpPct"] > 0:
                s += " (trailing " + _plain(c["trailingTpPct"]) + "%)"
            return s + "."
        if self.type == "grid":
            return ("Grid of " + _plain(c["gridCount"]) + " levels from " + _plain(c["lowerPrice"]) +
                    " to " + _plain(c["upperPrice"]) + ", $" + _plain(c["totalUsd"]) + " total.")
        if self.type == "smarttrade":
            return "Buys $" + _plain(c["amountUsd"]) + ", takes profit in " + _plain(len(c["takeProfits"])) + " step(s)."
        if self.type == "signal":
            return "Launches a " + c["onSignal"]["type"] + " bot per matching " + c["source"] + " signal."
        return self.type + " bot."

    def to_json(self) -> Dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "type": self.type, "universe": self.universe,
            "chainPrefs": self.chain_prefs, "venuePrefs": self.venue_prefs, "config": self.config,
            "allocationUsd": self.allocation_usd, "mode": self.mode, "enabled": self.enabled,
            "network": self.network, "pollSec": self.poll_sec, "cooldownSec": self.cooldown_sec,
            "createdAt": self.created_at, "wallet": self.wallet, "channel": self.channel,
            "state": encode_state(self.state),
        }

    # JS parity alias
    toJSON = to_json

    @property
    def allocationUsd(self):  # JS-style attribute parity for the runner/tests
        return self.allocation_usd

    @allocationUsd.setter
    def allocationUsd(self, v):
        self.allocation_usd = float(v)

    @staticmethod
    def from_json(obj: Optional[Dict[str, Any]]) -> "Bot":
        obj = obj or {}
        spec = dict(obj)
        spec["state"] = decode_state(obj["state"]) if obj.get("state") is not None else Bot.fresh_state()
        return Bot(spec)

    fromJSON = from_json


def _plain(v: Any) -> str:
    """Render a number the way JS string-concatenation would (no trailing .0)."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


# =========================================================================== #
# BotStore — persists bots + deal state per (wallet, channel). NO key material.
# =========================================================================== #
class BotStore:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self.store = opts.get("store")          # { set(obj), get(keys) } persistence shim
        self.store_key = opts.get("key") or "agentBots"
        self.wallet = opts.get("wallet") or "default"
        self.channel = opts.get("channel") or "default"
        self.bots: Dict[str, Bot] = {}

    def _scope_key(self) -> str:
        return self.store_key + ":" + self.wallet + ":" + self.channel

    def add(self, bot: Any) -> Bot:
        if not isinstance(bot, Bot):
            bot = Bot(bot)
        bot.wallet = bot.wallet or self.wallet
        bot.channel = bot.channel or self.channel
        self.bots[bot.id] = bot
        return bot

    def get(self, id_: str) -> Optional[Bot]:
        return self.bots.get(id_)

    def remove(self, id_: str) -> bool:
        return self.bots.pop(id_, None) is not None

    def list(self) -> List[Bot]:
        return list(self.bots.values())

    def enabled(self) -> List[Bot]:
        return [b for b in self.list() if b.enabled]

    def snapshot(self) -> Dict[str, Any]:
        return {"wallet": self.wallet, "channel": self.channel, "bots": [b.to_json() for b in self.list()]}

    def load(self, snap: Optional[Dict[str, Any]]) -> "BotStore":
        self.bots.clear()
        if not snap or not isinstance(snap.get("bots"), list):
            return self
        for o in snap["bots"]:
            b = Bot.from_json(o)
            self.bots[b.id] = b
        return self

    async def persist(self) -> None:
        if not self.store:
            return
        try:
            await maybe_await(self.store.set({self._scope_key(): self.snapshot()}))
        except Exception:
            pass

    async def restore(self) -> "BotStore":
        if not self.store or not hasattr(self.store, "get"):
            return self
        try:
            got = await maybe_await(self.store.get([self._scope_key()]))
            snap = got.get(self._scope_key()) if isinstance(got, dict) else None
            if snap:
                self.load(snap)
        except Exception:
            pass
        return self


def create(spec: Optional[Dict[str, Any]] = None) -> Bot:
    return Bot(spec)
