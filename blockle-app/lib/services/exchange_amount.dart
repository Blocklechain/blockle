// services/exchange_amount.dart — the venue's decimal arithmetic, in Dart.
//
// A PORT OF exchange/custody/src/amount.ts, AND IT HAS TO BE EXACT. Every
// figure on the trade screen — the price the ladder fills in, the order value
// the minimum is checked against, the fee estimate, the amount that goes on the
// wire — is money on a live custodial venue, and the server does all of it in
// `bigint` base units. A client that does the same sum in a `double` disagrees
// with the venue about someone's order: `0.1 * 3` is `0.30000000000000004`, and
// an 18-decimal amount does not fit in a double at all (2^53 base units is
// 0.009 of one whole 18-decimal token).
//
// So nothing here uses a double. Amounts are [BigInt] counts of an asset's
// smallest unit, and a decimal string exists at exactly two edges: [exParse]
// where the user types one, and [exFormat] where one is shown.
//
// THE TRAP THIS FILE EXISTS FOR IS `priceDecimals`.
//
// A PRICE IS NOT A QUOTE-ASSET AMOUNT. The venue defines a price as "quote base
// units per ONE WHOLE unit of base, times 10^priceDecimals" (venue.ts:24), and
// `priceDecimals` is PER MARKET: it is 0 for the twelve USDT and twelve BLOCK
// markets that predate the quote expansion, and 1, 2, 4, 5 or 8 for the BTC- and
// USDC-quoted ones, because one satoshi is worth more than one whole PERBUG and
// at `priceDecimals: 0` that price could not be written down at all. The server
// scales a submitted price by `priceScale(m) = quoteDecimals + priceDecimals`
// (publicapi.ts:821) — so a client that scales by the quote's decimals alone
// renders a PERBUG-BTC price 10^8 times too large and submits one 10^8 times
// too small, with no error from either side. [ExchangeMarket.priceScale] is the
// only scale a price may be parsed or rendered at, and it is published by the
// venue precisely because a client cannot derive it.
//
// REJECT, NEVER ROUND. [exParse] refuses input finer-grained than the asset
// rather than truncating it, which is the server's own decision and for the same
// reason: an exchange that rounds user input decides, invisibly, to keep or give
// away the remainder.

library;

import 'exchange_client.dart' show ExchangeMarket, OrderBook;

/// A refusal with a sentence a person can act on. Thrown, not returned, so a
/// caller cannot use a half-parsed amount by forgetting to check.
class ExAmountError implements Exception {
  const ExAmountError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// The server's ceiling (amount.ts `MAX_DECIMALS`). A scale beyond this is a
/// bad market definition, not a user error.
const int kMaxExDecimals = 36;

final BigInt _ten = BigInt.from(10);

/// `^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$` — the server's own grammar.
/// Exponent form is accepted because a `double.toString()` upstream produces it
/// (`1.2e-7` for a live BLOCK-quoted price) and refusing it would turn a
/// correct figure into an error.
final RegExp _decimal = RegExp(r'^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$');

/// Parse a decimal string into base units at [decimals] places.
///
/// Throws [ExAmountError] with a reason: empty, not a number, or finer-grained
/// than the asset. [symbol] appears in that reason, which is the only thing it
/// is for.
BigInt exParse(String input, {required String symbol, required int decimals}) {
  if (decimals < 0 || decimals > kMaxExDecimals) {
    throw ExAmountError('$symbol has an impossible scale ($decimals places)');
  }
  final s = input.trim();
  if (s.isEmpty) throw const ExAmountError('nothing entered');
  final m = _decimal.firstMatch(s);
  if (m == null) throw ExAmountError('"$input" is not a number');

  final sign = m.group(1) ?? '';
  final intPart = m.group(2) ?? '';
  final fracPart = m.group(3) ?? '';
  if (intPart.isEmpty && fracPart.isEmpty) {
    throw ExAmountError('"$input" has no digits');
  }
  final expText = m.group(4);
  final exp = expText == null ? 0 : int.tryParse(expText);
  if (exp == null || exp.abs() > kMaxExDecimals * 4) {
    throw ExAmountError('"$input" has an exponent out of range');
  }

  // All the digits, with the point's position tracked separately, so the shift
  // is exact integer work rather than floating-point scaling.
  final digits = BigInt.parse(intPart + fracPart);
  final scale = fracPart.length - exp;

  BigInt base;
  if (scale <= decimals) {
    base = digits * _ten.pow(decimals - scale);
  } else {
    // Finer than the asset. Acceptable only when what would be discarded is
    // exactly zero — "1.50" at 1 decimal is 1.5, "1.55" is a refusal.
    final divisor = _ten.pow(scale - decimals);
    if (digits % divisor != BigInt.zero) {
      throw ExAmountError(
        '$symbol goes to $decimals decimal '
        '${decimals == 1 ? 'place' : 'places'}; "$input" needs more and would '
        'lose value',
      );
    }
    base = digits ~/ divisor;
  }
  return sign == '-' ? -base : base;
}

/// Base units back to an exact decimal string. Never exponential, never a
/// float's 17 digits, and trailing zeros dropped — the server's `format()`.
String exFormat(BigInt base, int decimals) {
  final neg = base.isNegative;
  final abs = neg ? -base : base;
  final unit = _ten.pow(decimals < 0 ? 0 : decimals);
  final whole = abs ~/ unit;
  final frac = abs % unit;
  String out;
  if (decimals <= 0) {
    out = whole.toString();
  } else {
    // Drop only TRAILING zeros: "1.50" and "1.5" are the same number, "1.05"
    // and "1.5" are not.
    var f = frac.toString().padLeft(decimals, '0');
    while (f.endsWith('0')) {
      f = f.substring(0, f.length - 1);
    }
    out = f.isEmpty ? whole.toString() : '$whole.$f';
  }
  return neg && abs != BigInt.zero ? '-$out' : out;
}

// --------------------------------------------------------------- per market

/// A PRICE on [m], at [ExchangeMarket.priceScale] — not at the quote's
/// decimals. See the header.
BigInt exParsePrice(ExchangeMarket m, String text) =>
    exParse(text, symbol: '${m.pair} price', decimals: m.priceScale);

/// An ORDER SIZE on [m], in whole units of the base asset.
BigInt exParseBase(ExchangeMarket m, String text) =>
    exParse(text, symbol: m.base, decimals: m.baseDecimals);

/// An amount of the QUOTE asset (a notional, a balance, a minimum).
BigInt exParseQuote(ExchangeMarket m, String text) =>
    exParse(text, symbol: m.quote, decimals: m.quoteDecimals);

/// Render a price on [m] exactly as the venue would.
String exFormatPrice(ExchangeMarket m, BigInt price) =>
    exFormat(price, m.priceScale);

/// THE MID OF A TWO-SIDED BOOK, in integers, or null when there is no mid.
///
/// [OrderBook.mid] averages two `num`s, and that is a double. It is fine for a
/// spread PERCENTAGE — a ratio to two decimal places, which is a summary — and
/// it is not fine for the figure the spread row prints beside a quote ticker,
/// because that reads as a price. DINGO-BTC has `priceScale` 16 and its levels
/// are around 1e-16, where a double has no digits left to be right with: the
/// average of two adjacent ticks comes out as a float artefact rendered to
/// sixteen decimal places, every one of which looks like information.
///
/// So the mid is taken from the venue's OWN price strings when it sent them,
/// and the division truncates, exactly as the server's `bigint` division does
/// everywhere else. Null when either side is empty — a one-sided book has no
/// mid, and inventing one from the single side would be a made-up number — and
/// null, rather than a float, when the strings are missing, because a mid we
/// cannot compute exactly is one the row should show as unavailable.
BigInt? exBookMid(ExchangeMarket m, OrderBook b) {
  if (b.bids.isEmpty || b.asks.isEmpty) return null;
  final bidText = b.bids.first.priceText;
  final askText = b.asks.first.priceText;
  if (bidText == null || askText == null) return null;
  try {
    final bid = exParsePrice(m, bidText);
    final ask = exParsePrice(m, askText);
    if (bid <= BigInt.zero || ask <= BigInt.zero) return null;
    return (bid + ask) ~/ BigInt.two;
  } on ExAmountError catch (_) {
    return null;
  }
}

/// What an order is WORTH, in quote base units — the venue's `quoteFor()`
/// (venue.ts:643), integer-for-integer.
///
///     quote = baseAmount * price / 10^(baseDecimals + priceDecimals)
///
/// The division truncates, exactly as the server's `bigint` division does, so
/// the figure shown is the figure the `minNotional` check will see.
BigInt exQuoteFor({
  required BigInt baseAmount,
  required BigInt price,
  required int baseDecimals,
  required int priceDecimals,
}) =>
    (baseAmount * price) ~/ _ten.pow(baseDecimals + priceDecimals);

/// A fee of [bps] basis points on what a side RECEIVES, truncated.
///
/// Truncated, not rounded, and that direction is deliberate on the server:
/// "rounding favours the customer, always" (fees.ts:23) — a sub-unit remainder
/// stays with the trader. Showing a rounded-up estimate here would overstate
/// what the venue takes.
BigInt exFeeUnits(BigInt received, int bps) =>
    (received * BigInt.from(bps)) ~/ BigInt.from(10000);

// ------------------------------------------------------------- the ticket

/// Everything the order ticket needs to say, computed once in integers.
///
/// A CLASS RATHER THAN SIX FUNCTIONS CALLED FROM `build()` because the figures
/// have to agree with each other: the order value the fee is taken from must be
/// the same order value the `minNotional` check used, and the two minimums must
/// be checked against the same parse of the same two fields. Splitting that
/// across a widget tree is how a screen ends up reporting "below the minimum"
/// beside a value that is above it.
class ExTicketQuote {
  const ExTicketQuote._({
    required this.market,
    required this.buying,
    this.priceError,
    this.amountError,
    this.price,
    this.amount,
    this.notional,
    this.feeUnits,
    this.feeAsset,
    this.feeDecimals,
    this.receiveUnits,
    this.receiveAsset,
    this.receiveDecimals,
    this.belowMinBase = false,
    this.belowMinNotional = false,
    this.spendUnits,
  });

  final ExchangeMarket market;
  final bool buying;

  /// Why the typed price or amount is not a number the venue would take. Null
  /// when the field parsed.
  final String? priceError;
  final String? amountError;

  /// Price in `10^priceScale` units, size in base units — both null when the
  /// corresponding field did not parse.
  final BigInt? price;
  final BigInt? amount;

  /// The order's value in quote base units, or null when either field is bad.
  final BigInt? notional;

  /// The estimated fee, IN THE ASSET IT IS TAKEN FROM — which is the asset the
  /// side receives (base on a buy, quote on a sell), because that is how the
  /// venue charges it.
  final BigInt? feeUnits;
  final String? feeAsset;
  final int? feeDecimals;

  /// What lands in the account after the fee, in the asset received.
  final BigInt? receiveUnits;
  final String? receiveAsset;
  final int? receiveDecimals;

  /// The venue's two floors, each reported on its own. SHOWING ONLY ONE SENDS
  /// SOMEONE TO FIX THE WRONG CONSTRAINT: an order can clear `minBase` and be
  /// refused by `minNotional` (venue.ts:1096), and the error that comes back
  /// names only the one that tripped.
  final bool belowMinBase;
  final bool belowMinNotional;

  /// What would leave the available balance, in the asset being spent — the
  /// quote on a buy, the base on a sell.
  final BigInt? spendUnits;

  bool get priced => price != null && amount != null;

  /// The asset whose available balance this order spends.
  String get spendAsset => buying ? market.quote : market.base;
  int get spendDecimals => buying ? market.quoteDecimals : market.baseDecimals;

  /// True when every check this client can make passes. The venue still has
  /// the last word — this is not a promise, it is the refusals we can predict.
  bool get submittable =>
      priced &&
      !belowMinBase &&
      !belowMinNotional &&
      market.open &&
      (price ?? BigInt.zero) > BigInt.zero &&
      (amount ?? BigInt.zero) > BigInt.zero;

  /// Build the quote. [takerBps] null means the fee schedule has not been read,
  /// and the fee then renders as unknown rather than as zero.
  factory ExTicketQuote.of({
    required ExchangeMarket market,
    required bool buying,
    required String priceText,
    required String amountText,
    int? takerBps,
  }) {
    BigInt? price;
    String? priceError;
    try {
      price = exParsePrice(market, priceText);
      if (price <= BigInt.zero) {
        price = null;
        priceError = 'a price must be greater than zero';
      }
    } on ExAmountError catch (e) {
      priceError = e.message;
    }

    BigInt? amount;
    String? amountError;
    try {
      amount = exParseBase(market, amountText);
      if (amount <= BigInt.zero) {
        amount = null;
        amountError = 'an amount must be greater than zero';
      }
    } on ExAmountError catch (e) {
      amountError = e.message;
    }

    if (price == null || amount == null) {
      return ExTicketQuote._(
        market: market,
        buying: buying,
        priceError: priceError,
        amountError: amountError,
        price: price,
        amount: amount,
      );
    }

    final notional = exQuoteFor(
      baseAmount: amount,
      price: price,
      baseDecimals: market.baseDecimals,
      priceDecimals: market.priceDecimals,
    );

    // The minimums, each parsed at ITS OWN scale: `minBase` is a base amount,
    // `minNotional` is a quote amount. A failed parse of a venue-published
    // minimum is treated as "no floor published" rather than as zero, because
    // claiming an order clears a floor we could not read would be a guess.
    var belowBase = false;
    final minBase = market.minBase;
    if (minBase != null && minBase.isNotEmpty) {
      try {
        belowBase = amount < exParseBase(market, minBase);
      } on ExAmountError catch (_) {}
    }
    var belowNotional = false;
    final minNotional = market.minNotional;
    if (minNotional != null && minNotional.isNotEmpty) {
      try {
        belowNotional = notional < exParseQuote(market, minNotional);
      } on ExAmountError catch (_) {}
    }

    // THE FEE IS TAKEN FROM WHAT YOU RECEIVE, in that asset (fees.ts:90-99,
    // and /public/fees says so in words). A buyer receives base and pays the
    // fee in base; a seller receives quote and pays it in quote. Quoting it in
    // the other asset would be a different number about a different thing.
    final received = buying ? amount : notional;
    final fee = takerBps == null ? null : exFeeUnits(received, takerBps);

    return ExTicketQuote._(
      market: market,
      buying: buying,
      price: price,
      amount: amount,
      notional: notional,
      feeUnits: fee,
      feeAsset: buying ? market.base : market.quote,
      feeDecimals: buying ? market.baseDecimals : market.quoteDecimals,
      receiveUnits: fee == null ? received : received - fee,
      receiveAsset: buying ? market.base : market.quote,
      receiveDecimals: buying ? market.baseDecimals : market.quoteDecimals,
      belowMinBase: belowBase,
      belowMinNotional: belowNotional,
      spendUnits: buying ? notional : amount,
    );
  }

  /// The order value as a decimal string, or null when it cannot be computed.
  String? get notionalText =>
      notional == null ? null : exFormat(notional!, market.quoteDecimals);

  String? get feeText => feeUnits == null || feeDecimals == null
      ? null
      : exFormat(feeUnits!, feeDecimals!);

  String? get receiveText => receiveUnits == null || receiveDecimals == null
      ? null
      : exFormat(receiveUnits!, receiveDecimals!);

  String? get spendText =>
      spendUnits == null ? null : exFormat(spendUnits!, spendDecimals);
}
