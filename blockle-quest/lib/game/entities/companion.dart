import 'dart:math' as math;
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';

import '../../models/blockling.dart';
import '../billboard.dart';
import '../blocklings_game.dart';
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

  Sprite? _sprite;
  int facing = 0;
  double _animT = 0;
  bool _moving = false;

  @override
  Future<void> onLoad() async {
    try {
      _sprite = await Sprite.load('chars/${mon.element.name}.png');
    } catch (_) {}
  }

  void _face(Vector2 v) =>
      facing = v.x.abs() > v.y.abs() ? (v.x < 0 ? 2 : 3) : (v.y < 0 ? 1 : 0);

  /// Returns damage dealt this tick (0 if none) and the enemy hit (for the loop
  /// to resolve death/loot).
  Enemy? fight(List<Enemy> enemies, double dt) {
    _animT += dt;
    _moving = false;
    priority = position.y.round();
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

  final Paint _pixel = Paint()
    ..filterQuality = FilterQuality.none
    ..isAntiAlias = false;

  @override
  void render(Canvas canvas) {
    final game = findGame();
    if (game is! BlocklingsGame) return;
    if (!game.inActiveRoom(position)) return; // other rooms are off-screen
    canvas.save();
    canvas.translate(-position.x, -position.y);
    final s = game.project(position.x, position.y);
    final sc = game.scaleAt(s.y);
    final bob = _moving ? math.sin(_animT * 13) * 1.8 : math.sin(_animT * 2.6) * 1.0;
    Billboard.draw(canvas, s, sc,
        sprite: _sprite,
        pixel: _pixel,
        baseW: 24,
        baseH: 24,
        facingLeft: facing == 2,
        bob: bob,
        fallbackColor: mon.element.color);
    canvas.restore();
  }
}
