// Constant-product AMM quote math — a byte-exact bigint mirror of consensus
// (chain/crates/chain/src/pools.rs `amount_out`) and the public web/dex.js
// swap preview. Agents use this to set `minOut` from a slippage tolerance
// BEFORE signing a swap, so the on-chain min-out guard matches what they saw.
//
//   ain = amount_in * (10000 - SWAP_FEE_BPS)
//   out = (ain * out_reserve) / (in_reserve * 10000 + ain)      (integer div)
//
// All amounts base units (bigint).

import type { QuoteResult } from "./types";

/** 0.30% pool fee, in basis points — matches SWAP_FEE_BPS in consensus. */
export const SWAP_FEE_BPS = 30n;
const BPS_DENOM = 10_000n;

/** Exact consensus output for `amountIn` of the input side. Returns 0 on empty
 *  reserves or zero input, exactly like the chain. */
export function amountOut(amountIn: bigint, inReserve: bigint, outReserve: bigint): bigint {
  if (amountIn <= 0n || inReserve <= 0n || outReserve <= 0n) return 0n;
  const ain = amountIn * (BPS_DENOM - SWAP_FEE_BPS);
  const num = ain * outReserve;
  const den = inReserve * BPS_DENOM + ain;
  return num / den;
}

/** Apply a slippage tolerance (percent, e.g. 1 for 1%) to an expected output,
 *  flooring to an integer base-unit minimum-out. slippage 0 => minOut == out. */
export function applySlippage(out: bigint, slippagePct: number): bigint {
  if (!(slippagePct > 0)) return out;
  // scale by (1 - slip) using basis points to stay in integer math
  const keepBps = BigInt(Math.max(0, Math.round((100 - slippagePct) * 100))); // e.g. 1% -> 9900
  return (out * keepBps) / 10_000n;
}

/**
 * Quote a swap: expected `amountOut`, the slippage-adjusted `minOut` an agent
 * should pass to the on-chain swap, and an 1e18-scaled effective price
 * (amountIn per amountOut) for display/comparison.
 */
export function quote(
  amountIn: bigint,
  inReserve: bigint,
  outReserve: bigint,
  slippagePct = 1,
): QuoteResult {
  const out = amountOut(amountIn, inReserve, outReserve);
  const minOut = applySlippage(out, slippagePct);
  const priceX18 = out > 0n ? (amountIn * 1_000_000_000_000_000_000n) / out : 0n;
  return { amountOut: out, minOut, priceX18 };
}
