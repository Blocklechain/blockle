import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';
import 'package:vector_math/vector_math_64.dart' as vm;

import '../theme.dart';
import '../world/zones.dart';

enum TileType { grass, grassAlt, tallGrass, path, water, tree, rock, blockstone, sand, snow, ash, bog }

/// The world surface: a bounded 10×10 grid of 100 themed [Zone]s ("chunk maps").
/// Every tile is derived deterministically from its coordinates + the owning
/// zone's theme (same world for everyone, verifiable). Outside the grid is open
/// ocean. Only the camera's visible window is drawn each frame.
class TileMap extends PositionComponent {
  static const double ts = 32; // tile size px

  TileMap() {
    priority = -10;
    position = Vector2.zero();
  }

  final Map<TileType, Sprite?> _sprites = {};

  // Set by the game each frame: the Mode-7 view matrix + player-centre.
  vm.Matrix4 tiltMatrix = vm.Matrix4.identity();
  Vector2 tiltCam = Vector2.zero();

  @override
  Future<void> onLoad() async {
    for (final t in TileType.values) {
      try {
        _sprites[t] = await Sprite.load('tiles/${t.name}.png');
      } catch (_) {
        _sprites[t] = null; // fall back to a flat color
      }
    }
  }

  double get worldWidth => Zones.worldTiles * ts;
  double get worldHeight => Zones.worldTiles * ts;

  int _hash(int x, int y, int salt) {
    var h = x * 73856093 ^ y * 19349663 ^ salt * 83492791;
    h = (h ^ (h >> 13)) & 0x7fffffff;
    return h;
  }

  Zone? zoneAt(int col, int row) => Zones.at(col, row);

  TileType tileAt(int col, int row) {
    final z = Zones.at(col, row);
    if (z == null) return TileType.water; // ocean beyond the world
    final h = _hash(col, row, 1);
    final tree = _hash(col, row, 7) % 1 == 0; // placeholder, overridden below
    switch (z.theme) {
      case ZoneTheme.meadow:
        if (_hash(col, row, 7) % 26 == 0) return TileType.tree;
        if (_hash(col ~/ 3, row ~/ 3, 3) % 6 == 0) return TileType.tallGrass;
        return h % 2 == 0 ? TileType.grass : TileType.grassAlt;
      case ZoneTheme.forest:
        if (h % 4 == 0) return TileType.tree;
        if (_hash(col ~/ 2, row ~/ 2, 5) % 3 == 0) return TileType.tallGrass;
        return TileType.grass;
      case ZoneTheme.swamp:
        if (h % 6 == 0) return TileType.tree;
        if (h % 3 == 0) return TileType.bog; // solid muck
        return TileType.grassAlt;
      case ZoneTheme.desert:
        if (h % 9 == 0) return TileType.rock;
        return TileType.sand;
      case ZoneTheme.tundra:
        if (h % 8 == 0) return TileType.rock;
        if (_hash(col ~/ 3, row ~/ 3, 2) % 5 == 0) return TileType.tallGrass;
        return TileType.snow;
      case ZoneTheme.volcanic:
        if (h % 5 == 0) return TileType.rock;
        if (h % 11 == 0) return TileType.water; // lava pools (impassable)
        return TileType.ash;
      case ZoneTheme.crystal:
        if (h % 6 == 0) return TileType.blockstone;
        return h % 2 == 0 ? TileType.grassAlt : TileType.snow;
      case ZoneTheme.ruins:
        if (h % 5 == 0) return TileType.rock;
        if (h % 9 == 0) return TileType.path;
        return h % 2 == 0 ? TileType.grassAlt : TileType.sand;
      case ZoneTheme.shore:
        final lx = col % Zones.zoneTiles, ly = row % Zones.zoneTiles;
        if (lx < 4 || ly < 4 || lx > Zones.zoneTiles - 5 || ly > Zones.zoneTiles - 5) {
          return h % 2 == 0 ? TileType.sand : TileType.grass;
        }
        return TileType.water;
      case ZoneTheme.blocklands:
        if (h % 7 == 0) return TileType.blockstone;
        if (_hash(col ~/ 2, row ~/ 2, 9) % 4 == 0) return TileType.tallGrass;
        return TileType.grassAlt;
    }
    // ignore: dead_code
    return tree ? TileType.grass : TileType.grass;
  }

  bool solidAt(int col, int row) {
    final t = tileAt(col, row);
    return t == TileType.water ||
        t == TileType.tree ||
        t == TileType.rock ||
        t == TileType.blockstone ||
        t == TileType.bog;
  }

  /// Dynamic solid footprints (buildings) registered by entities.
  final List<Rect> solidRects = [];

  bool solidAtWorld(double wx, double wy) {
    if (solidAt((wx / ts).floor(), (wy / ts).floor())) return true;
    for (final r in solidRects) {
      if (r.contains(Offset(wx, wy))) return true;
    }
    return false;
  }

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
        TileType.sand => const Color(0xFFC9B680),
        TileType.snow => const Color(0xFFD7E6EF),
        TileType.ash => const Color(0xFF3A3236),
        TileType.bog => const Color(0xFF3B4A2A),
      };

  final Paint _p = Paint();
  // Crisp 8-bit scaling: no bilinear smoothing when sprites are drawn larger.
  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;

  @override
  void render(Canvas canvas) {
    // Pitch the ground plane back (Mode-7). Everything drawn here is in flat
    // world coords; the tilt matrix projects it to the receding perspective.
    canvas.save();
    canvas.transform(tiltMatrix.storage);

    final camCol = (tiltCam.x / ts).floor();
    final camRow = (tiltCam.y / ts).floor();
    // Draw a generous window, reaching further "north" toward the horizon.
    for (var row = camRow - 40; row <= camRow + 22; row++) {
      for (var col = camCol - 34; col <= camCol + 34; col++) {
        final t = tileAt(col, row);
        final sp = _sprites[t];
        if (sp != null) {
          sp.render(canvas,
              position: Vector2(col * ts, row * ts), size: Vector2(ts + 0.6, ts + 0.6),
              overridePaint: _pixel);
          continue;
        }
        _p.color = _colorFor(t);
        canvas.drawRect(Rect.fromLTWH(col * ts, row * ts, ts + 0.6, ts + 0.6), _p);
        if (t == TileType.tree || t == TileType.rock || t == TileType.blockstone) {
          _p.color = t == TileType.blockstone ? Bq.accent : const Color(0xFF1A1A1F);
          canvas.drawRect(Rect.fromLTWH(col * ts + 6, row * ts + 6, ts - 12, ts - 12), _p);
        }
      }
    }
    canvas.restore();
  }

  /// A walkable tile near a world point (for spawns/respawns).
  Vector2 nearestOpen(Vector2 near) {
    final c0 = (near.x / ts).floor();
    final r0 = (near.y / ts).floor();
    for (var radius = 1; radius < 40; radius++) {
      for (var r = r0 - radius; r <= r0 + radius; r++) {
        for (var c = c0 - radius; c <= c0 + radius; c++) {
          if (Zones.at(c, r) != null && !solidAt(c, r)) {
            return Vector2(c * ts + ts / 2, r * ts + ts / 2);
          }
        }
      }
    }
    return near.clone();
  }

  /// World-pixel center of the spawn zone (middle of the grid).
  Vector2 get spawnPoint {
    const mid = Zones.worldTiles ~/ 2;
    return nearestOpen(Vector2(mid * ts.toDouble(), mid * ts.toDouble()));
  }
}
