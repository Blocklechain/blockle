// Token-discovery tests (AGENT-STRATEGIES.md section 7): the pinned scoring
// CANONICAL VECTOR (= 0.98 EXACTLY), deterministic + monotonic ranking, hard
// filters (liquidity/age/denylist/allowlist/chains/quote/verified), rejectFlags
// hard-drop, per-source toggles, and the SAFETY invariant that discovery never
// approves or trades — every candidate is approved=false until an explicit act.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/discovery.dart';

Map<String, dynamic> mkt({
  required String symbol,
  String pair = '',
  String chain = 'base',
  num? liquidityUsd = 100000,
  num? volume24hUsd = 50000,
  num? ageSec = 86400,
  bool verified = true,
  bool? honeypot,
  bool? liquidityLocked,
  String? address,
}) =>
    {
      'symbol': symbol,
      'pair': pair.isEmpty ? '$symbol/USDC' : pair,
      'chain': chain,
      'liquidityUsd': liquidityUsd,
      'volume24hUsd': volume24hUsd,
      'ageSec': ageSec,
      'verified': verified,
      if (honeypot != null) 'honeypot': honeypot,
      if (liquidityLocked != null) 'liquidityLocked': liquidityLocked,
      if (address != null) 'address': address,
    };

DiscoveryContext ctxWith(List<Map<String, dynamic>> markets) =>
    DiscoveryContext(getMarkets: () async => markets);

void main() {
  group('scoring — pinned', () {
    test('CANONICAL VECTOR scores EXACTLY 0.98', () {
      final s = scoreCandidate(
        liquidityUsd: 100000,
        volume24hUsd: 50000,
        ageSec: 86400,
        trust: 0.8, // exchangeListings
        softFlags: 0,
      );
      expect(s, 0.98);
    });

    test('a missing feature contributes 0 (never fabricated)', () {
      // no volume -> Vn drops out: 0.40 + 0 + 0.20 + 0.08 = 0.68
      final s = scoreCandidate(liquidityUsd: 100000, volume24hUsd: null, ageSec: 86400, trust: 0.8);
      expect(s, 0.68);
    });

    test('monotonic in liquidity and in volume', () {
      double sc(num liq, num vol) =>
          scoreCandidate(liquidityUsd: liq, volume24hUsd: vol, ageSec: 86400, trust: 0.8);
      expect(sc(50000, 50000) < sc(100000, 50000), isTrue);
      expect(sc(100000, 20000) < sc(100000, 50000), isTrue);
      expect(sc(100000, 50000), sc(200000, 50000)); // saturates at full
    });

    test('soft flags subtract penalty', () {
      final clean = scoreCandidate(liquidityUsd: 100000, volume24hUsd: 50000, ageSec: 86400, trust: 0.8);
      final flagged = scoreCandidate(liquidityUsd: 100000, volume24hUsd: 50000, ageSec: 86400, trust: 0.8, softFlags: 1);
      expect(clean - flagged, closeTo(0.25, 1e-9));
    });
  });

  group('scan — filter + rank + safety', () {
    test('canonical market scans to score 0.98, approved=false', () async {
      final d = Discovery(ctx: ctxWith([mkt(symbol: 'NEW')]));
      final out = await d.scan();
      expect(out, hasLength(1));
      expect(out.first.score, 0.98);
      expect(out.first.approved, isFalse); // NEVER auto-approved
      expect(out.first.flags, isEmpty);
    });

    test('SAFETY: discovery never approves — all candidates approved=false', () async {
      final d = Discovery(ctx: ctxWith([
        mkt(symbol: 'A'),
        mkt(symbol: 'B', liquidityUsd: 60000),
        mkt(symbol: 'C', volume24hUsd: 30000),
      ]));
      final out = await d.scan();
      expect(out, isNotEmpty);
      expect(out.every((c) => !c.approved), isTrue);
      // default consumption (approved-only) yields nothing to trade
      expect(out.where((c) => c.approved), isEmpty);
      // approval is an explicit, separate act (and still not a trade)
      expect(out.first.approve().approved, isTrue);
    });

    test('hard filter: sub-threshold liquidity is dropped', () async {
      final d = Discovery(ctx: ctxWith([
        mkt(symbol: 'OK', liquidityUsd: 50000),
        mkt(symbol: 'THIN', liquidityUsd: 500),
      ]));
      final out = await d.scan();
      expect(out.map((c) => c.symbol), ['OK']);
    });

    test('hard filter: too-new (below minAgeSec) is dropped', () async {
      final d = Discovery(ctx: ctxWith([
        mkt(symbol: 'FRESH', ageSec: 60),
        mkt(symbol: 'AGED', ageSec: 86400),
      ]));
      final out = await d.scan();
      expect(out.map((c) => c.symbol), ['AGED']);
    });

    test('hard filter: denylist drops; allowlist restricts', () async {
      final deny = Discovery(
        ctx: ctxWith([mkt(symbol: 'GOOD'), mkt(symbol: 'SCAM')]),
        config: const DiscoveryConfig(filters: DiscoveryFilters(denylist: ['SCAM'])),
      );
      expect((await deny.scan()).map((c) => c.symbol), ['GOOD']);

      final allow = Discovery(
        ctx: ctxWith([mkt(symbol: 'GOOD'), mkt(symbol: 'MEH')]),
        config: const DiscoveryConfig(filters: DiscoveryFilters(allowlist: ['GOOD'])),
      );
      expect((await allow.scan()).map((c) => c.symbol), ['GOOD']);
    });

    test('hard filter: chains and quoteAssets', () async {
      final d = Discovery(
        ctx: ctxWith([
          mkt(symbol: 'ONBASE', chain: 'base'),
          mkt(symbol: 'ONETH', chain: 'ethereum'),
          mkt(symbol: 'BADQUOTE', pair: 'BADQUOTE/DOGE'),
        ]),
        config: const DiscoveryConfig(filters: DiscoveryFilters(chains: ['base'])),
      );
      expect((await d.scan()).map((c) => c.symbol), ['ONBASE']);
    });

    test('requireVerified hard-drops unverified external candidates', () async {
      final d = Discovery(ctx: ctxWith([
        mkt(symbol: 'VERIF', verified: true),
        mkt(symbol: 'UNVERIF', verified: false),
      ]));
      expect((await d.scan()).map((c) => c.symbol), ['VERIF']);

      // with requireVerified off, it survives but carries an 'unverified' flag
      final d2 = Discovery(
        ctx: ctxWith([mkt(symbol: 'UNVERIF', verified: false)]),
        config: const DiscoveryConfig(filters: DiscoveryFilters(requireVerified: false)),
      );
      final out = await d2.scan();
      expect(out.single.flags, contains('unverified'));
    });

    test('rejectFlags hard-drops a honeypot', () async {
      final d = Discovery(ctx: ctxWith([
        mkt(symbol: 'TRAP', honeypot: true),
        mkt(symbol: 'FINE'),
      ]));
      expect((await d.scan()).map((c) => c.symbol), ['FINE']);
    });

    test('soft heuristic: liquidity-not-locked becomes a flag, not a drop', () async {
      final d = Discovery(ctx: ctxWith([mkt(symbol: 'UNLOCKED', liquidityLocked: false)]));
      final out = await d.scan();
      expect(out.single.flags, contains('liquidity-not-locked'));
    });

    test('ranked by score descending, then capped by maxCandidates', () async {
      final d = Discovery(
        ctx: ctxWith([
          mkt(symbol: 'HI'), // 0.98
          mkt(symbol: 'MID', volume24hUsd: 10000), // lower Vn
          mkt(symbol: 'LO', liquidityUsd: 20000, volume24hUsd: 5000),
        ]),
        config: const DiscoveryConfig(filters: DiscoveryFilters(maxCandidates: 2)),
      );
      final out = await d.scan();
      expect(out, hasLength(2));
      expect(out[0].score >= out[1].score, isTrue);
      expect(out[0].symbol, 'HI');
    });

    test('sources can be disabled individually', () async {
      final d = Discovery(
        ctx: ctxWith([mkt(symbol: 'NEW')]),
        config: const DiscoveryConfig(sources: DiscoverySources(exchangeListings: false)),
      );
      expect(await d.scan(), isEmpty);
    });

    test('watchlist + tokenLists read-only sources feed candidates', () async {
      final d = Discovery(
        ctx: DiscoveryContext(
          fetchTokenList: (url) async => [mkt(symbol: 'LISTED', address: '0xlisted')],
        ),
        config: const DiscoveryConfig(
          watchlist: [
            {'symbol': 'WATCH', 'pair': 'WATCH/USDC', 'chain': 'base', 'liquidityUsd': 100000, 'volume24hUsd': 50000, 'ageSec': 86400},
          ],
          tokenListUrls: ['https://tokens.example/list.json'],
        ),
      );
      final out = await d.scan();
      final syms = out.map((c) => c.symbol).toSet();
      expect(syms, containsAll(['WATCH', 'LISTED']));
      // watchlist is trusted as a candidate (trust 1.0) but still unapproved
      final w = out.firstWhere((c) => c.symbol == 'WATCH');
      expect(w.approved, isFalse);
    });

    test('dedup keeps the higher-trust source for the same address', () async {
      final d = Discovery(
        ctx: DiscoveryContext(
          getMarkets: () async => [mkt(symbol: 'DUP', address: '0xdup')], // trust 0.8
          venuePairs: () async => [mkt(symbol: 'DUP', address: '0xdup')], // trust 0.5
        ),
      );
      final out = await d.scan();
      expect(out, hasLength(1));
      expect(out.single.source, 'exchangeListings'); // higher trust wins
    });
  });
}
