// StrategyRunner gate-integration tests (AGENT-STRATEGIES.md section 6, "the
// important one"): a strategy Intent dispatched in AUTO mode is still subject to
// every safety rail — per-asset/USD caps, kill mid-tick, confirm above the
// auto-approve threshold, the mainnet gate, and the tool allowlist — because the
// runner dispatches through the ONE shared value-moving routine. Plus the
// end-to-end `swap` commit + mandatory 0.05% fee leg, and the audit trim anchor.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/audit.dart';
import 'package:blockle_app/agent/discovery.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/runner.dart' show dispatchValueMoving;
import 'package:blockle_app/agent/strategies.dart';
import 'package:blockle_app/agent/strategy_runner.dart';
import 'package:blockle_app/agent/tools.dart';
import 'package:blockle_app/multichain/venues.dart';

/// A duck-typed READ-ONLY discovery feed (matches the `{ scan() }` contract the
/// StrategyRunner expects). It never trades, signs, or approves.
class _FakeDiscovery {
  final List<Candidate> _c;
  _FakeDiscovery(this._c);
  Future<List<Candidate>> scan() async => _c;
}

StrategyIntent _swap(String token, {String tag = 'disc'}) => StrategyIntent(
      tool: 'swap',
      args: {'from': token, 'to': 'USDC', 'amount': '1'},
      rationale: 'discovered-token trade',
      estUsd: 1,
      strategy: 'fixed',
      tag: '$tag:$token',
    );

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

StrategyContext _noCtx() => StrategyContext(now: () => 0);

StrategyIntent _send(String amount, {String tag = 'fixed:send', bool mainnet = false}) =>
    StrategyIntent(
      tool: 'send',
      args: {'chain': 'block', 'to': 'block1x', 'amount': amount},
      rationale: 'test send',
      estUsd: null,
      strategy: 'fixed',
      tag: tag,
      mainnet: mainnet,
    );

void main() {
  group('gate integration — strategies cannot bypass the safety layer', () {
    test('(a) a per-USD cap rejects an auto Intent before it commits', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 999,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(caps: {'sessionUsd': 10}, confirm: (_) async => true);
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        strategies: {'fixed': _FixedStrategy([_send('1')])},
      );
      final res = await sr.tick('fixed', {}, mode: 'auto');
      expect(broadcast, 0);
      expect(res.records.first['rejected'], 'cap');
      expect('${res.records.first['error']}'.contains('cap exceeded'), isTrue);
    });

    test('(b) a kill mid-tick aborts the whole tick and blocks the commit', () async {
      var broadcast = 0;
      late Policy policy;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      policy = Policy.create(confirm: (_) async {
        await policy.kill('user'); // kill arrives during the confirm await
        return true;
      });
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        strategies: {
          'fixed': _FixedStrategy([_send('1', tag: 'a'), _send('1', tag: 'b')])
        },
      );
      final res = await sr.tick('fixed', {}, mode: 'auto');
      expect(res.halted, isTrue);
      expect(broadcast, 0); // commit blocked, second leg never dispatched
      expect(policy.isKilled(), isTrue);
    });

    test('(c) an Intent above autoApproveUnderUsd still requires confirmation', () async {
      var asked = 0, broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 25, // above the auto threshold
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(
        caps: {'sessionUsd': 1000},
        autoApproveUnderUsd: 10,
        confirm: (_) async {
          asked++;
          return true;
        },
      );
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        strategies: {'fixed': _FixedStrategy([_send('1')])},
      );
      final res = await sr.tick('fixed', {}, mode: 'auto');
      expect(asked, 1); // confirm was required above the threshold
      expect(broadcast, 1);
      expect(res.records.first['executed'], isNotNull);
    });

    test('an Intent under autoApproveUnderUsd commits without asking', () async {
      var asked = 0, broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 5, // under the auto threshold
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(
        caps: {'sessionUsd': 1000},
        autoApproveUnderUsd: 10,
        confirm: (_) async {
          asked++;
          return true;
        },
      );
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        strategies: {'fixed': _FixedStrategy([_send('1')])},
      );
      await sr.tick('fixed', {}, mode: 'auto');
      expect(asked, 0);
      expect(broadcast, 1);
    });
  });

  group('mainnet gate', () {
    test('a mainnet-venue Intent is refused when mainnetEnabled=false', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(caps: {'sessionUsd': 1000}, confirm: (_) async => true);
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        mainnetEnabled: false,
        strategies: {'fixed': _FixedStrategy([_send('1', mainnet: true)])},
      );
      final res = await sr.tick('fixed', {}, mode: 'auto');
      expect(broadcast, 0);
      expect(res.records.first['refused'], 'mainnet');
    });

    test('the same Intent dispatches once mainnetEnabled=true', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(caps: {'sessionUsd': 1000}, confirm: (_) async => true);
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        mainnetEnabled: true,
        strategies: {'fixed': _FixedStrategy([_send('1', mainnet: true)])},
      );
      await sr.tick('fixed', {}, mode: 'auto');
      expect(broadcast, 1);
    });
  });

  group('allowlist + pair grouping', () {
    test('an arbitrage pair drops BOTH legs when one leg tool is not allowlisted', () async {
      final venues = [
        {'id': 'blockle', 'chain': 'block', 'mainnet': false, 'ask': '1.00', 'bid': '0.99', 'feeBps': 10},
        {'id': 'evmdex', 'chain': 'base', 'mainnet': false, 'ask': '1.01', 'bid': '1.10', 'feeBps': 10},
      ];
      final sctx = StrategyContext(
        now: () => 0,
        listVenues: (_) async => venues,
        prices: (_) async => {'USDC': 1},
        policyRemaining: () => {'sessionUsd': null},
      );
      // The buy leg routes through the native rail -> buy_block; the sell leg -> swap.
      // Allowlist permits swap/sell_block but NOT buy_block: the pair must be dropped.
      final tools = buildTools(const AgentContext());
      final policy = Policy.create()..setAllowlist(['swap', 'sell_block']);
      final sr = StrategyRunner(tools: tools, policy: policy, ctx: sctx);
      final res = await sr.tick('arbitrage', {
        'pair': 'BLOCK/USDC',
        'minEdgeBps': 10,
        'maxNotionalUsd': 100,
        'gasBufferUsd': 0,
        'agentFeeBps': 5,
        'slippageBps': 0,
      }, mode: 'propose');
      expect(res.records.length, 2);
      expect(res.records.every((r) => r.containsKey('blocked')), isTrue);
      expect(res.records.any((r) => r.containsKey('proposed')), isFalse);
    });

    test('propose mode emits proposals and dispatches nothing', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000'},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(confirm: (_) async => true);
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        strategies: {'fixed': _FixedStrategy([_send('1')])},
      );
      final res = await sr.tick('fixed', {}); // default mode == propose
      expect(broadcast, 0);
      expect(res.records.first['proposed'], isNotNull);
    });
  });

  group('discovery wiring (§7) — read-only suggestions, never auto-traded', () {
    test('candidates() draws approved-only by DEFAULT', () async {
      final fake = _FakeDiscovery([
        const Candidate(symbol: 'APPROVED', source: 'watchlist', score: 0.9, approved: true),
        const Candidate(symbol: 'RAW', source: 'venuePairs', score: 0.8),
      ]);
      final sr = StrategyRunner(
        tools: buildTools(const AgentContext()),
        policy: Policy.create(),
        ctx: _noCtx(),
        discovery: fake,
      );
      final def = await sr.candidates();
      expect(def.map((c) => c.symbol).toList(), ['APPROVED'],
          reason: 'default is approved-only');
      final all = await sr.candidates(includeUnapproved: true);
      expect(all.map((c) => c.symbol).toSet(), {'APPROVED', 'RAW'});
    });

    test('autoConsiderUnapproved=true STILL yields a blocked audit note (never a trade) '
        'for an unapproved candidate', () async {
      final audit = Audit();
      final tools = buildTools(const AgentContext());
      // allowlist is explicitly EMPTY — nothing is dispatchable. A discovered,
      // unapproved token can only ever produce a `blocked` note, never a trade.
      final policy = Policy.create(confirm: (_) async => true)..setAllowlist([]);
      final fake = _FakeDiscovery([
        const Candidate(symbol: 'RAW', source: 'venuePairs', score: 0.8),
      ]);
      final sr = StrategyRunner(
        tools: tools,
        policy: policy,
        ctx: _noCtx(),
        audit: audit,
        discovery: fake,
        useDiscovery: true,
        autoConsiderUnapproved: true,
        strategies: {'fixed': _FixedStrategy([_swap('RAW')])},
      );

      // with autoConsiderUnapproved the candidate universe DOES include the
      // unapproved token...
      final cands = await sr.candidates();
      expect(cands.map((c) => c.symbol).toSet(), {'RAW'});

      // ...but dispatching a trade on it in AUTO mode is blocked by the allowlist
      // gate: it never reaches commit and lands a `blocked` audit note.
      final res = await sr.tick('fixed', {}, mode: 'auto');
      expect(res.records.length, 1);
      expect(res.records.first.containsKey('blocked'), isTrue);
      expect(res.records.any((r) => r.containsKey('executed')), isFalse);
      expect(audit.entries.any((e) => e['type'] == 'blocked'), isTrue,
          reason: 'recorded a blocked audit note');
    });
  });

  group('end-to-end swap: prepare -> cap -> confirm -> executeSwap -> sendFee -> recordSpend', () {
    test('commits the trade and fires the 0.05% fee leg to the right treasury', () async {
      Map<String, dynamic>? seenBuilt;
      Map<String, dynamic>? seenFeeXfer;

      final venues = VenueRegistry.create(
        treasury: {
          'agentTradeFeeBps': 5,
          'mainnet': {'block': 'block1treasury'},
        },
        blockle: {
          'ammReserves': (String from, String to) async =>
              {'reserveIn': '1000000000000', 'reserveOut': '1000000000000'},
        },
        evmdex: {'enabled': false},
        jupiter: {'enabled': false},
      );

      final ctx = AgentContext(
        estimateUsd: (asset, amount) async => BigInt.parse(amount) / BigInt.from(100000000),
        venues: venues,
        executeSwap: (built) async {
          seenBuilt = built;
          return {'txid': 'swaptx', 'accepted': true};
        },
        sendFee: (feeXfer) async {
          seenFeeXfer = feeXfer;
          return {'txid': 'feetx'};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(caps: {'sessionUsd': 1000}, confirm: (_) async => true);

      final outcome = await dispatchValueMoving(
        tools: tools,
        policy: policy,
        name: 'swap',
        args: {'from': 'BLOCK', 'to': 'USDC', 'amount': '100000000'},
      );

      // trade committed via executeSwap (the native exchange-swap intent), NOT a raw rebroadcast.
      expect(seenBuilt, isNotNull);
      expect((seenBuilt!['intent'] as Map)['kind'], 'exchange-swap');
      expect(outcome.txid, 'swaptx');

      // fee leg fired to the treasury for the trade's chain, exact 0.05% of input.
      expect(seenFeeXfer, isNotNull);
      expect(seenFeeXfer!['chain'], 'block');
      expect(seenFeeXfer!['to'], 'block1treasury');
      expect(seenFeeXfer!['amount'], '50000'); // 100000000 * 5 / 10000
      expect(outcome.agentFee!['treasury'], 'block1treasury');
      expect(outcome.agentFee!['txid'], 'feetx');

      // recordSpend accrued trade + fee against the per-asset ledger.
      expect(policy.spentByAsset['BLOCK'], BigInt.from(100050000)); // 100000000 + 50000
      expect(policy.spentUsd, closeTo(1.0005, 1e-9));
    });

    test('a declined confirmation aborts the swap before executeSwap', () async {
      var executed = 0;
      final venues = VenueRegistry.create(
        treasury: {'agentTradeFeeBps': 5, 'mainnet': {'block': 'block1treasury'}},
        blockle: {
          'ammReserves': (String from, String to) async =>
              {'reserveIn': '1000000000000', 'reserveOut': '1000000000000'},
        },
        evmdex: {'enabled': false},
        jupiter: {'enabled': false},
      );
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        venues: venues,
        executeSwap: (built) async {
          executed++;
          return {'txid': 'swaptx'};
        },
        sendFee: (feeXfer) async => {'txid': 'feetx'},
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(confirm: (_) async => false);
      final outcome = await dispatchValueMoving(
        tools: tools,
        policy: policy,
        name: 'swap',
        args: {'from': 'BLOCK', 'to': 'USDC', 'amount': '100000000'},
      );
      expect(outcome.declined, isTrue);
      expect(executed, 0);
      expect(policy.spentByAsset['BLOCK'], isNull);
    });
  });

  group('audit survives trimming', () {
    test('verify() is still ok after the log exceeds max and is trimmed', () async {
      final audit = Audit(max: 5);
      for (var i = 0; i < 20; i++) {
        await audit.record({'type': 'tool_call', 'name': 'send', 'i': i});
      }
      expect(audit.entries.length, 5);
      final v = await audit.verify();
      expect(v['ok'], isTrue);
      expect(audit.anchor == 'genesis', isFalse); // a real anchor was captured on trim

      // tampering within the retained window is still detected.
      audit.entries[1]['i'] = 999;
      final v2 = await audit.verify();
      expect(v2['ok'], isFalse);
    });
  });
}
