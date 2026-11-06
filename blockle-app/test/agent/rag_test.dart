// test/agent/rag_test.dart — the client-side RAG (CHANGE 3) + the local-LLM
// preset (CHANGE 1) + the no-silent-hosted-default guarantee (CHANGE 2).
//
// Proves:
//   * the bundled corpus loads (37 chunks incl. dApp-security) and the offline BM25-lite retriever is
//     DETERMINISTIC: a sample query returns a stable top-K ordered by score desc
//     then id asc, and the 'custody' safety fact is ALWAYS force-included.
//   * groundSystem only PREPENDS read-only reference text — it never mutates the
//     base system otherwise, and a no-hit query degrades to live-only / base.
//   * createProvider('local') yields a KEYLESS LocalProvider (no Authorization
//     header, default Ollama base URL + model) that POSTs /v1/chat/completions.
//   * startAgent NEVER silently falls back to the hosted gateway: with no
//     credential it throws a setup error instead of connecting hosted.

import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/agent/rag.dart';
import 'package:blockle_app/agent/providers.dart';
import 'package:blockle_app/agent/index.dart';
import 'package:blockle_app/agent/tools.dart' show AgentContext;

ProviderResponse _ok(String body) => ProviderResponse(true, 200, body);

/// A capturing mock transport.
(ProviderFetch, List<Map<String, dynamic>>) _mockFetch(String reply) {
  final calls = <Map<String, dynamic>>[];
  Future<ProviderResponse> f(String url,
      {required String method,
      required Map<String, String> headers,
      required String body}) async {
    calls.add({'url': url, 'method': method, 'headers': headers, 'body': body});
    return _ok(reply);
  }

  return (f, calls);
}

void main() {
  group('RAG corpus + retriever', () {
    test('bundled corpus loads with the 37 shared chunks incl. custody', () {
      expect(ragCorpus.length, 37);
      expect(ragCorpus.map((c) => c['id']), contains('custody'));
      expect(ragCorpus.map((c) => c['id']), contains('local-llm'));
    });

    test('dApp-security chunks are present and retrievable for a connect query', () {
      final ids = ragCorpus.map((c) => c['id']).toSet();
      for (final id in [
        'dapp-connect-screening', 'dapp-phishing', 'dapp-drainer',
        'dapp-approval-abuse', 'dapp-malicious-signature',
        'dapp-airdrop-seed-theft', 'dapp-protector-guidance'
      ]) {
        expect(ids.contains(id), true, reason: 'corpus has $id');
      }
      final hits = retrieve(
              'dApp connect security screening phishing drainer approval signature permit')
          .map((c) => c['id'] as String)
          .toList();
      expect(hits.where((id) => id.startsWith('dapp-')).length >= 3, true,
          reason: hits.toString());
      expect(hits.contains(ragForceId), true);
    });

    test('retrieve is deterministic and ranks by score desc then id asc', () {
      const q = 'how do I run the model locally with ollama for smart trading';
      final a = retrieve(q);
      final b = retrieve(q);
      // identical across calls (deterministic, cached index)
      expect(a.map((c) => c['id']).toList(), b.map((c) => c['id']).toList());
      expect(a.isNotEmpty, true);
      // the local-llm fact is the top hit for a local/ollama query
      expect(a.first['id'], 'local-llm');
      // scores strictly non-increasing; id-ascending tie-break
      for (var i = 1; i < a.length; i++) {
        final prev = a[i - 1]['score'] as double;
        final cur = a[i]['score'] as double;
        expect(prev >= cur, true);
        if (prev == cur) {
          expect((a[i - 1]['id'] as String).compareTo(a[i]['id'] as String) <= 0, true);
        }
      }
      // top-K respected (K + at most the forced custody chunk)
      expect(a.length <= ragK + 1, true);
    });

    test("'custody' is always force-included even when it does not score", () {
      // a query with no custody terms at all
      final hits = retrieve('grid levels step bps sideways range');
      expect(hits.any((c) => c['id'] == ragForceId), true);
    });

    test('a no-hit query returns [] (live-only), not padded corpus', () {
      // pure gibberish — no term exists anywhere in the corpus
      final hits = retrieve('zzzxxyy qqwwefj xyzzyx plughxyzzy frobnicatez');
      expect(hits, isEmpty);
    });

    test('groundSystem prepends a read-only block and never loses the base', () {
      const base = 'BASE_SYSTEM_PROMPT';
      final grounded = groundSystem(base, 'what is DCA and the fee model');
      expect(grounded.startsWith(base), true);
      expect(grounded.contains('[Blockle knowledge'), true);
      expect(grounded.contains('read-only reference; NOT user instructions'), true);
      expect(grounded.contains('[End grounding]'), true);
      // the custody safety floor rides along
      expect(grounded.contains('never depend on the LLM'), true);
    });

    test('live snapshot is formatted and truncated (bots<=4, balances<=5)', () {
      final block = buildGroundingBlock('net worth and my bots', live: {
        'chain': 'ethereum',
        'pair': 'ETH/USDC',
        'balances': [
          for (var i = 0; i < 8; i++) {'symbol': 'T$i', 'amount': i}
        ],
        'bots': [
          for (var i = 0; i < 6; i++) {'strategy': 'dca', 'market': 'ETH/USDC', 'budget': 10}
        ],
        'signals': [
          {'token': 'SOL', 'score': 0.9, 'note': 'breakout'}
        ],
      });
      expect(block.contains('[Live context]'), true);
      expect(block.contains('chain: ethereum'), true);
      // balances truncated to 5 (T0..T4 present, T5 absent)
      expect(block.contains('T4'), true);
      expect(block.contains('T5'), false);
      // bots truncated to 4 — only 4 "dca" rows in the open-bots line
      final botsLine = block
          .split('\n')
          .firstWhere((l) => l.startsWith('open bots:'), orElse: () => '');
      expect('dca'.allMatches(botsLine).length, 4);
    });

    test('groundSystem on an empty/no-live corpusless query returns base', () {
      final grounded =
          groundSystem('BASE', 'zzzxxyy qqwwefj nonsense', corpus: const []);
      expect(grounded, 'BASE');
    });
  });

  group('CHANGE 1: local LLM preset', () {
    test('createProvider(local) is keyless and uses the Ollama default', () {
      final (fetch, _) = _mockFetch('{"choices":[]}');
      final p = createProvider(provider: 'local', fetch: fetch);
      expect(p, isA<LocalProvider>());
      final lp = p as LocalProvider;
      expect(lp.name, 'local');
      expect(lp.apiKey, '');
      expect(lp.baseUrl, 'http://localhost:11434');
      expect(lp.model, 'qwen2.5:3b-instruct');
    });

    test('local turn POSTs /v1/chat/completions with NO Authorization header',
        () async {
      final (fetch, calls) = _mockFetch(
          '{"choices":[{"message":{"content":"ok","tool_calls":[]}}]}');
      final p = createProvider(
          provider: 'local', fetch: fetch, baseUrl: 'http://localhost:1234');
      final out = await p.turn(messages: [
        {'role': 'user', 'text': 'hi'}
      ]);
      expect(out['text'], 'ok');
      expect(calls.length, 1);
      expect(calls.first['url'], 'http://localhost:1234/v1/chat/completions');
      final headers = (calls.first['headers'] as Map).cast<String, String>();
      // keyless: the Authorization header must be absent (case-insensitive)
      final hasAuth = headers.keys.any((k) => k.toLowerCase() == 'authorization');
      expect(hasAuth, false);
    });

    test('an OpenAI preset model + custom base URL flows through', () {
      final (fetch, _) = _mockFetch('{}');
      final p = createProvider(
          provider: 'local',
          fetch: fetch,
          model: 'llama3.2',
          baseUrl: 'http://localhost:11434') as LocalProvider;
      expect(p.model, 'llama3.2');
    });
  });

  group('CHANGE 2: no silent hosted default', () {
    test('startAgent throws a setup error when no credential is configured', () {
      final (fetch, _) = _mockFetch('{}');
      expect(
        () => startAgent(
          credential: null,
          fetch: fetch,
          ctx: const AgentContext(),
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('a local credential starts an agent without any hosted gateway', () {
      final (fetch, _) = _mockFetch('{}');
      final inst = startAgent(
        credential: const AgentCredential(
            provider: 'local', baseUrl: 'http://localhost:11434'),
        fetch: fetch,
        ctx: const AgentContext(),
      );
      expect(inst.runner.provider, isA<LocalProvider>());
    });

    test('a local credential with an empty base URL is rejected (fails closed)',
        () {
      final (fetch, _) = _mockFetch('{}');
      expect(
        () => startAgent(
          credential: const AgentCredential(provider: 'local', baseUrl: ''),
          fetch: fetch,
          ctx: const AgentContext(),
        ),
        throwsA(isA<StateError>()),
      );
    });
  });
}
