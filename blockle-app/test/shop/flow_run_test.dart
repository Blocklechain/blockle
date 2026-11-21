// A run must survive the app being closed, and must not advance by accident.
//
// Both failures here are expensive in the same way: they concern money that
// has already moved. A run lost on restart leaves the user holding USDC with
// no record of why. A step marked done that was never done leaves them
// waiting days for a payout nobody started.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:blockle_app/liquidity/liquidity_pool.dart';
import 'package:blockle_app/shop/flow.dart';
import 'package:blockle_app/shop/flow_run.dart';

SwapQuote good(String a, String b, double i, double o) => SwapQuote(
    ok: true,
    amountIn: i,
    amountOut: o,
    assetIn: a,
    assetOut: b,
    blockPriceUsd: 0.001);

FlowPlan payPlan() => MoneyFlow.payWithBlock(
      usd: 299,
      merchant: 'Example Store',
      blockToCoin: good('BLOCK', 'USDC', 299000, 299),
      coinReserve: 100000,
      onchainSettlement: true,
      sellEnabled: true,
      sellable: const {'USDC', 'ETH', 'BTC'},
      bankConnected: true,
    );

FlowPlan getPlan() => MoneyFlow.getBlock(
      usd: 50,
      solToBlock: good('SOL', 'BLOCK', 0.25, 40000),
      blockReserve: 1000000,
      onchainSettlement: true,
      buyEnabled: true,
      buyable: const {'SOL', 'USDC', 'ETH', 'BTC'},
    );

/// Storage that actually keeps bytes, so "close the app and come back" can be
/// tested rather than assumed.
class FakeStore extends FlutterSecureStorage {
  FakeStore([this.data = const {}]) : super();
  Map<String, String> data;

  @override
  Future<String?> read({required String key, iOptions, aOptions, lOptions,
          webOptions, mOptions, wOptions}) async =>
      data[key];

  @override
  Future<void> write({required String key, required String? value, iOptions,
      aOptions, lOptions, webOptions, mOptions, wOptions}) async {
    data = {...data, if (value != null) key: value};
  }
}

void main() {
  group('starting', () {
    test('a plan becomes a checklist with only the first step open', () {
      final r = FlowRun.from(payPlan(), id: 'x');
      expect(r.steps.first.state, LegState.active);
      expect(r.steps.skip(1).every((s) => s.state == LegState.waiting), isTrue);
      expect(r.complete, isFalse);
    });

    test('a BLOCKED plan can never become a run', () async {
      // The blockers exist precisely so nothing starts that cannot finish.
      // Starting anyway strands the user mid-flow holding the wrong asset.
      final blocked = MoneyFlow.payWithBlock(
        usd: 299,
        merchant: 'Example Store',
        blockToCoin: good('BLOCK', 'USDC', 299000, 299),
        coinReserve: 100000,
        onchainSettlement: true,
        sellEnabled: true,
        sellable: const {'USDC'},
        bankConnected: false, // no payout account
      );
      expect(blocked.ready, isFalse);
      final runs = FlowRuns(store: FakeStore());
      await expectLater(
          runs.start(blocked, id: 'x'), throwsA(isA<StateError>()));
      expect(runs.runs, isEmpty);
    });

    test('each leg records where it sends the user', () {
      final r = FlowRun.from(payPlan(), id: 'x');
      expect(r.steps.map((s) => s.action), [
        LegAction.treasurySwap,
        LegAction.moonpaySell,
        LegAction.retailCheckout,
      ]);
    });

    test('leg parameters are snapshotted, not recomputed later', () {
      // A user returning two days later must be sent to a payout for the
      // amount they actually swapped, not for today's rate.
      final r = FlowRun.from(getPlan(), id: 'x');
      final buy = r.steps.firstWhere((s) => s.action == LegAction.moonpayBuy);
      expect(buy.params['coin'], 'SOL');
      expect(buy.params['usd'], '50.0');
    });
  });

  group('advancing', () {
    test('only the active step can be completed', () {
      final r = FlowRun.from(payPlan(), id: 'x');
      r.completeCurrent();
      expect(r.steps[0].state, LegState.done);
      expect(r.steps[1].state, LegState.active);
      expect(r.steps[2].state, LegState.waiting);
    });

    test('completing every step finishes the run', () {
      final r = FlowRun.from(payPlan(), id: 'x');
      for (var i = 0; i < r.steps.length; i++) {
        r.completeCurrent();
      }
      expect(r.complete, isTrue);
      expect(r.current, isNull);
    });

    test('completing past the end does nothing rather than throwing', () {
      final r = FlowRun.from(getPlan(), id: 'x');
      for (var i = 0; i < 10; i++) {
        r.completeCurrent();
      }
      expect(r.doneCount, r.steps.length);
    });

    test('a failed step stays current and keeps its reason', () {
      // It must NOT silently advance — the next leg assumes this one's
      // output exists.
      final r = FlowRun.from(payPlan(), id: 'x');
      r.failCurrent('Swap was rejected');
      expect(r.current, r.steps.first);
      expect(r.steps[1].state, LegState.waiting);
      expect(r.stalled, isTrue);
      expect(r.steps.first.note, 'Swap was rejected');
    });

    test('a failed step can be retried and then completed', () {
      final r = FlowRun.from(payPlan(), id: 'x');
      r.failCurrent('card declined');
      r.completeCurrent();
      expect(r.steps.first.state, LegState.done);
      // The stale failure note is cleared, so the UI cannot show a red
      // reason on a step that eventually worked.
      expect(r.steps.first.note, isNull);
      expect(r.stalled, isFalse);
    });
  });

  group('surviving a restart', () {
    test('a half-finished run is still there in the next app session',
        () async {
      final store = FakeStore();
      final first = FlowRuns(store: store);
      final run = await first.start(payPlan(),
          id: 'run1', usd: 299, merchant: 'Example Store');
      await first.advance(run); // swap done, payout pending for days

      // A whole new object graph, as after a cold start.
      final second = FlowRuns(store: store);
      await second.load();

      expect(second.runs, hasLength(1));
      final back = second.runs.single;
      expect(back.id, 'run1');
      expect(back.merchant, 'Example Store');
      expect(back.usd, 299);
      expect(back.doneCount, 1);
      expect(back.current!.action, LegAction.moonpaySell);
      // And the amount it will send them to cash out survived too.
      expect(back.current!.params['coin'], 'USDC');
    });

    test('a failure reason survives too', () async {
      final store = FakeStore();
      final a = FlowRuns(store: store);
      final run = await a.start(getPlan(), id: 'r');
      await a.fail(run, 'MoonPay declined the card');

      final b = FlowRuns(store: store);
      await b.load();
      expect(b.runs.single.current!.note, 'MoonPay declined the card');
      expect(b.runs.single.stalled, isTrue);
    });

    test('unreadable storage does not stop a new flow being started',
        () async {
      final runs = FlowRuns(store: FakeStore({'blockle_flow_runs_v1': '{{{'}));
      await runs.load();
      expect(runs.runs, isEmpty);
      await runs.start(getPlan(), id: 'new');
      expect(runs.runs, hasLength(1));
    });

    test('a corrupt run does not take the others with it', () async {
      final storedGood = FlowRun.from(getPlan(), id: 'ok').toJson();
      final store = FakeStore({
        'blockle_flow_runs_v1': jsonEncode([storedGood, 'not an object', 42]),
      });
      final runs = FlowRuns(store: store);
      await runs.load();
      expect(runs.runs.map((r) => r.id), ['ok']);
    });
  });

  group('confirming a step from MoonPay, not from the user', () {
    // The ramp screen polls the status the VERIFIED webhook recorded
    // server-side, so the app already knows. Both wrong answers here are
    // expensive: advancing on an unconfirmed payout leaves someone waiting
    // days for money nobody sent; holding on a confirmed one makes them
    // repeat a transaction they already did.
    test('a completed transaction advances the step', () {
      expect(outcomeForMoonPayStatus('completed'), LegOutcome.advance);
      expect(outcomeForMoonPayStatus('COMPLETED'), LegOutcome.advance);
    });

    test('a failure fails it', () {
      expect(outcomeForMoonPayStatus('failed'), LegOutcome.fail);
      expect(outcomeForMoonPayStatus('cancelled'), LegOutcome.fail);
    });

    test('LEAVING EARLY HOLDS — it is the normal case, not an outcome', () {
      // A bank payout can confirm days after the user closes the sheet.
      expect(outcomeForMoonPayStatus(null), LegOutcome.hold);
      expect(outcomeForMoonPayStatus(''), LegOutcome.hold);
      expect(outcomeForMoonPayStatus('pending'), LegOutcome.hold);
      expect(outcomeForMoonPayStatus('waitingPayment'), LegOutcome.hold);
    });

    test('an unrecognised status holds rather than guessing', () {
      // MoonPay can add states. A new one must not be read as success.
      expect(outcomeForMoonPayStatus('someNewState'), LegOutcome.hold);
    });

    test('a held step is left completely untouched', () async {
      final runs = FlowRuns(store: FakeStore());
      final run = await runs.start(getPlan(), id: 'r');
      final before = run.current!.state;
      expect(outcomeForMoonPayStatus('pending'), LegOutcome.hold);
      expect(run.current!.state, before);
      expect(run.doneCount, 0);
    });
  });

  group('open runs', () {
    test('a finished run drops off the shop screen', () async {
      final runs = FlowRuns(store: FakeStore());
      final run = await runs.start(getPlan(), id: 'r');
      expect(runs.open, hasLength(1));
      for (var i = 0; i < run.steps.length; i++) {
        await runs.advance(run);
      }
      expect(runs.open, isEmpty);
    });

    test('abandoning hides it but keeps the record', () async {
      // Money that moved has moved; deleting the record would hide a real
      // financial event from the user.
      final runs = FlowRuns(store: FakeStore());
      final run = await runs.start(getPlan(), id: 'r');
      await runs.advance(run);
      await runs.abandon(run);
      expect(runs.open, isEmpty);
      expect(runs.runs, hasLength(1));
      expect(runs.runs.single.doneCount, 1);
    });

    test('the newest open run is listed first', () async {
      final runs = FlowRuns(store: FakeStore());
      await runs.start(getPlan(), id: 'old');
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await runs.start(getPlan(), id: 'new');
      expect(runs.open.first.id, 'new');
    });
  });
}
