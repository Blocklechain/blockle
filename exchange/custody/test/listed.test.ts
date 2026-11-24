// -----------------------------------------------------------------------------
// LISTING REGISTRY TESTS.
//
// The registry decides what gets published about a coin, so the tests are about
// one thing: NOTHING CAN CLAIM TO BE TRADEABLE THAT IS NOT.
//
// A page saying "buy and sell RTM" above a market that does not exist costs
// someone a deposit into an address nobody can credit. So `live` has to be
// unreachable from this file alone, and every published fact has to carry
// provenance.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	LISTED,
	QUOTES,
	canGoLive,
	coinBySlug,
	coinBySymbol,
	listingSummary,
	marketsFor,
	type ListedCoin,
} from "../src/listed";

const ok = {
	reachable: true,
	synced: true,
	decimals: 8,
	canDeriveAddresses: true,
	canSend: true,
	marketDefined: true,
	ledgerKnowsAsset: true,
};

const coin = (over: Partial<ListedCoin> = {}): ListedCoin => ({
	symbol: "RTM",
	name: "Raptoreum",
	slug: "raptoreum-rtm",
	status: "planned",
	custody: "bitcoin-rpc",
	decimals: 8,
	confirmations: 20,
	homepage: "https://raptoreum.com/",
	algorithm: undefined,
	blockTime: undefined,
	pitch: "x",
	knownVenues: undefined,
	...over,
});

// ------------------------------------------------------------ the whole point

test("NOTHING IN THE REGISTRY IS LIVE — a market cannot be opened by editing this file", () => {
	// Promotion goes through canGoLive against a real node. If this ever fails
	// because someone typed `status: "live"`, that is the thing to investigate,
	// not the test.
	const live = LISTED.filter((c) => c.status === "live");
	assert.deepEqual(live.map((c) => c.symbol), [],
		"a coin marked live must have been promoted through canGoLive, not edited in");
});

test("A COIN THE LEDGER DOES NOT KNOW CANNOT GO LIVE", () => {
	// The registry and assets.ts are separate files and were not checked
	// against each other. Promoting a coin the ledger refuses to post for
	// means the first deposit credits a customer and then fails to balance.
	const why = canGoLive(coin(), { ...ok, ledgerKnowsAsset: false });
	assert.ok(why.some((r) => /the ledger does not know this asset/.test(r)));
	assert.ok(why.some((r) => /add it to assets\.ts/.test(r)), "and it says how to fix it");
});

test("a coin with no market defined cannot go live", () => {
	assert.ok(canGoLive(coin(), { ...ok, marketDefined: false })
		.includes("no market is defined for it"));
});

test("EVERY BLOCKER IS REPORTED AT ONCE, not one per attempt", () => {
	// An operator fixing these one round-trip at a time is an operator who
	// gives up and asks for an override.
	const why = canGoLive(coin({ decimals: undefined, confirmations: undefined }), {
		reachable: false,
		synced: false,
		decimals: undefined,
		canDeriveAddresses: false,
		canSend: false,
		marketDefined: false,
		ledgerKnowsAsset: false,
	});
	assert.equal(why.length, 8, why.join("; "));
	assert.ok(why.some((r) => /does not answer/.test(r)));
	assert.ok(why.some((r) => /not synced/.test(r)));
	assert.ok(why.some((r) => /decimals are unconfirmed/.test(r)));
	assert.ok(why.some((r) => /confirmation count is unconfirmed/.test(r)));
	assert.ok(why.some((r) => /deposit address per customer/.test(r)));
	assert.ok(why.some((r) => /cannot send/.test(r)));
	assert.ok(why.some((r) => /no market/.test(r)));
});

test("a fully-ready coin has no blockers", () => {
	assert.deepEqual(canGoLive(coin(), ok), []);
});

test("DECIMALS THAT DISAGREE WITH THE NODE ARE A BLOCKER, not a choice", () => {
	// One of the two is wrong, and being wrong by one place misprices every
	// balance on the coin by a factor of ten.
	const why = canGoLive(coin({ decimals: 8 }), { ...ok, decimals: 18 });
	assert.ok(why.some((r) => /decimals disagree: the registry says 8, the node says 18/.test(r)));
});

test("a node that cannot report decimals does not block a confirmed registry value", () => {
	// bitcoind has no such RPC. Requiring it would make the whole family
	// unpromotable.
	assert.deepEqual(canGoLive(coin({ decimals: 8 }), { ...ok, decimals: undefined }), []);
});

test("zero confirmations is refused", () => {
	assert.ok(canGoLive(coin({ confirmations: 0 }), ok)
		.some((r) => /cannot be credited at zero confirmations/.test(r)));
});

test("a coin already live is not promoted again", () => {
	assert.ok(canGoLive(coin({ status: "live" }), ok).some((r) => /already marked live/.test(r)));
});

// -------------------------------------------------------------------- markets

test("markets exist only for live coins, and always against both quotes", () => {
	assert.deepEqual(marketsFor(coin()), [], "planned coins have no markets");
	assert.deepEqual(marketsFor(coin({ status: "integrating" })), []);
	assert.deepEqual(marketsFor(coin({ status: "live" })), ["RTM-USDT", "RTM-BLOCK"]);
});

test("BLOCK does not trade against itself", () => {
	assert.deepEqual(
		marketsFor(coin({ symbol: "BLOCK", status: "live" })),
		["BLOCK-USDT"],
	);
});

test("both quote assets are present, because that was the requirement", () => {
	assert.deepEqual([...QUOTES], ["USDT", "BLOCK"]);
});

// ------------------------------------------------------------------- the data

test("every entry is internally consistent", () => {
	for (const c of LISTED) {
		assert.match(c.symbol, /^[A-Z0-9]{2,10}$/, c.symbol);
		assert.match(c.slug, /^[a-z0-9-]+$/, `${c.symbol} slug`);
		assert.ok(c.name.trim().length > 1, `${c.symbol} name`);
		// THE PITCH IS WRITTEN BY HAND AND SPECIFIC. Generated filler reads as
		// generated filler to exactly the audience these pages are for.
		assert.ok(c.pitch.length > 40, `${c.symbol} pitch is too thin to publish`);
		assert.ok(!/lorem|TODO|placeholder/i.test(c.pitch), `${c.symbol} pitch`);
		if (c.homepage !== undefined) {
			assert.match(c.homepage, /^https:\/\//, `${c.symbol} homepage must be https`);
		}
		if (c.decimals !== undefined) {
			assert.ok(c.decimals >= 0 && c.decimals <= 18, `${c.symbol} decimals`);
		}
	}
});

test("slugs and symbols are unique — a collision would be two coins on one page", () => {
	assert.equal(new Set(LISTED.map((c) => c.slug)).size, LISTED.length);
	assert.equal(new Set(LISTED.map((c) => c.symbol)).size, LISTED.length);
});

test("EVERY PUBLISHED FACT CARRIES A SOURCE", () => {
	// An unsourced specification on a public page is a specification nobody can
	// check, including us a year from now.
	for (const c of LISTED) {
		for (const [name, fact] of [["algorithm", c.algorithm], ["blockTime", c.blockTime]] as const) {
			if (fact === undefined) continue;
			assert.ok(fact.value.trim() !== "", `${c.symbol} ${name} value`);
			assert.ok(fact.source.trim().length > 4, `${c.symbol} ${name} needs a source`);
		}
	}
});

test("a dated venue count is dated", () => {
	for (const c of LISTED) {
		if (c.knownVenues === undefined) continue;
		// Undated, this becomes a claim about the present that was true once.
		assert.match(c.knownVenues.asOf, /^\d{4}-\d{2}$/, c.symbol);
		assert.ok(c.knownVenues.count >= 0);
	}
});

test("lookup is by exact slug and case-insensitive symbol", () => {
	assert.equal(coinBySlug("raptoreum-rtm")?.symbol, "RTM");
	assert.equal(coinBySlug("Raptoreum-RTM"), undefined, "slugs are exact — URLs are");
	assert.equal(coinBySymbol("rtm")?.slug, "raptoreum-rtm");
	assert.equal(coinBySymbol(" rtm ")?.slug, "raptoreum-rtm");
	assert.equal(coinBySymbol("nope"), undefined);
});

test("the summary adds up", () => {
	const s = listingSummary();
	assert.equal(s.total, LISTED.length);
	assert.equal(s.live + s.integrating + s.planned, s.total);
});

test("the registry is actually about small proof-of-work coins", () => {
	// The point of the exercise. If this ever fills up with majors that are
	// already on twenty exchanges, the strategy has drifted.
	const majors = ["BTC", "ETH", "USDT", "USDC", "SOL", "XRP", "DOGE", "LTC"];
	for (const c of LISTED) {
		assert.ok(!majors.includes(c.symbol), `${c.symbol} does not need this venue`);
	}
	assert.ok(LISTED.length >= 10, "not enough coverage to be worth the pages");
});

test("the venue's own chains are in the registry", () => {
	// They are the anchor: the one pair of coins where we control both sides.
	assert.ok(coinBySymbol("BLOCK") !== undefined);
	assert.ok(coinBySymbol("PERBUG") !== undefined);
});
