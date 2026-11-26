// -----------------------------------------------------------------------------
// MIGRATING A DATABASE THAT ALREADY EXISTS.
//
// 663 tests passed and the deploy still took the public API down with
// "SqliteError: no such column: price_key". Every one of those tests builds a
// FRESH database, where `CREATE TABLE ord (... price_key TEXT ...)` runs for
// real and the column is simply there. The live database was created before
// that column existed, so `CREATE TABLE IF NOT EXISTS` did nothing to it — and
// the only code path that has ever mattered for a schema change was the one
// path with no coverage at all.
//
// So these tests start from the OLD schema, byte for byte as the live table
// was, and assert that a Venue can be constructed against it. That is the
// assertion whose absence cost an outage.
//
// It is written to keep working for the NEXT column too: the forward test
// asserts a Venue constructs and the book functions, not that one particular
// column appeared, so adding a second migration does not require editing it.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { Ledger } from "../src/ledger";
import { MARKETS, Venue } from "../src/venue";

/**
 * The `ord` table exactly as it existed in production before `price_key`.
 *
 * Deliberately a literal rather than something derived from SCHEMA: deriving it
 * would track whatever SCHEMA says today, which is precisely the thing that
 * cannot be trusted to describe an old database.
 */
const OLD_ORD_SCHEMA = `
CREATE TABLE IF NOT EXISTS ord (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  market      TEXT NOT NULL,
  side        TEXT NOT NULL,
  price       TEXT NOT NULL,
  base_total  TEXT NOT NULL,
  base_filled TEXT NOT NULL DEFAULT '0',
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seq         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ord_book ON ord(market, side, state);
CREATE INDEX IF NOT EXISTS idx_ord_acct ON ord(account_id);
`;

function legacyDb(): Database.Database {
	const db = new Database(":memory:");
	db.pragma("busy_timeout = 5000");
	// A Ledger first, the way every real process does it, so `ord` is created
	// against a database that already has the ledger's tables.
	new Ledger(db);
	db.exec(OLD_ORD_SCHEMA);
	return db;
}

test("A VENUE CONSTRUCTS AGAINST A PRE-price_key DATABASE", () => {
	// The outage, reduced to one line. Before the fix this threw
	// "no such column: price_key" from the SCHEMA exec, because SCHEMA carried
	// an index naming a column that migrate() had not added yet.
	const db = legacyDb();
	const cols = (db.prepare(`PRAGMA table_info(ord)`).all() as { name: string }[]).map(
		(c) => c.name,
	);
	assert.ok(!cols.includes("price_key"), "the fixture must really be the old schema");

	assert.doesNotThrow(() => new Venue(db, new Ledger(db)));
});

test("the migration adds the column AND the index it needs", () => {
	const db = legacyDb();
	new Venue(db, new Ledger(db));

	const cols = (db.prepare(`PRAGMA table_info(ord)`).all() as { name: string }[]).map(
		(c) => c.name,
	);
	assert.ok(cols.includes("price_key"), "migrate() must add the column");

	// The index is what SCHEMA was trying to create. If migrate() adds the
	// column but not the index, the matcher's ORDER BY price_key silently does
	// a full scan on every order — slow rather than broken, which is worse to
	// find later.
	const idx = (
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ord'`).all() as {
			name: string;
		}[]
	).map((r) => r.name);
	assert.ok(idx.includes("idx_ord_price"), `expected idx_ord_price, got ${idx.join(", ")}`);
});

test("EXISTING ORDERS ARE BACKFILLED, not left with a null key", () => {
	/*
	 * A null price_key is the dangerous outcome, not an empty one: the matcher
	 * compares on price_key, and NULL compares as less than every string in
	 * SQLite. A resting buy with a null key would sort as the cheapest bid in
	 * the book and could be crossed at a price its owner never agreed to.
	 */
	const db = legacyDb();
	const market = MARKETS[0]!.symbol;
	db.prepare(
		`INSERT INTO ord (id, account_id, market, side, price, base_total, base_filled, state, created_at, seq)
		 VALUES (?, ?, ?, 'buy', ?, '1000', '0', 'open', '2026-01-01T00:00:00.000Z', 1)`,
	).run("legacy-1", "acct-1", market, "12345");

	new Venue(db, new Ledger(db));

	const row = db.prepare(`SELECT price, price_key FROM ord WHERE id = ?`).get("legacy-1") as {
		price: string;
		price_key: string | null;
	};
	assert.ok(row.price_key !== null, "a pre-existing order must get a key");
	assert.equal(BigInt(row.price), BigInt(row.price_key!), "and it must encode the same number");
	assert.ok(
		row.price_key!.length > row.price.length,
		"the key is zero-padded to a fixed width, so it is wider than the plain price",
	);
});

test("migrating twice is a no-op", () => {
	// Services restart, and two of them share this database. A migration that
	// is not idempotent turns a routine restart into an outage.
	const db = legacyDb();
	new Venue(db, new Ledger(db));
	assert.doesNotThrow(() => new Venue(db, new Ledger(db)));
	assert.doesNotThrow(() => new Venue(db, new Ledger(db)));
});
