// -----------------------------------------------------------------------------
// Tests for the custodial venue: accounts, matching, settlement.
//
// The test that matters most is the end-to-end one: two accounts fund, place
// crossing orders, and the ledger afterwards still proves out — liabilities
// equal custody, per asset, to the unit. Everything else is a way for that to
// go wrong.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { parse } from "../src/amount";
import { AccountKind, Ledger, Reason } from "../src/ledger";
import { Venue, VenueError, quoteFor } from "../src/venue";

const BTC = { symbol: "BTC", decimals: 8 };
const USDT = { symbol: "USDT", decimals: 6 };

function setup(mainnet = false): { l: Ledger; v: Venue; db: Database.Database } {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	return { l, v: new Venue(db, l, undefined, { mainnetEnabled: mainnet }), db };
}

/** Register, log in, and fund an account. Returns its id. */
function actor(v: Venue, email: string, btc = "0", usdt = "0"): string {
	const { id } = v.register(email, "a-sufficiently-long-password");
	if (btc !== "0") v.testnetCredit(id, "BTC", parse(btc, BTC), "BTC");
	if (usdt !== "0") v.testnetCredit(id, "USDT", parse(usdt, USDT), "USDT.TRC20");
	return id;
}

const bal = (l: Ledger, who: string, asset: string): bigint =>
	l.balance({ kind: AccountKind.USER, owner: who, asset });

/** The invariant that must hold after everything: books prove out. */
function assertSolvent(l: Ledger, assets: string[]): void {
	assert.deepEqual(l.verify().ok, true, "ledger must verify");
	for (const a of assets) {
		const held = [...l.custodyByNetwork(a).values()].reduce((x, y) => x + y, 0n);
		assert.equal(l.liabilities(a), held, `${a}: liabilities must equal custody`);
	}
}

// ------------------------------------------------------------------ accounts

test("register + login + authenticate round-trips", () => {
	const { v } = setup();
	v.register("alice@example.com", "a-sufficiently-long-password");
	const { token, accountId } = v.login("alice@example.com", "a-sufficiently-long-password");
	assert.equal(v.authenticate(token), accountId);
	v.logout(token);
	assert.throws(() => v.authenticate(token), /not signed in/);
});

test("a wrong password and an unknown account give the SAME error", () => {
	// Different errors here make login an account-enumeration oracle.
	const { v } = setup();
	v.register("alice@example.com", "a-sufficiently-long-password");
	const msg = (email: string): string => {
		try {
			v.login(email, "wrong-but-long-enough");
			return "NO ERROR";
		} catch (e) {
			return String(e);
		}
	};
	const a = msg("alice@example.com");
	const b = msg("nobody@example.com");
	assert.equal(a, b);
	assert.match(a, /wrong email or password/);
});

test("registering a duplicate email does not confirm the email exists", () => {
	const { v } = setup();
	v.register("alice@example.com", "a-sufficiently-long-password");
	assert.throws(
		() => v.register("alice@example.com", "another-long-password"),
		/cannot be registered/,
	);
});

test("short passwords and bad emails are refused", () => {
	const { v } = setup();
	assert.throws(() => v.register("alice@example.com", "short"), /at least 12/);
	assert.throws(() => v.register("not-an-email", "a-sufficiently-long-password"), /email address/);
});

test("SESSIONS ARE STORED HASHED, so a database read yields no live tokens", () => {
	const { v, db } = setup();
	v.register("alice@example.com", "a-sufficiently-long-password");
	const { token } = v.login("alice@example.com", "a-sufficiently-long-password");
	const rows = db.prepare(`SELECT token_hash FROM session`).all() as { token_hash: string }[];
	assert.equal(rows.length, 1);
	assert.notEqual(rows[0]!.token_hash, token, "the raw token must not be stored");
});

// ------------------------------------------------------------------- funding

test("TESTNET FUNDING IS REFUSED WHEN MAINNET IS ON", () => {
	// An endpoint that can conjure balances in production is a rug, and the
	// guard belongs in code rather than a deployment checklist.
	const { v } = setup(true);
	const { id } = v.register("alice@example.com", "a-sufficiently-long-password");
	assert.throws(
		() => v.testnetCredit(id, "BTC", 100n, "BTC"),
		/disabled on mainnet/,
	);
});

test("testnet funding credits the balance and stays solvent", () => {
	const { l, v } = setup();
	const alice = actor(v, "alice@example.com", "1.5");
	assert.equal(bal(l, alice, "BTC"), parse("1.5", BTC));
	assertSolvent(l, ["BTC"]);
});

// ------------------------------------------------------------------- trading

test("TWO STRANGERS TRADE, AND THE BOOKS STILL PROVE OUT", () => {
	const { l, v } = setup();
	const alice = actor(v, "alice@example.com", "0", "60000"); // buyer, has USDT
	const bob = actor(v, "bob@example.com", "1", "0"); // seller, has BTC

	// Bob rests an ask at 50,000 USDT per BTC.
	const price = parse("50000", USDT);
	const ask = v.placeOrder({
		accountId: bob, market: "BTC-USDT", side: "sell",
		price, baseAmount: parse("1", BTC),
	});
	assert.equal(ask.fills, 0, "nothing to cross yet");
	assert.equal(v.book("BTC-USDT").asks.length, 1);

	// Alice crosses it.
	const bid = v.placeOrder({
		accountId: alice, market: "BTC-USDT", side: "buy",
		price, baseAmount: parse("1", BTC),
	});
	assert.equal(bid.fills, 1);
	assert.equal(bid.order.state, "filled");

	// Alice paid 50,000 and received 1 BTC less the 0.2% taker fee.
	assert.equal(bal(l, alice, "USDT"), parse("10000", USDT));
	assert.equal(bal(l, alice, "BTC"), parse("0.998", BTC));
	// Bob gave up the BTC and received 50,000 less his 0.2% maker fee.
	assert.equal(bal(l, bob, "BTC"), 0n);
	assert.equal(bal(l, bob, "USDT"), parse("49900", USDT));
	// The venue earned both fees.
	assert.equal(l.balance({ kind: AccountKind.FEES, owner: "", asset: "BTC" }), parse("0.002", BTC));
	assert.equal(l.balance({ kind: AccountKind.FEES, owner: "", asset: "USDT" }), parse("100", USDT));

	assertSolvent(l, ["BTC", "USDT"]);
	assert.equal(v.book("BTC-USDT").asks.length, 0, "the ask is gone");
	assert.equal(v.lastPrice("BTC-USDT"), price);
});

test("FILLS HAPPEN AT THE MAKER'S PRICE, not the taker's", () => {
	// The maker posted first and set the terms. Filling at the taker's limit
	// would hand the taker the whole gap — a silent transfer away from the
	// person who provided the liquidity.
	const { l, v } = setup();
	const alice = actor(v, "alice@example.com", "0", "60000");
	const bob = actor(v, "bob@example.com", "1", "0");

	// Bob asks 50,000.
	v.placeOrder({
		accountId: bob, market: "BTC-USDT", side: "sell",
		price: parse("50000", USDT), baseAmount: parse("1", BTC),
	});
	// Alice is willing to pay 55,000 — she should still pay 50,000.
	v.placeOrder({
		accountId: alice, market: "BTC-USDT", side: "buy",
		price: parse("55000", USDT), baseAmount: parse("1", BTC),
	});

	assert.equal(bal(l, alice, "USDT"), parse("10000", USDT), "paid 50k, not 55k");
	assert.equal(v.lastPrice("BTC-USDT"), parse("50000", USDT));
	assertSolvent(l, ["BTC", "USDT"]);
});

test("price-time priority: cheaper ask fills first, ties broken by arrival", () => {
	const { l, v } = setup();
	const buyer = actor(v, "buyer@example.com", "0", "200000");
	const s1 = actor(v, "s1@example.com", "1", "0");
	const s2 = actor(v, "s2@example.com", "1", "0");
	const s3 = actor(v, "s3@example.com", "1", "0");

	// s1 and s3 at 50,000 (s1 first), s2 cheaper at 49,000.
	v.placeOrder({ accountId: s1, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("1", BTC) });
	v.placeOrder({ accountId: s2, market: "BTC-USDT", side: "sell", price: parse("49000", USDT), baseAmount: parse("1", BTC) });
	v.placeOrder({ accountId: s3, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("1", BTC) });

	// Buy 2 BTC at up to 50,000: should take s2 (cheapest) then s1 (earlier).
	const r = v.placeOrder({ accountId: buyer, market: "BTC-USDT", side: "buy", price: parse("50000", USDT), baseAmount: parse("2", BTC) });
	assert.equal(r.fills, 2);
	assert.equal(bal(l, s2, "BTC"), 0n, "cheapest filled");
	assert.equal(bal(l, s1, "BTC"), 0n, "then the earlier of the tie");
	assert.equal(bal(l, s3, "BTC"), parse("1", BTC), "latest of the tie untouched");
	assertSolvent(l, ["BTC", "USDT"]);
});

test("a partial fill leaves the remainder resting", () => {
	const { l, v } = setup();
	const buyer = actor(v, "buyer@example.com", "0", "100000");
	const seller = actor(v, "seller@example.com", "0.4", "0");

	v.placeOrder({ accountId: seller, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("0.4", BTC) });
	const r = v.placeOrder({ accountId: buyer, market: "BTC-USDT", side: "buy", price: parse("50000", USDT), baseAmount: parse("1", BTC) });

	assert.equal(r.fills, 1);
	assert.equal(r.order.state, "open", "0.6 BTC still wanted");
	assert.equal(r.order.baseFilled, parse("0.4", BTC));
	const book = v.book("BTC-USDT");
	assert.equal(book.bids.length, 1);
	assert.equal(book.bids[0]!.base, parse("0.6", BTC));
	assertSolvent(l, ["BTC", "USDT"]);
});

test("AN UNDERFUNDED ORDER IS REFUSED AND LEAVES NO TRACE", () => {
	const { l, v } = setup();
	const alice = actor(v, "alice@example.com", "0", "100"); // only 100 USDT

	assert.throws(
		() => v.placeOrder({
			accountId: alice, market: "BTC-USDT", side: "buy",
			price: parse("50000", USDT), baseAmount: parse("1", BTC),
		}),
		/insufficient USDT/,
	);
	assert.equal(v.book("BTC-USDT").bids.length, 0, "no phantom order");
	assert.equal(v.myOrders(alice).length, 0);
	assertSolvent(l, ["USDT"]);
});

test("SELF-TRADING IS IMPOSSIBLE — an account never matches itself", () => {
	const { l, v } = setup();
	const alice = actor(v, "alice@example.com", "1", "60000");

	v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("1", BTC) });
	const r = v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "buy", price: parse("50000", USDT), baseAmount: parse("1", BTC) });

	assert.equal(r.fills, 0, "crossing own order must not fill");
	// Both rest on the book instead.
	const b = v.book("BTC-USDT");
	assert.equal(b.bids.length, 1);
	assert.equal(b.asks.length, 1);
	assertSolvent(l, ["BTC", "USDT"]);
});

test("cancel frees the order; a filled one cannot be cancelled", () => {
	const { v } = setup();
	const alice = actor(v, "alice@example.com", "1", "0");
	const r = v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("1", BTC) });

	assert.equal(v.cancelOrder(alice, r.order.id).state, "cancelled");
	assert.equal(v.book("BTC-USDT").asks.length, 0);
	assert.throws(() => v.cancelOrder(alice, r.order.id), /already cancelled/);
});

test("you cannot cancel someone else's order", () => {
	const { v } = setup();
	const alice = actor(v, "alice@example.com", "1", "0");
	const bob = actor(v, "bob@example.com", "0", "0");
	const r = v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("1", BTC) });
	assert.throws(() => v.cancelOrder(bob, r.order.id), /not your order/);
});

test("sub-minimum and non-positive orders are refused", () => {
	const { v } = setup();
	const alice = actor(v, "alice@example.com", "1", "60000");
	assert.throws(() => v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "buy", price: 0n, baseAmount: parse("1", BTC) }), /price must be positive/);
	assert.throws(() => v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: 1n }), /minimum order/);
	assert.throws(() => v.placeOrder({ accountId: alice, market: "NOPE-USDT", side: "buy", price: 1n, baseAmount: 1n }), VenueError);
});

test("quoteFor scales by the BASE asset's decimals", () => {
	// price is quote-units per WHOLE base unit, so this is the one place a
	// decimals mistake would silently misprice every order on the venue.
	assert.equal(quoteFor(parse("1", BTC), parse("50000", USDT), 8), parse("50000", USDT));
	assert.equal(quoteFor(parse("0.5", BTC), parse("50000", USDT), 8), parse("25000", USDT));
	// 18-decimal base against a 6-decimal quote.
	assert.equal(
		quoteFor(parse("2", { symbol: "ETH", decimals: 18 }), parse("3000", USDT), 18),
		parse("6000", USDT),
	);
});

test("trade and order history is readable, and trades are append-only", () => {
	const { v, db } = setup();
	const alice = actor(v, "alice@example.com", "0", "60000");
	const bob = actor(v, "bob@example.com", "1", "0");
	v.placeOrder({ accountId: bob, market: "BTC-USDT", side: "sell", price: parse("50000", USDT), baseAmount: parse("1", BTC) });
	v.placeOrder({ accountId: alice, market: "BTC-USDT", side: "buy", price: parse("50000", USDT), baseAmount: parse("1", BTC) });

	const trades = v.recentTrades("BTC-USDT");
	assert.equal(trades.length, 1);
	assert.equal(trades[0]!.takerSide, "buy");
	assert.equal(v.myOrders(alice).length, 1);

	assert.throws(() => db.exec(`UPDATE trade SET price = '1'`), /append-only/);
	assert.throws(() => db.exec(`DELETE FROM trade`), /append-only/);
});

test("A FULL SESSION OF TRADING STAYS SOLVENT TO THE UNIT", () => {
	// Not a benchmark — a property check at a size where a sign error or an
	// off-by-one in the matcher would have surfaced.
	const { l, v } = setup();
	const traders: string[] = [];
	for (let i = 0; i < 8; i++) {
		traders.push(actor(v, `t${i}@example.com`, "2", "150000"));
	}
	let placed = 0;
	for (let round = 0; round < 40; round++) {
		const who = traders[round % traders.length]!;
		const side = round % 2 === 0 ? "sell" : "buy";
		// Deterministic prices around 50k, so the book genuinely crosses.
		const px = parse(String(49_000 + ((round * 137) % 2_000)), USDT);
		try {
			v.placeOrder({
				accountId: who, market: "BTC-USDT", side,
				price: px, baseAmount: parse("0.05", BTC),
			});
			placed++;
		} catch (e) {
			// Running out of one asset is legitimate; the point is that it
			// never leaves the books broken.
			assert.ok(e instanceof VenueError, String(e));
		}
	}
	assert.ok(placed > 20, `expected most orders to place, got ${placed}`);
	assert.ok(v.recentTrades("BTC-USDT", 200).length > 0, "some trades must have happened");
	assertSolvent(l, ["BTC", "USDT"]);
});

// -----------------------------------------------------------------------------
// FUNDS RESERVATION.
//
// Added after finding that `placeOrder` checked the raw ledger balance and
// reserved nothing, so the same funds could back any number of resting orders.
// Nothing could be stolen — the ledger refuses an overdraw — but the SETTLEMENT
// then failed, and because it failed inside the incoming order's transaction it
// unwound that order entirely. One account with 1 BTC could rest five 1 BTC
// asks and every buy that reached past the first failed, for no visible reason,
// for anyone. A market denial of service costing one BTC.
// -----------------------------------------------------------------------------

/** Credit a balance directly, bypassing the faucet's asset table. */
function fundUser(l: Ledger, who: string, asset: string, amt: bigint, key: string): void {
	const custodyId = asset === "USDT" ? "USDT.TRC20" : asset;
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amt },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: custodyId }, delta: amt },
			{ account: { kind: AccountKind.USER, owner: who, asset }, delta: amt },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amt },
		],
		idempotencyKey: `fu:${key}`,
		actor: "test",
	});
}

test("THE SAME FUNDS CANNOT BACK TWO RESTING ORDERS", () => {
	const { l, v } = setup();
	const a = v.register("a@x.com", "correct horse battery staple").id;
	fundUser(l, a, "BTC", 100_000_000n, "r1"); // exactly 1 BTC

	v.placeOrder({
		accountId: a,
		market: "BTC-USDT",
		side: "sell",
		price: 100_000n * 10n ** 6n,
		baseAmount: 100_000_000n,
	});
	assert.throws(
		() =>
			v.placeOrder({
				accountId: a,
				market: "BTC-USDT",
				side: "sell",
				price: 100_000n * 10n ** 6n,
				baseAmount: 100_000_000n,
			}),
		(e: unknown) => {
			// And the refusal explains itself, rather than claiming the account
			// is empty when it visibly holds a bitcoin.
			assert.match(String(e), /already committed to open orders/);
			return true;
		},
	);
});

test("balances separate total, reserved and available", () => {
	const { l, v } = setup();
	const a = v.register("a@x.com", "correct horse battery staple").id;
	fundUser(l, a, "BTC", 100_000_000n, "r2");

	const before = v.balances(a).find((b) => b.asset === "BTC")!;
	assert.equal(before.total, 100_000_000n);
	assert.equal(before.reserved, 0n);
	assert.equal(before.available, 100_000_000n);

	v.placeOrder({
		accountId: a,
		market: "BTC-USDT",
		side: "sell",
		price: 100_000n * 10n ** 6n,
		baseAmount: 40_000_000n,
	});

	const after = v.balances(a).find((b) => b.asset === "BTC")!;
	assert.equal(after.total, 100_000_000n, "the coins are still theirs");
	assert.equal(after.reserved, 40_000_000n, "but committed to the book");
	assert.equal(after.available, 60_000_000n);
});

test("a buy reserves QUOTE at its own limit price", () => {
	const { l, v } = setup();
	const a = v.register("a@x.com", "correct horse battery staple").id;
	fundUser(l, a, "USDT", 100_000n * 10n ** 6n, "r3");

	v.placeOrder({
		accountId: a,
		market: "BTC-USDT",
		side: "buy",
		price: 50_000n * 10n ** 6n,
		baseAmount: 100_000_000n, // 1 BTC at 50k = 50,000 USDT
	});
	const b = v.balances(a).find((x) => x.asset === "USDT")!;
	assert.equal(b.reserved, 50_000n * 10n ** 6n);
	assert.equal(b.available, 50_000n * 10n ** 6n);
});

test("cancelling releases the reservation", () => {
	const { l, v } = setup();
	const a = v.register("a@x.com", "correct horse battery staple").id;
	fundUser(l, a, "BTC", 100_000_000n, "r4");
	const r = v.placeOrder({
		accountId: a,
		market: "BTC-USDT",
		side: "sell",
		price: 100_000n * 10n ** 6n,
		baseAmount: 100_000_000n,
	});
	v.cancelOrder(a, r.order.id);
	assert.equal(v.balances(a).find((b) => b.asset === "BTC")!.available, 100_000_000n);
});

test("a PARTIAL fill releases only the filled portion's reservation", () => {
	const { l, v } = setup();
	const maker = v.register("m@x.com", "correct horse battery staple").id;
	const taker = v.register("t@x.com", "correct horse battery staple").id;
	fundUser(l, maker, "BTC", 100_000_000n, "r5");
	fundUser(l, taker, "USDT", 200_000n * 10n ** 6n, "r6");

	v.placeOrder({
		accountId: maker,
		market: "BTC-USDT",
		side: "sell",
		price: 100_000n * 10n ** 6n,
		baseAmount: 100_000_000n,
	});
	// Take a quarter of it.
	v.placeOrder({
		accountId: taker,
		market: "BTC-USDT",
		side: "buy",
		price: 100_000n * 10n ** 6n,
		baseAmount: 25_000_000n,
	});

	const b = v.balances(maker).find((x) => x.asset === "BTC")!;
	assert.equal(b.total, 75_000_000n, "a quarter of a BTC was sold");
	assert.equal(b.reserved, 75_000_000n, "the rest is still on the book");
	assert.equal(b.available, 0n);
});

test("A MAKER WHO CANNOT DELIVER IS CANCELLED, AND THE TAKER STILL TRADES", () => {
	// Reservation makes this unreachable for new orders, but orders placed
	// before the fix are still on the live book and an operator correction can
	// also leave a maker short. The failure must be contained to that maker.
	const { l, v, db } = setup();
	const bad = v.register("bad@x.com", "correct horse battery staple").id;
	const good = v.register("good@x.com", "correct horse battery staple").id;
	const taker = v.register("t@x.com", "correct horse battery staple").id;
	fundUser(l, bad, "BTC", 100_000_000n, "c1");
	fundUser(l, good, "BTC", 100_000_000n, "c2");
	fundUser(l, taker, "USDT", 500_000n * 10n ** 6n, "c3");

	// `bad` rests a legitimate ask at the better price...
	const badOrder = v.placeOrder({
		accountId: bad,
		market: "BTC-USDT",
		side: "sell",
		price: 90_000n * 10n ** 6n,
		baseAmount: 100_000_000n,
	});
	// `good` rests behind it.
	const goodOrder = v.placeOrder({
		accountId: good,
		market: "BTC-USDT",
		side: "sell",
		price: 95_000n * 10n ** 6n,
		baseAmount: 100_000_000n,
	});

	// ...and then the BTC leaves their account behind the engine's back, which
	// is what a pre-fix overcommitment or a correction looks like at fill time.
	l.post({
		reason: Reason.ADJUSTMENT,
		postings: [
			{ account: { kind: AccountKind.USER, owner: bad, asset: "BTC" }, delta: -100_000_000n },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "BTC" }, delta: 100_000_000n },
		],
		idempotencyKey: "seize",
		actor: "ops",
		note: "simulating a maker left short",
	});

	const r = v.placeOrder({
		accountId: taker,
		market: "BTC-USDT",
		side: "buy",
		price: 95_000n * 10n ** 6n,
		baseAmount: 100_000_000n,
	});

	// THE TAKER TRADED, against the order that could actually deliver.
	assert.equal(r.fills, 1, "the taker was not punished for someone else's shortfall");
	assert.equal(v.order(goodOrder.order.id)?.state, "filled");
	// And the maker that could not deliver is off the book rather than left
	// there to break the next order too.
	assert.equal(v.order(badOrder.order.id)?.state, "cancelled");
	void db;
});
