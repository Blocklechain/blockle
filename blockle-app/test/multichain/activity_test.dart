// multichain/activity_test.dart — WALLET ACTIVITY merged cross-chain feed (§2),
// Dart port of blockle-extension/activity.test.js. Asserts against the
// AUTHORITATIVE shared fixture docs/portfolio-vectors.json: merge/sort order,
// the security-decoder-reused `kind`, the counterparty flag (a denylisted
// recipient stays flagged in history), STABLE paging, and the "unavailable
// indexer => audited note, never a fabricated empty feed" rule.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/activity.dart' as A;

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/portfolio-vectors.json',
    'docs/portfolio-vectors.json',
    '../../docs/portfolio-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('portfolio-vectors.json not found (cwd=${Directory.current.path})');
}

final V = _loadVectors();

A.ActivityCtx _actCtx(Map av) {
  final hist = av['history'] as Map;
  return A.ActivityCtx(
    securityConfig: (av['securityConfig'] as Map).cast<String, dynamic>(),
    history: (chain, address) async => (hist[chain] as List?) ?? const [],
  );
}

List<String> _idsOf(List items) => [for (final i in items) '${(i as Map)['txid']}'];

void main() {
  // =========================================================================
  // CANONICAL MERGE/SORT VECTOR — newest-first, decoded kinds, flagged counterparty
  // =========================================================================
  test('vector: merged feed is time-sorted with security-decoded kinds + counterparty flag',
      () async {
    final av = V['activity'] as Map;
    final r = await A.activity(av['accounts'] as List, _actCtx(av), const A.ActivityOpts(limit: 100));
    final e = (av['expect'] as Map)['merged'] as List;
    expect(r.items.length, e.length, reason: 'all items merged');
    for (var i = 0; i < e.length; i++) {
      expect(r.items[i]['chain'], e[i]['chain']);
      expect(r.items[i]['txid'], e[i]['txid'], reason: 'sort order');
      expect(r.items[i]['ts'], e[i]['ts']);
      expect(r.items[i]['kind'], e[i]['kind'], reason: 'reused security decoder');
      expect(r.items[i]['direction'], e[i]['direction']);
      expect(r.items[i]['flagged'], e[i]['flagged']);
    }
    // the flagged item carries the security warning code, matching the pre-sign suite
    final flagged = r.items.firstWhere((i) => i['flagged'] == true);
    expect((flagged['warnings'] as List).contains('send-to-flagged'), isTrue,
        reason: 'flag reason comes from the security suite');
  });

  // =========================================================================
  // STABLE PAGING — cursor-based, deterministic across calls
  // =========================================================================
  test('vector: paging is stable — page1 cursor yields exactly the remaining items',
      () async {
    final av = V['activity'] as Map;
    final ctx = _actCtx(av);
    final page1 = (av['expect'] as Map)['page1'] as Map;
    final page2 = (av['expect'] as Map)['page2'] as Map;

    final p1 = await A.activity(av['accounts'] as List, ctx,
        A.ActivityOpts(limit: (page1['limit'] as num).toInt()));
    expect(_idsOf(p1.items), (page1['ids'] as List).cast<String>());
    expect(p1.nextCursor, page1['nextCursor']);

    final p2 = await A.activity(av['accounts'] as List, ctx,
        A.ActivityOpts(limit: (page2['limit'] as num).toInt(), cursor: p1.nextCursor));
    expect(_idsOf(p2.items), (page2['ids'] as List).cast<String>());
    expect(p2.nextCursor == null, page2['nextCursor'] == null);

    // no item appears on both pages (stable, non-overlapping)
    final overlap = p1.items.where((a) => p2.items.any((b) => b['txid'] == a['txid']));
    expect(overlap.length, 0, reason: 'pages do not overlap');
  });

  // =========================================================================
  // UNAVAILABLE INDEXER — audited note, never a fabricated empty "no activity"
  // =========================================================================
  test('an unavailable indexer contributes nothing + an audited note', () async {
    final r = await A.activity([
      {'chain': 'ethereum', 'address': '0xE'}
    ], const A.ActivityCtx(), const A.ActivityOpts());
    expect(r.items.length, 0);
    expect(r.notes.length, 1, reason: 'one audited note for the unavailable chain');
    expect('${r.notes[0]['note']}'.contains('not a claim of no activity'), isTrue);
  });

  test('a throwing indexer is noted (fails safe), a real empty list is NOT noted',
      () async {
    final throwing = await A.activity([
      {'chain': 'ethereum', 'address': '0xE'}
    ], A.ActivityCtx(history: (chain, address) async => throw Exception('rate limited')),
        const A.ActivityOpts());
    expect(throwing.items.length, 0);
    expect(throwing.notes.length, 1);
    expect('${throwing.notes[0]['note']}'.contains('indexer error'), isTrue);

    final emptyReal = await A.activity([
      {'chain': 'ethereum', 'address': '0xE'}
    ], A.ActivityCtx(history: (chain, address) async => const []), const A.ActivityOpts());
    expect(emptyReal.items.length, 0);
    expect(emptyReal.notes.length, 0,
        reason: 'a genuine empty history is not an audited unavailability');
  });

  // =========================================================================
  // order is a strict stable total order (ts desc, chain asc, txid asc)
  // =========================================================================
  test('cmp: stable total order ts-desc, chain-asc, txid-asc', () {
    final a = {'ts': 100, 'chain': 'ethereum', 'txid': '0xaa'};
    final b = {'ts': 100, 'chain': 'ethereum', 'txid': '0xbb'};
    final c = {'ts': 200, 'chain': 'solana', 'txid': '0xaa'};
    expect(A.cmp(c, a) < 0, isTrue, reason: 'newer first');
    expect(A.cmp(a, b) < 0, isTrue, reason: 'same ts+chain: txid ascending');
    final list = [a, c, b]..sort(A.cmp);
    expect([for (final x in list) x['txid']], ['0xaa', '0xaa', '0xbb']);
  });
}
