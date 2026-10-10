"""agent/policy.py — the MANDATORY, non-bypassable safety layer for the
in-wallet AI agent. Faithful Python port of ``blockle-extension/agent/policy.js``.

Enforced in code, never by prompt. Four rails live here:

  1. Per-session spending caps      (hard-reject over cap; reset only by the user)
  2. Confirmation gate (default-on) (every value-moving action awaits a human OK)
  3. Tool allowlist check           (only named tools may run)
  4. Kill switch                    (abort + revoke session + lock the vault)

Values are tracked two ways, both independently enforced:
  - per-asset cumulative spend, in BASE UNITS (integer-safe)
  - an optional session cap in a USD-equivalent reference number
A value-moving action reports ``{asset, amount, usd?}``. If a session USD cap is
set, an action with no ``usd`` estimate is REJECTED (cannot be verified) — safety
over convenience. Per-asset caps are checked whenever a cap exists for the asset.

HARD REQUIREMENT — pricing for USD-capped channels: because a session USD cap
rejects any action it cannot price, a value-moving channel that carries a
``sessionUsd`` cap is only usable if the host wires ``ctx.estimateUsd`` (so the
tools can attach a ``usd`` to every prepared value). ``channels.ChannelManager``
refuses to arm such a channel when the ctx cannot price. Actions that inherently
lack a USD figure (``launch_token``, ``remove_liquidity``) should instead be
gated with a PER-ASSET cap — under a bare session-USD cap they are, by design,
blocked rather than waved through unpriced.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from ..multichain._util import maybe_await

_INT_RE = re.compile(r"^-?\d+$")


class AgentHalted(Exception):
    """Raised when the agent has been killed — a hard, non-recoverable halt."""

    def __init__(self, msg: str = "agent halted"):
        super().__init__(msg or "agent halted")
        self.halted = True


class CapExceeded(Exception):
    """Raised when a value-moving action would breach a spending cap."""

    def __init__(self, msg: str):
        super().__init__(msg)
        self.cap = True


class ToolNotAllowed(Exception):
    """Raised when the model asks for a tool not on the allowlist."""

    def __init__(self, name: str):
        super().__init__("tool not on allowlist: " + str(name))
        self.tool_name = name


def to_big(v: Any) -> int:
    if isinstance(v, bool):
        raise ValueError("amount must be a base-unit integer string: " + repr(v))
    if isinstance(v, int):
        return v
    if v is None or v == "":
        return 0
    s = str(v).strip()
    if not _INT_RE.match(s):
        raise ValueError("amount must be a base-unit integer string: " + s)
    return int(s)


class Policy:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        caps = opts.get("caps") or {}
        self.caps: Dict[str, Any] = {
            "sessionUsd": float(caps["sessionUsd"]) if caps.get("sessionUsd") is not None else None,
            "perAsset": {},
        }
        for k, v in (caps.get("perAsset") or {}).items():
            self.caps["perAsset"][k] = to_big(v)

        confirm = opts.get("confirm")
        self.confirm_fn = confirm if callable(confirm) else None
        on_kill = opts.get("onKill")
        self.on_kill = on_kill if callable(on_kill) else None
        self.audit = opts.get("audit")
        self.require_confirm = opts.get("requireConfirm") is not False  # default ON
        self.auto_approve_under_usd = (
            float(opts["autoApproveUnderUsd"]) if opts.get("autoApproveUnderUsd") is not None else None)

        self.spent_usd = 0.0
        self.spent_by_asset: Dict[str, int] = {}
        self.killed = False
        self.allowlist: Optional[set] = None

    # ---- allowlist ----------------------------------------------------------
    def set_allowlist(self, names):
        self.allowlist = set(names or [])
        return self

    def check_allowed(self, name: str) -> bool:
        if self.allowlist is not None and name not in self.allowlist:
            raise ToolNotAllowed(name)
        return True

    def is_allowed(self, name: str) -> bool:
        """Non-raising allowlist test (used by the StrategyRunner to drop, rather
        than error on, an Intent whose tool is not on the channel allowlist)."""
        return self.allowlist is None or name in self.allowlist

    # ---- kill switch --------------------------------------------------------
    def is_killed(self) -> bool:
        return self.killed

    def assert_live(self) -> None:
        if self.killed:
            raise AgentHalted("agent killed")

    async def kill(self, reason: Any = None) -> None:
        if self.killed:
            return
        self.killed = True
        if self.audit:
            try:
                await maybe_await(self.audit.record({"type": "kill", "reason": reason or "user"}))
            except Exception:
                pass
        if self.on_kill:
            try:
                await maybe_await(self.on_kill(reason))
            except Exception:
                pass

    # ---- spending caps ------------------------------------------------------
    def assess_value(self, value: Optional[Dict[str, Any]] = None) -> bool:
        value = value or {}
        asset = value.get("asset")
        amount = to_big(value["amount"]) if value.get("amount") is not None else 0
        usd = float(value["usd"]) if value.get("usd") is not None else None

        if asset and self.caps["perAsset"].get(asset) is not None:
            cap = self.caps["perAsset"][asset]
            nxt = self.spent_by_asset.get(asset, 0) + amount
            if nxt > cap:
                raise CapExceeded(
                    f"per-asset cap exceeded for {asset}: would spend {nxt} base units, cap is {cap}")

        if self.caps["sessionUsd"] is not None:
            if usd is None:
                raise CapExceeded(
                    f"session cap is set (${self.caps['sessionUsd']}) but this action has no USD "
                    "estimate — cannot verify, rejecting")
            nxt_usd = self.spent_usd + usd
            if nxt_usd > self.caps["sessionUsd"]:
                raise CapExceeded(
                    f"session USD cap exceeded: would spend ${nxt_usd:.2f}, cap is ${self.caps['sessionUsd']}")
        return True

    def record_spend(self, value: Optional[Dict[str, Any]] = None) -> None:
        value = value or {}
        if value.get("usd") is not None:
            self.spent_usd += float(value["usd"])
        if value.get("asset") and value.get("amount") is not None:
            a = value["asset"]
            self.spent_by_asset[a] = self.spent_by_asset.get(a, 0) + to_big(value["amount"])

    def reset_spend(self) -> None:
        self.spent_usd = 0.0
        self.spent_by_asset = {}

    def set_caps(self, caps: Optional[Dict[str, Any]] = None) -> None:
        caps = caps or {}
        if "sessionUsd" in caps:
            self.caps["sessionUsd"] = float(caps["sessionUsd"]) if caps["sessionUsd"] is not None else None
        for k, v in (caps.get("perAsset") or {}).items():
            self.caps["perAsset"][k] = to_big(v)

    def remaining(self) -> Dict[str, Any]:
        per_asset = {}
        for k, cap in self.caps["perAsset"].items():
            per_asset[k] = str(cap - self.spent_by_asset.get(k, 0))
        return {
            "sessionUsd": (self.caps["sessionUsd"] - self.spent_usd) if self.caps["sessionUsd"] is not None else None,
            "perAsset": per_asset,
        }

    # ---- confirmation gate --------------------------------------------------
    async def gate_confirm(self, summary: Any, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.assert_live()
        meta = meta or {}
        usd = float(meta["usd"]) if meta.get("usd") is not None else None

        if self.auto_approve_under_usd is not None and usd is not None and usd <= self.auto_approve_under_usd:
            return {"approved": True, "auto": True}
        if not self.require_confirm:
            return {"approved": True, "auto": False}
        if not self.confirm_fn:
            return {"approved": False, "auto": False}  # fail closed
        ok = await maybe_await(self.confirm_fn(summary))
        self.assert_live()  # a kill during the await must still block the action
        return {"approved": bool(ok), "auto": False}


def create(opts: Optional[Dict[str, Any]] = None) -> Policy:
    return Policy(opts)
