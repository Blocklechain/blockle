// -----------------------------------------------------------------------------
// DEPOSIT ADDRESS TESTS.
//
// This is the one place in the service where a wrong answer is unrecoverable:
// a deposit sent to an address nobody controls is not delayed or refunded, it
// is gone. So the tests are mostly about what the module REFUSES to do —
// invent, reuse, overwrite, or fall back.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { DepositError, Deposits, describeDeposit } from "../src/deposits";

const setup = (): Deposits => new Deposits(new Database(":memory:"));

test("a provisioned address round-trips", () => {
	const d = setup();
	d.provision({
		userId: "u1",
		asset: "USDT",
		network: "TRC20",
		address: "TXyz...1",
		source: "bitgo",
	});
	const got = d.addressFor("u1", "USDT", "TRC20");
	assert.equal(got?.address, "TXyz...1");
	assert.equal(got?.network, "TRC20");
	assert.equal(got?.source, "bitgo");
});

test("AN UNPROVISIONED CHAIN RETURNS NOTHING — never a guess", () => {
	const d = setup();
	assert.equal(d.addressFor("u1", "USDT", "ERC20"), undefined);
});

test("THE REFUSAL NAMES A CHAIN THAT WOULD WORK", () => {
	// "You cannot deposit on Solana" is a dead end. "You cannot deposit on
	// Solana; Tron is available" is an answer.
	const d = setup();
	d.provision({ userId: "u1", asset: "USDT", network: "TRC20", address: "T1", source: "bitgo" });

	const r = describeDeposit(d, "u1", "USDT", "SOL");
	assert.equal(r.address, null);
	assert.match(String(r.reason), /No USDT deposit address is provisioned on SOL/);
	assert.match(String(r.reason), /cannot be recovered by anyone/);
	assert.deepEqual(r.alternatives, ["TRC20"]);
	assert.match(String(r.reason), /available on: TRC20/);
});

test("ONE CUSTOMER'S ADDRESS IS NOT ANOTHER'S", () => {
	// Deposits are credited by the address they arrived at, so a shared address
	// makes two customers' funds indistinguishable.
	const d = setup();
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q-one", source: "bitgo" });
	assert.equal(d.addressFor("u2", "BTC", undefined), undefined);
	assert.throws(
		() =>
			d.provision({
				userId: "u2",
				asset: "BTC",
				network: undefined,
				address: "bc1q-one",
				source: "bitgo",
			}),
		/UNIQUE|constraint/i,
	);
});

test("RE-PROVISIONING THE SAME ADDRESS IS IDEMPOTENT", () => {
	// A retried provisioning run must not fail or duplicate.
	const d = setup();
	const a = d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q", source: "bitgo" });
	const b = d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q", source: "bitgo" });
	assert.equal(a.address, b.address);
	assert.equal(a.createdAt, b.createdAt, "the original row, not a new one");
});

test("A DIFFERENT ADDRESS FOR THE SAME SLOT IS REFUSED", () => {
	// Replacing it would orphan any deposit already on its way to the old one.
	const d = setup();
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q-old", source: "bitgo" });
	assert.throws(
		() =>
			d.provision({
				userId: "u1",
				asset: "BTC",
				network: undefined,
				address: "bc1q-new",
				source: "bitgo",
			}),
		(e: unknown) => {
			assert.ok(e instanceof DepositError);
			assert.equal(e.status, 409);
			assert.match(String(e), /orphan deposits already in flight/);
			return true;
		},
	);
	assert.equal(d.addressFor("u1", "BTC", undefined)?.address, "bc1q-old");
});

test("rows cannot be edited in place", () => {
	const db = new Database(":memory:");
	const d = new Deposits(db);
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q", source: "bitgo" });
	assert.throws(
		() => db.exec(`UPDATE deposit_address SET address = 'bc1q-evil'`),
		/not edited/,
	);
});

test("a multi-network asset must name a chain, and a single-chain one must not", () => {
	const d = setup();
	assert.throws(() => d.addressFor("u1", "USDT", undefined), /exists on 4 chains/);
	assert.throws(() => d.addressFor("u1", "USDT", "NOPE"), /not available on NOPE/);
	assert.throws(() => d.addressFor("u1", "BTC", "ERC20"), /single-chain/);
	// And a qualified id is refused outright rather than silently split.
	assert.throws(() => d.addressFor("u1", "USDT.TRC20", undefined), /separately/);
});

test("A MEMO IS REPORTED AS REQUIRED, not optional", () => {
	// XRP and its kind credit by tag on a shared address. A deposit without the
	// tag cannot be credited to anyone, so "optional" would be a lie that costs
	// money.
	const d = setup();
	d.provision({
		userId: "u1",
		asset: "XRP",
		network: undefined,
		address: "rShared",
		memo: "8812345",
		source: "bitgo",
	});
	const r = describeDeposit(d, "u1", "XRP", undefined);
	assert.equal(r.address, "rShared");
	assert.equal(r.memo, "8812345");
	assert.equal(r.memoRequired, true);

	// No memo on a chain that does not use one.
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q", source: "bitgo" });
	assert.equal(describeDeposit(d, "u1", "BTC", undefined).memoRequired, false);
});

test("provenance is mandatory", () => {
	// An address with no recorded source cannot be audited, and an address that
	// cannot be audited is one nobody can later prove was ours.
	const d = setup();
	assert.throws(
		() => d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q", source: "  " }),
		/source is required/,
	);
	assert.throws(
		() => d.provision({ userId: "u1", asset: "BTC", network: undefined, address: " ", source: "bitgo" }),
		/address is required/,
	);
});
