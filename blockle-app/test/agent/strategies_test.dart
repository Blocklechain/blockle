// Strategy-engine tests (AGENT-STRATEGIES.md sections 3 + 6), checked against the
// SHARED fixture docs/strategy-vectors.json so all three langs agree on the same
// numbers. Strategies are pure PLANNERS: these tests assert the Intents they
// return, never a broadcast.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/strategies.dart';

Map<String, dynamic> _loadVectors() {
  for (final p in [
    '../docs/strategy-vectors.json',
    'docs/strategy-vectors.json',
    '${Directory.current.path}/../docs/strategy-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return (jsonDecode(f.readAsStringSync()) as Map).cast<String, dynamic>();
    }
  }
  throw StateError('strategy-vectors.json not found from ${Directory.current.path}');
}

Future<Map<String, num>> _pricesFrom(Map? m) async {
  final out = <String, num>{};
  (m ?? const {}).forEach((k, v) => out['$k'] = v as num);
  return out;
}

void main() {
  final vectors = _loadVectors();
  Map<String, dynamic> caseOf(String strat, String name) =>
      ((vectors[strat] as Map)[name] as Map).cast<String, dynamic>();

  group('arbitrage', () {
    test('(a) detects a real edge and emits a balanced 2-leg pair', () async {
      final c = caseOf('arbitrage', 'detect_and_emit_pair');
      final venues = (c['venues'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        listVenues: (_) async => venues,
        prices: (_) => _pricesFrom(c['prices'] as Map?),
        policyRemaining: () => {'sessionUsd': null, 'perAsset': {}},
      );
      final strat = ArbitrageStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map).cast<String, dynamic>();
      final expIntents = (exp['intents'] as List).cast<Map>();
      expect(intents.length, expIntents.length);
      for (var i = 0; i < intents.length; i++) {
        expect(intents[i].tool, expIntents[i]['tool']);
        expect(intents[i].args['from'], expIntents[i]['from']);
        expect(intents[i].args['to'], expIntents[i]['to']);
        expect(intents[i].args['amount'], expIntents[i]['amount']);
        expect(intents[i].args['venue'], expIntents[i]['venue']);
      }
      // balanced: the two legs share a pair group, one buy + one sell.
      expect(intents[0].pair, isNotNull);
      expect(intents[0].pair, intents[1].pair);
    });

    test('(b) refuses when gross edge is positive but net < threshold', () async {
      final c = caseOf('arbitrage', 'refuse_below_net_threshold');
      final venues = (c['venues'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        listVenues: (_) async => venues,
        prices: (_) => _pricesFrom(c['prices'] as Map?),
        policyRemaining: () => {'sessionUsd': null},
      );
      final strat = ArbitrageStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      expect(intents, isEmpty);
    });

    test('never emits a single leg (both or neither)', () async {
      final c = caseOf('arbitrage', 'detect_and_emit_pair');
      final venues = (c['venues'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        listVenues: (_) async => venues,
        prices: (_) => _pricesFrom(c['prices'] as Map?),
        policyRemaining: () => {'sessionUsd': null},
      );
      final strat = ArbitrageStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      expect(intents.isEmpty || intents.length == 2, isTrue);
    });
  });

  group('dca', () {
    test('fires exactly once when the interval has elapsed', () async {
      final c = caseOf('dca', 'fires_on_interval');
      final ctx = StrategyContext(
        now: () => (c['now'] as num).toInt(),
        prices: (_) => _pricesFrom(c['prices'] as Map?),
      );
      final strat = DcaStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map)['intents'] as List;
      expect(intents.length, exp.length);
      expect(intents.first.tool, exp.first['tool']);
      expect(intents.first.args['from'], exp.first['from']);
      expect(intents.first.args['to'], exp.first['to']);
      expect(intents.first.args['amount'], exp.first['amount']);
    });

    test('nothing before the interval elapses', () async {
      final c = caseOf('dca', 'quiet_before_interval');
      final ctx = StrategyContext(
        now: () => (c['now'] as num).toInt(),
        prices: (_) => _pricesFrom(c['prices'] as Map?),
      );
      final strat = DcaStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      expect(intents, isEmpty);
    });
  });

  group('grid', () {
    test('emits the right buy/sell levels at the right prices', () async {
      final c = caseOf('grid', 'symmetric_ladder');
      final ctx = StrategyContext(
        now: () => 0,
        getBook: (_) async => (c['book'] as Map).cast<String, dynamic>(),
        prices: (_) => _pricesFrom(c['prices'] as Map?),
        openOrders: (_) => <Map<String, dynamic>>[],
      );
      final strat = GridStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map)['intents'] as List;
      expect(intents.length, exp.length);
      for (var i = 0; i < intents.length; i++) {
        expect(intents[i].tool, 'place_order');
        expect(intents[i].args['side'], exp[i]['side']);
        expect(intents[i].args['price'], exp[i]['price']);
        expect(intents[i].args['amount'], exp[i]['amount']);
        expect(intents[i].args['type'], 'limit');
      }
    });

    test('skips a level already occupied by an open order', () async {
      final c = caseOf('grid', 'skips_occupied_level');
      final open = (c['openOrders'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        getBook: (_) async => (c['book'] as Map).cast<String, dynamic>(),
        prices: (_) => _pricesFrom(c['prices'] as Map?),
        openOrders: (_) => open,
      );
      final strat = GridStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map)['intents'] as List;
      expect(intents.length, exp.length);
      // the occupied 0.99 buy level is gone.
      expect(intents.any((i) => i.args['price'] == '0.99'), isFalse);
      for (var i = 0; i < intents.length; i++) {
        expect(intents[i].args['side'], exp[i]['side']);
        expect(intents[i].args['price'], exp[i]['price']);
      }
    });
  });

  group('rebalance', () {
    test('sells only the out-of-band asset, half-gap sized, correct direction', () async {
      final c = caseOf('rebalance', 'sell_overweight_half_gap');
      final bals = (c['balances'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        getBalance: (_, [__]) async => bals,
        prices: (_) => _pricesFrom(c['prices'] as Map?),
      );
      final strat = RebalanceStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map)['intents'] as List;
      expect(intents.length, exp.length);
      expect(intents.first.tool, 'swap');
      expect(intents.first.args['from'], exp.first['from']); // sell BLOCK
      expect(intents.first.args['to'], exp.first['to']); // -> USDC
      expect(intents.first.args['amount'], exp.first['amount']);
      expect(intents.first.estUsd, closeTo((exp.first['estUsd'] as num).toDouble(), 1e-6));
    });

    test('no trade while every asset is inside the band', () async {
      final c = caseOf('rebalance', 'in_band_no_trade');
      final bals = (c['balances'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        getBalance: (_, [__]) async => bals,
        prices: (_) => _pricesFrom(c['prices'] as Map?),
      );
      final strat = RebalanceStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      expect(intents, isEmpty);
    });
  });

  group('momentum', () {
    test('buys on a golden cross', () async {
      final c = caseOf('momentum', 'golden_cross_buys');
      final ctx = StrategyContext(now: () => 0, prices: (_) => _pricesFrom(c['prices'] as Map?));
      final strat = MomentumStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map)['intents'] as List;
      expect(intents.length, exp.length);
      expect(intents.first.args['from'], exp.first['from']);
      expect(intents.first.args['to'], exp.first['to']);
      expect(intents.first.args['amount'], exp.first['amount']);
    });

    test('sells (only what is held) on a death cross', () async {
      final c = caseOf('momentum', 'death_cross_sells_held');
      final bals = (c['balances'] as List).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
      final ctx = StrategyContext(
        now: () => 0,
        prices: (_) => _pricesFrom(c['prices'] as Map?),
        getBalance: (_, [__]) async => bals,
      );
      final strat = MomentumStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      final exp = (c['expect'] as Map)['intents'] as List;
      expect(intents.length, exp.length);
      expect(intents.first.args['from'], exp.first['from']); // sell BLOCK
      expect(intents.first.args['to'], exp.first['to']);
      expect(intents.first.args['amount'], exp.first['amount']);
    });

    test('does nothing with no cross', () async {
      final c = caseOf('momentum', 'no_cross_quiet');
      final ctx = StrategyContext(now: () => 0, prices: (_) => _pricesFrom(c['prices'] as Map?));
      final strat = MomentumStrategy();
      final intents = await strat.plan(ctx, strat.validateParams(c['params'] as Map<String, dynamic>));
      expect(intents, isEmpty);
    });

    test('needs at least longN prices', () async {
      final ctx = StrategyContext(now: () => 0, prices: (_) async => {'USDC': 1});
      final strat = MomentumStrategy();
      final intents = await strat.plan(ctx,
          strat.validateParams({'market': 'BLOCK/USDC', 'shortN': 2, 'longN': 3, 'history': [1, 2]}));
      expect(intents, isEmpty);
    });

    test('FEE-AWARE entry gate (lever 3) skips a sub-threshold golden cross', () async {
      // A weak golden cross: short just barely above long. With the gate ARMED the
      // entry is skipped; the SAME cross at the default (0) still buys.
      final history = [100, 100, 100, 100, 100.2]; // tiny upmove -> small strength
      final notes = <Map<String, dynamic>>[];
      final ctx = StrategyContext(
        now: () => 0,
        prices: (_) async => {'USDC': 1, 'BLOCK': 1},
        note: notes.add,
      );
      final strat = MomentumStrategy();
      final base = {'market': 'BLOCK/USDC', 'shortN': 2, 'longN': 3, 'tradeUsd': 20, 'history': history};

      final armed = await strat.plan(ctx,
          strat.validateParams({...base, 'roundTripCostBps': 60, 'feeAwareMarginBps': 25}));
      expect(armed, isEmpty, reason: 'sub-threshold entry is skipped when armed');
      expect(notes.any((n) => '${n['skipped']}'.contains('fee-aware threshold')), isTrue);

      final dflt = await strat.plan(ctx, strat.validateParams(base));
      expect(dflt.length, 1, reason: 'default (gate off) still buys on the golden cross');
    });

    test('FEE-AWARE gate never suppresses a genuinely strong cross', () async {
      final history = [1, 1, 1, 1, 2]; // strong move (~10000 bps)
      final ctx = StrategyContext(now: () => 0, prices: (_) async => {'USDC': 1, 'BLOCK': 1});
      final strat = MomentumStrategy();
      final intents = await strat.plan(ctx, strat.validateParams({
        'market': 'BLOCK/USDC', 'shortN': 2, 'longN': 3, 'tradeUsd': 20,
        'history': history, 'roundTripCostBps': 60, 'feeAwareMarginBps': 25,
      }));
      expect(intents.length, 1, reason: 'a strong cross clears the fee-aware threshold');
      expect(intents.first.tag.endsWith(':buy'), isTrue);
    });
  });

  // ----- the 11 indicator planners (ported from the JS live planners), checked
  // byte-for-byte against the SAME shared fixture cases. --------------------
  Future<List<StrategyIntent>> runCase(String strat, Map<String, dynamic> c) {
    final s = defaultStrategies()[strat]!;
    final bals = (c['balances'] as List?)
        ?.cast<Map>()
        .map((m) => m.cast<String, dynamic>())
        .toList();
    final sessionUsd = c['sessionUsd'];
    final ctx = StrategyContext(
      now: () => 0,
      prices: (_) => _pricesFrom(c['prices'] as Map?),
      getBalance: bals == null ? null : (_, [__]) async => bals,
      policyRemaining:
          sessionUsd == null ? null : () => {'sessionUsd': sessionUsd},
    );
    return s.plan(ctx, s.validateParams(c['params'] as Map<String, dynamic>));
  }

  void fixtureCase(String strat, String name) {
    test('$strat / $name matches the shared vector', () async {
      final c = caseOf(strat, name);
      final got = await runCase(strat, c);
      final exp = ((c['expect'] as Map)['intents'] as List).cast<Map>();
      expect(got.length, exp.length, reason: '$strat/$name intent count');
      for (var i = 0; i < got.length; i++) {
        expect(got[i].tool, exp[i]['tool'], reason: '$strat/$name tool');
        expect(got[i].args['from'], exp[i]['from'], reason: '$strat/$name from');
        expect(got[i].args['to'], exp[i]['to'], reason: '$strat/$name to');
        expect(got[i].args['amount'], exp[i]['amount'], reason: '$strat/$name amount');
        if (exp[i]['venue'] != null) {
          expect(got[i].args['venue'], exp[i]['venue'], reason: '$strat/$name venue');
        }
      }
    });
  }

  group('indicator planners (shared vectors)', () {
    const cases = <String, List<String>>{
      'rsi': [
        'oversold_buys',
        'oversold_buys_clamped',
        'overbought_sells_held',
        'nonstable_quote_buys',
        'warming_up_quiet',
      ],
      'macd': ['cross_up_buys', 'cross_down_sells_held'],
      'bollinger': ['lower_band_buys', 'upper_band_sells_held'],
      'breakout': ['new_high_buys', 'range_break_sells_held'],
      'emacross': ['cross_up_buys', 'cross_down_sells_held'],
      'momentum_roc': ['strong_roc_buys', 'negative_roc_sells_held'],
      'meanrev': ['below_mean_buys', 'above_mean_sells_held'],
      'rebalance_hold': [
        'overweight_sells',
        'underweight_buys',
        'underweight_buys_clamped',
        'in_band_no_trade',
      ],
      'hodl': ['buys_when_flat', 'buys_when_flat_clamped', 'holds_when_held'],
    };
    cases.forEach((strat, names) {
      for (final n in names) {
        fixtureCase(strat, n);
      }
    });

    test('all 14 live strategies are registered (scalp + martingale dropped)', () {
      final names = defaultStrategies().keys.toList();
      expect(
        names,
        containsAll(<String>[
          'arbitrage', 'dca', 'grid', 'rebalance', 'momentum',
          'rsi', 'macd', 'bollinger', 'breakout', 'emacross',
          'momentum_roc', 'meanrev', 'rebalance_hold', 'hodl',
        ]),
      );
      // scalp + martingale are intentionally absent from the LIVE registry.
      expect(names, isNot(contains('scalp')));
      expect(names, isNot(contains('martingale')));
    });
  });

  group('param validation', () {
    test('arbitrage requires a pair', () {
      expect(() => ArbitrageStrategy().validateParams({}), throwsArgumentError);
    });
    test('grid clamps levels into 2..20', () {
      final p = GridStrategy().validateParams({'market': 'A/B', 'levels': 99});
      expect(p['levels'], 20);
      final p2 = GridStrategy().validateParams({'market': 'A/B', 'levels': 1});
      expect(p2['levels'], 2);
    });
    test('rebalance requires weights that sum to ~1', () {
      expect(() => RebalanceStrategy().validateParams({'targets': {'A': 0.2, 'B': 0.2}}),
          throwsArgumentError);
    });
    test('momentum requires shortN < longN', () {
      expect(() => MomentumStrategy().validateParams({'market': 'A/B', 'shortN': 30, 'longN': 10}),
          throwsArgumentError);
    });
  });
}
