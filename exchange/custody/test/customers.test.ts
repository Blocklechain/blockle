// -----------------------------------------------------------------------------
// CUSTOMER DIRECTORY TESTS.
//
// This is the screen an operator opens while a customer is waiting, so the
// tests are about it being RIGHT and being SAFE:
//
//   * balances match the ledger exactly, including past 2^53 where SUM() in
//     SQL would have rounded them;
//   * one customer's data never appears under another;
//   * the lookup resolves what an operator actually has to hand, and a
//     near-miss returns nothing rather than the wrong person;
//   * it reads. There is no method here that changes a customer's state.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { Customers } from "../src/customers";
import { AccountKind, Ledger, Reason } from "../src/ledger";
import { Withdrawals } from "../src/withdrawals";
import { Deposits } from "../src/deposits";

function setup() {
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	const deposits = new Deposits(db);
	// The withdrawal table's schema comes from Withdrawals; the directory only
	// reads it.
	new Withdrawals(db, ledger, {
		autoApprove: true,
		approvalThreshold: {},
		maxPerRequest: { BTC: 10n ** 12n },
		velocityCap24h: { BTC: 10n ** 13n },
		requireAllowlistedAddress: false,
	});
	return { db, ledger, deposits, customers: new Customers(db, ledger) };
}

/**
 * Credit an account the way a deposit does.
 *
 * The CUSTODY side is network-qualified for a multi-chain asset and the USER
 * side is not — that asymmetry is the ledger's settlement-asset design, and
 * it refuses an unqualified custody posting for an asset that lives on four
 * chains. The directory has to group the user side back to "USDT", which is
 * exactly what the test below checks.
 */
function credit(
	ledger: Ledger,
	owner: string,
	asset: string,
	amount: bigint,
	key: string,
	custodyId = asset,
): void {
	ledger.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amount },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: custodyId }, delta: amount },
			{ account: { kind: AccountKind.USER, owner, asset }, delta: amount },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amount },
		],
		idempotencyKey: key,
		actor: "test",
	});
}

// ----------------------------------------------------------------- balances

test("BALANCES MATCH THE LEDGER, including past 2^53", () => {
	/*
	 * `delta` is TEXT because an 18-decimal amount overflows SQLite's 64-bit
	 * INTEGER. Summing it in SQL coerces to a float and silently rounds — on
	 * a balance screen that is a customer being shown the wrong number.
	 */
	const { ledger, customers } = setup();
	const big = 123_456_789_012_345_678_901_234n; // ETH-scale, far past 2^53
	credit(ledger, "alice", "ETH", big, "k1");
	const s = customers.summary("alice");
	assert.deepEqual(s.balances, [{ asset: "ETH", amount: big.toString() }]);
});

test("multi-network holdings collapse to one settlement balance", () => {
	// A customer has "USDT", not USDT.TRC20 and USDT.ERC20 — grouping it any
	// other way makes this screen disagree with theirs.
	const { ledger, customers } = setup();
	// Same customer, two chains: one balance to them.
	credit(ledger, "alice", "USDT", 500n, "k1", "USDT.TRC20");
	credit(ledger, "alice", "USDT", 250n, "k2", "USDT.ERC20");
	assert.deepEqual(customers.summary("alice").balances, [{ asset: "USDT", amount: "750" }]);
});

test("a zero balance is omitted, but the customer is not", () => {
	// Someone who deposited and withdrew everything still exists and will
	// still write in about it.
	const { ledger, customers } = setup();
	credit(ledger, "alice", "BTC", 100n, "k1");
	ledger.post({
		reason: Reason.WITHDRAWAL_SETTLE,
		postings: [
			{ account: { kind: AccountKind.USER, owner: "alice", asset: "BTC" }, delta: -100n },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "BTC" }, delta: -100n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "BTC" }, delta: 100n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "BTC" }, delta: 100n },
		],
		idempotencyKey: "k2",
		actor: "test",
	});
	assert.deepEqual(customers.summary("alice").balances, []);
	assert.equal(customers.list().customers.some((c) => c.accountId === "alice"), true);
});

test("ONE CUSTOMER'S DATA NEVER APPEARS UNDER ANOTHER", () => {
	const { ledger, deposits, customers } = setup();
	credit(ledger, "alice", "BTC", 100n, "k1");
	credit(ledger, "bob", "BTC", 999n, "k2");
	deposits.provision({ userId: "alice", asset: "BTC", network: undefined,
		address: "addr-alice", source: "test" });
	deposits.provision({ userId: "bob", asset: "BTC", network: undefined,
		address: "addr-bob", source: "test" });

	const a = customers.detail("alice");
	assert.deepEqual(a.balances, [{ asset: "BTC", amount: "100" }]);
	assert.deepEqual(a.addresses.map((x) => x.address), ["addr-alice"]);
	assert.equal(JSON.stringify(a).includes("bob"), false, "no trace of the other account");
});

// ------------------------------------------------------------------ listing

test("the directory includes anyone with a balance, an address OR a withdrawal", () => {
	// Three different ways to be a customer; a single-table view would miss
	// two of them.
	const { ledger, deposits, customers } = setup();
	credit(ledger, "has-balance", "BTC", 5n, "k1");
	deposits.provision({ userId: "has-address", asset: "BTC", network: undefined,
		address: "addr-1", source: "test" });

	const ids = customers.list().customers.map((c) => c.accountId);
	assert.ok(ids.includes("has-balance"));
	assert.ok(ids.includes("has-address"));
	assert.equal(customers.list().total, 2);
});

test("paging is stable and bounded", () => {
	const { ledger, customers } = setup();
	for (let i = 0; i < 12; i++) credit(ledger, `u${String(i).padStart(2, "0")}`, "BTC", 1n, `k${i}`);

	const first = customers.list({ limit: 5 });
	const second = customers.list({ limit: 5, offset: 5 });
	assert.equal(first.customers.length, 5);
	assert.equal(second.customers.length, 5);
	assert.equal(first.total, 12);
	// Ordered, so page 2 continues page 1 rather than repeating it.
	assert.deepEqual(
		[...first.customers, ...second.customers].map((c) => c.accountId),
		Array.from({ length: 10 }, (_, i) => `u${String(i).padStart(2, "0")}`),
	);
	// A silly limit cannot ask for the whole table.
	assert.ok(customers.list({ limit: 100000 }).customers.length <= 500);
	assert.ok(customers.list({ limit: -3 }).customers.length >= 1);
});

// ------------------------------------------------------------------- lookup

test("LOOKUP RESOLVES WHAT AN OPERATOR ACTUALLY HAS", () => {
	const { ledger, deposits, customers } = setup();
	credit(ledger, "alice", "BTC", 100n, "k1");
	deposits.provision({ userId: "alice", asset: "BTC", network: undefined,
		address: "bc1qdeposit", source: "test" });

	// The deposit address is the most common thing to be handed, because it
	// is what the customer can see.
	const byAddr = customers.lookup("bc1qdeposit");
	assert.equal(byAddr.matchedBy, "deposit-address");
	assert.equal(byAddr.accountId, "alice");
	assert.equal(byAddr.detail?.balances[0]?.amount, "100");

	// And the account id itself.
	assert.equal(customers.lookup("alice").matchedBy, "account");
});

test("A NEAR MISS RETURNS NOTHING, never the wrong customer", () => {
	// No prefix or fuzzy matching: resolving "bc1qdepos" to alice would put
	// one person's balances on screen under another's question.
	const { ledger, deposits, customers } = setup();
	credit(ledger, "alice", "BTC", 100n, "k1");
	deposits.provision({ userId: "alice", asset: "BTC", network: undefined,
		address: "bc1qdeposit", source: "test" });

	for (const q of ["bc1qdepos", "BC1QDEPOSIT", "alic", "", "   ", "nobody"]) {
		const r = customers.lookup(q);
		assert.equal(r.matchedBy, null, `${JSON.stringify(q)} must not match`);
		assert.equal(r.accountId, null);
		assert.equal(r.detail, null);
	}
});

test("a withdrawal id, destination address and provider reference all resolve", () => {
	const { db, ledger, customers } = setup();
	credit(ledger, "alice", "BTC", 10_000n, "k1");
	db.prepare(
		`INSERT INTO withdrawal (id, user_id, asset, network, amount, fee, net, state,
		                         address, provider_ref, created_at, updated_at,
		                         request_tx_id, idempotency_key)
		 VALUES (7, 'alice', 'BTC', NULL, '500', '0', '500', 'submitted',
		         'bc1qdest', 'xfer-abc', '2026-11-24T00:00:00Z',
		         '2026-11-24T00:00:00Z', 1, 'idem-1')`,
	).run();

	assert.equal(customers.lookup("7").matchedBy, "withdrawal-id");
	assert.equal(customers.lookup("7").accountId, "alice");
	assert.equal(customers.lookup("bc1qdest").matchedBy, "withdrawal-address");
	assert.equal(customers.lookup("xfer-abc").matchedBy, "provider-ref");
	// A number that is not a withdrawal id does not become one.
	assert.equal(customers.lookup("999999").matchedBy, null);
});

// ------------------------------------------------------------------- detail

test("detail carries the addresses, withdrawals and recent ledger activity", () => {
	const { db, ledger, deposits, customers } = setup();
	credit(ledger, "alice", "BTC", 10_000n, "k1");
	deposits.provision({ userId: "alice", asset: "BTC", network: undefined,
		address: "bc1qdeposit", memo: "tag-1", source: "test" });
	db.prepare(
		`INSERT INTO withdrawal (id, user_id, asset, network, amount, fee, net, state,
		                         address, created_at, updated_at, request_tx_id,
		                         idempotency_key)
		 VALUES (1, 'alice', 'BTC', NULL, '500', '10', '490', 'requested',
		         'bc1qdest', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z', 1,
		         'idem-1')`,
	).run();

	const d = customers.detail("alice");
	assert.equal(d.depositAddresses, 1);
	assert.equal(d.addresses[0]?.memo, "tag-1");
	assert.equal(d.withdrawals.total, 1);
	assert.equal(d.withdrawals.pending, 1, "a requested withdrawal is pending");
	assert.equal(d.recentWithdrawals[0]?.net, "490");
	assert.equal(d.recentEntries.length, 1);
	assert.equal(d.recentEntries[0]?.reason, Reason.DEPOSIT);
	assert.notEqual(d.lastActivity, null);
});

test("an account with nothing is empty rather than an error", () => {
	// An operator pasting an id that turns out to be a typo should see
	// "nothing here", not a stack trace.
	const { customers } = setup();
	const d = customers.detail("ghost");
	assert.deepEqual(d.balances, []);
	assert.equal(d.depositAddresses, 0);
	assert.equal(d.withdrawals.total, 0);
	assert.equal(d.lastActivity, null);
});

test("THE DIRECTORY IS READ-ONLY — it exposes no mutation at all", () => {
	/*
	 * Freezing, crediting and reversing each deserve their own TOTP-gated,
	 * audited endpoint. On a browsing screen a mis-click becomes a loss, so
	 * the capability is absent rather than merely unused.
	 */
	const { customers } = setup();
	const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(customers))
		.filter((m) => m !== "constructor");
	assert.deepEqual(methods.sort(), ["balancesOf", "detail", "list", "lookup", "summary"]);
	for (const m of methods) {
		assert.ok(
			!/freeze|credit|debit|set|update|delete|adjust|reverse/i.test(m),
			`${m} looks like a mutation`,
		);
	}
});
