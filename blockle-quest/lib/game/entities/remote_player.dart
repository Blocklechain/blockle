import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flutter/painting.dart';

import '../../theme.dart';

/// Another player in the shared world. Position is smoothed toward the latest
/// networked [target] so movement stays fluid between updates.
class RemotePlayer extends PositionComponent {
  final Vector2 target = Vector2.zero();
  int lvl = 1;
  String name = '';

  RemotePlayer(Vector2 pos, this.name, this.lvl) {
    position = pos.clone();
    target.setFrom(pos);
    size = Vector2.all(24);
    anchor = Anchor.center;
    priority = 9;
  }

  @override
  void update(double dt) {
    super.update(dt);
    position.lerp(target, (10 * dt).clamp(0.0, 1.0));
  }

  static final _text = TextPaint(
    style: const TextStyle(color: Bq.text, fontSize: 9, fontWeight: FontWeight.w600),
  );
  final Paint _p = Paint();

  @override
  void render(Canvas canvas) {
    final c = size / 2;
    _p.color = const Color(0xFF4FC3F7); // remote players read as blue vs your purple
    canvas.drawCircle(c.toOffset(), 11, _p);
    _p.color = const Color(0xFF8ED8FA);
    canvas.drawCircle(c.toOffset(), 6, _p);
    if (name.isNotEmpty) {
      _text.render(canvas, name, Vector2(c.x, -12), anchor: Anchor.bottomCenter);
    }
  }
}
