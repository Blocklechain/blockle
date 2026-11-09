// Per-trade sizing for the aggressive "AI picks" autopilot (~1/8 of the cap,
// min $20, never above the cap) — pure function on BotsController's file.
import 'package:blockle_app/state/bots_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('aggressivePerTradeUsd scales with the allocation', () {
    expect(aggressivePerTradeUsd(500), 62.5);
    expect(aggressivePerTradeUsd(1000), 125);
    expect(aggressivePerTradeUsd(100), 20); // 1/8 would be 12.5 → floor $20
    expect(aggressivePerTradeUsd(10), 10); // tiny cap: never above the cap
    expect(aggressivePerTradeUsd(0), 20); // unknown cap → template default
  });
}
