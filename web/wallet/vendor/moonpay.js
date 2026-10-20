// moonpay.js — MoonPay fiat on-ramp ("Buy with card") for the Blockle wallet.
//
// MoonPay's buy widget is just a hosted URL: you open it with query params
// (apiKey, walletAddress, currencyCode, …) and MoonPay runs the KYC + card /
// bank flow and delivers crypto to walletAddress. We never see cards or PII.
//
// This module is PURE config + URL construction (no DOM): build the widget URL
// from a publishable apiKey + a currency-code map + the user's receive address.
// The UI (accounts-ui.js) opens the returned URL in a NEW TAB.
//
// SECURITY: the publishable key (pk_test_* / pk_live_*) is client-side and safe
// to embed. The MoonPay SECRET key is NEVER here — URL signing happens on a
// SERVER-SIDE endpoint (biz.rs) that we call over HTTP; if no signing endpoint
// is configured we fall back to the unsigned URL (fine for the sandbox key).
//
// Global `MoonPay`; also CommonJS-exported for the node test harness.
(function (global) {
  'use strict';

  // Publishable (client) key — SANDBOX test key by default. Override in Settings
  // (or swap to a pk_live_* key) once MoonPay approves the account. A pk_test_*
  // key routes to the sandbox host; a pk_live_* key routes to production. This
  // is NOT a secret and is safe to commit.
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

  // Same rule for the SELL widget host.
  function sellBaseFromKey(apiKey) {
    return String(apiKey || '').startsWith('pk_live_') ? SELL_LIVE_BASE : SELL_SANDBOX_BASE;
  }

  // Asset -> MoonPay currencyCode, keyed by our chain id. Best-effort; keep it
  // config-overridable (settings.moonpay.currencyCodes). `native` is the chain's
  // native coin; `tokens` maps an UPPERCASE token symbol to its MoonPay code.
  // An asset with no entry here has NO buy button (we don't guess).
  //
  // BLOCK is intentionally absent — it is not listed on MoonPay. The UI shows a
  // "buy a supported asset then swap to BLOCK" note instead of a buy button.
  const DEFAULT_MAP = {
    ethereum:  { native: 'eth',        tokens: { USDC: 'usdc',         USDT: 'usdt' } },
    base:      { native: 'eth_base',   tokens: { USDC: 'usdc_base',    USDT: 'usdt' } },
    arbitrum:  { native: 'eth_arbitrum', tokens: { USDC: 'usdc_arbitrum', USDT: 'usdt_arbitrum' } },
    optimism:  { native: 'eth_optimism', tokens: { USDC: 'usdc_optimism', USDT: 'usdt' } },
    polygon:   { native: 'pol_polygon', tokens: { USDC: 'usdc_polygon', USDT: 'usdt_polygon' } },
    bnb:       { native: 'bnb_bsc',    tokens: { USDC: 'usdc_bsc',     USDT: 'usdt_bsc' } },
    avalanche: { native: 'avax_cchain', tokens: { USDC: 'usdc_cchain', USDT: 'usdt' } },
    bitcoin:   { native: 'btc',        tokens: {} },
    litecoin:  { native: 'ltc',        tokens: {} },
    dogecoin:  { native: 'doge',       tokens: {} },
    solana:    { native: 'sol',        tokens: { USDC: 'usdc_sol',     USDT: 'usdt_sol' } },
    // block: absent on purpose (not on MoonPay).
  };

  // Shallow-merge a user override map over the defaults, per chain, so an
  // override can tweak a single code without redefining the whole table.
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
  //   codeFor(map, 'ethereum', { native: true })            -> 'eth'
  //   codeFor(map, 'ethereum', { symbol: 'USDC' })           -> 'usdc'
  //   codeFor(map, 'block',    { native: true })             -> null
  // Native vs token is explicit (no symbol-collision ambiguity).
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

  // Build the (unsigned) MoonPay buy-widget URL from the given options.
  // Required: currencyCode. apiKey defaults to DEFAULT_API_KEY; the host is
  // derived from the key prefix.
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

  // Build the (unsigned) MoonPay SELL (off-ramp) widget URL. Note the param
  // roles DIFFER from buy: here `baseCurrencyCode` is the CRYPTO being sold
  // (same code map as buy) and `quoteCurrencyCode` is the fiat payout currency.
  // Opening the URL launches MoonPay's hosted KYC + payout flow; MoonPay shows a
  // deposit address the user sends crypto to and pays fiat to their bank. We do
  // NOT handle PII/banking. apiKey defaults to DEFAULT_API_KEY; the host is
  // derived from the key prefix (pk_live_* -> sell.moonpay.com, else sandbox).
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

  // Ask a SERVER-SIDE signing endpoint to sign the widget URL (HMAC-SHA256 with
  // the secret key). Contract: POST { url } -> { url } (full signed URL) OR
  // { signature } (we append it). On any failure we fall back to the UNSIGNED
  // url — correct for the sandbox key, which accepts unsigned widgets.
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

  // Persisted config (Store key 'moonpay'), merged over defaults. Reads are
  // best-effort: a missing Store or key yields the defaults.
  const CONFIG_DEFAULTS = {
    apiKey: DEFAULT_API_KEY,
    signingEndpoint: '',     // e.g. https://blockle.org/api/moonpay/sign
    theme: 'dark',
    currencyCodes: null,     // per-chain override map (same shape as DEFAULT_MAP)
    baseCurrencyCode: 'usd',
  };

  async function loadConfig() {
    let saved = {};
    try {
      const Store = global.Store;
      if (Store && Store.get) saved = (await Store.get('moonpay')).moonpay || {};
    } catch {}
    return Object.assign({}, CONFIG_DEFAULTS, saved || {});
  }

  async function saveConfig(patch) {
    const Store = global.Store;
    if (!Store || !Store.set) return;
    const cur = await loadConfig();
    const next = Object.assign({}, cur, patch || {});
    // Only persist non-default fields that the UI exposes; keep it small.
    await Store.set({ moonpay: {
      apiKey: next.apiKey,
      signingEndpoint: next.signingEndpoint,
      theme: next.theme,
      baseCurrencyCode: next.baseCurrencyCode,
      currencyCodes: next.currencyCodes || undefined,
    } });
  }

  function effectiveMap(cfg) {
    return mergeMap(DEFAULT_MAP, cfg && cfg.currencyCodes);
  }

  // High-level: resolve + build (+ sign) a buy URL for an asset. Returns
  //   { ok: true, url, code }  or  { ok: false, reason: 'unsupported' }.
  // `opts`: { chain, symbol?, native?, walletAddress, baseCurrencyAmount?,
  //           redirectURL?, fetchFn? }.
  async function buyUrl(opts) {
    opts = opts || {};
    const cfg = await loadConfig();
    const map = effectiveMap(cfg);
    const code = codeFor(map, opts.chain, { native: opts.native, symbol: opts.symbol });
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

  // High-level: resolve + build (+ sign) a SELL (off-ramp) URL for an asset.
  // Returns { ok: true, url, code } or { ok: false, reason: 'unsupported' }.
  // Same supported-asset set as buyUrl (BLOCK + unmapped assets -> unsupported).
  // `opts`: { chain, symbol?, native?, walletAddress, baseCurrencyAmount?,
  //           redirectURL?, fetchFn? }. The fiat payout currency comes from
  // config.baseCurrencyCode (default 'usd') and maps to quoteCurrencyCode.
  async function sellUrl(opts) {
    opts = opts || {};
    const cfg = await loadConfig();
    const map = effectiveMap(cfg);
    const code = codeFor(map, opts.chain, { native: opts.native, symbol: opts.symbol });
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
    CONFIG_DEFAULTS,
    baseFromKey,
    sellBaseFromKey,
    mergeMap,
    effectiveMap,
    codeFor,
    isSupported,
    buildWidgetUrl,
    buildSellUrl,
    fetchSignedUrl,
    loadConfig,
    saveConfig,
    buyUrl,
    sellUrl,
  };

  global.MoonPay = MoonPay;
  if (typeof module !== 'undefined' && module.exports) module.exports = MoonPay;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
