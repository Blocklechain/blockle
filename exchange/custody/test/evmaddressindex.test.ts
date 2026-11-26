// -----------------------------------------------------------------------------
// EVM DEPOSIT INDEX TESTS.
//
// The table under test holds one integer per customer, and that integer is the
// only thing that lets the offline signer re-derive the key which spends
// whatever arrived at that customer's deposit address. So the properties
// defended here are not about correctness of a cache — they are about whether
// money that has already arrived can still be moved:
//
//   * ONE ADDRESS PER CUSTOMER, STABLE FOREVER. A customer returning to the
//     deposit screen must be shown the address they already have. A fresh one
//     orphans any deposit already in flight to the previous address, which then
//     arrives somewhere nobody is attributed to and lands in `__unattributed__`
//     as a liability owed to nobody. That has already happened on this venue
//     once, to XRP, and ops/unbook-unattributed.js exists because of it.
//
//   * THE RECORDED INDEX IS THE INDEX THAT WAS DERIVED. Not the loop variable
//     that was intended. A silently shifted index means the signer re-derives a
//     key for a different address than the one holding the coins.
//
//   * TWO ACCOUNTS NEVER SHARE AN INDEX SPACE. Mixing xpubs is the quiet
//     failure: nothing looks wrong until a sweep is attempted and the signer
//     reports that index 40 derives something else. By then the money is there.
//
// The xpub used throughout is the published Hardhat/Anvil development account
// — worthless, and the most published key material in Ethereum. No real key
// appears here; see evmxpub.test.ts for the provenance of the vectors.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { EvmAddressError, EvmAddressIndex, FIRST_CUSTOMER_INDEX } from "../src/evmaddressindex";
import { deriveEvmAddress, parseXpub } from "../src/evmxpub";

/** The Anvil dev account xpub for m/44'/60'/0'/0. See evmxpub.test.ts. */
const ANVIL =
	"xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4";

/** A DIFFERENT published account: BIP-32 test vector 1's master key. */
const OTHER_ACCOUNT =
	"xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";

function index(serialized = ANVIL, db = new Database(":memory:")): EvmAddressIndex {
	return new EvmAddressIndex(db, parseXpub(serialized));
}

test("the first customer is NOT index 0: the low indices are the venue's own", () => {
	/*
	 * `m/44'/60'/0'/0/0` is the index every wallet, tutorial and tool picks for
	 * an account's first address, so it is where the signer host's hot/gas
	 * address will be. If a customer were issued index 0 as well, the venue's
	 * own gas drips and sweep change would land at a CUSTOMER's deposit address
	 * and be credited to that customer as a deposit.
	 *
	 * Reserving a block of low indices costs sixteen addresses and removes the
	 * whole class of error. It cannot be fixed later: `deposit_address` has a
	 * BEFORE UPDATE trigger that ABORTs edits precisely so a live deposit
	 * address can never be renumbered in place.
	 */
	const ix = index();
	const first = ix.take("cust-1");
	assert.equal(first.index, FIRST_CUSTOMER_INDEX);
	assert.ok(FIRST_CUSTOMER_INDEX > 0, "index 0 must never be a customer's");
});

test("a returning customer gets THE SAME address, not a fresh one", () => {
	// The deposit-in-flight property. Called repeatedly because the deposit
	// screen is a page a customer reloads.
	const ix = index();
	const a = ix.take("cust-1");
	const b = ix.take("cust-1");
	const c = ix.take("  cust-1  "); // whitespace is trimmed, same customer
	assert.deepEqual(a, b);
	assert.deepEqual(a, c);
	assert.equal(ix.status().issued, 1, "no second index may be consumed");
});

test("different customers get different indices and different addresses", () => {
	/*
	 * ONE ADDRESS PER CUSTOMER, NEVER A SHARED ONE. Ethereum, BSC and Polygon
	 * have no memo field, so two customers sharing an address makes their
	 * deposits permanently indistinguishable on arrival — reconciliation still
	 * balances while the venue credits the wrong person and never finds out.
	 */
	const ix = index();
	const seen = new Set<string>();
	const indices = new Set<number>();
	for (let i = 0; i < 20; i++) {
		const got = ix.take(`cust-${i}`);
		seen.add(got.address.toLowerCase());
		indices.add(got.index);
	}
	assert.equal(seen.size, 20);
	assert.equal(indices.size, 20);
	assert.equal(ix.status().issued, 20);
});

test("the ADDRESS RECORDED is the address the recorded INDEX derives", () => {
	/*
	 * THE RECOVERABILITY CONTRACT, ASSERTED DIRECTLY.
	 *
	 * The stored row says "index N, address A". The signer will be handed N and
	 * will derive from its own seed. If the table's A is not what N derives,
	 * the sweep targets an address that holds nothing while the customer's coins
	 * sit at an address the signer never computes.
	 *
	 * Checked against an INDEPENDENT derivation from the account xpub rather
	 * than against whatever the class happened to store, so a bug that recorded
	 * a consistent-but-wrong pair cannot pass.
	 */
	const account = parseXpub(ANVIL);
	const ix = index();
	for (let i = 0; i < 8; i++) {
		const issued = ix.take(`cust-${i}`);
		assert.equal(
			issued.address,
			deriveEvmAddress(account, issued.index),
			`row for cust-${i} must match ${issued.index} derived from the xpub`,
		);
	}
});

test("indices are allocated monotonically and are not reused after a gap", () => {
	// Monotonic because the signer's nonce store and the operator's mental model
	// both assume it, and because reusing an index would hand a second customer
	// an address the first one's deposits may still be arriving at.
	const ix = index();
	const got = [ix.take("a"), ix.take("b"), ix.take("c")].map((r) => r.index);
	assert.deepEqual(got, [
		FIRST_CUSTOMER_INDEX,
		FIRST_CUSTOMER_INDEX + 1,
		FIRST_CUSTOMER_INDEX + 2,
	]);
	assert.equal(ix.status().nextIndex, FIRST_CUSTOMER_INDEX + 3);
});

test("an address survives a restart: the index space is read back from the table", () => {
	/*
	 * The deposit watcher and the API are separate one-shot processes against
	 * the same SQLite file, so "what is the next index" must be a fact in the
	 * database rather than a counter in memory. A process that restarted at
	 * FIRST_CUSTOMER_INDEX would re-issue addresses already handed out.
	 */
	const db = new Database(":memory:");
	const first = index(ANVIL, db);
	const issued = first.take("cust-1");

	const reopened = index(ANVIL, db);
	assert.deepEqual(reopened.forUser("cust-1"), issued);
	assert.equal(reopened.take("cust-2").index, issued.index + 1);
});

test("A SECOND XPUB OVER THE SAME TABLE REFUSES TO START", () => {
	/*
	 * THE QUIETEST WAY TO LOSE A DEPOSIT, AND THE REASON xpub_fp IS A COLUMN.
	 *
	 * If a different account's xpub were configured over rows already issued,
	 * every new address would be derived from a seed the signer does not hold,
	 * and every OLD address would still be in the table looking perfectly
	 * normal. Nothing errors. The failure surfaces at the first sweep, after the
	 * money has arrived.
	 *
	 * This is the EVM analogue of blockaddresspool's "same index, different
	 * address means two master seeds — refusing". The message must also tell the
	 * operator what a deliberate rotation actually requires, because the natural
	 * instinct — point the new xpub at the same table — is the broken one.
	 */
	const db = new Database(":memory:");
	index(ANVIL, db).take("cust-1");

	assert.throws(
		() => index(OTHER_ACCOUNT, db),
		(e: unknown) => {
			assert.ok(e instanceof EvmAddressError);
			assert.match(e.message, /REFUSING TO START/);
			assert.match(e.message, /retire the old addresses and reprovision/);
			assert.equal(e.status, 500);
			return true;
		},
	);
});

test("the SAME xpub over an existing table is fine — that is just a restart", () => {
	// The check must not be so eager that redeploying the service trips it.
	const db = new Database(":memory:");
	index(ANVIL, db).take("cust-1");
	assert.doesNotThrow(() => index(ANVIL, db));
});

test("an empty table accepts any xpub, because there is nothing to contradict", () => {
	const db = new Database(":memory:");
	assert.doesNotThrow(() => index(OTHER_ACCOUNT, db));
});

test("every issued row records WHICH xpub derived it", () => {
	// Not for debugging: it is what makes the rotation refusal above possible,
	// and what an off-host monitor compares against.
	const ix = index();
	ix.take("cust-1");
	const fp = parseXpub(ANVIL).fingerprint;
	assert.equal(ix.fingerprint, fp);
	for (const row of ix.attestation()) {
		assert.equal(row.xpubFingerprint, fp);
	}
});

/* ------------------------------------------------- the signer's vector file */

test("VECTORS PROVE THE XPUB BELONGS TO THE SIGNER'S SEED, and are mandatory", () => {
	/*
	 * A valid xpub of the WRONG seed parses perfectly, derives beautiful
	 * checksummed addresses, and is completely unsweepable. No amount of
	 * validation on the xpub itself can tell the two apart — the only thing that
	 * can is a list of addresses the signer derived from the SEED, compared
	 * against the same indices derived from the xpub.
	 *
	 * Mandatory rather than optional, and a throw rather than a warning,
	 * because a warning in a log is how a thousand loaded BLOCK addresses sat
	 * unused while customers were told the rail was shut: nobody read it, and it
	 * proved nothing about the object actually in use.
	 */
	const account = parseXpub(ANVIL);
	const ix = index();

	// Empty is a refusal, not a pass: "no vectors" means nothing was proved.
	assert.throws(() => ix.assertVectors([]), /no derivation vectors were supplied/);

	// The signer's real file, for the indices it would ship.
	const good = [0, 1, 2, 3, 4].map((i) => ({ index: i, address: deriveEvmAddress(account, i) }));
	assert.doesNotThrow(() => ix.assertVectors(good));

	// Lowercase is the same address — a signer may not checksum its output.
	assert.doesNotThrow(() =>
		ix.assertVectors(good.map((v) => ({ ...v, address: v.address.toLowerCase() }))),
	);
});

test("A VECTOR MISMATCH REFUSES TO START and says not to edit the vector file", () => {
	/*
	 * The direction of the fix matters and is easy to get backwards. A mismatch
	 * means the configured XPUB is wrong, so the xpub must be re-exported from
	 * the signer. "Fixing" the vector file to match makes the check pass and
	 * guarantees the deposits are unsweepable — which is why the message says so
	 * explicitly.
	 */
	const other = parseXpub(OTHER_ACCOUNT);
	const ix = index(ANVIL);
	const wrong = [{ index: 0, address: deriveEvmAddress(other, 0) }];
	assert.throws(
		() => ix.assertVectors(wrong),
		(e: unknown) => {
			assert.ok(e instanceof EvmAddressError);
			assert.match(e.message, /REFUSING TO START/);
			assert.match(e.message, /do not 'fix' the\s+vector file/);
			return true;
		},
	);
});

/* ------------------------------------------------------------- attribution */

test("ownerOf matches an address case-insensitively", () => {
	/*
	 * The table stores EIP-55 mixed case; a chain reports the lowercase form. A
	 * case-sensitive lookup would fail to attribute every single real deposit
	 * and credit all of them to `__unattributed__`.
	 */
	const ix = index();
	const issued = ix.take("cust-1");
	assert.equal(ix.ownerOf(issued.address), "cust-1");
	assert.equal(ix.ownerOf(issued.address.toLowerCase()), "cust-1");
	assert.equal(ix.ownerOf(issued.address.toUpperCase().replace("0X", "0x")), "cust-1");
	assert.equal(ix.ownerOf("0x" + "9".repeat(40)), undefined);
});

test("indexOf recovers the derivation index from an address, for a sweep proposal", () => {
	// This is the lookup the sweep composer uses: it has an address with a
	// balance and needs the integer the signer will re-derive from.
	const ix = index();
	const issued = ix.take("cust-1");
	assert.equal(ix.indexOf(issued.address), issued.index);
	assert.equal(ix.indexOf(issued.address.toLowerCase()), issued.index);
	assert.equal(ix.indexOf("0x" + "9".repeat(40)), undefined);
});

test("allAddresses is what the reconciler counts AND what the scanner watches", () => {
	/*
	 * Both, and the reconciler is the one that gets forgotten. Coins at a
	 * customer's deposit address before a sweep ARE the venue's holding: the
	 * customer has already been credited, so the venue owes it. A reconciler
	 * that counted only the hot address would see the liability without the
	 * asset — a SHORTFALL, which has no tolerance at any size and halts the
	 * asset for every customer.
	 */
	const ix = index();
	const issued = [ix.take("a"), ix.take("b"), ix.take("c")];
	const all = ix.allAddresses();
	assert.equal(all.length, 3);
	for (const r of issued) assert.ok(all.includes(r.address));
	// Ordered by index, so operator output and diffs are stable.
	assert.deepEqual([...all], issued.map((r) => r.address));
});

test("an address needs an owner: a blank label is refused", () => {
	// An address issued against a blank label could not be attributed to
	// anyone, and on a chain with no memo field that is unrecoverable.
	const ix = index();
	assert.throws(() => ix.take(""), /needs an owner/);
	assert.throws(() => ix.take("   "), /needs an owner/);
});

test("status reports the issued count, the next index and the fingerprint", () => {
	const ix = index();
	const empty = ix.status();
	assert.equal(empty.issued, 0);
	assert.equal(empty.nextIndex, FIRST_CUSTOMER_INDEX);
	assert.equal(empty.fingerprint, parseXpub(ANVIL).fingerprint);

	ix.take("cust-1");
	assert.equal(ix.status().issued, 1);
	assert.equal(ix.status().nextIndex, FIRST_CUSTOMER_INDEX + 1);
});

test("THE OFF-HOST MONITOR'S INPUT is derivable from public data alone", () => {
	/*
	 * THE ATTACK NO KEY DESIGN CLOSES, AND WHY THIS METHOD EXISTS.
	 *
	 * Root on the exchange host does not need to sign anything to steal a NEW
	 * customer's first deposit — it only has to change what that customer is
	 * SHOWN as their deposit address. The xpub model does not help, because the
	 * display is downstream of derivation. An attacker with root can swap in
	 * their own xpub and every new address is theirs.
	 *
	 * What makes that detectable is that an honest address is deterministic from
	 * PUBLIC data: the xpub fingerprint plus the index. So a monitor running
	 * somewhere this host cannot reach or rewrite re-derives every issued
	 * address from its own copy of the xpub and alarms on any mismatch, and the
	 * same triple is published on the deposit screen so a customer can verify
	 * their own address off our infrastructure entirely.
	 *
	 * This test asserts the attestation is sufficient for that: index, address
	 * and fingerprint, and re-deriving from the index reproduces the address.
	 */
	const account = parseXpub(ANVIL);
	const ix = index();
	ix.take("cust-1");
	ix.take("cust-2");

	const rows = ix.attestation();
	assert.equal(rows.length, 2);
	for (const row of rows) {
		// A monitor holding only the xpub can check this line, with no access
		// to the exchange host's database beyond the published attestation.
		assert.equal(deriveEvmAddress(account, row.index), row.address);
		assert.equal(row.xpubFingerprint, account.fingerprint);
	}
	// No customer identifier is exposed: the attestation is publishable, and
	// linking indices to named customers would make it a disclosure instead.
	for (const row of rows) {
		assert.ok(!("userId" in row) && !("user_id" in row));
	}
});
