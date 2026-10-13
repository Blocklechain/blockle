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
# Operator-overridable default for the keyless hosted-agent gateway.
DEFAULT_GATEWAY_URL = "https://agent.blockle.org"


class ClaudeProvider:
    def __init__(self, opts: Dict[str, Any]):
        self.name = "claude"
        self.api_key = opts["apiKey"]
        self.model = opts.get("model") or "claude-sonnet-4-5"
        self.base_url = (opts.get("baseUrl") or "https://api.anthropic.com").rstrip("/")
        self.max_tokens = opts.get("maxTokens") or DEFAULT_MAX_TOKENS
        self.version = opts.get("anthropicVersion") or "2023-06-01"
        self._request = default_request(opts.get("request") or opts.get("fetchImpl"))

    def wipe(self) -> None:
        """Drop the in-memory LLM credential (called on lock/kill)."""
        self.api_key = None

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

    def wipe(self) -> None:
        """Drop the in-memory LLM credential (called on lock/kill)."""
        self.api_key = None

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


class HostedProvider:
    """Blockle HOSTED gateway (keyless). Faithful port of the JS ``HostedProvider``.

    The BRAIN lives on Blockle's server; this provider is a thin transport. It
    POSTs the agent conversation to ``${gatewayUrl}/agent/turn`` with a SESSION
    TOKEN (NOT an ``apiKey`` — the wallet never holds the upstream LLM key) and
    returns the ALREADY-normalized ``{text?, toolCalls?}`` the gateway produces.
    The runner and the client policy gate are UNCHANGED: a hosted proposal is
    gated client-side exactly like a BYO-key proposal — the gateway/LLM can
    never move funds.

    Short-lived sessions are transparently refreshed: on a 401 we call the
    injected ``refresh()`` once (which re-signs the gateway challenge) and retry.
    """

    def __init__(self, opts: Dict[str, Any]):
        self.name = "hosted"
        self.gateway_url = (opts.get("gatewayUrl") or "").rstrip("/")
        if not self.gateway_url:
            raise ValueError("hosted provider requires a gatewayUrl")
        self.session_token = opts.get("sessionToken") or None
        if not self.session_token:
            raise ValueError("hosted provider requires a sessionToken (no apiKey)")
        self.model = opts.get("model") or None
        self._request = default_request(opts.get("request") or opts.get("fetchImpl"))
        # refresh() -> newSessionToken|None; re-signs the challenge on expiry.
        r = opts.get("refresh")
        self.refresh = r if callable(r) else None

    def wipe(self) -> None:
        """Drop the in-memory session token (called on lock/kill)."""
        self.session_token = None

    async def _post(self, payload: Dict[str, Any], attempt: int) -> Dict[str, Any]:
        # NOTE: we send ONLY sessionToken + the conversation. Never an apiKey,
        # never any wallet key/seed. The gateway injects the upstream key
        # server-side.
        body: Dict[str, Any] = {
            "sessionToken": self.session_token,
            "system": payload.get("system"),
            "messages": payload.get("messages"),
            "tools": payload.get("tools"),
        }
        if self.model:
            body["model"] = self.model
        try:
            j = await self._request({"method": "POST", "url": self.gateway_url + "/agent/turn",
                                     "headers": {"content-type": "application/json"}, "body": body})
        except Exception as e:  # noqa: BLE001 — a 401 is a recoverable refresh signal
            if getattr(e, "status", None) == 401 and self.refresh and attempt < 1:
                tok = await maybe_await(self.refresh())
                if tok:
                    self.session_token = tok
                    return await self._post(payload, attempt + 1)
            raise
        j = j or {}
        # The gateway already returns the common shape; re-normalize defensively
        # so the runner always sees {text?, toolCalls?} with the exact field names.
        tool_calls = []
        if isinstance(j.get("toolCalls"), list):
            tool_calls = [{"id": tc.get("id"), "name": tc.get("name"),
                           "arguments": tc.get("arguments") or {}} for tc in j["toolCalls"]]
        return {"text": j.get("text") or None, "toolCalls": tool_calls or None}

    async def turn(self, req: Dict[str, Any]) -> Dict[str, Any]:
        return await self._post({"system": req.get("system"), "messages": req.get("messages"),
                                 "tools": req.get("tools")}, 0)


async def hosted_session(opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Wallet-signature session handshake against the gateway. Faithful port of
    the JS ``hostedSession``.

    ``sign(message)`` is the wallet's own signer — it returns
    ``{signature, publicKey}`` (or a raw signature string) and proves control of
    an address (NOT a spend). Returns the stored hosted connection record.
    """
    opts = opts or {}
    f = default_request(opts.get("request") or opts.get("fetchImpl"))
    base = (opts.get("gatewayUrl") or "").rstrip("/")
    if not base:
        raise ValueError("hostedSession requires a gatewayUrl")
    # Default to "evm" (EIP-191 personal_sign) — the scheme the gateway actually
    # verifies. "block" (ML-DSA) is NOT yet verifiable server-side and always
    # 401s, so it is never the implicit default; callers must opt into it.
    chain = opts.get("chain") or "evm"

    async def post_json(body_obj: Dict[str, Any]) -> Dict[str, Any]:
        j = await f({"method": "POST", "url": base + "/agent/session",
                     "headers": {"content-type": "application/json"}, "body": body_obj})
        return j or {}

    # Anonymous fallback: no address/signer -> rate-limited free-tier token.
    if opts.get("anon") or not opts.get("sign"):
        a = await post_json({"step": "anon"})
        return {"gatewayUrl": base, "sessionToken": a.get("sessionToken"),
                "expiresAt": a.get("expiresAt"), "quota": a.get("quota"), "chain": "anon",
                "label": opts.get("label") or "Blockle hosted (anon)"}

    ch = await post_json({"step": "challenge", "address": opts.get("address"), "chain": chain})
    signed = await maybe_await(opts["sign"](ch.get("challenge")))
    if isinstance(signed, str):
        signature = signed
    elif isinstance(signed, dict):
        signature = signed.get("signature") or signed.get("sig") or ""
    else:
        signature = ""
    public_key = (signed.get("publicKey") if isinstance(signed, dict) else None) \
        or opts.get("publicKey") or ""
    v = await post_json({"step": "verify", "address": opts.get("address"), "chain": chain,
                         "challenge": ch.get("challenge"), "signature": signature,
                         "publicKey": public_key})
    return {
        "gatewayUrl": base,
        "sessionToken": v.get("sessionToken"),
        "expiresAt": v.get("expiresAt"),
        "quota": v.get("quota"),
        "address": opts.get("address"),
        "chain": chain,
        "publicKey": public_key,
        "label": opts.get("label") or "Blockle hosted agent",
    }


def _looks_like_evm_address(addr: Any) -> bool:
    return isinstance(addr, str) and addr.startswith("0x") and len(addr) == 42


async def hosted_connect(opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The "Use Blockle hosted agent" keyless connect — guaranteed to NEVER 401.

    Faithful intent of the extension's ``connectHosted`` but with the scheme the
    gateway actually verifies:

      * PREFER a real per-address session by signing the gateway challenge with
        the wallet's EVM key via EIP-191 ``personal_sign`` (chain ``"evm"`` + the
        0x address + signature). The gateway recovers the signer and checks it
        equals the claimed address, so this verifies and yields a per-address
        token.
      * FALL BACK to the anonymous (rate-limited, keyless) session — ``step:
        "anon"``, no signature — when no EVM key/signer is available, OR if the
        EVM handshake is rejected for any reason. Either way the connect returns
        a usable ``sessionToken`` and never surfaces a 401.

    ``opts`` accepts ``evmSign``/``evmAddress`` (preferred) or the generic
    ``sign``/``address`` pair; a signer is used for EVM only when the address is
    a 0x EVM address. Turns still send ONLY the sessionToken + conversation.
    """
    opts = opts or {}
    base = (opts.get("gatewayUrl") or DEFAULT_GATEWAY_URL or "").rstrip("/")
    request = opts.get("request") or opts.get("fetchImpl")
    label = opts.get("label")
    evm_sign = opts.get("evmSign") or opts.get("sign")
    evm_addr = opts.get("evmAddress") or opts.get("address")

    # Preferred path: a real EVM EIP-191 per-address session.
    if callable(evm_sign) and _looks_like_evm_address(evm_addr):
        try:
            sess = await hosted_session({
                "gatewayUrl": base, "chain": "evm", "address": evm_addr,
                "sign": evm_sign, "request": request, "fetchImpl": opts.get("fetchImpl"),
                "label": label or "Blockle hosted agent",
            })
            if sess.get("sessionToken"):
                return sess
        except Exception:  # noqa: BLE001 — never hard-fail the connect; fall back to anon
            pass

    # Fallback: the anonymous keyless session — no signature, cannot 401 on a bad sig.
    return await hosted_session({
        "gatewayUrl": base, "anon": True, "request": request,
        "fetchImpl": opts.get("fetchImpl"), "label": label,
    })


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
    provider = opts.get("provider")
    # The HOSTED provider is keyless: it needs a gatewayUrl + sessionToken, NOT
    # an apiKey. Every other (BYO-key) provider still requires an apiKey from the
    # vault. This is the ONLY place a provider is instantiated.
    if provider == "hosted":
        return HostedProvider(opts)
    if not opts.get("apiKey"):
        raise ValueError("provider requires an apiKey (from the vault)")
    if provider == "claude":
        return ClaudeProvider(opts)
    if provider == "openai":
        return OpenAIProvider(opts)
    if provider == "copilot":
        return CopilotProvider(opts)
    raise ValueError("unknown provider: " + str(provider))
