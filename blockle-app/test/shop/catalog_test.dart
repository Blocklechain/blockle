// The catalogue's job is to be empty honestly.
//
// Every one of these tests exists because the easy version of this code —
// return a few sample products so the screen looks alive — is indistinguishable
// from a working shop until a real person taps Buy on a price that was never
// real. So the assertions are about what is NOT returned, and about whether
// the UI is given enough to explain itself.
//
// The last group boots the ACTUAL ShopScreen. Unit tests on a source can pass
// while the screen quietly renders a hardcoded demo list beside them; this
// codebase has shipped that exact bug more than once (a feature built, tested
// and never wired, or wired to something other than what was tested). So the
// widget test is forbidden from touching the source classes directly — it
// pumps the real screen and reads what a user would see.

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:blockle_app/screens/shop_screen.dart';
import 'package:blockle_app/liquidity/liquidity_pool.dart';
import 'package:blockle_app/shop/affiliate.dart';
import 'package:blockle_app/shop/catalog.dart';
import 'package:blockle_app/shop/flow.dart';
import 'package:blockle_app/shop/delivery.dart';
import 'package:blockle_app/shop/flow_run.dart';
import 'package:blockle_app/shop/orders.dart';
import 'package:blockle_app/shop/product.dart';
import 'package:blockle_app/shop/ui.dart';
import 'package:blockle_app/state/liquidity_controller.dart';
import 'package:blockle_app/theme.dart';

const _page = '''
<html><head><script type="application/ld+json">
{"@type":"Product","name":"Walnut Desk Lamp","description":"A small lamp.",
 "image":"https://ex.com/l.jpg",
 "offers":{"price":"49.00","priceCurrency":"USD",
           "availability":"https://schema.org/InStock"}}
</script></head></html>''';

MerchantStore storeReturning(String body, {int code = 200}) => MerchantStore(
    client: MockClient((_) async => http.Response(body, code,
        headers: {'content-type': 'text/html; charset=utf-8'})));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('what the shipped app actually searches', () {
    test('Catalog.standard includes the Amazon source', () {
      // Guards main.dart's real wiring, not a Catalog the test built. A
      // source that exists, is unit-tested, and is missing from the app is
      // the exact failure this repo keeps hitting.
      final c = Catalog.standard(
          merchants: MerchantStore(),
          picks: AffiliateStore(store: const _MemStore()));
      expect(c.sources.whereType<AffiliateLinkSource>(), hasLength(1));
      expect(c.sources.whereType<MerchantLinkSource>(), hasLength(1));
      expect(c.sources.whereType<FeedSource>(), hasLength(1));
    });

    test('the two live sources are live, and the feed is not', () {
      final c = Catalog.standard(
          merchants: MerchantStore(),
          picks: AffiliateStore(store: const _MemStore()));
      expect(c.anyLive, isTrue);
      expect(c.offline.whereType<FeedSource>(), hasLength(1));
    });
  });

  group('retailer feeds are off, and say so', () {
    test('an unapproved feed returns nothing and explains why', () async {
      final f = FeedSource();
      expect(f.unavailableReason, isNotNull);
      // The reason is shown to a shopper verbatim, so it has to read like a
      // sentence rather than a flag name.
      expect(f.unavailableReason, contains('datafeed'));
      expect(await f.search('headphones'), isEmpty);
    });

    test('it never fabricates a sample product to look alive', () async {
      // The failure this guards: a placeholder catalogue that ships because
      // it makes the screenshot look finished.
      expect(await FeedSource(credentialsPresent: true).search('anything'),
          isEmpty);
    });

    test('Catalog reports which sources it could not consult', () async {
      final c = Catalog([MerchantLinkSource(MerchantStore()), FeedSource()]);
      await c.search('x');
      expect(c.offline, hasLength(1));
      expect(c.anyLive, isTrue);
    });

    test('one broken source does not take the others down', () async {
      final good = MerchantStore();
      good.listings.add(const Product(
          id: 'a',
          title: 'Lamp',
          merchant: 'm',
          url: 'https://e.com',
          source: ProductSource.merchantEdited,
          priceMinor: 100,
          currency: 'USD',
          description: 'd',
          imageUrl: 'https://e.com/i.jpg'));
      final c = Catalog([_ThrowingSource(), MerchantLinkSource(good)]);
      await c.search('lamp');
      expect(c.results.map((p) => p.title), ['Lamp']);
    });
  });

  group('a seller pastes a link', () {
    test('a readable page becomes a draft, never a live listing', () async {
      final s = storeReturning(_page);
      await s.readLink('https://mystore.example.com/lamp');
      expect(s.draft, isNotNull);
      expect(s.draft!.title, 'Walnut Desk Lamp');
      expect(s.draft!.priceMinor, 4900);
      // THE POINT. Parsed is not published. A parser's guess must pass under
      // the seller's eyes before a shopper can buy against it.
      expect(s.listings, isEmpty);
    });

    test('an incomplete draft cannot be published', () async {
      // No price in this page, so the listing is a dead end.
      final s = storeReturning(
          '<html><head><title>Mystery Item</title></head></html>');
      await s.readLink('https://mystore.example.com/x');
      expect(s.state, DraftState.needsWork);
      expect(s.publish(), isFalse);
      expect(s.listings, isEmpty);
    });

    test('the seller\'s corrections make it publishable', () async {
      final s = storeReturning(
          '<html><head><title>Mystery Item</title></head></html>');
      await s.readLink('https://mystore.example.com/x');
      s.edit(
          priceMinor: 1999,
          currency: 'USD',
          description: 'A mystery.',
          imageUrl: 'https://mystore.example.com/x.jpg');
      expect(s.state, DraftState.ready);
      expect(s.publish(), isTrue);
      expect(s.listings.single.priceMinor, 1999);
      // Attribution changes: the seller stated this, we did not read it.
      expect(s.listings.single.source, ProductSource.merchantEdited);
    });

    test('re-submitting the same link updates, never duplicates', () async {
      final s = storeReturning(_page);
      for (var i = 0; i < 2; i++) {
        await s.readLink('https://mystore.example.com/lamp');
        s.publish();
      }
      expect(s.listings, hasLength(1));
    });

    test('an HTTP error is reported in words a seller can act on', () async {
      final s = storeReturning('nope', code: 403);
      await s.readLink('https://mystore.example.com/lamp');
      expect(s.state, DraftState.failed);
      expect(s.error, contains('403'));
      expect(s.error, contains('not signed in'));
    });

    test('a non-URL is refused before any request is made', () async {
      var called = false;
      final s = MerchantStore(client: MockClient((_) async {
        called = true;
        return http.Response('', 200);
      }));
      await s.readLink('my store dot com');
      expect(called, isFalse);
      expect(s.state, DraftState.failed);
    });

    test('only listable products are searchable', () async {
      final s = storeReturning(_page);
      // Published listing is complete; an unpublished draft must not leak
      // into the shop.
      await s.readLink('https://mystore.example.com/lamp');
      s.publish();
      await s.readLink('https://mystore.example.com/lamp2');
      expect(await MerchantLinkSource(s).search(''), hasLength(1));
    });
  });

  group('the Shop screen itself', () {
    // A TALL SURFACE, deliberately. The default 800x600 test window puts the
    // results below the fold, and ListView builds lazily — so every
    // assertion here would pass vacuously by finding nothing for the wrong
    // reason, including on a screen that renders a fake product just off the
    // bottom. The window is sized so the whole page is built.
    setUp(() {
      final v = TestWidgetsFlutterBinding.instance.platformDispatcher.views
          .first;
      v.physicalSize = const Size(1000, 3000);
      v.devicePixelRatio = 1.0;
    });
    tearDown(() {
      TestWidgetsFlutterBinding.instance.platformDispatcher.views.first
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });

    // Forbidden from calling CatalogSource directly — it must observe what a
    // user sees, or it cannot catch a screen wired to something else.
    Widget app(Catalog c, MerchantStore s,
            {FlowRuns? runs, Orders? orders, AffiliateStore? picks}) =>
        MultiProvider(
          providers: [
            ChangeNotifierProvider<Catalog>.value(value: c),
            ChangeNotifierProvider<MerchantStore>.value(value: s),
            ChangeNotifierProvider<LiquidityService>.value(
                value: LiquidityService.instance),
            ChangeNotifierProvider<FlowRuns>.value(
                value: runs ?? FlowRuns()),
            ChangeNotifierProvider<DeliveryBook>(create: (_) => DeliveryBook()),
            ChangeNotifierProvider<Orders>.value(value: orders ?? Orders()),
            ChangeNotifierProvider<AffiliateStore>.value(
                value: picks ?? AffiliateStore(store: const _MemStore())),
          ],
          child: MaterialApp(theme: Bk.theme(), home: const ShopScreen()),
        );

    testWidgets('shows no products at all when nothing is listed',
        (tester) async {
      final s = MerchantStore();
      await tester.pumpWidget(
          app(Catalog([MerchantLinkSource(s), FeedSource()]), s));
      await tester.pump();

      expect(find.text('No listings yet'), findsOneWidget);
      // And it says WHY the automatic retailer catalogue is absent, rather
      // than looking like a shop that simply has nothing today.
      expect(find.textContaining('datafeed'), findsOneWidget);
    });

    testWidgets('renders a real listing, with the price it was given',
        (tester) async {
      final s = MerchantStore();
      s.listings.add(const Product(
          id: 'a',
          title: 'Walnut Desk Lamp',
          merchant: 'Hale & Co',
          url: 'https://e.com',
          source: ProductSource.merchantEdited,
          priceMinor: 4900,
          currency: 'USD',
          description: 'd',
          imageUrl: 'https://e.com/i.jpg',
          availability: Availability.inStock));
      final c = Catalog([MerchantLinkSource(s)]);
      await tester.pumpWidget(app(c, s));
      await c.search('');
      await tester.pump();

      expect(find.text('Walnut Desk Lamp'), findsOneWidget);
      expect(find.text(r'$49.00'), findsOneWidget);
      expect(find.text('In stock'), findsOneWidget);
    });

    testWidgets('an unfinished money flow is surfaced, not buried',
        (tester) async {
      // THE WIRING GUARD. FlowRuns is unit-tested on its own; this checks the
      // shop screen actually reads it. A run the user started days ago and
      // cannot see is the same as a lost run.
      final runs = FlowRuns(store: _MemStore());
      await runs.start(
          MoneyFlow.getBlock(
              usd: 50,
              solToBlock: SwapQuote(
                  ok: true,
                  amountIn: 0.25,
                  amountOut: 40000,
                  assetIn: 'SOL',
                  assetOut: 'BLOCK',
                  blockPriceUsd: 0.001),
              blockReserve: 1000000,
              onchainSettlement: true,
              buyEnabled: true,
              buyable: const {'SOL', 'USDC', 'ETH', 'BTC'}),
          id: 'r1');
      final s = MerchantStore();
      await tester.pumpWidget(
          app(Catalog([MerchantLinkSource(s)]), s, runs: runs));
      await tester.pump();

      expect(find.text('IN PROGRESS'), findsOneWidget);
      expect(find.text('0/2'), findsOneWidget);
    });

    testWidgets('parcels on the way are counted on the shop screen',
        (tester) async {
      // Wiring guard, same reason as the flow one: Orders is unit-tested
      // separately, and this checks the screen actually reads it.
      final orders = Orders(store: const _MemStore());
      await orders.add(Order(
          id: 'o1',
          merchant: 'Hale & Co',
          placedAt: DateTime.utc(2026, 11, 1),
          state: OrderState.shipped));
      final s = MerchantStore();
      await tester.pumpWidget(
          app(Catalog([MerchantLinkSource(s)]), s, orders: orders));
      await tester.pump();

      expect(find.text('1 on the way'), findsOneWidget);
    });

    testWidgets('an Amazon pick reaches the shop and shows NO PRICE',
        (tester) async {
      // Two guards in one. First the wiring: AffiliateLinkSource is unit
      // tested, but the shop must actually include it in its Catalog.
      // Second the contract: with no Creators API we may not render an
      // Amazon price, so the card must say where the price lives instead of
      // showing a number — and must never show a crypto conversion of one,
      // since a converted price is still a displayed price.
      final picks = AffiliateStore(
          store: const _MemStore(),
          settings: AffiliateSettings(store: const _MemStore()));
      await picks.add(
          ref: Affiliate.parse('https://www.amazon.com/dp/B08N5WRWNW')!,
          title: 'Echo Dot (5th Gen)');

      final s = MerchantStore();
      final c = Catalog([MerchantLinkSource(s), AffiliateLinkSource(picks)]);
      await tester.pumpWidget(app(c, s, picks: picks));
      await c.search('');
      await tester.pump();

      expect(find.text('Echo Dot (5th Gen)'), findsOneWidget);
      expect(find.text('See price on Amazon US'), findsOneWidget);

      // Scoped to the product's own card: the flow cards elsewhere on this
      // screen legitimately show "\$50", so a screen-wide search for a
      // dollar sign would fail for the wrong reason and then get deleted.
      final card = find.ancestor(
          of: find.text('Echo Dot (5th Gen)'), matching: find.byType(ShopCard));
      expect(find.descendant(of: card, matching: find.textContaining(r'\$')),
          findsNothing,
          reason: 'rendered an Amazon price');
      expect(find.descendant(of: card, matching: find.textContaining('≈')),
          findsNothing,
          reason: 'rendered a crypto conversion of an Amazon price — still '
              'a displayed price');
    });

    testWidgets('a listing with no price says so instead of showing \$0.00',
        (tester) async {
      final s = MerchantStore();
      s.listings.add(const Product(
          id: 'a',
          title: 'Unpriced',
          merchant: 'm',
          url: 'https://e.com',
          source: ProductSource.merchantEdited,
          description: 'd',
          imageUrl: 'https://e.com/i.jpg'));
      final c = Catalog([MerchantLinkSource(s)]);
      await tester.pumpWidget(app(c, s));
      await c.search('');
      await tester.pump();

      // It is filtered out of the shop entirely (not listable) — and crucially
      // a zero price is nowhere on screen.
      expect(find.textContaining(r'$0'), findsNothing);
    });
  });
}

/// In-memory storage so a run can be started in a widget test without
/// touching the platform keychain.
class _MemStore extends FlutterSecureStorage {
  const _MemStore();
  @override
  Future<void> write({required String key, required String? value, iOptions,
      aOptions, lOptions, webOptions, mOptions, wOptions}) async {}
  @override
  Future<String?> read({required String key, iOptions, aOptions, lOptions,
          webOptions, mOptions, wOptions}) async =>
      null;
}

class _ThrowingSource extends CatalogSource {
  @override
  String get name => 'broken';
  @override
  String? get unavailableReason => null;
  @override
  Future<List<Product>> search(String q) async => throw StateError('boom');
}
