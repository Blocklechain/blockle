// agent/bots.test.js — the Blockle Bots DEAL ENGINE (bots.js) + model/store +
// templates. The deal-engine tests assert the reference engine reproduces the
// AUTHORITATIVE shared fixture docs/bot-vectors.json EXACTLY (base-unit BigInt
// qty, micro-dollar integer basis) so the Dart + Python wallets can assert
// against the same numbers.
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const B = require('./bots.js');
const T = require('./bot-templates.js');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/bot-vectors.json'), 'utf8'));

// paper-fill a decided order exactly as BotRunner._executeOrder does (paper path)
function fillBuy(order, markUc, bd) {
  const qty = B.qtyForUsd(order.usdSizeUc, markUc, bd);
  return { side: 'buy', qty, priceUc: markUc, costUc: B.valueOf(qty, markUc, bd), bd, paper: true };
}
function fillSell(order, markUc, bd) {
  return { side: 'sell', qty: order.qty, priceUc: markUc, proceedsUc: B.valueOf(order.qty, markUc, bd), bd, paper: true };
}
const s = (x) => (x == null ? null : x.toString());

// ===========================================================================
// money/qty helpers — the pinned rounding (shared with pnl.js semantics)
// ===========================================================================
test('money helpers: microUsd, qtyForUsd floors, valueOf + avgEntry round half-away', () => {
  assert.equal(B.microUsd(200).toString(), '200000000');
  assert.equal(B.microUsd(0.01).toString(), '10000');
  // $100 at $90/coin, 8 decimals -> floor(100e6*1e8/90e6) = 111111111
  assert.equal(B.qtyForUsd(B.microUsd(100), B.microUsd(90), 8).toString(), '111111111');
  // value of that qty back at $90 ~ $100 (divRound)
  assert.equal(B.valueOf(111111111n, B.microUsd(90), 8).toString(), '100000000');
  // avg entry of $200 over 2e8 base units @ 8 decimals = $100/coin
  assert.equal(B.avgEntryOf(B.microUsd(200), 200000000n, 8).toString(), '100000000');
  // applyBps: -1000 bps (−10%) of $100 = $90
  assert.equal(B.applyBps(B.microUsd(100), -1000).toString(), '90000000');
  assert.equal(B.pctToBps(2.5), 250);
});

// ===========================================================================
// (1) DCA deal: base -> N safety -> take-profit close — EXACT fixture match
// ===========================================================================
test('vector dca_deal: base + 2 safety orders + TP close reproduces the fixture exactly', () => {
  const V = VECTORS.dca_deal;
  const cfg = B.validateConfig('dca', V.config);
  const bcfg = B.dcaBps(cfg);
  const bd = V.decimals;
  const deal = B.newDcaDeal('t', 0);
  const got = [];
  for (const mUsd of V.priceSeriesUsd) {
    const markUc = B.microUsd(mUsd);
    B.dcaObserve(deal, markUc);
    let guard = 0;
    while (guard++ < 64) {
      const order = B.dcaStep(deal, bcfg, markUc);
      if (!order) break;
      if (order.action === 'arm') { order._markUc = markUc; B.dcaApply(deal, bcfg, order, null, 0); continue; }
      const fill = order.side === 'buy' ? fillBuy(order, markUc, bd) : fillSell(order, markUc, bd);
      B.dcaApply(deal, bcfg, order, fill, 0);
      got.push({ kind: order.kind, side: order.side, priceUc: s(markUc), qty: s(fill.qty), costUc: s(fill.costUc || null), proceedsUc: s(fill.proceedsUc || null), avgEntryUc: s(deal.avgEntryUc), filledQty: s(deal.filledQty) });
      if (deal.status === 'closed') break;
    }
  }
  assert.deepEqual(got, V.fills);
  assert.equal(s(deal.realizedUc), V.realizedUc);
  assert.equal(deal.reason, V.closedReason);
  // sanity: 3 buys (base + 2 SO) then 1 sell
  assert.equal(got.filter((f) => f.side === 'buy').length, 3);
  assert.equal(got.filter((f) => f.side === 'sell').length, 1);
});

// ===========================================================================
// (2) trailing-TP: arm at +tp, ride the peak, sell on the pullback
// ===========================================================================
test('vector trailing_tp: arms at take-profit then sells on the trailing pullback', () => {
  const V = VECTORS.trailing_tp;
  const cfg = B.validateConfig('dca', V.config);
  const bcfg = B.dcaBps(cfg);
  const bd = V.decimals;
  const deal = B.newDcaDeal('t', 0);
  const got = [];
  const events = [];
  for (const mUsd of V.priceSeriesUsd) {
    const markUc = B.microUsd(mUsd);
    B.dcaObserve(deal, markUc);
    let guard = 0;
    while (guard++ < 64) {
      const order = B.dcaStep(deal, bcfg, markUc);
      if (!order) break;
      if (order.action === 'arm') { order._markUc = markUc; B.dcaApply(deal, bcfg, order, null, 0); events.push({ at: mUsd, event: 'trailing-armed', peakUc: s(deal.peakUc) }); continue; }
      const fill = order.side === 'buy' ? fillBuy(order, markUc, bd) : fillSell(order, markUc, bd);
      B.dcaApply(deal, bcfg, order, fill, 0);
      got.push({ kind: order.kind, side: order.side, priceUc: s(markUc), qty: s(fill.qty), costUc: s(fill.costUc || null), proceedsUc: s(fill.proceedsUc || null), avgEntryUc: s(deal.avgEntryUc) });
      if (deal.status === 'closed') break;
    }
  }
  assert.deepEqual(got, V.fills);
  assert.deepEqual(events, V.events);
  assert.equal(s(deal.realizedUc), V.realizedUc); // +$14.00
  // the sell price is the trailing stop (peak 120 − 5% = 114), NOT the +10% target
  assert.equal(got[got.length - 1].priceUc, '114000000');
});

// ===========================================================================
// (3) grid ladder + fill-flip
// ===========================================================================
test('vector grid_ladder: computed ladder + a buy->sell fill-flip reproduce the fixture', () => {
  const V = VECTORS.grid_ladder;
  const cfg = B.validateConfig('grid', V.config);
  const bd = V.decimals;
  const midUc = BigInt(V.midUc);
  const deal = B.newGridDeal('t', cfg, midUc, bd, 0);
  const ladder = deal.levels.map((l) => ({ i: l.i, priceUc: s(l.priceUc), sizeUc: s(l.sizeUc), qty: s(l.qty), side: l.side, status: l.status }));
  assert.deepEqual(ladder, V.ladder);

  const steps = [];
  for (const st of V.steps) {
    const markUc = B.microUsd(st.markUsd);
    let guard = 0; const tickFills = [];
    while (guard++ < 64) {
      const order = B.gridStep(deal, markUc);
      if (!order) break;
      const fill = order.side === 'buy'
        ? { side: 'buy', qty: order.qty, priceUc: markUc, costUc: B.valueOf(order.qty, markUc, bd), bd, paper: true }
        : { side: 'sell', qty: order.qty, priceUc: markUc, proceedsUc: B.valueOf(order.qty, markUc, bd), bd, paper: true };
      B.gridApply(deal, order, fill, 0);
      tickFills.push({ level: order.levelIndex, side: order.side, priceUc: s(markUc), qty: s(fill.qty), costUc: s(fill.costUc || null), proceedsUc: s(fill.proceedsUc || null) });
    }
    steps.push({ markUsd: st.markUsd, fills: tickFills, levels: deal.levels.map((l) => ({ i: l.i, side: l.side, status: l.status, heldQty: s(l.heldQty) })), realizedUc: s(deal.realizedUc) });
  }
  assert.deepEqual(steps, V.steps);
  assert.equal(s(deal.realizedUc), V.realizedUc);
});

// ===========================================================================
// (4) smarttrade split take-profit
// ===========================================================================
test('vector smarttrade_split_tp: entry then two 50% take-profits reproduce the fixture', () => {
  const V = VECTORS.smarttrade_split_tp;
  const cfg = B.validateConfig('smarttrade', V.config);
  const bd = V.decimals;
  const deal = B.newSmartTradeDeal('t', cfg, 0);
  const got = [];
  for (const mUsd of V.priceSeriesUsd) {
    const markUc = B.microUsd(mUsd);
    let guard = 0;
    while (guard++ < 64) {
      const order = B.smartStep(deal, cfg, markUc);
      if (!order) break;
      const fill = order.side === 'buy' ? fillBuy(order, markUc, bd) : fillSell(order, markUc, bd);
      B.smartApply(deal, cfg, order, fill, 0);
      got.push({ kind: order.kind, side: order.side, priceUc: s(markUc), qty: s(fill.qty), costUc: s(fill.costUc || null), proceedsUc: s(fill.proceedsUc || null), avgEntryUc: s(deal.avgEntryUc), remainingQty: s(deal.remainingQty), realizedUc: s(deal.realizedUc) });
      if (deal.status === 'closed') break;
    }
  }
  assert.deepEqual(got, V.fills);
  assert.equal(s(deal.realizedUc), V.realizedUc); // +$15.00
  assert.equal(deal.remainingQty.toString(), '0'); // fully exited
});

test('grid: an optional whole-grid take-profit liquidates all held inventory and closes the deal', () => {
  const cfg = B.validateConfig('grid', { lowerPrice: 0.90, upperPrice: 1.10, gridCount: 5, totalUsd: 50, takeProfitPct: 10 });
  const bcfg = B.gridBcfg(cfg);
  const bd = 8;
  const deal = B.newGridDeal('g', cfg, B.microUsd(1.00), bd, 0);
  const paperFill = (order, markUc) => (order.side === 'buy'
    ? { side: 'buy', qty: order.qty, priceUc: markUc, costUc: B.valueOf(order.qty, markUc, bd), paper: true }
    : { side: 'sell', qty: order.qty, priceUc: markUc, proceedsUc: B.valueOf(order.qty, markUc, bd), paper: true });
  const run = (mUsd) => {
    const markUc = B.microUsd(mUsd); let g = 0;
    while (g++ < 64) { const o = B.gridStep(deal, markUc, bcfg); if (!o) break; B.gridApply(deal, o, paperFill(o, markUc), 0); }
  };
  run(0.95);  // buy the 0.95 level, arm a sell one grid up
  assert.ok(deal.levels.some((l) => l.heldQty > 0n), 'inventory is held');
  run(1.20);  // whole-grid TP: value >> basis*1.10 -> liquidate + close
  assert.equal(deal.status, 'closed');
  assert.equal(deal.reason, 'grid_exit');
  assert.ok(deal.realizedUc > 0n, 'the whole-grid exit realized a gain');
  assert.ok(!deal.levels.some((l) => l.heldQty > 0n), 'no inventory left after the exit');
});

// ===========================================================================
// Bot model + BotStore: defaults, persistence, restart survival
// ===========================================================================
test('Bot defaults: paper + disabled + testnet, validated config', () => {
  const b = new B.Bot({ type: 'dca', universe: { pairs: ['SOL/USDC'] } });
  assert.equal(b.mode, 'paper');
  assert.equal(b.enabled, false);
  assert.equal(b.network, 'testnet');
  assert.equal(b.allocationUsd, 0);
  assert.equal(b.config.maxSafetyOrders, 3);   // default filled
  assert.equal(b.config.takeProfitPct, 2);
});

test('Bot: unknown type throws; grid requires a valid price range', () => {
  assert.throws(() => new B.Bot({ type: 'nope' }), /unknown bot type/);
  assert.throws(() => new B.Bot({ type: 'grid', config: { lowerPrice: 2, upperPrice: 1 } }), /lowerPrice < upperPrice/);
});

test('BotStore: snapshot + load survives a restart with BigInt deal state intact', async () => {
  const mem = {};
  const store = { async set(o) { Object.assign(mem, o); }, async get(keys) { const r = {}; for (const k of keys) r[k] = mem[k]; return r; } };
  const s1 = new B.BotStore({ store, wallet: 'w', channel: 'c' });
  const bot = s1.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, allocationUsd: 50 });
  // simulate an open deal with BigInt state
  bot.state.byPair['BLOCK/USDC'] = { deal: B.newDcaDeal('d', 0), lastCloseAt: 0 };
  bot.state.byPair['BLOCK/USDC'].deal.filledQty = 123456789n;
  bot.state.byPair['BLOCK/USDC'].deal.costUc = 987654321n;
  bot.state.committedUc = 25000000n;
  await s1.persist();

  const s2 = new B.BotStore({ store, wallet: 'w', channel: 'c' });
  await s2.restore();
  const got = s2.get(bot.id);
  assert.ok(got, 'bot restored');
  assert.equal(got.state.byPair['BLOCK/USDC'].deal.filledQty, 123456789n); // BigInt round-trips
  assert.equal(got.state.byPair['BLOCK/USDC'].deal.costUc, 987654321n);
  assert.equal(got.state.committedUc, 25000000n);
  assert.equal(got.allocationUsd, 50);
});

test('BotStore: scoping keeps different (wallet,channel) stores separate', async () => {
  const mem = {};
  const store = { async set(o) { Object.assign(mem, o); }, async get(keys) { const r = {}; for (const k of keys) r[k] = mem[k]; return r; } };
  const a = new B.BotStore({ store, wallet: 'w1', channel: 'c' });
  const bb = new B.BotStore({ store, wallet: 'w2', channel: 'c' });
  a.add({ type: 'dca', universe: { pairs: ['X/USDC'] } });
  await a.persist(); await bb.persist();
  const a2 = new B.BotStore({ store, wallet: 'w1', channel: 'c' }); await a2.restore();
  const b2 = new B.BotStore({ store, wallet: 'w2', channel: 'c' }); await b2.restore();
  assert.equal(a2.list().length, 1);
  assert.equal(b2.list().length, 0);
});

test('persisted bot state carries NO key/seed/credential material', async () => {
  const bot = new B.Bot({ type: 'dca', universe: { pairs: ['X/USDC'] } });
  const json = JSON.stringify(bot.toJSON());
  assert.doesNotMatch(json, /seed|mnemonic|privateKey|apiKey|secret|password/i);
});

// ===========================================================================
// Templates: starter set + export/import (import lands paper + disabled)
// ===========================================================================
test('templates: starter set builds valid paper+disabled bots', () => {
  const names = T.list().map((t) => t.key);
  for (const key of ['conservative_dca', 'aggressive_dca', 'wide_grid', 'scalp_grid', 'block_accumulator']) {
    assert.ok(names.includes(key), 'has ' + key);
    const spec = T.fromTemplate(key, { pair: 'BLOCK/USDC' });
    const bot = new B.Bot(spec);
    assert.equal(bot.mode, 'paper');
    assert.equal(bot.enabled, false);
    assert.equal(bot.allocationUsd, 0);
  }
});

test('templates: export then import round-trips the config and lands paper+disabled+testnet', () => {
  const src = new B.Bot({ type: 'dca', name: 'My DCA', universe: { pairs: ['SOL/USDC'] }, config: { baseOrderUsd: 42, takeProfitPct: 3 }, mode: 'live', enabled: true, allocationUsd: 100, network: 'mainnet' });
  const tpl = T.exportBot(src);
  assert.equal(tpl.kind, 'blockle-bot-template');
  // export carries NO running state / allocation / mode
  assert.equal(tpl.allocationUsd, undefined);
  assert.equal(tpl.mode, undefined);

  const imported = T.importTemplate(JSON.stringify(tpl));
  assert.equal(imported.type, 'dca');
  assert.equal(imported.config.baseOrderUsd, 42);
  assert.equal(imported.config.takeProfitPct, 3);
  // HARD safety: import never auto-arms, never carries live funds/mainnet
  assert.equal(imported.mode, 'paper');
  assert.equal(imported.enabled, false);
  assert.equal(imported.network, 'testnet');
  assert.equal(imported.allocationUsd, 0);
});

test('templates: importing a malicious "live+funded" JSON still lands paper+disabled+zero alloc', () => {
  const evil = { kind: 'blockle-bot-template', type: 'dca', name: 'evil', universe: { pairs: ['X/USDC'] }, config: {}, mode: 'live', enabled: true, allocationUsd: 1000000, network: 'mainnet' };
  const b = T.importTemplate(evil);
  assert.equal(b.mode, 'paper');
  assert.equal(b.enabled, false);
  assert.equal(b.allocationUsd, 0);
  assert.equal(b.network, 'testnet');
});
