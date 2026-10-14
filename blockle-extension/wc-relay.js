// wc-relay.js — WalletConnect v2 LIVE RELAY TRANSPORT (the reference `relay`
// client the WalletConnect engine injects; see docs/WALLET-WALLETCONNECT.md §6).
//
// walletconnect.js is PURE given an injected `relay`. THIS is the real transport:
// it opens a WebSocket to the WC v2 relay (wss://relay.walletconnect.com with a
// projectId query — operator-configurable), authenticates with a relay-auth JWT
// signed by an ed25519 client key (iss did:key / sub / aud the relay url, per the
// WC spec), speaks the `irn` JSON-RPC (irn_subscribe / irn_publish, handling
// irn_subscription pushes), and encrypts/decrypts every message with the pairing
// or session symKey using a ChaCha20-Poly1305 TYPE-0 envelope
// (0x00 || nonce(12) || sealbox) per WC v2.
//
// It NEVER holds wallet keys and NEVER signs a dApp request: it delivers the
// decrypted session_proposal / session_request to the engine (which runs the
// security gate + explicit approval) and publishes only what the engine returns.
//
// Lifecycle (faithful to the WC v2 Sign protocol):
//   pair(parsed)         -> subscribe the PAIRING topic (symKey from the URI),
//                           await wc_sessionPropose
//   <wc_sessionPropose>  -> derive the SESSION topic via X25519 + HKDF, surface
//                           the proposal (subscribeProposals) to the UI
//   approveProposal(...) -> respond to the propose request + publish
//                           wc_sessionSettle on the session topic
//   <wc_sessionRequest>  -> subscribeRequests delivers it to the engine
//   respond(topic, resp) -> publish the engine's JSON-RPC result/error
//   disconnect(topic)    -> publish wc_sessionDelete + unsubscribe
//
// Contract (what walletconnect.js calls): pair, approveProposal, rejectProposal,
// subscribeRequests(cb), respond(topic, response), disconnect(topic, reason),
// plus subscribeProposals(cb) for the UI. PURE helpers are exported for the
// node --test spec vectors (envelope / relay-auth JWT / irn framing).
//
// Global `WCRelay`; module.exports for node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const BLKCrypto = inNode ? require('./crypto-core.js') : global.BLKCrypto;
  const Ed25519Def = inNode ? require('./ed25519.js') : global.Ed25519;

  const DEFAULT_RELAY_URL = 'wss://relay.walletconnect.com';
  const RELAY_PROTOCOL = 'irn';

  // WC v2 engine message tags (the subset the Sign protocol uses here).
  const TAG = {
    sessionPropose: 1100, sessionProposeResponse: 1101,
    sessionSettle: 1102, sessionSettleResponse: 1103,
    sessionRequest: 1108, sessionRequestResponse: 1109,
    sessionDelete: 1112,
  };
  const TTL = { fiveMin: 300, oneDay: 86400, thirtySec: 30 };

  // ---- base64 / base64url (Buffer under Node, btoa/atob in the browser) ------
  function bytesToB64(bytes) {
    const b = BLKCrypto.toBytes(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return global.btoa(s);
  }
  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const s = global.atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function b64url(bytesOrStr) {
    const b = typeof bytesOrStr === 'string' ? BLKCrypto.utf8(bytesOrStr) : BLKCrypto.toBytes(bytesOrStr);
    return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToBytes(s) {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return b64ToBytes(t);
  }

  // ===========================================================================
  // TYPE-0 ENVELOPE — 0x00 || nonce(12) || sealbox(ChaCha20-Poly1305, empty aad)
  // ===========================================================================
  // encodeEnvelope(symKeyHex, payloadObject, randomBytes?) -> base64 string
  function encodeEnvelope(symKey, payload, randomBytes) {
    const key = typeof symKey === 'string' ? BLKCrypto.hexToBytes(symKey) : BLKCrypto.toBytes(symKey);
    const iv = randomBytes ? randomBytes(12) : randomBytes12();
    const pt = BLKCrypto.utf8(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const sealbox = BLKCrypto.chacha20poly1305Seal(key, iv, pt); // empty aad per WC v2
    const env = BLKCrypto.concatBytes(Uint8Array.of(0x00), iv, sealbox);
    return bytesToB64(env);
  }
  // decodeEnvelope(symKeyHex, base64) -> parsed payload (throws on a bad tag)
  function decodeEnvelope(symKey, b64, opts) {
    const key = typeof symKey === 'string' ? BLKCrypto.hexToBytes(symKey) : BLKCrypto.toBytes(symKey);
    const env = b64ToBytes(b64);
    if (env.length < 1 + 12 + 16 || env[0] !== 0x00) throw new Error('wc-relay: not a type-0 envelope');
    const iv = env.subarray(1, 13);
    const sealbox = env.subarray(13);
    const pt = BLKCrypto.chacha20poly1305Open(key, iv, sealbox);
    if (pt === null) throw new Error('wc-relay: envelope authentication failed (bad tag)');
    const text = (typeof Buffer !== 'undefined') ? Buffer.from(pt).toString('utf8') : new TextDecoder().decode(pt);
    if (opts && opts.raw) return text;
    return JSON.parse(text);
  }
  function randomBytes12() {
    const out = new Uint8Array(12);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(out);
    else if (inNode) { const r = require('crypto').randomBytes(12); out.set(r); }
    else for (let i = 0; i < 12; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  // ===========================================================================
  // RELAY-AUTH JWT — EdDSA (ed25519), iss did:key, sub random, aud the relay url
  // ===========================================================================
  // ed25519 multicodec (0xed 0x01) + base58btc, prefixed 'z' (did:key).
  function didKeyFromEd25519Pub(pub) {
    const p = BLKCrypto.toBytes(pub);
    const prefixed = BLKCrypto.concatBytes(Uint8Array.of(0xed, 0x01), p);
    return 'did:key:z' + BLKCrypto.base58encode(prefixed);
  }
  function ed25519PubFromDidKey(did) {
    const s = String(did);
    const m = s.match(/^did:key:z(.+)$/);
    if (!m) throw new Error('wc-relay: not a did:key');
    const decoded = BLKCrypto.base58decode(m[1]);
    if (decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error('wc-relay: did:key is not ed25519');
    return decoded.subarray(2, 34);
  }
  // buildRelayAuth({ ed25519, keyPair:{secretKey,publicKey}, aud, sub?, iat?, ttl? })
  function buildRelayAuth(opts) {
    const ed = opts.ed25519 || Ed25519Def;
    const kp = opts.keyPair;
    if (!ed || !kp || !kp.secretKey || !kp.publicKey) throw new Error('wc-relay: relay-auth needs an ed25519 key pair');
    const iat = opts.iat != null ? opts.iat : Math.floor(Date.now() / 1000);
    const ttl = opts.ttl != null ? opts.ttl : TTL.oneDay;
    const sub = opts.sub || BLKCrypto.bytesToHex(randomBytes32());
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const payload = { iss: didKeyFromEd25519Pub(kp.publicKey), sub, aud: opts.aud, iat, exp: iat + ttl };
    const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
    const sig = ed.sign(BLKCrypto.utf8(signingInput), kp.secretKey);
    return signingInput + '.' + b64url(sig);
  }
  // decodeRelayAuth(token) -> { header, payload, signingInput, signature, publicKey }
  function decodeRelayAuth(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('wc-relay: malformed JWT');
    const header = JSON.parse(utf8Decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(utf8Decode(b64urlToBytes(parts[1])));
    const signature = b64urlToBytes(parts[2]);
    const publicKey = ed25519PubFromDidKey(payload.iss);
    return { header, payload, signingInput: parts[0] + '.' + parts[1], signature, publicKey };
  }
  function verifyRelayAuth(token, ed25519) {
    const ed = ed25519 || Ed25519Def;
    const d = decodeRelayAuth(token);
    return !!(ed && ed.verify(BLKCrypto.utf8(d.signingInput), d.signature, d.publicKey));
  }
  function utf8Decode(bytes) {
    return (typeof Buffer !== 'undefined') ? Buffer.from(bytes).toString('utf8') : new TextDecoder().decode(bytes);
  }
  function randomBytes32() {
    const out = new Uint8Array(32);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(out);
    else if (inNode) { const r = require('crypto').randomBytes(32); out.set(r); }
    else for (let i = 0; i < 32; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  // ===========================================================================
  // SESSION KEY AGREEMENT — X25519 + HKDF-SHA256; session topic = sha256(symKey)
  // ===========================================================================
  // deriveSession(selfPrivHex, peerPubHex) -> { symKey(hex), topic(hex) }
  function deriveSession(selfPriv, peerPub) {
    const priv = typeof selfPriv === 'string' ? BLKCrypto.hexToBytes(selfPriv) : BLKCrypto.toBytes(selfPriv);
    const pub = typeof peerPub === 'string' ? BLKCrypto.hexToBytes(peerPub) : BLKCrypto.toBytes(peerPub);
    const shared = BLKCrypto.x25519(priv, pub);
    const symKey = BLKCrypto.hkdfSha256(shared, null, null, 32);
    const topic = BLKCrypto.bytesToHex(BLKCrypto.sha256(symKey));
    return { symKey: BLKCrypto.bytesToHex(symKey), topic };
  }
  function newX25519KeyPair(rand) {
    const priv = rand ? rand(32) : randomBytes32();
    const pub = BLKCrypto.x25519Base(priv);
    return { privateKey: BLKCrypto.bytesToHex(priv), publicKey: BLKCrypto.bytesToHex(pub) };
  }

  // ===========================================================================
  // THE LIVE RELAY CLIENT
  // ===========================================================================
  function createRelay(opts) {
    opts = opts || {};
    const crypto = opts.crypto || BLKCrypto;
    const ed = opts.ed25519 || Ed25519Def;
    const relayUrl = opts.relayUrl || DEFAULT_RELAY_URL;
    const projectId = opts.projectId || '';
    const WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : (typeof global.WebSocket !== 'undefined' ? global.WebSocket : null));
    const rand = opts.randomBytes || null;      // (n)->Uint8Array (injectable for tests)
    const nowSec = typeof opts.now === 'function' ? opts.now : (() => Math.floor(Date.now() / 1000));
    // the ed25519 client key the relay-auth JWT is signed with (generated if absent)
    const clientKey = opts.clientKey || (function () {
      const seed = rand ? rand(32) : randomBytes32();
      return { secretKey: seed, publicKey: ed.publicKey(seed) };
    })();

    const symKeys = new Map();     // topic(hex) -> symKey(hex)
    const subs = new Map();        // topic -> subscriptionId
    const pairMeta = new Map();    // pairingTopic -> { selfKeyPair }
    const proposals = new Map();   // proposalId -> { pairingTopic, sessionTopic, proposeId, proposerPub, responderKeyPair, relayMessageId }
    const pending = new Map();     // relay rpc id -> {resolve,reject}
    let proposalCbs = [], requestCbs = [];
    let ws = null, connecting = null, nextId = 1;

    function rpcId() { return nextId++; }
    function log() { if (opts.logger) try { opts.logger.apply(null, arguments); } catch (_) {} }

    // ---- WebSocket connect (with the projectId + relay-auth JWT in the URL) --
    function wsUrl() {
      const auth = buildRelayAuth({ ed25519: ed, keyPair: clientKey, aud: relayUrl, iat: nowSec() });
      const q = 'projectId=' + encodeURIComponent(projectId) + '&auth=' + encodeURIComponent(auth);
      return relayUrl + (relayUrl.indexOf('?') >= 0 ? '&' : '?') + q;
    }
    function connect() {
      if (ws && ws.readyState === 1) return Promise.resolve(ws);
      if (connecting) return connecting;
      if (!WS) return Promise.reject(new Error('wc-relay: no WebSocket implementation available'));
      connecting = new Promise(function (resolve, reject) {
        let sock;
        try { sock = new WS(wsUrl()); } catch (e) { connecting = null; return reject(e); }
        ws = sock;
        sock.onopen = function () { connecting = null; resolve(sock); };
        sock.onerror = function (e) { connecting = null; reject(e && e.error || new Error('wc-relay: websocket error')); };
        sock.onclose = function () { ws = null; };
        sock.onmessage = function (ev) { onWsMessage(ev && ev.data != null ? ev.data : ev); };
      });
      return connecting;
    }
    function sendRaw(obj) {
      const s = JSON.stringify(obj);
      return connect().then(function (sock) { sock.send(s); });
    }
    // a relay JSON-RPC call that resolves on the matching {id,result} ack.
    function rpcCall(method, params) {
      const id = rpcId();
      const msg = { id: id, jsonrpc: '2.0', method: method, params: params };
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        sendRaw(msg).catch(function (e) { pending.delete(id); reject(e); });
      });
    }

    // ---- irn framing ---------------------------------------------------------
    function irnSubscribe(topic) {
      if (subs.has(topic)) return Promise.resolve(subs.get(topic));
      return rpcCall('irn_subscribe', { topic: topic }).then(function (subId) {
        subs.set(topic, subId); return subId;
      });
    }
    function irnPublish(topic, message, tag, ttl, prompt) {
      return rpcCall('irn_publish', {
        topic: topic, message: message, ttl: ttl || TTL.fiveMin, tag: tag, prompt: !!prompt,
      });
    }
    function irnUnsubscribe(topic) {
      const id = subs.get(topic);
      if (id == null) return Promise.resolve();
      subs.delete(topic);
      return rpcCall('irn_unsubscribe', { topic: topic, id: id }).catch(function () {});
    }

    // publish an encrypted engine payload on a topic that has a symKey.
    function publishEncrypted(topic, payload, tag, prompt) {
      const key = symKeys.get(topic);
      if (!key) return Promise.reject(new Error('wc-relay: no symKey for topic ' + topic));
      const message = encodeEnvelope(key, payload, rand);
      return irnPublish(topic, message, tag, TTL.fiveMin, prompt);
    }

    // ---- inbound WS dispatch -------------------------------------------------
    function onWsMessage(data) {
      let msg; try { msg = typeof data === 'string' ? JSON.parse(data) : data; } catch (_) { return; }
      if (msg == null) return;
      // (a) a relay ack to one of our calls
      if (msg.id != null && (('result' in msg) || ('error' in msg)) && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if ('error' in msg) p.reject(Object.assign(new Error((msg.error && msg.error.message) || 'relay error'), { rpc: msg.error }));
        else p.resolve(msg.result);
        return;
      }
      // (b) an irn_subscription push from the relay (a message on a topic we sub'd)
      if (msg.method === 'irn_subscription' && msg.params && msg.params.data) {
        // ACK the push immediately (relay requires it).
        if (msg.id != null) sendRaw({ id: msg.id, jsonrpc: '2.0', result: true }).catch(function () {});
        handleTopicMessage(msg.params.data.topic, msg.params.data.message);
        return;
      }
    }

    // decrypt an inbound envelope on `topic` and route by the inner JSON-RPC.
    function handleTopicMessage(topic, message) {
      const key = symKeys.get(topic);
      if (!key) { log('no symKey for inbound topic', topic); return; }
      let payload; try { payload = decodeEnvelope(key, message); } catch (e) { log('decrypt failed', e && e.message); return; }
      if (payload == null) return;
      // a response to something WE published (e.g. settle ack) — ignore for now.
      if (('result' in payload) || ('error' in payload)) return;
      const method = payload.method;
      if (method === 'wc_sessionPropose') return onSessionPropose(topic, payload);
      if (method === 'wc_sessionRequest') return onSessionRequest(topic, payload);
      if (method === 'wc_sessionDelete') return onSessionDelete(topic, payload);
      // wc_sessionSettle / wc_sessionPing etc. are ack-only here.
      log('unhandled wc method', method);
    }

    // ---- wc_sessionPropose: derive the session topic, surface the proposal ---
    function onSessionPropose(pairingTopic, rpc) {
      const p = rpc.params || {};
      const proposer = p.proposer || {};
      const proposerPub = proposer.publicKey;
      if (!proposerPub) { log('propose without proposer.publicKey'); return; }
      const meta = pairMeta.get(pairingTopic) || {};
      const responderKeyPair = newX25519KeyPair(rand);
      const session = deriveSession(responderKeyPair.privateKey, proposerPub);
      // the proposal id the engine will settle under = the derived SESSION topic.
      const proposal = {
        id: p.id || rpc.id,
        pairingTopic: pairingTopic,
        sessionTopic: session.topic,
        proposer: proposer,
        requiredNamespaces: p.requiredNamespaces || {},
        optionalNamespaces: p.optionalNamespaces || {},
        relays: p.relays || [{ protocol: RELAY_PROTOCOL }],
        expiry: p.expiryTimestamp || p.expiry || null,
      };
      proposals.set(session.topic, {
        pairingTopic: pairingTopic, sessionTopic: session.topic, proposeId: rpc.id,
        proposerPub: proposerPub, responderKeyPair: responderKeyPair, sessionSymKey: session.symKey,
      });
      // stash the session symKey so approveProposal can subscribe + publish.
      symKeys.set(session.topic, session.symKey);
      void meta;
      proposalCbs.forEach(function (cb) { try { cb(proposal); } catch (e) { log('proposal cb threw', e); } });
    }

    // ---- wc_sessionRequest: hand the decrypted request to the engine ---------
    function onSessionRequest(sessionTopic, rpc) {
      const p = rpc.params || {};
      const inner = p.request || {};
      const request = {
        id: rpc.id,
        topic: sessionTopic,
        chainId: p.chainId,
        method: inner.method,
        params: inner.params,
      };
      requestCbs.forEach(function (cb) { try { cb(request); } catch (e) { log('request cb threw', e); } });
    }

    function onSessionDelete(sessionTopic) {
      symKeys.delete(sessionTopic);
      irnUnsubscribe(sessionTopic);
    }

    // =========================================================================
    // THE ENGINE-FACING CONTRACT
    // =========================================================================
    // pair(parsed) — parsed from walletconnect.parsePairingUri: the pairing topic
    // is the URI topic; the symKey comes from the URI. Subscribe + await propose.
    async function pair(parsed) {
      const topic = parsed.topic;
      symKeys.set(topic, parsed.symKey);
      pairMeta.set(topic, { selfKeyPair: null });
      await connect();
      await irnSubscribe(topic);
      return { topic: topic, subscribed: true };
    }

    // approveProposal(proposal, { namespaces, topic }) — respond to the propose
    // request (our responder x25519 publicKey) on the PAIRING topic, subscribe the
    // session topic, and publish wc_sessionSettle on it. Never signs anything.
    async function approveProposal(proposal, settled) {
      const sessionTopic = (settled && settled.topic) || proposal.sessionTopic;
      const rec = proposals.get(sessionTopic);
      if (!rec) throw new Error('wc-relay: no pending proposal for ' + sessionTopic);
      symKeys.set(sessionTopic, rec.sessionSymKey);
      await irnSubscribe(sessionTopic);
      // (1) respond to the sessionPropose request on the PAIRING topic with our
      //     responder public key (completes the X25519 exchange for the dApp).
      await publishEncrypted(rec.pairingTopic, {
        id: rec.proposeId, jsonrpc: '2.0',
        result: { relay: { protocol: RELAY_PROTOCOL }, responderPublicKey: rec.responderKeyPair.publicKey },
      }, TAG.sessionProposeResponse);
      // (2) publish wc_sessionSettle on the SESSION topic.
      await publishEncrypted(sessionTopic, {
        id: rpcId(), jsonrpc: '2.0', method: 'wc_sessionSettle',
        params: {
          relay: { protocol: RELAY_PROTOCOL },
          controller: { publicKey: rec.responderKeyPair.publicKey, metadata: (settled && settled.metadata) || {} },
          namespaces: (settled && settled.namespaces) || {},
          expiry: (settled && settled.expiry) || (nowSec() + TTL.oneDay * 7),
        },
      }, TAG.sessionSettle);
      return { topic: sessionTopic, settled: true };
    }

    // rejectProposal(proposal, reason) — respond to the propose request with an error.
    async function rejectProposal(proposal, reason) {
      const sessionTopic = proposal.sessionTopic;
      const rec = sessionTopic && proposals.get(sessionTopic);
      const pairingTopic = (rec && rec.pairingTopic) || proposal.pairingTopic;
      const proposeId = (rec && rec.proposeId) || proposal.id;
      if (!pairingTopic || !symKeys.get(pairingTopic)) return; // nothing to publish on
      await publishEncrypted(pairingTopic, {
        id: proposeId, jsonrpc: '2.0',
        error: { code: (reason && reason.code) || 5000, message: (reason && reason.message) || 'user rejected' },
      }, TAG.sessionProposeResponse);
      if (sessionTopic) { symKeys.delete(sessionTopic); proposals.delete(sessionTopic); }
    }

    // subscribeRequests(cb) — the engine registers one callback; returns an
    // unsubscribe. Each decrypted wc_sessionRequest is delivered to it.
    function subscribeRequests(cb) {
      requestCbs.push(cb);
      return function () { requestCbs = requestCbs.filter(function (f) { return f !== cb; }); };
    }
    // subscribeProposals(cb) — the UI registers the proposal-review callback.
    function subscribeProposals(cb) {
      proposalCbs.push(cb);
      return function () { proposalCbs = proposalCbs.filter(function (f) { return f !== cb; }); };
    }

    // respond(topic, response) — publish the engine's JSON-RPC result/error for a
    // session request. `response` is { id, result } or { id, error }.
    async function respond(topic, response) {
      await publishEncrypted(topic, {
        id: response.id, jsonrpc: '2.0',
        result: 'result' in response ? response.result : undefined,
        error: 'error' in response ? response.error : undefined,
      }, TAG.sessionRequestResponse);
      return { topic: topic, responded: true };
    }

    // disconnect(topic, reason) — publish wc_sessionDelete + unsubscribe.
    async function disconnect(topic, reason) {
      if (symKeys.get(topic)) {
        try {
          await publishEncrypted(topic, {
            id: rpcId(), jsonrpc: '2.0', method: 'wc_sessionDelete',
            params: { code: (reason && reason.code) || 6000, message: (reason && reason.message) || 'user disconnected' },
          }, TAG.sessionDelete);
        } catch (_) { /* best-effort */ }
      }
      await irnUnsubscribe(topic);
      symKeys.delete(topic);
      return { topic: topic, disconnected: true };
    }

    return {
      // engine-facing contract
      pair, approveProposal, rejectProposal, subscribeRequests, respond, disconnect,
      // UI-facing
      subscribeProposals,
      // lifecycle / introspection
      connect,
      clientKey: clientKey,
      relayUrl: relayUrl, projectId: projectId,
      _state: function () { return { symKeys: symKeys, subs: subs, proposals: proposals, pending: pending }; },
      _onWsMessage: onWsMessage, // exposed for the mock-relay test
    };
  }

  const API = {
    createRelay,
    // pure helpers for the spec-vector tests + the ports
    encodeEnvelope, decodeEnvelope,
    buildRelayAuth, decodeRelayAuth, verifyRelayAuth,
    didKeyFromEd25519Pub, ed25519PubFromDidKey,
    deriveSession, newX25519KeyPair,
    b64url, b64urlToBytes, bytesToB64, b64ToBytes,
    TAG, TTL, DEFAULT_RELAY_URL, RELAY_PROTOCOL,
  };
  global.WCRelay = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
