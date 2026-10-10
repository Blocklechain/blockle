"""agent/strategies.py — the trading-strategy PLANNERS for the in-wallet agent.

One spec, three implementations (JS / Dart / Python) that must behave
identically; see ``docs/AGENT-STRATEGIES.md``.

A strategy is a PLANNER, never an executor. It NEVER signs, broadcasts, or
touches keys: :meth:`plan` is read-only and returns a list of **Intents**. Every
Intent is later dispatched by :class:`strategy_runner.StrategyRunner` through the
*existing* value-moving pipeline (prepare -> assess_value -> gate_confirm ->
commit -> record_spend), so caps / confirm / allowlist / kill / audit / fee all
still apply and CANNOT be bypassed here.

``ctx`` exposes ONLY read accessors (camelCase keys, dict or object), each sync
OR async (awaited via :func:`maybe_await`)::

    quote(market, side, amount)         getBook(market)        getTrades(market)
    getMarkets()                        getBalance(chain, tokens)
    listVenues(pair)                    venueQuote(venue, pair, probeUsd)
    prices(symbols) -> {sym: usd}       now() -> ms (injected; never Date.now)
    policyRemaining() -> {sessionUsd?}  openOrders(market) | openOrders list
    decimals(symbol) -> int             mainnet -> bool (network the ctx is on)

All amounts are BASE-UNIT decimal strings; money math is exact (``Decimal`` with
explicit ROUND_DOWN floors). Params that are bps are integers. Defaults are the
cross-wallet contract — do not drift them.

Intent shape::

    {tool, args, rationale, estUsd, strategy, tag, mainnet?, group?}

``group`` ties the two legs of an arbitrage together so the StrategyRunner drops
BOTH when either leg's tool is not allowlisted (never a single-leg arb).
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member

# Agent fee: 0.05% == 5 bps per leg (matches the swap tool's on-chain fee).
# This is the real on-chain rate the ``swap`` tool charges; arbitrage edge math
# MUST price exactly ``2 * AGENT_FEE_BPS`` (one leg each way) and callers can only
# make it MORE conservative, never cheaper (see ``validate_params`` / ``plan``).
AGENT_FEE_BPS = 5

# Conservative non-zero slippage floor (bps). A caller may raise it but never
# configure it below this — a 0-slippage arb edge is not realistic and would
# understate cost, so we refuse to price it that optimistically.
MIN_SLIPPAGE_BPS = 10

DEFAULT_DECIMALS = {
    "USD": 2, "USDC": 6, "USDT": 6, "DAI": 18,
    "BLOCK": 8, "BTC": 8, "LTC": 8, "DOGE": 8,
    "ETH": 18, "WETH": 18, "SOL": 9,
}


# --------------------------------------------------------------------------- #
# exact-math helpers                                                          #
# --------------------------------------------------------------------------- #

def _dec(x: Any) -> Decimal:
    return Decimal(str(x))


def _decimals(ctx: Any, symbol: str) -> int:
    fn = member(ctx, "decimals")
    if callable(fn):
        try:
            d = fn(symbol)
            if d is not None:
                return int(d)
        except Exception:
            pass
    return DEFAULT_DECIMALS.get(str(symbol).upper(), 8)


def _usd_to_base(usd: Any, price_usd: Any, decimals: int) -> Optional[int]:
    """Floor(usd / price * 10**decimals) in exact BigInt-scaled math.

    Returns the integer base-unit amount of an asset priced at ``price_usd`` per
    whole token that ``usd`` dollars buys. ``None`` when the price is missing or
    non-positive (caller then emits no Intent — never a synthetic price).

    FIX-4: the result is computed with exact ``Decimal`` scaling (never binary
    float), so an 18-decimal asset loses NO low digits and the integer is bit-for
    -bit identical across the JS / Dart / Python wallets. Callers must hand us the
    original ``Decimal``/string value (not a ``float(...)`` round-trip) to keep
    that guarantee — e.g. ``_usd_to_base(Decimal("123.456789"), 1, 18)`` ->
    ``123456789000000000000`` exactly."""
    if price_usd is None:
        return None
    p = _dec(price_usd)
    if p <= 0:
        return None
    units = (_dec(usd) / p) * (Decimal(10) ** int(decimals))
    return int(units.to_integral_value(rounding=ROUND_DOWN))


def _price_str(d: Decimal) -> str:
    """Canonical limit-price string: 8 dp, no exponent, trailing zeros trimmed."""
    q = d.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    s = format(q, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _split_pair(pair: str):
    parts = str(pair).split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("pair must look like BASE/QUOTE, got: " + str(pair))
    return parts[0], parts[1]


async def _prices(ctx: Any, symbols: List[str]) -> Dict[str, Any]:
    fn = member(ctx, "prices")
    if not callable(fn):
        return {}
    out = await maybe_await(fn(list(symbols)))
    return out or {}


def _is_mainnet(ctx: Any) -> bool:
    """Chain-level mainnet signal for a ctx (FIX-3 backstop).

    True when EITHER the ctx exposes ``network()`` (or a ``network`` value) that
    resolves to ``"mainnet"``, OR the legacy ``mainnet`` flag is truthy. This must
    not depend on a per-venue descriptor or a caller param: a venue-less swap that
    the host auto-routes to a mainnet chain at commit is still gated here."""
    net = member(ctx, "network")
    if callable(net):
        try:
            net = net()
        except Exception:
            net = None
    if net is not None and str(net).lower() == "mainnet":
        return True
    m = member(ctx, "mainnet")
    if callable(m):
        try:
            return bool(m())
        except Exception:
            return False
    return bool(m)


def _venue_mainnet(obj: Any) -> bool:
    """A resolved venue is mainnet if it flags ``mainnet`` OR its network/chain
    descriptor says ``mainnet`` — never trust a single descriptor alone."""
    if bool(member(obj, "mainnet")):
        return True
    for key in ("network", "chain"):
        val = member(obj, key)
        if val is not None and str(val).lower() == "mainnet":
            return True
    return False


def _norm_balances(raw: Any) -> Dict[str, Dict[str, Any]]:
    """Normalize ``getBalance`` output to ``{SYMBOL: {amount:int, decimals:int?}}``.

    Accepts either a dict ``{sym: baseStr}`` or a list of balance records
    ``[{asset:{symbol,decimals,...}, confirmed|amount}]`` (the shared fixture
    shape) — so both wiring styles the hosts use work unchanged."""
    out: Dict[str, Dict[str, Any]] = {}
    if raw is None:
        return out
    if isinstance(raw, dict):
        for sym, v in raw.items():
            try:
                out[sym] = {"amount": int(str(v)), "decimals": None}
            except (TypeError, ValueError):
                continue
        return out
    try:
        items = list(raw)
    except TypeError:
        return out
    for item in items:
        asset = member(item, "asset")
        sym = member(asset, "symbol") if asset is not None else member(item, "symbol")
        if not sym:
            continue
        amt = member(item, "confirmed")
        if amt is None:
            amt = member(item, "amount")
        if amt is None:
            amt = member(item, "balance")
        try:
            amount = int(str(amt)) if amt is not None else 0
        except (TypeError, ValueError):
            amount = 0
        dec = member(asset, "decimals") if asset is not None else member(item, "decimals")
        out[sym] = {"amount": amount, "decimals": int(dec) if dec is not None else None}
    return out


def _bal_decimals(ctx: Any, sym: str, norm: Dict[str, Dict[str, Any]]) -> int:
    rec = norm.get(sym)
    if rec and rec.get("decimals") is not None:
        return int(rec["decimals"])
    return _decimals(ctx, sym)


def _session_remaining_usd(ctx: Any) -> Optional[float]:
    fn = member(ctx, "policyRemaining")
    if not callable(fn):
        return None
    try:
        rem = fn()
    except Exception:
        return None
    su = member(rem, "sessionUsd")
    return None if su is None else float(su)


# --------------------------------------------------------------------------- #
# base class                                                                  #
# --------------------------------------------------------------------------- #

class Strategy:
    name = "strategy"
    defaults: Dict[str, Any] = {}

    def describe(self) -> str:  # pragma: no cover - overridden
        return self.name

    def validate_params(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotImplementedError

    async def plan(self, ctx: Any, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        raise NotImplementedError

    # -- shared param coercion helpers (throw on bad input) -------------------
    @staticmethod
    def _pos_int(v, name):
        try:
            iv = int(v)
        except (TypeError, ValueError):
            raise ValueError(name + " must be an integer")
        if iv < 0:
            raise ValueError(name + " must be >= 0")
        return iv

    @staticmethod
    def _pos_num(v, name):
        try:
            fv = float(v)
        except (TypeError, ValueError):
            raise ValueError(name + " must be a number")
        if fv < 0:
            raise ValueError(name + " must be >= 0")
        return fv

    def _intent(self, tool, args, rationale, est_usd, tag, mainnet, group=None):
        it = {"tool": tool, "args": args, "rationale": rationale, "estUsd": est_usd,
              "strategy": self.name, "tag": tag, "mainnet": bool(mainnet)}
        if group is not None:
            it["group"] = group
        return it


# --------------------------------------------------------------------------- #
# 3.1 arbitrage (headline)                                                    #
# --------------------------------------------------------------------------- #

class Arbitrage(Strategy):
    name = "arbitrage"
    defaults = {"pair": "BLOCK/USDC", "venues": None, "minEdgeBps": 30,
                "maxNotionalUsd": 50, "gasBufferUsd": 2, "slippageBps": MIN_SLIPPAGE_BPS,
                "agentFeeBps": AGENT_FEE_BPS}

    def describe(self) -> str:
        return "Capture a profitable cross-venue price gap for one pair (both legs or neither)."

    def validate_params(self, params=None):
        p = dict(self.defaults)
        p.update(params or {})
        if not p.get("pair"):
            raise ValueError("arbitrage requires a pair")
        _split_pair(p["pair"])
        if p.get("venues") is not None and not isinstance(p["venues"], (list, tuple)):
            raise ValueError("venues must be a list")
        p["minEdgeBps"] = self._pos_int(p["minEdgeBps"], "minEdgeBps")
        p["maxNotionalUsd"] = self._pos_num(p["maxNotionalUsd"], "maxNotionalUsd")
        p["gasBufferUsd"] = self._pos_num(p["gasBufferUsd"], "gasBufferUsd")
        # FIX-2: slippage has a conservative non-zero FLOOR — a caller may raise it
        # but can never configure it below MIN_SLIPPAGE_BPS (0 would understate cost).
        p["slippageBps"] = max(MIN_SLIPPAGE_BPS,
                               self._pos_int(p.get("slippageBps") or 0, "slippageBps"))
        # FIX-2: the agent-fee term is pinned to the REAL on-chain rate. A caller may
        # only make it more conservative; agentFeeBps is floored at AGENT_FEE_BPS so
        # passing 0 can never price a loss-making arb as profitable.
        p["agentFeeBps"] = max(AGENT_FEE_BPS,
                               self._pos_int(p.get("agentFeeBps") if p.get("agentFeeBps") is not None
                                             else AGENT_FEE_BPS, "agentFeeBps"))
        return p

    async def _venue_objs(self, ctx, params, probe_usd):
        """Resolve each venue to an object with {id, ask, bid, feeBps, depthBase,
        chain?, mainnet?}. A venue given as a bare id is resolved via venueQuote."""
        venues = params.get("venues")
        if not venues:
            lv = member(ctx, "listVenues")
            venues = await maybe_await(lv(params["pair"])) if callable(lv) else []
        vq = member(ctx, "venueQuote")
        out = []
        for v in venues or []:
            if isinstance(v, str):
                obj = await maybe_await(vq(v, params["pair"], probe_usd)) if callable(vq) else None
                vid = v
            else:
                obj = v
                vid = member(v, "id")
            if obj is None:
                continue
            ask, bid = member(obj, "ask"), member(obj, "bid")
            if ask is None or bid is None:
                continue  # skip venues that can't quote — never fabricate
            out.append({
                "id": vid, "ask": _dec(ask), "bid": _dec(bid),
                "feeBps": int(member(obj, "feeBps") or 0),
                "depthBase": member(obj, "depthBase"),
                "mainnet": _venue_mainnet(obj),
            })
        return out

    async def plan(self, ctx, params):
        base, quote = _split_pair(params["pair"])
        rem = _session_remaining_usd(ctx)
        probe_usd = min(params["maxNotionalUsd"], rem) if rem is not None else params["maxNotionalUsd"]
        if probe_usd <= 0:
            return []

        venues = await self._venue_objs(ctx, params, probe_usd)
        if len(venues) < 2:
            return []

        buy = min(venues, key=lambda v: v["ask"])
        sell = max(venues, key=lambda v: v["bid"])
        if buy["id"] == sell["id"]:
            return []  # no cross-venue edge

        best_ask, best_bid = buy["ask"], sell["bid"]
        if best_ask <= 0:
            return []

        prices = await _prices(ctx, [base, quote])
        quote_usd = member(prices, quote)
        if quote_usd is None:
            return []  # no quote price -> can't size, don't fabricate
        quote_usd_d = _dec(quote_usd)
        base_dec = _decimals(ctx, base)
        quote_dec = _decimals(ctx, quote)

        # USD prices of the base derived from the executable venue prices.
        buy_base_usd = best_ask * quote_usd_d   # cost to acquire 1 base at the ask
        sell_base_usd = best_bid * quote_usd_d

        # size the trade (independent of costs): cap by notional, both venues'
        # depth (converted to USD), and the remaining session budget.
        notional = Decimal(params["maxNotionalUsd"])
        for v, px in ((buy, buy_base_usd), (sell, sell_base_usd)):
            if v["depthBase"] is not None and px > 0:
                depth_usd = (_dec(v["depthBase"]) / (Decimal(10) ** base_dec)) * px
                notional = min(notional, depth_usd)
        if rem is not None:
            notional = min(notional, _dec(rem))
        if notional <= 0:
            return []
        notional_usd = float(notional)

        # FIX-1: all USD-denominated costs are priced on the DEPTH-CLAMPED notional
        # (``notional``), never the full probe — gas is a fixed USD buffer, so its
        # bps weight grows as the executable size shrinks, and the minEdge test
        # below re-runs on the clamped size.
        gross_edge_bps = (best_bid - best_ask) / best_ask * Decimal(10000)
        gas_bps = _dec(params["gasBufferUsd"]) / notional * Decimal(10000)
        # FIX-2: the agent-fee term is the REAL fixed rate (2 * AGENT_FEE_BPS, one
        # leg each way) read from the same source the swap tool charges. A caller
        # can only make it more conservative; it can never dip below the on-chain
        # fee even if validate_params were bypassed.
        agent_fee_bps = max(int(params.get("agentFeeBps") or 0), AGENT_FEE_BPS)
        slippage_bps = max(int(params.get("slippageBps") or 0), MIN_SLIPPAGE_BPS)
        costs_bps = (_dec(buy["feeBps"]) + _dec(sell["feeBps"])
                     + _dec(2 * agent_fee_bps) + _dec(slippage_bps) + gas_bps)
        net_edge_bps = gross_edge_bps - costs_bps
        if net_edge_bps < _dec(params["minEdgeBps"]):
            return []  # (host records skipped: edge < min after clamp)

        # FIX-4: size in exact Decimal/BigInt math — pass the original Decimal
        # ``notional`` (NOT a float round-trip) so 18-decimal legs lose no digits.
        quote_base = _usd_to_base(notional, quote_usd_d, quote_dec)     # quote spent on buy
        base_base = _usd_to_base(notional, buy_base_usd, base_dec)      # base bought & sold
        if not quote_base or not base_base or quote_base <= 0 or base_base <= 0:
            return []

        group = "arb:" + params["pair"] + ":" + str(buy["id"]) + "->" + str(sell["id"])
        net_disp = float(net_edge_bps.quantize(Decimal("0.01"), rounding=ROUND_DOWN))

        buy_tool, buy_args = self._leg(ctx, "buy", buy["id"], base, quote, quote_base, base_base)
        sell_tool, sell_args = self._leg(ctx, "sell", sell["id"], base, quote, quote_base, base_base)

        # FIX-3: either leg's venue being mainnet, OR a chain-level mainnet ctx,
        # taints the WHOLE paired arb (both-legs-or-neither), so the runner's
        # mainnet gate refuses it when mainnetEnabled=false.
        arb_mainnet = buy["mainnet"] or sell["mainnet"] or _is_mainnet(ctx)
        return [
            self._intent(buy_tool, buy_args,
                         "arb buy %s on %s @ %s (net %s bps)" % (base, buy["id"], _price_str(best_ask), net_disp),
                         notional_usd, group + ":buy", arb_mainnet, group),
            self._intent(sell_tool, sell_args,
                         "arb sell %s on %s @ %s (net %s bps)" % (base, sell["id"], _price_str(best_bid), net_disp),
                         notional_usd, group + ":sell", arb_mainnet, group),
        ]

    @staticmethod
    def _leg(ctx, side, venue, base, quote, quote_base, base_base):
        """Pick the tool + args for one leg. A ctx ``venueTool(venue, side)`` hook
        may force buy_block / sell_block for a native rail; otherwise swap (which
        carries the 0.05% fee)."""
        vt = member(ctx, "venueTool")
        if callable(vt):
            forced = vt(venue, side)
            if forced == "buy_block":
                return "buy_block", {"usdc": str(quote_base)}
            if forced == "sell_block":
                return "sell_block", {"blockAmount": str(base_base)}
        if side == "buy":
            return "swap", {"from": quote, "to": base, "amount": str(quote_base), "venue": venue}
        return "swap", {"from": base, "to": quote, "amount": str(base_base), "venue": venue}


# --------------------------------------------------------------------------- #
# 3.2 dca                                                                     #
# --------------------------------------------------------------------------- #

class Dca(Strategy):
    name = "dca"
    defaults = {"asset": None, "quote": "USDC", "usdPerBuy": 10,
                "intervalSec": 86400, "lastRunAt": 0}

    def describe(self) -> str:
        return "Buy a fixed USD of an asset once per interval (dollar-cost averaging)."

    def validate_params(self, params=None):
        p = dict(self.defaults)
        p.update(params or {})
        if not p.get("asset"):
            raise ValueError("dca requires an asset")
        p["quote"] = p.get("quote") or "USDC"
        p["usdPerBuy"] = self._pos_num(p["usdPerBuy"], "usdPerBuy")
        if p["usdPerBuy"] <= 0:
            raise ValueError("usdPerBuy must be > 0")
        p["intervalSec"] = self._pos_int(p["intervalSec"], "intervalSec")
        p["lastRunAt"] = self._pos_int(p.get("lastRunAt") or 0, "lastRunAt")
        return p

    async def plan(self, ctx, params):
        now_fn = member(ctx, "now")
        now_ms = int(await maybe_await(now_fn())) if callable(now_fn) else 0
        if now_ms - params["lastRunAt"] < params["intervalSec"] * 1000:
            return []  # interval not elapsed
        prices = await _prices(ctx, [params["quote"]])
        quote_usd = member(prices, params["quote"])
        amount = _usd_to_base(params["usdPerBuy"], quote_usd, _decimals(ctx, params["quote"]))
        if amount is None or amount <= 0:
            return []  # no price -> no synthetic buy
        mainnet = _is_mainnet(ctx)
        args = {"from": params["quote"], "to": params["asset"], "amount": str(amount)}
        return [self._intent(
            "swap", args,
            "dca buy $%s of %s with %s" % (params["usdPerBuy"], params["asset"], params["quote"]),
            params["usdPerBuy"], "dca:" + params["asset"], mainnet)]


# --------------------------------------------------------------------------- #
# 3.3 grid                                                                    #
# --------------------------------------------------------------------------- #

class Grid(Strategy):
    name = "grid"
    defaults = {"market": None, "levels": 6, "stepBps": 50,
                "sizeUsdPerLevel": 10, "recenter": False}

    def describe(self) -> str:
        return "Lay symmetric buy/sell limit orders around mid at fixed bps steps."

    def validate_params(self, params=None):
        p = dict(self.defaults)
        p.update(params or {})
        if not p.get("market"):
            raise ValueError("grid requires a market")
        _split_pair(p["market"])
        lv = self._pos_int(p["levels"], "levels")
        p["levels"] = max(2, min(20, lv))  # clamp 2..20
        p["stepBps"] = self._pos_int(p["stepBps"], "stepBps")
        if p["stepBps"] <= 0:
            raise ValueError("stepBps must be > 0")
        p["sizeUsdPerLevel"] = self._pos_num(p["sizeUsdPerLevel"], "sizeUsdPerLevel")
        p["recenter"] = bool(p.get("recenter"))
        return p

    async def plan(self, ctx, params):
        base, quote = _split_pair(params["market"])
        gb = member(ctx, "getBook")
        book = await maybe_await(gb(params["market"])) if callable(gb) else None
        bids = member(book, "bids") or []
        asks = member(book, "asks") or []
        if not bids or not asks:
            return []  # no book -> nothing to quote
        best_bid = _dec(member(bids[0], "price"))
        best_ask = _dec(member(asks[0], "price"))
        mid = (best_bid + best_ask) / Decimal(2)
        if mid <= 0:
            return []

        prices = await _prices(ctx, [quote])
        quote_usd = member(prices, quote)
        if quote_usd is None:
            return []

        open_orders = member(ctx, "openOrders")
        if callable(open_orders):
            open_orders = open_orders(params["market"])
        open_orders = open_orders or []
        half_step = mid * _dec(params["stepBps"]) / Decimal(10000) / Decimal(2)

        def occupied(side, price):
            for o in open_orders:
                if member(o, "side") == side and abs(_dec(member(o, "price")) - price) <= half_step:
                    return True
            return False

        base_dec = _decimals(ctx, base)
        mainnet = _is_mainnet(ctx)
        half = params["levels"] // 2
        intents: List[Dict[str, Any]] = []

        def level(side, k):
            factor = _dec(k) * _dec(params["stepBps"]) / Decimal(10000)
            price = mid * (Decimal(1) - factor) if side == "buy" else mid * (Decimal(1) + factor)
            if price <= 0 or occupied(side, price):
                return None
            level_usd = price * _dec(quote_usd)   # USD per 1 whole base at this level
            amount = _usd_to_base(params["sizeUsdPerLevel"], level_usd, base_dec)
            if amount is None or amount <= 0:
                return None
            price_s = _price_str(price)
            return self._intent(
                "place_order",
                {"market": params["market"], "side": side, "type": "limit",
                 "amount": str(amount), "price": price_s},
                "grid %s %s @ %s (level %d)" % (side, base, price_s, k),
                params["sizeUsdPerLevel"],
                "grid:%s:%s:%d" % (params["market"], side, k), mainnet)

        # all buy rungs (inner->outer) first, then all sell rungs
        for side in ("buy", "sell"):
            for k in range(1, half + 1):
                it = level(side, k)
                if it is not None:
                    intents.append(it)
        return intents


# --------------------------------------------------------------------------- #
# 3.4 rebalance                                                               #
# --------------------------------------------------------------------------- #

class Rebalance(Strategy):
    name = "rebalance"
    defaults = {"targets": None, "bandBps": 500, "baseQuote": "USDC", "maxTradeUsd": 50}

    def describe(self) -> str:
        return "Trade assets back toward target weights when they drift outside a band."

    def validate_params(self, params=None):
        p = dict(self.defaults)
        p.update(params or {})
        targets = p.get("targets")
        if not isinstance(targets, dict) or not targets:
            raise ValueError("rebalance requires a non-empty targets map")
        clean = {}
        total = 0.0
        for sym, w in targets.items():
            wf = float(w)
            if wf < 0:
                raise ValueError("target weight must be >= 0 for " + str(sym))
            clean[sym] = wf
            total += wf
        if total <= 0:
            raise ValueError("target weights must sum to > 0")
        if abs(total - 1.0) > 0.05:
            raise ValueError("target weights should sum to ~1.0 (got %.4f)" % total)
        p["targets"] = clean
        p["bandBps"] = self._pos_int(p["bandBps"], "bandBps")
        p["baseQuote"] = p.get("baseQuote") or "USDC"
        p["maxTradeUsd"] = self._pos_num(p["maxTradeUsd"], "maxTradeUsd")
        return p

    async def plan(self, ctx, params):
        base_quote = params["baseQuote"]
        syms = list(params["targets"].keys())
        gb = member(ctx, "getBalance")
        raw = await maybe_await(gb(None, syms)) if callable(gb) else None
        norm = _norm_balances(raw)
        prices = await _prices(ctx, syms + [base_quote])

        values: Dict[str, Decimal] = {}
        total = Decimal(0)
        for sym in syms:
            rec = norm.get(sym)
            price = member(prices, sym)
            if rec is None or price is None:
                return []  # incomplete portfolio data -> never fabricate
            whole = _dec(rec["amount"]) / (Decimal(10) ** _bal_decimals(ctx, sym, norm))
            v = whole * _dec(price)
            values[sym] = v
            total += v
        if total <= 0:
            return []

        mainnet = _is_mainnet(ctx)
        band = _dec(params["bandBps"])
        intents: List[Dict[str, Any]] = []
        for sym in syms:
            if sym == base_quote:
                continue
            actual_w = values[sym] / total
            target_w = _dec(params["targets"][sym])
            drift_bps = (actual_w - target_w) * Decimal(10000)
            if abs(drift_bps) <= band:
                continue
            gap_usd = (actual_w - target_w) * total          # +overweight / -underweight
            trade_usd = min(abs(gap_usd) / Decimal(2), _dec(params["maxTradeUsd"]))
            if trade_usd <= 0:
                continue
            trade_usd_f = float(trade_usd)
            if drift_bps > 0:  # overweight -> sell asset into baseQuote
                amount = _usd_to_base(trade_usd_f, member(prices, sym), _bal_decimals(ctx, sym, norm))
                if amount is None or amount <= 0:
                    continue
                args = {"from": sym, "to": base_quote, "amount": str(amount)}
                rationale = "rebalance sell %s (%.0f bps over) ~$%.2f" % (sym, float(drift_bps), trade_usd_f)
            else:              # underweight -> buy asset from baseQuote
                amount = _usd_to_base(trade_usd_f, member(prices, base_quote), _bal_decimals(ctx, base_quote, norm))
                if amount is None or amount <= 0:
                    continue
                args = {"from": base_quote, "to": sym, "amount": str(amount)}
                rationale = "rebalance buy %s (%.0f bps under) ~$%.2f" % (sym, float(-drift_bps), trade_usd_f)
            intents.append(self._intent("swap", args, rationale, trade_usd_f,
                                        "rebal:" + sym, mainnet))
        return intents


# --------------------------------------------------------------------------- #
# 3.5 momentum (SMA crossover)                                                #
# --------------------------------------------------------------------------- #

class Momentum(Strategy):
    name = "momentum"
    defaults = {"market": None, "shortN": 10, "longN": 30, "tradeUsd": 20, "history": None}

    def describe(self) -> str:
        return "SMA crossover: buy on a golden cross, sell held on a death cross."

    def validate_params(self, params=None):
        p = dict(self.defaults)
        p.update(params or {})
        if not p.get("market"):
            raise ValueError("momentum requires a market")
        _split_pair(p["market"])
        p["shortN"] = self._pos_int(p["shortN"], "shortN")
        p["longN"] = self._pos_int(p["longN"], "longN")
        if p["shortN"] < 1 or p["longN"] < 1:
            raise ValueError("shortN and longN must be >= 1")
        if p["shortN"] >= p["longN"]:
            raise ValueError("shortN must be < longN")
        p["tradeUsd"] = self._pos_num(p["tradeUsd"], "tradeUsd")
        if p.get("history") is not None and not isinstance(p["history"], (list, tuple)):
            raise ValueError("history must be a list of prices")
        return p

    @staticmethod
    def _sma(prices: List[Decimal], n: int, end: int) -> Decimal:
        # mean of n values ending at index `end` (inclusive)
        window = prices[end - n + 1: end + 1]
        return sum(window, Decimal(0)) / Decimal(n)

    async def plan(self, ctx, params):
        base, quote = _split_pair(params["market"])
        history = params.get("history")
        if history is None:
            history = []
        prices = [_dec(x) for x in history]
        if len(prices) < params["longN"] + 1:
            return []  # need longN history PLUS the prior point to detect a cross

        last = len(prices) - 1
        short_now = self._sma(prices, params["shortN"], last)
        short_prev = self._sma(prices, params["shortN"], last - 1)
        long_now = self._sma(prices, params["longN"], last)
        long_prev = self._sma(prices, params["longN"], last - 1)

        golden = short_prev <= long_prev and short_now > long_now
        death = short_prev >= long_prev and short_now < long_now
        if not golden and not death:
            return []

        usd = await _prices(ctx, [base, quote])
        mainnet = _is_mainnet(ctx)

        if golden:
            amount = _usd_to_base(params["tradeUsd"], member(usd, quote), _decimals(ctx, quote))
            if amount is None or amount <= 0:
                return []
            args = {"from": quote, "to": base, "amount": str(amount)}
            return [self._intent("swap", args,
                                 "momentum golden cross on %s -> buy" % params["market"],
                                 params["tradeUsd"], "mom:" + params["market"] + ":buy", mainnet)]

        # death cross -> sell only what's held
        gb = member(ctx, "getBalance")
        raw = await maybe_await(gb(None, [base])) if callable(gb) else None
        norm = _norm_balances(raw)
        want = _usd_to_base(params["tradeUsd"], member(usd, base), _bal_decimals(ctx, base, norm))
        if want is None or want <= 0:
            return []
        held = norm.get(base, {}).get("amount", 0)
        amount = min(want, held)
        if amount <= 0:
            return []  # nothing held to sell
        args = {"from": base, "to": quote, "amount": str(amount)}
        return [self._intent("swap", args,
                             "momentum death cross on %s -> sell held" % params["market"],
                             params["tradeUsd"], "mom:" + params["market"] + ":sell", mainnet)]


# --------------------------------------------------------------------------- #
# registry                                                                    #
# --------------------------------------------------------------------------- #

class Registry:
    def __init__(self, strategies: Dict[str, Strategy]):
        self._by_name = dict(strategies)

    def get(self, name: str) -> Optional[Strategy]:
        return self._by_name.get(name)

    def names(self) -> List[str]:
        return list(self._by_name.keys())

    def describe(self) -> Dict[str, str]:
        return {n: s.describe() for n, s in self._by_name.items()}


def default_registry() -> Registry:
    return Registry({
        "arbitrage": Arbitrage(),
        "dca": Dca(),
        "grid": Grid(),
        "rebalance": Rebalance(),
        "momentum": Momentum(),
    })
