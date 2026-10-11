// charts.dart — the Bots dataviz: a sparkline, the deal-ladder preview, and the
// Arena simulation chart. Follows the dataviz method of the shared reference:
// ONE value axis, thin marks, the validated categorical triad (kBase/kSafety/
// kTp) for the ladder and the diverging gain/loss pair for P&L, a neutral zero,
// and a table fallback (the stat tiles beside each chart carry the same numbers).
//
// The deal-ladder preview is computed with the REAL engine helpers (bots.dart:
// qtyForUsd floors, valueOf/avgEntryOf round half-away, applyBps, scaledUsdUc) so
// the picture is the exact math a paper/live deal would execute — never a mock.

import 'package:flutter/material.dart';

import '../../agent/bots.dart' as b;
import 'bots_tokens.dart';

// ===========================================================================
// Deal-ladder preview — engine-exact projection of a DCA config at [priceUsd].
// ===========================================================================
class DealLeg {
  final String kind; // 'base' | 'safety'
  final double priceUsd;
  final double usd;
  const DealLeg(this.kind, this.priceUsd, this.usd);
}

class DealPreview {
  final List<DealLeg> legs;
  final double avgEntryUsd;
  final double takeProfitUsd;
  final double maxDealUsd;
  final double dipPct; // how far the ladder covers below the entry
  final double lowUsd; // lowest safety price (chart floor)
  final double highUsd; // take-profit (chart ceiling)
  const DealPreview({
    required this.legs,
    required this.avgEntryUsd,
    required this.takeProfitUsd,
    required this.maxDealUsd,
    required this.dipPct,
    required this.lowUsd,
    required this.highUsd,
  });

  /// Compute the ladder from a DCA config, using the engine's integer math.
  static DealPreview fromDca({
    required double baseOrderUsd,
    required int safetyOrders,
    required double stepPct,
    required double volumeScale,
    required double takeProfitPct,
    required double priceUsd,
    int decimals = 9,
  }) {
    final bd = decimals;
    final priceUc = b.microUsd(priceUsd);
    final legs = <DealLeg>[];
    var totalQty = BigInt.zero;
    var totalCost = BigInt.zero;
    var maxDealUc = BigInt.zero;

    // base order
    final baseUc = b.microUsd(baseOrderUsd);
    final baseQty = b.qtyForUsd(baseUc, priceUc, bd);
    final baseCost = b.valueOf(baseQty, priceUc, bd);
    legs.add(DealLeg('base', priceUsd, baseOrderUsd));
    totalQty += baseQty;
    totalCost += baseCost;
    maxDealUc += baseUc;

    final stepBps = b.pctToBps(stepPct);
    var p = priceUc;
    for (var k = 1; k <= safetyOrders; k++) {
      p = b.applyBps(p, -stepBps);
      final sizeUc = b.scaledUsdUc(baseOrderUsd, volumeScale, k);
      final qty = b.qtyForUsd(sizeUc, p, bd);
      totalQty += qty;
      totalCost += b.valueOf(qty, p, bd);
      maxDealUc += sizeUc;
      legs.add(DealLeg('safety', (b.ucToUsd(p) ?? 0), (b.ucToUsd(sizeUc) ?? 0)));
    }

    final avgUc = b.avgEntryOf(totalCost, totalQty, bd);
    final tpUc = b.applyBps(avgUc, b.pctToBps(takeProfitPct));
    final lastUc = p;
    final dip = priceUc > BigInt.zero
        ? (priceUc - lastUc).toDouble() / priceUc.toDouble() * 100
        : 0.0;
    return DealPreview(
      legs: legs,
      avgEntryUsd: b.ucToUsd(avgUc) ?? 0,
      takeProfitUsd: b.ucToUsd(tpUc) ?? 0,
      maxDealUsd: b.ucToUsd(maxDealUc) ?? 0,
      dipPct: dip,
      lowUsd: b.ucToUsd(lastUc) ?? 0,
      highUsd: b.ucToUsd(tpUc) ?? 0,
    );
  }
}

// ===========================================================================
// Sparkline — area + line, colored by direction (diverging gain/loss).
// ===========================================================================
class Sparkline extends StatelessWidget {
  const Sparkline({
    super.key,
    required this.data,
    required this.up,
    this.mini = false,
    this.height,
  });
  final List<double> data;
  final bool up;
  final bool mini;
  final double? height;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return SizedBox(
      height: height ?? (mini ? 26 : 72),
      width: double.infinity,
      child: CustomPaint(
        painter: _SparkPainter(data, up ? t.gain : t.loss, mini, t.surface),
      ),
    );
  }
}

class _SparkPainter extends CustomPainter {
  _SparkPainter(this.data, this.color, this.mini, this.surface);
  final List<double> data;
  final Color color;
  final bool mini;
  final Color surface;

  @override
  void paint(Canvas canvas, Size size) {
    if (data.length < 2) return;
    final pad = mini ? 2.0 : 6.0;
    final min = data.reduce((a, c) => a < c ? a : c);
    final max = data.reduce((a, c) => a > c ? a : c);
    final rng = (max - min).abs() < 1e-9 ? 1.0 : (max - min);
    double x(int i) => pad + i / (data.length - 1) * (size.width - pad * 2);
    double y(double v) => size.height - pad - (v - min) / rng * (size.height - pad * 2);

    final line = Path()..moveTo(x(0), y(data[0]));
    for (var i = 1; i < data.length; i++) {
      line.lineTo(x(i), y(data[i]));
    }
    final area = Path.from(line)
      ..lineTo(x(data.length - 1), size.height - pad)
      ..lineTo(x(0), size.height - pad)
      ..close();
    canvas.drawPath(
      area,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [color.withValues(alpha: 0.27), color.withValues(alpha: 0)],
        ).createShader(Offset.zero & size),
    );
    canvas.drawPath(
      line,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = mini ? 1.5 : 2
        ..strokeJoin = StrokeJoin.round
        ..color = color,
    );
    if (!mini) {
      final lx = x(data.length - 1), ly = y(data.last);
      canvas.drawCircle(Offset(lx, ly), 3.5, Paint()..color = color);
      canvas.drawCircle(
          Offset(lx, ly),
          6.5,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2
            ..color = color.withValues(alpha: 0.33));
    }
  }

  @override
  bool shouldRepaint(_SparkPainter old) =>
      old.data != data || old.color != color;
}

// ===========================================================================
// Deal-ladder chart — one price axis; base (diamond), safety (circle), TP (tri).
// ===========================================================================
class LadderChart extends StatelessWidget {
  const LadderChart({super.key, required this.preview, required this.priceUsd});
  final DealPreview preview;
  final double priceUsd;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return SizedBox(
      height: 300,
      width: double.infinity,
      child: CustomPaint(painter: _LadderPainter(preview, priceUsd, t)),
    );
  }
}

class _LadderPainter extends CustomPainter {
  _LadderPainter(this.p, this.price, this.t);
  final DealPreview p;
  final double price;
  final BotTokens t;

  TextPainter _tp(String s, Color c, {double size = 11}) {
    final tp = TextPainter(
      text: TextSpan(
          text: s,
          style: TextStyle(
              color: c, fontSize: size, fontFamily: kMonoFamily, height: 1)),
      textDirection: TextDirection.ltr,
    )..layout();
    return tp;
  }

  @override
  void paint(Canvas canvas, Size size) {
    const padL = 54.0, padR = 16.0, padT = 14.0, padB = 20.0;
    final lo = (p.lowUsd < p.avgEntryUsd ? p.lowUsd : p.avgEntryUsd) * 0.995;
    final hi = p.highUsd * 1.004;
    final rng = (hi - lo).abs() < 1e-9 ? 1.0 : (hi - lo);
    double yv(double v) => padT + (hi - v) / rng * (size.height - padT - padB);
    final plotW = size.width - padL - padR;

    // gridlines + price labels (one axis)
    for (var g = 0; g <= 5; g++) {
      final val = lo + rng * g / 5, y = yv(val);
      canvas.drawLine(Offset(padL, y), Offset(size.width - padR, y),
          Paint()..color = t.lineSoft..strokeWidth = 1);
      final lbl = _tp('\$${val.toStringAsFixed(1)}', t.inkFaint);
      lbl.paint(canvas, Offset(padL - 9 - lbl.width, y - lbl.height / 2));
    }

    // current price (dashed) + avg-entry band
    final cy = yv(price);
    _dashed(canvas, Offset(padL, cy), Offset(size.width - padR, cy),
        t.inkMuted, 1.2);
    _tp('now \$${price.toStringAsFixed(1)}', t.inkMuted)
        .paint(canvas, Offset(padL + 6, cy - 20));
    final ay = yv(p.avgEntryUsd);
    canvas.drawRect(
      Rect.fromLTRB(padL, ay < cy ? ay : cy, padL + plotW, ay < cy ? cy : ay),
      Paint()..color = t.accentGhost,
    );

    void marker(double y, Color color, String shape, String label, double? usd) {
      canvas.drawLine(Offset(padL, y), Offset(padL + plotW * 0.62, y),
          Paint()..color = color..strokeWidth = 2.5);
      final mx = padL + plotW * 0.62 + 10;
      final paint = Paint()..color = color;
      if (shape == 'diamond') {
        canvas.save();
        canvas.translate(mx, y);
        canvas.rotate(0.785398);
        canvas.drawRect(const Rect.fromLTWH(-4, -4, 8, 8), paint);
        canvas.restore();
      } else if (shape == 'tri') {
        final path = Path()
          ..moveTo(mx, y - 5)
          ..lineTo(mx + 5, y + 4)
          ..lineTo(mx - 5, y + 4)
          ..close();
        canvas.drawPath(path, paint);
      } else {
        canvas.drawCircle(Offset(mx, y), 4.2, paint);
      }
      _tp(label, t.inkMuted).paint(canvas, Offset(mx + 11, y - 6));
      if (usd != null) {
        final u = _tp('\$${usd.round()}', t.inkFaint);
        u.paint(canvas, Offset(size.width - padR - u.width, y - u.height / 2));
      }
    }

    // take-profit (triangle, green)
    marker(yv(p.takeProfitUsd), t.kTp, 'tri',
        'TP \$${p.takeProfitUsd.toStringAsFixed(1)}', null);
    // avg-entry line (dashed, accent)
    _dashed(canvas, Offset(padL, ay), Offset(size.width - padR, ay), t.accent, 1.4);
    _tp('avg \$${p.avgEntryUsd.toStringAsFixed(1)}', t.accent)
        .paint(canvas, Offset(padL + 6, ay + 2));
    // orders
    for (var i = 0; i < p.legs.length; i++) {
      final lg = p.legs[i];
      if (lg.kind == 'base') {
        marker(yv(lg.priceUsd), t.kBase, 'diamond', 'Base', lg.usd);
      } else {
        marker(yv(lg.priceUsd), t.kSafety, 'circle', 'SO$i', lg.usd);
      }
    }
  }

  void _dashed(Canvas c, Offset a, Offset bPt, Color color, double w) {
    final paint = Paint()..color = color..strokeWidth = w;
    const dash = 4.0, gap = 4.0;
    final total = (bPt - a).distance;
    final dir = (bPt - a) / total;
    var d = 0.0;
    while (d < total) {
      final s = a + dir * d;
      final e = a + dir * (d + dash).clamp(0, total);
      c.drawLine(s, e, paint);
      d += dash + gap;
    }
  }

  @override
  bool shouldRepaint(_LadderPainter old) => old.p != p || old.price != price || old.t != t;
}

// ===========================================================================
// Arena sim chart — price path (area+line) with buy (diamond) / sell (triangle)
// fills up to [upto]. The equity numbers live in the stat tiles (table fallback).
// ===========================================================================
class SimChart extends StatelessWidget {
  const SimChart({
    super.key,
    required this.path,
    required this.fills,
    this.upto,
  });
  final List<double> path;
  final List<Map<String, dynamic>> fills; // {t, side, priceUsd}
  final int? upto;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return SizedBox(
      height: 280,
      width: double.infinity,
      child: CustomPaint(painter: _SimPainter(path, fills, upto, t)),
    );
  }
}

class _SimPainter extends CustomPainter {
  _SimPainter(this.path, this.fills, this.upto, this.t);
  final List<double> path;
  final List<Map<String, dynamic>> fills;
  final int? upto;
  final BotTokens t;

  @override
  void paint(Canvas canvas, Size size) {
    if (path.length < 2) return;
    const padL = 46.0, padR = 14.0, padT = 12.0, padB = 16.0;
    var lo = path.reduce((a, c) => a < c ? a : c);
    var hi = path.reduce((a, c) => a > c ? a : c);
    var rng = (hi - lo).abs() < 1e-9 ? 1.0 : (hi - lo);
    lo -= rng * 0.08;
    hi += rng * 0.08;
    rng = hi - lo;
    double x(int i) => padL + i / (path.length - 1) * (size.width - padL - padR);
    double yv(double v) => padT + (hi - v) / rng * (size.height - padT - padB);

    for (var g = 0; g <= 4; g++) {
      final val = lo + rng * g / 4, y = yv(val);
      canvas.drawLine(Offset(padL, y), Offset(size.width - padR, y),
          Paint()..color = t.lineSoft..strokeWidth = 1);
      final lbl = TextPainter(
        text: TextSpan(
            text: '\$${val.toStringAsFixed(0)}',
            style: TextStyle(color: t.inkFaint, fontSize: 10, fontFamily: kMonoFamily)),
        textDirection: TextDirection.ltr,
      )..layout();
      lbl.paint(canvas, Offset(padL - 7 - lbl.width, y - lbl.height / 2));
    }

    final up = (upto ?? path.length - 1).clamp(0, path.length - 1);
    final line = Path()..moveTo(x(0), yv(path[0]));
    for (var i = 1; i <= up; i++) {
      line.lineTo(x(i), yv(path[i]));
    }
    final area = Path.from(line)
      ..lineTo(x(up), size.height - padB)
      ..lineTo(x(0), size.height - padB)
      ..close();
    canvas.drawPath(
      area,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [t.accent.withValues(alpha: 0.2), t.accent.withValues(alpha: 0)],
        ).createShader(Offset.zero & size),
    );
    canvas.drawPath(
      line,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeJoin = StrokeJoin.round
        ..color = t.accent,
    );

    for (final f in fills) {
      final ti = f['t'] as int;
      if (ti > up) continue;
      final px = x(ti), py = yv((f['priceUsd'] as num).toDouble());
      final buy = f['side'] == 'buy';
      final paint = Paint()..color = buy ? t.kBase : t.kTp;
      if (buy) {
        canvas.save();
        canvas.translate(px, py);
        canvas.rotate(0.785398);
        canvas.drawRect(const Rect.fromLTWH(-3.5, -3.5, 7, 7), paint);
        canvas.restore();
      } else {
        final tri = Path()
          ..moveTo(px, py - 5)
          ..lineTo(px + 5, py + 4)
          ..lineTo(px - 5, py + 4)
          ..close();
        canvas.drawPath(tri, paint);
      }
    }
    final hx = x(up), hy = yv(path[up]);
    canvas.drawCircle(Offset(hx, hy), 3.5, Paint()..color = t.accent);
  }

  @override
  bool shouldRepaint(_SimPainter old) =>
      old.path != path || old.upto != upto || old.fills != fills || old.t != t;
}
