// inpage.js — the `window.blockle` provider injected into every page the
// in-app browser loads. Mirrors the extension provider's API (EIP-1193-style
// request()/connect()/on()), but talks to the Flutter host over
// flutter_inappwebview.callHandler instead of postMessage.
(function () {
  if (window.blockle) return;

  const listeners = {};

  function call(method, params) {
    // The host handler returns {result} or {error:{code,message}}.
    return window.flutter_inappwebview
      .callHandler('blockleRpc', { method: method, params: params || [] })
      .then((resp) => {
        if (resp && resp.error) {
          const err = new Error(resp.error.message || 'Blockle error');
          err.code = resp.error.code;
          throw err;
        }
        return resp ? resp.result : null;
      });
  }

  const provider = {
    isBlockle: true,
    chain: 'BLOCK',
    chainId: 'blockle-main',
    selectedAddress: null,

    request({ method, params } = {}) { return call(method, params); },
    connect() {
      return call('blockle_connect').then((a) => {
        provider.selectedAddress = (a && a[0]) || null;
        return a;
      });
    },
    disconnect() {
      return call('blockle_disconnect').then((r) => { provider.selectedAddress = null; return r; });
    },
    getAccounts() { return call('blockle_accounts'); },
    getBalance() { return call('blockle_getBalance'); },
    getHeight() { return call('blockle_getHeight'); },
    chainInfo() { return call('blockle_chainInfo'); },
    signMessage(message) { return call('blockle_signMessage', [message]); },
    deployContract(codeHex, gasLimit) { return call('blockle_deployContract', [codeHex, gasLimit]); },
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); return provider; },
    removeListener(event, cb) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
      return provider;
    },
  };

  // ---- EIP-1193 window.ethereum so EVM dApps (Uniswap, etc.) DETECT + CONNECT ----
  // EVM method names (eth_*, personal_sign, wallet_*, net_version) are passed
  // through to the Flutter host, which signs via the wallet's EVM key after an
  // explicit approval. Connect is a single prompt — the handshake is automatic.
  const ethListeners = {};
  const ethereum = {
    isMetaMask: true, // many dApps gate their "injected wallet" UI on this
    isBlockle: true,
    _chainId: '0x1',
    get chainId() { return this._chainId; },
    get networkVersion() { return String(parseInt(this._chainId, 16)); },
    selectedAddress: null,
    isConnected() { return true; },
    request({ method, params } = {}) {
      return call(method, params).then((r) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          ethereum.selectedAddress = (r && r[0]) || null;
        }
        if (method === 'wallet_switchEthereumChain' && params && params[0] && params[0].chainId) {
          ethereum._chainId = params[0].chainId;
        }
        return r;
      });
    },
    enable() { return this.request({ method: 'eth_requestAccounts' }); },
    send(m, p) {
      return typeof m === 'string' ? this.request({ method: m, params: p }) : this.request(m);
    },
    sendAsync(payload, cb) {
      this.request(payload).then(
        (result) => cb(null, { id: payload && payload.id, jsonrpc: '2.0', result }),
        (error) => cb(error));
    },
    on(event, cb) { (ethListeners[event] = ethListeners[event] || []).push(cb); return ethereum; },
    removeListener(event, cb) {
      ethListeners[event] = (ethListeners[event] || []).filter((f) => f !== cb);
      return ethereum;
    },
  };

  // Single host→page event bridge: updates BOTH the blockle and ethereum providers.
  window.__blockleEmit = function (event, data) {
    if (event === 'accountsChanged') {
      provider.selectedAddress = (data && data[0]) || null;
      ethereum.selectedAddress = (data && data[0]) || null;
    }
    if (event === 'chainChanged') ethereum._chainId = data;
    if (event === 'disconnect') { provider.selectedAddress = null; ethereum.selectedAddress = null; }
    (listeners[event] || []).forEach((cb) => { try { cb(data); } catch (_) {} });
    (ethListeners[event] || []).forEach((cb) => { try { cb(data); } catch (_) {} });
  };

  Object.defineProperty(window, 'blockle', { value: provider, writable: false });
  try {
    if (!window.ethereum) {
      Object.defineProperty(window, 'ethereum', { value: ethereum, configurable: true });
    }
  } catch (_) { try { window.ethereum = ethereum; } catch (_) {} }

  // EIP-6963 multi-wallet discovery — how modern dApps (incl. Uniswap) enumerate
  // injected wallets. Without this, Uniswap never shows "Blockle" to connect.
  const info = {
    uuid: '7b1f2c9a-6b3d-4e8a-9c21-b10c51e00001',
    name: 'Blockle',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNiIgZmlsbD0iIzdDNUNGRiIvPjx0ZXh0IHg9IjEyIiB5PSIxNyIgZm9udC1zaXplPSIxNCIgZmlsbD0iI2ZmZiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXdlaWdodD0iYm9sZCI+QjwvdGV4dD48L3N2Zz4=',
    rdns: 'org.blockle.wallet',
  };
  function announce() {
    try {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info: info, provider: ethereum }),
      }));
    } catch (_) {}
  }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // ======================================================================
  // SOLANA — window.solana (Phantom-compatible) + Wallet Standard registration
  // so Solana dApps (Jupiter, Raydium, …) DETECT + CONNECT "Blockle". Modern
  // dApps use the Wallet Standard; legacy ones read window.solana. We serve both.
  // All signing routes to the Flutter host over blockleRpc after an explicit
  // approval; bytes cross the JSON bridge base64-encoded.
  // ======================================================================
  const ICON =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNiIgZmlsbD0iIzdDNUNGRiIvPjx0ZXh0IHg9IjEyIiB5PSIxNyIgZm9udC1zaXplPSIxNCIgZmlsbD0iI2ZmZiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXdlaWdodD0iYm9sZCI+QjwvdGV4dD48L3N2Zz4=';

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(u) {
    let s = '';
    const a = u instanceof Uint8Array ? u : new Uint8Array(u);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  // Minimal base58 (for the legacy window.solana publicKey.toString()).
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58encode(bytes) {
    let digits = [0];
    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let s = '';
    for (let k = 0; k < bytes.length && bytes[k] === 0; k++) s += '1';
    for (let q = digits.length - 1; q >= 0; q--) s += B58[digits[q]];
    return s;
  }

  const solState = { pubkeyBytes: null, address: null, connected: false };
  const solListeners = {};
  function solEmit(ev, data) { (solListeners[ev] || []).forEach((cb) => { try { cb(data); } catch (_) {} }); }

  async function solConnect() {
    const r = await call('sol_connect', []); // { address, publicKey(base64) }
    solState.address = r && r.address;
    solState.pubkeyBytes = r && r.publicKey ? b64ToBytes(r.publicKey) : null;
    solState.connected = !!solState.address;
    return solState;
  }

  // ---- legacy window.solana (Phantom-shaped) ----
  const PublicKeyLike = (bytes) => ({
    toBytes: () => bytes,
    toBuffer: () => bytes,
    toString: () => b58encode(bytes),
    toBase58: () => b58encode(bytes),
    equals: (o) => o && o.toString() === b58encode(bytes),
  });
  const solana = {
    isPhantom: true, // many dApps gate their Solana UI on this
    isBlockle: true,
    get publicKey() { return solState.pubkeyBytes ? PublicKeyLike(solState.pubkeyBytes) : null; },
    get isConnected() { return solState.connected; },
    async connect() { await solConnect(); solEmit('connect', solana.publicKey); return { publicKey: solana.publicKey }; },
    async disconnect() { await call('sol_disconnect', []).catch(() => {}); solState.connected = false; solState.pubkeyBytes = null; solEmit('disconnect'); },
    async signMessage(message, _enc) {
      const bytes = message instanceof Uint8Array ? message : new TextEncoder().encode(String(message));
      const r = await call('sol_signMessage', [bytesToB64(bytes)]);
      return { signature: b64ToBytes(r.signature), publicKey: solana.publicKey };
    },
    async signTransaction(tx) {
      const ser = tx.serialize ? tx.serialize({ requireAllSignatures: false, verifySignatures: false }) : tx;
      const r = await call('sol_signTransaction', [bytesToB64(ser)]);
      return b64ToBytes(r.signedTransaction);
    },
    async signAndSendTransaction(tx, _opts) {
      const ser = tx.serialize ? tx.serialize({ requireAllSignatures: false, verifySignatures: false }) : tx;
      const r = await call('sol_signAndSendTransaction', [bytesToB64(ser)]);
      return { signature: r.signature };
    },
    on(ev, cb) { (solListeners[ev] = solListeners[ev] || []).push(cb); return solana; },
    off(ev, cb) { solListeners[ev] = (solListeners[ev] || []).filter((f) => f !== cb); return solana; },
    removeListener(ev, cb) { return solana.off(ev, cb); },
    request: async ({ method, params }) => call(method, params),
  };
  try { Object.defineProperty(window, 'solana', { value: solana, configurable: true }); } catch (_) { try { window.solana = solana; } catch (_) {} }
  try { window.solflare = solana; } catch (_) {} // some dApps probe known names

  // ---- Wallet Standard (what Jupiter/Raydium actually enumerate) ----
  const SOL_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
  function makeAccount() {
    return {
      address: solState.address,
      publicKey: solState.pubkeyBytes,
      chains: SOL_CHAINS,
      features: ['solana:signTransaction', 'solana:signMessage', 'solana:signAndSendTransaction'],
      label: 'Blockle',
      icon: ICON,
    };
  }
  const wsListeners = {};
  const wallet = {
    version: '1.0.0',
    name: 'Blockle',
    icon: ICON,
    chains: SOL_CHAINS,
    get accounts() { return solState.connected ? [makeAccount()] : []; },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => { await solConnect(); wsEmit('change', { accounts: wallet.accounts }); return { accounts: wallet.accounts }; },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => { await solana.disconnect(); wsEmit('change', { accounts: wallet.accounts }); },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => { (wsListeners[event] = wsListeners[event] || []).push(listener); return () => { wsListeners[event] = (wsListeners[event] || []).filter((f) => f !== listener); }; },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs) => Promise.all(inputs.map(async (inp) => {
          const r = await call('sol_signAndSendTransaction', [bytesToB64(inp.transaction)]);
          return { signature: b58decodeToBytes(r.signature) };
        })),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => Promise.all(inputs.map(async (inp) => {
          const r = await call('sol_signTransaction', [bytesToB64(inp.transaction)]);
          return { signedTransaction: b64ToBytes(r.signedTransaction) };
        })),
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) => Promise.all(inputs.map(async (inp) => {
          const r = await call('sol_signMessage', [bytesToB64(inp.message)]);
          return { signedMessage: inp.message, signature: b64ToBytes(r.signature) };
        })),
      },
    },
  };
  function wsEmit(ev, data) { (wsListeners[ev] || []).forEach((cb) => { try { cb(data); } catch (_) {} }); }
  function b58decodeToBytes(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
      const val = B58.indexOf(str[i]); if (val < 0) continue;
      let carry = val;
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  // Register with the Wallet Standard: dispatch our register event AND answer the
  // app-ready event (covers dApps that loaded before OR after this script).
  function registerWallet() {
    const callbackFn = ({ register }) => register(wallet);
    try {
      const ev = new Event('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false });
      Object.defineProperty(ev, 'detail', { value: callbackFn });
      window.dispatchEvent(ev);
    } catch (_) {}
    try {
      window.addEventListener('wallet-standard:app-ready', (e) => { try { (e.detail).register(wallet); } catch (_) {} });
    } catch (_) {}
  }
  registerWallet();

  window.dispatchEvent(new Event('blockle#initialized'));
  window.dispatchEvent(new Event('ethereum#initialized'));
})();
