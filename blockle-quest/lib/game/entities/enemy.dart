import 'dart:ui';

import 'package:flame/components.dart';

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

  void takeDamage(int dmg) {
    hp -= dmg;
    if (hp <= 0) dead = true;
  }

  @override
  void update(double dt) {
    super.update(dt);
    if (dead) return;
    if (cdTimer > 0) cdTimer -= dt;
    final to = player.position - position;
    final dist = to.length;
    if (dist < aggro && dist > attackRange) {
      position.add(to.normalized() * spd * dt);
    } else if (dist <= attackRange && cdTimer <= 0) {
      player.takeHit(atkStat);
      cdTimer = cd;
    }
  }

  final Paint _p = Paint();

  @override
  void render(Canvas canvas) {
    final c = size / 2;
    _p.color = wild.element.color;
    canvas.drawCircle(c.toOffset(), 10, _p);
    if (wild.shiny) {
      _p.color = const Color(0xFFFFFFFF);
      canvas.drawCircle(c.toOffset(), 3, _p);
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
