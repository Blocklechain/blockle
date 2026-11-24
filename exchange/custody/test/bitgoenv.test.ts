// -----------------------------------------------------------------------------
// BITGO ENVIRONMENT vs COIN SET.
//
// These were one setting. Splitting them exists to allow a combination an
// operator actually wants — a PRODUCTION BitGo account holding TESTNET coins,
// so the venue can be exercised against the real custody system without real
// money moving — and the tests pin the two things that could go wrong with it:
//
//   * the default pairing must stay safe when neither is set;
//   * "production" for the purpose of going live must mean the CONJUNCTION,
//     because the production installation holding test coins is a dry run and
//     a venue live against it would record real liabilities against worthless
//     assets.
//
// Plus the environment-mismatch diagnosis, because BitGo returns the same 401
// for "wrong installation", "IP not whitelisted" and "revoked token", and
// working that out by hand costs an afternoon.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { BitGoError, BitGoHoldings } from "../src/bitgo";
import { Ledger } from "../src/ledger";
import { preflight } from "../src/golive";
import { sourceFromEnv } from "../src/reconcilejob";
import { Venue, VenueError } from "../src/venue";

const TOKEN = "v2x-not-a-real-token";

/** A fake BitGo that recognises the token at exactly one installation. */
function host(which: "test" | "prod" | "neither"): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		const isTest = url.includes("bitgo-test.com");
		const recognised =
			which === "neither" ? false : which === "test" ? isTest : !isTest;
		return {
			ok: recognised,
			status: recognised ? 200 : 401,
			async json() {
				return recognised ? { user: { username: "ops@blockle.org" } } : { error: "No access token" };
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

test("the default pairing is the safe one", () => {
	// Neither set: test installation, testnet coins.
	const a = BitGoHoldings.fromEnv({ BITGO_ACCESS_TOKEN: TOKEN } as NodeJS.ProcessEnv);
	assert.deepEqual(a.describe(), { env: "test", coins: "testnet", realMoney: false });

	// Production installation alone implies mainnet coins.
	const b = BitGoHoldings.fromEnv({
		BITGO_ACCESS_TOKEN: TOKEN,
		BITGO_ENV: "prod",
	} as NodeJS.ProcessEnv);
	assert.deepEqual(b.describe(), { env: "prod", coins: "mainnet", realMoney: true });
});

test("A PRODUCTION ACCOUNT CAN HOLD TESTNET COINS, and that is not real money", () => {
	// The combination this split exists for.
	const h = BitGoHoldings.fromEnv({
		BITGO_ACCESS_TOKEN: TOKEN,
		BITGO_ENV: "prod",
		BITGO_COINS: "testnet",
	} as NodeJS.ProcessEnv);
	assert.deepEqual(h.describe(), { env: "prod", coins: "testnet", realMoney: false });
	// Testnet tickers, from the production installation.
	assert.equal(h.ticker("BTC"), "tbtc");
	assert.equal(h.ticker("ETH"), "teth");
	// And the name says so, because "bitgo:prod" alone would not tell an
	// operator whether the figures underneath are real.
	assert.equal(h.name, "bitgo:prod/testnet");
});

test("the matching pairings keep the plain name", () => {
	const t = new BitGoHoldings(TOKEN, { env: "test" });
	const p = new BitGoHoldings(TOKEN, { env: "prod" });
	assert.equal(t.name, "bitgo:test");
	assert.equal(p.name, "bitgo:prod");
});

test("mainnet coins on the test installation is expressible too", () => {
	// Not useful, but it must not be silently rewritten — a setting that does
	// not do what it says is worse than one that is odd.
	const h = new BitGoHoldings(TOKEN, { env: "test", coins: "mainnet" });
	assert.equal(h.ticker("BTC"), "btc");
	assert.equal(h.describe().realMoney, false);
});

test("a bad coin set is refused rather than defaulted", () => {
	assert.throws(
		() =>
			BitGoHoldings.fromEnv({
				BITGO_ACCESS_TOKEN: TOKEN,
				BITGO_COINS: "livenet",
			} as NodeJS.ProcessEnv),
		/BITGO_COINS must be/,
	);
	assert.throws(
		() =>
			BitGoHoldings.fromEnv({
				BITGO_ACCESS_TOKEN: TOKEN,
				BITGO_ENV: "production",
			} as NodeJS.ProcessEnv),
		/BITGO_ENV must be/,
	);
});

test("an unmapped asset is an error, never a confident zero", () => {
	const h = new BitGoHoldings(TOKEN, { env: "prod", coins: "testnet" });
	assert.throws(() => h.ticker("XTZ"), (e: unknown) => {
		assert.ok(e instanceof BitGoError);
		assert.match(String(e), /testnet coin set/);
		return true;
	});
	// Our own chains are refused with a reason rather than mapped.
	assert.throws(() => h.ticker("BLOCK"), /self-custodied/);
	assert.throws(() => h.ticker("PERBUG"), /self-custodied/);
});

test("A TOKEN AT THE WRONG INSTALLATION IS DIAGNOSED, not reported as broken", () => {
	// This is the real failure: BitGo's two systems both answer 401 for a
	// foreign token, so "wrong environment" and "bad token" look identical.
	const h = new BitGoHoldings(TOKEN, { env: "prod", fetchImpl: host("test") });
	return h.verifyEnvironment().then((v) => {
		assert.equal(v.ok, false);
		assert.equal(v.belongsTo, "test");
		assert.match(v.detail, /authenticates against the test installation/);
		assert.match(v.detail, /separate accounts with separate tokens/);
		// And it says what to do about it, both ways round.
		assert.match(v.detail, /set BITGO_ENV=test, or supply a prod token/);
	});
});

test("a matching token verifies", async () => {
	const h = new BitGoHoldings(TOKEN, { env: "prod", fetchImpl: host("prod") });
	const v = await h.verifyEnvironment();
	assert.equal(v.ok, true);
	assert.equal(v.belongsTo, "prod");
	assert.match(v.detail, /app\.bitgo\.com/);
});

test("a token at NEITHER installation names the likely cause", async () => {
	// On this box the commonest cause is the IP whitelist, not the token.
	const h = new BitGoHoldings(TOKEN, { env: "prod", fetchImpl: host("neither") });
	const v = await h.verifyEnvironment();
	assert.equal(v.ok, false);
	assert.equal(v.belongsTo, undefined);
	assert.match(v.detail, /NEITHER installation/);
	assert.match(v.detail, /IP that is not on the token's whitelist/);
});

// ---------------------------------------------------------------- the faucet

test("THE FAUCET IS REFUSED WHEN RECONCILIATION USES A LIVE CUSTODIAN", () => {
	// Not just on mainnet. It credits CUSTODY as well as the user, and a real
	// custodian would not report those coins — reconciliation reads the
	// difference as a shortfall and halts that asset permanently.
	const db = new Database(":memory:");
	const l = new Ledger(db);
	const v = new Venue(db, l, undefined, { liveCustodian: true });
	const { id } = v.register("a@x.com", "a-sufficiently-long-password");

	assert.throws(
		() => v.testnetCredit(id, "BTC", 100_000_000n, "BTC"),
		(e: unknown) => {
			assert.ok(e instanceof VenueError);
			assert.equal(e.status, 403);
			assert.match(String(e), /live custodian is configured/);
			assert.match(String(e), /read the difference as a shortfall/);
			return true;
		},
	);

	// And with no custodian it still works, which is the point of having it.
	const v2 = new Venue(db, l, undefined, {});
	const { id: id2 } = v2.register("b@x.com", "a-sufficiently-long-password");
	v2.testnetCredit(id2, "BTC", 100_000_000n, "BTC");
	assert.equal(v2.balances(id2).find((b) => b.asset === "BTC")?.total, 100_000_000n);
});

// ------------------------------------------------------------ the preflight

test("THE PREFLIGHT REQUIRES BOTH prod AND mainnet for real money", async () => {
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	const base = {
		db,
		ledger,
		configPath: "/nonexistent/gate.json",
		verifyCustodyEnv: async () => ({ ok: true, detail: "verified" }),
	};

	const dryRun = await preflight({
		...base,
		env: { BITGO_ACCESS_TOKEN: TOKEN, BITGO_ENV: "prod", BITGO_COINS: "testnet" },
	});
	const envCheck = dryRun.checks.find((c) => c.id === "custody:env")!;
	assert.equal(envCheck.pass, false, "prod + testnet coins is a dry run, not live");
	assert.match(envCheck.evidence, /Either alone is a dry run/);

	const live = await preflight({
		...base,
		env: { BITGO_ACCESS_TOKEN: TOKEN, BITGO_ENV: "prod", BITGO_COINS: "mainnet" },
	});
	assert.equal(live.checks.find((c) => c.id === "custody:env")!.pass, true);
});

test("the preflight treats an unverified token as a failure, not a pass", async () => {
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	// No verifier supplied at all: UNKNOWN.
	const r = await preflight({
		db,
		ledger,
		configPath: "/nonexistent/gate.json",
		env: { BITGO_ACCESS_TOKEN: TOKEN, BITGO_ENV: "prod", BITGO_COINS: "mainnet" },
	});
	const c = r.checks.find((x) => x.id === "custody:envmatch")!;
	assert.equal(c.pass, false);
	assert.equal(c.fundsCritical, true);
	assert.match(c.evidence, /UNKNOWN, which is a failure here rather than a pass/);
});

test("the preflight reports the faucet shut once a custodian is wired", async () => {
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	const mk = (env: Record<string, string>) =>
		preflight({
			db,
			ledger,
			configPath: "/nonexistent/gate.json",
			verifyCustodyEnv: async () => ({ ok: true, detail: "verified" }),
			env,
		});

	// A TOKEN ALONE IS NOT ENOUGH, and that is the correction. The first
	// version keyed the faucet off the token being present; a token can be
	// configured while reconciliation still reads the declared file, and in
	// that combination the faucet is harmless and is the only way to fund a
	// test account.
	const tokenOnly = await mk({ BITGO_ACCESS_TOKEN: TOKEN, BITGO_ENV: "prod" });
	const t = tokenOnly.checks.find((c) => c.id === "faucet:shut")!;
	assert.equal(t.pass, false, "a token without RECONCILE_SOURCE=bitgo leaves it open");
	assert.match(t.evidence, /DECLARED FILE/);

	const reconciling = await mk({
		BITGO_ACCESS_TOKEN: TOKEN,
		BITGO_ENV: "prod",
		RECONCILE_SOURCE: "bitgo",
	});
	assert.equal(reconciling.checks.find((c) => c.id === "faucet:shut")!.pass, true);
	assert.equal(
		reconciling.checks.find((c) => c.id === "reconcile:source")!.pass,
		true,
	);

	// And reconciling against a file is reported as not reconciling at all.
	const declared = await mk({ RECONCILE_SOURCE: "declared" });
	const d = declared.checks.find((x) => x.id === "reconcile:source")!;
	assert.equal(d.pass, false);
	assert.match(d.evidence, /tautological for a live venue/);
});

test("an unrecognised RECONCILE_SOURCE is refused, not defaulted", () => {
	// A typo must not silently become "declared", which would turn a live
	// venue's solvency check into a self-referential one.
	assert.throws(
		() => sourceFromEnv({ RECONCILE_SOURCE: "bitgoo" } as NodeJS.ProcessEnv),
		/RECONCILE_SOURCE must be/,
	);
	assert.equal(sourceFromEnv({} as NodeJS.ProcessEnv), undefined);
	assert.equal(sourceFromEnv({ RECONCILE_SOURCE: " BitGo " } as NodeJS.ProcessEnv), "bitgo");
});
