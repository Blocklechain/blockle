// Reading a seller's page must never invent what the page did not say.
//
// The dangerous failure here is not a parse that fails — a merchant fixes
// that in thirty seconds. It is a parse that SUCCEEDS with a wrong price: a
// shipping cost read as the product price, a comma decimal read as a
// thousands separator, a currency assumed because the page was in English.
// Those list someone's product at the wrong number and nobody notices until
// a customer tries to buy it.
//
// So most of these tests check that a field came back NULL.

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/shop/ingest.dart';
import 'package:blockle_app/shop/product.dart';

String ld(String json) =>
    '<html><head><script type="application/ld+json">$json</script>'
    '</head><body></body></html>';

void main() {
  group('structured data', () {
    test('reads a plain schema.org Product', () {
      final r = Ingest.parse(
          ld('''{"@context":"https://schema.org","@type":"Product",
                 "name":"Walnut Desk Lamp","description":"A small lamp.",
                 "brand":{"name":"Hale & Co"},
                 "image":"https://ex.com/lamp.jpg",
                 "offers":{"@type":"Offer","price":"49.00",
                           "priceCurrency":"USD",
                           "availability":"https://schema.org/InStock"}}'''),
          'https://hale.example.com/shop/lamp');
      expect(r.ok, isTrue, reason: r.error);
      final p = r.product!;
      expect(p.title, 'Walnut Desk Lamp');
      expect(p.priceMinor, 4900);
      expect(p.currency, 'USD');
      expect(p.brand, 'Hale & Co');
      expect(p.availability, Availability.inStock);
      expect(p.listable, isTrue);
      expect(r.readFrom, 'structured data');
    });

    test('finds the Product inside a @graph of other types', () {
      // A real store's first JSON-LD block is almost never the product —
      // taking blocks[0] would read an Organization and give up.
      final r = Ingest.parse(
          ld('''{"@context":"https://schema.org","@graph":[
                  {"@type":"Organization","name":"Hale & Co"},
                  {"@type":"BreadcrumbList"},
                  {"@type":"Product","name":"Oak Stool",
                   "offers":{"price":12.5,"priceCurrency":"GBP"}}]}'''),
          'https://hale.example.com/stool');
      expect(r.ok, isTrue);
      expect(r.product!.title, 'Oak Stool');
      expect(r.product!.priceMinor, 1250);
      expect(r.product!.currency, 'GBP');
    });

    test('handles @type given as a list', () {
      final r = Ingest.parse(
          ld('''{"@type":["Product","IndividualProduct"],"name":"Thing",
                 "offers":{"price":"5.00","priceCurrency":"USD"}}'''),
          'https://ex.com/t');
      expect(r.ok, isTrue);
      expect(r.product!.title, 'Thing');
    });

    test('skips a malformed block and keeps reading', () {
      const html = '<html><head>'
          '<script type="application/ld+json">{ not json ,,, }</script>'
          '<script type="application/ld+json">'
          '{"@type":"Product","name":"Survivor",'
          '"offers":{"price":"3.00","priceCurrency":"USD"}}</script>'
          '</head></html>';
      final r = Ingest.parse(html, 'https://ex.com/s');
      expect(r.ok, isTrue);
      expect(r.product!.title, 'Survivor');
    });

    test('takes the low price of an AggregateOffer', () {
      final r = Ingest.parse(
          ld('''{"@type":"Product","name":"Range",
                 "offers":{"@type":"AggregateOffer","lowPrice":"20.00",
                           "highPrice":"40.00","priceCurrency":"USD"}}'''),
          'https://ex.com/r');
      expect(r.product!.priceMinor, 2000);
    });
  });

  group('refuses to guess', () {
    test('a price with no currency is dropped entirely', () {
      // $10 and ¥10 are not the same listing. Assuming USD because the page
      // is in English is a wrong price, not a helpful default.
      final r = Ingest.parse(
          ld('{"@type":"Product","name":"No currency",'
              '"offers":{"price":"10.00"}}'),
          'https://ex.com/n');
      expect(r.ok, isTrue);
      expect(r.product!.priceMinor, isNull);
      expect(r.product!.currency, isNull);
      expect(r.product!.missing, contains('price'));
      expect(r.product!.listable, isFalse);
    });

    test('a comma price is refused rather than guessed', () {
      // "19,99" is 1999 cents in Berlin and malformed in London. Blank is
      // correctable; silently wrong is not.
      final r = Ingest.parse(
          ld('{"@type":"Product","name":"Comma",'
              '"offers":{"price":"19,99","priceCurrency":"EUR"}}'),
          'https://ex.com/c');
      expect(r.product!.priceMinor, isNull);
    });

    test('a thousands separator is refused too', () {
      final r = Ingest.parse(
          ld('{"@type":"Product","name":"Big",'
              '"offers":{"price":"1,299.00","priceCurrency":"USD"}}'),
          'https://ex.com/b');
      expect(r.product!.priceMinor, isNull);
    });

    test('availability is unknown unless the page says', () {
      final r = Ingest.parse(
          ld('{"@type":"Product","name":"Quiet",'
              '"offers":{"price":"1.00","priceCurrency":"USD"}}'),
          'https://ex.com/q');
      expect(r.product!.availability, Availability.unknown);
    });

    test('an out-of-range rating is dropped, not clamped', () {
      // A 9.2/10 scale rendered as 9.2 stars out of 5 is worse than no stars.
      final r = Ingest.parse(
          ld('{"@type":"Product","name":"Rated",'
              '"aggregateRating":{"ratingValue":9.2,"reviewCount":10},'
              '"offers":{"price":"1.00","priceCurrency":"USD"}}'),
          'https://ex.com/x');
      expect(r.product!.rating, isNull);
    });

    test('no discount is reported when the was-price is lower', () {
      const p = Product(
          id: 'x',
          title: 't',
          merchant: 'm',
          url: 'https://e.com',
          source: ProductSource.merchantLink,
          priceMinor: 5000,
          originalPriceMinor: 4000,
          currency: 'USD');
      expect(p.discountPercent, isNull);
    });
  });

  group('page tags fallback', () {
    test('reads Open Graph when there is no structured data', () {
      const html = '<html><head>'
          '<meta property="og:title" content="Linen Shirt">'
          '<meta property="og:site_name" content="Thread Co">'
          '<meta property="og:image" content="https://ex.com/s.jpg">'
          '<meta property="product:price:amount" content="38.00">'
          '<meta property="product:price:currency" content="USD">'
          '</head></html>';
      final r = Ingest.parse(html, 'https://thread.example.com/shirt');
      expect(r.ok, isTrue);
      expect(r.readFrom, 'page tags');
      expect(r.product!.title, 'Linen Shirt');
      expect(r.product!.merchant, 'Thread Co');
      expect(r.product!.priceMinor, 3800);
    });

    test('handles content-before-property attribute order', () {
      const html = '<html><head>'
          '<meta content="Reversed" property="og:title">'
          '</head></html>';
      final r = Ingest.parse(html, 'https://ex.com/r');
      expect(r.product!.title, 'Reversed');
    });

    test('falls back to <title> and unescapes entities', () {
      const html = '<html><head><title>Salt &amp; Pepper Set</title>'
          '</head></html>';
      final r = Ingest.parse(html, 'https://ex.com/sp');
      expect(r.product!.title, 'Salt & Pepper Set');
      // No price anywhere, so the merchant is told what to add.
      expect(r.product!.missing, contains('price'));
    });

    test('merchant falls back to the host, without www', () {
      const html = '<html><head><title>Thing</title></head></html>';
      final r = Ingest.parse(html, 'https://www.shop.example.com/thing');
      expect(r.product!.merchant, 'shop.example.com');
    });
  });

  group('refusals', () {
    test('a page with nothing on it explains itself', () {
      final r = Ingest.parse('<html><body>hello</body></html>',
          'https://ex.com/none');
      expect(r.ok, isFalse);
      expect(r.error, contains('could not find'));
    });

    test('a non-URL is rejected before anything is fetched', () {
      final r = Ingest.parse(ld('{"@type":"Product","name":"x"}'),
          'not a url');
      expect(r.ok, isFalse);
      expect(r.error, contains('web address'));
    });

    test('non-http schemes are rejected', () {
      final r = Ingest.parse(ld('{"@type":"Product","name":"x"}'),
          'file:///etc/passwd');
      expect(r.ok, isFalse);
    });

    test('the same link twice gives the same id, so it updates not duplicates',
        () {
      final a = Ingest.parse(ld('{"@type":"Product","name":"A"}'),
          'https://ex.com/p?utm_source=x');
      final b = Ingest.parse(ld('{"@type":"Product","name":"A"}'),
          'https://ex.com/p?utm_source=y');
      expect(a.product!.id, b.product!.id);
    });
  });

  group('crypto price display', () {
    test('is always marked as an estimate', () {
      final c = CryptoPrice.from(usd: 299, asset: 'BTC', rateUsd: 70000)!;
      expect(c.display, startsWith('≈'));
      expect(c.display, contains('BTC'));
    });

    test('scales decimals to the asset', () {
      expect(CryptoPrice.from(usd: 299, asset: 'BTC', rateUsd: 70000)!
          .amountText, '0.004271');
      expect(CryptoPrice.from(usd: 299, asset: 'BLOCK', rateUsd: 0.001)!
          .amountText, '299000');
    });

    test('is null rather than zero when the rate is unknown', () {
      // "0.0000 BTC" because no rate came back is worse than showing nothing.
      expect(CryptoPrice.from(usd: 299, asset: 'BTC', rateUsd: 0), isNull);
    });
  });
}
