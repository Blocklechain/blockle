// -----------------------------------------------------------------------------
// DECLARED TREASURY TESTS.
//
// This file is what reconciliation compares the books against on testnet, so
// the tests are about not corrupting it and not silently misreading it. A
// declaration that parses wrongly reads as "we hold nothing", which is a
// shortfall against every liability.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TreasuryError, bumpDeclared, readDeclared } from "../src/declaredtreasury";

function tmpFile(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "treasury-"));
	const path = join(dir, "testnet-treasury.json");
	if (contents !== undefined) writeFileSync(path, contents);
	return path;
}

test("a missing file is an empty declaration, not a crash", () => {
	// A fresh box has no file yet, and the first faucet click should create it.
	assert.deepEqual(readDeclared(tmpFile()), {});
});

test("amounts are read as bigints from strings", () => {
	const p = tmpFile('{"BTC":"350000000","ETH":"40000000000000000000"}');
	assert.deepEqual(readDeclared(p), {
		BTC: 350_000_000n,
		ETH: 40_000_000_000_000_000_000n,
	});
});

test("A JSON NUMBER IS REFUSED, because it cannot hold an 18-decimal balance", () => {
	const p = tmpFile('{"ETH":40000000000000000000}');
	assert.throws(() => readDeclared(p), (e: unknown) => {
		assert.ok(e instanceof TreasuryError);
		assert.match(String(e), /must be a decimal string of base units/);
		return true;
	});
});

test("A CORRUPT FILE THROWS rather than reading as 'we hold nothing'", () => {
	// Zero holdings against real liabilities is a shortfall on every asset.
	const p = tmpFile("{not json");
	assert.throws(() => readDeclared(p), /Refusing to guess at it/);
	assert.throws(() => readDeclared(tmpFile('["BTC"]')), /must be a JSON object/);
});

test("a bump adds to an existing asset and creates a missing one", () => {
	const p = tmpFile('{"BTC":"100"}');
	assert.equal(bumpDeclared(p, "BTC", 50n), 150n);
	assert.equal(bumpDeclared(p, "BLOCK", 7n), 7n);
	assert.deepEqual(readDeclared(p), { BTC: 150n, BLOCK: 7n });
});

test("the written file stays string-valued, sorted and re-readable", () => {
	const p = tmpFile();
	bumpDeclared(p, "USDT", 1n);
	bumpDeclared(p, "BTC", 2n);
	const text = readFileSync(p, "utf8");
	// Sorted, so a diff shows what changed rather than what moved.
	assert.ok(text.indexOf('"BTC"') < text.indexOf('"USDT"'), text);
	// Strings, so the next read does not hit the JSON-number refusal above.
	assert.match(text, /"BTC": ?"2"/);
	assert.deepEqual(readDeclared(p), { BTC: 2n, USDT: 1n });
});

test("a non-positive bump is refused", () => {
	const p = tmpFile('{"BTC":"100"}');
	for (const d of [0n, -1n]) {
		assert.throws(() => bumpDeclared(p, "BTC", d), /must be positive/, String(d));
	}
	assert.deepEqual(readDeclared(p), { BTC: 100n }, "and leaves the file alone");
});

test("a huge balance survives the round trip", () => {
	// Past 2^53, where a JSON number would have quietly lost the low digits.
	const p = tmpFile();
	const big = 123_456_789_012_345_678_901_234n;
	assert.equal(bumpDeclared(p, "ETH", big), big);
	assert.equal(readDeclared(p).ETH, big);
});

test("a qualified custody id is its own line", () => {
	// Custody is per chain for a multi-network asset, and the declaration has
	// to match the ids the ledger posts against.
	const p = tmpFile();
	bumpDeclared(p, "USDT.TRC20", 5n);
	bumpDeclared(p, "USDT.ERC20", 3n);
	assert.deepEqual(readDeclared(p), { "USDT.TRC20": 5n, "USDT.ERC20": 3n });
});
