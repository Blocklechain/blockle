"""multichain/wc_relay.py — WalletConnect v2 LIVE RELAY TRANSPORT.

Faithful Python port of ``blockle-extension/wc-relay.js`` (the reference ``relay``
client the WalletConnect engine injects; see docs/WALLET-WALLETCONNECT.md §6).

``walletconnect.py`` is PURE given an injected ``relay``. THIS is the real
transport: it opens a WebSocket to the WC v2 relay (``wss://relay.walletconnect.com``
with a projectId query — operator-configurable), authenticates with a relay-auth
JWT signed by an ed25519 client key (``iss`` did:key / ``sub`` / ``aud`` the relay
url, per the WC spec), speaks the ``irn`` JSON-RPC (``irn_subscribe`` /
``irn_publish``, handling ``irn_subscription`` pushes), and encrypts/decrypts every
message with the pairing or session symKey using a ChaCha20-Poly1305 TYPE-0
envelope (``0x00 || nonce(12) || sealbox``) per WC v2.

It NEVER holds wallet keys and NEVER signs a dApp request: it delivers the
decrypted ``session_proposal`` / ``session_request`` to the engine (which runs
the security gate + explicit approval) and publishes only what the engine returns.

Lifecycle (faithful to the WC v2 Sign protocol):
  pair(parsed)         -> subscribe the PAIRING topic (symKey from the URI),
                          await wc_sessionPropose
  <wc_sessionPropose>  -> derive the SESSION topic via X25519 + HKDF, surface
                          the proposal (subscribeProposals) to the UI
  approveProposal(...) -> respond to the propose request + publish
                          wc_sessionSettle on the session topic
  <wc_sessionRequest>  -> subscribeRequests delivers it to the engine
  respond(topic, resp) -> publish the engine's JSON-RPC result/error
  disconnect(topic)    -> publish wc_sessionDelete + unsubscribe

Contract (what walletconnect.py calls): ``pair``, ``approveProposal``,
``rejectProposal``, ``subscribeRequests(cb)``, ``respond(topic, response)``,
``disconnect(topic, reason)``, plus ``subscribeProposals(cb)`` for the UI. PURE
helpers are exported for the spec-vector tests (envelope / relay-auth JWT / irn
framing / session agreement).

Uses ``websockets`` for the live wss relay, ``cryptography`` for the
ChaCha20-Poly1305 envelope + X25519, and ``pynacl`` (via crypto.ed25519) for the
ed25519 relay-auth JWT — all already deps. No official WC SDK exists for Python;
this is the minimal relay client to the same contract + vectors as the JS
reference.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from typing import Any, Callable, Dict, List, Optional

from . import crypto as C
from .crypto import ed25519 as _ed

DEFAULT_RELAY_URL = "wss://relay.walletconnect.com"
RELAY_PROTOCOL = "irn"

# WC v2 engine message tags (the subset the Sign protocol uses here).
TAG = {
    "sessionPropose": 1100, "sessionProposeResponse": 1101,
    "sessionSettle": 1102, "sessionSettleResponse": 1103,
    "sessionRequest": 1108, "sessionRequestResponse": 1109,
    "sessionDelete": 1112,
}
TTL = {"fiveMin": 300, "oneDay": 86400, "thirtySec": 30}


# ---- base64 / base64url ----------------------------------------------------
def bytes_to_b64(b) -> str:
    return base64.b64encode(C.to_bytes(b)).decode("ascii")


def b64_to_bytes(s: str) -> bytes:
    return base64.b64decode(s)


def b64url(data) -> str:
    b = C.utf8(data) if isinstance(data, str) else C.to_bytes(data)
    return bytes_to_b64(b).replace("+", "-").replace("/", "_").rstrip("=")


def b64url_to_bytes(s: str) -> bytes:
    t = str(s).replace("-", "+").replace("_", "/")
    t += "=" * ((4 - len(t) % 4) % 4)
    return b64_to_bytes(t)


def _canonical_json(payload) -> bytes:
    """JSON.stringify-compatible: compact separators, keys in insertion order."""
    if isinstance(payload, str):
        return C.utf8(payload)
    return C.utf8(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))


# ===========================================================================
# TYPE-0 ENVELOPE — 0x00 || nonce(12) || sealbox(ChaCha20-Poly1305, empty aad)
# ===========================================================================
def encode_envelope(sym_key, payload, random_bytes: Optional[Callable[[int], bytes]] = None) -> str:
    key = C.hex_to_bytes(sym_key) if isinstance(sym_key, str) else C.to_bytes(sym_key)
    iv = C.to_bytes(random_bytes(12)) if random_bytes else _random_bytes(12)
    pt = _canonical_json(payload)
    sealbox = C.chacha20poly1305_seal(key, iv, pt)  # empty aad per WC v2
    env = bytes([0x00]) + bytes(iv) + sealbox
    return bytes_to_b64(env)


def decode_envelope(sym_key, b64: str, raw: bool = False):
    key = C.hex_to_bytes(sym_key) if isinstance(sym_key, str) else C.to_bytes(sym_key)
    env = b64_to_bytes(b64)
    if len(env) < 1 + 12 + 16 or env[0] != 0x00:
        raise ValueError("wc-relay: not a type-0 envelope")
    iv = env[1:13]
    sealbox = env[13:]
    pt = C.chacha20poly1305_open(key, iv, sealbox)
    if pt is None:
        raise ValueError("wc-relay: envelope authentication failed (bad tag)")
    text = pt.decode("utf-8")
    if raw:
        return text
    return json.loads(text)


def _random_bytes(n: int) -> bytes:
    return os.urandom(n)


# ===========================================================================
# RELAY-AUTH JWT — EdDSA (ed25519), iss did:key, sub random, aud the relay url
# ===========================================================================
# ed25519 multicodec (0xed 0x01) + base58btc, prefixed 'z' (did:key).
def did_key_from_ed25519_pub(pub) -> str:
    prefixed = bytes([0xED, 0x01]) + C.to_bytes(pub)
    return "did:key:z" + C.base58encode(prefixed)


def ed25519_pub_from_did_key(did: str) -> bytes:
    m = re.match(r"^did:key:z(.+)$", str(did))
    if not m:
        raise ValueError("wc-relay: not a did:key")
    decoded = C.base58decode(m.group(1))
    if decoded[0] != 0xED or decoded[1] != 0x01:
        raise ValueError("wc-relay: did:key is not ed25519")
    return decoded[2:34]


def build_relay_auth(opts: Dict[str, Any]) -> str:
    """buildRelayAuth({ ed25519?, keyPair:{secretKey,publicKey}, aud, sub?, iat?, ttl? })."""
    ed = opts.get("ed25519") or _ed
    kp = opts.get("keyPair") or {}
    secret = kp.get("secretKey") if isinstance(kp, dict) else getattr(kp, "secretKey", None)
    public = kp.get("publicKey") if isinstance(kp, dict) else getattr(kp, "publicKey", None)
    if not ed or secret is None or public is None:
        raise ValueError("wc-relay: relay-auth needs an ed25519 key pair")
    import time
    iat = opts["iat"] if opts.get("iat") is not None else int(time.time())
    ttl = opts["ttl"] if opts.get("ttl") is not None else TTL["oneDay"]
    sub = opts.get("sub") or C.bytes_to_hex(_random_bytes(32))
    header = {"alg": "EdDSA", "typ": "JWT"}
    payload = {"iss": did_key_from_ed25519_pub(public), "sub": sub,
               "aud": opts.get("aud"), "iat": iat, "exp": iat + ttl}
    signing_input = b64url(_canonical_json(header)) + "." + b64url(_canonical_json(payload))
    sig = ed.sign(C.utf8(signing_input), C.to_bytes(secret))
    return signing_input + "." + b64url(sig)


def decode_relay_auth(token: str) -> Dict[str, Any]:
    parts = str(token).split(".")
    if len(parts) != 3:
        raise ValueError("wc-relay: malformed JWT")
    header = json.loads(b64url_to_bytes(parts[0]).decode("utf-8"))
    payload = json.loads(b64url_to_bytes(parts[1]).decode("utf-8"))
    signature = b64url_to_bytes(parts[2])
    public_key = ed25519_pub_from_did_key(payload["iss"])
    return {"header": header, "payload": payload,
            "signingInput": parts[0] + "." + parts[1],
            "signature": signature, "publicKey": public_key}


def verify_relay_auth(token: str, ed25519=None) -> bool:
    ed = ed25519 or _ed
    d = decode_relay_auth(token)
    return bool(ed and ed.verify(C.utf8(d["signingInput"]), d["signature"], d["publicKey"]))


# ===========================================================================
# SESSION KEY AGREEMENT — X25519 + HKDF-SHA256; session topic = sha256(symKey)
# ===========================================================================
def derive_session(self_priv, peer_pub) -> Dict[str, str]:
    priv = C.hex_to_bytes(self_priv) if isinstance(self_priv, str) else C.to_bytes(self_priv)
    pub = C.hex_to_bytes(peer_pub) if isinstance(peer_pub, str) else C.to_bytes(peer_pub)
    shared = C.x25519(priv, pub)
    sym_key = C.hkdf_sha256(shared, None, None, 32)
    topic = C.bytes_to_hex(C.sha256(sym_key))
    return {"symKey": C.bytes_to_hex(sym_key), "topic": topic}


def new_x25519_key_pair(rand: Optional[Callable[[int], bytes]] = None) -> Dict[str, str]:
    priv = C.to_bytes(rand(32)) if rand else _random_bytes(32)
    pub = C.x25519_base(priv)
    return {"privateKey": C.bytes_to_hex(priv), "publicKey": C.bytes_to_hex(pub)}


# ===========================================================================
# the default LIVE WebSocket adapter (websockets) — callback shape the relay
# drives. Tests inject a mock; this is the real wss transport.
# ===========================================================================
class _WebsocketsWS:
    """Wraps ``websockets.connect`` into the callback shape the relay drives
    (onopen / onmessage / onerror / onclose + send/close). Spawns one pump task
    that forwards inbound frames to ``onmessage``. Live path only — never hit by
    the injected-mock spec vectors."""

    def __init__(self, url: str):
        self.url = url
        self.readyState = 0
        self.onopen = None
        self.onmessage = None
        self.onerror = None
        self.onclose = None
        self._ws = None
        self._send_q: "asyncio.Queue[str]" = asyncio.Queue()
        self._task = asyncio.ensure_future(self._run())

    async def _run(self):
        try:
            import websockets  # noqa: PLC0415
        except Exception as e:  # pragma: no cover - import guard
            self.readyState = 3
            if self.onerror:
                self.onerror(e)
            return
        try:
            async with websockets.connect(self.url) as ws:  # pragma: no cover - live net
                self._ws = ws
                self.readyState = 1
                if self.onopen:
                    self.onopen()
                sender = asyncio.ensure_future(self._drain())
                try:
                    async for raw in ws:
                        if self.onmessage:
                            self.onmessage(raw)
                finally:
                    sender.cancel()
        except Exception as e:  # pragma: no cover - live net
            self.readyState = 3
            if self.onerror:
                self.onerror(e)
        finally:
            self.readyState = 3
            if self.onclose:
                self.onclose()

    async def _drain(self):  # pragma: no cover - live net
        while True:
            msg = await self._send_q.get()
            if self._ws is not None:
                await self._ws.send(msg)

    def send(self, s: str):  # pragma: no cover - live net
        self._send_q.put_nowait(s)

    def close(self):  # pragma: no cover - live net
        self.readyState = 3
        if self._ws is not None:
            asyncio.ensure_future(self._ws.close())


# ===========================================================================
# THE LIVE RELAY CLIENT
# ===========================================================================
class Relay:
    def __init__(self, opts: Optional[Dict[str, Any]] = None):
        opts = opts or {}
        self._ed = opts.get("ed25519") or _ed
        self.relayUrl = opts.get("relayUrl") or DEFAULT_RELAY_URL
        self.projectId = opts.get("projectId") or ""
        self._WS = opts.get("WebSocket") or _WebsocketsWS
        self._rand: Optional[Callable[[int], bytes]] = opts.get("randomBytes")
        _now = opts.get("now")
        if callable(_now):
            self._now_sec = _now
        else:
            import time
            self._now_sec = lambda: int(time.time())
        self._logger = opts.get("logger")

        # the ed25519 client key the relay-auth JWT is signed with (generated if absent)
        ck = opts.get("clientKey")
        if ck is None:
            seed = C.to_bytes(self._rand(32)) if self._rand else _random_bytes(32)
            ck = {"secretKey": seed, "publicKey": self._ed.public_key(seed)}
        self.clientKey = ck

        self._sym_keys: Dict[str, str] = {}      # topic -> symKey(hex)
        self._subs: Dict[str, Any] = {}          # topic -> subscriptionId
        self._pair_meta: Dict[str, Any] = {}     # pairingTopic -> meta
        self._proposals: Dict[str, Any] = {}     # sessionTopic -> record
        self._pending: Dict[int, asyncio.Future] = {}  # relay rpc id -> future
        self._proposal_cbs: List[Callable] = []
        self._request_cbs: List[Callable] = []
        self._ws = None
        self._connecting: Optional[asyncio.Future] = None
        self._next_id = 1

    # ---- small helpers ------------------------------------------------------
    def _rpc_id(self) -> int:
        i = self._next_id
        self._next_id += 1
        return i

    def _log(self, *a):
        if self._logger:
            try:
                self._logger(*a)
            except Exception:
                pass

    def _rand_bytes(self, n: int) -> bytes:
        return C.to_bytes(self._rand(n)) if self._rand else _random_bytes(n)

    # ---- WebSocket connect (projectId + relay-auth JWT in the URL) ----------
    def _ws_url(self) -> str:
        from urllib.parse import quote
        auth = build_relay_auth({"ed25519": self._ed, "keyPair": self.clientKey,
                                 "aud": self.relayUrl, "iat": self._now_sec()})
        q = "projectId=" + quote(self.projectId, safe="") + "&auth=" + quote(auth, safe="")
        sep = "&" if "?" in self.relayUrl else "?"
        return self.relayUrl + sep + q

    async def connect(self):
        if self._ws is not None and getattr(self._ws, "readyState", None) == 1:
            return self._ws
        if self._connecting is not None:
            return await self._connecting
        if self._WS is None:
            raise RuntimeError("wc-relay: no WebSocket implementation available")
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._connecting = fut
        try:
            sock = self._WS(self._ws_url())
        except Exception as e:
            self._connecting = None
            raise e
        self._ws = sock

        def _on_open():
            self._connecting = None
            if not fut.done():
                fut.set_result(sock)

        def _on_error(e):
            self._connecting = None
            if not fut.done():
                fut.set_exception(e if isinstance(e, BaseException)
                                  else RuntimeError("wc-relay: websocket error"))

        def _on_close():
            self._ws = None

        def _on_message(data):
            self._on_ws_message(data)

        sock.onopen = _on_open
        sock.onerror = _on_error
        sock.onclose = _on_close
        sock.onmessage = _on_message
        # a mock may have flipped readyState open synchronously already.
        if getattr(sock, "readyState", 0) == 1 and not fut.done():
            _on_open()
        return await fut

    async def _send_raw(self, obj):
        s = json.dumps(obj, separators=(",", ":"))
        sock = await self.connect()
        sock.send(s)

    # a relay JSON-RPC call that resolves on the matching {id,result} ack.
    async def _rpc_call(self, method: str, params: Dict[str, Any]):
        id_ = self._rpc_id()
        msg = {"id": id_, "jsonrpc": "2.0", "method": method, "params": params}
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[id_] = fut
        try:
            await self._send_raw(msg)
        except Exception as e:
            self._pending.pop(id_, None)
            raise e
        return await fut

    # ---- irn framing --------------------------------------------------------
    async def _irn_subscribe(self, topic: str):
        if topic in self._subs:
            return self._subs[topic]
        sub_id = await self._rpc_call("irn_subscribe", {"topic": topic})
        self._subs[topic] = sub_id
        return sub_id

    async def _irn_publish(self, topic, message, tag, ttl=None, prompt=False):
        return await self._rpc_call("irn_publish", {
            "topic": topic, "message": message, "ttl": ttl or TTL["fiveMin"],
            "tag": tag, "prompt": bool(prompt),
        })

    async def _irn_unsubscribe(self, topic):
        id_ = self._subs.get(topic)
        if id_ is None:
            return
        self._subs.pop(topic, None)
        try:
            await self._rpc_call("irn_unsubscribe", {"topic": topic, "id": id_})
        except Exception:
            pass

    async def _publish_encrypted(self, topic, payload, tag, prompt=False):
        key = self._sym_keys.get(topic)
        if not key:
            raise RuntimeError("wc-relay: no symKey for topic " + str(topic))
        message = encode_envelope(key, payload, self._rand)
        return await self._irn_publish(topic, message, tag, TTL["fiveMin"], prompt)

    # ---- inbound WS dispatch ------------------------------------------------
    def _on_ws_message(self, data):
        try:
            msg = json.loads(data) if isinstance(data, (str, bytes, bytearray)) else data
        except Exception:
            return
        if msg is None:
            return
        # (a) a relay ack to one of our calls
        if msg.get("id") is not None and ("result" in msg or "error" in msg) \
                and msg["id"] in self._pending:
            fut = self._pending.pop(msg["id"])
            if fut.done():
                return
            if "error" in msg:
                err = msg["error"] or {}
                fut.set_exception(RuntimeError(err.get("message") or "relay error"))
            else:
                fut.set_result(msg.get("result"))
            return
        # (b) an irn_subscription push from the relay
        if msg.get("method") == "irn_subscription" and msg.get("params") \
                and msg["params"].get("data"):
            if msg.get("id") is not None:
                try:
                    asyncio.ensure_future(self._send_raw(
                        {"id": msg["id"], "jsonrpc": "2.0", "result": True}))
                except Exception:
                    pass
            data_ = msg["params"]["data"]
            self._handle_topic_message(data_.get("topic"), data_.get("message"))
            return

    def _handle_topic_message(self, topic, message):
        key = self._sym_keys.get(topic)
        if not key:
            self._log("no symKey for inbound topic", topic)
            return
        try:
            payload = decode_envelope(key, message)
        except Exception as e:
            self._log("decrypt failed", str(e))
            return
        if payload is None:
            return
        if "result" in payload or "error" in payload:
            return  # a response to something WE published — ignore
        method = payload.get("method")
        if method == "wc_sessionPropose":
            return self._on_session_propose(topic, payload)
        if method == "wc_sessionRequest":
            return self._on_session_request(topic, payload)
        if method == "wc_sessionDelete":
            return self._on_session_delete(topic, payload)
        self._log("unhandled wc method", method)

    # ---- wc_sessionPropose: derive the session topic, surface the proposal --
    def _on_session_propose(self, pairing_topic, rpc):
        p = rpc.get("params") or {}
        proposer = p.get("proposer") or {}
        proposer_pub = proposer.get("publicKey")
        if not proposer_pub:
            self._log("propose without proposer.publicKey")
            return
        responder_kp = new_x25519_key_pair(self._rand)
        session = derive_session(responder_kp["privateKey"], proposer_pub)
        proposal = {
            "id": p.get("id") or rpc.get("id"),
            "pairingTopic": pairing_topic,
            "sessionTopic": session["topic"],
            "proposer": proposer,
            "requiredNamespaces": p.get("requiredNamespaces") or {},
            "optionalNamespaces": p.get("optionalNamespaces") or {},
            "relays": p.get("relays") or [{"protocol": RELAY_PROTOCOL}],
            "expiry": p.get("expiryTimestamp") or p.get("expiry"),
        }
        self._proposals[session["topic"]] = {
            "pairingTopic": pairing_topic, "sessionTopic": session["topic"],
            "proposeId": rpc.get("id"), "proposerPub": proposer_pub,
            "responderKeyPair": responder_kp, "sessionSymKey": session["symKey"],
        }
        self._sym_keys[session["topic"]] = session["symKey"]
        for cb in list(self._proposal_cbs):
            try:
                cb(proposal)
            except Exception as e:
                self._log("proposal cb threw", e)

    # ---- wc_sessionRequest: hand the decrypted request to the engine --------
    def _on_session_request(self, session_topic, rpc):
        p = rpc.get("params") or {}
        inner = p.get("request") or {}
        request = {
            "id": rpc.get("id"),
            "topic": session_topic,
            "chainId": p.get("chainId"),
            "method": inner.get("method"),
            "params": inner.get("params"),
        }
        for cb in list(self._request_cbs):
            try:
                cb(request)
            except Exception as e:
                self._log("request cb threw", e)

    def _on_session_delete(self, session_topic, _rpc=None):
        self._sym_keys.pop(session_topic, None)
        try:
            asyncio.ensure_future(self._irn_unsubscribe(session_topic))
        except Exception:
            pass

    # =========================================================================
    # THE ENGINE-FACING CONTRACT (camelCase — matches the injected-relay shape)
    # =========================================================================
    async def pair(self, parsed):
        topic = parsed["topic"] if isinstance(parsed, dict) else getattr(parsed, "topic")
        sym_key = parsed["symKey"] if isinstance(parsed, dict) else getattr(parsed, "symKey")
        self._sym_keys[topic] = sym_key
        self._pair_meta[topic] = {"selfKeyPair": None}
        await self.connect()
        await self._irn_subscribe(topic)
        return {"topic": topic, "subscribed": True}

    async def approveProposal(self, proposal, settled):
        settled = settled or {}
        session_topic = settled.get("topic") or proposal.get("sessionTopic")
        rec = self._proposals.get(session_topic)
        if not rec:
            raise RuntimeError("wc-relay: no pending proposal for " + str(session_topic))
        self._sym_keys[session_topic] = rec["sessionSymKey"]
        await self._irn_subscribe(session_topic)
        # (1) respond to the sessionPropose request on the PAIRING topic
        await self._publish_encrypted(rec["pairingTopic"], {
            "id": rec["proposeId"], "jsonrpc": "2.0",
            "result": {"relay": {"protocol": RELAY_PROTOCOL},
                       "responderPublicKey": rec["responderKeyPair"]["publicKey"]},
        }, TAG["sessionProposeResponse"])
        # (2) publish wc_sessionSettle on the SESSION topic
        await self._publish_encrypted(session_topic, {
            "id": self._rpc_id(), "jsonrpc": "2.0", "method": "wc_sessionSettle",
            "params": {
                "relay": {"protocol": RELAY_PROTOCOL},
                "controller": {"publicKey": rec["responderKeyPair"]["publicKey"],
                               "metadata": settled.get("metadata") or {}},
                "namespaces": settled.get("namespaces") or {},
                "expiry": settled.get("expiry") or (self._now_sec() + TTL["oneDay"] * 7),
            },
        }, TAG["sessionSettle"])
        return {"topic": session_topic, "settled": True}

    async def rejectProposal(self, proposal, reason):
        session_topic = proposal.get("sessionTopic")
        rec = self._proposals.get(session_topic) if session_topic else None
        pairing_topic = (rec and rec["pairingTopic"]) or proposal.get("pairingTopic")
        propose_id = (rec and rec["proposeId"]) or proposal.get("id")
        if not pairing_topic or not self._sym_keys.get(pairing_topic):
            return
        reason = reason or {}
        await self._publish_encrypted(pairing_topic, {
            "id": propose_id, "jsonrpc": "2.0",
            "error": {"code": reason.get("code") or 5000,
                      "message": reason.get("message") or "user rejected"},
        }, TAG["sessionProposeResponse"])
        if session_topic:
            self._sym_keys.pop(session_topic, None)
            self._proposals.pop(session_topic, None)

    def subscribeRequests(self, cb):
        self._request_cbs.append(cb)

        def _unsub():
            self._request_cbs[:] = [f for f in self._request_cbs if f is not cb]
        return _unsub

    def subscribeProposals(self, cb):
        self._proposal_cbs.append(cb)

        def _unsub():
            self._proposal_cbs[:] = [f for f in self._proposal_cbs if f is not cb]
        return _unsub

    async def respond(self, topic, response):
        out = {"id": response.get("id"), "jsonrpc": "2.0"}
        if "result" in response:
            out["result"] = response["result"]
        if "error" in response:
            out["error"] = response["error"]
        await self._publish_encrypted(topic, out, TAG["sessionRequestResponse"])
        return {"topic": topic, "responded": True}

    async def disconnect(self, topic, reason=None):
        if self._sym_keys.get(topic):
            reason = reason or {}
            try:
                await self._publish_encrypted(topic, {
                    "id": self._rpc_id(), "jsonrpc": "2.0", "method": "wc_sessionDelete",
                    "params": {"code": reason.get("code") or 6000,
                               "message": reason.get("message") or "user disconnected"},
                }, TAG["sessionDelete"])
            except Exception:
                pass  # best-effort
        await self._irn_unsubscribe(topic)
        self._sym_keys.pop(topic, None)
        return {"topic": topic, "disconnected": True}

    # ---- introspection (parity with the JS _state / _onWsMessage) -----------
    def _state(self):
        return {"symKeys": self._sym_keys, "subs": self._subs,
                "proposals": self._proposals, "pending": self._pending}

    _onWsMessage = _on_ws_message


def create_relay(opts: Optional[Dict[str, Any]] = None) -> Relay:
    return Relay(opts)
