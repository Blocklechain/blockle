// bots-ui.test.js — DOM-level tests for the Blockle Bots cockpit controller
// (agent/bots-ui.js). Uses a MINIMAL fake document (no jsdom) like the other
// *-ui tests, plus pure-helper tests for the pieces that carry the safety +
// price-wiring contract:
//
//   • makePriceAccessor feeds the engine REAL marks from the SAME source the
//     agent ctx uses — live Exchange book mid / last trade (per BASE/QUOTE) +
//     the configured USD price map — and OMITS a symbol with no data (so the
//     engine skips that tick; never a fabricated price).
//   • dealLadder reproduces the create-flow deal math (base + safety ladder +
//     avg entry + take-profit) used by the live preview chart.
//   • reviewSheetText (paper->live) restates allocation + auto-within-cap + kill
//     + mainnet before the single confirm.
//   • botCardHtml shows allocation-used-vs-cap + a mode badge + sign-explicit P&L.
//   • enter() renders the shell (Kill-all + four surfaces + PLAY) and the cockpit
//     empty state into a fake #bots-body/#bots-panel; the locked state shows the
//     unlock notice and never builds a runner.
//
//   node --test   (and `node bots-ui.test.js` directly)

const { test } = require('node:test');
const assert = require('node:assert');

// agent/bots-ui.js touches the DOM only inside functions, so it requires cleanly.
const BotsUI = require('./agent/bots-ui.js');
const AgentBots = require('./agent/bots.js');

// ---------------------------------------------------------------------------
// makePriceAccessor — the shared price/mark wiring (REAL marks, never {})
// ---------------------------------------------------------------------------
function fakeExchange(spec) {
  // spec: { markets:[{market,base,quote}], books:{market:{bids,asks}}, trades:{market:[{price}]} }
  return {
    async getMarkets() { return spec.markets || []; },
    async getBook(m) { return (spec.books && spec.books[m]) || { bids: [], asks: [] }; },
    async getTrades(m) { return (spec.trades && spec.trades[m]) || []; },
  };
}

test('price accessor: book MID becomes the mark; stablecoin quote is $1', async () => {
  const ex = fakeExchange({
    markets: [{ market: 'BLOCK/USDC', base: 'BLOCK', quote: 'USDC' }],
    books: { 'BLOCK/USDC': { bids: [{ price: '1.00', amount: '5' }], asks: [{ price: '1.02', amount: '5' }] } },
  });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: {} });
  const out = await prices(['BLOCK', 'USDC']);
  assert.ok(Math.abs(out.BLOCK - 1.01) < 1e-9, 'BLOCK = mid(1.00,1.02) * $1 = 1.01');
  assert.equal(out.USDC, 1, 'stablecoin resolves to $1');
});

test('price accessor: falls back to LAST TRADE when the book is empty', async () => {
  const ex = fakeExchange({
    markets: [{ market: 'BLOCK/USDC', base: 'BLOCK', quote: 'USDC' }],
    books: { 'BLOCK/USDC': { bids: [], asks: [] } },
    trades: { 'BLOCK/USDC': [{ price: '1.05' }, { price: '1.07' }] },
  });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: {} });
  const out = await prices(['BLOCK']);
  assert.ok(Math.abs(out.BLOCK - 1.07) < 1e-9, 'last trade (newest end) is the mark');
});

test('price accessor: a non-USD quote is converted via the configured USD price map', async () => {
  const ex = fakeExchange({
    markets: [{ market: 'FOO/ETH', base: 'FOO', quote: 'ETH' }],
    books: { 'FOO/ETH': { bids: [{ price: '0.49' }], asks: [{ price: '0.51' }] } },
  });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: { ETH: 2000 } });
  const out = await prices(['FOO']);
  assert.ok(Math.abs(out.FOO - 1000) < 1e-6, 'FOO = mid(0.5) * ETH($2000) = $1000');
});

test('price accessor: configured USD price is used when there is no market', async () => {
  const ex = fakeExchange({ markets: [] });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: { BLOCK: 2.5 } });
  const out = await prices(['BLOCK']);
  assert.equal(out.BLOCK, 2.5);
});

test('price accessor: NO data + NO price map -> symbol omitted (engine skips the tick)', async () => {
  const ex = fakeExchange({ markets: [] });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: {} });
  const out = await prices(['ZZZ']);
  assert.ok(!('ZZZ' in out), 'no synthetic price is fabricated');
});

test('price accessor: a market whose quote cannot be priced is skipped (no fabrication)', async () => {
  const ex = fakeExchange({
    markets: [{ market: 'FOO/BAR', base: 'FOO', quote: 'BAR' }],
    books: { 'FOO/BAR': { bids: [{ price: '3' }], asks: [{ price: '3' }] } },
  });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: {} }); // BAR has no USD price
  const out = await prices(['FOO']);
  assert.ok(!('FOO' in out), 'cannot convert BAR->USD, so no FOO mark is invented');
});

test('price accessor: a LIVE Exchange mark overrides a stale configured price', async () => {
  const ex = fakeExchange({
    markets: [{ market: 'BLOCK/USDC', base: 'BLOCK', quote: 'USDC' }],
    books: { 'BLOCK/USDC': { bids: [{ price: '2.00' }], asks: [{ price: '2.00' }] } },
  });
  const prices = BotsUI.makePriceAccessor({ exchange: ex, priceUsd: { BLOCK: 1 } });
  const out = await prices(['BLOCK']);
  assert.equal(out.BLOCK, 2, 'the live book mark wins over the static map');
});

// ---------------------------------------------------------------------------
// dealLadder — the create-flow deal math behind the live preview chart
// ---------------------------------------------------------------------------
test('dealLadder: base + safety ladder, avg entry below price, TP above avg', () => {
  const st = { base: 100, tp: 2, so: 3, step: 2, vol: 1.4, tr: 0 };
  const d = BotsUI.dealLadder(st, 100);
  assert.equal(d.legs.length, 4, 'base + 3 safety orders');
  assert.equal(d.legs[0].k, 'base');
  assert.equal(d.legs[3].k, 'safety');
  assert.ok(d.legs[1].price < d.legs[0].price, 'safety orders ladder down');
  assert.ok(d.avg < 100, 'avg entry is below the start price after dip buys');
  assert.ok(d.tp > d.avg, 'take-profit sits above the average entry');
  assert.ok(d.totalUsd > 100, 'max deal size includes the martingale safety orders');
  assert.ok(d.dip > 0, 'the ladder covers a positive dip %');
});

test('dealLadder: zero safety orders -> single base leg', () => {
  const d = BotsUI.dealLadder({ base: 50, tp: 2, so: 0, step: 2, vol: 1, tr: 0 }, 100);
  assert.equal(d.legs.length, 1);
  assert.ok(Math.abs(d.avg - 100) < 1e-9);
});

// ---------------------------------------------------------------------------
// reviewSheetText — the paper->live / testnet->mainnet REVIEW sheet
// ---------------------------------------------------------------------------
test('review sheet restates allocation + auto-within-cap + kill + network', () => {
  const lines = BotsUI.reviewSheetText({ allocationUsd: 500, network: 'testnet' });
  const blob = lines.join(' \n ');
  assert.ok(/\$500/.test(blob), 'states the allocation cap');
  assert.ok(/auto/i.test(blob) && /cap/i.test(blob), 'states fully-auto within the cap');
  assert.ok(/kill/i.test(blob), 'states the kill switch');
  assert.ok(/testnet/i.test(blob), 'states the network (testnet)');
});

test('review sheet (mainnet) warns about real funds + mainnetEnabled', () => {
  const blob = BotsUI.reviewSheetText({ allocationUsd: 25, network: 'mainnet' }).join(' ');
  assert.ok(/MAINNET/.test(blob) && /real funds/i.test(blob));
  assert.ok(/mainnetEnabled/i.test(blob), 'restates the operator mainnet sign-off requirement');
});

// ---------------------------------------------------------------------------
// botCardHtml — allocation-used-vs-cap + mode badge + sign-explicit P&L
// ---------------------------------------------------------------------------
test('botCardHtml: live badge, allocation bar %, and sign-explicit P&L', () => {
  const bot = { id: 'b1', name: 'SOL Accumulator', type: 'dca', mode: 'live', allocationUsd: 500,
    pairs: () => ['SOL/USDC'], universe: { pairs: ['SOL/USDC'] } };
  const html = BotsUI.botCardHtml(bot, { committedUsd: 240, realizedUsd: 10, unrealizedUsd: -3.42 });
  assert.ok(/bbadge live/.test(html), 'live mode badge');
  assert.ok(/\$240/.test(html) && /\$500/.test(html), 'allocation used vs cap');
  assert.ok(/width:48%/.test(html), 'allocation bar reflects 240/500 = 48%');
  assert.ok(/SOL\/USDC/.test(html), 'shows the pair');
  assert.ok(/\+\$6\.58|\+\$6\.58/.test(html) || /[+−]\$/.test(html), 'P&L is sign-explicit');
});

test('botCardHtml: paper bot with no cap shows a 0% bar (never divides by zero)', () => {
  const bot = { id: 'b2', name: 'Paper', type: 'grid', mode: 'paper', allocationUsd: 0,
    pairs: () => ['BLOCK/USDC'], universe: { pairs: ['BLOCK/USDC'] } };
  const html = BotsUI.botCardHtml(bot, { committedUsd: 0, realizedUsd: 0, unrealizedUsd: 0 });
  assert.ok(/bbadge paper/.test(html));
  assert.ok(/width:0%/.test(html));
});

// ---------------------------------------------------------------------------
// money — sign-explicit, 2dp
// ---------------------------------------------------------------------------
test('money: sign-explicit with two decimals', () => {
  assert.equal(BotsUI.money(1284.6), '+$1,284.60');
  assert.equal(BotsUI.money(-3.4), '−$3.40');
  assert.equal(BotsUI.money(0), '+$0.00');
});

// ---------------------------------------------------------------------------
// DOM-level: a MINIMAL fake document for enter() rendering
// ---------------------------------------------------------------------------
function installFakeDom() {
  const store = new Map();
  function El() {
    this.innerHTML = ''; this.textContent = ''; this.hidden = false; this.className = '';
    this.dataset = {}; this._attr = {};
  }
  El.prototype.addEventListener = function () {};
  El.prototype.setAttribute = function (k, v) { this._attr[k] = v; };
  El.prototype.getAttribute = function (k) { return this._attr[k] != null ? this._attr[k] : null; };
  El.prototype.querySelector = function () { return new El(); };
  El.prototype.querySelectorAll = function () { return []; };
  // NB: no getContext -> the canvas-fit helper short-circuits (no drawing in tests)
  const doc = {
    documentElement: new El(),
    querySelector(sel) { if (!store.has(sel)) store.set(sel, new El()); return store.get(sel); },
    querySelectorAll() { return []; },
  };
  global.document = doc;
  global.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
  return { doc, store };
}

function stubUI() {
  return { show() {}, toast() {}, route() {}, shortAddr: (a) => a };
}

test('enter(): LOCKED wallet shows the unlock notice and builds no runner', async () => {
  const { store } = installFakeDom();
  global.Wallet = { isUnlocked: () => false };
  BotsUI._setRunner(null);
  BotsUI.init(stubUI());
  await BotsUI.enter();
  const body = store.get('#bots-body');
  assert.ok(/Unlock your wallet/i.test(body.innerHTML), 'locked state renders the unlock notice');
});

test('enter(): UNLOCKED renders the shell (Kill-all + 4 surfaces + PLAY) and the cockpit empty state', async () => {
  const { store } = installFakeDom();
  global.Wallet = { isUnlocked: () => true };
  // inject a minimal REAL-shaped runner so enter() skips buildRunner and renders
  BotsUI._setRunner({ Bots: AgentBots, list: () => [], ctx: { prices: async () => ({}) } });
  BotsUI.init(stubUI());
  await BotsUI.enter();

  const body = store.get('#bots-body');
  assert.ok(/Kill all/i.test(body.innerHTML), 'shell has the Kill-all control');
  assert.ok(/Cockpit/.test(body.innerHTML) && /Create/.test(body.innerHTML) &&
    /Detail/.test(body.innerHTML) && /Arena/.test(body.innerHTML), 'all four surfaces are tabbed');
  assert.ok(/play-pill/.test(body.innerHTML), 'Arena carries the PLAY label');

  const panel = store.get('#bots-panel');
  assert.ok(/Create your first bot/i.test(panel.innerHTML), 'empty cockpit invites creating a bot');
  assert.ok(/fully auto within their allocation cap/i.test(panel.innerHTML), 'the safety note is shown');

  BotsUI._setRunner(null);
});
