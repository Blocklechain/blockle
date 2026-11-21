// Best Buy's catalogue — real products, live prices, today.
//
// Chosen because it is the one major retailer whose product API has NO sales
// gate: a free, self-serve, read-only key from developer.bestbuy.com gives
// about a million products with current prices, sale prices, availability
// and images. That is enough to make the shop read like a shop while the
// gated sources (Amazon's Creators API, eBay's Buy APIs, network datafeeds)
// are being applied for.
//
// MONETISATION IS SEPARATE AND IS NOT ASSUMED. The API key gives product
// DATA; it does not make the links earn. Best Buy's affiliate programme runs
// through Impact, and until that is approved these listings send traffic for
// free. `affiliateWrap` exists so links can be monetised later without
// touching the parser — and `earns` reports the truth in the meantime rather
// than letting someone assume commission is flowing.
//
// US ONLY, AND SO USD. developer.bestbuy.com serves the US catalogue, so the
// currency is known rather than guessed — which is the one thing the Shopify
// importer could not do. It is still written down explicitly here, because
// an unstated currency assumption is exactly the bug that importer had to
// guard against.

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../product.dart';
import 'retail_feed.dart';

class BestBuyFeed extends RetailFeed {
  BestBuyFeed({String? apiKey, http.Client? client, this.affiliateWrap})
      : _key = apiKey ?? '',
        _client = client ?? http.Client();

  final String _key;
  final http.Client _client;

  /// Optionally rewrites a product URL into a tracked one once an affiliate
  /// account exists. Null means links are untracked and earn nothing.
  final String Function(String url)? affiliateWrap;

  /// The Best Buy catalogue is US, so prices are USD. Stated, not assumed.
  static const String currency = 'USD';

  @override
  String get name => 'Best Buy';

  @override
  bool get configured => _key.trim().isNotEmpty;

  @override
  String get howToEnable =>
      'Get a free API key at developer.bestbuy.com and paste it in Shop → '
      'Sources. It is read-only and has no sales requirement.';

  /// True when these listings actually earn a commission.
  bool get earns => affiliateWrap != null;

  Uri searchUri(String query, {int limit = 24}) {
    // Best Buy's query grammar: ((search=a&search=b)) ANDs the terms.
    final terms = query
        .trim()
        .split(RegExp(r'\s+'))
        .where((t) => t.isNotEmpty)
        // The grammar is delimited by these, so a stray one breaks the URL.
        .map((t) => t.replaceAll(RegExp(r'[()&=,"]'), ''))
        .where((t) => t.isNotEmpty)
        .map((t) => 'search=${Uri.encodeQueryComponent(t)}')
        .join('&');

    return Uri.parse('https://api.bestbuy.com/v1/products'
        '(($terms))'
        '?apiKey=${Uri.encodeQueryComponent(_key)}'
        '&format=json'
        '&pageSize=$limit'
        '&sort=customerReviewCount.desc'
        '&show=sku,name,salePrice,regularPrice,onSale,image,url,'
        'shortDescription,manufacturer,customerReviewAverage,'
        'customerReviewCount,onlineAvailability');
  }

  /// The shop's front page: genuinely popular, in-stock, well-reviewed
  /// products.
  ///
  /// A filter plus a sort, rather than a search term, so this is a real
  /// slice of the catalogue and not a query someone picked.
  ///
  /// Sorting by review count descending already surfaces the popular items,
  /// so there is deliberately NO `customerReviewCount>500` filter: `>` is
  /// not legal in a URI path and would travel percent-encoded, which I
  /// cannot verify Best Buy decodes without a live key. The sort achieves
  /// the same ordering with nothing to get wrong.
  Uri featuredUri({int limit = 24}) => Uri.parse(
      'https://api.bestbuy.com/v1/products'
      '((onlineAvailability=true))'
      '?apiKey=${Uri.encodeQueryComponent(_key)}'
      '&format=json'
      '&pageSize=$limit'
      '&sort=customerReviewCount.desc'
      '&show=sku,name,salePrice,regularPrice,onSale,image,url,'
      'shortDescription,manufacturer,customerReviewAverage,'
      'customerReviewCount,onlineAvailability');

  @override
  Future<List<Product>> featured({int limit = 24}) async {
    if (!configured) return const [];
    final res = await _client
        .get(featuredUri(limit: limit))
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) return const [];
    return parse(res.body, affiliateWrap: affiliateWrap);
  }

  @override
  Future<List<Product>> search(String query, {int limit = 24}) async {
    if (!configured || query.trim().isEmpty) return const [];
    final res = await _client
        .get(searchUri(query, limit: limit))
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) return const [];
    return parse(res.body, affiliateWrap: affiliateWrap);
  }

  /// Pure. Everything the adapter can get wrong is in here, and is tested
  /// against a fixture rather than over the network.
  static List<Product> parse(String body,
      {String Function(String url)? affiliateWrap}) {
    final List raw;
    try {
      final j = jsonDecode(body);
      raw = (j is Map && j['products'] is List) ? j['products'] as List : const [];
    } catch (_) {
      return const [];
    }

    final out = <Product>[];
    for (final n in raw.whereType<Map>()) {
      final title = FeedParse.str(n['name']);
      final sku = FeedParse.str(n['sku']);
      final url = FeedParse.str(n['url']);
      // A listing we cannot name or send anyone to is not a listing.
      if (title == null || sku == null || url == null) continue;

      final price = FeedParse.money(n['salePrice']);

      out.add(Product(
        id: 'bby_$sku',
        title: title,
        merchant: 'Best Buy',
        url: affiliateWrap?.call(url) ?? url,
        source: ProductSource.feed,
        priceMinor: price,
        // Currency only travels with a price, never on its own.
        currency: price == null ? null : currency,
        originalPriceMinor: FeedParse.wasPrice(price, n['regularPrice']),
        description: FeedParse.str(n['shortDescription']),
        brand: FeedParse.str(n['manufacturer']),
        imageUrl: FeedParse.image(n['image']),
        availability: switch (n['onlineAvailability']) {
          true => Availability.inStock,
          false => Availability.outOfStock,
          // The field can be absent on some product types. Unknown is the
          // honest answer, not "probably available".
          _ => Availability.unknown,
        },
        rating: FeedParse.rating(n['customerReviewAverage']),
        reviewCount: FeedParse.count(n['customerReviewCount']),
        affiliateUrl: affiliateWrap?.call(url),
        fetchedAt: DateTime.now().toUtc(),
      ));
    }
    return out;
  }
}
