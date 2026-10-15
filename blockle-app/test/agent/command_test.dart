// Dart port of blockle-extension/agent/command.test.js — the NATURAL-LANGUAGE
// COMMAND BAR router.
//
// The command bar adds NO new power: a MOCK agent only PROPOSES tool-calls over
// the EXISTING registry (buildTools), and the EXISTING gate (policy +
// dispatchValueMoving) enforces every fund move. These tests inject a mock agent
// (canned tool-calls / answers) and assert the safety contract holds end-to-end:
//   1. a send intent routes through dispatchValueMoving; a declined confirm => zero commits
//   2. "alice.eth" is resolved and the RESOLVED address is inspected/confirmed/sent
//   3. a "rebalance" yielding multiple swaps gates EACH step
//   4. a bot-P&L query answers from the real dashboard/ledger for a 7-day window,
//      and an unavailable source => honest "unavailable" (never fabricated)
//   5. a query cannot invoke send/swap (read-only tool set)
//   6. THE INVARIANT — a huge send proposed via NL is hard-capped by the gate and
//      never commits, exactly like any other agent call.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/tools.dart';
import 'package:blockle_app/agent/command.dart';
import 'package:blockle_app/agent/providers.dart';
import 'package:blockle_app/multichain/venues.dart';

const int dayMs = 86400000;
final String rawEoa = '0x${'a' * 40}';
final String resolved = '0x${'b' * 40}';

// mirror exchange/treasury.json enough to route the mandatory 0.05% agent fee.
const treasuryCfg = {
  'agentTradeFeeBps': 5,
  'mainnet': {
    'base': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    'ethereum': '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  },
};

/// A mock agent (provider). A classification call offers NO tools -> we answer
/// with the scripted `intent`. Any call that offers tools replays the next
/// scripted turn ({ text?, toolCalls? }), exactly like a real provider.turn.
class MockAgent implements LlmProvider {
  final String intent;
  final List<Map<String, dynamic>> turns;
  int _i = 0;
  MockAgent({this.intent = 'query', List<Map<String, dynamic>>? turns})
      : turns = turns ?? [];
  @override
  String get name => 'mock';
  @override
  Future<Map<String, dynamic>> turn({
    String? system,
    required List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
  }) async {
    if (tools == null || tools.isEmpty) return {'intent': intent};
    return _i < turns.length ? turns[_i++] : {'text': 'done'};
  }
}

/// A minimal wallet wiring ctx for buildTools. Counts broadcasts/commits so a
/// test can prove nothing moved.
class TestCtx {
  final Map<String, int> calls = {'broadcast': 0, 'buildSend': 0, 'swap': 0, 'confirm': 0, 'fee': 0};
  final Map<String, dynamic> seen = {};
  late final AgentContext ctx;

  TestCtx({
    Future<num?> Function(String, String)? estimateUsd,
    VenueRegistry? venues,
  }) {
    ctx = AgentContext(
      getAddress: (chain) async => '0xADDR',
      getBalance: (chain, [tokens]) async => [
        {
          'asset': {'symbol': chain.toUpperCase(), 'decimals': 18},
          'confirmed': '5000000000000000000'
        }
      ],
      estimateUsd: estimateUsd ?? (_, __) async => 100,
      buildSend: (chain, p) async {
        calls['buildSend'] = calls['buildSend']! + 1;
        seen['built'] = p['to'];
        return {'fee': '21000', 'txid': '0xbuilt'};
      },
      broadcast: (chain, built) async {
        calls['broadcast'] = calls['broadcast']! + 1;
        seen['broadcastTxid'] = built['txid'];
        return {'txid': '0xtx', 'accepted': true};
      },
      inspect: (chain, intent) async {
        seen['inspected'] = intent['to'];
        return null;
      },
      venues: venues,
      executeSwap: (built) async {
        calls['swap'] = calls['swap']! + 1;
        return {'txid': '0xswap${calls['swap']}', 'accepted': true};
      },
      sendFee: (feeXfer) async {
        calls['fee'] = calls['fee']! + 1;
        return {'txid': '0xfee'};
      },
    );
  }
}

void main() {
  // -------------------------------------------------------------------------
  // 1. a send intent routes through the ONE gate; declined confirm => zero commits
  // -------------------------------------------------------------------------
  test('send intent goes through the ONE gate; a declined confirm commits nothing',
      () async {
    final t = TestCtx();
    final policy = Policy.create(confirm: (_) async {
      t.calls['confirm'] = t.calls['confirm']! + 1;
      return false;
    });
    final provider = MockAgent(intent: 'action', turns: [
      {
        'toolCalls': [
          {
            'id': '1',
            'name': 'send',
            'arguments': {'chain': 'ethereum', 'to': rawEoa, 'amount': '100000000000000000'}
          }
        ]
      },
      {'text': 'I did not send anything — you declined.'},
    ]);
    final router = CommandRouter(provider: provider, tools: buildTools(t.ctx), policy: policy);

    final r = await router.run('send 0.1 ETH to $rawEoa');
    expect(r.intent, 'action');
    expect(t.calls['confirm'], 1, reason: 'the human was asked to confirm');
    expect(t.calls['broadcast'], 0, reason: 'a declined confirm must broadcast NOTHING');
    final step = r.steps.firstWhere((s) => s['name'] == 'send');
    expect(step['status'], 'declined');
  });

  // -------------------------------------------------------------------------
  // 2. a name is resolved and the RESOLVED address is inspected/confirmed/sent
  // -------------------------------------------------------------------------
  test('alice.eth is resolved and the RESOLVED address (not the raw name) is used throughout',
      () async {
    final t = TestCtx();
    final policy = Policy.create(confirm: (s) async {
      t.seen['confirmed'] = s['to'];
      return true;
    });
    resolveName(input, chain) async =>
        input == 'alice.eth' ? {'address': resolved, 'source': 'ens', 'name': input} : null;
    final events = <Map<String, dynamic>>[];
    final provider = MockAgent(intent: 'action', turns: [
      {
        'toolCalls': [
          {
            'id': '1',
            'name': 'send',
            'arguments': {'chain': 'ethereum', 'to': 'alice.eth', 'amount': '100000000000000000'}
          }
        ]
      },
      {'text': 'Sent to alice.eth.'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      resolveNameFn: resolveName,
      onEvent: events.add,
    );

    await router.run('send 0.1 ETH to alice.eth');

    expect(t.seen['built'], resolved, reason: 'the built tx goes to the RESOLVED address');
    expect(t.seen['inspected'], resolved,
        reason: 'the security inspection sees the RESOLVED address');
    expect(t.seen['confirmed'], resolved, reason: 'the human confirms the RESOLVED address');
    expect(t.calls['broadcast'], 1);
    final res = events.firstWhere((e) => e['type'] == 'resolved');
    expect(res['input'], 'alice.eth');
    expect(res['address'], resolved);
    expect(res['source'], 'ens');
  });

  test('a recipient NAME that does not resolve is a hard error — never sent to the raw name',
      () async {
    final t = TestCtx();
    final policy = Policy.create(confirm: (_) async => true);
    resolveName(input, chain) async => null; // nothing resolves
    final provider = MockAgent(intent: 'action', turns: [
      {
        'toolCalls': [
          {
            'id': '1',
            'name': 'send',
            'arguments': {'chain': 'ethereum', 'to': 'nobody.eth', 'amount': '1'}
          }
        ]
      },
      {'text': 'Could not resolve the recipient.'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      resolveNameFn: resolveName,
    );
    final r = await router.run('send 1 wei to nobody.eth');
    expect(t.calls['broadcast'], 0);
    final step = r.steps.firstWhere((s) => s['name'] == 'send');
    expect(step['status'], 'error');
    expect('${step['error']}', matches(RegExp('resolve', caseSensitive: false)));
  });

  // -------------------------------------------------------------------------
  // 3. a "rebalance" yielding multiple swaps gates EACH step
  // -------------------------------------------------------------------------
  test('rebalance -> a SEQUENCE of swaps, and EACH swap gets its own confirm gate', () async {
    final venues = VenueRegistry.create(treasury: treasuryCfg, blockle: {
      'ammReserves': (String from, String to) async =>
          {'reserveIn': '1000000000', 'reserveOut': '1000000000', 'poolFeeBps': 30},
      'assetChain': {'USDC': 'base', 'ETH': 'base'},
    });
    final t = TestCtx(estimateUsd: (_, __) async => 10, venues: venues);
    var gateCount = 0;
    final policy = Policy.create(confirm: (_) async {
      gateCount++;
      return true;
    });
    final events = <Map<String, dynamic>>[];
    final provider = MockAgent(intent: 'action', turns: [
      {
        'toolCalls': [
          {'id': '1', 'name': 'swap', 'arguments': {'from': 'USDC', 'to': 'ETH', 'amount': '60000000'}},
          {'id': '2', 'name': 'swap', 'arguments': {'from': 'ETH', 'to': 'USDC', 'amount': '40000000'}},
        ]
      },
      {'text': 'Rebalanced to 60/40.'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      onEvent: events.add,
    );

    final r = await router.run('rebalance to 60/40 stables');
    expect(gateCount, 2, reason: 'EACH of the two swaps triggered its OWN confirm sheet');
    expect(t.calls['swap'], 2, reason: 'both legs committed after their individual confirms');
    final plan = events.firstWhere((e) => e['type'] == 'plan');
    expect((plan['steps'] as List).length, 2,
        reason: 'the multi-step plan was surfaced before executing');
    expect(r.steps.where((s) => s['status'] == 'committed').length, 2);
  });

  // -------------------------------------------------------------------------
  // 4. a bot-P&L query answers from the real dashboard/ledger for a 7-day window,
  //    and an unavailable source => honest "unavailable" (never fabricated)
  // -------------------------------------------------------------------------
  test('bot-P&L query reads the real engine over a 7-day window and never fabricates', () async {
    const now = 1700000000000;
    Map<String, dynamic>? sinceSeen;
    final engines = CommandEngines(
      botsPnl: ({required int sinceMs, required int days}) async {
        sinceSeen = {'sinceMs': sinceMs, 'days': days};
        return {
          'realizedUsd': 42.5,
          'bots': [
            {'id': 'b1', 'name': 'DCA BLOCK', 'realizedUsd': 42.5, 'unrealizedUsd': 3.0},
            {'id': 'b2', 'name': 'Grid ETH', 'realizedUsd': -5.0, 'unrealizedUsd': 1.0},
          ],
        };
      },
    );
    final t = TestCtx();
    final policy = Policy.create(confirm: (_) async => true);
    final provider = MockAgent(intent: 'query', turns: [
      {
        'toolCalls': [
          {'id': '1', 'name': 'bots_pnl', 'arguments': {'days': 7}}
        ]
      },
      {'text': 'DCA BLOCK made the most this week: +\$42.50 realized.'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      engines: engines,
      now: () => now,
    );

    final r = await router.run('which bot made money this week?');
    expect(r.intent, 'query');
    expect(sinceSeen, isNotNull, reason: 'the real bot-P&L engine was consulted');
    expect(sinceSeen!['days'], 7, reason: 'a 7-day "this week" window');
    expect(sinceSeen!['sinceMs'], now - 7 * dayMs,
        reason: 'window start = now - 7 days (clock injected, not fabricated)');

    // the engine tool returns ONLY the engine's own numbers (no fabrication).
    final tool = router.queryRegistry().get('bots_pnl')!;
    final out = await tool.run!({'days': 7}) as Map;
    expect(out['available'], true);
    expect(out['windowDays'], 7);
    expect(out['realizedUsd'], 42.5);
    expect((out['bots'] as List)[0]['realizedUsd'], 42.5);
  });

  test('bot-P&L query with NO engine wired answers an honest "unavailable", never a made-up number',
      () async {
    final t = TestCtx();
    final policy = Policy.create(confirm: (_) async => true);
    final provider = MockAgent(intent: 'query', turns: [
      {
        'toolCalls': [
          {'id': '1', 'name': 'bots_pnl', 'arguments': {'days': 7}}
        ]
      },
      {'text': 'I cannot tell right now — bot P&L is unavailable.'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      engines: const CommandEngines(), // none wired
    );

    await router.run('which bot made money this week?');
    final tool = router.queryRegistry().get('bots_pnl')!;
    final out = await tool.run!({'days': 7}) as Map;
    expect(out['available'], false, reason: 'an unavailable source is reported honestly');
    expect(out.containsKey('realizedUsd'), false,
        reason: 'no fabricated P&L number is invented when the source is unavailable');
    expect('${out['reason']}', matches(RegExp('unavailable|not available', caseSensitive: false)));
  });

  // -------------------------------------------------------------------------
  // 5. a query cannot invoke send/swap (read-only tool set)
  // -------------------------------------------------------------------------
  test('a QUERY runs in the read-only tool set — a proposed send is blocked, nothing commits',
      () async {
    final t = TestCtx();
    final policy = Policy.create(confirm: (_) async => true); // would approve, but send is unreachable
    final events = <Map<String, dynamic>>[];
    // the mock agent MISBEHAVES: during a query it proposes a value-moving send.
    final provider = MockAgent(intent: 'query', turns: [
      {
        'toolCalls': [
          {'id': '1', 'name': 'send', 'arguments': {'chain': 'ethereum', 'to': rawEoa, 'amount': '1'}}
        ]
      },
      {'text': 'I can only answer questions here.'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      onEvent: events.add,
    );

    await router.run('how much ETH do I have?');
    expect(t.calls['broadcast'], 0, reason: 'a query can never reach a value-moving tool');
    final err = events.firstWhere((e) => e['type'] == 'tool_error' && e['name'] == 'send',
        orElse: () => {});
    expect(err.isNotEmpty, true, reason: 'the stripped send tool was rejected by the allowlist');
    expect('${err['error']}', matches(RegExp('allow', caseSensitive: false)));

    // and the read-only registry never even OFFERS a value-moving tool to the model.
    final schemas = router.queryRegistry().schemas().map((s) => s['name']).toList();
    expect(schemas.contains('send'), false, reason: 'send not offered during a query');
    expect(schemas.contains('swap'), false, reason: 'swap not offered during a query');
  });

  // -------------------------------------------------------------------------
  // 6. THE INVARIANT — a huge send proposed via NL is hard-capped and never commits
  // -------------------------------------------------------------------------
  test('INVARIANT: a huge NL send is hard-capped by the gate and commits nothing', () async {
    final t = TestCtx(
        estimateUsd: (sym, amt) async => (double.parse(amt) / 1e18) * 2000); // ~\$2000/ETH
    final policy = Policy.create(caps: {'sessionUsd': 100}, confirm: (_) async {
      t.calls['confirm'] = t.calls['confirm']! + 1;
      return true;
    });
    final events = <Map<String, dynamic>>[];
    final provider = MockAgent(intent: 'action', turns: [
      // 1000 ETH == ~\$2,000,000, far over the \$100 session cap
      {
        'toolCalls': [
          {
            'id': '1',
            'name': 'send',
            'arguments': {'chain': 'ethereum', 'to': rawEoa, 'amount': '1000000000000000000000'}
          }
        ]
      },
      {'text': 'done'},
    ]);
    final router = CommandRouter(
      provider: provider,
      tools: buildTools(t.ctx),
      policy: policy,
      onEvent: events.add,
    );

    final r = await router.run('send 1000 ETH to $rawEoa');
    expect(t.calls['broadcast'], 0, reason: 'the hard cap blocked the send BEFORE any broadcast');
    expect(t.calls['confirm'], 0,
        reason: 'the cap rejects pre-confirm — the human is never asked to approve an over-cap move');
    final err = events.firstWhere((e) => e['type'] == 'step_error' && e['name'] == 'send',
        orElse: () => {});
    expect(err.isNotEmpty, true, reason: 'the step errored');
    expect('${err['error']}', matches(RegExp('cap', caseSensitive: false)),
        reason: 'it failed with a cap-exceeded error, same as any other agent call');
    final step = r.steps.firstWhere((s) => s['name'] == 'send');
    expect(step['status'], 'error');
  });
}
