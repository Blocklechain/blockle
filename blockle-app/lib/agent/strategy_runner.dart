// agent/strategy_runner.dart — the thin driver for the trading strategies
// (docs/AGENT-STRATEGIES.md section 4). It asks a [Strategy] to plan() a list of
// [StrategyIntent], then dispatches each one through the SAME value-moving
// routine the natural-language runner uses (`dispatchValueMoving` in runner.dart).
//
// There is exactly ONE commit path. The StrategyRunner adds no second broadcast
// path: it only decides WHETHER to dispatch (mode, allowlist, pair grouping,
// mainnet gate, kill) and then hands the Intent to the shared routine, where the
// hard caps, default-on confirm, kill, audit, and the mandatory 0.05% fee leg all
// still apply and cannot be bypassed.
//
//   tick(name, params, {mode}):
//     assertLive (kill)
//     strat = registry[name]; params = strat.validateParams(params)
//     intents = await strat.plan(ctx, params)          // READ-ONLY
//     audit { strategy_plan, count, mode }
//     for intent in intents:
//        kill?            -> abort the whole tick
//        not allowlisted  -> audited 'blocked'; (and drop its whole pair group)
//        mainnet && !on   -> audited 'refused'
//        mode==propose    -> audited 'strategy_proposal' (emit only, no dispatch)
//        mode==auto       -> dispatchValueMoving(...)  [cap->confirm->commit->fee]

import 'pnl.dart' show PnlHook;
import 'policy.dart';
import 'runner.dart' show dispatchValueMoving, DispatchOutcome;
import 'strategies.dart';
import 'tools.dart' show ToolRegistry;

/// The result of running a single strategy tick. One record per Intent.
class StrategyTickResult {
  final List<Map<String, dynamic>> records;
  final bool halted;
  const StrategyTickResult(this.records, {this.halted = false});
}

class StrategyRunner {
  final ToolRegistry tools;
  final Policy policy;
  final dynamic audit; // Audit? (duck-typed to avoid an import cycle)
  final StrategyContext ctx;

  /// Mainnet gate — default OFF. A mainnet-routed Intent is refused unless true.
  final bool mainnetEnabled;

  final Map<String, Strategy> registry;
  final void Function(Map<String, dynamic> ev)? onEvent;

  /// The shared realized-profit post-commit hook (§8). Optional.
  final PnlHook? pnl;
  final String pnlWallet;
  final String pnlChannel;

  /// Optional READ-ONLY candidate feed (§7). Duck-typed to a `{ scan() }` object
  /// (a [Discovery], or a test fake). Discovery NEVER trades, signs, or
  /// auto-allowlists; it only returns ranked, `approved=false` suggestions. The
  /// dispatch gate below is unchanged, so an unapproved token still produces a
  /// `blocked` audit note (never a trade).
  final dynamic discovery;

  /// When a strategy's `pair`/`asset` param is omitted, draw the candidate
  /// universe from [discovery] (filtered to `approved===true` by default).
  final bool useDiscovery;

  /// Draw UNapproved candidates too (default OFF). Even when on, an unapproved
  /// token is STILL subject to the allowlist at dispatch, so it can only ever
  /// produce a `blocked` audit note — never a trade.
  final bool autoConsiderUnapproved;

  StrategyRunner({
    required this.tools,
    required this.policy,
    required this.ctx,
    this.audit,
    this.mainnetEnabled = false,
    Map<String, Strategy>? strategies,
    this.onEvent,
    this.pnl,
    String? pnlWallet,
    String? pnlChannel,
    this.discovery,
    this.useDiscovery = false,
    this.autoConsiderUnapproved = false,
  })  : registry = strategies ?? defaultStrategies(),
        pnlWallet = pnlWallet ?? 'default',
        pnlChannel = pnlChannel ?? 'default';

  List<String> strategyNames() => registry.keys.toList();

  /// READ-ONLY candidate feed passthrough (§7). Returns ranked candidates from
  /// `discovery.scan()`, filtered to `approved===true` by DEFAULT. Only when
  /// [autoConsiderUnapproved] is explicitly enabled (or [includeUnapproved] is
  /// passed) are unapproved candidates included — and even then any resulting
  /// trade STILL passes the dispatch gate (an unapproved, non-allowlisted token
  /// produces a `blocked` note, never a trade). This method never trades, signs,
  /// or mutates the allowlist.
  Future<List<dynamic>> candidates({bool? includeUnapproved}) async {
    final d = discovery;
    if (d == null) return const [];
    final List<dynamic> all = List<dynamic>.from(await d.scan());
    final inc = includeUnapproved ?? autoConsiderUnapproved;
    return inc ? all : all.where((c) => c.approved == true).toList();
  }

  Future<void> _rec(Map<String, dynamic> d) async {
    if (audit != null) await audit.record(d);
  }

  void _emit(Map<String, dynamic> e) {
    if (onEvent != null) {
      try {
        onEvent!(e);
      } catch (_) {}
    }
  }

  bool _allowed(String tool) {
    try {
      policy.checkAllowed(tool);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Run one tick of [strategyName]. [mode] is 'propose' (default — emit + audit,
  /// no dispatch) or 'auto' (dispatch within caps + autoApproveUnderUsd, still
  /// honoring confirm/kill/mainnet).
  Future<StrategyTickResult> tick(
    String strategyName,
    Map<String, dynamic>? params, {
    String mode = 'propose',
  }) async {
    policy.assertLive(); // a kill before the tick blocks everything

    final strat = registry[strategyName];
    if (strat == null) throw ArgumentError('unknown strategy: $strategyName');
    final p = strat.validateParams(params);

    final intents = await strat.plan(_wrapCtxForAudit(), p);

    await _rec({
      'type': 'strategy_plan',
      'strategy': strategyName,
      'count': intents.length,
      'mode': mode,
    });
    _emit({'type': 'strategy_plan', 'strategy': strategyName, 'count': intents.length, 'mode': mode});

    // Pair grouping: if ANY leg of a pair group is not allowlisted, the whole
    // group is dropped (an arb must emit both legs or neither).
    final blockedPairs = <String>{};
    for (final it in intents) {
      if (it.pair != null && !_allowed(it.tool)) blockedPairs.add(it.pair!);
    }

    final records = <Map<String, dynamic>>[];
    for (final it in intents) {
      if (policy.isKilled()) {
        await _rec({'type': 'halted', 'strategy': strategyName});
        return StrategyTickResult(records, halted: true);
      }

      final notAllowed = !_allowed(it.tool);
      final pairBlocked = it.pair != null && blockedPairs.contains(it.pair);
      if (notAllowed || pairBlocked) {
        final reason =
            notAllowed ? 'tool not on allowlist' : 'paired leg not on allowlist';
        await _rec({
          'type': 'blocked',
          'strategy': strategyName,
          'tool': it.tool,
          'tag': it.tag,
          'reason': reason,
        });
        records.add({'blocked': it.toJson(), 'reason': reason});
        continue;
      }

      // FIX-3: mainnet gate with a CHAIN-LEVEL backstop. The Intent is treated as
      // mainnet if the strategy/venue flagged it OR the run's resolved network is
      // mainnet — so venue-less auto-routed swaps (dca/grid/rebalance/momentum)
      // are covered too, never relying only on a venue descriptor or caller param.
      if ((it.mainnet || _networkMainnet()) && !mainnetEnabled) {
        await _rec({
          'type': 'refused',
          'strategy': strategyName,
          'tag': it.tag,
          'reason': 'mainnet venue but mainnetEnabled=false',
        });
        records.add({'refused': 'mainnet', 'intent': it.toJson()});
        continue;
      }

      // FIX-5: dispatch (live) ONLY when mode is exactly 'auto'. ANY other value —
      // a typo, 'dryrun', '' — fails SAFE to propose: emit + audit, dispatch nothing.
      if (mode != 'auto') {
        await _rec({'type': 'strategy_proposal', 'strategy': strategyName, 'intent': it.toJson()});
        _emit({'type': 'strategy_proposal', 'strategy': strategyName, 'intent': it.toJson()});
        records.add({'proposed': it.toJson()});
        continue;
      }

      // FIX-6: structural gate invariant. In auto mode we only ever hand an Intent
      // to the ONE shared value-moving dispatch. An Intent that names a tool which
      // is unknown or NOT value-moving (a read-only/mis-flagged tool) is DROPPED
      // with an audited 'blocked' note — tool.run() is never called from a
      // strategy, and such a tool never crashes the tick.
      final tool = tools.get(it.tool);
      if (tool == null || !tool.valueMoving) {
        final reason =
            tool == null ? 'unknown tool' : 'tool is not value-moving';
        await _rec({
          'type': 'blocked',
          'strategy': strategyName,
          'tool': it.tool,
          'tag': it.tag,
          'reason': reason,
        });
        records.add({'blocked': it.toJson(), 'reason': reason});
        continue;
      }

      // ---- auto: dispatch through the ONE shared value-moving routine ----
      try {
        final DispatchOutcome o = await dispatchValueMoving(
          tools: tools,
          policy: policy,
          name: it.tool,
          args: it.args,
          audit: audit,
          emit: onEvent,
          pnl: pnl,
          pnlWallet: pnlWallet,
          pnlChannel: pnlChannel,
        );
        if (o.declined) {
          records.add({'declined': it.toJson()});
        } else {
          records.add({
            'executed': it.toJson(),
            'txid': o.txid,
            'result': o.result,
            if (o.agentFee != null) 'fee': o.agentFee,
          });
        }
      } on CapExceeded catch (e) {
        await _rec({'type': 'error', 'strategy': strategyName, 'tag': it.tag, 'error': '$e'});
        records.add({'rejected': 'cap', 'error': '$e', 'intent': it.toJson()});
      } on AgentHalted {
        // A kill mid-confirm/commit aborts the whole tick (commit already blocked
        // by policy.assertLive inside the shared routine).
        await _rec({'type': 'halted', 'strategy': strategyName});
        return StrategyTickResult(records, halted: true);
      } catch (e) {
        // FIX-6: any OTHER failure from the shared dispatch (e.g. a mis-flagged
        // tool throwing StateError) is RECOVERABLE — record it and move on; it
        // must never abort the whole tick. Kill still escapes via AgentHalted above.
        await _rec({'type': 'error', 'strategy': strategyName, 'tag': it.tag, 'error': '$e'});
        _emit({'type': 'strategy_error', 'tag': it.tag, 'error': '$e'});
        records.add({'error': it.toJson(), 'message': '$e'});
      }
    }

    return StrategyTickResult(records);
  }

  /// CHAIN-LEVEL mainnet backstop (FIX-3): true when the run's resolved network is
  /// mainnet, regardless of any venue descriptor or caller param. Fail-safe.
  bool _networkMainnet() {
    try {
      return ctx.network?.call() == 'mainnet';
    } catch (_) {
      return false;
    }
  }

  /// Wrap the host ctx so a strategy's `skip` notes are mirrored into the audit
  /// (the strategy stays pure; the side effect lives here).
  StrategyContext _wrapCtxForAudit() {
    if (audit == null && onEvent == null) return ctx;
    return StrategyContext(
      now: ctx.now,
      network: ctx.network,
      listVenues: ctx.listVenues,
      venueQuote: ctx.venueQuote,
      getBook: ctx.getBook,
      getTrades: ctx.getTrades,
      getMarkets: ctx.getMarkets,
      getBalance: ctx.getBalance,
      prices: ctx.prices,
      policyRemaining: ctx.policyRemaining,
      openOrders: ctx.openOrders,
      note: (n) {
        if (audit != null) {
          // fire-and-forget; audit.record is async but notes are best-effort.
          audit.record({'type': 'strategy_skip', ...n});
        }
        _emit({'type': 'strategy_skip', ...n});
        ctx.note?.call(n);
      },
    );
  }
}
