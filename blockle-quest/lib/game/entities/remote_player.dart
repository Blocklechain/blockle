import 'dart:ui';

import 'package:flame/components.dart';

import '../billboard.dart';
import '../blocklings_game.dart';

/// Another player in the shared world. Position is smoothed toward the latest
/// networked [target] so movement stays fluid between updates.
class RemotePlayer extends PositionComponent {
  final Vector2 target = Vector2.zero();
  int lvl = 1;
  String name = '';

  RemotePlayer(Vector2 pos, this.name, this.lvl) {
    position = pos.clone();
    target.setFrom(pos);
    size = Vector2.all(24);
    anchor = Anchor.center;
    priority = 9;
  }

  @override
  void update(double dt) {
    super.update(dt);
    position.lerp(target, (10 * dt).clamp(0.0, 1.0));
    priority = position.y.round();
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
    Billboard.draw(canvas, s, sc,
        pixel: _pixel, baseW: 26, baseH: 30, fallbackColor: const Color(0xFF4FC3F7), name: name);
    canvas.restore();
  }
}
