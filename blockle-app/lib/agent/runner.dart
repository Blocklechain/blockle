// agent/runner.dart — the natural-language loop (Dart port of
// blockle-extension/agent/runner.js). Turns a user instruction into allowlisted
// wallet/exchange/SDK actions, with the safety rails enforced AROUND every tool
// call (not inside the tools, and not by the model's discretion):
//
//   prompt -> provider.turn(system, history, allowlisted schemas)
//     text      -> emit to the user
//     toolCall  -> policy.checkAllowed            (allowlist)
//                  if valueMoving:
//                     tool.prepare()              (build + sign, no broadcast)
//                     policy.assessValue()        (hard cap check)
//                     policy.gateConfirm(summary) (default-on human confirm)
//                     tool.commit()               (broadcast / execute)
//                     policy.recordSpend()
//                  audit.record() around each step
//                  feed tool_result back to provider.turn
//   repeat until the model returns a final text answer, maxTurns is hit, or the
//   user hits the kill switch.

import 'dart:convert';

import 'pnl.dart' show PnlHook, TradeFill;
import 'policy.dart';
import 'providers.dart' show LlmProvider;
import 'tools.dart' show ToolRegistry, PreparedAction;

const String defaultSystem =
    'You are the in-wallet assistant for a Blockle multi-chain wallet. You can '
    'call only the tools provided. Value-moving actions (sends, swaps, orders, '
    'buys, token launches, liquidity, listings) are gated by the host: each is '
    'subject to a per-session spending cap and requires explicit human '
    'confirmation that the host enforces — not you. Do not claim an action '
    'succeeded until the tool returns a result. Never ask the user for their '
    'password, seed phrase, private keys, or API credentials; you do not need '
    'them and must refuse if asked to reveal or transmit them.';

String _jstr(dynamic v) => jsonEncode(v, toEncodable: (o) {
      if (o is BigInt) return o.toString();
      return '$o';
    });

/// The result of a single `run()`.
class RunResult {
  final String? text;
  final bool stopped;
  final String reason;
  const RunResult({this.text, required this.stopped, required this.reason});
}

class Runner {
  final LlmProvider provider;
  final ToolRegistry tools;
  final Policy policy;
  final dynamic audit; // Audit?
  final String system;
  final int maxTurns;
  final void Function(Map<String, dynamic> ev)? onEvent;

  /// The ONE realized-profit post-commit hook (AGENT-STRATEGIES.md section 8).
  /// Optional — null leaves behaviour unchanged.
  final PnlHook? pnl;
  final String pnlWallet;
  final String pnlChannel;

  final List<Map<String, dynamic>> messages = [];
  bool _aborted = false;

  Runner({
    required this.provider,
    required this.tools,
    required this.policy,
    this.audit,
    String? system,
    int? maxTurns,
    List<String>? allowlist,
    this.onEvent,
    this.pnl,
    String? pnlWallet,
    String? pnlChannel,
  })  : system = system ?? defaultSystem,
        pnlWallet = pnlWallet ?? 'default',
        pnlChannel = pnlChannel ?? 'default',
        maxTurns = maxTurns ?? 12 {
    // Enforce the allowlist from the catalog unless the host narrowed it.
    policy.setAllowlist(allowlist ?? tools.names());
  }

  void emit(Map<String, dynamic> ev) {
    if (onEvent != null) {
      try {
        onEvent!(ev);
      } catch (_) {}
    }
  }

  /// Kill switch: abort the loop + revoke session + lock the vault.
  Future<void> kill([String? reason]) async {
    _aborted = true;
    await policy.kill(reason ?? 'kill switch');
    emit({'type': 'killed', 'reason': reason ?? 'kill switch'});
  }

  Map<String, dynamic> _toolResult(Map<String, dynamic> call, dynamic obj, bool isError) {
    return {
      'id': call['id'],
      'name': call['name'],
      'content': _jstr(obj),
      'isError': isError,
    };
  }

  Future<void> _rec(Map<String, dynamic> data) async {
    if (audit != null) await audit.record(data);
  }

  Future<Map<String, dynamic>> _execute(Map<String, dynamic> call) async {
    final name = call['name'] as String;
    await _rec({'type': 'tool_call', 'name': name, 'args': call['arguments']});
    emit({'type': 'tool_call', 'name': name, 'args': call['arguments']});

    policy.checkAllowed(name); // throws ToolNotAllowed (recoverable)
    final tool = tools.get(name);
    if (tool == null) throw StateError('unknown tool: $name');

    final args = (call['arguments'] as Map?)?.cast<String, dynamic>() ?? {};

    if (!tool.valueMoving) {
      final res = await tool.run!(args);
      await _rec({'type': 'executed', 'name': name, 'valueMoving': false});
      return _toolResult(call, res, false);
    }

    // ---- value-moving path: the ONE shared commit routine ----
    // prepare -> cap -> confirm -> commit (+ fee) -> recordSpend. The SAME
    // routine the StrategyRunner dispatches through, so there is exactly one
    // broadcast path and strategies cannot bypass caps/confirm/kill/fee.
    policy.assertLive();
    final DispatchOutcome o = await dispatchValueMoving(
      tools: tools,
      policy: policy,
      name: name,
      args: args,
      audit: audit,
      emit: emit,
      pnl: pnl,
      pnlWallet: pnlWallet,
      pnlChannel: pnlChannel,
    );
    if (o.declined) {
      return _toolResult(
          call,
          {'rejected': true, 'reason': 'user declined confirmation', 'summary': o.summary},
          false);
    }
    return _toolResult(call, o.result, false);
  }

  /// Run one user instruction to completion.
  Future<RunResult> run(String prompt, {bool Function()? aborted}) async {
    await _rec({'type': 'prompt', 'text': prompt});
    emit({'type': 'prompt', 'text': prompt});
    messages.add({'role': 'user', 'text': prompt});

    String? lastText;
    try {
      for (var turn = 0; turn < maxTurns; turn++) {
        policy.assertLive();
        if (_aborted || (aborted != null && aborted())) {
          return RunResult(text: lastText, stopped: true, reason: 'aborted');
        }

        final resp = await provider.turn(
          system: system,
          messages: messages,
          tools: tools.schemas(),
        );

        final respText = resp['text'] as String?;
        lastText = respText ?? lastText;
        if (respText != null) {
          await _rec({'type': 'assistant_text', 'text': respText});
          emit({'type': 'text', 'text': respText});
        }

        final calls = (resp['toolCalls'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
        if (calls.isEmpty) {
          messages.add({'role': 'assistant', 'text': respText});
          return RunResult(text: respText, stopped: false, reason: 'end_turn');
        }

        messages.add({'role': 'assistant', 'text': respText, 'toolCalls': calls});

        final results = <Map<String, dynamic>>[];
        for (final call in calls) {
          policy.assertLive(); // halts mid-batch if the user hit kill
          try {
            results.add(await _execute(call));
          } catch (e) {
            if (e is AgentHalted) rethrow; // propagate kill to stop the loop
            await _rec({'type': 'error', 'name': call['name'], 'error': '$e'});
            emit({'type': 'tool_error', 'name': call['name'], 'error': '$e'});
            results.add(_toolResult(call, {'error': '$e'}, true));
          }
        }
        messages.add({'role': 'tool', 'results': results});
      }
      return RunResult(text: lastText, stopped: true, reason: 'max_turns');
    } on AgentHalted {
      await _rec({'type': 'halted'});
      return RunResult(text: lastText, stopped: true, reason: 'killed');
    }
  }

  void reset() => messages.clear();
}

/// The outcome of a single run through the shared value-moving dispatch routine.
class DispatchOutcome {
  /// The confirmation gate denied the action (nothing moved).
  final bool declined;

  /// The committed result, MERGED with the agent-fee record for the model.
  final dynamic result;

  /// The raw commit() result, unmerged.
  final dynamic rawResult;

  /// The broadcast txid (may be null / non-string depending on the tool).
  final dynamic txid;

  /// The recorded agent-fee leg, or null when the tool carried no fee.
  final Map<String, dynamic>? agentFee;

  /// The accounting descriptor that was cap-checked + recorded.
  final SpendValue value;

  /// The human-readable summary shown in the confirm + audit.
  final Map<String, dynamic> summary;

  const DispatchOutcome({
    this.declined = false,
    this.result,
    this.rawResult,
    this.txid,
    this.agentFee,
    required this.value,
    required this.summary,
  });
}

/// The ONE value-moving commit path, shared by the NL [Runner] and the
/// [StrategyRunner]. Enforces, in order:
///   prepare() -> policy.assessValue (hard caps, trade+fee together)
///             -> policy.gateConfirm (default-on human confirm)
///             -> commit()           (broadcast)
///             -> recordSpend        (only after a successful broadcast)
///             -> mandatory 0.05% fee leg (recorded only if IT broadcast)
/// Throws [CapExceeded] over a cap and [AgentHalted] on kill; both must escape
/// so the caller can surface/stop. Returns `declined` when the gate denies.
Future<DispatchOutcome> dispatchValueMoving({
  required ToolRegistry tools,
  required Policy policy,
  required String name,
  required Map<String, dynamic> args,
  dynamic audit,
  void Function(Map<String, dynamic> ev)? emit,
  PnlHook? pnl,
  String pnlWallet = 'default',
  String pnlChannel = 'default',
}) async {
  Future<void> rec(Map<String, dynamic> d) async {
    if (audit != null) await audit.record(d);
  }

  void ev(Map<String, dynamic> e) {
    if (emit != null) {
      try {
        emit(e);
      } catch (_) {}
    }
  }

  final tool = tools.get(name);
  if (tool == null) throw StateError('unknown tool: $name');
  if (!tool.valueMoving || tool.prepare == null) {
    throw StateError('not a value-moving tool: $name');
  }

  policy.assertLive();
  final PreparedAction prep = await tool.prepare!(args);
  ev({'type': 'prepared', 'name': name, 'summary': prep.summary});

  final feeValue = prep.feeValue;

  // hard cap pre-check — trade + mandatory fee must BOTH fit before anything moves.
  policy.assessValue(_withFee(prep.value, feeValue));
  await rec({
    'type': 'cap_check',
    'name': name,
    'value': _valueMap(prep.value),
    'fee': prep.fee,
    'ok': true,
  });

  final gate = await policy.gateConfirm(prep.summary, {'usd': _confirmUsd(prep.value, feeValue)});
  await rec({
    'type': 'confirmation',
    'name': name,
    'summary': prep.summary,
    'approved': gate.approved,
    'auto': gate.auto,
  });
  if (!gate.approved) {
    ev({'type': 'declined', 'name': name, 'summary': prep.summary});
    return DispatchOutcome(declined: true, value: prep.value, summary: prep.summary);
  }

  policy.assertLive(); // a kill during confirm must still block commit
  final res = await prep.commit();
  policy.recordSpend(prep.value);
  final txid = res is Map
      ? (res['txid'] ?? (res['settlement'] is Map ? res['settlement']['txid'] : null))
      : null;
  await rec({
    'type': 'executed',
    'name': name,
    'valueMoving': true,
    'result': res,
    'txid': txid,
  });
  ev({
    'type': 'executed',
    'name': name,
    'result': res,
    'txid': txid,
    'summary': prep.summary,
    'value': _valueMap(prep.value),
    'fee': prep.fee,
  });

  // ---- realized-profit ledger + pop-up: the ONE post-commit hook (§8) ----
  // Updates the avg-cost ledger on EVERY committed buy/sell and pops a pop-up on
  // a positive stablecoin exit. Fail-soft: PnL accounting must never break or
  // unwind a trade that already broadcast.
  if (pnl != null) {
    try {
      final fill = TradeFill.fromCommit(
        name: name,
        summary: prep.summary,
        result: res,
        config: pnl.config,
        wallet: pnlWallet,
        channel: pnlChannel,
        inUsd: prep.value.usd,
        txid: txid is String ? txid : (txid == null ? null : '$txid'),
      );
      if (fill != null) {
        final event = await pnl.onCommit(fill);
        if (event != null) ev({'type': 'realized_profit', ...event});
      }
    } catch (_) {}
  }

  // ---- mandatory fee leg: a second treasury send in the SAME action ----
  Map<String, dynamic>? agentFee;
  if (prep.commitFee != null && prep.fee != null) {
    policy.assertLive();
    dynamic feeRes;
    Object? feeErr;
    try {
      feeRes = await prep.commitFee!();
    } catch (e) {
      feeErr = e;
    }
    final feeTxid = feeRes is Map ? feeRes['txid'] : null;
    // Only accrue the fee against caps when it ACTUALLY broadcast, mirroring how
    // the main leg records spend only after a successful commit.
    if (feeErr == null && feeValue != null) policy.recordSpend(feeValue);
    agentFee = {
      'type': 'fee',
      'name': name,
      'bps': prep.fee!['bps'],
      'chain': prep.fee!['chain'],
      'asset': prep.fee!['asset'],
      'amount': prep.fee!['amount'],
      'treasury': prep.fee!['treasury'],
      'txid': feeTxid,
    };
    if (feeErr != null) agentFee['error'] = '$feeErr';
    await rec(agentFee);
    ev({'type': 'fee', 'name': name, 'fee': agentFee, 'txid': feeTxid});
  }

  // Return a MERGED copy so the model sees the fee without mutating `res`.
  final out = (agentFee != null && res is Map) ? {...res, 'agentFee': agentFee} : res;
  return DispatchOutcome(
    result: out,
    rawResult: res,
    txid: txid,
    agentFee: agentFee,
    value: prep.value,
    summary: prep.summary,
  );
}

SpendValue _withFee(SpendValue value, SpendValue? feeValue) {
  if (feeValue == null) return value;
  dynamic amount = value.amount;
  final sameAsset =
      feeValue.asset != null && value.asset != null && feeValue.asset == value.asset;
  if (sameAsset && value.amount != null && feeValue.amount != null) {
    try {
      amount = (BigInt.parse('${value.amount}') + BigInt.parse('${feeValue.amount}')).toString();
    } catch (_) {}
  }
  num? usd = value.usd;
  if (value.usd != null || feeValue.usd != null) {
    usd = (value.usd ?? 0) + (feeValue.usd ?? 0);
  }
  return SpendValue(asset: value.asset, amount: amount, usd: usd);
}

num? _confirmUsd(SpendValue value, SpendValue? feeValue) {
  final a = value.usd;
  final b = feeValue?.usd;
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

Map<String, dynamic> _valueMap(SpendValue v) =>
    {'asset': v.asset, 'amount': v.amount == null ? null : '${v.amount}', 'usd': v.usd};
