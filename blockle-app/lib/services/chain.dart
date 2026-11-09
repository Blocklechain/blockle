import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Read/broadcast client for live BLOCK chain data via the public API.
/// Best-effort: on any failure returns null so the UI can show "—".
class Chain {
  Chain({String? apiBase, http.Client? client})
      : apiBase = apiBase ?? defaultApi,
        _http = client ?? http.Client();

  static const defaultApi = 'https://blockle.org/api/explorer';
  static const coin = 100000000; // base units per BLOCK
  String apiBase;
  final http.Client _http;

  /// `https://blockle.org/api` — the non-explorer API root (dex, token, submit).
  String get _apiRoot => apiBase.replaceFirst(RegExp(r'/explorer$'), '');

  /// The node's submit RPC (and the WASM builder) spell a txid as the raw hash
  /// bytes; the explorer displays and looks up the byte-REVERSED form. Same tx,
  /// two spellings — this converts one to the other (64-hex only; anything
  /// else is returned unchanged).
  static String flipTxid(String txid) {
    final t = txid.trim().toLowerCase();
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(t)) return txid;
    final b = StringBuffer();
    for (var i = t.length - 2; i >= 0; i -= 2) {
      b.write(t.substring(i, i + 2));
    }
    return b.toString();
  }

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
      final r = await _http
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
    try {
      final r = await _http
          .get(Uri.parse('$_apiRoot/dex/pools'), headers: {'accept': 'application/json'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return [];
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      return ((j['pools'] ?? []) as List)
          .whereType<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Read a BLOCK-20 token by contract id (hex) through the node's read-only
  /// `tokeninfo` view. With [holder] (bech32 `block1…` or 32-byte hex) the
  /// result also carries that address's `balance`. Mirrors the web wallet's
  /// `Chain.token(contractId, holder)`. Returns null when unreachable or when
  /// the id is not a token.
  Future<Map<String, dynamic>?> token(String contractId, {String? holder}) async {
    if (contractId.isEmpty) return null;
    final q = (holder != null && holder.isNotEmpty)
        ? '?holder=${Uri.encodeQueryComponent(holder)}'
        : '';
    try {
      final r = await _http
          .get(Uri.parse('$_apiRoot/token/${Uri.encodeComponent(contractId)}$q'),
              headers: {'accept': 'application/json'})
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(r.body);
      if (j is! Map) return null;
      final t = j['result'] is Map ? j['result'] as Map : j;
      if (t['isToken'] == null && t['name'] == null && t['symbol'] == null) return null;
      return t.cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  /// BLOCK-20 token holdings for an address — the balanceOf-equivalent read
  /// the wallet uses to auto-detect tokens it received (e.g. after a DEX buy).
  ///
  /// Parity with the web wallet's `discoverTokens`: (1) a direct per-address
  /// holdings endpoint when the node exposes one; otherwise (2) enumerate every
  /// BLOCK-20 contract that has an AMM pool (plus [extraContracts], e.g. the
  /// user's imported list) and read the holder's balance per token via
  /// `/api/token/<id>?holder=`. Only non-zero holdings are returned. Each entry
  /// carries `{id, contract, symbol, name, decimals, balance}`; `balance` is a
  /// base-unit integer. Best-effort: `[]` when unreachable.
  Future<List<Map<String, dynamic>>> addressTokens(String address,
      {Iterable<String> extraContracts = const []}) async {
    if (address.isEmpty) return const [];

    // 1) direct holdings read, if the node has one (today it does not).
    final a = await _get('/address/$address/tokens');
    final direct = a == null ? null : (a['tokens'] ?? a['holdings'] ?? a['balances']);
    if (direct is List) {
      final out = <Map<String, dynamic>>[];
      for (final t in direct.whereType<Map>()) {
        final id = (t['contract'] ?? t['contractId'] ?? t['id'] ?? t['token'] ?? '').toString();
        final bal = _balanceOf(t['balance'] ?? t['holderBalance']);
        if (id.isEmpty || bal <= BigInt.zero) continue;
        out.add(_holding(id, t, bal));
      }
      if (out.isNotEmpty) return out;
    }

    // 2) enumerate pool tokens (+ extras) and read the holder's balance each.
    final ids = <String>{};
    for (final p in await pools()) {
      final id = (p['token'] ?? p['contract'] ?? p['contractId'] ?? '').toString();
      if (id.isNotEmpty) ids.add(id);
    }
    for (final e in extraContracts) {
      if (e.isNotEmpty) ids.add(e);
    }
    final out = <Map<String, dynamic>>[];
    await Future.wait(ids.map((id) async {
      final info = await token(id, holder: address);
      if (info == null) return;
      final bal = _balanceOf(info['holderBalance'] ?? info['balance']);
      if (bal <= BigInt.zero) return;
      out.add(_holding(id, info, bal));
    }));
    out.sort((x, y) => '${x['symbol']}'.compareTo('${y['symbol']}'));
    return out;
  }

  static BigInt _balanceOf(dynamic v) {
    if (v == null) return BigInt.zero;
    if (v is int) return BigInt.from(v);
    if (v is double) return BigInt.from(v.truncate());
    return BigInt.tryParse(v.toString()) ?? BigInt.zero;
  }

  static Map<String, dynamic> _holding(String id, Map t, BigInt bal) => {
        'id': id,
        'contract': id,
        'symbol': (t['symbol'] ?? 'TOKEN').toString(),
        'name': t['name']?.toString(),
        'decimals': (t['decimals'] as num?)?.toInt() ?? 8,
        // int when it fits (the wallet rows format `num`), else a string.
        'balance': bal.isValidInt ? bal.toInt() : bal.toString(),
      };

  /// Look up a transaction by id. Returns null when the node does not know it
  /// (never accepted, or dropped from the mempool). Otherwise a FLAT map: the
  /// explorer wraps the tx as `{block_hash, tx: {...}}` (block_hash null while
  /// it is still in the mempool), which this unwraps so callers can read
  /// `mined` (bool), `height`, `confirmations`, `block_hash`, `inputs`,
  /// `outputs`, `fee` directly. Accepts either txid spelling (see [flipTxid]):
  /// the given one is tried first, then the byte-reversed one. `txid` in the
  /// result is the explorer's (display) spelling.
  Future<Map<String, dynamic>?> tx(String txid) async {
    var t = await _get('/tx/$txid');
    var found = txid;
    if (t == null || t['error'] != null) {
      final alt = flipTxid(txid);
      if (alt == txid) return null;
      t = await _get('/tx/$alt');
      if (t == null || t['error'] != null) return null;
      found = alt;
    }
    final inner = t['tx'] is Map ? (t['tx'] as Map).cast<String, dynamic>() : t;
    final blockHash = t['block_hash'] ?? inner['block_hash'];
    final height = inner['block_height'] ?? inner['height'] ?? t['height'];
    final confs = inner['confirmations'] ?? t['confirmations'];
    return {
      ...inner,
      'txid': found,
      'block_hash': blockHash,
      'height': height,
      'confirmations': confs,
      'mined': blockHash != null || height != null,
    };
  }

  /// Broadcast a bincode-hex transaction via the submit proxy.
  Future<dynamic> submit(String rawHex) async {
    final base = apiBase.replaceFirst(RegExp(r'/api/explorer$'), '/api');
    final r = await _http.post(
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
    final res = j['result'] ?? j;
    // Normalise the accepted txid to the explorer's (display) spelling so the
    // queue, history and explorer links all agree; keep the node's under
    // `txidRpc`.
    if (res is Map && res['txid'] is String) {
      final rpc = res['txid'] as String;
      return {...res.cast<String, dynamic>(), 'txid': flipTxid(rpc), 'txidRpc': rpc};
    }
    return res;
  }
}
