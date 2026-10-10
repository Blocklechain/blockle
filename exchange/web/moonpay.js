/* moonpay.js — MoonPay fiat on/off-ramp ("Buy with card" + "Sell") for the
 * Blockle Exchange frontend.
 *
 * Mirrors blockle-extension/moonpay.js: MoonPay's widgets are just hosted URLs
 * you open with query params (apiKey, walletAddress, currencyCode, …); MoonPay
 * runs KYC + card/bank flow. We never see cards or PII. This module is PURE
 * config + URL construction (no DOM) plus small asset-resolution helpers for
 * the exchange's {chain, symbol} asset shape. trade.js opens the URL in a NEW
 * TAB.
 *
 * SECURITY: the publishable key (pk_test_* / pk_live_*) is client-side and safe
 * to embed. The MoonPay SECRET key is NEVER here — URL signing happens on a
 * SERVER-SIDE endpoint we POST to; if no signer is configured (or the call
 * fails / is blocked cross-origin) we fall back to the UNSIGNED URL, which the
 * sandbox key accepts.
 *
 * Config comes from window.EXCHANGE_CONFIG.moonpay (optional), shape:
 *   { apiKey, signingEndpoint, theme, baseCurrencyCode, currencyCodes }
 *
 * Global `MoonPay`; also CommonJS-exported for the node test harness.
 */
(function (global) {
  'use strict';

  // Publishable (client) key — SANDBOX test key by default. A pk_test_* key
  // routes to the sandbox host; a pk_live_* key routes to production. This is
  // NOT a secret and is safe to commit.
  const DEFAULT_API_KEY = 'pk_test_uRXfpYr99uQJibabWff6BlZYIzzFONLF';

  const SANDBOX_BASE = 'https://buy-sandbox.moonpay.com';
  const LIVE_BASE = 'https://buy.moonpay.com';

  // SELL (off-ramp) hosts. Same pk_live_* -> production rule as the buy hosts.
  const SELL_SANDBOX_BASE = 'https://sell-sandbox.moonpay.com';
  const SELL_LIVE_BASE = 'https://sell.moonpay.com';

  // Derive the widget host from the key PREFIX: only an explicit pk_live_* key
  // hits production; anything else (pk_test_*, blank, malformed) stays on the
  // safe sandbox host.
  function baseFromKey(apiKey) {
    return String(apiKey || '').startsWith('pk_live_') ? LIVE_BASE : SANDBOX_BASE;
  }
  function sellBaseFromKey(apiKey) {
    return String(apiKey || '').startsWith('pk_live_') ? SELL_LIVE_BASE : SELL_SANDBOX_BASE;
  }

  // Asset -> MoonPay currencyCode, keyed by our chain id. `native` is the
  // chain's native coin; `tokens` maps an UPPERCASE token symbol to its MoonPay
  // code. An asset with no entry here has NO button (we don't guess). BLOCK is
  // intentionally absent — it is not listed on MoonPay.
  const DEFAULT_MAP = {
    ethereum:  { native: 'eth',          tokens: { USDC: 'usdc',          USDT: 'usdt' } },
    base:      { native: 'eth_base',     tokens: { USDC: 'usdc_base',     USDT: 'usdt' } },
    arbitrum:  { native: 'eth_arbitrum', tokens: { USDC: 'usdc_arbitrum', USDT: 'usdt_arbitrum' } },
    optimism:  { native: 'eth_optimism', tokens: { USDC: 'usdc_optimism', USDT: 'usdt' } },
    polygon:   { native: 'pol_polygon',  tokens: { USDC: 'usdc_polygon',  USDT: 'usdt_polygon' } },
    bnb:       { native: 'bnb_bsc',      tokens: { USDC: 'usdc_bsc',      USDT: 'usdt_bsc' } },
    avalanche: { native: 'avax_cchain',  tokens: { USDC: 'usdc_cchain',   USDT: 'usdt' } },
    bitcoin:   { native: 'btc',          tokens: {} },
    litecoin:  { native: 'ltc',          tokens: {} },
    dogecoin:  { native: 'doge',         tokens: {} },
    solana:    { native: 'sol',          tokens: { USDC: 'usdc_sol',      USDT: 'usdt_sol' } },
    // block: absent on purpose (not on MoonPay).
  };

  // The native-coin SYMBOL for each chain, so an exchange asset given only as
  // {chain, symbol} can be classified native-vs-token without an explicit flag.
  const NATIVE_SYMBOLS = {
    ethereum: 'ETH', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH',
    polygon: 'POL', bnb: 'BNB', avalanche: 'AVAX',
    bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', solana: 'SOL',
  };

  // Shallow-merge a user override map over the defaults, per chain.
  function mergeMap(base, override) {
    const out = {};
    const chains = new Set([...Object.keys(base || {}), ...Object.keys(override || {})]);
    for (const id of chains) {
      const b = (base && base[id]) || {};
      const o = (override && override[id]) || {};
      out[id] = {
        native: o.native != null ? o.native : b.native,
        tokens: Object.assign({}, b.tokens || {}, o.tokens || {}),
      };
    }
    return out;
  }

  // Resolve the MoonPay currencyCode for an asset, or null if unsupported.
  //   codeFor(map, 'ethereum', { native: true })   -> 'eth'
  //   codeFor(map, 'ethereum', { symbol: 'USDC' })  -> 'usdc'
  //   codeFor(map, 'block',    { native: true })    -> null
  function codeFor(map, chain, opts) {
    const entry = map && map[chain];
    if (!entry) return null;
    if (opts && opts.native) return entry.native || null;
    const sym = String((opts && opts.symbol) || '').toUpperCase();
    if (!sym) return null;
    return (entry.tokens && entry.tokens[sym]) || null;
  }

  function isSupported(map, chain, opts) {
    return !!codeFor(map, chain, opts);
  }

  // Resolve an exchange asset ({ chain, symbol }) to a MoonPay code, deciding
  // native-vs-token from the chain's native symbol. Returns null if unsupported
  // (e.g. BLOCK, unknown chain, or an unmapped token).
  //   codeForAsset(map, 'ethereum', 'ETH')  -> 'eth'   (native)
  //   codeForAsset(map, 'ethereum', 'USDC') -> 'usdc'  (token)
  //   codeForAsset(map, 'block',    'BLOCK')-> null
  function codeForAsset(map, chain, symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    if (NATIVE_SYMBOLS[chain] && NATIVE_SYMBOLS[chain] === sym) {
      return codeFor(map, chain, { native: true });
    }
    return codeFor(map, chain, { symbol: sym });
  }

  function isAssetSupported(map, chain, symbol) {
    return !!codeForAsset(map, chain, symbol);
  }

  // Build the (unsigned) MoonPay BUY-widget URL.
  function buildWidgetUrl(opts) {
    opts = opts || {};
    const apiKey = opts.apiKey || DEFAULT_API_KEY;
    const base = baseFromKey(apiKey);
    const params = new URLSearchParams();
    params.set('apiKey', apiKey);
    if (opts.currencyCode) params.set('currencyCode', opts.currencyCode);
    if (opts.walletAddress) params.set('walletAddress', opts.walletAddress);
    if (opts.baseCurrencyCode) params.set('baseCurrencyCode', opts.baseCurrencyCode);
    if (opts.baseCurrencyAmount != null && opts.baseCurrencyAmount !== '')
      params.set('baseCurrencyAmount', String(opts.baseCurrencyAmount));
    if (opts.redirectURL) params.set('redirectURL', opts.redirectURL);
    if (opts.colorCode) params.set('colorCode', opts.colorCode);
    if (opts.theme) params.set('theme', opts.theme);
    return base + '?' + params.toString();
  }

  // Build the (unsigned) MoonPay SELL (off-ramp) widget URL. Here
  // `baseCurrencyCode` is the CRYPTO being sold and `quoteCurrencyCode` is the
  // fiat payout currency.
  function buildSellUrl(opts) {
    opts = opts || {};
    const apiKey = opts.apiKey || DEFAULT_API_KEY;
    const base = sellBaseFromKey(apiKey);
    const params = new URLSearchParams();
    params.set('apiKey', apiKey);
    if (opts.baseCurrencyCode) params.set('baseCurrencyCode', opts.baseCurrencyCode);
    if (opts.quoteCurrencyCode) params.set('quoteCurrencyCode', opts.quoteCurrencyCode);
    if (opts.walletAddress) params.set('walletAddress', opts.walletAddress);
    if (opts.baseCurrencyAmount != null && opts.baseCurrencyAmount !== '')
      params.set('baseCurrencyAmount', String(opts.baseCurrencyAmount));
    if (opts.redirectURL) params.set('redirectURL', opts.redirectURL);
    if (opts.colorCode) params.set('colorCode', opts.colorCode);
    if (opts.theme) params.set('theme', opts.theme);
    return base + '?' + params.toString();
  }

  // Ask a SERVER-SIDE signing endpoint to sign the widget URL. Contract:
  // POST { url } -> { url } (full signed URL) OR { signature } (we append it).
  // On ANY failure — no endpoint, non-ok, thrown (incl. a blocked cross-origin
  // request) — we fall back to the UNSIGNED url, which the sandbox key accepts.
  async function fetchSignedUrl(signingEndpoint, unsignedUrl, fetchFn) {
    const f = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!signingEndpoint || !f) return unsignedUrl;
    try {
      const res = await f(signingEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: unsignedUrl }),
      });
      if (!res || !res.ok) return unsignedUrl;
      const data = await res.json();
      if (data && typeof data.url === 'string' && data.url) return data.url;
      if (data && typeof data.signature === 'string' && data.signature) {
        const sep = unsignedUrl.indexOf('?') >= 0 ? '&' : '?';
        return unsignedUrl + sep + 'signature=' + encodeURIComponent(data.signature);
      }
      return unsignedUrl;
    } catch {
      return unsignedUrl;
    }
  }

  // Config defaults, merged over window.EXCHANGE_CONFIG.moonpay.
  const CONFIG_DEFAULTS = {
    apiKey: DEFAULT_API_KEY,
    signingEndpoint: '',     // e.g. https://blockle.org/api/moonpay/sign
    theme: 'dark',
    currencyCodes: null,     // per-chain override map (same shape as DEFAULT_MAP)
    baseCurrencyCode: 'usd',
  };

  // Synchronous config read from the exchange's runtime config (no Store here).
  function loadConfig() {
    let saved = {};
    try {
      const cfg = global.EXCHANGE_CONFIG;
      if (cfg && cfg.moonpay) saved = cfg.moonpay || {};
    } catch {}
    return Object.assign({}, CONFIG_DEFAULTS, saved || {});
  }

  function effectiveMap(cfg) {
    return mergeMap(DEFAULT_MAP, cfg && cfg.currencyCodes);
  }

  // High-level: resolve + build (+ sign) a BUY url for an exchange asset.
  // Returns { ok:true, url, code } or { ok:false, reason:'unsupported' }.
  // `opts`: { chain, symbol, walletAddress?, baseCurrencyAmount?, redirectURL?,
  //           fetchFn? }.
  async function buyUrl(opts) {
    opts = opts || {};
    const cfg = loadConfig();
    const map = effectiveMap(cfg);
    const code = codeForAsset(map, opts.chain, opts.symbol);
    if (!code) return { ok: false, reason: 'unsupported' };
    const unsigned = buildWidgetUrl({
      apiKey: cfg.apiKey,
      currencyCode: code,
      walletAddress: opts.walletAddress,
      baseCurrencyCode: cfg.baseCurrencyCode || 'usd',
      baseCurrencyAmount: opts.baseCurrencyAmount,
      redirectURL: opts.redirectURL,
      theme: cfg.theme,
    });
    const url = await fetchSignedUrl(cfg.signingEndpoint, unsigned, opts.fetchFn);
    return { ok: true, url, code };
  }

  // High-level: resolve + build (+ sign) a SELL (off-ramp) url for an asset.
  async function sellUrl(opts) {
    opts = opts || {};
    const cfg = loadConfig();
    const map = effectiveMap(cfg);
    const code = codeForAsset(map, opts.chain, opts.symbol);
    if (!code) return { ok: false, reason: 'unsupported' };
    const unsigned = buildSellUrl({
      apiKey: cfg.apiKey,
      baseCurrencyCode: code,
      quoteCurrencyCode: cfg.baseCurrencyCode || 'usd',
      walletAddress: opts.walletAddress,
      baseCurrencyAmount: opts.baseCurrencyAmount,
      redirectURL: opts.redirectURL,
      theme: cfg.theme,
    });
    const url = await fetchSignedUrl(cfg.signingEndpoint, unsigned, opts.fetchFn);
    return { ok: true, url, code };
  }

  const MoonPay = {
    DEFAULT_API_KEY,
    SANDBOX_BASE,
    LIVE_BASE,
    SELL_SANDBOX_BASE,
    SELL_LIVE_BASE,
    DEFAULT_MAP,
    NATIVE_SYMBOLS,
    CONFIG_DEFAULTS,
    baseFromKey,
    sellBaseFromKey,
    mergeMap,
    effectiveMap,
    codeFor,
    codeForAsset,
    isSupported,
    isAssetSupported,
    buildWidgetUrl,
    buildSellUrl,
    fetchSignedUrl,
    loadConfig,
    buyUrl,
    sellUrl,
  };

  global.MoonPay = MoonPay;
  if (typeof module !== 'undefined' && module.exports) module.exports = MoonPay;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
