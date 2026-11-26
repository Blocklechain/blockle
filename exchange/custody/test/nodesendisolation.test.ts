// -----------------------------------------------------------------------------
// THE PROCESS THAT FACES THE INTERNET MUST NOT HOLD A SEND-CAPABLE HOT-WALLET
// ADAPTER — and the preflight must say so out loud while the credential behind
// it can still export keys.
//
// THE MEASURED POSITION THAT PRODUCED THESE TESTS (2026-11-26, on the box):
//
//   /etc/blockle/exchange-coins.env   mode 0640 root:www-data
//   loaded as an EnvironmentFile by   exchange-public-api.service
//                                     exchange-deposit-watcher.service
//                                     exchange-reconcile.service
//                                     exchange-payout-runner.service
//   every one of those                User=www-data
//   contents include                  CHAIN_{RTM,PEP,DINGO,PERBUG}_{URL,USER,PASS}
//                                     CHAIN_PEP_SEND=1, CHAIN_DINGO_SEND=1,
//                                     CHAIN_RTM_SEND=1, CHAIN_PERBUG_SEND=1
//   none of those daemons has         an rpcwhitelist line
//   no CHAIN_*_PASSPHRASE exists      and `getwalletinfo` on the perbug
//                                     exchange wallet reports no
//                                     `unlocked_until`, i.e. unencrypted
//
// So `allowSend` was derived from a flag in a file the internet-facing uid can
// read, and the HTTP process built a send-capable adapter for four live hot
// wallets it has never had any reason to send from.
//
// TWO DIFFERENT CLAIMS ARE TESTED HERE, AND CONFLATING THEM WOULD BE THE WHOLE
// MISTAKE:
//
//   (a) FIXED IN CODE. Sending now needs the environment to permit it AND the
//       calling process to ask. The read-only jobs do not ask, so no object in
//       them can send, whatever the env file says.
//
//   (b) NOT FIXED IN CODE, AND NOT FIXABLE IN CODE. The CREDENTIAL is still in
//       that process's environment, and `dumpwallet`/`sendtoaddress` do not go
//       through this service at all. That is a deployment change. What code can
//       do is refuse to call the venue ready while it is outstanding, which is
//       `custody:node-key-export`, tested below — including that an UNKNOWN
//       answer fails rather than passing quietly.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { BitcoinRpcAdapter, JsonRpc, adapterFromEnv } from "../src/chains";
import { nodeAdapters } from "../src/custodyrouting";
import { Ledger } from "../src/ledger";
import { preflight, type PreflightDeps } from "../src/golive";

/** The live shape of the env file, including the send flags it really has. */
const SHARED_ENV = {
	CHAIN_PEP_URL: "http://127.0.0.1:9001",
	CHAIN_PEP_USER: "exchange",
	CHAIN_PEP_PASS: "not-a-real-password",
	CHAIN_PEP_SEND: "1",
} as const;

/** A fetch double: every RPC call answers with `reply`, and calls are recorded. */
function rpcStub(reply: unknown, status = 200, rawBody?: string) {
	const calls: string[] = [];
	const fetchImpl = (async (_url: string, init?: { body?: string }) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
		calls.push(body.method);
		return {
			ok: status >= 200 && status < 300,
			status,
			async text() {
				return rawBody ?? JSON.stringify(reply);
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

test("THE ENV FLAG ALONE NO LONGER GRANTS SEND — the caller must ask", async () => {
	const { fetchImpl } = rpcStub({ result: "0xtx" });
	const readOnly = adapterFromEnv({
		symbol: "PEP",
		route: "bitcoin-rpc",
		decimals: 8,
		env: SHARED_ENV,
		fetchImpl,
	})!;

	assert.equal(
		(await readOnly.probe()).canSend,
		false,
		"CHAIN_PEP_SEND=1 is in the environment and this adapter still must not send",
	);
	await assert.rejects(
		readOnly.send({ to: "PEPaddr", amount: 1n, idempotencyKey: "k" }),
		/read-only/,
		"the refusal must happen before any network call, not at the daemon",
	);
});

test("the payout runner, which asks, still gets what it needs", async () => {
	const { fetchImpl } = rpcStub({ result: "0xtx" });
	const payer = adapterFromEnv({
		symbol: "PEP",
		route: "bitcoin-rpc",
		decimals: 8,
		env: SHARED_ENV,
		fetchImpl,
		canSend: true,
	})!;
	assert.equal((await payer.probe()).canSend, true);
});

test("ASKING IS NOT ENOUGH EITHER: without the env flag, sending stays refused", async () => {
	const { fetchImpl } = rpcStub({ result: "0xtx" });
	const noFlag = adapterFromEnv({
		symbol: "PEP",
		route: "bitcoin-rpc",
		decimals: 8,
		env: { ...SHARED_ENV, CHAIN_PEP_SEND: "0" },
		fetchImpl,
		canSend: true,
	})!;
	assert.equal((await noFlag.probe()).canSend, false);
});

test("nodeAdapters is READ-ONLY BY DEFAULT, so every job but one is safe by omission", async () => {
	/*
	 * The default matters more than the option. publicapi, depositwatchercli
	 * and reconcilejob each call `nodeAdapters({ env: process.env, … })` and
	 * pass no capability — the same shape as before this change — so the fix
	 * applies to them without any of them having been edited. Only
	 * payoutrunnercli passes canSend: true.
	 */
	const coins = [{ symbol: "PEP", custody: "bitcoin-rpc", decimals: 8 }] as never;
	const def = nodeAdapters({ env: SHARED_ENV as never, coins });
	assert.equal(def.size, 1);
	/*
	 * Asserted on the OBJECT's capability, not on `probe()`. probe() reports
	 * canSend only after a live `getwalletinfo` succeeds, so against no daemon
	 * it answers false for both — which would make this test pass for the wrong
	 * reason and keep passing if the fix were reverted.
	 */
	const readOnly = def.get("PEP") as BitcoinRpcAdapter;
	assert.equal(readOnly.canSend, false);
	await assert.rejects(
		readOnly.send({ to: "PEPaddr", amount: 1n, idempotencyKey: "k" }),
		/read-only/,
	);

	const payer = nodeAdapters({ env: SHARED_ENV as never, coins, canSend: true });
	assert.equal((payer.get("PEP") as BitcoinRpcAdapter).canSend, true);
});

/* --------------------------------------------- what the CREDENTIAL can do */

function adapter(reply: unknown, status = 200, rawBody?: string): BitcoinRpcAdapter {
	const { fetchImpl } = rpcStub(reply, status, rawBody);
	return new BitcoinRpcAdapter(
		"PEP",
		new JsonRpc({ url: "http://127.0.0.1:9001", user: "u", password: "p", fetchImpl }),
		8,
	);
}

test("A CREDENTIAL THAT CAN RUN dumpprivkey IS REPORTED AS 'permitted'", async () => {
	/*
	 * -5 is RPC_INVALID_ADDRESS_OR_KEY: the method RAN and rejected the
	 * argument, which is the dangerous verdict — a real address would have been
	 * answered with its private key. This is what the four live daemons return
	 * today, because none of them has an rpcwhitelist.
	 */
	const a = adapter({ error: { code: -5, message: "Invalid address" } });
	assert.equal(await a.keyExportCapability(), "permitted");
});

test("an rpcwhitelist or -disablewallet is reported as 'refused'", async () => {
	assert.equal(
		await adapter({ error: { code: -32601, message: "Method not found" } }).keyExportCapability(),
		"refused",
	);
	// bitcoind's HTTP layer answers a whitelist violation with 403 and an empty
	// body — no JSON-RPC error object at all, which is why the message has to
	// be read as well as the code.
	assert.equal(await adapter({}, 403, "").keyExportCapability(), "refused");
});

test("an encrypted wallet is its own verdict, not a pass", async () => {
	// -13 is RPC_WALLET_UNLOCK_NEEDED. The method is permitted; the credential
	// alone is not sufficient. Distinguished because encrypting the wallets is
	// the half of the remedy an operator can do in one command.
	const a = adapter({ error: { code: -13, message: "Error: Please enter the wallet passphrase" } });
	assert.equal(await a.keyExportCapability(), "encrypted");
});

test("AN UNREACHABLE DAEMON IS 'unknown', NEVER 'refused'", async () => {
	const fetchImpl = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch;
	const a = new BitcoinRpcAdapter(
		"PEP",
		new JsonRpc({ url: "http://127.0.0.1:9001", fetchImpl }),
		8,
	);
	assert.equal(
		await a.keyExportCapability(),
		"unknown",
		"guessing in the safe-sounding direction is how a check becomes decoration",
	);
});

test("the probe never asks about a real address, so it cannot receive a key", async () => {
	const { calls, fetchImpl } = rpcStub({ error: { code: -5, message: "Invalid address" } });
	const seen: string[] = [];
	const spy = (async (url: string, init?: { body?: string }) => {
		seen.push(String(init?.body ?? ""));
		return fetchImpl(url as never, init as never);
	}) as unknown as typeof fetch;
	await new BitcoinRpcAdapter(
		"PEP",
		new JsonRpc({ url: "http://127.0.0.1:9001", fetchImpl: spy }),
		8,
	).keyExportCapability();

	assert.deepEqual(calls, ["dumpprivkey"]);
	assert.equal(seen.length, 1);
	assert.match(seen[0]!, /not-an-address/);
});

/* --------------------------------------------------------- the go-live gate */

function deps(
	extra: Partial<PreflightDeps> = {},
): PreflightDeps {
	const db = new Database(":memory:");
	return {
		db,
		ledger: new Ledger(db),
		configPath: "/nonexistent/exchange.json",
		env: {},
		...extra,
	} as PreflightDeps;
}

const check = (r: { checks: readonly { id: string; pass: boolean; evidence: string; fundsCritical: boolean }[] }) =>
	r.checks.find((c) => c.id === "custody:node-key-export")!;

test("THE PREFLIGHT FAILS, FUNDS-CRITICAL, WHILE THE CREDENTIAL CAN EXPORT KEYS", async () => {
	const r = await preflight(
		deps({
			nodeKeyExport: async () => [
				{ chain: "PEP", verdict: "permitted" },
				{ chain: "RTM", verdict: "refused" },
			],
		}),
	);
	const c = check(r);
	assert.equal(c.pass, false);
	assert.equal(c.fundsCritical, true, "this failure takes 100% of the rail's deposits");
	assert.match(c.evidence, /PEP=permitted/);
	assert.match(c.evidence, /rpcwhitelist/, "the remedy must be in the evidence the operator reads");
	assert.ok(r.blocking.some((b) => b.id === "custody:node-key-export"));
	assert.equal(r.ready, false);
});

test("UNKNOWN FAILS TOO — an unprobed credential is not a safe one", async () => {
	// No dep at all: nothing asked the daemons. That is the state every caller
	// but golivecli is in, and it must not read as a pass.
	assert.equal(check(await preflight(deps())).pass, false);
	// And a probe that throws is the same answer, not an absent check.
	const threw = await preflight(
		deps({
			nodeKeyExport: async () => {
				throw new Error("the daemon did not answer");
			},
		}),
	);
	assert.equal(check(threw).pass, false);
	assert.match(check(threw).evidence, /did not answer/);
});

test("it passes only when every self-custodied chain refuses the method", async () => {
	const r = await preflight(
		deps({
			nodeKeyExport: async () => [
				{ chain: "PEP", verdict: "refused" },
				{ chain: "RTM", verdict: "refused" },
			],
		}),
	);
	assert.equal(check(r).pass, true);

	// 'encrypted' is NOT a pass: the method is still permitted, so a credential
	// plus a leaked passphrase is still a key export, and the passphrase lives
	// in a file on the same host.
	const enc = await preflight(
		deps({ nodeKeyExport: async () => [{ chain: "PEP", verdict: "encrypted" }] }),
	);
	assert.equal(check(enc).pass, false);
});
