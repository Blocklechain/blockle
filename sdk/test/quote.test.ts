// Unit test for the constant-product quote math. This is the one piece of
// consensus math the SDK reimplements (a bigint mirror of pools.rs /
// web/dex.js), so it is worth pinning. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { amountOut, applySlippage, quote, SWAP_FEE_BPS } from "../src/quote";

test("SWAP_FEE_BPS matches consensus (0.30%)", () => {
  assert.equal(SWAP_FEE_BPS, 30n);
});

test("amountOut matches the exact integer-division formula", () => {
  // ain = 1000 * (10000-30) = 9_970_000
  // num = 9_970_000 * 1_000_000 = 9_970_000_000_000
  // den = 1_000_000 * 10000 + 9_970_000 = 10_009_970_000
  // out = floor(9_970_000_000_000 / 10_009_970_000) = 996
  assert.equal(amountOut(1000n, 1_000_000n, 1_000_000n), 996n);
});

test("amountOut returns 0 on empty reserves or non-positive input", () => {
  assert.equal(amountOut(0n, 1000n, 1000n), 0n);
  assert.equal(amountOut(100n, 0n, 1000n), 0n);
  assert.equal(amountOut(100n, 1000n, 0n), 0n);
  assert.equal(amountOut(-5n, 1000n, 1000n), 0n);
});

test("amountOut never exceeds the output reserve and grows with input", () => {
  const small = amountOut(10n, 1_000_000n, 1_000_000n);
  const big = amountOut(10_000n, 1_000_000n, 1_000_000n);
  assert.ok(big > small);
  assert.ok(amountOut(10n ** 18n, 1_000_000n, 1_000_000n) < 1_000_000n);
});

test("applySlippage floors to integer base units", () => {
  assert.equal(applySlippage(1000n, 1), 990n); // 1% -> keep 99%
  assert.equal(applySlippage(1000n, 0), 1000n); // 0% -> unchanged
  assert.equal(applySlippage(1000n, 0.5), 995n); // 0.5%
  assert.equal(applySlippage(333n, 1), 329n); // floor(333*9900/10000)=329
});

test("quote bundles amountOut + minOut + a non-zero price", () => {
  const q = quote(1000n, 1_000_000n, 1_000_000n, 1);
  assert.equal(q.amountOut, 996n);
  assert.equal(q.minOut, applySlippage(996n, 1));
  assert.ok(q.priceX18 > 0n);
});

test("quote on a dead pool is all zeros", () => {
  const q = quote(1000n, 0n, 0n, 1);
  assert.equal(q.amountOut, 0n);
  assert.equal(q.minOut, 0n);
  assert.equal(q.priceX18, 0n);
});
