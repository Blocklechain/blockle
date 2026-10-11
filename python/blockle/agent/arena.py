"""agent/arena.py — the Blockle ARENA: a gamified, play-money sandbox (spec
docs/BLOCKLE-BOTS.md §9). A faithful Python port of the REFERENCE implementation
``blockle-extension/agent/arena.js``; the numbers here match it EXACTLY (checked
against the shared fixture ``docs/arena-vectors.json``, which is LOADED, never
regenerated).

===========================================================================
HARD SAFETY RULE (non-negotiable, structural):
  Arena touches NO keys, NO vault, NO policy gate, NO broadcast, NO reserve.
  It is PURE in-memory simulation with VIRTUAL funds labeled PLAY/TEST that can
  NEVER be converted, withdrawn, or exchanged for anything real. There is no
  code path from an Arena run to commit/broadcast/record_spend/the reserve —
  this module depends ONLY on the PURE deal engine (:mod:`bots`) + the template
  export/import (:mod:`bot_templates`), never on :mod:`bot_runner` / :mod:`runner`
  / :mod:`policy` / :mod:`tools` / the gate. The one honest on-ramp
  ("use this for real") goes through the existing template import, which ALWAYS
  lands a bot paper + disabled + testnet.
===========================================================================

Pieces (all money base-unit/int-exact, micro-dollar integer basis):
  * :class:`PlayBalance`  — a virtual, labeled grant (default 🪙10,000 PLAY) that
                            can never become real (``convert_to_real`` raises).
  * scenario feed         — canonical price paths LOADED from
                            docs/arena-vectors.json (bull/crab/bear/crash/pump).
  * :func:`run_scenario`  — drive the PURE deal engine over a price path in SIM
                            mode -> fills, equity curve, play PnL, max drawdown,
                            max cost basis.
  * :func:`score`         — the pinned §9 formula round1(retPct - 0.5*ddPct), all
                            micro-dollar integer math off the deal engine's fills.
  * XP + levels           — advisory UX progression (gating is NOT a safety rail).
  * missions              — clear win condition + reward.
  * badges                — milestone achievements.
  * :class:`Leaderboard`  — LOCAL-first only (personal best + on-device board; NO
                            network/global board in v1).
  * use-for-real          — export the Arena config as a Bot template (§6); import
                            lands paper + disabled + testnet, NEVER auto-live.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from ..multichain._util import is_finite, js_round
from . import bots as _bots
from . import bot_templates as _templates

# Honesty guardrail (§9): a persistent, never-removed disclaimer. Arena must NEVER
# imply simulated results predict real profit.
DISCLAIMER = (
    "Simulation — not financial advice; simulated performance does not predict "
    "real results."
)

# Everything in the Arena is PLAY money. These labels appear everywhere a balance
# or PnL is shown. They are not a currency with any real value.
PLAY_LABEL = "PLAY"
PLAY_SYMBOL = "🪙"
DEFAULT_GRANT = 10000  # play dollars
SIMULATION_ONLY = True  # structural marker; Arena can never go live

SCENARIOS = ["bull", "crab", "bear", "crash", "pump"]


# =========================================================================== #
# PlayBalance — a virtual, labeled grant. CANNOT become real.                 #
# =========================================================================== #
class PlayBalance:
    def __init__(self, grant_usd: Any = None):
        self.label = PLAY_LABEL
        self.symbol = PLAY_SYMBOL
        self.real = False          # hard: PLAY is never real
        self.convertible = False   # hard: can never convert/withdraw/exchange
        self.grant_uc = _bots.micro_usd(grant_usd if grant_usd is not None else DEFAULT_GRANT)
        self.balance_uc = self.grant_uc  # current play equity (grant + play PnL)

    # JS-parity attribute aliases
    @property
    def grantUc(self) -> int:
        return self.grant_uc

    @property
    def balanceUc(self) -> int:
        return self.balance_uc

    def apply_pnl(self, pnl_uc: Optional[int]) -> "PlayBalance":
        """Apply a run's realized+unrealized play PnL to the play balance. PLAY only."""
        self.balance_uc = self.balance_uc + (0 if pnl_uc is None else pnl_uc)
        return self

    applyPnl = apply_pnl

    def reset(self) -> "PlayBalance":
        self.balance_uc = self.grant_uc
        return self

    # HARD RULE enforced in code: there is NO path to make PLAY funds real.
    def convert_to_real(self, *args: Any, **kwargs: Any):
        raise RuntimeError(
            "PLAY funds can never be converted, withdrawn, or exchanged for anything real")

    convertToReal = convert_to_real
    withdraw = convert_to_real
    exchange = convert_to_real

    def to_json(self) -> Dict[str, Any]:
        return {
            "label": self.label, "real": False, "convertible": False,
            "grantUc": str(self.grant_uc), "balanceUc": str(self.balance_uc),
        }

    toJSON = to_json


# =========================================================================== #
# scenario feed — LOAD canonical price paths from docs/arena-vectors.json.     #
# The fixture is AUTHORITATIVE; we never regenerate the tested scenarios from  #
# a cross-language RNG. A live generator (below) may add extra variety only.   #
# =========================================================================== #
def load_scenarios(vectors: Optional[Dict[str, Any]]) -> Dict[str, List[float]]:
    if not vectors or not vectors.get("scenarios"):
        raise ValueError("arena: vectors.scenarios missing")
    out: Dict[str, List[float]] = {}
    for name in SCENARIOS:
        s = vectors["scenarios"].get(name)
        arr = s if isinstance(s, list) else (s or {}).get("priceSeriesUsd") if isinstance(s, dict) else None
        if not isinstance(arr, list) or not arr:
            raise ValueError("arena: scenario missing in fixture: " + name)
        out[name] = list(arr)
    return out


loadScenarios = load_scenarios


def price_path(vectors: Dict[str, Any], name: str) -> List[float]:
    s = load_scenarios(vectors)
    if name not in s:
        raise ValueError("arena: unknown scenario: " + str(name))
    return s[name]


pricePath = price_path


# Optional LIVE generator for EXTRA variety only (never the canonical scenarios).
# A tiny deterministic LCG so a (seed) reproduces, but these paths are NOT the
# fixture and are NOT leaderboard-comparable.
def _lcg(seed: int):
    state = {"s": (int(seed) & 0xFFFFFFFF) or 1}

    def nxt() -> float:
        state["s"] = (state["s"] * 1664525 + 1013904223) & 0xFFFFFFFF
        return state["s"] / 4294967296.0

    return nxt


def generate_path(shape: str, seed: int = 1, n: int = 120, start: float = 100.0) -> List[float]:
    n = n or 120
    start = start or 100.0
    rnd = _lcg(seed or 1)
    out: List[float] = []
    p = float(start)
    for i in range(n):
        t = i / (n - 1)
        drift = 0.0
        if shape == "bull":
            drift = 0.006
        elif shape == "bear":
            drift = -0.006
        elif shape == "crab":
            drift = 0.0
        elif shape == "crash":
            drift = -0.35 if i == int(n * 0.5) else 0.001
        elif shape == "pump":
            drift = 0.02 if t < 0.4 else -0.012
        shock = (rnd() - 0.5) * 0.02
        p = max(0.01, p * (1 + drift + shock))
        out.append(js_round(p * 1e6) / 1e6)
    return out


generatePath = generate_path


# =========================================================================== #
# run a bot config over a scenario path -> fills + equity curve (PURE sim).    #
# Mirrors BotRunner's PAPER fill math EXACTLY (exec_price = level price for     #
# grid, else the mark; qty FLOORS; value/cost = div_round) but NEVER the gate. #
# =========================================================================== #
def _paper_fill(order: Dict[str, Any], mark_uc: int, bd: int) -> Dict[str, Any]:
    exec_price_uc = order["_levelPriceUc"] if order.get("_levelPriceUc") is not None else mark_uc
    if order["side"] == "buy":
        if order.get("usdSizeUc") is not None:
            qty = (order["_qtyOverride"] if order.get("_qtyOverride") is not None
                   else _bots.qty_for_usd(order["usdSizeUc"], mark_uc, bd))
        else:
            qty = order["qty"]
        return {"side": "buy", "qty": qty, "priceUc": exec_price_uc,
                "costUc": _bots.value_of(qty, exec_price_uc, bd), "bd": bd, "paper": True}
    return {"side": "sell", "qty": order["qty"], "priceUc": exec_price_uc,
            "proceedsUc": _bots.value_of(order["qty"], exec_price_uc, bd), "bd": bd, "paper": True}


def _engine_step(type_: str, deal: Dict[str, Any], bcfg: Dict[str, Any],
                 cfg: Dict[str, Any], mark_uc: int) -> Optional[Dict[str, Any]]:
    if type_ == "dca":
        return _bots.dca_step(deal, bcfg, mark_uc)
    if type_ == "grid":
        return _bots.grid_step(deal, mark_uc, bcfg)
    if type_ == "smarttrade":
        return _bots.smart_step(deal, cfg, mark_uc)
    return None


def _engine_apply(type_: str, deal: Dict[str, Any], bcfg: Dict[str, Any], cfg: Dict[str, Any],
                  order: Dict[str, Any], fill: Optional[Dict[str, Any]], now: int) -> Any:
    if type_ == "dca":
        return _bots.dca_apply(deal, bcfg, order, fill, now)
    if type_ == "grid":
        return _bots.grid_apply(deal, order, fill, now)
    if type_ == "smarttrade":
        return _bots.smart_apply(deal, cfg, order, fill, now)


def _new_deal(type_: str, id_: str, cfg: Dict[str, Any], mid_uc: int, bd: int, now: int) -> Dict[str, Any]:
    if type_ == "grid":
        return _bots.new_grid_deal(id_, cfg, mid_uc, bd, now)
    if type_ == "smarttrade":
        return _bots.new_smart_trade_deal(id_, cfg, now)
    return _bots.new_dca_deal(id_, now)


def _deal_agg(type_: str, deal: Optional[Dict[str, Any]], mark_uc: int, bd: int) -> Dict[str, int]:
    """Current held-inventory cost + mark + realized for a deal, per engine type."""
    if not deal:
        return {"openCostUc": 0, "openMarkUc": 0, "realizedUc": 0}
    realized = deal.get("realizedUc") or 0
    if type_ == "grid":
        cost = 0
        mark = 0
        for lv in deal["levels"]:
            if lv["heldQty"] > 0:
                cost += (lv.get("_costUc") or 0)
                mark += _bots.value_of(lv["heldQty"], mark_uc, bd)
        return {"openCostUc": cost, "openMarkUc": mark, "realizedUc": realized}
    if type_ == "smarttrade":
        is_open = deal["status"] != "closed" and deal["remainingQty"] > 0
        return {
            "openCostUc": _bots.value_of(deal["remainingQty"], deal["avgEntryUc"], bd) if is_open else 0,
            "openMarkUc": _bots.value_of(deal["remainingQty"], mark_uc, bd) if is_open else 0,
            "realizedUc": realized,
        }
    # dca
    dopen = deal["status"] != "closed"
    return {
        "openCostUc": deal["costUc"] if dopen else 0,
        "openMarkUc": _bots.value_of(deal["filledQty"], mark_uc, bd) if dopen else 0,
        "realizedUc": realized,
    }


def _resolve_bot(spec: Any) -> Dict[str, Any]:
    """Resolve a bot SPEC/instance/config into {bot, type, cfg, bcfg, bd, pair}."""
    spec = spec or {}
    if isinstance(spec, _bots.Bot):
        bot = spec
    else:
        if spec.get("pair"):
            pairs = [str(spec["pair"]).upper()]
        else:
            pairs = list(((spec.get("universe") or {}).get("pairs")) or [])
        bot = _bots.create({
            "type": spec.get("type") or "dca",
            "name": spec.get("name"),
            "universe": {"pairs": pairs},
            "config": spec.get("config") or {},
        })
    pair = (bot.pairs()[0] if bot.pairs() else None) or (spec.get("pair") if isinstance(spec, dict) else None) or "BLOCK/USDC"
    base = _bots.split_pair(pair)[0]
    if isinstance(spec, dict) and spec.get("decimals") is not None:
        bd = int(spec["decimals"])
    else:
        bd = _bots.decimals_for(base, bot.config.get("decimals") if isinstance(bot.config, dict) else None)
    cfg = bot.config
    if bot.type == "dca":
        bcfg = _bots.dca_bps(cfg)
    elif bot.type == "grid":
        bcfg = _bots.grid_bcfg(cfg)
    else:
        bcfg = cfg
    return {"bot": bot, "type": bot.type, "cfg": cfg, "bcfg": bcfg, "bd": bd, "pair": pair}


def run_scenario(opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run a bot config over a price path. PURE: returns fills + equity curve + the
    score inputs. ``opts.guard`` (spies) is accepted but NEVER called — Arena has no
    gate/broadcast path, so any such spy stays at zero (asserted by tests)."""
    opts = opts or {}
    prices = opts.get("prices")
    if not prices and opts.get("vectors") and opts.get("scenario"):
        prices = price_path(opts["vectors"], opts["scenario"])
    if not isinstance(prices, list) or not prices:
        raise ValueError("arena.run_scenario: need a price path (prices[] or vectors+scenario)")

    r = _resolve_bot(opts.get("bot") if opts.get("bot") is not None else opts)
    type_, cfg, bcfg, bd = r["type"], r["cfg"], r["bcfg"], r["bd"]

    mid_uc = _bots.micro_usd(prices[0])
    deal_seq = 0
    deal_seq += 1
    current = _new_deal(type_, "arena:" + type_ + ":" + str(deal_seq), cfg, mid_uc, bd, 0)
    closed_deals: List[Dict[str, Any]] = []
    fills: List[Dict[str, Any]] = []
    equity_curve_uc: List[int] = []

    realized_closed_uc = 0  # sum of realized from CLOSED deals
    max_cost_basis_uc = 0   # peak cost deployed (held-inventory basis)
    peak_equity_uc: Optional[int] = None  # running peak of the equity curve
    max_drawdown_uc = 0     # largest peak-to-trough drop of equity
    last_equity_uc = 0

    # DCA/smarttrade reopen a fresh deal after a close (grid is one deal). An
    # optional max_deals caps how many deals a run opens.
    md = opts.get("maxDeals")
    max_deals = (max(1, int(md)) if md is not None and is_finite(md) else None)  # None = unbounded
    reopen = (type_ == "dca" or type_ == "smarttrade")  # grid is one deal

    for ti in range(len(prices)):
        mark_uc = _bots.micro_usd(prices[ti])
        now = ti + 1  # synthetic monotonic sim clock (NOT wall time)

        if not current and reopen and (max_deals is None or deal_seq < max_deals):
            deal_seq += 1
            current = _new_deal(type_, "arena:" + type_ + ":" + str(deal_seq), cfg, mid_uc, bd, now)

        if current and type_ == "dca":
            _bots.dca_observe(current, mark_uc)

        guard_i = 0
        while current and guard_i < 512:
            guard_i += 1
            order = _engine_step(type_, current, bcfg, cfg, mark_uc)
            if not order:
                break
            if order.get("action") == "arm":
                order["_markUc"] = mark_uc
                _engine_apply(type_, current, bcfg, cfg, order, None, now)
                continue
            fill = _paper_fill(order, mark_uc, bd)
            if not fill.get("qty") or fill["qty"] <= 0:
                break  # rounds to zero — nothing fires
            _engine_apply(type_, current, bcfg, cfg, order, fill, now)
            fills.append({
                "t": ti, "kind": order.get("kind"), "side": order["side"],
                "priceUc": str(fill["priceUc"]), "qty": str(fill["qty"]),
                "costUc": str(fill["costUc"]) if fill.get("costUc") is not None else None,
                "proceedsUc": str(fill["proceedsUc"]) if fill.get("proceedsUc") is not None else None,
                "paper": True,
            })
            # A closed deal is booked IMMEDIATELY (its realized PnL folds into the
            # curve) regardless of reopen/max_deals; a new deal (if allowed) opens
            # on the next tick. This never loses a closed deal's realized profit.
            if current["status"] == "closed":
                closed_deals.append(current)
                realized_closed_uc += (current.get("realizedUc") or 0)
                current = None
                break

        # --- equity curve + score inputs at this tick ------------------------
        agg = _deal_agg(type_, current if (current and current["status"] != "closed") else None, mark_uc, bd)
        open_realized = (current.get("realizedUc") or 0) if (current and current["status"] != "closed") else 0
        unrealized_uc = agg["openMarkUc"] - agg["openCostUc"]
        equity_uc = realized_closed_uc + open_realized + unrealized_uc
        last_equity_uc = equity_uc

        if agg["openCostUc"] > max_cost_basis_uc:
            max_cost_basis_uc = agg["openCostUc"]
        if peak_equity_uc is None or equity_uc > peak_equity_uc:
            peak_equity_uc = equity_uc
        dd = peak_equity_uc - equity_uc
        if dd > max_drawdown_uc:
            max_drawdown_uc = dd

        equity_curve_uc.append(equity_uc)

    final_pnl_uc = last_equity_uc
    sc = score(final_pnl_uc, max_drawdown_uc, max_cost_basis_uc)

    return {
        "type": type_, "pair": r["pair"], "decimals": bd,
        "fills": fills,
        "equityCurveUc": equity_curve_uc,
        "finalPnlUc": final_pnl_uc,
        "maxDrawdownUc": max_drawdown_uc,
        "maxCostBasisUc": max_cost_basis_uc,
        "retTenthPct": _bots.div_round(final_pnl_uc * 1000, max_cost_basis_uc) if max_cost_basis_uc > 0 else 0,
        "ddTenthPct": _bots.div_round(max_drawdown_uc * 1000, max_cost_basis_uc) if max_cost_basis_uc > 0 else 0,
        "scoreTenths": sc["scoreTenths"],
        "score": sc["score"],
        "dealCount": len(closed_deals) + (1 if (current and current["status"] != "closed") else 0),
        "closedDealCount": len(closed_deals),
        "playLabel": PLAY_LABEL,
        "real": False,
        "disclaimer": DISCLAIMER,
    }


runScenario = run_scenario


# =========================================================================== #
# SCORE (§9 pinned formula) — risk-adjusted, drawdown-penalized.              #
#   retPct = finalPnl / maxCostBasis * 100                                    #
#   ddPct  = maxDrawdown / maxCostBasis * 100                                 #
#   score  = round1(retPct - 0.5 * ddPct)                                     #
# All micro-dollar integer math (no float decides money). To avoid double     #
# rounding we fold the formula into ONE half-away-from-zero division to        #
# tenths:                                                                      #
#   scoreTenths = round( (finalPnl*1000 - maxDrawdown*500) / maxCostBasis )   #
# A no-trade run (maxCostBasis = 0) scores 0.                                  #
# =========================================================================== #
def score(final_pnl_uc: Optional[int], max_drawdown_uc: Optional[int],
          max_cost_basis_uc: Optional[int]) -> Dict[str, Any]:
    final_pnl_uc = final_pnl_uc or 0
    max_drawdown_uc = max_drawdown_uc or 0
    max_cost_basis_uc = max_cost_basis_uc or 0
    if max_cost_basis_uc <= 0:
        return {"scoreTenths": 0, "score": 0}
    score_tenths = _bots.div_round(final_pnl_uc * 1000 - max_drawdown_uc * 500, max_cost_basis_uc)
    return {"scoreTenths": score_tenths, "score": score_tenths / 10}


# =========================================================================== #
# XP + LEVELS — advisory UX progression (NOT a safety control; §9/§5).        #
# Levels gently UNLOCK advanced params/bot types. Gating is UX only and never  #
# blocks a safety rail.                                                        #
# =========================================================================== #
LEVELS = [
    {"level": 1, "minXp": 0, "unlocks": ["dca", "simple-create"]},
    {"level": 2, "minXp": 50, "unlocks": ["grid"]},
    {"level": 3, "minXp": 150, "unlocks": ["advanced-params", "safety-ladder"]},
    {"level": 4, "minXp": 350, "unlocks": ["smarttrade", "trailing-tp"]},
    {"level": 5, "minXp": 700, "unlocks": ["martingale", "signal"]},
]


def xp_for_run(result: Optional[Dict[str, Any]]) -> int:
    """XP for one completed run: a flat participation grant + a bonus for a POSITIVE
    risk-adjusted score. Reckless negative runs earn only participation XP."""
    base = 10
    if result and result.get("scoreTenths") is not None:
        tenths = int(result["scoreTenths"])
    else:
        tenths = js_round(((result or {}).get("score") or 0) * 10)
    bonus = js_round(tenths / 10) if tenths > 0 else 0  # +1 XP per whole positive score point
    return base + bonus


xpForRun = xp_for_run


def level_for_xp(xp: Any) -> Dict[str, Any]:
    xp = int(xp) if xp else 0
    cur = LEVELS[0]
    for lv in LEVELS:
        if xp >= lv["minXp"]:
            cur = lv
    nxt = None
    for lv in LEVELS:
        if lv["minXp"] > xp:
            nxt = lv
            break
    unlocks: List[str] = []
    for lv in LEVELS:
        if xp >= lv["minXp"]:
            unlocks = unlocks + lv["unlocks"]
    return {
        "level": cur["level"], "unlocks": unlocks, "xp": xp,
        "nextLevel": nxt["level"] if nxt else None,
        "xpToNext": (nxt["minXp"] - xp) if nxt else 0,
    }


levelForXp = level_for_xp


# =========================================================================== #
# MISSIONS — clear win condition + reward (XP). Deterministic checks off a run #
# result. (More can be added; these cover the §9 examples.)                   #
# =========================================================================== #
def _m_survive_crash_green(res: Dict[str, Any]) -> bool:
    return res.get("scenario") == "crash" and (res.get("finalPnlUc") or 0) > 0


def _m_crab_grid_ten(res: Dict[str, Any]) -> bool:
    return (res.get("scenario") == "crab" and res.get("type") == "grid"
            and (res.get("retTenthPct") or 0) >= 100)


def _m_deep_ladder_survivor(res: Dict[str, Any]) -> bool:
    snap = res.get("configSnapshot") or {}
    return (res.get("scenario") in ("bear", "crash") and res.get("type") == "dca"
            and (snap.get("maxSafetyOrders") or 0) >= 4 and (res.get("finalPnlUc") or 0) >= 0)


def _m_steady_hand(res: Dict[str, Any]) -> bool:
    return (res.get("scoreTenths") or 0) > 0 and (res.get("ddTenthPct") or 0) < 150


MISSIONS = [
    {"id": "survive_crash_green", "name": "Survive the Flash-crash",
     "desc": "Finish the Flash-crash scenario in the green (positive play PnL).",
     "scenario": "crash", "rewardXp": 40, "check": _m_survive_crash_green},
    {"id": "crab_grid_ten", "name": "Range Rider",
     "desc": "Beat +10% with a grid bot in a Crab (ranging) market.",
     "scenario": "crab", "rewardXp": 35, "check": _m_crab_grid_ten},
    {"id": "deep_ladder_survivor", "name": "Deep Ladder",
     "desc": "Build a 4+ safety-order ladder that finishes non-negative through a Bear/Crash drop.",
     "rewardXp": 50, "check": _m_deep_ladder_survivor},
    {"id": "steady_hand", "name": "Steady Hand",
     "desc": "Finish any scenario with a positive score AND a drawdown under 15%.",
     "rewardXp": 25, "check": _m_steady_hand},
]


def mission_by_id(id_: str) -> Optional[Dict[str, Any]]:
    for m in MISSIONS:
        if m["id"] == id_:
            return m
    return None


missionById = mission_by_id


def check_mission(id_: str, res: Dict[str, Any]) -> bool:
    m = mission_by_id(id_)
    return bool(m and m["check"](res))


checkMission = check_mission


def completed_missions(res: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for m in MISSIONS:
        try:
            if m["check"](res):
                out.append(m["id"])
        except Exception:
            pass
    return out


completedMissions = completed_missions


# =========================================================================== #
# BADGES / achievements — milestones over a profile's history.                #
# =========================================================================== #
BADGES = [
    {"id": "first_run", "name": "First Steps", "desc": "Complete your first Arena run.",
     "check": (lambda p: p.runs >= 1)},
    {"id": "green_run", "name": "In the Green", "desc": "Finish a run with positive play PnL.",
     "check": (lambda p: p.green_runs >= 1)},
    {"id": "high_score", "name": "Sharp Shooter", "desc": "Score 10 or higher on any run.",
     "check": (lambda p: p.best_score_tenths >= 100)},
    {"id": "diamond_hands", "name": "Diamond Hands", "desc": "Survive the Flash-crash in the green.",
     "check": (lambda p: bool(p.survived_crash))},
    {"id": "all_scenarios", "name": "Globetrotter", "desc": "Run every scenario at least once.",
     "check": (lambda p: len(p.scenarios_played) >= len(SCENARIOS))},
    {"id": "veteran", "name": "Veteran", "desc": "Complete 25 runs.",
     "check": (lambda p: p.runs >= 25)},
]


# =========================================================================== #
# Leaderboard — LOCAL-FIRST ONLY (personal best + on-device board). NO network #
# NO global board in v1.                                                       #
# =========================================================================== #
class Leaderboard:
    def __init__(self):
        self.entries: Dict[str, List[Dict[str, Any]]] = {}  # scenario -> [entry] sorted desc

    def add(self, entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        s = entry.get("scenario") if entry else None
        if not s:
            return None
        score_tenths = entry.get("scoreTenths")
        if score_tenths is not None:
            st = str(int(score_tenths))
        else:
            st = str(js_round((entry.get("score") or 0) * 10))
        e = {
            "scenario": s, "score": entry.get("score"), "scoreTenths": st,
            "type": entry.get("type"), "name": entry.get("name"),
            "at": entry["at"] if entry.get("at") is not None else int(time.time() * 1000),
        }
        self.entries.setdefault(s, []).append(e)
        self.entries[s].sort(key=lambda x: (-int(x["scoreTenths"]), x["at"]))
        if len(self.entries[s]) > 100:
            self.entries[s] = self.entries[s][:100]
        return e

    def personal_best(self, scenario: str) -> Optional[Dict[str, Any]]:
        a = self.entries.get(scenario)
        return a[0] if a else None

    personalBest = personal_best

    def top(self, scenario: str, n: int = 10) -> List[Dict[str, Any]]:
        a = self.entries.get(scenario) or []
        return a[:(n or 10)]

    def to_json(self) -> Dict[str, Any]:
        return {"local": True, "global": False, "entries": self.entries}

    toJSON = to_json


# =========================================================================== #
# ArenaProfile — ties it together: play balance, XP/level, missions, badges,   #
# local leaderboard, run history. LOCAL-first.                                 #
# =========================================================================== #
class ArenaProfile:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self.play_balance = PlayBalance(opts.get("grantUsd"))
        self.xp = 0
        self.runs = 0
        self.green_runs = 0
        self.best_score_tenths = -1000000000
        self.survived_crash = False
        self.scenarios_played: set = set()
        self.missions_completed: set = set()
        self.badges: set = set()
        self.leaderboard = Leaderboard()
        self.history: List[Dict[str, Any]] = []

    # JS-parity attribute alias
    @property
    def playBalance(self) -> PlayBalance:
        return self.play_balance

    def run(self, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Run a scenario and record it into the profile (XP, missions, badges,
        board). PURE sim; no gate."""
        opts = opts or {}
        res = run_scenario(opts)
        bot = opts.get("bot")
        bot_scenario = bot.get("scenario") if isinstance(bot, dict) else None
        bot_name = bot.get("name") if isinstance(bot, dict) else None
        res["scenario"] = opts.get("scenario") or bot_scenario or None
        res["configSnapshot"] = _snapshot_config(opts)
        res["name"] = opts.get("name") or bot_name or None

        # play balance moves ONLY by play PnL — still PLAY, never real.
        self.play_balance.apply_pnl(res["finalPnlUc"])
        self.runs += 1
        if res["finalPnlUc"] > 0:
            self.green_runs += 1
        if res["scoreTenths"] > self.best_score_tenths:
            self.best_score_tenths = res["scoreTenths"]
        if res["scenario"]:
            self.scenarios_played.add(res["scenario"])
        if res["scenario"] == "crash" and res["finalPnlUc"] > 0:
            self.survived_crash = True

        # XP: run grant + any newly-completed mission rewards.
        gained = xp_for_run(res)
        newly_done: List[str] = []
        for mid in completed_missions(res):
            if mid not in self.missions_completed:
                self.missions_completed.add(mid)
                newly_done.append(mid)
                m = mission_by_id(mid)
                if m:
                    gained += m["rewardXp"]
        self.xp += gained

        # badges
        new_badges: List[str] = []
        for b in BADGES:
            if b["id"] not in self.badges and b["check"](self):
                self.badges.add(b["id"])
                new_badges.append(b["id"])

        # local leaderboard
        if res["scenario"]:
            self.leaderboard.add({"scenario": res["scenario"], "score": res["score"],
                                  "scoreTenths": res["scoreTenths"], "type": res["type"], "name": res["name"]})

        self.history.append({"scenario": res["scenario"], "score": res["score"],
                             "finalPnlUc": str(res["finalPnlUc"]), "at": int(time.time() * 1000)})

        return {
            "result": res,
            "xpGained": gained, "xp": self.xp, "level": level_for_xp(self.xp),
            "missionsCompleted": newly_done, "badgesEarned": new_badges,
            "playBalance": self.play_balance.to_json(),
            "disclaimer": DISCLAIMER,
        }

    def level(self) -> Dict[str, Any]:
        return level_for_xp(self.xp)


def _snapshot_config(opts: Dict[str, Any]) -> Dict[str, Any]:
    bot = opts.get("bot")
    if isinstance(bot, _bots.Bot):
        src = bot.config
    elif isinstance(bot, dict) and bot.get("config"):
        src = bot["config"]
    else:
        src = opts.get("config") or (bot.get("config") if isinstance(bot, dict) else None) or {}
    return dict(src)


# =========================================================================== #
# USE THIS FOR REAL — the ONE honest on-ramp (§9 / §6). Export the Arena config #
# as a Bot TEMPLATE, then import it. Import ALWAYS lands paper + disabled +     #
# testnet with zero allocation — NEVER auto-live. Reuses the existing template  #
# import which structurally enforces that; Arena adds no bypass.               #
# =========================================================================== #
def export_as_template(bot_or_spec: Any) -> Dict[str, Any]:
    if isinstance(bot_or_spec, _bots.Bot):
        bot = bot_or_spec
    else:
        bot = _resolve_bot(bot_or_spec)["bot"]
    return _templates.export_bot(bot)


exportAsTemplate = export_as_template


def use_for_real(bot_or_spec_or_template: Any) -> Any:
    """Import an Arena config into a REAL (but paper + disabled + testnet) bot spec.
    Returns the Bot produced by the existing non-bypassable template import."""
    if isinstance(bot_or_spec_or_template, dict) and bot_or_spec_or_template.get("kind") == "blockle-bot-template":
        template = bot_or_spec_or_template
    else:
        template = export_as_template(bot_or_spec_or_template)
    return _templates.import_template(template)  # ALWAYS paper + disabled + testnet + alloc 0


useForReal = use_for_real
