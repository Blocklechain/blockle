// multichain/portfolio_test.dart — WALLET PORTFOLIO net worth + daily snapshot
// (§1/§2.1), Dart port of blockle-extension/portfolio.test.js. Asserts the
// implementation against the AUTHORITATIVE shared fixture
// docs/portfolio-vectors.json (consumed, never edited) plus unit tests for the
// integer money math, the never-guess unpriced rule, and the append-only
// dedup-by-day snapshot store.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/portfolio.dart' as P;

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

P.PortfolioCtx _nwCtx(Map nw) {
  final byChain = nw['holdingsByChain'] as Map;
  return P.PortfolioCtx(
    asOf: (nw['asOf'] as num).toInt(),
    priceUsd: (nw['priceUsd'] as Map).cast<String, dynamic>(),
    getHoldings: (chain, address) async => (byChain[chain] as List?) ?? const [],
  );
}

void main() {
  // =========================================================================
  // 1. CANONICAL NET-WORTH VECTOR — exact micro-dollar total + byChain bps
  // =========================================================================
  test('vector: net worth aggregates priced, excludes unpriced, exact micro-dollars',
      () async {
    final nw = V['netWorth'] as Map;
    final pf = await P.portfolio(nw['accounts'] as List, _nwCtx(nw));
    final e = nw['expect'] as Map;

    expect(pf.totalUsdMicro, e['totalUsdMicro'], reason: 'exact micro-dollar total');
    expect(pf.totalUsd, (e['totalUsd'] as num).toDouble(), reason: 'convenience dollar total');
    expect(pf.asOf, (nw['asOf'] as num).toInt(), reason: 'injected asOf echoed, never a clock call');

    final eByChain = e['byChain'] as List;
    expect(pf.byChain.length, eByChain.length, reason: 'byChain chain count (unpriced chain absent)');
    for (var i = 0; i < eByChain.length; i++) {
      expect(pf.byChain[i]['chain'], eByChain[i]['chain']);
      expect(pf.byChain[i]['usdMicro'], eByChain[i]['usdMicro']);
      expect(pf.byChain[i]['pctBps'], eByChain[i]['pctBps']);
    }
    // basis points sum to 10000 across priced chains (exact split, no drift)
    expect(pf.byChain.fold<int>(0, (a, c) => a + (c['pctBps'] as int)), 10000);

    // priced holdings in value order with exact per-holding micro-dollars
    final priced = pf.holdings.where((h) => h['pricedOk'] == true).toList();
    final eHoldings = e['holdings'] as List;
    expect(priced.length, eHoldings.length);
    for (var i = 0; i < eHoldings.length; i++) {
      expect(priced[i]['chain'], eHoldings[i]['chain']);
      expect(priced[i]['symbol'], eHoldings[i]['symbol']);
      expect(priced[i]['usdMicro'], eHoldings[i]['usdMicro']);
    }

    // the unpriced holding is SHOWN but NEVER counted and NEVER guessed as 0
    final eUnpriced = e['unpriced'] as List;
    expect(pf.unpriced.length, eUnpriced.length);
    expect(pf.unpriced[0]['chain'], eUnpriced[0]['chain']);
    expect(pf.unpriced[0]['symbol'], eUnpriced[0]['symbol']);
    expect(pf.unpriced[0]['amountBase'], eUnpriced[0]['amountBase']);
    final unpricedHolding = pf.holdings.firstWhere((h) => h['pricedOk'] != true);
    expect(unpricedHolding['usdMicro'], isNull, reason: 'unpriced holding has null usd (not 0)');
  });

  // =========================================================================
  // integer money math — BigInt exact, half-away-from-zero, never a float guess
  // =========================================================================
  test('microUsd: round(usd*1e6) half-away-from-zero', () {
    expect(P.microUsd(2000), BigInt.parse('2000000000'));
    expect(P.microUsd(0.5), BigInt.parse('500000'));
    expect(P.microUsd(1), BigInt.parse('1000000'));
    expect(P.microUsd(null), isNull, reason: 'unknown price stays null (never 0)');
  });

  test('holdingMicro: exact base-unit -> micro-dollar conversion', () {
    expect(P.holdingMicro('1000000000000000000', 18, 2000).toString(), '2000000000');
    expect(P.holdingMicro('500000000', 6, 1).toString(), '500000000');
    expect(P.holdingMicro('1000000000', 8, 0.5).toString(), '5000000');
    expect(P.holdingMicro('123', 6, null), isNull);
  });

  test('portfolio: an empty / all-unpriced wallet is total 0 with no fabricated value',
      () async {
    final pf = await P.portfolio([
      {'chain': 'solana', 'address': 'x'}
    ], P.PortfolioCtx(priceUsd: const {}, getHoldings: (chain, address) async => [
          {
            'asset': {'symbol': 'XYZ', 'decimals': 6},
            'confirmed': '5'
          }
        ]));
    expect(pf.totalUsdMicro, '0');
    expect(pf.byChain.length, 0);
    expect(pf.unpriced.length, 1);
  });

  // =========================================================================
  // §2.1 DAILY SNAPSHOT STORE — append-only, dedup by UTC day, injected clock
  // =========================================================================
  test('vector: snapshot store dedups by day (latest total for a day wins)', () {
    final ss = V['snapshotStore'] as Map;
    var hist = <Map<String, dynamic>>[
      for (final x in (ss['start'] as List)) Map<String, dynamic>.from(x as Map)
    ];
    for (final a in (ss['appends'] as List)) {
      hist = P.recordSnapshot(hist, a as Map);
    }
    final points = (ss['expect'] as Map)['points'] as List;
    expect(hist.length, points.length, reason: 'one point per distinct day');
    for (var i = 0; i < points.length; i++) {
      expect(hist[i]['day'], points[i]['day']);
      expect(hist[i]['totalUsdMicro'], points[i]['totalUsdMicro']);
    }
  });

  test('recordSnapshot: pure (never mutates input) + sorted by ts', () {
    final h0 = <Map<String, dynamic>>[];
    final h1 = P.recordSnapshot(h0, {'ts': 1700100000000, 'totalUsdMicro': '10'});
    final h2 = P.recordSnapshot(h1, {'ts': 1700000000000, 'totalUsdMicro': '20'});
    expect(h0.length, 0, reason: 'input untouched');
    expect(h1.length, 1);
    expect(h2.length, 2);
    expect((h2[0]['ts'] as num) < (h2[1]['ts'] as num), isTrue, reason: 'sorted ascending by ts');
  });

  test('sparkline: last N points as {ts,totalUsdMicro,usd}', () {
    var hist = <Map<String, dynamic>>[];
    for (var d = 0; d < 40; d++) {
      hist = P.recordSnapshot(hist, {'ts': d * P.kDayMs, 'totalUsdMicro': '${d * 1000000}'});
    }
    final sp = P.sparkline(hist, 30);
    expect(sp.length, 30);
    expect(sp[sp.length - 1]['usd'], 39, reason: 'last point in dollars');
    expect(sp[0]['totalUsdMicro'], '10000000');
  });
}
