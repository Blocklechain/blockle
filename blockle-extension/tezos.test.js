// tezos.test.js — Tezos (XTZ) native adapter golden-vector gate.
// Run: node --test tezos.test.js
//
// Independently re-derives the ed25519 key from the BIP39 seed via SLIP-0010
// (m/44'/1729'/0'/0'), reproduces the edpk public key + tz1 address
// (base58check [6,161,159] || blake2b(pub,20)), FORGES a single 'transaction'
// manager operation byte-for-byte, signs ed25519 over blake2b(0x03 || forged, 32),
// and asserts every value in docs/tezos-vectors.json byte-identically (incl. the
// signature VERIFYING + the edsig + the injection payload). Also proves the one
// new primitive (blake2b at 20/32 bytes) + the zarith LEB128 varint + the
// contract-id encoding per address family. No network, no external deps — the
// forge codec (chains/tezos-forge.js) is pure JS.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('./crypto-core.js');
const ED = require('./ed25519.js');
const HD = require('./hd.js');
const TZ = require('./chains/tezos-forge.js');
const TEZOS = require('./chains/tezos.js');
const REG = require('./chains/registry.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'tezos-vectors.json'), 'utf8'));
const h = C.bytesToHex;

test('blake2b KATs (the one new primitive) at 20 + 32 bytes', () => {
  for (const [input, hex, len] of V.blake2bKats) {
    assert.strictEqual(h(C.blake2b(C.utf8(input), len)), hex, `blake2b-${len * 8}("${input}")`);
  }
});

test('zarith (unsigned LEB128) KATs', () => {
  for (const [n, hex] of V.zarithKats) {
    assert.strictEqual(h(TZ.zarith(n)), hex, 'zarith(' + n + ')');
  }
});

test('contract-id encoding per address family (tz1/tz2/tz3/KT1)', () => {
  for (const [addr, hex] of V.destinationKats) {
    assert.strictEqual(h(TZ.contractId(addr)), hex, 'contractId(' + addr + ')');
  }
});

test('key + edpk public key + tz1 address re-derive to the golden vector', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = TEZOS.deriveSlip10(seed, V.path);
  assert.strictEqual(h(node.key), V.expected.seedKeyHex);
  const pub = ED.publicKey(node.key);
  assert.strictEqual(h(pub), V.expected.edpkPubkeyHex);
  assert.strictEqual(TZ.edpk(pub), V.expected.edpk);
  assert.strictEqual(TZ.tz1(pub), V.expected.address);
});

test('tz1 codec: pub -> tz1 + validation', () => {
  for (const [pubHex, addr] of V.addressSpecVectors) {
    assert.strictEqual(TZ.tz1(C.hexToBytes(pubHex)), addr);
    assert.ok(TZ.isTz1(addr));
    assert.ok(TZ.isTezosDestination(addr));
  }
  // destinations: accept tz1/tz2/tz3/KT1
  for (const [addr] of V.destinationKats) assert.ok(TZ.isTezosDestination(addr));
  // rejects non-Tezos addresses
  assert.ok(!TZ.isTz1('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!TZ.isTezosDestination('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX'));
  assert.ok(!TZ.isTezosDestination('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3'));
  const a = V.expected.address;
  const bad = a.slice(0, -1) + (a.slice(-1) === 'a' ? 'b' : 'a');
  assert.ok(!TZ.isTz1(bad)); // corrupted checksum
});

test("native send: client-forged 'transaction' op is byte-exact + signs + verifies", () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const key = TEZOS.deriveSlip10(seed, V.path).key;
  const pub = ED.publicKey(key);
  const built = TEZOS.buildSignedTransaction(V.tx.fields, key);
  assert.strictEqual(built.forgedHex, V.tx.expected.forgedHex, 'forged bytes');
  assert.strictEqual(built.signingHashHex, V.tx.expected.signingHashHex, 'signing hash blake2b(0x03||forged,32)');
  assert.strictEqual(built.signatureHex, V.tx.expected.signatureHex, 'ed25519 signature');
  assert.strictEqual(built.edsig, V.tx.expected.edsig, 'edsig base58');
  assert.strictEqual(built.injectionHex, V.tx.expected.injectionHex, 'injection payload (forged+sig)');
  assert.ok(ED.verify(C.hexToBytes(built.signingHashHex), built.signature, pub), 'signature verifies');
});

test('adapter buildSend validates the destination + is client-signed (needsSign:false)', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const a = TEZOS.createTezosAdapter({});
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  assert.strictEqual(acct.address, V.expected.address);
  assert.strictEqual(acct.scheme, 'ed25519');
  assert.strictEqual(acct.edpk, V.expected.edpk);
  await assert.rejects(a.buildSend(acct, { to: 'not-a-tezos-address', amount: '1' }), /invalid destination/);
  assert.strictEqual(a.explorerTx('o123'), 'https://tzkt.io/o123');
});

test('adapter buildSend forges byte-exact with injected branch + counter (offline)', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  // Fake node: head hash + counter from the vector; counter read is (vector.counter - 1)
  // so buildSend's (+1) reproduces the vector's counter.
  const counterMinus1 = (BigInt(V.tx.fields.counter) - 1n).toString();
  const a = TEZOS.createTezosAdapter({
    httpGet: async (url) => {
      if (url.endsWith('/hash')) return '"' + V.tx.fields.branch + '"';
      if (url.endsWith('/counter')) return '"' + counterMinus1 + '"';
      if (url.endsWith('/balance')) return '"5000000"';
      throw new Error('unexpected GET ' + url);
    },
    httpPost: async () => '"ooGoldenInjectedOpHash"',
  });
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  const built = await a.buildSend(acct, {
    to: V.tx.fields.destination, amount: V.tx.fields.amount,
    fee: V.tx.fields.fee, gasLimit: V.tx.fields.gas_limit, storageLimit: V.tx.fields.storage_limit,
  });
  assert.strictEqual(built.needsSign, false);
  assert.strictEqual(built.raw, V.tx.expected.injectionHex, 'adapter injection hex matches golden');
  assert.strictEqual(built.summary.edsig, V.tx.expected.edsig);
  const bc = await a.broadcast(built);
  assert.strictEqual(bc.txid, 'ooGoldenInjectedOpHash');
  assert.ok(bc.accepted);
  const bal = await a.getBalance(acct.address);
  assert.strictEqual(bal[0].display, '5');
});

test('registry: Tezos adapter registered, enabled, endpoint', async () => {
  const reg = REG.createRegistry({});
  assert.ok(reg.has('tezos'));
  assert.ok(reg.enabled().includes('tezos'));
  assert.strictEqual(reg.endpoints('tezos').rpc, 'https://mainnet.api.tez.ie');
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const acct = await reg.get('tezos').deriveAccount({ seed });
  assert.strictEqual(acct.scheme, 'ed25519');
  assert.strictEqual(acct.address, V.expected.address);
});
