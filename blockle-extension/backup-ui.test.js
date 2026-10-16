const assert = require('node:assert');
const { test } = require('node:test');
const UI = require('./backup-ui.js');
const Client = require('./backup-client.js'); // real client + real crypto

// Fake accounts service (bearer login + a ciphertext-only store), and a stub wallet whose vault
// holds a known payload. Verifies the full backup→restore orchestration round-trips the payload
// and that the server only ever receives opaque ciphertext.
function fakeServer() {
  const store = {};
  globalThis.fetch = async (url, opts = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    const J = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o });
    if (path === '/account/api/login') return J({ ok: true, token: 'TKN', user: { email: body.email } });
    if (path === '/account/api/backup' && opts.method === 'PUT') { store.ct = body.ciphertext; return J({ ok: true }); }
    if (path === '/account/api/backup') return store.ct ? J({ latest: { ciphertext: store.ct } }) : J({ error: 'none' }, 404);
    return J({ error: 'nope' }, 404);
  };
  return store;
}

const PAYLOAD = { v: 2, scheme: 'ML-DSA-44', address: 'blk1qexample', public: 'PUBHEX', secret: 'SECRETHEX', seed: 'SEEDHEX', label: 'Main' };

function stubWallet() {
  const restored = [];
  return {
    _restored: restored,
    isUnlocked: () => true,
    backupPayload: async () => ({ ...PAYLOAD }),
    restoreFromPayload: async (payload, newPassword, label) => {
      restored.push({ payload, newPassword, label });
      return { id: 'w-new', address: payload.address };
    },
  };
}

test('backup uploads only ciphertext; restore reconstructs the exact payload', async () => {
  const store = fakeServer();
  const wallet = stubWallet();
  const common = { wallet, client: Client, origin: 'https://blockle.org', email: 'u@b.com', password: 'pw', totp: '123456', passphrase: 'my-backup-pass' };

  const b = await UI.backup(common);
  assert.strictEqual(b.ok, true);
  assert.ok(!store.ct.includes('SECRETHEX'), 'secret must not be uploaded in clear');
  assert.ok(!store.ct.includes('SEEDHEX'), 'seed must not be uploaded in clear');

  const r = await UI.restore({ ...common, newPassword: 'new-device-pw' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'w-new');
  assert.deepStrictEqual(wallet._restored[0].payload, PAYLOAD, 'payload round-trips exactly');
  assert.strictEqual(wallet._restored[0].newPassword, 'new-device-pw');
});

test('backup is blocked when the vault is locked', async () => {
  fakeServer();
  const wallet = { ...stubWallet(), isUnlocked: () => false };
  const res = await UI.backup({ wallet, client: Client, email: 'u@b.com', password: 'pw', totp: '1', passphrase: 'p' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'locked');
});

test('restore with the wrong passphrase fails without touching the vault', async () => {
  fakeServer();
  const wallet = stubWallet();
  await UI.backup({ wallet, client: Client, email: 'u@b.com', password: 'pw', totp: '1', passphrase: 'right' });
  const res = await UI.restore({ wallet, client: Client, email: 'u@b.com', password: 'pw', totp: '1', passphrase: 'wrong', newPassword: 'x' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(wallet._restored.length, 0, 'no wallet created on bad passphrase');
});
