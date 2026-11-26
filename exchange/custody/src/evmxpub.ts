// -----------------------------------------------------------------------------
// EVM DEPOSIT ADDRESSES FROM AN EXTENDED PUBLIC KEY — derivation with no key.
//
// THE POINT OF THIS FILE IS THE SAME AS blockaddresspool.ts, BY A DIFFERENT
// ROUTE, AND THE DIFFERENCE IS A FACT ABOUT THE CURVE.
//
// BLOCK signs with ML-DSA, which has NO watch-only derivation: there is no
// public value from which addresses follow without the secret, so anything that
// derives a BLOCK address necessarily holds spending authority for it. That is
// why BLOCK deposits come from a pool an operator fills offline.
//
// secp256k1 is not like that. A BIP32 non-hardened child public key is
// `parentPub + IL*G` — point arithmetic on public values only. So this process
// can hold an account-level xpub, derive m/44'/60'/0'/0/i for every customer
// online, and be MATHEMATICALLY INCAPABLE of signing for any of them. Not
// "configured not to". Incapable: there is no private scalar anywhere on this
// host to be stolen, leaked by a systemd `Environment=` line, or reached by a
// flaw in the public API.
//
// WHAT THE XPUB STILL COSTS, SAID PLAINLY, BECAUSE IT IS EASY TO MISREAD THIS
// FILE AS "THE XPUB IS HARMLESS":
//
//   Anyone who reads EVM_ACCOUNT_XPUB can enumerate EVERY customer deposit
//   address on EVERY EVM chain, retroactively and forever, and link them to
//   each other. It steals nothing. It is a complete, permanent targeting and
//   deanonymisation list. So it is handled as secret-grade configuration: read
//   from a file, never logged, never printed in an error, never put in a
//   systemd `Environment=` line (the standing security audit already found that
//   those leak to any local user on this box), and rotated to a fresh account
//   if it is ever disclosed. `safeDescribe()` below exists so that operator
//   output can prove WHICH xpub is loaded without printing it.
//
// ONE XPUB, NOT ONE PER CHAIN, AND THAT IS NOT LAZINESS. The same secp256k1
// account is reused across every EVM chain by construction — the house's own
// wallet code records it at services/accounts/src/vendor/evm.js:3 ("SAME key
// across all EVM chains") — so customer N's Ethereum, BSC and Polygon deposit
// addresses are IDENTICAL whatever we do here. A second xpub would buy no
// isolation and would add a second seed to lose. Deposit attribution therefore
// keys on (chain, txid, ref, address) and NEVER on (address, amount): the same
// address receiving the same amount on two chains is normal, not a duplicate.
//
// WHY THIS IS HAND-WRITTEN HERE RATHER THAN IMPORTED.
//
// The house already has a correct BIP32 in services/accounts/src/vendor/hd.js,
// and this file was checked against it line by line. It is not imported because
// (a) this package compiles a closed TypeScript tree with exactly one runtime
// dependency (better-sqlite3) and reaching into a sibling service's untyped JS
// would make the custody build depend on the accounts build, and (b) hd.js is a
// FULL BIP32 — it derives private keys, hardened children and master keys from
// a seed. Importing it would put key-derivation code inside the custody process
// for no reason, and test/evmrailguards.test.ts asserts structurally that no
// such code is reachable from here. What is below is the public half only. It
// cannot derive a private key because it contains no code that could.
//
// THE DELIBERATE DIFFERENCE FROM hd.js, AND THE BUG IT AVOIDS.
//
// hd.js handles the (astronomically unlikely) invalid-child case with
// `return deriveChild(node, index + 1)` — it silently derives a DIFFERENT index
// and returns a node whose `.index` is the one it actually used. That is
// BIP32-correct, and it is wrong for a deposit pool, because the recorded index
// IS the recoverability contract: with the seed and that number the offline
// signer re-derives the key that spends whatever arrived. A silent shift makes
// the stored index describe an address the signer will not reproduce. So
// `deriveChildPublic` THROWS on that case instead, and the index allocator
// advances deliberately and records the index it actually used. Probability is
// about 2^-127 per index, which is exactly why it must be handled by refusing
// rather than by code nobody will ever see run.
// -----------------------------------------------------------------------------

import { createHash, createHmac } from "node:crypto";

export class XpubError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "XpubError";
	}
}

/**
 * The standard account-level path for an EVM deposit account.
 *
 * Recorded as a constant because it is HALF OF THE RECOVERABILITY CONTRACT.
 * The pool stores a bare integer `i`; the offline signer re-derives
 * `${EVM_ACCOUNT_PATH}/${i}`. If the two ends disagree about the prefix, every
 * recorded index points at an address whose key nobody can find, and the error
 * is invisible until the first sweep fails.
 */
export const EVM_ACCOUNT_PATH = "m/44'/60'/0'/0";

/* ------------------------------------------------------- secp256k1 field math */

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const B = 7n;

/** An affine point, or null for the point at infinity. */
type Point = readonly [bigint, bigint] | null;

const G: Point = [Gx, Gy];

function mod(a: bigint, m: bigint = P): bigint {
	const r = a % m;
	return r >= 0n ? r : r + m;
}

function invMod(a: bigint, m: bigint = P): bigint {
	let [oldR, r] = [mod(a, m), m];
	let [oldS, s] = [1n, 0n];
	while (r !== 0n) {
		const q = oldR / r;
		[oldR, r] = [r, oldR - q * r];
		[oldS, s] = [s, oldS - q * s];
	}
	if (oldR !== 1n) throw new XpubError("not invertible — the modulus is wrong");
	return mod(oldS, m);
}

function powMod(base: bigint, exp: bigint, m: bigint): bigint {
	let b = mod(base, m);
	let e = exp;
	let out = 1n;
	while (e > 0n) {
		if ((e & 1n) === 1n) out = mod(out * b, m);
		b = mod(b * b, m);
		e >>= 1n;
	}
	return out;
}

/** Affine point addition. Clear rather than fast: this runs once per address. */
function pointAdd(p1: Point, p2: Point): Point {
	if (p1 === null) return p2;
	if (p2 === null) return p1;
	const [x1, y1] = p1;
	const [x2, y2] = p2;
	if (x1 === x2 && mod(y1 + y2) === 0n) return null;
	const m = x1 === x2 && y1 === y2
		? mod(3n * x1 * x1 * invMod(2n * y1))
		: mod((y2 - y1) * invMod(x2 - x1));
	const x3 = mod(m * m - x1 - x2);
	return [x3, mod(m * (x1 - x3) - y1)];
}

function pointMul(k: bigint, point: Point): Point {
	let kk = mod(k, N);
	let result: Point = null;
	let addend = point;
	while (kk > 0n) {
		if ((kk & 1n) === 1n) result = pointAdd(result, addend);
		addend = pointAdd(addend, addend);
		kk >>= 1n;
	}
	return result;
}

/** y^2 === x^3 + 7 (mod p). The check the vendor decoder does not do. */
function isOnCurve(x: bigint, y: bigint): boolean {
	if (x <= 0n || x >= P || y <= 0n || y >= P) return false;
	return mod(y * y) === mod(x * x * x + B);
}

/**
 * A 33-byte compressed public key to a point, VERIFIED ON THE CURVE.
 *
 * THE VERIFICATION IS THE WHOLE REASON THIS FUNCTION EXISTS RATHER THAN A
 * ONE-LINE REUSE. services/accounts/src/vendor/secp256k1.js `decodePoint`
 * computes `y = (x^3+7)^((P+1)/4)` and never checks `y^2 === x^3+7`, so an x
 * that is not on the curve yields a silent junk point rather than an error.
 * That is harmless there, where every input came from the library's own
 * `encodePoint`. It is NOT harmless here: the input is an xpub typed by an
 * operator at 2am, and every customer deposit address on every EVM chain is
 * derived from it. A junk point derives a pool of real-looking, correctly
 * checksummed addresses that no key on earth can spend — and the error would
 * not surface until the first customer's money was already sitting at one.
 */
function decodePointChecked(pub: Uint8Array, what: string): Point {
	if (pub.length !== 33) {
		throw new XpubError(`${what}: a compressed public key is 33 bytes, got ${pub.length}`);
	}
	const prefix = pub[0];
	if (prefix !== 0x02 && prefix !== 0x03) {
		throw new XpubError(
			`${what}: a compressed public key starts with 0x02 or 0x03, got ` +
				`0x${(prefix ?? 0).toString(16).padStart(2, "0")}. 0x04 is the ` +
				"uncompressed form, which BIP32 does not use.",
		);
	}
	const x = bytesToBig(pub.subarray(1));
	if (x === 0n || x >= P) throw new XpubError(`${what}: x is not a field element`);
	const ySq = mod(x * x * x + B);
	let y = powMod(ySq, (P + 1n) / 4n, P);
	if ((y & 1n) !== BigInt(prefix & 1)) y = mod(-y);
	if (!isOnCurve(x, y)) {
		throw new XpubError(
			`${what}: this is not a point on secp256k1. The key bytes decode to a ` +
				"well-formed-looking value that is not on the curve, which is what a " +
				"typo in an xpub looks like. Refusing it here, because the alternative " +
				"is a pool of deposit addresses nobody holds the key to.",
		);
	}
	return [x, y];
}

function encodePointCompressed(q: Point): Uint8Array {
	if (q === null) throw new XpubError("the point at infinity has no encoding");
	const [x, y] = q;
	const out = new Uint8Array(33);
	out[0] = (y & 1n) === 0n ? 0x02 : 0x03;
	out.set(bigTo32(x), 1);
	return out;
}

function encodePointUncompressed(q: Point): Uint8Array {
	if (q === null) throw new XpubError("the point at infinity has no encoding");
	const [x, y] = q;
	const out = new Uint8Array(65);
	out[0] = 0x04;
	out.set(bigTo32(x), 1);
	out.set(bigTo32(y), 33);
	return out;
}

function bytesToBig(b: Uint8Array): bigint {
	let x = 0n;
	for (const v of b) x = (x << 8n) | BigInt(v);
	return x;
}

function bigTo32(v: bigint): Uint8Array {
	const out = new Uint8Array(32);
	let x = v;
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(x & 0xffn);
		x >>= 8n;
	}
	return out;
}

function hex(b: Uint8Array): string {
	let s = "";
	for (const v of b) s += v.toString(16).padStart(2, "0");
	return s;
}

/* ------------------------------------------------------------------- keccak */

const KECCAK_RC: readonly bigint[] = [
	0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
	0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
	0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
	0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
	0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
	0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT: readonly number[] = [
	0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];
const MASK64 = (1n << 64n) - 1n;

/**
 * keccak256 — Ethereum's hash, and NOT the one in Node's crypto.
 *
 * `createHash('sha3-256')` is NIST SHA3, which differs from Keccak only in the
 * padding byte (0x06 against 0x01) and therefore produces a COMPLETELY
 * different digest. Using it would yield plausible-looking 20-byte addresses
 * that no Ethereum client agrees with. There is no keccak in Node, so it is
 * implemented here; the golden vectors in test/evmxpub.test.ts pin it against
 * the published empty-string digest before any address is trusted.
 *
 * Lanes are BigInt rather than the vendor file's hi/lo 32-bit pairs. One hash
 * per deposit address makes speed irrelevant, and the 64-bit form is the one a
 * reader can check against the specification without tracking carries.
 */
export function keccak256(msg: Uint8Array): Uint8Array {
	const rate = 136; // 1088 bits, the keccak-256 rate
	const s: bigint[] = new Array<bigint>(25).fill(0n);
	const rotl = (lane: bigint, n: number): bigint =>
		n === 0 ? lane : ((lane << BigInt(n)) | (lane >> BigInt(64 - n))) & MASK64;

	const padded = new Uint8Array(msg.length + (rate - (msg.length % rate)));
	padded.set(msg);
	// Keccak padding is 0x01 … 0x80. SHA3 would be 0x06 … 0x80.
	padded[msg.length] = 0x01;
	padded[padded.length - 1]! |= 0x80;

	for (let off = 0; off < padded.length; off += rate) {
		for (let i = 0; i < rate; i += 8) {
			let lane = 0n;
			for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i + b]!);
			s[i / 8] = s[i / 8]! ^ lane;
		}
		for (let round = 0; round < 24; round++) {
			const c: bigint[] = [];
			for (let x = 0; x < 5; x++) {
				c[x] = s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!;
			}
			const d: bigint[] = [];
			for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
			for (let x = 0; x < 5; x++) {
				for (let y = 0; y < 5; y++) s[x + 5 * y] = s[x + 5 * y]! ^ d[x]!;
			}
			const b: bigint[] = new Array<bigint>(25).fill(0n);
			for (let x = 0; x < 5; x++) {
				for (let y = 0; y < 5; y++) {
					b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, KECCAK_ROT[x + 5 * y]!);
				}
			}
			for (let x = 0; x < 5; x++) {
				for (let y = 0; y < 5; y++) {
					const i = x + 5 * y;
					s[i] = b[i]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]! & MASK64);
				}
			}
			s[0] = s[0]! ^ KECCAK_RC[round]!;
		}
	}

	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) {
		let lane = s[i]!;
		for (let b = 0; b < 8; b++) {
			out[i * 8 + b] = Number(lane & 0xffn);
			lane >>= 8n;
		}
	}
	return out;
}

/* -------------------------------------------------------------- base58check */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Uint8Array {
	const bytes: number[] = [0];
	for (const ch of str) {
		const val = B58.indexOf(ch);
		if (val < 0) {
			throw new XpubError(
				`not base58: ${JSON.stringify(ch)} is not in the alphabet. Base58 omits ` +
					"0, O, I and l precisely so a transcribed key cannot be ambiguous, " +
					"so this is a transcription error rather than a different encoding.",
			);
		}
		let carry = val;
		for (let j = 0; j < bytes.length; j++) {
			carry += bytes[j]! * 58;
			bytes[j] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	let zeros = 0;
	for (const ch of str) {
		if (ch === "1") zeros++;
		else break;
	}
	let n = bytes.length;
	if (n === 1 && bytes[0] === 0) n = 0;
	const out = new Uint8Array(zeros + n);
	for (let i = 0; i < n; i++) out[zeros + i] = bytes[n - 1 - i]!;
	return out;
}

function base58Encode(payload: Uint8Array): string {
	let zeros = 0;
	while (zeros < payload.length && payload[zeros] === 0) zeros++;
	const digits = [0];
	for (let i = zeros; i < payload.length; i++) {
		let carry = payload[i]!;
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j]! << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let str = "1".repeat(zeros);
	if (zeros < payload.length) {
		for (let i = digits.length - 1; i >= 0; i--) str += B58[digits[i]!];
	}
	return str;
}

function sha256(b: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(b).digest());
}

function hash160(b: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("ripemd160").update(sha256(b)).digest());
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
	return new Uint8Array(createHmac("sha512", key).update(data).digest());
}

/* ---------------------------------------------------------------- xpub node */

/**
 * A parsed extended PUBLIC key. There is no private field, by construction.
 *
 * `fingerprint` is the usual BIP32 one — the first four bytes of
 * hash160(publicKey), as hex. It is here because it is the one way to prove
 * WHICH xpub a process loaded without printing the xpub: the deposit screen can
 * publish it next to the derivation index so a customer can verify their own
 * address off our infrastructure, and an off-host monitor can confirm the live
 * service is still deriving from the xpub it was deployed with. A compromised
 * host that swaps in its own xpub to steal first deposits changes the
 * fingerprint, which is the only signal that attack leaves behind.
 */
export interface EvmXpub {
	readonly publicKey: Uint8Array;
	readonly chainCode: Uint8Array;
	readonly depth: number;
	readonly index: number;
	readonly parentFingerprint: Uint8Array;
	readonly fingerprint: string;
}

const VERSION_XPUB = 0x0488b21e;
const VERSION_XPRV = 0x0488ade4;
const HARDENED = 0x80000000;

/**
 * Parse an account-level xpub.
 *
 * WHY THIS FUNCTION IS THE SHARPEST CODE IN THE RAIL. hd.js can SERIALIZE an
 * xpub and has no deserializer at all (its export list ends at `serialize`), so
 * there was nothing to reuse. This is the only thing standing between an
 * operator's typo and a pool of correctly-checksummed deposit addresses that no
 * key can spend — and the money arrives before anyone finds out. Every rejection
 * below is therefore a hard refusal with a sentence an operator can act on, and
 * none of them degrade to a default.
 *
 * THE xprv CASE IS AN INCIDENT, NOT A TYPO. If the version bytes say 0488ade4
 * then a PRIVATE key was pasted into the exchange host's configuration. The
 * value is scrubbed from the error (the message names no bytes), the rail
 * refuses to start, and the correct response is to treat that seed as DISCLOSED
 * and rotate it — because by then it has been in a file, a shell history, and
 * possibly a terminal scrollback on a box that faces the internet. Starting
 * anyway "because derivation would still work" is how a seed ends up live.
 */
export function parseXpub(serialized: string): EvmXpub {
	const s = serialized.trim();
	if (s === "") throw new XpubError("no xpub is configured");

	let full: Uint8Array;
	try {
		full = base58Decode(s);
	} catch (e) {
		// Re-thrown without the input: an xpub is secret-grade and an error
		// string ends up in a log.
		throw new XpubError(
			`the configured xpub is not valid base58 (${
				e instanceof XpubError ? e.message : "decode failed"
			})`,
		);
	}
	if (full.length !== 82) {
		throw new XpubError(
			`a serialized extended key is 82 base58check bytes (78 + 4 checksum); ` +
				`this decoded to ${full.length}. Usually a truncated paste — check that ` +
				"the whole string was copied, including the last character.",
		);
	}
	const payload = full.subarray(0, 78);
	const checksum = full.subarray(78);
	const expect = sha256(sha256(payload)).subarray(0, 4);
	for (let i = 0; i < 4; i++) {
		if (checksum[i] !== expect[i]) {
			throw new XpubError(
				"the configured xpub fails its own base58check checksum. One character " +
					"is wrong or two are transposed. This is the check that exists so a " +
					"mistyped key cannot become a pool of unspendable deposit addresses — " +
					"do not work around it.",
			);
		}
	}

	const version = (payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
	if (version === VERSION_XPRV) {
		throw new XpubError(
			"REFUSING TO START: an xprv was configured where an xpub belongs. That is " +
				"a PRIVATE key, and it is now on the exchange host — in a file, and " +
				"probably in a shell history and a scrollback too. Treat that seed as " +
				"DISCLOSED: derive a new account, move any funds, and configure the new " +
				"account's xpub (the 'xpub…' form, from the signer host). The rail stays " +
				"shut until then. This host must never hold spending authority for a " +
				"customer deposit address.",
		);
	}
	if (version !== VERSION_XPUB) {
		throw new XpubError(
			`unexpected extended-key version 0x${version.toString(16).padStart(8, "0")}; ` +
				"expected 0x0488b21e (mainnet xpub). A tpub/ypub/zpub is a different " +
				"version byte for a different purpose, and this rail derives plain " +
				"BIP44 EVM addresses only.",
		);
	}

	const depth = payload[4]!;
	const parentFingerprint = payload.subarray(5, 9);
	const index = ((payload[9]! << 24) | (payload[10]! << 16) | (payload[11]! << 8) | payload[12]!) >>> 0;
	const chainCode = payload.subarray(13, 45);
	const publicKey = payload.subarray(45, 78);

	// Validates the prefix AND that the point is actually on the curve.
	decodePointChecked(publicKey, "the configured xpub");

	return {
		publicKey: new Uint8Array(publicKey),
		chainCode: new Uint8Array(chainCode),
		depth,
		index,
		parentFingerprint: new Uint8Array(parentFingerprint),
		fingerprint: hex(hash160(publicKey).subarray(0, 4)),
	};
}

/**
 * Serialize a node back to an xpub string.
 *
 * NOT DEAD CODE, AND NOT A CONVENIENCE. It is how the golden-vector test
 * compares against the PUBLISHED BIP32 test vectors: those vectors publish
 * xpub strings, so proving our derivation matches them means re-emitting the
 * derived child in the same encoding. A test that checked our derivation only
 * against our own derivation would pass just as happily with the maths wrong,
 * which is precisely the regression a lost deposit teaches you about.
 */
export function serializeXpub(node: EvmXpub): string {
	const payload = new Uint8Array(78);
	payload[0] = (VERSION_XPUB >>> 24) & 0xff;
	payload[1] = (VERSION_XPUB >>> 16) & 0xff;
	payload[2] = (VERSION_XPUB >>> 8) & 0xff;
	payload[3] = VERSION_XPUB & 0xff;
	payload[4] = node.depth & 0xff;
	payload.set(node.parentFingerprint, 5);
	payload[9] = (node.index >>> 24) & 0xff;
	payload[10] = (node.index >>> 16) & 0xff;
	payload[11] = (node.index >>> 8) & 0xff;
	payload[12] = node.index & 0xff;
	payload.set(node.chainCode, 13);
	payload.set(node.publicKey, 45);
	const checksum = sha256(sha256(payload)).subarray(0, 4);
	const out = new Uint8Array(82);
	out.set(payload);
	out.set(checksum, 78);
	return base58Encode(out);
}

/**
 * Derive one NON-HARDENED child from a public node: `parentPub + IL*G`.
 *
 * HARDENED IS REFUSED, AND THAT REFUSAL IS THE SAFETY PROPERTY, NOT A
 * LIMITATION. A hardened child's HMAC input is the parent's PRIVATE key, so
 * deriving one requires a secret this process does not have and must never
 * have. hd.js refuses it for the same reason at hd.js:90-92. If a future caller
 * ever needs a hardened path on this host, the answer is that the design is
 * wrong, not that this function needs an argument.
 *
 * The invalid-child case throws rather than silently shifting index — see the
 * file header for why a silently different index is worse than an error.
 */
export function deriveChildPublic(node: EvmXpub, index: number): EvmXpub {
	if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
		throw new XpubError(
			`not a non-hardened BIP32 index: ${index}. Valid range is 0 .. ${HARDENED - 1}; ` +
				"anything at or above 2^31 is hardened, which cannot be derived from a " +
				"public key by design.",
		);
	}
	const data = new Uint8Array(37);
	data.set(node.publicKey, 0);
	data[33] = (index >>> 24) & 0xff;
	data[34] = (index >>> 16) & 0xff;
	data[35] = (index >>> 8) & 0xff;
	data[36] = index & 0xff;

	const I = hmacSha512(node.chainCode, data);
	const IL = I.subarray(0, 32);
	const IR = I.subarray(32);
	const t = bytesToBig(IL);
	if (t >= N) {
		throw new XpubError(
			`index ${index} is not a valid BIP32 child (IL >= n). BIP32 says skip to ` +
				"the next index; this refuses instead so the caller advances on purpose " +
				"and records the index it actually used. A silently shifted index means " +
				"the offline signer re-derives a different key than the one holding the " +
				"customer's coins.",
		);
	}
	const parent = decodePointChecked(node.publicKey, "parent node");
	const child = pointAdd(parent, pointMul(t, G));
	if (child === null) {
		throw new XpubError(
			`index ${index} derives the point at infinity, which has no address. ` +
				"Advance to the next index deliberately rather than treating this as a " +
				"transient failure.",
		);
	}
	const childPub = encodePointCompressed(child);
	return {
		publicKey: childPub,
		chainCode: new Uint8Array(IR),
		depth: node.depth + 1,
		index,
		parentFingerprint: hash160(node.publicKey).subarray(0, 4),
		fingerprint: hex(hash160(childPub).subarray(0, 4)),
	};
}

/* ------------------------------------------------------------- EVM addresses */

/**
 * EIP-55 mixed-case checksum.
 *
 * Applied rather than returning lowercase because the checksum is free
 * protection against exactly the failure this rail cannot absorb: a customer or
 * an operator transcribing a deposit address by hand. Every modern wallet
 * verifies it, and a lowercase address silently skips that verification.
 */
export function toChecksumAddress(address: string): string {
	const a = address.toLowerCase().replace(/^0x/, "");
	if (!/^[0-9a-f]{40}$/.test(a)) {
		throw new XpubError(`not a 20-byte hex address: ${JSON.stringify(address)}`);
	}
	const h = hex(keccak256(Buffer.from(a, "utf8")));
	let out = "0x";
	for (let i = 0; i < a.length; i++) {
		out += parseInt(h[i]!, 16) >= 8 ? a[i]!.toUpperCase() : a[i]!;
	}
	return out;
}

/**
 * The address of a public key: the last 20 bytes of keccak256 of the
 * UNCOMPRESSED key with its 0x04 prefix dropped.
 *
 * The two easy ways to get this wrong both produce a valid-looking address:
 * hashing the compressed key, or hashing the uncompressed key WITH its prefix.
 * Both yield 20 bytes that check out as an address and that nobody can spend.
 * That is why the golden vectors assert against externally published addresses
 * rather than against anything this file computes.
 */
export function evmAddressFromPublicKey(publicKey: Uint8Array): string {
	const point = decodePointChecked(publicKey, "public key");
	const body = encodePointUncompressed(point).subarray(1);
	return toChecksumAddress(hex(keccak256(body)).slice(-40));
}

/** One customer's deposit address: `${EVM_ACCOUNT_PATH}/${index}`. */
export function deriveEvmAddress(account: EvmXpub, index: number): string {
	return evmAddressFromPublicKey(deriveChildPublic(account, index).publicKey);
}

/**
 * What operator output and logs are allowed to say about the loaded xpub.
 *
 * Exists because the obvious debugging line — print the xpub so the operator
 * can see which one is loaded — publishes a permanent map of every customer's
 * deposit addresses to anyone who later reads the journal. The fingerprint
 * answers the same question ("is this the key I deployed?") and discloses
 * nothing: it is four bytes of a hash of a public key.
 */
export function safeDescribe(account: EvmXpub): string {
	return `xpub fingerprint ${account.fingerprint} at depth ${account.depth}`;
}
