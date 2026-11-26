// -----------------------------------------------------------------------------
// THE BLOCK ADDRESS POOL HAS TO REACH THE ADAPTER THAT ISSUES ADDRESSES.
//
// `nodeAdapters` took a `blockPool` and never forwarded it: the call was
// `blockAdapterFromEnv(args.env)` against a signature of
// (env, fetchImpl?, pool?). Optional trailing parameters make that silent —
// no arity error, compiles, runs, and per-customer BLOCK deposits are off.
//
// It was maddening to find because the pool WAS loaded and the service said so.
// publicapi holds its own reference and logged "block pool: 999 free of 1000"
// at startup, while every deposit request was refused with "BLOCK deposits are
// not open: no address pool is loaded. Derive a batch on the wallet host..." —
// instructing an operator to do the thing already done. A thousand addresses
// sat in the database for hours while customers were told the rail was shut.
//
// So this does not test that the pool works (blockaddresspool.test.ts does).
// It tests that the WIRING carries it, which is the part that broke.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";

import Database from "better-sqlite3";

import { BlockAddressPool } from "../src/blockaddresspool";
import { nodeAdapters } from "../src/custodyrouting";

/** A pool with addresses in it, in a throwaway database. */
function loadedPool(): BlockAddressPool {
	const db = new Database(":memory:");
	const pool = new BlockAddressPool(db);
	pool.load([
		{ index: 0, address: "block1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqa" },
		{ index: 1, address: "block1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqb" },
	]);
	return pool;
}

/** BLOCK's adapter needs only this to be constructed. */
const ENV = { BLOCK_EXPLORER_URL: "http://127.0.0.1:8445" } as NodeJS.ProcessEnv;

test("A POOL PASSED TO nodeAdapters REACHES THE BLOCK ADAPTER", async () => {
	const pool = loadedPool();
	const before = pool.status();
	assert.equal(before.free, 2, "the fixture must start with addresses");

	const map = nodeAdapters({ env: ENV, blockPool: pool });
	const block = map.get("BLOCK");
	assert.ok(block !== undefined, "BLOCK must get an adapter when its explorer URL is set");

	/*
	 * The observable consequence, not the plumbing: an adapter that received
	 * the pool ISSUES an address, and one that did not refuses. Asserting the
	 * behaviour rather than a constructor argument means this keeps working if
	 * the pool is ever threaded through differently.
	 *
	 * newAddress() is used rather than probe() because probe() reaches for the
	 * explorer over HTTP, which is not available in a unit test — and because
	 * "can a customer actually get an address" is the question that was
	 * answered wrongly in production.
	 */
	const addr = await block!.newAddress("blockle-ex:wiring-test");
	assert.match(addr, /^block1/, `expected a BLOCK address, got ${addr}`);
	assert.equal(pool.status().issued, 1, "and it must come out of the pool");
	assert.equal(pool.status().free, 1);
});

test("WITHOUT a pool, BLOCK refuses clearly rather than pretending", async () => {
	// The honest negative, and the message matters as much as the refusal.
	// BLOCK genuinely cannot derive its own addresses — ML-DSA has no
	// watch-only derivation, so deriving IS spending, which is why the pool
	// exists at all. An adapter with no pool must say that, not return a blank.
	const map = nodeAdapters({ env: ENV });
	const block = map.get("BLOCK");
	assert.ok(block !== undefined, "it still reports balances without a pool");
	await assert.rejects(
		() => block!.newAddress("blockle-ex:no-pool"),
		/no address pool is loaded/,
		"the refusal must name the actual cause",
	);
});

test("the pool is not consumed merely by constructing the adapter", () => {
	// Wiring must not issue. If constructing the routing table took an address,
   // every service restart would burn one and the pool would drain silently.
	const pool = loadedPool();
	nodeAdapters({ env: ENV, blockPool: pool });
	assert.equal(pool.status().free, 2, "constructing adapters must not issue an address");
	assert.equal(pool.status().issued, 0);
});
