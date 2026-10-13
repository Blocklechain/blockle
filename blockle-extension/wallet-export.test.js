// wallet-export.test.js — WALLET EXPORT (docs/WALLET-EXPORT.md). Run:
//   node --test wallet-export.test.js
//
// Asserts the reference wallet-export.js against the AUTHORITATIVE shared
// vectors (docs/wallet-export-vectors.json) the Dart + Python ports reproduce:
// the fixed seed -> exact WIF (btc/ltc/doge) + EVM 0x-hex + Solana base58 keys,
// and the exact Core importwallet dump lines. Plus: WIF round-trips to the same
// key+address; each dump WIF matches its stated address; the gate blocks export
// while locked and on a declined confirm; and NO secret is ever logged or sent.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const WX = require('./wallet-export.js');
const Addr = require('./address.js');
const S = require('./secp256k1.js');
const ED = require('./ed25519.js');
const C = require('./crypto-core.js');
const Utxo = require('./chains/utxo.js');

const V = require(path.join('..', 'docs', 'wallet-export-vectors.json'));

// Re-derive an address from a WIF exactly as a recovering wallet would.
function addressFromWif(chainId, wif) {
  const net = Utxo.NETWORKS[chainId];
  const { privateKey } = Addr.fromWIF(wif);
  const pub = S.publicKey(privateKey, true);
  return net.segwit ? Addr.p2wpkh(pub, net.hrp) : Addr.p2pkh(pub, net.p2pkh);
}

// ===========================================================================
// 1. REFERENCE === VECTORS  (the cross-wallet contract)
// ===========================================================================
test('fromMnemonic reproduces the vector seed hex', () => {
  const r = WX.fromMnemonic(V.mnemonic, V.passphrase);
  assert.strictEqual(r.seedHex, V.seedHex);
});

test('privateKeys reproduces every vector key + address + path', () => {
  const k = WX.privateKeys(V.seedHex, V.accountIndex);
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    assert.strictEqual(k[c].wif, V.keys[c].wif, c + ' wif');
    assert.strictEqual(k[c].address, V.keys[c].address, c + ' address');
    assert.strictEqual(k[c].wifVersion, V.keys[c].wifVersion, c + ' wif version byte');
    assert.strictEqual(k[c].path, V.paths[c], c + ' path');
  }
  assert.strictEqual(k.evm.privateKey, V.keys.evm.privateKey);
  assert.strictEqual(k.evm.address, V.keys.evm.address);
  assert.strictEqual(k.evm.path, V.paths.evm);
  assert.strictEqual(k.solana.secretKey, V.keys.solana.secretKey);
  assert.strictEqual(k.solana.address, V.keys.solana.address);
  assert.strictEqual(k.solana.path, V.paths.solana);
});

test('WIF version bytes are chain-correct (BTC 0x80, LTC 0xb0, DOGE 0x9e)', () => {
  assert.strictEqual(V.keys.bitcoin.wifVersion, 0x80);
  assert.strictEqual(V.keys.litecoin.wifVersion, 0xb0);
  assert.strictEqual(V.keys.dogecoin.wifVersion, 0x9e);
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    assert.strictEqual(Addr.fromWIF(V.keys[c].wif).version, V.keys[c].wifVersion, c);
  }
});

test('coreDump reproduces the exact vector dump text (header + lines)', () => {
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    const text = WX.coreDump(c, V.seedHex, { indices: [V.accountIndex], time: V.dumpTime });
    assert.strictEqual(text, V.coreDumps[c].text, c + ' dump');
    assert.strictEqual(WX.coreDumpFilename(c), V.coreDumps[c].filename, c + ' filename');
    assert.ok(text.startsWith('# Wallet dump'), c + ' has the # Wallet dump header');
  }
});

// ===========================================================================
// 2. WIF ROUND-TRIP — decode back to the SAME key + address
// ===========================================================================
test('each WIF decodes back to the same private key + address', () => {
  const k = WX.privateKeys(V.seedHex, V.accountIndex);
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    const dec = Addr.fromWIF(k[c].wif);
    assert.strictEqual(dec.compressed, true, c + ' WIF is compressed');
    // re-encode -> identical WIF (key preserved)
    assert.strictEqual(Addr.toWIF(dec.privateKey, dec.version, true), k[c].wif, c + ' re-encode');
    // re-derive address from the decoded key
    assert.strictEqual(addressFromWif(c, k[c].wif), k[c].address, c + ' address from WIF');
  }
});

// ===========================================================================
// 3. DUMP INTEGRITY — every dump WIF matches its stated addr=
// ===========================================================================
test('each importwallet dump WIF matches its stated address', () => {
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    const parsed = WX.parseDump(V.coreDumps[c].text);
    assert.ok(parsed.length >= 1, c + ' has >=1 key line');
    for (const row of parsed) {
      assert.ok(row.wif && row.address, c + ' line has WIF + addr');
      assert.strictEqual(addressFromWif(c, row.wif), row.address, c + ' dump WIF -> addr');
      assert.ok(/^m\//.test(row.hdkeypath), c + ' line carries hdkeypath');
    }
  }
});

// ===========================================================================
// 4. SOLANA + EVM key integrity
// ===========================================================================
test('Solana base58 secret decodes to seed||pubkey and matches the address', () => {
  const secret = C.base58decode(V.keys.solana.secretKey);
  assert.strictEqual(secret.length, 64);
  const seedPart = secret.slice(0, 32);
  const pubPart = secret.slice(32);
  const pub = ED.publicKey(seedPart);
  assert.strictEqual(C.bytesToHex(pub), C.bytesToHex(pubPart), 'secret tail === pubkey');
  assert.strictEqual(C.base58encode(pub), V.keys.solana.address, 'pubkey -> address');
});

test('EVM 0x-hex private key re-derives the stated checksummed address', () => {
  const priv = C.hexToBytes(V.keys.evm.privateKey.replace(/^0x/, ''));
  const pub = S.publicKey(priv, true);
  assert.strictEqual(Addr.evmAddress(pub), V.keys.evm.address);
});

// ===========================================================================
// 5. THE SECURITY GATE — blocks while locked / on declined confirm
// ===========================================================================
test('gate blocks export while the vault is LOCKED', async () => {
  let confirmCalled = false;
  const g = await WX.gate({ unlocked: false, confirm: async () => { confirmCalled = true; return true; } });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'locked');
  assert.strictEqual(confirmCalled, false, 'a locked vault never even asks to confirm');
  assert.ok(/DANGER/.test(g.warning));
});

test('gate blocks export on a DECLINED confirm', async () => {
  const g = await WX.gate({ unlocked: true, confirm: async () => false });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'declined');
});

test('gate fails closed with no confirm handler', async () => {
  const g = await WX.gate({ unlocked: true });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'no-confirm-handler');
});

test('gate allows only when unlocked AND confirmed (and shows the danger warning)', async () => {
  let shown = null;
  const g = await WX.gate({ unlocked: true, confirm: async (w) => { shown = w; return true; } });
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.reason, 'confirmed');
  assert.strictEqual(shown, WX.DANGER_WARNING);
});

test('exportSecrets returns NO key material when blocked', async () => {
  const locked = await WX.exportSecrets({ unlocked: false, mnemonic: V.mnemonic, confirm: async () => true });
  assert.strictEqual(locked.ok, false);
  assert.strictEqual(locked.keys, undefined);
  assert.strictEqual(locked.mnemonic, undefined);

  const declined = await WX.exportSecrets({ unlocked: true, mnemonic: V.mnemonic, confirm: async () => false });
  assert.strictEqual(declined.ok, false);
  assert.strictEqual(declined.keys, undefined);
});

test('exportSecrets (unlocked + confirmed) yields the vector keys + dumps', async () => {
  const r = await WX.exportSecrets({
    unlocked: true, confirm: async () => true,
    mnemonic: V.mnemonic, passphrase: V.passphrase,
    index: V.accountIndex, coreDumps: true, indices: [V.accountIndex],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mnemonic.seedHex, V.seedHex);
  assert.strictEqual(r.keys.bitcoin.wif, V.keys.bitcoin.wif);
  assert.strictEqual(r.keys.evm.privateKey, V.keys.evm.privateKey);
  assert.strictEqual(r.keys.solana.secretKey, V.keys.solana.secretKey);
  // dump text differs only by the default time; assert the key line matches addr
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    const rows = WX.parseDump(r.dumps[c].text);
    assert.strictEqual(addressFromWif(c, rows[0].wif), V.keys[c].address, c);
  }
});

// ===========================================================================
// 6. NO SECRET IS LOGGED OR SENT
// ===========================================================================
test('export never logs a secret and never touches the network', async () => {
  const secrets = [V.seedHex, V.mnemonic, V.keys.bitcoin.wif, V.keys.litecoin.wif,
    V.keys.dogecoin.wif, V.keys.evm.privateKey, V.keys.solana.secretKey];
  const logged = [];
  const sent = [];
  const telemetry = [];

  const origLog = console.log, origErr = console.error, origWarn = console.warn, origInfo = console.info;
  const origFetch = global.fetch;
  console.log = console.error = console.warn = console.info = (...a) => { logged.push(a.map(String).join(' ')); };
  global.fetch = (...a) => { sent.push(a.map(String).join(' ')); return Promise.reject(new Error('network blocked in test')); };

  try {
    const r = await WX.exportSecrets({
      unlocked: true,
      confirm: async (w) => { telemetry.push('confirm:' + w); return true; },
      mnemonic: V.mnemonic, passphrase: V.passphrase, coreDumps: true,
    });
    assert.strictEqual(r.ok, true);
  } finally {
    console.log = origLog; console.error = origErr; console.warn = origWarn; console.info = origInfo;
    global.fetch = origFetch;
  }

  const haystack = (logged.join('\n') + '\n' + telemetry.join('\n'));
  for (const s of secrets) {
    assert.ok(!haystack.includes(s), 'a secret leaked into a log/telemetry sink');
  }
  assert.strictEqual(sent.length, 0, 'export made a network call');
  assert.strictEqual(logged.length, 0, 'export wrote to the console');
});
