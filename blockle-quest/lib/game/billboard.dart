import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';
import 'package:flame/text.dart';
import 'package:flutter/painting.dart';

/// Draws an upright, depth-scaled billboard on the tilted ground: a soft drop
/// shadow, the sprite standing with its feet at the ground point, an optional
/// HP bar and name. Shared by every world entity so they read consistently.
class Billboard {
  static final Paint _p = Paint();

  static final TextPaint _name = TextPaint(
    style: const TextStyle(color: Color(0xFFFFD27A), fontSize: 8, fontWeight: FontWeight.w800),
  );

  static void draw(
    Canvas canvas,
    Vector2 s,
    double sc, {
    Sprite? sprite,
    required Paint pixel,
    double baseW = 30,
    double baseH = 30,
    bool facingLeft = false,
    double bob = 0,
    Color fallbackColor = const Color(0xFF7C5CFF),
    double? hpFrac,
    Color hpColor = const Color(0xFF3FD17A),
    String? name,
  }) {
    // Ground shadow.
    _p.color = const Color(0x55000000);
    canvas.drawOval(
      Rect.fromCenter(center: Offset(s.x, s.y), width: baseW * 0.72 * sc, height: baseH * 0.26 * sc),
      _p,
    );

    final w = baseW * sc, h = baseH * sc, by = bob * sc;
    if (sprite != null) {
      canvas.save();
      if (facingLeft) {
        canvas.translate(2 * s.x, 0);
        canvas.scale(-1, 1); // mirror about the sprite centre
      }
      sprite.render(canvas,
          position: Vector2(s.x, s.y - by), size: Vector2(w, h), anchor: Anchor.bottomCenter, overridePaint: pixel);
      canvas.restore();
    } else {
      _p.color = fallbackColor;
      canvas.drawCircle(Offset(s.x, s.y - h * 0.4), h * 0.3, _p);
    }

    if (hpFrac != null) {
      final f = hpFrac.clamp(0.0, 1.0);
      final bw = baseW * 0.8 * sc, yy = s.y - h - 4 * sc;
      _p.color = const Color(0xAA000000);
      canvas.drawRect(Rect.fromLTWH(s.x - bw / 2, yy, bw, 3.5 * sc), _p);
      _p.color = f > 0.3 ? hpColor : const Color(0xFFE5484D);
      canvas.drawRect(Rect.fromLTWH(s.x - bw / 2, yy, bw * f, 3.5 * sc), _p);
    }

    if (name != null && name.isNotEmpty) {
      _name.render(canvas, name, Vector2(s.x, s.y - h - 8 * sc), anchor: Anchor.bottomCenter);
    }
  }
}
