// -----------------------------------------------------------------------------
// CUSTOMER SECOND-FACTOR TESTS.
//
// The point of this factor is to survive a STOLEN SESSION, so every test below
// is written from that attacker's position: they hold a valid session and are
// trying to move money with it. A second factor that a session alone can enrol,
// replace, remove or replay is not a second factor.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { UserTotp, TwoFactorError } from "../src/usertotp";
import { currentCode, TOTP_STEP_SECONDS } from "../src/totp";

/** A clock we control, so the ±1-step window is exercised deliberately. */
function at(ms: number): { now: () => number; set: (v: number) => void } {
	let t = ms;
	return { now: () => t, set: (v) => { t = v; } };
}

function setup(startMs = 1_700_000_000_000) {
	const clock = at(startMs);
	const db = new Database(":memory:");
	return { db, clock, u: new UserTotp(db, clock.now) };
}

/** Enrol and arm, returning the secret. */
function enrol(u: UserTotp, clock: { now: () => number }, id = "alice"): string {
	const { secret } = u.begin({ accountId: id, issuer: "Blockle", account: id });
	u.confirm(id, currentCode(secret, clock.now()));
	return secret;
}

test("A FRESH ENROLMENT IS NOT ARMED UNTIL A CODE IS PROVED", () => {
	// Arming on `begin` would let a user who never scanned the QR lock
	// themselves out, and would count a half-finished enrolment as protection.
	const { u, clock } = setup();
	const { secret, uri } = u.begin({
		accountId: "alice", issuer: "Blockle Exchange", account: "alice",
	});
	assert.equal(u.enrolled("alice"), false, "begin alone must not arm it");
	assert.match(uri, /^otpauth:\/\/totp\//);
	assert.match(uri, /issuer=Blockle(\+|%20)Exchange/);

	u.confirm("alice", currentCode(secret, clock.now()));
	assert.equal(u.enrolled("alice"), true);
});

test("an unarmed enrolment does not satisfy a withdrawal", () => {
	const { u, clock } = setup();
	const { secret } = u.begin({ accountId: "alice", issuer: "B", account: "alice" });
	// Even with a VALID code, an unconfirmed enrolment is not a second factor.
	assert.throws(
		() => u.requireCode("alice", currentCode(secret, clock.now()), "a withdrawal"),
		/requires an authenticator/,
	);
});

test("NOT ENROLLED IS A REFUSAL, never a pass", () => {
	// The tempting shortcut — skip the check for accounts without a factor —
	// means an attacker with a stolen session just picks an un-enrolled victim.
	const { u } = setup();
	assert.throws(
		() => u.requireCode("nobody", "123456", "a withdrawal"),
		(e: unknown) => {
			assert.ok(e instanceof TwoFactorError);
			assert.equal(e.status, 403);
			return true;
		},
	);
});

test("A CODE IS SPENT WHEN IT IS USED, so an observed code cannot be replayed", () => {
	// TOTP is replayable for its whole ±1-step window. Anyone who sees a code —
	// over someone's shoulder, in a proxy log, in a screenshot — could otherwise
	// reuse it for up to ninety seconds.
	const { u, clock } = setup();
	const secret = enrol(u, clock);

	// THE ENROLMENT CODE IS ITSELF ALREADY SPENT. `confirm` consumed it, so it
	// cannot be turned straight around into a withdrawal — which is right, and
	// is why this test has to advance the clock to get a usable code.
	assert.throws(
		() => u.requireCode("alice", currentCode(secret, clock.now()), "a withdrawal"),
		/already been used/,
	);

	clock.set(clock.now() + TOTP_STEP_SECONDS * 1000);
	const code = currentCode(secret, clock.now());
	u.requireCode("alice", code, "a withdrawal");
	assert.throws(
		() => u.requireCode("alice", code, "a withdrawal"),
		/already been used/,
	);
});

test("REPLACING A LIVE AUTHENTICATOR REQUIRES THE CURRENT ONE", () => {
	// THE RULE THAT MAKES THE FACTOR WORTH HAVING. If a session alone could
	// re-enrol, a stolen session would swap the authenticator and withdraw, and
	// the whole control would be theatre.
	const { u, clock } = setup();
	enrol(u, clock);
	assert.throws(
		() => u.begin({ accountId: "alice", issuer: "B", account: "alice" }),
		(e: unknown) => {
			assert.ok(e instanceof TwoFactorError);
			assert.equal(e.status, 401);
			assert.match(e.message, /cannot swap your second factor/);
			return true;
		},
	);
	// And the original factor still works — the failed swap changed nothing.
	assert.equal(u.enrolled("alice"), true);
});

test("a replacement with the current code works, and re-arms from scratch", () => {
	const { u, clock } = setup();
	const old = enrol(u, clock);
	// Move on a step so the enrolment code is not the one just spent.
	clock.set(clock.now() + TOTP_STEP_SECONDS * 1000);
	const fresh = u.begin({
		accountId: "alice", issuer: "B", account: "alice",
		currentCode: currentCode(old, clock.now()),
	});
	assert.notEqual(fresh.secret, old);
	// UNARMED AGAIN until proved: a half-finished swap must not leave the
	// account "protected" by a secret nobody holds.
	assert.equal(u.enrolled("alice"), false);
	clock.set(clock.now() + TOTP_STEP_SECONDS * 1000);
	u.confirm("alice", currentCode(fresh.secret, clock.now()));
	assert.equal(u.enrolled("alice"), true);
	// The OLD secret is now worthless.
	clock.set(clock.now() + TOTP_STEP_SECONDS * 1000);
	assert.throws(() => u.requireCode("alice", currentCode(old, clock.now()), "a withdrawal"));
});

test("TURNING THE FACTOR OFF ALSO REQUIRES A CODE", () => {
	// Otherwise a stolen session removes it and withdraws — the same bypass as
	// replacing it, by a different door.
	const { u, clock } = setup();
	const secret = enrol(u, clock);
	assert.throws(() => u.disable("alice", "000000"), /requires a current code/);
	assert.equal(u.enrolled("alice"), true);

	clock.set(clock.now() + TOTP_STEP_SECONDS * 1000);
	u.disable("alice", currentCode(secret, clock.now()));
	assert.equal(u.enrolled("alice"), false);
});

test("a wrong code is refused with 401, and does not arm anything", () => {
	const { u } = setup();
	const { secret } = u.begin({ accountId: "alice", issuer: "B", account: "alice" });
	void secret;
	assert.throws(
		() => u.confirm("alice", "000000"),
		(e: unknown) => {
			assert.ok(e instanceof TwoFactorError);
			assert.equal(e.status, 401);
			return true;
		},
	);
	assert.equal(u.enrolled("alice"), false);
});

test("one account's factor says nothing about another's", () => {
	const { u, clock } = setup();
	const aliceSecret = enrol(u, clock, "alice");
	assert.equal(u.enrolled("bob"), false);
	// Alice's code must not satisfy Bob, even though it is a valid TOTP code.
	assert.throws(
		() => u.requireCode("bob", currentCode(aliceSecret, clock.now()), "a withdrawal"),
		/requires an authenticator/,
	);
});

test("the spent-code set is per account, so one user cannot block another", () => {
	// Both accounts can legitimately use the same 6 digits in the same step.
	// Keying the replay cache globally would make one user's withdrawal
	// invalidate another's.
	const { db, clock } = setup();
	const u = new UserTotp(db, clock.now);
	const a = enrol(u, clock, "alice");
	const b = enrol(u, clock, "bob");
	clock.set(clock.now() + TOTP_STEP_SECONDS * 1000);
	u.requireCode("alice", currentCode(a, clock.now()), "a withdrawal");
	// Bob is unaffected.
	u.requireCode("bob", currentCode(b, clock.now()), "a withdrawal");
});
