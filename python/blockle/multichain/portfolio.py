"""multichain/portfolio.py — WALLET PORTFOLIO: unified cross-chain NET WORTH
(docs/WALLET-PORTFOLIO.md §1).

Faithful Python port of ``blockle-extension/portfolio.js`` (the JS reference),
asserted against the AUTHORITATIVE shared fixture ``docs/portfolio-vectors.json``.

READ-ONLY. No signing, no money path. ``portfolio(accounts, ctx)`` is PURE given
an injected balance + price ctx: it aggregates the balances the EXISTING chain
adapters already report (BLOCK, every EVM net + custom, BTC/LTC/DOGE, Solana)
and prices them from the SHARED live mark source (exchange book mid/last + the
configured USD price map — the same source the bots use), injected via ctx.

NEVER fabricates a price or a balance: a holding with no resolvable price goes to
``unpriced`` (shown, NOT counted, NOT guessed as 0). All money math is
integer-exact in micro-dollars (uc = round(usd · 1e6), the §8 convention shared
with ``agent/pnl.py``). The clock is injected (``ctx['asOf']``) — this module
never calls the clock in its pure logic.

Also a tiny append-only DAILY snapshot store ({ts, totalUsdMicro}, dedup by UTC
day) that drives the net-worth sparkline (§2.1).
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional

from ._util import is_finite, maybe_await, member

DAY_MS = 86400000

_HEX_RE = re.compile(r"^0x[0-9a-fA-F]+$")
_INT_RE = re.compile(r"^-?\d+$")


# ---- exact integer helpers (mirror agent/pnl.js) --------------------------
def to_big(v: Any) -> int:
    if isinstance(v, bool):
        raise ValueError("not a base-unit integer: " + repr(v))
    if isinstance(v, int):
        return v
    if v is None or v == "":
        return 0
    s = str(v).strip()
    if _HEX_RE.match(s):
        return int(s, 16)
    if not _INT_RE.match(s):
        raise ValueError("not a base-unit integer: " + s)
    return int(s)


def micro_usd(usd: Any) -> Optional[int]:
    """round(usd · 1e6) as an int of micro-dollars. Half-away-from-zero (JS
    ``Math.round``). ``None``/non-finite price stays ``None`` (never 0)."""
    if usd is None or not is_finite(usd):
        return None
    return math.floor(float(usd) * 1e6 + 0.5)


def div_round(num: int, den: int) -> int:
    """round(num / den) for ints, half-away-from-zero. den > 0 required."""
    if den <= 0:
        raise ValueError("div_round: denominator must be > 0")
    if num >= 0:
        return (num + den // 2) // den
    return -(((-num) + den // 2) // den)


def holding_micro(amount_base: Any, decimals: Any, price_usd: Any) -> Optional[int]:
    """micro-dollar value of ``amount_base`` base units of an asset priced at
    ``price_usd`` per WHOLE unit. Exact int math, never a float."""
    pm = micro_usd(price_usd)
    if pm is None:
        return None
    dec = int(decimals) if decimals is not None else 0
    return div_round(to_big(amount_base) * pm, 10 ** dec)


def micro_to_usd(micro: Any) -> float:
    return int(micro) / 1e6


# ---- price lookup against the injected shared mark source -----------------
async def lookup_price(ctx: Optional[Dict[str, Any]], asset: Any) -> Optional[float]:
    """``ctx['priceUsd']`` may be: a callable(asset)->number|None (possibly
    async), or a plain {SYMBOL: price} map. Returns a finite positive number, or
    ``None`` (None => unpriced; a non-positive/NaN price is unknown, never 0)."""
    sym = str((member(asset, "symbol") or "")).upper()
    src = member(ctx, "priceUsd")
    if src is None:
        src = member(ctx, "marks")
    v = None
    if callable(src):
        try:
            v = await maybe_await(src(asset))
        except Exception:  # noqa: BLE001
            v = None
    elif isinstance(src, dict):
        v = src.get(sym) if src.get(sym) is not None else None
    if v is None:
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if (math.isfinite(n) and n > 0) else None


# ---- getBalance shim: adapters return [{asset, confirmed}] ------------------
async def holdings_for(ctx: Optional[Dict[str, Any]], chain: str, address: Any) -> List[Any]:
    fn = member(ctx, "getHoldings") or member(ctx, "getBalance")
    if not callable(fn):
        return []
    try:
        rows = await maybe_await(fn(chain, address))
    except Exception:  # noqa: BLE001
        rows = []
    return rows if isinstance(rows, list) else []


def _cmp_big(a: Any, b: Any) -> int:
    x, y = to_big(a), to_big(b)
    return -1 if x < y else (1 if x > y else 0)


def _cmp_str(a: Any, b: Any) -> int:
    a = str(a if a is not None else "")
    b = str(b if b is not None else "")
    return -1 if a < b else (1 if a > b else 0)


# ===========================================================================
# portfolio(accounts, ctx) -> Portfolio
#   accounts: [{ chain, address }]   (one per configured chain + account)
# ===========================================================================
async def portfolio(accounts: Optional[List[Any]] = None,
                    ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    ctx = ctx or {}
    accounts = accounts if isinstance(accounts, list) else []

    holdings: List[Dict[str, Any]] = []
    unpriced: List[Dict[str, Any]] = []
    by_chain_micro: Dict[str, int] = {}
    total_micro = 0

    for acc in accounts:
        chain = member(acc, "chain")
        address = member(acc, "address")
        if not chain:
            continue
        rows = await holdings_for(ctx, chain, address)
        for row in rows:
            asset = member(row, "asset") or {}
            raw = member(row, "confirmed")
            if raw is None:
                raw = member(row, "balance")
            amount_base = str(raw if raw is not None else "0")
            try:
                amt = to_big(amount_base)
            except Exception:  # noqa: BLE001
                continue
            if amt <= 0:
                continue  # omit dust/zero — contributes nothing
            decimals = int(member(asset, "decimals")) if member(asset, "decimals") is not None else 0
            symbol = member(asset, "symbol") or "?"
            price = await lookup_price(ctx, asset)
            if price is None:
                unpriced.append({"chain": chain, "symbol": symbol,
                                 "amountBase": str(amt), "decimals": decimals, "asset": asset})
                holdings.append({"chain": chain, "asset": asset, "symbol": symbol,
                                 "amountBase": str(amt), "decimals": decimals,
                                 "priceUsd": None, "usdMicro": None, "usd": None,
                                 "pricedOk": False})
                continue
            micro = holding_micro(amt, decimals, price)
            total_micro += micro
            by_chain_micro[chain] = by_chain_micro.get(chain, 0) + micro
            holdings.append({"chain": chain, "asset": asset, "symbol": symbol,
                             "amountBase": str(amt), "decimals": decimals,
                             "priceUsd": price, "usdMicro": str(micro),
                             "usd": micro_to_usd(micro), "pricedOk": True})

    # byChain with int-exact pct (basis points) using LARGEST-REMAINDER
    # apportionment so the bps ALWAYS sum to exactly 10000 (independent rounding can
    # drift to 9999/10001). floor(micro*10000/total) each; the leftover bps go to the
    # largest remainders, tie-broken by chain asc for determinism.
    parts: List[Dict[str, Any]] = []
    for chain, micro in by_chain_micro.items():
        if total_micro > 0:
            scaled = micro * 10000
            parts.append({"chain": chain, "micro": micro,
                          "bps": scaled // total_micro, "rem": scaled % total_micro})
        else:
            parts.append({"chain": chain, "micro": micro, "bps": 0, "rem": 0})
    if total_micro > 0 and parts:
        assigned = sum(p["bps"] for p in parts)
        leftover = 10000 - assigned  # in [0, nChains)
        order = sorted(parts, key=lambda p: (-p["rem"], str(p["chain"])))
        i = 0
        while leftover > 0 and i < len(order):
            order[i]["bps"] += 1
            leftover -= 1
            i += 1
    by_chain: List[Dict[str, Any]] = []
    for p in parts:
        pct_bps = int(p["bps"])
        micro = p["micro"]
        by_chain.append({"chain": p["chain"], "usdMicro": str(micro), "usd": micro_to_usd(micro),
                         "pctBps": pct_bps, "pct": pct_bps / 100})

    # deterministic ordering (mirror the JS comparators exactly).
    by_chain.sort(key=_cmp_to_key(
        lambda a, b: _cmp_big(b["usdMicro"], a["usdMicro"]) or _cmp_str(a["chain"], b["chain"])))

    def _holdings_cmp(a, b):
        av = 1 if a["pricedOk"] else 0
        bv = 1 if b["pricedOk"] else 0
        if av != bv:
            return bv - av  # priced first
        by_val = _cmp_big(b["usdMicro"] or "0", a["usdMicro"] or "0")
        if by_val:
            return by_val
        return _cmp_str(a["chain"], b["chain"]) or _cmp_str(a["symbol"], b["symbol"])

    holdings.sort(key=_cmp_to_key(_holdings_cmp))
    unpriced.sort(key=_cmp_to_key(
        lambda a, b: _cmp_str(a["chain"], b["chain"]) or _cmp_str(a["symbol"], b["symbol"])))

    return {
        "totalUsdMicro": str(total_micro),
        "totalUsd": micro_to_usd(total_micro),
        "byChain": by_chain,
        "holdings": holdings,
        "unpriced": unpriced,
        "asOf": member(ctx, "asOf") if member(ctx, "asOf") is not None else None,
    }


def _cmp_to_key(cmp):
    class _K:
        __slots__ = ("obj",)

        def __init__(self, obj):
            self.obj = obj

        def __lt__(self, other):
            return cmp(self.obj, other.obj) < 0

    return _K


# ===========================================================================
# §2.1 DAILY SNAPSHOT STORE — append-only, dedup by UTC day. Pure: the caller
# injects ``ts`` (never a clock call here). An entry carries the net-worth total
# in micro-dollars (int-exact string) so the sparkline is lossless.
# ===========================================================================
def day_of(ts: Any) -> int:
    return math.floor(float(ts) / DAY_MS)


def record_snapshot(history: Optional[List[Dict[str, Any]]],
                    entry: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Append {ts, totalUsdMicro} to ``history`` (oldest->newest). Dedup by day:
    a second write for a day REPLACES that day's point (latest total wins).
    Returns a NEW sorted list; never mutates the input."""
    lst = list(history) if isinstance(history, list) else []
    ts_raw = member(entry, "ts")
    try:
        ts = float(ts_raw)
    except (TypeError, ValueError):
        ts = math.nan
    if not math.isfinite(ts):
        raise ValueError("record_snapshot: ts (ms) is required")
    ts = int(ts) if float(ts).is_integer() else ts
    tum = member(entry, "totalUsdMicro")
    if tum is None:
        tum = member(entry, "totalUsd")
    total_usd_micro = str(tum if tum is not None else "0")
    day = day_of(ts)
    point = {"ts": ts, "day": day, "totalUsdMicro": total_usd_micro}
    idx = next((i for i, p in enumerate(lst) if p.get("day") == day), -1)
    if idx >= 0:
        lst[idx] = point
    else:
        lst.append(point)
    lst.sort(key=lambda p: p["ts"])
    return lst


def sparkline(history: Optional[List[Dict[str, Any]]], n: Any = None) -> List[Dict[str, Any]]:
    """The last ``n`` points (default 30) as {ts, totalUsdMicro, usd}."""
    lst = history if isinstance(history, list) else []
    take = int(n) if n is not None else 30
    tail = lst[max(0, len(lst) - take):]
    return [{"ts": p["ts"], "totalUsdMicro": str(p["totalUsdMicro"]),
             "usd": micro_to_usd(to_big(p["totalUsdMicro"]))} for p in tail]
