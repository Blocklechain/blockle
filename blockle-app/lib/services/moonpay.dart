// moonpay.dart — MoonPay fiat on-ramp ("Buy with card").
//
// Opening the MoonPay buy widget is just opening a URL with query params:
//   apiKey, walletAddress, currencyCode, [baseCurrencyCode], [baseCurrencyAmount],
//   [redirectURL], [colorCode] / [theme].
// MoonPay hosts the KYC + card/bank payment flow and delivers the purchased
// crypto to walletAddress. This wallet NEVER sees card data or PII.
//
// SECURITY: the publishable key (pk_test_… / pk_live_…) is CLIENT-side and safe
// to embed. The SECRET key is NEVER embedded here — production URL signing is
// done SERVER-SIDE by an optional signer endpoint (see [signWidgetUrl]); this
// client only ever sends the unsigned query to that endpoint and appends the
// signature it returns. Sandbox URLs for pk_test_ keys work unsigned.

import 'dart:convert';

import 'transports.dart' show HttpSend, HttpReq, httpSend;

/// The default publishable (test/sandbox) key. CLIENT-side, safe to commit.
/// Swap for a pk_live_… key on approval via [MoonPayConfig] override.
const String kMoonPayDefaultApiKey = 'pk_test_uRXfpYr99uQJibabWff6BlZYIzzFONLF';

/// Config for the on-ramp. [apiKey] is overridable; [signerUrl] is an optional
/// SERVER-SIDE signing endpoint for production (HMAC-SHA256 over the query).
class MoonPayConfig {
  const MoonPayConfig({
    this.apiKey = kMoonPayDefaultApiKey,
    this.signerUrl,
  });

  final String apiKey;
  final String? signerUrl;

  bool get isLive => apiKey.startsWith('pk_live_');

  /// The hosted-widget base, derived from the key prefix:
  ///   pk_live_… -> https://buy.moonpay.com
  ///   anything else (pk_test_…) -> https://buy-sandbox.moonpay.com
  String get base => moonpayBaseForKey(apiKey);

  /// The hosted SELL-widget (off-ramp) base, derived from the same key prefix:
  ///   pk_live_… -> https://sell.moonpay.com
  ///   anything else (pk_test_…) -> https://sell-sandbox.moonpay.com
  String get sellBase => moonpaySellBaseForKey(apiKey);
}

/// Derive the buy-widget base URL from the publishable key prefix. A pk_live_
/// key targets production; every other prefix (pk_test_…) targets sandbox.
String moonpayBaseForKey(String apiKey) =>
    apiKey.startsWith('pk_live_')
        ? 'https://buy.moonpay.com'
        : 'https://buy-sandbox.moonpay.com';

/// Derive the SELL-widget base URL from the publishable key prefix. A pk_live_
/// key targets production; every other prefix (pk_test_…) targets sandbox.
/// Mirrors [moonpayBaseForKey] but for the off-ramp (cash-out) widget.
String moonpaySellBaseForKey(String apiKey) =>
    apiKey.startsWith('pk_live_')
        ? 'https://sell.moonpay.com'
        : 'https://sell-sandbox.moonpay.com';

/// Best-effort native-asset → MoonPay currencyCode map, keyed by this wallet's
/// internal chain id. Overridable. A chain absent here (e.g. `block`) has no
/// MoonPay code → the Buy button is hidden for its native asset.
const Map<String, String> kMoonPayNativeCodes = {
  'ethereum': 'eth',
  'base': 'eth_base',
  'arbitrum': 'eth_arbitrum',
  'optimism': 'eth_optimism',
  'polygon': 'pol_polygon',
  'bnb': 'bnb_bsc',
  'avalanche': 'avax_cchain',
  'bitcoin': 'btc',
  'litecoin': 'ltc',
  'dogecoin': 'doge',
  'solana': 'sol',
  // 'block' intentionally absent — BLOCK is not on MoonPay.
};

/// Best-effort token → MoonPay currencyCode map, keyed by `"<chain>:<SYMBOL>"`
/// (symbol upper-cased). Overridable. A token absent here has no MoonPay code →
/// the Buy button is hidden for it.
const Map<String, String> kMoonPayTokenCodes = {
  'ethereum:USDC': 'usdc',
  'ethereum:USDT': 'usdt',
  'base:USDC': 'usdc_base',
  'arbitrum:USDC': 'usdc_arbitrum',
  'optimism:USDC': 'usdc_optimism',
  'polygon:USDC': 'usdc_polygon',
  'polygon:USDT': 'usdt_polygon',
  'solana:USDC': 'usdc_sol',
};

/// Resolve the MoonPay currencyCode for an asset on [chain].
///
/// [kind] is the asset kind from the wallet (null / 'native' for the chain's
/// coin, otherwise a token kind like 'erc20' / 'spl'); [symbol] is the token
/// symbol (ignored for native). Returns null when there is no known MoonPay
/// code — callers HIDE the Buy button in that case.
///
/// [nativeCodes] / [tokenCodes] default to the built-in maps but are injectable
/// for config overrides and tests.
String? moonpayCurrencyCode(
  String chain, {
  String? kind,
  String? symbol,
  Map<String, String> nativeCodes = kMoonPayNativeCodes,
  Map<String, String> tokenCodes = kMoonPayTokenCodes,
}) {
  final isNative = kind == null || kind.isEmpty || kind == 'native';
  if (isNative) return nativeCodes[chain];
  final sym = (symbol ?? '').trim().toUpperCase();
  if (sym.isEmpty) return null;
  return tokenCodes['$chain:$sym'];
}

/// Whether BLOCK (the one asset never on MoonPay). BLOCK shows a swap note, not
/// a Buy-with-card button.
bool moonpayIsBlock(String chain) => chain == 'block';

/// Build the (UNSIGNED) MoonPay buy-widget URL.
///
/// Required: [apiKey], [walletAddress] (the receive address on that chain) and
/// [currencyCode] (from [moonpayCurrencyCode]). Optional: [baseCurrencyCode]
/// (fiat, e.g. 'usd'), [baseCurrencyAmount], [redirectUrl], [colorCode] (hex
/// '#rrggbb'), [theme] ('dark' | 'light'). The base is derived from the key.
///
/// For production, pass the returned URL through [signWidgetUrl] to append the
/// server-computed &signature; sandbox (pk_test_) URLs work unsigned.
String buildMoonPayUrl({
  required String apiKey,
  required String walletAddress,
  required String currencyCode,
  String? baseCurrencyCode,
  String? baseCurrencyAmount,
  String? redirectUrl,
  String? colorCode,
  String? theme,
}) {
  final params = <String, String>{
    'apiKey': apiKey,
    'currencyCode': currencyCode,
    'walletAddress': walletAddress,
  };
  if (baseCurrencyCode != null && baseCurrencyCode.isNotEmpty) {
    params['baseCurrencyCode'] = baseCurrencyCode;
  }
  if (baseCurrencyAmount != null && baseCurrencyAmount.isNotEmpty) {
    params['baseCurrencyAmount'] = baseCurrencyAmount;
  }
  if (redirectUrl != null && redirectUrl.isNotEmpty) {
    params['redirectURL'] = redirectUrl;
  }
  if (colorCode != null && colorCode.isNotEmpty) {
    params['colorCode'] = colorCode;
  }
  if (theme != null && theme.isNotEmpty) {
    params['theme'] = theme;
  }
  // Uri handles RFC 3986 percent-encoding of each value.
  final uri = Uri.parse(moonpayBaseForKey(apiKey)).replace(
    path: '/',
    queryParameters: params,
  );
  return uri.toString();
}

/// Append a server-computed signature to an unsigned widget [url].
///
/// [signature] is the base64 HMAC-SHA256 of the URL's query string, computed by
/// the SERVER (the secret key never leaves the server). Returns the URL with a
/// url-encoded `&signature=` appended.
String appendMoonPaySignature(String url, String signature) {
  final sep = url.contains('?') ? '&' : '?';
  return '$url${sep}signature=${Uri.encodeQueryComponent(signature)}';
}

/// Fetch a signed widget URL from the optional server-side [signerUrl].
///
/// Sends the UNSIGNED [unsignedUrl] to the signer (POST JSON `{"url": …}`) and
/// expects back either `{"url": "<fully-signed url>"}` or
/// `{"signature": "<base64>"}`. Returns the signed URL, or the original
/// unsigned URL if the signer is unavailable/misbehaving (sandbox still works).
///
/// NOTE: no secret is ever sent from the client — the signer holds it.
Future<String> signWidgetUrl(
  String signerUrl,
  String unsignedUrl, {
  HttpSend send = httpSend,
}) async {
  try {
    final reply = await send(HttpReq(
      'POST',
      signerUrl,
      headers: const {'content-type': 'application/json'},
      body: jsonEncode({'url': unsignedUrl}),
    ));
    if (reply.status >= 400) return unsignedUrl;
    final j = jsonDecode(reply.body);
    if (j is Map) {
      final signed = j['url'];
      if (signed is String && signed.isNotEmpty) return signed;
      final sig = j['signature'];
      if (sig is String && sig.isNotEmpty) {
        return appendMoonPaySignature(unsignedUrl, sig);
      }
    }
  } catch (_) {
    // fall through to unsigned (sandbox-safe)
  }
  return unsignedUrl;
}

/// One-call helper: resolve the asset code, build the URL, and (if a signer is
/// configured) sign it. Returns null when the asset has no MoonPay code.
Future<String?> moonpayBuyUrl({
  required MoonPayConfig config,
  required String chain,
  required String walletAddress,
  String? kind,
  String? symbol,
  String? baseCurrencyCode,
  String? baseCurrencyAmount,
  String? redirectUrl,
  String? colorCode,
  String? theme,
  Map<String, String> nativeCodes = kMoonPayNativeCodes,
  Map<String, String> tokenCodes = kMoonPayTokenCodes,
  HttpSend send = httpSend,
}) async {
  if (moonpayIsBlock(chain)) return null;
  if (walletAddress.isEmpty) return null;
  final code = moonpayCurrencyCode(
    chain,
    kind: kind,
    symbol: symbol,
    nativeCodes: nativeCodes,
    tokenCodes: tokenCodes,
  );
  if (code == null) return null;
  final url = buildMoonPayUrl(
    apiKey: config.apiKey,
    walletAddress: walletAddress,
    currencyCode: code,
    baseCurrencyCode: baseCurrencyCode,
    baseCurrencyAmount: baseCurrencyAmount,
    redirectUrl: redirectUrl,
    colorCode: colorCode,
    theme: theme,
  );
  final signer = config.signerUrl;
  if (signer != null && signer.isNotEmpty) {
    return signWidgetUrl(signer, url, send: send);
  }
  return url;
}

/// Build the (UNSIGNED) MoonPay SELL-widget (off-ramp) URL.
///
/// On the sell flow the crypto being cashed out is the BASE currency and fiat
/// is the QUOTE, so the param names differ from [buildMoonPayUrl]:
///   - [baseCurrencyCode] is the CRYPTO code (reuse [moonpayCurrencyCode], same
///     codes as buy),
///   - [quoteCurrencyCode] is the fiat (e.g. 'usd'),
///   - [walletAddress] is the address the user sends funds from / refund,
///   - [baseCurrencyAmount] is the optional crypto amount to pre-fill.
/// Optional [redirectUrl], [colorCode] ('#rrggbb'), [theme] ('dark'|'light').
/// The base is derived from the key via [moonpaySellBaseForKey].
///
/// For production, pass the returned URL through [signWidgetUrl] to append the
/// server-computed &signature (the host-agnostic signer works for sell URLs
/// unchanged); sandbox (pk_test_) URLs work unsigned.
String buildMoonPaySellUrl({
  required String apiKey,
  required String baseCurrencyCode,
  String? walletAddress,
  String? quoteCurrencyCode,
  String? baseCurrencyAmount,
  String? redirectUrl,
  String? colorCode,
  String? theme,
}) {
  final params = <String, String>{
    'apiKey': apiKey,
    'baseCurrencyCode': baseCurrencyCode,
  };
  if (quoteCurrencyCode != null && quoteCurrencyCode.isNotEmpty) {
    params['quoteCurrencyCode'] = quoteCurrencyCode;
  }
  if (walletAddress != null && walletAddress.isNotEmpty) {
    params['walletAddress'] = walletAddress;
  }
  if (baseCurrencyAmount != null && baseCurrencyAmount.isNotEmpty) {
    params['baseCurrencyAmount'] = baseCurrencyAmount;
  }
  if (redirectUrl != null && redirectUrl.isNotEmpty) {
    params['redirectURL'] = redirectUrl;
  }
  if (colorCode != null && colorCode.isNotEmpty) {
    params['colorCode'] = colorCode;
  }
  if (theme != null && theme.isNotEmpty) {
    params['theme'] = theme;
  }
  // Uri handles RFC 3986 percent-encoding of each value.
  final uri = Uri.parse(moonpaySellBaseForKey(apiKey)).replace(
    path: '/',
    queryParameters: params,
  );
  return uri.toString();
}

/// Trim a human-units balance (a [Balance.display] string) to a MoonPay-safe
/// SELL pre-fill amount: a plain positive decimal, at most 8 fractional digits,
/// trailing zeros stripped. Returns null for zero/blank/unparseable values so
/// the widget opens WITHOUT a pre-filled amount (never pass 0 or junk).
String? moonpaySellAmount(String? display) {
  if (display == null) return null;
  var s = display.trim().replaceAll(',', '');
  if (!RegExp(r'^\d*\.?\d+$').hasMatch(s)) return null; // plain non-negative decimal
  if (s.contains('.')) {
    final parts = s.split('.');
    s = '${parts[0]}.${parts[1].length > 8 ? parts[1].substring(0, 8) : parts[1]}'
        .replaceAll(RegExp(r'0+$'), '')
        .replaceAll(RegExp(r'\.$'), '');
  }
  if (s.isEmpty) return null;
  final n = double.tryParse(s);
  return (n != null && n > 0) ? s : null;
}

/// One-call SELL helper: resolve the asset code, build the sell URL, and (if a
/// signer is configured) sign it. Returns null when the asset has no MoonPay
/// code (BLOCK/unsupported) — callers HIDE the Sell button in that case.
///
/// Mirrors [moonpayBuyUrl]: reuses the same currency-code map and the same
/// server-side signer wiring. [quoteCurrencyCode] is the fiat payout (default
/// 'usd'); [walletAddress] is the source/refund address.
Future<String?> moonpaySellUrl({
  required MoonPayConfig config,
  required String chain,
  String? walletAddress,
  String? kind,
  String? symbol,
  String? quoteCurrencyCode,
  String? baseCurrencyAmount,
  String? redirectUrl,
  String? colorCode,
  String? theme,
  Map<String, String> nativeCodes = kMoonPayNativeCodes,
  Map<String, String> tokenCodes = kMoonPayTokenCodes,
  HttpSend send = httpSend,
}) async {
  if (moonpayIsBlock(chain)) return null;
  final code = moonpayCurrencyCode(
    chain,
    kind: kind,
    symbol: symbol,
    nativeCodes: nativeCodes,
    tokenCodes: tokenCodes,
  );
  if (code == null) return null;
  final url = buildMoonPaySellUrl(
    apiKey: config.apiKey,
    baseCurrencyCode: code,
    walletAddress: walletAddress,
    quoteCurrencyCode: quoteCurrencyCode,
    baseCurrencyAmount: baseCurrencyAmount,
    redirectUrl: redirectUrl,
    colorCode: colorCode,
    theme: theme,
  );
  final signer = config.signerUrl;
  if (signer != null && signer.isNotEmpty) {
    return signWidgetUrl(signer, url, send: send);
  }
  return url;
}
