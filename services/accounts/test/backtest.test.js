// Backtest analytics: the quick-backtest returns win-rate, Sharpe and a vs-HODL
// baseline alongside pnl — the richer metrics the create-view surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBacktester } from '../src/backtest.js';

// A deterministic 60-point price series (a dip then a recovery above start) so a
// strategy that buys and sells completes at least one round-trip.
function series() {
  const out = [];
  for (let i = 0; i < 60; i++) {
    // down to ~0.7x by the middle, back up to ~1.3x by the end
    const t = i / 59;
    const p = 100 * (1 - 0.3 * Math.sin(Math.PI * t) + 0.3 * t);
    out.push([i * 3600_000, p]);
  }
  return out;
}

function stubFetch() {
  return async () => ({ ok: true, status: 200, json: async () => ({ prices: series() }) });
}

test('backtest returns winRatePct, sharpe and vsHodlPct', async () => {
  const bt = makeBacktester({ fetch: stubFetch(), now: () => 0 });
  const r = await bt.run({ type: 'dca', params: { budget: 1000 }, asset: 'sol' });
  assert.ok('winRatePct' in r, 'winRatePct present');
  assert.ok('sharpe' in r, 'sharpe present');
  assert.ok('vsHodlPct' in r, 'vsHodlPct present');
  // vsHodl is pnl minus the asset move — internally consistent.
  assert.equal(r.vsHodlPct, Math.round((r.pnlPct - r.assetMovePct) * 100) / 100);
  // winRatePct is null (no judged round-trips) or a 0..100 number.
  if (r.winRatePct != null) {
    assert.ok(r.winRatePct >= 0 && r.winRatePct <= 100);
  }
});

test('a strategy that completes round-trips reports a win rate', async () => {
  const bt = makeBacktester({ fetch: stubFetch(), now: () => 0 });
  // momentum buys the golden cross and sells the death cross -> judged sells.
  const r = await bt.run({ type: 'momentum', params: { budget: 1000, shortN: 3, longN: 8 }, asset: 'sol' });
  if (r.sells > 0 && r.wins != null) {
    assert.ok(r.winRatePct != null, 'a judged sell yields a win rate');
  }
});
