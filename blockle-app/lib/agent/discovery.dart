// agent/discovery.dart — the configurable, READ-ONLY token-discovery feed
// (AGENT-STRATEGIES.md section 7), one of three numerically-identical
// implementations (JS / Dart / Python).
//
// Discovery finds and RANKS candidate tokens/pairs. It is strictly read-only:
//   • it NEVER trades, signs, or broadcasts;
//   • it NEVER auto-adds a token to the policy allowlist;
//   • every candidate is `approved=false` until an explicit user action.
// Feeding a discovered token to a strategy still passes the full gate at
// dispatch, so an unapproved token can only ever produce a `blocked` audit note —
// never a trade. This keeps the non-bypassable safety model intact.
//
// Pipeline:  gather (enabled sources) -> dedup -> filter (hard drops)
//            -> flag (soft rug/scam heuristics) -> score -> rank -> cap.
//
// Scoring is the pinned weighted sum so the three languages agree exactly:
//   score = clamp01( 0.40·Ln + 0.30·Vn + 0.20·An + 0.10·Tn − 0.25·flagPenalty )
// Canonical vector: liq=100000, vol=50000, age=86400, source=exchangeListings
// (trust 0.8), 0 flags  ->  0.40 + 0.30 + 0.20 + 0.08 = 0.98 (asserted exactly).

import 'dart:math' as math;

/// Trust weight (Tn) per source. Higher = the surface is more curated.
const Map<String, double> kSourceTrust = {
  'watchlist': 1.0,
  'exchangeListings': 0.8,
  'blockLaunches': 0.7,
  'venuePairs': 0.5,
  'tokenLists': 0.4,
};

/// Sources that are "external" (not user-supplied). `requireVerified` applies to
/// these; watchlist is always trusted as a candidate (still never auto-traded).
const Set<String> kExternalSources = {
  'blockLaunches',
  'exchangeListings',
  'venuePairs',
  'tokenLists',
};

double _clamp01(double x) => x < 0 ? 0.0 : (x > 1 ? 1.0 : x);

/// Round to 12 decimals to kill float noise and stay identical across languages.
double _round12(double x) => (x * 1e12).roundToDouble() / 1e12;

num? _num(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  return num.tryParse('$v');
}

/// Tunable scoring weights (pinned defaults match §7).
class ScoringWeights {
  final double liquidity; // 0.40
  final double volume; // 0.30
  final double age; // 0.20
  final double trust; // 0.10
  final double flagPenalty; // 0.25 per soft flag
  final double liquidityFull; // 100000 -> Ln saturates
  final double volumeFull; // 50000  -> Vn saturates
  final double ageSweetSpotSec; // 86400 (~1 day)
  final double ageSpread; // 3 (ln-distance divisor)

  const ScoringWeights({
    this.liquidity = 0.40,
    this.volume = 0.30,
    this.age = 0.20,
    this.trust = 0.10,
    this.flagPenalty = 0.25,
    this.liquidityFull = 100000,
    this.volumeFull = 50000,
    this.ageSweetSpotSec = 86400,
    this.ageSpread = 3,
  });
}

/// The pinned score. A missing feature contributes 0 (never fabricated).
double scoreCandidate({
  num? liquidityUsd,
  num? volume24hUsd,
  num? ageSec,
  required double trust,
  int softFlags = 0,
  ScoringWeights weights = const ScoringWeights(),
}) {
  final ln = liquidityUsd == null
      ? 0.0
      : math.min(1.0, liquidityUsd / weights.liquidityFull);
  final vn = volume24hUsd == null
      ? 0.0
      : math.min(1.0, volume24hUsd / weights.volumeFull);
  final an = ageSec == null
      ? 0.0
      : _clamp01(1 -
          (math.log(ageSec / weights.ageSweetSpotSec)).abs() / weights.ageSpread);
  final tn = trust;
  final raw = weights.liquidity * ln +
      weights.volume * vn +
      weights.age * an +
      weights.trust * tn -
      weights.flagPenalty * softFlags;
  return _round12(_clamp01(raw));
}

/// A ranked discovery result. `approved` is false until an explicit user action.
class Candidate {
  final String? chain;
  final String symbol;
  final String? address;
  final String? pair; // e.g. 'NEW/USDC'
  final String? venue;
  final String source;
  final num? liquidityUsd;
  final num? volume24hUsd;
  final num? ageSec;
  final double score;
  final List<String> flags;
  final bool approved;

  const Candidate({
    this.chain,
    required this.symbol,
    this.address,
    this.pair,
    this.venue,
    required this.source,
    this.liquidityUsd,
    this.volume24hUsd,
    this.ageSec,
    required this.score,
    this.flags = const [],
    this.approved = false,
  });

  /// Return an approved copy. This is the ONLY way `approved` becomes true, and
  /// a host must call it from an explicit user action — discovery itself never
  /// does. Approval alone still does not trade: the full gate applies at dispatch.
  Candidate approve() => Candidate(
        chain: chain,
        symbol: symbol,
        address: address,
        pair: pair,
        venue: venue,
        source: source,
        liquidityUsd: liquidityUsd,
        volume24hUsd: volume24hUsd,
        ageSec: ageSec,
        score: score,
        flags: flags,
        approved: true,
      );

  Map<String, dynamic> toJson() => {
        'chain': chain,
        'symbol': symbol,
        'address': address,
        'pair': pair,
        'venue': venue,
        'source': source,
        'liquidityUsd': liquidityUsd,
        'volume24hUsd': volume24hUsd,
        'ageSec': ageSec,
        'score': score,
        'flags': flags,
        'approved': approved,
      };
}

/// Which sources are enabled. Each is independently toggleable.
class DiscoverySources {
  final bool blockLaunches;
  final bool exchangeListings;
  final bool venuePairs;
  final bool tokenLists;
  final bool watchlist;

  const DiscoverySources({
    this.blockLaunches = true,
    this.exchangeListings = true,
    this.venuePairs = true,
    this.tokenLists = true,
    this.watchlist = true,
  });

  bool enabled(String source) {
    switch (source) {
      case 'blockLaunches':
        return blockLaunches;
      case 'exchangeListings':
        return exchangeListings;
      case 'venuePairs':
        return venuePairs;
      case 'tokenLists':
        return tokenLists;
      case 'watchlist':
        return watchlist;
      default:
        return false;
    }
  }
}

/// Conservative hard/soft filter thresholds (§7 defaults).
class DiscoveryFilters {
  final num minLiquidityUsd; // 10000
  final num minAgeSec; // 3600 — avoid 0-block honeypots
  final num? maxAgeSec; // null
  final List<String>? chains; // null = any
  final List<String> quoteAssets; // default ['USDC','USDT','BLOCK']
  final bool requireVerified; // true for external sources
  final List<String> allowlist; // symbols or addresses (empty = allow all)
  final List<String> denylist; // symbols or addresses
  final int maxCandidates; // 50

  /// Flags that HARD-DROP a candidate (default includes 'honeypot').
  final Set<String> rejectFlags;

  /// Below this age (seconds) a candidate is tagged with a soft 'new' flag (it
  /// is not dropped unless it also fails `minAgeSec`). Default = the sweet spot.
  final num newBelowSec;

  const DiscoveryFilters({
    this.minLiquidityUsd = 10000,
    this.minAgeSec = 3600,
    this.maxAgeSec,
    this.chains,
    this.quoteAssets = const ['USDC', 'USDT', 'BLOCK'],
    this.requireVerified = true,
    this.allowlist = const [],
    this.denylist = const [],
    this.maxCandidates = 50,
    Set<String>? rejectFlags,
    this.newBelowSec = 86400,
  }) : rejectFlags = rejectFlags ?? const {'honeypot'};
}

/// Full discovery configuration.
class DiscoveryConfig {
  final DiscoverySources sources;
  final DiscoveryFilters filters;
  final ScoringWeights weights;

  /// User-supplied watchlist entries (symbols/addresses/pairs). Each becomes a
  /// candidate from the 'watchlist' source (trusted as a candidate, not traded).
  final List<Map<String, dynamic>> watchlist;

  /// Operator-configured token-list URLs (CoinGecko-/Uniswap-style JSON). Fetched
  /// READ-ONLY via the injected fetcher; nothing hardcoded, no wallet data sent.
  final List<String> tokenListUrls;

  const DiscoveryConfig({
    this.sources = const DiscoverySources(),
    this.filters = const DiscoveryFilters(),
    this.weights = const ScoringWeights(),
    this.watchlist = const [],
    this.tokenListUrls = const [],
  });
}

/// Injected READ-ONLY data sources. Every one is optional; a null source (or a
/// disabled one in config) simply contributes nothing. None of these may send
/// wallet data — they are pure reads of public market/launch/list data.
class DiscoveryContext {
  /// New BLOCK-20 launches / new native AMM pools.
  final Future<List<Map<String, dynamic>>> Function()? blockLaunches;

  /// Exchange markets (we surface ones not previously seen — see [seen]).
  final Future<List<Map<String, dynamic>>> Function()? getMarkets;

  /// New pools/pairs on connected DEX venues.
  final Future<List<Map<String, dynamic>>> Function()? venuePairs;

  /// Read-only fetch of a token-list URL -> a list of raw token records.
  final Future<List<Map<String, dynamic>>> Function(String url)? fetchTokenList;

  /// Set of identifiers (symbol or address) already known, so exchangeListings
  /// surfaces only NEW markets. Optional.
  final Set<String> Function()? seen;

  const DiscoveryContext({
    this.blockLaunches,
    this.getMarkets,
    this.venuePairs,
    this.fetchTokenList,
    this.seen,
  });
}

class Discovery {
  final DiscoveryContext ctx;
  final DiscoveryConfig config;

  Discovery({required this.ctx, DiscoveryConfig? config})
      : config = config ?? const DiscoveryConfig();

  /// Dedup + filter + score + rank. READ-ONLY. Returns ranked [Candidate]s,
  /// all `approved=false`.
  Future<List<Candidate>> scan() async {
    final raw = <Map<String, dynamic>>[];

    Future<void> gather(
      String source,
      Future<List<Map<String, dynamic>>> Function()? fn,
    ) async {
      if (!config.sources.enabled(source) || fn == null) return;
      try {
        for (final r in await fn()) {
          raw.add({...r, 'source': source});
        }
      } catch (_) {
        // A flaky read source must never take down discovery.
      }
    }

    await gather('blockLaunches', ctx.blockLaunches);
    await gather('exchangeListings', () async {
      final markets = ctx.getMarkets == null ? <Map<String, dynamic>>[] : await ctx.getMarkets!();
      final seen = ctx.seen?.call() ?? const <String>{};
      return markets.where((m) {
        final id = '${m['address'] ?? m['symbol'] ?? m['pair'] ?? ''}';
        return id.isEmpty || !seen.contains(id);
      }).toList();
    });
    await gather('venuePairs', ctx.venuePairs);

    // watchlist (config-supplied)
    if (config.sources.watchlist) {
      for (final w in config.watchlist) {
        raw.add({...w, 'source': 'watchlist'});
      }
    }

    // tokenLists (operator URLs, read-only fetch)
    if (config.sources.tokenLists && ctx.fetchTokenList != null) {
      for (final url in config.tokenListUrls) {
        try {
          for (final t in await ctx.fetchTokenList!(url)) {
            raw.add({...t, 'source': 'tokenLists'});
          }
        } catch (_) {}
      }
    }

    // ---- dedup (chain+address, else symbol+pair+source) keeping best source ---
    final byKey = <String, Map<String, dynamic>>{};
    for (final r in raw) {
      final addr = r['address'];
      final key = addr != null
          ? '${r['chain'] ?? ''}:$addr'.toLowerCase()
          : '${r['symbol'] ?? ''}/${r['pair'] ?? ''}'.toLowerCase();
      final prev = byKey[key];
      if (prev == null) {
        byKey[key] = r;
      } else {
        // keep the higher-trust source
        final a = kSourceTrust[r['source']] ?? 0;
        final b = kSourceTrust[prev['source']] ?? 0;
        if (a > b) byKey[key] = r;
      }
    }

    final out = <Candidate>[];
    for (final r in byKey.values) {
      final c = _evaluate(r);
      if (c != null) out.add(c);
    }

    out.sort((a, b) {
      final d = b.score.compareTo(a.score);
      if (d != 0) return d;
      return a.symbol.compareTo(b.symbol); // stable tiebreak
    });

    final cap = config.filters.maxCandidates;
    return cap > 0 && out.length > cap ? out.sublist(0, cap) : out;
  }

  /// Apply hard filters (drop -> null), gather soft flags, and score.
  Candidate? _evaluate(Map<String, dynamic> r) {
    final f = config.filters;
    final source = '${r['source']}';
    final symbol = '${r['symbol'] ?? r['base'] ?? '?'}';
    final chain = r['chain'] as String?;
    final address = r['address'] as String?;
    final pair = r['pair'] as String?;
    final liquidityUsd = _num(r['liquidityUsd']);
    final volume24hUsd = _num(r['volume24hUsd']);
    final ageSec = _num(r['ageSec']);
    final external = kExternalSources.contains(source);

    bool inList(List<String> list) {
      if (list.isEmpty) return false;
      final lsym = symbol.toLowerCase();
      final laddr = address?.toLowerCase();
      return list.any((e) {
        final le = e.toLowerCase();
        return le == lsym || (laddr != null && le == laddr);
      });
    }

    // ---- hard filters (drop) ----
    if (f.denylist.isNotEmpty && inList(f.denylist)) return null;
    if (f.allowlist.isNotEmpty && !inList(f.allowlist)) return null;
    if (f.chains != null && chain != null && !f.chains!.contains(chain)) {
      return null;
    }
    // quote-asset filter (only when we can read a quote from the pair)
    if (pair != null && pair.contains('/')) {
      final quote = pair.split('/').last;
      if (!f.quoteAssets.contains(quote)) return null;
    }
    if (liquidityUsd != null && liquidityUsd < f.minLiquidityUsd) return null;
    if (ageSec != null && ageSec < f.minAgeSec) return null;
    if (f.maxAgeSec != null && ageSec != null && ageSec > f.maxAgeSec!) {
      return null;
    }
    // requireVerified hard-drops an unverified EXTERNAL candidate; watchlist is
    // exempt (trusted as a candidate). When requireVerified is off, a missing
    // verification becomes a soft 'unverified' flag instead.
    final verified = r['verified'] == true;
    if (f.requireVerified && external && !verified) return null;

    // ---- soft flags (rug/scam heuristics: flag, never fabricate safety) ----
    final flags = <String>[];
    if (external && !verified) flags.add('unverified');
    if (r['liquidityLocked'] == false) flags.add('liquidity-not-locked');
    if (r['mintRenounced'] == false) flags.add('mint-not-renounced');
    if (r['honeypot'] == true) flags.add('honeypot');
    final topHolderPct = _num(r['topHolderPct']);
    if (topHolderPct != null && topHolderPct >= 50) {
      flags.add('holder-concentration');
    }
    if (liquidityUsd != null && liquidityUsd < f.minLiquidityUsd * 2) {
      flags.add('low-liquidity');
    }
    if (ageSec != null && ageSec < f.newBelowSec) flags.add('new');

    // rejectFlags hard-drop (default includes honeypot).
    for (final rf in f.rejectFlags) {
      if (flags.contains(rf)) return null;
    }

    final trust = kSourceTrust[source] ?? 0.0;
    final score = scoreCandidate(
      liquidityUsd: liquidityUsd,
      volume24hUsd: volume24hUsd,
      ageSec: ageSec,
      trust: trust,
      softFlags: flags.length,
      weights: config.weights,
    );

    return Candidate(
      chain: chain,
      symbol: symbol,
      address: address,
      pair: pair,
      venue: r['venue'] as String?,
      source: source,
      liquidityUsd: liquidityUsd,
      volume24hUsd: volume24hUsd,
      ageSec: ageSec,
      score: score,
      flags: flags,
      approved: false, // NEVER auto-approved
    );
  }
}
