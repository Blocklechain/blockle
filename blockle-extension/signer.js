// signer.js — loads the Blockle WASM module (post-quantum ML-DSA-44) and
// exposes a small async API. The WASM is built from blockle-core, so keys,
// addresses, signatures and transactions are consensus-correct.
//
// Requires blockle_wasm.js (wasm-pack `--target no-modules`) to be loaded
// first. That file declares a top-level `let wasm_bindgen`, which is a LEXICAL
// global — reachable by bare name but NOT as a property of window — so we must
// reference it directly rather than via `window.wasm_bindgen`.
(function (global) {
  function wb() {
    return typeof wasm_bindgen !== 'undefined' ? wasm_bindgen : undefined;
  }

  function wasmUrl() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL('blockle_wasm_bg.wasm');
    }
    return 'blockle_wasm_bg.wasm';
  }

  let ready = null;
  function init() {
    if (ready) return ready;
    const f = wb();
    if (typeof f !== 'function') {
      ready = Promise.reject(new Error('blockle_wasm.js not loaded'));
      return ready;
    }
    ready = f(wasmUrl());
    return ready;
  }

  const Signer = {
    available() {
      return typeof wb() === 'function';
    },
    async ready() {
      await init();
      return true;
    },
    async keygen() {
      await init();
      return JSON.parse(wb().keygen());
    },
    async addressFromPubkey(pubHex) {
      await init();
      return wb().address_from_pubkey(pubHex);
    },
    async signMessage(secretHex, publicHex, msg) {
      await init();
      return JSON.parse(wb().sign_message(secretHex, publicHex, msg));
    },
    async verify(publicHex, msg, sigHex) {
      await init();
      return wb().verify(publicHex, msg, sigHex);
    },
    // amount/fee are base units (BigInt-safe). utxos = [{txid,vout,amount}].
    async buildTransfer(secretHex, publicHex, utxos, toAddr, amountBase, feeBase) {
      await init();
      return JSON.parse(
        wb().build_transfer(
          secretHex,
          publicHex,
          JSON.stringify(utxos),
          toAddr,
          BigInt(amountBase),
          BigInt(feeBase)
        )
      );
    },
    async buildDeploy(secretHex, publicHex, utxos, codeHex, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_deploy(
          secretHex,
          publicHex,
          JSON.stringify(utxos),
          codeHex,
          BigInt(gasLimit),
          BigInt(gasPrice)
        )
      );
    },
    async buildCall(secretHex, publicHex, utxos, contractHex, inputHex, value, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_call(secretHex, publicHex, JSON.stringify(utxos), contractHex, inputHex, BigInt(value), BigInt(gasLimit), BigInt(gasPrice))
      );
    },
    async buildPoolCreate(secretHex, publicHex, utxos, tokenHex, blockAmt, tokenAmt, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_pool_create(secretHex, publicHex, JSON.stringify(utxos), tokenHex, BigInt(blockAmt), BigInt(tokenAmt), BigInt(gasLimit), BigInt(gasPrice))
      );
    },
    async buildBlock20(name, symbol, decimals, supply) {
      await init();
      return wb().build_block20_token(name, symbol, BigInt(decimals), BigInt(supply));
    },
    async buildPoolSwapBuy(secretHex, publicHex, utxos, tokenHex, blockIn, minTokenOut, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_pool_swap_buy(secretHex, publicHex, JSON.stringify(utxos), tokenHex, BigInt(blockIn), BigInt(minTokenOut), BigInt(gasLimit), BigInt(gasPrice))
      );
    },
    async buildPoolSwapSell(secretHex, publicHex, utxos, tokenHex, tokenIn, minBlockOut, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_pool_swap_sell(secretHex, publicHex, JSON.stringify(utxos), tokenHex, BigInt(tokenIn), BigInt(minBlockOut), BigInt(gasLimit), BigInt(gasPrice))
      );
    },
  };

  global.Signer = Signer;
})(typeof self !== 'undefined' ? self : window);
