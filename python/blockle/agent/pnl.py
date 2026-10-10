"""agent/pnl.py — realized-profit cost-basis ledger + the single post-commit
hook (``docs/AGENT-STRATEGIES.md`` §8). Python port; numerically identical across
the three wallets.

Two things live here:

1. :class:`Ledger` — a per-``(wallet, channel, asset)`` **average-cost lots
   ledger**. Quantities are base-unit integers (Python ``int`` == BigInt);
   basis is carried as **integer USD-microcents** (``round(usd·1e6)``) so the
   math is exact and language-identical. A BUY adds ``qty`` and ``costUc``; a
   SELL of ``sellQty`` realizes ``proceedsUc − round(avgCostPerUnit·sellQty)``
   and removes that pro-rata share of basis, leaving the average cost unchanged.

2. :class:`RealizedPnl` — the ONE post-commit hook. :func:`runner.dispatch_prepared`
   calls :meth:`RealizedPnl.on_commit` after a trade broadcasts (the single
   commit path — there is no second one). It updates the ledger for the trade's
   buy/sell legs and, when the trade's OUTPUT asset is a configured stablecoin
   and a POSITIVE gain was realized, emits a ``realized_profit`` event, records it
   to the audit, and pops the injectable notifier. Losses update the ledger
   silently; unknown basis respects ``config.requireBasis`` (never a misleading
   profit). No key material is ever read, logged, or persisted here.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from ..multichain._util import maybe_await, member
from . import notify as _notify

# Default stablecoins whose receipt turns a sell into a realized USD exit.
DEFAULT_STABLECOINS = ("USDC", "USDT", "DAI", "USDBC", "PYUSD")

# Smallest realized gain that is worth a pop-up (USD).
DEFAULT_MIN_NOTIFY_USD = 0.01

# Display decimals (only ever used to RENDER a quantity in copy; never to
# fabricate a price). Mirrors strategies.DEFAULT_DECIMALS.
DEFAULT_DECIMALS = {
    "USD": 2, "USDC": 6, "USDT": 6, "DAI": 18, "USDBC": 6, "PYUSD": 6,
    "BLOCK": 8, "BTC": 8, "LTC": 8, "DOGE": 8,
    "ETH": 18, "WETH": 18, "SOL": 9,
}


def usd_to_uc(usd: Any) -> int:
    """``usd`` dollars -> integer USD-microcents (``round(usd·1e6)``, half-up).

    Half-up (toward +inf) matches JS ``Math.round`` so the three ports agree on
    the ``.5`` boundary. ``None`` -> ``0``.
    """
    if usd is None:
        return 0
    x = float(usd) * 1_000_000
    # round half up toward +inf (JS Math.round), not banker's rounding
    return math.floor(x + 0.5)


def uc_to_usd(uc: Any) -> float:
    """Integer USD-microcents -> dollars (float, for event/display only)."""
    return int(uc) / 1_000_000


def _round_half_up_div(num: int, den: int) -> int:
    """``round(num/den)`` as EXACT integer math, half-up toward +inf.

    Used for the pro-rata basis removal ``round(avgCostPerUnit·sellQty)`` where
    ``avgCostPerUnit = costUc/qty`` — kept as a single ``costUc·sellQty / qty``
    rational so no low digits are lost and the result is bit-for-bit identical
    across wallets. Requires ``den > 0``; ``num`` assumed non-negative (basis and
    quantities never go negative in this ledger).
    """
    if den <= 0:
        return 0
    return (2 * num + den) // (2 * den)


class Ledger:
    """Average-cost lots ledger keyed by ``(wallet, channel, asset)``.

    State is pure data (``{qty, costUc}`` per key) — no key material, safe to
    persist alongside the audit log. :meth:`snapshot` / :meth:`load` round-trip
    that state for persistence.
    """

    def __init__(self):
        self._lots: Dict[Tuple[str, str, str], Dict[str, int]] = {}

    @staticmethod
    def _key(wallet: str, channel: str, asset: str) -> Tuple[str, str, str]:
        return (str(wallet), str(channel), str(asset))

    def position(self, wallet: str, channel: str, asset: str) -> Dict[str, int]:
        lot = self._lots.get(self._key(wallet, channel, asset))
        if not lot:
            return {"qty": 0, "costUc": 0}
        return {"qty": lot["qty"], "costUc": lot["costUc"]}

    def avg_cost_uc_per_unit(self, wallet: str, channel: str, asset: str) -> Optional[float]:
        """Average cost in microcents per base unit, or ``None`` with no lot."""
        lot = self._lots.get(self._key(wallet, channel, asset))
        if not lot or lot["qty"] == 0:
            return None
        return lot["costUc"] / lot["qty"]

    def record_buy(self, wallet: str, channel: str, asset: str, qty: Any, cost_uc: Any) -> Dict[str, int]:
        """Add ``qty`` base units and ``cost_uc`` microcents to the lot.

        A zero or negative ``qty`` is a no-op (never fabricate a position). The
        average cost shifts toward the blended price; existing basis is untouched.
        """
        q = int(qty)
        c = int(cost_uc)
        if q <= 0:
            return self.position(wallet, channel, asset)
        key = self._key(wallet, channel, asset)
        lot = self._lots.get(key)
        if not lot:
            lot = {"qty": 0, "costUc": 0}
            self._lots[key] = lot
        lot["qty"] += q
        lot["costUc"] += c
        return {"qty": lot["qty"], "costUc": lot["costUc"]}

    def record_sell(self, wallet: str, channel: str, asset: str, sell_qty: Any,
                    proceeds_uc: Any) -> Dict[str, Any]:
        """Realize a sale of ``sell_qty`` base units for ``proceeds_uc`` microcents.

        Returns a result dict::

            { asset, soldQty, proceedsUc, proceedsTotalUc, basisUc, realizedUc,
              basisKnown, appliedQty, unknownQty, remainingQty, remainingCostUc }

        ``basisUc`` is the pro-rata basis removed (``round(avgCostPerUnit·appliedQty)``)
        and the average cost of the remaining lot is UNCHANGED. ``basisKnown`` is
        ``False`` when the asset was never acquired via the agent (no lot) — the
        caller then refuses to claim a misleading profit.

        OVERSELL honesty (§8): when ``sell_qty`` exceeds the recorded lot, only the
        held/tracked share (``appliedQty``) carries basis; the remainder
        (``unknownQty``) was acquired OUTSIDE the agent and has UNKNOWN basis. We
        prorate ``proceedsUc`` to only the applied share (``proceedsUc``) so the
        untracked remainder can never inflate the realized gain — ``realizedUc``
        reflects the tracked share alone. ``proceedsTotalUc`` keeps the full trade
        proceeds for reference. For a normal (non-oversell) sell ``appliedQty ==
        sell_qty`` so ``proceedsUc == proceedsTotalUc`` (numerically identical — no
        behaviour change).
        """
        q = int(sell_qty)
        proceeds = int(proceeds_uc)
        key = self._key(wallet, channel, asset)
        lot = self._lots.get(key)
        known = bool(lot and lot["qty"] > 0)

        if not known or q <= 0:
            return {"asset": asset, "soldQty": q, "proceedsUc": proceeds,
                    "proceedsTotalUc": proceeds, "basisUc": 0,
                    "realizedUc": proceeds - 0, "basisKnown": known,
                    "appliedQty": 0, "unknownQty": q if q > 0 else 0,
                    "remainingQty": lot["qty"] if lot else 0,
                    "remainingCostUc": lot["costUc"] if lot else 0}

        if q >= lot["qty"]:
            # selling the whole (or more than the) position: remove all basis. The
            # applied (tracked) share is the whole lot; the rest is the oversell.
            applied = lot["qty"]
            basis_uc = lot["costUc"]
            lot["qty"] = 0
            lot["costUc"] = 0
        else:
            applied = q
            basis_uc = _round_half_up_div(lot["costUc"] * q, lot["qty"])
            lot["qty"] -= q
            lot["costUc"] -= basis_uc

        unknown_qty = q - applied
        # prorate proceeds to only the applied/held share on an oversell; a normal
        # sell (unknown_qty == 0) keeps the full proceeds unchanged.
        proceeds_applied = (proceeds if unknown_qty <= 0
                            else _round_half_up_div(proceeds * applied, q))

        return {"asset": asset, "soldQty": q, "proceedsUc": proceeds_applied,
                "proceedsTotalUc": proceeds,
                "basisUc": basis_uc, "realizedUc": proceeds_applied - basis_uc,
                "basisKnown": True, "appliedQty": applied, "unknownQty": unknown_qty,
                "remainingQty": lot["qty"], "remainingCostUc": lot["costUc"]}

    def snapshot(self) -> List[Dict[str, Any]]:
        """Serializable state (no key material) for persistence beside the audit."""
        return [{"wallet": w, "channel": c, "asset": a, "qty": lot["qty"], "costUc": lot["costUc"]}
                for (w, c, a), lot in self._lots.items()]

    def load(self, rows: Optional[List[Dict[str, Any]]]) -> None:
        self._lots = {}
        for r in rows or []:
            self._lots[self._key(r["wallet"], r["channel"], r["asset"])] = {
                "qty": int(r["qty"]), "costUc": int(r["costUc"])}


class RealizedPnl:
    """The single post-commit hook: update the ledger + pop positive stablecoin
    exits. Wired into :func:`runner.dispatch_prepared` so EVERY committed trade
    flows through exactly one path.

    deps:
      ``ledger``       : an existing :class:`Ledger` (one created if omitted).
      ``notifier``     : a :class:`notify.Notifier` or bare callable (optional).
      ``wallet``       : wallet id for ledger keys (default ``"default"``).
      ``channel``      : channel id for ledger keys (default ``"default"``).
      ``priceUsd``     : ``fn(asset, baseUnitsStr) -> usd|None`` to value a leg
                         (sync or async). Never a fabricated price — ``None`` when
                         the host cannot price, and the proceeds fall back to the
                         input's own executed USD.
      ``decimalsOf``   : ``fn(asset) -> int|None`` for display only.
      ``config``       : ``{stablecoins, minNotifyUsd, requireBasis}``.
    """

    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        self.ledger: Ledger = deps.get("ledger") or Ledger()
        self.notifier = _notify.coerce(deps.get("notifier"))
        self.wallet = deps.get("wallet") or "default"
        self.channel = deps.get("channel") or "default"
        price = deps.get("priceUsd")
        self._price = price if callable(price) else None
        dec = deps.get("decimalsOf")
        self._decimals_of = dec if callable(dec) else None
        cfg = deps.get("config") or {}
        self.stablecoins = {str(s).upper() for s in cfg.get("stablecoins", DEFAULT_STABLECOINS)}
        self.min_notify_usd = (float(cfg["minNotifyUsd"]) if cfg.get("minNotifyUsd") is not None
                               else DEFAULT_MIN_NOTIFY_USD)
        self.require_basis = cfg.get("requireBasis", True) is not False

    # ---- helpers -----------------------------------------------------------
    def _decimals(self, asset: str) -> Optional[int]:
        if self._decimals_of:
            try:
                d = self._decimals_of(asset)
                if d is not None:
                    return int(d)
            except Exception:
                pass
        return DEFAULT_DECIMALS.get(str(asset).upper())

    async def _price_usd(self, asset: Optional[str], amount: Any) -> Optional[float]:
        if not self._price or asset is None or amount is None:
            return None
        try:
            v = await maybe_await(self._price(asset, str(amount)))
            return None if v is None else float(v)
        except Exception:
            return None

    def _is_stable(self, asset: Optional[str]) -> bool:
        return asset is not None and str(asset).upper() in self.stablecoins

    def _extract_trade(self, name: str, prep: Dict[str, Any],
                       res: Any) -> Optional[Dict[str, Any]]:
        """Normalize a committed tool output into a trade the ledger understands:
        ``{sellAsset, sellQty, buyAsset, buyQty, venue, txid}`` — or ``None`` when
        the shape is not a recognizable buy/sell (never guess)."""
        summary = prep.get("summary") or {}
        value = prep.get("value") or {}
        action = summary.get("action")
        txid = None
        if isinstance(res, dict):
            txid = res.get("txid")
            if not txid and isinstance(res.get("settlement"), dict):
                txid = res["settlement"].get("txid")

        if action == "swap":
            sell_asset = summary.get("from")
            sell_qty = value.get("amount")
            buy_asset = summary.get("to")
            buy_qty = summary.get("amountOut")
            if sell_asset is None or sell_qty is None:
                return None
            return {"sellAsset": sell_asset, "sellQty": int(sell_qty),
                    "buyAsset": buy_asset,
                    "buyQty": int(buy_qty) if buy_qty is not None else None,
                    "inUsd": value.get("usd"), "venue": summary.get("venue"), "txid": txid}
        return None

    # ---- the hook ----------------------------------------------------------
    async def on_commit(self, name: str, prep: Dict[str, Any], res: Any,
                        audit: Any = None, emit: Any = None) -> Optional[Dict[str, Any]]:
        """Update the ledger for a committed trade and, on a positive stablecoin
        exit, emit + record + pop a ``realized_profit`` event. Returns the event
        (or ``None``). Never raises outward — a bookkeeping/notify failure must not
        unwind a broadcast that already happened."""
        try:
            return await self._on_commit(name, prep, res, audit, emit)
        except Exception:  # noqa: BLE001 — never let PnL break the commit path
            return None

    async def _on_commit(self, name, prep, res, audit, emit) -> Optional[Dict[str, Any]]:
        trade = self._extract_trade(name, prep, res)
        if not trade:
            return None

        sell_asset = trade["sellAsset"]
        sell_qty = trade["sellQty"]
        buy_asset = trade["buyAsset"]
        buy_qty = trade["buyQty"]

        # Value of the trade in USD: prefer the executed value of what was
        # RECEIVED (the honest proceeds of the sell); fall back to the input's own
        # executed USD. Never a fabricated price -> None propagates.
        out_usd = await self._price_usd(buy_asset, buy_qty)
        trade_usd = out_usd if out_usd is not None else trade.get("inUsd")
        proceeds_uc = usd_to_uc(trade_usd) if trade_usd is not None else None

        # ---- SELL leg: dispose the input asset, realize vs. its avg cost ----
        sell_res = self.ledger.record_sell(
            self.wallet, self.channel, sell_asset, sell_qty,
            proceeds_uc if proceeds_uc is not None else 0)

        # ---- BUY leg: the received asset enters the ledger at its cost ----
        if buy_asset is not None and buy_qty is not None and proceeds_uc is not None:
            self.ledger.record_buy(self.wallet, self.channel, buy_asset, buy_qty, proceeds_uc)

        # ---- realized-profit pop-up (positive stablecoin exits only) ----
        if not self._is_stable(buy_asset) or proceeds_uc is None:
            return None

        basis_known = sell_res["basisKnown"]
        realized_uc = sell_res["realizedUc"]
        realized_usd = uc_to_usd(realized_uc)

        if not basis_known and self.require_basis:
            # Unknown basis + requireBasis -> skip rather than show a misleading
            # profit. The ledger already recorded the sell silently.
            return None

        event: Dict[str, Any] = {
            "type": "realized_profit",
            "asset": sell_asset,
            "soldQty": sell_res["soldQty"],
            "proceedsUsd": uc_to_usd(sell_res["proceedsUc"]),
            "basisUsd": uc_to_usd(sell_res["basisUc"]) if basis_known else None,
            "realizedUsd": realized_usd if basis_known else None,
            "stable": buy_asset,
            "venue": trade.get("venue"),
            "txid": trade.get("txid"),
            "decimals": self._decimals(sell_asset),
        }

        if basis_known:
            # Honesty: only POSITIVE realized gains pop. Losses (and sub-threshold
            # gains) update the ledger silently.
            if realized_usd <= self.min_notify_usd:
                return None
        # else: proceeds-only path (requireBasis disabled) — realizedUsd stays None
        #       so the copy never claims a gain it cannot prove.

        if audit is not None:
            try:
                await maybe_await(audit.record(dict(event)))
            except Exception:
                pass
        if callable(emit):
            try:
                emit(dict(event))
            except Exception:
                pass
        if self.notifier is not None:
            copy = _notify.format_realized(event)
            self.notifier.notify(copy["title"], copy["subtitle"], event)
        return event


def create(deps: Optional[Dict[str, Any]] = None) -> RealizedPnl:
    return RealizedPnl(deps)
