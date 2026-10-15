// agent/command.dart — the NATURAL-LANGUAGE COMMAND BAR router (Dart port of
// blockle-extension/agent/command.js).
//
// It adds NO new power. The agent (the SAME provider.turn — hosted or BYO) only
// PROPOSES tool-calls over the EXISTING tool registry (buildTools(ctx)), and the
// EXISTING gate (policy + runner.dispatchValueMoving) enforces every fund move.
// There is NO second broadcast path and NO relaxed confirm path here.
//
// Given typed text + wallet context it routes into one of two intents:
//
//   (A) ACTION  ("send 0.1 ETH to alice.eth", "swap 100 USDC to SOL",
//               "rebalance to 60/40 stables" = a SEQUENCE of swaps)
//       For EACH proposed value-moving tool-call the router:
//         1. RESOLVES any name (WalletAddressBook.resolveName) and shows the
//            RESOLVED address — the resolved address is what is then inspected,
//            confirmed, and sent (never the raw typed name).
//         2. dispatches through dispatchValueMoving — the ONE gate:
//            prepare -> assessValue cap -> gateConfirm (default-on) -> commit
//            (+ the mandatory 0.05% fee leg). Nothing auto-signs. A DANGER
//            inspection forces an explicit confirm. The kill switch is honored.
//       A multi-step plan is surfaced as a PLAN and EACH step gets its OWN
//       confirm sheet (one gateConfirm per value-moving call).
//
//   (B) QUERY   ("which bot made money this week?", "what is my net worth?",
//               "how much ETH do I have?")
//       Answered ONLY from the real engines (portfolio.dart, the bots
//       dashboard/P&L ledger, get_balance). The agent runs in a READ-ONLY tool
//       registry (value tools stripped), so a query can NEVER reach a value-
//       moving tool. All numbers come from tool/engine results — never
//       fabricated. When a source is unavailable the tool reports it so the
//       answer is an honest "unavailable", never an invented balance/P&L.
//
// The runner, the policy, and the security gate are UNCHANGED — this module only
// orchestrates over them.

import 'dart:convert';

import 'pnl.dart' show PnlHook;
import 'policy.dart';
import 'providers.dart' show LlmProvider;
import 'runner.dart' show Runner, DispatchOutcome, dispatchValueMoving;
import 'tools.dart' show Tool, ToolRegistry;

const int _dayMs = 86400000;

const String classifySystem =
    'You route a Blockle wallet command bar. Decide whether the user\'s message is '
    'an ACTION (it asks to move funds: send, swap, trade, rebalance, buy, sell, '
    'provide/remove liquidity, launch or list a token, place/cancel an order) or a '
    'QUERY (it only asks a question about balances, net worth, prices, markets, or '
    'bot performance — nothing moves). Reply with exactly one word: ACTION or QUERY.';

const String actionSystem =
    'You are the in-wallet assistant executing a user instruction that moves funds. '
    'Call only the provided tools. Resolve the user\'s intent into concrete '
    'value-moving tool calls (a "rebalance" is a SEQUENCE of swap calls). Use '
    'base-unit integer amounts. The host enforces a per-session spending cap and an '
    'explicit human confirmation on EVERY value-moving call — you cannot bypass or '
    'weaken it, and you must not claim an action succeeded until the tool returns a '
    'result. Never ask for a password, seed phrase, private key, or API key.';

const String querySystem =
    'You answer questions about this Blockle wallet. You may call only READ-ONLY '
    'tools (balances, markets, quotes, net_worth, bots_pnl). You CANNOT move funds. '
    'Every number in your answer must come from a tool result — never invent a '
    'balance, price, or P&L. If a tool reports a source is unavailable, say so '
    'honestly rather than guessing.';

String _jstr(dynamic v) => jsonEncode(v, toEncodable: (o) {
      if (o is BigInt) return o.toString();
      return '$o';
    });

/// A resolved name -> address mapping: `{ address, source, name?/label? }`.
typedef ResolveNameFn = Future<Map<String, dynamic>?> Function(
    dynamic input, dynamic chain);

/// The REAL read-only engines a QUERY draws its numbers from. Both optional; a
/// missing engine makes its tool report `available:false` (never a fabricated
/// number) so the model answers honestly.
class CommandEngines {
  /// This wallet's total net worth across chains (portfolio engine).
  final Future<Map<String, dynamic>?> Function()? netWorth;

  /// Per-bot realized/unrealized P&L windowed by [sinceMs] (bots dashboard +
  /// P&L ledger).
  final Future<Map<String, dynamic>?> Function({required int sinceMs, required int days})?
      botsPnl;

  const CommandEngines({this.netWorth, this.botsPnl});
}

/// The result of one `run()`.
class CommandResult {
  final String intent; // 'action' | 'query'
  final String? text;
  final List<Map<String, dynamic>> steps;
  final bool stopped;
  final String reason;
  const CommandResult({
    required this.intent,
    this.text,
    this.steps = const [],
    required this.stopped,
    required this.reason,
  });
}

class CommandRouter {
  final LlmProvider provider;
  final ToolRegistry tools;
  final Policy policy;
  final dynamic audit; // Audit?
  final PnlHook? pnl;
  final String pnlWallet;
  final String pnlChannel;
  final void Function(Map<String, dynamic> ev)? onEvent;
  final int maxTurns;
  final String defaultChain;

  /// WalletAddressBook.resolveName bound to the active wallet/chain ctx.
  final ResolveNameFn? resolveNameFn;

  /// The real read-only query engines.
  final CommandEngines engines;

  /// Injected clock (ms) — never fabricated. Defaults to the wall clock.
  final int Function() now;

  CommandRouter({
    required this.provider,
    required this.tools,
    required this.policy,
    this.audit,
    this.pnl,
    String? pnlWallet,
    String? pnlChannel,
    this.onEvent,
    int? maxTurns,
    String? defaultChain,
    this.resolveNameFn,
    CommandEngines? engines,
    int Function()? now,
  })  : pnlWallet = pnlWallet ?? 'default',
        pnlChannel = pnlChannel ?? 'default',
        maxTurns = maxTurns ?? 8,
        defaultChain = defaultChain ?? 'ethereum',
        engines = engines ?? const CommandEngines(),
        now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  void emit(Map<String, dynamic> ev) {
    if (onEvent != null) {
      try {
        onEvent!(ev);
      } catch (_) {}
    }
  }

  Future<void> _rec(Map<String, dynamic> d) async {
    if (audit != null) {
      try {
        await audit.record(d);
      } catch (_) {}
    }
  }

  Map<String, dynamic> _toolResult(Map<String, dynamic> call, dynamic obj, bool isError) {
    return {
      'id': call['id'],
      'name': call['name'],
      'content': _jstr(obj),
      'isError': isError,
    };
  }

  // ---- entry point ----------------------------------------------------------
  Future<CommandResult> run(String text, {String? intent, String? system}) async {
    policy.assertLive();
    await _rec({'type': 'command', 'text': text});
    emit({'type': 'command', 'text': text});

    final i = intent ?? await classify(text);
    emit({'type': 'intent', 'intent': i});
    if (i == 'action') return runAction(text, system: system);
    return runQuery(text, system: system);
  }

  // ---- intent classification -------------------------------------------------
  // Ask the agent with NO tools offered (nothing can move during classify).
  // Fail SAFE: anything ambiguous is treated as a read-only QUERY — the router
  // never auto-escalates to an action.
  Future<String> classify(String text) async {
    Map<String, dynamic>? resp;
    try {
      resp = await provider.turn(
        system: classifySystem,
        messages: [
          {'role': 'user', 'text': text}
        ],
        tools: const [],
      );
    } catch (_) {
      resp = null;
    }
    if (resp != null && resp['intent'] is String) {
      return (resp['intent'] as String).toLowerCase() == 'action' ? 'action' : 'query';
    }
    final t = '${(resp?['text']) ?? ''}'.trim().toLowerCase();
    if (RegExp(r'\baction\b').hasMatch(t)) return 'action';
    return 'query';
  }

  // ===========================================================================
  // (A) ACTION — propose value-moving tool calls, resolve names, dispatch EACH
  //     through the ONE gate (dispatchValueMoving). Nothing bypasses it.
  // ===========================================================================
  Future<CommandResult> runAction(String text, {String? system}) async {
    // the full catalog is allowed here; every value move is still gated.
    policy.setAllowlist(tools.names());

    final messages = <Map<String, dynamic>>[
      {'role': 'user', 'text': text}
    ];
    final steps = <Map<String, dynamic>>[];
    String? lastText;

    for (var turn = 0; turn < maxTurns; turn++) {
      policy.assertLive();
      final resp = await provider.turn(
        system: system ?? actionSystem,
        messages: messages,
        tools: tools.schemas(),
      );
      final respText = resp['text'] as String?;
      lastText = respText ?? lastText;
      if (respText != null) emit({'type': 'text', 'text': respText});

      final calls = (resp['toolCalls'] as List?)?.cast<Map<String, dynamic>>() ?? const [];
      if (calls.isEmpty) {
        messages.add({'role': 'assistant', 'text': respText});
        return CommandResult(
            intent: 'action', text: respText, steps: steps, stopped: false, reason: 'end_turn');
      }
      messages.add({'role': 'assistant', 'text': respText, 'toolCalls': calls});

      // Surface the whole proposed PLAN before running any step. Each
      // value-moving step still gets its OWN confirm sheet below.
      final plan = [for (var i = 0; i < calls.length; i++) _describeStep(calls[i], i)];
      if (plan.isNotEmpty) emit({'type': 'plan', 'steps': plan});

      final results = <Map<String, dynamic>>[];
      for (final call in calls) {
        policy.assertLive();
        try {
          results.add(await _executeAction(call, steps));
        } on AgentHalted {
          // kill -> stop the whole plan
          await _rec({'type': 'halted'});
          return CommandResult(
              intent: 'action', text: lastText, steps: steps, stopped: true, reason: 'killed');
        } catch (e) {
          // a throw before a step was registered (allowlist / unknown tool).
          emit({'type': 'step_error', 'name': call['name'], 'error': '$e'});
          steps.add({'name': call['name'], 'status': 'error', 'error': '$e'});
          results.add(_toolResult(call, {'error': '$e'}, true));
        }
      }
      messages.add({'role': 'tool', 'results': results});
    }
    return CommandResult(
        intent: 'action', text: lastText, steps: steps, stopped: true, reason: 'max_turns');
  }

  Map<String, dynamic> _describeStep(Map<String, dynamic> call, int i) {
    return {'index': i, 'action': call['name'], 'args': call['arguments'] ?? {}};
  }

  Future<Map<String, dynamic>> _executeAction(
      Map<String, dynamic> call, List<Map<String, dynamic>> steps) async {
    final name = call['name'] as String;
    await _rec({'type': 'tool_call', 'name': name, 'args': call['arguments']});
    policy.checkAllowed(name); // throws ToolNotAllowed (recoverable)
    final tool = tools.get(name);
    if (tool == null) throw StateError('unknown tool: $name');

    // read-only tool proposed in an action plan (e.g. a quote lookup): run it.
    if (!tool.valueMoving) {
      final res = await tool.run!((call['arguments'] as Map?)?.cast<String, dynamic>() ?? {});
      return _toolResult(call, res, false);
    }

    // value-moving: register the step up front, then RESOLVE any name FIRST and
    // substitute the resolved address so the inspected / confirmed / sent address
    // is the resolved one — never the raw typed name.
    final args = Map<String, dynamic>.from((call['arguments'] as Map?) ?? const {});
    final step = <String, dynamic>{'name': name, 'status': 'pending', 'args': args};
    steps.add(step);
    try {
      final resolved = await _resolveRecipient(name, args);
      if (resolved != null) step['resolved'] = resolved;
      step['args'] = Map<String, dynamic>.from(args); // reflect the substituted address
      emit({'type': 'step', 'action': name, 'args': args, 'resolved': resolved});

      // THE gate — dispatchValueMoving (the single commit path). Cap check,
      // default-on confirm, danger forces confirm, kill honored, 0.05% fee leg.
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
        step['status'] = 'declined';
        step['reason'] = 'user declined confirmation';
        return _toolResult(
            call, {'rejected': true, 'reason': 'user declined confirmation', 'summary': o.summary}, false);
      }
      step['status'] = 'committed';
      step['result'] = {'txid': o.txid};
      return _toolResult(call, o.result, false);
    } on AgentHalted {
      rethrow; // propagate kill
    } catch (e) {
      // a cap breach / name-resolution failure / build error: mark THIS step and
      // report back to the model as a tool error. Nothing committed.
      step['status'] = 'error';
      step['error'] = '$e';
      emit({'type': 'step_error', 'name': name, 'error': '$e'});
      return _toolResult(call, {'error': '$e'}, true);
    }
  }

  // Resolve the recipient name for a `send` to a concrete address and MUTATE the
  // args in place so the resolved address is what gets inspected/confirmed/sent.
  // A name that does not resolve is a HARD error — we never send to an
  // unverified raw name. Non-send value tools have no recipient name to resolve.
  Future<Map<String, dynamic>?> _resolveRecipient(String name, Map<String, dynamic> args) async {
    if (name != 'send') return null;
    final input = args['to'];
    if (input == null) return null;
    final chain = (args['chain'] as String?) ?? defaultChain;
    // A name-like recipient (ENS/SNS/label — contains a dot or spaces) REQUIRES a
    // resolver; with none wired we FAIL CLOSED rather than pass the raw name to
    // buildSend. A plain address (no dot) needs no resolution and proceeds to the
    // gate as-is (where inspect + the confirm sheet still show it to the user).
    final looksLikeName = input is String && (input.contains('.') || input.contains(' '));
    if (resolveNameFn == null) {
      if (looksLikeName) {
        throw StateError('cannot resolve recipient name "$input" — no name '
            'resolver is wired; refusing to send to an unverified name');
      }
      return null; // a raw address: proceed; the gate still shows it for confirm.
    }
    Map<String, dynamic>? res;
    try {
      res = await resolveNameFn!(input, chain);
    } catch (_) {
      res = null;
    }
    if (res == null || res['address'] == null) {
      throw StateError('could not resolve recipient "$input" on $chain '
          '— refusing to send to an unverified name');
    }
    args['to'] = res['address']; // substitute the RESOLVED address
    emit({'type': 'resolved', 'input': input, 'address': res['address'], 'source': res['source']});
    return {'input': input, 'address': res['address'], 'source': res['source']};
  }

  // ===========================================================================
  // (B) QUERY — the agent runs in a READ-ONLY tool registry (value tools
  //     stripped). Answers come only from real engines + read-only tools.
  // ===========================================================================
  Future<CommandResult> runQuery(String text, {String? system}) async {
    final qtools = queryRegistry();
    // A fresh Runner over the READ-ONLY registry. Its constructor narrows the
    // policy allowlist to the query registry's names (which exclude every
    // value-moving tool), so a query can never reach send/swap — the SAME gate,
    // just with the money path unreachable.
    final runner = Runner(
      provider: provider,
      tools: qtools,
      policy: policy,
      audit: audit,
      system: system ?? querySystem,
      maxTurns: maxTurns,
      onEvent: emit,
    );
    final r = await runner.run(text);
    return CommandResult(
        intent: 'query', text: r.text, steps: const [], stopped: r.stopped, reason: r.reason);
  }

  /// The query-time registry: the EXISTING read-only tools + the read-only
  /// engine tools (net_worth, bots_pnl). Because its `all` list contains NO
  /// value-moving tool, neither `schemas()` (offered to the model) nor `names()`
  /// (the policy allowlist) can reach send/swap. No value-moving tool is
  /// reachable during a query.
  ToolRegistry queryRegistry() {
    final readOnly = [for (final t in tools.all) if (!t.valueMoving) t];
    return ToolRegistry([...readOnly, ..._engineTools()]);
  }

  // Read-only engine tools backed by the REAL engines. Each reports
  // `available:false` (never a fabricated number) when its engine is not wired
  // or returns nothing, so the model answers honestly.
  List<Tool> _engineTools() {
    return [
      Tool(
        name: 'net_worth',
        valueMoving: false,
        description:
            "This wallet's total net worth in USD across all chains, from the portfolio engine. Read-only.",
        parameters: const {'type': 'object', 'properties': {}},
        run: (a) async {
          if (engines.netWorth == null) {
            return {'available': false, 'reason': 'net-worth engine not available in this wallet'};
          }
          Map<String, dynamic>? r;
          try {
            r = await engines.netWorth!();
          } catch (_) {
            r = null;
          }
          if (r == null) return {'available': false, 'reason': 'net worth is currently unavailable'};
          return {
            'available': true,
            'totalUsd': r['totalUsd'],
            'byChain': r['byChain'],
            'unpriced': r['unpriced'],
            'asOf': r['asOf'],
          };
        },
      ),
      Tool(
        name: 'bots_pnl',
        valueMoving: false,
        description: 'Per-bot realized and unrealized P&L from the bots dashboard + P&L ledger. '
            'Optional `days` window (default 7, i.e. "this week"). Read-only.',
        parameters: const {
          'type': 'object',
          'properties': {
            'days': {'type': 'number', 'description': 'lookback window in days (default 7)'}
          }
        },
        run: (a) async {
          if (engines.botsPnl == null) {
            return {'available': false, 'reason': 'bot P&L engine not available in this wallet'};
          }
          final parsed = a['days'] == null ? null : num.tryParse('${a['days']}');
          final days = parsed != null && parsed.isFinite ? parsed.toInt() : 7;
          final sinceMs = now() - days * _dayMs;
          Map<String, dynamic>? r;
          try {
            r = await engines.botsPnl!(sinceMs: sinceMs, days: days);
          } catch (_) {
            r = null;
          }
          if (r == null) return {'available': false, 'reason': 'bot P&L is currently unavailable'};
          return {'available': true, 'windowDays': days, 'sinceMs': sinceMs, ...r};
        },
      ),
    ];
  }
}
