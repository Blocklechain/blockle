// Widget + unit tests for the native Blockle Bots UI. These cover the parts that
// do not require the full vault/secure-storage stack: the design-token set, the
// shared widgets, and — critically — the deal-ladder PREVIEW math, which is
// computed with the real engine helpers (bots.dart) so the picture equals the
// exact fills a paper/live deal would execute (never a mock projection).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/screens/bots/bots_tokens.dart';
import 'package:blockle_app/screens/bots/bots_widgets.dart';
import 'package:blockle_app/screens/bots/charts.dart';
import 'package:blockle_app/screens/bots/cockpit_view.dart';

Widget _host(Brightness b, Widget child) => MaterialApp(
      home: BotTheme(
        tokens: BotTokens.of(b),
        child: Scaffold(body: Center(child: child)),
      ),
    );

void main() {
  group('BotTokens (ported design contract)', () {
    test('light and dark are distinct, validated steps (never an auto-invert)', () {
      expect(BotTokens.dark.brightness, Brightness.dark);
      expect(BotTokens.light.brightness, Brightness.light);
      expect(BotTokens.dark.ground, isNot(BotTokens.light.ground));
      expect(BotTokens.dark.accent, const Color(0xFF4C8DFF));
      expect(BotTokens.light.accent, const Color(0xFF2F6FF0));
      // categorical triad present for the deal ladder (dataviz palette)
      expect(BotTokens.dark.kBase, isNot(BotTokens.dark.kSafety));
      expect(BotTokens.dark.kSafety, isNot(BotTokens.dark.kTp));
    });

    test('pnlColor is sign-explicit with a neutral zero', () {
      final t = BotTokens.dark;
      expect(t.pnlColor(5), t.gain);
      expect(t.pnlColor(-5), t.loss);
      expect(t.pnlColor(0), t.inkMuted);
    });
  });

  group('moneyUsd formatting', () {
    test('signed, grouped, two decimals; minus is a true minus glyph', () {
      expect(moneyUsd(1284.6), '+\$1,284.60');
      expect(moneyUsd(-12.4), '−\$12.40');
      expect(moneyUsd(47.8, sign: false), '\$47.80');
      expect(moneyUsd(0), '+\$0.00');
    });
  });

  group('DealPreview (engine-exact ladder math)', () {
    test('base-only DCA lands at entry; TP is +tp% of avg entry', () {
      final p = DealPreview.fromDca(
        baseOrderUsd: 100,
        safetyOrders: 0,
        stepPct: 2,
        volumeScale: 1,
        takeProfitPct: 2,
        priceUsd: 100,
        decimals: 9,
      );
      expect(p.legs.length, 1);
      expect(p.avgEntryUsd, closeTo(100, 1e-6));
      expect(p.takeProfitUsd, closeTo(102, 1e-6));
      expect(p.maxDealUsd, closeTo(100, 1e-6));
      expect(p.dipPct, closeTo(0, 1e-9));
    });

    test('safety ladder lowers avg entry, widens the covered dip, grows max deal', () {
      final p = DealPreview.fromDca(
        baseOrderUsd: 100,
        safetyOrders: 3,
        stepPct: 2,
        volumeScale: 1.4,
        takeProfitPct: 2,
        priceUsd: 100,
        decimals: 9,
      );
      expect(p.legs.length, 4); // base + 3 safety
      expect(p.legs.first.kind, 'base');
      expect(p.legs.last.kind, 'safety');
      // avg entry sits below spot once safety orders fill below it
      expect(p.avgEntryUsd, lessThan(100));
      expect(p.takeProfitUsd, greaterThan(p.avgEntryUsd));
      // max deal = base + base*1.4 + base*1.4^2 + base*1.4^3
      expect(p.maxDealUsd, closeTo(100 + 140 + 196 + 274.4, 0.5));
      // 3 steps of ~2% compounding down
      expect(p.dipPct, greaterThan(5.5));
      expect(p.dipPct, lessThan(6.5));
    });
  });

  group('shared widgets render in both themes', () {
    for (final b in Brightness.values) {
      testWidgets('ModeBadge + AllocBar + BotButton ($b)', (tester) async {
        var tapped = false;
        await tester.pumpWidget(_host(
          b,
          Column(mainAxisSize: MainAxisSize.min, children: [
            const ModeBadge(live: true),
            const ModeBadge(live: false),
            const SizedBox(width: 120, child: AllocBar(fraction: 0.48)),
            BotButton(label: 'Go live', primary: true, onPressed: () => tapped = true),
          ]),
        ));
        expect(find.text('Live'), findsOneWidget);
        expect(find.text('Paper'), findsOneWidget);
        expect(find.text('Go live'), findsOneWidget);
        await tester.tap(find.text('Go live'));
        expect(tapped, isTrue);
      });
    }

    testWidgets('BotFilterSeg (now in the top bar) selects Paper/Live/All', (tester) async {
      var picked = BotFilter.all;
      await tester.pumpWidget(_host(
        Brightness.dark,
        BotFilterSeg(filter: BotFilter.all, onFilter: (f) => picked = f),
      ));
      expect(find.text('All'), findsOneWidget);
      expect(find.text('Paper'), findsOneWidget);
      expect(find.text('Live'), findsOneWidget);
      await tester.tap(find.text('Live'));
      expect(picked, BotFilter.live);
      await tester.tap(find.text('Paper'));
      expect(picked, BotFilter.paper);
    });

    testWidgets('a per-card minispark renders only with >=2 points', (tester) async {
      // <2 points: the mini sparkline must paint nothing (and never throw).
      await tester.pumpWidget(_host(
        Brightness.dark,
        const SizedBox(width: 72, child: Sparkline(data: [0], up: true, mini: true, height: 30)),
      ));
      expect(tester.takeException(), isNull);
      // >=2 points: paints the cumulative curve.
      await tester.pumpWidget(_host(
        Brightness.light,
        const SizedBox(width: 72, child: Sparkline(data: [0, 2, 1, 4], up: true, mini: true, height: 30)),
      ));
      expect(tester.takeException(), isNull);
    });

    testWidgets('Sparkline + LadderChart paint without error', (tester) async {
      final preview = DealPreview.fromDca(
        baseOrderUsd: 100,
        safetyOrders: 3,
        stepPct: 2,
        volumeScale: 1.4,
        takeProfitPct: 2,
        priceUsd: 142.8,
      );
      await tester.pumpWidget(_host(
        Brightness.dark,
        Column(children: [
          const SizedBox(
              width: 200, child: Sparkline(data: [0, 3, 2, 6, 5, 9], up: true)),
          SizedBox(
              width: 320,
              child: LadderChart(preview: preview, priceUsd: 142.8)),
        ]),
      ));
      expect(tester.takeException(), isNull);
    });
  });
}
