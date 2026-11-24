// -----------------------------------------------------------------------------
// Tests for 0.2% maker/taker trading fees.
//
// The property that matters is CONSERVATION: after a fill, the sum of every
// movement is exactly zero per asset. A fee calculation that does not conserve
// is one that created or destroyed customer money, and it will show up later as
// a reconciliation shortfall with no obvious cause.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { parse } from "../src/amount";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import {
	DEFAULT_FEES,
	FeeError,
	Side,
	disclose,
	feesFor,
	fillKey,
	fillPostings,
	type Fill,
} from "../src/fees";

const BTC = { symbol: "BTC", decimals: 8 };
const USDC = { symbol: "USDC", decimals: 6 };

const user = (id: string, asset: string): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});
const fees = (asset: string): AccountRef => ({
	kind: AccountKind.FEES,
	owner: "",
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

function fill(over: Partial<Fill> = {}): Fill {
	return {
		base: "BTC",
		quote: "USDC",
		baseAmount: parse("1", BTC), // 1 BTC
		quoteAmount: parse("50000", USDC), // 50,000 USDC
		buyer: { userId: "alice", side: Side.TAKER },
		seller: { userId: "bob", side: Side.MAKER },
		fillId: "f1",
		...over,
	};
}

test("0.2% is taken from each side's PROCEEDS, in the asset received", () => {
	const f = feesFor(fill());

	// Buyer receives 1 BTC, pays 0.2% of it in BTC.
	assert.equal(f.buyerFee, parse("0.002", BTC));
	assert.equal(f.buyerNetBase, parse("0.998", BTC));

	// Seller receives 50,000 USDC, pays 0.2% of it in USDC.
	assert.equal(f.sellerFee, parse("100", USDC));
	assert.equal(f.sellerNetQuote, parse("49900", USDC));

	assert.equal(f.buyerBps, 20);
	assert.equal(f.sellerBps, 20);
});

test("maker and taker rates are applied per side", () => {
	// Same rate today, but the wiring must be right for a future schedule.
	const f = feesFor(fill(), { makerBps: 10, takerBps: 30 });
	// alice is the taker, bob the maker.
	assert.equal(f.buyerBps, 30);
	assert.equal(f.sellerBps, 10);
	assert.equal(f.buyerFee, (parse("1", BTC) * 30n) / 10_000n);
	assert.equal(f.sellerFee, (parse("50000", USDC) * 10n) / 10_000n);
});

test("CONSERVATION: a fill's postings sum to exactly zero per asset", () => {
	const { postings } = fillPostings(fill());
	const sums = new Map<string, bigint>();
	for (const p of postings) {
		sums.set(p.account.asset, (sums.get(p.account.asset) ?? 0n) + p.delta);
	}
	assert.equal(sums.get("BTC"), 0n);
	assert.equal(sums.get("USDC"), 0n);
});

test("conservation holds across a sweep of awkward amounts", () => {
	// The property, not any single expected number.
	for (const base of ["0.00000001", "0.00000777", "1", "7.77777777", "21000000"]) {
		for (const quote of ["0.000001", "1", "3333.333333", "999999999"]) {
			for (const [mk, tk] of [[0, 0], [1, 1], [20, 20], [7, 33], [10_000, 10_000]]) {
				const { postings, fees: fe } = fillPostings(
					fill({
						baseAmount: parse(base, BTC),
						quoteAmount: parse(quote, USDC),
						fillId: `${base}-${quote}-${mk}-${tk}`,
					}),
					{ makerBps: mk!, takerBps: tk! },
				);
				const sums = new Map<string, bigint>();
				for (const p of postings) {
					sums.set(p.account.asset, (sums.get(p.account.asset) ?? 0n) + p.delta);
				}
				assert.equal(sums.get("BTC") ?? 0n, 0n, `BTC ${base}/${quote} ${mk}/${tk}`);
				assert.equal(sums.get("USDC") ?? 0n, 0n, `USDC ${base}/${quote} ${mk}/${tk}`);
				assert.ok(fe.buyerFee >= 0n && fe.sellerFee >= 0n);
			}
		}
	}
});

test("ROUNDING FAVOURS THE CUSTOMER — the venue absorbs the sub-unit", () => {
	// 1 base unit at 20 bps is 0.002 units, which truncates to a zero fee.
	// The alternative (round up) would charge a 100% fee on dust.
	const f = feesFor(fill({ baseAmount: 1n, quoteAmount: 1n }));
	assert.equal(f.buyerFee, 0n);
	assert.equal(f.sellerFee, 0n);
	assert.equal(f.buyerNetBase, 1n);
	assert.equal(f.sellerNetQuote, 1n);
});

test("a zero fee is OMITTED, not posted as a zero-delta row", () => {
	// The ledger refuses zero-delta postings, so posting one would make every
	// dust trade fail.
	const { postings } = fillPostings(fill({ baseAmount: 1n, quoteAmount: 1n }));
	assert.equal(postings.length, 4, "four user legs, no fee rows");
	assert.ok(postings.every((p) => p.delta !== 0n));
});

test("A FILL POSTS CLEANLY THROUGH THE REAL LEDGER", async () => {
	const db = new Database(":memory:");
	const l = new Ledger(db);

	// Fund both sides.
	// NOTE the qualified custody ids. USDC is multi-network, so its custody
	// holding must name a chain — the first draft used `custody("USDC")` and
	// the ledger correctly refused it. The USER balance stays unqualified,
	// because that liability is fungible to the customer.
	for (const [who, asset, custodyId, amt] of [
		["alice", "USDC", "USDC.ERC20", parse("50000", USDC)],
		["bob", "BTC", "BTC", parse("1", BTC)],
	] as const) {
		l.post({
			reason: Reason.DEPOSIT,
			postings: [
				{ account: external(custodyId), delta: -amt },
				{ account: custody(custodyId), delta: amt },
				{ account: user(who, asset), delta: amt },
				{ account: external(custodyId), delta: -amt },
			],
			idempotencyKey: `dep:${who}:${asset}`,
			actor: "test",
		});
	}

	const f = fill();
	const { postings, fees: fe } = fillPostings(f);
	l.post({
		reason: Reason.TRADE,
		postings,
		idempotencyKey: fillKey(f.fillId),
		actor: "engine",
	});

	// Alice spent all her USDC and holds 0.998 BTC.
	assert.equal(l.balance(user("alice", "USDC")), 0n);
	assert.equal(l.balance(user("alice", "BTC")), parse("0.998", BTC));
	// Bob gave up his BTC and holds 49,900 USDC.
	assert.equal(l.balance(user("bob", "BTC")), 0n);
	assert.equal(l.balance(user("bob", "USDC")), parse("49900", USDC));
	// The venue earned both fees.
	assert.equal(l.balance(fees("BTC")), fe.buyerFee);
	assert.equal(l.balance(fees("USDC")), fe.sellerFee);

	// And the books still prove out: liabilities equal custody, per asset.
	assert.deepEqual(l.verify().ok, true);
	for (const asset of ["BTC", "USDC"]) {
		assert.equal(
			l.liabilities(asset),
			[...l.custodyByNetwork(asset).values()].reduce((a, b) => a + b, 0n),
			`${asset} liabilities must equal custody`,
		);
	}
});

test("a replayed fill settles exactly once", () => {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	// NOTE the qualified custody ids. USDC is multi-network, so its custody
	// holding must name a chain — the first draft used `custody("USDC")` and
	// the ledger correctly refused it. The USER balance stays unqualified,
	// because that liability is fungible to the customer.
	for (const [who, asset, custodyId, amt] of [
		["alice", "USDC", "USDC.ERC20", parse("50000", USDC)],
		["bob", "BTC", "BTC", parse("1", BTC)],
	] as const) {
		l.post({
			reason: Reason.DEPOSIT,
			postings: [
				{ account: external(custodyId), delta: -amt },
				{ account: custody(custodyId), delta: amt },
				{ account: user(who, asset), delta: amt },
				{ account: external(custodyId), delta: -amt },
			],
			idempotencyKey: `dep:${who}:${asset}`,
			actor: "test",
		});
	}

	const f = fill();
	const { postings } = fillPostings(f);
	for (let i = 0; i < 3; i++) {
		l.post({
			reason: Reason.TRADE,
			postings,
			idempotencyKey: fillKey(f.fillId),
			actor: "engine",
		});
	}
	assert.equal(l.balance(user("alice", "BTC")), parse("0.998", BTC), "filled once");
});

test("SELF-TRADING IS REFUSED", () => {
	// A wash trade inflates volume, and with fees on both sides it quietly
	// drains the trader — so refusing is both the honest and the kind choice.
	assert.throws(
		() => feesFor(fill({ buyer: { userId: "alice", side: Side.TAKER }, seller: { userId: "alice", side: Side.MAKER } })),
		/self-trade/,
	);
});

test("a network-qualified asset is refused as a trade asset", () => {
	// Trading is against the fungible balance. "USDT.TRC20/BTC" is not a
	// market, and accepting it would let someone trade one chain's inventory.
	assert.throws(() => feesFor(fill({ quote: "USDT.TRC20" })), /must not name a network/);
});

test("degenerate fills are refused", () => {
	assert.throws(() => feesFor(fill({ baseAmount: 0n })), FeeError);
	assert.throws(() => feesFor(fill({ quoteAmount: -1n })), FeeError);
	assert.throws(() => feesFor(fill({ base: "BTC", quote: "BTC" })), /same settlement asset/);
	assert.throws(() => feesFor(fill({ fillId: "  " })), /fillId is required/);
});

test("the published rate is 0.20% on both sides", () => {
	const d = disclose();
	assert.equal(d.makerPct, "0.20%");
	assert.equal(d.takerPct, "0.20%");
	assert.equal(DEFAULT_FEES.makerBps, 20);
	assert.equal(DEFAULT_FEES.takerBps, 20);
	// The disclosure must explain WHERE the fee comes from, since "0.2%"
	// alone leaves a customer guessing.
	assert.match(d.note, /on what it receives/);
	assert.match(d.note, /round down/);
});

test("18-decimal and 6-decimal assets trade against each other exactly", () => {
	const ETH = { symbol: "ETH", decimals: 18 };
	const { postings, fees: fe } = fillPostings(
		fill({
			base: "ETH",
			quote: "USDC",
			baseAmount: parse("3.141592653589793238", ETH),
			quoteAmount: parse("9999.999999", USDC),
			fillId: "mixed-precision",
		}),
	);
	const sums = new Map<string, bigint>();
	for (const p of postings) {
		sums.set(p.account.asset, (sums.get(p.account.asset) ?? 0n) + p.delta);
	}
	assert.equal(sums.get("ETH"), 0n);
	assert.equal(sums.get("USDC"), 0n);
	assert.ok(fe.buyerFee > 0n && fe.sellerFee > 0n);
});
