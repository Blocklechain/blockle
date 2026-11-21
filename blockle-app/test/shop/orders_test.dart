// Tracking must not send a shopper to the wrong carrier.
//
// The tempting shortcut is to pick the first carrier whose format matches and
// link to it. Tracking number formats genuinely overlap — a 20-digit number
// is both a USPS and a FedEx shape — so that shortcut sends someone to a
// carrier that has never seen their parcel, which reads as "my order doesn't
// exist". These tests pin the ambiguity being reported rather than resolved.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:blockle_app/shop/orders.dart';

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

void main() {
  group('recognising a carrier', () {
    test('an unmistakable UPS number', () {
      final c = Carrier.detect('1Z999AA10123456784');
      expect(c.map((x) => x.id), ['ups']);
    });

    test('a USPS international label', () {
      final c = Carrier.detect('LZ123456789US');
      expect(c.map((x) => x.id), ['usps']);
    });

    test('a Royal Mail label is not mistaken for USPS', () {
      // Same 13-character shape, different country suffix. Matching on
      // length alone would link a UK parcel to usps.com.
      final c = Carrier.detect('AB123456789GB');
      expect(c.map((x) => x.id), ['royalmail']);
    });

    test('AMBIGUITY IS REPORTED, not resolved', () {
      // 20 digits is a legitimate shape for more than one carrier. The UI
      // asks; it does not pick.
      final c = Carrier.detect('12345678901234567890');
      expect(c.length, greaterThan(1));
      expect(c.map((x) => x.id), containsAll(<String>['usps', 'fedex']));
    });

    test('a pasted number with spaces and lower case still works', () {
      // People paste out of emails. A correct number rejected over a space
      // is a support ticket.
      expect(Carrier.detect('1z999aa1 0123 456784').map((c) => c.id), ['ups']);
    });

    test('nonsense matches nothing rather than guessing', () {
      expect(Carrier.detect('hello'), isEmpty);
      expect(Carrier.detect(''), isEmpty);
      expect(Carrier.detect('12'), isEmpty);
    });

    test('patterns are anchored, so a fragment of a longer id does not match',
        () {
      // Unanchored, '1Z…' would match inside an unrelated string and link
      // the shopper to UPS for something that is not a parcel.
      expect(Carrier.detect('XX1Z999AA10123456784YY'), isEmpty);
    });
  });

  group('linking out', () {
    test('the tracking URL carries the normalised number', () {
      final o = Order(
          id: 'o1',
          merchant: 'Shop',
          placedAt: _epoch,
          trackingNumber: '1z999aa1 0123456784',
          carrierId: 'ups');
      expect(o.trackUrl, contains('1Z999AA10123456784'));
      expect(o.trackUrl, startsWith('https://www.ups.com/track'));
    });

    test('no carrier means no link, rather than a URL that finds nothing', () {
      final o = Order(
          id: 'o1',
          merchant: 'Shop',
          placedAt: _epoch,
          trackingNumber: '1Z999AA10123456784');
      expect(o.trackUrl, isNull);
    });

    test('no tracking number means no link', () {
      final o = Order(
          id: 'o1', merchant: 'Shop', placedAt: _epoch, carrierId: 'ups');
      expect(o.trackUrl, isNull);
    });

    test('live carrier status is off, and the flag says so', () {
      // A plausible "In transit" that was never fetched is the delivery
      // equivalent of inventing a price.
      expect(Carrier.liveStatusAvailable, isFalse);
    });
  });

  group('reading a confirmation page', () {
    test('it recognises one', () {
      expect(
          OrderCapture.looksLikeConfirmation(
              '<h1>Thank you for your order</h1>'),
          isTrue);
      expect(OrderCapture.looksLikeConfirmation('<h1>Our socks</h1>'), isFalse);
    });

    test('it pulls out the order number', () {
      expect(OrderCapture.orderRef('<p>Order number: AB-10932</p>'),
          'AB-10932');
      expect(OrderCapture.orderRef('<p>Order #100042</p>'), '100042');
    });

    test('it declines rather than guessing at a number', () {
      // A wrong order number is worse than none — the shopper quotes it to
      // the shop and is told it does not exist.
      expect(OrderCapture.orderRef('<p>You ordered 2 items</p>'), isNull);
      expect(OrderCapture.orderRef('<p>Order number: 12</p>'), isNull);
    });

    test('it finds a tracking number and attributes it', () {
      final t = OrderCapture.tracking(
          '<p>Tracking: 1Z999AA10123456784 — shipping soon</p>');
      expect(t, isNotNull);
      expect(t!.number, '1Z999AA10123456784');
      expect(t.carriers.single.id, 'ups');
    });

    test('a number it cannot attribute is not reported as tracking', () {
      expect(OrderCapture.tracking('<p>Call us on 555 1234</p>'), isNull);
    });
  });

  group('the order list', () {
    test('orders survive a restart', () async {
      final store = FakeStore();
      final a = Orders(store: store);
      await a.add(Order(
          id: 'o1',
          merchant: 'Hale & Co',
          placedAt: DateTime.utc(2026, 11, 1),
          totalMinor: 4900,
          currency: 'USD'));

      final b = Orders(store: store);
      await b.load();
      expect(b.orders.single.merchant, 'Hale & Co');
      expect(b.orders.single.totalMinor, 4900);
    });

    test('adding the same id updates rather than duplicating', () async {
      final o = Orders(store: FakeStore());
      final base =
          Order(id: 'o1', merchant: 'Shop', placedAt: DateTime.utc(2026));
      await o.add(base);
      await o.add(base.copyWith(trackingNumber: '1Z999AA10123456784'));
      expect(o.orders, hasLength(1));
      expect(o.orders.single.hasTracking, isTrue);
    });

    test('newest first', () async {
      final o = Orders(store: FakeStore());
      await o.add(Order(
          id: 'old', merchant: 'A', placedAt: DateTime.utc(2026, 1, 1)));
      await o.add(Order(
          id: 'new', merchant: 'B', placedAt: DateTime.utc(2026, 6, 1)));
      expect(o.recent.first.id, 'new');
    });

    test('delivered and cancelled drop out of in-flight', () async {
      final o = Orders(store: FakeStore());
      await o.add(Order(
          id: '1',
          merchant: 'A',
          placedAt: DateTime.utc(2026),
          state: OrderState.shipped));
      await o.add(Order(
          id: '2',
          merchant: 'B',
          placedAt: DateTime.utc(2026),
          state: OrderState.delivered));
      await o.add(Order(
          id: '3',
          merchant: 'C',
          placedAt: DateTime.utc(2026),
          state: OrderState.cancelled));
      expect(o.inFlight.map((x) => x.id), ['1']);
    });

    test('a corrupt row does not take the list down', () async {
      final good =
          Order(id: 'ok', merchant: 'A', placedAt: DateTime.utc(2026)).toJson();
      final o = Orders(
          store: FakeStore({'blockle_orders_v1': jsonEncode([good, 7, 'x'])}));
      await o.load();
      expect(o.orders.map((x) => x.id), ['ok']);
    });
  });
}

final _epoch = DateTime.utc(2026);
