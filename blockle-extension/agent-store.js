// agent-store.js — persistent, ENCRYPTED storage for the in-wallet agent's LLM
// credentials ("connections"). This is what makes a provider connection survive
// a popup close and AUTO-RECONNECT on the next unlock, per the Pass-2 spec.
//
// HARD RULE: an LLM API key is NEVER written to disk unencrypted and is NEVER
// sent to a Blockle server. Here, connections are sealed with the SAME vault
// primitive as the wallet (scrypt + AES-256-GCM) under the wallet password, and
// the sealed blob is stored in Store('agentConnections'). The decrypted copy
// lives only in memory for the session (mirrored into chrome.storage.session so
// it survives a popup reopen, exactly like the wallet key session) and is wiped
// on lock/kill.
//
// A "connection" record (secret-free view): { credRef, provider, model, baseUrl,
// label, createdAt }. channels.js references a connection by `credRef`; this
// store resolves credRef -> { provider, apiKey, model?, baseUrl? } at run time.
//
// Global `AgentStore`.
(function (global) {
  'use strict';

  const DISK_KEY = 'agentConnections';   // sealed blob (on disk, encrypted)
  const SESS_KEY = 'agent:connections';  // decrypted, in-memory session mirror

  // in-memory session state (never persisted to disk unencrypted)
  let _pw = null;                 // wallet password, cached in memory for re-seal
  let _conns = null;              // [{ credRef, provider, apiKey, model, baseUrl, label, createdAt }]

  const rid = () => 'cr' + Math.random().toString(36).slice(2, 10);

  async function persist() {
    if (!_pw || !_conns) return;
    const sealed = await Vault.seal(_conns, _pw);
    await Store.set({ [DISK_KEY]: sealed });
    // mirror the decrypted set into ephemeral session storage for popup reopen
    await Session.set(SESS_KEY, { conns: _conns, pw: _pw });
  }

  const AgentStore = {
    isUnlocked() { return _conns != null; },

    // Open (or initialize) the encrypted connection store with the wallet
    // password. Called right after Wallet.unlock(pw). Never throws for an empty
    // or password-mismatched store — it degrades to "no connections available".
    async unlock(password) {
      _pw = password;
      const sealed = (await Store.get(DISK_KEY))[DISK_KEY];
      if (!sealed) { _conns = []; await Session.set(SESS_KEY, { conns: _conns, pw: _pw }); return _conns; }
      try {
        const pt = await Vault.open(sealed, password);
        _conns = Array.isArray(pt) ? pt : [];
      } catch (_) {
        // wrong password for the agent blob (shouldn't happen — same pw as wallet)
        _conns = []; _pw = null;
        return _conns;
      }
      await Session.set(SESS_KEY, { conns: _conns, pw: _pw });
      return _conns;
    },

    // Resume from the ephemeral session mirror (popup reopened without a fresh
    // password entry). Mirrors Wallet.resumeSession().
    async resume() {
      if (_conns != null) return true;
      const s = await Session.get(SESS_KEY);
      if (s && Array.isArray(s.conns)) { _conns = s.conns; _pw = s.pw || null; return true; }
      return false;
    },

    // Add / update a connection. Requires the store to be unlocked (we need the
    // password to re-seal). Two shapes:
    //   BYO-key: { provider, apiKey, model?, baseUrl?, label? }
    //   hosted : { provider:'hosted', gatewayUrl, sessionToken, expiresAt,
    //              label?, model?, address?, chain?, publicKey? }  (NO apiKey)
    // The hosted record holds NO upstream LLM key — only a short-lived session
    // token, transparently refreshed via refreshHosted() on expiry.
    async add(cred) {
      if (_conns == null || !_pw) throw new Error('unlock the wallet before connecting a provider');
      if (!cred || !cred.provider) throw new Error('a provider is required');
      const credRef = cred.credRef || rid();
      let rec;
      if (cred.provider === 'hosted') {
        if (!cred.gatewayUrl || !cred.sessionToken) throw new Error('a gatewayUrl and sessionToken are required for a hosted connection');
        rec = {
          credRef,
          provider: 'hosted',
          gatewayUrl: cred.gatewayUrl,
          sessionToken: cred.sessionToken,
          expiresAt: cred.expiresAt || null,
          address: cred.address || null,
          chain: cred.chain || null,
          publicKey: cred.publicKey || null,
          model: cred.model || null,
          label: cred.label || 'Blockle hosted agent',
          createdAt: Date.now(),
        };
      } else {
        if (!cred.apiKey) throw new Error('a provider and API key are required');
        rec = {
          credRef,
          provider: cred.provider,
          apiKey: cred.apiKey,
          model: cred.model || null,
          baseUrl: cred.baseUrl || null,
          label: cred.label || cred.provider,
          createdAt: Date.now(),
        };
      }
      const i = _conns.findIndex((c) => c.credRef === credRef);
      if (i >= 0) _conns[i] = rec; else _conns.push(rec);
      await persist();
      return { credRef, provider: rec.provider, model: rec.model, baseUrl: rec.baseUrl || null, gatewayUrl: rec.gatewayUrl || null, expiresAt: rec.expiresAt || null, label: rec.label };
    },

    // Keyless connect: perform the gateway signature handshake (via
    // AgentProviders.hostedSession) and seal the resulting hosted connection.
    // `sign(message) -> { signature, publicKey }` is the wallet's own signer; no
    // apiKey, no private key, ever leaves the device. Returns the secret-free view.
    async connectHosted(opts) {
      if (_conns == null || !_pw) throw new Error('unlock the wallet before connecting a provider');
      const Providers = (typeof global !== 'undefined' && global.AgentProviders) ||
        (typeof require === 'function' ? require('./agent/providers.js') : null);
      if (!Providers || typeof Providers.hostedSession !== 'function') throw new Error('AgentProviders.hostedSession unavailable');
      const sess = await Providers.hostedSession(opts || {});
      return this.add({
        credRef: (opts && opts.credRef) || undefined,
        provider: 'hosted',
        gatewayUrl: sess.gatewayUrl,
        sessionToken: sess.sessionToken,
        expiresAt: sess.expiresAt,
        address: sess.address,
        chain: sess.chain,
        publicKey: sess.publicKey,
        model: (opts && opts.model) || null,
        label: sess.label,
      });
    },

    // Transparent refresh: update a hosted connection's session token (after a
    // re-sign on expiry) and re-seal. Returns true if the record was found.
    async refreshHosted(credRef, sessionToken, expiresAt) {
      if (_conns == null || !_pw) return false;
      const c = _conns.find((x) => x.credRef === credRef && x.provider === 'hosted');
      if (!c) return false;
      c.sessionToken = sessionToken;
      if (expiresAt != null) c.expiresAt = expiresAt;
      await persist();
      return true;
    },

    async remove(credRef) {
      if (_conns == null) return false;
      const n = _conns.length;
      _conns = _conns.filter((c) => c.credRef !== credRef);
      await persist();
      return _conns.length !== n;
    },

    // Secret-free list for the UI. For hosted connections the sessionToken (a
    // short-lived bearer) is NEVER included — only non-secret transport metadata.
    list() {
      if (!_conns) return [];
      return _conns.map((c) => (c.provider === 'hosted'
        ? { credRef: c.credRef, provider: 'hosted', gatewayUrl: c.gatewayUrl, expiresAt: c.expiresAt, model: c.model, label: c.label, createdAt: c.createdAt }
        : { credRef: c.credRef, provider: c.provider, model: c.model, baseUrl: c.baseUrl, label: c.label, createdAt: c.createdAt }));
    },

    // Resolve a credRef to the full credential. Used by channels.js
    // resolveCredential. For BYO-key the apiKey leaves memory only to call the
    // provider's own API; for HOSTED there is NO apiKey — only the gatewayUrl +
    // short-lived sessionToken (never an upstream key).
    resolve(credRef) {
      if (!_conns) return null;
      const c = _conns.find((x) => x.credRef === credRef);
      if (!c) return null;
      if (c.provider === 'hosted') {
        return { provider: 'hosted', gatewayUrl: c.gatewayUrl, sessionToken: c.sessionToken, expiresAt: c.expiresAt, model: c.model, address: c.address, chain: c.chain, publicKey: c.publicKey };
      }
      return { provider: c.provider, apiKey: c.apiKey, model: c.model, baseUrl: c.baseUrl };
    },

    // Wipe all decrypted credential material from memory + the session mirror.
    async lock() {
      _pw = null; _conns = null;
      try { await Session.clear(SESS_KEY); } catch {}
    },
  };

  global.AgentStore = AgentStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentStore;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
