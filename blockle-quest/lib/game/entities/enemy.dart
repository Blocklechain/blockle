import 'dart:math' as math;
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';

import '../../models/blockling.dart';
import '../billboard.dart';
import '../blocklings_game.dart';
import '../tile_map.dart';
import '../../theme.dart';
import 'player.dart';

/// A wild Blockling roaming the world. Real-time: chases the player within aggro
/// range and attacks on a cooldown. Stats come from the (provably-fair) wild
/// Blockling it wraps. The game loop handles death/loot.
class Enemy extends PositionComponent {
  final Blockling wild;
  final Player player;

  late double hp;
  late final int maxHp;
  late final int atkStat;
  late final double spd;

  double aggro = 180;
  double attackRange = 30;
  late final Vector2 _homeRoom; // room this mob is bound to

  bool _playerInHomeRoom() =>
      player.position.x >= _homeRoom.x &&
      player.position.y >= _homeRoom.y &&
      player.position.x < _homeRoom.x + TileMap.roomPx &&
      player.position.y < _homeRoom.y + TileMap.roomPx;
  double cd = 1.0;
  double cdTimer = 0;
  bool dead = false;

  /// Set for zone bosses: the zone id it guards + its name (shown above it).
  int? bossZoneId;
  String bossName;

  bool get isBoss => bossZoneId != null;

  Enemy({
    required this.wild,
    required Vector2 position,
    required this.player,
    this.bossZoneId,
    this.bossName = '',
  }) {
    this.position = position;
    // Tuned friendly: regular mobs die fast (~2-4 hits) and hit soft; bosses
    // stay a real fight but not a wall.
    if (bossZoneId != null) {
      maxHp = wild.maxHp * 4;
      atkStat = (wild.atk * 1.5).ceil();
    } else {
      maxHp = (wild.maxHp * 0.55).ceil();
      atkStat = (wild.atk * 0.6).ceil().clamp(1, 999);
    }
    hp = maxHp.toDouble();
    spd = wild.speed * (bossZoneId != null ? 0.55 : 0.7);
    // Mobs are bound to the room (map screen) they spawned in.
    _homeRoom = Vector2(
      (position.x / TileMap.roomPx).floorToDouble() * TileMap.roomPx,
      (position.y / TileMap.roomPx).floorToDouble() * TileMap.roomPx,
    );
    size = Vector2.all(bossZoneId != null ? 44 : 22);
    aggro = bossZoneId != null ? 260 : 180;
    anchor = Anchor.center;
    priority = bossZoneId != null ? 7 : 5;
  }

  Sprite? _sprite;
  int facing = 0;
  double _animT = 0;
  bool _moving = false;

  @override
  Future<void> onLoad() async {
    try {
      _sprite = await Sprite.load('chars/${wild.element.name}.png');
    } catch (_) {}
  }

  void takeDamage(int dmg) {
    hp -= dmg;
    if (hp <= 0) dead = true;
  }

  @override
  void update(double dt) {
    super.update(dt);
    priority = position.y.round();
    if (dead) return;
    _animT += dt;
    _moving = false;
    if (cdTimer > 0) cdTimer -= dt;
    // Only engage while the player is on THIS mob's map screen.
    if (!_playerInHomeRoom()) return;
    final to = player.position - position;
    final dist = to.length;
    facing = to.x.abs() > to.y.abs() ? (to.x < 0 ? 2 : 3) : (to.y < 0 ? 1 : 0);
    if (dist < aggro && dist > attackRange) {
      position.add(to.normalized() * spd * dt);
      _moving = true;
    } else if (dist <= attackRange && cdTimer <= 0) {
      player.takeHit(atkStat);
      cdTimer = cd;
    }
    // Never leave the home room (stay clear of the border walls).
    const pad = TileMap.ts * 1.3;
    position.x = position.x.clamp(_homeRoom.x + pad, _homeRoom.x + TileMap.roomPx - pad);
    position.y = position.y.clamp(_homeRoom.y + pad, _homeRoom.y + TileMap.roomPx - pad);
  }

  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;

  @override
  void render(Canvas canvas) {
    final game = findGame();
    if (game is! BlocklingsGame || dead) return;
    if (!game.inActiveRoom(position)) return; // other rooms are off-screen
    canvas.save();
    canvas.translate(-position.x, -position.y);
    final s = game.project(position.x, position.y);
    final sc = game.scaleAt(s.y);
    final bob = _moving ? math.sin(_animT * 11) * 2.0 : math.sin(_animT * 2.2) * 1.2;
    Billboard.draw(canvas, s, sc,
        sprite: _sprite,
        pixel: _pixel,
        baseW: isBoss ? 56 : 30,
        baseH: isBoss ? 56 : 30,
        facingLeft: facing == 2,
        bob: bob,
        fallbackColor: wild.element.color,
        hpFrac: hp / maxHp,
        hpColor: isBoss ? const Color(0xFFFFC24B) : Bq.enemy,
        name: isBoss ? bossName : null);
    canvas.restore();
  }
}
