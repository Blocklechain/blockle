import 'dart:math';
import 'package:flutter/material.dart';
import '../theme.dart';

/// An interactive animated logo: a cloud of particles orbiting a glowing core,
/// forming the Blockle cube. Touch/drag attracts the particles toward the
/// finger; release and they settle back into the lattice.
class ParticleLogo extends StatefulWidget {
  const ParticleLogo({super.key, this.size = 160});
  final double size;

  @override
  State<ParticleLogo> createState() => _ParticleLogoState();
}

class _Particle {
  double hx, hy; // home (lattice) position, normalized -1..1
  double x, y; // current
  double vx = 0, vy = 0;
  double r;
  _Particle(this.hx, this.hy, this.r)
      : x = hx,
        y = hy;
}

class _ParticleLogoState extends State<ParticleLogo>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  final _rng = Random(42);
  final List<_Particle> _ps = [];
  Offset? _touch; // normalized -1..1
  double _t = 0;

  @override
  void initState() {
    super.initState();
    _seed();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
    _ctrl.addListener(() => setState(() => _t += 0.016));
  }

  void _seed() {
    // A ring + inner scatter that reads as a glowing cube of nodes.
    const ringCount = 26;
    for (var i = 0; i < ringCount; i++) {
      final a = (i / ringCount) * 2 * pi;
      final rad = 0.72 + _rng.nextDouble() * 0.06;
      _ps.add(_Particle(cos(a) * rad, sin(a) * rad, 1.6 + _rng.nextDouble() * 1.6));
    }
    for (var i = 0; i < 34; i++) {
      final a = _rng.nextDouble() * 2 * pi;
      final rad = _rng.nextDouble() * 0.6;
      _ps.add(_Particle(cos(a) * rad, sin(a) * rad, 1.0 + _rng.nextDouble() * 1.8));
    }
  }

  void _step() {
    for (final p in _ps) {
      // spring back to home, with a gentle breathing orbit
      final breathe = 1 + 0.03 * sin(_t * 1.3 + p.hx * 3);
      final tx = p.hx * breathe;
      final ty = p.hy * breathe;
      var ax = (tx - p.x) * 0.06;
      var ay = (ty - p.y) * 0.06;
      if (_touch != null) {
        final dx = _touch!.dx - p.x;
        final dy = _touch!.dy - p.y;
        final d2 = dx * dx + dy * dy + 0.02;
        final f = 0.08 / d2;
        ax += dx * f;
        ay += dy * f;
      }
      p.vx = (p.vx + ax) * 0.86;
      p.vy = (p.vy + ay) * 0.86;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  Offset _toNorm(Offset local) {
    final s = widget.size;
    return Offset((local.dx / s) * 2 - 1, (local.dy / s) * 2 - 1);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _step();
    return GestureDetector(
      onPanStart: (d) => _touch = _toNorm(d.localPosition),
      onPanUpdate: (d) => _touch = _toNorm(d.localPosition),
      onPanEnd: (_) => _touch = null,
      onPanCancel: () => _touch = null,
      onTapDown: (d) => _touch = _toNorm(d.localPosition),
      onTapUp: (_) => _touch = null,
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        child: CustomPaint(painter: _LogoPainter(_ps, _t)),
      ),
    );
  }
}

class _LogoPainter extends CustomPainter {
  _LogoPainter(this.ps, this.t);
  final List<_Particle> ps;
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final scale = size.width / 2;
    Offset pos(_Particle p) => c + Offset(p.x * scale * 0.9, p.y * scale * 0.9);

    // glow core
    final glow = Paint()
      ..shader = const RadialGradient(colors: [Bk.accent, Colors.transparent])
          .createShader(Rect.fromCircle(center: c, radius: scale));
    canvas.drawCircle(c, scale, glow..color = Bk.accent.withValues(alpha: 0.25));

    // links between nearby particles
    final link = Paint()
      ..strokeWidth = 0.8
      ..style = PaintingStyle.stroke;
    for (var i = 0; i < ps.length; i++) {
      for (var j = i + 1; j < ps.length; j++) {
        final a = pos(ps[i]);
        final b = pos(ps[j]);
        final d = (a - b).distance;
        if (d < scale * 0.42) {
          final alpha = (1 - d / (scale * 0.42)) * 0.35;
          link.color = Bk.accent2.withValues(alpha: alpha);
          canvas.drawLine(a, b, link);
        }
      }
    }

    // particles
    for (final p in ps) {
      final a = pos(p);
      final pulse = 1 + 0.25 * sin(t * 2 + p.hx * 4 + p.hy * 4);
      final dot = Paint()
        ..color = Color.lerp(Bk.accent, Bk.accent2, (p.hx + 1) / 2)!
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.2);
      canvas.drawCircle(a, p.r * pulse, dot);
    }
  }

  @override
  bool shouldRepaint(covariant _LogoPainter old) => true;
}
