// bch_haskoin_test.dart — the Bitcoin Cash UtxoAdapter speaks the Haskoin REST
// dialect (the public BCH Esplora/Fulcrum hosts are all dead). Verifies the
// three network calls use Haskoin paths + shapes and keep the 'bitcoincash:'
// CashAddr prefix (Esplora strips it; Haskoin requires it).

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/chains/utxo.dart' as u;

void main() {
  const addr = 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6';

  test('bitcoincash network is configured for the haskoin dialect', () {
    expect(u.networks['bitcoincash']!.apiStyle, 'haskoin');
  });

  test('getBalance hits /address/{cashaddr}/balance and reads confirmed sats', () async {
    final seen = <String>[];
    final a = u.UtxoAdapter('bitcoincash', httpGet: (path) async {
      seen.add(path);
      return '{"confirmed":2678203,"unconfirmed":0,"utxo":1,"txs":22,"received":2678203}';
    });
    final bals = await a.getBalance(addr);
    expect(seen.single, '/address/$addr/balance'); // prefix KEPT for Haskoin
    expect(bals.single.confirmed, '2678203');
    expect(bals.single.display, '0.02678203'); // 8 decimals
    expect(bals.single.error, isNull);
  });

  test('utxos hits /address/{cashaddr}/unspent and maps index→vout', () async {
    final seen = <String>[];
    final a = u.UtxoAdapter('bitcoincash', httpGet: (path) async {
      seen.add(path);
      return '[{"txid":"aa","index":0,"value":10000,"pkscript":"76a914..88ac"},'
          '{"txid":"bb","index":3,"value":500}]';
    });
    final utxos = await a.utxos(addr);
    expect(seen.single, '/address/$addr/unspent');
    expect(utxos.length, 2);
    expect(utxos[0], {'txid': 'aa', 'vout': 0, 'value': '10000'});
    expect(utxos[1], {'txid': 'bb', 'vout': 3, 'value': '500'});
  });

  test('a never-seen address (404) reports zero, not unavailable', () async {
    final a = u.UtxoAdapter('bitcoincash', httpGet: (path) async {
      throw StateError('bitcoincash api 404');
    });
    final bals = await a.getBalance(addr);
    expect(bals.single.confirmed, '0');
    expect(bals.single.error, isNull); // unfunded, not an outage
  });
}
