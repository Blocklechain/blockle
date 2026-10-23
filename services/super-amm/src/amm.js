// super-amm/amm.js — the custodial, oracle-priced, SINGLE-SHARED-PRICE BLOCK AMM.
//
// Model B (chosen by the operator): there is ONE BLOCK price in USD. Every quote
// currency's deposit is converted to USD via an oracle, and BLOCK trades against a
// single virtual USD reserve on a constant-product curve. So a buy with SOL and a
// buy with ETH move the *same* global price.
//
//   state = {
//     rBlock : BigInt   // BLOCK reserve, base units (1e8/BLOCK)   — REAL, we hold it
//     rUsd   : BigInt   // virtual USD reserve, micro-USD (1e6/USD) — pricing curve
//     custody: { SYM: BigInt base-units }  // REAL per-currency balances we hold
//   }
//
// Pricing curve: constant product k = rBlock * rUsd. Price(USD/BLOCK) = rUsd/rBlock
// (unit-adjusted). Buying BLOCK adds USD to rUsd and removes BLOCK → price up;
// selling does the reverse → price down. The 0.5% fee stays in the pool (k grows).
//
// SOLVENCY — the key invariant for a custodial pool with a *virtual* USD seed:
// rUsd is NOT real money; the real backing per currency is `custody[SYM]`. A sell
// of BLOCK for SYM can therefore only pay out up to `custody[SYM]`. That is the
// operator's rule "it can only ever trade against pairs with liquidity": a pair is
// sellable only to the extent real liquidity in that currency has accumulated
// (from prior buys / operator seeding). Buys are always allowed (they ADD liquidity).
//
// Pure functions only — no I/O, no keys. BigInt throughout (no float money).

'use strict';

const BLOCK_DECIMALS = 8;
const USD_DECIMALS = 6;                 // micro-USD
const TEN = (n) => 10n ** BigInt(n);
const DEFAULT_FEE_BPS = 50n;            // 0.5% swap fee

// ---- helpers ---------------------------------------------------------------

// USD (micro) value of `amountBase` of an asset, given oracle price in micro-USD
// per WHOLE unit and the asset's decimals.
function toUsd(amountBase, priceMicroUsd, decimals) {
  return (BigInt(amountBase) * BigInt(priceMicroUsd)) / TEN(decimals);
}
// Inverse: asset base units worth `usdMicro`, same oracle + decimals.
function fromUsd(usdMicro, priceMicroUsd, decimals) {
  if (BigInt(priceMicroUsd) <= 0n) throw new Error('oracle price must be > 0');
  return (BigInt(usdMicro) * TEN(decimals)) / BigInt(priceMicroUsd);
}

// Price in micro-USD per WHOLE BLOCK.
function priceMicroUsd(state) {
  if (state.rBlock <= 0n) return 0n;
  return (state.rUsd * TEN(BLOCK_DECIMALS)) / state.rBlock;
}
function priceUsd(state) { return Number(priceMicroUsd(state)) / 1e6; }

function assetMeta(cfg, sym) {
  const m = cfg.assets && cfg.assets[sym];
  if (!m) throw new Error('unsupported asset: ' + sym);
  return m;
}
function oraclePrice(oracle, sym) {
  const p = oracle && oracle[sym];
  if (p == null) throw new Error('no oracle price for ' + sym);
  return BigInt(p);
}

// ---- seed ------------------------------------------------------------------

// Seed the pool: `blockWhole` BLOCK at `priceUsdPerBlock` (a number, e.g. 0.10).
function seed(blockWhole, priceUsdPerBlock) {
  const rBlock = BigInt(blockWhole) * TEN(BLOCK_DECIMALS);
  // rUsd (micro) = blockWhole * price * 1e6
  const rUsd = BigInt(Math.round(Number(blockWhole) * priceUsdPerBlock * 1e6));
  if (rBlock <= 0n || rUsd <= 0n) throw new Error('seed must be positive');
  return { rBlock, rUsd, custody: {} };
}

// ---- quotes (pure; return what WOULD happen, no mutation) ------------------

// BUY BLOCK by paying `amountBase` of `sym`. Always allowed (adds liquidity).
function quoteBuy(state, sym, amountBase, cfg, oracle) {
  amountBase = BigInt(amountBase);
  if (amountBase <= 0n) throw new Error('amount must be > 0');
  const { decimals } = assetMeta(cfg, sym);
  const feeBps = BigInt(cfg.feeBps ?? DEFAULT_FEE_BPS);
  const usdIn = toUsd(amountBase, oraclePrice(oracle, sym), decimals);
  if (usdIn <= 0n) throw new Error('amount too small (0 USD)');
  const feeUsd = (usdIn * feeBps) / 10000n;
  const usdInEff = usdIn - feeUsd;
  const k = state.rBlock * state.rUsd;
  const newRUsdCurve = state.rUsd + usdInEff;
  const newRBlock = k / newRUsdCurve;
  const blockOut = state.rBlock - newRBlock;
  if (blockOut <= 0n) throw new Error('amount too small for any BLOCK out');
  const after = {
    rBlock: newRBlock,
    rUsd: state.rUsd + usdIn,                 // full fee retained in pool
    custody: { ...state.custody, [sym]: (state.custody[sym] || 0n) + amountBase },
  };
  return { side: 'buy', sym, amountInBase: amountBase, usdIn, feeUsd, blockOut,
           priceBeforeMicroUsd: priceMicroUsd(state), priceAfterMicroUsd: priceMicroUsd(after), after };
}

// SELL `blockBase` BLOCK for `sym`. Capped by real custody liquidity in `sym`.
function quoteSell(state, sym, blockBase, cfg, oracle) {
  blockBase = BigInt(blockBase);
  if (blockBase <= 0n) throw new Error('amount must be > 0');
  const { decimals } = assetMeta(cfg, sym);
  const feeBps = BigInt(cfg.feeBps ?? DEFAULT_FEE_BPS);
  const k = state.rBlock * state.rUsd;
  const newRBlock = state.rBlock + blockBase;
  const newRUsdCurve = k / newRBlock;
  const usdOut = state.rUsd - newRUsdCurve;
  if (usdOut <= 0n) throw new Error('amount too small for any payout');
  const feeUsd = (usdOut * feeBps) / 10000n;
  const usdOutEff = usdOut - feeUsd;
  const assetOut = fromUsd(usdOutEff, oraclePrice(oracle, sym), decimals);
  const have = state.custody[sym] || 0n;
  const liquidity = assetOut <= have;
  const after = {
    rBlock: newRBlock,
    rUsd: state.rUsd - usdOutEff,              // fee retained in pool
    custody: { ...state.custody, [sym]: have - assetOut },
  };
  return { side: 'sell', sym, blockInBase: blockBase, usdOut, feeUsd, assetOut,
           liquidity, availableBase: have,
           priceBeforeMicroUsd: priceMicroUsd(state), priceAfterMicroUsd: priceMicroUsd(after), after };
}

// Max BLOCK that can be sold for `sym` right now given its custody liquidity
// (binary search on the curve — used to tell the user the sellable ceiling).
function maxSellableBlock(state, sym, cfg, oracle) {
  const have = state.custody[sym] || 0n;
  if (have <= 0n) return 0n;
  let lo = 0n, hi = state.rBlock; // can't remove more than the whole reserve
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    let q; try { q = quoteSell(state, sym, mid, cfg, oracle); } catch { hi = mid - 1n; continue; }
    if (q.assetOut <= have) lo = mid; else hi = mid - 1n;
  }
  return lo;
}

// ---- apply (validate + return the new state; throws on bad trade) ----------

function applyBuy(state, sym, amountBase, cfg, oracle) {
  return quoteBuy(state, sym, amountBase, cfg, oracle).after;
}
function applySell(state, sym, blockBase, cfg, oracle) {
  const q = quoteSell(state, sym, blockBase, cfg, oracle);
  if (!q.liquidity) {
    const err = new Error('insufficient ' + sym + ' pair liquidity');
    err.code = 'NO_LIQUIDITY'; err.availableBase = q.availableBase; err.wantedBase = q.assetOut;
    throw err;
  }
  return q.after;
}

module.exports = {
  BLOCK_DECIMALS, USD_DECIMALS, DEFAULT_FEE_BPS,
  seed, priceMicroUsd, priceUsd, toUsd, fromUsd,
  quoteBuy, quoteSell, maxSellableBlock, applyBuy, applySell,
};
