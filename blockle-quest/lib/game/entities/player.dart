import 'dart:math' as math;
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/sprite.dart';

import '../../economy/economy.dart';
import '../../theme.dart';
import '../tile_map.dart';

/// The hero. Real-time movement with tile collision; combat resolution (who hits
/// whom) lives in the game loop, which calls [attackReady]/[resetCooldown] and
/// [takeHit]. Effective stats fold in equipped-gear bonuses from the economy.
class Player extends PositionComponent {
  final TileMap map;
  final econ = EconomyService.instance;

  int maxBaseHp;
  double hp;
  int baseAtk;
  int level;
  int xp;

  double speed; // px/sec at full stick
  double attackRange;
  double attackCd;
  double cdTimer = 0;

  /// Unit-ish movement vector (magnitude 0..1), set by the game each tick.
  final Vector2 velocity = Vector2.zero();

  /// Facing direction for directional sprites: 0=down,1=up,2=left,3=right.
  int facing = 0;

  /// Animation clock (procedural walk-bounce + idle breathe).
  double _animT = 0;

  Player({
    required this.map,
    this.maxBaseHp = 60,
    this.baseAtk = 8,
    this.level = 1,
    this.xp = 0,
    this.speed = 150,
    this.attackRange = 46,
    this.attackCd = 0.55,
  }) : hp = 60 {
    size = Vector2.all(26);
    anchor = Anchor.center;
    priority = 10;
  }

  // Directional sprites indexed by facing: 0=down,1=up,2=left,3=right.
  final List<Sprite?> _dir = List.filled(4, null);

  @override
  Future<void> onLoad() async {
    const files = ['chars/player_s.png', 'chars/player_n.png', 'chars/player_w.png', 'chars/player_e.png'];
    for (var i = 0; i < 4; i++) {
      try {
        _dir[i] = await Sprite.load(files[i]);
      } catch (_) {}
    }
  }

  int get maxHp => maxBaseHp + (level - 1) * 6 + econ.bonusHp;
  int get atk => baseAtk + (level - 1) * 2 + econ.bonusAtk;
  int get xpToNext => 30 + level * 20;

  bool get attackReady => cdTimer <= 0;
  void resetCooldown() => cdTimer = attackCd;

  void takeHit(int enemyAtk) {
    final dmg = math.max(1, enemyAtk - econ.bonusDef ~/ 2);
    hp = math.max(0, hp - dmg);
  }

  void heal(int amount) => hp = math.min(maxHp.toDouble(), hp + amount);

  bool gainXp(int amount) {
    xp += amount;
    var leveled = false;
    while (xp >= xpToNext) {
      xp -= xpToNext;
      level++;
      hp = maxHp.toDouble();
      leveled = true;
    }
    return leveled;
  }

  void respawn(Vector2 at) {
    position.setFrom(at);
    hp = maxHp.toDouble();
    velocity.setZero();
  }

  @override
  void update(double dt) {
    super.update(dt);
    _animT += dt;
    if (cdTimer > 0) cdTimer -= dt;
    if (velocity.isZero()) return;

    // Update facing from the dominant movement axis (for directional sprites).
    if (velocity.x.abs() > velocity.y.abs()) {
      facing = velocity.x < 0 ? 2 : 3;
    } else {
      facing = velocity.y < 0 ? 1 : 0;
    }

    final step = velocity * speed * dt;
    // Axis-separated collision so you slide along walls.
    final nx = position.x + step.x;
    if (!map.solidAtWorld(nx, position.y)) position.x = nx;
    final ny = position.y + step.y;
    if (!map.solidAtWorld(position.x, ny)) position.y = ny;

    // Clamp to world.
    position.x = position.x.clamp(TileMap.ts, map.worldWidth - TileMap.ts);
    position.y = position.y.clamp(TileMap.ts, map.worldHeight - TileMap.ts);
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
      // Procedural animation: walk-bounce while moving, gentle idle breathe.
      final moving = !velocity.isZero();
      final bob = moving ? math.sin(_animT * 12) * 2.4 : math.sin(_animT * 2.4) * 0.9;
      final sy = moving ? 1 + math.sin(_animT * 12) * 0.06 : 1 + math.sin(_animT * 2.4) * 0.025;
      sp.render(canvas,
          position: c + Vector2(0, -2 - bob),
          size: Vector2(38, 38 * sy),
          anchor: Anchor.center,
          overridePaint: _pixel);
    } else {
      _p.color = Bq.accent;
      canvas.drawCircle(c.toOffset(), 12, _p);
      _p.color = Bq.accent2;
      canvas.drawCircle(c.toOffset(), 7, _p);
    }

    // HP bar above head.
    const bw = 30.0;
    final frac = (hp / maxHp).clamp(0.0, 1.0);
    _p.color = const Color(0xAA000000);
    canvas.drawRect(Rect.fromLTWH(c.x - bw / 2, -10, bw, 4), _p);
    _p.color = frac > 0.3 ? Bq.hpGood : Bq.hpBad;
    canvas.drawRect(Rect.fromLTWH(c.x - bw / 2, -10, bw * frac, 4), _p);
  }
}
