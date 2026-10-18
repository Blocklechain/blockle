// USDB (Blockle USD) issuance + reserve service — Modern Treasury rails.
//
// The licensed issuer (Alienbeing LLC) mints USDB against USD collected via
// Modern Treasury (ACH) and burns it on redemption, paying USD back out via MT.
// On-chain supply never exceeds custodied USD (supply <= reserves, fully backed).
// A FLAT 3.7% fee is taken on BOTH ramps (our margin; ACH costs pennies, so it
// settles to our MT account as revenue).
//
// This process holds the ISSUER key by PATH (box-only) and signs BLOCK-20S
// mint/burn/markRedeemed with the same ML-DSA wasm the wallets use. MT API
// credentials come from the env (box-only secrets); MT egress is forced to IPv4
// so it comes from our allow-listed address.
//
// SAFETY: USDB_ENABLED=0 -> buy/redeem return a dry-run and move nothing. Mints
// are SETTLEMENT-GATED: a buy's USDB is minted only when its ACH debit reaches
// `completed` in MT, so we never mint against money we haven't collected.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import * as mt from './modern_treasury.js';
import * as plaid from './plaid.js';

const require = createRequire(import.meta.url);
const wasm = require('../wasm/blockle_wasm.js');

const PORT = Number(process.env.USDB_PORT || 8801);
const DATA = process.env.USDB_DATA || '/var/lib/blockle-usdb';
const NODE = (process.env.USDB_NODE_URL || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const CONTRACT = (process.env.USDB_CONTRACT || '').trim();
const DECIMALS = Number(process.env.USDB_DECIMALS || 6);
const UNIT = 10 ** DECIMALS;
// FLAT fee, both ramps (basis points). Modern Treasury ACH is ~pennies, so this
// is our margin and settles to the MT internal account.
const FEE_BPS = Number(process.env.MT_FEE_BPS || process.env.USDB_FEE_BPS || 370); // 3.7%
const PER_TX_CAP_USD = Number(process.env.USDB_PER_TX_CAP_USD || 10000);
const DAILY_CAP_USD = Number(process.env.USDB_DAILY_CAP_USD || 100000);
const ENABLED = (process.env.USDB_ENABLED || '0') === '1';
const KYC_URL = (process.env.USDB_KYC_URL || '').trim();
const KYC_THRESHOLD_USD = Number(process.env.USDB_KYC_THRESHOLD_USD || 10_000_000);
const KEYPATH = (process.env.USDB_ISSUER_KEYPAIR || '').trim();
const GAS_LIMIT = BigInt(process.env.USDB_GAS_LIMIT || 150000);
const GAS_PRICE = BigInt(process.env.USDB_GAS_PRICE || 10);

let issuer = null;
function loadIssuer() {
  if (issuer) return issuer;
  if (!KEYPATH) return null;
  try { const kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8')); if (kp && kp.address && kp.publicKey && kp.secretKey) { issuer = kp; return issuer; } } catch { /* */ }
  return null;
}

fs.mkdirSync(DATA, { recursive: true });
const LEDGER = path.join(DATA, 'reserve-ledger.json');
function load() {
  let l; try { l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { l = {}; }
  return { reserveUsd: 0, issued: [], day: '', dayUsd: 0, volumeUsd: 0, pendingBuys: {}, redeemIntents: {}, paidRedeems: {}, ...l };
}
function save(l) { fs.writeFileSync(LEDGER, JSON.stringify(l)); }

function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
}
async function nodeGet(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('node ' + r.status); return r.json(); }
async function nodeRpc(method, params) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'usdb', method, params }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || (b && b.error)) throw new Error((b.error && (b.error.message || b.error)) || 'rpc failed');
  return b.result != null ? b.result : b;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;
function today() { return new Date(Date.now()).toISOString().slice(0, 10); }
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b.toString('hex'); }
function leU64(hex, off) { return Number(Buffer.from(hex, 'hex').readBigUInt64LE(off)); }

// FLAT 3.7% both ramps.
function buyQuote(usd) { const fee = round2((usd * FEE_BPS) / 10000); return { side: 'buy', payUsd: round2(usd), feeUsd: fee, feeBps: FEE_BPS, receiveUsdb: round2(usd - fee) }; }
function redeemQuote(usdb) { const fee = round2((usdb * FEE_BPS) / 10000); return { side: 'redeem', burnUsdb: round2(usdb), feeUsd: fee, feeBps: FEE_BPS, payoutUsd: round2(usdb - fee) }; }

async function onchainSupply() {
  if (!CONTRACT) return null;
  try { const t = await nodeRpc('tokeninfo', [{ contract: CONTRACT }]); const s = t && (t.totalSupply != null ? t.totalSupply : t.supply); return s != null ? Number(s) / UNIT : null; } catch { return null; }
}
async function issuerUtxos() { const k = loadIssuer(); const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(k.address)); return (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) })); }
// Confirm an issuer-signed tx by its BLOCK change returning to the issuer (the
// node doesn't index contract txs in /explorer/tx).
async function waitConf(txid) {
  const k = loadIssuer(); if (!k) throw new Error('issuer key not configured');
  for (let i = 0; i < 1200; i++) { try { const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(k.address)); if ((u.utxos || []).some((x) => x.txid === txid)) return; } catch { /* */ } await sleep(2000); }
  throw new Error('timed out confirming ' + txid);
}
async function callRead(calldataHex) { return nodeRpc('callcontract', [{ contract: CONTRACT, calldata: calldataHex }]); }

async function mintTo(to, base) {
  const k = loadIssuer(); if (!k) throw new Error('issuer key not configured');
  const built = JSON.parse(wasm.build_stablecoin_mint(k.secretKey, k.publicKey, JSON.stringify(await issuerUtxos()), CONTRACT, to, BigInt(base), GAS_LIMIT, GAS_PRICE));
  const sub = await nodeRpc('submitrawtransaction', [built.raw]); const txid = (sub && sub.txid) || built.txid; await waitConf(txid); return txid;
}
async function markRedeemed(id) {
  const k = loadIssuer(); if (!k) throw new Error('issuer key not configured');
  const input = '12' + u64le(id); // selector 18 (0x12) ‖ id(8 LE)
  const built = JSON.parse(wasm.build_call(k.secretKey, k.publicKey, JSON.stringify(await issuerUtxos()), CONTRACT, input, 0n, GAS_LIMIT, GAS_PRICE));
  const sub = await nodeRpc('submitrawtransaction', [built.raw]); const txid = (sub && sub.txid) || built.txid; await waitConf(txid); return txid;
}

function validBank(b) {
  return b && /^\d{9}$/.test(String(b.routingNumber || '')) && /^\d{4,17}$/.test(String(b.accountNumber || '')) && String(b.name || '').trim().length >= 2;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return j(res, 204, {});
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/usdb/info') {
      const l = load(); const supply = await onchainSupply(); const k = loadIssuer();
      return j(res, 200, {
        asset: 'USDB', name: 'Blockle USD', peg: 'USD', decimals: DECIMALS, contract: CONTRACT || null,
        rail: 'modern_treasury', mtEnv: mt.env(), mtConfigured: mt.configured(),
        fee: { flatBps: FEE_BPS, pct: FEE_BPS / 100, appliesTo: 'both ramps', note: '3.7% on buy and redeem; USD moves via Modern Treasury ACH' },
        exampleBuy100: buyQuote(100), exampleRedeem100: redeemQuote(100),
        perTxCapUsd: PER_TX_CAP_USD, dailyCapUsd: DAILY_CAP_USD,
        enabled: ENABLED, issuerReady: !!k, kyc: { configured: !!KYC_URL, requiredAtVolumeUsd: KYC_THRESHOLD_USD, requiredNow: l.volumeUsd >= KYC_THRESHOLD_USD && !KYC_URL },
        volumeUsd: l.volumeUsd, supply, reserveUsd: l.reserveUsd,
        fullyBacked: supply == null ? null : l.reserveUsd >= supply,
        note: ENABLED ? 'live — Modern Treasury ACH, 3.7% both ramps' : 'public issuance not enabled (USDB_ENABLED=0)',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/usdb/reserves') {
      const l = load(); const supply = await onchainSupply();
      return j(res, 200, { supplyUsdb: supply, reserveUsd: l.reserveUsd, deltaUsd: supply == null ? null : l.reserveUsd - supply, fullyBacked: supply == null ? null : l.reserveUsd >= supply, asOf: Date.now() });
    }

    // Plaid Link: mint a link token for the browser widget.
    if (req.method === 'POST' && url.pathname === '/api/usdb/plaid/link-token') {
      if (!plaid.configured()) return j(res, 503, { error: 'Plaid not configured' });
      let raw = ''; for await (const c of req) raw += c; let b = {}; try { b = JSON.parse(raw || '{}'); } catch { /* */ }
      try { return j(res, 200, await plaid.linkToken(b.userId || 'usdb-' + crypto.randomUUID())); }
      catch (e) { return j(res, 502, { error: 'plaid link token: ' + e.message }); }
    }
    // Plaid connect: public_token + account -> MT external account (Plaid-verified).
    if (req.method === 'POST' && url.pathname === '/api/usdb/plaid/connect') {
      if (!plaid.configured() || !mt.configured()) return j(res, 503, { error: 'Plaid/MT not configured' });
      let raw = ''; for await (const c of req) raw += c; let b = {}; try { b = JSON.parse(raw || '{}'); } catch { return j(res, 400, { error: 'bad json' }); }
      const publicToken = String(b.publicToken || '').trim(), accountId = String(b.accountId || '').trim(), name = String(b.name || 'USDB user').trim();
      if (!publicToken || !accountId) return j(res, 400, { error: 'publicToken + accountId required' });
      try {
        const { accessToken } = await plaid.exchange(publicToken);
        const proc = await plaid.mtProcessorToken(accessToken, accountId);
        const cp = await mt.createCounterpartyFromPlaid({ name, processorToken: proc, idemKey: 'plaid-' + crypto.randomUUID() });
        return j(res, 200, { ok: true, externalAccountId: cp.externalAccountId });
      } catch (e) { return j(res, 502, { error: 'plaid connect: ' + e.message }); }
    }

    if (req.method === 'POST' && (url.pathname === '/api/usdb/quote' || url.pathname === '/api/usdb/buy' || url.pathname === '/api/usdb/redeem')) {
      let raw = ''; for await (const c of req) raw += c;
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { return j(res, 400, { error: 'bad json' }); }
      const side = url.pathname.endsWith('/redeem') ? 'redeem' : (url.pathname.endsWith('/buy') ? 'buy' : (b.side === 'redeem' ? 'redeem' : 'buy'));
      const usd = Number(b.amountUsd || b.amount || b.amountUsdb || 0);
      if (!(usd > 0)) return j(res, 400, { error: 'amount must be positive' });
      if (usd > PER_TX_CAP_USD) return j(res, 400, { error: 'exceeds per-tx cap of $' + PER_TX_CAP_USD });
      const quote = side === 'buy' ? buyQuote(usd) : redeemQuote(usd);
      if (url.pathname === '/api/usdb/quote') return j(res, 200, quote);

      // --- money paths: gated + fail-closed ---
      if (!ENABLED) return j(res, 200, { dryRun: true, ...quote, note: 'DRY-RUN: public issuance is not enabled (USDB_ENABLED=0).' });
      if (!CONTRACT) return j(res, 503, { error: 'USDB contract not configured' });
      if (!loadIssuer()) return j(res, 503, { error: 'issuer signer not configured (fail-closed)' });
      if (!mt.configured()) return j(res, 503, { error: 'Modern Treasury rail not configured (fail-closed)' });
      const l = load();
      if (l.volumeUsd >= KYC_THRESHOLD_USD && !KYC_URL) return j(res, 503, { error: `KYC required beyond $${KYC_THRESHOLD_USD.toLocaleString()} volume (fail-closed)` });
      if (l.day !== today()) { l.day = today(); l.dayUsd = 0; }
      if (l.dayUsd + usd > DAILY_CAP_USD) return j(res, 429, { error: 'daily cap reached' });

      // The bank account is either a Plaid-connected MT external account id
      // (preferred) or manual bank details we turn into an MT counterparty.
      const hasExt = !!b.externalAccountId;
      if (!hasExt && !validBank(b.bank || {})) return j(res, 400, { error: 'connect a bank (Plaid) or provide bank {name, routingNumber(9), accountNumber}' });
      async function externalAccount(tag) {
        if (hasExt) return String(b.externalAccountId);
        const bank = b.bank;
        const cp = await mt.createCounterparty({ name: bank.name, routingNumber: bank.routingNumber, accountNumber: bank.accountNumber, accountType: bank.accountType || 'checking', email: bank.email, idemKey: tag + '-cp-' + crypto.randomUUID() });
        return cp.externalAccountId;
      }

      if (side === 'buy') {
        // ON-RAMP: pull USD from the buyer's bank via an ACH debit. USDB is minted
        // by the settlement watcher only when the debit reaches `completed`.
        const to = String(b.recipient || b.to || '').trim();
        if (!/^block1[0-9a-z]{20,}$/.test(to)) return j(res, 400, { error: 'recipient (block1 address) required' });
        let po;
        try {
          const ext = await externalAccount('buy');
          po = await mt.createPaymentOrder({ amountCents: Math.round(quote.payUsd * 100), direction: 'debit', externalAccountId: ext, description: 'USDB buy ' + quote.receiveUsdb, idemKey: 'buy-po-' + crypto.randomUUID() });
        } catch (e) { return j(res, 502, { error: 'Modern Treasury debit failed: ' + e.message }); }
        l.pendingBuys[po.id] = { recipient: to, grossUsd: quote.payUsd, receiveUsdb: quote.receiveUsdb, feeUsd: quote.feeUsd, t: Date.now() };
        l.dayUsd = round2(l.dayUsd + quote.payUsd); save(l);
        return j(res, 200, { ok: true, side, status: 'collecting', paymentOrderId: po.id, poStatus: po.status, receiveUsdb: quote.receiveUsdb, feeUsd: quote.feeUsd, note: 'ACH debit initiated; USDB is delivered to ' + to + ' once the payment settles.' });
      } else {
        // OFF-RAMP: register the redeemer's bank, return the payoutRef + amount the
        // WALLET signs into redeem(). The redeem watcher ACH-credits (net 3.7%)
        // once the on-chain burn is seen.
        let ext; try { ext = await externalAccount('rd'); } catch (e) { return j(res, 502, { error: 'Modern Treasury counterparty failed: ' + e.message }); }
        const ref = crypto.randomBytes(32).toString('hex');
        l.redeemIntents[ref] = { externalAccountId: ext, amountUsdb: usd, t: Date.now() };
        save(l);
        return j(res, 200, { ok: true, action: 'sign-redeem', contract: CONTRACT, payoutRef: ref, amountBase: Math.round(usd * UNIT), amountUsdb: usd, estPayoutUsd: quote.payoutUsd, feeUsd: quote.feeUsd, note: 'Sign redeem(payoutRef, amountBase) in your wallet; USD is ACH-credited to your bank once the burn confirms.' });
      }
    }
    return j(res, 404, { error: 'not found' });
  } catch (e) { return j(res, 500, { error: (e && e.message) || String(e) }); }
});

// ---- on-ramp settlement watcher: mint USDB once the ACH debit `completed` ----
let buyBusy = false;
async function processBuys() {
  if (buyBusy || !ENABLED || !CONTRACT || !loadIssuer() || !mt.configured()) return;
  buyBusy = true;
  try {
    const l = load();
    for (const [poId, p] of Object.entries(l.pendingBuys)) {
      let po; try { po = await mt.getPaymentOrder(poId); } catch { continue; }
      if (po.status === 'completed') {
        const base = Math.round(p.receiveUsdb * UNIT);
        const txid = await mintTo(p.recipient, base);
        const l2 = load();
        l2.reserveUsd = round2(l2.reserveUsd + p.receiveUsdb); l2.volumeUsd = round2(l2.volumeUsd + p.grossUsd);
        l2.issued.push({ t: Date.now(), side: 'buy', payUsd: p.grossUsd, feeUsd: p.feeUsd, usdb: p.receiveUsdb, to: p.recipient, txid, paymentOrderId: poId });
        delete l2.pendingBuys[poId]; save(l2);
        console.log('[usdb] buy settled ' + poId + ' -> minted ' + p.receiveUsdb + ' USDB to ' + p.recipient);
      } else if (['returned', 'failed', 'cancelled', 'reversed'].includes(po.status)) {
        const l2 = load(); delete l2.pendingBuys[poId]; save(l2);
        console.log('[usdb] buy ' + poId + ' ' + po.status + ' — no mint');
      }
    }
  } catch (e) { console.error('[usdb] buy watch: ' + (e && e.message)); } finally { buyBusy = false; }
}

// ---- off-ramp watcher: on an on-chain redeem, ACH-credit the payout + mark done ----
let redeemBusy = false;
async function processRedeems() {
  if (redeemBusy || !ENABLED || !CONTRACT || !loadIssuer() || !mt.configured()) return;
  redeemBusy = true;
  try {
    const cnt = await callRead('10'); const count = cnt && cnt.u64 != null ? Number(cnt.u64) : 0;
    for (let id = 0; id < count; id++) {
      let l = load(); if (l.paidRedeems[id]) continue;
      const rec = await callRead('11' + u64le(id)); const hex = rec && rec.returnHex; if (!hex || hex.length < 160) continue;
      if (leU64(hex, 72) === 1) { l.paidRedeems[id] = { already: true, t: Date.now() }; save(l); continue; }
      const ref = hex.slice(64, 128); const amountBase = leU64(hex, 64);
      const intent = l.redeemIntents[ref]; if (!intent) continue; // bank not registered yet
      const usdb = amountBase / UNIT; const q = redeemQuote(usdb);
      l.paidRedeems[id] = { pending: true, ref, usdb, t: Date.now() }; save(l); // claim before paying
      let po; try { po = await mt.createPaymentOrder({ amountCents: Math.round(q.payoutUsd * 100), direction: 'credit', externalAccountId: intent.externalAccountId, description: 'USDB redeem ' + usdb, idemKey: 'rd-po-' + id }); }
      catch (e) { const lr = load(); delete lr.paidRedeems[id]; save(lr); console.error('[usdb] payout failed id ' + id + ': ' + e.message); break; }
      let markTxid = null; try { markTxid = await markRedeemed(id); } catch (e) { console.error('[usdb] markRedeemed ' + id + ' failed (payout sent): ' + e.message); }
      const l3 = load();
      l3.paidRedeems[id] = { paid: true, ref, usdb, payoutUsd: q.payoutUsd, paymentOrderId: po.id, markTxid, t: Date.now() };
      l3.reserveUsd = round2(Math.max(0, l3.reserveUsd - usdb)); l3.volumeUsd = round2(l3.volumeUsd + usdb);
      delete l3.redeemIntents[ref]; save(l3);
      console.log('[usdb] redeem id ' + id + ': ' + usdb + ' USDB -> $' + q.payoutUsd + ' ACH credit ' + po.id);
    }
  } catch (e) { console.error('[usdb] redeem watch: ' + (e && e.message)); } finally { redeemBusy = false; }
}
setInterval(() => { processBuys().catch(() => {}); }, 30000);
setInterval(() => { processRedeems().catch(() => {}); }, 30000);

server.listen(PORT, '127.0.0.1', () => {
  const k = loadIssuer();
  console.log(`[usdb] on 127.0.0.1:${PORT} enabled=${ENABLED} rail=modern_treasury(${mt.env()}) fee=${FEE_BPS}bps issuer=${k ? k.address : '(unset)'} contract=${CONTRACT || '(unset)'}`);
});
