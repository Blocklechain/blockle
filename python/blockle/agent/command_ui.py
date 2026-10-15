"""agent/command_ui.py — the NATURAL-LANGUAGE COMMAND BAR render helpers.

Python port of the pure renderers in ``blockle-extension/command-ui.js``. The Qt
wallet surfaces a text input ALONGSIDE the existing agent cockpit (see
``qtmultichain.AgentTab``); this module turns the :class:`command.CommandRouter`
events into transcript lines:

  * the interpreted INTENT (action vs query),
  * for an ACTION, the proposed PLAN (one row per step) and, per step, the
    RESOLVED recipient (name -> address) + the step outcome
    (committed / declined / error),
  * for a QUERY, the answer text.

It adds NO new power and owns NO gate. Every value-moving step is confirmed by
the HOST's shared security confirm sheet — the SAME modal the agent cockpit
already wires into ``policy.gate_confirm`` (through the router the host builds).
This module never signs, never broadcasts, and never shows its own "approve"
control; it only renders what the router reports.

The Qt transcript is a plain-text widget, so these renderers emit plain text
(no markup, hence no injection surface). ``event_text`` is the single
event -> line mapping shared by the mount controller and the tests.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def short(addr: Any) -> str:
    s = str(addr or "")
    return (s[:8] + "…" + s[-6:]) if len(s) > 14 else s


def intent_badge(intent: Any) -> str:
    return "[ACTION]" if intent == "action" else "[QUERY]"


def _step_line(s: Dict[str, Any], i: int) -> str:
    a = s.get("args") or {}
    action = s.get("action")
    if action == "send":
        asset = a.get("asset")
        sym = (asset.get("symbol") if isinstance(asset, dict) else None) or \
            (str(a.get("chain")).upper() if a.get("chain") else "")
        line = f"send {a.get('amount')} {sym} → {short(a.get('to'))}"
    elif action == "swap":
        line = f"swap {a.get('amount')} {a.get('from')} → {a.get('to')}"
    else:
        line = str(action)
    n = (s.get("index") + 1) if s.get("index") is not None else (i + 1)
    return f"  {n}. {line}  (awaiting confirm)"


def plan_text(steps: Optional[List[Dict[str, Any]]]) -> str:
    rows = [_step_line(s, i) for i, s in enumerate(steps or [])]
    return "Plan — each step needs your confirmation\n" + "\n".join(rows)


def resolved_text(ev: Dict[str, Any]) -> str:
    # name -> resolved-address mapping, surfaced so the human verifies WHO gets
    # paid (anti-spoofing). The resolved address is what is confirmed and sent.
    return (f"Resolved {ev.get('input')} → {ev.get('address')} "
            f"({ev.get('source') or 'raw'})")


def step_outcome_text(name: Any, status: Any, detail: Any = None) -> str:
    label = {"committed": "confirmed & sent", "declined": "declined",
             "error": "blocked"}.get(status, str(status))
    s = f"{name}: {label}"
    if detail:
        s += f" — {detail}"
    return s


def answer_text(text: Any) -> str:
    return str(text or "")


def error_text(text: Any) -> str:
    return str(text or "")


def event_text(ev: Optional[Dict[str, Any]]) -> str:
    """Turn ONE router event into a transcript line (or '' to ignore).
    Centralized so the mount controller and tests share the exact mapping."""
    if not ev or not ev.get("type"):
        return ""
    t = ev["type"]
    if t == "intent":
        return intent_badge(ev.get("intent"))
    if t == "plan":
        return plan_text(ev.get("steps"))
    if t == "resolved":
        return resolved_text(ev)
    if t == "text":
        return answer_text(ev.get("text"))
    if t == "declined":
        return step_outcome_text(ev.get("name"), "declined")
    if t == "executed":
        txid = ev.get("txid")
        return step_outcome_text(ev.get("name"), "committed",
                                 (str(txid)[:14] + "…") if txid else None)
    if t in ("step_error", "tool_error"):
        return error_text((ev.get("name") + ": " if ev.get("name") else "") + str(ev.get("error")))
    if t == "killed":
        return error_text("killed — " + str(ev.get("reason") or ""))
    return ""
