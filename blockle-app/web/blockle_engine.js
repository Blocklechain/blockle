// blockle_engine.js — the Blockle crypto core for Flutter WEB. Same WASM
// signer (ML-DSA-44) + password vault (PBKDF2-SHA256 -> AES-256-GCM) as the
// extension and desktop wallet, so keys/addresses/signatures/tx-bytes/vault
// files are byte-identical. Ported from assets/engine/engine.html; the only
// change is it runs directly in the page (not inside a WebView), so the wasm
// is served from the web root. `blockle_wasm.js` must load first (it declares
// the lexical global `wasm_bindgen`). Dart (engine_web.dart) calls window.Engine.*.
(function (global) {
  'use strict';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const KDF_ITERS = 310000;

  function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
  function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: KDF_ITERS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // --- WASM signer init (no-modules: `wasm_bindgen` is a lexical global) ------
  let ready = null;
  function initWasm() {
    if (ready) return ready;
    if (typeof wasm_bindgen !== 'function') {
      ready = Promise.reject(new Error('blockle_wasm.js not loaded'));
      return ready;
    }
    ready = wasm_bindgen('blockle_wasm_bg.wasm');
    return ready;
  }

  const Engine = {
    async ready() { await initWasm(); return true; },

    async keygen() { await initWasm(); return wasm_bindgen.keygen(); },

    async addressFromPubkey(pubHex) { await initWasm(); return wasm_bindgen.address_from_pubkey(pubHex); },

    async signMessage(secretHex, publicHex, msg) {
      await initWasm();
      return wasm_bindgen.sign_message(secretHex, publicHex, msg);
    },

    async verify(publicHex, msg, sigHex) {
      await initWasm();
      return wasm_bindgen.verify(publicHex, msg, sigHex);
    },

    // utxosJson = [{txid,vout,amount}]; amounts are decimal strings (base units).
    async buildTransfer(secretHex, publicHex, utxosJson, toAddr, amountBase, feeBase) {
      await initWasm();
      return wasm_bindgen.build_transfer(
        secretHex, publicHex, utxosJson, toAddr, BigInt(amountBase), BigInt(feeBase));
    },

    async buildDeploy(secretHex, publicHex, utxosJson, codeHex, gasLimit, gasPrice) {
      await initWasm();
      return wasm_bindgen.build_deploy(
        secretHex, publicHex, utxosJson, codeHex, BigInt(gasLimit), BigInt(gasPrice));
    },

    async buildPoolSwapBuy(secretHex, publicHex, utxosJson, tokenHex, blockIn, minOut, gasLimit, gasPrice) {
      await initWasm();
      return wasm_bindgen.build_pool_swap_buy(
        secretHex, publicHex, utxosJson, tokenHex, BigInt(blockIn), BigInt(minOut), BigInt(gasLimit), BigInt(gasPrice));
    },

    async buildPoolSwapSell(secretHex, publicHex, utxosJson, tokenHex, tokenIn, minOut, gasLimit, gasPrice) {
      await initWasm();
      return wasm_bindgen.build_pool_swap_sell(
        secretHex, publicHex, utxosJson, tokenHex, BigInt(tokenIn), BigInt(minOut), BigInt(gasLimit), BigInt(gasPrice));
    },

    // Password vault — identical format to the extension: {v,salt,iv,data} b64.
    async seal(objJson, password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(objJson));
      return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) });
    },

    async open(sealedJson, password) {
      const sealed = JSON.parse(sealedJson);
      const key = await deriveKey(password, unb64(sealed.salt));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.data));
      return dec.decode(pt);
    },
  };

  global.Engine = Engine;
  global.__engineLoaded = true;
})(window);
