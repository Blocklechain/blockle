// Notifier-surface tests (AGENT-STRATEGIES.md section 8): the injectable
// interface, the realized-profit copy EXACTLY as pinned ("+$45.00 — sold 1.5 SOL
// → USDC"), and the USD/quantity formatters.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/notify.dart';

void main() {
  group('formatters', () {
    test('formatUsd groups thousands and signs', () {
      expect(formatUsd(45), '\$45.00');
      expect(formatUsd(45, sign: true), '+\$45.00');
      expect(formatUsd(1234.5), '\$1,234.50');
      expect(formatUsd(-12.1, sign: true), '-\$12.10');
      expect(formatUsd(0.005), '\$0.01'); // rounds to cents
    });

    test('formatQty trims using decimals; raw when unknown', () {
      expect(formatQty(BigInt.from(150000000), decimals: 8), '1.5');
      expect(formatQty(BigInt.from(300000000), decimals: 8), '3');
      expect(formatQty(BigInt.from(150000000)), '150000000'); // no decimals known
      expect(formatQty(BigInt.from(1050), decimals: 3), '1.05');
    });
  });

  group('realized-profit copy', () {
    test('matches the pinned example exactly', () {
      final event = {
        'asset': 'SOL',
        'soldQty': '150000000',
        'proceedsUsd': 225.0,
        'basisUsd': 180.0,
        'realizedUsd': 45.0,
        'stable': 'USDC',
        'venue': 'evmdex',
        'txid': '0xabc',
      };
      final n = realizedProfitNotification(event, decimals: 8);
      expect(n.title, '+\$45.00 — sold 1.5 SOL → USDC');
      expect(n.subtitle, '\$180.00 basis → \$225.00 proceeds');
      expect(n.tag, '0xabc');
    });
  });

  group('injectable surfaces', () {
    test('RecordingNotifier captures; CallbackNotifier forwards', () async {
      final rec = RecordingNotifier();
      await rec.notify(const AgentNotification(title: 'hi'));
      expect(rec.sent.single.title, 'hi');

      AgentNotification? seen;
      final cb = CallbackNotifier((n) => seen = n);
      await cb.notify(const AgentNotification(title: 'yo', subtitle: 'sub'));
      expect(seen!.title, 'yo');
      expect(seen!.toString(), 'yo\nsub');
    });
  });
}
