// tron.test.js — Tron golden-vector gate for the WEB WALLET vendor superset.
// Proves the vendor Tron adapter + address codec reproduce the SAME bytes as the
// canonical extension (docs/tron-vectors.json): secp256k1 -> 0x41 -> base58check
// address, both-ways hex<->base58, txID == sha256(raw_data_hex), the 65B
// [r||s||v] signature (which must RECOVER to the owner pubkey), and the vendor
// imported-key / watch-only account superset. No network.
//
//   node web/wallet/vendor/tron.test.js

const C = require('./crypto-core.js');
const S = require('./secp256k1.js');
const HD = require('./hd.js');
const A = require('./address.js');
const TRON = require('./chains/tron.js');
const KI = require('./key-import.js');
const REG = require('./chains/registry.js');
const V = require('../../../docs/tron-vectors.json');

const h = C.bytesToHex;
let pass = 0, fail = 0;
function eq(name, got, want) { if (got === want) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); } }
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
const node = HD.derivePath(seed, V.path);
const priv = node.privateKey;
const pub = S.publicKey(priv, false);

// ---- key + address derivation ---------------------------------------------
eq('tron priv', h(priv), V.expected.privKeyHex);
eq('tron pubkey uncompressed', h(pub), V.expected.pubkeyHexUncompressed);
eq('tron keccak20 body', h(C.keccak256(pub.slice(1)).slice(-20)), V.expected.ethStyleHash20);
eq('tron address hex', '41' + V.expected.ethStyleHash20, V.expected.addressHex);
eq('tron base58 address', A.tronAddress(node.publicKey), V.expected.base58Address);
eq('tron body == evm body', V.expected.ethStyleHash20, A.evmAddress(node.publicKey).slice(2).toLowerCase());

// ---- codec both-ways + validation -----------------------------------------
for (const [hex, b58] of V.addressSpecVectors) {
  eq('tron hexToBase58 ' + b58, A.tronHexToBase58(hex), b58);
  eq('tron addressToHex ' + b58, A.tronAddressToHex(b58), hex);
  ok('tron isTronAddress ' + b58, A.isTronAddress(b58) && A.isTronAddress(hex) && A.isTronAddress('0x' + hex));
}
ok('tron rejects evm', !A.isTronAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
ok('tron rejects bech32', !A.isTronAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));

// ---- txID recompute + 65B signature golden + recover -----------------------
for (const [label, vec] of [['native', V.tx], ['trc20', V.trc20Tx]]) {
  const txId = h(C.sha256(C.hexToBytes(vec.rawDataHex)));
  eq('tron ' + label + ' txID == sha256(raw_data_hex)', txId, vec.expected.txID);
  eq('tron ' + label + ' verifyTxId', TRON.verifyTxId(vec.rawDataHex, vec.expected.txID), txId);
  let threw = false; try { TRON.verifyTxId(vec.rawDataHex, '00'.repeat(32)); } catch (_) { threw = true; }
  ok('tron ' + label + ' verifyTxId rejects tampered', threw);
  const sig65 = TRON.signTxId(txId, priv);
  eq('tron ' + label + ' sig 65B', h(sig65), vec.expected.signatureHex);
  ok('tron ' + label + ' sig len 65', sig65.length === 65);
  const r = S.bytesToBig(sig65.slice(0, 32)), sv = S.bytesToBig(sig65.slice(32, 64)), v = sig65[64];
  ok('tron ' + label + ' verifies', S.verify(C.hexToBytes(txId), { r, s: sv }, pub));
  eq('tron ' + label + ' recovers owner', h(S.recover(C.hexToBytes(txId), r, sv, v, false)), h(pub));
}
eq('tron trc20 abi parameter', TRON.trc20TransferParam(V.trc20Tx.to, V.trc20Tx.amount), V.trc20Tx.parameterHex);

// ---- key-import: raw key / mnemonic / watch -> same 'T…' address -----------
{
  const byKey = KI.parsePrivateKey('tron', V.expected.privKeyHex);
  eq('import tron key address', byKey.addresses.tron, V.expected.base58Address);
  eq('import tron key family', byKey.family, 'tron');
  const byMn = KI.fromMnemonic(V.mnemonic, '', { family: 'tron' });
  eq('import tron mnemonic address', byMn.addresses.tron, V.expected.base58Address);
  const watch = KI.watchAccount('tron', V.expected.base58Address);
  eq('import tron watch address', watch.watch.tron, V.expected.base58Address);
  eq('import tron detect', KI.detect(V.expected.base58Address).families[0], 'tron');
}

// ---- adapter superset: HD, imported key, watch-only ------------------------
(async () => {
  const a = TRON.createTronAdapter({});
  a.unlock(seed);
  const hd = await a.deriveAccount({ seed }, 0);
  eq('adapter hd address', hd.address, V.expected.base58Address);
  eq('adapter hd path', hd.path, V.path);

  a.unlock({ keys: { tron: { priv: V.expected.privKeyHex } } });
  const imp = await a.deriveAccount({ keys: { tron: { priv: V.expected.privKeyHex } } });
  eq('adapter imported address', imp.address, V.expected.base58Address);
  ok('adapter imported flag', imp.imported === true);

  a.unlock({ watch: { tron: V.expected.base58Address } });
  const w = await a.deriveAccount({ watch: { tron: V.expected.base58Address } });
  eq('adapter watch address', w.address, V.expected.base58Address);
  ok('adapter watch flag', w.watchOnly === true);
  let threw = false; try { await a.signTx(w, { raw_data_hex: V.tx.rawDataHex, txID: V.tx.expected.txID }); } catch (_) { threw = true; }
  ok('adapter watch cannot sign', threw);

  // signTx (HD) reproduces the golden signature + rejects a tampered payload
  a.unlock(seed);
  const signed = await a.signTx(hd, { raw_data_hex: V.tx.rawDataHex, txID: V.tx.expected.txID, unsigned: { raw_data_hex: V.tx.rawDataHex, txID: V.tx.expected.txID } });
  eq('adapter signTx signature', signed.signature, V.tx.expected.signatureHex);
  ok('adapter signTx attaches signature[]', Array.isArray(signed.signed.signature) && signed.signed.signature[0] === V.tx.expected.signatureHex);
  let threw2 = false; try { await a.signTx(hd, { raw_data_hex: V.tx.rawDataHex + '00', txID: V.tx.expected.txID }); } catch (_) { threw2 = true; }
  ok('adapter signTx rejects tampered raw_data_hex', threw2);

  // ---- FUND SAFETY: node-untrusted raw_data DECODE + ASSERT guard ----------
  // matching txID == sha256(raw_data_hex) proves NOTHING about who the payload
  // pays; decode the protobuf + assert it is the transfer we intended.
  {
    const dn = TRON.decodeRawData(V.tx.rawDataHex);
    eq('decode native type', dn.type, TRON.TRON_TRANSFER_CONTRACT);
    eq('decode native owner', dn.owner, V.expected.addressHex);
    eq('decode native to', dn.to, A.tronAddressToHex(V.tx.to));
    eq('decode native amount', dn.amount.toString(), V.tx.amount);
    const dt = TRON.decodeRawData(V.trc20Tx.rawDataHex);
    eq('decode trc20 type', dt.type, TRON.TRON_TRIGGER_SMART_CONTRACT);
    eq('decode trc20 owner', dt.owner, V.expected.addressHex);
    eq('decode trc20 contract', dt.contract, A.tronAddressToHex(V.trc20Tx.contract));
    eq('decode trc20 callValue', dt.callValue.toString(), '0');
    eq('decode trc20 data', dt.data, TRON.TRC20_SELECTOR + V.trc20Tx.parameterHex);
  }

  // decode+assert ACCEPTS the correct node payload
  {
    let okNative = true, okTrc = true;
    try { TRON.assertRawDataMatches(V.tx.rawDataHex, { owner: V.expected.base58Address, to: V.tx.to, amount: V.tx.amount }); } catch (_) { okNative = false; }
    try { TRON.assertRawDataMatches(V.trc20Tx.rawDataHex, { owner: V.expected.base58Address, to: V.trc20Tx.to, amount: V.trc20Tx.amount, asset: { kind: 'trc20', address: V.trc20Tx.contract } }); } catch (_) { okTrc = false; }
    ok('assert accepts correct native payload', okNative);
    ok('assert accepts correct trc20 payload', okTrc);
  }

  // decode+assert REJECTS tampered node payloads — NO signature produced
  {
    const attacker = '41e552f6487585c2b58bc2c9bb4492bc1f17132cd0'; // TWsm8… body
    const intent = { owner: V.expected.base58Address, to: V.tx.to, amount: V.tx.amount };
    // (a) native recipient swapped; txID recomputed so sha256 guard PASSES
    const swapTo = V.tx.rawDataHex.replace(A.tronAddressToHex(V.tx.to), attacker);
    const swapToId = h(C.sha256(C.hexToBytes(swapTo)));
    let aThrew = false; try { TRON.assertRawDataMatches(swapTo, intent); } catch (_) { aThrew = true; }
    ok('assert rejects native recipient swap', aThrew);
    let sThrew = false; try { await a.signTx(hd, { raw_data_hex: swapTo, txID: swapToId, assert: intent }); } catch (_) { sThrew = true; }
    ok('signTx refuses native recipient swap', sThrew);
    // (b) native amount inflated 1 -> 2 TRX (same-width varint)
    const infl = V.tx.rawDataHex.replace('18c0843d', '1880897a');
    const inflId = h(C.sha256(C.hexToBytes(infl)));
    eq('inflated decodes to 2 TRX', TRON.decodeRawData(infl).amount.toString(), '2000000');
    let bThrew = false; try { TRON.assertRawDataMatches(infl, intent); } catch (_) { bThrew = true; }
    ok('assert rejects native amount inflation', bThrew);
    let s2Threw = false; try { await a.signTx(hd, { raw_data_hex: infl, txID: inflId, assert: intent }); } catch (_) { s2Threw = true; }
    ok('signTx refuses native amount inflation', s2Threw);
    // (c) TRC-20 calldata recipient swapped (ABI word, no 0x41)
    const t20intent = { owner: V.expected.base58Address, to: V.trc20Tx.to, amount: V.trc20Tx.amount, asset: { kind: 'trc20', address: V.trc20Tx.contract } };
    const swapData = V.trc20Tx.rawDataHex.replace('0000000000000000000000005cd0fb0ab3ce40f3051414c604b27756e69e43db', '000000000000000000000000e552f6487585c2b58bc2c9bb4492bc1f17132cd0');
    const swapDataId = h(C.sha256(C.hexToBytes(swapData)));
    let cThrew = false; try { TRON.assertRawDataMatches(swapData, t20intent); } catch (_) { cThrew = true; }
    ok('assert rejects trc20 calldata swap', cThrew);
    let s3Threw = false; try { await a.signTx(hd, { raw_data_hex: swapData, txID: swapDataId, assert: t20intent }); } catch (_) { s3Threw = true; }
    ok('signTx refuses trc20 calldata swap', s3Threw);
    // (d) WITHOUT build-time intent, signTx refuses a payload whose owner is not us
    const swapOwner = V.tx.rawDataHex.replace('0a1541c8599111f29c1e1e061265b4af93ea1f274ad78a', '0a1541e552f6487585c2b58bc2c9bb4492bc1f17132cd0');
    const swapOwnerId = h(C.sha256(C.hexToBytes(swapOwner)));
    let dThrew = false; try { await a.signTx(hd, { raw_data_hex: swapOwner, txID: swapOwnerId }); } catch (_) { dThrew = true; }
    ok('signTx refuses foreign-owner payload (no intent)', dThrew);
  }

  // registry wiring
  const reg = REG.createRegistry({});
  reg.unlock({ seed });
  const trx = await reg.get('tron').deriveAccount({ seed });
  eq('registry tron addr', trx.address, V.expected.base58Address);
  ok('registry enables tron', reg.enabled().includes('tron'));
  eq('registry tron default api', reg.endpoints('tron').api, 'https://api.trongrid.io');
  ok('registry tron usdt token', reg.tokensFor('tron').some((t) => t.symbol === 'USDT' && t.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'));
  ok('registry networks lists Tron', reg.networks().some((n) => n.id === 'tron' && n.name === 'Tron' && n.symbol === 'TRX'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL async: ' + e.message); process.exit(1); });
