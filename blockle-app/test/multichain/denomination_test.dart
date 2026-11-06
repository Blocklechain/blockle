// denomination_test.dart — Task #135: the isBlockDenominated guard. There is NO
// BLOCK/USD oracle, so native BLOCK, every BLOCK-20/BLOCK-20S (incl. USDB) and
// WBLOCK must be flagged (priced in BLOCK, never USD); real-oracle chains must
// NOT be flagged.
import 'package:blockle_app/multichain/denomination.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('native BLOCK is block-denominated (by chain and by symbol)', () {
    expect(isBlockDenominated(chain: 'block', symbol: 'BLOCK'), isTrue);
    expect(isBlockDenominated(symbol: 'BLOCK'), isTrue);
    expect(isBlockDenominated(asset: 'BLOCK'), isTrue);
  });

  test('every BLOCK-20 / BLOCK-20S token is block-denominated by chain', () {
    // chain=='block' tags all BLOCK-20 incl. USDB — no symbol dependence.
    expect(isBlockDenominated(chain: 'block', symbol: 'USDB'), isTrue);
    expect(isBlockDenominated(chain: 'block', symbol: 'WORLD'), isTrue);
    expect(isBlockDenominated(chain: 'BLOCK', symbol: 'ANYTOKEN'), isTrue);
    expect(isBlockDenominated(asset: {'chain': 'block', 'symbol': 'XYZ'}), isTrue);
  });

  test('WBLOCK (Solana wrap) is block-denominated by symbol', () {
    expect(isBlockDenominated(chain: 'solana', symbol: 'WBLOCK'), isTrue);
    expect(isBlockDenominated(asset: {'chain': 'solana', 'symbol': 'WBLOCK'}), isTrue);
  });

  test('real-oracle chains are NOT block-denominated', () {
    expect(isBlockDenominated(chain: 'ethereum', symbol: 'ETH'), isFalse);
    expect(isBlockDenominated(chain: 'solana', symbol: 'SOL'), isFalse);
    expect(isBlockDenominated(chain: 'ethereum', symbol: 'USDC'), isFalse);
    expect(isBlockDenominated(chain: 'ethereum', symbol: 'USDB'), isFalse); // USDB only on block
    expect(isBlockDenominated(asset: {'chain': 'bitcoin', 'symbol': 'BTC'}), isFalse);
    expect(isBlockDenominated(), isFalse);
  });
}
