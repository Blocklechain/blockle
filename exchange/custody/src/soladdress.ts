// -----------------------------------------------------------------------------
// IS THIS STRING A SOLANA ADDRESS THAT COINS CAN ACTUALLY LEAVE AGAIN?
//
// WHY THIS FILE IS MORE THAN A REGEX, WHICH IS WHAT BLOCK GETS AWAY WITH.
//
// `blockaddresspool.assertAddress` is one regex — `/^block1[0-9a-z]{20,}$/` —
// and that is enough, because bech32m is a checksummed encoding of a fixed
// payload: a corrupted BLOCK address does not look like a BLOCK address.
//
// Base58 has no checksum. A Solana address is the raw 32 bytes of an ed25519
// public key, base58-encoded and nothing else, so EVERY ONE OF THESE IS A
// STRING THAT PASSES ANY PLAUSIBLE REGEX AND IS NOT AN ADDRESS WE CAN SPEND
// FROM:
//
//   * 31 or 33 bytes. Base58 length is not a function of byte length — a
//     32-byte value encodes to 43 or 44 characters, and a 31-byte value also
//     encodes to 43. Counting characters cannot tell them apart; only decoding
//     can. (The pool fixtures in the tests include a 43-character key with a
//     leading zero byte for exactly this reason.)
//   * 32 bytes that are not a point on the ed25519 curve. This is what a
//     Solana PDA is — an address found by searching for a value that is NOT on
//     the curve, precisely so that no private key exists for it. Roughly half
//     of all 32-byte strings are off-curve, so a single flipped character has
//     about even odds of producing one.
//   * a non-canonical encoding, y >= 2^255-19, which some decoders accept and
//     which does not round-trip.
//   * a point of order 1, 2 or 4 — the identity, and the two x=0 points. The
//     all-zero address `11111111111111111111111111111111` (the System
//     Program's own id) is one of these: on the curve, valid-looking, and with
//     no signer behind it.
//
// AND THE CONSEQUENCE IS NOT A FAILED REQUEST. It is a deposit address handed
// to a customer out of which no transaction can ever be signed. The coins
// arrive, the venue credits them because the deposit is real, and the sweep
// can never be composed: a permanent liability with an unrecoverable asset
// behind it, which is the one thing design rule 4 exists to forbid. So the
// check happens at LOAD time, like BLOCK's, where the cost of being wrong is
// an error message instead of a customer's money.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not prove the address came from
// our seed. Nothing online can — that is the signer host's job, by re-deriving
// every source from the seed at the recorded index before it signs. This only
// proves the string is a spendable-shaped Solana address.
// -----------------------------------------------------------------------------

/** Base58, Bitcoin alphabet — no 0, O, I or l, which is the whole point of it. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const VALUE = new Map<string, bigint>(
	[...ALPHABET].map((c, i) => [c, BigInt(i)]),
);

/** An ed25519 public key is 32 bytes. Always, on every chain that uses them. */
export const SOL_ADDRESS_BYTES = 32;

/* ------------------------------------------------------------------ base58 */

/**
 * Decode base58, or undefined when the string is not base58 at all.
 *
 * Undefined rather than a throw because the callers here all want to say
 * something more specific than "bad base58" — the pool names the entry number
 * in the batch, which is what an operator at 2am actually needs.
 *
 * LEADING ONES ARE LEADING ZERO BYTES and they are not decoration: a key whose
 * first byte is 0x00 encodes to 43 characters with a leading `1`, and dropping
 * it would silently produce a 31-byte value. That is the bug this function is
 * most likely to be asked to have.
 */
export function base58Decode(s: string): Uint8Array | undefined {
	if (s.length === 0) return undefined;
	let n = 0n;
	for (const ch of s) {
		const v = VALUE.get(ch);
		if (v === undefined) return undefined;
		n = n * 58n + v;
	}
	const digits: number[] = [];
	while (n > 0n) {
		digits.push(Number(n & 0xffn));
		n >>= 8n;
	}
	digits.reverse();
	let zeros = 0;
	for (const ch of s) {
		if (ch !== "1") break;
		zeros += 1;
	}
	return new Uint8Array([...new Array<number>(zeros).fill(0), ...digits]);
}

/** Encode base58. Here for tests and operator output, not for the money path. */
export function base58Encode(bytes: Uint8Array): string {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	let out = "";
	while (n > 0n) {
		out = ALPHABET[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const b of bytes) {
		if (b !== 0) break;
		out = `1${out}`;
	}
	return out === "" ? "1" : out;
}

/* ------------------------------------------------------------- the curve */

/** 2^255 - 19, the ed25519 field prime. */
const P = (1n << 255n) - 19n;

function mod(a: bigint): bigint {
	const r = a % P;
	return r < 0n ? r + P : r;
}

function modPow(base: bigint, exp: bigint): bigint {
	let result = 1n;
	let b = mod(base);
	let e = exp;
	while (e > 0n) {
		if ((e & 1n) === 1n) result = (result * b) % P;
		b = (b * b) % P;
		e >>= 1n;
	}
	return result;
}

/** Fermat inverse. P is prime, so a^(P-2) is a^-1 for every a != 0. */
function modInv(a: bigint): bigint {
	return modPow(a, P - 2n);
}

/** d = -121665/121666, the ed25519 curve constant. */
const D = mod(mod(-121665n) * modInv(121666n));

/**
 * WHY THE EXPENSIVE VERSION OF THIS CHECK IS THE ONLY USEFUL ONE.
 *
 * An ed25519 public key is a compressed point: 255 bits of y, and the top bit
 * is the sign of x. Recovering x means solving
 *
 *     x^2 = (y^2 - 1) / (d*y^2 + 1)
 *
 * and the address is only a real public key if that right-hand side is a
 * QUADRATIC RESIDUE mod p — otherwise no x exists and the value is off-curve,
 * i.e. exactly the shape Solana's `findProgramAddress` searches for.
 *
 * The cheap version of this check — computing the square root unconditionally
 * and not verifying it — is a silent accept of garbage. This repo has already
 * been bitten by that exact shortcut in another curve's code: the sibling
 * secp256k1 implementation in services/accounts/src/vendor/secp256k1.js
 * computes y = (x^3+7)^((p+1)/4) and never checks y^2 == x^3+7, so an invalid
 * x yields a junk point rather than an error. Here the input is operator-typed
 * and a whole pool of deposit addresses rides on it, so the Euler criterion is
 * computed and compared. It is one modexp — about 0.1ms — and it runs once per
 * address at load time, never per request.
 *
 * SMALL-ORDER POINTS ARE REJECTED TOO, and for a different reason than
 * off-curve ones: they are genuinely on the curve, but no derivation produces
 * them and no private key signs for them. `x^2 == 0` is the identity (0,1) and
 * the order-2 point (0,-1); `y == 0` is an order-4 point. The all-zero address
 * — base58 `11111111111111111111111111111111`, the System Program — is the
 * order-4 case, and it is the single most likely wrong value for a batch file
 * to contain, because it is what an all-zeros buffer encodes to.
 *
 * The four points of order 8 are NOT enumerated here. Said out loud rather
 * than hidden: an exhaustive small-subgroup check needs point arithmetic and a
 * scalar multiplication by the group order, which is a lot of new code on the
 * money path to exclude four specific 32-byte values that our own SLIP-0010
 * derivation cannot emit and that nobody types by accident. If that ever stops
 * being true, this is the function to extend.
 */
export function isEd25519PublicKey(bytes: Uint8Array): boolean {
	if (bytes.length !== SOL_ADDRESS_BYTES) return false;

	// Little-endian, which is how ed25519 encodes field elements. Reading it
	// big-endian would reject valid keys about half the time and accept invalid
	// ones just as often, so this is worth being explicit about.
	let n = 0n;
	for (let i = bytes.length - 1; i >= 0; i -= 1) {
		n = (n << 8n) | BigInt(bytes[i] as number);
	}
	const y = n & ((1n << 255n) - 1n);
	const sign = (n >> 255n) & 1n;

	// Non-canonical: y must be a field element. Decoders that wrap this around
	// disagree with each other about what address the string names, and an
	// address two implementations spell differently is not an address.
	if (y >= P) return false;

	// Order 4. (y = 0 gives x^2 = -1, which is a residue mod p, so this one
	// passes the curve equation and must be excluded by name.)
	if (y === 0n) return false;

	const yy = (y * y) % P;
	const u = mod(yy - 1n);
	const v = mod(D * yy + 1n);
	if (v === 0n) return false; // no solution exists at all
	const xx = (u * modInv(v)) % P;

	// x = 0: the identity and the order-2 point. On the curve, unspendable.
	if (xx === 0n) return false;

	// Euler's criterion. 1 means a square root exists, i.e. the point is real.
	// Anything else (p-1) means off-curve — a PDA, or a typo.
	if (modPow(xx, (P - 1n) / 2n) !== 1n) return false;

	// The sign bit is free: both x and -x are on the curve, so either value of
	// this bit names a real point. Checked for nothing, mentioned so the next
	// reader does not add a bogus constraint on it.
	void sign;
	return true;
}

/** Why a string is not usable as a Solana deposit address. */
export type SolAddressFault =
	| "not-base58"
	| "wrong-length"
	| "not-on-curve"
	| "blank";

export interface SolAddressVerdict {
	readonly ok: boolean;
	readonly fault?: SolAddressFault;
	/** Operator-facing, specific enough to act on. */
	readonly why?: string;
	readonly bytes?: Uint8Array;
}

/** Decode and check, reporting WHICH of the four failures it was. */
export function checkSolAddress(address: string): SolAddressVerdict {
	const s = address.trim();
	if (s === "") return { ok: false, fault: "blank", why: "an address is required" };
	const bytes = base58Decode(s);
	if (bytes === undefined) {
		return {
			ok: false,
			fault: "not-base58",
			why:
				"not base58 — Solana addresses use the Bitcoin alphabet, which has no " +
				"0, O, I or l. A character substituted by a copy-paste or a font is " +
				"the usual cause.",
		};
	}
	if (bytes.length !== SOL_ADDRESS_BYTES) {
		return {
			ok: false,
			fault: "wrong-length",
			why:
				`decodes to ${bytes.length} bytes, not ${SOL_ADDRESS_BYTES}. Length in ` +
				"characters proves nothing here: a 31-byte value and a 32-byte value " +
				"with a leading zero byte both encode to 43 characters.",
		};
	}
	if (!isEd25519PublicKey(bytes)) {
		return {
			ok: false,
			fault: "not-on-curve",
			why:
				"32 bytes, but not a usable ed25519 public key — it is off-curve, " +
				"non-canonical, or a small-order point. That is the shape of a " +
				"program-derived address: nothing can ever sign for it, so coins sent " +
				"to it could never be swept back out.",
		};
	}
	return { ok: true, bytes };
}

/** True when the string is a spendable-shaped Solana address. */
export function isSolAddress(address: string): boolean {
	return checkSolAddress(address).ok;
}
