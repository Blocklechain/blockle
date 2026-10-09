// idempotency.test.ts — one blockTxid -> at most one payout, across retries,
// concurrency, and a simulated crash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngine, inboundTx, FakeChain } from "./helpers";
import { Ledger } from "../src/ledger";
import { NoOpScreener } from "../src/compliance";
import { SettlementEngine } from "../src/settle";

const TXID = "a".repeat(64);

test("a repeated settle for the same txid pays exactly once", async () => {
  const { engine, reserve } = buildEngine({ reserveUsdc: 100_000, inbound: inboundTx(TXID, 10) });
  const startBal = await reserve.balanceOfBase();

  const first = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok(!("error" in first), "first settle should succeed");
  const afterFirst = await reserve.balanceOfBase();
  assert.ok(afterFirst < startBal, "reserve should have paid out once");

  // retry same txid — must be an idempotent replay, no second debit
  const second = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "1".repeat(40) });
  assert.ok(!("error" in second), "replay should return the prior receipt, not an error");
  if (!("error" in second) && !("error" in first)) {
    assert.equal(second.txHash, first.txHash, "replay returns the same tx hash");
    assert.equal(second.usdcOutBase, first.usdcOutBase);
  }
  const afterSecond = await reserve.balanceOfBase();
  assert.equal(afterSecond, afterFirst, "no second debit on replay");
});

test("concurrent settles for the same txid pay exactly once", async () => {
  const { engine, reserve } = buildEngine({ reserveUsdc: 100_000, inbound: inboundTx(TXID, 5) });
  const startBal = await reserve.balanceOfBase();

  const addr = "0x" + "2".repeat(40);
  const results = await Promise.all([
    engine.settle({ blockTxid: TXID, userUsdcAddr: addr }),
    engine.settle({ blockTxid: TXID, userUsdcAddr: addr }),
    engine.settle({ blockTxid: TXID, userUsdcAddr: addr }),
  ]);
  const paid = results.filter((r) => !("error" in r));
  const inProgress = results.filter((r) => "error" in r && (r as any).code === "IN_PROGRESS");
  assert.equal(paid.length, 1, "exactly one concurrent request pays out");
  assert.equal(inProgress.length, 2, "the other two are rejected as in-progress");

  const endBal = await reserve.balanceOfBase();
  const debit = startBal - endBal;
  assert.ok(debit > 0n, "one payout happened");
});

test("a crash between pay and settle never double-pays on restart", async () => {
  // Shared ledger file + reserve simulate persistence across a crash.
  const { cfg, ledger, reserve } = buildEngine({ reserveUsdc: 100_000, inbound: inboundTx(TXID, 10) });

  // Simulate: the first process wrote a pending row (begin) and broadcast the
  // USDC, then crashed BEFORE settle(). The ledger file now holds `pending`.
  ledger.begin(TXID, "0x" + "3".repeat(40), BigInt(10 * 1e8));
  await reserve.pay("0x" + "3".repeat(40), BigInt(900 * 1e6)); // the payout that "happened"

  // New process boots: fresh Ledger from the same file, same reserve.
  const ledger2 = new Ledger(cfg.ledgerPath);
  const engine2 = new SettlementEngine({
    config: cfg,
    chain: new FakeChain(inboundTx(TXID, 10)),
    reserve,
    ledger: ledger2,
    compliance: new NoOpScreener(),
  });

  const balBefore = await reserve.balanceOfBase();
  const retry = await engine2.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "3".repeat(40) });
  assert.ok("error" in retry, "a stuck-pending txid is not re-paid");
  assert.equal((retry as any).code, "IN_PROGRESS");
  const balAfter = await reserve.balanceOfBase();
  assert.equal(balAfter, balBefore, "no second payout after crash");
});

test("mock reserve payout math reduces the live balance by exactly usdcOut", async () => {
  const startUsdc = 100_000;
  const { engine, reserve } = buildEngine({ reserveUsdc: startUsdc, inbound: inboundTx(TXID, 1) });
  const before = await reserve.balanceOfBase();
  const r = await engine.settle({ blockTxid: TXID, userUsdcAddr: "0x" + "4".repeat(40) });
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    const after = await reserve.balanceOfBase();
    assert.equal(before - after, BigInt(r.usdcOutBase), "debit equals the reported payout");
  }
});
