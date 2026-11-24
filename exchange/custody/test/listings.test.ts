// -----------------------------------------------------------------------------
// LISTING APPLICATION TESTS.
//
// The property that matters is the ordering: THE ROW IS COMMITTED BEFORE THE
// MAIL IS ATTEMPTED, and a mail failure never loses the application. Mail is
// the flakiest part of any deployment, and a submission dropped because a
// notification bounced is a listing that never happens and a project that
// concluded nobody answered.
//
// Then header injection, because form-to-mail is the classic place to turn your
// own mail server into somebody else's open relay.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ListingError, Listings, QUESTIONS, sendmailMailer } from "../src/listings";

const GOOD: Record<string, string> = {
	project: "Litecoin Cash",
	ticker: "lcc",
	contact: "team@example.org",
	algorithm: "SHA-256 PoW",
	codebase: "Bitcoin Core 0.16",
	rpc: "bitcoin-style JSON-RPC, daemon at github.com/example/lcc",
	decimals: "8",
	confirmations: "12",
	explorer: "https://explorer.example.org",
};

function capture(): {
	mailer: { name: string; send: (a: { to: string; subject: string; body: string }) => Promise<void> };
	sent: { to: string; subject: string; body: string }[];
} {
	const sent: { to: string; subject: string; body: string }[] = [];
	return {
		mailer: {
			name: "capture",
			async send(a) {
				sent.push(a);
			},
		},
		sent,
	};
}

const setup = (over: Record<string, unknown> = {}) => {
	const db = new Database(":memory:");
	const c = capture();
	const l = new Listings(db, {
		mailer: c.mailer,
		notifyTo: "alex@blockle.org",
		// Awaited HERE ONLY so these tests can assert on the outcome. The
		// service detaches it: an applicant's request must not wait on an MTA.
		awaitMail: true,
		...over,
	});
	return { db, l, sent: c.sent };
};

test("a complete application is stored and notified", async () => {
	const { l, sent } = setup();
	const r = await l.submit({ fields: GOOD, ip: "1.2.3.4" });

	assert.match(r.id, /^L-[0-9A-F]{8}$/);
	assert.equal(r.stored, true);
	assert.equal(r.notified, true);

	const rows = l.list();
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.ticker, "LCC", "uppercased for display");
	assert.equal(rows[0]!.notified, "sent");

	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.to, "alex@blockle.org");
	assert.match(sent[0]!.subject, /^Listing application L-[0-9A-F]{8}: LCC$/);
});

test("THE APPLICATION SURVIVES A MAIL FAILURE", async () => {
	// The whole point of committing first. A notification is our problem; the
	// applicant has been accepted either way.
	const db = new Database(":memory:");
	const l = new Listings(db, {
		notifyTo: "alex@blockle.org",
		awaitMail: true,
		mailer: {
			name: "broken",
			async send() {
				throw new Error("postfix queue is full");
			},
		},
	});

	const r = await l.submit({ fields: GOOD, ip: "1.2.3.4" });
	assert.equal(r.stored, true, "stored anyway");
	assert.equal(r.notified, false, "and honest that it was not sent");

	const row = l.list()[0]!;
	assert.match(String(row.notified), /^failed: postfix queue is full/);
	// And it is findable for a retry rather than lost.
	assert.deepEqual(
		l.unnotified().map((x) => x.id),
		[row.id],
	);
});

test("no mailer at all still records the application", async () => {
	const db = new Database(":memory:");
	const l = new Listings(db, {});
	const r = await l.submit({ fields: GOOD, ip: "1.2.3.4" });
	assert.equal(r.stored, true);
	assert.equal(r.notified, false);
	assert.equal(l.list()[0]!.notified, "no mailer configured");
});

test("EVERY ANSWER REACHES THE EMAIL, labelled", async () => {
	// A question answered and not forwarded is the same as not asked.
	const { l, sent } = setup();
	const full: Record<string, string> = { ...GOOD };
	for (const q of QUESTIONS) full[q.key] = full[q.key] ?? `answer-${q.key}`;
	await l.submit({ fields: full, ip: "1.2.3.4" });

	const body = sent[0]!.body;
	for (const q of QUESTIONS) {
		assert.ok(body.includes(q.label + ":"), `${q.label} missing from the email`);
		assert.ok(body.includes(full[q.key]!), `${q.key}'s answer missing`);
	}
	// And the integration hint, so a reply does not promise a timeline before
	// anyone has looked at what the chain is.
	assert.match(body, /LISTING-ADAPTERS\.md/);
});

test("a multi-line answer cannot be mistaken for new fields", async () => {
	const { l, sent } = setup();
	await l.submit({
		fields: { ...GOOD, notes: "line one\nAnything else:\nline three" },
		ip: "1.2.3.4",
	});
	// Every line of an answer is indented, so a submitter cannot forge a label.
	assert.match(sent[0]!.body, /\n {4}Anything else:/);
});

test("HEADER INJECTION IS IMPOSSIBLE", async () => {
	// The classic form-to-mail hole: a newline in submitted text reaching a
	// header lets the submitter add recipients.
	const { l, sent } = setup();
	await l.submit({
		fields: {
			...GOOD,
			ticker: "AB\nBcc: x@y.z",
			project: "x\r\nSubject: hijacked",
		},
		ip: "1.2.3.4",
	});
	const subject = sent[0]!.subject;
	// THE PROPERTY IS "no CR or LF in a header", not "no scary substring". The
	// first draft asserted the subject contained no /Bcc/i and failed on
	// "ABBCCXYZ" — the sanitiser had stripped the newline and the colon, so
	// nothing injectable remained and the test was wrong about what it was
	// protecting. A header line cannot be forged without a line break.
	assert.doesNotMatch(subject, /[\r\n]/);
	// Built from safe pieces only: the id, then the ticker with everything
	// outside A-Z0-9 removed. No colon survives, so no header can be forged.
	assert.match(subject, /^Listing application L-[0-9A-F]{8}: [A-Z0-9]*$/);
	// The body carries the raw text — that is where submitted content belongs.
	assert.match(sent[0]!.body, /Subject: hijacked/);
});

test("the sendmail transport refuses a newline in a header outright", async () => {
	// Second line of defence, independent of the caller sanitising.
	const m = sendmailMailer("/bin/true");
	await assert.rejects(
		() => m.send({ to: "a@b.c", subject: "ok\nBcc: x@y.z", body: "" }),
		/newline in a mail header/,
	);
	await assert.rejects(
		() => m.send({ to: "a@b.c\nBcc: x@y.z", subject: "ok", body: "" }),
		/newline in a mail header/,
	);
});

test("required answers are required, and the message names the field", async () => {
	const { l } = setup();
	for (const q of QUESTIONS.filter((x) => x.required)) {
		const missing = { ...GOOD };
		delete missing[q.key];
		await assert.rejects(
			() => l.submit({ fields: missing, ip: "1.2.3.4" }),
			// Labels contain regex metacharacters ("What is the node a fork
			// of?"), so they must be escaped before becoming a pattern.
			new RegExp(
				`${q.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is required`,
			),
			`${q.key} should be required`,
		);
	}
});

test("optional answers really are optional", async () => {
	const { l } = setup();
	const r = await l.submit({ fields: GOOD, ip: "1.2.3.4" });
	assert.equal(r.stored, true);
});

test("an over-long answer is refused rather than silently truncated", async () => {
	const { l } = setup();
	await assert.rejects(
		() => l.submit({ fields: { ...GOOD, notes: "x".repeat(2001) }, ip: "1.2.3.4" }),
		/longer than 2000 characters/,
	);
});

test("an obviously wrong email is caught, without being clever about it", async () => {
	const { l } = setup();
	for (const bad of ["notanemail", "a@b", "a b@c.d", "@x.com"]) {
		await assert.rejects(
			() => l.submit({ fields: { ...GOOD, contact: bad }, ip: "1.2.3.4" }),
			/does not look right/,
			bad,
		);
	}
	// And a perfectly ordinary address with a plus tag is accepted, because a
	// strict regex rejecting valid addresses is worse than a loose one.
	const r = await l.submit({
		fields: { ...GOOD, contact: "team+listing@sub.example.org" },
		ip: "1.2.3.4",
	});
	assert.equal(r.stored, true);
});

test("the rate limit bounds one address without blocking others", async () => {
	let now = 1_700_000_000_000;
	const db = new Database(":memory:");
	const c = capture();
    const l = new Listings(db, {
		mailer: c.mailer,
		perHour: 2,
		now: () => now,
		awaitMail: true,
	});

	await l.submit({ fields: GOOD, ip: "1.1.1.1" });
	await l.submit({ fields: GOOD, ip: "1.1.1.1" });
	await assert.rejects(
		() => l.submit({ fields: GOOD, ip: "1.1.1.1" }),
		(e: unknown) => {
			assert.ok(e instanceof ListingError);
			assert.equal(e.status, 429);
			// And it says where to go instead, rather than just refusing.
			assert.match(String(e), /support@blockle\.org/);
			return true;
		},
	);
	// A different submitter is unaffected.
	await l.submit({ fields: GOOD, ip: "2.2.2.2" });
	// And the window really is an hour.
	now += 61 * 60 * 1000;
	await l.submit({ fields: GOOD, ip: "1.1.1.1" });
	assert.equal(l.list().length, 4);
});

test("the honeypot is rejected without explanation", async () => {
	// A field no human sees. Saying why would tell a bot what to avoid.
	const { l } = setup();
	await assert.rejects(
		() => l.submit({ fields: { ...GOOD, website_url: "http://spam" }, ip: "1.2.3.4" }),
		/submission rejected/,
	);
	assert.equal(l.list().length, 0);
});

test("the question set asks what integration needs, not marketing copy", () => {
	// A guard on the shape of the form rather than its wording: the answers
	// that decide whether a chain CAN be listed must stay required.
	const required = QUESTIONS.filter((q) => q.required).map((q) => q.key);
	for (const k of ["codebase", "rpc", "decimals", "confirmations", "explorer"]) {
		assert.ok(required.includes(k), `${k} must be required`);
	}
	// And the one that decides how much work it is explains itself.
	const codebase = QUESTIONS.find((q) => q.key === "codebase")!;
	assert.match(codebase.hint, /Bitcoin Core|go-ethereum/);
});

test("A SLOW MAILER DOES NOT HANG THE SUBMISSION", async () => {
	// The bug this guards: the first deployment awaited sendmail inside the
	// request, and a wedged MTA left the HTTP call hanging until the client
	// gave up. The applicant saw a broken form; the row was already committed.
	const db = new Database(":memory:");
	let released: (() => void) | undefined;
	const l = new Listings(db, {
		notifyTo: "alex@blockle.org",
		mailer: {
			name: "glacial",
			send: () => new Promise<void>((r) => { released = r; }),
		},
	});

	const started = Date.now();
	const res = await l.submit({ fields: GOOD, ip: "1.2.3.4" });
	assert.ok(Date.now() - started < 500, "returned without waiting for mail");
	assert.equal(res.stored, true);
	assert.equal(res.notified, false, "honest: not sent yet");
	// The record exists regardless, which is the point.
	assert.equal(l.list().length, 1);
	released?.();
});

test("the sendmail transport gives up rather than hanging forever", async () => {
	// A stand-in MTA that accepts the message and then never exits. `/bin/cat`
	// was the first attempt and is wrong: stdin is closed after writing, so cat
	// exits 0 immediately and the timeout never fires.
	const fake = join(tmpdir(), `fake-sendmail-${process.pid}.sh`);
	writeFileSync(fake, "#!/bin/sh\ncat > /dev/null\nsleep 30\n", { mode: 0o755 });
	const m = sendmailMailer(fake, 150);
	const started = Date.now();
	await assert.rejects(
		() => m.send({ to: "a@b.c", subject: "s", body: "b" }),
		/did not return within 150ms/,
	);
	assert.ok(Date.now() - started < 2000, "the kill took effect");
	rmSync(fake, { force: true });
});
