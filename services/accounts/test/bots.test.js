import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBot, step, botView, mark, BOT_TYPES } from '../src/bots.js';

test('bot types + param sanitization', () => {
  assert.deepEqual(BOT_TYPES, ['dca', 'grid']);
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

test('grid trades within its band and botView has the right shape', () => {
  const b = newBot({ id: 'g', uid: 'u', type: 'grid', pair: 'BLOCK/USD', params: { budget: 600, lower: 8, upper: 12, grids: 4 }, now: 1 });
  for (const p of [10, 9, 8.5, 9.5, 11, 10]) step(b, p);
  assert.ok(b.state.trades.length >= 1, 'grid executed at least one trade');
  const v = botView(b, 10);
  assert.deepEqual(Object.keys(v).sort(), ['createdAt', 'id', 'paper', 'pair', 'params', 'pnl', 'pnlPct', 'status', 'trades', 'type', 'value'].sort());
  assert.equal(v.paper, true);
});
