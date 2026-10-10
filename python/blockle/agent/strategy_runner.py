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
from .strategies import _is_mainnet as _ctx_is_mainnet


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
