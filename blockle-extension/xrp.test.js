// xrp.test.js — XRP Ledger native adapter golden-vector gate.
// Run: node --test xrp.test.js
//
// Independently re-derives the secp256k1 key from the BIP39 seed (BIP44
// m/44'/144'/0'/0/0), reproduces the classic 'r…' address (RIPEMD160(SHA256(pub))
// -> ripple-base58check), CLIENT-BUILDS the XRPL-binary-codec Payment, signs the
// SHA512-half of ('STX\0' || tx-without-sig) with the existing secp256k1 signer
// (canonical low-S DER), re-serializes the signed tx_blob, and asserts every
// value in docs/xrp-vectors.json byte-identically (incl. the signature VERIFYING).
// No network, no external deps — the codec (chains/xrpl-codec.js) is pure JS.
// The vectors were cross-checked BYTE-IDENTICAL against ripple-keypairs +
// ripple-binary-codec when generated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('./crypto-core.js');
const S = require('./secp256k1.js');
const HD = require('./hd.js');
const XC = require('./chains/xrpl-codec.js');
const XRP = require('./chains/xrp.js');
const REG = require('./chains/registry.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'xrp-vectors.json'), 'utf8'));
const h = C.bytesToHex;

test('key + address re-derive to the golden vector', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = HD.derivePath(seed, V.path);
  assert.strictEqual(h(node.privateKey), V.expected.privKeyHex);
  assert.strictEqual(h(node.publicKey), V.expected.pubkeyHexCompressed); // 33B compressed
  assert.strictEqual(h(XC.accountIdFromPubkey(node.publicKey)), V.expected.accountIdHex);
  assert.strictEqual(XC.classicAddress(node.publicKey), V.expected.classicAddress);
});

test('address codec: accountId <-> r… + validation', () => {
  for (const [idHex, addr] of V.addressSpecVectors) {
    assert.strictEqual(XC.addressFromAccountId(C.hexToBytes(idHex)), addr);
    assert.strictEqual(h(XC.accountIdFromAddress(addr)), idHex);
    assert.ok(XC.isXrpAddress(addr));
  }
  assert.ok(!XC.isXrpAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!XC.isXrpAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'));
  assert.ok(!XC.isXrpAddress('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX'));
  const a = V.expected.classicAddress;
  const bad = a.slice(0, -1) + (a.slice(-1) === 'a' ? 'b' : 'a');
  assert.ok(!XC.isXrpAddress(bad));
});

function checkTx(vec, label) {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = HD.derivePath(seed, V.path);
  const fields = XC.buildPaymentFields(
    vec.fields.Account, vec.fields.Destination, vec.fields.Amount, vec.fields.Fee,
    vec.fields.Sequence, vec.fields.LastLedgerSequence, vec.fields.SigningPubKey,
    { flags: vec.fields.Flags, destinationTag: vec.fields.DestinationTag });
  assert.strictEqual(h(XC.signingData(fields)), vec.signingDataHex, label + ' signing data');
  const built = XC.buildSignedPayment(fields, node.privateKey);
  assert.strictEqual(built.txnSignatureDerHex, vec.expected.txnSignatureDerHex, label + ' DER');
  assert.strictEqual(built.txBlobHex, vec.expected.txBlobHex, label + ' signed tx_blob');
  assert.strictEqual(built.hash, vec.expected.hash, label + ' txid');
  // signature VERIFIES against the pubkey over the SHA512-half signing hash
  const { r, s } = derDecode(C.hexToBytes(built.txnSignatureDerHex));
  assert.ok(S.verify(XC.signingHash(fields), { r, s }, node.publicKey), label + ' secp256k1 verifies');
  assert.ok(vec.expected.verifies);
}

// Minimal DER (SEQ(INT r, INT s)) decoder for the verify step.
function derDecode(der) {
  let i = 2;
  assert.strictEqual(der[0], 0x30);
  assert.strictEqual(der[i], 0x02); const rl = der[i + 1]; i += 2;
  const r = S.bytesToBig(der.slice(i, i + rl)); i += rl;
  assert.strictEqual(der[i], 0x02); const sl = der[i + 1]; i += 2;
  const s = S.bytesToBig(der.slice(i, i + sl));
  return { r, s };
}

test('native XRP Payment: signing data + signed blob + txid byte-exact + verifies', () => checkTx(V.tx, 'payment'));
test('XRP Payment with DestinationTag: byte-exact + verifies', () => checkTx(V.txWithTag, 'payment+tag'));

test('amount + field codec invariants', () => {
  const amt = XC.serialize({ Amount: '1000000' }, false);
  assert.strictEqual(h(amt), '6140000000000f4240'); // 0x61 header + XRP amount
  const fee = XC.serialize({ Fee: '10' }, false);
  assert.strictEqual(h(fee), '68400000000000000a');
});

test('adapter buildSend validates the destination + is client-signed (needsSign:false)', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const a = XRP.createXrpAdapter({});
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  assert.strictEqual(acct.address, V.expected.classicAddress);
  await assert.rejects(a.buildSend(acct, { to: 'not-an-xrp-address', amount: '1' }), /invalid destination/);
  assert.strictEqual(a.explorerTx(V.tx.expected.hash), 'https://xrpscan.com/tx/' + V.tx.expected.hash);
});

test('registry: XRP adapter registered, enabled, endpoint', async () => {
  const reg = REG.createRegistry({});
  assert.ok(reg.has('xrp'));
  assert.ok(reg.enabled().includes('xrp'));
  assert.strictEqual(reg.endpoints('xrp').rpc, 'https://xrplcluster.com');
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const acct = await reg.get('xrp').deriveAccount({ seed });
  assert.strictEqual(acct.scheme, 'secp256k1');
  assert.strictEqual(acct.address, V.expected.classicAddress);
});
