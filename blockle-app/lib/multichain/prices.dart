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
  PriceService({PriceGet? get, Duration ttl = const Duration(minutes: 2)})
      : _get = get ?? _httpGet,
        _ttl = ttl;

  final PriceGet _get;
  final Duration _ttl;
  final Map<String, double> _cache = {};
  final Map<String, int> _at = {}; // key -> epoch ms of last fetch

  static Future<String> _httpGet(String url) async {
    final r = await http.get(Uri.parse(url));
    if (r.statusCode >= 400) throw StateError('coingecko ${r.statusCode}');
    return r.body;
  }

  bool _fresh(String key, int now) =>
      _cache.containsKey(key) && (now - (_at[key] ?? 0)) < _ttl.inMilliseconds;

  /// USD prices (per whole unit) for [assets], keyed by [priceKey]. BLOCK-
  /// denominated assets are skipped; unresolved assets are simply absent.
  /// Best-effort: a network failure yields whatever is cached (never throws).
  Future<Map<String, double>> fetchUsd(List<AssetRef> assets, {int? nowMs}) async {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    final out = <String, double>{};

    // Partition into: stables (free), natives by id, tokens by (platform, addr).
    final idBySym = <String, String>{}; // coingecko id -> representative symbol key
    final keyById = <String, String>{}; // coingecko id -> priceKey
    final tokensByPlatform = <String, Map<String, String>>{}; // platform -> {addrLower: priceKey}

    for (final a in assets) {
      if (isBlockDenominated(asset: {
        'chain': a.chain,
        'symbol': a.symbol,
        'kind': a.kind,
        if (a.address != null) 'address': a.address,
      })) {
        continue;
      }
      final key = priceKey(a);
      final sym = a.symbol.toUpperCase();
      if (kStableSyms.contains(sym)) {
        out[key] = 1.0;
        continue;
      }
      if (_fresh(key, now)) {
        out[key] = _cache[key]!;
        continue;
      }
      final isNative = a.kind == 'native' || a.address == null || a.address!.isEmpty;
      if (isNative) {
        final id = kCoingeckoIds[sym];
        if (id != null) {
          idBySym[id] = sym;
          keyById[id] = key;
        }
      } else {
        final platform = kCoingeckoPlatforms[a.chain];
        if (platform != null) {
          (tokensByPlatform[platform] ??= {})[a.address!.toLowerCase()] = key;
        }
      }
    }

    // Natives — one batched call.
    if (idBySym.isNotEmpty) {
      try {
        final ids = idBySym.keys.join(',');
        final body = await _get(
            'https://api.coingecko.com/api/v3/simple/price?ids=$ids&vs_currencies=usd');
        final j = jsonDecode(body);
        if (j is Map) {
          j.forEach((id, v) {
            final usd = (v is Map) ? _numOf(v['usd']) : null;
            final key = keyById['$id'];
            if (usd != null && key != null) {
              out[key] = usd;
              _cache[key] = usd;
              _at[key] = now;
            }
          });
        }
      } catch (_) {/* best-effort; cached natives (if any) already in out */}
    }

    // Tokens — one batched call per platform.
    for (final entry in tokensByPlatform.entries) {
      final platform = entry.key;
      final addrs = entry.value.keys.join(',');
      try {
        final body = await _get(
            'https://api.coingecko.com/api/v3/simple/token_price/$platform?contract_addresses=$addrs&vs_currencies=usd');
        final j = jsonDecode(body);
        if (j is Map) {
          j.forEach((addr, v) {
            final usd = (v is Map) ? _numOf(v['usd']) : null;
            final key = entry.value['$addr'.toLowerCase()];
            if (usd != null && key != null) {
              out[key] = usd;
              _cache[key] = usd;
              _at[key] = now;
            }
          });
        }
      } catch (_) {/* best-effort */}
    }

    return out;
  }

  static double? _numOf(dynamic v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }
}
