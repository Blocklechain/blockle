// -----------------------------------------------------------------------------
// EVM XPUB DERIVATION — GOLDEN VECTORS.
//
// WHY THIS FILE IS THE MOST IMPORTANT TEST IN THE EVM RAIL.
//
// Every customer deposit address on Ethereum, BSC and Polygon is produced by
// the code this file exercises. A derivation bug does not throw, does not log,
// and does not fail a health check: it produces a real, correctly-checksummed,
// completely valid Ethereum address that NO KEY ON EARTH CAN SPEND. The money
// arrives, the customer is credited, the books balance, and the first symptom
// is a sweep failing weeks later with the deposits already stranded.
//
// So a derivation regression has to be caught by a test rather than by a lost
// deposit, and the only test that can do that compares against values this
// codebase did not compute.
//
// WHAT "GOLDEN" MEANS HERE, PRECISELY, BECAUSE IT IS EASY TO FAKE.
//
// A test that derived an address and compared it against an address derived by
// the same code would pass just as happily with the point arithmetic wrong.
// Every expected value below is therefore EXTERNALLY PUBLISHED and was copied
// from its source, not generated:
//
//   * BIP-0032's own "Test Vectors" section, fetched from
//     github.com/bitcoin/bips/blob/master/bip-0032.mediawiki. Vectors 1 and 2
//     pin non-hardened public derivation; vector 5 is a published list of
//     extended keys that MUST be rejected, and it includes the off-curve public
//     key that `decodePointChecked`'s on-curve test exists for.
//   * EIP-55's own four worked examples, for the mixed-case checksum.
//   * The Keccak team's published digests for "" and "abc", which pin
//     keccak256 against NIST SHA3 — a confusion that differs by one padding
//     byte and yields plausible addresses nobody agrees with.
//   * The Hardhat/Anvil/Foundry development mnemonic's published accounts
//     0 through 4. These prove the WHOLE pipeline end to end — xpub string in,
//     EIP-55 address out — against addresses printed by third-party tooling
//     millions of times a day.
//
// NO REAL KEY APPEARS IN THIS FILE AND NONE EVER SHOULD. The Anvil mnemonic is
// the single most published private key material in Ethereum; it holds nothing
// on mainnet and is used here precisely because it is worthless. The BIP-32
// vectors are likewise spec fixtures. What is NOT here is a seed, a mnemonic or
// an xprv for anything the venue controls — see evmrailguards.test.ts, which
// asserts structurally that no such value is reachable from custody code.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	deriveChildPublic,
	deriveEvmAddress,
	evmAddressFromPublicKey,
	EVM_ACCOUNT_PATH,
	keccak256,
	parseXpub,
	safeDescribe,
	serializeXpub,
	toChecksumAddress,
	XpubError,
} from "../src/evmxpub";

function hex(b: Uint8Array): string {
	return Buffer.from(b).toString("hex");
}

/* --------------------------------------------------------------- BIP-32 vectors */

/*
 * Published in BIP-0032, "Test vector 1", seed 000102030405060708090a0b0c0d0e0f.
 * Only the extended PUBLIC keys are reproduced: this rail has no code that
 * could consume the private halves, which is the entire point of it.
 */
const V1_M =
	"xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const V1_0H =
	"xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw";
const V1_0H_1 =
	"xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ";
const V1_0H_1_2H =
	"xpub6D4BDPcP2GT577Vvch3R8wDkScZWzQzMMUm3PWbmWvVJrZwQY4VUNgqFJPMM3No2dFDFGTsxxpG5uJh7n7epu4trkrX7x7DogT5Uv6fcLW5";
const V1_0H_1_2H_2 =
	"xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV";
const V1_0H_1_2H_2_1G =
	"xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy";

/** Published in BIP-0032, "Test vector 2". */
const V2_M =
	"xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB";
const V2_0 =
	"xpub69H7F5d8KSRgmmdJg2KhpAK8SR3DjMwAdkxj3ZuxV27CprR9LgpeyGmXUbC6wb7ERfvrnKZjXoUmmDznezpbZb7ap6r1D3tgFxHmwMkQTPH";
const V2_0_2147483647H =
	"xpub6ASAVgeehLbnwdqV6UKMHVzgqAG8Gr6riv3Fxxpj8ksbH9ebxaEyBLZ85ySDhKiLDBrQSARLq1uNRts8RuJiHjaDMBU4Zn9h8LZNnBC5y4a";

/** Published in BIP-0032, "Test vector 3" (retention of leading zeros). */
const V3_M =
	"xpub661MyMwAqRbcEZVB4dScxMAdx6d4nFc9nvyvH3v4gJL378CSRZiYmhRoP7mBy6gSPSCYk6SzXPTf3ND1cZAceL7SfJ1Z3GC8vBgp2epUt13";
/** Published in BIP-0032, "Test vector 4" (retention of leading zeros). */
const V4_M =
	"xpub661MyMwAqRbcGczjuMoRm6dXaLDEhW1u34gKenbeYqAix21mdUKJyuyu5F1rzYGVxyL6tmgBUAEPrEz92mBXjByMRiJdba9wpnN37RLLAXa";

test("GOLDEN: BIP-32 vector 1, m/0'/1 derived from the m/0' PUBLIC key alone", () => {
	/*
	 * THE CRUX OF THE ENTIRE EVM RAIL, IN ONE ASSERTION.
	 *
	 * The node is parsed from a published xpub STRING — there is no seed, no
	 * private scalar and no code path here that could produce one. If a
	 * non-hardened child can be derived from that alone and matches the
	 * published expectation, then this host can issue every customer's deposit
	 * address while being mathematically incapable of signing for any of them.
	 *
	 * That is the property BLOCK cannot have (ML-DSA has no watch-only
	 * derivation, which is why blockaddresspool.ts ships addresses in from an
	 * offline machine) and it is why this rail is built differently.
	 */
	const account = parseXpub(V1_0H);
	const child = deriveChildPublic(account, 1);
	assert.equal(serializeXpub(child), V1_0H_1, "m/0'/1 must match BIP-32 test vector 1");
});

test("GOLDEN: BIP-32 vector 1, a two-deep non-hardened chain m/0'/1/2'/2/1000000000", () => {
	/*
	 * Derivation applied to its own output, which is what the deposit rail
	 * actually does to reach an index. A single-step test would not catch a
	 * child chain code being derived correctly but propagated wrongly — the
	 * first address would be right and every subsequent one wrong, which is the
	 * worst possible shape for this bug because the smoke test passes.
	 *
	 * The large index is deliberate: 1000000000 exercises the full four-byte
	 * big-endian index serialisation. A little-endian slip would still produce
	 * valid addresses for index 0 and 1, and garbage from index 256 onward.
	 */
	const account = parseXpub(V1_0H_1_2H);
	const child = deriveChildPublic(account, 2);
	assert.equal(serializeXpub(child), V1_0H_1_2H_2);

	const grandchild = deriveChildPublic(child, 1_000_000_000);
	assert.equal(serializeXpub(grandchild), V1_0H_1_2H_2_1G);
});

test("GOLDEN: BIP-32 vector 2, m/0 derived from the master PUBLIC key", () => {
	// A second independent seed, because one vector passing can be a
	// coincidence of a single chain code.
	const child = deriveChildPublic(parseXpub(V2_M), 0);
	assert.equal(serializeXpub(child), V2_0);
});

test("GOLDEN: every published vector xpub survives a parse/serialize round trip", () => {
	/*
	 * This pins the PARSER and SERIALISER against the published encodings, which
	 * the derivation tests above cannot do on their own: a parser that dropped
	 * the depth, mangled the parent fingerprint or mis-sliced the chain code
	 * could still derive a correct child and only corrupt the re-encoding.
	 *
	 * Vectors 3 and 4 exist in the specification specifically to catch
	 * implementations that strip LEADING ZEROS from a key or chain code — a
	 * documented historical bug in more than one library (bitcore-lib#47,
	 * btcutil#172). They are included for exactly that reason.
	 */
	for (const serialized of [
		V1_M,
		V1_0H,
		V1_0H_1,
		V1_0H_1_2H,
		V1_0H_1_2H_2,
		V1_0H_1_2H_2_1G,
		V2_M,
		V2_0,
		V2_0_2147483647H,
		V3_M,
		V4_M,
	]) {
		assert.equal(serializeXpub(parseXpub(serialized)), serialized);
	}
});

test("GOLDEN: the parsed node's depth and index match the published path", () => {
	// Depth and index are not cosmetic: the depth is how an operator confirms
	// they exported an ACCOUNT-level key rather than a master key, and shipping
	// a master xpub would derive m/0 instead of m/44'/60'/0'/0/0 — a complete,
	// valid, entirely wrong set of addresses.
	assert.equal(parseXpub(V1_M).depth, 0);
	assert.equal(parseXpub(V1_0H).depth, 1);
	assert.equal(parseXpub(V1_0H).index, 0x80000000, "m/0' is a hardened index");
	assert.equal(parseXpub(V1_0H_1).depth, 2);
	assert.equal(parseXpub(V1_0H_1).index, 1);
});

/* ------------------------------------------------- what MUST NOT parse */

test("AN xprv IS AN INCIDENT, NOT A TYPO: refused, and the value is not echoed", () => {
	/*
	 * BIP-32 vector 5's "prvkey version / pubkey mismatch" entry is a real
	 * serialized xprv. If one of these is ever configured on the exchange host,
	 * a PRIVATE key has reached a machine that faces the internet — it is now in
	 * a file, and probably in a shell history and a terminal scrollback too. The
	 * right response is to treat that seed as disclosed and rotate it, which is
	 * why the message says so rather than merely reporting a bad version byte.
	 *
	 * The second assertion is the one that would rot quietly: the error must not
	 * contain the key. An error string ends up in a journal, and a journal on
	 * this box is readable by any local user — the standing security audit
	 * already found secrets leaking that way through systemd `Environment=`.
	 */
	const xprv =
		"xprv9s21ZrQH143K24Mfq5zL5MhWK9hUhhGbd45hLXo2Pq2oqzMMo63oStZzFGTQQD3dC4H2D5GBj7vWvSQaaBv5cxi9gafk7NF3pnBju6dwKvH";
	assert.throws(
		() => parseXpub(xprv),
		(e: unknown) => {
			assert.ok(e instanceof XpubError);
			assert.match(e.message, /REFUSING TO START/);
			assert.match(e.message, /DISCLOSED/);
			assert.ok(
				!e.message.includes(xprv) && !e.message.includes(xprv.slice(4, 40)),
				"the refusal must not echo the private key it was handed",
			);
			return true;
		},
	);
});

test("GOLDEN: BIP-32 vector 5's OFF-CURVE public key is refused", () => {
	/*
	 * THIS IS THE TEST THAT JUSTIFIES HAND-WRITING A POINT DECODER.
	 *
	 * The published key below carries x = 7, which is not on secp256k1. The
	 * house's own vendor decoder (services/accounts/src/vendor/secp256k1.js
	 * `decodePoint`) computes y = (x^3+7)^((P+1)/4) unconditionally and never
	 * checks y^2 == x^3+7, so it would return a silent junk point. That is
	 * harmless there, where every input came from its own encoder. Here the
	 * input is an xpub typed by an operator, and a junk point derives a whole
	 * pool of real-looking, correctly-checksummed, permanently unspendable
	 * deposit addresses.
	 *
	 * BIP-32 publishes this key as one that implementations must reject, so the
	 * check is pinned against the specification rather than against our opinion.
	 */
	const offCurve =
		"xpub661MyMwAqRbcEYS8w7XLSVeEsBXy79zSzH1J8vCdxAZningWLdN3zgtU6Q5JXayek4PRsn35jii4veMimro1xefsM58PgBMrvdYre8QyULY";
	assert.throws(() => parseXpub(offCurve), /not a point on secp256k1/);
});

test("GOLDEN: BIP-32 vector 5's remaining invalid extended keys are all refused", () => {
	/*
	 * The published invalid-key list, each entry labelled with the defect the
	 * specification says it carries. Driven as a table because the failure that
	 * matters is ANY of them parsing, and a table makes adding the next
	 * published case a one-line change.
	 *
	 * Note what is NOT asserted: the exact message per case. The parser's job
	 * here is to refuse; pinning each sentence would make a reworded error a
	 * test failure and teach the next person to loosen the assertion.
	 */
	const invalid: ReadonlyArray<readonly [string, string]> = [
		[
			"pubkey version / prvkey mismatch",
			"xpub661MyMwAqRbcEYS8w7XLSVeEsBXy79zSzH1J8vCdxAZningWLdN3zgtU6LBpB85b3D2yc8sfvZU521AAwdZafEz7mnzBBsz4wKY5fTtTQBm",
		],
		[
			"invalid pubkey prefix 04 (the uncompressed form BIP-32 does not use)",
			"xpub661MyMwAqRbcEYS8w7XLSVeEsBXy79zSzH1J8vCdxAZningWLdN3zgtU6Txnt3siSujt9RCVYsx4qHZGc62TG4McvMGcAUjeuwZdduYEvFn",
		],
		[
			"invalid pubkey prefix 01",
			"xpub661MyMwAqRbcEYS8w7XLSVeEsBXy79zSzH1J8vCdxAZningWLdN3zgtU6N8ZMMXctdiCjxTNq964yKkwrkBJJwpzZS4HS2fxvyYUA4q2Xe4",
		],
		[
			"unknown extended key version",
			"DMwo58pR1QLEFihHiXPVykYB6fJmsTeHvyTp7hRThAtCX8CvYzgPcn8XnmdfHGMQzT7ayAmfo4z3gY5KfbrZWZ6St24UVf2Qgo6oujFktLHdHY4",
		],
		[
			"invalid checksum",
			"xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHL",
		],
	];
	for (const [defect, serialized] of invalid) {
		assert.throws(
			() => parseXpub(serialized),
			XpubError,
			`BIP-32 publishes this as invalid (${defect}) and it must not parse`,
		);
	}
});

test("a mistyped xpub is refused by its own checksum, not silently accepted", () => {
	// The realistic operator error: one transposed character in a 111-character
	// string. base58check exists precisely so this cannot become a pool of
	// unspendable addresses, so the refusal must be hard and must say not to
	// work around it.
	const typo = V1_M.slice(0, 60) + (V1_M[60] === "a" ? "b" : "a") + V1_M.slice(61);
	assert.throws(() => parseXpub(typo), /checksum|base58/);
});

test("a truncated paste names the actual failure", () => {
	// Copying from a terminal that soft-wrapped is how this happens, and the
	// length check gives the operator the one sentence that resolves it.
	assert.throws(() => parseXpub(V1_M.slice(0, 80)), /truncated paste|82/);
});

test("an empty or whitespace-only xpub is 'nothing is configured'", () => {
	// Distinct from a malformed one: the rail being unconfigured is a normal
	// state that must not be reported as a corrupt key.
	assert.throws(() => parseXpub(""), /no xpub is configured/);
	assert.throws(() => parseXpub("   \n"), /no xpub is configured/);
});

test("HARDENED DERIVATION IS REFUSED, and that refusal is the safety property", () => {
	/*
	 * A hardened child's HMAC input is the parent's PRIVATE key. Deriving one
	 * requires a secret this process does not have and must never have, so the
	 * refusal is not a missing feature — it is the boundary itself. If a future
	 * caller "needs" a hardened path here, the design is wrong rather than this
	 * function being short of an argument.
	 */
	const account = parseXpub(V1_M);
	assert.throws(() => deriveChildPublic(account, 0x80000000), /hardened/);
	assert.throws(() => deriveChildPublic(account, 0xffffffff), /hardened/);
});

test("a non-integer or negative index is refused rather than coerced", () => {
	// Coercion here would be a silent index shift, and the recorded index IS the
	// recoverability contract: the signer re-derives from that integer.
	const account = parseXpub(V1_M);
	assert.throws(() => deriveChildPublic(account, 1.5), /not a non-hardened BIP32 index/);
	assert.throws(() => deriveChildPublic(account, -1), /not a non-hardened BIP32 index/);
	assert.throws(() => deriveChildPublic(account, NaN), /not a non-hardened BIP32 index/);
});

test("a derived child carries no private key, because there is no field for one", () => {
	// Structural rather than behavioural: the absence of spending authority is
	// the design, and an absence is exactly the kind of property that rots when
	// someone later adds a convenience field.
	const child = deriveChildPublic(parseXpub(V1_0H), 1);
	assert.ok(!("privateKey" in child), "an EvmXpub must have no privateKey field");
	assert.equal(child.publicKey.length, 33, "a compressed public key is 33 bytes");
	assert.equal(child.chainCode.length, 32);
});

/* ------------------------------------------------------------- keccak + EIP-55 */

test("GOLDEN: keccak256 matches the published digests, and is NOT SHA3", () => {
	/*
	 * Node ships `createHash('sha3-256')`, which is NIST SHA3 and differs from
	 * Keccak only in the padding byte (0x06 against 0x01). The digests are
	 * COMPLETELY different, so using it would yield plausible 20-byte addresses
	 * that no Ethereum client agrees with — and nothing would error.
	 *
	 * These two digests are the Keccak team's published values. The third
	 * assertion is the one that catches the confusion directly.
	 */
	assert.equal(
		hex(keccak256(new Uint8Array(0))),
		"c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
	);
	assert.equal(
		hex(keccak256(Buffer.from("abc", "utf8"))),
		"4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
	);
	// NIST SHA3-256 of "" — the value we must NOT be producing.
	assert.notEqual(
		hex(keccak256(new Uint8Array(0))),
		"a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
	);
});

test("GOLDEN: keccak256 is correct across the 136-byte rate boundary", () => {
	/*
	 * The sponge absorbs 136 bytes (1088 bits) at a time, so a padding or
	 * multi-block absorb bug hides ENTIRELY behind short inputs — and every
	 * address hash is a short input. This file's own address vectors would
	 * therefore pass with the absorb loop broken, which is why the boundary is
	 * pinned separately.
	 *
	 * WHERE THESE EXPECTED VALUES CAME FROM, since BIP-32 and EIP-55 do not
	 * publish them: they were cross-checked, out of band, against the INDEPENDENT
	 * keccak256 implementation the house already ships at
	 * services/accounts/src/vendor/crypto-core.js:307. That one is a different
	 * implementation by a different route — it carries state as hi/lo 32-bit
	 * pairs where this file uses 64-bit BigInt lanes — so agreement between them
	 * is meaningful rather than circular. Both also reproduce the Keccak team's
	 * published empty-string digest asserted above, which anchors the pair to
	 * the specification.
	 *
	 * The vendor file is deliberately NOT imported here. Doing so would make the
	 * custody build depend on a sibling service's untyped JavaScript, and
	 * evmrailguards.test.ts asserts structurally that custody reaches no such
	 * code. The constants are the result of that comparison, not a live call.
	 *
	 * Input is the repeated byte 0x61 ('a') at each length.
	 */
	const crossChecked: ReadonlyArray<readonly [number, string]> = [
		[32, "47a01324181e85459310f8fb9b24dc09744323ebdcef26cbf98959effdc76e02"],
		// 135: one byte short of the rate — the padding fills a single block.
		[135, "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446"],
		// 136: exactly the rate, so padding must spill into a SECOND block. An
		// implementation that writes the pad byte in-place without adding that
		// block gets this one wrong and everything shorter right.
		[136, "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e"],
		[137, "d869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39"],
		// Multi-block absorb, well past the boundary.
		[200, "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"],
		[272, "cf7fcd4f705ee749930d19ca84561a9bf62516bd90a471545fa2f49fdc7e63c8"],
	];
	for (const [len, expected] of crossChecked) {
		assert.equal(
			hex(keccak256(new Uint8Array(len).fill(0x61))),
			expected,
			`keccak256 of ${len} bytes of 0x61`,
		);
	}
});

test("GOLDEN: EIP-55 checksums match the specification's own four examples", () => {
	// Published in EIP-55 itself. The checksum is free protection against the
	// one failure this rail cannot absorb — a deposit address transcribed by
	// hand — and a lowercase address silently skips that verification in every
	// wallet that would otherwise catch it.
	for (const published of [
		"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
		"0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
		"0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
		"0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
	]) {
		assert.equal(toChecksumAddress(published.toLowerCase()), published);
		// Idempotent: re-checksumming an already-checksummed address is a
		// no-op, which matters because addresses pass through this function on
		// the way out of the database as well as on the way in.
		assert.equal(toChecksumAddress(published), published);
	}
});

test("a non-address is refused by the checksummer rather than padded into one", () => {
	assert.throws(() => toChecksumAddress("0x1234"), /not a 20-byte hex address/);
	assert.throws(() => toChecksumAddress("not an address"), /not a 20-byte hex address/);
});

/* ------------------------------------- the whole pipeline, against third parties */

/**
 * The account-level xpub for m/44'/60'/0'/0 of the Hardhat/Anvil/Foundry
 * development mnemonic, "test test test test test test test test test test test
 * junk".
 *
 * THIS VALUE'S PROVENANCE DOES NOT HAVE TO BE TRUSTED, and that is the point of
 * the test below. It is an INPUT. The expected values are the addresses Anvil
 * itself prints, published in its own documentation and in every Hardhat
 * tutorial. If this xpub were wrong, or if any step of our parse → derive →
 * keccak → EIP-55 pipeline were wrong, the derived addresses could not possibly
 * match all five published ones. The chain of custody runs from third-party
 * published addresses backwards into our code, not from our code outwards.
 */
const ANVIL_ACCOUNT_XPUB =
	"xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4";

/** Anvil's published accounts 0..4 for that mnemonic, EIP-55 checksummed. */
const ANVIL_ADDRESSES: readonly string[] = [
	"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
	"0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
	"0x90F79bf6EB2c4f870365E785982E1f101E93b906",
	"0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];

test("GOLDEN: an xpub alone reproduces Anvil's published addresses 0..4", () => {
	/*
	 * THE END-TO-END TEST, AND THE ONE THAT WOULD HAVE CAUGHT A LOST DEPOSIT.
	 *
	 * Every stage is exercised in the order the live rail uses them: parse a
	 * serialized xpub, derive a non-hardened child, take the uncompressed point,
	 * keccak it, drop the 0x04 prefix, take the last twenty bytes, apply EIP-55.
	 * The two classic ways to get the last part wrong — hashing the COMPRESSED
	 * key, or hashing the uncompressed key WITH its prefix — both produce twenty
	 * perfectly valid-looking bytes, and neither would be caught by anything
	 * except a comparison against externally published addresses.
	 *
	 * Five indices rather than one, because an off-by-one in index
	 * serialisation produces a correct-looking address at every index except
	 * the one asked for.
	 */
	const account = parseXpub(ANVIL_ACCOUNT_XPUB);
	ANVIL_ADDRESSES.forEach((expected, index) => {
		assert.equal(
			deriveEvmAddress(account, index),
			expected,
			`${EVM_ACCOUNT_PATH}/${index} must be Anvil's published account ${index}`,
		);
	});
});

test("GOLDEN: derivation is deterministic and index-specific", () => {
	// Same index twice is the same address — a customer returning to the deposit
	// screen must not be shown something new. And two indices must differ, which
	// is what would break if the index were dropped from the HMAC input: every
	// customer would share one address, on chains with no memo field, and the
	// deposits would be permanently unattributable.
	const account = parseXpub(ANVIL_ACCOUNT_XPUB);
	assert.equal(deriveEvmAddress(account, 7), deriveEvmAddress(account, 7));
	const seen = new Set<string>();
	for (let i = 0; i < 24; i++) seen.add(deriveEvmAddress(account, i));
	assert.equal(seen.size, 24, "24 indices must yield 24 distinct addresses");
});

test("an address derived from a public key is EIP-55 checksummed, not lowercase", () => {
	const account = parseXpub(ANVIL_ACCOUNT_XPUB);
	const addr = evmAddressFromPublicKey(deriveChildPublic(account, 0).publicKey);
	assert.equal(addr, ANVIL_ADDRESSES[0]);
	assert.notEqual(addr, addr.toLowerCase(), "the checksum casing must be applied");
	assert.match(addr, /^0x[0-9a-fA-F]{40}$/);
});

test("evmAddressFromPublicKey refuses a key that is not a point", () => {
	// An operator-supplied or corrupted key must not become an address. x = 7 is
	// BIP-32's own published off-curve example, reused here at the key level.
	const offCurve = new Uint8Array(33);
	offCurve[0] = 0x02;
	offCurve[32] = 0x07;
	assert.throws(() => evmAddressFromPublicKey(offCurve), /not a point on secp256k1/);
	assert.throws(() => evmAddressFromPublicKey(new Uint8Array(32)), /33 bytes/);
});

/* --------------------------------------------------------------- disclosure */

test("THE XPUB IS NEVER PRINTABLE: safeDescribe discloses only a fingerprint", () => {
	/*
	 * The xpub cannot steal anything — it is mathematically incapable of
	 * signing. What it CAN do is enumerate every customer deposit address on
	 * every EVM chain, retroactively and forever, and link them to each other.
	 * It is a permanent deanonymisation and targeting list, so it is handled as
	 * secret-grade config and the obvious debugging line ("print the xpub so the
	 * operator can see which one is loaded") is exactly the one that must not
	 * exist.
	 *
	 * The fingerprint answers the same operational question — "is this the key I
	 * deployed?" — and discloses nothing: it is four bytes of a hash of a public
	 * key. It is also what makes the off-host address monitor possible, since
	 * the only trace left by a compromised host swapping in its own xpub to
	 * steal first deposits is a changed fingerprint.
	 */
	const account = parseXpub(ANVIL_ACCOUNT_XPUB);
	const described = safeDescribe(account);
	assert.ok(
		!described.includes(ANVIL_ACCOUNT_XPUB),
		"safeDescribe must never contain the xpub itself",
	);
	assert.ok(!described.includes("xpub6"), "not even a prefix of the key material");
	assert.match(described, /fingerprint [0-9a-f]{8}/);
	// Stable across parses, so an operator comparing two deployments sees the
	// same string for the same key.
	assert.equal(safeDescribe(parseXpub(ANVIL_ACCOUNT_XPUB)), described);
	// And distinct keys are distinguishable, or the check proves nothing.
	assert.notEqual(safeDescribe(parseXpub(V1_M)), described);
});
