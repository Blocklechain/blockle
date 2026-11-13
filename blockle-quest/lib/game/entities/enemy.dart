import 'dart:math' as math;
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';

import '../../models/blockling.dart';
import '../billboard.dart';
import '../blocklings_game.dart';
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
    final bossMul = bossZoneId != null ? 6 : 1;
    maxHp = wild.maxHp * bossMul;
    hp = maxHp.toDouble();
    atkStat = bossZoneId != null ? wild.atk * 2 : wild.atk;
    spd = wild.speed * (bossZoneId != null ? 0.55 : 0.7);
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
  }

  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;

  @override
  void render(Canvas canvas) {
    final game = findGame();
    if (game is! BlocklingsGame || dead) return;
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
