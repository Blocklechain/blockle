// wallet.js — multi-wallet key management, backed by the post-quantum WASM
// signer (ML-DSA-44). Each wallet's secret lives only in its password-sealed
// vault; the active wallet's key is held in an ephemeral session with auto-lock.
//
// Storage: `wallets` = [rec, …]  (rec: {id,label,address,publicKey,crypto,
// watchOnly,scheme}), `selectedId` = active wallet id.  Session: the decrypted
// secret for the active wallet.
//
// Exposed as global `Wallet`.
(function (global) {
  const AUTO_LOCK_MS = 30 * 60 * 1000;
  let session = { id: null, address: null, pub: null, secret: null, seed: null, legacySeed: null, accounts: null, activeAccount: 'main', at: 0 };
  // Imported accounts live INSIDE the wallet's sealed vault as
  //   pt.accounts = [{ id, seedHex?, keys?, watch?, chains }]
  // (secret material) while the record carries their public metadata as
  //   rec.accounts = [{ id, label, source, family, chains, addresses, createdAt }].
  // 'main' is the wallet's own account (BLOCK identity + BLOCK-bound HD seed).
  function activeKey(recId) { return 'activeAccount.' + recId; }
  function metaOf(spec, label) {
    const fam = spec.family === 'all' ? 'Multi-chain' : ({ evm: 'EVM', bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', solana: 'SOL', block: 'BLOCK' }[spec.family] || String(spec.family || '').toUpperCase());
    const how = { key: 'key', mnemonic: 'seed', keystore: 'keystore', walletdat: 'wallet.dat', watch: 'watch' }[spec.source] || 'import';
    return {
      label: (label && String(label).trim()) || (fam + ' · ' + how),
      source: spec.source || 'key', family: spec.family || 'evm', chains: (spec.chains || []).slice(),
      addresses: Object.assign({}, spec.addresses || {}), createdAt: Date.now(),
    };
  }

  const rid = () => 'w' + Math.random().toString(36).slice(2, 10);

  // 256-bit HD root for every secp256k1 chain (EVM / BTC / LTC / DOGE). It is
  // generated once per wallet, stored INSIDE the password-sealed vault next to
  // the BLOCK ML-DSA keypair, and never leaves the device. BLOCK is NOT derived
  // from this seed — it is its own ML-DSA-44 keypair.
  function newSeedHex() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // Deterministic HD seed BOUND to this wallet's BLOCK identity: a domain-separated SHA-256 of
  // the BLOCK ML-DSA secret key. So every secp256k1 chain address (EVM / Base / BTC / LTC / DOGE)
  // persists across sessions AND is reproducible from the BLOCK key alone — a seedless import of
  // the BLOCK key regenerates the SAME multichain addresses, attached to the base Blockle address.
  function seedFromBlock(secretHex) {
    const C = (typeof BLKCrypto !== 'undefined' && BLKCrypto) || (typeof window !== 'undefined' && window.BLKCrypto);
    if (!C || !C.sha256 || !C.hexToBytes || !C.bytesToHex || !secretHex) return newSeedHex();
    // "blockle-hd-v1" (hex) || BLOCK secret → 32-byte seed.
    return C.bytesToHex(C.sha256(C.hexToBytes('626c6f636b6c652d68642d7631' + secretHex)));
  }

  async function allWallets() {
    return (await Store.get('wallets')).wallets || [];
  }
  async function saveWallets(list) {
    await Store.set({ wallets: list });
  }
  async function selectedRec() {
    const list = await allWallets();
    const sel = (await Store.get('selectedId')).selectedId;
    return list.find((w) => w.id === sel) || list[0] || null;
  }
  async function saveSession() {
    await Session.set('session', {
      id: session.id,
      address: session.address,
      pub: session.pub,
      secret: session.secret,
      seed: session.seed,
      legacySeed: session.legacySeed,
      accounts: session.accounts,
      activeAccount: session.activeAccount,
      at: session.at,
    });
  }

  const Wallet = {
    get address() {
      return session.address;
    },
    get publicKeyHex() {
      return session.pub;
    },
    // secp256k1 HD root (hex) for EVM/BTC/LTC/DOGE derivation; null when locked.
    get seedHex() {
      return session.seed;
    },
    // The prior random HD seed (pre BLOCK-migration), for the legacy-funds sweep. Null if none.
    get legacySeedHex() {
      return session.legacySeed || null;
    },
    get activeId() {
      return session.id;
    },
    // --- accounts inside this wallet ---------------------------------------
    get activeAccountId() { return session.activeAccount || 'main'; },
    // The active account's root for the Accounts layer (in-memory only):
    //   { id, seedHex, keys, watch, chains }  — chains null = every chain.
    activeRoot() {
      if (!session.secret) return null;
      const id = session.activeAccount || 'main';
      const acc = id !== 'main' && (session.accounts || []).find((a) => a.id === id);
      if (!acc) return { id: 'main', seedHex: session.seed, keys: null, watch: null, chains: null, mnemonic: null, passphrase: '' };
      return { id: acc.id, seedHex: acc.seedHex || null, keys: acc.keys || null, watch: acc.watch || null, chains: acc.chains || null, mnemonic: acc.mnemonic || null, passphrase: acc.passphrase || '' };
    },
    // Re-check the wallet password against the sealed vault WITHOUT changing the
    // session — the gate for revealing key material. Resolves true/false.
    async verifyPassword(password) {
      const rec = await selectedRec();
      if (!rec || !rec.crypto) throw new Error('no wallet');
      try { await Vault.open(rec.crypto, password); return true; } catch (_) { return false; }
    },
    // The BLOCK (ML-DSA-44) key of the unlocked wallet, behind the password
    // re-check. Read-only: never logged, never persisted, never sent anywhere.
    async exportBlockKey(password) {
      if (!session.secret) throw new Error('locked');
      if (!(await this.verifyPassword(password))) throw new Error('wrong password');
      return { chain: 'block', family: 'block', format: 'ml-dsa', scheme: 'ml-dsa-44', label: 'ML-DSA-44 secret key (hex)', address: session.address, publicKey: session.pub, secret: session.secret, imported: false, keys: [{ address: session.address, type: 'block', secret: session.secret, path: null }] };
    },
    // Public list for the switcher: main first, then every import.
    async listAccounts() {
      const rec = await selectedRec();
      const active = session.activeAccount || 'main';
      const out = [{ id: 'main', label: 'Main', source: 'hd', family: 'all', chains: null, addresses: { block: rec ? rec.address : session.address }, active: active === 'main' }];
      for (const m of ((rec && rec.accounts) || [])) out.push(Object.assign({}, m, { active: m.id === active }));
      return out;
    },
    async setActiveAccount(id) {
      const rec = await selectedRec();
      if (!rec) throw new Error('no wallet');
      const ok = id === 'main' || (rec.accounts || []).some((a) => a.id === id);
      if (!ok) throw new Error('no such account');
      await Store.set({ [activeKey(rec.id)]: id });
      session.activeAccount = id;
      if (session.secret) await saveSession();
      return id;
    },
    // Add an imported account (spec from KeyImport: {source, family, chains,
    // seedHex?, keys?, watch?, addresses}) to THIS wallet's vault. Needs the
    // wallet password to re-seal; selects the new account.
    async addAccount(spec, password, label) {
      const rec = await selectedRec();
      if (!rec || !rec.crypto) throw new Error('no wallet');
      if (!spec || (!spec.seedHex && !spec.keys && !spec.watch)) throw new Error('nothing to import');
      const pt = await Vault.open(rec.crypto, password);
      const acc = { id: rid(), seedHex: spec.seedHex || null, keys: spec.keys || null, watch: spec.watch || null, chains: (spec.chains || []).slice(), mnemonic: spec.mnemonic || null, passphrase: spec.passphrase || '' };
      pt.accounts = (pt.accounts || []).concat([acc]);
      rec.crypto = await Vault.seal(pt, password);
      const meta = Object.assign({ id: acc.id }, metaOf(spec, label));
      rec.accounts = (rec.accounts || []).concat([meta]);
      const list = await allWallets();
      const i = list.findIndex((w) => w.id === rec.id);
      if (i >= 0) { list[i] = rec; await saveWallets(list); }
      if (session.id === rec.id && session.secret) session.accounts = pt.accounts;
      await Store.set({ [activeKey(rec.id)]: acc.id });
      session.activeAccount = acc.id;
      if (session.secret) await saveSession();
      return meta;
    },
    async renameAccount(id, label) {
      const rec = await selectedRec();
      if (!rec) throw new Error('no wallet');
      const m = (rec.accounts || []).find((a) => a.id === id);
      if (!m) throw new Error('no such account');
      m.label = String(label || '').trim() || m.label;
      const list = await allWallets();
      const i = list.findIndex((w) => w.id === rec.id);
      if (i >= 0) { list[i] = rec; await saveWallets(list); }
      return m;
    },
    async removeAccount(id, password) {
      const rec = await selectedRec();
      if (!rec || !rec.crypto) throw new Error('no wallet');
      if (id === 'main') throw new Error('the main account cannot be removed');
      const pt = await Vault.open(rec.crypto, password);
      pt.accounts = (pt.accounts || []).filter((a) => a.id !== id);
      rec.crypto = await Vault.seal(pt, password);
      rec.accounts = (rec.accounts || []).filter((a) => a.id !== id);
      const list = await allWallets();
      const i = list.findIndex((w) => w.id === rec.id);
      if (i >= 0) { list[i] = rec; await saveWallets(list); }
      if (session.id === rec.id && session.secret) session.accounts = pt.accounts;
      if (session.activeAccount === id) { session.activeAccount = 'main'; await Store.set({ [activeKey(rec.id)]: 'main' }); }
      if (session.secret) await saveSession();
      return true;
    },
    isUnlocked() {
      return !!session.secret;
    },
    scheme: 'ML-DSA-44',

    async exists() {
      return (await allWallets()).length > 0;
    },

    // Public list for the UI: [{id, label, address, watchOnly, active}].
    async list() {
      const sel = (await Store.get('selectedId')).selectedId;
      return (await allWallets()).map((w) => ({
        id: w.id,
        label: w.label,
        address: w.address,
        watchOnly: !!w.watchOnly,
        active: w.id === (sel || (session.id)),
      }));
    },

    async selected() {
      return selectedRec();
    },

    // Switch active wallet (locks the previous session).
    async select(id) {
      await Store.set({ selectedId: id });
      await this.lock();
      await this.loadPublic();
      return session.address;
    },

    async loadPublic() {
      const rec = await selectedRec();
      if (!rec) {
        session = { id: null, address: null, pub: null, secret: null, seed: null, at: 0 };
        return null;
      }
      session.id = rec.id;
      session.address = rec.address;
      session.pub = rec.publicKey;
      return { address: rec.address, id: rec.id, watchOnly: !!rec.watchOnly };
    },

    // Create a new wallet, seal under `password`, append, select, unlock.
    async create(password, label) {
      const kp = await Signer.keygen();
      const seed = seedFromBlock(kp.secretKey); // HD seed bound to the BLOCK key (deterministic)
      const crypto_ = await Vault.seal(
        { secret: kp.secretKey, public: kp.publicKey, seed },
        password
      );
      const list = await allWallets();
      const rec = {
        id: rid(),
        label: label || 'Wallet ' + (list.length + 1),
        format: 'blockle-wallet',
        version: 2,
        scheme: 'ML-DSA-44',
        address: kp.address,
        publicKey: kp.publicKey,
        crypto: crypto_,
      };
      list.push(rec);
      await saveWallets(list);
      await Store.set({ selectedId: rec.id });
      session = { id: rec.id, address: kp.address, pub: kp.publicKey, secret: kp.secretKey, seed, accounts: [], activeAccount: 'main', at: Date.now() };
      await saveSession();
      return { address: kp.address, id: rec.id };
    },

    // Unlock the active wallet.
    async unlock(password) {
      const rec = await selectedRec();
      if (!rec || !rec.crypto) throw new Error('no wallet');
      const pt = await Vault.open(rec.crypto, password);
      const { secret, public: pub } = pt;
      // The HD seed for every secp256k1 chain is DERIVED FROM THE BLOCK KEY (deterministic), so
      // EVM / Base / BTC / LTC / DOGE / SOL addresses persist across sessions and are reproducible
      // from the BLOCK identity alone. Legacy wallets that stored a random seed are migrated to the
      // BLOCK-derived one here and re-sealed below. BLOCK identity itself is untouched.
      const seed = seedFromBlock(secret);
      // The prior (random) seed, if any — kept so funds at the old multichain addresses are
      // recoverable via the "sweep legacy" flow.
      const legacySeed = (pt.seed && pt.seed !== seed) ? pt.seed : pt.legacySeed;
      // Transparent vault upgrade: re-seal legacy (v1 PBKDF2) blobs, blobs missing the HD seed, or
      // blobs whose stored seed differs from the BLOCK-derived one (migration), as the current v2
      // (scrypt) format. The user never loses access and never has to re-enter anything.
      if (Vault.needsUpgrade(rec.crypto) || pt.seed !== seed) {
        try {
          rec.crypto = await Vault.seal({ ...pt, secret, public: pub, seed, legacySeed }, password);
          const list = await allWallets();
          const i = list.findIndex((w) => w.id === rec.id);
          if (i >= 0) {
            list[i] = rec;
            await saveWallets(list);
          }
        } catch (_) {
          /* re-seal is best-effort; a failure must not block unlock */
        }
      }
      let active = 'main';
      try { active = (await Store.get(activeKey(rec.id)))[activeKey(rec.id)] || 'main'; } catch (_) {}
      if (active !== 'main' && !(pt.accounts || []).some((a) => a.id === active)) active = 'main';
      session = { id: rec.id, address: rec.address, pub: pub || rec.publicKey, secret, seed, legacySeed, accounts: pt.accounts || [], activeAccount: active, at: Date.now() };
      await saveSession();
      return { address: rec.address };
    },

    async resumeSession() {
      const s = await Session.get('session');
      const sel = (await Store.get('selectedId')).selectedId;
      if (!s || !s.secret || (sel && s.id !== sel)) return false;
      if (Date.now() - (s.at || 0) > AUTO_LOCK_MS) {
        await Session.clear('session');
        return false;
      }
      // Re-derive the HD seed from the BLOCK key on resume too, so a session saved before this
      // migration still yields the deterministic, BLOCK-attached multichain addresses.
      session = { id: s.id, address: s.address, pub: s.pub, secret: s.secret, seed: s.secret ? seedFromBlock(s.secret) : (s.seed || null), legacySeed: s.legacySeed || null, accounts: s.accounts || [], activeAccount: s.activeAccount || 'main', at: s.at };
      return true;
    },

    async lock() {
      // Wipe ALL decrypted secret material from memory: the BLOCK ML-DSA secret
      // and the secp256k1 HD seed. (Public address/pubkey may remain for display.)
      session = { id: session.id, address: session.address, pub: session.pub, secret: null, seed: null, accounts: null, activeAccount: session.activeAccount, at: 0 };
      await Session.clear('session');
    },

    async signMessage(message) {
      if (!session.secret) throw new Error('locked');
      return Signer.signMessage(session.secret, session.pub, message);
    },

    async verify(message, publicKeyHex, signatureHex) {
      return Signer.verify(publicKeyHex, message, signatureHex);
    },

    async buildTransfer(utxos, toAddress, amountBase, feeBase) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildTransfer(session.secret, session.pub, utxos, toAddress, amountBase, feeBase);
    },

    async buildDeploy(utxos, codeHex, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildDeploy(session.secret, session.pub, utxos, codeHex, gasLimit, gasPrice);
    },

    async buildCall(utxos, contractHex, inputHex, value, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildCall(session.secret, session.pub, utxos, contractHex, inputHex, value, gasLimit, gasPrice);
    },

    async buildTokenTransfer(utxos, contractHex, toAddr, amountBase, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildTokenTransfer(session.secret, session.pub, utxos, contractHex, toAddr, amountBase, gasLimit, gasPrice);
    },

    async buildPoolCreate(utxos, tokenHex, blockAmt, tokenAmt, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildPoolCreate(session.secret, session.pub, utxos, tokenHex, blockAmt, tokenAmt, gasLimit, gasPrice);
    },

    async buildLaunchToken(utxos, name, symbol, decimals, supply, seedBlock, seedToken, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildLaunchToken(session.secret, session.pub, utxos, name, symbol, decimals, supply, seedBlock, seedToken, gasLimit, gasPrice);
    },

    async buildLaunchNft(utxos, codeHex, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildLaunchNft(session.secret, session.pub, utxos, codeHex, gasLimit, gasPrice);
    },

    async buildPoolSwapBuy(utxos, tokenHex, blockIn, minTokenOut, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildPoolSwapBuy(session.secret, session.pub, utxos, tokenHex, blockIn, minTokenOut, gasLimit, gasPrice);
    },

    async buildPoolSwapSell(utxos, tokenHex, tokenIn, minBlockOut, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildPoolSwapSell(session.secret, session.pub, utxos, tokenHex, tokenIn, minBlockOut, gasLimit, gasPrice);
    },

    // --- encrypted cloud backup --------------------------------------------

    // Platform-neutral backup payload for the active (unlocked) wallet. This is the plaintext
    // that backup-crypto.js encrypts under the user's SEPARATE backup passphrase before upload;
    // the server only ever sees the opaque ciphertext. Requires the vault to be unlocked.
    async backupPayload() {
      if (!session.secret) return null; // locked
      const rec = (await allWallets()).find((w) => w.id === session.id);
      return {
        v: 2, scheme: 'ML-DSA-44',
        address: session.address, public: session.pub, secret: session.secret, seed: session.seed,
        label: rec && rec.label,
        accounts: session.accounts || [], accountsMeta: (rec && rec.accounts) || [],
      };
    },

    // Restore a wallet from a decrypted backup payload, re-sealing its secrets under a NEW local
    // password you set on this device. Appends + selects it; never overwrites an existing wallet.
    async restoreFromPayload(payload, newPassword, label) {
      if (!payload || !payload.secret || !payload.public) throw new Error('invalid backup payload');
      const crypto_ = await Vault.seal(
        { secret: payload.secret, public: payload.public, seed: payload.seed || null, accounts: payload.accounts || [] }, newPassword);
      const list = await allWallets();
      const rec = {
        id: rid(), label: label || payload.label || 'Restored wallet',
        format: 'blockle-wallet', version: 2, scheme: payload.scheme || 'ML-DSA-44',
        address: payload.address, publicKey: payload.public, crypto: crypto_,
        accounts: payload.accountsMeta || [],
      };
      list.push(rec);
      await saveWallets(list);
      await Store.set({ selectedId: rec.id });
      return { id: rec.id, address: rec.address };
    },

    // --- import / export ---------------------------------------------------

    // Export the active wallet's sealed record.
    async exportFile(id) {
      const target = id || session.id;
      const rec = (await allWallets()).find((w) => w.id === target);
      if (!rec) throw new Error('no wallet');
      return rec;
    },

    // Import a wallet and set a NEW local password on it.
    //   - Our format: decrypt with the file's password, then RE-SEAL under the
    //     new password so the imported wallet is protected by a password you set.
    //   - Raw secret/public hex (e.g. exported from a desktop wallet): sealed
    //     under the new password as a full, signable wallet.
    //   - Desktop wallet.json with no usable secret: imported watch-only.
    async importFile(obj, filePassword, newPassword, label) {
      const list = await allWallets();
      const addRec = async (secret, pub, address, watchOnly, extra) => {
        extra = extra || {};
        const seed = watchOnly ? null : newSeedHex();
        const crypto_ = watchOnly ? null : await Vault.seal({ secret, public: pub, seed, accounts: extra.accounts || [] }, newPassword);
        const rec = {
          id: rid(),
          label: label || (watchOnly ? 'Imported (watch)' : 'Imported ' + (list.length + 1)),
          format: 'blockle-wallet',
          version: 2,
          scheme: 'ML-DSA-44',
          address,
          publicKey: pub || '',
          crypto: crypto_,
          watchOnly: !!watchOnly,
          accounts: extra.accountsMeta || [],
        };
        list.push(rec);
        await saveWallets(list);
        await Store.set({ selectedId: rec.id });
        if (!watchOnly) {
          session = { id: rec.id, address, pub, secret, seed, accounts: extra.accounts || [], activeAccount: 'main', at: Date.now() };
          await saveSession();
        } else {
          session = { id: rec.id, address, pub: pub || '', secret: null, seed: null, at: 0 };
        }
        return { address, id: rec.id, mode: watchOnly ? 'watch-only' : 'full' };
      };

      // Our encrypted format → decrypt with the file password, re-seal with new.
      if (obj && obj.format === 'blockle-wallet' && obj.crypto) {
        const pt = await Vault.open(obj.crypto, filePassword);
        const { secret, public: pub } = pt;
        const address = obj.address || (await Signer.addressFromPubkey(pub));
        return addRec(secret, pub, address, false, { accounts: pt.accounts || [], accountsMeta: obj.accounts || [] });
      }
      // Raw ML-DSA key material (hex) → FULL wallet under the new password.
      // Covers the desktop wallet.json (secret_hex / public_hex) and generic
      // {secret, public} exports.
      const rawSecret = obj && (obj.secret || obj.secretKey || obj.sk || obj.secret_hex);
      const rawPublic = obj && (obj.public || obj.publicKey || obj.pk || obj.public_hex);
      if (rawSecret && rawPublic && /^[0-9a-fA-F]+$/.test(rawSecret)) {
        const address = obj.address || (await Signer.addressFromPubkey(rawPublic));
        return addRec(rawSecret, rawPublic, address, false);
      }
      // An encrypted desktop wallet (no plaintext secret) can't be signed from
      // here yet — decrypt it in the desktop wallet first and re-export.
      if (obj && obj.encrypted && obj.address) {
        throw new Error('this wallet file is encrypted — decrypt it in the desktop wallet and export again');
      }
      // Address only → watch-only.
      const addr = obj && (obj.address || obj.block_address || obj.receive_address);
      if (addr && /^block1/.test(addr)) {
        return addRec(null, '', addr, true);
      }
      throw new Error('unrecognized wallet file');
    },

    async remove(id) {
      let list = await allWallets();
      list = list.filter((w) => w.id !== id);
      await saveWallets(list);
      if (session.id === id) await this.lock();
      await Store.set({ selectedId: list[0] ? list[0].id : null });
      await this.loadPublic();
    },

    async reset() {
      await Store.remove('wallets');
      await Store.remove('selectedId');
      await Store.remove('sites');
      await Session.clear('session');
      session = { id: null, address: null, pub: null, secret: null, at: 0 };
    },
  };

  global.Wallet = Wallet;
})(typeof self !== 'undefined' ? self : window);
