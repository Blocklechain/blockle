// pass3.test.js — execution plumbing (disjoint files: exchange-client.js +
// wiring.js). Proves the backends the agent tools call actually exist and build
// the right requests, WITHOUT network or a browser:
//
//   • exchange-client.js: swap/quote/sellBlock/listAsset exist; resolveSwap +
//     walkBook are exact; swap signs locally and POSTs the expected /orders body.
//   • wiring.js agentCtx(): every ctx method (incl. ctx.amm.* + ctx.launchToken)
//     is a function; the native AMM swap + BLOCK-20 launch drive the BLOCK rail.
//
//   node pass3.test.js
//
// Fake `chrome` + a routed `fetch` + stubbed Wallet/Chain/Signer back it all.

const { test } = require('node:test');
const assert = require('node:assert');

// ---- in-memory chrome.storage shim (installed BEFORE storage.js) ------------
function memArea() {
  const m = new Map();
  return {
    async get(keys) {
      if (keys == null) { const o = {}; for (const [k, v] of m) o[k] = v; return o; }
      const list = Array.isArray(keys) ? keys : typeof keys === 'object' ? Object.keys(keys) : [keys];
      const out = {};
      for (const k of list) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); },
    _map: m,
  };
}
globalThis.chrome = { storage: { local: memArea(), session: memArea() } };

require('./storage.js');        // -> globalThis.Store, globalThis.Session
require('./venues.js');         // -> globalThis.Venues (amm math)
const Exchange = require('./exchange-client.js');
const Wiring = require('./wiring.js');

// ---- a routed fetch Response ------------------------------------------------
function resp(status, data) {
  return {
    ok: status < 400,
    status,
    async text() { return data == null ? '' : JSON.stringify(data); },
    headers: { forEach() {}, get() { return null; } },
  };
}

// =========================== exchange-client.js ==============================

test('exchange: the agent-called methods exist', () => {
  for (const name of ['getMarkets', 'getBook', 'getTrades', 'quote', 'swap',
    'placeOrder', 'cancelOrder', 'buyBlock', 'sellBlock', 'listAsset',
    'listingQuote', 'resolveSwap', 'walkBook']) {
    assert.strictEqual(typeof Exchange[name], 'function', 'missing ' + name);
  }
});

test('exchange.resolveSwap: direct=sell, inverse=buy, else throw', () => {
  const markets = [{ market: 'BLOCK/USDC', base: 'BLOCK', quote: 'USDC' }];
  const d = Exchange.resolveSwap(markets, 'BLOCK', 'USDC');
  assert.strictEqual(d.market, 'BLOCK/USDC');
  assert.strictEqual(d.side, 'sell');
  assert.strictEqual(d.inverse, false);
  const inv = Exchange.resolveSwap(markets, 'USDC', 'BLOCK');
  assert.strictEqual(inv.market, 'BLOCK/USDC');
  assert.strictEqual(inv.side, 'buy');
  assert.strictEqual(inv.inverse, true);
  assert.throws(() => Exchange.resolveSwap(markets, 'BLOCK', 'ETH'), /no market/);
});

test('exchange.walkBook: exact BigInt sell + buy with decimal prices', () => {
  // SELL 50 base into bids [price 2 x 100]: out = 50 * 2 = 100 quote, full.
  const sell = Exchange.walkBook('sell', '50', [{ price: '2', amount: '100' }]);
  assert.strictEqual(sell.amountOut, '100');
  assert.strictEqual(sell.partial, false);
  // SELL 150 base into bids [2 x 100, 1.5 x 100]: 100*2 + 50*1.5 = 275.
  const sell2 = Exchange.walkBook('sell', '150', [
    { price: '2', amount: '100' }, { price: '1.5', amount: '100' },
  ]);
  assert.strictEqual(sell2.amountOut, '275');
  // BUY with 100 quote against asks [price 2 x 100 base]: 100 quote buys 50 base,
  // all quote consumed so nothing left over (not partial).
  const buy = Exchange.walkBook('buy', '100', [{ price: '2', amount: '100' }]);
  assert.strictEqual(buy.amountOut, '50');
  assert.strictEqual(buy.partial, false);
  // BUY with 300 quote against the same single level (costs 200 for all 100 base):
  // fills the whole level, 100 quote unspent -> partial.
  const buy2 = Exchange.walkBook('buy', '300', [{ price: '2', amount: '100' }]);
  assert.strictEqual(buy2.amountOut, '100');
  assert.strictEqual(buy2.partial, true);
});

test('exchange.swap: signs locally + POSTs the expected /orders request', async () => {
  await Store.set({ exchangeBase: 'https://ex.test' });
  await Session.clear('ex:session');

  // local ML-DSA signer stub — keys never leave; returns a fixed sig.
  globalThis.Wallet = {
    address: 'block1testaddr',
    publicKeyHex: 'pub',
    isUnlocked: () => true,
    async signMessage() { return { signature: 'sig', publicKey: 'pub' }; },
  };

  let orderBody = null;
  globalThis.fetch = async (url, opts) => {
    const p = new URL(url).pathname;
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (p === '/auth/nonce') return resp(200, { nonce: 'nonce-123' });
    if (p === '/auth/verify') return resp(200, { token: 'tok', expires: Math.floor(Date.now() / 1000) + 3600 });
    if (p === '/markets') return resp(200, [{ market: 'BLOCK/USDC', base: 'BLOCK', quote: 'USDC' }]);
    if (p.indexOf('/book/') === 0) return resp(200, { bids: [{ orderId: 'o1', price: '2', amount: '100' }], asks: [] });
    if (p === '/orders') { orderBody = body; return resp(200, { orderId: 'ord1' }); }
    if (p === '/swaps/mine') return resp(200, []);
    return resp(404, { error: 'no route ' + p });
  };

  const r = await Exchange.swap('BLOCK', 'USDC', '50', { slippage: 0.01, timeoutMs: 0 });
  assert.strictEqual(r.orderId, 'ord1');
  assert.strictEqual(r.market, 'BLOCK/USDC');
  assert.strictEqual(r.side, 'sell');
  assert.strictEqual(r.swap, null); // no relay swap in this stub

  assert.ok(orderBody, '/orders was posted');
  assert.strictEqual(orderBody.signature, 'sig');
  assert.strictEqual(orderBody.publicKey, 'pub');
  assert.ok(orderBody.intent, 'carries the signed intent');
  assert.strictEqual(orderBody.intent.market, 'BLOCK/USDC');
  assert.strictEqual(orderBody.intent.side, 'sell');
  assert.strictEqual(orderBody.intent.type, 'market'); // took the best resting bid
  assert.strictEqual(orderBody.intent.price, '2');
  assert.strictEqual(orderBody.intent.amount, '50');
  assert.strictEqual(orderBody.intent.maker, 'block1testaddr');
});

test('exchange.listAsset: pays the relay-named payTo, then registers', async () => {
  await Store.set({ exchangeBase: 'https://ex.test' });

  globalThis.Wallet = {
    address: 'block1testaddr', publicKeyHex: 'pub', isUnlocked: () => true,
    async signMessage() { return { signature: 'sig', publicKey: 'pub' }; },
    async buildTransfer() { return { raw: 'feeraw', txid: 'feetx' }; },
  };
  globalThis.Chain = {
    async utxos() { return { utxos: [{ txid: 'u', vout: 0, amount: 100000000 }] }; },
    async submit() { return { txid: 'feetx' }; },
  };

  let listingBody = null;
  globalThis.fetch = async (url, opts) => {
    const p = new URL(url).pathname;
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (p === '/listings/quote') return resp(200, { totalUsd: 5, payTo: 'block1treasury', payAmount: '500000000' });
    if (p === '/auth/nonce') return resp(200, { nonce: 'n' });
    if (p === '/auth/verify') return resp(200, { token: 'tok' });
    if (p === '/listings') { listingBody = body; return resp(200, { listingId: 'L1', markets: ['BLOCK/FOO'] }); }
    return resp(404, { error: 'no route ' + p });
  };

  const res = await Exchange.listAsset({ asset: { symbol: 'FOO', chain: 'block', kind: 'block20', decimals: 8 }, extraPairs: [] });
  assert.strictEqual(res.listingId, 'L1');
  assert.ok(listingBody, '/listings registered');
  assert.strictEqual(listingBody.paymentTxid, 'feetx'); // paid the fee first
  assert.strictEqual(listingBody.asset.symbol, 'FOO');
});

// =============================== wiring.js ===================================

test('wiring.agentCtx: every agent capability is wired as a function', () => {
  globalThis.Exchange = Exchange; // agentCtx reads global.Exchange
  const ctx = Wiring.agentCtx();
  for (const name of ['getAddress', 'getBalance', 'buildSend', 'broadcast',
    'listAssets', 'estimateUsd', 'explorerTx', 'launchToken']) {
    assert.strictEqual(typeof ctx[name], 'function', 'ctx.' + name + ' not a function');
  }
  assert.strictEqual(ctx.exchange, Exchange, 'ctx.exchange is the exchange client');
  assert.strictEqual(typeof ctx.amm, 'object', 'ctx.amm present');
  for (const name of ['swap', 'quote', 'createPool', 'addLiquidity', 'removeLiquidity']) {
    assert.strictEqual(typeof ctx.amm[name], 'function', 'ctx.amm.' + name + ' not a function');
  }
});

test('wiring.amm.swap: quotes the pool then builds + broadcasts on the BLOCK rail', async () => {
  globalThis.Wallet = {
    address: 'block1x', isUnlocked: () => true,
    async buildPoolSwapBuy(utxos, token, blockIn, minOut) {
      assert.strictEqual(token, 'tok');
      assert.strictEqual(blockIn, 1000n);
      assert.ok(minOut > 0n, 'minOut derived from the quote');
      return { raw: 'aa', txid: 'built' };
    },
  };
  globalThis.Chain = {
    async pools() { return [{ token: 'tok', blockReserve: '1000000', tokenReserve: '2000000', poolFeeBps: 30 }]; },
    async utxos() { return { utxos: [{ txid: 'u', vout: 0, amount: 100000000 }] }; },
    async submit() { return { txid: 'tx1' }; },
  };
  const r = await Wiring.amm.swap({ token: 'tok', side: 'buy', amountIn: '1000', slippage: 0.01 });
  assert.strictEqual(r.txid, 'tx1');
  assert.strictEqual(r.accepted, true);
});

test('wiring.launchToken: deploy -> wait -> init through the BLOCK rail', async () => {
  globalThis.Signer = { async buildBlock20() { return 'deadbeef'; } };
  globalThis.Wallet = {
    address: 'block1x', isUnlocked: () => true,
    async buildDeploy() { return { raw: 'd1', txid: 'deploytx', contractId: 'ct1' }; },
    async buildCall() { return { raw: 'c1', txid: 'inittx' }; },
  };
  globalThis.Chain = {
    async utxos() { return { utxos: [{ txid: 'u', vout: 0, amount: 100000000 }] }; },
    async submit(raw) { return { txid: raw === 'd1' ? 'deploytx' : 'inittx' }; },
    async tx() { return { confirmations: 1 }; },
  };
  const r = await Wiring.launchToken({ name: 'Foo', symbol: 'FOO', decimals: 8, supply: '1000000' });
  assert.deepStrictEqual(r, { contractId: 'ct1', deployTxid: 'deploytx', initTxid: 'inittx' });
});
