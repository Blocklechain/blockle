// -----------------------------------------------------------------------------
// MARKET-MAKER POSITION TESTS.
//
// This file places real orders with real balances, so the things worth pinning
// are the ones that cost a user money:
//
//   * the break-even is TWICE the maker fee, because a maker pays on both legs,
//     and a position tighter than that loses on every round trip;
//   * a sub-break-even ladder is REFUSED unless the loss is accepted explicitly;
//   * the ladder goes on in ONE transaction — a half-placed ladder is not the
//     spread the user chose;
//   * closing cancels only what is still resting, and never unwinds a fill;
//   * capital actually committed never exceeds capital offered.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { parse } from "../src/amount";
import { DEFAULT_FEES } from "../src/fees";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import { MarketMaker, MmError, quote } from "../src/mm";
import { Venue } from "../src/venue";

const usdt = (s: string): bigint => parse(s, { symbol: "USDT", decimals: 6 });
const btc = (s: string): bigint => parse(s, { symbol: "BTC", decimals: 8 });

const user = (id: string, asset: string): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});

function setup(): { db: Database.Database; l: Ledger; v: Venue; mm: MarketMaker } {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	const v = new Venue(db, l);
	const mm = new MarketMaker(db, v);
	return { db, l, v, mm };
}

/** Credit a trading balance. The custody leg names a chain where it must. */
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
		actor: "test",
	});
}

const MID = usdt("100000"); // BTC-USDT

test("BREAK-EVEN IS TWICE THE MAKER FEE, because a maker pays on both legs", () => {
	// The claim people expect is "makers earn the fee". On this venue they do
	// not — there is no maker rebate, so a maker pays 0.20% to buy and 0.20% to
	// sell. A round trip therefore needs more than 0.40% of spread to make
	// money, and a 10 bps "competitive" spread bleeds steadily.
	const q = quote({
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 10,
		rungs: 3,
		baseCapital: btc("0.3"),
		quoteCapital: usdt("30000"),
	});
	assert.equal(q.breakEvenBps, DEFAULT_FEES.makerBps * 2);
	assert.equal(q.breakEvenBps, 40);
	assert.equal(q.loses, true);
	assert.match(q.note, /does not cover fees/);
	assert.match(q.note, /LOSES about 0\.30%/);
});

test("a spread above break-even reports what it nets, not what it grosses", () => {
	const q = quote({
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 100,
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: usdt("20000"),
	});
	assert.equal(q.loses, false);
	assert.match(q.note, /Break-even is 0\.40%/);
	assert.match(q.note, /nets roughly 0\.60%/);
});

test("the ladder straddles the mid: bids below, asks above", () => {
	const q = quote({
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200, // ±1%
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: usdt("20000"),
	});
	assert.equal(q.bids.length, 2);
	assert.equal(q.asks.length, 2);
	for (const b of q.bids) assert.ok(b.price < MID, `bid ${b.price} should be under the mid`);
	for (const a of q.asks) assert.ok(a.price > MID, `ask ${a.price} should be over the mid`);
	// Outer rungs are further out than inner ones.
	assert.ok(q.bids[1]!.price < q.bids[0]!.price);
	assert.ok(q.asks[1]!.price > q.asks[0]!.price);
	// The widest rung sits at half the spread from the mid.
	assert.equal(q.asks[1]!.price, MID + (MID * 100n) / 10_000n);
});

test("CAPITAL COMMITTED NEVER EXCEEDS CAPITAL OFFERED", () => {
	// Integer division truncates per rung, so the remainder must stay unspent
	// rather than being rounded up into an order the balance cannot cover.
	for (const rungs of [1, 3, 7, 11]) {
		const q = quote({
			market: "BTC-USDT",
			mid: MID,
			spreadBps: 200,
			rungs,
			baseCapital: btc("1"),
			quoteCapital: usdt("100000"),
		});
		assert.ok(q.baseNeeded <= btc("1"), `rungs=${rungs}: base ${q.baseNeeded}`);
		assert.ok(q.quoteNeeded <= usdt("100000"), `rungs=${rungs}: quote ${q.quoteNeeded}`);
	}
});

test("one-sided ladders are allowed", () => {
	const askOnly = quote({
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 100,
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: 0n,
	});
	assert.equal(askOnly.bids.length, 0);
	assert.equal(askOnly.asks.length, 2);

	const bidOnly = quote({
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 100,
		rungs: 2,
		baseCapital: 0n,
		quoteCapital: usdt("20000"),
	});
	assert.equal(bidOnly.bids.length, 2);
	assert.equal(bidOnly.asks.length, 0);
});

test("nonsense parameters are refused rather than normalised", () => {
	const base = {
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 100,
		rungs: 2,
		baseCapital: btc("1"),
		quoteCapital: usdt("100000"),
	};
	assert.throws(() => quote({ ...base, mid: 0n }), /must be positive/);
	assert.throws(() => quote({ ...base, rungs: 0 }), /1 to 20/);
	assert.throws(() => quote({ ...base, rungs: 21 }), /1 to 20/);
	assert.throws(() => quote({ ...base, rungs: 2.5 }), /1 to 20/);
	assert.throws(() => quote({ ...base, spreadBps: 0 }), /basis points/);
	assert.throws(() => quote({ ...base, spreadBps: 10_001 }), /basis points/);
	assert.throws(() => quote({ ...base, baseCapital: -1n }), /cannot be negative/);
	assert.throws(
		() => quote({ ...base, baseCapital: 0n, quoteCapital: 0n }),
		/commit some capital/,
	);
	assert.throws(() => quote({ ...base, market: "NOPE-USDT" }), /NOPE/);
});

test("capital too small for the market minimum is refused, with the reason", () => {
	// Silently placing nothing and reporting success would leave someone
	// believing they were quoting a market when they were not.
	assert.throws(
		() =>
			quote({
				market: "BTC-USDT",
				mid: MID,
				spreadBps: 100,
				rungs: 20,
				baseCapital: 1n,
				quoteCapital: 1n,
			}),
		/below the .* minimum/,
	);
});

test("A LOSING LADDER IS REFUSED unless the loss is accepted explicitly", () => {
	// Not a checkbox for show: without it the venue quietly takes money from
	// someone who misread the arithmetic, which is the one thing a fee-charging
	// venue must not do.
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	fund(l, id, "USDT", usdt("100000"), "q");

	const args = {
		accountId: id,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 20, // under the 40 bps break-even
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: usdt("20000"),
	};
	assert.throws(() => mm.open(args), (e: unknown) => {
		assert.ok(e instanceof MmError);
		assert.match(String(e), /does not cover fees/);
		return true;
	});
	assert.equal(v.myOrders(id).length, 0, "and nothing was placed");

	// With the loss accepted, it goes on.
	const r = mm.open({ ...args, acceptLoss: true });
	assert.equal(r.quote.loses, true);
	assert.ok(r.position.orderIds.length > 0);
});

test("opening places the whole ladder and reports it", () => {
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	fund(l, id, "USDT", usdt("100000"), "q");

	const { position, quote: q } = mm.open({
		accountId: id,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 3,
		baseCapital: btc("0.3"),
		quoteCapital: usdt("30000"),
	});

	assert.equal(position.state, "open");
	assert.equal(position.rungs, 3);
	assert.equal(position.spreadBps, 200);
	assert.equal(position.orderIds.length, q.bids.length + q.asks.length);
	assert.equal(v.myOrders(id).length, position.orderIds.length);

	// Every order is resting, not filled: a ladder around the mid has nothing
	// to cross against.
	for (const oid of position.orderIds) {
		assert.equal(v.order(oid)?.state, "open", oid);
	}
});

test("A HALF-PLACED LADDER IS IMPOSSIBLE — the whole thing is one transaction", () => {
	// Funded for the asks but not the bids. The bid leg fails on insufficient
	// funds, and the asks must NOT survive: one side committed and the other
	// not is not the spread the user chose.
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	// No USDT at all.

	assert.throws(() =>
		mm.open({
			accountId: id,
			market: "BTC-USDT",
			mid: MID,
			spreadBps: 200,
			rungs: 2,
			baseCapital: btc("0.2"),
			quoteCapital: usdt("20000"),
		}),
	);
	assert.equal(v.myOrders(id).length, 0, "NOTHING was left on the book");
	assert.equal(mm.list(id).length, 0, "and no position row either");
});

test("closing cancels what is resting and frees the balance", () => {
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	fund(l, id, "USDT", usdt("100000"), "q");

	const before = v.balances(id).find((b) => b.asset === "BTC")!.available;
	const { position } = mm.open({
		accountId: id,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: usdt("20000"),
	});
	assert.ok(v.balances(id).find((b) => b.asset === "BTC")!.available < before);

	const r = mm.close(id, position.id);
	assert.equal(r.cancelled, position.orderIds.length);
	assert.equal(r.alreadyGone, 0);
	assert.equal(mm.get(id, position.id)?.state, "closed");
	assert.equal(
		v.balances(id).find((b) => b.asset === "BTC")!.available,
		before,
		"the committed base came back",
	);
});

test("A FILL IS NOT UNWOUND BY CLOSING — that was a real trade", () => {
	// "Remove liquidity" means stop quoting, not undo history. A close that
	// reversed fills would be rewriting trades the counterparty relied on.
	const { l, mm, v } = setup();
	const maker = v.register("mm@x.com", "correct horse battery staple").id;
	const taker = v.register("taker@x.com", "correct horse battery staple").id;
	fund(l, maker, "BTC", btc("1"), "mb");
	fund(l, maker, "USDT", usdt("100000"), "mq");
	fund(l, taker, "USDT", usdt("200000"), "tq");

	const { position } = mm.open({
		accountId: maker,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: usdt("20000"),
	});

	// Lift the inner ask.
	const innerAsk = position.orderIds
		.map((oid) => v.order(oid)!)
		.filter((o) => o.side === "sell")
		.sort((a, b) => (a.price < b.price ? -1 : 1))[0]!;
	v.placeOrder({
		accountId: taker,
		market: "BTC-USDT",
		side: "buy",
		price: innerAsk.price,
		baseAmount: innerAsk.baseTotal,
	});
	assert.equal(v.order(innerAsk.id)?.state, "filled");

	const r = mm.close(maker, position.id);
	assert.equal(r.alreadyGone, 1, "the filled order could not be cancelled");
	assert.equal(r.cancelled, position.orderIds.length - 1);
	// The maker sold BTC for USDT. That stands.
	assert.equal(v.order(innerAsk.id)?.state, "filled");
	assert.ok(
		v.balances(maker).find((b) => b.asset === "USDT")!.available > usdt("80000"),
		"the sale proceeds are theirs",
	);
});

test("a ladder cannot cross itself — the matcher excludes its own account", () => {
	// Two-sided quoting would otherwise wash the owner's capital away in fees.
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	fund(l, id, "USDT", usdt("200000"), "q");

	// A deliberately INVERTED ladder: bids above the asks. If self-matching
	// were possible this would immediately trade with itself.
	const { position } = mm.open({
		accountId: id,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 1,
		baseCapital: btc("0.1"),
		quoteCapital: usdt("20000"),
		acceptLoss: true,
	});
	// Now place a bid straight through its own ask.
	const ask = position.orderIds.map((o) => v.order(o)!).find((o) => o.side === "sell")!;
	const r = v.placeOrder({
		accountId: id,
		market: "BTC-USDT",
		side: "buy",
		price: ask.price,
		baseAmount: ask.baseTotal,
	});
	assert.equal(r.fills, 0, "no self-trade");
	assert.equal(v.order(ask.id)?.state, "open");
});

test("list() reports fill progress, which is the point of looking", () => {
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	fund(l, id, "USDT", usdt("100000"), "q");
	const { position } = mm.open({
		accountId: id,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 2,
		baseCapital: btc("0.2"),
		quoteCapital: usdt("20000"),
	});

	const rows = mm.list(id);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.id, position.id);
	assert.equal(rows[0]!.filledBase, 0n);
	assert.ok(rows[0]!.restingBase > 0n);
});

test("positions are per account — one user cannot see or close another's", () => {
	const { l, mm, v } = setup();
	const a = v.register("a@x.com", "correct horse battery staple").id;
	const b = v.register("b@x.com", "correct horse battery staple").id;
	fund(l, a, "BTC", btc("1"), "ab");
	fund(l, a, "USDT", usdt("100000"), "aq");
	const { position } = mm.open({
		accountId: a,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 1,
		baseCapital: btc("0.1"),
		quoteCapital: usdt("10000"),
	});

	assert.equal(mm.get(b, position.id), undefined);
	assert.equal(mm.list(b).length, 0);
	assert.throws(() => mm.close(b, position.id), /no such position/);
	// And it is still open for its owner.
	assert.equal(mm.get(a, position.id)?.state, "open");
});

test("a position cannot be closed twice", () => {
	const { l, mm, v } = setup();
	const { id } = v.register("mm@x.com", "correct horse battery staple");
	fund(l, id, "BTC", btc("1"), "b");
	fund(l, id, "USDT", usdt("100000"), "q");
	const { position } = mm.open({
		accountId: id,
		market: "BTC-USDT",
		mid: MID,
		spreadBps: 200,
		rungs: 1,
		baseCapital: btc("0.1"),
		quoteCapital: usdt("10000"),
	});
	mm.close(id, position.id);
	assert.throws(() => mm.close(id, position.id), /already closed/);
});
