// Tests for the exchange tab's SHELL: the section table, the left rail and the
// content pane that reads both.
//
// WHAT EACH GROUP PREVENTS, because the point of this file is not coverage:
//
//   * the table tests prevent a section existing in the rail and not in the
//     router (or the reverse), which is an unreachable screen or a dead glyph;
//   * the deep-link tests prevent the one plist mistake that has actually cost
//     releases — an underscored URL scheme — and prevent a link naming a
//     section the rail does not have;
//   * the badge tests prevent the two dishonest dots: "blocked" for a gate we
//     have not checked, and silence for a gate we have checked and that is
//     shut. On a live custodial venue the second one means a user fills in a
//     withdrawal form the venue is going to refuse;
//   * the rail tests prevent the selection becoming invisible (no label, no
//     tint, no capsule) and prevent a tap selecting the wrong section;
//   * the shell tests prevent the signed-out curtain swallowing the rail, and
//     prevent any money-moving placeholder reading as if the server gates were
//     optional.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:blockle_app/screens/exchange/exchange_rail.dart';
import 'package:blockle_app/screens/exchange/section_table.dart';
import 'package:blockle_app/screens/exchange_screen.dart';
import 'package:blockle_app/services/exchange_client.dart';
import 'package:blockle_app/services/exchange_link.dart';
import 'package:blockle_app/services/transports.dart';
import 'package:blockle_app/state/app_state.dart';
import 'package:blockle_app/state/exchange_controller.dart';
import 'package:blockle_app/theme.dart';

/// A venue that answers from a table keyed on 'METHOD /path'. The surface is
/// part of the key on purpose — a stub that erased `/public` vs `/v1` would be
/// blind to exactly the bug that once made the whole tab report "unavailable".
HttpSend _venue(Map<String, Object?> routes) {
  return (HttpReq req) async {
    final key = '${req.method} ${Uri.parse(req.url).path}';
    if (!routes.containsKey(key)) {
      return HttpReply(404, jsonEncode({'error': 'no stub for $key'}));
    }
    final v = routes[key];
    return HttpReply(200, v is String ? v : jsonEncode(v));
  };
}

const _kMarkets = [
  {'symbol': 'RTM-USDT', 'base': 'RTM', 'quote': 'USDT', 'minBase': '1'},
  {'symbol': 'PEP-BLOCK', 'base': 'PEP', 'quote': 'BLOCK'},
  // The market the never-price-BLOCK-in-USD rule withholds.
  {'symbol': 'BLOCK-USDT', 'base': 'BLOCK', 'quote': 'USDT'},
];

Map<String, Object?> _routes() => <String, Object?>{
      'GET /public/status': {
        'live': true,
        'mainnetEnabled': true,
        'legalReviewCompleted': true,
        'network': 'mainnet',
        'ledgerPresent': true,
        'faucetAvailable': false,
      },
      'GET /public/markets': _kMarkets,
      'GET /public/tickers': [
        {'market': 'RTM-USDT', 'last': '0.012', 'bid': '0.011', 'ask': '0.013'},
      ],
      'GET /public/fees': {
        'makerPct': '0.20%',
        'takerPct': '0.20%',
        'makerBps': 20,
        'takerBps': 20,
        'note': 'Each side pays in the asset it receives.',
      },
      'GET /public/book/RTM-USDT': {
        'bids': [
          {'price': '0.011', 'base': '100'}
        ],
        'asks': [
          {'price': '0.013', 'base': '90'}
        ],
      },
      'GET /public/trades/RTM-USDT': <Object>[],
      'GET /public/book/PEP-BLOCK': {'bids': <Object>[], 'asks': <Object>[]},
      'GET /public/trades/PEP-BLOCK': <Object>[],
      'GET /v1/balances': [
        {
          'asset': 'RTM',
          'total': '10',
          'reserved': '4',
          'available': '6',
          'decimals': 8
        },
      ],
      'GET /v1/orders': [
        {
          'id': 'o1',
          'market': 'RTM-USDT',
          'side': 'buy',
          'state': 'open',
          'price': '0.010',
          'filled': '0',
          'total': '50',
          'createdAt': '2026-11-20T10:00:00Z',
        },
      ],
      'GET /v1/deposits': {'deposits': <Object>[]},
      'GET /v1/liquidity': <Object>[],
      'GET /v1/api-keys': {'keys': <Object>[], 'signing': {}},
      'GET /v1/2fa': {'enrolled': false},
      'GET /v1/allowlist': {'required': true, 'addresses': <Object>[]},
    };

ExchangeController _controller({bool signedIn = true}) => ExchangeController(
      client: ExchangeClient(
        send: _venue(_routes()),
        bearer: signedIn ? () => 'session-token' : () => null,
      ),
    );

void main() {
  _webParity();
  TestWidgetsFlutterBinding.ensureInitialized();

  const secureStorage =
      MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

  setUpAll(() {
    TestWidgetsFlutterBinding.ensureInitialized()
        .defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, (call) async {
      if (call.method == 'readAll') return <String, String>{};
      return null;
    });
  });

  tearDownAll(() {
    TestWidgetsFlutterBinding.ensureInitialized()
        .defaultBinaryMessenger
        .setMockMethodCallHandler(secureStorage, null);
  });

  // ------------------------------------------------------------- the table

  group('the section table is the one source of truth', () {
    test('every id is unique and resolvable', () {
      final ids = kExchangeSections.map((s) => s.id).toList();
      expect(ids.toSet().length, ids.length, reason: 'a duplicate id would make '
          'one of the two sections unreachable');
      for (final id in ids) {
        expect(exchangeSectionById(id)?.id, id);
      }
    });

    test('an unknown id falls back to a PUBLIC section, never to a locked one', () {
      final s = exchangeSectionOrDefault('no-such-section');
      expect(s.id, kDefaultExchangeSection);
      expect(s.authRequired, isFalse,
          reason: 'a stale link must land somewhere a signed-out visitor can '
              'actually read');
    });

    test('rail labels fit the 60pt rail: 8 glyphs, upper case, no spaces', () {
      for (final s in kExchangeSections) {
        expect(s.short.length, lessThanOrEqualTo(8),
            reason: '"${s.short}" would ellipsize in 48pt of inner width');
        expect(s.short, s.short.toUpperCase());
        expect(s.short.contains(' '), isFalse);
        expect(s.name, isNotEmpty);
      }
    });

    test('groups are contiguous — the rail draws its rule on each change', () {
      final seen = <ExchangeGroup>[];
      ExchangeGroup? last;
      for (final s in kExchangeSections) {
        if (s.group != last) {
          expect(seen.contains(s.group), isFalse,
              reason: 'group ${s.group} is interleaved, so the rail would draw '
                  'two separators for one band');
          seen.add(s.group);
          last = s.group;
        }
      }
      expect(seen.length, 3);
    });

    test('the sections that move or reveal money are the ones that need an account', () {
      String? find(String id) => exchangeSectionById(id)?.authRequired == true ? id : null;
      for (final id in const [
        'orders', 'balances', 'deposit', 'withdraw', 'liquidity',
        'api',
      ]) {
        expect(find(id), id, reason: '$id reads or moves the account\'s money');
      }
      for (final id in const ['markets', 'trade', 'fees', 'listing', 'account']) {
        expect(exchangeSectionById(id)!.authRequired, isFalse,
            reason: '$id is public on the web and must stay readable signed out');
      }
    });
  });

  // -------------------------------------------------------------- deep links

  group('deep links resolve against the table', () {
    test('a section link selects that section', () {
      final t = parseExchangeDeepLink(Uri.parse('blockle://exchange/withdraw'));
      expect(t?.section.id, 'withdraw');
      expect(t?.market, isNull);
    });

    test('a trade link carries the market, upper-cased', () {
      final t = parseExchangeDeepLink(Uri.parse('blockle://exchange/trade/rtm-usdt'));
      expect(t?.section.id, 'trade');
      expect(t?.market, 'RTM-USDT');
    });

    test('a market on a non-trade section is DROPPED, not half-applied', () {
      final t = parseExchangeDeepLink(Uri.parse('blockle://exchange/fees/RTM-USDT'));
      expect(t?.section.id, 'fees');
      expect(t?.market, isNull);
    });

    test('a bare exchange link opens the default section', () {
      expect(parseExchangeDeepLink(Uri.parse('blockle://exchange'))?.section.id,
          kDefaultExchangeSection);
    });

    test('an unknown section is refused rather than silently redirected', () {
      expect(parseExchangeDeepLink(Uri.parse('blockle://exchange/not-a-section')),
          isNull);
    });

    test('THE SCHEME IS "blockle" AND NOTHING ELSE', () {
      // `blockle_app` is the scheme that cost two TestFlight uploads to
      // ITMS-90158. It must not be honoured here either, or the app would grow
      // a reason to re-add it to the plist.
      // Dart will not even PARSE it: an underscore is not a legal scheme
      // character, which is the same rule Apple applies at the altool step.
      // Asserting the FormatException is stronger than asserting a null — it
      // shows the scheme cannot be smuggled in at all.
      expect(() => Uri.parse('blockle_app://exchange/trade'), throwsFormatException);
      expect(parseExchangeDeepLink(Uri.parse('https://exchange/trade')), isNull);
      expect(parseExchangeDeepLink(Uri.parse('blockle://dapp?req=abc')), isNull,
          reason: 'the dApp handshake link belongs to DappLink');
    });

    test('handleExchangeLink switches tabs WITHOUT renumbering anything', () {
      final app = AppState();
      expect(handleExchangeLink(Uri.parse('blockle://exchange/trade/PEP-BLOCK'), app),
          isTrue);
      expect(app.tabIndex, AppState.exchangeTabIndex);
      expect(AppState.exchangeTabIndex, 9,
          reason: 'the Exchange tab replaced the Shop IN PLACE; moving it would '
              'send every browser deep-link (browserTabIndex == 3) to the '
              'wrong page');
      expect(app.pendingExchangeSection, 'trade');
      expect(app.pendingExchangeMarket, 'PEP-BLOCK');

      // A link that is not ours is left for the other handlers.
      expect(handleExchangeLink(Uri.parse('blockle://dapp?req=x'), app), isFalse);
    });
  });

  // ------------------------------------------------------------ badge honesty

  group('rail dots never lie about a gate', () {
    RailBadge? badgeFor(String id, ExchangeBadgeState s) =>
        exchangeSectionById(id)!.badge?.call(s);

    test('an UNCHECKED withdrawal gate draws NO dot', () {
      // Nothing read yet: both halves null.
      expect(badgeFor('withdraw', const ExchangeBadgeState()), isNull,
          reason: '"blocked" for a check that has not run is a false alarm');
    });

    test('no authenticator draws a BAD dot', () {
      final b = badgeFor('withdraw',
          const ExchangeBadgeState(twoFactorEnrolled: false));
      expect(b?.tone, RailBadgeTone.bad);
    });

    test('an empty REQUIRED allowlist draws a BAD dot', () {
      final b = badgeFor(
        'withdraw',
        const ExchangeBadgeState(
            twoFactorEnrolled: true, allowlistRequired: true, allowlistEntries: 0),
      );
      expect(b?.tone, RailBadgeTone.bad,
          reason: 'with the allowlist required and empty, no withdrawal can '
              'succeed — the venue refuses it');
    });

    test('an enrolled authenticator with a populated allowlist draws nothing', () {
      expect(
        badgeFor(
          'withdraw',
          const ExchangeBadgeState(
              twoFactorEnrolled: true, allowlistRequired: true, allowlistEntries: 2),
        ),
        isNull,
      );
    });

    test('working orders / confirming deposits / resting ladders carry a count', () {
      expect(badgeFor('orders', const ExchangeBadgeState(ordersWorking: 3))?.count, 3);
      expect(badgeFor('orders', const ExchangeBadgeState())?.count, isNull);
      expect(
          badgeFor('deposit', const ExchangeBadgeState(depositsConfirming: 1))?.tone,
          RailBadgeTone.warn);
      expect(badgeFor('liquidity', const ExchangeBadgeState(laddersResting: 2))?.count, 2);
    });
  });

  // -------------------------------------------------------------- the rail

  group('the rail', () {
    Widget host(Widget child) => MaterialApp(
          theme: Bk.theme(),
          home: Scaffold(body: Row(children: [child, const Expanded(child: SizedBox())])),
        );

    testWidgets('renders EVERY section, and every glyph can say its own name',
        (tester) async {
      // A TALLER SURFACE THAN THE 600pt DEFAULT, because the point of this
      // test is that the table and the rail agree — not that eleven items fit
      // one phone screen. They do not, which is why the rail scrolls; asserting
      // on a viewport that clips the last item would make this test fail for
      // the wrong reason.
      tester.view.physicalSize = const Size(1200, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(host(ExchangeRail(
        selectedId: 'markets',
        onSelect: (_) {},
      )));
      for (final s in kExchangeSections) {
        expect(find.byTooltip(s.name), findsOneWidget,
            reason: '${s.id} is in the table but not drawn on the rail');
      }
    });

    testWidgets('only the SELECTED item shows its label', (tester) async {
      await tester.pumpWidget(host(ExchangeRail(
        selectedId: 'withdraw',
        onSelect: (_) {},
      )));
      expect(find.text('WITHDRAW'), findsOneWidget);
      expect(find.text('MARKETS'), findsNothing);
    });

    testWidgets('a tap reports the section that was tapped', (tester) async {
      final tapped = <String>[];
      await tester.pumpWidget(host(ExchangeRail(
        selectedId: 'markets',
        onSelect: (s) => tapped.add(s.id),
      )));
      await tester.tap(find.byTooltip('Deposit'));
      await tester.pump();
      expect(tapped, ['deposit']);

      // Re-tapping the open section is a no-op rather than a re-entry.
      await tester.tap(find.byTooltip('Markets'));
      await tester.pump();
      expect(tapped, ['deposit']);
    });

    testWidgets('the selection is marked TWICE — tint and capsule — not by colour alone',
        (tester) async {
      await tester.pumpWidget(host(ExchangeRail(
        selectedId: 'markets',
        onSelect: (_) {},
      )));
      // The accent capsule: a 3x24 box that exists only for the selected item.
      final capsules = tester
          .widgetList<Container>(find.byType(Container))
          .where((c) => c.constraints?.maxWidth == 3 || _isCapsule(c));
      expect(capsules, isNotEmpty,
          reason: 'the tint alone fails for a colour-blind user glancing at a '
              '20pt glyph');
    });

    testWidgets('the expanded rail shows full names (iPad), from the same table',
        (tester) async {
      await tester.pumpWidget(host(ExchangeRail(
        selectedId: 'markets',
        expanded: true,
        badges: const ExchangeBadgeState(ordersWorking: 4),
        onSelect: (_) {},
      )));
      // The web's own labels, from the web's own table.
      expect(find.text('Liquidity'), findsOneWidget);
      expect(find.text('Balances'), findsOneWidget);
      expect(find.text('List a coin'), findsOneWidget);
      expect(find.text('API'), findsOneWidget);
      // At 200pt a number beats a dot.
      expect(find.text('4'), findsOneWidget);
    });
  });

  // -------------------------------------------------------------- the shell

  group('the exchange tab shell', () {
    Future<ExchangeController> pumpShell(WidgetTester tester,
        {bool signedIn = true}) async {
      final c = _controller(signedIn: signedIn);
      final app = AppState();
      await tester.pumpWidget(MultiProvider(
        providers: [
          ChangeNotifierProvider<AppState>.value(value: app),
          ChangeNotifierProvider<ExchangeController>.value(value: c),
        ],
        child: MaterialApp(theme: Bk.theme(), home: const ExchangeScreen()),
      ));
      await tester.pumpAndSettle();
      return c;
    }

    testWidgets('opens on Markets with the rail beside it', (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      await pumpShell(tester);
      expect(find.byType(ExchangeRail), findsOneWidget);
      expect(find.text('Markets'), findsWidgets);
      // The fail-closed environment pill, with a live venue.
      expect(find.text('LIVE'), findsOneWidget);
    });

    // THE RULING THIS PINS REPLACED AN EARLIER ONE, so the old assertion is
    // worth naming: this test used to require that BLOCK-USDT be WITHHELD, on
    // the reading that a USD-stablecoin quote is a dollar price wearing a
    // ticker. Hiding it also hid a live market from the people trading it, and
    // the rule it was enforcing is about the DOLLAR SIGN AND THE CONVERSION,
    // not about the market's existence. So the market is listed, and what is
    // banned is renaming its quote: the figure is rendered strictly in its own
    // quote unit, with no `$`, no USD column and no converted second figure
    // anywhere in the tab. Those are the two halves of the same rule and this
    // asserts both — the pair is present, and nothing on screen prices it in
    // dollars.
    testWidgets('A BLOCK MARKET IS LISTED AND NEVER PRICED IN DOLLARS',
        (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final c = await pumpShell(tester);
      expect(c.markets.length, 3);
      expect(c.visibleMarkets.map((m) => m.id), contains('BLOCK-USDT'),
          reason: 'hiding a live market is not what the no-USD rule asks for; '
              'rendering it in its own quote unit is');
      expect(find.text('BLOCK/USDT'), findsOneWidget);

      // No withholding notice, because nothing is being withheld. A screen
      // that says it is hiding a market it is in fact showing is worse than
      // either behaviour on its own.
      expect(find.textContaining('not shown here'), findsNothing);

      // THE ACTUAL RULE: not one dollar sign in the rendered tab, and no USD
      // column header. Every price on screen is a figure plus its own quote
      // ticker.
      for (final t in tester.widgetList<Text>(find.byType(Text))) {
        final s = t.data ?? t.textSpan?.toPlainText() ?? '';
        expect(s, isNot(contains(r'$')),
            reason: 'a dollar sign reached the exchange tab in "$s"');
      }
    });

    testWidgets('the rail navigates every section without leaving the tab',
        (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 900 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final c = await pumpShell(tester);
      for (final s in kExchangeSections) {
        await tester.ensureVisible(find.byTooltip(s.name));
        await tester.tap(find.byTooltip(s.name));
        await tester.pumpAndSettle();
        expect(c.section, s.id, reason: 'tapping ${s.name} did not open it');
        // Every section renders SOMETHING with its own name on it — never a
        // blank pane.
        expect(find.byType(ExchangeRail), findsOneWidget,
            reason: 'the rail must survive every section');
        // AND IT IS NOT THE FALL-THROUGH. The content switch ends in an
        // ExPlaceholder that exists only so a table/switch divergence fails
        // readably instead of crashing — but reaching it means the rail is
        // drawing a glyph that opens nothing. Adding a section to
        // kExchangeSections without wiring a screen to it must fail HERE,
        // not in someone's hands.
        expect(find.text('This section has no screen wired to it.'), findsNothing,
            reason: '${s.id} is in the table but the shell has no screen for '
                'it — the rail offers a destination that does not exist');
      }
    });

    testWidgets('signed out, the rail stays usable and the gate is INLINE',
        (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 900 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final c = await pumpShell(tester, signedIn: false);
      await tester.tap(find.byTooltip('Balances'));
      await tester.pumpAndSettle();
      expect(c.section, 'balances');
      expect(find.textContaining('needs your Blockle account'), findsOneWidget);
      // THE POINT: the rail is not behind a curtain.
      expect(find.byType(ExchangeRail), findsOneWidget);
      expect(find.byTooltip('Markets'), findsOneWidget);

      // And a public section still reads. "List a coin" needs no account —
      // the web's rule too — so it renders its form, not the gate.
      await tester.tap(find.byTooltip('List a coin'));
      await tester.pumpAndSettle();
      expect(find.text('List a coin'), findsWidgets);
      expect(find.textContaining('Ask the venue to add a market'),
          findsOneWidget);
    });

    testWidgets('WITHDRAW states the gates it does not bypass', (tester) async {
      // This asserted a placeholder until the real screen landed. The ASSERTION
      // is the part that matters and it is unchanged: whatever is on this
      // section, it must name the authenticator and the allowlist, because
      // those are server refusals the app can neither skip nor hide — and it
      // must never grow a faucet, which is deleted server-side rather than
      // gated.
      tester.view.physicalSize = const Size(390 * 3, 900 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      await pumpShell(tester);
      await tester.tap(find.byTooltip('Withdraw'));
      await tester.pumpAndSettle();
      expect(find.textContaining('allowlist'), findsWidgets);
      expect(find.textContaining('authenticator'), findsWidgets);
      // No faucet, ever: the route is deleted server-side.
      expect(find.textContaining('faucet'), findsNothing);
    });

    testWidgets('a deep link lands on its section and market', (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 900 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final c = _controller();
      final app = AppState();
      await tester.pumpWidget(MultiProvider(
        providers: [
          ChangeNotifierProvider<AppState>.value(value: app),
          ChangeNotifierProvider<ExchangeController>.value(value: c),
        ],
        child: MaterialApp(theme: Bk.theme(), home: const ExchangeScreen()),
      ));
      await tester.pumpAndSettle();

      handleExchangeLink(Uri.parse('blockle://exchange/trade/PEP-BLOCK'), app);
      await tester.pumpAndSettle();
      expect(c.section, 'trade');
      expect(c.selected, 'PEP-BLOCK');
      // Consumed exactly once, so a rail tap afterwards is not undone.
      expect(app.pendingExchangeSection, isNull);
    });
  });
}

/// A 3x24 accent capsule, however the decoration is expressed.
bool _isCapsule(Container c) {
  final d = c.decoration;
  if (d is! BoxDecoration) return false;
  return d.color == Bk.accent;
}

/// THE TABLE IS A COPY OF THE WEBSITE'S, and this is what keeps it one.
///
/// exchange.blockle.org builds its rail, routes and screen ids from a single
/// array — `SCREENS` in deploy/exchange/frontpage/exchange.js. The app's
/// [kExchangeSections] is that array. It had drifted in four places (a
/// renamed Liquidity screen in the wrong group, a singular "balance", and no
/// rail item at all for the listing form or the API keys), which is what made
/// the tab read as a thinner, different product even though every screen's
/// content was built.
///
/// If the web adds or renames a screen, this fails, and that is the point: the
/// expected list below is transcribed from the web's table, so the two cannot
/// silently diverge again.
void _webParity() {
  group('web parity', () {
    test('the rail mirrors exchange.blockle.org screen for screen', () {
      // (id, label, group) exactly as exchange.js:209-221 declares them.
      const expected = <List<String>>[
        ['markets', 'Markets', 'Trade'],
        ['trade', 'Trade', 'Trade'],
        ['liquidity', 'Liquidity', 'Trade'],
        ['orders', 'Orders', 'Trade'],
        ['balances', 'Balances', 'Funds'],
        ['deposit', 'Deposit', 'Funds'],
        ['withdraw', 'Withdraw', 'Funds'],
        ['fees', 'Fees', 'Venue'],
        ['listing', 'List a coin', 'Venue'],
        ['api', 'API', 'Venue'],
        ['account', 'Account', 'Venue'],
      ];
      final actual = kExchangeSections
          .map((s) => [s.id, s.name, s.group.label])
          .toList();
      expect(actual, expected);
    });

    test('the auth flags match the web\'s, screen for screen', () {
      // `auth: true` in exchange.js. Markets, Trade, Fees, "List a coin" and
      // Account are public there and must be public here — a section the web
      // lets a stranger read must not ask the app's user to sign in.
      const needsAccount = <String>{
        'liquidity', 'orders', 'balances', 'deposit', 'withdraw', 'api',
      };
      for (final s in kExchangeSections) {
        expect(s.authRequired, needsAccount.contains(s.id),
            reason: '${s.id}: auth flag disagrees with the web');
      }
    });

    test('a shipped deep link to an OLD id still lands on its screen', () {
      // blockle://exchange/ladders is in a shipped build and in release notes.
      // It has to keep working rather than falling back to Markets.
      expect(exchangeSectionOrDefault('ladders').id, 'liquidity');
      expect(exchangeSectionOrDefault('balance').id, 'balances');
      expect(exchangeSectionOrDefault('venue').id, 'account');
      // And a genuinely unknown id still falls back, as the web does.
      expect(exchangeSectionOrDefault('no-such-screen').id, 'markets');
    });
  });
}
