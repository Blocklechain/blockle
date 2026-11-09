// Blockle Liquidity treasury — ONE BLOCK price across currencies, fee intake, swap.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/liquidity/liquidity_pool.dart';

void main() {
  group('single BLOCK price', () {
    test('opens at \$0.001 with a 50k-BLOCK treasury', () {
      final p = LiquidityPool();
      expect(p.blockTreasury, 50000.0);
      expect(p.blockPriceUsd, closeTo(0.001, 1e-12));
    });

    test('fees lift the ONE price uniformly across every currency', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 500, 1.0); // $500 fees => +$0.01 over 50k
      expect(p.blockPriceUsd, closeTo(0.001 + 500 / 50000, 1e-12));
      // BLOCK is worth the SAME in USDC and SOL (no per-pool divergence).
      p.accrueFee('SOL', 90, 90.0);
      final qU = p.quote('BLOCK', 'USDC', 100, 1.0);
      final qS = p.quote('BLOCK', 'SOL', 100, 90.0);
      expect(qU.amountOut * 1.0, closeTo(qS.amountOut * 90.0, 1e-6)); // equal USD value
      expect(qU.blockPriceUsd, closeTo(qS.blockPriceUsd, 1e-12)); // same price
    });
  });

  group('fees + liquidity', () {
    test('a fee adds coin-side reserve; liquidity is reported in USD', () {
      final p = LiquidityPool();
      p.accrueFee('SOL', 9, 90.0); // $9 @ $90 => 0.1 SOL
      expect(p.reserves['SOL'], closeTo(0.1, 1e-9));
      expect(p.availableLiquidityUsd('SOL', 90.0), closeTo(9.0, 1e-6));
      expect(p.totalFeesUsd, 9.0);
    });
  });

  group('bonding curve', () {
    test('buying BLOCK pushes the price UP (~+10% per 1% of treasury)', () {
      final p = LiquidityPool();
      final before = p.blockPriceUsd; // 0.001, treasury 50000 (d0=0)
      // At $0.001/BLOCK, $0.525 buys ~500 BLOCK (1% of the 50k seed).
      final q = p.swap('USDC', 'BLOCK', 0.525, 1.0);
      expect(q.ok, isTrue);
      expect(q.amountOut, closeTo(500, 1e-6)); // walks the curve, not fixed price
      expect(p.blockTreasury, closeTo(49500, 1e-6)); // BLOCK left the treasury
      final after = p.blockPriceUsd;
      expect(after, greaterThan(before));
      expect(after / before, closeTo(1.10, 1e-6)); // steep: +10%
    });

    test('selling BLOCK pushes the price DOWN', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 100, 1.0); // reserve to sell into
      final before = p.blockPriceUsd;
      final q = p.swap('BLOCK', 'USDC', 500, 1.0);
      expect(q.ok, isTrue);
      expect(p.blockTreasury, closeTo(50500, 1e-6)); // BLOCK returned
      expect(p.blockPriceUsd, lessThan(before));
    });

    test('symmetric: a same-size round-trip returns to the start price', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 5000, 1.0);
      final start = p.blockPriceUsd;
      final bought = p.swap('USDC', 'BLOCK', 1.0, 1.0).amountOut; // buy BLOCK
      expect(p.blockPriceUsd, greaterThan(start)); // moved up mid-trade
      final back = p.swap('BLOCK', 'USDC', bought, 1.0).amountOut; // sell it back
      expect(back, closeTo(1.0, 1e-6)); // neutral (no swap fee); fees still ratchet the floor
      expect(p.blockPriceUsd, closeTo(start, 1e-9)); // price returned
    });

    test('swapping a coin with no reserve is refused', () {
      final p = LiquidityPool();
      final q = p.quote('BLOCK', 'DOGE', 10, 0.1);
      expect(q.ok, isFalse);
    });

    test('one side must be BLOCK', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 100, 1.0);
      expect(p.quote('USDC', 'ETH', 10, 1.0).ok, isFalse);
    });
  });

  group('persistence', () {
    test('encode/decode round-trips reserves + treasury + fees', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 250, 1.0);
      final r = LiquidityPool.decode(p.encode());
      expect(r.blockTreasury, closeTo(p.blockTreasury, 1e-9));
      expect(r.reserves['USDC'], closeTo(p.reserves['USDC']!, 1e-9));
      expect(r.totalFeesUsd, closeTo(p.totalFeesUsd, 1e-9));
    });

    test('junk/empty decodes to a fresh 50k treasury', () {
      expect(LiquidityPool.decode(null).blockTreasury, 50000.0);
      expect(LiquidityPool.decode('nope').blockTreasury, 50000.0);
    });
  });
}
