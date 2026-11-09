// Chain.addressTokens — BLOCK-20 holdings auto-detection (parity with the web
// wallet's discoverTokens): the node has no per-address token endpoint, so the
// wallet enumerates the AMM pool tokens (+ the user's imported ids) and reads
// the holder balance per token. Only non-zero holdings come back.
import 'dart:convert';

import 'package:blockle_app/services/chain.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const world = '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f';
const usdb = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const holder = 'block1y76d75ku575wkj7yek8746xj45gmd6p9s6gqwck6uuda58jaz8esw5scq0';

http.Client fakeApi({Map<String, int> balances = const {}, bool directEndpoint = false}) {
  return MockClient((req) async {
    final p = req.url.path;
    final q = req.url.queryParameters;
    if (p == '/api/explorer/address/$holder/tokens') {
      if (!directEndpoint) return http.Response('{"error":"bad address"}', 200);
      return http.Response(jsonEncode({
        'tokens': [
          {'contract': world, 'symbol': 'WORLD', 'decimals': 8, 'balance': 123},
          {'contract': usdb, 'symbol': 'USDB', 'decimals': 6, 'balance': 0},
        ]
      }), 200);
    }
    if (p == '/api/dex/pools') {
      return http.Response(jsonEncode({
        'count': 1,
        'pools': [
          {'token': world, 'symbol': 'WORLD', 'name': 'World', 'decimals': 8, 'blockReserve': 1, 'tokenReserve': 1}
        ]
      }), 200);
    }
    final m = RegExp(r'^/api/token/([0-9a-f]{64})$').firstMatch(p);
    if (m != null) {
      final id = m.group(1)!;
      final name = id == world ? 'World' : 'USD Blockle';
      final sym = id == world ? 'WORLD' : 'USDB';
      final dec = id == world ? 8 : 6;
      return http.Response(jsonEncode({
        'error': null,
        'id': 'tok',
        'result': {
          'contract': id, 'isToken': true, 'name': name, 'symbol': sym, 'decimals': dec,
          'totalSupply': 1000,
          if (q['holder'] != null) 'balance': balances[id] ?? 0,
        }
      }), 200);
    }
    return http.Response('not found', 404);
  });
}

void main() {
  test('enumerates pool tokens and returns only non-zero holder balances', () async {
    final c = Chain(client: fakeApi(balances: {world: 3824057891295}));
    final out = await c.addressTokens(holder);
    expect(out.length, 1);
    expect(out.first['id'], world);
    expect(out.first['symbol'], 'WORLD');
    expect(out.first['decimals'], 8);
    expect(out.first['balance'], 3824057891295);
  });

  test('zero balance in every pool token -> empty list (no phantom rows)', () async {
    final c = Chain(client: fakeApi(balances: {}));
    expect(await c.addressTokens(holder), isEmpty);
  });

  test('extraContracts (imported ids without a pool) are probed too', () async {
    final c = Chain(client: fakeApi(balances: {usdb: 5000000}));
    final out = await c.addressTokens(holder, extraContracts: [usdb]);
    expect(out.map((t) => t['symbol']), ['USDB']);
    expect(out.first['decimals'], 6);
  });

  test('prefers a direct per-address holdings endpoint when the node has one', () async {
    final c = Chain(client: fakeApi(directEndpoint: true));
    final out = await c.addressTokens(holder);
    expect(out.map((t) => t['symbol']), ['WORLD']); // USDB had balance 0
    expect(out.first['balance'], 123);
  });

  test('token() unwraps the RPC envelope and passes the holder through', () async {
    final c = Chain(client: fakeApi(balances: {world: 42}));
    final t = await c.token(world, holder: holder);
    expect(t?['symbol'], 'WORLD');
    expect(t?['balance'], 42);
    expect(await c.token('deadbeef'), isNull);
    expect(await c.addressTokens(''), isEmpty);
  });
}
