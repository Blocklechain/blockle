// Blockle test-BLOCK faucet.
//
// Drips a small, fixed amount of BLOCK to any block1 address so people can test
// the launchpad + the BLOCK<->wBLOCK bridge without buying BLOCK. It is a plain
// operator convenience, NOT consensus: it holds a funded faucet wallet key
// (box-only, path via env) and builds + submits a normal transfer, exactly like
// a light wallet. Rate-limited per recipient address AND per IP.
//
// Safety: the faucet can only ever spend what's in the faucet wallet — it is not
// a mint. Drip size + cooldown + a daily total cap bound the blast radius. If the
// faucet wallet is empty it serves an honest "dry" message (never fakes a txid).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The ML-DSA signer / tx builder — same wasm the wallets use. Vendored next to
// this service as ./wasm (pkg-node build) at deploy time.
const wasm = require('../wasm/blockle_wasm.js');

const PORT = Number(process.env.FAUCET_PORT || 8799);
const DATA = process.env.FAUCET_DATA || '/var/lib/blockle-faucet';
const KEYPATH = process.env.FAUCET_KEYPAIR || '/opt/blockle/secrets/faucet-block.json';
const NODE = (process.env.FAUCET_NODE_URL || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const COIN = 100000000n;
// Decimal BLOCK string -> integer base units (8 dp exact). Lets the drip be a
// fraction like 0.1 BLOCK.
function toBase(v) {
  const m = String(v).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error(`bad BLOCK amount "${v}"`);
  return BigInt(m[1]) * COIN + BigInt((m[2] || '').padEnd(8, '0') || '0');
}
const DRIP_WHOLE = process.env.FAUCET_DRIP || '0.1';           // BLOCK per claim (decimal ok)
const FEE_BASE = BigInt(process.env.FAUCET_FEE_BASE || 10000); // 0.0001 BLOCK
const COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_HRS || 6) * 3600 * 1000;
const DAILY_CAP_BLOCK = toBase(process.env.FAUCET_DAILY_CAP || '5000'); // operator-total/day (base units)

const DRIP_BASE = toBase(DRIP_WHOLE);

fs.mkdirSync(DATA, { recursive: true });
const CLAIMS = path.join(DATA, 'claims.json');
function loadClaims() { try { return JSON.parse(fs.readFileSync(CLAIMS, 'utf8')); } catch { return { byAddr: {}, byIp: {}, day: '', dayTotalBase: '0' }; } }
function saveClaims(c) { fs.writeFileSync(CLAIMS, JSON.stringify(c)); }

const kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8')); // { address, publicKey, secretKey } hex

function j(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(b);
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
async function nodeGet(p) {
  const r = await fetch(NODE + p, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('node ' + r.status);
  return r.json();
}
async function nodeSubmit(rawHex) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'faucet', method: 'submitrawtransaction', params: [rawHex] }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error((body.error && (body.error.message || body.error)) || 'submit failed');
  return body.result || body;
}
function fmt(base) { const n = BigInt(base); const w = n / COIN; const f = (n % COIN).toString().padStart(8, '0').replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; }
function today() { return new Date(Date.now()).toISOString().slice(0, 10); }

async function faucetBalance() {
  try { const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(kp.address)); return BigInt(u.spendable || 0); }
  catch { return null; }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return j(res, 204, {});
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/faucet/info') {
      const bal = await faucetBalance();
      return j(res, 200, {
        faucetAddress: kp.address,
        dripBlock: Number(DRIP_WHOLE),
        cooldownHours: COOLDOWN_MS / 3600000,
        dailyCapBlock: Number(fmt(DAILY_CAP_BLOCK)),
        balance: bal == null ? null : fmt(bal),
        dry: bal != null && bal < DRIP_BASE,
        // The faucet is funded by PoW coinbase: the node mines to the faucet
        // wallet, so it self-mints test BLOCK (matures ~100 blocks). No manual
        // top-ups. When "dry" it's just warming up, not broken.
        source: 'mining-coinbase',
        network: 'BLOCK testnet',
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/faucet/block') {
      let raw = ''; for await (const c of req) raw += c;
      let addr = '';
      try { addr = String((JSON.parse(raw || '{}').address || '')).trim(); } catch { return j(res, 400, { error: 'bad json' }); }
      if (!/^block1[0-9a-z]{20,}$/.test(addr)) return j(res, 400, { error: 'not a valid block1 address' });

      const c = loadClaims();
      const now = Date.now();
      // daily operator cap (reset per UTC day)
      if (c.day !== today()) { c.day = today(); c.dayTotalBase = '0'; }
      if (BigInt(c.dayTotalBase) + DRIP_BASE > DAILY_CAP_BLOCK) return j(res, 429, { error: 'faucet daily cap reached — try again tomorrow' });
      // per-address + per-ip cooldown
      const ip = clientIp(req);
      const lastA = c.byAddr[addr] || 0, lastI = c.byIp[ip] || 0;
      const wait = Math.max(lastA + COOLDOWN_MS - now, lastI + COOLDOWN_MS - now);
      if (wait > 0) return j(res, 429, { error: `cooldown — try again in ${Math.ceil(wait / 60000)} min` });

      const bal = await faucetBalance();
      if (bal == null) return j(res, 502, { error: 'node unreachable' });
      if (bal < DRIP_BASE) return j(res, 503, { error: 'faucet is dry — please top it up' });

      const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(kp.address));
      const utxos = (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
      const built = JSON.parse(wasm.build_transfer(kp.secretKey, kp.publicKey, JSON.stringify(utxos), addr, DRIP_BASE, FEE_BASE));
      const sub = await nodeSubmit(built.raw);
      const txid = sub.txid || built.txid;

      c.byAddr[addr] = now; c.byIp[ip] = now; c.dayTotalBase = (BigInt(c.dayTotalBase) + DRIP_BASE).toString();
      saveClaims(c);
      return j(res, 200, { ok: true, txid, amount: fmt(DRIP_BASE), to: addr });
    }
    return j(res, 404, { error: 'not found' });
  } catch (e) {
    return j(res, 500, { error: (e && e.message) || String(e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[faucet] on 127.0.0.1:${PORT} drip=${DRIP_WHOLE} BLOCK cooldown=${COOLDOWN_MS / 3600000}h addr=${kp.address}`));
