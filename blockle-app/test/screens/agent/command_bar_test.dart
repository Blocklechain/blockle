// Dart port of blockle-extension/command-ui.test.js — the pure renderers for
// the natural-language COMMAND BAR surface. The UI owns no gate: it only renders
// what the router reports. These tests pin the event -> fragment mapping and the
// fact that the bar presents NO approve/sign control of its own (confirmation
// belongs to the shared security sheet via policy.gateConfirm). A widget smoke
// test exercises the input -> transcript path.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/screens/agent/command_bar.dart';

void main() {
  group('pure renderers (parity with command-ui.js)', () {
    test('intent label distinguishes action vs query', () {
      expect(cmdIntentLabel('action'), 'ACTION');
      expect(cmdIntentLabel('query'), 'QUERY');
      expect(cmdIntentLabel(null), 'QUERY'); // fail-safe default
    });

    test('plan renders one line per step, each surfaced for confirmation', () {
      final f = cmdEventFragment({
        'type': 'plan',
        'steps': [
          {'index': 0, 'action': 'swap', 'args': {'from': 'USDC', 'to': 'ETH', 'amount': '60000000'}},
          {'index': 1, 'action': 'swap', 'args': {'from': 'ETH', 'to': 'USDC', 'amount': '40000000'}},
        ],
      })!;
      expect(f.kind, 'plan');
      expect(f.planLines.length, 2, reason: 'two steps shown');
      expect(f.planLines[0], contains('USDC'));
      expect(f.planLines[0], contains('swap'));
      expect(f.text, contains('confirm'));
    });

    test('send plan line shows the asset symbol and the shortened recipient', () {
      final line = cmdPlanLine({
        'action': 'send',
        'args': {'chain': 'ethereum', 'amount': '0.1', 'to': '0x${'a' * 40}'},
      });
      expect(line, startsWith('send 0.1 ETHEREUM → 0x'));
      expect(line, contains('…'), reason: 'the long address is shortened');
    });

    test('resolved mapping shows name -> resolved address + source (anti-spoofing)', () {
      final f = cmdEventFragment({
        'type': 'resolved',
        'input': 'alice.eth',
        'address': '0x${'b' * 40}',
        'source': 'ens',
      })!;
      expect(f.kind, 'resolved');
      expect(f.text, contains('alice.eth'));
      expect(f.text, contains('ens'));
      expect(f.text, contains('0x${'b' * 40}'));
    });

    test('eventFragment maps router events to fragments and ignores unknowns', () {
      expect(cmdEventFragment({'type': 'intent', 'intent': 'action'})!.text, 'ACTION');

      final exec = cmdEventFragment(
          {'type': 'executed', 'name': 'send', 'txid': '0xdeadbeefcafef00d'})!;
      expect(exec.status, 'committed');
      expect(exec.text, contains('confirmed & sent'));

      final declined = cmdEventFragment({'type': 'declined', 'name': 'send'})!;
      expect(declined.status, 'declined');
      expect(declined.text, contains('declined'));

      final err = cmdEventFragment(
          {'type': 'step_error', 'name': 'send', 'error': 'per-asset cap exceeded'})!;
      expect(err.kind, 'error');
      expect(err.text, contains('cap exceeded'));

      final ans = cmdEventFragment({'type': 'text', 'text': 'your net worth is \$123.45'})!;
      expect(ans.kind, 'answer');
      expect(ans.text, contains('123.45'));

      // unknown / intermediate events are ignored (no fragment)
      expect(cmdEventFragment({'type': 'prepared', 'name': 'send'}), isNull);
      expect(cmdEventFragment({'type': 'step', 'action': 'send'}), isNull);
      expect(cmdEventFragment(null), isNull);
      expect(cmdEventFragment({}), isNull);
    });

    test('the command bar presents NO approve/sign control — only reported outcomes', () {
      // Outcome/plan fragments are inert text with a status, never an actionable
      // control. Confirmation lives in the shared security sheet (policy.gateConfirm).
      final outcome = cmdEventFragment({'type': 'executed', 'name': 'send', 'txid': '0xabc'})!;
      expect(const {'you', 'intent', 'plan', 'resolved', 'answer', 'outcome', 'error'}
          .contains(outcome.kind), isTrue);
      expect(cmdStepOutcomeLabel('committed'), isNot(anyOf(contains('approve'), contains('sign'))));
    });

    test('engine/user strings are carried verbatim as data (Flutter Text renders inertly)', () {
      // No HTML string-building here — the payload is preserved literally and the
      // widget renders it through a Text (which never interprets markup), so there
      // is no injection surface at all.
      final f = cmdEventFragment({'type': 'text', 'text': '<img src=x onerror=alert(1)>'})!;
      expect(f.text, '<img src=x onerror=alert(1)>');
    });
  });

  group('widget', () {
    testWidgets('typing a command with no running channel reports it, nothing signs',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: CommandBar(
            enabled: true,
            // the host returns null when no channel/provider is available.
            buildRouter: ({onEvent}) => null,
          ),
        ),
      ));

      await tester.enterText(find.byType(TextField), 'what is my net worth?');
      await tester.tap(find.text('Run'));
      await tester.pumpAndSettle();

      expect(find.textContaining('“what is my net worth?”'), findsOneWidget);
      expect(find.textContaining('Connect an agent channel first'), findsOneWidget);
    });

    testWidgets('a disabled bar does not accept input', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: CommandBar(enabled: false, buildRouter: ({onEvent}) => null),
        ),
      ));
      final btn = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(btn.onPressed, isNull, reason: 'Run is disabled when no channel runs');
    });
  });
}
