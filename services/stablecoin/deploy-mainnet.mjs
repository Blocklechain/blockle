// USDB mainnet deploy + init + net-zero self-test — run ON THE BOX by the issuer.
//
// Uses the SAME ML-DSA wasm the wallets/service use (./wasm) and the live mainnet
// node RPC (:8445). It deploys the BLOCK-20S bytecode, initializes the issuer
// (= this script's key), verifies the metadata, then mints 1 USDB to the issuer
// and burns it back so on-chain supply returns to 0 — proving the issuer rails
// end-to-end without leaving any lasting supply. Prints the contract id.
//
//   node deploy-mainnet.mjs <issuer-keypair.json> <usdb-bytecode.hex> [nodeUrl]
//
// This NEVER touches the premine key: the issuer wallet is a dedicated key, and
// its gas was funded via the reserve-signer dispense (audited, capped).
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('./wasm/blockle_wasm.js');

const [, , KEYPATH, CODEPATH, NODE_ARG] = process.argv;
const NODE = (NODE_ARG || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const GAS_PRICE = 10n;
const k = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
const code = fs.readFileSync(CODEPATH, 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status); return r.json(); }
async function rpc(method, params) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'd', method, params }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || (b && b.error)) throw new Error(method + ': ' + ((b.error && (b.error.message || b.error)) || r.status));
  return b.result != null ? b.result : b;
}
async function utxos() { const u = await get('/explorer/utxos/' + encodeURIComponent(k.address)); return (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) })); }
// NOTE: the node's /explorer/tx does NOT index contract txs (deploy/call), so we
// confirm by the tx's BLOCK change output landing back in the issuer's UTXO set
// (every build_* here sends change to the issuer). Robust for all tx kinds.
async function waitConf(txid, n = 1, label = '') {
  process.stdout.write(`  confirm ${label} ${txid.slice(0, 12)}… `);
  for (let i = 0; i < 1200; i++) { // ~40 min budget per step (mainnet ~10-min blocks)
    try { const u = await get('/explorer/utxos/' + encodeURIComponent(k.address)); if ((u.utxos || []).some((x) => x.txid === txid)) { console.log('ok'); return; } } catch {}
    await sleep(2000);
  }
  throw new Error('timeout confirming ' + txid);
}
async function supply(contract) { const t = await rpc('tokeninfo', [{ contract }]); return Number(t.totalSupply != null ? t.totalSupply : t.supply || 0); }

(async () => {
  console.log('issuer:', k.address);
  let bal = (await get('/explorer/utxos/' + encodeURIComponent(k.address))).spendable || 0;
  console.log('issuer spendable (base):', bal);
  if (bal < 2000000) throw new Error('issuer underfunded — fund gas via reserve-signer first');

  // 1) DEPLOY
  const dep = JSON.parse(wasm.build_deploy(k.secretKey, k.publicKey, JSON.stringify(await utxos()), code, 500000n, GAS_PRICE));
  const contract = dep.contractId;
  console.log('deploy txid:', dep.txid, '\ncontractId:', contract);
  await rpc('submitrawtransaction', [dep.raw]);
  await waitConf(dep.txid, 1, 'deploy');

  // 2) INIT (selector 0 -> issuer = caller)
  const init = JSON.parse(wasm.build_call(k.secretKey, k.publicKey, JSON.stringify(await utxos()), contract, '00', 0n, 120000n, GAS_PRICE));
  console.log('init txid:', init.txid);
  await rpc('submitrawtransaction', [init.raw]);
  await waitConf(init.txid, 1, 'init');

  // 3) VERIFY metadata
  const info = await rpc('tokeninfo', [{ contract }]);
  console.log('tokeninfo:', JSON.stringify({ name: info.name, symbol: info.symbol, decimals: info.decimals, totalSupply: info.totalSupply }));

  // 4) NET-ZERO SELF-TEST: mint 1 USDB to issuer, verify, burn it back, verify 0
  const ONE = 1000000n; // 1 USDB (6 dp)
  const mint = JSON.parse(wasm.build_stablecoin_mint(k.secretKey, k.publicKey, JSON.stringify(await utxos()), contract, k.address, ONE, 120000n, GAS_PRICE));
  console.log('selftest mint txid:', mint.txid);
  await rpc('submitrawtransaction', [mint.raw]);
  await waitConf(mint.txid, 1, 'mint');
  const afterMint = await supply(contract);
  console.log('supply after mint (base):', afterMint, afterMint === 1000000 ? 'OK' : 'UNEXPECTED');

  const burn = JSON.parse(wasm.build_stablecoin_burn(k.secretKey, k.publicKey, JSON.stringify(await utxos()), contract, k.address, ONE, 120000n, GAS_PRICE));
  console.log('selftest burn txid:', burn.txid);
  await rpc('submitrawtransaction', [burn.raw]);
  await waitConf(burn.txid, 1, 'burn');
  const afterBurn = await supply(contract);
  console.log('supply after burn (base):', afterBurn, afterBurn === 0 ? 'OK — net zero' : 'UNEXPECTED');

  console.log('\nUSDB_CONTRACT=' + contract);
})().catch((e) => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
