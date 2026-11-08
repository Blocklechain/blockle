// Blockle Liquidity treasury/AMM — the fee→liquidity→swap math.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/liquidity/liquidity_pool.dart';

void main() {
  group('seed + pricing', () {
    test('a new pool opens BLOCK at \$0.001 and draws from the 50k treasury', () {
      final p = LiquidityPool();
      expect(p.blockTreasury, 50000.0);
      p.ensurePool('USDC', 1.0);
      final price = p.blockPriceUsd('USDC', 1.0)!;
      expect(price, closeTo(0.001, 1e-9)); // $0.001 opening
      expect(p.blockTreasury, 50000.0 - kPerPoolSeedBlock); // deployed from treasury
      expect(p.deployedBlock, closeTo(kPerPoolSeedBlock, 1e-9));
    });

    test('seed holds across coins at any coin price (ETH @ \$2000)', () {
      final p = LiquidityPool();
      p.ensurePool('ETH', 2000.0);
      expect(p.blockPriceUsd('ETH', 2000.0)!, closeTo(0.001, 1e-9));
    });

    test('treasury + deployed BLOCK always sums to 50,000', () {
      final p = LiquidityPool();
      p.ensurePool('USDC', 1.0);
      p.ensurePool('SOL', 90.0);
      p.ensurePool('ETH', 2000.0);
      expect(p.blockTreasury + p.deployedBlock, closeTo(50000.0, 1e-6));
    });
  });

  group('fees deepen liquidity + raise BLOCK', () {
    test('accruing a fee adds coin-side reserve and nudges BLOCK price up', () {
      final p = LiquidityPool();
      p.ensurePool('USDC', 1.0);
      final before = p.blockPriceUsd('USDC', 1.0)!;
      p.accrueFee('USDC', 100.0, 1.0); // $100 of fees
      final after = p.blockPriceUsd('USDC', 1.0)!;
      expect(after, greaterThan(before));
      expect(p.availableLiquidityUsd('USDC', 1.0), greaterThan(100.0));
      expect(p.totalFeesUsd, 100.0);
    });

    test('fee below a known price is accrued in base units correctly', () {
      final p = LiquidityPool();
      p.accrueFee('SOL', 9.0, 90.0); // $9 fee at $90/SOL => +0.1 SOL
      final pool = p.pools['SOL']!;
      // seed base + 0.1 SOL
      expect(p.availableLiquidityUsd('SOL', 90.0), closeTo(pool.rBase * 90.0, 1e-9));
    });
  });

  group('swap (constant product)', () {
    test('BLOCK -> USDC returns coin and preserves x*y=k', () {
      final p = LiquidityPool();
      p.ensurePool('USDC', 1.0);
      p.accrueFee('USDC', 1000.0, 1.0); // deepen so there is real liquidity
      final pool = p.pools['USDC']!;
      final kBefore = pool.k;
      final q = p.swap('BLOCK', 'USDC', 100.0, 1.0);
      expect(q.ok, isTrue);
      expect(q.amountOut, greaterThan(0));
      expect(pool.k, closeTo(kBefore, kBefore * 1e-6)); // invariant holds
      expect(pool.rBlock, closeTo(/*seed+100*/ kPerPoolSeedBlock + 100, 1e-6));
    });

    test('a round-trip never PROFITS (zero swap fee => lossless, not a money pump)', () {
      final p = LiquidityPool();
      p.ensurePool('USDC', 1.0);
      p.accrueFee('USDC', 5000.0, 1.0);
      final out = p.swap('BLOCK', 'USDC', 500.0, 1.0).amountOut;
      final back = p.swap('USDC', 'BLOCK', out, 1.0).amountOut;
      expect(back, lessThanOrEqualTo(500.0 + 1e-6)); // can never extract value
      expect(back, closeTo(500.0, 1e-3)); // zero swap fee: recovers the input
    });

    test('swapping a coin with no pool is refused (no fabricated liquidity)', () {
      final p = LiquidityPool();
      final q = p.quote('BLOCK', 'DOGE', 10.0, 0.1);
      expect(q.ok, isFalse);
      expect(q.reason, contains('liquidity'));
    });

    test('one side must be BLOCK', () {
      final p = LiquidityPool();
      p.ensurePool('USDC', 1.0);
      final q = p.quote('USDC', 'ETH', 10.0, 1.0);
      expect(q.ok, isFalse);
    });
  });

  group('persistence', () {
    test('encode/decode round-trips reserves + treasury', () {
      final p = LiquidityPool();
      p.ensurePool('USDC', 1.0);
      p.accrueFee('USDC', 250.0, 1.0);
      final restored = LiquidityPool.decode(p.encode());
      expect(restored.blockTreasury, closeTo(p.blockTreasury, 1e-9));
      expect(restored.pools['USDC']!.rBase, closeTo(p.pools['USDC']!.rBase, 1e-9));
      expect(restored.totalFeesUsd, closeTo(p.totalFeesUsd, 1e-9));
    });

    test('decode of junk/empty yields a fresh 50k treasury', () {
      expect(LiquidityPool.decode(null).blockTreasury, 50000.0);
      expect(LiquidityPool.decode('not json').blockTreasury, 50000.0);
    });
  });
}
