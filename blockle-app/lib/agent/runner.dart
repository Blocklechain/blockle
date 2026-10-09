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
  })  : system = system ?? defaultSystem,
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

    // ---- value-moving path: build -> cap -> confirm -> commit (+ fee) ----
    policy.assertLive();
    final PreparedAction prep = await tool.prepare!(args);
    emit({'type': 'prepared', 'name': name, 'summary': prep.summary});

    final feeValue = prep.feeValue;

    // hard cap pre-check — trade + mandatory fee must BOTH fit before anything moves.
    policy.assessValue(_withFee(prep.value, feeValue));
    await _rec({
      'type': 'cap_check',
      'name': name,
      'value': _valueMap(prep.value),
      'fee': prep.fee,
      'ok': true,
    });

    final gate = await policy.gateConfirm(prep.summary, {'usd': _confirmUsd(prep.value, feeValue)});
    await _rec({
      'type': 'confirmation',
      'name': name,
      'summary': prep.summary,
      'approved': gate.approved,
      'auto': gate.auto,
    });
    if (!gate.approved) {
      emit({'type': 'declined', 'name': name, 'summary': prep.summary});
      return _toolResult(
          call,
          {'rejected': true, 'reason': 'user declined confirmation', 'summary': prep.summary},
          false);
    }

    policy.assertLive(); // a kill during confirm must still block commit
    final res = await prep.commit();
    policy.recordSpend(prep.value);
    final txid = res is Map
        ? (res['txid'] ?? (res['settlement'] is Map ? res['settlement']['txid'] : null))
        : null;
    await _rec({
      'type': 'executed',
      'name': name,
      'valueMoving': true,
      'result': res,
      'txid': txid,
    });
    emit({
      'type': 'executed',
      'name': name,
      'result': res,
      'txid': txid,
      'summary': prep.summary,
      'value': _valueMap(prep.value),
      'fee': prep.fee,
    });

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
      if (feeValue != null) policy.recordSpend(feeValue);
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
      await _rec(agentFee);
      emit({'type': 'fee', 'name': name, 'fee': agentFee, 'txid': feeTxid});
    }

    // Return a MERGED copy so the model sees the fee without mutating `res`.
    final out = (agentFee != null && res is Map)
        ? {...res, 'agentFee': agentFee}
        : res;
    return _toolResult(call, out, false);
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
