// Widget + unit tests for the native multi-chain WALLET UI. These cover the
// parts that do not require the full vault/secure-storage stack: the shared
// security confirm sheet (used by BOTH Send and dApp requests), its config
// builders over the REAL security suite (so the sheet shows exactly what the
// pre-sign inspector decoded), the "N checks ran" transparency line, and the
// shared presentation widgets — rendered in both themes.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/multichain/security.dart' as sec;
import 'package:blockle_app/screens/bots/bots_tokens.dart';
import 'package:blockle_app/screens/wallet/security_sheet.dart';
import 'package:blockle_app/screens/wallet/wallet_widgets.dart';

Widget _host(Brightness b, Widget child) => MaterialApp(
      home: BotTheme(
        tokens: BotTokens.of(b),
        child: Scaffold(body: Center(child: child)),
      ),
    );

void main() {
  group('checksLineFor (transparency — never a safety claim)', () {
    test('counts ran + skipped and never claims safe', () {
      expect(checksLineFor(3, const []), '3 checks ran. Nothing here claims this is safe.');
      expect(checksLineFor(1, const []), startsWith('1 check ran'));
      final withSkips = checksLineFor(4, const [
        {'code': 'approval-to-eoa', 'reason': 'no RPC'}
      ]);
      expect(withSkips, contains('4 checks ran'));
      expect(withSkips, contains('1 skipped'));
      // the line disclaims safety ("Nothing … claims this is safe") — it never
      // asserts the tx IS safe.
      expect(withSkips.toLowerCase(), contains('nothing here claims this is safe'));
    });
  });

  group('SecuritySheetConfig.fromInspection (real security suite)', () {
    test('a clean send produces a plain Approve + no danger', () async {
      final insp = await sec.inspectTransaction(
        {'chain': 'ethereum', 'to': '0x1111111111111111111111111111111111111111', 'value': '1000'},
        const sec.SecCtx(),
      );
      final cfg = SecuritySheetConfig.fromInspection(insp, title: 'Review send');
      expect(cfg.danger, isFalse);
      expect(cfg.approveLabel, 'Approve');
      expect(cfg.rows, isNotEmpty); // decoded details become preview rows
      expect(cfg.checksLine, contains('Nothing'));
    });

    test('a flagged recipient forces the explicit "understand the risk" button', () async {
      const drainer = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
      final insp = await sec.inspectTransaction(
        {'chain': 'ethereum', 'to': drainer, 'value': '1000'},
        const sec.SecCtx(config: {'denylist': [drainer]}),
      );
      expect(insp.severity, 'danger');
      final cfg = SecuritySheetConfig.fromInspection(insp, title: 'Review send');
      expect(cfg.danger, isTrue);
      expect(cfg.approveLabel, contains('understand the risk'));
      expect(cfg.warnings.any((w) => w.severity == 'danger'), isTrue);
    });
  });

  group('SecuritySheetConfig.fromDecoded (WalletConnect path)', () {
    test('maps decoded warnings + derives the danger button', () {
      final cfg = SecuritySheetConfig.fromDecoded({
        'summary': 'Sign off-chain approval (Permit2) — UNLIMITED',
        'details': [
          {'label': 'Spender', 'value': '0xabc'},
          {'label': 'Allowance', 'value': 'UNLIMITED'},
        ],
        'warnings': [
          sec.Warning('permit-unlimited', 'danger', 'Unlimited allowance'),
        ],
        'severity': 'danger',
      }, title: 'eth_signTypedData_v4');
      expect(cfg.danger, isTrue);
      expect(cfg.approveLabel, contains('understand the risk'));
      expect(cfg.rows.length, 2);
    });
  });

  group('shared security sheet renders + gates in both themes', () {
    for (final b in Brightness.values) {
      testWidgets('reject returns false, approve returns true ($b)', (tester) async {
        bool? result;
        await tester.pumpWidget(_host(
          b,
          Builder(builder: (ctx) {
            return ElevatedButton(
              onPressed: () async {
                result = await showSecuritySheet(
                  ctx,
                  const SecuritySheetConfig(
                    title: 'Review send',
                    previewHeader: 'Send on Ethereum',
                    rows: [MapEntry('To', '0x1111…1111'), MapEntry('Amount', '0.5 ETH')],
                    warnings: [SheetWarning('warn', 'First time sending here')],
                    checksLine: '6 checks ran. Nothing here claims this is safe.',
                  ),
                );
              },
              child: const Text('open'),
            );
          }),
        ));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        expect(find.text('Review send'), findsOneWidget);
        expect(find.text('Reject'), findsOneWidget);
        expect(find.text('Approve'), findsOneWidget);
        expect(find.textContaining('6 checks ran'), findsOneWidget);
        await tester.tap(find.text('Reject'));
        await tester.pumpAndSettle();
        expect(result, isFalse);

        // reopen and approve
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Approve'));
        await tester.pumpAndSettle();
        expect(result, isTrue);
      });

      testWidgets('a DANGER warning swaps in the explicit confirm button ($b)', (tester) async {
        await tester.pumpWidget(_host(
          b,
          Builder(builder: (ctx) {
            return ElevatedButton(
              onPressed: () => showSecuritySheet(
                ctx,
                const SecuritySheetConfig(
                  title: 'Signature request',
                  dappName: 'Uniswap',
                  dappUrl: 'app.uniswap.org',
                  previewHeader: 'eth_signTypedData_v4 — Permit2',
                  rows: [MapEntry('Allowance', 'UNLIMITED')],
                  warnings: [SheetWarning('danger', 'Unlimited approval')],
                  checksLine: '5 checks ran. Nothing here claims this is safe.',
                  approveLabel: 'I understand the risk — approve',
                ),
              ),
              child: const Text('open'),
            );
          }),
        ));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        expect(find.text('Signature request'), findsOneWidget);
        expect(find.textContaining('understand the risk'), findsOneWidget);
        expect(find.text('Approve'), findsNothing);
        expect(find.textContaining('Unlimited approval'), findsOneWidget);
      });
    }
  });

  group('shared wallet widgets render in both themes', () {
    for (final b in Brightness.values) {
      testWidgets('WCard + SectionHead + TokenBubble + WTag ($b)', (tester) async {
        await tester.pumpWidget(_host(
          b,
          Column(mainAxisSize: MainAxisSize.min, children: const [
            SectionHead(title: 'Holdings', count: '6'),
            WCard(padding: EdgeInsets.all(12), child: TokenBubble(label: 'ETH')),
            WTag('UNPRICED', bordered: true),
          ]),
        ));
        expect(find.text('Holdings'), findsOneWidget);
        expect(find.text('6'), findsOneWidget);
        expect(find.text('ET'), findsOneWidget); // two-letter token mark
        expect(find.text('UNPRICED'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    test('colorForChain + shortAddr are deterministic', () {
      final t = BotTokens.dark;
      expect(colorForChain('ethereum', t), t.kBase);
      expect(colorForChain('solana', t), t.kTp);
      expect(shortAddr('0x1234567890abcdef1234'), '0x123456…1234');
      expect(shortAddr('short'), 'short');
    });
  });
}
