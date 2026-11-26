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
    // THE SURFACE IS PART OF THE KEY NOW, not stripped.
    //
    // This stub used to erase `/v1` before matching, which made it blind to the
    // bug that shipped: the client asked for `/v1/status`, the real venue
    // serves that under `/public`, and every public read 404'd in production
    // while every test here passed. A stub that discards the part of the URL
    // most likely to be wrong is worse than no stub.
    final path = Uri.parse(req.url).path;
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
        'GET /public/status': {
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
          'GET /public/status': {
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
        'GET /public/markets': [
          {'symbol': 'RTM-USDT', 'base': 'RTM', 'quote': 'USDT', 'baseDecimals': 8, 'quoteDecimals': 6, 'minBase': '1'},
        ],
        'GET /public/tickers': [
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
        'GET /public/markets': [
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
        'GET /public/book/RTM-USDT': {
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
        'GET /public/book/X-Y': {
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
      send: _stub({'GET /v1/balances': <Object>[]}, seen: seen),
      bearer: () => 'sess-123',
    );
    await c.getBalances();
    expect(seen.single.headers['authorization'], 'Bearer sess-123');
    expect(seen.single.headers.containsKey('cookie'), isFalse);
  });

  test('public reads carry NO credential', () async {
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'GET /public/status': {'live': true, 'mainnetEnabled': true, 'legalReviewCompleted': true, 'network': 'mainnet'}}, seen: seen),
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
        'GET /v1/balances': [
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
        'GET /v1/deposit-address': {
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
        'GET /v1/deposit-address': {
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

  test('AN ORDER IS POSTED AS {market, side, amount, price} — STRINGS', () async {
    // TWO ASSERTIONS, AND THE SECOND ONE IS THE BUG THIS TEST USED TO LOCK IN.
    //
    // THE FIELD IS `amount`. This test previously asserted `body['base']`,
    // which is what the client sent — and `POST /v1/orders` reads
    // `str(b, "amount")` (publicapi.ts:800). `str()` throws on a missing key,
    // so the venue answered 400 to every order the app had ever sent: the
    // order form was decorative, and a green test suite said otherwise. A test
    // that asserts the shape the client happens to produce, rather than the
    // shape the server parses, is worse than no test.
    //
    // AND THERE IS NO `type`. The venue has limit orders only and has no such
    // field; sending one was harmless but implied a market order might exist.
    //
    // Strings all the way to the wire, because a price or size that has been
    // through a JSON number has already lost its last digits above 2^53 base
    // units — and an order is a claim on real money.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'POST /v1/orders': {'id': 'o1', 'state': 'open'}}, seen: seen),
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
    expect(body['amount'], '1000.00000001');
    expect(body['price'], '0.00012345');
    expect(body['amount'], isA<String>());
    expect(body['price'], isA<String>());
    expect(body.containsKey('base'), isFalse,
        reason: 'the venue does not read `base` on an order — see above');
    expect(body.containsKey('type'), isFalse,
        reason: 'the venue has no order `type`; it is limit-only');
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
      send: _stub({'POST /v1/orders/o1/cancel': {'state': 'cancelled'}}, seen: seen),
      bearer: () => 't',
    );
    final r = await c.cancelOrder('o1');
    expect(r['state'], 'cancelled');
    expect(seen.single.url, endsWith('/v1/orders/o1/cancel'));
  });

  // ----------------------------------------------------------- price oracle

  test('THE PRICE ORACLE OMITS UNTRADED MARKETS rather than marking them zero',
      () async {
    // This is the seam the 2026-11-06 removal left empty. Marks degraded to
    // "unpriced", which was right; filling it with a zero would be worse than
    // leaving it empty, because a zero looks like a real price.
    final c = ExchangeClient(
      send: _stub({
        'GET /public/markets': [
          {'symbol': 'A-B', 'base': 'A', 'quote': 'B'},
          {'symbol': 'C-D', 'base': 'C', 'quote': 'D'},
        ],
        'GET /public/tickers': [
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

  // --------------------------------------------------------- the surface split

  test('PUBLIC READS GO TO /public AND ACCOUNT CALLS TO /v1', () async {
    // THE BUG THIS PINS. The client was built with a single base of
    // `https://exchange.blockle.org/v1` and paths like `/status` hung off it. The
    // venue serves market data under `/public` and only the account under `/v1`,
    // so every public read 404'd — and because `status()` threw, the controller
    // stored a null status and the Exchange tab reported "unavailable" on iOS.
    // The gate logic was right; it never got an answer to gate on.
    //
    // Asserting the full path, because the surface is the part that was wrong and
    // the old test stub erased it before matching.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({
        'GET /public/status': {
          'live': false, 'mainnetEnabled': false,
          'legalReviewCompleted': false, 'network': 'testnet',
        },
        'GET /public/markets': <Object>[],
        'GET /public/tickers': <Object>[],
        'GET /public/book/X-Y': {'bids': <Object>[], 'asks': <Object>[]},
        'GET /public/trades/X-Y': <Object>[],
        'GET /v1/balances': <Object>[],
        'GET /v1/orders': <Object>[],
      }, seen: seen),
      bearer: () => 'sess',
    );

    await c.status();
    await c.getMarkets();
    await c.getBook('X-Y');
    await c.getTrades('X-Y');
    await c.getBalances();
    await c.getOpenOrders();

    final paths = seen.map((r) => Uri.parse(r.url).path).toList();
    // Every market-data call on the public surface...
    expect(paths, contains('/public/status'));
    expect(paths, contains('/public/markets'));
    expect(paths, contains('/public/book/X-Y'));
    expect(paths, contains('/public/trades/X-Y'));
    // ...and every account call on /v1.
    expect(paths, contains('/v1/balances'));
    expect(paths, contains('/v1/orders'));
    // Nothing may land on the other half: `/v1/status` and `/public/balances`
    // are both 404s on the real venue.
    expect(paths.where((p) => p.startsWith('/v1/')).toList(),
        everyElement(isNot(anyOf(contains('status'), contains('markets'),
            contains('tickers'), contains('book'), contains('trades')))));
    expect(paths.where((p) => p.startsWith('/public/')).toList(),
        everyElement(isNot(anyOf(contains('balances'), contains('orders')))));
  });

  test('a base still carrying the old /v1 suffix is normalised', () async {
    // Absorbs the previous convention rather than producing `/v1/public/status`.
    final seen = <HttpReq>[];
    for (final base in const [
      'https://exchange.blockle.org/v1',
      'https://exchange.blockle.org/',
      'https://exchange.blockle.org',
    ]) {
      final c = ExchangeClient(
        base: base,
        send: _stub({
          'GET /public/status': {
            'live': false, 'mainnetEnabled': false,
            'legalReviewCompleted': false, 'network': 'testnet',
          }
        }, seen: seen),
      );
      await c.status();
    }
    for (final r in seen) {
      expect(Uri.parse(r.url).path, '/public/status', reason: r.url);
    }
  });

  // ------------------------------------------------- the money-moving routes
  //
  // These are the ones where a client bug costs real money, so each test names
  // the loss it prevents rather than the method it calls.

  test('A WITHDRAWAL CARRIES ITS CODE IN THE x-blockle-totp HEADER, '
      'and an idempotency requestId', () async {
    // THE CODE IS PER REQUEST, NOT PER SESSION. The venue spends it on the one
    // withdrawal it authorises, which is what stops a single code buying a
    // window in which an unattended session keeps paying out. In the BODY it
    // would be ignored and the venue would refuse with "not enrolled" — a
    // message that sends the user to the wrong screen.
    //
    // AND THE requestId IS THE DOUBLE-TAP GUARD: the venue keys on it, so the
    // second tap answers with the one withdrawal it already made.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({
        'POST /v1/withdrawals': {
          'id': 'w1', 'state': 'requested', 'asset': 'RTM',
          'network': 'raptoreum', 'amount': '10', 'fee': '1',
          'youReceive': '9', 'address': 'rAbC',
        }
      }, seen: seen),
      bearer: () => 't',
    );
    final r = await c.requestWithdrawal(
      asset: 'RTM',
      network: 'raptoreum',
      amount: '10',
      address: 'rAbC',
      totpCode: '123456',
      requestId: 'req-1',
    );
    expect(seen.single.headers['x-blockle-totp'], '123456');
    final body = jsonDecode(seen.single.body!) as Map<String, dynamic>;
    expect(body['requestId'], 'req-1');
    expect(body['amount'], '10', reason: 'a decimal STRING, never a double');
    expect(r.youReceive, '9');
  });

  test('A WITHDRAWAL WITH NO CODE IS REFUSED BEFORE IT IS SENT', () async {
    // Sending an empty header comes back as the venue's "you are not enrolled"
    // 403, which tells the user to go and set up an authenticator they already
    // have. Refusing here says the true thing: you did not type the code.
    final seen = <HttpReq>[];
    final c = ExchangeClient(send: _stub({}, seen: seen), bearer: () => 't');
    await expectLater(
      () => c.requestWithdrawal(
          asset: 'RTM', amount: '1', address: 'x', totpCode: '  ', requestId: 'r'),
      throwsA(isA<ExchangeException>()),
    );
    expect(seen, isEmpty, reason: 'nothing may reach the venue');
  });

  test('newRequestId IS UNIQUE PER CALL, so two withdrawals are two '
      'withdrawals', () {
    // The flip side of the idempotency key: reusing one across two DIFFERENT
    // withdrawals would silently collapse the second into the first, and the
    // user would believe they had sent twice.
    final ids = {for (var i = 0; i < 50; i++) ExchangeClient.newRequestId()};
    expect(ids.length, 50);
  });

  test('ADDING AN ALLOWLIST ADDRESS NEEDS A CODE; REMOVING ONE DOES NOT',
      () async {
    // Asymmetric on purpose. Adding a destination widens what can be paid, so
    // it needs the second factor — otherwise an attacker holding a session
    // adds their own address and the allowlist cost them one extra request.
    // Removing only ever narrows it, and someone who suspects trouble should
    // not be hunting for their phone to take an address OFF the list.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({
        'POST /v1/allowlist': {
          'ok': true, 'asset': 'RTM', 'address': 'rAbC',
          'usableAt': '2026-11-27T00:00:00.000Z',
        },
        'POST /v1/allowlist/remove': {'ok': true, 'removed': true},
      }, seen: seen),
      bearer: () => 't',
    );
    await c.addToAllowlist(asset: 'RTM', address: 'rAbC', totpCode: '654321');
    expect(seen.last.headers['x-blockle-totp'], '654321');

    expect(await c.removeFromAllowlist(asset: 'RTM', address: 'rAbC'), isTrue);
    expect(seen.last.headers.containsKey('x-blockle-totp'), isFalse);
  });

  test('ADDING AN ALLOWLIST ADDRESS WITHOUT A CODE IS REFUSED LOCALLY',
      () async {
    final seen = <HttpReq>[];
    final c = ExchangeClient(send: _stub({}, seen: seen), bearer: () => 't');
    await expectLater(
      () => c.addToAllowlist(asset: 'RTM', address: 'x', totpCode: ''),
      throwsA(isA<ExchangeException>()),
    );
    expect(seen, isEmpty);
  });

  test('THE NATIVE-CHAIN CONVENTION: a single-chain asset omits the network',
      () async {
    // `network` on a native entry is a LABEL, not a chain id. Sending the
    // symbol back as `network=RTM` 400s every single-chain asset — which is
    // exactly what broke deposit-address issuance for all of them.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({
        'GET /v1/withdrawal-options': {
          'asset': 'RTM',
          'decimals': 8,
          'maxSingleWithdrawal': '1000',
          'networks': [
            {'network': 'RTM', 'native': true, 'label': 'Raptoreum',
             'available': '500', 'open': true},
          ],
        },
        'GET /v1/deposit-address': {
          'asset': 'RTM', 'network': null, 'address': 'rNative',
        },
      }, seen: seen),
      bearer: () => 't',
    );
    final d = await c.withdrawalOptions('RTM');
    final native = d.networks.single;
    expect(native.native, isTrue);
    expect(native.param, isEmpty, reason: 'nothing to send back');

    await c.depositAddress('RTM', network: native.param.isEmpty ? null : native.param);
    expect(Uri.parse(seen.last.url).queryParameters.containsKey('network'), isFalse);
  });

  test('A QUOTE FOR A MULTI-CHAIN ASSET DOES send its network', () async {
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({
        'GET /v1/withdrawal-quote': {
          'asset': 'USDT', 'network': 'erc20', 'amount': '100', 'fee': '8',
          'youReceive': '92', 'minimum': '20', 'gasAsset': 'ETH', 'note': 'n',
        }
      }, seen: seen),
      bearer: () => 't',
    );
    final q = await c.withdrawalQuote(asset: 'USDT', network: 'erc20', amount: '100');
    // The gas asset is NOT the asset being sent, which is why a USDT chain can
    // be shut while the USDT balance is untouched.
    expect(q.gasAsset, 'ETH');
    expect(Uri.parse(seen.single.url).queryParameters['network'], 'erc20');
  });

  test('A CLOSED DEPOSIT CHAIN IS REPORTED WITH ITS REASON, never skipped',
      () async {
    // "No address shown" and "this chain is shut until its gas float is
    // funded" look identical on a screen, and only one of them is worth
    // waiting out.
    final c = ExchangeClient(
      send: _stub({
        'GET /v1/deposit-addresses': {
          'note': 'One address per chain.',
          'addresses': [
            {'asset': 'RTM', 'network': null, 'address': 'rAbC',
             'memo': null, 'memoRequired': false, 'open': true, 'reason': null},
            {'asset': 'USDT', 'network': 'erc20', 'address': null,
             'memo': null, 'memoRequired': false, 'open': false,
             'reason': 'Closed until we can pay this chain\'s network fee.'},
          ],
        }
      }),
      bearer: () => 't',
    );
    final v = await c.depositAddresses();
    expect(v.rows.length, 2);
    expect(v.openCount, 1, reason: 'only one row actually has an address');
    final closed = v.rows[1];
    expect(closed.ready, isFalse);
    expect(closed.reason, contains('network fee'));
  });

  test('AN ORDER LIST READS `total`, so a resting order is not sized ZERO',
      () async {
    // The mapper read `base`, which GET /v1/orders has never returned, so a
    // 1,000-RTM resting order rendered as "SELL 0 RTM-USDT". `base` is the key
    // on the BOOK and the TAPE; an order carries `total`.
    final c = ExchangeClient(
      send: _stub({
        'GET /v1/orders': [
          {'id': 'o1', 'market': 'RTM-USDT', 'side': 'sell', 'state': 'open',
           'price': '0.0005', 'filled': '0', 'total': '1000',
           'createdAt': '2026-11-25T10:00:00.000Z'},
        ]
      }),
      bearer: () => 't',
    );
    final o = (await c.getOpenOrders()).single;
    expect(o.size, 1000);
    expect(o.sizeText, '1000');
    expect(o.createdAt, isNotNull, reason: 'the history column needs it');
    expect(o.open, isTrue);
  });

  test('A LADDER NEVER SENDS acceptLoss UNLESS IT IS PASSED', () async {
    // The venue refuses a below-break-even ladder without it, and defaulting
    // it true would place a money-losing ladder on the user's behalf.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'POST /v1/liquidity': {'id': 'mm_1', 'orders': 6}}, seen: seen),
      bearer: () => 't',
    );
    await c.openLadder(
      market: 'RTM-USDT', mid: '0.0005', spreadBps: 100, rungs: 3,
      baseCapital: '100', quoteCapital: '1',
    );
    expect((jsonDecode(seen.single.body!) as Map)['acceptLoss'], isFalse);
  });

  test('REVOKING A KEY USES DELETE on the key-specific route', () async {
    // The transport had no DELETE verb, so without it the only honest option
    // would be to not offer revocation — i.e. to let a leaked key keep trading
    // because the client could not speak the method.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({'DELETE /v1/api-keys/bk_abc': {'ok': true}}, seen: seen),
      bearer: () => 't',
    );
    await c.revokeApiKey('bk_abc');
    expect(seen.single.method, 'DELETE');
    expect(seen.single.url, endsWith('/v1/api-keys/bk_abc'));
  });

  test('2FA begin RETURNS THE otpauth URI the web throws away', () async {
    // On a phone that URI is a one-tap handoff to the authenticator app that
    // is already installed, which is the biggest ergonomic win this surface
    // has over a desktop. exchange.js ignores the field entirely.
    final c = ExchangeClient(
      send: _stub({
        'POST /v1/2fa/begin': {
          'secret': 'ABCDEFGH',
          'uri': 'otpauth://totp/Blockle%20Exchange:u1?secret=ABCDEFGH',
          'note': 'Scan this.',
        }
      }),
      bearer: () => 't',
    );
    final r = await c.beginTwoFactor();
    expect(r.uri, startsWith('otpauth://'));
    expect(r.secret, 'ABCDEFGH');
  });

  test('EVERY NEW ACCOUNT ROUTE IS ON /v1 AND EVERY NEW PUBLIC READ ON /public',
      () async {
    // The regression that reported "exchange unavailable" on iOS was a base
    // that carried one surface for both. Each route added here is asserted on
    // the half that actually serves it.
    final seen = <HttpReq>[];
    final c = ExchangeClient(
      send: _stub({
        'GET /public/fees': {'makerPct': '0.20%', 'takerPct': '0.20%',
          'makerBps': 20, 'takerBps': 20, 'note': 'n'},
        'GET /public/withdrawal-fees': {'fees': <Object>[], 'note': 'n'},
        'GET /public/reserves': {'disclaimer': 'd', 'assets': <Object>[]},
        'GET /public/liquidity': {'assets': <Object>[]},
        'GET /public/listing-questions': {'questions': <Object>[]},
        'GET /v1/me': {'accountId': 'u1', 'email': 'a@b.c', 'twoFactor': true},
        'GET /v1/deposits': {'deposits': <Object>[]},
        'GET /v1/withdrawals': <Object>[],
        'GET /v1/allowlist': {'addresses': <Object>[], 'cooldownHours': 24,
          'required': true, 'note': 'n'},
        'GET /v1/2fa': {'enrolled': true},
        'GET /v1/api-keys': {'keys': <Object>[], 'signing': {'cannotWithdraw': true}},
        'GET /v1/liquidity': <Object>[],
      }, seen: seen),
      bearer: () => 'sess',
    );
    await c.fees();
    await c.withdrawalFeeSchedule();
    await c.reserves();
    await c.publicLiquidity();
    await c.listingQuestions();
    await c.me();
    await c.deposits();
    await c.withdrawals();
    await c.allowlist();
    await c.twoFactorEnrolled();
    await c.apiKeys();
    await c.ladders();

    final paths = seen.map((r) => Uri.parse(r.url).path).toList();
    expect(paths.where((p) => p.startsWith('/public/')).length, 5);
    expect(paths.where((p) => p.startsWith('/v1/')).length, 7);
    // Nothing may land on the other half: both are 404s on the real venue.
    for (final p in paths) {
      expect(p.startsWith('/public/') || p.startsWith('/v1/'), isTrue, reason: p);
    }
  });

  test('A FEE FIGURE THE VENUE DID NOT SEND RENDERS AS AN EM DASH, not 0',
      () async {
    final c = ExchangeClient(send: _stub({'GET /public/fees': <String, Object>{}}));
    final f = await c.fees();
    expect(f.makerPct, '—');
    expect(f.takerPct, '—');
  });

  test('THE RESERVES DISCLAIMER IS CARRIED VERBATIM', () async {
    // Paraphrasing it is how a disclaimer stops disclaiming: these are
    // self-reported figures from the venue's own ledger, not an audit.
    const d = 'Self-reported figures from our own ledger, published live. '
        'Not an independent audit or attestation.';
    final c = ExchangeClient(
      send: _stub({
        'GET /public/reserves': {
          'disclaimer': d,
          'assets': [
            {'asset': 'RTM', 'owed': '10', 'held': '10', 'fullyBacked': true},
          ],
        }
      }),
    );
    final r = await c.reserves();
    expect(r.disclaimer, d);
    expect(r.assets.single.fullyBacked, isTrue);
  });
}
