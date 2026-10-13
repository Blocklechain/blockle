// agent/scanner_runner_test.dart — the `scanner` bot type routes its chosen Intents
// through the SAME value-moving gate as every other bot (docs/AGENT-SCAN.md §3-4):
// PAPER never broadcasts; LIVE within allocation auto-approves + commits; the hard
// allocation cap still blocks an over-allocation scanner trade; kill stops it
// instantly; the tool allowlist still governs (an unapproved tool is an audit note,
// never an ungated trade); a DANGER-severity pre-sign still forces a confirm
// (declined => no broadcast); the mainnet gate still refuses a mainnet trade. No
// synthetic prices. Same contract (docs/scan-vectors.json) as the JS reference.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/audit.dart';
import 'package:blockle_app/agent/bot_runner.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/tools.dart';
import 'package:blockle_app/multichain/security.dart' show Inspection, Warning, Checks;

Map<String, dynamic> _loadScanner() {
  for (final p in const [
    '../docs/scan-vectors.json',
    'docs/scan-vectors.json',
    '../../docs/scan-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return ((jsonDecode(f.readAsStringSync()) as Map)['scanner'] as Map)
          .cast<String, dynamic>();
    }
  }
  throw StateError('scan-vectors.json not found (cwd=${Directory.current.path})');
}

final _sv = _loadScanner();
final List<dynamic> UNIVERSE = _sv['universe'] as List;
final Map<String, dynamic> SCANNER_CFG = (_sv['config'] as Map).cast<String, dynamic>();

class _ToolState {
  int commits = 0;
  final List<Map<String, dynamic>> committed = [];
}

// A value-moving tools registry whose commit() counts broadcasts. A tool can be
// told to force a DANGER confirm for a given `to` symbol (security pre-sign).
class _FakeTools {
  final ToolRegistry registry;
  final _ToolState state;
  _FakeTools(this.registry, this.state);
}

Inspection _danger() => Inspection(
      chain: 'ethereum',
      kind: 'swap',
      summary: 'known drainer',
      details: const [],
      effects: const [],
      warnings: [Warning('known-drainer', 'danger', 'known drainer')],
      severity: 'danger',
      checks: Checks(const [], const []),
    );

_FakeTools fakeTools({String? dangerTo}) {
  final state = _ToolState();
  Tool mk(String name) => Tool(
        name: name,
        description: name,
        valueMoving: true,
        parameters: const {'type': 'object', 'properties': {}},
        prepare: (a) async {
          final from = '${a['from'] ?? a['asset'] ?? 'X'}';
          const usd = 1000.0; // every vector leg is ~$1000
          final danger = dangerTo != null && a['to'] == dangerTo;
          final prep = PreparedAction(
            summary: {'action': name, 'from': from, 'to': a['to'], 'amount': a['amount'], 'venue': a['venue']},
            value: SpendValue(asset: from, amount: '${a['amount'] ?? '0'}', usd: usd),
            commit: () async {
              state.commits++;
              state.committed.add({'name': name, 'args': a});
              return {'txid': 'tx${state.commits}', 'accepted': true};
            },
          );
          return danger ? prep.withSecurity(_danger()) : prep;
        },
      );
  final registry = ToolRegistry([mk('swap'), mk('place_order'), mk('cancel_order')]);
  return _FakeTools(registry, state);
}

BotContext mkCtx({String network = 'testnet'}) => BotContext(
      now: () => 0,
      network: () => network,
      scanUniverse: ([config]) async => UNIVERSE,
    );

class _Setup {
  final BotRunner runner;
  final Policy policy;
  final _ToolState tools;
  final Audit audit;
  _Setup(this.runner, this.policy, this.tools, this.audit);
}

class _FakeTimer implements Timer {
  bool _active = true;
  @override
  void cancel() => _active = false;
  @override
  bool get isActive => _active;
  @override
  int get tick => 0;
}

_Setup setup({
  BotContext? ctx,
  num sessionUsd = 100000,
  Future<bool> Function(Map<String, dynamic>)? confirm,
  bool mainnetEnabled = false,
  List<String>? allowlist,
  _FakeTools? tools,
}) {
  final audit = Audit();
  final policy = Policy.create(
    caps: {'sessionUsd': sessionUsd},
    confirm: confirm,
    audit: audit,
  );
  final ft = tools ?? fakeTools();
  policy.setAllowlist(allowlist ?? ft.registry.names());
  final runner = BotRunner(
    policy: policy,
    tools: ft.registry,
    audit: audit,
    ctx: ctx ?? mkCtx(),
    mainnetEnabled: mainnetEnabled,
    timerFactory: (d, cb) => _FakeTimer(),
  );
  return _Setup(runner, policy, ft.state, audit);
}

dynamic addScanner(BotRunner runner, [Map<String, dynamic>? overrides]) {
  return runner.add({
    'type': 'scanner',
    'config': {...SCANNER_CFG},
    ...?overrides,
  });
}

List<Map<String, dynamic>> auditTypes(Audit audit, String type) =>
    audit.list().where((e) => e['type'] == type).toList();

void main() {
  // =========================================================================
  // PAPER: the scanner scans + records paper intents but NEVER broadcasts
  // =========================================================================
  test('scanner PAPER: scans the worthy pairs but never broadcasts', () async {
    final su = setup();
    final bot = addScanner(su.runner);
    bot.mode = 'paper';
    bot.enabled = true;

    final report = await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 0, reason: 'PAPER must never broadcast');
    expect(auditTypes(su.audit, 'scanner_scan').length, 1);
    expect(auditTypes(su.audit, 'bot_paper_intent').length, 3,
        reason: 'the 3 worthy Intents were simulated (paper)');
    expect((report['scan'] as Map)['worthy'], ['MOM/USDC', 'ETH/USDC']);
  });

  // =========================================================================
  // LIVE within allocation: auto-approves + broadcasts the worthy pairs' Intents
  // =========================================================================
  test('scanner LIVE within allocation: the worthy pairs broadcast through the ONE gate',
      () async {
    var asked = 0;
    final su = setup(confirm: (_) async {
      asked++;
      return true;
    });
    final bot = addScanner(su.runner);
    await su.runner.armLive(bot.id, allocationUsd: 5000);

    await su.runner.tickBot(bot.id);
    expect(asked, 0, reason: 'within allocation auto-approves — confirm is NOT asked');
    expect(su.tools.commits, 3, reason: 'MOM buy + ETH arb buy + ETH arb sell all broadcast');
  });

  // =========================================================================
  // ALLOCATION CAP: an over-allocation scanner trade is refused exactly like any bot
  // =========================================================================
  test('scanner allocation cap: a worthy pair that does not fit is NOT traded', () async {
    final su = setup();
    final bot = addScanner(su.runner);
    await su.runner.armLive(bot.id, allocationUsd: 1200);

    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 1, reason: 'only the pair that fits the allocation broadcast');
    expect(su.tools.committed[0]['args']['to'], 'MOM');
    final scan = auditTypes(su.audit, 'scanner_scan')[0];
    expect((scan['skipped'] as List).any((s) => s == 'ETH/USDC:allocation'), true);
  });

  // =========================================================================
  // KILL: stops the scanner instantly — no scan, no broadcast
  // =========================================================================
  test('scanner KILL: a killed runner never scans or trades', () async {
    final su = setup();
    final bot = addScanner(su.runner);
    await su.runner.armLive(bot.id, allocationUsd: 5000);
    await su.runner.killAll('test');

    final report = await su.runner.tickBot(bot.id);
    expect(report['skipped'], 'disabled');
    expect(su.tools.commits, 0, reason: 'kill blocks all scanner trades');
    expect(auditTypes(su.audit, 'scanner_scan').length, 0, reason: 'no scan ran after kill');
  });

  // =========================================================================
  // ALLOWLIST: an un-allowlisted tool is an audit note, never an ungated trade
  // =========================================================================
  test('scanner allowlist: a worthy pair whose tool is not allowlisted is blocked', () async {
    final su = setup(allowlist: ['cancel_order']); // swap NOT allowed
    final bot = addScanner(su.runner);
    await su.runner.armLive(bot.id, allocationUsd: 5000);

    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 0, reason: 'no ungated trade when the tool is off the allowlist');
    expect(auditTypes(su.audit, 'bot_blocked').length >= 1, true);
  });

  // =========================================================================
  // DANGER pre-sign: a danger forces a confirm; declined => no broadcast
  // =========================================================================
  test('scanner danger pre-sign: a DANGER inspection forces a confirm and a decline blocks the trade',
      () async {
    var asked = 0;
    final tools = fakeTools(dangerTo: 'MOM');
    final su = setup(tools: tools, confirm: (_) async {
      asked++;
      return false;
    });
    final bot = addScanner(su.runner);
    await su.runner.armLive(bot.id, allocationUsd: 5000);

    await su.runner.tickBot(bot.id);
    expect(asked >= 1, true, reason: 'the danger forced an explicit confirm even within allocation');
    expect(su.tools.committed.any((c) => c['args']['to'] == 'MOM'), false,
        reason: 'the declined dangerous trade never broadcast');
    expect(auditTypes(su.audit, 'security_inspection').any((e) => e['severity'] == 'danger'), true);
  });

  // =========================================================================
  // MAINNET gate: a mainnet scanner trade is refused when mainnetEnabled=false
  // =========================================================================
  test('scanner mainnet gate: a mainnet-context scanner never trades when the mainnet gate is off',
      () async {
    final su = setup(ctx: mkCtx(network: 'mainnet'), mainnetEnabled: false);
    final bot = addScanner(su.runner);
    try {
      await su.runner.armLive(bot.id, allocationUsd: 5000);
    } catch (_) {}

    await su.runner.tickBot(bot.id);
    expect(su.tools.commits, 0, reason: 'no mainnet trade with the mainnet gate off');
    expect(auditTypes(su.audit, 'bot_skip').any((e) => e['reason'] == 'mainnet'), true);
  });
}
