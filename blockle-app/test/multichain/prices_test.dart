// prices_test.dart — the CoinGecko-backed USD price service. Verifies the two
// lookups (native by id, token by contract), stable pinning, the never-price-
// BLOCK rule, and that unresolved assets are simply absent (never a guessed 0).

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/chains/chain_adapter.dart';
import 'package:blockle_app/multichain/prices.dart';

AssetRef native(String chain, String sym) =>
    AssetRef(chain: chain, kind: 'native', symbol: sym, decimals: 18);
AssetRef token(String chain, String sym, String addr, {String kind = 'erc20'}) =>
    AssetRef(chain: chain, kind: kind, symbol: sym, decimals: 6, address: addr);

void main() {
  test('prices natives by id, tokens by contract; stables pinned; BLOCK skipped',
      () async {
    final seen = <String>[];
    final svc = PriceService(get: (url) async {
      seen.add(url);
      if (url.contains('/simple/price')) {
        return '{"ethereum":{"usd":2232.97},"bitcoin":{"usd":75735}}';
      }
      if (url.contains('/token_price/ethereum')) {
        // contract echoed lower-case, as CoinGecko does
        return '{"0xdeadbeef":{"usd":1.23}}';
      }
      return '{}';
    });

    final assets = [
      native('ethereum', 'ETH'),
      native('bitcoin', 'BTC'),
      token('ethereum', 'FOO', '0xDEADBEEF'),
      token('ethereum', 'USDC', '0xA0b0'), // stable → pinned, no call
      // BLOCK-denominated: must NEVER be priced.
      native('block', 'BLOCK'),
      AssetRef(chain: 'block', kind: 'block20', symbol: 'USDB', decimals: 8, address: 'abc'),
      // unknown native (no id) → absent
      native('ethereum', 'ZZZ'),
    ];

    final usd = await svc.fetchUsd(assets, nowMs: 1000);

    expect(usd[priceKey(native('ethereum', 'ETH'))], 2232.97);
    expect(usd[priceKey(native('bitcoin', 'BTC'))], 75735);
    expect(usd[priceKey(token('ethereum', 'FOO', '0xDEADBEEF'))], 1.23);
    expect(usd[priceKey(token('ethereum', 'USDC', '0xA0b0'))], 1.0);
    // BLOCK + BLOCK-20 never priced:
    expect(usd.containsKey(priceKey(native('block', 'BLOCK'))), isFalse);
    expect(usd.keys.any((k) => k.startsWith('block:')), isFalse);
    // Unknown symbol absent (never 0):
    expect(usd.containsKey(priceKey(native('ethereum', 'ZZZ'))), isFalse);
  });

  test('network failure is best-effort — returns stables, never throws', () async {
    final svc = PriceService(get: (_) async => throw StateError('offline'));
    final usd = await svc.fetchUsd([
      native('ethereum', 'ETH'),
      token('ethereum', 'USDC', '0xA0b0'),
    ]);
    expect(usd[priceKey(token('ethereum', 'USDC', '0xA0b0'))], 1.0); // pinned
    expect(usd.containsKey(priceKey(native('ethereum', 'ETH'))), isFalse); // no guess
  });

  test('second call within TTL serves cache (no new network hit)', () async {
    var calls = 0;
    final svc = PriceService(get: (url) async {
      calls++;
      return '{"ethereum":{"usd":100}}';
    });
    await svc.fetchUsd([native('ethereum', 'ETH')], nowMs: 0);
    await svc.fetchUsd([native('ethereum', 'ETH')], nowMs: 1000); // < 2min TTL
    expect(calls, 1);
  });
}
