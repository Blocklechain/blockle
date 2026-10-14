// wc_relay_test.dart — WalletConnect v2 LIVE RELAY TRANSPORT (wc_relay.dart).
//
// The Dart port of blockle-extension/wc-relay.test.js. Verifies the HARD parts of
// the real transport against the SAME WC v2 spec test vectors:
//   • the ChaCha20-Poly1305 TYPE-0 envelope (0x00 || nonce(12) || sealbox)
//     encrypt->decrypt round-trips, decrypts a frozen KNOWN-VECTOR ciphertext
//     (byte-identical to the JS reference), and rejects a tampered tag;
//   • the underlying AEAD matches the RFC 8439 §2.8.2 known-answer vector;
//   • X25519 matches the RFC 7748 §5.2 known-answer vector;
//   • the relay-auth JWT is well-formed (EdDSA/JWT header, iss did:key, aud the
//     relay url) and its ed25519 signature verifies;
//   • X25519+HKDF session derivation agrees on both sides; topic = sha256(symKey);
//   • the irn JSON-RPC framing + the full pair -> propose -> approve(settle) ->
//     request -> respond -> disconnect lifecycle against a MOCK WebSocket relay.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/multichain/crypto/crypto_core.dart' as c;
import 'package:blockle_app/multichain/crypto/ed25519.dart' as ed;
import 'package:blockle_app/multichain/wc_relay.dart' as wr;

// ---- a mock relay WebSocket: captures sent frames, auto-acks the irn calls,
// and lets a test INJECT an irn_subscription push (the dApp's encrypted msgs).
class MockWcSocket implements wr.WcSocket {
  final List<Map<String, dynamic>> sent = [];
  void Function(String)? _onMsg;

  @override
  void onMessage(void Function(String) cb) => _onMsg = cb;
  @override
  void onClose(void Function() cb) {}

  @override
  void send(String data) {
    final msg = (jsonDecode(data) as Map).cast<String, dynamic>();
    sent.add(msg);
    final method = msg['method'];
    if (method == 'irn_subscribe') {
      _reply(msg['id'], 'sub:${(msg['params'] as Map)['topic']}');
    } else if (method == 'irn_publish') {
      _reply(msg['id'], true);
    } else if (method == 'irn_unsubscribe') {
      _reply(msg['id'], true);
    }
  }

  void _reply(dynamic id, dynamic result) {
    Future.microtask(
        () => _onMsg?.call(jsonEncode({'id': id, 'jsonrpc': '2.0', 'result': result})));
  }

  // simulate the relay pushing a message on a subscribed topic.
  void inject(String topic, String message) {
    _onMsg?.call(jsonEncode({
      'id': 9999,
      'jsonrpc': '2.0',
      'method': 'irn_subscription',
      'params': {
        'id': 'sub:$topic',
        'data': {'topic': topic, 'message': message, 'publishedAt': 1, 'tag': 0},
      },
    }));
  }

  @override
  Future<void> close() async {}
}

Future<void> tick() => Future.delayed(const Duration(milliseconds: 5));

void main() {
  // =========================================================================
  // 1. ChaCha20-Poly1305 — RFC 8439 §2.8.2 known-answer + the type-0 envelope
  // =========================================================================
  test('aead: RFC 8439 §2.8.2 seal matches the known ciphertext+tag and opens back', () {
    final key = c.hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    final nonce = c.hexToBytes('070000004041424344454647');
    final aad = c.hexToBytes('50515253c0c1c2c3c4c5c6c7');
    final pt = c.utf8Bytes(
        "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    final sealed = c.chacha20poly1305Seal(key, nonce, pt, aad);
    expect(c.bytesToHex(sealed.sublist(0, sealed.length - 16)),
        'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116');
    expect(c.bytesToHex(sealed.sublist(sealed.length - 16)), '1ae10b594f09e26a7e902ecbd0600691');
    final opened = c.chacha20poly1305Open(key, nonce, sealed, aad);
    expect(c.bytesToHex(opened!), c.bytesToHex(pt));
  });

  test('x25519: RFC 7748 §5.2 known-answer vector', () {
    final scalar = c.hexToBytes('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
    final u = c.hexToBytes('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
    final out = c.x25519(scalar, u);
    expect(c.bytesToHex(out), 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  });

  test('envelope: a type-0 envelope round-trips, is tagged 0x00, and rejects tamper', () {
    const symKey = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
    final payload = {'id': 7, 'jsonrpc': '2.0', 'method': 'wc_sessionRequest', 'params': {'chainId': 'eip155:1'}};
    final env = wr.encodeEnvelope(symKey, payload); // random nonce
    final bytes = wr.b64ToBytes(env);
    expect(bytes[0], 0x00);
    expect(bytes.length >= 1 + 12 + 16, true);
    expect(wr.decodeEnvelope(symKey, env), payload);

    final tampered = wr.b64ToBytes(env);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => wr.decodeEnvelope(symKey, wr.bytesToB64(tampered)),
        throwsA(predicate((e) => '$e'.toLowerCase().contains('authentication failed') || '$e'.toLowerCase().contains('bad tag'))));
  });

  test('envelope: decrypts a KNOWN-VECTOR ciphertext (fixed symKey + fixed nonce)', () {
    const symKey = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
    final payload = {'id': 1, 'jsonrpc': '2.0', 'method': 'wc_sessionSettle', 'params': {'ok': true}};
    // frozen in wc-relay.test.js; produced with the fixed nonce 00..01.
    const known =
        'AAAAAAAAAAAAAAAAASt3/+NjgTP336ojLgb4CyT8w8cwALVOKs0GLdxbwXksCy04eSP2YLUIwTSAQAlQ6sFXgvp3oH/ht66+sfj14cYvfWGl2nQKxR6LEK5p8crpnmL3Vp7oh0MP';
    final regen = wr.encodeEnvelope(symKey, payload,
        (n) => c.hexToBytes('000000000000000000000001'));
    expect(regen, known);
    expect(wr.decodeEnvelope(symKey, known), payload);
  });

  // =========================================================================
  // 2. RELAY-AUTH JWT — EdDSA header, iss did:key, aud the relay url, sig verifies
  // =========================================================================
  test('relay-auth: the JWT is well-formed and its ed25519 signature verifies', () {
    final seed = c.hexToBytes('11' * 32);
    final kp = wr.WcClientKey(seed, ed.publicKey(seed));
    const aud = 'wss://relay.walletconnect.com';
    final token = wr.buildRelayAuth(keyPair: kp, aud: aud, iat: 1700000000, ttl: 86400, sub: 'subject-123');

    final parts = token.split('.');
    expect(parts.length, 3);

    final d = wr.decodeRelayAuth(token);
    expect(d.header['alg'], 'EdDSA');
    expect(d.header['typ'], 'JWT');
    expect('${d.payload['iss']}'.startsWith('did:key:z'), true);
    expect(d.payload['aud'], aud);
    expect(d.payload['sub'], 'subject-123');
    expect((d.payload['exp'] as int) - (d.payload['iat'] as int), 86400);

    expect(c.bytesToHex(d.publicKey), c.bytesToHex(kp.publicKey));
    expect(c.bytesToHex(wr.ed25519PubFromDidKey('${d.payload['iss']}')), c.bytesToHex(kp.publicKey));

    expect(ed.verify(c.utf8Bytes(d.signingInput), d.signature, d.publicKey), true);
    expect(wr.verifyRelayAuth(token), true);

    final bad = Uint8List.fromList(d.signature);
    bad[0] ^= 0x01;
    expect(ed.verify(c.utf8Bytes(d.signingInput), bad, d.publicKey), false);
  });

  // =========================================================================
  // 3. SESSION KEY AGREEMENT — X25519 + HKDF; session topic = sha256(symKey)
  // =========================================================================
  test('session: both parties derive the same symKey + topic (X25519 + HKDF)', () {
    final a = wr.newX25519KeyPair();
    final b = wr.newX25519KeyPair();
    final sa = wr.deriveSession(a.privateKey, b.publicKey);
    final sb = wr.deriveSession(b.privateKey, a.publicKey);
    expect(sa.symKey, sb.symKey);
    expect(sa.topic, sb.topic);
    expect(sa.topic.length, 64);
    expect(sa.topic, c.bytesToHex(c.sha256(c.hexToBytes(sa.symKey))));
  });

  // =========================================================================
  // 4. irn FRAMING + the full lifecycle, against a MOCK WebSocket relay
  // =========================================================================
  test('relay: irn_subscribe on pair() uses the correct framing + a verifying auth JWT', () async {
    final mock = MockWcSocket();
    String? capturedUrl;
    final relay = wr.WcLiveRelay(
      projectId: 'proj-123',
      socketFactory: (url) async {
        capturedUrl = url;
        return mock;
      },
    );
    final pairingTopic = 'a' * 64;
    final symKey = c.bytesToHex(c.hexToBytes('22' * 32));
    await relay.pair({'topic': pairingTopic, 'symKey': symKey, 'relayProtocol': 'irn', 'version': 2});

    expect(capturedUrl, contains('projectId=proj-123'));
    expect(capturedUrl, contains('auth='));
    final auth = Uri.decodeQueryComponent(RegExp(r'auth=([^&]+)').firstMatch(capturedUrl!)!.group(1)!);
    expect(wr.verifyRelayAuth(auth), true);

    final sub = mock.sent.firstWhere((m) => m['method'] == 'irn_subscribe');
    expect(sub['jsonrpc'], '2.0');
    expect((sub['params'] as Map).keys.toList(), ['topic']);
    expect((sub['params'] as Map)['topic'], pairingTopic);
  });

  test('relay: full lifecycle pair -> propose -> approve(settle) -> request -> respond -> disconnect', () async {
    final mock = MockWcSocket();
    final relay = wr.WcLiveRelay(projectId: 'p', socketFactory: (url) async => mock);

    final pairingTopic = 'b' * 64;
    final pairingSymKey = c.bytesToHex(c.hexToBytes('33' * 32));

    final proposals = <Map<String, dynamic>>[];
    relay.subscribeProposals(proposals.add);
    final requests = <Map<String, dynamic>>[];
    relay.subscribeRequests((r) async {
      requests.add(r);
      return <String, dynamic>{};
    });

    await relay.pair({'topic': pairingTopic, 'symKey': pairingSymKey, 'relayProtocol': 'irn', 'version': 2});

    // --- the dApp publishes wc_sessionPropose (encrypted w/ the PAIRING symKey) ---
    final dapp = wr.newX25519KeyPair();
    final proposeRpc = {
      'id': 1111,
      'jsonrpc': '2.0',
      'method': 'wc_sessionPropose',
      'params': {
        'proposer': {'publicKey': dapp.publicKey, 'metadata': {'name': 'Test dApp', 'url': 'https://dapp.example'}},
        'requiredNamespaces': {'eip155': {'chains': ['eip155:1'], 'methods': ['eth_sendTransaction'], 'events': []}},
        'optionalNamespaces': {},
        'relays': [{'protocol': 'irn'}],
      },
    };
    mock.inject(pairingTopic, wr.encodeEnvelope(pairingSymKey, proposeRpc));
    await tick();

    expect(proposals.length, 1);
    final proposal = proposals[0];
    expect(proposal['pairingTopic'], pairingTopic);
    expect('${proposal['sessionTopic']}'.length, 64);
    expect((proposal['proposer'] as Map)['publicKey'], dapp.publicKey);

    // --- the engine approves: relay responds + settles ---
    mock.sent.clear();
    final namespaces = {
      'eip155': {'chains': ['eip155:1'], 'accounts': ['eip155:1:0xabc'], 'methods': ['eth_sendTransaction'], 'events': []}
    };
    await relay.approveProposal(proposal, {'namespaces': namespaces, 'topic': proposal['sessionTopic']});
    await tick();

    // (a) the propose RESPONSE published on the PAIRING topic — with our responder key
    final respFrame = mock.sent.firstWhere((m) => m['method'] == 'irn_publish' && (m['params'] as Map)['topic'] == pairingTopic);
    expect((respFrame['params'] as Map).keys.toList()..sort(), ['message', 'prompt', 'tag', 'topic', 'ttl']..sort());
    expect((respFrame['params'] as Map)['tag'], wr.WcTag.sessionProposeResponse);
    final respPayload = wr.decodeEnvelope(pairingSymKey, '${(respFrame['params'] as Map)['message']}') as Map;
    expect(respPayload['id'], proposeRpc['id']);
    final responderPub = (respPayload['result'] as Map)['responderPublicKey'];
    expect(responderPub, isNotNull);

    // the dApp derives the SAME session topic the relay subscribed to
    final dappSession = wr.deriveSession(dapp.privateKey, '$responderPub');
    expect(dappSession.topic, proposal['sessionTopic']);

    // (b) wc_sessionSettle published on the SESSION topic, decryptable + correct
    final settleFrame = mock.sent.firstWhere((m) => m['method'] == 'irn_publish' && (m['params'] as Map)['topic'] == proposal['sessionTopic']);
    expect((settleFrame['params'] as Map)['tag'], wr.WcTag.sessionSettle);
    final settle = wr.decodeEnvelope(dappSession.symKey, '${(settleFrame['params'] as Map)['message']}') as Map;
    expect(settle['method'], 'wc_sessionSettle');
    expect((settle['params'] as Map)['namespaces'], namespaces);

    expect(mock.sent.any((m) => m['method'] == 'irn_subscribe' && (m['params'] as Map)['topic'] == proposal['sessionTopic']), true);

    // --- the dApp sends a wc_sessionRequest (encrypted w/ the SESSION symKey) ---
    final reqRpc = {
      'id': 2222,
      'jsonrpc': '2.0',
      'method': 'wc_sessionRequest',
      'params': {'chainId': 'eip155:1', 'request': {'method': 'eth_sendTransaction', 'params': [{'to': '0xdead', 'value': '0x1'}]}},
    };
    mock.inject('${proposal['sessionTopic']}', wr.encodeEnvelope(dappSession.symKey, reqRpc));
    await tick();

    expect(requests.length, 1);
    final req = requests[0];
    expect(req['id'], reqRpc['id']);
    expect(req['topic'], proposal['sessionTopic']);
    expect(req['chainId'], 'eip155:1');
    expect(req['method'], 'eth_sendTransaction');
    expect(req['params'], ((reqRpc['params'] as Map)['request'] as Map)['params']);

    // --- the engine responds; the relay publishes the (encrypted) result ---
    mock.sent.clear();
    await relay.respond('${proposal['sessionTopic']}', {'id': req['id'], 'result': '0xhash'});
    await tick();
    final outFrame = mock.sent.firstWhere((m) => m['method'] == 'irn_publish' && (m['params'] as Map)['topic'] == proposal['sessionTopic']);
    expect((outFrame['params'] as Map)['tag'], wr.WcTag.sessionRequestResponse);
    final out = wr.decodeEnvelope(dappSession.symKey, '${(outFrame['params'] as Map)['message']}') as Map;
    expect(out['id'], req['id']);
    expect(out['result'], '0xhash');

    // --- disconnect publishes wc_sessionDelete + unsubscribes ---
    mock.sent.clear();
    await relay.disconnect('${proposal['sessionTopic']}', {'code': 6000, 'message': 'bye'});
    await tick();
    final delFrame = mock.sent.firstWhere((m) => m['method'] == 'irn_publish' && (m['params'] as Map)['topic'] == proposal['sessionTopic']);
    expect((delFrame['params'] as Map)['tag'], wr.WcTag.sessionDelete);
    final del = wr.decodeEnvelope(dappSession.symKey, '${(delFrame['params'] as Map)['message']}') as Map;
    expect(del['method'], 'wc_sessionDelete');
    expect(mock.sent.any((m) => m['method'] == 'irn_unsubscribe' && (m['params'] as Map)['topic'] == proposal['sessionTopic']), true);
  });
}
