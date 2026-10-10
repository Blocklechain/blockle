// agent/pnl.test.js — realized-profit engine + pop-up surface (spec §8).
//
//   node --test blockle-extension/agent/
//
// Covers: the PINNED avg-cost ledger semantics + the CANONICAL VECTOR
// (buy 2@$100, buy 1@$160, sell 1.5@$150 => realized EXACTLY +$45.00, avg cost
// unchanged); the post-commit tracker fires ONLY on a positive gain into a
// configured stablecoin; non-stable outputs and losses are silent; unknown basis
// respects requireBasis; the notification copy; and that the realized-profit
// check runs off the ONE dispatchValueMoving commit path (no second path).

const { test } = require('node:test');
const assert = require('node:assert');

const AgentPnl = require('./pnl.js');
const AgentNotify = require('./notify.js');
const AgentRunner = require('./runner.js');

const WALLET = 'default', CH = 'default';

// A capturing notifier (headless): records every notify() payload + rendered msg.
function capNotifier() {
  const fired = [];
  const notifier = AgentNotify.create({
    emit: (msg) => { fired.push(msg); return true; },
  });
  // wrap notify to also expose the raw event
  const orig = notifier.notify.bind(notifier);
  notifier.events = [];
  notifier.notify = (payload) => { notifier.events.push(payload.event); return orig(payload); };
  return { notifier, fired, get events() { return notifier.events; } };
}

// ---------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------
test('microcents: round(usd*1e6) as BigInt, half-away-from-zero', () => {
  assert.strictEqual(AgentPnl.microcents(200), 200000000n);
  assert.strictEqual(AgentPnl.microcents(160), 160000000n);
  assert.strictEqual(AgentPnl.microcents(225), 225000000n);
  assert.strictEqual(AgentPnl.microcents(0.01), 10000n);
  assert.strictEqual(AgentPnl.microcents(null), null);
});

test('divRound: integer-exact half-away-from-zero', () => {
  assert.strictEqual(AgentPnl.divRound(5n, 2n), 3n);   // 2.5 -> 3
  assert.strictEqual(AgentPnl.divRound(4n, 2n), 2n);
  assert.strictEqual(AgentPnl.divRound(-5n, 2n), -3n);
  // the canonical basis-removal: round(costUc*sellQty / qty)
  assert.strictEqual(AgentPnl.divRound(360000000n * 150000000n, 300000000n), 180000000n);
});

// ---------------------------------------------------------------------------
// CANONICAL VECTOR — direct on the ledger (§8, assert exactly)
// ---------------------------------------------------------------------------
test('CANONICAL avg-cost vector: realized EXACTLY +$45.00, avg cost unchanged', () => {
  const led = new AgentPnl.Ledger();
  const K = { wallet: WALLET, channel: CH, asset: 'SOL' };

  led.applyBuy({ ...K, qty: 200000000n, usd: 200 });   // 2e8 base @ $100 => costUc 200000000
  led.applyBuy({ ...K, qty: 100000000n, usd: 160 });   // +1e8 @ $160 => costUc 360000000; qty 3e8

  let lot = led.get(WALLET, CH, 'SOL');
  assert.strictEqual(lot.qty, 300000000n);
  assert.strictEqual(lot.costUc, 360000000n);
  const avgBefore = led.avgCostPerUnit(WALLET, CH, 'SOL');
  assert.strictEqual(avgBefore, 1.2);                   // uc per base unit ($120/coin)

  const r = led.applySell({ ...K, qty: 150000000n, proceedsUsd: 225 });
  assert.strictEqual(r.avgKnown, true);
  assert.strictEqual(r.proceedsUc, 225000000n);
  assert.strictEqual(r.basisUc, 180000000n);            // round(1.2 * 1.5e8)
  assert.strictEqual(r.realizedUc, 45000000n);          // EXACTLY +$45.00
  assert.strictEqual(Number(r.realizedUc) / 1e6, 45);

  lot = led.get(WALLET, CH, 'SOL');
  assert.strictEqual(lot.qty, 150000000n);              // remaining 1.5e8
  assert.strictEqual(lot.costUc, 180000000n);           // basis removed pro-rata
  assert.strictEqual(led.avgCostPerUnit(WALLET, CH, 'SOL'), 1.2); // avg UNCHANGED

  assert.strictEqual(AgentNotify.fmtUsd(Number(r.realizedUc) / 1e6), '+$45.00');
});

// ---------------------------------------------------------------------------
// CANONICAL VECTOR — through the tracker.onCommit swap derivation
// ---------------------------------------------------------------------------
function swapPrep({ from, to, amountIn, amountOut, usd, venue }) {
  return {
    summary: { action: 'swap', venue: venue || 'evmdex', from, to, amountOut: String(amountOut) },
    value: { asset: from, amount: String(amountIn), usd },
  };
}

test('CANONICAL through onCommit: one +$45.00 pop, output USDC', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 } } });

  // two buys (USDC -> SOL) build the SOL basis; neither pops (output not stable)
  await tracker.onCommit({ prep: swapPrep({ from: 'USDC', to: 'SOL', amountIn: 2000000, amountOut: 200000000, usd: 200 }) });
  await tracker.onCommit({ prep: swapPrep({ from: 'USDC', to: 'SOL', amountIn: 1600000, amountOut: 100000000, usd: 160 }) });
  assert.strictEqual(cap.events.length, 0, 'buys into a non-stable do not pop');

  const lot = tracker.ledger.get(WALLET, CH, 'SOL');
  assert.strictEqual(lot.qty, 300000000n);
  assert.strictEqual(lot.costUc, 360000000n);

  // sell 1.5 SOL -> USDC @ $225 => realized +$45.00, fires exactly once
  const ev = await tracker.onCommit({
    prep: swapPrep({ from: 'SOL', to: 'USDC', amountIn: 150000000, amountOut: 225000000, usd: 225, venue: 'jupiter' }),
    txid: '0xdead',
  });
  assert.ok(ev, 'a realized_profit event is returned');
  assert.strictEqual(cap.events.length, 1, 'exactly one pop');
  assert.strictEqual(ev.type, 'realized_profit');
  assert.strictEqual(ev.asset, 'SOL');
  assert.strictEqual(ev.soldQty, '150000000');
  assert.strictEqual(ev.realizedUsd, 45);
  assert.strictEqual(ev.basisUsd, 180);
  assert.strictEqual(ev.proceedsUsd, 225);
  assert.strictEqual(ev.stable, 'USDC');
  assert.strictEqual(ev.venue, 'jupiter');
  assert.strictEqual(ev.txid, '0xdead');

  // the rendered copy
  assert.strictEqual(cap.fired[0].message, '+$45.00 — sold 1.5 SOL → USDC');
  assert.strictEqual(cap.fired[0].title, '+$45.00');
  assert.strictEqual(cap.fired[0].subtitle, 'basis $180.00 → proceeds $225.00');

  // avg cost unchanged after the partial sell
  assert.strictEqual(tracker.ledger.avgCostPerUnit(WALLET, CH, 'SOL'), 1.2);
});

// ---------------------------------------------------------------------------
// Honesty gates
// ---------------------------------------------------------------------------
test('no pop on a non-stable output (SOL -> BTC) even with a gain', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 } } });
  await tracker.onCommit({ prep: swapPrep({ from: 'USDC', to: 'SOL', amountIn: 1000000, amountOut: 100000000, usd: 100 }) });
  const ev = await tracker.onCommit({ prep: swapPrep({ from: 'SOL', to: 'BTC', amountIn: 100000000, amountOut: 1, usd: 150 }) });
  assert.strictEqual(ev, null);
  assert.strictEqual(cap.events.length, 0);
  // but the ledger still updated (SOL sold out)
  assert.strictEqual(tracker.ledger.get(WALLET, CH, 'SOL').qty, 0n);
});

test('a LOSS into a stablecoin updates the ledger silently (no pop)', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 } } });
  await tracker.onCommit({ prep: swapPrep({ from: 'USDC', to: 'SOL', amountIn: 1000000, amountOut: 100000000, usd: 100 }) });
  const ev = await tracker.onCommit({ prep: swapPrep({ from: 'SOL', to: 'USDC', amountIn: 100000000, amountOut: 50000000, usd: 50 }) });
  assert.strictEqual(ev, null, 'a loss does not pop');
  assert.strictEqual(cap.events.length, 0);
  assert.strictEqual(tracker.ledger.get(WALLET, CH, 'SOL').qty, 0n); // ledger updated
});

test('gain below minNotifyUsd does not pop', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 }, minNotifyUsd: 1 } });
  await tracker.onCommit({ prep: swapPrep({ from: 'USDC', to: 'SOL', amountIn: 1000000, amountOut: 100000000, usd: 100 }) });
  const ev = await tracker.onCommit({ prep: swapPrep({ from: 'SOL', to: 'USDC', amountIn: 100000000, amountOut: 100500000, usd: 100.5 }) });
  assert.strictEqual(ev, null, '$0.50 gain is below the $1 threshold');
  assert.strictEqual(cap.events.length, 0);
});

test('unknown basis: requireBasis=true (default) SKIPS the pop', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 } } });
  // sell SOL we never acquired via the agent -> basis unknown
  const ev = await tracker.onCommit({ prep: swapPrep({ from: 'SOL', to: 'USDC', amountIn: 100000000, amountOut: 150000000, usd: 150 }) });
  assert.strictEqual(ev, null);
  assert.strictEqual(cap.events.length, 0);
});

test('unknown basis: requireBasis=false surfaces proceeds-only (no fabricated profit)', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 }, requireBasis: false } });
  const ev = await tracker.onCommit({ prep: swapPrep({ from: 'SOL', to: 'USDC', amountIn: 100000000, amountOut: 150000000, usd: 150 }) });
  assert.ok(ev);
  assert.strictEqual(ev.realizedUsd, null, 'never fabricate a profit');
  assert.strictEqual(ev.basisUnknown, true);
  assert.strictEqual(ev.proceedsUsd, 150);
  assert.strictEqual(cap.events.length, 1);
  assert.match(cap.fired[0].message, /basis unknown/);
});

test('OVERSELL: part acquired outside the agent -> realize only the tracked share (no inflated pop)', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 } } });

  // agent-buy 0.1 SOL for $5 (avg $50/coin). A further 2.0 SOL arrives from OUTSIDE
  // the agent and is never recorded in the ledger (unknown basis).
  await tracker.onCommit({ prep: swapPrep({ from: 'USDC', to: 'SOL', amountIn: 5000000, amountOut: 10000000, usd: 5 }) });
  assert.strictEqual(cap.events.length, 0);
  assert.strictEqual(tracker.ledger.get(WALLET, CH, 'SOL').qty, 10000000n); // only the tracked 0.1

  // sell 2.1 SOL -> USDC for $210 total. Old bug: realized = $210 proceeds − $5 basis
  // = +$205 inflated pop. Correct: prorate proceeds to the held 0.1 -> $10, realize
  // $10 − $5 = +$5; the untracked 2.0 is NOT counted as profit.
  const ev = await tracker.onCommit({
    prep: swapPrep({ from: 'SOL', to: 'USDC', amountIn: 210000000, amountOut: 210000000, usd: 210, venue: 'jupiter' }),
  });

  assert.ok(ev, 'a realized_profit event fires on the tracked gain');
  assert.strictEqual(cap.events.length, 1, 'exactly one pop');
  assert.strictEqual(ev.realizedUsd, 5, 'realize ONLY the tracked 0.1 share, not the oversell');
  assert.notStrictEqual(ev.realizedUsd, 205, 'the inflated oversell gain must never surface');
  assert.strictEqual(ev.basisUsd, 5, 'basis is the tracked 0.1 cost');
  assert.strictEqual(ev.proceedsUsd, 10, 'proceeds prorated to the tracked 0.1 share');
  // internally consistent: proceeds − basis === realized
  assert.strictEqual(ev.proceedsUsd - ev.basisUsd, ev.realizedUsd);
  // lot fully drained; no lingering dust basis
  assert.strictEqual(tracker.ledger.get(WALLET, CH, 'SOL').qty, 0n);

  // direct-on-ledger shape: the oversell remainder is surfaced as unknown qty
  const led = new AgentPnl.Ledger();
  led.applyBuy({ wallet: WALLET, channel: CH, asset: 'SOL', qty: 10000000n, usd: 5 });
  const r = led.applySell({ wallet: WALLET, channel: CH, asset: 'SOL', qty: 210000000n, proceedsUsd: 210 });
  assert.strictEqual(r.appliedQty, 10000000n);
  assert.strictEqual(r.unknownQty, 200000000n);
  assert.strictEqual(r.basisUc, 5000000n);
  assert.strictEqual(r.proceedsUc, 10000000n);        // prorated share, not 210000000
  assert.strictEqual(r.proceedsTotalUc, 210000000n);  // full trade USD still available
  assert.strictEqual(r.realizedUc, 5000000n);         // +$5.00, not +$205.00
});

// ---------------------------------------------------------------------------
// Ledger persistence (no key material)
// ---------------------------------------------------------------------------
test('ledger snapshot/load round-trips BigInt exactly', () => {
  const led = new AgentPnl.Ledger();
  led.applyBuy({ wallet: WALLET, channel: CH, asset: 'SOL', qty: 300000000n, usd: 360 });
  const snap = led.snapshot();
  assert.strictEqual(JSON.stringify(snap).includes('privKey'), false);
  const led2 = new AgentPnl.Ledger();
  led2.load(JSON.parse(JSON.stringify(snap)));
  const lot = led2.get(WALLET, CH, 'SOL');
  assert.strictEqual(lot.qty, 300000000n);
  assert.strictEqual(lot.costUc, 360000000n);
});

// ---------------------------------------------------------------------------
// notify.js copy + headless emitter
// ---------------------------------------------------------------------------
test('notify.format: realized-profit copy', () => {
  const m = AgentNotify.format({ asset: 'SOL', soldQty: '150000000', realizedUsd: 45, basisUsd: 180, proceedsUsd: 225, stable: 'USDC' }, 8);
  assert.strictEqual(m.title, '+$45.00');
  assert.strictEqual(m.message, '+$45.00 — sold 1.5 SOL → USDC');
  assert.strictEqual(m.subtitle, 'basis $180.00 → proceeds $225.00');
});

test('notify.fmtQty: decimals + trailing-zero trim; unknown => raw base units', () => {
  assert.strictEqual(AgentNotify.fmtQty('150000000', 8), '1.5');
  assert.strictEqual(AgentNotify.fmtQty('100000000', 8), '1');
  assert.strictEqual(AgentNotify.fmtQty('3200000000', 9), '3.2');
  assert.strictEqual(AgentNotify.fmtQty('150000000', null), '150000000');
});

test('notify default emit: no chrome + no document => false (headless no-op)', () => {
  assert.strictEqual(AgentNotify.defaultEmit({ title: 't', message: 'm', subtitle: '' }), false);
});

test('notify: injected emitter captures the message headlessly', () => {
  const seen = [];
  const n = AgentNotify.create({ emit: (m) => { seen.push(m); return true; } });
  n.notify({ event: { asset: 'SOL', soldQty: '150000000', realizedUsd: 45, basisUsd: 180, proceedsUsd: 225, stable: 'USDC' }, decimals: 8 });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].message, '+$45.00 — sold 1.5 SOL → USDC');
});

// ---------------------------------------------------------------------------
// WIRING: the realized check runs off the ONE dispatchValueMoving commit path
// ---------------------------------------------------------------------------
function fakePolicy() {
  return {
    assertLive() {},
    assessValue() {},
    async gateConfirm() { return { approved: true }; },
    recordSpend() {},
  };
}
function fakeSwapTool() {
  return {
    name: 'swap', valueMoving: true,
    async prepare(a) {
      return {
        summary: { action: 'swap', venue: 'evmdex', from: a.from, to: a.to, amountOut: String(a.amountOut) },
        value: { asset: a.from, amount: String(a.amount), usd: a.usd },
        commit: async () => ({ txid: '0xfeed' }),
      };
    },
  };
}

test('WIRING: dispatchValueMoving runs the pnl post-commit hook (single path)', async () => {
  const cap = capNotifier();
  const tracker = AgentPnl.create({ notifier: cap.notifier, config: { decimals: { SOL: 8 } } });
  const tool = fakeSwapTool();
  const policy = fakePolicy();

  // establish basis, then realize a gain into USDC — all through dispatchValueMoving
  await AgentRunner.dispatchValueMoving({
    tool, args: { from: 'USDC', to: 'SOL', amount: '3600000', amountOut: '300000000', usd: 360 },
    policy, name: 'swap', pnl: tracker,
  });
  assert.strictEqual(cap.events.length, 0);

  const r = await AgentRunner.dispatchValueMoving({
    tool, args: { from: 'SOL', to: 'USDC', amount: '150000000', amountOut: '225000000', usd: 225 },
    policy, name: 'swap', pnl: tracker,
  });
  assert.ok(r.result && r.result.txid === '0xfeed');
  assert.strictEqual(cap.events.length, 1, 'the ONE post-commit hook fired');
  assert.strictEqual(cap.events[0].realizedUsd, 45);
  assert.strictEqual(cap.fired[0].message, '+$45.00 — sold 1.5 SOL → USDC');
});
