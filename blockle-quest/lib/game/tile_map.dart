import 'dart:ui';

import 'package:flame/components.dart';

import '../theme.dart';

enum TileType { grass, grassAlt, tallGrass, path, water, tree, rock, blockstone }

enum Biome { plains, forest, lake, rocky, blocklands }

/// An **open, chunked, procedurally-generated world** — effectively infinite.
/// Nothing is stored: every tile is derived on the fly from its coordinates
/// (deterministic, so the world is identical for every player and verifiable),
/// grouped into [chunk]-sized regions that each roll a biome. Only the tiles in
/// the camera's view are drawn each frame.
class TileMap extends PositionComponent {
  static const double ts = 32; // tile size px
  static const int chunk = 24; // tiles per chunk edge

  TileMap() {
    priority = -10;
    position = Vector2.zero();
  }

  // Large logical bounds (used for clamping/spawns; the world is effectively open).
  double get worldWidth => (1 << 22).toDouble();
  double get worldHeight => (1 << 22).toDouble();

  int _hash(int x, int y, int salt) {
    var h = x * 73856093 ^ y * 19349663 ^ salt * 83492791;
    h = (h ^ (h >> 13)) & 0x7fffffff;
    return h;
  }

  Biome biomeAt(int col, int row) {
    final cc = (col >= 0 ? col : col - chunk + 1) ~/ chunk;
    final cr = (row >= 0 ? row : row - chunk + 1) ~/ chunk;
    final r = _hash(cc, cr, 101) % 100;
    if (r < 40) return Biome.plains;
    if (r < 64) return Biome.forest;
    if (r < 80) return Biome.lake;
    if (r < 95) return Biome.rocky;
    return Biome.blocklands;
  }

  TileType tileAt(int col, int row) {
    final biome = biomeAt(col, row);
    final h = _hash(col, row, 1);
    switch (biome) {
      case Biome.plains:
        if (_hash(col, row, 7) % 23 == 0) return TileType.tree;
        if (_hash(col ~/ 3, row ~/ 3, 3) % 6 == 0) return TileType.tallGrass;
        return h % 2 == 0 ? TileType.grass : TileType.grassAlt;
      case Biome.forest:
        if (h % 4 == 0) return TileType.tree; // dense, solid
        if (_hash(col ~/ 2, row ~/ 2, 5) % 3 == 0) return TileType.tallGrass;
        return TileType.grass;
      case Biome.lake:
        // A lake with grassy shores at the chunk edge.
        final lx = col % chunk, ly = row % chunk;
        final edge = lx < 3 || ly < 3 || lx > chunk - 4 || ly > chunk - 4;
        if (edge) return h % 2 == 0 ? TileType.grass : TileType.tallGrass;
        return TileType.water;
      case Biome.rocky:
        if (h % 5 == 0) return TileType.rock; // solid
        return h % 2 == 0 ? TileType.path : TileType.grassAlt;
      case Biome.blocklands:
        if (h % 7 == 0) return TileType.blockstone; // solid, violet
        if (_hash(col ~/ 2, row ~/ 2, 9) % 4 == 0) return TileType.tallGrass;
        return TileType.grassAlt;
    }
  }

  bool solidAt(int col, int row) {
    final t = tileAt(col, row);
    return t == TileType.water || t == TileType.tree || t == TileType.rock || t == TileType.blockstone;
  }

  bool solidAtWorld(double wx, double wy) => solidAt((wx / ts).floor(), (wy / ts).floor());

  bool tallGrassAtWorld(double wx, double wy) =>
      tileAt((wx / ts).floor(), (wy / ts).floor()) == TileType.tallGrass;

  Color _colorFor(TileType t) => switch (t) {
        TileType.grass => Bq.grass,
        TileType.grassAlt => Bq.grassAlt,
        TileType.tallGrass => Bq.tallGrass,
        TileType.path => Bq.path,
        TileType.water => Bq.water,
        TileType.tree => Bq.tree,
        TileType.rock => const Color(0xFF4A4A55),
        TileType.blockstone => const Color(0xFF3A2A66),
      };

  final Paint _p = Paint();

  @override
  void render(Canvas canvas) {
    final game = findGame();
    if (game == null) return;
    final view = game.camera.visibleWorldRect;
    final c0 = (view.left / ts).floor() - 1;
    final r0 = (view.top / ts).floor() - 1;
    final c1 = (view.right / ts).ceil() + 1;
    final r1 = (view.bottom / ts).ceil() + 1;

    for (var row = r0; row <= r1; row++) {
      for (var col = c0; col <= c1; col++) {
        final t = tileAt(col, row);
        _p.color = _colorFor(t);
        canvas.drawRect(Rect.fromLTWH(col * ts, row * ts, ts + 0.5, ts + 0.5), _p);
        if (t == TileType.tree) {
          _p.color = const Color(0xFF0C2612);
          canvas.drawCircle(Offset(col * ts + ts / 2, row * ts + ts / 2), ts * 0.42, _p);
        } else if (t == TileType.rock) {
          _p.color = const Color(0xFF2E2E38);
          canvas.drawCircle(Offset(col * ts + ts / 2, row * ts + ts / 2), ts * 0.36, _p);
        } else if (t == TileType.blockstone) {
          _p.color = Bq.accent;
          canvas.drawRect(Rect.fromLTWH(col * ts + 7, row * ts + 7, ts - 14, ts - 14), _p);
        } else if (t == TileType.tallGrass) {
          _p.color = const Color(0x3300160A);
          canvas.drawRect(Rect.fromLTWH(col * ts + 4, row * ts + 10, ts - 8, ts - 14), _p);
        }
      }
    }
  }

  /// A walkable tile near a world point (for spawns/respawns).
  Vector2 nearestOpen(Vector2 near) {
    final c0 = (near.x / ts).floor();
    final r0 = (near.y / ts).floor();
    for (var radius = 1; radius < 24; radius++) {
      for (var r = r0 - radius; r <= r0 + radius; r++) {
        for (var c = c0 - radius; c <= c0 + radius; c++) {
          if (!solidAt(c, r)) return Vector2(c * ts + ts / 2, r * ts + ts / 2);
        }
      }
    }
    return near.clone();
  }
}
