// multichain/autoimport_test.dart — auto-detect + auto-import held tokens on EVERY
// chain. Pins the shared contract (docs/scan-vectors.json -> tokenImport): a real
// positive balance is auto-imported; a default / zero-balance row is not; dedupe by
// (chain, contract|mint); the security suite (denylist / scam flags / spam) MARKS a
// token instead of importing it; re-running imports nothing (idempotent). The
// orchestrator persists into the SAME store keys a manual import writes.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/autoimport.dart';

Map<String, dynamic> _loadVec() {
  for (final p in const [
    '../docs/scan-vectors.json',
    'docs/scan-vectors.json',
    '../../docs/scan-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return ((jsonDecode(f.readAsStringSync()) as Map)['tokenImport'] as Map)
          .cast<String, dynamic>();
    }
  }
  throw StateError('scan-vectors.json not found (cwd=${Directory.current.path})');
}

final VEC = _loadVec();

List<String> _denylist() => List<String>.from(VEC['denylist'] as List);

// A chrome.storage-shaped in-memory shim.
class FakeStore {
  final Map<String, dynamic> data;
  FakeStore([Map<String, dynamic>? initial])
      : data = {
          'chainTokens': <String, dynamic>{},
          'tokens': <dynamic>[],
          'flaggedTokens': <String, dynamic>{},
          ...?initial,
        };
  Future<Map<String, dynamic>> get(dynamic keys) async {
    final ks = keys is List ? keys : [keys];
    final out = <String, dynamic>{};
    for (final k in ks) {
      out['$k'] = data['$k'];
    }
    return out;
  }

  Future<void> set(Map<String, dynamic> obj) async => data.addAll(obj);
}

// A duck-typed ChainRegistry whose discoverTokens returns the per-chain fixture.
class FakeRegistry {
  final Map<String, List<dynamic>> perChain;
  FakeRegistry(this.perChain);
  List<String> enabled() => perChain.keys.toList();
  Future<List<dynamic>> discoverTokens(
          String chain, dynamic addr, dynamic opts) async =>
      perChain[chain] ?? const [];
}

void main() {
  final expect0 = (VEC['expect'] as Map).cast<String, dynamic>();
  final imported = expect0['imported'] as List;
  final ethDetected = ((VEC['detected'] as Map)['ethereum'] as List);
  final solDetected = ((VEC['detected'] as Map)['solana'] as List);

  // =========================================================================
  // SHARED VECTOR: detected balances -> the exact imported / flagged / skipped sets
  // =========================================================================
  test('token-import vector: ethereum detected balances classify exactly', () {
    final r = filterForImport(ethDetected, const [],
        denylist: _denylist(), spamFilter: VEC['spamFilter'] == true);
    expect(r.toImport.map((x) => x['token']).toList(),
        [(imported[0] as Map).cast<String, dynamic>()]);
    expect(
        r.flagged
            .map((f) => {'symbol': (f['token'] as Map)['symbol'], 'reason': f['reason']})
            .toList(),
        [
          {'symbol': 'CLAIM', 'reason': 'spam'},
          {'symbol': 'EVIL', 'reason': 'denylist'}
        ]);
    expect(
        r.skipped
            .map((s) => {'symbol': (s['token'] as Map)['symbol'], 'reason': s['reason']})
            .toList(),
        [
          {'symbol': 'USDC', 'reason': 'default'},
          {'symbol': 'ZERO', 'reason': 'zero-balance'}
        ]);
  });

  test('token-import vector: solana SPL detected balance is imported', () {
    final r = filterForImport(solDetected, const [],
        denylist: _denylist(), spamFilter: VEC['spamFilter'] == true);
    expect(r.toImport.map((x) => x['token']).toList(),
        [(imported[1] as Map).cast<String, dynamic>()]);
  });

  // =========================================================================
  // NEVER FABRICATE: a token with no (or zero) detected balance is never imported
  // =========================================================================
  test('a zero-balance / no-balance token is never auto-imported (never fabricate)', () {
    final discovered = [
      {'chain': 'ethereum', 'kind': 'erc20', 'symbol': 'ZERO', 'decimals': 18, 'address': '0xaaa', 'balance': '0'},
      {'chain': 'ethereum', 'kind': 'erc20', 'symbol': 'NOBAL', 'decimals': 18, 'address': '0xbbb'},
    ];
    final r = filterForImport(discovered, const []);
    expect(r.toImport.length, 0);
    expect(r.skipped.map((s) => s['reason']).toList(), ['zero-balance', 'zero-balance']);
  });

  // =========================================================================
  // SECURITY: a flagged / denylisted / spam token is MARKED, never imported/traded
  // =========================================================================
  test('a denylisted token is flagged, never imported', () {
    final discovered = [
      {'chain': 'ethereum', 'kind': 'erc20', 'symbol': 'BAD', 'decimals': 18, 'address': '0xBAD', 'balance': '100'}
    ];
    final r = filterForImport(discovered, const [], denylist: ['0xbad']);
    expect(r.toImport.length, 0);
    expect(r.flagged[0]['reason'], 'denylist');
  });

  test('a scam/honeypot-flagged token is flagged, never imported', () {
    final discovered = [
      {'chain': 'ethereum', 'kind': 'erc20', 'symbol': 'HP', 'decimals': 18, 'address': '0xhp', 'balance': '100', 'flags': ['honeypot']}
    ];
    final r = filterForImport(discovered, const []);
    expect(r.toImport.length, 0);
    expect(r.flagged[0]['reason'], 'honeypot');
  });

  // =========================================================================
  // DEDUPE + IDEMPOTENT: re-running with the import already persisted adds nothing
  // =========================================================================
  test('re-running is idempotent — an already-imported token is not imported again', () {
    final first = filterForImport(ethDetected, const [],
        denylist: _denylist(), spamFilter: true);
    final persisted = first.toImport.map((x) => x['token']).toList();
    final second = filterForImport(ethDetected, persisted,
        denylist: _denylist(), spamFilter: true);
    expect(second.toImport, (expect0['idempotent_rerun_imports'] as List));
    expect(
        second.skipped.any((s) =>
            (s['token'] as Map)['symbol'] == 'DAI' && s['reason'] == 'already-imported'),
        true);
  });

  // =========================================================================
  // ORCHESTRATOR: runs discovery for EVERY chain + persists into the manual-import
  // store keys (chainTokens for EVM/Solana, tokens for BLOCK-20).
  // =========================================================================
  test('orchestrator: auto-imports across every chain into the persisted lists', () async {
    final store = FakeStore();
    final registry = FakeRegistry({
      'ethereum': ethDetected,
      'solana': solDetected,
    });
    final summary = await autoImport(
      registry: registry,
      store: store,
      denylist: _denylist(),
      spamFilter: true,
      addressFor: (_) async => '0xMyAddress',
    );

    expect((store.data['chainTokens'] as Map)['ethereum'],
        [(imported[0] as Map).cast<String, dynamic>()]);
    expect((store.data['chainTokens'] as Map)['solana'],
        [(imported[1] as Map).cast<String, dynamic>()]);
    final flaggedEth = (store.data['flaggedTokens'] as Map)['ethereum'] as List;
    expect(flaggedEth.length, 2);
    expect((flaggedEth.map((f) => (f as Map)['reason']).toList()..sort()),
        ['denylist', 'spam']);
    expect((summary['imported'] as List).length, 2);
    expect(summary['changed'], true);
  });

  test('orchestrator: a second run changes nothing (incremental + idempotent)', () async {
    final registry = FakeRegistry({'ethereum': ethDetected, 'solana': solDetected});
    final store = FakeStore();
    await autoImport(
        registry: registry, store: store, denylist: _denylist(), addressFor: (_) async => '0xMe');
    final snapshot = jsonEncode(store.data);
    final summary2 = await autoImport(
        registry: registry, store: store, denylist: _denylist(), addressFor: (_) async => '0xMe');
    expect(summary2['changed'], false);
    expect(jsonEncode(store.data), snapshot);
  });

  test('orchestrator: a BLOCK-20 discovered token persists into the `tokens` id array',
      () async {
    final store = FakeStore();
    final registry = FakeRegistry({
      'block': [
        {'chain': 'block', 'kind': 'block20', 'symbol': 'MEME', 'decimals': 8, 'id': 'abc123', 'address': 'abc123', 'balance': '500'}
      ],
    });
    await autoImport(registry: registry, store: store, addressFor: (_) async => 'block1addr');
    expect(store.data['tokens'], ['abc123']);
  });
}
