// Self-serve listing: the live quote ($5 + $1/extra pair), the MANDATORY
// BLOCK pair, fee verification before activation, and idempotent fee reuse.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Registry } from "../src/registry";
import { Listings } from "../src/listings";
import { makeFeeVerifier } from "../src/feeverify";
import { NoopCompliance } from "../src/compliance";

function setup() {
  const cfg = loadConfig({ dbPath: ":memory:" });
  const db = openDb(cfg.dbPath);
  const registry = new Registry(db, cfg);
  const listings = new Listings(db, cfg, registry, makeFeeVerifier(cfg), new NoopCompliance());
  return { cfg, db, registry, listings };
}

const ASSET = { symbol: "MYT", chain: "block", kind: "block20", addr: "block1tokenxyz", decimals: 8 };

test("quote is $5 base + $1 per extra pair and always includes the BLOCK pair", () => {
  const { listings } = setup();
  const q = listings.quote(ASSET, ["USDC", "ETH"]);
  assert.equal(q.totalUsd, 7); // 5 + 1 + 1
  assert.ok(q.markets.includes("BLOCK/MYT"));
  assert.ok(q.markets.includes("MYT/USDC"));
  assert.ok(q.markets.includes("MYT/ETH"));
  assert.equal(q.breakdown.length, 3);
  // BLOCK-settled fee carries an exact base-unit amount
  assert.ok(BigInt(q.payAmount) > 0n);
});

test("activates a listing with a verified on-chain fee and derives its markets", async () => {
  const { listings, registry } = setup();
  const res = await listings.create("block1lister", {
    asset: ASSET,
    extraPairs: ["USDC"],
    paymentTxid: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  });
  assert.ok(res.listingId.startsWith("lst_"));
  assert.ok(res.markets.includes("BLOCK/MYT"));

  // the new asset + markets are now live in the registry
  assert.ok(registry.asset("MYT"));
  assert.ok(registry.markets().some((m) => m.market === "BLOCK/MYT"));
  assert.ok(registry.markets().some((m) => m.market === "MYT/USDC"));
  assert.equal(listings.list().length, 1);
});

test("rejects a listing with no fee payment", async () => {
  const { listings } = setup();
  await assert.rejects(() => listings.create("block1lister", { asset: ASSET }), /required/i);
});

test("a fee payment cannot be reused for a second listing", async () => {
  const { listings } = setup();
  const txid = "deadbeefdeadbeefdeadbeef";
  await listings.create("block1lister", { asset: ASSET, paymentTxid: txid });
  await assert.rejects(
    () => listings.create("block1lister", { asset: { ...ASSET, symbol: "OTHER" }, paymentTxid: txid }),
    /already been used/i,
  );
});

test("cannot re-list a base asset or BLOCK itself", () => {
  const { listings } = setup();
  assert.throws(() => listings.quote({ symbol: "BLOCK", chain: "block", kind: "native", decimals: 8 }), /BLOCK/);
  assert.throws(() => listings.quote({ symbol: "USDC", chain: "base", kind: "erc20", addr: "0x", decimals: 6 }), /base asset/i);
});

test("accepts an x402 listing-paid receipt", async () => {
  const { listings } = setup();
  const res = await listings.create("block1lister", {
    asset: ASSET,
    x402Receipt: { receipt: "rcpt_123", paid: true, settlement: "0xabc" },
  });
  assert.equal(listings.list()[0].listingId, res.listingId);
});
