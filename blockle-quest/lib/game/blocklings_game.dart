import 'dart:math' as math;

import 'package:flame/components.dart';
import 'package:flame/game.dart';
import 'package:flame/input.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:vector_math/vector_math_64.dart' as vm;

import '../account/character.dart';
import '../economy/economy.dart';
import '../models/blockling.dart';
import '../models/item.dart';
import '../quests/quests.dart';
import '../skills/skills.dart';
import '../theme.dart';
import '../world/zones.dart';
import '../net/net_client.dart';
import 'entities/building.dart';
import 'entities/companion.dart';
import 'entities/enemy.dart';
import 'entities/player.dart';
import 'entities/remote_player.dart';
import 'entities/tree.dart';
import 'entities/vendor.dart';
import 'tile_map.dart';

/// The Blocklings game: an open, chunked world with real-time combat, an
/// auto-combat mode, a Blockling companion, and crypto/NFT loot. UI (HUD,
/// inventory, wallet, marketplace) is Flutter overlays over this.
class BlocklingsGame extends FlameGame {
  final CharacterProfile profile;
  BlocklingsGame({required this.profile});

  final econ = EconomyService.instance;

  late TileMap map;
  late Player player;
  Companion? companion;
  final List<Enemy> enemies = [];

  /// Movement vector from the on-screen D-pad (set by the HUD).
  final Vector2 dpad = Vector2.zero();
  bool autoCombat = true;

  // Multiplayer presence (best-effort; single-player if the relay is down).
  final NetClient net = NetClient();
  final Map<String, RemotePlayer> remotePlayers = {};
  double _posAcc = 0;

  int _seq = 0;
  // Stubbed chain height for provably-fair seeds; swap for the live height.
  int blockHeight = 2_100_000;
  static const int targetEnemies = 7;

  final quests = QuestLog.instance;
  final skills = SkillsState.instance;
  int? _zoneId; // current zone (for banner + explore quests)

  // SINGLE-SCREEN ROOM VIEW: the screen shows exactly one room (one painted
  // scene); the camera is fixed per room and cuts on room change.
  double _roomScale = 1;
  final Vector2 _roomOff = Vector2.zero();
  final Vector2 roomOrigin = Vector2.zero();
  String _roomKey = '';

  Vector2 project(double wx, double wy) => Vector2(
      (wx - roomOrigin.x) * _roomScale + _roomOff.x,
      (wy - roomOrigin.y) * _roomScale + _roomOff.y);
  double scaleAt(double screenY) => _roomScale;

  /// Is a world point inside the active room (+margin)? Used to cull entities
  /// that live in other rooms — only the current screen's cast is drawn.
  bool inActiveRoom(Vector2 p, [double margin = 60]) =>
      p.x >= roomOrigin.x - margin &&
      p.y >= roomOrigin.y - margin &&
      p.x < roomOrigin.x + TileMap.roomPx + margin &&
      p.y < roomOrigin.y + TileMap.roomPx + margin;

  /// Title-screen cinematic: the camera drifts across the world until the
  /// player presses Enter World. While cinematic, streaming (villages/vendors)
  /// follows the drifting camera, input/HUD are hidden, and nothing toasts.
  bool cinematic = true;
  double _cineT = 0;
  final Vector2 _cinePos = Vector2.zero();

  /// What the camera + world streaming centre on.
  Vector2 get focus => cinematic ? _cinePos : player.position;

  /// overlays.add that tolerates hosts without the overlay registered (tests).
  void _tryOverlay(String name) {
    try {
      overlays.add(name);
    } catch (_) {}
  }

  /// Leave the title cinematic and drop into the world.
  void enterWorld() {
    if (!cinematic) return;
    cinematic = false;
    _addControls(); // reveal the on-screen attack button now (hidden on title)
    if (profile.multiplayer) {
      net.onChat = (name, msg) => toast.value = '$name: $msg';
      net.connect(NetClient.defaultUrl, name: profile.name);
    }
    overlays.remove('title');
    overlays.add('hud');
  }

  // Vendors: one market stall per nearby zone; the nearest in range is shoppable.
  final Map<int, Vendor> vendors = {};
  Vendor? nearbyVendor;

  // Nearest enterable building within range of the player (null otherwise).
  Building? nearbyBuilding;

  // One unique boss per zone, guarding it until defeated.
  final Set<int> bossesDefeated = {};
  final Map<int, Enemy> _bosses = {};

  // Villages: a cluster of buildings in some zones.
  final Map<int, List<Building>> _villages = {};
  // Standalone trees, streamed per zone.
  final Map<int, List<Tree>> _trees = {};
  static const _buildingKinds = ['house', 'shop', 'inn', 'house', 'blockhall', 'cabin', 'tower', 'hall'];

  /// Bumped on notable events (loot/level) so the HUD/toasts can react.
  final ValueNotifier<String> toast = ValueNotifier('');

  @override
  Future<void> onLoad() async {
    econ.seed();
    econ.seedMarket();

    map = TileMap();
    world.add(map);

    player = Player(map: map)..position = map.spawnPoint;
    world.add(player);

    // Starter Blockling companion — the element chosen at character creation.
    final starter = Blockling.ofElement(profile.starterElement);
    econ.addBlockling(starter);
    companion = Companion(mon: starter, player: player);
    world.add(companion!);

    // No Flame camera follow — the player-centred Tilt projection IS the camera.
    camera.viewfinder.anchor = Anchor.topLeft;
    camera.viewfinder.zoom = 1.0;

    // Controls (attack button) + the multiplayer connection are owned by
    // enterWorld() — nothing is wired up while the title cinematic plays.
    for (var i = 0; i < targetEnemies; i++) {
      _spawnEnemy();
    }
  }

  @override
  void onRemove() {
    net.dispose();
    super.onRemove();
  }

  void _syncRemotes() {
    // Add/update remote players from the latest network snapshot.
    net.remotes.forEach((id, s) {
      final rp = remotePlayers[id];
      if (rp == null) {
        final np = RemotePlayer(Vector2(s.x, s.y), s.name, s.lvl);
        remotePlayers[id] = np;
        world.add(np);
      } else {
        rp.target.setValues(s.x, s.y);
        rp.name = s.name;
        rp.lvl = s.lvl;
      }
    });
    // Drop players who left.
    remotePlayers.keys.where((id) => !net.remotes.containsKey(id)).toList().forEach((id) {
      remotePlayers.remove(id)?.removeFromParent();
    });
  }

  void _addControls() {
    // Movement is the Flutter D-pad (HUD overlay -> game.dpad); attack is a HUD
    // button rendered by Flame on the right.
    final attackBtn = HudButtonComponent(
      button: CircleComponent(radius: 30, paint: Paint()..color = Bq.accent),
      margin: const EdgeInsets.only(right: 30, bottom: 48),
      onPressed: playerAttack,
    );
    camera.viewport.add(attackBtn);
  }

  Enemy? _nearestEnemy({double within = 1e9}) {
    Enemy? best;
    var bd = within;
    for (final e in enemies) {
      if (e.dead) continue;
      final d = e.position.distanceTo(player.position);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  void playerAttack() {
    if (!player.attackReady) return;
    final e = _nearestEnemy(within: player.attackRange);
    if (e == null) return;
    e.takeDamage(player.atk);
    player.resetCooldown();
  }

  void toggleAuto() => autoCombat = !autoCombat;

  @override
  void update(double dt) {
    super.update(dt);

    // Title cinematic: drift a slow, wide Lissajous across the world, centred
    // on the spawn point. Everything else (input, combat, networking) is off.
    if (cinematic) {
      _cineT += dt;
      final sp = map.spawnPoint;
      _cinePos.setValues(
        sp.x + math.cos(_cineT * 0.05) * 2800,
        sp.y + math.sin(_cineT * 0.035) * 2200,
      );
    }

    // Refresh the fixed room view for this frame: which room the focus is in,
    // scaled to fit the screen (letterboxed; bars stay dark).
    const rp = TileMap.roomPx;
    roomOrigin.setValues((focus.x / rp).floorToDouble() * rp, (focus.y / rp).floorToDouble() * rp);
    _roomScale = (size.x / rp) < (size.y / rp) ? size.x / rp : size.y / rp;
    _roomOff.setValues((size.x - rp * _roomScale) / 2, (size.y - rp * _roomScale) / 2);
    final view = vm.Matrix4.identity()
      ..translate(_roomOff.x, _roomOff.y)
      ..scale(_roomScale, _roomScale, 1.0)
      ..translate(-roomOrigin.x, -roomOrigin.y);
    map.roomView = view;
    map.roomOrigin.setFrom(roomOrigin);

    // Room-change cut: a quick dark fade between rooms (the zone loading screen
    // covers realm changes; no fades during the title cinematic).
    final rk = '${roomOrigin.x.toInt()},${roomOrigin.y.toInt()}';
    if (rk != _roomKey) {
      final first = _roomKey.isEmpty;
      _roomKey = rk;
      if (!first && !cinematic && !overlays.isActive('zoneload')) {
        _tryOverlay('roomfade');
      }
    }

    if (cinematic) {
      // Stream the world along the drifting camera only (~10Hz).
      _posAcc += dt;
      if (_posAcc >= 0.1) {
        _posAcc = 0;
        _updateVendors();
        _updateVillages();
        _updateTrees();
      }
      return;
    }

    // Movement is ALWAYS manual (the D-pad). The player never auto-moves.
    player.velocity.setFrom(dpad);
    // Side-scroller realms: movement is left/right only (lanes seal their
    // north/south gates, so travel through them is horizontal).
    final moveZone = Zones.atWorld(player.position.x, player.position.y, TileMap.ts);
    if (moveZone?.movement == ZoneMovement.lane) player.velocity.y = 0;
    // Auto-combat only auto-ATTACKS a foe that is already within reach.
    if (autoCombat) playerAttack();

    companion?.fight(enemies, dt);

    // Resolve deaths + loot.
    for (final e in enemies.where((e) => e.dead).toList()) {
      if (e.isBoss) {
        bossesDefeated.add(e.bossZoneId!);
        _bosses.remove(e.bossZoneId);
      }
      _loot(e);
      e.removeFromParent();
      enemies.remove(e);
    }
    // Keep the world populated near the player.
    while (enemies.length < targetEnemies) {
      _spawnEnemy();
    }

    // Player death -> respawn with an XP nick.
    if (player.hp <= 0) {
      player.respawn(map.nearestOpen(player.position));
      player.xp = (player.xp * 0.8).round();
      toast.value = 'You were downed — respawned.';
    }

    // Zone transitions: a brief loading screen + explore quests.
    final zone = Zones.atWorld(player.position.x, player.position.y, TileMap.ts);
    if (zone != null && zone.id != _zoneId) {
      final first = _zoneId == null;
      _zoneId = zone.id;
      quests.onExplore(zone.id);
      if (!first) _tryOverlay('zoneload'); // not on initial spawn
    }

    // Multiplayer + vendors: ~10Hz.
    _posAcc += dt;
    if (_posAcc >= 0.1) {
      _posAcc = 0;
      net.sendPos(player.position.x, player.position.y, player.level);
      _syncRemotes();
      _updateVendors();
      _updateBoss();
      _updateVillages();
      _updateTrees();
      // Nearest enterable building within range (for the HUD door button).
      nearbyBuilding = null;
      var bb = 70.0;
      for (final list in _villages.values) {
        for (final b in list) {
          final d = b.position.distanceTo(player.position);
          if (d < bb) {
            bb = d;
            nearbyBuilding = b;
          }
        }
      }
    }
  }

  void _updateVillages() {
    final pz = Zones.atWorld(focus.x, focus.y, TileMap.ts);
    if (pz == null) return;
    const offs = [
      [-5, -3], [0, -4], [5, -3], [-4, 2], [3, 2], [-1, 5],
    ];
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        final zx = pz.zx + dx, zy = pz.zy + dy;
        if (zx < 0 || zy < 0 || zx >= Zones.grid || zy >= Zones.grid) continue;
        final z = Zones.all[zy * Zones.grid + zx];
        if (!z.isVillage || _villages.containsKey(z.id)) continue;
        final cx = zx * Zones.zoneTiles + Zones.zoneTiles ~/ 2;
        final cy = zy * Zones.zoneTiles + Zones.zoneTiles ~/ 2;
        final list = <Building>[];
        for (var i = 0; i < offs.length; i++) {
          final wx = (cx + offs[i][0]) * TileMap.ts;
          final wy = (cy + offs[i][1]) * TileMap.ts;
          if (map.solidAtWorld(wx, wy)) continue;
          final b = Building(
              kind: _buildingKinds[(z.id + i) % _buildingKinds.length],
              map: map,
              position: Vector2(wx, wy),
              seed: z.id * 10 + i,
              zoneId: z.id);
          list.add(b);
          world.add(b);
        }
        _villages[z.id] = list;
      }
    }
    _villages.keys.where((id) {
      final zx = id % Zones.grid, zy = id ~/ Zones.grid;
      return (zx - pz.zx).abs() > 2 || (zy - pz.zy).abs() > 2;
    }).toList().forEach((id) {
      for (final b in _villages.remove(id)!) {
        b.removeFromParent();
      }
    });
  }

  /// Standalone trees per zone: deterministic scatter, denser in forests,
  /// pines in the cold, sparse in deserts/volcanic; kept clear of the village
  /// centre and the fence borders.
  void _updateTrees() {
    final pz = Zones.atWorld(focus.x, focus.y, TileMap.ts);
    if (pz == null) return;
    int countFor(Zone z) => switch (z.theme) {
          ZoneTheme.forest => 9,
          ZoneTheme.meadow => 4,
          ZoneTheme.tundra || ZoneTheme.shore || ZoneTheme.swamp => 3,
          ZoneTheme.ruins || ZoneTheme.crystal || ZoneTheme.blocklands => 2,
          _ => 1,
        };
    int h(int a, int b) {
      var x = a * 73856093 ^ b * 19349663;
      return (x ^ (x >> 13)) & 0x7fffffff;
    }

    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        final zx = pz.zx + dx, zy = pz.zy + dy;
        if (zx < 0 || zy < 0 || zx >= Zones.grid || zy >= Zones.grid) continue;
        final z = Zones.all[zy * Zones.grid + zx];
        if (_trees.containsKey(z.id)) continue;
        final list = <Tree>[];
        final n = countFor(z);
        for (var i = 0; i < n; i++) {
          // Interior scatter, away from the borders (4..43) by construction.
          final tx = 4 + h(z.id * 31 + i, 5) % 40;
          final ty = 4 + h(z.id * 31 + i, 11) % 40;
          if (z.isVillage) {
            final mid = Zones.zoneTiles ~/ 2;
            if ((tx - mid).abs() < 9 && (ty - mid).abs() < 9) continue; // plaza
          }
          final wx = (zx * Zones.zoneTiles + tx) * TileMap.ts;
          final wy = (zy * Zones.zoneTiles + ty) * TileMap.ts;
          if (map.solidAtWorld(wx, wy)) continue;
          final cold = z.theme == ZoneTheme.tundra || z.theme == ZoneTheme.forest && i.isOdd;
          final kind = '${cold ? 'pine' : 'oak'}_${h(z.id, 17 + i) % 2}';
          final t = Tree(kind: kind, map: map, position: Vector2(wx, wy));
          list.add(t);
          world.add(t);
        }
        _trees[z.id] = list;
      }
    }
    _trees.keys.where((id) {
      final zx = id % Zones.grid, zy = id ~/ Zones.grid;
      return (zx - pz.zx).abs() > 2 || (zy - pz.zy).abs() > 2;
    }).toList().forEach((id) {
      for (final t in _trees.remove(id)!) {
        t.removeFromParent();
      }
    });
  }

  void _updateBoss() {
    final pz = Zones.atWorld(player.position.x, player.position.y, TileMap.ts);
    if (pz == null) return;
    if (bossesDefeated.contains(pz.id) || _bosses.containsKey(pz.id)) return;
    final cx = pz.zx * Zones.zoneTiles + Zones.zoneTiles ~/ 2 + 3;
    final cy = pz.zy * Zones.zoneTiles + Zones.zoneTiles ~/ 2 - 3;
    final pos = map.nearestOpen(Vector2(cx * TileMap.ts, cy * TileMap.ts));
    final mon = Blockling.ofElement(pz.elementBias.index, level: pz.maxLevel + 6);
    final boss = Enemy(wild: mon, position: pos, player: player, bossZoneId: pz.id, bossName: pz.bossName);
    _bosses[pz.id] = boss;
    enemies.add(boss);
    world.add(boss);
    toast.value = '${pz.bossName} guards ${pz.name}!';
  }

  void _updateVendors() {
    final pz = Zones.atWorld(focus.x, focus.y, TileMap.ts);
    if (pz == null) return;
    // Ensure a vendor exists in the 3×3 block of zones around the player.
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        final zx = pz.zx + dx, zy = pz.zy + dy;
        if (zx < 0 || zy < 0 || zx >= Zones.grid || zy >= Zones.grid) continue;
        final id = zy * Zones.grid + zx;
        if (vendors.containsKey(id)) continue;
        final cx = zx * Zones.zoneTiles + Zones.zoneTiles ~/ 2;
        final cy = zy * Zones.zoneTiles + Zones.zoneTiles ~/ 2;
        final pos = map.nearestOpen(Vector2(cx * TileMap.ts, cy * TileMap.ts));
        final v = Vendor(name: Vendor.nameFor(id), seed: id, position: pos);
        vendors[id] = v;
        world.add(v);
      }
    }
    // Despawn distant vendors.
    vendors.keys.where((id) {
      final zx = id % Zones.grid, zy = id ~/ Zones.grid;
      return (zx - pz.zx).abs() > 2 || (zy - pz.zy).abs() > 2;
    }).toList().forEach((id) => vendors.remove(id)?.removeFromParent());
    // Nearest vendor within interaction range.
    nearbyVendor = null;
    var best = 52.0;
    for (final v in vendors.values) {
      final d = v.distanceToPlayer(player.position);
      if (d < best) {
        best = d;
        nearbyVendor = v;
      }
    }
  }

  String get currentZoneName => _zoneId == null ? '' : Zones.byId(_zoneId!).name;
  Zone? get currentZone => _zoneId == null ? null : Zones.byId(_zoneId!);

  void _spawnEnemy() {
    // Spawn INSIDE the player's current room (each screen is its own stage).
    const rp = TileMap.roomPx;
    final cx = (player.position.x / rp).floorToDouble() * rp + rp / 2;
    final cy = (player.position.y / rp).floorToDouble() * rp + rp / 2;
    final ang = (_seq * 2.3999632) % (math.pi * 2); // golden-angle scatter
    final dist = 70.0 + (_seq % 5) * 32; // within the room
    final at = map.nearestOpen(Vector2(cx + math.cos(ang) * dist, cy + math.sin(ang) * dist));
    final wild = Blockling.fromSeed('block:$blockHeight:wild:${_seq++}');
    // Scale the wild Blockling to the zone it spawns in.
    final zone = Zones.atWorld(at.x, at.y, TileMap.ts);
    if (zone != null) {
      wild.level = zone.minLevel + (wild.seed.hashCode.abs() % (zone.maxLevel - zone.minLevel + 1));
    }
    final e = Enemy(wild: wild, position: at, player: player);
    enemies.add(e);
    world.add(e);
  }

  void _loot(Enemy e) {
    final seed = 'block:$blockHeight:drop:${_seq}';
    // Crypto reward (BLOCK, with rare ETH/SOL dust) — the game economy is crypto.
    econ.credit(Chain.blockle, 0.05 + e.wild.rarity * 0.05);
    final roll = Blockling.fromSeed('$seed:coin').baseSpd; // 0..13 deterministic
    if (roll == 0) econ.credit(Chain.solana, 0.001);
    if (roll == 1) econ.credit(Chain.ethereum, 0.0005);

    // XP to you + your companion.
    if (player.gainXp(8 + e.wild.rarity * 6)) {
      toast.value = 'Level ${player.level}!';
      quests.onLevel(player.level);
    }
    companion?.mon.gainXp(6 + e.wild.rarity * 4);

    // Combat skill XP (RuneScape-style) + quest hooks.
    final z = Zones.atWorld(e.position.x, e.position.y, TileMap.ts);
    quests.onKill(z?.id ?? -1, e.wild.element);
    for (final sk in const ['Attack', 'Strength', 'Defence', 'Constitution', 'Slayer']) {
      if (skills.addXp(sk, 6 + e.wild.rarity * 4)) {
        quests.onSkill(sk, skills.level(skillIndex(sk)));
      }
    }

    // Item drop (~35%).
    if (e.wild.baseSpd % 3 == 0) {
      final drop = Item.drop('$seed:item');
      econ.addItem(drop);
      quests.onGather(drop.rarity);
    }
    // Capture the wild Blockling (~1 in 6).
    if (e.wild.baseSpd % 6 == 0) {
      econ.addBlockling(Blockling.fromSeed('block:$blockHeight:wild:${e.wild.seed.hashCode & 0xffff}'));
      toast.value = 'Caught a ${e.wild.name}!';
    }
    // Boss bounty: a big BLOCK drop, a guaranteed item + a captured Blockling.
    if (e.isBoss) {
      econ.credit(Chain.blockle, 2.0 + e.wild.rarity);
      econ.addItem(Item.drop('boss:${e.bossZoneId}:item'));
      econ.addBlockling(Blockling.fromSeed('boss:${e.bossZoneId}'));
      player.gainXp(40 + e.wild.rarity * 20);
      toast.value = 'Defeated ${e.bossName}!';
    }
  }
}
