// -----------------------------------------------------------------------------
// AUTHENTICATION VIA THE EXISTING BLOCKLE ACCOUNT SYSTEM.
//
// The exchange does NOT have its own accounts. It asks the Blockle accounts
// service who the caller is, and uses that identity as the ledger's USER owner.
//
// WHY THIS IS THE RIGHT CALL AND MY ORIGINAL venue.ts AUTH WAS NOT.
//
// I built a second account system — register, login, scrypt, sessions. It
// worked, and it was wrong. Two account systems on one brand means two places
// to reset a password, two 2FA enrolments, two sets of session-expiry rules,
// and two things to get right when a customer says "I cannot log in". It also
// means the account that holds your BLOCK is not the account that trades it,
// which is exactly the kind of seam that produces support tickets nobody can
// resolve.
//
// HOW IT WORKS. The accounts service sets a session cookie scoped to
// `.blockle.org`, and `GET /account/api/me` returns `{ csrf, user }` for a
// valid session or 401 otherwise. `exchange.blockle.org` is inside that cookie
// domain, so the browser sends the cookie with no extra work — the exchange
// simply forwards it and believes the answer.
//
// THREE THINGS THAT MATTER ABOUT DOING IT THIS WAY:
//
// 1. THE COOKIE IS FORWARDED, NEVER PARSED. This service does not know the
//    session secret and must not: validating the cookie itself would mean
//    duplicating session logic that can then drift out of step with the
//    accounts service, which is how "logged out everywhere except one app"
//    happens.
//
// 2. A FAILED LOOKUP IS NEVER TREATED AS A SUCCESS. If the accounts service is
//    unreachable, that is a 503 — not an anonymous session, and certainly not
//    a fallback to some local account table. An auth system that degrades to
//    "allow" under load is not an auth system.
//
// 3. IDENTITY IS THE ACCOUNTS SERVICE'S ID, NOT THE EMAIL. Emails change.
//    Keying ledger balances on an email would mean a customer changing their
//    address loses their money, which is the single worst bug this file could
//    contain.
// -----------------------------------------------------------------------------

export class AuthError extends Error {
	constructor(
		message: string,
		readonly status = 401,
	) {
		super(message);
		this.name = "AuthError";
	}
}

export interface BlockleUser {
	/** Stable account id. THE LEDGER KEY. Never the email. */
	readonly id: string;
	readonly email: string | undefined;
	/** CSRF token the accounts service expects on its own mutations. */
	readonly csrf: string | undefined;
	/** Whether the Blockle account has 2FA enrolled, if it tells us. */
	readonly twoFactor: boolean | undefined;
}

export interface AuthConfig {
	/** Base URL of the accounts service, e.g. https://blockle.org */
	readonly base: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	/**
	 * Cache window for a verified session, in milliseconds.
	 *
	 * Without one, every poll of every open page is an extra HTTP round trip to
	 * the accounts service — the trading UI refreshes every four seconds, so a
	 * handful of users would quietly become a sustained load on an unrelated
	 * service. Short enough that a sign-out takes effect promptly.
	 */
	readonly cacheMs?: number;
}

interface CacheEntry {
	user: BlockleUser;
	until: number;
}

export class BlockleAuth {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly fetchImpl: typeof fetch;

	constructor(
		private readonly cfg: AuthConfig,
		private readonly now: () => number = () => Date.now(),
	) {
		this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
		if (typeof this.fetchImpl !== "function") {
			throw new AuthError("no fetch implementation available", 500);
		}
	}

	/**
	 * Resolve the caller from a forwarded Cookie header.
	 *
	 * Takes the WHOLE header rather than a parsed cookie, because this service
	 * deliberately does not know which cookie carries the session — that is the
	 * accounts service's business, and hard-coding its name here would break
	 * silently the day it changes.
	 */
	async whoami(cookieHeader: string | undefined): Promise<BlockleUser> {
		const cookie = (cookieHeader ?? "").trim();
		if (cookie === "") throw new AuthError("not signed in");

		const key = cacheKey(cookie);
		const hit = this.cache.get(key);
		if (hit !== undefined && hit.until > this.now()) return hit.user;

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs ?? 8_000);
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.cfg.base}/account/api/me`, {
				method: "GET",
				headers: { Cookie: cookie, Accept: "application/json" },
				signal: ac.signal,
			});
		} catch (e) {
			// UNREACHABLE IS 503, NOT ANONYMOUS. See note 2 above.
			throw new AuthError(
				`the account service is unreachable (${
					e instanceof Error ? e.message : String(e)
				}); refusing to guess who you are`,
				503,
			);
		} finally {
			clearTimeout(timer);
		}

		if (res.status === 401 || res.status === 403) {
			this.cache.delete(key);
			throw new AuthError("not signed in");
		}
		if (!res.ok) {
			throw new AuthError(
				`the account service returned ${res.status}; refusing to proceed`,
				503,
			);
		}

		const body = (await res.json().catch(() => null)) as unknown;
		const user = extractUser(body);
		this.cache.set(key, {
			user,
			until: this.now() + (this.cfg.cacheMs ?? 15_000),
		});
		return user;
	}

	/** Drop a cached session, so a sign-out takes effect immediately. */
	forget(cookieHeader: string | undefined): void {
		if (cookieHeader !== undefined) this.cache.delete(cacheKey(cookieHeader));
	}
}

/**
 * Pull the user out of whatever shape /account/api/me returns.
 *
 * Tolerant about the envelope (`{user:{...}}` or a bare object) and strict
 * about the one field that matters. A missing id is a hard error rather than a
 * fallback to the email, because keying balances on an email means a customer
 * who changes their address loses their funds.
 */
export function extractUser(body: unknown): BlockleUser {
	if (typeof body !== "object" || body === null) {
		throw new AuthError("the account service returned a malformed response", 503);
	}
	const o = body as Record<string, unknown>;
	const u = (typeof o.user === "object" && o.user !== null
		? o.user
		: o) as Record<string, unknown>;

	const id = firstString(u.id, u.accountId, u.account_id, u.uid, u.sub);
	if (id === undefined) {
		throw new AuthError(
			"the account service did not return a stable account id — refusing to " +
				"key balances on anything else",
			503,
		);
	}
	const email = firstString(u.email, u.username);
	const twoFactorRaw = u.twoFactor ?? u.two_factor ?? u.twoFactorEnabled ?? u.mfa;
	return {
		id,
		email,
		csrf: firstString(o.csrf, u.csrf),
		twoFactor: typeof twoFactorRaw === "boolean" ? twoFactorRaw : undefined,
	};
}

function firstString(...vals: unknown[]): string | undefined {
	for (const v of vals) {
		if (typeof v === "string" && v.trim() !== "") return v.trim();
	}
	return undefined;
}

/**
 * Cache key for a cookie header.
 *
 * HASHED, so the in-memory map never holds a live session cookie in plaintext
 * where a heap dump or an error serialisation could expose it.
 */
function cacheKey(cookie: string): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { createHash } = require("node:crypto") as typeof import("node:crypto");
	return createHash("sha256").update(cookie).digest("hex");
}
