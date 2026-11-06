// accounts.js — the Accounts layer: sits between the vault/Wallet session and
// the chain registry. Resolves the ACTIVE account's root (the wallet's own HD
// seed, or an imported account's seed / per-chain keys / watch address), fans
// it into the adapters, lazily derives + caches one DerivedAccount per enabled
// chain, and exposes balances through the adapters.
//
// BLOCK stays the native identity (its ML-DSA key lives in the Wallet session)
// and is shared by every account in the wallet; the secp256k1 / ed25519 chains
// come from the account root. Keys never leave the device.
//
// Global `Accounts`. Browser layer (depends on Wallet + HD + ChainRegistry).
(function (global) {
  'use strict';

  function createAccounts(opts) {
    opts = opts || {};
    const W = opts.wallet || global.Wallet;
    const registry = opts.registry;
    const C = opts.crypto || global.BLKCrypto;
    const HD = opts.hd || global.HD; // for Cardano Icarus entropy on mnemonic accounts
    let root = null;                  // { id, seed:Uint8Array|null, keys, watch, chains } in-memory only
    const cache = {};                 // chainId -> DerivedAccount

    // Every EVM network shares the 'evm' key family; the rest are their own.
    const evmIds = new Set();
    try { for (const n of registry.networks()) if (n.evm) evmIds.add(n.id); } catch (_) {}
    function familyOf(chainId) { return evmIds.has(chainId) ? 'evm' : chainId; }

    // The account root comes from the Wallet session: the wallet's BLOCK-bound
    // HD seed for the main account, or an imported account's own material.
    async function ensureRoot() {
      if (root) return root;
      if (!W.isUnlocked()) throw new Error('locked');
      const r = (W.activeRoot && W.activeRoot()) || { id: 'main', seedHex: W.seedHex };
      root = {
        id: r.id || 'main',
        seed: r.seedHex ? C.hexToBytes(r.seedHex) : null,
        keys: r.keys || null,
        watch: r.watch || null,
        chains: r.chains || null, // null = every enabled chain
      };
      // Cardano (Icarus CIP-3) needs the BIP39 ENTROPY, not the 64-byte seed.
      // An imported-mnemonic account has a real mnemonic -> canonical,
      // interoperable CIP-3 entropy; the main (BLOCK-derived) account has no
      // mnemonic, so the Cardano adapter falls back to using the 32-byte seed
      // as the Icarus entropy input (self-consistent, non-Daedalus/Yoroi).
      try {
        if (r.mnemonic && HD && HD.mnemonicToEntropy) root.entropy = HD.mnemonicToEntropy(r.mnemonic);
      } catch (_) {}
      registry.unlock(root);
      return root;
    }

    function chainAvailable(id, r) {
      if (id === 'block') return true;
      if (r.chains && r.chains.length) {
        const fam = familyOf(id);
        if (!r.chains.includes(fam) && !r.chains.includes(id)) return false;
      }
      const fam = familyOf(id);
      if (r.keys && r.keys[fam]) return true;
      if (r.watch && r.watch[fam]) return true;
      return !!r.seed;
    }

    return {
      isUnlocked() { return W.isUnlocked(); },

      async unlock(password) {
        if (!W.isUnlocked()) await W.unlock(password);
        await ensureRoot();
      },

      async lock() {
        root = null;
        for (const k of Object.keys(cache)) delete cache[k];
        registry.lock();
        await W.lock();
      },

      // kill switch: wipe everything decrypted, immediately.
      async kill() { return this.lock(); },

      get blockAddress() { return W.address; },
      get activeAccountId() { return (root && root.id) || (W.activeAccountId || 'main'); },

      // Switch the active account (main / an import). Drops the derived cache
      // and re-arms the adapters with the new root.
      async switchAccount(id) {
        if (W.setActiveAccount) await W.setActiveAccount(id);
        root = null;
        for (const k of Object.keys(cache)) delete cache[k];
        registry.lock();
        if (W.isUnlocked()) await ensureRoot();
      },

      // The chains the ACTIVE account can serve (BLOCK always; others only when
      // the account has a seed, a key or a watch address for them).
      async chains() {
        const r = await ensureRoot();
        return registry.enabled().filter((id) => chainAvailable(id, r));
      },

      async accountFor(chainId) {
        if (chainId === 'block') {
          return registry.get('block').deriveAccount();
        }
        if (cache[chainId]) return cache[chainId];
        const r = await ensureRoot();
        if (!chainAvailable(chainId, r)) throw new Error('this account has no ' + chainId + ' key');
        const acct = await registry.get(chainId).deriveAccount(r);
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
