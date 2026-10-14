// The BotRunner routes bot orders through the SAME value-moving gate as the NL
// runner + StrategyRunner. The important tests (docs/BLOCKLE-BOTS.md §5-7): the
// FULLY-AUTO-WITHIN-ALLOCATION gate is non-bypassable — a live order that would
// exceed allocationUsd does NOT fire and is NEVER prompted (audited
// skipped:allocation); arming live without a finite allocation (<= the session
// cap) fails closed; kill stops ALL bots + locks the vault; PAPER never
// broadcasts; a mainnet bot is refused when mainnetEnabled=false; import lands
// paper + disabled.

import 'dart:async';
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

// A no-op Timer so the scheduler never spins a REAL periodic timer in tests
// (that would leave a pending timer and fail the test). The probe captures the
// scheduler's onTick so a test can fire a tick deterministically.
class _FakeTimer implements Timer {
  bool _active = true;
  @override
  void cancel() => _active = false;
  @override
  bool get isActive => _active;
  @override
  int get tick => 0;
}

class _SchedulerProbe {
  Duration? interval;
  void Function()? onTick;
  int built = 0;
  _FakeTimer? timer;
  Timer make(Duration d, void Function() cb) {
    interval = d;
    onTick = cb;
    built++;
    return timer = _FakeTimer();
  }
}

class _Setup {
  final BotRunner runner;
  final Policy policy;
  final _ToolState tools;
  final Audit audit;
  final _SchedulerProbe probe;
  _Setup(this.runner, this.policy, this.tools, this.audit, this.probe);
}

const _noCap = Object();

_Setup setup({
  BotContext? ctx,
  Object? sessionUsd = _noCap,
  Future<bool> Function(Map<String, dynamic>)? confirm,
  Future<void> Function(String?)? onKill,
  bool mainnetEnabled = false,
  dynamic discovery,
  _SchedulerProbe? probe,
}) {
  final sched = probe ?? _SchedulerProbe();
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
    timerFactory: sched.make,
  );
  return _Setup(runner, policy, ft.state, audit, sched);
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

  test('dashboard: an OPEN position with no mark reports unrealizedUsd=null (awaiting data), not a misleading 0', () async {
    final su = setup(ctx: mkCtx([100]));
    final bot = su.runner.add({
      'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
      'config': {'baseOrderUsd': 100, 'maxSafetyOrders': 0, 'takeProfitPct': 50},
    });
    bot.mode = 'paper';
    bot.enabled = true;

    await su.runner.tickBot(bot.id); // base order fills -> open position held

    // No mark available for BLOCK -> unrealized is unknown, surfaced as null so
    // the UI shows "awaiting market data" rather than $0.00.
    final noMark = su.runner.dashboard(bot.id)!;
    expect(noMark['unrealizedUsd'], isNull);

    // A real mark -> a concrete (numeric) unrealized figure.
    final marked = su.runner.dashboard(bot.id, {'BLOCK': 100})!;
    expect(marked['unrealizedUsd'], isA<num>());
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

  // ===========================================================================
  // FIX-KILL: scheduler ticks enabled bots; per-bot STOP + REMOVE; kill-all.
  // ===========================================================================
  group('scheduler + stop/remove/kill (FIX-KILL)', () {
    test('enabling a bot starts the background scheduler on its pollSec', () async {
      final su = setup();
      expect(su.runner.schedulerRunning, isFalse, reason: 'idle: no scheduler');
      final bot = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
        'config': {'baseOrderUsd': 10, 'maxSafetyOrders': 0, 'takeProfitPct': 5},
        'pollSec': 5,
      });
      await su.runner.enablePaper(bot.id);
      expect(su.runner.schedulerRunning, isTrue, reason: 'enabling a bot arms the scheduler');
      expect(su.probe.interval, const Duration(seconds: 5), reason: 'ticks on the bot pollSec');
    });

    test('the scheduler actually TICKS enabled bots (a paper fill is recorded)', () async {
      final su = setup(ctx: mkCtx([100]));
      final bot = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
        'config': {'baseOrderUsd': 10, 'maxSafetyOrders': 0, 'takeProfitPct': 50},
      });
      await su.runner.enablePaper(bot.id);
      expect(su.audit.list().any((e) => e['type'] == 'bot_paper_fill'), isFalse);
      // Fire the captured scheduler callback once — the SAME path the real timer
      // drives — and let the async tick settle.
      su.probe.onTick!();
      await pumpEventQueue();
      expect(su.audit.list().any((e) => e['type'] == 'bot_paper_fill'), isTrue,
          reason: 'the scheduled tick advanced the enabled bot');
    });

    test('per-bot STOP halts it: enabled=false, scheduler skips it, status stopped', () async {
      final su = setup(ctx: mkCtx([100]));
      final bot = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']},
        'config': {'baseOrderUsd': 10, 'maxSafetyOrders': 0, 'takeProfitPct': 50},
      });
      await su.runner.enablePaper(bot.id);
      expect(su.runner.schedulerRunning, isTrue);

      await su.runner.pause(bot.id);
      expect(bot.enabled, isFalse, reason: 'stop disables the bot');
      expect(su.runner.schedulerRunning, isFalse, reason: 'no enabled bots -> scheduler stops');
      expect(su.runner.dashboard(bot.id)!['status'], 'paused');

      // A fired tick (or a direct tickAll) must NOT advance a stopped bot.
      final before = su.audit.list().length;
      await su.runner.tickAll();
      expect(su.audit.list().where((e) => e['type'] == 'bot_paper_fill').isEmpty, isTrue);
      expect(su.audit.list().length, before, reason: 'a stopped bot is skipped entirely');
    });

    test('per-bot REMOVE deletes it from the store (and stops an idle scheduler)', () async {
      final su = setup();
      final a = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {'baseOrderUsd': 10},
      });
      final c = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {'baseOrderUsd': 10},
      });
      await su.runner.enablePaper(a.id);
      expect(su.runner.list().length, 2);

      final removed = await su.runner.remove(c.id);
      expect(removed, isTrue);
      expect(su.runner.get(c.id), isNull, reason: 'deleted from the store');
      expect(su.runner.list().length, 1);
      expect(su.runner.schedulerRunning, isTrue, reason: 'bot a is still enabled');

      await su.runner.remove(a.id);
      expect(su.runner.get(a.id), isNull);
      expect(su.runner.schedulerRunning, isFalse, reason: 'last enabled bot gone -> scheduler stops');
      expect(await su.runner.remove('nope'), isFalse);
    });

    test('kill-all stops the scheduler, disables every bot, and blocks further ticks', () async {
      var vaultLocked = false;
      final su = setup(ctx: mkCtx([100]), sessionUsd: 1000, confirm: (_) async => true, onKill: (_) async {
        vaultLocked = true;
      });
      final a = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {'baseOrderUsd': 20, 'maxSafetyOrders': 0},
      });
      final c = su.runner.add({
        'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'config': {'baseOrderUsd': 5, 'maxSafetyOrders': 0},
      });
      await su.runner.armLive(a.id, allocationUsd: 50);
      await su.runner.enablePaper(c.id);
      expect(su.runner.schedulerRunning, isTrue);

      await su.runner.killAll('panic');

      expect(su.runner.schedulerRunning, isFalse, reason: 'kill stops the scheduler');
      expect(vaultLocked, isTrue);
      expect(a.enabled, isFalse);
      expect(c.enabled, isFalse);
      for (final r in su.runner.list()) {
        expect(su.runner.dashboard(r.id)!['status'], 'killed');
      }
      // Firing a leftover tick after kill must advance nothing.
      final before = su.tools.commits;
      await su.runner.tickAll();
      expect(su.tools.commits, before);
    });
  });

  // =========================================================================
  // UNIFORM SETTLEMENT STEP (docs/BLOCKLE-BOTS.md §6): whenever a realized
  // SELL/exit — ANY lane (arb, momentum/take-profit, grid sell) — realizes into
  // a currency != the bot profitCurrency, the deal-engine exit path emits ONE
  // additional settlement swap into the profit currency through the SAME value-
  // moving gate. No route -> keep the native quote AND label realized.currency
  // with the ACTUAL output (the label never lies). Redundant hop skipped when the
  // output already == profitCurrency. Paper records but never broadcasts.
  // =========================================================================
  group('uniform settlement step (profit currency honored in every lane)', () {
    BotContext gridCtx(List<num> blockSeq) {
      var i = 0;
      final seq = List<num>.from(blockSeq);
      return BotContext(
        now: () => 0,
        network: () => 'testnet',
        prices: (syms) async {
          final out = <String, num>{'USDT': 1, 'USDC': 1};
          if (syms.map((s) => '$s'.toUpperCase()).contains('BLOCK')) {
            out['BLOCK'] = seq[math.min(i, seq.length - 1)];
            i++;
          }
          return out;
        },
      );
    }

    test('MOMENTUM take-profit: a sell realizing into the native quote emits a committed settlement swap whose output IS the profit currency', () async {
      final audit = Audit();
      final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit, confirm: (_) async => true);
      final ft = fakeTools();
      policy.setAllowlist(ft.registry.names());
      final runner = BotRunner(
        policy: policy,
        tools: ft.registry,
        audit: audit,
        ctx: BotContext(
          now: () => 0,
          network: () => 'testnet',
          prices: (_) async => {'BLOCK': 100, 'USDT': 1, 'USDC': 1},
          strategyCtx: StrategyContext(now: () => 0, network: () => 'testnet'),
        ),
        strategies: {'momentum': _FakeMomentumSell()},
      );
      final bot = runner.add({
        'type': 'momentum', 'universe': {'pairs': ['BLOCK/USDT']},
        'config': {'profitCurrency': 'USDC'},
      });
      await runner.armLive(bot.id, allocationUsd: 100);

      final rep = await runner.tickBot(bot.id);

      final settle = ft.state.committed
          .where((c) => c['name'] == 'swap' && (c['args'] as Map)['from'] == 'USDT' && (c['args'] as Map)['to'] == 'USDC')
          .toList();
      expect(settle.length, 1, reason: 'the USDT proceeds were settled INTO USDC by ONE committed swap');
      final ev = (rep['events'] as List).cast<Map<String, dynamic>>();
      expect(ev.any((e) => e['settlement'] == true && e['to'] == 'USDC'), isTrue,
          reason: 'the tick reports the final settled currency = profit currency');
      expect(audit.list().any((e) => e['type'] == 'bot_settle' && e['to'] == 'USDC'), isTrue);
    });

    test('GRID sell: a sell realizing into the native quote emits a committed settlement swap whose output IS the profit currency', () async {
      final audit = Audit();
      final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit, confirm: (_) async => true);
      final ft = fakeTools();
      policy.setAllowlist(ft.registry.names());
      final runner = BotRunner(policy: policy, tools: ft.registry, audit: audit, ctx: gridCtx([1.00, 0.95, 1.05]));
      final bot = runner.add({
        'type': 'grid', 'universe': {'pairs': ['BLOCK/USDT']},
        'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40, 'profitCurrency': 'USDC'},
      });
      await runner.armLive(bot.id, allocationUsd: 50);

      await runner.tickBot(bot.id); // seed ladder (mid 1.00)
      await runner.tickBot(bot.id); // dip to 0.95 -> a grid BUY (place_order) fills, holds inventory
      await runner.tickBot(bot.id); // rise to 1.05 -> a grid SELL (place_order) realizes USDT, then settles

      final settle = ft.state.committed
          .where((c) => c['name'] == 'swap' && (c['args'] as Map)['from'] == 'USDT' && (c['args'] as Map)['to'] == 'USDC')
          .toList();
      expect(settle.length, 1, reason: 'the grid sell proceeds (USDT) were settled INTO USDC by ONE swap');
      expect(ft.state.committed.any((c) => c['name'] == 'place_order'), isTrue,
          reason: 'the grid buy/sell themselves went through the limit-order path');
      final ps = (bot.state['byPair'] as Map)['BLOCK/USDT'] as Map;
      expect(ps['realizedCurrency'], 'USDC', reason: 'realized currency reports the FINAL settled currency');
    });

    test('redundant hop skipped: when a grid sell already realizes the profit currency, NO extra settlement swap fires', () async {
      final audit = Audit();
      final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit, confirm: (_) async => true);
      final ft = fakeTools();
      policy.setAllowlist(ft.registry.names());
      final runner = BotRunner(policy: policy, tools: ft.registry, audit: audit, ctx: gridCtx([1.00, 0.95, 1.05]));
      final bot = runner.add({
        'type': 'grid', 'universe': {'pairs': ['BLOCK/USDC']},
        'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40, 'profitCurrency': 'USDC'},
      });
      await runner.armLive(bot.id, allocationUsd: 50);

      await runner.tickBot(bot.id);
      await runner.tickBot(bot.id);
      await runner.tickBot(bot.id);

      expect(ft.state.committed.any((c) => c['name'] == 'swap'), isFalse,
          reason: 'proceeds already == profit currency (USDC) -> the redundant settlement hop is skipped');
      final ps = (bot.state['byPair'] as Map)['BLOCK/USDC'] as Map;
      expect(ps['realizedCurrency'], 'USDC');
    });

    test('NO route: a grid sell with no path to the profit currency keeps proceeds native and labels realized.currency honestly (never a false label)', () async {
      final audit = Audit();
      final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit, confirm: (_) async => true);
      final ft = fakeTools();
      policy.setAllowlist(ft.registry.names());
      final runner = BotRunner(policy: policy, tools: ft.registry, audit: audit, ctx: gridCtx([1.00, 0.95, 1.05]));
      final bot = runner.add({
        'type': 'grid', 'universe': {'pairs': ['BLOCK/USDT']},
        // ZZZ has no price and is not a stablecoin -> no route; the proceeds must
        // NOT be relabeled as the profit currency it never reached.
        'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40, 'profitCurrency': 'ZZZ'},
      });
      await runner.armLive(bot.id, allocationUsd: 50);

      await runner.tickBot(bot.id);
      await runner.tickBot(bot.id);
      await runner.tickBot(bot.id);

      expect(ft.state.committed.any((c) => c['name'] == 'swap'), isFalse,
          reason: 'no route -> no fabricated settlement swap');
      final ps = (bot.state['byPair'] as Map)['BLOCK/USDT'] as Map;
      expect(ps['realizedCurrency'], 'USDT',
          reason: 'the label reports the ACTUAL output (USDT), never the unreachable profit currency');
      expect(audit.list().any((e) => e['type'] == 'bot_settle_skip' && e['reason'] == 'no-route'), isTrue);
    });

    test('PAPER: the settlement step is recorded but NEVER broadcast', () async {
      final audit = Audit();
      final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
      final ft = fakeTools();
      policy.setAllowlist(ft.registry.names());
      final runner = BotRunner(policy: policy, tools: ft.registry, audit: audit, ctx: gridCtx([1.00, 0.95, 1.05]));
      final bot = runner.add({
        'type': 'grid', 'universe': {'pairs': ['BLOCK/USDT']},
        'config': {'lowerPrice': 0.9, 'upperPrice': 1.1, 'gridCount': 4, 'totalUsd': 40, 'profitCurrency': 'USDC'},
      });
      bot.mode = 'paper';
      bot.enabled = true;

      await runner.tickBot(bot.id);
      await runner.tickBot(bot.id);
      await runner.tickBot(bot.id);

      expect(ft.state.commits, 0, reason: 'PAPER never broadcasts — including the settlement step');
      expect(audit.list().any((e) => e['type'] == 'bot_settle' && e['mode'] == 'paper'), isTrue,
          reason: 'the settlement is paper-recorded (not broadcast)');
      final ps = (bot.state['byPair'] as Map)['BLOCK/USDT'] as Map;
      expect(ps['realizedCurrency'], 'USDC', reason: 'paper still reports the settled currency');
    });
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

/// A fake momentum strategy that emits a single death-cross SELL (the realize/exit
/// leg) of held BLOCK into the pair-native quote (USDT). The uniform settlement
/// step must then convert the USDT proceeds into the bot profit currency (USDC).
class _FakeMomentumSell implements Strategy {
  @override
  String get name => 'momentum';
  @override
  String describe() => 'fake momentum sell';
  @override
  Map<String, dynamic> get defaults => const {};
  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) => params ?? const {};
  @override
  Future<List<StrategyIntent>> plan(StrategyContext ctx, Map<String, dynamic> params) async => [
        const StrategyIntent(
          tool: 'swap', args: {'from': 'BLOCK', 'to': 'USDT', 'amount': '2000000000'},
          rationale: 'death cross — sell held BLOCK', strategy: 'momentum',
          tag: 'mom:BLOCK/USDT:sell', estUsd: 20, mainnet: false,
        ),
      ];
}
