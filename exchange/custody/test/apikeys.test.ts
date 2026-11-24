// -----------------------------------------------------------------------------
// TRADE API KEY TESTS.
//
// The first test is the one that matters: A KEY CANNOT WITHDRAW. Every large
// exchange theft through an API went through a key with withdrawal rights, and
// the defence here is that the scope does not exist — so the test asserts the
// refusal rather than asserting a default is off, because a default can be
// changed by someone who does not know why it was set.
//
// Then the signature: each component of the signed string is checked by moving
// it and watching verification fail, because a signature that ignores the path
// or the body is a signature that can be lifted onto another request.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { ApiKeyError, ApiKeys, SCOPES, SKEW_MS, sign, signingString } from "../src/apikeys";

function setup(start = 1_700_000_000_000): {
	keys: ApiKeys;
	advance: (ms: number) => void;
	at: () => number;
} {
	let t = start;
	const db = new Database(":memory:");
	return { keys: new ApiKeys(db, () => t), advance: (ms) => { t += ms; }, at: () => t };
}

/** A signed request, as a client would build it. */
function req(
	secret: string,
	o: { method?: string; path?: string; body?: string; timestamp?: number },
	at: number,
) {
	const method = o.method ?? "GET";
    const path = o.path ?? "/v1/balances";
	const body = o.body ?? "";
	const timestamp = String(o.timestamp ?? at);
	return {
		signature: sign(secret, { timestamp, method, path, body }),
		timestamp,
		method,
		path,
		body,
	};
}

// --------------------------------------------------------------- the big one

test("A KEY CANNOT BE GIVEN WITHDRAWAL RIGHTS, and the refusal says why", () => {
	const { keys } = setup();
	for (const bad of ["withdraw", "withdrawal", "WITHDRAW", " Withdraw "]) {
		assert.throws(
			() => keys.create({ userId: "alice", label: "bot", scopes: ["trade", bad] }),
			(e: unknown) => {
				assert.ok(e instanceof ApiKeyError);
				assert.equal(e.status, 400);
				assert.match(String(e), /cannot withdraw/);
				// It explains the reasoning rather than just refusing, so nobody
				// adds the scope later thinking it was an oversight.
				assert.match(String(e), /went through a key with withdrawal rights/);
				assert.match(String(e), /your session and your second factor/);
				return true;
			},
			bad,
		);
	}
	// And there is no such scope to ask for in the first place.
	assert.deepEqual([...SCOPES], ["read", "trade"]);
});

test("an unknown scope is refused rather than silently dropped", () => {
	const { keys } = setup();
	assert.throws(
		() => keys.create({ userId: "alice", label: "bot", scopes: ["admin"] }),
		/unknown scope "admin"/,
	);
});

test("no scopes at all defaults to read, not to everything", () => {
	const { keys } = setup();
	const { key } = keys.create({ userId: "alice", label: "bot", scopes: [] });
	assert.deepEqual([...key.scopes], ["read"]);
});

// ---------------------------------------------------------------- the secret

test("THE SIGNING KEY IS RETURNED ONCE and never appears in a listing", () => {
	const { keys } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["trade"] });
	assert.ok(made.secret.length >= 40, "32 bytes, base64url");

	const listed = keys.list("alice");
	assert.equal(listed.length, 1);
	assert.equal(JSON.stringify(listed).includes(made.secret), false,
		"the signing key must not be readable afterwards");
	assert.equal(JSON.stringify(keys.get(made.keyId)).includes(made.secret), false);
});

test("two keys never share an id or a signing key", () => {
	const { keys } = setup();
	const a = keys.create({ userId: "alice", label: "one", scopes: ["read"] });
	const b = keys.create({ userId: "alice", label: "two", scopes: ["read"] });
	assert.notEqual(a.keyId, b.keyId);
	assert.notEqual(a.secret, b.secret);
	// And the id is not derivable from the secret or vice versa.
	assert.equal(a.keyId.startsWith("bk_"), true);
	assert.equal(a.secret.includes(a.keyId), false);
});

// ------------------------------------------------------------- the signature

test("a correctly signed request authenticates", () => {
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read", "trade"] });
	const r = req(made.secret, {}, at());
	const got = keys.authenticate({ keyId: made.keyId, ...r, need: "read" });
	assert.equal(got.userId, "alice");
	// And it records when, so an unused key is visible as unused.
	assert.notEqual(keys.get(made.keyId)?.lastUsedAt, null);
});

test("EVERY PART OF THE SIGNED STRING IS BOUND", () => {
	// A signature that ignored any of these could be lifted from a harmless
	// request onto a harmful one.
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read", "trade"] });
	const good = req(made.secret, { method: "POST", path: "/v1/orders", body: '{"a":1}' }, at());

	// The method cannot be swapped.
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...good, method: "GET", need: "trade" }),
		/signature mismatch/,
	);
	// Nor the path — this is the one that would move a balance read onto an
	// order placement.
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...good, path: "/v1/balances", need: "trade" }),
		/signature mismatch/,
	);
	// Nor the body, so an order cannot be edited in flight.
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...good, body: '{"a":999}', need: "trade" }),
		/signature mismatch/,
	);
	// Nor the timestamp.
	assert.throws(
		() => keys.authenticate({
			keyId: made.keyId, ...good, timestamp: String(at() - 1), need: "trade",
		}),
		/signature mismatch/,
	);
});

test("the signing string is exactly what the docs claim", () => {
	// Exported so the documentation and the verifier cannot drift apart.
	const body = '{"market":"BTC-USDT"}';
	assert.equal(
		signingString({ timestamp: "123", method: "post", path: "/v1/orders", body }),
		"123" + "POST" + "/v1/orders" + createHash("sha256").update(body).digest("hex"),
	);
	// The method is upper-cased for the client, so a lower-case verb still works.
	assert.equal(
		signingString({ timestamp: "1", method: "get", path: "/p", body: "" }),
		signingString({ timestamp: "1", method: "GET", path: "/p", body: "" }),
	);
});

test("a malformed signature is refused before any comparison", () => {
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	const r = req(made.secret, {}, at());
	for (const bad of ["", "zz", "nothex".repeat(10), r.signature.slice(0, 63)]) {
		assert.throws(
			() => keys.authenticate({ keyId: made.keyId, ...r, signature: bad, need: "read" }),
			/64 hex characters/,
			JSON.stringify(bad.slice(0, 12)),
		);
	}
});

// ------------------------------------------------------------------- replay

test("A SIGNED REQUEST IS SINGLE-USE", () => {
	// Double-submitting an order is a real way to lose money, and a captured
	// request would otherwise be usable for the whole window.
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["trade"] });
	const r = req(made.secret, { method: "POST", path: "/v1/orders", body: "{}" }, at());

	keys.authenticate({ keyId: made.keyId, ...r, need: "trade" });
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...r, need: "trade" }),
		(e: unknown) => {
			assert.match(String(e), /already used/);
			assert.match(String(e), /double submit cannot place an order twice/);
			return true;
		},
	);
});

test("THE REPLAY GUARD SURVIVES A RESTART", () => {
	// This is why the nonce lives in the database. With an in-memory Map, a
	// deploy or a crash reopened a 30-second replay window on every captured
	// request — and a second worker process never shared one at all.
	const db = new Database(":memory:");
	let t = 1_700_000_000_000;
	const before = new ApiKeys(db, () => t);
	const made = before.create({ userId: "alice", label: "bot", scopes: ["trade"] });
	const r = req(made.secret, { method: "POST", path: "/v1/orders", body: "{}" }, t);
	before.authenticate({ keyId: made.keyId, ...r, need: "trade" });

	// A different instance on the same database — a restarted process, or a
	// second worker.
	const after = new ApiKeys(db, () => t);
	assert.throws(
		() => after.authenticate({ keyId: made.keyId, ...r, need: "trade" }),
		/already used/,
	);
});

test("the nonce table is pruned, and the timestamp still refuses what it drops", () => {
	const { keys, at, advance } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	const r = req(made.secret, {}, at());
	keys.authenticate({ keyId: made.keyId, ...r, need: "read" });

	// Long past the window: the row is gone on the next call...
	advance(SKEW_MS * 10);
	const fresh = req(made.secret, { path: "/v1/other" }, at());
	keys.authenticate({ keyId: made.keyId, ...fresh, need: "read" });

	// ...but the dropped signature is still unusable, because its timestamp is
	// now stale. Pruning must never widen what is accepted.
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...r, need: "read" }),
		/outside the 30s window/,
	);
});

test("a broken nonce store refuses the request rather than skipping the check", () => {
	// Fail closed: if replay protection cannot be recorded, the request does
	// not get to proceed without it.
	const db = new Database(":memory:");
	const keys = new ApiKeys(db, () => 1_700_000_000_000);
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	db.exec("DROP TABLE api_key_use");
	assert.throws(
		() => keys.authenticate({
			keyId: made.keyId,
			...req(made.secret, {}, 1_700_000_000_000),
			need: "read",
		}),
		(e: unknown) => {
			assert.equal((e as ApiKeyError).status, 503);
			assert.match(String(e), /refused rather than accepted without replay/);
			return true;
		},
	);
});

test("A STALE TIMESTAMP IS REFUSED, in both directions", () => {
	const { keys, at, advance } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });

	// Signed now, presented too late.
	const old = req(made.secret, {}, at());
	advance(SKEW_MS + 1000);
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...old, need: "read" }),
		(e: unknown) => {
			assert.match(String(e), /outside the 30s window/);
			// It names the likely cause rather than leaving a bot author guessing.
			assert.match(String(e), /Check the clock on the sending machine/);
			return true;
		},
	);

	// A clock running ahead is refused too — otherwise a request could be
	// pre-signed for the future and held.
	const future = req(made.secret, { timestamp: at() + SKEW_MS + 5000 }, at());
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...future, need: "read" }),
		/outside the 30s window/,
	);
});

test("a non-numeric timestamp is refused with a usable message", () => {
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	const r = req(made.secret, {}, at());
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...r, timestamp: "yesterday", need: "read" }),
		/milliseconds since the epoch/,
	);
});

// ------------------------------------------------------------------- scopes

test("a read key cannot trade", () => {
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "watcher", scopes: ["read"] });
	const r = req(made.secret, { method: "POST", path: "/v1/orders", body: "{}" }, at());
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...r, need: "trade" }),
		(e: unknown) => {
			assert.equal((e as ApiKeyError).status, 403);
			assert.match(String(e), /has read access and this needs "trade"/);
			return true;
		},
	);
});

// --------------------------------------------------------------- revocation

test("REVOKING TAKES EFFECT IMMEDIATELY, and the row is kept", () => {
	const { keys, at, advance } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	keys.authenticate({ keyId: made.keyId, ...req(made.secret, {}, at()), need: "read" });

	keys.revoke("alice", made.keyId);
	advance(1000);
	assert.throws(
		() => keys.authenticate({ keyId: made.keyId, ...req(made.secret, {}, at()), need: "read" }),
		/was revoked/,
	);
	// Kept, so an audit of what that key did still resolves it to an owner.
	assert.notEqual(keys.get(made.keyId), undefined);
	assert.notEqual(keys.get(made.keyId)?.revokedAt, null);
});

test("ONE CUSTOMER CANNOT REVOKE ANOTHER'S KEY, and cannot probe for it", () => {
	const { keys } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	assert.throws(() => keys.revoke("bob", made.keyId), (e: unknown) => {
		assert.equal((e as ApiKeyError).status, 404);
		// The same answer as a genuinely missing key, so an id cannot be tested
		// for existence.
		assert.equal(String((e as Error).message), "no such key");
		return true;
	});
	assert.throws(() => keys.revoke("bob", "bk_doesnotexist"), /no such key/);
	assert.equal(keys.get(made.keyId)?.revokedAt, null, "untouched");
});

test("revoking twice is a no-op rather than an error", () => {
	const { keys } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	keys.revoke("alice", made.keyId);
	const first = keys.get(made.keyId)?.revokedAt;
	keys.revoke("alice", made.keyId);
	assert.equal(keys.get(made.keyId)?.revokedAt, first, "the original time stands");
});

test("an unknown key id is refused without revealing anything", () => {
	const { keys, at } = setup();
	const made = keys.create({ userId: "alice", label: "bot", scopes: ["read"] });
	assert.throws(
		() => keys.authenticate({
			keyId: "bk_nope", ...req(made.secret, {}, at()), need: "read",
		}),
		/unknown API key/,
	);
});

// ----------------------------------------------------------------- the limit

test("the per-key rate limit bounds one bot without touching its siblings", () => {
	const { keys, at } = setup();
	const slow = keys.create({ userId: "alice", label: "slow", scopes: ["read"], ratePerMin: 3 });
	const other = keys.create({ userId: "alice", label: "other", scopes: ["read"] });

	for (let i = 0; i < 3; i++) {
		// A fresh signature each time, since each is single-use.
		keys.authenticate({
			keyId: slow.keyId,
			...req(slow.secret, { path: "/v1/balances?i=" + i }, at()),
			need: "read",
		});
	}
	assert.throws(
		() => keys.authenticate({
			keyId: slow.keyId, ...req(slow.secret, { path: "/v1/x" }, at()), need: "read",
		}),
		(e: unknown) => {
			assert.equal((e as ApiKeyError).status, 429);
			assert.match(String(e), /limit of 3 requests a minute/);
			return true;
		},
	);
	// The owner's other key is unaffected.
	keys.authenticate({ keyId: other.keyId, ...req(other.secret, {}, at()), need: "read" });
});

test("the window slides", () => {
	const { keys, at, advance } = setup();
	const k = keys.create({ userId: "alice", label: "bot", scopes: ["read"], ratePerMin: 1 });
	keys.authenticate({ keyId: k.keyId, ...req(k.secret, {}, at()), need: "read" });
	assert.throws(
		() => keys.authenticate({ keyId: k.keyId, ...req(k.secret, { path: "/a" }, at()), need: "read" }),
		/limit of 1/,
	);
	advance(61_000);
	keys.authenticate({ keyId: k.keyId, ...req(k.secret, { path: "/b" }, at()), need: "read" });
});

test("a nonsensical rate is refused", () => {
	const { keys } = setup();
	for (const bad of [0, -1, 1201, 1.5]) {
		assert.throws(
			() => keys.create({ userId: "a", label: "b", scopes: ["read"], ratePerMin: bad }),
			/whole number from 1 to 1200/,
			String(bad),
		);
	}
});

test("labels are required and bounded", () => {
	const { keys } = setup();
	assert.throws(() => keys.create({ userId: "a", label: "  ", scopes: ["read"] }), /label is required/);
	assert.throws(
		() => keys.create({ userId: "a", label: "x".repeat(65), scopes: ["read"] }),
		/label is too long/,
	);
});

test("keys are listed per owner only", () => {
	const { keys } = setup();
	keys.create({ userId: "alice", label: "a", scopes: ["read"] });
	keys.create({ userId: "bob", label: "b", scopes: ["read"] });
	assert.equal(keys.list("alice").length, 1);
	assert.equal(keys.list("bob").length, 1);
	assert.equal(keys.list("carol").length, 0);
});
