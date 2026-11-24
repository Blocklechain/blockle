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

import { bitgoTicker, networkOf, settlementAsset } from "./assets";
import type { HoldingsSource } from "./reconcile";

export type BitGoEnv = "test" | "prod";

/**
 * Which SET OF COIN TICKERS to use, separately from which BitGo system we talk
 * to.
 *
 * WHY THESE ARE TWO SETTINGS AND NOT ONE.
 *
 * They were one. `BITGO_ENV=prod` meant both "talk to app.bitgo.com" and "ask
 * for mainnet coins", which reads as obviously right and quietly forbids a
 * combination an operator genuinely wants: a PRODUCTION BitGo account holding
 * TESTNET coins, so the venue can be exercised end-to-end against the real
 * custody system — real account, real API, real wallet policies, real
 * approvals — without real money moving.
 *
 * BitGo's two systems are entirely separate installations with separate
 * accounts and separate tokens. A test token gets a flat 401 from
 * app.bitgo.com and vice versa; there is no single token that spans them. So
 * "use a production token for both modes" means: point at the production
 * system, and choose the coin set per mode.
 *
 * `coins` DEFAULTS TO MATCHING `env`, because that is the common case and an
 * operator who sets neither should get the safe pairing. Overriding it is
 * deliberate and is logged.
 */
export type BitGoCoins = "mainnet" | "testnet";

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
const TICKERS: Readonly<Record<BitGoCoins, Readonly<Record<string, string>>>> = {
	mainnet: {
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
	testnet: {
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
	/** Which BitGo installation to talk to. Decides the host and the token. */
	readonly env: BitGoEnv;
	/**
	 * Which coin tickers to ask for. Defaults to matching `env`: a test system
	 * holds testnet coins, a production one holds mainnet coins. Set explicitly
	 * to run testnet coins on a production account.
	 */
	readonly coins?: BitGoCoins;
	/**
	 * Optional enterprise filter. Supply it once there is more than one
	 * enterprise on the account, or balances from an unrelated enterprise will
	 * be summed in and overstate holdings.
	 */
	readonly enterprise?: string;
	/**
	 * WHICH WALLETS ARE THE EXCHANGE'S.
	 *
	 * Required in practice, and the reason is concrete. The production account
	 * this venue uses also holds wallets for other projects and a personal one
	 * — `Perbug BTC`, `FROGE XRP`, `epic2epic@gmail.com` — with real balances
	 * in them. BitGo's account-wide balance call sums every wallet for a coin,
	 * so without a scope the reconciler counts somebody else's XRP as exchange
	 * custody. Books would then show LESS than custody, which reads as a
	 * SURPLUS, which is tolerated, which means a genuine shortfall of up to
	 * that size is invisible. The one check that exists to catch insolvency,
	 * defeated by a shared account.
	 *
	 * Either form may be given:
	 *   - `walletIds`: exact BitGo wallet ids. Unambiguous; preferred.
	 *   - `labelPrefix`: every wallet whose label starts with it.
	 *
	 * Neither given is NOT "use everything" — see `holdings`.
	 */
	readonly walletIds?: readonly string[];
	readonly labelPrefix?: string;
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
	private readonly coins: BitGoCoins;
	private readonly enterprise: string | undefined;
	private readonly walletIds: ReadonlySet<string> | undefined;
	private readonly labelPrefix: string | undefined;
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
		// Defaults to the safe pairing; see the note on BitGoCoins.
		this.coins = cfg.coins ?? (cfg.env === "prod" ? "mainnet" : "testnet");
		this.base = BASE_URL[cfg.env];
		this.enterprise = cfg.enterprise;
		this.walletIds =
			cfg.walletIds !== undefined && cfg.walletIds.length > 0
				? new Set(cfg.walletIds)
				: undefined;
		this.labelPrefix =
			cfg.labelPrefix !== undefined && cfg.labelPrefix.trim() !== ""
				? cfg.labelPrefix.trim()
				: undefined;
		this.timeoutMs = cfg.timeoutMs ?? 15_000;
		this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
		// THE NAME CARRIES BOTH, because it is what the reconciler logs and
		// what the admin console shows. "bitgo:prod" alone would not tell an
		// operator whether the figures underneath are real money.
		this.name =
			this.coins === (cfg.env === "prod" ? "mainnet" : "testnet")
				? `bitgo:${cfg.env}`
				: `bitgo:${cfg.env}/${this.coins}`;

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
		const coinsRaw = (env.BITGO_COINS ?? "").trim().toLowerCase();
		if (coinsRaw !== "" && coinsRaw !== "mainnet" && coinsRaw !== "testnet") {
			throw new BitGoError(
				`BITGO_COINS must be "mainnet" or "testnet", got "${coinsRaw}"`,
			);
		}
		const ent = env.BITGO_ENTERPRISE?.trim();
		// Wallet scope. Comma/space separated ids, and/or a label prefix.
		const ids = (env.BITGO_WALLETS ?? "")
			.split(/[,\s]+/)
			.map((x) => x.trim())
			.filter((x) => x !== "");
		const prefix = (env.BITGO_WALLET_PREFIX ?? "").trim();
		return new BitGoHoldings(token, {
			env: raw,
			...(coinsRaw === "" ? {} : { coins: coinsRaw }),
			...(ent !== undefined && ent !== "" ? { enterprise: ent } : {}),
			...(ids.length > 0 ? { walletIds: ids } : {}),
			...(prefix !== "" ? { labelPrefix: prefix } : {}),
		});
	}

	/** Which BitGo installation and coin set this instance is bound to. */
	describe(): { env: BitGoEnv; coins: BitGoCoins; realMoney: boolean } {
		return {
			env: this.env,
			coins: this.coins,
			// THE ONLY QUESTION THAT MATTERS for a safety check: would a mistake
			// here move real money? Production coins on the production system
			// is the only combination where it would.
			realMoney: this.env === "prod" && this.coins === "mainnet",
		};
	}

	/**
	 * Confirm the token belongs to the configured environment, and say which
	 * one it DOES belong to when it does not.
	 *
	 * This exists because the two installations return an indistinguishable
	 * 401 for "wrong environment", "IP not whitelisted" and "revoked token" —
	 * a token pointed at the wrong host reads exactly like a bad token, and
	 * that cost real time to work out by hand. Now it is one call that names
	 * the answer.
	 */
	async verifyEnvironment(): Promise<{
		ok: boolean;
		env: BitGoEnv;
		belongsTo: BitGoEnv | undefined;
		detail: string;
	}> {
		const tryOne = async (e: BitGoEnv): Promise<boolean> => {
			try {
				const res = await this.fetchImpl(`${BASE_URL[e]}/user/me`, {
					method: "GET",
					headers: { Authorization: `Bearer ${this.token}` },
				});
				return res.ok;
			} catch {
				return false;
			}
		};

		if (await tryOne(this.env)) {
			return {
				ok: true,
				env: this.env,
				belongsTo: this.env,
				detail: `token authenticates against ${BASE_URL[this.env]}`,
			};
		}
		const other: BitGoEnv = this.env === "prod" ? "test" : "prod";
		if (await tryOne(other)) {
			return {
				ok: false,
				env: this.env,
				belongsTo: other,
				detail:
					`BITGO_ENV=${this.env} but this token authenticates against the ` +
					`${other} installation (${BASE_URL[other]}). BitGo's two systems ` +
					"are separate accounts with separate tokens; one token never " +
					`spans them. Either set BITGO_ENV=${other}, or supply a ` +
					`${this.env} token.`,
			};
		}
		return {
			ok: false,
			env: this.env,
			belongsTo: undefined,
			detail:
				"this token authenticates against NEITHER installation. That is a " +
				"revoked token, a typo, or — most often on this box — an IP that is " +
				"not on the token's whitelist. BitGo returns the same 401 for all " +
				"three.",
		};
	}

	/**
	 * The BitGo ticker for one of our asset ids.
	 *
	 * HANDLES CHAIN-QUALIFIED IDS, which is the form custody actually uses.
	 * `USDT.TRC20` is a different BitGo coin from `USDT.ERC20` (`trx:usdt` and
	 * `eth:usdt`), and the per-network mapping already lives in assets.ts
	 * beside the network definition. Looking a qualified id up in the flat
	 * table here returned undefined and threw "no ticker mapped", so every
	 * multi-network custody check failed for a reason that sounded like a
	 * missing entry rather than a missing lookup.
	 */
	ticker(asset: string): string {
		const sym = settlementAsset(asset).toUpperCase();
		const refusal = NOT_BITGO[sym];
		if (refusal !== undefined) throw new BitGoError(refusal);

		if (networkOf(asset) !== undefined) {
			// Qualified: the mapping is the network's own.
			return bitgoTicker(asset, this.coins === "mainnet" ? "prod" : "test");
		}
		const t = TICKERS[this.coins][sym];
		if (t === undefined) {
			throw new BitGoError(
				`no BitGo ticker mapped for ${asset} in the ${this.coins} coin set — ` +
					"add it to TICKERS rather than letting it read as a zero balance",
			);
		}
		return t;
	}

	/**
	 * Wallets for a coin that belong to THE EXCHANGE.
	 *
	 * Fails closed in both directions, and the two refusals are deliberately
	 * different because the fixes are different:
	 *
	 *  - NO SCOPE CONFIGURED: refuse, and list what is on the account. Summing
	 *    everything would silently fold other projects' balances into exchange
	 *    custody (see the note on `walletIds`).
	 *  - SCOPE MATCHES NOTHING: refuse. Zero matching wallets means the wallet
	 *    has not been created or the scope is wrong, and reporting 0n would
	 *    present as a total shortfall and halt the asset.
	 */
	private async scopedWallets(coin: string): Promise<
		{ id: string; label: string; balance: bigint }[]
	> {
		// The enterprise filter still narrows the LIST, which is a second,
		// coarser scope than the wallet allowlist and worth keeping: on an
		// account with several enterprises it stops the list including wallets
		// this deployment has no business reading at all.
		const qs = new URLSearchParams();
		if (this.enterprise !== undefined) qs.set("enterprise", this.enterprise);
		const suffix = qs.toString() === "" ? "" : `?${qs.toString()}`;
		const body = await this.get<{
			wallets?: {
				id?: string;
				label?: string;
				confirmedBalanceString?: string;
				balanceString?: string;
			}[];
		}>(`/${coin}/wallet${suffix}`);
		const all = (body.wallets ?? []).filter(
			(w): w is { id: string; label?: string; confirmedBalanceString?: string; balanceString?: string } =>
				typeof w.id === "string",
		);

		if (this.walletIds === undefined && this.labelPrefix === undefined) {
			throw new BitGoError(
				`no exchange wallet scope is configured, and the account has ` +
					`${all.length} ${coin} wallet(s): ` +
					all.map((w) => `${w.label ?? "?"} (${w.id})`).join(", ") +
					". Refusing to treat all of them as exchange custody — this " +
					"account also holds wallets for other projects, and counting " +
					"those would make a real shortfall look like a surplus. Set " +
					"BITGO_WALLETS or BITGO_WALLET_PREFIX.",
			);
		}

		const mine = all.filter((w) => {
			if (this.walletIds !== undefined && this.walletIds.has(w.id)) return true;
			if (
				this.labelPrefix !== undefined &&
				(w.label ?? "").startsWith(this.labelPrefix)
			) {
				return true;
			}
			return false;
		});

		if (mine.length === 0) {
			throw new BitGoError(
				`no exchange wallet matched the configured scope for ${coin}. The ` +
					`account has: ${all.map((w) => `${w.label ?? "?"} (${w.id})`).join(", ") || "(none)"}. ` +
					"Reporting zero here would present as a total shortfall and halt " +
					"the asset, so this is an error instead.",
			);
		}

		return mine.map((w) => ({
			id: w.id,
			label: w.label ?? "",
			// CONFIRMED only. An unconfirmed deposit is not ours to count yet,
			// and counting it would let a reorg turn a balanced book into a
			// shortfall.
			balance: parseBaseUnits(
				w.confirmedBalanceString ?? w.balanceString ?? "0",
				coin,
			),
		}));
	}

	/** The exchange's wallets for an asset, for the admin console. */
	async exchangeWallets(
		asset: string,
	): Promise<{ id: string; label: string; balance: bigint }[]> {
		return this.scopedWallets(this.ticker(asset));
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
		/*
		 * SUMMED OVER THE EXCHANGE'S WALLETS ONLY.
		 *
		 * This used to call `/wallet/balances?coin=…`, which is an
		 * ACCOUNT-WIDE total. On a dedicated account that is the same number
		 * and the simpler call. On the account this venue actually uses it is
		 * not: that account also holds `Perbug BTC`, `FROGE XRP` and a personal
		 * wallet, with real balances. The account-wide figure therefore
		 * included other people's money as exchange custody — books below
		 * custody, reported as a SURPLUS, which reconcile tolerates, which
		 * means a genuine shortfall up to that size would never have been
		 * flagged. Found by listing the account's wallets rather than assuming
		 * it was ours alone.
		 */
		const mine = await this.scopedWallets(coin);
		let total = 0n;
		for (const w of mine) total += w.balance;
		return total;
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
