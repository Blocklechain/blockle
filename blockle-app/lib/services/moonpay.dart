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

/// The live accounts-service origin that hosts the MoonPay server endpoints.
/// Overridable in helpers/tests; the production default is blockle.org.
const String kMoonPayOrigin = 'https://blockle.org';

/// Server endpoint PATHS (appended to the origin). The signing path is PINNED
/// so a client can never be tricked into signing via some other host; swap and
/// commerce are the AUTHED server proxies that keep the Trade-API and Commerce
/// secrets server-side. Clients only ever hold the publishable + commerce
/// PUBLIC keys — never sk_/trade/webhook/commerce-secret.
const String kMoonPayConfigPath = '/account/api/moonpay/config';
const String kMoonPaySignPath = '/account/api/moonpay/sign';
const String kMoonPaySwapPath = '/account/api/moonpay/swap';
const String kMoonPayCommercePath = '/account/api/moonpay/commerce';

/// Config for the on-ramp. [apiKey] is overridable; [signerUrl] is the
/// SERVER-SIDE signing endpoint for production (HMAC-SHA256 over the query).
///
/// The net-new fields hydrate from [MoonPayConfig.fromServer] (GET /config):
/// [commercePublicKey] (safe to ship), [swapUrl] / [commerceUrl] (the authed
/// server proxies) and the feature flags (hide a button when a feature is off).
/// They all default so the existing `const MoonPayConfig()` offline fallback
/// still compiles and keeps every feature on in sandbox mode.
class MoonPayConfig {
  const MoonPayConfig({
    this.apiKey = kMoonPayDefaultApiKey,
    this.signerUrl,
    this.commercePublicKey = '',
    this.swapUrl,
    this.commerceUrl,
    this.featureBuy = true,
    this.featureSell = true,
    this.featureSwap = true,
    this.featureCommerce = true,
    this.enabled = true,
  });

  final String apiKey;
  final String? signerUrl;

  /// MoonPay Commerce PUBLIC key (safe client-side). Empty until hydrated.
  final String commercePublicKey;

  /// The authed server proxies ([kMoonPaySwapPath] / [kMoonPayCommercePath]
  /// resolved against the origin). Null in the offline fallback.
  final String? swapUrl;
  final String? commerceUrl;

  /// Feature gates from /config — a UI hides the matching entry when false.
  final bool featureBuy;
  final bool featureSell;
  final bool featureSwap;
  final bool featureCommerce;

  /// Master enable from /config.
  final bool enabled;

  bool get isLive => apiKey.startsWith('pk_live_');

  /// The hosted-widget base, derived from the key prefix:
  ///   pk_live_… -> https://buy.moonpay.com
  ///   anything else (pk_test_…) -> https://buy-sandbox.moonpay.com
  String get base => moonpayBaseForKey(apiKey);

  /// The hosted SELL-widget (off-ramp) base, derived from the same key prefix:
  ///   pk_live_… -> https://sell.moonpay.com
  ///   anything else (pk_test_…) -> https://sell-sandbox.moonpay.com
  String get sellBase => moonpaySellBaseForKey(apiKey);

  MoonPayConfig copyWith({
    String? apiKey,
    String? signerUrl,
    String? commercePublicKey,
    String? swapUrl,
    String? commerceUrl,
    bool? featureBuy,
    bool? featureSell,
    bool? featureSwap,
    bool? featureCommerce,
    bool? enabled,
  }) =>
      MoonPayConfig(
        apiKey: apiKey ?? this.apiKey,
        signerUrl: signerUrl ?? this.signerUrl,
        commercePublicKey: commercePublicKey ?? this.commercePublicKey,
        swapUrl: swapUrl ?? this.swapUrl,
        commerceUrl: commerceUrl ?? this.commerceUrl,
        featureBuy: featureBuy ?? this.featureBuy,
        featureSell: featureSell ?? this.featureSell,
        featureSwap: featureSwap ?? this.featureSwap,
        featureCommerce: featureCommerce ?? this.featureCommerce,
        enabled: enabled ?? this.enabled,
      );

  /// Build a config from a parsed /config JSON body. [publishableKey] becomes
  /// [apiKey] (falling back to the sandbox default if absent); features default
  /// ON unless the server explicitly reports `false`. The signing/swap/commerce
  /// endpoints are PINNED to [origin] + the fixed paths — never taken from the
  /// response — so the response can only toggle flags + keys, never redirect
  /// where we sign.
  factory MoonPayConfig.fromJson(
    Map<String, dynamic> j, {
    String origin = kMoonPayOrigin,
  }) {
    final pk = (j['publishableKey'] as String?)?.trim();
    final features = (j['features'] as Map?)?.cast<String, dynamic>() ?? const {};
    bool feat(String k) => features[k] != false; // default-on unless explicit false
    return MoonPayConfig(
      apiKey: (pk != null && pk.isNotEmpty) ? pk : kMoonPayDefaultApiKey,
      signerUrl: '$origin$kMoonPaySignPath',
      commercePublicKey: (j['commercePublicKey'] as String?)?.trim() ?? '',
      swapUrl: '$origin$kMoonPaySwapPath',
      commerceUrl: '$origin$kMoonPayCommercePath',
      featureBuy: feat('buy'),
      featureSell: feat('sell'),
      featureSwap: feat('swap'),
      featureCommerce: feat('commerce'),
      enabled: j['enabled'] != false,
    );
  }

  /// Load the live remote config (GET {origin}/account/api/moonpay/config). This
  /// is the source of truth for the publishable key + commerce public key +
  /// feature flags, replacing the hard-coded pk_test default. On any failure it
  /// returns the offline fallback (`const MoonPayConfig()` — sandbox key, no
  /// signer, every feature on) so buy/sell still works unsigned in sandbox.
  ///
  /// NO secret is ever fetched — /config exposes only public values.
  static Future<MoonPayConfig> fromServer({
    String origin = kMoonPayOrigin,
    HttpSend send = httpSend,
  }) async {
    try {
      final reply = await send(HttpReq(
        'GET',
        '$origin$kMoonPayConfigPath',
        headers: const {'accept': 'application/json'},
      ));
      if (reply.status >= 400 || reply.body.isEmpty) {
        return const MoonPayConfig();
      }
      final j = jsonDecode(reply.body);
      if (j is! Map) return const MoonPayConfig();
      return MoonPayConfig.fromJson(j.cast<String, dynamic>(), origin: origin);
    } catch (_) {
      return const MoonPayConfig(); // offline/sandbox fallback
    }
  }
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
  // HyperEVM native. MoonPay may not list HYPE yet — code is config-overridable;
  // verify against MoonPay's live currency list before shipping a pk_live_ key.
  'hyperevm': 'hype',
  'bitcoin': 'btc',
  'litecoin': 'ltc',
  'dogecoin': 'doge',
  'bitcoincash': 'bch',
  'solana': 'sol',
  'tron': 'trx',
  'ton': 'ton',
  'xrp': 'xrp',
  'stellar': 'xlm',
  'tezos': 'xtz',
  'cardano': 'ada',
  // 'block' intentionally absent — BLOCK is not on MoonPay.
};

/// Best-effort token → MoonPay currencyCode map, keyed by `"<chain>:<SYMBOL>"`
/// (symbol upper-cased). Overridable. A token absent here has no MoonPay code →
/// the Buy button is hidden for it.
const Map<String, String> kMoonPayTokenCodes = {
  'ethereum:USDC': 'usdc',
  'ethereum:USDT': 'usdt',
  'ethereum:XAUT': 'xaut',
  'ethereum:LINK': 'link',
  'ethereum:POL': 'pol',
  'base:USDC': 'usdc_base',
  'base:USDT': 'usdt',
  'arbitrum:USDC': 'usdc_arbitrum',
  'arbitrum:USDT': 'usdt_arbitrum',
  'optimism:USDC': 'usdc_optimism',
  'optimism:USDT': 'usdt',
  'polygon:USDC': 'usdc_polygon',
  'polygon:USDT': 'usdt_polygon',
  'bnb:USDC': 'usdc_bsc',
  'bnb:USDT': 'usdt_bsc',
  'avalanche:USDC': 'usdc_cchain',
  'avalanche:USDT': 'usdt',
  'solana:USDC': 'usdc_sol',
  'solana:USDT': 'usdt_sol',
  'tron:USDT': 'usdt_tron',
  'ton:USDT': 'usdt_ton',
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

// ===========================================================================
// NET-NEW: SWAP (Trade API proxy) — S3.
// ===========================================================================

/// Raised when a /swap or /commerce server proxy returns a non-2xx status. The
/// body is the server's error payload (never a secret).
class MoonPayServerException implements Exception {
  const MoonPayServerException(this.status, this.body);
  final int status;
  final String body;
  @override
  String toString() => 'MoonPayServerException($status): $body';
}

/// Thin AUTHED proxy to the MoonPay Trade API via the SERVER /swap endpoint.
///
/// The Trade-API key stays server-side; the client only ever relays
/// `{method, path, query, body}`. [bearer] is the accounts session token — the
/// /swap endpoint is authed, so non-custodial wallets with no linked account
/// pass null and the UI must gate behind a sign-in prompt. Returns the decoded
/// JSON reply. Throws [MoonPayServerException] on a non-2xx.
Future<Map<String, dynamic>> moonpaySwap(
  String method,
  String path, {
  required MoonPayConfig config,
  Map<String, dynamic>? query,
  Map<String, dynamic>? body,
  String? bearer,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) async {
  final url = (config.swapUrl != null && config.swapUrl!.isNotEmpty)
      ? config.swapUrl!
      : '$origin$kMoonPaySwapPath';
  final headers = <String, String>{
    'content-type': 'application/json',
    'x-blockle-client': 'wallet',
  };
  if (bearer != null && bearer.isNotEmpty) {
    headers['Authorization'] = 'Bearer $bearer';
  }
  final reply = await send(HttpReq(
    'POST',
    url,
    headers: headers,
    body: jsonEncode({
      'method': method,
      'path': path,
      if (query != null) 'query': query,
      if (body != null) 'body': body,
    }),
  ));
  if (reply.status >= 400) {
    throw MoonPayServerException(reply.status, reply.body);
  }
  final j = reply.body.isEmpty ? const <String, dynamic>{} : jsonDecode(reply.body);
  return (j is Map) ? j.cast<String, dynamic>() : <String, dynamic>{};
}

/// Convenience: a crypto↔crypto quote via the Trade-API proxy.
Future<Map<String, dynamic>> moonpaySwapQuote({
  required MoonPayConfig config,
  required String sellAsset,
  required String buyAsset,
  required num amount,
  String? bearer,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) =>
    // MoonPay Trade API: GET /v3/currencies/{sellAsset}/buy_quote with the BUY
    // asset + amount as query (matches the web/extension clients; /v3/quote 404s).
    moonpaySwap(
      'GET',
      '/v3/currencies/${Uri.encodeComponent(sellAsset)}/buy_quote',
      config: config,
      query: {
        'quoteCurrencyCode': buyAsset,
        'baseCurrencyAmount': '$amount',
      },
      bearer: bearer,
      origin: origin,
      send: send,
    );

/// Convenience: execute a previously-quoted swap.
Future<Map<String, dynamic>> moonpaySwapExecute({
  required MoonPayConfig config,
  required String quoteId,
  Map<String, dynamic>? extra,
  String? bearer,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) =>
    moonpaySwap(
      'POST',
      '/v3/trades',
      config: config,
      body: {'quoteId': quoteId, ...?extra},
      bearer: bearer,
      origin: origin,
      send: send,
    );

// ===========================================================================
// NET-NEW: STATUS — S4.
// ===========================================================================

/// A MoonPay transaction summary for the wallet's activity surface.
class MoonPayTxn {
  const MoonPayTxn({
    required this.id,
    required this.type, // 'buy' | 'sell' | 'swap'
    required this.status,
    this.asset,
    this.amountUsd,
    this.at,
  });
  final String id;
  final String type;
  final String status;
  final String? asset;
  final double? amountUsd;
  final DateTime? at;
}

/// Parse a MoonPay redirect-callback [uri] (the widget returns to our
/// redirectURL with transactionId/transactionStatus appended) into a txn. This
/// is the CHEAP S4 source (no account needed), captured on the webview nav
/// callback. Returns null when there is no transaction id in the query.
MoonPayTxn? moonpayTxnFromRedirect(Uri uri, {String type = 'buy'}) {
  final q = uri.queryParameters;
  final id = q['transactionId'] ?? q['transactionid'] ?? q['id'];
  if (id == null || id.isEmpty) return null;
  final status = q['transactionStatus'] ?? q['status'] ?? 'pending';
  final asset = q['currencyCode'] ?? q['baseCurrencyCode'];
  return MoonPayTxn(
    id: id,
    type: type,
    status: status,
    asset: asset,
    at: DateTime.now().toUtc(),
  );
}

MoonPayTxn? _txnFromApi(dynamic e) {
  if (e is! Map) return null;
  final id = (e['id'] ?? e['transactionId'])?.toString();
  if (id == null || id.isEmpty) return null;
  final flow = (e['flow'] ?? e['type'] ?? 'buy').toString().toLowerCase();
  final type = flow.contains('sell')
      ? 'sell'
      : (flow.contains('swap') || flow.contains('trade'))
          ? 'swap'
          : 'buy';
  final usd = e['baseCurrencyAmount'] ?? e['usdAmount'] ?? e['amountUsd'];
  DateTime? at;
  final ts = e['createdAt'] ?? e['at'];
  if (ts is String) at = DateTime.tryParse(ts);
  return MoonPayTxn(
    id: id,
    type: type,
    status: (e['status'] ?? 'pending').toString(),
    asset: (e['currencyCode'] ?? e['baseCurrencyCode'])?.toString(),
    amountUsd: (usd is num) ? usd.toDouble() : double.tryParse('$usd'),
    at: at,
  );
}

/// The user's recent MoonPay transactions + live state, merged from two
/// sources: [local] (redirect-callback params persisted on widget return) and —
/// when a [bearer] is present — the authed Trade-API `/v3/transactions` poll.
/// De-duped by id, newest first, capped at [limit]. Never throws (a failed
/// poll just yields the local set).
Future<List<MoonPayTxn>> moonpayStatus({
  required MoonPayConfig config,
  List<MoonPayTxn> local = const [],
  String? bearer,
  int limit = 10,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) async {
  final byId = <String, MoonPayTxn>{for (final t in local) t.id: t};
  if (bearer != null && bearer.isNotEmpty) {
    try {
      final j = await moonpaySwap(
        'GET',
        '/v3/transactions',
        config: config,
        query: {'limit': '$limit'},
        bearer: bearer,
        origin: origin,
        send: send,
      );
      final list = j['transactions'] ?? j['data'] ?? j['items'];
      if (list is List) {
        for (final e in list) {
          final t = _txnFromApi(e);
          if (t != null) byId[t.id] = t;
        }
      }
    } catch (_) {
      // local-only
    }
  }
  final all = byId.values.toList()
    ..sort((a, b) =>
        (b.at ?? DateTime.fromMillisecondsSinceEpoch(0))
            .compareTo(a.at ?? DateTime.fromMillisecondsSinceEpoch(0)));
  return all.take(limit).toList();
}

// ===========================================================================
// NET-NEW: CREATIVE HELPERS (thin wrappers so each UI hook is one call).
// ===========================================================================

/// C1 / C3 / C6 — BUY exactly a USD shortfall of [symbol] on [chain] into the
/// user's own [walletAddress]. The amount is ceil()'d (MoonPay buys whole
/// fiat). Returns the (signed, in live mode) widget URL, or null when the asset
/// has no MoonPay code / no address. The caller opens it and, on the redirect
/// return, auto-continues its flow (arm-the-bot / resume-send).
Future<String?> moonpayTopUpShortfall({
  required MoonPayConfig config,
  required String chain,
  String? kind,
  String? symbol,
  required String walletAddress,
  required num shortfallUsd,
  String? redirectUrl,
  HttpSend send = httpSend,
}) {
  final amt = shortfallUsd.ceil();
  return moonpayBuyUrl(
    config: config,
    chain: chain,
    walletAddress: walletAddress,
    kind: kind,
    symbol: symbol,
    baseCurrencyCode: 'usd',
    baseCurrencyAmount: amt > 0 ? '$amt' : null,
    redirectUrl: redirectUrl,
    theme: 'dark',
    colorCode: '#7C5CFF',
    send: send,
  );
}

/// C2 — a recurring MoonPay buy preset wired to a DCA bot. Returns the buy
/// widget URL carrying MoonPay's recurring params PLUS a DCA bot spec
/// `{type:'dca', allocationUsd, cadence:'weekly'}` to hand to the bot engine.
/// [url] is null when the asset has no MoonPay code (the DCA bot can still be
/// created). The weekly amount is ceil()'d to whole USD.
class MoonPayRecurringPreset {
  const MoonPayRecurringPreset({required this.url, required this.botSpec});
  final String? url;
  final Map<String, dynamic> botSpec;
}

Future<MoonPayRecurringPreset> moonpayRecurringBuyPreset({
  required MoonPayConfig config,
  required String chain,
  String? kind,
  String? symbol,
  required String walletAddress,
  required num weeklyUsd,
  String? redirectUrl,
  HttpSend send = httpSend,
}) async {
  final amt = weeklyUsd.ceil();
  final botSpec = <String, dynamic>{
    'type': 'dca',
    'allocationUsd': amt.toDouble(),
    'cadence': 'weekly',
  };
  final code = moonpayCurrencyCode(chain, kind: kind, symbol: symbol);
  if (code == null || moonpayIsBlock(chain) || walletAddress.isEmpty) {
    return MoonPayRecurringPreset(url: null, botSpec: botSpec);
  }
  final base = buildMoonPayUrl(
    apiKey: config.apiKey,
    walletAddress: walletAddress,
    currencyCode: code,
    baseCurrencyCode: 'usd',
    baseCurrencyAmount: amt > 0 ? '$amt' : null,
    redirectUrl: redirectUrl,
    theme: 'dark',
    colorCode: '#7C5CFF',
  );
  // Opt the widget into MoonPay's recurring-buy flow (weekly).
  final sep = base.contains('?') ? '&' : '?';
  final withRecurring =
      '$base${sep}showRecurringBuyToggle=true&recurringBuyFrequency=weekly';
  final signer = config.signerUrl;
  final url = (signer != null && signer.isNotEmpty)
      ? await signWidgetUrl(signer, withRecurring, send: send)
      : withRecurring;
  return MoonPayRecurringPreset(url: url, botSpec: botSpec);
}

/// C4 — one-tap SELL of realized gains to fiat, pre-filled with [gainAmount]
/// (in the CRYPTO asset's units). Returns the (signed) sell widget URL or null
/// for an unsupported asset.
Future<String?> moonpayCashOutGains({
  required MoonPayConfig config,
  required String chain,
  String? kind,
  String? symbol,
  String? walletAddress,
  required num gainAmount,
  String? redirectUrl,
  HttpSend send = httpSend,
}) {
  return moonpaySellUrl(
    config: config,
    chain: chain,
    walletAddress: walletAddress,
    kind: kind,
    symbol: symbol,
    quoteCurrencyCode: 'usd',
    baseCurrencyAmount:
        moonpaySellAmount(gainAmount > 0 ? '$gainAmount' : null),
    redirectUrl: redirectUrl,
    theme: 'dark',
    colorCode: '#7C5CFF',
    send: send,
  );
}

/// C5 — "Get BLOCK with a card": BLOCK is never on MoonPay, so this is a 2-step
/// guided plan. Step 1 (returned here) BUYs USDC on the wallet's active EVM/SOL
/// [usdcChain] for [usdAmount]; step 2 (opened by the caller after funding) is
/// a native /dex swap USDC→BLOCK. A wizard state machine the UI drives.
class MoonPayBlockPlan {
  const MoonPayBlockPlan({
    required this.ok,
    this.step1BuyUrl,
    this.usdcChain,
    this.usdcSymbol,
    this.usdAmount,
    this.reason,
  });
  final bool ok;
  final String? step1BuyUrl;
  final String? usdcChain;
  final String? usdcSymbol;
  final double? usdAmount;
  final String? reason;
}

Future<MoonPayBlockPlan> moonpayGetBlockWithCard({
  required MoonPayConfig config,
  required String walletAddress,
  required num usdAmount,
  String usdcChain = 'solana',
  String? redirectUrl,
  HttpSend send = httpSend,
}) async {
  if (walletAddress.isEmpty) {
    return const MoonPayBlockPlan(ok: false, reason: 'No wallet address yet.');
  }
  final amt = usdAmount.ceil();
  final url = await moonpayBuyUrl(
    config: config,
    chain: usdcChain,
    walletAddress: walletAddress,
    kind: 'erc20',
    symbol: 'USDC',
    baseCurrencyCode: 'usd',
    baseCurrencyAmount: amt > 0 ? '$amt' : null,
    redirectUrl: redirectUrl,
    theme: 'dark',
    colorCode: '#7C5CFF',
    send: send,
  );
  if (url == null) {
    return MoonPayBlockPlan(
        ok: false, reason: 'USDC isn’t buyable with a card on $usdcChain.');
  }
  return MoonPayBlockPlan(
    ok: true,
    step1BuyUrl: url,
    usdcChain: usdcChain,
    usdcSymbol: 'USDC',
    usdAmount: amt.toDouble(),
  );
}

// ===========================================================================
// NET-NEW: COMMERCE (crypto checkout) — M1–M4.
// ===========================================================================

/// The result of creating a MoonPay Commerce checkout. The GRANT is applied
/// SERVER-SIDE only after the webhook verifies payment — the client never
/// carries entitlement; it only opens [hostedUrl] and polls status for UI.
class MoonPayCommerceCheckout {
  const MoonPayCommerceCheckout({
    this.checkoutId,
    this.hostedUrl,
    this.raw = const {},
  });
  final String? checkoutId;
  final String? hostedUrl;
  final Map<String, dynamic> raw;
}

/// M1–M4 — create a crypto checkout for [product] ('copilot'|'copilot_pro'|
/// 'launch_fee'|'raid'|'nft') via the AUTHED server /commerce proxy (which holds
/// the Commerce SECRET). [bearer] is the accounts session token (required — the
/// endpoint is authed). Opens the hosted checkout via [hostedUrl]; entitlement
/// flips only via the server webhook grant keyed on [refId].
Future<MoonPayCommerceCheckout> moonpayCommerceCheckout({
  required MoonPayConfig config,
  required String product,
  required String refId,
  required num amountUsd,
  String ccy = 'USD',
  String? bearer,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) async {
  final m = await _commercePost(
    config: config,
    bearer: bearer,
    origin: origin,
    send: send,
    body: {
      'action': 'create',
      'product': product,
      'refId': refId,
      'amountUsd': amountUsd,
      'ccy': ccy,
    },
  );
  return MoonPayCommerceCheckout(
    checkoutId: m['checkoutId'] as String?,
    hostedUrl: (m['hostedUrl'] ?? m['url']) as String?,
    raw: m,
  );
}

/// Poll a commerce checkout's status (UI only; the grant is webhook-driven).
Future<String> moonpayCommerceStatus({
  required MoonPayConfig config,
  required String checkoutId,
  String? bearer,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) async {
  final m = await _commercePost(
    config: config,
    bearer: bearer,
    origin: origin,
    send: send,
    body: {'action': 'status', 'checkoutId': checkoutId},
  );
  return (m['status'] ?? 'pending').toString();
}

Future<Map<String, dynamic>> _commercePost({
  required MoonPayConfig config,
  required Map<String, dynamic> body,
  String? bearer,
  String origin = kMoonPayOrigin,
  HttpSend send = httpSend,
}) async {
  final url = (config.commerceUrl != null && config.commerceUrl!.isNotEmpty)
      ? config.commerceUrl!
      : '$origin$kMoonPayCommercePath';
  final headers = <String, String>{
    'content-type': 'application/json',
    'x-blockle-client': 'wallet',
  };
  if (bearer != null && bearer.isNotEmpty) {
    headers['Authorization'] = 'Bearer $bearer';
  }
  final reply =
      await send(HttpReq('POST', url, headers: headers, body: jsonEncode(body)));
  if (reply.status >= 400) {
    throw MoonPayServerException(reply.status, reply.body);
  }
  final j = reply.body.isEmpty ? const <String, dynamic>{} : jsonDecode(reply.body);
  return (j is Map) ? j.cast<String, dynamic>() : <String, dynamic>{};
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
