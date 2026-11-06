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

  window.dispatchEvent(new Event('blockle#initialized'));
  window.dispatchEvent(new Event('ethereum#initialized'));
})();
