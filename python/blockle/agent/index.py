"""agent/index.py — wiring facade for the in-wallet AI agent. Faithful Python
port of ``blockle-extension/agent/index.js``.

Assembles the provider adapter, the tool allowlist, the safety policy, the audit
log, and the runner into one handle the UI drives.

The LLM credential comes from the unlocked vault only and is held in memory for
the session; it is wiped on lock/kill. It is sent only to the chosen provider's
API, never to any Blockle server.

Usage::

    agent = Agent.start(
        credential={"provider": "claude", "apiKey": ..., "model": ...},
        caps={"sessionUsd": 50, "perAsset": {"BLOCK": "5000000000"}},
        confirm=async_confirm,          # async/sync -> bool
        onKill=async_lock,              # wipes keys + credential, locks vault
        ctx=wiring,                     # adapters / exchange / sdk / venues
        store=store,                    # audit persistence shim
        onEvent=render_event,
    )
    await agent.run("swap 10 BLOCK for USDC")
    await agent.kill()                  # the always-visible kill switch
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from . import audit as _audit
from . import policy as _policy
from . import providers as _providers
from . import runner as _runner
from . import tools as _tools


class AgentHandle:
    """What :func:`start` returns — the object the UI holds."""

    def __init__(self, runner, policy, audit, tools):
        self.runner = runner
        self.policy = policy
        self.audit = audit
        self.tools = tools

    async def run(self, prompt, opts=None):
        return await self.runner.run(prompt, opts)

    async def kill(self, reason=None):
        return await self.runner.kill(reason)

    def set_caps(self, caps):
        return self.policy.set_caps(caps)

    def reset_spend(self):
        return self.policy.reset_spend()

    def remaining(self):
        return self.policy.remaining()

    def reset(self):
        return self.runner.reset()


def start(opts: Optional[Dict[str, Any]] = None) -> AgentHandle:
    opts = opts or {}
    cred = opts.get("credential") or {}
    if not cred.get("apiKey") or not cred.get("provider"):
        raise ValueError("AI agent is not configured — enable it and add an LLM credential first")

    audit = _audit.create({"store": opts.get("store"), "sink": opts.get("onAudit")})

    policy = _policy.create({
        "caps": opts.get("caps") or {},
        "confirm": opts.get("confirm"),
        "onKill": opts.get("onKill"),
        "audit": audit,
        "requireConfirm": opts.get("requireConfirm") is not False,
        "autoApproveUnderUsd": opts.get("autoApproveUnderUsd"),
    })

    provider = _providers.create({
        "provider": cred["provider"],
        "apiKey": cred["apiKey"],
        "model": cred.get("model") or opts.get("model"),
        "baseUrl": cred.get("baseUrl"),
        "fetchImpl": opts.get("fetchImpl"),
        "request": opts.get("request"),
    })

    tools = _tools.build(opts.get("ctx") or {})

    runner = _runner.create({
        "provider": provider,
        "tools": tools,
        "policy": policy,
        "audit": audit,
        "system": opts.get("system"),
        "maxTurns": opts.get("maxTurns"),
        "allowlist": opts.get("allowlist"),
        "onEvent": opts.get("onEvent"),
    })

    return AgentHandle(runner, policy, audit, tools)


class Agent:
    """Namespace mirroring the JS ``Agent`` global — ``Agent.start(...)``."""

    start = staticmethod(start)
