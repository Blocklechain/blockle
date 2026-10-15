"""agent/command.py — the NATURAL-LANGUAGE COMMAND BAR router. Faithful Python
port of ``blockle-extension/agent/command.js``.

It adds NO new power. The agent (the SAME ``provider.turn`` — hosted or BYO) only
PROPOSES tool-calls over the EXISTING tool registry (:func:`tools.build`), and the
EXISTING gate (``policy`` + ``runner.dispatch_prepared``) enforces every fund
move. There is NO second broadcast path and NO relaxed confirm path here.

Given typed text + wallet context it routes into one of two intents:

  (A) ACTION  ("send 0.1 ETH to alice.eth", "swap 100 USDC to SOL",
              "rebalance to 60/40 stables" = a SEQUENCE of swaps)
      For EACH proposed value-moving tool-call the router:
        1. RESOLVES any name (:func:`addressbook.resolve_name`) and shows the
           RESOLVED address — the resolved address is what is then inspected,
           confirmed, and sent (never the raw typed name).
        2. dispatches through the ONE gate — ``tool.prepare()`` then
           :func:`runner.dispatch_prepared` (the SINGLE commit path the NL
           Runner and the StrategyRunner already share): cap pre-check ->
           default-on human confirm -> commit (+ the mandatory 0.05% fee leg).
           Nothing auto-signs. A DANGER inspection forces an explicit confirm.
           The kill switch is honored.
      A multi-step plan is surfaced as a PLAN and EACH step gets its OWN confirm
      sheet (one gate_confirm per value-moving call).

  (B) QUERY   ("which bot made money this week?", "what is my net worth?",
              "how much ETH do I have?")
      Answered ONLY from the real engines (portfolio, the bots dashboard / P&L
      ledger, get_balance). The agent runs in a READ-ONLY tool set (every
      value-moving tool stripped from both the offered schemas AND the policy
      allowlist), so a query can NEVER reach a value-moving tool. All numbers
      come from tool/engine results — never fabricated. When a source is
      unavailable the tool reports it so the answer is an honest "unavailable",
      never an invented balance / P&L.

The runner, the policy, and the security gate are UNCHANGED — this module only
orchestrates over them.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member
from . import runner as _runner

DAY_MS = 86400000

CLASSIFY_SYSTEM = (
    "You route a Blockle wallet command bar. Decide whether the user's message is "
    "an ACTION (it asks to move funds: send, swap, trade, rebalance, buy, sell, "
    "provide/remove liquidity, launch or list a token, place/cancel an order) or a "
    "QUERY (it only asks a question about balances, net worth, prices, markets, or "
    "bot performance — nothing moves). Reply with exactly one word: ACTION or QUERY.")

ACTION_SYSTEM = (
    "You are the in-wallet assistant executing a user instruction that moves funds. "
    "Call only the provided tools. Resolve the user's intent into concrete "
    "value-moving tool calls (a \"rebalance\" is a SEQUENCE of swap calls). Use "
    "base-unit integer amounts. The host enforces a per-session spending cap and an "
    "explicit human confirmation on EVERY value-moving call — you cannot bypass or "
    "weaken it, and you must not claim an action succeeded until the tool returns a "
    "result. Never ask for a password, seed phrase, private key, or API key.")

QUERY_SYSTEM = (
    "You answer questions about this Blockle wallet. You may call only READ-ONLY "
    "tools (balances, markets, quotes, net_worth, bots_pnl). You CANNOT move funds. "
    "Every number in your answer must come from a tool result — never invent a "
    "balance, price, or P&L. If a tool reports a source is unavailable, say so "
    "honestly rather than guessing.")


def _jstr(v: Any) -> str:
    return json.dumps(v, default=str)


def _tool_result(call, obj, is_error=False) -> Dict[str, Any]:
    return {"id": call.get("id"), "name": call.get("name"),
            "content": _jstr(obj), "isError": bool(is_error)}


class _QueryRegistry:
    """The query-time registry: the EXISTING read-only tools + the read-only
    engine tools (net_worth, bots_pnl). ``schemas()`` offered to the model EXCLUDE
    every value-moving tool; ``value_moving_names()`` still names them so the
    read-only allowlist strips them (defense in depth). No value-moving tool is
    reachable during a query."""

    def __init__(self, existing, engine_tools: List[Dict[str, Any]]):
        self._existing = existing
        self._engine = engine_tools
        self._engine_by_name = {t["name"]: t for t in engine_tools}
        self._vm = set(existing.value_moving_names() if hasattr(existing, "value_moving_names") else [])
        self.all = list(getattr(existing, "all", []) or []) + engine_tools

    def get(self, name):
        return self._engine_by_name.get(name) or self._existing.get(name)

    def names(self):
        return list(self._existing.names()) + [t["name"] for t in self._engine]

    def schemas(self):
        base = [s for s in self._existing.schemas() if s.get("name") not in self._vm]
        return base + [{"name": t["name"], "description": t.get("description"),
                        "parameters": t.get("parameters")} for t in self._engine]

    def value_moving_names(self):
        return list(self._vm)

    def readonly_names(self):
        """The names the model may actually call during a query — the offered
        (non-value-moving) tools + the engine tools. Fed to the runner as its
        allowlist so a misbehaving model that proposes `send`/`swap` is rejected
        by the allowlist, never reaching a commit path."""
        return [s["name"] for s in self.schemas()]


class CommandRouter:
    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        if not deps.get("provider"):
            raise ValueError("command router requires a provider")
        if not deps.get("tools"):
            raise ValueError("command router requires a tools registry")
        if not deps.get("policy"):
            raise ValueError("command router requires a policy")
        self.provider = deps["provider"]
        self.tools = deps["tools"]
        self.policy = deps["policy"]
        self.audit = deps.get("audit")
        self.pnl = deps.get("pnl")
        self.wallet = deps.get("wallet")
        self.channel = deps.get("channel")
        on_event = deps.get("onEvent")
        self.on_event = on_event if callable(on_event) else None
        self.max_turns = deps.get("maxTurns") or 8
        self.default_chain = deps.get("defaultChain") or "ethereum"

        # name resolution: addressbook.resolve_name(input, chain, ctx)
        rn = deps.get("resolveName")
        if callable(rn):
            self.resolve_name_fn = rn
        else:
            book = deps.get("addressBook")
            self.resolve_name_fn = (book.resolve_name if book is not None
                                    and callable(getattr(book, "resolve_name", None)) else None)
        self.name_ctx = deps.get("nameCtx") or {}  # {resolveEns, resolveSns, book}

        # real read engines for queries (all READ-ONLY, no money path):
        #   engines["netWorth"]() -> portfolio result | None
        #   engines["botsPnl"]({sinceMs, days}) -> {bots:[...], realizedUsd} | None
        self.engines = deps.get("engines") or {}
        now = deps.get("now")
        self._now = now if callable(now) else None

        # the ONE gate (runner module) — UNCHANGED. dispatch_prepared is the single
        # commit path shared with the NL Runner + StrategyRunner.
        self.runner_mod = deps.get("runnerModule") or _runner
        if not callable(getattr(self.runner_mod, "dispatch_prepared", None)):
            raise ValueError("command router requires the runner's dispatch_prepared gate")

    # ---- helpers -------------------------------------------------------------
    def now_ms(self) -> int:
        if self._now is not None:
            return int(self._now())
        import time
        return int(time.time() * 1000)

    def emit(self, ev: Dict[str, Any]) -> None:
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:
                pass

    # ---- entry point ---------------------------------------------------------
    async def run(self, text: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        self.policy.assert_live()
        if self.audit:
            try:
                await maybe_await(self.audit.record({"type": "command", "text": text}))
            except Exception:
                pass
        self.emit({"type": "command", "text": text})

        intent = opts.get("intent") or (await self.classify(text))
        self.emit({"type": "intent", "intent": intent})
        if intent == "action":
            return await self.run_action(text, opts)
        return await self.run_query(text, opts)

    # ---- intent classification ----------------------------------------------
    # Ask the agent with NO tools offered (nothing can move during classify). Fail
    # SAFE: anything ambiguous is treated as a read-only QUERY — the router never
    # auto-escalates to an action.
    async def classify(self, text: str) -> str:
        resp = None
        try:
            resp = await maybe_await(self.provider.turn({
                "system": CLASSIFY_SYSTEM,
                "messages": [{"role": "user", "text": text}],
                "tools": [],
            }))
        except Exception:
            resp = None
        if resp and isinstance(resp, dict) and isinstance(resp.get("intent"), str):
            return "action" if resp["intent"].lower() == "action" else "query"
        t = str((resp or {}).get("text") or "").strip().lower() if isinstance(resp, dict) else ""
        import re
        if re.search(r"\baction\b", t):
            return "action"
        return "query"

    # =========================================================================
    # (A) ACTION — propose value-moving tool calls, resolve names, dispatch EACH
    #     through the ONE gate (prepare + dispatch_prepared). Nothing bypasses it.
    # =========================================================================
    async def run_action(self, text: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        # the full catalog is allowed here; every value move is still gated.
        self.policy.set_allowlist(self.tools.names())

        messages: List[Dict[str, Any]] = [{"role": "user", "text": text}]
        steps: List[Dict[str, Any]] = []
        last_text = None

        for _turn in range(self.max_turns):
            self.policy.assert_live()
            resp = await maybe_await(self.provider.turn({
                "system": opts.get("system") or ACTION_SYSTEM,
                "messages": messages,
                "tools": self.tools.schemas(),
            }))
            last_text = resp.get("text") or last_text
            if resp.get("text"):
                self.emit({"type": "text", "text": resp["text"]})

            calls = resp.get("toolCalls") or []
            if len(calls) == 0:
                messages.append({"role": "assistant", "text": resp.get("text")})
                return {"intent": "action", "text": resp.get("text"), "steps": steps,
                        "stopped": False, "reason": "end_turn"}
            messages.append({"role": "assistant", "text": resp.get("text"), "toolCalls": calls})

            # Surface the whole proposed PLAN before running any step. Each
            # value-moving step still gets its OWN confirm sheet below.
            plan = [self._describe_step(c, i) for i, c in enumerate(calls)]
            if plan:
                self.emit({"type": "plan", "steps": plan})

            results = []
            for call in calls:
                self.policy.assert_live()
                try:
                    results.append(await self._execute_action(call, steps))
                except Exception as e:
                    if getattr(e, "halted", False):  # kill -> stop the whole plan
                        if self.audit:
                            try:
                                await maybe_await(self.audit.record({"type": "halted"}))
                            except Exception:
                                pass
                        return {"intent": "action", "text": last_text, "steps": steps,
                                "stopped": True, "reason": "killed"}
                    # a throw before a step was registered (allowlist / unknown tool).
                    self.emit({"type": "step_error", "name": call.get("name"), "error": str(e)})
                    steps.append({"name": call.get("name"), "status": "error", "error": str(e)})
                    results.append(_tool_result(call, {"error": str(e)}, True))
            messages.append({"role": "tool", "results": results})
        return {"intent": "action", "text": last_text, "steps": steps,
                "stopped": True, "reason": "max_turns"}

    @staticmethod
    def _describe_step(call, i) -> Dict[str, Any]:
        return {"index": i, "action": call.get("name"), "args": call.get("arguments") or {}}

    async def _execute_action(self, call, steps) -> Dict[str, Any]:
        name = call.get("name")
        if self.audit:
            try:
                await maybe_await(self.audit.record({"type": "tool_call", "name": name,
                                                     "args": call.get("arguments")}))
            except Exception:
                pass
        self.policy.check_allowed(name)  # raises ToolNotAllowed (recoverable)
        tool = self.tools.get(name)
        if not tool:
            raise ValueError("unknown tool: " + str(name))

        # read-only tool proposed in an action plan (e.g. a quote lookup): run it.
        if not tool.get("valueMoving"):
            res = await maybe_await(tool["run"](call.get("arguments") or {}))
            return _tool_result(call, res, False)

        # value-moving: register the step up front, then RESOLVE any name FIRST and
        # substitute the resolved address so the inspected / confirmed / sent address
        # is the resolved one — never the raw typed name.
        args = dict(call.get("arguments") or {})
        step = {"name": name, "status": "pending", "args": args}
        steps.append(step)
        try:
            resolved = await self._resolve_recipient(name, args)
            if resolved:
                step["resolved"] = resolved
            step["args"] = dict(args)  # reflect the substituted address
            self.emit({"type": "step", "action": name, "args": args, "resolved": resolved})

            # THE gate — tool.prepare() then runner.dispatch_prepared (the single
            # commit path). Cap check, default-on confirm, danger forces confirm,
            # kill honored, 0.05% fee leg. No second broadcast path exists.
            self.policy.assert_live()
            prep = await maybe_await(tool["prepare"](args))
            self.emit({"type": "prepared", "name": name, "summary": prep.get("summary")})
            disp = await self.runner_mod.dispatch_prepared(
                self.policy, self.audit, lambda ev: self.emit(ev), name, prep, pnl=self.pnl)
            if not disp.get("approved"):
                step["status"] = "declined"
                step["reason"] = "user declined confirmation"
                return _tool_result(call, {"rejected": True, "reason": "user declined confirmation",
                                           "summary": disp.get("summary")}, False)
            res = disp.get("result")
            txid = None
            if isinstance(res, dict):
                txid = res.get("txid")
                if not txid and isinstance(res.get("settlement"), dict):
                    txid = res["settlement"].get("txid")
            step["status"] = "committed"
            step["result"] = {"txid": txid}
            agent_fee = disp.get("agentFee")
            if agent_fee and isinstance(res, dict):
                out = dict(res)
                out["agentFee"] = agent_fee
            else:
                out = res
            return _tool_result(call, out, False)
        except Exception as e:
            if getattr(e, "halted", False):
                raise  # propagate kill
            # a cap breach / name-resolution failure / build error: mark THIS step
            # and report back to the model as a tool error. Nothing committed.
            step["status"] = "error"
            step["error"] = str(e)
            self.emit({"type": "step_error", "name": name, "error": str(e)})
            return _tool_result(call, {"error": str(e)}, True)

    # Resolve the recipient name for a `send` to a concrete address and MUTATE the
    # args in place so the resolved address is what gets inspected/confirmed/sent.
    # A name that does not resolve is a HARD error — we never send to an unverified
    # raw name. Non-send value tools have no recipient name to resolve.
    async def _resolve_recipient(self, name, args) -> Optional[Dict[str, Any]]:
        if name != "send":
            return None
        input_ = args.get("to")
        if not input_:
            return None
        chain = args.get("chain") or self.default_chain
        if not callable(self.resolve_name_fn):
            # no resolver wired: proceed with whatever the model proposed (a
            # concrete address). No name -> address substitution is possible.
            return None
        res = None
        try:
            res = await maybe_await(self.resolve_name_fn(input_, chain, self.name_ctx))
        except Exception:
            res = None
        if not res or not res.get("address"):
            raise ValueError('could not resolve recipient "' + str(input_) + '" on ' + str(chain) +
                             " — refusing to send to an unverified name")
        args["to"] = res["address"]  # substitute the RESOLVED address
        self.emit({"type": "resolved", "input": input_, "address": res["address"],
                   "source": res.get("source")})
        return {"input": input_, "address": res["address"], "source": res.get("source")}

    # =========================================================================
    # (B) QUERY — the agent runs in the READ-ONLY tool set (value tools stripped
    #     from both schemas AND the allowlist). Answers come only from real
    #     engines + read-only tools.
    # =========================================================================
    async def run_query(self, text: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        tools = self._query_registry()
        runner = self.runner_mod.create({
            "provider": self.provider,
            "tools": tools,
            "policy": self.policy,
            "audit": self.audit,
            "system": opts.get("system") or QUERY_SYSTEM,
            "maxTurns": self.max_turns,
            # enforce read-only BY CAPABILITY: only the offered (non-value-moving)
            # tool names + engine tools are on the allowlist, so a proposed
            # send/swap is rejected by the allowlist before any commit path.
            "allowlist": tools.readonly_names(),
            "onEvent": lambda ev: self.emit(ev),
        })
        r = await runner.run(text, opts)
        return {"intent": "query", "text": r.get("text"),
                "stopped": r.get("stopped"), "reason": r.get("reason")}

    def _query_registry(self) -> _QueryRegistry:
        return _QueryRegistry(self.tools, self._engine_tools())

    # Read-only engine tools backed by the REAL engines. Each reports
    # ``available: False`` (never a fabricated number) when its engine is not
    # wired or returns nothing, so the model answers honestly.
    def _engine_tools(self) -> List[Dict[str, Any]]:
        self_ref = self

        async def _net_worth(_a=None):
            fn = self_ref.engines.get("netWorth")
            if not callable(fn):
                return {"available": False, "reason": "net-worth engine not available in this wallet"}
            r = None
            try:
                r = await maybe_await(fn())
            except Exception:
                r = None
            if r is None:
                return {"available": False, "reason": "net worth is currently unavailable"}
            return {
                "available": True,
                "totalUsd": r.get("totalUsd") if r.get("totalUsd") is not None else None,
                "byChain": r.get("byChain"),
                "unpriced": r.get("unpriced"),
                "asOf": r.get("asOf"),
            }

        async def _bots_pnl(a=None):
            fn = self_ref.engines.get("botsPnl")
            if not callable(fn):
                return {"available": False, "reason": "bot P&L engine not available in this wallet"}
            a = a or {}
            days = 7
            try:
                if a.get("days") is not None and float(a["days"]) == float(a["days"]):
                    days = float(a["days"])
            except (TypeError, ValueError):
                days = 7
            since_ms = self_ref.now_ms() - int(days * DAY_MS)
            r = None
            try:
                r = await maybe_await(fn({"sinceMs": since_ms, "days": days}))
            except Exception:
                r = None
            if r is None:
                return {"available": False, "reason": "bot P&L is currently unavailable"}
            out = {"available": True, "windowDays": days, "sinceMs": since_ms}
            out.update(r)
            return out

        return [
            {
                "name": "net_worth",
                "valueMoving": False,
                "description": "This wallet's total net worth in USD across all chains, from the "
                               "portfolio engine. Read-only.",
                "parameters": {"type": "object", "properties": {}},
                "run": _net_worth,
            },
            {
                "name": "bots_pnl",
                "valueMoving": False,
                "description": "Per-bot realized and unrealized P&L from the bots dashboard + P&L "
                               "ledger. Optional `days` window (default 7, i.e. \"this week\"). Read-only.",
                "parameters": {"type": "object",
                               "properties": {"days": {"type": "number",
                                                       "description": "lookback window in days (default 7)"}}},
                "run": _bots_pnl,
            },
        ]


def create(deps: Optional[Dict[str, Any]] = None) -> CommandRouter:
    return CommandRouter(deps)
