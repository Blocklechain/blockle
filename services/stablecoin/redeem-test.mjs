// End-to-end redeem test on the live redeem-capable USDB contract.
//  1. issuer funds the test wallet with a little BLOCK for gas
//  2. issuer mints `MINT` USDB to the test wallet (so it has redeemable balance)
//  3. register a PayPal payout intent for EMAIL (service /redeem) -> payoutRef
//  4. the TEST wallet signs redeem(payoutRef, amount) — burns its own USDB
// The service's watcher then pays the USD to EMAIL and marks it fulfilled.
//
//   node redeem-test.mjs <issuerKey> <testKey> <contract> <email> <redeemUsdb> [node]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('./wasm/blockle_wasm.js');

const [, , ISSUER, TESTK, CONTRACT, EMAIL, REDEEM_USDB, NODE_ARG] = process.argv;
const NODE = (NODE_ARG || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const USDB_API = 'http://127.0.0.1:8801/api/usdb';
const GP = 10n, UNIT = 1_000_000;
const iss = JSON.parse(fs.readFileSync(ISSUER, 'utf8'));
const tst = JSON.parse(fs.readFileSync(TESTK, 'utf8'));
const MINT = Number(REDEEM_USDB) + 0.1; // mint a touch more than we redeem
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('GET ' + p + ' ' + r.status); return r.json(); }
async function rpc(m, p) { const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'rt', method: m, params: p }) }); const b = await r.json().catch(() => ({})); if (!r.ok || (b && b.error)) throw new Error(m + ': ' + ((b.error && (b.error.message || b.error)) || r.status)); return b.result != null ? b.result : b; }
async function utxos(addr) { const u = await get('/explorer/utxos/' + encodeURIComponent(addr)); return { spendable: u.spendable || 0, utxos: (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) })) }; }
async function waitChange(addr, txid, label) { process.stdout.write('  confirm ' + label + ' ' + txid.slice(0, 12) + '… '); for (let i = 0; i < 1800; i++) { const { utxos: us } = await utxos(addr); if (us.some((x) => x.txid === txid)) { console.log('ok'); return; } await sleep(2000); } throw new Error('timeout ' + label); }
async function usdbBal(holder) { const t = await rpc('tokeninfo', [{ contract: CONTRACT, holder }]); return Number(t.balance || 0); }

(async () => {
  console.log('issuer', iss.address, '\ntest  ', tst.address, '\ncontract', CONTRACT);

  // 1) fund the test wallet's gas (0.1 BLOCK) from the issuer
  if ((await utxos(tst.address)).spendable < 3_000_000) {
    const iu = await utxos(iss.address);
    const ft = JSON.parse(wasm.build_transfer(iss.secretKey, iss.publicKey, JSON.stringify(iu.utxos), tst.address, 10_000_000n, 10_000n));
    console.log('gas txid:', ft.txid);
    await rpc('submitrawtransaction', [ft.raw]);
    await waitChange(tst.address, ft.txid, 'gas');
  } else console.log('test wallet already funded');

  // 2) issuer mints redeemable USDB to the test wallet
  const iu2 = await utxos(iss.address);
  const base = Math.round(MINT * UNIT);
  const mt = JSON.parse(wasm.build_stablecoin_mint(iss.secretKey, iss.publicKey, JSON.stringify(iu2.utxos), CONTRACT, tst.address, BigInt(base), 120000n, GP));
  console.log('mint txid:', mt.txid, '(' + MINT + ' USDB)');
  await rpc('submitrawtransaction', [mt.raw]);
  await waitChange(iss.address, mt.txid, 'mint');
  console.log('test USDB balance:', (await usdbBal(tst.address)) / UNIT);

  // 3) register the payout intent -> payoutRef + exact amount to burn
  const ir = await (await fetch(USDB_API + '/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payoutEmail: EMAIL, amountUsd: Number(REDEEM_USDB) }) })).json();
  if (ir.error) throw new Error('intent: ' + ir.error);
  console.log('intent payoutRef:', ir.payoutRef, 'estPayout $' + ir.estPayoutUsd, 'burn', ir.amountBase / UNIT, 'USDB');

  // 4) the TEST wallet signs redeem(payoutRef, amount) — burns its own USDB
  const tu = await utxos(tst.address);
  const rd = JSON.parse(wasm.build_stablecoin_redeem(tst.secretKey, tst.publicKey, JSON.stringify(tu.utxos), CONTRACT, ir.payoutRef, BigInt(ir.amountBase), 150000n, GP));
  console.log('redeem txid:', rd.txid);
  await rpc('submitrawtransaction', [rd.raw]);
  await waitChange(tst.address, rd.txid, 'redeem');
  console.log('\nREDEEM burned on-chain. redeemCount now:', (await rpc('callcontract', [{ contract: CONTRACT, calldata: '10' }])).u64);
  console.log('The service watcher will now PayPal $' + ir.estPayoutUsd + ' to ' + EMAIL + ' and mark it fulfilled.');
})().catch((e) => { console.error('REDEEM TEST FAILED:', e.message); process.exit(1); });
