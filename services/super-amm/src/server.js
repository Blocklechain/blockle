// server.js — HTTP API + live engine for the shared-price BLOCK AMM.
//
// PAPER mode (AMM_PAPER=1): synchronous /amm/trade moves the pool + ledger, no real
// funds. Proves the curve/UI. LIVE mode (AMM_PAPER=0): real custody via the intent
// lifecycle — POST /amm/intent returns a deposit address + a locked quote; a settle
// loop watches deposits, executes on the ACTUAL funded amount (refunding on slippage),
// pays out, and a solvency loop auto-pauses if the pool ever holds less than it owes.
//
// Base chains only: BLOCK, SOL, ETH, BTC, LTC, DOGE (no tokens).
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const A = require('./amm.js');
const I = require('./intents.js');
const S = require('./solvency.js');
const { createOracle } = require('./oracle.js');
const { createStore } = require('./store.js');
const { createCustody } = require('./custody.js');

const PAPER = (process.env.AMM_PAPER ?? '1') !== '0';
const LIVE = !PAPER;
const PORT = Number(process.env.AMM_PORT || 8806);
const FEE_BPS = BigInt(process.env.AMM_FEE_BPS || 50);          // 0.5%
const SEED_BLOCK = Number(process.env.AMM_SEED_BLOCK || 100000);
const SEED_PRICE = Number(process.env.AMM_SEED_PRICE || 0.10);
// Optional base-unit seed (allows fractional BLOCK, e.g. seed less than you fund so
// payout network fees don't trip solvency). Overrides AMM_SEED_BLOCK when set.
const SEED_BLOCK_BASE = process.env.AMM_SEED_BLOCK_BASE ? BigInt(process.env.AMM_SEED_BLOCK_BASE) : null;
// Per-asset solvency dust tolerance (absorbs accrued on-chain payout fees).
const TOL = {};
if (process.env.AMM_SOLVENCY_TOL_BLOCK_BASE) TOL.BLOCK = BigInt(process.env.AMM_SOLVENCY_TOL_BLOCK_BASE);
const STATE_FILE = process.env.AMM_STATE_FILE || (__dirname + '/../data/amm.json');
function makeSeed() {
  if (SEED_BLOCK_BASE != null) {
    const rUsd = BigInt(Math.round((Number(SEED_BLOCK_BASE) / 1e8) * SEED_PRICE * 1e6));
    return { rBlock: SEED_BLOCK_BASE, rUsd, custody: {} };
  }
  return A.seed(SEED_BLOCK, SEED_PRICE);
}

// Base-chain assets + their display network. BLOCK is the hub; the rest are quote legs.
const ASSETS = {
  BLOCK: { decimals: 8, chain: 'blockle', network: 'Blockle' },
  SOL: { decimals: 9, chain: 'solana', network: 'Solana' },
  ETH: { decimals: 18, chain: 'ethereum', network: 'Ethereum' },
  BTC: { decimals: 8, chain: 'bitcoin', network: 'Bitcoin' },
  LTC: { decimals: 8, chain: 'litecoin', network: 'Litecoin' },
  DOGE: { decimals: 8, chain: 'dogecoin', network: 'Dogecoin' },
};
const QUOTE_SYMS = Object.keys(ASSETS).filter((s) => s !== 'BLOCK');
const CFG = { feeBps: FEE_BPS, assets: ASSETS };

const oracle = createOracle({
  mode: process.env.AMM_ORACLE_MODE || (PAPER ? 'paper' : 'live'),
  static: { SOL: 180_000_000n, ETH: 3000_000_000n, BTC: 68000_000_000n, LTC: 70_000_000n, DOGE: 250_000n },
});
const store = createStore(STATE_FILE, makeSeed());
const custody = createCustody({ block: {} }); // reads AMM_BLOCK_* env for key/node

// ---- response helpers ------------------------------------------------------
function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}
function j(res, code, obj) {
  cors(res); res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
const USYM = (s) => String(s || '').toUpperCase();

function pairsView(state) {
  oracle.ensureFresh();
  return QUOTE_SYMS.map((sym) => {
    const custodyBase = state.custody[sym] || 0n;
    let maxSell = 0n;
    try { maxSell = A.maxSellableBlock(state, sym, CFG, oracle.map()); } catch {}
    return {
      pair: 'BLOCK/' + sym, sym, network: ASSETS[sym].network, chain: ASSETS[sym].chain,
      decimals: ASSETS[sym].decimals, oracleMicroUsd: oracle.get(sym) ?? null,
      custodyBase, maxSellableBlockBase: maxSell, hasLiquidity: custodyBase > 0n,
      live: LIVE ? custody.ready(sym) : true, // tradeable leg in live mode needs a ready adapter
    };
  });
}
function info() {
  const s = store.getState();
  return {
    paper: PAPER, live: LIVE, feeBps: Number(FEE_BPS), blockDecimals: A.BLOCK_DECIMALS,
    priceUsd: A.priceUsd(s), priceMicroUsd: A.priceMicroUsd(s), rBlock: s.rBlock, rUsd: s.rUsd,
    seed: { block: SEED_BLOCK, priceUsd: SEED_PRICE }, pairs: pairsView(s),
    paused: store.isPaused(), stats: store.stats(),
    readyAssets: LIVE ? ['BLOCK', ...QUOTE_SYMS.filter((s2) => custody.ready(s2))] : null,
    note: PAPER ? 'PAPER — no real funds move; curve/price/liquidity are live.' : (store.isPaused() ? 'LIVE — PAUSED by solvency monitor.' : 'LIVE'),
  };
}

// ---- live settle + solvency loops -----------------------------------------
let looping = false;
async function settleLoop() {
  if (!LIVE || looping) return; looping = true;
  try {
    const now = Date.now();
    // 1) expire stale awaiting intents
    for (const it of store.listIntents('awaiting_deposit')) {
      if (I.isExpired(it, now)) store.putIntent(I.markExpired(it));
    }
    // 2) watch deposits per ready asset, match to awaiting intents (FIFO, exact-or-greater)
    for (const sym of ['BLOCK', ...QUOTE_SYMS]) {
      const ad = custody.get(sym); if (!ad || !ad.ready()) continue;
      let res; try { res = await ad.listDeposits(store.getCursor(sym)); } catch { continue; }
      if (res && res.cursor) store.setCursor(sym, res.cursor);
      for (const dep of (res && res.deposits) || []) {
        if (store.isClaimed(dep.txid)) continue;
        const waiting = store.listIntents('awaiting_deposit')
          .filter((it) => it.depositAsset === sym && BigInt(dep.amountBase) >= BigInt(it.amountInBase))
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!waiting) continue;
        store.claim(dep.txid, waiting.id);
        let it = I.markFunded(waiting, dep.amountBase, dep.txid);
        store.putIntent(it);
      }
    }
    // 3) execute funded intents, pay out
    for (let it of store.listIntents('funded')) {
      let r;
      try { r = I.execute(it, store.getState(), CFG, oracle.map(), { paused: store.isPaused() }); }
      catch (e) {
        if (e.code === 'REFUND' || e.code === 'PAUSED') {
          store.putIntent(I.markRefund(it, (e.reason || e.code)));
          store.appendTrade({ t: now, kind: 'refund', id: it.id, asset: it.depositAsset, amount: it.fundedAmountBase, reason: e.reason || e.code });
          continue;
        }
        continue; // transient; retry next tick
      }
      store.setState(r.poolState);
      const payAd = custody.get(r.payoutAsset);
      try {
        const out = await payAd.payout(it.payoutAddress, BigInt(r.payoutBase));
        it = I.markSettled(I.markPaid(r.intent, out.txid));
        store.putIntent(it);
        store.appendTrade({ t: now, kind: it.side, id: it.id, sym: it.sym, in: it.fundedAmountBase,
          outAsset: r.payoutAsset, out: r.payoutBase, payoutTxid: out.txid,
          priceAfterUsd: Number(it.executedPriceMicroUsd) / 1e6 });
      } catch (e) {
        // executed on the curve but payout failed — mark executed (retry payout next tick)
        store.putIntent(r.intent);
      }
    }
  } finally { looping = false; }
}
async function solvencyLoop() {
  if (!LIVE) return;
  const state = store.getState();
  const observed = {};
  for (const sym of ['BLOCK', ...QUOTE_SYMS]) {
    const ad = custody.get(sym); if (!ad || !ad.ready()) continue;
    try { observed[sym] = await ad.observedBalanceBase(); } catch { /* skip; can't confirm */ }
  }
  const rep = S.check(state, observed, TOL);
  if (rep.shouldPause && !store.isPaused()) { store.setPaused(true); console.log('[super-amm] SOLVENCY PAUSE', JSON.stringify(rep.rows)); }
}

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/health') return j(res, 200, { ok: true, paper: PAPER, live: LIVE, paused: store.isPaused() });
    if (p === '/amm/info') return j(res, 200, info());
    if (p === '/amm/pairs') return j(res, 200, { pairs: pairsView(store.getState()) });
    if (p === '/amm/ledger') return j(res, 200, { trades: store.ledger(Number(url.searchParams.get('limit') || 100)) });

    if (p === '/amm/quote') {
      oracle.ensureFresh();
      const side = url.searchParams.get('side'); const sym = USYM(url.searchParams.get('sym'));
      const amount = BigInt(url.searchParams.get('amount') || '0');
      const s = store.getState();
      const q = side === 'sell' ? A.quoteSell(s, sym, amount, CFG, oracle.map()) : A.quoteBuy(s, sym, amount, CFG, oracle.map());
      delete q.after; return j(res, 200, q);
    }

    // ---- PAPER: instant trade ----
    if (p === '/amm/trade' && req.method === 'POST') {
      if (LIVE) return j(res, 400, { error: 'live mode: use POST /amm/intent (async deposit flow)' });
      let body = ''; for await (const c of req) body += c;
      const { side, sym: raw, amount, to } = JSON.parse(body || '{}'); const sym = USYM(raw);
      const s = store.getState();
      if (side === 'buy') {
        const q = A.quoteBuy(s, sym, BigInt(amount), CFG, oracle.map());
        store.setState(q.after);
        store.appendTrade({ t: Date.now(), side, sym, amountIn: String(amount), blockOut: q.blockOut.toString(), usd: Number(q.usdIn) / 1e6, feeUsd: Number(q.feeUsd) / 1e6, to: to || null, paper: true });
        return j(res, 200, { ok: true, paper: true, side, sym, blockOut: q.blockOut, usdIn: q.usdIn, feeUsd: q.feeUsd, priceAfterUsd: Number(q.priceAfterMicroUsd) / 1e6 });
      }
      if (side === 'sell') {
        let q, after;
        try { q = A.quoteSell(s, sym, BigInt(amount), CFG, oracle.map()); after = A.applySell(s, sym, BigInt(amount), CFG, oracle.map()); }
        catch (e) { if (e.code === 'NO_LIQUIDITY') return j(res, 409, { error: e.message, code: 'NO_LIQUIDITY', availableBase: e.availableBase, wantedBase: e.wantedBase }); throw e; }
        store.setState(after);
        store.appendTrade({ t: Date.now(), side, sym, blockIn: String(amount), assetOut: q.assetOut.toString(), usd: Number(q.usdOut) / 1e6, feeUsd: Number(q.feeUsd) / 1e6, to: to || null, paper: true });
        return j(res, 200, { ok: true, paper: true, side, sym, assetOut: q.assetOut, usdOut: q.usdOut, feeUsd: q.feeUsd, priceAfterUsd: Number(q.priceAfterMicroUsd) / 1e6 });
      }
      return j(res, 400, { error: 'side must be buy|sell' });
    }

    // ---- LIVE: create a trade intent (deposit flow) ----
    if (p === '/amm/intent' && req.method === 'POST') {
      if (!LIVE) return j(res, 501, { error: 'paper mode: use POST /amm/trade' });
      if (store.isPaused()) return j(res, 503, { error: 'AMM paused by solvency monitor' });
      let body = ''; for await (const c of req) body += c;
      const { side, sym: raw, amount, payoutAddress } = JSON.parse(body || '{}'); const sym = USYM(raw);
      if (!QUOTE_SYMS.includes(sym)) return j(res, 400, { error: 'unsupported pair' });
      if (!['buy', 'sell'].includes(side)) return j(res, 400, { error: 'side must be buy|sell' });
      if (!payoutAddress) return j(res, 400, { error: 'payoutAddress required' });
      const depositAsset = side === 'buy' ? sym : 'BLOCK';
      if (!custody.ready(depositAsset) || !custody.ready(side === 'buy' ? 'BLOCK' : sym))
        return j(res, 501, { error: 'custody adapter not live for ' + (custody.ready(depositAsset) ? sym : depositAsset) });
      await oracle.ensureFresh();
      let it;
      try {
        it = I.create({ id: 'amm_' + crypto.randomBytes(10).toString('hex'), side, sym,
          amountInBase: BigInt(amount), poolState: store.getState(), cfg: CFG, oracle: oracle.map(),
          depositAddress: custody.get(depositAsset).address(), payoutAddress, nowMs: Date.now() });
      } catch (e) { if (e.code === 'NO_LIQUIDITY') return j(res, 409, { error: e.message, code: 'NO_LIQUIDITY' }); throw e; }
      store.putIntent(it);
      return j(res, 200, { id: it.id, status: it.status, depositAsset: it.depositAsset, depositAddress: it.depositAddress,
        amountInBase: it.amountInBase, payoutAsset: it.payoutAsset, quote: it.quote, expiresAt: it.expiresAt });
    }
    if (p.startsWith('/amm/intent/') && req.method === 'GET') {
      const it = store.getIntent(p.split('/').pop());
      return it ? j(res, 200, it) : j(res, 404, { error: 'not found' });
    }

    return j(res, 404, { error: 'not found' });
  } catch (e) { return j(res, 400, { error: String(e.message || e) }); }
});

if (LIVE) {
  setInterval(() => settleLoop().catch(() => {}), 8000);
  setInterval(() => solvencyLoop().catch(() => {}), 15000);
}
server.listen(PORT, '127.0.0.1', () => console.log(`[super-amm] ${PAPER ? 'PAPER' : 'LIVE'} on 127.0.0.1:${PORT} · assets ${Object.keys(ASSETS).join(',')}`));
