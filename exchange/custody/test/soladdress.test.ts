// -----------------------------------------------------------------------------
// SOLANA ADDRESS VALIDATION TESTS.
//
// WHAT THESE DEFEND, AND WHY A REGEX WOULD HAVE PASSED EVERY ONE OF THEM.
//
// A base58 string with no checksum carries no evidence about itself. The
// failures that matter are all strings that look exactly like addresses:
//
//   * a 31-byte value, which encodes to the same 43 characters a 32-byte value
//     with a leading zero byte does;
//   * a 32-byte value that is not a point on the ed25519 curve — which is
//     precisely what a Solana PDA is, found by searching for off-curve values
//     so that no private key can exist;
//   * a small-order point, on the curve and still unsignable;
//   * a non-canonical y >= 2^255-19.
//
// Any of them in the address pool is a deposit address handed to a customer
// out of which no sweep can ever be signed: the coins arrive, the deposit is
// real, and the venue has credited a liability it cannot ever return.
//
// THE ORACLE IS NOT OUR OWN CODE. Two independent sources are used:
//
//   1. node's crypto, which generates genuine ed25519 keypairs. Every public
//      key it produces is a real curve point by construction, so accepting
//      100% of them is a true positive rate measured against something that
//      does not share a line of code with the implementation.
//   2. real Solana mainnet addresses, typed from outside this repo. They are
//      asserted to decode to exactly 32 bytes and to round-trip, which is a
//      check of the base58 implementation against the world rather than
//      against itself — and `ComputeBudget111111111111111111111111111111`, a
//      real program id, is the external off-curve case.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";

import {
	base58Decode,
	base58Encode,
	checkSolAddress,
	isEd25519PublicKey,
	isSolAddress,
} from "../src/soladdress";

/** A genuine ed25519 public key, base58-encoded. The oracle for "valid". */
function freshAddress(): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" });
	// SPKI for ed25519 is a 12-byte prefix plus the 32-byte key; taking the
	// tail avoids depending on the exact prefix bytes.
	return base58Encode(new Uint8Array(der.subarray(der.length - 32)));
}

/*
 * REAL MAINNET ADDRESSES, from outside this repository.
 *
 * `curve` records what the implementation must conclude, and the interesting
 * rows are the FALSE ones: the System Program's all-zero address is an
 * order-4 point and ComputeBudget's is off-curve. Both are real, both are 32
 * bytes, and neither has a private key — exactly the shape that must never
 * reach the pool.
 */
const KNOWN: readonly { address: string; curve: boolean; note: string }[] = [
	{
		address: "11111111111111111111111111111111",
		curve: false,
		note: "the System Program: 32 zero bytes, an order-4 point, no signer",
	},
	{
		address: "ComputeBudget111111111111111111111111111111",
		curve: false,
		note: "a real program id that is off the curve — the PDA shape",
	},
	{
		address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		curve: true,
		note: "the SPL Token program, a real curve point",
	},
	{
		address: "So11111111111111111111111111111111111111112",
		curve: true,
		note: "the wrapped-SOL mint, 43 characters",
	},
	{
		address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
		curve: true,
		note: "the associated-token program, 44 characters",
	},
];

// ------------------------------------------------------------------- base58

test("base58 round-trips real mainnet addresses to exactly 32 bytes", () => {
	// The external check on the codec. Character count is NOT the test: these
	// are 32, 43 and 44 characters long and all decode to the same 32 bytes,
	// which is the whole reason a length regex cannot validate an address.
	for (const k of KNOWN) {
		const bytes = base58Decode(k.address);
		assert.ok(bytes !== undefined, `${k.address} must decode`);
		assert.equal(bytes.length, 32, `${k.address} (${k.note})`);
		assert.equal(base58Encode(bytes), k.address, `${k.address} must round-trip`);
	}
});

test("LEADING ONES ARE LEADING ZERO BYTES, not decoration", () => {
	/*
	 * The bug this guards: dropping the leading `1` turns a 32-byte key into a
	 * 31-byte value that still encodes to 43 characters, so nothing downstream
	 * notices. The System Program's address is 32 ones and must decode to 32
	 * zero bytes, not to nothing.
	 */
	const zeros = base58Decode("11111111111111111111111111111111");
	assert.ok(zeros !== undefined);
	assert.equal(zeros.length, 32);
	assert.ok(
		zeros.every((b) => b === 0),
		"32 ones is 32 zero bytes",
	);
	assert.equal(base58Decode("1")?.length, 1);
	assert.equal(base58Encode(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("characters outside the alphabet are refused rather than coerced", () => {
	// 0, O, I and l are absent from base58 precisely because they are the
	// characters humans and fonts substitute. A decoder that skipped them would
	// turn a typo into a different valid-looking address.
	for (const bad of ["0", "O", "I", "l", "Token keg", "Tokenkeg!", ""]) {
		assert.equal(base58Decode(bad), undefined, JSON.stringify(bad));
	}
});

// -------------------------------------------------------------- the curve

test("EVERY GENUINE ed25519 PUBLIC KEY IS ACCEPTED (node crypto is the oracle)", () => {
	// 100% true-positive rate against keys this code did not generate. If the
	// curve check were subtly wrong — wrong endianness, wrong d, a missing
	// inverse — roughly half of these would be rejected.
	for (let i = 0; i < 32; i += 1) {
		const address = freshAddress();
		assert.ok(isSolAddress(address), `rejected a real ed25519 public key: ${address}`);
	}
});

test("A PDA-SHAPED VALUE IS REJECTED, which is the whole point", () => {
	// ComputeBudget's program id is a real, published, 32-byte Solana address
	// that is off the curve. Coins sent there can never be moved by anyone.
	const v = checkSolAddress("ComputeBudget111111111111111111111111111111");
	assert.equal(v.ok, false);
	assert.equal(v.fault, "not-on-curve");
	assert.match(v.why ?? "", /program-derived/);
});

test("known mainnet addresses are classified exactly as expected", () => {
	for (const k of KNOWN) {
		assert.equal(isSolAddress(k.address), k.curve, `${k.address}: ${k.note}`);
	}
});

test("THE CHECK ACTUALLY DISCRIMINATES — about half of random 32-byte strings fail", () => {
	/*
	 * The test that catches the degenerate implementation.
	 *
	 * A checker that returned true for everything would pass every assertion
	 * above about valid keys, and would quietly admit PDAs forever. Roughly
	 * half of all 32-byte values are on the curve, so the acceptance rate over
	 * random input is the signal. The 25-75% band is loose enough that it
	 * cannot flake (p < 10^-20 at n=240) and tight enough that "always true"
	 * and "always false" both fail it.
	 */
	let accepted = 0;
	const n = 240;
	for (let i = 0; i < n; i += 1) {
		if (isEd25519PublicKey(new Uint8Array(randomBytes(32)))) accepted += 1;
	}
	assert.ok(
		accepted > n * 0.25 && accepted < n * 0.75,
		`accepted ${accepted} of ${n} random strings — a rate this far from 50% ` +
			"means the curve test is not testing the curve",
	);
});

test("31 and 33 bytes are refused, and the reason names the character-count trap", () => {
	const short = base58Encode(new Uint8Array(31).fill(7));
	const long = base58Encode(new Uint8Array(33).fill(7));
	for (const a of [short, long]) {
		const v = checkSolAddress(a);
		assert.equal(v.ok, false, a);
		assert.equal(v.fault, "wrong-length");
		assert.match(v.why ?? "", /Length in characters proves nothing/);
	}
});

test("a non-canonical y (>= 2^255-19) is refused", () => {
	// Some decoders wrap this around and disagree with each other about which
	// address the string names. An address two implementations spell
	// differently is not an address.
	const p = (1n << 255n) - 19n;
	const bytes = new Uint8Array(32);
	let t = p;
	for (let i = 0; i < 32; i += 1) {
		bytes[i] = Number(t & 0xffn);
		t >>= 8n;
	}
	assert.equal(isEd25519PublicKey(bytes), false);
	// And p+1 .. p+18 are the other non-canonical encodings in that window.
	const plus = new Uint8Array(bytes);
	plus[0] = (plus[0] as number) + 5;
	assert.equal(isEd25519PublicKey(plus), false);
});

test("a blank address is its own fault, not a decode failure", () => {
	// The deposit route can reach this with an empty query parameter, and
	// "not base58" would send an operator looking at the wrong thing.
	const v = checkSolAddress("   ");
	assert.equal(v.ok, false);
	assert.equal(v.fault, "blank");
});
