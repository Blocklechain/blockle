// -----------------------------------------------------------------------------
// GAS GATE TESTS.
//
// The question under test is narrow and the failure is expensive: can we
// actually send this token transfer? Holding plenty of USDT means nothing if
// the wallet has no ETH, and a withdrawal accepted in that state is a customer's
// money debited for a payment that cannot go out.
//
// Every refusal path is pinned, because the tempting implementation of each one
// is to let the withdrawal through.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
	LIVE_GAS_COSTS,
	checkGas,
	gasPositions,
	type GasCostTable,
	type GasGateDeps,
} from "../src/gasgate";
import { AccountKind, Ledger, Reason } from "../src/ledger";
import { fundGasFloat } from "../src/revenue";

function setup(): { l: Ledger; db: Database.Database } {
	const db = new Database(":memory:");
	return { l: new Ledger(db), db };
}

/** Put ETH in custody AND credit the venue's own claim on it. */
function fundFloat(l: Ledger, gasAsset: string, amount: bigint, key = "1"): void {
	fundGasFloat(l, { gasAsset, amount, actor: "treasury@blockle.org", idempotencyKey: key });
}

const deps = (l: Ledger, pending = 0, table?: GasCostTable): GasGateDeps => ({
	ledger: l,
	pendingOnChain: () => pending,
	...(table === undefined ? {} : { table }),
});

test("WITH NO GAS FLOAT, A TOKEN WITHDRAWAL IS REFUSED", () => {
	// The whole point. We may hold any amount of USDT.ERC20; without ETH the
	// transfer cannot be built.
	const { l } = setup();
	const v = checkGas({ asset: "USDT", network: "ERC20" }, deps(l));
	assert.equal(v.ok, false);
	assert.equal(v.gasAsset, "ETH");
	assert.match(v.reason, /sending the token costs ETH/);
	assert.match(v.reason, /gas float/);
	// And it says what to do about it rather than just refusing.
	assert.match(v.reason, /Another chain may be available/);
});

test("with a funded float it passes", () => {
	const { l } = setup();
	// One withdrawal needs 0.0026 ETH plus a 0.015 ETH floor.
	fundFloat(l, "ETH", 100_000_000_000_000_000n); // 0.1 ETH
	const v = checkGas({ asset: "USDT", network: "ERC20" }, deps(l));
	assert.equal(v.ok, true, v.reason);
	assert.equal(v.reason, "");
	assert.ok(v.required > 0n);
	assert.ok(v.ownedFloat >= v.required);
});

test("THE RESERVE FLOOR IS HELD BACK, not spent down to zero", () => {
	// A float drained to exactly the next withdrawal's cost has no headroom for
	// a gas spike between the check and the send.
	const { l } = setup();
	const cost = LIVE_GAS_COSTS["USDT.ERC20"]!;
	// Exactly one withdrawal's worth, and nothing more.
	fundFloat(l, "ETH", cost.perWithdrawal);
	const v = checkGas({ asset: "USDT", network: "ERC20" }, deps(l));
	assert.equal(v.ok, false, "one withdrawal's gas is not enough — the floor too");
	assert.equal(v.required, cost.perWithdrawal + cost.floor);
});

test("PENDING WITHDRAWALS ARE COUNTED, so a burst cannot each pass alone", () => {
	// Without this, ten withdrawals each check against the same float and all
	// ten pass, then seven of them cannot be sent.
	const { l } = setup();
	const cost = LIVE_GAS_COSTS["USDT.TRC20"]!;
	fundFloat(l, "TRX", cost.floor + cost.perWithdrawal * 3n);

	assert.equal(checkGas({ asset: "USDT", network: "TRC20" }, deps(l, 2)).ok, true);
	const tooMany = checkGas({ asset: "USDT", network: "TRC20" }, deps(l, 3));
	assert.equal(tooMany.ok, false, "the fourth does not fit");
	assert.match(tooMany.reason, /3 already queued/);
});

test("A CLAIM ON ETH IS NOT ETH — custody is checked separately", () => {
	// The FEES balance says we are owed it; the custody holding says it exists.
	// Fee revenue accrued in ETH is a claim; if the coins were swept out, the
	// claim is still on the books and cannot pay gas.
	const { l } = setup();
	const amt = 1_000_000_000_000_000_000n; // 1 ETH
	fundFloat(l, "ETH", amt);
	// Now move the coins out of custody while leaving the claim on the books —
	// a treasury transfer that forgot the float, or a custody holding that was
	// never really there. Either way the claim cannot pay gas.
	l.post({
		reason: Reason.ADJUSTMENT,
		postings: [
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "ETH" }, delta: -amt },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: amt },
		],
		idempotencyKey: "coins-moved-out",
		actor: "treasury@blockle.org",
		note: "treasury transfer out that forgot the gas float",
	});
	const v = checkGas({ asset: "USDT", network: "ERC20" }, deps(l));
	assert.equal(v.ok, false);
	assert.ok(v.ownedFloat > v.required, "we are owed plenty");
	assert.equal(v.custodyHeld, 0n, "but none of it exists");
	assert.match(v.reason, /only 0 ETH is actually in custody/);
});

test("SELF-FUNDING CHAINS ARE NOT GATED", () => {
	// A BTC withdrawal's fee comes out of the BTC being sent, so there is no
	// separate float and demanding one would refuse withdrawals for want of a
	// balance that does not need to exist.
	const { l } = setup();
	const v = checkGas({ asset: "BTC", network: undefined }, deps(l));
	assert.equal(v.ok, true);
	assert.equal(v.selfFunding, true);
	assert.equal(v.gasAsset, "BTC");
});

test("AN UNBUDGETED CHAIN IS REFUSED, not assumed cheap", () => {
	const { l } = setup();
	fundFloat(l, "TRX", 1_000_000_000n);
	const v = checkGas({ asset: "USDT", network: "TRC20" }, deps(l, 0, {}));
	assert.equal(v.ok, false);
	assert.match(v.reason, /no gas budget configured/);
	assert.match(v.reason, /pays gas in TRX/);
});

test("A GATE THAT CANNOT READ ITS INPUTS REFUSES", () => {
	// Treating an unreadable balance as "probably fine" is how a float goes
	// negative — which means paying gas out of customer holdings.
	const { l } = setup();
	fundFloat(l, "ETH", 1_000_000_000_000_000_000n);
	const broken: GasGateDeps = {
		ledger: l,
		pendingOnChain: () => {
			throw new Error("withdrawal table locked");
		},
	};
	const v = checkGas({ asset: "USDT", network: "ERC20" }, broken);
	assert.equal(v.ok, false);
	assert.match(v.reason, /cannot establish the ETH gas position/);
	assert.match(v.reason, /withdrawal table locked/);
});

test("a nonsense pending count is refused rather than coerced", () => {
	const { l } = setup();
	fundFloat(l, "ETH", 1_000_000_000_000_000_000n);
	for (const bad of [-1, 1.5, Number.NaN]) {
		const v = checkGas(
			{ asset: "USDT", network: "ERC20" },
			{ ledger: l, pendingOnChain: () => bad },
		);
		assert.equal(v.ok, false, `pending=${bad}`);
	}
});

test("a missing network on a multi-network asset is refused", () => {
	const { l } = setup();
	const v = checkGas({ asset: "USDT", network: undefined }, deps(l));
	assert.equal(v.ok, false);
	assert.match(v.reason, /cannot determine which asset pays gas/);
});

test("RUNWAY IS REPORTED IN WITHDRAWALS, not just in coins", () => {
	// "0.9 ETH" means nothing without knowing what a send costs. The number an
	// operator needs is how many more withdrawals it buys.
	const { l } = setup();
	const cost = LIVE_GAS_COSTS["USDT.ERC20"]!;
	fundFloat(l, "ETH", cost.floor + cost.perWithdrawal * 5n);

	const rows = gasPositions(deps(l));
	const erc = rows.find((r) => r.chain === "USDT.ERC20");
	assert.ok(erc !== undefined);
	assert.equal(erc.gasAsset, "ETH");
	assert.equal(erc.runway, 5, "five withdrawals of headroom above the floor");
	assert.equal(erc.healthy, true);

	// A chain with no float reports zero runway rather than a negative one.
	const trc = rows.find((r) => r.chain === "USDT.TRC20");
	assert.ok(trc !== undefined);
	assert.equal(trc.runway, 0);
	assert.equal(trc.healthy, false);
});

test("every chain in the live gas table is reportable", () => {
	// A row that throws when rendered is a row an operator will never see.
	const { l } = setup();
	const rows = gasPositions(deps(l));
	assert.equal(rows.length, Object.keys(LIVE_GAS_COSTS).length);
	for (const r of rows) {
		assert.ok(r.gasAsset.length > 0, r.chain);
		assert.ok(r.perWithdrawal !== "0", `${r.chain}: a zero budget is not a budget`);
	}
});
