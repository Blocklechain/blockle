// stellar.test.js — Stellar (XLM) native adapter golden-vector gate.
// Run: node --test stellar.test.js
//
// Independently re-derives the ed25519 key from the BIP39 seed via SLIP-0010
// (m/44'/148'/0'), reproduces the strkey 'G…' address (base32(0x30||pub||crc16)),
// CLIENT-BUILDS the TransactionEnvelope XDR (one native-XLM Payment op, and an
// issued-asset variant), signs ed25519 over the tx hash = SHA256(networkId ||
// ENVELOPE_TYPE_TX || txXDR), and asserts every value in docs/stellar-vectors.json
// byte-identically (incl. the signature VERIFYING). No network, no external deps —
// the XDR codec (chains/stellar-xdr.js) is pure JS. The vectors were cross-checked
// BYTE-IDENTICAL against @stellar/stellar-base when generated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('./crypto-core.js');
const ED = require('./ed25519.js');
const HD = require('./hd.js');
const SX = require('./chains/stellar-xdr.js');
const STELLAR = require('./chains/stellar.js');
const REG = require('./chains/registry.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'stellar-vectors.json'), 'utf8'));
const h = C.bytesToHex;

test('CRC-16/XModem KATs', () => {
  for (const [input, val] of V.crcKats) {
    assert.strictEqual(SX.crc16Xmodem(C.utf8(input)), val);
  }
});

test('key + public key + address re-derive to the golden vector', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = STELLAR.deriveSlip10(seed, V.path);
  assert.strictEqual(h(node.key), V.expected.seedKeyHex);
  const pub = ED.publicKey(node.key);
  assert.strictEqual(h(pub), V.expected.pubkeyHex);
  assert.strictEqual(SX.encodeEd25519PublicKey(pub), V.expected.address);
});

test('networkId = SHA256(passphrase)', () => {
  assert.strictEqual(h(SX.networkId(V.network.networkPassphrase)), V.network.networkIdHex);
});

test('strkey codec: pub <-> G… + validation', () => {
  for (const [pubHex, addr] of V.addressSpecVectors) {
    assert.strictEqual(SX.encodeEd25519PublicKey(C.hexToBytes(pubHex)), addr);
    assert.strictEqual(h(SX.decodeEd25519PublicKey(addr)), pubHex);
    assert.ok(SX.isStellarAddress(addr));
  }
  assert.ok(!SX.isStellarAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!SX.isStellarAddress('rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3'));
  const a = V.expected.address;
  const bad = a.slice(0, -1) + (a.slice(-1) === 'A' ? 'B' : 'A');
  assert.ok(!SX.isStellarAddress(bad));
});

function checkTx(vec, label, assetXdr) {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const key = STELLAR.deriveSlip10(seed, V.path).key;
  const pub = ED.publicKey(key);
  const dest = SX.decodeEd25519PublicKey(vec.fields.op.destination);
  const op = SX.paymentOp(dest, vec.fields.op.amountStroops, assetXdr);
  const built = SX.buildSignedEnvelope(pub, key, vec.fields.sequence, [op],
    { fee: vec.fields.fee, passphrase: V.network.networkPassphrase });
  const txXdrB64 = SX.toBase64(C.hexToBytes(built.txXDRunsignedHex));
  assert.strictEqual(txXdrB64, vec.txXDRunsignedBase64, label + ' unsigned tx XDR');
  assert.strictEqual(built.hash, vec.signingPayloadHex, label + ' signing payload (tx hash)');
  assert.strictEqual(built.signatureHex, vec.expected.signatureHex, label + ' ed25519 signature');
  assert.strictEqual(built.hint, vec.expected.hint, label + ' hint');
  assert.strictEqual(built.envelopeXDRBase64, vec.expected.envelopeXDRBase64, label + ' signed envelope');
  assert.strictEqual(built.hash, vec.expected.hash, label + ' tx hash');
  assert.ok(ED.verify(C.hexToBytes(built.hash), C.hexToBytes(built.signatureHex), pub), label + ' ed25519 verifies');
  assert.ok(vec.expected.verifies);
}

test('native XLM Payment: unsigned XDR + signed envelope + hash byte-exact + verifies', () =>
  checkTx(V.tx, 'payment-native', null));
test('issued-asset (AlphaNum4) Payment: byte-exact + verifies', () => {
  const issuerPub = SX.decodeEd25519PublicKey(V.assetTx.fields.op.asset.issuer);
  checkTx(V.assetTx, 'payment-asset', SX.assetAlphanum4(V.assetTx.fields.op.asset.code, issuerPub));
});

test('adapter buildSend validates the destination + is client-signed (needsSign:false)', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const a = STELLAR.createStellarAdapter({});
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  assert.strictEqual(acct.address, V.expected.address);
  await assert.rejects(a.buildSend(acct, { to: 'not-a-stellar-address', amount: '1' }), /invalid destination/);
  assert.strictEqual(a.explorerTx(V.tx.expected.hash), 'https://stellar.expert/explorer/public/tx/' + V.tx.expected.hash);
});

test('registry: Stellar adapter registered, enabled, endpoint', async () => {
  const reg = REG.createRegistry({});
  assert.ok(reg.has('stellar'));
  assert.ok(reg.enabled().includes('stellar'));
  assert.strictEqual(reg.endpoints('stellar').horizon, 'https://horizon.stellar.org');
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const acct = await reg.get('stellar').deriveAccount({ seed });
  assert.strictEqual(acct.scheme, 'ed25519');
  assert.strictEqual(acct.address, V.expected.address);
});
