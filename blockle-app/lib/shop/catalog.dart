// Where listings come from, and the promise that none of them are invented.
//
// A shopping app has exactly one unforgivable failure: showing a product at a
// price nobody can buy it at. It is also the easiest failure to ship, because
// placeholder data looks like a working feature in every screenshot and only
// breaks when a real person taps Buy. So the catalogue is built around a
// source that can say "I have nothing", and a UI that is required to say so
// rather than fill the gap.
//
// THREE ADAPTERS BEHIND ONE INTERFACE, with very different legal footing:
//
//   MerchantLinkSource — a business pastes a link to a product on THEIR OWN
//     site. That is an invitation, so we read the page (see ingest.dart) and
//     hand them a draft to correct. Live now.
//
//   AffiliateLinkSource — curated links to big retailers. Needs no API and no
//     credentials, so this is how Amazon works TODAY. It reads nothing from
//     Amazon and shows no price: the Associates agreement permits a price
//     only from Amazon's own embed or the Creators API, and the Creators API
//     will not issue credentials below 10 qualifying sales in a rolling 30
//     days. Live now. See affiliate.dart.
//
//   FeedSource — an automatic catalogue with live prices, from a network
//     datafeed or a retailer's own API. Needs an approved account, so it
//     reports itself unavailable rather than returning sample products. NOT a
//     stub that returns examples.
//
// The interface is deliberately allowed to return nothing. `unavailableReason`
// exists so the screen can explain itself in a sentence instead of rendering
// an ambiguous empty list.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'affiliate.dart';
import 'bulk.dart';
import 'feeds/retail_feed.dart';
import 'ingest.dart';
import 'product.dart';

/// One source of listings.
abstract class CatalogSource {
  String get name;

  /// Null when this source can serve requests. A sentence a shopper can
  /// understand when it cannot — shown verbatim, so it is written for them and
  /// not for a log file.
  String? get unavailableReason;

  /// Listings matching `query`; empty when there are none. An empty list and
  /// an unavailable source are different states and the UI distinguishes them.
  Future<List<Product>> search(String query);
}

/// Products submitted by businesses, one link at a time.
///
/// This is the live source. It holds what merchants have actually listed, so
/// an empty result means no merchant has listed a match — which is true, and
/// says so, rather than being covered up with examples.
class MerchantLinkSource extends CatalogSource {
  MerchantLinkSource(this._store);
  final MerchantStore _store;

  @override
  String get name => 'Blockle sellers';

  @override
  String? get unavailableReason => null;

  @override
  Future<List<Product>> search(String query) async {
    final q = query.trim().toLowerCase();
    final listed = _store.listings.where((p) => p.listable);
    if (q.isEmpty) return listed.toList();
    return listed
        .where((p) =>
            p.title.toLowerCase().contains(q) ||
            p.merchant.toLowerCase().contains(q) ||
            (p.brand?.toLowerCase().contains(q) ?? false))
        .toList();
  }
}

/// Curated affiliate links — Amazon and friends, with no API at all.
///
/// THIS IS THE ONE THAT WORKS TODAY for big retailers. Affiliate links need
/// no credentials, so a curated storefront is compliant and earns commission
/// immediately — and it is the only thing that can produce the sales that
/// unlock Amazon's Creators API, which requires 10 qualifying sales in a
/// rolling 30 days before it will issue credentials.
///
/// Listings here carry NO PRICE, by construction rather than by omission.
/// See affiliate.dart for the clause that requires it.
class AffiliateLinkSource extends CatalogSource {
  AffiliateLinkSource(this._store);
  final AffiliateStore _store;

  @override
  String get name => 'Retailer picks';

  @override
  String? get unavailableReason => null;

  @override
  Future<List<Product>> search(String query) async {
    final q = query.trim().toLowerCase();
    final all = _store.listings;
    if (q.isEmpty) return all.toList();
    return all
        .where((p) =>
            p.title.toLowerCase().contains(q) ||
            p.merchant.toLowerCase().contains(q))
        .toList();
  }
}

/// A real retailer catalogue, searched live.
///
/// This is what makes the shop read like a shop: a query returns real
/// products at real current prices, with no curation step. It is a thin
/// bridge onto RetailFeed — see shop/feeds/retail_feed.dart for which
/// retailers permit this and which do not (Amazon does not).
///
/// When the feed has no credential it reports WHY and returns nothing. It
/// never substitutes examples: a sample product in a shopping app is
/// indistinguishable from a real one until someone tries to buy it.
class FeedSource extends CatalogSource {
  FeedSource({RetailFeed? feed}) : _feed = feed;

  final RetailFeed? _feed;

  @override
  String get name => _feed?.name ?? 'Retailer feeds';

  @override
  String? get unavailableReason {
    final f = _feed;
    if (f == null) {
      return 'No retailer catalogue is connected yet, so the shop only '
          'shows products that sellers have listed themselves.';
    }
    if (!f.configured) return '${f.name} is not connected. ${f.howToEnable}';
    return null;
  }

  @override
  Future<List<Product>> search(String query) async {
    final f = _feed;
    if (f == null || !f.configured) return const [];
    return f.search(query);
  }
}

/// Everything the shop can search, with the honest empty states preserved.
class Catalog extends ChangeNotifier {
  Catalog(this.sources);

  /// The app's real source list.
  ///
  /// THIS EXISTS SO IT CAN BE TESTED. When main.dart assembled the list
  /// inline, a test could only check a Catalog it had built itself — which
  /// would have passed just as happily on a release where someone dropped a
  /// source from the app's own wiring. This repo has shipped
  /// built-tested-but-unwired more than once.
  factory Catalog.standard({
    required MerchantStore merchants,
    required AffiliateStore picks,
    RetailFeed? feed,
  }) =>
      Catalog([
        // A live retailer catalogue first — it is the only source that makes
        // an unsearched shop feel populated. Off until a key exists, and it
        // says so rather than returning examples.
        FeedSource(feed: feed),
        MerchantLinkSource(merchants),
        AffiliateLinkSource(picks),
      ]);

  final List<CatalogSource> sources;

  List<Product> results = const [];
  bool searching = false;

  /// Sources that could not be consulted, so the screen can say what is
  /// missing from the results rather than implying they are complete.
  List<CatalogSource> get offline =>
      sources.where((s) => s.unavailableReason != null).toList();

  bool get anyLive => sources.any((s) => s.unavailableReason == null);

  Future<void> search(String query) async {
    searching = true;
    notifyListeners();
    final out = <Product>[];
    for (final s in sources) {
      if (s.unavailableReason != null) continue;
      try {
        out.addAll(await s.search(query));
      } catch (_) {
        // A source that throws is a source that returned nothing. It must not
        // take the other sources' results down with it.
      }
    }
    results = out;
    searching = false;
    notifyListeners();
  }
}

// --- the seller's side -------------------------------------------------

/// A listing in progress, from pasted link to published product.
enum DraftState { empty, reading, needsWork, ready, failed }

/// Holds what businesses have submitted, and runs the paste-a-link flow.
///
/// FETCHING IS SEPARATED FROM PARSING on purpose: Ingest.parse is pure and
/// fully tested against fixture HTML, and this class owns only the network and
/// the storage. The parser never has to be tested over a socket.
class MerchantStore extends ChangeNotifier {
  MerchantStore({http.Client? client}) : _client = client ?? http.Client();

  static const _key = 'blockle_merchant_listings_v1';
  final _store = const FlutterSecureStorage();
  final http.Client _client;

  final List<Product> listings = [];

  DraftState state = DraftState.empty;
  Product? draft;
  String? error;

  /// Which reader produced the draft — shown to the merchant, because "we read
  /// your structured data" vs "we could only read your page title" tells them
  /// whether fixing their own site would improve the result.
  String? readFrom;

  Future<void> load() async {
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final list = jsonDecode(raw);
      if (list is! List) return;
      listings
        ..clear()
        ..addAll(list.whereType<Map<String, dynamic>>().map(Product.fromJson));
      notifyListeners();
    } catch (_) {
      // Unreadable storage must not block the seller from listing again.
    }
  }

  Future<void> _persist() async {
    try {
      await _store.write(
          key: _key,
          value: jsonEncode(listings.map((p) => p.toJson()).toList()));
    } catch (_) {}
  }

  /// Fetch a seller's own product page and turn it into a draft.
  ///
  /// The URL comes from the seller, about their own site. It is still fetched
  /// defensively: a redirect chain, a 10s ceiling and a size cap, because a
  /// pasted link is the most user-controlled input in the app.
  Future<void> readLink(String url) async {
    state = DraftState.reading;
    error = null;
    draft = null;
    readFrom = null;
    notifyListeners();

    final uri = Uri.tryParse(url.trim());
    if (uri == null ||
        (uri.scheme != 'http' && uri.scheme != 'https') ||
        uri.host.isEmpty) {
      state = DraftState.failed;
      error = 'That does not look like a web address. Paste the full link to '
          'one of your product pages, starting with https://';
      notifyListeners();
      return;
    }

    String html;
    try {
      final res = await _client
          .get(uri, headers: {
            // Identifying ourselves honestly, with a contact, is both correct
            // and what lets a seller allow us through their own WAF.
            'User-Agent': 'BlockleShop/1.0 (+https://blockle.org/sellers)',
            'Accept': 'text/html,application/xhtml+xml',
          })
          .timeout(const Duration(seconds: 10));
      if (res.statusCode >= 400) {
        state = DraftState.failed;
        error = 'That page returned ${res.statusCode}. Check the link opens '
            'for someone who is not signed in to your store.';
        notifyListeners();
        return;
      }
      // 2 MB is generous for a product page and stops a pathological response
      // from exhausting memory on a phone.
      html = res.body.length > 2 * 1024 * 1024
          ? res.body.substring(0, 2 * 1024 * 1024)
          : res.body;
    } on TimeoutException {
      state = DraftState.failed;
      error = 'That page took too long to load. Try again, or add the details '
          'yourself.';
      notifyListeners();
      return;
    } catch (_) {
      state = DraftState.failed;
      error = 'We could not reach that page. Check the link and your '
          'connection.';
      notifyListeners();
      return;
    }

    final result = Ingest.parse(html, uri.toString());
    if (!result.ok) {
      state = DraftState.failed;
      error = result.error;
      notifyListeners();
      return;
    }
    draft = result.product;
    readFrom = result.readFrom;
    // A draft is NEVER auto-published. Everything here was read off a page by
    // a parser, and the seller is the only one who knows if it is right.
    state = draft!.listable ? DraftState.ready : DraftState.needsWork;
    notifyListeners();
  }

  // --- bulk import -----------------------------------------------------

  /// Products found by reading a whole storefront, awaiting the merchant's OK.
  List<Product> bulkFound = const [];
  bool bulkBusy = false;
  String? bulkError;
  StorePlatform bulkPlatform = StorePlatform.unknown;
  String? bulkCurrency;
  int bulkDroppedPrices = 0;

  /// Hard ceiling on pages. A catalogue of a quarter of a million products
  /// is not something to pull onto a phone, and an unbounded loop against
  /// someone else's server is rude as well as fragile. What is skipped is
  /// REPORTED rather than silently truncated.
  static const int maxPages = 5;
  bool bulkTruncated = false;

  /// Read a merchant's entire storefront from its public catalogue endpoint.
  ///
  /// Shopify and WooCommerce both publish one; see bulk.dart for why this is
  /// the best coverage available without a gatekeeper, and for the currency
  /// trap that makes this more than a loop.
  /// [currencyOverride] re-runs the read with a currency the merchant has
  /// stated, for the Shopify stores whose /meta.json does not say. It has to
  /// re-fetch rather than patch the previous result: once a price has been
  /// dropped for having no currency, the raw figure is gone, and inventing a
  /// way to put it back would defeat the point of dropping it.
  Future<void> importStore(String storeUrl, {String? currencyOverride}) async {
    bulkBusy = true;
    bulkError = null;
    bulkFound = const [];
    bulkTruncated = false;
    bulkDroppedPrices = 0;
    notifyListeners();

    final candidates = BulkImport.catalogUrls(storeUrl);
    if (candidates.isEmpty) {
      bulkBusy = false;
      bulkError = 'That does not look like a web address. Paste your shop\'s '
          'address, like https://yourstore.com';
      notifyListeners();
      return;
    }

    // Shopify omits the currency from its catalogue entirely, so ask the
    // store for it FIRST — a failure here costs prices, not the import.
    String? currency = currencyOverride?.trim().toUpperCase();
    if (currency != null && currency.length != 3) currency = null;
    final meta = currency != null ? null : BulkImport.metaUrl(storeUrl);
    if (meta != null) {
      try {
        final r = await _client.get(meta).timeout(const Duration(seconds: 8));
        if (r.statusCode == 200) {
          currency = BulkImport.currencyFromMeta(r.body);
        }
      } catch (_) {}
    }

    final found = <Product>[];
    var dropped = 0;
    var platform = StorePlatform.unknown;

    for (var page = 1; page <= maxPages; page++) {
      final urls = page == 1
          ? candidates
          : BulkImport.catalogUrls(storeUrl, page: page)
              .where((u) =>
                  platform == StorePlatform.shopify
                      ? u.path.endsWith('products.json')
                      : u.path.contains('wc/store'))
              .toList();

      BulkResult? best;
      for (final u in urls) {
        try {
          final r = await _client.get(u, headers: {
            'User-Agent': 'BlockleShop/1.0 (+https://blockle.org/sellers)',
            'Accept': 'application/json',
          }).timeout(const Duration(seconds: 12));
          if (r.statusCode != 200) continue;
          final parsed =
              BulkImport.parse(r.body, storeUrl, currency: currency);
          if (parsed.platform != StorePlatform.unknown) {
            best = parsed;
            break;
          }
        } catch (_) {
          // Try the next candidate endpoint rather than failing the import.
        }
      }

      if (best == null || best.products.isEmpty) break;
      platform = best.platform;
      found.addAll(best.products);
      dropped += best.droppedPrices;
      // A short page is the last page.
      if (best.products.length < 100) break;
      if (page == maxPages) bulkTruncated = true;
    }

    bulkBusy = false;
    bulkPlatform = platform;
    bulkCurrency = currency;
    bulkDroppedPrices = dropped;
    bulkFound = found;
    if (found.isEmpty) {
      bulkError = 'No public product catalogue was found at that address. '
          'Blockle can import automatically from Shopify and WooCommerce '
          'stores; otherwise add products one link at a time.';
    }
    notifyListeners();
  }

  /// Publish everything from the import that is actually listable.
  ///
  /// Returns how many went live and how many were held back, so the merchant
  /// is told rather than wondering why their 247-product shop shows 203.
  ({int published, int skipped}) publishBulk() {
    var published = 0, skipped = 0;
    for (final p in bulkFound) {
      if (!p.listable) {
        skipped++;
        continue;
      }
      final at = listings.indexWhere((x) => x.id == p.id);
      if (at >= 0) {
        listings[at] = p;
      } else {
        listings.add(p);
      }
      published++;
    }
    bulkFound = const [];
    _persist();
    notifyListeners();
    return (published: published, skipped: skipped);
  }

  void discardBulk() {
    bulkFound = const [];
    bulkError = null;
    notifyListeners();
  }

  /// Apply the seller's corrections. Marks the listing as theirs rather than
  /// ours, which is what the shopper is shown.
  void edit({
    String? title,
    int? priceMinor,
    String? currency,
    String? description,
    String? imageUrl,
    Availability? availability,
  }) {
    final d = draft;
    if (d == null) return;
    draft = d.copyWith(
      title: title,
      priceMinor: priceMinor,
      currency: currency,
      description: description,
      imageUrl: imageUrl,
      availability: availability,
      source: ProductSource.merchantEdited,
    );
    state = draft!.listable ? DraftState.ready : DraftState.needsWork;
    notifyListeners();
  }

  /// Publish. Refuses an incomplete listing — a product with no price is not a
  /// listing, it is a dead end a shopper taps into.
  bool publish() {
    final d = draft;
    if (d == null || !d.listable) return false;
    // Same id for the same URL, so re-submitting a link updates the listing
    // instead of creating a second one.
    final at = listings.indexWhere((p) => p.id == d.id);
    if (at >= 0) {
      listings[at] = d;
    } else {
      listings.add(d);
    }
    draft = null;
    readFrom = null;
    state = DraftState.empty;
    _persist();
    notifyListeners();
    return true;
  }

  void remove(String id) {
    listings.removeWhere((p) => p.id == id);
    _persist();
    notifyListeners();
  }

  void discard() {
    draft = null;
    error = null;
    readFrom = null;
    state = DraftState.empty;
    notifyListeners();
  }
}
