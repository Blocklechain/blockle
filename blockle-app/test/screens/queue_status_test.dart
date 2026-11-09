// The BLOCK transaction queue must leave "pending" once the explorer reports
// the tx mined (its reply nests the tx under `tx`), and must say "not found"
// for a tx the node never accepted instead of spinning forever.
import 'dart:convert';

import 'package:blockle_app/screens/queue.dart';
import 'package:blockle_app/services/chain.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const mined = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const mempool = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const unknown = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

// a tx indexed by the explorer ONLY under its byte-reversed (display) spelling
const rawOnly = 'a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718';
final rawOnlyDisplay = Chain.flipTxid(rawOnly);

Chain fakeChain() => Chain(client: MockClient((req) async {
      final p = req.url.path;
      if (req.method == 'POST' && p.endsWith('/api/submit')) {
        return http.Response(jsonEncode({'error': null, 'id': 'ext', 'result': {'accepted': true, 'txid': mined}}), 200);
      }
      if (p.endsWith('/tx/$rawOnlyDisplay')) {
        // known to the explorer ONLY under the reversed spelling
        return http.Response(jsonEncode({'block_hash': 'ee' * 32, 'tx': {'block_height': 1, 'confirmations': 2, 'txid': rawOnlyDisplay}}), 200);
      }
      if (p.endsWith('/tx/$mined')) {
        return http.Response(jsonEncode({
          'block_hash': 'ff' * 32,
          'tx': {'block_height': 35146, 'confirmations': 78, 'txid': mined, 'outputs': []},
        }), 200);
      }
      if (p.endsWith('/tx/$mempool')) {
        return http.Response(jsonEncode({'block_hash': null, 'tx': {'txid': mempool, 'outputs': []}}), 200);
      }
      // the explorer answers 200 with an error body for an unknown txid
      return http.Response(jsonEncode({'error': 'no such transaction'}), 200);
    }));

void main() {
  test('history labels from the explorer item shape {net, kind, time}', () {
    expect(historyKindLabel({'kind': 'contract', 'net': -1000000}), 'Contract / swap');
    expect(historyKindLabel({'kind': 'transfer', 'net': 150000000}), 'Received');
    expect(historyKindLabel({'kind': 'transfer', 'net': -150000000}), 'Sent');
    expect(historyKindLabel({'kind': 'coinbase', 'net': 4500000000}), 'Mined reward');
    expect(historyAmountLabel({'net': 150000000}), '+1.5 BLOCK');
    expect(historyAmountLabel({'net': -1000000}), '−0.01 BLOCK');
  });

  test('Chain.tx unwraps the explorer envelope', () async {
    final c = fakeChain();
    final t = await c.tx(mined);
    expect(t?['mined'], isTrue);
    expect(t?['height'], 35146);
    expect(t?['confirmations'], 78);
    final m = await c.tx(mempool);
    expect(m?['mined'], isFalse);
    expect(await c.tx(unknown), isNull);
  });

  test('flipTxid reverses byte order and is its own inverse; non-txids pass through', () {
    expect(Chain.flipTxid('f02f46f73613d98ab45de4f3e38c633ba5f1376028d9020a8ced78f366e8d7db'),
        'dbd7e866f378ed8c0a02d9286037f1a53b638ce3f3e45db48ad91336f7462ff0');
    expect(Chain.flipTxid(Chain.flipTxid(mined)), mined);
    expect(Chain.flipTxid('nope'), 'nope');
  });

  test('a txid the node returned (raw order) is found under the explorer spelling', () async {
    final c = fakeChain();
    expect(rawOnlyDisplay, isNot(rawOnly));
    final byRaw = await c.tx(rawOnly);
    expect(byRaw?['mined'], isTrue);
    expect(byRaw?['confirmations'], 2);
    expect(byRaw?['txid'], rawOnlyDisplay);
  });

  test('submit normalises the accepted txid to the explorer spelling', () async {
    final c = fakeChain();
    final res = await c.submit('00');
    expect(res['txid'], Chain.flipTxid(mined));
    expect(res['txidRpc'], mined);
  });

  test('queue status: mined → confirmed, mempool → pending, unknown → not found after grace', () async {
    final c = fakeChain();
    const t0 = 1000000;
    expect(resolveQueueStatus(await c.tx(mined), t0, t0 + 1000), TxQueueStatus.confirmed);
    expect(resolveQueueStatus(await c.tx(mempool), t0, t0 + 60 * 60 * 1000), TxQueueStatus.pending);
    // unknown: pending during the propagation grace window, then not found
    expect(resolveQueueStatus(await c.tx(unknown), t0, t0 + 30 * 1000), TxQueueStatus.pending);
    expect(resolveQueueStatus(await c.tx(unknown), t0, t0 + 10 * 60 * 1000), TxQueueStatus.notFound);
  });
}
