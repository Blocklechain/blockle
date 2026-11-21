// What a listing is, once it has been normalised.
//
// Products reach this app from very different places — a merchant pasting a
// link to their own site, an affiliate feed, a retailer API — and every one of
// them describes a product differently. Everything downstream (the card, the
// product page, the crypto price, the comparison) reads THIS and nothing else.
//
// THE RULE THAT SHAPES THE WHOLE TYPE: every field that might be missing IS
// NULLABLE, and nothing is defaulted to a plausible value. A price that falls
// back to 0, a rating that defaults to 5, an "in stock" that assumes true —
// each of those is a lie the UI will render confidently. Absent must stay
// absent all the way to the screen, where it is omitted rather than guessed.

/// Where a listing came from. Shown to the user, because "the merchant told
/// us" and "we read it off their page" deserve different amounts of trust.
enum ProductSource {
  /// A business pasted a link to their own site and we read the page.
  merchantLink,

  /// A business typed or corrected the details themselves.
  merchantEdited,

  /// An affiliate network or retailer API.
  feed,

  /// A curated affiliate link — the product lives on a big retailer and the
  /// shopper is sent there to buy it.
  ///
  /// THE PRICE IS INTENTIONALLY ABSENT for these, not missing. Amazon's
  /// Operating Agreement permits showing a price only when Amazon serves the
  /// link displaying it or it came from the Creators API; with neither, a
  /// rendered price would breach it. So `missing` must not nag about a price
  /// here and `listable` must not require one. See shop/affiliate.dart.
  affiliateLink,
}

extension ProductSourceLabel on ProductSource {
  String get label => switch (this) {
        ProductSource.merchantLink => 'read from the seller’s page',
        ProductSource.merchantEdited => 'provided by the seller',
        ProductSource.feed => 'from a retailer feed',
        ProductSource.affiliateLink => 'sold by the retailer',
      };
}

/// Stock state. `unknown` is a real answer and the commonest one — most pages
/// do not say, and claiming "In stock" because nothing said otherwise is how
/// a shopper ends up at a sold-out checkout.
enum Availability { inStock, outOfStock, preorder, unknown }

class Product {
  const Product({
    required this.id,
    required this.title,
    required this.merchant,
    required this.url,
    required this.source,
    this.priceMinor,
    this.currency,
    this.originalPriceMinor,
    this.description,
    this.brand,
    this.imageUrl,
    this.availability = Availability.unknown,
    this.rating,
    this.reviewCount,
    this.affiliateUrl,
    this.fetchedAt,
  });

  final String id;
  final String title;
  final String merchant;

  /// The page a human can open to buy it. Always present — a listing we
  /// cannot send anyone to is not a listing.
  final String url;

  final ProductSource source;

  /// MINOR UNITS (cents), not a double. Money in floating point accumulates
  /// error the moment it is summed, and a shopping app sums constantly.
  final int? priceMinor;
  final String? currency;

  /// Was-price, only when the page actually stated one. Never derived from a
  /// "discount" claim, which is how fake sale prices get manufactured.
  final int? originalPriceMinor;

  final String? description;
  final String? brand;
  final String? imageUrl;
  final Availability availability;

  /// 0-5. Only when sourced; never a placeholder.
  final double? rating;
  final int? reviewCount;

  final String? affiliateUrl;
  final DateTime? fetchedAt;

  bool get hasPrice => priceMinor != null && currency != null;

  /// True when this listing is not allowed to show a price here, as opposed
  /// to simply not having one yet. Drives the difference between "Price not
  /// listed" (a gap the seller should fill) and "See price on Amazon" (the
  /// correct, permanent state for a curated affiliate link).
  bool get priceLivesAtRetailer => source == ProductSource.affiliateLink;

  double? get price => priceMinor == null ? null : priceMinor! / 100.0;

  double? get originalPrice =>
      originalPriceMinor == null ? null : originalPriceMinor! / 100.0;

  /// Only a real discount: both prices present AND the original is higher.
  /// A "was" below the current price is bad data, not a negative discount.
  int? get discountPercent {
    final p = priceMinor, o = originalPriceMinor;
    if (p == null || o == null || o <= p || o <= 0) return null;
    return (((o - p) / o) * 100).round();
  }

  /// What a merchant still needs to fill in before this can be listed.
  /// Drives the onboarding form rather than a wall of empty fields.
  List<String> get missing {
    final out = <String>[];
    if (title.trim().isEmpty) out.add('title');
    // Not asked for when the retailer is the only place it may be shown.
    if (!hasPrice && !priceLivesAtRetailer) out.add('price');
    if (imageUrl == null) out.add('image');
    if (description == null || description!.trim().isEmpty) {
      out.add('description');
    }
    return out;
  }

  bool get listable => missing.isEmpty;

  Product copyWith({
    String? title,
    String? merchant,
    int? priceMinor,
    String? currency,
    int? originalPriceMinor,
    String? description,
    String? brand,
    String? imageUrl,
    Availability? availability,
    ProductSource? source,
  }) =>
      Product(
        id: id,
        title: title ?? this.title,
        merchant: merchant ?? this.merchant,
        url: url,
        source: source ?? this.source,
        priceMinor: priceMinor ?? this.priceMinor,
        currency: currency ?? this.currency,
        originalPriceMinor: originalPriceMinor ?? this.originalPriceMinor,
        description: description ?? this.description,
        brand: brand ?? this.brand,
        imageUrl: imageUrl ?? this.imageUrl,
        availability: availability ?? this.availability,
        rating: rating,
        reviewCount: reviewCount,
        affiliateUrl: affiliateUrl,
        fetchedAt: fetchedAt,
      );

  /// Round-trips through storage WITHOUT inventing defaults.
  ///
  /// The temptation in a fromJson is `json['price'] ?? 0` to avoid a null
  /// check downstream. That would resurrect a listing whose price failed to
  /// persist as a free product. Everything optional stays nullable here, and
  /// a stored field of the wrong type reads as absent rather than throwing —
  /// one corrupt row must not make a seller's whole catalogue unloadable.
  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'merchant': merchant,
        'url': url,
        'source': source.name,
        if (priceMinor != null) 'priceMinor': priceMinor,
        if (currency != null) 'currency': currency,
        if (originalPriceMinor != null) 'originalPriceMinor': originalPriceMinor,
        if (description != null) 'description': description,
        if (brand != null) 'brand': brand,
        if (imageUrl != null) 'imageUrl': imageUrl,
        'availability': availability.name,
        if (rating != null) 'rating': rating,
        if (reviewCount != null) 'reviewCount': reviewCount,
        if (affiliateUrl != null) 'affiliateUrl': affiliateUrl,
        if (fetchedAt != null) 'fetchedAt': fetchedAt!.toIso8601String(),
      };

  static Product fromJson(Map<String, dynamic> j) => Product(
        id: _s(j['id']) ?? '',
        title: _s(j['title']) ?? '',
        merchant: _s(j['merchant']) ?? '',
        url: _s(j['url']) ?? '',
        source: ProductSource.values.firstWhere(
            (e) => e.name == j['source'],
            orElse: () => ProductSource.merchantEdited),
        priceMinor: _i(j['priceMinor']),
        currency: _s(j['currency']),
        originalPriceMinor: _i(j['originalPriceMinor']),
        description: _s(j['description']),
        brand: _s(j['brand']),
        imageUrl: _s(j['imageUrl']),
        availability: Availability.values.firstWhere(
            (e) => e.name == j['availability'],
            orElse: () => Availability.unknown),
        rating: _d(j['rating']),
        reviewCount: _i(j['reviewCount']),
        affiliateUrl: _s(j['affiliateUrl']),
        fetchedAt:
            j['fetchedAt'] is String ? DateTime.tryParse(j['fetchedAt']) : null,
      );

  static String? _s(dynamic v) => v is String && v.isNotEmpty ? v : null;
  static int? _i(dynamic v) => v is int ? v : (v is num ? v.toInt() : null);
  static double? _d(dynamic v) => v is num ? v.toDouble() : null;
}

/// A fiat price expressed in a crypto asset, for display only.
///
/// THIS IS AN ESTIMATE AND THE TYPE SAYS SO. The retailer charges in fiat and
/// the rate moves between looking and paying; a shopper who believes they
/// locked 0.0043 BTC and is charged a different amount has been misled by the
/// UI, not by the market. Every string this produces is prefixed so it cannot
/// be mistaken for a quote.
class CryptoPrice {
  const CryptoPrice(this.asset, this.amount, {required this.rateUsd});

  final String asset;
  final double amount;

  /// USD per unit of `asset` at the moment this was built.
  final double rateUsd;

  /// Null when the rate is unknown — a price of "0.0000 BTC" because no rate
  /// came back is worse than showing nothing.
  static CryptoPrice? from({
    required double usd,
    required String asset,
    required double rateUsd,
  }) {
    if (usd <= 0 || rateUsd <= 0) return null;
    return CryptoPrice(asset, usd / rateUsd, rateUsd: rateUsd);
  }

  /// Significant digits scaled to the asset's value: 0.0043 BTC needs four
  /// decimals to mean anything, 430000 BLOCK needs none.
  String get amountText {
    if (amount >= 1000) return amount.toStringAsFixed(0);
    if (amount >= 1) return amount.toStringAsFixed(2);
    if (amount >= 0.01) return amount.toStringAsFixed(4);
    return amount.toStringAsFixed(6);
  }

  /// Always carries the approximation mark. There is no un-hedged form of
  /// this string anywhere in the app, on purpose.
  String get display => '≈$amountText $asset';
}
