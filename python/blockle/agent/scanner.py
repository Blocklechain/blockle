"""agent/scanner.py — the SCAN-&-TRADE (Autopilot) evaluator. See docs/AGENT-SCAN.md
and the shared fixture docs/scan-vectors.json. The three wallets (JS reference,
Dart, Python here) MUST behave IDENTICALLY: same scoring formula, same ranking,
same worthy/skip decisions, same emitted Intents — checked against that fixture.

Faithful Python port of ``blockle-extension/agent/scanner.js``.

SAFETY MODEL (non-negotiable): the scanner is a PLANNER, never an executor. It
NEVER signs/broadcasts/touches keys. Per tick it (1) SCANS a candidate universe,
(2) EVALUATES each for cost-positive profit using the EXISTING strategy signals
(arbitrage net edge, momentum crossover, grid spread) net of ALL costs (both
venue fees + two 0.05% agent legs + slippage + gas), (3) SCORES + RANKS, (4)
returns the worthy strategy Intents for the BotRunner to dispatch through the
ONE value-moving gate (caps/allocation/confirm/allowlist/kill/audit/fee/mainnet
+ the security pre-sign). It NEVER fabricates a price/edge and NEVER emits a
sub-threshold or net-negative Intent.

---- PINNED SCORING FORMULA (identical across all three wallets) -------------
For a candidate c with market data (venues[], history[], book, prices, liquidity,
flags), for EACH enabled strategy compute an expected edge in bps, net of costs:

  arbitrage: buyV=min ask, sellV=max bid (distinct venues);
    grossBps = (sellV.bid - buyV.ask)/buyV.ask * 1e4
    baseUnits = usdToBase(perTradeUsd/quoteUsd, baseDec, buyV.ask), clamped to depth
    execUsd   = baseUnits * buyV.ask * quoteUsd           (the ACTUAL notional)
    gasBps    = gasBufferUsd/execUsd * 1e4
    costsBps  = buyV.feeBps + sellV.feeBps + 2*agentFeeBps + slippageBps + gasBps
    edge      = grossBps - costsBps            (exactly strategies.arbitrage's net)
  momentum: on a GOLDEN cross only (SMA short crosses above SMA long):
    strengthBps = (currShort - currLong)/currLong * 1e4
    edge        = strengthBps - (agentFeeBps + slippageBps)      (single buy leg)
  grid: on a positive spread:
    spreadBps = (bestAsk - bestBid)/mid * 1e4
    edge      = spreadBps - (2*agentFeeBps + slippageBps)        (round-trip)

  rawEdgeBps = max over enabled strategies of their edge (the winning strategy).
  A candidate with no signal / no distinct-venue edge contributes no result.

  RISK ADJUSTMENT (penalize thinness / volatility / flags), each in [0,1]:
    Lf = liquidityUsd==None ? 1 : min(1, liquidityUsd/liquidityNorm)
    Vf = 1 / (1 + volPenaltyK * coeffVar(history))     (coeffVar = stdev/mean)
    Ff = max(0, 1 - flagPenalty * nSoftFlags)
  score = round6( max(0, rawEdgeBps) * Lf * Vf * Ff )      # bps, rounded to 1e-6

  WORTHY  iff  rawEdgeBps > 0  AND  score >= minProfitBps.
  Ranked by score desc, stable tiebreak by pair asc. The top maxConcurrentPairs
  whose intents' total cost fits the remaining allocation are TRADED; the rest are
  SKIPPED with a pinned reason (no-signal / net-negative / below-threshold /
  flagged / max-concurrent / allocation).
"""

from __future__ import annotations

import math
from decimal import ROUND_DOWN, Decimal
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member
from . import strategies as _strategies

STABLE_USD = {"USDC": 1, "USDT": 1, "DAI": 1, "USD": 1, "USDBC": 1, "PYUSD": 1}

# Pinned defaults — the fixture depends on these EXACT values (mirror scanner.js).
DEFAULTS: Dict[str, Any] = {
    "minProfitBps": 30,
    "maxConcurrentPairs": 3,
    "perTradeUsd": 20,
    "allocationUsd": 0,
    "strategies": ["arbitrage", "momentum", "grid"],
    # cost model (mirrors strategies.arbitrage defaults + floors)
    "gasBufferUsd": 2,
    "slippageBps": 10,
    "agentFeeBps": 5,
    # momentum + grid sizing
    "momentumShortN": 10,
    "momentumLongN": 30,
    "gridLevels": 2,
    "gridStepBps": 50,
    # risk-adjustment normalizers (pinned)
    "liquidityNorm": 100000,
    "volPenaltyK": 2.0,
    "flagPenalty": 0.25,
    # hard-drop flags (never scored, never traded)
    "rejectFlags": ["honeypot", "scam", "rug", "denylist"],
    "maxCandidates": 50,
}

DEFAULT_DECIMALS = _strategies.DEFAULT_DECIMALS


def _num(v: Any, dflt: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return float(dflt)
    return n if math.isfinite(n) else float(dflt)


def _round6(x: float) -> float:
    # JS: Math.round(x * 1e6) / 1e6 — half rounds toward +inf.
    return math.floor(x * 1e6 + 0.5) / 1e6


def _lc(x: Any) -> str:
    return "" if x is None else str(x).lower()


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def _trunc(x: float) -> int:
    return math.trunc(x)


def split_pair(pair: Any):
    parts = str(pair).split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("pair must look like BASE/QUOTE, got: " + str(pair))
    return parts[0], parts[1]


def decimals_for(sym: Any) -> int:
    d = DEFAULT_DECIMALS.get(str(sym).upper())
    return d if d is not None else 8


def usd_to_base(usd: Any, decimals: int, unit_usd: Any) -> int:
    """Floor(usd / unit_usd * 10**decimals), exact. 0 on a non-positive price/usd."""
    try:
        u = Decimal(str(usd))
        p = Decimal(str(unit_usd))
    except Exception:
        return 0
    if not (p > 0) or not (u > 0):
        return 0
    units = (u / p) * (Decimal(10) ** int(decimals))
    q = int(units.to_integral_value(rounding=ROUND_DOWN))
    return q if q > 0 else 0


def coeff_var(history: Any) -> float:
    """Coefficient of variation (population stdev / mean). 0 on too little data or
    a non-positive mean (never fabricated)."""
    h = [float(x) for x in (history or []) if _is_finite(x)]
    if len(h) < 2:
        return 0.0
    mean = sum(h) / len(h)
    if not (mean > 0):
        return 0.0
    v = sum((x - mean) * (x - mean) for x in h) / len(h)
    return math.sqrt(v) / mean


def _is_finite(x: Any) -> bool:
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False


def validate_config(params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    p = dict(DEFAULTS)
    p.update(params or {})
    p["minProfitBps"] = max(0, _trunc(_num(p.get("minProfitBps"), 30)))
    p["maxConcurrentPairs"] = max(1, _trunc(_num(p.get("maxConcurrentPairs"), 3)))
    p["perTradeUsd"] = max(0.0, _num(p.get("perTradeUsd"), 20))
    p["allocationUsd"] = max(0.0, _num(p.get("allocationUsd"), 0))
    p["gasBufferUsd"] = max(0.0, _num(p.get("gasBufferUsd"), 2))
    # Floors mirror strategies.arbitrage: slippage >= 5, agent fee >= 5 — a caller
    # can never price a loss-maker as a winner by configuring them below reality.
    p["slippageBps"] = max(5, _trunc(_num(p.get("slippageBps"), 10)))
    p["agentFeeBps"] = max(5, _trunc(_num(p.get("agentFeeBps"), 5)))
    p["momentumShortN"] = max(1, _trunc(_num(p.get("momentumShortN"), 10)))
    p["momentumLongN"] = max(2, _trunc(_num(p.get("momentumLongN"), 30)))
    if p["momentumShortN"] >= p["momentumLongN"]:
        p["momentumShortN"] = max(1, p["momentumLongN"] - 1)
    p["gridLevels"] = max(2, _trunc(_num(p.get("gridLevels"), 2)))
    p["gridStepBps"] = max(1, _trunc(_num(p.get("gridStepBps"), 50)))
    p["liquidityNorm"] = max(1.0, _num(p.get("liquidityNorm"), 100000))
    p["volPenaltyK"] = max(0.0, _num(p.get("volPenaltyK"), 2.0))
    p["flagPenalty"] = max(0.0, _num(p.get("flagPenalty"), 0.25))
    strats = p.get("strategies")
    p["strategies"] = [_lc(s) for s in strats] if isinstance(strats, (list, tuple)) and len(strats) \
        else list(DEFAULTS["strategies"])
    rf = p.get("rejectFlags")
    p["rejectFlags"] = [_lc(f) for f in rf] if isinstance(rf, (list, tuple)) else list(DEFAULTS["rejectFlags"])
    p["maxCandidates"] = max(1, _trunc(_num(p.get("maxCandidates"), 50)))
    return p


# ---- per-strategy expected edge (bps), net of ALL costs. Returns None when the
# strategy produces no real signal/edge (never fabricates one). -----------------

def arb_edge(c: Any, cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    venues = []
    for v in (member(c, "venues") or []):
        ask = _num(member(v, "ask"), float("nan"))
        bid = _num(member(v, "bid"), float("nan"))
        vid = member(v, "id")
        depth = member(v, "depthBase")
        venues.append({
            "id": vid, "ask": ask, "bid": bid, "feeBps": _num(member(v, "feeBps"), 0),
            "mainnet": bool(member(v, "mainnet") is True or member(v, "network") == "mainnet"),
            "depthBase": int(str(depth)) if depth is not None else None,
        })
    venues = [v for v in venues if v["id"] and v["ask"] > 0 and v["bid"] > 0]
    if len(venues) < 2:
        return None
    try:
        base, quote = split_pair(member(c, "pair"))
    except Exception:
        return None
    prices = member(c, "prices") or {}
    qp = member(prices, quote)
    quote_usd = _num(qp, float("nan")) if qp is not None else (
        STABLE_USD[quote] if quote in STABLE_USD else float("nan"))
    if not (quote_usd > 0):
        return None
    bd = decimals_for(base)
    buy_v = min(venues, key=lambda v: v["ask"])   # lowest ask
    sell_v = max(venues, key=lambda v: v["bid"])  # highest bid
    if buy_v["id"] == sell_v["id"]:
        return None
    gross_bps = ((sell_v["bid"] - buy_v["ask"]) / buy_v["ask"]) * 10000
    # size exactly like strategies.arbitrage (depth-clamped), then price costs on
    # the ACTUAL executed notional so gas bps are honest for a shallow book.
    base_units = usd_to_base(cfg["perTradeUsd"] / quote_usd, bd, buy_v["ask"])
    if buy_v["depthBase"] is not None and buy_v["depthBase"] < base_units:
        base_units = buy_v["depthBase"]
    if sell_v["depthBase"] is not None and sell_v["depthBase"] < base_units:
        base_units = sell_v["depthBase"]
    if base_units <= 0:
        return None
    exec_usd = (float(base_units) / math.pow(10, bd)) * buy_v["ask"] * quote_usd
    if not (exec_usd > 0):
        return None
    gas_bps = (cfg["gasBufferUsd"] / exec_usd) * 10000
    costs_bps = buy_v["feeBps"] + sell_v["feeBps"] + (2 * cfg["agentFeeBps"]) + cfg["slippageBps"] + gas_bps
    return {
        "strategy": "arbitrage", "edgeBps": gross_bps - costs_bps,
        "grossBps": gross_bps, "costsBps": costs_bps, "execUsd": exec_usd,
        "buyVenue": buy_v["id"], "sellVenue": sell_v["id"],
        "mainnet": buy_v["mainnet"] or sell_v["mainnet"],
    }


def momentum_edge(c: Any, cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    h = [float(x) for x in (member(c, "history") or []) if _is_finite(x)]
    long_n, short_n = cfg["momentumLongN"], cfg["momentumShortN"]
    if len(h) < long_n:
        return None
    n = len(h)

    def sma(end: int, win: int) -> float:
        s = 0.0
        for i in range(end - win + 1, end + 1):
            s += h[i]
        return s / win

    prev_short, curr_short = sma(n - 2, short_n), sma(n - 1, short_n)
    prev_long, curr_long = sma(n - 2, long_n), sma(n - 1, long_n)
    golden = prev_short <= prev_long and curr_short > curr_long  # entry signal only
    if not golden or not (curr_long > 0):
        return None
    strength_bps = ((curr_short - curr_long) / curr_long) * 10000
    costs_bps = cfg["agentFeeBps"] + cfg["slippageBps"]  # single buy leg
    return {"strategy": "momentum", "edgeBps": strength_bps - costs_bps,
            "strengthBps": strength_bps, "costsBps": costs_bps}


def grid_edge(c: Any, cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    book = member(c, "book")
    best_bid = float("nan")
    best_ask = float("nan")
    if book:
        bids = member(book, "bids") or []
        asks = member(book, "asks") or []
        bb = bids[0] if bids else None
        ba = asks[0] if asks else None
        if bb is not None:
            best_bid = _num(member(bb, "price") if member(bb, "price") is not None else
                            (bb[0] if isinstance(bb, (list, tuple)) else None), float("nan"))
        if ba is not None:
            best_ask = _num(member(ba, "price") if member(ba, "price") is not None else
                            (ba[0] if isinstance(ba, (list, tuple)) else None), float("nan"))
    if not (best_bid > 0) or not (best_ask > 0) or best_ask <= best_bid:
        return None
    mid = (best_bid + best_ask) / 2
    spread_bps = ((best_ask - best_bid) / mid) * 10000
    costs_bps = (2 * cfg["agentFeeBps"]) + cfg["slippageBps"]  # round-trip capture
    return {"strategy": "grid", "edgeBps": spread_bps - costs_bps,
            "spreadBps": spread_bps, "costsBps": costs_bps}


def evaluate(c: Any, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Evaluate ONE candidate: best net edge, risk-adjusted score, reason. PURE."""
    flags = [_lc(f) for f in (member(c, "flags") or [])]
    reject = set(cfg["rejectFlags"])
    if any(f in reject for f in flags):
        return {"pair": member(c, "pair"), "chain": member(c, "chain"), "strategy": None,
                "edgeBps": 0, "score": 0, "reason": "flagged", "flags": flags, "eval": None}

    evals: List[Dict[str, Any]] = []
    if "arbitrage" in cfg["strategies"]:
        e = arb_edge(c, cfg)
        if e:
            evals.append(e)
    if "momentum" in cfg["strategies"]:
        e = momentum_edge(c, cfg)
        if e:
            evals.append(e)
    if "grid" in cfg["strategies"]:
        e = grid_edge(c, cfg)
        if e:
            evals.append(e)

    if not evals:
        return {"pair": member(c, "pair"), "chain": member(c, "chain"), "strategy": None,
                "edgeBps": 0, "score": 0, "reason": "no-signal", "flags": flags, "eval": None}

    # winning strategy = highest net edge (stable: first-listed wins a tie)
    best = evals[0]
    for e in evals:
        if e["edgeBps"] > best["edgeBps"]:
            best = e

    liq = member(c, "liquidityUsd")
    lf = 1.0 if liq is None else _clamp01(float(liq) / cfg["liquidityNorm"])
    vf = 1.0 / (1.0 + cfg["volPenaltyK"] * coeff_var(member(c, "history")))
    n_soft = len(flags)  # soft flags (hard rejects already returned above)
    ff = max(0.0, 1.0 - cfg["flagPenalty"] * n_soft)
    raw_edge = best["edgeBps"]
    score = _round6(max(0.0, raw_edge) * lf * vf * ff)

    if raw_edge <= 0:
        reason = "net-negative"
    elif score < cfg["minProfitBps"]:
        reason = "below-threshold"
    else:
        reason = "worthy"

    return {
        "pair": member(c, "pair"), "chain": member(c, "chain"), "strategy": best["strategy"],
        "edgeBps": _round6(raw_edge), "score": score, "reason": reason, "flags": flags,
        "factors": {"Lf": _round6(lf), "Vf": _round6(vf), "Ff": _round6(ff)},
        "eval": best, "candidate": c,
    }


def _registry(S: Any):
    mod = S or _strategies
    reg_fn = member(mod, "default_registry")
    if callable(reg_fn):
        return reg_fn()
    return _strategies.default_registry()


async def emit_intents(row: Dict[str, Any], cfg: Dict[str, Any], S: Any, mainnet: bool) -> List[Dict[str, Any]]:
    """Build a per-candidate READ-ONLY ctx + params and call the EXISTING strategy
    planner so the emitted Intents match the shared strategy conventions exactly."""
    c = row["candidate"]
    reg = _registry(S)
    net = "mainnet" if mainnet else "testnet"
    prices = member(c, "prices") or {}

    if row["strategy"] == "arbitrage":
        strat = reg.get("arbitrage")
        ctx = {
            "network": (lambda: net),
            "prices": (lambda syms, _p=prices: dict(_p)),
            "policyRemaining": (lambda: {"sessionUsd": cfg["perTradeUsd"]}),
            "listVenues": (lambda pair, _v=(member(c, "venues") or []): list(_v)),
        }
        params = strat.validate_params({
            "pair": member(c, "pair"), "venues": member(c, "venues"), "minEdgeBps": 0,
            "maxNotionalUsd": cfg["perTradeUsd"], "gasBufferUsd": cfg["gasBufferUsd"],
            "slippageBps": cfg["slippageBps"], "agentFeeBps": cfg["agentFeeBps"],
        })
        return (await maybe_await(strat.plan(ctx, params))) or []

    if row["strategy"] == "momentum":
        strat = reg.get("momentum")
        ctx = {"network": (lambda: net), "prices": (lambda syms, _p=prices: dict(_p))}
        params = strat.validate_params({
            "market": member(c, "pair"), "shortN": cfg["momentumShortN"],
            "longN": cfg["momentumLongN"], "tradeUsd": cfg["perTradeUsd"],
            "history": member(c, "history") or [],
        })
        intents = (await maybe_await(strat.plan(ctx, params))) or []
        # Normalize to the shared scan contract: the scanner's momentum leg routes
        # through the native `blockle` venue and carries the full `momentum:` tag
        # (the JS reference strategy emits this shape directly).
        out = []
        for it in intents:
            it = dict(it)
            args = dict(it.get("args") or {})
            args.setdefault("venue", "blockle")
            it["args"] = args
            tag = it.get("tag") or ""
            if tag.startswith("mom:"):
                it["tag"] = "momentum:" + tag[len("mom:"):]
            out.append(it)
        return out

    if row["strategy"] == "grid":
        strat = reg.get("grid")
        ctx = {
            "network": (lambda: net),
            "prices": (lambda syms, _p=prices: dict(_p)),
            "getBook": (lambda market, _b=member(c, "book"): _b),
            "openOrders": (lambda market=None: []),
        }
        params = strat.validate_params({
            "market": member(c, "pair"), "levels": cfg["gridLevels"], "stepBps": cfg["gridStepBps"],
            "sizeUsdPerLevel": cfg["perTradeUsd"],
        })
        return (await maybe_await(strat.plan(ctx, params))) or []

    return []


def _trim(row: Dict[str, Any], reason: str) -> Dict[str, Any]:
    return {
        "pair": row["pair"], "chain": row.get("chain"), "strategy": row.get("strategy"),
        "edgeBps": row["edgeBps"], "score": row["score"], "reason": reason,
        "flags": row.get("flags"), "factors": row.get("factors"), "traded": False,
    }


async def scan_and_score(universe: Any, config: Optional[Dict[str, Any]] = None,
                         opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The full per-tick pipeline over a candidate snapshot. Returns the ranked
    evaluation of every candidate, the chosen worthy set WITH its emitted Intents,
    and the flat Intent list the BotRunner dispatches. DETERMINISTIC."""
    cfg = validate_config(config)
    opts = opts or {}
    S = opts.get("Strategies")

    # dedupe the universe by (chain, address|mint|pair) — first-seen wins; cap it.
    seen: Dict[str, Any] = {}
    for c in (universe or []):
        if not c or not member(c, "pair"):
            continue
        key = _lc(member(c, "chain")) + ":" + _lc(member(c, "address") or member(c, "mint") or member(c, "pair"))
        if key not in seen:
            seen[key] = c
    candidates = list(seen.values())[: cfg["maxCandidates"]]

    rows = [evaluate(c, cfg) for c in candidates]
    # rank by score desc, stable tiebreak by pair asc
    rows.sort(key=lambda r: (-r["score"], _lc(r["pair"])))

    allocation_usd = float(opts["allocationUsd"]) if opts.get("allocationUsd") is not None else cfg["allocationUsd"]
    committed_usd = float(opts["committedUsd"]) if opts.get("committedUsd") is not None else 0.0
    has_cap = allocation_usd > 0
    remaining_usd = max(0.0, allocation_usd - committed_usd) if has_cap else float("inf")
    mainnet = bool(opts.get("mainnet"))

    decisions: List[Dict[str, Any]] = []
    all_intents: List[Dict[str, Any]] = []
    picked = 0

    for row in rows:
        if row["reason"] != "worthy":
            decisions.append(_trim(row, row["reason"]))
            continue
        if picked >= cfg["maxConcurrentPairs"]:
            decisions.append(_trim(row, "max-concurrent"))
            continue
        row_mainnet = mainnet or bool(row.get("eval") and row["eval"].get("mainnet"))
        intents = await emit_intents(row, cfg, S, row_mainnet)
        if not intents:
            decisions.append(_trim(row, "no-intent"))
            continue
        # cost = sum of every leg's estUsd + the mandatory 0.05% agent fee (the SAME
        # bound the allocation ledger accrues at dispatch).
        cost_usd = 0.0
        for it in intents:
            est = _num(it.get("estUsd"), 0)
            cost_usd += est + est * (cfg["agentFeeBps"] / 10000)
        if has_cap and cost_usd > remaining_usd + 1e-9:
            decisions.append(_trim(row, "allocation"))
            continue
        remaining_usd -= cost_usd
        picked += 1
        tagged = []
        for it in intents:
            t = dict(it)
            t["scannerPair"] = row["pair"]
            t["scannerScore"] = row["score"]
            t["scannerStrategy"] = row["strategy"]
            tagged.append(t)
            all_intents.append(t)
        d = _trim(row, "worthy")
        d["traded"] = True
        d["intents"] = tagged
        d["costUsd"] = _round6(cost_usd)
        decisions.append(d)

    return {
        "candidates": decisions,
        "worthy": [d for d in decisions if d.get("traded")],
        "skipped": [{"pair": d["pair"], "reason": d["reason"], "score": d["score"], "edgeBps": d["edgeBps"]}
                    for d in decisions if not d.get("traded")],
        "intents": all_intents,
        "allocationUsd": allocation_usd if has_cap else None,
        "committedUsd": committed_usd,
        "remainingUsd": (max(0.0, _round6(remaining_usd)) if has_cap else None),
        "minProfitBps": cfg["minProfitBps"],
        "maxConcurrentPairs": cfg["maxConcurrentPairs"],
    }


# JS-parity aliases
scanAndScore = scan_and_score
validateConfig = validate_config
