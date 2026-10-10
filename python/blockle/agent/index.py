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

from ..multichain._util import member as _member
from . import audit as _audit
from . import discovery as _discovery
from . import pnl as _pnl
from . import policy as _policy
from . import providers as _providers
from . import runner as _runner
from . import strategy_runner as _strategy_runner
from . import tools as _tools


def _ctx_get(ctx, name):
    """Return a callable ctx accessor by name, or ``None`` (never fabricate)."""
    fn = _member(ctx, name)
    return fn if callable(fn) else None


class AgentHandle:
    """What :func:`start` returns — the object the UI holds."""

    def __init__(self, runner, policy, audit, tools, pnl=None,
                 discovery=None, strategy=None):
        self.runner = runner
        self.policy = policy
        self.audit = audit
        self.tools = tools
        self.pnl = pnl
        # §7: the READ-ONLY candidate feed and the strategy driver wired to it.
        # Both are inert unless a ``discovery`` config was supplied; discovery
        # never trades/signs/allowlists and the strategy driver reuses the ONE
        # gated commit path — so exposing them changes no trading behaviour.
        self.discovery = discovery
        self.strategy = strategy

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

    ctx = opts.get("ctx") or {}
    tools = _tools.build(ctx)

    # The single post-commit cost-basis + realized-profit hook. Prices legs from
    # the host's own ``estimateUsd`` (never a fabricated price) and pops the
    # injectable notifier on a positive stablecoin exit.
    pnl = _pnl.create({
        "ledger": opts.get("ledger"),
        "notifier": opts.get("notifier"),
        "wallet": opts.get("wallet"),
        "channel": opts.get("channel"),
        "priceUsd": _ctx_get(ctx, "estimateUsd"),
        "decimalsOf": _ctx_get(ctx, "decimals"),
        "config": opts.get("pnl") or {},
    })

    runner = _runner.create({
        "provider": provider,
        "tools": tools,
        "policy": policy,
        "audit": audit,
        "pnl": pnl,
        "system": opts.get("system"),
        "maxTurns": opts.get("maxTurns"),
        "allowlist": opts.get("allowlist"),
        "onEvent": opts.get("onEvent"),
    })

    # §7 discovery -> StrategyRunner wiring. Discovery is built ONLY when the
    # caller supplies a ``discovery`` config (otherwise ``None`` — the feed is
    # off and nothing changes). The StrategyRunner takes that discovery plus the
    # ``useDiscovery`` / ``autoConsiderUnapproved`` flags; it reuses the SAME
    # gated commit path as the NL runner, so a discovered-but-unapproved (or
    # non-allowlisted) token still produces a ``blocked`` note — never a trade.
    disc_cfg = opts.get("discovery")
    discovery = (_discovery.create({"ctx": ctx, "config": disc_cfg})
                 if disc_cfg is not None else None)
    strategy = _strategy_runner.create({
        "tools": tools,
        "policy": policy,
        "audit": audit,
        "pnl": pnl,
        "ctx": ctx,
        "mainnetEnabled": opts.get("mainnetEnabled"),
        "onEvent": opts.get("onEvent"),
        "channel": opts.get("channel"),
        "discovery": discovery,
        "useDiscovery": opts.get("useDiscovery"),
        "autoConsiderUnapproved": opts.get("autoConsiderUnapproved"),
    })

    return AgentHandle(runner, policy, audit, tools, pnl,
                       discovery=discovery, strategy=strategy)


class Agent:
    """Namespace mirroring the JS ``Agent`` global — ``Agent.start(...)``."""

    start = staticmethod(start)
