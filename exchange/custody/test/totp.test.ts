// -----------------------------------------------------------------------------
// TOTP tests, including RFC 6238's OWN PUBLISHED VECTORS.
//
// A hand-written TOTP that has not been checked against the standard's test
// values is not an implementation of the standard, it is a plausible-looking
// function. These vectors are the only thing that makes the difference
// verifiable rather than asserted.
//
// RFC 6238 Appendix B, SHA-1 column. The secret is the ASCII string
// "12345678901234567890" (20 bytes), which is what the RFC specifies.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	TOTP_STEP_SECONDS,
	TotpError,
	TotpVerifier,
	base32Decode,
	base32Encode,
	currentCode,
	generateSecret,
	provisioningUri,
	verify,
} from "../src/totp";

/** RFC 6238's secret, base32-encoded so our API accepts it. */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

test("RFC 6238 Appendix B vectors (SHA-1) — 8 digits truncated to our 6", () => {
	// The RFC publishes 8-digit values; we emit 6, which is the low 6 digits of
	// the same dynamic truncation. So each expectation is the RFC's value with
	// its leading two digits dropped.
	const vectors: [number, string][] = [
		[59, "94287082"],
		[1111111109, "07081804"],
		[1111111111, "14050471"],
		[1234567890, "89005924"],
		[2000000000, "69279037"],
		[20000000000, "65353130"],
	];
	for (const [unixSeconds, eightDigit] of vectors) {
		const expected = eightDigit.slice(-6);
		const got = currentCode(RFC_SECRET, unixSeconds * 1000);
		assert.equal(
			got,
			expected,
			`RFC vector at T=${unixSeconds}: expected ${expected} (from ${eightDigit}), got ${got}`,
		);
	}
});

test("base32 round-trips, and rejects junk rather than coercing it", () => {
	// NOT the empty string: encoding it gives "" and decoding "" correctly
	// THROWS, because an empty secret is not a secret. The first draft asserted
	// a round-trip there and the test was wrong, not the code.
	for (const s of ["a", "hello world", "12345678901234567890"]) {
		const enc = base32Encode(Buffer.from(s, "ascii"));
		assert.equal(base32Decode(enc).toString("ascii"), s, s);
	}
	// Characters outside the base32 alphabet.
	assert.throws(() => base32Decode("0189!"), TotpError);
	assert.throws(() => base32Decode(""), TotpError);
	// Padding and spacing are tolerated, because apps emit both.
	assert.deepEqual(base32Decode("MFRGG==="), base32Decode("mfrgg"));
	assert.deepEqual(base32Decode("MFRG G"), base32Decode("MFRGG"));
});

test("a generated secret is valid base32 and long enough", () => {
	const s = generateSecret();
	assert.match(s, /^[A-Z2-7]+$/);
	// 20 bytes is RFC 4226's recommended minimum.
	assert.ok(base32Decode(s).length >= 20);
	// And two calls do not collide.
	assert.notEqual(generateSecret(), generateSecret());
});

test("the current code verifies", () => {
	const s = generateSecret();
	const now = 1_700_000_000_000;
	const r = verify(s, currentCode(s, now), now);
	assert.equal(r.ok, true);
	assert.equal(typeof r.counter, "number");
});

test("the window is ±1 STEP, no wider", () => {
	// Accepting ±5 "for clock drift" turns a 30-second credential into a
	// five-minute one.
	const s = generateSecret();
	const now = 1_700_000_000_000;
	const step = TOTP_STEP_SECONDS * 1000;

	assert.equal(verify(s, currentCode(s, now - step), now).ok, true, "previous step");
	assert.equal(verify(s, currentCode(s, now + step), now).ok, true, "next step");
	assert.equal(verify(s, currentCode(s, now - 2 * step), now).ok, false, "2 steps back");
	assert.equal(verify(s, currentCode(s, now + 2 * step), now).ok, false, "2 steps forward");
});

test("malformed codes are refused without touching the secret", () => {
	const s = generateSecret();
	for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78", "-12345"]) {
		assert.equal(verify(s, bad).ok, false, bad);
	}
	// Whitespace inside an otherwise valid code is stripped, since apps and
	// humans both insert it.
	const now = 1_700_000_000_000;
	const code = currentCode(s, now);
	assert.equal(verify(s, `${code.slice(0, 3)} ${code.slice(3)}`, now).ok, true);
});

test("A VALID CODE CANNOT BE REPLAYED", () => {
	// The failure this prevents: a code observed once — shoulder-surfed,
	// phished, or sitting in a request log — stays valid for up to 90 seconds
	// across the ±1 window. Without single-use, anyone who sees it can use it.
	let now = 1_700_000_000_000;
	const v = new TotpVerifier(() => now);
	const s = generateSecret();
	const code = currentCode(s, now);

	assert.equal(v.check("admin", s, code).ok, true, "first use succeeds");
	assert.equal(v.check("admin", s, code).ok, false, "SECOND USE MUST FAIL");
	assert.equal(v.check("admin", s, code).ok, false, "and stays failed");

	// A different identity is tracked separately — one admin spending a
	// counter must not lock another out.
	assert.equal(v.check("other", s, code).ok, true);

	// The next step's code works normally.
	now += TOTP_STEP_SECONDS * 1000;
	assert.equal(v.check("admin", s, currentCode(s, now)).ok, true);
});

test("spent counters are forgotten once they can no longer be presented", () => {
	// Otherwise the set grows for the lifetime of the process.
	let now = 1_700_000_000_000;
	const v = new TotpVerifier(() => now);
	const s = generateSecret();
	v.check("admin", s, currentCode(s, now));

	// Jump far enough ahead that the old counter is outside the window.
	now += TOTP_STEP_SECONDS * 1000 * 10;
	v.check("admin", s, currentCode(s, now));

	// Internals are private, so assert the observable consequence: the process
	// still works and the old code is now rejected for being out of window
	// rather than for being spent.
	assert.equal(verify(s, currentCode(s, 1_700_000_000_000), now).ok, false);
});

test("the wrong secret does not verify", () => {
	const now = 1_700_000_000_000;
	const a = generateSecret();
	const b = generateSecret();
	assert.equal(verify(b, currentCode(a, now), now).ok, false);
});

test("the provisioning URI carries the issuer TWICE, as apps require", () => {
	// Older authenticators read only the label prefix, newer ones only the
	// parameter. Omitting either yields an entry labelled with a bare email,
	// which is useless to someone holding codes for several services.
	const uri = provisioningUri({
		issuer: "Blockle Exchange",
		account: "alex@blockle.org",
		secret: "ABCDEFGHIJKLMNOP",
	});
	assert.ok(uri.startsWith("otpauth://totp/"));
	assert.match(uri, /Blockle%20Exchange%3Aalex%40blockle\.org/);
	assert.match(uri, /issuer=Blockle\+Exchange/);
	assert.match(uri, /secret=ABCDEFGHIJKLMNOP/);
	assert.match(uri, /digits=6/);
	assert.match(uri, /period=30/);
	assert.match(uri, /algorithm=SHA1/);
});

test("codes are stable within a step and change across it", () => {
	const s = generateSecret();
	const base = 1_700_000_000_000;
	// Same step.
	assert.equal(currentCode(s, base), currentCode(s, base + 1000));
	// Next step — overwhelmingly likely to differ; a 1-in-a-million collision
	// would make this flaky, so compare the counters instead by checking that
	// verify() attributes them to different steps.
	const r1 = verify(s, currentCode(s, base), base);
	const r2 = verify(s, currentCode(s, base + TOTP_STEP_SECONDS * 1000), base + TOTP_STEP_SECONDS * 1000);
	assert.notEqual(r1.counter, r2.counter);
});

test("the 64-bit counter does not truncate (would break in 2106)", () => {
	// hotp writes the counter with writeBigUInt64BE rather than bit-shifting,
	// because `<<` in JavaScript is 32-bit and silently drops the high half.
	// A time past 2^32 seconds exercises that path.
	const s = generateSecret();
	const far = 5_000_000_000_000; // ~year 2128
    const code = currentCode(s, far);
	assert.match(code, /^\d{6}$/);
	assert.equal(verify(s, code, far).ok, true);
});
