"""The KEYLESS hosted provider + the SAFETY INVARIANT — Python parity port of
``blockle-extension/agent/hosted.test.js`` and conformant to
``docs/hosted-agent-vectors.json``.

Proves:
  * the ``hosted`` provider yields a working ``turn()`` with ONLY a session
    token (no apiKey ever sent), and returns the normalized {text?, toolCalls?}
  * the session is transparently refreshed (re-sign) on a 401
  * ``hosted_session`` runs the challenge -> sign -> verify handshake and yields
    the stored hosted connection record (and the anon fallback)
  * THE INVARIANT: a hosted provider returning a MALICIOUS toolCall is still
    blocked by the CLIENT policy gate (cap/confirm) exactly like a BYO provider
    — the gateway/LLM can never move funds, and a DANGER-severity security
    pre-sign still forces a human confirm even under auto-approve.

Transport is injected as the Python ``request({method,url,headers,body}) ->
parsed_json`` contract (what ``multichain.venues.default_request`` wraps): a
2xx returns the parsed JSON, a >=400 raises an Exception carrying ``.status``
(exactly as ``default_request`` does), so the provider can detect a 401.
"""

from __future__ import annotations

import asyncio

import pytest

from blockle.agent import index as agent_index
from blockle.agent import policy as policy_mod
from blockle.agent import providers as providers_mod
from blockle.agent import runner as runner_mod


def run(coro):
    return asyncio.run(coro)


def req_from_router(router):
    """Build an injectable ``request`` impl from a ``(url, body, n) -> {status, json}``
    router, mirroring the JS ``mockFetch`` but honoring the Python request
    contract (parsed JSON on 2xx, raise with ``.status`` on >=400)."""
    calls = []

    async def request(req):
        body = req.get("body") or {}
        calls.append({"url": req["url"], "headers": req.get("headers") or {}, "body": body})
        r = router(req["url"], body, len(calls))
        status = r.get("status", 200)
        j = r.get("json") or {}
        if status >= 400:
            err = Exception(j.get("error") or j.get("message") or ("HTTP " + str(status)))
            err.status = status
            raise err
        return j

    request.calls = calls
    return request


# ---------------------------------------------------------------------------
# 1. HOSTED PROVIDER — keyless turn()
# ---------------------------------------------------------------------------


def test_hosted_turn_works_with_only_a_session_token_no_apikey():
    def router(url, body, n):
        assert url.endswith("/agent/turn")
        return {"status": 200, "json": {"text": "proposing a swap",
                                        "toolCalls": [{"id": "t1", "name": "swap",
                                                       "arguments": {"amount": "10"}}]}}

    request = req_from_router(router)
    p = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw.test/",
                              "sessionToken": "sess-abc", "request": request})
    out = run(p.turn({"system": "s", "messages": [{"role": "user", "text": "swap 10"}],
                      "tools": [{"name": "swap"}]}))
    assert out["text"] == "proposing a swap"
    assert out["toolCalls"][0]["name"] == "swap"
    # the request carried the sessionToken and NEVER an apiKey
    sent = request.calls[0]["body"]
    assert sent["sessionToken"] == "sess-abc"
    assert "apiKey" not in sent, "hosted turn must not send an apiKey"
    headers = request.calls[0]["headers"]
    assert "x-api-key" not in headers
    assert "authorization" not in headers


def test_hosted_requires_gateway_and_token_never_an_apikey():
    with pytest.raises(ValueError, match="gatewayUrl"):
        providers_mod.create({"provider": "hosted", "sessionToken": "x"})
    with pytest.raises(ValueError, match="sessionToken"):
        providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw"})
    # create() must NOT demand an apiKey for hosted (the BYO guard is bypassed)
    p = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw", "sessionToken": "t"})
    assert p.name == "hosted"


def test_hosted_401_triggers_one_transparent_refresh_and_retry():
    refreshed = {"n": 0}

    def router(url, body, n):
        if body.get("sessionToken") == "stale":
            return {"status": 401, "json": {"error": "expired"}}
        return {"status": 200, "json": {"text": "ok after refresh"}}

    async def refresh():
        refreshed["n"] += 1
        return "fresh"

    p = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw",
                              "sessionToken": "stale", "request": req_from_router(router),
                              "refresh": refresh})
    out = run(p.turn({"system": "s", "messages": [{"role": "user", "text": "hi"}], "tools": []}))
    assert refreshed["n"] == 1
    assert out["text"] == "ok after refresh"
    assert p.session_token == "fresh"


def test_hosted_401_without_refresh_raises():
    def router(url, body, n):
        return {"status": 401, "json": {"error": "invalid or expired session"}}

    p = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw",
                              "sessionToken": "stale", "request": req_from_router(router)})
    with pytest.raises(Exception, match="invalid or expired session"):
        run(p.turn({"system": "s", "messages": [{"role": "user", "text": "hi"}], "tools": []}))


def test_hosted_turn_sends_model_when_set_and_normalizes_defensively():
    def router(url, body, n):
        # gateway omits toolCalls -> provider yields toolCalls=None (not [])
        return {"status": 200, "json": {"text": "just text"}}

    request = req_from_router(router)
    p = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw",
                              "sessionToken": "s", "model": "claude-sonnet-4-5", "request": request})
    out = run(p.turn({"system": "sys", "messages": [], "tools": []}))
    assert out["text"] == "just text"
    assert out["toolCalls"] is None
    assert request.calls[0]["body"]["model"] == "claude-sonnet-4-5"


def test_hosted_wipe_nulls_the_session_token():
    p = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://gw", "sessionToken": "secret"})
    assert p.session_token == "secret"
    p.wipe()
    assert p.session_token is None


# ---------------------------------------------------------------------------
# 2. HOSTED SESSION HANDSHAKE (keyless connect) + the connection record
# ---------------------------------------------------------------------------


def test_hosted_session_challenge_sign_verify_yields_connection_record():
    def router(url, body, n):
        assert url.endswith("/agent/session")
        if body.get("step") == "challenge":
            return {"status": 200, "json": {"challenge": "nonce-123", "expiresAt": 1760000000}}
        if body.get("step") == "verify":
            assert body["challenge"] == "nonce-123"
            assert body["signature"] == "sig-of-nonce-123"
            assert body["publicKey"] == "pub-hex"
            return {"status": 200, "json": {"sessionToken": "tok-1", "expiresAt": 1760000900,
                                            "quota": {"reqPerMin": 20}}}
        raise AssertionError("unexpected step " + str(body.get("step")))

    async def sign(msg):
        return {"signature": "sig-of-" + msg, "publicKey": "pub-hex"}

    sess = run(providers_mod.hosted_session({
        "gatewayUrl": "https://gw.test", "address": "block1abc", "chain": "block",
        "request": req_from_router(router), "sign": sign,
    }))
    assert sess["sessionToken"] == "tok-1"
    assert sess["gatewayUrl"] == "https://gw.test"
    assert sess["address"] == "block1abc"
    assert sess["chain"] == "block"
    assert sess["publicKey"] == "pub-hex"
    assert sess["quota"] == {"reqPerMin": 20}
    assert sess["label"] == "Blockle hosted agent"


def test_hosted_session_anon_fallback_when_no_signer():
    def router(url, body, n):
        assert body.get("step") == "anon"
        return {"status": 200, "json": {"sessionToken": "anon-tok", "expiresAt": 1760000900,
                                        "quota": {"dailyTokenCap": 20000}}}

    sess = run(providers_mod.hosted_session({"gatewayUrl": "https://gw.test",
                                             "request": req_from_router(router)}))
    assert sess["sessionToken"] == "anon-tok"
    assert sess["chain"] == "anon"
    assert sess["quota"] == {"dailyTokenCap": 20000}
    assert sess["label"] == "Blockle hosted (anon)"


def test_hosted_session_bad_signature_surfaces_gateway_error():
    def router(url, body, n):
        if body.get("step") == "challenge":
            return {"status": 200, "json": {"challenge": "nonce"}}
        return {"status": 401, "json": {"error": "signature verification failed"}}

    async def sign(msg):
        return {"signature": "WRONG", "publicKey": "pub"}

    with pytest.raises(Exception, match="signature verification failed"):
        run(providers_mod.hosted_session({"gatewayUrl": "https://gw.test", "address": "block1abc",
                                          "request": req_from_router(router), "sign": sign}))


def test_hosted_session_requires_gateway_url():
    with pytest.raises(ValueError, match="gatewayUrl"):
        run(providers_mod.hosted_session({}))


# A hosted credential record wires straight into the (UNCHANGED) runner via
# index.start — keyless, no apiKey.
def test_index_start_accepts_hosted_credential_and_rejects_incomplete():
    def router(url, body, n):
        return {"status": 200, "json": {"text": "hi from hosted"}}

    handle = agent_index.start({
        "credential": {"provider": "hosted", "gatewayUrl": "https://gw.test",
                       "sessionToken": "tok-A"},
        "caps": {"sessionUsd": 10},
        "confirm": lambda s: True,
        "request": req_from_router(router),
        "ctx": {},
    })
    assert handle.runner.provider.name == "hosted"
    assert handle.runner.provider.session_token == "tok-A"
    # a hosted cred missing the transport fields is rejected (no silent apiKey path)
    with pytest.raises(ValueError, match="hosted agent is not configured"):
        agent_index.start({"credential": {"provider": "hosted"}, "ctx": {}})
    # kill wipes the hosted session token (same wipe invariant as BYO providers)
    run(handle.kill("user"))
    assert handle.runner.provider.session_token is None


# ---------------------------------------------------------------------------
# 3. THE SAFETY INVARIANT — hosted proposals are STILL gated client-side
# ---------------------------------------------------------------------------


class _Tools:
    """A minimal value-moving registry whose single tool's commit() records if
    it ever ran. Mirrors the JS invariant harness tool registry."""

    def __init__(self, committed, prepare_over=None):
        self._committed = committed
        self._prepare_over = prepare_over

    async def _prepare(self, args):
        committed = self._committed

        async def commit():
            committed.append(args)
            return {"txid": "SHOULD_NOT_HAPPEN"}

        prep = {
            "summary": {"action": "send", "to": args.get("to"), "amount": args.get("amount")},
            "value": {"asset": "BLOCK", "amount": str(args.get("amount")),
                      "usd": args["usd"] if args.get("usd") is not None else 1e9},
            "commit": commit,
        }
        if self._prepare_over:
            prep.update(self._prepare_over(args))
        return prep

    def names(self):
        return ["send"]

    def value_moving_names(self):
        return ["send"]

    def schemas(self):
        return [{"name": "send", "description": "send funds", "parameters": {"type": "object"}}]

    def get(self, n):
        if n != "send":
            return None
        return {"name": "send", "valueMoving": True, "prepare": self._prepare}


def _hosted_harness(tool_call_script, prepare_over=None):
    committed = []
    script = list(tool_call_script)

    def router(url, body, n):
        return {"status": 200, "json": script.pop(0) if script else {"text": "done"}}

    provider = providers_mod.create({"provider": "hosted", "gatewayUrl": "https://evil-gw",
                                     "sessionToken": "sess", "request": req_from_router(router)})
    return {"tools": _Tools(committed, prepare_over), "provider": provider, "committed": committed}


def test_invariant_hosted_huge_send_is_hard_rejected_by_client_cap():
    h = _hosted_harness([
        {"text": "I will send everything",
         "toolCalls": [{"id": "t1", "name": "send",
                        "arguments": {"to": "block1attacker", "amount": "99999999999",
                                      "usd": 5000000}}]},
    ])
    policy = policy_mod.create({"caps": {"sessionUsd": 10}, "confirm": lambda s: True})
    runner = runner_mod.create({"provider": h["provider"], "tools": h["tools"],
                                "policy": policy, "maxTurns": 2})
    run(runner.run("do something"))
    # The gateway/LLM PROPOSED a fund-moving call; the CLIENT gate refused it.
    assert h["committed"] == [], "a compromised gateway/LLM must NEVER cause a commit"


def test_invariant_hosted_malicious_call_gated_like_byo_declined_confirm():
    asked = {"n": 0}

    def confirm(summary):
        asked["n"] += 1
        return False

    h = _hosted_harness([
        {"toolCalls": [{"id": "t1", "name": "send",
                        "arguments": {"to": "block1attacker", "amount": "5", "usd": 1}}]},
    ])
    # under cap, but the user DECLINES the mandatory confirmation
    policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "confirm": confirm})
    runner = runner_mod.create({"provider": h["provider"], "tools": h["tools"],
                                "policy": policy, "maxTurns": 2})
    run(runner.run("do something"))
    assert asked["n"] >= 1, "the client confirm gate still runs for a hosted proposal"
    assert h["committed"] == [], "declining the confirm blocks the commit"


def test_invariant_hosted_danger_presign_forces_confirm_under_auto_approve():
    forced = {"summary": None}

    def confirm(summary):
        forced["summary"] = summary
        return False

    h = _hosted_harness(
        [{"toolCalls": [{"id": "t1", "name": "send",
                         "arguments": {"to": "block1attacker", "amount": "1", "usd": 0.01}}]}],
        prepare_over=lambda args: {
            # the tool's prepare() attaches a DANGER inspection (security pre-sign gate)
            "security": {"severity": "danger", "warnings": [{"code": "drainer"}]},
            "forceConfirm": True,
        },
    )
    # auto-approve tiny spends — but a danger inspection must STILL force a confirm
    policy = policy_mod.create({"caps": {"sessionUsd": 1000}, "autoApproveUnderUsd": 100,
                                "confirm": confirm})
    runner = runner_mod.create({"provider": h["provider"], "tools": h["tools"],
                                "policy": policy, "maxTurns": 2})
    run(runner.run("tiny send"))
    assert forced["summary"], "the danger pre-sign forced a human confirm despite auto-approve"
    assert forced["summary"]["security"]["severity"] == "danger"
    assert h["committed"] == []
