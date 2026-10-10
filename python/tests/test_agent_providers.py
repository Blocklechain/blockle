"""LLM provider adapter tests — Python parity port of the provider portion of
``blockle-extension/agent/agent.test.js``.

Locks tool-call NORMALIZATION (Claude tool_use blocks and OpenAI function
tool_calls both map to the internal ``{id,name,arguments}`` shape, with the
request body carrying the schema + round-tripped history), the credential
requirement (never silently absent), and the kill-time credential WIPE invariant
(``provider.wipe()`` and the runner dropping the key on kill).

Transport is injected as the Python ``request({method,url,headers,body}) ->
parsed_json`` contract (what ``multichain.venues.default_request`` wraps).
"""

from __future__ import annotations

import asyncio
import json

import pytest

from blockle.agent import index as agent_index
from blockle.agent import providers as providers_mod


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------- claude normalization

def test_provider_claude_maps_tool_use_blocks():
    seen = {}

    async def fake_request(req):
        seen["url"] = req["url"]
        seen["headers"] = req["headers"]
        seen["body"] = req["body"]
        return {"content": [{"type": "text", "text": "ok"},
                            {"type": "tool_use", "id": "u1", "name": "send",
                             "input": {"amount": "5"}}]}

    p = providers_mod.create({"provider": "claude", "apiKey": "sk-test", "request": fake_request})
    out = run(p.turn({
        "system": "s",
        "messages": [{"role": "user", "text": "hi"}],
        "tools": [{"name": "send", "description": "d", "parameters": {"type": "object", "properties": {}}}],
    }))
    assert seen["url"].endswith("/v1/messages")
    assert seen["headers"]["x-api-key"] == "sk-test"
    assert seen["headers"]["anthropic-dangerous-direct-browser-access"] == "true"
    assert seen["body"]["tools"][0]["input_schema"]["type"] == "object"
    assert out["text"] == "ok"
    assert out["toolCalls"][0]["name"] == "send"
    assert out["toolCalls"][0]["arguments"] == {"amount": "5"}


# --------------------------------------------------------- openai normalization

def test_provider_openai_maps_function_tool_calls_and_roundtrips_history():
    sent = {}

    async def fake_request(req):
        sent["body"] = req["body"]
        return {"choices": [{"message": {"content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "swap",
                          "arguments": '{"from":"BLOCK","to":"USDC","amount":"3"}'}}]}}]}

    p = providers_mod.create({"provider": "openai", "apiKey": "sk", "request": fake_request})
    out = run(p.turn({
        "system": "sys",
        "messages": [
            {"role": "user", "text": "swap"},
            {"role": "assistant", "text": None,
             "toolCalls": [{"id": "c0", "name": "quote", "arguments": {"from": "BLOCK"}}]},
            {"role": "tool", "results": [{"id": "c0", "name": "quote", "content": '{"ok":true}'}]},
        ],
        "tools": [{"name": "swap", "description": "d", "parameters": {"type": "object", "properties": {}}}],
    }))
    assert out["toolCalls"][0]["name"] == "swap"
    assert out["toolCalls"][0]["arguments"] == {"from": "BLOCK", "to": "USDC", "amount": "3"}
    body = sent["body"]
    assert body["messages"][0]["role"] == "system"
    asst = [m for m in body["messages"] if m["role"] == "assistant"][0]
    assert asst["tool_calls"][0]["function"]["name"] == "quote"
    # arguments are stringified on the wire
    assert json.loads(asst["tool_calls"][0]["function"]["arguments"]) == {"from": "BLOCK"}
    tool_role = [m for m in body["messages"] if m["role"] == "tool"][0]
    assert tool_role["tool_call_id"] == "c0"


def test_provider_credential_required_and_unknown_rejected():
    with pytest.raises(ValueError, match="apiKey"):
        providers_mod.create({"provider": "claude"})
    with pytest.raises(ValueError, match="unknown provider"):
        providers_mod.create({"provider": "nope", "apiKey": "x"})


def test_copilot_is_openai_compatible_with_copilot_headers():
    sent = {}

    async def fake_request(req):
        sent["url"] = req["url"]
        sent["headers"] = req["headers"]
        return {"choices": [{"message": {"content": "hello"}}]}

    p = providers_mod.create({"provider": "copilot", "apiKey": "sk", "request": fake_request})
    out = run(p.turn({"system": "s", "messages": [{"role": "user", "text": "hi"}], "tools": []}))
    assert out["text"] == "hello"
    assert "githubcopilot.com" in sent["url"]
    assert sent["headers"]["copilot-integration-id"] == "blockle-wallet"


# ---------------------------------------------------------- credential wipe

def test_wipe_nulls_the_credential():
    p = providers_mod.create({"provider": "claude", "apiKey": "sk-secret"})
    assert p.api_key == "sk-secret"
    p.wipe()
    assert p.api_key is None


def test_runner_kill_wipes_the_provider_credential():
    handle = agent_index.start({
        "credential": {"provider": "claude", "apiKey": "sk-secret"},
        "caps": {"sessionUsd": 10},
        "confirm": lambda s: True,
        "ctx": {},
    })
    assert handle.runner.provider.api_key == "sk-secret"
    run(handle.kill("user"))
    # the audited kill must leave no live LLM credential in memory
    assert handle.runner.provider.api_key is None
