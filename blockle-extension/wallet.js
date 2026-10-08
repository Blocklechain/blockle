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
  let session = { id: null, address: null, pub: null, secret: null, at: 0 };

  const rid = () => 'w' + Math.random().toString(36).slice(2, 10);

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
    get activeId() {
      return session.id;
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
        session = { id: null, address: null, pub: null, secret: null, at: 0 };
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
      const crypto_ = await Vault.seal({ secret: kp.secretKey, public: kp.publicKey }, password);
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
      session = { id: rec.id, address: kp.address, pub: kp.publicKey, secret: kp.secretKey, at: Date.now() };
      await saveSession();
      return { address: kp.address, id: rec.id };
    },

    // Unlock the active wallet.
    async unlock(password) {
      const rec = await selectedRec();
      if (!rec || !rec.crypto) throw new Error('no wallet');
      const { secret, public: pub } = await Vault.open(rec.crypto, password);
      session = { id: rec.id, address: rec.address, pub: pub || rec.publicKey, secret, at: Date.now() };
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
      session = { id: s.id, address: s.address, pub: s.pub, secret: s.secret, at: s.at };
      return true;
    },

    async lock() {
      session = { id: session.id, address: session.address, pub: session.pub, secret: null, at: 0 };
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

    async buildPoolCreate(utxos, tokenHex, blockAmt, tokenAmt, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildPoolCreate(session.secret, session.pub, utxos, tokenHex, blockAmt, tokenAmt, gasLimit, gasPrice);
    },

    async buildPoolSwapBuy(utxos, tokenHex, blockIn, minTokenOut, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildPoolSwapBuy(session.secret, session.pub, utxos, tokenHex, blockIn, minTokenOut, gasLimit, gasPrice);
    },

    async buildPoolSwapSell(utxos, tokenHex, tokenIn, minBlockOut, gasLimit, gasPrice) {
      if (!session.secret) throw new Error('locked');
      return Signer.buildPoolSwapSell(session.secret, session.pub, utxos, tokenHex, tokenIn, minBlockOut, gasLimit, gasPrice);
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
      const addRec = async (secret, pub, address, watchOnly) => {
        const crypto_ = watchOnly ? null : await Vault.seal({ secret, public: pub }, newPassword);
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
        };
        list.push(rec);
        await saveWallets(list);
        await Store.set({ selectedId: rec.id });
        if (!watchOnly) {
          session = { id: rec.id, address, pub, secret, at: Date.now() };
          await saveSession();
        } else {
          session = { id: rec.id, address, pub: pub || '', secret: null, at: 0 };
        }
        return { address, id: rec.id, mode: watchOnly ? 'watch-only' : 'full' };
      };

      // Our encrypted format → decrypt with the file password, re-seal with new.
      if (obj && obj.format === 'blockle-wallet' && obj.crypto) {
        const { secret, public: pub } = await Vault.open(obj.crypto, filePassword);
        const address = obj.address || (await Signer.addressFromPubkey(pub));
        return addRec(secret, pub, address, false);
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
