// Real retailer catalogues, pulled automatically.
//
// WHY THIS EXISTS RATHER THAN MORE LINK-PASTING. A shop has to read like a
// shop: you open it, you search "headphones", and real products with real
// prices come back. Curating links one at a time cannot produce that, and no
// amount of UI polish hides an empty catalogue.
//
// WHAT IS ACTUALLY AVAILABLE, having checked rather than assumed:
//
//   Best Buy      — free, self-serve API key, read-only, ~1M products with
//                   live prices and availability. NO sales gate. This is the
//                   one that can be switched on today.
//   CJ / Awin /   — product datafeeds, thousands of merchants, real prices.
//   Impact /        Needs network signup plus per-advertiser approval; many
//   Rakuten         advertisers auto-approve. This is the path to Walmart,
//                   Target and most brand-name retail.
//   eBay          — Buy APIs are partner-only and tiered on sales history.
//   AMAZON        — CANNOT be auto-populated. PA-API is deprecated; the
//                   Creators API that replaced it requires 10 qualifying
//                   sales in a rolling 30 days before it will issue
//                   credentials, and the Operating Agreement forbids both
//                   scraping and displaying a price obtained any other way.
//                   There is no version of this adapter for Amazon until
//                   that gate is cleared. See shop/affiliate.dart.
//
// So the shop populates from the sources that permit it, and Amazon stays
// link-curated until it is allowed to be otherwise.
//
// ONE SHAPE FOR ALL OF THEM. Each retailer's JSON is different; every
// adapter's job is to turn it into Product and to drop anything it cannot
// state honestly. Parsing is pure and separate from fetching so a feed's
// quirks can be tested against a fixture rather than over a socket.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../product.dart';

/// A keyed retailer catalogue.
abstract class RetailFeed {
  /// Shown to the shopper as the source of these listings.
  String get name;

  /// False when no credential is configured. The shop must then say the
  /// source is off rather than silently returning nothing.
  bool get configured;

  /// Where to send someone to turn it on.
  String get howToEnable;

  /// Search the live catalogue. Returns empty on no match; throws only on a
  /// transport failure, which Catalog already isolates per-source.
  Future<List<Product>> search(String query, {int limit});
}

/// Shared normalising helpers, so every adapter drops bad data the same way
/// the rest of the shop does.
class FeedParse {
  /// Money to MINOR UNITS from a JSON number or numeric string.
  ///
  /// Returns null for anything it cannot read exactly. A feed that sends
  /// "call for price", an empty string, or a negative is stating that it has
  /// no price — not that the item is free.
  static int? money(dynamic v) {
    if (v == null) return null;
    final d = v is num ? v.toDouble() : double.tryParse('$v'.trim());
    if (d == null || d.isNaN || d.isInfinite || d < 0) return null;
    return (d * 100).round();
  }

  /// A was-price only when it is genuinely higher than the current one.
  ///
  /// Retail feeds routinely send regularPrice == salePrice on items that are
  /// not discounted. Passing that through would render "0% off" on half the
  /// catalogue, which trains shoppers to ignore the badge.
  static int? wasPrice(int? now, dynamic regular) {
    final was = money(regular);
    if (now == null || was == null || was <= now) return null;
    return was;
  }

  static String? str(dynamic v) {
    if (v is String) return v.trim().isEmpty ? null : v.trim();
    if (v is num) return '$v';
    return null;
  }

  /// 0-5 only. A feed using a different scale is dropped rather than
  /// rendered as nine stars.
  static double? rating(dynamic v) {
    final d = v is num ? v.toDouble() : double.tryParse('${v ?? ''}');
    if (d == null || d < 0 || d > 5) return null;
    return d;
  }

  static int? count(dynamic v) {
    final n = v is num ? v.toInt() : int.tryParse('${v ?? ''}');
    return (n == null || n < 0) ? null : n;
  }

  /// Images must be https. A feed's http URL is blocked by App Transport
  /// Security on iOS and renders as a broken box, so it is better treated as
  /// absent — ProductImage already has a placeholder.
  static String? image(dynamic v) {
    final s = str(v);
    if (s == null) return null;
    if (s.startsWith('https://')) return s;
    if (s.startsWith('http://')) return s.replaceFirst('http://', 'https://');
    return null;
  }
}

/// Where retailer API keys live.
///
/// Secure storage, because a leaked key is someone else spending your rate
/// limit and, on a paid feed, your money. Kept out of source for the same
/// reason — unlike the associate TAG, which travels in every outbound URL
/// and is deliberately shipped as a default.
class FeedSettings extends ChangeNotifier {
  FeedSettings({FlutterSecureStorage? store})
      : _store = store ?? const FlutterSecureStorage();

  static const _key = 'blockle_feed_keys_v1';
  final FlutterSecureStorage _store;

  Map<String, String> keys = const {};

  String? keyFor(String feedId) {
    final v = keys[feedId];
    return (v == null || v.trim().isEmpty) ? null : v.trim();
  }

  Future<void> load() async {
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final j = jsonDecode(raw);
      if (j is Map) {
        keys = j.map((k, v) => MapEntry('$k', '$v'));
        notifyListeners();
      }
    } catch (_) {}
  }

  Future<void> setKey(String feedId, String value) async {
    keys = {...keys, feedId: value.trim()};
    notifyListeners();
    try {
      await _store.write(key: _key, value: jsonEncode(keys));
    } catch (_) {}
  }
}
