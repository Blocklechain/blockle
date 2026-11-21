// Amazon listings without an Amazon API.
//
// Two things must hold, and they pull in opposite directions.
//
// COMMERCIALLY: every outbound link must carry OUR associate tag, or the
// storefront sends Amazon free traffic and earns nothing. This fails
// silently — an untagged link works perfectly for the shopper — so it has to
// be tested rather than noticed.
//
// CONTRACTUALLY: no Amazon price may be rendered. The Associates agreement
// permits showing a price only when Amazon serves the link displaying it or
// it came from the Creators API, and we have neither. A breach here risks the
// account the whole feature depends on, so the tests check the structure,
// not just today's behaviour.

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:blockle_app/shop/affiliate.dart';
import 'package:blockle_app/shop/product.dart';

class FakeStore extends FlutterSecureStorage {
  FakeStore([this.data = const {}]) : super();
  Map<String, String> data;

  @override
  Future<String?> read({required String key, iOptions, aOptions, lOptions,
          webOptions, mOptions, wOptions}) async =>
      data[key];

  @override
  Future<void> write({required String key, required String? value, iOptions,
      aOptions, lOptions, webOptions, mOptions, wOptions}) async {
    data = {...data, if (value != null) key: value};
  }
}

AffiliateStore storeWith({String? tag, http.Client? client}) {
  final s = AffiliateStore(
      store: FakeStore(), client: client, settings: AffiliateSettings(store: FakeStore()));
  if (tag != null) {
    s.settings.setTag(const Marketplace('amazon.com', 'Amazon US'), tag);
  }
  return s;
}

void main() {
  group('finding the product in a pasted link', () {
    test('the ordinary /dp/ link', () {
      final r = Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW');
      expect(r!.asin, 'B08N5WRWNW');
      expect(r.marketplace.host, 'amazon.com');
    });

    test('a long SEO link with a slug and query junk', () {
      final r = Affiliate.parse(
          'https://www.amazon.com/Echo-Dot-4th-Gen/dp/B08N5WRWNW/'
          'ref=sr_1_3?keywords=echo&qid=1700000000&sr=8-3');
      expect(r!.asin, 'B08N5WRWNW');
    });

    test('the /gp/product/ and mobile shapes', () {
      expect(Affiliate.parse('https://amazon.com/gp/product/B08N5WRWNW')!.asin,
          'B08N5WRWNW');
      expect(Affiliate.parse('https://www.amazon.com/gp/aw/d/B08N5WRWNW')!.asin,
          'B08N5WRWNW');
    });

    test('amazon.com.au is not read as amazon.com', () {
      // Longest-host-first matching. Getting this wrong tags an Australian
      // link with a US tag, which earns nothing.
      final r = Affiliate.parse('https://www.amazon.com.au/dp/B08N5WRWNW');
      expect(r!.marketplace.host, 'amazon.com.au');
    });

    test('a non-Amazon host is refused', () {
      expect(Affiliate.parse('https://notamazon.com/dp/B08N5WRWNW'), isNull);
      // ...including a lookalike that merely contains the string.
      expect(Affiliate.parse('https://amazon.com.evil.test/dp/B08N5WRWNW'),
          isNull);
    });

    test('a page that is not a product is refused, not guessed', () {
      expect(Affiliate.parse('https://www.amazon.com/s?k=headphones'), isNull);
      expect(Affiliate.parse('https://www.amazon.com'), isNull);
    });

    test('a short link is identified as needing resolution', () {
      expect(Affiliate.needsResolving('https://amzn.to/3xYzAbC'), isTrue);
      expect(Affiliate.needsResolving('https://www.amazon.com/dp/B08N5WRWNW'),
          isFalse);
    });
  });

  group('the tag — where the money is', () {
    test('the link carries our tag', () async {
      final s = storeWith(tag: 'blockle-20');
      final p = await s.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(p.url, 'https://www.amazon.com/dp/B08N5WRWNW?tag=blockle-20');
    });

    test('SOMEONE ELSE\'S TAG IS STRIPPED', () async {
      // Pasting a link found on another affiliate's site would otherwise
      // hand them the commission on every sale we send.
      final s = storeWith(tag: 'blockle-20');
      final p = await s.add(
          ref: Affiliate.parse(
              'https://www.amazon.com/dp/B08N5WRWNW?tag=rival-21&psc=1')!,
          title: 'Echo Dot');
      expect(p.url, contains('tag=blockle-20'));
      expect(p.url, isNot(contains('rival-21')));
    });

    test('tracking and session junk is dropped, not carried', () async {
      final s = storeWith(tag: 'blockle-20');
      final p = await s.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW/'
              'ref=sr_1_3?pd_rd_w=xyz&pf_rd_p=abc&qid=1700000000')!,
          title: 'Echo Dot');
      expect(p.url, 'https://www.amazon.com/dp/B08N5WRWNW?tag=blockle-20');
    });

    test('amazon.com is tagged out of the box', () async {
      // Blockle's own tag ships as a default, so the very first listing on a
      // fresh install earns. An unconfigured marketplace is the leak this
      // closes: untagged links work perfectly for the shopper, so nobody
      // notices the missing commission.
      final s = storeWith();
      final p = await s.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(p.url, contains('tag=blockle-20'));
      expect(s.untagged, isEmpty);
    });

    test('a marketplace with no tag is flagged, not silently unpaid',
        () async {
      final s = storeWith();
      await s.add(
          ref: Affiliate.parse('https://www.amazon.de/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(s.untagged, hasLength(1));
      expect(s.settings.unconfigured.map((m) => m.host),
          contains('amazon.de'));
    });

    test('setting a tag afterwards re-stamps the back catalogue', () async {
      final s = storeWith();
      await s.add(
          ref: Affiliate.parse('https://www.amazon.de/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(s.untagged, hasLength(1));
      await s.settings
          .setTag(const Marketplace('amazon.de', 'Amazon Germany'), 'blockle-21');
      final n = await s.retagAll();
      expect(n, 1);
      expect(s.untagged, isEmpty);
      expect(s.listings.single.url, contains('tag=blockle-21'));
    });

    test('tags are per-marketplace', () async {
      final s = storeWith(tag: 'blockle-20');
      await s.settings
          .setTag(const Marketplace('amazon.co.uk', 'Amazon UK'), 'blockle-21');
      final uk = await s.add(
          ref: Affiliate.parse('https://www.amazon.co.uk/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(uk.url, contains('amazon.co.uk'));
      expect(uk.url, contains('tag=blockle-21'));
    });

    test('the same ASIN on two marketplaces is two listings', () async {
      final s = storeWith(tag: 'blockle-20');
      await s.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      await s.add(
          ref: Affiliate.parse('https://www.amazon.co.uk/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(s.listings, hasLength(2));
    });
  });

  group('NO AMAZON PRICE IS EVER RENDERED', () {
    test('a curated listing has no price and no currency', () async {
      final s = storeWith(tag: 'blockle-20');
      final p = await s.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot');
      expect(p.priceMinor, isNull);
      expect(p.currency, isNull);
      expect(p.hasPrice, isFalse);
    });

    test('and there is no way to give it one', () {
      // STRUCTURAL, not behavioural. Affiliate.listing takes no price
      // argument at all, so the next person cannot add one by passing a
      // parameter — they would have to edit this file and its header, which
      // explains why not.
      final p = Affiliate.listing(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot',
          tag: 'blockle-20');
      expect(p.hasPrice, isFalse);
      expect(p.source, ProductSource.affiliateLink);
    });

    test('the absent price is "at the retailer", not "missing"', () {
      // The difference matters: a missing price nags the curator forever and
      // blocks listing, when in fact the listing is complete and correct.
      final p = Affiliate.listing(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot',
          tag: 't',
          description: 'A speaker.',
          imageUrl: 'https://img.test/a.jpg');
      expect(p.priceLivesAtRetailer, isTrue);
      expect(p.missing, isNot(contains('price')));
      expect(p.listable, isTrue);
    });

    test('a seller\'s OWN listing still requires a price', () {
      // The exemption must not leak to the merchant-link path, where a
      // missing price really is an unfinished listing.
      const own = Product(
          id: 'x',
          title: 'Lamp',
          merchant: 'Hale & Co',
          url: 'https://hale.test/lamp',
          source: ProductSource.merchantEdited,
          description: 'd',
          imageUrl: 'https://i.test/a.jpg');
      expect(own.priceLivesAtRetailer, isFalse);
      expect(own.missing, contains('price'));
      expect(own.listable, isFalse);
    });
  });

  group('short links', () {
    test('are followed to the product, and the BODY IS IGNORED', () async {
      // The response carries a title and a price. Resolving must take the
      // ASIN from the final URL and nothing whatsoever from the page — that
      // is the line between following a link someone handed us and mining
      // Amazon's catalogue.
      final client = MockClient((req) async => http.Response(
          '<html><title>Echo Dot</title><span class="price">\$49.99</span>'
          '</html>',
          200,
          request: http.Request(
              'GET', Uri.parse('https://www.amazon.com/dp/B08N5WRWNW'))));
      final s = storeWith(tag: 'blockle-20', client: client);
      final r = await s.resolve('https://amzn.to/3xYzAbC');
      expect(r.ref!.asin, 'B08N5WRWNW');

      // The curator still has to supply the title, because we did not read
      // one — and the listing has no price despite one being on the page.
      final p = await s.add(ref: r.ref!, title: 'Typed by the curator');
      expect(p.title, 'Typed by the curator');
      expect(p.hasPrice, isFalse);
      expect(p.description, isNull);
    });

    test('a short link that does not land on a product is reported', () async {
      final client = MockClient((_) async => http.Response('', 200,
          request: http.Request('GET', Uri.parse('https://www.amazon.com/'))));
      final s = storeWith(client: client);
      final r = await s.resolve('https://amzn.to/bad');
      expect(r.ref, isNull);
      expect(r.error, contains('single product'));
    });

    test('a normal product link makes no request at all', () async {
      var called = false;
      final client = MockClient((_) async {
        called = true;
        return http.Response('', 200);
      });
      final s = storeWith(client: client);
      final r = await s.resolve('https://www.amazon.com/dp/B08N5WRWNW');
      expect(r.ref!.asin, 'B08N5WRWNW');
      expect(called, isFalse,
          reason: 'Amazon must not be fetched when the URL already says '
              'which product it is');
    });

    test('a non-Amazon link is refused with a usable instruction', () async {
      final s = storeWith();
      final r = await s.resolve('https://example.com/thing');
      expect(r.ref, isNull);
      expect(r.error, contains('address bar'));
    });
  });

  group('persistence', () {
    test('listings and tags survive a restart', () async {
      final disk = FakeStore();
      final tagDisk = FakeStore();
      final a = AffiliateStore(
          store: disk, settings: AffiliateSettings(store: tagDisk));
      await a.settings
          .setTag(const Marketplace('amazon.com', 'Amazon US'), 'blockle-20');
      await a.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot');

      final b = AffiliateStore(
          store: disk, settings: AffiliateSettings(store: tagDisk));
      await b.load();
      expect(b.listings.single.title, 'Echo Dot');
      expect(b.listings.single.url, contains('tag=blockle-20'));
      // And crucially, no price came back from storage either.
      expect(b.listings.single.hasPrice, isFalse);
      expect(b.settings.tagFor(const Marketplace('amazon.com', 'Amazon US')),
          'blockle-20');
    });
  });
}
