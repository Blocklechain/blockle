// Turn a seller's own product page into a draft listing.
//
// THE BUSINESS-SIDE ONBOARDING. A merchant pastes a link to a product on
// their own site; we read the page and fill in as much of the listing as the
// page actually states, then hand it to them to correct. The alternative —
// a blank twelve-field form — is why small sellers never finish onboarding.
//
// WHAT THIS IS NOT
//
// It is not a scraper for other people's catalogues. It runs on a URL the
// seller submitted for their own site, which is an invitation; pointing it at
// Amazon would be reading a listing nobody offered us and would breach their
// terms. Big retailers arrive through PA-API or an affiliate feed, which is a
// different adapter with its own approval. The caller enforces that; this file
// just parses whatever HTML it is handed.
//
// HOW IT READS A PAGE, best source first:
//
//   1. JSON-LD (schema.org/Product) — a structured block the site PUBLISHED
//      for exactly this purpose. It is real JSON, so it is decoded rather
//      than pattern-matched, which is why this is the only source trusted for
//      prices.
//   2. Open Graph / meta tags — near-universal, but a title-and-image affair.
//      Price only from the standard `product:price:amount`.
//
// NOTHING IS INVENTED. A field the page does not state comes back null and
// shows up in Product.missing for the merchant to fill in. The failure this
// guards against is a parser that "helpfully" infers a price from the first
// number on the page and lists someone's product at the shipping cost.

import 'dart:convert';

import 'product.dart';

/// What came back from reading a page, including why it fell short.
class IngestResult {
  const IngestResult({this.product, this.error, this.readFrom});

  final Product? product;

  /// Plain-language reason, for the merchant, when nothing usable was found.
  final String? error;

  /// 'structured data' or 'page tags' — shown so a merchant understands why
  /// some fields are blank and whether fixing their site would help.
  final String? readFrom;

  bool get ok => product != null;
}

class Ingest {
  /// Parse `html` fetched from `url`.
  static IngestResult parse(String html, String url) {
    final host = _host(url);
    if (host == null) {
      return const IngestResult(error: 'That does not look like a web address.');
    }

    final fromLd = _fromJsonLd(html, url, host);
    if (fromLd != null) {
      return IngestResult(product: fromLd, readFrom: 'structured data');
    }
    final fromMeta = _fromMeta(html, url, host);
    if (fromMeta != null) {
      return IngestResult(product: fromMeta, readFrom: 'page tags');
    }
    return const IngestResult(
        error: 'We could not find product details on that page. Check the '
            'link opens a single product, or add the details yourself.');
  }

  // --- JSON-LD ---------------------------------------------------------

  /// Every <script type="application/ld+json"> block, decoded.
  ///
  /// Sites emit these in every shape imaginable: one object, an array, or a
  /// @graph of mixed types. All three are flattened and searched rather than
  /// assuming the first one is the product — on a real store the first block
  /// is usually Organization or BreadcrumbList.
  static Product? _fromJsonLd(String html, String url, String host) {
    final re = RegExp(
        r'<script[^>]*type\s*=\s*["\x27]application/ld\+json["\x27][^>]*>'
        r'([\s\S]*?)</script>',
        caseSensitive: false);
    for (final m in re.allMatches(html)) {
      final raw = m.group(1);
      if (raw == null) continue;
      dynamic decoded;
      try {
        decoded = jsonDecode(raw.trim());
      } catch (_) {
        continue; // A malformed block is not a reason to abandon the page.
      }
      for (final node in _flatten(decoded)) {
        if (!_isProduct(node)) continue;
        final p = _productFromLd(node, url, host);
        if (p != null) return p;
      }
    }
    return null;
  }

  /// Depth-first over objects, arrays and @graph containers.
  static Iterable<Map<String, dynamic>> _flatten(dynamic node) sync* {
    if (node is List) {
      for (final n in node) {
        yield* _flatten(n);
      }
    } else if (node is Map<String, dynamic>) {
      yield node;
      final graph = node['@graph'];
      if (graph != null) yield* _flatten(graph);
    }
  }

  static bool _isProduct(Map<String, dynamic> n) {
    final t = n['@type'];
    if (t is String) return t.toLowerCase() == 'product';
    // @type can legitimately be a list ("Product", "IndividualProduct").
    if (t is List) {
      return t.any((e) => e is String && e.toLowerCase() == 'product');
    }
    return false;
  }

  static Product? _productFromLd(
      Map<String, dynamic> n, String url, String host) {
    final title = _str(n['name']);
    if (title == null || title.isEmpty) return null;

    // offers is an object, a list, or an AggregateOffer with a low price.
    Map<String, dynamic>? offer;
    final offers = n['offers'];
    for (final o in _flatten(offers)) {
      offer = o;
      break;
    }

    int? price;
    String? currency;
    if (offer != null) {
      price = _money(offer['price'] ?? offer['lowPrice']);
      currency = _str(offer['priceCurrency'])?.toUpperCase();
    }
    // A price with no currency is unusable — $10 and ¥10 are not the same
    // listing, and guessing USD because the page is in English is how a
    // shopper gets a surprise at checkout.
    if (price == null || currency == null) {
      price = null;
      currency = null;
    }

    return Product(
      id: _id(url),
      title: title,
      merchant: _str(_brandOf(n)) ?? host,
      url: url,
      source: ProductSource.merchantLink,
      priceMinor: price,
      currency: currency,
      description: _str(n['description']),
      brand: _str(_brandOf(n)),
      imageUrl: _firstImage(n['image']),
      availability: _availability(_str(offer?['availability'])),
      rating: _rating(n['aggregateRating']),
      reviewCount: _int(_nested(n['aggregateRating'], 'reviewCount')),
      fetchedAt: DateTime.now().toUtc(),
    );
  }

  static dynamic _brandOf(Map<String, dynamic> n) {
    final b = n['brand'];
    if (b is Map) return b['name'];
    return b;
  }

  static dynamic _nested(dynamic node, String key) =>
      node is Map ? node[key] : null;

  static double? _rating(dynamic node) {
    final v = _num(_nested(node, 'ratingValue'));
    if (v == null) return null;
    // Out-of-range means the site is using a different scale; dropping it is
    // safer than rendering 9.2 stars out of 5.
    return (v < 0 || v > 5) ? null : v.toDouble();
  }

  static String? _firstImage(dynamic v) {
    for (final n in [v]) {
      if (n is String && n.startsWith('http')) return n;
      if (n is List) {
        for (final e in n) {
          if (e is String && e.startsWith('http')) return e;
          if (e is Map && e['url'] is String) return e['url'] as String;
        }
      }
      if (n is Map && n['url'] is String) return n['url'] as String;
    }
    return null;
  }

  static Availability _availability(String? s) {
    if (s == null) return Availability.unknown;
    final v = s.toLowerCase();
    if (v.contains('instock') || v.contains('in_stock')) {
      return Availability.inStock;
    }
    if (v.contains('outofstock') || v.contains('soldout')) {
      return Availability.outOfStock;
    }
    if (v.contains('preorder')) return Availability.preorder;
    return Availability.unknown;
  }

  // --- Open Graph ------------------------------------------------------

  static Product? _fromMeta(String html, String url, String host) {
    final title = _meta(html, 'og:title') ?? _title(html);
    if (title == null || title.trim().isEmpty) return null;

    final amount = _money(_meta(html, 'product:price:amount'));
    final cur = _meta(html, 'product:price:currency')?.toUpperCase();

    return Product(
      id: _id(url),
      title: title.trim(),
      merchant: _meta(html, 'og:site_name') ?? host,
      url: url,
      source: ProductSource.merchantLink,
      priceMinor: (amount != null && cur != null) ? amount : null,
      currency: (amount != null && cur != null) ? cur : null,
      description: _meta(html, 'og:description'),
      imageUrl: _meta(html, 'og:image'),
      fetchedAt: DateTime.now().toUtc(),
    );
  }

  /// Handles both attribute orders — property-then-content and the reverse —
  /// which real pages emit in roughly equal measure.
  static String? _meta(String html, String key) {
    final k = RegExp.escape(key);
    for (final re in [
      RegExp('<meta[^>]*(?:property|name)\\s*=\\s*["\\x27]$k["\\x27][^>]*'
          'content\\s*=\\s*["\\x27]([^"\\x27]*)["\\x27]',
          caseSensitive: false),
      RegExp('<meta[^>]*content\\s*=\\s*["\\x27]([^"\\x27]*)["\\x27][^>]*'
          '(?:property|name)\\s*=\\s*["\\x27]$k["\\x27]',
          caseSensitive: false),
    ]) {
      final m = re.firstMatch(html);
      final v = m?.group(1);
      if (v != null && v.trim().isNotEmpty) return _unescape(v.trim());
    }
    return null;
  }

  static String? _title(String html) {
    final m = RegExp(r'<title[^>]*>([\s\S]*?)</title>', caseSensitive: false)
        .firstMatch(html);
    final v = m?.group(1);
    return v == null ? null : _unescape(v.trim());
  }

  static String _unescape(String s) => s
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&apos;', "'");

  // --- scalars ---------------------------------------------------------

  /// Money to MINOR UNITS, strictly.
  ///
  /// Accepts "19.99", 19.99 and "USD 19.99"; REFUSES "19,99" and "1,299.00"
  /// rather than guessing whether a comma is a decimal point or a thousands
  /// separator. Reading €19,99 as 1999 cents is right in Berlin and wrong in
  /// London, and the merchant can correct a blank far more easily than a
  /// silently wrong price.
  static int? _money(dynamic v) {
    if (v == null) return null;
    if (v is num) return _fromDouble(v.toDouble());
    if (v is! String) return null;
    final s = v.trim();
    if (s.contains(',')) return null;
    final m = RegExp(r'(\d+(?:\.\d+)?)').firstMatch(s);
    if (m == null) return null;
    final d = double.tryParse(m.group(1)!);
    return d == null ? null : _fromDouble(d);
  }

  static int? _fromDouble(double d) {
    if (d.isNaN || d.isInfinite || d < 0) return null;
    return (d * 100).round();
  }

  static String? _str(dynamic v) => v is String && v.trim().isNotEmpty
      ? _unescape(v.trim())
      : (v is num ? v.toString() : null);

  static num? _num(dynamic v) =>
      v is num ? v : (v is String ? num.tryParse(v.trim()) : null);

  static int? _int(dynamic v) => _num(v)?.toInt();

  static String? _host(String url) {
    final u = Uri.tryParse(url.trim());
    if (u == null || !u.hasScheme) return null;
    if (u.scheme != 'http' && u.scheme != 'https') return null;
    return u.host.isEmpty ? null : u.host.replaceFirst('www.', '');
  }

  /// Stable id from the URL, so re-submitting the same link updates the same
  /// listing instead of creating a duplicate.
  static String _id(String url) {
    final u = Uri.tryParse(url);
    final base = u == null ? url : '${u.host}${u.path}';
    return base.hashCode.toUnsigned(32).toRadixString(16);
  }
}
