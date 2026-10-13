// test/agent/hosted_test.dart — the KEYLESS hosted provider + the SAFETY
// INVARIANT (Dart port of blockle-extension/agent/hosted.test.js). Conformance
// to docs/hosted-agent-vectors.json.
//
// Proves:
//   * the `hosted` provider yields a working turn() with ONLY a session token
//     (no apiKey ever sent), and returns the normalized { text?, toolCalls? }
//   * the session is transparently refreshed (re-sign) on a 401
//   * the hosted connection record persists (vault-sealed) + refreshes in place,
//     and the secret-free list NEVER leaks the session token
//   * THE INVARIANT: a hosted provider returning a MALICIOUS toolCall is STILL
//     blocked by the CLIENT policy gate (cap/confirm) exactly like a BYO
//     provider — the gateway/LLM can never move funds, and a danger-severity
//     security pre-sign still forces a human confirm even under auto-approve.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/index.dart';
import 'package:blockle_app/agent/providers.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/runner.dart';
import 'package:blockle_app/agent/tools.dart';
import 'package:blockle_app/multichain/security.dart' show Inspection, Warning, Checks;

/// A recorded fetch call.
class _Call {
  final String url;
  final Map<String, String> headers;
  final Map<String, dynamic> body;
  _Call(this.url, this.headers, this.body);
}

/// A route decision: an HTTP status + the JSON the gateway returns.
class _Route {
  final int status;
  final Map<String, dynamic> json;
  _Route(this.status, this.json);
}

/// A mock fetch: given a router (url, body, callIndex) -> _Route. Captures every
/// call for after-the-fact assertions.
(ProviderFetch, List<_Call>) mockFetch(
    _Route Function(String url, Map<String, dynamic> body, int n) router) {
  final calls = <_Call>[];
  Future<ProviderResponse> f(String url,
      {required String method,
      required Map<String, String> headers,
      required String body}) async {
    final parsed = body.isNotEmpty
        ? (jsonDecode(body) as Map<String, dynamic>)
        : <String, dynamic>{};
    calls.add(_Call(url, headers, parsed));
    final r = router(url, parsed, calls.length);
    final text = jsonEncode(r.json);
    return ProviderResponse(r.status >= 200 && r.status < 300, r.status, text);
  }

  return (f, calls);
}

// ---------------------------------------------------------------------------
// INVARIANT harness: a minimal value-moving `send` tool whose commit() records
// whether it ran, driven by a hosted provider wired to a mock gateway.
// ---------------------------------------------------------------------------
class _Harness {
  final ToolRegistry tools;
  final HostedProvider provider;
  final List<Map<String, dynamic>> committed;
  _Harness(this.tools, this.provider, this.committed);
}

_Harness _harness(
  List<Map<String, dynamic>> toolCallScript, {
  Inspection? security,
}) {
  final committed = <Map<String, dynamic>>[];
  final sendTool = Tool(
    name: 'send',
    description: 'send funds',
    valueMoving: true,
    parameters: const {'type': 'object'},
    prepare: (args) async {
      final usd = args['usd'];
      var prep = PreparedAction(
        summary: {'action': 'send', 'to': args['to'], 'amount': args['amount']},
        value: SpendValue(
          asset: 'BLOCK',
          amount: '${args['amount']}',
          usd: usd != null ? (usd as num) : 1000000000,
        ),
        commit: () async {
          committed.add(args);
          return {'txid': 'SHOULD_NOT_HAPPEN'};
        },
      );
      if (security != null) prep = prep.withSecurity(security);
      return prep;
    },
  );
  final tools = ToolRegistry([sendTool]);

  // A hosted provider wired to a mock gateway that returns the malicious
  // toolCall script (one entry per turn, then {text:'done'}).
  final script = List<Map<String, dynamic>>.from(toolCallScript);
  final (fetch, _) = mockFetch((url, body, n) {
    final next = script.isNotEmpty ? script.removeAt(0) : {'text': 'done'};
    return _Route(200, next);
  });
  final provider = createProvider(
    provider: 'hosted',
    gatewayUrl: 'https://evil-gw',
    sessionToken: 'sess',
    fetch: fetch,
  ) as HostedProvider;
  return _Harness(tools, provider, committed);
}

void main() {
  // -------------------------------------------------------------------------
  // 1. HOSTED PROVIDER — keyless turn()
  // -------------------------------------------------------------------------
  group('hosted provider — keyless turn()', () {
    test('turn() works with ONLY a session token (no apiKey sent)', () async {
      final (fetch, calls) = mockFetch((url, body, n) {
        expect(url.endsWith('/agent/turn'), isTrue);
        return _Route(200, {
          'text': 'proposing a swap',
          'toolCalls': [
            {'id': 't1', 'name': 'swap', 'arguments': {'amount': '10'}}
          ]
        });
      });
      final p = createProvider(
        provider: 'hosted',
        gatewayUrl: 'https://gw.test/',
        sessionToken: 'sess-abc',
        fetch: fetch,
      );
      final out = await p.turn(
        system: 's',
        messages: [{'role': 'user', 'text': 'swap 10'}],
        tools: [{'name': 'swap'}],
      );
      expect(out['text'], 'proposing a swap');
      expect((out['toolCalls'] as List)[0]['name'], 'swap');
      // trailing slash is stripped -> one clean /agent/turn
      expect(calls[0].url, 'https://gw.test/agent/turn');
      // the request carried the sessionToken and NEVER an apiKey
      final sent = calls[0].body;
      expect(sent['sessionToken'], 'sess-abc');
      expect(sent.containsKey('apiKey'), isFalse,
          reason: 'hosted turn must not send an apiKey');
      final h = calls[0].headers;
      expect(h.containsKey('x-api-key'), isFalse);
      expect(h.containsKey('authorization'), isFalse);
    });

    test('requires gatewayUrl + sessionToken, never an apiKey', () {
      // create() must NOT demand an apiKey for hosted (the BYO guard is bypassed)
      Future<ProviderResponse> f(String url,
              {required String method,
              required Map<String, String> headers,
              required String body}) async =>
          const ProviderResponse(true, 200, '{}');
      expect(
          () => HostedProvider(
              gatewayUrl: '', sessionToken: 'x', fetch: f),
          throwsA(predicate((e) => '$e'.contains('gatewayUrl'))));
      expect(
          () => HostedProvider(
              gatewayUrl: 'https://gw', sessionToken: null, fetch: f),
          throwsA(predicate((e) => '$e'.contains('sessionToken'))));
      final p = createProvider(
          provider: 'hosted',
          gatewayUrl: 'https://gw',
          sessionToken: 't',
          fetch: f);
      expect(p.name, 'hosted');
    });

    test('a 401 triggers ONE transparent refresh + retry', () async {
      var refreshed = 0;
      final (fetch, _) = mockFetch((url, body, n) {
        if (body['sessionToken'] == 'stale') {
          return _Route(401, {'error': 'expired'});
        }
        return _Route(200, {'text': 'ok after refresh'});
      });
      final p = createProvider(
        provider: 'hosted',
        gatewayUrl: 'https://gw',
        sessionToken: 'stale',
        fetch: fetch,
        refresh: () async {
          refreshed++;
          return 'fresh';
        },
      ) as HostedProvider;
      final out = await p.turn(
        system: 's',
        messages: [{'role': 'user', 'text': 'hi'}],
        tools: [],
      );
      expect(refreshed, 1);
      expect(out['text'], 'ok after refresh');
      expect(p.sessionToken, 'fresh');
    });

    test('normalizes the gateway reply to {text?, toolCalls?} exactly', () async {
      // matches docs/hosted-agent-vectors.json turn.normalized_response_shape
      final (fetch, _) = mockFetch((url, body, n) => _Route(200, {
            'text': 'I will swap it.',
            'toolCalls': [
              {
                'id': 'tu_1',
                'name': 'swap',
                'arguments': {'from': 'BLOCK', 'to': 'USDC', 'amount': '10'}
              }
            ]
          }));
      final p = createProvider(
          provider: 'hosted',
          gatewayUrl: 'https://gw',
          sessionToken: 's',
          fetch: fetch);
      final out = await p.turn(messages: [{'role': 'user', 'text': 'swap'}]);
      expect(out['text'], 'I will swap it.');
      final tc = (out['toolCalls'] as List)[0];
      expect(tc['id'], 'tu_1');
      expect(tc['name'], 'swap');
      expect(tc['arguments'], {'from': 'BLOCK', 'to': 'USDC', 'amount': '10'});
    });

    test('text-only reply yields no toolCalls; empty text normalizes to null',
        () async {
      final (fetch, _) = mockFetch((url, body, n) => _Route(200, {'text': ''}));
      final p = createProvider(
          provider: 'hosted',
          gatewayUrl: 'https://gw',
          sessionToken: 's',
          fetch: fetch);
      final out = await p.turn(messages: [{'role': 'user', 'text': 'hi'}]);
      expect(out['text'], isNull);
      expect(out['toolCalls'], isNull);
    });

    test('a non-ok (non-401) gateway status throws', () async {
      final (fetch, _) =
          mockFetch((url, body, n) => _Route(503, {'error': 'down'}));
      final p = createProvider(
          provider: 'hosted',
          gatewayUrl: 'https://gw',
          sessionToken: 's',
          fetch: fetch);
      expect(
          () => p.turn(messages: [{'role': 'user', 'text': 'hi'}]),
          throwsA(predicate((e) => '$e'.contains('503'))));
    });
  });

  // -------------------------------------------------------------------------
  // 2. HOSTED SESSION HANDSHAKE + CONNECTION RECORD (vault-sealed)
  // -------------------------------------------------------------------------
  group('hosted session handshake + connection record', () {
    test('challenge -> sign -> verify yields a stored connection', () async {
      final (fetch, calls) = mockFetch((url, body, n) {
        expect(url.endsWith('/agent/session'), isTrue);
        if (body['step'] == 'challenge') {
          return _Route(200, {'challenge': 'nonce-123', 'expiresAt': 1000});
        }
        if (body['step'] == 'verify') {
          expect(body['challenge'], 'nonce-123');
          expect(body['signature'], 'sig-of-nonce-123');
          expect(body['publicKey'], 'pub-hex');
          return _Route(200, {
            'sessionToken': 'tok-1',
            'expiresAt': 900000,
            'quota': {'reqPerMin': 20}
          });
        }
        throw StateError('unexpected step ${body['step']}');
      });
      final sess = await hostedSession(
        fetch: fetch,
        gatewayUrl: 'https://gw.test',
        address: 'block1abc',
        chain: 'block',
        sign: (msg) async => {'signature': 'sig-of-$msg', 'publicKey': 'pub-hex'},
      );
      expect(sess['sessionToken'], 'tok-1');
      expect(sess['gatewayUrl'], 'https://gw.test');
      expect(sess['address'], 'block1abc');
      expect(sess['publicKey'], 'pub-hex');

      // the wallet sent NO apiKey / private key / seed on any hop
      for (final c in calls) {
        expect(c.body.containsKey('apiKey'), isFalse);
        expect(c.body.containsKey('privateKey'), isFalse);
        expect(c.body.containsKey('seed'), isFalse);
      }
    });

    test('anon fallback (no signer) yields a rate-limited free-tier token',
        () async {
      final (fetch, calls) = mockFetch((url, body, n) {
        expect(body['step'], 'anon');
        return _Route(200, {
          'sessionToken': 'anon-tok',
          'expiresAt': 1760000900,
          'quota': {'dailyTokenCap': 20000}
        });
      });
      final sess = await hostedSession(
          fetch: fetch, gatewayUrl: 'https://gw.test', anon: true);
      expect(sess['sessionToken'], 'anon-tok');
      expect(sess['chain'], 'anon');
      expect(calls.length, 1);
    });

    test('connection record persists (sealed, no apiKey) + refreshes in place',
        () async {
      final sess = {
        'gatewayUrl': 'https://gw.test',
        'sessionToken': 'tok-A',
        'expiresAt': 111,
        'address': 'block1abc',
        'chain': 'block',
        'publicKey': 'pub',
        'label': 'Blockle hosted agent',
      };
      final conn = HostedConnection.fromSession(sess, model: null);
      expect(conn.sessionToken, 'tok-A');
      expect(conn.gatewayUrl, 'https://gw.test');

      // secret-free view: NO sessionToken leaks into the UI list
      final view = conn.secretFreeView();
      expect(view['provider'], 'hosted');
      expect(view['gatewayUrl'], 'https://gw.test');
      expect(view.containsKey('sessionToken'), isFalse,
          reason: 'the session token must never be in the secret-free list');
      expect(view.containsKey('apiKey'), isFalse);

      // resolve() returns the transport fields (incl. token) for the provider
      final cred = conn.resolve();
      expect(cred['provider'], 'hosted');
      expect(cred['sessionToken'], 'tok-A');
      expect(cred.containsKey('apiKey'), isFalse,
          reason: 'a hosted cred has NO apiKey');

      // round-trips through the vault seal (persists across lock/reopen)
      final sealed = jsonEncode(conn.toSealed());
      final reopened = HostedConnection.fromSealed(
          jsonDecode(sealed) as Map<String, dynamic>);
      expect(reopened.sessionToken, 'tok-A');
      expect(reopened.credRef, conn.credRef);

      // transparent refresh updates the token + expiry in place
      reopened.applyRefresh('tok-B', 222);
      expect(reopened.sessionToken, 'tok-B');
      expect(reopened.expiresAt, 222);
      expect(reopened.resolve()['sessionToken'], 'tok-B');
    });

    test('a refresh() wired into the provider re-signs via the gateway',
        () async {
      // Simulate the wallet refresh closure: re-run hostedSession and feed the
      // fresh token back to the provider (what agent-store.refreshHosted does).
      var signs = 0;
      final (fetch, _) = mockFetch((url, body, n) {
        if (url.endsWith('/agent/session')) {
          if (body['step'] == 'challenge') {
            return _Route(200, {'challenge': 'n2'});
          }
          return _Route(200, {'sessionToken': 'tok-fresh', 'expiresAt': 999});
        }
        // /agent/turn: 401 while stale, ok once refreshed
        if (body['sessionToken'] == 'tok-stale') {
          return _Route(401, {'error': 'expired'});
        }
        return _Route(200, {'text': 'ok'});
      });
      final conn = HostedConnection(
        credRef: 'cr1',
        gatewayUrl: 'https://gw.test',
        sessionToken: 'tok-stale',
        address: 'block1abc',
      );
      final p = createProvider(
        provider: 'hosted',
        gatewayUrl: conn.gatewayUrl,
        sessionToken: conn.sessionToken,
        fetch: fetch,
        refresh: () async {
          signs++;
          final s = await hostedSession(
            fetch: fetch,
            gatewayUrl: conn.gatewayUrl,
            address: conn.address,
            chain: 'block',
            sign: (m) async => {'signature': 's', 'publicKey': 'pub'},
          );
          conn.applyRefresh(s['sessionToken'] as String,
              (s['expiresAt'] as num?)?.toInt());
          return conn.sessionToken;
        },
      ) as HostedProvider;
      final out = await p.turn(messages: [{'role': 'user', 'text': 'hi'}]);
      expect(signs, 1);
      expect(out['text'], 'ok');
      expect(p.sessionToken, 'tok-fresh');
      expect(conn.sessionToken, 'tok-fresh');
      expect(conn.expiresAt, 999);
    });
  });

  // -------------------------------------------------------------------------
  // 3. THE SAFETY INVARIANT — hosted proposals are STILL gated client-side.
  //    A malicious/buggy/compromised gateway or LLM CANNOT move a single unit:
  //    worst case it proposes a toolCall the client gate rejects.
  // -------------------------------------------------------------------------
  group('SAFETY INVARIANT — hosted is the BRAIN not the HANDS', () {
    test('a hosted provider proposing a huge send is HARD-REJECTED by the '
        'client cap (never commits)', () async {
      final h = _harness([
        {
          'text': 'I will send everything',
          'toolCalls': [
            {
              'id': 't1',
              'name': 'send',
              'arguments': {
                'to': 'block1attacker',
                'amount': '99999999999',
                'usd': 5000000
              }
            }
          ]
        },
      ]);
      final policy =
          Policy.create(caps: {'sessionUsd': 10}, confirm: (_) async => true);
      final runner = Runner(
          provider: h.provider, tools: h.tools, policy: policy, maxTurns: 2);
      await runner.run('do something');
      // The gateway/LLM PROPOSED a fund-moving call; the CLIENT gate refused it.
      expect(h.committed, isEmpty,
          reason: 'a compromised gateway/LLM must NEVER cause a commit');
    });

    test('a hosted malicious call is gated IDENTICALLY to a BYO provider '
        '(declined confirm -> no commit)', () async {
      var asked = 0;
      final h = _harness([
        {
          'toolCalls': [
            {
              'id': 't1',
              'name': 'send',
              'arguments': {'to': 'block1attacker', 'amount': '5', 'usd': 1}
            }
          ]
        },
      ]);
      // under cap, but the user DECLINES the mandatory confirmation
      final policy = Policy.create(caps: {'sessionUsd': 1000}, confirm: (_) async {
        asked++;
        return false;
      });
      final runner = Runner(
          provider: h.provider, tools: h.tools, policy: policy, maxTurns: 2);
      await runner.run('do something');
      expect(asked >= 1, isTrue,
          reason: 'the client confirm gate still runs for a hosted proposal');
      expect(h.committed, isEmpty,
          reason: 'declining the confirm blocks the commit');
    });

    test('a DANGER-severity security pre-sign FORCES a confirm even under '
        'auto-approve', () async {
      Map<String, dynamic>? forced;
      final danger = Inspection(
        chain: 'block',
        kind: 'send',
        summary: 'drainer',
        details: const [],
        effects: const [],
        warnings: const [Warning('drainer', 'danger', 'wallet drainer')],
        severity: 'danger',
        checks: Checks(const ['drainer'], const []),
      );
      final h = _harness([
        {
          'toolCalls': [
            {
              'id': 't1',
              'name': 'send',
              'arguments': {'to': 'block1attacker', 'amount': '1', 'usd': 0.01}
            }
          ]
        },
      ], security: danger);
      // auto-approve tiny spends — but a danger inspection must STILL force a confirm
      final policy = Policy.create(
        caps: {'sessionUsd': 1000},
        autoApproveUnderUsd: 100,
        confirm: (summary) async {
          forced = summary;
          return false;
        },
      );
      final runner = Runner(
          provider: h.provider, tools: h.tools, policy: policy, maxTurns: 2);
      await runner.run('tiny send');
      expect(forced, isNotNull,
          reason: 'the danger pre-sign forced a human confirm despite auto-approve');
      expect((forced!['security'] as Map)['severity'], 'danger');
      expect(h.committed, isEmpty);
    });
  });

  // -------------------------------------------------------------------------
  // 4. START WIRING (index.dart) — startAgent ACCEPTS a keyless hosted
  //    credential and THREADS gatewayUrl/sessionToken/refresh into the `hosted`
  //    provider so it is actually used. Mirrors blockle-extension/agent/index.js
  //    Agent.start's hosted branch.
  // -------------------------------------------------------------------------
  group('startAgent — keyless hosted credential wiring (index.dart)', () {
    test('ACCEPTS a hosted credential with NO apiKey and runs through the '
        'hosted gateway (never sends an apiKey)', () async {
      final (fetch, calls) = mockFetch((url, body, n) {
        expect(url.endsWith('/agent/turn'), isTrue);
        return _Route(200, {'text': 'hello from the hosted brain'});
      });
      final agent = startAgent(
        credential: const AgentCredential(
          provider: 'hosted',
          gatewayUrl: 'https://gw.test/',
          sessionToken: 'sess-xyz',
          // NOTE: no apiKey — a hosted credential is keyless.
        ),
        fetch: fetch,
        ctx: const AgentContext(),
        caps: {'sessionUsd': 10},
        confirm: (_) async => true,
      );
      // the provider wired into the runner is the hosted transport
      expect(agent.runner.provider, isA<HostedProvider>());
      expect(agent.runner.provider.name, 'hosted');

      final out = await agent.run('hi');
      expect(out.text, 'hello from the hosted brain');
      // the gatewayUrl + sessionToken were threaded through; NO apiKey ever sent
      expect(calls[0].url, 'https://gw.test/agent/turn');
      expect(calls[0].body['sessionToken'], 'sess-xyz');
      expect(calls[0].body.containsKey('apiKey'), isFalse);
      expect(calls[0].headers.containsKey('x-api-key'), isFalse);
      expect(calls[0].headers.containsKey('authorization'), isFalse);
    });

    test('threads the refresh callback into the provider (401 -> re-sign)',
        () async {
      var refreshed = 0;
      final (fetch, _) = mockFetch((url, body, n) {
        if (body['sessionToken'] == 'stale') return _Route(401, {'error': 'x'});
        return _Route(200, {'text': 'ok after refresh'});
      });
      final agent = startAgent(
        credential: AgentCredential(
          provider: 'hosted',
          gatewayUrl: 'https://gw',
          sessionToken: 'stale',
          refresh: () async {
            refreshed++;
            return 'fresh';
          },
        ),
        fetch: fetch,
        ctx: const AgentContext(),
        caps: {'sessionUsd': 10},
        confirm: (_) async => true,
      );
      final out = await agent.run('hi');
      expect(refreshed, 1, reason: 'startAgent must thread cred.refresh through');
      expect(out.text, 'ok after refresh');
      expect((agent.runner.provider as HostedProvider).sessionToken, 'fresh');
    });

    test('REJECTS a BYO credential with an empty apiKey, but a hosted one with '
        'no apiKey is allowed', () {
      Future<ProviderResponse> f(String url,
              {required String method,
              required Map<String, String> headers,
              required String body}) async =>
          const ProviderResponse(true, 200, '{}');
      // BYO with empty apiKey -> rejected (unchanged behaviour)
      expect(
          () => startAgent(
              credential: const AgentCredential(provider: 'claude', apiKey: ''),
              fetch: f,
              ctx: const AgentContext()),
          throwsA(predicate((e) => '$e'.contains('not configured'))));
      // hosted missing its gateway session -> rejected with the hosted message
      expect(
          () => startAgent(
              credential: const AgentCredential(
                  provider: 'hosted', gatewayUrl: '', sessionToken: 'x'),
              fetch: f,
              ctx: const AgentContext(),
              caps: {'sessionUsd': 1},
              confirm: (_) async => true),
          throwsA(predicate((e) => '$e'.contains('hosted agent is not configured'))));
      // hosted WITH a gateway session -> accepted (no apiKey required)
      final agent = startAgent(
        credential: const AgentCredential(
            provider: 'hosted', gatewayUrl: 'https://gw', sessionToken: 't'),
        fetch: f,
        ctx: const AgentContext(),
        caps: {'sessionUsd': 1},
        confirm: (_) async => true,
      );
      expect(agent.runner.provider.name, 'hosted');
    });
  });
}
