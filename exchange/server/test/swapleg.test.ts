// BTC + Sui legs wired into the swap state machine. The engine stays generic
// (chain is a string), but the lock instruction must carry the per-chain HTLC
// semantics each leg needs: Bitcoin locks against hash160(preimage) with a
// unix-time CLTV refund; Sui locks against the canonical sha256 hashlock.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { SwapEngine, legHints } from "../src/swaps";

function engine() {
  const cfg = loadConfig({ dbPath: ":memory:" });
  return new SwapEngine(openDb(cfg.dbPath));
}

test("legHints: BTC uses OP_HASH160 over the preimage + unix CLTV", () => {
  const preimage = crypto.randomBytes(32).toString("hex");
  const sha = crypto.createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const h = legHints("bitcoin", sha, preimage);
  assert.equal(h.hashAlgo, "hash160");
  assert.equal(h.timelockKind, "unixTime");
  const expect = Buffer.from(ripemd160(sha256(Buffer.from(preimage, "hex")))).toString("hex");
  assert.equal(h.hashlock, expect, "hash160(preimage) == ripemd160(sha256(preimage))");
});

test("legHints: Sui uses the canonical sha256 hashlock", () => {
  const sha = "a".repeat(64);
  const h = legHints("sui", sha);
  assert.equal(h.hashAlgo, "sha256");
  assert.equal(h.hashlock, sha);
  assert.equal(h.timelockKind, "unixTime");
});

test("BTC->SUI swap: lock steps carry the right hash algo per leg", () => {
  const e = engine();
  const MAKER = "bc1qmaker";
  const TAKER = "0xsuitaker";
  const swap = e.create({
    market: "BTC/SUI",
    maker: MAKER,
    taker: TAKER,
    makerLeg: { chain: "bitcoin", amount: "100000", recipient: TAKER },
    takerLeg: { chain: "sui", amount: "1000000000", recipient: MAKER },
    feeBps: 10,
  });

  // maker (BTC) lock instruction: hash160 algo, hashlock != canonical sha256
  const mStep = e.step(swap.swapId, MAKER, "poll");
  assert.equal(mStep.action, "lock");
  assert.equal(mStep.chain, "bitcoin");
  assert.equal(mStep.payload!.hashAlgo, "hash160");
  assert.notEqual(mStep.payload!.hashlock, swap.hashlock, "BTC leg hashlock is hash160, not sha256");
  assert.equal(mStep.payload!.timelockKind, "unixTime");

  e.step(swap.swapId, MAKER, "locked", { lockRef: "btctx" });

  // taker (Sui) lock instruction: sha256 algo, canonical hashlock
  const tStep = e.step(swap.swapId, TAKER, "poll");
  assert.equal(tStep.action, "lock");
  assert.equal(tStep.chain, "sui");
  assert.equal(tStep.payload!.hashAlgo, "sha256");
  assert.equal(tStep.payload!.hashlock, swap.hashlock);

  // the single preimage, revealed on withdraw, satisfies BOTH legs' hashes
  e.step(swap.swapId, TAKER, "locked", { lockRef: "suiobj" });
  const w = e.step(swap.swapId, MAKER, "poll");
  assert.equal(w.action, "withdraw");
  const preimage = w.payload!.preimage as string;
  const sha = crypto.createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  assert.equal(sha, swap.hashlock, "preimage hashes (sha256) to the Sui leg hashlock");
  const h160 = Buffer.from(ripemd160(sha256(Buffer.from(preimage, "hex")))).toString("hex");
  assert.equal(h160, mStep.payload!.hashlock, "same preimage hash160s to the BTC leg hashlock");
});
