import 'dart:math' as math;
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';

import '../../models/blockling.dart';
import 'enemy.dart';
import 'player.dart';

/// An owned Blockling that fights alongside you — the NFT in action. It trails
/// the player and auto-attacks the nearest enemy in range. Combat targeting is
/// driven by the game loop via [fight].
class Companion extends PositionComponent {
  final Blockling mon;
  final Player player;

  double range = 140;
  double attackRange = 26;
  double cd = 0.8;
  double cdTimer = 0;

  Companion({required this.mon, required this.player}) {
    size = Vector2.all(18);
    anchor = Anchor.center;
    priority = 6;
    position = player.position.clone()..add(Vector2(20, 20));
  }

  final List<Sprite?> _dir = List.filled(4, null);
  int facing = 0;
  double _animT = 0;
  bool _moving = false;

  @override
  Future<void> onLoad() async {
    final e = mon.element.name;
    const suf = ['s', 'n', 'w', 'e'];
    for (var i = 0; i < 4; i++) {
      try {
        _dir[i] = await Sprite.load('chars/${e}_${suf[i]}.png');
      } catch (_) {}
    }
  }

  void _face(Vector2 v) =>
      facing = v.x.abs() > v.y.abs() ? (v.x < 0 ? 2 : 3) : (v.y < 0 ? 1 : 0);

  /// Returns damage dealt this tick (0 if none) and the enemy hit (for the loop
  /// to resolve death/loot).
  Enemy? fight(List<Enemy> enemies, double dt) {
    _animT += dt;
    _moving = false;
    if (cdTimer > 0) cdTimer -= dt;
    // Nearest live enemy within range.
    Enemy? target;
    var best = range;
    for (final e in enemies) {
      if (e.dead) continue;
      final d = e.position.distanceTo(position);
      if (d < best) {
        best = d;
        target = e;
      }
    }
    if (target == null) {
      // Idle: trail the player.
      final to = player.position - position;
      if (to.length > 36) {
        _face(to);
        _moving = true;
        position.add(to.normalized() * mon.speed * 0.9 * dt);
      }
      return null;
    }
    final to = target.position - position;
    if (to.length > attackRange) {
      _face(to);
      _moving = true;
      position.add(to.normalized() * mon.speed * dt);
      return null;
    }
    if (cdTimer <= 0) {
      target.takeDamage(mon.atk);
      cdTimer = cd;
      return target;
    }
    return null;
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
      final bob = _moving ? math.sin(_animT * 13) * 1.8 : math.sin(_animT * 2.6) * 1.0;
      final sy = 1 + math.sin(_animT * (_moving ? 13 : 2.6)) * (_moving ? 0.07 : 0.04);
      sp.render(canvas, position: c + Vector2(0, -bob), size: Vector2(24, 24 * sy), anchor: Anchor.center, overridePaint: _pixel);
      return;
    }
    _p.color = mon.element.color;
    canvas.drawCircle(c.toOffset(), 8, _p);
    _p.color = const Color(0x55000000);
    canvas.drawCircle(c.toOffset(), 8, _p..style = PaintingStyle.stroke..strokeWidth = 1.5);
    _p.style = PaintingStyle.fill;
  }
}
