// Sanity tests for the shared-price AMM core. Run: node test/amm.test.js
'use strict';
const A = require('../src/amm.js');
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name); } }
function approx(a, b, eps) { return Math.abs(a - b) <= eps; }

const cfg = {
  feeBps: 50n, // 0.5%
  assets: {
    BLOCK: { decimals: 8 }, SOL: { decimals: 9 }, USDC: { decimals: 6 },
    ETH: { decimals: 18 }, BTC: { decimals: 8 }, DOGE: { decimals: 8 },
  },
};
// oracle: micro-USD per whole unit
const oracle = { SOL: 180_000_000n, USDC: 1_000_000n, ETH: 3000_000_000n, BTC: 68000_000_000n, DOGE: 250_000n };

// --- seed: 100,000 BLOCK @ $0.10 ---
let s = A.seed(100000, 0.10);
ok('seed price == $0.10', approx(A.priceUsd(s), 0.10, 1e-9));
ok('seed rBlock == 100k*1e8', s.rBlock === 100000n * 10n ** 8n);

// --- buy BLOCK with 1000 USDC (=$1000) ---
const qb = A.quoteBuy(s, 'USDC', 1000_000_000n /*1000 USDC*/, cfg, oracle);
ok('buy: fee is 0.5% of $1000 = $5', qb.feeUsd === 5_000_000n);
ok('buy: price rises', qb.priceAfterMicroUsd > qb.priceBeforeMicroUsd);
ok('buy: got some BLOCK', qb.blockOut > 0n);
// $1000 is ~10% of the $10k USD side: USD +10%, BLOCK ~-9% => price up ~21% => ~$0.121
ok('buy: price after ~$0.121 (10% buy moves price ~21%)', A.priceUsd(qb.after) > 0.119 && A.priceUsd(qb.after) < 0.123);
s = qb.after;
ok('buy: USDC custody credited', s.custody.USDC === 1000_000_000n);

// --- constant product preserved-or-grown (fee grows k) ---
const kBefore = (100000n * 10n ** 8n) * A.seed(100000, 0.10).rUsd;
const kAfter = s.rBlock * s.rUsd;
ok('buy: k grew (fee retained)', kAfter >= kBefore);

// --- sell BLOCK back for USDC within liquidity ---
// sell a small amount of BLOCK; should pay out <= custody USDC
const qs = A.quoteSell(s, 'USDC', 1000n * 10n ** 8n /*1000 BLOCK*/, cfg, oracle);
ok('sell: price falls', qs.priceAfterMicroUsd < qs.priceBeforeMicroUsd);
ok('sell: fee is 0.5% of usdOut', qs.feeUsd === (qs.usdOut * 50n) / 10000n);
ok('sell: within USDC liquidity', qs.liquidity === true && qs.assetOut <= s.custody.USDC);

// --- liquidity cap: selling for SOL with ZERO sol custody must be blocked ---
let threw = false;
try { A.applySell(s, 'SOL', 1000n * 10n ** 8n, cfg, oracle); }
catch (e) { threw = (e.code === 'NO_LIQUIDITY'); }
ok('sell: blocked on empty SOL pair (no liquidity)', threw);

// --- buying with SOL adds SOL liquidity, then a bounded SOL sell works ---
let s2 = A.applyBuy(s, 'SOL', 10n * 10n ** 9n /*10 SOL = $1800*/, cfg, oracle);
ok('buy SOL: SOL custody credited', s2.custody.SOL === 10n * 10n ** 9n);
const maxSol = A.maxSellableBlock(s2, 'SOL', cfg, oracle);
ok('maxSellableBlock(SOL) > 0 after SOL liquidity exists', maxSol > 0n);
const qs2 = A.quoteSell(s2, 'SOL', maxSol, cfg, oracle);
ok('sell at max: still within SOL custody', qs2.assetOut <= s2.custody.SOL);

// --- shared price: a SOL buy and a USDC buy move the SAME price variable ---
const base = A.seed(100000, 0.10);
const viaSol  = A.applyBuy(base, 'SOL', 1n * 10n ** 9n /*$180*/, cfg, oracle);
const viaUsdc = A.applyBuy(base, 'USDC', 180_000_000n /*$180*/, cfg, oracle);
ok('shared price: equal USD buys via SOL vs USDC give equal price', A.priceMicroUsd(viaSol) === A.priceMicroUsd(viaUsdc));

console.log(`\nsuper-amm core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
