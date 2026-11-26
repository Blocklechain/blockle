// Tests for the exchange tab's MARKETS and TRADE sections.
//
// THE FIXTURE IS THE REAL VENUE, not a convenient three-row stub. Every market
// below was taken from a live read of https://exchange.blockle.org/public/markets
// — all forty symbols, the four quote currencies in their real proportions
// (USDT 13, BLOCK 12, USDC 8, BTC 7), the six markets that are closed to new
// orders, the thirteen that carry a caveat, and the real per-market
// `priceDecimals`, `minBase` and `minNotional`. The closed and caveat sentences
// are the venue's own words, verbatim.
//
// That matters because the bugs these tests exist to catch are all bugs of
// SCALE AND STATE, and a three-market fixture has neither:
//
//   * a quote-filter chip list written as a literal passes every test against a
//     fixture with two quotes and is wrong the moment the venue adds a third.
//     So there are two fixtures here with DIFFERENT quote sets, and the second
//     one proves the chips are derived at runtime rather than declared;
//   * `priceDecimals` is 0 on twenty-four of the forty markets, which means a
//     client that ignores it entirely looks correct on a majority of the venue
//     and misprices DINGO-USDT by 100,000x. The ladder test uses a market with
//     priceDecimals 5 on purpose;
//   * "closed" and "open with a caveat" are different things and neither is a
//     hidden market. A closed market must still open its book.
//
// WHAT IS NOT TESTED HERE, deliberately: no test asserts a market COUNT of 40
// or a hardcoded quote set, because the production code must not know either
// and a test that pinned them would make the next listing a test failure.
// The assertions are relational — "every quote in the payload has a chip", "the
// chip count equals the distinct quotes" — so they hold at 40 markets and at
// 400.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/screens/exchange/exchange_ui.dart';
import 'package:blockle_app/screens/exchange/sections/markets_section.dart';
import 'package:blockle_app/screens/exchange/sections/trade_section.dart';
import 'package:blockle_app/services/exchange_client.dart';
import 'package:blockle_app/services/transports.dart';
import 'package:blockle_app/state/exchange_controller.dart';
import 'package:blockle_app/theme.dart';

// --------------------------------------------------------------- the fixture

/// The venue's own sentences, verbatim off /public/markets.
const String _ethClosed =
    'ETH deposits are not open yet. Our custodian will not issue a '
    'per-customer Ethereum deposit address on our current plan, and we will '
    'not hand everyone one shared address — on Ethereum there is no memo or '
    'tag, so we could not tell whose money had arrived. We are resolving it '
    'with the custodian.';
const String _solClosed =
    'SOL deposits are not open yet. Our Solana custody wallet needs a one-off '
    'on-chain activation payment, and we will not open deposits until we can '
    'also pay SOL back out — we do not hold coins we cannot send.';
const String _bnbClosed =
    'BNB deposits are not open yet. Our custodian will not issue a '
    'per-customer BNB Chain deposit address on our current plan, and we will '
    'not hand everyone one shared address — BNB Chain has no memo or tag, so '
    'we could not tell whose money had arrived. We are resolving it with the '
    'custodian.';
const String _blockCaveat =
    'BLOCK moves on our own chain, and that rail is only half automatic. '
    'Deposits depend on our BLOCK node being reachable and on a loaded address '
    'pool, and withdrawals are released by an operator rather than by a payout '
    'runner, so they are not instant. Trading, balances and cancels are '
    'unaffected.';

/// One row of /public/markets, in the shape the server publishes it.
Map<String, Object?> _mk(String base, String quote, int bd, int qd, int pd,
        String minBase, String minNotional,
        [String? closed, bool caveat = false]) =>
    <String, Object?>{
      'symbol': '$base-$quote',
      'base': base,
      'quote': quote,
      'baseDecimals': bd,
      'quoteDecimals': qd,
      'priceDecimals': pd,
      // PUBLISHED, not derived — the client cannot work it out, and a fixture
      // that omitted it would be testing the fallback rather than the field.
      'priceScale': qd + pd,
      'minBase': minBase,
      'minNotional': minNotional,
      'state': closed == null ? 'open' : 'closed',
      'closed': closed,
      'caveat': caveat ? _blockCaveat : null,
      'listedAt': '2026-11-25',
    };

/// All forty live markets.
final List<Map<String, Object?>> _kMarkets = [
  _mk('BTC', 'USDT', 8, 6, 0, '0.00001', '5'),
  _mk('BTC', 'USDC', 8, 6, 0, '0.00001', '5'),
  _mk('DOGE', 'BTC', 8, 8, 2, '1', '0.0002'),
  _mk('TRX', 'BTC', 6, 8, 1, '1', '0.0002'),
  _mk('XRP', 'BTC', 6, 8, 1, '1', '0.0002'),
  _mk('BTC', 'BLOCK', 8, 8, 0, '0.00001', '0.05', null, true),
  _mk('PERBUG', 'BTC', 8, 8, 4, '0.001', '0.0002'),
  _mk('PEP', 'BTC', 8, 8, 5, '10', '0.0002'),
  _mk('DINGO', 'BTC', 8, 8, 8, '1000', '0.0002'),
  _mk('RTM', 'BTC', 8, 8, 4, '10', '0.0002'),
  _mk('ETH', 'USDT', 18, 6, 0, '0.00001', '5', _ethClosed),
  _mk('ETH', 'BLOCK', 18, 8, 0, '0.00001', '0.05', _ethClosed, true),
  _mk('USDC', 'USDT', 6, 6, 0, '1', '5'),
  _mk('SOL', 'USDT', 9, 6, 0, '0.001', '5', _solClosed),
  _mk('DOGE', 'USDT', 8, 6, 0, '1', '5'),
  _mk('TRX', 'USDT', 6, 6, 0, '1', '5'),
  _mk('XRP', 'USDT', 6, 6, 0, '1', '5'),
  _mk('BNB', 'USDT', 18, 6, 0, '0.001', '5', _bnbClosed),
  // THE MARKET AN EARLIER RULING HID. It is listed, and its price is rendered
  // strictly in USDT with no dollar sign and no conversion.
  _mk('BLOCK', 'USDT', 8, 6, 0, '0.001', '5', null, true),
  _mk('PERBUG', 'USDT', 8, 6, 0, '0.001', '5'),
  _mk('PEP', 'USDT', 8, 6, 0, '10', '5'),
  // priceDecimals 5 on a 6-decimal quote: priceScale 11.
  _mk('DINGO', 'USDT', 8, 6, 5, '1000', '5'),
  _mk('RTM', 'USDT', 8, 6, 0, '10', '5'),
  _mk('DOGE', 'USDC', 8, 6, 0, '1', '5'),
  _mk('TRX', 'USDC', 6, 6, 0, '1', '5'),
  _mk('XRP', 'USDC', 6, 6, 0, '1', '5'),
  _mk('USDC', 'BLOCK', 6, 8, 0, '1', '0.05', null, true),
  _mk('PERBUG', 'USDC', 8, 6, 1, '0.001', '5'),
  _mk('PEP', 'USDC', 8, 6, 2, '10', '5'),
  _mk('DINGO', 'USDC', 8, 6, 5, '1000', '5'),
  _mk('RTM', 'USDC', 8, 6, 1, '10', '5'),
  _mk('SOL', 'BLOCK', 9, 8, 0, '0.001', '0.05', _solClosed, true),
  _mk('DOGE', 'BLOCK', 8, 8, 0, '1', '0.05', null, true),
  _mk('TRX', 'BLOCK', 6, 8, 0, '1', '0.05', null, true),
  _mk('XRP', 'BLOCK', 6, 8, 0, '1', '0.05', null, true),
  _mk('BNB', 'BLOCK', 18, 8, 0, '0.001', '0.05', _bnbClosed, true),
  _mk('PERBUG', 'BLOCK', 8, 8, 0, '0.001', '0.05', null, true),
  _mk('PEP', 'BLOCK', 8, 8, 0, '10', '0.05', null, true),
  _mk('DINGO', 'BLOCK', 8, 8, 0, '1000', '0.05', null, true),
  _mk('RTM', 'BLOCK', 8, 8, 0, '10', '0.05', null, true),
];

/// The distinct quotes in the fixture, computed the same way the UI must.
Set<String> _quotesOf(List<Map<String, Object?>> ms) =>
    ms.map((m) => m['quote'] as String).toSet();

/// A book on DINGO-USDT — priceScale 11, so every price here carries eleven
/// decimal places and is the venue's own string.
///
/// Five levels a side, with DELIBERATELY UNEVEN SIZES so the cumulative bars
/// are not all the same width and a bar that ignored the running total would
/// show up.
const Map<String, Object?> _kDingoBook = {
  'market': 'DINGO-USDT',
  'bids': [
    {'price': '0.00000123', 'base': '5000'},
    {'price': '0.00000122', 'base': '12000'},
    {'price': '0.00000120', 'base': '3000'},
    {'price': '0.00000119', 'base': '40000'},
    {'price': '0.00000115', 'base': '1000'},
  ],
  'asks': [
    {'price': '0.00000125', 'base': '2000'},
    {'price': '0.00000126', 'base': '9000'},
    {'price': '0.00000130', 'base': '25000'},
    {'price': '0.00000131', 'base': '6000'},
    {'price': '0.00000140', 'base': '80000'},
  ],
};

Map<String, Object?> _routes({
  List<Map<String, Object?>>? markets,
  Object? marketsStatus,
}) =>
    <String, Object?>{
      'GET /public/status': {
        'live': true,
        'mainnetEnabled': true,
        'legalReviewCompleted': true,
        'network': 'mainnet',
        'ledgerPresent': true,
        'faucetAvailable': false,
      },
      'GET /public/markets': marketsStatus ?? (markets ?? _kMarkets),
      'GET /public/tickers': [
        // ONLY ONE MARKET HAS EVER TRADED in this fixture. The other
        // thirty-nine must render an em dash, not a zero.
        {
          'market': 'DINGO-USDT',
          'last': '0.00000124',
          'bid': '0.00000123',
          'ask': '0.00000125',
          'change24h': null,
          'volume24h': null,
        },
      ],
      'GET /public/fees': {
        'makerPct': '0.20%',
        'takerPct': '0.20%',
        'makerBps': 20,
        'takerBps': 20,
        'note': 'Each side pays in the asset it receives.',
      },
      'GET /public/book/DINGO-USDT': _kDingoBook,
      'GET /public/trades/DINGO-USDT': [
        {
          'price': '0.00000124',
          'base': '7000',
          'takerSide': 'buy',
          'at': '2026-11-25T12:00:00Z',
        },
      ],
      'GET /public/book/SOL-USDT': {
        'bids': [
          {'price': '142.40', 'base': '3'}
        ],
        'asks': [
          {'price': '142.90', 'base': '5'}
        ],
      },
      'GET /public/trades/SOL-USDT': <Object>[],
      'GET /v1/balances': [
        {
          'asset': 'USDT',
          'total': '500',
          'reserved': '100',
          'available': '400',
          'decimals': 6
        },
        {
          'asset': 'DINGO',
          'total': '9000',
          'reserved': '0',
          'available': '9000',
          'decimals': 8
        },
      ],
      'GET /v1/orders': <Object>[],
      'GET /v1/deposits': {'deposits': <Object>[]},
      'GET /v1/liquidity': <Object>[],
      'GET /v1/api-keys': {'keys': <Object>[], 'signing': {}},
      'GET /v1/2fa': {'enrolled': true},
      'GET /v1/allowlist': {'required': true, 'addresses': <Object>[]},
    };

/// A venue keyed on 'METHOD /path'. The `/public` vs `/v1` surface is part of
/// the key on purpose — a stub that flattened them would be blind to the bug
/// that once made the whole tab report "unavailable".
HttpSend _venue(Map<String, Object?> routes, {List<String>? seen}) {
  return (HttpReq req) async {
    final key = '${req.method} ${Uri.parse(req.url).path}';
    seen?.add('$key${req.body == null ? '' : ' ${req.body}'}');
    if (!routes.containsKey(key)) {
      return HttpReply(404, jsonEncode({'error': 'no stub for $key'}));
    }
    final v = routes[key];
    if (v is HttpReply) return v;
    return HttpReply(200, v is String ? v : jsonEncode(v));
  };
}

Future<ExchangeController> _loaded(
  WidgetTester tester, {
  Map<String, Object?>? routes,
  bool signedIn = true,
  String? select,
  List<String>? seen,
}) async {
  final c = ExchangeController(
    client: ExchangeClient(
      send: _venue(routes ?? _routes(), seen: seen),
      bearer: signedIn ? () => 'session-token' : () => null,
    ),
  );
  await c.loadMarkets();
  await c.loadFees();
  if (signedIn) await c.loadAccount();
  if (select != null) await c.selectMarket(select);
  return c;
}

/// Mount one section on a phone-sized surface.
Future<void> _pump(WidgetTester tester, Widget child,
    {Size size = const Size(390, 1600)}) async {
  tester.view.physicalSize = Size(size.width * 3, size.height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: Bk.theme(),
    home: Scaffold(body: child),
  ));
  await tester.pumpAndSettle();
}

/// Every string the widget tree is currently rendering.
List<String> _allText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
    .toList();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // ==================================================================
  group('MARKETS', () {
    testWidgets('lists what the venue listed, without knowing how many',
        (tester) async {
      final c = await _loaded(tester);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));

      // RELATIONAL, not a magic number: the header's count is the payload's
      // length, whatever that length becomes.
      expect(c.visibleMarkets.length, _kMarkets.length);
      expect(find.textContaining('${_kMarkets.length} listed'), findsOneWidget);

      // And it says how many are shut, from the data rather than from a
      // constant.
      final shut = _kMarkets.where((m) => m['closed'] != null).length;
      expect(find.textContaining('$shut closed to new orders'), findsOneWidget);
    });

    testWidgets('THE QUOTE CHIPS ARE DERIVED, one per distinct quote',
        (tester) async {
      final c = await _loaded(tester);
      // A WIDE SURFACE, because the chip row is a horizontal ListView and a
      // lazy one: on a 390pt phone only three chips are built at a time and the
      // rest arrive on scroll. That is correct behaviour and the wrong way to
      // count them — so this mounts at iPad width where the whole derived row
      // is realised at once.
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}),
          size: const Size(1100, 1600));

      final quotes = _quotesOf(_kMarkets);
      expect(quotes.length, greaterThan(2),
          reason: 'a fixture with one or two quotes cannot catch a hardcoded '
              'chip list');

      // One chip per quote, each labelled with that quote's own count — and an
      // "All" chip. Nothing else.
      final chips = tester.widgetList<ChoiceChip>(find.byType(ChoiceChip));
      expect(chips.length, quotes.length + 1);
      for (final q in quotes) {
        final n = _kMarkets.where((m) => m['quote'] == q).length;
        expect(find.text('$q $n'), findsOneWidget,
            reason: 'no chip for the $q quote');
      }
    });

    testWidgets('A NEW QUOTE CURRENCY GROWS ITS OWN CHIP, with no code change',
        (tester) async {
      // THE TEST THAT A LITERAL LIST CANNOT PASS. Same screen, a payload whose
      // quote set is different: one quote removed entirely and one invented.
      // If the chips were declared anywhere, this fails.
      final grown = <Map<String, Object?>>[
        ..._kMarkets.where((m) => m['quote'] != 'BTC'),
        _mk('DOGE', 'EURC', 8, 6, 0, '1', '5'),
        _mk('TRX', 'EURC', 6, 6, 0, '1', '5'),
      ];
      final c = await _loaded(tester, routes: _routes(markets: grown));
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}),
          size: const Size(1100, 1600));

      expect(find.text('EURC 2'), findsOneWidget,
          reason: 'a quote the app has never heard of must still get a chip');
      expect(find.textContaining('BTC '), findsNothing,
          reason: 'a quote the venue dropped must lose its chip');

      final chips = tester.widgetList<ChoiceChip>(find.byType(ChoiceChip));
      expect(chips.length, _quotesOf(grown).length + 1);
    });

    testWidgets('a quote chip filters the list to that quote', (tester) async {
      final c = await _loaded(tester);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}),
          size: const Size(1100, 1600));

      final btc = _kMarkets.where((m) => m['quote'] == 'BTC').length;
      await tester.tap(find.text('BTC $btc'));
      await tester.pumpAndSettle();

      // Every visible pair ends in /BTC. Scrolling is not needed — the point is
      // that nothing from another quote is in the tree at all.
      final pairs = _allText(tester).where((s) => s.contains('/'));
      expect(pairs, isNotEmpty);
      for (final p in pairs) {
        expect(p, endsWith('/BTC'), reason: '"$p" survived the BTC filter');
      }
    });

    testWidgets('search matches the PAIR SYMBOL', (tester) async {
      final c = await _loaded(tester);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));

      await tester.enterText(find.byType(TextField), 'DINGO');
      await tester.pumpAndSettle();

      final pairs = _allText(tester).where((s) => s.contains('/')).toList();
      expect(pairs, isNotEmpty);
      for (final p in pairs) {
        expect(p, startsWith('DINGO/'));
      }
    });

    testWidgets('SEARCH ALSO MATCHES THE FULL COIN NAME', (tester) async {
      // "RTM" tells a first-time visitor nothing. "Raptoreum" is what they
      // would actually type, and a search that only matched tickers would come
      // back empty on the only term they know.
      final c = await _loaded(tester);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));

      await tester.enterText(find.byType(TextField), 'raptoreum');
      await tester.pumpAndSettle();

      final pairs = _allText(tester).where((s) => s.contains('/')).toList();
      expect(pairs, isNotEmpty,
          reason: 'searching a coin by its name found nothing');
      for (final p in pairs) {
        expect(p, startsWith('RTM/'));
      }
    });

    testWidgets('a search that matches nothing SAYS SO', (tester) async {
      final c = await _loaded(tester);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));

      await tester.enterText(find.byType(TextField), 'zzzznotacoin');
      await tester.pumpAndSettle();

      expect(find.text('No market matches that.'), findsOneWidget);
      expect(_allText(tester).where((s) => s.contains('/')), isEmpty);
    });

    testWidgets('A NEVER-TRADED MARKET SHOWS AN EM DASH, NEVER A ZERO',
        (tester) async {
      // /public/tickers returns null for a market that has not traded, and
      // "no market yet" is not "the market is at zero".
      final c = await _loaded(tester);
      final traded = c.visibleMarkets.firstWhere((m) => m.id == 'DINGO-USDT');
      final untraded = c.visibleMarkets.firstWhere((m) => m.id == 'BTC-USDT');
      expect(traded.lastText, '0.00000124');
      expect(untraded.last, isNull);
      expect(untraded.lastText, isNull);

      await _pump(
        tester,
        Column(children: [
          MarketRow(m: untraded, selected: false, onTap: () {}),
        ]),
      );
      expect(find.text(kEmDash), findsOneWidget);
      expect(find.text('0'), findsNothing);
      expect(find.text('0.00'), findsNothing);
    });

    testWidgets('A CLOSED MARKET SHOWS THE VENUE\'S REASON and stays tappable',
        (tester) async {
      final c = await _loaded(tester);
      final shut = c.visibleMarkets.firstWhere((m) => m.id == 'SOL-USDT');
      expect(shut.open, isFalse);

      var tapped = 0;
      await _pump(
        tester,
        MarketRow(m: shut, selected: false, onTap: () => tapped++),
      );

      expect(find.text('CLOSED'), findsOneWidget);
      // The venue's own sentence, not a paraphrase of it.
      expect(find.textContaining('Our Solana custody wallet needs a one-off'),
          findsOneWidget);

      // STILL TAPPABLE. The book and the history are intact on a closed
      // market; only placing an order is refused, and that refusal belongs on
      // the ticket.
      await tester.tap(find.byType(InkWell));
      expect(tapped, 1,
          reason: 'a closed market must still open its book');
    });

    testWidgets('AN OPEN-WITH-A-CAVEAT MARKET IS NOT DRESSED AS CLOSED',
        (tester) async {
      final c = await _loaded(tester);
      final caveated = c.visibleMarkets.firstWhere((m) => m.id == 'RTM-BLOCK');
      expect(caveated.open, isTrue);
      expect(caveated.caveat, isNotNull);

      await _pump(
        tester,
        MarketRow(m: caveated, selected: false, onTap: () {}),
      );

      expect(find.text('KNOWN GAP'), findsOneWidget);
      expect(find.text('CLOSED'), findsNothing,
          reason: 'a caveat is not a weaker form of closed');
      expect(find.textContaining('Open, with a known gap'), findsOneWidget);
    });

    testWidgets('AN OPEN MARKET WITH NO CAVEAT CARRIES NO PILL AT ALL',
        (tester) async {
      final c = await _loaded(tester);
      final plain = c.visibleMarkets.firstWhere((m) => m.id == 'BTC-USDT');
      await _pump(tester, MarketRow(m: plain, selected: false, onTap: () {}));
      expect(find.text('CLOSED'), findsNothing);
      expect(find.text('KNOWN GAP'), findsNothing);
      expect(find.text('Bitcoin'), findsOneWidget,
          reason: 'the coin name belongs on the row beside the ticker');
    });

    testWidgets('A BLOCK PRICE IS IN BLOCK, with no dollar sign anywhere',
        (tester) async {
      final c = await _loaded(tester);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));

      // Every BLOCK-quoted pair in the fixture is on screen, and the figure
      // beside it is in BLOCK.
      expect(find.textContaining('/BLOCK'), findsWidgets);

      for (final s in _allText(tester)) {
        // THE RULE IS THE DOLLAR SIGN AND THE CONVERSION, not the letters
        // U-S-D: "USD Coin" is USDC's actual name and belongs on its row. What
        // may never appear is a currency symbol or an approximation glyph,
        // because both mean "here is the same figure in dollars".
        expect(s, isNot(contains(r'$')), reason: 'dollar sign in "$s"');
        expect(s, isNot(contains('≈')), reason: 'a conversion appeared in "$s"');
        expect(s.trim().toUpperCase(), isNot('USD'),
            reason: 'a bare USD label is a USD column in "$s"');
      }
    });

    testWidgets('A FAILED MARKET READ PRINTS ITS ERROR, never a blank list',
        (tester) async {
      final routes = _routes();
      routes['GET /public/markets'] =
          HttpReply(500, jsonEncode({'error': 'venue is restarting'}));
      final c = await _loaded(tester, routes: routes);
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));

      expect(c.marketsError, isNotNull);
      expect(find.textContaining('Could not read the market list'),
          findsOneWidget);
      // An empty table would read as "the venue delisted everything".
      expect(find.textContaining('the read above is why'), findsOneWidget);
      // And no spinner survives a finished request.
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('AN EMPTY LIST AND A FAILED LIST SAY DIFFERENT THINGS',
        (tester) async {
      final c = await _loaded(tester, routes: _routes(markets: []));
      await _pump(tester, MarketsSection(c: c, onTrade: (_) {}));
      expect(c.marketsError, isNull);
      expect(find.textContaining('That is the venue\'s answer'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('tapping a row reports that market to the tab', (tester) async {
      final c = await _loaded(tester);
      String? picked;
      await _pump(tester, MarketsSection(c: c, onTrade: (m) => picked = m));

      await tester.tap(find.text('BTC/USDT').first);
      await tester.pumpAndSettle();
      expect(picked, 'BTC-USDT');
    });
  });

  // ==================================================================
  group('TRADE — the ladder', () {
    testWidgets('ASKS ARE REVERSED so the best ask abuts the best bid',
        (tester) async {
      // THE TAPE IS EMPTIED FOR THIS ONE TEST. A recent trade renders its own
      // price in the same shape as a ladder level, lower down the same scroll
      // view, and this assertion is about the ORDER of the book's price column
      // — so a tape print at the bottom of the tree would read as the last
      // level of the book. The tape has its own tests.
      final routes = _routes();
      routes['GET /public/trades/DINGO-USDT'] = <Object>[];
      final c = await _loaded(tester, routes: routes, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // The rendered order of the price column, top to bottom.
      final prices = _allText(tester)
          .where((s) => s.startsWith('0.000001'))
          .toList();
      expect(prices.length, 10, reason: 'five levels a side and nothing else');

      // Asks descend to the best ask, then bids descend from the best bid. The
      // two prices either side of the spread row are the TOUCH: 0.00000125 and
      // 0.00000123.
      final bestAskAt = prices.indexOf('0.00000125');
      final bestBidAt = prices.indexOf('0.00000123');
      expect(bestAskAt, isNonNegative);
      expect(bestBidAt, isNonNegative);
      expect(bestBidAt - bestAskAt, 1,
          reason: 'the touch must be adjacent — asks are drawn reversed so the '
              'best ask sits directly above the best bid');

      // The worst ask is at the very top and the worst bid at the very bottom.
      expect(prices.first, '0.00000140');
      expect(prices.last, '0.00000115');
    });

    testWidgets('THE SPREAD ROW CARRIES THE MID AND THE SPREAD', (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));
      // mid of 0.00000123 / 0.00000125, at priceScale 11 and computed in
      // integers — 123000 and 125000 base units average to 124000.
      expect(find.textContaining('mid 0.00000124 USDT'), findsOneWidget);
      expect(find.textContaining('spread 1.61%'), findsOneWidget);
    });

    testWidgets('THE MID IS EXACT ON A 16-PLACE MARKET, where a double is not',
        (tester) async {
      // DINGO-BTC, priceScale 16. Two adjacent ticks around 1e-16 average to a
      // figure a double cannot hold — it has no significant digits left — and
      // the spread row prints its answer beside a quote ticker, so a float
      // artefact there reads as a price. This pins the integer path.
      final routes = _routes(markets: [
        _mk('DINGO', 'BTC', 8, 8, 8, '1000', '0.0002'),
      ]);
      routes['GET /public/tickers'] = <Object>[];
      routes['GET /public/book/DINGO-BTC'] = {
        'bids': [
          {'price': '0.0000000000000003', 'base': '1000'}
        ],
        'asks': [
          {'price': '0.0000000000000005', 'base': '1000'}
        ],
      };
      routes['GET /public/trades/DINGO-BTC'] = <Object>[];
      final c = await _loaded(tester, routes: routes, select: 'DINGO-BTC');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // 3 and 5 base units average to 4 — exactly.
      expect(find.textContaining('mid 0.0000000000000004 BTC'),
          findsOneWidget);
    });

    testWidgets('CUMULATIVE TOTALS RUN FROM THE BEST PRICE OUTWARDS',
        (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // Bids: 5000, then 17000, then 20000, then 60000, then 61000. The bars
      // are drawn from these, so a bar sized by the LEVEL rather than the
      // RUNNING TOTAL would not produce this column.
      for (final t in ['5000.0000', '17000.0000', '20000.0000', '60000.0000',
        '61000.0000']) {
        expect(find.text(t), findsOneWidget, reason: 'missing cumulative $t');
      }
      // Asks, outwards from the best: 2000, 11000, 36000, 42000, 122000.
      for (final t in ['2000.0000', '11000.0000', '36000.0000',
        '42000.0000', '122000.0000']) {
        expect(find.text(t), findsOneWidget, reason: 'missing cumulative $t');
      }
    });

    testWidgets('DEPTH BARS ARE SCALED TO THE DEEPER SIDE', (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      final factors = tester
          .widgetList<FractionallySizedBox>(find.byType(FractionallySizedBox))
          .map((w) => w.widthFactor ?? 0)
          .toList();
      expect(factors.length, 10, reason: 'one bar per level, five a side');
      // Asks total 122000 and bids total 61000, so exactly ONE bar is full
      // width — the outermost ask — and the deepest bid reaches half.
      expect(factors.where((f) => f > 0.999).length, 1,
          reason: 'both sides must share one scale, or a thin side looks thick');
      expect(factors.reduce((a, b) => a > b ? a : b), closeTo(1.0, 1e-9));
      expect(factors.where((f) => (f - 0.5).abs() < 1e-9).length, 1,
          reason: '61000 of 122000 is half the deepest side');
    });

    testWidgets('TAPPING A LEVEL FILLS THE PRICE AT THE MARKET\'S OWN SCALE',
        (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // The price field starts empty.
      final priceField = find.widgetWithText(TextField, 'Limit price (USDT)');
      expect(tester.widget<TextField>(priceField).controller!.text, '');

      // Tap the best ask.
      await tester.tap(find.text('0.00000125'));
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(priceField).controller!.text,
          '0.00000125',
          reason: 'a tapped level must fill the venue\'s own price string, not '
              'a reformatted double');
    });

    testWidgets('TAPPING A LEVEL DOES NOT CHANGE THE SIDE', (tester) async {
      // Hitting an ask is a buy and hitting a bid is a sell, so a ladder that
      // set the side too would turn one misplaced thumb into a reversed order.
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      final seg = find.byType(SegmentedButton<String>);
      expect(tester.widget<SegmentedButton<String>>(seg).selected, {'buy'});

      // Tap a BID — the side a careless implementation would flip to 'sell'.
      await tester.tap(find.text('0.00000119'));
      await tester.pumpAndSettle();
      expect(tester.widget<SegmentedButton<String>>(seg).selected, {'buy'},
          reason: 'the side is the one field nobody should change by accident');
    });

    testWidgets('AN EMPTY BOOK IS NOT A PRICE', (tester) async {
      final routes = _routes();
      routes['GET /public/book/DINGO-USDT'] = {
        'bids': <Object>[],
        'asks': <Object>[]
      };
      final c = await _loaded(tester, routes: routes, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));
      expect(find.textContaining('An empty book is not a price'),
          findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('A FAILED BOOK READ PRINTS ITS ERROR', (tester) async {
      final routes = _routes();
      routes['GET /public/book/DINGO-USDT'] =
          HttpReply(502, jsonEncode({'error': 'matching engine unreachable'}));
      final c = await _loaded(tester, routes: routes, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));
      expect(find.textContaining('Could not read the order book'),
          findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing,
          reason: 'a spinner must not outlive its request');
    });
  });

  // ==================================================================
  group('TRADE — the order ticket', () {
    testWidgets('LIMIT ONLY, and it says so', (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      expect(find.textContaining('LIMIT ONLY'), findsOneWidget);
      // No order-type picker, because the venue has no market order.
      expect(find.text('Market'), findsNothing);
      // Buy and Sell are both offered, named for the base asset.
      expect(find.text('Buy DINGO'), findsWidgets);
      expect(find.text('Sell DINGO'), findsWidgets);
    });

    testWidgets('the price is labelled in the QUOTE and the amount in the BASE',
        (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));
      expect(find.text('Limit price (USDT)'), findsOneWidget);
      expect(find.text('Amount (DINGO)'), findsOneWidget);
      // And the field states the market's own price scale, which is the one
      // thing a user cannot work out.
      expect(find.textContaining('up to 11 decimal places'), findsOneWidget);
    });

    testWidgets('BOTH MINIMUMS ARE SURFACED, each in its own asset',
        (tester) async {
      // Showing one sends someone to fix the wrong constraint.
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      expect(find.text('BOTH MINIMUMS APPLY'), findsOneWidget);
      expect(find.textContaining('Smallest size 1000 DINGO'), findsOneWidget);
      expect(find.textContaining('Smallest order value 5 USDT'), findsOneWidget);
    });

    testWidgets('THE VALUE FLOOR FAILS ON ITS OWN, and says which one',
        (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // 2000 DINGO at 0.00000125 USDT = 0.0025 USDT. Clears the 1000-DINGO
      // size floor; nowhere near the 5-USDT value floor.
      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'), '0.00000125');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '2000');
      await tester.pumpAndSettle();

      expect(
          find.textContaining(
              'Smallest order value 5 USDT — this order is under it'),
          findsOneWidget);
      expect(find.textContaining('Smallest size 1000 DINGO — this order'),
          findsNothing,
          reason: 'the size floor is clear, so it must not be flagged');

      // And the button is dead, rather than offering a round trip to a 400.
      final btn = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(btn.onPressed, isNull);
    });

    testWidgets('THE SIZE FLOOR FAILS ON ITS OWN', (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // 500 DINGO at 1 USDT = 500 USDT: way over the value floor, under the
      // 1000-DINGO size floor.
      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'), '1');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '500');
      await tester.pumpAndSettle();

      expect(find.textContaining('Smallest size 1000 DINGO — this order is '
          'under it'), findsOneWidget);
      expect(
          find.textContaining('Smallest order value 5 USDT — this order'),
          findsNothing);
    });

    testWidgets('AVAILABLE IS THE ASSET BEING SPENT, and it follows the side',
        (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // A BUY spends the quote.
      expect(find.text('400 USDT'), findsOneWidget);
      expect(find.text('Available to spend'), findsOneWidget);

      // A SELL spends the base. Same row, different asset — showing the quote
      // balance on a sell would be a figure about the wrong pocket.
      await tester.tap(find.text('Sell DINGO'));
      await tester.pumpAndSettle();
      expect(find.text('9000 DINGO'), findsOneWidget);
      expect(find.text('400 USDT'), findsNothing);
    });

    testWidgets('THE FEE IS QUOTED AT THE LIVE TAKER BPS, IN THE ASSET '
        'RECEIVED', (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'), '0.00000125');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '8000000');
      await tester.pumpAndSettle();

      // A BUYER receives DINGO, so the fee is in DINGO: 20bps of 8,000,000.
      expect(find.text('16000 DINGO'), findsOneWidget);
      expect(find.textContaining('taken from the DINGO you receive'),
          findsOneWidget);
      expect(find.textContaining('taker 0.20%'), findsOneWidget);

      // A SELLER receives USDT, so the fee moves asset: the order is worth 10
      // USDT and 20bps of that is 0.02 USDT.
      await tester.tap(find.text('Sell DINGO'));
      await tester.pumpAndSettle();
      expect(find.text('10 USDT'), findsWidgets, reason: 'the order value');
      expect(find.text('0.02 USDT'), findsOneWidget, reason: 'the fee');
      expect(find.text('9.98 USDT'), findsOneWidget, reason: 'what lands');
    });

    testWidgets('AN UNREAD FEE SCHEDULE IS AN EM DASH, NOT A FREE TRADE',
        (tester) async {
      final routes = _routes();
      routes['GET /public/fees'] =
          HttpReply(503, jsonEncode({'error': 'fees unavailable'}));
      final c = await _loaded(tester, routes: routes, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'), '0.00000125');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '8000000');
      await tester.pumpAndSettle();

      expect(find.textContaining('fee schedule has not been read'),
          findsOneWidget);
      expect(find.text('0 DINGO'), findsNothing,
          reason: 'a fee we could not read is not a fee of zero');
    });

    testWidgets('A SUBMITTED ORDER SENDS amount AND price, AND NO type',
        (tester) async {
      // THE WIRE FORMAT THAT 400d EVERY ORDER THIS APP EVER SENT. The venue
      // reads `str(b,"amount")`, which throws on a missing key, and it has no
      // `type` field at all. This asserts the body, not just that a request
      // happened.
      final seen = <String>[];
      final routes = _routes();
      routes['POST /v1/orders'] = {
        'id': 'ord-1',
        'state': 'open',
        'fills': <Object>[],
        'filled': '0',
        'total': '8000000',
      };
      final c = ExchangeController(
        client: ExchangeClient(
          send: _venue(routes, seen: seen),
          bearer: () => 'session-token',
        ),
      );
      await c.loadMarkets();
      await c.loadFees();
      await c.loadAccount();
      await c.selectMarket('DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'), '0.00000125');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '8000000');
      await tester.pumpAndSettle();

      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      final post = seen.firstWhere((s) => s.startsWith('POST /v1/orders'));
      final body = jsonDecode(post.substring('POST /v1/orders '.length))
          as Map<String, dynamic>;
      expect(body.keys.toSet(), {'market', 'side', 'amount', 'price'});
      expect(body['market'], 'DINGO-USDT');
      expect(body['side'], 'buy');
      expect(body['amount'], '8000000');
      // AT priceScale, which is the whole point: 0.00000125 is the price on an
      // 11-place market, and a client that re-rendered it at the quote's six
      // places would send "0.000001" — a different order.
      expect(body['price'], '0.00000125');
      expect(body.containsKey('type'), isFalse,
          reason: 'this venue has no order type');

      // And the venue's OWN outcome is reported, not "order placed".
      expect(find.textContaining('Resting on the book'), findsOneWidget);
    });

    testWidgets('A REFUSED ORDER SHOWS THE VENUE\'S REASON', (tester) async {
      final routes = _routes();
      routes['POST /v1/orders'] = HttpReply(
          400, jsonEncode({'error': 'minimum order is 1000 base units'}));
      final c = await _loaded(tester, routes: routes, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'), '0.00000125');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '8000000');
      await tester.pumpAndSettle();
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(find.textContaining('minimum order is 1000 base units'),
          findsOneWidget);
    });

    testWidgets('A CLOSED MARKET OPENS ITS BOOK AND REFUSES ONLY THE ORDER',
        (tester) async {
      final c = await _loaded(tester, select: 'SOL-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // The book is there.
      expect(find.text('Order book'), findsOneWidget);
      expect(find.text('142.40'), findsOneWidget);
      expect(find.text('142.90'), findsOneWidget);

      // The venue's reason is there in FULL, and the state is named.
      expect(find.text('CLOSED TO NEW ORDERS'), findsOneWidget);
      expect(find.textContaining('we do not hold coins we cannot send'),
          findsOneWidget);
      expect(
          find.textContaining(
              'The book, the trade history and cancelling an order you already '
              'have are all unaffected.'),
          findsOneWidget);

      // And there is NO ticket to submit — not a disabled button that implies
      // the order would otherwise work.
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(SegmentedButton<String>), findsNothing);
      expect(find.textContaining('are refused by the venue right now'),
          findsOneWidget);
    });

    testWidgets('A CAVEATED MARKET STILL TAKES ORDERS, with the gap stated',
        (tester) async {
      // BLOCK-USDT: open, caveated, and listed. The ticket works.
      final routes = _routes();
      routes['GET /public/book/BLOCK-USDT'] = {
        'bids': [
          {'price': '0.041200', 'base': '500'}
        ],
        'asks': [
          {'price': '0.042000', 'base': '400'}
        ],
      };
      routes['GET /public/trades/BLOCK-USDT'] = <Object>[];
      final c = await _loaded(tester, routes: routes, select: 'BLOCK-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      expect(find.text('KNOWN GAP'), findsOneWidget);
      expect(find.textContaining('withdrawals are released by an operator'),
          findsOneWidget);
      expect(find.text('CLOSED TO NEW ORDERS'), findsNothing);
      // The ticket is live.
      expect(find.byType(FilledButton), findsOneWidget);

      // AND NO DOLLAR SIGN. The figure is in USDT and nothing converts it.
      for (final s in _allText(tester)) {
        expect(s, isNot(contains(r'$')), reason: 'dollar sign in "$s"');
      }
    });

    testWidgets('SIGNED OUT, the book is public and the ticket asks for an '
        'account', (tester) async {
      final c = await _loaded(tester, signedIn: false, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // Market data is public and must still render.
      expect(find.text('Order book'), findsOneWidget);
      expect(find.text('0.00000125'), findsOneWidget);
      // The ticket says what is needed, and offers no field to fill in.
      expect(find.textContaining('Sign in to your Blockle account'),
          findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('NO MARKET SELECTED is a prompt, not a blank pane',
        (tester) async {
      final c = await _loaded(tester, routes: _routes(markets: []));
      var asked = 0;
      await _pump(tester, TradeSection(c: c, onPickMarket: () => asked++));
      expect(find.text('Pick a market to trade.'), findsOneWidget);
      await tester.tap(find.text('Choose a market'));
      expect(asked, 1);
    });

    testWidgets('a bad price is reported on the FIELD, not as a priced order',
        (tester) async {
      final c = await _loaded(tester, select: 'DINGO-USDT');
      await _pump(tester, TradeSection(c: c, onPickMarket: () {}));

      // Twelve places on an eleven-place market, with a digit that would be
      // lost. The venue refuses it, and so does the ticket — before anyone
      // taps.
      await tester.enterText(
          find.widgetWithText(TextField, 'Limit price (USDT)'),
          '0.000001234567');
      await tester.enterText(
          find.widgetWithText(TextField, 'Amount (DINGO)'), '8000000');
      await tester.pumpAndSettle();

      expect(find.textContaining('goes to 11 decimal places'), findsOneWidget);
      final btn = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(btn.onPressed, isNull);
    });
  });
}
