// Deploy the Blockle Protect anchor-registry on Blockle MAINNET, then prove the
// full loop end-to-end (anchor a test root -> read it back) — run ON THE BOX.
//
// The registry is PERMISSIONLESS and has no owner/init, so this only deploys the
// bytecode and then self-tests with one real anchor. Uses the SAME ML-DSA wasm
// the wallets use and the live mainnet node RPC (:8445).
//
//   node deploy-anchor-mainnet.mjs <wallet.json> <anchor-registry.hex> [nodeUrl]
//
// Prints:  ANCHOR_CONTRACT=<id>
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('./wasm/blockle_wasm.js');

const [, , KEYPATH, CODEPATH, NODE_ARG] = process.argv;
const NODE = (NODE_ARG || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const GAS_PRICE = 10n;
const raw = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
const k = { address: raw.address, secretKey: raw.secretKey ?? raw.secret_hex, publicKey: raw.publicKey ?? raw.public_hex };
const code = fs.readFileSync(CODEPATH, 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status); return r.json(); }
async function rpc(method, params) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'anchor', method, params }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || (b && b.error)) throw new Error(method + ': ' + ((b.error && (b.error.message || b.error)) || r.status));
  return b.result != null ? b.result : b;
}
async function utxos() { const u = await get('/explorer/utxos/' + encodeURIComponent(k.address)); return (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) })); }
async function waitConf(txid, label) {
  process.stdout.write(`  waiting 1 conf for ${label} ${txid.slice(0, 12)}… `);
  for (let i = 0; i < 1800; i++) { // ~60 min budget (mainnet ~10-min blocks)
    try { const t = await get('/explorer/tx/' + encodeURIComponent(txid)); const c = (t && t.tx && t.tx.confirmations) || t.confirmations || 0; if (c >= 1) { console.log('ok (' + c + ')'); return; } } catch {}
    await sleep(2000);
  }
  throw new Error('timeout waiting for ' + txid);
}
async function anchoredHeight(contract, root32) {
  const res = await rpc('callcontract', [{ contract, calldata: '01' + root32 }]);
  if (!res || !res.success) return 0;
  if (typeof res.u64 === 'number') return res.u64;
  if (typeof res.returnHex === 'string' && res.returnHex.length >= 16) {
    return parseInt(res.returnHex.slice(0, 16).match(/../g).reverse().join(''), 16);
  }
  return 0;
}

(async () => {
  console.log('deployer:', k.address);
  const sp = (await get('/explorer/utxos/' + encodeURIComponent(k.address))).spendable || 0;
  console.log('spendable (base):', sp);
  if (sp < 10000000) throw new Error('deployer underfunded');

  // 1) DEPLOY (no init — permissionless registry)
  const dep = JSON.parse(wasm.build_deploy(k.secretKey, k.publicKey, JSON.stringify(await utxos()), code, 500000n, GAS_PRICE));
  const contract = dep.contractId;
  console.log('deploy txid:', dep.txid, '\nANCHOR_CONTRACT=' + contract);
  await rpc('submitrawtransaction', [dep.raw]);
  await waitConf(dep.txid, 'deploy');

  // 2) SELF-TEST: anchor a throwaway root, confirm, read it back.
  const testRoot = 'ab'.repeat(32); // 32 bytes
  console.log('self-test: anchoring root', testRoot.slice(0, 12) + '…');
  const pre = await anchoredHeight(contract, testRoot);
  console.log('  anchored() before:', pre, pre === 0 ? 'OK (unset)' : 'UNEXPECTED');
  const anc = JSON.parse(wasm.build_call(k.secretKey, k.publicKey, JSON.stringify(await utxos()), contract, '00' + testRoot, 0n, 120000n, GAS_PRICE));
  console.log('  anchor txid:', anc.txid);
  await rpc('submitrawtransaction', [anc.raw]);
  await waitConf(anc.txid, 'anchor');
  const post = await anchoredHeight(contract, testRoot);
  console.log('  anchored() after:', post, post > 0 ? 'OK — root is provably on-chain at height ' + post : 'UNEXPECTED (still 0)');
  if (post <= 0) throw new Error('self-test failed: anchored root not readable');

  console.log('\nDEPLOY+SELFTEST OK');
  console.log('ANCHOR_CONTRACT=' + contract);
})().catch((e) => { console.error('ANCHOR DEPLOY FAILED:', e.message); process.exit(1); });
