// MoonPay on-ramp tests — all pure/offline: key-prefix → base, currency-code
// mapping, URL building/encoding, signature append, and the signer fetch over
// an injected HttpSend (no network). BLOCK must never produce a buy URL.

import 'dart:convert';

import 'package:blockle_app/services/moonpay.dart';
import 'package:blockle_app/services/transports.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('base from key prefix', () {
    test('pk_test_ → sandbox', () {
      expect(moonpayBaseForKey('pk_test_abc'),
          'https://buy-sandbox.moonpay.com');
      expect(moonpayBaseForKey(kMoonPayDefaultApiKey),
          'https://buy-sandbox.moonpay.com');
    });
    test('pk_live_ → production', () {
      expect(moonpayBaseForKey('pk_live_xyz'), 'https://buy.moonpay.com');
    });
    test('unknown prefix defaults to sandbox', () {
      expect(moonpayBaseForKey('garbage'),
          'https://buy-sandbox.moonpay.com');
    });
    test('MoonPayConfig derives base + isLive', () {
      const sandbox = MoonPayConfig();
      expect(sandbox.isLive, isFalse);
      expect(sandbox.base, 'https://buy-sandbox.moonpay.com');
      const live = MoonPayConfig(apiKey: 'pk_live_xyz');
      expect(live.isLive, isTrue);
      expect(live.base, 'https://buy.moonpay.com');
    });
  });

  group('sell base from key prefix', () {
    test('pk_test_ → sell sandbox', () {
      expect(moonpaySellBaseForKey('pk_test_abc'),
          'https://sell-sandbox.moonpay.com');
      expect(moonpaySellBaseForKey(kMoonPayDefaultApiKey),
          'https://sell-sandbox.moonpay.com');
    });
    test('pk_live_ → sell production', () {
      expect(moonpaySellBaseForKey('pk_live_xyz'), 'https://sell.moonpay.com');
    });
    test('unknown prefix defaults to sell sandbox', () {
      expect(moonpaySellBaseForKey('garbage'),
          'https://sell-sandbox.moonpay.com');
    });
    test('MoonPayConfig derives sellBase from the same key', () {
      const sandbox = MoonPayConfig();
      expect(sandbox.sellBase, 'https://sell-sandbox.moonpay.com');
      const live = MoonPayConfig(apiKey: 'pk_live_xyz');
      expect(live.sellBase, 'https://sell.moonpay.com');
    });
  });

  group('currency code map', () {
    test('native chains map to their MoonPay code', () {
      expect(moonpayCurrencyCode('ethereum'), 'eth');
      expect(moonpayCurrencyCode('base'), 'eth_base');
      expect(moonpayCurrencyCode('bitcoin'), 'btc');
      expect(moonpayCurrencyCode('litecoin'), 'ltc');
      expect(moonpayCurrencyCode('dogecoin'), 'doge');
      expect(moonpayCurrencyCode('solana'), 'sol');
      expect(moonpayCurrencyCode('polygon'), 'pol_polygon');
      expect(moonpayCurrencyCode('bnb'), 'bnb_bsc');
      expect(moonpayCurrencyCode('avalanche'), 'avax_cchain');
      expect(moonpayCurrencyCode('hyperevm'), 'hype');
    });
    test('kind null/empty/native all resolve to the native code', () {
      expect(moonpayCurrencyCode('ethereum', kind: null), 'eth');
      expect(moonpayCurrencyCode('ethereum', kind: ''), 'eth');
      expect(moonpayCurrencyCode('ethereum', kind: 'native'), 'eth');
    });
    test('BLOCK has no native code', () {
      expect(moonpayCurrencyCode('block'), isNull);
    });
    test('tokens map by chain+symbol, case-insensitive', () {
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'USDC'),
          'usdc');
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'usdc'),
          'usdc');
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'USDT'),
          'usdt');
      expect(
          moonpayCurrencyCode('polygon', kind: 'erc20', symbol: 'USDC'),
          'usdc_polygon');
      expect(
          moonpayCurrencyCode('solana', kind: 'spl', symbol: 'USDC'),
          'usdc_sol');
      // EVM-completion tranche: new ethereum tokens + USDT across chains.
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'XAUT'),
          'xaut');
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'LINK'),
          'link');
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'POL'),
          'pol');
      expect(
          moonpayCurrencyCode('base', kind: 'erc20', symbol: 'USDT'),
          'usdt');
      expect(
          moonpayCurrencyCode('arbitrum', kind: 'erc20', symbol: 'USDT'),
          'usdt_arbitrum');
      expect(
          moonpayCurrencyCode('bnb', kind: 'erc20', symbol: 'USDT'),
          'usdt_bsc');
      expect(
          moonpayCurrencyCode('avalanche', kind: 'erc20', symbol: 'USDC'),
          'usdc_cchain');
      expect(
          moonpayCurrencyCode('solana', kind: 'spl', symbol: 'USDT'),
          'usdt_sol');
    });
    test('unknown token → null (button hidden)', () {
      expect(
          moonpayCurrencyCode('ethereum', kind: 'erc20', symbol: 'SHIB'),
          isNull);
      expect(
          moonpayCurrencyCode('bitcoin', kind: 'erc20', symbol: ''), isNull);
    });
    test('overridable maps', () {
      expect(
          moonpayCurrencyCode('zeta',
              nativeCodes: const {'zeta': 'zeta_coin'}),
          'zeta_coin');
      expect(
          moonpayCurrencyCode('ethereum',
              kind: 'erc20',
              symbol: 'DAI',
              tokenCodes: const {'ethereum:DAI': 'dai'}),
          'dai');
    });
  });

  group('buildMoonPayUrl', () {
    test('required params on the right base, url-encoded', () {
      final url = buildMoonPayUrl(
        apiKey: 'pk_test_abc',
        walletAddress: '0xDEADBEEF',
        currencyCode: 'eth',
      );
      final u = Uri.parse(url);
      expect(u.scheme, 'https');
      expect(u.host, 'buy-sandbox.moonpay.com');
      expect(u.queryParameters['apiKey'], 'pk_test_abc');
      expect(u.queryParameters['currencyCode'], 'eth');
      expect(u.queryParameters['walletAddress'], '0xDEADBEEF');
    });
    test('live key targets production host', () {
      final url = buildMoonPayUrl(
        apiKey: 'pk_live_abc',
        walletAddress: 'addr',
        currencyCode: 'btc',
      );
      expect(Uri.parse(url).host, 'buy.moonpay.com');
    });
    test('optional params included only when set', () {
      final url = buildMoonPayUrl(
        apiKey: 'pk_test_abc',
        walletAddress: 'addr',
        currencyCode: 'eth',
        baseCurrencyCode: 'usd',
        baseCurrencyAmount: '100',
        redirectUrl: 'https://blockle.org/done?x=1',
        colorCode: '#7C5CFF',
        theme: 'dark',
      );
      final q = Uri.parse(url).queryParameters;
      expect(q['baseCurrencyCode'], 'usd');
      expect(q['baseCurrencyAmount'], '100');
      expect(q['redirectURL'], 'https://blockle.org/done?x=1');
      expect(q['colorCode'], '#7C5CFF');
      expect(q['theme'], 'dark');
      // The redirect URL's own query must be percent-encoded, not leak out.
      expect(url.contains('redirectURL=https%3A%2F%2Fblockle.org'), isTrue);
    });
    test('empty optionals are omitted', () {
      final url = buildMoonPayUrl(
        apiKey: 'pk_test_abc',
        walletAddress: 'addr',
        currencyCode: 'eth',
        baseCurrencyCode: '',
        redirectUrl: '',
      );
      final q = Uri.parse(url).queryParameters;
      expect(q.containsKey('baseCurrencyCode'), isFalse);
      expect(q.containsKey('redirectURL'), isFalse);
    });
  });

  group('signature', () {
    test('appendMoonPaySignature url-encodes and uses & when query exists', () {
      const base = 'https://buy-sandbox.moonpay.com/?apiKey=pk_test_abc';
      final signed = appendMoonPaySignature(base, 'ab+/=cd');
      expect(signed.startsWith('$base&signature='), isTrue);
      expect(signed.contains('ab%2B%2F%3Dcd'), isTrue);
    });
  });

  group('signWidgetUrl (injected sender)', () {
    const unsigned = 'https://buy-sandbox.moonpay.com/?apiKey=pk_test_abc';

    test('server returns a fully-signed url', () async {
      HttpReq? seen;
      final out = await signWidgetUrl(
        'https://sign.example/moonpay',
        unsigned,
        send: (req) async {
          seen = req;
          return const HttpReply(200, '{"url":"https://signed.example/x"}');
        },
      );
      expect(out, 'https://signed.example/x');
      expect(seen!.method, 'POST');
      expect(seen!.url, 'https://sign.example/moonpay');
      expect(jsonDecode(seen!.body!)['url'], unsigned);
    });

    test('server returns a bare signature → appended', () async {
      final out = await signWidgetUrl(
        'https://sign.example/moonpay',
        unsigned,
        send: (req) async => const HttpReply(200, '{"signature":"SIG=="}'),
      );
      expect(out, '$unsigned&signature=SIG%3D%3D');
    });

    test('signer error falls back to unsigned', () async {
      final out = await signWidgetUrl(
        'https://sign.example/moonpay',
        unsigned,
        send: (req) async => const HttpReply(500, 'boom'),
      );
      expect(out, unsigned);
    });

    test('signer throwing falls back to unsigned', () async {
      final out = await signWidgetUrl(
        'https://sign.example/moonpay',
        unsigned,
        send: (req) async => throw Exception('network down'),
      );
      expect(out, unsigned);
    });
  });

  group('moonpayBuyUrl end-to-end', () {
    test('BLOCK never produces a url', () async {
      final out = await moonpayBuyUrl(
        config: const MoonPayConfig(),
        chain: 'block',
        walletAddress: 'blk1xyz',
      );
      expect(out, isNull);
    });
    test('empty address → null', () async {
      final out = await moonpayBuyUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '',
      );
      expect(out, isNull);
    });
    test('unsupported asset → null', () async {
      final out = await moonpayBuyUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        kind: 'erc20',
        symbol: 'SHIB',
      );
      expect(out, isNull);
    });
    test('supported native asset, no signer → unsigned sandbox url', () async {
      final out = await moonpayBuyUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        baseCurrencyCode: 'usd',
      );
      expect(out, isNotNull);
      final u = Uri.parse(out!);
      expect(u.host, 'buy-sandbox.moonpay.com');
      expect(u.queryParameters['currencyCode'], 'eth');
      expect(u.queryParameters['walletAddress'], '0xabc');
      expect(u.queryParameters.containsKey('signature'), isFalse);
    });
    test('signer configured → signed url', () async {
      final out = await moonpayBuyUrl(
        config: const MoonPayConfig(signerUrl: 'https://sign.example/mp'),
        chain: 'bitcoin',
        walletAddress: 'bc1qxyz',
        send: (req) async => const HttpReply(200, '{"signature":"ZZ"}'),
      );
      expect(out, isNotNull);
      expect(out!.contains('&signature=ZZ'), isTrue);
      expect(Uri.parse(out).queryParameters['currencyCode'], 'btc');
    });
  });

  group('buildMoonPaySellUrl', () {
    test('crypto is baseCurrencyCode, on the sell base, url-encoded', () {
      final url = buildMoonPaySellUrl(
        apiKey: 'pk_test_abc',
        baseCurrencyCode: 'eth',
      );
      final u = Uri.parse(url);
      expect(u.scheme, 'https');
      expect(u.host, 'sell-sandbox.moonpay.com');
      expect(u.queryParameters['apiKey'], 'pk_test_abc');
      expect(u.queryParameters['baseCurrencyCode'], 'eth');
      // Sell URLs have no currencyCode param (that is the buy shape).
      expect(u.queryParameters.containsKey('currencyCode'), isFalse);
    });
    test('live key targets sell production host', () {
      final url = buildMoonPaySellUrl(
        apiKey: 'pk_live_abc',
        baseCurrencyCode: 'btc',
      );
      expect(Uri.parse(url).host, 'sell.moonpay.com');
    });
    test('optional params included only when set', () {
      final url = buildMoonPaySellUrl(
        apiKey: 'pk_test_abc',
        baseCurrencyCode: 'eth',
        quoteCurrencyCode: 'usd',
        walletAddress: '0xabc',
        baseCurrencyAmount: '0.5',
        redirectUrl: 'https://blockle.org/done?x=1',
        colorCode: '#7C5CFF',
        theme: 'dark',
      );
      final q = Uri.parse(url).queryParameters;
      expect(q['quoteCurrencyCode'], 'usd');
      expect(q['walletAddress'], '0xabc');
      expect(q['baseCurrencyAmount'], '0.5');
      expect(q['redirectURL'], 'https://blockle.org/done?x=1');
      expect(q['colorCode'], '#7C5CFF');
      expect(q['theme'], 'dark');
      expect(url.contains('redirectURL=https%3A%2F%2Fblockle.org'), isTrue);
    });
    test('empty/absent optionals are omitted', () {
      final url = buildMoonPaySellUrl(
        apiKey: 'pk_test_abc',
        baseCurrencyCode: 'eth',
        quoteCurrencyCode: '',
        walletAddress: '',
      );
      final q = Uri.parse(url).queryParameters;
      expect(q.containsKey('quoteCurrencyCode'), isFalse);
      expect(q.containsKey('walletAddress'), isFalse);
    });
  });

  group('moonpaySellUrl end-to-end', () {
    test('BLOCK never produces a sell url', () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'block',
        walletAddress: 'blk1xyz',
      );
      expect(out, isNull);
    });
    test('unsupported asset → null', () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        kind: 'erc20',
        symbol: 'SHIB',
      );
      expect(out, isNull);
    });
    test('supported native asset, no signer → unsigned sell sandbox url',
        () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        quoteCurrencyCode: 'usd',
      );
      expect(out, isNotNull);
      final u = Uri.parse(out!);
      expect(u.host, 'sell-sandbox.moonpay.com');
      expect(u.queryParameters['baseCurrencyCode'], 'eth');
      expect(u.queryParameters['quoteCurrencyCode'], 'usd');
      expect(u.queryParameters['walletAddress'], '0xabc');
      expect(u.queryParameters.containsKey('signature'), isFalse);
    });
    test('token sell resolves to the shared currency code', () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'polygon',
        walletAddress: '0xabc',
        kind: 'erc20',
        symbol: 'USDC',
      );
      expect(out, isNotNull);
      expect(Uri.parse(out!).queryParameters['baseCurrencyCode'],
          'usdc_polygon');
    });
    test('signer configured → signed sell url (host-agnostic signer)',
        () async {
      HttpReq? seen;
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(signerUrl: 'https://sign.example/mp'),
        chain: 'bitcoin',
        walletAddress: 'bc1qxyz',
        send: (req) async {
          seen = req;
          return const HttpReply(200, '{"signature":"ZZ"}');
        },
      );
      expect(out, isNotNull);
      expect(out!.contains('&signature=ZZ'), isTrue);
      expect(Uri.parse(out).queryParameters['baseCurrencyCode'], 'btc');
      // The same signer endpoint is reused, unchanged, for sell URLs.
      expect(seen!.url, 'https://sign.example/mp');
      expect(jsonDecode(seen!.body!)['url'].contains('sell-sandbox'), isTrue);
    });
    test('sell allows an empty address (MoonPay can collect it)', () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '',
      );
      expect(out, isNotNull);
      final u = Uri.parse(out!);
      expect(u.queryParameters['baseCurrencyCode'], 'eth');
      expect(u.queryParameters.containsKey('walletAddress'), isFalse);
    });
    test('held balance > 0 → baseCurrencyAmount pre-filled in sell url',
        () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        baseCurrencyAmount: moonpaySellAmount('2.5'),
      );
      expect(out, isNotNull);
      expect(Uri.parse(out!).queryParameters['baseCurrencyAmount'], '2.5');
    });
    test('zero/unknown held balance → baseCurrencyAmount omitted', () async {
      final out = await moonpaySellUrl(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        baseCurrencyAmount: moonpaySellAmount('0'),
      );
      expect(out, isNotNull);
      expect(Uri.parse(out!).queryParameters.containsKey('baseCurrencyAmount'),
          isFalse);
    });
  });

  group('remote config (fromJson / fromServer)', () {
    test('fromJson maps keys + features and PINS endpoints to the origin', () {
      final cfg = MoonPayConfig.fromJson(const {
        'enabled': true,
        'live': true,
        'publishableKey': 'pk_live_ABC',
        'commercePublicKey': 'pk_commerce_PUB',
        'features': {'buy': true, 'sell': false, 'swap': true, 'commerce': false},
      });
      expect(cfg.apiKey, 'pk_live_ABC');
      expect(cfg.isLive, isTrue);
      expect(cfg.base, 'https://buy.moonpay.com');
      expect(cfg.commercePublicKey, 'pk_commerce_PUB');
      expect(cfg.signerUrl, 'https://blockle.org/account/api/moonpay/sign');
      expect(cfg.swapUrl, 'https://blockle.org/account/api/moonpay/swap');
      expect(cfg.commerceUrl, 'https://blockle.org/account/api/moonpay/commerce');
      expect(cfg.featureBuy, isTrue);
      expect(cfg.featureSell, isFalse);
      expect(cfg.featureSwap, isTrue);
      expect(cfg.featureCommerce, isFalse);
    });
    test('features default ON unless explicitly false; missing pk → default', () {
      final cfg = MoonPayConfig.fromJson(const {'commercePublicKey': 'x'});
      expect(cfg.apiKey, kMoonPayDefaultApiKey);
      expect(cfg.featureBuy, isTrue);
      expect(cfg.featureSell, isTrue);
      expect(cfg.featureSwap, isTrue);
      expect(cfg.featureCommerce, isTrue);
    });
    test('fromJson honours a custom origin for the pinned endpoints', () {
      final cfg = MoonPayConfig.fromJson(const {'publishableKey': 'pk_test_x'},
          origin: 'https://staging.example');
      expect(cfg.signerUrl, 'https://staging.example/account/api/moonpay/sign');
      expect(cfg.swapUrl, 'https://staging.example/account/api/moonpay/swap');
    });
    test('fromServer GETs /config and parses it', () async {
      HttpReq? seen;
      final cfg = await MoonPayConfig.fromServer(
        origin: 'https://blockle.org',
        send: (req) async {
          seen = req;
          return const HttpReply(200,
              '{"enabled":true,"publishableKey":"pk_live_Z","commercePublicKey":"c","features":{"buy":true}}');
        },
      );
      expect(seen!.method, 'GET');
      expect(seen!.url, 'https://blockle.org/account/api/moonpay/config');
      expect(cfg.apiKey, 'pk_live_Z');
      expect(cfg.signerUrl, 'https://blockle.org/account/api/moonpay/sign');
    });
    test('fromServer falls back to the sandbox default on error', () async {
      final cfg = await MoonPayConfig.fromServer(
        send: (req) async => const HttpReply(500, 'boom'),
      );
      expect(cfg.apiKey, kMoonPayDefaultApiKey);
      expect(cfg.isLive, isFalse);
    });
    test('fromServer falls back when the sender throws', () async {
      final cfg = await MoonPayConfig.fromServer(
        send: (req) async => throw Exception('offline'),
      );
      expect(cfg.apiKey, kMoonPayDefaultApiKey);
    });
  });

  group('swap proxy (authed Trade-API relay)', () {
    const cfg = MoonPayConfig(
        swapUrl: 'https://blockle.org/account/api/moonpay/swap');
    test('relays {method,path,query,body} and sets the bearer', () async {
      HttpReq? seen;
      final out = await moonpaySwap(
        'GET',
        '/v3/currencies',
        config: cfg,
        query: const {'limit': '5'},
        bearer: 'tok123',
        send: (req) async {
          seen = req;
          return const HttpReply(200, '{"ok":true}');
        },
      );
      expect(out['ok'], isTrue);
      expect(seen!.method, 'POST');
      expect(seen!.url, 'https://blockle.org/account/api/moonpay/swap');
      expect(seen!.headers['Authorization'], 'Bearer tok123');
      final body = jsonDecode(seen!.body!) as Map<String, dynamic>;
      expect(body['method'], 'GET');
      expect(body['path'], '/v3/currencies');
      expect(body['query'], {'limit': '5'});
    });
    test('omits the Authorization header when no bearer', () async {
      HttpReq? seen;
      await moonpaySwap('GET', '/v3/x', config: cfg, send: (req) async {
        seen = req;
        return const HttpReply(200, '{}');
      });
      expect(seen!.headers.containsKey('Authorization'), isFalse);
    });
    test('throws MoonPayServerException on non-2xx', () async {
      expect(
        () => moonpaySwap('GET', '/v3/x',
            config: cfg, send: (req) async => const HttpReply(401, 'nope')),
        throwsA(isA<MoonPayServerException>()),
      );
    });
    test('swapQuote shapes the quote query', () async {
      HttpReq? seen;
      await moonpaySwapQuote(
        config: cfg,
        sellAsset: 'usdc',
        buyAsset: 'eth',
        amount: 100,
        send: (req) async {
          seen = req;
          return const HttpReply(200, '{}');
        },
      );
      final body = jsonDecode(seen!.body!) as Map<String, dynamic>;
      // MoonPay Trade API: GET /v3/currencies/{sellAsset}/buy_quote with the BUY
      // asset as quoteCurrencyCode (the legacy /v3/quote 404s).
      expect(body['path'], '/v3/currencies/usdc/buy_quote');
      expect((body['query'] as Map)['quoteCurrencyCode'], 'eth');
      expect((body['query'] as Map)['baseCurrencyAmount'], '100');
    });
  });

  group('status (S4)', () {
    test('moonpayTxnFromRedirect parses the callback params', () {
      final t = moonpayTxnFromRedirect(
          Uri.parse('https://blockle.org/done?transactionId=tx1&transactionStatus=completed&currencyCode=eth'));
      expect(t, isNotNull);
      expect(t!.id, 'tx1');
      expect(t.status, 'completed');
      expect(t.asset, 'eth');
      expect(t.type, 'buy');
    });
    test('no transaction id → null', () {
      expect(moonpayTxnFromRedirect(Uri.parse('https://x/done?foo=bar')), isNull);
    });
    test('local-only when no bearer (no poll)', () async {
      var called = false;
      final out = await moonpayStatus(
        config: const MoonPayConfig(),
        local: [
          MoonPayTxn(id: 'a', type: 'buy', status: 'pending', at: DateTime.utc(2024)),
        ],
        send: (req) async {
          called = true;
          return const HttpReply(200, '{}');
        },
      );
      expect(called, isFalse); // no bearer → never polls
      expect(out.length, 1);
      expect(out.first.id, 'a');
    });
    test('merges the authed poll, de-dupes by id, newest first', () async {
      final out = await moonpayStatus(
        config: const MoonPayConfig(
            swapUrl: 'https://blockle.org/account/api/moonpay/swap'),
        bearer: 'tok',
        local: [
          MoonPayTxn(id: 'a', type: 'buy', status: 'pending', at: DateTime.utc(2024, 1, 1)),
        ],
        send: (req) async => HttpReply(200, jsonEncode({
          'transactions': [
            {'id': 'b', 'flow': 'sell', 'status': 'completed', 'createdAt': '2024-06-01T00:00:00Z'},
            {'id': 'a', 'flow': 'buy', 'status': 'completed', 'createdAt': '2024-01-01T00:00:00Z'},
          ]
        })),
      );
      expect(out.map((t) => t.id).toList(), ['b', 'a']); // newest first
      expect(out.firstWhere((t) => t.id == 'a').status, 'completed'); // poll won
    });
    test('a failed poll yields the local set', () async {
      final out = await moonpayStatus(
        config: const MoonPayConfig(
            swapUrl: 'https://blockle.org/account/api/moonpay/swap'),
        bearer: 'tok',
        local: const [MoonPayTxn(id: 'a', type: 'buy', status: 'pending')],
        send: (req) async => const HttpReply(500, 'boom'),
      );
      expect(out.single.id, 'a');
    });
  });

  group('creative helpers', () {
    test('topUpShortfall ceils the USD amount into a buy url', () async {
      final url = await moonpayTopUpShortfall(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        walletAddress: '0xabc',
        shortfallUsd: 12.1,
      );
      expect(url, isNotNull);
      expect(Uri.parse(url!).queryParameters['baseCurrencyAmount'], '13');
      expect(Uri.parse(url).queryParameters['currencyCode'], 'eth');
    });
    test('topUpShortfall → null for BLOCK', () async {
      final url = await moonpayTopUpShortfall(
        config: const MoonPayConfig(),
        chain: 'block',
        walletAddress: 'blk1',
        shortfallUsd: 10,
      );
      expect(url, isNull);
    });
    test('recurringBuyPreset returns a weekly DCA spec + a recurring url', () async {
      final p = await moonpayRecurringBuyPreset(
        config: const MoonPayConfig(),
        chain: 'solana',
        walletAddress: 'soADDR',
        weeklyUsd: 24.2,
      );
      expect(p.botSpec['type'], 'dca');
      expect(p.botSpec['cadence'], 'weekly');
      expect(p.botSpec['allocationUsd'], 25.0); // ceil
      expect(p.url, isNotNull);
      expect(p.url!.contains('recurringBuyFrequency=weekly'), isTrue);
      expect(Uri.parse(p.url!).queryParameters['currencyCode'], 'sol');
    });
    test('recurringBuyPreset still yields a spec when the asset is unsupported',
        () async {
      final p = await moonpayRecurringBuyPreset(
        config: const MoonPayConfig(),
        chain: 'block',
        walletAddress: 'blk1',
        weeklyUsd: 10,
      );
      expect(p.url, isNull);
      expect(p.botSpec['type'], 'dca');
    });
    test('cashOutGains builds a sell url pre-filled with the gain', () async {
      final url = await moonpayCashOutGains(
        config: const MoonPayConfig(),
        chain: 'ethereum',
        kind: 'erc20',
        symbol: 'USDC',
        walletAddress: '0xabc',
        gainAmount: 5.5,
      );
      expect(url, isNotNull);
      final u = Uri.parse(url!);
      expect(u.host, 'sell-sandbox.moonpay.com');
      expect(u.queryParameters['baseCurrencyCode'], 'usdc');
      expect(u.queryParameters['baseCurrencyAmount'], '5.5');
    });
    test('getBlockWithCard step 1 buys USDC on the chosen chain', () async {
      final plan = await moonpayGetBlockWithCard(
        config: const MoonPayConfig(),
        walletAddress: 'soADDR',
        usdAmount: 49.5,
        usdcChain: 'solana',
      );
      expect(plan.ok, isTrue);
      expect(plan.usdcSymbol, 'USDC');
      expect(plan.usdAmount, 50.0); // ceil
      final u = Uri.parse(plan.step1BuyUrl!);
      expect(u.queryParameters['currencyCode'], 'usdc_sol');
      expect(u.queryParameters['walletAddress'], 'soADDR');
    });
    test('getBlockWithCard not-ok with no address', () async {
      final plan = await moonpayGetBlockWithCard(
        config: const MoonPayConfig(),
        walletAddress: '',
        usdAmount: 50,
      );
      expect(plan.ok, isFalse);
      expect(plan.reason, isNotNull);
    });
  });

  group('commerce checkout (M1–M4)', () {
    const cfg = MoonPayConfig(
        commerceUrl: 'https://blockle.org/account/api/moonpay/commerce');
    test('create posts the product/refId/amount and returns the checkout', () async {
      HttpReq? seen;
      final out = await moonpayCommerceCheckout(
        config: cfg,
        product: 'copilot',
        refId: 'sub_1',
        amountUsd: 12,
        bearer: 'tok',
        send: (req) async {
          seen = req;
          return const HttpReply(
              200, '{"checkoutId":"ck_1","hostedUrl":"https://commerce/x"}');
        },
      );
      expect(out.checkoutId, 'ck_1');
      expect(out.hostedUrl, 'https://commerce/x');
      expect(seen!.url, 'https://blockle.org/account/api/moonpay/commerce');
      expect(seen!.headers['Authorization'], 'Bearer tok');
      final body = jsonDecode(seen!.body!) as Map<String, dynamic>;
      expect(body['action'], 'create');
      expect(body['product'], 'copilot');
      expect(body['refId'], 'sub_1');
    });
    test('status posts action:status and returns the status string', () async {
      HttpReq? seen;
      final s = await moonpayCommerceStatus(
        config: cfg,
        checkoutId: 'ck_1',
        bearer: 'tok',
        send: (req) async {
          seen = req;
          return const HttpReply(200, '{"status":"completed"}');
        },
      );
      expect(s, 'completed');
      final body = jsonDecode(seen!.body!) as Map<String, dynamic>;
      expect(body['action'], 'status');
      expect(body['checkoutId'], 'ck_1');
    });
    test('throws on a non-2xx commerce response', () async {
      expect(
        () => moonpayCommerceCheckout(
          config: cfg,
          product: 'nft',
          refId: 'r',
          amountUsd: 1,
          send: (req) async => const HttpReply(403, 'no'),
        ),
        throwsA(isA<MoonPayServerException>()),
      );
    });
  });

  group('moonpaySellAmount (held-balance pre-fill trimming)', () {
    test('positive whole and decimal balances pass through', () {
      expect(moonpaySellAmount('5'), '5');
      expect(moonpaySellAmount('1.5'), '1.5');
    });
    test('strips trailing zeros and thousands commas', () {
      expect(moonpaySellAmount('2.5000'), '2.5');
      expect(moonpaySellAmount('1,234.50'), '1234.5');
    });
    test('caps at 8 fractional digits', () {
      expect(moonpaySellAmount('1.123456789123'), '1.12345678');
    });
    test('zero/blank/unknown/junk → null (omit the amount)', () {
      expect(moonpaySellAmount('0'), isNull);
      expect(moonpaySellAmount('0.00'), isNull);
      expect(moonpaySellAmount(''), isNull);
      expect(moonpaySellAmount('—'), isNull);
      expect(moonpaySellAmount(null), isNull);
      expect(moonpaySellAmount('abc'), isNull);
    });
  });
}
