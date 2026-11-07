// bots_screen_empty_test.dart — REGRESSION GUARD for the "grey screen with no
// active bots" report. Drives the FULL BotsScreen (not just DetailView) through
// a freshly-initialized BotsController with an EMPTY store, then:
//   1) asserts the screen renders (cockpit empty-state) without throwing, and
//   2) taps the standalone "Bot detail" tab — which, with no bot selected, must
//      show the friendly pick-prompt, never a blank/crash frame.
//
// This specifically covers the BotsController.init() path: `_rebuildRunner`
// reads the multichain controller's `late` agent, and a throw there used to
// abort init() so `ready` never flipped true and the whole screen stayed blank.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:blockle_app/screens/bots_screen.dart';
import 'package:blockle_app/state/app_state.dart';
import 'package:blockle_app/state/bots_controller.dart';
import 'package:blockle_app/state/multichain_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const secureStorage = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

  late BotsController controller;
  late MultichainController mc;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized()
        .defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, (call) async {
      if (call.method == 'readAll') return <String, String>{};
      return null;
    });
    final app = AppState();
    mc = MultichainController(app, GlobalKey<NavigatorState>());
    // NOTE: deliberately do NOT init the multichain controller, so its `agent`
    // late field is uninitialized — exactly the fragile state that must not crash
    // BotsController.init()/the screen.
    controller = BotsController(mc);
    await controller.init();
  });

  tearDownAll(() {
    controller.dispose();
    TestWidgetsFlutterBinding.ensureInitialized()
        .defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, null);
  });

  testWidgets('init() completes even with an uninitialized agent', (tester) async {
    expect(controller.ready, isTrue);
  });

  testWidgets('BotsScreen renders + Bot detail tab shows the pick-prompt (no bots)',
      (tester) async {
    // A realistically tall phone surface so the cockpit's scroll content lays out
    // fully — isolating this guard to CRASHES (the init/listener throw), not the
    // release-safe RenderFlex overflow a 800x600 default surface would trip.
    await tester.binding.setSurfaceSize(const Size(430, 2200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ChangeNotifierProvider<MultichainController>.value(
          value: mc,
          child: ChangeNotifierProvider<BotsController>.value(
            value: controller,
            child: const BotsScreen(),
          ),
        ),
      ),
    ));
    await tester.pump();

    expect(tester.takeException(), isNull, reason: 'cockpit threw with no bots');
    expect(find.text('Bot detail'), findsOneWidget);

    // Tap the standalone Bot detail tab with nothing selected.
    await tester.tap(find.text('Bot detail'));
    await tester.pump();

    expect(tester.takeException(), isNull, reason: 'Bot detail tab threw with no bot selected');
    expect(find.textContaining('Pick a bot'), findsOneWidget);

    controller.runner.stopScheduler();
  });
}
