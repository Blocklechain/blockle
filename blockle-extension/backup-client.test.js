const assert = require('node:assert');
const { test } = require('node:test');
const Client = require('./backup-client.js');

// Fake accounts service: a bearer token on login, and a store that only ever holds the opaque
// ciphertext the client uploads. Asserts the plaintext vault never leaves the device.
function fakeServer() {
  const store = {};
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (path === '/account/api/login') return json({ ok: true, token: 'TKN', user: { email: body.email } });
    if (path === '/account/api/backup' && opts.method === 'PUT') {
      assert.strictEqual(opts.headers.Authorization, 'Bearer TKN');
      assert.ok(opts.headers['x-totp'], 'totp required');
      store.ct = body.ciphertext; seen.push(body.ciphertext);
      return json({ ok: true });
    }
    if (path === '/account/api/backup') return json(store.ct ? { latest: { ciphertext: store.ct } } : { error: 'none' }, store.ct ? 200 : 404);
    return json({ error: 'nope' }, 404);
  };
  return { store, seen };
}
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });

test('backup uploads ONLY ciphertext; restore round-trips the vault', async () => {
  const srv = fakeServer();
  const vault = { mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', accounts: [{ chain: 'BLOCK' }] };
  const { token } = await Client.login('https://blockle.org', 'u@b.com', 'pw');
  await Client.backup('https://blockle.org', token, '123456', vault, 'my-backup-passphrase', { app: 'extension' });

  // what the server stored must NOT contain the mnemonic or any plaintext
  assert.ok(!srv.store.ct.includes('legal winner'), 'no plaintext uploaded');
  assert.ok(!srv.store.ct.includes('mnemonic'), 'no plaintext key names uploaded');

  const restored = await Client.restore('https://blockle.org', token, '123456', 'my-backup-passphrase');
  assert.deepStrictEqual(JSON.parse(restored), vault);
});

test('restore with the wrong passphrase fails (no silent corruption)', async () => {
  fakeServer();
  const { token } = await Client.login(null, 'u@b.com', 'pw');
  await Client.backup(null, token, '123456', { secret: 42 }, 'right-pass');
  await assert.rejects(() => Client.restore(null, token, '123456', 'wrong-pass'));
});
