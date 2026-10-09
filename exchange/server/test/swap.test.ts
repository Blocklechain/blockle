// Atomic-swap state machine: proposed -> makerLocked -> takerLocked ->
// makerWithdrew -> claimed, plus the timelock refund path. The relay only
// coordinates; the preimage it releases must hash to the published hashlock.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { SwapEngine } from "../src/swaps";

function engine() {
  const cfg = loadConfig({ dbPath: ":memory:" });
  const db = openDb(cfg.dbPath);
  return new SwapEngine(db);
}

const MAKER = "block1maker";
const TAKER = "block1taker";

function newSwap(e: SwapEngine, ttlSec?: number) {
  return e.create({
    market: "BLOCK/USDC",
    maker: MAKER,
    taker: TAKER,
    makerOrder: "ordM",
    takerOrder: "ordT",
    makerLeg: { chain: "block", amount: "100000000", recipient: TAKER },
    takerLeg: { chain: "base", asset: "0xusdc", amount: "1000000", recipient: MAKER },
    feeBps: 10,
    ttlSec,
  });
}

test("happy path drives proposed -> claimed", () => {
  const e = engine();
  const swap = newSwap(e);
  assert.equal(swap.state, "proposed");

  // maker polls -> instructed to lock on its chain with the hashlock
  let step = e.step(swap.swapId, MAKER, "poll");
  assert.equal(step.action, "lock");
  assert.equal(step.chain, "block");
  assert.equal(step.payload!.hashlock, swap.hashlock);

  // taker polling now -> wait
  assert.equal(e.step(swap.swapId, TAKER, "poll").action, "wait");

  // maker reports its lock
  step = e.step(swap.swapId, MAKER, "locked", { lockRef: "mlock1" });
  assert.equal(e.get(swap.swapId)!.state, "makerLocked");

  // taker locks
  step = e.step(swap.swapId, TAKER, "poll");
  assert.equal(step.action, "lock");
  assert.equal(step.chain, "base");
  assert.equal(step.payload!.hashlock, swap.hashlock);
  e.step(swap.swapId, TAKER, "locked", { lockRef: "tlock1" });
  assert.equal(e.get(swap.swapId)!.state, "takerLocked");

  // maker withdraws taker's leg using the preimage the relay releases
  step = e.step(swap.swapId, MAKER, "poll");
  assert.equal(step.action, "withdraw");
  assert.equal(step.chain, "base");
  assert.equal(step.payload!.lockRef, "tlock1");
  const preimage = step.payload!.preimage as string;
  const h = crypto.createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  assert.equal(h, swap.hashlock, "released preimage must hash to the published hashlock");

  e.step(swap.swapId, MAKER, "withdrawn", { txid: "wtx1" });
  assert.equal(e.get(swap.swapId)!.state, "makerWithdrew");

  // taker withdraws maker's leg with the now-revealed preimage
  step = e.step(swap.swapId, TAKER, "poll");
  assert.equal(step.action, "withdraw");
  assert.equal(step.chain, "block");
  assert.equal(step.payload!.preimage, preimage);
  e.step(swap.swapId, TAKER, "withdrawn", { txid: "wtx2" });

  const done = e.get(swap.swapId)!;
  assert.equal(done.state, "claimed");
  assert.equal(done.legs.find((l) => l.role === "maker")!.status, "withdrawn");
  assert.equal(done.legs.find((l) => l.role === "taker")!.status, "withdrawn");

  // both parties now see "done"
  assert.equal(e.step(swap.swapId, MAKER, "poll").action, "done");
  assert.equal(e.step(swap.swapId, TAKER, "poll").action, "done");
});

test("timelock expiry drives a locked leg to refund -> refunded", () => {
  const e = engine();
  const swap = newSwap(e, -10); // already-expired timelocks
  // maker is still told to lock first (proposed has no live lock yet)
  assert.equal(e.step(swap.swapId, MAKER, "poll").action, "lock");
  e.step(swap.swapId, MAKER, "locked", { lockRef: "mlock1" });
  // now maker's own lock is past its timelock -> refund instruction
  const step = e.step(swap.swapId, MAKER, "poll");
  assert.equal(step.action, "refund");
  assert.equal(step.payload!.lockRef, "mlock1");
  e.step(swap.swapId, MAKER, "refunded", {});
  assert.equal(e.get(swap.swapId)!.state, "refunded");
});

test("a non-party cannot step the swap", () => {
  const e = engine();
  const swap = newSwap(e);
  assert.throws(() => e.step(swap.swapId, "block1intruder", "poll"), /not a party/i);
});

test("mine() returns swaps for either party", () => {
  const e = engine();
  const swap = newSwap(e);
  assert.equal(e.mine(MAKER).length, 1);
  assert.equal(e.mine(TAKER).length, 1);
  assert.equal(e.mine("block1stranger").length, 0);
  assert.equal(e.mine(MAKER)[0].swapId, swap.swapId);
});
