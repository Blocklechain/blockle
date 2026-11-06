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
    this.baseDecimals = 8,
    this.last,
    this.change24h,
    this.volume24h,
  });
  final String id;
  final String base;
  final String quote;

  /// Decimals of the BASE asset — needed to convert a human amount into the
  /// base-unit integer the relay's signed order intent requires.
  final int baseDecimals;
  final num? last;
  final num? change24h;
  final num? volume24h;

  static ExchangeMarket fromJson(Map<String, dynamic> j) {
    final id = (j['id'] ?? j['market'] ?? j['symbol'] ?? '').toString();
    final parts = id.contains('/') ? id.split('/') : id.split('-');
    // The relay returns {market, base, quote, baseAsset:{symbol,chain,decimals},
    // quoteAsset:{…}}. Pull base decimals from baseAsset when present.
    final baseAsset = j['baseAsset'];
    final dec = baseAsset is Map ? _num(baseAsset['decimals'])?.toInt() : null;
    return ExchangeMarket(
      id: id,
      base: (j['base'] ?? (parts.isNotEmpty ? parts.first : '')).toString(),
      quote: (j['quote'] ??
              (parts.length > 1 ? parts[1] : 'USDC'))
          .toString(),
      baseDecimals: dec ?? 8,
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
  ExchangeClient({String? baseUrl, http.Client? httpClient, this.chain = 'block'})
      : baseUrl = (baseUrl ?? defaultBaseUrl).replaceAll(RegExp(r'/+$'), ''),
        _http = httpClient ?? http.Client();

  static const defaultBaseUrl = 'https://exchange.blockle.org';

  final String baseUrl;
  final http.Client _http;

  /// The chain the connected wallet signs on. BLOCK (ML-DSA) is the only
  /// sign-in identity the Flutter app offers today.
  final String chain;

  String? _token;
  String? _address;
  String? lastError;

  // Set at sign-in so writes (place/cancel/buy/sell) can re-sign canonical
  // order intents with the same local key the session was opened with.
  MessageSigner? _signer;

  // market id -> base-asset decimals, filled by getMarkets(). Used to convert
  // human amounts into the base-unit integers the relay's order intent needs.
  final Map<String, int> _baseDecimals = {};

  bool get signedIn => _token != null;
  String? get address => _address;

  // --- encoding helpers -----------------------------------------------------

  /// Deterministic JSON (recursively sorted keys, no whitespace) — MUST match
  /// the relay/SDK canonical() so signature verification is byte-identical.
  static String _canonical(Object? v) => jsonEncode(_sortKeys(v));
  static Object? _sortKeys(Object? v) {
    if (v is Map) {
      final keys = v.keys.map((e) => e.toString()).toList()..sort();
      return {for (final k in keys) k: _sortKeys(v[k])};
    }
    if (v is List) return v.map(_sortKeys).toList();
    return v;
  }

  /// Human decimal string -> base-unit integer string (no float math), e.g.
  /// _toBaseUnits('1.5', 8) == '150000000'.
  static String _toBaseUnits(String human, int d) {
    var s = human.trim();
    if (s.isEmpty) return '0';
    final neg = s.startsWith('-');
    if (neg) s = s.substring(1);
    final parts = s.split('.');
    var whole = parts.isNotEmpty && parts[0].isNotEmpty ? parts[0] : '0';
    var frac = parts.length > 1 ? parts[1] : '';
    frac = (frac + '0' * d).substring(0, d);
    var combined = (whole + frac).replaceFirst(RegExp(r'^0+'), '');
    if (combined.isEmpty) combined = '0';
    return (neg ? '-' : '') + combined;
  }

  /// Base-unit integer string -> human decimal string (trailing zeros trimmed).
  static String _fromBaseUnits(String baseUnits, int d) {
    var s = baseUnits.trim();
    final neg = s.startsWith('-');
    if (neg) s = s.substring(1);
    if (d == 0) return (neg ? '-' : '') + s;
    while (s.length <= d) {
      s = '0$s';
    }
    final whole = s.substring(0, s.length - d);
    var frac = s.substring(s.length - d).replaceFirst(RegExp(r'0+$'), '');
    return (neg ? '-' : '') + whole + (frac.isEmpty ? '' : '.$frac');
  }

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
    // Relay contract: POST /auth/nonce {address, chain} -> { nonce }.
    final nonceResp = await _send('POST', '/auth/nonce', {
      'address': address,
      'chain': chain,
    });
    final nonce = (nonceResp is Map
            ? (nonceResp['nonce'] ?? nonceResp['challenge'] ?? nonceResp['message'])
            : null)
        ?.toString();
    if (nonce == null || nonce.isEmpty) {
      throw Exception('exchange did not issue a sign-in challenge');
    }
    final sig = await signer(nonce);
    // POST /auth/verify {address, chain, signature, publicKey, nonce} -> { token }.
    final verify = await _send('POST', '/auth/verify', {
      'address': address,
      'chain': chain,
      'publicKey': sig.publicKey,
      'signature': sig.signature,
      'nonce': nonce,
    });
    final token = verify is Map
        ? (verify['token'] ??
                verify['session'] ??
                verify['sessionToken'] ??
                verify['jwt'])
            ?.toString()
        : null;
    if (token == null || token.isEmpty) {
      throw Exception('exchange sign-in was rejected');
    }
    _token = token;
    _signer = signer;
    lastError = null;
  }

  void signOut() {
    _token = null;
    _address = null;
    _signer = null;
  }

  // --- market data (best-effort; never throw into the UI) -------------------

  Future<List<ExchangeMarket>> getMarkets() async {
    try {
      final j = await _get('/markets');
      final list = (j is Map ? (j['markets'] ?? j['result'] ?? j['data']) : j) as List?;
      lastError = null;
      final markets = (list ?? const [])
          .map((e) => ExchangeMarket.fromJson((e as Map).cast<String, dynamic>()))
          .toList();
      for (final m in markets) {
        _baseDecimals[m.id] = m.baseDecimals;
      }
      return markets;
    } catch (e) {
      lastError = e.toString();
      return const [];
    }
  }

  Future<OrderBook?> getBook(String market) async {
    try {
      final j = await _get('/book/${Uri.encodeComponent(market)}');
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
      final j = await _get('/trades/${Uri.encodeComponent(market)}');
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
      final j = await _get('/orders/mine');
      final list = (j is Map ? (j['orders'] ?? j['result'] ?? j['data']) : j) as List?;
      lastError = null;
      return (list ?? const []).map((e) {
        final m = (e as Map).cast<String, dynamic>();
        // The relay returns amounts in base units — show them as human values.
        final dec = _baseDecimals[(m['market'] ?? '').toString()] ?? 8;
        if (m['amount'] != null) {
          m['size'] = _fromBaseUnits(m['amount'].toString(), dec);
        }
        return OpenOrder.fromJson(m);
      }).toList();
    } catch (e) {
      lastError = e.toString();
      return const [];
    }
  }

  // --- trading (surface errors) ---------------------------------------------

  /// Place an order. The relay is non-custodial: it accepts a SIGNED order
  /// intent (never raw size/price), verifies it against the session's public
  /// key, and posts it to the book. `size` is a human base-asset amount; it is
  /// converted to the base-unit integer the intent requires.
  Future<Map<String, dynamic>> placeOrder({
    required String market,
    required String side, // "buy" | "sell"
    required String type, // "limit" | "market"
    required String size,
    String? price,
  }) async {
    if (_token == null || _signer == null || _address == null) {
      throw Exception('Sign in to place orders.');
    }
    final dec = _baseDecimals[market] ?? 8;
    final amount = _toBaseUnits(size, dec);
    if (amount == '0' || amount.startsWith('-')) {
      throw Exception('Enter an amount greater than zero.');
    }
    // Mirror the relay/SDK intent shape exactly (sorted-key canonical bytes are
    // what the maker signs and the relay re-derives to verify).
    final intent = <String, dynamic>{
      'market': market,
      'side': side,
      'type': type,
      'price': type == 'limit' ? price : null,
      'amount': amount,
      'expiry': DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600,
      'maker': _address,
      'nonce': '${DateTime.now().microsecondsSinceEpoch}',
    };
    final sig = await _signer!(_canonical(intent));
    final r = await _send('POST', '/orders', {
      'intent': intent,
      'signature': sig.signature,
    });
    return (r is Map ? r.cast<String, dynamic>() : {'result': r});
  }

  Future<Map<String, dynamic>> cancelOrder(String orderId) async {
    if (_token == null || _signer == null) {
      throw Exception('Sign in to cancel orders.');
    }
    // The relay verifies a signature over the cancel intent {action, orderId}.
    final sig = await _signer!(
        _canonical({'action': 'cancel', 'orderId': orderId}));
    final r = await _send(
        'DELETE', '/orders/${Uri.encodeComponent(orderId)}',
        {'signature': sig.signature});
    return (r is Map ? r.cast<String, dynamic>() : {'ok': true});
  }

  /// Buy BLOCK with USDC: a BLOCK/USDC market buy for `blockAmount` BLOCK.
  Future<Map<String, dynamic>> buyBlock(String blockAmount) => placeOrder(
        market: 'BLOCK/USDC',
        side: 'buy',
        type: 'market',
        size: blockAmount,
      );

  /// Sell BLOCK for USDC: a BLOCK/USDC market sell for `blockAmount` BLOCK.
  Future<Map<String, dynamic>> sellBlock(String blockAmount) => placeOrder(
        market: 'BLOCK/USDC',
        side: 'sell',
        type: 'market',
        size: blockAmount,
      );

  /// A read-only indicative quote (used by the agent's exchange.quote seam).
  /// The relay has no quote endpoint — derive one from the top of the book for
  /// the `from/to` (or inverted) market. Never throws into the agent.
  Future<Map<String, dynamic>> quote(
      String from, String to, String amount, Map<String, dynamic> opts) async {
    final amt = num.tryParse(amount) ?? 0;
    try {
      // Direct market from/to: sell `from` into the bids (best bid price).
      final direct = await getBook('$from/$to');
      if (direct != null && direct.bids.isNotEmpty) {
        final px = direct.bids.first.price;
        return {'amountOut': (amt * px).toString(), 'price': px.toString()};
      }
      // Inverted market to/from: buy `to` from the asks (best ask price).
      final inv = await getBook('$to/$from');
      if (inv != null && inv.asks.isNotEmpty) {
        final px = inv.asks.first.price;
        final out = px == 0 ? 0 : amt / px;
        return {'amountOut': out.toString(), 'price': px.toString()};
      }
    } catch (_) {/* fall through to the empty quote */}
    return {'amountOut': '0'};
  }
}
