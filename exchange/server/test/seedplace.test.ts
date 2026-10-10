// #37 PLACEMENT: the premine BLOCK seed becomes REAL, visible, tradeable
// liquidity — a resting PROTOCOL order in the mandatory BLOCK/<symbol> market.
//
// Covers: a real (dispensed) seed places exactly ONE protocol SELL-BLOCK order
// in the right market at a sane price; a dry-run places NONE but records the
// intent; a failed/gated dispense places none and the listing fails CLOSED; and
// the protocol order is MARKED (origin), references the dispense txid, and is
// NON-CUSTODIAL (no key/signature-secret in the relay).

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { Registry } from "../src/registry";
import { SwapEngine } from "../src/swaps";
import { OrderBook } from "../src/orders";
import { Listings } from "../src/listings";
import { NoopCompliance } from "../src/compliance";
import { Seeder, SeedError, type ReserveSigner, type SeedIntent, type SeedResult } from "../src/seed";
import type { FeeVerifier } from "../src/feeverify";

const ASSET = { symbol: "MYT", chain: "block", kind: "block20", addr: "block1tokenxyz", decimals: 8 };
const TXID = "0x" + "cd".repeat(32);

function auditRows(db: any, action: string): any[] {
  return db.prepare("SELECT * FROM audit_log WHERE action=?").all(action) as any[];
}

/** A reserve signer that records calls; availability + txid configurable. */
class SpySigner implements ReserveSigner {
  calls: SeedIntent[] = [];
  constructor(
    private isAvailable: boolean,
    private txid: string = TXID,
  ) {}
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async dispense(intent: SeedIntent): Promise<{ txid: string }> {
    this.calls.push(intent);
    return { txid: this.txid };
  }
}

/** Test fee verifier that always confirms — lets us exercise the mainnet
 *  activation path without a real chain/facilitator (the dev verifier refuses
 *  on mainnet by design). */
class OkVerifier implements FeeVerifier {
  async verify() {
    return { verified: true as const, kind: "onchain" as const, detail: "test-ok" };
  }
}

function makeBook(db: any, cfg: any) {
  const registry = new Registry(db, cfg);
  const swaps = new SwapEngine(db);
  const book = new OrderBook(db, cfg, registry, swaps);
  return { registry, swaps, book };
}

// ---- placeSeedLiquidity unit behaviour ------------------------------------

test("REAL dispense places exactly ONE protocol SELL-BLOCK order at a sane price", () => {
  const cfg = loadConfig({ dbPath: ":memory:", blockPriceUsd: 1 } as any);
  (cfg.seed as any).seedAssetPriceUsd = 0.1; // $1 BLOCK / $0.10 asset => 10 MYT per BLOCK
  const db = openDb(cfg.dbPath);
  const { book } = makeBook(db, cfg);

  const seed: SeedResult = {
    intentId: "seed_real1",
    market: "BLOCK/MYT",
    venue: "orderbook",
    seedUsd: 5,
    blockAmountBase: (5n * 10n ** 8n).toString(),
    dispensed: true,
    dryRun: false,
    txid: TXID,
    detail: "dispensed",
  };

  const p = book.placeSeedLiquidity(seed, { symbol: "MYT", assetKind: "block20" });
  assert.equal(p.placed, true);
  assert.equal(p.recordedIntent, false);
  assert.ok(p.orderId?.startsWith("ord_"));
  assert.equal(p.market, "BLOCK/MYT");
  assert.equal(p.side, "sell");
  assert.equal(p.origin, "protocol-seed");
  assert.equal(p.price, "10"); // sane, from the listing/curve price
  assert.equal(p.amount, (5n * 10n ** 8n).toString());

  // exactly one order, and it is the protocol SELL-BLOCK ask in BLOCK/MYT
  const rows = db.prepare("SELECT * FROM orders").all() as any[];
  assert.equal(rows.length, 1);
  const bk = book.book("BLOCK/MYT");
  assert.equal(bk.asks.length, 1);
  assert.equal(bk.bids.length, 0);
  assert.equal(bk.asks[0].origin, "protocol-seed");
  assert.equal(bk.asks[0].price, "10");
  assert.equal(bk.asks[0].amount, (5n * 10n ** 8n).toString());

  // audited as a placement
  assert.equal(auditRows(db, "order.seed.place").length, 1);
  assert.equal(auditRows(db, "order.seed.intent").length, 0);
});

test("DRY-RUN places NO order but records the placement intent", () => {
  const cfg = loadConfig({ dbPath: ":memory:" } as any);
  const db = openDb(cfg.dbPath);
  const { book } = makeBook(db, cfg);

  const seed: SeedResult = {
    intentId: "seed_dry1",
    market: "BLOCK/MYT",
    venue: "orderbook",
    seedUsd: 5,
    blockAmountBase: (5n * 10n ** 8n).toString(),
    dispensed: false,
    dryRun: true,
    detail: "dry-run",
  };

  const p = book.placeSeedLiquidity(seed, { symbol: "MYT", assetKind: "block20" });
  assert.equal(p.placed, false);
  assert.equal(p.recordedIntent, true);
  assert.equal(p.orderId, undefined);
  assert.ok(p.price, "dry-run still computes the indicative price");

  // no live order anywhere
  assert.equal((db.prepare("SELECT * FROM orders").all() as any[]).length, 0);
  assert.equal(book.book("BLOCK/MYT").asks.length, 0);
  // intent recorded, no placement
  assert.equal(auditRows(db, "order.seed.intent").length, 1);
  assert.equal(auditRows(db, "order.seed.place").length, 0);
});

test("protocol order is MARKED, references the dispense txid, and is NON-CUSTODIAL (no key in the relay)", () => {
  const cfg = loadConfig({ dbPath: ":memory:" } as any);
  const db = openDb(cfg.dbPath);
  const { book } = makeBook(db, cfg);

  const seed: SeedResult = {
    intentId: "seed_mark1",
    market: "BLOCK/MYT",
    venue: "orderbook",
    seedUsd: 5,
    blockAmountBase: (5n * 10n ** 8n).toString(),
    dispensed: true,
    dryRun: false,
    txid: TXID,
    detail: "dispensed",
  };
  const p = book.placeSeedLiquidity(seed, { symbol: "MYT", assetKind: "block20" });

  const row = book.getOrder(p.orderId!)!;
  assert.equal(row.origin, "protocol-seed"); // marked
  assert.equal(row.seedTxid, TXID); // references the dispense txid
  assert.equal(row.maker, cfg.seed.seedDestination); // backed by the reserve seed wallet

  // NON-CUSTODIAL: the stored row carries NO private key / real signature — the
  // signature column is a provenance sentinel, and no key material is present.
  const raw = db.prepare("SELECT * FROM orders WHERE order_id=?").get(p.orderId) as any;
  assert.equal(raw.seed_txid, TXID);
  assert.equal(raw.origin, "protocol-seed");
  assert.ok(String(raw.signature).startsWith("protocol-seed:"));
  assert.ok(!/priv|secret|0x[0-9a-fA-F]{64}/.test(String(raw.signature)));

  // idempotent: re-placing the same seed does not create a second order
  const again = book.placeSeedLiquidity(seed, { symbol: "MYT", assetKind: "block20" });
  assert.equal(again.orderId, p.orderId);
  assert.equal((db.prepare("SELECT * FROM orders").all() as any[]).length, 1);
});

// ---- wired through Listings.create ----------------------------------------

test("Listings.create on testnet records a placement INTENT and posts NO live order", async () => {
  const cfg = loadConfig({ dbPath: ":memory:" } as any);
  const db = openDb(cfg.dbPath);
  const { registry, book } = makeBook(db, cfg);
  const listings = new Listings(db, cfg, registry, new OkVerifier(), new NoopCompliance(), undefined, undefined, book);

  const res = await listings.create("block1lister", {
    asset: ASSET,
    paymentTxid: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  });

  assert.equal(res.seed.dryRun, true);
  assert.ok(res.seedPlacement, "a placement is reported");
  assert.equal(res.seedPlacement!.placed, false);
  assert.equal(res.seedPlacement!.recordedIntent, true);
  // listing is live, but no resting order was posted
  assert.equal(listings.list().length, 1);
  assert.equal((db.prepare("SELECT * FROM orders").all() as any[]).length, 0);
});

test("Listings.create with a REAL dispense posts exactly one protocol order into the live market", async () => {
  const cfg = loadConfig({ dbPath: ":memory:", mainnetEnabled: true, blockPriceUsd: 1 } as any);
  (cfg.seed as any).seedAssetPriceUsd = 0.1;
  const db = openDb(cfg.dbPath);
  const { registry, book } = makeBook(db, cfg);
  const seeder = new Seeder(db, cfg, new SpySigner(true, TXID));
  const listings = new Listings(db, cfg, registry, new OkVerifier(), new NoopCompliance(), undefined, seeder, book);

  const res = await listings.create("block1lister", {
    asset: ASSET,
    paymentTxid: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  });

  assert.equal(res.seed.dispensed, true);
  assert.equal(res.seedPlacement!.placed, true);
  assert.equal(res.seedPlacement!.seedTxid, TXID);

  // the BLOCK/MYT market is live and shows exactly one protocol ask
  assert.ok(registry.markets().some((m) => m.market === "BLOCK/MYT"));
  const bk = book.book("BLOCK/MYT");
  assert.equal(bk.asks.length, 1);
  assert.equal(bk.asks[0].origin, "protocol-seed");
  assert.equal((db.prepare("SELECT * FROM orders").all() as any[]).length, 1);
});

test("FAIL-CLOSED: a gated dispense that cannot be performed throws, places no order, and does not activate the listing", async () => {
  const cfg = loadConfig({ dbPath: ":memory:", mainnetEnabled: true } as any);
  const db = openDb(cfg.dbPath);
  const { registry, book } = makeBook(db, cfg);
  const seeder = new Seeder(db, cfg, new SpySigner(false)); // signer unavailable
  const listings = new Listings(db, cfg, registry, new OkVerifier(), new NoopCompliance(), undefined, seeder, book);

  await assert.rejects(
    () => listings.create("block1lister", { asset: ASSET, paymentTxid: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }),
    SeedError,
  );
  // no listing activated, no order placed, no placement recorded
  assert.equal(listings.list().length, 0);
  assert.equal((db.prepare("SELECT * FROM orders").all() as any[]).length, 0);
  assert.equal(auditRows(db, "order.seed.place").length, 0);
  assert.equal(auditRows(db, "order.seed.intent").length, 0);
});
