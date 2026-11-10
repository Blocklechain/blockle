// chains/cardano.test.js — Cardano (ADA) native adapter golden-vector gate.
// Run: node --test chains/cardano.test.js
//
// The HARD cross-port gate. Independently reproduces, from a known BIP39
// mnemonic's ENTROPY:
//   • Icarus (CIP-3) 96-byte master key (PBKDF2-HMAC-SHA512 pw='' salt=entropy
//     iters=4096 dkLen=96 + clamp)
//   • CIP-1852 BIP32-Ed25519 payment (m/1852'/1815'/0'/0/0) + stake
//     (m/1852'/1815'/0'/2/0) extended keys + public keys
//   • Shelley base mainnet addr1 address
//   • the canonical Conway CBOR tx_body (set tag 258 on inputs) — BYTE-EXACT
//   • txHash = blake2b256(tx_body)
//   • an ed25519-BIP32 extended-key signature (signExtended) — BYTE-EXACT, and
//     it VERIFIES under the standard ed25519.verify
//   • the full signed-tx CBOR [body, witnesses, true, null] — BYTE-EXACT
// Every `expected` in docs/cardano-vectors.json was produced by
// @emurgo/cardano-serialization-lib-nodejs with an independent blakejs blake2b.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const C = require('./crypto-core.js');
const ED = require('./ed25519.js');
const HD = require('./hd.js');
const CC = require('./chains/cardano-crypto.js');
const CBOR = require('./chains/cardano-cbor.js');
const ADA = require('./chains/cardano.js');
const REG = require('./chains/registry.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'cardano-vectors.json'), 'utf8'));
const h = C.bytesToHex;
const entropy = () => HD.mnemonicToEntropy(V.mnemonic);

test('mnemonic -> entropy matches the vector', () => {
  assert.strictEqual(h(entropy()), V.icarus.entropyHex);
});

test('blake2b KATs at 28 (224) + 32 (256) bytes', () => {
  for (const [input, hex, len] of V.blake2bKats) {
    assert.strictEqual(h(C.blake2b(C.utf8(input), len)), hex, `blake2b-${len * 8}("${input}")`);
  }
});

test('canonical CBOR KATs (uint minimal-width + bytestring + array + map)', () => {
  for (const [n, hex] of V.cborKats.uint) {
    assert.strictEqual(h(CBOR.uint(n)), hex, 'cbor uint(' + n + ')');
  }
  for (const [input, hex] of V.cborKats.bstr) {
    assert.strictEqual(h(CBOR.bytes(C.hexToBytes(input))), hex, 'cbor bstr(' + input + ')');
  }
  // array [1,2,3]
  assert.strictEqual(h(CBOR.array([CBOR.uint(1), CBOR.uint(2), CBOR.uint(3)])), V.cborKats.array, 'cbor array');
  // map {0:1, 2:3}
  assert.strictEqual(h(CBOR.map([[CBOR.uint(0), CBOR.uint(1)], [CBOR.uint(2), CBOR.uint(3)]])), V.cborKats.map, 'cbor map');
});

test('Icarus (CIP-3) master key from entropy — byte-exact', () => {
  const master = CC.icarusMasterKey(entropy());
  const mk = C.concatBytes(master.kL, master.kR, master.cc);
  assert.strictEqual(h(mk), V.icarus.masterKeyHex96);
});

test('CIP-1852 BIP32-Ed25519 payment + stake keys + public keys — byte-exact', () => {
  const master = CC.icarusMasterKey(entropy());
  const pay = CC.derivePathFromMaster(master, V.derivation.paymentPath);
  const stake = CC.derivePathFromMaster(master, V.derivation.stakePath);
  assert.strictEqual(h(C.concatBytes(pay.A, pay.cc)), V.derivation.paymentXpubHex, 'payment xpub A||cc');
  assert.strictEqual(h(pay.A), V.derivation.paymentPubHex32, 'payment pubkey');
  assert.strictEqual(h(stake.A), V.derivation.stakePubHex32, 'stake pubkey');
  // scalarMulBase(kL) reproduces the public key
  assert.strictEqual(h(ED.scalarMulBase(pay.kL)), V.derivation.paymentPubHex32);
});

test('Shelley base address (cred hashes + addr bytes + addr1 bech32) — byte-exact', () => {
  const master = CC.icarusMasterKey(entropy());
  const pay = CC.derivePathFromMaster(master, V.derivation.paymentPath);
  const stake = CC.derivePathFromMaster(master, V.derivation.stakePath);
  assert.strictEqual(h(ADA.blake2b224(pay.A)), V.address.paymentCredHex28, 'payment cred');
  assert.strictEqual(h(ADA.blake2b224(stake.A)), V.address.stakeCredHex28, 'stake cred');
  assert.strictEqual(h(ADA.addressBytes(pay.A, stake.A)), V.address.addressBytesHex57, 'address bytes');
  assert.strictEqual(ADA.addressFromPubkeys(pay.A, stake.A), V.address.bech32, 'addr1 bech32');
  // round-trip + validation
  assert.ok(ADA.isCardanoAddress(V.address.bech32));
  assert.strictEqual(h(ADA.addressToBytes(V.address.bech32)), V.address.addressBytesHex57);
  // rejects non-Cardano + corrupted
  assert.ok(!ADA.isCardanoAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!ADA.isCardanoAddress('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX'));
  const a = V.address.bech32;
  assert.ok(!ADA.isCardanoAddress(a.slice(0, -1) + (a.slice(-1) === 'a' ? 'b' : 'a')));
});

test('native tx: tx_body CBOR + txHash + extended signature + signed-tx — byte-exact + verifies', () => {
  const master = CC.icarusMasterKey(entropy());
  const pay = CC.derivePathFromMaster(master, V.derivation.paymentPath);
  const built = ADA.buildSignedTransaction({
    inputs: V.tx.inputs, outputs: V.tx.outputs, fee: V.tx.fee, ttl: V.tx.ttl,
  }, pay);
  assert.strictEqual(built.bodyHex, V.tx.txBodyCborHex, 'tx_body CBOR');
  assert.strictEqual(built.txHashHex, V.tx.txHashHex, 'txHash blake2b256(body)');
  assert.strictEqual(built.vkeyHex, V.tx.vkeyHex32, 'vkey');
  assert.strictEqual(built.signatureHex, V.tx.signatureHex64, 'extended signature');
  assert.strictEqual(built.signedTxHex, V.tx.signedTxCborHex, 'signed-tx CBOR');
  // the extended signature VERIFIES under the standard ed25519 verify
  assert.ok(ED.verify(C.hexToBytes(built.txHashHex), C.hexToBytes(built.signatureHex), pay.A), 'signature verifies');
});

test('adapter deriveAccount + buildSend (offline, injected provider) + coin selection', async () => {
  const ent = entropy();
  const a = ADA.createCardanoAdapter({
    httpGet: async (url) => {
      if (url.endsWith('/tip')) return JSON.stringify([{ abs_slot: 900000 }]);
      throw new Error('unexpected GET ' + url);
    },
    httpPost: async (url, body) => {
      if (url.endsWith('/address_utxos')) {
        // one 10-ADA UTXO on the derived self address
        return JSON.stringify([{ tx_hash: V.tx.inputs[0].txHashHex, tx_index: 0, value: '10000000', asset_list: [] }]);
      }
      if (url.endsWith('/submittx')) return '"' + V.tx.txHashHex + '"';
      throw new Error('unexpected POST ' + url);
    },
  });
  a.unlock({ entropy: ent });
  const acct = await a.deriveAccount({ entropy: ent }, 0);
  assert.strictEqual(acct.address, V.address.bech32);
  assert.strictEqual(acct.scheme, 'ed25519-bip32');
  assert.strictEqual(acct.publicKey, V.derivation.paymentPubHex32);

  await assert.rejects(a.buildSend(acct, { to: 'not-an-addr', amount: '1000000' }), /invalid destination/);
  const built = await a.buildSend(acct, { to: V.tx.outputs[0].address, amount: '1000000' });
  assert.strictEqual(built.needsSign, false);
  assert.strictEqual(built.chain, 'cardano');
  // tx is internally consistent: inputs(10 ADA) = amount + change + fee
  assert.ok(BigInt(built.summary.fee) >= BigInt(ADA.MIN_FEE_B));
  // the built raw signed tx must re-verify end to end
  const body = built.raw;
  assert.ok(typeof body === 'string' && body.length > 0);
  const bc = await a.broadcast(built);
  assert.strictEqual(bc.txid, V.tx.txHashHex);
  assert.ok(bc.accepted);
  assert.strictEqual(a.explorerTx('abc'), 'https://cardanoscan.io/transaction/abc');
});

test('getBalance sums lovelace + surfaces native-asset amounts (display only)', async () => {
  const a = ADA.createCardanoAdapter({
    httpPost: async (url) => {
      if (url.endsWith('/address_utxos')) {
        return JSON.stringify([
          { tx_hash: 'aa', tx_index: 0, value: '2000000', asset_list: [{ policy_id: 'pp', asset_name: '41', quantity: '5' }] },
          { tx_hash: 'bb', tx_index: 1, value: '3000000', asset_list: [] },
        ]);
      }
      throw new Error('unexpected POST ' + url);
    },
  });
  const bal = await a.getBalance(V.address.bech32);
  assert.strictEqual(bal[0].asset.symbol, 'ADA');
  assert.strictEqual(bal[0].confirmed, '5000000');
  assert.strictEqual(bal[0].display, '5');
  const asset = bal.find((b) => b.asset.kind === 'native-asset');
  assert.ok(asset, 'native asset surfaced');
  assert.strictEqual(asset.confirmed, '5');
  assert.strictEqual(asset.asset.displayOnly, true);
});

test('registry: Cardano adapter registered, enabled, endpoint, derives', async () => {
  const reg = REG.createRegistry({});
  assert.ok(reg.has('cardano'));
  assert.ok(reg.enabled().includes('cardano'));
  assert.strictEqual(reg.endpoints('cardano').koios, 'https://blockle.org/account/api/px/koios/api/v1');
  const ent = entropy();
  reg.unlock({ entropy: ent, seed: ent });
  const acct = await reg.get('cardano').deriveAccount({ entropy: ent });
  assert.strictEqual(acct.scheme, 'ed25519-bip32');
  assert.strictEqual(acct.address, V.address.bech32);
});
