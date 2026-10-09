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

  const Exchange = {
    DEFAULT_BASE,
    canonical,
    toHuman,
    toBase,
    api,
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
    async buyBlock(usdcBaseUnits, recipient) {
      const xb = await x402Base();
      const body = { usdc: String(usdcBaseUnits), recipient: recipient || Wallet.address };
      const res = await fetch(xb + '/x402/buy', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
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
})(typeof self !== 'undefined' ? self : window);
