"""agent/strategy_runner.py — the thin driver that turns a strategy's Intents
into real actions WITHOUT ever adding a second commit path.

It reuses :func:`runner.dispatch_prepared` verbatim — the exact same
cap -> confirm -> commit -> fee -> record routine the natural-language runner
uses — so a strategy Intent is subject to every rail (per-session/per-asset
caps, default-on confirm, allowlist, kill switch, hash-chained audit, mandatory
0.05% fee). A strategy CANNOT bypass any of it.

Modes:
  - ``propose`` (default): emit + audit each Intent as ``strategy_proposal`` and
    return it; dispatch NOTHING. This is the safe default.
  - ``auto``: dispatch each Intent through the shared gated path, within the
    policy caps + ``autoApproveUnderUsd``; still honors confirm above the auto
    threshold, still honors kill BETWEEN Intents, still honors the mainnet gate.

Mainnet gate: an Intent flagged ``mainnet`` is refused unless
``mainnetEnabled is True`` (default False — testnet/dry).

Allowlist + the both-legs-or-neither arbitrage rule: Intents sharing a ``group``
(the two arb legs) are dropped together if EITHER leg's tool is not allowlisted,
so a half-executed arb can never happen.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member
from . import strategies as _strategies
from .policy import AgentHalted, CapExceeded
from .runner import dispatch_prepared
from .strategies import STABLE_USD, _num
from .strategies import _is_mainnet as _ctx_is_mainnet


def _pair_of(p: Dict[str, Any]):
    """Resolve a strategy's market -> (BASE, QUOTE, 'BASE/QUOTE') or ``None``.

    Covers the single-market planners (``market`` / ``pair``) and the dca-style
    (``asset`` + ``quote``). Returns ``None`` for the strategies that have no
    single market (rebalance), so their price ring stays inert."""
    s = p.get("market") or p.get("pair")
    if not s and p.get("asset"):
        s = str(p["asset"]) + "/" + str(p.get("quote") or "USDC")
    if not s:
        return None
    parts = str(s).upper().split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return parts[0], parts[1], parts[0] + "/" + parts[1]


def _book_mid(book: Any):
    """Book mid (quote-per-base) from a ``{mid}`` or ``{bids,asks}`` book; ``None``
    if neither is resolvable."""
    if not book:
        return None
    mid = member(book, "mid")
    if mid is not None:
        return _num(mid, 0) or None
    bids = member(book, "bids") or []
    asks = member(book, "asks") or []
    bb = bids[0] if bids else None
    ba = asks[0] if asks else None
    bid = _num(member(bb, "price") if bb is not None else None, float("nan"))
    ask = _num(member(ba, "price") if ba is not None else None, float("nan"))
    if bid == bid and ask == ask:  # not NaN
        return (bid + ask) / 2
    return None


class StrategyRunner:
    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        if not deps.get("tools"):
            raise ValueError("strategy runner requires a tools registry")
        if not deps.get("policy"):
            raise ValueError("strategy runner requires a policy")
        self.tools = deps["tools"]
        self.policy = deps["policy"]
        self.audit = deps.get("audit")
        self.pnl = deps.get("pnl")
        self.ctx = deps.get("ctx") or {}
        self.mainnet_enabled = bool(deps.get("mainnetEnabled"))
        self.registry = deps.get("registry") or _strategies.default_registry()
        on_event = deps.get("onEvent")
        self.on_event = on_event if callable(on_event) else None
        # Optional READ-ONLY candidate feed (§7). Discovery NEVER trades, signs, or
        # auto-allowlists; it only surfaces ranked, approved=False suggestions. The
        # dispatch gate below is UNCHANGED, so an unapproved (or approved-but-not-
        # allowlisted) token still produces a `blocked` audit note — never a trade.
        self.discovery = deps.get("discovery")
        self.use_discovery = deps.get("useDiscovery") is True
        self.auto_consider_unapproved = deps.get("autoConsiderUnapproved") is True  # default off
        self.channel = deps.get("channel")
        # Per-strategy price ring (last ``history_cap`` prices, oldest->newest),
        # persisted across ticks and supplied to plan() as ``p["history"]`` so the
        # stateless indicator planners (rsi/macd/bollinger/breakout/emacross/
        # momentum_roc/meanrev/rebalance_hold/hodl) get their
        # window and derive any cross-state from it. The ring is the ONLY host-held
        # state; planners stay pure + stateless. Identical to the JS/Dart hosts.
        hc = deps.get("historyCap")
        self.history_cap = max(2, int(hc)) if hc is not None else 400
        rings = deps.get("priceRings")
        self.price_rings: Dict[str, List[float]] = rings if isinstance(rings, dict) else {}

    async def _record_price(self, strategy_name: str, p: Dict[str, Any]):
        """Observe the current market price for this strategy's market, push it onto
        the persisted per-strategy ring (oldest->newest, capped at ``history_cap``),
        and return a snapshot. The price is the book mid (quote-per-base) when
        available, else derived from ``ctx.prices`` as ``prices[base]/prices[quote]``
        — the same quote-per-base unit the fixtures use. Returns ``None`` (and
        records nothing) when no market or price resolves, so the non-history
        strategies (dca/arbitrage/rebalance) stay inert."""
        pr = _pair_of(p)
        if pr is None:
            return None
        base, quote, mkt = pr
        key = strategy_name + "|" + mkt
        ring = self.price_rings.get(key)
        if ring is None:
            ring = []
            self.price_rings[key] = ring
        price = None
        gb = member(self.ctx, "getBook")
        if callable(gb):
            try:
                price = _book_mid(await maybe_await(gb(mkt)))
            except Exception:
                price = None
        if not (price and price > 0):
            pf = member(self.ctx, "prices")
            if callable(pf):
                try:
                    px = await maybe_await(pf([base, quote])) or {}
                    b = _num(member(px, base), 0)
                    qraw = member(px, quote)
                    q = _num(qraw if qraw is not None else STABLE_USD.get(str(quote).upper()), 0)
                    if b > 0 and q > 0:
                        price = b / q
                except Exception:
                    price = None
        if price and price > 0:
            ring.append(price)
            if len(ring) > self.history_cap:
                del ring[0]
        return list(ring) if ring else None

    async def candidates(self, opts: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """READ-ONLY candidate universe passthrough (§7 Wiring). Returns the ranked
        Candidates from ``discovery.scan()`` filtered to ``approved is True`` by
        DEFAULT. Only when ``autoConsiderUnapproved`` is explicitly enabled (or the
        caller passes ``includeUnapproved=True``) are unapproved candidates included
        — and EVEN THEN any resulting trade STILL passes the dispatch gate in
        :meth:`tick` (an unapproved / non-allowlisted token yields a ``blocked``
        note, never a trade). This method never trades, signs, or mutates the
        allowlist. Returns ``[]`` when no discovery feed is wired."""
        opts = opts or {}
        scan = member(self.discovery, "scan") if self.discovery is not None else None
        if not callable(scan):
            return []
        all_c = await maybe_await(scan()) or []
        inc = opts.get("includeUnapproved")
        include_unapproved = bool(inc) if inc is not None else self.auto_consider_unapproved
        if include_unapproved:
            return list(all_c)
        return [c for c in all_c if c.get("approved") is True]

    def emit(self, ev: Dict[str, Any]) -> None:
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:
                pass

    def _dropped_groups(self, intents: List[Dict[str, Any]]):
        """Groups to drop wholesale: any group with a non-allowlisted leg."""
        bad = set()
        for it in intents:
            g = it.get("group")
            if g is not None and not self.policy.is_allowed(it.get("tool")):
                bad.add(g)
        return bad

    async def tick(self, strategy_name: str, params: Optional[Dict[str, Any]] = None,
                   opts: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        opts = opts or {}
        # FIX-5: dispatch (live) ONLY when mode is exactly "auto". ANY other value
        # — a typo, an empty string, "dryrun", None — fails safe to propose: emit +
        # audit the Intents, dispatch nothing.
        mode = "auto" if opts.get("mode") == "auto" else "propose"

        self.policy.assert_live()  # kill before we even plan

        strat = self.registry.get(strategy_name)
        if not strat:
            raise ValueError("unknown strategy: " + str(strategy_name))
        params = strat.validate_params(params or {})

        # Persist + supply the per-strategy price ring as p["history"]
        # (oldest->newest). If the caller already supplied an explicit history
        # (a backtest or the shared fixture), respect it and do NOT touch the
        # ring; otherwise observe the current price, push it onto the ring, and
        # hand plan() a snapshot. Identical wiring in the JS + Dart hosts.
        if params.get("history") is None:
            hist = await self._record_price(strategy_name, params)
            if hist:
                params["history"] = hist

        intents = await maybe_await(strat.plan(self.ctx, params))
        intents = intents or []

        if self.audit:
            await self.audit.record({"type": "strategy_plan", "strategy": strategy_name,
                                     "count": len(intents), "mode": mode})
        self.emit({"type": "strategy_plan", "strategy": strategy_name,
                   "count": len(intents), "mode": mode})

        dropped = self._dropped_groups(intents)
        results: List[Dict[str, Any]] = []

        for intent in intents:
            if self.policy.is_killed():
                if self.audit:
                    await self.audit.record({"type": "aborted", "strategy": strategy_name,
                                             "reason": "killed"})
                self.emit({"type": "aborted", "strategy": strategy_name, "reason": "killed"})
                break

            tool_name = intent.get("tool")
            group = intent.get("group")

            # allowlist (both-legs-or-neither for grouped arb legs)
            if (group is not None and group in dropped) or not self.policy.is_allowed(tool_name):
                note = {"type": "blocked", "strategy": strategy_name, "tool": tool_name,
                        "tag": intent.get("tag"),
                        "reason": "group leg not allowlisted" if group is not None and group in dropped
                        else "tool not allowlisted"}
                if self.audit:
                    await self.audit.record(note)
                self.emit(note)
                results.append({"blocked": intent, "reason": note["reason"]})
                continue

            if mode == "propose":
                if self.audit:
                    await self.audit.record({"type": "strategy_proposal", "strategy": strategy_name,
                                             "intent": intent})
                self.emit({"type": "strategy_proposal", "strategy": strategy_name, "intent": intent})
                results.append({"proposed": intent})
                continue

            # ---- auto: dispatch through the SHARED gated commit path ----
            # FIX-3: chain-level mainnet backstop. Refuse when EITHER the Intent is
            # flagged mainnet OR the ctx itself resolves to a mainnet network — so a
            # venue-less swap (dca/grid/rebalance/momentum) that the host auto-routes
            # to a mainnet chain at commit is still gated, not just descriptor-flagged.
            if (intent.get("mainnet") or _ctx_is_mainnet(self.ctx)) and not self.mainnet_enabled:
                note = {"type": "mainnet_blocked", "strategy": strategy_name,
                        "tool": tool_name, "tag": intent.get("tag")}
                if self.audit:
                    await self.audit.record(note)
                self.emit(note)
                results.append({"blocked": intent, "reason": "mainnet disabled"})
                continue

            # FIX-6: structural gate invariant. In auto mode we NEVER prepare/commit
            # an Intent whose tool is not value-moving (or unknown / mis-flagged):
            # drop it with an audited "blocked" note and move on — a planner naming a
            # read-only or bogus tool can never reach the single commit path, and a
            # mis-flagged tool can never crash the tick.
            tool = self.tools.get(tool_name)
            if not tool or not tool.get("valueMoving") or not tool.get("prepare"):
                note = {"type": "blocked", "strategy": strategy_name, "tool": tool_name,
                        "tag": intent.get("tag"), "reason": "tool not value-moving"}
                if self.audit:
                    await self.audit.record(note)
                self.emit(note)
                results.append({"blocked": intent, "reason": note["reason"]})
                continue

            try:
                prep = await maybe_await(tool["prepare"](intent.get("args") or {}))
                self.emit({"type": "prepared", "tool": tool_name, "summary": prep.get("summary")})
                disp = await dispatch_prepared(self.policy, self.audit, self.emit, tool_name, prep,
                                               pnl=self.pnl)
            except AgentHalted:
                if self.audit:
                    await self.audit.record({"type": "aborted", "strategy": strategy_name,
                                             "reason": "killed"})
                self.emit({"type": "aborted", "strategy": strategy_name, "reason": "killed"})
                break
            except CapExceeded as e:
                if self.audit:
                    await self.audit.record({"type": "error", "strategy": strategy_name,
                                             "tool": tool_name, "error": str(e), "cap": True})
                self.emit({"type": "tool_error", "tool": tool_name, "error": str(e)})
                results.append({"rejected": intent, "reason": str(e), "cap": True})
                continue
            except Exception as e:  # noqa: BLE001 — surface as a recoverable result
                if self.audit:
                    await self.audit.record({"type": "error", "strategy": strategy_name,
                                             "tool": tool_name, "error": str(e)})
                self.emit({"type": "tool_error", "tool": tool_name, "error": str(e)})
                results.append({"error": str(e), "intent": intent})
                continue

            if not disp["approved"]:
                results.append({"declined": intent, "summary": disp.get("summary")})
            else:
                results.append({"executed": intent, "result": disp.get("result"),
                                "fee": disp.get("agentFee")})
        return results


def create(deps: Optional[Dict[str, Any]] = None) -> StrategyRunner:
    return StrategyRunner(deps)
