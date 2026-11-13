import 'package:flame/components.dart' show Vector2;
import 'package:flutter/material.dart';

import '../theme.dart';

/// A classic on-screen D-pad: four directional buttons in a cross. Multi-touch
/// aware (press two for diagonals). Emits a normalized movement vector via
/// [onChanged]; a zero vector when nothing is held.
class DPad extends StatefulWidget {
  final void Function(Vector2 dir) onChanged;
  const DPad({super.key, required this.onChanged});

  @override
  State<DPad> createState() => _DPadState();
}

class _DPadState extends State<DPad> {
  // Which directions are currently held: 0=up,1=down,2=left,3=right.
  final Set<int> _held = {};

  static const _vec = [
    [0.0, -1.0], // up
    [0.0, 1.0], // down
    [-1.0, 0.0], // left
    [1.0, 0.0], // right
  ];

  void _emit() {
    var x = 0.0, y = 0.0;
    for (final d in _held) {
      x += _vec[d][0];
      y += _vec[d][1];
    }
    final v = Vector2(x, y);
    if (v.length2 > 0) v.normalize();
    widget.onChanged(v);
  }

  void _press(int d) {
    if (_held.add(d)) {
      _emit();
      setState(() {});
    }
  }

  void _release(int d) {
    if (_held.remove(d)) {
      _emit();
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 150,
      height: 150,
      child: Stack(
        children: [
          Align(alignment: Alignment.topCenter, child: _btn(0, Icons.keyboard_arrow_up)),
          Align(alignment: Alignment.bottomCenter, child: _btn(1, Icons.keyboard_arrow_down)),
          Align(alignment: Alignment.centerLeft, child: _btn(2, Icons.keyboard_arrow_left)),
          Align(alignment: Alignment.centerRight, child: _btn(3, Icons.keyboard_arrow_right)),
          // Center hub.
          Align(
            alignment: Alignment.center,
            child: Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                color: Bq.panel.withValues(alpha: 0.7),
                shape: BoxShape.circle,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _btn(int d, IconData icon) {
    final held = _held.contains(d);
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: (_) => _press(d),
      onPointerUp: (_) => _release(d),
      onPointerCancel: (_) => _release(d),
      child: Container(
        width: 52,
        height: 52,
        decoration: BoxDecoration(
          color: held ? Bq.accent : Bq.panel.withValues(alpha: 0.82),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Bq.panel2),
        ),
        child: Icon(icon, color: held ? Colors.white : Bq.text, size: 30),
      ),
    );
  }
}
