import 'dart:math' as math;
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';

import '../../models/blockling.dart';
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

  Enemy({required this.wild, required Vector2 position, required this.player}) {
    this.position = position;
    maxHp = wild.maxHp;
    hp = maxHp.toDouble();
    atkStat = wild.atk;
    spd = wild.speed * 0.7;
    size = Vector2.all(22);
    anchor = Anchor.center;
    priority = 5;
  }

  final List<Sprite?> _dir = List.filled(4, null);
  int facing = 0;
  double _animT = 0;
  bool _moving = false;

  @override
  Future<void> onLoad() async {
    final e = wild.element.name; // spark/stone/leaf/tide/ember/gust
    const suf = ['s', 'n', 'w', 'e'];
    for (var i = 0; i < 4; i++) {
      try {
        _dir[i] = await Sprite.load('chars/${e}_${suf[i]}.png');
      } catch (_) {}
    }
  }

  void takeDamage(int dmg) {
    hp -= dmg;
    if (hp <= 0) dead = true;
  }

  @override
  void update(double dt) {
    super.update(dt);
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

  final Paint _p = Paint();
  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;

  @override
  void render(Canvas canvas) {
    final c = size / 2;
    final sp = _dir[facing];
    if (sp != null) {
      final bob = _moving ? math.sin(_animT * 11) * 2.0 : math.sin(_animT * 2.2) * 1.2;
      final sy = 1 + math.sin(_animT * (_moving ? 11 : 2.2)) * (_moving ? 0.06 : 0.04);
      sp.render(canvas, position: c + Vector2(0, -bob), size: Vector2(30, 30 * sy), anchor: Anchor.center, overridePaint: _pixel);
    } else {
      _p.color = wild.element.color;
      canvas.drawCircle(c.toOffset(), 10, _p);
      if (wild.shiny) {
        _p.color = const Color(0xFFFFFFFF);
        canvas.drawCircle(c.toOffset(), 3, _p);
      }
    }
    // HP bar.
    const bw = 24.0;
    final frac = (hp / maxHp).clamp(0.0, 1.0);
    _p.color = const Color(0xAA000000);
    canvas.drawRect(Rect.fromLTWH(c.x - bw / 2, -8, bw, 3), _p);
    _p.color = Bq.enemy;
    canvas.drawRect(Rect.fromLTWH(c.x - bw / 2, -8, bw * frac, 3), _p);
  }
}
