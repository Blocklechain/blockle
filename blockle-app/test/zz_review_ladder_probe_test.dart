// SCRATCH PROBE — review only, delete after.

import 'dart:convert';

import 'package:blockle_app/screens/exchange/sections/ladders_section.dart';
import 'package:blockle_app/services/exchange_client.dart';
import 'package:blockle_app/services/transports.dart';
import 'package:blockle_app/state/exchange_controller.dart';
import 'package:blockle_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _closedWhy =
    'ETH deposits and withdrawals are paused while the gas float is topped up.';

void main() {
  testWidgets('LADDER BUILDER on a CLOSED market', (tester) async {
    tester.view.physicalSize = const Size(1200, 5200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final seen = <HttpReq>[];
    final send = (HttpReq req) async {
      seen.add(req);
      final u = Uri.parse(req.url);
      final key = '${req.method} ${u.path}';
      switch (key) {
        case 'GET /public/status':
          return HttpReply(
              200,
              jsonEncode({
                'live': true,
                'mainnetEnabled': true,
                'legalReviewCompleted': true,
                'network': 'mainnet',
              }));
        case 'GET /public/markets':
          return HttpReply(
              200,
              jsonEncode([
                {
                  'symbol': 'ETH-USDT',
                  'base': 'ETH',
                  'quote': 'USDT',
                  'baseDecimals': 18,
                  'quoteDecimals': 6,
                  'priceDecimals': 0,
                  'priceScale': 6,
                  'minBase': '1000000000000000',
                  'minNotional': '5',
                  'closed': _closedWhy,
                },
              ]));
        case 'GET /public/tickers':
          return HttpReply(200, jsonEncode([]));
        case 'GET /public/book/ETH-USDT':
          return HttpReply(200, jsonEncode({'bids': [], 'asks': []}));
        case 'GET /public/trades/ETH-USDT':
          return HttpReply(200, jsonEncode([]));
        case 'GET /v1/fees':
          return HttpReply(
              200, jsonEncode({'makerBps': 20, 'takerBps': 20}));
        case 'GET /v1/liquidity/quote':
          return HttpReply(
              200,
              jsonEncode({
                'market': 'ETH-USDT',
                'breakEvenBps': 40,
                'loses': false,
                'note': 'You earn the spread.',
                'baseNeeded': '0.3',
                'quoteNeeded': '900',
                'bids': [
                  {'price': '2990', 'amount': '0.1'},
                  {'price': '2980', 'amount': '0.1'},
                  {'price': '2970', 'amount': '0.1'},
                ],
                'asks': [
                  {'price': '3010', 'amount': '0.1'},
                  {'price': '3020', 'amount': '0.1'},
                  {'price': '3030', 'amount': '0.1'},
                ],
              }));
        case 'GET /v1/liquidity':
          return HttpReply(200, jsonEncode([]));
        case 'POST /v1/liquidity':
          // What the LIVE venue does: venue.placeOrder throws 409 with the
          // closed sentence, mm.open rolls the whole ladder back.
          return HttpReply(409, jsonEncode({'error': _closedWhy}));
        default:
          return HttpReply(404, jsonEncode({'error': 'no stub for $key'}));
      }
    };

    final c = ExchangeController(
        client: ExchangeClient(send: send, bearer: () => 'sess'));
    await c.loadMarkets();
    await c.loadFees();

    await tester.pumpWidget(MaterialApp(
      theme: Bk.theme(),
      home: Scaffold(body: LaddersSection(c: c)),
    ));
    await tester.pumpAndSettle();

    // 1. Is the market's closed state visible anywhere on this screen?
    expect(find.textContaining(_closedWhy), findsNothing,
        reason: 'the venue\'s closed sentence is nowhere on LADDERS');
    expect(find.textContaining('closed'), findsNothing);
    expect(find.textContaining('CLOSED'), findsNothing);

    // 2. Fill a centre price and let the preview arrive.
    await tester.enterText(find.byType(TextField).at(0), '3000');
    await tester.enterText(find.byType(TextField).at(1), '0.3');
    await tester.enterText(find.byType(TextField).at(2), '900');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    expect(find.text('Break-even'), findsOneWidget,
        reason: 'the preview rendered for a closed market');

    // 3. Is the submit button live?
    final btn = tester.widget<FilledButton>(find.widgetWithText(
        FilledButton, 'Place the ladder'));
    expect(btn.onPressed, isNotNull,
        reason: 'PLACE THE LADDER is enabled on a closed market');

    // 4. Tapping it posts orders to a market that refuses them.
    await tester.tap(find.widgetWithText(FilledButton, 'Place the ladder'));
    await tester.pumpAndSettle();
    expect(seen.where((r) => r.method == 'POST' && r.url.contains('/v1/liquidity')).length, 1,
        reason: 'the app sent an order-placing request for a closed market');
    expect(find.textContaining(_closedWhy), findsOneWidget,
        reason: 'the user learns it is closed only from the 409');
  });
}
