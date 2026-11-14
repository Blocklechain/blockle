import 'package:flame/components.dart';
import 'package:vector_math/vector_math_64.dart' as vm;

/// Perspective "Mode-7" tilt. The world logic stays flat (top-down) world-pixels;
/// rendering pitches the ground plane back toward a horizon and draws entities as
/// upright, depth-sorted, shadowed billboards. Everything is player-centred, so
/// the camera is just this projection. Uses vector_math_64 (Float64List storage)
/// for Canvas.transform.
class Tilt {
  // Gentle 3/4 view (Thronebound Realms): a subtle pitch + faint perspective —
  // the depth should come mostly from the art, not an aggressive Mode-7 tilt.
  static const double pitch = 0.42; // ground pitch, radians (~24°)
  static const double persp = -0.0006; // perspective strength
  static const double horizon = 0.44; // camera centre line (fraction of screen height)

  static vm.Matrix4 view(Vector2 cam, Vector2 screen) {
    final m = vm.Matrix4.identity();
    m.setEntry(3, 2, persp);
    m.translate(screen.x / 2, screen.y * horizon);
    m.rotateX(pitch);
    m.translate(-cam.x, -cam.y);
    return m;
  }

  static Vector2 projectWith(vm.Matrix4 m, double wx, double wy) {
    final v = m.perspectiveTransform(vm.Vector3(wx, wy, 0));
    return Vector2(v.x, v.y);
  }

  static double scaleForY(double screenY, double screenH) {
    // Subtle depth scaling to match the gentle pitch (~0.85 far → ~1.1 near).
    final t = (screenY / screenH).clamp(0.0, 1.0);
    return 0.85 + t * 0.25;
  }
}
