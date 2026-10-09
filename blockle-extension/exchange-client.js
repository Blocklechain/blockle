// exchange-client.js — embedded client for the Blockle Exchange relay.
//
// REUSE, DO NOT REIMPLEMENT. This mirrors the SHARED EXCHANGE API CONTRACT as
// spoken by exchange/web/core.js (window.EX.api) and the SDK's ExchangeClient
// (sdk/src/exchange.ts). The relay is NON-CUSTODIAL: it only coordinates
// nonces, order intents and HTLC steps. It NEVER sees a key.
//
// The one difference from the web core.js: there, the page asks a separate
// wallet extension (window.blockle) to sign. HERE WE ARE THE WALLET — so every
// signature is produced locally by `Wallet` (ML-DSA-44 via blockle-wasm). Keys
// never leave the device and are never sent to the relay.
//
// Exposed as global `Exchange`.
(function (global) {
  const DEFAULT_BASE = 'https://exchange.blockle.org';
  // The x402 seller endpoints (buy-block) may live on the relay or a separate
  // service; default to the relay base and let settings override.
  async function base() {
    const { exchangeBase } = await Store.get('exchangeBase');
    return (exchangeBase || DEFAULT_BASE).replace(/\/$/, '');
  }
  async function x402Base() {
    const { x402Base } = await Store.get('x402Base');
    if (x402Base) return x402Base.replace(/\/$/, '');
    return base();
  }
  function wsFrom(httpBase) {
    return httpBase.replace(/^http/, 'ws');
  }

  // ---- deterministic JSON (MUST match the relay + SDK canonical()) --------
  function canonical(obj) {
    return JSON.stringify(sortKeys(obj));
  }
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).sort().forEach((k) => (out[k] = sortKeys(v[k])));
      return out;
    }
    return v;
  }

  // base units <-> human (amounts on the wire are ALWAYS base-unit strings)
  function toHuman(baseUnits, decimals) {
    try {
      const neg = String(baseUnits).charAt(0) === '-';
      let s = String(baseUnits).replace('-', '');
      const d = Number(decimals) || 0;
      if (d === 0) return (neg ? '-' : '') + s;
      while (s.length <= d) s = '0' + s;
      const whole = s.slice(0, s.length - d);
      const frac = s.slice(s.length - d).replace(/0+$/, '');
      return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
    } catch {
      return String(baseUnits);
    }
  }
  function toBase(human, decimals) {
    const d = Number(decimals) || 0;
    let s = String(human == null ? '' : human).trim();
    if (!s || isNaN(Number(s))) return '0';
    const neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    const parts = s.split('.');
    const whole = parts[0] || '0';
    let frac = parts[1] || '';
    frac = (frac + '0'.repeat(d)).slice(0, d);
    const combined = (whole + frac).replace(/^0+/, '') || '0';
    return (neg ? '-' : '') + combined;
  }

  // ---- session (bearer token; ephemeral, never persisted to disk) ---------
  // Kept in chrome.storage.session so it survives a popup reopen but is cleared
  // when the browser closes. The token is NOT a key — it is a signed-nonce
  // receipt that proves we control the address for this session only.
  let session = null; // { token, address, chain, expires }
  async function loadSession() {
    if (session) return session;
    const s = await Session.get('ex:session');
    if (s && (!s.expires || s.expires * 1000 > Date.now())) session = s;
    return session;
  }
  async function saveSession(s) {
    session = s;
    await Session.set('ex:session', s);
  }
  async function clearSession() {
    session = null;
    await Session.clear('ex:session');
  }

  function authHeaders(h) {
    const out = { 'content-type': 'application/json', accept: 'application/json' };
    if (session && session.token) out['authorization'] = 'Bearer ' + session.token;
    if (h) Object.assign(out, h);
    return out;
  }

  async function req(method, path, body, withAuth) {
    const b = await base();
    const opts = { method, headers: authHeaders() };
    if (!withAuth) delete opts.headers['authorization'];
    if (body != null) opts.body = JSON.stringify(body);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(b + path, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const msg = (data && (data.error || data.message)) || 'HTTP ' + res.status;
        const err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  // ---- raw contract calls (mirror core.js EX.api) -------------------------
  const api = {
    nonce: (address, chain) => req('POST', '/auth/nonce', { address, chain }, false),
    verify: (b) => req('POST', '/auth/verify', b, false),
    markets: () => req('GET', '/markets', null, false),
    book: (m) => req('GET', '/book/' + encodeURIComponent(m), null, false),
    trades: (m) => req('GET', '/trades/' + encodeURIComponent(m), null, false),
    placeOrder: (b) => req('POST', '/orders', b, true),
    cancelOrder: (id, b) => req('DELETE', '/orders/' + encodeURIComponent(id), b, true),
    myOrders: () => req('GET', '/orders/mine', null, true),
    mySwaps: () => req('GET', '/swaps/mine', null, true),
    swapStep: (id, b) => req('POST', '/swaps/' + encodeURIComponent(id) + '/step', b, true),
    listings: () => req('GET', '/listings', null, false),
    listingQuote: (b) => req('POST', '/listings/quote', b, false),
    createListing: (b) => req('POST', '/listings', b, true),
  };

  // ---- the local BLOCK signer (ML-DSA via Wallet) -------------------------
  // Returns the hex signature string the relay's blockle-wasm verify() expects,
  // plus the public key that commits to the address (required at /auth/verify
  // so the relay can verify this session's orders).
  async function signBlock(message) {
    if (!Wallet.isUnlocked()) throw new Error('locked');
    const r = await Wallet.signMessage(message);
    const signature = typeof r === 'string' ? r : (r && (r.signature || r.sig)) || '';
    const publicKey = (r && r.publicKey) || Wallet.publicKeyHex || '';
    return { signature, publicKey };
  }

  // ---- swap / quote / money helpers (pure + BLOCK-rail I/O) ---------------
  // The site base hosts the buy-curve config + the sell settlement endpoint
  // (mirrors sdk/money.ts SettlementClient, which uses siteUrl, not the relay).
  async function siteBase() {
    const { siteBase } = await Store.get('siteBase');
    return (siteBase || 'https://blockle.org').replace(/\/$/, '');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status >= 400) {
      const e = new Error((data && (data.error || data.message)) || 'HTTP ' + res.status);
      e.status = res.status; e.data = data; throw e;
    }
    return data;
  }
  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status >= 400) {
      const e = new Error((data && (data.error || data.message)) || 'HTTP ' + res.status);
      e.status = res.status; e.data = data; throw e;
    }
    return data;
  }

  // BigInt of a base-unit integer string.
  function bi(v) {
    const s = String(v == null ? '0' : v).trim();
    if (!/^-?\d+$/.test(s)) throw new Error('expected base-unit integer: ' + s);
    return BigInt(s);
  }
  // price "quote per base" (possibly decimal) -> exact rational {num, den}.
  function priceFraction(price) {
    const s = String(price == null ? '0' : price).trim();
    const neg = s.charAt(0) === '-';
    const body = neg ? s.slice(1) : s;
    const dot = body.split('.');
    const whole = dot[0] || '0';
    const frac = dot[1] || '';
    const den = 10n ** BigInt(frac.length);
    const num = BigInt((whole + frac) || '0');
    return { num: neg ? -num : num, den };
  }

  // Resolve which market + side trades `from` -> `to`. Pure; mirrors the SDK:
  // a direct <from>/<to> market is a SELL of base; the inverse market is a BUY.
  function resolveSwap(markets, from, to) {
    const F = String(from), T = String(to);
    const list = markets || [];
    const direct = list.find((m) => m.base === F && m.quote === T);
    const inverse = list.find((m) => m.base === T && m.quote === F);
    const m = direct || inverse;
    if (!m) throw new Error('no market for ' + F + '/' + T);
    return { market: m.market, side: direct ? 'sell' : 'buy', inverse: !direct, marketInfo: m };
  }

  // Walk the book to estimate output, exact BigInt. `amountIn` is base units of
  // the asset we spend (base asset when selling, quote asset when buying).
  // levels = [{price, amount}] best-first; `amount` is base-asset base units.
  function walkBook(side, amountIn, levels) {
    levels = levels || [];
    let out = 0n, partial = false;
    if (side === 'sell') {
      let rem = bi(amountIn); // base asset to sell
      for (const lv of levels) {
        if (rem <= 0n) break;
        const { num, den } = priceFraction(lv.price);
        const have = bi(lv.amount);
        const fill = have < rem ? have : rem;
        out += (fill * num) / den; // quote asset received
        rem -= fill;
      }
      partial = rem > 0n;
    } else {
      let rem = bi(amountIn); // quote asset to spend
      for (const lv of levels) {
        if (rem <= 0n) break;
        const { num, den } = priceFraction(lv.price);
        if (num <= 0n) continue;
        const levelBase = bi(lv.amount);
        const costAll = (levelBase * num) / den; // quote to take the whole level
        if (rem >= costAll) { out += levelBase; rem -= costAll; }
        else { out += (rem * den) / num; rem = 0n; }
      }
      partial = rem > 0n;
    }
    return { amountOut: out.toString(), partial };
  }

  // minimum acceptable output after a slippage FRACTION (0.01 = 1%).
  function minOutOf(amountOut, slippage) {
    const out = bi(amountOut);
    const s = Number(slippage);
    if (!isFinite(s) || s <= 0) return out.toString();
    const keep = 10000n - BigInt(Math.round(Math.min(s, 1) * 10000));
    return ((out * keep) / 10000n).toString();
  }

  // The base-unit listing fee the relay states in its quote (never inferred
  // from USD — fail closed if the relay didn't name an exact amount).
  function listingFeeAmount(quote) {
    const amt = quote && (quote.payAmount != null
      ? quote.payAmount
      : (quote.payAsset && quote.payAsset.extra && quote.payAsset.extra.amount));
    if (amt == null) throw new Error('listing quote did not include a base-unit payAmount — cannot pay fee safely');
    return String(amt);
  }

  // Send BLOCK on the native rail: build + sign (local ML-DSA) + broadcast.
  // Returns the raw-hex txid. Keys never leave the Wallet session.
  async function blockSend(to, amountBase, feeBase) {
    if (!Wallet.isUnlocked || !Wallet.isUnlocked()) throw new Error('locked');
    const u = await Chain.utxos(Wallet.address);
    const utxos = (u && u.utxos) || [];
    const built = await Wallet.buildTransfer(utxos, to, BigInt(amountBase), BigInt(feeBase == null ? 100000 : feeBase));
    const res = await Chain.submit(built.raw);
    const txid = (res && (res.txid || res.result)) || built.txid;
    return String(txid);
  }

  async function waitForBlockTx(txid, minConfs, timeoutMs) {
    if (!minConfs) return null;
    const deadline = Date.now() + (timeoutMs || 120000);
    while (Date.now() < deadline) {
      try {
        const t = await Chain.tx(txid);
        if (t) { const c = t.confirmations; if (c == null || c >= minConfs) return t; }
      } catch (_) {}
      await sleep(2500);
    }
    throw new Error('timed out waiting for BLOCK tx ' + txid);
  }

  const Exchange = {
    DEFAULT_BASE,
    canonical,
    toHuman,
    toBase,
    api,
    // pure helpers (exported for reuse + tests)
    resolveSwap,
    walkBook,
    async baseUrl() {
      return base();
    },

    isSignedIn() {
      return !!(session && session.token);
    },
    sessionAddress() {
      return session && session.address;
    },
    async resume() {
      await loadSession();
      // A session only counts if it matches the active wallet address.
      if (session && Wallet.address && session.address !== Wallet.address) {
        await clearSession();
      }
      return this.isSignedIn();
    },
    async signOut() {
      await clearSession();
    },

    // Sign in with the active BLOCK wallet: nonce -> ML-DSA signature -> token.
    async signIn() {
      const address = Wallet.address;
      if (!address) throw new Error('no wallet');
      if (!Wallet.isUnlocked()) throw new Error('locked');
      const chain = 'block';
      const res = await api.nonce(address, chain);
      const nonce = (res && (res.nonce || res.message)) || res;
      const { signature, publicKey } = await signBlock(String(nonce));
      const verify = await api.verify({ address, chain, signature, publicKey, nonce });
      const token = verify && (verify.token || verify.session);
      if (!token) throw new Error('relay did not return a session token');
      await saveSession({ token, address, chain, expires: verify.expires });
      return true;
    },
    async ensureSignedIn() {
      await this.resume();
      if (!this.isSignedIn()) await this.signIn();
    },

    // ---- market data (public) ---------------------------------------------
    getMarkets: () => api.markets(),
    getBook: (m) => api.book(m),
    getTrades: (m) => api.trades(m),
    getListings: () => api.listings(),

    // ---- signed orders (mirror sdk ExchangeClient.placeOrder) -------------
    // amount/price are base-unit strings per the contract. We build the EXACT
    // intent object we sign and send it back as body.intent so the relay
    // re-canonicalises and verifies the same bytes.
    async placeOrder(p) {
      await this.ensureSignedIn();
      const intent = {
        market: p.market,
        side: p.side,
        type: p.type || 'limit',
        price: p.price != null ? String(p.price) : null,
        amount: String(p.amount),
        expiry: p.expiry || Math.floor(Date.now() / 1000) + 3600,
        maker: Wallet.address,
        nonce: Date.now() + '-' + Math.random().toString(16).slice(2),
      };
      const { signature, publicKey } = await signBlock(canonical(intent));
      return api.placeOrder({ ...intent, intent, signature, publicKey });
    },

    async cancelOrder(orderId) {
      await this.ensureSignedIn();
      const { signature } = await signBlock(canonical({ action: 'cancel', orderId }));
      return api.cancelOrder(orderId, { signature });
    },

    getMyOrders: () => api.myOrders(),
    getMySwaps: () => api.mySwaps(),

    // ---- listing quote (public): $5 base + $1 per extra pair --------------
    // Positional signature mirrors the SDK (asset, extraPairs) — tools.js calls
    // ex.listingQuote(asset, extraPairs); the wire form is POST {asset, extraPairs}.
    listingQuote: (asset, extraPairs) => api.listingQuote({ asset, extraPairs: extraPairs || [] }),

    // ---- quote a swap from the live book (READ-ONLY, no signing) ----------
    // Resolves the market/side for from->to and walks the book for an exact
    // expected-out estimate + slippage-adjusted minimum. Venues (blockle) use
    // this as their pricing source; the `quote` tool surfaces it to the model.
    async quote(from, to, amount, opts) {
      opts = opts || {};
      const markets = await this.getMarkets();
      const { market, side, inverse } = resolveSwap(markets, from, to);
      const book = await this.getBook(market);
      const levels = side === 'sell' ? (book.bids || []) : (book.asks || []);
      const walk = walkBook(side, String(amount), levels);
      const slip = opts.slippage == null ? 0.005 : opts.slippage;
      return {
        venue: 'blockle-exchange', market, side, inverse,
        from: String(from), to: String(to),
        amountIn: String(amount), amountOut: walk.amountOut,
        minOut: minOutOf(walk.amountOut, slip),
        partial: walk.partial, route: [market],
      };
    },

    // ---- swap: sign + take/post the best order on the live exchange -------
    // Mirrors sdk ExchangeClient.swap. Accepts positional (from, to, amount,
    // opts) OR a single object { from, to, amount, slippage }. Signs locally
    // (ML-DSA), places a market take against the best resting order (or posts a
    // maker limit when the book side is empty), then best-effort attaches the
    // relay-created swap id. The HTLC legs are driven by the relay's step loop;
    // nothing here fabricates a settlement. Returns the placed order + swap ref.
    async swap(from, to, amount, opts) {
      if (from && typeof from === 'object') {
        const o = from;
        opts = Object.assign({}, (o.slippage != null ? { slippage: o.slippage } : null), to || {});
        from = o.from; to = o.to; amount = o.amount;
      }
      opts = opts || {};
      await this.ensureSignedIn();
      const markets = await this.getMarkets();
      const { market, side } = resolveSwap(markets, from, to);
      const book = await this.getBook(market);
      const levels = side === 'sell' ? (book.bids || []) : (book.asks || []);
      const best = levels[0];
      const order = best
        ? await this.placeOrder({ market, side, type: 'market', price: best.price, amount: String(amount), expiry: opts.expiry })
        : await this.placeOrder({ market, side, type: 'limit', amount: String(amount), expiry: opts.expiry });
      let swap = null;
      try { swap = await this._findSwapForOrder(order.orderId, opts.timeoutMs == null ? 0 : opts.timeoutMs); } catch (_) {}
      return { order, orderId: order.orderId, market, side, swap, swapId: swap && swap.swapId };
    },

    // Poll the relay for the swap it created for `orderId`. One scan when
    // timeoutMs<=0; otherwise polls until the deadline.
    async _findSwapForOrder(orderId, timeoutMs) {
      if (orderId == null) return null;
      const deadline = Date.now() + (timeoutMs || 0);
      for (;;) {
        let swaps = [];
        try { swaps = (await api.mySwaps()) || []; } catch (_) { swaps = []; }
        const match = (swaps || []).find((s) =>
          s && (s.orderId === orderId || (s.legs || []).some((l) => l && l.orderId === orderId)));
        if (match) return match;
        if (Date.now() >= deadline) return null;
        await sleep(1500);
      }
    },

    // ---- sell BLOCK back for USDC (non-custodial, two steps) --------------
    // Mirrors sdk/money.ts + web/buy.js: (1) send BLOCK to the reserve (built,
    // signed and broadcast locally on the BLOCK rail), (2) tell the settlement
    // service the BLOCK txid + the user's Base USDC payout address; the service
    // verifies the inbound BLOCK on-chain and pays USDC. We never custody.
    async sellBlock(blockAmount, opts) {
      opts = opts || {};
      const sb = await siteBase();
      const cfg = await fetchJson(sb + '/api/buy/config');
      const reserve = cfg && (cfg.blockReserveAddr || cfg.reserve || cfg.blockReserveAddress);
      if (!reserve) throw new Error('sell not enabled on this deployment (no blockReserveAddr in /api/buy/config)');
      const userUsdcAddr = opts.userUsdcAddr;
      if (!userUsdcAddr) throw new Error('sellBlock needs a Base USDC payout address (opts.userUsdcAddr)');
      const blockTxid = await blockSend(reserve, String(blockAmount), opts.fee == null ? 1000 : opts.fee);
      await waitForBlockTx(blockTxid, opts.minConfs == null ? 1 : opts.minConfs, opts.timeoutMs);
      const settlement = await postJson(sb + '/api/buy/settle', { blockTxid, userUsdcAddr });
      return { blockTxid, settlement };
    },

    // ---- list a new asset (pays the relay listing fee non-custodially) ----
    // Mirrors sdk ExchangeClient.listAsset: quote -> pay the relay-named payTo
    // with the exact base-unit amount it stated -> register with that txid. We
    // only ever pay the relay-provided payTo; we never route around the fee.
    async listAsset(p) {
      p = p || {};
      const extraPairs = p.extraPairs || [];
      const quote = await api.listingQuote({ asset: p.asset, extraPairs });
      const payWith = String(p.payWith || 'block').toLowerCase();
      if (payWith !== 'block') {
        throw new Error('listing fee payWith="' + payWith + '" is not supported in this wallet build (only BLOCK)');
      }
      const payTo = quote && quote.payTo;
      if (!payTo) throw new Error('listing quote did not name a payTo treasury address');
      const paymentTxid = await blockSend(payTo, listingFeeAmount(quote), p.fee);
      await this.ensureSignedIn();
      return api.createListing({ asset: p.asset, extraPairs, paymentTxid });
    },

    // ---- live stream (WS) --------------------------------------------------
    async stream(markets, onMsg) {
      const url = wsFrom(await base()) + '/stream' + (markets ? '?markets=' + encodeURIComponent(markets) : '');
      let ws = null,
        closed = false,
        retry = 0,
        timer = null;
      function open() {
        try {
          ws = new WebSocket(url);
        } catch {
          schedule();
          return;
        }
        ws.onopen = () => (retry = 0);
        ws.onmessage = (ev) => {
          let m;
          try {
            m = JSON.parse(ev.data);
          } catch {
            return;
          }
          onMsg(m);
        };
        ws.onclose = () => {
          if (!closed) schedule();
        };
        ws.onerror = () => {
          try {
            ws.close();
          } catch {}
        };
      }
      function schedule() {
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(open, 500 * retry);
      }
      open();
      return {
        close() {
          closed = true;
          if (timer) clearTimeout(timer);
          if (ws) try { ws.close(); } catch {}
        },
        setMarkets(ms) {
          try {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ subscribe: ms }));
          } catch {}
        },
      };
    },

    // ---- buy BLOCK over x402 (mirror sdk/money.ts X402Client.buy) ---------
    // POST {usdc, recipient}. If the service answers 200 (free/mock mode) we
    // return the receipt. A 402 means USDC settlement is required: the extension
    // has no EVM/USDC signer yet (it arrives with the multi-chain adapter pass),
    // so we return the challenge for the UI to surface honestly instead of
    // pretending to pay. We NEVER fabricate a payment.
    async buyBlock(usdcBaseUnits, recipient, opts) {
      opts = opts || {};
      const xb = await x402Base();
      const body = { usdc: String(usdcBaseUnits), recipient: recipient || Wallet.address };
      // x402 settlement retry: once the wallet has paid USDC on-chain it re-POSTs
      // with the payment proof so the seller can verify + release the BLOCK.
      if (opts.paymentTxid) body.paymentTxid = opts.paymentTxid;
      if (opts.payment) body.payment = opts.payment;
      const extraHeaders = opts.paymentTxid ? { 'x-payment': String(opts.paymentTxid) } : null;
      const res = await fetch(xb + '/x402/buy', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, extraHeaders || {}),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (res.status === 402) {
        return { paymentRequired: true, challenge: data, headers: headerMap(res) };
      }
      if (res.status >= 400) {
        const e = new Error((data && (data.error || data.message)) || 'HTTP ' + res.status);
        e.status = res.status;
        throw e;
      }
      return { receipt: data };
    },
  };

  function headerMap(res) {
    const h = {};
    res.headers.forEach((v, k) => (h[k] = v));
    return h;
  }

  global.Exchange = Exchange;
  if (typeof module !== 'undefined' && module.exports) module.exports = Exchange;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
