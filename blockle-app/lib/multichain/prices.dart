// prices.dart — live USD spot prices for wallet assets, from CoinGecko's free,
// keyless public API. Two lookups:
//   • native coins  → /simple/price?ids=<coingecko ids>&vs_currencies=usd
//   • on-chain tokens→ /simple/token_price/<platform>?contract_addresses=<addr>
// Stablecoins pin to $1 (no network call). BLOCK and every BLOCK-20/BLOCK-20S
// are NEVER priced in USD (there is no BLOCK/USD oracle — docs rule); they are
// simply omitted from the result so the UI shows them in BLOCK only.
//
// Never fabricates: an asset with no resolvable price is absent from the map
// (callers show the holding without a $ value, never a guessed 0). Results are
// cached in-memory with a short TTL. The HTTP sender is injectable for tests.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'chains/chain_adapter.dart' show AssetRef;
import 'denomination.dart' show isBlockDenominated;

typedef PriceGet = Future<String> Function(String url);
typedef PricePost = Future<String> Function(String url, String body);

/// Symbol (upper-case) → CoinGecko coin id, for native coins.
const Map<String, String> kCoingeckoIds = {
  'ETH': 'ethereum',
  'BTC': 'bitcoin',
  'LTC': 'litecoin',
  'DOGE': 'dogecoin',
  'BCH': 'bitcoin-cash',
  'SOL': 'solana',
  'TRX': 'tron',
  'TON': 'the-open-network',
  'XRP': 'ripple',
  'XLM': 'stellar',
  'XTZ': 'tezos',
  'ADA': 'cardano',
  'BNB': 'binancecoin',
  'AVAX': 'avalanche-2',
  'POL': 'matic-network',
  'MATIC': 'matic-network',
  'HYPE': 'hyperliquid',
};

/// Wallet chain id → CoinGecko asset-platform id (for token contract pricing).
const Map<String, String> kCoingeckoPlatforms = {
  'ethereum': 'ethereum',
  'base': 'base',
  'arbitrum': 'arbitrum-one',
  'optimism': 'optimistic-ethereum',
  'polygon': 'polygon-pos',
  'bnb': 'binance-smart-chain',
  'avalanche': 'avalanche',
  'solana': 'solana',
  'tron': 'tron',
};

/// Wallet chain id → DeFiLlama chain key (for the token-by-contract fallback).
const Map<String, String> kLlamaChains = {
  'ethereum': 'ethereum',
  'base': 'base',
  'arbitrum': 'arbitrum',
  'optimism': 'optimism',
  'polygon': 'polygon',
  'bnb': 'bsc',
  'avalanche': 'avax',
  'solana': 'solana',
  'tron': 'tron',
};

/// Stablecoins pinned to $1 (mirrors the engine's `_stableUsd` set).
const Set<String> kStableSyms = {
  'USDC', 'USDT', 'DAI', 'USD', 'USDBC', 'PYUSD', 'TUSD', 'FDUSD', 'USDP',
};

/// A stable per-asset cache/lookup key.
String priceKey(AssetRef a) {
  final addr = a.address;
  if (addr != null && addr.isNotEmpty) return '${a.chain}:${addr.toLowerCase()}';
  return '${a.chain}:native:${a.symbol.toUpperCase()}';
}

class PriceService {
  PriceService({
    PriceGet? get,
    PricePost? post,
    Duration ttl = const Duration(minutes: 2),
    this.serverBase,
  })  : _get = get ?? _httpGet,
        _post = post ?? _httpPost,
        _ttl = ttl;

  final PriceGet _get;
  final PricePost _post;
  final Duration _ttl;

  /// Optional accounts-server origin (e.g. https://blockle.org). When set, the
  /// server price proxy is tried FIRST (server-side cached + rate-limit-safe);
  /// the public sources below are the client-side fallback. A single server
  /// failure latches it off for the session so we don't re-hit a dead route.
  final String? serverBase;
  bool _serverDown = false;

  final Map<String, double> _cache = {};
  final Map<String, int> _at = {}; // key -> epoch ms of last fetch

  static Future<String> _httpGet(String url) async {
    final r = await http.get(Uri.parse(url));
    if (r.statusCode >= 400) throw StateError('price http ${r.statusCode}');
    return r.body;
  }

  static Future<String> _httpPost(String url, String body) async {
    final r = await http.post(Uri.parse(url),
        headers: const {'content-type': 'application/json'}, body: body);
    if (r.statusCode >= 400) throw StateError('price http ${r.statusCode}');
    return r.body;
  }

  bool _fresh(String key, int now) =>
      _cache.containsKey(key) && (now - (_at[key] ?? 0)) < _ttl.inMilliseconds;

  /// USD prices (per whole unit) for [assets], keyed by [priceKey]. BLOCK-
  /// denominated assets are skipped; unresolved assets are simply absent.
  /// Resolves through SOURCES IN ORDER — server proxy (if configured), then
  /// CoinGecko, DeFiLlama, and Coinbase — each only queried for whatever the
  /// previous source left unresolved. Best-effort: every source is wrapped, so
  /// a failure just falls through and a total outage yields cache/stables only.
  Future<Map<String, double>> fetchUsd(List<AssetRef> assets, {int? nowMs}) async {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final out = <String, double>{};
    final pending = <AssetRef>[];

    for (final a in assets) {
      if (isBlockDenominated(asset: {
        'chain': a.chain,
        'symbol': a.symbol,
        'kind': a.kind,
        if (a.address != null) 'address': a.address,
      })) {
        continue; // BLOCK / BLOCK-20 are never USD-priced.
      }
      final key = priceKey(a);
      if (kStableSyms.contains(a.symbol.toUpperCase())) {
        out[key] = 1.0;
        continue;
      }
      if (_fresh(key, now)) {
        out[key] = _cache[key]!;
        continue;
      }
      pending.add(a);
    }
    if (pending.isEmpty) return out;

    Future<void> run(Future<Map<String, double>> Function(List<AssetRef>) src) async {
      if (pending.isEmpty) return;
      try {
        final got = await src(List<AssetRef>.from(pending));
        got.forEach((k, v) {
          if (v > 0) {
            out[k] = v;
            _cache[k] = v;
            _at[k] = now;
          }
        });
        pending.removeWhere((a) => out.containsKey(priceKey(a)));
      } catch (_) {/* fall through to the next source */}
    }

    if (serverBase != null && serverBase!.isNotEmpty && !_serverDown) {
      await run(_fromServer);
    }
    await run(_fromCoingecko);
    await run(_fromLlama);
    await run(_fromCoinbase);
    return out;
  }

  // ---- source 1: the accounts-server proxy (server-cached, rate-limit-safe) --
  Future<Map<String, double>> _fromServer(List<AssetRef> list) async {
    try {
      final body = jsonEncode({
        'assets': [
          for (final a in list)
            {
              'chain': a.chain,
              'symbol': a.symbol,
              'kind': a.kind,
              if (a.address != null) 'address': a.address,
            }
        ]
      });
      final reply = await _post('$serverBase/account/api/prices', body);
      final j = jsonDecode(reply);
      final prices = (j is Map) ? j['prices'] : null;
      final out = <String, double>{};
      if (prices is Map) {
        prices.forEach((k, v) {
          final p = _numOf(v);
          if (p != null) out['$k'] = p;
        });
      }
      return out;
    } catch (e) {
      _serverDown = true; // latch off for the session on any failure
      rethrow;
    }
  }

  // ---- source 2: CoinGecko (natives by id, tokens by platform/contract) ------
  Future<Map<String, double>> _fromCoingecko(List<AssetRef> list) async {
    final out = <String, double>{};
    final keyById = <String, String>{};
    final tokensByPlatform = <String, Map<String, String>>{};
    for (final a in list) {
      if (_isNative(a)) {
        final id = kCoingeckoIds[a.symbol.toUpperCase()];
        if (id != null) keyById[id] = priceKey(a);
      } else {
        final platform = kCoingeckoPlatforms[a.chain];
        if (platform != null) {
          (tokensByPlatform[platform] ??= {})[a.address!.toLowerCase()] = priceKey(a);
        }
      }
    }
    if (keyById.isNotEmpty) {
      final body = await _get(
          'https://api.coingecko.com/api/v3/simple/price?ids=${keyById.keys.join(',')}&vs_currencies=usd');
      final j = jsonDecode(body);
      if (j is Map) {
        j.forEach((id, v) {
          final usd = (v is Map) ? _numOf(v['usd']) : null;
          final key = keyById['$id'];
          if (usd != null && key != null) out[key] = usd;
        });
      }
    }
    for (final e in tokensByPlatform.entries) {
      final body = await _get(
          'https://api.coingecko.com/api/v3/simple/token_price/${e.key}?contract_addresses=${e.value.keys.join(',')}&vs_currencies=usd');
      final j = jsonDecode(body);
      if (j is Map) {
        j.forEach((addr, v) {
          final usd = (v is Map) ? _numOf(v['usd']) : null;
          final key = e.value['$addr'.toLowerCase()];
          if (usd != null && key != null) out[key] = usd;
        });
      }
    }
    return out;
  }

  // ---- source 3: DeFiLlama (one batched call; natives + tokens together) -----
  Future<Map<String, double>> _fromLlama(List<AssetRef> list) async {
    final byLlama = <String, String>{}; // llama coin id -> priceKey
    for (final a in list) {
      if (_isNative(a)) {
        final cg = kCoingeckoIds[a.symbol.toUpperCase()];
        if (cg != null) byLlama['coingecko:$cg'] = priceKey(a);
      } else {
        final lc = kLlamaChains[a.chain];
        if (lc != null) byLlama['$lc:${a.address}'] = priceKey(a);
      }
    }
    if (byLlama.isEmpty) return const {};
    final lcIndex = {for (final e in byLlama.entries) e.key.toLowerCase(): e.value};
    final body = await _get(
        'https://coins.llama.fi/prices/current/${byLlama.keys.join(',')}');
    final j = jsonDecode(body);
    final coins = (j is Map) ? j['coins'] : null;
    final out = <String, double>{};
    if (coins is Map) {
      coins.forEach((llamaKey, v) {
        final usd = (v is Map) ? _numOf(v['price']) : null;
        final key = byLlama['$llamaKey'] ?? lcIndex['$llamaKey'.toLowerCase()];
        if (usd != null && key != null) out[key] = usd;
      });
    }
    return out;
  }

  // ---- source 4: Coinbase spot (natives only, one call per symbol) -----------
  Future<Map<String, double>> _fromCoinbase(List<AssetRef> list) async {
    final out = <String, double>{};
    for (final a in list) {
      if (!_isNative(a)) continue;
      final sym = a.symbol.toUpperCase();
      try {
        final body =
            await _get('https://api.coinbase.com/v2/prices/$sym-USD/spot');
        final j = jsonDecode(body);
        final amt = (j is Map && j['data'] is Map) ? _numOf(j['data']['amount']) : null;
        if (amt != null) out[priceKey(a)] = amt;
      } catch (_) {/* skip this symbol */}
    }
    return out;
  }

  static bool _isNative(AssetRef a) =>
      a.kind == 'native' || a.address == null || a.address!.isEmpty;

  static double? _numOf(dynamic v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }
}
