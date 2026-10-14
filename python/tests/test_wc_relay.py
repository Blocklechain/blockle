"""test_wc_relay.py — WalletConnect v2 LIVE RELAY TRANSPORT (blockle/multichain/wc_relay.py).

Run: cd python && python -m pytest tests/test_wc_relay.py -q

Python mirror of ``blockle-extension/wc-relay.test.js`` — verifies the HARD parts
of the real transport against the SAME WC v2 spec test vectors as the JS reference
+ the Dart port:
  * the ChaCha20-Poly1305 TYPE-0 envelope (0x00 || nonce(12) || sealbox)
    encrypt->decrypt round-trips, decrypts a KNOWN-VECTOR ciphertext, and rejects
    a tampered tag (NEVER returns forged plaintext);
  * the underlying AEAD matches the RFC 8439 §2.8.2 known-answer vector;
  * the relay-auth JWT is well-formed (EdDSA/JWT header, iss did:key, aud the
    relay url) and its ed25519 signature verifies;
  * the irn JSON-RPC framing matches (irn_subscribe / irn_publish params +
    irn_subscription push handling) driven against a MOCK WebSocket relay, and the
    full pair -> propose -> approve(settle) -> request -> respond -> disconnect
    lifecycle carries encrypted engine payloads correctly.

The transport NEVER holds wallet keys and NEVER signs — it delivers decrypted
proposals/requests to the engine and publishes only what the engine returns.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from blockle.multichain import wc_relay as WR
from blockle.multichain.crypto import ed25519 as Ed
from blockle.multichain import crypto as C


def run(coro):
    return asyncio.run(coro)


# ===========================================================================
# 1. ChaCha20-Poly1305 — RFC 8439 §2.8.2 known-answer + the type-0 envelope
# ===========================================================================
def test_aead_rfc8439_known_answer():
    key = C.hex_to_bytes("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
    nonce = C.hex_to_bytes("070000004041424344454647")
    aad = C.hex_to_bytes("50515253c0c1c2c3c4c5c6c7")
    pt = C.utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one "
                "tip for the future, sunscreen would be it.")
    sealed = C.chacha20poly1305_seal(key, nonce, pt, aad)
    assert C.bytes_to_hex(sealed[:-16]) == (
        "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6"
        "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36"
        "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc"
        "3ff4def08e4b7a9de576d26586cec64b6116")
    assert C.bytes_to_hex(sealed[-16:]) == "1ae10b594f09e26a7e902ecbd0600691"
    opened = C.chacha20poly1305_open(key, nonce, sealed, aad)
    assert C.bytes_to_hex(opened) == C.bytes_to_hex(pt)


def test_envelope_roundtrips_tagged_zero_and_rejects_tamper():
    sym_key = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
    payload = {"id": 7, "jsonrpc": "2.0", "method": "wc_sessionRequest",
               "params": {"chainId": "eip155:1"}}
    env = WR.encode_envelope(sym_key, payload)  # random nonce
    b = WR.b64_to_bytes(env)
    assert b[0] == 0x00, "type-0 prefix"
    assert len(b) >= 1 + 12 + 16
    assert WR.decode_envelope(sym_key, env) == payload

    tampered = bytearray(WR.b64_to_bytes(env))
    tampered[-1] ^= 0x01
    with pytest.raises(ValueError) as ei:
        WR.decode_envelope(sym_key, WR.bytes_to_b64(bytes(tampered)))
    assert "authentication failed" in str(ei.value) or "bad tag" in str(ei.value)


def test_envelope_decrypts_known_vector():
    sym_key = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
    payload = {"id": 1, "jsonrpc": "2.0", "method": "wc_sessionSettle", "params": {"ok": True}}
    KNOWN = ("AAAAAAAAAAAAAAAAASt3/+NjgTP336ojLgb4CyT8w8cwALVOKs0GLdxbwXksCy04"
             "eSP2YLUIwTSAQAlQ6sFXgvp3oH/ht66+sfj14cYvfWGl2nQKxR6LEK5p8crpnmL3Vp7oh0MP")
    regen = WR.encode_envelope(sym_key, payload,
                               lambda _n: C.hex_to_bytes("000000000000000000000001"))
    assert regen == KNOWN, "deterministic type-0 envelope matches the frozen vector"
    assert WR.decode_envelope(sym_key, KNOWN) == payload


# ===========================================================================
# 2. RELAY-AUTH JWT — EdDSA header, iss did:key, aud the relay url, sig verifies
# ===========================================================================
def test_relay_auth_jwt_wellformed_and_verifies():
    seed = C.hex_to_bytes("11" * 32)
    kp = {"secretKey": seed, "publicKey": Ed.public_key(seed)}
    aud = "wss://relay.walletconnect.com"
    token = WR.build_relay_auth({"ed25519": Ed, "keyPair": kp, "aud": aud,
                                 "iat": 1700000000, "ttl": 86400, "sub": "subject-123"})

    parts = token.split(".")
    assert len(parts) == 3

    d = WR.decode_relay_auth(token)
    assert d["header"]["alg"] == "EdDSA"
    assert d["header"]["typ"] == "JWT"
    assert d["payload"]["iss"].startswith("did:key:z")
    assert d["payload"]["aud"] == aud
    assert d["payload"]["sub"] == "subject-123"
    assert d["payload"]["exp"] - d["payload"]["iat"] == 86400

    assert C.bytes_to_hex(d["publicKey"]) == C.bytes_to_hex(kp["publicKey"])
    assert C.bytes_to_hex(WR.ed25519_pub_from_did_key(d["payload"]["iss"])) == C.bytes_to_hex(kp["publicKey"])

    assert Ed.verify(C.utf8(d["signingInput"]), d["signature"], d["publicKey"]) is True
    assert WR.verify_relay_auth(token, Ed) is True

    bad = bytearray(d["signature"])
    bad[0] ^= 0x01
    assert Ed.verify(C.utf8(d["signingInput"]), bytes(bad), d["publicKey"]) is False


# ===========================================================================
# 3. SESSION KEY AGREEMENT — X25519 + HKDF; session topic = sha256(symKey)
# ===========================================================================
def test_session_agreement_x25519_hkdf():
    a = WR.new_x25519_key_pair()
    b = WR.new_x25519_key_pair()
    sa = WR.derive_session(a["privateKey"], b["publicKey"])
    sb = WR.derive_session(b["privateKey"], a["publicKey"])
    assert sa["symKey"] == sb["symKey"], "ECDH + HKDF agree"
    assert sa["topic"] == sb["topic"], "same derived session topic"
    assert len(sa["topic"]) == 64
    assert sa["topic"] == C.bytes_to_hex(C.sha256(C.hex_to_bytes(sa["symKey"])))


# ===========================================================================
# 4. irn FRAMING + the full lifecycle, against a MOCK WebSocket relay
# ===========================================================================
class MockWS:
    """A mock relay WS: captures the connect URL + every sent frame, auto-acks the
    irn_subscribe/irn_publish/irn_unsubscribe calls, and lets a test INJECT an
    irn_subscription push (simulating the dApp's encrypted messages)."""

    state = None  # set per-instance via the factory below

    def __init__(self, url, state):
        self.readyState = 1  # synchronously open (the relay resolves connect immediately)
        self.url = url
        state["url"] = url
        state["instance"] = self
        self._state = state
        self.onopen = self.onmessage = self.onerror = self.onclose = None

    def send(self, s):
        msg = json.loads(s)
        self._state["sent"].append(msg)
        if msg.get("method") == "irn_subscribe":
            self._reply(msg["id"], "sub:" + msg["params"]["topic"])
        elif msg.get("method") == "irn_publish":
            self._reply(msg["id"], True)
        elif msg.get("method") == "irn_unsubscribe":
            self._reply(msg["id"], True)

    def _reply(self, id_, result):
        if self.onmessage:
            self.onmessage(json.dumps({"id": id_, "jsonrpc": "2.0", "result": result}))

    def inject(self, topic, message):
        if self.onmessage:
            self.onmessage(json.dumps({
                "id": 9999, "jsonrpc": "2.0", "method": "irn_subscription",
                "params": {"id": "sub:" + topic,
                           "data": {"topic": topic, "message": message,
                                    "publishedAt": 1, "tag": 0}}}))

    def close(self):
        self.readyState = 3
        if self.onclose:
            self.onclose()


def mock_ws_factory():
    state = {"url": None, "sent": [], "instance": None}

    def factory(url):
        return MockWS(url, state)
    return factory, state


def seq_rand():
    n = [1]

    def rand(length):
        out = bytearray(length)
        for i in range(length):
            out[i] = n[0] & 0xFF
            n[0] = (n[0] * 1103515245 + 12345) & 0x7FFFFFFF
        return bytes(out)
    return rand


async def tick():
    await asyncio.sleep(0.01)


def test_relay_irn_subscribe_framing():
    async def _t():
        factory, state = mock_ws_factory()
        relay = WR.create_relay({"projectId": "proj-123", "WebSocket": factory,
                                 "ed25519": Ed, "randomBytes": seq_rand()})
        pairing_topic = "a" * 64
        sym_key = C.bytes_to_hex(C.hex_to_bytes("22" * 32))
        await relay.pair({"topic": pairing_topic, "symKey": sym_key,
                          "relayProtocol": "irn", "version": 2})

        assert "projectId=proj-123" in state["url"]
        assert "auth=" in state["url"]
        import re
        from urllib.parse import unquote
        auth = unquote(re.search(r"auth=([^&]+)", state["url"]).group(1))
        assert WR.verify_relay_auth(auth, Ed) is True

        sub = next(m for m in state["sent"] if m.get("method") == "irn_subscribe")
        assert sub["jsonrpc"] == "2.0"
        assert list(sub["params"].keys()) == ["topic"]
        assert sub["params"]["topic"] == pairing_topic
    run(_t())


def test_relay_full_lifecycle():
    async def _t():
        factory, state = mock_ws_factory()
        relay = WR.create_relay({"projectId": "p", "WebSocket": factory,
                                 "ed25519": Ed, "randomBytes": seq_rand()})
        pairing_topic = "b" * 64
        pairing_sym_key = C.bytes_to_hex(C.hex_to_bytes("33" * 32))

        proposals = []
        relay.subscribeProposals(lambda p: proposals.append(p))
        requests = []
        relay.subscribeRequests(lambda r: requests.append(r))

        await relay.pair({"topic": pairing_topic, "symKey": pairing_sym_key,
                          "relayProtocol": "irn", "version": 2})
        ws = state["instance"]

        # --- the dApp publishes wc_sessionPropose (encrypted w/ the PAIRING symKey) ---
        dapp = WR.new_x25519_key_pair()
        propose_rpc = {
            "id": 1111, "jsonrpc": "2.0", "method": "wc_sessionPropose",
            "params": {
                "proposer": {"publicKey": dapp["publicKey"],
                             "metadata": {"name": "Test dApp", "url": "https://dapp.example"}},
                "requiredNamespaces": {"eip155": {"chains": ["eip155:1"],
                                                  "methods": ["eth_sendTransaction"], "events": []}},
                "optionalNamespaces": {},
                "relays": [{"protocol": "irn"}],
            },
        }
        ws.inject(pairing_topic, WR.encode_envelope(pairing_sym_key, propose_rpc))
        await tick()

        assert len(proposals) == 1
        proposal = proposals[0]
        assert proposal["pairingTopic"] == pairing_topic
        assert len(proposal["sessionTopic"]) == 64
        assert proposal["proposer"]["publicKey"] == dapp["publicKey"]

        # --- the engine approves: relay responds + settles ---
        state["sent"].clear()
        namespaces = {"eip155": {"chains": ["eip155:1"], "accounts": ["eip155:1:0xabc"],
                                 "methods": ["eth_sendTransaction"], "events": []}}
        await relay.approveProposal(proposal, {"namespaces": namespaces,
                                               "topic": proposal["sessionTopic"]})
        await tick()

        # (a) the propose RESPONSE published on the PAIRING topic — with our responder key
        resp_frame = next(m for m in state["sent"]
                          if m.get("method") == "irn_publish" and m["params"]["topic"] == pairing_topic)
        assert sorted(resp_frame["params"].keys()) == sorted(["message", "prompt", "tag", "topic", "ttl"])
        assert resp_frame["params"]["tag"] == WR.TAG["sessionProposeResponse"]
        resp_payload = WR.decode_envelope(pairing_sym_key, resp_frame["params"]["message"])
        assert resp_payload["id"] == propose_rpc["id"]
        responder_pub = resp_payload["result"]["responderPublicKey"]
        assert responder_pub

        # the dApp derives the SAME session topic the relay subscribed to
        dapp_session = WR.derive_session(dapp["privateKey"], responder_pub)
        assert dapp_session["topic"] == proposal["sessionTopic"]

        # (b) wc_sessionSettle published on the SESSION topic, decryptable + correct
        settle_frame = next(m for m in state["sent"]
                            if m.get("method") == "irn_publish" and m["params"]["topic"] == proposal["sessionTopic"])
        assert settle_frame["params"]["tag"] == WR.TAG["sessionSettle"]
        settle = WR.decode_envelope(dapp_session["symKey"], settle_frame["params"]["message"])
        assert settle["method"] == "wc_sessionSettle"
        assert settle["params"]["namespaces"] == namespaces

        assert any(m.get("method") == "irn_subscribe" and m["params"]["topic"] == proposal["sessionTopic"]
                   for m in state["sent"]), "subscribed the session topic"

        # --- the dApp sends a wc_sessionRequest (encrypted w/ the SESSION symKey) ---
        req_rpc = {
            "id": 2222, "jsonrpc": "2.0", "method": "wc_sessionRequest",
            "params": {"chainId": "eip155:1",
                       "request": {"method": "eth_sendTransaction",
                                   "params": [{"to": "0xdead", "value": "0x1"}]}},
        }
        ws.inject(proposal["sessionTopic"], WR.encode_envelope(dapp_session["symKey"], req_rpc))
        await tick()

        assert len(requests) == 1
        req = requests[0]
        assert req["id"] == req_rpc["id"]
        assert req["topic"] == proposal["sessionTopic"]
        assert req["chainId"] == "eip155:1"
        assert req["method"] == "eth_sendTransaction"
        assert req["params"] == req_rpc["params"]["request"]["params"]

        # --- the engine responds; the relay publishes the (encrypted) result ---
        state["sent"].clear()
        await relay.respond(proposal["sessionTopic"], {"id": req["id"], "result": "0xhash"})
        await tick()
        out_frame = next(m for m in state["sent"]
                         if m.get("method") == "irn_publish" and m["params"]["topic"] == proposal["sessionTopic"])
        assert out_frame["params"]["tag"] == WR.TAG["sessionRequestResponse"]
        out = WR.decode_envelope(dapp_session["symKey"], out_frame["params"]["message"])
        assert out["id"] == req["id"]
        assert out["result"] == "0xhash"

        # --- disconnect publishes wc_sessionDelete + unsubscribes ---
        state["sent"].clear()
        await relay.disconnect(proposal["sessionTopic"], {"code": 6000, "message": "bye"})
        await tick()
        del_frame = next(m for m in state["sent"]
                         if m.get("method") == "irn_publish" and m["params"]["topic"] == proposal["sessionTopic"])
        assert del_frame["params"]["tag"] == WR.TAG["sessionDelete"]
        delete = WR.decode_envelope(dapp_session["symKey"], del_frame["params"]["message"])
        assert delete["method"] == "wc_sessionDelete"
        assert any(m.get("method") == "irn_unsubscribe" and m["params"]["topic"] == proposal["sessionTopic"]
                   for m in state["sent"]), "unsubscribed the session topic"
    run(_t())
