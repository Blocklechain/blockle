// Blockle encrypted-backup CLIENT. Talks to the accounts service as a native wallet (bearer
// token, not the browser cookie). Encryption happens locally via BLKBackup (backup-crypto.js) —
// only opaque ciphertext is uploaded, so the server (and anyone who breaches it) can never read
// the vault. 2FA is required for backup ops, so the caller supplies a current TOTP code.
//
// Shared contract with python/blockle/backup_client.py and
// blockle-app/lib/multichain/backup_client.dart.
(function (global) {
  const Backup = (typeof require !== 'undefined') ? require('./backup-crypto.js') : global.BLKBackup;
  const DEFAULT_ORIGIN = 'https://blockle.org';

  async function req(origin, method, path, { token, totp, body } = {}) {
    const headers = { 'x-blockle-client': 'wallet' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (totp) headers['x-totp'] = totp;
    const r = await fetch((origin || DEFAULT_ORIGIN) + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data.error || data.message || `http ${r.status}`);
    return data;
  }

  // Sign in to the Blockle account; returns { token, user }. `totp` only if 2FA is on.
  async function login(origin, email, password, totp) {
    const d = await req(origin, 'POST', '/account/api/login', { body: { email, password, totp } });
    if (!d.token) throw new Error('no token (is x-blockle-client honored?)');
    return { token: d.token, user: d.user };
  }

  // Encrypt `vaultObj` with `passphrase` and upload. `meta` is non-secret (device label etc.).
  async function backup(origin, token, totp, vaultObj, passphrase, meta = {}) {
    const plaintext = typeof vaultObj === 'string' ? vaultObj : JSON.stringify(vaultObj);
    const ciphertext = await Backup.encryptVault(passphrase, plaintext);
    await req(origin, 'PUT', '/account/api/backup', { token, totp, body: { ciphertext, meta } });
    return { ok: true };
  }

  // Download the latest backup and decrypt it locally with `passphrase`. Returns the vault string.
  async function restore(origin, token, totp, passphrase) {
    const d = await req(origin, 'GET', '/account/api/backup', { token, totp });
    if (!d.latest || !d.latest.ciphertext) throw new Error('no backup stored');
    return Backup.decryptVault(passphrase, d.latest.ciphertext);
  }

  // The signed-in account (incl. `sub` with the Copilot tier) — for feature gating.
  async function me(origin, token) {
    const d = await req(origin, 'GET', '/account/api/me', { token });
    return d.user || null;
  }

  // Extract the Copilot subscription tier from a /me user object. 'free' when inactive.
  function tierOf(user) {
    const sub = (user && user.sub) || {};
    return sub.active ? (sub.tier || 'free') : 'free';
  }

  // The EFFECTIVE entitlement tier (folds in an active free trial). The server exposes
  // sub.entitledTier; fall back to tierOf for older payloads. Use this (not tierOf) for
  // the live-bot gate so trials unlock live arming, matching the web wallet's loadTier.
  function entitledTierOf(user) {
    const sub = (user && user.sub) || {};
    return sub.entitledTier || tierOf(user);
  }

  // The per-plan LIVE-bot cap (Free 1, Copilot 3, Pro -1 = unlimited). Defaults to 1
  // (Free) when the server did not supply one.
  function liveBotLimitOf(user) {
    const sub = (user && user.sub) || {};
    return sub.liveBotLimit != null ? Number(sub.liveBotLimit) : 1;
  }

  // Quick backtest of a CONFIGURED strategy on recent real prices (the tune-and-test loop).
  // body: { type, params, asset } -> { pnlPct, trades, maxDrawdownPct, curve }.
  async function backtest(origin, token, body) {
    return req(origin, 'POST', '/account/api/backtest', { token, body: body || {} });
  }

  // Copy-trade = clone another trader's bot CONFIG into a fresh paper bot (config only, never
  // funds or live state). body: { fromBotId } (or an inline { type, pair, params }) -> { ok, bot }.
  async function copyBot(origin, token, body) {
    const b = (typeof body === 'string') ? { fromBotId: body } : (body || {});
    return req(origin, 'POST', '/account/api/bots/copy', { token, body: b });
  }

  const api = { login, me, tierOf, entitledTierOf, liveBotLimitOf, backtest, copyBot, backup, restore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BLKBackupClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
