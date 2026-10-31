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

  // A BLOCK tx with too many inputs would exceed the 2MB block size (post-quantum signatures are
  // ~13KB each), so it could never be mined. Count the fewest coins (largest-first) needed to
  // cover amount+fee; if that's over the cap, throw a friendly, actionable error instead of
  // building an unminable transaction. The node enforces the same limit on the wire.
  var MAX_TX_INPUTS = 140;
  function assertInputCap(utxos, amountBase, feeBase) {
    try {
      var need = BigInt(amountBase) + BigInt(feeBase);
      var sorted = (utxos || []).slice().sort(function (x, y) {
        var ax = BigInt((x && x.amount) || 0), ay = BigInt((y && y.amount) || 0);
        return ax > ay ? -1 : ax < ay ? 1 : 0;
      });
      var got = 0n, count = 0;
      for (var i = 0; i < sorted.length; i++) { got += BigInt(sorted[i].amount || 0); count++; if (got >= need) break; }
      if (got >= need && count > MAX_TX_INPUTS) {
        throw new Error('TOO_MANY_INPUTS');
      }
    } catch (e) {
      if (e && e.message === 'TOO_MANY_INPUTS') {
        throw new Error('You have too many small BLOCK coins to send this amount in one transaction — it would exceed the network block size. Consolidate your BLOCK first by sending it to yourself in smaller batches (about ' + MAX_TX_INPUTS + ' coins at a time).');
      }
      /* BigInt parse error etc. — let the wasm builder report it */
    }
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
      assertInputCap(utxos, amountBase, feeBase); // friendly error before building an oversized tx
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
    // Transfer a BLOCK-20 token (fn_transfer) — consensus calldata encoded in wasm.
    async buildTokenTransfer(secretHex, publicHex, utxos, contractHex, toAddr, amountBase, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_token_transfer(secretHex, publicHex, JSON.stringify(utxos), contractHex, toAddr, BigInt(amountBase), BigInt(gasLimit), BigInt(gasPrice))
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
    // Atomic deploy + mint + pool — amounts in WHOLE coins (scaled by decimals
    // inside the wasm so the minted supply and pool token leg always match).
    async buildLaunchToken(secretHex, publicHex, utxos, name, symbol, decimals, supply, seedBlock, seedToken, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_launch_token(secretHex, publicHex, JSON.stringify(utxos), name, symbol,
          BigInt(decimals), BigInt(supply), BigInt(seedBlock), BigInt(seedToken), BigInt(gasLimit), BigInt(gasPrice))
      );
    },
    // Atomic deploy + init of a BLOCK-721 collection (codeHex = prebuilt bytecode).
    async buildLaunchNft(secretHex, publicHex, utxos, codeHex, gasLimit, gasPrice) {
      await init();
      return JSON.parse(
        wb().build_launch_nft(secretHex, publicHex, JSON.stringify(utxos), codeHex, BigInt(gasLimit), BigInt(gasPrice))
      );
    },
    contractIdForTxid(txid) {
      return wb().contract_id_for_txid(txid);
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
