// backup-ui.js — orchestrates encrypted cloud backup/restore for the extension. It wires the
// vault (wallet.js backupPayload/restoreFromPayload) to the backup client (backup-client.js),
// which encrypts locally (backup-crypto.js) under a SEPARATE backup passphrase and talks to the
// accounts service as a native wallet (bearer token). It holds no keys and does no logging; the
// vault must be unlocked to back up. Global `WalletBackupUI`; module.exports for the node test.
(function (global) {
  const inNode = (typeof module !== 'undefined' && module.exports);
  function dep(name, file) {
    if (global[name]) return global[name];
    if (inNode) { try { return require(file); } catch (e) { return null; } }
    return null;
  }

  // deps: { wallet, client, origin, email, password, totp, passphrase, device }
  async function backup(deps) {
    deps = deps || {};
    const wallet = deps.wallet || dep('Wallet', './wallet.js');
    const client = deps.client || dep('BLKBackupClient', './backup-client.js');
    if (!wallet || !client) return { ok: false, reason: 'unavailable' };
    if (!(wallet.isUnlocked && wallet.isUnlocked())) return { ok: false, reason: 'locked' };
    const payload = await wallet.backupPayload();
    if (!payload) return { ok: false, reason: 'locked' };
    const { token } = await client.login(deps.origin, deps.email, deps.password, deps.totp);
    await client.backup(deps.origin, token, deps.totp, payload, deps.passphrase,
      { app: 'extension', device: deps.device || '', scheme: payload.scheme });
    return { ok: true };
  }

  // deps: { wallet, client, origin, email, password, totp, passphrase, newPassword, label }
  async function restore(deps) {
    deps = deps || {};
    const wallet = deps.wallet || dep('Wallet', './wallet.js');
    const client = deps.client || dep('BLKBackupClient', './backup-client.js');
    if (!wallet || !client) return { ok: false, reason: 'unavailable' };
    const { token } = await client.login(deps.origin, deps.email, deps.password, deps.totp);
    let payload;
    try {
      const json = await client.restore(deps.origin, token, deps.totp, deps.passphrase);
      payload = JSON.parse(json);
    } catch { return { ok: false, reason: 'bad-passphrase' }; } // decrypt (GCM) or parse failed
    const res = await wallet.restoreFromPayload(payload, deps.newPassword, deps.label || payload.label);
    return { ok: true, id: res.id, address: res.address };
  }

  const api = { backup, restore };
  if (inNode) module.exports = api;
  global.WalletBackupUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
