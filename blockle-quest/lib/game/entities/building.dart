import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';
import 'package:flutter/painting.dart';

import '../tile_map.dart';

/// A village building. Sits on the ground (bottom-center anchored) and blocks
/// movement via a footprint registered with the map, so you can walk behind the
/// roof but not through the base.
class Building extends PositionComponent {
  final String kind; // house/shop/inn/hall/tower/cabin/blockhall
  final TileMap map;
  Sprite? _sprite;
  Rect? _footprint;

  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;
  final Paint _p = Paint();

  Building({required this.kind, required this.map, required Vector2 position, double px = 84}) {
    this.position = position;
    size = Vector2.all(px);
    anchor = Anchor.bottomCenter;
    priority = 3;
  }

  @override
  Future<void> onLoad() async {
    try {
      _sprite = await Sprite.load('buildings/$kind.png');
    } catch (_) {}
    // Footprint: the lower-middle of the building (walk behind the roof).
    final w = size.x * 0.72, h = size.y * 0.40;
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
    final sp = _sprite;
    if (sp != null) {
      sp.render(canvas, position: Vector2.zero(), size: size, overridePaint: _pixel);
    } else {
      _p.color = const Color(0xFF6B4A2F);
      canvas.drawRect(Rect.fromLTWH(0, size.y * 0.4, size.x, size.y * 0.6), _p);
      _p.color = const Color(0xFF8B2E2E);
      canvas.drawRect(Rect.fromLTWH(0, size.y * 0.2, size.x, size.y * 0.25), _p);
    }
  }
}
