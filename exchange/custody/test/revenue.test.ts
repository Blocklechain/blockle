// -----------------------------------------------------------------------------
// REVENUE TESTS — is the profit figure true?
//
// A profit report is the one report nobody double-checks by hand, so the tests
// have to. The important ones are:
//
//   * the buckets reconcile to the FEES balance (and SAY SO when they do not);
//   * an unclassified posting makes the report admit it is incomplete rather
//     than quietly reporting a wrong total;
//   * gas is attributed to the asset it was actually spent in;
//   * a sweep is not counted as revenue, and cannot take the gas float with it.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { parse } from "../src/amount";
import { Side, fillPostings } from "../src/fees";
import { GAS_PRICE_FLOOR, StaticRates } from "../src/gasrates";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import { RevenueError, estimateTotal, fundGasFloat, revenue, sweep } from "../src/revenue";

const usdt = (s: string): bigint => parse(s, { symbol: "USDT", decimals: 6 });
const btc = (s: string): bigint => parse(s, { symbol: "BTC", decimals: 8 });

const user = (id: string, asset: string): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});
const fees = (asset: string): AccountRef => ({ kind: AccountKind.FEES, owner: "", asset });

function setup(): { l: Ledger; db: Database.Database } {
	const db = new Database(":memory:");
	return { l: new Ledger(db), db };
}

/**
 * Credit a user without pretending it came from nowhere.
 *
 * The custody AND external legs name a chain for multi-network assets: both
 * sides of an on-chain movement happened on a specific chain, and an
 * unqualified holding cannot be reconciled against any of them (see assets.ts).
 * USDT deposits land on Tron here.
 */
function fund(l: Ledger, who: string, asset: string, amt: bigint, key: string): void {
	const custodyId = asset === "USDT" || asset === "USDC" ? `${asset}.TRC20` : asset;
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amt },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: custodyId }, delta: amt },
			{ account: user(who, asset), delta: amt },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amt },
		],
		idempotencyKey: `dep:${key}`,
		actor: "deposit-watcher",
	});
}

/** One trade: alice buys 1 BTC from bob for 100,000 USDT. */
function trade(l: Ledger, id: string): void {
	const { postings } = fillPostings({
		base: "BTC",
		quote: "USDT",
		baseAmount: btc("1"),
		quoteAmount: usdt("100000"),
		buyer: { userId: "alice", side: Side.TAKER },
		seller: { userId: "bob", side: Side.MAKER },
		fillId: id,
	});
	l.post({ reason: Reason.TRADE, postings, idempotencyKey: `trade:${id}`, actor: "matcher" });
}

test("TRADING FEES ACCRUE TO THE EXCHANGE and are reported as such", () => {
	// 0.20% from each side, taken in the asset that side receives: the buyer's
	// fee in BTC, the seller's in USDT.
	const { l, db } = setup();
	fund(l, "bob", "BTC", btc("5"), "b");
	fund(l, "alice", "USDT", usdt("500000"), "a");
	trade(l, "f1");

	const r = revenue(db, l);
	assert.equal(r.reconciles, true, r.warnings.join(" | "));

	const inBtc = r.assets.find((a) => a.asset === "BTC");
	const inUsdt = r.assets.find((a) => a.asset === "USDT");
	assert.ok(inBtc !== undefined && inUsdt !== undefined);

	// 0.20% of 1 BTC and 0.20% of 100,000 USDT.
	assert.equal(inBtc.tradingFees, btc("0.002"));
	assert.equal(inUsdt.tradingFees, usdt("200"));
	assert.equal(inBtc.netProfit, btc("0.002"));
	assert.equal(inUsdt.netProfit, usdt("200"));
	assert.equal(inUsdt.display.netProfit, "200");
});

test("the buckets reconcile to the FEES balance", () => {
	const { l, db } = setup();
	fund(l, "bob", "BTC", btc("5"), "b");
	fund(l, "alice", "USDT", usdt("500000"), "a");
	trade(l, "f1");
	trade(l, "f2");

	const r = revenue(db, l);
	assert.equal(r.reconciles, true, r.warnings.join(" | "));
	for (const a of r.assets) {
		assert.equal(
			a.netProfit + a.treasuryFunding - a.swept + a.unclassified,
			a.balance,
			`${a.asset} does not reconcile`,
		);
	}
});

test("AN UNCLASSIFIED POSTING MAKES THE REPORT ADMIT IT IS INCOMPLETE", () => {
	// The failure this prevents: an operator adjustment lands in the fee
	// account, the report has no bucket for it, and the profit figure is wrong
	// with nothing on screen to say so.
	const { l, db } = setup();
	fund(l, "alice", "USDT", usdt("1000"), "a");
	l.post({
		reason: Reason.ADJUSTMENT,
		postings: [
			{ account: user("alice", "USDT"), delta: -usdt("50") },
			{ account: fees("USDT"), delta: usdt("50") },
		],
		idempotencyKey: "manual-1",
		actor: "alex@blockle.org",
		note: "goodwill clawback agreed by email",
	});

	const r = revenue(db, l);
	assert.equal(r.reconciles, false, "must not claim to reconcile");
	assert.ok(r.warnings.some((w) => /does not classify/.test(w)));
	const u = r.assets.find((a) => a.asset === "USDT")!;
	assert.equal(u.unclassified, usdt("50"));
	assert.equal(u.netProfit, 0n, "and it is NOT counted as profit");
});

test("GAS IS CHARGED TO THE ASSET IT WAS SPENT IN", () => {
	// Sending USDT over Ethereum burns ETH. Booking that against USDT would
	// understate USDT profit and hide the ETH cost entirely.
	const { l, db } = setup();
	fundGasFloat(l, {
		gasAsset: "ETH",
		amount: 100_000_000_000_000_000n,
		actor: "treasury@blockle.org",
		idempotencyKey: "float-1",
	});
	// A settlement that burned 0.002 ETH of gas.
	l.post({
		reason: Reason.WITHDRAWAL_SETTLE,
		postings: [
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "ETH" }, delta: -2_000_000_000_000_000n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: 2_000_000_000_000_000n },
			{ account: fees("ETH"), delta: -2_000_000_000_000_000n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: 2_000_000_000_000_000n },
		],
		idempotencyKey: "settle-1",
		actor: "bitgo-webhook",
	});

	const r = revenue(db, l);
	const eth = r.assets.find((a) => a.asset === "ETH")!;
	assert.equal(eth.gasSpent, 2_000_000_000_000_000n);
	assert.equal(eth.treasuryFunding, 100_000_000_000_000_000n);
	// Treasury funding is NOT revenue, so the ETH line is a pure loss.
	assert.equal(eth.netProfit, -2_000_000_000_000_000n);
	assert.ok(r.warnings.some((w) => /ETH: NET LOSS/.test(w)));
	// And it still reconciles — a loss is not a bookkeeping error.
	assert.equal(r.reconciles, true, r.warnings.join(" | "));
});

test("THE LEDGER ITSELF REFUSES TO OVERSPEND THE GAS FLOAT", () => {
	// Stronger than the report warning I first wrote for this: a FEES balance
	// cannot go negative at all, because the ledger enforces non-negative
	// balances on every internal account. So gas can never be paid out of
	// customer holdings by a posting — the attempt fails.
	//
	// WHICH MOVES THE RISK RATHER THAN REMOVING IT. If the gate passes at
	// request time and the float is exhausted by the time the custodian
	// confirms, `confirm()` throws and the withdrawal cannot be settled — while
	// the coins are already on chain. That is what the reserve floor in
	// gasgate.ts is for, and it is the reason the floor is several withdrawals
	// wide rather than one.
	const { l } = setup();
	// A customer's ETH is in custody, so the coins exist — they are just not
	// ours to burn.
	fund(l, "alice", "ETH", 1_000_000n, "eth");
	assert.throws(
		() =>
			l.post({
				reason: Reason.WITHDRAWAL_SETTLE,
				postings: [
					{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "ETH" }, delta: -1_000n },
					{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: 1_000n },
					{ account: fees("ETH"), delta: -1_000n },
					{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: 1_000n },
				],
				idempotencyKey: "overspend",
				actor: "bitgo-webhook",
			}),
		/fees::ETH has 0 but 1000 was debited/,
	);
});

test("a windowed report says it is not expected to match the balances", () => {
	const { l, db } = setup();
	fund(l, "bob", "BTC", btc("5"), "b");
	fund(l, "alice", "USDT", usdt("500000"), "a");
	trade(l, "f1");

	const r = revenue(db, l, { from: "2099-01-01T00:00:00.000Z" });
	assert.equal(r.assets.length, 0, "nothing was earned in the future");
	assert.ok(r.warnings.some((w) => /windowed report/.test(w)));

	const all = revenue(db, l, { from: "2000-01-01T00:00:00.000Z" });
	assert.ok(all.assets.length > 0);
});

test("A SWEEP MOVES REVENUE WITHOUT COUNTING AS REVENUE", () => {
	// Counting a sweep as income would report the same earnings twice.
	const { l, db } = setup();
	fund(l, "bob", "BTC", btc("5"), "b");
	fund(l, "alice", "USDT", usdt("500000"), "a");
	trade(l, "f1");

	const before = revenue(db, l).assets.find((a) => a.asset === "USDT")!;
	sweep(l, {
		asset: "USDT",
		toUserId: "house",
		amount: usdt("150"),
		actor: "alex@blockle.org",
		idempotencyKey: "sw1",
	});

	const after = revenue(db, l).assets.find((a) => a.asset === "USDT")!;
	assert.equal(after.netProfit, before.netProfit, "profit is unchanged by a sweep");
	assert.equal(after.swept, usdt("150"));
	assert.equal(after.balance, usdt("50"), "the fee account is drawn down");
	assert.equal(l.balance(user("house", "USDT")), usdt("150"), "and it is spendable");
	assert.equal(revenue(db, l).reconciles, true);
});

test("A SWEEP CANNOT TAKE THE GAS FLOAT WITH IT", () => {
	// Booking a profit and then being unable to pay withdrawals out of it is
	// the specific way this goes wrong.
	const { l } = setup();
	fundGasFloat(l, {
		gasAsset: "ETH",
		amount: 100_000_000_000_000_000n, // 0.1 ETH
		actor: "treasury@blockle.org",
		idempotencyKey: "float-1",
	});
	assert.throws(
		() =>
			sweep(l, {
				asset: "ETH",
				toUserId: "house",
				amount: 100_000_000_000_000_000n,
				actor: "alex@blockle.org",
				reserve: 50_000_000_000_000_000n,
				idempotencyKey: "sw1",
			}),
		(e: unknown) => {
			assert.ok(e instanceof RevenueError);
			assert.match(String(e), /reserved as a gas float/);
			assert.match(String(e), /cannot pay withdrawals/);
			return true;
		},
	);
	// And the sweepable portion still goes through.
	sweep(l, {
		asset: "ETH",
		toUserId: "house",
		amount: 50_000_000_000_000_000n,
		actor: "alex@blockle.org",
		reserve: 50_000_000_000_000_000n,
		idempotencyKey: "sw2",
	});
	assert.equal(l.balance(fees("ETH")), 50_000_000_000_000_000n);
});

test("a sweep must name an operator and a destination", () => {
	const { l } = setup();
	fund(l, "alice", "USDT", usdt("1000"), "a");
	l.post({
		reason: Reason.TRADE,
		postings: [
			{ account: user("alice", "USDT"), delta: -usdt("100") },
			{ account: fees("USDT"), delta: usdt("100") },
		],
		idempotencyKey: "fee",
		actor: "matcher",
	});
	const base = { asset: "USDT", amount: usdt("10"), idempotencyKey: "x" };
	assert.throws(() => sweep(l, { ...base, toUserId: "house", actor: "  " }), /name the operator/);
	assert.throws(() => sweep(l, { ...base, toUserId: " ", actor: "alex" }), /name the destination/);
	assert.throws(
		() => sweep(l, { ...base, toUserId: "house", actor: "alex", amount: 0n }),
		/must be positive/,
	);
});

test("THE SINGLE-NUMBER TOTAL IS LABELLED AN ESTIMATE and names what it left out", () => {
	// Earnings accrue in several assets; one number requires prices, and a
	// price is a judgement. The worst version of this is a confident total that
	// silently omits the asset you earn most in.
	const { l, db } = setup();
	fund(l, "bob", "BTC", btc("5"), "b");
	fund(l, "alice", "USDT", usdt("500000"), "a");
	trade(l, "f1");

	const r = revenue(db, l);
	// The floor table prices ETH/TRX/SOL/BNB against USDT — but not BTC.
	const t = estimateTotal(r, [new StaticRates(GAS_PRICE_FLOOR)], "USDT");
	assert.equal(t.currency, "USDT");
	assert.deepEqual(t.unpriced, ["BTC"], "BTC has no rate here");
	assert.match(t.caveat, /ESTIMATE/);
	assert.match(t.caveat, /BTC could not be priced and is EXCLUDED/);
	// USDT converts to itself at one, exactly.
	assert.equal(t.netProfit, "200");
	assert.equal(t.lines.find((x) => x.asset === "USDT")?.source, "identity");

	// Give it a BTC rate and BTC joins the total.
	const withBtc = estimateTotal(
		r,
		[new StaticRates({ ...GAS_PRICE_FLOOR, "BTC/USDT": "90000" })],
		"USDT",
	);
	assert.deepEqual(withBtc.unpriced, []);
	// 0.002 BTC at 90,000 = 180, plus 200 USDT.
	assert.equal(withBtc.netProfit, "380");
});

test("a loss converts as a loss, rounded away from zero", () => {
	// convertCeil refuses negatives on purpose; the magnitude is converted and
	// the sign reapplied, so a loss is never understated by rounding.
	const { l, db } = setup();
	fundGasFloat(l, {
		gasAsset: "TRX",
		amount: 100_000_000n,
		actor: "treasury@blockle.org",
		idempotencyKey: "trx-float",
	});
	l.post({
		reason: Reason.WITHDRAWAL_SETTLE,
		postings: [
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "TRX" }, delta: -1_000_001n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "TRX" }, delta: 1_000_001n },
			{ account: fees("TRX"), delta: -1_000_001n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "TRX" }, delta: 1_000_001n },
		],
		idempotencyKey: "gas",
		actor: "bitgo-webhook",
	});
	const t = estimateTotal(revenue(db, l), [new StaticRates(GAS_PRICE_FLOOR)], "USDT");
	// 1.000001 TRX at 0.35 = 0.35000035, which rounds to 0.350001 at 6 dp —
	// away from zero, so the loss is not understated.
	assert.equal(t.netProfit, "-0.350001");
});
