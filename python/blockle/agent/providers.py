"""agent/providers.py — LLM provider adapters for the in-wallet agent.

Faithful Python port of ``blockle-extension/agent/providers.js``. One interface,
three implementations: Claude (Anthropic Messages API), OpenAI (Chat Completions
function-calling), and a Copilot stub (OpenAI-compatible). Each normalizes the
provider's native tool-call format to the internal shape so ``agent/runner.py``
stays provider-agnostic.

CREDENTIAL HANDLING: the ``apiKey`` comes from the encrypted vault only. It is
used solely to call the chosen provider's own API over TLS, and is NEVER written
to disk unencrypted or sent to any Blockle server. Wiped from memory on
lock/kill.

Internal interface::

    await provider.turn({system, messages, tools}) -> {text?, toolCalls?}

messages: ``[{role:'user', text} | {role:'assistant', text?, toolCalls?} |
           {role:'tool', results:[{id,name,content,isError}]}]``
tools:    ``[{name, description, parameters}]``
toolCalls:``[{id, name, arguments}]``

Transport is injectable. ``request`` (or ``fetchImpl``) is an async/sync callable
``request({method,url,headers,body}) -> parsed_json`` that raises on HTTP errors
(same contract as ``multichain.venues.default_request``). A urllib fallback is
used when none is supplied.
"""

from __future__ import annotations

import json as _json
from typing import Any, Dict, List, Optional

from ..multichain._util import maybe_await
from ..multichain.venues import default_request

DEFAULT_MAX_TOKENS = 4096


class ClaudeProvider:
    def __init__(self, opts: Dict[str, Any]):
        self.name = "claude"
        self.api_key = opts["apiKey"]
        self.model = opts.get("model") or "claude-sonnet-4-5"
        self.base_url = (opts.get("baseUrl") or "https://api.anthropic.com").rstrip("/")
        self.max_tokens = opts.get("maxTokens") or DEFAULT_MAX_TOKENS
        self.version = opts.get("anthropicVersion") or "2023-06-01"
        self._request = default_request(opts.get("request") or opts.get("fetchImpl"))

    def _messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out = []
        for m in messages:
            if m.get("role") == "user":
                out.append({"role": "user", "content": [{"type": "text", "text": m.get("text")}]})
            elif m.get("role") == "assistant":
                content = []
                if m.get("text"):
                    content.append({"type": "text", "text": m["text"]})
                for tc in m.get("toolCalls") or []:
                    content.append({"type": "tool_use", "id": tc["id"], "name": tc["name"],
                                    "input": tc.get("arguments") or {}})
                out.append({"role": "assistant", "content": content})
            elif m.get("role") == "tool":
                content = []
                for r in m.get("results") or []:
                    content.append({
                        "type": "tool_result",
                        "tool_use_id": r["id"],
                        "content": r["content"] if isinstance(r["content"], str) else _json.dumps(r["content"]),
                        "is_error": bool(r.get("isError")),
                    })
                out.append({"role": "user", "content": content})
        return out

    def _build_body(self, system, messages, tools) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": self._messages(messages),
        }
        if system:
            body["system"] = system
        if tools:
            body["tools"] = [{
                "name": t["name"],
                "description": t.get("description"),
                "input_schema": t.get("parameters") or {"type": "object", "properties": {}},
            } for t in tools]
        return body

    @staticmethod
    def _parse(j: Dict[str, Any]) -> Dict[str, Any]:
        text = ""
        tool_calls = []
        for b in (j.get("content") or []):
            if b.get("type") == "text":
                text += b.get("text") or ""
            elif b.get("type") == "tool_use":
                tool_calls.append({"id": b.get("id"), "name": b.get("name"),
                                   "arguments": b.get("input") or {}})
        return {"text": text or None, "toolCalls": tool_calls or None}

    async def turn(self, req: Dict[str, Any]) -> Dict[str, Any]:
        body = self._build_body(req.get("system"), req.get("messages") or [], req.get("tools") or [])
        headers = {
            "content-type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": self.version,
            "anthropic-dangerous-direct-browser-access": "true",
        }
        j = await self._request({"method": "POST", "url": self.base_url + "/v1/messages",
                                 "headers": headers, "body": body})
        return self._parse(j or {})


class OpenAIProvider:
    def __init__(self, opts: Dict[str, Any]):
        self.name = opts.get("name") or "openai"
        self.api_key = opts["apiKey"]
        self.model = opts.get("model") or "gpt-4.1"
        self.base_url = (opts.get("baseUrl") or "https://api.openai.com").rstrip("/")
        self.max_tokens = opts.get("maxTokens") or DEFAULT_MAX_TOKENS
        self.extra_headers = opts.get("extraHeaders") or {}
        self._request = default_request(opts.get("request") or opts.get("fetchImpl"))

    def _messages(self, system, messages) -> List[Dict[str, Any]]:
        out = []
        if system:
            out.append({"role": "system", "content": system})
        for m in messages:
            if m.get("role") == "user":
                out.append({"role": "user", "content": m.get("text")})
            elif m.get("role") == "assistant":
                msg: Dict[str, Any] = {"role": "assistant", "content": m.get("text")}
                if m.get("toolCalls"):
                    msg["tool_calls"] = [{
                        "id": tc["id"], "type": "function",
                        "function": {"name": tc["name"], "arguments": _json.dumps(tc.get("arguments") or {})},
                    } for tc in m["toolCalls"]]
                out.append(msg)
            elif m.get("role") == "tool":
                for r in m.get("results") or []:
                    out.append({
                        "role": "tool", "tool_call_id": r["id"],
                        "content": r["content"] if isinstance(r["content"], str) else _json.dumps(r["content"]),
                    })
        return out

    def _build_body(self, system, messages, tools) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": self._messages(system, messages),
        }
        if tools:
            body["tools"] = [{
                "type": "function",
                "function": {
                    "name": t["name"], "description": t.get("description"),
                    "parameters": t.get("parameters") or {"type": "object", "properties": {}},
                },
            } for t in tools]
        return body

    @staticmethod
    def _parse(j: Dict[str, Any]) -> Dict[str, Any]:
        choices = j.get("choices") or []
        msg = (choices[0].get("message") if choices else {}) or {}
        tool_calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            try:
                args = _json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {"_raw": fn.get("arguments")}
            tool_calls.append({"id": tc.get("id"), "name": fn.get("name"), "arguments": args})
        return {"text": msg.get("content") or None, "toolCalls": tool_calls or None}

    async def turn(self, req: Dict[str, Any]) -> Dict[str, Any]:
        body = self._build_body(req.get("system"), req.get("messages") or [], req.get("tools") or [])
        headers = {"content-type": "application/json", "authorization": "Bearer " + self.api_key}
        headers.update(self.extra_headers)
        j = await self._request({"method": "POST", "url": self.base_url + "/v1/chat/completions",
                                 "headers": headers, "body": body})
        return self._parse(j or {})


class CopilotProvider(OpenAIProvider):
    def __init__(self, opts: Dict[str, Any]):
        merged = dict(opts)
        merged["name"] = "copilot"
        merged["baseUrl"] = opts.get("baseUrl") or "https://api.githubcopilot.com"
        merged["model"] = opts.get("model") or "gpt-4.1"
        extra = {"editor-version": "blockle-wallet/0.1", "copilot-integration-id": "blockle-wallet"}
        extra.update(opts.get("extraHeaders") or {})
        merged["extraHeaders"] = extra
        super().__init__(merged)


def create(opts: Optional[Dict[str, Any]] = None):
    opts = opts or {}
    if not opts.get("apiKey"):
        raise ValueError("provider requires an apiKey (from the vault)")
    provider = opts.get("provider")
    if provider == "claude":
        return ClaudeProvider(opts)
    if provider == "openai":
        return OpenAIProvider(opts)
    if provider == "copilot":
        return CopilotProvider(opts)
    raise ValueError("unknown provider: " + str(provider))
