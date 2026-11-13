import 'package:flame/components.dart' show Vector2;
import 'package:flutter/material.dart';

import '../theme.dart';

/// Drag-to-move control. Touch anywhere in the pad zone and drag: a floating
/// thumbstick appears under your finger and steers the player in the drag
/// direction, with speed scaling by how far you pull (up to the ring). Release
/// to stop. Emits a movement vector (magnitude 0..1) via [onChanged].
class DPad extends StatefulWidget {
  final void Function(Vector2 dir) onChanged;
  const DPad({super.key, required this.onChanged});

  @override
  State<DPad> createState() => _DPadState();
}

class _DPadState extends State<DPad> {
  static const double _radius = 62;
  Offset? _origin;
  Offset _current = Offset.zero;

  void _emit() {
    if (_origin == null) {
      widget.onChanged(Vector2.zero());
      return;
    }
    final d = _current - _origin!;
    var v = Vector2(d.dx, d.dy);
    final len = v.length;
    if (len > 0) v = v / len * (len.clamp(0.0, _radius) / _radius);
    widget.onChanged(v);
  }

  void _start(Offset p) {
    _origin = p;
    _current = p;
    _emit();
    setState(() {});
  }

  void _move(Offset p) {
    _current = p;
    _emit();
    setState(() {});
  }

  void _end() {
    _origin = null;
    _emit();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final active = _origin != null;
    // Knob position clamped to the ring.
    Offset knob = _current;
    if (active) {
      final d = _current - _origin!;
      if (d.distance > _radius) knob = _origin! + d / d.distance * _radius;
    }
    return SizedBox(
      width: 230,
      height: 230,
      child: Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: (e) => _start(e.localPosition),
        onPointerMove: (e) => _move(e.localPosition),
        onPointerUp: (_) => _end(),
        onPointerCancel: (_) => _end(),
        child: CustomPaint(
          painter: _StickPainter(active ? _origin : const Offset(70, 160), active ? knob : null, active),
        ),
      ),
    );
  }
}

class _StickPainter extends CustomPainter {
  final Offset? base;
  final Offset? knob;
  final bool active;
  _StickPainter(this.base, this.knob, this.active);

  @override
  void paint(Canvas canvas, Size size) {
    if (base == null) return;
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..color = Bq.text.withValues(alpha: active ? 0.4 : 0.18);
    canvas.drawCircle(base!, 62, ring);
    final hub = Paint()..color = Bq.panel.withValues(alpha: active ? 0.55 : 0.28);
    canvas.drawCircle(base!, 62, hub);
    final k = Paint()..color = (active ? Bq.accent : Bq.panel2).withValues(alpha: active ? 0.9 : 0.5);
    canvas.drawCircle(knob ?? base!, 26, k);
  }

  @override
  bool shouldRepaint(covariant _StickPainter old) =>
      old.base != base || old.knob != knob || old.active != active;
}
