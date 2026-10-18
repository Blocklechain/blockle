// USDB (Blockle USD) issuance + reserve service.
//
// The licensed issuer (ALienbeing LLC) mints USDB against VERIFIED USD reserves
// and burns it on redemption, so on-chain supply never exceeds custodied USD
// (supply <= reserves, fully backed). A small mint/redeem fee is the issuer's
// margin, taken on the fiat side so it never mints unbacked tokens.
//
// This process holds the ISSUER key by PATH (box-only, chmod 600) and signs
// BLOCK-20S mint/burn calls with the SAME ML-DSA wasm the wallets use (vendored
// at ./wasm). The key never enters any other service and is never logged.
//
// SAFETY POSTURE (money + regulated product — public issuance OFF by default):
//   * USDB_ENABLED defaults 0 -> the PUBLIC buy/redeem endpoints return an
//     honest DRY-RUN plan and mint/burn NOTHING. The operator flips it on only
//     AFTER the fiat deposit rail + reserve custody + KYC/sanctions verifier are
//     wired, so no USDB is ever minted against uncollected or unscreened USD.
//   * Every real mint requires a verified USD-deposit reference; every real burn
//     (redeem) requires the user's USDB-return txid to the treasury, confirmed
//     on-chain. Missing either => fail-closed (nothing issued).
//   * supply <= reserveUsd is the invariant: a buy records the GROSS USD to
//     reserves and mints the NET (fee is margin, so reserves over-cover supply).
//   * Per-tx + daily issuance caps bound the blast radius. The proof-of-reserves
//     endpoint compares live on-chain supply vs recorded USD backing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as paypal from './paypal.js';

const require = createRequire(import.meta.url);
// ML-DSA signer / tx builder — same wasm the wallets use, vendored next to this
// service as ./wasm (pkg-node build) at deploy time. Exposes build_stablecoin_mint
// / build_stablecoin_burn (issuer-signed BLOCK-20S selectors 7/8).
const wasm = require('../wasm/blockle_wasm.js');

const PORT = Number(process.env.USDB_PORT || 8801);
const DATA = process.env.USDB_DATA || '/var/lib/blockle-usdb';
const NODE = (process.env.USDB_NODE_URL || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const CONTRACT = (process.env.USDB_CONTRACT || '').trim();     // deployed USDB contract id (64 hex)
const DECIMALS = Number(process.env.USDB_DECIMALS || 6);
const UNIT = 10 ** DECIMALS;
// Buy pricing: the buyer pays via PayPal, so the quote PASSES THROUGH PayPal's
// processing fee (so the issuer never nets less than the USDB it backs) and adds
// OUR margin on top. PayPal's published goods-&-services rate defaults to
// 2.9% + $0.30 (override per the account's actual rate); our margin is 0.5% of
// the post-PayPal net. USDB received = reserves credited (fully backed).
const PAYPAL_PCT_BPS = Number(process.env.USDB_PAYPAL_PCT_BPS || 290);   // 2.9%
const PAYPAL_FIXED_USD = Number(process.env.USDB_PAYPAL_FIXED_USD || 0.30);
const BUY_MARGIN_BPS = Number(process.env.USDB_BUY_MARGIN_BPS || 50);    // our 0.50% on-ramp
// Redeem (off-ramp) mirrors the buy: pass through PayPal's PAYOUT fee (US
// domestic default 2% capped at $1.00) + OUR 0.50% margin, both borne by the
// redeemer. Reserves are debited the full burned amount; our margin is profit.
const REDEEM_MARGIN_BPS = Number(process.env.USDB_REDEEM_MARGIN_BPS || 50);       // our 0.50% off-ramp
const PAYPAL_PAYOUT_PCT_BPS = Number(process.env.USDB_PAYPAL_PAYOUT_PCT_BPS || 200); // 2%
const PAYPAL_PAYOUT_CAP_USD = Number(process.env.USDB_PAYPAL_PAYOUT_CAP_USD || 1.0); // $1 cap
const PER_TX_CAP_USD = Number(process.env.USDB_PER_TX_CAP_USD || 10000);
const DAILY_CAP_USD = Number(process.env.USDB_DAILY_CAP_USD || 100000);
const ENABLED = (process.env.USDB_ENABLED || '0') === '1';      // master gate for REAL public mint/burn
const KYC_URL = (process.env.USDB_KYC_URL || '').trim();         // sanctions/KYC verifier
// Regulatory posture: the issuer is cleared to operate KYC-FREE until cumulative
// volume reaches this threshold ($10M). At/above it, KYC becomes mandatory and
// issuance fails closed until USDB_KYC_URL is configured. Self-funding model:
// reserves accrue from each sale's captured PayPal payment (not pre-funded), so
// supply stays <= reserves without any up-front float.
const KYC_THRESHOLD_USD = Number(process.env.USDB_KYC_THRESHOLD_USD || 10_000_000);
const KEYPATH = (process.env.USDB_ISSUER_KEYPAIR || '').trim();  // issuer wallet {address,publicKey,secretKey} (box-only)
const GAS_LIMIT = BigInt(process.env.USDB_GAS_LIMIT || 120000);  // mint/burn gas
const GAS_PRICE = BigInt(process.env.USDB_GAS_PRICE || 10);      // mainnet gas_price
const CONF_TARGET = Number(process.env.USDB_CONF_TARGET || 1);   // confirmations before "done"

// Issuer key is OPTIONAL at boot (service runs read-only/dry-run without it) but
// REQUIRED before any real mint/burn. Load lazily + fail-closed if missing.
let issuer = null;
function loadIssuer() {
  if (issuer) return issuer;
  if (!KEYPATH) return null;
  try {
    const kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
    if (kp && kp.address && kp.publicKey && kp.secretKey) { issuer = kp; return issuer; }
  } catch { /* fall through */ }
  return null;
}
const TREASURY = (process.env.USDB_TREASURY || '').trim(); // where redeemers send USDB to be burned (default: issuer addr)
function treasuryAddr() { const k = loadIssuer(); return TREASURY || (k && k.address) || ''; }

fs.mkdirSync(DATA, { recursive: true });
const LEDGER = path.join(DATA, 'reserve-ledger.json');
function load() {
  let l; try { l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { l = {}; }
  return { reserveUsd: 0, issued: [], day: '', dayUsd: 0, volumeUsd: 0, consumed: {}, pending: {}, ...l };
}
function save(l) { fs.writeFileSync(LEDGER, JSON.stringify(l)); }

function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
}
async function nodeGet(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('node ' + r.status); return r.json(); }
async function nodeRpc(method, params) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'usdb', method, params }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || (body && body.error)) throw new Error((body.error && (body.error.message || body.error)) || 'rpc failed');
  return body.result != null ? body.result : body;
}
function today() { return new Date(Date.now()).toISOString().slice(0, 10); }
function net(usd, bps) { return usd - (usd * bps) / 10000; }
function round2(x) { return Math.round(x * 100) / 100; }

// Buy pricing. The buyer pays `pay` USD through PayPal. PayPal takes its
// processing fee off the top; of what lands in our account we keep OUR margin
// and back the rest 1:1 with minted USDB (so reserves credited == USDB minted,
// fully backed). PayPal fee + our margin are both borne by the buyer.
function buyFromPay(pay) {
  const paypalFee = (pay * PAYPAL_PCT_BPS) / 10000 + PAYPAL_FIXED_USD;
  const netAfterPaypal = Math.max(0, pay - paypalFee);
  const ourFee = (netAfterPaypal * BUY_MARGIN_BPS) / 10000;
  const receiveUsdb = Math.max(0, netAfterPaypal - ourFee);
  return { side: 'buy', payUsd: round2(pay), paypalFeeUsd: round2(paypalFee), ourFeeUsd: round2(ourFee), feeUsd: round2(paypalFee + ourFee), receiveUsdb: round2(receiveUsdb) };
}
// Inverse: the buyer wants `want` USDB — solve for the USD they must pay so that,
// after PayPal + our margin, exactly `want` USD backs the minted USDB.
function buyFromUsdb(want) {
  const m = BUY_MARGIN_BPS / 10000, pct = PAYPAL_PCT_BPS / 10000;
  const netAfterPaypal = want / (1 - m);
  const pay = (netAfterPaypal + PAYPAL_FIXED_USD) / (1 - pct);
  return buyFromPay(pay);
}
// Redeem quote: burn `burn` USDB ($burn), pay out via PayPal minus PayPal's
// payout fee and our 0.5% margin.
function redeemQuote(burn) {
  const paypalFee = Math.min((burn * PAYPAL_PAYOUT_PCT_BPS) / 10000, PAYPAL_PAYOUT_CAP_USD);
  const ourFee = (burn * REDEEM_MARGIN_BPS) / 10000;
  const payoutUsd = Math.max(0, burn - paypalFee - ourFee);
  return { side: 'redeem', burnUsdb: round2(burn), paypalFeeUsd: round2(paypalFee), ourFeeUsd: round2(ourFee), feeUsd: round2(paypalFee + ourFee), payoutUsd: round2(payoutUsd) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On-chain USDB supply (whole USDB) via the stablecoin contract's totalSupply
// (BLOCK-20S selector 3), read through the node's `tokeninfo` RPC.
async function onchainSupply() {
  if (!CONTRACT) return null;
  try {
    const t = await nodeRpc('tokeninfo', [{ contract: CONTRACT }]);
    const sup = t && (t.totalSupply != null ? t.totalSupply : t.supply);
    return sup != null ? Number(sup) / UNIT : null;
  } catch { return null; }
}
async function balanceOfBase(addr) {
  const t = await nodeRpc('tokeninfo', [{ contract: CONTRACT, holder: addr }]);
  const b = t && (t.balance != null ? t.balance : t.balanceOf);
  return b != null ? Number(b) : 0;
}
async function issuerUtxos() {
  const k = loadIssuer();
  const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(k.address));
  return (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
}
async function waitConf(txid, n) {
  for (let i = 0; i < 1200; i++) { // ~40 min budget (mainnet ~10-min blocks)
    try { const t = await nodeGet('/explorer/tx/' + encodeURIComponent(txid));
      const c = (t && t.tx && t.tx.confirmations) || t.confirmations || 0;
      if (c >= n) return c;
    } catch { /* keep polling */ }
    await sleep(2000);
  }
  throw new Error('timed out waiting for ' + n + ' confirmation(s) of ' + txid);
}

// Issuer-signed mint of `base` USDB base units to `to` (block1 addr). Pays only
// gas from the issuer wallet; reverts at the node if the signer isn't the issuer.
async function mintTo(to, base) {
  const k = loadIssuer(); if (!k) throw new Error('issuer key not configured');
  const utxos = await issuerUtxos();
  const built = JSON.parse(wasm.build_stablecoin_mint(k.secretKey, k.publicKey, JSON.stringify(utxos), CONTRACT, to, BigInt(base), GAS_LIMIT, GAS_PRICE));
  const sub = await nodeRpc('submitrawtransaction', [built.raw]);
  const txid = (sub && sub.txid) || built.txid;
  await waitConf(txid, CONF_TARGET);
  return txid;
}
async function burnFrom(from, base) {
  const k = loadIssuer(); if (!k) throw new Error('issuer key not configured');
  const utxos = await issuerUtxos();
  const built = JSON.parse(wasm.build_stablecoin_burn(k.secretKey, k.publicKey, JSON.stringify(utxos), CONTRACT, from, BigInt(base), GAS_LIMIT, GAS_PRICE));
  const sub = await nodeRpc('submitrawtransaction', [built.raw]);
  const txid = (sub && sub.txid) || built.txid;
  await waitConf(txid, CONF_TARGET);
  return txid;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return j(res, 204, {});
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/usdb/info') {
      const l = load();
      const supply = await onchainSupply();
      const k = loadIssuer();
      return j(res, 200, {
        asset: 'USDB', name: 'Blockle USD', peg: 'USD', decimals: DECIMALS,
        contract: CONTRACT || null, treasury: treasuryAddr() || null,
        buyFee: { paypalPctBps: PAYPAL_PCT_BPS, paypalFixedUsd: PAYPAL_FIXED_USD, ourMarginBps: BUY_MARGIN_BPS, rail: 'paypal',
          note: 'on-ramp quote passes through PayPal processing fee + our 0.5% margin; USDB received is fully backed' },
        redeemFee: { paypalPayoutPctBps: PAYPAL_PAYOUT_PCT_BPS, paypalPayoutCapUsd: PAYPAL_PAYOUT_CAP_USD, ourMarginBps: REDEEM_MARGIN_BPS, rail: 'paypal',
          note: 'off-ramp payout passes through PayPal payout fee + our 0.5% margin' },
        exampleBuy100: buyFromPay(100), exampleRedeem100: redeemQuote(100),
        perTxCapUsd: PER_TX_CAP_USD, dailyCapUsd: DAILY_CAP_USD,
        enabled: ENABLED, issuerReady: !!k, rail: 'paypal', paypalConfigured: paypal.configured(), paypalEnv: paypal.env(),
        kyc: { configured: !!KYC_URL, requiredAtVolumeUsd: KYC_THRESHOLD_USD, requiredNow: l.volumeUsd >= KYC_THRESHOLD_USD && !KYC_URL },
        volumeUsd: l.volumeUsd,
        supply, reserveUsd: l.reserveUsd,
        fullyBacked: supply == null ? null : l.reserveUsd >= supply,
        note: ENABLED ? 'live — self-funding (reserves accrue from PayPal-captured sales); KYC-free until $' + KYC_THRESHOLD_USD.toLocaleString() + ' volume' : 'public issuance not enabled — buy/redeem return a dry-run plan and mint/burn nothing',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/usdb/reserves') {
      // Proof-of-reserves: on-chain USDB supply vs recorded USD backing.
      const l = load();
      const supply = await onchainSupply();
      return j(res, 200, {
        supplyUsdb: supply, reserveUsd: l.reserveUsd,
        deltaUsd: supply == null ? null : (l.reserveUsd - supply),
        fullyBacked: supply == null ? null : l.reserveUsd >= supply,
        asOf: Date.now(),
      });
    }

    // Start a PayPal checkout for a buy: create a CAPTURE order for the GROSS
    // payUsd (so the quote's receiveUsdb ends up fully backed). The client opens
    // approveUrl, the buyer pays, then POSTs the orderId to /api/usdb/buy.
    if (req.method === 'POST' && url.pathname === '/api/usdb/paypal/create') {
      let raw = ''; for await (const c of req) raw += c;
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { return j(res, 400, { error: 'bad json' }); }
      if (!ENABLED) return j(res, 200, { dryRun: true, note: 'public issuance not enabled' });
      if (!paypal.configured()) return j(res, 503, { error: 'PayPal rail not configured' });
      const to = String(b.recipient || b.to || '').trim();
      if (!/^block1[0-9a-z]{20,}$/.test(to)) return j(res, 400, { error: 'recipient (block1 address) required' });
      const q = b.amountUsdb > 0 ? buyFromUsdb(Number(b.amountUsdb)) : buyFromPay(Number(b.amountUsd || b.amount || 0));
      if (!(q.payUsd > 0)) return j(res, 400, { error: 'amount must be positive' });
      if (q.payUsd > PER_TX_CAP_USD) return j(res, 400, { error: 'exceeds per-tx cap of $' + PER_TX_CAP_USD });
      try {
        const o = await paypal.createOrder(q.payUsd, { description: `Buy ${q.receiveUsdb} USDB`, returnUrl: b.returnUrl, cancelUrl: b.cancelUrl });
        // Bind the recipient to the order server-side so the PayPal return only
        // needs the order id (no block1 address rides in the redirect URL).
        const l = load(); l.pending[o.orderId] = { recipient: to, payUsd: q.payUsd, t: Date.now() }; save(l);
        return j(res, 200, { ...o, quote: q, recipient: to });
      } catch (e) { return j(res, 502, { error: 'PayPal order create failed: ' + e.message }); }
    }

    if (req.method === 'POST' && (url.pathname === '/api/usdb/quote' || url.pathname === '/api/usdb/buy' || url.pathname === '/api/usdb/redeem')) {
      let raw = ''; for await (const c of req) raw += c;
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { return j(res, 400, { error: 'bad json' }); }
      const side = url.pathname.endsWith('/redeem') ? 'redeem' : (url.pathname.endsWith('/buy') ? 'buy' : (b.side === 'redeem' ? 'redeem' : 'buy'));

      // BUY: `amountUsd` is what the buyer pays via PayPal; `amountUsdb` (optional)
      // lets them instead request a target USDB amount. REDEEM: `amount(Usd)` is
      // the USDB they burn (in USD terms, 1:1) for a USD payout minus our fee.
      let quote;
      if (side === 'buy') {
        quote = b.amountUsdb > 0 ? buyFromUsdb(Number(b.amountUsdb)) : buyFromPay(Number(b.amountUsd || b.amount || 0));
        if (!(quote.payUsd > 0)) return j(res, 400, { error: 'amount (USD) must be positive' });
        if (quote.payUsd > PER_TX_CAP_USD) return j(res, 400, { error: 'exceeds per-tx cap of $' + PER_TX_CAP_USD });
      } else {
        const usd = Number(b.amountUsd || b.amount || b.amountUsdb || 0);
        if (!(usd > 0)) return j(res, 400, { error: 'amount (USDB) must be positive' });
        if (usd > PER_TX_CAP_USD) return j(res, 400, { error: 'exceeds per-tx cap of $' + PER_TX_CAP_USD });
        quote = redeemQuote(usd);
      }

      if (url.pathname === '/api/usdb/quote') return j(res, 200, quote);
      const usd = side === 'buy' ? quote.payUsd : quote.burnUsdb;

      // --- money paths: gated + fail-closed ---
      if (!ENABLED) {
        return j(res, 200, { dryRun: true, ...quote, note: 'DRY-RUN: public issuance is not enabled (USDB_ENABLED=0). No USDB minted/burned, no reserve moved.' });
      }
      if (!CONTRACT) return j(res, 503, { error: 'USDB contract not configured' });
      if (!loadIssuer()) return j(res, 503, { error: 'issuer signer not configured — refusing to issue (fail-closed)' });
      if (!paypal.configured()) return j(res, 503, { error: 'PayPal rail not configured — refusing to issue (fail-closed)' });
      const l = load();
      // KYC becomes mandatory only once cumulative volume reaches the threshold.
      if (l.volumeUsd >= KYC_THRESHOLD_USD && !KYC_URL) {
        return j(res, 503, { error: `KYC required beyond $${KYC_THRESHOLD_USD.toLocaleString()} cumulative volume — configure USDB_KYC_URL (fail-closed)` });
      }
      // daily cap
      if (l.day !== today()) { l.day = today(); l.dayUsd = 0; }
      if (l.dayUsd + usd > DAILY_CAP_USD) return j(res, 429, { error: 'daily issuance cap reached' });

      if (side === 'buy') {
        // Real mint, tied to a captured PayPal payment. `orderId` is the PayPal
        // CAPTURE order the buyer paid; we capture + verify it covers payUsd in
        // USD and COMPLETED, reject replays, THEN mint. Self-funding: the payment
        // IS the backing, so reserves += the minted (backed) amount.
        const orderId = String(b.orderId || b.depositRef || '').trim();
        const to = String(b.recipient || b.to || (l.pending[orderId] && l.pending[orderId].recipient) || '').trim();
        if (!orderId) return j(res, 402, { error: 'PayPal orderId required (create one via /api/usdb/paypal/create, have the buyer approve+pay, then submit it here)' });
        if (!/^block1[0-9a-z]{20,}$/.test(to)) return j(res, 400, { error: 'recipient (block1 address) required' });
        if (l.consumed[orderId]) return j(res, 409, { error: 'this PayPal order was already redeemed for USDB' });
        let cap; try { cap = await paypal.captureOrder(orderId); } catch (e) { return j(res, 402, { error: 'PayPal capture failed: ' + e.message }); }
        if (!paypal.captureOk(cap, quote.payUsd)) {
          return j(res, 402, { error: 'PayPal payment not verified (need COMPLETED, USD, >= $' + quote.payUsd + '); got ' + JSON.stringify({ status: cap.status, captureStatus: cap.captureStatus, value: cap.value, currency: cap.currency }) });
        }
        l.consumed[orderId] = { t: Date.now(), value: cap.value, captureId: cap.captureId }; save(l); // mark consumed BEFORE mint (no double-mint even on retry)
        const base = Math.round(quote.receiveUsdb * UNIT);
        const txid = await mintTo(to, base);
        l.reserveUsd = round2(l.reserveUsd + quote.receiveUsdb); l.dayUsd = round2(l.dayUsd + quote.payUsd); l.volumeUsd = round2(l.volumeUsd + quote.payUsd);
        l.issued.push({ t: Date.now(), side, payUsd: quote.payUsd, paypalFeeUsd: quote.paypalFeeUsd, ourFeeUsd: quote.ourFeeUsd, usdb: base / UNIT, to, txid, orderId, captureId: cap.captureId });
        delete l.pending[orderId];
        save(l);
        return j(res, 200, { ok: true, side, txid, mintedUsdb: base / UNIT, payUsd: quote.payUsd, paypalFeeUsd: quote.paypalFeeUsd, ourFeeUsd: quote.ourFeeUsd, reserveUsd: l.reserveUsd });
      } else {
        // Real redeem: the user SENDS USDB back to the treasury (returnTxid) and
        // gives a PayPal email. We confirm the treasury holds the USDB, PAY OUT
        // first (PayPal Payouts), then burn — so we never burn without having paid.
        const returnTxid = String(b.returnTxid || '').trim();
        const email = String(b.payoutEmail || b.email || '').trim();
        if (!returnTxid) return j(res, 402, { error: 'returnTxid (USDB sent to treasury) required (fail-closed)' });
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j(res, 400, { error: 'payoutEmail (PayPal) required' });
        const tre = treasuryAddr(); if (!tre) return j(res, 503, { error: 'treasury not configured' });
        const base = Math.round(usd * UNIT);
        const bal = await balanceOfBase(tre);
        if (bal < base) return j(res, 409, { error: 'treasury has not received the USDB to burn yet (send USDB to ' + tre + ' first)' });
        let pay; try { pay = await paypal.payout(email, quote.payoutUsd, 'USDB redemption'); } catch (e) { return j(res, 502, { error: 'PayPal payout failed (nothing burned): ' + e.message }); }
        const txid = await burnFrom(tre, base);
        l.reserveUsd = round2(Math.max(0, l.reserveUsd - usd)); l.dayUsd = round2(l.dayUsd + usd); l.volumeUsd = round2(l.volumeUsd + usd);
        l.issued.push({ t: Date.now(), side, usd, usdb: base / UNIT, from: tre, returnTxid, burnTxid: txid, payoutUsd: quote.payoutUsd, payoutBatch: pay.batchId });
        save(l);
        return j(res, 200, { ok: true, side, txid, burnedUsdb: base / UNIT, payoutUsd: quote.payoutUsd, payoutBatch: pay.batchId, reserveUsd: l.reserveUsd, feeUsd: quote.feeUsd });
      }
    }
    return j(res, 404, { error: 'not found' });
  } catch (e) { return j(res, 500, { error: (e && e.message) || String(e) }); }
});
server.listen(PORT, '127.0.0.1', () => {
  const k = loadIssuer();
  console.log(`[usdb] issuance on 127.0.0.1:${PORT} enabled=${ENABLED} issuer=${k ? k.address : '(unset)'} contract=${CONTRACT || '(unset)'} buy=paypal(${PAYPAL_PCT_BPS}bps+$${PAYPAL_FIXED_USD})+${BUY_MARGIN_BPS}bps redeem=paypal(${PAYPAL_PAYOUT_PCT_BPS}bps cap$${PAYPAL_PAYOUT_CAP_USD})+${REDEEM_MARGIN_BPS}bps`);
});
