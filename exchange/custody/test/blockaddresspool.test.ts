// -----------------------------------------------------------------------------
// BLOCK ADDRESS POOL TESTS.
//
// One address, one customer, forever. Everything here defends that:
//
//   * no address is ever issued twice, including under a race;
//   * a customer always gets back the address they were already given;
//   * an empty pool stops deposits rather than reusing one;
//   * two different master seeds cannot be mixed into one pool.
//
// The failure these prevent is the same in every case: two customers sharing
// a deposit address, which makes their coins indistinguishable on arrival.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { AddressPoolError, BlockAddressPool } from "../src/blockaddresspool";

const addr = (n: number): string =>
	`block1${n.toString(36).padStart(4, "0")}${"q".repeat(50)}`;

const batch = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => ({ index: from + i, address: addr(from + i) }));

function pool(): BlockAddressPool {
	return new BlockAddressPool(new Database(":memory:"));
}

// ------------------------------------------------------------------ loading

test("a batch loads, and reloading it is a no-op rather than an error", () => {
	// The realistic operator mistake is running the load twice. Failing the
	// whole batch for that pushes someone toward a --force-shaped workaround.
	const p = pool();
	assert.deepEqual(p.load(batch(0, 10)), { added: 10, alreadyPresent: 0 });
	assert.deepEqual(p.load(batch(0, 10)), { added: 0, alreadyPresent: 10 });
	assert.deepEqual(p.load(batch(5, 10)), { added: 5, alreadyPresent: 5 });
	assert.equal(p.status().total, 15);
});

test("TWO MASTER SEEDS CANNOT BE MIXED INTO ONE POOL", () => {
	// Same index, different address means the batch came from another seed.
	// A pool holding both contains addresses nobody can match to a key.
	const p = pool();
	p.load(batch(0, 3));
	assert.throws(
		() => p.load([{ index: 1, address: addr(999) }]),
		(e: unknown) => {
			assert.match(String(e), /two different master seeds/);
			assert.match(String(e), /nobody can match to a key/);
			return true;
		},
	);
	// And the good entries survive: the load is one transaction.
	assert.equal(p.status().total, 3);
});

test("a malformed address is refused at load, not at use", () => {
	// In the pool it would become a deposit address no coins can reach.
	const p = pool();
	for (const bad of ["", "bc1qxyz", "block1", "BLOCK1AAAA", "block1!!!"]) {
		assert.throws(() => p.load([{ index: 0, address: bad }]), /not a BLOCK address/,
			JSON.stringify(bad));
	}
	assert.equal(p.status().total, 0);
});

test("a nonsensical index is refused", () => {
	const p = pool();
	assert.throws(() => p.load([{ index: -1, address: addr(1) }]), /not a derivation index/);
	assert.throws(() => p.load([{ index: 1.5, address: addr(1) }]), /not a derivation index/);
	assert.throws(() => p.load([]), /nothing to load/);
});

// ------------------------------------------------------------------ issuing

test("ONE ADDRESS PER CUSTOMER, and the same one on every visit", () => {
	// A customer returning to the deposit screen must see the address they
	// already have, or a deposit in flight to the old one looks unattributed.
	const p = pool();
	p.load(batch(0, 5));
	const first = p.take("alice");
	assert.equal(p.take("alice").address, first.address);
	assert.equal(p.take("alice").index, first.index);
	assert.equal(p.status().issued, 1, "repeat visits do not consume the pool");
});

test("NO TWO CUSTOMERS EVER SHARE AN ADDRESS", () => {
	const p = pool();
	p.load(batch(0, 50));
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const got = p.take(`user-${i}`);
		assert.ok(!seen.has(got.address), `${got.address} issued twice`);
		seen.add(got.address);
	}
	assert.equal(p.status().free, 0);
});

test("addresses are handed out in index order", () => {
	// Not required for correctness, but it keeps the operator's sweep list
	// contiguous and makes a gap visible.
	const p = pool();
	p.load(batch(10, 3));
	assert.deepEqual(
		["a", "b", "c"].map((u) => p.take(u).index),
		[10, 11, 12],
	);
});

test("AN EMPTY POOL STOPS DEPOSITS, and says how to refill", () => {
	// The alternative — reusing an address — credits two customers' coins to
	// the same place, which cannot be untangled afterwards.
	const p = pool();
	p.load(batch(0, 1));
	p.take("alice");
	assert.throws(() => p.take("bob"), (e: unknown) => {
		assert.equal((e as AddressPoolError).status, 503);
		assert.match(String(e), /no BLOCK deposit addresses are left/);
		assert.match(String(e), /rather than reusing one/);
		assert.match(String(e), /wallet derive --count 1000 --json/);
		return true;
	});
	// An existing owner is still served from an empty pool: their address was
	// already taken, so nothing needs to be issued.
	assert.equal(p.take("alice").index, 0);
});

test("an address needs an owner", () => {
	const p = pool();
	p.load(batch(0, 2));
	assert.throws(() => p.take("   "), /needs an owner/);
});

// --------------------------------------------------------------- attribution

test("an incoming deposit resolves to its owner", () => {
	const p = pool();
	p.load(batch(0, 3));
	const a = p.take("alice");
	assert.equal(p.ownerOf(a.address), "alice");
	// An address in the pool but not yet issued has no owner — a deposit to
	// it is unattributed, which the watcher parks rather than guesses.
	assert.equal(p.ownerOf(addr(2)), undefined);
	// And one that is not ours at all.
	assert.equal(p.ownerOf(addr(99)), undefined);
});

test("custody watches every address, issued or not", () => {
	// Coins can arrive at an address that was derived but never handed out —
	// an operator testing, or a customer reusing one from a previous batch.
	const p = pool();
	p.load(batch(0, 4));
	p.take("alice");
	assert.equal(p.allAddresses().length, 4);
});

// -------------------------------------------------------------------- runway

test("the low-water mark scales with the pool, and fires before it empties", () => {
	// "50 left" means something different for a 100-address pool than for a
	// 10,000-address one, and an operator needs warning early enough to
	// refill calmly.
	// A floor of 16 free addresses, whatever the pool size: below that there
	// is not enough room to refill without a rush, however big the pool was.
	const small = pool();
	small.load(batch(0, 20));
	assert.equal(small.status().low, false, "20 free is not yet low");
	for (let i = 0; i < 4; i++) small.take(`u${i}`);
	assert.equal(small.status().free, 16);
	assert.equal(small.status().low, true, "16 free trips the floor");

	const big = pool();
	big.load(batch(0, 1000));
	assert.equal(big.status().low, false);
	for (let i = 0; i < 901; i++) big.take(`u${i}`);
	assert.equal(big.status().low, true, "under 10% remaining");
	assert.equal(big.status().free, 99);
});

test("an empty pool is not 'low', it is empty", () => {
	// Nothing loaded yet is a different operator action from running out.
	const p = pool();
	assert.deepEqual(p.status(), { total: 0, issued: 0, free: 0, low: false });
});

// ------------------------------------------------------------------ the race

test("A CONCURRENT CLAIM CANNOT HAND THE SAME ADDRESS TO BOTH", () => {
	/*
	 * better-sqlite3 is synchronous, so this simulates the interleaving the
	 * conditional UPDATE exists to survive: another writer takes the row
	 * between this one's SELECT and its UPDATE. The guard is
	 * `WHERE issued_to IS NULL`, which makes the loser's update affect zero
	 * rows rather than overwriting the winner's claim.
	 */
	const db = new Database(":memory:");
	const p = new BlockAddressPool(db);
	p.load(batch(0, 2));

	// Simulate the interleaving: claim index 0 directly for carol, as if a
	// parallel request had just won it.
	db.prepare(
		`UPDATE block_address_pool SET issued_to = 'carol', issued_at = 'now'
		 WHERE idx = 0 AND issued_to IS NULL`,
	).run();

	const got = p.take("dave");
	assert.notEqual(got.address, addr(0), "dave must not get carol's address");
	assert.equal(got.index, 1);
	assert.equal(p.ownerOf(addr(0)), "carol");
});
