import 'package:flutter/painting.dart';

import '../models/blockling.dart' show Element;

/// Visual/gameplay themes a zone can take.
enum ZoneTheme { meadow, forest, swamp, desert, tundra, volcanic, crystal, ruins, shore, blocklands }

/// One of the 100 zones ("chunk maps") that tile the open world in a 10×10 grid.
/// Everything is derived deterministically from the zone id, so the world is the
/// same for every player and verifiable. Difficulty rises with distance from the
/// central spawn, so the map reads as concentric level bands.
class Zone {
  final int id; // 0..99
  final int zx; // 0..9
  final int zy; // 0..9
  final ZoneTheme theme;
  final int tier; // 0 (center) .. higher at the edges
  final Element elementBias;

  const Zone(this.id, this.zx, this.zy, this.theme, this.tier, this.elementBias);

  int get minLevel => 1 + tier * 6;
  int get maxLevel => minLevel + 7;
  String get name => Zones.nameFor(id);

  /// Gentler zones sometimes hold a village (a cluster of buildings). The spawn
  /// zone is ALWAYS a village — the player starts among buildings.
  bool get isVillage {
    if (zx == Zones.grid ~/ 2 && zy == Zones.grid ~/ 2) return true; // spawn zone
    return tier <= 3 && ((id * 2654435761) & 0x7fffffff) % 5 == 0;
  }
  String get bossName => '${_bossAdj[id % _bossAdj.length]} ${_bossNoun[(id ~/ 7) % _bossNoun.length]}';

  Color get accent => switch (theme) {
        ZoneTheme.meadow => const Color(0xFF6FCF67),
        ZoneTheme.forest => const Color(0xFF2E8B57),
        ZoneTheme.swamp => const Color(0xFF6B8E23),
        ZoneTheme.desert => const Color(0xFFE2C275),
        ZoneTheme.tundra => const Color(0xFFBFE3F2),
        ZoneTheme.volcanic => const Color(0xFFE5705A),
        ZoneTheme.crystal => const Color(0xFF7FD1FF),
        ZoneTheme.ruins => const Color(0xFFBFA98A),
        ZoneTheme.shore => const Color(0xFF4FC3F7),
        ZoneTheme.blocklands => const Color(0xFF7C5CFF),
      };
}

const _bossAdj = ['Ancient', 'Dread', 'Gilded', 'Frost', 'Molten', 'Shadow', 'Storm', 'Verdant', 'Astral', 'Cursed'];
const _bossNoun = ['Warden', 'Colossus', 'Serpent', 'Golem', 'Drake', 'Sentinel', 'Behemoth', 'Wyrm'];

/// The 100-zone world registry.
class Zones {
  static const int grid = 10; // 10 x 10 = 100 zones
  static const int zoneTiles = 48; // tiles per zone edge
  static const int worldTiles = grid * zoneTiles; // 480 tiles across
  static const int count = grid * grid; // 100

  static final List<Zone> all = List.generate(count, _build);

  static Zone byId(int id) => all[id.clamp(0, count - 1)];

  /// Zone at a tile coordinate, or null if outside the world (open ocean).
  static Zone? at(int col, int row) {
    if (col < 0 || row < 0 || col >= worldTiles || row >= worldTiles) return null;
    final zx = col ~/ zoneTiles;
    final zy = row ~/ zoneTiles;
    return all[zy * grid + zx];
  }

  static Zone? atWorld(double wx, double wy, double tileSize) =>
      at((wx / tileSize).floor(), (wy / tileSize).floor());

  static int _hash(int a, int b) {
    var h = a * 73856093 ^ b * 19349663;
    h = (h ^ (h >> 13)) & 0x7fffffff;
    return h;
  }

  static Zone _build(int id) {
    final zx = id % grid, zy = id ~/ grid;
    // Chebyshev ring distance from the central spawn -> difficulty tier.
    final cx = (grid - 1) / 2, cy = (grid - 1) / 2;
    final tier = ((zx - cx).abs() > (zy - cy).abs() ? (zx - cx).abs() : (zy - cy).abs()).round();
    // Theme: center is gentle meadow/forest; outward themes vary deterministically.
    final ZoneTheme theme;
    if (tier == 0) {
      theme = ZoneTheme.meadow;
    } else if (tier == 1) {
      theme = ZoneTheme.values[[ZoneTheme.forest, ZoneTheme.meadow, ZoneTheme.shore][_hash(zx, zy) % 3].index];
    } else if (tier >= 4 && _hash(id, 9) % 4 == 0) {
      theme = ZoneTheme.blocklands; // rare high-tier end-game zones
    } else {
      theme = ZoneTheme.values[_hash(id, 3) % ZoneTheme.values.length];
    }
    final elementBias = Element.values[_hash(id, 5) % Element.values.length];
    return Zone(id, zx, zy, theme, tier, elementBias);
  }

  // 100 unique zone names from 10 descriptors × 10 locales.
  static String nameFor(int id) => '${_adj[id ~/ grid]} ${_noun[id % grid]}';

  static const _adj = [
    'Verdant', 'Sunken', 'Ashen', 'Golden', 'Frozen', 'Whispering', 'Shattered', 'Umbral', 'Astral', 'Blockforged'
  ];
  static const _noun = [
    'Meadows', 'Hollow', 'Expanse', 'Reach', 'Wastes', 'Thicket', 'Spires', 'Marsh', 'Dunes', 'Bastion'
  ];
}
