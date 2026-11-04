// Node tests for the new/changed wallet modules (run with: node wallet-tests.mjs)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const V = '/opt/blockle/web/wallet/vendor/';
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); } }

const Lists = require(V + 'chains/token-lists.js');
const PriceFeed = require(V + 'prices.js');
const Moon = require(V + 'moon.js');
const Bots = require(V + 'agent/bots.js');
const Runner = require(V + 'agent/bot-runner.js');
const AutoImport = require(V + 'chains/autoimport.js');
const Evm = require(V + 'chains/evm.js');
const Sol = require(V + 'chains/solana.js');
const Registry = require(V + 'chains/registry.js');

// ---- token lists -----------------------------------------------------------
await test('token lists: every address is a valid EVM address, no dupes per chain', () => {
  for (const chain of Lists.chains()) {
    const seen = new Set();
    for (const t of Lists.forChain(chain)) {
      assert.match(t.address, /^0x[0-9a-fA-F]{40}$/, chain + ' ' + t.symbol);
      assert.ok(!seen.has(t.address.toLowerCase()), 'dupe ' + chain + ' ' + t.address); seen.add(t.address.toLowerCase());
    }
  }
  assert.equal(Lists.coingeckoId('eth'), 'ethereum');
  assert.equal(Lists.dexscreenerChain('bnb'), 'bsc');
});

// ---- price feed (mock fetch) -------------------------------------------------
function mockFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [re, body] of routes) if (re.test(url)) return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(url) : body) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  f.calls = calls; return f;
}
await test('prices: stables, majors via proxy, token by remembered address, BLOCK via buy history', async () => {
  const fetchImpl = mockFetch([
    [/\/api\/signals\/prices/, (u) => ({ prices: { ETH: 2300, SOL: 93 }, change: { ETH: 1.2 }, tokens: { 'solana:MINT1': { priceUsd: 0.0125, symbol: 'GATO' } } })],
    [/\/api\/dex\/pools/, { pools: [] }],
    [/\/api\/buy\/history/, [{ t: 1, price: 0.1 }]],
  ]);
  const pf = PriceFeed.create({ fetchImpl, cacheMs: 1000 });
  pf.remember('GATO', { chain: 'solana', mint: 'MINT1', decimals: 6 });
  const p = await pf.prices(['USDC', 'eth', 'SOL', 'GATO', 'BLOCK', 'NOPE']);
  assert.equal(p.USDC, 1); assert.equal(p.ETH, 2300); assert.equal(p.SOL, 93); assert.equal(p.GATO, 0.0125); assert.equal(p.BLOCK, 0.1);
  assert.equal(p.NOPE, undefined, 'unknown symbols are never fabricated');
  assert.equal(pf.change24h('ETH'), 1.2);
  assert.equal(pf.decimalsOf('GATO'), 6);
  assert.equal(pf.decimalsOf('ETH'), 18);
});
await test('prices: proxy down → CoinGecko + DexScreener direct, cached', async () => {
  const fetchImpl = mockFetch([
    [/coingecko.*simple\/price/, { ethereum: { usd: 2301, usd_24h_change: -2 } }],
    [/dexscreener\.com\/tokens\/v1\/base\/0xaaaa/i, [{ baseToken: { address: '0xAAAA', symbol: 'AERO', name: 'Aerodrome' }, priceUsd: '0.64', liquidity: { usd: 100 }, priceChange: { h24: 4 } }, { baseToken: { address: '0xAAAA', symbol: 'AERO' }, priceUsd: '0.70', liquidity: { usd: 5 } }]],
  ]);
  const pf = PriceFeed.create({ fetchImpl, cacheMs: 60000 });
  pf.remember('AERO', { chain: 'base', address: '0xAAAA', decimals: 18 });
  const p1 = await pf.prices(['ETH', 'AERO']);
  assert.equal(p1.ETH, 2301); assert.equal(p1.AERO, 0.64, 'deepest pair wins');
  const n = fetchImpl.calls.length;
  await pf.prices(['ETH', 'AERO']);
  assert.equal(fetchImpl.calls.length, n, 'second call served from cache');
  const meta = await pf.tokenMeta('base', ['0xAAAA']);
  assert.equal(meta['0xaaaa'].symbol, 'AERO');
});
await test('prices: BLOCK-20 token priced through its AMM pool × BLOCK/USD', async () => {
  const fetchImpl = mockFetch([
    [/\/api\/signals\/prices/, null],
    [/\/api\/dex\/pools/, { pools: [{ token: 'abc', symbol: 'WORLD', decimals: 8, blockReserve: 108905343402, tokenReserve: 91846345958697 }] }],
    [/\/api\/buy\/history/, [{ t: 1, price: 0.1 }]],
  ]);
  const pf = PriceFeed.create({ fetchImpl, proxyUrl: null });
  const v = await pf.priceOf({ chain: 'block', address: 'abc', symbol: 'WORLD', decimals: 8 });
  assert.ok(Math.abs(v - 0.0011857341 * 0.1) < 1e-9, String(v));
});

// ---- moon core ---------------------------------------------------------------
await test('moon: buy/sell quotes, impact, ledger P&L', () => {
  const pool = { blockReserve: '108905343402', tokenReserve: '91846345958697', decimals: 8, poolFeeBps: 30 };
  const q = Moon.quoteBuyUsd(20, 0.1, pool);
  assert.equal(q.amountIn, '20000000000'); // 200 BLOCK
  assert.ok(Number(q.amountOut) > 0 && BigInt(q.minOut) < BigInt(q.amountOut));
  assert.ok(q.impactPct > 0 && q.impactPct < 30, 'impact ' + q.impactPct);
  assert.equal(q.tooBig, q.impactPct > 15);
  const big = Moon.quoteBuyUsd(5000, 0.1, pool); assert.equal(big.tooBig, true);
  const s = Moon.quoteSell(q.amountOut, 0.1, pool);
  assert.ok(Number(s.amountOut) < Number(q.amountIn), 'round trip loses fees + impact');
  let pos = Moon.applyTrade({}, { contract: 'ABC', symbol: 'WORLD', decimals: 8, side: 'buy', qty: q.amountOut, blockAmt: q.amountIn, blockUsd: 0.1, at: 1 });
  const p = pos.abc; assert.equal(p.qty, q.amountOut); assert.equal(p.costBlock, q.amountIn);
  const pnl = Moon.pnl(p, Moon.poolPriceBlock(pool) * 2, 0.1);
  assert.ok(pnl.unrealizedPct > 50, 'doubling the price shows a gain: ' + pnl.unrealizedPct);
  pos = Moon.applyTrade(pos, { contract: 'ABC', decimals: 8, side: 'sell', qty: Moon.fractionOf(p.qty, 50), blockAmt: s.amountOut, blockUsd: 0.1, at: 2 });
  assert.ok(BigInt(pos.abc.qty) > 0n && BigInt(pos.abc.qty) < BigInt(q.amountOut));
  assert.equal(Moon.rank([{ symbol: 'A', change24hPct: 5, liquidityBlock: 10 }, { symbol: 'B', change24hPct: 50, liquidityBlock: 10 }], 'gainers')[0].symbol, 'B');
  assert.ok(Moon.warnings({ liquidityBlock: 1, lpLocked: false, ageBlocks: 10, flags: ['honeypot'] }).length >= 3);
});

// ---- bots engine -------------------------------------------------------------
function mkRunner(prices, extra) {
  const audit = []; const events = [];
  const policy = { caps: { sessionUsd: 1000 }, autoApproveUnderUsd: null, assertLive() {}, isKilled() { return false; }, isAllowed() { return true; }, async kill() {} };
  const tools = { get() { return null; } };
  let now = 1_000_000;
  const ctx = { now: () => now, prices: async (syms) => { const o = {}; for (const s of syms) if (prices[s] != null) o[s] = prices[s]; return o; }, decimalsFor: (s) => ({ SOL: 9, USDC: 6, GATO: 6 })[s] };
  const r = Runner.create(Object.assign({ policy, tools, ctx, audit: { record: async (x) => audit.push(x) }, onEvent: (e) => events.push(e), AgentRunner: { dispatchValueMoving: async () => ({ rejected: true, reason: 'test' }) }, timers: { set: () => 1, clear: () => {} } }, extra || {}));
  r._audit_ = audit; r._events_ = events; r._setNow = (t) => { now = t; }; r._now = () => now;
  return r;
}
await test('bots: lanes cover every supported network, aliases resolve, store.all() exists', () => {
  assert.ok(Bots.validateLane('bsc') === 'bnb' && Bots.validateLane('base') === 'base' && Bots.validateLane('sei') === 'sei');
  assert.equal(Bots.laneSignalsChain('bnb'), 'bsc');
  Bots.registerLanes([{ id: 'mychain', symbol: 'MYC', name: 'My Chain', custom: true }, { id: 'bitcoin', symbol: 'BTC' }]);
  assert.equal(Bots.validateLane('mychain'), 'mychain'); assert.equal(Bots.validateLane('bitcoin'), null);
  const st = new Bots.BotStore({}); st.add({ type: 'dca' }); assert.equal(st.all().length, 1);
});
await test('bots: DCA "dip" start waits for the pullback, then opens', async () => {
  const prices = { SOL: 100, USDC: 1 };
  const r = mkRunner(prices);
  const b = r.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 20, startCondition: 'dip', dipPct: 5, takeProfitPct: 3 }, pollSec: 1 });
  await r.enablePaper(b.id, { allocationUsd: 200 });
  let rep = await r.tickBot(b.id); assert.ok(rep.events[0].waiting, 'no deal at the high');
  prices.SOL = 97; rep = await r.tickBot(b.id); assert.ok(rep.events[0].waiting, 'not dipped enough');
  prices.SOL = 94; rep = await r.tickBot(b.id); assert.equal(rep.events[0].action, 'base', 'opened on a 6% dip');
  assert.equal(b.state.lastMarks.SOL, 94);
  assert.ok(b.state.feed.some((e) => e.kind === 'buy'));
});
await test('bots: grid auto-range builds a band around the first mark', async () => {
  const r = mkRunner({ ETH: 2000, USDC: 1 });
  const b = r.add({ type: 'grid', universe: { pairs: ['ETH/USDC'] }, config: { autoRangePct: 10, gridCount: 4, totalUsd: 100 } });
  await r.enablePaper(b.id, { allocationUsd: 100 });
  await r.tickBot(b.id);
  const deal = b.state.byPair['ETH/USDC'].deal;
  assert.equal(deal.range.lower, 1800); assert.equal(deal.range.upper, 2200);
  assert.equal(deal.levels.length, 4);
});
await test('bots: paper slippage moves the fill against you; 0 keeps mark fills', async () => {
  const mk = (slip) => { const r = mkRunner({ SOL: 100, USDC: 1 }); const b = r.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 50 }, risk: { paperSlippageBps: slip } }); return [r, b]; };
  const [r0, b0] = mk(0); await r0.enablePaper(b0.id, { allocationUsd: 100 }); await r0.tickBot(b0.id);
  const [r1, b1] = mk(100); await r1.enablePaper(b1.id, { allocationUsd: 100 }); await r1.tickBot(b1.id);
  assert.equal(b0.state.byPair['SOL/USDC'].deal.fills[0].priceUc, 100_000_000n);
  assert.equal(b1.state.byPair['SOL/USDC'].deal.fills[0].priceUc, 101_000_000n);
});
await test('bots: max-loss rail pauses the bot; resume() clears it; streaks + closedDeals in dashboard', async () => {
  const prices = { SOL: 100, USDC: 1 };
  const r = mkRunner(prices);
  const b = r.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 50, maxSafetyOrders: 0, stopLossPct: 10, takeProfitPct: 5 }, risk: { maxLossPct: 8 } });
  await r.enablePaper(b.id, { allocationUsd: 100 });
  await r.tickBot(b.id);                       // base order @100
  prices.SOL = 85; await r.tickBot(b.id);       // stop-loss → -$7.5 (7.5% of budget: under the 8% rail)
  assert.equal(b.enabled, true); assert.equal(b.state.streak, -1);
  prices.SOL = 100; await r.tickBot(b.id);      // new deal @100
  prices.SOL = 85; await r.tickBot(b.id);       // second stop → -$15 total ≥ 8% → HALT
  assert.equal(b.enabled, false); assert.equal(b.state.haltReason, 'max-loss');
  const d = r.dashboard(b.id);
  assert.equal(d.status, 'halted'); assert.equal(d.closedDeals.length, 2); assert.equal(d.streak, -2);
  assert.ok(r._events_.some((e) => e.type === 'bot_paused' && e.reason === 'max-loss'));
  await r.resume(b.id); assert.equal(b.enabled, true); assert.equal(b.state.haltReason, null);
  const agg = r.aggregate(); assert.ok(agg.feed.length > 0 && agg.realizedUsd < 0 && 'running' in agg);
});
await test('bots: time stop closes a stale deal', async () => {
  const prices = { SOL: 100, USDC: 1 };
  const r = mkRunner(prices);
  const b = r.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 20, takeProfitPct: 50, maxSafetyOrders: 0, maxDealSec: 3600 } });
  await r.enablePaper(b.id, { allocationUsd: 100 });
  await r.tickBot(b.id);
  r._setNow(r._now() + 3700 * 1000); prices.SOL = 101;
  const rep = await r.tickBot(b.id);
  assert.ok(rep.events.some((e) => e.action === 'time'), JSON.stringify(rep.events));
  assert.equal(b.state.dealCount, 1); assert.equal(b.state.closedDeals[0].reason, 'time');
});
await test('bots: signal bot applies the risk preset to candidates and prices discovered tokens by symbol', async () => {
  const prices = { GATO: 0.0125, SOL: 93 };
  const scan = async () => [
    { pair: 'GATO/SOL', chain: 'solana', approved: true, score: 0.8, liquidityUsd: 350000, ageSec: 6000000, honeypot: false },
    { pair: 'RUG/SOL', chain: 'solana', approved: true, score: 0.9, liquidityUsd: 2000, ageSec: 100, honeypot: false },   // below medium liquidity
    { pair: 'BSCX/BNB', chain: 'bsc', approved: true, score: 0.9 },                                                      // cross-lane
  ];
  const r = mkRunner(prices, { discovery: { scan } });
  const b = r.add({ type: 'signal', lane: 'solana', riskMode: 'medium', config: { source: 'discovery', maxConcurrent: 3, minScore: 0.5, onSignal: { type: 'dca', config: { baseOrderUsd: 10 } } } });
  await r.enablePaper(b.id, { allocationUsd: 100 });
  const rep = await r.tickBot(b.id);
  const pairs = Object.keys(b.state.byPair);
  assert.deepEqual(pairs, ['GATO/SOL']);
  assert.equal(rep.events[0].action, 'base');
  assert.equal(b.state.byPair['GATO/SOL'].deal.fills[0].qty, 800000000n, '10 USD / 0.0125 at 6 decimals');
});

// ---- FULL AUTO -----------------------------------------------------------------
await test('auto: pick-a-chain bot spawns one child per algorithm, detects the regime, re-weights, aggregates, persists', async () => {
  const prices = { SOL: 100, USDC: 1, GATO: 0.01 };
  const scan = async () => [{ pair: 'GATO/SOL', chain: 'solana', approved: true, score: 0.9, liquidityUsd: 500000, ageSec: 9e6 }];
  const r = mkRunner(prices, { discovery: { scan } });
  const b = r.add({ type: 'auto', lane: 'solana', riskMode: 'high', config: { rebalanceSec: 60, regimeWindow: 12 }, risk: { maxLossPct: 40 }, pollSec: 10 });
  await r.enablePaper(b.id, { allocationUsd: 500 });
  assert.equal(b.describe().slice(0, 9), 'Full Auto');
  let rep = await r.tickBot(b.id);
  assert.equal(rep.type, 'auto'); assert.equal(rep.regime, 'warming');
  const kids = r._autoChildren(b);
  assert.deepEqual(kids.map((k) => k.algo), ['momentum', 'buzz', 'sniper', 'grid', 'dip', 'scanner']);
  const w = b.state.auto.weights; assert.ok(Math.abs(Object.values(w).reduce((a, x) => a + x, 0) - 1) < 1e-6, JSON.stringify(w));
  assert.ok(kids.every((k) => k.allocationUsd > 0 && k.lane === 'solana' && k.mode === 'paper'));
  // the grid child built its deal on the sized budget; the momentum child armed the signal
  assert.ok(kids.find((k) => k.algo === 'grid').state.byPair['SOL/USDC'].deal.levels.length === 10);
  assert.ok(Object.keys(kids[0].state.byPair).includes('GATO/SOL'));
  // feed the regime a clean uptrend, 1 sample per tick (clock advances past the 60s rebalance)
  for (let i = 1; i <= 14; i++) { prices.SOL = 100 * (1 + 0.004 * i); r._setNow(r._now() + 61 * 1000); rep = await r.tickBot(b.id); }
  assert.equal(rep.regime, 'trend-up', JSON.stringify(b.state.auto.regimeInfo));
  assert.ok(b.state.auto.weights.momentum > b.state.auto.weights.grid, 'uptrend favours momentum');
  assert.ok(b.state.feed.some((e) => e.kind === 'switch'), 'a switch event was announced');
  const d = r.dashboard(b.id);
  assert.equal(d.type, 'auto'); assert.equal(d.auto.children.length, 6); assert.ok(d.activeDeals.length >= 1); assert.ok(typeof d.realizedUsd === 'number');
  const agg = r.aggregate(); assert.equal(agg.bots.length, 1); assert.equal(agg.running, 1);
  // persistence round trip: children + their deal state survive snapshot/load
  const snap = JSON.parse(JSON.stringify(r.store.snapshot()));
  const st2 = new Bots.BotStore({}); st2.load(snap);
  const r2 = mkRunner(prices, { discovery: { scan }, store: st2 });
  const b2 = r2.store.get(b.id);
  const kids2 = r2._autoChildren(b2);
  assert.equal(kids2.length, 6);
  assert.equal(kids2.find((k) => k.algo === 'grid').state.byPair['SOL/USDC'].deal.levels.length, 10);
  assert.equal(typeof kids2.find((k) => k.algo === 'grid').state.byPair['SOL/USDC'].deal.levels[0].priceUc, 'bigint');
  assert.equal(r2.dashboard(b.id).auto.regime, 'trend-up');
});
await test('auto: parent max-loss rail halts every algorithm at once', async () => {
  const prices = { SOL: 100, USDC: 1 };
  const r = mkRunner(prices, { discovery: { scan: async () => [] } });
  const b = r.add({ type: 'auto', lane: 'solana', config: { algos: ['dip'], rebalanceSec: 60 }, risk: { maxLossPct: 5 } });
  await r.enablePaper(b.id, { allocationUsd: 100 });
  await r.tickBot(b.id);                                  // dip child waits for a 1.5% pullback
  prices.SOL = 98; await r.tickBot(b.id);                 // opens base order
  prices.SOL = 40; r._setNow(r._now() + 61000); await r.tickBot(b.id); // no stop-loss configured → still open
  const kid = r._autoChildren(b)[0];
  const deal = kid.state.byPair['SOL/USDC'].deal; assert.ok(deal && deal.status === 'open');
  // force a close at a loss through the engine's own exit (time stop) to trip the rail
  kid.config.maxDealSec = 1; r._setNow(r._now() + 5000); await r.tickBot(b.id);
  assert.equal(b.enabled, false); assert.equal(b.state.haltReason, 'max-loss');
  assert.ok(r.dashboard(b.id).realizedUsd < 0);
});

// ---- candle exits ---------------------------------------------------------------
const Candles = require(V + 'agent/candles.js');
await test('candles: ticks fold into OHLC buckets; a new bucket closes the previous candle', () => {
  let s = [];
  let r = Candles.update(s, 100, 0, 60); s = r.series; assert.equal(r.closed, null);
  r = Candles.update(s, 103, 20000, 60); r = Candles.update(r.series, 99, 40000, 60); s = r.series;
  assert.deepEqual([s[0].o, s[0].h, s[0].l, s[0].c, s[0].n], [100, 103, 99, 99, 3]);
  r = Candles.update(s, 101, 61000, 60); s = r.series;
  assert.equal(r.closed.t, 0); assert.equal(s.length, 2);
});
await test('candles: exits only in profit, on closed-candle reversals (lower low / wick / ema / giveback)', () => {
  const cfg = { enabled: true, sec: 60, minProfitPct: 2, emaSlow: 4, emaFast: 2 };
  const mk = (rows) => rows.map((r, i) => ({ t: i * 60000, o: r[0], h: r[1], l: r[2], c: r[3], n: 3 }));
  // losing: never exits even on a lower low
  let st = {};
  assert.equal(Candles.evaluateExit(mk([[100, 101, 99, 100], [100, 100, 95, 96], [96, 97, 95, 96]]), 100, 96, cfg, st).exit, false);
  // in profit + last CLOSED candle red below previous low → lower-low exit
  st = {};
  let ev = Candles.evaluateExit(mk([[100, 106, 100, 105], [105, 107, 104, 106], [106, 106, 103, 103.5], [103.5, 104, 103, 103.6]]), 100, 103.6, cfg, st);
  assert.equal(ev.reason, 'lower-low');
  // wick rejection
  st = {};
  ev = Candles.evaluateExit(mk([[100, 104, 100, 104], [104, 110, 103.5, 103.8], [103.8, 104, 103, 103.9]]), 100, 103.9, { ...cfg, lowerLow: false }, st);
  assert.equal(ev.reason, 'wick-rejection');
  // giveback: peak +6% then back to +2.5% (≤ 50% of peak) → exit
  st = {};
  Candles.evaluateExit(mk([[100, 106, 100, 106], [106, 106, 105, 106]]), 100, 106, { ...cfg, lowerLow: false, wick: false, emaCross: false }, st);
  ev = Candles.evaluateExit(mk([[100, 106, 100, 106], [106, 106, 105, 106], [106, 106, 102, 102.5]]), 100, 102.5, { ...cfg, lowerLow: false, wick: false, emaCross: false }, st);
  assert.equal(ev.reason, 'giveback'); assert.ok(st.peakProfitPct >= 6);
  // forming candle never triggers: same rows but the reversal is the LAST (forming) candle
  st = {};
  ev = Candles.evaluateExit(mk([[100, 106, 100, 105], [105, 107, 104, 106], [106, 106, 103, 103.5]]), 100, 103.5, cfg, st);
  assert.equal(ev.exit, false);
  // disabled config never exits
  assert.equal(Candles.evaluateExit(mk([[100, 106, 100, 105], [105, 107, 104, 106], [106, 106, 103, 103.5], [103.5, 104, 103, 103.6]]), 100, 103.6, { enabled: false }, {}).exit, false);
});
await test('runner: a DCA deal in profit is banked by a candle exit before its fixed take-profit', async () => {
  const prices = { SOL: 100, USDC: 1 };
  const r = mkRunner(prices);
  const b = r.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 50, maxSafetyOrders: 0, takeProfitPct: 20, candle: { enabled: true, sec: 60, minProfitPct: 2, emaCross: false, giveback: 0 } }, pollSec: 20 });
  await r.enablePaper(b.id, { allocationUsd: 100 });
  const tick = async (p, t) => { prices.SOL = p; r._setNow(t); return r.tickBot(b.id); };
  await tick(100, 0);                         // base order @100
  await tick(104, 20000); await tick(105, 40000);
  await tick(106, 61000); await tick(107, 80000); await tick(106.5, 100000);   // candle 1 closes @105 (o 100 h 105 l 100)
  await tick(104, 121000); await tick(103.5, 140000);                            // candle 2 closes @106.5; candle 3 forming red
  const rep = await tick(103.8, 181000);      // candle 3 closes @103.5 < candle 2 low (106) → lower-low exit
  assert.ok(rep.events.some((e) => e.action === 'ctp' && e.candle === 'lower-low'), JSON.stringify(rep.events));
  assert.equal(b.state.dealCount, 1); assert.equal(b.state.closedDeals[0].reason, 'ctp');
  assert.ok(b.state.realizedUc > 0n, 'profit was realized');
  assert.ok(b.state.feed.some((e) => /Banked SOL/.test(e.text)));
  // with the giveback rule ON the same path exits even earlier: +7% peak, back to +3.5% → banked
  const r2 = mkRunner({ SOL: 100, USDC: 1 });
  const b2 = r2.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 50, maxSafetyOrders: 0, takeProfitPct: 20, candle: { enabled: true, sec: 60, minProfitPct: 2 } } });
  await r2.enablePaper(b2.id, { allocationUsd: 100 });
  const t2 = async (p, t) => { r2.ctx; r2._setNow(t); return r2.tickBot(b2.id); };
  const px = { SOL: 100, USDC: 1 }; r2.ctx.prices = async (syms) => { const o = {}; for (const s of syms) if (px[s] != null) o[s] = px[s]; return o; };
  px.SOL = 100; await t2(100, 0); px.SOL = 107; await t2(107, 61000); px.SOL = 103.5; const rep2 = await t2(103.5, 121000);
  assert.ok(rep2.events.some((e) => e.action === 'ctp' && e.candle === 'giveback'), JSON.stringify(rep2.events));
});

// ---- local LLM provider ----------------------------------------------------------
await test('providers: local LLM is keyless, lists models, pings without an authorization header', async () => {
  const Providers = require(V + 'agent/providers.js');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (/\/v1\/models$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5:14b' }] }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: ' ready ' } }] }), text: async () => '' };
  };
  const p = Providers.create({ provider: 'local', baseUrl: 'http://localhost:11434/', model: 'llama3.1:8b', fetchImpl });
  assert.ok(p instanceof Providers.LocalProvider);
  assert.equal(p.baseUrl, 'http://localhost:11434');
  assert.deepEqual(await p.listModels(), ['llama3.1:8b', 'qwen2.5:14b']);
  assert.equal(await p.ping(), 'ready');
  for (const c of calls) assert.ok(!('authorization' in (c.init.headers || {})), 'keyless');
  assert.equal(calls[calls.length - 1].url, 'http://localhost:11434/v1/chat/completions');
  assert.throws(() => Providers.create({ provider: 'openai', fetchImpl }), /apiKey/);
  assert.ok(Providers.LOCAL_PRESETS.ollama && Providers.LOCAL_PRESETS.lmstudio);
});

// ---- stop / flatten -------------------------------------------------------------
await test('runner: stopAll pauses every bot without killing; flatten closes open deals at market and books them', async () => {
  const prices = { SOL: 100, USDC: 1, ETH: 2000 };
  const r = mkRunner(prices);
  const a = r.add({ type: 'dca', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 50, maxSafetyOrders: 0, takeProfitPct: 50 } });
  const g = r.add({ type: 'grid', universe: { pairs: ['ETH/USDC'] }, config: { autoRangePct: 10, gridCount: 4, totalUsd: 100 } });
  await r.enablePaper(a.id, { allocationUsd: 100 }); await r.enablePaper(g.id, { allocationUsd: 100 });
  await r.tickBot(a.id); await r.tickBot(g.id); prices.ETH = 1850; await r.tickBot(g.id);   // a: open dca; g: ladder built @2000, then a rung filled
  assert.ok(a.state.byPair['SOL/USDC'].deal.status === 'open');
  assert.ok(g.state.byPair['ETH/USDC'].deal.levels.some((l) => l.heldQty > 0n));
  await r.stopAll('user');
  assert.equal(a.enabled, false); assert.equal(g.enabled, false); assert.equal(r.aggregate().killed, false);
  await r.enablePaper(a.id); assert.equal(a.enabled, true, 'stopAll is recoverable');
  prices.SOL = 110;
  const closes = await r.flatten(a.id, 'user');
  assert.equal(closes.length, 1); assert.equal(a.enabled, false);
  assert.equal(a.state.dealCount, 1); assert.equal(a.state.closedDeals[0].reason, 'manual');
  assert.ok(a.state.realizedUc > 0n, 'flattened at +10%');
  const gc = await r.flatten(g.id, 'user');
  assert.ok(gc.length >= 1); assert.equal(g.state.byPair['ETH/USDC'].deal, null, 'the grid deal closed and was archived'); assert.equal(g.state.closedDeals[0].reason, 'manual');
  assert.ok(a.state.feed.some((e) => /flattened/.test(e.text)));
});

// ---- autoimport (parallel + enrich + knownTokens) ----------------------------
await test('autoimport: parallel chains, enrich hook, timeout isolation, flagged kept out', async () => {
  const store = { data: { chainTokens: {}, tokens: [] }, async get(k) { const o = {}; for (const x of k) if (this.data[x] !== undefined) o[x] = this.data[x]; return o; }, async set(o) { Object.assign(this.data, o); } };
  const registry = {
    enabled: () => ['base', 'solana', 'slow'],
    async discoverTokens(chain, addr, opts) {
      if (chain === 'slow') return new Promise(() => {}); // never resolves
      if (chain === 'base') return [{ chain: 'base', kind: 'erc20', address: '0xAAAA', symbol: '?', decimals: 18, balance: '5' }, { chain: 'base', kind: 'erc20', address: '0xBBBB', symbol: 'FREE AIRDROP visit x.com', decimals: 18, balance: '9' }];
      return [{ chain: 'solana', kind: 'spl', mint: 'M1', symbol: 'M1…M1', decimals: 6, balance: '7' }];
    },
  };
  const sum = await AutoImport.autoImport({ registry, store, timeoutMs: 50, addressFor: async () => 'x',
    enrich: async (chain, rows) => rows.map((r) => (r.address === '0xAAAA' ? Object.assign(r, { symbol: 'AERO', name: 'Aerodrome' }) : r)) });
  assert.equal(sum.perChain.slow.error, 'timeout');
  assert.equal(sum.imported.length, 2);
  assert.equal(store.data.chainTokens.base[0].symbol, 'AERO');
  assert.equal(store.data.chainTokens.base[0].autoImported, true);
  assert.equal(sum.flagged.length, 1);
  assert.ok(store.data.lastAutoImportAt > 0);
  const again = await AutoImport.autoImport({ registry, store, timeoutMs: 50, addressFor: async () => 'x' });
  assert.equal(again.imported.length, 0, 'idempotent');
});

// ---- EVM keyless discovery (mock fetch) -------------------------------------
await test('evm: keyless probe finds a well-known token via batched balanceOf + on-chain metadata; ABI string decode', async () => {
  const balOf = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const str = (s) => { const hex = Buffer.from(s).toString('hex'); return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0'); };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const one = (c) => {
      const to = c.params[0].to.toLowerCase(), data = c.params[0].data;
      if (data.startsWith('0x70a08231')) return { jsonrpc: '2.0', id: c.id, result: balOf(to === '0x940181a94a35a4569e4529a3cdfb74e38fd98631' ? 123n * 10n ** 18n : (to === '0x1234567890123456789012345678901234567890' ? 5n : 0n)) };
      if (data === '0x95d89b41') return { jsonrpc: '2.0', id: c.id, result: str('NEWT') };
      if (data === '0x313ce567') return { jsonrpc: '2.0', id: c.id, result: '0x' + (9).toString(16).padStart(64, '0') };
      if (data === '0x06fdde03') return { jsonrpc: '2.0', id: c.id, result: str('New Token') };
      return { jsonrpc: '2.0', id: c.id, result: '0x' };
    };
    return { ok: true, json: async () => (Array.isArray(body) ? body.map(one) : one(body)) };
  };
  const a = Evm.createEvmAdapter({ id: 'base', chainId: 8453, rpcUrl: 'http://rpc', symbol: 'ETH' });
  const found = await a.discoverTokens('0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c', { knownTokens: [{ address: '0x1234567890123456789012345678901234567890' }] });
  const aero = found.find((t) => t.symbol === 'AERO'); assert.ok(aero, JSON.stringify(found)); assert.equal(aero.balance, (123n * 10n ** 18n).toString()); assert.equal(aero.display, '123');
  const newt = found.find((t) => t.symbol === 'NEWT'); assert.ok(newt); assert.equal(newt.decimals, 9); assert.equal(newt.name, 'New Token');
  assert.equal(found.length, 2);
  assert.equal(Evm.decodeAbiString('0x4d4b520000000000000000000000000000000000000000000000000000000000'), 'MKR');
  delete globalThis.fetch;
});

// ---- Solana metadata parse + token-2022 enumeration ---------------------------
await test('solana: Metaplex metadata parses; discovery sums both token programs and labels from metadata', async () => {
  const u32 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]);
  const padded = (s, n) => Buffer.concat([u32(n), Buffer.from(s.padEnd(n, '\0'))]);
  const buf = Buffer.concat([Buffer.from([4]), Buffer.alloc(32), Buffer.alloc(32), padded('GTA6CAT', 32), padded('GATO', 10), padded('https://x/meta.json', 200)]);
  const m = Sol.parseMetaplexMetadata(new Uint8Array(buf));
  assert.equal(m.symbol, 'GATO'); assert.equal(m.name, 'GTA6CAT');
  const mint = 'HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump';
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'getTokenAccountsByOwner') {
      const prog = b.params[1].programId;
      const amt = prog === Sol.TOKEN_PROGRAM ? '100' : '50';
      return { ok: true, json: async () => ({ result: { value: [{ account: { data: { parsed: { info: { mint, tokenAmount: { amount: amt, decimals: 6 } } } } } }] } }) };
    }
    if (b.method === 'getMultipleAccounts') return { ok: true, json: async () => ({ result: { value: [{ data: [buf.toString('base64'), 'base64'] }] } }) };
    return { ok: true, json: async () => ({ result: null }) };
  };
  const a = Sol.createSolanaAdapter({ rpcUrl: 'http://rpc' });
  const found = await a.discoverTokens('EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j');
  assert.equal(found.length, 1); assert.equal(found[0].balance, '150'); assert.equal(found[0].symbol, 'GATO'); assert.equal(found[0].name, 'GTA6CAT');
  delete globalThis.fetch;
});

// ---- registry -----------------------------------------------------------------
await test('registry: new networks enabled by default, networks() lists lanes, hint tokens flow into discovery', async () => {
  const reg = Registry.createRegistry({});
  const en = reg.enabled();
  for (const id of ['linea', 'scroll', 'gnosis', 'mantle', 'celo', 'cronos', 'sonic', 'berachain', 'unichain', 'opbnb', 'sei']) assert.ok(en.includes(id), id);
  const nets = reg.networks(); assert.ok(nets.find((n) => n.id === 'gnosis').symbol === 'XDAI');
  assert.equal(Registry.isEvm('sei'), true); assert.equal(Registry.isEvm('solana'), false);
  let seen = null; reg.adapters.sei.discoverTokens = async (addr, opts) => { seen = opts; return []; };
  await reg.discoverTokens('sei', '0x0', { knownTokens: [{ address: '0x1' }] });
  assert.ok(seen.knownTokens.length >= 3, 'defaults + caller hint');
});


// ---------------------------------------------------------------------------
// chain-specific wallet imports (key-import.js) + imported-account plumbing
// ---------------------------------------------------------------------------
const KeyImport = require(V + 'key-import.js');
const Utxo = require(V + 'chains/utxo.js');
const HD = require(V + 'hd.js');
const Accounts = require(V + 'accounts.js');
const C = require(V + 'crypto-core.js');
const S = require(V + 'secp256k1.js');
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

await test('key-import: private keys, seed phrases and watch addresses match the reference wallets', async () => {
  // web3.js docs vector
  const e = KeyImport.parsePrivateKey('evm', '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  assert.equal(e.addresses.evm, '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  assert.deepEqual(e.chains, ['evm']);
  // BIP39/44/84 + Phantom vectors for the "abandon … about" phrase
  const m = KeyImport.fromMnemonic(ABANDON, '');
  assert.equal(m.addresses.evm, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.equal(m.addresses.bitcoin, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(m.addresses.solana, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(m.chains.length, 5);
  const only = KeyImport.fromMnemonic(ABANDON, '', { family: 'dogecoin' });
  assert.deepEqual(only.chains, ['dogecoin']); assert.ok(only.addresses.dogecoin.startsWith('D'));
  assert.throws(() => KeyImport.fromMnemonic('abandon abandon abandon', ''), /12, 15, 18, 21 or 24 words/);
  assert.throws(() => KeyImport.fromMnemonic(ABANDON.replace('about', 'abandon'), ''), /checksum/);
  // bitcoin wiki WIF vector (uncompressed) + its compressed twin
  const w = KeyImport.parsePrivateKey('bitcoin', '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');
  assert.equal(w.keys.bitcoin.keys[0].priv, '0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d');
  assert.equal(w.keys.bitcoin.keys[0].compressed, false);
  assert.deepEqual(w.preview.map((p) => p.type), ['p2pkh']);
  const wc = KeyImport.parsePrivateKey('bitcoin', 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  assert.deepEqual(wc.preview.map((p) => p.type), ['p2wpkh', 'p2sh-p2wpkh', 'p2pkh']);
  assert.equal(wc.keys.bitcoin.track.length, 3);
  assert.throws(() => KeyImport.parsePrivateKey('litecoin', 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617'), /BTC key/);
  // solana: JSON keypair == base58 of the same bytes
  const seed = C.hexToBytes('11'.repeat(32));
  const ED = require(V + 'ed25519.js');
  const kp = C.concatBytes(seed, ED.publicKey(seed));
  const sj = KeyImport.parsePrivateKey('solana', JSON.stringify(Array.from(kp)));
  const sb = KeyImport.parsePrivateKey('solana', C.base58encode(kp));
  assert.equal(sj.addresses.solana, sb.addresses.solana);
  assert.equal(sj.keys.solana.priv, '11'.repeat(32));
  assert.throws(() => KeyImport.parsePrivateKey('solana', C.base58encode(C.concatBytes(seed, new Uint8Array(32)))), /does not match/);
  // detection + watch-only
  assert.equal(KeyImport.detect(ABANDON).kind, 'mnemonic');
  assert.equal(KeyImport.detect('KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617').families[0], 'bitcoin');
  assert.equal(KeyImport.detect('{"version":3,"crypto":{}}').kind, 'keystore');
  assert.equal(KeyImport.detect('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu').kind, 'address');
  assert.equal(KeyImport.watchAccount('evm', '0x9858effd232b4033e47d90003d41ec34ecaeda94').watch.evm, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.throws(() => KeyImport.watchAccount('litecoin', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'), /BTC address/);
});

await test('key-import: Ethereum keystore v3 (pbkdf2 and scrypt) decrypts to the right key', async () => {
  const priv = C.hexToBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  const subtle = globalThis.crypto.subtle;
  async function make(kdf) {
    const salt = C.hexToBytes('ab'.repeat(32)), iv = C.hexToBytes('0102030405060708090a0b0c0d0e0f10');
    let dk;
    if (kdf === 'pbkdf2') {
      const k = await subtle.importKey('raw', C.utf8('pw'), 'PBKDF2', false, ['deriveBits']);
      dk = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, k, 256));
    } else {
      require(V + 'vault.js'); dk = await globalThis.VaultUtil.scrypt('pw', salt, 256, 8, 1, 32);
    }
    const key = await subtle.importKey('raw', dk.slice(0, 16), { name: 'AES-CTR' }, false, ['encrypt']);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 128 }, key, priv));
    const mac = C.bytesToHex(C.keccak256(C.concatBytes(dk.slice(16, 32), ct)));
    const kdfparams = kdf === 'pbkdf2' ? { c: 1000, dklen: 32, prf: 'hmac-sha256', salt: C.bytesToHex(salt) } : { n: 256, r: 8, p: 1, dklen: 32, salt: C.bytesToHex(salt) };
    return { version: 3, address: '2c7536e3605d9c16a7a3d7b1898e529396a65c23', crypto: { cipher: 'aes-128-ctr', cipherparams: { iv: C.bytesToHex(iv) }, ciphertext: C.bytesToHex(ct), kdf, kdfparams, mac } };
  }
  for (const kdf of ['pbkdf2', 'scrypt']) {
    const ks = await make(kdf);
    const r = await KeyImport.decryptKeystore(JSON.stringify(ks), 'pw');
    assert.equal(r.addresses.evm, '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    await assert.rejects(KeyImport.decryptKeystore(ks, 'nope'), /wrong keystore password/);
  }
});

// Build wallet.dat-like byte layouts: BDB (value item just below the key item,
// 4-byte aligned, 3-byte headers) and SQLite (value right after the key).
function bdbPair(keyBytes, valueBytes) {
  const align4 = (n) => (n + 3) & ~3;
  const item = (b) => { const h = new Uint8Array(align4(b.length + 3)); h[0] = (b.length) & 0xff; h[1] = (b.length >> 8) & 0xff; h[2] = 1; h.set(b, 3); return h; };
  return C.concatBytes(item(valueBytes), item(keyBytes)); // value sits BELOW the key in page memory
}
function sqlitePair(keyBytes, valueBytes) { return C.concatBytes(keyBytes, valueBytes); }
const recName = (t) => C.concatBytes(Uint8Array.of(t.length), C.utf8(t));
function derCompressed(priv, pub) { // 214-byte OpenSSL ECPrivateKey shape: header, priv, params…, pub tail
  const head = C.concatBytes(C.hexToBytes('3081d3020101' + '0420'), priv);
  const filler = new Uint8Array(214 - head.length - 33).fill(0x5a);
  return C.concatBytes(head, filler, pub);
}

await test('key-import: wallet.dat — encrypted legacy (BDB) keys decrypt with the Core scheme and track funded addresses', async () => {
  const subtle = globalThis.crypto.subtle;
  const pass = 'correct horse';
  const salt = C.hexToBytes('0011223344556677'), iters = 2500;
  let h = C.sha512(C.concatBytes(C.utf8(pass), salt)); for (let i = 1; i < iters; i++) h = C.sha512(h);
  const master = C.hexToBytes('77'.repeat(32));
  const aes = async (key, iv, data) => new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']), data));
  const encMaster = await aes(h.slice(0, 32), h.slice(32, 48), master); // 48 bytes (PKCS7)
  assert.equal(encMaster.length, 48);
  const mkeyVal = C.concatBytes(Uint8Array.of(0x30), encMaster, Uint8Array.of(0x08), salt, C.hexToBytes('00000000'), new Uint8Array(new Uint32Array([iters]).buffer), Uint8Array.of(0x00));
  const mkeyKey = C.concatBytes(recName('mkey'), C.hexToBytes('01000000'));
  const privs = ['0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d', 'a1'.repeat(32), 'b2'.repeat(32)].map(C.hexToBytes);
  let buf = C.concatBytes(new Uint8Array(4096), bdbPair(mkeyKey, mkeyVal));
  const pubs = [];
  for (const priv of privs) {
    const pub = S.publicKey(priv, true); pubs.push(pub);
    const enc = await aes(master, C.hash256(pub).slice(0, 16), priv);
    buf = C.concatBytes(buf, new Uint8Array(37), bdbPair(C.concatBytes(recName('ckey'), Uint8Array.of(0x21), pub), C.concatBytes(Uint8Array.of(0x30), enc)));
  }
  // address book entry for the second key's legacy address
  const named = KeyImport.utxoAddresses('bitcoin', privs[1], true).find((a) => a.type === 'p2pkh').address;
  buf = C.concatBytes(buf, bdbPair(C.concatBytes(recName('name'), Uint8Array.of(named.length), C.utf8(named)), C.concatBytes(Uint8Array.of(4), C.utf8('cold'))), new Uint8Array(100));
  const parsed = KeyImport.parseWalletDat(buf);
  assert.equal(parsed.format, 'legacy'); assert.equal(parsed.encrypted, true);
  assert.equal(parsed.ckeys.length, 3); assert.equal(parsed.mkeys.length, 1); assert.equal(parsed.mkeys[0].iters, iters);
  assert.deepEqual(parsed.names, [named]);
  await assert.rejects(KeyImport.unlockWalletDat(parsed, 'wrong'), /wrong wallet.dat passphrase/);
  await KeyImport.unlockWalletDat(parsed, pass);
  assert.equal(parsed.keys.length, 3);
  assert.equal(parsed.keys[0].priv, C.bytesToHex(privs[0]));
  const acct = KeyImport.walletDatAccount(parsed, 'bitcoin', {});
  assert.equal(acct.stats.keys, 3);
  assert.equal(acct.candidates[0].address, named, 'address-book entries are scanned first');
  assert.equal(acct.candidates[0].named, true);
  // pretend the scan found funds on key 3's bech32 address
  const funded = KeyImport.utxoAddresses('bitcoin', privs[2], true)[0].address;
  KeyImport.finalizeWalletDat(acct, [{ address: funded, balance: '123456' }]);
  assert.equal(acct.addresses.bitcoin, funded);
  assert.equal(acct.keys.bitcoin.track[0].address, funded);
  assert.ok(acct.keys.bitcoin.track.some((t) => t.address === named), 'named addresses stay tracked');
  assert.equal(acct.funded, 1);
  assert.equal(KeyImport.guessFamily(parsed), 'bitcoin');
});

await test('key-import: wallet.dat — descriptor wallet (SQLite) derives the same bech32 addresses as the seed phrase', () => {
  const seed = HD.mnemonicToSeed(ABANDON, '');
  const acctNode = HD.derivePath(seed, "m/84'/0'/0'");
  const xpub = HD.serialize(acctNode, true);
  const desc = "wpkh([73c5da0a/84h/0h/0h]" + xpub + "/0/*)#abcdefgh";
  const descId = new Uint8Array(32).fill(7);
  const meta = new Uint8Array(20); new DataView(meta.buffer).setUint32(8, 5, true); new DataView(meta.buffer).setUint32(16, 999, true); // next_index=5, range_end=999
  const descVal = C.concatBytes(Uint8Array.of(desc.length), C.utf8(desc), meta);
  const keyVal = C.concatBytes(Uint8Array.of(0xd6), derCompressed(acctNode.privateKey, acctNode.publicKey), new Uint8Array(32));
  const buf = C.concatBytes(C.utf8('SQLite format 3\0'), new Uint8Array(200),
    sqlitePair(C.concatBytes(recName('walletdescriptor'), descId), descVal), new Uint8Array(9),
    sqlitePair(C.concatBytes(recName('walletdescriptorkey'), descId, Uint8Array.of(0x21), acctNode.publicKey), keyVal), new Uint8Array(50));
  const parsed = KeyImport.parseWalletDat(buf);
  assert.equal(parsed.container, 'sqlite'); assert.equal(parsed.format, 'descriptor');
  assert.equal(parsed.descriptors.length, 1); assert.equal(parsed.descriptors[0].type, 'p2wpkh');
  assert.equal(parsed.descriptors[0].nextIndex, 5);
  assert.equal(parsed.keys.length, 1);
  const acct = KeyImport.walletDatAccount(parsed, 'bitcoin', {});
  assert.equal(acct.candidates[0].address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'); // BIP84 vector /0/0
  assert.equal(acct.candidates[0].type, 'p2wpkh');
  assert.ok(acct.stats.derived >= 25, 'derives past next_index');
  assert.throws(() => KeyImport.walletDatAccount(parsed, 'solana'), /Bitcoin, Litecoin or Dogecoin/);
});

await test('utxo adapter: imported key set aggregates its addresses and signs mixed segwit/legacy inputs', async () => {
  const btc = Utxo.createUtxoAdapter('bitcoin', {});
  const spec = KeyImport.parsePrivateKey('bitcoin', 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  btc.unlock({ seed: null, keys: spec.keys });
  const a = await btc.deriveAccount();
  assert.equal(a.imported, true); assert.equal(a.addresses.length, 3);
  assert.deepEqual(btc.addressSet(a.address), a.addresses);
  const utxos = a.addresses.map((address, i) => ({ txid: String(i + 1).repeat(64).slice(0, 64), vout: i, value: '60000', address }));
  const built = await btc.buildSend(a, { to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: '150000', feeRate: 5, utxos });
  assert.ok(built.raw.startsWith('01000000' + '0001'), 'witness-serialised');
  assert.equal(BigInt(built.fee) > 0n, true);
  // HD root still derives the BIP84 account afterwards (sweep-legacy relies on it)
  btc.unlock({ seed: HD.mnemonicToSeed(ABANDON, '') });
  assert.equal((await btc.deriveAccount()).address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  btc.unlock({ watch: { bitcoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' } });
  assert.equal((await btc.deriveAccount()).watchOnly, true);
  await assert.rejects(btc.buildSend(await btc.deriveAccount(), { to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amount: '1', utxos: [] }), /watch-only/);
});

await test('accounts layer: an imported BTC-only account serves BLOCK + bitcoin and nothing else; switching restores the HD account', async () => {
  const reg = Registry.createRegistry({});
  const mainSeed = C.bytesToHex(HD.mnemonicToSeed(ABANDON, ''));
  const spec = KeyImport.parsePrivateKey('bitcoin', 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  let active = 'main';
  const W = {
    isUnlocked: () => true, seedHex: mainSeed, address: 'block1x', get activeAccountId() { return active; },
    activeRoot() { return active === 'main' ? { id: 'main', seedHex: mainSeed } : { id: 'imp', seedHex: null, keys: spec.keys, chains: ['bitcoin'] }; },
    async setActiveAccount(id) { active = id; }, async lock() {},
  };
  const acc = Accounts.createAccounts({ wallet: W, registry: reg, crypto: C });
  assert.equal((await acc.accountFor('bitcoin')).address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.ok((await acc.chains()).includes('ethereum'));
  await acc.switchAccount('imp');
  const chains = await acc.chains();
  assert.deepEqual(chains.filter((c) => c !== 'block'), ['bitcoin']);
  assert.equal((await acc.accountFor('bitcoin')).address, 'bc1qmy63mjadtw8nhzl69ukdepwzsyvv4yex5qlmkd');
  await assert.rejects(acc.accountFor('ethereum'), /no ethereum key/);
  await acc.switchAccount('main');
  assert.equal((await acc.accountFor('bitcoin')).address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal((await acc.accountFor('ethereum')).address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});


// ---- chain-specific private-key export for the ACTIVE account ----------------
await test('wallet-export: accountKey derives the HD account keys per chain (reference vectors)', async () => {
  const WX = require(V + 'wallet-export.js');
  const KI = require(V + 'key-import.js');
  const spec = KI.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
  const root = { id: 'main', seedHex: spec.seedHex, keys: null, watch: null };
  const evm = WX.accountKey('ethereum', root);
  assert.equal(evm.format, 'hex');
  assert.equal(evm.address.toLowerCase(), '0x9858effd232b4033e47d90003d41ec34ecaeda94');
  assert.equal(evm.secret, '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
  assert.equal(WX.accountKey('base', root).secret, evm.secret); // every EVM network shares the key
  const btc = WX.accountKey('bitcoin', root);
  assert.equal(btc.format, 'wif');
  assert.equal(btc.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(btc.secret, 'KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d');
  assert.ok(btc.dump.includes(btc.secret) && btc.dump.includes('addr=' + btc.address));
  const sol = WX.accountKey('solana', root);
  assert.equal(sol.format, 'base58');
  assert.equal(sol.address, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(JSON.parse(sol.alt.secret).length, 64);
  assert.throws(() => WX.accountKey('block', root), /wallet file/);
});

await test('wallet-export: accountKey exports imported keys (WIF/hex/base58), rejects watch-only and missing families', async () => {
  const WX = require(V + 'wallet-export.js');
  const KI = require(V + 'key-import.js');
  // compressed BTC WIF → three tracked addresses, one Core line
  const btcSpec = KI.parsePrivateKey('bitcoin', 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  const btcRoot = { id: 'a1', seedHex: null, keys: btcSpec.keys, watch: null, chains: ['bitcoin'] };
  const btc = WX.accountKey('bitcoin', btcRoot);
  assert.equal(btc.imported, true);
  assert.equal(btc.secret, 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617');
  assert.equal(btc.address, 'bc1qmy63mjadtw8nhzl69ukdepwzsyvv4yex5qlmkd');
  assert.equal(btc.keyCount, 1);
  assert.equal(btc.dump.split('\n').filter((l) => l && !l.startsWith('#')).length, 1);
  // uncompressed WIF keeps its uncompressed address
  const legacy = KI.parsePrivateKey('bitcoin', '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ');
  const leg = WX.accountKey('bitcoin', { id: 'a2', keys: legacy.keys, watch: null });
  assert.equal(leg.address, '1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S');
  assert.match(leg.label, /uncompressed/);
  // imported EVM hex key
  const evmSpec = KI.parsePrivateKey('evm', '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  const evm = WX.accountKey('arbitrum', { id: 'a3', keys: evmSpec.keys, watch: null });
  assert.equal(evm.secret, '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  assert.equal(evm.address, '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  // imported Solana key round-trips through base58(seed||pub)
  const solSpec = KI.parsePrivateKey('solana', '0x' + '11'.repeat(32));
  const sol = WX.accountKey('solana', { id: 'a4', keys: solSpec.keys, watch: null });
  assert.equal(sol.address, solSpec.addresses.solana);
  const back = KI.parsePrivateKey('solana', sol.secret);
  assert.equal(back.addresses.solana, sol.address);
  // watch-only and wrong-family accounts expose nothing
  assert.throws(() => WX.accountKey('bitcoin', { id: 'w', keys: null, watch: { bitcoin: 'bc1q…' } }), /watch-only/);
  assert.throws(() => WX.accountKey('solana', btcRoot), /no SOLANA key/);
});

await test('wallet-export: accountSeed exports the phrase kept at import, raw seed for the BLOCK-derived main account, nothing for key imports', async () => {
  const WX = require(V + 'wallet-export.js');
  const KI = require(V + 'key-import.js');
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const spec = KI.fromMnemonic(phrase, 'trezor');
  assert.equal(spec.mnemonic, phrase); assert.equal(spec.passphrase, 'trezor');
  const e = WX.accountSeed({ id: 'a1', seedHex: spec.seedHex, mnemonic: spec.mnemonic, passphrase: spec.passphrase });
  assert.equal(e.format, 'mnemonic'); assert.equal(e.words.length, 12); assert.equal(e.secret, phrase); assert.equal(e.passphrase, true);
  assert.equal(e.alt.secret, spec.seedHex);
  const main = WX.accountSeed({ id: 'main', seedHex: '07'.repeat(32), mnemonic: null });
  assert.equal(main.format, 'seedhex'); assert.match(main.note, /BLOCK identity/);
  assert.throws(() => WX.accountSeed({ id: 'k', keys: { evm: { priv: '11'.repeat(32) } } }), /single private key/);
  assert.throws(() => WX.accountSeed({ id: 'w', watch: { evm: '0x1' } }), /watch-only/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
