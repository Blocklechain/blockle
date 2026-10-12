// multichain/walletconnect_test.dart — Wallet dApp Connect / WalletConnect v2
// core (walletconnect.dart), Dart port of blockle-extension/walletconnect.js.
//
// Asserts the implementation against the AUTHORITATIVE shared vectors
// (docs/walletconnect-vectors.json, consumed never edited) — the exact pairing /
// proposal / approval / request-routing / expiry cases the JS reference + Python
// port reproduce — plus the SECURITY integration + the explicit-approval gate.
//
// The relay transport + WC crypto are ABSTRACTED: we inject a FAKE relay + FAKE
// signer. The core is PURE given those — it NEVER holds keys and signs only
// AFTER explicit human approval + the security pre-sign gate. No dApp request
// ever auto-approves.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/walletconnect.dart';
import 'package:blockle_app/multichain/security.dart' show Warning;

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/walletconnect-vectors.json',
    'docs/walletconnect-vectors.json',
    '../../docs/walletconnect-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('walletconnect-vectors.json not found (cwd=${Directory.current.path})');
}

final V = _loadVectors();
final int NOW = (V['nowMs'] as num).toInt();

// ---- a FAKE relay: records calls, grants/holds nothing on its own -----------
class FakeRelay implements WcRelay {
  final calls = <String, List<dynamic>>{
    'pair': [], 'approveProposal': [], 'rejectProposal': [], 'respond': [], 'disconnect': [],
  };
  Future<Map<String, dynamic>> Function(Map<String, dynamic>)? _onRequest;

  @override
  Future<void> pair(Map<String, dynamic> parsed) async => calls['pair']!.add(parsed);
  @override
  Future<void> approveProposal(Map<String, dynamic> proposal, Map<String, dynamic> settled) async =>
      calls['approveProposal']!.add({'proposal': proposal, 'settled': settled});
  @override
  Future<void> rejectProposal(Map<String, dynamic> proposal, Map<String, dynamic> reason) async =>
      calls['rejectProposal']!.add({'proposal': proposal, 'reason': reason});
  @override
  Future<void> respond(String topic, Map<String, dynamic> response) async =>
      calls['respond']!.add({'topic': topic, 'response': response});
  @override
  Future<void> disconnect(String topic, Map<String, dynamic>? reason) async =>
      calls['disconnect']!.add({'topic': topic, 'reason': reason});
  @override
  void Function() subscribeRequests(Future<Map<String, dynamic>> Function(Map<String, dynamic>) onRequest) {
    _onRequest = onRequest;
    return () => _onRequest = null;
  }

  Future<Map<String, dynamic>> emit(Map<String, dynamic> request) => _onRequest!(request);
}

// ---- a FAKE signer: deterministic, NEVER real crypto, records what it signed -
class FakeSigner implements WcSigner {
  final signed = <Map<String, dynamic>>[];
  @override
  Future<dynamic> ethSendTransaction(Map<String, dynamic> a) async {
    signed.add({'m': 'eth_sendTransaction', 'a': a});
    final tx = a['tx'];
    final v = tx is Map ? (tx['value'] ?? tx['data'] ?? '') : '';
    return '0xhash_$v';
  }

  @override
  Future<dynamic> ethSignTypedData(Map<String, dynamic> a) async {
    signed.add({'m': 'ethSignTypedData', 'a': a});
    return '0xsig_typed';
  }

  @override
  Future<dynamic> personalSign(Map<String, dynamic> a) async {
    signed.add({'m': 'personalSign', 'a': a});
    return '0xsig_personal';
  }

  @override
  Future<dynamic> solanaSignTransaction(Map<String, dynamic> a) async {
    signed.add({'m': 'solanaSignTransaction', 'a': a});
    return {'signature': 'solsig'};
  }

  @override
  Future<dynamic> solanaSignAndSend(Map<String, dynamic> a) async {
    signed.add({'m': 'solanaSignAndSend', 'a': a});
    return {'signature': 'solsig_sent'};
  }

  @override
  Future<dynamic> solanaSignMessage(Map<String, dynamic> a) async {
    signed.add({'m': 'solanaSignMessage', 'a': a});
    return '0xsol_msg_sig';
  }
}

// ---- a FAKE encrypted store: a plain in-memory map (NO key material ever) ----
class FakeStore implements WalletConnectStore {
  final mem = <String, dynamic>{};
  @override
  Future<Map<String, dynamic>> get(String key) async => {key: mem[key]};
  @override
  Future<void> set(Map<String, dynamic> obj) async => mem.addAll(obj);
}

class Harness {
  final WalletConnect wc;
  final FakeRelay relay;
  final FakeSigner signer;
  final FakeStore store;
  Harness(this.wc, this.relay, this.signer, this.store);
}

Harness makeWC({FakeRelay? relay, FakeSigner? signer, FakeStore? store, Map<String, dynamic>? config, int? now}) {
  final r = relay ?? FakeRelay();
  final s = signer ?? FakeSigner();
  final st = store ?? FakeStore();
  final wc = WalletConnect(
    relay: r,
    signer: s,
    store: st,
    now: () => now ?? NOW,
    config: {...(V['config'] as Map).cast<String, dynamic>(), ...?config},
  );
  return Harness(wc, r, s, st);
}

typedef HookResult = ({WcRequestCtx ctx, List<Map<String, dynamic>> approveSeen, List<Map<String, dynamic>> confirmSeen});

// approval/confirm hooks that just record + return a fixed decision. A null
// value means that handler is NOT wired at all (fail-closed path).
HookResult hooks({bool? approve, bool? confirm}) {
  final approveSeen = <Map<String, dynamic>>[];
  final confirmSeen = <Map<String, dynamic>>[];
  final ctx = WcRequestCtx(
    approve: approve == null ? null : (p) async { approveSeen.add(p); return approve; },
    confirm: confirm == null ? null : (p) async { confirmSeen.add(p); return confirm; },
  );
  return (ctx: ctx, approveSeen: approveSeen, confirmSeen: confirmSeen);
}

Future<Harness> withSettledSession({Map<String, dynamic>? config}) async {
  final h = makeWC(config: config);
  final v = (V['approval'] as Map)['intersection'] as Map<String, dynamic>;
  await h.wc.approveProposal((v['proposal'] as Map).cast<String, dynamic>(),
      accounts: (v['accounts'] as List).cast<String>());
  return h;
}

// ---- helpers ----
List<String> codesOf(dynamic ws) =>
    (ws as List).map((w) => (w as Warning).code).toList()..sort();
int? reqErr(Map<String, dynamic> resp) => resp['error'] != null ? resp['error']['code'] as int : null;
String escapeRe(String s) => s.replaceAllMapped(RegExp(r'[.*+?^${}()|[\]\\]'), (m) => '\\${m[0]}');

void expectThrowsMatch(void Function() fn, String pattern) {
  final re = RegExp(escapeRe(pattern), caseSensitive: false);
  try {
    fn();
    fail('expected a throw matching "$pattern"');
  } catch (e) {
    expect(re.hasMatch('$e'), isTrue, reason: 'error "$e" should match "$pattern"');
  }
}

Future<void> expectThrowsMatchAsync(Future<void> Function() fn, String pattern) async {
  final re = RegExp(escapeRe(pattern), caseSensitive: false);
  try {
    await fn();
    fail('expected a throw matching "$pattern"');
  } catch (e) {
    expect(re.hasMatch('$e'), isTrue, reason: 'error "$e" should match "$pattern"');
  }
}

void main() {
  // =========================================================================
  // 1. PAIRING URI — accept v2, reject v1 + malformed (vectors)
  // =========================================================================
  group('pairing', () {
    test('a valid v2 URI parses to topic/relay/symKey', () {
      final v = (V['pairing'] as Map)['valid'] as Map<String, dynamic>;
      final got = parsePairingUri(v['uri']);
      expect(got, equals((v['expect'] as Map).cast<String, dynamic>()));
    });

    test('a v1 (@1) URI is rejected with a clear error', () {
      final v = (V['pairing'] as Map)['rejectV1'] as Map<String, dynamic>;
      expectThrowsMatch(() => parsePairingUri(v['uri']), v['expectErrorMatch'] as String);
    });

    test('malformed URIs are each rejected with a clear error', () {
      for (final raw in (V['pairing'] as Map)['rejectMalformed'] as List) {
        final c = (raw as Map).cast<String, dynamic>();
        expectThrowsMatch(() => parsePairingUri(c['uri']), c['expectErrorMatch'] as String);
      }
    });

    test('pair(): parses then hands the pairing to the injected relay (grants nothing)', () async {
      final h = makeWC();
      final v = (V['pairing'] as Map)['valid'] as Map<String, dynamic>;
      final parsed = await h.wc.pair(v['uri']);
      expect(parsed['version'], 2);
      expect(h.relay.calls['pair']!.length, 1);
      expect(await h.wc.listSessions(), isEmpty); // pairing alone grants no session
    });

    test('pair(): a v1 URI never reaches the relay', () async {
      final h = makeWC();
      await expectThrowsMatchAsync(() => h.wc.pair((V['pairing'] as Map)['rejectV1']['uri']), 'v1');
      expect(h.relay.calls['pair']!.length, 0);
    });
  });

  // =========================================================================
  // 2. PROPOSAL REVIEW — claimed metadata surfaced (never trusted) + warnings
  // =========================================================================
  group('reviewProposal', () {
    test('surfaces CLAIMED dApp metadata + requested chains/methods + warnings', () {
      final h = makeWC();
      final v = (V['proposalReview'] as Map)['surfaces-metadata-and-warnings'] as Map<String, dynamic>;
      final r = h.wc.reviewProposal((v['proposal'] as Map).cast<String, dynamic>());
      final ex = (v['expect'] as Map).cast<String, dynamic>();
      final dapp = r['dapp'] as Map<String, dynamic>;
      expect(dapp['name'], (ex['dapp'] as Map)['name']);
      expect(dapp['url'], (ex['dapp'] as Map)['url']);
      expect(dapp['description'], (ex['dapp'] as Map)['description']);
      expect((r['chains'] as List)..sort(), equals((ex['chains'] as List).toList()..sort()));
      for (final m in ex['methodsInclude'] as List) {
        expect((r['methods'] as List).contains(m), isTrue, reason: 'surfaces method $m');
      }
      expect(codesOf(r['warnings']), equals((ex['warnings'] as List).cast<String>().toList()..sort()));
      expect(r['severity'], ex['severity']);
    });

    test('a denylisted dApp domain is a DANGER warning', () {
      final h = makeWC();
      final v = (V['proposalReview'] as Map)['denylisted-dapp-is-danger'] as Map<String, dynamic>;
      final r = h.wc.reviewProposal((v['proposal'] as Map).cast<String, dynamic>());
      final ex = (v['expect'] as Map).cast<String, dynamic>();
      expect(codesOf(r['warnings']), equals((ex['warnings'] as List).cast<String>().toList()..sort()));
      expect(r['severity'], 'danger');
    });
  });

  // =========================================================================
  // 3. APPROVAL — settled namespace = requested ∩ wallet-controlled
  // =========================================================================
  group('approveProposal', () {
    test('settles the INTERSECTION of requested ∩ wallet-controlled + supported-safe methods', () async {
      final h = makeWC();
      final v = (V['approval'] as Map)['intersection'] as Map<String, dynamic>;
      final ex = (v['expect'] as Map).cast<String, dynamic>();
      final session = await h.wc.approveProposal((v['proposal'] as Map).cast<String, dynamic>(),
          accounts: (v['accounts'] as List).cast<String>());
      final ns = (session['namespaces'] as Map)[ex['namespaceKey']] as Map<String, dynamic>;
      expect(ns, isNotNull);
      expect((ns['chains'] as List).toList()..sort(), equals((ex['chains'] as List).toList()..sort()));
      expect((ns['accounts'] as List).toList()..sort(), equals((ex['accounts'] as List).toList()..sort()));
      for (final m in ex['methodsInclude'] as List) {
        expect((ns['methods'] as List).contains(m), isTrue, reason: 'settles supported method $m');
      }
      for (final m in ex['methodsExclude'] as List) {
        expect((ns['methods'] as List).contains(m), isFalse, reason: 'drops unsafe method $m');
      }
      for (final c in ex['chainsExclude'] as List) {
        expect((ns['chains'] as List).contains(c), isFalse, reason: 'never fabricates chain $c');
      }
      expect(session['activeChainId'], ex['activeChainId']);
      // persisted via the injected store; NO key material
      expect((h.store.mem['wc:sessions'] as Map)[session['topic']], isNotNull);
      expect(RegExp('symKey|privateKey|secret|seed', caseSensitive: false).hasMatch(jsonEncode(session)), isFalse);
      expect(h.relay.calls['approveProposal']!.length, 1);
    });

    test('a REQUIRED unsupported chain is rejected fail-closed (never fabricated)', () async {
      final h = makeWC();
      final v = (V['approval'] as Map)['reject-required-unsupported-chain'] as Map<String, dynamic>;
      await expectThrowsMatchAsync(
          () => h.wc.approveProposal((v['proposal'] as Map).cast<String, dynamic>(),
              accounts: (v['accounts'] as List).cast<String>()),
          v['expectThrowMatch'] as String);
      expect(await h.wc.listSessions(), isEmpty);
    });

    test('rejectProposal: forwards a rejection to the relay, settles nothing', () async {
      final h = makeWC();
      final v = (V['approval'] as Map)['intersection'] as Map<String, dynamic>;
      await h.wc.rejectProposal((v['proposal'] as Map).cast<String, dynamic>(), {'code': 4001, 'message': 'no'});
      expect(h.relay.calls['rejectProposal']!.length, 1);
      expect(await h.wc.listSessions(), isEmpty);
    });
  });

  // =========================================================================
  // 4. REQUEST ROUTING — namespace enforcement first, then the signing surface.
  // =========================================================================
  group('request routing', () {
    Map<String, dynamic> req(String key) =>
        ((V['requests'] as Map)[key] as Map)['request'] as Map<String, dynamic>;
    Map<String, dynamic> reqCase(String key) => (V['requests'] as Map)[key] as Map<String, dynamic>;

    test('an out-of-namespace CHAIN is rejected 3001', () async {
      final h = await withSettledSession();
      final v = reqCase('out-of-namespace-chain');
      final resp = await h.wc.handleRequest(req('out-of-namespace-chain'), hooks(approve: true).ctx);
      expect(reqErr(resp), v['expectErrorCode']);
    });

    test('an out-of-namespace METHOD is rejected 3001', () async {
      final h = await withSettledSession();
      final v = reqCase('out-of-namespace-method');
      final resp = await h.wc.handleRequest(req('out-of-namespace-method'), hooks(approve: true).ctx);
      expect(reqErr(resp), v['expectErrorCode']);
    });

    test('an unknown topic is rejected 4202', () async {
      final h = await withSettledSession();
      final v = reqCase('unknown-topic');
      final resp = await h.wc.handleRequest(req('unknown-topic'), hooks(approve: true).ctx);
      expect(reqErr(resp), v['expectErrorCode']);
    });

    test('eth_accounts / eth_chainId are answered from session state (no prompt)', () async {
      final h = await withSettledSession();
      final seen = hooks(approve: true);
      final a = await h.wc.handleRequest(req('eth_accounts-read'), seen.ctx);
      expect(a['result'], equals(reqCase('eth_accounts-read')['expectResult']));
      final c = await h.wc.handleRequest(req('eth_chainId-read'), seen.ctx);
      expect(c['result'], reqCase('eth_chainId-read')['expectResult']);
      expect(seen.approveSeen.length, 0, reason: 'read methods never prompt');
    });

    test('eth_sendTransaction (clean) runs security inspect + explicit approval, then signs', () async {
      final h = await withSettledSession();
      final v = reqCase('eth_sendTransaction-clean-approved');
      final seen = hooks(approve: true);
      final resp = await h.wc.handleRequest(req('eth_sendTransaction-clean-approved'), seen.ctx);
      expect('${resp['result']}'.startsWith(v['expectResultMatch'] as String), isTrue);
      expect(seen.approveSeen.length, 1);
      expect(seen.approveSeen[0]['severity'], v['expectSeverity']);
      expect(h.signer.signed.length, 1);
    });

    test('eth_sendTransaction DANGER forces the extra confirm (fail-closed without one)', () async {
      final v = reqCase('eth_sendTransaction-danger-setApprovalForAll');
      final cases = (v['cases'] as Map).cast<String, dynamic>();
      // (a) no confirm handler wired -> BLOCKED 5000, never signs
      {
        final h = await withSettledSession();
        final c = (cases['no-confirm-handler-blocks'] as Map).cast<String, dynamic>();
        final resp = await h.wc.handleRequest(
            (v['request'] as Map).cast<String, dynamic>(), hooks(approve: c['approve'] as bool?, confirm: c['confirm'] as bool?).ctx);
        expect(reqErr(resp), c['expectErrorCode']);
        expect(h.signer.signed.length, 0);
      }
      // (b) confirm declined -> 4001, never signs
      {
        final h = await withSettledSession();
        final c = (cases['confirm-declined-rejects'] as Map).cast<String, dynamic>();
        final resp = await h.wc.handleRequest(
            (v['request'] as Map).cast<String, dynamic>(), hooks(approve: c['approve'] as bool?, confirm: c['confirm'] as bool?).ctx);
        expect(reqErr(resp), c['expectErrorCode']);
        expect(h.signer.signed.length, 0);
      }
      // (c) confirmed + approved -> signs
      {
        final h = await withSettledSession();
        final c = (cases['confirmed-and-approved-signs'] as Map).cast<String, dynamic>();
        final seen = hooks(approve: c['approve'] as bool?, confirm: c['confirm'] as bool?);
        final resp = await h.wc.handleRequest((v['request'] as Map).cast<String, dynamic>(), seen.ctx);
        expect('${resp['result']}'.startsWith(c['expectResultMatch'] as String), isTrue);
        expect(seen.confirmSeen.length, 1);
        expect(seen.approveSeen[0]['severity'], 'danger');
        expect(h.signer.signed.length, 1);
      }
    });

    test('a declined approval returns the user-rejected error 4001 (never signs)', () async {
      final h = await withSettledSession();
      final v = reqCase('eth_sendTransaction-declined-approval');
      final resp = await h.wc.handleRequest(req('eth_sendTransaction-declined-approval'), hooks(approve: false).ctx);
      expect(reqErr(resp), v['expectErrorCode']);
      expect(h.signer.signed.length, 0);
    });

    test('an external dApp signing request can NEVER auto-approve (no approve handler => fail-closed)', () async {
      final h = await withSettledSession();
      final resp = await h.wc.handleRequest(req('eth_sendTransaction-clean-approved'), const WcRequestCtx());
      expect(reqErr(resp), errBlocked, reason: 'fail-closed, not a silent sign');
      expect(h.signer.signed.length, 0);
    });

    test('eth_signTypedData_v4 Permit with an UNLIMITED allowance is DANGER', () async {
      final h = await withSettledSession();
      final v = reqCase('eth_signTypedData_v4-permit-unlimited-danger');
      final seen = hooks(approve: v['approve'] as bool?, confirm: v['confirm'] as bool?);
      final resp = await h.wc.handleRequest((v['request'] as Map).cast<String, dynamic>(), seen.ctx);
      final pres = seen.approveSeen[0];
      expect(pres['severity'], v['expectSeverity']);
      final codes = codesOf((pres['decoded'] as Map)['warnings']);
      for (final c in v['expectWarningsInclude'] as List) {
        expect(codes.contains(c), isTrue, reason: 'detects $c');
      }
      expect('${resp['result']}'.startsWith(v['expectResultMatch'] as String), isTrue);
      expect(seen.confirmSeen.length, 1);
      expect(h.signer.signed[0]['m'], 'ethSignTypedData');
    });

    test('eth_signTypedData_v4 a SIZED Permit with a short deadline is NOT danger', () async {
      final h = await withSettledSession();
      final v = reqCase('eth_signTypedData_v4-permit-sized-ok');
      final seen = hooks(approve: true);
      final resp = await h.wc.handleRequest((v['request'] as Map).cast<String, dynamic>(), seen.ctx);
      final pres = seen.approveSeen[0];
      expect(pres['severity'], isNot('danger'));
      final codes = codesOf((pres['decoded'] as Map)['warnings']);
      for (final c in v['expectWarningsInclude'] as List) {
        expect(codes.contains(c), isTrue, reason: 'still flags $c');
      }
      expect('${resp['result']}'.startsWith(v['expectResultMatch'] as String), isTrue);
    });

    test('eth_sign is REFUSED by default with an explanatory error (4100)', () async {
      final h = await withSettledSession();
      final v = reqCase('eth_sign-refused');
      final resp = await h.wc.handleRequest(req('eth_sign-refused'), hooks(approve: true).ctx);
      expect(reqErr(resp), v['expectErrorCode']);
      expect(RegExp(escapeRe(v['expectErrorMatch'] as String), caseSensitive: false).hasMatch(resp['error']['message'] as String), isTrue);
      expect(h.signer.signed.length, 0);
    });

    test('personal_sign decodes the UTF-8 message and signs on approval', () async {
      final h = await withSettledSession();
      final v = reqCase('personal_sign-decodes-message');
      final seen = hooks(approve: true);
      final resp = await h.wc.handleRequest(req('personal_sign-decodes-message'), seen.ctx);
      expect((seen.approveSeen[0]['decoded'] as Map)['text'], v['expectDecodedText']);
      expect('${resp['result']}'.startsWith(v['expectResultMatch'] as String), isTrue);
      expect(h.signer.signed[0]['m'], 'personalSign');
    });
  });

  // =========================================================================
  // 5. EXPIRY + sessions
  // =========================================================================
  group('expiry + sessions', () {
    test('a request on an EXPIRED session is rejected (4201)', () async {
      final v = (V['expiry'] as Map)['expired-session-rejected'] as Map<String, dynamic>;
      final h = makeWC();
      h.store.mem['wc:sessions'] = {
        v['session']['topic']: (v['session'] as Map).cast<String, dynamic>()
      };
      final resp = await h.wc.handleRequest((v['request'] as Map).cast<String, dynamic>(), hooks(approve: true).ctx);
      expect(reqErr(resp), v['expectErrorCode']);
      expect(h.signer.signed.length, 0);
    });

    test('list / get / disconnect round-trip via the injected store', () async {
      final h = await withSettledSession();
      final topic = (V['approval'] as Map)['intersection']['proposal']['sessionTopic'] as String;
      expect((await h.wc.listSessions()).length, 1);
      final got = await h.wc.getSession(topic);
      expect(got!['topic'], topic);
      final d = await h.wc.disconnect(topic, {'code': 6000, 'message': 'user disconnected'});
      expect(d['disconnected'], true);
      expect(h.relay.calls['disconnect']!.length, 1);
      expect((await h.wc.listSessions()).length, 0);
      expect(await h.wc.getSession(topic), isNull);
    });

    test('switching to an approved chain updates activeChainId (and is prompted)', () async {
      final h = await withSettledSession();
      final seen = hooks(approve: true);
      final resp = await h.wc.handleRequest(
          {'id': 30, 'topic': 'sess-abc', 'chainId': 'eip155:1', 'method': 'wallet_switchEthereumChain', 'params': [{'chainId': '0x2105'}]},
          seen.ctx);
      expect(resp['result'], isNull);
      expect(seen.approveSeen.length, 1, reason: 'a chain switch is still prompted, never silent');
      final got = await h.wc.getSession('sess-abc');
      expect(got!['activeChainId'], 'eip155:8453');
    });

    test('refusing to switch/add a chain the wallet does not have (4203)', () async {
      final h = await withSettledSession();
      final resp = await h.wc.handleRequest(
          {'id': 31, 'topic': 'sess-abc', 'chainId': 'eip155:1', 'method': 'wallet_switchEthereumChain', 'params': [{'chainId': '0xa4b1'}]},
          hooks(approve: true).ctx);
      expect(reqErr(resp), errUnsupportedChain);
    });

    test('a malformed chainId in switch/addChain returns a graceful error, never crashes the handler', () async {
      // A hostile/buggy dApp sends a missing or non-hex chainId. The handler must
      // return a JSON-RPC error, not throw a FormatException past its try/catch.
      for (final params in [
        <Map<String, dynamic>>[{}],              // chainId null
        <Map<String, dynamic>>[{'chainId': '0xZZ'}], // non-hex
      ]) {
        final h = await withSettledSession();
        // switchEthereumChain IS a settled method here, so the param guard catches
        // the malformed chainId and returns 4203 (not a thrown FormatException).
        final sw = await h.wc.handleRequest(
            {'id': 32, 'topic': 'sess-abc', 'chainId': 'eip155:1', 'method': 'wallet_switchEthereumChain', 'params': params},
            hooks(approve: true).ctx);
        expect(reqErr(sw), errUnsupportedChain, reason: 'switch with malformed chainId -> graceful error, never a crash');
        // addEthereumChain is caught earlier by namespace enforcement in this
        // session (3001); either way the handler returns a graceful error and the
        // request NEVER throws out of the handler.
        final add = await h.wc.handleRequest(
            {'id': 33, 'topic': 'sess-abc', 'chainId': 'eip155:1', 'method': 'wallet_addEthereumChain', 'params': params},
            hooks(approve: true).ctx);
        expect(reqErr(add), isNotNull, reason: 'add with malformed chainId -> graceful error, never a crash');
        expect(h.signer.signed.length, 0);
      }
    });
  });

  // =========================================================================
  // config toggle: eth_sign can be explicitly allowed (off by default)
  // =========================================================================
  test('config: allowEthSign=true lets eth_sign past the hard refusal (still namespace-gated)', () async {
    final h = await withSettledSession(config: {'allowEthSign': true});
    final resp = await h.wc.handleRequest(
        ((V['requests'] as Map)['eth_sign-refused'] as Map)['request'] as Map<String, dynamic>, hooks(approve: true).ctx);
    expect(reqErr(resp), isNot(errEthSignDisabled), reason: 'no longer a hard refusal when opted in');
    expect(reqErr(resp), errUnauthorized, reason: 'still namespace-gated');
  });

  // =========================================================================
  // relay glue: connectRelay routes an incoming relay request through handleRequest
  // =========================================================================
  test('connectRelay: an incoming relay request is routed through the same gate + responded', () async {
    final h = await withSettledSession();
    final seen = hooks(approve: true);
    h.wc.connectRelay(seen.ctx);
    await h.relay.emit(((V['requests'] as Map)['eth_sendTransaction-clean-approved'] as Map)['request'] as Map<String, dynamic>);
    expect(h.relay.calls['respond']!.length, 1);
    expect('${(h.relay.calls['respond']![0] as Map)['response']['result']}'.startsWith('0xhash'), isTrue);
    expect(h.signer.signed.length, 1);
  });
}
