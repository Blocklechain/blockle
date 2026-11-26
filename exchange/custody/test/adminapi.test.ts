// -----------------------------------------------------------------------------
// ADMIN API TESTS.
//
// What is being protected here is "move the exchange's money" and "read the
// exchange's position", so the tests are mostly about who is refused:
//
//   * an unconfigured allowlist admits NOBODY (not everybody);
//   * a valid Blockle session that is not on the list gets a 404, not a 403,
//     because confirming the endpoint exists is itself information;
//   * reads need the session; mutations need a fresh, single-use code;
//   * an allowlisted operator with no authenticator can look but not act.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { IncomingMessage, ServerResponse } from "node:http";

import { SCHEMA, adminRoute, allowlistFrom, totpSecretsFrom, type AdminDeps } from "../src/adminapi";
import { BlockleAuth } from "../src/blockleauth";
import { LIVE_GAS_COSTS } from "../src/gasgate";
import { GAS_PRICE_FLOOR, StaticRates } from "../src/gasrates";
import { Customers } from "../src/customers";
import { AccountKind, Ledger, Reason } from "../src/ledger";
import { currentCode, generateSecret } from "../src/totp";
import { LIVE_FEES, type GasPricing } from "../src/withdrawalfees";
import { fundGasFloat } from "../src/revenue";
import type { ReconcilerState, ReservationSource } from "../src/treasury";

const SECRET = generateSecret();

/*
 * A FRESH OPERATOR IDENTITY PER TEST.
 *
 * The TOTP verifier in adminapi.ts is a module singleton with single-use
 * counters, which is exactly right in production and means two tests in the
 * same 30-second window cannot both spend the same (identity, counter) pair.
 * The first draft of this file shared one id and the later tests failed with
 * "already been used" — the code working, not the test.
 */
let seq = 0;
const freshAdmin = (): string => `acct_admin_${++seq}`;
const ADMIN_ID = "acct_admin";

/** An accounts service that recognises one session cookie. */
function auth(signedInAs: string | undefined): BlockleAuth {
	const impl = (async () => {
		if (signedInAs === undefined) {
			return { ok: false, status: 401, async json() { return {}; } } as unknown as Response;
		}
		return {
			ok: true,
			status: 200,
			async json() {
				return { user: { id: signedInAs, email: `${signedInAs}@blockle.org` } };
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return new BlockleAuth({ base: "https://blockle.org", fetchImpl: impl, cacheMs: 0 });
}

interface Captured {
	status: number;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

/** Drive adminRoute without a real socket. */
async function call(
	method: string,
	path: string,
	opts: {
		signedInAs?: string | undefined;
		allowlist?: readonly string[];
		secrets?: Readonly<Record<string, string>>;
		code?: string;
		body?: unknown;
		ledger?: Ledger;
		db?: Database.Database;
		adminId?: string;
		reservations?: ReservationSource;
		reconciler?: ReconcilerState;
	} = {},
): Promise<Captured> {
	const adminId = opts.adminId ?? ADMIN_ID;
	const db = opts.db ?? new Database(":memory:");
	const ledger = opts.ledger ?? new Ledger(db);
	db.exec(SCHEMA);

	const pricing: GasPricing = { sources: [new StaticRates(GAS_PRICE_FLOOR)] };
	const deps: AdminDeps = {
		db,
		ledger,
		auth: auth("signedInAs" in opts ? opts.signedInAs : adminId),
		gas: { ledger, pendingOnChain: () => 0, table: LIVE_GAS_COSTS },
		feeTable: LIVE_FEES,
		pricing,
		rates: [new StaticRates(GAS_PRICE_FLOOR)],
		allowlist: opts.allowlist ?? [adminId],
		customers: new Customers(db, ledger),
		totpSecrets: opts.secrets ?? { [adminId]: SECRET },
		houseAccountId: "house",
		// NO RESERVATIONS AND NO RECONCILER PASS, by default. A test double that
		// invented a halt set would make the treasury route look verified; this
		// one is honest about having checked nothing, which is also the state a
		// freshly-installed box is in.
		reservations: opts.reservations ?? {
			reservationsByAsset: () => ({ byAsset: new Map(), skipped: 0 }),
		},
		reconcilerState: () =>
			opts.reconciler ?? {
				halted: {},
				lastPassAt: undefined,
				unavailableReason: "no halt file in this test",
			},
	};

	const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
	const req = {
		method,
		headers: {
			cookie: "signedInAs" in opts && opts.signedInAs === undefined ? undefined : "blockle_sid=x",
			...(opts.code === undefined ? {} : { "x-admin-totp": opts.code }),
		},
		async *[Symbol.asyncIterator]() {
			if (payload !== undefined) yield Buffer.from(payload);
		},
	} as unknown as IncomingMessage;

	let status = 0;
	let out = "";
	const headers: Record<string, string> = {};
	const res = {
		writeHead(code: number, h: Record<string, string>) {
			status = code;
			Object.assign(headers, h);
			return this;
		},
		end(chunk?: string) {
			out = chunk ?? "";
		},
	} as unknown as ServerResponse;

	const handled = await adminRoute(req, res, new URL(`http://x${path}`), deps);
	assert.equal(handled, true, `${path} should be handled by the admin router`);
	return { status, body: JSON.parse(out || "{}") as Record<string, unknown>, headers };
}

test("AN UNCONFIGURED ALLOWLIST ADMITS NOBODY", () => {
	// The dangerous default would be "anyone with a Blockle account can read
	// the venue's revenue and sweep its fees".
	return call("GET", "/admin/api/revenue", { allowlist: [] }).then((r) => {
		assert.equal(r.status, 503);
		assert.match(String(r.body.error), /nobody is an administrator/);
		assert.match(String(r.body.error), /fails closed/);
	});
});

test("A VALID SESSION THAT IS NOT AN OPERATOR GETS 404, NOT 403", async () => {
	// A 403 confirms the endpoint exists and that this account is merely not on
	// the list. That is information, and the caller has no right to it.
	const r = await call("GET", "/admin/api/revenue", {
		signedInAs: "acct_customer",
		allowlist: [ADMIN_ID],
	});
	assert.equal(r.status, 404);
	assert.equal(r.body.error, "not found");
});

test("no session at all is a 401 from the auth layer", async () => {
	const r = await call("GET", "/admin/api/revenue", { signedInAs: undefined });
	assert.equal(r.status, 401);
});

test("the allowlist accepts an email too, but the id is what matches", async () => {
	// Emails are accepted for convenience; the account id is the stable key.
	const byEmail = await call("GET", "/admin/api/me", {
		allowlist: [`${ADMIN_ID}@blockle.org`],
	});
	assert.equal(byEmail.status, 200);
	assert.equal(byEmail.body.accountId, ADMIN_ID);

	const byId = await call("GET", "/admin/api/me", { allowlist: [ADMIN_ID] });
	assert.equal(byId.status, 200);
});

test("reads work with a session and no code", async () => {
	for (const path of ["/admin/api/revenue", "/admin/api/gas", "/admin/api/fee-coverage", "/admin/api/actions"]) {
		const r = await call("GET", path);
		assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
	}
});

test("A MUTATION WITHOUT A CODE IS REFUSED", async () => {
	const r = await call("POST", "/admin/api/sweep", {
		body: { asset: "USDT", amount: "1", requestId: "r1" },
	});
	assert.equal(r.status, 401);
	assert.match(String(r.body.error), /current authenticator code is required/);
});

test("a wrong code is refused", async () => {
	const r = await call("POST", "/admin/api/sweep", {
		code: "000000",
		body: { asset: "USDT", amount: "1", requestId: "r1" },
	});
	assert.equal(r.status, 401);
	assert.match(String(r.body.error), /not valid, or has already been used/);
});

test("AN OPERATOR WITH NO AUTHENTICATOR CAN READ BUT NOT ACT", async () => {
	// The alternative is letting an un-enrolled admin move money with a cookie
	// alone, which is the whole thing the code is there to prevent.
	const read = await call("GET", "/admin/api/me", { secrets: {} });
	assert.equal(read.status, 200);
	assert.equal(read.body.canAct, false, "the console disables its buttons on this");

	const act = await call("POST", "/admin/api/fund-gas", {
		adminId: freshAdmin(),
		secrets: {},
		code: currentCode(SECRET),
		body: { gasAsset: "ETH", amount: "1", requestId: "r1" },
	});
	assert.equal(act.status, 403);
	assert.match(String(act.body.error), /no authenticator enrolled/);
});

test("AN AUTHENTICATOR KEYED BY EMAIL WORKS, like the allowlist", async () => {
	// THE TRAP THIS CLOSES, found on the live box while bringing the venue up.
	//
	// `operator()` admits a caller whose id OR email is on EXCHANGE_ADMINS, so
	// configuring it with an email is the obvious thing to do — and is what the
	// box actually had. But the TOTP map used to be read by id alone, so that
	// operator passed the allowlist, could read the console, and would have been
	// told "no authenticator enrolled" the moment they tried to act.
	//
	// The go-live preflight made it worse by only checking that
	// EXCHANGE_ADMIN_TOTP is a non-empty string: it reported "Operator 2FA is
	// enrolled" while every mutation would have been refused. A second factor
	// that is configured and unreachable looks exactly like one that works,
	// right up until someone needs it.
	const id = freshAdmin();
	const email = `${id}@blockle.org`;   // what the test harness's auth returns

	const read = await call("GET", "/admin/api/me", {
		adminId: id,
		allowlist: [email],              // allowlisted by EMAIL
		secrets: { [email]: SECRET },    // and the secret keyed by EMAIL too
	});
	assert.equal(read.status, 200);
	assert.equal(read.body.canAct, true, "canAct must not depend on the key shape");

	const act = await call("POST", "/admin/api/fund-gas", {
		adminId: id,
		allowlist: [email],
		secrets: { [email]: SECRET },
		code: currentCode(SECRET),
		body: { gasAsset: "ETH", amount: "1", requestId: "r-email" },
	});
	assert.notEqual(act.status, 403, `must not refuse: ${JSON.stringify(act.body)}`);
});

test("an id-keyed secret still wins over an email-keyed one", async () => {
	// Id first, so an explicit per-account entry beats a shared email entry.
	const id = freshAdmin();
	const email = `${id}@blockle.org`;
	const other = generateSecret();
	const act = await call("POST", "/admin/api/fund-gas", {
		adminId: id,
		allowlist: [id],
		secrets: { [id]: SECRET, [email]: other },
		code: currentCode(SECRET),      // the ID's code
		body: { gasAsset: "ETH", amount: "1", requestId: "r-id" },
	});
	assert.notEqual(act.status, 403, `the id secret must be used: ${JSON.stringify(act.body)}`);
});

test("funding a gas float works, and says it did not move any coins", async () => {
	// The two halves of this are easy to conflate, and conflating them produces
	// a reconciliation shortfall nobody expected.
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	const admin = freshAdmin();
	const r = await call("POST", "/admin/api/fund-gas", {
		db,
		ledger,
		adminId: admin,
		code: currentCode(SECRET),
		body: { gasAsset: "ETH", amount: "0.5", requestId: "fund-1" },
	});
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.match(String(r.body.note), /does NOT move coins/);
	assert.match(String(r.body.note), /shortfall/);

	// And it is on the books.
	const gas = await call("GET", "/admin/api/gas", { db, ledger, adminId: admin });
	const rows = gas.body.positions as { chain: string; float: string }[];
	assert.equal(rows.find((x) => x.chain === "USDT.ERC20")?.float, "0.5");
});

test("A SWEEP CANNOT TAKE THE GAS FLOAT, even when the operator asks", async () => {
	// The reserve is computed from the gas table rather than taken from the
	// request, so "sweep everything" cannot strand the chains that earn it.
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	fundGasFloat(ledger, {
		gasAsset: "ETH",
		amount: 50_000_000_000_000_000n, // 0.05 ETH — under the ERC-20 reserve
		actor: "treasury",
		idempotencyKey: "f1",
	});
	const r = await call("POST", "/admin/api/sweep", {
		db,
		ledger,
		adminId: freshAdmin(),
		code: currentCode(SECRET),
		body: { asset: "ETH", amount: "0.05", requestId: "s1" },
	});
	assert.equal(r.status, 400, JSON.stringify(r.body));
	assert.match(String(r.body.error), /reserved as a gas float/);
});

test("EVERY MUTATION IS JOURNALLED, attempt and outcome both", async () => {
	// An admin action nobody can reconstruct afterwards cannot be investigated.
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	const admin = freshAdmin();
	await call("POST", "/admin/api/fund-gas", {
		db,
		ledger,
		adminId: admin,
		code: currentCode(SECRET),
		body: { gasAsset: "TRX", amount: "100", requestId: "f1" },
	});
	const rows = db
		.prepare(`SELECT actor, action, outcome FROM admin_action ORDER BY id`)
		.all() as { actor: string; action: string; outcome: string | null }[];
	assert.equal(rows.length, 2, "the attempt and its result");
	assert.equal(rows[0]!.action, "fund-gas");
	assert.equal(rows[0]!.actor, admin);
	assert.equal(rows[1]!.action, "fund-gas:result");
	assert.equal(rows[1]!.outcome, "ok");
});

test("a FAILED mutation is journalled too", async () => {
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	await call("POST", "/admin/api/sweep", {
		db,
		ledger,
		adminId: freshAdmin(),
		code: currentCode(SECRET),
		body: { asset: "USDT", amount: "999", requestId: "s1" },
	});
	const rows = db
		.prepare(`SELECT action, outcome FROM admin_action ORDER BY id`)
		.all() as { action: string; outcome: string | null }[];
	assert.equal(rows.length, 2);
	assert.match(String(rows[1]!.outcome), /^failed: /);
});

test("THE JOURNAL CANNOT BE EDITED OR DELETED", () => {
	const db = new Database(":memory:");
	db.exec(SCHEMA);
	db.prepare(
		`INSERT INTO admin_action (actor, action, detail, at) VALUES (?, ?, ?, ?)`,
	).run("a", "b", "{}", "2026-01-01T00:00:00.000Z");
	assert.throws(() => db.exec(`UPDATE admin_action SET actor = 'x'`), /append-only/);
	assert.throws(() => db.exec(`DELETE FROM admin_action`), /append-only/);
});

test("an unknown admin path is 404 rather than falling through", async () => {
	const r = await call("GET", "/admin/api/drop-tables");
	assert.equal(r.status, 404);
});

test("admin responses are never cached", async () => {
	// A revenue figure served from a cache is wrong, and a shared cache would
	// serve it to the wrong person.
	const r = await call("GET", "/admin/api/revenue");
	assert.match(r.headers["cache-control"] ?? "", /no-store/);
	assert.match(r.headers["cache-control"] ?? "", /private/);
});

test("the config parsers treat absent configuration as empty, not as a wildcard", () => {
	assert.deepEqual(allowlistFrom(undefined), []);
	assert.deepEqual(allowlistFrom(""), []);
	assert.deepEqual(allowlistFrom("a, b  c"), ["a", "b", "c"]);
	assert.deepEqual(totpSecretsFrom(undefined), {});
	// A malformed entry is dropped rather than producing an empty secret, which
	// would read as "enrolled" while accepting nothing.
	assert.deepEqual(totpSecretsFrom("id1=ABC, broken, id2="), { id1: "ABC" });
});

// -----------------------------------------------------------------------------
// THE TREASURY ROUTES.
//
// The treasury view shows every customer's balance in one response, which
// makes it the most sensitive read in the product. The only question these
// tests ask of the ROUTE (treasury.test.ts tests the arithmetic) is who it
// refuses, and that it refuses them in the same way and with the same wording
// as everything else here — because a new endpoint that answers 403 where its
// neighbours answer 404 is itself a disclosure.
// -----------------------------------------------------------------------------

test("THE TREASURY VIEW REFUSES AN UNAUTHENTICATED CALLER", async () => {
	for (const path of [
		"/admin/api/treasury",
		"/admin/api/treasury/BTC/customers",
	]) {
		const r = await call("GET", path, { signedInAs: undefined });
		assert.equal(r.status, 401, path);
		// Nothing about assets, balances or customers in the refusal body.
		assert.doesNotMatch(JSON.stringify(r.body), /custody|balance|holder/i, path);
	}
});

test("THE TREASURY VIEW REFUSES A SIGNED-IN NON-ADMIN WITH 404, NOT 403", async () => {
	// Same answer a nonexistent route gives. A 403 would confirm that a
	// treasury endpoint exists and that this account is merely not on the list,
	// which tells an attacker where to point a stolen cookie next.
	for (const path of [
		"/admin/api/treasury",
		"/admin/api/treasury/BTC/customers",
	]) {
		const r = await call("GET", path, {
			signedInAs: "acct_customer",
			allowlist: [ADMIN_ID],
		});
		assert.equal(r.status, 404, path);
		assert.equal(r.body.error, "not found", path);
	}
});

test("an unconfigured allowlist admits nobody to the treasury view either", async () => {
	const r = await call("GET", "/admin/api/treasury", { allowlist: [] });
	assert.equal(r.status, 503);
	assert.match(String(r.body.error), /nobody is an administrator/);
});

test("an operator reads the treasury view with a session and no code", async () => {
	// Consistent with every other read here: reads need the session and the
	// allowlist, not an authenticator code.
	const r = await call("GET", "/admin/api/treasury");
	assert.equal(r.status, 200, JSON.stringify(r.body));
	const assets = r.body.assets as Array<Record<string, unknown>>;
	// Every registry asset is present, including the empty rails — an operator
	// needs to see that a rail is empty, which is not the same as missing.
	assert.ok(assets.length >= 14, `only ${assets.length} assets`);
	assert.ok(assets.some((a) => a.asset === "BLOCK"));
	assert.equal(r.body.booksBalance, true);
	// Not cached, and not shareable.
	assert.match(r.headers["cache-control"] ?? "", /no-store/);
	assert.match(r.headers["cache-control"] ?? "", /private/);
	// AND NO CORS HEADER. publicapi.ts's `json()` helper sends
	// `Access-Control-Allow-Origin: *` on every response it writes; the admin
	// surface uses its own `send()` and must never acquire one, or a page on
	// any origin could read every customer's balance out of a logged-in
	// operator's browser.
	assert.equal(r.headers["Access-Control-Allow-Origin"], undefined);
	assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("an operator reads the per-asset drill-down with a session and no code", async () => {
	const r = await call("GET", "/admin/api/treasury/BTC/customers");
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.equal(r.body.asset, "BTC");
	assert.deepEqual(r.body.holders, []);
	assert.equal(r.body.agrees, true);
});

test("the drill-down's asset is bounded by the route pattern, not by the handler", async () => {
	/*
	 * A path that is not a short uppercase token never reaches the query at
	 * all: no stray character, no over-long symbol, no extra segment.
	 *
	 * `/treasury/../customers` is deliberately NOT in this list, and it is
	 * worth saying why rather than leaving someone to add it. `new URL()`
	 * resolves the `..` before `adminRoute` ever sees a pathname, so that
	 * request arrives as `/admin/api/customers` and is answered by the
	 * customer directory — which sits behind the same operator allowlist, so
	 * nothing is bypassed. Asserting a 404 there would be asserting a fact
	 * about URL normalisation, and it would start failing the day the
	 * directory route was renamed.
	 */
	for (const bad of [
		"/admin/api/treasury/BTC%20ETH/customers",
		"/admin/api/treasury/ThisAssetSymbolIsFarTooLongToBeReal/customers",
		"/admin/api/treasury/BTC/customers/extra",
	]) {
		const r = await call("GET", bad);
		assert.equal(r.status, 404, `${bad} -> ${JSON.stringify(r.body)}`);
	}
});

test("THE TREASURY ROUTES ARE READ-ONLY: A POST IS NOT A ROUTE", async () => {
	// There is deliberately no mutating treasury endpoint. Freezing or
	// crediting an account needs its own code-gated action and its own audit
	// row; putting one on the screen an operator refreshes during an incident
	// is how a mis-click becomes a loss.
	for (const path of [
		"/admin/api/treasury",
		"/admin/api/treasury/BTC/customers",
	]) {
		const r = await call("POST", path, { code: currentCode(SECRET), body: {} });
		assert.equal(r.status, 404, path);
	}
});

test("NO CUSTOMER IDENTIFIER REACHES A LOG LINE THROUGH THE ROUTE", async () => {
	/*
	 * treasury.test.ts asserts this of the module; this asserts it of the
	 * HTTP path, which is where the logging in this service actually happens
	 * (publicapi.ts prints a raw account id on its deposit-address routes, so
	 * the mistake is one already made next door rather than a hypothetical).
	 *
	 * Every console method is captured, because a console.error on a failure
	 * path leaks exactly as much as a console.log on a happy one and systemd
	 * puts both in the same journal.
	 */
	const SECRET_ID = "acct_zzz_distinctive_9f3a2b";
	const db = new Database(":memory:");
	const ledger = new Ledger(db);
	ledger.post({
		reason: Reason.DEPOSIT,
		postings: [
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "BTC" }, delta: -500n },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: "BTC" }, delta: 500n },
			{ account: { kind: AccountKind.USER, owner: SECRET_ID, asset: "BTC" }, delta: 500n },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: "BTC" }, delta: -500n },
		],
		idempotencyKey: "dep:1",
		actor: "test",
	});

	const captured: string[] = [];
	const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
	const saved = methods.map((m) => console[m]);
	for (const m of methods) {
		console[m] = (...args: unknown[]): void => {
			captured.push(args.map((a) => String(a)).join(" "));
		};
	}
	let body: Record<string, unknown>;
	try {
		const r = await call("GET", "/admin/api/treasury/BTC/customers", { db, ledger });
		assert.equal(r.status, 200);
		body = r.body;
	} finally {
		methods.forEach((m, i) => {
			console[m] = saved[i]!;
		});
	}

	// The id really was returned in the BODY — otherwise "nothing was logged"
	// would be trivially true of a route that read nothing.
	assert.match(JSON.stringify(body), new RegExp(SECRET_ID));
	assert.deepEqual(captured, [], `logged: ${captured.join(" | ")}`);
});
