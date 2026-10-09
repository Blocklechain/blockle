/* core.js — shared runtime for the Blockle Exchange frontend.
 *
 * NON-CUSTODIAL. This file never sees a private key. It only:
 *   - talks to the relay over the SHARED EXCHANGE API CONTRACT (fetch + WS),
 *   - connects to the user's own wallet extension (MetaMask / Phantom /
 *     Blockle) and asks IT to sign — nonces, order intents, HTLC steps.
 * No secrets are stored client-side. Session auth is a signed-nonce token.
 *
 * Exposes a single global: window.EX
 */
(function () {
  'use strict';

  // ---- config ------------------------------------------------------------
  // apiBase defaults to same-origin (the relay serves these pages). Override
  // via a config.js that sets window.EXCHANGE_CONFIG = {apiBase, wsBase}.
  var CFG = window.EXCHANGE_CONFIG || {};
  var API = (CFG.apiBase != null ? CFG.apiBase : '').replace(/\/$/, '');
  function wsBase() {
    if (CFG.wsBase) return CFG.wsBase.replace(/\/$/, '');
    var base = API || (location.origin);
    return base.replace(/^http/, 'ws');
  }

  // ---- tiny helpers ------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shortAddr(a) {
    a = String(a || '');
    return a.length > 14 ? a.slice(0, 7) + '…' + a.slice(-5) : a;
  }
  function fmtNum(n, d) {
    if (n == null || n === '' || !isFinite(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 8 : d });
  }
  // base units <-> human. Amounts on the wire are ALWAYS base units (strings).
  function toHuman(baseUnits, decimals) {
    try {
      var neg = String(baseUnits).charAt(0) === '-';
      var s = String(baseUnits).replace('-', '');
      var d = Number(decimals) || 0;
      if (d === 0) return (neg ? '-' : '') + s;
      while (s.length <= d) s = '0' + s;
      var whole = s.slice(0, s.length - d), frac = s.slice(s.length - d).replace(/0+$/, '');
      return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
    } catch (e) { return String(baseUnits); }
  }
  function toBase(human, decimals) {
    var d = Number(decimals) || 0;
    var s = String(human).trim();
    if (!s || isNaN(Number(s))) return '0';
    var neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    var parts = s.split('.');
    var whole = parts[0] || '0', frac = (parts[1] || '');
    frac = (frac + '0'.repeat(d)).slice(0, d);
    var combined = (whole + frac).replace(/^0+/, '') || '0';
    return (neg ? '-' : '') + combined;
  }

  // Deterministic JSON for signing — sorted keys, no whitespace. MUST match
  // the SDK's canonical() so relay signature verification is identical.
  function canonical(obj) {
    return JSON.stringify(sortKeys(obj));
  }
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }
  function b64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ---- HTTP client (shared contract) -------------------------------------
  var session = null; // bearer token, if the relay returns one (cookie also ok)
  function headers(extra) {
    var h = { 'content-type': 'application/json' };
    if (session) h['authorization'] = 'Bearer ' + session;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  async function req(method, path, body) {
    var opts = { method: method, headers: headers(), credentials: 'include' };
    if (body != null) opts.body = JSON.stringify(body);
    var res = await fetch(API + path, opts);
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      var err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }
  var api = {
    nonce: function (address, chain) { return req('POST', '/auth/nonce', { address: address, chain: chain }); },
    verify: function (b) { return req('POST', '/auth/verify', b); },
    markets: function () { return req('GET', '/markets'); },
    book: function (m) { return req('GET', '/book/' + encodeURIComponent(m)); },
    trades: function (m) { return req('GET', '/trades/' + encodeURIComponent(m)); },
    placeOrder: function (b) { return req('POST', '/orders', b); },
    cancelOrder: function (id, b) { return req('DELETE', '/orders/' + encodeURIComponent(id), b); },
    myOrders: function () { return req('GET', '/orders/mine'); },
    mySwaps: function () { return req('GET', '/swaps/mine'); },
    swapStep: function (id, b) { return req('POST', '/swaps/' + encodeURIComponent(id) + '/step', b); },
    listingQuote: function (b) { return req('POST', '/listings/quote', b); },
    createListing: function (b) { return req('POST', '/listings', b); },
    listings: function () { return req('GET', '/listings'); }
  };

  // ---- WebSocket stream --------------------------------------------------
  function stream(markets, onMsg) {
    var url = wsBase() + '/stream' + (markets ? '?markets=' + encodeURIComponent(markets) : '');
    var ws = null, closed = false, retry = 0, timer = null;
    function open() {
      try { ws = new WebSocket(url); } catch (e) { schedule(); return; }
      ws.onopen = function () { retry = 0; };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        onMsg(m);
      };
      ws.onclose = function () { if (!closed) schedule(); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
    function schedule() {
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(open, 500 * retry);
    }
    open();
    return {
      close: function () { closed = true; if (timer) clearTimeout(timer); if (ws) try { ws.close(); } catch (e) {} },
      setMarkets: function (ms) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ subscribe: ms })); } catch (e) {} }
    };
  }

  // ---- wallets -----------------------------------------------------------
  // Three providers. Each exposes: connect() -> address, sign(msg) -> signature
  // string, and (best-effort) sendStep(payload) for HTLC on-chain actions.
  // The CHAIN label is what the relay keys auth + legs on.
  var wallets = {
    block: {
      kind: 'block', chain: 'block', label: 'Blockle',
      present: function () { return typeof window.blockle !== 'undefined'; },
      connect: async function () {
        if (!this.present()) throw new Error('Install the Blockle wallet extension');
        var r = await window.blockle.connect();
        var addr = (r && (r.address || r.account)) || (window.blockle.address) ||
          (window.blockle.getAddress && await window.blockle.getAddress());
        return addr;
      },
      sign: async function (msg) {
        var r = await window.blockle.signMessage(msg);
        return typeof r === 'string' ? r : (r && (r.signature || r.sig)) || '';
      }
    },
    evm: {
      kind: 'evm', chain: 'ethereum', label: 'MetaMask',
      present: function () { return typeof window.ethereum !== 'undefined'; },
      connect: async function () {
        if (!this.present()) throw new Error('Install MetaMask (or any EVM wallet)');
        var accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        return accts && accts[0];
      },
      // EVM personal_sign; returns a 0x hex signature the relay verifies.
      sign: async function (msg, address) {
        return await window.ethereum.request({ method: 'personal_sign', params: [msg, address] });
      },
      // HTLC leg: the relay payload carries a ready tx object to send.
      sendStep: async function (payload) {
        if (payload && payload.tx) {
          var h = await window.ethereum.request({ method: 'eth_sendTransaction', params: [payload.tx] });
          return { txHash: h };
        }
        throw new Error('EVM step payload has no tx to send');
      }
    },
    solana: {
      kind: 'solana', chain: 'solana', label: 'Phantom',
      present: function () { return typeof window.solana !== 'undefined' && window.solana.isPhantom; },
      connect: async function () {
        if (typeof window.solana === 'undefined') throw new Error('Install Phantom (or any Solana wallet)');
        var r = await window.solana.connect();
        return (r && r.publicKey && r.publicKey.toString()) || (window.solana.publicKey && window.solana.publicKey.toString());
      },
      // ed25519 detached signature over the nonce bytes; sent base64.
      sign: async function (msg) {
        var enc = new TextEncoder().encode(msg);
        var r = await window.solana.signMessage(enc, 'utf8');
        var sig = r && (r.signature || r);
        return b64(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
      },
      sendStep: async function (payload) {
        // Relay provides a base64-serialized transaction for the leg.
        if (payload && payload.transaction && window.solana.signAndSendTransaction) {
          var r = await window.solana.signAndSendTransaction(payload.transaction);
          return { txHash: (r && r.signature) || r };
        }
        throw new Error('Solana step payload has no transaction to send');
      }
    }
  };
  // chain label -> wallet provider (for driving swap legs)
  function walletForChain(chain) {
    if (chain === 'block') return wallets.block;
    if (chain === 'solana') return wallets.solana;
    return wallets.evm; // ethereum, base, erc20
  }

  // ---- session (connect + sign-in) --------------------------------------
  // The "active" wallet is the identity the user signs orders with. We keep a
  // map of connected wallets and which one is active.
  var connected = {}; // kind -> {address, chain}
  var active = null;  // wallet kind
  var listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach(function (f) { try { f(state()); } catch (e) {} }); }
  function state() {
    return {
      connected: connected,
      active: active,
      activeAddress: active && connected[active] && connected[active].address,
      activeChain: active && connected[active] && connected[active].chain,
      signedIn: !!session || (active && connected[active] && connected[active].signedIn)
    };
  }

  async function connect(kind) {
    var w = wallets[kind];
    if (!w) throw new Error('unknown wallet ' + kind);
    var addr = await w.connect();
    if (!addr) throw new Error('No account returned by ' + w.label);
    connected[kind] = { address: addr, chain: w.chain, signedIn: false };
    active = kind;
    emit();
    return addr;
  }

  // Sign in = sign the relay's nonce with the connected wallet -> session.
  async function signIn(kind) {
    kind = kind || active;
    if (!kind || !connected[kind]) await connect(kind || 'block');
    kind = kind || active;
    var w = wallets[kind], c = connected[kind];
    var res = await api.nonce(c.address, c.chain);
    var nonce = res && (res.nonce || res.message || res);
    var signature = await w.sign(nonce, c.address);
    var verify = await api.verify({ address: c.address, chain: c.chain, signature: signature, nonce: nonce });
    if (verify && (verify.token || verify.session)) session = verify.token || verify.session;
    connected[kind].signedIn = true;
    active = kind;
    emit();
    return true;
  }
  async function ensureSignedIn() {
    var c = active && connected[active];
    if (session || (c && c.signedIn)) return;
    await signIn(active || 'block');
  }

  // Sign an order/cancel intent with the ACTIVE wallet. Returns {signature,
  // address, chain} so the caller can build the POST body per the contract.
  async function signIntent(intentObj) {
    if (!active || !connected[active]) throw new Error('Connect a wallet first');
    var w = wallets[active], c = connected[active];
    var sig = await w.sign(canonical(intentObj), c.address);
    return { signature: sig, address: c.address, chain: c.chain };
  }

  function disconnect() {
    connected = {}; active = null; session = null; emit();
  }

  // ---- render the header wallet bar (shared by all pages) ----------------
  function mountWalletBar(container) {
    var defs = [
      { kind: 'evm', label: 'MetaMask', ic: 'meta' },
      { kind: 'solana', label: 'Phantom', ic: 'phantom' },
      { kind: 'block', label: 'Blockle', ic: 'blockle' }
    ];
    function paint() {
      var s = state();
      container.innerHTML = '';
      defs.forEach(function (d) {
        var c = connected[d.kind];
        var btn = el('button', 'wbtn' + (c ? ' connected' : '') + (active === d.kind ? ' active' : ''));
        btn.innerHTML = '<span class="ic ' + d.ic + '"></span>' +
          '<span class="dot"></span>' +
          (c ? '<span class="waddr">' + esc(shortAddr(c.address)) + '</span>'
             : '<span>' + d.label + '</span>');
        btn.title = c ? (d.label + ' · ' + c.address + (c.signedIn ? ' · signed in' : ' · click to sign in'))
                      : ('Connect ' + d.label);
        btn.onclick = async function () {
          try {
            if (!connected[d.kind]) { await connect(d.kind); }
            else { active = d.kind; emit(); }
            if (!connected[d.kind].signedIn) await signIn(d.kind);
          } catch (e) { EX.toast((e && e.message) || 'Wallet error', 'err'); }
        };
        container.appendChild(btn);
      });
    }
    onChange(paint);
    paint();
  }

  // ---- toast -------------------------------------------------------------
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('__toast');
    if (!t) { t = el('div'); t.id = '__toast'; document.body.appendChild(t); }
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    t.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = 'none'; }, 5000);
  }

  window.EX = {
    cfg: CFG, apiBase: API, api: api, stream: stream, wallets: wallets,
    walletForChain: walletForChain,
    connect: connect, signIn: signIn, ensureSignedIn: ensureSignedIn,
    signIntent: signIntent, disconnect: disconnect, state: state, onChange: onChange,
    mountWalletBar: mountWalletBar,
    // helpers
    $: $, el: el, esc: esc, shortAddr: shortAddr, fmtNum: fmtNum,
    toHuman: toHuman, toBase: toBase, canonical: canonical, toast: toast,
    PROTOCOL_FEE_BPS: 10 // 0.1% protocol fee (display)
  };
})();
