// #37 LISTING LIQUIDITY SEED: premine-funded $5-BLOCK seed at activation.
// Covers seed-amount math, the dryRun-by-default intent (no send), fail-closed
// when a gated mainnet dispense has no signer, and the testnet gating that
// never dispenses even when a signer is present.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Registry } from "../src/registry";
import { Listings } from "../src/listings";
import { makeFeeVerifier } from "../src/feeverify";
import { NoopCompliance } from "../src/compliance";
import { Seeder, SeedError, type ReserveSigner, type SeedIntent } from "../src/seed";

const ASSET = { symbol: "MYT", chain: "block", kind: "block20", addr: "block1tokenxyz", decimals: 8 };

function auditRows(db: any, action: string): any[] {
  return db.prepare("SELECT * FROM audit_log WHERE action=?").all(action) as any[];
}

/** Records every dispense; `available` configurable. Throws if told to. */
class SpySigner implements ReserveSigner {
  calls: SeedIntent[] = [];
  constructor(
    private isAvailable: boolean,
    private txid: string = "0x" + "ab".repeat(32),
  ) {}
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async dispense(intent: SeedIntent): Promise<{ txid: string }> {
    this.calls.push(intent);
    return { txid: this.txid };
  }
}

test("seed amount = seedBlockUsd / blockPriceUsd in BLOCK base units (8 dp)", () => {
  const db = openDb(":memory:");
  // price $1 -> $5 of BLOCK = 5 BLOCK = 5e8 base units
  const s1 = new Seeder(db, loadConfig({ dbPath: ":memory:", blockPriceUsd: 1 } as any));
  assert.equal(s1.seedAmountBase(5).toString(), (5n * 10n ** 8n).toString());
  // price $0.10 -> $5 of BLOCK = 50 BLOCK = 50e8 base units
  const s2 = new Seeder(db, loadConfig({ dbPath: ":memory:", blockPriceUsd: 0.1 } as any));
  assert.equal(s2.seedAmountBase(5).toString(), (50n * 10n ** 8n).toString());
  // default pulls seedBlockUsd ($5) from config
  assert.equal(s1.seedAmountBase().toString(), (5n * 10n ** 8n).toString());
});

test("venue: block20 -> amm-pool, cross-chain -> orderbook", () => {
  const db = openDb(":memory:");
  const s = new Seeder(db, loadConfig({ dbPath: ":memory:" } as any));
  assert.equal(s.venueFor("block20"), "amm-pool");
  assert.equal(s.venueFor("erc20"), "orderbook");
  assert.equal(s.venueFor("native"), "orderbook");
});

test("DEFAULT (testnet) is a DRY RUN: records an intent, performs NO send", async () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ dbPath: ":memory:" } as any);
  assert.equal(cfg.mainnetEnabled, false); // default
  const spy = new SpySigner(true); // signer present but MUST NOT be used on testnet
  const seeder = new Seeder(db, cfg, spy);

  const res = await seeder.seedListing({ listingId: "lst_1", symbol: "MYT", assetKind: "block20", lister: "block1x" });

  assert.equal(res.dryRun, true);
  assert.equal(res.dispensed, false);
  assert.equal(res.txid, undefined);
  assert.equal(res.market, "BLOCK/MYT");
  assert.equal(res.blockAmountBase, (5n * 10n ** 8n).toString());
  // the signer was never asked to dispense (gating)
  assert.equal(spy.calls.length, 0);
  // the dispense INTENT was audit-logged; no real dispense row
  assert.equal(auditRows(db, "listing.seed.intent").length, 1);
  assert.equal(auditRows(db, "listing.seed.dispense").length, 0);
});

test("FAIL-CLOSED: gated mainnet seed with NO signer throws and does not send", async () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ dbPath: ":memory:", mainnetEnabled: true } as any);
  const seeder = new Seeder(db, cfg, undefined); // no reserve signer

  await assert.rejects(
    () => seeder.seedListing({ listingId: "lst_2", symbol: "MYT", assetKind: "block20", lister: "block1x" }),
    (e: unknown) => e instanceof SeedError && /unavailable|fail-closed/i.test((e as Error).message),
  );
  assert.equal(auditRows(db, "listing.seed.fail").length, 1);
  assert.equal(auditRows(db, "listing.seed.dispense").length, 0);
});

test("FAIL-CLOSED: gated mainnet seed with an UNAVAILABLE signer throws", async () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ dbPath: ":memory:", mainnetEnabled: true } as any);
  const spy = new SpySigner(false); // present but unreachable
  const seeder = new Seeder(db, cfg, spy);

  await assert.rejects(
    () => seeder.seedListing({ listingId: "lst_3", symbol: "MYT", assetKind: "block20", lister: "block1x" }),
    SeedError,
  );
  assert.equal(spy.calls.length, 0); // never attempted a send
});

test("gated mainnet with an available signer performs a REAL dispense", async () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ dbPath: ":memory:", mainnetEnabled: true } as any);
  const spy = new SpySigner(true, "0x" + "cd".repeat(32));
  const seeder = new Seeder(db, cfg, spy);

  const res = await seeder.seedListing({ listingId: "lst_4", symbol: "MYT", assetKind: "block20", lister: "block1x" });
  assert.equal(res.dispensed, true);
  assert.equal(res.dryRun, false);
  assert.equal(res.txid, "0x" + "cd".repeat(32));
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].market, "BLOCK/MYT");
  assert.equal(auditRows(db, "listing.seed.dispense").length, 1);
});

test("seed disabled => no-op, still audit-logged, no send", async () => {
  const db = openDb(":memory:");
  const cfg = loadConfig({ dbPath: ":memory:" } as any);
  (cfg.seed as any).enabled = false;
  const spy = new SpySigner(true);
  const seeder = new Seeder(db, cfg, spy);

  const res = await seeder.seedListing({ listingId: "lst_5", symbol: "MYT", assetKind: "block20", lister: "block1x" });
  assert.equal(res.dispensed, false);
  assert.equal(res.blockAmountBase, "0");
  assert.equal(spy.calls.length, 0);
  assert.equal(auditRows(db, "listing.seed.skip").length, 1);
});

test("Listings.create attaches a dryRun seed to the result on testnet (IN ADDITION to the fee)", async () => {
  const cfg = loadConfig({ dbPath: ":memory:" } as any);
  const db = openDb(cfg.dbPath);
  const registry = new Registry(db, cfg);
  const listings = new Listings(db, cfg, registry, makeFeeVerifier(cfg), new NoopCompliance());

  const res = await listings.create("block1lister", {
    asset: ASSET,
    paymentTxid: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  });
  assert.ok(res.listingId.startsWith("lst_"));
  assert.ok(res.seed, "listing result carries a seed");
  assert.equal(res.seed.dryRun, true);
  assert.equal(res.seed.dispensed, false);
  assert.equal(res.seed.market, "BLOCK/MYT");
  assert.equal(res.seed.venue, "amm-pool");
  assert.equal(res.seed.blockAmountBase, (5n * 10n ** 8n).toString());
  // listing is still live
  assert.equal(listings.list().length, 1);
});
