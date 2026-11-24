// -----------------------------------------------------------------------------
// Tests for published withdrawal liquidity.
//
// The scenario driving these: inventory is all on Tron, a customer wants BNB
// Smart Chain. The venue must say so BEFORE they commit, must not promise the
// same units twice, and must never publish a number a double could mangle.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { format } from "../src/amount";
import { qualify } from "../src/assets";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import {
	NOTHING_HALTED,
	assetLiquidity,
	canPay,
	publish,
	reserves,
	type CommitmentSource,
	type HaltSource,
} from "../src/liquidity";

const fmt = (b: bigint, d: number): string => format(b, { symbol: "", decimals: d });

function fresh(): Ledger {
	return new Ledger(new Database(":memory:"));
}
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

function deposit(l: Ledger, who: string, net: string | null, amt: bigint, ref: string) {
	const sym = net === null ? "BTC" : "USDT";
	const q = net === null ? "BTC" : qualify("USDT", net);
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external(q), delta: -amt },
			{ account: custody(q), delta: amt },
			{ account: user(who, sym), delta: amt },
			{ account: external(q), delta: -amt },
		],
		idempotencyKey: `deposit:${ref}`,
		actor: "test",
	});
}

const noCommitments: CommitmentSource = {
	committedByNetwork: () => new Map(),
};
function commitments(m: Record<string, bigint>): CommitmentSource {
	return { committedByNetwork: () => new Map(Object.entries(m)) };
}

// 1 USDT = 1_000_000 base units (6 decimals).
const USDT = 1_000_000n;

test("ALL INVENTORY ON TRON: Tron is open, the other chains are not", () => {
	// The exact case asked about — "if all we have is TRX".
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");

	const liq = assetLiquidity(l, "USDT", noCommitments);
	const byNet = Object.fromEntries(liq.networks.map((n) => [n.network, n]));

	assert.equal(byNet.TRC20!.open, true);
	assert.equal(byNet.TRC20!.available, 500n * USDT);

	for (const n of ["ERC20", "SOL", "BEP20"]) {
		assert.equal(byNet[n]!.open, false, `${n} must be closed`);
		assert.equal(byNet[n]!.available, 0n);
		assert.match(byNet[n]!.closedReason!, /no liquidity on this network/);
	}

	// And the customer is told the largest withdrawal that CAN be paid.
	assert.equal(liq.maxSingleWithdrawal, 500n * USDT);
});

test("canPay refuses a chain with no inventory, and says where to go instead", () => {
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");
	const liq = assetLiquidity(l, "USDT", noCommitments);

	const bsc = canPay(liq, "BEP20", 100n * USDT);
	assert.equal(bsc.ok, false);
	assert.match(bsc.ok === false ? bsc.reason : "", /no liquidity on this network/);

	assert.deepEqual(canPay(liq, "TRC20", 100n * USDT), { ok: true });
});

test("an over-size request reports the ACTUAL available figure", () => {
	// "Insufficient liquidity" with no number tells a customer nothing and
	// they retry immediately.
	const l = fresh();
	deposit(l, "alice", "TRC20", 50n * USDT, "trx:1");
	const liq = assetLiquidity(l, "USDT", noCommitments);

	const r = canPay(liq, "TRC20", 100n * USDT);
	assert.equal(r.ok, false);
	if (r.ok === false) {
		assert.equal(r.available, 50n * USDT);
		assert.match(r.reason, /50000000 available/);
		assert.match(r.reason, /Another network may have more/);
	}
});

test("COMMITTED UNITS ARE NOT AVAILABLE — no promising the same coins twice", () => {
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");

	// 400 already approved for Tron withdrawals in flight.
	const liq = assetLiquidity(
		l,
		"USDT",
		commitments({ "USDT.TRC20": 400n * USDT }),
	);
	const tron = liq.networks.find((n) => n.network === "TRC20")!;

	assert.equal(tron.held, 500n * USDT);
	assert.equal(tron.committed, 400n * USDT);
	assert.equal(tron.available, 100n * USDT, "only the uncommitted remainder");
	assert.equal(canPay(liq, "TRC20", 200n * USDT).ok, false);
	assert.deepEqual(canPay(liq, "TRC20", 100n * USDT), { ok: true });
});

test("a fully committed chain says so, distinctly from being empty", () => {
	// These are different situations and a customer should be able to tell:
	// "come back shortly" vs "use another chain".
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");
	const liq = assetLiquidity(
		l,
		"USDT",
		commitments({ "USDT.TRC20": 500n * USDT }),
	);
	const tron = liq.networks.find((n) => n.network === "TRC20")!;
	assert.equal(tron.open, false);
	assert.match(tron.closedReason!, /fully committed to withdrawals already in progress/);
});

test("committed exceeding held floors availability at zero, never negative", () => {
	const l = fresh();
	deposit(l, "alice", "TRC20", 100n * USDT, "trx:1");
	const liq = assetLiquidity(
		l,
		"USDT",
		commitments({ "USDT.TRC20": 500n * USDT }),
	);
	assert.equal(liq.networks.find((n) => n.network === "TRC20")!.available, 0n);
});

test("A HALT CLOSES EVERY CHAIN, whatever the inventory says", () => {
	// When books and custody disagree, the inventory number is precisely what
	// is in doubt — so it cannot be used to justify a payout.
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");
	deposit(l, "alice", "ERC20", 500n * USDT, "eth:1");

	const halted: HaltSource = {
		halted: (s) => s === "USDT",
		reason: () => "a reconciliation check is in progress",
	};
	const liq = assetLiquidity(l, "USDT", noCommitments, halted);

	assert.equal(liq.halted, true);
	assert.equal(liq.maxSingleWithdrawal, 0n);
	for (const n of liq.networks) {
		assert.equal(n.open, false, `${n.network} must be closed`);
		assert.match(n.closedReason!, /reconciliation check is in progress/);
		// The inventory is still reported honestly — it is just not spendable.
		assert.ok(n.held >= 0n);
	}
});

test("dust is treated as empty rather than offered", () => {
	// 3 base units of USDT is 0.000003 — a withdrawal that costs more in
	// network fees than it moves. Offering it invites an instant rejection
	// for being under the minimum.
	const l = fresh();
	deposit(l, "alice", "TRC20", 3n, "trx:1");
	const liq = assetLiquidity(l, "USDT", noCommitments);
	const tron = liq.networks.find((n) => n.network === "TRC20")!;
	assert.equal(tron.held, 3n);
	assert.equal(tron.open, false);
});

test("networks are offered CHEAPEST FIRST", () => {
	const l = fresh();
	for (const n of ["TRC20", "ERC20", "SOL", "BEP20"]) {
		deposit(l, "alice", n, 100n * USDT, `dep:${n}`);
	}
	const liq = assetLiquidity(l, "USDT", noCommitments);
	// Ethereum is the expensive one and must not be the default.
	assert.equal(liq.networks[liq.networks.length - 1]!.network, "ERC20");
	assert.ok(liq.networks.every((n) => n.open));
});

test("single-chain assets get one row, so callers never branch", () => {
	const l = fresh();
	deposit(l, "bob", null, 100_000_000n, "btc:1"); // 1 BTC
	const liq = assetLiquidity(l, "BTC", noCommitments);
	assert.equal(liq.networks.length, 1);
	assert.equal(liq.networks[0]!.network, "BTC");
	assert.equal(liq.networks[0]!.open, true);
	assert.equal(liq.maxSingleWithdrawal, 100_000_000n);
});

test("THE PUBLIC PROJECTION EMITS STRINGS, NEVER JSON NUMBERS", () => {
	// A JSON number is a double. A balance above ~9e15 base units would be
	// silently mangled on the way out — the exact defect found in TradeXPro's
	// PHP helpers. Strings cost nothing and cannot be wrong.
	const l = fresh();
	const huge = 9_999_999_999_999_999_999n; // ~1e19, far past 2^53
    deposit(l, "whale", "TRC20", huge, "trx:big");

	const pub = publish(assetLiquidity(l, "USDT", noCommitments), fmt);
	const tron = pub.networks.find((n) => n.network === "TRC20")!;

	assert.equal(typeof tron.available, "string");
	assert.equal(typeof pub.maxSingleWithdrawal, "string");
	// Exact: 1e19 base units at 6 decimals.
	assert.equal(tron.available, "9999999999999.999999");
	// Round-trips without loss, which a double could not do.
	assert.equal(BigInt(tron.available.replace(".", "")), huge);
});

test("the public projection carries the closed reason, not just a flag", () => {
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");
	const pub = publish(assetLiquidity(l, "USDT", noCommitments), fmt);

	const tron = pub.networks.find((n) => n.network === "TRC20")!;
	assert.equal(tron.open, true);
	assert.equal(tron.note, undefined, "no note needed when open");

	const bsc = pub.networks.find((n) => n.network === "BEP20")!;
	assert.equal(bsc.open, false);
	assert.match(bsc.note!, /no liquidity/);
});

test("the public projection exposes no customer data", () => {
	const l = fresh();
	deposit(l, "alice", "TRC20", 500n * USDT, "trx:1");
	deposit(l, "bob", "ERC20", 300n * USDT, "eth:1");

	const json = JSON.stringify(publish(assetLiquidity(l, "USDT", noCommitments), fmt));
	assert.doesNotMatch(json, /alice/);
	assert.doesNotMatch(json, /bob/);
	assert.doesNotMatch(json, /user:/);
});

// ---------------------------------------------------------------- reserves

test("reserves reports owed and held as two exact figures, not a ratio", () => {
	// A "100%" ratio invites rounding and hides a small shortfall; two numbers
	// a reader can subtract do not.
	const l = fresh();
	deposit(l, "alice", "TRC20", 150n * USDT, "trx:1");
	deposit(l, "bob", "ERC20", 300n * USDT, "eth:1");

	const r = reserves(l, "USDT", fmt);
	assert.equal(r.owed, "450");
	assert.equal(r.held, "450");
	assert.equal(r.fullyBacked, true);
	assert.deepEqual(
		r.perNetwork.filter((n) => n.held !== "0").map((n) => [n.network, n.held]),
		[["TRC20", "150"], ["ERC20", "300"]],
	);
});

test("a surplus is still fully backed; a shortfall is not", () => {
	const l = fresh();
	deposit(l, "alice", "TRC20", 100n * USDT, "trx:1");
	// Fee revenue adds a liability without adding inventory.
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice", "USDT"), delta: -5n * USDT },
			{ account: { kind: AccountKind.FEES, owner: "", asset: "USDT" }, delta: 5n * USDT },
		],
		idempotencyKey: "fee:1",
		actor: "engine",
	});
	// Still 100 owed in total (95 user + 5 fees) against 100 held.
	assert.equal(reserves(l, "USDT", fmt).fullyBacked, true);

	// Now an unbacked credit: owed exceeds held.
	l.post({
		reason: Reason.ADJUSTMENT,
		postings: [
			{ account: user("carol", "USDT"), delta: 50n * USDT },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "USDT.TRC20" }, delta: -50n * USDT },
		],
		idempotencyKey: "adj:unbacked",
		actor: "operator:test",
		note: "deliberately unbacked, to prove the check works",
	});
	const r = reserves(l, "USDT", fmt);
	assert.equal(r.owed, "150");
	assert.equal(r.held, "100");
	assert.equal(r.fullyBacked, false);
});
