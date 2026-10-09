// chains/block.js — the BLOCK ChainAdapter. This is a THIN wrapper over the
// existing, consensus-correct BLOCK stack (`Signer` = blockle-wasm ML-DSA-44,
// `Wallet` = key session, `Chain` = explorer/submit). It does NOT reimplement
// any BLOCK crypto — ML-DSA signing stays entirely in blockle-wasm.
//
// BLOCK is the wallet's native identity and is ALWAYS enabled. This adapter
// exists so the UI / exchange / agent can talk to every chain through one
// uniform ChainAdapter interface.
//
// Post-quantum: YES — BLOCK alone is signed with ML-DSA-44 (FIPS 204).
//
// Global `BlockAdapter` (factory). Browser-only (depends on wasm globals); the
// unit tests exercise the secp256k1 adapters, not this wrapper.
(function (global) {
  'use strict';
  const COIN = 100000000;

  function createBlockAdapter(opts) {
    opts = opts || {};
    const id = 'block';
    const native = { chain: id, kind: 'native', symbol: 'BLOCK', decimals: 8 };
    const W = opts.wallet || global.Wallet;
    const Chain = opts.chain || global.Chain;
    const explorer = opts.explorer || 'https://blockle.org/tx/';

    return {
      id, native, postQuantum: true, scheme: 'ml-dsa-44',

      // No-ops for interface symmetry: the BLOCK key lives in the Wallet session.
      unlock() {},
      lock() {},

      async deriveAccount() {
        // BLOCK identity is the ML-DSA keypair in the Wallet session — not HD.
        return {
          chain: id, index: 0,
          address: W.address,
          publicKey: W.publicKeyHex,
          scheme: 'ml-dsa-44',
        };
      },

      async getBalance(address) {
        try {
          const a = await Chain.account(address || W.address);
          const confirmed = a ? String(a.balance) : '0';
          return [{ asset: native, confirmed, spendable: confirmed, display: a ? a.balanceFmt : '—' }];
        } catch (e) {
          return [{ asset: native, confirmed: '0', display: '—', error: String(e.message || e) }];
        }
      },

      // req: {to, amount(base), feeRate?(fee base)}
      async buildSend(account, req) {
        if (!W.isUnlocked()) throw new Error('locked');
        const u = await Chain.utxos(W.address);
        const utxos = (u && u.utxos) || [];
        const fee = BigInt(req.feeRate || 100000);
        const built = await W.buildTransfer(utxos, req.to, BigInt(req.amount), fee);
        // Signer.buildTransfer returns { raw, txid } (bincode hex)
        return { chain: id, raw: built.raw, txid: built.txid, fee: fee.toString(), summary: req };
      },

      async broadcast(tx) {
        const res = await Chain.submit(tx.raw);
        const txid = (res && (res.txid || res.result || res)) || tx.txid;
        return { txid: String(txid), accepted: true };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  global.BlockAdapter = { createBlockAdapter, COIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.BlockAdapter;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
