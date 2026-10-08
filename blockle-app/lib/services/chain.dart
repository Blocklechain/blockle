import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Read/broadcast client for live BLOCK chain data via the public API.
/// Best-effort: on any failure returns null so the UI can show "—".
class Chain {
  Chain({String? apiBase}) : apiBase = apiBase ?? defaultApi;

  static const defaultApi = 'https://blockle.org/api/explorer';
  static const coin = 100000000; // base units per BLOCK
  String apiBase;

  static String fmt(num? base, {int maxFrac = 8}) {
    if (base == null) return '—';
    final v = base / coin;
    var s = v.toStringAsFixed(maxFrac);
    if (s.contains('.')) {
      s = s.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
    }
    return s;
  }

  Future<Map<String, dynamic>?> _get(String path) async {
    try {
      final r = await http
          .get(Uri.parse(apiBase + path), headers: {'accept': 'application/json'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      return jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>?> stats() async {
    final s = await _get('/stats');
    if (s == null) return null;
    return {'height': s['height'], 'supply': s['supply'], 'ticker': s['ticker'] ?? 'BLOCK'};
  }

  Future<Map<String, dynamic>?> account(String? address) async {
    if (address == null || address.isEmpty) return null;
    final a = await _get('/address/$address');
    if (a == null) return null;
    final bal = a['balance'] ?? a['confirmed'] ?? a['final_balance'] ?? 0;
    return {
      'balance': bal,
      'balanceFmt': fmt(bal is num ? bal : num.tryParse('$bal')),
      'received': a['total_received'],
      'sent': a['total_sent'],
      'txCount': a['tx_count'] ?? (a['history'] is List ? (a['history'] as List).length : null),
      'txs': a['history'] ?? [],
    };
  }

  /// Spendable (mature) UTXOs for building a transfer.
  Future<Map<String, dynamic>?> utxos(String address) async {
    final u = await _get('/utxos/$address');
    if (u == null) return null;
    return {'utxos': u['utxos'] ?? [], 'spendable': u['spendable'] ?? 0};
  }

  /// Native AMM pools (DEX). Returns the pool list, or [] on failure.
  Future<List<Map<String, dynamic>>> pools() async {
    final base = apiBase.replaceFirst(RegExp(r'/explorer$'), '');
    try {
      final r = await http
          .get(Uri.parse('$base/dex/pools'), headers: {'accept': 'application/json'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return ((j['pools'] ?? []) as List).cast<Map<String, dynamic>>();
    } catch (_) {
      return [];
    }
  }

  /// Look up a transaction by id. Returns its JSON (with `confirmations`/
  /// `height` once mined) or null if not found / still unconfirmed.
  Future<Map<String, dynamic>?> tx(String txid) async {
    final t = await _get('/tx/$txid');
    if (t == null || t['error'] != null) return null;
    return t;
  }

  /// Broadcast a bincode-hex transaction via the submit proxy.
  Future<dynamic> submit(String rawHex) async {
    final base = apiBase.replaceFirst(RegExp(r'/api/explorer$'), '/api');
    final r = await http.post(
      Uri.parse('$base/submit'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'raw': rawHex}),
    );
    Map<String, dynamic> j = {};
    try {
      j = jsonDecode(r.body) as Map<String, dynamic>;
    } catch (_) {}
    if (r.statusCode >= 400 || j['error'] != null) {
      final e = j['error'];
      final msg = e is Map ? (e['message'] ?? e.toString()) : (e ?? 'submit failed');
      throw Exception(msg.toString());
    }
    return j['result'] ?? j;
  }
}
