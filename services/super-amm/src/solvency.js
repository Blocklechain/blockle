// solvency.js — the circuit breaker. The engine's pool state says what we SHOULD
// hold (rBlock BLOCK to honour buys, custody[SYM] of each quote currency to honour
// sells). This reconciles that against OBSERVED on-chain balances in the pool's hot
// wallets and decides whether to keep trading or auto-PAUSE.
//
// Rule: if we observe LESS of any asset than we owe (beyond a small dust tolerance),
// the pool is undercollateralised → PAUSE immediately. Holding more than we owe
// (surplus, e.g. accrued fees) is fine. This is what stops a bug or a drain from
// silently letting trades continue against reserves that aren't there.
'use strict';

// expected(poolState) -> { SYM: BigInt } : what the hot wallets must contain.
function expected(poolState) {
  const out = { BLOCK: BigInt(poolState.rBlock) };
  for (const [sym, v] of Object.entries(poolState.custody || {})) {
    const b = BigInt(v);
    if (b > 0n) out[sym] = b;
  }
  return out;
}

// reconcile(expected, observed, tolerance) -> report.
// `observed` : { SYM: BigInt base-units actually in the hot wallets }
// `toleranceBase` : per-asset dust allowance (default 0).
function reconcile(exp, observed, toleranceBase = {}) {
  const rows = [];
  let healthy = true;
  for (const [sym, need] of Object.entries(exp)) {
    const have = BigInt((observed && observed[sym]) || 0n);
    const tol = BigInt(toleranceBase[sym] || 0n);
    const deficit = need - have;               // >0 means we owe more than we hold
    const ok = deficit <= tol;
    if (!ok) healthy = false;
    rows.push({ sym, needBase: need.toString(), haveBase: have.toString(),
                deficitBase: deficit.toString(), ok });
  }
  return { healthy, shouldPause: !healthy, rows, at: null };
}

// Convenience: full check from a pool state + observed balances.
function check(poolState, observed, toleranceBase) {
  return reconcile(expected(poolState), observed, toleranceBase);
}

module.exports = { expected, reconcile, check };
