// -----------------------------------------------------------------------------
// Tests for the BitGo holdings adapter.
//
// No network. Every test injects a fake fetch, so the suite runs anywhere and
// never needs a real token — which matters because the real token is
// IP-whitelisted to one host and would make these tests pass or fail based on
// where they ran.
//
// What is asserted is mostly the failure behaviour, because that is where this
// adapter can do damage: a network blip read as "we hold nothing" would present
// to the reconciler as a total shortfall and halt withdrawals, and a token
// echoed into an error message is a leaked bearer credential.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { BitGoError, BitGoHoldings, parseBaseUnits, redact } from "../src/bitgo";
import { Status, reconcile } from "../src/reconcile";
import { AccountKind, Ledger, Reason } from "../src/ledger";
import Database from "better-sqlite3";

const TOKEN = "v2x_fake_token_for_tests_only";

/** A fake fetch that records what it was asked and returns a canned response. */
function fakeFetch(
	handler: (url: string, init: RequestInit) => { status?: number; body: unknown } | Error,
): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init });
		const out = handler(url, init);
		if (out instanceof Error) throw out;
		const status = out.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? "OK" : "Error",
			async json() {
				return out.body;
			},
			async text() {
				return typeof out.body === "string" ? out.body : JSON.stringify(out.body);
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

/**
 * A wallet-list response for one exchange wallet.
 *
 * `holdings` reads the EXCHANGE'S WALLETS rather than the account-wide balance
 * endpoint it used to call. That change was not cosmetic: the production
 * account this venue uses also holds other projects' wallets, so the
 * account-wide figure counted their coins as exchange custody. These helpers
 * moved with it.
 */
function walletList(
	label: string,
	confirmed: string,
	id = "w_exchange_1",
): unknown {
	return {
		wallets: [{ id, label, confirmedBalanceString: confirmed, balanceString: confirmed }],
	};
}

/** The scope every test uses: wallets labelled for the exchange. */
const SCOPE = { labelPrefix: "Blockle Exchange" } as const;
const LBL = "Blockle Exchange BTC";

function holdingsOf(_coin: string, confirmed: string): unknown {
	return walletList(LBL, confirmed);
}

test("confirmed holdings are read from the STRING field, exactly", async () => {
	// 1.2e26 wei. Via the numeric field this would have been corrupted; the
	// whole point of the adapter is that it is not.
	const huge = "123456789000000000000000001";
	const { impl } = fakeFetch(() => ({ body: holdingsOf("teth", huge) }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });

	assert.equal(await bg.holdings("ETH"), BigInt(huge));
});

test("the numeric `balance` field is never consulted", async () => {
	// A response where the lossy field disagrees with the string field. If the
	// adapter ever reads `balance`, this test fails.
	const { impl } = fakeFetch(() => ({
		body: {
			wallets: [
				{ id: "w1", label: LBL, balance: 1, confirmedBalanceString: "999", balanceString: "999" },
			],
		},
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	assert.equal(await bg.holdings("ETH"), 999n);
});

test("CONFIRMED balance is preferred over the unconfirmed total", async () => {
	// Reconciling against unconfirmed balance would agree with a deposit that
	// can still be reorged away.
	const { impl } = fakeFetch(() => ({
		body: {
			wallets: [
				{ id: "w1", label: LBL, balanceString: "5000", confirmedBalanceString: "3000" },
			],
		},
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	assert.equal(await bg.holdings("ETH"), 3000n);
});

test("TESTNET TICKERS ARE USED IN THE TEST ENVIRONMENT", async () => {
	// Asking the test environment for `eth` returns nothing, which would read as
	// a zero balance and therefore as a shortfall against real books. The ticker
	// table is what prevents that.
	const { impl, calls } = fakeFetch(() => ({ body: holdingsOf("teth", "100") }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await bg.holdings("ETH");

	assert.match(calls[0]!.url, /app\.bitgo-test\.com/);
	// The coin is in the PATH now, not a query parameter: the exchange's own
	// wallets are listed per coin rather than the account totalled.
	assert.match(calls[0]!.url, /\/teth\/wallet$/);
});

test("production tickers and base URL differ", async () => {
	const { impl, calls } = fakeFetch(() => ({ body: holdingsOf("eth", "100") }));
	const bg = new BitGoHoldings(TOKEN, { env: "prod", fetchImpl: impl, ...SCOPE });
	await bg.holdings("ETH");

	assert.match(calls[0]!.url, /app\.bitgo\.com/);
	assert.match(calls[0]!.url, /\/eth\/wallet$/);
	assert.doesNotMatch(calls[0]!.url, /bitgo-test/);
});

test("BLOCK and BLOCK-20 are REFUSED, not reported as zero", async () => {
	// BitGo does not custody our own chain. A zero here would make the
	// reconciler flag the entire BLOCK book as a shortfall and halt withdrawals
	// for a reason unrelated to reality.
	const { impl } = fakeFetch(() => ({ body: { balances: [] } }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });

	await assert.rejects(() => bg.holdings("BLOCK"), /self-custodied, not held at BitGo/);
	await assert.rejects(() => bg.holdings("BLOCK20"), /self-custodied/);
});

test("an unmapped asset is an error, not a confident zero", async () => {
	const { impl } = fakeFetch(() => ({ body: { balances: [] } }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("DOGECOIN"), /no BitGo ticker mapped/);
});

test("NO MATCHING WALLET THROWS rather than returning zero", async () => {
	// This is the single most important failure in the file. The reconciler
	// treats a throw as UNAVAILABLE ("we do not know") and a zero as a real
	// balance. Returning 0n on a config problem would halt withdrawals.
	const { impl } = fakeFetch(() => ({ body: { wallets: [] } }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(
		() => bg.holdings("ETH"),
		/no exchange wallet matched the configured scope for teth/,
	);
});

test("SOMEBODY ELSE'S WALLETS ARE NOT COUNTED AS EXCHANGE CUSTODY", async () => {
	// The reason this adapter stopped using the account-wide balance call. The
	// production account genuinely holds `Perbug BTC`, `FROGE XRP` and a
	// personal wallet; counting them would put books BELOW custody, which
	// reconcile reads as a tolerated surplus — hiding a real shortfall of up to
	// that size.
	const { impl } = fakeFetch(() => ({
		body: {
			wallets: [
				{ id: "w1", label: "Blockle Exchange ETH", confirmedBalanceString: "42" },
				{ id: "w2", label: "FROGE ETH", confirmedBalanceString: "1000000" },
				{ id: "w3", label: "epic2epic@gmail.com", confirmedBalanceString: "500" },
			],
		},
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	assert.equal(await bg.holdings("ETH"), 42n, "ours only");
});

test("several exchange wallets for one coin are summed", async () => {
	const { impl } = fakeFetch(() => ({
		body: {
			wallets: [
				{ id: "w1", label: "Blockle Exchange ETH hot", confirmedBalanceString: "40" },
				{ id: "w2", label: "Blockle Exchange ETH cold", confirmedBalanceString: "2" },
				{ id: "w3", label: "FROGE ETH", confirmedBalanceString: "9999" },
			],
		},
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	assert.equal(await bg.holdings("ETH"), 42n);
});

test("WITH NO SCOPE CONFIGURED IT REFUSES, and lists what it found", async () => {
	// Not "use everything". An unscoped adapter on a shared account is the bug
	// this whole mechanism exists to prevent, so the unconfigured case fails
	// closed and names the wallets so the operator can pick.
	const { impl } = fakeFetch(() => ({
		body: {
			wallets: [
				{ id: "w2", label: "FROGE ETH", confirmedBalanceString: "1000000" },
				{ id: "w3", label: "epic2epic@gmail.com", confirmedBalanceString: "500" },
			],
		},
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl });
	await assert.rejects(() => bg.holdings("ETH"), (e: unknown) => {
		const m = String(e);
		assert.match(m, /no exchange wallet scope is configured/);
		assert.match(m, /FROGE ETH \(w2\)/);
		assert.match(m, /make a real shortfall look like a surplus/);
		assert.match(m, /BITGO_WALLETS or BITGO_WALLET_PREFIX/);
		return true;
	});
});

test("an explicit wallet id list scopes as precisely as a prefix", async () => {
	const { impl } = fakeFetch(() => ({
		body: {
			wallets: [
				{ id: "keep-me", label: "anything at all", confirmedBalanceString: "7" },
				{ id: "not-mine", label: "Blockle Exchange ETH", confirmedBalanceString: "1000" },
			],
		},
	}));
	const bg = new BitGoHoldings(TOKEN, {
		env: "test",
		fetchImpl: impl,
		walletIds: ["keep-me"],
	});
	assert.equal(await bg.holdings("ETH"), 7n);
});

test("A CHAIN-QUALIFIED ASSET RESOLVES TO THE RIGHT BITGO COIN", async () => {
	// USDT.TRC20 and USDT.ERC20 are different BitGo coins. The flat ticker
	// table had no entry for a qualified id, so every multi-network custody
	// check threw "no ticker mapped" — which read as a missing table entry
	// rather than a missing lookup. The mapping lives per-network in assets.ts.
	const { impl, calls } = fakeFetch(() => ({ body: walletList(LBL, "1000000") }));
	const bg = new BitGoHoldings(TOKEN, { env: "prod", fetchImpl: impl, ...SCOPE });

	assert.equal(bg.ticker("USDT.TRC20"), "trx:usdt");
	assert.equal(bg.ticker("USDT.ERC20"), "eth:usdt");
	assert.equal(bg.ticker("USDC.SOL"), "sol:usdc");

	await bg.holdings("USDT.TRC20");
	assert.match(calls[0]!.url, /\/trx:usdt\/wallet$/);
});

test("A NETWORK FAILURE THROWS — it must not look like a zero balance", async () => {
	const { impl } = fakeFetch(() => new Error("ECONNREFUSED"));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("ETH"), BitGoError);
});

test("THE TOKEN IS NEVER ECHOED IN AN ERROR", async () => {
	// A bearer token in an error message is a leaked credential: it lands in
	// logs, crash reports, and whatever aggregates them.
	const { impl } = fakeFetch(() => new Error(`request failed with Bearer ${TOKEN}`));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });

	await assert.rejects(
		() => bg.holdings("ETH"),
		(e: unknown) => {
			const msg = String(e);
			assert.ok(!msg.includes(TOKEN), `the token leaked into: ${msg}`);
			assert.match(msg, /\[REDACTED\]/);
			return true;
		},
	);
});

test("the token is not echoed in an HTTP error body either", async () => {
	const { impl } = fakeFetch(() => ({
		status: 400,
		body: `bad request, token=${TOKEN}`,
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(
		() => bg.holdings("ETH"),
		(e: unknown) => {
			assert.ok(!String(e).includes(TOKEN));
			return true;
		},
	);
});

test("the token travels in the Authorization header, never the URL", async () => {
	// A token in a query string is logged by every proxy and server in the path.
	const { impl, calls } = fakeFetch(() => ({ body: holdingsOf("teth", "1") }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await bg.holdings("ETH");

	const { url, init } = calls[0]!;
	assert.ok(!url.includes(TOKEN), "the token must not appear in the URL");
	const headers = init.headers as Record<string, string>;
	assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
});

// The next three use VERBATIM BitGo response bodies, captured from the live API
// on 2026-11-23. The first version of these tests asserted my own guess — that
// IP-whitelist rejections arrive as HTTP 403 — and the real API returns 401 for
// both that and an unknown token, distinguishing them only in the body. Tests
// written against a guess will happily confirm the guess.

test("an IP-whitelist 401 points at the source address, not the token", async () => {
	const { impl } = fakeFetch(() => ({
		status: 401,
		body: {
			error: "Attempt to use IP-restricted token from an unauthorized IP address",
			name: "Unauthorized",
		},
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("ETH"), (e: unknown) => {
		const m = String(e);
		assert.match(m, /not on its whitelist/);
		// The IPv6 trap is the thing that actually wastes the hour.
		assert.match(m, /IPv6/);
		assert.doesNotMatch(m, /invalid, expired, or revoked/);
		return true;
	});
});

test('a "No access token" 401 points at the WRONG ENVIRONMENT', async () => {
	// This is what app.bitgo.com returned for a token created on the test
	// environment — not a permissions error, just an unknown token.
	const { impl } = fakeFetch(() => ({
		status: 401,
		body: { error: "No access token", name: "Unauthorized" },
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "prod", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("ETH"), (e: unknown) => {
		const m = String(e);
		assert.match(m, /SEPARATE tokens/);
		assert.match(m, /BITGO_ENV/);
		return true;
	});
});

test("any other 401 still reads as an invalid or revoked token", async () => {
	const { impl } = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("ETH"), /invalid, expired, or revoked/);
});

test("a 403 is about scopes and roles, not the whitelist", async () => {
	const { impl } = fakeFetch(() => ({ status: 403, body: { error: "forbidden" } }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("ETH"), /scopes and the acting user's wallet role/);
});

test("a 429 says to back off rather than retry", async () => {
	const { impl } = fakeFetch(() => ({ status: 429, body: { error: "slow down" } }));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	await assert.rejects(() => bg.holdings("ETH"), /rate limited; back off/);
});

test("a request that hangs is abandoned rather than hanging the reconciler", async () => {
	// The double HAS TO HONOUR THE ABORT SIGNAL, because real fetch does. The
	// first version of this test slept and then threw its own error, ignoring
	// `signal` entirely — so the timeout never got exercised and the test passed
	// for the wrong reason. A double that does not implement the contract of the
	// thing it replaces proves nothing.
	const impl = ((_input: string | URL | Request, init: RequestInit = {}) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init.signal;
			const fail = (): void => {
				const e = new Error("The operation was aborted.");
				e.name = "AbortError";
				reject(e);
			};
			if (signal?.aborted === true) return fail();
			signal?.addEventListener("abort", fail, { once: true });
			// Otherwise never settle — a hung upstream.
		})) as unknown as typeof fetch;

	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, timeoutMs: 40 });
	const started = Date.now();
	await assert.rejects(() => bg.holdings("ETH"), /timed out after 40ms/);
	// And it gave up promptly rather than waiting on the upstream.
	assert.ok(Date.now() - started < 2_000, "the abort did not take effect");
});

test("the enterprise filter is passed through when configured", async () => {
	// Without it, balances from an unrelated enterprise are summed in and
	// overstate holdings.
	const { impl, calls } = fakeFetch(() => ({ body: holdingsOf("teth", "1") }));
	const bg = new BitGoHoldings(TOKEN, {
		env: "test",
		enterprise: "ent123",
		fetchImpl: impl,
		...SCOPE,
	});
	await bg.holdings("ETH");
	assert.match(calls[0]!.url, /enterprise=ent123/);
});

test("an empty or missing token is rejected at construction", () => {
	assert.throws(() => new BitGoHoldings("", { env: "test" }), BitGoError);
	assert.throws(() => new BitGoHoldings("   ", { env: "test" }), BitGoError);
});

test("FROMENV DEFAULTS TO THE TEST ENVIRONMENT", () => {
	// A missing or misspelled BITGO_ENV must never resolve to the environment
	// holding real customer funds.
	const bg = BitGoHoldings.fromEnv({ BITGO_ACCESS_TOKEN: TOKEN } as NodeJS.ProcessEnv);
	assert.equal(bg.name, "bitgo:test");
	assert.equal(bg.ticker("ETH"), "teth");
});

test("fromEnv requires BITGO_ENV=prod to be set deliberately", () => {
	const prod = BitGoHoldings.fromEnv({
		BITGO_ACCESS_TOKEN: TOKEN,
		BITGO_ENV: "prod",
	} as NodeJS.ProcessEnv);
	assert.equal(prod.name, "bitgo:prod");

	// Anything else is an error rather than a silent fallback in either
	// direction — "production" is not "prod", and guessing would be wrong.
	assert.throws(
		() =>
			BitGoHoldings.fromEnv({
				BITGO_ACCESS_TOKEN: TOKEN,
				BITGO_ENV: "production",
			} as NodeJS.ProcessEnv),
		/must be "test" or "prod"/,
	);
});

test("fromEnv refuses to run without a token, and says where to put it", () => {
	assert.throws(
		() => BitGoHoldings.fromEnv({} as NodeJS.ProcessEnv),
		/never in a config file inside the repository/,
	);
});

test("parseBaseUnits is strict about integer base units", () => {
	assert.equal(parseBaseUnits("0", "teth"), 0n);
	assert.equal(parseBaseUnits("  1000  ", "teth"), 1000n);
	// A decimal means our base-units assumption has broken; guessing the scale
	// would be the exact precision bug this module exists to prevent.
	assert.throws(() => parseBaseUnits("1.5", "teth"), /non-integer balance/);
	assert.throws(() => parseBaseUnits("1e18", "teth"), /non-integer balance/);
	assert.throws(() => parseBaseUnits("", "teth"), /non-integer balance/);
	assert.throws(() => parseBaseUnits("abc", "teth"), /non-integer balance/);
	assert.throws(() => parseBaseUnits("-5", "teth"), /negative/);
});

test("redact removes every occurrence", () => {
	assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), "a [REDACTED] b [REDACTED]");
	assert.equal(redact("nothing to do", TOKEN), "nothing to do");
	// An empty token must not turn every character into [REDACTED].
	assert.equal(redact("abc", ""), "abc");
});

test("whoami verifies the token without touching funds", async () => {
	const { impl, calls } = fakeFetch(() => ({
		body: { id: "user123", username: "ops@example.com" },
	}));
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });
	const me = await bg.whoami();

	assert.equal(me.id, "user123");
	assert.match(calls[0]!.url, /\/user\/me$/);
	assert.equal(calls[0]!.init.method, "GET", "read-only");
});

test("EVERY REQUEST THIS ADAPTER MAKES IS A GET", async () => {
	// The structural guarantee: the reconciler's dependency cannot move money.
	const { impl, calls } = fakeFetch((url) =>
		url.includes("/user/me")
			? { body: { id: "u" } }
			: url.includes("/wallet/balances")
				? { body: holdingsOf("teth", "1") }
				: { body: { wallets: [{ id: "w1", label: LBL, confirmedBalanceString: "1" }] } },
	);
	const bg = new BitGoHoldings(TOKEN, { env: "test", fetchImpl: impl, ...SCOPE });

	await bg.whoami();
	await bg.holdings("ETH");
	await bg.wallets("ETH");

	assert.equal(calls.length, 3);
	for (const c of calls) {
		assert.equal(c.init.method, "GET", `${c.url} was not a GET`);
		assert.equal(c.init.body, undefined, `${c.url} carried a body`);
	}
});

test("the adapter drops into the reconciler and a BitGo outage reads UNAVAILABLE", async () => {
	// The integration that matters: an adapter throw must become "we do not
	// know" rather than "we hold nothing".
	const l = new Ledger(new Database(":memory:"));
	l.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: -1000n },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "ETH" }, delta: 1000n },
			{ account: { kind: AccountKind.USER, owner: "alice", asset: "ETH" }, delta: 1000n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "ETH" }, delta: -1000n },
		],
		idempotencyKey: "deposit:0x1",
		actor: "test",
	});

	const down = new BitGoHoldings(TOKEN, {
		env: "test",
		fetchImpl: fakeFetch(() => new Error("ECONNREFUSED")).impl,
		...SCOPE,
	});
	const outage = await reconcile(l, down, ["ETH"]);
	assert.equal(outage.assets[0]!.status, Status.UNAVAILABLE);
	assert.deepEqual(outage.halted, [], "an outage must not halt withdrawals");

	// And when BitGo agrees, it reconciles clean through the real adapter path.
	const up = new BitGoHoldings(TOKEN, {
		env: "test",
		fetchImpl: fakeFetch(() => ({ body: holdingsOf("teth", "1000") })).impl,
		...SCOPE,
	});
	const good = await reconcile(l, up, ["ETH"]);
	assert.equal(good.assets[0]!.status, Status.OK);
	assert.equal(good.assets[0]!.source, "bitgo:test");
});
