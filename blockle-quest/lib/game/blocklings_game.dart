import 'dart:math' as math;

import 'package:flame/components.dart';
import 'package:flame/game.dart';
import 'package:flame/input.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:vector_math/vector_math_64.dart' as vm;

import 'tilt.dart';

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

  // Mode-7 tilt projection (focus-centred; replaces the Flame camera).
  Vector2 _screen = Vector2.all(800);
  vm.Matrix4 _view = vm.Matrix4.identity();
  Vector2 project(double wx, double wy) => Tilt.projectWith(_view, wx, wy);
  double scaleAt(double screenY) => Tilt.scaleForY(screenY, _screen.y);

  /// Title-screen cinematic: the camera drifts across the world until the
  /// player presses Enter World. While cinematic, streaming (villages/vendors)
  /// follows the drifting camera, input/HUD are hidden, and nothing toasts.
  bool cinematic = true;
  double _cineT = 0;
  final Vector2 _cinePos = Vector2.zero();

  /// What the camera + world streaming centre on.
  Vector2 get focus => cinematic ? _cinePos : player.position;

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

    // Refresh the tilt projection for this frame (centred on the focus — the
    // drifting camera while cinematic, the player once in the world).
    _screen.setFrom(size);
    _view = Tilt.view(focus, _screen);
    map.tiltMatrix = _view;
    map.tiltCam = focus;

    if (cinematic) {
      // Stream the world along the drifting camera only (~10Hz).
      _posAcc += dt;
      if (_posAcc >= 0.1) {
        _posAcc = 0;
        _updateVendors();
        _updateVillages();
      }
      return;
    }

    // Movement is ALWAYS manual (the D-pad). The player never auto-moves.
    player.velocity.setFrom(dpad);
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
      if (!first) overlays.add('zoneload'); // not on initial spawn
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
    final ang = (_seq * 2.3999632) % (math.pi * 2); // golden-angle scatter
    final dist = 240.0 + (_seq % 5) * 40;
    final at = map.nearestOpen(player.position + Vector2(math.cos(ang), math.sin(ang)) * dist);
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
