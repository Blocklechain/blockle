// intents.js — the LIVE trade lifecycle. Unlike paper mode (instant, synchronous),
// a real trade is async: the user can't atomically hand us SOL and receive BLOCK,
// so a trade is an INTENT that moves through states as money actually arrives and
// is paid out. This module is pure logic over a provided pool-state + oracle; the
// per-chain deposit watchers and payout signers (custody.js) drive it.
//
// Lifecycle:
//   awaiting_deposit  -> user must send `amountInBase` of depositAsset to depositAddress
//   funded            -> watcher saw a confirmed deposit (records the ACTUAL amount)
//   executed          -> AMM curve applied at the CURRENT price using the ACTUAL
//                        funded amount; aborts to `refund` if below minOut (slippage)
//   paid              -> payout tx broadcast to the user
//   settled           -> payout confirmed
//   expired           -> no deposit before expiry (nothing to refund)
//   refund            -> funded but execution failed (slippage/price move/paused) →
//                        the deposit must be returned; never silently kept
//   failed            -> unrecoverable; flagged for operator
//
// KEY SAFETY RULES:
//  * Execute uses the ACTUAL on-chain funded amount, never the quoted estimate.
//  * minOut (slippage guard) is fixed at intent creation; if the price moved against
//    the user past it, we REFUND rather than fill at a bad price.
//  * A sell is only accepted if the pool currently has liquidity in the payout
//    currency (same NO_LIQUIDITY rule as the engine), checked again at execute time.
'use strict';
const A = require('./amm.js');

const DEFAULT_SLIPPAGE_BPS = 100n;   // 1% max adverse move before refund
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min to fund an intent

function newId(seedHex) { return 'amm_' + seedHex; } // caller supplies a unique hex (no RNG here)

// Create an intent from a quote at the current pool price.
// side 'buy'  : user pays `sym`,   receives BLOCK → deposit=sym,   payout=BLOCK
// side 'sell' : user pays BLOCK,   receives `sym` → deposit=BLOCK, payout=sym
function create(opts) {
  const { id, side, sym, amountInBase, poolState, cfg, oracle,
          depositAddress, payoutAddress, nowMs, ttlMs = DEFAULT_TTL_MS,
          slippageBps = DEFAULT_SLIPPAGE_BPS } = opts;
  if (!['buy', 'sell'].includes(side)) throw new Error('side must be buy|sell');
  const amt = BigInt(amountInBase);
  if (amt <= 0n) throw new Error('amount must be > 0');

  const q = side === 'buy'
    ? A.quoteBuy(poolState, sym, amt, cfg, oracle)
    : A.quoteSell(poolState, sym, amt, cfg, oracle);
  const outBase = side === 'buy' ? q.blockOut : q.assetOut;
  if (side === 'sell' && !q.liquidity) {
    const e = new Error('insufficient ' + sym + ' pair liquidity'); e.code = 'NO_LIQUIDITY'; throw e;
  }
  const minOutBase = outBase - (outBase * slippageBps) / 10000n;

  return {
    id, createdAt: nowMs, expiresAt: nowMs + ttlMs, status: 'awaiting_deposit',
    side, sym,
    depositAsset: side === 'buy' ? sym : 'BLOCK',
    payoutAsset: side === 'buy' ? 'BLOCK' : sym,
    amountInBase: amt.toString(),
    depositAddress, payoutAddress,
    quote: {
      priceMicroUsd: A.priceMicroUsd(poolState).toString(),
      outBase: outBase.toString(), minOutBase: minOutBase.toString(),
      feeUsd: (side === 'buy' ? q.usdIn : q.usdOut).toString(),
      slippageBps: Number(slippageBps),
    },
    fundedAmountBase: null, fundedTxid: null,
    executedOutBase: null, executedPriceMicroUsd: null,
    payoutTxid: null, error: null,
  };
}

function isExpired(intent, nowMs) {
  return intent.status === 'awaiting_deposit' && nowMs > intent.expiresAt;
}

// Watcher calls this when a confirmed deposit lands. Records the ACTUAL amount.
function markFunded(intent, actualAmountBase, txid) {
  if (intent.status !== 'awaiting_deposit') throw new Error('not awaiting deposit: ' + intent.status);
  return { ...intent, status: 'funded', fundedAmountBase: BigInt(actualAmountBase).toString(), fundedTxid: txid };
}

// Execute against the live pool using the ACTUAL funded amount. Returns
// { intent, poolState } on success, or throws with code REFUND/NO_LIQUIDITY/PAUSED.
function execute(intent, poolState, cfg, oracle, { paused = false } = {}) {
  if (intent.status !== 'funded') throw new Error('not funded: ' + intent.status);
  if (paused) { const e = new Error('amm paused'); e.code = 'PAUSED'; throw e; }
  const funded = BigInt(intent.fundedAmountBase);
  const minOut = BigInt(intent.quote.minOutBase);

  const q = intent.side === 'buy'
    ? A.quoteBuy(poolState, intent.sym, funded, cfg, oracle)
    : A.quoteSell(poolState, intent.sym, funded, cfg, oracle);
  const outBase = intent.side === 'buy' ? q.blockOut : q.assetOut;

  if (intent.side === 'sell' && !q.liquidity) {
    const e = new Error('insufficient ' + intent.sym + ' liquidity at execute'); e.code = 'REFUND'; e.reason = 'NO_LIQUIDITY'; throw e;
  }
  if (outBase < minOut) {
    const e = new Error('price moved past slippage guard'); e.code = 'REFUND'; e.reason = 'SLIPPAGE';
    e.outBase = outBase.toString(); e.minOutBase = minOut.toString(); throw e;
  }
  const executed = {
    ...intent, status: 'executed',
    executedOutBase: outBase.toString(),
    executedPriceMicroUsd: A.priceMicroUsd(q.after).toString(),
  };
  return { intent: executed, poolState: q.after, payoutAsset: intent.payoutAsset, payoutBase: outBase };
}

function markPaid(intent, payoutTxid) {
  if (intent.status !== 'executed') throw new Error('not executed: ' + intent.status);
  return { ...intent, status: 'paid', payoutTxid };
}
function markSettled(intent) {
  if (intent.status !== 'paid') throw new Error('not paid: ' + intent.status);
  return { ...intent, status: 'settled' };
}
function markRefund(intent, reason) {
  return { ...intent, status: 'refund', error: reason || 'refund' };
}
function markExpired(intent) { return { ...intent, status: 'expired' }; }

module.exports = {
  DEFAULT_SLIPPAGE_BPS, DEFAULT_TTL_MS, newId,
  create, isExpired, markFunded, execute, markPaid, markSettled, markRefund, markExpired,
};
