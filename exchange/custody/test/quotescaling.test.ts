// -----------------------------------------------------------------------------
// PRICE SCALING ACROSS SIX QUOTE ASSETS, AND THE MIGRATION SAFETY OF THE 25
// MARKETS THAT EXISTED BEFORE THERE WERE SIX.
//
// The quote expansion took the venue from two quote assets to six, which means
// a price is now written against a 6-decimal (USDT, USDC), an 8-decimal (BTC),
// a 9-decimal (SOL) or an 18-decimal (ETH) quote, and on twelve markets it
// carries extra `priceDecimals` on top of that. Four different scales reach the
// same `quoteFor`.
//
// A MISTAKE HERE DOES NOT THROW. That is the entire reason this file exists.
// Every wrong answer in this area is a valid price that happens to be a power
// of ten away from the right one: the order rests, the book displays, the match
// settles, the ledger proves out, and the only sign of trouble is that a
// customer bought a coin for ten thousand times what they meant to pay. There
// is no exception to catch and no invariant to violate, so the arithmetic has
// to be pinned by example at every scale it is used at.
//
// The examples below are deliberately written as "a human types X, the engine
// must store Y, and it must render X again". Round-tripping is what catches a
// scale error, because a scale error is exactly the thing that survives one
// direction and fails the other.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { format, parse } from "../src/amount";
import { assetDef, custodyIds } from "../src/assets";
import { AccountKind, Ledger } from "../src/ledger";
import {
	MARKETS,
	MIN_NOTIONAL,
	OPEN_MARKETS,
	QUOTE_SENIORITY,
	Venue,
	market,
	priceKey,
	priceScale,
	quoteFor,
} from "../src/venue";
import { UNIT_SCALE } from "../src/settlement";
import { LIVE_FEES, quoteWithdrawal } from "../src/withdrawalfees";

/* ------------------------------------------------ the four decimal classes */

/*
 * ONE REPRESENTATIVE MARKET PER QUOTE-DECIMAL CLASS.
 *
 * ETH (18) and SOL (9) have no OPEN market, because neither asset can take a
 * deposit yet — BitGo refuses receive addresses on the ETH wallet without a
 * pricing plan and the SOL custody wallet is not initialised on chain. Their
 * arithmetic is still pinned here, and that is on purpose: the scale that gets
 * a market wrong is the scale nobody exercised before it opened, and these two
 * are the extreme ends of the range. The day a rail opens should not also be
 * the day its price arithmetic is first tried.
 */
const CLASSES = [
	{ quote: "USDT", decimals: 6, via: "BTC-USDT" },
	{ quote: "BTC", decimals: 8, via: "DOGE-BTC" },
	{ quote: "SOL", decimals: 9, via: undefined },
	{ quote: "ETH", decimals: 18, via: undefined },
] as const;

test("the four quote-decimal classes are the ones the registry actually declares", () => {
	// Guards the premise of every test below. If USDC were ever redefined to 2
	// decimals, the examples here would still pass while testing nothing about
	// the live venue, so the classes are checked against the registry.
	for (const c of CLASSES) {
		assert.equal(
			assetDef(c.quote).decimals,
			c.decimals,
			`${c.quote} is meant to be the ${c.decimals}-decimal class`,
		);
	}
	assert.equal(assetDef("USDC").decimals, 6, "USDC shares USDT's class");
	assert.equal(assetDef("BLOCK").decimals, 8, "BLOCK shares BTC's class");
});

test("QUOTE_SCALE: quoteFor is exact at 6, 8, 9 and 18 decimal quotes", () => {
	/*
	 * `quoteFor(baseAmount, price, baseDecimals, priceDecimals)` answers "what
	 * does this much base cost at this price", and the quote's own decimals
	 * never appear in it — they are carried implicitly by the price's unit.
	 * That is correct and it is also the easiest thing in this file to get
	 * wrong, so each class is checked against a figure worked out by hand.
	 */

	// 6-decimal quote: 1 BTC at 90,000 USDT costs 90,000 USDT.
	assert.equal(
		quoteFor(parse("1", { symbol: "BTC", decimals: 8 }), parse("90000", { symbol: "USDT", decimals: 6 }), 8),
		parse("90000", { symbol: "USDT", decimals: 6 }),
	);
	// ...and a fraction of the base scales the cost, not the price.
	assert.equal(
		quoteFor(parse("0.25", { symbol: "BTC", decimals: 8 }), parse("90000", { symbol: "USDT", decimals: 6 }), 8),
		parse("22500", { symbol: "USDT", decimals: 6 }),
	);

	// 8-decimal quote with priceDecimals 2 (DOGE-BTC). One DOGE is ~0.0000018
	// BTC, which is 180 satoshi; with two extra places the price integer counts
	// HUNDREDTHS of a satoshi, so it is 18,000. 10,000 DOGE then costs 0.018
	// BTC. Drop the priceDecimals argument and the same call returns 1.8 BTC —
	// a hundred times too much, with nothing raised.
	assert.equal(
		quoteFor(parse("10000", { symbol: "DOGE", decimals: 8 }), 18_000n, 8, 2),
		parse("0.018", { symbol: "BTC", decimals: 8 }),
	);
	assert.equal(
		quoteFor(parse("10000", { symbol: "DOGE", decimals: 8 }), 18_000n, 8),
		parse("1.8", { symbol: "BTC", decimals: 8 }),
		"the wrong answer the priceDecimals argument exists to prevent",
	);

	// 9-decimal quote (SOL). 2 DOGE-worth at 0.0000008 SOL each.
	assert.equal(
		quoteFor(parse("1000", { symbol: "DOGE", decimals: 8 }), parse("0.0000008", { symbol: "SOL", decimals: 9 }), 8),
		parse("0.0008", { symbol: "SOL", decimals: 9 }),
	);

	// 18-decimal quote (ETH), the class where a `number` would already have
	// lost the value: 2 BTC at 30 ETH is 60 ETH = 6e19 wei, well past
	// Number.MAX_SAFE_INTEGER.
	assert.equal(
		quoteFor(parse("2", { symbol: "BTC", decimals: 8 }), parse("30", { symbol: "ETH", decimals: 18 }), 8),
		60_000_000_000_000_000_000n,
	);
	assert.equal(
		format(60_000_000_000_000_000_000n, { symbol: "ETH", decimals: 18 }),
		"60",
		"and it renders back as a whole number of ETH, not in exponent form",
	);
});

test("PRICE_SCALE IS THE QUOTE'S DECIMALS PLUS THE MARKET'S, never just the quote's", () => {
	/*
	 * The bug this pins was live: every price parse and format in the HTTP
	 * layer used `assetDef(m.quote).decimals` alone. On the twelve markets that
	 * carry priceDecimals that under-scales a submitted price and over-scales a
	 * displayed one by 10^priceDecimals — up to 10^8 on DINGO-BTC. Nothing
	 * raised, because both numbers are perfectly valid prices.
	 */
	for (const m of MARKETS) {
		assert.equal(
			priceScale(m),
			assetDef(m.quote).decimals + m.priceDecimals,
			`${m.symbol}: priceScale must carry both exponents`,
		);
	}
	const withExtra = MARKETS.filter((m) => m.priceDecimals > 0);
	assert.ok(
		withExtra.length > 0,
		"if no market carries priceDecimals, priceScale is untested in the only case it matters",
	);
	for (const m of withExtra) {
		assert.notEqual(
			priceScale(m),
			assetDef(m.quote).decimals,
			`${m.symbol} is exactly the case where the quote's decimals alone are wrong`,
		);
	}
});

test("A PRICE ROUND-TRIPS THROUGH parse AND format AT EVERY priceDecimals IN USE", () => {
	/*
	 * `format(parse(x)) === x` for every price string a customer could type, at
	 * every scale the venue actually emits. This is the assertion that would
	 * have failed on the HTTP layer before priceScale existed, and it is the
	 * cheapest guard against the next scale being added without its call sites
	 * being updated.
	 */
	const scales = [...new Set(MARKETS.map((m) => m.priceDecimals))].sort((a, b) => a - b);
	assert.ok(scales.includes(0), "the pinned markets must still be at priceDecimals 0");

	for (const m of MARKETS) {
		const ps = priceScale(m);
		const unit = { symbol: m.quote, decimals: ps };
		// The smallest price this market can express, and a mid-range one.
		for (const human of ["0.1", "1", "1.5", "12345.6789"]) {
			// Only test strings this scale can hold exactly; parse refuses the
			// rest by design, which is itself the correct behaviour.
			const stored = parse(human, unit);
			assert.equal(
				format(stored, unit),
				human,
				`${m.symbol} at priceScale ${ps}: ${human} must survive a round trip`,
			);
		}
		// One tick — the smallest non-zero price — must be representable, or no
		// order could be priced in this market at all.
		assert.ok(parse(format(1n, unit), unit) === 1n, `${m.symbol}: one tick must round-trip`);
	}
});

test("THE SAME HUMAN PRICE MEANS DIFFERENT INTEGERS ON TWO MARKETS, and both are right", () => {
	// A price integer is NOT comparable across markets, and that is the single
	// most dangerous thing about priceDecimals. "0.0000018 BTC" is 180 on a
	// market with no extra places and 18,000 on DOGE-BTC, which has two.
	const doge = market("DOGE-BTC");
	assert.equal(doge.priceDecimals, 2);
	assert.equal(market("BTC-USDT").priceDecimals, 0);

	assert.equal(
		parse("0.0000018", { symbol: "BTC", decimals: assetDef("BTC").decimals }),
		180n,
		"unscaled, this price is 180 satoshi",
	);
	assert.equal(
		parse("0.0000018", { symbol: "BTC", decimals: priceScale(doge) }),
		18_000n,
		"on DOGE-BTC the same price counts hundredths of a satoshi",
	);
});

test("WITHOUT priceDecimals THE HONEST PRICE OF A TAIL COIN CANNOT BE WRITTEN DOWN", () => {
	/*
	 * This is the reason priceDecimals exists, and it is a refusal rather than a
	 * rounding: one PERBUG is worth about 1.1 satoshi, and `parse()` rejects
	 * input finer than the scale it is given instead of silently discarding the
	 * remainder. So against plain BTC the honest price is simply not expressible
	 * — not coarse, not approximate, REFUSED — and `placeOrder` refuses zero, so
	 * every order in such a market would be rejected. A miner trying to sell
	 * would be the one to discover it.
	 */
	const perbug = market("PERBUG-BTC");
	assert.ok(perbug.priceDecimals > 0, "PERBUG-BTC must carry extra places to be priceable");

	const honest = "0.000000011"; // ~1.1 satoshi per PERBUG
	assert.throws(
		() => parse(honest, { symbol: "BTC", decimals: assetDef("BTC").decimals }),
		/needs more and would lose value/,
		"at BTC's own 8 decimals this price is refused outright",
	);
	const scaled = parse(honest, { symbol: "BTC", decimals: priceScale(perbug) });
	assert.ok(scaled > 1000n, `with priceDecimals it has real resolution, got ${scaled}`);
	assert.equal(
		format(scaled, { symbol: "BTC", decimals: priceScale(perbug) }),
		honest,
		"and it renders back exactly as typed",
	);
});

/* ------------------------------------------------- the int64 comparison fix */

test("PRICE KEYS ORDER CORRECTLY ACROSS THE int64 BOUNDARY", () => {
	/*
	 * SQLite's INTEGER is int64 and CAST CLAMPS rather than erroring, so
	 * `CAST('9300000000000000000' AS INTEGER)` and
	 * `CAST('9500000000000000000' AS INTEGER)` were both 9223372036854775807 and
	 * compared EQUAL. In the matcher that meant a buy could cross a sell priced
	 * above its own limit while having reserved only its own lower limit —
	 * overdrawing, and cancelling an innocent maker on the way out.
	 *
	 * This is not hypothetical for an 18-decimal quote: 9.22e18 wei is ~9.2 ETH,
	 * which is one ordinary price level on an ETH-quoted book.
	 */
	const db = new Database(":memory:");
	const clamped = db
		.prepare("SELECT CAST(? AS INTEGER) AS a, CAST(? AS INTEGER) AS b")
		.get("9300000000000000000", "9500000000000000000") as { a: number; b: number };
	assert.equal(clamped.a, clamped.b, "the clamp this fix exists for is real in this very build");

	const lo = 9_300_000_000_000_000_000n;
	const hi = 9_500_000_000_000_000_000n;
	assert.ok(priceKey(lo) < priceKey(hi), "zero-padded keys keep the order the CAST destroyed");
	assert.equal(priceKey(lo).length, priceKey(hi).length, "keys must be equal width to compare");

	// SQLite's own TEXT comparison, which is what the matcher now uses.
	const sorted = db
		.prepare("SELECT ? AS k UNION ALL SELECT ? ORDER BY k ASC")
		.all(priceKey(hi), priceKey(lo)) as { k: string }[];
	assert.deepEqual([sorted[0]!.k, sorted[1]!.k], [priceKey(lo), priceKey(hi)]);
	db.close();

	// A price too wide to key is refused rather than silently truncated: a
	// truncated key sorts wrongly, and a wrong sort crosses at the wrong price.
	assert.throws(() => priceKey(10n ** 40n), /outside the range/);
	assert.throws(() => priceKey(-1n), /outside the range/);
});

/* --------------------------------------------------------- migration safety */

/*
 * THE 25 SYMBOLS THAT WERE LIVE BEFORE THE EXPANSION, WRITTEN OUT.
 *
 * A golden list, not a count. A count test passes when a symbol is replaced by
 * a different one, which is the failure that actually matters: flipping a live
 * symbol's orientation orphans every resting order and historical trade in it,
 * because the `ord` and `trade` rows keep the old symbol while `MARKETS.find`
 * stops matching — at which point `reserved()` quietly stops counting the funds
 * those orders commit and the balances screen offers the customer money that is
 * still pledged to a book nobody can see or cancel.
 *
 * Some of these orientations are NOT what a clean-sheet seniority rule would
 * choose (`USDC-BLOCK` and `BTC-BLOCK` would have been written the other way).
 * They are historical, and keeping them is the whole point.
 */
const GOLDEN_25: readonly string[] = [
	"BTC-USDT", "ETH-USDT", "USDC-USDT", "SOL-USDT", "DOGE-USDT", "TRX-USDT",
	"XRP-USDT", "BNB-USDT", "BLOCK-USDT", "PERBUG-USDT", "PEP-USDT",
	"DINGO-USDT", "RTM-USDT",
	"BTC-BLOCK", "ETH-BLOCK", "USDC-BLOCK", "SOL-BLOCK", "DOGE-BLOCK",
	"TRX-BLOCK", "XRP-BLOCK", "BNB-BLOCK", "PERBUG-BLOCK", "PEP-BLOCK",
	"DINGO-BLOCK", "RTM-BLOCK",
];

test("ALL 25 PRE-EXPANSION SYMBOLS STILL EXIST, with their original orientation", () => {
	assert.equal(GOLDEN_25.length, 25, "the golden list is the 25 that were live");
	const have = new Set(MARKETS.map((m) => m.symbol));
	for (const sym of GOLDEN_25) {
		assert.ok(have.has(sym), `${sym} was a live market and must not have been deleted`);
		// And the inverse must NOT have appeared alongside it.
		const [base, quote] = sym.split("-") as [string, string];
		assert.ok(
			!have.has(`${quote}-${base}`),
			`${quote}-${base} is ${sym} inverted — the same book twice`,
		);
	}
});

test("A PRE-EXPANSION MARKET'S PRICE SCALE IS UNCHANGED, so no stored price moves", () => {
	/*
	 * priceDecimals is part of the wire format: changing it on a market that
	 * already holds orders or trades rescales every stored price by a power of
	 * ten. Every pinned market must therefore still be at 0 — with the single
	 * audited exception of DINGO-USDT, where the true price (0.1) was never
	 * writable at all, so there is no real price to rescale. That exception is
	 * gated on the deploy confirming the market is empty.
	 */
	for (const sym of GOLDEN_25) {
		const m = market(sym);
		if (sym === "DINGO-USDT") {
			assert.ok(m.priceDecimals > 0, "DINGO-USDT is rescaled deliberately; see PINNED_PRICE_DECIMALS");
			continue;
		}
		assert.equal(
			m.priceDecimals,
			0,
			`${sym} held real prices at priceDecimals 0 — changing it rescales them by 10^n`,
		);
	}
});

/* ------------------------------------------------------ minimums stay sound */

test("EVERY QUOTE'S MIN_NOTIONAL EXCEEDS THE COST OF WITHDRAWING IT", () => {
	/*
	 * The bar MIN_BASE already meets, applied to the quote side: an order whose
	 * entire proceeds are eaten by the fee to move them is an order that loses
	 * the customer money by filling. Asserted against LIVE_FEES rather than
	 * trusting the comment beside the table, because the fee table and the
	 * minimums are edited by different people at different times.
	 */
	for (const quote of QUOTE_SENIORITY) {
		const floor = MIN_NOTIONAL[quote];
		assert.ok(floor !== undefined, `${quote} is a quote asset and needs a MIN_NOTIONAL`);
		assert.ok(floor! > 0n, `${quote}'s MIN_NOTIONAL must be positive`);

		// The cheapest chain this quote can actually be withdrawn over.
		let cheapest: bigint | undefined;
		for (const chain of custodyIds(quote)) {
			if (LIVE_FEES[chain] === undefined) continue;
			try {
				const q = quoteWithdrawal({
					asset: quote,
					network: chain.includes(".") ? chain.split(".")[1]! : undefined,
					amount: floor!,
					table: LIVE_FEES,
				});
				if (cheapest === undefined || q.fee < cheapest) cheapest = q.fee;
			} catch {
				// A chain that cannot be quoted cannot be the cheapest one.
			}
		}
		assert.ok(cheapest !== undefined, `${quote} has no priced withdrawal chain to measure against`);
		assert.ok(
			floor! > cheapest!,
			`${quote}'s minimum order (${format(floor!, { symbol: quote, decimals: assetDef(quote).decimals })}) ` +
				`does not cover its own withdrawal fee (${format(cheapest!, { symbol: quote, decimals: assetDef(quote).decimals })})`,
		);
	}
});

test("every market's minimums are in the right asset's units", () => {
	// minBase is in BASE units and minNotional in QUOTE units. They are both
	// bigints, so swapping them is a silent, enormous error.
	for (const m of MARKETS) {
		assert.ok(m.minBase > 0n, `${m.symbol} must have a positive minBase`);
		assert.equal(
			m.minNotional,
			MIN_NOTIONAL[m.quote],
			`${m.symbol}'s minNotional must be its QUOTE's floor, not its base's`,
		);
	}
});

/* ------------------------------- the engine, end to end, on a scaled market */

test("AN ORDER ON A priceDecimals MARKET FILLS AT THE PRICE THE CUSTOMER TYPED", () => {
	/*
	 * The whole chain at once on DOGE-BTC (8-decimal quote, 2 extra places):
	 * a human price string, parsed at priceScale, through placeOrder, matched,
	 * and settled — with the BTC that changes hands checked against a figure
	 * computed by hand rather than by the code under test.
	 *
	 * 50,000 DOGE at 0.0000018 BTC each is 0.09 BTC. If priceDecimals were
	 * dropped anywhere along that path the answer would be 9 BTC or 0.0009 BTC,
	 * and nothing would have thrown.
	 */
	const db = new Database(":memory:");
	const l = new Ledger(db);
	const v = new Venue(db, l, undefined, { mainnetEnabled: false });
	const m = market("DOGE-BTC");

	const DOGE = { symbol: "DOGE", decimals: assetDef("DOGE").decimals };
	const BTC = { symbol: "BTC", decimals: assetDef("BTC").decimals };
	const priceUnit = { symbol: "BTC", decimals: priceScale(m) };

	const seller = v.register("seller@example.com", "a-sufficiently-long-password").id;
	const buyer = v.register("buyer@example.com", "a-sufficiently-long-password").id;
	v.testnetCredit(seller, "DOGE", parse("50000", DOGE), "DOGE");
	v.testnetCredit(buyer, "BTC", parse("1", BTC), "BTC");

	const price = parse("0.0000018", priceUnit);
	assert.equal(price, 18_000n, "the price integer carries the two extra places");

	v.placeOrder({
		accountId: seller,
		market: m.symbol,
		side: "sell",
		price,
		baseAmount: parse("50000", DOGE),
	});
	v.placeOrder({
		accountId: buyer,
		market: m.symbol,
		side: "buy",
		price,
		baseAmount: parse("50000", DOGE),
	});

	const expected = parse("0.09", BTC); // 50,000 * 0.0000018, by hand
	assert.equal(
		quoteFor(parse("50000", DOGE), price, DOGE.decimals, m.priceDecimals),
		expected,
		"the arithmetic the engine used must match the hand-computed cost",
	);

	/*
	 * BOTH SIDES RECEIVE THEIR LEG NET OF THE TRADING FEE, so the assertion is a
	 * tight band just under the gross rather than equality. The band is what
	 * makes this a scale test: a dropped priceDecimals moves the BTC leg by a
	 * factor of 100, which no fee could ever account for, while the fee itself
	 * is a fraction of a percent.
	 */
	const grossDoge = parse("50000", DOGE);
	const sellerBtc = l.balance({ kind: AccountKind.USER, owner: seller, asset: "BTC" });
	const buyerDoge = l.balance({ kind: AccountKind.USER, owner: buyer, asset: "DOGE" });

	assert.ok(
		buyerDoge <= grossDoge && buyerDoge > (grossDoge * 99n) / 100n,
		`buyer got ${format(buyerDoge, DOGE)} DOGE, expected just under ${format(grossDoge, DOGE)}`,
	);
	assert.ok(
		sellerBtc <= expected && sellerBtc > (expected * 99n) / 100n,
		`seller got ${format(sellerBtc, BTC)} BTC, expected just under ${format(expected, BTC)}`,
	);
	// And the figure a dropped priceDecimals would have produced is nowhere near
	// the band, which is the point of checking a band at all.
	assert.ok(sellerBtc < expected * 2n, "a 100x misprice would blow straight through this");

	assert.deepEqual(l.verify().ok, true, "the ledger still proves out");
	db.close();
});

test("A CLOSED MARKET REFUSES ORDERS BUT KEEPS ITS SYMBOL", () => {
	// Three states exist, not two. A closed market must still resolve, because
	// deleting the symbol is what orphans resting orders.
	const closed = MARKETS.filter((m) => m.closed !== undefined);
	assert.ok(closed.length > 0, "the settlement gate closes markets; one must exist to test");
	for (const m of closed) {
		assert.equal(market(m.symbol).symbol, m.symbol, `${m.symbol} must still resolve`);
		assert.ok(
			!OPEN_MARKETS.some((o) => o.symbol === m.symbol),
			`${m.symbol} is closed and must not be in OPEN_MARKETS`,
		);
	}

	const db = new Database(":memory:");
	const l = new Ledger(db);
	const v = new Venue(db, l, undefined, { mainnetEnabled: false });
	const m = closed[0]!;
	const who = v.register("shut@example.com", "a-sufficiently-long-password").id;
	assert.throws(
		() =>
			v.placeOrder({
				accountId: who,
				market: m.symbol,
				side: "buy",
				price: 1n,
				baseAmount: m.minBase,
			}),
		// The refusal must be the gate's own sentence, not a generic error: it is
		// what the customer reads.
		(e: Error) => e.message === m.closed,
		`${m.symbol} must refuse orders with its own reason`,
	);
	db.close();
});

/* ------------------------------------------------ BLOCK is never priced in USD */

test("UNIT_SCALE IS MEASURED IN SATOSHIS AND HAS NO BLOCK ENTRY", () => {
	/*
	 * UNIT_SCALE is an order-of-magnitude estimate used only to decide whether a
	 * price is EXPRESSIBLE. It is the one judgement in a file of measurements,
	 * and if it were denominated in dollars then its BLOCK entry would be a USD
	 * price for BLOCK sitting in the repo — the hard product rule broken by the
	 * mechanism meant to keep the venue honest.
	 *
	 * Two things keep that from being true, and both are asserted rather than
	 * commented: the table is denominated in satoshis, and BLOCK is absent from
	 * it entirely (its expressibility is settled by its pinned live symbols, so
	 * the generator never needs a magnitude for it).
	 */
	assert.equal(
		UNIT_SCALE["BLOCK"],
		undefined,
		"BLOCK must have no magnitude entry — see the comment above UNIT_SCALE",
	);
	// The satoshi basis, asserted at its anchor: 1 BTC is 10^8 satoshi by
	// definition, so BTC's entry being 8 is what makes every other entry a
	// satoshi exponent rather than a dollar one.
	assert.equal(UNIT_SCALE["BTC"]!.value, 8, "the table is denominated in satoshis");
	for (const [sym, mag] of Object.entries(UNIT_SCALE)) {
		assert.ok(Number.isInteger(mag.value), `${sym}'s magnitude must be an integer exponent`);
		assert.ok(mag.source.length > 0, `${sym}'s magnitude must name its source`);
		assert.ok(mag.asOf.length > 0, `${sym}'s magnitude must be dated`);
	}
});

test("NO MAGNITUDE ESTIMATE REACHES AN HTTP RESPONSE OR A GENERATED PAGE", () => {
	/*
	 * UNIT_SCALE gates whether a price is expressible and nothing else. If one
	 * of its exponents were ever served or rendered it would be the venue
	 * publishing a price estimate it has explicitly told the operator not to
	 * trust — accurate to a factor of ten, so a price derived from it would be
	 * wrong by up to 10x — and for a BLOCK pair it would be a USD price for
	 * BLOCK by one conversion. The table has no BLOCK entry, so the second
	 * cannot happen; this pins the first.
	 *
	 * Checked structurally: the Market records that ARE published carry no
	 * magnitude field, so there is nothing for a response builder to pick up by
	 * accident.
	 */
	for (const m of MARKETS) {
		for (const key of Object.keys(m)) {
			assert.ok(
				!/scale|magnitude|unitScale|usd/i.test(key),
				`Market.${key} on ${m.symbol} looks like a price estimate on the wire`,
			);
		}
	}
	// priceDecimals IS published, and must not be confused for a magnitude: it
	// is an exact wire-format fact about the market, not an estimate of value.
	assert.ok(
		MARKETS.every((m) => Number.isInteger(m.priceDecimals) && m.priceDecimals >= 0),
		"priceDecimals is an exact non-negative integer, unlike a magnitude estimate",
	);
});

test("NO BLOCK MARKET WAS ADDED BY THE EXPANSION", () => {
	/*
	 * "Never render a USD price for BLOCK, including via a crypto conversion" is
	 * violated by one multiplication the moment a new BLOCK cross exists and
	 * anyone knows that leg's USD price. BLOCK already traded against all five
	 * requested quotes before this change, so the correct number of new BLOCK
	 * pairs is zero — and that is a rule here, not a lucky consequence of the
	 * generator's iteration order.
	 *
	 * The pre-existing `BLOCK-USDT` and `USDC-BLOCK` exposure is exactly that,
	 * pre-existing. It is raised with the user rather than widened here.
	 */
	const blockPairs = MARKETS.filter((m) => m.base === "BLOCK" || m.quote === "BLOCK")
		.map((m) => m.symbol)
		.sort();
	const goldenBlock = GOLDEN_25.filter((s) => s.includes("BLOCK")).slice().sort();
	assert.deepEqual(
		blockPairs,
		goldenBlock,
		"the expansion must not mint a single new BLOCK pair",
	);
});
