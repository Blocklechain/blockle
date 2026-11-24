// -----------------------------------------------------------------------------
// END TO END: a real withdrawal, with a real fee, through the real state machine.
//
// The unit tests prove each piece. This proves they compose — specifically that
// the money adds up at every step, which is the only claim that matters:
//
//     debited  ==  what goes on chain  +  what we keep
//
// and that a reversal returns ALL of it, fee included.
//
// It also pins the two things that only show up when the pieces are wired
// together: that a token withdrawal is refused when the gas float is empty even
// though the token inventory is plentiful, and that gas is debited from the GAS
// asset at settlement rather than from the asset being sent.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { parse } from "../src/amount";
import { LIVE_GAS_COSTS, type GasGateDeps } from "../src/gasgate";
import { GAS_PRICE_FLOOR, StaticRates } from "../src/gasrates";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";
import { fundGasFloat, revenue } from "../src/revenue";
import { LIVE_FEES, type GasPricing } from "../src/withdrawalfees";
import { State, Withdrawals, type AddressScreener, type Policy } from "../src/withdrawals";

const usdt = (s: string): bigint => parse(s, { symbol: "USDT", decimals: 6 });
const ONE_ETH = 1_000_000_000_000_000_000n;

const acct = (kind: AccountKind, owner: string, asset: string): AccountRef => ({
	kind,
	owner,
	asset,
});

const POLICY: Policy = {
	autoApprove: true,
	approvalThreshold: {},
	maxPerRequest: { USDT: usdt("100000") },
	velocityCap24h: { USDT: usdt("500000") },
	requireAllowlistedAddress: false,
};

const CLEAN: AddressScreener = {
	name: "test-screener",
	screen: async () => ({ allowed: true }),
};

const PRICING: GasPricing = { sources: [new StaticRates(GAS_PRICE_FLOOR)] };

function setup(opts: { withFloat: boolean }): {
	l: Ledger;
	w: Withdrawals;
	db: Database.Database;
} {
	const db = new Database(":memory:");
	const l = new Ledger(db);

	// A customer's USDT, held on Ethereum. Plenty of it.
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: acct(AccountKind.EXTERNAL, "", "USDT.ERC20"), delta: -usdt("10000") },
			{ account: acct(AccountKind.CUSTODY, "", "USDT.ERC20"), delta: usdt("10000") },
			{ account: acct(AccountKind.USER, "alice", "USDT"), delta: usdt("10000") },
			{ account: acct(AccountKind.EXTERNAL, "", "USDT.ERC20"), delta: -usdt("10000") },
		],
		idempotencyKey: "dep-1",
		actor: "deposit-watcher",
	});

	if (opts.withFloat) {
		fundGasFloat(l, {
			gasAsset: "ETH",
			amount: ONE_ETH,
			actor: "treasury@blockle.org",
			idempotencyKey: "float-1",
		});
	}

	let wd: Withdrawals;
	const gas: GasGateDeps = {
		ledger: l,
		pendingOnChain: (a, n) =>
			wd.pending().filter((x) => x.asset === a && (x.network ?? undefined) === n).length,
		table: LIVE_GAS_COSTS,
	};
	wd = new Withdrawals(db, l, POLICY, {
		feeTable: LIVE_FEES,
		pricing: PRICING,
		gas,
		requireGasGate: true,
	});
	return { l, w: wd, db };
}

test("E2E: the fee is withheld, the net goes out, and it all adds up", async () => {
	const { l, w } = setup({ withFloat: true });

	const req = w.request({
		userId: "alice",
		asset: "USDT",
		network: "ERC20",
		amount: usdt("500"),
		address: "0xdestination",
		idempotencyKey: "wd-1",
	});

	// THE IDENTITY THAT MATTERS.
	assert.equal(req.fee + req.net, req.amount, "net + fee == debited");
	assert.ok(req.fee > 0n, "a fee was actually charged");

	// The customer is down the GROSS.
	assert.equal(l.balance(acct(AccountKind.USER, "alice", "USDT")), usdt("9500"));
	// We owe the chain the NET.
	assert.equal(l.balance(acct(AccountKind.INFLIGHT, "", "USDT")), req.net);
	// And the fee is already ours.
	assert.equal(l.balance(acct(AccountKind.FEES, "", "USDT")), req.fee);

	// Settle it, with the chain having taken 0.002 ETH of gas.
	await w.screen(req.id, CLEAN);
	w.markSubmitted(req.id, "bitgo-xfer-1", "payout-runner");
	const gasBurned = 2_000_000_000_000_000n;
	const done = w.confirm(req.id, "bitgo-webhook", gasBurned);
	assert.equal(done.state, State.CONFIRMED);

	// INFLIGHT is clear; the custody inventory fell by the net, NOT the gross.
	assert.equal(l.balance(acct(AccountKind.INFLIGHT, "", "USDT")), 0n);
	assert.equal(
		l.balance(acct(AccountKind.CUSTODY, "", "USDT.ERC20")),
		usdt("10000") - req.net,
	);
	// The fee stayed with us.
	assert.equal(l.balance(acct(AccountKind.FEES, "", "USDT")), req.fee);

	// GAS CAME OUT OF ETH, not USDT. Booking it against USDT would invent a
	// USDT shortfall no on-chain event matches — and a shortfall halts
	// withdrawals.
	assert.equal(l.balance(acct(AccountKind.FEES, "", "ETH")), ONE_ETH - gasBurned);
	assert.equal(l.balance(acct(AccountKind.CUSTODY, "", "ETH")), ONE_ETH - gasBurned);
});

test("E2E: a reversal returns the fee as well", async () => {
	// Nothing was sent, so there was no gas to recover and no service to charge
	// for. Keeping the fee would be charging for a payment never received.
	const { l, w } = setup({ withFloat: true });
	const req = w.request({
		userId: "alice",
		asset: "USDT",
		network: "ERC20",
		amount: usdt("500"),
		address: "0xdestination",
		idempotencyKey: "wd-1",
	});
	w.reject(req.id, "ops", "customer asked us to cancel");

	assert.equal(
		l.balance(acct(AccountKind.USER, "alice", "USDT")),
		usdt("10000"),
		"whole and entire",
	);
	assert.equal(l.balance(acct(AccountKind.FEES, "", "USDT")), 0n, "fee given back");
	assert.equal(l.balance(acct(AccountKind.INFLIGHT, "", "USDT")), 0n);
});

test("E2E: WITH NO GAS FLOAT THE WITHDRAWAL IS REFUSED, not accepted and stuck", async () => {
	// 10,000 USDT sitting in Ethereum custody and no ETH to send it with. The
	// liquidity check passes; the gas gate is the only thing standing between
	// the customer and a debited balance for a transfer that cannot be built.
	const { l, w } = setup({ withFloat: false });
	assert.throws(
		() =>
			w.request({
				userId: "alice",
				asset: "USDT",
				network: "ERC20",
				amount: usdt("500"),
				address: "0xdestination",
				idempotencyKey: "wd-1",
			}),
		/sending the token costs ETH/,
	);
	// NOTHING HAPPENED. No debit, no row, no INFLIGHT.
	assert.equal(l.balance(acct(AccountKind.USER, "alice", "USDT")), usdt("10000"));
	assert.equal(l.balance(acct(AccountKind.INFLIGHT, "", "USDT")), 0n);
	assert.equal(w.pending().length, 0);
});

test("E2E: a burst cannot each pass the gas check alone", async () => {
	// Fund exactly enough for the floor plus two withdrawals.
	const db = new Database(":memory:");
	const l = new Ledger(db);
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: acct(AccountKind.EXTERNAL, "", "USDT.ERC20"), delta: -usdt("100000") },
			{ account: acct(AccountKind.CUSTODY, "", "USDT.ERC20"), delta: usdt("100000") },
			{ account: acct(AccountKind.USER, "alice", "USDT"), delta: usdt("100000") },
			{ account: acct(AccountKind.EXTERNAL, "", "USDT.ERC20"), delta: -usdt("100000") },
		],
		idempotencyKey: "dep-1",
		actor: "deposit-watcher",
	});
	const cost = LIVE_GAS_COSTS["USDT.ERC20"]!;
	fundGasFloat(l, {
		gasAsset: "ETH",
		amount: cost.floor + cost.perWithdrawal * 2n,
		actor: "treasury@blockle.org",
		idempotencyKey: "float-1",
	});

	let wd: Withdrawals;
	wd = new Withdrawals(db, l, POLICY, {
		feeTable: LIVE_FEES,
		pricing: PRICING,
		gas: {
			ledger: l,
			pendingOnChain: (a, n) =>
				wd.pending().filter((x) => x.asset === a && (x.network ?? undefined) === n).length,
			table: LIVE_GAS_COSTS,
		},
		requireGasGate: true,
	});

	const ask = (key: string): void => {
		wd.request({
			userId: "alice",
			asset: "USDT",
			network: "ERC20",
			amount: usdt("500"),
			address: "0xdestination",
			idempotencyKey: key,
		});
	};

	ask("a");
	ask("b");
	// The third is over the float: two are already queued and each will burn
	// gas before this one does.
	assert.throws(() => ask("c"), /already queued/);
	assert.equal(wd.pending().length, 2);
});

test("E2E: the withdrawal fee shows up in the profit report", async () => {
	const { l, w, db } = setup({ withFloat: true });
	const req = w.request({
		userId: "alice",
		asset: "USDT",
		network: "ERC20",
		amount: usdt("500"),
		address: "0xdestination",
		idempotencyKey: "wd-1",
	});
	await w.screen(req.id, CLEAN);
	w.markSubmitted(req.id, "ref", "payout-runner");
	w.confirm(req.id, "bitgo-webhook", 2_000_000_000_000_000n);

	const r = revenue(db, l);
	const u = r.assets.find((a) => a.asset === "USDT")!;
	assert.equal(u.withdrawalFees, req.fee);
	assert.equal(u.tradingFees, 0n);
	assert.equal(u.netProfit, req.fee, "no gas was spent in USDT");

	// And the ETH line carries the cost, as a loss against the float.
	const eth = r.assets.find((a) => a.asset === "ETH")!;
	assert.equal(eth.gasSpent, 2_000_000_000_000_000n);
	assert.ok(r.reconciles, r.warnings.join(" | "));

	// THE HONEST BIT: the USDT profit and the ETH cost do not net. Whether the
	// withdrawal made money is a question about two assets, which is exactly
	// why the report keeps them apart and the single total is an estimate.
	assert.notEqual(u.asset, eth.asset);
});
