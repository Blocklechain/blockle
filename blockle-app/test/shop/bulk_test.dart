// Importing a whole catalogue multiplies any parsing mistake by a thousand.
//
// A single bad product listing is one bad listing. A bad bulk importer puts
// an entire shop online at the wrong price, and nobody reads 400 rows to
// check. So the assertions here lean hard on what gets DROPPED.
//
// The headline case is Shopify's currency trap: products.json gives a price
// as the bare string "49.00" with no currency anywhere in the payload.
// Reading that as dollars because the parser was written in English puts a
// Canadian or Australian merchant's whole shop online underpriced.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:blockle_app/shop/bulk.dart';
import 'package:blockle_app/shop/catalog.dart';
import 'package:blockle_app/shop/product.dart';

String shopify(List<Map<String, dynamic>> products) =>
    jsonEncode({'products': products});

Map<String, dynamic> sProduct({
  String title = 'Walnut Desk Lamp',
  String handle = 'walnut-desk-lamp',
  int id = 101,
  List<Map<String, dynamic>>? variants,
  String vendor = 'Hale & Co',
}) =>
    {
      'id': id,
      'title': title,
      'handle': handle,
      'vendor': vendor,
      'body_html': '<p>A <b>small</b> lamp.</p>',
      'images': [
        {'src': 'https://cdn.test/lamp.jpg'}
      ],
      'variants': variants ??
          [
            {'id': 1, 'title': 'Default', 'price': '49.00', 'available': true}
          ],
    };

void main() {
  group('Shopify', () {
    test('imports a catalogue when the currency is known', () {
      final r = BulkImport.parse(
          shopify([sProduct(), sProduct(id: 102, title: 'Oak Stool')]),
          'https://hale.example.com',
          currency: 'USD');
      expect(r.platform, StorePlatform.shopify);
      expect(r.products, hasLength(2));
      final p = r.products.first;
      expect(p.title, 'Walnut Desk Lamp');
      expect(p.priceMinor, 4900);
      expect(p.currency, 'USD');
      expect(p.availability, Availability.inStock);
      expect(p.url, 'https://hale.example.com/products/walnut-desk-lamp');
    });

    test('THE CURRENCY TRAP — no currency means no prices, not USD', () {
      // The whole point. "49.00" with no currency is not $49.
      final r = BulkImport.parse(shopify([sProduct()]),
          'https://hale.example.com');
      expect(r.products, hasLength(1));
      expect(r.products.single.priceMinor, isNull);
      expect(r.products.single.currency, isNull);
      // ...and the merchant is TOLD, rather than finding out from a customer.
      expect(r.droppedPrices, 1);
    });

    test('currency comes from the store, not from a guess', () {
      expect(BulkImport.currencyFromMeta('{"currency":"cad"}'), 'CAD');
      expect(BulkImport.currencyFromMeta('{"currency":"Canadian Dollar"}'),
          isNull);
      expect(BulkImport.currencyFromMeta('not json'), isNull);
      expect(BulkImport.currencyFromMeta('{}'), isNull);
    });

    test('the cheapest AVAILABLE variant sets the price', () {
      // A sold-out $19 variant must not advertise the product at $19 when
      // the only buyable one is $49.
      final r = BulkImport.parse(
          shopify([
            sProduct(variants: [
              {'id': 1, 'price': '19.00', 'available': false},
              {'id': 2, 'price': '49.00', 'available': true},
              {'id': 3, 'price': '59.00', 'available': true},
            ])
          ]),
          'https://hale.example.com',
          currency: 'USD');
      expect(r.products.single.priceMinor, 4900);
      expect(r.products.single.availability, Availability.inStock);
    });

    test('a fully sold-out product still shows its real price', () {
      final r = BulkImport.parse(
          shopify([
            sProduct(variants: [
              {'id': 1, 'price': '19.00', 'available': false},
            ])
          ]),
          'https://hale.example.com',
          currency: 'USD');
      expect(r.products.single.priceMinor, 1900);
      expect(r.products.single.availability, Availability.outOfStock);
    });

    test('a comma price is refused, same as everywhere else', () {
      final r = BulkImport.parse(
          shopify([
            sProduct(variants: [
              {'id': 1, 'price': '1.299,00', 'available': true}
            ])
          ]),
          'https://hale.example.com',
          currency: 'EUR');
      expect(r.products.single.priceMinor, isNull);
    });

    test('HTML descriptions are stripped, not handed to a Text widget', () {
      final r = BulkImport.parse(shopify([sProduct()]),
          'https://hale.example.com', currency: 'USD');
      expect(r.products.single.description, 'A small lamp.');
    });

    test('a product with no title is skipped rather than listed blank', () {
      final r = BulkImport.parse(
          jsonEncode({
            'products': [
              {'id': 1, 'handle': 'x'},
              sProduct(),
            ]
          }),
          'https://hale.example.com',
          currency: 'USD');
      expect(r.products, hasLength(1));
    });
  });

  group('WooCommerce', () {
    String woo(List<Map<String, dynamic>> p) => jsonEncode(p);

    test('imports with the currency the API states', () {
      // Woo is the better-behaved API: it says the currency.
      final r = BulkImport.parse(
          woo([
            {
              'id': 7,
              'name': 'Oak Stool',
              'permalink': 'https://shop.test/?p=7',
              'short_description': '<p>A stool.</p>',
              'is_in_stock': true,
              'images': [
                {'src': 'https://shop.test/s.jpg'}
              ],
              'prices': {
                'price': '1250',
                'currency_code': 'GBP',
                'currency_minor_unit': 2,
              },
            }
          ]),
          'https://shop.test');
      expect(r.platform, StorePlatform.woocommerce);
      final p = r.products.single;
      expect(p.priceMinor, 1250);
      expect(p.currency, 'GBP');
      expect(p.description, 'A stool.');
      expect(r.currency, 'GBP');
    });

    test('a non-2-decimal currency is rescaled, not taken literally', () {
      // JPY has 0 decimals: "1250" means ¥1250, which is 125000 in the
      // cents-style minor units the rest of the app uses. Taking it
      // literally would price it at ¥12.50.
      final r = BulkImport.parse(
          woo([
            {
              'id': 8,
              'name': 'Thing',
              'is_in_stock': true,
              'prices': {
                'price': '1250',
                'currency_code': 'JPY',
                'currency_minor_unit': 0,
              },
            }
          ]),
          'https://shop.test');
      expect(r.products.single.priceMinor, 125000);
    });

    test('no currency code means no price', () {
      final r = BulkImport.parse(
          woo([
            {
              'id': 9,
              'name': 'Thing',
              'prices': {'price': '1250'},
            }
          ]),
          'https://shop.test');
      expect(r.products.single.priceMinor, isNull);
    });

    test('unknown stock state stays unknown', () {
      final r = BulkImport.parse(
          woo([
            {
              'id': 9,
              'name': 'Thing',
              'prices': {'price': '100', 'currency_code': 'USD'},
            }
          ]),
          'https://shop.test');
      expect(r.products.single.availability, Availability.unknown);
    });
  });

  _fetchTests();

  group('finding the catalogue', () {
    test('both public endpoints are tried for a pasted store address', () {
      final urls = BulkImport.catalogUrls('https://hale.example.com/collections/all');
      expect(urls.map((u) => u.path),
          ['/products.json', '/wp-json/wc/store/v1/products']);
      // Always from the site root, whatever page they pasted from.
      expect(urls.every((u) => u.host == 'hale.example.com'), isTrue);
      expect(urls.first.queryParameters['limit'], '250');
    });

    test('platform is detected from the payload shape, not the URL', () {
      expect(BulkImport.detect(shopify([sProduct()])), StorePlatform.shopify);
      expect(
          BulkImport.detect(jsonEncode([
            {
              'id': 1,
              'prices': {'price': '1'}
            }
          ])),
          StorePlatform.woocommerce);
      expect(BulkImport.detect('<html>nope</html>'), StorePlatform.unknown);
    });

    test('a store on neither platform gets a usable explanation', () {
      final r = BulkImport.parse('<html></html>', 'https://custom.test');
      expect(r.ok, isFalse);
      expect(r.error, contains('one link at a time'));
    });

    test('a junk address yields no candidate URLs', () {
      expect(BulkImport.catalogUrls('not a url'), isEmpty);
    });
  });
}

// --- the fetching layer ------------------------------------------------
//
// Separate from the parser above, which is pure. These cover the things only
// the network path can get wrong: pagination, the cap, and re-reading a
// catalogue once the merchant has told us the currency.

void _fetchTests() {
  /// A fake storefront serving `total` products across pages of 250, plus an
  /// optional /meta.json stating the currency.
  MerchantStore shopWith({required int total, String? metaCurrency}) {
    final client = MockClient((req) async {
      if (req.url.path == '/meta.json') {
        return metaCurrency == null
            ? http.Response('{}', 404)
            : http.Response('{"currency":"$metaCurrency"}', 200);
      }
      if (req.url.path != '/products.json') return http.Response('', 404);
      final page = int.tryParse(req.url.queryParameters['page'] ?? '1') ?? 1;
      final start = (page - 1) * 250;
      final n = (total - start).clamp(0, 250);
      return http.Response(
          shopify([for (var i = 0; i < n; i++) sProduct(id: start + i)]), 200);
    });
    return MerchantStore(client: client);
  }

  group('reading a real storefront', () {
    test('a single page imports with the store\'s own currency', () async {
      final s = shopWith(total: 3, metaCurrency: 'CAD');
      await s.importStore('https://hale.example.com');
      expect(s.bulkFound, hasLength(3));
      expect(s.bulkCurrency, 'CAD');
      expect(s.bulkFound.first.priceMinor, 4900);
      expect(s.bulkFound.first.currency, 'CAD');
      expect(s.bulkDroppedPrices, 0);
    });

    test('pagination follows through to the end', () async {
      final s = shopWith(total: 600, metaCurrency: 'USD');
      await s.importStore('https://hale.example.com');
      expect(s.bulkFound, hasLength(600));
      expect(s.bulkTruncated, isFalse);
    });

    test('A CAP IS REPORTED, never silent', () async {
      // 5 pages x 250. A merchant whose 3000-product shop imports 1250 and
      // is not told will assume the rest simply failed to sell.
      final s = shopWith(total: 3000, metaCurrency: 'USD');
      await s.importStore('https://hale.example.com');
      expect(s.bulkFound, hasLength(1250));
      expect(s.bulkTruncated, isTrue);
    });

    test('a store that does not state its currency loses prices, not products',
        () async {
      final s = shopWith(total: 2);
      await s.importStore('https://hale.example.com');
      expect(s.bulkFound, hasLength(2));
      expect(s.bulkFound.every((p) => p.priceMinor == null), isTrue);
      expect(s.bulkDroppedPrices, 2);
    });

    test('the merchant stating the currency re-reads with it', () async {
      // It re-fetches rather than patching: once a price is dropped the raw
      // figure is gone, and a way to put it back would defeat dropping it.
      final s = shopWith(total: 2);
      await s.importStore('https://hale.example.com');
      expect(s.bulkDroppedPrices, 2);

      await s.importStore('https://hale.example.com', currencyOverride: 'aud');
      expect(s.bulkCurrency, 'AUD');
      expect(s.bulkDroppedPrices, 0);
      expect(s.bulkFound.first.priceMinor, 4900);
    });

    test('a site with no catalogue explains itself', () async {
      final s = MerchantStore(
          client: MockClient((_) async => http.Response('<html>', 200)));
      await s.importStore('https://custom.test');
      expect(s.bulkFound, isEmpty);
      expect(s.bulkError, contains('one link at a time'));
    });

    test('publishing holds back what is not listable, and says how many',
        () async {
      final s = shopWith(total: 3, metaCurrency: 'USD');
      await s.importStore('https://hale.example.com');
      final r = s.publishBulk();
      expect(r.published, 3);
      expect(r.skipped, 0);
      expect(s.listings, hasLength(3));
      expect(s.bulkFound, isEmpty);
    });

    test('an import with no currency publishes nothing, rather than free '
        'products', () async {
      // Every product is missing a price, so none is listable. The shop
      // must not fill with $0 items.
      final s = shopWith(total: 3);
      await s.importStore('https://hale.example.com');
      final r = s.publishBulk();
      expect(r.published, 0);
      expect(r.skipped, 3);
      expect(s.listings, isEmpty);
    });

    test('re-importing updates rather than duplicating', () async {
      final s = shopWith(total: 2, metaCurrency: 'USD');
      await s.importStore('https://hale.example.com');
      s.publishBulk();
      await s.importStore('https://hale.example.com');
      s.publishBulk();
      expect(s.listings, hasLength(2));
    });
  });
}
