// gating.test.ts — mainnet is disabled by default; testnet always works;
// confirmations, reserve-output, and compliance guards all refuse rather than
// pay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngine, inboundTx } from "./helpers";
import { ComplianceScreener, ScreenContext, ScreenResult } from "../src/compliance";

const TXID = "c".repeat(64);

test("Base mainnet payouts are refused until the legal-review gate is set", async () => {
  const { engine } = buildEngine({
    network: "base",
    mainnetEnabled: false,
    reserveUsdc: 100_000,
    inbound: inboundTx(TXID, 10),
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok("error" in r);
  assert.equal((r as any).code, "MAINNET_DISABLED");
});

test("mainnetEnabled WITHOUT a completed legal review is still refused", async () => {
  const { engine } = buildEngine({
    network: "base",
    mainnetEnabled: true,
    legalReviewCompleted: false,
    reserveUsdc: 100_000,
    inbound: inboundTx(TXID, 10),
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok("error" in r);
  assert.equal((r as any).code, "MAINNET_DISABLED");
});

test("mainnet pays once enabled AND legal review recorded", async () => {
  const { engine } = buildEngine({
    network: "base",
    mainnetEnabled: true,
    legalReviewCompleted: true,
    reserveUsdc: 100_000,
    inbound: inboundTx(TXID, 10),
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok(!("error" in r), "fully gated mainnet should pay");
});

test("testnet (base-sepolia) pays without the mainnet gate", async () => {
  const { engine } = buildEngine({ network: "base-sepolia", reserveUsdc: 100_000, inbound: inboundTx(TXID, 10) });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok(!("error" in r));
});

test("insufficient confirmations is refused with depth detail", async () => {
  const { engine } = buildEngine({
    confirmationDepth: 100,
    reserveUsdc: 100_000,
    inbound: inboundTx(TXID, 10, 7), // only 7 confs
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok("error" in r);
  assert.equal((r as any).code, "INSUFFICIENT_CONFIRMATIONS");
  assert.equal((r as any).confirmations, 7);
  assert.equal((r as any).needConfirmations, 100);
});

test("a tx that does not pay the reserve is refused", async () => {
  const { engine } = buildEngine({
    reserveUsdc: 100_000,
    inbound: { [TXID]: { amountBase: 0n, confirmations: 100, displayTxid: TXID } },
  });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok("error" in r);
  assert.equal((r as any).code, "NO_RESERVE_OUTPUT");
});

test("a bad Base payout address is rejected", async () => {
  const { engine } = buildEngine({ reserveUsdc: 100_000, inbound: inboundTx(TXID, 10) });
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "not-an-address" });
  assert.ok("error" in r);
  assert.equal((r as any).code, "BAD_ADDR");
});

test("compliance deny blocks the payout and moves no funds", async () => {
  class Deny implements ComplianceScreener {
    async screen(_ctx: ScreenContext): Promise<ScreenResult> {
      return { allowed: false, reason: "geo-blocked in test" };
    }
  }
  const { engine, reserve } = buildEngine({
    reserveUsdc: 100_000,
    inbound: inboundTx(TXID, 10),
    compliance: new Deny(),
  });
  const before = await reserve.balanceOfBase();
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok("error" in r);
  assert.equal((r as any).code, "COMPLIANCE_BLOCK");
  assert.equal(await reserve.balanceOfBase(), before, "no funds moved on a compliance block");
});
