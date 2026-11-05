// ton.test.js — TON (native + USDT jetton) native adapter golden-vector gate.
// Run: node --test ton.test.js
//
// Independently re-derives the ed25519 key from the BIP39 seed via SLIP-0010
// (m/44'/607'/0'), rebuilds the v4R2 StateInit cell (code+data), reproduces the
// bounceable base64url address, and CLIENT-BUILDS the signed external-message BOC
// (native + jetton), asserting every value in docs/ton-vectors.json byte-
// identically (incl. the full BOC base64 + ed25519 verify over the signing-cell
// hash). No network, no external deps — the cell/BOC engine is pure JS.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('./crypto-core.js');
const ED = require('./ed25519.js');
const HD = require('./hd.js');
const TC = require('./chains/ton-cell.js');
const TON = require('./chains/ton.js');
const REG = require('./chains/registry.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'ton-vectors.json'), 'utf8'));
const h = C.bytesToHex;
const SUB = V.network.subwalletId;

test('CRC KATs (crc16-ccitt + crc32c)', () => {
  for (const [input, hex] of V.crcKats.crc16ccitt) {
    assert.strictEqual('0x' + h(TC.crc16Ccitt(C.utf8(input))), hex);
  }
  for (const [input, hex] of V.crcKats.crc32c) {
    // vector pins the logical crc value (big-endian); our bytes are little-endian
    const le = h(TC.crc32c(C.utf8(input)));
    const be = le.match(/../g).reverse().join('');
    assert.strictEqual('0x' + be, hex);
  }
});

test('key + public key re-derive to the golden vector', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = TON.deriveSlip10(seed, V.path);
  assert.strictEqual(h(node.key), V.key.ed25519Seed32Hex);
  assert.strictEqual(h(ED.publicKey(node.key)), V.key.publicKeyHex);
});

test('v4R2 code/data/StateInit cell hashes', () => {
  const pub = C.hexToBytes(V.key.publicKeyHex);
  assert.strictEqual(TC.V4R2_CODE_B64, V.v4r2.codeBocBase64);
  assert.strictEqual(h(TC.v4r2CodeCell().hash()), V.v4r2.codeCellHashHex);
  assert.strictEqual(h(TC.v4r2DataCell(pub, SUB).hash()), V.v4r2.dataCellHashHex);
  assert.strictEqual(h(TC.v4r2StateInit(pub, SUB).hash()), V.v4r2.stateInitCellHashHex);
});

test('friendly + raw address encoding (all tags)', () => {
  const hash = C.hexToBytes(V.v4r2.stateInitCellHashHex);
  assert.strictEqual(TC.formatAddress(0, hash, {}), V.v4r2.addressBounceable);
  assert.strictEqual(TC.formatAddress(0, hash, { bounceable: false }), V.v4r2.addressNonBounceable);
  assert.strictEqual(TC.formatAddress(0, hash, { testOnly: true }), V.v4r2.addressTestnet);
  assert.strictEqual(TC.rawAddress(0, hash), V.v4r2.rawAddress);
});

test('address codec round-trips (raw <-> friendly) + validation', () => {
  for (const [raw, friendly] of V.addressSpecVectors) {
    const pf = TC.parseAddress(friendly);
    assert.strictEqual(TC.rawAddress(pf.workchain, pf.hash), raw);
    const pr = TC.parseAddress(raw);
    assert.strictEqual(TC.formatAddress(pr.workchain, pr.hash, {}), friendly);
    assert.ok(TC.isTonAddress(friendly));
    assert.ok(TC.isTonAddress(raw));
  }
  // rejects non-TON addresses
  assert.ok(!TC.isTonAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
  assert.ok(!TC.isTonAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!TC.isTonAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'));
});

test('native send: client-built signed external message is byte-exact', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const key = TON.deriveSlip10(seed, V.path).key;
  const pub = ED.publicKey(key);
  const dest = TC.parseAddress(V.tx.dest);
  const built = TON.buildNativeExternal({
    pubKey: pub, seedKey: key, dest, amount: V.tx.amount,
    comment: V.tx.comment, bounce: V.tx.bounce, seqno: V.tx.seqno,
    validUntil: V.tx.validUntil, subwalletId: SUB,
  });
  assert.strictEqual(h(built.internalMsg.hash()), V.tx.intMsgCellHashHex);
  assert.strictEqual(h(built.signingCell.hash()), V.tx.signingCellHashHex);
  assert.strictEqual(h(built.signature), V.tx.expected.signatureHex);
  assert.ok(ED.verify(built.signingCell.hash(), built.signature, pub));
  assert.strictEqual(built.boc, V.tx.expected.externalMessageBocBase64);
  assert.strictEqual(built.hash, V.tx.expected.externalMessageBocHashHex);
});

test('jetton (USDT) send: transfer body op + signed external message byte-exact', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const key = TON.deriveSlip10(seed, V.path).key;
  const pub = ED.publicKey(key);
  const jw = TC.parseAddress(V.jettonTx.ownerJettonWallet);
  const dest = TC.parseAddress(V.jettonTx.dest);
  const resp = TC.parseAddress(V.jettonTx.responseDest);
  const built = TON.buildJettonExternal({
    pubKey: pub, seedKey: key, jettonWallet: jw, dest, response: resp,
    amount: V.jettonTx.amount, fwdAmount: V.jettonTx.fwdAmount, gas: V.jettonTx.gasAmount,
    seqno: V.jettonTx.seqno, validUntil: V.jettonTx.validUntil, subwalletId: SUB,
  });
  assert.strictEqual('0x' + TON.JETTON_TRANSFER_OP.toString(16).padStart(8, '0'), V.jettonTx.op);
  assert.strictEqual(h(built.jettonBody.hash()), V.jettonTx.jettonBodyCellHashHex);
  assert.strictEqual(h(built.internalMsg.hash()), V.jettonTx.intMsgCellHashHex);
  assert.strictEqual(h(built.signingCell.hash()), V.jettonTx.signingCellHashHex);
  assert.strictEqual(h(built.signature), V.jettonTx.expected.signatureHex);
  assert.ok(ED.verify(built.signingCell.hash(), built.signature, pub));
  assert.strictEqual(built.boc, V.jettonTx.expected.externalMessageBocBase64);
  assert.strictEqual(built.hash, V.jettonTx.expected.externalMessageBocHashHex);
});

test('registry: TON adapter registered, enabled, endpoint + USDT jetton', async () => {
  const reg = REG.createRegistry({});
  assert.ok(reg.has('ton'));
  assert.ok(reg.enabled().includes('ton'));
  assert.strictEqual(reg.endpoints('ton').api, 'https://toncenter.com/api/v2');
  assert.ok(reg.tokensFor('ton').some((t) => t.kind === 'jetton' && t.symbol === 'USDT'
    && t.master === V.network.jettonMasters.USDT));
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const acct = await reg.get('ton').deriveAccount({ seed });
  assert.strictEqual(acct.scheme, 'ed25519');
  assert.strictEqual(acct.address, V.v4r2.addressBounceable);
});
