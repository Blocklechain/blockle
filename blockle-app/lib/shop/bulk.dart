// One link, a merchant's whole catalogue.
//
// WHY THIS IS THE BEST COVERAGE WE CAN GET WITHOUT A GATEKEEPER.
//
// Every route to big-retailer product data is gated behind sales we have not
// made yet: Amazon's Creators API wants 10 qualifying sales in a rolling 30
// days, and eBay's Buy APIs are partner-only with access tiered on sales
// history. Both are chicken-and-egg.
//
// Shopify and WooCommerce are not gated at all, because the data is already
// public. Shopify serves every storefront's catalogue as read-only JSON at
// /products.json, and WooCommerce exposes the same through its Store API —
// no key, no login, and returning exactly what a visitor browsing the shop
// can already see. Between them they account for a very large share of
// independent e-commerce, which makes this the single biggest coverage win
// available today.
//
// AND IT IS THE RIGHT KIND OF DATA. These are stores whose owners submitted
// them to Blockle: the merchant pastes their shop address and gets their
// whole catalogue listed instead of adding products one at a time. That is
// an invitation, the prices are real and current, and because they are real
// the crypto-price display works — which it cannot for Amazon.
//
// THE CURRENCY TRAP, which is why this file is longer than it looks.
// Shopify's products.json gives a price as a bare string — "49.00" — with NO
// CURRENCY ANYWHERE IN IT. Importing that as dollars because the parser was
// written in English is how a Canadian merchant's catalogue goes live at the
// wrong price. Currency is fetched separately from the store, and if it
// cannot be established the import still runs but every price is dropped and
// the merchant is asked. Same rule as everywhere else here: absent beats
// wrong.

import 'dart:convert';

import 'product.dart';

/// What a store is built on, which decides where its catalogue lives.
enum StorePlatform { shopify, woocommerce, unknown }

/// The outcome of reading a storefront.
class BulkResult {
  const BulkResult({
    this.products = const [],
    this.platform = StorePlatform.unknown,
    this.error,
    this.currency,
    this.droppedPrices = 0,
  });

  final List<Product> products;
  final StorePlatform platform;
  final String? error;

  /// The currency every price in [products] is in. Null means prices were
  /// dropped rather than guessed.
  final String? currency;

  /// How many products came back priceless because the currency was unknown.
  /// Surfaced so the merchant is told, rather than discovering it later.
  final int droppedPrices;

  bool get ok => products.isNotEmpty;
}

class BulkImport {
  /// Candidate catalogue URLs for a pasted store address, best first.
  ///
  /// Both are public read-only storefront endpoints, so this tries them
  /// rather than making the merchant know what their shop runs on.
  static List<Uri> catalogUrls(String storeUrl, {int page = 1}) {
    final u = Uri.tryParse(storeUrl.trim());
    if (u == null || u.host.isEmpty) return const [];
    final root = Uri(scheme: 'https', host: u.host);
    return [
      root.replace(
          path: '/products.json',
          queryParameters: {'limit': '250', 'page': '$page'}),
      root.replace(
          path: '/wp-json/wc/store/v1/products',
          queryParameters: {'per_page': '100', 'page': '$page'}),
    ];
  }

  /// Where Shopify states the storefront's currency.
  static Uri? metaUrl(String storeUrl) {
    final u = Uri.tryParse(storeUrl.trim());
    if (u == null || u.host.isEmpty) return null;
    return Uri(scheme: 'https', host: u.host, path: '/meta.json');
  }

  /// Currency from Shopify's /meta.json, or null if it does not say.
  static String? currencyFromMeta(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map) {
        final c = j['currency'];
        if (c is String && RegExp(r'^[A-Za-z]{3}$').hasMatch(c)) {
          return c.toUpperCase();
        }
      }
    } catch (_) {}
    return null;
  }

  /// Which platform produced this body, by shape rather than by URL — a
  /// store can proxy either endpoint from an unexpected path.
  static StorePlatform detect(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['products'] is List) return StorePlatform.shopify;
      if (j is List &&
          j.isNotEmpty &&
          j.first is Map &&
          (j.first as Map).containsKey('prices')) {
        return StorePlatform.woocommerce;
      }
    } catch (_) {}
    return StorePlatform.unknown;
  }

  /// Parse a catalogue page.
  ///
  /// [currency] is required for Shopify, whose payload omits it. Pass null
  /// and every price is dropped — deliberately, see the header.
  static BulkResult parse(String body, String storeUrl, {String? currency}) {
    final platform = detect(body);
    return switch (platform) {
      StorePlatform.shopify => _shopify(body, storeUrl, currency),
      StorePlatform.woocommerce => _woo(body, storeUrl),
      StorePlatform.unknown => const BulkResult(
          error: 'That address does not expose a public product catalogue. '
              'Blockle can import automatically from Shopify and '
              'WooCommerce stores; otherwise add products one link at a '
              'time.'),
    };
  }

  // --- Shopify ---------------------------------------------------------

  static BulkResult _shopify(String body, String storeUrl, String? currency) {
    final host = _host(storeUrl);
    final List raw;
    try {
      raw = (jsonDecode(body) as Map)['products'] as List;
    } catch (_) {
      return const BulkResult(error: 'That catalogue could not be read.');
    }

    final out = <Product>[];
    var dropped = 0;
    for (final n in raw.whereType<Map>()) {
      final title = _str(n['title']);
      if (title == null) continue;
      final handle = _str(n['handle']);
      final id = _str(n['id']) ?? handle;
      if (id == null) continue;

      // Variants carry the prices. Take the cheapest AVAILABLE one, which is
      // the "from" price a shopper sees; if none is available the product is
      // out of stock and the cheapest overall is still the right figure.
      final variants = (n['variants'] as List?)?.whereType<Map>().toList() ??
          const <Map>[];
      final available = variants.any((v) => v['available'] == true);
      int? cheapest;
      for (final v in variants) {
        if (available && v['available'] != true) continue;
        final p = _money(v['price']);
        if (p == null) continue;
        if (cheapest == null || p < cheapest) cheapest = p;
      }

      // THE CURRENCY TRAP. A price with no currency is unusable, so it is
      // dropped whole rather than assumed to be dollars.
      final usable = currency != null ? cheapest : null;
      if (cheapest != null && currency == null) dropped++;

      out.add(Product(
        id: 'shop_${host}_$id',
        title: title,
        merchant: _str(n['vendor']) ?? host,
        url: handle == null
            ? 'https://$host'
            : 'https://$host/products/$handle',
        source: ProductSource.merchantLink,
        priceMinor: usable,
        currency: usable == null ? null : currency,
        description: _strip(_str(n['body_html'])),
        brand: _str(n['vendor']),
        imageUrl: _firstImage(n['images']),
        availability:
            available ? Availability.inStock : Availability.outOfStock,
        fetchedAt: DateTime.now().toUtc(),
      ));
    }
    return BulkResult(
      products: out,
      platform: StorePlatform.shopify,
      currency: currency,
      droppedPrices: dropped,
    );
  }

  // --- WooCommerce -----------------------------------------------------

  /// Woo's Store API is the better-behaved of the two: it states the
  /// currency alongside the amount, and gives the amount already in minor
  /// units with an explicit exponent.
  static BulkResult _woo(String body, String storeUrl) {
    final host = _host(storeUrl);
    final List raw;
    try {
      raw = jsonDecode(body) as List;
    } catch (_) {
      return const BulkResult(error: 'That catalogue could not be read.');
    }

    final out = <Product>[];
    String? seen;
    for (final n in raw.whereType<Map>()) {
      final title = _str(n['name']);
      final id = _str(n['id']);
      if (title == null || id == null) continue;

      final prices = n['prices'];
      int? minor;
      String? cur;
      if (prices is Map) {
        cur = _str(prices['currency_code'])?.toUpperCase();
        // currency_minor_unit is the number of decimals; Woo gives the price
        // as an integer string already scaled by it. Normalise to cents so
        // the rest of the app has one convention.
        final dec = _int(prices['currency_minor_unit']) ?? 2;
        final v = _int(prices['price']);
        if (v != null) {
          minor = dec == 2
              ? v
              : (v * _pow10(2 - dec)).round();
        }
      }
      if (cur == null) minor = null;
      seen ??= cur;

      out.add(Product(
        id: 'woo_${host}_$id',
        title: title,
        merchant: host,
        url: _str(n['permalink']) ?? 'https://$host',
        source: ProductSource.merchantLink,
        priceMinor: minor,
        currency: minor == null ? null : cur,
        description: _strip(_str(n['short_description'])) ??
            _strip(_str(n['description'])),
        imageUrl: _wooImage(n['images']),
        availability: n['is_in_stock'] == true
            ? Availability.inStock
            : n['is_in_stock'] == false
                ? Availability.outOfStock
                : Availability.unknown,
        fetchedAt: DateTime.now().toUtc(),
      ));
    }
    return BulkResult(
      products: out,
      platform: StorePlatform.woocommerce,
      currency: seen,
    );
  }

  // --- scalars ---------------------------------------------------------

  static double _pow10(int n) {
    var v = 1.0;
    for (var i = 0; i < n.abs(); i++) {
      v *= 10;
    }
    return n < 0 ? 1 / v : v;
  }

  /// Shopify prices are decimal strings like "49.00". Same refusal rule as
  /// the single-product parser: a comma is ambiguous, so it is rejected
  /// rather than read as either a decimal point or a thousands separator.
  static int? _money(dynamic v) {
    if (v == null) return null;
    if (v is num) return (v * 100).round();
    if (v is! String) return null;
    final s = v.trim();
    if (s.contains(',')) return null;
    final d = double.tryParse(s);
    if (d == null || d < 0 || d.isNaN || d.isInfinite) return null;
    return (d * 100).round();
  }

  static String? _str(dynamic v) {
    if (v is String) return v.trim().isEmpty ? null : v.trim();
    if (v is num) return v.toString();
    return null;
  }

  static int? _int(dynamic v) =>
      v is int ? v : (v is num ? v.toInt() : (v is String ? int.tryParse(v) : null));

  static String? _firstImage(dynamic images) {
    if (images is List) {
      for (final i in images) {
        if (i is Map) {
          final s = _str(i['src']);
          if (s != null) return s;
        } else if (i is String) {
          return i;
        }
      }
    }
    return null;
  }

  static String? _wooImage(dynamic images) {
    if (images is List) {
      for (final i in images) {
        if (i is Map) {
          final s = _str(i['src']) ?? _str(i['thumbnail']);
          if (s != null) return s;
        }
      }
    }
    return null;
  }

  /// Descriptions arrive as HTML. Tags are stripped rather than rendered,
  /// because a product card is not a browser and a half-parsed <script> in a
  /// description is not something to hand to a Text widget.
  static String? _strip(String? html) {
    if (html == null) return null;
    final t = html
        .replaceAll(RegExp(r'<[^>]*>'), ' ')
        .replaceAll('&nbsp;', ' ')
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return t.isEmpty ? null : t;
  }

  static String _host(String url) {
    final u = Uri.tryParse(url.trim());
    final h = u?.host ?? url;
    return h.replaceFirst('www.', '');
  }
}
