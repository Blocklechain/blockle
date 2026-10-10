// Regression tests that LOCK the verifier-found strategy-engine fixes
// (docs/AGENT-STRATEGIES.md §0 safety, §3.1 arbitrage, §5 fees). Each test maps
// to one canonical fix and fails if that rail is weakened. Vectors are inline
// here (the shared docs/strategy-vectors.json is intentionally NOT touched).

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/strategies.dart';
import 'package:blockle_app/agent/strategy_runner.dart';
import 'package:blockle_app/agent/tools.dart';

/// A strategy that returns a fixed list of Intents (full control for gate tests).
class _FixedStrategy extends Strategy {
  final List<StrategyIntent> intents;
  _FixedStrategy(this.intents);
  @override
  String get name => 'fixed';
  @override
  String describe() => 'test fixture strategy';
  @override
  Map<String, dynamic> get defaults => {};
  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) => {...?params};
  @override
  Future<List<StrategyIntent>> plan(StrategyContext ctx, Map<String, dynamic> params) async =>
      intents;
}

StrategyIntent _intent(String tool, {String tag = 'fixed:x'}) => StrategyIntent(
      tool: tool,
      args: const {'chain': 'block', 'to': 'block1x', 'amount': '1'},
      rationale: 'fixture',
      estUsd: 1,
      strategy: 'fixed',
      tag: tag,
    );

void main() {
  // =========================================================================
  // FIX-4 — BigInt-exact USD -> base-unit conversion (deterministic across langs)
  // =========================================================================
  group('FIX-4: usdToBase is BigInt-exact', () {
    test('123.456789 of an 18-decimal asset @ \$1 loses no low digits', () {
      expect(usdToBase(123.456789, 18, 1),
          BigInt.parse('123456789000000000000'));
    });
    test('floors toward zero, exact at 8dp @ \$0.99', () {
      // 10 / 0.99 * 1e8 = 1010101010.10... -> floor
      expect(usdToBase(10, 8, 0.99), BigInt.from(1010101010));
    });
    test('zero / non-positive inputs are zero', () {
      expect(usdToBase(0, 18, 1), BigInt.zero);
      expect(usdToBase(5, 18, 0), BigInt.zero);
    });
  });

  // =========================================================================
  // FIX-1 — arbitrage recomputes cost on the DEPTH-CLAMPED size + estUsd=clamped
  // =========================================================================
  group('FIX-1: arbitrage depth/gas on the clamped notional', () {
    StrategyContext ctx(List<Map<String, dynamic>> venues) => StrategyContext(
          now: () => 0,
          listVenues: (_) async => venues,
          prices: (_) async => {'USDC': 1},
          policyRemaining: () => {'sessionUsd': null},
        );

    test('fat gross edge but tiny venue depth => emits NOTHING', () async {
      // ask 100 / bid 105 (gross ~500bps) but depth is only ~0.01 unit (~\$1),
      // so the \$2 gas buffer alone is ~20000bps of the clamped size => net < 0.
      final venues = [
        {'id': 'a', 'chain': 'eth', 'mainnet': false, 'ask': '100', 'bid': '99', 'feeBps': 0, 'depthBase': '1000000'},
        {'id': 'b', 'chain': 'eth', 'mainnet': false, 'ask': '106', 'bid': '105', 'feeBps': 0, 'depthBase': '1000000'},
      ];
      final strat = ArbitrageStrategy();
      final p = strat.validateParams({
        'pair': 'FOO/USDC',
        'minEdgeBps': 1,
        'maxNotionalUsd': 50,
        'gasBufferUsd': 2,
      });
      final intents = await strat.plan(ctx(venues), p);
      expect(intents, isEmpty); // would WRONGLY emit if gas used the full \$50 probe
    });

    test('when depth clamps but edge still clears, estUsd is the CLAMPED notional', () async {
      // gross ~1000bps, depth 0.1 unit (~\$10) < \$50 cap; no gas; fees 0.
      final venues = [
        {'id': 'a', 'chain': 'eth', 'mainnet': false, 'ask': '100', 'bid': '99', 'feeBps': 0, 'depthBase': '10000000'},
        {'id': 'b', 'chain': 'eth', 'mainnet': false, 'ask': '111', 'bid': '110', 'feeBps': 0, 'depthBase': '10000000'},
      ];
      final strat = ArbitrageStrategy();
      final p = strat.validateParams({
        'pair': 'FOO/USDC',
        'minEdgeBps': 1,
        'maxNotionalUsd': 50,
        'gasBufferUsd': 0,
      });
      final intents = await strat.plan(ctx(venues), p);
      expect(intents.length, 2);
      // clamped to depth (~\$10), NOT the \$50 probe.
      expect(intents[0].estUsd, closeTo(10, 1e-6));
      expect(intents[1].estUsd, closeTo(10, 1e-6));
      // base bought == 0.1 unit (10000000 @ 8dp), consistent with the clamp.
      expect(intents[1].args['amount'], '10000000');
    });
  });

  // =========================================================================
  // FIX-2 — agent-fee term pinned at the real on-chain fee (never 0); slip floor
  // =========================================================================
  group('FIX-2: agent fee pinned at AGENT_FEE_BPS', () {
    test('agentFeeBps:0 + gross just under the true 10bps fee => emits NOTHING', () async {
      // gross ~9bps; a caller tries agentFeeBps:0 + slippageBps:0. Pinned to 2x5=10
      // (+ slippage floor) so net stays negative and no loss-making arb is proposed.
      final venues = [
        {'id': 'a', 'chain': 'eth', 'mainnet': false, 'ask': '1.0000', 'bid': '0.9990', 'feeBps': 0},
        {'id': 'b', 'chain': 'eth', 'mainnet': false, 'ask': '1.0010', 'bid': '1.0009', 'feeBps': 0},
      ];
      final ctx = StrategyContext(
        now: () => 0,
        listVenues: (_) async => venues,
        prices: (_) async => {'USDC': 1},
        policyRemaining: () => {'sessionUsd': null},
      );
      final strat = ArbitrageStrategy();
      final p = strat.validateParams({
        'pair': 'FOO/USDC',
        'minEdgeBps': 1,
        'maxNotionalUsd': 100,
        'gasBufferUsd': 0,
        'agentFeeBps': 0, // caller attempt to zero the fee
        'slippageBps': 0, // caller attempt to zero slippage
      });
      // the fee/slippage floors took effect on the validated params...
      expect(p['agentFeeBps'], AGENT_FEE_BPS);
      expect(p['slippageBps'], greaterThanOrEqualTo(1));
      // ...so the planner refuses the sub-fee gross edge.
      final intents = await strat.plan(ctx, p);
      expect(intents, isEmpty);
    });
  });

  // =========================================================================
  // FIX-3 — chain-level mainnet backstop covers venue-less auto-routed swaps
  // =========================================================================
  group('FIX-3: mainnet backstop via ctx.network()', () {
    StrategyRunner runnerOn(StrategyContext ctx) => StrategyRunner(
          tools: buildTools(const AgentContext()),
          policy: Policy.create(caps: {'sessionUsd': 1000}, confirm: (_) async => true),
          ctx: ctx,
          mainnetEnabled: false,
        );

    test('dca in auto is REFUSED when the resolved network is mainnet', () async {
      final ctx = StrategyContext(
        now: () => 86400000,
        network: () => 'mainnet', // chain-level signal; no venue, no caller param
        prices: (_) async => {'USDC': 1, 'BLOCK': 1},
      );
      final res = await runnerOn(ctx).tick('dca', {'asset': 'BLOCK'}, mode: 'auto');
      expect(res.records.length, 1);
      expect(res.records.first['refused'], 'mainnet');
    });

    test('rebalance in auto is REFUSED when the resolved network is mainnet', () async {
      final ctx = StrategyContext(
        now: () => 0,
        network: () => 'mainnet',
        getBalance: (_, [__]) async => [
          {'asset': {'symbol': 'BLOCK', 'decimals': 8, 'chain': 'block'}, 'confirmed': '7000000000'},
          {'asset': {'symbol': 'USDC', 'decimals': 6, 'chain': 'base'}, 'confirmed': '30000000'},
        ],
        prices: (_) async => {'BLOCK': 1, 'USDC': 1},
      );
      final res = await runnerOn(ctx).tick(
          'rebalance', {'targets': {'BLOCK': 0.5, 'USDC': 0.5}, 'maxTradeUsd': 1000},
          mode: 'auto');
      expect(res.records.any((r) => r['refused'] == 'mainnet'), isTrue);
    });
  });

  // =========================================================================
  // FIX-5 — mode fail-safe: dispatch ONLY on exactly "auto"
  // =========================================================================
  group('FIX-5: any non-"auto" mode fails safe to propose', () {
    test('mode "dryrun" dispatches NOTHING (emits a proposal instead)', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final sr = StrategyRunner(
        tools: buildTools(ctx),
        policy: Policy.create(confirm: (_) async => true),
        ctx: StrategyContext(now: () => 0),
        strategies: {'fixed': _FixedStrategy([_intent('send')])},
      );
      final res = await sr.tick('fixed', {}, mode: 'dryrun');
      expect(broadcast, 0);
      expect(res.records.first['proposed'], isNotNull);
    });
  });

  // =========================================================================
  // FIX-6 — structural gate: a non-value-moving tool is dropped, never crashes
  // =========================================================================
  group('FIX-6: auto never runs a non-value-moving tool', () {
    test('an Intent naming a read-only tool is BLOCKED (no execution, no crash)', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final sr = StrategyRunner(
        tools: buildTools(ctx),
        policy: Policy.create(confirm: (_) async => true), // null allowlist => all allowed
        ctx: StrategyContext(now: () => 0),
        strategies: {'fixed': _FixedStrategy([_intent('get_markets', tag: 'fixed:ro')])},
      );
      final res = await sr.tick('fixed', {}, mode: 'auto');
      expect(broadcast, 0);
      expect(res.halted, isFalse); // the read-only tool did NOT abort the tick
      expect(res.records.first['blocked'], isNotNull);
      expect('${res.records.first['reason']}'.contains('not value-moving'), isTrue);
    });
  });
}
