// -----------------------------------------------------------------------------
// Tests for exact money arithmetic.
//
// The cases that matter here are not "does 1.5 parse" — they are the ones that
// cost real money at real exchanges: precision loss on a downscale, a float
// sneaking in, a fee that rounds the wrong way, and the specific
// decimal(19,8)-vs-decimal(29,18) truncation that exists in the schema we are
// building on.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	AmountError,
	applyFeeBps,
	format,
	parse,
	rescale,
	type AssetUnit,
} from "../src/amount";

const ETH: AssetUnit = { symbol: "ETH", decimals: 18 };
const BTC: AssetUnit = { symbol: "BTC", decimals: 8 };
const USDC: AssetUnit = { symbol: "USDC", decimals: 6 };
const WHOLE: AssetUnit = { symbol: "WHOLE", decimals: 0 };

test("parse: whole and fractional values are exact", () => {
	assert.equal(parse("1", ETH), 10n ** 18n);
	assert.equal(parse("1.5", ETH), 1_500_000_000_000_000_000n);
	assert.equal(parse("0.000000000000000001", ETH), 1n);
	assert.equal(parse("1", BTC), 100_000_000n);
	assert.equal(parse("0.00000001", BTC), 1n);
	assert.equal(parse("1", WHOLE), 1n);
});

test("parse: a value far beyond Number.MAX_SAFE_INTEGER stays exact", () => {
	// 1e6 ETH is 1e24 wei. A float would have lost the low digits long before.
	const got = parse("1000000.000000000000000001", ETH);
	assert.equal(got, 1_000_000_000_000_000_000_000_000n + 1n);
	// And the round trip proves nothing was dropped in either direction.
	assert.equal(format(got, ETH), "1000000.000000000000000001");
});

test("parse: leading-dot, signs, and exponent forms", () => {
	assert.equal(parse(".5", BTC), 50_000_000n);
	assert.equal(parse("+1.5", BTC), 150_000_000n);
	assert.equal(parse("-1.5", BTC), -150_000_000n);
	assert.equal(parse("1e3", BTC), 1000n * 100_000_000n);
	assert.equal(parse("1.5E-2", BTC), parse("0.015", BTC));
	// Exponent that lands exactly on the asset's precision floor.
	assert.equal(parse("1e-8", BTC), 1n);
});

test("parse: REFUSES to silently drop precision", () => {
	// This is the decimal(19,8) bug in the TradeXPro schema, as a test. An
	// 18-decimal amount passing through an 8-decimal column loses the tail; here
	// it is a loud error instead of a quiet subtraction.
	assert.throws(() => parse("0.000000001", BTC), AmountError);
	assert.throws(() => parse("1.000000000000000001", BTC), AmountError);
	assert.throws(() => parse("0.5", WHOLE), AmountError);
	// The error names the asset and its precision, so the caller can tell the
	// user something true.
	assert.throws(() => parse("1e-9", BTC), /BTC has 8 decimals/);
});

test("parse: trailing zeros beyond precision are fine — they lose nothing", () => {
	assert.equal(parse("1.500000000000", BTC), 150_000_000n);
	assert.equal(parse("0.000000010000", BTC), 1n);
});

test("parse: rejects junk rather than coercing it", () => {
	for (const bad of ["", "   ", "abc", "1.2.3", "Infinity", "NaN", "0x10", "1,5", "--1", "1 2"]) {
		assert.throws(() => parse(bad, BTC), AmountError, `should reject ${JSON.stringify(bad)}`);
	}
	// A lone sign or dot has no digits.
	assert.throws(() => parse("-", BTC), AmountError);
	assert.throws(() => parse(".", BTC), AmountError);
});

test("parse: a non-string is rejected, not coerced", () => {
	// Guards the realistic case: JSON.parse gave us a number and a float has
	// already lost precision before our code ever ran.
	assert.throws(() => parse(1.5 as unknown as string, BTC), AmountError);
	assert.throws(() => parse(null as unknown as string, BTC), AmountError);
});

test("format: exact, never exponential, trailing zeros trimmed", () => {
	assert.equal(format(10n ** 18n, ETH), "1");
	assert.equal(format(1_500_000_000_000_000_000n, ETH), "1.5");
	assert.equal(format(1n, ETH), "0.000000000000000001");
	assert.equal(format(0n, ETH), "0");
	assert.equal(format(-1_500_000_000_000_000_000n, ETH), "-1.5");
	assert.equal(format(1n, WHOLE), "1");
	// Interior zeros must survive — "1.05" is not "1.5".
	assert.equal(format(parse("1.05", BTC), BTC), "1.05");
	assert.equal(format(parse("0.00000001", BTC), BTC), "0.00000001");
});

test("format: negative zero renders as zero", () => {
	assert.equal(format(-0n, ETH), "0");
});

test("round trip: format(parse(x)) is stable for every accepted x", () => {
	for (const unit of [ETH, BTC, USDC, WHOLE]) {
		for (const v of ["0", "1", "123456789"]) {
			assert.equal(format(parse(v, unit), unit), v);
		}
	}
	for (const v of ["1.5", "0.01", "99999.12345678", "-7.5"]) {
		assert.equal(format(parse(v, BTC), BTC), v);
	}
});

test("rescale: upscales freely, refuses lossy downscales", () => {
	assert.equal(rescale(1n, 6, 18), 10n ** 12n);
	assert.equal(rescale(10n ** 12n, 18, 6), 1n);
	assert.equal(rescale(5n, 8, 8), 5n);
	// 1 wei cannot be expressed in 6 decimals.
	assert.throws(() => rescale(1n, 18, 6), AmountError);
});

test("applyFeeBps: conserves value exactly and rounds the fee DOWN", () => {
	// 1 BTC at 10 bps = 0.001 BTC.
	const { fee, net } = applyFeeBps(parse("1", BTC), 10);
	assert.equal(fee, parse("0.001", BTC));
	assert.equal(fee + net, parse("1", BTC));

	// A sub-unit remainder goes to the customer, not the venue: 1 base unit at
	// 10 bps is 0.001 units, which truncates to a zero fee.
	const tiny = applyFeeBps(1n, 10);
	assert.equal(tiny.fee, 0n);
	assert.equal(tiny.net, 1n);

	// Conservation holds across a sweep of awkward values, which is the property
	// that actually matters — not any single expected number.
	for (const gross of [0n, 1n, 7n, 9_999n, 10_001n, 123_456_789n, 10n ** 24n + 7n]) {
		for (const bps of [0, 1, 7, 25, 100, 9_999, 10_000]) {
			const r = applyFeeBps(gross, bps);
			assert.equal(r.fee + r.net, gross, `${gross} @ ${bps}bps must conserve`);
			assert.ok(r.fee >= 0n && r.net >= 0n, `${gross} @ ${bps}bps went negative`);
			assert.ok(r.fee <= gross, `${gross} @ ${bps}bps fee exceeded gross`);
		}
	}
});

test("applyFeeBps: rejects negative amounts and out-of-range rates", () => {
	assert.throws(() => applyFeeBps(-1n, 10), AmountError);
	assert.throws(() => applyFeeBps(100n, -1), AmountError);
	assert.throws(() => applyFeeBps(100n, 10_001), AmountError);
	assert.throws(() => applyFeeBps(100n, 1.5), AmountError);
});

test("an invalid asset definition is caught, not trusted", () => {
	assert.throws(() => parse("1", { symbol: "X", decimals: -1 }), AmountError);
	assert.throws(() => parse("1", { symbol: "X", decimals: 1.5 }), AmountError);
	assert.throws(() => parse("1", { symbol: "X", decimals: 999 }), AmountError);
});
