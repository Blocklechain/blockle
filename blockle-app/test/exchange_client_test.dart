// Tests for the in-app exchange client, entirely offline.
//
// Each test names the consequence it prevents. The theme is that this client
// talks about real money on a custodial venue, so the failures that matter are
// not crashes — they are plausible-looking wrong numbers, and a wallet that
// quietly does something with custody the user did not ask for.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/services/exchange_client.dart';
import 'package:blockle_app/services/transports.dart';

/// A sender that answers from a table of 'METHOD path' -> body, recording calls.
HttpSend _stub(
  Map<String, Object?> routes, {
  List<HttpReq>? seen,
  int status = 200,
}) {
  return (HttpReq req) async {
    seen?.add(req);
    final path = Uri.parse(req.url).path.replaceFirst('/v1', '');
    final key = '${req.method} $path';
    if (!routes.containsKey(key)) {
      return HttpReply(404, jsonEncode({'error': 'no stub for $key'}));
    }
    final v = routes[key];
    return HttpReply(status, v is String ? v : jsonEncode(v));
  };
}

void main() {
  // ----------------------------------------------------------------- the gate

  test('STATUS IS REPORTED VERBATIM, never interpreted as ready', () async {
    // The venue is not live yet. A client that smoothed this over would let
    // the UI imply live trading on a venue whose legal review is incomplete.
    final c = ExchangeClient(
      send: _stub({
        'GET /status': {
          'live': false,
          'mainnetEnabled': false,
          'legalReviewCompleted': false,
          'network': 'testnet',
        }
      }),
    );
    final s = await c.status();
    expect(s.live, isFalse);
    expect(s.tradable, isFalse, reason: 'nothing may read as tradable here');
    expect(s.network, 'testnet');
  });

  test('tradable requires ALL THREE gates, not just live', () async {
    for (final missing in ['live', 'mainnetEnabled', 'legalReviewCompleted']) {
      final c = ExchangeClient(
        send: _stub({
          'GET /status': {
            'live': missing != 'live',
            'mainnetEnabled': missing != 'mainnetEnabled',
            'legalReviewCompleted': missing != 'legalReviewCompleted',
            'network': 'mainnet',
          }
        }),
      );
      expect((await c.status()).tradable, isFalse,
          reason: 'with $missing false the venue is not tradable');
    }
  });

  // ------------------------------------------------------------ public reads

  test('A MARKET THAT HAS NEVER TRADED REPORTS null, NOT ZERO', () async {
    // "No market yet" and "the market is at zero" are different claims and
    // only one is true before the first fill. A zero here would show a price
    // of 0 on a chart and a portfolio mark of nothing.
    final c = ExchangeClient(
      send: _stub({
        'GET /markets': [
          {'symbol': 'RTM-USDT', 'base': 'RTM', 'quote': 'USDT', 'baseDecimals': 8, 'quoteDecimals': 6, 'minBase': '1'},
        ],
        'GET /tickers': [
          {'market': 'RTM-USDT', 'last': null, 'bid': null, 'ask': null},
        ],
      }),
    );
    final m = (await c.getMarkets()).single;
    expect(m.id, 'RTM-USDT');
    expect(m.pair, 'RTM/USDT');
    expect(m.last, isNull);
    expect(m.quoteDecimals, 6);
    expect(m.minBase, '1');
  });

  test('A TICKER FAILURE STILL YIELDS THE MARKET LIST', () async {
    // Prices are a nicety; the list of what is listed is not. Blanking the
    // whole screen because one call failed is worse than showing no price.
    final c = ExchangeClient(
      send: _stub({
        'GET /markets': [
          {'symbol': 'PEP-BLOCK', 'base': 'PEP', 'quote': 'BLOCK'},
        ],
        // no /tickers stub -> 404
      }),
    );
    final m = await c.getMarkets();
    expect(m, hasLength(1));
    expect(m.single.last, isNull);
  });

  test('A ONE-SIDED BOOK HAS NO MID, rather than half a number', () async {
    final c = ExchangeClient(
      send: _stub({
        'GET /book/RTM-USDT': {
          'bids': [
            {'price': '0.01', 'base': '100'}
          ],
          'asks': <Object>[],
        }
      }),
    );
    final b = await c.getBook('RTM-USDT');
    expect(b!.bids, hasLength(1));
    expect(b.asks, isEmpty);
    expect(b.mid, isNull, reason: 'inventing a mid from one side is a made-up price');
  });

  test('a two-sided book has a mid', () async {
    final c = ExchangeClient(
      send: _stub({
        'GET /book/X-Y': {
          'bids': [
            {'price': '10', 'base': '1'}
          ],
          'asks': [
            {'price': '12', 'base': '1'}
          ],
        }
      }),
    );
    expect((await c.getBook('X-Y'))!.mid, 11);
  });

  // ------------------------------------------------------------------- auth

  test('AN ACCOUNT CALL WITHOUT A SESSION FAILS CLEARLY, and never calls out',
      () async {
    // The failure a user sees must say what to do. It must also not reach the
    // network: an unauthenticated balance request that 401s is noise, and on a
    // venue that answers 503 when accounts are unreachable it could be read as
    // "balance unavailable" instead of "you are not signed in".
    final seen = <HttpReq>[];
    final c = ExchangeClient(send: _stub({}, seen: seen), bearer: () => null);
    expect(c.signedIn, isFalse);
    await expectLater(
      () => c.getBalances(),
      throwsA(isA<ExchangeException>()
          .having((e) => e.status, 'status', 401)
          .having((e) => e.message, 'message', contains('Sign in'))),
    );
    expect(seen, isEmpty, reason: 'no request should have been sent');
  });

  test('THE SESSION GOES AS A BEARER HEADER, not a cookie', () async {
    // A SameSite=Lax cookie does not ride a cross-site fetch from a phone;
    // bearer is the only form that works, and the venue only forwards Bearer.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'GET /balances': <Object>[]}, seen: seen),
      bearer: () => 'sess-123',
    );
    await c.getBalances();
    expect(seen.single.headers['authorization'], 'Bearer sess-123');
    expect(seen.single.headers.containsKey('cookie'), isFalse);
  });

  test('public reads carry NO credential', () async {
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'GET /status': {'live': true, 'mainnetEnabled': true, 'legalReviewCompleted': true, 'network': 'mainnet'}}, seen: seen),
      bearer: () => 'sess-123',
    );
    await c.status();
    expect(seen.single.headers.containsKey('authorization'), isFalse,
        reason: 'the order book is public; sending the session is needless exposure');
  });

  // --------------------------------------------------------------- balances

  test('BALANCES KEEP ALL THREE FIGURES as strings', () async {
    // reserved is why a visible balance will not place an order. And the
    // amounts stay STRINGS: a balance above 2^53 base units has already lost
    // its last digits by the time a double holds it.
    final c = ExchangeClient(
      send: _stub({
        'GET /balances': [
          {
            'asset': 'RTM',
            'total': '123456789012345678',
            'reserved': '12345678',
            'available': '123456776666667670',
            'decimals': 8
          }
        ]
      }),
      bearer: () => 't',
    );
    final b = (await c.getBalances()).single;
    expect(b.total, '123456789012345678');
    expect(b.reserved, '12345678');
    expect(b.decimals, 8);
  });

  // --------------------------------------------------------------- deposits

  test('A REFUSED DEPOSIT ADDRESS PASSES THE REASON THROUGH, never a blank',
      () async {
    // A deposit to a wrong address is unrecoverable by anyone. The venue
    // returns an explanation rather than a guess; showing an empty field
    // instead would invite the user to improvise.
    final c = ExchangeClient(
      send: _stub({
        'GET /deposit-address': {
          'reason': 'RTM deposits are closed until its node finishes syncing',
        }
      }),
      bearer: () => 't',
    );
    final d = await c.depositAddress('RTM');
    expect(d.ready, isFalse);
    expect(d.address, isNull);
    expect(d.reason, contains('finishes syncing'));
  });

  test('a ready deposit target carries the address and its network', () async {
    final c = ExchangeClient(
      send: _stub({
        'GET /deposit-address': {
          'address': 'RASnNhEeAfsrepCLefsugW57A5A1ZLSMW9',
          'network': 'raptoreum',
        }
      }),
      bearer: () => 't',
    );
    final d = await c.depositAddress('RTM', network: 'raptoreum');
    expect(d.ready, isTrue);
    expect(d.network, 'raptoreum');
  });

  // ----------------------------------------------------------------- orders

  test('ORDER AMOUNTS ARE SENT AS STRINGS, never through a double', () async {
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'POST /orders': {'id': 'o1', 'state': 'open'}}, seen: seen),
      bearer: () => 't',
    );
    await c.placeOrder(
      market: 'RTM-USDT',
      side: 'buy',
      type: 'limit',
      size: '1000.00000001',
      price: '0.00012345',
    );
    final body = jsonDecode(seen.single.body!) as Map<String, dynamic>;
    expect(body['base'], '1000.00000001');
    expect(body['price'], '0.00012345');
    expect(body['base'], isA<String>());
    expect(body['price'], isA<String>());
  });

  test('A LIMIT ORDER WITH NO PRICE IS REFUSED BEFORE IT IS SENT', () async {
    // A limit order with no price is either a market order the user did not
    // ask for, or a rejection round trip. Neither should reach the venue.
    final seen = <HttpReq>[];
    final c = ExchangeClient(send: _stub({}, seen: seen), bearer: () => 't');
    await expectLater(
      () => c.placeOrder(market: 'X-Y', side: 'buy', type: 'limit', size: '1'),
      throwsA(isA<ExchangeException>()),
    );
    expect(seen, isEmpty);
  });

  test('cancel posts to the order-specific cancel route', () async {
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'POST /orders/o1/cancel': {'state': 'cancelled'}}, seen: seen),
      bearer: () => 't',
    );
    final r = await c.cancelOrder('o1');
    expect(r['state'], 'cancelled');
    expect(seen.single.url, endsWith('/orders/o1/cancel'));
  });

  // ----------------------------------------------------------- price oracle

  test('THE PRICE ORACLE OMITS UNTRADED MARKETS rather than marking them zero',
      () async {
    // This is the seam the 2026-11-06 removal left empty. Marks degraded to
    // "unpriced", which was right; filling it with a zero would be worse than
    // leaving it empty, because a zero looks like a real price.
    final c = ExchangeClient(
      send: _stub({
        'GET /markets': [
          {'symbol': 'A-B', 'base': 'A', 'quote': 'B'},
          {'symbol': 'C-D', 'base': 'C', 'quote': 'D'},
        ],
        'GET /tickers': [
          {'market': 'A-B', 'last': '1.5'},
          {'market': 'C-D', 'last': null},
        ],
      }),
    );
    final p = await c.lastPrices();
    expect(p['A-B'], 1.5);
    expect(p.containsKey('C-D'), isFalse);
  });

  // ------------------------------------------------------------- transport

  test('AN UNREACHABLE VENUE THROWS, so a caller cannot read it as zero',
      () async {
    final c = ExchangeClient(send: (_) => throw Exception('ECONNREFUSED'));
    await expectLater(() => c.getMarkets(), throwsA(isA<ExchangeException>()));
    expect(c.lastError, contains('unreachable'));
  });

  test('a venue error message is surfaced, not swallowed', () async {
    final c = ExchangeClient(
      send: (_) async => HttpReply(503, jsonEncode({'error': 'halted: reconciliation'})),
    );
    await expectLater(
      () => c.getMarkets(),
      throwsA(isA<ExchangeException>()
          .having((e) => e.message, 'message', contains('halted'))
          .having((e) => e.status, 'status', 503)),
    );
  });
}
