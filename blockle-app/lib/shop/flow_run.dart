// A flow in progress, and the fact that it outlives the screen.
//
// WHY THIS IS PERSISTED, which is the whole reason the file exists.
//
// "Pay with BLOCK" contains a MoonPay bank payout, so it takes one to three
// BUSINESS DAYS. If the state of that flow lives in a widget, then closing the
// app halfway through loses the user's place in a multi-day movement of their
// own money: they come back to a wallet holding USDC with no record of why it
// is there, whether the payout was started, or what they were buying. That is
// not a cosmetic bug — it is the app forgetting a financial commitment the
// user made. So a run is written to storage the moment it starts and after
// every step.
//
// WHY IT IS A CHECKLIST AND NOT A ONE-TAP BUTTON.
//
// Three of the four leg types CANNOT be automated, and pretending otherwise
// would be the dishonest version of this screen:
//
//   - MoonPay buy and sell are hosted widgets. MoonPay is the merchant of
//     record and runs the KYC; the user completes them in a webview, and we
//     cannot and must not drive that form.
//   - The retail purchase is the USER'S. Blockle is non-custodial and never
//     holds their funds, so it cannot pay a shop on their behalf. The last
//     leg is them checking out, with their money, in their browser.
//
// Only the treasury swap is ours to execute. So this type drives the user to
// the right place for each leg, remembers where they got to, and is explicit
// that confirming a leg means "I did this", not "the app did this".
//
// NOTHING HERE MOVES MONEY. Marking a leg done records what the user says
// happened. The actual execution lives in the existing Liquidity and MoonPay
// screens, which already carry the security gate and the signing path — this
// deliberately does not grow a second one.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'flow.dart';

enum LegState {
  /// Not reachable yet — an earlier leg is unfinished.
  waiting,

  /// The step the user should do now.
  active,

  /// The user has confirmed they completed it.
  done,

  /// Started, but the user said it did not work.
  failed,
}

/// Where a leg sends the user. The UI maps this to a destination; keeping it
/// an enum rather than a callback is what lets a run be written to disk and
/// resumed in a later app session.
enum LegAction {
  /// MoonPay's hosted buy widget.
  moonpayBuy,

  /// MoonPay's hosted sell/payout widget.
  moonpaySell,

  /// The in-app Liquidity swap, which Blockle executes.
  treasurySwap,

  /// The merchant's own checkout, in the browser.
  retailCheckout,
}

LegAction _actionFor(Leg leg) => switch (leg) {
      MoonPayBuyLeg() => LegAction.moonpayBuy,
      MoonPaySellLeg() => LegAction.moonpaySell,
      TreasurySwapLeg() => LegAction.treasurySwap,
      RetailPurchaseLeg() => LegAction.retailCheckout,
      // A new leg type must choose a destination deliberately. Defaulting it
      // to "checkout" would silently send someone to the wrong place with
      // their money, so this throws at construction instead.
      _ => throw ArgumentError('no destination for ${leg.runtimeType}'),
    };

/// The few values a destination needs, captured as strings so a run survives
/// serialisation.
///
/// These are SNAPSHOTTED at start rather than recomputed on resume. A user who
/// returns two days later must be sent to a payout for the amount they
/// actually swapped, not for whatever the current rate would imply — the
/// numbers in the checklist and the numbers in their wallet have to agree.
Map<String, String> _paramsFor(Leg leg) => switch (leg) {
      MoonPayBuyLeg l => {'coin': l.coin, 'usd': l.usd.toString()},
      MoonPaySellLeg l => {'coin': l.coin, 'amount': l.amount.toString()},
      TreasurySwapLeg l => {
          'from': l.from,
          'to': l.to,
          'amountIn': l.amountIn.toString(),
        },
      RetailPurchaseLeg l => {
          'merchant': l.merchant,
          'usd': l.usd.toString(),
        },
      _ => const {},
    };

/// One step of a run, as stored.
class RunStep {
  RunStep({
    required this.name,
    required this.describe,
    required this.action,
    this.params = const {},
    this.state = LegState.waiting,
    this.note,
    this.at,
  });

  final String name;
  final String describe;
  final LegAction action;

  /// What the destination needs (coin, amount, pair), snapshotted at start.
  final Map<String, String> params;
  LegState state;

  /// What the user told us when a step failed, kept so support and the user
  /// can see why a run stalled.
  String? note;
  DateTime? at;

  Map<String, dynamic> toJson() => {
        'name': name,
        'describe': describe,
        'action': action.name,
        'params': params,
        'state': state.name,
        if (note != null) 'note': note,
        if (at != null) 'at': at!.toIso8601String(),
      };

  static RunStep fromJson(Map<String, dynamic> j) => RunStep(
        name: '${j['name'] ?? ''}',
        describe: '${j['describe'] ?? ''}',
        action: LegAction.values.firstWhere((a) => a.name == j['action'],
            orElse: () => LegAction.retailCheckout),
        params: ((j['params'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k', '$v')),
        state: LegState.values.firstWhere((s) => s.name == j['state'],
            orElse: () => LegState.waiting),
        note: j['note'] as String?,
        at: j['at'] is String ? DateTime.tryParse(j['at']) : null,
      );
}

/// A started flow.
class FlowRun {
  FlowRun({
    required this.id,
    required this.title,
    required this.steps,
    required this.startedAt,
    this.usd,
    this.merchant,
    this.checkoutUrl,
    this.abandonedAt,
  });

  final String id;
  final String title;
  final List<RunStep> steps;
  final DateTime startedAt;

  /// What this run is for, kept so a user returning days later knows why
  /// there is a half-finished money movement in their app.
  final double? usd;
  final String? merchant;

  /// Where the final leg sends the user to check out with their own money.
  final String? checkoutUrl;

  DateTime? abandonedAt;

  factory FlowRun.from(FlowPlan plan,
      {required String id,
      double? usd,
      String? merchant,
      String? checkoutUrl,
      DateTime? now}) {
    final steps = [
      for (final l in plan.legs)
        RunStep(
            name: l.name,
            describe: l.describe,
            action: _actionFor(l),
            params: _paramsFor(l)),
    ];
    if (steps.isNotEmpty) steps.first.state = LegState.active;
    return FlowRun(
      id: id,
      title: plan.title,
      steps: steps,
      startedAt: now ?? DateTime.now().toUtc(),
      usd: usd,
      merchant: merchant,
      checkoutUrl: checkoutUrl,
    );
  }

  bool get complete => steps.every((s) => s.state == LegState.done);
  bool get abandoned => abandonedAt != null;
  bool get stalled => steps.any((s) => s.state == LegState.failed);

  /// The step the user should do now, or null when there is nothing to do.
  RunStep? get current {
    for (final s in steps) {
      if (s.state == LegState.active || s.state == LegState.failed) return s;
    }
    return null;
  }

  int get doneCount => steps.where((s) => s.state == LegState.done).length;

  /// Mark the active step done and open the next one.
  ///
  /// Only the ACTIVE step can be completed. Letting the UI complete an
  /// arbitrary index would allow a mis-tap to mark a bank payout done that
  /// never happened, and the user would wait days for money that was never
  /// sent.
  void completeCurrent({DateTime? now}) {
    final i = steps.indexWhere(
        (s) => s.state == LegState.active || s.state == LegState.failed);
    if (i < 0) return;
    steps[i]
      ..state = LegState.done
      ..note = null
      ..at = now ?? DateTime.now().toUtc();
    if (i + 1 < steps.length) steps[i + 1].state = LegState.active;
  }

  void failCurrent(String why, {DateTime? now}) {
    final i = steps.indexWhere(
        (s) => s.state == LegState.active || s.state == LegState.failed);
    if (i < 0) return;
    steps[i]
      ..state = LegState.failed
      ..note = why
      ..at = now ?? DateTime.now().toUtc();
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'startedAt': startedAt.toIso8601String(),
        if (usd != null) 'usd': usd,
        if (merchant != null) 'merchant': merchant,
        if (checkoutUrl != null) 'checkoutUrl': checkoutUrl,
        if (abandonedAt != null) 'abandonedAt': abandonedAt!.toIso8601String(),
        'steps': steps.map((s) => s.toJson()).toList(),
      };

  static FlowRun fromJson(Map<String, dynamic> j) => FlowRun(
        id: '${j['id'] ?? ''}',
        title: '${j['title'] ?? ''}',
        startedAt:
            DateTime.tryParse('${j['startedAt']}') ?? DateTime.now().toUtc(),
        usd: (j['usd'] as num?)?.toDouble(),
        merchant: j['merchant'] as String?,
        checkoutUrl: j['checkoutUrl'] as String?,
        abandonedAt: j['abandonedAt'] is String
            ? DateTime.tryParse(j['abandonedAt'])
            : null,
        steps: ((j['steps'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(RunStep.fromJson)
            .toList(),
      );
}

/// Every run the user has started, across app launches.
class FlowRuns extends ChangeNotifier {
  FlowRuns({FlutterSecureStorage? store})
      : _store = store ?? const FlutterSecureStorage();

  static const _key = 'blockle_flow_runs_v1';
  final FlutterSecureStorage _store;

  final List<FlowRun> runs = [];

  /// Runs that still need something from the user. This is what the shop
  /// surfaces on open — an unfinished money movement must be visible without
  /// the user going looking for it.
  List<FlowRun> get open => runs
      .where((r) => !r.complete && !r.abandoned)
      .toList()
    ..sort((a, b) => b.startedAt.compareTo(a.startedAt));

  Future<void> load() async {
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final list = jsonDecode(raw);
      if (list is! List) return;
      runs
        ..clear()
        ..addAll(list.whereType<Map<String, dynamic>>().map(FlowRun.fromJson));
      notifyListeners();
    } catch (_) {
      // Unreadable history must not stop the user starting a new flow.
    }
  }

  Future<void> _persist() async {
    try {
      await _store.write(
          key: _key, value: jsonEncode(runs.map((r) => r.toJson()).toList()));
    } catch (_) {}
  }

  Future<FlowRun> start(FlowPlan plan,
      {required String id,
      double? usd,
      String? merchant,
      String? checkoutUrl}) async {
    // A plan that is not ready must never become a run. The blockers were
    // computed precisely so nothing starts that cannot finish, and starting
    // anyway would strand the user mid-flow holding the wrong asset.
    if (!plan.ready) {
      throw StateError('cannot start a blocked flow: ${plan.firstBlocker}');
    }
    final run = FlowRun.from(plan,
        id: id, usd: usd, merchant: merchant, checkoutUrl: checkoutUrl);
    runs.add(run);
    await _persist();
    notifyListeners();
    return run;
  }

  Future<void> advance(FlowRun run) async {
    run.completeCurrent();
    await _persist();
    notifyListeners();
  }

  Future<void> fail(FlowRun run, String why) async {
    run.failCurrent(why);
    await _persist();
    notifyListeners();
  }

  /// Give up on a run. Kept rather than deleted — a user who started a bank
  /// payout and then abandoned the flow still needs the record of it, because
  /// the money moved whether or not they finished the checklist.
  Future<void> abandon(FlowRun run) async {
    run.abandonedAt = DateTime.now().toUtc();
    await _persist();
    notifyListeners();
  }
}
