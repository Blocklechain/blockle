// DIAGNOSTIC repro: mirror the PRODUCTION controller wiring and confirm a PAPER
// DCA bot and a PAPER scanner ("AI picks") bot each actually emit a fill on a
// single tick. If these pass, the engine is fine and the device problem is the
// scheduler/enable/UI; if they fail, the bug is here.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/audit.dart';
import 'package:blockle_app/agent/bot_runner.dart';
import 'package:blockle_app/agent/bot_templates.dart' as tpl;
import 'package:blockle_app/agent/notify.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/tools.dart';

Tool _mk(String name, List<Map<String, dynamic>> log) => Tool(
      name: name,
      description: name,
      valueMoving: true,
      parameters: const {'type': 'object', 'properties': {}},
      prepare: (a) async => PreparedAction(
        summary: {'action': name, ...a},
        value: SpendValue(asset: '${a['from'] ?? 'X'}', amount: '${a['amount'] ?? 0}', usd: 1),
        commit: () async {
          log.add({'name': name, 'args': a});
          return {'txid': 'tx${log.length}', 'accepted': true};
        },
      ),
    );

// Discovery fake shaped EXACTLY like SignalsDiscovery output (live DESSA row).
class _Disco {
  Future<List<Map<String, dynamic>>> scan([Map<String, dynamic>? opts]) async => [
        {
          'pair': 'DESSA/USDC', 'token': 'npz2...pump', 'chain': 'solana', 'symbol': 'DESSA',
          'lane': null, 'approved': true, 'score': 0.81, 'hype': 51,
          'liquidityUsd': 479985.4, 'volume24hUsd': 498671.96, 'marketCapUsd': 25550469,
          'ageSec': 1133896, 'topHolderPct': 0.91, 'honeypot': false,
          'liquidityLocked': null, 'mintAuthorityRenounced': true, 'flags': ['too-new'],
          'priceUsd': 0.02609, 'priceChange1hPct': 7.55, 'priceChange24hPct': 9.89,
          'prices': {'USDC': 1, 'DESSA': 0.02609},
        },
      ];
}

void main() {
  test('PAPER DCA bot emits a fill on one tick (SOL/USDC)', () async {
    final log = <Map<String, dynamic>>[];
    final audit = Audit();
    final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
    final reg = ToolRegistry([_mk('swap', log), _mk('place_order', log)]);
    policy.setAllowlist(reg.names());
    final runner = BotRunner(
      policy: policy, tools: reg, audit: audit,
      ctx: BotContext(
        now: () => 0, network: () => 'testnet',
        prices: (syms) async => {'SOL': 89.08, 'USDC': 1},
      ),
      liveEntitled: true,
    );
    final bot = runner.add(tpl.fromTemplate('conservative_dca', pair: 'SOL/USDC'));
    await runner.enablePaper(bot.id, allocationUsd: 100);
    final rep = await runner.tickBot(bot.id);
    print('DCA report: ${rep['events']}');
    print('DCA audit kinds: ${audit.list().map((e) => e['type']).toList()}');
    final evs = (rep['events'] as List);
    expect(evs.any((e) => e is Map && (e['action'] != null || e['paper'] == true)), isTrue,
        reason: 'DCA paper bot produced no fill: $evs');
  });

  test('PAPER wide_grid (spanPct, SOL/USDC) auto-centers on SOL + fills a buy rung on a dip', () async {
    final audit = Audit();
    final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
    final reg = ToolRegistry([_mk('swap', []), _mk('place_order', [])]);
    policy.setAllowlist(reg.names());
    // Tick 1 builds the ±20% ladder around SOL=$89 (rungs ~$71..$107); tick 2 at
    // $80 (a ~10% dip) must cross a buy rung and fill — proving the rungs are
    // priced around the LIVE SOL mark, not a dead $1 band.
    var px = 89.08;
    final runner = BotRunner(
      policy: policy, tools: reg, audit: audit,
      ctx: BotContext(now: () => 0, network: () => 'testnet',
          prices: (syms) async => {'SOL': px, 'USDC': 1}),
      liveEntitled: true,
    );
    final bot = runner.add(tpl.fromTemplate('wide_grid', pair: 'SOL/USDC'));
    await runner.enablePaper(bot.id, allocationUsd: 500);
    await runner.tickBot(bot.id); // establish the ladder at $89
    px = 80.0;                    // SOL dips ~10%
    final rep = await runner.tickBot(bot.id);
    print('GRID events (after dip): ${rep['events']}');
    final evs = (rep['events'] as List);
    expect(evs.any((e) => e is Map && (e['action'] != null || e['paper'] == true)), isTrue,
        reason: 'spanPct grid did not fill a buy rung on a SOL dip: $evs');
  });

  test('BLOCK/USDC bot CANNOT trade — BLOCK is never priced (the old bug)', () async {
    final audit = Audit();
    final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
    final reg = ToolRegistry([_mk('swap', []), _mk('place_order', [])]);
    policy.setAllowlist(reg.names());
    final runner = BotRunner(
      policy: policy, tools: reg, audit: audit,
      // Mirror production _prices: BLOCK is intentionally omitted (never priced).
      ctx: BotContext(now: () => 0, network: () => 'testnet',
          prices: (syms) async => {'USDC': 1}),
      liveEntitled: true,
    );
    final bot = runner.add(tpl.fromTemplate('conservative_dca', pair: 'BLOCK/USDC'));
    await runner.enablePaper(bot.id, allocationUsd: 100);
    final rep = await runner.tickBot(bot.id);
    final evs = (rep['events'] as List);
    print('BLOCK events (expected price-skip): $evs');
    expect(evs.every((e) => e is Map && e['skipped'] == 'price'), isTrue,
        reason: 'BLOCK pair should skip on price (documents why it never traded)');
  });

  test('PROFIT notification fires when a paper DCA deal closes in profit', () async {
    final audit = Audit();
    final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
    final reg = ToolRegistry([_mk('swap', []), _mk('place_order', [])]);
    policy.setAllowlist(reg.names());
    final notifier = RecordingNotifier();
    var px = 89.08;
    final runner = BotRunner(
      policy: policy, tools: reg, audit: audit, notifier: notifier,
      ctx: BotContext(now: () => 0, network: () => 'testnet',
          prices: (syms) async => {'SOL': px, 'USDC': 1}),
      liveEntitled: true,
    );
    // conservative_dca takes profit at +2%. Open the deal at $89, then rally to
    // $93 (~+4.4%) so the take-profit sells for a realized gain and the deal closes.
    final bot = runner.add(tpl.fromTemplate('conservative_dca', pair: 'SOL/USDC'));
    await runner.enablePaper(bot.id, allocationUsd: 100);
    await runner.tickBot(bot.id); // base buy at $89
    px = 93.0;                    // rally past +2% TP
    await runner.tickBot(bot.id); // take-profit close
    final profit = notifier.sent.where((n) => n.data['type'] == 'bot_profit').toList();
    print('PROFIT notifications: ${notifier.sent.map((n) => n.title).toList()}');
    expect(profit.isNotEmpty, isTrue, reason: 'no profit notification fired: ${notifier.sent}');
    expect((profit.first.data['deltaUsd'] as num) > 0, isTrue);
  });

  test('PAPER scanner ("AI picks") emits a sniper buy on one tick', () async {
    final log = <Map<String, dynamic>>[];
    final audit = Audit();
    final policy = Policy.create(caps: {'sessionUsd': 1000}, audit: audit);
    final reg = ToolRegistry([_mk('swap', log), _mk('place_order', log)]);
    policy.setAllowlist(reg.names());
    final runner = BotRunner(
      policy: policy, tools: reg, audit: audit,
      ctx: BotContext(
        now: () => 0, network: () => 'testnet',
        prices: (syms) async => {'SOL': 89.08, 'USDC': 1, 'DESSA': 0.02609},
      ),
      discovery: _Disco(),
      liveEntitled: true,
    );
    final bot = runner.add(tpl.fromTemplate('scan_and_trade'));
    await runner.enablePaper(bot.id, allocationUsd: 100);
    final rep = await runner.tickBot(bot.id);
    print('SCAN report events: ${rep['events']}');
    print('SCAN lastScan worthy: ${(rep['scan'] as Map?)?['worthy']}');
    print('SCAN lastScan skipped: ${(rep['scan'] as Map?)?['skipped']}');
    print('SCAN audit: ${audit.list().map((e) => "${e['type']}:${e['reason'] ?? e['candidates'] ?? ''}").toList()}');
    final evs = (rep['events'] as List);
    expect(evs.any((e) => e is Map && (e['action'] != null || e['paper'] == true)), isTrue,
        reason: 'scanner produced no trade: events=$evs');
  });
}
