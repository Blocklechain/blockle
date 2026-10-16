const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const B = require('./backup-crypto.js');

const vec = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/backup-vectors.json'), 'utf8'));

test('round-trips any plaintext', async () => {
  const pt = JSON.stringify({ mnemonic: 'abandon abandon about', accounts: [1, 2, 3] });
  const blob = await B.encryptVault('pw-correct-horse', pt);
  assert.strictEqual(await B.decryptVault('pw-correct-horse', blob), pt);
});

test('matches the cross-platform vector ct exactly', async () => {
  const salt = Uint8Array.from(Buffer.from(vec.saltB64, 'base64'));
  const nonce = Uint8Array.from(Buffer.from(vec.nonceB64, 'base64'));
  const blob = await B.encryptVault(vec.passphrase, vec.plaintext, { salt, nonce, iter: vec.iter });
  const env = JSON.parse(Buffer.from(blob.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.strictEqual(env.ct, vec.ctB64);
});

test('decrypts the stored vector blob', async () => {
  assert.strictEqual(await B.decryptVault(vec.passphrase, vec.blob), vec.plaintext);
});

test('wrong passphrase throws (GCM auth fails)', async () => {
  await assert.rejects(() => B.decryptVault('wrong-passphrase', vec.blob));
});
