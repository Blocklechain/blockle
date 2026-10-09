"""agent/runner.py — the natural-language loop. Faithful Python port of
``blockle-extension/agent/runner.js``.

Turns a user instruction into allowlisted wallet/exchange/SDK actions, with the
safety rails enforced AROUND every tool call (not inside the tools, and not by
the model's discretion)::

  prompt -> provider.turn(system, history, allowlisted schemas)
    text      -> emit to the user
    toolCall  -> policy.check_allowed            (allowlist)
                 if valueMoving:
                    tool.prepare()               (build + sign, no broadcast)
                    policy.assess_value()        (hard cap check, trade + fee)
                    policy.gate_confirm(summary) (default-on human confirm)
                    tool.commit()                (broadcast / execute)
                    policy.record_spend()
                    [mandatory fee leg: commit_fee() -> treasury transfer]
                 audit.record() around each step
                 feed tool_result back to provider.turn
  repeat until the model returns a final text answer, max_turns is hit, or the
  user hits the kill switch.

The caps + confirmation gate are applied here by the runner/policy regardless of
how a tool is written — a tool CANNOT opt out. :meth:`kill` aborts the loop,
revokes the session, and locks the vault via ``policy.on_kill``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from ..multichain._util import maybe_await

DEFAULT_SYSTEM = (
    "You are the in-wallet assistant for a Blockle multi-chain wallet. You can "
    "call only the tools provided. Value-moving actions (sends, swaps, orders, "
    "buys, token launches, liquidity, listings) are gated by the host: each is "
    "subject to a per-session spending cap and requires explicit human "
    "confirmation that the host enforces — not you. Do not claim an action "
    "succeeded until the tool returns a result. Never ask the user for their "
    "password, seed phrase, private keys, or API credentials; you do not need "
    "them and must refuse if asked to reveal or transmit them.")


def _jstr(v: Any) -> str:
    return json.dumps(v, default=str)


class Runner:
    def __init__(self, deps: Optional[Dict[str, Any]] = None):
        deps = deps or {}
        if not deps.get("provider"):
            raise ValueError("runner requires a provider")
        if not deps.get("tools"):
            raise ValueError("runner requires a tools registry")
        if not deps.get("policy"):
            raise ValueError("runner requires a policy")
        self.provider = deps["provider"]
        self.tools = deps["tools"]
        self.policy = deps["policy"]
        self.audit = deps.get("audit")
        self.system = deps.get("system") or DEFAULT_SYSTEM
        self.max_turns = deps.get("maxTurns") or 12
        on_event = deps.get("onEvent")
        self.on_event = on_event if callable(on_event) else None

        self.messages = []
        self._aborted = False

        self.policy.set_allowlist(deps.get("allowlist") or self.tools.names())

    def emit(self, ev: Dict[str, Any]) -> None:
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:
                pass

    async def kill(self, reason: Any = None) -> None:
        self._aborted = True
        await self.policy.kill(reason or "kill switch")
        self.emit({"type": "killed", "reason": reason or "kill switch"})

    def _tool_result(self, call, obj, is_error=False) -> Dict[str, Any]:
        return {"id": call.get("id"), "name": call.get("name"),
                "content": _jstr(obj), "isError": bool(is_error)}

    async def _execute(self, call: Dict[str, Any]) -> Dict[str, Any]:
        if self.audit:
            await self.audit.record({"type": "tool_call", "name": call.get("name"),
                                     "args": call.get("arguments")})
        self.emit({"type": "tool_call", "name": call.get("name"), "args": call.get("arguments")})

        self.policy.check_allowed(call.get("name"))  # raises ToolNotAllowed (recoverable)
        tool = self.tools.get(call.get("name"))
        if not tool:
            raise ValueError("unknown tool: " + str(call.get("name")))

        if not tool.get("valueMoving"):
            res = await maybe_await(tool["run"](call.get("arguments") or {}))
            if self.audit:
                await self.audit.record({"type": "executed", "name": call.get("name"), "valueMoving": False})
            return self._tool_result(call, res, False)

        # ---- value-moving path: build -> cap -> confirm -> commit (+ fee) ----
        self.policy.assert_live()
        prep = await maybe_await(tool["prepare"](call.get("arguments") or {}))
        self.emit({"type": "prepared", "name": call.get("name"), "summary": prep.get("summary")})

        fee_value = prep.get("feeValue")

        # hard cap pre-check — trade + mandatory fee must BOTH fit before anything
        # moves (raises CapExceeded -> recoverable tool error).
        self.policy.assess_value(self._with_fee(prep.get("value"), fee_value))
        if self.audit:
            await self.audit.record({"type": "cap_check", "name": call.get("name"),
                                     "value": prep.get("value"), "fee": prep.get("fee"), "ok": True})

        gate = await self.policy.gate_confirm(
            prep.get("summary"), {"usd": self._confirm_usd(prep.get("value"), fee_value)})
        if self.audit:
            await self.audit.record({"type": "confirmation", "name": call.get("name"),
                                     "summary": prep.get("summary"), "approved": gate["approved"],
                                     "auto": bool(gate.get("auto"))})
        if not gate["approved"]:
            self.emit({"type": "declined", "name": call.get("name"), "summary": prep.get("summary")})
            return self._tool_result(call, {"rejected": True, "reason": "user declined confirmation",
                                            "summary": prep.get("summary")}, False)

        self.policy.assert_live()  # a kill during confirm must still block commit
        res = await maybe_await(prep["commit"]())
        self.policy.record_spend(prep.get("value"))
        txid = None
        if isinstance(res, dict):
            txid = res.get("txid")
            if not txid and isinstance(res.get("settlement"), dict):
                txid = res["settlement"].get("txid")
        if self.audit:
            await self.audit.record({"type": "executed", "name": call.get("name"), "valueMoving": True,
                                     "result": res, "txid": txid})
        self.emit({"type": "executed", "name": call.get("name"), "result": res, "txid": txid,
                   "summary": prep.get("summary"), "value": prep.get("value"), "fee": prep.get("fee")})

        # ---- mandatory fee leg: a second treasury send in the SAME action ----
        agent_fee = None
        if prep.get("commitFee") and prep.get("fee"):
            self.policy.assert_live()
            fee_res, fee_err = None, None
            try:
                fee_res = await maybe_await(prep["commitFee"]())
            except Exception as e:
                fee_err = e
            fee_txid = fee_res.get("txid") if isinstance(fee_res, dict) else None
            if fee_value:
                self.policy.record_spend(fee_value)
            fee = prep["fee"]
            agent_fee = {
                "type": "fee", "name": call.get("name"),
                "bps": fee.get("bps"), "chain": fee.get("chain"), "asset": fee.get("asset"),
                "amount": fee.get("amount"), "treasury": fee.get("treasury"), "txid": fee_txid,
            }
            if fee_err:
                agent_fee["error"] = str(fee_err)
            if self.audit:
                await self.audit.record(agent_fee)
            self.emit({"type": "fee", "name": call.get("name"), "fee": agent_fee, "txid": fee_txid})

        # Return a MERGED copy so the model sees the fee without mutating `res`
        # (the recorded 'executed' audit entry holds `res`; mutating it would
        # break the audit hash chain).
        if agent_fee and isinstance(res, dict):
            out = dict(res)
            out["agentFee"] = agent_fee
        else:
            out = res
        return self._tool_result(call, out, False)

    def _with_fee(self, value, fee_value):
        value = value or {"asset": None, "amount": "0", "usd": None}
        if not fee_value:
            return value
        amount = value.get("amount")
        same_asset = fee_value.get("asset") and value.get("asset") and fee_value["asset"] == value["asset"]
        if same_asset and value.get("amount") is not None and fee_value.get("amount") is not None:
            try:
                amount = str(int(str(value["amount"])) + int(str(fee_value["amount"])))
            except Exception:
                pass
        usd = value.get("usd")
        if value.get("usd") is not None or fee_value.get("usd") is not None:
            usd = float(value.get("usd") or 0) + float(fee_value.get("usd") or 0)
        return {"asset": value.get("asset"), "amount": amount, "usd": usd}

    def _confirm_usd(self, value, fee_value):
        a = float(value["usd"]) if value and value.get("usd") is not None else None
        b = float(fee_value["usd"]) if fee_value and fee_value.get("usd") is not None else None
        if a is None and b is None:
            return None
        return float(a or 0) + float(b or 0)

    async def run(self, prompt: str, opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        opts = opts or {}
        signal = opts.get("signal")

        if self.audit:
            await self.audit.record({"type": "prompt", "text": prompt})
        self.emit({"type": "prompt", "text": prompt})
        self.messages.append({"role": "user", "text": prompt})

        last_text = None
        try:
            for _turn in range(self.max_turns):
                self.policy.assert_live()
                if self._aborted or (signal and getattr(signal, "aborted", False)):
                    return {"text": last_text, "stopped": True, "reason": "aborted"}

                resp = await maybe_await(self.provider.turn({
                    "system": self.system,
                    "messages": self.messages,
                    "tools": self.tools.schemas(),
                }))

                last_text = resp.get("text") or last_text
                if resp.get("text"):
                    if self.audit:
                        await self.audit.record({"type": "assistant_text", "text": resp["text"]})
                    self.emit({"type": "text", "text": resp["text"]})

                calls = resp.get("toolCalls") or []
                if len(calls) == 0:
                    self.messages.append({"role": "assistant", "text": resp.get("text")})
                    return {"text": resp.get("text"), "stopped": False, "reason": "end_turn"}

                self.messages.append({"role": "assistant", "text": resp.get("text"), "toolCalls": calls})

                results = []
                for call in calls:
                    self.policy.assert_live()  # halts mid-batch if the user hit kill
                    try:
                        results.append(await self._execute(call))
                    except Exception as e:
                        if getattr(e, "halted", False):
                            raise
                        if self.audit:
                            await self.audit.record({"type": "error", "name": call.get("name"),
                                                     "error": str(e)})
                        self.emit({"type": "tool_error", "name": call.get("name"), "error": str(e)})
                        results.append(self._tool_result(call, {"error": str(e)}, True))
                self.messages.append({"role": "tool", "results": results})
            return {"text": last_text, "stopped": True, "reason": "max_turns"}
        except Exception as e:
            if getattr(e, "halted", False):
                if self.audit:
                    await self.audit.record({"type": "halted"})
                return {"text": last_text, "stopped": True, "reason": "killed"}
            raise

    def reset(self) -> None:
        self.messages = []


def create(deps: Optional[Dict[str, Any]] = None) -> Runner:
    return Runner(deps)
