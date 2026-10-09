// clamp.test.ts — availability pricing: a redemption can never drain the
// reserve. Payout is clamped to a fraction of the LIVE USDC balance and the
// rolling daily cap; low balance => partial fill / lower effective price.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngine, inboundTx } from "./helpers";
import { Curve } from "../src/curve";

const TXID = "b".repeat(64);

test("a big sell is clamped to maxReserveFractionPerRedemption of the live balance", async () => {
  // Reserve holds 1,000 USDC; a single redemption may take at most 10% = 100.
  const { engine } = buildEngine({
    reserveUsdc: 1_000,
    maxFraction: 0.1,
    inbound: inboundTx(TXID, 100_000), // absurdly large sell
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.partial, true, "a clamped payout is marked partial");
    assert.ok(r.usdcOut <= 100 + 1e-6, `payout ${r.usdcOut} must be <= 10% of 1000`);
    assert.ok(r.usdcOut >= 100 - 1e-6, "payout should hit the fraction cap exactly");
    assert.equal(r.quote.boundBy, "reserve-fraction");
  }
});

test("the clamp leaves the reserve strictly positive (never drained)", async () => {
  const { engine, reserve } = buildEngine({
    reserveUsdc: 500,
    maxFraction: 0.25,
    inbound: inboundTx(TXID, 100_000),
  });
  await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "9".repeat(40) });
  const bal = await reserve.balanceOfBase();
  assert.ok(bal > 0n, "reserve is never fully drained by one redemption");
});

test("a small sell within the cap pays the full curve quote (not partial)", async () => {
  const reserveUsdc = 500_000;
  const blockSold = 1; // tiny
  const { engine } = buildEngine({
    reserveUsdc,
    maxFraction: 0.5,
    inbound: inboundTx(TXID, blockSold),
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "2".repeat(40) });
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.partial, false, "a small sell is fully filled");
    const curve = new Curve();
    const expected = curve.sellQuote(blockSold, reserveUsdc).out;
    assert.ok(Math.abs(r.usdcOut - expected) < 0.01, `curve quote ${r.usdcOut} ~= ${expected}`);
  }
});

test("quote matches the sell side of web/buy.js", async () => {
  // Reproduce buy.js math directly and compare.
  const reserveUsdc = 250_000;
  const blockIn = 1000;
  const P0 = 0.1,
    TARGET = 2_000_000,
    ALLOC = 210_000,
    FEE = 0.05;
  const K = (2 * (TARGET - P0 * ALLOC)) / (ALLOC * ALLOC);
  const priceAt = (r: number) => Math.max(P0, Math.sqrt(P0 * P0 + 2 * K * r));
  const soldAt = (r: number) => (priceAt(r) - P0) / K;
  const reserveForN = (n: number) => P0 * Math.max(0, n) + (K * Math.max(0, n) * Math.max(0, n)) / 2;
  const n = soldAt(reserveUsdc);
  const n2 = Math.max(0, n - blockIn);
  const gross = reserveUsdc - reserveForN(n2);
  const expectedOut = gross * (1 - FEE);

  const { engine } = buildEngine({
    reserveUsdc,
    maxFraction: 1, // no clamp
    dailyCapUsdc: 10_000_000,
    inbound: inboundTx(TXID, blockIn),
  });
  const q = await engine.quote(BigInt(Math.round(blockIn * 1e8)));
  assert.ok(Math.abs(q.usdcOut - expectedOut) < 0.01, `engine ${q.usdcOut} ~= buy.js ${expectedOut}`);
});

test("the rolling daily cap clamps and reports boundBy=daily-cap", async () => {
  // Cap the day at 50 USDC; sell wants far more from a well-funded reserve.
  const { engine } = buildEngine({
    reserveUsdc: 1_000_000,
    maxFraction: 1,
    dailyCapUsdc: 50,
    inbound: inboundTx(TXID, 100_000),
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "7".repeat(40) });
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.partial, true);
    assert.ok(r.usdcOut <= 50 + 1e-6, "payout clamped to the daily cap");
    assert.equal(r.quote.boundBy, "daily-cap");
  }
});

test("an empty reserve yields NO_AVAILABILITY, not a payout", async () => {
  const { engine } = buildEngine({ reserveUsdc: 0, inbound: inboundTx(TXID, 10) });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "8".repeat(40) });
  assert.ok("error" in r);
  assert.equal((r as any).code, "NO_AVAILABILITY");
});
