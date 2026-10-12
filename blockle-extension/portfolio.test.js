// portfolio.test.js — WALLET PORTFOLIO net worth + daily snapshot (§1/§2.1).
//   node --test portfolio.test.js
//
// Asserts the reference implementation against the AUTHORITATIVE shared fixture
// docs/portfolio-vectors.json (the exact micro-dollar aggregation the Dart +
// Python ports must reproduce) plus unit tests for the integer money math, the
// never-guess unpriced rule, and the append-only dedup-by-day snapshot store.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const P = require('./portfolio.js');
const vectors = require(path.join('..', 'docs', 'portfolio-vectors.json'));

// build the injected ctx from the PLAIN netWorth fixture (no functions stored).
function nwCtx(nw) {
  return {
    asOf: nw.asOf,
    priceUsd: nw.priceUsd, // plain { SYMBOL: price } map — the shared mark source
    getHoldings: async (chain) => (nw.holdingsByChain[chain] || []),
  };
}

// ===========================================================================
// 1. CANONICAL NET-WORTH VECTOR — exact micro-dollar total + byChain bps
// ===========================================================================
test('vector: net worth aggregates priced holdings, excludes unpriced, exact micro-dollars', async () => {
  const nw = vectors.netWorth;
  const pf = await P.portfolio(nw.accounts, nwCtx(nw));
  const e = nw.expect;

  assert.equal(pf.totalUsdMicro, e.totalUsdMicro, 'exact micro-dollar total');
  assert.equal(pf.totalUsd, e.totalUsd, 'convenience dollar total');
  assert.equal(pf.asOf, nw.asOf, 'injected asOf echoed, never a clock call');

  // byChain: value + basis points of total, value-desc order
  assert.equal(pf.byChain.length, e.byChain.length, 'byChain chain count (unpriced chain absent)');
  for (let i = 0; i < e.byChain.length; i++) {
    assert.equal(pf.byChain[i].chain, e.byChain[i].chain, 'byChain[' + i + '].chain');
    assert.equal(pf.byChain[i].usdMicro, e.byChain[i].usdMicro, 'byChain[' + i + '].usdMicro');
    assert.equal(pf.byChain[i].pctBps, e.byChain[i].pctBps, 'byChain[' + i + '].pctBps');
  }
  // basis points sum to 10000 across priced chains (exact split, no drift)
  assert.equal(pf.byChain.reduce((a, c) => a + c.pctBps, 0), 10000, 'pct basis points sum to 100%');

  // priced holdings in value order with exact per-holding micro-dollars
  const priced = pf.holdings.filter((h) => h.pricedOk);
  assert.equal(priced.length, e.holdings.length);
  for (let i = 0; i < e.holdings.length; i++) {
    assert.equal(priced[i].chain, e.holdings[i].chain, 'holding[' + i + '].chain');
    assert.equal(priced[i].symbol, e.holdings[i].symbol, 'holding[' + i + '].symbol');
    assert.equal(priced[i].usdMicro, e.holdings[i].usdMicro, 'holding[' + i + '].usdMicro');
  }

  // the unpriced holding is SHOWN but NEVER counted and NEVER guessed as 0
  assert.equal(pf.unpriced.length, e.unpriced.length, 'unpriced count');
  assert.equal(pf.unpriced[0].chain, e.unpriced[0].chain);
  assert.equal(pf.unpriced[0].symbol, e.unpriced[0].symbol);
  assert.equal(pf.unpriced[0].amountBase, e.unpriced[0].amountBase);
  // unpriced never leaks into the total (micro-dollars unchanged by its presence)
  const unpricedInHoldings = pf.holdings.find((h) => !h.pricedOk);
  assert.equal(unpricedInHoldings.usdMicro, null, 'unpriced holding has null usd (not 0)');
});

// ===========================================================================
// integer money math — BigInt exact, half-away-from-zero, never a float guess
// ===========================================================================
test('byChain pctBps always sum to exactly 10000 (largest-remainder; 3 equal chains would drift to 9999)', async () => {
  // three chains with equal value: independent floor rounding gives 3333*3 = 9999;
  // largest-remainder must apportion the leftover bp so the total is exactly 10000.
  const ctx = {
    asOf: 0,
    priceUsd: { A: 1, B: 1, C: 1 },
    getHoldings: async (chain) => {
      const sym = { chainA: 'A', chainB: 'B', chainC: 'C' }[chain];
      return sym ? [{ asset: { symbol: sym, decimals: 8 }, confirmed: '100000000' }] : [];
    },
  };
  const accounts = [
    { chain: 'chainA', address: 'a' },
    { chain: 'chainB', address: 'b' },
    { chain: 'chainC', address: 'c' },
  ];
  const pf = await P.portfolio(accounts, ctx);
  assert.equal(pf.byChain.length, 3);
  assert.equal(pf.byChain.reduce((a, c) => a + c.pctBps, 0), 10000, 'bps sum to exactly 100%');
  // each is 3333 or 3334, never a drifted value
  for (const c of pf.byChain) assert.ok(c.pctBps === 3333 || c.pctBps === 3334, 'bps ' + c.pctBps);
});

test('microUsd: round(usd*1e6) half-away-from-zero', () => {
  assert.equal(P.microUsd(2000), 2000000000n);
  assert.equal(P.microUsd(0.5), 500000n);
  assert.equal(P.microUsd(1), 1000000n);
  assert.equal(P.microUsd(null), null, 'unknown price stays null (never 0)');
});

test('holdingMicro: exact base-unit -> micro-dollar conversion', () => {
  // 1 ETH @ $2000 = $2000.000000
  assert.equal(P.holdingMicro('1000000000000000000', 18, 2000).toString(), '2000000000');
  // 500 USDC (6dp) @ $1 = $500
  assert.equal(P.holdingMicro('500000000', 6, 1).toString(), '500000000');
  // 10 BLOCK (8dp) @ $0.50 = $5
  assert.equal(P.holdingMicro('1000000000', 8, 0.5).toString(), '5000000');
  // no price => null, not zero
  assert.equal(P.holdingMicro('123', 6, null), null);
});

test('portfolio: an empty / all-unpriced wallet is total 0 with no fabricated value', async () => {
  const pf = await P.portfolio(
    [{ chain: 'solana', address: 'x' }],
    { priceUsd: {}, getHoldings: async () => ([{ asset: { symbol: 'XYZ', decimals: 6 }, confirmed: '5' }]) });
  assert.equal(pf.totalUsdMicro, '0');
  assert.equal(pf.byChain.length, 0);
  assert.equal(pf.unpriced.length, 1);
});

// ===========================================================================
// §2.1 DAILY SNAPSHOT STORE — append-only, dedup by UTC day, injected clock
// ===========================================================================
test('vector: snapshot store dedups by day (latest total for a day wins)', () => {
  const ss = vectors.snapshotStore;
  let hist = ss.start.slice();
  for (const a of ss.appends) hist = P.recordSnapshot(hist, a);
  assert.equal(hist.length, ss.expect.points.length, 'one point per distinct day');
  for (let i = 0; i < ss.expect.points.length; i++) {
    assert.equal(hist[i].day, ss.expect.points[i].day, 'point[' + i + '].day');
    assert.equal(hist[i].totalUsdMicro, ss.expect.points[i].totalUsdMicro, 'point[' + i + '].total');
  }
});

test('recordSnapshot: pure (never mutates input) + sorted by ts', () => {
  const h0 = [];
  const h1 = P.recordSnapshot(h0, { ts: 1700100000000, totalUsdMicro: '10' });
  const h2 = P.recordSnapshot(h1, { ts: 1700000000000, totalUsdMicro: '20' });
  assert.equal(h0.length, 0, 'input untouched');
  assert.equal(h1.length, 1);
  assert.equal(h2.length, 2);
  assert.ok(h2[0].ts < h2[1].ts, 'sorted ascending by ts');
});

test('sparkline: last N points as {ts,totalUsdMicro,usd}', () => {
  let hist = [];
  for (let d = 0; d < 40; d++) hist = P.recordSnapshot(hist, { ts: d * P.DAY_MS, totalUsdMicro: String(d * 1000000) });
  const sp = P.sparkline(hist, 30);
  assert.equal(sp.length, 30);
  assert.equal(sp[sp.length - 1].usd, 39, 'last point in dollars');
  assert.equal(sp[0].totalUsdMicro, '10000000');
});
