// wc-relay.test.js — WalletConnect v2 LIVE RELAY TRANSPORT (wc-relay.js).
// Run: node --test wc-relay.test.js
//
// Verifies the HARD parts of the real transport against WC v2 spec test vectors:
//   • the ChaCha20-Poly1305 TYPE-0 envelope (0x00 || nonce(12) || sealbox)
//     encrypt->decrypt round-trips, decrypts a KNOWN-VECTOR ciphertext, and
//     rejects a tampered tag (NEVER returns forged plaintext);
//   • the underlying AEAD matches the RFC 8439 §2.8.2 known-answer vector;
//   • the relay-auth JWT is well-formed (EdDSA/JWT header, iss did:key, aud the
//     relay url) and its ed25519 signature verifies;
//   • the irn JSON-RPC framing matches (irn_subscribe / irn_publish params +
//     irn_subscription push handling) driven against a MOCK WebSocket relay, and
//     the full pair -> propose -> approve(settle) -> request -> respond ->
//     disconnect lifecycle carries encrypted engine payloads correctly.

const { test } = require('node:test');
const assert = require('node:assert');

const WR = require('./wc-relay.js');
const Ed = require('./ed25519.js');
const C = require('./crypto-core.js');

// ===========================================================================
// 1. ChaCha20-Poly1305 — RFC 8439 §2.8.2 known-answer + the type-0 envelope
// ===========================================================================
test('aead: RFC 8439 §2.8.2 seal matches the known ciphertext+tag and opens back', () => {
  const key = C.hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = C.hexToBytes('070000004041424344454647');
  const aad = C.hexToBytes('50515253c0c1c2c3c4c5c6c7');
  const pt = C.utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const sealed = C.chacha20poly1305Seal(key, nonce, pt, aad);
  assert.equal(C.bytesToHex(sealed.subarray(0, sealed.length - 16)),
    'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116');
  assert.equal(C.bytesToHex(sealed.subarray(sealed.length - 16)), '1ae10b594f09e26a7e902ecbd0600691');
  const opened = C.chacha20poly1305Open(key, nonce, sealed, aad);
  assert.equal(C.bytesToHex(opened), C.bytesToHex(pt));
});

test('envelope: a type-0 envelope round-trips, is tagged 0x00, and rejects tamper', () => {
  const symKey = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
  const payload = { id: 7, jsonrpc: '2.0', method: 'wc_sessionRequest', params: { chainId: 'eip155:1' } };
  const env = WR.encodeEnvelope(symKey, payload); // random nonce
  const bytes = WR.b64ToBytes(env);
  assert.equal(bytes[0], 0x00, 'type-0 prefix');
  assert.equal(bytes.length >= 1 + 12 + 16, true, 'prefix + nonce(12) + at least a tag');
  assert.deepEqual(WR.decodeEnvelope(symKey, env), payload, 'decrypts back to the payload');

  const tampered = WR.b64ToBytes(env); tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => WR.decodeEnvelope(symKey, WR.bytesToB64(tampered)), /authentication failed|bad tag/i,
    'a flipped tag never yields forged plaintext');
});

test('envelope: decrypts a KNOWN-VECTOR ciphertext (fixed symKey + fixed nonce)', () => {
  const symKey = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
  const payload = { id: 1, jsonrpc: '2.0', method: 'wc_sessionSettle', params: { ok: true } };
  // produced by encodeEnvelope(symKey, payload, ()=>nonce(00..01)); frozen here.
  const KNOWN = 'AAAAAAAAAAAAAAAAASt3/+NjgTP336ojLgb4CyT8w8cwALVOKs0GLdxbwXksCy04eSP2YLUIwTSAQAlQ6sFXgvp3oH/ht66+sfj14cYvfWGl2nQKxR6LEK5p8crpnmL3Vp7oh0MP';
  // regenerating with the same fixed nonce reproduces the frozen vector byte-for-byte
  const regen = WR.encodeEnvelope(symKey, payload, () => C.hexToBytes('000000000000000000000001'));
  assert.equal(regen, KNOWN, 'deterministic type-0 envelope matches the frozen vector');
  assert.deepEqual(WR.decodeEnvelope(symKey, KNOWN), payload, 'the known ciphertext decrypts to the known payload');
});

// ===========================================================================
// 2. RELAY-AUTH JWT — EdDSA header, iss did:key, aud the relay url, sig verifies
// ===========================================================================
test('relay-auth: the JWT is well-formed and its ed25519 signature verifies', () => {
  const seed = C.hexToBytes('11'.repeat(32));
  const kp = { secretKey: seed, publicKey: Ed.publicKey(seed) };
  const aud = 'wss://relay.walletconnect.com';
  const token = WR.buildRelayAuth({ ed25519: Ed, keyPair: kp, aud, iat: 1700000000, ttl: 86400, sub: 'subject-123' });

  const parts = token.split('.');
  assert.equal(parts.length, 3, 'header.payload.signature');

  const d = WR.decodeRelayAuth(token);
  assert.equal(d.header.alg, 'EdDSA');
  assert.equal(d.header.typ, 'JWT');
  assert.match(d.payload.iss, /^did:key:z/, 'iss is a did:key');
  assert.equal(d.payload.aud, aud, 'aud is the relay url');
  assert.equal(d.payload.sub, 'subject-123');
  assert.equal(d.payload.exp - d.payload.iat, 86400, 'exp = iat + ttl');

  // the did:key encodes the signing public key (multicodec 0xed01 + 32 bytes)
  assert.equal(C.bytesToHex(d.publicKey), C.bytesToHex(kp.publicKey));
  assert.equal(C.bytesToHex(WR.ed25519PubFromDidKey(d.payload.iss)), C.bytesToHex(kp.publicKey));

  // the signature verifies over the EXACT signing input (base64url header.payload)
  assert.equal(Ed.verify(C.utf8(d.signingInput), d.signature, d.publicKey), true);
  assert.equal(WR.verifyRelayAuth(token, Ed), true);

  // a flipped signature must NOT verify
  const bad = d.signature.slice(); bad[0] ^= 0x01;
  assert.equal(Ed.verify(C.utf8(d.signingInput), bad, d.publicKey), false);
});

// ===========================================================================
// 3. SESSION KEY AGREEMENT — X25519 + HKDF; session topic = sha256(symKey)
// ===========================================================================
test('session: both parties derive the same symKey + topic (X25519 + HKDF)', () => {
  const a = WR.newX25519KeyPair();
  const b = WR.newX25519KeyPair();
  const sa = WR.deriveSession(a.privateKey, b.publicKey);
  const sb = WR.deriveSession(b.privateKey, a.publicKey);
  assert.equal(sa.symKey, sb.symKey, 'ECDH + HKDF agree');
  assert.equal(sa.topic, sb.topic, 'same derived session topic');
  assert.equal(sa.topic.length, 64, 'topic = sha256 hex');
  assert.equal(sa.topic, C.bytesToHex(C.sha256(C.hexToBytes(sa.symKey))), 'topic = sha256(symKey)');
});

// ===========================================================================
// 4. irn FRAMING + the full lifecycle, against a MOCK WebSocket relay
// ===========================================================================
// A mock relay WS: captures the connect URL + every sent frame, auto-acks the
// irn_subscribe/irn_publish/irn_unsubscribe calls, and lets a test INJECT an
// irn_subscription push (simulating the dApp's encrypted messages).
function makeMockWS() {
  const state = { url: null, sent: [], instance: null };
  class MockWS {
    constructor(url) {
      this.readyState = 0; this.url = url; state.url = url; state.instance = this;
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0);
    }
    send(str) {
      const msg = JSON.parse(str);
      state.sent.push(msg);
      // auto-ack relay calls (NOT the irn_subscription acks the relay sends back)
      if (msg.method === 'irn_subscribe') this._reply(msg.id, 'sub:' + msg.params.topic);
      else if (msg.method === 'irn_publish') this._reply(msg.id, true);
      else if (msg.method === 'irn_unsubscribe') this._reply(msg.id, true);
    }
    _reply(id, result) {
      setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ id, jsonrpc: '2.0', result }) }); }, 0);
    }
    // simulate the relay pushing a message on a subscribed topic
    inject(topic, message) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ id: 9999, jsonrpc: '2.0', method: 'irn_subscription', params: { id: 'sub:' + topic, data: { topic, message, publishedAt: 1, tag: 0 } } }) });
    }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  return { MockWS, state };
}

// deterministic byte source so the relay's responder keypair + envelope nonces
// are reproducible within a test.
function seqRand() {
  let n = 1;
  return function (len) { const b = new Uint8Array(len); for (let i = 0; i < len; i++) { b[i] = n & 0xff; n = (n * 1103515245 + 12345) & 0x7fffffff; } return b; };
}

function tick() { return new Promise((r) => setTimeout(r, 5)); }

test('relay: irn_subscribe on pair() uses the correct framing', async () => {
  const { MockWS, state } = makeMockWS();
  const relay = WR.createRelay({ projectId: 'proj-123', WebSocket: MockWS, ed25519: Ed, randomBytes: seqRand() });
  const pairingTopic = 'a'.repeat(64);
  const symKey = C.bytesToHex(C.hexToBytes('22'.repeat(32)));
  await relay.pair({ topic: pairingTopic, symKey, relayProtocol: 'irn', version: 2 });

  // the connect URL carries the projectId + the relay-auth JWT
  assert.match(state.url, /projectId=proj-123/);
  assert.match(state.url, /auth=/);
  const auth = decodeURIComponent(state.url.match(/auth=([^&]+)/)[1]);
  assert.equal(WR.verifyRelayAuth(auth, Ed), true, 'the URL auth JWT verifies');

  const sub = state.sent.find((m) => m.method === 'irn_subscribe');
  assert.ok(sub, 'sent an irn_subscribe');
  assert.equal(sub.jsonrpc, '2.0');
  assert.deepEqual(Object.keys(sub.params), ['topic'], 'irn_subscribe params = { topic }');
  assert.equal(sub.params.topic, pairingTopic);
});

test('relay: full lifecycle pair -> propose -> approve(settle) -> request -> respond -> disconnect', async () => {
  const { MockWS, state } = makeMockWS();
  const relay = WR.createRelay({ projectId: 'p', WebSocket: MockWS, ed25519: Ed, randomBytes: seqRand() });

  const pairingTopic = 'b'.repeat(64);
  const pairingSymKey = C.bytesToHex(C.hexToBytes('33'.repeat(32)));

  const proposals = [];
  relay.subscribeProposals((p) => proposals.push(p));
  const requests = [];
  relay.subscribeRequests((r) => requests.push(r));

  await relay.pair({ topic: pairingTopic, symKey: pairingSymKey, relayProtocol: 'irn', version: 2 });
  const ws = state.instance;

  // --- the dApp publishes wc_sessionPropose (encrypted w/ the PAIRING symKey) ---
  const dapp = WR.newX25519KeyPair();
  const proposeRpc = {
    id: 1111, jsonrpc: '2.0', method: 'wc_sessionPropose',
    params: {
      proposer: { publicKey: dapp.publicKey, metadata: { name: 'Test dApp', url: 'https://dapp.example' } },
      requiredNamespaces: { eip155: { chains: ['eip155:1'], methods: ['eth_sendTransaction'], events: [] } },
      optionalNamespaces: {},
      relays: [{ protocol: 'irn' }],
    },
  };
  ws.inject(pairingTopic, WR.encodeEnvelope(pairingSymKey, proposeRpc));
  await tick();

  assert.equal(proposals.length, 1, 'the proposal surfaced to the UI');
  const proposal = proposals[0];
  assert.equal(proposal.pairingTopic, pairingTopic);
  assert.equal(proposal.sessionTopic.length, 64, 'derived a session topic');
  assert.equal(proposal.proposer.publicKey, dapp.publicKey, 'carries the dApp proposer key');

  // --- the engine approves: relay responds + settles ---
  state.sent.length = 0;
  const namespaces = { eip155: { chains: ['eip155:1'], accounts: ['eip155:1:0xabc'], methods: ['eth_sendTransaction'], events: [] } };
  await relay.approveProposal(proposal, { namespaces, topic: proposal.sessionTopic });
  await tick();

  // (a) the propose RESPONSE published on the PAIRING topic — with our responder key
  const respFrame = state.sent.find((m) => m.method === 'irn_publish' && m.params.topic === pairingTopic);
  assert.ok(respFrame, 'published the propose response on the pairing topic');
  assert.deepEqual(Object.keys(respFrame.params).sort(), ['message', 'prompt', 'tag', 'topic', 'ttl'].sort(), 'irn_publish params');
  assert.equal(respFrame.params.tag, WR.TAG.sessionProposeResponse, 'tagged as a propose response');
  const respPayload = WR.decodeEnvelope(pairingSymKey, respFrame.params.message);
  assert.equal(respPayload.id, proposeRpc.id, 'responds to the propose request id');
  const responderPub = respPayload.result.responderPublicKey;
  assert.ok(responderPub, 'returned the wallet responder public key');

  // the dApp can now derive the SAME session topic the relay subscribed to
  const dappSession = WR.deriveSession(dapp.privateKey, responderPub);
  assert.equal(dappSession.topic, proposal.sessionTopic, 'dApp + wallet agree on the session topic');

  // (b) wc_sessionSettle published on the SESSION topic, decryptable + correct
  const settleFrame = state.sent.find((m) => m.method === 'irn_publish' && m.params.topic === proposal.sessionTopic);
  assert.ok(settleFrame, 'published wc_sessionSettle on the session topic');
  assert.equal(settleFrame.params.tag, WR.TAG.sessionSettle);
  const settle = WR.decodeEnvelope(dappSession.symKey, settleFrame.params.message);
  assert.equal(settle.method, 'wc_sessionSettle');
  assert.deepEqual(settle.params.namespaces, namespaces, 'settled the approved namespaces');

  // the relay subscribed to the session topic too
  assert.ok(state.sent.some((m) => m.method === 'irn_subscribe' && m.params.topic === proposal.sessionTopic), 'subscribed the session topic');

  // --- the dApp sends a wc_sessionRequest (encrypted w/ the SESSION symKey) ---
  const reqRpc = {
    id: 2222, jsonrpc: '2.0', method: 'wc_sessionRequest',
    params: { chainId: 'eip155:1', request: { method: 'eth_sendTransaction', params: [{ to: '0xdead', value: '0x1' }] } },
  };
  ws.inject(proposal.sessionTopic, WR.encodeEnvelope(dappSession.symKey, reqRpc));
  await tick();

  assert.equal(requests.length, 1, 'the request reached the engine callback');
  const req = requests[0];
  assert.equal(req.id, reqRpc.id);
  assert.equal(req.topic, proposal.sessionTopic);
  assert.equal(req.chainId, 'eip155:1');
  assert.equal(req.method, 'eth_sendTransaction');
  assert.deepEqual(req.params, reqRpc.params.request.params, 'unwrapped request.params');

  // --- the engine responds; the relay publishes the (encrypted) result ---
  state.sent.length = 0;
  await relay.respond(proposal.sessionTopic, { id: req.id, result: '0xhash' });
  await tick();
  const outFrame = state.sent.find((m) => m.method === 'irn_publish' && m.params.topic === proposal.sessionTopic);
  assert.ok(outFrame, 'published the response');
  assert.equal(outFrame.params.tag, WR.TAG.sessionRequestResponse);
  const out = WR.decodeEnvelope(dappSession.symKey, outFrame.params.message);
  assert.equal(out.id, req.id);
  assert.equal(out.result, '0xhash', 'the dApp can decrypt the engine result');

  // --- disconnect publishes wc_sessionDelete + unsubscribes ---
  state.sent.length = 0;
  await relay.disconnect(proposal.sessionTopic, { code: 6000, message: 'bye' });
  await tick();
  const delFrame = state.sent.find((m) => m.method === 'irn_publish' && m.params.topic === proposal.sessionTopic);
  assert.ok(delFrame, 'published wc_sessionDelete');
  assert.equal(delFrame.params.tag, WR.TAG.sessionDelete);
  const del = WR.decodeEnvelope(dappSession.symKey, delFrame.params.message);
  assert.equal(del.method, 'wc_sessionDelete');
  assert.ok(state.sent.some((m) => m.method === 'irn_unsubscribe' && m.params.topic === proposal.sessionTopic), 'unsubscribed the session topic');
});
