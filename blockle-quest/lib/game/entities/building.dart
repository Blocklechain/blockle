import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';
import 'package:flutter/painting.dart';

import '../blocklings_game.dart';
import '../tile_map.dart';

/// A village building. Sits on the ground (bottom-center anchored) and blocks
/// movement via a footprint registered with the map, so you can walk behind the
/// roof but not through the base.
class Building extends PositionComponent {
  final String kind; // house/shop/inn/hall/tower/cabin/blockhall
  final TileMap map;
  final int seed; // deterministic NPC roster
  final int zoneId;
  Sprite? _sprite;
  Rect? _footprint;

  String get kindLabel => switch (kind) {
        'inn' => 'The Inn',
        'shop' => 'General Store',
        'hall' => 'Town Hall',
        'tower' => 'Wizard Tower',
        'cabin' => 'Hunter\'s Cabin',
        'blockhall' => 'Block Guild Hall',
        _ => 'Cottage',
      };

  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;
  final Paint _p = Paint();

  Building({required this.kind, required this.map, required Vector2 position, this.seed = 0, this.zoneId = 0, double px = 84}) {
    this.position = position;
    size = Vector2.all(px);
    anchor = Anchor.bottomCenter;
    priority = position.y.round();
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
    final game = findGame();
    if (game is! BlocklingsGame) return;
    canvas.save();
    canvas.translate(-position.x, -position.y);
    final s = game.project(position.x, position.y);
    final sc = game.scaleAt(s.y);
    final w = size.x * sc, h = size.y * sc;
    _p.color = const Color(0x44000000);
    canvas.drawOval(Rect.fromCenter(center: Offset(s.x, s.y), width: w * 0.7, height: h * 0.14), _p);
    final sp = _sprite;
    if (sp != null) {
      sp.render(canvas, position: Vector2(s.x, s.y), size: Vector2(w, h), anchor: Anchor.bottomCenter, overridePaint: _pixel);
    } else {
      _p.color = const Color(0xFF6B4A2F);
      canvas.drawRect(Rect.fromLTWH(s.x - w / 2, s.y - h * 0.6, w, h * 0.6), _p);
      _p.color = const Color(0xFF8B2E2E);
      canvas.drawRect(Rect.fromLTWH(s.x - w / 2, s.y - h, w, h * 0.35), _p);
    }
    canvas.restore();
  }
}
