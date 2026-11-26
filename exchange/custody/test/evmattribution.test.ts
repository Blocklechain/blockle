// -----------------------------------------------------------------------------
// WHO OWNS AN EVM DEPOSIT ADDRESS — THE CASE-FOLD REGRESSION.
//
// THE DEFECT THESE TESTS PIN, IN ONE SENTENCE: a deposit address is issued
// EIP-55 CHECKSUMMED (mixed case) and the chain reports the arrival LOWERCASE,
// so an attribution lookup that compares bytes finds nobody and credits every
// EVM deposit to `__unattributed__`.
//
// WHY IT HAD TO BE A TEST AND NOT A CODE READING. Every part of the failure is
// invisible from outside:
//
//   * `__unattributed__` is a USER account, so liabilities still equal custody.
//     The reconciler sees neither a shortfall nor a surplus and nothing halts.
//   * `runOnce` returns `errors: []`. The pass looks perfect.
//   * The only trace is a `deposit_seen` row with outcome 'unattributed'.
//   * The customer's balance is simply zero, which looks like "not arrived yet".
//
// And it is not an edge case. An EIP-55 address is all-lowercase only when all
// forty hex digits happen to be digits-or-unaffected — about 2^-15 — so the
// first test below derives real addresses from a real xpub and asserts the
// property that makes this universal rather than occasional.
//
// THE SECOND HALF OF THE FIX IS THE PART THAT IS EASY TO GET WRONG. Folding
// case is correct for 0x-hex and WRONG for base58: on Solana, BTC, DOGE and the
// small PoW coins two addresses differing in case are two different addresses.
// So there is a test here that a base58 lookup is still exact, and a test that
// two customers can never be issued the same address through a case difference
// — because once folding is accepted on the read side, two such rows would make
// attribution ambiguous, and an ambiguous address is worse than an unknown one.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { AccountKind } from "../src/ledger";
import { Ledger } from "../src/ledger";
import { Deposits, DepositError, addressCaseIsCosmetic } from "../src/deposits";
import { runOnce, UNATTRIBUTED } from "../src/depositwatcher";
import { EvmAddressIndex } from "../src/evmaddressindex";
import { parseXpub } from "../src/evmxpub";

/** The Anvil dev account xpub for m/44'/60'/0'/0. See evmxpub.test.ts. */
const ANVIL =
	"xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4";

function setup(): { db: Database.Database; ledger: Ledger; deposits: Deposits } {
	const db = new Database(":memory:");
	return { db, ledger: new Ledger(db), deposits: new Deposits(db) };
}

/** A BitGo client double that is never consulted: these rails are node-fed. */
const noClient = {
	async incomingTransfers() {
		return { transfers: [] as never, nextPrevId: undefined };
	},
	async createReceiveAddress() {
		throw new Error("not used in this test");
	},
	async wallets() {
		return [];
	},
} as never;

/** A node feed that reports one arrival, at whatever spelling it is given. */
function feed(symbol: string, address: string, amount: bigint, confirmations: number) {
	return {
		symbol,
		route: "evm-rpc",
		probe: async () => ({
			reachable: true,
			synced: true,
			height: 1,
			decimals: 18,
			canDeriveAddresses: true,
			canSend: false,
			notes: [],
		}),
		balance: async () => amount,
		newAddress: async () => "x",
		incoming: async () => [{ txid: "0xdeposit", address, amount, confirmations }],
		send: async () => ({ txid: "" }),
	};
}

test("A REAL ISSUED EVM ADDRESS IS MIXED CASE — which is what made this universal", () => {
	/*
	 * Derived, not hand-written. The one existing test of `ownerOfAddress` used
	 * a hand-typed all-lowercase `0xabc0000…`, which passes whether the bug is
	 * present or not — that is exactly why the defect survived review.
	 */
	const ix = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	let lowercase = 0;
	for (let i = 0; i < 30; i++) {
		const a = ix.take(`cust-${i}`).address;
		assert.match(a, /^0x[0-9a-fA-F]{40}$/);
		if (a === a.toLowerCase()) lowercase++;
	}
	assert.equal(
		lowercase,
		0,
		"not one of 30 derived addresses was all-lowercase, so a byte-exact " +
			"lookup against a lowercased chain report misses essentially every " +
			"customer, not an unlucky few",
	);
});

test("THE CHAIN'S LOWERCASE SPELLING FINDS THE CUSTOMER WHO WAS ISSUED THE CHECKSUMMED ONE", () => {
	const { deposits } = setup();
	const ix = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	const issued = ix.take("alice").address;
	assert.notEqual(issued, issued.toLowerCase(), "the fixture must be checksummed");

	deposits.provision({
		userId: "alice",
		asset: "ETH",
		network: undefined,
		// Stored AS DERIVED. Lowercasing at provision time would discard the
		// checksum the schema comment deliberately keeps, and the ABORT trigger
		// makes a stored row impossible to fix afterwards.
		address: issued,
		source: "evm-xpub",
	});

	assert.equal(deposits.ownerOfAddress(issued, "ETH", undefined), "alice");
	assert.equal(
		deposits.ownerOfAddress(issued.toLowerCase(), "ETH", undefined),
		"alice",
		"this is the spelling EvmNativeScanner emits from tx.to",
	);
	assert.equal(deposits.ownerOfAddress(issued.toUpperCase().replace("0X", "0x"), "ETH", undefined), "alice");
});

test("THE DEPOSIT REACHES THE CUSTOMER, NOT __unattributed__ — end to end", async () => {
	const { db, ledger, deposits } = setup();
	const ix = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	const issued = ix.take("alice").address;
	deposits.provision({
		userId: "alice",
		asset: "ETH",
		network: undefined,
		address: issued,
		source: "evm-xpub",
	});

	const one = 1_000_000_000_000_000_000n;
	const r = await runOnce({
		db,
		ledger,
		client: noClient,
		walletFor: async () => undefined,
		assets: ["ETH"],
		// The scanner lowercases tx.to on purpose, so this is the real input.
		nodeFeeds: new Map([["ETH", feed("ETH", issued.toLowerCase(), one, 64)]]),
	});

	assert.deepEqual(r.errors, []);
	assert.equal(r.credited, 1);
	assert.equal(
		r.unattributed,
		0,
		"an unattributed EVM deposit is the defect: the books still balance, " +
			"nothing errors, and the customer's balance stays zero",
	);
	assert.equal(
		ledger.balance({ kind: AccountKind.USER, owner: "alice", asset: "ETH" }),
		one,
	);
	assert.equal(
		ledger.balance({ kind: AccountKind.USER, owner: UNATTRIBUTED, asset: "ETH" }),
		0n,
	);
});

test("BASE58 IS NEVER FOLDED: on Solana and the PoW coins, case IS identity", () => {
	const { deposits } = setup();
	const sol = "HRdvYQ2StLnLNRHFeyBoDMgBVbCqjAJTm5vAmbmBqEwP";
	deposits.provision({
		userId: "alice",
		asset: "SOL",
		network: undefined,
		address: sol,
		source: "sol-pool",
	});

	assert.equal(deposits.ownerOfAddress(sol, "SOL", undefined), "alice");
	/*
	 * A case variant of a base58 address is a DIFFERENT address (and in
	 * practice an invalid one — the checksum is over the bytes, not over the
	 * spelling). Folding it would be the mirror-image defect of the one above:
	 * crediting one customer for coins that arrived somewhere else.
	 */
	assert.equal(deposits.ownerOfAddress(sol.toLowerCase(), "SOL", undefined), undefined);
	assert.equal(addressCaseIsCosmetic(sol), false);
	assert.equal(addressCaseIsCosmetic("0x1111111111111111111111111111111111111111"), true);
	// Length matters: a 0x-prefixed string that is not 20 bytes is not an EVM
	// address, and must not be folded on the strength of its prefix.
	assert.equal(addressCaseIsCosmetic("0xABC"), false);
});

test("THE SAME EVM ADDRESS CANNOT REACH TWO CUSTOMERS THROUGH A CASE DIFFERENCE", () => {
	const { deposits } = setup();
	const ix = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	const issued = ix.take("alice").address;
	deposits.provision({
		userId: "alice",
		asset: "ETH",
		network: undefined,
		address: issued,
		source: "evm-xpub",
	});

	/*
	 * The UNIQUE index is on the address AS STORED, so without this check the
	 * lowercase spelling would insert cleanly for a second customer — and then
	 * `ownerOfAddress` would have two candidates for one address and park every
	 * deposit to it rather than guess. Refusing the second issue is where that
	 * is preventable.
	 */
	assert.throws(
		() =>
			deposits.provision({
				userId: "bob",
				asset: "ETH",
				network: undefined,
				address: issued.toLowerCase(),
				source: "evm-xpub",
			}),
		(e: unknown) =>
			e instanceof DepositError &&
			e.status === 409 &&
			/already issued to another account/.test(e.message),
	);

	// And a re-provision of the SAME customer's address in the other case is
	// idempotent rather than a 409 nobody could resolve: it is one address.
	const again = deposits.provision({
		userId: "alice",
		asset: "ETH",
		network: undefined,
		address: issued.toLowerCase(),
		source: "evm-xpub",
	});
	assert.equal(again.address, issued, "the stored, checksummed spelling is kept");
});

test("AN AMBIGUOUS ADDRESS PARKS THE DEPOSIT — it never credits the first row read", () => {
	/*
	 * Reachable only by a direct SQL write (or a row predating the check above),
	 * which is precisely why it is tested: the honest answer to "two customers
	 * claim this address" is "nobody", which parks the deposit for a human.
	 * Crediting one of them would hand one customer another's money.
	 */
	const { db, deposits } = setup();
	const a = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
	deposits.provision({
		userId: "alice", asset: "ETH", network: undefined, address: a, source: "evm-xpub",
	});
	db.prepare(
		`INSERT INTO deposit_address (user_id, asset, network, address, memo, source, created_at)
		 VALUES ('bob', 'ETH', '', ?, NULL, 'hand-edited', '2026-01-01T00:00:00.000Z')`,
	).run(a.toLowerCase());

	assert.equal(deposits.ownerOfAddress(a, "ETH", undefined), "alice", "exact still wins");
	assert.equal(
		deposits.ownerOfAddress(a.toLowerCase(), "ETH", undefined),
		"bob",
		"an exact match on the lowercase row is still exact, and unambiguous",
	);
	assert.equal(
		deposits.ownerOfAddress(a.toUpperCase().replace("0X", "0x"), "ETH", undefined),
		undefined,
		"a spelling matching neither row exactly folds to two owners — park it",
	);
});
