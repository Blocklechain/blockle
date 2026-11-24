// -----------------------------------------------------------------------------
// GAS RATES — converting "0.0015 ETH of gas" into "how much USDT to charge".
//
// THE PROBLEM THIS SOLVES.
//
// We spend gas in ETH and charge the fee in USDT. Guaranteeing that the fee
// covers the gas is therefore not arithmetic, it is a PRICE QUESTION, and a
// venue that answers it by hard-coding a figure has only moved the guess
// somewhere less visible. When ETH triples, a hard-coded USDT fee is a standing
// commitment to lose money on every withdrawal, automatically, with nobody
// watching.
//
// WHY NOT JUST ASSUME THE WORST CASE.
//
// That was the first design: assume ETH at a ceiling price and USDT at a floor
// price, and charge enough to cover gas even then. It is certainly safe, and it
// produced a 35 USDT minimum fee — because two independent worst cases multiply.
// A fee nobody will pay protects nothing; it just moves the withdrawals to a
// venue that did the arithmetic properly.
//
// WHAT THIS DOES INSTEAD. Three layers, in order:
//
// 1. A REAL RATE, from our own order book. We run an ETH/USDT market; its mid
//    is a live local price, and it costs no external dependency.
// 2. A FRESHNESS REQUIREMENT. A stale price is not a price. Past the maximum
//    age a rate is not used, and if nothing fresher exists the chain stops
//    accepting withdrawals rather than pricing them from memory.
// 3. THE WORST OF EVERY AVAILABLE SOURCE. Given a book mid and an operator
//    floor, use whichever implies MORE expensive gas. Disagreement between
//    sources resolves toward safety, never toward a cheaper fee.
//
// On top of that sits the declared buffer in withdrawalfees.ts, which absorbs
// movement between quoting and sending.
//
// EXACT INTEGER ARITHMETIC. A rate is a pair of bigints, not a float: `num`
// base units of the target per `den` base units of the source. Converting is
// multiply-then-divide, with the division rounded UP wherever the result is a
// cost to us, so a remainder is never silently a subsidy. No float ever touches
// a number that decides a fee — the same rule as the rest of this service.
// -----------------------------------------------------------------------------

import { parse, type AssetUnit } from "./amount";
import { assetDef } from "./assets";

export class RateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RateError";
	}
}

/**
 * How many base units of `to` one gets for base units of `from`.
 *
 *     toBase = fromBase * num / den
 */
export interface Rate {
	readonly from: string;
	readonly to: string;
	readonly num: bigint;
	readonly den: bigint;
	/** When this rate was observed, epoch ms. Freshness is enforced, not hoped. */
	readonly asOf: number;
	/** Where it came from, so a surprising fee is traceable. */
	readonly source: string;
}

/** Default maximum age of a usable rate. Five minutes. */
export const MAX_RATE_AGE_MS = 5 * 60 * 1000;

const unit = (asset: string): AssetUnit => ({
	symbol: asset,
	decimals: assetDef(asset).decimals,
});

/**
 * Build a rate from a decimal price string: "how many `to` per one whole `from`".
 *
 * `rateFromPrice("3000.50", "ETH", "USDT")` — one ETH is 3000.50 USDT.
 *
 * The price is parsed at the TARGET asset's precision and refused if it carries
 * more, rather than rounded (see amount.ts). A price we cannot represent is a
 * price we should not be pricing gas from.
 */
export function rateFromPrice(
	price: string,
	from: string,
	to: string,
	opts: { asOf: number; source: string },
): Rate {
	const toUnit = unit(to);
	const num = parse(price, toUnit);
	if (num <= 0n) {
		throw new RateError(`${from}/${to} price must be positive, got ${price}`);
	}
	return {
		from,
		to,
		num,
		// One whole unit of `from`, in its base units.
		den: 10n ** BigInt(unit(from).decimals),
		asOf: opts.asOf,
		source: opts.source,
	};
}

/**
 * Convert base units of `rate.from` into base units of `rate.to`.
 *
 * ROUNDS UP. Every caller in this service is converting a COST — "how much must
 * we charge to cover this gas" — and rounding a cost down by one unit, several
 * million times, is a loss we chose. Rounding it up overcharges by at most one
 * base unit, which for a 6-decimal stablecoin is one millionth of a cent.
 *
 * Note this is the opposite direction from the trading-fee rounding in fees.ts,
 * and deliberately so: there the venue is taking a cut of a customer's proceeds
 * and rounds in the customer's favour; here it is recovering a cost it has
 * already incurred.
 */
export function convertCeil(amount: bigint, rate: Rate): bigint {
	if (amount < 0n) throw new RateError("cannot convert a negative amount");
	if (rate.den <= 0n || rate.num <= 0n) {
		throw new RateError(`degenerate ${rate.from}/${rate.to} rate`);
	}
	const prod = amount * rate.num;
	return (prod + rate.den - 1n) / rate.den;
}

/** A source of rates. Returns undefined when it has no opinion. */
export interface RateSource {
	readonly name: string;
	rate(from: string, to: string): Rate | undefined;
}

/**
 * Operator-configured rates. The floor, not the answer.
 *
 * These exist so a chain is not entirely at the mercy of our own book's depth,
 * and they are deliberately set ABOVE the likely market price of the gas asset:
 * their job is to stop us under-charging, not to be accurate.
 */
export class StaticRates implements RateSource {
	readonly name: string;
	private readonly rates = new Map<string, Rate>();

	constructor(
		prices: Readonly<Record<string, string>>,
		opts: { name?: string } = {},
	) {
		this.name = opts.name ?? "configured";
		for (const [pair, price] of Object.entries(prices)) {
			const [from, to] = pair.split("/");
			if (from === undefined || to === undefined || to === "") {
				throw new RateError(`"${pair}" is not a FROM/TO pair`);
			}
			this.rates.set(pair, rateFromPrice(price, from, to, {
				// Configured rates do not go stale: they are a policy floor, not
				// an observation. Stamped far in the future so freshness checks
				// never reject them, and marked as configured so a fee priced
				// off them is visibly not a market fee.
				asOf: Number.MAX_SAFE_INTEGER,
				source: this.name,
			}));
		}
	}

	rate(from: string, to: string): Rate | undefined {
		return this.rates.get(`${from}/${to}`);
	}
}

/**
 * Pick the rate that implies the MOST expensive gas, among fresh sources.
 *
 * "Most expensive" means the largest num/den — the most `to` per `from`. With
 * exact integers that comparison is a cross-multiplication, not a division, so
 * nothing is lost to rounding.
 *
 * Returns undefined when no source has a fresh rate, which every caller must
 * treat as "this chain cannot be priced" and therefore "this chain cannot pay
 * out". That is the point: an unpriceable chain is a chain where we do not know
 * whether we would be losing money.
 */
export function worstRate(
	from: string,
	to: string,
	sources: readonly RateSource[],
	opts: { now?: number | undefined; maxAgeMs?: number | undefined } = {},
): Rate | undefined {
	const now = opts.now ?? Date.now();
	const maxAge = opts.maxAgeMs ?? MAX_RATE_AGE_MS;
	let best: Rate | undefined;
	for (const s of sources) {
		let r: Rate | undefined;
		try {
			r = s.rate(from, to);
		} catch {
			// A source that throws is a source with no opinion. It must not take
			// the whole quote down with it, and it must not be treated as zero.
			continue;
		}
		if (r === undefined) continue;
		if (r.asOf !== Number.MAX_SAFE_INTEGER && now - r.asOf > maxAge) continue;
		if (best === undefined || r.num * best.den > best.num * r.den) best = r;
	}
	return best;
}

/**
 * Conservative gas-asset prices, as a policy floor.
 *
 * SET HIGH ON PURPOSE. If our own book is thin or quiet, these are what the fee
 * is computed from, and the failure that matters is under-charging. A fee that
 * is too high loses a withdrawal; a fee that is too low loses money on every
 * withdrawal, forever, with no alert.
 *
 * Reviewed when they stop being an upper bound — which revenue.ts shows by
 * reporting gas spent against fees earned per asset.
 */
export const GAS_PRICE_FLOOR: Readonly<Record<string, string>> = {
	"ETH/USDT": "4000",
	"ETH/USDC": "4000",
	"TRX/USDT": "0.35",
	"TRX/USDC": "0.35",
	"SOL/USDT": "280",
	"SOL/USDC": "280",
	"BNB/USDT": "1100",
	"BNB/USDC": "1100",
};

/**
 * A rate source backed by the venue's OWN ORDER BOOK.
 *
 * Decoupled on purpose: this takes a function that returns the best ask, not a
 * Venue. The ask rather than the mid or the last price, because buying the gas
 * asset means paying the ask — pricing gas off a mid assumes we can buy at a
 * price nobody is offering, and pricing it off the last trade assumes the
 * market has not moved since.
 *
 * A market with no ask produces NO OPINION rather than a zero. An empty book
 * does not mean ETH is free.
 */
export class BookRates implements RateSource {
	readonly name = "order-book";

	constructor(
		/** Best ask for one whole `from`, in base units of `to`. */
		private readonly bestAsk: (from: string, to: string) => bigint | undefined,
		private readonly clock: () => number = () => Date.now(),
	) {}

	rate(from: string, to: string): Rate | undefined {
		const ask = this.bestAsk(from, to);
		if (ask === undefined || ask <= 0n) return undefined;
		return {
			from,
			to,
			num: ask,
			den: 10n ** BigInt(unit(from).decimals),
			// Stamped now: a book read IS a current observation. The freshness
			// check still applies to whatever this is compared against.
			asOf: this.clock(),
			source: this.name,
		};
	}
}
