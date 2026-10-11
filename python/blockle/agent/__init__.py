"""blockle.agent — the in-wallet AI trading agent core (Python port).

Mirrors the audited browser extension (``blockle-extension/agent/*.js``) and the
Flutter port (``blockle-app/lib/agent``). The safety rails are enforced in code,
never by the model's discretion:

  * :mod:`~blockle.agent.policy`    — hard spending caps, default-on confirmation
    gate, tool allowlist, kill switch.
  * :mod:`~blockle.agent.audit`     — append-only, SHA-256 hash-chained,
    tamper-evident local action log.
  * :mod:`~blockle.agent.providers` — Claude / OpenAI / Copilot adapters
    normalizing native tool-calls to one internal shape.
  * :mod:`~blockle.agent.tools`     — the fixed tool allowlist (no shell/eval);
    value-moving tools build+sign in ``prepare`` and broadcast in ``commit``.
  * :mod:`~blockle.agent.runner`    — the NL loop: prepare -> assess_value ->
    gate_confirm -> commit -> mandatory fee leg -> record_spend; kill aborts.
  * :mod:`~blockle.agent.channels`  — multi-channel manager (one isolated agent
    per wallet/account), persistent connections, provider credential guides.

Assemble one via :func:`blockle.agent.index.start` (``Agent.start``).
"""

from __future__ import annotations

from . import (arena, audit, bot_runner, bot_templates, bots, channels,
               discovery, index, notify, pnl, policy, providers, runner, tools)
from .index import Agent, start

__all__ = [
    "policy", "audit", "providers", "tools", "runner", "channels", "index",
    "discovery", "pnl", "notify", "bots", "bot_runner", "bot_templates", "arena",
    "Agent", "start",
]
