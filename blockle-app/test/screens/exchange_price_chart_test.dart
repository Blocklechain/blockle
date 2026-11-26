// The price line: what it draws, and what it refuses to draw.
//
// The chart is the one place in the exchange UI where a price becomes a double,
// so these tests exist to pin the boundary of that exception: the SHAPE may
// come from floats (a pixel coordinate is a float), but every figure a user can
// read must still be the venue's own string, and a market with nothing to plot
// must say so rather than render an empty box.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/screens/exchange/sections/price_chart.dart';
import 'package:blockle_app/services/exchange_client.dart';

ExchangeMarket _market() => const ExchangeMarket(
      id: 'BLOCK-USDT',
      base: 'BLOCK',
      quote: 'USDT',
      baseDecimals: 8,
      quoteDecimals: 6,
      priceDecimals: 6,
    );

/// The tape as the venue sends it: NEWEST FIRST.
List<Map<String, dynamic>> _tape(List<String> newestFirst) =>
    newestFirst.map((p) => <String, dynamic>{'price': p, 'base': '1'}).toList();

Future<void> _pump(WidgetTester tester, List<Map<String, dynamic>> trades) =>
    tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 360,
          child: PriceChart(market: _market(), trades: trades),
        ),
      ),
    ));

void main() {
  testWidgets('A MARKET WITH NO TRADES SAYS SO — the web\'s exact sentence',
      (tester) async {
    await _pump(tester, const []);
    expect(find.text('No trades yet on this market.'), findsOneWidget);
  });

  testWidgets('ONE TRADE IS NOT A LINE, so it says so too', (tester) async {
    // A single point has no direction and no range. Drawing it as a flat line
    // across the full width would assert a history that does not exist.
    await _pump(tester, _tape(['1.5']));
    expect(find.text('No trades yet on this market.'), findsOneWidget);
  });

  testWidgets('THE LABELS ARE THE VENUE\'S STRINGS, not reformatted doubles',
      (tester) async {
    // 0.000001 would render as "1e-6" through a bare double toString, and
    // 18-decimal figures lose digits entirely. The label must be byte-identical
    // to what the venue sent.
    await _pump(tester, _tape(['0.000001', '0.000003', '0.000002']));
    expect(find.text('0.000003'), findsOneWidget, reason: 'high label');
    // NEWEST-FIRST IN, so the last plotted point is the FIRST element — and
    // here it is also the low, which is a real and common shape (a market that
    // just printed its lowest trade). The figure then appears TWICE on purpose:
    // once as the low on the axis, once as the accented last-trade marker.
    expect(find.text('0.000001'), findsNWidgets(2),
        reason: 'the low axis label and the last-trade marker coincide');
  });

  testWidgets('A FLAT MARKET DRAWS, and prints its price once not three times',
      (tester) async {
    // Every trade at the same price is normal on a thin market and must not
    // divide by zero; printing the identical figure as high, low AND last
    // reads like a rendering fault.
    await _pump(tester, _tape(['2.5', '2.5', '2.5', '2.5']));
    expect(find.text('No trades yet on this market.'), findsNothing);
    expect(find.text('2.5'), findsOneWidget,
        reason: 'printed ONCE, not as high + low + last');
  });

  testWidgets('AN UNREADABLE ROW IS DROPPED, never counted as zero',
      (tester) async {
    // A zero would drag the low to 0 and flatten every real price against the
    // top of the plot — a wrong shape presented with full confidence.
    final trades = <Map<String, dynamic>>[
      {'price': '10', 'base': '1'},
      {'price': 'not-a-number', 'base': '1'},
      {'price': null, 'base': '1'},
      {'price': '12', 'base': '1'},
    ];
    await _pump(tester, trades);
    expect(find.text('No trades yet on this market.'), findsNothing);
    expect(find.text('0'), findsNothing, reason: 'no fabricated zero');
    // Reversed: 12 then 10, so 12 is the high and 10 is both the low and the
    // last — same coincidence as above.
    expect(find.text('12'), findsOneWidget, reason: 'high');
    expect(find.text('10'), findsNWidgets(2), reason: 'low and last');
  });

  testWidgets('it renders without overflowing a phone-width column',
      (tester) async {
    await _pump(tester, _tape(['1', '2', '3', '4', '5', '6', '7', '8']));
    expect(tester.takeException(), isNull);
  });
}
