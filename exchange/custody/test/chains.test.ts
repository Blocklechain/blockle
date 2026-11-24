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

/** A fetch that answers from a table of method -> result (or a thrower). */
function rpcStub(
	answers: Record<string, unknown | (() => unknown)>,
	seen?: Array<{ method: string; params: unknown }>,
): typeof fetch {
	return (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
		seen?.push({ method: body.method, params: body.params });
		if (!(body.method in answers)) {
			return new Response(
				JSON.stringify({ error: { message: `Method not found: ${body.method}` } }),
				{ status: 200 },
			);
		}
		const a = answers[body.method];
		const value = typeof a === "function" ? (a as () => unknown)() : a;
		if (value instanceof Error) {
			return new Response(JSON.stringify({ error: { message: value.message } }), {
				status: 200,
			});
		}
		return new Response(JSON.stringify({ result: value }), { status: 200 });
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
	const a = evm({ eth_getBalance: "0xde0b6b3a7640000" }, [A1, A2]);
	// 1e18 each.
	assert.equal(await a.balance(), 2_000_000_000_000_000_000n);
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
	const a = evm({}, [A1]);
	await assert.rejects(() => a.incoming(), (e: unknown) => {
		assert.match(String(e), /not implemented for the EVM route/);
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
	const a = evm({ eth_call: "0x" }, [A1], A2);
	await assert.rejects(() => a.balance(), /the call returned no data/);
});

test("a token balance reads balanceOf with the address padded correctly", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = new EvmRpcAdapter("USDX", new JsonRpc({
		url: "http://127.0.0.1:8545",
		fetchImpl: rpcStub({ eth_call: "0x0f4240" }, seen),
	}), { decimals: 6, addresses: [A1], token: A2 });
	assert.equal(await a.balance(), 1_000_000n);
	const params = seen[0]!.params as [{ to: string; data: string }, string];
	assert.equal(params[0].to, A2);
	assert.equal(
		params[0].data,
		"0x70a08231" + "1111111111111111111111111111111111111111".padStart(64, "0"),
	);
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

test("Monero reports atomic units, and large balances survive as strings", async () => {
	const a = new MoneroRpcAdapter("ZEPH", new JsonRpc({
		url: "http://127.0.0.1:18082",
		fetchImpl: rpcStub({ get_balance: { unlocked_balance: "123456789012345678901" } }),
	}), 12);
	assert.equal(await a.balance(), 123_456_789_012_345_678_901n);
});

test("a subaddress is created per customer, which is the attribution", async () => {
	const seen: Array<{ method: string; params: unknown }> = [];
	const a = new MoneroRpcAdapter("ZEPH", new JsonRpc({
		url: "http://127.0.0.1:18082",
		fetchImpl: rpcStub({ create_address: { address: "ZEPHsub1 " } }, seen),
	}), 12);
	assert.equal(await a.newAddress("user:alice"), "ZEPHsub1");
	assert.deepEqual(seen[0]!.params, { account_index: 0, label: "user:alice" });
});

test("A WALLET RPC IS NEVER CALLED SYNCED on its own word", async () => {
	// The wallet reports how far IT has scanned. A wallet behind the chain
	// understates the balance, which reads as a shortfall and halts withdrawals.
	const a = new MoneroRpcAdapter("ZEPH", new JsonRpc({
		url: "http://127.0.0.1:18082",
		fetchImpl: rpcStub({ get_height: { height: 100 }, get_address: { address: "Z" } }),
	}), 12);
	const p = await a.probe();
	assert.equal(p.reachable, true);
	assert.equal(p.synced, false);
	assert.ok(p.notes.some((n) => /only its own scan height/.test(n)));
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
	const on = adapterFromEnv({
		symbol: "RTM", route: "bitcoin-rpc", decimals: 8,
		env: { ...base, CHAIN_RTM_SEND: "1" },
		fetchImpl: rpcStub({ sendtoaddress: "tx" }),
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
