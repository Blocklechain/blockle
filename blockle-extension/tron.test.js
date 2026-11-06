// tron.test.js — Tron (TRX + USDT-TRC20) native adapter golden-vector gate.
// Run: node --test tron.test.js
//
// Independently re-derives the key from the BIP39 seed, reproduces the 'T…'
// address (secp256k1 -> 0x41 -> base58check), recomputes txID = sha256(
// raw_data_hex), signs ONLY that txID -> 65B [r||s||v], and verifies the
// signature RECOVERS to the owner pubkey. Asserts every value in
// docs/tron-vectors.json byte-identically. No network, no external deps.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('./crypto-core.js');
const S = require('./secp256k1.js');
const HD = require('./hd.js');
const Addr = require('./address.js');
const TRON = require('./chains/tron.js');
const REG = require('./chains/registry.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'tron-vectors.json'), 'utf8'));
const h = C.bytesToHex;

test('key + address re-derive to the golden vector', () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = HD.derivePath(seed, V.path);
  assert.strictEqual(h(node.privateKey), V.expected.privKeyHex);
  const pub = S.publicKey(node.privateKey, false);
  assert.strictEqual(h(pub), V.expected.pubkeyHexUncompressed);
  const hash20 = C.keccak256(pub.slice(1)).slice(-20);
  assert.strictEqual(h(hash20), V.expected.ethStyleHash20);
  assert.strictEqual('41' + h(hash20), V.expected.addressHex);
  assert.strictEqual(Addr.tronAddress(node.publicKey), V.expected.base58Address);
  // the EVM keccak body is identical; only the prefix + encoding differ
  assert.strictEqual(h(hash20), Addr.evmAddress(node.publicKey).slice(2).toLowerCase());
});

test('address codec: both-ways hex <-> base58 + validation', () => {
  for (const [hex, b58] of V.addressSpecVectors) {
    assert.strictEqual(Addr.tronHexToBase58(hex), b58);
    assert.strictEqual(Addr.tronAddressToHex(b58), hex);
    assert.ok(Addr.isTronAddress(b58));
    assert.ok(Addr.isTronAddress(hex));
    assert.ok(Addr.isTronAddress('0x' + hex));
  }
  assert.ok(!Addr.isTronAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!Addr.isTronAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
  // a corrupted checksum must fail
  const bad = V.expected.base58Address.slice(0, -1) + (V.expected.base58Address.slice(-1) === 'a' ? 'b' : 'a');
  assert.ok(!Addr.isTronAddress(bad));
});

function checkTx(vec, label) {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const node = HD.derivePath(seed, V.path);
  const pub = S.publicKey(node.privateKey, false);
  // (1) txID == sha256(raw_data_hex) — recomputed, not trusted
  const txId = h(C.sha256(C.hexToBytes(vec.rawDataHex)));
  assert.strictEqual(txId, vec.expected.txID, label + ' txID == sha256(raw_data_hex)');
  // (2) the adapter's verifyTxId accepts the matching id and REJECTS a tampered one
  assert.strictEqual(TRON.verifyTxId(vec.rawDataHex, vec.expected.txID), txId);
  assert.throws(() => TRON.verifyTxId(vec.rawDataHex, '00'.repeat(32)), /refusing to sign/);
  // (3) sign the txID -> deterministic 65B [r||s||v]
  const sig65 = TRON.signTxId(txId, node.privateKey);
  assert.strictEqual(h(sig65), vec.expected.signatureHex, label + ' signature 65B [r||s||v]');
  assert.strictEqual(sig65.length, 65);
  // (4) the signature VERIFIES and RECOVERS to the owner pubkey (independent)
  const r = S.bytesToBig(sig65.slice(0, 32));
  const s = S.bytesToBig(sig65.slice(32, 64));
  const v = sig65[64];
  assert.ok(S.verify(C.hexToBytes(txId), { r, s }, pub), label + ' ECDSA verifies');
  assert.strictEqual(h(S.recover(C.hexToBytes(txId), r, s, v, false)), h(pub), label + ' recovers owner');
  assert.ok(vec.expected.verifies);
}

test('native TRX transfer: txID + 65B signature golden + recover', () => checkTx(V.tx, 'native'));
test('TRC-20 USDT transfer: txID + 65B signature golden + recover', () => checkTx(V.trc20Tx, 'trc20'));

test('TRC-20 ABI parameter = 32B to ++ 32B amount', () => {
  const p = TRON.trc20TransferParam(V.trc20Tx.to, V.trc20Tx.amount);
  assert.strictEqual(p, V.trc20Tx.parameterHex);
  assert.strictEqual(p.length, 128); // two 32-byte words
  // the first word's low 20 bytes are the recipient's keccak body (no 0x41)
  assert.strictEqual(p.slice(24, 64), Addr.tronAddressToHex(V.trc20Tx.to).slice(2));
});

test('signTx re-verifies txID before signing and attaches signature[]', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const a = TRON.createTronAdapter({});
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  assert.strictEqual(acct.address, V.expected.base58Address);
  assert.strictEqual(acct.path, V.path);
  const unsigned = { raw_data_hex: V.tx.rawDataHex, txID: V.tx.expected.txID, raw_data: {} };
  const intent = { owner: V.expected.base58Address, to: V.tx.to, amount: V.tx.amount };
  const signed = await a.signTx(acct, { unsigned, raw_data_hex: unsigned.raw_data_hex, txID: unsigned.txID, assert: intent });
  assert.strictEqual(signed.signature, V.tx.expected.signatureHex);
  assert.ok(Array.isArray(signed.signed.signature) && signed.signed.signature[0] === V.tx.expected.signatureHex);
  // tampered raw_data_hex must be rejected (malicious-node guard)
  await assert.rejects(a.signTx(acct, { unsigned: { raw_data_hex: V.tx.rawDataHex + '00', txID: V.tx.expected.txID } }), /refusing to sign/);
  assert.strictEqual(a.explorerTx(V.tx.expected.txID), 'https://tronscan.org/#/transaction/' + V.tx.expected.txID);
});

// ---------------------------------------------------------------------------
// FUND SAFETY: the node-untrusted raw_data DECODE + ASSERT guard. A matching
// txID == sha256(raw_data_hex) proves NOTHING about who the payload pays; the
// client must decode the protobuf and assert it is exactly the transfer we
// asked for, and REFUSE to sign otherwise.
// ---------------------------------------------------------------------------
test('decode: recovers the exact transfer from the signed native + TRC-20 bytes', () => {
  const dn = TRON.decodeRawData(V.tx.rawDataHex);
  assert.strictEqual(dn.type, TRON.TRON_TRANSFER_CONTRACT);
  assert.strictEqual(dn.owner, V.expected.addressHex);
  assert.strictEqual(dn.to, Addr.tronAddressToHex(V.tx.to));
  assert.strictEqual(dn.amount.toString(), V.tx.amount);

  const dt = TRON.decodeRawData(V.trc20Tx.rawDataHex);
  assert.strictEqual(dt.type, TRON.TRON_TRIGGER_SMART_CONTRACT);
  assert.strictEqual(dt.owner, V.expected.addressHex);
  assert.strictEqual(dt.contract, Addr.tronAddressToHex(V.trc20Tx.contract));
  assert.strictEqual(dt.callValue.toString(), '0');
  assert.strictEqual(dt.data, TRON.TRC20_SELECTOR + V.trc20Tx.parameterHex);
});

test('assertRawDataMatches ACCEPTS the correct node payload (native + TRC-20)', () => {
  assert.doesNotThrow(() => TRON.assertRawDataMatches(V.tx.rawDataHex,
    { owner: V.expected.base58Address, to: V.tx.to, amount: V.tx.amount }));
  assert.doesNotThrow(() => TRON.assertRawDataMatches(V.trc20Tx.rawDataHex,
    { owner: V.expected.base58Address, to: V.trc20Tx.to, amount: V.trc20Tx.amount,
      asset: { kind: 'trc20', address: V.trc20Tx.contract } }));
});

test('decode+assert REJECTS a tampered node payload — NO signature produced', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const a = TRON.createTronAdapter({});
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  const attacker = '41e552f6487585c2b58bc2c9bb4492bc1f17132cd0'; // TWsm8… body

  // (a) NATIVE recipient swapped to the attacker; txID recomputed so the
  //     sha256 guard PASSES — only the decode+assert can catch this.
  const swapTo = V.tx.rawDataHex.replace(Addr.tronAddressToHex(V.tx.to), attacker);
  assert.notStrictEqual(swapTo, V.tx.rawDataHex);
  const swapToTxId = h(C.sha256(C.hexToBytes(swapTo)));
  assert.strictEqual(swapToTxId, h(C.sha256(C.hexToBytes(swapTo)))); // self-consistent id
  const intent = { owner: V.expected.base58Address, to: V.tx.to, amount: V.tx.amount };
  assert.throws(() => TRON.assertRawDataMatches(swapTo, intent), /recipient mismatch/);
  await assert.rejects(a.signTx(acct, { raw_data_hex: swapTo, txID: swapToTxId, assert: intent }), /refusing to sign/);

  // (b) NATIVE amount inflated 1 TRX -> 2 TRX (same-width 3-byte varint).
  const infl = V.tx.rawDataHex.replace('18c0843d', '1880897a');
  assert.notStrictEqual(infl, V.tx.rawDataHex);
  const inflTxId = h(C.sha256(C.hexToBytes(infl)));
  assert.strictEqual(TRON.decodeRawData(infl).amount.toString(), '2000000');
  assert.throws(() => TRON.assertRawDataMatches(infl, intent), /amount mismatch/);
  await assert.rejects(a.signTx(acct, { raw_data_hex: infl, txID: inflTxId, assert: intent }), /refusing to sign/);

  // (c) TRC-20 calldata recipient swapped to the attacker (ABI word, no 0x41).
  const t20intent = { owner: V.expected.base58Address, to: V.trc20Tx.to, amount: V.trc20Tx.amount,
    asset: { kind: 'trc20', address: V.trc20Tx.contract } };
  const swapData = V.trc20Tx.rawDataHex.replace(
    '0000000000000000000000005cd0fb0ab3ce40f3051414c604b27756e69e43db',
    '000000000000000000000000e552f6487585c2b58bc2c9bb4492bc1f17132cd0');
  assert.notStrictEqual(swapData, V.trc20Tx.rawDataHex);
  const swapDataTxId = h(C.sha256(C.hexToBytes(swapData)));
  assert.throws(() => TRON.assertRawDataMatches(swapData, t20intent), /transfer args mismatch/);
  await assert.rejects(a.signTx(acct, { raw_data_hex: swapData, txID: swapDataTxId, assert: t20intent }), /refusing to sign/);

  // (d) even WITHOUT build-time intent, signTx refuses a payload whose decoded
  //     owner is not the signing account (here the owner field is the attacker).
  const swapOwner = V.tx.rawDataHex.replace('0a1541c8599111f29c1e1e061265b4af93ea1f274ad78a', '0a1541e552f6487585c2b58bc2c9bb4492bc1f17132cd0');
  assert.notStrictEqual(swapOwner, V.tx.rawDataHex);
  const swapOwnerTxId = h(C.sha256(C.hexToBytes(swapOwner)));
  await assert.rejects(a.signTx(acct, { raw_data_hex: swapOwner, txID: swapOwnerTxId }), /refusing to sign/);
});

// ---------------------------------------------------------------------------
// HARDENING A1 — DUPLICATE / UNEXPECTED FIELDS. The protobuf decoder takes the
// first occurrence per field, so a malicious node could append a DUPLICATE
// scalar (e.g. a 2nd amount) that last-wins merge semantics elsewhere would
// read differently. Only the exact canonical encoding is signable, so the
// decoder REJECTS any level that repeats a field number (raw / Contract / Any /
// inner-contract) — tested here by building a TransferContract with a 2nd
// `amount` (inner level) and by appending a 2nd `contract` (raw level).
// ---------------------------------------------------------------------------
test('decode REJECTS a duplicate field (2nd amount, inner level)', () => {
  // tiny protobuf encoder (varint + length-delimited) — test-only
  const vbytes = (n) => { n = BigInt(n); const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; o.push(b); } while (n > 0n); return o; };
  const f2 = (fn, bytes) => [(fn << 3) | 2, ...vbytes(bytes.length), ...bytes];
  const fv = (fn, v) => [(fn << 3) | 0, ...vbytes(v)];
  const owner = [...C.hexToBytes(V.expected.addressHex)];        // 41 + 20B
  const to = [...C.hexToBytes(Addr.tronAddressToHex(V.tx.to))];
  // TransferContract value with a DUPLICATE field 3 (amount)
  const val = [...f2(1, owner), ...f2(2, to), ...fv(3, 1000000), ...fv(3, 2000000)];
  const anyMsg = [...f2(1, [...C.utf8('type.googleapis.com/protocol.TransferContract')]), ...f2(2, val)];
  const contract = [...fv(1, TRON.TRON_TRANSFER_CONTRACT), ...f2(2, anyMsg)];
  const raw = [...f2(11, contract)];
  const rawHex = C.bytesToHex(Uint8Array.from(raw));
  assert.throws(() => TRON.decodeRawData(rawHex), /duplicate field 3 in contract-value/);
  assert.throws(() => TRON.assertRawDataMatches(rawHex,
    { owner: V.expected.base58Address, to: V.tx.to, amount: V.tx.amount }), /duplicate field/);
});

test('decode REJECTS a duplicate contract (2nd contract, raw level)', () => {
  const vbytes = (n) => { n = BigInt(n); const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; o.push(b); } while (n > 0n); return o; };
  const f2 = (fn, bytes) => [(fn << 3) | 2, ...vbytes(bytes.length), ...bytes];
  const fv = (fn, v) => [(fn << 3) | 0, ...vbytes(v)];
  const owner = [...C.hexToBytes(V.expected.addressHex)];
  const to = [...C.hexToBytes(Addr.tronAddressToHex(V.tx.to))];
  const val = [...f2(1, owner), ...f2(2, to), ...fv(3, 1000000)];
  const anyMsg = [...f2(1, [...C.utf8('type.googleapis.com/protocol.TransferContract')]), ...f2(2, val)];
  const contract = [...fv(1, TRON.TRON_TRANSFER_CONTRACT), ...f2(2, anyMsg)];
  // ONE contract decodes fine; TWO field-11 contracts at the raw level is rejected.
  const okRaw = C.bytesToHex(Uint8Array.from([...f2(11, contract)]));
  assert.strictEqual(TRON.decodeRawData(okRaw).type, TRON.TRON_TRANSFER_CONTRACT);
  const dupRaw = C.bytesToHex(Uint8Array.from([...f2(11, contract), ...f2(11, contract)]));
  assert.throws(() => TRON.decodeRawData(dupRaw), /duplicate field 11 in raw_data/);
});

// ---------------------------------------------------------------------------
// HARDENING A2 — MANDATORY INTENT. signTx REFUSES to sign a sign-ready payload
// that carries no locally-built intent; it never falls back to the
// txID==sha256 integrity check (or a bare owner check) alone.
// ---------------------------------------------------------------------------
test('signTx THROWS when the sign-ready payload carries no intent', async () => {
  const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
  const a = TRON.createTronAdapter({});
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  // no `assert` intent and no `unsigned.assert` -> refused outright
  await assert.rejects(
    a.signTx(acct, { raw_data_hex: V.tx.rawDataHex, txID: V.tx.expected.txID }),
    /missing transfer intent.*refusing to sign/);
  // a partial intent (missing amount) is also refused
  await assert.rejects(
    a.signTx(acct, { raw_data_hex: V.tx.rawDataHex, txID: V.tx.expected.txID,
      assert: { owner: V.expected.base58Address, to: V.tx.to } }),
    /missing transfer intent.*refusing to sign/);
});

test('registry registers + enables tron with TronGrid default + USDT token', () => {
  const reg = REG.createRegistry({});
  assert.ok(reg.has('tron'));
  assert.ok(reg.enabled().includes('tron'));
  assert.strictEqual(reg.endpoints('tron').api, 'https://api.trongrid.io');
  const usdt = reg.tokensFor('tron').find((t) => t.symbol === 'USDT');
  assert.ok(usdt && usdt.kind === 'trc20' && usdt.decimals === 6);
  assert.strictEqual(usdt.address, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
});
