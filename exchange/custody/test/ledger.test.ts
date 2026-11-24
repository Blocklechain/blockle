// -----------------------------------------------------------------------------
// Tests for the append-only double-entry ledger.
//
// These assert the properties that make the books usable as evidence, and each
// one corresponds to a way real exchanges have lost money or lost track of it:
// a replayed deposit webhook crediting twice, a withdrawal racing its own
// balance check, an unbalanced transaction quietly minting value, and history
// being edited to cover a mistake.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
	AccountKind,
	InsufficientFunds,
	Ledger,
	LedgerError,
	Reason,
	accountId,
	type AccountRef,
} from "../src/ledger";

function fresh(): Ledger {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	return new Ledger(db);
}

const ETH = "ETH";
const user = (id: string, asset = ETH): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});
const custody = (asset = ETH): AccountRef => ({
	kind: AccountKind.CUSTODY,
	owner: "",
	asset,
});
const external = (asset = ETH): AccountRef => ({
	kind: AccountKind.EXTERNAL,
	owner: "",
	asset,
});
const fees = (asset = ETH): AccountRef => ({
	kind: AccountKind.FEES,
	owner: "",
	asset,
});
const inflight = (asset = ETH): AccountRef => ({
	kind: AccountKind.INFLIGHT,
	owner: "",
	asset,
});

/** A deposit as the service will actually write it: external -> custody + user. */
function deposit(l: Ledger, who: string, amount: bigint, chainRef: string) {
	return l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external(), delta: -amount },
			{ account: custody(), delta: amount },
			// The customer's entitlement and the venue's holding both rise; the
			// contra side is the outside world.
			{ account: user(who), delta: amount },
			{ account: external(), delta: -amount },
		],
		idempotencyKey: `deposit:${chainRef}`,
		actor: "bitgo-webhook",
	});
}

test("a deposit credits the customer and the custody account", () => {
	const l = fresh();
	deposit(l, "alice", 10n ** 18n, "eth:0xabc:0");

	assert.equal(l.balance(user("alice")), 10n ** 18n);
	assert.equal(l.balance(custody()), 10n ** 18n);
	// The outside world is correspondingly negative. That is expected and is
	// why EXTERNAL is exempt from the non-negative rule.
	assert.equal(l.balance(external()), -2n * 10n ** 18n);
	assert.deepEqual(l.verify(), { ok: true, transactions: 1 });
});

test("REPLAYING A DEPOSIT WEBHOOK DOES NOT CREDIT TWICE", () => {
	// The failure this prevents: BitGo retries a webhook (which it will, by
	// design, on any non-2xx or timeout) and the customer is credited again.
	const l = fresh();
	const a = deposit(l, "alice", 500n, "eth:0xdead:0");
	const b = deposit(l, "alice", 500n, "eth:0xdead:0");

	assert.equal(a.replayed, false);
	assert.equal(b.replayed, true);
	assert.equal(b.id, a.id, "the replay must return the ORIGINAL transaction");
	assert.equal(l.balance(user("alice")), 500n, "credited once, not twice");
	assert.deepEqual(l.verify(), { ok: true, transactions: 1 });
});

test("idempotency is keyed on the EVENT, so a different deposit still lands", () => {
	const l = fresh();
	deposit(l, "alice", 500n, "eth:0xdead:0");
	deposit(l, "alice", 500n, "eth:0xdead:1"); // same tx, different output index
	assert.equal(l.balance(user("alice")), 1000n);
});

test("an unbalanced transaction is refused — value cannot be minted", () => {
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.DEPOSIT,
				postings: [
					{ account: user("alice"), delta: 100n },
					{ account: external(), delta: -99n }, // off by one
				],
				idempotencyKey: "bad:1",
				actor: "test",
			}),
		/sum to .*not zero/,
	);
	assert.equal(l.balance(user("alice")), 0n, "nothing was written");
	assert.deepEqual(l.verify(), { ok: true, transactions: 0 });
});

test("each asset must balance independently, not just in aggregate", () => {
	// The subtle version of the bug above: the totals cancel across two
	// different assets, which is meaningless — 1 BTC is not 1 ETH.
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.TRADE,
				postings: [
					{ account: user("alice", "ETH"), delta: 100n },
					{ account: user("bob", "BTC"), delta: -100n },
				],
				idempotencyKey: "cross:1",
				actor: "engine",
			}),
		/sum to/,
	);
});

test("a single-posting transaction is refused", () => {
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.ADJUSTMENT,
				postings: [{ account: user("alice"), delta: 100n }],
				idempotencyKey: "single:1",
				actor: "operator:admin",
				note: "n/a",
			}),
		/at least two postings/,
	);
});

test("A USER BALANCE CANNOT GO NEGATIVE", () => {
	const l = fresh();
	deposit(l, "alice", 100n, "eth:0x1:0");

	assert.throws(
		() =>
			l.post({
				reason: Reason.WITHDRAWAL_REQUEST,
				postings: [
					{ account: user("alice"), delta: -101n },
					{ account: inflight(), delta: 101n },
				],
				idempotencyKey: "wd:1",
				actor: "alice",
			}),
		InsufficientFunds,
	);
	assert.equal(l.balance(user("alice")), 100n, "the failed debit wrote nothing");
});

test("the insufficient-funds error carries the numbers a caller needs", () => {
	const l = fresh();
	deposit(l, "alice", 100n, "eth:0x1:0");
	try {
		l.post({
			reason: Reason.WITHDRAWAL_REQUEST,
			postings: [
				{ account: user("alice"), delta: -150n },
				{ account: inflight(), delta: 150n },
			],
			idempotencyKey: "wd:2",
			actor: "alice",
		});
		assert.fail("should have thrown");
	} catch (e) {
		assert.ok(e instanceof InsufficientFunds);
		assert.equal(e.balance, 100n);
		assert.equal(e.requested, 150n);
		assert.equal(e.account, accountId(user("alice")));
	}
});

test("net effect within one transaction is what is checked, not each posting", () => {
	// A trade legitimately debits and credits the same account; only the net
	// may not overdraw. Checking postings individually would reject valid work.
	//
	// Alice nets +50 here while bob nets -50, so bob must actually be able to
	// afford his side — the first draft of this test funded only alice and was
	// correctly rejected for overdrawing bob.
	const l = fresh();
	deposit(l, "alice", 100n, "eth:0x1:0");
	deposit(l, "bob", 100n, "eth:0x2:0");
	l.post({
		reason: Reason.TRADE,
		postings: [
			{ account: user("alice"), delta: -100n },
			{ account: user("alice"), delta: 150n },
			{ account: user("bob"), delta: 100n },
			{ account: user("bob"), delta: -150n },
		],
		idempotencyKey: "trade:net",
		actor: "engine",
	});
	assert.equal(l.balance(user("alice")), 150n);
});

test("the full withdrawal lifecycle conserves value at every step", () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "eth:0x1:0");

	// 1. Debit the user FIRST, into inflight. Debiting before sending is what
	//    stops two concurrent withdrawal requests both passing their checks.
	l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user("alice"), delta: -300n },
			{ account: inflight(), delta: 300n },
		],
		idempotencyKey: "wd:req:7",
		actor: "alice",
	});
	assert.equal(l.balance(user("alice")), 700n);
	assert.equal(l.balance(inflight()), 300n);

	// 2. Settle on confirmation: inflight and custody both fall, the outside
	//    world rises.
	l.post({
		reason: Reason.WITHDRAWAL_SETTLE,
		postings: [
			{ account: inflight(), delta: -300n },
			{ account: external(), delta: 300n },
			{ account: custody(), delta: -300n },
			{ account: external(), delta: 300n },
		],
		idempotencyKey: "wd:settle:7",
		actor: "bitgo-webhook",
	});
	assert.equal(l.balance(inflight()), 0n);
	assert.equal(l.balance(custody()), 700n);
	assert.equal(
		l.balance(user("alice")),
		l.balance(custody()),
		"the books and the holdings agree",
	);
	assert.deepEqual(l.verify(), { ok: true, transactions: 3 });
});

test("a failed withdrawal is reversed by a new entry, not by an edit", () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "eth:0x1:0");
	const req = l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user("alice"), delta: -300n },
			{ account: inflight(), delta: 300n },
		],
		idempotencyKey: "wd:req:9",
		actor: "alice",
	});

	l.reverse(req.id, "operator:ops1", "BitGo rejected: destination screened");

	assert.equal(l.balance(user("alice")), 1000n, "the customer is made whole");
	assert.equal(l.balance(inflight()), 0n);
	// The mistake is still on the record. That is the point.
	assert.equal(l.get(req.id)?.postings.length, 2);
	const correction = l.history(user("alice"))[0];
	assert.equal(correction?.reason, Reason.CORRECTION);
	assert.equal(correction?.note, "BitGo rejected: destination screened");
	assert.deepEqual(l.verify(), { ok: true, transactions: 3 });
});

test("reversing twice is idempotent, not a double refund", () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "eth:0x1:0");
	const req = l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user("alice"), delta: -300n },
			{ account: inflight(), delta: 300n },
		],
		idempotencyKey: "wd:req:11",
		actor: "alice",
	});
	l.reverse(req.id, "operator:ops1", "first");
	const second = l.reverse(req.id, "operator:ops1", "second");
	assert.equal(second.replayed, true, "the correction key is derived from the tx id");
	assert.equal(l.balance(user("alice")), 1000n, "refunded once");
});

test("APPEND-ONLY IS ENFORCED BY THE DATABASE, not by convention", () => {
	// Code can be bypassed by the next person in a hurry; a trigger cannot.
	const db = new Database(":memory:");
	const l = new Ledger(db);
	deposit(l, "alice", 100n, "eth:0x1:0");

	assert.throws(
		() => db.exec(`UPDATE ledger_posting SET delta = '999999'`),
		/append-only/,
	);
	assert.throws(() => db.exec(`DELETE FROM ledger_posting`), /append-only/);
	assert.throws(() => db.exec(`UPDATE ledger_tx SET actor = 'nobody'`), /append-only/);
	assert.throws(() => db.exec(`DELETE FROM ledger_tx`), /append-only/);

	assert.equal(l.balance(user("alice")), 100n);
});

test("verify() detects tampering that got around the triggers", () => {
	// The realistic path: a restored backup, a direct file edit, or a migration
	// that dropped the triggers. The hash chain still catches it.
	const db = new Database(":memory:");
	const l = new Ledger(db);
	deposit(l, "alice", 100n, "eth:0x1:0");
	deposit(l, "bob", 200n, "eth:0x2:0");
	assert.equal(l.verify().ok, true);

	db.exec(`DROP TRIGGER ledger_posting_no_update`);
	db.exec(`UPDATE ledger_posting SET delta = '999999' WHERE account_id = 'user:alice:ETH'`);

	const after = l.verify();
	assert.equal(after.ok, false);
	assert.ok(
		after.ok === false && after.errors.some((e) => /does not match its hash|not zero/.test(e)),
		`expected a tamper finding, got ${JSON.stringify(after.ok === false ? after.errors : [])}`,
	);
});

test("verify() detects a broken hash chain even if each row self-checks", () => {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	deposit(l, "alice", 100n, "eth:0x1:0");
	deposit(l, "bob", 200n, "eth:0x2:0");

	// Excise the first transaction entirely, the way a truncated restore would:
	// the second's prev_hash now points at a transaction that is not there.
	//
	// Its postings have to go first — the foreign key from ledger_posting.tx_id
	// refuses the orphan, which is itself a control worth noting. Both triggers
	// must be dropped to stage this, i.e. the tamper takes deliberate effort.
	db.exec(`DROP TRIGGER ledger_tx_no_delete`);
	db.exec(`DROP TRIGGER ledger_posting_no_delete`);
	db.exec(`DELETE FROM ledger_posting WHERE tx_id = 1`);
	db.exec(`DELETE FROM ledger_tx WHERE id = 1`);

	const after = l.verify();
	assert.equal(after.ok, false);
	assert.ok(after.ok === false && after.errors.some((e) => /breaks the chain/.test(e)));
});

test("an ADJUSTMENT must be explained and attributed", () => {
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.ADJUSTMENT,
				postings: [
					{ account: user("alice"), delta: 100n },
					{ account: external(), delta: -100n },
				],
				idempotencyKey: "adj:1",
				actor: "operator:admin",
			}),
		/must carry a note/,
	);
	assert.throws(
		() =>
			l.post({
				reason: Reason.DEPOSIT,
				postings: [
					{ account: user("alice"), delta: 100n },
					{ account: external(), delta: -100n },
				],
				idempotencyKey: "adj:2",
				actor: "   ",
			}),
		/actor is required/,
	);
});

test("a zero-delta posting is refused as noise", () => {
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.TRADE,
				postings: [
					{ account: user("alice"), delta: 0n },
					{ account: user("bob"), delta: 0n },
				],
				idempotencyKey: "zero:1",
				actor: "engine",
			}),
		/records nothing/,
	);
});

test("a USER posting must name its owner", () => {
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.TRADE,
				postings: [
					{ account: { kind: AccountKind.USER, owner: "", asset: ETH }, delta: 10n },
					{ account: external(), delta: -10n },
				],
				idempotencyKey: "noowner:1",
				actor: "engine",
			}),
		/must name its owner/,
	);
});

test("fees accumulate in their own account and are part of the balance sheet", () => {
	const l = fresh();
	deposit(l, "alice", 10_000n, "eth:0x1:0");
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice"), delta: -10n },
			{ account: fees(), delta: 10n },
		],
		idempotencyKey: "fee:trade:1",
		actor: "engine",
	});

	assert.equal(l.balance(user("alice")), 9_990n);
	assert.equal(l.balance(fees()), 10n);
	// The solvency statement: everything we owe plus everything we earned
	// equals everything we hold.
	assert.equal(
		l.balance(user("alice")) + l.balance(fees()),
		l.balance(custody()),
	);
});

test("balances() totals every account in an asset and hides closed ones", () => {
	const l = fresh();
	deposit(l, "alice", 100n, "eth:0x1:0");
	deposit(l, "bob", 200n, "eth:0x2:0");
	deposit(l, "alice", 50n, "btc:0x3:0" /* still ETH here, just another ref */);

	const b = l.balances(ETH);
	assert.equal(b.get("user:alice:ETH"), 150n);
	assert.equal(b.get("user:bob:ETH"), 200n);
	assert.equal(b.get("custody::ETH"), 350n);

	// An account drained to zero should not clutter the sheet.
	l.post({
		reason: Reason.TRADE,
		postings: [
			{ account: user("bob"), delta: -200n },
			{ account: user("alice"), delta: 200n },
		],
		idempotencyKey: "trade:drain",
		actor: "engine",
	});
	assert.equal(l.balances(ETH).has("user:bob:ETH"), false);
});

test("history explains a balance, newest movement first", () => {
	const l = fresh();
	deposit(l, "alice", 100n, "eth:0x1:0");
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice"), delta: -3n },
			{ account: fees(), delta: 3n },
		],
		idempotencyKey: "fee:1",
		actor: "engine",
	});

	const h = l.history(user("alice"));
	assert.equal(h.length, 2);
	assert.equal(h[0]?.reason, Reason.FEE);
	assert.equal(h[0]?.delta, -3n);
	assert.equal(h[1]?.reason, Reason.DEPOSIT);
	assert.equal(h[1]?.delta, 100n);
	// The movements sum to the balance — the ledger's whole promise.
	assert.equal(
		h.reduce((s, e) => s + e.delta, 0n),
		l.balance(user("alice")),
	);
});

test("18-decimal token amounts survive the round trip through SQLite", () => {
	// SQLite's INTEGER is 64-bit and would overflow here, which is why deltas
	// are stored as TEXT. A silent overflow would corrupt a balance sheet.
	const l = fresh();
	const huge = 123_456_789n * 10n ** 18n; // ~1.2e26, well past 2^63
	deposit(l, "whale", huge, "eth:0xbig:0");
	assert.equal(l.balance(user("whale")), huge);
	assert.equal(l.balance(custody()), huge);
	assert.deepEqual(l.verify(), { ok: true, transactions: 1 });
});

test("reversing an unknown transaction fails loudly", () => {
	const l = fresh();
	assert.throws(() => l.reverse(999, "operator:x", "why"), LedgerError);
});

test("a ledger with thousands of transactions stays internally consistent", () => {
	// Not a benchmark — a property check at a size where an off-by-one in the
	// hash chain or a sign error would have shown up by now.
	const l = fresh();
	for (let i = 0; i < 500; i++) {
		deposit(l, `u${i % 25}`, BigInt(1000 + i), `eth:0x${i}:0`);
	}
	const v = l.verify();
	assert.deepEqual(v, { ok: true, transactions: 500 });

	let owed = 0n;
	for (let i = 0; i < 25; i++) owed += l.balance(user(`u${i}`));
	assert.equal(owed, l.balance(custody()), "customer entitlements equal holdings");
});
