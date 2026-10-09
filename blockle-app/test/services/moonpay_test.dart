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
}
