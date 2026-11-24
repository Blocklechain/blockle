// -----------------------------------------------------------------------------
// TOTP (RFC 6238) — time-based one-time passwords, for the admin portal.
//
// WHY THIS IS HAND-WRITTEN AND NOT A DEPENDENCY.
//
// It is about sixty lines of HMAC and a modulo, it is a frozen standard, and it
// sits directly in front of the one surface that can edit the velocity caps —
// which are the only brake on an automated withdrawal path. A supply-chain
// compromise in a transitive dependency of a convenience wrapper would be a
// compromise of the authentication on the venue's treasury controls. The
// primitive it needs (HMAC-SHA1) is in node:crypto.
//
// THREE THINGS IMPLEMENTATIONS GET WRONG, all handled explicitly below:
//
// 1. NO REPLAY PROTECTION. A valid 6-digit code stays valid for its whole
//    30-second step, and with a ±1 window for ninety seconds. Anyone who can
//    observe one code — shoulder-surfing, a phished form, a logged request —
//    can reuse it until it expires. So `verify` is paired with a used-code
//    store and the caller MUST consult it; see `TotpVerifier`.
//
// 2. STRING COMPARISON. Comparing codes with === leaks position through timing.
//    Six digits is a small space, and an attacker who can measure the compare
//    can narrow it. timingSafeEqual, always.
//
// 3. AN UNBOUNDED CLOCK WINDOW. Accepting ±5 steps to be "forgiving about
//    clock drift" turns a 30-second credential into a five-minute one. ±1 step
//    is the standard allowance and is what a phone with NTP needs.
//
// SHA-1 is correct here. RFC 6238's default HMAC is SHA-1 and every
// authenticator app implements that; its use in HMAC is not affected by the
// collision attacks that retired SHA-1 for signatures.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class TotpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TotpError";
	}
}

const STEP_SECONDS = 30;
const DIGITS = 6;
/** ±1 step. See note 3 above. */
const WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh base32 secret, in the form authenticator apps expect. */
export function generateSecret(bytes = 20): string {
	return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	// No "=" padding: authenticator apps accept unpadded and several reject
	// padded secrets outright.
	return out;
}

export function base32Decode(s: string): Buffer {
	const clean = s.toUpperCase().replace(/[\s=-]/g, "");
	if (clean === "" || /[^A-Z2-7]/.test(clean)) {
		throw new TotpError("not a base32 secret");
	}
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		value = (value << 5) | B32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** The code for a given secret and counter. */
function hotp(secret: Buffer, counter: number): string {
	// 8-byte big-endian counter. Written via a DataView rather than
	// bit-shifting, because `<<` in JavaScript is 32-bit and silently truncates
	// the high half of the counter — which only breaks in the year 2106, i.e.
	// exactly the kind of bug that is never found.
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));

	const mac = createHmac("sha1", secret).update(buf).digest();
	// Dynamic truncation, RFC 4226 §5.4.
	const offset = mac[mac.length - 1]! & 0x0f;
	const bin =
		((mac[offset]! & 0x7f) << 24) |
		((mac[offset + 1]! & 0xff) << 16) |
		((mac[offset + 2]! & 0xff) << 8) |
		(mac[offset + 3]! & 0xff);
	return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The code valid right now. Exposed for tests and for enrolment confirmation. */
export function currentCode(secret: string, now = Date.now()): string {
	return hotp(base32Decode(secret), Math.floor(now / 1000 / STEP_SECONDS));
}

export interface VerifyResult {
	readonly ok: boolean;
	/**
	 * The counter the code matched, when it did. The CALLER MUST RECORD THIS
	 * and refuse the same (secret, counter) pair again — without that, a code
	 * is replayable for up to 90 seconds. See note 1.
	 */
	readonly counter: number | undefined;
}

/**
 * Check a code against a secret, within ±1 step.
 *
 * Returns the matched counter rather than just a boolean, precisely so replay
 * protection is possible. A function that returned only `true` would make the
 * replay bug the default.
 */
export function verify(secret: string, code: string, now = Date.now()): VerifyResult {
	const trimmed = code.replace(/\s/g, "");
	if (!/^\d{6}$/.test(trimmed)) return { ok: false, counter: undefined };

	const key = base32Decode(secret);
	const current = Math.floor(now / 1000 / STEP_SECONDS);
	const given = Buffer.from(trimmed, "utf8");

	// Check every candidate step even after a match, so the work done does not
	// depend on WHICH step matched.
	let matched: number | undefined;
	for (let d = -WINDOW; d <= WINDOW; d++) {
		const counter = current + d;
		const expect = Buffer.from(hotp(key, counter), "utf8");
		if (expect.length === given.length && timingSafeEqual(expect, given)) {
			if (matched === undefined) matched = counter;
		}
	}
	return matched === undefined
		? { ok: false, counter: undefined }
		: { ok: true, counter: matched };
}

/**
 * Verification with replay protection.
 *
 * Wraps `verify` with a record of spent counters, because the raw function
 * cannot enforce single-use on its own and leaving that to each call site means
 * one of them will forget.
 */
export class TotpVerifier {
	private readonly spent = new Map<string, Set<number>>();

	constructor(private readonly now: () => number = () => Date.now()) {}

	/**
	 * True only if the code is valid AND this counter has not been used before
	 * for this identity.
	 */
	check(identity: string, secret: string, code: string): VerifyResult {
		const r = verify(secret, code, this.now());
		if (!r.ok || r.counter === undefined) return r;

		const used = this.spent.get(identity) ?? new Set<number>();
		if (used.has(r.counter)) {
			// A REPLAY. Valid code, already spent.
			return { ok: false, counter: undefined };
		}
		used.add(r.counter);
		// Forget counters that can no longer be presented, so this does not
		// grow without bound in a long-running process.
		const floor = Math.floor(this.now() / 1000 / STEP_SECONDS) - WINDOW - 1;
		for (const c of used) if (c < floor) used.delete(c);
		this.spent.set(identity, used);
		return r;
	}
}

/**
 * The otpauth:// URI an authenticator app scans.
 *
 * `issuer` appears twice by design — as a label prefix and as a parameter.
 * Older apps read only the prefix, newer ones only the parameter, and omitting
 * either produces an entry labelled with just an email address, which is
 * useless to anyone holding codes for several services.
 */
export function provisioningUri(args: {
	issuer: string;
	account: string;
	secret: string;
}): string {
	const label = encodeURIComponent(`${args.issuer}:${args.account}`);
	const q = new URLSearchParams({
		secret: args.secret,
		issuer: args.issuer,
		algorithm: "SHA1",
		digits: String(DIGITS),
		period: String(STEP_SECONDS),
	});
	return `otpauth://totp/${label}?${q.toString()}`;
}

export const TOTP_STEP_SECONDS = STEP_SECONDS;
export const TOTP_WINDOW_STEPS = WINDOW;
