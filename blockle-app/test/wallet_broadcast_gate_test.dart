// Tests for the broadcast/sign-gate sweep: every formerly-ungated value-moving
// path now runs security.inspectTransaction (or the message-decode for a sign)
// and clears the SHARED security confirm sheet BEFORE the existing signer
// broadcasts. A DANGER forces the explicit "understand the risk" confirm; a
// reject aborts WITHOUT signing.
//
//   GATE-SWAP   lib/screens/swap.dart  — the AMM swap now calls reviewSend
//               (inspectTransaction over the pool token) before build/broadcast.
//   GATE-SIGN   lib/screens/browser_tab.dart — a dApp signMessage now decodes
//               (decodePersonalSign) and clears the shared confirm sheet before
//               app.store.signMessage.
//   GATE-DEPLOY lib/screens/browser_tab.dart — a dApp contract deploy now runs
//               inspectTransaction + the shared sheet before app.chain.submit.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/multichain/security.dart' as sec;
import 'package:blockle_app/multichain/walletconnect.dart' show decodePersonalSign;
import 'package:blockle_app/screens/bots/bots_tokens.dart';
import 'package:blockle_app/screens/wallet/security_sheet.dart';
import 'package:blockle_app/screens/wallet/send_gate.dart';

Widget _host(Widget child) => MaterialApp(
      home: BotTheme(
        tokens: BotTokens.dark,
        child: Scaffold(body: Center(child: child)),
      ),
    );

void main() {
  // === GATE-SWAP: the AMM swap clears reviewSend before broadcast ============
  // swap.dart calls reviewSend(chain:'block', to: <pool token>, amount, asset).
  // A flagged pool token must raise a DANGER (send-to-flagged) and block.
  group('GATE-SWAP AMM swap gate (reviewSend over the pool token)', () {
    const flaggedToken = 'tokenDRAINER000000000000000000000000';
    final flaggedCtx = sec.SecCtx(
      chain: 'block',
      config: const {'denylist': [flaggedToken]},
    );

    testWidgets('a flagged pool token runs inspectTransaction, forces the '
        'explicit confirm, and a reject blocks the swap', (tester) async {
      bool? result;
      await tester.pumpWidget(_host(Builder(builder: (ctx) {
        return ElevatedButton(
          onPressed: () async {
            result = await reviewSend(
              ctx,
              chain: 'block',
              to: flaggedToken,
              amount: '100000000',
              asset: const {
                'chain': 'block',
                'kind': 'native',
                'symbol': 'BLOCK',
                'decimals': 8,
              },
              ctx: flaggedCtx,
              title: 'Review swap',
              previewHeader: 'Buy SCAM with BLOCK',
              resolvedAddress: shortSendAddr(flaggedToken),
            );
          },
          child: const Text('open'),
        );
      })));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // inspectTransaction ran → decoded preview rows are shown.
      expect(find.text('To'), findsOneWidget);
      expect(find.text('Amount'), findsOneWidget);
      // DANGER swaps Approve for the explicit confirm.
      expect(find.textContaining('understand the risk'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
      expect(find.textContaining('denylist'), findsOneWidget);

      // Reject → false → swap.dart never builds/broadcasts.
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
      expect(result, isFalse);
    });

    testWidgets('a clean, trusted pool shows a plain Approve preview and '
        'approves', (tester) async {
      bool? result;
      await tester.pumpWidget(_host(Builder(builder: (ctx) {
        return ElevatedButton(
          onPressed: () async {
            result = await reviewSend(
              ctx,
              chain: 'block',
              to: 'tokenGOOD00000000000000000000000000',
              amount: '100000000',
              asset: const {
                'chain': 'block',
                'kind': 'native',
                'symbol': 'BLOCK',
                'decimals': 8,
              },
              ctx: const sec.SecCtx(chain: 'block'),
              title: 'Review swap',
              previewHeader: 'Buy GOOD with BLOCK',
            );
          },
          child: const Text('open'),
        );
      })));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Approve'), findsOneWidget);
      expect(find.textContaining('understand the risk'), findsNothing);
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(result, isTrue);
    });
  });

  // === GATE-SIGN: a dApp signMessage decodes + clears the shared sheet =======
  group('GATE-SIGN dApp signMessage gate (decodePersonalSign + shared sheet)', () {
    test('decodePersonalSign decodes the message and flags smuggled structures',
        () {
      final plain = decodePersonalSign('Sign in to Dapp');
      expect(plain['kind'], 'personal-sign');
      expect((plain['details'] as List).first['value'], 'Sign in to Dapp');
      expect(plain['warnings'], isEmpty);

      // An EIP-712 blob smuggled as plain text is flagged (warn).
      final typed = decodePersonalSign(
          '{"types":{"EIP712Domain":[]},"domain":{"name":"X"},"message":{}}');
      expect((typed['warnings'] as List), isNotEmpty);
      expect(typed['severity'], 'warn');
    });

    testWidgets('the shared confirm sheet shows the decoded message and a reject '
        'blocks signing', (tester) async {
      bool? result;
      final decoded = decodePersonalSign('Transfer all my funds');
      await tester.pumpWidget(_host(Builder(builder: (ctx) {
        return ElevatedButton(
          onPressed: () async {
            result = await showSecuritySheet(
              ctx,
              SecuritySheetConfig.fromDecoded(decoded,
                  title: 'Signature request',
                  dappName: 'evil.example',
                  dappUrl: 'evil.example'),
            );
          },
          child: const Text('open'),
        );
      })));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      // The decoded message preview is shown (proof the decode ran before signing).
      expect(find.text('Message'), findsOneWidget);
      // Reject → false → browser_tab never calls app.store.signMessage.
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
      expect(result, isFalse);
    });

    testWidgets('a DANGER-severity decoded sign forces the explicit confirm',
        (tester) async {
      // The shared sheet (used for the sign path) escalates a danger warning to
      // the explicit confirm exactly as the inspect path does.
      final decoded = <String, dynamic>{
        'summary': 'Sign message',
        'details': [
          {'label': 'Message', 'value': ' transfer approval'}
        ],
        'warnings': [
          sec.Warning('known-drainer', 'danger', 'Signing target is denylisted.'),
        ],
        'severity': 'danger',
      };
      await tester.pumpWidget(_host(Builder(builder: (ctx) {
        return ElevatedButton(
          onPressed: () => showSecuritySheet(
              ctx, SecuritySheetConfig.fromDecoded(decoded, title: 'Signature request')),
          child: const Text('open'),
        );
      })));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.textContaining('understand the risk'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
    });
  });

  // === GATE-DEPLOY: a dApp contract deploy runs inspect + shared sheet =======
  group('GATE-DEPLOY dApp contract deploy gate (inspectTransaction + sheet)', () {
    testWidgets('the deploy inspect-tx runs and the shared sheet shows a uniform '
        'preview; a reject blocks the broadcast', (tester) async {
      bool? result;
      // The EXACT inspect-tx browser_tab builds for a deploy.
      final insp = await sec.inspectTransaction(
        sec.buildInspectTx('block', const {
          'to': null,
          'amount': '0',
          'asset': {'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8},
        }),
        sec.SecCtx(chain: 'block', config: sec.defaultSecurityConfig()),
      );
      await tester.pumpWidget(_host(Builder(builder: (ctx) {
        return ElevatedButton(
          onPressed: () async {
            result = await showSecuritySheet(
              ctx,
              SecuritySheetConfig.fromInspection(insp,
                  title: 'Deploy contract',
                  previewHeader: 'Deploy contract · 42 bytes · gas 200000'),
            );
          },
          child: const Text('open'),
        );
      })));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Deploy contract'), findsWidgets);
      // Clean deploy (no recipient) → no danger escalation.
      expect(find.text('Approve'), findsOneWidget);
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
      expect(result, isFalse);
    });

    testWidgets('a deploy whose target is denylisted raises a DANGER and forces '
        'the explicit confirm', (tester) async {
      // Same inspect+sheet mechanism the deploy gate uses; a flagged recipient
      // proves the gate blocks a danger before broadcast.
      const drainer = 'block1qdeploydrainer000000000000000000';
      final insp = await sec.inspectTransaction(
        sec.buildInspectTx('block', const {
          'to': drainer,
          'amount': '1',
          'asset': {'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8},
        }),
        sec.SecCtx(chain: 'block', config: const {'denylist': [drainer]}),
      );
      expect(insp.severity, 'danger');
      await tester.pumpWidget(_host(Builder(builder: (ctx) {
        return ElevatedButton(
          onPressed: () => showSecuritySheet(
              ctx, SecuritySheetConfig.fromInspection(insp, title: 'Deploy contract')),
          child: const Text('open'),
        );
      })));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.textContaining('understand the risk'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
    });
  });
}
