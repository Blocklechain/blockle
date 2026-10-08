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

  // Called by the Flutter host to push events into the page.
  window.__blockleEmit = function (event, data) {
    if (event === 'accountsChanged') provider.selectedAddress = (data && data[0]) || null;
    if (event === 'disconnect') provider.selectedAddress = null;
    (listeners[event] || []).forEach((cb) => { try { cb(data); } catch (_) {} });
  };

  Object.defineProperty(window, 'blockle', { value: provider, writable: false });
  window.dispatchEvent(new Event('blockle#initialized'));
})();
