"""agent/discovery.py — the configurable, READ-ONLY token candidate feed
(``docs/AGENT-STRATEGIES.md`` §7). Python port; numerically identical across the
three wallets.

Discovery finds, filters, scores, and ranks candidate tokens/pairs for the
strategies to consider. It is **read-only**: it NEVER trades, NEVER signs, NEVER
adds a token to the policy allowlist, and NEVER auto-approves. :meth:`scan`
returns ranked :class:`Candidate` dicts with ``approved=False``; a candidate only
becomes ``approved`` by an explicit user action (:meth:`approve`). Any trade on a
discovered token still passes the full dispatch gate (allowlist + caps + confirm),
so an unapproved token simply produces a ``blocked`` audit note — never a trade.

Scoring is a pinned weighted sum so the three ports agree exactly; the canonical
vector (``liquidityUsd=100000, volume24hUsd=50000, ageSec=86400,
source=exchangeListings, 0 flags``) scores **0.98** in every wallet.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member

# Each source's trust contribution Tn in [0,1] (feeds the 0.10·Tn scoring term).
SOURCE_TRUST = {
    "watchlist": 1.0,
    "exchangeListings": 0.8,
    "blockLaunches": 0.7,
    "venuePairs": 0.5,
    "tokenLists": 0.4,
}

# Sources that are "external" (untrusted origin) — subject to requireVerified.
EXTERNAL_SOURCES = {"exchangeListings", "blockLaunches", "venuePairs", "tokenLists"}

DEFAULT_FILTERS = {
    "minLiquidityUsd": 10000,
    "minAgeSec": 3600,          # avoid 0-block honeypots
    "maxAgeSec": None,
    "chains": None,             # None/empty => any chain
    "quoteAssets": ["USDC", "USDT", "BLOCK"],
    "requireVerified": True,    # for external sources
    "allowlist": None,          # symbols or addresses; None/empty => no restriction
    "denylist": None,
    "maxCandidates": 50,
}

# Flags that HARD-DROP a candidate (dropped, not merely penalized).
DEFAULT_REJECT_FLAGS = ["honeypot"]

# Age sweet-spot for the An feature (≈ 1 day), and the soft "new" flag window.
_AGE_SWEET_SPOT_SEC = 86400
_NEW_FLAG_SEC = 86400


def _clamp01(x: float) -> float:
    if x < 0:
        return 0.0
    if x > 1:
        return 1.0
    return float(x)


def _num(v: Any) -> Optional[float]:
    """Coerce to float, or ``None`` when absent/non-numeric (never fabricate)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


def score_candidate(cand: Dict[str, Any]) -> float:
    """The pinned weighted score in [0,1] (see §7).

    ``score = clamp01( 0.40·Ln + 0.30·Vn + 0.20·An + 0.10·Tn − 0.25·flagPenalty )``
    where a MISSING feature contributes 0 (never fabricated) and ``flagPenalty`` is
    the count of flags on the candidate.
    """
    liq = _num(cand.get("liquidityUsd"))
    vol = _num(cand.get("volume24hUsd"))
    age = _num(cand.get("ageSec"))

    ln = min(1.0, liq / 100000.0) if liq is not None else 0.0
    vn = min(1.0, vol / 50000.0) if vol is not None else 0.0
    if age is not None and age > 0:
        an = _clamp01(1.0 - abs(math.log(age / _AGE_SWEET_SPOT_SEC)) / 3.0)
    else:
        an = 0.0
    tn = float(SOURCE_TRUST.get(cand.get("source"), 0.0))
    flag_penalty = len(cand.get("flags") or [])

    return _clamp01(0.40 * ln + 0.30 * vn + 0.20 * an + 0.10 * tn - 0.25 * flag_penalty)


def _norm_key(cand: Dict[str, Any]) -> str:
    """Dedup key: chain + address (lowered) when present, else chain+symbol+pair."""
    chain = str(cand.get("chain") or "").lower()
    addr = cand.get("address")
    if addr:
        return f"{chain}|{str(addr).lower()}"
    return f"{chain}|{str(cand.get('symbol') or '').upper()}|{str(cand.get('pair') or '').upper()}"


def _quote_of(cand: Dict[str, Any]) -> Optional[str]:
    """The quote asset for the candidate, from ``quote`` or a ``BASE/QUOTE`` pair."""
    q = cand.get("quote")
    if q:
        return str(q).upper()
    pair = cand.get("pair")
    if pair and "/" in str(pair):
        parts = str(pair).split("/")
        if len(parts) == 2 and parts[1]:
            return parts[1].upper()
    return None


class Discovery:
    """Per-wallet candidate feed. ``deps = {ctx, config}``.

    ``ctx`` read accessors (each sync OR async, camelCase keys, dict or object):
      ``getBlockLaunches()`` ``getMarkets()`` ``getVenuePairs()``
      ``fetchJson(url)`` (for token lists; read-only, never sends wallet data).
    ``config``:
      ``sources``     : ``{blockLaunches, exchangeListings, venuePairs,
                          tokenLists, watchlist}`` booleans (default all on).
      ``filters``     : see :data:`DEFAULT_FILTERS`.
      ``rejectFlags`` : flags that hard-drop (default ``['honeypot']``).
      ``tokenLists``  : ``[{url, chain?}]`` operator-configured list URLs.
      ``watchlist``   : ``[rawCandidate]`` user-supplied symbols/addresses.
      ``seenMarkets`` : markets already known (exchangeListings surfaces only NEW).
      ``approved``    : approved keys/symbols/addresses (explicit user action).
    """

    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        self.ctx = deps.get("ctx") or {}
        cfg = deps.get("config") or {}
        self.config = cfg

        src = cfg.get("sources") or {}
        self.sources = {name: src.get(name, True) for name in
                        ("blockLaunches", "exchangeListings", "venuePairs",
                         "tokenLists", "watchlist")}

        filters = dict(DEFAULT_FILTERS)
        filters.update(cfg.get("filters") or {})
        self.filters = filters
        self.reject_flags = set(cfg.get("rejectFlags", DEFAULT_REJECT_FLAGS) or [])

        # explicit user approvals (symbols/addresses/keys) — NOT the policy
        # allowlist; approving here never grants a trade on its own.
        self._approved = {str(a).lower() for a in (cfg.get("approved") or [])}

    # ---- approval (explicit user action; never automatic) ------------------
    def approve(self, key: str) -> None:
        """Mark a candidate (by symbol/address/dedup-key) approved. This is the
        ONLY way ``approved`` flips to ``True`` — discovery never does it itself."""
        if key:
            self._approved.add(str(key).lower())

    def is_approved(self, cand: Dict[str, Any]) -> bool:
        keys = {_norm_key(cand).lower()}
        if cand.get("symbol"):
            keys.add(str(cand["symbol"]).lower())
        if cand.get("address"):
            keys.add(str(cand["address"]).lower())
        return bool(keys & self._approved)

    # ---- scan --------------------------------------------------------------
    async def scan(self) -> List[Dict[str, Any]]:
        """Collect -> dedup -> flag -> filter -> score -> rank. READ-ONLY."""
        raw: List[Dict[str, Any]] = []
        if self.sources.get("blockLaunches"):
            raw += await self._from_block_launches()
        if self.sources.get("exchangeListings"):
            raw += await self._from_exchange_listings()
        if self.sources.get("venuePairs"):
            raw += await self._from_venue_pairs()
        if self.sources.get("tokenLists"):
            raw += await self._from_token_lists()
        if self.sources.get("watchlist"):
            raw += self._from_watchlist()

        # dedup — HIGHEST-TRUST wins. The scan() gather order is NOT strictly
        # trust-descending (watchlist 1.0 is collected last; blockLaunches 0.7
        # precedes exchangeListings 0.8), so a plain first-seen dedup would let a
        # low-trust duplicate shadow a higher-trust one. Sort by source trust
        # descending FIRST (stable, so equal-trust ties keep gather order), then
        # keep the first seen per key — now genuinely the highest-trust candidate
        # (a watchlist 1.0 entry beats a blockLaunches 0.7 duplicate).
        ranked = sorted(
            raw, key=lambda c: SOURCE_TRUST.get(c.get("source"), 0.0), reverse=True)
        seen: Dict[str, Dict[str, Any]] = {}
        for cand in ranked:
            key = _norm_key(cand)
            if key not in seen:
                seen[key] = cand

        out: List[Dict[str, Any]] = []
        for cand in seen.values():
            cand["flags"] = self._flags_for(cand)
            if not self._passes_filters(cand):
                continue
            if self.reject_flags & set(cand["flags"]):
                continue
            cand["score"] = score_candidate(cand)
            cand["approved"] = self.is_approved(cand)
            out.append(cand)

        out.sort(key=lambda c: c["score"], reverse=True)
        cap = self.filters.get("maxCandidates")
        if cap is not None:
            out = out[: int(cap)]
        return out

    async def approved_candidates(self) -> List[Dict[str, Any]]:
        """Default consumption: scan() filtered to ``approved === True``."""
        return [c for c in await self.scan() if c.get("approved")]

    # ---- sources -----------------------------------------------------------
    async def _call(self, name: str, *args) -> Any:
        fn = member(self.ctx, name)
        if not callable(fn):
            return None
        try:
            return await maybe_await(fn(*args))
        except Exception:
            return None

    def _mk(self, source: str, r: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize a raw item into a Candidate skeleton (flags/score added later)."""
        return {
            "chain": r.get("chain"),
            "symbol": r.get("symbol"),
            "address": r.get("address"),
            "pair": r.get("pair"),
            "quote": r.get("quote"),
            "venue": r.get("venue"),
            "source": source,
            "liquidityUsd": r.get("liquidityUsd"),
            "volume24hUsd": r.get("volume24hUsd"),
            "ageSec": r.get("ageSec"),
            # raw rug/scam signals (only used to FLAG, never to claim safety)
            "verified": r.get("verified"),
            "liquidityLocked": r.get("liquidityLocked"),
            "mintRenounced": r.get("mintRenounced"),
            "honeypot": r.get("honeypot"),
            "holderTopPct": r.get("holderTopPct"),
            "score": 0.0,
            "flags": [],
            "approved": False,
        }

    async def _from_block_launches(self) -> List[Dict[str, Any]]:
        rows = await self._call("getBlockLaunches") or []
        return [self._mk("blockLaunches", r) for r in rows if isinstance(r, dict)]

    async def _from_exchange_listings(self) -> List[Dict[str, Any]]:
        rows = await self._call("getMarkets") or []
        seen = {str(s).upper() for s in (self.config.get("seenMarkets") or [])}
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            mkey = str(r.get("pair") or r.get("symbol") or r.get("market") or "").upper()
            if mkey and mkey in seen:
                continue  # already known — surface only NEW markets
            item = dict(r)
            if not item.get("pair") and r.get("market"):
                item["pair"] = r.get("market")
            out.append(self._mk("exchangeListings", item))
        return out

    async def _from_venue_pairs(self) -> List[Dict[str, Any]]:
        rows = await self._call("getVenuePairs") or []
        return [self._mk("venuePairs", r) for r in rows if isinstance(r, dict)]

    async def _from_token_lists(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for spec in (self.config.get("tokenLists") or []):
            url = spec.get("url") if isinstance(spec, dict) else spec
            if not url:
                continue
            doc = await self._call("fetchJson", url)
            if not isinstance(doc, dict):
                continue
            default_chain = spec.get("chain") if isinstance(spec, dict) else None
            for t in (doc.get("tokens") or []):
                if not isinstance(t, dict):
                    continue
                out.append(self._mk("tokenLists", {
                    "chain": t.get("chain") or default_chain,
                    "symbol": t.get("symbol"),
                    "address": t.get("address"),
                    "verified": t.get("verified"),
                }))
        return out

    def _from_watchlist(self) -> List[Dict[str, Any]]:
        rows = self.config.get("watchlist") or []
        out = []
        for r in rows:
            if isinstance(r, str):
                r = {"symbol": r}
            if isinstance(r, dict):
                # user-supplied -> trusted as a candidate (verified for filters)
                item = dict(r)
                item.setdefault("verified", True)
                out.append(self._mk("watchlist", item))
        return out

    # ---- flags + filters ---------------------------------------------------
    def _flags_for(self, cand: Dict[str, Any]) -> List[str]:
        """Best-effort rug/scam flags (surface concerns; never fabricate safety)."""
        flags: List[str] = []
        src = cand.get("source")
        external = src in EXTERNAL_SOURCES

        # denylist -> flag (also hard-dropped in _passes_filters)
        if self._in_list(cand, self.filters.get("denylist")):
            flags.append("denylisted")

        # unverified external
        if external and cand.get("verified") is False:
            flags.append("unverified")

        liq = _num(cand.get("liquidityUsd"))
        min_liq = _num(self.filters.get("minLiquidityUsd")) or 0.0
        if liq is not None and liq < 2 * min_liq:
            flags.append("low-liquidity")

        age = _num(cand.get("ageSec"))
        if age is not None and age < _NEW_FLAG_SEC:
            flags.append("new")

        # liquidity-not-locked only when the source EXPOSES it as False
        if cand.get("liquidityLocked") is False:
            flags.append("liquidity-not-locked")

        # mint-authority-not-renounced — Solana only, when exposed as False
        if str(cand.get("chain") or "").lower() == "solana" and cand.get("mintRenounced") is False:
            flags.append("mint-not-renounced")

        if cand.get("honeypot") is True:
            flags.append("honeypot")

        top = _num(cand.get("holderTopPct"))
        if top is not None and top > 50:
            flags.append("holder-concentration")

        return flags

    def _in_list(self, cand: Dict[str, Any], lst: Optional[List[str]]) -> bool:
        if not lst:
            return False
        vals = {str(x).lower() for x in lst}
        sym = str(cand.get("symbol") or "").lower()
        addr = str(cand.get("address") or "").lower()
        return (bool(sym) and sym in vals) or (bool(addr) and addr in vals)

    def _passes_filters(self, cand: Dict[str, Any]) -> bool:
        f = self.filters

        # denylist -> always drop
        if self._in_list(cand, f.get("denylist")):
            return False

        # allowlist (discovery-local, NOT the policy allowlist) -> keep only listed
        allow = f.get("allowlist")
        if allow and not self._in_list(cand, allow):
            return False

        # requireVerified for external sources -> drop unverified external
        if f.get("requireVerified") and "unverified" in cand.get("flags", []):
            return False

        # chains
        chains = f.get("chains")
        if chains and str(cand.get("chain") or "").lower() not in {str(c).lower() for c in chains}:
            return False

        # quote assets (only when a quote is known)
        quotes = f.get("quoteAssets")
        q = _quote_of(cand)
        if quotes and q is not None and q not in {str(x).upper() for x in quotes}:
            return False

        # liquidity floor (only when liquidity is known)
        liq = _num(cand.get("liquidityUsd"))
        min_liq = _num(f.get("minLiquidityUsd"))
        if liq is not None and min_liq is not None and liq < min_liq:
            return False

        # age window (only when age is known)
        age = _num(cand.get("ageSec"))
        min_age = _num(f.get("minAgeSec"))
        if age is not None and min_age is not None and age < min_age:
            return False
        max_age = _num(f.get("maxAgeSec"))
        if age is not None and max_age is not None and age > max_age:
            return False

        return True


def create(deps: Optional[Dict[str, Any]] = None) -> Discovery:
    return Discovery(deps)
