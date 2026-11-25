// -----------------------------------------------------------------------------
// CUSTODY ROUTING TESTS.
//
// One rule, tested from several directions: AN ASSET WITH NO CUSTODIAN IS
// UNKNOWN, NEVER ZERO.
//
// Zero is the dangerous answer. Against real liabilities it reads as a
// shortfall and halts the asset; against none it reads as perfect balance and
// creates the impression that a coin is custodied when nothing is watching it.
// The reconciler already has a word for "I could not find out" — UNAVAILABLE —
// and every path here has to reach it rather than inventing a number.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChainAdapter, ChainCapabilities } from "../src/chains";
import { LISTED } from "../src/listed";
import {
	defaultCustodianOf,
	nodeAdapters,
	nodeDepositAddress,
	routedHoldings,
} from "../src/custodyrouting";
import type { HoldingsSource } from "../src/reconcile";

const CAPS: ChainCapabilities = {
	reachable: true,
	synced: true,
	height: 100,
	decimals: 8,
	canDeriveAddresses: true,
	canSend: true,
	notes: [],
};

function fakeAdapter(symbol: string, over: Partial<{
	caps: Partial<ChainCapabilities>;
	balance: bigint | Error;
	address: string | Error;
}> = {}): ChainAdapter {
	return {
		symbol,
		route: "bitcoin-rpc",
		probe: async () => ({ ...CAPS, ...over.caps }),
		balance: async () => {
			if (over.balance instanceof Error) throw over.balance;
			return over.balance ?? 42n;
		},
		newAddress: async () => {
			if (over.address instanceof Error) throw over.address;
			return over.address ?? `${symbol}-addr-1`;
		},
		incoming: async () => [],
		send: async () => ({ txid: "tx" }),
	};
}

const bitgoStub = (answers: Record<string, bigint | Error>): HoldingsSource => ({
	name: "bitgo:prod",
	holdings: async (asset) => {
		const v = answers[asset];
		if (v === undefined) throw new Error(`bitgo asked for unknown ${asset}`);
		if (v instanceof Error) throw v;
		return v;
	},
});

// --------------------------------------------------------------- the rule

test("AN ASSET WITH NO CUSTODIAN IS UNKNOWN, NOT ZERO", async () => {
	const src = routedHoldings({ bitgo: bitgoStub({}), nodes: new Map() });
	await assert.rejects(() => src.holdings("RTM"), (e: unknown) => {
		assert.match(String(e), /no custodian configured/);
		// The reasoning is in the message because the next person to see it
		// will be tempted to make it return 0 and move on.
		assert.match(String(e), /indistinguishable from 'the coins are gone'/);
		return true;
	});
});

test("a BitGo asset with no BitGo client is unknown, not zero", async () => {
	const src = routedHoldings({ nodes: new Map() });
	await assert.rejects(() => src.holdings("BTC"), (e: unknown) => {
		assert.match(String(e), /no BitGo client is configured/);
		assert.match(String(e), /would read as a shortfall/);
		return true;
	});
});

test("AN UNSYNCED NODE IS UNKNOWN, because its balance is understated", async () => {
	// A syncing daemon reports the balance as of the block it reached. That is
	// lower than the truth and indistinguishable from coins having left.
	const nodes = new Map([["RTM", fakeAdapter("RTM", {
		caps: { synced: false, notes: ["at block 900 of 1000 headers"] },
		balance: 1n, // would be believed if sync were not checked
	})]]);
	const src = routedHoldings({ nodes });
	await assert.rejects(() => src.holdings("RTM"), (e: unknown) => {
		assert.match(String(e), /not synced/);
		assert.match(String(e), /at block 900 of 1000 headers/);
		return true;
	});
});

test("an unreachable node is unknown and names what it said", async () => {
	const nodes = new Map([["RTM", fakeAdapter("RTM", {
		caps: { reachable: false, notes: ["ECONNREFUSED"] },
	})]]);
	await assert.rejects(
		() => routedHoldings({ nodes }).holdings("RTM"),
		/did not answer \(ECONNREFUSED\)/,
	);
});

// ------------------------------------------------------------------ routing

test("each asset reaches exactly its own custodian", async () => {
	const nodes = new Map([["RTM", fakeAdapter("RTM", { balance: 777n })]]);
	const src = routedHoldings({
		bitgo: bitgoStub({ BTC: 500n, "USDT.TRC20": 100n }),
		nodes,
	});
	assert.equal(await src.holdings("BTC"), 500n);
	assert.equal(await src.holdings("RTM"), 777n);
	// A network-qualified id settles to one coin and goes to that coin's
	// custodian, with the qualified id passed through — BitGo holds USDT per
	// chain, so the chain has to survive the routing.
	assert.equal(await src.holdings("USDT.TRC20"), 100n);
});

test("A LISTED COIN WITH NO NODE DOES NOT FALL BACK TO BITGO", async () => {
	// BitGo does not hold Raptoreum. Asking it would return zero or an error
	// for the wrong reason; either way the answer would be about the wrong
	// custodian.
	let asked = false;
	const bitgo: HoldingsSource = {
		name: "bitgo:prod",
		holdings: async () => { asked = true; return 0n; },
	};
	await assert.rejects(
		() => routedHoldings({ bitgo, nodes: new Map() }).holdings("RTM"),
		/no custodian/,
	);
	assert.equal(asked, false, "BitGo must not be asked about a coin it cannot hold");
});

test("an asset outside the listing registry is BitGo's", () => {
	// BTC, ETH and the stablecoins are not in the registry and never will be.
	const of = defaultCustodianOf(new Map());
	assert.equal(of("BTC"), "bitgo");
	assert.equal(of("USDT.ERC20"), "bitgo");
	assert.equal(of("RTM"), "none", "listed, node route, no node configured");
	assert.equal(of("BLOCK"), "none");
});

test("a configured node wins over the registry's default", () => {
	const of = defaultCustodianOf(new Map([["RTM", fakeAdapter("RTM")]]));
	assert.equal(of("RTM"), "node");
});

test("the source name says where the money actually is", () => {
	// A report labelled "bitgo" while half its figures came from our own
	// daemons would misdescribe the custody model.
	const nodes = new Map([["RTM", fakeAdapter("RTM")], ["PEP", fakeAdapter("PEP")]]);
	assert.equal(
		routedHoldings({ bitgo: bitgoStub({}), nodes }).name,
		"bitgo:prod+nodes(RTM,PEP)",
	);
	assert.equal(routedHoldings({ nodes: new Map() }).name, "no-custodian");
	assert.equal(routedHoldings({ bitgo: bitgoStub({}), nodes: new Map() }).name, "bitgo:prod");
});

test("a node that throws on balance propagates rather than reporting zero", async () => {
	const nodes = new Map([["RTM", fakeAdapter("RTM", { balance: new Error("wallet locked") })]]);
	await assert.rejects(() => routedHoldings({ nodes }).holdings("RTM"), /wallet locked/);
});

// ----------------------------------------------------------------- adapters

test("NOTHING CONFIGURED IS A SKIP, NOT A FAILURE", () => {
	// The normal state of a planned listing. A dozen of them must not look
	// like a dozen errors.
	const skips: string[] = [];
	const map = nodeAdapters({ env: {}, onSkip: (s, why) => skips.push(`${s}:${why}`) });
	assert.equal(map.size, 0);
	assert.ok(skips.every((s) => s.endsWith(":no node configured")), skips.join(" "));
	assert.ok(skips.length >= 10);
});

test("ONE COIN'S BAD CONFIGURATION DOES NOT TAKE DOWN THE OTHERS", async () => {
	// Throwing here would stop the whole process over one environment typo,
	// while eleven other coins were fine. The broken one becomes unknown.
	//
	// THE UNCONFIRMED COIN IS FOUND, NOT NAMED. This test used to hardcode RTM
	// as its example, and then RTM's decimals were measured against its own
	// daemon and the test failed — reporting a regression in error handling
	// when what had actually happened was a coin getting fixed. Every coin here
	// is on a path to having its decimals confirmed, so any specific name is a
	// time bomb. Picking one off the registry keeps the assertion about the
	// BEHAVIOUR, which is not supposed to change, and lets the data move.
	const unconfirmed = LISTED.find(
		(c) => c.custody !== "bitgo" && c.symbol !== "BLOCK" && c.decimals === undefined,
	);
	assert.ok(
		unconfirmed !== undefined,
		"every listed coin now has confirmed decimals — to keep covering this " +
			"path, point it at a fixture coin instead of a real one",
	);

	const skips: string[] = [];
	const map = nodeAdapters({
		env: {
			// PERBUG has confirmed decimals, so this one builds.
			CHAIN_PERBUG_URL: "http://127.0.0.1:1",
			// This one's decimals are unconfirmed in the registry, so the
			// factory refuses — correctly, since a guessed scale misprices
			// every balance on that chain.
			[`CHAIN_${unconfirmed.symbol}_URL`]: "http://127.0.0.1:2",
		},
		onSkip: (s, why) => skips.push(`${s}: ${why}`),
	});
	assert.ok(map.has("PERBUG"), "the well-configured coin is present");
	assert.ok(!map.has(unconfirmed.symbol));
	assert.ok(
		skips.some((s) => new RegExp(`^${unconfirmed.symbol}: .*decimals are unconfirmed`).test(s)),
		skips.join("\n"),
	);

	// And the refused one is UNKNOWN downstream, not zero.
	await assert.rejects(
		() => routedHoldings({ nodes: map }).holdings(unconfirmed.symbol),
		/no custodian configured/,
	);
});

test("BitGo-custodied coins are never given a node adapter", () => {
	// Even if someone sets CHAIN_BTC_URL, BTC is BitGo's.
	const map = nodeAdapters({ env: { CHAIN_BTC_URL: "http://127.0.0.1:1" } });
	assert.equal(map.has("BTC"), false);
});

// ---------------------------------------------------------------- addresses

test("a node deposit address comes from the chain, labelled with the owner", async () => {
	let seenLabel = "";
	const adapter: ChainAdapter = {
		...fakeAdapter("RTM"),
		newAddress: async (label: string) => { seenLabel = label; return "  RTMaddr1  "; },
	};
	const r = await nodeDepositAddress({ adapter, userId: "acct_42" });
	assert.equal(r.address, "RTMaddr1", "trimmed");
	// The owner is in the label so an operator looking at the daemon's own
	// wallet can see whose address it is — which matters exactly when our
	// database is the thing under investigation.
	assert.equal(seenLabel, "blockle-ex:acct_42");
	assert.equal(r.source, "bitcoin-rpc:RTM");
});

test("AN EMPTY ADDRESS IS REFUSED rather than handed to a customer", async () => {
	// A deposit to "" cannot be credited to anyone.
	await assert.rejects(
		() => nodeDepositAddress({ adapter: fakeAdapter("RTM", { address: "   " }), userId: "a" }),
		/Refusing to hand that to a customer/,
	);
});

test("a node that cannot issue addresses surfaces its own error", async () => {
	await assert.rejects(
		() => nodeDepositAddress({
			adapter: fakeAdapter("RTM", { address: new Error("Private keys are disabled") }),
			userId: "a",
		}),
		/Private keys are disabled/,
	);
});
