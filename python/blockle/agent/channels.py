"""agent/channels.py — the multi-CHANNEL manager. Faithful Python port of
``blockle-extension/agent/channels.js``.

A "channel" is one independent agent instance bound to a SPECIFIC wallet/account,
with its OWN provider connection, venue/strategy config, spend/risk caps, kill
switch, audit log, and P&L. A user can run several at once (e.g. a conservative
BTC channel and an aggressive BLOCK channel) and each is fully isolated: a cap
hit or a kill on one never touches another.

Each channel wraps an ``agent/index`` instance (``Agent.start``). The safety
rails from ``agent/policy`` still apply per channel, unchanged — this layer adds
isolation + persistence + lifecycle, it does NOT weaken them.

PERSISTENT CONNECTION: for every channel we persist a small record in the Store
so channels survive a restart and AUTO-RESUME on the next unlock. They stay
connected until the user explicitly stops (disconnects) or deletes them.

CREDENTIAL HANDLING (hard rule): the LLM API key is NEVER persisted here. The
record holds only a ``credRef`` — an opaque pointer the host resolves against the
unlocked vault (``resolveCredential(credRef) -> {provider, apiKey, model?,
baseUrl?}``). The key lives in memory only while the channel is running and is
dropped on stop/kill/lock. Keys are never logged or sent to a Blockle server.
"""

from __future__ import annotations

import random
import string
import time
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await, member
from . import index as _index

STORE_KEY = "agentChannels"

# Sane default caps the host can apply when creating a channel: a value-moving
# channel must have caps before it can start.
DEFAULT_CAPS = {"sessionUsd": 100, "perAsset": {}}

# "How do I get credentials" guidance shown in the UI for each provider, so a
# user can connect a channel without leaving the wallet to hunt for docs.
PROVIDER_GUIDES = {
    "claude": {
        "label": "Claude (Anthropic)",
        "provider": "claude",
        "needs": ["apiKey"],
        "defaultModel": "claude-sonnet-4-5",
        "url": "https://console.anthropic.com/settings/keys",
        "how": ("Sign in to the Anthropic Console, open Settings → API Keys, create a key "
                "(starts with sk-ant-), and paste it here. The key is stored encrypted in your "
                "vault and sent only to api.anthropic.com."),
    },
    "chatgpt": {
        "label": "ChatGPT (OpenAI)",
        "provider": "openai",
        "needs": ["apiKey"],
        "defaultModel": "gpt-4.1",
        "url": "https://platform.openai.com/api-keys",
        "how": ("Sign in to the OpenAI platform, open API keys, create a secret key (starts with "
                "sk-), and paste it here. The key is stored encrypted in your vault and sent only "
                "to api.openai.com."),
    },
    "copilot": {
        "label": "GitHub Copilot",
        "provider": "copilot",
        "needs": ["apiKey"],
        "defaultModel": "gpt-4.1",
        "url": "https://github.com/settings/tokens",
        "how": ("Authorize via GitHub device/OAuth sign-in, or paste a GitHub token that has "
                "Copilot access. The token is stored encrypted in your vault and sent only to the "
                "Copilot endpoint."),
    },
    "other": {
        "label": "Other (OpenAI-compatible)",
        "provider": "openai",
        "needs": ["baseUrl", "model", "apiKey"],
        "defaultModel": "",
        "url": "",
        "how": ("Point at any OpenAI-compatible endpoint: enter the base URL (e.g. https://host/v1 "
                "— your wallet appends /chat/completions), the exact model name, and the API key. "
                "Everything is stored encrypted in your vault and sent only to the base URL you "
                "provide."),
    },
}


def _has_caps(caps: Optional[Dict[str, Any]]) -> bool:
    if not caps:
        return False
    if caps.get("sessionUsd") is not None:
        return True
    if caps.get("perAsset") and len(caps["perAsset"]) > 0:
        return True
    return False


def _rid() -> str:
    return "ch" + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(8))


def _namespaced_store(store, cid):
    """A Store wrapper that prefixes every key with ``ch:<id>:``."""
    if not store:
        return None
    pfx = "ch:" + cid + ":"

    class _NS:
        async def get(self, keys=None):
            if keys is None:
                allv = await maybe_await(store.get(None))
                return {k[len(pfx):]: v for k, v in (allv or {}).items() if k.startswith(pfx)}
            lst = keys if isinstance(keys, list) else [keys]
            got = await maybe_await(store.get([pfx + k for k in lst]))
            out = {}
            for k in lst:
                if (pfx + k) in (got or {}):
                    out[k] = got[pfx + k]
            return out

        async def set(self, obj):
            return await maybe_await(store.set({pfx + k: v for k, v in obj.items()}))

        async def remove(self, keys):
            lst = keys if isinstance(keys, list) else [keys]
            return await maybe_await(store.remove([pfx + k for k in lst]))

    return _NS()


class Channel:
    def __init__(self, manager: "ChannelManager", meta: Dict[str, Any]):
        self.manager = manager
        self.meta = meta           # persisted record (NO apiKey)
        self.instance = None       # Agent.start() handle when running
        self.killed = False
        self.pnl = {"realizedUsd": 0, "tradeCount": 0, "trades": []}
        self.pnl.update(meta.get("pnl") or {})
        self.pnl["trades"] = self.pnl.get("trades") or []

    @property
    def id(self):
        return self.meta["id"]

    @property
    def running(self):
        return self.instance is not None

    def describe(self) -> Dict[str, Any]:
        m = self.meta
        live = self.instance
        return {
            "id": m["id"], "label": m.get("label"), "walletId": m.get("walletId"),
            "accountId": m.get("accountId"), "provider": m.get("provider"), "model": m.get("model"),
            "baseUrl": m.get("baseUrl"), "credRef": m.get("credRef"),
            "enabled": bool(m.get("enabled")), "running": self.running, "killed": self.killed,
            "readOnly": bool(m.get("readOnly")), "config": m.get("config") or {},
            "caps": m.get("caps") or {},
            "pnl": {"realizedUsd": self.pnl["realizedUsd"], "tradeCount": self.pnl["tradeCount"]},
            "remaining": live.remaining() if live and hasattr(live, "remaining") else None,
            "createdAt": m.get("createdAt"),
        }

    async def record_pnl(self, entry: Optional[Dict[str, Any]] = None):
        entry = entry or {}
        if entry.get("realizedUsd") is not None:
            self.pnl["realizedUsd"] += float(entry["realizedUsd"])
        rec = {"ts": int(time.time() * 1000)}
        rec.update(entry)
        self.pnl["trades"].append(rec)
        self.meta["pnl"] = {"realizedUsd": self.pnl["realizedUsd"], "tradeCount": self.pnl["tradeCount"]}
        return await self.manager._persist()

    async def run(self, prompt, opts=None):
        if not self.instance:
            raise ValueError("channel not started: " + self.id)
        return await self.instance.run(prompt, opts)

    async def set_caps(self, caps):
        self.meta["caps"] = {**(self.meta.get("caps") or {}), **(caps or {})}
        if self.instance and hasattr(self.instance, "set_caps"):
            self.instance.set_caps(self.meta["caps"])
        return await self.manager._persist()

    def remaining(self):
        return self.instance.remaining() if self.instance and hasattr(self.instance, "remaining") else None

    def audit(self):
        return self.instance.audit if self.instance else None

    async def kill(self, reason=None):
        self.killed = True
        self.meta["enabled"] = False
        if self.instance:
            try:
                await self.instance.kill(reason or "channel kill")
            except Exception:
                pass
        self.instance = None  # drop the only ref that holds the decrypted key
        await self.manager._persist()


class ChannelManager:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self.store = opts.get("store")
        self.agent_factory = opts.get("agentFactory") or _index.Agent
        rc = opts.get("resolveCredential")
        self.resolve_credential = rc if callable(rc) else None
        cf = opts.get("confirm")
        self.confirm = cf if callable(cf) else None
        ok = opts.get("onKill")
        self.on_kill = ok if callable(ok) else None
        ock = opts.get("onChannelKill")
        self.on_channel_kill = ock if callable(ock) else None
        oe = opts.get("onEvent")
        self.on_event = oe if callable(oe) else None
        cx = opts.get("ctxFor")
        self.ctx_for = cx if callable(cx) else None
        self.defaults = opts.get("defaults") or {}
        self.fetch_impl = opts.get("fetchImpl")
        self.channels: Dict[str, Channel] = {}

    async def load(self):
        recs: List[Dict[str, Any]] = []
        if self.store:
            try:
                got = await maybe_await(self.store.get(STORE_KEY))
                recs = (got or {}).get(STORE_KEY) or []
            except Exception:
                recs = []
        self.channels.clear()
        for rec in recs:
            self.channels[rec["id"]] = Channel(self, rec)
        return self.list()

    async def _persist(self):
        if not self.store:
            return
        recs = [ch.meta for ch in self.channels.values()]
        try:
            await maybe_await(self.store.set({STORE_KEY: recs}))
        except Exception:
            pass

    def list(self):
        return [c.describe() for c in self.channels.values()]

    def get(self, cid):
        return self.channels.get(cid)

    async def create(self, spec: Optional[Dict[str, Any]] = None):
        spec = spec or {}
        if not spec.get("provider"):
            raise ValueError("channel requires a provider")
        if not spec.get("walletId") and not spec.get("accountId"):
            raise ValueError("channel must be bound to a wallet/account (walletId or accountId)")
        guide = PROVIDER_GUIDES.get(spec["provider"])
        read_only = bool(spec.get("readOnly"))
        meta = {
            "id": spec.get("id") or _rid(),
            "label": spec.get("label") or ("Channel " + str(len(self.channels) + 1)),
            "walletId": spec.get("walletId"),
            "accountId": spec.get("accountId"),
            "provider": spec["provider"],
            "model": spec.get("model") or (guide and guide.get("defaultModel")) or self.defaults.get("model"),
            "baseUrl": spec.get("baseUrl"),
            "credRef": spec.get("credRef"),
            "enabled": False,
            "readOnly": read_only,
            "config": spec.get("config") or {},
            # NB: an explicitly-passed {} stays empty (matches JS object truthiness)
            # so a value-moving channel created with no caps refuses to start.
            "caps": spec["caps"] if spec.get("caps") is not None
            else ({} if read_only else dict(DEFAULT_CAPS)),
            "pnl": {"realizedUsd": 0, "tradeCount": 0},
            "createdAt": int(time.time() * 1000),
        }
        if meta["id"] in self.channels:
            raise ValueError("channel already exists: " + meta["id"])
        ch = Channel(self, meta)
        self.channels[meta["id"]] = ch
        await self._persist()
        if spec.get("start"):
            await self.start(meta["id"])
        return ch.describe()

    async def start(self, cid):
        ch = self.channels.get(cid)
        if not ch:
            raise ValueError("no such channel: " + str(cid))
        if ch.instance:
            return ch.describe()

        meta = ch.meta
        ctx = self.ctx_for(meta) if self.ctx_for else (self.defaults.get("ctx") or {})

        # refuse to arm a value-moving channel without caps + a confirm handler.
        if not meta.get("readOnly"):
            if not _has_caps(meta.get("caps")):
                raise ValueError('refusing to start "' + meta["label"]
                                 + '": set spend/risk caps first (value-moving channels require caps)')
            if not self.confirm:
                raise ValueError('refusing to start "' + meta["label"]
                                 + '": a confirmation handler is required for value-moving channels')
            # A session-USD cap rejects any action it cannot price, so a channel
            # under a USD cap is only usable if the ctx can estimate USD. Refuse
            # to arm one that would be dead-on-arrival (every trade rejected as
            # unpriced). Per-asset-only caps don't need pricing.
            if (meta.get("caps") or {}).get("sessionUsd") is not None \
                    and not callable(member(ctx, "estimateUsd")):
                raise ValueError('refusing to start "' + meta["label"]
                                 + '": a USD-capped channel needs ctx.estimateUsd to price '
                                   "actions (wire pricing or use per-asset caps)")

        cred = None
        if self.resolve_credential:
            cred = await maybe_await(self.resolve_credential(meta.get("credRef"), meta))
        if not cred or not cred.get("apiKey"):
            raise ValueError('cannot start "' + meta["label"]
                             + '": no LLM credential available (unlock the wallet and connect this channel)')
        credential = {
            "provider": meta.get("provider") or cred.get("provider"),
            "apiKey": cred["apiKey"],
            "model": meta.get("model") or cred.get("model"),
            "baseUrl": meta.get("baseUrl") or cred.get("baseUrl"),
        }

        async def on_kill(reason):
            if self.on_channel_kill:
                try:
                    await maybe_await(self.on_channel_kill(cid, reason))
                except Exception:
                    pass

        def on_event(ev):
            if ev and ev.get("type") == "executed" and ev.get("txid"):
                ch.pnl["tradeCount"] += 1
                ch.pnl["trades"].append({"ts": int(time.time() * 1000), "name": ev.get("name"),
                                         "txid": ev.get("txid")})
                ch.meta["pnl"] = {"realizedUsd": ch.pnl["realizedUsd"], "tradeCount": ch.pnl["tradeCount"]}
                # fire-and-forget persistence
                try:
                    import asyncio
                    asyncio.ensure_future(self._persist())
                except Exception:
                    pass
            if self.on_event:
                try:
                    self.on_event(cid, ev)
                except Exception:
                    pass

        config = meta.get("config") or {}
        ch.instance = self.agent_factory.start({
            "credential": credential,
            "caps": meta.get("caps") or {},
            "confirm": self.confirm,
            "onKill": on_kill,
            "ctx": ctx,
            "store": _namespaced_store(self.store, cid),
            "onEvent": on_event,
            "model": credential["model"],
            "allowlist": config.get("allowlist") or self.defaults.get("allowlist"),
            "system": config.get("system") or self.defaults.get("system"),
            "maxTurns": config.get("maxTurns") or self.defaults.get("maxTurns"),
            "requireConfirm": None if meta.get("readOnly") else True,
            "autoApproveUnderUsd": config.get("autoApproveUnderUsd"),
            "fetchImpl": self.fetch_impl,
        })
        ch.killed = False
        meta["enabled"] = True
        await self._persist()
        return ch.describe()

    async def stop(self, cid):
        ch = self.channels.get(cid)
        if not ch:
            raise ValueError("no such channel: " + str(cid))
        if ch.instance:
            try:
                ch.instance.reset()
            except Exception:
                pass
        ch.instance = None
        ch.meta["enabled"] = False
        await self._persist()
        return ch.describe()

    async def delete(self, cid):
        ch = self.channels.get(cid)
        if not ch:
            return False
        try:
            await self.stop(cid)
        except Exception:
            pass
        del self.channels[cid]
        await self._persist()
        if self.store:
            try:
                await maybe_await(self.store.remove("ch:" + cid + ":agentAuditLog"))
            except Exception:
                pass
        return True

    async def resume(self):
        started, skipped = [], []
        for ch in list(self.channels.values()):
            if not ch.meta.get("enabled") or ch.instance:
                continue
            try:
                await self.start(ch.id)
                started.append(ch.id)
            except Exception as e:
                skipped.append({"id": ch.id, "reason": str(e)})
        return {"started": started, "skipped": skipped}

    async def kill_all(self, reason=None):
        for ch in list(self.channels.values()):
            try:
                await ch.kill(reason or "kill all")
            except Exception:
                pass
        if self.on_kill:
            try:
                await maybe_await(self.on_kill(reason or "kill all"))
            except Exception:
                pass
        await self._persist()


def create(opts: Optional[Dict[str, Any]] = None) -> ChannelManager:
    return ChannelManager(opts)
