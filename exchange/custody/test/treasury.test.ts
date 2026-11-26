// -----------------------------------------------------------------------------
// TREASURY VIEW TESTS.
//
// What is being protected here is the operator's ability to believe one number.
// So the assertions are mostly about agreement and about refusal:
//
//   * the per-asset totals match a fixture computed BY HAND, in base units, so
//     a wrong grouping cannot pass by agreeing with its own helper;
//   * the figures equal what reconcile.ts reports over the same ledger — if
//     they can ever differ, the view is the thing that is wrong;
//   * a balance beyond int64 survives the whole path unrounded, because every
//     money column in this service is TEXT precisely so that it can, and
//     SQLite's CAST clamps instead of erroring (venue.ts has the incident);
//   * an asset with nothing in it is PRESENT and zero, never missing;
//   * the drill-down puts no account identifier into any log line;
//   * no fiat figure appears anywhere, for any asset.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ASSETS } from "../src/assets";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import { Status, reconcile, type HoldingsSource } from "../src/reconcile";
import {
	reconcilerStateFrom,
	treasury,
	treasuryHolders,
	type ReconcilerState,
	type ReservationSource,
} from "../src/treasury";

const user = (id: string, asset: string): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});
const custody = (asset: string): AccountRef => ({
	kind: AccountKind.CUSTODY,
	owner: "",
	asset,
});
const external = (asset: string): AccountRef => ({
	kind: AccountKind.EXTERNAL,
	owner: "",
	asset,
});
const feesAcct = (asset: string): AccountRef => ({
	kind: AccountKind.FEES,
	owner: "",
	asset,
});
const inflightAcct = (asset: string): AccountRef => ({
	kind: AccountKind.INFLIGHT,
	owner: "",
	asset,
});

function fresh(): Ledger {
	return new Ledger(new Database(":memory:"));
}

/**
 * A deposit, posted the way the real deposit flow posts it.
 *
 * `custodyId` is separate from `asset` because a multi-network asset's custody
 * posting MUST name a chain while the user's liability must NOT — that
 * asymmetry is the whole reason reconcile.ts matches on the settlement asset,
 * and a fixture that used one id for both would not exercise it.
 */
function deposit(
	l: Ledger,
	who: string,
	amount: bigint,
	ref: string,
	asset: string,
	custodyId = asset,
): void {
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external(custodyId), delta: -amount },
			{ account: custody(custodyId), delta: amount },
			{ account: user(who, asset), delta: amount },
			{ account: external(custodyId), delta: -amount },
		],
		idempotencyKey: `deposit:${ref}`,
		actor: "test",
	});
}

/** Move part of a user's balance into the fee account — a trade's taker fee. */
function chargeFee(
	l: Ledger,
	who: string,
	amount: bigint,
	ref: string,
	asset: string,
): void {
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user(who, asset), delta: -amount },
			{ account: feesAcct(asset), delta: amount },
		],
		idempotencyKey: `fee:${ref}`,
		actor: "test",
	});
}

/** Debit a user and park the amount in INFLIGHT, as a withdrawal request does. */
function requestWithdrawal(
	l: Ledger,
	who: string,
	amount: bigint,
	ref: string,
	asset: string,
): void {
	l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user(who, asset), delta: -amount },
			{ account: inflightAcct(asset), delta: amount },
		],
		idempotencyKey: `wd:${ref}`,
		actor: "test",
	});
}

const NO_RESERVATIONS: ReservationSource = {
	reservationsByAsset: () => ({ byAsset: new Map(), skipped: 0 }),
};

function reservations(
	byAsset: Record<string, Record<string, bigint>>,
	skipped = 0,
): ReservationSource {
	return {
		reservationsByAsset: () => ({
			byAsset: new Map(
				Object.entries(byAsset).map(([asset, per]) => [
					asset,
					new Map(Object.entries(per)),
				]),
			),
			skipped,
		}),
	};
}

const NEVER_RECONCILED: ReconcilerState = {
	halted: {},
	lastPassAt: undefined,
	unavailableReason: "no halt file in this test",
};

// =============================================================================
// THE HAND-COMPUTED FIXTURE
// =============================================================================

test("PER-ASSET TOTALS MATCH A FIXTURE COMPUTED BY HAND", async () => {
	/*
	 * Everything below is in BASE UNITS and worked out on paper, not by
	 * calling the code under test with a different argument. ETH has 18
	 * decimals; these are wei.
	 *
	 *   alice deposits   5_000000000000000000  (5 ETH)
	 *   bob   deposits   3_000000000000000000  (3 ETH)
	 *   alice is charged    200000000000000000  (0.2 ETH) in fees
	 *   bob requests a withdrawal of 1_000000000000000000 (1 ETH)
	 *
	 *   custody          = 5 + 3                  = 8_000000000000000000
	 *   fees             =                          0_200000000000000000
	 *   inflight         =                          1_000000000000000000
	 *   owed to users    = (5 - 0.2) + (3 - 1)     = 6_800000000000000000
	 *   liabilities      = 6.8 + 0.2 + 1          = 8_000000000000000000
	 *   solvency         = 8 - 8                  = 0
	 */
	const l = fresh();
	deposit(l, "alice", 5_000000000000000000n, "a1", "ETH");
	deposit(l, "bob", 3_000000000000000000n, "b1", "ETH");
	chargeFee(l, "alice", 200000000000000000n, "f1", "ETH");
	requestWithdrawal(l, "bob", 1_000000000000000000n, "w1", "ETH");

	const r = await treasury({
		ledger: l,
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
		assets: ["ETH"],
	});
	const eth = r.assets[0]!;

	assert.equal(eth.custodyBase, "8000000000000000000");
	assert.equal(eth.feesBase, "200000000000000000");
	assert.equal(eth.inflightBase, "1000000000000000000");
	assert.equal(eth.owedToCustomersBase, "6800000000000000000");
	assert.equal(eth.liabilitiesBase, "8000000000000000000");
	assert.equal(eth.solvencyBase, "0");
	assert.equal(eth.balanced, true);
	assert.equal(r.booksBalance, true);

	// And the display strings, in the asset's OWN units — never a fiat figure.
	assert.equal(eth.custody, "8");
	assert.equal(eth.fees, "0.2");
	assert.equal(eth.owedToCustomers, "6.8");
	assert.equal(eth.decimals, 18);

	// Two holders, both non-zero; nobody overcommitted.
	assert.equal(eth.holders, 2);
	assert.equal(eth.overcommitted, 0);
});

test("the three liability parts always add back up to the reconciled total", async () => {
	// The displayed split is a SUBTRACTION from the reconciled lump precisely
	// so this identity cannot be broken by a fourth query drifting. Asserted
	// anyway: an identity nobody checks is an assumption.
	const l = fresh();
	deposit(l, "alice", 7n, "a1", "BTC");
	chargeFee(l, "alice", 2n, "f1", "BTC");
	requestWithdrawal(l, "alice", 3n, "w1", "BTC");

	const r = await treasury({
		ledger: l,
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
		assets: ["BTC"],
	});
	const a = r.assets[0]!;
	assert.equal(
		BigInt(a.owedToCustomersBase) + BigInt(a.feesBase) + BigInt(a.inflightBase),
		BigInt(a.liabilitiesBase),
	);
});

// =============================================================================
// AGREEMENT WITH THE RECONCILER
// =============================================================================

/** A custodian that reports whatever we tell it to — same shape as reconcile's. */
function source(holdings: Record<string, bigint>): HoldingsSource {
	return {
		name: "mock",
		holdings: (asset: string) => Promise.resolve(holdings[asset] ?? 0n),
	};
}

test("THE VIEW'S FIGURES ARE THE RECONCILER'S FIGURES", async () => {
	/*
	 * The one assertion this whole module exists to make true. If a treasury
	 * total can differ from what reconcile.ts reports over the same ledger,
	 * then on the day they differ an operator has two numbers and no way to
	 * choose, and the practical outcome is that they trust neither.
	 *
	 * Multi-network USDT on purpose: custody is posted as USDT.TRC20 and
	 * USDT.ERC20 while the liability is plain USDT. The first version of
	 * reconcile.ts walked `balances(asset)`, matched the asset column exactly,
	 * found the liabilities and none of the holdings, and would have halted
	 * USDT withdrawals forever. A view that re-derived custody with the naive
	 * query would reproduce that bug in a new place.
	 */
	const l = fresh();
	deposit(l, "alice", 150_000000n, "t1", "USDT", "USDT.TRC20");
	deposit(l, "bob", 300_000000n, "e1", "USDT", "USDT.ERC20");
	chargeFee(l, "alice", 1_000000n, "f1", "USDT");

	const view = await treasury({
		ledger: l,
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
		assets: ["USDT"],
	});
	const rec = await reconcile(l, source({ USDT: 450_000000n }), ["USDT"]);

	const v = view.assets[0]!;
	const c = rec.assets[0]!;
	assert.equal(v.custodyBase, c.booksCustody.toString());
	assert.equal(v.liabilitiesBase, c.liabilities.toString());
	assert.equal(v.solvencyBase, c.internalDelta.toString());
	assert.equal(c.status, Status.OK, "the reconciler is happy with this ledger");
	assert.equal(v.balanced, true);

	// The per-network breakdown must sum to the custody total it sits under.
	assert.equal(v.perNetwork.length, 2);
	let sum = 0n;
	for (const n of v.perNetwork) sum += BigInt(n.heldBase);
	assert.equal(sum.toString(), v.custodyBase);
	assert.deepEqual(
		v.perNetwork.map((n) => n.network).sort(),
		["ERC20", "TRC20"],
	);
});

test("A POSTING BUG SHOWS AS A NON-ZERO SOLVENCY FIGURE AND THE RECONCILER'S OWN WORDS", async () => {
	// Books that do not add up: custody credited without a matching liability.
	// This is the condition reconcile.ts halts withdrawals on, and the figure
	// the console puts in its largest type.
	const l = fresh();
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external("BTC"), delta: -500n },
			{ account: custody("BTC"), delta: 500n },
		],
		idempotencyKey: "orphan-custody",
		actor: "test",
	});

	const r = await treasury({
		ledger: l,
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
		assets: ["BTC"],
	});
	const btc = r.assets[0]!;
	assert.equal(btc.solvencyBase, "500");
	assert.equal(btc.balanced, false);
	assert.equal(btc.status, Status.INTERNAL_BREAK);
	assert.equal(r.booksBalance, false);
	assert.deepEqual(r.unbalanced, ["BTC"]);
	// Passed through verbatim from reconcile.ts rather than paraphrased, so
	// the console and the reconcile log say the same thing.
	assert.match(btc.detail, /the books do not add up/);
	assert.match(btc.detail, /Withdrawals halted/);
});

// =============================================================================
// BIGINT INTEGRITY
// =============================================================================

test("A BALANCE BEYOND INT64 SURVIVES THE WHOLE PATH INTACT", async () => {
	/*
	 * 9223372036854775807 is int64 max. SQLite's CAST does not error past it,
	 * it CLAMPS: `CAST('9300000000000000000' AS INTEGER)` and
	 * `CAST('9500000000000000000' AS INTEGER)` are both int64 max and compare
	 * EQUAL. That has already cost this project a wrong number — the order
	 * book's depth aggregation summed a price level with more than ~9.2 ETH in
	 * it to the clamp and published it (see the header of venue.ts).
	 *
	 * ~9.2 ETH in wei is where the boundary sits, which is one ordinary
	 * balance, so this is not a theoretical edge. Two holders are seeded
	 * ABOVE the boundary and their sum is far above it: if anything on the
	 * path — a SQL SUM, a Number(), a JSON.parse of a bare numeric literal —
	 * rounds, these assertions fail.
	 */
	const INT64_MAX = 9223372036854775807n;
	// Annotated `bigint` rather than left as literal types: TypeScript
	// narrows a bigint literal to itself and then rejects `A !== B` as a
	// comparison with no overlap — which would delete the assertion that
	// these two are distinct, i.e. the exact thing SQLite's clamp destroys.
	const A: bigint = 9_300000000000000000n; // just over int64 max
	const B: bigint = 9_500000000000000000n; // also over, and distinct from A
	assert.ok(A > INT64_MAX && B > INT64_MAX && A !== B);

	const l = fresh();
	deposit(l, "whale", A, "w1", "ETH");
	deposit(l, "orca", B, "w2", "ETH");

	const r = await treasury({
		ledger: l,
		reservations: reservations({ ETH: { whale: 1_000000000000000000n } }),
		reconciler: NEVER_RECONCILED,
		assets: ["ETH"],
	});
	const eth = r.assets[0]!;

	// Exact, to the wei, on a total that is more than double int64 max.
	assert.equal(eth.custodyBase, (A + B).toString());
	assert.equal(eth.custodyBase, "18800000000000000000");
	assert.equal(eth.owedToCustomersBase, "18800000000000000000");
	assert.equal(eth.solvencyBase, "0");
	// And the displayed string is still exact rather than 1.88e19.
	assert.equal(eth.custody, "18.8");

	// It survives the JSON round trip the browser will do, because every
	// money field is a STRING. A bare numeric literal of this size is
	// irrecoverably rounded by JSON.parse before any code of ours sees it.
	const roundTripped = JSON.parse(JSON.stringify(eth)) as typeof eth;
	assert.equal(roundTripped.custodyBase, "18800000000000000000");

	// Drill-down: the two large balances stay distinct and in the right order,
	// which a Number-based sort comparator could not guarantee.
	const d = treasuryHolders({
		ledger: l,
		reservations: reservations({ ETH: { whale: 1_000000000000000000n } }),
		asset: "ETH",
	});
	assert.deepEqual(
		d.holders.map((h) => [h.accountId, h.balanceBase]),
		[
			["orca", B.toString()],
			["whale", A.toString()],
		],
	);
	assert.equal(d.holders[1]!.reservedBase, "1000000000000000000");
	assert.equal(d.holders[1]!.availableBase, "8300000000000000000");
	assert.equal(d.sumOfHoldersBase, (A + B).toString());
	assert.equal(d.agrees, true);
});

// =============================================================================
// ZERO IS VISIBLE, NOT ABSENT
// =============================================================================

test("AN ASSET WITH NOTHING IN IT IS PRESENT AND ZERO, NOT MISSING", async () => {
	/*
	 * The reconcile job filters its asset list down to assets with a non-zero
	 * position, and on a flat ledger that filter selects NOTHING — which is
	 * the live state of this deployment. Inheriting that filter here would
	 * render an empty table on the solvency screen of a venue that is live,
	 * and an empty table is the worst available way to say "nothing is wrong".
	 *
	 * An operator needs to be able to see that a rail is empty. A rail that is
	 * absent reads as a rail that was forgotten.
	 */
	const r = await treasury({
		ledger: fresh(),
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
	});

	assert.equal(
		r.assets.length,
		Object.keys(ASSETS).length,
		"every registry asset gets a row, including the empty ones",
	);
	for (const a of r.assets) {
		assert.equal(a.custodyBase, "0", a.asset);
		assert.equal(a.owedToCustomersBase, "0", a.asset);
		assert.equal(a.feesBase, "0", a.asset);
		assert.equal(a.reservedBase, "0", a.asset);
		assert.equal(a.solvencyBase, "0", a.asset);
		assert.equal(a.holders, 0, a.asset);
	}
	assert.equal(r.booksBalance, true);
	// BLOCK and the BLOCK-20 rails are in the table like anything else.
	assert.ok(r.assets.some((a) => a.asset === "BLOCK"));
});

test("an empty halt set is reported as UNVERIFIED, not as verified", async () => {
	// A vacuously green reconciliation must not render as a clean bill of
	// health. The halt file names only what it halted, so "absent from it"
	// conflates "checked and fine" with "never looked at".
	const r = await treasury({
		ledger: fresh(),
		reservations: NO_RESERVATIONS,
		reconciler: { halted: {}, lastPassAt: "2026-11-25T12:00:00.000Z", unavailableReason: undefined },
		assets: ["BTC"],
	});
	const btc = r.assets[0]!;
	assert.equal(btc.halted, false);
	assert.equal(btc.externallyVerified, false);
	assert.match(btc.externalNote, /NOT the same as verified/);
	assert.equal(r.lastPassAt, "2026-11-25T12:00:00.000Z");
	assert.ok(
		r.caveats.some((c) => /does not read a custodian/i.test(c)),
		"the payload says plainly that no custodian was read",
	);
});

test("a halted asset carries the reconciler's own reason", async () => {
	const r = await treasury({
		ledger: fresh(),
		reservations: NO_RESERVATIONS,
		reconciler: {
			halted: { BTC: "BTC: SHORTFALL of 500 base units — the books say ..." },
			lastPassAt: "2026-11-25T12:00:00.000Z",
			unavailableReason: undefined,
		},
		assets: ["BTC", "ETH"],
	});
	assert.deepEqual(r.halted, ["BTC"]);
	const btc = r.assets.find((a) => a.asset === "BTC")!;
	assert.equal(btc.halted, true);
	assert.match(btc.haltReason, /SHORTFALL of 500/);
	assert.equal(btc.externallyVerified, true);
	assert.equal(r.assets.find((a) => a.asset === "ETH")!.halted, false);
});

test("an unreadable halt file is a stated unknown, not silence", async () => {
	// publicapi's haltsFrom() falls back to NOTHING_HALTED on any error, which
	// is the right bias for the withdrawal path and the wrong one here: it
	// would render "nothing halted" identically whether a pass had just
	// succeeded or the file had never existed.
	const s = reconcilerStateFrom(join(tmpdir(), "definitely-not-a-halt-file.json"));
	assert.deepEqual(s.halted, {});
	assert.equal(s.lastPassAt, undefined);
	assert.ok(s.unavailableReason !== undefined);

	const r = await treasury({
		ledger: fresh(),
		reservations: NO_RESERVATIONS,
		reconciler: s,
		assets: ["BTC"],
	});
	assert.ok(r.reconcilerUnavailable !== undefined);
	assert.ok(r.caveats.some((c) => /means 'unknown', not 'clear'/.test(c)));
});

test("a real halt file is read, and its mtime dates the pass", async () => {
	const dir = mkdtempSync(join(tmpdir(), "treasury-halts-"));
	const p = join(dir, "exchange-halts.json");
	writeFileSync(p, JSON.stringify({ BTC: "BTC: SHORTFALL of 7" }));
	const s = reconcilerStateFrom(p);
	assert.equal(s.halted.BTC, "BTC: SHORTFALL of 7");
	assert.equal(s.unavailableReason, undefined);
	assert.match(String(s.lastPassAt), /^\d{4}-\d\d-\d\dT/);
});

// =============================================================================
// RESERVED AND AVAILABLE
// =============================================================================

test("reserved is totalled per asset and attributed per account", async () => {
	const l = fresh();
	deposit(l, "alice", 10_00000000n, "a1", "BTC");
	deposit(l, "bob", 4_00000000n, "b1", "BTC");

	const res = reservations({ BTC: { alice: 3_00000000n, bob: 1_00000000n } });
	const r = await treasury({
		ledger: l,
		reservations: res,
		reconciler: NEVER_RECONCILED,
		assets: ["BTC"],
	});
	assert.equal(r.assets[0]!.reservedBase, "400000000");

	const d = treasuryHolders({ ledger: l, reservations: res, asset: "BTC" });
	const alice = d.holders.find((h) => h.accountId === "alice")!;
	assert.equal(alice.balanceBase, "1000000000");
	assert.equal(alice.reservedBase, "300000000");
	assert.equal(alice.availableBase, "700000000");
	assert.equal(alice.balance, "10");
	assert.equal(alice.available, "7");
	assert.equal(alice.overcommitted, false);
});

test("AN OVERCOMMITTED ACCOUNT IS FLAGGED AND SORTS FIRST, NOT CLAMPED AWAY", async () => {
	/*
	 * Venue.balances clamps `available` at zero because a negative number
	 * shown to a CUSTOMER is alarming without being actionable. For an
	 * operator the clamp is the bug-concealer: a negative available is exactly
	 * the signature of an account resting more than it holds, which is the
	 * failure that once let one account brick a market with one BTC.
	 *
	 * It also has to sort to the top. A single flagged row buried under a page
	 * of larger balances is a flag nobody sees.
	 */
	const l = fresh();
	deposit(l, "whale", 100_00000000n, "w1", "BTC");
	deposit(l, "tiny", 1n, "t1", "BTC");

	const d = treasuryHolders({
		ledger: l,
		reservations: reservations({ BTC: { tiny: 5n } }),
		asset: "BTC",
	});
	assert.equal(d.holders[0]!.accountId, "tiny", "the finding sorts first");
	assert.equal(d.holders[0]!.overcommitted, true);
	assert.equal(d.holders[0]!.availableBase, "-4", "negative, not clamped to 0");
	assert.equal(d.overcommitted, 1);
});

test("an account at zero that still has funds reserved is not dropped", async () => {
	// Ledger.balances() deletes zero entries, which is right for a customer's
	// own screen and is exactly how this finding would stay invisible.
	const l = fresh();
	deposit(l, "alice", 5n, "a1", "BTC");
	requestWithdrawal(l, "alice", 5n, "w1", "BTC");

	const d = treasuryHolders({
		ledger: l,
		reservations: reservations({ BTC: { alice: 2n } }),
		asset: "BTC",
	});
	const alice = d.holders.find((h) => h.accountId === "alice");
	assert.ok(alice !== undefined, "a zero balance is still a row");
	assert.equal(alice.balanceBase, "0");
	assert.equal(alice.reservedBase, "2");
	assert.equal(alice.overcommitted, true);
});

test("an open order on an unlisted market is reported, not swallowed", async () => {
	// Such an order's claim cannot be priced, so reserved is UNDERSTATED by
	// whatever it holds — and the customer-facing available balance is
	// overstated by the same amount. That is a finding, not a detail.
	const r = await treasury({
		ledger: fresh(),
		reservations: reservations({}, 3),
		reconciler: NEVER_RECONCILED,
		assets: ["BTC"],
	});
	assert.equal(r.unpricedOpenOrders, 3);
	assert.ok(r.caveats.some((c) => /RESERVED is understated/.test(c)));
});

// =============================================================================
// THE DRILL-DOWN'S OWN INVARIANT, PAGING, AND REFUSALS
// =============================================================================

test("the sum of the named holders equals the asset's owed-to-customers", async () => {
	// The one thing a drill-down is for: that the names add up to the total
	// above them. Both come from the same postings through different
	// groupings, so a mismatch is a real finding and not a rounding artefact.
	const l = fresh();
	deposit(l, "alice", 500n, "a1", "BTC");
	deposit(l, "bob", 250n, "b1", "BTC");
	chargeFee(l, "alice", 10n, "f1", "BTC");
	requestWithdrawal(l, "bob", 50n, "w1", "BTC");

	const view = await treasury({
		ledger: l,
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
		assets: ["BTC"],
	});
	const d = treasuryHolders({ ledger: l, reservations: NO_RESERVATIONS, asset: "BTC" });

	assert.equal(d.sumOfHoldersBase, "690"); // 490 + 200
	assert.equal(d.owedToCustomersBase, view.assets[0]!.owedToCustomersBase);
	assert.equal(d.agrees, true);
});

test("the drill-down pages, and its limit is clamped rather than trusted", async () => {
	// GET /admin/api/customers accepts ?limit= guarded by Number.isFinite
	// alone, so one request can dump the whole directory. This is the newer
	// endpoint and does not copy that.
	const l = fresh();
	for (let i = 0; i < 12; i++) deposit(l, `u${i}`, BigInt(100 - i), `d${i}`, "BTC");

	const page = treasuryHolders({
		ledger: l,
		reservations: NO_RESERVATIONS,
		asset: "BTC",
		limit: 5,
		offset: 5,
	});
	assert.equal(page.total, 12);
	assert.equal(page.holders.length, 5);
	assert.equal(page.limit, 5);
	assert.equal(page.offset, 5);
	// The whole-set sum, not the page's — otherwise the agreement check would
	// fail on every page but the only one that fits.
	assert.equal(page.agrees, true);

	const capped = treasuryHolders({
		ledger: l,
		reservations: NO_RESERVATIONS,
		asset: "BTC",
		limit: 10_000_000,
	});
	assert.equal(capped.limit, 500);

	const nonsense = treasuryHolders({
		ledger: l,
		reservations: NO_RESERVATIONS,
		asset: "BTC",
		limit: Number.NaN,
		offset: -40,
	});
	assert.equal(nonsense.limit, 1, "NaN falls to the floor, never to unbounded");
	assert.equal(nonsense.offset, 0);
});

test("the drill-down accepts a network-qualified asset and groups it", async () => {
	// A customer's USDT is one balance to them whether it arrived over Tron or
	// Ethereum, which is the level the ledger's invariant is stated at.
	const l = fresh();
	deposit(l, "alice", 150_000000n, "t1", "USDT", "USDT.TRC20");
	deposit(l, "alice", 300_000000n, "e1", "USDT", "USDT.ERC20");

	const d = treasuryHolders({
		ledger: l,
		reservations: NO_RESERVATIONS,
		asset: "usdt.trc20",
	});
	assert.equal(d.asset, "USDT");
	assert.equal(d.holders.length, 1);
	assert.equal(d.holders[0]!.balanceBase, "450000000");
	assert.equal(d.holders[0]!.balance, "450");
});

test("an unknown asset is refused, and the message names only the asset", async () => {
	assert.throws(
		() =>
			treasuryHolders({
				ledger: fresh(),
				reservations: NO_RESERVATIONS,
				asset: "NOTACOIN",
			}),
		/unknown asset NOTACOIN/,
	);
});

// =============================================================================
// NO CUSTOMER IDENTIFIER IN A LOG LINE
// =============================================================================

test("THE DRILL-DOWN NEVER APPEARS IN A LOG LINE", async () => {
	/*
	 * An account identifier that reaches a log line has left the
	 * access-controlled surface for one with different retention and
	 * different readers. There are existing log lines in this service that
	 * print a raw account id — publicapi.ts does it on the deposit-address
	 * routes — so this is not a mistake nobody would make here; it is one
	 * already made next door.
	 *
	 * Every console method is captured, not just `log`: a `console.error` on a
	 * failure path leaks exactly as much as a `console.log` on a happy one,
	 * and systemd captures both into the journal identically.
	 */
	const SECRET_ID = "acct_zzz_very_distinctive_customer_9f3a2b";
	const l = fresh();
	deposit(l, SECRET_ID, 9_300000000000000000n, "s1", "ETH");
	deposit(l, "acct_other", 5n, "s2", "ETH");

	const captured: string[] = [];
	const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
	const saved = methods.map((m) => console[m]);
	for (const m of methods) {
		console[m] = (...args: unknown[]): void => {
			captured.push(args.map((a) => String(a)).join(" "));
		};
	}
	try {
		const res = reservations({ ETH: { [SECRET_ID]: 1n } });
		const view = await treasury({
			ledger: l,
			reservations: res,
			reconciler: NEVER_RECONCILED,
			assets: ["ETH"],
		});
		const d = treasuryHolders({ ledger: l, reservations: res, asset: "ETH" });

		// The data really was read — otherwise "nothing was logged" would be
		// trivially true of a function that did nothing.
		assert.ok(d.holders.some((h) => h.accountId === SECRET_ID));
		assert.equal(view.assets[0]!.holders, 2);

		// And the failure path logs nothing either.
		assert.throws(() =>
			treasuryHolders({ ledger: l, reservations: res, asset: "NOTACOIN" }),
		);
	} finally {
		methods.forEach((m, i) => {
			console[m] = saved[i]!;
		});
	}

	assert.deepEqual(
		captured,
		[],
		`the treasury view wrote to the console: ${captured.join(" | ")}`,
	);
});

// =============================================================================
// NO FIAT, EVER
// =============================================================================

test("NO FIAT FIGURE APPEARS ANYWHERE IN THE PAYLOAD", async () => {
	/*
	 * The hard product rule: never render a USD price for BLOCK or any
	 * BLOCK-20 token, INCLUDING VIA CONVERSION. The existing
	 * /admin/api/revenue route launders one in by passing its report through
	 * estimateTotal(..., "USDT") — USDT is a dollar stablecoin, so BLOCK fee
	 * revenue priced off the live BLOCK-USDT book becomes a dollar figure for
	 * BLOCK. Nothing on this path imports a rate source at all, and this test
	 * is what keeps it that way: a future edit that adds a converted column
	 * has to delete an assertion to do it.
	 */
	const l = fresh();
	deposit(l, "alice", 1000_00000000n, "b1", "BLOCK");
	chargeFee(l, "alice", 10_00000000n, "f1", "BLOCK");

	const r = await treasury({
		ledger: l,
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
	});
	const payload = JSON.stringify(r);

	assert.doesNotMatch(payload, /\$/, "no dollar sign anywhere in the payload");
	assert.doesNotMatch(payload, /\bUSD\b/, "no USD denomination anywhere");

	/*
	 * EXACT FIELD NAMES, NOT SUBSTRINGS, and the reason is worth recording
	 * because the first version of this assertion failed on a passing
	 * payload: `"[a-zA-Z]*rate[a-zA-Z]*":` matches `"generatedAt":`, because
	 * "generated" contains "rate". A guard that cries wolf on a correct
	 * payload gets deleted by whoever hits it next, and then the real rule is
	 * unguarded.
	 */
	const keys = new Set<string>();
	JSON.parse(payload, (k) => {
		if (k !== "") keys.add(k);
		return undefined;
	});
	for (const forbidden of [
		"usd",
		"usdValue",
		"fiat",
		"currency",
		"rate",
		"rates",
		"rateSource",
		"price",
		"pricedAt",
		"total",
		"estimate",
		"estimatedTotal",
	]) {
		assert.ok(
			!keys.has(forbidden),
			`the payload carries a "${forbidden}" field; this view must have no ` +
				"denomination other than each asset's own units",
		);
	}

	const block = r.assets.find((a) => a.asset === "BLOCK")!;
	assert.equal(block.custody, "1000", "BLOCK is shown in BLOCK");
	assert.equal(block.fees, "10");
	assert.equal(block.owedToCustomers, "990");
});

// =============================================================================
// THE CONTRACT WITH THE OPERATOR CONSOLE
// =============================================================================

test("THE PAYLOAD CARRIES EVERY FIELD admin.inline.js READS", async () => {
	/*
	 * deploy/exchange/frontpage/admin.inline.js is hand-written, has no build
	 * step and is deployed separately from this service by
	 * deploy/exchange/ship-frontpage.sh. So nothing links the two: rename a
	 * field here and the console renders `undefined` — or, worse for the one
	 * field that matters, treats a missing `solvencyBase` as not-the-string-"0"
	 * and paints a healthy venue red, or reads a missing `balanced` as falsy
	 * and announces that the books do not add up.
	 *
	 * This list is therefore the contract, written down. It is not a schema
	 * exported from anywhere, because the console cannot import one; it is a
	 * test that fails loudly in CI the moment the two drift.
	 */
	const r = await treasury({
		ledger: fresh(),
		reservations: NO_RESERVATIONS,
		reconciler: NEVER_RECONCILED,
		assets: ["BTC"],
	});

	for (const k of [
		"assets",
		"generatedAt",
		"caveats",
		"halted",
		"lastPassAt",
		"reconcilerUnavailable",
	]) {
		assert.ok(k in r, `the report must carry "${k}"`);
	}
	for (const k of [
		"asset",
		"balanced",
		"custody",
		"owedToCustomers",
		"fees",
		"inflight",
		"reserved",
		"solvency",
		// The one the console tests for zero-ness. A FORMATTED figure could
		// round a tiny real break to "0" and paint it green, so the console
		// compares this base-unit string instead — which makes its presence
		// load-bearing rather than merely convenient.
		"solvencyBase",
		"holders",
		"overcommitted",
		"halted",
		"haltReason",
		"externallyVerified",
		"externalNote",
	]) {
		assert.ok(k in r.assets[0]!, `an asset row must carry "${k}"`);
	}

	const l = fresh();
	deposit(l, "alice", 7n, "a1", "BTC");
	const d = treasuryHolders({
		ledger: l,
		reservations: reservations({ BTC: { alice: 2n } }),
		asset: "BTC",
	});
	for (const k of [
		"asset",
		"holders",
		"total",
		"agrees",
		"sumOfHolders",
		"owedToCustomers",
		"overcommitted",
	]) {
		assert.ok(k in d, `the drill-down must carry "${k}"`);
	}
	for (const k of [
		"accountId",
		"balance",
		"reserved",
		"available",
		"availableBase",
		"overcommitted",
	]) {
		assert.ok(k in d.holders[0]!, `a holder row must carry "${k}"`);
	}
});
