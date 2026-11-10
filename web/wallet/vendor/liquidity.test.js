// liquidity.test.js — node gate for the web-wallet Blockle Liquidity client.
// Proves the LOCAL bonding-curve preview matches the server math (floor/spot,
// buy ~10% per 500 BLOCK, exact round-trip neutrality), the helper tables
// (chainForCoin / gasReserve / isTokenCoin), availableUsd on-chain capping, and
// the pending-settlement add/resume/drop logic — with an injected fetch + Store
// (no network, no DOM).
//
//   node web/wallet/vendor/liquidity.test.js

const L = require('./liquidity.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
function eq(name, got, want) { if (got === want) pass++; else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); } }
function near(name, got, want, eps) {
  if (Math.abs(got - want) <= (eps == null ? 1e-9 : eps)) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + got + '\n  want ' + want); }
}

// ---- curve: floor + spot ---------------------------------------------------
near('floor at zero fees', L.priceFloorUsd(0), 0.001);
near('floor rises $0.001 per $50 of fees', L.priceFloorUsd(50), 0.002);
near('spot == floor at full treasury', L.spotPriceUsd(0, 50000), 0.001);
// A 500-BLOCK buy-out (1% of the seed) lifts spot ~10% at the 0.001 floor.
near('spot +10% after 500 BLOCK bought out', L.spotPriceUsd(0, 49500), 0.0011);
near('spot min multiplier clamps', L.spotPriceUsd(0, 50000 + 1e7), 0.001 * 0.1);

// ---- localQuote: buy (coin → BLOCK) ----------------------------------------
L.state = { blockTreasury: 50000, totalFeesUsd: 0, reserves: {} };
// usdIn that integrates to exactly 500 BLOCK from d0=0:
//   usdIn = F·(x + C·x²/2) = 0.001·(500 + 0.0002·125000) = 0.525
const buy = L.localQuote('USDC', 'BLOCK', 0.525, 1);
ok('buy ok', buy.ok === true && buy.local === true);
near('0.525 USDC buys exactly 500 BLOCK along the curve', buy.amountOut, 500, 1e-6);
eq('buy assets', buy.assetIn + '>' + buy.assetOut, 'USDC>BLOCK');
near('buy quotes pre-trade spot', buy.blockPriceUsd, 0.001);
// Tiny buy fills ~at spot (integral ≈ spot for dx→0).
near('tiny buy ≈ spot fill', L.localQuote('USDC', 'BLOCK', 0.001, 1).amountOut, 1, 1e-3);
// Spot AFTER that 500-BLOCK buy is ~10% higher.
L.state = { blockTreasury: 49500, totalFeesUsd: 0, reserves: {} };
near('post-buy spot is +10%', L.spotPriceUsd(0, 49500) / 0.001, 1.1);

// ---- localQuote: round-trip neutrality -------------------------------------
// Buy x BLOCK, apply the treasury move, sell the same x back: the sell integral
// over the SAME curve segment must return exactly the USD paid in.
L.state = { blockTreasury: 48000, totalFeesUsd: 123.45, reserves: { SOL: 1e9 } };
const usdIn = 7.77;
const px = 155.5; // SOL price
const b2 = L.localQuote('SOL', 'BLOCK', usdIn / px, px);
ok('round-trip buy ok', b2.ok === true);
L.state = { blockTreasury: 48000 - b2.amountOut, totalFeesUsd: 123.45, reserves: { SOL: 1e9 } };
const s2 = L.localQuote('BLOCK', 'SOL', b2.amountOut, px);
ok('round-trip sell ok', s2.ok === true);
near('round-trip returns the exact USD in', s2.amountOut * px, usdIn, 1e-9);

// ---- localQuote: guards ----------------------------------------------------
L.state = { blockTreasury: 50000, totalFeesUsd: 0, reserves: { USDC: 0.4 } };
ok('zero amount rejected', L.localQuote('USDC', 'BLOCK', 0, 1).ok === false);
ok('both-BLOCK rejected', L.localQuote('BLOCK', 'BLOCK', 1, 1).ok === false);
ok('neither-BLOCK rejected', L.localQuote('USDC', 'SOL', 1, 1).ok === false);
const dry = L.localQuote('BLOCK', 'SOL', 100, 150);
ok('no reserve → "No liquidity"', dry.ok === false && /No liquidity for SOL/.test(dry.reason));
const thin = L.localQuote('BLOCK', 'USDC', 1000, 1); // wants 1 USDC, has 0.4
ok('thin reserve → "Only … available"', thin.ok === false && /Only 0\.4/.test(thin.reason));
const huge = L.localQuote('USDC', 'BLOCK', 1e9, 1);
ok('treasury exhausted on huge buy', huge.ok === false && /exhausted/.test(huge.reason));

// ---- helpers ---------------------------------------------------------------
eq('chainForCoin BLOCK', L.chainForCoin('block'), 'block');
eq('chainForCoin ETH', L.chainForCoin('ETH'), 'ethereum');
eq('chainForCoin USDC (token on ethereum)', L.chainForCoin('USDC'), 'ethereum');
eq('chainForCoin SOL', L.chainForCoin('SOL'), 'solana');
eq('chainForCoin BTC', L.chainForCoin('BTC'), 'bitcoin');
eq('chainForCoin LTC', L.chainForCoin('LTC'), 'litecoin');
eq('chainForCoin DOGE', L.chainForCoin('DOGE'), 'dogecoin');
eq('chainForCoin BCH', L.chainForCoin('BCH'), 'bitcoincash');
eq('chainForCoin XRP', L.chainForCoin('XRP'), 'xrp');
eq('chainForCoin ADA', L.chainForCoin('ADA'), 'cardano');
eq('chainForCoin TRX', L.chainForCoin('TRX'), 'tron');
eq('chainForCoin BNB', L.chainForCoin('BNB'), 'bnb');
eq('chainForCoin MATIC', L.chainForCoin('MATIC'), 'polygon');
eq('chainForCoin AVAX', L.chainForCoin('AVAX'), 'avalanche');
eq('chainForCoin DOT unwired', L.chainForCoin('DOT'), null);
ok('isTokenCoin', L.isTokenCoin('usdc') && L.isTokenCoin('USDT') && L.isTokenCoin('DAI') && !L.isTokenCoin('ETH'));
near('gasReserve ETH', L.gasReserve('ETH'), 0.0006);
near('gasReserve BNB', L.gasReserve('bnb'), 0.0008);
near('gasReserve MATIC', L.gasReserve('MATIC'), 0.05);
near('gasReserve AVAX', L.gasReserve('AVAX'), 0.01);
near('gasReserve SOL', L.gasReserve('SOL'), 0.00002);
near('gasReserve BLOCK', L.gasReserve('BLOCK'), 0.001);
near('gasReserve BTC family', L.gasReserve('BTC') + L.gasReserve('LTC') + L.gasReserve('BCH') + L.gasReserve('DOGE'), 0.0012);
near('gasReserve XRP', L.gasReserve('XRP'), 0.00002);
near('gasReserve ADA', L.gasReserve('ADA'), 0.2);
near('gasReserve TRX', L.gasReserve('TRX'), 1);
near('gasReserve unknown = 0', L.gasReserve('DOT'), 0);
ok('kMoonPayCoins has the 16', L.kMoonPayCoins.length === 16 && L.kMoonPayCoins.includes('BCH') && L.kMoonPayCoins.includes('USDC'));

// ---- availableUsd capping --------------------------------------------------
L.state = {
  blockTreasury: 50000, totalFeesUsd: 0,
  reserves: { SOL: 10, ETH: 2 },
  settlement: 'onchain',
  onchain: { SOL: { balance: 5, spendable: 4 }, ETH: null },
};
near('availableUsd capped by on-chain spendable', L.availableUsd('SOL', 100), 400);
near('availableUsd uncapped when chain unreported', L.availableUsd('ETH', 2000), 4000);
L.state.settlement = 'accounting';
near('availableUsd ledger-only while accounting', L.availableUsd('SOL', 100), 1000);
near('availableUsd px fallback 1', L.availableUsd('SOL', 0), 10);
near('availableUsd unknown coin = 0', L.availableUsd('DOT', 5), 0);

// ---- pending + loadState with injected fetch/Store -------------------------
const mem = {};
L._store = {
  async get(k) { const o = {}; if (k in mem) o[k] = mem[k]; return o; },
  async set(o) { Object.assign(mem, JSON.parse(JSON.stringify(o))); },
};
const calls = { state: 0, settle: [] };
const settleReply = {}; // id → reply
L._fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  let reply = {};
  if (url.endsWith('/state')) {
    calls.state++;
    reply = { blockTreasury: 49990, blockSeedSupply: 50000, totalFeesUsd: 1.5, reserves: { SOL: 3 }, fees: { SOL: 1.5 } };
  } else if (url.endsWith('/settle')) {
    calls.settle.push(body.id);
    reply = settleReply[body.id] || { ok: false, error: 'unknown swap' };
  }
  return { ok: true, json: async () => reply };
};

(async () => {
  // loadState: fetch, then 30s cache, then force.
  L.state = null;
  const st = await L.loadState();
  ok('loadState adopts server state', st && st.blockTreasury === 49990 && L.state === st);
  await L.loadState();
  eq('loadState cached within TTL', calls.state, 1);
  await L.loadState(true);
  eq('loadState force refetches', calls.state, 2);
  near('spot from live server state', L.spotPriceUsd(L.state.totalFeesUsd, L.state.blockTreasury),
    (0.001 + 1.5 / 50000) * (1 + 0.0002 * 10), 1e-12);

  // pending: add (dedup by id), resume drops terminal, keeps confirming.
  await L.addPending({ id: 'a1', depositTxid: 't1', from: 'BLOCK', to: 'SOL', amountOut: 0.5 });
  await L.addPending({ id: 'b2', depositTxid: 't2', from: 'USDC', to: 'BLOCK', amountOut: 9 });
  await L.addPending({ id: 'c3', depositTxid: 't3', from: 'BLOCK', to: 'ETH', amountOut: 0.01 });
  await L.addPending({ id: 'a1', depositTxid: 't1b', from: 'BLOCK', to: 'SOL', amountOut: 0.5 }); // replace
  let p = await L.pending();
  eq('addPending dedups by id', p.length, 3);
  eq('addPending keeps newest record', p.find((e) => e.id === 'a1').depositTxid, 't1b');
  ok('pending persisted under liq_pending', Array.isArray(mem.liq_pending) && mem.liq_pending.length === 3);

  settleReply.a1 = { ok: true, status: 'settled', payoutTxid: 'p1' }; // terminal → drop
  settleReply.b2 = { ok: false, status: 'awaiting-deposit', reason: 'unconfirmed' }; // keep
  // c3 falls through to the 'unknown swap' error → drop
  p = await L.resumePending();
  eq('resume posted settle for each', calls.settle.sort().join(','), 'a1,b2,c3');
  eq('settled + unknown dropped, confirming kept', p.map((e) => e.id).join(','), 'b2');

  settleReply.b2 = { ok: false, status: 'failed', reason: 'deposit refunded' }; // terminal
  p = await L.resumePending();
  eq('failed dropped on the next pass', p.length, 0);

  // takeFee is fire-and-forget and never throws, even with a broken fetch.
  L._fetch = async () => { throw new Error('offline'); };
  L.takeFee('SOL', 0.05, 150);
  L.takeFee('SOL', 0, 150); // no-op
  const q = await L.quote('USDC', 'BLOCK', 0.525, 1); // offline → local fallback
  ok('offline quote falls back to localQuote', q.ok === true && q.local === true);
  const sw = await L.startSwap({ from: 'USDC', to: 'BLOCK', amountIn: 1, coinUsd: 1, userAddress: 'x' });
  ok('offline startSwap fails soft', sw && sw.ok === false && /offline/.test(sw.error));
  const se = await L.settle('zz', 'tt');
  ok('offline settle fails soft', se && se.ok === false && /offline/.test(se.error));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
