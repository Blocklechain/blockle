// test/backtest/backtest-guarantees.test.js — the PROFITABILITY GUARANTEES of the
// backtest harness, run NETWORK-FREE + DETERMINISTIC (seeded synthetic data +
// constructed cross-venue books) so they are enforced on every `npm test` without
// touching the live candle cache or any external host. The full report over REAL
// candles is `node test/backtest/backtest.js` (after `node fetch-candles.js`).
//
//   node --test blockle-extension/test/backtest/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const BT = require('./backtest.js');

// ---------------------------------------------------------------------------
// ARB PROFIT GUARANTEE: a net<=0 cross-venue gap is NEVER traded; realized >= 0.
// ---------------------------------------------------------------------------
test('ARB: net<=0 spreads are skipped, net-positive spreads trade, realized >= 0', async () => {
  const { results, minEdgeBps } = await BT.runArbitrage();
  let realized = 0, trades = 0, negTotal = 0, negSkipped = 0;
  for (const r of results) {
    if (r.emitted) { trades++; realized += r.realized; assert.ok(r.netBps >= minEdgeBps, `${r.pair} traded below minEdge`); }
    const netNeg = r.netBps == null || r.netBps <= 0;
    if (netNeg) { negTotal++; if (!r.emitted) negSkipped++; }
    // the planner must agree with the scanner's independent net-edge gate
    assert.equal(r.emitted, r.netBps != null && r.netBps >= minEdgeBps, `${r.pair} emit/skip disagrees with net-edge gate`);
  }
  assert.ok(trades >= 1, 'at least one net-positive arb must actually trade (profit-by-construction)');
  assert.equal(negSkipped, negTotal, 'every net<=0 pair was skipped');
  assert.ok(realized >= 0, 'realized arb P&L >= 0 across the run');
});

// ---------------------------------------------------------------------------
// SCANNER: only cost-positive worthy pairs trade; gross-positive/net-negative,
// flagged, and settlement-negative pairs are skipped; PAPER never broadcasts.
// ---------------------------------------------------------------------------
test('SCANNER: trades only cost-positive worthy pairs; paper never broadcasts', async () => {
  const data = BT.syntheticData(); // seeded, no network
  const s = await BT.runScanner(data);
  assert.equal(s.commits, 0, 'PAPER must never broadcast (gate spy == 0)');

  const by = Object.fromEntries(s.candidates.map((d) => [d.pair, d]));
  assert.ok(!by['ARB2/USDC'].traded && by['ARB2/USDC'].reason === 'net-negative', 'gross-positive/net-negative arb skipped');
  assert.ok(!by['SCAM/USDC'].traded && by['SCAM/USDC'].reason === 'flagged', 'flagged scam hard-dropped');
  assert.ok(!by['SETTLE/DAI'].traded && by['SETTLE/DAI'].reason === 'net-negative', 'native-profitable but settlement-negative skipped');

  for (const d of s.candidates) if (d.traded) {
    assert.ok(d.edgeBps > 0, `${d.pair} traded with net edge <= 0`);
    assert.ok(d.score >= s.scan.minProfitBps, `${d.pair} traded below the min score`);
  }
  assert.ok(s.scan.worthy.length >= 1, 'at least one worthy pair trades');
  assert.ok(s.realizedUsd >= 0, 'scanner realized P&L (USDC) >= 0');
});

// ---------------------------------------------------------------------------
// GRID: real deal engine in PAPER never broadcasts; the engine's open-deal
// realized == the sum of its sell fills (no phantom gross); net < gross (fees).
// ---------------------------------------------------------------------------
test('GRID: paper never broadcasts; realized reconciles to fills; net < gross', async () => {
  const data = BT.syntheticData();
  const byRegime = { uptrend: BT.newAgg(), downtrend: BT.newAgg(), range: BT.newAgg() };
  const agg = BT.newAgg();
  const reconcile = { gridGrossTally: 0, gridFillGross: 0, gridCommits: 0 };
  const gateStates = [];
  await BT.runGrid(data, byRegime, agg, reconcile, gateStates);
  assert.equal(reconcile.gridCommits, 0, 'PAPER grid must never broadcast');
  assert.ok(Math.abs(reconcile.gridGrossTally - reconcile.gridFillGross) < 1e-6, 'engine realized == sum of fills (no phantom gross)');
  if (agg.trades > 0) {
    assert.ok(agg.feesUsd > 0, 'fees were actually charged');
    assert.ok(agg.netUsd < agg.grossUsd + 1e-9, 'net is strictly below gross (fees subtracted)');
  }
});

// ---------------------------------------------------------------------------
// RECONCILIATION: momentum's aggregated net P&L must equal the realized total
// produced by the REAL pnl.js Ledger (no un-subtracted fees, no phantom profit).
// ---------------------------------------------------------------------------
test('MOMENTUM: aggregated net P&L reconciles to the pnl.js ledger realized total', async () => {
  const data = BT.syntheticData();
  const byRegime = { uptrend: BT.newAgg(), downtrend: BT.newAgg(), range: BT.newAgg() };
  const agg = BT.newAgg();
  const reconcile = { momNetTally: 0 };
  await BT.runMomentum(data, byRegime, agg, reconcile);
  assert.ok(Math.abs(reconcile.momNetTally - agg.netUsd) < 1e-6, 'ledger-realized == aggregated net');
  if (agg.trades > 0) assert.ok(agg.netUsd < agg.grossUsd + 1e-9, 'net <= gross (fees subtracted on every leg)');
});

// ---------------------------------------------------------------------------
// COST MODEL: the harness uses the engine's OWN mandatory cost constants.
// ---------------------------------------------------------------------------
test('COST: per-leg cost uses the engine constants (agent 5bps floor + slippage 5bps floor + 30bps AMM pool)', () => {
  const AgentStrategies = require('../../agent/strategies.js');
  assert.equal(BT.COST.agentFeeBps, AgentStrategies.AGENT_FEE_BPS, 'agent fee == strategies.AGENT_FEE_BPS');
  assert.equal(BT.COST.agentFeeBps, 5);
  assert.equal(BT.COST.slippageBps, 5);     // strategies.SLIPPAGE_FLOOR_BPS
  assert.equal(BT.COST.venueFeeBps, 30);    // venues.js AMM pool default
  assert.equal(BT.PER_LEG_BPS, 40);
});
