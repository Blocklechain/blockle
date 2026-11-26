// -----------------------------------------------------------------------------
// THE CUSTODIAL VENUE — accounts, balances, a matching engine, and settlement.
//
// This is what makes it an exchange rather than a landing page. Everything
// settles through the double-entry ledger in ledger.ts, with the 0.2% fees from
// fees.ts, so every property already proven there holds here: conservation,
// no negative balances, idempotency, an append-only audit trail.
//
// WHAT IS DELIBERATELY NOT HERE.
//
// No real deposits. On testnet, funding is an explicit, clearly-labelled
// testnet credit. Wiring real BitGo deposit webhooks is a separate change and
// it must not be possible to confuse the two — so the testnet credit refuses
// to run at all when the mainnet gate is on. A venue that can mint balances
// in production is not a venue, it is a rug.
//
// THE MATCHING ENGINE IS PRICE-TIME PRIORITY, AND IT RUNS INSIDE ONE SQLITE
// TRANSACTION PER INCOMING ORDER. That matters more than its sophistication:
// an order that half-matches and then fails must leave no trace, or balances
// and the book disagree. Taking the write lock for the whole match is what
// makes "all fills or none" true rather than aspirational.
//
// PRICES ARE INTEGERS, SCALED. A price is "quote base-units per ONE whole unit
// of base, times 10^priceDecimals", held as a bigint. No floats anywhere: the
// whole point of this service existing separately from TradeXPro's PHP is that
// `bcaddx(x, "0") !== x` over there.
//
// `priceDecimals` is per market and is 0 for every market that existed before
// the quote expansion, so that sentence used to be the shorter one. It is not
// an improvement in resolution for its own sake: against an 8-decimal quote
// one satoshi is worth more than one PERBUG, and without it a PEP-BTC price
// could not be written down at all. See Market.priceDecimals.
//
// PRICES ARE COMPARED ON `price_key`, NOT ON `price`. SQLite's INTEGER is int64
// and it CLAMPS rather than erroring, so `CAST('9300000000000000000' AS
// INTEGER)` and `CAST('9500000000000000000' AS INTEGER)` are both
// 9223372036854775807 and compare EQUAL — which, in the matcher, meant a buy
// could cross a sell priced above its own limit while having reserved only its
// own lower limit. `price_key` is the same number zero-padded to a fixed width,
// where lexicographic order is exact for any bigint.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";

import { assetDef } from "./assets";
import { DEFAULT_FEES, Side, fillKey, fillPostings, type FeeSchedule } from "./fees";
import { AccountKind, InsufficientFunds, Reason, type Ledger } from "./ledger";
import { expressible, isQuoteAsset, orient, settleable } from "./settlement";

export class VenueError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "VenueError";
	}
}

export type OrderSide = "buy" | "sell";

export interface Market {
	readonly symbol: string;
	readonly base: string;
	readonly quote: string;
	/** Smallest tradable base amount, in base units. */
	readonly minBase: bigint;
	/**
	 * Smallest tradable VALUE, in quote base units. See MIN_NOTIONAL — minBase
	 * alone cannot bound the quote side, and with six quotes the economic size
	 * of `minBase` worth of a tail coin varies by nine orders of magnitude.
	 */
	readonly minNotional: bigint;
	/**
	 * EXTRA DECIMAL PLACES THIS MARKET'S PRICE CARRIES.
	 *
	 * A price is quote base-units per one whole unit of base, multiplied by
	 * 10^priceDecimals. Zero means the historical meaning, unchanged.
	 *
	 * It exists because a quote's own decimals are not always enough. One
	 * satoshi is worth more than one PERBUG, so at priceDecimals 0 a
	 * PERBUG-BTC price could only be 1, 2 or 3 — one tick being ~100% of the
	 * price — and a PEP-BTC or DINGO-BTC price could not be written at all:
	 * `parse()` refuses sub-unit input rather than rounding and `placeOrder`
	 * refuses zero, so every order in those markets would be rejected.
	 *
	 * IT IS PER MARKET AND IT IS PART OF THE WIRE FORMAT. Changing it on a
	 * market that already holds orders or trades silently rescales every stored
	 * price by a power of ten, which is why the markets that existed before the
	 * quote expansion are pinned at 0 whatever their exponent. See
	 * PINNED_PRICE_DECIMALS.
	 */
	readonly priceDecimals: number;
	/**
	 * When this symbol first existed. Symbols are append-only, so this only
	 * ever gets older.
	 */
	readonly listedAt: string;
	/**
	 * WHY TRADING IS REFUSED, or undefined when the market is open.
	 *
	 * A closed market keeps its symbol, its book and its history. Cancels are
	 * still accepted; only `placeOrder` is refused, with this sentence. The
	 * alternative — deleting the symbol — makes `market()` throw 404, makes
	 * `MARKETS.find` in `reserved()` return undefined so the funds committed to
	 * those orders stop being counted, and hands the customer a balance that is
	 * still committed to a book nobody can see or cancel.
	 */
	readonly closed: string | undefined;
	/**
	 * A QUALIFICATION ON AN OPEN MARKET — "open, with a known gap".
	 *
	 * Not the opposite of `closed` and not a weaker form of it. A closed market
	 * refuses orders; a caveated one takes them and settles them, while one of
	 * its legs has a rail the customer should know about before they commit.
	 *
	 * Today there is exactly one source: an asset admitted by
	 * `SETTLEMENT_EXCEPTIONS`, which is BLOCK. BLOCK's deposits depend on our
	 * own node being reachable and its withdrawals are released by an operator
	 * rather than by the payout runner, so the ten BLOCK markets are genuinely
	 * open and genuinely not the same proposition as BTC-USDT.
	 *
	 * IT EXISTS BECAUSE THE CAVEAT WAS BEING PRODUCED AND THROWN AWAY.
	 * `settleable()` has returned it since the settlement gate was written, and
	 * its own comment justified the exception on the grounds that "operator
	 * output and the UI can say 'open, with a known payout gap' instead of
	 * 'open'" — while this interface had nowhere to put it, so every consumer
	 * saw `state:"open", closed:null` and nothing else. A caveat that reaches
	 * no reader is indistinguishable from a check nobody wrote.
	 */
	readonly caveat: string | undefined;
}

/**
 * Smallest tradable amount, PER BASE ASSET rather than per market.
 *
 * It is a property of the asset: the dust floor for BTC is the same whether it
 * is priced in USDT or in BLOCK. Keeping it per-market meant the figure had to
 * be repeated for every new pair, which is how one pair ends up with a floor a
 * thousand times off and nobody notices until an order behaves oddly.
 *
 * Each is roughly "the smallest amount worth the gas of eventually moving it",
 * erring large: a market full of dust orders is a market nobody can read.
 */
const MIN_BASE: Readonly<Record<string, bigint>> = {
	BTC: 1_000n,                  // 0.00001 BTC
	ETH: 10n ** 13n,              // 0.00001 ETH
	USDT: 1_000_000n,             // 1 USDT
	USDC: 1_000_000n,             // 1 USDC
	SOL: 1_000_000n,              // 0.001 SOL
	DOGE: 100_000_000n,           // 1 DOGE
	TRX: 1_000_000n,              // 1 TRX
	XRP: 1_000_000n,              // 1 XRP
	BNB: 10n ** 15n,              // 0.001 BNB
	BLOCK: 100_000n,              // 0.001 BLOCK
	PERBUG: 100_000n,             // 0.001 PERBUG
	/*
	 * The small-PoW coins. Each floor is set ABOVE that chain's own withdrawal
	 * fee (LIVE_FEES, itself measured from the daemon's relay rate), which is
	 * the only floor that means anything: an order smaller than the cost of
	 * moving the proceeds is an order whose filling loses the customer money.
	 * DINGO's is large in nominal units because its relay minimum is 1 DINGO
	 * per kB — that is the chain, not a stray zero.
	 */
	PEP: 1_000_000_000n,          // 10 PEP      (fee ~0.12 PEP)
	DINGO: 100_000_000_000n,      // 1,000 DINGO (fee ~12 DINGO)
	RTM: 1_000_000_000n,          // 10 RTM      (fee ~0.1 RTM)
};

/**
 * MINIMUM VALUE OF AN ORDER, PER QUOTE ASSET.
 *
 * MIN_BASE is still right and still per base asset, but it was never
 * sufficient, and with one quote that was easy to miss. A floor in base units
 * says nothing about what the order is WORTH, and `match()` silently skips any
 * fill whose quote amount truncates to zero ("dust that prices to nothing") —
 * so an order could rest, appear in the book, be crossed, and never fill, with
 * nothing anywhere explaining why. With six quotes the same `minBase` of DINGO
 * is worth a fraction of a satoshi against BTC and a tenth of a cent against
 * USDT, so the quote side has to be bounded too.
 *
 * ONE NUMBER PER QUOTE, NOT PER MARKET. Six numbers rather than thirty-four,
 * for the same reason MIN_BASE is per asset: a figure repeated per pair is a
 * figure that ends up a thousand times off in one of them.
 *
 * Each is set comfortably ABOVE the cost of withdrawing the proceeds on that
 * quote's own cheapest chain, computed from LIVE_FEES (gas plus its buffer plus
 * the margin) — the same bar MIN_BASE uses. An order worth less than the cost
 * of moving what it pays out is an order whose filling loses the customer
 * money. A test asserts the relationship rather than trusting these comments.
 *
 * NOT A WITHDRAWAL GUARANTEE. The fee actually charged on a token chain is
 * derived from a live gas rate (see priceGas), and on Ethereum it can exceed
 * the floor these are measured against by several times. This bounds dust, it
 * does not promise the proceeds are withdrawable at a profit.
 */
export const MIN_NOTIONAL: Readonly<Record<string, bigint>> = {
	USDT: 5_000_000n,                 // 5 USDT      (TRC-20 floor ~2.2 USDT)
	USDC: 5_000_000n,                 // 5 USDC      (TRC-20 floor ~2.2 USDC)
	BTC: 20_000n,                     // 0.0002 BTC  (fee floor ~6,500 sat)
	ETH: 5_000_000_000_000_000n,      // 0.005 ETH   (fee floor ~0.0012 ETH)
	SOL: 20_000_000n,                 // 0.02 SOL    (fee floor ~0.00502 SOL)
	BLOCK: 5_000_000n,                // 0.05 BLOCK  (fee floor ~0.0115 BLOCK)
};

/**
 * THE SIX QUOTE ASSETS. Defined in settlement.ts and re-exported here, because
 * this is where callers look for it and importing it the other way round would
 * be a cycle.
 */
export { QUOTE_SENIORITY } from "./settlement";

/**
 * THE 25 SYMBOLS THAT WERE LIVE BEFORE THE QUOTE EXPANSION, EXACTLY AS THEY
 * WERE WRITTEN.
 *
 * DO NOT TIDY THIS AWAY. It will look redundant, because `orient()` computes an
 * orientation for almost every pair here and agrees with most of them. It does
 * not agree with all of them: a clean-sheet seniority rule would have written
 * `BLOCK-USDC` and `BLOCK-BTC`, where the live venue has `USDC-BLOCK` and
 * `BTC-BLOCK`. These orientations are HISTORICAL, NOT OPTIMAL, and the
 * difference is deliberate.
 *
 * Flipping a live symbol orphans every resting order and every historical trade
 * in it: the `ord` and `trade` rows keep the old symbol, `MARKETS.find` in
 * `reserved()` returns undefined and stops counting the funds those orders
 * commit, and the balances screen then hands the customer money that is still
 * pledged to a book nobody can see or cancel. A golden-list test pins all 25.
 */
const PINNED_SYMBOLS: readonly string[] = [
	// Quote USDT — every asset the venue carried.
	"BTC-USDT", "ETH-USDT", "USDC-USDT", "SOL-USDT", "DOGE-USDT", "TRX-USDT",
	"XRP-USDT", "BNB-USDT", "BLOCK-USDT", "PERBUG-USDT", "PEP-USDT",
	"DINGO-USDT", "RTM-USDT",
	// Quote BLOCK — the same list minus BLOCK itself and minus USDT, whose
	// pair with BLOCK had already been emitted the other way round.
	"BTC-BLOCK", "ETH-BLOCK", "USDC-BLOCK", "SOL-BLOCK", "DOGE-BLOCK",
	"TRX-BLOCK", "XRP-BLOCK", "BNB-BLOCK", "PERBUG-BLOCK", "PEP-BLOCK",
	"DINGO-BLOCK", "RTM-BLOCK",
];

/**
 * PRICE DECIMALS FOR THE PINNED MARKETS — ZERO, WITH ONE EXCEPTION.
 *
 * Zero is what every stored price in these markets already means, so pinning
 * them at zero is what makes this change require no data migration: no stored
 * price, no wire format and no historical trade moves by a factor of ten. Some
 * of them are coarse because of it (PEP-USDT prices in whole hundredths of a
 * USDT unit); that is a pre-existing property of a live market, not something
 * to improve by rescaling other people's orders.
 *
 * THE EXCEPTION IS DINGO-USDT, AND IT IS A FINDING RATHER THAN A CHOICE. One
 * DINGO is worth about a tenth of USDT's smallest unit, so its true price is
 * 0.1 and the only writable prices are 1 and up — ten times too expensive.
 * `parse()` refuses the honest number, so no order has ever been priceable in
 * this market since it opened. Rescaling it is therefore the one case where
 * changing priceDecimals cannot reprice anything real.
 *
 * It is still a scale change on a live symbol, so the deploy must confirm that
 * `ord` and `trade` hold no DINGO-USDT rows before shipping it. If they do, the
 * honest move is to pin this back to 0, let the market show as closed with the
 * arithmetic as the reason, and cancel the orders by hand.
 */
const PINNED_PRICE_DECIMALS: Readonly<Record<string, number>> = Object.fromEntries(
	PINNED_SYMBOLS.map((s) => [s, s === "DINGO-USDT" ? 5 : 0]),
);

/** The day the quote set went from two to six. */
const EXPANSION_DAY = "2026-11-25";
/** Pinned symbols predate the mainnet gate; no finer date was recorded. */
const BEFORE_EXPANSION = "2026-11-25";

/** A pair with no symbol, and the sentence saying why. */
export interface UnlistedPair {
	readonly base: string;
	readonly quote: string;
	readonly why: string;
	/** Which leg is responsible, for grouping the pending list. */
	readonly blockedBy?: string;
}

/** Unordered key for a pair, so {a,b} and {b,a} are the same entry. */
function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Split a symbol. Tickers are `[A-Z0-9]{2,10}` with no hyphen, so the single
 * hyphen is unambiguous — and `market()` resolves symbols by lookup rather than
 * by parsing precisely so this is the only place that has to be true.
 */
function splitSymbol(symbol: string): { base: string; quote: string } {
	const i = symbol.indexOf("-");
	return { base: symbol.slice(0, i), quote: symbol.slice(i + 1) };
}

/**
 * EVERY ASSET TRADES AGAINST EVERY QUOTE THIS VENUE CAN ACTUALLY SETTLE.
 *
 * That sentence replaces "every listed asset trades against USDT and against
 * BLOCK", and the second half of it is the whole design. Of the 63 unordered
 * quote-involving pairs the six quotes allow, 29 involve an asset whose
 * deposits cannot be opened at all (ETH and BNB are refused receive addresses
 * by BitGo pending a paid plan; the SOL wallet is not initialised on chain), so
 * listing them would advertise books that can be sold into and never funded.
 * A one-sided-by-construction market is worse than no market: an empty book
 * costs a customer nothing, an unsettleable one costs them a deposit.
 *
 * FOUR CLAUSES, APPLIED IN ORDER TO EACH UNORDERED PAIR:
 *
 *   1. ORIENTATION. A pair with a live symbol keeps it, forever. Otherwise
 *      `orient()` picks the side whose price is expressible, and seniority
 *      breaks a tie. Iterating unordered pairs is what makes "the same market
 *      twice with the prices inverted" unrepresentable rather than merely
 *      avoided — the old generator relied on `Object.keys` order for that.
 *   2. EXPRESSIBILITY. `priceDecimals` is chosen so the price fits; only a
 *      pair that fits in NEITHER direction is refused, and the arithmetic is
 *      published as the reason.
 *   3. SETTLEMENT, ON BOTH LEGS. Gating only the quote is not enough:
 *      ETH-BLOCK has a settleable quote and an ETH leg nobody can deposit. A
 *      leg that settles only by named exception yields an OPEN market that
 *      carries that exception's caveat — see `Market.caveat`. "Open" and
 *      "open, with a known gap" are different claims and the generator makes
 *      both of them rather than flattening the second into the first.
 *   4. EXACTLY ONCE. Each unordered pair yields at most one symbol, ever.
 *
 * Returns three lists rather than one, because "there is no market" is three
 * different claims and a customer is owed the difference: a CLOSED market has a
 * symbol and a book and refuses orders; a PENDING pair has no symbol and gets
 * one when a rail opens, with no code change; a NOT-LISTED pair has no symbol
 * and will not get one while the arithmetic stands.
 */
function buildMarkets(): {
	markets: readonly Market[];
	notListed: readonly UnlistedPair[];
	pending: readonly UnlistedPair[];
} {
	const assets = Object.keys(MIN_BASE);
	const pins = new Map<string, string>();
	for (const s of PINNED_SYMBOLS) {
		const { base, quote } = splitSymbol(s);
		pins.set(pairKey(base, quote), s);
	}

	const markets: Market[] = [];
	const notListed: UnlistedPair[] = [];
	const pending: UnlistedPair[] = [];

	for (let i = 0; i < assets.length; i++) {
		for (let j = i + 1; j < assets.length; j++) {
			const a = assets[i]!;
			const b = assets[j]!;
			// A pair of two tail coins is not a market this venue offers; one
			// side has to be something people price in.
			if (!isQuoteAsset(a) && !isQuoteAsset(b)) continue;

			const pin = pins.get(pairKey(a, b));
			let base: string;
			let quote: string;
			let priceDecimals: number;
			if (pin !== undefined) {
				({ base, quote } = splitSymbol(pin));
				const p = PINNED_PRICE_DECIMALS[pin];
				if (p === undefined) {
					// Loud at module load: a pinned symbol with no declared
					// scale is a live market whose prices mean nothing.
					throw new Error(`${pin} is pinned but has no PINNED_PRICE_DECIMALS entry`);
				}
				priceDecimals = p;
			} else {
				const o = orient(a, b);
				if (!o.ok) {
					notListed.push({ base: a, quote: b, why: o.why });
					continue;
				}
				({ base, quote, priceDecimals } = o);
			}

			const sb = settleable(base);
			const sq = settleable(quote);
			const why = !sb.ok ? sb.why : !sq.ok ? sq.why : undefined;
			if (why !== undefined && pin === undefined) {
				pending.push({ base, quote, why, blockedBy: sb.ok ? quote : base });
				continue;
			}

			/*
			 * THE CAVEAT TRAVELS WITH THE VERDICT.
			 *
			 * `settleable` returns one for an asset admitted by exception, and
			 * this generator used to read `.ok` and `.why` and discard it — so
			 * BLOCK's markets published "open" full stop, which is the thing
			 * the exception's own comment promised not to do. Both legs are
			 * asked because a caveat can come from either side: BLOCK is the
			 * quote in nine of these markets and the base in BLOCK-USDT.
			 *
			 * Joined rather than picked, so that if a second exception is ever
			 * granted a pair of two caveated assets says both things instead of
			 * silently dropping one.
			 */
			const caveats = [sb.ok ? sb.caveat : undefined, sq.ok ? sq.caveat : undefined]
				.filter((c): c is string => c !== undefined && c !== "");

			const notional = MIN_NOTIONAL[quote];
			if (notional === undefined) {
				throw new Error(
					`${quote} is used as a quote but has no MIN_NOTIONAL — every order ` +
						"in it would be unbounded on the quote side",
				);
			}
			/*
			 * THE PRICE SCALE IS CHECKED, NOT ASSUMED.
			 *
			 * `expressible()` is the documented check that `priceDecimals` was
			 * chosen correctly, and it was exported and called from nowhere —
			 * so the thing it checks held only by construction, and only for
			 * the half of the markets that `orient()` sizes. The pinned half is
			 * exactly where it does not hold by construction: DINGO-USDT sat
			 * live for months at an exponent of -1, where `parse()` refuses the
			 * honest price and no order was ever placeable. That is the bug this
			 * answers, and it was found by hand rather than by this check.
			 *
			 * AT LOAD, LOUDLY, like the pinned-symbol guards below. A market
			 * whose prices cannot be written is a market that rejects every
			 * order, and it is not discovered by reading a test report — it is
			 * discovered by a customer trying to sell. `undefined` means the
			 * magnitude is unknown and the question cannot be asked, which is
			 * every BLOCK pair, by the design in UNIT_SCALE.
			 */
			const exp = expressible(base, quote, priceDecimals);
			if (exp !== undefined && !exp.ok) {
				throw new Error(
					`${base}-${quote} would be listed with priceDecimals ` +
						`${priceDecimals}, and ${exp.why}`,
				);
			}

			markets.push({
				symbol: `${base}-${quote}`,
				base,
				quote,
				minBase: MIN_BASE[base]!,
				minNotional: notional,
				priceDecimals,
				listedAt: pin === undefined ? EXPANSION_DAY : BEFORE_EXPANSION,
				closed: why,
				caveat: caveats.length === 0 ? undefined : caveats.join(" "),
			});
		}
	}

	// MIGRATION SAFETY, CHECKED AT LOAD RATHER THAN IN A TEST ALONE. A pinned
	// symbol that stopped being emitted is a live market that vanished, and the
	// damage (orphaned orders, uncounted reservations) happens before anyone
	// reads a test report.
	for (const s of PINNED_SYMBOLS) {
		if (!markets.some((m) => m.symbol === s)) {
			throw new Error(
				`${s} is live but the generator no longer emits it — symbols are ` +
					"append-only; close a market, never delete it",
			);
		}
	}
	return { markets, notListed, pending };
}

const built = buildMarkets();

/**
 * EVERY SYMBOL THE VENUE HAS, OPEN OR CLOSED.
 *
 * Closed markets stay in here on purpose: their books, their resting orders and
 * their history still exist, cancels must still work, and the assets in them
 * must still appear in balances and withdrawals.
 */
export const MARKETS: readonly Market[] = built.markets;

/** Markets accepting orders right now, by structure. See publicapi for live state. */
export const OPEN_MARKETS: readonly Market[] = built.markets.filter(
	(m) => m.closed === undefined,
);

/**
 * Pairs with no symbol because no price for them can be written down. Served
 * so that "I asked for everything against BTC and got three rows" has an answer
 * other than "the filter is broken".
 */
export const NOT_LISTED: readonly UnlistedPair[] = built.notListed;

/**
 * Pairs with no symbol because an asset in them cannot settle yet. Each appears
 * automatically, with no code change and no second deploy, when its rail opens.
 */
export const PENDING_SETTLEMENT: readonly UnlistedPair[] = built.pending;

export function market(symbol: string): Market {
	const m = MARKETS.find((x) => x.symbol === symbol);
	if (m === undefined) throw new VenueError(`unknown market ${symbol}`, 404);
	return m;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  pw_salt       TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ord (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id),
  market      TEXT NOT NULL,
  side        TEXT NOT NULL,
  -- quote base-units per ONE WHOLE unit of base, times 10^priceDecimals,
  -- as an integer string
  price       TEXT NOT NULL,
  -- THE SAME NUMBER, ZERO-PADDED TO A FIXED WIDTH, WHICH IS THE ONE THE
  -- MATCHER COMPARES. Lexicographic order over equal-width decimal digits is
  -- exact for any bigint; CAST(price AS INTEGER) is not, because SQLite clamps
  -- at int64 instead of failing. See the header.
  price_key   TEXT,
  base_total  TEXT NOT NULL,
  base_filled TEXT NOT NULL DEFAULT '0',
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seq         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ord_book ON ord(market, side, state);
/*
 * THE price_key INDEX IS CREATED BY migrate(), NOT HERE, AND IT CANNOT MOVE.
 *
 * SCHEMA is exec'd before migrate() runs. On a database that already exists --
 * i.e. the live one -- CREATE TABLE IF NOT EXISTS ord does nothing, so
 * price_key is absent at this point, and an index naming it fails the whole
 * exec with "no such column: price_key". That took the public API down on
 * deploy: it would not start, and the venue served nothing until the previous
 * dist was restored.
 *
 * The irony is that migrate()'s own doc comment explains this exact trap for
 * COLUMNS. Adding the index here reintroduced it by the back door, because an
 * index is the one other thing in SCHEMA that can reference a column by name.
 *
 * migrate() adds the column and then creates this index, and
 * CREATE INDEX IF NOT EXISTS is idempotent, so a fresh database gets it there
 * too. Nothing is lost by its absence here except the outage.
 *
 * NOTE FOR THE NEXT EDITOR: this comment sits inside a template literal, so a
 * backtick anywhere in it silently ends the string. That is how the first
 * version of this comment broke the build.
 */
CREATE INDEX IF NOT EXISTS idx_ord_acct ON ord(account_id);

CREATE TABLE IF NOT EXISTS trade (
  id          TEXT PRIMARY KEY,
  market      TEXT NOT NULL,
  price       TEXT NOT NULL,
  base_amount TEXT NOT NULL,
  taker_side  TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_mkt ON trade(market, at);

-- Orders and trades are the venue's record of what it agreed to. Amending one
-- after the fact would make the ledger and the book disagree about history.
CREATE TRIGGER IF NOT EXISTS trade_no_update
BEFORE UPDATE ON trade
BEGIN SELECT RAISE(ABORT, 'trade is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_no_delete
BEFORE DELETE ON trade
BEGIN SELECT RAISE(ABORT, 'trade is append-only'); END;
`;

interface OrderRow {
	id: string;
	account_id: string;
	market: string;
	side: string;
	price: string;
	base_total: string;
	base_filled: string;
	state: string;
	created_at: string;
	seq: number | null;
}

export interface Order {
	readonly id: string;
	readonly market: string;
	readonly side: OrderSide;
	readonly price: bigint;
	readonly baseTotal: bigint;
	readonly baseFilled: bigint;
	readonly state: "open" | "filled" | "cancelled";
	readonly createdAt: string;
}

function hydrate(r: OrderRow): Order {
	return {
		id: r.id,
		market: r.market,
		side: r.side as OrderSide,
		price: BigInt(r.price),
		baseTotal: BigInt(r.base_total),
		baseFilled: BigInt(r.base_filled),
		state: r.state as Order["state"],
		createdAt: r.created_at,
	};
}

/**
 * Quote amount for a base amount at a price.
 *
 * price is quote-units per WHOLE base unit, so the base amount must be divided
 * by the base asset's scale. Integer division truncates, which rounds the quote
 * DOWN — ALWAYS towards the party paying the quote, which is the BUYER. On a
 * buy they pay fractionally less than the exact product; on a sell they receive
 * fractionally less of what the seller is owed in quote terms. (An earlier
 * version of this comment had the buy case backwards, which matters because the
 * direction is the reason the rounding is safe.)
 *
 * The asymmetry is sub-unit and is deliberately preferred to rounding up, which
 * would let a fill cost more than the order authorised. It is also why the
 * truncation can be relied on by `placeOrder`'s reservation: flooring is
 * sub-additive, so the sum of the quote amounts of any set of partial fills can
 * never exceed the quote reserved for the whole order at the same price.
 */
export function quoteFor(
	baseAmount: bigint,
	price: bigint,
	baseDecimals: number,
	priceDecimals = 0,
): bigint {
	return (baseAmount * price) / 10n ** BigInt(baseDecimals + priceDecimals);
}

/**
 * HOW MANY DECIMAL PLACES A PRICE STRING CARRIES ON THE WIRE.
 *
 * This is the ONLY correct scale for parsing or formatting a price, and it is
 * not the quote asset's decimals. A price is quote base-units per whole base
 * unit times 10^priceDecimals, so turning the stored integer back into the
 * number a human typed needs BOTH exponents:
 *
 *     price_int = human_price * 10^(quote decimals + priceDecimals)
 *
 * IT EXISTS BECAUSE THE OBVIOUS CODE IS WRONG AND LOOKS RIGHT. Every price
 * parse and format in the HTTP layer used `assetDef(m.quote).decimals` alone.
 * That was correct while every market had priceDecimals 0, and it silently
 * became a misprice of 10^priceDecimals the moment the quote expansion gave
 * twelve markets a non-zero one — a factor of 10,000 on PERBUG-BTC and
 * 100,000,000 on DINGO-BTC, in the direction that makes a submitted price far
 * too small and a displayed price far too large. Nothing would have thrown:
 * both numbers are valid prices, so the order would simply have rested at the
 * wrong place and been filled there.
 *
 * So the quote's decimals on their own are never the right argument for a
 * PRICE. They remain exactly right for a quote AMOUNT — a balance, a notional,
 * the capital in a ladder — which is why both still appear at the call sites.
 */
export function priceScale(m: Market): number {
	return assetDef(m.quote).decimals + m.priceDecimals;
}

/**
 * THE WIDTH OF `price_key`, AND WHY A PRICE WIDER THAN THIS IS REFUSED.
 *
 * Zero-padded decimal strings compare correctly only at equal width, so the
 * width has to be fixed, which makes it a limit. 40 digits is ~10^40, far above
 * any price the generator will emit (the ceiling is 10^18) and far below the
 * point where the padding itself costs anything. A price that does not fit is
 * refused rather than truncated: a truncated key would sort wrongly and the
 * matcher would cross at the wrong price, silently.
 */
const PRICE_KEY_WIDTH = 40;

export function priceKey(price: bigint): string {
	const s = price.toString();
	if (price < 0n || s.length > PRICE_KEY_WIDTH) {
		throw new VenueError(`price ${s} is outside the range this venue can order`);
	}
	return s.padStart(PRICE_KEY_WIDTH, "0");
}

/** The columns both reservation views read. */
interface OpenOrderRow {
	account_id: string;
	market: string;
	side: string;
	price: string;
	base_total: string;
	base_filled: string;
}

/**
 * WHAT ONE OPEN ORDER HAS ALREADY LAID CLAIM TO, and in which asset.
 *
 * A resting buy has claimed quote for the part still unfilled, at its own
 * limit price; a resting sell has claimed that much base. `undefined` means
 * the row claims nothing — a fully-filled row still marked open, or an order
 * on a market that is no longer listed.
 *
 * FACTORED OUT SO THERE IS EXACTLY ONE OF IT. `Venue.reserved()` (per
 * account, what `placeOrder` and the withdrawal path enforce against) and
 * `Venue.reservationsByAsset()` (venue-wide, what the operator treasury view
 * displays) both go through here. Two hand-rolled copies of this arithmetic
 * would be two answers to "how much of this customer's balance is spoken
 * for", and the moment they disagreed the operator console would be
 * contradicting the endpoint that actually refuses the withdrawal.
 *
 * ALL BIGINT, NEVER A CAST IN SQL. `price`, `base_total` and `base_filled`
 * are TEXT because an 18-decimal amount overflows SQLite's 64-bit INTEGER,
 * and `CAST` clamps at the boundary instead of failing — which is how this
 * venue once published a price level's depth as int64-max. See the header of
 * this file.
 */
function reservationOf(
	r: OpenOrderRow,
): { asset: string; amount: bigint } | undefined {
	const m = MARKETS.find((x) => x.symbol === r.market);
	if (m === undefined) return undefined;
	const left = BigInt(r.base_total) - BigInt(r.base_filled);
	if (left <= 0n) return undefined;
	return r.side === "buy"
		? {
				asset: m.quote,
				amount: quoteFor(
					left,
					BigInt(r.price),
					assetDef(m.base).decimals,
					m.priceDecimals,
				),
			}
		: { asset: m.base, amount: left };
}

export class Venue {
	constructor(
		private readonly db: Database,
		private readonly ledger: Ledger,
		private readonly fees: FeeSchedule = DEFAULT_FEES,
		private readonly opts: {
			mainnetEnabled?: boolean;
			/**
			 * True when a LIVE CUSTODIAN backs this venue — a real BitGo
			 * account, whether it holds mainnet or testnet coins.
			 *
			 * Separate from `mainnetEnabled` because it gates a different
			 * thing. See `testnetCredit`.
			 */
			liveCustodian?: boolean;
			/**
			 * What the DECLARED TREASURY says is actually held of a custody
			 * asset, or undefined if it declares nothing for it.
			 *
			 * The testnet faucet is capped against this. Without a cap the
			 * faucet can post book custody far beyond anything declared, and
			 * reconciliation then reports a shortfall forever — which is the
			 * failure mode this venue hit on USDT: 139 faucet credits put the
			 * books 1,390,000,000,000 base units above the declared treasury,
			 * the interlock halted USDT withdrawals, and nothing un-credits it.
			 *
			 * A PERMANENTLY TRIPPED INTERLOCK IS THE REAL DAMAGE. While it is
			 * stuck on, it can no longer tell anyone about a genuine USDT
			 * shortfall — the signal is pinned, so nobody reads it.
			 */
			declaredHoldings?: (custodyId: string) => bigint | undefined;
			now?: () => number;
		} = {},
	) {
		db.exec(SCHEMA);
		this.migrate();
	}

	/**
	 * Add columns that post-date the first deployment.
	 *
	 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
	 * so a column added to SCHEMA is invisible to every database that has
	 * already been created — which is the live one. Same shape as
	 * `Withdrawals.migrate`, deliberately: this is the second time it has been
	 * needed and it will not be the last.
	 *
	 * THE BACKFILL IS DONE IN JAVASCRIPT, not in SQL, because the obvious SQL
	 * (`printf('%040d', CAST(price AS INTEGER))`) routes the value through the
	 * very int64 cast this column exists to escape, and would write a clamped
	 * key for exactly the prices that matter.
	 */
	private migrate(): void {
		const cols = (
			this.db.prepare(`PRAGMA table_info(ord)`).all() as { name: string }[]
		).map((c) => c.name);
		if (!cols.includes("price_key")) {
			this.db.exec(`ALTER TABLE ord ADD COLUMN price_key TEXT`);
			this.db.exec(
				`CREATE INDEX IF NOT EXISTS idx_ord_price ON ord(market, side, state, price_key)`,
			);
		}
		const todo = this.db
			.prepare(`SELECT id, price FROM ord WHERE price_key IS NULL`)
			.all() as { id: string; price: string }[];
		if (todo.length === 0) return;
		const set = this.db.prepare(`UPDATE ord SET price_key = ? WHERE id = ?`);
		this.db.transaction(() => {
			for (const r of todo) set.run(priceKey(BigInt(r.price)), r.id);
		})();
	}

	/** The venue's own connection — withdrawals must share it, not open another. */
	get database(): Database {
		return this.db;
	}
	get book_ledger(): Ledger {
		return this.ledger;
	}

	private now(): string {
		return new Date(this.opts.now?.() ?? Date.now()).toISOString();
	}

	// ------------------------------------------------------------- accounts

	/**
	 * Register an account.
	 *
	 * scrypt, not a bare hash: a password database is going to leak eventually
	 * and the only question is how expensive it is to crack afterwards. 16-byte
	 * random salt per account, so one rainbow table cannot serve two users.
	 */
	register(email: string, password: string): { id: string } {
		const e = email.trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
			throw new VenueError("that does not look like an email address");
		}
		// A LENGTH FLOOR, NOT COMPOSITION RULES. "One capital and a symbol"
		// produces Password1! and measurably does not help; length does.
		if (password.length < 12) {
			throw new VenueError("password must be at least 12 characters");
		}
		if (this.db.prepare(`SELECT 1 FROM account WHERE email = ?`).get(e) !== undefined) {
			// Deliberately the same shape of error as a bad login would give,
			// so this endpoint is not an account-enumeration oracle.
			throw new VenueError("that email cannot be registered", 409);
		}
		const id = `u_${randomBytes(9).toString("hex")}`;
		const salt = randomBytes(16).toString("hex");
		const hash = scryptSync(password, salt, 64).toString("hex");
		this.db
			.prepare(
				`INSERT INTO account (id, email, pw_salt, pw_hash, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, e, salt, hash, this.now());
		return { id };
	}

	/** Log in, returning an opaque bearer token. */
	login(email: string, password: string): { token: string; accountId: string } {
		const row = this.db
			.prepare(`SELECT id, pw_salt, pw_hash FROM account WHERE email = ?`)
			.get(email.trim().toLowerCase()) as
			| { id: string; pw_salt: string; pw_hash: string }
			| undefined;

		// CONSTANT-TIME, AND THE SAME WORK WHETHER OR NOT THE ACCOUNT EXISTS.
		// Returning early on an unknown email makes login timing an account
		// enumeration oracle.
		const salt = row?.pw_salt ?? "0".repeat(32);
		const expect = Buffer.from(row?.pw_hash ?? "0".repeat(128), "hex");
		const got = scryptSync(password, salt, 64);
		const ok =
			row !== undefined &&
			expect.length === got.length &&
			timingSafeEqual(expect, got);
		if (!ok) throw new VenueError("wrong email or password", 401);

		const token = randomBytes(32).toString("hex");
		const expires = new Date(
			(this.opts.now?.() ?? Date.now()) + 12 * 3600 * 1000,
		).toISOString();
		this.db
			.prepare(
				`INSERT INTO session (token_hash, account_id, created_at, expires_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(sha(token), row.id, this.now(), expires);
		return { token, accountId: row.id };
	}

	/** Resolve a bearer token to an account, or throw 401. */
	authenticate(token: string): string {
		const row = this.db
			.prepare(`SELECT account_id, expires_at FROM session WHERE token_hash = ?`)
			.get(sha(token)) as { account_id: string; expires_at: string } | undefined;
		if (row === undefined) throw new VenueError("not signed in", 401);
		if (row.expires_at < this.now()) {
			this.db.prepare(`DELETE FROM session WHERE token_hash = ?`).run(sha(token));
			throw new VenueError("session expired", 401);
		}
		return row.account_id;
	}

	logout(token: string): void {
		this.db.prepare(`DELETE FROM session WHERE token_hash = ?`).run(sha(token));
	}

	// ------------------------------------------------------------- balances

	/**
	 * Funds an account's OPEN ORDERS have already laid claim to, per asset.
	 *
	 * A resting buy has claimed quote for the part of it still unfilled, at its
	 * own limit price; a resting sell has claimed that much base. Derived from
	 * the order rows rather than tracked in a column, so it cannot drift out of
	 * step with the book.
	 */
	reserved(accountId: string): Map<string, bigint> {
		const rows = this.db
			.prepare(
				`SELECT account_id, market, side, price, base_total, base_filled FROM ord
				  WHERE account_id = ? AND state = 'open'`,
			)
			.all(accountId) as OpenOrderRow[];

		const out = new Map<string, bigint>();
		for (const r of rows) {
			const claim = reservationOf(r);
			if (claim === undefined) continue;
			out.set(claim.asset, (out.get(claim.asset) ?? 0n) + claim.amount);
		}
		return out;
	}

	/**
	 * EVERY open order's claim, as asset -> account -> units.
	 *
	 * The operator treasury view needs two things this answers in one pass:
	 * how much of each asset the whole venue has committed to resting orders,
	 * and which accounts those commitments belong to. The alternative — call
	 * `reserved()` once per customer — is one query per account and, worse,
	 * cannot see an account that has orders but no ledger postings.
	 *
	 * IT SHARES `reservationOf` WITH `reserved()` ABOVE, DELIBERATELY. This is
	 * the one figure in the treasury view that is NOT backed by the ledger's
	 * hash chain: a reservation is derived from the order table, so a second
	 * hand-rolled derivation of it would be a number that could disagree with
	 * the one `placeOrder` and the withdrawal path actually enforce. An
	 * operator screen that says an account has 3 ETH available while the
	 * withdrawal endpoint refuses on 2 is worse than no screen.
	 *
	 * `skipped` counts open orders whose market is no longer in MARKETS. Those
	 * are silently ignored when computing a claim — see `reservationOf` — and
	 * that means reserved is UNDERSTATED by however much they hold. For a
	 * customer the clamp is harmless; for an operator it is a finding, so the
	 * count is returned rather than swallowed.
	 */
	reservationsByAsset(): {
		byAsset: Map<string, Map<string, bigint>>;
		skipped: number;
	} {
		const rows = this.db
			.prepare(
				`SELECT account_id, market, side, price, base_total, base_filled FROM ord
				  WHERE state = 'open'`,
			)
			.all() as OpenOrderRow[];

		const byAsset = new Map<string, Map<string, bigint>>();
		let skipped = 0;
		for (const r of rows) {
			if (MARKETS.find((x) => x.symbol === r.market) === undefined) {
				skipped++;
				continue;
			}
			const claim = reservationOf(r);
			if (claim === undefined) continue;
			let perAccount = byAsset.get(claim.asset);
			if (perAccount === undefined) {
				perAccount = new Map<string, bigint>();
				byAsset.set(claim.asset, perAccount);
			}
			perAccount.set(
				r.account_id,
				(perAccount.get(r.account_id) ?? 0n) + claim.amount,
			);
		}
		return { byAsset, skipped };
	}

	/**
	 * Balances, with what is already committed to resting orders separated out.
	 *
	 * THE FIRST VERSION REPORTED THE LEDGER BALANCE AS "available" AND RESERVED
	 * NOTHING, which was not merely cosmetic. `placeOrder` checked that same
	 * raw balance, so one account holding 1 BTC could rest five separate 1 BTC
	 * asks — each individually passing the check — and every incoming buy that
	 * reached past the first then failed, because settling the second fill
	 * overdrew a balance the ledger correctly refused. One account could make a
	 * whole market unusable for the price of one BTC, and nothing was stolen,
	 * which is exactly why it would have taken a while to notice.
	 */
	balances(accountId: string): {
		asset: string;
		/** Ledger balance: everything the account owns. */
		total: bigint;
		/** Committed to resting orders. */
		reserved: bigint;
		/** total − reserved. What a new order may use. */
		available: bigint;
		decimals: number;
	}[] {
		const assets = new Set<string>();
		for (const m of MARKETS) {
			assets.add(m.base);
			assets.add(m.quote);
		}
		const held = this.reserved(accountId);
		return [...assets].sort().map((asset) => {
			const total = this.ledger.balance({
				kind: AccountKind.USER,
				owner: accountId,
				asset,
			});
			const reserved = held.get(asset) ?? 0n;
			return {
				asset,
				total,
				reserved,
				// Clamped at zero. A negative "available" could only come from a
				// legacy overcommitted order, and rendering it negative would be
				// alarming without being actionable.
				available: total > reserved ? total - reserved : 0n,
				decimals: assetDef(asset).decimals,
			};
		});
	}

	/**
	 * TESTNET-ONLY funding.
	 *
	 * REFUSES OUTRIGHT when the mainnet gate is on. A venue with an endpoint
	 * that can conjure balances in production is not an exchange, and the guard
	 * belongs in the code rather than in a deployment checklist — checklists
	 * are not enforced at 3am.
	 */
	testnetCredit(accountId: string, asset: string, amount: bigint, custodyId: string): void {
		if (this.opts.mainnetEnabled === true) {
			throw new VenueError(
				"testnet funding is disabled on mainnet — deposits must arrive on chain",
				403,
			);
		}
		/*
		 * AND REFUSED WHENEVER A LIVE CUSTODIAN BACKS THE VENUE, mainnet or not.
		 *
		 * Look at what this method posts: it credits CUSTODY as well as the
		 * user, because the ledger's invariant requires the liability to be
		 * backed. But no coins arrive. So the books claim custody holds
		 * something the custodian does not, and reconciliation — comparing
		 * books against what the custodian actually reports — correctly calls
		 * that a SHORTFALL and halts withdrawals of that asset. Permanently,
		 * since nothing ever un-credits it.
		 *
		 * That is why this is NOT covered by the mainnet gate alone. A
		 * production BitGo account holding testnet coins is exactly the setup
		 * an operator wants for a dry run, and it is exactly the setup where
		 * one faucet click silently bricks reconciliation for that asset.
		 *
		 * The faucet is for a venue reconciling against a declared treasury
		 * file. Once a real custodian is wired, deposits come from the chain.
		 */
		if (this.opts.liveCustodian === true) {
			throw new VenueError(
				"testnet funding is disabled because a live custodian is " +
					"configured. This endpoint credits CUSTODY as well as your " +
					"balance, and the custodian would not report those coins — " +
					"reconciliation would read the difference as a shortfall and " +
					"halt withdrawals of that asset. Deposit on chain instead.",
				403,
			);
		}
		if (amount <= 0n) throw new VenueError("amount must be positive");
		/*
		 * CAPPED AT WHAT THE TREASURY DECLARES IS HELD.
		 *
		 * The faucet credits CUSTODY as well as the user, so each click moves
		 * the books further from the declared treasury and reconciliation reads
		 * the gap as a shortfall. Refusing here keeps that comparison MEANINGFUL
		 * — the alternative is what happened to USDT, where the interlock is now
		 * pinned on and has stopped being able to report anything.
		 *
		 * Declaring nothing for an asset means no faucet for it, rather than an
		 * unlimited one: an undeclared asset is precisely the case where there
		 * is no number to check against.
		 */
		if (this.opts.declaredHoldings !== undefined) {
			const declared = this.opts.declaredHoldings(custodyId);
			if (declared === undefined) {
				throw new VenueError(
					`testnet funding refused: the declared treasury says nothing about ` +
						`${custodyId}, so there is no holding to fund against. Declare it ` +
						"first.",
					409,
				);
			}
			const booked = this.ledger.balance({
				kind: AccountKind.CUSTODY,
				owner: "",
				asset: custodyId,
			});
			if (booked + amount > declared) {
				throw new VenueError(
					`testnet funding refused: the books already show ${booked} of ` +
						`${custodyId} in custody and the declared treasury holds ` +
						`${declared}. Crediting ${amount} more would put the books above ` +
						"the declared holding, and reconciliation would halt withdrawals " +
						"of this asset until someone un-credited it — which nothing does.",
					409,
				);
			}
		}
		this.ledger.post({
			reason: Reason.DEPOSIT,
			postings: [
				{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amount },
				{ account: { kind: AccountKind.CUSTODY, owner: "", asset: custodyId }, delta: amount },
				{ account: { kind: AccountKind.USER, owner: accountId, asset }, delta: amount },
				{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amount },
			],
			idempotencyKey: `testnet-credit:${accountId}:${asset}:${randomBytes(6).toString("hex")}`,
			actor: "testnet-faucet",
		});
	}

	// -------------------------------------------------------------- trading

	/**
	 * Place a limit order and match it against the book.
	 *
	 * THE WHOLE THING IS ONE IMMEDIATE TRANSACTION. A partially-matched order
	 * that then fails must leave nothing behind: otherwise the book says one
	 * thing, the ledger says another, and reconciliation reports a break whose
	 * cause is three layers away. Taking the write lock up front is what makes
	 * "all fills or none" true.
	 */
	placeOrder(args: {
		accountId: string;
		market: string;
		side: OrderSide;
		price: bigint;
		baseAmount: bigint;
	}): { order: Order; fills: number } {
		const m = market(args.market);
		/*
		 * A CLOSED MARKET REFUSES ORDERS AND NOTHING ELSE.
		 *
		 * 409 rather than 404: the market exists, the book exists, and the
		 * customer's resting orders in it are still theirs. `cancelOrder` is
		 * deliberately NOT gated on this — a closure that stopped people
		 * retrieving their own funds would be the orphaning this design exists
		 * to prevent, committed by the fix instead of the bug.
		 */
		if (m.closed !== undefined) throw new VenueError(m.closed, 409);
		if (args.price <= 0n) throw new VenueError("price must be positive");
		if (args.baseAmount < m.minBase) {
			throw new VenueError(
				`minimum order is ${m.minBase} base units of ${m.base}`,
			);
		}

		const baseDec = assetDef(m.base).decimals;
		/*
		 * THE QUOTE-SIDE FLOOR, CHECKED AT PLACEMENT.
		 *
		 * Without it, `match()` quietly skips any fill that prices to zero, so
		 * an order rests, shows in the book, gets crossed and never fills, and
		 * nothing tells anybody why. Naming the quote in the message matters
		 * because the same base amount clears the floor against USDT and fails
		 * it against BTC.
		 */
		const notional = quoteFor(args.baseAmount, args.price, baseDec, m.priceDecimals);
		if (notional < m.minNotional) {
			throw new VenueError(
				`order is worth ${notional} base units of ${m.quote}; the minimum for ` +
					`a ${m.quote} market is ${m.minNotional}`,
			);
		}
		const run = this.db.transaction((): { order: Order; fills: number } => {
			// FUNDS CHECK FIRST, against the ledger, inside the lock. A buy
			// needs quote for the full order at its limit price — which is the
			// same figure the notional floor was measured on — and a sell needs
			// the base.
			const need = args.side === "buy" ? notional : args.baseAmount;
			const needAsset = args.side === "buy" ? m.quote : m.base;
			// AGAINST AVAILABLE, NOT THE RAW BALANCE. Checking the ledger
			// balance alone lets the same funds back any number of resting
			// orders — see the note on `balances`.
			const total = this.ledger.balance({
				kind: AccountKind.USER,
				owner: args.accountId,
				asset: needAsset,
			});
			const committed = this.reserved(args.accountId).get(needAsset) ?? 0n;
			const have = total > committed ? total - committed : 0n;
			if (have < need) {
				throw new VenueError(
					`insufficient ${needAsset}: need ${need}, have ${have}` +
						(committed > 0n
							? ` (${total} held, ${committed} already committed to open orders)`
							: ""),
				);
			}

			const id = `o_${randomBytes(9).toString("hex")}`;
			const now = this.now();
			this.db
				.prepare(
					`INSERT INTO ord (id, account_id, market, side, price, price_key,
					                  base_total, base_filled, state, created_at, seq)
					 VALUES (?, ?, ?, ?, ?, ?, ?, '0', 'open', ?,
					         (SELECT COALESCE(MAX(seq), 0) + 1 FROM ord))`,
				)
				.run(id, args.accountId, args.market, args.side, args.price.toString(),
					priceKey(args.price), args.baseAmount.toString(), now);

			const fills = this.match(id, m, baseDec);
			return { order: this.order(id)!, fills };
		});
		return run.immediate();
	}

	/**
	 * Match an order against the resting book, price-time priority.
	 *
	 * Fills at the RESTING order's price, not the incoming one — the maker
	 * posted first and set the terms. Filling at the taker's price would hand
	 * the taker any gap between the two, which is a silent wealth transfer away
	 * from the person who provided the liquidity.
	 */
	private match(orderId: string, m: Market, baseDec: number): number {
		const incoming = this.order(orderId)!;
		const opposite: OrderSide = incoming.side === "buy" ? "sell" : "buy";

		// A buy crosses sells at or below its limit, cheapest first. A sell
		// crosses buys at or above its limit, dearest first. `seq` breaks ties
		// by arrival, which is the "time" in price-time priority.
		//
		// COMPARED AND ORDERED ON `price_key`, the zero-padded fixed-width form.
		// This was `CAST(price AS INTEGER)`, which SQLite clamps at int64 rather
		// than refusing: two prices above ~9.2e18 compared EQUAL, so a buy could
		// cross a sell priced above its own limit and settle at the maker's
		// higher price, having reserved only its own lower limit — overdrawing,
		// and cancelling an innocent maker on the way out. An 18-decimal quote
		// reaches that range with an ordinary price, so it stopped being
		// hypothetical the moment ETH became a quote asset.
		const rows = this.db
			.prepare(
				`SELECT * FROM ord
				  WHERE market = ? AND side = ? AND state = 'open'
				    AND account_id != ?
				    AND (? = 'buy' AND price_key <= ?
				      OR ? = 'sell' AND price_key >= ?)
				  ORDER BY price_key ${incoming.side === "buy" ? "ASC" : "DESC"}, seq ASC`,
			)
			.all(
				m.symbol, opposite, incoming.account_id ?? "",
				incoming.side, priceKey(incoming.price),
				incoming.side, priceKey(incoming.price),
			) as OrderRow[];

		let remaining = incoming.baseTotal - incoming.baseFilled;
		let fills = 0;

		for (const r of rows) {
			if (remaining <= 0n) break;
			const resting = hydrate(r);
			const restingLeft = resting.baseTotal - resting.baseFilled;
			if (restingLeft <= 0n) continue;

			const qty = remaining < restingLeft ? remaining : restingLeft;
			const price = resting.price; // maker's price — see above
			const quote = quoteFor(qty, price, baseDec, m.priceDecimals);
			// Dust that prices to nothing. `minNotional` stops a whole order
			// being this at placement; a PARTIAL fill can still be, so the
			// guard stays.
			if (quote <= 0n) continue;

			const buyerId = incoming.side === "buy" ? incoming.account_id! : r.account_id;
			const sellerId = incoming.side === "buy" ? r.account_id : incoming.account_id!;
			const tradeId = `t_${randomBytes(9).toString("hex")}`;

			// Settlement goes through the tested fee + ledger path.
			const { postings } = fillPostings(
				{
					base: m.base,
					quote: m.quote,
					baseAmount: qty,
					quoteAmount: quote,
					buyer: {
						userId: buyerId,
						side: incoming.side === "buy" ? Side.TAKER : Side.MAKER,
					},
					seller: {
						userId: sellerId,
						side: incoming.side === "buy" ? Side.MAKER : Side.TAKER,
					},
					fillId: tradeId,
				},
				this.fees,
			);
			// A MAKER WHO CANNOT DELIVER IS REMOVED FROM THE BOOK, AND THE
			// TAKER IS NOT PUNISHED.
			//
			// Reservation (see `balances`) is what stops an account resting more
			// than it holds, so this should be unreachable for any order placed
			// after that fix. It is here because it was NOT unreachable before:
			// a throw at this point unwound the entire incoming order, so one
			// overcommitted resting order made every buy that reached it fail,
			// and the person whose order failed had done nothing wrong and
			// could not tell why.
			//
			// Orders that predate the fix are still on the live book, and a
			// maker can also be left short by an operator correction. So the
			// failure is contained rather than propagated: cancel the maker,
			// skip the fill, carry on down the book.
			try {
				this.ledger.post({
					reason: Reason.TRADE,
					postings,
					idempotencyKey: fillKey(tradeId),
					actor: "engine",
				});
			} catch (e) {
				if (e instanceof InsufficientFunds) {
					// SAVEPOINT, not the outer transaction: we are inside one
					// already and must undo only this fill's attempt.
					this.db
						.prepare(`UPDATE ord SET state = 'cancelled' WHERE id = ?`)
						.run(r.id);
					console.error(
						`matching ${m.symbol}: cancelled resting order ${r.id} — its ` +
							`owner cannot cover the fill (${e.message}). The incoming ` +
							"order continues against the rest of the book.",
					);
					continue;
				}
				throw e;
			}

			this.db
				.prepare(
					`INSERT INTO trade (id, market, price, base_amount, taker_side, at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(tradeId, m.symbol, price.toString(), qty.toString(), incoming.side, this.now());

			this.bump(r.id, BigInt(r.base_filled) + qty, BigInt(r.base_total));
			remaining -= qty;
			fills++;
		}

		this.bump(orderId, incoming.baseTotal - remaining, incoming.baseTotal);
		return fills;
	}

	private bump(id: string, filled: bigint, total: bigint): void {
		this.db
			.prepare(`UPDATE ord SET base_filled = ?, state = ? WHERE id = ?`)
			.run(filled.toString(), filled >= total ? "filled" : "open", id);
	}

	cancelOrder(accountId: string, orderId: string): Order {
		const row = this.db.prepare(`SELECT * FROM ord WHERE id = ?`).get(orderId) as
			| OrderRow
			| undefined;
		if (row === undefined) throw new VenueError("no such order", 404);
		if (row.account_id !== accountId) throw new VenueError("not your order", 403);
		if (row.state !== "open") throw new VenueError(`order is already ${row.state}`);
		this.db.prepare(`UPDATE ord SET state = 'cancelled' WHERE id = ?`).run(orderId);
		return this.order(orderId)!;
	}

	order(id: string): (Order & { account_id?: string }) | undefined {
		const r = this.db.prepare(`SELECT * FROM ord WHERE id = ?`).get(id) as
			| OrderRow
			| undefined;
		return r === undefined ? undefined : { ...hydrate(r), account_id: r.account_id };
	}

	myOrders(accountId: string, limit = 50): readonly Order[] {
		const rows = this.db
			.prepare(`SELECT * FROM ord WHERE account_id = ? ORDER BY seq DESC LIMIT ?`)
			.all(accountId, limit) as OrderRow[];
		return rows.map(hydrate);
	}

	/** Aggregated depth, best price first. */
	book(symbol: string, depth = 20): {
		bids: { price: bigint; base: bigint }[];
		asks: { price: bigint; base: bigint }[];
	} {
		market(symbol);
		/*
		 * AGGREGATED IN JAVASCRIPT, IN BIGINT, DELIBERATELY.
		 *
		 * This was `SUM(CAST(base_total AS INTEGER) - CAST(base_filled AS
		 * INTEGER))` with `ORDER BY CAST(price AS INTEGER)`, and both halves
		 * were wrong for a large-decimal asset: SQLite's INTEGER is int64 and
		 * CLAMPS at 9223372036854775807 instead of failing, so one price level
		 * holding more than ~9.2 ETH summed to the clamp and the published
		 * depth was simply a different number from the book. The levels per
		 * market are few and the open orders are few, so summing them here
		 * costs nothing and is exact.
		 */
		const side = (s: OrderSide, dir: "DESC" | "ASC") => {
			const rows = this.db
				.prepare(
					`SELECT price, base_total, base_filled FROM ord
					  WHERE market = ? AND side = ? AND state = 'open'`,
				)
				.all(symbol, s) as {
				price: string;
				base_total: string;
				base_filled: string;
			}[];
			const levels = new Map<string, bigint>();
			for (const r of rows) {
				const left = BigInt(r.base_total) - BigInt(r.base_filled);
				if (left <= 0n) continue;
				levels.set(r.price, (levels.get(r.price) ?? 0n) + left);
			}
			return [...levels.entries()]
				.map(([price, base]) => ({ price: BigInt(price), base }))
				.sort((a, b) =>
					a.price === b.price ? 0 : (a.price < b.price) === (dir === "ASC") ? -1 : 1,
				)
				.slice(0, depth);
		};
		return { bids: side("buy", "DESC"), asks: side("sell", "ASC") };
	}

	recentTrades(symbol: string, limit = 30): {
		price: bigint;
		base: bigint;
		takerSide: OrderSide;
		at: string;
	}[] {
		market(symbol);
		const rows = this.db
			.prepare(
				`SELECT price, base_amount, taker_side, at FROM trade
				  WHERE market = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
			)
			.all(symbol, limit) as {
			price: string;
			base_amount: string;
			taker_side: string;
			at: string;
		}[];
		return rows.map((r) => ({
			price: BigInt(r.price),
			base: BigInt(r.base_amount),
			takerSide: r.taker_side as OrderSide,
			at: r.at,
		}));
	}

	/** Last traded price, or undefined if the market has never traded. */
	lastPrice(symbol: string): bigint | undefined {
		const r = this.db
			.prepare(
				`SELECT price FROM trade WHERE market = ? ORDER BY at DESC, rowid DESC LIMIT 1`,
			)
			.get(symbol) as { price: string } | undefined;
		return r === undefined ? undefined : BigInt(r.price);
	}
}

function sha(s: string): string {
	// Sessions are stored hashed so a database read does not yield live
	// bearer tokens.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require("node:crypto").createHash("sha256").update(s).digest("hex");
}
