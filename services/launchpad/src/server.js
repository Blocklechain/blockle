// Blockle Launchpad service (loopback; nginx proxies /api/launch/* here).
//
// WHAT THIS IS (and is not):
//   * A PAID SOFTWARE/LISTING SERVICE. The PayPal charge is a developer deploy +
//     listing/promotion fee — it is NOT a sale of BLOCK or of the launched token.
//   * Users deploy their OWN BLOCK-20 token and seed their OWN pool liquidity by
//     signing in their wallet (non-custodial). This service never holds user keys
//     and never sells tokens for fiat.
//   * Promo perk: the first PROMO_CAP launches may opt into a one-time BLOCK
//     preseed from a platform wallet (a marketing grant, fixed size, NOT scaled
//     to the amount paid) so a new pool has a little starting depth.
//
// ECONOMICS (operator-configurable):
//   * launches 1..PROMO_CAP   -> FEE_PROMO_USD, optional PRESEED_BLOCK preseed.
//   * launches PROMO_CAP+1..  -> FEE_STD_USD,   no preseed.
//   * Featured / Boost listing placement sold as flat add-ons (time-boxed flags).
//
// SAFETY: the preseed can only ever spend the platform wallet's own balance (not
// a mint); it is bounded by PROMO_CAP, a per-address cap, a daily cap, and the
// wallet balance. If PayPal creds or the seed wallet are not wired, the service
// still serves /config honestly (payments disabled / preseed unavailable) and
// refuses to create orders — it never fakes a charge or a txid.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as paypal from './paypal.js';

const require = createRequire(import.meta.url);

const PORT = Number(process.env.LAUNCHPAD_PORT || 8808);
const DATA = process.env.LAUNCHPAD_DATA || '/var/lib/blockle-launchpad';
const KEYPATH = process.env.LAUNCHPAD_KEYPAIR || '/opt/blockle/secrets/launch-block.json';
const NODE = (process.env.LAUNCHPAD_NODE_URL || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const BIZ = (process.env.LAUNCHPAD_BIZ_URL || 'http://127.0.0.1:8900').replace(/\/+$/, '');
const PUBLIC_BASE = (process.env.LAUNCHPAD_PUBLIC_BASE || 'https://blockle.org/launch').replace(/\/+$/, '');

const PROMO_CAP = Number(process.env.LAUNCHPAD_PROMO_CAP || 1000);     // launches that get the promo deal
const PRESEED_BLOCK = Number(process.env.LAUNCHPAD_PRESEED_BLOCK || 50); // whole BLOCK preseeded per promo launch
const FEE_PROMO_USD = Number(process.env.LAUNCHPAD_FEE_PROMO_USD || 5);
const FEE_STD_USD = Number(process.env.LAUNCHPAD_FEE_STD_USD || 1);
const PRESEED_MAX_PER_ADDR = Number(process.env.LAUNCHPAD_PRESEED_MAX_PER_ADDR || 1);
const PRESEED_DAILY_CAP_BLOCK = Number(process.env.LAUNCHPAD_PRESEED_DAILY_CAP || 2000); // whole BLOCK/day
const LOCK_WEEKS = 1; // chain currently enforces a fixed 1-week LP lock

// Flat add-on prices (USD). Placement/promotion only — pure advertising.
const ADDON_PRICES = {
  featured: { '24h': Number(process.env.LAUNCHPAD_FEATURED_24H_USD || 10), '7d': Number(process.env.LAUNCHPAD_FEATURED_7D_USD || 25) },
  boost: { '24h': Number(process.env.LAUNCHPAD_BOOST_24H_USD || 5), '7d': Number(process.env.LAUNCHPAD_BOOST_7D_USD || 15) },
};
const DURATION_MS = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

const COIN = 100000000n;
const FEE_BASE = BigInt(process.env.LAUNCHPAD_TX_FEE_BASE || 10000); // node tx fee for the preseed transfer

fs.mkdirSync(DATA, { recursive: true });
const STATE = path.join(DATA, 'state.json');
function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { launchCount: 0, orders: {}, listings: {}, preseedByAddr: {}, day: '', dayPreseedBlock: 0 }; }
}
function save(s) { fs.writeFileSync(STATE, JSON.stringify(s)); }
function today() { return new Date(Date.now()).toISOString().slice(0, 10); }

// Lazy, resilient seed wallet: the service runs even if the wasm signer or the
// platform keypair aren't deployed yet (preseed simply stays unavailable).
let _kp = null, _wasm = null;
function seedReady() {
  if (_kp && _wasm) return true;
  try { _wasm = require('../wasm/blockle_wasm.js'); _kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8')); return true; }
  catch { _kp = null; _wasm = null; return false; }
}

function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
}
async function nodeGet(p) {
  const r = await fetch(NODE + p, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('node ' + r.status);
  return r.json();
}
async function nodeSubmit(rawHex) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'launchpad', method: 'submitrawtransaction', params: [rawHex] }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error((body.error && (body.error.message || body.error)) || 'submit failed');
  return body.result || body;
}
async function seedBalanceBase() {
  if (!seedReady()) return null;
  try { const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(_kp.address)); return BigInt(u.spendable || 0); }
  catch { return null; }
}
// Send `whole` BLOCK from the platform seed wallet to `addr`. Spends only the
// wallet's own UTXOs — this is a transfer, never a mint.
async function sendBlock(addr, whole) {
  if (!seedReady()) throw new Error('seed wallet not configured');
  const amt = BigInt(whole) * COIN;
  const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(_kp.address));
  const utxos = (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
  const built = JSON.parse(_wasm.build_transfer(_kp.secretKey, _kp.publicKey, JSON.stringify(utxos), addr, amt, FEE_BASE));
  const sub = await nodeSubmit(built.raw);
  return sub.txid || built.txid;
}

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isAddr = (s) => typeof s === 'string' && /^block1[0-9a-z]{20,}$/.test(s);

function phaseOf(s) { return s.launchCount < PROMO_CAP ? 'promo' : 'standard'; }
function feeOf(s) { return phaseOf(s) === 'promo' ? FEE_PROMO_USD : FEE_STD_USD; }

async function configJson() {
  const s = load();
  const bal = await seedBalanceBase();
  const preseedBudgetOk = bal != null && bal >= BigInt(PRESEED_BLOCK) * COIN + FEE_BASE;
  return {
    phase: phaseOf(s),
    feeUsd: feeOf(s),
    launchCount: s.launchCount,
    promoCap: PROMO_CAP,
    promoRemaining: Math.max(0, PROMO_CAP - s.launchCount),
    preseedBlock: PRESEED_BLOCK,
    // preseed is offered only in the promo phase AND when the platform wallet can fund it
    preseedAvailable: phaseOf(s) === 'promo' && preseedBudgetOk,
    lockWeeks: LOCK_WEEKS,
    addonPrices: ADDON_PRICES,
    paymentsEnabled: paypal.configured(),
    paypalEnv: paypal.env(),
    seedWalletFunded: bal == null ? null : Number(bal / COIN),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return j(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/launch/config') return j(res, 200, await configJson());

    if (req.method === 'GET' && p === '/api/launch/listings') {
      const s = load(); const now = Date.now();
      const featured = [], boosted = [];
      for (const [tok, L] of Object.entries(s.listings || {})) {
        if (L.featuredUntil && L.featuredUntil > now) featured.push(tok);
        if (L.boostUntil && L.boostUntil > now) boosted.push(tok);
      }
      return j(res, 200, { featured, boosted });
    }

    if (req.method === 'POST' && p === '/api/launch/order') {
      if (!paypal.configured()) return j(res, 503, { error: 'payments are not enabled yet' });
      const body = await readJson(req);
      const tier = String(body.tier || 'launch');
      let usd, description, meta = {};
      if (tier === 'launch') {
        const s = load();
        usd = feeOf(s);
        const address = String(body.address || '');
        const preseed = !!body.preseed;
        if (address && !isAddr(address)) return j(res, 400, { error: 'bad launch address' });
        meta = { address, preseed, phaseAtOrder: phaseOf(s), preseedBlock: preseed ? PRESEED_BLOCK : 0 };
        description = 'Blockle token launch — deploy & listing service';
      } else if (tier === 'featured' || tier === 'boost') {
        const dur = String(body.duration || '7d');
        if (!DURATION_MS[dur]) return j(res, 400, { error: 'bad duration' });
        const token = String(body.token || '');
        if (!isHex64(token)) return j(res, 400, { error: 'featured/boost needs a 64-hex token id' });
        usd = ADDON_PRICES[tier][dur];
        meta = { token, duration: dur };
        description = (tier === 'featured' ? 'Featured placement' : 'Listing boost') + ' (' + dur + ') — Blockle Launchpad';
      } else {
        return j(res, 400, { error: 'unknown tier' });
      }
      const order = await paypal.createOrder(usd, { description, returnUrl: PUBLIC_BASE, cancelUrl: PUBLIC_BASE });
      const s = load();
      s.orders[order.orderId] = { tier, usd, status: 'created', created: Date.now(), ...meta };
      save(s);
      return j(res, 200, { orderId: order.orderId, approveUrl: order.approveUrl, usd, tier });
    }

    // Poll after the buyer approves on PayPal. Idempotent; returns {pending:true}
    // until approved, then captures, applies the entitlement, and returns ok.
    if (req.method === 'POST' && p === '/api/launch/capture') {
      const body = await readJson(req);
      const orderId = String(body.orderId || '');
      const s = load();
      const ord = s.orders[orderId];
      if (!ord) return j(res, 404, { error: 'unknown order' });
      if (ord.status === 'used') return j(res, 200, { ok: true, status: 'used', tier: ord.tier, preseedTxid: ord.preseedTxid || null });
      let cap;
      try { cap = await paypal.captureOrder(orderId); }
      catch (e) { if (e.notApproved) return j(res, 200, { ok: false, pending: true }); throw e; }
      if (!paypal.captureOk(cap, ord.usd)) return j(res, 402, { error: 'payment not complete', status: cap.status, captureStatus: cap.captureStatus });

      if (ord.status !== 'paid') { ord.status = 'paid'; ord.paidAt = Date.now(); }

      // Add-ons apply immediately on payment.
      if (ord.tier === 'featured' || ord.tier === 'boost') {
        const L = s.listings[ord.token] || {};
        const until = Date.now() + DURATION_MS[ord.duration];
        if (ord.tier === 'featured') L.featuredUntil = Math.max(L.featuredUntil || 0, until);
        else L.boostUntil = Math.max(L.boostUntil || 0, until);
        s.listings[ord.token] = L;
        ord.status = 'used';
        save(s);
        return j(res, 200, { ok: true, tier: ord.tier, until });
      }

      // Launch tier: optionally deliver the one-time promo preseed now, to the
      // launching address, so the user can include it in their pool liquidity.
      let preseedTxid = ord.preseedTxid || null;
      if (ord.preseed && ord.phaseAtOrder === 'promo' && !preseedTxid && isAddr(ord.address)) {
        if (s.day !== today()) { s.day = today(); s.dayPreseedBlock = 0; }
        const got = s.preseedByAddr[ord.address] || 0;
        const bal = await seedBalanceBase();
        const canFund = bal != null && bal >= BigInt(PRESEED_BLOCK) * COIN + FEE_BASE;
        if (got >= PRESEED_MAX_PER_ADDR) ord.preseedNote = 'preseed already claimed by this address';
        else if (s.dayPreseedBlock + PRESEED_BLOCK > PRESEED_DAILY_CAP_BLOCK) ord.preseedNote = 'preseed daily cap reached — launch proceeds without it';
        else if (!canFund) ord.preseedNote = 'preseed wallet unfunded — launch proceeds without it';
        else {
          preseedTxid = await sendBlock(ord.address, PRESEED_BLOCK);
          ord.preseedTxid = preseedTxid;
          s.preseedByAddr[ord.address] = got + 1;
          s.dayPreseedBlock += PRESEED_BLOCK;
        }
      }
      save(s);
      return j(res, 200, { ok: true, tier: 'launch', paid: ord.usd, preseedTxid, preseedNote: ord.preseedNote || null, nextStep: 'launch-then-register' });
    }

    // After the user signs & submits their on-chain LaunchToken, record the logo,
    // mark the order used, and advance the launch counter (which drives phase/fee).
    if (req.method === 'POST' && p === '/api/launch/register') {
      const body = await readJson(req);
      const orderId = String(body.orderId || '');
      const token = String(body.token || '');
      const logo = String(body.logo || '');
      if (!isHex64(token)) return j(res, 400, { error: 'token must be a 64-hex contract id' });
      const s = load();
      const ord = s.orders[orderId];
      if (!ord || ord.tier !== 'launch') return j(res, 404, { error: 'unknown launch order' });
      if (ord.status === 'used') return j(res, 200, { ok: true, already: true });
      if (ord.status !== 'paid') return j(res, 402, { error: 'order not paid' });
      // Register the logo with the biz DEX registry (best-effort).
      try {
        await fetch(BIZ + '/api/dex/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, logo }) });
      } catch { /* non-fatal: token still resolves, just without a stored logo */ }
      ord.status = 'used'; ord.token = token;
      s.listings[token] = Object.assign({ created: Date.now() }, s.listings[token] || {});
      s.launchCount = (s.launchCount || 0) + 1;
      save(s);
      return j(res, 200, { ok: true, token, launchCount: s.launchCount });
    }

    return j(res, 404, { error: 'not found' });
  } catch (e) {
    return j(res, 500, { error: (e && e.message) || String(e) });
  }
});

async function readJson(req) {
  let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) throw new Error('body too large'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('bad json'); }
}

server.listen(PORT, '127.0.0.1', () => console.log(`[launchpad] on 127.0.0.1:${PORT} promoCap=${PROMO_CAP} preseed=${PRESEED_BLOCK} BLOCK fee=$${FEE_PROMO_USD}/$${FEE_STD_USD} paypal=${paypal.configured() ? paypal.env() : 'OFF'}`));
