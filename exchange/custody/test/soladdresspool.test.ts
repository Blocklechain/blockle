// -----------------------------------------------------------------------------
// SOLANA ADDRESS POOL TESTS.
//
// One address, one customer, forever — the same property blockaddresspool's
// tests defend, for the same reason: two customers sharing a deposit address
// makes their coins indistinguishable on arrival, and Solana has no memo field
// to recover the attribution with afterwards.
//
// AND TWO PROPERTIES BLOCK DOES NOT NEED, WHICH ARE WHY THIS FILE EXISTS
// ALONGSIDE THAT ONE:
//
//   * THE INDEX SURVIVES ISSUANCE. BLOCK's `take()` returns `{address}` and
//     drops the derivation index, which is survivable there because the
//     operator sweeps the whole wallet. Solana is account-per-address: the
//     only way to empty the account a deposit landed in is to re-derive
//     m/44'/501'/idx'/0' on the signer host. An issued address whose index is
//     unknown is a permanently stranded balance, with the seed in hand.
//   * PROJECTED EXHAUSTION. Refilling needs an operator, a seed and an offline
//     host, so "16 left" on a Saturday is already too late.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import Database from "better-sqlite3";

import { base58Encode } from "../src/soladdress";
import { SolAddressPool, SolAddressPoolError } from "../src/soladdresspool";

/** Genuine ed25519 public keys: the pool refuses anything else, correctly. */
function freshAddress(): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" });
	return base58Encode(new Uint8Array(der.subarray(der.length - 32)));
}

function batch(from: number, count: number): { index: number; address: string }[] {
	return Array.from({ length: count }, (_, i) => ({
		index: from + i,
		address: freshAddress(),
	}));
}

function pool(now?: () => Date): SolAddressPool {
	return now === undefined
		? new SolAddressPool(new Database(":memory:"))
		: new SolAddressPool(new Database(":memory:"), now);
}

// ------------------------------------------------------------------ loading

test("a batch loads, and reloading it is a no-op rather than an error", () => {
	// The realistic operator mistake is running the load twice — the file is
	// carried between two hosts by hand. Failing the whole batch for that
	// pushes someone toward a --force-shaped workaround.
	const p = pool();
	const b = batch(0, 10);
	assert.deepEqual(p.load(b), { added: 10, alreadyPresent: 0 });
	assert.deepEqual(p.load(b), { added: 0, alreadyPresent: 10 });
	assert.equal(p.status().total, 10);
});

test("TWO MASTER SEEDS CANNOT BE MIXED INTO ONE POOL", () => {
	/*
	 * Same index, different address means the batch came from another seed. On
	 * BLOCK that is bad; on Solana it is worse, because there is no
	 * wallet-wide sweep to fall back on — an address whose seed is unknown is
	 * an account nobody can ever empty.
	 */
	const p = pool();
	p.load(batch(0, 3));
	assert.throws(
		() => p.load([{ index: 1, address: freshAddress() }]),
		(e: unknown) => {
			assert.match(String(e), /two different master seeds/);
			assert.match(String(e), /no wallet-wide sweep/);
			return true;
		},
	);
	// The good entries survive: the load is one transaction.
	assert.equal(p.status().total, 3);
});

test("A PDA-SHAPED ADDRESS IS REFUSED AT LOAD, not at use", () => {
	/*
	 * This is the check a regex cannot make, and the failure it prevents is
	 * the worst one in the file: an off-curve address is a real, 32-byte,
	 * base58-clean string that no key can ever sign for. In the pool it
	 * becomes a deposit address whose coins are unrecoverable the moment they
	 * arrive — and we would still credit the customer, because the deposit is
	 * real.
	 */
	const p = pool();
	assert.throws(
		() => p.load([{ index: 0, address: "ComputeBudget111111111111111111111111111111" }]),
		/not a usable SOL deposit address.*program-derived/s,
	);
	// The System Program's all-zero address: on the curve, order 4, no signer.
	assert.throws(
		() => p.load([{ index: 0, address: "11111111111111111111111111111111" }]),
		/not a usable SOL deposit address/,
	);
	assert.equal(p.status().total, 0);
});

test("malformed addresses are refused with the specific fault", () => {
	const p = pool();
	const cases: readonly [string, RegExp][] = [
		["", /an address is required/],
		["not base58 0OIl", /not base58/],
		[base58Encode(new Uint8Array(31).fill(3)), /31 bytes/],
	];
	for (const [bad, why] of cases) {
		assert.throws(() => p.load([{ index: 0, address: bad }]), why, JSON.stringify(bad));
	}
	assert.equal(p.status().total, 0);
});

test("a nonsensical index is refused, including beyond the hardened range", () => {
	const p = pool();
	assert.throws(() => p.load([{ index: -1, address: freshAddress() }]), /not a derivation index/);
	assert.throws(() => p.load([{ index: 1.5, address: freshAddress() }]), /not a derivation index/);
	assert.throws(() => p.load([]), /nothing to load/);
	// 2^31 is not a path segment the signer can reproduce: hardened is i+2^31.
	assert.throws(
		() => p.load([{ index: 2 ** 31, address: freshAddress() }]),
		/beyond the hardened range/,
	);
});

// ------------------------------------------------------------------ issuing

test("ONE ADDRESS PER CUSTOMER, and the same one on every visit", () => {
	// A customer returning to the deposit screen must see the address they
	// already have, or a deposit in flight to the old one looks unattributed —
	// and on Solana there is no memo to recover it from.
	const p = pool();
	p.load(batch(0, 5));
	const first = p.take("acct-1");
	assert.equal(p.take("acct-1").address, first.address);
	assert.equal(p.take("acct-1").index, first.index);
	assert.equal(p.status().issued, 1);
});

test("THE DERIVATION INDEX COMES BACK WITH THE ADDRESS", () => {
	/*
	 * THE LOAD-BEARING ASSERTION FOR SWEEPING.
	 *
	 * BLOCK's AddressPool.take() returns only `{address}`. If this one did the
	 * same, the signer host could not re-derive the key for the account a
	 * deposit landed in — and on Solana that key is the only way to empty it.
	 * The index is not a convenience field; it is the recoverability contract.
	 */
	const p = pool();
	const loaded = batch(40, 3);
	p.load(loaded);
	const got = p.take("acct-indexed");
	assert.equal(got.index, 40, "the lowest free index is issued first");
	assert.equal(got.address, loaded[0]?.address);
	assert.equal(p.indexOf(got.address), 40, "and the index is recoverable from the address");
	assert.equal(p.indexOf("ComputeBudget111111111111111111111111111111"), undefined);
});

test("NO TWO CUSTOMERS EVER SHARE AN ADDRESS", () => {
	const p = pool();
	p.load(batch(0, 20));
	const seen = new Set<string>();
	for (let i = 0; i < 20; i += 1) {
		const e = p.take(`acct-${i}`);
		assert.ok(!seen.has(e.address), `${e.address} was issued twice`);
		seen.add(e.address);
	}
	assert.equal(p.status().free, 0);
});

test("AN EMPTY POOL STOPS DEPOSITS, and says how to refill", () => {
	// Exhaustion must stop the rail rather than reuse an address. The message
	// is part of the contract: it names the two-host procedure, because the
	// person reading it cannot fix this from the exchange host.
	const p = pool();
	p.load(batch(0, 1));
	p.take("acct-1");
	assert.throws(
		() => p.take("acct-2"),
		(e: unknown) => {
			assert.ok(e instanceof SolAddressPoolError);
			assert.equal(e.status, 503, "a pool refill is a service condition, not a bad request");
			assert.match(e.message, /no memo field to tell them apart/);
			assert.match(e.message, /solpoolcli/);
			return true;
		},
	);
});

test("an address needs an owner", () => {
	const p = pool();
	p.load(batch(0, 2));
	assert.throws(() => p.take("   "), /an address needs an owner/);
	assert.equal(p.status().issued, 0);
});

test("an incoming deposit resolves to its owner", () => {
	const p = pool();
	p.load(batch(0, 3));
	const mine = p.take("acct-7");
	assert.equal(p.ownerOf(mine.address), "acct-7");
	// An unissued pool address has no owner, and that is not an error: a
	// deposit to one is unattributed, which the watcher handles deliberately.
	const unissued = p.allAddresses().find((a) => a !== mine.address);
	assert.equal(p.ownerOf(unissued as string), undefined);
});

test("custody watches every address, and the scanner only the issued ones", () => {
	/*
	 * Two different questions. Reconciliation must count every pool address,
	 * because coins at an unissued one are still the venue's. The SCANNER
	 * polls only issued addresses, because publicnode caps
	 * getMultipleAccounts at 10 accounts and the difference between 1,000
	 * loaded and 12 issued is 100 round trips a pass versus 2.
	 */
	const p = pool();
	p.load(batch(0, 10));
	p.take("acct-a");
	p.take("acct-b");
	assert.equal(p.allAddresses().length, 10);
	assert.equal(p.issued().length, 2);
	assert.deepEqual(
		p.issued().map((e) => e.index),
		[0, 1],
	);
});

// ---------------------------------------------------------------- watermark

test("the low-water mark scales with the pool, and fires before it empties", () => {
	const big = pool();
	big.load(batch(0, 200));
	for (let i = 0; i < 179; i += 1) big.take(`acct-${i}`);
	assert.equal(big.status().low, false, "21 free of 200 is above the 10% mark");
	big.take("acct-179");
	assert.equal(big.status().low, true, "20 free of 200 is the 10% mark");

	// And the floor of 16 is what makes a small pool warn at all.
	const small = pool();
	small.load(batch(0, 20));
	for (let i = 0; i < 4; i += 1) small.take(`acct-${i}`);
	assert.equal(small.status().low, true, "16 free of 20 is the floor, not the share");
});

test("an empty pool is not 'low', it is closed", () => {
	// Deliberate: total 0 is a different operator conversation ("no batch has
	// ever been loaded") and is surfaced separately. A `low` flag on an empty
	// pool would make the refill warning indistinguishable from never having
	// set the rail up.
	assert.equal(pool().status().low, false);
	assert.equal(pool().status().total, 0);
});

test("PROJECTED EXHAUSTION warns while there is still time to refill", () => {
	/*
	 * The signal BLOCK does not have. 100 addresses with 30 issued in the last
	 * week is ~4.3 a day and ~16 days of runway — not low by the share rule,
	 * and the operator needs to know now, because a refill needs a human, a
	 * seed and an offline host.
	 */
	let clock = new Date("2026-11-20T00:00:00.000Z");
	const p = pool(() => clock);
	p.load(batch(0, 100));
	for (let i = 0; i < 30; i += 1) p.take(`acct-${i}`);
	const s = p.status();
	assert.equal(s.low, false, "70 free of 100 is not low by the share rule");
	assert.ok(s.issuedPerDay !== undefined && Math.abs(s.issuedPerDay - 30 / 7) < 1e-9);
	assert.ok(s.daysOfRunway !== undefined && Math.abs(s.daysOfRunway - 70 / (30 / 7)) < 1e-9);

	// Issuance older than the window does not count: the projection is about
	// the current rate, and a burst last month would hide a quiet pool now.
	clock = new Date("2026-12-20T00:00:00.000Z");
	const later = p.status();
	assert.equal(later.daysOfRunway, undefined, "no recent issuance means no projection");
	assert.equal(later.issuedPerDay, undefined);
});

// --------------------------------------------------------------------- races

test("A CONCURRENT CLAIM CANNOT HAND THE SAME ADDRESS TO BOTH", () => {
	/*
	 * The claim is a conditional UPDATE inside a transaction, so the loser of
	 * a race gets `changes === 0` and moves on. Simulated by taking the row
	 * out from under the claim: a second pool object over the same database is
	 * exactly what two requests are.
	 */
	const db = new Database(":memory:");
	const a = new SolAddressPool(db);
	const b = new SolAddressPool(db);
	a.load(batch(0, 2));
	const first = a.take("acct-1");
	const second = b.take("acct-2");
	assert.notEqual(first.address, second.address);
	assert.notEqual(first.index, second.index);
	assert.equal(a.status().free, 0);
});
