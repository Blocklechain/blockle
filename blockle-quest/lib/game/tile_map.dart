import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';
import 'package:vector_math/vector_math_64.dart' as vm;

import '../theme.dart';
import '../world/zones.dart';

/// Collision-only tile kinds (visuals come from the room's scene painting).
enum TileType { grass, tallGrass, path, water, fence }

/// SINGLE-SCREEN ROOMS. The world is a grid of rooms (16×16 tiles = 512 logical
/// px); the game screen shows exactly ONE room — one whole AI-painted scene —
/// and walking out through a gate cuts to the next room. No scrolling, no two
/// scenes ever on screen together (so no seams, ever).
///
/// Zones (realms) are 3×3 rooms. Gates sit at the midpoint of each room edge:
/// always open between rooms of the SAME realm; across realms only the middle
/// room of the shared edge connects (the realm's "small entrance"), and lane
/// realms seal their north/south entrances.
class TileMap extends PositionComponent {
  static const double ts = 32; // logical tile size px
  static const int roomTiles = 16; // tiles per room edge
  static const double roomPx = roomTiles * ts; // 512 logical px

  TileMap() {
    priority = -10;
    position = Vector2.zero();
  }

  final Map<String, List<Sprite>> _scenes = {};
  final List<Sprite> _fenceProps = [];
  static const int sceneVariants = 4;

  // Set by the game each frame: the room view (scale+translate) + active room.
  vm.Matrix4 roomView = vm.Matrix4.identity();
  Vector2 roomOrigin = Vector2.zero(); // world px of the active room's top-left

  double get worldWidth => Zones.worldTiles * ts;
  double get worldHeight => Zones.worldTiles * ts;

  static const _themeScene = {
    ZoneTheme.meadow: 'meadow',
    ZoneTheme.forest: 'forest',
    ZoneTheme.swamp: 'swamp',
    ZoneTheme.desert: 'desert',
    ZoneTheme.tundra: 'tundra',
    ZoneTheme.volcanic: 'volcanic',
    ZoneTheme.crystal: 'crystal',
    ZoneTheme.ruins: 'ruins',
    ZoneTheme.shore: 'shore',
    ZoneTheme.blocklands: 'blocklands',
  };

  @override
  Future<void> onLoad() async {
    for (final name in {..._themeScene.values, 'village_ground'}) {
      final list = <Sprite>[];
      for (var v = 0; v < sceneVariants; v++) {
        try {
          list.add(await Sprite.load('scenes/${name}_$v.png'));
        } catch (_) {}
      }
      if (list.isNotEmpty) _scenes[name] = list;
    }
    for (final f in const ['props/fence_0.png', 'props/fence_1.png']) {
      try {
        _fenceProps.add(await Sprite.load(f));
      } catch (_) {}
    }
  }

  int _hash(int x, int y, int salt) {
    var h = x * 73856093 ^ y * 19349663 ^ salt * 83492791;
    h = (h ^ (h >> 13)) & 0x7fffffff;
    return h;
  }

  bool _gateBand(int v) => (v % roomTiles - roomTiles ~/ 2).abs() <= 1;

  /// Collision grid: room borders are fences with gated openings.
  TileType tileAt(int col, int row) {
    final z = Zones.at(col, row);
    if (z == null) return TileType.water; // beyond the world

    final lx = col % roomTiles, ly = row % roomTiles;
    if (lx == 0 || ly == 0) {
      // West edge of this room.
      if (lx == 0 && _gateBand(row)) {
        final west = Zones.at(col - 1, row);
        if (west != null) {
          final sameZone = west.id == z.id;
          // Across realms: only the middle room of the shared edge connects.
          final middleRoom = (row ~/ roomTiles) % 3 == 1;
          if (sameZone || middleRoom) return TileType.path;
        }
      }
      // North edge of this room.
      if (ly == 0 && _gateBand(col)) {
        final north = Zones.at(col, row - 1);
        if (north != null) {
          final sameZone = north.id == z.id;
          final middleRoom = (col ~/ roomTiles) % 3 == 1;
          final laneOk =
              z.movement == ZoneMovement.omni && north.movement == ZoneMovement.omni;
          if (sameZone || (middleRoom && laneOk)) return TileType.path;
        }
      }
      return TileType.fence;
    }

    // Invisible tall grass for wild encounters.
    if (_hash(col ~/ 2, row ~/ 2, 3) % 6 == 0) return TileType.tallGrass;
    return TileType.grass;
  }

  bool solidAt(int col, int row) {
    final t = tileAt(col, row);
    return t == TileType.water || t == TileType.fence;
  }

  /// Dynamic solid footprints (buildings, tree trunks).
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

  final Paint _p = Paint();
  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;

  @override
  void render(Canvas canvas) {
    canvas.save();
    canvas.transform(roomView.storage);

    final rc = (roomOrigin.x / ts).round(); // room's first tile col
    final rr = (roomOrigin.y / ts).round();

    // The room's single scene painting, filling the room exactly.
    final z = Zones.at(rc + 1, rr + 1);
    final rect = Rect.fromLTWH(roomOrigin.x, roomOrigin.y, roomPx, roomPx);
    if (z == null) {
      _p.color = Bq.water;
      canvas.drawRect(rect, _p);
    } else {
      final key = z.isVillage ? 'village_ground' : _themeScene[z.theme]!;
      final list = _scenes[key];
      if (list == null || list.isEmpty) {
        _p.color = Bq.grass;
        canvas.drawRect(rect, _p);
      } else {
        final sp = list[_hash(rc ~/ roomTiles, rr ~/ roomTiles, 9) % list.length];
        sp.render(canvas,
            position: Vector2(rect.left, rect.top),
            size: Vector2(rect.width, rect.height),
            overridePaint: _pixel);
      }
    }

    // Border wall segments (with gate gaps) around THIS room, drawn with a
    // slight upward overhang so they read as standing walls.
    for (var i = 0; i <= roomTiles; i++) {
      for (final t in [
        [rc + i, rr], // north edge (and i==roomTiles covers the NE corner)
        [rc, rr + i], // west edge
        [rc + i, rr + roomTiles], // south edge (next room's north line)
        [rc + roomTiles, rr + i], // east edge (next room's west line)
      ]) {
        final col = t[0], row = t[1];
        if (tileAt(col, row) != TileType.fence) continue;
        final x = col * ts, y = row * ts;
        if (_fenceProps.isNotEmpty) {
          final sp = _fenceProps[_hash(col, row, 21) % _fenceProps.length];
          sp.render(canvas,
              position: Vector2(x, y - 12),
              size: Vector2(ts, ts + 12),
              overridePaint: _pixel);
        } else {
          _p.color = const Color(0xFF7A5C3A);
          canvas.drawRect(Rect.fromLTWH(x, y - 8, ts, ts + 8), _p);
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

  /// Centre of the spawn VILLAGE zone's middle room.
  Vector2 get spawnPoint {
    const mid = (Zones.grid ~/ 2) * Zones.zoneTiles + Zones.zoneTiles ~/ 2;
    return nearestOpen(Vector2(mid * ts + ts / 2, (mid + 2) * ts + ts / 2));
  }
}
