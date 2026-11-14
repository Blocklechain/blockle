import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';
import 'package:flutter/painting.dart';

import '../blocklings_game.dart';
import '../tile_map.dart';

/// A standalone tree: its own billboarded asset standing on the ground with a
/// drop shadow, depth-sorted with everything else, and a small solid trunk
/// footprint (walk behind the canopy, not through the trunk).
class Tree extends PositionComponent {
  final String kind; // oak_0/oak_1/pine_0/pine_1
  final TileMap map;
  Sprite? _sprite;
  Rect? _footprint;

  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;
  final Paint _p = Paint();

  Tree({required this.kind, required this.map, required Vector2 position, double px = 62}) {
    this.position = position;
    size = Vector2.all(px);
    anchor = Anchor.bottomCenter;
    priority = position.y.round();
  }

  @override
  Future<void> onLoad() async {
    try {
      _sprite = await Sprite.load('props/$kind.png');
    } catch (_) {}
    final w = size.x * 0.28, h = size.y * 0.18; // trunk only
    final f = Rect.fromLTWH(position.x - w / 2, position.y - h, w, h);
    _footprint = f;
    map.solidRects.add(f);
  }

  @override
  void onRemove() {
    final f = _footprint;
    if (f != null) map.solidRects.remove(f);
    super.onRemove();
  }

  @override
  void render(Canvas canvas) {
    final game = findGame();
    if (game is! BlocklingsGame) return;
    if (!game.inActiveRoom(position)) return; // other rooms are off-screen
    canvas.save();
    canvas.translate(-position.x, -position.y);
    final s = game.project(position.x, position.y);
    final sc = game.scaleAt(s.y);
    final w = size.x * sc, h = size.y * sc;
    _p.color = const Color(0x44000000);
    canvas.drawOval(Rect.fromCenter(center: Offset(s.x, s.y), width: w * 0.55, height: h * 0.12), _p);
    final sp = _sprite;
    if (sp != null) {
      sp.render(canvas, position: Vector2(s.x, s.y), size: Vector2(w, h), anchor: Anchor.bottomCenter, overridePaint: _pixel);
    } else {
      _p.color = const Color(0xFF2E6B34);
      canvas.drawCircle(Offset(s.x, s.y - h * 0.5), w * 0.35, _p);
    }
    canvas.restore();
  }
}
