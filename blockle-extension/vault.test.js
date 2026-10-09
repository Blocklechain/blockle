// vault.test.js — unit tests for the password-sealed vault.
//
// Run:  node vault.test.js        (Node 20+, uses global WebCrypto)
//
// Covers:
//   1. scrypt correctness vs. RFC 7914 published test vectors,
//   2. seal→open roundtrip preserves the plaintext (incl. the full multi-chain
//      plaintext: BLOCK ML-DSA keypair + secp256k1 HD seed),
//   3. wrong-passphrase rejection (AES-GCM auth failure, normalized),
//   4. a tampered blob is rejected,
//   5. legacy v1 (PBKDF2) blobs still open, and needsUpgrade() flags them.
//
// No external test framework — a tiny assert harness so it runs anywhere.

const assert = require('node:assert');
require('./vault.js'); // attaches globalThis.Vault + globalThis.VaultUtil

const { Vault, VaultUtil } = globalThis;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failures.push(name);
    console.log('FAIL  ' + name + '\n        ' + (e && e.message));
  }
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

(async () => {
  // --- 1. scrypt RFC 7914 vectors ----------------------------------------
  // scrypt("pleaseletmein","SodiumChloride",N=16384,r=8,p=1,dkLen=64)
  await test('scrypt RFC7914 vector (N=16384,r=8,p=1) — matches default params', async () => {
    const dk = await VaultUtil.scrypt(
      'pleaseletmein',
      new TextEncoder().encode('SodiumChloride'),
      16384, 8, 1, 64
    );
    const expected =
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2' +
      'd5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887';
    assert.strictEqual(hex(dk), expected);
  });

  // scrypt("password","NaCl",N=1024,r=8,p=16,dkLen=64) — exercises p>1 blocks.
  await test('scrypt RFC7914 vector (N=1024,r=8,p=16) — exercises multiple blocks', async () => {
    const dk = await VaultUtil.scrypt(
      'password',
      new TextEncoder().encode('NaCl'),
      1024, 8, 16, 64
    );
    const expected =
      'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162' +
      '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640';
    assert.strictEqual(hex(dk), expected);
  });

  // --- 2. seal/open roundtrip --------------------------------------------
  const plaintext = {
    version: 2,
    // BLOCK identity — post-quantum ML-DSA-44 keypair (hex, abbreviated here):
    block: { secret: 'ab'.repeat(32), public: 'cd'.repeat(32) },
    // HD root for every secp256k1 chain (EVM / BTC / LTC / DOGE):
    seed: 'ef'.repeat(32),
    agent: { provider: 'claude', apiKey: 'sk-ant-test-DO-NOT-LEAVE-DEVICE' },
    endpoints: { ethereum: { rpc: 'https://rpc.example' } },
  };

  await test('seal → open roundtrip preserves the full multi-chain plaintext', async () => {
    const sealed = await Vault.seal(plaintext, 'correct horse battery staple');
    assert.strictEqual(sealed.v, 2);
    assert.strictEqual(sealed.kdf.name, 'scrypt');
    assert.strictEqual(sealed.kdf.params.N, 16384);
    // ciphertext must not leak the secret in the clear
    assert.ok(!sealed.data.includes('sk-ant'), 'cred must be encrypted');
    const opened = await Vault.open(sealed, 'correct horse battery staple');
    assert.deepStrictEqual(opened, plaintext);
  });

  await test('two seals of the same plaintext differ (random salt + iv)', async () => {
    const a = await Vault.seal(plaintext, 'pw');
    const b = await Vault.seal(plaintext, 'pw');
    assert.notStrictEqual(a.salt, b.salt);
    assert.notStrictEqual(a.iv, b.iv);
    assert.notStrictEqual(a.data, b.data);
  });

  // --- 3. wrong passphrase ------------------------------------------------
  await test('wrong passphrase is rejected', async () => {
    const sealed = await Vault.seal(plaintext, 'the-right-one');
    await assert.rejects(
      () => Vault.open(sealed, 'the-wrong-one'),
      /wrong password/
    );
  });

  await test('empty-string passphrase is rejected when sealed under a real one', async () => {
    const sealed = await Vault.seal(plaintext, 'nonempty');
    await assert.rejects(() => Vault.open(sealed, ''), /wrong password/);
  });

  // --- 4. tamper detection ------------------------------------------------
  await test('tampered ciphertext is rejected (AEAD auth)', async () => {
    const sealed = await Vault.seal(plaintext, 'pw');
    const raw = VaultUtil.unb64(sealed.data);
    raw[0] ^= 0x01; // flip one bit
    const tampered = { ...sealed, data: VaultUtil.b64(raw) };
    await assert.rejects(() => Vault.open(tampered, 'pw'), /wrong password/);
  });

  // --- 5. legacy v1 (PBKDF2) compatibility + upgrade flag -----------------
  await test('legacy v1 PBKDF2 blob still opens, and needsUpgrade flags it', async () => {
    // Build a v1 blob exactly as the old vault.js did: PBKDF2-310k → AES-GCM.
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey('raw', enc.encode('legacy-pw'), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    const legacyObj = { secret: 'deadbeef', public: 'feedface' };
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(legacyObj)));
    const v1 = { v: 1, salt: VaultUtil.b64(salt), iv: VaultUtil.b64(iv), data: VaultUtil.b64(ct) };

    assert.ok(Vault.needsUpgrade(v1), 'v1 blob must be flagged for upgrade');
    const opened = await Vault.open(v1, 'legacy-pw');
    assert.deepStrictEqual(opened, legacyObj);
    // wrong password on a v1 blob also normalizes to "wrong password"
    await assert.rejects(() => Vault.open(v1, 'nope'), /wrong password/);
  });

  await test('a freshly sealed v2 blob does NOT need upgrade', async () => {
    const sealed = await Vault.seal(plaintext, 'pw');
    assert.strictEqual(Vault.needsUpgrade(sealed), false);
  });

  // --- summary ------------------------------------------------------------
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) process.exit(1);
})();
