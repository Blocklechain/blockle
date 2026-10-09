// agent/policy.dart — the MANDATORY, non-bypassable safety layer for the
// in-wallet AI agent (Dart port of blockle-extension/agent/policy.js). Enforced
// in code, never by prompt. Four rails live here:
//
//   1. Per-session spending caps      (hard-reject over cap; reset only by user)
//   2. Confirmation gate (default-on) (every value-moving action awaits a human)
//   3. Tool allowlist check           (only named tools may run)
//   4. Kill switch                    (abort + revoke session + lock the vault)
//
// Values are tracked two ways, both independently enforced:
//   - per-asset cumulative spend, in BASE UNITS (BigInt)
//   - an optional session cap in a USD-equivalent reference number
// A value-moving action reports { asset, amount, usd? }. If a session USD cap is
// set, an action with no `usd` estimate is REJECTED (cannot be verified).

/// Thrown to halt the loop (kill switch). `halted` marks it for the runner.
class AgentHalted implements Exception {
  final String message;
  final bool halted = true;
  AgentHalted([this.message = 'agent halted']);
  @override
  String toString() => message;
}

/// Thrown when a value-moving action would breach a cap (recoverable).
class CapExceeded implements Exception {
  final String message;
  final bool cap = true;
  CapExceeded(this.message);
  @override
  String toString() => message;
}

/// Thrown when a tool is not on the allowlist (recoverable).
class ToolNotAllowed implements Exception {
  final String toolName;
  ToolNotAllowed(this.toolName);
  @override
  String toString() => 'tool not on allowlist: $toolName';
}

BigInt _toBig(dynamic v) {
  if (v is BigInt) return v;
  if (v == null || v == '') return BigInt.zero;
  final s = '$v'.trim();
  if (!RegExp(r'^-?\d+$').hasMatch(s)) {
    throw ArgumentError('amount must be a base-unit integer string: $s');
  }
  return BigInt.parse(s);
}

/// A value-moving action's accounting descriptor.
class SpendValue {
  final String? asset;
  final dynamic amount; // base-unit decimal string or BigInt
  final num? usd;
  const SpendValue({this.asset, this.amount, this.usd});
}

/// The result of the confirmation gate.
class GateResult {
  final bool approved;
  final bool auto;
  const GateResult(this.approved, this.auto);
}

/// Session caps.
class Caps {
  num? sessionUsd;
  final Map<String, BigInt> perAsset;
  Caps({this.sessionUsd, Map<String, BigInt>? perAsset})
      : perAsset = perAsset ?? {};
}

class Policy {
  final Caps caps;
  final Future<bool> Function(Map<String, dynamic> summary)? confirmFn;
  final Future<void> Function(String? reason)? onKill;
  final dynamic audit; // Audit (duck-typed to avoid a hard import cycle)
  bool requireConfirm;
  final num? autoApproveUnderUsd;

  num spentUsd = 0;
  final Map<String, BigInt> spentByAsset = {};
  bool killed = false;
  Set<String>? allowlist;

  Policy({
    Caps? caps,
    this.confirmFn,
    this.onKill,
    this.audit,
    this.requireConfirm = true,
    this.autoApproveUnderUsd,
  }) : caps = caps ?? Caps();

  /// Build a Policy from the loose option shape used by the extension/tests.
  factory Policy.create({
    Map<String, dynamic>? caps,
    Future<bool> Function(Map<String, dynamic>)? confirm,
    Future<void> Function(String?)? onKill,
    dynamic audit,
    bool requireConfirm = true,
    num? autoApproveUnderUsd,
  }) {
    final c = Caps();
    if (caps != null) {
      if (caps['sessionUsd'] != null) {
        c.sessionUsd = (caps['sessionUsd'] as num);
      }
      if (caps['perAsset'] is Map) {
        (caps['perAsset'] as Map).forEach((k, v) {
          c.perAsset['$k'] = _toBig(v);
        });
      }
    }
    return Policy(
      caps: c,
      confirmFn: confirm,
      onKill: onKill,
      audit: audit,
      requireConfirm: requireConfirm,
      autoApproveUnderUsd: autoApproveUnderUsd,
    );
  }

  // ---- allowlist ----------------------------------------------------------
  Policy setAllowlist(Iterable<String>? names) {
    allowlist = Set<String>.from(names ?? const <String>[]);
    return this;
  }

  bool checkAllowed(String name) {
    if (allowlist != null && !allowlist!.contains(name)) {
      throw ToolNotAllowed(name);
    }
    return true;
  }

  // ---- kill switch --------------------------------------------------------
  bool isKilled() => killed;

  void assertLive() {
    if (killed) throw AgentHalted('agent killed');
  }

  Future<void> kill([String? reason]) async {
    if (killed) return;
    killed = true;
    if (audit != null) {
      try {
        await audit.record({'type': 'kill', 'reason': reason ?? 'user'});
      } catch (_) {}
    }
    if (onKill != null) {
      try {
        await onKill!(reason);
      } catch (_) {}
    }
  }

  // ---- spending caps ------------------------------------------------------
  /// Pre-check WITHOUT recording. Throws [CapExceeded] on violation.
  bool assessValue(SpendValue value) {
    final asset = value.asset;
    final amount = value.amount != null ? _toBig(value.amount) : BigInt.zero;
    final usd = value.usd;

    if (asset != null && caps.perAsset[asset] != null) {
      final cap = caps.perAsset[asset]!;
      final next = (spentByAsset[asset] ?? BigInt.zero) + amount;
      if (next > cap) {
        throw CapExceeded(
            'per-asset cap exceeded for $asset: would spend $next base units, cap is $cap');
      }
    }

    if (caps.sessionUsd != null) {
      if (usd == null) {
        throw CapExceeded(
            'session cap is set (\$${caps.sessionUsd}) but this action has no USD estimate — cannot verify, rejecting');
      }
      final next = spentUsd + usd;
      if (next > caps.sessionUsd!) {
        throw CapExceeded(
            'session USD cap exceeded: would spend \$${next.toStringAsFixed(2)}, cap is \$${caps.sessionUsd}');
      }
    }
    return true;
  }

  /// Record a committed spend. Called only AFTER a successful broadcast/execute.
  void recordSpend(SpendValue value) {
    if (value.usd != null) spentUsd += value.usd!;
    if (value.asset != null && value.amount != null) {
      spentByAsset[value.asset!] =
          (spentByAsset[value.asset!] ?? BigInt.zero) + _toBig(value.amount);
    }
  }

  /// Caps reset only by explicit user action — never by the agent.
  void resetSpend() {
    spentUsd = 0;
    spentByAsset.clear();
  }

  void setCaps(Map<String, dynamic> newCaps) {
    if (newCaps.containsKey('sessionUsd')) {
      caps.sessionUsd =
          newCaps['sessionUsd'] != null ? (newCaps['sessionUsd'] as num) : null;
    }
    if (newCaps['perAsset'] is Map) {
      (newCaps['perAsset'] as Map).forEach((k, v) {
        caps.perAsset['$k'] = _toBig(v);
      });
    }
  }

  Map<String, dynamic> remaining() {
    final perAsset = <String, String>{};
    caps.perAsset.forEach((k, cap) {
      perAsset[k] = (cap - (spentByAsset[k] ?? BigInt.zero)).toString();
    });
    return {
      'sessionUsd':
          caps.sessionUsd != null ? caps.sessionUsd! - spentUsd : null,
      'perAsset': perAsset,
    };
  }

  // ---- confirmation gate --------------------------------------------------
  /// Fail-safe: no handler => denied.
  Future<GateResult> gateConfirm(
      Map<String, dynamic> summary, Map<String, dynamic>? meta) async {
    assertLive();
    meta = meta ?? {};
    final usd = meta['usd'] != null ? (meta['usd'] as num) : null;

    if (autoApproveUnderUsd != null && usd != null && usd <= autoApproveUnderUsd!) {
      return const GateResult(true, true);
    }
    if (!requireConfirm) return const GateResult(true, false);
    if (confirmFn == null) return const GateResult(false, false); // fail closed
    final ok = await confirmFn!(summary);
    assertLive(); // a kill during the await must still block the action
    return GateResult(ok, false);
  }
}
