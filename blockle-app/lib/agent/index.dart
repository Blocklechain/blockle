// agent/index.dart — wiring facade for the in-wallet AI agent (Dart port of
// blockle-extension/agent/index.js). Assembles the provider adapter, the tool
// allowlist, the safety policy, the audit log, and the runner into one object
// the UI drives.
//
// The LLM credential comes from the unlocked vault only; it is held in memory
// for the session and wiped on lock/kill. It is sent only to the chosen
// provider's API, never to any Blockle server.

import 'audit.dart';
import 'policy.dart';
import 'providers.dart';
import 'runner.dart';
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
  AgentInstance(this.runner, this.policy, this.audit, this.tools);

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

  final runner = Runner(
    provider: provider,
    tools: tools,
    policy: policy,
    audit: audit,
    system: system,
    maxTurns: maxTurns,
    allowlist: allowlist,
    onEvent: onEvent,
  );

  return AgentInstance(runner, policy, audit, tools);
}
