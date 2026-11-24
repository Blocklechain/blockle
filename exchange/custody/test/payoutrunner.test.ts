// -----------------------------------------------------------------------------
// PAYOUT RUNNER TESTS.
//
// This is the only component in the service that can lose money outright, and
// the way it would is PAYING A CUSTOMER TWICE: send succeeds, the process dies
// before recording the reference, the next pass sees an approved withdrawal and
// sends again. The venue is then short the difference with no on-chain recourse.
//
// So the first three tests are that crash window, from all three sides: the
// pre-send check, a duplicate rejection from BitGo, and a failure to check at
// all. Then settlement, reversal, and every refusal path.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { BitGoPayouts } from "../src/bitgopayouts";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import { attemptsFor, runOnce, stuckPayouts } from "../src/payoutrunner";
import {
	State,
	Withdrawals,
	type AddressScreener,
	type Policy,
} from "../src/withdrawals";
import type { FeeTable } from "../src/withdrawalfees";

const POLICY: Policy = {
	autoApprove: true,
	approvalThreshold: {},
	maxPerRequest: { BTC: 10n ** 10n, USDT: 10n ** 12n },
	velocityCap24h: { BTC: 10n ** 11n, USDT: 10n ** 13n },
	requireAllowlistedAddress: false,
};

/** Zero-fee table: these tests are about the payout rail, not fee arithmetic. */
const FREE: FeeTable = {
	BTC: { gas: 0n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
	"USDT.ERC20": { gas: 0n, gasBufferBps: 0, margin: 0n, marginBps: 0, subsidised: true },
};

const CLEAN: AddressScreener = { name: "test", screen: async () => ({ allowed: true }) };

const acct = (kind: AccountKind, owner: string, asset: string): AccountRef => ({
	kind, owner, asset,
});

/** A payout client double. Records every call so sends can be counted. */
function client(opts: {
	existing?: Record<string, { id: string; txid: string }>;
	duplicateOnSend?: boolean;
	sendThrows?: string;
	findThrows?: string;
	transfers?: Record<string, { state: string; confirmations: number; fee: bigint }>;
	canSend?: boolean;
	noTransferId?: boolean;
} = {}) {
	const sends: { address: string; amount: bigint; sequenceId: string }[] = [];
	const existing = { ...(opts.existing ?? {}) };
	const c = {
		get canSend() { return opts.canSend !== false; },
		async findBySequenceId(a: { sequenceId: string }) {
			if (opts.findThrows) throw new Error(opts.findThrows);
			const e = existing[a.sequenceId];
			return e === undefined ? undefined : {
				id: e.id, txid: e.txid, state: "confirmed", confirmations: 99,
				feeBaseUnits: 0n, sequenceId: a.sequenceId,
			};
		},
		async send(a: { address: string; amount: bigint; sequenceId: string }) {
			if (opts.sendThrows) throw new Error(opts.sendThrows);
			sends.push({ address: a.address, amount: a.amount, sequenceId: a.sequenceId });
			if (opts.duplicateOnSend) {
				throw new Error("sequenceId already exists for this wallet (duplicate)");
			}
			if (opts.noTransferId) {
				throw new Error("BitGo accepted the send but returned no transfer id.");
			}
			const id = "xfer-" + a.sequenceId;
			existing[a.sequenceId] = { id, txid: "tx-" + a.sequenceId };
			return {
				transfer: {
					id, txid: "tx-" + a.sequenceId, state: "unconfirmed",
					confirmations: 0, feeBaseUnits: 0n, sequenceId: a.sequenceId,
				},
				alreadySent: false,
			};
		},
		async transfer(a: { transferId: string }) {
			const t = (opts.transfers ?? {})[a.transferId];
			if (t === undefined) {
				return {
					id: a.transferId, txid: "tx", state: "unconfirmed",
					confirmations: 0, feeBaseUnits: 0n, sequenceId: undefined,
				};
			}
			return {
				id: a.transferId, txid: "tx", state: t.state,
				confirmations: t.confirmations, feeBaseUnits: t.fee,
				sequenceId: undefined,
			};
		},
	};
	return { client: c as unknown as BitGoPayouts, sends, existing };
}

const walletFor = async (custodyId: string) =>
	({ BTC: { coin: "btc", walletId: "w-btc" },
	   "USDT.ERC20": { coin: "usdt", walletId: "w-usdt" } } as Record<
		string, { coin: string; walletId: string }>)[custodyId];

function setup(): { db: Database.Database; l: Ledger; w: Withdrawals } {
	const db = new Database(":memory:");
	const l = new Ledger(db);
	const w = new Withdrawals(db, l, POLICY, { feeTable: FREE });
	return { db, l, w };
}

function fund(l: Ledger, who: string, asset: string, amt: bigint, key: string): void {
	const custodyId = asset === "USDT" ? "USDT.ERC20" : asset;
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: acct(AccountKind.EXTERNAL, "", custodyId), delta: -amt },
			{ account: acct(AccountKind.CUSTODY, "", custodyId), delta: amt },
			{ account: acct(AccountKind.USER, who, asset), delta: amt },
			{ account: acct(AccountKind.EXTERNAL, "", custodyId), delta: -amt },
		],
		idempotencyKey: `dep:${key}`,
		actor: "test",
	});
}

/** An approved withdrawal, ready for the runner. */
async function approved(
	w: Withdrawals,
	l: Ledger,
	opts: { asset?: string; network?: string; amount?: bigint; key?: string } = {},
): Promise<number> {
	const asset = opts.asset ?? "BTC";
	const amount = opts.amount ?? 50_000_000n;
	const r = w.request({
		userId: "alice",
		asset,
		...(opts.network === undefined ? {} : { network: opts.network }),
		amount,
		address: "dest-address",
		idempotencyKey: opts.key ?? "k1",
	});
	await w.screen(r.id, CLEAN);
	assert.equal(w.get(r.id)?.state, State.APPROVED);
	void l;
	return r.id;
}

// ------------------------------------------------- the double-payment window

test("A WITHDRAWAL ALREADY SENT IS RECOVERED, NEVER SENT AGAIN", async () => {
	// The crash window: BitGo accepted the send, the process died before
	// markSubmitted. The next pass must find the existing transfer by its
	// deterministic sequence id instead of paying the customer twice.
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l);
	const seq = BitGoPayouts.sequenceId(id);

	const c = client({ existing: { [seq]: { id: "xfer-already", txid: "tx-already" } } });
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });

	assert.equal(r.sent, 0, "nothing was sent");
	assert.equal(r.recovered, 1);
	assert.equal(c.sends.length, 0, "the send was never attempted");
	assert.equal(w.get(id)?.state, State.SUBMITTED);
	assert.equal(w.get(id)?.providerRef, "xfer-already", "the reference was recovered");
});

test("A DUPLICATE REJECTION IS TREATED AS ALREADY-SENT, not as an error", async () => {
	// BitGo's own guard firing. Reporting it as a failure would leave the
	// withdrawal approved and invite the next pass to try again.
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l);
	const seq = BitGoPayouts.sequenceId(id);

	// Pre-check finds nothing, the send is rejected as a duplicate, and the
	// recovery lookup inside `send` finds it. Modelled by the real client's
	// contract: alreadySent true.
	const c = client();
	const spy = {
		...c.client,
		canSend: true,
		async findBySequenceId() { return undefined; },
		async send() {
			return {
				transfer: {
					id: "xfer-dup", txid: "tx-dup", state: "unconfirmed",
					confirmations: 0, feeBaseUnits: 0n, sequenceId: seq,
				},
				alreadySent: true,
			};
		},
		async transfer() {
			return { id: "x", txid: "t", state: "unconfirmed", confirmations: 0,
				feeBaseUnits: 0n, sequenceId: undefined };
		},
	} as unknown as BitGoPayouts;

	const r = await runOnce({ db, ledger: l, withdrawals: w, client: spy, walletFor });
	assert.equal(r.recovered, 1);
	assert.equal(r.sent, 0);
	assert.equal(w.get(id)?.providerRef, "xfer-dup");
});

test("IF WE CANNOT CHECK, WE DO NOT SEND", async () => {
	// "I could not ask whether this was already sent" must never resolve to
	// "send it". This is the single most expensive wrong answer in the file.
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l);

	const c = client({ findThrows: "BitGo 503" });
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });

	assert.equal(c.sends.length, 0, "NOTHING was sent");
	assert.equal(r.sent, 0);
	assert.equal(w.get(id)?.state, State.APPROVED, "left where it was");
	assert.ok(r.errors.some((e) => /rule out a double payment/.test(e)));
	assert.equal(attemptsFor(db, id)[0]!.outcome, "error");
});

test("the sequence id is derived from the withdrawal, not random", () => {
	// A random id per attempt would make every retry a fresh send, which is
	// precisely the bug the guard exists to prevent.
	assert.equal(BitGoPayouts.sequenceId(42), "blockle-wd-42");
	assert.equal(BitGoPayouts.sequenceId(42), BitGoPayouts.sequenceId(42));
	assert.notEqual(BitGoPayouts.sequenceId(42), BitGoPayouts.sequenceId(43));
});

// --------------------------------------------------------------- the happy path

test("an approved withdrawal is sent, then settled once deep enough", async () => {
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l, { amount: 50_000_000n });

	// Pass one: sent.
	const c1 = client();
	const r1 = await runOnce({ db, ledger: l, withdrawals: w, client: c1.client, walletFor });
	assert.equal(r1.sent, 1);
	assert.equal(c1.sends.length, 1);
	// THE NET LEAVES, not the gross. (The fee is zero in this table, so they
	// coincide here; the assertion is that `net` is what is passed.)
	assert.equal(c1.sends[0]!.amount, w.get(id)!.net);
	assert.equal(w.get(id)?.state, State.SUBMITTED);

	const ref = w.get(id)!.providerRef!;

	// Pass two: not deep enough yet.
	const shallow = client({ transfers: { [ref]: { state: "confirmed", confirmations: 1, fee: 0n } } });
	const r2 = await runOnce({ db, ledger: l, withdrawals: w, client: shallow.client, walletFor });
	assert.equal(r2.waiting, 1);
	assert.equal(r2.settled, 0);
	assert.equal(w.get(id)?.state, State.SUBMITTED, "still in flight");

	// Pass three: deep enough.
	const deep = client({ transfers: { [ref]: { state: "confirmed", confirmations: 6, fee: 0n } } });
	const r3 = await runOnce({ db, ledger: l, withdrawals: w, client: deep.client, walletFor });
	assert.equal(r3.settled, 1);
	assert.equal(w.get(id)?.state, State.CONFIRMED);
	// INFLIGHT is clear and custody fell by the net.
	assert.equal(l.balance(acct(AccountKind.INFLIGHT, "", "BTC")), 0n);
	assert.equal(l.balance(acct(AccountKind.CUSTODY, "", "BTC")), 50_000_000n);
});

test("THE GAS FEE IS BOOKED IN THE GAS ASSET, not the token", async () => {
	// An ERC-20 payout burns ETH. Charging it to USDT would invent a USDT
	// shortfall no on-chain event matches — and a shortfall halts that asset.
	const { db, l, w } = setup();
	fund(l, "alice", "USDT", 1_000_000_000n, "u");
	// The venue's own ETH, so the fee has a float to come out of.
	l.post({
		reason: Reason.TREASURY_FUNDING,
		postings: [
			{ account: acct(AccountKind.EXTERNAL, "", "ETH"), delta: -(10n ** 18n) },
			{ account: acct(AccountKind.CUSTODY, "", "ETH"), delta: 10n ** 18n },
			{ account: acct(AccountKind.FEES, "", "ETH"), delta: 10n ** 18n },
			{ account: acct(AccountKind.EXTERNAL, "", "ETH"), delta: -(10n ** 18n) },
		],
		idempotencyKey: "float",
		actor: "treasury",
	});

	const id = await approved(w, l, {
		asset: "USDT", network: "ERC20", amount: 100_000_000n, key: "u1",
	});
	const c = client();
	await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });
	const ref = w.get(id)!.providerRef!;

	const gas = 2_000_000_000_000_000n; // 0.002 ETH
	const deep = client({ transfers: { [ref]: { state: "confirmed", confirmations: 40, fee: gas } } });
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: deep.client, walletFor });

	assert.equal(r.settled, 1);
	assert.equal(l.balance(acct(AccountKind.FEES, "", "ETH")), (10n ** 18n) - gas,
		"the ETH float paid the gas");
	assert.equal(l.balance(acct(AccountKind.CUSTODY, "", "ETH")), (10n ** 18n) - gas);
	// And USDT custody fell by the payout only, not by the gas.
	assert.equal(
		l.balance(acct(AccountKind.CUSTODY, "", "USDT.ERC20")),
		1_000_000_000n - 100_000_000n,
	);
});

// ------------------------------------------------------------------ reversals

test("THE CUSTODIAN'S OWN FAILURE REVERSES THE DEBIT", async () => {
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l, { amount: 50_000_000n });
	const c = client();
	await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });
	const ref = w.get(id)!.providerRef!;

	const dead = client({ transfers: { [ref]: { state: "failed", confirmations: 0, fee: 0n } } });
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: dead.client, walletFor });

	assert.equal(r.failed, 1);
	assert.equal(w.get(id)?.state, State.FAILED);
	// The customer is whole again.
	assert.equal(l.balance(acct(AccountKind.USER, "alice", "BTC")), 100_000_000n);
	assert.equal(l.balance(acct(AccountKind.INFLIGHT, "", "BTC")), 0n);
});

test("A TIMEOUT IS NOT A FAILURE — nothing is reversed", async () => {
	// A reversal on a guess refunds a customer who may also be paid on chain.
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l, { amount: 50_000_000n });
	const c = client();
	await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });

	const broken = {
		...c.client,
		canSend: true,
		async transfer() { throw new Error("ETIMEDOUT"); },
	} as unknown as BitGoPayouts;
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: broken, walletFor });

	assert.equal(r.failed, 0, "nothing reversed");
	assert.equal(r.settled, 0);
	assert.equal(w.get(id)?.state, State.SUBMITTED, "still in flight, correctly");
	assert.ok(r.errors.some((e) => /cannot read transfer/.test(e)));
});

// ------------------------------------------------------------------- refusals

test("NO PASSPHRASE IS A LOUD REFUSAL, not a quiet idle pass", async () => {
	// Balances are already debited and sitting in INFLIGHT. A runner that
	// shrugged and reported success would leave customers stranded while every
	// dashboard looked green.
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l);

	const c = client({ canSend: false });
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });

	assert.equal(r.refused, 1);
	assert.equal(r.sent, 0);
	assert.ok(r.errors.some((e) => /BITGO_WALLET_PASSPHRASE/.test(e)));
	assert.ok(r.errors.some((e) => /debited and waiting/.test(e)));
	assert.equal(w.get(id)?.state, State.APPROVED);
	// AND THE HEARTBEAT SAYS SO, so the preflight does not read it as healthy.
	const hb = db
		.prepare(`SELECT detail FROM runner_heartbeat WHERE runner = 'payout-runner'`)
		.get() as { detail: string };
	assert.match(hb.detail, /^REFUSED/);
	// It is surfaced for an operator rather than only logged.
	assert.equal(stuckPayouts(db).length, 1);
});

test("a missing wallet is reported, and the customer is not left silently", async () => {
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	await approved(w, l);
	const c = client();
	const r = await runOnce({
		db, ledger: l, withdrawals: w, client: c.client,
		walletFor: async () => undefined,
	});
	assert.equal(r.sent, 0);
	assert.ok(r.errors.some((e) => /no exchange wallet/.test(e)));
	assert.ok(r.errors.some((e) => /debited and waiting/.test(e)));
});

test("a send failure leaves the withdrawal approved for the next pass", async () => {
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l);
	const c = client({ sendThrows: "BitGo 500" });
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });

	assert.equal(r.sent, 0);
	assert.equal(w.get(id)?.state, State.APPROVED, "retryable, and safely so");
	assert.ok(r.errors.some((e) => /send failed/.test(e)));
});

test("A SETTLEMENT THAT WILL NOT POST IS REPORTED AS SENT-BUT-UNSETTLED", async () => {
	// The coins have left and the books still hold them. An operator must never
	// discover this from a customer.
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l, { amount: 50_000_000n });
	const c = client();
	await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });
	const ref = w.get(id)!.providerRef!;

	// A fee larger than the venue's (nonexistent) BTC float makes `confirm`
	// refuse, since internal accounts cannot go negative.
	const deep = client({
		transfers: { [ref]: { state: "confirmed", confirmations: 6, fee: 10n ** 9n } },
	});
	const r = await runOnce({ db, ledger: l, withdrawals: w, client: deep.client, walletFor });

	assert.equal(r.settled, 0);
	assert.ok(r.errors.some((e) => /SENT BUT NOT SETTLED/.test(e)));
	assert.ok(r.errors.some((e) => /reconciliation will show the gap/.test(e)));
	assert.equal(w.get(id)?.state, State.SUBMITTED);
});

test("one pass is capped so a backlog cannot starve other chains", async () => {
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 10n ** 10n, "a");
	for (let i = 0; i < 5; i++) {
		await approved(w, l, { amount: 1_000_000n, key: "k" + i });
	}
	const c = client();
	const r = await runOnce({
		db, ledger: l, withdrawals: w, client: c.client, walletFor, maxPerPass: 2,
	});
	assert.equal(r.sent, 2);
	assert.equal(c.sends.length, 2);
});

test("the attempt history is kept, which is what support actually needs", async () => {
	const { db, l, w } = setup();
	fund(l, "alice", "BTC", 100_000_000n, "a");
	const id = await approved(w, l, { amount: 50_000_000n });
	const c = client();
	await runOnce({ db, ledger: l, withdrawals: w, client: c.client, walletFor });
	const ref = w.get(id)!.providerRef!;
	const deep = client({ transfers: { [ref]: { state: "confirmed", confirmations: 6, fee: 0n } } });
	await runOnce({ db, ledger: l, withdrawals: w, client: deep.client, walletFor });

	const history = attemptsFor(db, id);
	assert.ok(history.length >= 2);
	assert.equal(history[0]!.outcome, "sent");
	assert.equal(history[history.length - 1]!.outcome, "settled");
	assert.ok(history.every((h) => h.at !== ""));
	// A settled payout is no longer "stuck".
	assert.equal(stuckPayouts(db).length, 0);
});
