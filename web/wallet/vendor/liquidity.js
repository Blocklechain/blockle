// liquidity.js — Blockle Liquidity client for the WEB WALLET.
//
// Mirrors blockle-app/lib/state/liquidity_controller.dart + liquidity_pool.dart:
// the SERVER treasury (https://blockle.org/account/api/liquidity/*) is the
// authoritative shared state; this module caches /state, previews quotes with
// the SAME bonding-curve math locally (instant UI), and runs the real
// quote/swap/settle against the server. Pending on-chain settlements are
// persisted (Store key 'liq_pending') and re-posted until terminal — the server
// settle endpoint is idempotent, so re-posting is always safe.
//
// ONE BLOCK PRICE across every currency; the curve MUST match the server
// (services/accounts/src/liquidity.js):
//   floor = 0.001 + totalFeesUsd / 50000
//   spot  = floor × max(0.1, 1 + 0.0002 × (50000 − blockTreasury))
//   SELL BLOCK→coin:  usdOut = F·∫ max(MIN_MULT, 1+C·d) dd (piecewise, floored)
//   BUY  coin→BLOCK:  solve (C/2)x² + (1 + C·d0)x − usdIn/F = 0
//
// Fail-soft throughout — the money paths never depend on this module.
// Global `Liquidity`; also CommonJS-exported for the node test harness.
(function (global) {
  'use strict';

  const SERVER_BASE = 'https://blockle.org/account/api/liquidity';

  // Curve constants — MUST match the server + the Flutter pool exactly.
  const BLOCK_SEED_PRICE_USD = 0.001;
  // MOONSHOT CURVE (mirrors services/accounts/src/liquidity.js): depth d = netBought
  // (cumulative BLOCK bought out of the pool by swaps — NOT the treasury balance, so
  // mining emission never moves the price). Fixed steep slope, UNCAPPED: ~$4 after
  // 100k net-bought and it keeps climbing (1M ⇒ ~$40, no ceiling).
  //   C = (REF_PRICE/FLOOR − 1) / REF_BOUGHT = (4/0.001 − 1)/100000 = 0.03999
  const CURVE_REF_PRICE_USD = 4;
  const CURVE_REF_BOUGHT = 100000;
  const CURVE_STEEPNESS = (CURVE_REF_PRICE_USD / BLOCK_SEED_PRICE_USD - 1) / CURVE_REF_BOUGHT;
  const CURVE_MIN_MULT = 0.1;
  // Depth below which the multiplier is FLOORED (heavy net selling); the swap
  // integrals are piecewise over it so price can never go negative.
  const CURVE_D_MIN = (CURVE_MIN_MULT - 1) / CURVE_STEEPNESS;
  // ∫ max(MIN_MULT, 1 + C·d) dd over [a, b] — × floor USD = USD moved.
  function curveMultIntegral(a, b) {
    if (!(b > a)) return 0;
    var total = 0;
    var lo = Math.min(b, CURVE_D_MIN);
    if (lo > a) total += CURVE_MIN_MULT * (lo - a);
    var a2 = Math.max(a, CURVE_D_MIN);
    if (b > a2) total += (b - a2) + (CURVE_STEEPNESS / 2) * (b * b - a2 * a2);
    return total;
  }

  const STATE_TTL_MS = 30 * 1000;
  const PENDING_KEY = 'liq_pending';

  // Base coins the treasury supplies liquidity for — the MoonPay-supported set.
  const kMoonPayCoins = [
    'USDC', 'USDT', 'DAI', 'ETH', 'BTC', 'SOL', 'BNB', 'MATIC', 'AVAX',
    'ADA', 'DOGE', 'LTC', 'TRX', 'XRP', 'DOT', 'BCH',
  ];

  const TOKEN_COINS = { USDC: true, USDT: true, DAI: true };

  // Coin → web-wallet chain id (null = no native send leg wired in this wallet).
  const COIN_CHAIN = {
    BLOCK: 'block',
    ETH: 'ethereum', USDC: 'ethereum', USDT: 'ethereum', DAI: 'ethereum',
    SOL: 'solana',
    BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', BCH: 'bitcoincash',
    XRP: 'xrp', ADA: 'cardano', TRX: 'tron',
    BNB: 'bnb', MATIC: 'polygon', AVAX: 'avalanche',
  };

  // Native units kept back so the payout/sweep tx can still pay its own gas.
  const GAS_RESERVE = {
    ETH: 0.0006, BNB: 0.0008, MATIC: 0.05, AVAX: 0.01,
    SOL: 0.00002, BLOCK: 0.001,
    BTC: 0.0003, LTC: 0.0003, BCH: 0.0003, DOGE: 0.0003,
    XRP: 0.00002, ADA: 0.2, TRX: 1,
  };

  function up(s) { return String(s || '').toUpperCase(); }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : (d || 0); }
  function trim(v) { return v >= 1 ? v.toFixed(4) : v.toFixed(6); }

  // Lazily-resolved injectables so the node tests can swap them out
  // (Liquidity._fetch / Liquidity._store) without a DOM or network.
  function doFetch(url, opts) {
    const f = L._fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return Promise.reject(new Error('no fetch available'));
    return f(url, opts);
  }
  function store() {
    return L._store || global.Store || null;
  }

  async function postJson(path, body, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 12000) : null;
    try {
      const r = await doFetch(SERVER_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
      return await r.json();
    } finally {
      if (t) clearTimeout(t);
    }
  }

  // ---- curve math (preview only — the server quote is authoritative) --------

  function priceFloorUsd(totalFeesUsd) {
    return BLOCK_SEED_PRICE_USD + num(totalFeesUsd) / CURVE_REF_BOUGHT;
  }

  function spotPriceUsd(totalFeesUsd, netBought) {
    const mult = 1 + CURVE_STEEPNESS * num(netBought);
    return priceFloorUsd(totalFeesUsd) * Math.max(CURVE_MIN_MULT, mult);
  }

  function stateTotals() {
    const s = L.state || {};
    // Depth = net BLOCK bought by swaps. Prefer the server's netBought; fall back to
    // the legacy balance-based depth (50000 − treasury) only for an old server.
    let netBought = num(s.netBought, NaN);
    if (!Number.isFinite(netBought)) netBought = 50000 - num(s.blockTreasury, 50000);
    let fees = num(s.totalFeesUsd, NaN);
    if (!Number.isFinite(fees)) {
      fees = 0;
      const f = s.fees || {};
      for (const k in f) fees += num(f[k]);
    }
    // treasury = real BLOCK inventory (uncapped), only for the buy-side availability cap.
    const treasury = num(s.blockTreasury, 50000);
    return { netBought, treasury, fees, reserves: s.reserves || {} };
  }

  /// Instant local preview of a swap along the bonding curve (one side must be
  /// BLOCK). Same shape as the server quote: {ok, amountIn, amountOut, assetIn,
  /// assetOut, blockPriceUsd} or {ok:false, reason}. Marked local:true.
  function localQuote(from, to, amountIn, coinUsd) {
    from = up(from); to = up(to);
    const { netBought, treasury, fees, reserves } = stateTotals();
    const bp = spotPriceUsd(fees, netBought); // spot (pre-trade), for display
    const base = { local: true, assetIn: from, assetOut: to, blockPriceUsd: bp };
    amountIn = num(amountIn);
    if (!(amountIn > 0)) return Object.assign({ ok: false, reason: 'Enter an amount' }, base);
    if ((from === 'BLOCK') === (to === 'BLOCK')) {
      return Object.assign({ ok: false, reason: 'One side must be BLOCK' }, base);
    }
    const cu = num(coinUsd) > 0 ? num(coinUsd) : 1.0;
    const F = priceFloorUsd(fees);
    const C = CURVE_STEEPNESS;
    const d0 = netBought;
    if (from === 'BLOCK') {
      // SELL BLOCK → coin: usdOut = ∫ p dd over the BLOCK returned.
      const x = amountIn;
      const usdOut = F * curveMultIntegral(d0 - x, d0); // piecewise: floored price on deep sells, never negative
      const out = usdOut / cu;
      const have = num(reserves[to]);
      if (!(out > 0)) return Object.assign({ ok: false, reason: 'Amount too small' }, base);
      if (out > have) {
        return Object.assign({
          ok: false,
          reason: have <= 0
            ? 'No liquidity for ' + to + ' yet — bot fees fund it'
            : 'Only ' + trim(have) + ' ' + to + ' available',
        }, base);
      }
      return Object.assign({ ok: true, amountIn: amountIn, amountOut: out }, base);
    }
    // BUY coin → BLOCK: solve (C/2)x² + (1+C·d0)x − usdIn/F = 0 for x BLOCK out.
    const usdIn = amountIn * cu;
    let out;
    if (d0 >= CURVE_D_MIN) {
      const a = F * C / 2;
      const b = F * (1 + C * d0);
      out = a <= 0 ? usdIn / b : (-b + Math.sqrt(b * b + 4 * a * usdIn)) / (2 * a);
    } else {
      // starts in the floored region: fill at MIN_MULT·F to the breakpoint,
      // then walk the linear curve with whatever USD remains.
      const flatUsd = F * CURVE_MIN_MULT * (CURVE_D_MIN - d0);
      if (usdIn <= flatUsd) out = usdIn / (F * CURVE_MIN_MULT);
      else {
        const rem = usdIn - flatUsd;
        const a = F * C / 2;
        const b = F * CURVE_MIN_MULT;
        const xLin = a <= 0 ? rem / b : (-b + Math.sqrt(b * b + 4 * a * rem)) / (2 * a);
        out = (CURVE_D_MIN - d0) + xLin;
      }
    }
    if (!(out > 0)) return Object.assign({ ok: false, reason: 'Amount too small' }, base);
    if (out > treasury) return Object.assign({ ok: false, reason: 'Treasury BLOCK exhausted' }, base);
    return Object.assign({ ok: true, amountIn: amountIn, amountOut: out }, base);
  }

  // ---- server state ---------------------------------------------------------

  let stateAt = 0;
  let stateInflight = null;

  /// GET /state, cached 30s. Fail-soft: on any error the previous state (or
  /// null) is kept. Returns the state (or null).
  async function loadState(force) {
    const now = Date.now();
    if (!force && L.state && now - stateAt < STATE_TTL_MS) return L.state;
    if (stateInflight) return stateInflight;
    stateInflight = (async () => {
      try {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const t = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
        try {
          const r = await doFetch(SERVER_BASE + '/state', { signal: ctl ? ctl.signal : undefined });
          if (r && (r.ok === undefined || r.ok)) {
            const j = await r.json();
            if (j && j.blockTreasury != null) {
              L.state = j;
              stateAt = Date.now();
            }
          }
        } finally {
          if (t) clearTimeout(t);
        }
      } catch (_) { /* keep the previous state */ }
      return L.state;
    })();
    try { return await stateInflight; } finally { stateInflight = null; }
  }

  // ---- quote / swap / settle ------------------------------------------------

  /// Server quote (authoritative); falls back to the local curve preview when
  /// offline. Never throws.
  async function quote(from, to, amountIn, coinUsd) {
    try {
      const j = await postJson('/quote', {
        from: up(from), to: up(to), amountIn: num(amountIn), coinUsd: num(coinUsd),
      }, 12000);
      if (j && typeof j === 'object') return j;
    } catch (_) { /* offline → local preview */ }
    return localQuote(from, to, amountIn, coinUsd);
  }

  /// Start a swap server-side. Returns the settlement record (quote fields +
  /// {id, depositAddress, status}) or {ok:false, error} — never throws.
  async function startSwap(opts) {
    opts = opts || {};
    try {
      const j = await postJson('/swap', {
        from: up(opts.from), to: up(opts.to),
        amountIn: num(opts.amountIn), coinUsd: num(opts.coinUsd),
        userAddress: opts.userAddress,
      }, 12000);
      loadState(true).catch(function () {}); // reserves moved — refresh
      return j;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /// Settle a swap: post the user's deposit txid; the server verifies it and
  /// pays out. IDEMPOTENT server-side — safe to re-post. Never throws.
  async function settle(id, depositTxid) {
    try {
      const j = await postJson('/settle', { id: id, depositTxid: depositTxid }, 25000);
      loadState(true).catch(function () {});
      return j;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---- pending settlements (auto-resume) ------------------------------------
  // Once a deposit is broadcast the swap can finalize only after it confirms
  // (BLOCK is a ~10-minute block). Persist {id, depositTxid, …} so the payout
  // completes automatically later, even across reloads.

  async function loadPending() {
    try {
      const S = store();
      if (!S) return [];
      const got = await S.get(PENDING_KEY);
      const v = got && got[PENDING_KEY];
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }

  async function savePending(list) {
    try {
      const S = store();
      if (S) { const o = {}; o[PENDING_KEY] = list; await S.set(o); }
    } catch (_) { /* best-effort */ }
  }

  /// Register a broadcast-but-not-yet-settled swap ({id, depositTxid, from, to,
  /// amountOut, …}) for automatic completion by resumePending().
  async function addPending(rec) {
    if (!rec || !rec.id) return;
    const list = (await loadPending()).filter(function (e) { return e.id !== rec.id; });
    list.push(rec);
    await savePending(list);
  }

  async function removePending(id) {
    const list = await loadPending();
    const next = list.filter(function (e) { return e.id !== id; });
    if (next.length !== list.length) await savePending(next);
  }

  async function pending() { return loadPending(); }

  /// Retry every pending settlement. Settled / refunded / terminally-failed /
  /// unknown swaps are dropped; a still-confirming one is kept for the next
  /// pass. Safe to call repeatedly (settle is idempotent server-side).
  async function resumePending() {
    const list = await loadPending();
    for (const rec of list) {
      const r = await settle(String(rec.id), String(rec.depositTxid || ''));
      const st = String((r && r.status) || '');
      const err = String((r && r.error) || '');
      const terminal = st === 'settled' || st === 'refunded' || st === 'unsupported' ||
        st === 'failed' || err.indexOf('unknown swap') !== -1;
      if (terminal) await removePending(rec.id);
    }
    return loadPending();
  }

  // ---- bot fee intake --------------------------------------------------------

  /// Deposit a 0.05% bot fee into the shared server treasury. Fire-and-forget.
  function takeFee(coin, feeUsd, coinUsd, mode) {
    feeUsd = num(feeUsd);
    if (!(feeUsd > 0)) return;
    // The server only credits fees marked mode:'live' (paper fills move no real
    // money and must not inflate the ledger).
    postJson('/fee', { coin: up(coin), feeUsd: feeUsd, coinUsd: num(coinUsd), mode: mode || 'paper' }, 8000)
      .catch(function () { /* best-effort */ });
  }

  // ---- helpers ---------------------------------------------------------------

  /// The web-wallet chain id a coin's native send leg runs on (null = unwired).
  function chainForCoin(coin) { return COIN_CHAIN[up(coin)] || null; }

  /// Coins that are TOKENS on their chain (ERC-20 on Ethereum) — the send leg
  /// needs a token transfer, not a native transfer.
  function isTokenCoin(coin) { return !!TOKEN_COINS[up(coin)]; }

  /// Native units to keep back for gas when sweeping/sending this coin.
  function gasReserve(coin) { return GAS_RESERVE[up(coin)] || 0; }

  /// USD liquidity actually AVAILABLE for a coin: the accounting reserve capped
  /// by the hot wallet's REAL on-chain spendable balance when settlement is
  /// live. What the ledger says means nothing if the wallet lacks the coins.
  function availableUsd(coin, pxUsd) {
    const c = up(coin);
    const s = L.state || {};
    const px = num(pxUsd) > 0 ? num(pxUsd) : 1.0;
    const reserve = num((s.reserves || {})[c]);
    let units = reserve;
    if (String(s.settlement || '') === 'onchain') {
      const oc = (s.onchain || {})[c];
      const spend = oc && oc.spendable != null ? num(oc.spendable) : null;
      if (spend != null) units = Math.min(reserve, spend);
    }
    return units * px;
  }

  const L = {
    SERVER_BASE: SERVER_BASE,
    BLOCK_SEED_PRICE_USD: BLOCK_SEED_PRICE_USD,
    CURVE_REF_PRICE_USD: CURVE_REF_PRICE_USD,
    CURVE_REF_BOUGHT: CURVE_REF_BOUGHT,
    CURVE_STEEPNESS: CURVE_STEEPNESS,
    CURVE_MIN_MULT: CURVE_MIN_MULT,
    kMoonPayCoins: kMoonPayCoins,

    state: null, // last /state payload (null until loaded)
    loadState: loadState,

    priceFloorUsd: priceFloorUsd,
    spotPriceUsd: spotPriceUsd,
    localQuote: localQuote,
    quote: quote,
    startSwap: startSwap,
    settle: settle,

    pending: pending,
    addPending: addPending,
    removePending: removePending,
    resumePending: resumePending,

    takeFee: takeFee,

    chainForCoin: chainForCoin,
    isTokenCoin: isTokenCoin,
    gasReserve: gasReserve,
    availableUsd: availableUsd,

    // Test injection points (node harness): fetch + Store stand-ins.
    _fetch: null,
    _store: null,
  };

  global.Liquidity = L;
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
