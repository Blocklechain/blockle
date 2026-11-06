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
    ethereum:  { native: 'eth',        tokens: { USDC: 'usdc',         USDT: 'usdt', XAUT: 'xaut', LINK: 'link', POL: 'pol' } },
    base:      { native: 'eth_base',   tokens: { USDC: 'usdc_base',    USDT: 'usdt' } },
    arbitrum:  { native: 'eth_arbitrum', tokens: { USDC: 'usdc_arbitrum', USDT: 'usdt_arbitrum' } },
    optimism:  { native: 'eth_optimism', tokens: { USDC: 'usdc_optimism', USDT: 'usdt' } },
    polygon:   { native: 'pol_polygon', tokens: { USDC: 'usdc_polygon', USDT: 'usdt_polygon' } },
    bnb:       { native: 'bnb_bsc',    tokens: { USDC: 'usdc_bsc',     USDT: 'usdt_bsc' } },
    avalanche: { native: 'avax_cchain', tokens: { USDC: 'usdc_cchain', USDT: 'usdt' } },
    hyperevm:  { native: 'hype',       tokens: {} },
    bitcoin:   { native: 'btc',        tokens: {} },
    litecoin:  { native: 'ltc',        tokens: {} },
    dogecoin:  { native: 'doge',       tokens: {} },
    bitcoincash: { native: 'bch',      tokens: {} },
    solana:    { native: 'sol',        tokens: { USDC: 'usdc_sol',     USDT: 'usdt_sol' } },
    tron:      { native: 'trx',        tokens: { USDT: 'usdt_tron' } },
    ton:       { native: 'ton',        tokens: { USDT: 'usdt_ton' } },
    xrp:       { native: 'xrp',        tokens: {} },
    stellar:   { native: 'xlm',        tokens: {} },
    tezos:     { native: 'xtz',        tokens: {} },
    cardano:   { native: 'ada',        tokens: {} },
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
    // Optional extra MoonPay params (e.g. recurring-buy flags for C2). Never a secret.
    if (opts.extraParams) for (const k in opts.extraParams) { const v = opts.extraParams[k]; if (v != null && v !== '') params.set(k, String(v)); }
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
    if (opts.extraParams) for (const k in opts.extraParams) { const v = opts.extraParams[k]; if (v != null && v !== '') params.set(k, String(v)); }
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

  // LIVE server endpoints (accounts service, CORS-open /config + /sign, authed
  // /swap + /commerce). The web wallet is served from blockle.org so these are
  // same-origin; absolute URLs keep the surface identical across every wallet.
  const CONFIG_ENDPOINT = 'https://blockle.org/account/api/moonpay/config';
  const SIGN_ENDPOINT = 'https://blockle.org/account/api/moonpay/sign';
  const SWAP_ENDPOINT = 'https://blockle.org/account/api/moonpay/swap';
  const COMMERCE_ENDPOINT = 'https://blockle.org/account/api/moonpay/commerce';

  // Persisted config (Store key 'moonpay'), merged over defaults. Reads are
  // best-effort: a missing Store or key yields the defaults.
  const CONFIG_DEFAULTS = {
    apiKey: DEFAULT_API_KEY,
    signingEndpoint: '',     // e.g. https://blockle.org/account/api/moonpay/sign
    theme: 'dark',
    currencyCodes: null,     // per-chain override map (same shape as DEFAULT_MAP)
    baseCurrencyCode: 'usd',
    commercePublicKey: '',
    features: { buy: true, sell: true, swap: false, commerce: false },
    live: false,
  };

  // In-memory cache of the remote /config response. This is the SOURCE OF TRUTH
  // for apiKey (replaces the pk_test default) + commercePublicKey + feature flags
  // once loadRemoteConfig() has run. Holds ONLY public values — never a secret.
  let _remote = null;

  // NET-NEW: pull the live publishable key + commerce public key + feature flags
  // from the accounts service and cache them. CORS-open, no auth. On any failure
  // we keep whatever we had (offline fallback = the committed pk_test key).
  async function loadRemoteConfig(fetchFn, endpoint) {
    const f = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return _remote;
    try {
      const res = await f(endpoint || CONFIG_ENDPOINT, { credentials: 'omit' });
      if (!res || !res.ok) return _remote;
      const data = await res.json();
      if (data && data.publishableKey) {
        _remote = {
          enabled: !!data.enabled,
          live: !!data.live,
          apiKey: data.publishableKey,
          commercePublicKey: data.commercePublicKey || '',
          features: Object.assign({ buy: true, sell: true, swap: false, commerce: false }, data.features || {}),
        };
      }
    } catch {}
    return _remote;
  }

  // The current feature flags (post-/config). Buttons gate on these; before the
  // remote load, buy/sell default on (they work via /sign or the sandbox key).
  function features() { return (_remote && _remote.features) || CONFIG_DEFAULTS.features; }
  function commercePublicKey() { return (_remote && _remote.commercePublicKey) || ''; }
  function remoteConfig() { return _remote; }

  async function loadConfig() {
    let saved = {};
    try {
      const Store = global.Store;
      if (Store && Store.get) saved = (await Store.get('moonpay')).moonpay || {};
    } catch {}
    const cfg = Object.assign({}, CONFIG_DEFAULTS, saved || {});
    // Remote /config wins for the key + commerce key + flags; pin signingEndpoint
    // to the live /sign route so buy/sell URLs are HMAC-signed server-side.
    if (_remote && _remote.apiKey) {
      cfg.apiKey = _remote.apiKey;
      cfg.signingEndpoint = SIGN_ENDPOINT;
      cfg.commercePublicKey = _remote.commercePublicKey;
      cfg.features = _remote.features;
      cfg.live = _remote.live;
    }
    return cfg;
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
      extraParams: opts.extraParams,
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

  /* ---------------- S3 SWAP (crypto<->crypto via the Trade API) ----------------
   * Thin authed proxy: POST {swapEndpoint} { method, path, query, body }. The
   * trade key stays server-side; the browser only forwards the call with its
   * accounts session cookie. Returns { ok, status, body }. */
  async function swap(method, path, opts) {
    opts = opts || {};
    const f = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('moonpay swap: no fetch');
    const res = await f(opts.endpoint || SWAP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ method: method === 'POST' ? 'POST' : 'GET', path: path, query: opts.query || {}, body: opts.body || null }),
    });
    let body = null; try { body = await res.json(); } catch {}
    return { ok: !!(res && res.ok), status: res ? res.status : 0, body: body };
  }
  // Convenience: a crypto->crypto quote. sell/buy are MoonPay currencyCodes.
  function swapQuote(o) {
    o = o || {};
    return swap('GET', '/v3/currencies/' + encodeURIComponent(o.sellAsset) + '/buy_quote', {
      query: { quoteCurrencyCode: o.buyAsset, baseCurrencyAmount: o.amount }, fetchFn: o.fetchFn,
    });
  }
  // Convenience: execute a previously-quoted trade.
  function swapExecute(o) {
    o = o || {};
    return swap('POST', '/v3/trades', { body: Object.assign({ quoteId: o.quoteId }, o.body || {}), fetchFn: o.fetchFn });
  }

  /* ---------------- S4 STATUS (recent MoonPay transactions) ----------------
   * Two sources: (1) widget redirect-callback params captured on return and
   * persisted to Store; (2) an authed /swap poll of /v3/transactions. Returns
   * [{ id, type, status, asset, amountUsd, at }], newest first. */
  const STATUS_KEY = 'moonpay_txns';
  async function _localTxns() {
    try { const Store = global.Store; if (Store && Store.get) return (await Store.get(STATUS_KEY))[STATUS_KEY] || []; } catch {}
    return [];
  }
  // Capture a widget return: pass a URLSearchParams / query string / object of the
  // redirectURL callback params and we persist a normalized txn record (dedup by id).
  async function captureReturn(input, hint) {
    let q = {};
    try {
      if (!input) q = {};
      else if (typeof input === 'string') q = Object.fromEntries(new URLSearchParams(input.indexOf('?') >= 0 ? input.slice(input.indexOf('?')) : input));
      else if (typeof URLSearchParams !== 'undefined' && input instanceof URLSearchParams) q = Object.fromEntries(input);
      else q = input;
    } catch { q = {}; }
    const id = q.transactionId || q.id || q.transactionID || (hint && hint.id) || ('mp_' + Date.now());
    const rec = {
      id: String(id),
      type: (hint && hint.type) || 'buy',
      status: q.transactionStatus || q.status || 'pending',
      asset: q.currencyCode || q.baseCurrencyCode || (hint && hint.asset) || '',
      amountUsd: Number(q.baseCurrencyAmount || (hint && hint.amountUsd) || 0) || null,
      at: Date.now(),
    };
    try {
      const Store = global.Store;
      if (Store && Store.set) {
        const list = await _localTxns();
        const next = [rec].concat(list.filter((x) => x.id !== rec.id)).slice(0, 50);
        await Store.set({ [STATUS_KEY]: next });
      }
    } catch {}
    return rec;
  }
  async function status(opts) {
    opts = opts || {};
    let out = await _localTxns();
    // Richer source (best-effort, needs a session): the authed /swap transactions poll.
    if (opts.poll) {
      try {
        const r = await swap('GET', '/v3/transactions', { query: { limit: opts.limit || 20 }, fetchFn: opts.fetchFn });
        if (r.ok && Array.isArray(r.body)) {
          const remote = r.body.map((t) => ({ id: String(t.id), type: t.type || 'swap', status: t.status, asset: t.currencyCode || t.baseCurrencyCode || '', amountUsd: Number(t.baseCurrencyAmount) || null, at: Date.parse(t.createdAt || '') || Date.now() }));
          const seen = {}; out = remote.concat(out).filter((x) => (seen[x.id] ? false : (seen[x.id] = true)));
        }
      } catch {}
    }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, opts.limit || 20);
  }

  /* ---------------- CREATIVE HELPERS (thin wrappers; one call per UI hook) ---- */
  // C1/C3/C6 — buy exactly the shortfall (rounded up) so the caller can auto-continue.
  async function topUpShortfall(o) {
    o = o || {};
    const amt = Math.max(1, Math.ceil(Number(o.shortfallUsd) || 0));
    const r = await buyUrl({ chain: o.chain, symbol: o.symbol, native: o.native, walletAddress: o.walletAddress, baseCurrencyAmount: amt, redirectURL: o.redirectURL, fetchFn: o.fetchFn });
    return Object.assign({ amountUsd: amt, onReturn: (cb) => captureReturn(cb, { type: 'buy', asset: o.symbol || o.chain, amountUsd: amt }) }, r);
  }
  // C2 — a recurring MoonPay buy preset + the matching DCA bot spec for the engine.
  async function recurringBuyPreset(o) {
    o = o || {};
    const amt = Math.max(1, Math.ceil(Number(o.weeklyUsd) || 0));
    const r = await buyUrl({ chain: o.chain, symbol: o.symbol, native: o.native, walletAddress: o.walletAddress, baseCurrencyAmount: amt, redirectURL: o.redirectURL, fetchFn: o.fetchFn, extraParams: { paymentMethod: 'credit_debit_card', recurring: 'weekly' } });
    return Object.assign({ amountUsd: amt, botSpec: { type: 'dca', allocationUsd: amt, cadence: 'weekly' } }, r);
  }
  // C4 — sell exactly the realized gain to fiat.
  async function cashOutGains(o) {
    o = o || {};
    const amt = Number(o.gainAmount) || 0;
    return sellUrl({ chain: o.chain, symbol: o.symbol, native: o.native, walletAddress: o.walletAddress, baseCurrencyAmount: amt > 0 ? amt : undefined, redirectURL: o.redirectURL, fetchFn: o.fetchFn });
  }
  // C5 — MoonPay doesn't list BLOCK: BUY USDC, then SWAP USDC->BLOCK on the native
  // /dex. Returns a 2-step guided plan; step2 is a dex deep-link the caller opens.
  async function getBlockWithCard(o) {
    o = o || {};
    const chain = o.chain || 'solana';
    const usd = Math.max(1, Math.ceil(Number(o.usdAmount) || 0));
    const step1 = await buyUrl({ chain: chain, symbol: 'USDC', walletAddress: o.walletAddress, baseCurrencyAmount: usd, redirectURL: o.redirectURL, fetchFn: o.fetchFn });
    return {
      ok: step1.ok,
      reason: step1.reason,
      amountUsd: usd,
      step1: step1,                                   // buy USDC via MoonPay
      step2: { action: 'dex-swap', from: 'USDC', to: 'BLOCK', chain: chain, deeplink: '/dex?from=USDC&to=BLOCK' },
    };
  }

  /* ---------------- COMMERCE (crypto checkout; grant is server-verified) ------
   * POST {commerceEndpoint} { action:'create'|'status', product, refId, amountUsd,
   * ccy }. The entitlement/grant flips ONLY in the server webhook — never here. */
  async function commerceCheckout(o) {
    o = o || {};
    const f = o.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('moonpay commerce: no fetch');
    const res = await f(o.endpoint || COMMERCE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: o.action || 'create', product: o.product, refId: o.refId, amountUsd: o.amountUsd, ccy: o.ccy || 'USD' }),
    });
    let body = null; try { body = await res.json(); } catch {}
    return { ok: !!(res && res.ok), status: res ? res.status : 0, checkoutId: body && body.checkoutId, hostedUrl: body && body.hostedUrl, body: body };
  }
  function commerceStatus(checkoutId, fetchFn) {
    return commerceCheckout({ action: 'status', refId: checkoutId, fetchFn: fetchFn });
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
    // NET-NEW: live config + swap + status + creative + commerce.
    CONFIG_ENDPOINT,
    SIGN_ENDPOINT,
    SWAP_ENDPOINT,
    COMMERCE_ENDPOINT,
    loadRemoteConfig,
    remoteConfig,
    features,
    commercePublicKey,
    swap,
    swapQuote,
    swapExecute,
    status,
    captureReturn,
    topUpShortfall,
    recurringBuyPreset,
    cashOutGains,
    getBlockWithCard,
    commerceCheckout,
    commerceStatus,
  };

  global.MoonPay = MoonPay;
  if (typeof module !== 'undefined' && module.exports) module.exports = MoonPay;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
