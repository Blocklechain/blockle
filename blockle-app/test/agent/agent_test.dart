// Dart port of blockle-extension/agent/agent.test.js — the mandatory safety
// layer. Focus (PASS-1 contract): spending cap enforced, confirmation required,
// kill switch halts. Plus allowlist enforcement, audit tamper-evidence, the
// runner build->cap->confirm->commit ordering, and provider tool-call mapping.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/audit.dart';
import 'package:blockle_app/agent/tools.dart';
import 'package:blockle_app/agent/runner.dart';
import 'package:blockle_app/agent/providers.dart';

/// A provider that replays a fixed script of { text, toolCalls } turns.
class Scripted implements LlmProvider {
  final List<Map<String, dynamic>> script;
  int _i = 0;
  Scripted(this.script);
  @override
  String get name => 'scripted';
  @override
  Future<Map<String, dynamic>> turn({
    String? system,
    required List<Map<String, dynamic>> messages,
    List<Map<String, dynamic>>? tools,
  }) async =>
      _i < script.length ? script[_i++] : {'text': 'done'};
}

Map<String, dynamic>? _toolMsg(Runner r) {
  for (final m in r.messages) {
    if (m['role'] == 'tool') return m;
  }
  return null;
}

void main() {
  group('spending cap enforced', () {
    test('per-asset cap hard-rejects an over-cap action', () {
      final p = Policy.create(caps: {'perAsset': {'BTC': '1000'}});
      expect(() => p.assessValue(const SpendValue(asset: 'BTC', amount: '1500')),
          throwsA(isA<CapExceeded>()));
      p.assessValue(const SpendValue(asset: 'BTC', amount: '600'));
      p.recordSpend(const SpendValue(asset: 'BTC', amount: '600'));
      expect(() => p.assessValue(const SpendValue(asset: 'BTC', amount: '500')),
          throwsA(isA<CapExceeded>()));
      p.assessValue(const SpendValue(asset: 'BTC', amount: '400')); // exactly at cap
    });

    test('session USD cap hard-rejects and accrues cumulatively', () {
      final p = Policy.create(caps: {'sessionUsd': 50});
      expect(() => p.assessValue(const SpendValue(asset: 'X', amount: '1', usd: 60)),
          throwsA(isA<CapExceeded>()));
      p.assessValue(const SpendValue(asset: 'X', amount: '1', usd: 40));
      p.recordSpend(const SpendValue(asset: 'X', amount: '1', usd: 40));
      expect(() => p.assessValue(const SpendValue(asset: 'X', amount: '1', usd: 20)),
          throwsA(isA<CapExceeded>()));
    });

    test('with a session USD cap, an unpriced action is rejected', () {
      final p = Policy.create(caps: {'sessionUsd': 50});
      expect(() => p.assessValue(const SpendValue(asset: 'X', amount: '1', usd: null)),
          throwsA(predicate((e) => '$e'.contains('cannot verify'))));
    });

    test('caps reset only via explicit resetSpend, never implicitly', () {
      final p = Policy.create(caps: {'sessionUsd': 50});
      p.recordSpend(const SpendValue(asset: 'X', amount: '1', usd: 50));
      expect(() => p.assessValue(const SpendValue(asset: 'X', amount: '1', usd: 1)),
          throwsA(isA<CapExceeded>()));
      p.resetSpend();
      p.assessValue(const SpendValue(asset: 'X', amount: '1', usd: 1));
    });
  });

  group('confirmation required', () {
    test('default-on gate denies when the user declines', () async {
      final p = Policy.create(confirm: (_) async => false);
      final g = await p.gateConfirm({'action': 'send'}, {'usd': 5});
      expect(g.approved, false);
    });

    test('gate approves when the user accepts', () async {
      final seen = [];
      final p = Policy.create(confirm: (s) async {
        seen.add(s);
        return true;
      });
      final g = await p.gateConfirm({'action': 'send', 'amount': '10'}, {'usd': 5});
      expect(g.approved, true);
      expect(seen.length, 1);
    });

    test('FAIL-SAFE — no confirmation handler means denied', () async {
      final p = Policy.create(requireConfirm: true);
      final g = await p.gateConfirm({'action': 'send'}, {'usd': 5});
      expect(g.approved, false);
    });

    test('auto-approve under threshold is opt-in and bounded', () async {
      var asked = 0;
      final p = Policy.create(confirm: (_) async {
        asked++;
        return true;
      }, autoApproveUnderUsd: 10);
      final under = await p.gateConfirm({'action': 'send'}, {'usd': 5});
      expect(under.approved, true);
      expect(under.auto, true);
      expect(asked, 0);
      final over = await p.gateConfirm({'action': 'send'}, {'usd': 25});
      expect(over.auto, false);
      expect(asked, 1);
    });
  });

  group('kill switch halts', () {
    test('sets killed, runs onKill, and assertLive throws thereafter', () async {
      var locked = 0;
      final p = Policy.create(onKill: (_) async => locked++);
      expect(p.isKilled(), false);
      await p.kill('test');
      expect(p.isKilled(), true);
      expect(locked, 1);
      expect(() => p.assertLive(), throwsA(isA<AgentHalted>()));
      await p.kill('again');
      expect(locked, 1); // idempotent
    });

    test('a kill during the confirmation await still blocks the commit', () async {
      var committed = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (_, __) async => {'raw': '00', 'txid': 'abc', 'fee': '1000'},
        broadcast: (_, __) async {
          committed++;
          return {'txid': 'abc', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final audit = Audit();
      late Runner runner;
      final policy = Policy.create(audit: audit, confirm: (_) async {
        await runner.kill('user');
        return true;
      });
      runner = Runner(
        provider: Scripted([
          {'toolCalls': [{'id': 't1', 'name': 'send', 'arguments': {'chain': 'block', 'to': 'block1x', 'amount': '1'}}]},
          {'text': 'should never get here'},
        ]),
        tools: tools,
        policy: policy,
        audit: audit,
      );

      final res = await runner.run('send 1');
      expect(res.stopped, true);
      expect(res.reason, 'killed');
      expect(committed, 0);
      expect(policy.isKilled(), true);
    });
  });

  group('runner build -> cap -> confirm -> commit', () {
    test('approved value-moving call builds, confirms, commits, records spend', () async {
      final calls = {'build': 0, 'broadcast': 0};
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 5,
        buildSend: (chain, req) async {
          calls['build'] = calls['build']! + 1;
          return {'raw': 'de', 'txid': 'tx123', 'fee': '1000', 'summary': req};
        },
        broadcast: (_, __) async {
          calls['broadcast'] = calls['broadcast']! + 1;
          return {'txid': 'tx123', 'accepted': true};
        },
        explorerTx: (chain, txid) => 'https://ex/$txid',
      );
      final tools = buildTools(ctx);
      final audit = Audit();
      final confirms = <Map<String, dynamic>>[];
      final policy = Policy.create(caps: {'sessionUsd': 100}, confirm: (s) async {
        confirms.add(s);
        return true;
      }, audit: audit);
      final runner = Runner(
        provider: Scripted([
          {'text': 'sending now', 'toolCalls': [{'id': 't1', 'name': 'send', 'arguments': {'chain': 'block', 'to': 'block1y', 'amount': '7'}}]},
          {'text': 'all done'},
        ]),
        tools: tools,
        policy: policy,
        audit: audit,
      );

      final res = await runner.run('send 7 BLOCK to block1y');
      expect(res.reason, 'end_turn');
      expect(calls['build'], 1);
      expect(calls['broadcast'], 1);
      expect(confirms.length, 1);
      expect(confirms[0]['txid'], 'tx123');
      expect(policy.spentUsd, 5);
      final kinds = audit.list().map((e) => e['type']).toList();
      expect(kinds.contains('cap_check'), isTrue);
      expect(kinds.contains('confirmation'), isTrue);
      expect(kinds.contains('executed'), isTrue);
      expect((await audit.verify())['ok'], true);
    });

    test('an over-cap value-moving call errors to the model and never commits', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 999,
        buildSend: (chain, req) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000', 'summary': req},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(caps: {'sessionUsd': 10}, confirm: (_) async => true);
      final runner = Runner(
        provider: Scripted([
          {'toolCalls': [{'id': 't1', 'name': 'send', 'arguments': {'chain': 'block', 'to': 'block1z', 'amount': '1'}}]},
          {'text': 'ok, cancelled'},
        ]),
        tools: tools,
        policy: policy,
      );
      final res = await runner.run('send a fortune');
      expect(res.reason, 'end_turn');
      expect(broadcast, 0);
      final toolMsg = _toolMsg(runner)!;
      final content = (toolMsg['results'] as List)[0]['content'] as String;
      expect(content.contains('cap exceeded'), isTrue);
      expect((toolMsg['results'] as List)[0]['isError'], true);
    });

    test('a declined confirmation returns a rejection and does not commit', () async {
      var broadcast = 0;
      final ctx = AgentContext(
        estimateUsd: (_, __) async => 1,
        buildSend: (chain, req) async => {'raw': 'de', 'txid': 'tx', 'fee': '1000', 'summary': req},
        broadcast: (_, __) async {
          broadcast++;
          return {'txid': 'tx', 'accepted': true};
        },
      );
      final tools = buildTools(ctx);
      final policy = Policy.create(confirm: (_) async => false);
      final runner = Runner(
        provider: Scripted([
          {'toolCalls': [{'id': 't1', 'name': 'send', 'arguments': {'chain': 'block', 'to': 'block1z', 'amount': '1'}}]},
          {'text': 'understood, not sending'},
        ]),
        tools: tools,
        policy: policy,
      );
      await runner.run('maybe send');
      expect(broadcast, 0);
      final content = (_toolMsg(runner)!['results'] as List)[0]['content'] as String;
      expect(content.contains('user declined'), isTrue);
    });
  });

  group('allowlist', () {
    test('a tool not on the allowlist is rejected before execution', () async {
      final tools = buildTools(const AgentContext());
      final policy = Policy.create();
      final runner = Runner(
        provider: Scripted([
          {'toolCalls': [{'id': 't1', 'name': 'get_markets', 'arguments': {}}]},
          {'text': 'ok'},
        ]),
        tools: tools,
        policy: policy,
        allowlist: ['get_balance', 'get_address'],
      );
      final res = await runner.run('list markets');
      expect(res.reason, 'end_turn');
      final content = (_toolMsg(runner)!['results'] as List)[0]['content'] as String;
      expect(content.contains('not on allowlist'), isTrue);
      expect((_toolMsg(runner)!['results'] as List)[0]['isError'], true);
    });

    test('policy.checkAllowed throws ToolNotAllowed for unknown names', () {
      final p = Policy.create().setAllowlist(['send']);
      expect(() => p.checkAllowed('rm_rf'), throwsA(isA<ToolNotAllowed>()));
      p.checkAllowed('send');
    });
  });

  group('audit tamper-evidence', () {
    test('verify() detects a tampered entry', () async {
      final audit = Audit();
      await audit.record({'type': 'prompt', 'text': 'hi'});
      await audit.record({'type': 'executed', 'name': 'send', 'txid': 'abc'});
      expect((await audit.verify())['ok'], true);
      audit.entries[0]['text'] = 'edited after the fact';
      final v = await audit.verify();
      expect(v['ok'], false);
      expect(v['at'], 0);
    });
  });

  group('provider normalization', () {
    test('claude maps tool_use blocks to internal toolCalls', () async {
      Future<ProviderResponse> fakeFetch(String url,
          {required String method,
          required Map<String, String> headers,
          required String body}) async {
        expect(RegExp(r'/v1/messages$').hasMatch(url), isTrue);
        expect(headers['x-api-key'], 'sk-test');
        expect(headers['anthropic-dangerous-direct-browser-access'], 'true');
        final b = jsonDecode(body) as Map<String, dynamic>;
        expect((b['tools'] as List)[0]['input_schema']['type'], 'object');
        return ProviderResponse(true, 200, jsonEncode({
          'content': [
            {'type': 'text', 'text': 'ok'},
            {'type': 'tool_use', 'id': 'u1', 'name': 'send', 'input': {'amount': '5'}}
          ]
        }));
      }
      final p = createProvider(provider: 'claude', apiKey: 'sk-test', fetch: fakeFetch);
      final out = await p.turn(
        system: 's',
        messages: [{'role': 'user', 'text': 'hi'}],
        tools: [{'name': 'send', 'description': 'd', 'parameters': {'type': 'object', 'properties': {}}}],
      );
      expect(out['text'], 'ok');
      expect((out['toolCalls'] as List)[0]['name'], 'send');
      expect((out['toolCalls'] as List)[0]['arguments'], {'amount': '5'});
    });

    test('openai maps function tool_calls and stringifies args', () async {
      late Map<String, dynamic> sentBody;
      Future<ProviderResponse> fakeFetch(String url,
          {required String method,
          required Map<String, String> headers,
          required String body}) async {
        sentBody = jsonDecode(body) as Map<String, dynamic>;
        return ProviderResponse(true, 200, jsonEncode({
          'choices': [
            {'message': {'content': null, 'tool_calls': [
              {'id': 'c1', 'type': 'function', 'function': {'name': 'swap', 'arguments': '{"from":"BLOCK","to":"USDC","amount":"3"}'}}
            ]}}
          ]
        }));
      }
      final p = createProvider(provider: 'openai', apiKey: 'sk', fetch: fakeFetch);
      final out = await p.turn(
        system: 'sys',
        messages: [
          {'role': 'user', 'text': 'swap'},
          {'role': 'assistant', 'text': null, 'toolCalls': [{'id': 'c0', 'name': 'quote', 'arguments': {'from': 'BLOCK'}}]},
          {'role': 'tool', 'results': [{'id': 'c0', 'name': 'quote', 'content': '{"ok":true}'}]},
        ],
        tools: [{'name': 'swap', 'description': 'd', 'parameters': {'type': 'object', 'properties': {}}}],
      );
      expect((out['toolCalls'] as List)[0]['name'], 'swap');
      expect((out['toolCalls'] as List)[0]['arguments'], {'from': 'BLOCK', 'to': 'USDC', 'amount': '3'});
      expect((sentBody['messages'] as List)[0]['role'], 'system');
      final asst = (sentBody['messages'] as List).firstWhere((m) => m['role'] == 'assistant');
      expect(asst['tool_calls'][0]['function']['name'], 'quote');
      final toolRole = (sentBody['messages'] as List).firstWhere((m) => m['role'] == 'tool');
      expect(toolRole['tool_call_id'], 'c0');
    });

    test('credential is required (never silently absent)', () {
      Future<ProviderResponse> f(String url,
              {required String method,
              required Map<String, String> headers,
              required String body}) async =>
          const ProviderResponse(true, 200, '{}');
      expect(() => createProvider(provider: 'claude', apiKey: null, fetch: f),
          throwsA(predicate((e) => '$e'.contains('apiKey'))));
      expect(() => createProvider(provider: 'nope', apiKey: 'x', fetch: f),
          throwsA(predicate((e) => '$e'.contains('unknown provider'))));
    });
  });
}
