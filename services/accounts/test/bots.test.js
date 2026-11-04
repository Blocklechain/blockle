import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBot, step, botView, mark, BOT_TYPES } from '../src/bots.js';

test('bot types + param sanitization', () => {
  assert.deepEqual(BOT_TYPES, ['dca', 'grid', 'smarttrade', 'signal']);
  const b = newBot({ id: 'b1', uid: 'u', type: 'dca', pair: 'BLOCK/USD', params: { budget: -5, buyAmount: 1e12, everyTicks: 0 }, now: 1 });
  assert.equal(b.params.budget >= 1, true);
  assert.equal(b.params.everyTicks >= 1, true);
  assert.equal(b.paper, true);
  assert.equal(b.state.cash, b.params.budget);
});

test('DCA buys a fixed amount every N ticks and conserves value at a flat price', () => {
  const b = newBot({ id: 'b', uid: 'u', type: 'dca', pair: 'BLOCK/USD', params: { budget: 300, buyAmount: 100, everyTicks: 2 }, now: 1 });
  // flat price 10: ticks 2 and 4 buy 100 each → spends 200, holds 20 base; value stays 300
  let last;
  for (let i = 0; i < 5; i++) last = step(b, 10);
  assert.equal(b.state.trades.length, 2, 'two buys at ticks 2 and 4');
  assert.ok(Math.abs(last.value - 300) < 1e-9, 'flat price conserves value');
  assert.ok(Math.abs(last.pnl) < 1e-9);
  assert.ok(Math.abs(b.state.base - 20) < 1e-9);
});

test('DCA shows a gain when the price rises after buying', () => {
  const b = newBot({ id: 'b', uid: 'u', type: 'dca', pair: 'BLOCK/USD', params: { budget: 300, buyAmount: 100, everyTicks: 1 }, now: 1 });
  step(b, 10); // buy 10 base
  const m = mark(b, 20); // price doubles
  assert.ok(m.pnl > 0, 'rising price → positive P&L');
  assert.ok(m.value > 300);
});

test('a paused bot does not trade', () => {
  const b = newBot({ id: 'b', uid: 'u', type: 'dca', pair: 'BLOCK/USD', params: { budget: 300, buyAmount: 100, everyTicks: 1 }, now: 1 });
  b.status = 'paused';
  step(b, 10); step(b, 10);
  assert.equal(b.state.trades.length, 0);
});

test('smart-trade exits at take-profit and at stop-loss', () => {
  const tp = newBot({ id: 't', uid: 'u', type: 'smarttrade', pair: 'BLOCK/USD', params: { budget: 1000, takeProfitPct: 20, stopLossPct: 10 }, now: 1 });
  step(tp, 10);                 // enter at 10
  assert.equal(tp.state.entered, true);
  const m = step(tp, 12.5);     // +25% ≥ +20% take-profit → exit in profit
  assert.equal(tp.status, 'done');
  assert.ok(m.pnl > 0 && tp.state.base === 0);

  const sl = newBot({ id: 's', uid: 'u', type: 'smarttrade', pair: 'BLOCK/USD', params: { budget: 1000, takeProfitPct: 20, stopLossPct: 10 }, now: 1 });
  step(sl, 10);
  const m2 = step(sl, 8.9);     // -11% ≤ -10% stop-loss → exit at a loss
  assert.equal(sl.status, 'done');
  assert.ok(m2.pnl < 0 && sl.state.base === 0);
});

test('signal bot buys momentum up and sells momentum down', () => {
  const b = newBot({ id: 'g', uid: 'u', type: 'signal', pair: 'BLOCK/USD', params: { budget: 1000, thresholdPct: 2 }, now: 1 });
  step(b, 10);        // establishes lastPrice, no trade yet
  step(b, 10.5);      // +5% ≥ 2% → buy
  assert.ok(b.state.base > 0);
  step(b, 10.0);      // -4.8% ≤ -2% → sell all
  assert.equal(b.state.base, 0);
  assert.ok(b.state.trades.length >= 2);
});

test('smart-trade trailing stop banks a gain on a reversal (not just a fixed stop)', () => {
  // High take-profit so it never triggers; the trailing stop should exit IN PROFIT after a pullback.
  const b = newBot({ id: 't', uid: 'u', type: 'smarttrade', pair: 'BLOCK/USD', params: { budget: 1000, takeProfitPct: 100, stopLossPct: 10 }, now: 1 });
  step(b, 10);            // enter at 10
  step(b, 15);            // runs to 15 (high-water)
  const m = step(b, 13.4); // pulls back below 15*(1-10%)=13.5 → trailing stop
  assert.equal(b.status, 'done');
  assert.ok(m.pnl > 0, 'trailing stop exits in profit, not at a loss');
  assert.equal(b.state.base, 0);
});

test('DCA take-profit banks the position when the portfolio is up', () => {
  const b = newBot({ id: 'd', uid: 'u', type: 'dca', pair: 'BLOCK/USD', params: { budget: 300, buyAmount: 100, everyTicks: 1, takeProfitPct: 12, trailPct: 7 }, now: 1 });
  step(b, 10);           // buy 100 → base 10, value 300
  const m = step(b, 14); // tick 2 buys, then value up >12% → take-profit sells all
  assert.ok(m.pnl > 0, 'realized a gain');
  assert.equal(b.state.base, 0, 'position banked to cash');
  assert.ok(b.state.trades.some((t) => t.reason === 'take-profit'));
});

test('grid breakdown stop liquidates and pauses buying below the band', () => {
  const b = newBot({ id: 'g', uid: 'u', type: 'grid', pair: 'BLOCK/USD', params: { budget: 600, lower: 8, upper: 12, grids: 4, breakoutStopPct: 8 }, now: 1 });
  for (const p of [10, 9, 8.2]) step(b, p); // accumulate some base inside the band
  const before = b.state.trades.length;
  step(b, 7);  // 7 < 8*(1-8%)=7.36 → breakdown: liquidate + halt
  assert.equal(b.state.base, 0, 'liquidated on breakdown');
  assert.ok(b.state.halted, 'buying paused');
  step(b, 6.5); // still below band → NO new buy while halted
  assert.equal(b.state.trades.filter((t) => t.side === 'buy').length,
    b.state.trades.filter((t, i) => t.side === 'buy' && i < before).length,
    'no buys while halted below the band');
});

test('grid trades within its band and botView has the right shape', () => {
  const b = newBot({ id: 'g', uid: 'u', type: 'grid', pair: 'BLOCK/USD', params: { budget: 600, lower: 8, upper: 12, grids: 4 }, now: 1 });
  for (const p of [10, 9, 8.5, 9.5, 11, 10]) step(b, p);
  assert.ok(b.state.trades.length >= 1, 'grid executed at least one trade');
  const v = botView(b, 10);
  assert.deepEqual(Object.keys(v).sort(), ['createdAt', 'id', 'paper', 'pair', 'params', 'pnl', 'pnlPct', 'status', 'trades', 'type', 'value'].sort());
  assert.equal(v.paper, true);
});
