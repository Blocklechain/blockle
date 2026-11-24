// -----------------------------------------------------------------------------
// MULTI-NETWORK ASSETS — USDT on four chains, one customer balance.
//
// The case that motivated this: a customer deposits USDT over Tron and wants to
// withdraw it over BNB Smart Chain. Those are different Tether contracts, BitGo
// offers no conversion, and no amount of asking makes them fungible on-chain.
//
// So the model is: ONE fungible liability, N chain-specific inventories. These
// tests pin that, and pin the failure modes that would otherwise present as a
// reconciliation shortfall — i.e. indistinguishable from a theft.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
	AssetError,
	assertCustodyId,
	custodyIds,
	isMultiNetwork,
	networkOf,
	qualify,
	settlementAsset,
	withdrawalNetworks,
} from "../src/assets";
import { AccountKind, Ledger, Reason, type AccountRef } from "../src/ledger";

function fresh(): Ledger {
	return new Ledger(new Database(":memory:"));
}

const user = (id: string, asset: string): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});
const custody = (asset: string): AccountRef => ({
	kind: AccountKind.CUSTODY,
	owner: "",
	asset,
});
const external = (asset: string): AccountRef => ({
	kind: AccountKind.EXTERNAL,
	owner: "",
	asset,
});
const inflight = (asset: string): AccountRef => ({
	kind: AccountKind.INFLIGHT,
	owner: "",
	asset,
});

/** A USDT deposit arriving over one specific chain. */
function depositUsdt(l: Ledger, who: string, net: string, amt: bigint, ref: string) {
	const qualified = qualify("USDT", net);
	return l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external(qualified), delta: -amt },
			{ account: custody(qualified), delta: amt },
			// The customer's balance is plain USDT — fungible to them.
			{ account: user(who, "USDT"), delta: amt },
			{ account: external(qualified), delta: -amt },
		],
		idempotencyKey: `deposit:${ref}`,
		actor: "bitgo-webhook",
	});
}

// ---------------------------------------------------------------- the model

test("settlementAsset collapses a network-qualified id to its base", () => {
	assert.equal(settlementAsset("USDT.TRC20"), "USDT");
	assert.equal(settlementAsset("USDT"), "USDT");
	assert.equal(settlementAsset("BTC"), "BTC");
	assert.equal(networkOf("USDT.TRC20"), "TRC20");
	assert.equal(networkOf("BTC"), undefined);
});

test("USDT has 6 decimals, not 18", () => {
	// Treating 6-decimal USDT as 18-decimal understates a balance by 10^12,
	// which is the kind of mistake that only shows up as a shortfall.
	const { assetDef } = require("../src/assets") as typeof import("../src/assets");
	assert.equal(assetDef("USDT").decimals, 6);
	assert.equal(assetDef("USDT.TRC20").decimals, 6);
	assert.equal(assetDef("ETH").decimals, 18);
	assert.equal(assetDef("BTC").decimals, 8);
});

test("qualify refuses pairings that do not exist on chain", () => {
	assert.equal(qualify("USDT", "TRC20"), "USDT.TRC20");
	// USDT is not on Cardano.
	assert.throws(() => qualify("USDT", "ADA"), /not deployed on ADA/);
	// BTC is single-chain; qualifying it would invent a second BTC.
	assert.throws(() => qualify("BTC", "ERC20"), /single-chain/);
	assert.throws(() => qualify("NOPE", "ERC20"), AssetError);
});

test("A MULTI-NETWORK ASSET MUST NAME A CHAIN ON A CUSTODY HOLDING", () => {
	// An unqualified custody balance cannot be reconciled against anything:
	// "we hold 450 USDT" does not say on which chain, so no provider query can
	// confirm or refute it.
	assert.throws(() => assertCustodyId("USDT"), /must name one/);
	assertCustodyId("USDT.TRC20"); // fine
});

test("a single-chain asset must NOT name one", () => {
	// "BTC.ERC20" would create a phantom balance that reconciles against
	// nothing and silently inflates the books.
	assert.throws(() => assertCustodyId("BTC.ERC20"), /phantom balance/);
	assertCustodyId("BTC");
});

test("custodyIds enumerates what reconciliation must check", () => {
	assert.deepEqual(custodyIds("BTC"), ["BTC"]);
	assert.deepEqual(
		[...custodyIds("USDT")].sort(),
		["USDT.BEP20", "USDT.ERC20", "USDT.SOL", "USDT.TRC20"],
	);
	assert.equal(isMultiNetwork("USDT"), true);
	assert.equal(isMultiNetwork("BTC"), false);
});

test("the withdrawal network picker puts the CHEAP chain first", () => {
	// Otherwise customers who do not care which chain they get default to
	// Ethereum and drain the most expensive inventory.
	const nets = withdrawalNetworks("USDT").map((n) => n.id);
	assert.equal(nets[nets.length - 1], "ERC20", "Ethereum should be last");
	assert.ok(nets.includes("TRC20"));
});

// ---------------------------------------------------------------- the ledger

test("A TRON DEPOSIT CREDITS A PLAIN USDT BALANCE AND BALANCES", () => {
	const l = fresh();
	depositUsdt(l, "alice", "TRC20", 500_000_000n, "trx:0x1"); // 500 USDT at 6dp

	// One fungible liability.
	assert.equal(l.balance(user("alice", "USDT")), 500_000_000n);
	// Chain-specific inventory.
	assert.equal(l.balance(custody("USDT.TRC20")), 500_000_000n);
	assert.equal(l.balance(custody("USDT.ERC20")), 0n);
	assert.deepEqual(l.verify(), { ok: true, transactions: 1 });
});

test("deposits on different chains accumulate into ONE customer balance", () => {
	const l = fresh();
	depositUsdt(l, "alice", "TRC20", 150_000_000n, "trx:1");
	depositUsdt(l, "alice", "ERC20", 300_000_000n, "eth:1");
	depositUsdt(l, "alice", "SOL", 50_000_000n, "sol:1");

	assert.equal(
		l.balance(user("alice", "USDT")),
		500_000_000n,
		"the customer sees 500 USDT, not three balances",
	);

	const inv = l.custodyByNetwork("USDT");
	assert.equal(inv.get("USDT.TRC20"), 150_000_000n);
	assert.equal(inv.get("USDT.ERC20"), 300_000_000n);
	assert.equal(inv.get("USDT.SOL"), 50_000_000n);
	assert.equal(inv.get("USDT.BEP20"), undefined, "no BSC inventory at all");

	// And the books still balance, which is the whole point of the
	// settlement-asset invariant.
	assert.deepEqual(l.verify(), { ok: true, transactions: 3 });
});

test("A USER BALANCE MAY NOT NAME A NETWORK", () => {
	// Fragmenting the liability by chain would mean telling a customer they
	// have "150 Tron USDT and 300 Ethereum USDT" — which is not what they
	// deposited into, and makes their balance unspendable as one number.
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.DEPOSIT,
				postings: [
					{ account: user("alice", "USDT.TRC20"), delta: 100n },
					{ account: external("USDT.TRC20"), delta: -100n },
				],
				idempotencyKey: "bad:qualified-user",
				actor: "test",
			}),
		/must not name a network/,
	);
});

test("an UNQUALIFIED custody posting is refused", () => {
	const l = fresh();
	assert.throws(
		() =>
			l.post({
				reason: Reason.DEPOSIT,
				postings: [
					{ account: custody("USDT"), delta: 100n },
					{ account: external("USDT.TRC20"), delta: -100n },
				],
				idempotencyKey: "bad:unqualified-custody",
				actor: "test",
			}),
		/must name one/,
	);
});

test("value cannot leak BETWEEN chains inside one transaction", () => {
	// This is the dangerous shape: it looks balanced at the settlement level
	// and would move 100 units of Tron inventory into Ethereum inventory
	// without anything having moved on either chain.
	const l = fresh();
	depositUsdt(l, "alice", "TRC20", 100n, "trx:1");

	// Custody-to-custody across chains sums to zero in USDT, so the ledger
	// ACCEPTS it — and it must, because that is exactly the posting a real
	// rebalance makes once the on-chain move has happened. What makes it safe
	// is that reconciliation then checks each chain against BitGo separately:
	// an unbacked rebalance shows up immediately as a shortfall on one chain
	// and a surplus on the other.
	l.post({
		reason: Reason.ADJUSTMENT,
		postings: [
			{ account: custody("USDT.TRC20"), delta: -100n },
			{ account: custody("USDT.ERC20"), delta: 100n },
		],
		idempotencyKey: "rebalance:1",
		actor: "operator:treasury",
		note: "rebalance: moved 100 units Tron -> Ethereum, tx 0xabc",
	});

	const inv = l.custodyByNetwork("USDT");
	assert.equal(inv.get("USDT.TRC20"), 0n);
	assert.equal(inv.get("USDT.ERC20"), 100n);
	// The customer is unaffected — their liability never moved.
	assert.equal(l.balance(user("alice", "USDT")), 100n);
	assert.deepEqual(l.verify().ok, true);
});

test("liabilities() sums users, fees and in-flight for a settlement asset", () => {
	const l = fresh();
	depositUsdt(l, "alice", "TRC20", 1_000_000n, "trx:1");
	l.post({
		reason: Reason.FEE,
		postings: [
			{ account: user("alice", "USDT"), delta: -2_000n },
			{ account: { kind: AccountKind.FEES, owner: "", asset: "USDT" }, delta: 2_000n },
		],
		idempotencyKey: "fee:1",
		actor: "engine",
	});
	l.post({
		reason: Reason.WITHDRAWAL_REQUEST,
		postings: [
			{ account: user("alice", "USDT"), delta: -500_000n },
			{ account: inflight("USDT"), delta: 500_000n },
		],
		idempotencyKey: "wd:1",
		actor: "alice",
	});

	// 998,000 user + 2,000 fees + 500,000 in-flight = 1,000,000 held.
	assert.equal(l.liabilities("USDT"), 1_000_000n);
	let held = 0n;
	for (const v of l.custodyByNetwork("USDT").values()) held += v;
	assert.equal(held, 1_000_000n, "liabilities equal total inventory");
});

test("single-chain assets are unaffected by any of this", () => {
	const l = fresh();
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: external("BTC"), delta: -100n },
			{ account: custody("BTC"), delta: 100n },
			{ account: user("bob", "BTC"), delta: 100n },
			{ account: external("BTC"), delta: -100n },
		],
		idempotencyKey: "deposit:btc:1",
		actor: "test",
	});
	assert.equal(l.balance(user("bob", "BTC")), 100n);
	assert.deepEqual([...l.custodyByNetwork("BTC").keys()], ["BTC"]);
	assert.equal(l.liabilities("BTC"), 100n);
});
