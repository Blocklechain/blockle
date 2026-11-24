// -----------------------------------------------------------------------------
// BLOCK CUSTODY TESTS.
//
// BLOCK is the venue's own chain and the quote asset on half the markets, so
// its custody figure has to come from the chain rather than from a file. Three
// things are pinned here:
//
//   * the explorer reports BASE UNITS, not decimal coins — the one conversion
//     mistake that would multiply every balance by 10^8;
//   * the adapter refuses to issue addresses and refuses to send, with the
//     reason, because the chain cannot do either safely yet;
//   * an unreachable or lagging node is unknown, never zero.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { BlockExplorerAdapter, blockAdapterFromEnv } from "../src/blockchain";

const A1 = "block1y76d75ku575wkj7yek8746xj45gmd6p9s6gqwck6uuda58jaz8esw5scq0";
const A2 = "block1yyvqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

/** Serves the explorer's real response shapes. */
function explorer(routes: Record<string, unknown>, seen?: string[]): typeof fetch {
	return (async (url: string) => {
		const path = new URL(String(url)).pathname;
		seen?.push(path);
		const v = routes[path];
		if (v === undefined) {
			return new Response(JSON.stringify({ error: "unknown endpoint" }), { status: 404 });
		}
		if (v instanceof Error) throw v;
		return new Response(JSON.stringify(v), { status: 200 });
	}) as unknown as typeof fetch;
}

const adapter = (routes: Record<string, unknown>, addresses = [A1], seen?: string[]) =>
	new BlockExplorerAdapter({
		url: "http://127.0.0.1:8445",
		addresses,
		fetchImpl: explorer(routes, seen),
	});

// ------------------------------------------------------------------- balance

test("THE EXPLORER REPORTS BASE UNITS, and they are used as such", () => {
	/*
	 * The giveaway in the live chain data is a coinbase of 45000000: the
	 * subsidy is 0.45 BLOCK at this height, not forty-five million. Every
	 * other adapter here converts from decimal coins, and treating this one
	 * the same way would multiply the venue's whole BLOCK position by 10^8.
	 */
	const a = adapter({ [`/explorer/address/${A1}`]: { balance: 2_025_299_207_300 } });
	return a.balance().then((b) => {
		assert.equal(b, 2_025_299_207_300n, "20,252.992073 BLOCK, not 2.0e20");
	});
});

test("balances sum across the configured custody addresses", async () => {
	const a = adapter(
		{
			[`/explorer/address/${A1}`]: { balance: 100 },
			[`/explorer/address/${A2}`]: { balance: 250 },
		},
		[A1, A2],
	);
	assert.equal(await a.balance(), 350n);
});

test("ADDRESSES ARE CONFIGURED, NEVER DISCOVERED", () => {
	// Summing "every address we have seen" would fold a customer's own wallet
	// into the venue's holdings the moment they withdrew to it.
	assert.throws(
		() => new BlockExplorerAdapter({ url: "http://127.0.0.1:1", addresses: ["nope"] }),
		/not a BLOCK address/,
	);
});

test("no configured addresses is an error, not an empty treasury", async () => {
	await assert.rejects(
		() => adapter({}, []).balance(),
		/reconciliation would read as an empty treasury/,
	);
});

test("A BALANCE PAST 2^53 IS REFUSED rather than approximated", async () => {
	// A JSON number has already lost the low digits by then — about 90 million
	// BLOCK, which the treasury could reach.
	const a = adapter({ [`/explorer/address/${A1}`]: { balance: 9_007_199_254_740_993 } });
	await assert.rejects(() => a.balance(), /Refusing an approximate custody balance/);
	// A string of the same size is fine: the digits are all there.
	const s = adapter({ [`/explorer/address/${A1}`]: { balance: "9007199254740993" } });
	assert.equal(await s.balance(), 9_007_199_254_740_993n);
});

test("a missing balance field is an error, not zero", async () => {
	await assert.rejects(
		() => adapter({ [`/explorer/address/${A1}`]: { address: A1 } }).balance(),
		/returned no balance/,
	);
});

// --------------------------------------------------------------------- probe

test("sync is judged against the merge-mined lanes", async () => {
	// There is no headers-vs-blocks comparison on this chain. The highest
	// last_block_height any lane reports is the best block we know about.
	const behind = adapter({
		"/explorer/stats": { height: 74_500, lanes: [{ last_block_height: 74_537 }] },
		"/explorer/peers": { count: 5 },
	});
	const p1 = await behind.probe();
	assert.equal(p1.reachable, true);
	assert.equal(p1.synced, false);
	assert.ok(p1.notes.some((n) => /at height 74500, lanes report 74537/.test(n)));

	// One block of drift is normal on a ten-lane chain, not an emergency.
	const current = adapter({
		"/explorer/stats": { height: 74_536, lanes: [{ last_block_height: 74_537 }] },
		"/explorer/peers": { count: 5 },
	});
	assert.equal((await current.probe()).synced, true);
});

test("peer count is reported but does NOT decide sync", async () => {
	// A node with no peers that is already at the tip is current; one with
	// fifty peers that is behind is not.
	const a = adapter({
		"/explorer/stats": { height: 10, lanes: [{ last_block_height: 10 }] },
		"/explorer/peers": { count: 0 },
	});
	const p = await a.probe();
	assert.equal(p.synced, true);
	assert.ok(p.notes.some((n) => /no peers/.test(n)));
});

test("AN UNREACHABLE NODE IS UNREACHABLE, not empty", async () => {
	const a = adapter({ "/explorer/stats": new Error("ECONNREFUSED") });
	const p = await a.probe();
	assert.equal(p.reachable, false);
	assert.equal(p.synced, false);
	await assert.rejects(() => a.balance(), /unreachable|HTTP 404/);
});

test("the probe states decimals, and they are the chain's eight", async () => {
	const a = adapter({
		"/explorer/stats": { height: 1, lanes: [] },
		"/explorer/peers": { count: 1 },
	});
	assert.equal((await a.probe()).decimals, 8);
});

// ------------------------------------------------- what it refuses, and why

test("WITH NO POOL LOADED, DEPOSITS ARE CLOSED and the message says how to open them", async () => {
	/*
	 * This process must never hold the master seed: ML-DSA has no watch-only
	 * derivation, so anything that can derive an address can also spend it,
	 * and the public API is the most exposed thing here. Addresses therefore
	 * arrive pre-derived or not at all.
	 */
	const a = adapter({});
	await assert.rejects(() => a.newAddress("alice"), (e: unknown) => {
		assert.match(String(e), /no address pool is loaded/);
		assert.match(String(e), /wallet derive --count 1000 --json/);
		assert.match(String(e), /deliberately cannot derive addresses itself/);
		return true;
	});
	const p = await adapter({
		"/explorer/stats": { height: 1, lanes: [] },
		"/explorer/peers": { count: 1 },
	}).probe();
	// AND THE CAPABILITY SAYS SO, which is what makes canGoLive refuse to
	// promote BLOCK rather than leaving the limitation in a comment.
	assert.equal(p.canDeriveAddresses, false);
	assert.equal(p.canSend, false);
	assert.ok(p.notes.some((n) => /deposits are closed/.test(n)));
});

test("WITH A POOL, IT ISSUES — and the pool, not this process, holds the derivation", async () => {
	const issued: string[] = [];
	const pool = {
		take: (userId: string) => {
			issued.push(userId);
			return { address: A2 };
		},
		allAddresses: () => [A2],
		status: () => ({ total: 10, issued: 1, free: 9, low: false }),
	};
	const a = new BlockExplorerAdapter({
		url: "http://127.0.0.1:8445",
		addresses: [A1],
		pool,
		fetchImpl: explorer({
			"/explorer/stats": { height: 5, lanes: [{ last_block_height: 5 }] },
			"/explorer/peers": { count: 2 },
			[`/explorer/address/${A1}`]: { balance: 100 },
			[`/explorer/address/${A2}`]: { balance: 7 },
		}),
	});
	assert.equal(await a.newAddress("acct_9"), A2);
	assert.deepEqual(issued, ["acct_9"]);

	const p = await a.probe();
	assert.equal(p.canDeriveAddresses, true, "a pool with free addresses can issue");
	assert.ok(p.notes.some((n) => /deposit addresses: 9 free of 10/.test(n)));

	// CUSTODY INCLUDES THE DEPOSIT ADDRESSES. Coins sitting at a customer's
	// address before a sweep are still the venue's holding, and omitting them
	// would show the liability without the asset — a shortfall that halts
	// BLOCK.
	assert.equal(await a.balance(), 107n);
});

test("a low pool is called out at probe time, before it empties", async () => {
	const a = new BlockExplorerAdapter({
		url: "http://127.0.0.1:8445",
		addresses: [A1],
		pool: {
			take: () => ({ address: A2 }),
			allAddresses: () => [],
			status: () => ({ total: 100, issued: 95, free: 5, low: true }),
		},
		fetchImpl: explorer({
			"/explorer/stats": { height: 5, lanes: [{ last_block_height: 5 }] },
			"/explorer/peers": { count: 2 },
		}),
	});
	assert.ok((await a.probe()).notes.some((n) => /running low/.test(n)));
});

test("it cannot send, and the reason is the trust boundary", async () => {
	await assert.rejects(
		() => adapter({}).send({ to: A2, amount: 1n, idempotencyKey: "k" }),
		/different trust boundary/,
	);
});

// ------------------------------------------------------------------ incoming

test("incoming credits only what arrived, with depth measured from the tip", async () => {
	const a = adapter({
		"/explorer/stats": { height: 100, lanes: [{ last_block_height: 100 }] },
		"/explorer/peers": { count: 3 },
		[`/explorer/address/${A1}`]: {
			history: [
				{ txid: "in1", height: 98, net: 45_000_000 },
				// Spent more than it received: not a deposit.
				{ txid: "out1", height: 99, net: -1_000 },
				// Net zero: nothing to credit.
				{ txid: "zero", height: 99, net: 0 },
				// Unreadable: skipped, not guessed.
				{ txid: "bad", height: 99, net: "lots" },
			],
		},
	});
	const got = await a.incoming();
	assert.equal(got.length, 1);
	assert.equal(got[0]!.txid, "in1");
	assert.equal(got[0]!.amount, 45_000_000n);
	// 100 - 98 + 1
	assert.equal(got[0]!.confirmations, 3);
	assert.equal(got[0]!.address, A1);
});

test("history can be filtered by height, for an incremental pass", async () => {
	const a = adapter({
		"/explorer/stats": { height: 100, lanes: [{ last_block_height: 100 }] },
		"/explorer/peers": { count: 3 },
		[`/explorer/address/${A1}`]: {
			history: [
				{ txid: "old", height: 10, net: 5 },
				{ txid: "new", height: 99, net: 7 },
			],
		},
	});
	assert.deepEqual((await a.incoming(50)).map((p) => p.txid), ["new"]);
});

// ------------------------------------------------------------------ the env

test("nothing configured means no adapter, which is the normal state", () => {
	assert.equal(blockAdapterFromEnv({}), undefined);
});

test("configured from the environment, addresses comma-separated", () => {
	const a = blockAdapterFromEnv({
		BLOCK_EXPLORER_URL: "http://127.0.0.1:8445",
		BLOCK_CUSTODY_ADDRESSES: ` ${A1} , ${A2} `,
	});
	assert.ok(a !== undefined);
	assert.equal(a.symbol, "BLOCK");
	assert.equal(a.route, "custom");
});

test("a non-http explorer url is refused", () => {
	assert.throws(
		() => blockAdapterFromEnv({ BLOCK_EXPLORER_URL: "ssh://box", BLOCK_CUSTODY_ADDRESSES: A1 }),
		/must be http/,
	);
});
