// Tests for services/exchange_amount.dart — the venue's decimal arithmetic.
//
// WHY THIS FILE IS GOLDEN VECTORS AND NOT HAND-REASONED EXPECTATIONS.
//
// Every number below was produced by running the SERVER'S OWN COMPILED CODE —
// `parse`, `format` and `applyFeeBps` from exchange/custody/dist/src/amount.js
// and `quoteFor`/`priceScale` from dist/src/venue.js — over real listed markets.
// A test that asserted what I believe the arithmetic should be would pass
// against a Dart port that is wrong in the same way as my belief. These assert
// what the venue actually computes, so the port cannot drift from it quietly.
//
// THE BUG CLASS BEING PINNED IS `priceDecimals`.
//
// A price is quote base units per ONE WHOLE unit of base, times
// 10^priceDecimals, and `priceDecimals` is per market. A client that scales a
// price by the quote's decimals alone is wrong by that power of ten — and wrong
// in OPPOSITE DIRECTIONS on the way in and the way out, so it renders a price
// 10^priceDecimals too large and submits one 10^priceDecimals too small, with
// no error from either end. DINGO-USDT below is the live case: priceDecimals 5,
// so a price parsed at `quoteDecimals` (6) instead of `priceScale` (11) comes
// out as 1 base unit where the venue reads 123,000 — a misprice of 100,000x on
// a market that takes real money.
//
// ONE CASE PER BASE-DECIMAL CLASS, because those are the four shapes the venue
// actually lists (confirmed against /public/markets: baseDecimals is 6, 8, 9 or
// 18 and nothing else) and because 18 is the one that cannot be done in a
// double at all — 2^53 base units of an 18-decimal asset is 0.009 of one token,
// so `0.000000000000000001 ETH` is not representable and the only correct
// answer comes from integers.

import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/services/exchange_amount.dart';
import 'package:blockle_app/services/exchange_client.dart';

/// A market in exactly the shape `/public/markets` publishes one.
///
/// `priceScale` is passed EXPLICITLY, as the venue publishes it, rather than
/// left to the model's fallback — this is the field the whole file is about and
/// a test that let it be derived would not be testing that it is read.
ExchangeMarket _m({
  required String base,
  required String quote,
  required int bd,
  required int qd,
  required int pd,
  String? minBase,
  String? minNotional,
  String? closed,
}) =>
    ExchangeMarket(
      id: '$base-$quote',
      base: base,
      quote: quote,
      baseDecimals: bd,
      quoteDecimals: qd,
      priceDecimals: pd,
      priceScale: qd + pd,
      minBase: minBase,
      minNotional: minNotional,
      closed: closed,
    );

/// One golden row: the venue's own figures for a real order on a real market.
class _Vector {
  const _Vector({
    required this.market,
    required this.priceText,
    required this.amountText,
    required this.priceUnits,
    required this.amountUnits,
    required this.notionalUnits,
    required this.notionalText,
    required this.buyFeeText,
    required this.sellFeeText,
    required this.sellNetText,
  });
  final ExchangeMarket market;
  final String priceText;
  final String amountText;
  final String priceUnits;
  final String amountUnits;
  final String notionalUnits;
  final String notionalText;
  final String buyFeeText;
  final String sellFeeText;
  final String sellNetText;
}

/// 20 bps, the venue's live taker rate off /public/fees at the time these were
/// generated. The RATE is not what is being pinned — the truncation is.
const int _bps = 20;

final List<_Vector> _vectors = [
  // ---- 6-DECIMAL BASE. TRX-USDT, priceDecimals 0, priceScale 6.
  _Vector(
    market: _m(base: 'TRX', quote: 'USDT', bd: 6, qd: 6, pd: 0,
        minBase: '1', minNotional: '5'),
    priceText: '0.2871',
    amountText: '1500',
    priceUnits: '287100',
    amountUnits: '1500000000',
    notionalUnits: '430650000',
    notionalText: '430.65',
    buyFeeText: '3',
    sellFeeText: '0.8613',
    sellNetText: '429.7887',
  ),
  // ---- 8-DECIMAL BASE. RTM-USDT, priceDecimals 0, priceScale 6.
  _Vector(
    market: _m(base: 'RTM', quote: 'USDT', bd: 8, qd: 6, pd: 0,
        minBase: '10', minNotional: '5'),
    priceText: '0.012345',
    amountText: '1000',
    priceUnits: '12345',
    amountUnits: '100000000000',
    notionalUnits: '12345000',
    notionalText: '12.345',
    buyFeeText: '2',
    sellFeeText: '0.02469',
    sellNetText: '12.32031',
  ),
  // ---- 9-DECIMAL BASE. SOL-USDT. Closed to new orders, which changes nothing
  // about the arithmetic: a closed market keeps its book and its history, and
  // the ladder still has to render its prices correctly.
  _Vector(
    market: _m(base: 'SOL', quote: 'USDT', bd: 9, qd: 6, pd: 0,
        minBase: '0.001', minNotional: '5',
        closed: 'SOL settlement is paused.'),
    priceText: '142.5',
    amountText: '0.123456789',
    priceUnits: '142500000',
    amountUnits: '123456789',
    // TRUNCATED, not rounded: the exact product is 17.5925924...  and the
    // venue's bigint division drops the remainder. 17.592593 would be a
    // different (and wrong) sixth decimal place.
    notionalUnits: '17592592',
    notionalText: '17.592592',
    buyFeeText: '0.000246913',
    sellFeeText: '0.035185',
    sellNetText: '17.557407',
  ),
  // ---- 18-DECIMAL BASE. ETH-BLOCK, one wei of ETH.
  //
  // THE CASE A DOUBLE CANNOT DO. One base unit of an 18-decimal asset priced
  // at 3,100,000 BLOCK notionals to LESS THAN ONE BLOCK base unit, so the
  // venue's truncating division returns 0 — the order is worth nothing it can
  // settle, and `minNotional` is what refuses it. A float path would produce
  // some tiny non-zero figure here and show a value the venue does not agree
  // exists.
  _Vector(
    market: _m(base: 'ETH', quote: 'BLOCK', bd: 18, qd: 8, pd: 0,
        minBase: '0.00001', minNotional: '0.05'),
    priceText: '3100000',
    amountText: '0.000000000000000001',
    priceUnits: '310000000000000',
    amountUnits: '1',
    notionalUnits: '0',
    notionalText: '0',
    buyFeeText: '0',
    sellFeeText: '0',
    sellNetText: '0',
  ),
  // ---- THE priceDecimals CASES, which are the point of the file.
  //
  // DINGO-USDT: priceDecimals 5 on a 6-decimal quote, so priceScale is 11. Parse
  // this price at the quote's decimals and you get 1 unit instead of 123,000.
  _Vector(
    market: _m(base: 'DINGO', quote: 'USDT', bd: 8, qd: 6, pd: 5,
        minBase: '1000', minNotional: '5'),
    priceText: '0.00000123',
    amountText: '5000',
    priceUnits: '123000',
    amountUnits: '500000000000',
    notionalUnits: '6150',
    notionalText: '0.00615',
    buyFeeText: '10',
    sellFeeText: '0.000012',
    sellNetText: '0.006138',
  ),
  // DINGO-BTC: priceDecimals 8 on an 8-decimal quote — priceScale 16, the
  // venue's widest. One satoshi is worth more than one whole DINGO, which is
  // the reason priceDecimals exists at all.
  _Vector(
    market: _m(base: 'DINGO', quote: 'BTC', bd: 8, qd: 8, pd: 8,
        minBase: '1000', minNotional: '0.0002'),
    priceText: '0.0000000000000001',
    amountText: '1000',
    priceUnits: '1',
    amountUnits: '100000000000',
    notionalUnits: '0',
    notionalText: '0',
    buyFeeText: '2',
    sellFeeText: '0',
    sellNetText: '0',
  ),
  // PERBUG-BTC: priceDecimals 4, priceScale 12.
  _Vector(
    market: _m(base: 'PERBUG', quote: 'BTC', bd: 8, qd: 8, pd: 4,
        minBase: '0.001', minNotional: '0.0002'),
    priceText: '0.000000012345',
    amountText: '250',
    priceUnits: '12345',
    amountUnits: '25000000000',
    notionalUnits: '308',
    notionalText: '0.00000308',
    buyFeeText: '0.5',
    sellFeeText: '0',
    sellNetText: '0.00000308',
  ),
];

void main() {
  group('the venue arithmetic, per decimal class', () {
    for (final v in _vectors) {
      final m = v.market;
      final label = '${m.id} (base ${m.baseDecimals}, quote '
          '${m.quoteDecimals}, priceDecimals ${m.priceDecimals}, '
          'priceScale ${m.priceScale})';

      test('$label parses a price at priceScale, not at the quote', () {
        expect(exParsePrice(m, v.priceText).toString(), v.priceUnits);
      });

      test('$label parses a size at the base asset decimals', () {
        expect(exParseBase(m, v.amountText).toString(), v.amountUnits);
      });

      test('$label round-trips a price through priceScale unchanged', () {
        // The field the ladder fills and the string that goes on the wire are
        // the same figure. A format/parse pair that disagreed would send a
        // different price than the one the ticket priced.
        final p = exParsePrice(m, v.priceText);
        expect(exFormatPrice(m, p), v.priceText);
        expect(exParsePrice(m, exFormatPrice(m, p)), p);
      });

      test('$label computes the order value the minNotional check will see',
          () {
        final q = exQuoteFor(
          baseAmount: exParseBase(m, v.amountText),
          price: exParsePrice(m, v.priceText),
          baseDecimals: m.baseDecimals,
          priceDecimals: m.priceDecimals,
        );
        expect(q.toString(), v.notionalUnits);
        expect(exFormat(q, m.quoteDecimals), v.notionalText);
      });

      test('$label quotes the ticket in the venue\'s own figures', () {
        // THE WHOLE TICKET AT ONCE, both sides. The fee is charged on what a
        // side RECEIVES — base on a buy, quote on a sell — so the two sides
        // report a fee in different assets, and the figures have to match the
        // server's for each.
        final buy = ExTicketQuote.of(
          market: m,
          buying: true,
          priceText: v.priceText,
          amountText: v.amountText,
          takerBps: _bps,
        );
        expect(buy.priceError, isNull);
        expect(buy.amountError, isNull);
        expect(buy.notionalText, v.notionalText);
        expect(buy.feeAsset, m.base, reason: 'a buyer receives base');
        expect(buy.feeText, v.buyFeeText);
        // What is spent on a buy is the QUOTE — the order value, not the size.
        expect(buy.spendAsset, m.quote);
        expect(buy.spendText, v.notionalText);

        final sell = ExTicketQuote.of(
          market: m,
          buying: false,
          priceText: v.priceText,
          amountText: v.amountText,
          takerBps: _bps,
        );
        expect(sell.feeAsset, m.quote, reason: 'a seller receives quote');
        expect(sell.feeText, v.sellFeeText);
        expect(sell.receiveText, v.sellNetText);
        // What is spent on a sell is the BASE — the size.
        expect(sell.spendAsset, m.base);
        expect(sell.spendText, exFormat(
            exParseBase(m, v.amountText), m.baseDecimals));
      });
    }
  });

  group('the priceDecimals trap, stated as a difference', () {
    test('the wrong scale SILENTLY misprices by 10^priceDecimals on submit',
        () {
      // DINGO-USDT, priceDecimals 5. "0.1" parses cleanly at BOTH scales — no
      // digit is lost either way, so reject-never-round does not fire — and the
      // two answers are five orders of magnitude apart. This is the dangerous
      // shape: no exception, no warning, an order placed at 1/100,000 of the
      // intended price.
      final m = _m(base: 'DINGO', quote: 'USDT', bd: 8, qd: 6, pd: 5);

      final correct = exParsePrice(m, '0.1'); // at priceScale 11
      final wrong = exParse('0.1', symbol: 'USDT', decimals: m.quoteDecimals);

      expect(correct, BigInt.from(10000000000));
      expect(wrong, BigInt.from(100000));
      expect(correct ~/ wrong, BigInt.from(10).pow(m.priceDecimals));
    });

    test('the wrong scale INFLATES a rendered price by 10^priceDecimals', () {
      // The same error in the other direction, and this one has no safety net
      // at all: formatting cannot refuse. The venue sends 123000 for
      // DINGO-USDT; at priceScale that is 0.00000123, and at the quote's
      // decimals it renders as 0.123 — a price 100,000x too large, shown to
      // someone about to trade on it.
      final m = _m(base: 'DINGO', quote: 'USDT', bd: 8, qd: 6, pd: 5);
      final fromVenue = BigInt.from(123000);

      expect(exFormatPrice(m, fromVenue), '0.00000123');
      expect(exFormat(fromVenue, m.quoteDecimals), '0.123');
    });

    test('a mis-scaled parse is REFUSED when it would drop a digit', () {
      // The other half of the picture, and the reason the trap is intermittent
      // rather than constant: when the wrong scale would discard a non-zero
      // digit, reject-never-round catches it and the user gets a refusal
      // instead of a misprice. That is a safety net, not a defence — it only
      // fires for prices with more places than the quote has.
      final m = _m(base: 'DINGO', quote: 'USDT', bd: 8, qd: 6, pd: 5);
      expect(exParsePrice(m, '0.00000123'), BigInt.from(123000));
      expect(
        () => exParse('0.00000123', symbol: 'USDT', decimals: m.quoteDecimals),
        throwsA(isA<ExAmountError>()),
      );
    });

    test('a market that omits priceScale falls back to the server definition',
        () {
      // An older venue that publishes priceDecimals but not priceScale must
      // still price correctly — the fallback is the server's own formula.
      const m = ExchangeMarket(
        id: 'DINGO-USDT', base: 'DINGO', quote: 'USDT',
        baseDecimals: 8, quoteDecimals: 6, priceDecimals: 5,
      );
      expect(m.priceScale, 11);
      expect(exParsePrice(m, '0.00000123'), BigInt.from(123000));
    });
  });

  group('refusals, because an exchange that rounds input decides for you', () {
    final m = _m(base: 'TRX', quote: 'USDT', bd: 6, qd: 6, pd: 0,
        minBase: '1', minNotional: '5');

    test('a size finer than the asset is REFUSED, not truncated', () {
      // 7 places on a 6-decimal asset, with a non-zero digit being discarded.
      expect(() => exParseBase(m, '1.0000001'),
          throwsA(isA<ExAmountError>()));
      // The same length is fine when what would be dropped is exactly zero —
      // "1.0000000" is 1, and refusing it would be pedantry rather than safety.
      expect(exParseBase(m, '1.0000000'), BigInt.from(1000000));
    });

    test('the ticket reports a bad field instead of pricing around it', () {
      final q = ExTicketQuote.of(
        market: m, buying: true, priceText: 'abc', amountText: '1500',
        takerBps: _bps,
      );
      expect(q.priceError, isNotNull);
      expect(q.priced, isFalse);
      expect(q.submittable, isFalse);
      expect(q.notionalText, isNull,
          reason: 'no order value may be shown for a price that is not one');
    });

    test('a zero or negative price is not a price', () {
      for (final bad in ['0', '0.0', '-1']) {
        final q = ExTicketQuote.of(
          market: m, buying: true, priceText: bad, amountText: '1500',
          takerBps: _bps,
        );
        expect(q.priceError, isNotNull, reason: '"$bad" was accepted');
        expect(q.submittable, isFalse);
      }
    });

    test('an unread fee schedule shows no fee rather than a zero fee', () {
      final q = ExTicketQuote.of(
        market: m, buying: true, priceText: '0.2871', amountText: '1500',
        takerBps: null,
      );
      expect(q.feeText, isNull, reason: 'a fee we have not read is not 0');
      // And the order is still priceable — not knowing the fee does not stop
      // someone placing an order.
      expect(q.notionalText, '430.65');
      expect(q.submittable, isTrue);
    });
  });

  group('BOTH minimums, independently', () {
    // THE REASON BOTH ARE SURFACED. On RTM-USDT the size floor is 10 RTM and
    // the value floor is 5 USDT. An order can clear either one alone, so a
    // ticket that showed only one would send someone to adjust the wrong field,
    // get the same refusal, and have nothing to go on.
    final m = _m(base: 'RTM', quote: 'USDT', bd: 8, qd: 6, pd: 0,
        minBase: '10', minNotional: '5');

    test('under the SIZE floor only', () {
      // 5 RTM at 2 USDT = 10 USDT: clears minNotional, fails minBase.
      final q = ExTicketQuote.of(
        market: m, buying: true, priceText: '2', amountText: '5',
        takerBps: _bps,
      );
      expect(q.belowMinBase, isTrue);
      expect(q.belowMinNotional, isFalse);
      expect(q.submittable, isFalse);
    });

    test('under the VALUE floor only', () {
      // 100 RTM at 0.01 USDT = 1 USDT: clears minBase, fails minNotional.
      final q = ExTicketQuote.of(
        market: m, buying: true, priceText: '0.01', amountText: '100',
        takerBps: _bps,
      );
      expect(q.belowMinBase, isFalse);
      expect(q.belowMinNotional, isTrue);
      expect(q.submittable, isFalse);
      expect(q.notionalText, '1');
    });

    test('clearing both is submittable', () {
      final q = ExTicketQuote.of(
        market: m, buying: true, priceText: '0.1', amountText: '100',
        takerBps: _bps,
      );
      expect(q.belowMinBase, isFalse);
      expect(q.belowMinNotional, isFalse);
      expect(q.submittable, isTrue);
    });

    test('a CLOSED market is never submittable, whatever the numbers say', () {
      final shut = _m(base: 'SOL', quote: 'USDT', bd: 9, qd: 6, pd: 0,
          minBase: '0.001', minNotional: '5',
          closed: 'SOL settlement is paused.');
      final q = ExTicketQuote.of(
        market: shut, buying: true, priceText: '142.5', amountText: '1',
        takerBps: _bps,
      );
      // Every arithmetic check passes...
      expect(q.belowMinBase, isFalse);
      expect(q.belowMinNotional, isFalse);
      expect(q.priced, isTrue);
      // ...and the venue would still answer 409.
      expect(q.submittable, isFalse);
    });
  });

  group('formatting never lies and never goes exponential', () {
    test('a tiny 8-place price is decimal, not 1.2e-7', () {
      // The live quote shape on every BLOCK-quoted cheap coin. `toString()` on
      // the equivalent double gives "1.2e-7", which is not a price anyone can
      // read or check.
      expect(exFormat(BigInt.from(12), 8), '0.00000012');
    });

    test('trailing zeros go, interior zeros stay', () {
      expect(exFormat(BigInt.from(150), 2), '1.5');
      expect(exFormat(BigInt.from(105), 2), '1.05');
      expect(exFormat(BigInt.zero, 8), '0');
    });

    test('an 18-decimal figure survives, which no double would', () {
      final wei = BigInt.parse('1234567890123456789');
      expect(exFormat(wei, 18), '1.234567890123456789');
      expect(exParse('1.234567890123456789', symbol: 'ETH', decimals: 18), wei);
      // The proof it matters: the double path loses the tail.
      expect(double.parse('1.234567890123456789').toString(),
          isNot('1.234567890123456789'));
    });
  });
}
