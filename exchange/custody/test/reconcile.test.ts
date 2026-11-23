// -----------------------------------------------------------------------------
// Tests for reconciliation.
//
// The cases here are the real incident shapes: a theft, a missed deposit, an
// unjournaled network fee, a custodian outage, and a posting bug. What is being
// asserted is not just detection but the RESPONSE — specifically that a
// shortfall halts withdrawals and a surplus does not, because getting that
// backwards either lets a short venue keep paying out or freezes a solvent one.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
	AccountKind,
	Ledger,
	Reason,
	type AccountRef,
} from "../src/ledger";
import {
	Status,
	formatReport,
	reconcile,
	type HoldingsSource,
} from "../src/reconcile";

const ETH = "ETH";

function fresh(): Ledger {
	return new Ledger(new Database(":memory:"));
}

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

function deposit(l: Ledger, who: string, amt: bigint, ref: string, asset = ETH) {
	return l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external(asset), delta: -amt },
			{ account: custody(asset), delta: amt },
			{ account: user(who, asset), delta: amt },
			{ account: external(asset), delta: -amt },
		],
		idempotencyKey: `deposit:${ref}`,
		actor: "bitgo-webhook",
	});
}

/** A custodian that reports whatever we tell it to. */
function source(
	holdings: Record<string, bigint>,
	opts: { fail?: boolean } = {},
): HoldingsSource {
	return {
		name: "mock",
		async holdings(asset: string): Promise<bigint> {
			if (opts.fail) throw new Error("ETIMEDOUT contacting custodian");
			return holdings[asset] ?? 0n;
		},
	};
}

test("a solvent venue reconciles clean", async () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	deposit(l, "bob", 500n, "0x2");

	const r = await reconcile(l, source({ ETH: 1500n }), [ETH]);

	assert.equal(r.ok, true);
	assert.deepEqual(r.halted, []);
	const a = r.assets[0]!;
	assert.equal(a.status, Status.OK);
	assert.equal(a.liabilities, 1500n);
	assert.equal(a.booksCustody, 1500n);
	assert.equal(a.internalDelta, 0n);
	assert.equal(a.externalDelta, 0n);
	assert.equal(a.haltWithdrawals, false);
});

test("fees and in-flight withdrawals count as liabilities", async () => {
	// A venue whose reconciler forgot either one would read as a surplus and
	// nobody would investigate, because a surplus is the benign case.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice"), delta: -10n },
			{ account: fees(), delta: 10n },
		],
		idempotencyKey: "fee:1",
		actor: "engine",
	});
	l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user("alice"), delta: -200n },
			{ account: inflight(), delta: 200n },
		],
		idempotencyKey: "wd:1",
		actor: "alice",
	});

	const r = await reconcile(l, source({ ETH: 1000n }), [ETH]);
	const a = r.assets[0]!;
	// 790 owed to alice + 10 fees + 200 in flight = 1000, still fully held.
	assert.equal(a.liabilities, 1000n);
	assert.equal(a.status, Status.OK);
});

test("A SHORTFALL HALTS WITHDRAWALS", async () => {
	// The theft case: funds left custody without a corresponding entry.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");

	const r = await reconcile(l, source({ ETH: 400n }), [ETH]);

	assert.equal(r.ok, false);
	assert.deepEqual(r.halted, [ETH]);
	const a = r.assets[0]!;
	assert.equal(a.status, Status.SHORTFALL);
	assert.equal(a.externalDelta, -600n);
	assert.equal(a.haltWithdrawals, true);
	assert.match(a.detail, /SHORTFALL of 600/);
	// The operator needs to know why it halted, not just that it did.
	assert.match(a.detail, /WITHDRAWALS HALTED/);
});

test("a shortfall of ONE base unit still halts — no tolerance is granted", async () => {
	// A tolerance for shortfalls is a configurable amount of unnoticed loss.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");

	const r = await reconcile(l, source({ ETH: 999n }), [ETH], {
		// Even with a generous surplus tolerance set, it must not apply here.
		surplusTolerance: { ETH: 1_000_000n },
	});

	assert.equal(r.assets[0]!.status, Status.SHORTFALL);
	assert.equal(r.assets[0]!.haltWithdrawals, true);
});

test("A SURPLUS DOES NOT HALT WITHDRAWALS", async () => {
	// Usually an uncredited deposit. Halting would punish every other customer
	// for one accounting lag, so the response is to investigate, not to freeze.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");

	const r = await reconcile(l, source({ ETH: 1600n }), [ETH]);

	assert.equal(r.ok, false, "it is still not OK — it needs investigating");
	assert.deepEqual(r.halted, [], "but nothing is frozen");
	const a = r.assets[0]!;
	assert.equal(a.status, Status.SURPLUS);
	assert.equal(a.externalDelta, 600n);
	assert.equal(a.haltWithdrawals, false);
	assert.match(a.detail, /deposit that was never credited/);
});

test("a surplus within tolerance reads as OK", async () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");

	const r = await reconcile(l, source({ ETH: 1005n }), [ETH], {
		surplusTolerance: { ETH: 10n },
	});

	assert.equal(r.ok, true);
	assert.equal(r.assets[0]!.status, Status.OK);
	assert.match(r.assets[0]!.detail, /within the 10 tolerance/);
});

test("a surplus just past tolerance is reported", async () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	const r = await reconcile(l, source({ ETH: 1011n }), [ETH], {
		surplusTolerance: { ETH: 10n },
	});
	assert.equal(r.assets[0]!.status, Status.SURPLUS);
});

test("AN UNJOURNALED NETWORK FEE PRESENTS AS A SHORTFALL — and should", async () => {
	// The most common false alarm, and the reason it is worth naming in the
	// message. The chain took a fee from custody that the books never recorded.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user("alice"), delta: -300n },
			{ account: inflight(), delta: 300n },
		],
		idempotencyKey: "wd:req",
		actor: "alice",
	});
	l.post({
		reason: Reason.WITHDRAWAL_SETTLE,
		postings: [
			{ account: inflight(), delta: -300n },
			{ account: external(), delta: 300n },
			{ account: custody(), delta: -300n },
			{ account: external(), delta: 300n },
		],
		idempotencyKey: "wd:settle",
		actor: "bitgo-webhook",
	});

	// The chain actually took 300 + 7 fee.
	const r = await reconcile(l, source({ ETH: 693n }), [ETH]);
	const a = r.assets[0]!;
	assert.equal(a.status, Status.SHORTFALL);
	assert.equal(a.externalDelta, -7n);
	// The message points at the likely cause so an operator is not left guessing.
	assert.match(a.detail, /network fee/);
	// Clearing it requires fee revenue to absorb the expense from, which is the
	// next test — the ledger will not let an expense come from nowhere.
});

test("absorbing a network fee requires fee revenue to absorb it from", async () => {
	// Follow-on from the case above, stated as its own property: the ledger will
	// not let the venue pay an expense out of nothing, because FEES is a
	// non-negative account. This is a feature — it forces the expense to be
	// funded rather than conjured.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice"), delta: -50n },
			{ account: fees(), delta: 50n },
		],
		idempotencyKey: "fee:trading",
		actor: "engine",
	});
	// Now there is 50 of fee revenue; a 7-unit network fee can be absorbed.
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: fees(), delta: -7n },
			{ account: custody(), delta: -7n },
			{ account: external(), delta: 7n },
			{ account: external(), delta: 7n },
		],
		idempotencyKey: "netfee:1",
		actor: "custody-service",
	});

	// 950 owed to alice + 43 remaining fee revenue = 993 held.
	const r = await reconcile(l, source({ ETH: 993n }), [ETH]);
	assert.equal(r.assets[0]!.status, Status.OK);
	assert.equal(r.assets[0]!.liabilities, 993n);
});

test("AN INTERNAL BREAK IS REPORTED AS A BUG, NOT A CUSTODY PROBLEM", async () => {
	// Staged by posting a user credit against EXTERNAL without the matching
	// custody credit — exactly the shape of a mis-written deposit flow. The
	// books balance per asset (so the ledger accepts it) but the venue now owes
	// more than its custody account claims to hold.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: user("bob"), delta: 500n },
			{ account: external(), delta: -500n },
		],
		idempotencyKey: "deposit:buggy",
		actor: "bad-code",
	});

	const r = await reconcile(l, source({ ETH: 1000n }), [ETH]);

	assert.equal(r.ok, false);
	assert.deepEqual(r.halted, [ETH]);
	const a = r.assets[0]!;
	assert.equal(a.status, Status.INTERNAL_BREAK);
	assert.equal(a.liabilities, 1500n);
	assert.equal(a.booksCustody, 1000n);
	assert.equal(a.internalDelta, -500n);
	assert.equal(a.haltWithdrawals, true);
	// It must say this is OUR bug, or an operator will go hunting at BitGo.
	assert.match(a.detail, /bug in how some flow posts/);
});

test("an internal break takes precedence over the custody comparison", async () => {
	// Even where the custodian happens to match the (wrong) custody account,
	// the internal break must still win: both numbers are untrustworthy.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: user("bob"), delta: 500n },
			{ account: external(), delta: -500n },
		],
		idempotencyKey: "deposit:buggy",
		actor: "bad-code",
	});
	const r = await reconcile(l, source({ ETH: 1000n }), [ETH]);
	assert.equal(r.assets[0]!.status, Status.INTERNAL_BREAK);
});

test("a custodian outage is UNAVAILABLE — not a break, and does not halt", async () => {
	// Claiming OK would hide a real shortfall; halting on every transient API
	// error would make the venue unusable. The honest state is "unverified".
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");

	const r = await reconcile(l, source({}, { fail: true }), [ETH]);

	assert.equal(r.ok, false);
	assert.deepEqual(r.halted, []);
	const a = r.assets[0]!;
	assert.equal(a.status, Status.UNAVAILABLE);
	assert.equal(a.providerHoldings, undefined);
	assert.equal(a.externalDelta, undefined);
	assert.equal(a.internalDelta, 0n, "the books themselves still check out");
	assert.match(a.detail, /UNVERIFIED/);
	assert.match(a.detail, /ETIMEDOUT/, "the cause is carried through");
});

test("assets are judged independently — one break does not halt the others", async () => {
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1", "ETH");
	deposit(l, "alice", 500n, "0x2", "BTC");

	const r = await reconcile(l, source({ ETH: 1000n, BTC: 100n }), ["ETH", "BTC"]);

	const eth = r.assets.find((a) => a.asset === "ETH")!;
	const btc = r.assets.find((a) => a.asset === "BTC")!;
	assert.equal(eth.status, Status.OK);
	assert.equal(btc.status, Status.SHORTFALL);
	assert.deepEqual(r.halted, ["BTC"], "ETH keeps trading");
});

test("an asset with no activity reconciles at zero", async () => {
	const l = fresh();
	const r = await reconcile(l, source({ XRP: 0n }), ["XRP"]);
	assert.equal(r.assets[0]!.status, Status.OK);
	assert.equal(r.assets[0]!.liabilities, 0n);
});

test("an asset with no books but holdings present is a surplus, not a crash", async () => {
	// Realistic: someone sent us an asset we do not list.
	const l = fresh();
	const r = await reconcile(l, source({ XRP: 5000n }), ["XRP"]);
	assert.equal(r.assets[0]!.status, Status.SURPLUS);
	assert.equal(r.assets[0]!.externalDelta, 5000n);
	assert.equal(r.assets[0]!.haltWithdrawals, false);
});

test("18-decimal scale reconciles exactly", async () => {
	// A float-based reconciler would report a phantom break here.
	const l = fresh();
	const big = 123_456_789n * 10n ** 18n + 1n;
	deposit(l, "whale", big, "0xbig");

	const exact = await reconcile(l, source({ ETH: big }), [ETH]);
	assert.equal(exact.assets[0]!.status, Status.OK);

	// One wei missing out of 1.2e26 is still a shortfall.
	const short = await reconcile(l, source({ ETH: big - 1n }), [ETH]);
	assert.equal(short.assets[0]!.status, Status.SHORTFALL);
	assert.equal(short.assets[0]!.externalDelta, -1n);
});

test("formatReport names the halted assets", () => {
	const r = {
		checkedAt: "2026-11-23T00:00:00.000Z",
		ok: false,
		halted: ["BTC"],
		assets: [
			{
				asset: "BTC",
				source: "mock",
				liabilities: 100n,
				booksCustody: 100n,
				providerHoldings: 40n,
				internalDelta: 0n,
				externalDelta: -60n,
				status: Status.SHORTFALL,
				detail: "BTC: SHORTFALL of 60 base units",
				haltWithdrawals: true,
			},
		],
	};
	const s = formatReport(r);
	assert.match(s, /ATTENTION/);
	assert.match(s, /\[SHORTFALL\]/);
	assert.match(s, /WITHDRAWALS HALTED: BTC/);
});

test("reconciliation reads the books before the custodian", async () => {
	// Ordering matters: if a deposit is credited between the two reads, the
	// books are the OLDER number and the race presents as a harmless surplus.
	// Reading the custodian first would turn the same race into a spurious
	// shortfall and freeze withdrawals for no reason.
	const l = fresh();
	deposit(l, "alice", 1000n, "0x1");

	let booksReadFirst = false;
	const racing: HoldingsSource = {
		name: "racing",
		async holdings(): Promise<bigint> {
			// By the time the custodian is asked, the ledger read has happened.
			booksReadFirst = true;
			return 1000n;
		},
	};

	const r = await reconcile(l, racing, [ETH]);
	assert.equal(booksReadFirst, true);
	assert.equal(r.assets[0]!.status, Status.OK);
});
