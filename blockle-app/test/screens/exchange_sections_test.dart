// exchange_sections_test.dart — widget tests for the exchange sub-sections that
// move money or report on custody.
//
// WHAT THESE TESTS ARE FOR. Every one of them names a way a custody screen can
// lie, and asserts that it does not:
//
//   * a withdrawal must not be sendable without the second factor, and the
//     refusal must happen BEFORE the request leaves the device;
//   * an empty allowlist must say out loud that the venue will refuse the
//     withdrawal, because that is the state the live venue is in for every new
//     account and no other client can fix it;
//   * a closed chain must show the venue's REASON, not a blank row;
//   * an unavailable fee row must be shown as unavailable rather than omitted;
//   * a failed read must print its error and must never render as "you have
//     nothing";
//   * a 2FA check that has not succeeded must never read as "off".
//
// All offline: the controller is handed an ExchangeClient over a stub sender,
// so nothing here touches the network.

import 'dart:convert';

import 'package:blockle_app/screens/exchange/sections/account_section.dart';
import 'package:blockle_app/screens/exchange/sections/pending_sections.dart';
import 'package:blockle_app/screens/exchange/sections/deposit_extras.dart';
import 'package:blockle_app/screens/exchange/sections/fees_section.dart';
import 'package:blockle_app/screens/exchange/sections/withdraw_section.dart';
import 'package:blockle_app/services/exchange_client.dart';
import 'package:blockle_app/services/transports.dart';
import 'package:blockle_app/state/exchange_controller.dart';
import 'package:blockle_app/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

HttpSend _stub(Map<String, Object?> routes, {List<HttpReq>? seen}) {
  return (HttpReq req) async {
    seen?.add(req);
    final key = '${req.method} ${Uri.parse(req.url).path}';
    final v = routes[key];
    if (v == null && !routes.containsKey(key)) {
      return HttpReply(404, jsonEncode({'error': 'no stub for $key'}));
    }
    return HttpReply(200, jsonEncode(v));
  };
}

const _markets = [
  {
    'symbol': 'RTM-USDT',
    'base': 'RTM',
    'quote': 'USDT',
    'baseDecimals': 8,
    'quoteDecimals': 6,
    'minBase': '1',
  },
];

ExchangeController _controller(Map<String, Object?> routes, {List<HttpReq>? seen}) {
  return ExchangeController(
    client: ExchangeClient(send: _stub(routes, seen: seen), bearer: () => 'sess'),
  );
}

Widget _host(Widget child) => MaterialApp(
      theme: Bk.theme(),
      home: Scaffold(body: child),
    );

/// A viewport tall enough that a lazy ListView builds the whole section.
void _tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 5200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  group('WITHDRAW', () {
    testWidgets(
        'AN EMPTY ALLOWLIST SAYS THE VENUE WILL REFUSE, rather than looking ready',
        (tester) async {
      // This is the live venue's state for every new account:
      // WD_REQUIRE_ALLOWLIST is true and no other shipped client can add a
      // destination. A withdrawal form that looked ready here would send the
      // user into a refusal they cannot diagnose.
      _tall(tester);
      final c = _controller({
        'GET /public/status': {
          'live': true, 'mainnetEnabled': true,
          'legalReviewCompleted': true, 'network': 'mainnet',
        },
        'GET /public/markets': _markets,
        'GET /public/tickers': <Object>[],
        'GET /public/book/RTM-USDT': {'bids': <Object>[], 'asks': <Object>[]},
        'GET /public/trades/RTM-USDT': <Object>[],
        'GET /v1/withdrawal-options': {
          'asset': 'RTM',
          'decimals': 8,
          'maxSingleWithdrawal': '1000',
          'networks': [
            {'network': 'RTM', 'native': true, 'label': 'Raptoreum',
             'available': '500', 'open': true},
          ],
        },
        'GET /v1/allowlist': {
          'addresses': <Object>[],
          'cooldownHours': 24,
          'required': true,
          'note': 'A new address becomes usable 24 hours after you add it.',
        },
        'GET /v1/withdrawals': <Object>[],
      });
      await c.loadMarkets();
      await tester.pumpWidget(_host(WithdrawSection(c: c)));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('the venue will refuse any withdrawal of it'),
        findsOneWidget,
      );
      expect(find.text('REQUIRED'), findsOneWidget);
      expect(find.textContaining('Add a RTM destination'), findsOneWidget);
    });

    testWidgets('A WITHDRAWAL WITHOUT A CODE NEVER LEAVES THE DEVICE',
        (tester) async {
      // The code is per request and is spent server-side. Sending an empty one
      // would come back as the venue's "not enrolled" 403, which points the
      // user at a screen they do not need.
      _tall(tester);
      final seen = <HttpReq>[];
      final c = _controller({
        'GET /public/status': {
          'live': true, 'mainnetEnabled': true,
          'legalReviewCompleted': true, 'network': 'mainnet',
        },
        'GET /public/markets': _markets,
        'GET /public/tickers': <Object>[],
        'GET /public/book/RTM-USDT': {'bids': <Object>[], 'asks': <Object>[]},
        'GET /public/trades/RTM-USDT': <Object>[],
        'GET /v1/withdrawal-options': {
          'asset': 'RTM',
          'decimals': 8,
          'maxSingleWithdrawal': '1000',
          'networks': [
            {'network': 'RTM', 'native': true, 'label': 'Raptoreum',
             'available': '500', 'open': true},
          ],
        },
        'GET /v1/allowlist': {
          'addresses': <Object>[],
          'cooldownHours': 24,
          'required': false,
          'note': '',
        },
        'GET /v1/withdrawals': <Object>[],
      }, seen: seen);
      await c.loadMarkets();
      await tester.pumpWidget(_host(WithdrawSection(c: c)));
      await tester.pumpAndSettle();

      await tester.enterText(find.widgetWithText(TextField, 'Amount (RTM)'), '10');
      await tester.enterText(
          find.widgetWithText(TextField, 'Destination address'), 'rDest');
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Withdraw RTM'));
      await tester.pumpAndSettle();

      expect(find.textContaining('6-digit code'), findsWidgets);
      expect(
        seen.where((r) =>
            r.method == 'POST' && Uri.parse(r.url).path == '/v1/withdrawals'),
        isEmpty,
        reason: 'no withdrawal may be attempted without the second factor',
      );
    });

    testWidgets('A CLOSED CHAIN IS DISABLED AND ITS REASON IS SHOWN',
        (tester) async {
      _tall(tester);
      final c = _controller({
        'GET /public/status': {
          'live': true, 'mainnetEnabled': true,
          'legalReviewCompleted': true, 'network': 'mainnet',
        },
        'GET /public/markets': _markets,
        'GET /public/tickers': <Object>[],
        'GET /public/book/RTM-USDT': {'bids': <Object>[], 'asks': <Object>[]},
        'GET /public/trades/RTM-USDT': <Object>[],
        'GET /v1/withdrawal-options': {
          'asset': 'RTM',
          'decimals': 8,
          'maxSingleWithdrawal': '1000',
          'networks': [
            {'network': 'RTM', 'native': true, 'label': 'Raptoreum',
             'available': '0', 'open': false,
             'note': 'Closed until we can pay this chain\'s network fee.'},
          ],
        },
        'GET /v1/allowlist': {
          'addresses': <Object>[], 'cooldownHours': 24,
          'required': false, 'note': '',
        },
        'GET /v1/withdrawals': <Object>[],
      });
      await c.loadMarkets();
      await tester.pumpWidget(_host(WithdrawSection(c: c)));
      await tester.pumpAndSettle();

      expect(find.textContaining('network fee'), findsWidgets);
      // The button is dead while the only chain cannot pay — a refusal the
      // user can see before typing beats one they discover after.
      final btn = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Withdraw RTM'));
      expect(btn.onPressed, isNull);
    });

    testWidgets('A FAILED WITHDRAWAL LIST PRINTS ITS ERROR, never an empty table',
        (tester) async {
      _tall(tester);
      final c = _controller({
        'GET /public/status': {
          'live': true, 'mainnetEnabled': true,
          'legalReviewCompleted': true, 'network': 'mainnet',
        },
        'GET /public/markets': _markets,
        'GET /public/tickers': <Object>[],
        'GET /public/book/RTM-USDT': {'bids': <Object>[], 'asks': <Object>[]},
        'GET /public/trades/RTM-USDT': <Object>[],
        'GET /v1/withdrawal-options': {
          'asset': 'RTM', 'decimals': 8, 'maxSingleWithdrawal': '1000',
          'networks': <Object>[],
        },
        'GET /v1/allowlist': {
          'addresses': <Object>[], 'cooldownHours': 24,
          'required': false, 'note': '',
        },
        // /v1/withdrawals deliberately unstubbed -> 404
      });
      await c.loadMarkets();
      await tester.pumpWidget(_host(WithdrawSection(c: c)));
      await tester.pumpAndSettle();

      expect(find.textContaining('Could not read your withdrawals'),
          findsOneWidget);
      expect(find.textContaining('says nothing about your funds'), findsWidgets);
      expect(find.text('Nothing on its way out.'), findsNothing,
          reason: 'a failure must not be reported as an empty list');
    });
  });

  group('DEPOSIT', () {
    testWidgets('A CLOSED CHAIN IS REPORTED WITH ITS REASON, never skipped',
        (tester) async {
      _tall(tester);
      final c = _controller({
        'GET /v1/deposit-addresses': {
          'note': 'One address per chain, reused forever.',
          'addresses': [
            {'asset': 'RTM', 'network': null, 'address': 'rAbCdEfGhIjKlMnOpQr',
             'memo': null, 'memoRequired': false, 'open': true, 'reason': null},
            {'asset': 'USDT', 'network': 'erc20', 'address': null,
             'memo': null, 'memoRequired': false, 'open': false,
             'reason': 'Closed until we can pay this chain\'s network fee.'},
          ],
        },
      });
      await tester.pumpWidget(_host(ListView(children: [DepositAddressBook(c: c)])));
      await tester.pumpAndSettle();

      // The EXACT count lives in the header; the rail only draws a dot.
      expect(find.textContaining('1 of 2 chains open'), findsOneWidget);
      expect(find.textContaining('network fee'), findsOneWidget);
      expect(find.text('closed'), findsOneWidget);
    });

    testWidgets('A FAILED ADDRESS LOAD SAYS SO INSTEAD OF SHOWING NO ADDRESSES',
        (tester) async {
      // A blank table reads as "you have no addresses", which would send
      // someone looking for a deposit route that already exists.
      _tall(tester);
      final c = _controller(const {});
      await tester.pumpWidget(_host(ListView(children: [DepositAddressBook(c: c)])));
      await tester.pumpAndSettle();

      expect(find.textContaining('Could not read your deposit addresses'),
          findsOneWidget);
    });

    testWidgets('A PENDING DEPOSIT SHOWS ITS N-OF-M CONFIRMATIONS',
        (tester) async {
      _tall(tester);
      final c = _controller({
        'GET /v1/deposits': {
          'deposits': [
            {'asset': 'RTM', 'network': null, 'amount': '12.5', 'txid': 'abc',
             'confirmations': 2, 'outcome': 'pending',
             'detail': '2 of 6 confirmations',
             'firstSeen': '2026-11-25T10:00:00.000Z'},
          ],
        },
      });
      await tester.pumpWidget(_host(ListView(children: [DepositsInFlight(c: c)])));
      await tester.pumpAndSettle();

      expect(find.textContaining('1 waiting to confirm'), findsOneWidget);
      expect(find.text('2 of 6 confirmations'), findsOneWidget);
      expect(find.text('confirming'), findsOneWidget);
    });
  });

  group('FEES', () {
    testWidgets('AN UNAVAILABLE CHAIN IS SHOWN AS CLOSED, not omitted, and the '
        'gas asset is named', (tester) async {
      // Omitting the row reads as "this chain does not exist". And the gas
      // asset is the column people miss: an ERC-20 USDT withdrawal costs ETH,
      // which is why that chain can be shut while the USDT is untouched.
      _tall(tester);
      final c = _controller({
        'GET /public/fees': {
          'makerPct': '0.20%', 'takerPct': '0.20%',
          'makerBps': 20, 'takerBps': 20,
          'note': 'Each side pays a fee on what it receives.',
        },
        'GET /public/withdrawal-fees': {
          'note': 'The fee is withheld from the amount.',
          'fees': [
            {'asset': 'USDT', 'network': 'erc20', 'fee': '8', 'minimum': '20',
             'gasAsset': 'ETH', 'available': false,
             'note': 'No ETH float to pay with.'},
            {'asset': 'RTM', 'network': null, 'fee': '1', 'minimum': '10',
             'gasAsset': 'RTM', 'available': true},
          ],
        },
      });
      await tester.pumpWidget(_host(FeesSection(c: c)));
      await tester.pumpAndSettle();

      expect(find.text('closed'), findsOneWidget);
      expect(find.text('ETH'), findsOneWidget);
      expect(find.text('flat'), findsOneWidget);
      expect(find.textContaining('No ETH float'), findsOneWidget);
      // The maker rebate that does not exist, said out loud, because the
      // ladder screen's break-even depends on it.
      expect(find.textContaining('40 bps'), findsOneWidget);
    });
  });

  group('ACCOUNT', () {
    testWidgets('NO AUTHENTICATOR READS AS "not set up", with the consequence',
        (tester) async {
      _tall(tester);
      final c = _controller({
        'GET /v1/2fa': {'enrolled': false},
        'GET /v1/api-keys': {'keys': <Object>[], 'signing': {'cannotWithdraw': true}},
        'GET /v1/me': {'accountId': 'u1', 'email': 'a@b.c', 'twoFactor': false},
      });
      await tester.pumpWidget(_host(AccountSection(c: c)));
      await tester.pumpAndSettle();

      expect(find.text('not set up'), findsOneWidget);
      expect(find.textContaining('will not pay anything out'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Set one up'), findsOneWidget);
    });

    testWidgets('A FAILED 2FA CHECK IS NEVER RENDERED AS "off"', (tester) async {
      // The dangerous direction. A user told their money is unprotected when it
      // is will turn protection off and on again; a user told it IS protected
      // when the check failed will skip enrolling. Neither state may be
      // guessed, so the panel reports the failure instead.
      _tall(tester);
      final c = _controller({
        'GET /v1/api-keys': {'keys': <Object>[], 'signing': {'cannotWithdraw': true}},
        'GET /v1/me': {'accountId': 'u1', 'email': 'a@b.c', 'twoFactor': null},
        // /v1/2fa deliberately unstubbed -> 404
      });
      await tester.pumpWidget(_host(AccountSection(c: c)));
      await tester.pumpAndSettle();

      expect(find.text('not set up'), findsNothing);
      expect(find.text('on'), findsNothing);
      expect(find.textContaining('Could not read whether a second factor'),
          findsOneWidget);
      // /v1/me said null, which is "not reported" — a third state, not "off".
      expect(find.text('not reported'), findsOneWidget);
      expect(find.text('off'), findsNothing);
    });

    testWidgets('A KEY THAT HAS NEVER BEEN USED SAYS "never", and no key can '
        'withdraw', (tester) async {
      _tall(tester);
      final c = _controller({
        'GET /v1/2fa': {'enrolled': true},
        'GET /v1/me': {'accountId': 'u1', 'email': 'a@b.c', 'twoFactor': true},
        'GET /v1/api-keys': {
          'signing': {'cannotWithdraw': true, 'stringToSign': 'ts+METHOD+path'},
          'keys': [
            {'keyId': 'bk_abc', 'label': 'laptop bot',
             'scopes': ['read', 'trade'], 'ratePerMin': 120,
             'createdAt': '2026-11-20T00:00:00.000Z',
             'lastUsedAt': null, 'revokedAt': null},
          ],
        },
      });
      // THE KEYS LIVE ON THEIR OWN SCREEN NOW, as on the web, instead of
      // being buried at the bottom of Account where nobody found them.
      await tester.pumpWidget(_host(ApiSection(c: c)));
      await tester.pumpAndSettle();

      expect(find.text('never'), findsOneWidget);
      expect(find.text('1 live'), findsOneWidget);
      expect(find.textContaining('withdrawal is not on the list'), findsOneWidget);
    });
  });
}
