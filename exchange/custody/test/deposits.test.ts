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

import { DepositError, Deposits, describeDeposit, listDepositAddresses } from "../src/deposits";

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
	// Solana; Tron is available" is an answer. That is the intent, and it holds
	// whichever sentence explains the absence.
	//
	// WHAT CHANGED, AND WHY THIS TEST NOW ASSERTS A DIFFERENT SENTENCE. This
	// case names SOL, which is one of the three rails whose cause is MEASURED
	// (settlement.RAIL_BLOCKERS), so `describeDeposit` now answers with that
	// cause instead of the generic "no address is provisioned". The generic
	// wording was true for every absent address, which is exactly why it was
	// useless here: it is what customers were shown for ETH, for BNB and for
	// SOL while the real cause sat in the service's log. The alternative-naming
	// half of the contract is unchanged and still asserted below; the coverage
	// for the generic wording moved to the test immediately after this one, so
	// it is tested on a rail that genuinely has no recorded cause.
	const d = setup();
	d.provision({ userId: "u1", asset: "USDT", network: "TRC20", address: "T1", source: "bitgo" });

	const r = describeDeposit(d, "u1", "USDT", "SOL");
	assert.equal(r.address, null);
	assert.match(String(r.reason), /SOL deposits are not open yet/);
	assert.match(String(r.reason), /we do not hold coins we cannot send/);
	assert.deepEqual(r.alternatives, ["TRC20"]);
	assert.match(String(r.reason), /available on: TRC20/);
	// And it never suggests the address might appear on a reload.
	assert.doesNotMatch(String(r.reason), /try again|retry|reload/i);
});

test("AN ABSENCE WITH NO RECORDED CAUSE STILL GETS THE CAREFUL WORDING", () => {
	// The complement of the test above, and the reason it is a separate test
	// rather than a changed assertion: a rail with no entry in RAIL_BLOCKERS
	// must still fall through to the wording that admits it does not know why.
	// Inventing a cause is worse than admitting none, and the fall-through is
	// the branch that would silently rot if nothing exercised it.
	//
	// DOGE is chosen because it is single-chain and has no measured blocker, so
	// it reaches the generic path by construction rather than by luck.
	const d = setup();
	const r = describeDeposit(d, "u1", "DOGE", undefined);
	assert.equal(r.address, null);
	assert.match(String(r.reason), /No DOGE deposit address is provisioned/);
	assert.match(String(r.reason), /cannot be recovered by anyone/);
	assert.deepEqual(r.alternatives, []);
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

// ------------------------------------- the whole-account address list

test("A CLOSED CHAIN IS REPORTED, NOT OMITTED", async () => {
	// "No address shown" and "this chain is shut until we fund its gas" look
	// identical on a screen, and only one of them is worth waiting out. Dropping
	// the row is what sends someone to support.
	//
	// THE GAS GATE IS NOW EXERCISED ON TRC20 RATHER THAN ERC20, because ERC20
	// is one of the rails with a MEASURED structural blocker and is therefore
	// refused before the gas gate is ever consulted. Pointing the fixture's
	// unfunded chain at ERC20 would have left the gas branch untested while
	// still passing on the wording. TRC20's anchor (TRX) has no recorded
	// blocker, so it reaches the gate by construction.
	//
	// Both closure causes are covered here on purpose: TRC20 shut by gas, ERC20
	// shut structurally, BTC open. Three rows, three outcomes, nothing dropped.
	const d = setup();
	const asked: string[] = [];
	const rows = await listDepositAddresses({
		deposits: d,
		userId: "u1",
		assets: ["USDT", "BTC"],
		networksFor: (a) => (a === "USDT" ? ["TRC20", "ERC20"] : []),
		gasReady: (_a, net) =>
			net === "TRC20" ? { ok: false, reason: "no TRX float." } : { ok: true },
		provision: async (asset, net) => {
			asked.push(`${asset}/${net ?? "native"}`);
			d.provision({ userId: "u1", asset, network: net, address: `addr-${asset}-${net ?? "native"}`, source: "bitgo" });
		},
	});

	// Every chain appears, in order, open or not.
	assert.deepEqual(rows.map((r) => `${r.asset}/${r.network ?? "native"}`),
		["USDT/TRC20", "USDT/ERC20", "BTC/native"]);

	const trc = rows.find((r) => r.network === "TRC20")!;
	assert.equal(trc.open, false);
	assert.equal(trc.address, null, "never an address for a chain we cannot pay from");
	assert.match(trc.reason ?? "", /no TRX float/);
	assert.match(trc.reason ?? "", /cannot send back/);

	// The structurally blocked rail reports its own cause...
	const erc = rows.find((r) => r.network === "ERC20")!;
	assert.equal(erc.open, false);
	assert.equal(erc.address, null);
	assert.match(erc.reason ?? "", /ETH deposits are not open yet/);

	// ...and was never asked of the custodian. Three doomed requests per page
	// load is what this saves; the assertion is here because the saving is
	// invisible and would be silently lost by a reordering.
	assert.deepEqual(asked, ["BTC/native"]);

	// And the open one was provisioned on sight.
	assert.equal(rows.find((r) => r.asset === "BTC")!.address, "addr-BTC-native");
});

test("ONE CHAIN'S FAILURE DOES NOT EMPTY THE LIST", async () => {
	// A custodian timeout on one chain must not hide an address that already
	// exists on another. The failing chain reports its absence; the rest stand.
	//
	// THE FAILING CHAIN IS DOGE, NOT SOL. SOL has a measured structural blocker
	// now, so the custodian is never called for it and this fixture's throw
	// would never fire — the test would pass vacuously, asserting nothing about
	// error handling. DOGE has no recorded blocker, so the call is really made
	// and really fails, which is the property under test.
	const d = setup();
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q-known", source: "bitgo" });
	const seen: string[] = [];

	const rows = await listDepositAddresses({
		deposits: d,
		userId: "u1",
		assets: ["DOGE", "BTC"],
		networksFor: () => [],
		provision: async (asset) => {
			if (asset === "DOGE") throw new Error("custodian timeout");
			d.provision({ userId: "u1", asset, network: undefined, address: `a-${asset}`, source: "bitgo" });
		},
		onError: (asset, _net, error) => seen.push(`${asset}: ${error}`),
	});

	assert.deepEqual(seen, ["DOGE: custodian timeout"], "the failure is surfaced");
	const failed = rows.find((r) => r.asset === "DOGE")!;
	assert.equal(failed.address, null, "and NOT an invented address");
	assert.equal(failed.open, false);
	// The pre-existing one is untouched and still shown.
	assert.equal(rows.find((r) => r.asset === "BTC")!.address, "bc1q-known");
});

test("an existing address is never re-provisioned", async () => {
	// Replacing an address would orphan coins already on their way to the old
	// one. `Deposits.provision` refuses, but this must not even ask.
	const d = setup();
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q-first", source: "bitgo" });
	let asked = 0;
	const rows = await listDepositAddresses({
		deposits: d,
		userId: "u1",
		assets: ["BTC"],
		networksFor: () => [],
		provision: async () => { asked++; },
	});
	assert.equal(asked, 0, "provision must not be called for an address we hold");
	assert.equal(rows[0]!.address, "bc1q-first");
});

test("one customer's addresses are never another's", async () => {
	const d = setup();
	d.provision({ userId: "u1", asset: "BTC", network: undefined, address: "bc1q-u1", source: "bitgo" });
	const rows = await listDepositAddresses({
		deposits: d,
		userId: "u2",
		assets: ["BTC"],
		networksFor: () => [],
		// No provisioner: u2 has none, and must not be shown u1's.
	});
	assert.equal(rows[0]!.address, null);
	assert.equal(rows[0]!.open, false);
});
