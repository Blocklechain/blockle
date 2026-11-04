// Deploy the "World Items" (WITEM) BLOCK-721 collection on mainnet from the node
// operator wallet (which becomes the collection's authorized minter via fn_init).
// Prints the contract id and waits until it is live on-chain.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wasm = require('/opt/blockle/services/stablecoin/wasm/blockle_wasm.js');

const NODE = 'http://127.0.0.1:8445';
const op = JSON.parse(fs.readFileSync('/var/lib/blockle-pool/wallet.json', 'utf8'));
const code = fs.readFileSync('/tmp/witem_code.hex', 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('GET ' + p + ' ' + r.status); return r.json(); }
async function rpc(m, p) { const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'w', method: m, params: p }) }); const b = await r.json().catch(() => ({})); if (b && b.error) throw new Error(m + ': ' + JSON.stringify(b.error)); return b.result != null ? b.result : b; }

(async () => {
  const u = await get('/explorer/utxos/' + encodeURIComponent(op.address));
  const utxos = (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
  const built = JSON.parse(wasm.build_launch_nft(op.secret_hex, op.public_hex, JSON.stringify(utxos), code, 400000n, 10n));
  const cid = wasm.contract_id_for_txid(built.txid);
  console.log('WITEM launch txid:', built.txid);
  console.log('WITEM contractId:', cid);
  await rpc('submitrawtransaction', [built.raw]);
  console.log('submitted — waiting for the collection to go live…');
  for (let i = 0; i < 300; i++) {
    let info = null;
    try { info = await rpc('tokeninfo', [{ contract: cid }]); } catch {}
    if (info && (info.name || info.symbol)) { console.log('COLLECTION LIVE:', JSON.stringify(info)); console.log('\nWITEM DEPLOYED ✓ contract=' + cid); return; }
    await sleep(4000);
  }
  throw new Error('timed out waiting for WITEM (contract ' + cid + ')');
})().catch((e) => { console.error('WITEM DEPLOY FAILED:', e.message); process.exit(1); });
