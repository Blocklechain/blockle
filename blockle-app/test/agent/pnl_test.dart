// Realized-profit engine tests (AGENT-STRATEGIES.md section 8): the pinned
// avg-cost ledger CANONICAL VECTOR (+$45.00, avg cost unchanged), the single
// post-commit hook firing exactly once on a positive stablecoin exit through the
// ONE shared value-moving dispatch, the unknown-basis `requireBasis` guard,
// silent losses, and no-pop on a non-stable output.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/notify.dart';
import 'package:blockle_app/agent/pnl.dart';
import 'package:blockle_app/agent/policy.dart';
import 'package:blockle_app/agent/runner.dart' show dispatchValueMoving;
import 'package:blockle_app/agent/tools.dart';

BigInt coins(num n) => BigInt.from((n * 1e8).round()); // 8-dp base units
BigInt usdc(num n) => BigInt.from((n * 1e6).round()); // USDC base (6 dp)
BigInt uc(num usd) => BigInt.from((usd * 1e6).round()); // microdollars

/// A minimal value-moving `swap` tool whose prepare() echoes a fixed fill, so we
/// can exercise the real `dispatchValueMoving` post-commit hook end-to-end.
Tool _fakeSwap({
  required String from,
  required String to,
  required String amount,
  required String amountOut,
  required void Function() onCommit,
}) {
  return Tool(
    name: 'swap',
    description: 'test swap',
    valueMoving: true,
    parameters: const {'type': 'object', 'properties': {}},
    prepare: (a) async => PreparedAction(
      summary: {
        'action': 'swap',
        'venue': 'evmdex',
        'from': from,
        'to': to,
        'amount': amount,
        'amountOut': amountOut,
      },
      value: const SpendValue(asset: null, amount: '0', usd: null),
      commit: () async {
        onCommit();
        return {'txid': '0xdead', 'accepted': true};
      },
    ),
  );
}

void main() {
  group('avg-cost ledger — pinned semantics', () {
    test('CANONICAL VECTOR: realized = +\$45.00, avg cost unchanged', () {
      final led = PnlLedger();
      const w = 'w', c = 'main', a = 'SOL';

      // buy 2 coins @ $100 -> costUc 200_000_000
      led.recordBuy(wallet: w, channel: c, asset: a, qty: coins(2), costUc: uc(200));
      // buy 1 coin @ $160 -> costUc +160_000_000 => 360_000_000; qty 3e8
      led.recordBuy(wallet: w, channel: c, asset: a, qty: coins(1), costUc: uc(160));

      final before = led.lotOf(w, c, a)!;
      expect(before.qty, coins(3));
      expect(before.costUc, uc(360)); // 360_000_000
      // avg = 360_000_000 / 3e8 = 1.2 microdollars/base-unit ($120/coin)

      // sell 1.5 coins @ $150 -> proceedsUc 225_000_000
      final sale = led.recordSell(
        wallet: w,
        channel: c,
        asset: a,
        sellQty: coins(1.5),
        proceedsUc: uc(225),
      );

      expect(sale.basisUc, uc(180)); // round(1.2 * 1.5e8) = 180_000_000
      expect(sale.realizedUc, uc(45)); // 225_000_000 - 180_000_000
      expect(sale.realizedUsd, 45.00); // +$45.00 EXACTLY
      expect(sale.basisKnown, isTrue);
      expect(sale.proceedsKnown, isTrue);

      final after = led.lotOf(w, c, a)!;
      expect(after.qty, coins(1.5)); // 1.5e8 remaining
      expect(after.costUc, uc(180)); // 180_000_000
      // avg cost unchanged: before.costUc/before.qty == after.costUc/after.qty
      expect(after.costUc * before.qty, before.costUc * after.qty);
    });

    test('partial sells are BigInt/integer-exact and round correctly', () {
      final led = PnlLedger();
      // 3 units costing 100 microdollars -> avg 100/3 (non-integer)
      led.recordBuy(wallet: 'w', channel: 'c', asset: 'X', qty: BigInt.from(3), costUc: BigInt.from(100));
      final s = led.recordSell(wallet: 'w', channel: 'c', asset: 'X', sellQty: BigInt.from(1), proceedsUc: BigInt.from(40));
      // round(100 * 1 / 3) = round(33.33) = 33
      expect(s.basisUc, BigInt.from(33));
      expect(s.realizedUc, BigInt.from(7));
      final lot = led.lotOf('w', 'c', 'X')!;
      expect(lot.qty, BigInt.from(2));
      expect(lot.costUc, BigInt.from(67));
    });

    test('unknown basis (never acquired via the agent) is flagged, not faked', () {
      final led = PnlLedger();
      final s = led.recordSell(wallet: 'w', channel: 'c', asset: 'Y', sellQty: coins(1), proceedsUc: uc(10));
      expect(s.basisKnown, isFalse);
      expect(s.basisUc, BigInt.zero);
    });

    test('OVERSELL prorates proceeds to the HELD share; remainder is unknown-basis', () {
      // Honesty fix (§8): selling more than is tracked must NOT realize the full
      // proceeds against the held basis. Only the applied (held) share is counted;
      // the untracked remainder's proceeds are dropped.
      final led = PnlLedger();
      // hold 1 coin @ $100 (costUc 100_000_000)
      led.recordBuy(wallet: 'w', channel: 'c', asset: 'SOL', qty: coins(1), costUc: uc(100));
      // sell 2 coins for $300 total ($150/coin) — only 1 coin is held/tracked
      final s = led.recordSell(
        wallet: 'w',
        channel: 'c',
        asset: 'SOL',
        sellQty: coins(2),
        proceedsUc: uc(300),
      );
      // proceeds prorated to the applied 1-of-2 => $150 (NOT the full $300)
      expect(s.proceedsUc, uc(150));
      expect(s.basisUc, uc(100)); // all held basis removed
      expect(s.realizedUc, uc(50)); // +$50 on the tracked share, never +$200
      expect(s.realizedUsd, 50.00);
      expect(s.basisKnown, isTrue); // the applied share has a known basis
      final lot = led.lotOf('w', 'c', 'SOL')!;
      expect(lot.qty, BigInt.zero); // position drained; remainder dropped
      expect(lot.costUc, BigInt.zero);
    });

    test('persists alongside audit via onChange (no key material) + round-trips', () {
      Map<String, dynamic>? last;
      final led = PnlLedger(onChange: (j) => last = j);
      led.recordBuy(wallet: 'w', channel: 'c', asset: 'SOL', qty: coins(2), costUc: uc(200));
      expect(last, isNotNull);
      expect(last.toString().toLowerCase().contains('key'), isFalse);
      final led2 = PnlLedger(initial: last);
      final lot = led2.lotOf('w', 'c', 'SOL')!;
      expect(lot.qty, coins(2));
      expect(lot.costUc, uc(200));
    });
  });

  group('post-commit hook — pop-ups on positive stablecoin exits', () {
    test('CANONICAL pop-up: +\$45.00 fires once through dispatchValueMoving', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger();
      // seed the SOL position (two prior buys) exactly as the §8 vector
      led.recordBuy(wallet: 'default', channel: 'default', asset: 'SOL', qty: coins(2), costUc: uc(200));
      led.recordBuy(wallet: 'default', channel: 'default', asset: 'SOL', qty: coins(1), costUc: uc(160));

      final events = <Map<String, dynamic>>[];
      final hook = PnlHook(ledger: led, notifier: notifier);

      var committed = 0;
      final tools = ToolRegistry([
        _fakeSwap(
          from: 'SOL',
          to: 'USDC',
          amount: coins(1.5).toString(),
          amountOut: usdc(225).toString(),
          onCommit: () => committed++,
        ),
      ]);
      final policy = Policy.create(confirm: (_) async => true);

      final o = await dispatchValueMoving(
        tools: tools,
        policy: policy,
        name: 'swap',
        args: {},
        pnl: hook,
        emit: (e) {
          if (e['type'] == 'realized_profit') events.add(e);
        },
      );

      expect(o.declined, isFalse);
      expect(committed, 1);
      expect(notifier.sent, hasLength(1));
      // (exact "1.5 SOL" copy is asserted in notify_test with the asset decimals;
      // a generic swap summary carries no decimals, so here we assert the money)
      expect(notifier.sent.first.title, contains('+\$45.00'));
      expect(notifier.sent.first.title, contains('SOL → USDC'));
      expect(notifier.sent.first.subtitle, '\$180.00 basis → \$225.00 proceeds');
      expect(events, hasLength(1));
      expect(events.first['realizedUsd'], 45.00);
      expect(events.first['stable'], 'USDC');
      expect(events.first['asset'], 'SOL');

      // ledger reflects the partial sell
      final lot = led.lotOf('default', 'default', 'SOL')!;
      expect(lot.qty, coins(1.5));
      expect(lot.costUc, uc(180));
    });

    test('a realized LOSS updates the ledger silently (no pop-up)', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger();
      // bought high: 1 coin @ $300
      led.recordBuy(wallet: 'default', channel: 'default', asset: 'SOL', qty: coins(1), costUc: uc(300));
      final hook = PnlHook(ledger: led, notifier: notifier);

      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'USDC', amount: coins(1).toString(), amountOut: usdc(200).toString(), onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, isEmpty); // loss: silent
      // but the ledger closed the position
      expect(led.lotOf('default', 'default', 'SOL')!.qty, BigInt.zero);
    });

    test('unknown basis respects requireBasis (default true => skip)', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger(); // no prior SOL buys => unknown basis
      final hook = PnlHook(ledger: led, notifier: notifier);
      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'USDC', amount: coins(1).toString(), amountOut: usdc(200).toString(), onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, isEmpty); // skip rather than show misleading profit
    });

    test('requireBasis=false surfaces proceeds-only on unknown basis', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger();
      final hook = PnlHook(
        ledger: led,
        notifier: notifier,
        config: const PnlConfig(requireBasis: false),
      );
      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'USDC', amount: coins(1).toString(), amountOut: usdc(200).toString(), onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, hasLength(1));
      expect(notifier.sent.first.data['basisUnknown'], isTrue);
      expect(notifier.sent.first.data['realizedUsd'], isNull);
      expect(notifier.sent.first.data['proceedsUsd'], 200.0);
    });

    test('OVERSELL pops only the HONEST gain on the held share (+\$50.00)', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger();
      // hold 1 SOL @ $100; later sell 2 SOL for $300 total
      led.recordBuy(wallet: 'default', channel: 'default', asset: 'SOL', qty: coins(1), costUc: uc(100));
      final hook = PnlHook(ledger: led, notifier: notifier);
      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'USDC', amount: coins(2).toString(), amountOut: usdc(300).toString(), onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, hasLength(1));
      expect(notifier.sent.first.title, contains('+\$50.00')); // not +$200
      expect(notifier.sent.first.subtitle, '\$100.00 basis → \$150.00 proceeds');
    });

    test('requireBasis=false: a SUB-THRESHOLD proceeds-only exit does NOT pop', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger(); // unknown basis
      final hook = PnlHook(
        ledger: led,
        notifier: notifier,
        config: const PnlConfig(requireBasis: false),
      );
      // proceeds $0.005 < $0.01 default minNotifyUsd floor
      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'USDC', amount: coins(1).toString(), amountOut: usdc(0.005).toString(), onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, isEmpty); // floored out, no noise
    });

    test('NO pop-up when the output asset is not a stablecoin', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger();
      led.recordBuy(wallet: 'default', channel: 'default', asset: 'SOL', qty: coins(3), costUc: uc(100));
      final hook = PnlHook(ledger: led, notifier: notifier);
      // SOL -> ETH (both non-stable): no stablecoin exit, no pop-up
      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'ETH', amount: coins(1).toString(), amountOut: '5', onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, isEmpty);
    });

    test('tiny gains below minNotifyUsd do not pop', () async {
      final notifier = RecordingNotifier();
      final led = PnlLedger();
      led.recordBuy(wallet: 'default', channel: 'default', asset: 'SOL', qty: coins(1), costUc: uc(100));
      final hook = PnlHook(ledger: led, notifier: notifier);
      // proceeds $100.005 -> realized $0.005 < $0.01 default threshold
      final tools = ToolRegistry([
        _fakeSwap(from: 'SOL', to: 'USDC', amount: coins(1).toString(), amountOut: usdc(100.005).toString(), onCommit: () {}),
      ]);
      await dispatchValueMoving(
        tools: tools, policy: Policy.create(confirm: (_) async => true),
        name: 'swap', args: {}, pnl: hook,
      );
      expect(notifier.sent, isEmpty);
    });
  });

  group('stable base-unit -> microdollar conversion is exact', () {
    test('6-dp and 18-dp stables', () {
      const cfg = PnlConfig();
      expect(cfg.stableBaseToUc('USDC', usdc(225)), uc(225));
      // DAI 18 dp: 1 DAI = 1e18 base -> 1e6 microdollars
      expect(cfg.stableBaseToUc('DAI', BigInt.from(10).pow(18)), uc(1));
      expect(cfg.stableBaseToUc('SOL', coins(1)), isNull); // not a stable
    });
  });
}
