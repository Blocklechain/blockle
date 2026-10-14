// agent/scanner.dart — the SCAN-&-TRADE (Autopilot) evaluator (Dart port of
// blockle-extension/agent/scanner.js — the REFERENCE). See docs/AGENT-SCAN.md and
// the shared fixture docs/scan-vectors.json. The three wallets (JS reference,
// this Dart, Python) MUST behave IDENTICALLY: same scoring formula, same ranking,
// same worthy/skip decisions, same emitted Intents — checked against that fixture.
//
// SAFETY MODEL (non-negotiable): the scanner is a PLANNER, never an executor. It
// NEVER signs/broadcasts/touches keys. Per tick it (1) SCANS a candidate universe,
// (2) EVALUATES each for cost-positive profit using the EXISTING strategy signals
// (arbitrage net edge, momentum crossover, grid spread) net of ALL costs (both
// venue fees + two 0.05% agent legs + slippage + gas), (3) SCORES + RANKS, (4)
// returns the worthy strategy Intents for the BotRunner to dispatch through the
// ONE value-moving gate (caps/allocation/confirm/allowlist/kill/audit/fee/mainnet
// + the security pre-sign). It NEVER fabricates a price/edge and NEVER emits a
// sub-threshold or net-negative Intent.
//
// ---- PINNED SCORING FORMULA (identical across all three wallets) -------------
// For a candidate c with market data (venues[], history[], book, prices, liquidity,
// flags), for EACH enabled strategy compute an expected edge in bps, net of costs:
//
//   arbitrage: buyV=min ask, sellV=max bid (distinct venues);
//     grossBps = (sellV.bid - buyV.ask)/buyV.ask * 1e4
//     baseUnits = usdToBase(perTradeUsd/quoteUsd, baseDec, buyV.ask), clamped to depth
//     execUsd   = baseUnits * buyV.ask * quoteUsd           (the ACTUAL notional)
//     gasBps    = gasBufferUsd/execUsd * 1e4
//     costsBps  = buyV.feeBps + sellV.feeBps + 2*agentFeeBps + slippageBps + gasBps
//     edge      = grossBps - costsBps            (exactly strategies.arbitrage's net)
//   momentum: on a GOLDEN cross only (SMA short crosses above SMA long):
//     strengthBps = (currShort - currLong)/currLong * 1e4
//     edge        = strengthBps - (agentFeeBps + slippageBps)      (single buy leg)
//   grid: on a positive spread:
//     spreadBps = (bestAsk - bestBid)/mid * 1e4
//     edge      = spreadBps - (2*agentFeeBps + slippageBps)        (round-trip)
//
//   rawEdgeBps = max over enabled strategies of their edge (the winning strategy).
//   A candidate with no signal / no distinct-venue edge contributes no result.
//
//   RISK ADJUSTMENT (penalize thinness / volatility / flags), each in [0,1]:
//     Lf = liquidityUsd==null ? 1 : min(1, liquidityUsd/liquidityNorm)
//     Vf = 1 / (1 + volPenaltyK * coeffVar(history))     (coeffVar = stdev/mean)
//     Ff = max(0, 1 - flagPenalty * nSoftFlags)
//   score = round6( max(0, rawEdgeBps) * Lf * Vf * Ff )      // bps, rounded to 1e-6
//
//   WORTHY  iff  rawEdgeBps > 0  AND  score >= minProfitBps.
//   Ranked by score desc, stable tiebreak by pair asc. The top maxConcurrentPairs
//   whose intents' total cost fits the remaining allocation are TRADED; the rest are
//   SKIPPED with a pinned reason (no-signal / net-negative / below-threshold /
//   flagged / max-concurrent / allocation).

import 'dart:math' as math;

import 'strategies.dart' show usdToBase;

const Map<String, num> _kStableUsd = {
  'USDC': 1, 'USDT': 1, 'DAI': 1, 'USD': 1, 'USDBC': 1, 'PYUSD': 1,
};

const Map<String, int> _kDefaultDecimals = {
  'BLOCK': 8, 'BTC': 8, 'LTC': 8, 'DOGE': 8,
  'USDC': 6, 'USDT': 6, 'DAI': 6, 'USD': 2,
  'ETH': 18, 'WETH': 18, 'SOL': 9,
};

/// One leg of a scanner-emitted plan. Carries exactly the fields the BotRunner's
/// shared dispatch loop reads (tool/args/estUsd/tag/mainnet) PLUS the scanner
/// provenance the UI + the shared vector pin (strategy/group/scannerPair/score).
class ScanIntent {
  final String tool;
  final Map<String, dynamic> args;
  final num estUsd;
  final String strategy;
  final String tag;
  final String? group;
  final bool mainnet;
  final String scannerPair;
  final double scannerScore;
  final String rationale;

  /// The settlement/quote asset this leg realizes profit INTO (the scanner's
  /// profit currency). Null until the selection loop tags the worthy intents.
  final String? settleTo;

  /// Whether this leg is the take-profit / realize EXIT (the sell leg) that routes
  /// its proceeds into the profit currency.
  final bool exit;

  const ScanIntent({
    required this.tool,
    required this.args,
    required this.estUsd,
    required this.strategy,
    required this.tag,
    required this.scannerPair,
    required this.scannerScore,
    this.group,
    this.mainnet = false,
    this.rationale = '',
    this.settleTo,
    this.exit = false,
  });

  /// A copy tagged with the settlement currency + exit flag (the worthy-selection
  /// step fills these in once the profit currency is known). On the EXIT (sell /
  /// take-profit) leg the OUTPUT asset is rewritten to the profit currency: a direct
  /// sell when the pair quote already equals it, otherwise the venue layer resolves
  /// the extra hop into it. The emitted swap args therefore actually change with the
  /// chosen profit currency — the exit realizes proceeds INTO it, not just a label.
  ScanIntent tagged({required String settleTo, required bool exit}) => ScanIntent(
        tool: tool,
        args: exit ? {...args, 'to': settleTo} : args,
        estUsd: estUsd,
        strategy: strategy,
        tag: tag,
        scannerPair: scannerPair,
        scannerScore: scannerScore,
        group: group,
        mainnet: mainnet,
        rationale: rationale,
        settleTo: settleTo,
        exit: exit,
      );

  Map<String, dynamic> toJson() => {
        'tool': tool,
        'args': args,
        'estUsd': estUsd,
        'strategy': strategy,
        'tag': tag,
        if (group != null) 'group': group,
        'scannerPair': scannerPair,
        'scannerScore': scannerScore,
        if (settleTo != null) 'settleTo': settleTo,
        if (settleTo != null) 'exit': exit,
      };
}

/// The full per-tick result: the ranked decisions (for the UI cockpit card), the
/// worthy set with its emitted Intents, the flat Intent list the runner dispatches,
/// and the allocation accounting.
class ScanResult {
  final List<Map<String, dynamic>> candidates; // ranked, each with decision + reason
  final List<Map<String, dynamic>> worthy;
  final List<Map<String, dynamic>> skipped;
  final List<ScanIntent> intents;
  final num? allocationUsd;
  final num committedUsd;
  final num? remainingUsd;
  final int minProfitBps;
  final int maxConcurrentPairs;
  final String profitCurrency; // the settlement/quote asset P&L realizes INTO

  const ScanResult({
    required this.candidates,
    required this.worthy,
    required this.skipped,
    required this.intents,
    required this.allocationUsd,
    required this.committedUsd,
    required this.remainingUsd,
    required this.minProfitBps,
    required this.maxConcurrentPairs,
    this.profitCurrency = 'USDC',
  });
}

class AgentScanner {
  // Pinned defaults — the fixture depends on these EXACT values.
  static const Map<String, dynamic> defaults = {
    'minProfitBps': 30,
    'maxConcurrentPairs': 3,
    'perTradeUsd': 20,
    'allocationUsd': 0,
    // PROFIT CURRENCY — the settlement/quote asset the autopilot realizes profit
    // INTO, denominates P&L in, and routes take-profit exits to. Default USDC. In
    // AI-chooses-pairs mode the user picks it; in manual mode it derives from the
    // chosen pair's quote. Scoring is unchanged (already USD-normalized); this names
    // the asset the realized profit settles to.
    'profitCurrency': 'USDC',
    'strategies': ['arbitrage', 'momentum', 'grid'],
    // cost model (mirrors strategies.arbitrage defaults + floors)
    'gasBufferUsd': 2,
    'slippageBps': 10,
    'agentFeeBps': 5,
    // SETTLEMENT LEG — the extra venue fee (bps) of the hop that converts a pair's
    // native quote INTO the profit currency when they differ. Charged (with another
    // agent leg + slippage) against the net edge so a pair that is only profitable
    // in its native quote but net-negative after settling is NOT traded.
    'settlementFeeBps': 30,
    // momentum + grid sizing
    'momentumShortN': 10,
    'momentumLongN': 30,
    'gridLevels': 2,
    'gridStepBps': 50,
    // risk-adjustment normalizers (pinned)
    'liquidityNorm': 100000,
    'volPenaltyK': 2.0,
    'flagPenalty': 0.25,
    // hard-drop flags (never scored, never traded)
    'rejectFlags': ['honeypot', 'scam', 'rug', 'denylist'],
    'maxCandidates': 50,
  };

  static num _num(dynamic v, num dflt) {
    if (v is num) return v.isFinite ? v : dflt;
    final n = num.tryParse('$v');
    return (n != null && n.isFinite) ? n : dflt;
  }

  static int _trunc(dynamic v, int dflt) => _num(v, dflt).truncate();

  static double round6(num x) => (x * 1e6).round() / 1e6;

  static String _lc(dynamic x) => x == null ? '' : '$x'.toLowerCase();

  static double _clamp01(double x) => x < 0 ? 0 : (x > 1 ? 1 : x);

  static List<String> _splitPair(String pair) {
    final parts = '$pair'.toUpperCase().split('/');
    if (parts.length != 2 || parts[0].isEmpty || parts[1].isEmpty) {
      throw ArgumentError('bad pair (want BASE/QUOTE): $pair');
    }
    return [parts[0], parts[1]];
  }

  static int _decimalsFor(String sym) => _kDefaultDecimals[sym.toUpperCase()] ?? 8;

  // Settlement into the PROFIT CURRENCY. Returns {route, costBps}:
  //   - quote == profitCurrency  -> a DIRECT sell: route true, zero extra cost.
  //   - quote != profitCurrency  -> an extra hop converting the proceeds INTO the
  //     profit currency: route true ONLY if a price for it is known for this
  //     candidate (stablecoin $1, or the candidate's prices[]), and its cost is the
  //     extra venue fee + one 0.05% agent leg + conversion slippage (bps).
  //   - no price known           -> NO route: route false (the caller skips it and
  //     audits the reason; a price is NEVER fabricated to force the trade).
  static Map<String, dynamic> settleInto(
      String quote, Map<String, dynamic> c, Map<String, dynamic> cfg) {
    final pc = cfg['profitCurrency'] as String;
    if (quote.toUpperCase() == pc) return const {'route': true, 'costBps': 0.0};
    final prices = (c['prices'] is Map) ? c['prices'] as Map : const {};
    final priced = _num(prices[pc], double.nan) > 0;
    if (_kStableUsd[pc] == null && !priced) {
      return const {'route': false, 'costBps': 0.0};
    }
    final costBps = (cfg['settlementFeeBps'] as num) +
        (cfg['agentFeeBps'] as num) +
        (cfg['slippageBps'] as num);
    return {'route': true, 'costBps': costBps.toDouble()};
  }

  // Coefficient of variation (population stdev / mean) of a price history. 0 when
  // there is too little data or a non-positive mean (never fabricated).
  static double coeffVar(dynamic history) {
    final h = <double>[];
    if (history is List) {
      for (final x in history) {
        final n = x is num ? x.toDouble() : double.tryParse('$x');
        if (n != null && n.isFinite) h.add(n);
      }
    }
    if (h.length < 2) return 0;
    var sum = 0.0;
    for (final x in h) {
      sum += x;
    }
    final mean = sum / h.length;
    if (!(mean > 0)) return 0;
    var v = 0.0;
    for (final x in h) {
      v += (x - mean) * (x - mean);
    }
    v /= h.length;
    return math.sqrt(v) / mean;
  }

  static Map<String, dynamic> validateConfig(Map<String, dynamic>? params) {
    final p = <String, dynamic>{...defaults, ...?params};
    p['minProfitBps'] = math.max(0, _trunc(p['minProfitBps'], 30));
    p['maxConcurrentPairs'] = math.max(1, _trunc(p['maxConcurrentPairs'], 3));
    p['perTradeUsd'] = math.max(0, _num(p['perTradeUsd'], 20));
    p['allocationUsd'] = math.max(0, _num(p['allocationUsd'], 0));
    p['gasBufferUsd'] = math.max(0, _num(p['gasBufferUsd'], 2));
    // Floors mirror strategies.arbitrage: slippage >= 5, agent fee >= 5 — a caller
    // can never price a loss-maker as a winner by configuring them below reality.
    p['slippageBps'] = math.max(5, _trunc(p['slippageBps'], 10));
    p['agentFeeBps'] = math.max(5, _trunc(p['agentFeeBps'], 5));
    p['settlementFeeBps'] = math.max(0, _trunc(p['settlementFeeBps'], 30));
    p['momentumShortN'] = math.max(1, _trunc(p['momentumShortN'], 10));
    p['momentumLongN'] = math.max(2, _trunc(p['momentumLongN'], 30));
    if ((p['momentumShortN'] as int) >= (p['momentumLongN'] as int)) {
      p['momentumShortN'] = math.max(1, (p['momentumLongN'] as int) - 1);
    }
    p['gridLevels'] = math.max(2, _trunc(p['gridLevels'], 2));
    p['gridStepBps'] = math.max(1, _trunc(p['gridStepBps'], 50));
    p['liquidityNorm'] = math.max(1, _num(p['liquidityNorm'], 100000));
    p['volPenaltyK'] = math.max(0, _num(p['volPenaltyK'], 2.0));
    p['flagPenalty'] = math.max(0, _num(p['flagPenalty'], 0.25));
    final pc = p['profitCurrency'];
    p['profitCurrency'] = (pc is String && pc.trim().isNotEmpty)
        ? pc.trim().toUpperCase()
        : 'USDC';
    final strategies = p['strategies'];
    p['strategies'] = (strategies is List && strategies.isNotEmpty)
        ? strategies.map(_lc).toList()
        : List<String>.from(defaults['strategies'] as List);
    final rejectFlags = p['rejectFlags'];
    p['rejectFlags'] = (rejectFlags is List)
        ? rejectFlags.map(_lc).toList()
        : List<String>.from(defaults['rejectFlags'] as List);
    p['maxCandidates'] = math.max(1, _trunc(p['maxCandidates'], 50));
    return p;
  }

  // ---- per-strategy expected edge (bps), net of ALL costs. Returns null when the
  // strategy produces no real signal/edge (never fabricates one). -----------------

  static Map<String, dynamic>? arbEdge(
      Map<String, dynamic> c, Map<String, dynamic> cfg) {
    final rawVenues = (c['venues'] is List) ? c['venues'] as List : const [];
    final venues = <Map<String, dynamic>>[];
    for (final raw in rawVenues) {
      if (raw is! Map) continue;
      final v = raw.cast<String, dynamic>();
      final ask = _num(v['ask'], double.nan);
      final bid = _num(v['bid'], double.nan);
      final id = v['id'];
      if (id == null || !(ask > 0) || !(bid > 0)) continue;
      venues.add({
        'id': id,
        'ask': ask,
        'bid': bid,
        'feeBps': _num(v['feeBps'], 0),
        'mainnet': v['mainnet'] == true || v['network'] == 'mainnet',
        'depthBase': v['depthBase'] != null ? BigInt.parse('${v['depthBase']}') : null,
      });
    }
    if (venues.length < 2) return null;
    String base, quote;
    try {
      final parts = _splitPair('${c['pair']}');
      base = parts[0];
      quote = parts[1];
    } catch (_) {
      return null;
    }
    final prices = (c['prices'] is Map) ? (c['prices'] as Map) : const {};
    final quoteUsd = prices[quote] != null
        ? _num(prices[quote], double.nan)
        : (_kStableUsd[quote] ?? double.nan);
    if (!(quoteUsd > 0)) return null;
    final bd = _decimalsFor(base);
    final qd = _decimalsFor(quote);
    var buyV = venues.first;
    var sellV = venues.first;
    for (final v in venues) {
      if ((v['ask'] as num) < (buyV['ask'] as num)) buyV = v;
      if ((v['bid'] as num) > (sellV['bid'] as num)) sellV = v;
    }
    if (buyV['id'] == sellV['id']) return null;
    final buyAsk = buyV['ask'] as num;
    final grossBps = ((sellV['bid'] as num) - buyAsk) / buyAsk * 10000;
    // size exactly like strategies.arbitrage (depth-clamped), then price costs on
    // the ACTUAL executed notional so gas bps are honest for a shallow book.
    final fullBase = usdToBase((cfg['perTradeUsd'] as num) / quoteUsd, bd, buyAsk);
    var baseUnits = fullBase;
    final buyDepth = buyV['depthBase'] as BigInt?;
    final sellDepth = sellV['depthBase'] as BigInt?;
    if (buyDepth != null && buyDepth < baseUnits) baseUnits = buyDepth;
    if (sellDepth != null && sellDepth < baseUnits) baseUnits = sellDepth;
    if (baseUnits <= BigInt.zero) return null;
    final execUsd =
        (baseUnits.toDouble() / math.pow(10, bd)) * buyAsk * quoteUsd;
    if (!(execUsd > 0)) return null;
    final gasBps = (cfg['gasBufferUsd'] as num) / execUsd * 10000;
    final costsBps = (buyV['feeBps'] as num) +
        (sellV['feeBps'] as num) +
        (2 * (cfg['agentFeeBps'] as num)) +
        (cfg['slippageBps'] as num) +
        gasBps;
    return {
      'strategy': 'arbitrage',
      'edgeBps': grossBps - costsBps,
      'grossBps': grossBps,
      'costsBps': costsBps,
      'execUsd': execUsd,
      'buyVenue': buyV['id'],
      'sellVenue': sellV['id'],
      'buyAsk': buyAsk,
      'baseUnits': baseUnits,
      'fullBase': fullBase,
      'base': base,
      'quote': quote,
      'quoteUsd': quoteUsd,
      'bd': bd,
      'qd': qd,
      'mainnet': (buyV['mainnet'] == true) || (sellV['mainnet'] == true),
    };
  }

  static Map<String, dynamic>? momentumEdge(
      Map<String, dynamic> c, Map<String, dynamic> cfg) {
    final h = <double>[];
    final hist = c['history'];
    if (hist is List) {
      for (final x in hist) {
        final n = x is num ? x.toDouble() : double.tryParse('$x');
        if (n != null && n.isFinite) h.add(n);
      }
    }
    final longN = cfg['momentumLongN'] as int;
    final shortN = cfg['momentumShortN'] as int;
    if (h.length < longN) return null;
    final n = h.length;
    double sma(int end, int win) {
      var s = 0.0;
      for (var i = end - win + 1; i <= end; i++) {
        s += h[i];
      }
      return s / win;
    }

    final prevShort = sma(n - 2, shortN);
    final currShort = sma(n - 1, shortN);
    final prevLong = sma(n - 2, longN);
    final currLong = sma(n - 1, longN);
    final golden = prevShort <= prevLong && currShort > currLong;
    if (!golden || !(currLong > 0)) return null;
    final strengthBps = (currShort - currLong) / currLong * 10000;
    final costsBps = (cfg['agentFeeBps'] as num) + (cfg['slippageBps'] as num);
    return {
      'strategy': 'momentum',
      'edgeBps': strengthBps - costsBps,
      'strengthBps': strengthBps,
      'costsBps': costsBps,
    };
  }

  static Map<String, dynamic>? gridEdge(
      Map<String, dynamic> c, Map<String, dynamic> cfg) {
    final book = c['book'];
    var bestBid = double.nan, bestAsk = double.nan;
    if (book is Map) {
      final bids = book['bids'];
      final asks = book['asks'];
      final bb = (bids is List && bids.isNotEmpty) ? bids[0] : null;
      final ba = (asks is List && asks.isNotEmpty) ? asks[0] : null;
      double sideP(dynamic row) {
        if (row is Map) return _num(row['price'], double.nan).toDouble();
        if (row is List && row.isNotEmpty) return _num(row[0], double.nan).toDouble();
        return double.nan;
      }

      if (bb != null) bestBid = sideP(bb);
      if (ba != null) bestAsk = sideP(ba);
    }
    if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) return null;
    final mid = (bestBid + bestAsk) / 2;
    final spreadBps = (bestAsk - bestBid) / mid * 10000;
    final costsBps = (2 * (cfg['agentFeeBps'] as num)) + (cfg['slippageBps'] as num);
    return {
      'strategy': 'grid',
      'edgeBps': spreadBps - costsBps,
      'spreadBps': spreadBps,
      'costsBps': costsBps,
    };
  }

  // Evaluate ONE candidate: the best (winning) net edge, the risk-adjusted score,
  // and the hard-flag / signal reason. PURE + deterministic.
  static Map<String, dynamic> evaluate(
      Map<String, dynamic> c, Map<String, dynamic> cfg) {
    final flagsRaw = (c['flags'] is List) ? c['flags'] as List : const [];
    final flags = flagsRaw.map(_lc).toList();
    final reject = Set<String>.from(cfg['rejectFlags'] as List);
    if (flags.any(reject.contains)) {
      return {
        'pair': c['pair'],
        'chain': c['chain'],
        'strategy': null,
        'edgeBps': 0,
        'score': 0,
        'reason': 'flagged',
        'flags': flags,
        'eval': null,
      };
    }

    final strategies = Set<String>.from(cfg['strategies'] as List);
    final evals = <Map<String, dynamic>>[];
    if (strategies.contains('arbitrage')) {
      final e = arbEdge(c, cfg);
      if (e != null) evals.add(e);
    }
    if (strategies.contains('momentum')) {
      final e = momentumEdge(c, cfg);
      if (e != null) evals.add(e);
    }
    if (strategies.contains('grid')) {
      final e = gridEdge(c, cfg);
      if (e != null) evals.add(e);
    }

    if (evals.isEmpty) {
      return {
        'pair': c['pair'],
        'chain': c['chain'],
        'strategy': null,
        'edgeBps': 0,
        'score': 0,
        'reason': 'no-signal',
        'flags': flags,
        'eval': null,
      };
    }
    // winning strategy = highest net edge (stable: first-listed wins a tie)
    var best = evals.first;
    for (final e in evals) {
      if ((e['edgeBps'] as num) > (best['edgeBps'] as num)) best = e;
    }

    // risk adjustment
    final liq = c['liquidityUsd'];
    final Lf = liq == null
        ? 1.0
        : _clamp01(_num(liq, 0).toDouble() / (cfg['liquidityNorm'] as num));
    final Vf = 1 / (1 + (cfg['volPenaltyK'] as num) * coeffVar(c['history']));
    final nSoft = flags.length; // soft flags (hard rejects already returned above)
    final Ff = math.max(0, 1 - (cfg['flagPenalty'] as num) * nSoft).toDouble();
    final factors = {'Lf': round6(Lf), 'Vf': round6(Vf), 'Ff': round6(Ff)};
    final rawEdge = (best['edgeBps'] as num).toDouble();

    // SETTLEMENT INTO THE PROFIT CURRENCY — the score must be net of the cost of
    // converting the realized proceeds into the profit currency (zero when the pair
    // quote already equals it). A pair profitable in its native quote but
    // net-negative after settling is NOT worthy. If no route to the profit currency
    // exists for this candidate it is skipped (audited) — never a fabricated price.
    String quoteSym = '';
    try {
      quoteSym = _splitPair('${c['pair']}')[1];
    } catch (_) {}
    final settle = settleInto(quoteSym, c, cfg);
    if (settle['route'] == false) {
      return {
        'pair': c['pair'],
        'chain': c['chain'],
        'strategy': best['strategy'],
        'edgeBps': round6(rawEdge),
        'score': 0,
        'reason': 'no-route',
        'flags': flags,
        'factors': factors,
        'eval': best,
        'candidate': c,
      };
    }
    final netEdge = rawEdge - (settle['costBps'] as double);
    final score = round6(math.max(0.0, netEdge) * Lf * Vf * Ff);

    String reason;
    if (netEdge <= 0) {
      reason = 'net-negative';
    } else if (score < (cfg['minProfitBps'] as num)) {
      reason = 'below-threshold';
    } else {
      reason = 'worthy';
    }

    return {
      'pair': c['pair'],
      'chain': c['chain'],
      'strategy': best['strategy'],
      'edgeBps': round6(netEdge),
      'score': score,
      'reason': reason,
      'flags': flags,
      'factors': factors,
      'eval': best,
      'candidate': c,
    };
  }

  // Build the chosen strategy's Intent(s) for a worthy row, matching the shared
  // strategy conventions EXACTLY (arb = balanced 2-leg group; momentum = single buy
  // leg). Sized perTradeUsd. Mirrors the reference strategies.js output shape.
  static List<ScanIntent> emitIntents(
      Map<String, dynamic> row, Map<String, dynamic> cfg, bool mainnet) {
    final strategy = row['strategy'] as String?;
    final ev = row['eval'] as Map<String, dynamic>?;
    final pair = '${row['pair']}';
    final score = row['score'] as num;
    if (ev == null || strategy == null) return const [];

    if (strategy == 'arbitrage') {
      final base = ev['base'] as String;
      final quote = ev['quote'] as String;
      final bd = ev['bd'] as int;
      final qd = ev['qd'] as int;
      final buyAsk = ev['buyAsk'] as num;
      final quoteUsd = ev['quoteUsd'] as num;
      final baseUnits = ev['baseUnits'] as BigInt;
      final fullBase = ev['fullBase'] as BigInt;
      final buyVenue = '${ev['buyVenue']}';
      final sellVenue = '${ev['sellVenue']}';
      // quote spent on the buy leg = full notional (when NOT depth-clamped), else
      // the clamped baseUnits repriced to quote base units (BigInt-exact).
      final buyAmt = (baseUnits == fullBase)
          ? usdToBase(cfg['perTradeUsd'] as num, qd, quoteUsd)
          : _baseToQuote(baseUnits, bd, qd, buyAsk);
      final sellAmt = baseUnits;
      final estUsd = (((ev['execUsd'] as num) * 100).round()) / 100;
      final group = 'arb:$pair:$buyVenue->$sellVenue';
      final isMainnet = mainnet || (ev['mainnet'] == true);
      return [
        ScanIntent(
          tool: 'swap',
          args: {'from': quote, 'to': base, 'amount': buyAmt.toString(), 'venue': buyVenue},
          estUsd: estUsd,
          strategy: 'arbitrage',
          tag: '$group:buy',
          group: group,
          mainnet: isMainnet,
          scannerPair: pair,
          scannerScore: score.toDouble(),
        ),
        ScanIntent(
          tool: 'swap',
          args: {'from': base, 'to': quote, 'amount': sellAmt.toString(), 'venue': sellVenue},
          estUsd: estUsd,
          strategy: 'arbitrage',
          tag: '$group:sell',
          group: group,
          mainnet: isMainnet,
          scannerPair: pair,
          scannerScore: score.toDouble(),
        ),
      ];
    }

    if (strategy == 'momentum') {
      final parts = _splitPair(pair);
      final base = parts[0], quote = parts[1];
      final prices = (row['candidate'] is Map)
          ? ((row['candidate'] as Map)['prices'] is Map
              ? (row['candidate'] as Map)['prices'] as Map
              : const {})
          : const {};
      final quoteUsd = prices[quote] != null
          ? _num(prices[quote], double.nan)
          : (_kStableUsd[quote] ?? double.nan);
      if (!(quoteUsd > 0)) return const [];
      final qd = _decimalsFor(quote);
      final amount = usdToBase(cfg['perTradeUsd'] as num, qd, quoteUsd);
      if (amount <= BigInt.zero) return const [];
      return [
        ScanIntent(
          tool: 'swap',
          args: {'from': quote, 'to': base, 'amount': amount.toString(), 'venue': 'blockle'},
          estUsd: cfg['perTradeUsd'] as num,
          strategy: 'momentum',
          tag: 'momentum:$pair:buy',
          mainnet: mainnet,
          scannerPair: pair,
          scannerScore: score.toDouble(),
        ),
      ];
    }

    if (strategy == 'grid') {
      final parts = _splitPair(pair);
      final base = parts[0], quote = parts[1];
      final prices = (row['candidate'] is Map)
          ? ((row['candidate'] as Map)['prices'] is Map
              ? (row['candidate'] as Map)['prices'] as Map
              : const {})
          : const {};
      final quoteUsd = prices[quote] != null
          ? _num(prices[quote], double.nan)
          : (_kStableUsd[quote] ?? double.nan);
      if (!(quoteUsd > 0)) return const [];
      final qd = _decimalsFor(quote);
      final amount = usdToBase(cfg['perTradeUsd'] as num, qd, quoteUsd);
      if (amount <= BigInt.zero) return const [];
      // one representative buy leg per tick (ladder detail lives in the grid bot).
      return [
        ScanIntent(
          tool: 'swap',
          args: {'from': quote, 'to': base, 'amount': amount.toString(), 'venue': 'blockle'},
          estUsd: cfg['perTradeUsd'] as num,
          strategy: 'grid',
          tag: 'grid:$pair:buy',
          mainnet: mainnet,
          scannerPair: pair,
          scannerScore: score.toDouble(),
        ),
      ];
    }
    return const [];
  }

  // base units -> quote base units at a decimal price (quote per whole base).
  static BigInt _baseToQuote(BigInt baseUnits, int bd, int qd, num price) {
    if (baseUnits <= BigInt.zero || !(price > 0)) return BigInt.zero;
    // scale price to 12 dp integer, exact.
    final p = usdToBase(price, 12, 1); // price * 1e12
    if (p <= BigInt.zero) return BigInt.zero;
    final numer = baseUnits * p * BigInt.from(10).pow(qd);
    final den = BigInt.from(10).pow(bd) * BigInt.from(10).pow(12);
    final q = numer ~/ den;
    return q > BigInt.zero ? q : BigInt.zero;
  }

  // The full per-tick pipeline over a candidate snapshot. Returns the ranked
  // evaluation of every candidate, the chosen worthy set WITH its emitted Intents,
  // and the flat Intent list the BotRunner dispatches. DETERMINISTIC.
  static ScanResult scanAndScore(
    List<dynamic> universe,
    Map<String, dynamic>? config, {
    num? allocationUsd,
    num committedUsd = 0,
    bool mainnet = false,
  }) {
    final cfg = validateConfig(config);

    // dedupe the universe by (chain, address|mint|pair) — first-seen wins; cap it.
    final seen = <String, Map<String, dynamic>>{};
    for (final raw in universe) {
      if (raw is! Map) continue;
      final c = raw.cast<String, dynamic>();
      if (c['pair'] == null) continue;
      final key = _lc(c['chain']) +
          ':' +
          _lc(c['address'] ?? c['mint'] ?? c['pair']);
      seen.putIfAbsent(key, () => c);
    }
    final candidates =
        seen.values.take(cfg['maxCandidates'] as int).toList();

    // evaluate + score each
    final rows = candidates.map((c) => evaluate(c, cfg)).toList();
    // rank by score desc, stable tiebreak by pair asc
    rows.sort((a, b) {
      final d = (b['score'] as num).compareTo(a['score'] as num);
      if (d != 0) return d;
      return _lc(a['pair']).compareTo(_lc(b['pair']));
    });

    final cfgAllocation = (cfg['allocationUsd'] as num);
    final alloc = allocationUsd ?? cfgAllocation;
    final committed = committedUsd;
    final hasAllocationCap = alloc > 0;
    var remaining = hasAllocationCap
        ? math.max(0.0, alloc.toDouble() - committed.toDouble())
        : double.infinity;

    final profitCurrency = cfg['profitCurrency'] as String;
    // USD value of one unit of the profit currency (for denominating realized P&L
    // in it). Stablecoins are $1; otherwise use a candidate-provided price; fall
    // back to $1 (NEVER fabricated into a trade — this only labels the P&L unit).
    num profitCurUsd(Map<String, dynamic>? c) {
      if (_kStableUsd[profitCurrency] != null) return _kStableUsd[profitCurrency]!;
      final prices = (c != null && c['prices'] is Map) ? c['prices'] as Map : null;
      final p = prices != null ? _num(prices[profitCurrency], double.nan) : double.nan;
      return (p > 0) ? p : 1;
    }

    final decisions = <Map<String, dynamic>>[];
    final allIntents = <ScanIntent>[];
    var picked = 0;

    for (final row in rows) {
      if (row['reason'] != 'worthy') {
        decisions.add(_trim(row, '${row['reason']}'));
        continue;
      }
      if (picked >= (cfg['maxConcurrentPairs'] as int)) {
        decisions.add(_trim(row, 'max-concurrent'));
        continue;
      }
      final useMainnet = mainnet || ((row['eval']?['mainnet']) == true);
      final intents = emitIntents(row, cfg, useMainnet);
      if (intents.isEmpty) {
        decisions.add(_trim(row, 'no-intent'));
        continue;
      }
      // cost = sum of every leg's estUsd + the mandatory 0.05% agent fee (the SAME
      // bound the allocation ledger accrues at dispatch).
      var costUsd = 0.0;
      for (final it in intents) {
        final est = it.estUsd.toDouble();
        costUsd += est + est * ((cfg['agentFeeBps'] as num) / 10000);
      }
      if (hasAllocationCap && costUsd > remaining + 1e-9) {
        decisions.add(_trim(row, 'allocation'));
        continue;
      }
      remaining -= costUsd;
      picked += 1;
      // Realized P&L denominated in the PROFIT CURRENCY: expected net profit =
      // executed notional * net-edge; converted to profit-currency units. Exits
      // (sell / take-profit legs) route their proceeds INTO the profit currency.
      final ev = row['eval'] as Map<String, dynamic>?;
      final evExec = ev != null ? _num(ev['execUsd'], double.nan) : double.nan;
      final notionalUsd = evExec.isFinite ? evExec : (cfg['perTradeUsd'] as num);
      final profitUsd = round6(notionalUsd * ((row['edgeBps'] as num) / 10000));
      final pcUsd = profitCurUsd(row['candidate'] as Map<String, dynamic>?);
      final realized = {
        'currency': profitCurrency,
        'profitUsd': profitUsd,
        'profit': round6(profitUsd / pcUsd),
      };
      // tag each leg with the settlement currency + whether it is the exit leg.
      final tagged = intents
          .map((it) => it.tagged(
                settleTo: profitCurrency,
                exit: RegExp(r':sell$').hasMatch(it.tag),
              ))
          .toList();
      allIntents.addAll(tagged);
      final d = _trim(row, 'worthy');
      d['traded'] = true;
      d['intents'] = tagged.map((i) => i.toJson()).toList();
      d['costUsd'] = (costUsd * 1e6).round() / 1e6;
      d['realized'] = realized;
      decisions.add(d);
    }

    return ScanResult(
      candidates: decisions,
      worthy: decisions.where((d) => d['traded'] == true).toList(),
      skipped: decisions
          .where((d) => d['traded'] != true)
          .map((d) => {
                'pair': d['pair'],
                'reason': d['reason'],
                'score': d['score'],
                'edgeBps': d['edgeBps'],
              })
          .toList(),
      intents: allIntents,
      allocationUsd: hasAllocationCap ? alloc : null,
      committedUsd: committed,
      remainingUsd:
          hasAllocationCap ? math.max(0, (remaining * 1e6).round() / 1e6) : null,
      minProfitBps: cfg['minProfitBps'] as int,
      maxConcurrentPairs: cfg['maxConcurrentPairs'] as int,
      profitCurrency: profitCurrency,
    );
  }

  // Strip the heavy candidate/eval refs for the decision list (reason is final).
  static Map<String, dynamic> _trim(Map<String, dynamic> row, String reason) {
    return {
      'pair': row['pair'],
      'chain': row['chain'],
      'strategy': row['strategy'],
      'edgeBps': row['edgeBps'],
      'score': row['score'],
      'reason': reason,
      'flags': row['flags'],
      'factors': row['factors'],
      'traded': false,
    };
  }
}
