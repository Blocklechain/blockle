// Multi-leg money flows, stated honestly before anything moves.
//
// Two of the app's headline actions are the SAME LEGS IN OPPOSITE DIRECTIONS:
//
//   Get BLOCK fast   : MoonPay buy SOL  ->  treasury swap SOL -> BLOCK
//   Pay with BLOCK   : treasury swap BLOCK -> coin  ->  MoonPay sell coin
//                      ->  payout to the user's own bank  ->  user buys the item
//
// Writing them as two bespoke screens would mean two copies of the same
// precondition checks, and the copy that was wrong would be the one nobody
// tested. So a flow is a LIST OF LEGS, and every leg can say in advance
// whether it is able to run.
//
// WHY PREFLIGHT IS THE WHOLE POINT
//
// Each leg has a different way of being unavailable, and all of them are
// invisible until you try:
//
//   - the treasury's reserves are finite, and a swap larger than the reserve
//     either fails or fills at a ruinous rate;
//   - treasury settlement is GATED — today a swap updates a reserve ledger
//     and does not move coins on chain (LiquidityService.onchainSettlement);
//   - MoonPay sell is per-asset and per-region, and buy != sell;
//   - a bank payout is days, not seconds.
//
// A flow that discovers any of these halfway through has already taken the
// user's money somewhere they did not intend. So `preflight` runs every check
// up front and returns the FIRST reason it cannot proceed, in words a
// non-technical person can act on.
//
// NOTHING HERE TAKES CUSTODY. Every leg either moves the user's own coins
// between their own addresses, or hands off to MoonPay, who are the merchant
// of record and who pay out to the user's own bank. Blockle never receives,
// holds, or directs the money. That is what keeps this out of money
// transmission, and it is also why the final retail purchase is made by the
// user and not by us.

import '../liquidity/liquidity_pool.dart';

/// Why a leg cannot run. Carries text the UI can show as-is.
class Blocker {
  const Blocker(this.leg, this.reason, {this.fixable = true});

  /// Which leg objected, for the UI to highlight.
  final String leg;

  /// Plain-language reason. Never a code, never an exception string.
  final String reason;

  /// Whether the user can do something about it (top up, pick another asset)
  /// as against it being switched off at our end.
  final bool fixable;

  @override
  String toString() => '$leg: $reason';
}

/// How long a leg takes, so the UI can be honest instead of saying "quick".
///
/// A SHOPPING APP THAT SAYS "BUY" AND MEANS "IN THREE DAYS" IS A BROKEN
/// SHOPPING APP — but saying nothing is worse. Each leg declares its own
/// honest range and the flow sums them.
class Duration2 {
  const Duration2(this.fastest, this.slowest);
  final Duration fastest;
  final Duration slowest;

  Duration2 operator +(Duration2 o) =>
      Duration2(fastest + o.fastest, slowest + o.slowest);

  static const instant = Duration2(Duration.zero, Duration(seconds: 30));

  /// "about a minute" / "1-3 business days". Deliberately vague at the top
  /// end: a precise promise we cannot keep is worse than a range.
  String get human {
    if (slowest.inMinutes < 2) return 'about a minute';
    if (slowest.inHours < 2) return 'up to an hour';
    if (slowest.inDays < 1) return 'a few hours';
    if (fastest.inDays <= 1 && slowest.inDays <= 3) {
      return '1-3 business days';
    }
    return '${fastest.inDays}-${slowest.inDays} days';
  }
}

/// One step of a flow.
abstract class Leg {
  String get name;

  /// A short line describing what this step does, shown in the preview.
  String get describe;

  /// How long this step takes once started.
  Duration2 get takes;

  /// Null when this leg can run; a Blocker when it cannot.
  Blocker? check();
}

/// Buy a coin from MoonPay with a card or bank, delivered to the user's own
/// wallet address. MoonPay is the merchant of record and does the KYC.
class MoonPayBuyLeg implements Leg {
  MoonPayBuyLeg({
    required this.coin,
    required this.usd,
    required this.enabled,
    required this.supportedCoins,
  });

  final String coin;
  final double usd;

  /// From GET /account/api/moonpay/config -> features.buy.
  final bool enabled;
  final Set<String> supportedCoins;

  @override
  String get name => 'Buy $coin';

  @override
  String get describe =>
      'MoonPay sells you \$${usd.toStringAsFixed(2)} of $coin, straight to '
      'your own wallet.';

  // Card buys land in minutes; bank-funded ones can take longer. Quoting the
  // card case alone would make every slower purchase feel broken.
  @override
  Duration2 get takes =>
      const Duration2(Duration(minutes: 2), Duration(minutes: 40));

  @override
  Blocker? check() {
    if (!enabled) {
      return const Blocker('Buy', 'Buying crypto is unavailable right now.',
          fixable: false);
    }
    if (!supportedCoins.contains(coin.toUpperCase())) {
      return Blocker('Buy', '$coin cannot be bought here.', fixable: false);
    }
    if (usd <= 0) return const Blocker('Buy', 'Enter an amount first.');
    // MoonPay enforces its own floor and rejects below it with a generic
    // error, so catch it here where we can say which number is wrong.
    if (usd < 20) {
      return const Blocker('Buy', 'Card purchases start at \$20.');
    }
    return null;
  }
}

/// Swap one asset for another against the in-wallet liquidity treasury.
class TreasurySwapLeg implements Leg {
  TreasurySwapLeg({
    required this.from,
    required this.to,
    required this.amountIn,
    required this.quote,
    required this.reserveOut,
    required this.onchainSettlement,
  });

  final String from;
  final String to;
  final double amountIn;

  /// LiquidityService.quote(from, to, amountIn).
  final SwapQuote quote;

  /// Units of `to` the treasury actually holds.
  final double reserveOut;

  /// LiquidityService.onchainSettlement — false means the swap updates a
  /// ledger and does NOT move coins.
  final bool onchainSettlement;

  /// Never spend more than this share of a reserve in one swap. Draining a
  /// pool to the floor gives the last user a terrible rate and leaves the
  /// next one with nothing.
  static const double maxReserveShare = 0.25;

  @override
  String get name => 'Swap $from to $to';

  @override
  String get describe =>
      'Swap ${amountIn.toStringAsFixed(4)} $from for $to against Blockle '
      'Liquidity.';

  @override
  Duration2 get takes => Duration2.instant;

  @override
  Blocker? check() {
    // THE GATE THAT MATTERS MOST. Settlement being off means a swap moves a
    // number and not a coin — fine for a preview screen the user understands,
    // disqualifying for a step inside a purchase.
    if (!onchainSettlement) {
      return const Blocker(
          'Swap',
          'Blockle Liquidity is still in preview — swaps do not settle on '
              'chain yet, so they cannot be part of a purchase.',
          fixable: false);
    }
    if (!quote.ok) {
      return Blocker('Swap', quote.reason ?? 'This swap is not available.');
    }
    if (quote.amountOut <= 0) {
      return const Blocker('Swap', 'That amount is too small to swap.');
    }
    if (reserveOut <= 0) {
      return Blocker('Swap', 'Blockle Liquidity holds no $to right now.',
          fixable: false);
    }
    // THE LIQUIDITY CHECK. Stated as a number the user can act on rather than
    // "insufficient liquidity", which tells them nothing about what WOULD
    // work.
    final cap = reserveOut * maxReserveShare;
    if (quote.amountOut > cap) {
      return Blocker(
          'Swap',
          'Too large for current liquidity — the most you can swap for right '
              'now is about ${cap.toStringAsFixed(4)} $to.');
    }
    return null;
  }
}

/// Sell a coin to MoonPay for fiat, paid out to the user's OWN bank account.
class MoonPaySellLeg implements Leg {
  MoonPaySellLeg({
    required this.coin,
    required this.amount,
    required this.enabled,
    required this.supportedCoins,
    required this.bankConnected,
  });

  final String coin;
  final double amount;

  /// From features.sell.
  final bool enabled;
  final Set<String> supportedCoins;

  /// Whether the user has a payout destination set up WITH MOONPAY. Not with
  /// us — we never see their bank.
  final bool bankConnected;

  @override
  String get name => 'Sell $coin';

  @override
  String get describe =>
      'MoonPay buys your $coin and pays the cash into your own bank account.';

  // THE SLOW LEG, and the reason this whole flow cannot be called instant.
  @override
  Duration2 get takes =>
      const Duration2(Duration(days: 1), Duration(days: 3));

  @override
  Blocker? check() {
    if (!enabled) {
      return const Blocker('Sell', 'Selling crypto is unavailable right now.',
          fixable: false);
    }
    // Buy and sell are approved separately and per asset; assuming one from
    // the other is how a flow dies at its last step.
    if (!supportedCoins.contains(coin.toUpperCase())) {
      return Blocker('Sell', '$coin cannot be sold for cash here.',
          fixable: false);
    }
    if (!bankConnected) {
      return const Blocker(
          'Sell', 'Add a bank account with MoonPay to receive the cash.');
    }
    if (amount <= 0) return const Blocker('Sell', 'Nothing to sell.');
    return null;
  }
}

/// The user buys the item from the retailer, with their own money.
///
/// DELIBERATELY NOT AUTOMATED. Blockle never holds the funds, so Blockle
/// cannot pay the shop — and should not pretend to. This leg exists so the
/// preview tells the whole truth about what the user will have to do.
class RetailPurchaseLeg implements Leg {
  RetailPurchaseLeg({required this.merchant, required this.usd});

  final String merchant;
  final double usd;

  @override
  String get name => 'Buy from $merchant';

  @override
  String get describe =>
      'You check out at $merchant for \$${usd.toStringAsFixed(2)}. Blockle '
      'fills in your details and tracks the order.';

  @override
  Duration2 get takes => Duration2.instant;

  @override
  Blocker? check() => usd <= 0
      ? const Blocker('Buy', 'This item has no price yet.')
      : null;
}

/// What a flow will do, whether it can, and how long it takes.
class FlowPlan {
  const FlowPlan(this.title, this.legs, this.blockers);

  final String title;
  final List<Leg> legs;

  /// Every reason this cannot run, in leg order. Empty means ready.
  final List<Blocker> blockers;

  bool get ready => blockers.isEmpty;

  /// The first thing standing in the way — what the button should say.
  Blocker? get firstBlocker => blockers.isEmpty ? null : blockers.first;

  Duration2 get takes =>
      legs.fold(const Duration2(Duration.zero, Duration.zero),
          (a, l) => a + l.takes);

  /// True when any leg takes more than a few minutes. The UI must not call
  /// such a flow "instant" however much we would like it to.
  bool get isSlow => takes.slowest.inHours >= 2;
}

/// Build and check a flow.
class MoneyFlow {
  /// Buy SOL with a card, then swap it to BLOCK against the treasury.
  ///
  /// Fast on purpose: both legs are minutes, neither touches a bank payout.
  /// This is the one flow in the app that can honestly be called quick.
  static FlowPlan getBlock({
    required double usd,
    required SwapQuote solToBlock,
    required double blockReserve,
    required bool onchainSettlement,
    required bool buyEnabled,
    required Set<String> buyable,
    String via = 'SOL',
  }) {
    final legs = <Leg>[
      MoonPayBuyLeg(
          coin: via, usd: usd, enabled: buyEnabled, supportedCoins: buyable),
      TreasurySwapLeg(
          from: via,
          to: 'BLOCK',
          amountIn: solToBlock.amountIn,
          quote: solToBlock,
          reserveOut: blockReserve,
          onchainSettlement: onchainSettlement),
    ];
    return FlowPlan('Get BLOCK', legs, _check(legs));
  }

  /// Turn BLOCK into cash in the user's bank so they can buy something.
  ///
  /// NOT QUICK, and the plan says so: the sell leg is a bank payout. The UI
  /// should present this as "top up your bank" rather than as a checkout
  /// button, because a shopper who presses Buy and waits three days has been
  /// misled by the word.
  static FlowPlan payWithBlock({
    required double usd,
    required String merchant,
    required SwapQuote blockToCoin,
    required double coinReserve,
    required bool onchainSettlement,
    required bool sellEnabled,
    required Set<String> sellable,
    required bool bankConnected,
    String via = 'USDC',
  }) {
    final legs = <Leg>[
      TreasurySwapLeg(
          from: 'BLOCK',
          to: via,
          amountIn: blockToCoin.amountIn,
          quote: blockToCoin,
          reserveOut: coinReserve,
          onchainSettlement: onchainSettlement),
      MoonPaySellLeg(
          coin: via,
          amount: blockToCoin.amountOut,
          enabled: sellEnabled,
          supportedCoins: sellable,
          bankConnected: bankConnected),
      RetailPurchaseLeg(merchant: merchant, usd: usd),
    ];
    return FlowPlan('Pay with BLOCK', legs, _check(legs));
  }

  /// EVERY leg, not just up to the first failure: a user told to fix one
  /// thing, who then hits a second, has been sent round a loop. Order is
  /// preserved so the UI can lead with the first.
  static List<Blocker> _check(List<Leg> legs) {
    final out = <Blocker>[];
    for (final l in legs) {
      final b = l.check();
      if (b != null) out.add(b);
    }
    return out;
  }
}
