// Listing Amazon products without an Amazon API.
//
// THE SITUATION, as of this being written.
//
// PA-API is deprecated — Amazon's own Creators API docs carry a PA-API 5
// deprecation notice — so it is not something to build towards. Its
// successor, the Creators API, requires "at least 10 qualifying sales within
// the past 30 days", on a ROLLING window, per marketplace. That is not a
// paperwork delay: it is a chicken-and-egg, because the data that helps you
// make sales is gated behind already having made them. And because the window
// rolls, access that is granted can pause again at any time.
//
// So this is NOT written as a stopgap until the API arrives. It is written so
// that having no API is a normal, permanently-supported state.
//
// WHAT THE OPERATING AGREEMENT ALLOWS, which decides the whole design:
//
//   "Your site may only show prices and availability if either Amazon serves
//    the link in which that price and availability data are displayed, or you
//    obtain product pricing and availability data via Creators API or PA API"
//
// We have neither. Therefore BLOCKLE MUST NOT RENDER AN AMAZON PRICE. Not a
// cached one, not an approximate one, and not a crypto conversion of one —
// a converted price is still a displayed price. This is enforced structurally
// below rather than left to whoever writes the next screen: an affiliate
// listing is constructed without a price field and the builder refuses to
// accept one.
//
// Affiliate LINKS need no API at all. So a curated storefront of Amazon links
// is fully compliant today, earns commission today, and is the only thing
// that can generate the sales that unlock the Creators API. When it does
// unlock, prices fill in and these same listings upgrade in place — and if
// access later pauses, they degrade back to link-only rather than showing a
// stale price.
//
// WHAT IS DELIBERATELY NOT DONE HERE: no fetching of Amazon product pages.
// The agreement prohibits scraping and data mining, and the price rule above
// exists precisely to stop the workaround. The one network call this file
// permits is following a redirect on a short link the user pasted, which
// resolves WHICH product they meant and reads no page content.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'product.dart';

/// An Amazon storefront. Tags are per-marketplace — a .com tag earns nothing
/// on .co.uk, and sales on one do not count towards the other's API gate.
class Marketplace {
  const Marketplace(this.host, this.label);

  final String host;
  final String label;

  static const all = <Marketplace>[
    Marketplace('amazon.com', 'Amazon US'),
    Marketplace('amazon.co.uk', 'Amazon UK'),
    Marketplace('amazon.ca', 'Amazon Canada'),
    Marketplace('amazon.de', 'Amazon Germany'),
    Marketplace('amazon.fr', 'Amazon France'),
    Marketplace('amazon.it', 'Amazon Italy'),
    Marketplace('amazon.es', 'Amazon Spain'),
    Marketplace('amazon.nl', 'Amazon Netherlands'),
    Marketplace('amazon.se', 'Amazon Sweden'),
    Marketplace('amazon.pl', 'Amazon Poland'),
    Marketplace('amazon.com.au', 'Amazon Australia'),
    Marketplace('amazon.co.jp', 'Amazon Japan'),
    Marketplace('amazon.in', 'Amazon India'),
    Marketplace('amazon.com.mx', 'Amazon Mexico'),
    Marketplace('amazon.com.br', 'Amazon Brazil'),
    Marketplace('amazon.ae', 'Amazon UAE'),
    Marketplace('amazon.sg', 'Amazon Singapore'),
  ];

  /// Match on the registrable domain, so www. and smile. and regional
  /// subdomains all resolve to the same storefront.
  static Marketplace? forHost(String host) {
    final h = host.toLowerCase();
    // Longest first: amazon.com.au must win over amazon.com.
    final sorted = [...all]..sort((a, b) => b.host.length - a.host.length);
    for (final m in sorted) {
      if (h == m.host || h.endsWith('.${m.host}')) return m;
    }
    return null;
  }

  /// Short-link hosts Amazon itself issues. These carry no ASIN; they have to
  /// be followed to find out which product they mean.
  static const shortHosts = ['amzn.to', 'a.co', 'amzn.eu', 'amzn.asia'];

  static bool isShortLink(String host) =>
      shortHosts.contains(host.toLowerCase().replaceFirst('www.', ''));
}

/// A product identified on a marketplace.
class AffiliateRef {
  const AffiliateRef(this.asin, this.marketplace);

  final String asin;
  final Marketplace marketplace;

  /// The canonical product URL carrying [tag].
  ///
  /// Built from scratch rather than by editing the pasted URL, which strips
  /// whatever tracking, session ids, or SOMEONE ELSE'S AFFILIATE TAG came
  /// with it. Shipping a competitor's tag would hand them the commission;
  /// shipping a stale session id is a privacy leak.
  String urlWith(String? tag) {
    final base = 'https://www.${marketplace.host}/dp/$asin';
    if (tag == null || tag.trim().isEmpty) return base;
    return '$base?tag=${Uri.encodeQueryComponent(tag.trim())}';
  }
}

class Affiliate {
  /// Pull the ASIN out of any of the URL shapes Amazon actually serves.
  ///
  /// Returns null rather than guessing. A wrong ASIN is a listing that sends
  /// a shopper to the wrong product, which is worse than refusing the paste.
  static AffiliateRef? parse(String url) {
    final u = Uri.tryParse(url.trim());
    if (u == null || !u.hasScheme) return null;
    if (u.scheme != 'http' && u.scheme != 'https') return null;

    final market = Marketplace.forHost(u.host);
    if (market == null) return null;

    final path = u.path;
    for (final re in [
      RegExp(r'/dp/(?:product/)?([A-Z0-9]{10})(?:[/?]|$)'),
      RegExp(r'/gp/product/(?:glance/)?([A-Z0-9]{10})(?:[/?]|$)'),
      RegExp(r'/gp/aw/d/([A-Z0-9]{10})(?:[/?]|$)'),
      RegExp(r'/exec/obidos/ASIN/([A-Z0-9]{10})(?:[/?]|$)'),
      RegExp(r'/product/([A-Z0-9]{10})(?:[/?]|$)'),
      RegExp(r'/ASIN/([A-Z0-9]{10})(?:[/?]|$)'),
    ]) {
      final m = re.firstMatch(path);
      if (m != null) return AffiliateRef(m.group(1)!, market);
    }

    // Some links carry it as a parameter instead.
    final q = u.queryParameters['asin'] ?? u.queryParameters['ASIN'];
    if (q != null && RegExp(r'^[A-Z0-9]{10}$').hasMatch(q.toUpperCase())) {
      return AffiliateRef(q.toUpperCase(), market);
    }
    return null;
  }

  /// Does this need resolving before it can be parsed?
  static bool needsResolving(String url) {
    final u = Uri.tryParse(url.trim());
    return u != null && Marketplace.isShortLink(u.host);
  }

  /// Turn a ref into a listing.
  ///
  /// NOTE THE ABSENT PRICE, and that there is no parameter to supply one.
  /// Without the Creators API we may not display an Amazon price, and a
  /// builder that merely *defaulted* price to null would be one hopeful
  /// patch away from displaying one. The title and image come from the
  /// curator, because reading them off Amazon's page would be the scraping
  /// the agreement prohibits.
  static Product listing({
    required AffiliateRef ref,
    required String title,
    required String? tag,
    String? description,
    String? imageUrl,
  }) =>
      Product(
        // Scoped by marketplace: the same ASIN on .com and .co.uk are two
        // listings with two tags and two commissions.
        id: 'amz_${ref.marketplace.host}_${ref.asin}',
        title: title,
        merchant: ref.marketplace.label,
        url: ref.urlWith(tag),
        source: ProductSource.affiliateLink,
        description: description,
        imageUrl: imageUrl,
        affiliateUrl: ref.urlWith(tag),
      );
}

/// Blockle's own associate tags, shipped as defaults.
///
/// NOT A SECRET — an associate tag travels in the query string of every
/// outbound link and is visible to anyone who looks at one. It belongs in the
/// source so that a fresh install earns commission on its first listing,
/// rather than on whenever someone remembers to open a settings screen. A tag
/// added later only applies to links built after it, which is exactly the
/// kind of revenue leak nobody notices: untagged links work perfectly for the
/// shopper.
const Map<String, String> kDefaultAssociateTags = {
  'amazon.com': 'blockle-20',
};

/// The user's affiliate tags, one per marketplace.
class AffiliateSettings extends ChangeNotifier {
  AffiliateSettings({FlutterSecureStorage? store})
      : _store = store ?? const FlutterSecureStorage();

  static const _key = 'blockle_affiliate_tags_v1';
  final FlutterSecureStorage _store;

  /// marketplace host -> associate tag.
  Map<String, String> tags = const {};

  /// Stored tag if there is one, otherwise Blockle's shipped default.
  String? tagFor(Marketplace m) {
    final t = tags[m.host] ?? kDefaultAssociateTags[m.host];
    return (t == null || t.trim().isEmpty) ? null : t.trim();
  }

  /// Marketplaces with no tag from either source — these earn nothing, so
  /// the UI prompts for them before a curator builds a catalogue there.
  List<Marketplace> get unconfigured =>
      Marketplace.all.where((m) => tagFor(m) == null).toList();

  /// True when at least one marketplace can earn. A listing built with no tag
  /// still works for the shopper but earns nothing, so the UI warns rather
  /// than letting someone quietly build an unpaid catalogue.
  bool get anyConfigured => Marketplace.all.any((m) => tagFor(m) != null);

  Future<void> load() async {
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final j = jsonDecode(raw);
      if (j is Map) {
        tags = j.map((k, v) => MapEntry('$k', '$v'));
        notifyListeners();
      }
    } catch (_) {}
  }

  Future<void> setTag(Marketplace m, String tag) async {
    tags = {...tags, m.host: tag.trim()};
    notifyListeners();
    try {
      await _store.write(key: _key, value: jsonEncode(tags));
    } catch (_) {}
  }
}

/// The curated retailer listings.
class AffiliateStore extends ChangeNotifier {
  AffiliateStore({
    FlutterSecureStorage? store,
    http.Client? client,
    AffiliateSettings? settings,
  })  : _store = store ?? const FlutterSecureStorage(),
        _client = client ?? http.Client(),
        settings = settings ?? AffiliateSettings();

  static const _key = 'blockle_affiliate_listings_v1';
  final FlutterSecureStorage _store;
  final http.Client _client;
  final AffiliateSettings settings;

  final List<Product> listings = [];

  Future<void> load() async {
    await settings.load();
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final list = jsonDecode(raw);
      if (list is! List) return;
      listings
        ..clear()
        ..addAll(list.whereType<Map<String, dynamic>>().map(Product.fromJson));
      notifyListeners();
    } catch (_) {}
  }

  Future<void> _persist() async {
    try {
      await _store.write(
          key: _key,
          value: jsonEncode(listings.map((p) => p.toJson()).toList()));
    } catch (_) {}
  }

  /// Work out which product a pasted link refers to.
  ///
  /// For a normal product URL this is pure string work. For one of Amazon's
  /// own short links it has to be followed, because the ASIN simply is not in
  /// the URL. That request reads the redirect chain and NOTHING ELSE — the
  /// response body is never looked at, which is the line between resolving a
  /// link someone handed us and mining Amazon's catalogue.
  Future<({AffiliateRef? ref, String? error})> resolve(String url) async {
    final direct = Affiliate.parse(url);
    if (direct != null) return (ref: direct, error: null);

    if (!Affiliate.needsResolving(url)) {
      return (
        ref: null,
        error: 'That is not an Amazon product link. Open the product and '
            'copy the address from the address bar.'
      );
    }

    try {
      final res = await _client
          .get(Uri.parse(url.trim()))
          .timeout(const Duration(seconds: 10));
      // `http` follows redirects by default, so the final destination is on
      // the request of the last response.
      final finalUrl = res.request?.url.toString() ?? '';
      final ref = Affiliate.parse(finalUrl);
      if (ref == null) {
        return (
          ref: null,
          error: 'That short link did not lead to a single product page.'
        );
      }
      return (ref: ref, error: null);
    } catch (_) {
      return (
        ref: null,
        error: 'Could not follow that short link. Paste the full product '
            'address instead.'
      );
    }
  }

  /// Save a curated listing.
  ///
  /// The tag is applied HERE, from settings, rather than being trusted from
  /// the pasted URL — see AffiliateRef.urlWith.
  Future<Product> add({
    required AffiliateRef ref,
    required String title,
    String? description,
    String? imageUrl,
  }) async {
    final p = Affiliate.listing(
      ref: ref,
      title: title,
      tag: settings.tagFor(ref.marketplace),
      description: description,
      imageUrl: imageUrl,
    );
    final at = listings.indexWhere((x) => x.id == p.id);
    if (at >= 0) {
      listings[at] = p;
    } else {
      listings.add(p);
    }
    await _persist();
    notifyListeners();
    return p;
  }

  Future<void> remove(String id) async {
    listings.removeWhere((p) => p.id == id);
    await _persist();
    notifyListeners();
  }

  /// Re-stamp every listing with the current tag.
  ///
  /// Needed because the tag is usually entered AFTER the first few products
  /// are added. Without this, early listings keep sending traffic to Amazon
  /// with no tag and earn nothing — silently, since they still work fine for
  /// the shopper.
  Future<int> retagAll() async {
    var n = 0;
    for (var i = 0; i < listings.length; i++) {
      final p = listings[i];
      final ref = Affiliate.parse(p.url);
      if (ref == null) continue;
      final fresh = ref.urlWith(settings.tagFor(ref.marketplace));
      if (fresh == p.url) continue;
      listings[i] = Product(
        id: p.id,
        title: p.title,
        merchant: p.merchant,
        url: fresh,
        source: p.source,
        description: p.description,
        imageUrl: p.imageUrl,
        affiliateUrl: fresh,
      );
      n++;
    }
    if (n > 0) {
      await _persist();
      notifyListeners();
    }
    return n;
  }

  /// Listings that will earn nothing because their marketplace has no tag.
  List<Product> get untagged => listings
      .where((p) => !p.url.contains('tag='))
      .toList();
}
