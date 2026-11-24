// -----------------------------------------------------------------------------
// DEPOSIT WATCHER TESTS.
//
// This is the rail that turns coins arriving on chain into a customer's
// balance, and the failures are the expensive kind in both directions:
// crediting the wrong person, crediting twice, crediting a reorg-able deposit,
// or never crediting at all. Every one of those is pinned here.
//
// No network: the BitGo client is a double. What is being tested is the
// attribution and the ledger postings, not HTTP.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { confirmationsFor } from "../src/bitgodeposits";
import { Deposits } from "../src/deposits";
import {
	UNATTRIBUTED,
	depositsFor,
	runOnce,
	unattributedDeposits,
} from "../src/depositwatcher";
import { AccountKind, Ledger } from "../src/ledger";

type Transfer = {
	id: string;
	txid: string;
	coin: string;
	confirmations: number;
	state: string;
	credits: { address: string; amount: bigint }[];
	total: bigint;
	createdAt?: string;
};

/** A BitGo deposit client double. */
function client(feed: Record<string, Transfer[]>, opts: { fail?: string } = {}) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			async incomingTransfers(a: { coin: string; walletId: string }) {
				calls.push(a.coin);
				if (opts.fail === a.coin) throw new Error("BitGo 503");
				return {
					transfers: (feed[a.coin] ?? []) as never,
					nextPrevId: undefined,
				};
			},
			async createReceiveAddress() {
				throw new Error("not used in this test");
			},
			async wallets() {
				return [];
			},
		} as never,
	};
}

function setup(): { db: Database.Database; l: Ledger; d: Deposits } {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	return { db, l, d: new Deposits(db) };
}

const walletFor = async (custodyId: string) => {
	const map: Record<string, { coin: string; walletId: string }> = {
		BTC: { coin: "btc", walletId: "w-btc" },
		"USDT.TRC20": { coin: "trx:usdt", walletId: "w-trx-usdt" },
		"USDT.ERC20": { coin: "eth:usdt", walletId: "w-eth-usdt" },
		"USDT.SOL": { coin: "sol:usdt", walletId: "w-sol-usdt" },
		"USDT.BEP20": { coin: "bsc:usdt", walletId: "w-bsc-usdt" },
	};
	return map[custodyId];
};

const bal = (l: Ledger, owner: string, asset: string): bigint =>
	l.balance({ kind: AccountKind.USER, owner, asset });
const custody = (l: Ledger, asset: string): bigint =>
	l.balance({ kind: AccountKind.CUSTODY, owner: "", asset });

test("A DEPOSIT IS CREDITED TO THE CUSTOMER WHOSE ADDRESS IT ARRIVED AT", async () => {
	const { db, l, d } = setup();
	d.provision({
		userId: "alice",
		asset: "BTC",
		network: undefined,
		address: "bc1q-alice",
		source: "bitgo",
	});
	d.provision({
		userId: "bob",
		asset: "BTC",
		network: undefined,
		address: "bc1q-bob",
		source: "bitgo",
	});

	const c = client({
		btc: [
			{
				id: "t1",
				txid: "tx1",
				coin: "btc",
				confirmations: 6,
				state: "confirmed",
				credits: [{ address: "bc1q-bob", amount: 150_000_000n }],
				total: 150_000_000n,
			},
		],
	});

	const r = await runOnce({
		db, ledger: l, client: c.client, walletFor, assets: ["BTC"],
	});

	assert.equal(r.credited, 1);
	assert.equal(bal(l, "bob", "BTC"), 150_000_000n);
	assert.equal(bal(l, "alice", "BTC"), 0n, "not the other customer");
	// AND CUSTODY MOVED WITH IT. A deposit that credited only the customer
	// would be an instant, permanent shortfall.
	assert.equal(custody(l, "BTC"), 150_000_000n);
});

test("CREDITED EXACTLY ONCE across repeated polls", async () => {
	// Re-reading recent transfers is the NORMAL case — every poll does it — so
	// this is the property the whole design hangs on.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });
	const c = client({
		btc: [{
			id: "t1", txid: "tx1", coin: "btc", confirmations: 6, state: "confirmed",
			credits: [{ address: "a1", amount: 100_000n }], total: 100_000n,
		}],
	});

	for (let i = 0; i < 4; i++) {
		await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["BTC"] });
	}
	assert.equal(bal(l, "alice", "BTC"), 100_000n, "four polls, one credit");
	assert.equal(custody(l, "BTC"), 100_000n);
});

test("A DEPOSIT IS HELD UNTIL IT IS DEEP ENOUGH", async () => {
	// Crediting early means crediting something a reorg can take back, after
	// the customer has traded or withdrawn it. The venue is short at that point.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });

	const shallow = client({
		btc: [{
			id: "t1", txid: "tx1", coin: "btc", confirmations: 1, state: "confirmed",
			credits: [{ address: "a1", amount: 100_000n }], total: 100_000n,
		}],
	});
	const r1 = await runOnce({ db, ledger: l, client: shallow.client, walletFor, assets: ["BTC"] });
	assert.equal(r1.pending, 1);
	assert.equal(r1.credited, 0);
	assert.equal(bal(l, "alice", "BTC"), 0n);

	// The customer can SEE it waiting, with how far to go — which is what makes
	// "where is my deposit" answerable without an operator.
	const mine = depositsFor(db, "alice");
	assert.equal(mine.length, 1);
	assert.equal(mine[0]!.outcome, "pending");
	assert.match(String(mine[0]!.detail), /1 of 2 confirmations/);
	assert.equal(mine[0]!.amount, "0.001", "formatted at the asset's decimals");

	// Deeper, and it lands.
	const deep = client({
		btc: [{
			id: "t1", txid: "tx1", coin: "btc", confirmations: 2, state: "confirmed",
			credits: [{ address: "a1", amount: 100_000n }], total: 100_000n,
		}],
	});
	const r2 = await runOnce({ db, ledger: l, client: deep.client, walletFor, assets: ["BTC"] });
	assert.equal(r2.credited, 1);
	assert.equal(bal(l, "alice", "BTC"), 100_000n);
});

test("A CREDITED DEPOSIT IS NEVER DOWNGRADED BACK TO PENDING", async () => {
	// A lagging node or an in-flight reorg can report fewer confirmations on a
	// later poll. The money is already in the customer's balance; only a
	// deliberate correction reverses that, so the record must not flip.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });
	const t = (conf: number) => client({
		btc: [{
			id: "t1", txid: "tx1", coin: "btc", confirmations: conf, state: "confirmed",
			credits: [{ address: "a1", amount: 100_000n }], total: 100_000n,
		}],
	});

	await runOnce({ db, ledger: l, client: t(6).client, walletFor, assets: ["BTC"] });
	assert.equal(depositsFor(db, "alice")[0]!.outcome, "credited");

	await runOnce({ db, ledger: l, client: t(0).client, walletFor, assets: ["BTC"] });
	assert.equal(depositsFor(db, "alice")[0]!.outcome, "credited", "still credited");
	assert.equal(bal(l, "alice", "BTC"), 100_000n, "and credited once");
});

test("AN UNATTRIBUTABLE DEPOSIT IS PARKED, NOT GUESSED AND NOT DROPPED", async () => {
	// Money at an address we did not issue is still money we hold. Ignoring it
	// leaves custody above the books — a surplus that masks a shortfall — and
	// guessing an owner credits the wrong person.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });

	const c = client({
		btc: [{
			id: "t9", txid: "tx9", coin: "btc", confirmations: 6, state: "confirmed",
			credits: [{ address: "someone-elses-address", amount: 500_000n }], total: 500_000n,
		}],
	});
	const r = await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["BTC"] });

	assert.equal(r.unattributed, 1);
	assert.equal(bal(l, "alice", "BTC"), 0n, "nobody was guessed at");
	assert.equal(bal(l, UNATTRIBUTED, "BTC"), 500_000n, "parked");
	// THE BOOKS STILL BALANCE, which is the point of parking rather than
	// ignoring: liabilities equal custody, so reconciliation stays exact.
	assert.equal(custody(l, "BTC"), 500_000n);
	assert.equal(l.liabilities("BTC"), custody(l, "BTC"));

	const flagged = unattributedDeposits(db);
	assert.equal(flagged.length, 1);
	assert.equal(flagged[0]!.address, "someone-elses-address");
	assert.equal(flagged[0]!.amount, "0.005");
});

test("THE SAME ADDRESS STRING ON TWO CHAINS IS NOT CONFUSED", async () => {
	// An Ethereum address is a valid BNB Chain address. An address-only lookup
	// would credit a BEP-20 deposit to whoever holds that string on Ethereum,
	// and the amounts would look entirely plausible.
	const { db, l, d } = setup();
	const shared = "0xabc0000000000000000000000000000000000001";
	d.provision({ userId: "eth-user", asset: "USDT", network: "ERC20", address: shared, source: "bitgo" });
	d.provision({ userId: "bsc-user", asset: "USDT", network: "BEP20", address: shared, source: "bitgo" });

	assert.equal(d.ownerOfAddress(shared, "USDT", "ERC20"), "eth-user");
	assert.equal(d.ownerOfAddress(shared, "USDT", "BEP20"), "bsc-user");

	const c = client({
		"bsc:usdt": [{
			id: "tb", txid: "txb", coin: "bsc:usdt", confirmations: 50, state: "confirmed",
			credits: [{ address: shared, amount: 25_000_000n }], total: 25_000_000n,
		}],
	});
	await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["USDT"] });

	assert.equal(bal(l, "bsc-user", "USDT"), 25_000_000n);
	assert.equal(bal(l, "eth-user", "USDT"), 0n, "the Ethereum holder got nothing");
	// Custody is credited on the CHAIN IT ARRIVED ON, not the bare asset.
	assert.equal(custody(l, "USDT.BEP20"), 25_000_000n);
	assert.equal(custody(l, "USDT.ERC20"), 0n);
});

test("a token deposit credits ONE fungible balance across chains", async () => {
	// To a customer, USDT is one balance. What is not fungible is the inventory
	// backing it, which stays per chain.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "USDT", network: "TRC20", address: "T-alice", source: "bitgo" });
	d.provision({ userId: "alice", asset: "USDT", network: "SOL", address: "S-alice", source: "bitgo" });

	const c = client({
		"trx:usdt": [{
			id: "t1", txid: "x1", coin: "trx:usdt", confirmations: 30, state: "confirmed",
			credits: [{ address: "T-alice", amount: 10_000_000n }], total: 10_000_000n,
		}],
		"sol:usdt": [{
			id: "t2", txid: "x2", coin: "sol:usdt", confirmations: 40, state: "confirmed",
			credits: [{ address: "S-alice", amount: 5_000_000n }], total: 5_000_000n,
		}],
	});
	await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["USDT"] });

	assert.equal(bal(l, "alice", "USDT"), 15_000_000n, "one balance");
	assert.equal(custody(l, "USDT.TRC20"), 10_000_000n);
	assert.equal(custody(l, "USDT.SOL"), 5_000_000n);
});

test("two credits in one transfer are attributed separately", async () => {
	// A batched send can pay several of our addresses at once.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });
	d.provision({ userId: "bob", asset: "BTC", network: undefined, address: "b1", source: "bitgo" });

	const c = client({
		btc: [{
			id: "tbatch", txid: "txb", coin: "btc", confirmations: 6, state: "confirmed",
			credits: [
				{ address: "a1", amount: 11_000n },
				{ address: "b1", amount: 22_000n },
			],
			total: 33_000n,
		}],
	});
	const r = await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["BTC"] });
	assert.equal(r.credited, 2);
	assert.equal(bal(l, "alice", "BTC"), 11_000n);
	assert.equal(bal(l, "bob", "BTC"), 22_000n);
	assert.equal(custody(l, "BTC"), 33_000n);
});

test("A FAILED OR REMOVED TRANSFER IS NOT A DEPOSIT", async () => {
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });
	for (const state of ["failed", "removed"]) {
		const c = client({
			btc: [{
				id: "t-" + state, txid: "x", coin: "btc", confirmations: 99, state,
				credits: [{ address: "a1", amount: 100_000n }], total: 100_000n,
			}],
		});
		await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["BTC"] });
	}
	assert.equal(bal(l, "alice", "BTC"), 0n);
});

test("A CUSTODIAN OUTAGE CREDITS NOTHING AND MARKS NOTHING", async () => {
	// An outage is not a deposit decision. The next poll tries again.
	const { db, l, d } = setup();
	d.provision({ userId: "alice", asset: "BTC", network: undefined, address: "a1", source: "bitgo" });
	const c = client({ btc: [] }, { fail: "btc" });
	const r = await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["BTC"] });

	assert.equal(r.credited, 0);
	assert.equal(r.errors.length, 1);
	assert.match(r.errors[0]!, /transfer feed unavailable/);
	assert.equal(depositsFor(db, "alice").length, 0, "nothing recorded either");
});

test("a transfer with no readable credits is reported, not silently skipped", async () => {
	const { db, l } = setup();
	const c = client({
		btc: [{
			id: "tbad", txid: "xbad", coin: "btc", confirmations: 6, state: "confirmed",
			credits: [], total: 100_000n,
		}],
	});
	const r = await runOnce({ db, ledger: l, client: c.client, walletFor, assets: ["BTC"] });
	assert.equal(r.unreadable, 1);
	assert.equal(r.credited, 0);
	const flagged = unattributedDeposits(db);
	assert.equal(flagged.length, 1);
	assert.match(String(flagged[0]!.transferId), /tbad/);
});

test("THE HEARTBEAT REPORTS WHAT THE PASS DID, errors included", async () => {
	// The preflight reads heartbeats rather than systemd state, because a unit
	// reports "active" while its loop is wedged. So what the beat SAYS matters:
	// a pass that completed but hit errors must not look like a clean one.
	//
	// (My first version of this test asserted the heartbeat is written "only
	// after a full pass" and checked the table was empty beforehand — which
	// failed on "no such table", and was overclaiming anyway: runOnce is built
	// not to throw, so the guarantee is about where the call sits, not about
	// surviving a crash. This tests the part that is actually observable.)
	const { db, l } = setup();

	await runOnce({ db, ledger: l, client: client({ btc: [] }).client, walletFor, assets: ["BTC"] });
	let row = db
		.prepare(`SELECT detail, cycles FROM runner_heartbeat WHERE runner = 'deposit-watcher'`)
		.get() as { detail: string; cycles: number };
	assert.equal(row.cycles, 1);
	assert.match(row.detail, /0 seen, 0 credited/);
	assert.doesNotMatch(row.detail, /error/);

	// A pass with a custodian outage still beats — it completed — but says so.
	await runOnce({
		db, ledger: l,
		client: client({ btc: [] }, { fail: "btc" }).client,
		walletFor, assets: ["BTC"],
	});
	row = db
		.prepare(`SELECT detail, cycles FROM runner_heartbeat WHERE runner = 'deposit-watcher'`)
		.get() as { detail: string; cycles: number };
	assert.equal(row.cycles, 2, "cycles accumulate");
	assert.match(row.detail, /1 error\(s\)/);
});

test("a listed asset with no wallet is skipped quietly, not errored every poll", async () => {
	// It is already a preflight failure; shouting about it on every cycle would
	// bury the errors that are actionable.
	const { db, l } = setup();
	const c = client({});
	const r = await runOnce({
		db, ledger: l, client: c.client,
		walletFor: async () => undefined,
		assets: ["BTC"],
	});
	assert.equal(r.errors.length, 0);
	assert.equal(r.scanned, 0);
});

// ------------------------------------------------------- confirmation policy

test("A TOKEN INHERITS THE CONFIRMATIONS OF THE CHAIN IT ARRIVED ON", () => {
	// USDT on Tron is not as final as USDT on Ethereum. A single per-token
	// number would be wrong for every chain but one.
	assert.equal(confirmationsFor("USDT", "TRC20"), confirmationsFor("TRX", undefined));
	assert.equal(confirmationsFor("USDT", "ERC20"), confirmationsFor("ETH", undefined));
	assert.equal(confirmationsFor("USDC", "BEP20"), confirmationsFor("BNB", undefined));
	assert.notEqual(confirmationsFor("USDT", "TRC20"), confirmationsFor("USDT", "ERC20"));
});

test("AN UNKNOWN CHAIN FAILS LONG, NOT SHORT", () => {
	// Zero would credit on sight. A newly listed chain nobody has set a
	// threshold for must wait, not go straight through.
	assert.equal(confirmationsFor("SOMECOIN", undefined), 64);
	assert.ok(confirmationsFor("SOMECOIN", undefined) > confirmationsFor("BTC", undefined));
});
