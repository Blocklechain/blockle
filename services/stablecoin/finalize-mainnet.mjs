// USDB mainnet finalize: init (set issuer) + net-zero mint/burn self-test.
// Robust confirmation: the node's /explorer/tx does NOT index contract txs, so
// we confirm each tx by its EFFECT instead —
//   * init  -> its BLOCK change output (txid) appears in the issuer's UTXO set
//   * mint  -> totalSupply rises to the minted amount
//   * burn  -> totalSupply returns to 0
//
//   node finalize-mainnet.mjs <issuer-keypair.json> <contractId> [nodeUrl]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('./wasm/blockle_wasm.js');

const [, , KEYPATH, CONTRACT, NODE_ARG, MODE] = process.argv;
const NODE = (NODE_ARG || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const SKIP_INIT = MODE === 'mintburn'; // init already mined; run only the self-test
const GAS_PRICE = 10n;
const k = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('GET ' + p + ' ' + r.status); return r.json(); }
async function rpc(method, params) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'f', method, params }) });
  const b = await r.json().catch(() => ({})); if (!r.ok || (b && b.error)) throw new Error(method + ': ' + ((b.error && (b.error.message || b.error)) || r.status));
  return b.result != null ? b.result : b;
}
async function utxos() { const u = await get('/explorer/utxos/' + encodeURIComponent(k.address)); return { spendable: u.spendable || 0, utxos: (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) })) }; }
async function supply() { const t = await rpc('tokeninfo', [{ contract: CONTRACT }]); return Number(t.totalSupply || 0); }

// Confirm by the tx's BLOCK change landing back in the issuer's UTXO set.
async function waitChange(txid, label) {
  process.stdout.write(`  confirm ${label} ${txid.slice(0, 12)}… `);
  for (let i = 0; i < 1800; i++) { const { utxos: us } = await utxos(); if (us.some((x) => x.txid === txid)) { console.log('ok'); return; } await sleep(2000); }
  throw new Error('timeout confirming ' + label);
}
async function waitSupply(want, label) {
  process.stdout.write(`  confirm ${label} supply=${want}… `);
  for (let i = 0; i < 1800; i++) { if ((await supply()) === want) { console.log('ok'); return; } await sleep(2000); }
  throw new Error('timeout: supply never reached ' + want + ' for ' + label);
}

(async () => {
  console.log('issuer:', k.address, '\ncontract:', CONTRACT);
  const info = await rpc('tokeninfo', [{ contract: CONTRACT }]);
  console.log('pre:', JSON.stringify({ name: info.name, symbol: info.symbol, decimals: info.decimals, totalSupply: info.totalSupply }));

  // 1) INIT -> issuer = caller (selector 00)
  if (!SKIP_INIT) {
    const init = JSON.parse(wasm.build_call(k.secretKey, k.publicKey, JSON.stringify((await utxos()).utxos), CONTRACT, '00', 0n, 120000n, GAS_PRICE));
    console.log('init txid:', init.txid);
    await rpc('submitrawtransaction', [init.raw]);
    await waitChange(init.txid, 'init');
  } else {
    console.log('skip-init (already mined)');
  }

  // 2) SELF-TEST mint 1 USDB (proves issuer set) -> supply 1_000000
  const ONE = 1000000n;
  const mint = JSON.parse(wasm.build_stablecoin_mint(k.secretKey, k.publicKey, JSON.stringify((await utxos()).utxos), CONTRACT, k.address, ONE, 120000n, GAS_PRICE));
  console.log('mint txid:', mint.txid);
  await rpc('submitrawtransaction', [mint.raw]);
  await waitSupply(1000000, 'mint');

  // 3) burn it back -> supply 0 (net zero)
  const burn = JSON.parse(wasm.build_stablecoin_burn(k.secretKey, k.publicKey, JSON.stringify((await utxos()).utxos), CONTRACT, k.address, ONE, 120000n, GAS_PRICE));
  console.log('burn txid:', burn.txid);
  await rpc('submitrawtransaction', [burn.raw]);
  await waitSupply(0, 'burn');

  console.log('\nRESULT ok — USDB initialized + mint/burn proven on mainnet, supply back to 0');
})().catch((e) => { console.error('FINALIZE FAILED:', e.message); process.exit(1); });
