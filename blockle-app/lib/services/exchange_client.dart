// exchange_client.dart — NEUTERED.
//
// The in-app exchange (exchange.blockle.org) has been REMOVED from the product.
// This file no longer talks to any network and contains no exchange.blockle.org
// reference. The type surface is kept as inert stubs only so the remaining
// callers (bots/portfolio price helpers) compile and degrade gracefully: every
// read returns empty (→ holdings/marks are simply "unpriced", never a fake
// value) and every write throws. A replacement price source is wired separately.

/// A signed challenge (retained as an inert type; no sign-in flow remains).
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
    this.last,
    this.change24h,
    this.volume24h,
  });
  final String id;
  final String base;
  final String quote;
  final int baseDecimals;
  final num? last;
  final num? change24h;
  final num? volume24h;
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

/// Inert client. All reads return empty; all writes throw. No network.
class ExchangeClient {
  ExchangeClient();

  static const _removed = 'The in-app exchange has been removed.';

  String? lastError;
  bool get signedIn => false;
  String? get address => null;

  Future<void> signIn(String address, MessageSigner signer) async =>
      throw Exception(_removed);
  void signOut() {}

  Future<List<ExchangeMarket>> getMarkets() async => const [];
  Future<OrderBook?> getBook(String market) async => null;
  Future<List<Map<String, dynamic>>> getTrades(String market) async => const [];
  Future<List<OpenOrder>> getOpenOrders() async => const [];

  Future<Map<String, dynamic>> placeOrder({
    required String market,
    required String side,
    required String type,
    required String size,
    String? price,
  }) async =>
      throw Exception(_removed);

  Future<Map<String, dynamic>> cancelOrder(String orderId) async =>
      throw Exception(_removed);
  Future<Map<String, dynamic>> buyBlock(String amount) async =>
      throw Exception(_removed);
  Future<Map<String, dynamic>> sellBlock(String amount) async =>
      throw Exception(_removed);

  /// Indicative quote seam (agent tools) — no exchange, so no quote.
  Future<Map<String, dynamic>> quote(
          String from, String to, String amount, Map<String, dynamic> opts) async =>
      const {'amountOut': '0'};
}
