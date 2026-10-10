// agent/index.dart — wiring facade for the in-wallet AI agent (Dart port of
// blockle-extension/agent/index.js). Assembles the provider adapter, the tool
// allowlist, the safety policy, the audit log, and the runner into one object
// the UI drives.
//
// The LLM credential comes from the unlocked vault only; it is held in memory
// for the session and wiped on lock/kill. It is sent only to the chosen
// provider's API, never to any Blockle server.

import 'audit.dart';
import 'notify.dart';
import 'pnl.dart';
import 'policy.dart';
import 'providers.dart';
import 'runner.dart';
import 'strategies.dart' show StrategyContext, Strategy;
import 'strategy_runner.dart';
import 'tools.dart';

/// A resolved LLM credential (from the unlocked vault). NEVER persisted.
class AgentCredential {
  final String provider;
  final String apiKey;
  final String? model;
  final String? baseUrl;
  const AgentCredential({
    required this.provider,
    required this.apiKey,
    this.model,
    this.baseUrl,
  });
}

/// The assembled, running agent. Mirrors the object `Agent.start` returns.
class AgentInstance {
  final Runner runner;
  final Policy policy;
  final Audit audit;
  final ToolRegistry tools;

  /// The realized-profit ledger + hook (§8), or null when PnL is disabled.
  final PnlLedger? pnlLedger;

  /// The ONE post-commit realized-profit hook (§8), shared so a [StrategyRunner]
  /// updates the SAME ledger as the natural-language [Runner]. Null when disabled.
  final PnlHook? pnlHook;

  AgentInstance(this.runner, this.policy, this.audit, this.tools,
      {this.pnlLedger, this.pnlHook});

  Future<RunResult> run(String prompt, {bool Function()? aborted}) =>
      runner.run(prompt, aborted: aborted);
  Future<void> kill([String? reason]) => runner.kill(reason);
  void setCaps(Map<String, dynamic> caps) => policy.setCaps(caps);
  void resetSpend() => policy.resetSpend();
  Map<String, dynamic> remaining() => policy.remaining();
  void reset() => runner.reset();
}

/// Assemble + start an agent. [fetch] is the injected HTTP transport the
/// provider uses to reach the LLM API (keeps the core testable and platform-
/// agnostic). Throws if no credential is configured.
AgentInstance startAgent({
  required AgentCredential? credential,
  required ProviderFetch fetch,
  required AgentContext ctx,
  Map<String, dynamic>? caps,
  Future<bool> Function(Map<String, dynamic> summary)? confirm,
  Future<void> Function(String? reason)? onKill,
  AuditStore? store,
  void Function(Map<String, dynamic> entry)? onAudit,
  void Function(Map<String, dynamic> ev)? onEvent,
  String? model,
  List<String>? allowlist,
  String? system,
  int? maxTurns,
  bool requireConfirm = true,
  num? autoApproveUnderUsd,
  AgentNotifier? notifier,
  PnlConfig? pnlConfig,
  Map<String, dynamic>? pnlInitial,
  void Function(Map<String, dynamic> ledger)? onPnlChange,
  String? walletId,
  String? channelId,
}) {
  final cred = credential;
  if (cred == null || cred.apiKey.isEmpty) {
    throw StateError(
        'AI agent is not configured — enable it and add an LLM credential first');
  }

  final audit = Audit(store: store, sink: onAudit);

  final policy = Policy.create(
    caps: caps ?? {},
    confirm: confirm,
    onKill: onKill,
    audit: audit,
    requireConfirm: requireConfirm,
    autoApproveUnderUsd: autoApproveUnderUsd,
  );

  final provider = createProvider(
    provider: cred.provider,
    apiKey: cred.apiKey,
    fetch: fetch,
    model: cred.model ?? model,
    baseUrl: cred.baseUrl,
  );

  final tools = buildTools(ctx);

  // Realized-profit ledger + the ONE post-commit hook (§8). The ledger persists
  // alongside the audit (no key material); the pop-up fires through the injected
  // notifier. Enabled whenever a notifier or explicit PnL config is provided.
  PnlLedger? ledger;
  PnlHook? pnl;
  if (notifier != null || pnlConfig != null) {
    ledger = PnlLedger(onChange: onPnlChange, initial: pnlInitial);
    pnl = PnlHook(
      ledger: ledger,
      config: pnlConfig,
      notifier: notifier,
      audit: audit,
    );
  }

  final runner = Runner(
    provider: provider,
    tools: tools,
    policy: policy,
    audit: audit,
    system: system,
    maxTurns: maxTurns,
    allowlist: allowlist,
    onEvent: onEvent,
    pnl: pnl,
    pnlWallet: walletId,
    pnlChannel: channelId,
  );

  return AgentInstance(runner, policy, audit, tools,
      pnlLedger: ledger, pnlHook: pnl);
}

/// Assemble a [StrategyRunner] (§4) wired to an already-started agent's shared
/// policy / tools / audit / post-commit PnL hook, plus an optional READ-ONLY
/// [discovery] feed (§7). This is the ONE place discovery meets the strategy
/// driver, and it preserves every safety guarantee:
///   • Discovery is READ-ONLY — it never trades, signs, or broadcasts.
///   • A discovered token is NEVER auto-added to the policy allowlist.
///   • The StrategyRunner's dispatch gate is unchanged, so an unapproved token
///     can only ever produce a `blocked` audit note, never a trade.
/// When a strategy's `pair`/`asset` param is omitted and [useDiscovery] is on,
/// the candidate universe is drawn from `discovery.scan()` filtered to
/// `approved===true` by DEFAULT — or, only if [autoConsiderUnapproved] is
/// explicitly true, from all candidates (still subject to the allowlist at
/// dispatch).
StrategyRunner buildStrategyRunner({
  required AgentInstance agent,
  required StrategyContext ctx,
  bool mainnetEnabled = false,
  Map<String, Strategy>? strategies,
  void Function(Map<String, dynamic> ev)? onEvent,
  dynamic discovery,
  bool useDiscovery = false,
  bool autoConsiderUnapproved = false,
  String? walletId,
  String? channelId,
}) {
  return StrategyRunner(
    tools: agent.tools,
    policy: agent.policy,
    ctx: ctx,
    audit: agent.audit,
    mainnetEnabled: mainnetEnabled,
    strategies: strategies,
    onEvent: onEvent,
    pnl: agent.pnlHook, // the SAME ledger the NL runner updates (one commit path)
    pnlWallet: walletId,
    pnlChannel: channelId,
    discovery: discovery,
    useDiscovery: useDiscovery,
    autoConsiderUnapproved: autoConsiderUnapproved,
  );
}
