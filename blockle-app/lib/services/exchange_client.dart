// exchange_client.dart — the in-app client for exchange.blockle.org.
//
// WHAT THIS IS, AND WHAT IT IS NOT.
//
// The exchange is CUSTODIAL and it is a separate pot of money from the wallet.
// The wallet on this device holds keys; the exchange holds a balance for your
// Blockle account. Nothing here moves coins between the two by itself: to
// trade, you send coins from the wallet to the deposit address this client
// asks for, exactly as you would to any other venue. That separation is the
// product decision, not an implementation gap — a wallet that silently swept
// self-custodied coins into a custodial venue would be the single worst thing
// this app could do.
//
// This file replaces a NEUTERED stub. The in-app exchange was removed on
// 2026-11-06 ("strip the features that don't pull their weight") when it was
// thin, and the stub kept the type surface alive so bots and portfolio would
// still compile while every read returned empty. That removal left a known
// hole, recorded in its own commit message: "the exchange relay was also the
// live price oracle for the portfolio + bot marks — a replacement price source
// is still to be wired". Restoring this client closes that too.
//
// AUTHENTICATION. Public reads — markets, tickers, the order book, the trade
// tape — need no account. Everything about YOUR money (balances, orders,
// deposit addresses) is authenticated with the Blockle accounts session as a
// Bearer token, because a SameSite=Lax cookie does not ride a cross-site fetch
// from a phone. The venue has no accounts of its own.
//
// HONESTY ABOUT THE GATE. The venue publishes /status with `live`,
// `mainnetEnabled` and `legalReviewCompleted`. This client surfaces that
// verbatim rather than interpreting it, so the UI can say what is actually
// true instead of implying live trading.
import 'dart:convert';

import 'transports.dart';

/// Default origin. Overridable for tests and for a staging venue.
const String kExchangeBase = 'https://exchange.blockle.org/v1';

/// A signed challenge (kept: older callers still reference the type).
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

typedef MessageSigner = Future<({String signature, String publicKey})> Function(
    String message);

class ExchangeMarket {
  const ExchangeMarket({
    required this.id,
    required this.base,
    required this.quote,
    this.baseDecimals = 8,
    this.quoteDecimals = 8,
    this.last,
    this.bid,
    this.ask,
    this.change24h,
    this.volume24h,
    this.minBase,
  });
  final String id;
  final String base;
  final String quote;
  final int baseDecimals;
  final int quoteDecimals;

  /// Last traded price, or NULL when the market has never traded.
  ///
  /// Null is not zero. "No market yet" and "the market is at zero" are
  /// different claims and only one of them is true before the first fill; the
  /// venue is careful about this and so is the UI that reads it.
  final num? last;
  final num? bid;
  final num? ask;
  final num? change24h;
  final num? volume24h;
  final String? minBase;

  String get pair => '$base/$quote';
}

class OrderLevel {
  const OrderLevel(this.price, this.size);
  final num price;
  final num size;
}

class OrderBook {
  const OrderBook(this.bids, this.asks);
  final List<OrderLevel> bids;
  final List<OrderLevel> asks;

  bool get isEmpty => bids.isEmpty && asks.isEmpty;

  /// Mid price, or null when either side is empty — a one-sided book has no
  /// mid, and inventing one from the single side would be a made-up number.
  num? get mid =>
      (bids.isEmpty || asks.isEmpty) ? null : (bids.first.price + asks.first.price) / 2;
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
}

/// One asset's balance on the venue — three figures, not one.
class ExchangeBalance {
  const ExchangeBalance({
    required this.asset,
    required this.total,
    required this.reserved,
    required this.available,
    required this.decimals,
  });
  final String asset;
  final String total;

  /// Held against open orders. Shown beside the total because "available"
  /// alone cannot explain why a visible balance will not place an order.
  final String reserved;
  final String available;
  final int decimals;
}

/// A deposit address, or the venue's explanation of why there isn't one.
class DepositTarget {
  const DepositTarget({this.address, this.network, this.note, this.reason});
  final String? address;
  final String? network;
  final String? note;

  /// Why no address was issued. A deposit to a wrong address is unrecoverable
  /// by anyone, so the venue returns an explanation rather than a guess, and
  /// this client passes it through rather than showing a blank field.
  final String? reason;

  bool get ready => address != null && address!.isNotEmpty;
}

/// The venue's own view of whether it is open for business.
class ExchangeStatus {
  const ExchangeStatus({
    required this.live,
    required this.mainnetEnabled,
    required this.legalReviewCompleted,
    required this.network,
  });
  final bool live;
  final bool mainnetEnabled;
  final bool legalReviewCompleted;
  final String network;

  /// True only when the venue says every gate is open. The UI must not infer
  /// readiness from anything else.
  bool get tradable => live && mainnetEnabled && legalReviewCompleted;
}

class ExchangeException implements Exception {
  ExchangeException(this.message, {this.status});
  final String message;
  final int? status;
  @override
  String toString() => 'ExchangeException($status): $message';
}

class ExchangeClient {
  ExchangeClient({
    String base = kExchangeBase,
    HttpSend? send,
    String? Function()? bearer,
  })  : _base = base.endsWith('/') ? base.substring(0, base.length - 1) : base,
        _send = send ?? httpSend,
        _bearer = bearer;

  final String _base;
  final HttpSend _send;
  final String? Function()? _bearer;

  String? lastError;

  /// Whether an account session is available for the authenticated routes.
  bool get signedIn {
    final t = _bearer?.call();
    return t != null && t.isNotEmpty;
  }

  Map<String, String> _headers({bool auth = false, bool json = false}) {
    final h = <String, String>{'accept': 'application/json'};
    if (json) h['content-type'] = 'application/json';
    if (auth) {
      final t = _bearer?.call();
      if (t == null || t.isEmpty) {
        throw ExchangeException(
          'Sign in to your Blockle account to see your exchange balance.',
          status: 401,
        );
      }
      h['authorization'] = 'Bearer $t';
    }
    return h;
  }

  Future<dynamic> _req(
    String method,
    String path, {
    bool auth = false,
    Object? body,
  }) async {
    final req = HttpReq(
      method,
      '$_base$path',
      headers: _headers(auth: auth, json: body != null),
      body: body == null ? null : jsonEncode(body),
    );
    final HttpReply r;
    try {
      r = await _send(req);
    } catch (e) {
      lastError = 'the exchange is unreachable';
      throw ExchangeException('the exchange is unreachable: $e');
    }
    dynamic decoded;
    if (r.body.isNotEmpty) {
      try {
        decoded = jsonDecode(r.body);
      } catch (_) {
        // A proxy error page, or a plain-text txid. Keep the text.
        decoded = r.body;
      }
    }
    if (r.status < 200 || r.status >= 300) {
      final msg = decoded is Map && decoded['error'] != null
          ? decoded['error'].toString()
          : 'HTTP ${r.status}';
      lastError = msg;
      throw ExchangeException(msg, status: r.status);
    }
    lastError = null;
    return decoded;
  }

  // ------------------------------------------------------------ public reads

  Future<ExchangeStatus> status() async {
    final j = await _req('GET', '/status') as Map<String, dynamic>;
    return ExchangeStatus(
      live: j['live'] == true,
      mainnetEnabled: j['mainnetEnabled'] == true,
      legalReviewCompleted: j['legalReviewCompleted'] == true,
      network: (j['network'] ?? 'unknown').toString(),
    );
  }

  /// Markets merged with their tickers, so one call feeds a market list.
  Future<List<ExchangeMarket>> getMarkets() async {
    final mkts = await _req('GET', '/markets') as List<dynamic>;
    // Tickers are a nicety: a market list is still correct without prices, so
    // a ticker failure must not blank the whole screen.
    List<dynamic> ticks = const [];
    try {
      ticks = await _req('GET', '/tickers') as List<dynamic>;
    } catch (_) {}
    final byMarket = <String, Map<String, dynamic>>{
      for (final t in ticks)
        if (t is Map<String, dynamic> && t['market'] != null)
          t['market'].toString(): t,
    };
    return mkts.whereType<Map<String, dynamic>>().map((m) {
      final sym = (m['symbol'] ?? '').toString();
      final t = byMarket[sym];
      return ExchangeMarket(
        id: sym,
        base: (m['base'] ?? '').toString(),
        quote: (m['quote'] ?? '').toString(),
        baseDecimals: (m['baseDecimals'] as num?)?.toInt() ?? 8,
        quoteDecimals: (m['quoteDecimals'] as num?)?.toInt() ?? 8,
        minBase: m['minBase']?.toString(),
        last: _num(t?['last']),
        bid: _num(t?['bid']),
        ask: _num(t?['ask']),
        change24h: _num(t?['change24h']),
        volume24h: _num(t?['volume24h']),
      );
    }).toList();
  }

  Future<OrderBook?> getBook(String market) async {
    final j = await _req('GET', '/book/${Uri.encodeComponent(market)}');
    if (j is! Map<String, dynamic>) return null;
    List<OrderLevel> side(Object? raw) => (raw is List ? raw : const [])
        .whereType<Map<String, dynamic>>()
        .map((l) => OrderLevel(_num(l['price']) ?? 0, _num(l['base']) ?? 0))
        .where((l) => l.price > 0)
        .toList();
    return OrderBook(side(j['bids']), side(j['asks']));
  }

  Future<List<Map<String, dynamic>>> getTrades(String market) async {
    final j = await _req('GET', '/trades/${Uri.encodeComponent(market)}');
    return (j is List ? j : const []).whereType<Map<String, dynamic>>().toList();
  }

  // ------------------------------------------------------- the account's money

  Future<List<ExchangeBalance>> getBalances() async {
    final j = await _req('GET', '/balances', auth: true);
    return (j is List ? j : const [])
        .whereType<Map<String, dynamic>>()
        .map((b) => ExchangeBalance(
              asset: (b['asset'] ?? '').toString(),
              total: (b['total'] ?? '0').toString(),
              reserved: (b['reserved'] ?? '0').toString(),
              available: (b['available'] ?? '0').toString(),
              decimals: (b['decimals'] as num?)?.toInt() ?? 8,
            ))
        .toList();
  }

  /// Where to send coins from the wallet to trade them here.
  ///
  /// THIS IS THE ONLY BRIDGE between the two pots, and the user drives it: the
  /// app shows the address and they send to it like any other withdrawal.
  Future<DepositTarget> depositAddress(String asset, {String? network}) async {
    final q = StringBuffer('?asset=${Uri.encodeComponent(asset)}');
    if (network != null && network.isNotEmpty) {
      q.write('&network=${Uri.encodeComponent(network)}');
    }
    final j = await _req('GET', '/deposit-address$q', auth: true);
    if (j is! Map<String, dynamic>) {
      throw ExchangeException('the venue returned no deposit information');
    }
    return DepositTarget(
      address: j['address']?.toString(),
      network: j['network']?.toString(),
      note: j['note']?.toString(),
      reason: (j['reason'] ?? j['error'])?.toString(),
    );
  }

  Future<List<OpenOrder>> getOpenOrders() async {
    final j = await _req('GET', '/orders', auth: true);
    final rows = j is List ? j : (j is Map ? (j['orders'] as List? ?? const []) : const []);
    return rows.whereType<Map<String, dynamic>>().map((o) {
      return OpenOrder(
        id: (o['id'] ?? o['orderId'] ?? '').toString(),
        market: (o['market'] ?? '').toString(),
        side: (o['side'] ?? '').toString(),
        price: _num(o['price']) ?? 0,
        size: _num(o['base'] ?? o['size']) ?? 0,
        filled: _num(o['filled']),
        status: o['state']?.toString() ?? o['status']?.toString(),
      );
    }).toList();
  }

  /// Place an order. Amounts are STRINGS end to end.
  ///
  /// Never a double: a price or size that has been through a JSON number has
  /// already lost its last digits for anything above 2^53 base units, and an
  /// order is a claim on real money. The venue parses decimal strings.
  Future<Map<String, dynamic>> placeOrder({
    required String market,
    required String side,
    required String type,
    required String size,
    String? price,
  }) async {
    if (type == 'limit' && (price == null || price.isEmpty)) {
      throw ExchangeException('a limit order needs a price');
    }
    final j = await _req('POST', '/orders', auth: true, body: {
      'market': market,
      'side': side,
      'type': type,
      'base': size,
      if (price != null && price.isNotEmpty) 'price': price,
    });
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  Future<Map<String, dynamic>> cancelOrder(String orderId) async {
    final j = await _req(
      'POST',
      '/orders/${Uri.encodeComponent(orderId)}/cancel',
      auth: true,
    );
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  // --------------------------------------------------------- the price oracle

  /// Last price per market symbol, for portfolio and bot marks.
  ///
  /// This is the seam the removal left empty — marks degraded to "unpriced"
  /// rather than showing a fake number, which was right, and this fills it
  /// with a real figure. Markets that have never traded stay absent rather
  /// than reporting zero.
  Future<Map<String, num>> lastPrices() async {
    final out = <String, num>{};
    for (final m in await getMarkets()) {
      final p = m.last;
      if (p != null) out[m.id] = p;
    }
    return out;
  }

  /// Indicative quote seam kept for the agent tools.
  Future<Map<String, dynamic>> quote(
      String from, String to, String amount, Map<String, dynamic> opts) async {
    try {
      final book = await getBook('$from-$to');
      final mid = book?.mid;
      if (mid == null) return const {'amountOut': '0', 'reason': 'no two-sided book'};
      final a = num.tryParse(amount) ?? 0;
      return {'amountOut': (a * mid).toString(), 'price': mid.toString()};
    } catch (e) {
      return {'amountOut': '0', 'reason': e.toString()};
    }
  }

  static num? _num(Object? v) {
    if (v == null) return null;
    if (v is num) return v;
    return num.tryParse(v.toString());
  }
}
