// The flows must refuse BEFORE they move anything.
//
// Every leg of these flows is unavailable in a different, invisible way —
// thin reserves, gated settlement, an asset MoonPay will buy but not sell, a
// missing payout account. A flow that discovers one of those halfway through
// has already sent the user's coins somewhere they did not mean them to go.
//
// So these tests are mostly about REFUSAL, and about refusing with a sentence
// a person can act on rather than "insufficient liquidity".

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/shop/flow.dart';
import 'package:blockle_app/liquidity/liquidity_pool.dart';

SwapQuote good(String a, String b, double inAmt, double outAmt) => SwapQuote(
    ok: true,
    amountIn: inAmt,
    amountOut: outAmt,
    assetIn: a,
    assetOut: b,
    blockPriceUsd: 0.001);

const buyable = {'SOL', 'USDC', 'ETH', 'BTC'};
const sellable = {'USDC', 'ETH', 'BTC'};

void main() {
  group('Get BLOCK', () {
    test('is ready when both legs can run', () {
      final p = MoneyFlow.getBlock(
          usd: 50,
          solToBlock: good('SOL', 'BLOCK', 0.25, 40000),
          blockReserve: 1000000,
          onchainSettlement: true,
          buyEnabled: true,
          buyable: buyable);
      expect(p.ready, isTrue, reason: p.blockers.join(' | '));
    });

    test('is honestly fast — no bank payout anywhere in it', () {
      final p = MoneyFlow.getBlock(
          usd: 50,
          solToBlock: good('SOL', 'BLOCK', 0.25, 40000),
          blockReserve: 1000000,
          onchainSettlement: true,
          buyEnabled: true,
          buyable: buyable);
      expect(p.isSlow, isFalse);
      expect(p.takes.slowest.inHours, lessThan(2));
    });

    test('refuses while liquidity settlement is still in preview', () {
      // THE ONE THAT WOULD HAVE SHIPPED. A ledger-only swap looks identical
      // to a real one from the UI; put it inside a purchase and the user has
      // paid for a number.
      final p = MoneyFlow.getBlock(
          usd: 50,
          solToBlock: good('SOL', 'BLOCK', 0.25, 40000),
          blockReserve: 1000000,
          onchainSettlement: false,
          buyEnabled: true,
          buyable: buyable);
      expect(p.ready, isFalse);
      expect(p.firstBlocker!.reason, contains('preview'));
      expect(p.firstBlocker!.fixable, isFalse);
    });

    test('refuses a swap that would drain the reserve, and says the cap', () {
      final p = MoneyFlow.getBlock(
          usd: 5000,
          solToBlock: good('SOL', 'BLOCK', 25, 900000),
          blockReserve: 1000000, // cap is 25% = 250,000
          onchainSettlement: true,
          buyEnabled: true,
          buyable: buyable);
      expect(p.ready, isFalse);
      final r = p.blockers.map((b) => b.reason).join();
      expect(r, contains('Too large'));
      // The number the user can actually act on has to be in the message.
      expect(r, contains('250000'));
    });

    test('refuses an asset MoonPay will not sell us', () {
      final p = MoneyFlow.getBlock(
          usd: 50,
          solToBlock: good('DOGE', 'BLOCK', 100, 40000),
          blockReserve: 1000000,
          onchainSettlement: true,
          buyEnabled: true,
          buyable: buyable,
          via: 'DOGE');
      expect(p.ready, isFalse);
      expect(p.firstBlocker!.reason, contains('DOGE'));
    });

    test('refuses under the card minimum rather than letting MoonPay do it',
        () {
      final p = MoneyFlow.getBlock(
          usd: 5,
          solToBlock: good('SOL', 'BLOCK', 0.02, 4000),
          blockReserve: 1000000,
          onchainSettlement: true,
          buyEnabled: true,
          buyable: buyable);
      expect(p.ready, isFalse);
      expect(p.firstBlocker!.reason, contains('\$20'));
    });
  });

  group('Pay with BLOCK', () {
    FlowPlan plan({
      bool onchain = true,
      bool sell = true,
      bool bank = true,
      double reserve = 100000,
      Set<String> can = sellable,
    }) =>
        MoneyFlow.payWithBlock(
            usd: 299,
            merchant: 'Example Store',
            blockToCoin: good('BLOCK', 'USDC', 299000, 299),
            coinReserve: reserve,
            onchainSettlement: onchain,
            sellEnabled: sell,
            sellable: can,
            bankConnected: bank);

    test('is ready when every leg can run', () {
      final p = plan();
      expect(p.ready, isTrue, reason: p.blockers.join(' | '));
    });

    test('is NEVER presented as quick — it contains a bank payout', () {
      // The headline ask was a "quick flow". This leg is days, and the plan
      // has to say so rather than let a button call it instant.
      final p = plan();
      expect(p.isSlow, isTrue);
      expect(p.takes.human, contains('day'));
    });

    test('the retail purchase is the user\'s, not ours', () {
      // Non-custodial means Blockle cannot pay the shop. The plan must say
      // out loud that the last step belongs to the user.
      final p = plan();
      final last = p.legs.last;
      expect(last, isA<RetailPurchaseLeg>());
      expect(last.describe, contains('You check out'));
    });

    test('refuses without a MoonPay payout account', () {
      final p = plan(bank: false);
      expect(p.ready, isFalse);
      expect(p.blockers.map((b) => b.reason).join(), contains('bank account'));
    });

    test('refuses an asset that can be bought but not sold', () {
      // Buy and sell are approved separately. Inferring one from the other
      // strands the user at the last leg, holding a coin they cannot cash.
      final p = plan(can: const {'BTC'});
      expect(p.ready, isFalse);
      expect(p.blockers.map((b) => b.reason).join(), contains('USDC'));
    });

    test('reports EVERY blocker, not just the first', () {
      // A user who fixes one thing and immediately hits another has been
      // sent round a loop.
      final p = plan(onchain: false, sell: false, bank: false);
      expect(p.blockers.length, greaterThanOrEqualTo(2));
      expect(p.firstBlocker!.leg, 'Swap');
    });
  });

  group('honesty of the timing text', () {
    test('a bank payout never reads as minutes', () {
      const d = Duration2(Duration(days: 1), Duration(days: 3));
      expect(d.human, '1-3 business days');
    });

    test('two instant legs read as about a minute', () {
      final d = Duration2.instant + Duration2.instant;
      expect(d.human, 'about a minute');
    });
  });
}
