// exchange_client.dart — the Dart client for the NON-CUSTODIAL Blockle exchange
// (exchange.blockle.org). Used by the EXCHANGE screen and exposed to the AI
// agent through the ExchangeLike seam (lib/agent/tools.dart).
//
// Non-custodial sign-in: the server hands out a nonce, the wallet signs it with
// its LOCAL key (ML-DSA for BLOCK), and the signed nonce is exchanged for a
// bearer session token. No private key ever leaves the device — only the public
// key + signature are posted. The session token lives in memory only.
//
// Every read is best-effort: on any failure the method returns an empty list /
// null and records `lastError`, so the UI can render a clean "unavailable"
// state instead of throwing. Writes (sign-in, place/cancel, buy/sell) surface
// their error so the UI can show it.
//
// NOTE: the REST shapes below follow the exchange's documented conventions and
// parse defensively across a couple of common envelope shapes; if the live API
// differs on a field name the parser falls back gracefully.

import 'dart:convert';

import 'package:http/http.dart' as http;

/// A signed challenge produced locally by the wallet.
class SignedChallenge {
  const SignedChallenge({
    required this.address,
    required this.publicKey,
    required this.signature,
    required this.nonce,
  });
  final String address;
  final String publicKey;
  final String signature;
  final String nonce;
}

/// Signs an arbitrary message with the wallet's LOCAL key and returns the
/// signature + public key (hex). Injected by the host so the client never
/// touches key material directly.
typedef MessageSigner = Future<({String signature, String publicKey})> Function(
    String message);

class ExchangeMarket {
  const ExchangeMarket({
    required this.id,
    required this.base,
    required this.quote,
    this.last,
    this.change24h,
    this.volume24h,
  });
  final String id;
  final String base;
  final String quote;
  final num? last;
  final num? change24h;
  final num? volume24h;

  static ExchangeMarket fromJson(Map<String, dynamic> j) {
    final id = (j['id'] ?? j['market'] ?? j['symbol'] ?? '').toString();
    final parts = id.contains('/') ? id.split('/') : id.split('-');
    return ExchangeMarket(
      id: id,
      base: (j['base'] ?? (parts.isNotEmpty ? parts.first : '')).toString(),
      quote: (j['quote'] ??
              (parts.length > 1 ? parts[1] : 'USDC'))
          .toString(),
      last: _num(j['last'] ?? j['lastPrice'] ?? j['price']),
      change24h: _num(j['change24h'] ?? j['change'] ?? j['priceChangePercent']),
      volume24h: _num(j['volume24h'] ?? j['volume'] ?? j['quoteVolume']),
    );
  }
}

class OrderLevel {
  const OrderLevel(this.price, this.size);
  final num price;
  final num size;
  static OrderLevel fromAny(dynamic v) {
    if (v is List && v.length >= 2) {
      return OrderLevel(_num(v[0]) ?? 0, _num(v[1]) ?? 0);
    }
    if (v is Map) {
      return OrderLevel(_num(v['price']) ?? 0, _num(v['size'] ?? v['amount'] ?? v['qty']) ?? 0);
    }
    return const OrderLevel(0, 0);
  }
}

class OrderBook {
  const OrderBook(this.bids, this.asks);
  final List<OrderLevel> bids;
  final List<OrderLevel> asks;
  static OrderBook fromJson(Map<String, dynamic> j) {
    final b = (j['bids'] ?? j['buy'] ?? const []) as List;
    final a = (j['asks'] ?? j['sell'] ?? const []) as List;
    return OrderBook(
      b.map(OrderLevel.fromAny).toList(),
      a.map(OrderLevel.fromAny).toList(),
    );
  }
}

class OpenOrder {
  const OpenOrder({
    required this.id,
    required this.market,
    required this.side,
    required this.price,
    required this.size,
    this.filled,
    this.status,
  });
  final String id;
  final String market;
  final String side;
  final num price;
  final num size;
  final num? filled;
  final String? status;

  static OpenOrder fromJson(Map<String, dynamic> j) => OpenOrder(
        id: (j['id'] ?? j['orderId'] ?? '').toString(),
        market: (j['market'] ?? j['symbol'] ?? '').toString(),
        side: (j['side'] ?? '').toString(),
        price: _num(j['price']) ?? 0,
        size: _num(j['size'] ?? j['amount'] ?? j['qty']) ?? 0,
        filled: _num(j['filled'] ?? j['executed']),
        status: j['status']?.toString(),
      );
}

num? _num(dynamic v) {
  if (v == null) return null;
  if (v is num) return v;
  return num.tryParse('$v');
}

/// The non-custodial Blockle exchange client.
class ExchangeClient {
  ExchangeClient({String? baseUrl, http.Client? httpClient})
      : baseUrl = (baseUrl ?? defaultBaseUrl).replaceAll(RegExp(r'/+$'), ''),
        _http = httpClient ?? http.Client();

  static const defaultBaseUrl = 'https://exchange.blockle.org';

  final String baseUrl;
  final http.Client _http;

  String? _token;
  String? _address;
  String? lastError;

  bool get signedIn => _token != null;
  String? get address => _address;

  Map<String, String> _headers({bool json = false}) => {
        'accept': 'application/json',
        if (json) 'content-type': 'application/json',
        if (_token != null) 'authorization': 'Bearer $_token',
      };

  Future<dynamic> _get(String path) async {
    final r = await _http
        .get(Uri.parse('$baseUrl$path'), headers: _headers())
        .timeout(const Duration(seconds: 10));
    if (r.statusCode >= 400) {
      throw Exception('HTTP ${r.statusCode}');
    }
    return r.body.isEmpty ? null : jsonDecode(r.body);
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    final uri = Uri.parse('$baseUrl$path');
    final hdrs = _headers(json: body != null);
    final payload = body == null ? null : jsonEncode(body);
    final http.Response r;
    switch (method) {
      case 'POST':
        r = await _http.post(uri, headers: hdrs, body: payload);
        break;
      case 'DELETE':
        r = await _http.delete(uri, headers: hdrs, body: payload);
        break;
      default:
        throw ArgumentError('unsupported method $method');
    }
    dynamic j;
    try {
      j = r.body.isEmpty ? null : jsonDecode(r.body);
    } catch (_) {
      j = null;
    }
    if (r.statusCode >= 400) {
      final msg = j is Map ? (j['error'] ?? j['message'] ?? j['reason']) : null;
      throw Exception((msg ?? 'HTTP ${r.statusCode}').toString());
    }
    return j;
  }

  // --- auth -----------------------------------------------------------------

  /// Non-custodial sign-in: fetch a nonce, sign it locally, exchange it for a
  /// bearer token. Throws on failure (the UI shows it).
  Future<void> signIn(String address, MessageSigner signer) async {
    _address = address;
    final nonceResp = await _get('/api/auth/nonce?address=${Uri.encodeQueryComponent(address)}');
    final nonce = (nonceResp is Map
            ? (nonceResp['nonce'] ?? nonceResp['challenge'] ?? nonceResp['message'])
            : null)
        ?.toString();
    if (nonce == null || nonce.isEmpty) {
      throw Exception('exchange did not issue a sign-in challenge');
    }
    final sig = await signer(nonce);
    final verify = await _send('POST', '/api/auth/verify', {
      'address': address,
      'publicKey': sig.publicKey,
      'signature': sig.signature,
      'nonce': nonce,
    });
    final token = verify is Map
        ? (verify['token'] ?? verify['sessionToken'] ?? verify['jwt'])?.toString()
        : null;
    if (token == null || token.isEmpty) {
      throw Exception('exchange sign-in was rejected');
    }
    _token = token;
    lastError = null;
  }

  void signOut() {
    _token = null;
    _address = null;
  }

  // --- market data (best-effort; never throw into the UI) -------------------

  Future<List<ExchangeMarket>> getMarkets() async {
    try {
      final j = await _get('/api/markets');
      final list = (j is Map ? (j['markets'] ?? j['result'] ?? j['data']) : j) as List?;
      lastError = null;
      return (list ?? const [])
          .map((e) => ExchangeMarket.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (e) {
      lastError = e.toString();
      return const [];
    }
  }

  Future<OrderBook?> getBook(String market) async {
    try {
      final j = await _get('/api/book?market=${Uri.encodeQueryComponent(market)}');
      final m = (j is Map ? (j['book'] ?? j['result'] ?? j) : null) as Map?;
      lastError = null;
      return m == null ? null : OrderBook.fromJson(m.cast<String, dynamic>());
    } catch (e) {
      lastError = e.toString();
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> getTrades(String market) async {
    try {
      final j = await _get('/api/trades?market=${Uri.encodeQueryComponent(market)}');
      final list = (j is Map ? (j['trades'] ?? j['result'] ?? j['data']) : j) as List?;
      lastError = null;
      return (list ?? const []).map((e) => (e as Map).cast<String, dynamic>()).toList();
    } catch (e) {
      lastError = e.toString();
      return const [];
    }
  }

  Future<List<OpenOrder>> getOpenOrders() async {
    try {
      final j = await _get('/api/orders');
      final list = (j is Map ? (j['orders'] ?? j['result'] ?? j['data']) : j) as List?;
      lastError = null;
      return (list ?? const [])
          .map((e) => OpenOrder.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
    } catch (e) {
      lastError = e.toString();
      return const [];
    }
  }

  // --- trading (surface errors) ---------------------------------------------

  Future<Map<String, dynamic>> placeOrder({
    required String market,
    required String side, // "buy" | "sell"
    required String type, // "limit" | "market"
    required String size,
    String? price,
  }) async {
    final r = await _send('POST', '/api/orders', {
      'market': market,
      'side': side,
      'type': type,
      'size': size,
      if (price != null) 'price': price,
    });
    return (r is Map ? r.cast<String, dynamic>() : {'result': r});
  }

  Future<Map<String, dynamic>> cancelOrder(String orderId) async {
    final r = await _send('DELETE', '/api/orders/${Uri.encodeComponent(orderId)}');
    return (r is Map ? r.cast<String, dynamic>() : {'ok': true});
  }

  Future<Map<String, dynamic>> buyBlock(String usdcAmount) async {
    final r = await _send('POST', '/api/buy', {'asset': 'BLOCK', 'amount': usdcAmount});
    return (r is Map ? r.cast<String, dynamic>() : {'result': r});
  }

  Future<Map<String, dynamic>> sellBlock(String blockAmount) async {
    final r = await _send('POST', '/api/sell', {'asset': 'BLOCK', 'amount': blockAmount});
    return (r is Map ? r.cast<String, dynamic>() : {'result': r});
  }

  /// A read-only indicative quote (used by the agent's exchange.quote seam).
  Future<Map<String, dynamic>> quote(
      String from, String to, String amount, Map<String, dynamic> opts) async {
    final j = await _send('POST', '/api/quote', {
      'from': from,
      'to': to,
      'amount': amount,
      ...opts,
    });
    return (j is Map ? j.cast<String, dynamic>() : {'amountOut': '0'});
  }
}
