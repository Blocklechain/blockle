// Tests for the live trade lifecycle + solvency breaker. Run: node test/intents.test.js
'use strict';
const A = require('../src/amm.js');
const I = require('../src/intents.js');
const S = require('../src/solvency.js');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL:', n); } };

const cfg = { feeBps: 50n, assets: { BLOCK: { decimals: 8 }, SOL: { decimals: 9 }, USDC: { decimals: 6 } } };
const oracle = { SOL: 180_000_000n, USDC: 1_000_000n };
const NOW = 1_700_000_000_000;

// ---- happy buy: create -> fund -> execute -> pay -> settle ----
let pool = A.seed(100000, 0.10);
let it = I.create({ id: I.newId('aaa1'), side: 'buy', sym: 'USDC', amountInBase: 1000_000_000n,
  poolState: pool, cfg, oracle, depositAddress: 'POOL_USDC', payoutAddress: 'block1user', nowMs: NOW });
ok('buy: awaiting_deposit', it.status === 'awaiting_deposit');
ok('buy: deposit asset USDC, payout BLOCK', it.depositAsset === 'USDC' && it.payoutAsset === 'BLOCK');
ok('buy: minOut < quoted out (slippage room)', BigInt(it.quote.minOutBase) < BigInt(it.quote.outBase));

it = I.markFunded(it, 1000_000_000n, 'usdc_tx_1');     // exact funding
ok('buy: funded', it.status === 'funded' && it.fundedTxid === 'usdc_tx_1');
let r = I.execute(it, pool, cfg, oracle);
ok('buy: executed', r.intent.status === 'executed' && BigInt(r.payoutBase) > 0n);
ok('buy: payout is BLOCK', r.payoutAsset === 'BLOCK');
pool = r.poolState;                                     // pool advanced
ok('buy: price rose after execute', A.priceUsd(pool) > 0.10);
let settled = I.markSettled(I.markPaid(r.intent, 'block_payout_1'));
ok('buy: settled', settled.status === 'settled');

// ---- slippage refund: fund far less than quoted -> price gives < minOut? ----
// Create a big-quote intent, then the pool moves against the user before execute.
let pool2 = A.seed(100000, 0.10);
let big = I.create({ id: I.newId('bbb2'), side: 'buy', sym: 'USDC', amountInBase: 5000_000_000n,
  poolState: pool2, cfg, oracle, depositAddress: 'POOL_USDC', payoutAddress: 'block1user', nowMs: NOW, slippageBps: 100n });
// someone else buys a lot first, pushing price up so our fixed minOut can't be met
let moved = A.applyBuy(pool2, 'USDC', 40000_000_000n, cfg, oracle); // $40k buy moves price hard
big = I.markFunded(big, 5000_000_000n, 'usdc_tx_2');
let threwRefund = false;
try { I.execute(big, moved, cfg, oracle); } catch (e) { threwRefund = (e.code === 'REFUND' && e.reason === 'SLIPPAGE'); }
ok('slippage: execute refunds when price moved past guard', threwRefund);

// ---- sell with no liquidity: create must throw NO_LIQUIDITY ----
let threwNoLiq = false;
try {
  I.create({ id: I.newId('ccc3'), side: 'sell', sym: 'SOL', amountInBase: 1000n * 10n ** 8n,
    poolState: A.seed(100000, 0.10), cfg, oracle, depositAddress: 'POOL_BLOCK', payoutAddress: 'solUser', nowMs: NOW });
} catch (e) { threwNoLiq = (e.code === 'NO_LIQUIDITY'); }
ok('sell: create blocked when payout currency has no liquidity', threwNoLiq);

// ---- expiry ----
let exp = I.create({ id: I.newId('ddd4'), side: 'buy', sym: 'USDC', amountInBase: 100_000_000n,
  poolState: A.seed(100000, 0.10), cfg, oracle, depositAddress: 'P', payoutAddress: 'u', nowMs: NOW, ttlMs: 1000 });
ok('expiry: not expired before ttl', !I.isExpired(exp, NOW + 500));
ok('expiry: expired after ttl', I.isExpired(exp, NOW + 2000));

// ---- paused: execute refuses ----
let p3 = I.markFunded(I.create({ id: I.newId('eee5'), side: 'buy', sym: 'USDC', amountInBase: 100_000_000n,
  poolState: A.seed(100000, 0.10), cfg, oracle, depositAddress: 'P', payoutAddress: 'u', nowMs: NOW }), 100_000_000n, 'tx');
let threwPaused = false;
try { I.execute(p3, A.seed(100000, 0.10), cfg, oracle, { paused: true }); } catch (e) { threwPaused = e.code === 'PAUSED'; }
ok('paused: execute refuses when paused', threwPaused);

// ---- solvency breaker ----
let ps = A.applyBuy(A.seed(100000, 0.10), 'USDC', 1000_000_000n, cfg, oracle); // we now owe 1000 USDC + ~90951 BLOCK
const exp6 = S.expected(ps);
ok('solvency: expects BLOCK + USDC', exp6.BLOCK > 0n && exp6.USDC === 1000_000_000n);
// healthy: hold exactly what we owe
let rep = S.reconcile(exp6, { BLOCK: exp6.BLOCK, USDC: exp6.USDC });
ok('solvency: healthy when holdings match', rep.healthy && !rep.shouldPause);
// surplus is fine
rep = S.reconcile(exp6, { BLOCK: exp6.BLOCK + 1n, USDC: exp6.USDC + 5n });
ok('solvency: surplus is fine', rep.healthy);
// deficit -> pause
rep = S.reconcile(exp6, { BLOCK: exp6.BLOCK, USDC: exp6.USDC - 1n });
ok('solvency: deficit triggers pause', rep.shouldPause && !rep.healthy);

console.log(`\nsuper-amm live lifecycle: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
