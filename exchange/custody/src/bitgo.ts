// -----------------------------------------------------------------------------
// BITGO HOLDINGS SOURCE — READ-ONLY BY CONSTRUCTION.
//
// This module can ask BitGo what it holds. It cannot move anything, and that is
// a structural decision rather than an oversight: the reconciler's whole job is
// to be the independent check on custody, so the thing it depends on must not
// be able to spend. Transfers will live in a separate, separately-gated module
// with its own approval path. Nothing here should ever grow a `send` method —
// add a new file instead.
//
// THE TOKEN IS NEVER LOGGED, NEVER SERIALISED, NEVER PUT IN A URL.
// It is read from the environment, held in a private field, and `redact()` is
// applied to every error string that leaves this module. BitGo access tokens
// are bearer credentials: anything that prints one has leaked it into logs,
// crash reports, and whatever aggregates them.
//
// PRECISION. BitGo returns both `balance` (a JSON number) and `balanceString`.
// We use the string, always. BitGo publishes `balanceString` precisely because
// the numeric field cannot hold a token balance without loss — 1 ETH is 10^18
// wei and IEEE-754 doubles run out of integer precision at ~9.007e15. Reading
// `balance` would silently corrupt the reconciliation it feeds.
//
// CONFIRMED ONLY. `HoldingsSource.holdings` is specified as confirmed balance,
// so this reads `confirmedBalanceString`. Using the unconfirmed figure would
// make the reconciler agree with a deposit that can still be reorged away,
// which is exactly the moment it should disagree.
// -----------------------------------------------------------------------------

import type { HoldingsSource } from "./reconcile";

export type BitGoEnv = "test" | "prod";

const BASE_URL: Readonly<Record<BitGoEnv, string>> = {
	test: "https://app.bitgo-test.com/api/v2",
	prod: "https://app.bitgo.com/api/v2",
};

export class BitGoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BitGoError";
	}
}

/**
 * Our venue-wide asset symbols mapped to BitGo coin tickers.
 *
 * BITGO USES DIFFERENT TICKERS PER ENVIRONMENT — testnet coins are `t`-prefixed
 * (`teth`, `tbtc`). Asking the test environment for `eth` does not fail loudly;
 * it returns nothing, which would read as a zero balance and therefore as a
 * SHORTFALL against real books. An explicit table per environment is the only
 * way this stays honest.
 *
 * Assets absent from this table are NOT silently passed through. A typo or an
 * unlisted asset must be an error, not a confident zero.
 */
const TICKERS: Readonly<Record<BitGoEnv, Readonly<Record<string, string>>>> = {
	prod: {
		BTC: "btc",
		ETH: "eth",
		USDC: "usdc",
		USDT: "usdt",
		SOL: "sol",
		LTC: "ltc",
		BCH: "bch",
		DOGE: "doge",
		TRX: "trx",
		XRP: "xrp",
		XLM: "xlm",
	},
	test: {
		BTC: "tbtc",
		ETH: "teth",
		// BitGo's test tokens live under the test chain's token namespace.
		USDC: "teth:usdc",
		USDT: "teth:usdt",
		SOL: "tsol",
		LTC: "tltc",
		BCH: "tbch",
		DOGE: "tdoge",
		TRX: "ttrx",
		XRP: "txrp",
		XLM: "txlm",
	},
};

/**
 * Assets this adapter must refuse outright, with a reason.
 *
 * BLOCK and BLOCK-20 are not BitGo-supported assets and never will be by
 * default — they are our own chain. Returning zero for them would make the
 * reconciler report the entire BLOCK book as a shortfall and halt withdrawals
 * for a reason that has nothing to do with reality. They are custodied by a
 * separate self-custody signer (see docs/CEX-ARCHITECTURE.md §6) behind its own
 * HoldingsSource.
 */
const NOT_BITGO: Readonly<Record<string, string>> = {
	BLOCK: "BLOCK is our own chain; it is self-custodied, not held at BitGo",
	BLOCK20: "BLOCK-20 tokens are self-custodied, not held at BitGo",
	// Perbug is a Bitcoin Core fork we run ourselves (sha256d, with BLOCK aux
	// merge-mining). BitGo does not list it and will not, so it takes the same
	// self-custody path as BLOCK: our own signer, behind its own HoldingsSource,
	// with the same journal, reconciliation and velocity caps.
	PERBUG: "PERBUG is our own chain; it is self-custodied, not held at BitGo",
};

export interface BitGoConfig {
	readonly env: BitGoEnv;
	/**
	 * Optional enterprise filter. Supply it once there is more than one
	 * enterprise on the account, or balances from an unrelated enterprise will
	 * be summed in and overstate holdings.
	 */
	readonly enterprise?: string;
	readonly timeoutMs?: number;
	/** Injected for tests. Defaults to global fetch. */
	readonly fetchImpl?: typeof fetch;
}

interface BalancesResponse {
	balances?: {
		coin?: string;
		balanceString?: string;
		confirmedBalanceString?: string;
	}[];
}

export class BitGoHoldings implements HoldingsSource {
	readonly name: string;

	private readonly token: string;
	private readonly base: string;
	private readonly env: BitGoEnv;
	private readonly enterprise: string | undefined;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	/**
	 * @param token  BitGo access token. Pass it in rather than reading the
	 *               environment here, so the single place that touches
	 *               `process.env` is `fromEnv()` and tests never need a real one.
	 */
	constructor(token: string, cfg: BitGoConfig) {
		if (typeof token !== "string" || token.trim() === "") {
			throw new BitGoError("a BitGo access token is required");
		}
		this.token = token.trim();
		this.env = cfg.env;
		this.base = BASE_URL[cfg.env];
		this.enterprise = cfg.enterprise;
		this.timeoutMs = cfg.timeoutMs ?? 15_000;
		this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
		this.name = `bitgo:${cfg.env}`;

		if (typeof this.fetchImpl !== "function") {
			throw new BitGoError("no fetch implementation available (Node >= 20 required)");
		}
	}

	/**
	 * Build from the environment.
	 *
	 * DEFAULTS TO THE TEST ENVIRONMENT. Production requires
	 * `BITGO_ENV=prod` to be set deliberately — a missing or misspelled value
	 * must never resolve to the environment holding real customer funds.
	 */
	static fromEnv(env: NodeJS.ProcessEnv = process.env): BitGoHoldings {
		const token = env.BITGO_ACCESS_TOKEN;
		if (token === undefined || token.trim() === "") {
			throw new BitGoError(
				"BITGO_ACCESS_TOKEN is not set. Put it in the environment — never " +
					"in a config file inside the repository.",
			);
		}
		const raw = (env.BITGO_ENV ?? "test").trim().toLowerCase();
		if (raw !== "test" && raw !== "prod") {
			throw new BitGoError(`BITGO_ENV must be "test" or "prod", got "${raw}"`);
		}
		const ent = env.BITGO_ENTERPRISE?.trim();
		return new BitGoHoldings(token, {
			env: raw,
			...(ent !== undefined && ent !== "" ? { enterprise: ent } : {}),
		});
	}

	/** The BitGo ticker for one of our asset symbols, in this environment. */
	ticker(asset: string): string {
		const refusal = NOT_BITGO[asset.toUpperCase()];
		if (refusal !== undefined) throw new BitGoError(refusal);
		const t = TICKERS[this.env][asset.toUpperCase()];
		if (t === undefined) {
			throw new BitGoError(
				`no BitGo ticker mapped for ${asset} in the ${this.env} environment — ` +
					"add it to TICKERS rather than letting it read as a zero balance",
			);
		}
		return t;
	}

	/**
	 * Confirmed holdings for one asset, in base units.
	 *
	 * Throws on any failure rather than returning 0n. The reconciler treats a
	 * throw as UNAVAILABLE ("we do not know") and a zero as a real balance; a
	 * network blip must never be reported as "we hold nothing", which would
	 * present as a total shortfall and halt withdrawals.
	 */
	async holdings(asset: string): Promise<bigint> {
		const coin = this.ticker(asset);
		const qs = new URLSearchParams({ coin, excludeEmptyBalances: "false" });
		if (this.enterprise !== undefined) qs.set("enterprise", this.enterprise);

		const body = await this.get<BalancesResponse>(`/wallet/balances?${qs}`);
		const rows = body.balances ?? [];

		// Match on the ticker we asked for. The endpoint can return several rows
		// (subtokens), and summing them all would conflate, say, ETH with every
		// ERC-20 held in the same wallet.
		const row = rows.find((r) => r.coin === coin);
		if (row === undefined) {
			// Genuinely absent is distinct from zero: it means BitGo has no wallet
			// for this coin at all, which is a configuration error worth raising
			// rather than a balance.
			throw new BitGoError(
				`BitGo returned no balance row for ${coin} — is a ${coin} wallet ` +
					`set up on this ${this.env} account?`,
			);
		}

		const s = row.confirmedBalanceString ?? row.balanceString;
		if (s === undefined) {
			throw new BitGoError(
				`BitGo returned a ${coin} row with no confirmedBalanceString; ` +
					"refusing to fall back to the lossy numeric field",
			);
		}
		return parseBaseUnits(s, coin);
	}

	/** Verify the token works and report who it belongs to. Read-only. */
	async whoami(): Promise<{ id: string; username: string | undefined }> {
		const me = await this.get<{ id?: string; username?: string }>("/user/me");
		if (me.id === undefined) {
			throw new BitGoError("BitGo /user/me returned no id");
		}
		return { id: me.id, username: me.username };
	}

	/** Wallets for a coin, for setup and diagnostics. Read-only. */
	async wallets(asset: string): Promise<{ id: string; label: string | undefined }[]> {
		const coin = this.ticker(asset);
		const body = await this.get<{ wallets?: { id?: string; label?: string }[] }>(
			`/${coin}/wallet`,
		);
		return (body.wallets ?? [])
			.filter((w): w is { id: string; label?: string } => typeof w.id === "string")
			.map((w) => ({ id: w.id, label: w.label }));
	}

	private async get<T>(path: string): Promise<T> {
		const url = `${this.base}${path}`;
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/json",
				},
				signal: ac.signal,
			});

			if (!res.ok) {
				const text = await res.text().catch(() => "");
				const body = redact(text, this.token);
				throw new BitGoError(
					`BitGo ${res.status} ${res.statusText} for ${path}` +
						(body === "" ? "" : `: ${body.slice(0, 400)}`) +
						hint(res.status, body),
				);
			}

			return (await res.json()) as T;
		} catch (e) {
			if (e instanceof BitGoError) throw e;
			if (e instanceof Error && e.name === "AbortError") {
				throw new BitGoError(`BitGo request to ${path} timed out after ${this.timeoutMs}ms`);
			}
			// Redact unconditionally: a fetch error can echo the request, headers
			// included, and that is how a bearer token ends up in a log file.
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

/**
 * Turn a BitGo HTTP failure into an actionable hint.
 *
 * WRITTEN AGAINST OBSERVED RESPONSES, not assumptions. The first version of
 * this code attributed IP-whitelist rejections to HTTP 403 and treated every
 * 401 as "the token is invalid, expired, or revoked" — which would have sent a
 * developer hunting for a dead token when the real problem was the source
 * address. BitGo actually returns **401** for both cases and distinguishes them
 * only in the body:
 *
 *   401 {"error":"Attempt to use IP-restricted token from an unauthorized IP
 *        address","name":"Unauthorized"}          <- whitelist mismatch
 *   401 {"error":"No access token","name":"Unauthorized"}
 *                                                 <- wrong environment, or no
 *                                                    such token
 *
 * That second one is worth calling out: BitGo's test and production
 * environments hold SEPARATE tokens, so a test token presented to
 * app.bitgo.com reads as "No access token" rather than as a permissions error.
 */
function hint(status: number, body: string): string {
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

/**
 * Parse a BitGo base-unit string to bigint.
 *
 * Strict: BitGo documents these as integer base units, so anything else
 * (a decimal point, an exponent, junk) means an assumption has broken and we
 * should stop rather than guess. A `Number()` round trip here would be the
 * precision bug this whole module exists to avoid.
 */
export function parseBaseUnits(s: string, coin: string): bigint {
	const t = s.trim();
	if (!/^-?\d+$/.test(t)) {
		throw new BitGoError(
			`BitGo returned a non-integer balance for ${coin}: ${JSON.stringify(s)} — ` +
				"expected base units",
		);
	}
	const v = BigInt(t);
	if (v < 0n) {
		throw new BitGoError(`BitGo reported a negative ${coin} balance: ${t}`);
	}
	return v;
}

/** Remove the token from any string about to be logged or thrown. */
export function redact(text: string, token: string): string {
	if (token === "") return text;
	return text.split(token).join("[REDACTED]");
}
