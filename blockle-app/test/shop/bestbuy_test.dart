// A live retailer catalogue is what makes the shop read like a shop.
//
// It is also the source with the most room to be quietly wrong, because
// nobody reviews a thousand auto-imported listings. A feed that sends
// regularPrice == salePrice on everything, or an http image URL that iOS
// silently blocks, or a review average on a 10-point scale, produces a shop
// that looks finished and is subtly lying.
//
// So these run the real parser over real Best Buy response shapes.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:blockle_app/shop/catalog.dart';
import 'package:blockle_app/shop/feeds/bestbuy.dart';
import 'package:blockle_app/shop/feeds/retail_feed.dart';
import 'package:blockle_app/shop/product.dart';

String body(List<Map<String, dynamic>> products) =>
    jsonEncode({'from': 1, 'to': products.length, 'products': products});

Map<String, dynamic> item({
  int sku = 6487231,
  String name = 'Sony WH-1000XM5 Wireless Headphones',
  dynamic salePrice = 329.99,
  dynamic regularPrice = 399.99,
  dynamic image = 'https://pisces.bbystatic.com/x.jpg',
  dynamic online = true,
  dynamic review = 4.7,
  dynamic reviews = 2841,
}) =>
    {
      'sku': sku,
      'name': name,
      'salePrice': salePrice,
      'regularPrice': regularPrice,
      'onSale': true,
      'image': image,
      'url': 'https://www.bestbuy.com/site/x/$sku.p',
      'shortDescription': 'Noise cancelling over-ear headphones.',
      'manufacturer': 'Sony',
      'customerReviewAverage': review,
      'customerReviewCount': reviews,
      'onlineAvailability': online,
    };

void main() {
  group('reading the catalogue', () {
    test('a normal product comes through whole', () {
      final p = BestBuyFeed.parse(body([item()])).single;
      expect(p.title, 'Sony WH-1000XM5 Wireless Headphones');
      expect(p.merchant, 'Best Buy');
      expect(p.priceMinor, 32999);
      expect(p.currency, 'USD');
      expect(p.originalPriceMinor, 39999);
      expect(p.discountPercent, 18);
      expect(p.brand, 'Sony');
      expect(p.rating, 4.7);
      expect(p.reviewCount, 2841);
      expect(p.availability, Availability.inStock);
      expect(p.source, ProductSource.feed);
      expect(p.hasPrice, isTrue);
    });

    test('NO FAKE DISCOUNT when the regular price equals the sale price', () {
      // Feeds routinely send both fields on items that are not discounted.
      // Passing that through renders "0% off" across half the catalogue and
      // trains shoppers to ignore the badge.
      final p = BestBuyFeed.parse(
              body([item(salePrice: 99.99, regularPrice: 99.99)]))
          .single;
      expect(p.originalPriceMinor, isNull);
      expect(p.discountPercent, isNull);
    });

    test('a regular price BELOW the sale price is bad data, not a discount',
        () {
      final p = BestBuyFeed.parse(
              body([item(salePrice: 149.99, regularPrice: 99.99)]))
          .single;
      expect(p.originalPriceMinor, isNull);
    });

    test('no price means no currency either', () {
      // "Call for price" items exist. A null price with a stray "USD" on it
      // is the kind of half-state the UI then has to guess about.
      final p = BestBuyFeed.parse(body([item(salePrice: null)])).single;
      expect(p.priceMinor, isNull);
      expect(p.currency, isNull);
      expect(p.hasPrice, isFalse);
    });

    test('an unavailable item says so; a missing flag says unknown', () {
      expect(BestBuyFeed.parse(body([item(online: false)])).single.availability,
          Availability.outOfStock);
      final noFlag = {...item()}..remove('onlineAvailability');
      expect(BestBuyFeed.parse(body([noFlag])).single.availability,
          Availability.unknown,
          reason: 'absent must not be read as "probably available"');
    });

    test('an out-of-range rating is dropped rather than rendered', () {
      expect(BestBuyFeed.parse(body([item(review: 9.2)])).single.rating,
          isNull);
      expect(BestBuyFeed.parse(body([item(review: null)])).single.rating,
          isNull);
    });

    test('an http image is upgraded, and a junk one dropped', () {
      // iOS App Transport Security blocks http, so it would render as a
      // broken box — the placeholder is better.
      expect(
          BestBuyFeed.parse(body([item(image: 'http://img.test/a.jpg')]))
              .single
              .imageUrl,
          'https://img.test/a.jpg');
      expect(
          BestBuyFeed.parse(body([item(image: 'not-a-url')])).single.imageUrl,
          isNull);
    });

    test('a row with no name, sku or url is skipped, not listed blank', () {
      final broken = [
        {'sku': 1, 'salePrice': 10.0},
        {'name': 'No url', 'sku': 2, 'salePrice': 10.0},
        item(),
      ];
      expect(BestBuyFeed.parse(body(broken)), hasLength(1));
    });

    test('malformed JSON yields nothing rather than throwing', () {
      expect(BestBuyFeed.parse('<html>502</html>'), isEmpty);
      expect(BestBuyFeed.parse('{}'), isEmpty);
    });
  });

  group('monetisation is separate from the data, and honest about it', () {
    test('without an affiliate wrap the links are untracked, and it says so',
        () {
      final feed = BestBuyFeed(apiKey: 'k');
      expect(feed.earns, isFalse);
      final p = BestBuyFeed.parse(body([item()])).single;
      expect(p.affiliateUrl, isNull);
      expect(p.url, startsWith('https://www.bestbuy.com/site/'));
    });

    test('a wrap is applied to both url and affiliateUrl when present', () {
      final p = BestBuyFeed.parse(body([item()]),
          affiliateWrap: (u) => 'https://track.test/?u=$u').single;
      expect(p.url, startsWith('https://track.test/?u='));
      expect(p.affiliateUrl, p.url);
      expect(BestBuyFeed(apiKey: 'k', affiliateWrap: (u) => u).earns, isTrue);
    });
  });

  group('the front page', () {
    // Without this the shop is a blank search box on open, which is a
    // database rather than a store.
    test('featured filters for popular, in-stock products', () {
      final u = BestBuyFeed(apiKey: 'K').featuredUri();
      expect(u.toString(), contains('onlineAvailability=true'));
      expect(u.toString(), contains('sort=customerReviewCount.desc'));
      // It is a filter, not someone's guess at a search term.
      expect(u.toString(), isNot(contains('search=')));
      // And nothing percent-encoded in the path that Best Buy might not
      // decode — the sort does the work a '>' filter would have.
      expect(u.path, isNot(contains('%3E')));
    });

    test('an empty query asks for the front page, not for nothing', () async {
      var hit = '';
      final feed = BestBuyFeed(
          apiKey: 'K',
          client: MockClient((req) async {
            hit = req.url.toString();
            return http.Response(body([item()]), 200);
          }));
      final src = FeedSource(feed: feed);
      final r = await src.search('');
      expect(r, hasLength(1));
      expect(hit, contains('onlineAvailability=true'),
          reason: 'an unsearched shop must show the featured slice');
      expect(hit, isNot(contains('search=')));
    });

    test('a real query still searches', () async {
      var hit = '';
      final feed = BestBuyFeed(
          apiKey: 'K',
          client: MockClient((req) async {
            hit = req.url.toString();
            return http.Response(body([item()]), 200);
          }));
      await FeedSource(feed: feed).search('headphones');
      expect(hit, contains('search=headphones'));
    });

    test('featured makes no request when unconfigured', () async {
      var called = false;
      final feed = BestBuyFeed(
          apiKey: '',
          client: MockClient((_) async {
            called = true;
            return http.Response('', 200);
          }));
      expect(await feed.featured(), isEmpty);
      expect(called, isFalse);
    });
  });

  group('the affiliate template', () {
    FeedSettings settings(Map<String, String> k) {
      final s = FeedSettings(store: const _NoStore());
      s.keys = k;
      return s;
    }

    test('a template with {url} produces a working wrap', () {
      final w = settings({
        'bestbuy.affiliate': 'https://goto.bestbuy.com/c/1?u={url}'
      }).wrapFor('bestbuy')!;
      final out = w('https://www.bestbuy.com/site/x/1.p');
      expect(out, startsWith('https://goto.bestbuy.com/c/1?u='));
      // The destination is encoded, or the tracker drops everything after
      // the first & in the product URL.
      expect(out, contains('https%3A%2F%2Fwww.bestbuy.com'));
    });

    test('a template WITHOUT {url} is refused rather than silently useless',
        () {
      // Pasting a bare click URL would send every shopper to the same
      // landing page instead of the product they tapped.
      final s = settings({'bestbuy.affiliate': 'https://goto.bestbuy.com/c/1'});
      expect(s.templateFor('bestbuy'), isNull);
      expect(s.wrapFor('bestbuy'), isNull);
    });

    test('no template means the feed reports that it earns nothing', () {
      final s = settings({'bestbuy': 'KEY'});
      final feed =
          BestBuyFeed(apiKey: 'KEY', affiliateWrap: s.wrapFor('bestbuy'));
      expect(feed.configured, isTrue, reason: 'products still load');
      expect(feed.earns, isFalse, reason: 'but they earn nothing yet');
    });
  });

  group('the request', () {
    test('ANDs the search terms in Best Buy\'s grammar', () {
      final u = BestBuyFeed(apiKey: 'KEY').searchUri('wireless headphones');
      expect(u.toString(), contains('search=wireless'));
      expect(u.toString(), contains('search=headphones'));
      expect(u.toString(), contains('apiKey=KEY'));
    });

    test('strips the characters that would break the query grammar', () {
      // '(' ')' '&' '=' delimit Best Buy's filter syntax; a stray one from a
      // user's search box produces a 400, not a result set.
      final u = BestBuyFeed(apiKey: 'K').searchUri('sony (wh-1000) & more=x');
      expect(u.toString(), isNot(contains('(wh')));
      expect(u.toString(), contains('search=sony'));
    });

    test('an unconfigured feed makes no request at all', () async {
      var called = false;
      final feed = BestBuyFeed(
          apiKey: '',
          client: MockClient((_) async {
            called = true;
            return http.Response('', 200);
          }));
      expect(feed.configured, isFalse);
      expect(await feed.search('headphones'), isEmpty);
      expect(called, isFalse);
      expect(feed.howToEnable, contains('developer.bestbuy.com'));
    });

    test('an empty query makes no request either', () async {
      var called = false;
      final feed = BestBuyFeed(
          apiKey: 'K',
          client: MockClient((_) async {
            called = true;
            return http.Response(body([item()]), 200);
          }));
      expect(await feed.search('   '), isEmpty);
      expect(called, isFalse);
    });

    test('a live search returns parsed products', () async {
      final feed = BestBuyFeed(
          apiKey: 'K',
          client: MockClient((_) async => http.Response(body([item()]), 200)));
      final r = await feed.search('headphones');
      expect(r.single.title, contains('Sony'));
      expect(r.single.priceMinor, 32999);
    });

    test('an API error returns nothing rather than a broken listing',
        () async {
      final feed = BestBuyFeed(
          apiKey: 'K',
          client: MockClient((_) async => http.Response('rate limited', 429)));
      expect(await feed.search('headphones'), isEmpty);
    });
  });

  group('shared feed parsing rules', () {
    test('money refuses what it cannot read exactly', () {
      expect(FeedParse.money(19.99), 1999);
      expect(FeedParse.money('19.99'), 1999);
      expect(FeedParse.money('call for price'), isNull);
      expect(FeedParse.money(''), isNull);
      expect(FeedParse.money(-5), isNull);
      expect(FeedParse.money(null), isNull);
    });

    test('a was-price needs a current price to compare against', () {
      expect(FeedParse.wasPrice(null, 99.99), isNull);
    });
  });
}

/// Settings with no disk behind them.
class _NoStore extends FlutterSecureStorage {
  const _NoStore();
  @override
  Future<String?> read({required String key, iOptions, aOptions, lOptions,
          webOptions, mOptions, wOptions}) async =>
      null;
  @override
  Future<void> write({required String key, required String? value, iOptions,
      aOptions, lOptions, webOptions, mOptions, wOptions}) async {}
}
