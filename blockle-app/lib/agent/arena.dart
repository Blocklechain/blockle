// agent/arena.dart — the Blockle ARENA: a gamified, play-money sandbox (spec
// docs/BLOCKLE-BOTS.md §9). A safe test/learn mode where anyone designs and runs
// strategies with FAKE funds against SIMULATED markets. This is the Dart port of
// the REFERENCE implementation blockle-extension/agent/arena.js; it is numerically
// IDENTICAL to the JS reference and the Python wallet — checked against the shared
// fixture docs/arena-vectors.json.
//
// ===========================================================================
// HARD SAFETY RULE (non-negotiable, structural):
//   Arena touches NO keys, NO vault, NO policy gate, NO broadcast, NO reserve.
//   It is PURE in-memory simulation with VIRTUAL funds labeled PLAY/TEST that can
//   NEVER be converted, withdrawn, or exchanged for anything real. There is no
//   code path from an Arena run to commit/broadcast/recordSpend/the reserve — this
//   module depends ONLY on the PURE deal engine (bots.dart) + the template
//   export/import (bot_templates.dart), never on bot_runner.dart / runner.dart /
//   the gate. The one honest on-ramp ("use this for real") goes through the
//   existing template import, which ALWAYS lands a bot paper + disabled + testnet.
// ===========================================================================
//
// Pieces (all money base-unit/BigInt-exact, micro-dollar integer basis):
//   • PlayBalance    — a virtual, labeled grant (default 🪙10,000 PLAY) that can
//                      never become real (convertToReal throws).
//   • scenario feed  — canonical price paths LOADED from docs/arena-vectors.json
//                      (bull/crab/bear/crash/pump); never regenerated for the
//                      tested/leaderboard-comparable scenarios.
//   • runScenario    — drive the PURE deal engine over a price path in SIM mode ->
//                      deterministic fills -> equity curve, play PnL, max drawdown,
//                      max cost basis.
//   • score          — the pinned §9 formula (round1(retPct - 0.5·ddPct)), all in
//                      micro-dollar integer math off the deal engine's own fills.
//   • XP + levels    — advisory UX progression (gating is NOT a safety control).
//   • missions       — clear win condition + reward.
//   • badges         — milestone achievements.
//   • Leaderboard    — LOCAL-first only (personal best + on-device board; NO
//                      network/global board in v1).
//   • use-for-real   — export the Arena config as a Bot template (§6); import lands
//                      paper + disabled + testnet, NEVER auto-live.

import 'dart:math' as math;

import 'bots.dart';
import 'bot_templates.dart';

// Honesty guardrail (§9): a persistent, never-removed disclaimer. Arena must
// NEVER imply simulated results predict real profit.
const String kDisclaimer =
    'Simulation — not financial advice; simulated performance does not predict real results.';

// Everything in the Arena is PLAY money. These labels appear everywhere a
// balance or PnL is shown. They are not a currency with any real value.
const String kPlayLabel = 'PLAY';
const String kPlaySymbol = '🪙';
const int kDefaultGrant = 10000; // play dollars
const bool kSimulationOnly = true; // structural marker; Arena can never go live

const List<String> kScenarios = ['bull', 'crab', 'bear', 'crash', 'pump'];

// ===========================================================================
// PlayBalance — a virtual, labeled grant. CANNOT become real.
// ===========================================================================
class PlayBalance {
  final String label = kPlayLabel;
  final String symbol = kPlaySymbol;
  final bool real = false; // hard: PLAY is never real
  final bool convertible = false; // hard: can never convert/withdraw/exchange
  final BigInt grantUc;
  BigInt balanceUc; // current play equity (grant + play PnL)

  PlayBalance([num? grantUsd])
      : grantUc = microUsd(grantUsd ?? kDefaultGrant),
        balanceUc = microUsd(grantUsd ?? kDefaultGrant);

  /// Apply a run's realized+unrealized play PnL to the play balance. PLAY only.
  PlayBalance applyPnl(BigInt? pnlUc) {
    balanceUc = balanceUc + (pnlUc ?? BigInt.zero);
    return this;
  }

  PlayBalance reset() {
    balanceUc = grantUc;
    return this;
  }

  /// HARD RULE enforced in code: there is NO path to make PLAY funds real.
  Never convertToReal() {
    throw StateError(
        'PLAY funds can never be converted, withdrawn, or exchanged for anything real');
  }

  Never withdraw() => convertToReal();
  Never exchange() => convertToReal();

  Map<String, dynamic> toJson() => {
        'label': label,
        'real': false,
        'convertible': false,
        'grantUc': grantUc.toString(),
        'balanceUc': balanceUc.toString(),
      };
}

// ===========================================================================
// scenario feed — LOAD canonical price paths from docs/arena-vectors.json.
// The fixture is AUTHORITATIVE; we never regenerate the tested scenarios from a
// cross-language RNG. A live generator (below) may add extra variety only.
// ===========================================================================
Map<String, List<num>> loadScenarios(Map<String, dynamic> vectors) {
  final scenarios = vectors['scenarios'];
  if (scenarios is! Map) throw ArgumentError('arena: vectors.scenarios missing');
  final out = <String, List<num>>{};
  for (final name in kScenarios) {
    final s = scenarios[name];
    final arr = s is List ? s : (s is Map ? s['priceSeriesUsd'] : null);
    if (arr is! List || arr.isEmpty) {
      throw ArgumentError('arena: scenario missing in fixture: $name');
    }
    out[name] = arr.map((e) => e as num).toList();
  }
  return out;
}

List<num> pricePath(Map<String, dynamic> vectors, String name) {
  final s = loadScenarios(vectors);
  final p = s[name];
  if (p == null) throw ArgumentError('arena: unknown scenario: $name');
  return p;
}

// Optional LIVE generator for EXTRA variety only (never the canonical scenarios).
// A tiny deterministic LCG so a (seed) reproduces, but these paths are NOT the
// fixture and are NOT leaderboard-comparable.
int Function() _lcg(int seed) {
  var s = (seed & 0xFFFFFFFF);
  if (s == 0) s = 1;
  return () {
    s = ((s * 1664525) + 1013904223) & 0xFFFFFFFF;
    return s;
  };
}

List<num> generatePath(String shape, {int seed = 1, int n = 120, num start = 100}) {
  final rnd = _lcg(seed);
  final out = <num>[];
  var p = start.toDouble();
  for (var i = 0; i < n; i++) {
    final t = i / (n - 1);
    var drift = 0.0;
    if (shape == 'bull') {
      drift = 0.006;
    } else if (shape == 'bear') {
      drift = -0.006;
    } else if (shape == 'crab') {
      drift = 0;
    } else if (shape == 'crash') {
      drift = (i == (n * 0.5).floor()) ? -0.35 : 0.001;
    } else if (shape == 'pump') {
      drift = (t < 0.4) ? 0.02 : -0.012;
    }
    final shock = ((rnd() / 4294967296.0) - 0.5) * 0.02;
    p = math.max(0.01, p * (1 + drift + shock));
    out.add((p * 1e6).round() / 1e6);
  }
  return out;
}

// ===========================================================================
// run a bot config over a scenario path -> fills + equity curve (PURE sim).
// Mirrors BotRunner's PAPER fill math EXACTLY (execPrice = level price for grid,
// else the mark; qty FLOORS; value/cost = divRound) but NEVER the gate/broadcast.
// ===========================================================================
Map<String, dynamic> _paperFill(Map<String, dynamic> order, BigInt markUc, int bd) {
  final execPriceUc = (order['_levelPriceUc'] as BigInt?) ?? markUc;
  if (order['side'] == 'buy') {
    final qty = (order['usdSizeUc'] != null)
        ? ((order['_qtyOverride'] as BigInt?) ??
            qtyForUsd(order['usdSizeUc'] as BigInt, markUc, bd))
        : order['qty'] as BigInt;
    return {
      'side': 'buy',
      'qty': qty,
      'priceUc': execPriceUc,
      'costUc': valueOf(qty, execPriceUc, bd),
      'bd': bd,
      'paper': true,
    };
  }
  return {
    'side': 'sell',
    'qty': order['qty'],
    'priceUc': execPriceUc,
    'proceedsUc': valueOf(order['qty'] as BigInt, execPriceUc, bd),
    'bd': bd,
    'paper': true,
  };
}

Map<String, dynamic>? _engineStep(String type, Map<String, dynamic> deal,
    Map<String, dynamic> bcfg, Map<String, dynamic> cfg, BigInt markUc) {
  if (type == 'dca') return dcaStep(deal, bcfg, markUc);
  if (type == 'grid') return gridStep(deal, markUc, bcfg);
  if (type == 'smarttrade') return smartStep(deal, cfg, markUc);
  return null;
}

void _engineApply(String type, Map<String, dynamic> deal, Map<String, dynamic> bcfg,
    Map<String, dynamic> cfg, Map<String, dynamic> order, Map<String, dynamic>? fill, int now) {
  if (type == 'dca') {
    dcaApply(deal, bcfg, order, fill, now);
  } else if (type == 'grid') {
    gridApply(deal, order, fill!, now);
  } else if (type == 'smarttrade') {
    smartApply(deal, cfg, order, fill!, now);
  }
}

Map<String, dynamic> _newDeal(String type, String id, Map<String, dynamic> cfg,
    BigInt midUc, int bd, int now) {
  if (type == 'grid') return newGridDeal(id, cfg, midUc, bd, now);
  if (type == 'smarttrade') return newSmartTradeDeal(id, cfg, now);
  return newDcaDeal(id, now);
}

// Current held-inventory cost + mark + realized for a deal, per engine type.
Map<String, BigInt> _dealAgg(String type, Map<String, dynamic>? deal, BigInt markUc, int bd) {
  if (deal == null) {
    return {'openCostUc': BigInt.zero, 'openMarkUc': BigInt.zero, 'realizedUc': BigInt.zero};
  }
  final realized = (deal['realizedUc'] as BigInt?) ?? BigInt.zero;
  if (type == 'grid') {
    var cost = BigInt.zero, mark = BigInt.zero;
    for (final lv in (deal['levels'] as List).cast<Map<String, dynamic>>()) {
      if ((lv['heldQty'] as BigInt) > BigInt.zero) {
        cost += (lv['_costUc'] as BigInt?) ?? BigInt.zero;
        mark += valueOf(lv['heldQty'] as BigInt, markUc, bd);
      }
    }
    return {'openCostUc': cost, 'openMarkUc': mark, 'realizedUc': realized};
  }
  if (type == 'smarttrade') {
    final open = deal['status'] != 'closed' && (deal['remainingQty'] as BigInt) > BigInt.zero;
    return {
      'openCostUc': open ? valueOf(deal['remainingQty'] as BigInt, deal['avgEntryUc'] as BigInt, bd) : BigInt.zero,
      'openMarkUc': open ? valueOf(deal['remainingQty'] as BigInt, markUc, bd) : BigInt.zero,
      'realizedUc': realized,
    };
  }
  // dca
  final dopen = deal['status'] != 'closed';
  return {
    'openCostUc': dopen ? deal['costUc'] as BigInt : BigInt.zero,
    'openMarkUc': dopen ? valueOf(deal['filledQty'] as BigInt, markUc, bd) : BigInt.zero,
    'realizedUc': realized,
  };
}

class ResolvedBot {
  final Bot bot;
  final String type;
  final Map<String, dynamic> cfg;
  final Map<String, dynamic> bcfg;
  final int bd;
  final String pair;
  ResolvedBot(this.bot, this.type, this.cfg, this.bcfg, this.bd, this.pair);
}

// Resolve a bot SPEC/instance/config into { type, cfg, bcfg, bd, pair }.
ResolvedBot resolveBot(dynamic spec) {
  Bot bot;
  if (spec is Bot) {
    bot = spec;
  } else {
    final m = (spec as Map).cast<String, dynamic>();
    final pairList = m['pair'] != null
        ? [m['pair'].toString().toUpperCase()]
        : (((m['universe'] as Map?)?['pairs'] as List?) ?? const []);
    bot = createBot({
      'type': m['type'] ?? 'dca',
      'name': m['name'],
      'universe': {'pairs': List.of(pairList)},
      'config': (m['config'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{},
    });
  }
  final specMap = spec is Map ? (spec).cast<String, dynamic>() : null;
  final pair = (bot.pairs().isNotEmpty ? bot.pairs()[0] : null) ??
      (specMap?['pair']?.toString()) ??
      'BLOCK/USDC';
  final base = splitPair(pair)[0];
  final int bd = (specMap != null && specMap['decimals'] != null)
      ? (specMap['decimals'] as num).toInt()
      : decimalsFor(base,
          bot.config['decimals'] is Map ? (bot.config['decimals'] as Map).cast<String, dynamic>() : null);
  final cfg = bot.config;
  final bcfg = bot.type == 'dca'
      ? dcaBps(cfg)
      : (bot.type == 'grid' ? gridBcfg(cfg) : cfg);
  return ResolvedBot(bot, bot.type, cfg, bcfg, bd, pair);
}

/// The risk-adjusted score (§9 pinned formula).
class ArenaScore {
  final BigInt scoreTenths;
  final num score;
  const ArenaScore(this.scoreTenths, this.score);

  @override
  bool operator ==(Object other) =>
      other is ArenaScore && other.scoreTenths == scoreTenths && other.score == score;
  @override
  int get hashCode => Object.hash(scoreTenths, score);
  @override
  String toString() => 'ArenaScore(scoreTenths: $scoreTenths, score: $score)';
}

/// The result of a single PURE-SIM run over a price path.
class ArenaResult {
  final String type;
  final String pair;
  final int decimals;
  final List<Map<String, dynamic>> fills;
  final List<BigInt> equityCurveUc;
  final BigInt finalPnlUc;
  final BigInt maxDrawdownUc;
  final BigInt maxCostBasisUc;
  final BigInt retTenthPct;
  final BigInt ddTenthPct;
  final BigInt scoreTenths;
  final num score;
  final int dealCount;
  final int closedDealCount;
  final String playLabel;
  final bool real;
  final String disclaimer;

  // Set by ArenaProfile.run after the pure run (mission/leaderboard metadata).
  String? scenario;
  Map<String, dynamic>? configSnapshot;
  String? name;

  ArenaResult({
    required this.type,
    required this.pair,
    required this.decimals,
    required this.fills,
    required this.equityCurveUc,
    required this.finalPnlUc,
    required this.maxDrawdownUc,
    required this.maxCostBasisUc,
    required this.retTenthPct,
    required this.ddTenthPct,
    required this.scoreTenths,
    required this.score,
    required this.dealCount,
    required this.closedDealCount,
    required this.playLabel,
    required this.real,
    required this.disclaimer,
    this.scenario,
    this.configSnapshot,
    this.name,
  });
}

// Run a bot config over a price path. PURE: returns fills + equity curve + the
// score inputs. opts['guard'] (spies) is accepted but NEVER called — Arena has no
// gate/broadcast path, so any such spy stays at zero (asserted by tests).
ArenaResult runScenario(Map<String, dynamic> opts) {
  List<num>? prices = (opts['prices'] as List?)?.map((e) => e as num).toList();
  if (prices == null && opts['vectors'] != null && opts['scenario'] != null) {
    prices = pricePath(
        (opts['vectors'] as Map).cast<String, dynamic>(), opts['scenario'] as String);
  }
  if (prices == null || prices.isEmpty) {
    throw ArgumentError(
        'arena.runScenario: need a price path (prices[] or vectors+scenario)');
  }

  final r = resolveBot(opts['bot'] ?? opts);
  final type = r.type, cfg = r.cfg, bcfg = r.bcfg, bd = r.bd;

  final midUc = microUsd(prices[0]);
  var dealSeq = 0;
  Map<String, dynamic>? current =
      _newDeal(type, 'arena:$type:${++dealSeq}', cfg, midUc, bd, 0);
  final closedDeals = <Map<String, dynamic>>[];
  final fills = <Map<String, dynamic>>[];
  final equityCurveUc = <BigInt>[];

  var realizedClosedUc = BigInt.zero; // sum of realized from CLOSED deals
  var maxCostBasisUc = BigInt.zero; // peak cost deployed (held-inventory basis)
  BigInt? peakEquityUc; // running peak of the equity curve
  var maxDrawdownUc = BigInt.zero; // largest peak-to-trough drop of equity
  var lastEquityUc = BigInt.zero;

  // DCA/smarttrade reopen a fresh deal after a close (grid is one deal). An
  // optional maxDeals caps how many deals a run opens.
  final double maxDeals = (opts['maxDeals'] != null && (opts['maxDeals'] as num).isFinite)
      ? math.max(1, (opts['maxDeals'] as num).truncate()).toDouble()
      : double.infinity;
  final reopen = (type == 'dca' || type == 'smarttrade'); // grid is one deal

  for (var ti = 0; ti < prices.length; ti++) {
    final markUc = microUsd(prices[ti]);
    final now = ti + 1; // synthetic monotonic sim clock (NOT wall time)

    if (current == null && reopen && dealSeq < maxDeals) {
      current = _newDeal(type, 'arena:$type:${++dealSeq}', cfg, midUc, bd, now);
    }

    if (current != null && type == 'dca') dcaObserve(current, markUc);

    var guard = 0;
    while (current != null && guard++ < 512) {
      final order = _engineStep(type, current, bcfg, cfg, markUc);
      if (order == null) break;
      if (order['action'] == 'arm') {
        order['_markUc'] = markUc;
        _engineApply(type, current, bcfg, cfg, order, null, now);
        continue;
      }
      final fill = _paperFill(order, markUc, bd);
      final fqty = fill['qty'] as BigInt?;
      if (fqty == null || fqty <= BigInt.zero) break; // rounds to zero — nothing fires
      _engineApply(type, current, bcfg, cfg, order, fill, now);
      fills.add({
        't': ti,
        'kind': order['kind'],
        'side': order['side'],
        'priceUc': (fill['priceUc'] as BigInt).toString(),
        'qty': (fill['qty'] as BigInt).toString(),
        'costUc': fill['costUc'] != null ? (fill['costUc'] as BigInt).toString() : null,
        'proceedsUc': fill['proceedsUc'] != null ? (fill['proceedsUc'] as BigInt).toString() : null,
        'paper': true,
      });
      // A closed deal is booked IMMEDIATELY (its realized PnL folds into the
      // curve) regardless of reopen/maxDeals; a new deal (if allowed) opens on
      // the next tick. This never loses a closed deal's realized profit.
      if (current['status'] == 'closed') {
        closedDeals.add(current);
        realizedClosedUc += (current['realizedUc'] as BigInt?) ?? BigInt.zero;
        current = null;
        break;
      }
    }

    // --- equity curve + score inputs at this tick -------------------------
    final aggDeal = (current != null && current['status'] != 'closed') ? current : null;
    final agg = _dealAgg(type, aggDeal, markUc, bd);
    final openRealized = (current != null && current['status'] != 'closed')
        ? ((current['realizedUc'] as BigInt?) ?? BigInt.zero)
        : BigInt.zero;
    final unrealizedUc = agg['openMarkUc']! - agg['openCostUc']!;
    final equityUc = realizedClosedUc + openRealized + unrealizedUc;
    lastEquityUc = equityUc;

    if (agg['openCostUc']! > maxCostBasisUc) maxCostBasisUc = agg['openCostUc']!;
    if (peakEquityUc == null || equityUc > peakEquityUc!) peakEquityUc = equityUc;
    final dd = peakEquityUc! - equityUc;
    if (dd > maxDrawdownUc) maxDrawdownUc = dd;

    equityCurveUc.add(equityUc);
  }

  final finalPnlUc = lastEquityUc;
  final sc = score(finalPnlUc, maxDrawdownUc, maxCostBasisUc);

  return ArenaResult(
    type: type,
    pair: r.pair,
    decimals: bd,
    fills: fills,
    equityCurveUc: equityCurveUc,
    finalPnlUc: finalPnlUc,
    maxDrawdownUc: maxDrawdownUc,
    maxCostBasisUc: maxCostBasisUc,
    retTenthPct: maxCostBasisUc > BigInt.zero
        ? divRound(finalPnlUc * BigInt.from(1000), maxCostBasisUc)
        : BigInt.zero,
    ddTenthPct: maxCostBasisUc > BigInt.zero
        ? divRound(maxDrawdownUc * BigInt.from(1000), maxCostBasisUc)
        : BigInt.zero,
    scoreTenths: sc.scoreTenths,
    score: sc.score,
    dealCount: closedDeals.length + ((current != null && current['status'] != 'closed') ? 1 : 0),
    closedDealCount: closedDeals.length,
    playLabel: kPlayLabel,
    real: false,
    disclaimer: kDisclaimer,
  );
}

// ===========================================================================
// SCORE (§9 pinned formula) — risk-adjusted, drawdown-penalized.
//   retPct = finalPnl / maxCostBasis · 100
//   ddPct  = maxDrawdown / maxCostBasis · 100
//   score  = round1(retPct − 0.5 · ddPct)
// All micro-dollar integer math (no float decides money). To avoid double
// rounding we fold the formula into ONE half-away-from-zero division to tenths:
//   scoreTenths = round( (finalPnl·1000 − maxDrawdown·500) / maxCostBasis )
// A no-trade run (maxCostBasis = 0) scores 0.
// ===========================================================================
ArenaScore score(BigInt? finalPnlUc, BigInt? maxDrawdownUc, BigInt? maxCostBasisUc) {
  final pnl = finalPnlUc ?? BigInt.zero;
  final dd = maxDrawdownUc ?? BigInt.zero;
  final basis = maxCostBasisUc ?? BigInt.zero;
  if (basis <= BigInt.zero) return ArenaScore(BigInt.zero, 0);
  final scoreTenths = divRound(pnl * BigInt.from(1000) - dd * BigInt.from(500), basis);
  return ArenaScore(scoreTenths, scoreTenths.toDouble() / 10);
}

// ===========================================================================
// XP + LEVELS — advisory UX progression (NOT a safety control; §9/§5).
// Levels gently UNLOCK advanced params/bot types, mirroring the real product's
// progressive disclosure. Gating here is UX only and never blocks a safety rail.
// ===========================================================================
const List<Map<String, dynamic>> kLevels = [
  {'level': 1, 'minXp': 0, 'unlocks': ['dca', 'simple-create']},
  {'level': 2, 'minXp': 50, 'unlocks': ['grid']},
  {'level': 3, 'minXp': 150, 'unlocks': ['advanced-params', 'safety-ladder']},
  {'level': 4, 'minXp': 350, 'unlocks': ['smarttrade', 'trailing-tp']},
  {'level': 5, 'minXp': 700, 'unlocks': ['martingale', 'signal']},
];

// XP for one completed run: a flat participation grant + a bonus for a POSITIVE
// risk-adjusted score (deterministic integer; reckless negative runs earn only
// the participation XP, never a penalty below zero).
int xpForRun(ArenaResult result) {
  const base = 10;
  final tenths = result.scoreTenths.toInt();
  final bonus = tenths > 0 ? (tenths / 10).round() : 0; // +1 XP per whole positive score point
  return base + bonus;
}

class LevelInfo {
  final int level;
  final List<String> unlocks;
  final int xp;
  final int? nextLevel;
  final int xpToNext;
  const LevelInfo(this.level, this.unlocks, this.xp, this.nextLevel, this.xpToNext);
}

LevelInfo levelForXp(int xp) {
  var cur = kLevels[0];
  for (final l in kLevels) {
    if (xp >= (l['minXp'] as int)) cur = l;
  }
  Map<String, dynamic>? next;
  for (final l in kLevels) {
    if ((l['minXp'] as int) > xp) {
      next = l;
      break;
    }
  }
  final unlocks = <String>[];
  for (final l in kLevels) {
    if (xp >= (l['minXp'] as int)) unlocks.addAll((l['unlocks'] as List).cast<String>());
  }
  return LevelInfo(
    cur['level'] as int,
    unlocks,
    xp,
    next != null ? next['level'] as int : null,
    next != null ? (next['minXp'] as int) - xp : 0,
  );
}

// ===========================================================================
// MISSIONS — clear win condition + reward (XP). Deterministic checks off a run
// result. (More can be added; these cover the §9 examples.)
// ===========================================================================
class Mission {
  final String id;
  final String name;
  final String desc;
  final String? scenario;
  final int rewardXp;
  final bool Function(ArenaResult res) check;
  const Mission(this.id, this.name, this.desc, this.scenario, this.rewardXp, this.check);
}

final List<Mission> kMissions = [
  Mission(
    'survive_crash_green',
    'Survive the Flash-crash',
    'Finish the Flash-crash scenario in the green (positive play PnL).',
    'crash',
    40,
    (res) => res.scenario == 'crash' && res.finalPnlUc > BigInt.zero,
  ),
  Mission(
    'crab_grid_ten',
    'Range Rider',
    'Beat +10% with a grid bot in a Crab (ranging) market.',
    'crab',
    35,
    (res) => res.scenario == 'crab' && res.type == 'grid' && res.retTenthPct >= BigInt.from(100),
  ),
  Mission(
    'deep_ladder_survivor',
    'Deep Ladder',
    'Build a 4+ safety-order ladder that finishes non-negative through a Bear/Crash drop.',
    null,
    50,
    (res) =>
        (res.scenario == 'bear' || res.scenario == 'crash') &&
        res.type == 'dca' &&
        (res.configSnapshot != null &&
            ((res.configSnapshot!['maxSafetyOrders'] as num?) ?? 0) >= 4) &&
        res.finalPnlUc >= BigInt.zero,
  ),
  Mission(
    'steady_hand',
    'Steady Hand',
    'Finish any scenario with a positive score AND a drawdown under 15%.',
    null,
    25,
    (res) => res.scoreTenths > BigInt.zero && res.ddTenthPct < BigInt.from(150),
  ),
];

Mission? missionById(String id) {
  for (final m in kMissions) {
    if (m.id == id) return m;
  }
  return null;
}

bool checkMission(String id, ArenaResult res) {
  final m = missionById(id);
  return m != null && m.check(res);
}

List<String> completedMissions(ArenaResult res) {
  final out = <String>[];
  for (final m in kMissions) {
    try {
      if (m.check(res)) out.add(m.id);
    } catch (_) {}
  }
  return out;
}

// ===========================================================================
// BADGES / achievements — milestones over a profile's history.
// ===========================================================================
class Badge {
  final String id;
  final String name;
  final String desc;
  final bool Function(ArenaProfile p) check;
  const Badge(this.id, this.name, this.desc, this.check);
}

final List<Badge> kBadges = [
  Badge('first_run', 'First Steps', 'Complete your first Arena run.', (p) => p.runs >= 1),
  Badge('green_run', 'In the Green', 'Finish a run with positive play PnL.', (p) => p.greenRuns >= 1),
  Badge('high_score', 'Sharp Shooter', 'Score 10 or higher on any run.',
      (p) => p.bestScoreTenths >= BigInt.from(100)),
  Badge('diamond_hands', 'Diamond Hands', 'Survive the Flash-crash in the green.',
      (p) => p.survivedCrash),
  Badge('all_scenarios', 'Globetrotter', 'Run every scenario at least once.',
      (p) => p.scenariosPlayed.length >= kScenarios.length),
  Badge('veteran', 'Veteran', 'Complete 25 runs.', (p) => p.runs >= 25),
];

// ===========================================================================
// Leaderboard — LOCAL-FIRST ONLY (personal best + on-device board). NO network,
// NO global board in v1 (deferred: needs server + anti-cheat + fairness review).
// ===========================================================================
class Leaderboard {
  final Map<String, List<Map<String, dynamic>>> entries = {}; // scenario -> [entry] sorted desc

  Map<String, dynamic>? add(Map<String, dynamic> entry) {
    final s = entry['scenario'] as String?;
    if (s == null) return null;
    final e = <String, dynamic>{
      'scenario': s,
      'score': entry['score'],
      'scoreTenths': entry['scoreTenths'] != null
          ? entry['scoreTenths'].toString()
          : ((((entry['score'] as num?) ?? 0) * 10).round()).toString(),
      'type': entry['type'],
      'name': entry['name'],
      'at': entry['at'] ?? DateTime.now().millisecondsSinceEpoch,
    };
    final list = entries.putIfAbsent(s, () => <Map<String, dynamic>>[]);
    list.add(e);
    list.sort((a, b) {
      final d = int.parse(b['scoreTenths'] as String) - int.parse(a['scoreTenths'] as String);
      if (d != 0) return d;
      return (a['at'] as int) - (b['at'] as int);
    });
    if (list.length > 100) list.length = 100;
    return e;
  }

  Map<String, dynamic>? personalBest(String scenario) {
    final a = entries[scenario];
    return (a != null && a.isNotEmpty) ? a[0] : null;
  }

  List<Map<String, dynamic>> top(String scenario, [int n = 10]) {
    final a = entries[scenario] ?? const <Map<String, dynamic>>[];
    return a.take(n).toList();
  }

  Map<String, dynamic> toJson() => {'local': true, 'global': false, 'entries': entries};
}

// ===========================================================================
// ArenaProfile — ties it together: play balance, XP/level, missions, badges,
// local leaderboard, run history. LOCAL-first; optional store shim (no keys).
// ===========================================================================
class ArenaProfile {
  final PlayBalance playBalance;
  int xp = 0;
  int runs = 0;
  int greenRuns = 0;
  BigInt bestScoreTenths = BigInt.from(-1000000000);
  bool survivedCrash = false;
  final Set<String> scenariosPlayed = {};
  final Set<String> missionsCompleted = {};
  final Set<String> badges = {};
  final Leaderboard leaderboard = Leaderboard();
  final List<Map<String, dynamic>> history = [];

  ArenaProfile({num? grantUsd}) : playBalance = PlayBalance(grantUsd);

  // Run a scenario and record it into the profile (XP, missions, badges, board).
  // opts: { bot|type/config/pair, scenario, vectors } — PURE sim; no gate.
  Map<String, dynamic> run(Map<String, dynamic> opts) {
    final res = runScenario(opts);
    res.scenario = (opts['scenario'] as String?) ??
        ((opts['bot'] is Map) ? (opts['bot'] as Map)['scenario'] as String? : null);
    res.configSnapshot = _snapshotConfig(opts);
    res.name = (opts['name'] as String?) ??
        ((opts['bot'] is Map) ? (opts['bot'] as Map)['name'] as String? : null);

    // play balance moves ONLY by play PnL — still PLAY, never real.
    playBalance.applyPnl(res.finalPnlUc);
    runs += 1;
    if (res.finalPnlUc > BigInt.zero) greenRuns += 1;
    if (res.scoreTenths > bestScoreTenths) bestScoreTenths = res.scoreTenths;
    if (res.scenario != null) scenariosPlayed.add(res.scenario!);
    if (res.scenario == 'crash' && res.finalPnlUc > BigInt.zero) survivedCrash = true;

    // XP: run grant + any newly-completed mission rewards.
    var gained = xpForRun(res);
    final newlyDone = <String>[];
    for (final id in completedMissions(res)) {
      if (!missionsCompleted.contains(id)) {
        missionsCompleted.add(id);
        newlyDone.add(id);
        final m = missionById(id);
        if (m != null) gained += m.rewardXp;
      }
    }
    xp += gained;

    // badges
    final newBadges = <String>[];
    for (final b in kBadges) {
      if (!badges.contains(b.id) && b.check(this)) {
        badges.add(b.id);
        newBadges.add(b.id);
      }
    }

    // local leaderboard
    if (res.scenario != null) {
      leaderboard.add({
        'scenario': res.scenario,
        'score': res.score,
        'scoreTenths': res.scoreTenths,
        'type': res.type,
        'name': res.name,
      });
    }

    history.add({
      'scenario': res.scenario,
      'score': res.score,
      'finalPnlUc': res.finalPnlUc.toString(),
      'at': DateTime.now().millisecondsSinceEpoch,
    });

    return {
      'result': res,
      'xpGained': gained,
      'xp': xp,
      'level': levelForXp(xp),
      'missionsCompleted': newlyDone,
      'badgesEarned': newBadges,
      'playBalance': playBalance.toJson(),
      'disclaimer': kDisclaimer,
    };
  }

  LevelInfo level() => levelForXp(xp);
}

Map<String, dynamic> _snapshotConfig(Map<String, dynamic> opts) {
  final src = (opts['bot'] is Map && (opts['bot'] as Map)['config'] is Map)
      ? ((opts['bot'] as Map)['config'] as Map).cast<String, dynamic>()
      : ((opts['config'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{});
  // shallow numeric snapshot for mission checks
  return Map<String, dynamic>.from(src);
}

// ===========================================================================
// USE THIS FOR REAL — the ONE honest on-ramp (§9 / §6). Export the Arena config
// as a Bot TEMPLATE, then import it. Import ALWAYS lands paper + disabled +
// testnet with zero allocation — NEVER auto-live. Reuses the existing template
// import which structurally enforces that; Arena adds no bypass.
// ===========================================================================
Map<String, dynamic> exportAsTemplate(dynamic botOrSpec) {
  final bot = (botOrSpec is Bot) ? botOrSpec : resolveBot(botOrSpec).bot;
  return exportBot(bot);
}

// Import an Arena config into a REAL (but paper + disabled + testnet) bot spec.
// Returns the Bot produced by the existing non-bypassable template import.
Bot useForReal(dynamic botOrSpecOrTemplate) {
  final dynamic template = (botOrSpecOrTemplate is Map &&
          (botOrSpecOrTemplate)['kind'] == 'blockle-bot-template')
      ? botOrSpecOrTemplate
      : exportAsTemplate(botOrSpecOrTemplate);
  return importTemplate(template); // ALWAYS paper + disabled + testnet + alloc 0
}
