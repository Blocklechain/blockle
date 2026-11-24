// -----------------------------------------------------------------------------
// Tests for authentication against the Blockle account system.
//
// The cases that matter are the failure modes, because every one of them has a
// tempting wrong answer: an unreachable account service could "fall back", a
// missing id could "use the email", a 500 could be "treated as logged out".
// Each of those is a security or a data-loss bug, so each is pinned.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthError, BlockleAuth, extractUser } from "../src/blockleauth";

const COOKIE = "blockle_sid=abc123; theme=dark";

/** A fake accounts service. */
function svc(
	handler: (req: { url: string; headers: Record<string, unknown> }) =>
		| { status?: number; body: unknown }
		| Error,
): { impl: typeof fetch; calls: { url: string; cookie: unknown }[] } {
	const calls: { url: string; cookie: unknown }[] = [];
	const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		const headers = (init.headers ?? {}) as Record<string, unknown>;
		calls.push({ url, cookie: headers.Cookie });
		const out = handler({ url, headers });
		if (out instanceof Error) throw out;
		const status = out.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			async json() {
				return out.body;
			},
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

const cfg = (impl: typeof fetch, over = {}) => ({
	base: "https://blockle.org",
	fetchImpl: impl,
	...over,
});

test("a valid session resolves to the account id", async () => {
	const { impl, calls } = svc(() => ({
		body: { csrf: "tok", user: { id: "acct_42", email: "a@x.com" } },
	}));
	const a = new BlockleAuth(cfg(impl));
	const u = await a.whoami(COOKIE);

	assert.equal(u.id, "acct_42");
	assert.equal(u.email, "a@x.com");
	assert.equal(u.csrf, "tok");
	// It asks the accounts service, at its own endpoint.
	assert.match(calls[0]!.url, /\/account\/api\/me$/);
});

test("THE COOKIE IS FORWARDED WHOLE, never parsed here", async () => {
	// This service does not know which cookie carries the session, and must
	// not: hard-coding the name would break silently the day it changes.
	const { impl, calls } = svc(() => ({ body: { user: { id: "u1" } } }));
	await new BlockleAuth(cfg(impl)).whoami(COOKIE);
	assert.equal(calls[0]!.cookie, COOKIE, "the entire header, verbatim");
});

test("no cookie is simply not signed in", async () => {
	const { impl, calls } = svc(() => ({ body: {} }));
	const a = new BlockleAuth(cfg(impl));
	for (const c of [undefined, "", "   "]) {
		await assert.rejects(() => a.whoami(c), /not signed in/);
	}
	assert.equal(calls.length, 0, "and does not bother the accounts service");
});

test("401 from the accounts service is not signed in", async () => {
	const { impl } = svc(() => ({ status: 401, body: { error: "no session" } }));
	await assert.rejects(
		() => new BlockleAuth(cfg(impl)).whoami(COOKIE),
		(e: unknown) => {
			assert.ok(e instanceof AuthError);
			assert.equal(e.status, 401);
			return true;
		},
	);
});

test("AN UNREACHABLE ACCOUNTS SERVICE IS 503, NOT ANONYMOUS", async () => {
	// The tempting wrong answer is to fall back to some local account table or
	// to treat the caller as a guest. An auth system that degrades to "allow"
	// under load is not an auth system.
	const { impl } = svc(() => new Error("ECONNREFUSED"));
	await assert.rejects(
		() => new BlockleAuth(cfg(impl)).whoami(COOKIE),
		(e: unknown) => {
			assert.ok(e instanceof AuthError);
			assert.equal(e.status, 503, "503, not 401 and certainly not success");
			assert.match(String(e), /refusing to guess who you are/);
			return true;
		},
	);
});

test("a 500 from the accounts service is 503, not 'logged out'", async () => {
	// Reporting "logged out" for a server fault sends the customer round a
	// sign-in loop that cannot succeed and tells them nothing true.
	const { impl } = svc(() => ({ status: 500, body: {} }));
	await assert.rejects(
		() => new BlockleAuth(cfg(impl)).whoami(COOKIE),
		(e: unknown) => {
			assert.equal((e as AuthError).status, 503);
			return true;
		},
	);
});

test("A MISSING ACCOUNT ID IS A HARD ERROR — never fall back to the email", async () => {
	// Keying ledger balances on an email means a customer who changes their
	// address loses their money. That is the worst bug this file could have.
	assert.throws(
		() => extractUser({ user: { email: "a@x.com" } }),
		/stable account id/,
	);
	// And it is reported as a service fault, not as "not signed in", because
	// the session was valid — the response was not.
	try {
		extractUser({ user: { email: "a@x.com" } });
		assert.fail("should throw");
	} catch (e) {
		assert.equal((e as AuthError).status, 503);
	}
});

test("the envelope shape is tolerated; the id field is not negotiable", async () => {
	// Different revisions of the accounts service have returned the user
	// nested and bare, and the id under several names.
	assert.equal(extractUser({ user: { id: "a" } }).id, "a");
	assert.equal(extractUser({ id: "b" }).id, "b");
	assert.equal(extractUser({ user: { accountId: "c" } }).id, "c");
	assert.equal(extractUser({ user: { account_id: "d" } }).id, "d");
	assert.equal(extractUser({ user: { uid: "e" } }).id, "e");
	// Blank is not an id.
	assert.throws(() => extractUser({ user: { id: "   " } }), /stable account id/);
	assert.throws(() => extractUser(null), /malformed/);
	assert.throws(() => extractUser("nope"), /malformed/);
});

test("a verified session is CACHED, so the trading UI does not hammer accounts", async () => {
	// The UI refreshes every four seconds; without a cache a handful of open
	// tabs becomes sustained load on an unrelated service.
	let now = 1_000_000;
	const { impl, calls } = svc(() => ({ body: { user: { id: "u1" } } }));
	const a = new BlockleAuth(cfg(impl, { cacheMs: 15_000 }), () => now);

	for (let i = 0; i < 5; i++) await a.whoami(COOKIE);
	assert.equal(calls.length, 1, "one lookup for five calls");

	now += 16_000;
	await a.whoami(COOKIE);
	assert.equal(calls.length, 2, "and it re-checks once the window passes");
});

test("forget() makes a sign-out take effect immediately", async () => {
	let now = 1_000_000;
	const { impl, calls } = svc(() => ({ body: { user: { id: "u1" } } }));
	const a = new BlockleAuth(cfg(impl, { cacheMs: 60_000 }), () => now);
	await a.whoami(COOKIE);
	a.forget(COOKIE);
	await a.whoami(COOKIE);
	assert.equal(calls.length, 2, "the cache was dropped");
});

test("different cookies are cached separately", async () => {
	let n = 0;
	const { impl } = svc(() => ({ body: { user: { id: `u${++n}` } } }));
	const a = new BlockleAuth(cfg(impl, { cacheMs: 60_000 }));
	const one = await a.whoami("sid=A");
	const two = await a.whoami("sid=B");
	assert.notEqual(one.id, two.id, "one session must not answer for another");
});

test("a hung accounts service is abandoned rather than hanging the exchange", async () => {
	const impl = ((_i: string | URL | Request, init: RequestInit = {}) =>
		new Promise<Response>((_res, rej) => {
			const sig = init.signal;
			const fail = (): void => {
				const e = new Error("The operation was aborted.");
				e.name = "AbortError";
				rej(e);
			};
			if (sig?.aborted === true) return fail();
			sig?.addEventListener("abort", fail, { once: true });
		})) as unknown as typeof fetch;

	const a = new BlockleAuth(cfg(impl, { timeoutMs: 40 }));
	const started = Date.now();
	await assert.rejects(() => a.whoami(COOKIE), /unreachable/);
	assert.ok(Date.now() - started < 2_000, "the abort took effect");
});

test("the cache does not store the cookie in plaintext", async () => {
	// A heap dump or a serialised error must not yield live session cookies.
	const { impl } = svc(() => ({ body: { user: { id: "u1" } } }));
	const a = new BlockleAuth(cfg(impl));
	await a.whoami(COOKIE);
	const dumped = JSON.stringify(a, (_k, v) =>
		v instanceof Map ? [...v.keys()] : v,
	);
	assert.doesNotMatch(dumped, /abc123/, "the raw cookie value must not appear");
});
