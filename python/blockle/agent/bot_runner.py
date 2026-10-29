"""agent/bot_runner.py — the BotRunner: ticks enabled bots, runs their deal-engine
state machines (:mod:`bots`), and routes every LIVE order through the SAME value-
moving dispatch as the NL runner + the StrategyRunner
(:func:`runner.dispatch_prepared`). There is exactly ONE commit path — no second
broadcast path exists. Faithful Python port of
``blockle-extension/agent/bot-runner.js``. See docs/BLOCKLE-BOTS.md §2-6.

THE FULLY-AUTO-WITHIN-ALLOCATION GATE (§5), made non-bypassable:
  * ``allocationUsd`` is a hard per-bot cap enforced by a per-bot committed-spend
    ledger (``bot.state['committedUc']``) IN ADDITION to the policy session/
    per-asset caps — the tighter bound wins. A live BUY that would push cumulative
    live spend over allocationUsd is NOT auto-approved and NOT prompted: it simply
    does not fire (audited ``skipped: allocation``). Accrual is int-exact and only
    counts orders that actually broadcast.
  * Arming a LIVE bot REQUIRES allocationUsd > 0 AND <= the policy session USD cap
    (fail-closed otherwise).
  * Auto-approve reuses the EXISTING ``policy.auto_approve_under_usd``, which the
    runner sets to the bot's REMAINING allocation around each dispatch — so "auto
    within allocation" is the ONE gate, not a new path. Above remaining allocation
    the policy falls back to its normal confirm (fail-closed with no handler).
  * Caps, allowlist, kill, hash-chained audit, the 0.05% fee, and the mainnet gate
    (default off) are NEVER skipped. Bots default paper + disabled + testnet.
  * PAPER mode simulates fills at the ctx quote: it does NOT broadcast, does NOT
    call the gate, and does NOT consume allocation — it records a simulated deal +
    pnl tagged ``paper``.
  * No synthetic prices: a missing mark skips the tick (audited ``skipped: price``).
"""

from __future__ import annotations

import asyncio
import inspect
import math
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member
from . import bots as _bots
from . import strategies as _strategies
from .policy import AgentHalted
from .runner import dispatch_prepared

STABLE_USD = {"USDC": 1, "USDT": 1, "DAI": 1, "USD": 1, "USDBC": 1, "PYUSD": 1}


def _call_scan(scan, opts):
    """Invoke a discovery ``scan`` the way the JS reference does (``scan({lane,mode})``)
    while staying compatible with a legacy no-arg ``scan()`` stub. JS silently ignores
    extra args; Python does not, so we pass ``opts`` only when the callable accepts a
    positional parameter, else call it bare. Returns the (possibly awaitable) result."""
    try:
        params = inspect.signature(scan).parameters.values()
        accepts = any(p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)
                      for p in params)
    except (TypeError, ValueError):
        accepts = True
    return scan(opts) if accepts else scan()


class BotRunner:
    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        if not deps.get("policy"):
            raise ValueError("BotRunner requires a policy")
        if not deps.get("tools"):
            raise ValueError("BotRunner requires a tools registry")
        self.Bots = deps.get("Bots") or _bots
        self.policy = deps["policy"]
        self.tools = deps["tools"]
        self.audit = deps.get("audit")
        self.ctx = deps.get("ctx") or {}
        self.mainnet_enabled = deps.get("mainnetEnabled") is True  # default False
        on_event = deps.get("onEvent")
        self.on_event = on_event if callable(on_event) else None
        self.pnl = deps.get("pnl")                   # post-commit realized-profit tracker (LIVE)
        self.wallet = deps.get("wallet") or "default"
        self.channel = deps.get("channel") or "default"
        self.store = deps.get("store") or self.Bots.BotStore(
            {"store": deps.get("persist"), "wallet": self.wallet, "channel": self.channel})
        self.discovery = deps.get("discovery") or member(self.ctx, "discovery")
        self.Strategies = deps.get("Strategies")  # optional injection (tests); else module default
        self.Scanner = deps.get("Scanner")        # optional injection (tests); else module default
        self._killed = False
        # ---- background scheduler ------------------------------------------
        # A single asyncio task that ticks every ENABLED bot when its pollSec is
        # due. Started on arm/enable; stopped on kill_all or when no enabled bot
        # remains. ``schedulerBaseSec`` is the loop granularity (overridable for
        # tests); each bot still only ticks when ``now - lastTickAt >= pollSec``.
        self._scheduler_task: Optional["asyncio.Task"] = None
        self._scheduler_running = False
        try:
            self._scheduler_base_sec = float(deps.get("schedulerBaseSec") or 1.0)
        except (TypeError, ValueError):
            self._scheduler_base_sec = 1.0
        if self._scheduler_base_sec <= 0:
            self._scheduler_base_sec = 1.0

    # ---- events / audit -----------------------------------------------------
    def emit(self, ev: Dict[str, Any]) -> None:
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:
                pass

    async def _audit(self, rec: Dict[str, Any]) -> None:
        if self.audit:
            try:
                await maybe_await(self.audit.record(rec))
            except Exception:
                pass

    # ---- bot lifecycle ------------------------------------------------------
    def add(self, spec: Any) -> Any:
        return self.store.add(spec)

    def get(self, id_: str) -> Any:
        return self.store.get(id_)

    def list(self) -> List[Any]:
        return self.store.list()

    async def arm_live(self, id_: str, opts: Optional[Dict[str, Any]] = None) -> Any:
        """Arm a bot LIVE (§5). Fail-closed: requires a finite allocationUsd in
        (0, sessionCap]."""
        opts = opts or {}
        bot = self.store.get(id_)
        if not bot:
            raise ValueError("unknown bot: " + str(id_))
        alloc = float(opts["allocationUsd"]) if opts.get("allocationUsd") is not None else bot.allocation_usd
        session_cap = self.policy.caps.get("sessionUsd") if isinstance(self.policy.caps, dict) else None
        if not (alloc > 0):
            await self._audit({"type": "bot_arm_refused", "bot": id_, "reason": "allocationUsd must be > 0"})
            raise ValueError("cannot arm live: allocationUsd must be > 0 (fail-closed)")
        if session_cap is None:
            await self._audit({"type": "bot_arm_refused", "bot": id_, "reason": "no policy session USD cap set"})
            raise ValueError("cannot arm live: a policy session USD cap is required (fail-closed)")
        if not (alloc <= session_cap):
            await self._audit({"type": "bot_arm_refused", "bot": id_, "reason": "allocationUsd > session cap"})
            raise ValueError("cannot arm live: allocationUsd (" + str(alloc) +
                             ") exceeds the policy session cap ($" + str(session_cap) + ")")
        if bot.network == "mainnet" and not self.mainnet_enabled:
            await self._audit({"type": "bot_arm_refused", "bot": id_, "reason": "mainnet disabled"})
            raise ValueError("cannot arm live on mainnet: set mainnetEnabled=true (operator sign-off)")
        bot.allocation_usd = alloc
        bot.mode = "live"
        bot.enabled = True
        await self._audit({"type": "bot_armed", "bot": id_, "mode": "live",
                           "allocationUsd": alloc, "network": bot.network})
        self.emit({"type": "bot_armed", "bot": id_, "mode": "live", "allocationUsd": alloc})
        await self.store.persist()
        self.start_scheduler()
        return bot

    async def enable_paper(self, id_: str, allocation_usd: Any = None) -> Any:
        bot = self.store.get(id_)
        if not bot:
            raise ValueError("unknown bot: " + str(id_))
        # Optional paper BUDGET: when provided (>0) it bounds cumulative paper spend
        # exactly like the live allocation cap — a sandbox the same size as the real
        # one. Omitted → unbounded paper (legacy/arena behavior, allocationUsd stays 0).
        if allocation_usd is not None and float(allocation_usd) > 0:
            bot.allocation_usd = float(allocation_usd)
        bot.mode = "paper"
        bot.enabled = True
        await self._audit({"type": "bot_armed", "bot": id_, "mode": "paper",
                           "allocationUsd": bot.allocation_usd or 0})
        await self.store.persist()
        self.start_scheduler()
        return bot

    async def pause(self, id_: str) -> Any:
        bot = self.store.get(id_)
        if bot:
            bot.enabled = False
            await self._audit({"type": "bot_paused", "bot": id_})
            await self.store.persist()
            self._stop_scheduler_if_idle()
        return bot

    async def stop(self, id_: str) -> Any:
        """Per-bot STOP: truly halt ONE bot. Sets ``enabled=False`` (so the
        scheduler skips it and its status reads "stopped"), best-effort cancels
        its open LIVE orders, and persists. The bot stays in the store so it can
        be resumed/edited; use :meth:`remove` to delete it entirely."""
        bot = self.store.get(id_)
        if not bot:
            raise ValueError("unknown bot: " + str(id_))
        bot.enabled = False
        if bot.mode == "live":
            try:
                await self._cancel_open_orders(bot)
            except Exception:
                pass
        await self._audit({"type": "bot_stopped", "bot": id_})
        self.emit({"type": "bot_stopped", "bot": id_})
        await self.store.persist()
        self._stop_scheduler_if_idle()
        return bot

    async def remove(self, id_: str) -> bool:
        """Per-bot REMOVE/delete: stop the bot, best-effort cancel its open LIVE
        orders, then DELETE it from the store. Returns True if a bot was removed."""
        bot = self.store.get(id_)
        if not bot:
            return False
        bot.enabled = False
        if bot.mode == "live":
            try:
                await self._cancel_open_orders(bot)
            except Exception:
                pass
        removed = self.store.remove(id_)
        await self._audit({"type": "bot_removed", "bot": id_})
        self.emit({"type": "bot_removed", "bot": id_})
        await self.store.persist()
        self._stop_scheduler_if_idle()
        return removed

    # ---- background scheduler ----------------------------------------------
    def start_scheduler(self) -> Optional["asyncio.Task"]:
        """Start the background tick loop if an asyncio loop is running and one is
        not already active. Idempotent. No-op (returns None) when called outside a
        running loop — callers then tick manually via :meth:`tick_all`."""
        if self._killed:
            return None
        if self._scheduler_task is not None and not self._scheduler_task.done():
            return self._scheduler_task
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        self._scheduler_running = True
        self._scheduler_task = loop.create_task(self._scheduler_loop())
        return self._scheduler_task

    def stop_scheduler(self) -> None:
        """Halt the background tick loop (no bot state is changed)."""
        self._scheduler_running = False
        t = self._scheduler_task
        self._scheduler_task = None
        if t is not None and not t.done():
            t.cancel()

    def _stop_scheduler_if_idle(self) -> None:
        if not self.store.enabled():
            self.stop_scheduler()

    async def _scheduler_loop(self) -> None:
        try:
            while self._scheduler_running and not self._killed:
                enabled = self.store.enabled()
                if not enabled:
                    break  # nothing armed -> the scheduler stops until re-armed
                now = self._now()
                for bot in enabled:
                    if self._killed or not self._scheduler_running:
                        break
                    last = bot.state.get("lastTickAt") or 0
                    if now - last >= bot.poll_sec * 1000:
                        try:
                            await self.tick_bot(bot.id)
                        except Exception:  # noqa: BLE001 — a bad tick never kills the loop
                            pass
                await asyncio.sleep(self._scheduler_base_sec)
        except asyncio.CancelledError:  # pragma: no cover - cooperative cancel
            pass
        finally:
            self._scheduler_running = False
            self._scheduler_task = None

    # ---- KILL (§5): stop ALL bots, best-effort cancel orders, lock vault -----
    async def kill_all(self, reason: Any = None) -> None:
        self._killed = True
        self.stop_scheduler()                        # the scheduler stops on kill
        for bot in self.store.list():
            bot.enabled = False
            if bot.mode == "live":
                try:
                    await self._cancel_open_orders(bot)
                except Exception:
                    pass
        await self._audit({"type": "bot_kill", "reason": reason or "user", "bots": len(self.store.list())})
        self.emit({"type": "bot_kill", "reason": reason or "user"})
        # policy.kill wipes decrypted keys + the LLM credential and locks the vault.
        await self.policy.kill(reason or "bot kill")
        await self.store.persist()

    async def _cancel_open_orders(self, bot: Any) -> None:
        B = self.Bots
        tool = self.tools.get("cancel_order")
        if not tool or not self.policy.is_allowed("cancel_order"):
            return
        # Route cancels through the ONE shared value-moving dispatch (the SAME audited
        # commit routine every order uses) — NOT a bare prepare().commit() second path.
        # Best-effort: a failed cancel never blocks the kill (which locks the vault next).
        remaining_uc = B.micro_usd(bot.allocation_usd) - (bot.state.get("committedUc") or 0)
        envelope = remaining_uc if remaining_uc > 0 else B.micro_usd(bot.allocation_usd)
        by_pair = bot.state.get("byPair") or {}
        for pair in list(by_pair.keys()):
            ps = by_pair.get(pair)
            deal = ps.get("deal") if isinstance(ps, dict) else None
            levels = deal.get("levels") if isinstance(deal, dict) else None
            for lv in (levels or []):
                if lv.get("orderId"):
                    try:
                        await self._dispatch(bot, "cancel_order", {"orderId": lv["orderId"]}, envelope)
                    except Exception:
                        pass

    # ---- read helpers -------------------------------------------------------
    def _ctx_mainnet(self) -> bool:
        try:
            fn = member(self.ctx, "network")
            return bool(callable(fn) and fn() == "mainnet")
        except Exception:
            return False

    async def _prices(self, symbols: List[str]) -> Dict[str, Any]:
        try:
            fn = member(self.ctx, "prices")
            if not callable(fn):
                return {}
            return (await maybe_await(fn(symbols))) or {}
        except Exception:
            return {}

    def _unit_uc(self, prices: Dict[str, Any], sym: str) -> Optional[int]:
        B = self.Bots
        v = prices.get(sym)
        try:
            if v is not None and float(v) > 0:
                return B.micro_usd(v)
        except (TypeError, ValueError):
            pass
        s = str(sym).upper()
        if STABLE_USD.get(s) is not None:
            return B.micro_usd(STABLE_USD[s])
        return None  # no synthetic price

    def _now(self) -> int:
        fn = member(self.ctx, "now")
        if callable(fn):
            return int(fn())
        import time
        return int(time.time() * 1000)

    # =========================================================================
    # tick ONE bot (public: tick_bot) — runs its schedule once. Returns a report.
    # =========================================================================
    async def tick_all(self, opts: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        out = []
        for bot in self.store.enabled():
            out.append(await self.tick_bot(bot.id, opts))
        return out

    async def tick_bot(self, id_: Any, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        bot = id_ if not isinstance(id_, str) else self.store.get(id_)
        if not bot:
            raise ValueError("unknown bot: " + str(id_))
        # a kill (or a paused bot) is a no-op BEFORE we assert liveness, so a killed
        # runner reports cleanly instead of throwing out of the tick.
        if self._killed or not bot.enabled:
            return {"bot": bot.id, "skipped": "disabled"}
        self.policy.assert_live()               # a live-but-unkilled sanity check
        now = self._now()
        bot.state["lastTickAt"] = now

        try:
            if bot.type in ("rebalance", "momentum"):
                report = await self._tick_scheduled(bot, now, opts)
            elif bot.type == "scanner":
                report = await self._tick_scanner(bot, now, opts)
            elif bot.type == "signal":
                report = await self._tick_signal(bot, now, opts)
            else:
                report = await self._tick_deal_bot(bot, bot.type, bot.config, bot.pairs(), now, opts)
        except AgentHalted:
            self._killed = True
            await self._audit({"type": "bot_abort", "bot": bot.id, "reason": "killed"})
            return {"bot": bot.id, "killed": True}
        except Exception as e:  # noqa: BLE001 — surface as a recoverable report
            await self._audit({"type": "bot_error", "bot": bot.id, "error": str(e)})
            report = {"bot": bot.id, "error": str(e)}
        await self.store.persist()
        return report

    # ---- deal bots (dca / grid / smarttrade), also reused by signal-spawned ---
    async def _tick_deal_bot(self, bot: Any, type_: str, cfg: Dict[str, Any],
                             pairs: List[str], now: int, opts: Dict[str, Any]) -> Dict[str, Any]:
        B = self.Bots
        engine = B.ENGINES.get(type_)
        if not engine:
            return {"bot": bot.id, "error": "no engine for " + str(type_)}
        bcfg = engine["bcfg"](cfg) if engine.get("bcfg") else cfg
        ctx_mainnet = self._ctx_mainnet()
        events: List[Dict[str, Any]] = []

        for pair in pairs:
            base, quote = B.split_pair(pair)
            prices = await self._prices([base, quote])
            mark_uc = self._unit_uc(prices, base)
            if mark_uc is None:
                await self._audit({"type": "bot_skip", "bot": bot.id, "pair": pair,
                                   "reason": "price", "detail": "no mark for " + base})
                events.append({"pair": pair, "skipped": "price"})
                continue
            bd = B.decimals_for(base, cfg.get("decimals"))
            quote_dec = B.decimals_for(quote, cfg.get("decimals"))
            quote_uc = self._unit_uc(prices, quote)

            by_pair = bot.state["byPair"]
            ps = by_pair.get(pair)
            if ps is None:
                ps = {"deal": None, "lastCloseAt": 0}
                by_pair[pair] = ps

            # (re)open a deal if needed (dca/smarttrade). grid keeps one persistent deal.
            if type_ == "grid":
                if not ps.get("deal"):
                    ps["deal"] = engine["new_deal"](bot.id + ":" + pair, cfg, mark_uc, bd, now)
            else:
                if not ps.get("deal") or ps["deal"]["status"] == "closed":
                    if not self._can_start(bot, ps, now):
                        events.append({"pair": pair, "waiting": True})
                        continue
                    did = bot.id + ":" + pair + ":" + str(bot.state["dealCount"] + 1)
                    ps["deal"] = engine["new_deal"](did, cfg, now) if type_ == "smarttrade" \
                        else engine["new_deal"](did, now)

            # observe (trailing peak) then step the engine until it returns None,
            # interposing the gate on each fill.
            if engine.get("observe"):
                engine["observe"](ps["deal"], mark_uc)
            guard = 0
            while guard < 128:
                guard += 1
                order = self._engine_step(type_, ps["deal"], bcfg, cfg, mark_uc)
                if not order:
                    break

                if order["action"] == "arm":
                    order["_markUc"] = mark_uc
                    self._engine_apply(type_, ps["deal"], bcfg, cfg, order, None, now)
                    continue

                fill = await self._execute_order(
                    bot, {"base": base, "quote": quote, "bd": bd, "quoteDec": quote_dec, "quoteUc": quote_uc},
                    order, mark_uc, ctx_mainnet)
                if not fill:
                    break  # skipped/blocked/declined — stop this pair's cascade this tick
                fill["bd"] = bd
                self._engine_apply(type_, ps["deal"], bcfg, cfg, order, fill, now)
                ev = {"pair": pair, "action": order["kind"], "side": order["side"],
                      "qty": str(fill["qty"]), "priceUc": str(fill["priceUc"]),
                      "paper": bool(fill.get("paper"))}
                if fill.get("side") == "sell":
                    # the ACTUAL currency the realized proceeds settled into (never a
                    # false label — equals profitCurrency only when a route existed).
                    ev["settleCurrency"] = fill.get("settleCurrency")
                    ev["settled"] = bool(fill.get("settled"))
                events.append(ev)

                if ps["deal"]["status"] == "closed":
                    self._book_close(bot, ps, now)
                    break
        return {"bot": bot.id, "type": type_, "events": events, "dashboard": self.dashboard(bot.id)}

    def _engine_step(self, type_, deal, bcfg, cfg, mark_uc):
        if type_ == "dca":
            return self.Bots.dca_step(deal, bcfg, mark_uc)
        if type_ == "grid":
            return self.Bots.grid_step(deal, mark_uc, bcfg)
        if type_ == "smarttrade":
            return self.Bots.smart_step(deal, cfg, mark_uc)
        return None

    def _engine_apply(self, type_, deal, bcfg, cfg, order, fill, now):
        if type_ == "dca":
            return self.Bots.dca_apply(deal, bcfg, order, fill, now)
        if type_ == "grid":
            return self.Bots.grid_apply(deal, order, fill, now)
        if type_ == "smarttrade":
            return self.Bots.smart_apply(deal, cfg, order, fill, now)

    def _can_start(self, bot, ps, now):
        # cooldown since last close
        if bot.cooldown_sec > 0 and ps.get("lastCloseAt") and (now - ps["lastCloseAt"]) < bot.cooldown_sec * 1000:
            return False
        sc = bot.config.get("startCondition") if isinstance(bot.config, dict) else None
        if sc == "signal":
            return bool(ps.get("signalArmed"))  # a signal must have armed this pair
        # 'asap' (and 'dip' once its trigger logic is wired) start immediately
        return True

    # Book a closed deal into the bot's dashboard stats + archive.
    def _book_close(self, bot, ps, now):
        deal = ps["deal"]
        r = deal.get("realizedUc") or 0
        bot.state["realizedUc"] = (bot.state.get("realizedUc") or 0) + r
        bot.state["dealCount"] = (bot.state.get("dealCount") or 0) + 1
        if r > 0:
            bot.state["winCount"] = (bot.state.get("winCount") or 0) + 1
        elif r < 0:
            bot.state["lossCount"] = (bot.state.get("lossCount") or 0) + 1
        # running peak-to-trough drawdown on cumulative realized
        if bot.state.get("_peakRealizedUc") is None:
            bot.state["_peakRealizedUc"] = 0
        if bot.state["realizedUc"] > bot.state["_peakRealizedUc"]:
            bot.state["_peakRealizedUc"] = bot.state["realizedUc"]
        dd = bot.state["_peakRealizedUc"] - bot.state["realizedUc"]
        if dd > (bot.state.get("maxDrawdownUc") or 0):
            bot.state["maxDrawdownUc"] = dd
        bot.state["closedDeals"].append(deal)
        if len(bot.state["closedDeals"]) > 500:
            del bot.state["closedDeals"][0:len(bot.state["closedDeals"]) - 500]
        ps["lastCloseAt"] = now
        ps["deal"] = None
        ps["signalArmed"] = False

    # =========================================================================
    # effective deploy cap (§ PROFIT MODE) — the per-bot budget, optionally lifted
    # by realized profit. 'off'/'take' -> EXACTLY micro_usd(allocationUsd) (the
    # legacy cap, byte-for-byte). 'compound' -> budget + cumulative realized when
    # realized > 0 (losses never lower the cap below the budget; the budget is a
    # hard floor and the cap NEVER pulls from the wallet).
    # =========================================================================
    def _effective_cap_uc(self, bot) -> int:
        base = self.Bots.micro_usd(bot.allocation_usd)
        if getattr(bot, "profit_mode", "off") == "compound":
            r = bot.state.get("realizedUc") or 0
            return base + r if r > 0 else base
        return base

    # =========================================================================
    # execute a single order — PAPER simulates; LIVE routes through the ONE gate.
    # Returns a fill dict or None when the order did not fire (all audited).
    # =========================================================================
    async def _execute_order(self, bot, m, order, mark_uc, ctx_mainnet):
        B = self.Bots
        mainnet = bool(bot.network == "mainnet" or ctx_mainnet)
        tool_name = "place_order" if bot.type == "grid" else "swap"
        # Grid orders are LIMIT orders at a specific ladder price; DCA/smarttrade fill
        # at the current mark. Use the level price for grid so size = qty*levelPrice.
        exec_price_uc = order["_levelPriceUc"] if order.get("_levelPriceUc") is not None else mark_uc

        if order["side"] == "buy":
            # DCA/smarttrade buys carry a USD size; GRID buys carry only a fixed base
            # qty + its level price (FIX-GRID). Derive usdSizeUc/costUc from qty*levelPrice
            # (base-unit/int-exact) so the SAME allocation cap-check + committed-spend
            # accrual + ONE dispatch apply to grid EXACTLY like DCA.
            if order.get("usdSizeUc") is not None:
                usd_size_uc = order["usdSizeUc"]
                qty = order["_qtyOverride"] if order.get("_qtyOverride") is not None \
                    else B.qty_for_usd(usd_size_uc, mark_uc, m["bd"])
            else:
                qty = order["qty"]
                usd_size_uc = B.value_of(qty, exec_price_uc, m["bd"])  # grid: fixed qty * level price
            cost_uc = B.value_of(qty, exec_price_uc, m["bd"])
            if not qty or qty <= 0:
                await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "size",
                                   "detail": "buy rounds to zero"})
                return None

            # The mandatory 0.05% agent fee rides EVERY live trade; the allocation ledger
            # bounds the TRUE outflow = trade + fee (FIX-ALLOC-FEE), so cap-check AND
            # accrue trade+fee — cumulative live spend can never exceed allocationUsd.
            fee_uc = B.agent_fee_uc(usd_size_uc)

            # --- allocation gate (int-exact, non-bypassable) --------------------
            # LIVE always enforces the per-bot budget. PAPER enforces it too WHEN a
            # budget was set (allocationUsd > 0) — so a paper run is a sandbox the
            # same size as the real one. Legacy/arena paper bots (allocationUsd == 0)
            # are unbounded, preserving the deterministic fixtures exactly.
            remaining_uc = None
            enforce_budget = bot.mode == "live" or (bot.mode == "paper" and bot.allocation_usd > 0)
            if enforce_budget:
                alloc_uc = self._effective_cap_uc(bot)  # budget, + realized profit when compounding
                remaining_uc = alloc_uc - (bot.state.get("committedUc") or 0)
                if usd_size_uc + fee_uc > remaining_uc:
                    # does NOT fire, is NOT prompted — the hard per-bot cap (trade + fee).
                    await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "allocation",
                                       "wantUc": str(usd_size_uc + fee_uc), "remainingUc": str(remaining_uc),
                                       "allocationUsd": bot.allocation_usd})
                    self.emit({"type": "bot_skip", "bot": bot.id, "reason": "allocation"})
                    return None

            # --- mainnet gate (never skipped) ------------------------------------
            if mainnet and not self.mainnet_enabled:
                await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "mainnet",
                                   "detail": "mainnetEnabled=false"})
                return None
            # --- allowlist -------------------------------------------------------
            if not self.policy.is_allowed(tool_name):
                await self._audit({"type": "bot_blocked", "bot": bot.id, "tool": tool_name,
                                   "reason": "not on allowlist"})
                return None

            if bot.mode == "paper":
                # Mirror the live ledger in paper WHEN a budget is set, so the sandbox
                # depletes its budget identically. No-op when unbounded (alloc 0).
                if enforce_budget:
                    bot.state["committedUc"] = (bot.state.get("committedUc") or 0) + usd_size_uc + fee_uc
                await self._audit({"type": "bot_paper_fill", "bot": bot.id, "side": "buy", "kind": order["kind"],
                                   "pair": m["base"] + "/" + m["quote"], "qty": str(qty),
                                   "priceUc": str(exec_price_uc), "costUc": str(cost_uc)})
                return {"side": "buy", "qty": qty, "priceUc": exec_price_uc, "costUc": cost_uc, "paper": True}

            # --- LIVE: route through the ONE value-moving dispatch ---------------
            quote_uc = m["quoteUc"] if m["quoteUc"] is not None else B.micro_usd(1)
            if tool_name == "place_order":
                args = {"market": m["base"] + "/" + m["quote"], "side": "buy", "type": "limit",
                        "amount": str(qty), "price": B.uc_to_usd(order.get("_levelPriceUc") or mark_uc)}
            else:
                amount = str(B.qty_for_usd(usd_size_uc, quote_uc, m["quoteDec"]))  # quote base units to spend
                buy_venue = await self._resolve_venue(bot, m["quote"], m["base"],
                                                      B.uc_to_usd(usd_size_uc), None)
                args = {"from": m["quote"], "to": m["base"], "amount": amount,
                        "venue": buy_venue or "blockle"}
            r = await self._dispatch(bot, tool_name, args, remaining_uc)
            if not r or r.get("rejected") or not r.get("result"):
                await self._audit({"type": "bot_order_rejected", "bot": bot.id,
                                   "reason": r.get("reason") if r else None})
                return None
            # accrue trade + fee, ONLY on broadcast
            bot.state["committedUc"] = (bot.state.get("committedUc") or 0) + usd_size_uc + fee_uc
            res = r["result"]
            out_qty = int(str(res["amountOut"])) if isinstance(res, dict) and res.get("amountOut") is not None else qty
            return {"side": "buy", "qty": out_qty, "priceUc": exec_price_uc, "costUc": cost_uc,
                    "txid": r.get("txid"), "orderId": res.get("orderId") if isinstance(res, dict) else None}

        # ---- SELL (take-profit / stop-loss / grid flip): proceeds, no allocation --
        qty = order.get("qty")
        if not qty or qty <= 0:
            await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "size", "detail": "sell qty zero"})
            return None
        proceeds_uc = B.value_of(qty, exec_price_uc, m["bd"])
        if mainnet and not self.mainnet_enabled:
            await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "mainnet"})
            return None
        if not self.policy.is_allowed(tool_name):
            await self._audit({"type": "bot_blocked", "bot": bot.id, "tool": tool_name, "reason": "not on allowlist"})
            return None

        if bot.mode == "paper":
            await self._audit({"type": "bot_paper_fill", "bot": bot.id, "side": "sell", "kind": order["kind"],
                               "pair": m["base"] + "/" + m["quote"], "qty": str(qty),
                               "priceUc": str(exec_price_uc), "proceedsUc": str(proceeds_uc)})
            # UNIFORM SETTLEMENT (paper): proceeds land in the quote; convert into the
            # bot's profitCurrency (recorded, NEVER broadcast).
            settle = await self._settle_exit(bot, m["quote"], proceeds_uc, bot.profit_currency,
                                             mainnet, True)
            return {"side": "sell", "qty": qty, "priceUc": exec_price_uc, "proceedsUc": proceeds_uc,
                    "paper": True, "settleCurrency": settle["currency"], "settled": settle["settled"]}

        if tool_name == "place_order":
            args = {"market": m["base"] + "/" + m["quote"], "side": "sell", "type": "limit",
                    "amount": str(qty), "price": B.uc_to_usd(order.get("_levelPriceUc") or mark_uc)}
        else:
            sell_venue = await self._resolve_venue(bot, m["base"], m["quote"],
                                                   B.uc_to_usd(proceeds_uc), None)
            args = {"from": m["base"], "to": m["quote"], "amount": str(qty), "venue": sell_venue or "blockle"}
        # sells do not consume allocation; keep the auto-approve envelope at remaining
        # allocation so the sell still auto-approves within the same ONE gate.
        remaining_uc = B.micro_usd(bot.allocation_usd) - (bot.state.get("committedUc") or 0)
        env = remaining_uc if remaining_uc > 0 else B.micro_usd(bot.allocation_usd)
        r = await self._dispatch(bot, tool_name, args, env)
        if not r or r.get("rejected") or not r.get("result"):
            await self._audit({"type": "bot_order_rejected", "bot": bot.id,
                               "reason": r.get("reason") if r else None})
            return None
        res = r["result"]
        # UNIFORM SETTLEMENT (live): the sell's proceeds (quote) are converted into the
        # bot's profitCurrency via ONE additional gated swap (skipped when the quote
        # already IS the profitCurrency; honest native-quote fallback with no route).
        settle = await self._settle_exit(bot, m["quote"], proceeds_uc, bot.profit_currency,
                                         mainnet, False)
        return {"side": "sell", "qty": qty, "priceUc": exec_price_uc, "proceedsUc": proceeds_uc,
                "txid": r.get("txid"), "orderId": res.get("orderId") if isinstance(res, dict) else None,
                "settleCurrency": settle["currency"], "settled": settle["settled"]}

    # LEVER 1+2 AT DISPATCH: resolve the cheapest fillable venue for THIS swap
    # when a route resolver is wired (``ctx.routeCandidates`` -> route descriptors
    # fed to the shared ``venues.choose_route``; the internal Blockle rail is
    # preferred when it can ACTUALLY fill the pair+size, never assumed). Falls
    # back to the bot's configured venue (default 'blockle'). Default-safe: with
    # no resolver the venue is unchanged, so every existing dispatch path behaves
    # exactly as before.
    async def _resolve_venue(self, bot, frm, to, size_usd, chain):
        default = (bot.venue_prefs or {}).get("venue") if isinstance(bot.venue_prefs, dict) else None
        default = default or "blockle"
        try:
            rc = member(self.ctx, "routeCandidates")
            if callable(rc):
                cands = await maybe_await(rc({"from": frm, "to": to, "sizeUsd": size_usd,
                                              "chain": chain, "bot": bot.id}))
                if isinstance(cands, (list, tuple)) and len(cands):
                    if getattr(self, "_Venues", None) is None:
                        from ..multichain import venues as _venues_mod
                        self._Venues = _venues_mod
                    picked = self._Venues.choose_route(list(cands))
                    if picked and picked.get("venue"):
                        return picked["venue"]
        except Exception:
            pass
        return default

    # The ONE gate call: temporarily set policy.auto_approve_under_usd = remaining
    # allocation so an order WITHIN allocation auto-approves through the SAME gate
    # the NL runner uses; restore it afterward so bot state never leaks out.
    async def _dispatch(self, bot, tool_name, args, remaining_uc):
        tool = self.tools.get(tool_name)
        if not tool or not tool.get("valueMoving") or not tool.get("prepare"):
            await self._audit({"type": "bot_blocked", "bot": bot.id, "tool": tool_name,
                               "reason": "not value-moving"})
            return {"rejected": True, "reason": "not value-moving"}
        prev_auto = self.policy.auto_approve_under_usd
        if remaining_uc is not None:
            self.policy.auto_approve_under_usd = self.Bots.uc_to_usd(remaining_uc)
        try:
            await self._audit({"type": "bot_dispatch", "bot": bot.id, "tool": tool_name})
            prep = await maybe_await(tool["prepare"](args))
            self.emit({"type": "prepared", "name": tool_name, "summary": prep.get("summary")})
            disp = await dispatch_prepared(self.policy, self.audit, self.emit, tool_name, prep, pnl=self.pnl)
            if not disp.get("approved"):
                return {"rejected": True, "reason": "user declined confirmation", "summary": disp.get("summary")}
            res = disp.get("result")
            txid = None
            if isinstance(res, dict):
                txid = res.get("txid")
                if not txid and isinstance(res.get("settlement"), dict):
                    txid = res["settlement"].get("txid")
            return {"result": res, "txid": txid, "agentFee": disp.get("agentFee")}
        finally:
            self.policy.auto_approve_under_usd = prev_auto

    # =========================================================================
    # THE UNIFORM SETTLEMENT STEP (every lane — arb / momentum / grid) ---------
    # =========================================================================
    # A realized SELL/exit lands proceeds in the pair's native quote. If that is
    # not the bot's profitCurrency, convert it with ONE additional swap through the
    # SAME value-moving gate (allocation envelope, allowlist, security pre-sign,
    # 0.05% fee, mainnet gate). HONESTY over optimism:
    #   * output already == profitCurrency  -> skip the redundant hop (arb case).
    #   * no profitCurrency set              -> no hop (realize into native quote).
    #   * no priceable route to profitCurrency (not a stablecoin, no real quote)
    #     -> DO NOT fabricate: leave proceeds native and report the ACTUAL output.
    # PAPER records a settlement note and NEVER broadcasts; LIVE commits it.
    def _settle_route_ok(self, prices: Dict[str, Any], profit_currency: Optional[str]) -> bool:
        if not profit_currency:
            return False
        if str(profit_currency).upper() in STABLE_USD:
            return True
        unit = self._unit_uc(prices, profit_currency)
        return unit is not None and unit > 0

    async def _settle_exit(self, bot: Any, proceeds_asset: Optional[str], proceeds_uc: int,
                           profit_currency: Optional[str], mainnet: bool, paper: bool) -> Dict[str, Any]:
        """Convert a realized exit's proceeds INTO ``profit_currency``. Returns
        ``{"currency", "settled", "paper", "routeOk", "txid"}`` where ``currency`` is
        the FINAL asset the proceeds actually sit in (never a false label)."""
        B = self.Bots
        native = str(proceeds_asset).upper() if proceeds_asset else proceeds_asset
        pc = str(profit_currency).upper() if profit_currency else None
        out: Dict[str, Any] = {"currency": native, "settled": False, "paper": bool(paper),
                               "routeOk": True, "txid": None}
        # no target, or the proceeds already ARE the profit currency -> no extra hop.
        if not pc or (native is not None and native == pc):
            if pc:
                out["currency"] = pc
            return out

        # price the route WITHOUT fabrication (stablecoin, or a real quote for both).
        prices = await self._prices([proceeds_asset, pc])
        if not self._settle_route_ok(prices, pc):
            await self._audit({"type": "bot_settle_skip", "bot": bot.id, "from": native,
                               "to": pc, "reason": "no-route"})
            self.emit({"type": "bot_settle_skip", "bot": bot.id, "from": native, "to": pc})
            out["routeOk"] = False
            return out  # currency stays the ACTUAL native output — the label never lies.

        unit_uc = self._unit_uc(prices, proceeds_asset)
        proceeds_dec = B.decimals_for(proceeds_asset,
                                      bot.config.get("decimals") if isinstance(bot.config, dict) else None)
        amount = B.qty_for_usd(proceeds_uc, unit_uc, proceeds_dec) if (unit_uc and proceeds_uc) else 0
        if not amount or amount <= 0:
            # proceeds round to zero in the native asset — nothing to convert; honest.
            await self._audit({"type": "bot_settle_skip", "bot": bot.id, "from": native,
                               "to": pc, "reason": "dust"})
            out["routeOk"] = False
            return out

        if paper:
            # PAPER: record the settlement, NEVER broadcast, NEVER consume allocation.
            await self._audit({"type": "bot_settlement", "bot": bot.id, "from": native, "to": pc,
                               "amount": str(amount), "proceedsUc": str(proceeds_uc), "paper": True})
            self.emit({"type": "bot_settlement", "bot": bot.id, "from": native, "to": pc, "paper": True})
            out["currency"] = pc
            out["settled"] = True
            return out

        # --- mainnet gate + allowlist (never skipped) ---------------------------
        if mainnet and not self.mainnet_enabled:
            await self._audit({"type": "bot_settle_skip", "bot": bot.id, "from": native,
                               "to": pc, "reason": "mainnet"})
            out["routeOk"] = False
            return out
        if not self.policy.is_allowed("swap"):
            await self._audit({"type": "bot_blocked", "bot": bot.id, "tool": "swap",
                               "reason": "not on allowlist (settlement)"})
            out["routeOk"] = False
            return out

        settle_venue = await self._resolve_venue(bot, proceeds_asset, pc, None, None)
        args = {"from": proceeds_asset, "to": pc, "amount": str(amount), "venue": settle_venue or "blockle"}
        # Settlement converts proceeds you already hold — like a sell, it does NOT
        # consume allocation; keep the auto-approve envelope at remaining allocation.
        remaining_uc = B.micro_usd(bot.allocation_usd) - (bot.state.get("committedUc") or 0)
        env = remaining_uc if remaining_uc > 0 else B.micro_usd(bot.allocation_usd)
        await self._audit({"type": "bot_settlement", "bot": bot.id, "from": native, "to": pc,
                           "amount": str(amount), "proceedsUc": str(proceeds_uc), "paper": False})
        self.emit({"type": "bot_settlement", "bot": bot.id, "from": native, "to": pc, "paper": False})
        r = await self._dispatch(bot, "swap", args, env)
        if not r or r.get("rejected") or not r.get("result"):
            # the settlement did NOT broadcast — be honest: proceeds stay native.
            await self._audit({"type": "bot_settle_rejected", "bot": bot.id, "from": native, "to": pc,
                               "reason": r.get("reason") if r else None})
            out["routeOk"] = False
            return out
        out["currency"] = pc
        out["settled"] = True
        out["txid"] = r.get("txid")
        return out

    # ---- signal bot (§2.4) --------------------------------------------------
    async def _tick_signal(self, bot, now, opts):
        B = self.Bots
        cfg = bot.config
        spawn = cfg["onSignal"]  # { type, config }
        open_count = sum(1 for p in bot.state["byPair"].values()
                         if p.get("deal") and p["deal"]["status"] != "closed")
        room = max(0, cfg["maxConcurrent"] - open_count)

        # gather candidate pairs (READ-ONLY; discovery never trades/auto-allowlists)
        signals: List[Dict[str, Any]] = []
        if cfg["source"] in ("discovery", "both") and self.discovery is not None:
            scan = member(self.discovery, "scan")
            if callable(scan):
                # Lane + risk-mode aware discovery: the feed returns only same-chain,
                # same-mode candidates that already cleared the safety gate.
                try:
                    cands = (await maybe_await(_call_scan(scan, {"lane": bot.lane, "mode": bot.risk_mode}))) or []
                except Exception:
                    cands = []
                lane_chain = B.lane_chain(bot.lane) if bot.lane else None
                for c in cands:
                    if lane_chain and c.get("chain") and c.get("chain") != lane_chain:
                        continue  # never cross-lane
                    if c.get("approved") is True and (c.get("score") is None or c.get("score") >= cfg["minScore"]) and c.get("pair"):
                        signals.append({"pair": c["pair"], "score": c.get("score"), "source": "discovery"})
        if cfg["source"] in ("inbox", "both"):
            inbox = bot.state.get("inbox") or []
            for i in range(bot.state.get("cursor") or 0, len(inbox)):
                sgl = inbox[i]
                if sgl and sgl.get("pair"):
                    signals.append({"pair": sgl["pair"], "source": "inbox"})
            bot.state["cursor"] = len(inbox)

        # arm a spawned deal per NEW pair, up to maxConcurrent
        for sig in signals:
            if room <= 0:
                break
            pair = str(sig["pair"]).upper()
            existing = bot.state["byPair"].get(pair)
            if existing and existing.get("deal") and existing["deal"]["status"] != "closed":
                continue
            if not bot.state["byPair"].get(pair):
                bot.state["byPair"][pair] = {"deal": None, "lastCloseAt": 0}
            bot.state["byPair"][pair]["signalArmed"] = True
            await self._audit({"type": "bot_signal", "bot": bot.id, "pair": pair,
                               "source": sig["source"], "template": spawn["type"]})
            room -= 1

        # run the spawned deal engine over ALL armed pairs
        pairs = list(bot.state["byPair"].keys())
        return await self._tick_deal_bot(bot, spawn["type"], spawn["config"], pairs, now, opts)

    async def post_signal(self, id_, signal):
        """Post a local signal to a signal bot's inbox (user / NL agent). READ side only."""
        bot = self.store.get(id_)
        if not bot:
            raise ValueError("unknown bot: " + str(id_))
        bot.state["inbox"] = bot.state.get("inbox") or []
        bot.state["inbox"].append(signal)
        await self.store.persist()
        return bot

    # ---- scheduled bots (rebalance / momentum) reuse the strategy planners ----
    async def _tick_scheduled(self, bot, now, opts):
        strat_mod = self.Strategies or _strategies
        strat = strat_mod.default_registry().get(bot.type)
        if not strat:
            return {"bot": bot.id, "error": "no strategy " + str(bot.type)}
        params = strat.validate_params(dict(bot.config))
        intents = await maybe_await(strat.plan(self.ctx, params))
        events = await self._dispatch_intents(bot, intents or [])
        return {"bot": bot.id, "type": bot.type, "events": events}

    # The ONE shared Intent-dispatch loop used by scheduled bots AND the scanner:
    # every Intent passes the SAME non-bypassable gate — FINITE+positive estimate,
    # the hard per-bot allocation ledger (trade + 0.05% fee), the mainnet gate, the
    # tool allowlist, and the ONE value-moving dispatch (caps/confirm/kill/audit/
    # security pre-sign). PAPER records a paper_intent and NEVER broadcasts. Kill is
    # honored between Intents.
    async def _dispatch_intents(self, bot, intents):
        B = self.Bots
        ctx_mainnet = self._ctx_mainnet()
        events: List[Dict[str, Any]] = []

        def _exit_of(it):
            """A realized exit leg + where its proceeds must settle. ``(is_exit,
            proceeds_asset, profit_currency)``. An exit is tagged ``…:sell`` or carries
            ``exit: True``; its proceeds land in the swap's output asset; the target is
            the intent's ``settleTo`` (scanner) else the bot's profitCurrency."""
            is_exit = bool(it.get("exit")) or str(it.get("tag") or "").endswith(":sell")
            args = it.get("args") or {}
            proceeds_asset = args.get("to")
            pc = it.get("settleTo") or bot.profit_currency
            return is_exit, proceeds_asset, pc

        for it in (intents or []):
            if self.policy.is_killed():
                break
            if bot.mode == "live":
                # FIX-EST: a LIVE order must carry a FINITE, POSITIVE USD estimate or it
                # FAILS CLOSED. None/NaN/inf would coerce to $0 and slip past the cap; a
                # NEGATIVE estimate would accrue negative and EXPAND the ledger — both
                # bypass the hard cap, so reject all.
                _est = it.get("estUsd")
                if _est is None or not math.isfinite(_est) or _est <= 0:
                    await self._audit({"type": "bot_skip", "bot": bot.id,
                                       "reason": "allocation-unknown", "tag": it.get("tag")})
                    events.append({"tag": it.get("tag"), "skipped": "allocation-unknown"})
                    continue
                est_usd_uc = B.micro_usd(it["estUsd"])
                fee_uc = B.agent_fee_uc(est_usd_uc)  # allocation bounds the trade + 0.05% fee
                remaining_uc = self._effective_cap_uc(bot) - (bot.state.get("committedUc") or 0)  # + realized profit when compounding
                if est_usd_uc + fee_uc > remaining_uc:
                    await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "allocation", "tag": it.get("tag")})
                    events.append({"tag": it.get("tag"), "skipped": "allocation"})
                    continue
                if (it.get("mainnet") or ctx_mainnet) and not self.mainnet_enabled:
                    await self._audit({"type": "bot_skip", "bot": bot.id, "reason": "mainnet", "tag": it.get("tag")})
                    events.append({"tag": it.get("tag"), "skipped": "mainnet"})
                    continue
                if not self.policy.is_allowed(it.get("tool")):
                    await self._audit({"type": "bot_blocked", "bot": bot.id, "tool": it.get("tool")})
                    events.append({"tag": it.get("tag"), "blocked": True})
                    continue
                r = await self._dispatch(bot, it.get("tool"), it.get("args"), remaining_uc)
                if r and r.get("result"):
                    bot.state["committedUc"] = (bot.state.get("committedUc") or 0) + est_usd_uc + fee_uc
                    ev = {"tag": it.get("tag"), "executed": True}
                    # UNIFORM SETTLEMENT: a realized exit's proceeds settle into the
                    # profitCurrency via ONE more gated swap (skipped when the output
                    # already IS it — the arb case; honest native fallback with no route).
                    is_exit, proceeds_asset, pc = _exit_of(it)
                    if is_exit and proceeds_asset is not None:
                        settle = await self._settle_exit(bot, proceeds_asset, est_usd_uc, pc,
                                                         bool(it.get("mainnet") or ctx_mainnet), False)
                        ev["settleCurrency"] = settle["currency"]
                        ev["settled"] = settle["settled"]
                    events.append(ev)
                else:
                    events.append({"tag": it.get("tag"), "rejected": r.get("reason") if r else None})
            else:
                if (it.get("mainnet") or ctx_mainnet) and not self.mainnet_enabled:
                    events.append({"tag": it.get("tag"), "skipped": "mainnet"})
                    continue
                await self._audit({"type": "bot_paper_intent", "bot": bot.id, "tag": it.get("tag"),
                                   "estUsd": it.get("estUsd")})
                ev = {"tag": it.get("tag"), "paper": True}
                # PAPER settlement note (never broadcasts) for a realized exit leg.
                is_exit, proceeds_asset, pc = _exit_of(it)
                if is_exit and proceeds_asset is not None:
                    settle = await self._settle_exit(bot, proceeds_asset, B.micro_usd(it.get("estUsd") or 0), pc,
                                                     bool(it.get("mainnet") or ctx_mainnet), True)
                    ev["settleCurrency"] = settle["currency"]
                    ev["settled"] = settle["settled"]
                events.append(ev)
        return events

    # ---- scanner (scan-&-trade autopilot, docs/AGENT-SCAN.md) -----------------
    # Build the candidate universe (discovery feed ∪ exchange markets ∪ venue pairs,
    # enriched with market data), score every pair with the shared scanner evaluator,
    # pick the worthy ones that fit the REMAINING allocation, and dispatch each chosen
    # Intent through the SAME gate (_dispatch_intents) as every other bot. READ-ONLY
    # until dispatch; never fabricates a price/edge; a sub-threshold or net-negative
    # pair is NEVER emitted. Returns the scored candidate list (for the UI) + events.
    async def _tick_scanner(self, bot, now, opts):
        B = self.Bots
        Scanner = self.Scanner
        if Scanner is None:
            from . import scanner as Scanner  # lazy import; module default
        Strategies = self.Strategies or _strategies
        universe = await self._scan_universe(bot)
        committed_usd = B.uc_to_usd(bot.state.get("committedUc") or 0)
        result = await Scanner.scan_and_score(universe, bot.config, {
            "Strategies": Strategies, "allocationUsd": bot.allocation_usd,
            "committedUsd": committed_usd, "mainnet": self._ctx_mainnet(),
        })
        await self._audit({
            "type": "scanner_scan", "bot": bot.id, "candidates": len(result["candidates"]),
            "worthy": len(result["worthy"]), "traded": [w["pair"] for w in result["worthy"]],
            "skipped": [s["pair"] + ":" + s["reason"] for s in result["skipped"]],
        })
        events = await self._dispatch_intents(bot, result["intents"])
        bot.state["lastScan"] = {
            "at": now, "candidates": result["candidates"],
            "worthy": [w["pair"] for w in result["worthy"]], "skipped": result["skipped"],
            "minProfitBps": result["minProfitBps"], "allocationUsd": result["allocationUsd"],
            "committedUsd": committed_usd, "remainingUsd": result["remainingUsd"],
            "profitCurrency": result.get("profitCurrency"),
        }
        return {"bot": bot.id, "type": "scanner", "scan": bot.state["lastScan"], "events": events}

    # Assemble the scanner's candidate universe. Prefer an injected enriched feed
    # (ctx.scanUniverse — discovery ∪ exchange markets ∪ venue pairs WITH venue
    # prices/history/book), else fall back to the discovery feed. READ-ONLY.
    async def _scan_universe(self, bot):
        fn = member(self.ctx, "scanUniverse")
        if callable(fn):
            try:
                return (await maybe_await(fn(bot.config if bot else None))) or []
            except Exception:
                return []
        if self.discovery is not None:
            scan = member(self.discovery, "scan")
            if callable(scan):
                try:
                    B = self.Bots
                    rows = (await maybe_await(_call_scan(scan, {"lane": bot.lane if bot else None,
                                                                "mode": bot.risk_mode if bot else None}))) or []
                    lane_chain = B.lane_chain(bot.lane) if (bot and bot.lane) else None
                    if lane_chain:
                        rows = [r for r in rows if not r.get("chain") or r.get("chain") == lane_chain]  # never cross-lane
                    return rows
                except Exception:
                    return []
        return []

    # =========================================================================
    # per-bot dashboard DATA (§4) — accessors only, no UI.
    # =========================================================================
    def dashboard(self, id_, marks_override: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        B = self.Bots
        bot = id_ if not isinstance(id_, str) else self.store.get(id_)
        if not bot:
            return None
        open_deals: List[Dict[str, Any]] = []
        unrealized_uc = 0
        safety_used = 0
        for pair in list((bot.state.get("byPair") or {}).keys()):
            ps = bot.state["byPair"][pair]
            deal = ps.get("deal") if isinstance(ps, dict) else None
            if not deal or deal["status"] == "closed":
                continue
            base = B.split_pair(pair)[0]
            mark_uc = None
            if marks_override and marks_override.get(base) is not None:
                mark_uc = B.micro_usd(marks_override[base])
            if deal["type"] == "grid":
                uc = 0
                for lv in deal["levels"]:
                    if lv["heldQty"] > 0 and mark_uc is not None:
                        uc += B.value_of(lv["heldQty"], mark_uc, B.decimals_for(base, bot.config.get("decimals"))) - (lv.get("_costUc") or 0)
                unrealized_uc += uc
                open_deals.append({"pair": pair, "type": "grid", "levels": len(deal["levels"]),
                                   "filledLevels": len([l for l in deal["levels"] if l["heldQty"] > 0]),
                                   "realizedUc": str(deal.get("realizedUc") or 0)})
            else:
                qty = deal["filledQty"] if deal.get("filledQty") is not None else deal.get("remainingQty")
                cost = deal["costUc"] if deal.get("costUc") is not None else deal.get("entryCostUc")
                safety_used += deal.get("safetyOrdersUsed") or 0
                uc = 0
                if mark_uc is not None and qty and qty > 0:
                    uc = B.value_of(qty, mark_uc, B.decimals_for(base, bot.config.get("decimals"))) - (cost or 0)
                unrealized_uc += uc
                open_deals.append({
                    "pair": pair, "type": deal["type"], "status": deal["status"],
                    "avgEntryUsd": B.uc_to_usd(deal.get("avgEntryUc")), "filledQty": str(qty or 0),
                    "safetyOrdersUsed": deal.get("safetyOrdersUsed") or 0,
                    "unrealizedUsd": B.uc_to_usd(uc) if mark_uc is not None else None,
                })
        deal_count = bot.state.get("dealCount") or 0
        wins = bot.state.get("winCount") or 0
        out = {
            "bot": bot.id, "name": bot.name, "type": bot.type, "mode": bot.mode,
            "enabled": bot.enabled, "network": bot.network,
            "status": "killed" if self._killed else ("running" if bot.enabled else "stopped"),
            "allocationUsd": bot.allocation_usd,
            "lane": bot.lane or None, "riskMode": bot.risk_mode or None,
            "profitMode": getattr(bot, "profit_mode", "off") or "off",
            # effective deploy cap = budget, + realized profit when compounding (else == budget)
            "effectiveCapUsd": B.uc_to_usd(self._effective_cap_uc(bot)),
            "committedUsd": B.uc_to_usd(bot.state.get("committedUc") or 0),
            # remaining budget shown whenever one is set (live always; paper when a budget was given)
            "remainingUsd": B.uc_to_usd(self._effective_cap_uc(bot) - (bot.state.get("committedUc") or 0))
            if (bot.mode == "live" or bot.allocation_usd > 0) else None,
            "activeDeals": open_deals,
            "safetyOrdersUsed": safety_used,
            "realizedUsd": B.uc_to_usd(bot.state.get("realizedUc") or 0),
            "unrealizedUsd": B.uc_to_usd(unrealized_uc),
            "totalDeals": deal_count,
            "winCount": wins, "lossCount": bot.state.get("lossCount") or 0,
            "winRate": (wins / deal_count) if deal_count > 0 else None,
            "maxDrawdownUsd": B.uc_to_usd(bot.state.get("maxDrawdownUc") or 0),
        }
        # Scanner cockpit card (docs/AGENT-SCAN.md §3): surface the last scan's
        # candidates + scores + traded/skipped reasons for the "Scan & trade" view.
        if bot.type == "scanner":
            out["scan"] = bot.state.get("lastScan")
        return out

    def aggregate(self) -> Dict[str, Any]:
        B = self.Bots
        realized_uc = 0
        rows = []
        for bot in self.store.list():
            realized_uc += bot.state.get("realizedUc") or 0
            rows.append(self.dashboard(bot.id))
        return {"realizedUsd": B.uc_to_usd(realized_uc), "bots": rows, "killed": self._killed}


def create(deps: Optional[Dict[str, Any]] = None) -> BotRunner:
    return BotRunner(deps)
