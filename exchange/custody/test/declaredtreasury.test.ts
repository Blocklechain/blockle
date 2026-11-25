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
import { testnetTreasury } from "../src/reconcilejob";

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
	// QUALIFIED, because USDT is multi-network. A bare "USDT" key is what the
	// faucet and the reconciler used to disagree about; see the next test.
	bumpDeclared(p, "USDT.TRC20", 1n);
	bumpDeclared(p, "BTC", 2n);
	const text = readFileSync(p, "utf8");
	// Sorted, so a diff shows what changed rather than what moved.
	assert.ok(text.indexOf('"BTC"') < text.indexOf('"USDT.TRC20"'), text);
	// Strings, so the next read does not hit the JSON-number refusal above.
	assert.match(text, /"BTC": ?"2"/);
	assert.deepEqual(readDeclared(p), { BTC: 2n, "USDT.TRC20": 1n });
});

test("A JUNK CUSTODY ID IS NEVER WRITTEN DOWN", () => {
	// The live incident: a scanner pushed path-traversal payloads through the
	// faucet's `asset` field, and because assetDef() resolves only the part
	// before the first dot, the raw string reached this file as a KEY. No file
	// outside the treasury was touched — but caller input must not be able to
	// mint lines in the declaration reconciliation keys on.
	const p = tmpFile('{"BTC":"100"}');
	for (const junk of [
		"USDT../../../../ETC/PASSWD.TRC20",
		"USDT..\\..\\WINDOWS\\WIN.INI.TRC20",
		"NOTACOIN",
		"BTC.TRC20", // single-chain asset with a network: a phantom balance
		"USDT", // multi-network asset with none: reconcilable against nothing
		"USDT.NOSUCHCHAIN",
	]) {
		assert.throws(() => bumpDeclared(p, junk, 1n), Error, `must refuse ${junk}`);
	}
	// And nothing was written on the way to refusing.
	assert.deepEqual(readDeclared(p), { BTC: 100n });
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

// ----------------------------------------------- the faucet/reconciler seam

test("THE RECONCILER AND THE FAUCET AGREE ON ONE KEY SPACE", async () => {
	// THE BUG THIS LOCKS DOWN, in the exact shape it took on the live box.
	//
	// The faucet declares per network (`USDT.TRC20`, because that is the
	// custody id it posts to). The reconciler used to read the BARE symbol
	// (`USDT`). So the declaration could never catch up with the books: USDT
	// showed a 1,390,000,000,000 shortfall on every pass, withdrawals stayed
	// halted, and the interlock — pinned on — could no longer report a REAL
	// USDT shortfall to anyone.
	// EVERY leg of the asset, because the holding is the sum of all of them.
	const p = tmpFile();
	bumpDeclared(p, "USDT.TRC20", 1_390_000_000_000n);
	bumpDeclared(p, "USDT.SOL", 5_000_000_000n);
	bumpDeclared(p, "USDT.ERC20", 1n);
	bumpDeclared(p, "USDT.BEP20", 1n);

	const src = testnetTreasury(p);
	// Summed across the asset's networks, which is what the books hold.
	assert.equal(await src.holdings("USDT"), 1_395_000_000_002n);

	// A bare key is NOT read as the holding any more — that is the old bug.
	const stale = tmpFile('{"USDT":"95000000000"}');
	await assert.rejects(
		() => testnetTreasury(stale).holdings("USDT"),
		/USDT\.\w+ is not declared/,
		"an undeclared network leg is UNKNOWN, never zero and never a bare fallback",
	);
});

test("a single-chain asset still uses its bare key", async () => {
	// custodyIds returns [symbol] for these, so nothing changed for BTC/BLOCK.
	const p = tmpFile('{"BTC":"350000000"}');
	assert.equal(await testnetTreasury(p).holdings("BTC"), 350_000_000n);
});

test("ONE MISSING NETWORK LEG DOES NOT SILENTLY SHRINK THE HOLDING", async () => {
	// Summing with a missing leg treated as zero would understate holdings and
	// manufacture a shortfall — the same class of error, reintroduced.
	const p = tmpFile('{"USDT.TRC20":"1000"}');
	await assert.rejects(() => testnetTreasury(p).holdings("USDT"), /not declared/);
});
