// -----------------------------------------------------------------------------
// LISTING APPLICATIONS — a project asks to be listed, and we hear about it.
//
// WHAT THIS IS FOR. Small chains with no exchange listing are the venue's best
// growth lever, and the people who want a listing are usually the project's own
// team. The friction to reach us should be a form, not a Telegram search.
//
// THE RECORD IS THE DATABASE; THE EMAIL IS A NOTIFICATION.
//
// That ordering is the whole design. Mail is the part most likely to fail — a
// full queue, a DNS change, a greylist — and a submission lost because a
// notification failed is a listing that never happens and a project that
// concluded nobody answered. So the row is written and committed FIRST, the
// mail is attempted after, and a mail failure is recorded against the row
// rather than thrown at the applicant. They are told "received", because it
// was.
//
// WHAT IT ASKS FOR IS WHAT INTEGRATION ACTUALLY NEEDS.
//
// Not marketing copy. The questions are the ones that decide whether a chain
// can be listed at all and how much work it is: what the node is a fork of,
// whether there is an RPC we can run ourselves, decimals, confirmations, and
// whether anyone else already lists it. A form that collects a logo and a
// Twitter handle produces a pile of applications nobody can act on.
//
// ABUSE. Public, because requiring an account would filter out exactly the
// people we want to hear from. Bounded instead by a per-IP rate limit, a size
// cap on every field, and a honeypot. None of that is strong; it does not need
// to be, because the worst case is a junk row in a table an operator reads.
//
// HEADER INJECTION. Every value that reaches the mail goes in the BODY, never a
// header. A newline in a "project name" that reached a To: or Subject: line
// would let a submitter add recipients — the classic form-to-mail hole — so the
// subject is built from a sanitised id and nothing else.
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import type { Database } from "better-sqlite3";
import { randomBytes } from "node:crypto";

export class ListingError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "ListingError";
	}
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS listing_application (
  id          TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  -- Who is asking, and how we reach them back.
  contact     TEXT NOT NULL,
  project     TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  -- The technical answers, as submitted. Stored verbatim as JSON rather than
  -- one column per question: the question set will change, and a schema
  -- migration per new question would mean the form stops being easy to edit.
  details     TEXT NOT NULL,
  -- Notification state. 'sent', or the reason it could not be.
  notified    TEXT,
  -- Operator workflow. Deliberately minimal: this is an inbox, not a CRM.
  status      TEXT NOT NULL DEFAULT 'new',
  source_ip   TEXT
);

CREATE INDEX IF NOT EXISTS idx_listing_status ON listing_application(status);
CREATE INDEX IF NOT EXISTS idx_listing_at ON listing_application(received_at);
`;

/**
 * The questions.
 *
 * Declared as data so the form, the validation and the email all read from one
 * list — a question added to the HTML but not here would be silently dropped,
 * which is the worst outcome for a form (the submitter answered and nobody
 * received it).
 */
export const QUESTIONS: readonly {
	key: string;
	label: string;
	hint: string;
	required: boolean;
	max: number;
}[] = [
	{
		key: "project",
		label: "Project name",
		hint: "",
		required: true,
		max: 120,
	},
	{
		key: "ticker",
		label: "Ticker",
		hint: "As you want it displayed, e.g. XMR",
		required: true,
		max: 16,
	},
	{
		key: "contact",
		label: "Your email",
		hint: "We reply here. Not published.",
		required: true,
		max: 200,
	},
	{
		key: "algorithm",
		label: "Consensus / algorithm",
		hint: "e.g. SHA-256 PoW, Equihash, Ethash, or 'EVM L2'",
		required: true,
		max: 120,
	},
	{
		key: "codebase",
		label: "What is the node a fork of?",
		hint:
			"THE MOST IMPORTANT ANSWER. 'Bitcoin Core 27' or 'go-ethereum' means " +
			"we likely already have an adapter. A bespoke codebase means custom " +
			"work, which we will quote honestly rather than pretend otherwise.",
		required: true,
		max: 300,
	},
	{
		key: "rpc",
		label: "Node software and RPC",
		hint:
			"Where we get the daemon, and whether its RPC is Bitcoin-style, " +
			"JSON-RPC/EVM, or something else. We run our own node — we do not " +
			"rely on a project-hosted endpoint for custody.",
		required: true,
		max: 500,
	},
	{
		key: "decimals",
		label: "Decimals",
		hint: "8 for most Bitcoin forks, 18 for most EVM chains",
		required: true,
		max: 8,
	},
	{
		key: "confirmations",
		label: "Confirmations for a safe deposit",
		hint: "Your honest number, given the chain's reorg behaviour",
		required: true,
		max: 8,
	},
	{
		key: "explorer",
		label: "Block explorer",
		hint: "So deposits and withdrawals can be linked",
		required: true,
		max: 300,
	},
	{
		key: "supply",
		label: "Supply and emission",
		hint: "Circulating, max, block reward, halving schedule if any",
		required: false,
		max: 500,
	},
	{
		key: "listings",
		label: "Existing listings",
		hint:
			"Where else it trades, if anywhere. 'Nowhere' is a perfectly good " +
			"answer and is often why we are interested.",
		required: false,
		max: 300,
	},
	{
		key: "liquidity",
		label: "Who will make the market?",
		hint:
			"A pair with no liquidity helps nobody. Tell us if the team or a " +
			"community member intends to quote it.",
		required: false,
		max: 400,
	},
	{
		key: "notes",
		label: "Anything else",
		hint: "Quirks we would otherwise discover the hard way",
		required: false,
		max: 2000,
	},
];

export interface Mailer {
	readonly name: string;
	send(args: { to: string; subject: string; body: string }): Promise<void>;
}

/**
 * Local sendmail. The box runs Postfix with DKIM already configured for this
 * domain, so there is no SMTP credential to hold and nothing to leak.
 *
 * The subject is restricted to a safe character set by the caller; this still
 * refuses any newline in `to` or `subject` as a second line of defence,
 * because header injection is the one mistake in a form-to-mail path that
 * turns our mail server into someone else's.
 */
export function sendmailMailer(
	bin = "/usr/sbin/sendmail",
	timeoutMs = 10_000,
): Mailer {
	return {
		name: "sendmail",
		async send({ to, subject, body }) {
			if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) {
				throw new ListingError("refusing to send: newline in a mail header", 500);
			}
			await new Promise<void>((resolve, reject) => {
				const p = spawn(bin, ["-t", "-i"], { stdio: ["pipe", "ignore", "pipe"] });
				let err = "";
				let done = false;
				const finish = (e?: Error): void => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					if (e === undefined) resolve();
					else reject(e);
				};
				// A HARD TIMEOUT. sendmail hands off to Postfix and normally
				// returns at once, but a wedged MTA, a full spool or a DNS
				// stall can leave it sitting there — and the first deployment
				// of this hung the HTTP request until the client gave up.
				// Killed rather than waited on: the row is already committed,
				// so losing the notification is recoverable and a hung request
				// is not.
				const timer = setTimeout(() => {
					p.kill("SIGKILL");
					finish(new Error(`sendmail did not return within ${timeoutMs}ms`));
				}, timeoutMs);
				p.stderr?.on("data", (d: Buffer) => {
					err += d.toString();
				});
				p.on("error", finish);
				p.on("close", (code) => {
					if (code === 0) finish();
					else finish(new Error(`sendmail exited ${code}: ${err.slice(0, 300)}`));
				});
				p.stdin.end(
					`To: ${to}\n` +
						`From: Blockle Exchange <support@blockle.org>\n` +
						`Subject: ${subject}\n` +
						"Content-Type: text/plain; charset=utf-8\n" +
						"\n" +
						body,
				);
			});
		},
	};
}

export class Listings {
	private readonly recent: { ip: string; at: number }[] = [];

	constructor(
		private readonly db: Database,
		private readonly opts: {
			mailer?: Mailer;
			notifyTo?: string;
			now?: () => number;
			/** Submissions allowed per IP per hour. */
			perHour?: number;
			/**
			 * Wait for the notification before returning. TESTS ONLY — in the
			 * service the mail is detached so a slow MTA cannot hang a request.
			 */
			awaitMail?: boolean;
		} = {},
	) {
		db.exec(SCHEMA);
	}

	/**
	 * Accept an application.
	 *
	 * Returns as soon as the row is committed. The notification is attempted
	 * after and its outcome recorded on the row — see the header.
	 */
	async submit(args: {
		fields: Record<string, unknown>;
		ip: string;
	}): Promise<{ id: string; stored: true; notified: boolean }> {
		const now = (this.opts.now ?? (() => Date.now()))();

		// HONEYPOT: a field no human sees. Filled means a bot.
		if (typeof args.fields.website_url === "string" && args.fields.website_url !== "") {
			throw new ListingError("submission rejected");
		}

		const perHour = this.opts.perHour ?? 5;
		const cutoff = now - 60 * 60 * 1000;
		while (this.recent.length > 0 && this.recent[0]!.at < cutoff) this.recent.shift();
		if (this.recent.filter((r) => r.ip === args.ip).length >= perHour) {
			throw new ListingError(
				`too many applications from this address — ${perHour} an hour. ` +
					"Email support@blockle.org if you have more than that to send.",
				429,
			);
		}

		const clean: Record<string, string> = {};
		for (const q of QUESTIONS) {
			const raw = args.fields[q.key];
			const v = typeof raw === "string" ? raw.trim() : "";
			if (v === "") {
				if (q.required) throw new ListingError(`${q.label} is required`);
				continue;
			}
			if (v.length > q.max) {
				throw new ListingError(`${q.label} is longer than ${q.max} characters`);
			}
			clean[q.key] = v;
		}

		// NORMALISE ONCE, so the row, the email body and the subject all carry
		// the same value. Uppercasing only on insert left the subject building
		// from the raw lowercase ticker and then stripping everything outside
		// A-Z0-9 — which deleted it, and the subject read "Listing application
		// L-8EAF8D0C: " with nothing after the colon.
		if (clean.ticker !== undefined) clean.ticker = clean.ticker.toUpperCase();

		// Enough of an email check to catch a typo, deliberately not more. A
		// strict regex rejects valid addresses, and the real validation is
		// whether our reply arrives.
		if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(clean.contact ?? "")) {
			throw new ListingError("that email address does not look right");
		}

		const id = `L-${randomBytes(4).toString("hex").toUpperCase()}`;
		this.db
			.prepare(
				`INSERT INTO listing_application
				   (id, received_at, contact, project, ticker, details, source_ip)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				new Date(now).toISOString(),
				clean.contact!,
				clean.project!,
				clean.ticker!,
				JSON.stringify(clean),
				args.ip,
			);
		this.recent.push({ ip: args.ip, at: now });

		// ---- notification, after the commit ---------------------------------
		//
		// NOT AWAITED BY THE CALLER unless it asks. The row is the record and
		// it is already committed; making the applicant's HTTP request wait on
		// an MTA means a slow mail server reads to them as a broken form. The
		// outcome is written back to the row either way, and `unnotified()`
		// finds anything that failed.
		let notified = false;
		const mailer = this.opts.mailer;
		if (mailer === undefined) {
			this.note(id, "no mailer configured");
		} else {
			const deliver = async (): Promise<void> => {
			try {
				await mailer.send({
					to: this.opts.notifyTo ?? "alex@blockle.org",
					// SUBJECT FROM SAFE PIECES ONLY. The ticker is uppercased and
					// length-capped above, and anything outside A-Z0-9 is stripped
					// here, so no submitted text can reach a header.
					subject: `Listing application ${id}: ${(clean.ticker ?? "").replace(/[^A-Z0-9]/g, "")}`,
					body: this.body(id, clean, args.ip, now),
				});
				notified = true;
				this.note(id, "sent");
			} catch (e) {
				// RECORDED, NOT THROWN. The applicant has been accepted; a mail
				// failure is our problem and visible in the admin list.
				const why = e instanceof Error ? e.message : String(e);
				console.error(`listing ${id}: notification failed: ${why}`);
				this.note(id, `failed: ${why.slice(0, 200)}`);
			}
			};
			if (this.opts.awaitMail === true) {
				await deliver();
			} else {
				// Detached. An unhandled rejection here would be a crash, so
				// `deliver` catches everything itself and this only guards
				// against a bug in that catch.
				void deliver().catch((e: unknown) => {
					console.error(`listing ${id}: notifier threw: ${String(e)}`);
				});
			}
		}
		return { id, stored: true, notified };
	}

	private note(id: string, state: string): void {
		this.db
			.prepare(`UPDATE listing_application SET notified = ? WHERE id = ?`)
			.run(state, id);
	}

	/** The email body: every answer, labelled, in the order asked. */
	private body(
		id: string,
		clean: Record<string, string>,
		ip: string,
		now: number,
	): string {
		const lines: string[] = [];
		lines.push(`Listing application ${id}`);
		lines.push(new Date(now).toISOString());
		lines.push("");
		for (const q of QUESTIONS) {
			const v = clean[q.key];
			if (v === undefined) continue;
			lines.push(`${q.label}:`);
			// Indented so a multi-line answer cannot be mistaken for a new field.
			for (const l of v.split("\n")) lines.push(`    ${l}`);
			lines.push("");
		}
		lines.push(`Submitted from ${ip}`);
		lines.push("");
		lines.push(
			"Integration notes: a Bitcoin Core or go-ethereum fork reuses an " +
				"existing adapter. Anything else needs a custom one — see " +
				"docs/LISTING-ADAPTERS.md before replying with a timeline.",
		);
		return lines.join("\n");
	}

	/** For the admin console. Newest first. */
	list(limit = 100): readonly {
		id: string;
		receivedAt: string;
		project: string;
		ticker: string;
		contact: string;
		status: string;
		notified: string | null;
		details: Record<string, string>;
	}[] {
		const rows = this.db
			.prepare(
				`SELECT id, received_at, project, ticker, contact, status, notified, details
				   FROM listing_application ORDER BY received_at DESC LIMIT ?`,
			)
			.all(limit) as {
			id: string;
			received_at: string;
			project: string;
			ticker: string;
			contact: string;
			status: string;
			notified: string | null;
			details: string;
		}[];
		return rows.map((r) => ({
			id: r.id,
			receivedAt: r.received_at,
			project: r.project,
			ticker: r.ticker,
			contact: r.contact,
			status: r.status,
			notified: r.notified,
			details: JSON.parse(r.details) as Record<string, string>,
		}));
	}

	/** Applications whose notification never went out, for a retry. */
	unnotified(): readonly { id: string; contact: string; ticker: string }[] {
		return this.db
			.prepare(
				`SELECT id, contact, ticker FROM listing_application
				  WHERE notified IS NULL OR notified NOT IN ('sent')
				  ORDER BY received_at`,
			)
			.all() as { id: string; contact: string; ticker: string }[];
	}
}
