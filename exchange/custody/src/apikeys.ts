// -----------------------------------------------------------------------------
// TRADE API KEYS — programmatic access, without a key becoming a way to steal.
//
// A key lets a bot place and cancel orders and read balances. It is signed
// rather than sent: the secret never travels, so a key is useless to anyone
// reading the wire or a proxy log.
//
// THE DECISION THAT MATTERS MOST: A KEY CANNOT WITHDRAW. EVER.
//
// Every large exchange theft of the last decade that went through an API went
// through a key with withdrawal rights. The scope does not exist here — not
// "off by default", not "requires extra confirmation": there is no code path
// from a signed API request to a withdrawal. Withdrawing needs the session and
// the account's own second factor, by a human, on the site.
//
// That costs something real — nobody can automate a sweep to cold storage —
// and it is still the right trade. A leaked key then costs its owner the
// spread on some unwanted trades, which is recoverable, instead of their
// balance, which is not.
//
// HOW THE SIGNATURE WORKS, and why each part is there:
//
//   signature = HMAC-SHA256(secret, timestamp + method + path + sha256(body))
//
//   * TIMESTAMP, with a ±30s window. Without it a captured request can be
//     replayed forever. Thirty seconds is enough for any real latency and
//     short enough that a captured request is stale before it is useful.
//   * METHOD and PATH, so a signature for `GET /balances` cannot be moved onto
//     `POST /orders`.
//   * A HASH OF THE BODY, so the order cannot be edited in flight. Hashing
//     rather than including it keeps the signed string short and fixed-size.
//   * AND THE NONCE IS THE SIGNATURE ITSELF: each one is remembered for the
//     window, so the same signed request cannot be sent twice even inside it.
//     Double-submitting an order is a real way to lose money.
//
// WHAT IS STORED, AND WHAT THAT COSTS — stated plainly, because it is the one
// place this design is weaker than it first looks.
//
// HMAC is symmetric: verifying a signature needs the same key that made it. So
// a signing key CANNOT be stored as an irreversible hash the way a password is
// — there would be nothing to verify against. The options are really:
//
//   (a) sign with HMAC, and hold signing material at rest; or
//   (b) send the secret as a bearer token, and hold only a hash at rest.
//
// This takes (a), as exchanges generally do, because an API key gets pasted
// into third-party bots and config files and ends up in places a bearer token
// should never travel. Keeping it off the wire is worth more than keeping it
// out of a database that already contains the entire ledger — if that leaks,
// the signing keys are not the biggest problem.
//
// So `signing_key` IS A CREDENTIAL AT REST. It is named that way rather than
// `secret_hash`, which is what the first draft called it and which would have
// read as "already protected, nothing to worry about" to whoever next changed
// this file. Treat the api_key table with the same care as the ledger.
//
// What this does buy: the stored value is generated per key and used nowhere
// else, so a leak exposes trading on this venue and nothing more. And it is
// shown to the customer ONCE — not because we cannot show it again, but
// because an endpoint that returns signing keys is an endpoint worth attacking.
// -----------------------------------------------------------------------------

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";

export class ApiKeyError extends Error {
	constructor(
		message: string,
		readonly status = 401,
	) {
		super(message);
		this.name = "ApiKeyError";
	}
}

/**
 * What a key is allowed to do.
 *
 * There is no `withdraw`. See the header — its absence is the point, and
 * adding one later should require re-reading that paragraph.
 */
export type Scope = "read" | "trade";

export const SCOPES: readonly Scope[] = ["read", "trade"];

/** How far a request's timestamp may be from ours. */
export const SKEW_MS = 30_000;

/**
 * THE PER-KEY RATE-LIMIT WINDOW. A key's allowance is "N requests in this
 * rolling window", so this is also the longest a throttled caller can have to
 * wait for capacity — which is why publicapi.ts derives the `Retry-After` it
 * sends on a 429 from here instead of typing a number beside it.
 */
export const KEY_RATE_WINDOW_MS = 60_000;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_key (
  -- Public half. Sent in the clear on every request.
  key_id      TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- THE SIGNING KEY. A credential at rest, not a hash of one — HMAC
  -- verification needs the same key that signed, so there is nothing to
  -- one-way here. See the note at the top of this file; it is named for what
  -- it is so nobody mistakes it for already-protected.
  signing_key TEXT NOT NULL,
  -- Comma-separated subset of SCOPES. Never includes a withdrawal right,
  -- because no such scope exists.
  scopes      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  -- Set when revoked; the row is KEPT so an audit of what a key did still
  -- resolves its id to an owner.
  revoked_at  TEXT,
  -- Requests per minute. Per key, so one runaway bot cannot starve its owner's
  -- other integrations.
  rate_per_min INTEGER NOT NULL DEFAULT 120
);

CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key(user_id);

-- ONE SIGNED REQUEST, ONE USE — AND IN THE DATABASE, NOT IN MEMORY.
--
-- The first version kept this in a Map, which was wrong twice over:
--
--  * A RESTART EMPTIED IT. A deploy, a crash, a systemd reload — and for the
--    next 30 seconds every captured request was replayable again. Narrow, but
--    the whole point of this table is that the window is zero.
--  * IT WAS PER PROCESS. The moment this API runs behind two workers, a
--    replay simply lands on the other one and succeeds.
--
-- The signature IS the nonce, so it is the primary key: a replay is a UNIQUE
-- violation, which also makes the check atomic. Check-then-set has a gap;
-- INSERT does not.
--
-- Rows are pruned past the skew window, so this stays a few seconds of
-- traffic rather than a log.
CREATE TABLE IF NOT EXISTS api_key_use (
  signature TEXT PRIMARY KEY,
  key_id    TEXT NOT NULL,
  at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_use_at ON api_key_use(at);
`;

export interface ApiKeyRow {
	readonly keyId: string;
	readonly userId: string;
	readonly label: string;
	readonly scopes: readonly Scope[];
	readonly createdAt: string;
	readonly lastUsedAt: string | null;
	readonly revokedAt: string | null;
	readonly ratePerMin: number;
}

interface Raw {
	key_id: string;
	user_id: string;
	label: string;
	signing_key: string;
	scopes: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
	rate_per_min: number;
}

const sha256 = (s: string | Buffer): string =>
	createHash("sha256").update(s).digest("hex");

/** The exact string a client must sign. Exported so the docs cannot drift. */
export function signingString(args: {
	timestamp: string;
	method: string;
	path: string;
	body: string;
}): string {
	return (
		args.timestamp +
		args.method.toUpperCase() +
		args.path +
		sha256(args.body ?? "")
	);
}

export function sign(secret: string, args: {
	timestamp: string;
	method: string;
	path: string;
	body: string;
}): string {
	return createHmac("sha256", secret).update(signingString(args)).digest("hex");
}

export class ApiKeys {
	/**
	 * Request timestamps per key, for the per-minute limit.
	 *
	 * IN MEMORY ON PURPOSE, unlike the replay table. A rate limit that forgets
	 * on restart lets a bot burst once; a replay guard that forgets on restart
	 * lets someone spend a captured order twice. Only the second is worth a
	 * write per request.
	 */
	private readonly hits = new Map<string, number[]>();

	constructor(
		private readonly db: Database,
		private readonly now: () => number = () => Date.now(),
	) {
		db.exec(SCHEMA);
	}

	/**
	 * Create a key. THE SECRET IS RETURNED HERE AND NEVER AGAIN.
	 *
	 * Scopes are validated against the list, so a caller asking for "withdraw"
	 * gets a clear refusal rather than a key that silently cannot.
	 */
	create(args: {
		userId: string;
		label: string;
		scopes: readonly string[];
		ratePerMin?: number;
	}): { keyId: string; secret: string; key: ApiKeyRow } {
		const label = args.label.trim();
		if (label === "") throw new ApiKeyError("a label is required", 400);
		if (label.length > 64) throw new ApiKeyError("that label is too long", 400);

		const scopes: Scope[] = [];
		for (const s of args.scopes) {
			const v = String(s).trim().toLowerCase();
			if (v === "") continue;
			if (v === "withdraw" || v === "withdrawal") {
				throw new ApiKeyError(
					"API keys cannot withdraw, and there is no scope that grants it. " +
						"Every large exchange theft through an API went through a key " +
						"with withdrawal rights. Withdrawing needs your session and your " +
						"second factor, on the site.",
					400,
				);
			}
			if (!SCOPES.includes(v as Scope)) {
				throw new ApiKeyError(
					`unknown scope "${v}" — choose from ${SCOPES.join(", ")}`,
					400,
				);
			}
			if (!scopes.includes(v as Scope)) scopes.push(v as Scope);
		}
		if (scopes.length === 0) scopes.push("read");

		const rate = args.ratePerMin ?? 120;
		if (!Number.isInteger(rate) || rate < 1 || rate > 1200) {
			throw new ApiKeyError("rate must be a whole number from 1 to 1200", 400);
		}

		// The id is public and the secret is not, so they are generated
		// separately — a secret derived from the id would be guessable from it.
		const keyId = `bk_${randomBytes(12).toString("hex")}`;
		const secret = randomBytes(32).toString("base64url");
		const at = new Date(this.now()).toISOString();

		this.db
			.prepare(
				`INSERT INTO api_key
				   (key_id, user_id, label, signing_key, scopes, created_at, rate_per_min)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(keyId, args.userId, label, secret, scopes.join(","), at, rate);

		return { keyId, secret, key: this.get(keyId)! };
	}

	get(keyId: string): ApiKeyRow | undefined {
		const r = this.db
			.prepare(`SELECT * FROM api_key WHERE key_id = ?`)
			.get(keyId) as Raw | undefined;
		return r === undefined ? undefined : hydrate(r);
	}

	list(userId: string): readonly ApiKeyRow[] {
		return (
			this.db
				.prepare(
					`SELECT * FROM api_key WHERE user_id = ? ORDER BY created_at DESC`,
				)
				.all(userId) as Raw[]
		).map(hydrate);
	}

	/**
	 * Revoke. The row stays so an audit can still attribute past requests.
	 *
	 * Scoped to the owner: one customer must not be able to revoke another's
	 * key by guessing an id.
	 */
	revoke(userId: string, keyId: string): void {
		const r = this.db
			.prepare(`SELECT user_id, revoked_at FROM api_key WHERE key_id = ?`)
			.get(keyId) as { user_id: string; revoked_at: string | null } | undefined;
		if (r === undefined || r.user_id !== userId) {
			// Same answer for "no such key" and "not yours", so an id cannot be
			// probed for existence.
			throw new ApiKeyError("no such key", 404);
		}
		if (r.revoked_at !== null) return; // already gone; idempotent
		this.db
			.prepare(`UPDATE api_key SET revoked_at = ? WHERE key_id = ?`)
			.run(new Date(this.now()).toISOString(), keyId);
	}

	/**
	 * Authenticate a signed request and return the account it belongs to.
	 *
	 * Every failure path is a refusal with a reason the caller can act on,
	 * because a bot author debugging a signature with "401" and nothing else
	 * will eventually start sending the secret in a header to see if that
	 * works.
	 */
	authenticate(args: {
		keyId: string;
		signature: string;
		timestamp: string;
		method: string;
		path: string;
		body: string;
		need: Scope;
	}): { userId: string; key: ApiKeyRow } {
		const now = this.now();

		const row = this.db
			.prepare(`SELECT * FROM api_key WHERE key_id = ?`)
			.get(args.keyId) as Raw | undefined;
		if (row === undefined) throw new ApiKeyError("unknown API key");
		if (row.revoked_at !== null) throw new ApiKeyError("that API key was revoked");

		const ts = Number(args.timestamp);
		if (!Number.isFinite(ts)) {
			throw new ApiKeyError(
				"the timestamp must be milliseconds since the epoch, as a number",
			);
		}
		const skew = Math.abs(now - ts);
		if (skew > SKEW_MS) {
			throw new ApiKeyError(
				`the timestamp is ${Math.round(skew / 1000)}s from ours, outside the ` +
					`${SKEW_MS / 1000}s window. Check the clock on the sending machine; ` +
					"a stale request is refused so a captured one cannot be replayed.",
			);
		}

		if (
			args.signature.length !== 64 ||
			!/^[0-9a-f]{64}$/i.test(args.signature)
		) {
			throw new ApiKeyError("the signature must be 64 hex characters (HMAC-SHA256)");
		}

		const mine = sign(row.signing_key, {
			timestamp: args.timestamp,
			method: args.method,
			path: args.path,
			body: args.body,
		});
		const a = Buffer.from(mine, "hex");
		const b = Buffer.from(args.signature.toLowerCase(), "hex");
		if (a.length !== b.length || !timingSafeEqual(a, b)) {
			throw new ApiKeyError(
				"signature mismatch. Sign the string " +
					"timestamp + METHOD + path + sha256(body) with HMAC-SHA256, using " +
					"the signing key from your key's setup page. The path excludes the " +
					"host and includes the query string.",
			);
		}

		/*
		 * REPLAY, inside the window. The signature is its own nonce.
		 *
		 * The INSERT is the check: a duplicate raises a constraint error, so
		 * two identical requests cannot both pass however they interleave.
		 */
		try {
			this.db
				.prepare(`INSERT INTO api_key_use (signature, key_id, at) VALUES (?, ?, ?)`)
				.run(args.signature.toLowerCase(), row.key_id, now);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/UNIQUE|constraint/i.test(msg)) {
				throw new ApiKeyError(
					"that exact request was already used. Each signed request is " +
						"single-use, so a double submit cannot place an order twice.",
				);
			}
			// A FAILURE TO RECORD IS A FAILURE TO AUTHENTICATE. Letting the
			// request through because the nonce store is broken would disable
			// the replay guard exactly when it cannot be trusted.
			throw new ApiKeyError(
				"could not record this request, so it is refused rather than " +
					`accepted without replay protection. Detail: ${msg}`,
				503,
			);
		}
		this.prune(now);

		const scopes = parseScopes(row.scopes);
		if (!scopes.includes(args.need)) {
			throw new ApiKeyError(
				`this key has ${scopes.join(", ") || "no"} access and this needs ` +
					`"${args.need}"`,
				403,
			);
		}

		// Per-key rate limit, over KEY_RATE_WINDOW_MS. The constant is exported
		// because the Retry-After this service sends on a 429 is derived from it
		// (publicapi.ts, RETRY_AFTER_SECONDS) — a hard-coded wait published next
		// to a window that later changed would teach every client to retry at
		// the wrong moment.
		const arr = (this.hits.get(args.keyId) ?? []).filter(
			(t) => now - t < KEY_RATE_WINDOW_MS,
		);
		if (arr.length >= row.rate_per_min) {
			arr.push(now);
			this.hits.set(args.keyId, arr);
			throw new ApiKeyError(
				`over this key's limit of ${row.rate_per_min} requests a minute`,
				429,
			);
		}
		arr.push(now);
		this.hits.set(args.keyId, arr);

		this.db
			.prepare(`UPDATE api_key SET last_used_at = ? WHERE key_id = ?`)
			.run(new Date(now).toISOString(), args.keyId);

		return { userId: row.user_id, key: hydrate(row) };
	}

	/**
	 * Drop replay records that can no longer matter.
	 *
	 * A request older than the skew window is already refused on its timestamp,
	 * so keeping its signature proves nothing. The cutoff is deliberately
	 * GENEROUS — twice the window — so a clock nudge cannot let a signature out
	 * of this table while it is still inside the accepted window.
	 */
	private prune(now: number): void {
		this.db
			.prepare(`DELETE FROM api_key_use WHERE at < ?`)
			.run(now - SKEW_MS * 2);
	}
}

function parseScopes(s: string): Scope[] {
	return s
		.split(",")
		.map((x) => x.trim().toLowerCase())
		.filter((x): x is Scope => SCOPES.includes(x as Scope));
}

function hydrate(r: Raw): ApiKeyRow {
	return {
		keyId: r.key_id,
		userId: r.user_id,
		label: r.label,
		scopes: parseScopes(r.scopes),
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
		revokedAt: r.revoked_at,
		ratePerMin: r.rate_per_min,
	};
}

/**
 * ONE VALUE, NOT TWO.
 *
 * An earlier draft issued a "secret" and had the client derive a signing key
 * from it. That is two things to get wrong for no benefit — the derivation was
 * one hash, both values were equally sensitive, and a client that derived it
 * incorrectly got an opaque signature mismatch. The key issues exactly one
 * value and the client signs with that.
 */
export const SIGNING_ALGORITHM = "HMAC-SHA256";
