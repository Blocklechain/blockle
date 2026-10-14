// wc_relay.dart — WalletConnect v2 LIVE RELAY TRANSPORT (the Dart port of
// blockle-extension/wc-relay.js; see docs/WALLET-WALLETCONNECT.md §6).
//
// walletconnect.dart is PURE given an injected `relay`. THIS is the real
// transport: it opens a WebSocket to the WC v2 relay (wss://relay.walletconnect.com
// with a projectId query — operator-configurable), authenticates with a
// relay-auth JWT signed by an ed25519 client key (iss did:key / sub / aud the
// relay url, per the WC spec), speaks the `irn` JSON-RPC (irn_subscribe /
// irn_publish, handling irn_subscription pushes), and encrypts/decrypts every
// message with the pairing or session symKey using a ChaCha20-Poly1305 TYPE-0
// envelope (0x00 || nonce(12) || sealbox) per WC v2.
//
// It NEVER holds wallet keys and NEVER signs a dApp request: it delivers the
// decrypted session_proposal / session_request to the engine (which runs the
// security gate + explicit approval) and publishes only what the engine returns.
//
// Behaviourally IDENTICAL to the JS reference, asserted against the SAME WC v2
// spec vectors (test/multichain/wc_relay_test.dart): the ChaCha20-Poly1305
// type-0 envelope (round-trip + a frozen known-vector + tamper rejection), the
// relay-auth JWT, X25519+HKDF session derivation, and the irn framing + full
// pair -> propose -> approve(settle) -> request -> respond -> disconnect
// lifecycle driven against a mock relay.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'crypto/crypto_core.dart' as c;
import 'crypto/ed25519.dart' as ed;
import 'walletconnect.dart' as wc;

// native dart:io WebSocket where available; a stub (throws) otherwise. The relay
// also accepts an injected socketFactory (used by tests + operators).
import 'wc_socket_stub.dart' if (dart.library.io) 'wc_socket_io.dart' as sock;

const String kDefaultRelayUrl = 'wss://relay.walletconnect.com';
const String kRelayProtocol = 'irn';

/// WC v2 engine message tags (the subset the Sign protocol uses here).
class WcTag {
  static const int sessionPropose = 1100;
  static const int sessionProposeResponse = 1101;
  static const int sessionSettle = 1102;
  static const int sessionSettleResponse = 1103;
  static const int sessionRequest = 1108;
  static const int sessionRequestResponse = 1109;
  static const int sessionDelete = 1112;
}

class WcTtl {
  static const int fiveMin = 300;
  static const int oneDay = 86400;
  static const int thirtySec = 30;
}

// ---- the injected socket abstraction (real WebSocket; mock in tests) --------
abstract class WcSocket {
  void send(String data);
  void onMessage(void Function(String data) cb);
  void onClose(void Function() cb);
  Future<void> close();
}

typedef WcSocketFactory = Future<WcSocket> Function(String url);
typedef RandomBytesFn = Uint8List Function(int n);

/// An ed25519 client key the relay-auth JWT is signed with (seed + public key).
class WcClientKey {
  WcClientKey(this.secretKey, this.publicKey);
  final Uint8List secretKey; // 32-byte seed
  final Uint8List publicKey; // 32-byte ed25519 public key
}

// ===========================================================================
// base64 / base64url
// ===========================================================================
String bytesToB64(List<int> bytes) => base64.encode(c.toBytes(bytes));
Uint8List b64ToBytes(String b64) => base64.decode(base64.normalize(b64));

String b64url(dynamic bytesOrStr) {
  final b = bytesOrStr is String ? c.utf8Bytes(bytesOrStr) : c.toBytes(bytesOrStr);
  return bytesToB64(b).replaceAll('+', '-').replaceAll('/', '_').replaceAll(RegExp(r'=+$'), '');
}

Uint8List b64urlToBytes(String s) {
  var t = s.replaceAll('-', '+').replaceAll('_', '/');
  while (t.length % 4 != 0) {
    t += '=';
  }
  return b64ToBytes(t);
}

// ===========================================================================
// TYPE-0 ENVELOPE — 0x00 || nonce(12) || sealbox(ChaCha20-Poly1305, empty aad)
// ===========================================================================
String encodeEnvelope(dynamic symKey, dynamic payload, [RandomBytesFn? randomBytes]) {
  final key = symKey is String ? c.hexToBytes(symKey) : c.toBytes(symKey);
  final iv = randomBytes != null ? randomBytes(12) : _randomBytes(12);
  final pt = c.utf8Bytes(payload is String ? payload : jsonEncode(payload));
  final sealbox = c.chacha20poly1305Seal(key, iv, pt); // empty aad per WC v2
  final env = c.concatBytes([Uint8List.fromList([0x00]), iv, sealbox]);
  return bytesToB64(env);
}

/// Decrypt a type-0 envelope. Returns the parsed JSON (or the raw string when
/// [raw] is true). Throws on a bad tag / malformed envelope — NEVER forged data.
dynamic decodeEnvelope(dynamic symKey, String b64, {bool raw = false}) {
  final key = symKey is String ? c.hexToBytes(symKey) : c.toBytes(symKey);
  final env = b64ToBytes(b64);
  if (env.length < 1 + 12 + 16 || env[0] != 0x00) {
    throw const FormatException('wc-relay: not a type-0 envelope');
  }
  final iv = env.sublist(1, 13);
  final sealbox = env.sublist(13);
  final pt = c.chacha20poly1305Open(key, iv, sealbox);
  if (pt == null) {
    throw const FormatException('wc-relay: envelope authentication failed (bad tag)');
  }
  final text = utf8.decode(pt);
  if (raw) return text;
  return jsonDecode(text);
}

Uint8List _randomBytes(int n) {
  final r = c.randomBytes(n);
  return r;
}

// ===========================================================================
// RELAY-AUTH JWT — EdDSA (ed25519), iss did:key, sub random, aud the relay url
// ===========================================================================
String didKeyFromEd25519Pub(List<int> pub) {
  final prefixed = c.concatBytes([Uint8List.fromList([0xed, 0x01]), c.toBytes(pub)]);
  return 'did:key:z${c.base58encode(prefixed)}';
}

Uint8List ed25519PubFromDidKey(String did) {
  final m = RegExp(r'^did:key:z(.+)$').firstMatch(did);
  if (m == null) throw const FormatException('wc-relay: not a did:key');
  final decoded = c.base58decode(m.group(1)!);
  if (decoded[0] != 0xed || decoded[1] != 0x01) {
    throw const FormatException('wc-relay: did:key is not ed25519');
  }
  return Uint8List.fromList(decoded.sublist(2, 34));
}

/// Build a relay-auth JWT (EdDSA) signed with [keyPair]. iss=did:key(pub),
/// sub (random hex if omitted), aud=[aud], exp=iat+ttl.
String buildRelayAuth({
  required WcClientKey keyPair,
  required String aud,
  String? sub,
  int? iat,
  int? ttl,
}) {
  final i = iat ?? (DateTime.now().millisecondsSinceEpoch ~/ 1000);
  final t = ttl ?? WcTtl.oneDay;
  final s = sub ?? c.bytesToHex(_randomBytes(32));
  final header = {'alg': 'EdDSA', 'typ': 'JWT'};
  final payload = {
    'iss': didKeyFromEd25519Pub(keyPair.publicKey),
    'sub': s,
    'aud': aud,
    'iat': i,
    'exp': i + t,
  };
  final signingInput = '${b64url(jsonEncode(header))}.${b64url(jsonEncode(payload))}';
  final sig = ed.sign(c.utf8Bytes(signingInput), keyPair.secretKey);
  return '$signingInput.${b64url(sig)}';
}

class DecodedRelayAuth {
  DecodedRelayAuth(this.header, this.payload, this.signingInput, this.signature, this.publicKey);
  final Map<String, dynamic> header;
  final Map<String, dynamic> payload;
  final String signingInput;
  final Uint8List signature;
  final Uint8List publicKey;
}

DecodedRelayAuth decodeRelayAuth(String token) {
  final parts = token.split('.');
  if (parts.length != 3) throw const FormatException('wc-relay: malformed JWT');
  final header = (jsonDecode(utf8.decode(b64urlToBytes(parts[0]))) as Map).cast<String, dynamic>();
  final payload = (jsonDecode(utf8.decode(b64urlToBytes(parts[1]))) as Map).cast<String, dynamic>();
  final signature = b64urlToBytes(parts[2]);
  final publicKey = ed25519PubFromDidKey('${payload['iss']}');
  return DecodedRelayAuth(header, payload, '${parts[0]}.${parts[1]}', signature, publicKey);
}

bool verifyRelayAuth(String token) {
  final d = decodeRelayAuth(token);
  return ed.verify(c.utf8Bytes(d.signingInput), d.signature, d.publicKey);
}

// ===========================================================================
// SESSION KEY AGREEMENT — X25519 + HKDF-SHA256; session topic = sha256(symKey)
// ===========================================================================
class WcDerivedSession {
  WcDerivedSession(this.symKey, this.topic);
  final String symKey; // hex
  final String topic; // hex (sha256 of the symKey)
}

WcDerivedSession deriveSession(dynamic selfPriv, dynamic peerPub) {
  final priv = selfPriv is String ? c.hexToBytes(selfPriv) : c.toBytes(selfPriv);
  final pub = peerPub is String ? c.hexToBytes(peerPub) : c.toBytes(peerPub);
  final shared = c.x25519(priv, pub);
  final symKey = c.hkdfSha256(shared, null, null, 32);
  final topic = c.bytesToHex(c.sha256(symKey));
  return WcDerivedSession(c.bytesToHex(symKey), topic);
}

class WcX25519KeyPair {
  WcX25519KeyPair(this.privateKey, this.publicKey);
  final String privateKey; // hex
  final String publicKey; // hex
}

WcX25519KeyPair newX25519KeyPair([RandomBytesFn? rand]) {
  final priv = rand != null ? rand(32) : _randomBytes(32);
  final pub = c.x25519Base(priv);
  return WcX25519KeyPair(c.bytesToHex(priv), c.bytesToHex(pub));
}

// ===========================================================================
// THE LIVE RELAY CLIENT
// ===========================================================================
class WcLiveRelay implements wc.WcRelay {
  WcLiveRelay({
    String? relayUrl,
    this.projectId = '',
    WcSocketFactory? socketFactory,
    RandomBytesFn? randomBytes,
    WcClientKey? clientKey,
    int Function()? now,
    void Function(Object? message)? logger,
  })  : relayUrl = relayUrl ?? kDefaultRelayUrl,
        _socketFactory = socketFactory ?? sock.openWcSocket,
        _rand = randomBytes,
        _nowSec = now ?? (() => DateTime.now().millisecondsSinceEpoch ~/ 1000),
        _logger = logger {
    _clientKey = clientKey ??
        (() {
          final seed = _randBytes(32);
          return WcClientKey(seed, ed.publicKey(seed));
        })();
  }

  final String relayUrl;
  final String projectId;
  final WcSocketFactory _socketFactory;
  final RandomBytesFn? _rand;
  final int Function() _nowSec;
  final void Function(Object? message)? _logger;
  late final WcClientKey _clientKey;

  final Map<String, String> _symKeys = {}; // topic(hex) -> symKey(hex)
  final Map<String, dynamic> _subs = {}; // topic -> subscriptionId
  final Map<String, Map<String, dynamic>> _proposals = {}; // sessionTopic -> record
  final Map<int, Completer<dynamic>> _pending = {}; // relay rpc id -> completer
  final List<void Function(Map<String, dynamic>)> _proposalCbs = [];
  final List<Future<Map<String, dynamic>> Function(Map<String, dynamic>)> _requestCbs = [];

  WcSocket? _ws;
  Future<WcSocket>? _connecting;
  int _nextId = 1;

  WcClientKey get clientKey => _clientKey;

  Uint8List _randBytes(int n) => _rand != null ? _rand(n) : _randomBytes(n);
  int _rpcId() => _nextId++;
  void _log(Object? m) {
    if (_logger != null) {
      try {
        _logger(m);
      } catch (_) {/* swallow */}
    }
  }

  // ---- WebSocket connect (with projectId + relay-auth JWT in the URL) -------
  String _wsUrl() {
    final auth = buildRelayAuth(keyPair: _clientKey, aud: relayUrl, iat: _nowSec());
    final q = 'projectId=${Uri.encodeQueryComponent(projectId)}&auth=${Uri.encodeQueryComponent(auth)}';
    return relayUrl + (relayUrl.contains('?') ? '&' : '?') + q;
  }

  Future<WcSocket> connect() {
    final existing = _ws;
    if (existing != null) return Future.value(existing);
    if (_connecting != null) return _connecting!;
    _connecting = _socketFactory(_wsUrl()).then((s) {
      _ws = s;
      _connecting = null;
      s.onMessage(_onWsMessage);
      s.onClose(() => _ws = null);
      return s;
    }).catchError((Object e) {
      _connecting = null;
      throw e;
    });
    return _connecting!;
  }

  Future<void> _sendRaw(Map<String, dynamic> obj) async {
    final s = jsonEncode(obj);
    final sock = await connect();
    sock.send(s);
  }

  // a relay JSON-RPC call that resolves on the matching {id,result} ack.
  Future<dynamic> _rpcCall(String method, Map<String, dynamic> params) {
    final id = _rpcId();
    final msg = {'id': id, 'jsonrpc': '2.0', 'method': method, 'params': params};
    final completer = Completer<dynamic>();
    _pending[id] = completer;
    _sendRaw(msg).catchError((Object e) {
      _pending.remove(id);
      if (!completer.isCompleted) completer.completeError(e);
    });
    return completer.future;
  }

  // ---- irn framing ----------------------------------------------------------
  Future<dynamic> _irnSubscribe(String topic) async {
    if (_subs.containsKey(topic)) return _subs[topic];
    final subId = await _rpcCall('irn_subscribe', {'topic': topic});
    _subs[topic] = subId;
    return subId;
  }

  Future<dynamic> _irnPublish(String topic, String message, int tag, {int? ttl, bool prompt = false}) {
    return _rpcCall('irn_publish', {
      'topic': topic,
      'message': message,
      'ttl': ttl ?? WcTtl.fiveMin,
      'tag': tag,
      'prompt': prompt,
    });
  }

  Future<void> _irnUnsubscribe(String topic) async {
    final id = _subs[topic];
    if (id == null) return;
    _subs.remove(topic);
    try {
      await _rpcCall('irn_unsubscribe', {'topic': topic, 'id': id});
    } catch (_) {/* best-effort */}
  }

  // publish an encrypted engine payload on a topic that has a symKey.
  Future<dynamic> _publishEncrypted(String topic, Map<String, dynamic> payload, int tag, {bool prompt = false}) {
    final key = _symKeys[topic];
    if (key == null) {
      return Future.error(StateError('wc-relay: no symKey for topic $topic'));
    }
    final message = encodeEnvelope(key, payload, _rand);
    return _irnPublish(topic, message, tag, ttl: WcTtl.fiveMin, prompt: prompt);
  }

  // ---- inbound WS dispatch --------------------------------------------------
  void _onWsMessage(String data) {
    dynamic msg;
    try {
      msg = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (msg is! Map) return;
    final m = msg.cast<String, dynamic>();
    // (a) a relay ack to one of our calls
    if (m['id'] != null && (m.containsKey('result') || m.containsKey('error')) && _pending.containsKey(m['id'])) {
      final p = _pending.remove(m['id'])!;
      if (m.containsKey('error')) {
        final err = m['error'];
        p.completeError(StateError((err is Map ? err['message'] : null)?.toString() ?? 'relay error'));
      } else {
        p.complete(m['result']);
      }
      return;
    }
    // (b) an irn_subscription push from the relay (a message on a subscribed topic)
    if (m['method'] == 'irn_subscription' && m['params'] is Map && (m['params'] as Map)['data'] is Map) {
      if (m['id'] != null) {
        _sendRaw({'id': m['id'], 'jsonrpc': '2.0', 'result': true}).catchError((_) {});
      }
      final d = ((m['params'] as Map)['data'] as Map).cast<String, dynamic>();
      _handleTopicMessage('${d['topic']}', '${d['message']}');
      return;
    }
  }

  // decrypt an inbound envelope on `topic` and route by the inner JSON-RPC.
  void _handleTopicMessage(String topic, String message) {
    final key = _symKeys[topic];
    if (key == null) {
      _log('no symKey for inbound topic $topic');
      return;
    }
    dynamic payload;
    try {
      payload = decodeEnvelope(key, message);
    } catch (e) {
      _log('decrypt failed: $e');
      return;
    }
    if (payload is! Map) return;
    final p = payload.cast<String, dynamic>();
    if (p.containsKey('result') || p.containsKey('error')) return; // a response to us
    final method = p['method'];
    if (method == 'wc_sessionPropose') return _onSessionPropose(topic, p);
    if (method == 'wc_sessionRequest') return _onSessionRequest(topic, p);
    if (method == 'wc_sessionDelete') return _onSessionDelete(topic);
    _log('unhandled wc method $method');
  }

  // ---- wc_sessionPropose: derive the session topic, surface the proposal ----
  void _onSessionPropose(String pairingTopic, Map<String, dynamic> rpc) {
    final params = (rpc['params'] as Map?)?.cast<String, dynamic>() ?? const {};
    final proposer = (params['proposer'] as Map?)?.cast<String, dynamic>() ?? const {};
    final proposerPub = proposer['publicKey'];
    if (proposerPub == null) {
      _log('propose without proposer.publicKey');
      return;
    }
    final responderKeyPair = newX25519KeyPair(_rand);
    final session = deriveSession(responderKeyPair.privateKey, '$proposerPub');
    final proposal = <String, dynamic>{
      'id': params['id'] ?? rpc['id'],
      'pairingTopic': pairingTopic,
      'sessionTopic': session.topic,
      'proposer': proposer,
      'requiredNamespaces': params['requiredNamespaces'] ?? const {},
      'optionalNamespaces': params['optionalNamespaces'] ?? const {},
      'relays': params['relays'] ?? [{'protocol': kRelayProtocol}],
      'expiry': params['expiryTimestamp'] ?? params['expiry'],
    };
    _proposals[session.topic] = {
      'pairingTopic': pairingTopic,
      'sessionTopic': session.topic,
      'proposeId': rpc['id'],
      'proposerPub': '$proposerPub',
      'responderKeyPair': responderKeyPair,
      'sessionSymKey': session.symKey,
    };
    _symKeys[session.topic] = session.symKey;
    for (final cb in List.of(_proposalCbs)) {
      try {
        cb(proposal);
      } catch (e) {
        _log('proposal cb threw $e');
      }
    }
  }

  // ---- wc_sessionRequest: hand the decrypted request to the engine ----------
  void _onSessionRequest(String sessionTopic, Map<String, dynamic> rpc) {
    final params = (rpc['params'] as Map?)?.cast<String, dynamic>() ?? const {};
    final inner = (params['request'] as Map?)?.cast<String, dynamic>() ?? const {};
    final request = <String, dynamic>{
      'id': rpc['id'],
      'topic': sessionTopic,
      'chainId': params['chainId'],
      'method': inner['method'],
      'params': inner['params'],
    };
    for (final cb in List.of(_requestCbs)) {
      Future<Map<String, dynamic>> fut;
      try {
        fut = cb(request);
      } catch (e) {
        _log('request cb threw $e');
        continue;
      }
      // keep the engine UNTOUCHED: if the engine callback (handleRequest +
      // respond) rejects, publish a generic JSON-RPC error so the dApp isn't left
      // hanging — the engine never has to know about the transport.
      fut.catchError((Object e) {
        _log('request handling failed $e');
        _publishEncrypted(sessionTopic, {
          'id': rpc['id'],
          'jsonrpc': '2.0',
          'error': {'code': 5000, 'message': 'request failed: $e'},
        }, WcTag.sessionRequestResponse).catchError((_) {});
        return <String, dynamic>{};
      });
    }
  }

  void _onSessionDelete(String sessionTopic) {
    _symKeys.remove(sessionTopic);
    _irnUnsubscribe(sessionTopic);
  }

  // =========================================================================
  // THE ENGINE-FACING CONTRACT (wc.WcRelay)
  // =========================================================================
  @override
  Future<void> pair(Map<String, dynamic> parsed) async {
    final topic = '${parsed['topic']}';
    _symKeys[topic] = '${parsed['symKey']}';
    await connect();
    await _irnSubscribe(topic);
  }

  @override
  Future<void> approveProposal(Map<String, dynamic> proposal, Map<String, dynamic> settled) async {
    final sessionTopic = '${settled['topic'] ?? proposal['sessionTopic']}';
    final rec = _proposals[sessionTopic];
    if (rec == null) {
      throw StateError('wc-relay: no pending proposal for $sessionTopic');
    }
    _symKeys[sessionTopic] = '${rec['sessionSymKey']}';
    await _irnSubscribe(sessionTopic);
    final responderKeyPair = rec['responderKeyPair'] as WcX25519KeyPair;
    // (1) respond to the sessionPropose request on the PAIRING topic with our
    //     responder public key (completes the X25519 exchange for the dApp).
    await _publishEncrypted('${rec['pairingTopic']}', {
      'id': rec['proposeId'],
      'jsonrpc': '2.0',
      'result': {
        'relay': {'protocol': kRelayProtocol},
        'responderPublicKey': responderKeyPair.publicKey,
      },
    }, WcTag.sessionProposeResponse);
    // (2) publish wc_sessionSettle on the SESSION topic.
    await _publishEncrypted(sessionTopic, {
      'id': _rpcId(),
      'jsonrpc': '2.0',
      'method': 'wc_sessionSettle',
      'params': {
        'relay': {'protocol': kRelayProtocol},
        'controller': {
          'publicKey': responderKeyPair.publicKey,
          'metadata': settled['metadata'] ?? const {},
        },
        'namespaces': settled['namespaces'] ?? const {},
        'expiry': settled['expiry'] ?? (_nowSec() + WcTtl.oneDay * 7),
      },
    }, WcTag.sessionSettle);
  }

  @override
  Future<void> rejectProposal(Map<String, dynamic> proposal, Map<String, dynamic> reason) async {
    final sessionTopic = proposal['sessionTopic'] != null ? '${proposal['sessionTopic']}' : null;
    final rec = sessionTopic != null ? _proposals[sessionTopic] : null;
    final pairingTopic = '${(rec != null ? rec['pairingTopic'] : null) ?? proposal['pairingTopic']}';
    final proposeId = (rec != null ? rec['proposeId'] : null) ?? proposal['id'];
    if (_symKeys[pairingTopic] == null) return;
    await _publishEncrypted(pairingTopic, {
      'id': proposeId,
      'jsonrpc': '2.0',
      'error': {
        'code': reason['code'] ?? 5000,
        'message': reason['message'] ?? 'user rejected',
      },
    }, WcTag.sessionProposeResponse);
    if (sessionTopic != null) {
      _symKeys.remove(sessionTopic);
      _proposals.remove(sessionTopic);
    }
  }

  @override
  void Function() subscribeRequests(Future<Map<String, dynamic>> Function(Map<String, dynamic> request) onRequest) {
    _requestCbs.add(onRequest);
    return () => _requestCbs.remove(onRequest);
  }

  /// subscribeProposals(cb) — the UI registers the proposal-review callback (the
  /// engine core has no proposal hook; this is a transport→UI extra).
  void Function() subscribeProposals(void Function(Map<String, dynamic> proposal) cb) {
    _proposalCbs.add(cb);
    return () => _proposalCbs.remove(cb);
  }

  @override
  Future<void> respond(String topic, Map<String, dynamic> response) async {
    await _publishEncrypted(topic, {
      'id': response['id'],
      'jsonrpc': '2.0',
      if (response.containsKey('result')) 'result': response['result'],
      if (response.containsKey('error')) 'error': response['error'],
    }, WcTag.sessionRequestResponse);
  }

  @override
  Future<void> disconnect(String topic, Map<String, dynamic>? reason) async {
    if (_symKeys[topic] != null) {
      try {
        await _publishEncrypted(topic, {
          'id': _rpcId(),
          'jsonrpc': '2.0',
          'method': 'wc_sessionDelete',
          'params': {
            'code': reason?['code'] ?? 6000,
            'message': reason?['message'] ?? 'user disconnected',
          },
        }, WcTag.sessionDelete);
      } catch (_) {/* best-effort */}
    }
    await _irnUnsubscribe(topic);
    _symKeys.remove(topic);
  }

  // introspection for tests
  Map<String, String> get symKeysView => Map.unmodifiable(_symKeys);
  Map<String, dynamic> get subsView => Map.unmodifiable(_subs);
}
