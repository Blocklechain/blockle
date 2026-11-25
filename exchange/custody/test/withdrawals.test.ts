// -----------------------------------------------------------------------------
// Tests for the withdrawal state machine.
//
// This is the only path by which customer funds leave, so the tests are written
// as attacks on it: drain it with concurrent requests, refund twice, cancel
// something already on chain, approve your own withdrawal, send to an
// unscreened address, and lose money to an unjournaled network fee.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { AccountKind, InsufficientFunds, Ledger, Reason, type AccountRef } from "../src/ledger";
import {
	IllegalTransition,
	State,
	WithdrawalError,
	Withdrawals,
	type AddressScreener,
	type Interlock,
	type Policy,
} from "../src/withdrawals";
import { Status, reconcile, type HoldingsSource } from "../src/reconcile";
import type { FeeTable } from "../src/withdrawalfees";

const ETH = "ETH";

const POLICY: Policy = {
	autoApprove: true,
	approvalThreshold: { ETH: 1_000n },
	maxPerRequest: { ETH: 100_000n },
	velocityCap24h: { ETH: 1_000_000n },
	requireAllowlistedAddress: false,
};

/** The manual tier, for the tests that still exercise human approval. */
const MANUAL: Policy = { ...POLICY, autoApprove: false };

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
const inflight = (asset = ETH): AccountRef => ({
	kind: AccountKind.INFLIGHT,
	owner: "",
	asset,
});
const feesAcct = (asset = ETH): AccountRef => ({
	kind: AccountKind.FEES,
	owner: "",
	asset,
});

/*
 * A FEE TABLE THAT CHARGES NOTHING, so that the tests in this file keep
 * testing the state machine rather than the fee arithmetic.
 *
 * Declared `subsidised` because a zero fee is otherwise refused outright (see
 * withdrawalfees.ts) — which is the behaviour we want in production and would
 * be the wrong thing to quietly switch off for a test. Fees have their own
 * suite: withdrawalfees.test.ts.
 */
const FREE: FeeTable = {
	ETH: { gas: 0n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
	XRP: { gas: 0n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
	BTC: { gas: 0n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
};

function setup(
	policy: Policy = POLICY,
	opts: { interlock?: Interlock; now?: () => number } = {},
): { l: Ledger; w: Withdrawals; db: Database.Database } {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	return { l, w: new Withdrawals(db, l, policy, { ...opts, feeTable: FREE }), db };
}

function fund(l: Ledger, who: string, amt: bigint, ref = "0x1"): void {
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external(), delta: -amt },
			{ account: custody(), delta: amt },
			{ account: user(who), delta: amt },
			{ account: external(), delta: -amt },
		],
		idempotencyKey: `deposit:${ref}`,
		actor: "test",
	});
}

const allow: AddressScreener = {
	name: "screener",
	async screen() {
		return { allowed: true };
	},
};
const deny: AddressScreener = {
	name: "screener",
	async screen() {
		return { allowed: false, reason: "OFAC SDN match" };
	},
};

test("THE CUSTOMER IS DEBITED AT REQUEST TIME, BEFORE ANYTHING IS SENT", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);

	const req = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xdest",
		idempotencyKey: "k1",
	});

	assert.equal(req.state, State.REQUESTED);
	assert.equal(l.balance(user("alice")), 4_500n);
	// Not destroyed — moved to INFLIGHT, which is still the venue's liability.
	assert.equal(l.balance(inflight()), 500n);
	assert.equal(l.balance(custody()), 5_000n, "nothing has left custody yet");
});

test("TWO CONCURRENT REQUESTS CANNOT DRAIN THE SAME BALANCE", async () => {
	// The classic exchange drain: both requests read "sufficient funds" and both
	// get paid. Debiting first, inside the ledger's row lock, makes the second
	// fail on arithmetic rather than on a race.
	const { l, w } = setup();
	fund(l, "alice", 1_000n);

	w.request({
		userId: "alice",
		asset: ETH,
		amount: 800n,
		address: "0xa",
		idempotencyKey: "k1",
	});
	assert.throws(
		() =>
			w.request({
				userId: "alice",
				asset: ETH,
				amount: 800n,
				address: "0xb",
				idempotencyKey: "k2",
			}),
		InsufficientFunds,
	);

	assert.equal(l.balance(user("alice")), 200n);
	assert.equal(l.balance(inflight()), 800n, "only the first one reserved funds");
});

test("a resubmitted request is the SAME withdrawal, not a second one", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);

	const a = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xdest",
		idempotencyKey: "same",
	});
	const b = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xdest",
		idempotencyKey: "same",
	});

	assert.equal(b.id, a.id);
	assert.equal(l.balance(user("alice")), 4_500n, "debited once");
});

test("A SUBMITTED WITHDRAWAL CANNOT BE REJECTED", async () => {
	// The single most important edge in the table. Once the custodian has been
	// told to send, the funds may already be on chain; crediting the customer
	// back here pays them twice.
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xdest",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "bitgo-xfer-99", "custody-service");

	assert.throws(
		() => w.reject(r.id, "operator:ops1", "changed my mind"),
		(e: unknown) => {
			assert.ok(e instanceof IllegalTransition);
			assert.match(String(e), /may already be on chain/);
			return true;
		},
	);
	assert.equal(l.balance(user("alice")), 4_500n, "not refunded");
});

test("a terminal withdrawal cannot transition at all", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "ref1", "custody-service");
	w.confirm(r.id, "bitgo-webhook");

	assert.throws(() => w.fail(r.id, "ops", "late failure"), IllegalTransition);
	assert.throws(() => w.markSubmitted(r.id, "ref2", "ops"), IllegalTransition);
});

test("A REJECTION REFUNDS EXACTLY ONCE", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});

	w.reject(r.id, "operator:ops1", "manual review declined");
	assert.equal(l.balance(user("alice")), 5_000n, "made whole");
	assert.equal(l.balance(inflight()), 0n);

	// A second rejection must be a no-op, not a second refund.
	w.reject(r.id, "operator:ops1", "manual review declined");
	assert.equal(l.balance(user("alice")), 5_000n, "refunded once, not twice");
});

test("a failed submission refunds exactly once", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "ref1", "custody-service");

	w.fail(r.id, "bitgo-webhook", "custodian reports the transfer never went out");
	assert.equal(l.balance(user("alice")), 5_000n);
	w.fail(r.id, "bitgo-webhook", "custodian reports the transfer never went out");
	assert.equal(l.balance(user("alice")), 5_000n, "refunded once");
});

test("a rejection or failure must carry a reason", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	assert.throws(() => w.reject(r.id, "ops", "   "), /must carry a reason/);
});

test("A SANCTIONED DESTINATION IS REJECTED AND REFUNDED", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xbad",
		idempotencyKey: "k1",
	});

	const after = await w.screen(r.id, deny);
	assert.equal(after.state, State.REJECTED);
	assert.equal(after.reason, "OFAC SDN match");
	assert.equal(l.balance(user("alice")), 5_000n);
});

test("A SCREENER OUTAGE DOES NOT SILENTLY ALLOW", async () => {
	// "We cannot reach the sanctions provider" must not resolve to "send it".
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});

	const broken: AddressScreener = {
		name: "screener",
		async screen() {
			throw new Error("ETIMEDOUT");
		},
	};
	await assert.rejects(() => w.screen(r.id, broken), /must not be submitted/);

	// Still in screening — not approved, and not punished either.
	assert.equal(w.get(r.id)!.state, State.SCREENING);
	assert.equal(l.balance(user("alice")), 4_500n, "funds stay reserved");
});

test("AN AMOUNT OVER THE THRESHOLD REQUIRES A SECOND HUMAN", async () => {
	// Only under the manual tier; the venue's configured default is automatic.
	const { l, w } = setup(MANUAL);
	fund(l, "alice", 50_000n);

	const small = w.request({
		userId: "alice",
		asset: ETH,
		amount: 999n,
		address: "0xd",
		idempotencyKey: "small",
	});
	assert.equal((await w.screen(small.id, allow)).state, State.APPROVED);

	const big = w.request({
		userId: "alice",
		asset: ETH,
		amount: 1_001n,
		address: "0xd",
		idempotencyKey: "big",
	});
	assert.equal((await w.screen(big.id, allow)).state, State.AWAITING_APPROVAL);
	assert.throws(() => w.markSubmitted(big.id, "ref", "svc"), IllegalTransition);
});

test("AN ASSET WITH NO THRESHOLD CONFIGURED FAILS CLOSED", async () => {
	// A newly-listed asset must not be freely withdrawable because somebody
	// forgot a config entry.
	const { l, w } = setup({ ...MANUAL, approvalThreshold: {} });
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 1n,
		address: "0xd",
		idempotencyKey: "k1",
	});

	const after = await w.screen(r.id, allow);
	assert.equal(after.state, State.AWAITING_APPROVAL, "1 base unit still needs a human");
	assert.match(w.history(r.id).at(-1)!.note!, /none configured — failing closed/);
});

test("AN ASSET WITH NO LIMIT CONFIGURED CANNOT BE WITHDRAWN AT ALL", async () => {
	const { l, w } = setup();
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external("XRP"), delta: -100n },
			{ account: custody("XRP"), delta: 100n },
			{ account: user("alice", "XRP"), delta: 100n },
			{ account: external("XRP"), delta: -100n },
		],
		idempotencyKey: "dep:xrp",
		actor: "test",
	});

	assert.throws(
		() =>
			w.request({
				userId: "alice",
				asset: "XRP",
				amount: 10n,
				address: "rDest",
				idempotencyKey: "k1",
			}),
		/no withdrawal limit configured/,
	);
	assert.equal(l.balance(user("alice", "XRP")), 100n, "nothing was debited");
});

test("the per-request ceiling is enforced", async () => {
	const { l, w } = setup();
	fund(l, "alice", 500_000n);
	assert.throws(
		() =>
			w.request({
				userId: "alice",
				asset: ETH,
				amount: 100_001n,
				address: "0xd",
				idempotencyKey: "k1",
			}),
		/exceeds the ETH per-request limit/,
	);
	assert.equal(l.balance(user("alice")), 500_000n);
});

test("A CUSTOMER CANNOT APPROVE THEIR OWN WITHDRAWAL", async () => {
	// A control the beneficiary can satisfy themselves is not a control.
	// Manual tier, since that is where approval exists at all.
	const { l, w } = setup(MANUAL);
	fund(l, "alice", 50_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 5_000n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);

	assert.throws(() => w.approve(r.id, "alice"), /cannot approve their own withdrawal/);
	assert.throws(() => w.approve(r.id, "  "), /must be named/);
	assert.equal(w.get(r.id)!.state, State.AWAITING_APPROVAL);

	w.approve(r.id, "operator:ops1");
	assert.equal(w.get(r.id)!.approvedBy, "operator:ops1");
});

test("an allowlist, when required, blocks unknown destinations", async () => {
	const { l, w } = setup({ ...POLICY, requireAllowlistedAddress: true });
	fund(l, "alice", 5_000n);

	assert.throws(
		() =>
			w.request({
				userId: "alice",
				asset: ETH,
				amount: 100n,
				address: "0xunknown",
				idempotencyKey: "k1",
			}),
		/not an allowlisted ETH destination/,
	);
	// One customer's allowlist is not another's.
	w.allowlist("alice", ETH, "0xknown");
	assert.equal(w.isAllowlisted("bob", ETH, "0xknown"), false);
	// Nor does it carry across assets.
	assert.equal(w.isAllowlisted("alice", "BTC", "0xknown"), false);
});

test("A FRESHLY ADDED ADDRESS CANNOT BE PAID YET", async () => {
	// THE COOLING-OFF PERIOD IS THE POINT. An allowlist an attacker can add to
	// and draw from in the same minute has cost them one extra request; the
	// delay is what forces a stolen session to stay live long enough for the
	// customer to notice an address they did not add.
	let t = 1_700_000_000_000;
	const { l, w } = setup(
		{ ...POLICY, requireAllowlistedAddress: true },
		{ now: () => t },
	);
	fund(l, "alice", 5_000n);
	w.allowlist("alice", ETH, "0xmine");

	// On the list, and refused anyway.
	assert.equal(w.isAllowlisted("alice", ETH, "0xmine"), true);
	assert.throws(
		() =>
			w.request({
				userId: "alice", asset: ETH, amount: 100n,
				address: "0xmine", idempotencyKey: "k1",
			}),
		/added too recently/,
	);

	// Still refused one minute short of the window.
	t += Withdrawals.ALLOWLIST_COOLDOWN_MS - 60_000;
	assert.throws(
		() =>
			w.request({
				userId: "alice", asset: ETH, amount: 100n,
				address: "0xmine", idempotencyKey: "k2",
			}),
		/added too recently/,
	);

	// And allowed once it matures.
	t += 60_001;
	const ok = w.request({
		userId: "alice", asset: ETH, amount: 100n,
		address: "0xmine", idempotencyKey: "k3",
	});
	assert.equal(ok.state, State.REQUESTED);
});

test("REMOVAL IS IMMEDIATE, because it only narrows what can be paid", async () => {
	// Deliberately asymmetric with adding. A customer who suspects trouble must
	// not have to wait, or find their authenticator, to take an address off.
	let t = 1_700_000_000_000;
	const { l, w } = setup(
		{ ...POLICY, requireAllowlistedAddress: true },
		{ now: () => t },
	);
	fund(l, "alice", 5_000n);
	w.allowlist("alice", ETH, "0xmine");
	t += Withdrawals.ALLOWLIST_COOLDOWN_MS + 1;

	assert.equal(w.removeFromAllowlist("alice", ETH, "0xmine"), true);
	assert.equal(w.removeFromAllowlist("alice", ETH, "0xmine"), false, "idempotent");
	assert.throws(
		() =>
			w.request({
				userId: "alice", asset: ETH, amount: 100n,
				address: "0xmine", idempotencyKey: "k1",
			}),
		/not an allowlisted ETH destination/,
	);
});

test("re-adding a removed address restarts the clock", async () => {
	// Otherwise remove-then-re-add would be a way to skip the delay.
	let t = 1_700_000_000_000;
	const { l, w } = setup(
		{ ...POLICY, requireAllowlistedAddress: true },
		{ now: () => t },
	);
	fund(l, "alice", 5_000n);
	w.allowlist("alice", ETH, "0xmine");
	t += Withdrawals.ALLOWLIST_COOLDOWN_MS + 1;
	w.removeFromAllowlist("alice", ETH, "0xmine");
	w.allowlist("alice", ETH, "0xmine");

	assert.throws(
		() =>
			w.request({
				userId: "alice", asset: ETH, amount: 100n,
				address: "0xmine", idempotencyKey: "k1",
			}),
		/added too recently/,
	);
});

test("the listing says when each address becomes usable", async () => {
	let t = 1_700_000_000_000;
	const { w } = setup({ ...POLICY, requireAllowlistedAddress: true }, { now: () => t });
	w.allowlist("alice", ETH, "0xold");
	t += Withdrawals.ALLOWLIST_COOLDOWN_MS + 1;
	w.allowlist("alice", ETH, "0xnew");

	const rows = w.listAllowlist("alice");
	assert.equal(rows.length, 2);
	const byAddr = new Map(rows.map((r) => [r.address, r]));
	assert.equal(byAddr.get("0xold")!.usable, true);
	assert.equal(byAddr.get("0xnew")!.usable, false);
	// Another customer sees none of it.
	assert.deepEqual(w.listAllowlist("bob"), []);
});

test("submission requires a provider reference", async () => {
	// Without one there is no way to reconcile the transfer later.
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 100n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	assert.throws(() => w.markSubmitted(r.id, "  ", "svc"), /provider reference is required/);
});

test("THE HAPPY PATH SETTLES AND RECONCILES CLEAN", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "bitgo-xfer-1", "custody-service");
	const done = w.confirm(r.id, "bitgo-webhook");

	assert.equal(done.state, State.CONFIRMED);
	assert.equal(l.balance(user("alice")), 4_500n);
	assert.equal(l.balance(inflight()), 0n);
	assert.equal(l.balance(custody()), 4_500n);
	assert.deepEqual(l.verify(), { ok: true, transactions: 3 });

	const source: HoldingsSource = {
		name: "mock",
		async holdings() {
			return 4_500n;
		},
	};
	assert.equal((await reconcile(l, source, [ETH])).assets[0]!.status, Status.OK);
});

test("A JOURNALED NETWORK FEE KEEPS RECONCILIATION CLEAN", async () => {
	// The counterpart to the reconcile test that proves an UNjournaled fee reads
	// as a shortfall. Here the fee is recorded, so the books match reality.
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	// Give the venue fee revenue to absorb the expense from.
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice"), delta: -100n },
			{ account: feesAcct(), delta: 100n },
		],
		idempotencyKey: "fee:trading",
		actor: "engine",
	});

	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "ref1", "custody-service");
	w.confirm(r.id, "bitgo-webhook", 7n);

	// The chain took 500 + 7.
	assert.equal(l.balance(custody()), 5_000n - 507n);
	assert.equal(l.balance(feesAcct()), 93n, "the venue absorbed the fee");
	assert.deepEqual(l.verify().ok, true);

	const source: HoldingsSource = {
		name: "mock",
		async holdings() {
			return 4_493n;
		},
	};
	const rep = await reconcile(l, source, [ETH]);
	assert.equal(rep.assets[0]!.status, Status.OK, rep.assets[0]!.detail);
});

test("a replayed confirmation webhook settles exactly once", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "ref1", "custody-service");

	w.confirm(r.id, "bitgo-webhook");
	w.confirm(r.id, "bitgo-webhook");
	w.confirm(r.id, "bitgo-webhook");

	assert.equal(l.balance(custody()), 4_500n, "custody fell once, not three times");
	assert.equal(l.balance(inflight()), 0n);
});

test("a negative network fee is refused", async () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 500n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "ref1", "svc");
	assert.throws(() => w.confirm(r.id, "svc", -1n), /cannot be negative/);
});

test("a non-positive amount is refused", () => {
	const { l, w } = setup();
	fund(l, "alice", 5_000n);
	for (const amt of [0n, -100n]) {
		assert.throws(
			() =>
				w.request({
					userId: "alice",
					asset: ETH,
					amount: amt,
					address: "0xd",
					idempotencyKey: `k${amt}`,
				}),
			WithdrawalError,
		);
	}
});

test("THE AUDIT TRAIL IS APPEND-ONLY AND COMPLETE, WITH NO HUMAN IN IT", async () => {
	// Withdrawals are automatic, so the trail must show a complete, attributed
	// path with NO operator step — and the attribution must name the mechanism
	// that let it through, so an auditor can see what the control actually was.
	const { l, w, db } = setup();
	fund(l, "alice", 50_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 5_000n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	await w.screen(r.id, allow);
	w.markSubmitted(r.id, "ref1", "custody-service");
	w.confirm(r.id, "bitgo-webhook");

	const h = w.history(r.id);
	assert.deepEqual(
		h.map((e) => e.to),
		[
			State.REQUESTED,
			State.SCREENING,
			State.APPROVED,
			State.SUBMITTED,
			State.CONFIRMED,
		],
		"no awaiting_approval step — nothing waited on a person",
	);
	// Every edge is attributed.
	for (const e of h) assert.ok(e.actor.trim() !== "", `${e.to} had no actor`);

	const approved = h.find((e) => e.to === State.APPROVED)!;
	assert.equal(approved.actor, "policy", "the approver is the policy, not a person");
	// The note records the cap state at the moment it passed, which is the
	// evidence that a control was applied rather than skipped.
	assert.match(approved.note!, /auto-approved/);
	assert.match(approved.note!, /5000\/1000000 of the 24h cap/);
	// And no operator appears anywhere in the trail.
	for (const e of h) assert.doesNotMatch(e.actor, /^operator:/, `${e.to} involved a human`);

	assert.throws(() => db.exec(`UPDATE withdrawal_event SET actor = 'nobody'`), /append-only/);
	assert.throws(() => db.exec(`DELETE FROM withdrawal_event`), /append-only/);
});

test("pending() lists only the in-flight ones", async () => {
	const { l, w } = setup();
	fund(l, "alice", 50_000n);
	const a = w.request({
		userId: "alice",
		asset: ETH,
		amount: 100n,
		address: "0xa",
		idempotencyKey: "a",
	});
	const b = w.request({
		userId: "alice",
		asset: ETH,
		amount: 200n,
		address: "0xb",
		idempotencyKey: "b",
	});
	w.reject(a.id, "ops", "declined");

	assert.deepEqual(
		w.pending().map((x) => x.id),
		[b.id],
	);
});

test("an unknown withdrawal id fails loudly", () => {
	const { w } = setup();
	assert.equal(w.get(9999), undefined);
	assert.throws(() => w.reject(9999, "ops", "x"), /no withdrawal 9999/);
});

test("18-decimal amounts survive the whole lifecycle", async () => {
	const { l, w } = setup({
		...POLICY,
		maxPerRequest: { ETH: 10n ** 30n },
		velocityCap24h: { ETH: 10n ** 30n },
	});
	const big = 123_456_789n * 10n ** 18n + 1n;
	fund(l, "whale", big);

	const r = w.request({
		userId: "whale",
		asset: ETH,
		amount: big,
		address: "0xd",
		idempotencyKey: "k1",
	});
	assert.equal(r.amount, big);
	await w.screen(r.id, allow);
	w.approve(r.id, "operator:ops1");
	w.markSubmitted(r.id, "ref1", "svc");
	w.confirm(r.id, "bitgo-webhook");

	assert.equal(l.balance(user("whale")), 0n);
	assert.equal(l.balance(custody()), 0n);
	assert.deepEqual(l.verify().ok, true);
});

// ---------------------------------------------------------------------------
// AUTOMATIC WITHDRAWALS.
//
// The venue runs with no admin oversight: screening passing sends a withdrawal
// straight to APPROVED. These tests cover what replaces the human approver,
// because "automatic" must not mean "unbounded" — a compromised session would
// otherwise drain the venue at machine speed.
// ---------------------------------------------------------------------------

test("AUTOMATIC: a screened withdrawal needs no human and goes straight through", async () => {
	const { l, w } = setup();
	fund(l, "alice", 50_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 40_000n, // far above the old 1_000 approval threshold
		address: "0xd",
		idempotencyKey: "k1",
	});

	const after = await w.screen(r.id, allow);
	assert.equal(after.state, State.APPROVED, "no awaiting_approval hold");
	assert.equal(after.approvedBy, undefined, "no human approver recorded");

	// And it can be submitted immediately, with no intervening step.
	w.markSubmitted(r.id, "ref1", "custody-service");
	w.confirm(r.id, "bitgo-webhook");
	assert.equal(w.get(r.id)!.state, State.CONFIRMED);
	assert.equal(l.balance(custody()), 10_000n);
});

test("VELOCITY CAP: the rolling 24h total bounds a compromised account", async () => {
	// maxPerRequest alone is trivially defeated by issuing many requests, so
	// this is the control that actually matters once approval is automatic.
	const { l, w } = setup({ ...POLICY, velocityCap24h: { ETH: 1_000n } });
	fund(l, "alice", 50_000n);

	for (const [i, amt] of [400n, 400n].entries()) {
		const r = w.request({
			userId: "alice",
			asset: ETH,
			amount: amt,
			address: "0xd",
			idempotencyKey: `ok${i}`,
		});
		assert.equal((await w.screen(r.id, allow)).state, State.APPROVED);
	}

	// 800 already committed; 400 more would be 1200, over the 1000 cap.
	const over = w.request({
		userId: "alice",
		asset: ETH,
		amount: 400n,
		address: "0xd",
		idempotencyKey: "over",
	});
	const result = await w.screen(over.id, allow);

	// AUTO-REJECTED, not queued for a person.
	assert.equal(result.state, State.REJECTED);
	assert.match(result.reason!, /over the 1000 cap/);
	assert.equal(l.balance(user("alice")), 50_000n - 800n, "the refused one was refunded");
});

test("VELOCITY CAP: the window rolls, so yesterday does not count forever", async () => {
	let clock = Date.parse("2026-11-23T12:00:00Z");
	const { l, w } = setup({ ...POLICY, velocityCap24h: { ETH: 1_000n } }, { now: () => clock });
	fund(l, "alice", 50_000n);

	const first = w.request({
		userId: "alice",
		asset: ETH,
		amount: 900n,
		address: "0xd",
		idempotencyKey: "day1",
	});
	assert.equal((await w.screen(first.id, allow)).state, State.APPROVED);

	// Same day: another 900 would breach.
	const sameDay = w.request({
		userId: "alice",
		asset: ETH,
		amount: 900n,
		address: "0xd",
		idempotencyKey: "same-day",
	});
	assert.equal((await w.screen(sameDay.id, allow)).state, State.REJECTED);

	// 25 hours later the first one has aged out of the window.
	clock += 25 * 60 * 60 * 1000;
	const nextDay = w.request({
		userId: "alice",
		asset: ETH,
		amount: 900n,
		address: "0xd",
		idempotencyKey: "next-day",
	});
	assert.equal((await w.screen(nextDay.id, allow)).state, State.APPROVED);
});

test("VELOCITY CAP: a declined request does not lock the account out", async () => {
	// REJECTED and FAILED withdrawals returned their funds, so counting them
	// would let one refusal cost a customer a day of access to their own money.
	const { l, w } = setup({ ...POLICY, velocityCap24h: { ETH: 1_000n } });
	fund(l, "alice", 50_000n);

	const bad = w.request({
		userId: "alice",
		asset: ETH,
		amount: 900n,
		address: "0xbad",
		idempotencyKey: "sanctioned",
	});
	assert.equal((await w.screen(bad.id, deny)).state, State.REJECTED);

	// The full cap is still available.
	const good = w.request({
		userId: "alice",
		asset: ETH,
		amount: 900n,
		address: "0xgood",
		idempotencyKey: "fine",
	});
	assert.equal((await w.screen(good.id, allow)).state, State.APPROVED);
	assert.equal(l.balance(user("alice")), 50_000n - 900n);
});

test("VELOCITY CAP is per account and per asset, not global", async () => {
	const { l, w } = setup({ ...POLICY, velocityCap24h: { ETH: 1_000n } });
	fund(l, "alice", 50_000n, "0x1");
	fund(l, "bob", 50_000n, "0x2");

	const a = w.request({
		userId: "alice",
		asset: ETH,
		amount: 900n,
		address: "0xd",
		idempotencyKey: "a",
	});
	assert.equal((await w.screen(a.id, allow)).state, State.APPROVED);

	// Alice's usage must not spend Bob's cap.
	const b = w.request({
		userId: "bob",
		asset: ETH,
		amount: 900n,
		address: "0xd",
		idempotencyKey: "b",
	});
	assert.equal((await w.screen(b.id, allow)).state, State.APPROVED);
});

test("AN ASSET WITH NO VELOCITY CAP FAILS CLOSED", async () => {
	// With approval automatic, an unconfigured cap is an unbounded one.
	const { l, w } = setup({ ...POLICY, velocityCap24h: {} });
	fund(l, "alice", 50_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 1n,
		address: "0xd",
		idempotencyKey: "k1",
	});

	const after = await w.screen(r.id, allow);
	assert.equal(after.state, State.REJECTED);
	assert.match(after.reason!, /no 24h velocity cap configured/);
	assert.equal(l.balance(user("alice")), 50_000n, "refunded");
});

test("THE RECONCILIATION INTERLOCK BLOCKS PAYOUTS WHILE SHORT", async () => {
	// Not oversight: no human sets or clears this. The reconciler halts an
	// asset when the books and custody disagree, and paying out while short
	// spends other customers' assets.
	const halted: Interlock = {
		halted: (asset) => asset === ETH,
		reason: () => "SHORTFALL of 600 base units",
	};
	const { l, w } = setup(POLICY, { interlock: halted });
	fund(l, "alice", 50_000n);

	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 100n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	const after = await w.screen(r.id, allow);

	assert.equal(after.state, State.REJECTED);
	assert.match(after.reason!, /withdrawals are halted: SHORTFALL of 600/);
	assert.equal(l.balance(user("alice")), 50_000n, "refunded, not stranded");
	assert.equal(w.history(r.id).at(-1)!.actor, "interlock");
});

test("the interlock is per asset — a halt on one does not stop the others", async () => {
	const halted: Interlock = {
		halted: (asset) => asset === "BTC",
		reason: () => "internal break",
	};
	const { l, w } = setup(POLICY, { interlock: halted });
	fund(l, "alice", 50_000n);

	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 100n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	assert.equal((await w.screen(r.id, allow)).state, State.APPROVED);
});

test("screening still runs BEFORE the automatic approval", async () => {
	// Automatic approval must not mean automatic sending: a sanctioned
	// destination is still refused, with no human involved.
	const { l, w } = setup();
	fund(l, "alice", 50_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 100n,
		address: "0xbad",
		idempotencyKey: "k1",
	});
	const after = await w.screen(r.id, deny);
	assert.equal(after.state, State.REJECTED);
	assert.equal(after.reason, "OFAC SDN match");
	assert.equal(l.balance(user("alice")), 50_000n);
});

test("an unscreened withdrawal can never be submitted", async () => {
	// The one ordering guarantee automation depends on: REQUESTED has no edge
	// to SUBMITTED, so skipping screening is structurally impossible.
	const { l, w } = setup();
	fund(l, "alice", 50_000n);
	const r = w.request({
		userId: "alice",
		asset: ETH,
		amount: 100n,
		address: "0xd",
		idempotencyKey: "k1",
	});
	assert.throws(() => w.markSubmitted(r.id, "ref", "svc"), IllegalTransition);
});

// --------------------------------------------- reserved collateral (audit)

test("A WITHDRAWAL CANNOT SPEND AN OPEN ORDER'S COLLATERAL", () => {
	// Found in the 2026-11-25 audit, and reproduced end to end before fixing.
	//
	// A reservation is not a ledger posting — it is derived from the open-order
	// table — so `ledger.post` only enforces that the TOTAL stays non-negative.
	// A customer with their whole balance committed to a live bid could withdraw
	// all of it, because the ledger saw total - amount = 0 and allowed it.
	//
	// The result was not theft: the matching engine refuses a fill the owner
	// cannot cover and cancels the resting order. It was a FREE SPOOF — post a
	// big bid, withdraw the collateral, and the public book shows depth that
	// costs nothing to abandon and can never be hit.
	const db = new Database(":memory:");
	const l = new Ledger(db);
	fund(l, "alice", 5_000n);
	const w = new Withdrawals(db, l, POLICY, {
		feeTable: FREE,
		reserved: () => 5_000n, // every unit committed to an open order
		requireReservedCheck: true,
	});
	assert.throws(
		() => w.request({
			userId: "alice", asset: ETH, amount: 5_000n,
			address: "0xdest", idempotencyKey: "k1",
		}),
		/available to withdraw/,
	);
	// And nothing was debited on the way to refusing.
	assert.equal(l.balance(user("alice")), 5_000n);
});

test("the unreserved part of a balance is still withdrawable", () => {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	fund(l, "alice", 5_000n);
	const w = new Withdrawals(db, l, POLICY, {
		feeTable: FREE,
		reserved: () => 3_000n, // 3,000 committed, 2,000 free
		requireReservedCheck: true,
	});
	const got = w.request({
		userId: "alice", asset: ETH, amount: 2_000n,
		address: "0xdest", idempotencyKey: "k2",
	});
	assert.equal(got.amount, 2_000n);
	// One unit past available is refused.
	assert.throws(
		() => w.request({
			userId: "alice", asset: ETH, amount: 1n,
			address: "0xdest", idempotencyKey: "k3",
		}),
		/available to withdraw/,
	);
});

test("AN UNWIRED RESERVATION SOURCE REFUSES rather than failing open", () => {
	// The same fail-closed rule as requireGasGate: forgetting to wire this must
	// be a loud refusal, not a silent return to overcommitment.
	const db = new Database(":memory:");
	const l = new Ledger(db);
	fund(l, "alice", 5_000n);
	const w = new Withdrawals(db, l, POLICY, {
		feeTable: FREE,
		requireReservedCheck: true,
	});
	assert.throws(
		() => w.request({
			userId: "alice", asset: ETH, amount: 1n,
			address: "0xdest", idempotencyKey: "k4",
		}),
		/no reservation source is configured/,
	);
});
