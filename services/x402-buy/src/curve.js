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

// ---- named curves -----------------------------------------------------------
//
// The MAIN primary-sale curve lives in buy-config (cfg.curve): 210,000 BLOCK /
// $2,000,000 target. In ADDITION, the sell rail can select a dedicated curve by
// name. Each dedicated curve reuses the IDENTICAL sqrt math below — only the
// (allocation, targetUsdc, startPrice) triple differs.
//
// #36 — the $1-average curve: allocation=20,000, targetUsdc=20,000 → because
// the reserve required to sell the entire allocation equals targetUsdc, the
// average price over the full allocation is EXACTLY target/allocation =
// $20,000 / 20,000 = $1.00 / BLOCK. floor stays at the $0.10 treasury floor.
// It is a SEPARATE pool from the 210k curve and is dispensed from the premine
// (gated — no real dispense until mainnet_enabled; see release.js / config.js).
const AVG1_20K_ID = "avg1-20k";

const BUILTIN_CURVES = {
  [AVG1_20K_ID]: {
    id: AVG1_20K_ID,
    startPrice: 0.1,
    targetUsdc: 20_000,
    allocation: 20_000,
  },
};

/**
 * Resolve the (startPrice, targetUsdc, allocation) params for a curve name.
 * `undefined`/empty → the MAIN 210k/$2M curve from buy-config. A name resolves
 * against operator-defined curves (buyCfg.curves) first, then the built-ins, so
 * an operator can override a built-in curve's reserve/params in config.
 */
function curveParamsFor(buyCfg, name) {
  if (!name) return Object.assign({ id: "main" }, buyCfg.curve);
  const operator = buyCfg && buyCfg.curves && buyCfg.curves[name];
  if (operator) return Object.assign({ id: name }, operator);
  if (BUILTIN_CURVES[name]) return BUILTIN_CURVES[name];
  throw new Error(`unknown curve: ${name}`);
}

/** Is `name` a selectable curve? (empty/undefined == the main curve == true.) */
function isKnownCurve(buyCfg, name) {
  if (!name) return true;
  if (buyCfg && buyCfg.curves && buyCfg.curves[name]) return true;
  return Boolean(BUILTIN_CURVES[name]);
}

/**
 * The reserve-source descriptor to price a curve against. The main curve prices
 * against the live Base USDC reserve (buyCfg.usdc). A dedicated curve is its own
 * pool: it prices against its own configured reserve if the operator set one,
 * otherwise R=0 (so pricing starts at the floor and climbs) — fail-safe.
 */
function reserveSourceFor(buyCfg, name) {
  const cp = curveParamsFor(buyCfg, name);
  if (!name || cp.id === "main") return buyCfg;
  return { usdc: cp.usdc || null };
}

function makeCurve(buyCfg, curveName) {
  const cp = curveParamsFor(buyCfg, curveName);
  const P0 = cp.startPrice;
  const TARGET = cp.targetUsdc;
  const ALLOC = cp.allocation;
  const FEE = (buyCfg.feeBps != null ? buyCfg.feeBps : 500) / 10000;
  const K = (2 * (TARGET - P0 * ALLOC)) / (ALLOC * ALLOC);

  const priceAt = (r) => Math.max(P0, Math.sqrt(P0 * P0 + 2 * K * r));
  const soldAt = (r) => (priceAt(r) - P0) / K;
  // USDC the reserve must hold to have sold `n` BLOCK (inverse of soldAt).
  const reserveForN = (n) => {
    const nn = Math.max(0, n);
    return P0 * nn + (K * nn * nn) / 2;
  };

  return { id: cp.id || "main", P0, TARGET, ALLOC, FEE, K, priceAt, soldAt, reserveForN };
}

/**
 * The average price across the WHOLE allocation of a curve, = target/allocation
 * by construction (the reserve to sell the full allocation equals targetUsdc).
 * For the $1-average 20k curve this is exactly 1.00.
 */
function curveAveragePrice(buyCfg, curveName) {
  const c = makeCurve(buyCfg, curveName);
  return c.TARGET / c.ALLOC;
}

/**
 * Quote a buy. `rawUsdc` is the gross USDC dollars the buyer pays; `reserveR`
 * is the current USDC raised into the reserve (read live from Base, same as
 * buy.js). Returns the BLOCK delivered and fee, mirroring buy.js.
 */
function quoteBuy(buyCfg, rawUsdc, reserveR, curveName) {
  const c = makeCurve(buyCfg, curveName);
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
  return { blockOut, feeUsd, avgPrice: avg, spotPrice: c.priceAt(R), reserveAfter: r2, curve: c.id };
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
  AVG1_20K_ID,
  BUILTIN_CURVES,
  curveParamsFor,
  isKnownCurve,
  reserveSourceFor,
  curveAveragePrice,
  makeCurve,
  quoteBuy,
  blockToBaseUnits,
  baseUnitsToBlock,
  usdToMicroUsdc,
  microUsdcToUsd,
};
