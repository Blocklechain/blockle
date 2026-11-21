// Orders, and where the parcel is.
//
// WHAT THIS DOES AND DOES NOT KNOW.
//
// Blockle is not in the delivery path. It did not take the payment, it is not
// the merchant, and it has no carrier account — so it cannot look up a live
// parcel status, and anything claiming to be one would be invented. What it
// CAN do, with no credentials and no guessing, is:
//
//   - keep the orders in one place, because a shopper who paid with crypto
//     across three merchants currently has three confirmation emails and no
//     list;
//   - recognise a tracking number's carrier from its format, which is public
//     and well-documented;
//   - deep-link straight to that carrier's own tracking page, which is
//     authoritative and always current.
//
// LIVE STATUS IS DELIBERATELY ABSENT, not forgotten. UPS, FedEx, USPS and DHL
// all require an approved API account, and the alternative — showing a
// plausible "In transit" that was never fetched — is the delivery equivalent
// of inventing a price. `Carrier.liveStatusAvailable` is the single flag that
// turns it on when an account exists; until then the UI says the status comes
// from the carrier's page.
//
// DETECTION REPORTS AMBIGUITY RATHER THAN GUESSING. A bare 12-digit number is
// genuinely FedEx-or-other; `detect` returns every carrier whose format
// matches, and the UI asks rather than picking one and linking the shopper to
// a carrier that has never heard of their parcel.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A shipping carrier we can recognise and link to.
class Carrier {
  const Carrier(this.id, this.name, this._pattern, this._url);

  final String id;
  final String name;
  final RegExp _pattern;
  final String _url;

  /// Live parcel status needs an approved carrier API account. None is
  /// configured, and the UI must say so rather than show a status it never
  /// fetched. Flipping this is the whole change when one is approved.
  static const bool liveStatusAvailable = false;

  bool matches(String n) => _pattern.hasMatch(n);

  /// The carrier's own tracking page — authoritative, and current without us
  /// having to poll anything.
  String trackUrl(String number) =>
      _url.replaceAll('{n}', Uri.encodeQueryComponent(number));

  /// Formats are public and documented. Anchored, because an unanchored
  /// pattern matches a fragment of an unrelated number.
  static final all = <Carrier>[
    Carrier('ups', 'UPS', RegExp(r'^1Z[0-9A-Z]{16}$'),
        'https://www.ups.com/track?tracknum={n}'),
    Carrier(
        'usps',
        'USPS',
        // The international 13-char form, plus the long domestic forms.
        RegExp(r'^([A-Z]{2}\d{9}US|(94|93|92|95|82)\d{18,20}|\d{20,22})$'),
        'https://tools.usps.com/go/TrackConfirmAction?tLabels={n}'),
    Carrier('fedex', 'FedEx', RegExp(r'^(\d{12}|\d{15}|\d{20}|\d{22})$'),
        'https://www.fedex.com/fedextrack/?trknbr={n}'),
    Carrier('dhl', 'DHL', RegExp(r'^(\d{10,11}|[A-Z]{3}\d{7})$'),
        'https://www.dhl.com/en/express/tracking.html?AWB={n}'),
    Carrier('royalmail', 'Royal Mail', RegExp(r'^[A-Z]{2}\d{9}GB$'),
        'https://www.royalmail.com/track-your-item#/tracking-results/{n}'),
    Carrier('dpd', 'DPD', RegExp(r'^\d{14}$'),
        'https://track.dpd.co.uk/search?reference={n}'),
  ];

  /// Normalise before matching: people paste tracking numbers with spaces and
  /// in lower case, and a carrier that "does not recognise" a correct number
  /// because of a space is a support ticket.
  static String normalise(String raw) =>
      raw.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');

  /// Every carrier whose format matches, in order.
  ///
  /// Returns a LIST because the formats genuinely overlap — a 20-digit number
  /// is both a USPS and a FedEx shape, and a 22-digit one likewise. Picking
  /// the first would send a shopper to a carrier that has never seen their
  /// parcel and tell them their order does not exist.
  static List<Carrier> detect(String raw) {
    final n = normalise(raw);
    if (n.isEmpty) return const [];
    return all.where((c) => c.matches(n)).toList();
  }

  static Carrier? byId(String? id) {
    if (id == null) return null;
    for (final c in all) {
      if (c.id == id) return c;
    }
    return null;
  }
}

/// How far along an order is, as far as the USER has told us.
///
/// These are the shopper's own notes, not a carrier feed. Named so the UI
/// cannot accidentally present them as tracked status.
enum OrderState { placed, shipped, delivered, cancelled }

extension OrderStateLabel on OrderState {
  String get label => switch (this) {
        OrderState.placed => 'Ordered',
        OrderState.shipped => 'Shipped',
        OrderState.delivered => 'Delivered',
        OrderState.cancelled => 'Cancelled',
      };
}

class Order {
  const Order({
    required this.id,
    required this.merchant,
    required this.placedAt,
    this.title,
    this.totalMinor,
    this.currency,
    this.orderRef,
    this.trackingNumber,
    this.carrierId,
    this.state = OrderState.placed,
    this.url,
    this.flowRunId,
  });

  final String id;
  final String merchant;
  final DateTime placedAt;

  final String? title;

  /// MINOR UNITS, like Product — same reason.
  final int? totalMinor;
  final String? currency;

  /// The merchant's own order number, which is what a shopper quotes when
  /// they contact the shop.
  final String? orderRef;

  final String? trackingNumber;
  final String? carrierId;
  final OrderState state;
  final String? url;

  /// Links an order back to the money flow that paid for it, so a user can
  /// see the swap, the payout and the parcel as one thing.
  final String? flowRunId;

  Carrier? get carrier => Carrier.byId(carrierId);

  bool get hasTracking =>
      trackingNumber != null && trackingNumber!.trim().isNotEmpty;

  /// Null when we cannot link anywhere — which is honest, rather than a
  /// search URL that returns nothing.
  String? get trackUrl {
    final c = carrier;
    if (c == null || !hasTracking) return null;
    return c.trackUrl(Carrier.normalise(trackingNumber!));
  }

  double? get total => totalMinor == null ? null : totalMinor! / 100.0;

  Order copyWith({
    String? title,
    int? totalMinor,
    String? currency,
    String? orderRef,
    String? trackingNumber,
    String? carrierId,
    OrderState? state,
    String? url,
  }) =>
      Order(
        id: id,
        merchant: merchant,
        placedAt: placedAt,
        title: title ?? this.title,
        totalMinor: totalMinor ?? this.totalMinor,
        currency: currency ?? this.currency,
        orderRef: orderRef ?? this.orderRef,
        trackingNumber: trackingNumber ?? this.trackingNumber,
        carrierId: carrierId ?? this.carrierId,
        state: state ?? this.state,
        url: url ?? this.url,
        flowRunId: flowRunId,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'merchant': merchant,
        'placedAt': placedAt.toIso8601String(),
        if (title != null) 'title': title,
        if (totalMinor != null) 'totalMinor': totalMinor,
        if (currency != null) 'currency': currency,
        if (orderRef != null) 'orderRef': orderRef,
        if (trackingNumber != null) 'trackingNumber': trackingNumber,
        if (carrierId != null) 'carrierId': carrierId,
        'state': state.name,
        if (url != null) 'url': url,
        if (flowRunId != null) 'flowRunId': flowRunId,
      };

  static Order fromJson(Map<String, dynamic> j) => Order(
        id: '${j['id'] ?? ''}',
        merchant: '${j['merchant'] ?? ''}',
        placedAt:
            DateTime.tryParse('${j['placedAt']}') ?? DateTime.now().toUtc(),
        title: j['title'] as String?,
        totalMinor: (j['totalMinor'] as num?)?.toInt(),
        currency: j['currency'] as String?,
        orderRef: j['orderRef'] as String?,
        trackingNumber: j['trackingNumber'] as String?,
        carrierId: j['carrierId'] as String?,
        state: OrderState.values.firstWhere((s) => s.name == j['state'],
            orElse: () => OrderState.placed),
        url: j['url'] as String?,
        flowRunId: j['flowRunId'] as String?,
      );
}

/// Reads an order confirmation page.
///
/// A shopper who has just checked out is on a page that states their order
/// number and total; asking them to retype it into Blockle is how an order
/// list stays empty. This pulls out ONLY what the page plainly says and hands
/// it over for confirmation — the same rule as the product parser. Nothing is
/// saved without the user agreeing to it.
class OrderCapture {
  /// Does this look like a confirmation page at all? Used to decide whether
  /// to OFFER to save an order, never to save one silently.
  static bool looksLikeConfirmation(String html) {
    final h = html.toLowerCase();
    const phrases = [
      'thank you for your order',
      'order confirmed',
      'order confirmation',
      'your order has been placed',
      'order number',
      'order #',
    ];
    return phrases.any(h.contains);
  }

  /// The merchant's order reference, if the page states one.
  ///
  /// Conservative on purpose: a wrong order number is worse than none,
  /// because the shopper quotes it to the shop and is told it does not exist.
  static String? orderRef(String html) {
    final pats = [
      RegExp(r'order\s*(?:number|no\.?|#)\s*[:\s]\s*([A-Z0-9][A-Z0-9-]{3,24})',
          caseSensitive: false),
      RegExp(r'order\s*#\s*([A-Z0-9][A-Z0-9-]{3,24})', caseSensitive: false),
      RegExp(r'confirmation\s*(?:number|code)\s*[:\s]\s*([A-Z0-9-]{4,24})',
          caseSensitive: false),
    ];
    for (final p in pats) {
      final m = p.firstMatch(html);
      final v = m?.group(1)?.trim();
      // A capture of only digits shorter than 4 is far more likely to be a
      // quantity or a date fragment than an order number.
      if (v != null && v.length >= 4) return v;
    }
    return null;
  }

  /// Any tracking number on the page whose carrier we recognise.
  ///
  /// Only returns one we can attribute to a carrier — an unattributable
  /// number is not useful and may not be a tracking number at all.
  static ({String number, List<Carrier> carriers})? tracking(String html) {
    // Candidate tokens: the shapes tracking numbers actually take.
    final tokens = RegExp(r'\b(1Z[0-9A-Z]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d{10,22})\b')
        .allMatches(html.toUpperCase())
        .map((m) => m.group(1)!)
        .toSet();
    for (final tok in tokens) {
      final c = Carrier.detect(tok);
      if (c.isNotEmpty) return (number: tok, carriers: c);
    }
    return null;
  }
}

/// The user's orders.
class Orders extends ChangeNotifier {
  Orders({FlutterSecureStorage? store})
      : _store = store ?? const FlutterSecureStorage();

  static const _key = 'blockle_orders_v1';
  final FlutterSecureStorage _store;

  final List<Order> orders = [];

  /// Newest first — a shopper is almost always looking for the last thing
  /// they bought.
  List<Order> get recent =>
      [...orders]..sort((a, b) => b.placedAt.compareTo(a.placedAt));

  List<Order> get inFlight => recent
      .where((o) =>
          o.state == OrderState.placed || o.state == OrderState.shipped)
      .toList();

  Future<void> load() async {
    try {
      final raw = await _store.read(key: _key);
      if (raw == null) return;
      final list = jsonDecode(raw);
      if (list is! List) return;
      orders
        ..clear()
        ..addAll(list.whereType<Map<String, dynamic>>().map(Order.fromJson));
      notifyListeners();
    } catch (_) {}
  }

  Future<void> _persist() async {
    try {
      await _store.write(
          key: _key, value: jsonEncode(orders.map((o) => o.toJson()).toList()));
    } catch (_) {}
  }

  Future<void> add(Order o) async {
    final at = orders.indexWhere((x) => x.id == o.id);
    if (at >= 0) {
      orders[at] = o;
    } else {
      orders.add(o);
    }
    await _persist();
    notifyListeners();
  }

  Future<void> update(String id, Order Function(Order) f) async {
    final at = orders.indexWhere((o) => o.id == id);
    if (at < 0) return;
    orders[at] = f(orders[at]);
    await _persist();
    notifyListeners();
  }

  Future<void> remove(String id) async {
    orders.removeWhere((o) => o.id == id);
    await _persist();
    notifyListeners();
  }
}
