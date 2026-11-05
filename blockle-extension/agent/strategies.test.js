// agent/strategies.test.js — the five strategy PLANNERS, checked against the
// shared fixture docs/strategy-vectors.json (identical numbers across the three
// wallets). Strategies are pure planners: plan() returns Intents, touches no keys.
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const S = require('./strategies.js');

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'strategy-vectors.json'), 'utf8'));

// A READ-ONLY ctx assembled from a fixture case.
function ctxFor(vec, extra) {
  return Object.assign({
    now: () => (vec.now != null ? vec.now : 0),
    network: () => 'testnet',
    async prices() { return vec.prices || {}; },
    async listVenues() { return vec.venues || []; },
    async policyRemaining() { return { sessionUsd: vec.sessionUsd != null ? vec.sessionUsd : null, perAsset: {} }; },
    async getBook() { return vec.book; },
    async getBalances() { return vec.balances; },
  }, extra || {});
}
function paramsOf(vec) {
  const p = Object.assign({}, vec.params);
  if (vec.openOrders != null) p.openOrders = vec.openOrders;
  if (vec.balances != null) p.balances = vec.balances;
  return p;
}

// ===========================================================================
// arbitrage
// ===========================================================================
test('arbitrage: detects a real edge above threshold and emits a balanced 2-leg pair', async () => {
  const vec = VEC.arbitrage.detect_and_emit_pair;
  const intents = await S.arbitrage.plan(ctxFor(vec), S.arbitrage.validateParams(paramsOf(vec)));
  const exp = vec.expect;
  assert.equal(intents.length, exp.intents.length);
  // both legs share ONE group id
  assert.ok(intents[0].group && intents[0].group === intents[1].group, 'legs are one group');
  assert.equal(intents[0].args.venue, exp.buyVenue);
  assert.equal(intents[1].args.venue, exp.sellVenue);
  for (let i = 0; i < exp.intents.length; i++) {
    const e = exp.intents[i], it = intents[i];
    assert.equal(it.tool, e.tool);
    assert.equal(it.args.from, e.from);
    assert.equal(it.args.to, e.to);
    assert.equal(it.args.amount, e.amount);
    assert.equal(it.args.venue, e.venue);
  }
  assert.match(intents[0].rationale, /net/);
});

test('arbitrage: refuses when gross edge is positive but net (after fees + gas) is below threshold', async () => {
  const vec = VEC.arbitrage.refuse_below_net_threshold;
  const intents = await S.arbitrage.plan(ctxFor(vec), S.arbitrage.validateParams(paramsOf(vec)));
  assert.equal(intents.length, 0);
  assert.ok(intents.skipped, 'records a skip reason');
  assert.match(intents.skipped, /edge < min/);
});

test('arbitrage: never fabricates a price — no venues, no intent', async () => {
  const vec = VEC.arbitrage.detect_and_emit_pair;
  const ctx = ctxFor(vec, { async listVenues() { return []; } });
  const intents = await S.arbitrage.plan(ctx, S.arbitrage.validateParams({ pair: vec.params.pair }));
  assert.equal(intents.length, 0);
});

// FIX-1: a fat GROSS edge on a shallow book must emit NOTHING — after depth
// clamping the executed notional, gas (a fixed USD buffer) and all USD costs are
// recomputed on the CLAMPED size and the net-edge test is re-run on it.
test('arbitrage (FIX-1): fat gross edge but tiny depth => recomputes gas on clamped size and emits nothing', async () => {
  const shallow = {
    prices: { USDC: 1 },
    venues: [
      { id: 'dexA', mainnet: false, ask: '100', bid: '104', feeBps: 0, depthBase: '1000000' }, // 0.01 BLOCK
      { id: 'dexB', mainnet: false, ask: '101', bid: '105', feeBps: 0, depthBase: '1000000' },
    ],
  };
  const params = { pair: 'BLOCK/USDC', minEdgeBps: 30, maxNotionalUsd: 50, gasBufferUsd: 2, slippageBps: 10 };
  const intents = await S.arbitrage.plan(ctxFor(shallow), S.arbitrage.validateParams(params));
  assert.equal(intents.length, 0, 'loss-maker on shallow depth must emit nothing');
  assert.match(intents.skipped, /edge < min/);

  // positive control: the SAME prices with deep books DO clear (proves the gross
  // edge really is fat and only the depth clamp — via recomputed gas — kills it).
  const deep = {
    prices: { USDC: 1 },
    venues: [
      { id: 'dexA', mainnet: false, ask: '100', bid: '104', feeBps: 0, depthBase: '100000000000' },
      { id: 'dexB', mainnet: false, ask: '101', bid: '105', feeBps: 0, depthBase: '100000000000' },
    ],
  };
  const emitted = await S.arbitrage.plan(ctxFor(deep), S.arbitrage.validateParams(params));
  assert.equal(emitted.length, 2, 'deep book clears the net-edge test');
  // estUsd reflects the ACTUAL clamped notional, not the full probe
  assert.ok(emitted[0].estUsd > 0 && emitted[0].estUsd <= 50);
  assert.equal(emitted[0].estUsd, emitted[1].estUsd);
});

// FIX-4: USD->base conversion is BigInt-exact for 18-decimal assets (no float
// precision loss; deterministic across JS/Dart/Python).
test('arbitrage (FIX-4): usdToBase is BigInt-exact for 18-decimal assets', () => {
  assert.equal(S.usdToBase(123.456789, 18, 1), 123456789000000000000n);
  assert.equal(S.usdToBase(1000 / 1, 18, 2000), 500000000000000000n);
  assert.equal(S.usdToBase(10, 6, 1), 10000000n);
  assert.equal(S.usdToBase(0, 18, 1), 0n);
  assert.equal(S.usdToBase(5, 18, 0), 0n); // no price => no synthetic base amount
});

// FIX-2: the agent-fee term in the edge math is pinned at the REAL mandatory
// per-leg rate — a caller cannot set agentFeeBps (or slippage) low enough to make
// a sub-fee gross edge look profitable and emit a loss-making arb.
test('arbitrage (FIX-2): agentFeeBps below the real fee is floored; a sub-fee gross edge emits nothing', async () => {
  // gross edge = (100.08 - 100)/100 = 8 bps < the true 2*5 = 10 bps agent fee.
  const thin = {
    prices: { USDC: 1 },
    venues: [
      { id: 'dexA', mainnet: false, ask: '100', bid: '100.04', feeBps: 0, depthBase: '100000000000' },
      { id: 'dexB', mainnet: false, ask: '100', bid: '100.08', feeBps: 0, depthBase: '100000000000' },
    ],
  };
  // caller tries to zero out fees + slippage + gas + threshold to force an emit
  const params = { pair: 'BLOCK/USDC', maxNotionalUsd: 50, gasBufferUsd: 0, slippageBps: 0, minEdgeBps: 0, agentFeeBps: 0 };
  const p = S.arbitrage.validateParams(params);
  assert.equal(p.agentFeeBps, S.AGENT_FEE_BPS, 'agentFeeBps floored to the real per-leg rate');
  assert.ok(p.slippageBps >= 5, 'slippage floored to a conservative non-zero value');
  const intents = await S.arbitrage.plan(ctxFor(thin), p);
  assert.equal(intents.length, 0, 'an 8bps gross edge cannot clear the real 10bps agent fee => no loss-making arb');
});

test('arbitrage: validateParams requires a pair and fills defaults', () => {
  assert.throws(() => S.arbitrage.validateParams({}), /requires a pair/);
  const p = S.arbitrage.validateParams({ pair: 'BLOCK/USDC' });
  assert.equal(p.minEdgeBps, 30);
  assert.equal(p.maxNotionalUsd, 50);
  assert.equal(p.gasBufferUsd, 2);
  assert.equal(p.agentFeeBps, 5);
});

// ===========================================================================
// dca
// ===========================================================================
test('dca: fires exactly once per interval; nothing before the interval elapses', async () => {
  const fire = VEC.dca.fires_on_interval;
  const fired = await S.dca.plan(ctxFor(fire), S.dca.validateParams(paramsOf(fire)));
  assert.equal(fired.length, 1);
  const e = fire.expect.intents[0];
  assert.equal(fired[0].tool, e.tool);
  assert.equal(fired[0].args.from, e.from);
  assert.equal(fired[0].args.to, e.to);
  assert.equal(fired[0].args.amount, e.amount);

  const wait = VEC.dca.quiet_before_interval;
  const nothing = await S.dca.plan(ctxFor(wait), S.dca.validateParams(paramsOf(wait)));
  assert.equal(nothing.length, 0);
});

// ===========================================================================
// grid
// ===========================================================================
test('grid: emits the right number of buy/sell levels at the right prices', async () => {
  const vec = VEC.grid.symmetric_ladder;
  const intents = await S.grid.plan(ctxFor(vec), S.grid.validateParams(paramsOf(vec)));
  const exp = vec.expect.intents;
  assert.equal(intents.length, exp.length);
  for (let i = 0; i < exp.length; i++) {
    assert.equal(intents[i].tool, exp[i].tool);
    assert.equal(intents[i].args.side, exp[i].side);
    assert.equal(intents[i].args.price, exp[i].price);
    assert.equal(intents[i].args.amount, exp[i].amount);
    assert.equal(intents[i].args.type, 'limit');
  }
});

test('grid: skips a level already occupied by an open order within half a step', async () => {
  const vec = VEC.grid.skips_occupied_level;
  const intents = await S.grid.plan(ctxFor(vec), S.grid.validateParams(paramsOf(vec)));
  const exp = vec.expect.intents;
  assert.equal(intents.length, exp.length);
  for (let i = 0; i < exp.length; i++) {
    assert.equal(intents[i].args.side, exp[i].side);
    assert.equal(intents[i].args.price, exp[i].price);
    assert.equal(intents[i].args.amount, exp[i].amount);
  }
});

test('grid: levels clamp to 2..20', () => {
  assert.equal(S.grid.validateParams({ market: 'A/B', levels: 99 }).levels, 20);
  assert.equal(S.grid.validateParams({ market: 'A/B', levels: 1 }).levels, 2);
});

// ===========================================================================
// rebalance
// ===========================================================================
test('rebalance: trades only assets outside the band; direction + half-gap sizing correct', async () => {
  const vec = VEC.rebalance.sell_overweight_half_gap;
  const intents = await S.rebalance.plan(ctxFor(vec), S.rebalance.validateParams(paramsOf(vec)));
  const exp = vec.expect.intents;
  assert.equal(intents.length, exp.length);
  assert.equal(intents[0].tool, exp[0].tool);
  assert.equal(intents[0].args.from, exp[0].from);   // overweight -> SELL base to quote
  assert.equal(intents[0].args.to, exp[0].to);
  assert.equal(intents[0].args.amount, exp[0].amount);
  assert.equal(intents[0].estUsd, exp[0].estUsd);
});

test('rebalance: nothing to do when every asset is inside the band', async () => {
  const vec = VEC.rebalance.in_band_no_trade;
  const intents = await S.rebalance.plan(ctxFor(vec), S.rebalance.validateParams(paramsOf(vec)));
  assert.equal(intents.length, 0);
});

test('rebalance: validateParams rejects weights that do not sum to ~1', () => {
  assert.throws(() => S.rebalance.validateParams({ targets: { A: 0.3, B: 0.3 } }), /sum to ~1/);
});

// ===========================================================================
// momentum
// ===========================================================================
test('momentum: buys on a golden cross', async () => {
  const vec = VEC.momentum.golden_cross_buys;
  const intents = await S.momentum.plan(ctxFor(vec), S.momentum.validateParams(paramsOf(vec)));
  const e = vec.expect.intents[0];
  assert.equal(intents.length, 1);
  assert.equal(intents[0].args.from, e.from);
  assert.equal(intents[0].args.to, e.to);
  assert.equal(intents[0].args.amount, e.amount);
});

test('momentum: sells held on a death cross (sell only what is held)', async () => {
  const vec = VEC.momentum.death_cross_sells_held;
  const intents = await S.momentum.plan(ctxFor(vec), S.momentum.validateParams(paramsOf(vec)));
  const e = vec.expect.intents[0];
  assert.equal(intents.length, 1);
  assert.equal(intents[0].args.from, e.from);
  assert.equal(intents[0].args.to, e.to);
  assert.equal(intents[0].args.amount, e.amount);
});

test('momentum: nothing on no cross and when history is shorter than longN', async () => {
  const vec = VEC.momentum.no_cross_quiet;
  const flat = await S.momentum.plan(ctxFor(vec), S.momentum.validateParams(paramsOf(vec)));
  assert.equal(flat.length, 0);
  const few = await S.momentum.plan(ctxFor(vec), S.momentum.validateParams({ market: 'BLOCK/USDC', shortN: 3, longN: 5, tradeUsd: 20, history: [1, 1, 1, 1] }));
  assert.equal(few.length, 0);
  assert.match(few.skipped, /longN/);
});

test('momentum: FEE-AWARE entry gate (lever 3) skips a sub-threshold golden cross', async () => {
  // A weak golden cross: short just barely above long. With the gate ARMED the
  // entry is skipped; the SAME cross with the gate at its default (0) still buys.
  const history = [100, 100, 100, 100, 100.2]; // tiny upmove -> small strength
  const base = { market: 'BLOCK/USDC', shortN: 2, longN: 3, tradeUsd: 20, history };
  const ctx = ctxFor({ prices: { USDC: 1, BLOCK: 1 } });

  const armed = await S.momentum.plan(ctx, S.momentum.validateParams(
    Object.assign({}, base, { roundTripCostBps: 60, feeAwareMarginBps: 25 })));
  assert.equal(armed.length, 0, 'sub-threshold entry is skipped when the gate is armed');
  assert.match(armed.skipped || '', /fee-aware threshold/);

  const dflt = await S.momentum.plan(ctx, S.momentum.validateParams(base));
  assert.equal(dflt.length, 1, 'default (gate off) still buys on the golden cross');
});

test('momentum: FEE-AWARE gate never suppresses a genuinely strong cross', async () => {
  const history = [1, 1, 1, 1, 2]; // strong move (~1250 bps strength)
  const intents = await S.momentum.plan(ctxFor({ prices: { USDC: 1, BLOCK: 1 } }),
    S.momentum.validateParams({ market: 'BLOCK/USDC', shortN: 2, longN: 3, tradeUsd: 20, history, roundTripCostBps: 60, feeAwareMarginBps: 25 }));
  assert.equal(intents.length, 1, 'a strong cross clears the fee-aware threshold and trades');
  assert.ok(intents[0].tag.endsWith(':buy'));
});

test('momentum: death cross with nothing held emits nothing', async () => {
  const vec = VEC.momentum.death_cross_sells_held;
  const intents = await S.momentum.plan(ctxFor({ prices: vec.prices }), S.momentum.validateParams(vec.params)); // no balances/held
  assert.equal(intents.length, 0);
});

// ===========================================================================
// indicator planners (rsi/macd/bollinger/breakout/emacross/momentum_roc/meanrev/
// rebalance_hold/hodl) — the 9 LIVE keepers ported from the paper bot engine
// (services/accounts/src/bots.js step()). scalp + martingale are DROPPED from live
// (per-position-state they cannot safely reproduce) and stay PAPER-only. Each case
// in the shared fixture pins the exact Intent (byte-identical amounts across
// JS/Dart/Python). History lives in params (oldest->newest); planners are pure.
// ===========================================================================
function assertCase(name, caseName) {
  const vec = VEC[name][caseName];
  test('indicator ' + name + ': ' + caseName, async () => {
    const intents = await S[name].plan(ctxFor(vec), S[name].validateParams(paramsOf(vec)));
    const exp = vec.expect.intents;
    assert.equal(intents.length, exp.length, 'intent count for ' + name + '.' + caseName);
    if (vec.expect.skipped) assert.ok(intents.skipped, 'records a skip reason');
    for (let i = 0; i < exp.length; i++) {
      assert.equal(intents[i].tool, exp[i].tool);
      assert.equal(intents[i].args.from, exp[i].from);
      assert.equal(intents[i].args.to, exp[i].to);
      assert.equal(intents[i].args.amount, exp[i].amount);
      assert.equal(intents[i].args.venue, exp[i].venue);
    }
  });
}
// New-semantics cases (posUsd buy at budgetUsd*positionPct/100, clamped to the
// remaining session budget; full-held sellAll; no fabricated $1 quote). Each
// strategy exercises (a) a full-posUsd BUY, (c) a full-held SELL; rsi additionally
// covers (b) a BUY clamped by a small policyRemaining.sessionUsd, (d) a non-stable
// quote priced from ctx.prices, and (e) warming-up; rebalance_hold + hodl carry
// their own clamped-buy cases. scalp + martingale are DROPPED from live.
const INDICATOR_CASES = {
  rsi: ['oversold_buys', 'oversold_buys_clamped', 'overbought_sells_held', 'nonstable_quote_buys', 'warming_up_quiet'],
  macd: ['cross_up_buys', 'cross_down_sells_held'],
  bollinger: ['lower_band_buys', 'upper_band_sells_held'],
  breakout: ['new_high_buys', 'range_break_sells_held'],
  emacross: ['cross_up_buys', 'cross_down_sells_held'],
  momentum_roc: ['strong_roc_buys', 'negative_roc_sells_held'],
  meanrev: ['below_mean_buys', 'above_mean_sells_held'],
  rebalance_hold: ['overweight_sells', 'underweight_buys', 'underweight_buys_clamped', 'in_band_no_trade'],
  hodl: ['buys_when_flat', 'buys_when_flat_clamped', 'holds_when_held'],
};
for (const [name, cases] of Object.entries(INDICATOR_CASES)) for (const c of cases) assertCase(name, c);

// a few explicit invariants beyond the fixture table
test('indicator: validateParams requires a market', () => {
  assert.throws(() => S.rsi.validateParams({}), /requires a market/);
  assert.throws(() => S.macd.validateParams({ market: 'A/B', fast: 30, slow: 10 }), /fast < slow/);
  assert.throws(() => S.emacross.validateParams({ market: 'A/B', fast: 50, slow: 10 }), /fast < slow/);
});
test('indicator: a cross planner derives prev-relation from the window (stateless, no cross => no trade)', async () => {
  // a pure down-trend never crosses up: macd stays below its signal -> no intent
  const hist = []; for (let i = 0; i < 50; i++) hist.push(+(3 - i * 0.03).toFixed(6));
  const flat = await S.macd.plan(ctxFor({ prices: { USDC: 1, BLOCK: 1 } }), S.macd.validateParams({ market: 'BLOCK/USDC', history: hist }));
  assert.equal(flat.length, 0);
});
test('indicator: a SELL never exceeds the held base (clamp)', async () => {
  // overbought rsi but only a crumb held -> sells the crumb, not tradeUsd worth
  const hist = []; for (let i = 0; i < 16; i++) hist.push(+(0.5 + i * 0.05).toFixed(6));
  const tiny = [{ asset: { symbol: 'BLOCK', decimals: 8, chain: 'block' }, confirmed: '7' }];
  const out = await S.rsi.plan(ctxFor({ prices: { USDC: 1, BLOCK: 1 }, balances: tiny }),
    S.rsi.validateParams({ market: 'BLOCK/USDC', history: hist, balances: tiny }));
  assert.equal(out.length, 1);
  assert.equal(out[0].args.amount, '7', 'sells only what is held');
});

// ===========================================================================
// registry
// ===========================================================================
test('registry: exposes the five core + nine indicator strategies (scalp + martingale dropped from live)', () => {
  const reg = S.createRegistry();
  assert.deepEqual(reg.names().sort(), [
    'arbitrage', 'bollinger', 'breakout', 'dca', 'emacross', 'grid', 'hodl', 'macd',
    'meanrev', 'momentum', 'momentum_roc', 'rebalance', 'rebalance_hold', 'rsi',
  ]);
  // scalp + martingale remain PAPER-only (bots.js); a live bot of those types is
  // cleanly rejected as an unknown strategy.
  assert.equal(reg.get('scalp'), null);
  assert.equal(reg.get('martingale'), null);
  assert.equal(reg.has('scalp'), false);
  assert.equal(reg.has('martingale'), false);
  assert.equal(reg.get('arbitrage').name, 'arbitrage');
  assert.equal(reg.get('rsi').name, 'rsi');
  assert.equal(reg.get('nope'), null);
  assert.equal(typeof reg.get('dca').describe(), 'string');
  for (const n of reg.names()) assert.equal(typeof reg.get(n).describe(), 'string');
});
