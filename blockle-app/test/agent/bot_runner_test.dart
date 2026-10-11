// The BotRunner routes bot orders through the SAME value-moving gate as the NL
// runner + StrategyRunner. The important tests (docs/BLOCKLE-BOTS.md §5-7): the
// FULLY-AUTO-WITHIN-ALLOCATION gate is non-bypassable — a live order that would
// exceed allocationUsd does NOT fire and is NEVER prompted (audited
// skipped:allocation); arming live without a finite allocation (<= the session
// cap) fails closed; kill stops ALL bots + locks the vault; PAPER never
// broadcasts; a mainnet bot is refused when mainnetEnabled=false; import lands
// paper + disabled.

import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/audit.dart';
import 'package:blockle_app/agent/bot_runner.dart';
import 'package:blockle_app/agent/bot_templates.dart';
import 'package:blockle_app/agent/discovery.dart' show Candidate;
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/strategies.dart' show Strategy, StrategyContext, StrategyIntent;
import 'package:blockle_app/agent/tools.dart';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class _ToolState {
  int commits = 0;
  final List<Map<String, dynamic>> committed = [];
}

class _FakeTools {
  final ToolRegistry registry;
  final _ToolState state;
  _FakeTools(this.registry, this.state);
}

_FakeTools fakeTools() {
  final state = _ToolState();
  const stable = {'USDC', 'USDT', 'DAI', 'USD'};
  Tool mk(String name) => Tool(
        name: name,
        description: name,
        valueMoving: true,
        parameters: const {'type': 'object', 'properties': {}},
        prepare: (a) async {
          final from = '${a['from'] ?? a['asset'] ?? 'X'}';
          final amt = a['amount'] != null ? num.parse('${a['amount']}') : 0;
          final usd = stable.contains(from.toUpperCase()) ? amt / 1e6 : amt / 1e8;
          return PreparedAction(
            summary: {'action': name, 'from': from, 'to': a['to'], 'amount': a['amount'], 'venue': a['venue']},
            value: SpendValue(asset: from, amount: a['amount'] ?? '0', usd: usd),
            commit: () async {
              state.commits++;
              state.committed.add({'name': name, 'args': a, 'usd': usd});
              return {
                'txid': 'tx${state.commits}',
                'accepted': true,
                if (name == 'place_order') 'orderId': 'ord${state.commits}',
              };
            },
          );
        },
      );
  final registry = ToolRegistry([mk('swap'), mk('place_order'), mk('cancel_order')]);
  return _FakeTools(registry, state);
}

BotContext mkCtx(List<num> priceSeq) {
  var i = 0;
  final marks = List<num>.from(priceSeq);
  return BotContext(
    now: () => 0,
    network: () => 'testnet',
    prices: (syms) async {
      final p = marks[math.min(i, marks.length - 1)];
      i++;
      return {'BLOCK': p, 'USDC': 1};
    },
  );
}

class _FakeDiscovery {
  final List<Candidate> cands;
  _FakeDiscovery(this.cands);
  Future<List<Candidate>> scan() async => cands;
}

class _Setup {
  final BotRunner runner;
  final Policy policy;
  final _ToolState tools;
  final Audit audit;
  _Setup(this.runner, this.policy, this.tools, this.audit);
}

const _noCap = Object();

_Setup setup({
  BotContext? ctx,
  Object? sessionUsd = _noCap,
  Future<bool> Function(Map<String, dynamic>)? confirm,
  Future<void> Function(String?)? onKill,
  bool mainnetEnabled = false,
  dynamic discovery,
}) {
  final audit = Audit();
  final num? cap = sessionUsd == _noCap ? 1000 : (sessionUsd as num?);
  final policy = Policy.create(
    caps: cap == null ? {} : {'sessionUsd': cap},
    confirm: confirm,
    audit: audit,
    onKill: onKill,
  );
  final ft = fakeTools();
  policy.setAllowlist(ft.registry.names());
  final runner = BotRunner(
    policy: policy,
    tools: ft.registry,
    audit: audit,
    ctx: ctx ?? mkCtx([100]),
    mainnetEnabled: mainnetEnabled,
    discovery: discovery,
  );
  return _Setup(runner, policy, ft.state, audit);
}

int skips(Audit audit, String reason) =>
    audit.list().where((e) => e['type'] == 'bot_skip' && e['reason'] == reason).length;

void main() {
  test('paper: a DCA bot fills simulated at the quote and NEVER broadcasts', () async {
    final su = setup(ctx: mkCtx([100, 90, 97]));
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 100, 'safetyOrderUsd': 100, 'maxSafetyOrders': 1, 'safetyStepPct': 2, 'takeProfitPct': 2},
    });
    bot.mode = 'paper';
    bot.enabled = true;

    await su.runner.tickBot(bot.id);
    await su.runner.tickBot(bot.id);
    await su.runner.tickBot(bot.id);

    expect(su.tools.commits, 0, reason: 'PAPER must never broadcast');
    expect(su.audit.list().any((e) => e['type'] == 'bot_paper_fill'), isTrue);
    final d = su.runner.dashboard(bot.id, {'BLOCK': 94.2})!;
    expect(d['mode'], 'paper');
    expect((d['totalDeals'] as int) >= 1, isTrue);
  });

  test('live within allocation: auto-approves via policy.autoApproveUnderUsd (no confirm asked) and commits', () async {
    var asked = 0;
    final su = setup(ctx: mkCtx([100]), sessionUsd: 1000, confirm: (_) async {
      asked++;
      return true;
    });
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 20, 'maxSafetyOrders': 0, 'takeProfitPct': 5},
    });
    await su.runner.armLive(bot.id, allocationUsd: 50);

    await su.runner.tickBot(bot.id);
    expect(asked, 0, reason: 'within allocation auto-approves — confirm is NOT asked');
    expect(su.tools.commits, 1);
    final d = su.runner.dashboard(bot.id, {'BLOCK': 100})!;
    expect((d['committedUsd'] as double).round(), 20);
    expect((d['remainingUsd'] as double).round(), 30);
  });

  test('allocation gate: a live order exceeding remaining allocation is refused (never prompted, audited skipped:allocation)', () async {
    var asked = 0;
    final su = setup(ctx: mkCtx([100, 90]), sessionUsd: 1000, confirm: (_) async {
      asked++;
      return true;
    });
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 8, 'safetyOrderUsd': 5, 'maxSafetyOrders': 3, 'safetyStepPct': 2, 'takeProfitPct': 50},
    });
    await su.runner.armLive(bot.id, allocationUsd: 10);

    await su.runner.tickBot(bot.id);
    await su.runner.tickBot(bot.id);

    expect(su.tools.commits, 1, reason: 'only the base order fired');
    expect(asked, 0, reason: 'the refused order was NEVER prompted');
    expect(skips(su.audit, 'allocation'), 1);
    final d = su.runner.dashboard(bot.id, {'BLOCK': 90})!;
    expect((d['committedUsd'] as double).round(), 8);
  });

  test('allocation gate: the backstop holds even if a confirm handler would say yes', () async {
    final su = setup(ctx: mkCtx([100, 90]), sessionUsd: 1000, confirm: (_) async => true);
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 8, 'safetyOrderUsd': 5, 'maxSafetyOrders': 3, 'safetyStepPct': 2, 'takeProfitPct': 50},
    });
    await su.runner.armLive(bot.id, allocationUsd: 10);
    await su.runner.tickBot(bot.id);
    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 1);
    expect(skips(su.audit, 'allocation'), 1);
  });

  test('arm live: fails closed when allocationUsd <= 0', () async {
    final su = setup(sessionUsd: 1000);
    final bot = su.runner.add({'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}});
    await expectLater(su.runner.armLive(bot.id, allocationUsd: 0),
        throwsA(predicate((e) => '$e'.contains('allocationUsd must be > 0'))));
    expect(bot.mode, 'paper');
    expect(bot.enabled, false);
  });

  test('arm live: fails closed when there is no policy session USD cap', () async {
    final su = setup(sessionUsd: null);
    final bot = su.runner.add({'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}});
    await expectLater(su.runner.armLive(bot.id, allocationUsd: 50),
        throwsA(predicate((e) => '$e'.contains('session USD cap is required'))));
  });

  test('arm live: fails closed when allocationUsd exceeds the session cap', () async {
    final su = setup(sessionUsd: 50);
    final bot = su.runner.add({'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}});
    await expectLater(su.runner.armLive(bot.id, allocationUsd: 100),
        throwsA(predicate((e) => '$e'.contains('exceeds the policy session cap'))));
  });

  test('arm live: fails closed on a mainnet bot when mainnetEnabled=false', () async {
    final su = setup(sessionUsd: 1000, mainnetEnabled: false);
    final bot = su.runner.add({'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'network': 'mainnet'});
    await expectLater(su.runner.armLive(bot.id, allocationUsd: 50),
        throwsA(predicate((e) => '$e'.contains('mainnet'))));
  });

  test('mainnet gate: a live mainnet bot order does not fire when mainnetEnabled=false', () async {
    final su = setup(ctx: mkCtx([100]), sessionUsd: 1000, mainnetEnabled: false, confirm: (_) async => true);
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 20, 'maxSafetyOrders': 0},
    });
    bot.mode = 'live';
    bot.enabled = true;
    bot.network = 'mainnet';
    bot.allocationUsd = 50;
    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 0, reason: 'nothing broadcast on mainnet with the gate off');
    expect(skips(su.audit, 'mainnet'), 1);
  });

  test('kill: stops all bots, blocks further commits, and locks the vault via policy.kill', () async {
    var vaultLocked = false;
    final su = setup(ctx: mkCtx([100]), sessionUsd: 1000, confirm: (_) async => true, onKill: (_) async {
      vaultLocked = true;
    });
    final a = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {'baseOrderUsd': 20, 'maxSafetyOrders': 0},
    });
    final b = su.runner.add({
      'type': 'grid', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40},
    });
    await su.runner.armLive(a.id, allocationUsd: 50);
    await su.runner.enablePaper(b.id);

    await su.runner.killAll('panic');

    expect(su.policy.isKilled(), true);
    expect(vaultLocked, true);
    expect(a.enabled, false);
    expect(b.enabled, false);
    final before = su.tools.commits;
    final r = await su.runner.tickBot(a.id);
    expect(su.tools.commits, before);
    expect(r['killed'] == true || r['skipped'] != null, isTrue);
  });

  test('import: a template added to the runner lands paper + disabled + zero allocation', () async {
    final su = setup(sessionUsd: 1000);
    final tpl = {
      'kind': 'blockle-bot-template', 'type': 'dca', 'name': 'x', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 20}, 'mode': 'live', 'enabled': true, 'allocationUsd': 999,
    };
    final bot = importTemplate(tpl);
    su.runner.add(bot);
    expect(bot.mode, 'paper');
    expect(bot.enabled, false);
    expect(bot.allocationUsd, 0);
    await su.runner.tickAll();
    expect(su.tools.commits, 0);
  });

  test('signal bot: an approved discovery candidate spawns a paper DCA deal (no broadcast)', () async {
    final discovery = _FakeDiscovery([
      const Candidate(symbol: 'BLOCK', source: 'test', score: 0.9, approved: true, pair: 'BLOCK/USDC'),
      const Candidate(symbol: 'SCAM', source: 'test', score: 0.9, approved: false, pair: 'SCAM/USDC'),
    ]);
    final su = setup(ctx: mkCtx([100, 100, 100]), sessionUsd: 1000, discovery: discovery);
    final bot = su.runner.add({
      'type': 'signal',
      'config': {'source': 'discovery', 'maxConcurrent': 2, 'onSignal': {'type': 'dca', 'config': {'baseOrderUsd': 10, 'maxSafetyOrders': 0}}},
    });
    bot.mode = 'paper';
    bot.enabled = true;
    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 0, reason: 'paper signal bot never broadcasts');
    expect(su.audit.list().any((e) => e['type'] == 'bot_signal' && e['pair'] == 'BLOCK/USDC'), isTrue);
    expect(su.audit.list().any((e) => e['type'] == 'bot_signal' && e['pair'] == 'SCAM/USDC'), isFalse);
  });

  test('no synthetic prices: a bot with no mark skips the tick, audited', () async {
    final ctx = BotContext(now: () => 0, network: () => 'testnet', prices: (_) async => <String, num>{});
    final su = setup(ctx: ctx, sessionUsd: 1000);
    final bot = su.runner.add({'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {'baseOrderUsd': 20}});
    bot.mode = 'paper';
    bot.enabled = true;
    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 0);
    expect(skips(su.audit, 'price') >= 1, isTrue);
  });

  // =========================================================================
  // FIX-GRID: grid bots fill end-to-end (paper) — a buy level now simulates a
  // fill instead of throwing (it used to read order.usdSizeUc, which a grid buy
  // lacks, and was swallowed as bot_error).
  // =========================================================================
  test('grid (paper): a buy level fills simulated at the level and NEVER broadcasts (FIX-GRID)', () async {
    final su = setup(ctx: mkCtx([1.00, 0.95])); // seed at mid 1.00, then dip to 0.95
    final bot = su.runner.add({
      'type': 'grid', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40},
    });
    bot.mode = 'paper';
    bot.enabled = true;

    await su.runner.tickBot(bot.id); // seeds the ladder (mid 1.00, no fill)
    await su.runner.tickBot(bot.id); // dip to 0.95 -> a grid BUY fills (used to throw -> bot_error)

    expect(su.tools.commits, 0, reason: 'PAPER grid never broadcasts');
    expect(su.audit.list().any((e) => e['type'] == 'bot_error'), isFalse,
        reason: 'a grid buy no longer throws + is swallowed as bot_error');
    expect(
        su.audit.list().any((e) => e['type'] == 'bot_paper_fill' && e['side'] == 'buy' && e['kind'] == 'grid'),
        isTrue,
        reason: 'a grid buy simulated a fill');
    final ps = (bot.state['byPair'] as Map)['BLOCK/USDC'] as Map;
    final levels = (ps['deal'] as Map)['levels'] as List;
    expect(levels.any((l) => (l as Map)['heldQty'] as BigInt > BigInt.zero), isTrue,
        reason: 'inventory is held on the armed sell one grid up');
  });

  // =========================================================================
  // FIX-GRID + allocation: a LIVE grid routes through the ONE dispatch and can
  // never spend past allocationUsd (the same hard cap DCA respects).
  // =========================================================================
  test('grid (live): routes through the ONE dispatch and cannot exceed allocationUsd (FIX-GRID)', () async {
    final su = setup(ctx: mkCtx([1.00, 0.80]), sessionUsd: 1000, confirm: (_) async => true);
    final bot = su.runner.add({
      'type': 'grid', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'lowerPrice': 0.80, 'upperPrice': 1.20, 'gridCount': 10, 'totalUsd': 100},
    });
    await su.runner.armLive(bot.id, allocationUsd: 25); // only ~2 x $10 levels fit

    await su.runner.tickBot(bot.id); // seed ladder (mid 1.00)
    await su.runner.tickBot(bot.id); // crash: fill until allocation is exhausted, then refuse

    expect(su.tools.commits >= 1, isTrue, reason: 'a live grid buy broadcast through place_order');
    expect(su.tools.committed.every((c) => c['name'] == 'place_order'), isTrue,
        reason: 'every grid order went through the ONE value-moving dispatch (place_order)');
    final d = su.runner.dashboard(bot.id, {'BLOCK': 0.80})!;
    expect((d['committedUsd'] as double) <= 25 + 1e-9, isTrue,
        reason: 'cumulative live spend never exceeds allocationUsd, got ${d['committedUsd']}');
    expect(skips(su.audit, 'allocation') >= 1, isTrue,
        reason: 'an over-allocation level was refused (audited skipped:allocation)');
  });

  // =========================================================================
  // FIX-ALLOC-FEE: the committed-spend ledger bounds the TRUE outflow = trade +
  // the mandatory 0.05% agent fee (checked before firing, accrued after broadcast).
  // =========================================================================
  test('allocation ledger accrues trade + the 0.05% agent fee, not the trade alone (FIX-ALLOC-FEE)', () async {
    final su = setup(ctx: mkCtx([100]), sessionUsd: 1000);
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 200, 'maxSafetyOrders': 0, 'takeProfitPct': 50},
    });
    await su.runner.armLive(bot.id, allocationUsd: 300);

    await su.runner.tickBot(bot.id); // base $200 + 0.05% fee ($0.10) -> committed $200.10
    expect(su.tools.commits, 1);
    final d = su.runner.dashboard(bot.id, {'BLOCK': 100})!;
    expect(((d['committedUsd'] as double) - 200.10).abs() < 1e-6, isTrue,
        reason: 'committed = trade + fee (\$200.10), got ${d['committedUsd']}');
    expect(((d['remainingUsd'] as double) - 99.90).abs() < 1e-6, isTrue,
        reason: 'remaining reflects trade + fee, got ${d['remainingUsd']}');
  });

  // =========================================================================
  // FIX-CANCEL: a LIVE fill records its exchange orderId onto the level, and
  // KILL cancels it through the ONE audited dispatch (never a bare
  // prepare().commit()).
  // =========================================================================
  test('kill: a live grid fill records an orderId and kill cancels it through the ONE gate (FIX-CANCEL)', () async {
    final su = setup(ctx: mkCtx([1.00, 0.95]), sessionUsd: 1000, confirm: (_) async => true, onKill: (_) async {});
    final bot = su.runner.add({
      'type': 'grid', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40},
    });
    await su.runner.armLive(bot.id, allocationUsd: 50);

    await su.runner.tickBot(bot.id); // seed ladder
    await su.runner.tickBot(bot.id); // a buy level fills LIVE via place_order -> orderId recorded

    final ps = (bot.state['byPair'] as Map)['BLOCK/USDC'] as Map;
    final levels = (ps['deal'] as Map)['levels'] as List;
    final withId = levels.where((l) => (l as Map)['orderId'] != null).toList();
    expect(withId.isNotEmpty, isTrue,
        reason: 'the live fill STORED its exchange orderId onto the level (was never written before)');
    final orderId = (withId.first as Map)['orderId'];

    final commitsBefore = su.tools.commits;
    await su.runner.killAll('panic');

    expect(su.audit.list().any((e) => e['type'] == 'bot_dispatch' && e['tool'] == 'cancel_order'), isTrue,
        reason: 'the cancel routed through the ONE audited dispatch (not a bare prepare().commit())');
    expect(su.tools.committed.any((c) => c['name'] == 'cancel_order' && (c['args'] as Map)['orderId'] == orderId), isTrue,
        reason: 'kill cancelled exactly the recorded orderId');
    expect(su.tools.commits > commitsBefore, isTrue,
        reason: 'the cancel went through the one shared commit path');
  });

  // =========================================================================
  // FIX-EST: a LIVE scheduled-strategy order with NO usd estimate must FAIL
  // CLOSED (a null estUsd must NOT be treated as $0, which would pass the cap
  // check and accrue nothing).
  // =========================================================================
  test('scheduled (live): a null USD estimate fails closed (skipped:allocation-unknown); a finite one accrues trade+fee (FIX-EST)', () async {
    final audit = Audit();
    final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
    final ft = fakeTools();
    policy.setAllowlist(ft.registry.names());
    final runner = BotRunner(
      policy: policy,
      tools: ft.registry,
      audit: audit,
      ctx: BotContext(
        now: () => 0,
        network: () => 'testnet',
        prices: (_) async => {'BLOCK': 100, 'USDC': 1},
        strategyCtx: StrategyContext(now: () => 0, network: () => 'testnet'),
      ),
      strategies: {'momentum': _FakeMomentum()},
    );
    final bot = runner.add({'type': 'momentum', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {}});
    await runner.armLive(bot.id, allocationUsd: 100);

    final rep = await runner.tickBot(bot.id);
    final ev = (rep['events'] as List).cast<Map<String, dynamic>>();
    expect(ev.any((e) => e['tag'] == 'no-est' && e['skipped'] == 'allocation-unknown'), isTrue,
        reason: 'the null-estimate order failed closed (not treated as \$0)');
    expect(ev.any((e) => e['tag'] == 'has-est' && e['executed'] == true), isTrue,
        reason: 'the finite-estimate order executed');
    expect(audit.list().where((e) => e['type'] == 'bot_skip' && e['reason'] == 'allocation-unknown').length, 1,
        reason: 'audited skipped:allocation-unknown');
    expect(ft.state.commits, 1, reason: 'only the finite-estimate order broadcast');
    final d = runner.dashboard(bot.id, {'BLOCK': 100})!;
    expect(((d['committedUsd'] as double) - 10.005).abs() < 1e-6, isTrue,
        reason: 'only the finite order accrued (trade \$10 + fee \$0.005), got ${d['committedUsd']}');
  });
}

/// A fake momentum strategy for the FIX-EST test: one intent with a null USD
/// estimate (must fail closed) and one with a finite $10 estimate (must execute).
class _FakeMomentum implements Strategy {
  @override
  String get name => 'momentum';
  @override
  String describe() => 'fake momentum';
  @override
  Map<String, dynamic> get defaults => const {};
  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) => params ?? const {};
  @override
  Future<List<StrategyIntent>> plan(StrategyContext ctx, Map<String, dynamic> params) async => [
        const StrategyIntent(
          tool: 'swap', args: {'from': 'USDC', 'to': 'BLOCK', 'amount': '1'},
          rationale: 'no estimate', strategy: 'momentum', tag: 'no-est', estUsd: null, mainnet: false,
        ),
        const StrategyIntent(
          tool: 'swap', args: {'from': 'USDC', 'to': 'BLOCK', 'amount': '2'},
          rationale: 'has estimate', strategy: 'momentum', tag: 'has-est', estUsd: 10, mainnet: false,
        ),
      ];
}
