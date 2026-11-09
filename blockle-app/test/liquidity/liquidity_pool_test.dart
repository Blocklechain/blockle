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

  group('swap', () {
    test('BLOCK -> coin pays out at the one price, bounded by the reserve', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 1000, 1.0);
      final q = p.swap('BLOCK', 'USDC', 100, 1.0);
      expect(q.ok, isTrue);
      // 100 BLOCK * $0.001.. / $1 ≈ small USDC amount
      expect(q.amountOut, closeTo(100 * p.blockPriceUsd / 1.0, 1e-6));
      expect(p.blockTreasury, closeTo(50100, 1e-6)); // BLOCK came in
    });

    test('round-trip is lossless (fixed price, never a money pump)', () {
      final p = LiquidityPool();
      p.accrueFee('USDC', 5000, 1.0);
      final out = p.swap('BLOCK', 'USDC', 500, 1.0).amountOut;
      final back = p.swap('USDC', 'BLOCK', out, 1.0).amountOut;
      expect(back, closeTo(500, 1e-6));
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
