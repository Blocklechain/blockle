// Transport-shaping tests: the real JSON-RPC / Esplora transport closures over
// an injected HttpSend seam — asserting request envelope, headers, URL
// composition, and response/error parsing with NO network. Plus a wiring check
// that buildWiredRegistry routes an adapter read through the injected sender.

import 'dart:convert';

import 'package:blockle_app/multichain/chains/registry.dart';
import 'package:blockle_app/services/transports.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('jsonRpc shaping', () {
    test('builds a JSON-RPC 2.0 envelope and returns result', () async {
      HttpReq? seen;
      final fn = jsonRpc('https://rpc.example/eth', send: (req) async {
        seen = req;
        return const HttpReply(200, '{"jsonrpc":"2.0","id":1,"result":"0x10"}');
      });
      final res = await fn('eth_getBalance', ['0xabc', 'latest']);
      expect(res, '0x10');
      expect(seen!.method, 'POST');
      expect(seen!.url, 'https://rpc.example/eth');
      expect(seen!.headers['content-type'], 'application/json');
      final body = jsonDecode(seen!.body!) as Map<String, dynamic>;
      expect(body['jsonrpc'], '2.0');
      expect(body['method'], 'eth_getBalance');
      expect(body['params'], ['0xabc', 'latest']);
      expect(body['id'], isA<int>());
    });

    test('surfaces a JSON-RPC error object as a thrown message', () async {
      final fn = jsonRpc('https://rpc.example', send: (req) async =>
          const HttpReply(200, '{"error":{"code":-32000,"message":"boom"}}'));
      expect(() => fn('eth_call', const []),
          throwsA(predicate((e) => '$e'.contains('boom'))));
    });

    test('a non-2xx HTTP status throws', () async {
      final fn = jsonRpc('https://rpc.example',
          send: (req) async => const HttpReply(503, 'nope'));
      expect(() => fn('eth_chainId', const []), throwsStateError);
    });

    test('merges caller headers over the json content-type default', () async {
      HttpReq? seen;
      final fn = jsonRpc('https://rpc.example',
          headers: {'authorization': 'Bearer k'}, send: (req) async {
        seen = req;
        return const HttpReply(200, '{"result":1}');
      });
      await fn('eth_chainId', const []);
      expect(seen!.headers['authorization'], 'Bearer k');
      expect(seen!.headers['content-type'], 'application/json');
    });
  });

  group('esplora shaping', () {
    test('GET composes base + path and returns the body', () async {
      HttpReq? seen;
      final fn = esploraGet('https://esplora/api', send: (req) async {
        seen = req;
        return const HttpReply(200, 'BODY');
      });
      final out = await fn('/address/abc');
      expect(out, 'BODY');
      expect(seen!.method, 'GET');
      expect(seen!.url, 'https://esplora/api/address/abc');
    });

    test('POST sends text/plain body and composes the URL', () async {
      HttpReq? seen;
      final fn = esploraPost('https://esplora/api', send: (req) async {
        seen = req;
        return const HttpReply(200, 'txid');
      });
      final out = await fn('/tx', 'DEADBEEF');
      expect(out, 'txid');
      expect(seen!.method, 'POST');
      expect(seen!.url, 'https://esplora/api/tx');
      expect(seen!.headers['content-type'], 'text/plain');
      expect(seen!.body, 'DEADBEEF');
    });

    test('a non-2xx status throws', () async {
      final fn = esploraGet('https://esplora/api',
          send: (req) async => const HttpReply(404, 'missing'));
      expect(() => fn('/address/x'), throwsStateError);
    });
  });

  group('buildWiredRegistry', () {
    test('routes a UTXO balance read through the injected sender', () async {
      final urls = <String>[];
      final reg = buildWiredRegistry(send: (req) async {
        urls.add(req.url);
        return const HttpReply(
            200, '{"chain_stats":{"funded_txo_sum":1000,"spent_txo_sum":200}}');
      });
      final bals = await reg.get('bitcoin').getBalance('bc1qexample');
      expect(bals.single.confirmed, '800'); // 1000 - 200
      expect(urls.single, contains('/address/bc1qexample'));
    });

    test('routes an EVM balance read through the injected sender', () async {
      final methods = <String>[];
      final reg = buildWiredRegistry(
        endpoints: const {
          'ethereum': EndpointCfg(rpcUrl: 'https://rpc.test/eth', chainId: 1),
        },
        tokens: const {'ethereum': []}, // skip token eth_calls
        send: (req) async {
          methods.add((jsonDecode(req.body!) as Map)['method'] as String);
          return const HttpReply(200, '{"result":"0x0"}');
        },
      );
      final bals = await reg.get('ethereum').getBalance('0xabc');
      expect(bals.first.confirmed, '0');
      expect(methods, contains('eth_getBalance'));
    });
  });
}
