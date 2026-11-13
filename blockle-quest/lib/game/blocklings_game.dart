import 'dart:math' as math;

import 'package:flame/components.dart';
import 'package:flame/game.dart';
import 'package:flame/input.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

import '../economy/economy.dart';
import '../models/blockling.dart';
import '../models/item.dart';
import '../theme.dart';
import 'entities/companion.dart';
import 'entities/enemy.dart';
import 'entities/player.dart';
import 'tile_map.dart';

/// The Blocklings game: an open, chunked world with real-time combat, an
/// auto-combat mode, a Blockling companion, and crypto/NFT loot. UI (HUD,
/// inventory, wallet, marketplace) is Flutter overlays over this.
class BlocklingsGame extends FlameGame {
  final econ = EconomyService.instance;

  late TileMap map;
  late Player player;
  Companion? companion;
  final List<Enemy> enemies = [];

  late JoystickComponent joystick;
  bool autoCombat = true;

  int _seq = 0;
  // Stubbed chain height for provably-fair seeds; swap for the live height.
  int blockHeight = 2_100_000;
  static const int targetEnemies = 7;

  /// Bumped on notable events (loot/level) so the HUD/toasts can react.
  final ValueNotifier<String> toast = ValueNotifier('');

  @override
  Future<void> onLoad() async {
    econ.seed();
    econ.seedMarket();

    map = TileMap();
    world.add(map);

    final start = Vector2(0, 0);
    player = Player(map: map)..position = map.nearestOpen(start);
    world.add(player);

    // Starter Blockling companion (provably-fair from a fixed starter seed).
    final starter = Blockling.fromSeed('starter:blockle')..level = 3;
    econ.addBlockling(starter);
    companion = Companion(mon: starter, player: player);
    world.add(companion!);

    camera.viewfinder.zoom = 1.7;
    camera.follow(player);

    _addControls();
    for (var i = 0; i < targetEnemies; i++) {
      _spawnEnemy();
    }
  }

  void _addControls() {
    joystick = JoystickComponent(
      knob: CircleComponent(radius: 20, paint: Paint()..color = const Color(0xCCFFFFFF)),
      background: CircleComponent(radius: 46, paint: Paint()..color = const Color(0x33FFFFFF)),
      margin: const EdgeInsets.only(left: 28, bottom: 40),
    );
    final attackBtn = HudButtonComponent(
      button: CircleComponent(radius: 30, paint: Paint()..color = Bq.accent),
      margin: const EdgeInsets.only(right: 30, bottom: 48),
      onPressed: playerAttack,
    );
    camera.viewport.add(joystick);
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

    // Drive the player: auto-combat seeks the nearest foe; otherwise the stick.
    if (autoCombat) {
      final e = _nearestEnemy();
      if (e != null) {
        final to = e.position - player.position;
        if (to.length > player.attackRange * 0.8) {
          player.velocity.setFrom(to.normalized());
        } else {
          player.velocity.setZero();
          playerAttack();
        }
      } else {
        player.velocity.setZero();
      }
    } else {
      player.velocity.setFrom(joystick.relativeDelta);
    }

    companion?.fight(enemies, dt);

    // Resolve deaths + loot.
    for (final e in enemies.where((e) => e.dead).toList()) {
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
  }

  void _spawnEnemy() {
    final ang = (_seq * 2.3999632) % (math.pi * 2); // golden-angle scatter
    final dist = 240.0 + (_seq % 5) * 40;
    final at = map.nearestOpen(player.position + Vector2(math.cos(ang), math.sin(ang)) * dist);
    final wild = Blockling.fromSeed('block:$blockHeight:wild:${_seq++}');
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
    if (player.gainXp(8 + e.wild.rarity * 6)) toast.value = 'Level ${player.level}!';
    companion?.mon.gainXp(6 + e.wild.rarity * 4);

    // Item drop (~35%).
    if (e.wild.baseSpd % 3 == 0) {
      econ.addItem(Item.drop('$seed:item'));
    }
    // Capture the wild Blockling (~1 in 6).
    if (e.wild.baseSpd % 6 == 0) {
      econ.addBlockling(Blockling.fromSeed('block:$blockHeight:wild:${e.wild.seed.hashCode & 0xffff}'));
      toast.value = 'Caught a ${e.wild.name}!';
    }
  }
}
