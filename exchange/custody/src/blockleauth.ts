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
	 * Resolve the caller from a forwarded Cookie header, or a Bearer token.
	 *
	 * Takes the WHOLE header rather than a parsed cookie, because this service
	 * deliberately does not know which cookie carries the session — that is the
	 * accounts service's business, and hard-coding its name here would break
	 * silently the day it changes.
	 *
	 * BEARER IS FOR THE NATIVE APPS, and it is not a second auth system. The
	 * accounts service already accepts `Authorization: Bearer <session id>`
	 * for exactly this reason, in its own words: a SameSite=Lax cookie will not
	 * ride a cross-site fetch, so a phone app cannot authenticate the way a
	 * browser on blockle.org does. Without this the iOS wallet could read the
	 * public order book and nothing else — no balances, no orders.
	 *
	 * Both forms are forwarded verbatim to the SAME endpoint and the answer is
	 * believed the same way. This service still validates nothing itself, and
	 * an unreachable accounts service is still a 503 rather than an anonymous
	 * session.
	 */
	async whoami(
		cookieHeader: string | undefined,
		authorizationHeader?: string | undefined,
	): Promise<BlockleUser> {
		const cookie = (cookieHeader ?? "").trim();
		const authz = (authorizationHeader ?? "").trim();
		// Only a Bearer credential is forwarded. Anything else (Basic, a bare
		// token, an API-key scheme) is not an accounts session and must not be
		// handed to the accounts service as though it were.
		const bearer = /^Bearer\s+\S/i.test(authz) ? authz : "";
		if (cookie === "" && bearer === "") throw new AuthError("not signed in");

		// Distinct cache keys: the same person via cookie and via bearer are
		// two credentials, and one being revoked must not leave the other
		// resolving from a shared entry.
		const key = cacheKey(bearer === "" ? cookieKey(cookie) : bearerKey(bearer));
		const hit = this.cache.get(key);
		if (hit !== undefined && hit.until > this.now()) return hit.user;

		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs ?? 8_000);
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.cfg.base}/account/api/me`, {
				method: "GET",
				headers: {
					Accept: "application/json",
					...(cookie === "" ? {} : { Cookie: cookie }),
					...(bearer === "" ? {} : { Authorization: bearer }),
				},
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
	/**
	 * Drop a cached resolution so a sign-out takes effect at once.
	 *
	 * MUST stay in step with the key shape `whoami` uses. It did not, briefly,
	 * and the existing test caught it: when cookie keys gained a `c:` prefix
	 * for bearer support, this still deleted the unprefixed key — so a
	 * signed-out session went on resolving for the rest of the cache TTL. The
	 * prefixes are built in one place now so they cannot drift again.
	 */
	forget(credential: string | undefined): void {
		if (credential === undefined) return;
		// A caller may have been seen under either scheme; drop both rather
		// than require the caller to know which one it used.
		this.cache.delete(cacheKey(cookieKey(credential)));
		this.cache.delete(cacheKey(bearerKey(credential)));
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
/*
 * The two credential namespaces, in one place.
 *
 * A cookie and a bearer token are different credentials even for the same
 * person, so they get separate namespaces. This is DEFENSIVE, not load-bearing:
 * a cookie header and a "Bearer ..." string already differ, so nothing
 * currently collides without it — deleting the prefixes breaks no test. It
 * earns its place by keeping `whoami` and `forget` agreeing on one key shape,
 * which is the thing that actually broke when bearer support was added and
 * left signed-out sessions resolving from cache.
 */
function cookieKey(v: string): string {
	return `c:${v}`;
}
function bearerKey(v: string): string {
	return `b:${v}`;
}

function cacheKey(cookie: string): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { createHash } = require("node:crypto") as typeof import("node:crypto");
	return createHash("sha256").update(cookie).digest("hex");
}
