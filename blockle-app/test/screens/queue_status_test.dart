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

Chain fakeChain() => Chain(client: MockClient((req) async {
      final p = req.url.path;
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
