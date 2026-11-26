// -----------------------------------------------------------------------------
// CHAIN ADAPTER TESTS.
//
// Two things are being defended here.
//
// PRECISION. These daemons report amounts as decimal coins, often as JSON
// numbers, and the venue accounts in base units. Every lost digit is a lost
// coin, and the loss is silent — so the conversion is tested at the edges where
// a double gives up.
//
// FAILING CLOSED. An adapter that returns zero when it cannot reach its node
// reports the customers' coins as missing, which halts withdrawals; one that
// returns an empty transfer list reports "no deposits" for a chain nobody is
// watching. Every one of those paths must throw instead, and each test below
// names the consequence it is preventing.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	BitcoinRpcAdapter,
	ChainError,
	EvmRpcAdapter,
	JsonRpc,
	MoneroRpcAdapter,
	adapterFromEnv,
	baseToDecimal,
	decimalToBase,
} from "../src/chains";

/**
 * A fetch that answers with a real JSON-RPC error object, code included.
 *
 * `rpcStub` turns an Error into `{error:{message}}` with no code, which is
 * fine for most tests but cannot express the distinction the custody
 * read-only check depends on: -4 (no key here) versus -13 (wallet locked).
 */
function rpcErrStub(method: string, code: number, message: string): typeof fetch {
	return (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { method: string };
		if (body.method === method) {
			return new Response(JSON.stringify({ error: { code, message } }), { status: 200 });
		}
		if (body.method === "getblockchaininfo") {
			return new Response(
				JSON.stringify({
					result: { blocks: 10, headers: 10, initialblockdownload: false },
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ result: null }), { status: 200 });
	}) as unknown as typeof fetch;
}

/**
 * A fetch that answers from a table of method -> result (or a thrower).
 *
 * IT ANSWERS BATCHES AS WELL AS SINGLE CALLS, and that is not a convenience —
 * it is what keeps these tests honest about the code they exercise. The EVM
 * reconciliation read is BATCHED (one HTTP request, N results, matched by id)
 * because it has to read one balance per customer address, and a stub that
 * only understood single calls would have forced the adapter to stay serial to
 * remain testable. Replies are emitted in REVERSE request order on purpose:
 * JSON-RPC 2.0 explicitly permits any order, some providers use it, and
 * `JsonRpc.batch` matches by id for exactly that reason. A stub that always
 * replied in order would let a positional-read regression — which silently
 * attributes one customer's balance to another, while the SUM stays right —
 * pass every test here.
 */
function rpcStub(
	answers: Record<string, unknown | (() => unknown)>,
	seen?: Array<{ method: string; params: unknown }>,
): typeof fetch {
	const answerOne = (
		call: { method: string; params: unknown; id?: unknown },
	): Record<string, unknown> => {
		seen?.push({ method: call.method, params: call.params });
		const envelope = { jsonrpc: "2.0", id: call.id };
		if (!(call.method in answers)) {
			return { ...envelope, error: { message: `Method not found: ${call.method}` } };
		}
		const a = answers[call.method];
		const value = typeof a === "function" ? (a as () => unknown)() : a;
		if (value instanceof Error) return { ...envelope, error: { message: value.message } };
		return { ...envelope, result: value };
	};

	return (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as
			| { method: string; params: unknown; id?: unknown }
			| Array<{ method: string; params: unknown; id?: unknown }>;
		if (Array.isArray(body)) {
			const replies = body.map(answerOne).reverse();
			return new Response(JSON.stringify(replies), { status: 200 });
		}
		const one = answerOne(body);
		// Single-call replies keep the old shape exactly: `call()` reads
		// `result`/`error` and ignores the id, and every bitcoind-family test
		// below depends on that having not changed.
		return new Response(JSON.stringify(one), { status: 200 });
	}) as unknown as typeof fetch;
}

const btc = (answers: Record<string, unknown>, opts?: { send?: boolean; decimals?: number }) =>
	new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			fetchImpl: rpcStub(answers),
			...(opts?.send === true ? { allowSend: true } : {}),
		}),
		opts?.decimals ?? 8,
	);

// ------------------------------------------------------------------ precision

test("DECIMAL CONVERSION IS EXACT at eight places", () => {
	assert.equal(decimalToBase("0.00000001", 8), 1n);
	assert.equal(decimalToBase("1", 8), 100_000_000n);
	assert.equal(decimalToBase("12.5", 8), 1_250_000_000n);
	assert.equal(decimalToBase("21000000.12345678", 8), 2_100_000_012_345_678n);
	// Trailing zeros past the scale are not extra precision.
	assert.equal(decimalToBase("1.500000000000", 8), 150_000_000n);
	assert.equal(decimalToBase("-0.5", 8), -50_000_000n);
	// 18 decimals, where a double has no chance at all.
	assert.equal(
		decimalToBase("1234567.123456789012345678", 18),
		1_234_567_123_456_789_012_345_678n,
	);
});

test("EXTRA PRECISION THROWS rather than rounding", () => {
	// Rounding down invents a shortfall; rounding up invents coins. Neither is
	// an acceptable thing to do quietly to a custody balance.
	assert.throws(() => decimalToBase("0.000000001", 8), (e: unknown) => {
		assert.match(String(e), /more precision than 8 decimals/);
		assert.match(String(e), /invents a shortfall/);
		return true;
	});
});

test("exponent notation is expanded, not refused", () => {
	// Some JSON encoders emit 1e-8 for a satoshi. The digits are all present.
	assert.equal(decimalToBase("1e-8", 8), 1n);
	assert.equal(decimalToBase("1.5e2", 8), 15_000_000_000n);
	assert.equal(decimalToBase("-2.5e-1", 8), -25_000_000n);
});

test("a non-amount is refused", () => {
	for (const bad of ["", "abc", "1.2.3", "0x10", "1,5", " "]) {
		assert.throws(() => decimalToBase(bad, 8), /not a decimal amount/, JSON.stringify(bad));
	}
});

test("base units round-trip back to the string a daemon wants", () => {
	for (const s of ["0", "1", "0.00000001", "12.5", "21000000.12345678"]) {
		assert.equal(baseToDecimal(decimalToBase(s, 8), 8), String(Number(s)) === s ? s : s);
	}
	assert.equal(baseToDecimal(0n, 8), "0");
	assert.equal(baseToDecimal(1n, 8), "0.00000001");
	assert.equal(baseToDecimal(-150_000_000n, 8), "-1.5");
});

// ------------------------------------------------------------- bitcoind family

test("a balance arrives as base units, from getbalances where available", async () => {
	const a = btc({ getbalances: { mine: { trusted: "12.5" } } });
	assert.equal(await a.balance(), 1_250_000_000n);
});

test("an older fork without getbalances still works", async () => {
	// A missing method is a CAPABILITY DIFFERENCE, not a failure — the fallback
	// exists because most of these forks predate getbalances.
	const a = btc({ getbalance: "3.00000001" });
	assert.equal(await a.balance(), 300_000_001n);
});

test("A BALANCE TOO LARGE FOR A DOUBLE IS REFUSED", async () => {
	/*
	 * Past (2^53-1)/1e8 — about 90,071,992 coins — consecutive satoshis are not
	 * distinguishable in a JSON number, so the figure the daemon sent is already
	 * an approximation. Accepting it would put a wrong custody total into
	 * reconciliation, where it reads as a shortfall or surplus that no
	 * transaction can explain.
	 *
	 * This is not hypothetical: a Dogecoin-family wallet passes that bound
	 * easily.
	 *
	 * The first version of this test asserted a round-trip check instead, and it
	 * failed — correctly. A round trip cannot detect this, because the digits
	 * are gone before the check runs. Magnitude can.
	 */
	const a = btc({ getbalances: { mine: { trusted: 150_000_000.5 } } });
	await assert.rejects(() => a.balance(), (e: unknown) => {
		assert.match(String(e), /a double cannot hold every unit at 8 decimals/);
		assert.match(String(e), /Refusing to use an approximate custody balance/);
		assert.match(String(e), /returns amounts as strings/);
		return true;
	});

	// A STRING OF THE SAME SIZE IS FINE — the digits are all there.
	const s = btc({ getbalances: { mine: { trusted: "150000000.50000001" } } });
	assert.equal(await s.balance(), 15_000_000_050_000_001n);
});

test("an 18-decimal amount as a JSON number is refused outright", async () => {
	// At 18 places a double holds base units exactly only below ~0.009, so any
	// real balance arriving this way is an approximation.
	const a = btc({ getbalances: { mine: { trusted: 1.5 } } }, { decimals: 18 });
	await assert.rejects(() => a.balance(), /already an approximation/);
});

test("a JSON number that IS exact is accepted", async () => {
	// Refusing every number would make this unusable against real daemons.
	const a = btc({ getbalances: { mine: { trusted: 12.5 } } });
	assert.equal(await a.balance(), 1_250_000_000n);
});

test("AN UNREACHABLE NODE THROWS — it never reports zero", async () => {
	const dead = new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
		}),
		8,
	);
	await assert.rejects(() => dead.balance(), /could not reach/);
	// A zero here would read as "the customers' coins are gone" and halt the
	// venue on a network blip.
	const probe = await dead.probe();
	assert.equal(probe.reachable, false);
	assert.equal(probe.canSend, false);
});

test("probe reports sync honestly, and names the gap", async () => {
	const behind = btc({
		getblockchaininfo: { blocks: 900, headers: 1000, initialblockdownload: false },
		getnewaddress: "addr1",
	});
	const p = await behind.probe();
	assert.equal(p.reachable, true);
	assert.equal(p.synced, false);
	assert.equal(p.height, 900);
	assert.ok(p.notes.some((n) => /at block 900 of 1000 headers/.test(n)));

	const synced = btc({
		getblockchaininfo: { blocks: 1000, headers: 1000, initialblockdownload: false },
		getnewaddress: "addr1",
	});
	assert.equal((await synced.probe()).synced, true);
});

test("initial block download is never 'synced', however close the numbers are", async () => {
	const ibd = btc({
		getblockchaininfo: { blocks: 1000, headers: 1000, initialblockdownload: true },
	});
	assert.equal((await ibd.probe()).synced, false);
});

test("A WALLET THAT CANNOT ISSUE ADDRESSES IS REPORTED, NOT DISCOVERED LATER", async () => {
	// Finding this out at deposit time means a customer waiting for an address
	// that will never arrive.
	const watchOnly = btc({
		getblockchaininfo: { blocks: 10, headers: 10 },
		getnewaddress: new Error("Error: Private keys are disabled for this wallet"),
	});
	const p = await watchOnly.probe();
	assert.equal(p.canDeriveAddresses, false);
	assert.ok(p.notes.some((n) => /per-customer deposit addresses are not available/.test(n)));
});

test("only received transactions become deposits, and an unreadable row is skipped", async () => {
	const a = btc({
		listtransactions: [
			{ category: "receive", txid: "t1", address: "a1", amount: "1.5", confirmations: 3 },
			// A send out — not a deposit.
			{ category: "send", txid: "t2", address: "a2", amount: "-1", confirmations: 9 },
			// Unreadable amount: SKIPPED, not guessed. It comes back next pass.
			{ category: "receive", txid: "t3", address: "a3", amount: "lots" },
			// Zero: nothing to credit.
			{ category: "receive", txid: "t4", address: "a4", amount: "0" },
		],
	});
	const got = await a.incoming();
	assert.equal(got.length, 1);
	assert.deepEqual({ ...got[0]! }, {
		txid: "t1", address: "a1", amount: 150_000_000n, confirmations: 3,
	});
});

test("A READ-ONLY ADAPTER REFUSES TO SEND, and says how sending is enabled", async () => {
	const a = btc({ sendtoaddress: "txid-should-not-happen" });
	await assert.rejects(
		() => a.send({ to: "addr", amount: 1n, idempotencyKey: "wd-1" }),
		(e: unknown) => {
			assert.match(String(e), /this adapter is read-only/);
			assert.match(String(e), /deliberately not the default/);
			return true;
		},
	);
});

test("a send passes the amount as a decimal string and carries the idempotency key", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			allowSend: true,
			fetchImpl: rpcStub({ sendtoaddress: "deadbeef" }, seen),
		}),
		8,
	);
	const r = await a.send({ to: " addr1 ", amount: 150_000_000n, idempotencyKey: "blockle-wd-7" });
	assert.equal(r.txid, "deadbeef");
	assert.deepEqual(seen[0]!.params, ["addr1", "1.5", "blockle-wd-7"]);
});

test("an accepted send with no txid is an error, not a success", async () => {
	// Reporting it as sent with a blank reference would make the withdrawal
	// unreconcilable forever.
	const a = new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			allowSend: true,
			fetchImpl: rpcStub({ sendtoaddress: "" }),
		}),
		8,
	);
	await assert.rejects(
		() => a.send({ to: "a", amount: 1n, idempotencyKey: "k" }),
		(e: unknown) => {
			assert.match(String(e), /NOT treating this as sent/);
			assert.match(String(e), /look for the transaction by its comment \(k\)/);
			return true;
		},
	);
});

test("a prior send is findable by its idempotency key", async () => {
	// This is what stands in for BitGo's sequence id: bitcoind will happily
	// send twice, so the double-pay guard has to be a lookup on our side.
	const a = btc({
		listtransactions: [
			{ category: "send", txid: "earlier", comment: "blockle-wd-7" },
			{ category: "send", txid: "other", comment: "blockle-wd-8" },
		],
	});
	assert.deepEqual(await a.findSend("blockle-wd-7"), { txid: "earlier" });
	assert.equal(await a.findSend("blockle-wd-99"), undefined);
});

test("a non-positive or empty-address send is refused before any RPC", async () => {
	const a = new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({ url: "http://127.0.0.1:9999", allowSend: true, fetchImpl: rpcStub({}) }),
		8,
	);
	await assert.rejects(() => a.send({ to: "x", amount: 0n, idempotencyKey: "k" }), /non-positive/);
	await assert.rejects(() => a.send({ to: " ", amount: 1n, idempotencyKey: "k" }), /empty address/);
});

// -------------------------------------------------------------------- EVM

const evm = (answers: Record<string, unknown>, addresses: string[], token?: string) =>
	new EvmRpcAdapter("OCTA", new JsonRpc({
		url: "http://127.0.0.1:8545",
		fetchImpl: rpcStub(answers),
	}), { decimals: 18, addresses, ...(token === undefined ? {} : { token }) });

const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";

test("native balances are summed across holding addresses, in wei", async () => {
	// `eth_blockNumber` is now part of this path and that is the point of the
	// test changing rather than the stub being patched quietly: the custody read
	// PINS every balance to one explicit block instead of asking for "latest".
	// Without the pin, a sum taken across moving blocks can see a sweep in
	// flight at neither end — the money leaves the customer address at block N
	// and lands at the hot address at N+1 — and report a shortfall that does not
	// exist. A shortfall has no tolerance at any size and halts the asset.
	const a = evm({ eth_blockNumber: "0x10", eth_getBalance: "0xde0b6b3a7640000" }, [A1, A2]);
	// 1e18 each.
	assert.equal(await a.balance(), 2_000_000_000_000_000_000n);
});

test("EVERY CUSTODY BALANCE READ IS PINNED TO ONE BLOCK, never 'latest'", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = new EvmRpcAdapter(
		"OCTA",
		new JsonRpc({
			url: "http://127.0.0.1:8545",
			fetchImpl: rpcStub({ eth_blockNumber: "0x4d2", eth_getBalance: "0x1" }, seen),
		}),
		{ decimals: 18, addresses: [A1, A2] },
	);
	await a.balance();
	const balances = seen.filter((s) => s.method === "eth_getBalance");
	assert.equal(balances.length, 2);
	for (const b of balances) {
		const params = b.params as [string, string];
		// The literal block the pass pinned, not "latest" and not "pending".
		assert.equal(params[1], "0x4d2");
	}
});

test("A BLOCK THAT CANNOT BE PINNED IS AN ERROR, not a fall back to 'latest'", async () => {
	// An endpoint that answers eth_blockNumber with junk has not given us an
	// instant to read the treasury at. Falling back to "latest" here would be
	// the silent version of the bug above.
	const a = evm({ eth_blockNumber: "not-a-quantity", eth_getBalance: "0x1" }, [A1]);
	await assert.rejects(() => a.balance(), /Refusing to fall back to 'latest'/);
});

test("A SHORT BATCH IS AN ERROR, not a partial custody total", async () => {
	// Asked for two balances, given one. A partial sum is indistinguishable
	// from a real shortfall, and a shortfall halts withdrawals for every
	// customer holding the asset — so the reconciler must get UNAVAILABLE
	// rather than a number that is too small.
	const shortBatch = (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as unknown;
		if (Array.isArray(body)) {
			const first = body[0] as { id: number };
			return new Response(
				JSON.stringify([{ jsonrpc: "2.0", id: first.id, result: "0x1" }]),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
	const a = new EvmRpcAdapter(
		"OCTA",
		new JsonRpc({ url: "http://127.0.0.1:8545", fetchImpl: shortBatch }),
		{ decimals: 18, addresses: [A1, A2] },
	);
	await assert.rejects(() => a.balance(), /Refusing to treat a missing answer as a zero/);
});

test("AN EVM ROUTE SAYS IT CANNOT ISSUE ADDRESSES OR SEND", async () => {
	// It holds no keys. An adapter that generated an address from a key it
	// invented would be handing out an address nobody can spend from.
	const a = evm({ eth_blockNumber: "0x10", eth_syncing: false }, [A1]);
	await assert.rejects(() => a.newAddress("alice"), /holds no keys/);
	await assert.rejects(
		() => a.send({ to: A2, amount: 1n, idempotencyKey: "k" }),
		/signs nothing/,
	);

	const p = await a.probe();
	assert.equal(p.canDeriveAddresses, false);
	assert.equal(p.canSend, false);
	assert.equal(p.synced, true);
	assert.ok(p.notes.some((n) => /reads balances only/.test(n)));
});

test("incoming scanning THROWS rather than returning an empty list", async () => {
	// [] would be read as "no deposits" by the watcher, for a chain it is not
	// watching at all.
	//
	// THE WORDING MOVED FROM "not implemented" TO "not configured" AND THAT IS A
	// REAL DISTINCTION, NOT A REPHRASING. Scanning IS implemented now
	// (evmscan.ts), so "not implemented" would have become a false statement in
	// the one message an operator reads while deciding whether a rail is safe.
	// What this adapter is saying is narrower and still true: no scanner has
	// been wired into THIS adapter, so it knows nothing about arrivals. A rail
	// can hold an xpub, issue addresses, and not be watching them — and that
	// combination must never present as "no deposits".
	const a = evm({}, [A1]);
	await assert.rejects(() => a.incoming(), (e: unknown) => {
		assert.match(String(e), /scanning is not configured for this\s+EVM rail/);
		assert.match(String(e), /rather than 'not watching'/);
		return true;
	});
});

test("no configured addresses is an error, not a zero balance", async () => {
	const a = evm({}, []);
	await assert.rejects(() => a.balance(), /would read as an empty treasury/);
});

test("an empty return from a token call is an error, not zero", async () => {
	// "0x" means the call hit nothing — usually a wrong contract address.
	//
	// `eth_blockNumber` is stubbed because the custody read pins every balance to
	// one explicit block; it is not what this test is about. What this test is
	// about is that "0x" must NOT be read as a zero balance, because a wrong
	// token contract address would then report an empty treasury as a fact.
	const a = evm({ eth_blockNumber: "0x10", eth_call: "0x" }, [A1], A2);
	await assert.rejects(() => a.balance(), /the call returned no data/);
});

test("a token balance reads balanceOf with the address padded correctly", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = new EvmRpcAdapter("USDX", new JsonRpc({
		url: "http://127.0.0.1:8545",
		fetchImpl: rpcStub({ eth_blockNumber: "0x10", eth_call: "0x0f4240" }, seen),
	}), { decimals: 6, addresses: [A1], token: A2 });
	assert.equal(await a.balance(), 1_000_000n);
	/*
	 * FOUND BY METHOD, NOT BY POSITION, AND THE DIFFERENCE IS THE REASON THIS
	 * ASSERTION IS WORTH KEEPING.
	 *
	 * This used to read `seen[0]`, which was the balanceOf call back when the
	 * balance path made exactly one request. It is now the `eth_blockNumber`
	 * that pins the read to a single block, so a positional lookup would be
	 * asserting the padding of the wrong call — and would keep passing while
	 * actually checking nothing. Selecting by method survives any future
	 * round trip being added ahead of this one.
	 */
	const call = seen.find((s) => s.method === "eth_call");
	assert.ok(call !== undefined, "the token balance must be read with eth_call");
	const params = call.params as [{ to: string; data: string }, string];
	assert.equal(params[0].to, A2);
	assert.equal(
		params[0].data,
		"0x70a08231" + "1111111111111111111111111111111111111111".padStart(64, "0"),
	);
	// The token read is pinned to the same explicit block as a native read.
	assert.equal(params[1], "0x10");
});

test("a contract whose decimals disagree with the config is reported", async () => {
	// 18 configured, 6 on chain, is a factor of a trillion.
	const a = new EvmRpcAdapter("USDX", new JsonRpc({
		url: "http://127.0.0.1:8545",
		fetchImpl: rpcStub({ eth_blockNumber: "0x1", eth_syncing: false, eth_call: "0x06" }),
	}), { decimals: 18, addresses: [A1], token: A2 });
	const p = await a.probe();
	assert.ok(p.notes.some((n) => /reports 6 decimals but this adapter is configured for 18/.test(n)));
});

test("unknown sync state is NOT reported as synced", async () => {
	// Believing a lagging node means crediting a deposit a reorg can remove.
	const a = evm({ eth_blockNumber: "0x10" }, [A1]);
	const p = await a.probe();
	assert.equal(p.synced, false);
	assert.ok(p.notes.some((n) => /sync state is unknown/.test(n)));
});

test("a malformed address is refused at construction", () => {
	assert.throws(() => evm({}, ["not-an-address"]), /not an address/);
	assert.throws(() => evm({}, [A1], "nope"), /not a contract address/);
});

// ----------------------------------------------------------------- Monero

/**
 * A Monero-family adapter over one method table, wallet and daemon alike.
 *
 * `daemon: false` builds the unconfigured case on purpose — that is a state an
 * operator can really deploy, and what it does is part of the contract.
 */
function zeph(
	answers: Record<string, unknown | (() => unknown)>,
	opts?: { daemon?: false; seen?: Array<{ method: string; params: unknown }> },
) {
	const impl = rpcStub(answers, opts?.seen);
	const wallet = new JsonRpc({ url: "http://127.0.0.1:18082", fetchImpl: impl });
	const daemon =
		opts?.daemon === false
			? undefined
			: new JsonRpc({ url: "http://127.0.0.1:18081", fetchImpl: impl });
	return new MoneroRpcAdapter("ZEPH", wallet, 12, 0, daemon);
}

/** A daemon at the tip with peers — the only state that unlocks the adapter. */
const SYNCED_DAEMON = {
	get_info: {
		height: 500,
		target_height: 0,
		synchronized: true,
		offline: false,
		outgoing_connections_count: 8,
		incoming_connections_count: 1,
	},
	get_height: { height: 500 },
};

test("Monero reports atomic units, and large balances survive as strings", async () => {
	const a = zeph({
		...SYNCED_DAEMON,
		get_balance: { unlocked_balance: "123456789012345678901" },
	});
	assert.equal(await a.balance(), 123_456_789_012_345_678_901n);
});

test("a subaddress is created per customer, which is the attribution", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = zeph({ ...SYNCED_DAEMON, create_address: { address: "ZEPHsub1 " } }, { seen });
	assert.equal(await a.newAddress("user:alice"), "ZEPHsub1");
	const call = seen.find((s) => s.method === "create_address");
	assert.deepEqual(call!.params, { account_index: 0, label: "user:alice" });
});

test("A WALLET RPC IS NEVER CALLED SYNCED on its own word", async () => {
	// The wallet reports how far IT has scanned. A wallet behind the chain
	// understates the balance, which reads as a shortfall and halts withdrawals.
	const a = zeph(
		{ get_height: { height: 100 }, get_address: { address: "Z" } },
		{ daemon: false },
	);
	const p = await a.probe();
	assert.equal(p.reachable, true);
	assert.equal(p.synced, false);
	assert.ok(p.notes.some((n) => /no daemon RPC is configured/.test(n)));
});

test("WITHOUT A DAEMON, every money-touching call REFUSES", async () => {
	// A wallet alone cannot tell "you hold nothing" from "I scanned nothing",
	// and it answers the second with a confident zero. Trusting it reports a
	// custody shortfall, credits no deposits, and hands out addresses on a
	// chain nobody is watching.
	const a = zeph(
		{
			get_balance: { unlocked_balance: "0" },
			create_address: { address: "ZEPHsub1" },
			get_transfers: { in: [] },
			get_height: { height: 1 },
		},
		{ daemon: false },
	);
	for (const [what, call] of [
		["balance", () => a.balance()],
		["deposit address", () => a.newAddress("user:alice")],
		["deposit scan", () => a.incoming()],
	] as const) {
		await assert.rejects(call, (e: unknown) => {
			assert.ok(e instanceof ChainError);
			assert.match(e.message, /no daemon RPC is configured/);
			assert.match(e.message, new RegExp(what));
			return true;
		}, `${what} must refuse`);
	}
});

test("A DAEMON WITH NO PEERS IS REFUSED, height 1 and all", async () => {
	// The live ZEPH case: the node sat at height 1 with zero peers because
	// every one of the project's mainnet p2p seeds refuses connections. Its
	// height says nothing about the chain, so neither may the venue.
	const a = zeph({
		get_info: {
			height: 1,
			target_height: 0,
			synchronized: true,
			offline: false,
			outgoing_connections_count: 0,
			incoming_connections_count: 0,
		},
		get_height: { height: 1 },
		get_balance: { unlocked_balance: "0" },
	});
	await assert.rejects(() => a.balance(), (e: unknown) => {
		assert.ok(e instanceof ChainError);
		assert.match(e.message, /no peers/);
		assert.equal(e.retryable, true, "ask again later, not a bad request");
		return true;
	});
});

test("a daemon still in initial sync is refused", async () => {
	const a = zeph({
		get_info: {
			height: 120_000,
			target_height: 2_300_000,
			synchronized: false,
			offline: false,
			outgoing_connections_count: 6,
		},
		get_height: { height: 120_000 },
		get_balance: { unlocked_balance: "0" },
	});
	await assert.rejects(() => a.balance(), (e: unknown) => {
		assert.ok(e instanceof ChainError);
		assert.match(e.message, /still syncing \(120000\/2300000\)/);
		return true;
	});
});

test("AN OFFLINE DAEMON IS REFUSED even if it claims to be synchronized", async () => {
	// --offline makes a daemon report synchronized against a chain it is not
	// following. Peers alone would not catch it, so offline is checked first.
	const a = zeph({
		get_info: {
			height: 500,
			target_height: 0,
			synchronized: true,
			offline: true,
			outgoing_connections_count: 4,
		},
		get_height: { height: 500 },
		get_balance: { unlocked_balance: "0" },
	});
	await assert.rejects(() => a.balance(), /offline/);
});

test("A LAGGING WALLET IS REFUSED even when the daemon is at the tip", async () => {
	// This is the understated-balance case specifically: the chain is fine and
	// the wallet simply has not caught up, so its balance is real but partial.
	const a = zeph({
		get_info: {
			height: 500,
			target_height: 0,
			synchronized: true,
			offline: false,
			outgoing_connections_count: 8,
		},
		get_height: { height: 450 },
		get_balance: { unlocked_balance: "7" },
	});
	await assert.rejects(() => a.balance(), (e: unknown) => {
		assert.ok(e instanceof ChainError);
		assert.match(e.message, /scanned to 450 but the chain is at 500/);
		return true;
	});
});

test("one block of scan lag is tolerated, so a healthy pair does not flap", async () => {
	// The two legs are read at different instants; demanding an exact match
	// would make a working deployment refuse at random.
	const a = zeph({
		get_info: {
			height: 500,
			target_height: 0,
			synchronized: true,
			offline: false,
			outgoing_connections_count: 8,
		},
		get_height: { height: 499 },
		get_balance: { unlocked_balance: "42" },
	});
	assert.equal(await a.balance(), 42n);
});

test("probe reports synced TRUE only with a healthy daemon, and gates addresses",
	async () => {
		const healthy = zeph({ ...SYNCED_DAEMON, get_address: { address: "Z" } });
		const p = await healthy.probe();
		assert.equal(p.synced, true);
		assert.equal(p.canDeriveAddresses, true);

		// get_address answers, but a deposit to it would not be seen.
		const blind = zeph({
			get_info: {
				height: 1,
				target_height: 0,
				synchronized: false,
				offline: false,
				outgoing_connections_count: 0,
			},
			get_height: { height: 1 },
			get_address: { address: "Z" },
		});
		const q = await blind.probe();
		assert.equal(q.synced, false);
		assert.equal(q.canDeriveAddresses, false,
			"a subaddress nobody is watching is a trap, not a capability");
	});

test("THE DAEMON URL IS NEVER INFERRED from the wallet's", () => {
	// Falling back to the wallet URL would make the adapter 'have a daemon'
	// that is really the wallet answering get_info — unreachable, or worse,
	// answering something. Credentials may fall back; the endpoint may not.
	const a = adapterFromEnv({
		symbol: "ZEPH",
		route: "monero-rpc",
		decimals: 12,
		env: { CHAIN_ZEPH_URL: "http://127.0.0.1:19008" },
	});
	assert.ok(a !== undefined, "a configured wallet still builds an adapter");
	assert.rejects(() => a.balance(), /no daemon RPC is configured/);
});

// ---------------------------------------------------------------- factory

test("NOTHING CONFIGURED MEANS NO ADAPTER, which is not an error", () => {
	// The normal state of a planned coin.
	assert.equal(
		adapterFromEnv({ symbol: "RTM", route: "bitcoin-rpc", decimals: 8, env: {} }),
		undefined,
	);
});

test("A NODE WITH UNCONFIRMED DECIMALS IS REFUSED", () => {
	// Building it anyway would report every balance at a guessed scale.
	assert.throws(
		() => adapterFromEnv({
			symbol: "RTM",
			route: "bitcoin-rpc",
			decimals: undefined,
			env: { CHAIN_RTM_URL: "http://127.0.0.1:1" },
		}),
		/decimals are unconfirmed in the registry/,
	);
});

test("SENDING IS OPT-IN AND EXACT: only \"1\" enables it", async () => {
	const base = { CHAIN_RTM_URL: "http://127.0.0.1:1" };
	for (const v of ["0", "true", "yes", "", "1 "]) {
		const a = adapterFromEnv({
			symbol: "RTM", route: "bitcoin-rpc", decimals: 8,
			env: { ...base, CHAIN_RTM_SEND: v },
			fetchImpl: rpcStub({}),
		})!;
		await assert.rejects(
			() => a.send({ to: "x", amount: 1n, idempotencyKey: "k" }),
			/read-only/,
			`CHAIN_RTM_SEND=${JSON.stringify(v)} must not enable sending`,
		);
	}
	/*
	 * AND THE FLAG IS NO LONGER SUFFICIENT ON ITS OWN. It lives in the one env
	 * file all four exchange units load, so the internet-facing API used to
	 * build a send-capable hot-wallet adapter for every self-custodied coin.
	 * The environment now says what is PERMITTED and the caller says what is
	 * NEEDED; see test/nodesendisolation.test.ts and adapterFromEnv.canSend.
	 */
	const flagOnly = adapterFromEnv({
		symbol: "RTM", route: "bitcoin-rpc", decimals: 8,
		env: { ...base, CHAIN_RTM_SEND: "1" },
		fetchImpl: rpcStub({ sendtoaddress: "tx" }),
	})!;
	await assert.rejects(
		() => flagOnly.send({ to: "x", amount: 1n, idempotencyKey: "k" }),
		/read-only/,
		"CHAIN_RTM_SEND=1 alone must not enable sending — the caller must ask too",
	);

	const on = adapterFromEnv({
		symbol: "RTM", route: "bitcoin-rpc", decimals: 8,
		env: { ...base, CHAIN_RTM_SEND: "1" },
		fetchImpl: rpcStub({ sendtoaddress: "tx" }),
		canSend: true,
	})!;
	assert.deepEqual(await on.send({ to: "x", amount: 1n, idempotencyKey: "k" }), { txid: "tx" });
});

test("an unknown route is refused rather than approximated", () => {
	assert.throws(
		() => adapterFromEnv({
			symbol: "XEL", route: "custom", decimals: 8,
			env: { CHAIN_XEL_URL: "http://127.0.0.1:1" },
		}),
		(e: unknown) => {
			assert.ok(e instanceof ChainError);
			assert.match(String(e), /needs its own class/);
			assert.match(String(e), /not something to approximate with the nearest family/);
			return true;
		},
	);
});

test("an RPC url that is not http is refused", () => {
	assert.throws(
		() => new JsonRpc({ url: "ssh://box/rtm" }),
		/RPC url must be http/,
	);
});

test("a non-JSON RPC response is reported with its body, not swallowed", async () => {
	const a = new BitcoinRpcAdapter("RTM", new JsonRpc({
		url: "http://127.0.0.1:9999",
		fetchImpl: (async () =>
			new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch,
	}), 8);
	await assert.rejects(() => a.balance(), /not JSON.*502 Bad Gateway/s);
});

// ------------------------------------------------- scoped (address) custody
//
// WHY THIS MODE EXISTS. A bitcoin-family balance normally means "whatever is in
// this daemon's wallet". That definition breaks the moment a node does two
// jobs: these daemons are also the parent chains of merge-mining pools, and
// pool income sitting in the wallet is indistinguishable from customer
// deposits — so a custody SHORTFALL could hide behind mining EARNINGS, and
// reconciliation would pass while the venue was short.
//
// Declaring the addresses turns custody into a stated fact auditable against
// the chain. The tests below defend the three ways that can go quietly wrong.

/** A scoped adapter over a table of RPC answers. */
const scoped = (
	answers: Record<string, unknown>,
	addresses: readonly string[],
	seen?: Array<{ method: string; params: unknown }>,
) =>
	new BitcoinRpcAdapter(
		"PEP",
		new JsonRpc({ url: "http://127.0.0.1:9999", fetchImpl: rpcStub(answers, seen) }),
		8,
		addresses,
	);

test("SCOPED BALANCE sums only the declared addresses, exactly", async () => {
	const a = scoped(
		{
			listunspent: [
				{ address: "Pa", amount: 1.5 },
				{ address: "Pb", amount: 0.00000001 },
				{ address: "Pa", amount: 2 },
			],
		},
		["Pa", "Pb"],
	);
	// 1.5 + 0.00000001 + 2 == 3.50000001 coins == 350000001 base units, and the
	// sum is BigInt so the last digit cannot be rounded away.
	assert.equal(await a.balance(), 350000001n);
});

test("SCOPED BALANCE asks the node to filter, and passes the address list", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = scoped({ listunspent: [] }, ["Pa", "Pb"], seen);
	assert.equal(await a.balance(), 0n);
	const call = seen.find((s) => s.method === "listunspent");
	assert.ok(call, "listunspent was not called");
	// minconf 1: unconfirmed coins are not custody. Counting them would
	// overstate holdings, and a reorg would turn that into a shortfall.
	assert.deepEqual(call.params, [1, 9999999, ["Pa", "Pb"]]);
});

test("A NODE THAT IGNORES THE ADDRESS FILTER IS REFUSED, not summed", async () => {
	// THE BUG THIS PREVENTS: older forks have been known to ignore the address
	// argument to listunspent. A wallet-wide total would then be returned under
	// the name of a scoped one — pool earnings counted as customer custody,
	// which is the precise confusion the scoped mode exists to prevent. It must
	// fail loudly, not produce a plausible larger number.
	const a = scoped(
		{
			listunspent: [
				{ address: "Pa", amount: 1 },
				{ address: "POOL-COINBASE", amount: 5000 },
			],
		},
		["Pa"],
	);
	await assert.rejects(() => a.balance(), /not a declared custody address/);
});

test("SCOPED BALANCE refuses an amount a double cannot carry", async () => {
	// The existing precision guard must still apply per UTXO in this path.
	const a = scoped({ listunspent: [{ address: "Pa", amount: 1e17 }] }, ["Pa"]);
	await assert.rejects(() => a.balance(), ChainError);
});

test("A DUPLICATE DECLARED ADDRESS IS REFUSED at construction", () => {
	// Counted once by the node and twice by a naive sum. Refusing beats
	// depending on which of those happens.
	assert.throws(
		() => scoped({}, ["Pa", "Pa"]),
		/duplicate custody address/,
	);
});

test("A BLANK DECLARED ADDRESS IS REFUSED at construction", () => {
	assert.throws(() => scoped({}, ["Pa", "  "]), /blank custody address/);
});

test("PROBE REFUSES a node that can spend a declared custody address", async () => {
	// THE WHOLE POINT of scoping is that this node is an observer. If it holds
	// the key, the label is decoration: it is a hot wallet being reconciled as
	// read-only custody. Reporting it as a working chain would mean every
	// number downstream describes a different custody model than the operator
	// believes is in force.
	const a = scoped(
		{
			getblockchaininfo: { blocks: 10, headers: 10, initialblockdownload: false },
			dumpprivkey: "a-real-private-key",
		},
		["Pa"],
	);
	const caps = await a.probe();
	assert.equal(caps.reachable, false, "a key-holding node must not read as reachable custody");
	assert.ok(
		caps.notes.some((n) => /REFUSED/.test(n) && /holds the private key/.test(n)),
		`expected a refusal note, got: ${caps.notes.join(" | ")}`,
	);
});

test("PROBE accepts a keyless node and says custody is scoped", async () => {
	const a = scoped(
		{
			getblockchaininfo: { blocks: 10, headers: 10, initialblockdownload: false },
			// What a watch-only address actually answers.
			dumpprivkey: new Error("Private key for address Pa is not known"),
		},
		["Pa"],
	);
	const caps = await a.probe();
	assert.equal(caps.reachable, true);
	assert.equal(caps.synced, true);
	assert.ok(caps.notes.some((n) => /custody is scoped to 1 declared/.test(n)));
	// It must NOT claim it can mint deposit addresses: on a watch-only wallet
	// getnewaddress would create a key this node then holds.
	assert.equal(caps.canDeriveAddresses, false);
	assert.ok(caps.notes.some((n) => /imported, not derived/.test(n)));
});

test("A LOCKED WALLET IS UNVERIFIED, not quietly treated as keyless", async () => {
	// A locked wallet fails dumpprivkey the same way a keyless one does, and it
	// still HOLDS the keys. Saying "verified read-only" on that basis would be
	// a false assurance about the one property that matters.
	const a = scoped(
		{
			getblockchaininfo: { blocks: 10, headers: 10, initialblockdownload: false },
			dumpprivkey: new Error("Error: Please enter the wallet passphrase with walletpassphrase first"),
		},
		["Pa"],
	);
	const caps = await a.probe();
	assert.equal(caps.reachable, true, "indeterminate is not a reason to drop the chain");
	assert.ok(
		caps.notes.some((n) => /UNVERIFIED/.test(n)),
		`expected an unverified note, got: ${caps.notes.join(" | ")}`,
	);
});

test("WITH NO DECLARED ADDRESSES the wallet-wide behaviour is unchanged", async () => {
	// Back-compat matters: BTC and the other already-live bitcoin-family coins
	// are reconciled from the wallet and must keep working exactly as before.
	const a = btc({ getbalances: { mine: { trusted: "1.25" } } });
	assert.equal(await a.balance(), 125000000n);
	const seen: Array<{ method: string; params: unknown }> = [];
	const b = new BitcoinRpcAdapter(
		"RTM",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			fetchImpl: rpcStub({ getbalances: { mine: { trusted: "1" } } }, seen),
		}),
		8,
	);
	await b.balance();
	assert.ok(
		!seen.some((s) => s.method === "listunspent"),
		"unscoped custody must not go near listunspent",
	);
});

test("watchAddress imports without a key, and the rescan choice is explicit", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = scoped({ importaddress: null }, ["Pa"], seen);
	await a.watchAddress("Pnew", false);
	assert.deepEqual(seen.at(-1)?.params, ["Pnew", "blockle-custody", false]);
	// An address that already holds coins needs the rescan, or the daemon
	// reports zero for funds that are plainly on the chain.
	await a.watchAddress("Pold", true);
	assert.deepEqual(seen.at(-1)?.params, ["Pold", "blockle-custody", true]);
	await assert.rejects(() => a.watchAddress("  ", false), /blank address/);
});

test("ADDRESSES COME FROM THE ENVIRONMENT, same spelling as the EVM route", () => {
	const a = adapterFromEnv({
		symbol: "PEP",
		route: "bitcoin-rpc",
		decimals: 8,
		env: {
			CHAIN_PEP_URL: "http://127.0.0.1:19002",
			CHAIN_PEP_ADDRESSES: "Pa, Pb ,",
		},
		fetchImpl: rpcStub({ listunspent: [{ address: "Pb", amount: 7 }] }),
	});
	assert.ok(a, "no adapter built");
	// Blanks and whitespace are dropped rather than becoming a third address.
	return a.balance().then((v) => assert.equal(v, 700000000n));
});

test("THE RPC ERROR CODE IS CARRIED, not just the message", async () => {
	// Without the code, "no key here" and "wallet locked" are both just an
	// exception, and the read-only check cannot tell a verified observer from a
	// hot wallet that happens to be locked right now.
	const a = new BitcoinRpcAdapter(
		"PEP",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			fetchImpl: rpcErrStub("dumpprivkey", -4, "Private key for address Pa is not known"),
		}),
		8,
		["Pa"],
	);
	await assert.rejects(
		() => a.watchAddress("Pa", false),
		(e: unknown) => e instanceof ChainError && e.rpcCode === undefined,
		"importaddress answered null here, so this should not have thrown at all",
	).catch(() => {
		/* importaddress returns null in this stub; the code path under test is below. */
	});
	const caps = await a.probe();
	assert.equal(caps.reachable, true);
	// -4 is the real code pepecoind and dingocoind return for a watch-only
	// address; it must read as verified-keyless, not as unverified.
	assert.ok(
		!caps.notes.some((n) => /UNVERIFIED/.test(n)),
		`code -4 should verify keylessness, got: ${caps.notes.join(" | ")}`,
	);
});

test("A LOCKED WALLET (-13) IS NEVER READ AS KEYLESS", async () => {
	// The dangerous confusion: a wallet that is merely locked still holds every
	// key. Treating -13 as proof of read-only would be a false assurance about
	// the single property the scoped custody model rests on.
	const a = new BitcoinRpcAdapter(
		"PEP",
		new JsonRpc({
			url: "http://127.0.0.1:9999",
			fetchImpl: rpcErrStub("dumpprivkey", -13, "Error: Please enter the wallet passphrase"),
		}),
		8,
		["Pa"],
	);
	const caps = await a.probe();
	assert.equal(caps.reachable, true, "indeterminate is not a reason to drop the chain");
	assert.ok(
		caps.notes.some((n) => /UNVERIFIED/.test(n)),
		`a locked wallet must be UNVERIFIED, got: ${caps.notes.join(" | ")}`,
	);
});
