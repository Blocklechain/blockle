"""Multi-channel manager tests — Python parity port of
``blockle-extension/agent/channels.test.js``.

Locks the isolation (caps + kill independent per channel), persistence roundtrip
(records survive a reload + auto-resume, API key NEVER persisted), credential
handling, the RED-3 start guards (value-moving channels need caps + a confirm
handler), lifecycle (stop keeps / delete removes), and per-channel P&L.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from blockle.agent import channels as channels_mod
from blockle.agent import index as agent_index
from blockle.agent.policy import CapExceeded


def run(coro):
    return asyncio.run(coro)


def mem_store():
    data = {}

    class Store:
        _data = data

        async def get(self, keys=None):
            if keys is None:
                return dict(data)
            lst = keys if isinstance(keys, list) else [keys]
            return {k: data[k] for k in lst if k in data}

        async def set(self, obj):
            data.update(obj)

        async def remove(self, keys):
            lst = keys if isinstance(keys, list) else [keys]
            for k in lst:
                data.pop(k, None)

    return Store()


def resolver(mapping):
    async def _resolve(cred_ref, meta=None):
        return mapping.get(cred_ref)
    return _resolve


def base_opts(store, **overrides):
    opts = {
        "store": store,
        "resolveCredential": resolver({"main": {"apiKey": "sk-test", "provider": "claude"}}),
        "confirm": lambda s: True,
        # a USD-capped channel needs ctx.estimateUsd to arm (pricing requirement)
        "ctxFor": lambda meta: {"estimateUsd": lambda a, x: 1.0},
        "agentFactory": agent_index.Agent,
    }
    opts.update(overrides)
    return opts


# --------------------------------------------------------------------- guides

def test_provider_guides_present():
    g = channels_mod.PROVIDER_GUIDES
    for key in ("claude", "chatgpt", "copilot", "other"):
        assert g.get(key)
        assert isinstance(g[key]["how"], str) and len(g[key]["how"]) > 10
        assert isinstance(g[key]["url"], str)
        assert isinstance(g[key]["needs"], list)
        assert g[key]["provider"]
    assert "console.anthropic.com" in g["claude"]["url"]
    assert "platform.openai.com" in g["chatgpt"]["url"]
    assert "github.com" in g["copilot"]["url"]


# ------------------------------------------------------------------ isolation

def test_isolation_caps_do_not_bleed_across_channels():
    mgr = channels_mod.create(base_opts(mem_store()))
    run(mgr.create({"id": "a", "label": "tight", "walletId": "w1", "provider": "claude",
                    "credRef": "main", "caps": {"sessionUsd": 10}, "start": True}))
    run(mgr.create({"id": "b", "label": "loose", "walletId": "w2", "provider": "claude",
                    "credRef": "main", "caps": {"sessionUsd": 1000}, "start": True}))
    a = mgr.get("a")
    b = mgr.get("b")
    with pytest.raises(CapExceeded):
        a.instance.policy.assess_value({"asset": "X", "amount": "1", "usd": 50})
    b.instance.policy.assess_value({"asset": "X", "amount": "1", "usd": 50})  # fine under 1000
    b.instance.policy.record_spend({"asset": "X", "amount": "1", "usd": 900})
    assert a.instance.policy.spent_usd == 0


def test_isolation_killing_one_leaves_others_live():
    killed = []
    mgr = channels_mod.create(base_opts(
        mem_store(), onChannelKill=lambda cid, reason: killed.append(cid)))
    run(mgr.create({"id": "a", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}, "start": True}))
    run(mgr.create({"id": "b", "walletId": "w2", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}, "start": True}))
    a, b = mgr.get("a"), mgr.get("b")
    assert a.running and b.running
    run(a.kill("test"))
    assert a.running is False and a.killed is True and a.instance is None
    assert killed == ["a"]
    assert b.running is True and b.killed is False
    assert b.instance.policy.is_killed() is False


def test_kill_all_stops_every_channel_and_runs_global_hook_once():
    global_kills = {"n": 0}

    async def on_kill(reason):
        global_kills["n"] += 1

    mgr = channels_mod.create(base_opts(mem_store(), onKill=on_kill))
    run(mgr.create({"id": "a", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}, "start": True}))
    run(mgr.create({"id": "b", "walletId": "w2", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}, "start": True}))
    run(mgr.kill_all("panic"))
    assert global_kills["n"] == 1
    for c in mgr.list():
        assert c["running"] is False and c["killed"] is True


# ---------------------------------------------------------------- persistence

def test_persistence_records_survive_reload_and_key_never_stored():
    store = mem_store()
    mgr1 = channels_mod.create(base_opts(store))
    run(mgr1.create({
        "id": "keep", "label": "BLOCK scalper", "walletId": "w9", "accountId": "block",
        "provider": "claude", "model": "claude-sonnet-4-5", "credRef": "main",
        "caps": {"sessionUsd": 25, "perAsset": {"BLOCK": "5000000000"}},
        "config": {"pairs": ["BLOCK/USDC"], "allowlist": ["get_markets", "swap"]},
        "start": True,
    }))
    raw = json.dumps(store._data, default=str)
    assert "BLOCK scalper" in raw
    assert "sk-test" not in raw  # the API key must never be persisted

    mgr2 = channels_mod.create(base_opts(store))
    loaded = run(mgr2.load())
    assert len(loaded) == 1
    c = mgr2.get("keep").describe()
    assert c["label"] == "BLOCK scalper"
    assert c["walletId"] == "w9" and c["accountId"] == "block"
    assert c["provider"] == "claude" and c["model"] == "claude-sonnet-4-5"
    assert c["caps"]["sessionUsd"] == 25
    assert c["caps"]["perAsset"]["BLOCK"] == "5000000000"
    assert c["config"]["pairs"] == ["BLOCK/USDC"]
    assert c["enabled"] is True        # flagged for auto-resume
    assert c["running"] is False       # but not live until resume()


def test_persistence_resume_auto_starts_enabled_channels():
    store = mem_store()
    mgr1 = channels_mod.create(base_opts(store))
    run(mgr1.create({"id": "on", "walletId": "w1", "provider": "claude", "credRef": "main",
                     "caps": {"sessionUsd": 10}, "start": True}))
    run(mgr1.create({"id": "off", "walletId": "w2", "provider": "claude", "credRef": "main",
                     "caps": {"sessionUsd": 10}}))  # never started
    mgr2 = channels_mod.create(base_opts(store))
    run(mgr2.load())
    res = run(mgr2.resume())
    assert res["started"] == ["on"]
    assert mgr2.get("on").running is True
    assert mgr2.get("off").running is False


def test_persistence_resume_skips_channels_whose_credential_is_gone():
    store = mem_store()
    mgr1 = channels_mod.create(base_opts(store))
    run(mgr1.create({"id": "on", "walletId": "w1", "provider": "claude", "credRef": "main",
                     "caps": {"sessionUsd": 10}, "start": True}))
    mgr2 = channels_mod.create(base_opts(store, resolveCredential=resolver({})))
    run(mgr2.load())
    res = run(mgr2.resume())
    assert res["started"] == []
    assert len(res["skipped"]) == 1
    assert res["skipped"][0]["id"] == "on"
    assert "credential" in res["skipped"][0]["reason"]


# --------------------------------------------------------------- start guards

def test_guard_value_moving_refuses_without_caps():
    mgr = channels_mod.create(base_opts(mem_store()))
    run(mgr.create({"id": "nocaps", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {}}))
    with pytest.raises(ValueError, match="caps"):
        run(mgr.start("nocaps"))


def test_guard_value_moving_refuses_without_confirm():
    mgr = channels_mod.create(base_opts(mem_store(), confirm=None))
    run(mgr.create({"id": "noconfirm", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}}))
    with pytest.raises(ValueError, match="confirmation handler"):
        run(mgr.start("noconfirm"))


def test_guard_usd_capped_channel_refuses_without_pricing():
    # the audit-fix guard: a USD-capped channel cannot arm if the ctx can't price.
    mgr = channels_mod.create(base_opts(mem_store(), ctxFor=lambda meta: {}))
    run(mgr.create({"id": "noprice", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}}))
    with pytest.raises(ValueError, match="estimateUsd"):
        run(mgr.start("noprice"))


def test_guard_read_only_may_start_without_caps():
    mgr = channels_mod.create(base_opts(mem_store(), confirm=None))
    run(mgr.create({"id": "ro", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "readOnly": True, "caps": {}}))
    d = run(mgr.start("ro"))
    assert d["running"] is True and d["readOnly"] is True


# ------------------------------------------------------------------ lifecycle

def test_lifecycle_stop_keeps_record_delete_removes_it():
    store = mem_store()
    mgr = channels_mod.create(base_opts(store))
    run(mgr.create({"id": "x", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 10}, "start": True}))
    run(mgr.stop("x"))
    assert mgr.get("x").running is False
    assert mgr.get("x").describe()["enabled"] is False
    assert len(mgr.list()) == 1
    assert run(mgr.delete("x")) is True
    assert mgr.get("x") is None
    assert len(mgr.list()) == 0
    recs = store._data.get(channels_mod.STORE_KEY)
    assert not recs


# ------------------------------------------------------------------------ pnl

def test_pnl_recorded_per_channel_and_persisted():
    store = mem_store()
    mgr = channels_mod.create(base_opts(store))
    run(mgr.create({"id": "p", "walletId": "w1", "provider": "claude", "credRef": "main",
                    "caps": {"sessionUsd": 100}, "start": True}))
    run(mgr.get("p").record_pnl({"realizedUsd": 12.5, "label": "BLOCK/USDC swap"}))
    run(mgr.get("p").record_pnl({"realizedUsd": -3.0, "label": "fee"}))
    assert mgr.get("p").describe()["pnl"]["realizedUsd"] == 9.5
    mgr2 = channels_mod.create(base_opts(store))
    run(mgr2.load())
    assert mgr2.get("p").describe()["pnl"]["realizedUsd"] == 9.5
