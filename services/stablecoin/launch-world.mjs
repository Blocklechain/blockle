// One-shot atomic launch of the official WORLD token on mainnet from the node
// operator wallet: deploy World/WORLD (8dp), mint 1,000,000, seed a 1,000 BLOCK /
// 1,000,000 WORLD pool — all in ONE transaction. Prints the contract id and
// waits until the token + pool are live on-chain.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('/opt/blockle/services/stablecoin/wasm/blockle_wasm.js');

const NODE = 'http://127.0.0.1:8445';
const op = JSON.parse(fs.readFileSync('/var/lib/blockle-pool/wallet.json', 'utf8'));
const SK = op.secret_hex, PK = op.public_hex, ADDR = op.address;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('GET ' + p + ' ' + r.status); return r.json(); }
async function rpc(m, p) { const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'w', method: m, params: p }) }); const b = await r.json().catch(() => ({})); if (!r.ok || (b && b.error)) throw new Error(m + ': ' + ((b.error && (b.error.message || b.error)) || r.status)); return b.result != null ? b.result : b; }

(async () => {
  console.log('operator:', ADDR);
  const u = await get('/explorer/utxos/' + encodeURIComponent(ADDR));
  console.log('spendable:', (u.spendable / 1e8).toFixed(2), 'BLOCK');
  const utxos = (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
  // deploy World/WORLD 8dp, mint 1,000,000, seed 1,000 BLOCK / 1,000,000 WORLD
  const built = JSON.parse(wasm.build_launch_token(SK, PK, JSON.stringify(utxos), 'World', 'WORLD', 8n, 1000000n, 1000n, 1000000n, 800000n, 10n));
  const cid = wasm.contract_id_for_txid(built.txid);
  console.log('launch txid:', built.txid);
  console.log('WORLD contractId:', cid);
  await rpc('submitrawtransaction', [built.raw]);
  console.log('submitted — waiting for the token + pool to go live…');
  for (let i = 0; i < 1800; i++) {
    let tok = null, pool = false;
    try { tok = await rpc('tokeninfo', [{ contract: cid }]); } catch {}
    try { const pl = await rpc('listpools', []); pool = (pl.pools || []).some((p) => (p.token || p.id || '').includes(cid)); } catch {}
    if (tok && tok.isToken) { console.log('token live: ' + tok.name + '/' + tok.symbol + ' supply=' + tok.totalSupply + (pool ? ' · pool live' : ' · pool pending')); if (pool) { console.log('\nWORLD LAUNCHED ✓  contract=' + cid); return; } }
    await sleep(2000);
  }
  throw new Error('timed out waiting for WORLD to go live (contract ' + cid + ')');
})().catch((e) => { console.error('WORLD LAUNCH FAILED:', e.message); process.exit(1); });
