// -----------------------------------------------------------------------------
// MONEY IS AN INTEGER COUNT OF BASE UNITS. NEVER A FLOAT, NEVER A JS `number`.
//
// This module exists because of a concrete defect in the TradeXPro schema we
// are building on: `wallets.balance` is decimal(29,18) but
// `withdraw_histories.amount` is decimal(19,8). An 18-decimal ERC-20 or
// BLOCK-20 withdrawal passing through that column silently loses everything
// below the 8th decimal place. Silently, because MySQL rounds rather than
// raising, and because nothing downstream compares the two.
//
// So no amount in the custody service is ever a decimal string or a float.
// Amounts are `bigint` counts of the asset's smallest indivisible unit (wei,
// satoshi, drop, ...), and the ONLY places a decimal representation exists are
// `parse()` at the edge where a human or an external API hands us one, and
// `format()` at the edge where we hand one back.
//
// `number` cannot hold these values. 1 ETH is 10^18 wei; Number.MAX_SAFE_INTEGER
// is ~9.007 * 10^15. A single ETH does not fit in a JS number without loss, let
// alone a balance sheet. Any function here that accepted a `number` would be a
// loaded gun, so none do.
// -----------------------------------------------------------------------------

/** An asset's unit definition. `decimals` is how many base units make one whole. */
export interface AssetUnit {
	/** Venue-wide asset symbol, e.g. "ETH", "BLOCK", "USDC". */
	readonly symbol: string;
	/** Base units per whole unit, as a power of ten. ETH=18, BTC=8, USDC=6. */
	readonly decimals: number;
}

export class AmountError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AmountError";
	}
}

const MAX_DECIMALS = 36;

function assertDecimals(decimals: number): void {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
		throw new AmountError(
			`decimals must be an integer in [0, ${MAX_DECIMALS}], got ${decimals}`,
		);
	}
}

/**
 * Parse a human/external decimal string into base units.
 *
 * REJECTS rather than rounds when the input carries more precision than the
 * asset has. This is the single most important decision in this file: an
 * exchange that rounds user input decides, unilaterally and invisibly, to keep
 * or give away the remainder. "0.0000000001 BTC" is not 0 BTC — it is a request
 * we cannot represent, and the honest answer is to refuse it and say why.
 *
 * Accepts: "1", "1.5", "0.5", ".5", "-1.5", "+1.5", "1e3", "1.5E-2".
 * Rejects: "", "abc", "1.2.3", "Infinity", "NaN", " 1 " with other content,
 * and anything finer-grained than the asset.
 */
export function parse(input: string, unit: AssetUnit): bigint {
	assertDecimals(unit.decimals);
	if (typeof input !== "string") {
		throw new AmountError(`amount must be a string, got ${typeof input}`);
	}
	const s = input.trim();
	if (s === "") throw new AmountError("amount is empty");

	// Exponent form shows up in JSON from external APIs (1e-8) and from
	// JavaScript's own number stringification, so it has to be understood
	// rather than rejected.
	const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
	if (m === null) throw new AmountError(`not a decimal number: ${JSON.stringify(input)}`);

	const [, sign, intPart = "", fracPart = "", expPart] = m;
	if (intPart === "" && fracPart === "") {
		throw new AmountError(`no digits in amount: ${JSON.stringify(input)}`);
	}

	const exp = expPart === undefined ? 0 : Number(expPart);
	if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_DECIMALS * 4) {
		throw new AmountError(`exponent out of range: ${JSON.stringify(input)}`);
	}

	// All digits, with the decimal point's position tracked separately, so the
	// shift is exact integer work rather than floating-point scaling.
	const digits = intPart + fracPart;
	// How many places the value sits below a whole unit, after the exponent.
	const scale = fracPart.length - exp;

	let base: bigint;
	if (scale <= unit.decimals) {
		// Scale up to base units: multiply by 10^(decimals - scale).
		base = BigInt(digits) * 10n ** BigInt(unit.decimals - scale);
	} else {
		// More precision than the asset has. Only acceptable if what we would
		// discard is exactly zero.
		const excess = scale - unit.decimals;
		const divisor = 10n ** BigInt(excess);
		const whole = BigInt(digits);
		if (whole % divisor !== 0n) {
			throw new AmountError(
				`${unit.symbol} has ${unit.decimals} decimals; ` +
					`${JSON.stringify(input)} needs more and would lose value`,
			);
		}
		base = whole / divisor;
	}

	return sign === "-" ? -base : base;
}

/**
 * Render base units as an exact decimal string. Never lossy, never exponential,
 * and never a float — `format(parse(x)) === canonical(x)` for every accepted x.
 */
export function format(base: bigint, unit: AssetUnit): string {
	assertDecimals(unit.decimals);
	const neg = base < 0n;
	const abs = neg ? -base : base;
	const d = BigInt(unit.decimals);
	const whole = abs / 10n ** d;
	const frac = abs % 10n ** d;

	let out: string;
	if (unit.decimals === 0) {
		out = whole.toString();
	} else {
		// Left-pad the fraction, then drop only TRAILING zeros — "1.50" and
		// "1.5" are the same number, but "1.05" and "1.5" are not.
		const fracStr = frac.toString().padStart(unit.decimals, "0").replace(/0+$/, "");
		out = fracStr === "" ? whole.toString() : `${whole}.${fracStr}`;
	}
	return neg && abs !== 0n ? `-${out}` : out;
}

/**
 * Convert between two assets' unit scales — needed whenever an external
 * provider reports a balance in different precision than our asset definition
 * (BitGo, for instance, reports some tokens in their own base).
 *
 * Throws rather than truncating on a downscale that would lose value, for the
 * same reason `parse` does.
 */
export function rescale(base: bigint, from: number, to: number): bigint {
	assertDecimals(from);
	assertDecimals(to);
	if (from === to) return base;
	if (to > from) return base * 10n ** BigInt(to - from);
	const divisor = 10n ** BigInt(from - to);
	if (base % divisor !== 0n) {
		throw new AmountError(
			`rescaling ${base} from ${from} to ${to} decimals would lose value`,
		);
	}
	return base / divisor;
}

/**
 * Apply a fee in basis points, rounding the FEE DOWN.
 *
 * Returns the fee and the remainder separately, and asserts they sum back to
 * the input. Rounding direction is a policy decision, so it is stated here
 * rather than left to whichever call site got written first: the fee rounds
 * down, so a rounding error can never take more from the customer than the
 * published rate. The venue absorbs the sub-unit, which is the correct
 * direction for the party that wrote the software.
 */
export function applyFeeBps(gross: bigint, bps: number): { fee: bigint; net: bigint } {
	if (gross < 0n) throw new AmountError("cannot take a fee on a negative amount");
	if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
		throw new AmountError(`fee bps must be an integer in [0, 10000], got ${bps}`);
	}
	const fee = (gross * BigInt(bps)) / 10_000n; // bigint division truncates → rounds down
	const net = gross - fee;
	/* istanbul ignore if — arithmetic invariant, not a reachable branch */
	if (fee + net !== gross) throw new AmountError("fee split did not conserve value");
	return { fee, net };
}

/** Exact equality, for use where `===` on bigint is easy to misread as loose. */
export function isZero(base: bigint): boolean {
	return base === 0n;
}
