// detail_view_test.dart — REGRESSION GUARD: the bot DETAIL screen (DetailView)
// must render without throwing for EVERY bot type (dca, grid, smarttrade, signal,
// rebalance, momentum, scanner) and EVERY edge state (no open deal, empty pairs,
// empty/absent state map, paper vs live, a freshly-created bot with minimal
// fields, realistic open deals of each dealing type, and a malformed pair). It
// exercises the REAL BotsController + BotRunner + BotStore (engine not mocked)
// and pumps the real widget, so a field-access OR a layout (RenderFlex) crash in
// detail_view.dart surfaces here.
//
// One controller is built ONCE (building a second full BotsController +
// MultichainController + AppState in the same isolate wedges on shared engine
// singletons); each case adds a bot, pumps, asserts, then removes it.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/agent/bots.dart' as b;
import 'package:blockle_app/screens/bots/bots_tokens.dart';
import 'package:blockle_app/screens/bots/detail_view.dart';
import 'package:blockle_app/state/app_state.dart';
import 'package:blockle_app/state/bots_controller.dart';
import 'package:blockle_app/state/multichain_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // The engine stores (bots + secure channel blob) sit behind flutter_secure_storage.
  // In a unit test there is no platform plugin, so stub it to an empty store.
  const secureStorage = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

  late BotsController controller;
  var seq = 0;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized()
        .defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, (call) async {
      if (call.method == 'readAll') return <String, String>{};
      return null; // read / write / delete / containsKey -> empty store
    });
    final app = AppState();
    final mc = MultichainController(app, GlobalKey<NavigatorState>());
    controller = BotsController(mc);
    await controller.init();
  });

  tearDownAll(() {
    controller.dispose();
    TestWidgetsFlutterBinding.ensureInitialized()
        .defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, null);
  });

  // Add a bot (unique id) from [spec] (after an optional [mutate] hook to inject
  // deal state), pump a DetailView for it, assert nothing was thrown, then remove
  // the bot so the next case starts from a clean store.
  Future<void> pumpBot(
    WidgetTester tester,
    Map<String, dynamic> spec, {
    void Function(b.Bot bot)? mutate,
    Brightness brightness = Brightness.dark,
    Size? surface,
  }) async {
    final id = 'bot_${spec['type']}_${seq++}';
    final bot = controller.runner.add({...spec, 'id': id});
    mutate?.call(bot);
    addTearDown(() => controller.runner.remove(id));

    if (surface != null) {
      await tester.binding.setSurfaceSize(surface);
      addTearDown(() => tester.binding.setSurfaceSize(null));
    }

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: BotTheme(
          tokens: BotTokens.of(brightness),
          child: DetailView(
            controller: controller,
            botId: id,
            onBack: () {},
            onClonedTo: (_) {},
          ),
        ),
      ),
    ));
    await tester.pump();

    expect(tester.takeException(), isNull,
        reason: 'DetailView threw for type=${bot.type} id=$id');

    // An enabled/live bot arms the BotRunner's periodic scheduler Timer on the
    // SHARED controller. Cancel it here (before flutter_test's pending-timer check)
    // so it never accumulates across cases and wedges every subsequent test.
    controller.runner.stopScheduler();
  }

  // ---- realistic deal shapes (BigInt money fields, exactly as the engine persists) --

  Map<String, dynamic> dcaOpenDeal() => {
        'id': 'd1', 'type': 'dca', 'status': 'open', 'openedAt': 1, 'closedAt': null,
        'fills': <dynamic>[
          {
            'side': 'buy', 'kind': 'base', 'priceUc': BigInt.from(150000000),
            'qty': BigInt.from(1000000000), 'costUc': BigInt.from(150000000),
            'ts': 1, 'paper': true,
          },
          {
            'side': 'buy', 'kind': 'safety', 'priceUc': BigInt.from(147000000),
            'qty': BigInt.from(1000000000), 'costUc': BigInt.from(147000000),
            'ts': 2, 'paper': true,
          },
        ],
        'filledQty': BigInt.from(2000000000), 'costUc': BigInt.from(297000000),
        'avgEntryUc': BigInt.from(148500000), 'safetyOrdersUsed': 1, 'curStepBps': 200,
        'nextTriggerUc': BigInt.from(144000000), 'peakUc': BigInt.from(150000000),
        'tpArmed': false, 'realizedUc': BigInt.zero, 'reason': null,
      };

  Map<String, dynamic> gridOpenDeal() => {
        'id': 'g1', 'type': 'grid', 'status': 'open', 'openedAt': 1, 'closedAt': null,
        'bd': 9,
        'levels': <dynamic>[
          {
            'i': 0, 'priceUc': BigInt.from(140000000), 'side': 'buy', 'status': 'open',
            'heldQty': BigInt.zero, '_costUc': BigInt.zero,
          },
          {
            'i': 1, 'priceUc': BigInt.from(150000000), 'side': 'sell', 'status': 'open',
            'heldQty': BigInt.from(500000000), '_costUc': BigInt.from(70000000),
          },
        ],
        'fills': <dynamic>[
          {
            'side': 'buy', 'kind': 'grid', 'level': 0, 'priceUc': BigInt.from(140000000),
            'qty': BigInt.from(500000000), 'costUc': BigInt.from(70000000), 'ts': 1, 'paper': true,
          },
        ],
        'realizedUc': BigInt.zero,
      };

  Map<String, dynamic> smartOpenDeal() => {
        'id': 's1', 'type': 'smarttrade', 'status': 'open', 'openedAt': 1, 'closedAt': null,
        'fills': <dynamic>[
          {
            'side': 'buy', 'kind': 'entry', 'priceUc': BigInt.from(150000000),
            'qty': BigInt.from(1000000000), 'costUc': BigInt.from(150000000),
            'ts': 1, 'paper': true,
          },
        ],
        'entryQty': BigInt.from(1000000000), 'entryCostUc': BigInt.from(150000000),
        'avgEntryUc': BigInt.from(150000000), 'remainingQty': BigInt.from(1000000000),
        'tpsHit': <dynamic>[false], 'peakUc': BigInt.from(150000000), 'slArmed': false,
        'realizedUc': BigInt.zero, 'reason': null,
      };

  void putDeal(b.Bot bot, String pair, Map<String, dynamic> deal) {
    (bot.state['byPair'] as Map<String, dynamic>)[pair] = {
      'deal': deal,
      'lastCloseAt': 0,
    };
  }

  Map<String, dynamic> universe(List<String> pairs) => {'pairs': pairs};

  final gridCfg = {'lowerPrice': 120.0, 'upperPrice': 180.0, 'gridCount': 6, 'totalUsd': 60};

  // ======================================================================
  // 1) every type renders fresh (paper, one pair, no deal; and live, no pairs)
  // ======================================================================
  for (final type in b.kBotTypes) {
    testWidgets('renders fresh $type bot (paper, one pair, no deal)', (tester) async {
      await pumpBot(tester, {
        'type': type,
        'name': '$type one',
        'mode': 'paper',
        'allocationUsd': 100,
        'universe': universe(['SOL/USDC']),
        if (type == 'grid') 'config': gridCfg,
      });
    });

    testWidgets('renders fresh $type bot (live, empty pairs, enabled)', (tester) async {
      await pumpBot(tester, {
        'type': type,
        'name': '$type two',
        'mode': 'live',
        'enabled': true,
        'allocationUsd': 250,
        'universe': universe(const []),
        if (type == 'grid') 'config': gridCfg,
      });
    });
  }

  // ======================================================================
  // 2) the dealing types with a realistic OPEN deal (fills present)
  // ======================================================================
  testWidgets('dca bot with an open deal + fills', (tester) async {
    await pumpBot(
      tester,
      {'type': 'dca', 'mode': 'paper', 'allocationUsd': 100, 'universe': universe(['SOL/USDC'])},
      mutate: (bot) => putDeal(bot, 'SOL/USDC', dcaOpenDeal()),
    );
  });

  testWidgets('grid bot with an open deal + fills', (tester) async {
    await pumpBot(
      tester,
      {'type': 'grid', 'mode': 'paper', 'allocationUsd': 100, 'config': gridCfg, 'universe': universe(['SOL/USDC'])},
      mutate: (bot) => putDeal(bot, 'SOL/USDC', gridOpenDeal()),
    );
  });

  testWidgets('smarttrade bot with an open deal + fills', (tester) async {
    await pumpBot(
      tester,
      {'type': 'smarttrade', 'mode': 'live', 'enabled': true, 'allocationUsd': 100, 'universe': universe(['SOL/USDC'])},
      mutate: (bot) => putDeal(bot, 'SOL/USDC', smartOpenDeal()),
    );
  });

  // ======================================================================
  // 3) a dca deal that is still PENDING (no fills yet, zeroed money fields)
  // ======================================================================
  testWidgets('dca bot with a freshly-opened PENDING deal (no fills)', (tester) async {
    await pumpBot(
      tester,
      {'type': 'dca', 'mode': 'paper', 'allocationUsd': 50, 'universe': universe(['BLOCK/USDC'])},
      mutate: (bot) => putDeal(bot, 'BLOCK/USDC', b.newDcaDeal('d0', 1)),
    );
  });

  // ======================================================================
  // 4) absent / empty state map (minimal persisted bot); scanner carrying a deal
  // ======================================================================
  testWidgets('bot with an emptied state map', (tester) async {
    await pumpBot(
      tester,
      {'type': 'dca', 'mode': 'paper', 'allocationUsd': 10, 'universe': universe(['SOL/USDC'])},
      mutate: (bot) => bot.state.clear(),
    );
  });

  testWidgets('scanner bot carrying a byPair deal entry', (tester) async {
    await pumpBot(
      tester,
      {'type': 'scanner', 'mode': 'live', 'enabled': true, 'allocationUsd': 200, 'universe': universe(['SOL/USDC'])},
      mutate: (bot) => putDeal(bot, 'SOL/USDC', dcaOpenDeal()),
    );
  });

  // A malformed universe pair (no BASE/QUOTE slash) leading the list must not crash
  // the stepper, which reads pairs().first for its base symbol. The open deal still
  // sits on a VALID byPair key (as the engine always writes), so only the stepper's
  // splitPair sees the bad entry.
  testWidgets('dca bot whose first universe pair is malformed', (tester) async {
    await pumpBot(
      tester,
      {'type': 'dca', 'mode': 'paper', 'allocationUsd': 100, 'universe': universe(['WEIRDPAIR', 'SOL/USDC'])},
      mutate: (bot) => putDeal(bot, 'SOL/USDC', dcaOpenDeal()),
    );
  });

  // ======================================================================
  // 5) narrow layout (Column path) + light theme — the perf tiles must still fit
  // ======================================================================
  testWidgets('dca open deal renders in the narrow Column layout (light)', (tester) async {
    await pumpBot(
      tester,
      {'type': 'dca', 'mode': 'paper', 'allocationUsd': 100, 'universe': universe(['SOL/USDC'])},
      mutate: (bot) => putDeal(bot, 'SOL/USDC', dcaOpenDeal()),
      brightness: Brightness.light,
      surface: const Size(420, 1400),
    );
  });
}
