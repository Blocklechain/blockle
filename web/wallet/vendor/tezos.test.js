// tezos.test.js — Tezos golden-vector gate for the WEB WALLET vendor superset.
// Proves the vendor Tezos forge + adapter reproduce the SAME bytes as the
// canonical extension (docs/tezos-vectors.json): blake2b (20/32), zarith LEB128,
// contract-id per address family, SLIP-0010 ed25519 m/44'/1729'/0'/0' -> edpk ->
// tz1, the client-forged 'transaction' op byte-for-byte, the blake2b(0x03||forged)
// signing hash, the ed25519 signature (which VERIFIES), edsig + injection payload,
// and the registry wiring. No network.
//
//   node web/wallet/vendor/tezos.test.js

const C = require('./crypto-core.js');
const ED = require('./ed25519.js');
const HD = require('./hd.js');
const TZ = require('./chains/tezos-forge.js');
const TEZOS = require('./chains/tezos.js');
const REG = require('./chains/registry.js');
const V = require('../../../docs/tezos-vectors.json');

const h = C.bytesToHex;
let pass = 0, fail = 0;
function eq(name, got, want) { if (got === want) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); } }
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// ---- blake2b KATs (the one new primitive) ---------------------------------
for (const [input, hex, len] of V.blake2bKats) eq('blake2b-' + (len * 8) + '("' + input + '")', h(C.blake2b(C.utf8(input), len)), hex);

// ---- zarith LEB128 KATs ----------------------------------------------------
for (const [n, hex] of V.zarithKats) eq('zarith(' + n + ')', h(TZ.zarith(n)), hex);

// ---- contract-id per address family ---------------------------------------
for (const [addr, hex] of V.destinationKats) eq('contractId(' + addr.slice(0, 4) + '…)', h(TZ.contractId(addr)), hex);

// ---- key + edpk + tz1 ------------------------------------------------------
const seed = HD.mnemonicToSeed(V.mnemonic, V.passphrase || '');
const node = TEZOS.deriveSlip10(seed, V.path);
eq('seed key', h(node.key), V.expected.seedKeyHex);
const pub = ED.publicKey(node.key);
eq('edpk pubkey', h(pub), V.expected.edpkPubkeyHex);
eq('edpk', TZ.edpk(pub), V.expected.edpk);
eq('tz1 address', TZ.tz1(pub), V.expected.address);

// ---- tz1 codec + validation -----------------------------------------------
for (const [pubHex, addr] of V.addressSpecVectors) {
  eq('tz1 from pub', TZ.tz1(C.hexToBytes(pubHex)), addr);
  ok('isTz1 ' + addr.slice(0, 6), TZ.isTz1(addr));
}
ok('rejects btc', !TZ.isTezosDestination('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
ok('rejects xlm', !TZ.isTezosDestination('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX'));

// ---- client-forged transaction byte-exact + signs + verifies --------------
const built = TEZOS.buildSignedTransaction(V.tx.fields, node.key);
eq('forged bytes', built.forgedHex, V.tx.expected.forgedHex);
eq('signing hash', built.signingHashHex, V.tx.expected.signingHashHex);
eq('signature', built.signatureHex, V.tx.expected.signatureHex);
eq('edsig', built.edsig, V.tx.expected.edsig);
eq('injection hex', built.injectionHex, V.tx.expected.injectionHex);
ok('ed25519 verifies', ED.verify(C.hexToBytes(built.signingHashHex), built.signature, pub));

(async () => {
  // adapter buildSend validates destination + is client-signed (offline)
  const a = TEZOS.createTezosAdapter({
    httpGet: async (url) => {
      if (url.endsWith('/hash')) return '"' + V.tx.fields.branch + '"';
      if (url.endsWith('/counter')) return '"' + (BigInt(V.tx.fields.counter) - 1n).toString() + '"';
      if (url.endsWith('/balance')) return '"5000000"';
      throw new Error('unexpected GET ' + url);
    },
    httpPost: async () => '"ooGoldenInjectedOpHash"',
  });
  a.unlock(seed);
  const acct = await a.deriveAccount({ seed }, 0);
  eq('adapter address', acct.address, V.expected.address);
  eq('adapter edpk', acct.edpk, V.expected.edpk);
  try { await a.buildSend(acct, { to: 'not-a-tezos-address', amount: '1' }); ok('rejects bad dest', false); }
  catch (e) { ok('rejects bad dest', /invalid destination/.test(e.message)); }
  const b = await a.buildSend(acct, {
    to: V.tx.fields.destination, amount: V.tx.fields.amount,
    fee: V.tx.fields.fee, gasLimit: V.tx.fields.gas_limit, storageLimit: V.tx.fields.storage_limit,
  });
  ok('needsSign false', b.needsSign === false);
  eq('adapter injection hex', b.raw, V.tx.expected.injectionHex);
  const bc = await a.broadcast(b);
  eq('broadcast txid', bc.txid, 'ooGoldenInjectedOpHash');
  const bal = await a.getBalance(acct.address);
  eq('balance display', bal[0].display, '5');

  // registry wiring
  const reg = REG.createRegistry({});
  reg.unlock({ seed });
  const xtz = await reg.get('tezos').deriveAccount({ seed });
  eq('registry tezos addr', xtz.address, V.expected.address);
  ok('registry enables tezos', reg.enabled().includes('tezos'));
  eq('registry tezos default rpc', reg.endpoints('tezos').rpc, 'https://mainnet.api.tez.ie');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL async: ' + e.message); process.exit(1); });
