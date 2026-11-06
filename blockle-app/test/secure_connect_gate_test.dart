// Tests for the secure dApp-connect gate (#127) added to the in-app browser
// (lib/screens/browser_tab.dart). They cover the parts that do not need the
// live vault/plugin stack:
//
//   RULES    rulesScreenSite() — the scam/denylist + host heuristics verdict
//            (punycode/lookalike/non-TLS) reused from the wallet's scam gate.
//   COMPOSE  composeScreeningConfig() — folds the rules verdict + the local-AI
//            protector assessment into ONE SecuritySheetConfig; any red flag is a
//            DANGER, which forces the explicit confirm.
//   GATE     showSecuritySheet() over that config — the NON-BYPASSABLE confirm:
//            a connection is BLOCKED (returns false) unless the user explicitly
//            approves, and a DANGER swaps the plain button for the
//            "I understand the risk" button (no auto-connect anywhere).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/screens/browser_tab.dart';
import 'package:blockle_app/screens/wallet/security_sheet.dart';
import 'package:blockle_app/services/agent_service.dart' show SiteScreening;

Widget _host(Future<bool> Function(BuildContext) run, void Function(bool) sink) =>
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (ctx) => ElevatedButton(
            onPressed: () async => sink(await run(ctx)),
            child: const Text('open'),
          ),
        ),
      ),
    );

void main() {
  group('RULES rulesScreenSite', () {
    test('a clean, trusted https dApp raises no warnings', () {
      expect(rulesScreenSite('https://app.uniswap.org'), isEmpty);
    });

    test('a punycode (lookalike) host is a DANGER', () {
      final w = rulesScreenSite('https://xn--ualet-6z5a.org'); // fake lookalike
      expect(w.any((x) => x.severity == 'danger'), isTrue);
    });

    test('a non-TLS (http) host is a WARNING', () {
      final w = rulesScreenSite('http://example.com');
      expect(w.any((x) => x.severity == 'warn'), isTrue);
    });

    test('a brand-lookalike domain is a WARNING', () {
      final w = rulesScreenSite('https://myuniswap-airdrop.com');
      expect(w.any((x) => x.severity == 'warn'), isTrue);
    });

    test('a raw-IP host is a WARNING', () {
      final w = rulesScreenSite('http://203.0.113.9');
      expect(w.any((x) => x.severity == 'warn'), isTrue);
    });
  });

  group('COMPOSE composeScreeningConfig', () {
    test('an AI red flag becomes a DANGER that forces the explicit confirm', () {
      final cfg = composeScreeningConfig(
        origin: 'https://app.uniswap.org',
        rules: const [],
        screening: const SiteScreening(
          ran: true,
          risk: 'high',
          assessment: 'Requests setApprovalForAll on an unknown spender.',
          redFlags: ['Unlimited approval to an unverified contract.'],
        ),
        forConnect: true,
      );
      expect(cfg.danger, isTrue);
      expect(cfg.approveLabel, contains('understand the risk'));
    });

    test('rules-only (no local AI) still yields a usable config + note', () {
      final cfg = composeScreeningConfig(
        origin: 'https://app.uniswap.org',
        rules: const [],
        screening: const SiteScreening(ran: false, note: 'No on-device AI is configured.'),
        forConnect: true,
      );
      expect(cfg.danger, isFalse);
      expect(cfg.approveLabel, 'Connect');
      expect(cfg.warnings.any((w) => w.message.contains('on-device AI')), isTrue);
    });
  });

  group('GATE showSecuritySheet (connection blocked until explicit approval)', () {
    testWidgets('a DANGER site forces the explicit confirm; REJECT blocks the '
        'connection (returns false)', (tester) async {
      bool? result;
      final cfg = composeScreeningConfig(
        origin: 'https://xn--phishy-lookalike.org',
        rules: rulesScreenSite('https://xn--phishy-lookalike.org'),
        screening: const SiteScreening(ran: false, note: 'rules-only'),
        forConnect: true,
      );
      await tester.pumpWidget(_host((ctx) => showSecuritySheet(ctx, cfg), (r) => result = r));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // DANGER (punycode) swaps the plain button for the explicit confirm.
      expect(find.textContaining('understand the risk'), findsOneWidget);
      expect(find.text('Connect'), findsNothing);

      // Reject → false → AppState.handleRpc('blockle_connect') never records the
      // site (the gate blocks the connection).
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
      expect(result, isFalse);
    });

    testWidgets('a clean site NEVER auto-connects: it still needs an explicit '
        'Connect tap, and a reject returns false', (tester) async {
      bool? result;
      final cfg = composeScreeningConfig(
        origin: 'https://app.uniswap.org',
        rules: const [],
        screening: const SiteScreening(ran: true, risk: 'low', assessment: 'No red flags.'),
        forConnect: true,
      );

      // First render: reject path blocks.
      await tester.pumpWidget(_host((ctx) => showSecuritySheet(ctx, cfg), (r) => result = r));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Connect'), findsOneWidget); // plain confirm, not auto-connected
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
      expect(result, isFalse);

      // Second render: an EXPLICIT Connect tap is required to approve.
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();
      expect(result, isTrue);
    });
  });
}
