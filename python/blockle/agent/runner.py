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


def _with_fee(value, fee_value):
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


def _confirm_usd(value, fee_value):
    a = float(value["usd"]) if value and value.get("usd") is not None else None
    b = float(fee_value["usd"]) if fee_value and fee_value.get("usd") is not None else None
    if a is None and b is None:
        return None
    return float(a or 0) + float(b or 0)


async def dispatch_prepared(policy, audit, emit, name, prep, pnl=None) -> Dict[str, Any]:
    """The ONE value-moving commit path: cap -> confirm -> commit -> fee -> record.

    Shared by the NL :class:`Runner` and the ``StrategyRunner`` so there is
    exactly one broadcast routine. Takes an already-``prepare()``d tool output
    and the policy/audit; returns ``{approved, result, agentFee}`` (or
    ``{approved: False, summary}`` on decline). Raises ``CapExceeded`` /
    ``AgentHalted`` the same way the inline path used to, for the caller to
    surface as a recoverable tool error or a hard halt.

    ``pnl`` (optional :class:`pnl.RealizedPnl`) is the SINGLE post-commit hook:
    after a trade broadcasts (and its mandatory fee leg runs) it updates the
    cost-basis ledger and pops a realized-profit notification on a positive
    stablecoin exit. It runs only on an approved+committed trade, never on a
    decline/cap/kill, and can never unwind the broadcast — bookkeeping only.
    """
    emit = emit if callable(emit) else (lambda ev: None)
    fee_value = prep.get("feeValue")

    # hard cap pre-check — trade + mandatory fee must BOTH fit before anything
    # moves (raises CapExceeded -> recoverable tool error).
    policy.assess_value(_with_fee(prep.get("value"), fee_value))
    # A fee paid in a DIFFERENT asset than the trade input is NOT covered by the
    # merged check above (that only sums same-asset base units). Verify the fee
    # leg against its OWN per-asset cap too.
    val = prep.get("value") or {}
    if fee_value and fee_value.get("asset") and fee_value.get("asset") != val.get("asset"):
        policy.assess_value({"asset": fee_value.get("asset"),
                             "amount": fee_value.get("amount"),
                             "usd": fee_value.get("usd")})
    if audit:
        await audit.record({"type": "cap_check", "name": name,
                            "value": prep.get("value"), "fee": prep.get("fee"), "ok": True})

    gate = await policy.gate_confirm(prep.get("summary"),
                                     {"usd": _confirm_usd(prep.get("value"), fee_value)})
    if audit:
        await audit.record({"type": "confirmation", "name": name, "summary": prep.get("summary"),
                            "approved": gate["approved"], "auto": bool(gate.get("auto"))})
    if not gate["approved"]:
        emit({"type": "declined", "name": name, "summary": prep.get("summary")})
        return {"approved": False, "summary": prep.get("summary")}

    policy.assert_live()  # a kill during confirm must still block commit
    res = await maybe_await(prep["commit"]())
    policy.record_spend(prep.get("value"))
    txid = None
    if isinstance(res, dict):
        txid = res.get("txid")
        if not txid and isinstance(res.get("settlement"), dict):
            txid = res["settlement"].get("txid")
    if audit:
        await audit.record({"type": "executed", "name": name, "valueMoving": True,
                            "result": res, "txid": txid})
    emit({"type": "executed", "name": name, "result": res, "txid": txid,
          "summary": prep.get("summary"), "value": prep.get("value"), "fee": prep.get("fee")})

    # ---- mandatory fee leg: a second treasury send in the SAME action ----
    agent_fee = None
    if prep.get("commitFee") and prep.get("fee"):
        policy.assert_live()
        fee_res, fee_err = None, None
        try:
            fee_res = await maybe_await(prep["commitFee"]())
        except Exception as e:  # noqa: BLE001 — fee failure must not crash the trade path
            fee_err = e
        fee_txid = fee_res.get("txid") if isinstance(fee_res, dict) else None
        committed = fee_txid is not None and fee_err is None
        # Only accrue the fee against caps when it actually broadcast — a failed
        # fee transfer moved no money and must not be counted as spend.
        if fee_value and committed:
            policy.record_spend(fee_value)
        fee = prep["fee"]
        agent_fee = {
            "type": "fee", "name": name,
            "bps": fee.get("bps"), "chain": fee.get("chain"), "asset": fee.get("asset"),
            "amount": fee.get("amount"), "treasury": fee.get("treasury"), "txid": fee_txid,
        }
        if fee_err:
            agent_fee["error"] = str(fee_err)
        if audit:
            await audit.record(agent_fee)
            if not committed:
                # A trade executed WITHOUT its mandatory fee — surface it loudly.
                await audit.record({"type": "fee_failed", "name": name, "fee": agent_fee,
                                    "error": str(fee_err) if fee_err
                                    else "fee transfer returned no txid"})
        emit({"type": "fee", "name": name, "fee": agent_fee, "txid": fee_txid})
        if not committed:
            emit({"type": "fee_failed", "name": name, "fee": agent_fee})

    # ---- post-commit hook: cost-basis ledger + realized-profit pop-up ----
    # The ONE place the ledger is updated — there is no second path. Runs after
    # the trade (and fee) have broadcast; never raises outward.
    if pnl is not None:
        try:
            await maybe_await(pnl.on_commit(name, prep, res, audit, emit))
        except Exception:  # noqa: BLE001 — bookkeeping must not unwind a broadcast
            pass

    return {"approved": True, "result": res, "agentFee": agent_fee}


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
        self.pnl = deps.get("pnl")
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
        # Actively wipe the LLM credential held by the provider so the key does
        # not linger in memory after a kill, even when the agent is used without
        # the channels layer (which also drops its instance reference).
        wipe = getattr(self.provider, "wipe", None)
        if callable(wipe):
            try:
                wipe()
            except Exception:
                pass
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
        # This is the SINGLE commit path (``dispatch_prepared``), shared verbatim
        # with the StrategyRunner so strategy Intents and NL tool calls route
        # through exactly one broadcast routine — no bypass can exist.
        self.policy.assert_live()
        prep = await maybe_await(tool["prepare"](call.get("arguments") or {}))
        self.emit({"type": "prepared", "name": call.get("name"), "summary": prep.get("summary")})

        disp = await dispatch_prepared(self.policy, self.audit, self.emit, call.get("name"), prep,
                                       pnl=self.pnl)
        if not disp["approved"]:
            return self._tool_result(call, {"rejected": True, "reason": "user declined confirmation",
                                            "summary": disp.get("summary")}, False)

        res, agent_fee = disp["result"], disp.get("agentFee")
        # Return a MERGED copy so the model sees the fee without mutating `res`
        # (the recorded 'executed' audit entry holds `res`; mutating it would
        # break the audit hash chain).
        if agent_fee and isinstance(res, dict):
            out = dict(res)
            out["agentFee"] = agent_fee
        else:
            out = res
        return self._tool_result(call, out, False)

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
