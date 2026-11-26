// screens/exchange/sections/price_chart.dart — the traded-price line.
//
// The one thing the web's Trade page had that the app's did not: a price line
// above the ladder (app.html #chart). Same data, same sentence when there is
// nothing to draw.
//
// WHAT IT PLOTS, AND WHAT IT REFUSES TO.
//
// The venue publishes no candles and no OHLC — `/public/trades/:market` is the
// only price history there is. So this is the executed-trade price in order,
// and nothing more: no interpolation across gaps, no synthetic open/close, no
// moving average. A chart that invents a shape the venue never reported would
// be the prettiest lie in the app.
//
// THE ONE PLACE A PRICE BECOMES A DOUBLE. Everywhere else in this app a price
// is the decimal STRING the API sent, because an 18-decimal amount does not
// survive a float. Plotting is the documented exception — the web's own header
// says it in the same words — because a pixel coordinate IS a double and
// nothing is settled from it.
//
// THE LABELS ARE WIDGETS, NOT CANVAS TEXT, and that is deliberate twice over.
// They carry the venue's own strings, so no figure a user can read off this
// chart came out of a float; and text painted into a canvas is invisible to
// screen readers and to the widget tests, so an axis drawn that way is both
// inaccessible and unverifiable.
//
// Fewer than two trades is not an empty chart, it is a different statement:
// "No trades yet on this market." — the web's exact sentence, so a user moving
// between the two surfaces is told the same thing.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../theme.dart';

/// Height of the plot. Tall enough to read a trend on a 390pt phone, short
/// enough that the ladder — which is what people actually trade off — is still
/// close to the fold under it.
const double kPriceChartHeight = 132;

/// Room on the right for the price labels, which is where the eye ends up.
const double _kGutter = 78;
const double _kPadV = 10;

class PriceChart extends StatelessWidget {
  const PriceChart({super.key, required this.market, required this.trades});

  final ExchangeMarket market;

  /// The tape as the venue returns it: NEWEST FIRST. Reversed before plotting.
  final List<Map<String, dynamic>> trades;

  @override
  Widget build(BuildContext context) {
    // Oldest -> newest, keeping only prices that parse. A row we cannot read is
    // DROPPED, never counted as zero: a zero would drag the low to 0 and
    // flatten every real price against the top of the plot — a wrong shape
    // presented with full confidence.
    final series = <double>[];
    final texts = <String>[];
    for (final t in trades.reversed) {
      final raw = t['price'];
      final s = raw is String ? raw : raw?.toString();
      if (s == null) continue;
      final v = double.tryParse(s);
      if (v == null || !v.isFinite) continue;
      series.add(v);
      texts.add(s);
    }

    if (series.length < 2) {
      return const SizedBox(
        height: kPriceChartHeight,
        child: Center(
          child: Text(
            'No trades yet on this market.',
            style: TextStyle(color: Bk.muted, fontSize: 13),
          ),
        ),
      );
    }

    var lo = series.first;
    var hi = series.first;
    var loIdx = 0;
    var hiIdx = 0;
    for (var i = 0; i < series.length; i++) {
      if (series[i] < lo) {
        lo = series[i];
        loIdx = i;
      }
      if (series[i] > hi) {
        hi = series[i];
        hiIdx = i;
      }
    }

    // A FLAT MARKET IS NOT A DIVIDE BY ZERO. Every trade at one price is a real
    // and common state on a thin market; it draws as a centre line, and it
    // prints its price ONCE — the same figure as high, low AND last reads like
    // a rendering fault.
    final flat = (hi - lo).abs() < 1e-18;
    final rising = series.last >= series.first;
    final accent = rising ? Bk.good : Bk.bad;

    const plotH = kPriceChartHeight - _kPadV * 2;
    double yOf(double v) =>
        flat ? _kPadV + plotH / 2 : _kPadV + (1 - (v - lo) / (hi - lo)) * plotH;

    return SizedBox(
      height: kPriceChartHeight,
      child: Stack(children: [
        Positioned.fill(
          right: _kGutter,
          child: CustomPaint(
            painter: _PriceLinePainter(
              series: series,
              lo: lo,
              hi: hi,
              flat: flat,
              accent: accent,
            ),
            child: const SizedBox.expand(),
          ),
        ),
        // High / low, only when there is a range to describe.
        if (!flat) ...[
          _AxisLabel(top: _kPadV - 7, text: texts[hiIdx]),
          _AxisLabel(top: _kPadV + plotH - 7, text: texts[loIdx]),
        ],
        // The last trade: the only figure on here people act on, so it is the
        // one that gets the accent and the weight.
        _AxisLabel(
          top: (yOf(series.last) - 7).clamp(0.0, kPriceChartHeight - 14),
          text: texts.last,
          color: accent,
          bold: true,
        ),
      ]),
    );
  }
}

class _AxisLabel extends StatelessWidget {
  const _AxisLabel({
    required this.top,
    required this.text,
    this.color = Bk.muted,
    this.bold = false,
  });

  final double top;
  final String text;
  final Color color;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: top,
      right: 0,
      width: _kGutter - 6,
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: TextAlign.right,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
    );
  }
}

class _PriceLinePainter extends CustomPainter {
  _PriceLinePainter({
    required this.series,
    required this.lo,
    required this.hi,
    required this.flat,
    required this.accent,
  });

  final List<double> series;
  final double lo;
  final double hi;
  final bool flat;
  final Color accent;

  @override
  void paint(Canvas canvas, Size size) {
    final plotH = size.height - _kPadV * 2;
    if (size.width <= 1 || plotH <= 1) return;

    double xAt(int i) => (i / (series.length - 1)) * size.width;
    double yAt(double v) =>
        flat ? _kPadV + plotH / 2 : _kPadV + (1 - (v - lo) / (hi - lo)) * plotH;

    // Faint grid: top, middle, bottom. Three lines is enough to read a level
    // against; more turns into texture.
    final grid = Paint()
      ..color = Bk.line
      ..strokeWidth = 1;
    for (final f in const [0.0, 0.5, 1.0]) {
      final y = _kPadV + f * plotH;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    // Area under the line, so the direction reads before the numbers do.
    final fill = Path()..moveTo(xAt(0), yAt(series[0]));
    for (var i = 1; i < series.length; i++) {
      fill.lineTo(xAt(i), yAt(series[i]));
    }
    fill
      ..lineTo(xAt(series.length - 1), _kPadV + plotH)
      ..lineTo(xAt(0), _kPadV + plotH)
      ..close();
    canvas.drawPath(fill, Paint()..color = accent.withValues(alpha: 0.12));

    final path = Path()..moveTo(xAt(0), yAt(series[0]));
    for (var i = 1; i < series.length; i++) {
      path.lineTo(xAt(i), yAt(series[i]));
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = accent
        ..strokeWidth = 2
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );

    canvas.drawCircle(
      Offset(xAt(series.length - 1), yAt(series.last)),
      3,
      Paint()..color = accent,
    );
  }

  @override
  bool shouldRepaint(_PriceLinePainter old) =>
      old.series.length != series.length ||
      old.series.last != series.last ||
      old.lo != lo ||
      old.hi != hi ||
      old.accent != accent;
}
