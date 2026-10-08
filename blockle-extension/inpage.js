// inpage.js — the provider injected into every page as `window.blockle`.
// EIP-1193-style: request()/connect()/on(). Talks to the content script over
// window.postMessage; the content script relays to the extension background.
(function () {
  if (window.blockle) return;

  const listeners = {};
  const pending = new Map();
  let reqId = 0;

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      window.postMessage({ source: 'blockle-inpage', id, method, params: params || [] }, '*');
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'blockle-content') return;
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) {
        const err = new Error(d.error.message || 'Blockle error');
        err.code = d.error.code;
        reject(err);
      } else resolve(d.result);
    } else if (d.event) {
      if (d.event === 'accountsChanged') provider.selectedAddress = (d.data && d.data[0]) || null;
      if (d.event === 'disconnect') provider.selectedAddress = null;
      (listeners[d.event] || []).forEach((cb) => {
        try {
          cb(d.data);
        } catch (_) {}
      });
    }
  });

  const provider = {
    isBlockle: true,
    chain: 'BLOCK',
    chainId: 'blockle-main',
    selectedAddress: null,

    request({ method, params } = {}) {
      return rpc(method, params);
    },
    connect() {
      return rpc('blockle_connect').then((a) => {
        provider.selectedAddress = (a && a[0]) || null;
        return a;
      });
    },
    disconnect() {
      return rpc('blockle_disconnect');
    },
    getAccounts() {
      return rpc('blockle_accounts');
    },
    getBalance() {
      return rpc('blockle_getBalance');
    },
    getHeight() {
      return rpc('blockle_getHeight');
    },
    chainInfo() {
      return rpc('blockle_chainInfo');
    },
    signMessage(message) {
      return rpc('blockle_signMessage', [message]);
    },
    deployContract(codeHex, gasLimit) {
      return rpc('blockle_deployContract', [codeHex, gasLimit]);
    },
    // Mint a freshly-deployed BLOCK-20's supply to the caller (once).
    tokenInit(contractId, gasLimit) {
      return rpc('blockle_tokenInit', [contractId, gasLimit]);
    },
    // Create a native AMM pool: seed `blockAmt` (base units) BLOCK + `tokenAmt` of the token.
    createPool(token, blockAmt, tokenAmt, gasLimit) {
      return rpc('blockle_createPool', [token, blockAmt, tokenAmt, gasLimit]);
    },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return provider;
    },
    removeListener(event, cb) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
      return provider;
    },
  };

  Object.defineProperty(window, 'blockle', { value: provider, writable: false });
  window.dispatchEvent(new Event('blockle#initialized'));
})();
