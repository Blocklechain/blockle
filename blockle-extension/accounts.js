// accounts.js — the Accounts layer: sits between the vault/Wallet session and
// the chain registry. Holds the unlocked HD root (derived from the vault's BIP39
// mnemonic) in memory only, lazily derives + caches one DerivedAccount per
// enabled chain, and exposes balances through the adapters.
//
// BLOCK stays the native identity (its ML-DSA key lives in the Wallet session);
// the secp256k1 chains derive from the HD seed. Keys never leave the device.
//
// Global `Accounts`. Browser layer (depends on Wallet + HD + ChainRegistry).
(function (global) {
  'use strict';

  function createAccounts(opts) {
    opts = opts || {};
    const W = opts.wallet || global.Wallet;
    const HD = opts.hd || global.HD;
    const registry = opts.registry;
    const C = opts.crypto || global.BLKCrypto;
    let rootSeed = null;              // Uint8Array, in-memory only
    const cache = {};                 // chainId -> DerivedAccount

    // The HD root comes from the vault's secp256k1 seed (`Wallet.seedHex`, a
    // raw 32-byte value stored alongside the BLOCK ML-DSA key). BLOCK is NOT
    // derived from it. A BIP39 mnemonic seed (HD.mnemonicToSeed) is equally
    // accepted if a future wallet stores one instead.
    async function ensureSeed() {
      if (rootSeed) return rootSeed;
      if (!W.isUnlocked()) throw new Error('locked');
      const seedHex = W.seedHex;
      if (!seedHex) throw new Error('wallet has no HD seed');
      rootSeed = C.hexToBytes(seedHex);
      registry.unlock({ seed: rootSeed });
      return rootSeed;
    }

    return {
      isUnlocked() { return W.isUnlocked(); },

      async unlock(password) {
        if (!W.isUnlocked()) await W.unlock(password);
        await ensureSeed();
      },

      async lock() {
        rootSeed = null;
        for (const k of Object.keys(cache)) delete cache[k];
        registry.lock();
        await W.lock();
      },

      // kill switch: wipe everything decrypted, immediately.
      async kill() { return this.lock(); },

      get blockAddress() { return W.address; },

      async accountFor(chainId) {
        if (chainId === 'block') {
          return registry.get('block').deriveAccount();
        }
        if (cache[chainId]) return cache[chainId];
        await ensureSeed();
        const acct = await registry.get(chainId).deriveAccount({ seed: rootSeed });
        cache[chainId] = acct;
        return acct;
      },

      async addresses() {
        const out = {};
        for (const id of registry.enabled()) {
          try { out[id] = (await this.accountFor(id)).address; } catch { out[id] = null; }
        }
        return out;
      },

      async balances(chainId) {
        const acct = await this.accountFor(chainId);
        const adapter = registry.get(chainId);
        const tokens = registry.tokensFor ? registry.tokensFor(chainId) : [];
        return adapter.getBalance(acct.address, tokens);
      },

      registry,
    };
  }

  global.Accounts = { createAccounts };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Accounts;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
