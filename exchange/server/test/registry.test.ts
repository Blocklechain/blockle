// Market derivation is config-driven off the registry. These tests pin that
// the BTC + Sui full trading legs show up as real markets with the right asset
// specs, and that the mandatory-BLOCK-pair listing rule still holds.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Registry } from "../src/registry";

function registry() {
  const cfg = loadConfig({ dbPath: ":memory:" });
  const db = openDb(cfg.dbPath);
  return new Registry(db, cfg);
}

test("BTC + SUI are first-class base assets", () => {
  const reg = registry();
  const btc = reg.asset("BTC");
  const sui = reg.asset("SUI");
  assert.ok(btc, "BTC asset exists");
  assert.ok(sui, "SUI asset exists");
  assert.equal(btc!.chain, "bitcoin");
  assert.equal(btc!.kind, "native");
  assert.equal(btc!.decimals, 8);
  assert.equal(sui!.chain, "sui");
  assert.equal(sui!.kind, "native");
  assert.equal(sui!.decimals, 9);
  assert.ok(reg.isBaseAsset("BTC"));
  assert.ok(reg.isBaseAsset("SUI"));
});

test("market derivation includes the new BTC + SUI pairs", () => {
  const reg = registry();
  const names = new Set(reg.markets().map((m) => m.market));
  for (const pair of ["BLOCK/BTC", "BLOCK/SUI", "BTC/USDC", "SUI/USDC", "BTC/SUI"]) {
    assert.ok(names.has(pair), `market ${pair} is derived`);
  }
  // existing markets are untouched (additive)
  for (const pair of ["BLOCK/ETH", "BLOCK/SOL", "BLOCK/USDC", "ETH/USDC", "SOL/USDC"]) {
    assert.ok(names.has(pair), `existing market ${pair} preserved`);
  }
});

test("derived markets carry correct base/quote asset specs", () => {
  const reg = registry();
  const m = reg.market("BTC/SUI");
  assert.ok(m);
  assert.equal(m!.baseAsset.chain, "bitcoin");
  assert.equal(m!.quoteAsset.chain, "sui");

  const u = reg.market("BTC/USDC");
  assert.ok(u);
  assert.equal(u!.baseAsset.symbol, "BTC");
  assert.equal(u!.quoteAsset.symbol, "USDC");
  // testnet-first: USDC resolves to its testnet (Base Sepolia) address by default
  assert.equal(u!.quoteAsset.addr, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
});

test("a listing still prepends the mandatory BLOCK pair (BTC/SUI quote ok)", () => {
  const reg = registry();
  const names = reg.marketsForListing("WIDGET", ["BTC", "SUI"]);
  assert.equal(names[0], "BLOCK/WIDGET");
  assert.ok(names.includes("WIDGET/BTC"));
  assert.ok(names.includes("WIDGET/SUI"));
});
