// telemetry.dart — ANONYMIZED agent-performance emitter (Dart port of
// blockle-extension/telemetry.js). Feeds the future "house" trading algorithm
// with aggregate signal about agent performance WITHOUT ever learning who the
// user is or what they hold.
//
// HARD RULES (enforced in code, not by convention):
//   * Never include keys / seeds / LLM creds / raw addresses. The payload is
//     built from a strict WHITELIST of coarse fields; a scrubber runs on the
//     finished payload and THROWS (drops the emit) if anything slips through.
//   * Default OFF. Nothing is sent until the user opts in. Disabled => no
//     network call, ever.
//   * Amounts are bucketed, never exact. No wallet/exchange account id is sent —
//     only a locally-salted, daily-rotating pseudonymous `agentId`.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

const int telemetrySchemaVersion = 1;
const String telemetryDefaultCollector =
    'https://blockle.org/api/agent-telemetry';
const int _defaultRotateMs = 24 * 60 * 60 * 1000;
const String _saltKey = 'agentTelemetrySalt';
const String _enabledKey = 'agentTelemetryEnabled';

const String telemetryDisclosure =
    'Anonymous performance telemetry is OFF by default. If you opt in, Blockle '
    'receives coarse, bucketed stats about how the trading agent performs '
    '(strategy, venue, chain, size range, win/loss, P&L %) under a rotating '
    'pseudonymous id. It never includes your keys, seed phrase, LLM credentials, '
    'wallet addresses, or exact amounts. You can turn it off at any time.';

/// Raised by the scrubber when a secret/address-like value or a disallowed field
/// name is found. The emit is refused; the error never surfaces to the trade.
class TelemetryScrubbed implements Exception {
  final String message;
  const TelemetryScrubbed(this.message);
  @override
  String toString() => message;
}

String _sha256hex(String s) {
  final d = SHA256Digest();
  final out = d.process(Uint8List.fromList(utf8.encode(s)));
  return out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

final Random _rng = Random.secure();
String _randomHex(int bytes) {
  final a = List<int>.generate(bytes, (_) => _rng.nextInt(256));
  return a.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

// --- bucketing --------------------------------------------------------------
const List<List<dynamic>> _usdBuckets = [
  [0, '0'],
  [10, '<10'],
  [100, '10-100'],
  [1000, '100-1k'],
  [10000, '1k-10k'],
  [100000, '10k-100k'],
  [1000000, '100k-1m'],
];

String bucketUsd(dynamic n) {
  final v = n is num ? n.toDouble() : double.tryParse('$n');
  if (v == null || !v.isFinite || v < 0) return 'unknown';
  if (v == 0) return '0';
  for (final b in _usdBuckets) {
    final hi = b[0] as int;
    if (hi == 0) continue;
    if (v < hi) return b[1] as String;
  }
  return '1m+';
}

String bucketHoldTime(dynamic sec) {
  final v = sec is num ? sec.toDouble() : double.tryParse('$sec');
  if (v == null || !v.isFinite || v < 0) return 'unknown';
  if (v < 60) return '<1m';
  if (v < 3600) return '1m-1h';
  if (v < 86400) return '1h-1d';
  if (v < 604800) return '1d-1w';
  return '1w+';
}

double? _round(dynamic n, int dp) {
  final v = n is num ? n.toDouble() : double.tryParse('$n');
  if (v == null || !v.isFinite) return null;
  final f = pow(10, dp);
  return (v * f).round() / f;
}

// --- label sanitizing -------------------------------------------------------
final List<RegExp> _addressLike = [
  RegExp(r'0x[0-9a-fA-F]{40}'),
  RegExp(r'[0-9a-fA-F]{40,}'),
  RegExp(r'\b(bc1|ltc1|tb1|block1|doge1)[0-9ac-hj-np-z]{8,}', caseSensitive: false),
  RegExp(r'\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b'),
  RegExp(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b'),
];

String? sanitizeLabel(dynamic s, [int max = 48]) {
  if (s == null) return null;
  // strip control characters (0x00-0x1f, 0x7f), mirroring the extension's
  // /[\0-\037\177]/ — keeps spaces/hyphens so "mean-reversion" survives intact.
  var v = '$s'.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '').trim();
  if (v.isEmpty) return null;
  for (final re in _addressLike) {
    if (re.hasMatch(v)) return 'redacted';
  }
  if (v.length > max) v = v.substring(0, max);
  return v;
}

// --- secret / address scrubber (defense in depth) ---------------------------
final List<RegExp> _secretPatterns = [
  RegExp(r'0x[0-9a-fA-F]{40}'),
  RegExp(r'[0-9a-fA-F]{40,}'),
  RegExp(r'\b(bc1|ltc1|tb1|block1|doge1)[0-9ac-hj-np-z]{8,}', caseSensitive: false),
  RegExp(r'\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b'),
  RegExp(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b'),
  RegExp(r'sk-[a-zA-Z0-9]{8,}'),
  RegExp(
      r'\b(api[_-]?key|secret|priv(ate)?[_-]?key|mnemonic|seed[_-]?phrase|passphrase|password)\b',
      caseSensitive: false),
];

final RegExp _disallowedFieldName = RegExp(
    r'^(key|seed|secret|apikey|api_key|privkey|private_key|mnemonic|address|addr|from|to)$',
    caseSensitive: false);

/// Runs on the FINISHED payload. Throws [TelemetryScrubbed] if any string value
/// matches a secret/address pattern, or any object key is a disallowed name.
void assertNoSecrets(dynamic obj, [String path = 'payload']) {
  if (obj == null) return;
  if (obj is String) {
    for (final re in _secretPatterns) {
      if (re.hasMatch(obj)) {
        throw TelemetryScrubbed(
            'telemetry: refused — secret/address-like value at $path');
      }
    }
    return;
  }
  if (obj is Map) {
    for (final k in obj.keys) {
      if (_disallowedFieldName.hasMatch('$k')) {
        throw TelemetryScrubbed(
            'telemetry: refused — disallowed field name "$k" at $path');
      }
      assertNoSecrets(obj[k], '$path.$k');
    }
  } else if (obj is List) {
    for (var i = 0; i < obj.length; i++) {
      assertNoSecrets(obj[i], '$path.$i');
    }
  }
}

// --- asset-class classifier (coarse) ---------------------------------------
const Set<String> _stables = {
  'USDC', 'USDT', 'DAI', 'USD', 'USDP', 'TUSD', 'PYUSD', 'FDUSD'
};
const Set<String> _majors = {'BTC', 'ETH', 'SOL', 'LTC', 'DOGE', 'BNB', 'XRP'};

String classifyAsset(dynamic symbol) {
  final s = sanitizeLabel(symbol, 16);
  if (s == null || s == 'redacted') return 'unknown';
  final up = s.toUpperCase();
  if (up == 'BLOCK') return 'block';
  if (_stables.contains(up)) return 'stablecoin';
  if (_majors.contains(up)) return 'crypto-major';
  return 'crypto-other';
}

String? sanitizePair(dynamic pair) {
  final s = sanitizeLabel(pair, 24);
  if (s == null) return null;
  if (s == 'redacted') return 'redacted';
  final parts = s
      .split(RegExp(r'[\/\-:_]'))
      .map((p) => p.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase())
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.isEmpty) return null;
  return parts.take(2).join('/');
}

String _normResult(dynamic r) {
  final s = (r == null ? '' : '$r').toLowerCase();
  if (s == 'win' || s == 'won' || s == 'profit') return 'win';
  if (s == 'loss' || s == 'lost' || s == 'lose') return 'loss';
  if (s == 'flat' || s == 'breakeven' || s == 'even') return 'flat';
  return 'unknown';
}

String? _normSide(dynamic side) {
  final s = (side == null ? '' : '$side').toLowerCase();
  if (s == 'buy' || s == 'long' || s == 'bid') return 'buy';
  if (s == 'sell' || s == 'short' || s == 'ask') return 'sell';
  return null;
}

/// Minimal key/value store shim (the chrome.storage get/set shape).
abstract class TelemetryStore {
  Future<Map<String, dynamic>> get(List<String> keys);
  Future<void> set(Map<String, dynamic> obj);
}

/// `{ emitted, reason?, payload? }` result of an emit.
class EmitResult {
  final bool emitted;
  final String? reason;
  final String? error;
  final Map<String, dynamic>? payload;
  const EmitResult(this.emitted, {this.reason, this.error, this.payload});
}

/// `fetch`-style POST transport; returns nothing of interest (fire-and-forget).
typedef TelemetryPost = Future<void> Function(
    String url, Map<String, String> headers, String body);

class Telemetry {
  bool enabled;
  final String collectorUrl;
  final TelemetryStore? store;
  final int Function() clock;
  final int rotateMs;
  final TelemetryPost? post;
  final void Function(Map<String, dynamic>)? sink;
  String? _salt;

  Telemetry({
    this.enabled = false, // DEFAULT OFF
    String? collectorUrl,
    this.store,
    int Function()? clock,
    int? rotateMs,
    this.post,
    this.sink,
    String? salt,
  })  : collectorUrl = collectorUrl ?? telemetryDefaultCollector,
        clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch),
        rotateMs = rotateMs ?? _defaultRotateMs,
        _salt = salt;

  bool isEnabled() => enabled == true;

  Future<bool> setEnabled(bool on) async {
    enabled = on;
    if (store != null) {
      try {
        await store!.set({_enabledKey: enabled});
      } catch (_) {}
    }
    return enabled;
  }

  Future<bool> loadEnabled() async {
    if (store == null) return enabled;
    try {
      final got = await store!.get([_enabledKey]);
      if (got[_enabledKey] is bool) enabled = got[_enabledKey] as bool;
    } catch (_) {}
    return enabled;
  }

  Future<String> _getSalt() async {
    if (_salt != null) return _salt!;
    if (store != null) {
      try {
        final got = await store!.get([_saltKey]);
        if (got[_saltKey] != null) {
          _salt = got[_saltKey] as String;
          return _salt!;
        }
      } catch (_) {}
    }
    _salt = _randomHex(16);
    if (store != null) {
      try {
        await store!.set({_saltKey: _salt});
      } catch (_) {}
    }
    return _salt!;
  }

  /// Daily-rotating pseudonymous id = sha256(localSalt : rotationBucket)[:16].
  Future<String> agentId([int? ts]) async {
    final salt = await _getSalt();
    final bucket = ((ts ?? clock()) / rotateMs).floor();
    final h = _sha256hex('$salt:$bucket');
    return h.substring(0, 16);
  }

  /// Build the anonymized, bucketed payload from a WHITELIST of coarse fields.
  Future<Map<String, dynamic>> buildPayload(Map<String, dynamic> ev) async {
    final ts = ev['ts'] != null ? (ev['ts'] as num).toInt() : clock();

    final sizeUsd = ev['sizeUsd'] ?? ev['notionalUsd'];
    dynamic holdSec = ev['holdTimeSec'];
    if (holdSec == null && ev['holdTimeMs'] != null) {
      holdSec = (ev['holdTimeMs'] as num) / 1000;
    }
    if (holdSec == null && ev['openedAt'] != null && ev['closedAt'] != null) {
      holdSec = ((ev['closedAt'] as num) - (ev['openedAt'] as num)) / 1000;
    }

    final pair = sanitizePair(ev['pair']);
    final baseSymbol = pair != null ? pair.split('/')[0] : ev['asset'];
    final assetClass =
        sanitizeLabel(ev['assetClass'], 24) ?? classifyAsset(baseSymbol);

    final payload = <String, dynamic>{
      'v': telemetrySchemaVersion,
      'agentId': await agentId(ts),
      'ts': (ts ~/ 60000) * 60000,
      'strategy': sanitizeLabel(ev['strategy'], 48) ?? 'unspecified',
      'venue': sanitizeLabel(ev['venue'], 32) ?? 'unknown',
      'chain': sanitizeLabel(ev['chain'], 24) ?? 'unknown',
      'assetClass': assetClass,
      'pair': pair,
      'side': _normSide(ev['side']),
      'sizeBucket': bucketUsd(sizeUsd),
      'holdBucket': bucketHoldTime(holdSec),
      'holdTimeSec': holdSec != null ? _round(holdSec, 0) : null,
      'result': _normResult(ev['result'] ?? ev['win']),
      'pnlPct': ev['pnlPct'] != null ? _round(ev['pnlPct'], 2) : null,
      'slippagePct': ev['slippagePct'] != null ? _round(ev['slippagePct'], 3) : null,
      'feeBucket': ev['feePaidUsd'] != null ? bucketUsd(ev['feePaidUsd']) : 'unknown',
      'feePct': ev['feePct'] != null ? _round(ev['feePct'], 3) : null,
      'intent': sanitizeLabel(ev['intent'], 32),
      'outcome': sanitizeLabel(ev['outcome'], 32),
      'outcomeMetIntent': ev['metIntent'] is bool ? ev['metIntent'] : null,
    };

    if (payload['result'] == 'unknown' && ev['win'] is bool) {
      payload['result'] = (ev['win'] as bool) ? 'win' : 'loss';
    }
    return payload;
  }

  /// Emit one event. No network when disabled. Never throws for network reasons.
  Future<EmitResult> emit(Map<String, dynamic> ev) async {
    if (!enabled) return const EmitResult(false, reason: 'disabled');

    Map<String, dynamic> payload;
    try {
      payload = await buildPayload(ev);
      assertNoSecrets(payload);
    } catch (e) {
      return EmitResult(false, reason: 'scrubbed', error: '$e');
    }

    if (sink != null) {
      try {
        sink!(payload);
      } catch (_) {}
    }

    if (post == null) {
      return EmitResult(false, reason: 'no-transport', payload: payload);
    }

    try {
      await post!(collectorUrl, {'content-type': 'application/json'},
          jsonEncode(payload));
      return EmitResult(true, payload: payload);
    } catch (e) {
      return EmitResult(false, reason: 'network', error: '$e', payload: payload);
    }
  }
}
