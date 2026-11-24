// -----------------------------------------------------------------------------
// THE BITGO HTTP CORE — one request path, shared, with the token discipline.
//
// WHY THIS IS A SEPARATE FILE.
//
// `BitGoHoldings` is the reconciler's dependency, and it has a structural
// guarantee worth keeping: EVERY REQUEST IT MAKES IS A GET. That is what makes
// "the component that checks solvency cannot move money" true by construction
// rather than by review, and there is a test asserting it.
//
// Deposits need to POST — creating a receive address is a write. Adding a
// `post()` to the holdings class would have put a money-shaped verb on the
// object the reconciler holds, and the next person to add a method there would
// have had no structural reason not to use it.
//
// So the request plumbing — timeouts, redaction, the error hints — lives here
// and is shared, while the two CLIENTS stay distinct: holdings only ever calls
// `get`, deposits may call both. The guarantee survives and the plumbing is
// written once.
//
// THE TOKEN NEVER APPEARS IN AN ERROR. A fetch failure can echo the request
// including headers, which is how a bearer token lands in a log aggregator, so
// every error message goes through `redact` unconditionally rather than only
// where a leak seems plausible.
// -----------------------------------------------------------------------------

export class BitGoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BitGoError";
	}
}

export type BitGoEnv = "test" | "prod";

export const BASE_URL: Readonly<Record<BitGoEnv, string>> = {
	test: "https://app.bitgo-test.com/api/v2",
	prod: "https://app.bitgo.com/api/v2",
};

/**
 * Remove a token from any text before it is logged or thrown.
 *
 */
export function redact(text: string, token: string): string {
	if (token === "") return text;
	return text.split(token).join("[REDACTED]");
}

/**
 * Turn a BitGo HTTP failure into an actionable hint.
 *
 * WRITTEN AGAINST OBSERVED RESPONSES, not assumptions. An earlier version
 * attributed IP-whitelist rejections to HTTP 403 and read every 401 as "the
 * token is invalid, expired, or revoked" — which sends a developer hunting for
 * a dead token when the real problem is the source address. BitGo returns
 * **401** for both and distinguishes them only in the body:
 *
 *   401 {"error":"Attempt to use IP-restricted token from an unauthorized IP
 *        address", ...}                           <- whitelist mismatch
 *   401 {"error":"No access token", ...}          <- wrong installation, or no
 *                                                    such token
 */
export function hint(status: number, body: string): string {
	if (status === 401) {
		if (/IP-restricted|unauthorized IP/i.test(body)) {
			return (
				" — the token is valid but this source IP is not on its whitelist. " +
				"Check the EGRESS address actually used: if the host has IPv6, the " +
				"request may have left over IPv6 from a different address than the " +
				"whitelisted IPv4. Force IPv4 to confirm."
			);
		}
		if (/No access token/i.test(body)) {
			return (
				" — BitGo does not recognise this token in this environment. Test and " +
				"production hold SEPARATE tokens; check BITGO_ENV matches where the " +
				"token was created."
			);
		}
		return " — the token is invalid, expired, or revoked";
	}
	if (status === 403) {
		return " — forbidden: check the token's scopes and the acting user's wallet role";
	}
	if (status === 429) {
		return " — rate limited; back off rather than retrying immediately";
	}
	return "";
}

export interface HttpConfig {
	readonly env: BitGoEnv;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
}

/**
 * The shared request path.
 *
 * Deliberately NOT a class with public `get`/`post` that clients extend: each
 * client holds one of these and decides which verbs it exposes, so the
 * holdings client can offer `get` alone.
 */
export class BitGoHttp {
	readonly base: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(token: string, cfg: HttpConfig) {
		if (typeof token !== "string" || token.trim() === "") {
			throw new BitGoError("a BitGo access token is required");
		}
		this.token = token.trim();
		this.base = BASE_URL[cfg.env];
		this.timeoutMs = cfg.timeoutMs ?? 15_000;
		this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
		if (typeof this.fetchImpl !== "function") {
			throw new BitGoError("no fetch implementation available (Node >= 20 required)");
		}
	}

	/** For redacting the token out of messages built by a caller. */
	scrub(text: string): string {
		return redact(text, this.token);
	}

	async request<T>(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = `${this.base}${path}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: ac.signal,
			});

			if (!res.ok) {
				const text = await res.text().catch(() => "");
				const clean = redact(text, this.token);
				throw new BitGoError(
					`BitGo ${res.status} ${res.statusText} for ${method} ${path}` +
						(clean === "" ? "" : `: ${clean.slice(0, 400)}`) +
						hint(res.status, clean),
				);
			}

			return (await res.json()) as T;
		} catch (e) {
			if (e instanceof BitGoError) throw e;
			if (e instanceof Error && e.name === "AbortError") {
				throw new BitGoError(
					`BitGo request to ${path} timed out after ${this.timeoutMs}ms`,
				);
			}
			throw new BitGoError(
				`BitGo request to ${path} failed: ${redact(
					e instanceof Error ? e.message : String(e),
					this.token,
				)}`,
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
