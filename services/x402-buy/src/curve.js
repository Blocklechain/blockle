// BLOCK primary-sale curve — a byte-faithful mirror of web/buy.js. The price
// is a pure function of the USDC actually raised into the reserve R:
//
//     price(R) = max(p0, sqrt(p0^2 + 2*k*R))         // p0 = $0.10 floor
//     sold(R)  = (price(R) - p0) / k
//     k        = 2*(targetUsdc - p0*allocation) / allocation^2
//
// A buy of `rawUsdc` dollars pays a 5% fee, then the net raises the reserve
// from R to R+net; BLOCK delivered = sold(R+net) - sold(R). This matches
// buy.js quote() exactly — do NOT invent numbers; curve params come from
// buy-config.json (cfg.curve) with the same defaults buy.js uses.

"use strict";

const COIN = 100_000_000n; // 1 BLOCK = 1e8 base units
const USDC_DECIMALS = 6;

function makeCurve(buyCfg) {
  const P0 = buyCfg.curve.startPrice;
  const TARGET = buyCfg.curve.targetUsdc;
  const ALLOC = buyCfg.curve.allocation;
  const FEE = (buyCfg.feeBps != null ? buyCfg.feeBps : 500) / 10000;
  const K = (2 * (TARGET - P0 * ALLOC)) / (ALLOC * ALLOC);

  const priceAt = (r) => Math.max(P0, Math.sqrt(P0 * P0 + 2 * K * r));
  const soldAt = (r) => (priceAt(r) - P0) / K;

  return { P0, TARGET, ALLOC, FEE, K, priceAt, soldAt };
}

/**
 * Quote a buy. `rawUsdc` is the gross USDC dollars the buyer pays; `reserveR`
 * is the current USDC raised into the reserve (read live from Base, same as
 * buy.js). Returns the BLOCK delivered and fee, mirroring buy.js.
 */
function quoteBuy(buyCfg, rawUsdc, reserveR) {
  const c = makeCurve(buyCfg);
  const R = Math.max(0, reserveR || 0);
  const raw = Number(rawUsdc);
  if (!(raw > 0)) {
    return { blockOut: 0, feeUsd: 0, avgPrice: c.priceAt(R), spotPrice: c.priceAt(R) };
  }
  const net = raw * (1 - c.FEE);
  const r2 = R + net;
  const blockOut = c.soldAt(r2) - c.soldAt(R);
  const feeUsd = raw * c.FEE;
  let avg = blockOut > 0 ? net / blockOut : c.priceAt(R);
  avg = Math.max(c.P0, avg);
  return { blockOut, feeUsd, avgPrice: avg, spotPrice: c.priceAt(R), reserveAfter: r2 };
}

/** BLOCK (float) → base units (bigint), floored. */
function blockToBaseUnits(block) {
  if (!(block > 0)) return 0n;
  // use string math to avoid float drift at 8dp
  const s = block.toFixed(8);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * COIN + BigInt((frac + "00000000").slice(0, 8));
}

/** base units (bigint) → BLOCK decimal string (8dp, trimmed) for the CLI. */
function baseUnitsToBlock(base) {
  const b = BigInt(base);
  const whole = b / COIN;
  const frac = (b % COIN).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** USDC dollars → micro-USDC (6dp) base-unit string for x402 maxAmountRequired. */
function usdToMicroUsdc(usd) {
  const n = Number(usd);
  if (!(n > 0)) throw new Error(`invalid USD amount: ${usd}`);
  // round to 6dp via string
  const micros = Math.round(n * 1e6);
  return String(micros);
}

/** micro-USDC string → dollars (number), for display/ledger. */
function microUsdcToUsd(micro) {
  return Number(BigInt(micro)) / 1e6;
}

module.exports = {
  COIN,
  USDC_DECIMALS,
  makeCurve,
  quoteBuy,
  blockToBaseUnits,
  baseUnitsToBlock,
  usdToMicroUsdc,
  microUsdcToUsd,
};
