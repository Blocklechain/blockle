// -----------------------------------------------------------------------------
// CHAIN ADAPTERS — custody for coins no custodian will hold.
//
// BitGo covers BTC, ETH, the stablecoins and a handful of majors. It will not
// custody Raptoreum, and nobody else will either. So for the small
// proof-of-work coins this venue exists to serve, the venue runs the node and
// the node IS the custodian.
//
// THAT IS A DIFFERENT RISK AND IT IS WRITTEN DOWN HERE.
//
// With BitGo, key shares are theirs and a send needs their policy to agree.
// With a daemon we run, the hot wallet is a file on a box, and anything that
// can call its RPC can spend it. Nothing in this file pretends otherwise. What
// it does instead:
//
//   * READ-ONLY BY DEFAULT. An adapter cannot send unless it was constructed
//     with sending explicitly enabled. The default object cannot move money.
//   * CAPABILITIES ARE DECLARED AND PROBED. `probe()` asks the node what it can
//     actually do rather than assuming the family's usual answer, because the
//     forks differ: some bitcoind descendants have no `getnewaddress` in a
//     descriptor wallet, some EVM nodes are behind a provider that will not
//     sign anything.
//   * AMOUNTS CROSS AS STRINGS AND BECOME bigint. A JSON number loses an
//     18-decimal balance, and a lost digit here is a lost coin.
//   * NO ADAPTER INVENTS A BALANCE. Every failure throws. A custody source that
//     returns zero when it cannot reach its node would read as "the customers'
//     coins are gone", which halts the venue, or worse, as a surplus elsewhere.
//
// THE THREE FAMILIES, AND WHY EACH NEEDS ITS OWN CODE.
//
//   bitcoin-rpc  getbalance / getnewaddress / sendtoaddress. The ubiquitous
//                shape, but amounts are DECIMAL COINS, not base units, and the
//                conversion is where precision dies.
//   evm-rpc      eth_getBalance in wei, hex-encoded. No wallet: an EVM node
//                does not hold keys, so deposits need derived addresses from a
//                key this service does not have. Read-only until one is wired,
//                and it says so rather than appearing to work.
//   monero-rpc   a WALLET process, not a node. Subaddresses are the best
//                per-customer deposit attribution of any chain here — the
//                wallet tells you which subaddress received, exactly.
// -----------------------------------------------------------------------------

import { EVM_CHAIN_RULES } from "./evmscan";

/*
 * NO PER-REQUEST IPv4 PINNING HERE, DELIBERATELY.
 *
 * The first version spread `pinAndVerify(url)` into the fetch options, which
 * was wrong twice: it is an ASYNC STARTUP CHECK, not a fetch option, so
 * spreading the promise contributed nothing to the request — and it takes a
 * HOSTNAME, so passing a full URL made it resolve "http://127.0.0.1:8445/..."
 * as a host and print a warning on every single call.
 *
 * The pin itself is process-global (`pinIPv4` sets the DNS result order), so
 * the services that need it apply it once at startup and every adapter in the
 * process inherits it. See ipv4.ts.
 */
export class ChainError extends Error {
	constructor(
		message: string,
		readonly retryable = false,
		/**
		 * The daemon's own JSON-RPC error code, where there was one.
		 *
		 * Kept because some decisions must not rest on English prose. Asking
		 * "can this node spend a custody address?" is answered by `dumpprivkey`
		 * failing, and the difference between "there is no key here" (-4) and
		 * "the wallet is locked" (-13) is the difference between verified
		 * read-only and merely unverified. Both arrive as an exception; only the
		 * code tells them apart without matching a message that a fork is free
		 * to reword.
		 */
		readonly rpcCode: number | undefined = undefined,
	) {
		super(message);
		this.name = "ChainError";
	}
}

/** What an adapter can actually do, as the node answers it. */
export interface ChainCapabilities {
	readonly reachable: boolean;
	readonly synced: boolean;
	/** Chain height, for the "is it synced" question and for operator eyes. */
	readonly height: number | undefined;
	/** Base-unit decimals, where the node can be asked. Undefined if not. */
	readonly decimals: number | undefined;
	readonly canDeriveAddresses: boolean;
	readonly canSend: boolean;
	/** Anything the operator should read. Never a reason to proceed anyway. */
	readonly notes: readonly string[];
}

/** One incoming payment, as the chain reports it. */
export interface IncomingPayment {
	/** Chain transaction id. The idempotency key for crediting. */
	readonly txid: string;
	/** The address that received — how the deposit is attributed to a customer. */
	readonly address: string;
	/** Base units. */
	readonly amount: bigint;
	readonly confirmations: number;
	/**
	 * A CHAIN-QUALIFIED IDENTITY FOR THIS ONE ARRIVAL, where the txid alone is
	 * not unique.
	 *
	 * WHY THIS FIELD EXISTS, AND WHY IT IS OPTIONAL RATHER THAN MANDATORY.
	 *
	 * The node feed's identity is the bare txid (depositwatcher.ts nodeTransfers
	 * sets `id = r.txid`) on the stated assumption that "a txid paying two of
	 * our addresses yields two rows with different addresses". That assumption
	 * holds for the bitcoind family, whose explorer nets per address. It is
	 * false twice on EVM: one transaction can pay the same address more than
	 * once through internal calls, and one transaction can emit several ERC-20
	 * Transfer events to the same address. Each arrival after the first would be
	 * swallowed as a replay by the ledger and the customer silently
	 * under-credited. Chain qualification is needed as well, because the same
	 * secp256k1 address receives on Ethereum, BSC and Polygon BY DESIGN.
	 *
	 * IT IS OPTIONAL BECAUSE CHANGING AN IDEMPOTENCY KEY ON A LIVE VENUE
	 * DOUBLE-CREDITS EVERY DEPOSIT THAT WAS ALREADY PAID.
	 *
	 * The watcher keys its ledger post on `deposit:<transferId>:<address>`. If
	 * that spelling changed for existing rails, every already-credited deposit
	 * the custodian still reports in its recent window would arrive under a NEW
	 * key, the ledger's replay check would not recognise it, and it would be
	 * credited a second time. So adapters that have always reported a bare txid
	 * keep reporting exactly that, and only an adapter that sets `ref` gets the
	 * composite identity — which the watcher then uses verbatim as the transfer
	 * id, so the key and the `deposit_seen` primary key both become unique
	 * without a migration and without touching one existing row.
	 */
	readonly ref?: string;
}

/**
 * The adapter contract.
 *
 * Deliberately small. Everything the venue does with a chain it does not
 * custody through BitGo reduces to: how much is there, give me an address,
 * what came in, send this out.
 */
export interface ChainAdapter {
	readonly symbol: string;
	readonly route: string;
	probe(): Promise<ChainCapabilities>;
	/** Total held, in base units. Throws rather than guessing. */
	balance(): Promise<bigint>;
	/** A fresh address for one customer. Labelled so it can be recognised. */
	newAddress(label: string): Promise<string>;
	/** Everything received since `sinceHeight`, or recently if unsupported. */
	incoming(sinceHeight?: number): Promise<readonly IncomingPayment[]>;
	/**
	 * Send. Refuses unless the adapter was built with sending enabled.
	 *
	 * `idempotencyKey` is the caller's withdrawal id. An adapter that cannot
	 * honour it MUST say so in `probe().notes` rather than quietly sending
	 * twice on a retry.
	 */
	send(args: {
		to: string;
		amount: bigint;
		idempotencyKey: string;
	}): Promise<{ txid: string }>;
}

/* -------------------------------------------------------- decimal conversion */

/**
 * A decimal string to base units, EXACTLY or not at all.
 *
 * bitcoind reports "0.00000001" and "12.5"; some forks report an integer. Going
 * through a double loses the low digits of an 8-decimal amount above about
 * 90,000 coins, and silently — which is why this is string surgery.
 *
 * Extra precision THROWS. It cannot be rounded away: rounding a balance down
 * invents a shortfall, rounding it up invents coins that are not there.
 */
export function decimalToBase(value: string, decimals: number): bigint {
	const s = value.trim();
	if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
		throw new ChainError(`not a decimal amount: ${JSON.stringify(value)}`);
	}
	if (/[eE]/.test(s)) {
		// Exponent form from a JSON encoder that decided 1e-8 was tidier. The
		// digits are all there; expanding it is mechanical, and refusing it
		// would reject a legitimate node response.
		return decimalToBase(expand(s), decimals);
	}
	const neg = s.startsWith("-");
	const body = neg ? s.slice(1) : s;
	const [whole, frac = ""] = body.split(".") as [string, string?];
	if (frac.length > decimals) {
		const trimmed = frac.replace(/0+$/, "");
		if (trimmed.length > decimals) {
			throw new ChainError(
				`${value} has more precision than ${decimals} decimals. Refusing to ` +
					"round: rounding a custody balance down invents a shortfall and " +
					"rounding it up invents coins.",
			);
		}
	}
	const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
	const n = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
	return neg ? -n : n;
}

/** Base units back to a decimal string, for an RPC that wants coins. */
export function baseToDecimal(units: bigint, decimals: number): string {
	const neg = units < 0n;
	const abs = neg ? -units : units;
	const d = 10n ** BigInt(decimals);
	const whole = abs / d;
	const frac = (abs % d).toString().padStart(decimals, "0").replace(/0+$/, "");
	return `${neg ? "-" : ""}${whole}${frac === "" ? "" : "." + frac}`;
}

function expand(s: string): string {
	const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([-+]?\d+)$/.exec(s);
	if (m === null) throw new ChainError(`cannot expand ${s}`);
	const [, sign = "", whole = "0", frac = "", expStr = "0"] = m;
	const exp = Number(expStr);
	const digits = whole + frac;
	const point = whole.length + exp;
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/* ------------------------------------------------------------------ JSON-RPC */

export interface RpcConfig {
	readonly url: string;
	readonly user?: string;
	readonly password?: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	/**
	 * SENDING IS OPT-IN. Absent or false and `send` refuses, so an adapter
	 * built for reconciliation cannot be talked into moving money by a bug
	 * somewhere else.
	 */
	readonly allowSend?: boolean;
	/** Wallet passphrase, for daemons that keep the wallet locked. */
	readonly passphrase?: string;
}

interface RpcResult<T> {
	result?: T;
	error?: { code?: number; message?: string } | null;
}

/** A JSON-RPC caller shared by the bitcoind and Monero adapters. */
export class JsonRpc {
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private id = 0;

	constructor(private readonly cfg: RpcConfig) {
		if (!/^https?:\/\//.test(cfg.url)) {
			throw new ChainError(`RPC url must be http(s): ${cfg.url}`);
		}
		this.timeoutMs = cfg.timeoutMs ?? 20_000;
		this.fetchImpl = cfg.fetchImpl ?? fetch;
	}

	async call<T>(method: string, params: unknown[] | Record<string, unknown> = []): Promise<T> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.cfg.user !== undefined) {
			const basic = Buffer.from(`${this.cfg.user}:${this.cfg.password ?? ""}`)
				.toString("base64");
			headers.authorization = `Basic ${basic}`;
		}
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await this.fetchImpl(this.cfg.url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: ++this.id,
					method,
					params,
				}),
				signal: ctl.signal,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new ChainError(
				`${method} could not reach ${this.cfg.url}: ${msg}`,
				true, // a network failure is worth retrying; a wrong answer is not
			);
		} finally {
			clearTimeout(timer);
		}

		const text = await res.text();
		if (!res.ok && text.trim() === "") {
			throw new ChainError(`${method} failed: HTTP ${res.status}`, res.status >= 500);
		}
		let body: RpcResult<T>;
		try {
			body = JSON.parse(text) as RpcResult<T>;
		} catch {
			throw new ChainError(
				`${method} returned ${res.status} and a body that is not JSON: ` +
					text.slice(0, 200),
			);
		}
		if (body.error !== undefined && body.error !== null) {
			throw new ChainError(
				`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`,
				false,
				typeof body.error.code === "number" ? body.error.code : undefined,
			);
		}
		if (body.result === undefined) {
			throw new ChainError(`${method} returned no result`);
		}
		return body.result;
	}

	/**
	 * A BATCHED JSON-RPC CALL: one HTTP request, one array, N results.
	 *
	 * WHY THIS IS NOT A PERFORMANCE NICETY. The EVM reconciler has to read one
	 * balance per customer address, and it read them SERIALLY — one HTTP round
	 * trip each. At a few thousand customers that is a multi-minute pass against
	 * a rate-limited endpoint, and a pass that times out half way through is
	 * worse than no pass at all: books-versus-custody is this venue's only
	 * insolvency check, and a partial custody figure reads as a SHORTFALL, which
	 * has no tolerance at any size and halts a perfectly healthy asset.
	 *
	 * RESULTS ARE MATCHED BY ID, NEVER BY POSITION. The JSON-RPC 2.0 spec
	 * explicitly allows a server to return a batch in any order, and some do.
	 * Reading them positionally would silently attribute customer A's balance to
	 * customer B — the sum would still be right, which is exactly what makes
	 * that bug survive review, and then wrong the moment anything cares which
	 * address held what (a sweep proposal does).
	 *
	 * AN INCOMPLETE BATCH THROWS. A missing or errored entry is not zero. Zero
	 * is the single most dangerous value this file can return.
	 */
	async batch<T>(calls: readonly { method: string; params?: unknown[] }[]): Promise<T[]> {
		if (calls.length === 0) return [];
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.cfg.user !== undefined) {
			const basic = Buffer.from(`${this.cfg.user}:${this.cfg.password ?? ""}`)
				.toString("base64");
			headers.authorization = `Basic ${basic}`;
		}
		const ids = calls.map(() => ++this.id);
		const body = calls.map((c, i) => ({
			jsonrpc: "2.0",
			id: ids[i],
			method: c.method,
			params: c.params ?? [],
		}));
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await this.fetchImpl(this.cfg.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: ctl.signal,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new ChainError(`batch of ${calls.length} could not reach the node: ${msg}`, true);
		} finally {
			clearTimeout(timer);
		}
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new ChainError(
				`a batch of ${calls.length} returned ${res.status} and a body that is ` +
					`not JSON: ${text.slice(0, 200)}`,
				res.status >= 500,
			);
		}
		if (!Array.isArray(parsed)) {
			/*
			 * A SINGLE OBJECT INSTEAD OF AN ARRAY IS A REFUSAL, NOT A RESULT.
			 * Some providers answer a batch they do not support with one error
			 * object. Treating that as "the first call's answer" would report one
			 * address's balance as the whole treasury.
			 */
			throw new ChainError(
				`a batch of ${calls.length} was answered with a single object rather ` +
					"than an array, which means this endpoint does not support batching. " +
					`Refusing to read it as one result: ${text.slice(0, 200)}`,
			);
		}
		const byId = new Map<number, RpcResult<T>>();
		for (const entry of parsed as RpcResult<T>[] & { id?: number }[]) {
			const id = (entry as { id?: unknown }).id;
			if (typeof id === "number") byId.set(id, entry);
		}
		const out: T[] = [];
		for (let i = 0; i < calls.length; i++) {
			const entry = byId.get(ids[i]!);
			if (entry === undefined) {
				throw new ChainError(
					`a batch of ${calls.length} came back missing the answer to ` +
						`${calls[i]!.method} (id ${ids[i]}). Refusing to treat a missing ` +
						"answer as a zero.",
					true,
				);
			}
			if (entry.error !== undefined && entry.error !== null) {
				throw new ChainError(
					`${calls[i]!.method} failed inside a batch: ` +
						(entry.error.message ?? JSON.stringify(entry.error)),
					false,
					typeof entry.error.code === "number" ? entry.error.code : undefined,
				);
			}
			if (entry.result === undefined) {
				throw new ChainError(`${calls[i]!.method} returned no result inside a batch`);
			}
			out.push(entry.result);
		}
		return out;
	}

	get canSend(): boolean {
		return this.cfg.allowSend === true;
	}

	get passphrase(): string | undefined {
		return this.cfg.passphrase;
	}
}

/* ------------------------------------------------------- bitcoind and forks */

/**
 * The bitcoind-family adapter. Raptoreum, Pepecoin, Neoxa, Meowcoin,
 * Dingocoin, Radiant, Perbug, Dogecoin — every Bitcoin descendant that kept
 * the wallet RPC.
 *
 * THE DECIMALS TRAP. `getbalance` returns COINS, not satoshis, as a JSON
 * number — so 21000000.12345678 has already lost its last digits before this
 * code sees it. The fix is `getbalances`-style string handling where the daemon
 * offers it, and otherwise re-reading the number as a string from the raw body.
 * Here that is done by asking for the balance in the way that keeps digits:
 * the raw text is parsed, and a number that cannot be represented exactly is
 * refused rather than accepted.
 */
export class BitcoinRpcAdapter implements ChainAdapter {
	readonly route = "bitcoin-rpc";

	constructor(
		readonly symbol: string,
		private readonly rpc: JsonRpc,
		private readonly decimals: number,
		/**
		 * The addresses whose coins are this venue's, when custody is scoped to
		 * an explicit list rather than to "whatever is in the node's wallet".
		 *
		 * WHY THIS EXISTS. A bitcoin-family balance normally comes from the
		 * wallet, which means custody is defined as "everything this daemon can
		 * see". That is wrong for any node that does more than one job: these
		 * same daemons are the parents of merge-mining pools, and pool income in
		 * the wallet would be indistinguishable from customer deposits — a
		 * custody shortfall could sit hidden behind mining earnings.
		 *
		 * Declaring the addresses makes custody a stated fact that can be
		 * audited against the chain, the way BLOCK already works. Empty means
		 * the old wallet-wide behaviour, unchanged.
		 */
		private readonly custodyAddresses: readonly string[] = [],
	) {
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
			throw new ChainError(`${symbol}: implausible decimals ${decimals}`);
		}
		const seen = new Set<string>();
		for (const a of custodyAddresses) {
			if (a.trim() === "") throw new ChainError(`${symbol}: blank custody address`);
			if (seen.has(a)) {
				// A duplicate would be counted once by the node and twice by a
				// naive sum; refuse it rather than rely on which happens.
				throw new ChainError(`${symbol}: duplicate custody address ${a}`);
			}
			seen.add(a);
		}
	}

	/** Custody is scoped to a declared address list rather than to the wallet. */
	private get scoped(): boolean {
		return this.custodyAddresses.length > 0;
	}

	/**
	 * Can this node spend the custody addresses?
	 *
	 * The scoped model only means anything if the answer is no, so it is ASKED
	 * rather than assumed — `dumpprivkey` on a watch-only address fails because
	 * the key is not there.
	 *
	 * A locked wallet also makes it fail, for an entirely different reason, and
	 * that case is reported as INDETERMINATE rather than quietly counted as
	 * proof. A wallet that is merely locked still holds the keys.
	 */
	private async spendability(): Promise<"keyless" | "holds-keys" | "indeterminate"> {
		const addr = this.custodyAddresses[0];
		if (addr === undefined) return "indeterminate";
		try {
			const k = await this.rpc.call<unknown>("dumpprivkey", [addr]);
			if (typeof k === "string" && k.trim() !== "") return "holds-keys";
			return "indeterminate";
		} catch (e) {
			/*
			 * DECIDE ON THE CODE, verified against the actual daemons.
			 *
			 * pepecoind and dingocoind answer a watch-only address with
			 * {"code":-4,"message":"Private key for address X is not known"}.
			 * -4 is RPC_WALLET_ERROR and -13 is RPC_WALLET_UNLOCK_NEEDED; a
			 * locked wallet still HOLDS its keys, so it is not evidence of
			 * anything and must not be read as such.
			 *
			 * The message check stays as a fallback for a fork that returns a
			 * code we do not recognise, but it is no longer what the safety
			 * property rests on.
			 */
			const code = e instanceof ChainError ? e.rpcCode : undefined;
			if (code === -13) return "indeterminate"; // locked, not keyless
			if (code === -32601) return "keyless"; // no wallet RPC at all
			if (code === -4) return "keyless";
			const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
			if (msg.includes("passphrase") || msg.includes("locked")) return "indeterminate";
			if (msg.includes("not known") || msg.includes("no private key")) return "keyless";
			if (msg.includes("method not found") || msg.includes("disabled")) return "keyless";
			return "indeterminate";
		}
	}

	async probe(): Promise<ChainCapabilities> {
		const notes: string[] = [];
		let height: number | undefined;
		let synced = false;
		try {
			const info = await this.rpc.call<{
				blocks?: number;
				headers?: number;
				initialblockdownload?: boolean;
				verificationprogress?: number;
			}>("getblockchaininfo");
			height = info.blocks;
			/*
			 * SYNCED MEANS THE NODE SAYS SO, in its own terms. Comparing blocks
			 * to headers is the reliable signal across forks; verification
			 * progress is a float that sits at 0.9999 for a long time.
			 */
			const blocks = info.blocks ?? 0;
			const headers = info.headers ?? 0;
			synced = info.initialblockdownload !== true && headers > 0 && blocks >= headers - 1;
			if (!synced) {
				notes.push(`at block ${blocks} of ${headers} headers`);
			}
		} catch (e) {
			return {
				reachable: false,
				synced: false,
				height: undefined,
				decimals: undefined,
				canDeriveAddresses: false,
				canSend: false,
				notes: [e instanceof Error ? e.message : String(e)],
			};
		}

		/*
		 * SCOPED CUSTODY: say so, and prove the part that makes it safe.
		 *
		 * The whole point of declaring addresses is that this node cannot spend
		 * them. If it turns out it can, the scoping is decoration — the node is
		 * a hot wallet wearing a read-only label — and that is reported as
		 * unreachable rather than as a working chain, because every number
		 * downstream would be describing a different custody model than the one
		 * the operator thinks is in force.
		 */
		let canDeriveAddresses = false;
		if (this.scoped) {
			notes.push(
				`custody is scoped to ${this.custodyAddresses.length} declared ` +
					"address(es); the node's wallet total is not used",
			);
			const spend = await this.spendability();
			if (spend === "holds-keys") {
				return {
					reachable: false,
					synced: false,
					height,
					decimals: undefined,
					canDeriveAddresses: false,
					canSend: false,
					notes: [
						...notes,
						"REFUSED: this node holds the private key for a declared custody " +
							"address, so it is not the read-only observer the scoped model " +
							"assumes. Either move the keys off it or stop calling it custody.",
					],
				};
			}
			if (spend === "indeterminate") {
				notes.push(
					"could not confirm the node is keyless for the custody addresses " +
						"(a locked wallet fails the same way a keyless one does), so " +
						"read-only status is UNVERIFIED rather than established",
				);
			}
			// Deposit addresses are derived elsewhere and imported here, the same
			// shape BLOCK uses. Asking getnewaddress would be worse than useless:
			// on a watch-only wallet it would mint a key this node then holds.
			notes.push(
				"deposit addresses are imported, not derived here — `watchAddress` " +
					"tracks an externally derived address without a key",
			);
		} else {
			// CAN IT ISSUE AN ADDRESS? Asked, not assumed: a descriptor wallet with
			// no keys answers this with an error, and finding that out at deposit
			// time means a customer waiting on an address that will never come.
			try {
				await this.rpc.call<string>("getnewaddress", ["blockle-probe"]);
				canDeriveAddresses = true;
			} catch (e) {
				notes.push(
					"getnewaddress failed, so per-customer deposit addresses are not " +
						`available: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}

		let canSend = false;
		if (!this.rpc.canSend) {
			notes.push("this adapter was built read-only; sending is disabled here");
		} else {
			try {
				// Ask what a send WOULD cost rather than sending. Any answer at all
				// means the wallet is unlocked and spendable.
				await this.rpc.call<unknown>("getwalletinfo");
				canSend = true;
			} catch (e) {
				notes.push(`getwalletinfo failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		return {
			reachable: true,
			synced,
			height,
			// Not reported by this family. The registry's value stands, and
			// canGoLive treats an unconfirmed registry value as a blocker.
			decimals: undefined,
			canDeriveAddresses,
			canSend,
			notes,
		};
	}

	async balance(): Promise<bigint> {
		if (this.scoped) return this.scopedBalance();
		/*
		 * `getbalances` where available, because it reports under `mine.trusted`
		 * and distinguishes confirmed from pending — crediting unconfirmed
		 * change as custody would overstate what is actually spendable.
		 */
		let trusted: unknown;
		try {
			const b = await this.rpc.call<{ mine?: { trusted?: unknown } }>("getbalances");
			trusted = b.mine?.trusted;
		} catch {
			// Older forks do not have it. Fall through to getbalance, which they
			// all do — this is a capability difference, not an error.
		}
		/*
		 * THE CONVERSION IS OUTSIDE THE CATCH, DELIBERATELY.
		 *
		 * It used to be inside, and that was a bug: `toBase` refuses a balance a
		 * JSON number cannot hold, and the catch swallowed that refusal and fell
		 * through to `getbalance` — so a figure this adapter had just declared
		 * untrustworthy got replaced by another attempt instead of stopping. The
		 * catch exists for ONE thing, a daemon that lacks the method.
		 */
		if (trusted !== undefined) return this.toBase(trusted);
		const v = await this.rpc.call<unknown>("getbalance", ["*", 1]);
		return this.toBase(v);
	}

	/**
	 * The confirmed value of the declared custody addresses, from the chain.
	 *
	 * `listunspent` filtered to those addresses, rather than any wallet total:
	 * the pool's coinbase address is simply never declared, so its earnings are
	 * invisible here no matter what else the node is doing.
	 *
	 * Not `scantxoutset`, which would have been the obvious choice and is the
	 * one this was first designed around — it is absent from Pepecoin and
	 * Dingocoin, the two oldest forks on the list and the two that matter most.
	 * `listunspent` over imported watch-only addresses works on every fork here
	 * and is incremental rather than a full UTXO scan per call.
	 *
	 * minconf 1: unconfirmed coins are not custody. Counting them would
	 * overstate holdings and, worse, a reorg would turn the overstatement into
	 * a shortfall.
	 */
	private async scopedBalance(): Promise<bigint> {
		const rows = await this.rpc.call<Array<{ amount?: unknown; address?: string }>>(
			"listunspent",
			[1, 9_999_999, this.custodyAddresses],
		);
		if (!Array.isArray(rows)) {
			throw new ChainError(`${this.symbol}: listunspent did not return a list`);
		}
		const declared = new Set(this.custodyAddresses);
		let total = 0n;
		for (const r of rows) {
			/*
			 * TRUST THE FILTER, THEN CHECK IT. Older forks have been known to
			 * ignore the address argument; if that happened, a wallet-wide total
			 * would be returned under the name of a scoped one, which is exactly
			 * the confusion this method exists to prevent.
			 */
			if (typeof r.address !== "string" || !declared.has(r.address)) {
				throw new ChainError(
					`${this.symbol}: listunspent returned an output at ${String(r.address)}, ` +
						"which is not a declared custody address — the node ignored the " +
						"address filter, so this balance is not scoped and is refused",
				);
			}
			// Each UTXO converts exactly or `toBase` refuses it; the sum is BigInt.
			total += this.toBase(r.amount);
		}
		return total;
	}

	/**
	 * Track an address without being able to spend it.
	 *
	 * `rescan` is the caller's decision and an expensive one: false is right for
	 * a freshly derived deposit address that cannot have history, and true is
	 * required for an address that already holds coins — a daemon will happily
	 * import without rescanning and then report a zero balance for funds that
	 * are plainly on the chain.
	 */
	async watchAddress(address: string, rescan: boolean): Promise<void> {
		if (address.trim() === "") throw new ChainError(`${this.symbol}: blank address`);
		await this.rpc.call<unknown>("importaddress", [address, "blockle-custody", rescan]);
	}

	async newAddress(label: string): Promise<string> {
		const a = await this.rpc.call<string>("getnewaddress", [label.slice(0, 64)]);
		if (typeof a !== "string" || a.trim() === "") {
			throw new ChainError(`${this.symbol}: getnewaddress returned nothing usable`);
		}
		return a.trim();
	}

	async incoming(): Promise<readonly IncomingPayment[]> {
		const rows = await this.rpc.call<
			Array<{
				category?: string;
				address?: string;
				amount?: unknown;
				txid?: string;
				confirmations?: number;
			}>
		>("listtransactions", ["*", 200, 0, true]);
		const out: IncomingPayment[] = [];
		for (const r of rows) {
			if (r.category !== "receive") continue;
			if (typeof r.txid !== "string" || typeof r.address !== "string") continue;
			let amount: bigint;
			try {
				amount = this.toBase(r.amount);
			} catch {
				// A ROW WE CANNOT READ IS SKIPPED, NOT GUESSED. It will be picked
				// up on the next pass once whatever is odd about it is fixed;
				// crediting a wrong amount cannot be taken back.
				continue;
			}
			if (amount <= 0n) continue;
			out.push({
				txid: r.txid,
				address: r.address,
				amount,
				confirmations: typeof r.confirmations === "number" ? r.confirmations : 0,
			});
		}
		return out;
	}

	async send(args: {
		to: string;
		amount: bigint;
		idempotencyKey: string;
	}): Promise<{ txid: string }> {
		if (!this.rpc.canSend) {
			throw new ChainError(
				`${this.symbol}: this adapter is read-only. Sending requires an ` +
					"adapter constructed with allowSend, which is deliberately not " +
					"the default.",
			);
		}
		if (args.amount <= 0n) throw new ChainError("refusing to send a non-positive amount");
		if (args.to.trim() === "") throw new ChainError("refusing to send to an empty address");

		if (this.rpc.passphrase !== undefined && this.rpc.passphrase !== "") {
			// Unlock for the shortest window that can work. 20 seconds is long
			// enough for one send and short enough that a crash mid-sequence
			// leaves the wallet locked again.
			await this.rpc.call<unknown>("walletpassphrase", [this.rpc.passphrase, 20]);
		}
		/*
		 * THE COMMENT FIELD CARRIES THE IDEMPOTENCY KEY, AND THAT IS NOT A
		 * GUARANTEE.
		 *
		 * bitcoind has no sequence-id equivalent: there is nothing to make it
		 * refuse a duplicate. So the protection has to live on our side — the
		 * payout runner looks for an existing transaction with this key before
		 * sending, which is why the key goes in the comment where it can be
		 * found again. `probe().notes` says this out loud for the family.
		 */
		const txid = await this.rpc.call<string>("sendtoaddress", [
			args.to.trim(),
			baseToDecimal(args.amount, this.decimals),
			args.idempotencyKey,
		]);
		if (typeof txid !== "string" || txid.trim() === "") {
			throw new ChainError(
				`${this.symbol}: the daemon accepted the send but returned no txid. ` +
					"NOT treating this as sent — look for the transaction by its " +
					`comment (${args.idempotencyKey}) before retrying.`,
			);
		}
		return { txid: txid.trim() };
	}

	/**
	 * One transaction's current state.
	 *
	 * NEGATIVE CONFIRMATIONS ARE MEANINGFUL and are passed through rather than
	 * clamped: bitcoind reports a conflicted transaction that way — replaced or
	 * reorged out and not coming back — and that is the only signal that
	 * justifies reversing a customer's debit. Clamping it to zero would make a
	 * dead payout look like a pending one forever.
	 */
	async transaction(txid: string): Promise<{
		txid: string;
		confirmations: number;
		feeBaseUnits: bigint;
		comment: string | undefined;
	}> {
		const t = await this.rpc.call<{
			txid?: string;
			confirmations?: number;
			fee?: unknown;
			comment?: string;
		}>("gettransaction", [txid]);
		let fee = 0n;
		if (t.fee !== undefined) {
			try {
				// Reported NEGATIVE for a send — it left the wallet. The magnitude
				// is the cost; the sign is bookkeeping we do our own way.
				const signed = this.toBase(t.fee);
				fee = signed < 0n ? -signed : signed;
			} catch {
				// An unreadable fee is reported as zero, which under-books our own
				// cost rather than inventing a debit against a float. Same choice
				// as the BitGo client makes, for the same reason.
				fee = 0n;
			}
		}
		return {
			txid: (t.txid ?? txid).trim(),
			confirmations: typeof t.confirmations === "number" ? t.confirmations : 0,
			feeBaseUnits: fee,
			comment: t.comment,
		};
	}

	/** Can this adapter move money? False unless it was built with allowSend. */
	get canSend(): boolean {
		return this.rpc.canSend;
	}

	/** Find a previous send by its idempotency key, so a retry cannot double-pay. */
	async findSend(idempotencyKey: string): Promise<{ txid: string } | undefined> {
		const rows = await this.rpc.call<
			Array<{ category?: string; comment?: string; label?: string; txid?: string }>
		>("listtransactions", ["*", 500, 0, true]);
		const hit = rows.find(
			(r) =>
				r.category === "send" &&
				(r.comment === idempotencyKey || r.label === idempotencyKey),
		);
		return hit?.txid === undefined ? undefined : { txid: hit.txid };
	}

	private toBase(v: unknown): bigint {
		if (typeof v === "string") return decimalToBase(v, this.decimals);
		if (typeof v === "number") {
			/*
			 * A JSON NUMBER TOO LARGE TO CARRY EVERY BASE UNIT IS REFUSED.
			 *
			 * THE CHECK IS MAGNITUDE, NOT A ROUND TRIP. The first version of
			 * this compared `Number(v.toFixed(decimals))` back to `v` and called
			 * a mismatch the error — which never fires, because toFixed prints
			 * the double's own value and parsing that returns the same double.
			 * By the time this code runs the digits are already gone; there is
			 * nothing left to detect by comparison.
			 *
			 * What IS detectable is whether the amount is in the range where a
			 * double can still hold every base unit. A double carries integers
			 * exactly up to 2^53-1, so at `decimals` places the largest safe
			 * amount is (2^53-1)/10^decimals — about 90,071,992 coins at eight
			 * decimals. Past that, consecutive satoshis are not distinguishable
			 * and the figure is an approximation.
			 *
			 * This matters for real coins: a Dogecoin-family wallet can easily
			 * hold more than 90 million, so this is not a theoretical bound. The
			 * fix is a daemon that reports amounts as strings (`getbalances`
			 * does), which is why the message says so.
			 */
			if (!Number.isFinite(v)) throw new ChainError(`non-finite amount ${v}`);
			const maxExact = Number.MAX_SAFE_INTEGER / 10 ** this.decimals;
			if (Math.abs(v) > maxExact) {
				throw new ChainError(
					`${this.symbol}: the daemon reported ${v} as a JSON number. Above ` +
						`${maxExact} a double cannot hold every unit at ${this.decimals} ` +
						"decimals, so that figure is already an approximation. Refusing " +
						"to use an approximate custody balance — configure the daemon " +
						"or RPC path that returns amounts as strings.",
				);
			}
			return decimalToBase(v.toFixed(this.decimals), this.decimals);
		}
		throw new ChainError(`${this.symbol}: unusable amount ${JSON.stringify(v)}`);
	}
}

/* ----------------------------------------------------------------- EVM nodes */

/**
 * WHAT AN EVM DEPOSIT ADDRESS SOURCE LOOKS LIKE TO THIS ADAPTER.
 *
 * A structural type rather than an import of EvmAddressIndex, for the same
 * reason blockchain.ts declares `AddressPool` structurally: the adapter stays
 * testable without a database, and it cannot reach anything else on the real
 * object. Note what is NOT on this interface — nothing that signs, nothing that
 * derives a private key, nothing that takes a seed. The thing behind it holds an
 * extended PUBLIC key and is mathematically incapable of producing a signature.
 */
export interface EvmDepositAddresses {
	/**
	 * RETURNS THE INDEX AS WELL AS THE ADDRESS, unlike `AddressPool.take`.
	 *
	 * `AddressPool.take()` drops the index, which is survivable for BLOCK
	 * because the operator sweeps the whole wallet in one go. It is not
	 * survivable here: an EVM sweep is per address, and without the index the
	 * offline signer cannot re-derive the key for the specific address holding
	 * a customer's coins.
	 */
	take(userId: string): { address: string; index: number };
	allAddresses(): readonly string[];
	status(): { issued: number; nextIndex: number; fingerprint: string };
}

/** What a deposit scan looks like to this adapter. See evmscan.ts. */
export interface EvmIncomingSource {
	readonly chain: string;
	haltedReason(): string | undefined;
	/**
	 * Why new deposit addresses are not being issued, if they are not.
	 *
	 * SEPARATE FROM `haltedReason` BECAUSE THE TWO MEAN OPPOSITE THINGS ABOUT
	 * THE CHAIN. A halt means the endpoint has been caught under-reporting, so
	 * nothing may be credited and a human has to look. This means the chain reads
	 * fine and the venue has more value parked at customer addresses than it has
	 * declared it will leave waiting for an operator with an offline signer — so
	 * it stops accepting NEW deposits while crediting the ones already on their
	 * way. One flag for both would make a routine backlog look like a lying node.
	 */
	issuanceShutReason(): string | undefined;
	preflight(): Promise<readonly string[]>;
	scan(): Promise<{
		readonly payments: readonly IncomingPayment[];
		readonly pending: readonly IncomingPayment[];
		readonly cursor: number;
		readonly lagAlarm: string | undefined;
		readonly issuanceShut: string | undefined;
	}>;
}

/**
 * The EVM adapter. Any Ethereum-compatible JSON-RPC: OctaSpace, Rethereum,
 * Ethereum Classic, HyperEVM, Ethereum, BSC, Polygon.
 *
 * WHAT IT CANNOT DO, STATED FIRST, BECAUSE THAT IS STILL THE IMPORTANT HALF:
 * an EVM node holds no keys, so THIS ADAPTER CANNOT SEND. Not configurably,
 * not with a flag. A withdrawal needs a signer, the signer for these rails
 * lives on a host with no inbound network, and nothing on this box can reach
 * it. `canSend` is a constant false and `send()` is a permanent rejection.
 *
 * WHAT CHANGED, AND THE EXACT PREMISE THAT CHANGED.
 *
 * This file used to say an EVM node "holds no keys, so deposits-per-customer
 * need a signer that lives elsewhere", and treated address issuance and sending
 * as the same impossibility. They are not the same, and the difference is a
 * property of the curve.
 *
 * secp256k1 HAS WATCH-ONLY DERIVATION. A BIP32 non-hardened child public key is
 * `parentPub + IL*G` — arithmetic on public values. So with an account-level
 * xpub this process can derive `m/44'/60'/0'/0/i` for every customer and hold
 * ZERO spending authority for any of them. That is not true of BLOCK, whose
 * ML-DSA signatures have no watch-only derivation, which is exactly why
 * blockaddresspool.ts has to ship addresses in from an offline machine. For EVM
 * the same security posture is achievable WITHOUT the operator ceremony, and
 * that is the whole reason this rail is built this way.
 *
 * So the capabilities are now split where the maths splits them:
 *   canDeriveAddresses — true when an xpub-backed address source is configured.
 *   canSend            — false, permanently, on this host.
 *
 * AND IF NO XPUB IS CONFIGURED, NOTHING CHANGES. `newAddress` refuses with the
 * same sentence it always did and `canDeriveAddresses` is false, so an operator
 * who sets a URL and forgets the xpub gets a correctly SHUT rail rather than a
 * rail that looks open and quietly answers "no deposits".
 */
export class EvmRpcAdapter implements ChainAdapter {
	readonly route = "evm-rpc";

	constructor(
		readonly symbol: string,
		private readonly rpc: JsonRpc,
		private readonly cfg: {
			readonly decimals: number;
			/**
			 * The venue's DECLARED addresses — hot, gas, treasury.
			 *
			 * Separate from the issued customer addresses, which arrive through
			 * `addresses` on the address source. Both are custody and `balance()`
			 * unions them; they are configured separately because one is a
			 * deliberate operator declaration and the other grows by itself.
			 */
			readonly addresses: readonly string[];
			/** Token contract, for an ERC-20 rather than the native coin. */
			readonly token?: string;
			/**
			 * The xpub-backed per-customer deposit address source.
			 *
			 * Absent means `newAddress` refuses and the rail is shut. Present
			 * means this adapter can issue addresses and MUST count them in
			 * `balance()` — those two obligations arrive together, and splitting
			 * them is how a venue issues deposit addresses whose balances its own
			 * reconciler cannot see, which presents as a shortfall and halts the
			 * asset.
			 */
			readonly depositAddresses?: EvmDepositAddresses;
			/**
			 * The durable block scanner. Absent means `incoming()` keeps throwing.
			 *
			 * Deliberately NOT defaulted to something that returns an empty list:
			 * see `incoming()`.
			 */
			readonly incomingSource?: EvmIncomingSource;
			/**
			 * EIP-155 chain id, asserted by `probe()` against `eth_chainId`.
			 *
			 * Worth a whole round trip because a scanner pointed at the wrong
			 * chain has NO symptom: it reads valid blocks, valid balances and
			 * valid transactions that simply never contain our addresses, and
			 * reports no deposits forever. A Polygon rail on an Ethereum URL is
			 * one character of config away at all times.
			 */
			readonly chainId?: number;
		},
	) {
		for (const a of cfg.addresses) {
			if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
				throw new ChainError(`${symbol}: not an address: ${a}`);
			}
		}
		if (cfg.token !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(cfg.token)) {
			throw new ChainError(`${symbol}: not a contract address: ${cfg.token}`);
		}
		if (cfg.token !== undefined && cfg.depositAddresses !== undefined) {
			/*
			 * ERC-20 ON AN xpub RAIL IS NOT HALF-SHIPPED HERE.
			 *
			 * Issuing per-customer addresses for a TOKEN would be the same
			 * derivation, but detecting a token deposit is a different problem:
			 * Transfer-event scanning, with log-index idempotency and a usable
			 * log backfill window. Measured, the free endpoints do not have one —
			 * Ethereum prunes logs at about 32 hours (failing loudly) and BSC at
			 * about 59 hours (failing SILENTLY, HTTP 200 with an empty array).
			 * Worse, the deposit watcher resolves a node feed by SETTLEMENT asset
			 * inside a loop over all four of USDT's custody ids, so one token
			 * adapter would be polled four times and the custody posting would
			 * land under whichever network ran first.
			 *
			 * Rather than let a future caller configure that combination and
			 * discover it in production, it is refused at construction with the
			 * reason attached.
			 */
			throw new ChainError(
				`${symbol}: per-customer deposit addresses are wired for the NATIVE coin ` +
					"only. An ERC-20 rail additionally needs Transfer-event scanning with " +
					"log-index idempotency and a log backfill window no endpoint available " +
					"to this venue serves, plus a deposit watcher keyed by custody id " +
					"rather than by settlement asset. Refusing to half-ship it.",
			);
		}
	}

	async probe(): Promise<ChainCapabilities> {
		/*
		 * THE FIRST NOTE USED TO BE ONE SENTENCE AND HALF OF IT IS NOW WRONG.
		 *
		 * It read: "an EVM node holds no keys: this route reads balances only.
		 * Deposit addresses and withdrawals need a signer, which is not wired
		 * here." The first clause is still true and always will be. The second
		 * clause conflated two different things, and once an xpub is loaded it
		 * is a lie about half of them — an xpub issues addresses and signs
		 * nothing. `probe().notes` is what an operator actually reads when they
		 * are deciding whether a rail is safe, so it says the two things
		 * separately now.
		 */
		const notes: string[] = [];
		if (this.cfg.depositAddresses === undefined) {
			notes.push(
				"no deposit-address source is configured, so this route reads balances " +
					"only. Per-customer addresses need an account xpub (EVM_ACCOUNT_XPUB), " +
					"which confers no spending authority and is therefore safe to hold here.",
			);
		} else {
			const st = this.cfg.depositAddresses.status();
			/*
			 * THIS LINE IS EMITTED BY THE ADAPTER THAT WILL ACTUALLY USE THE
			 * SOURCE, AND THAT IS THE POINT, NOT A DETAIL.
			 *
			 * The BLOCK pool bug was maddening precisely because the API logged
			 * "block pool: 999 free of 1000" at startup from its OWN reference
			 * while the deposit route refused every request — the pool had never
			 * been forwarded to the adapter. The log proved nothing because it
			 * described a different object. So the only place allowed to claim an
			 * address source is loaded is the object that would issue from it,
			 * and the fingerprint is included so an operator can confirm it is
			 * the xpub they deployed rather than merely "an" xpub.
			 */
			notes.push(
				`per-customer deposit addresses are derived here from xpub ` +
					`${st.fingerprint} (${st.issued} issued, next index ${st.nextIndex}). ` +
					"The xpub cannot sign: this host holds no private key for any of them.",
			);
		}
		notes.push(
			"this route CANNOT send. An EVM node signs nothing, and the signer for " +
				"this rail is on a host with no inbound network — holding an xpub " +
				"changes nothing about that.",
		);
		let height: number | undefined;
		try {
			const hex = await this.rpc.call<string>("eth_blockNumber");
			height = Number(BigInt(hex));
		} catch (e) {
			return {
				reachable: false,
				synced: false,
				height: undefined,
				decimals: this.cfg.decimals,
				canDeriveAddresses: false,
				canSend: false,
				notes: [e instanceof Error ? e.message : String(e)],
			};
		}

		/*
		 * IS THIS EVEN THE RIGHT CHAIN? Asked before anything else is believed.
		 *
		 * Reported as UNREACHABLE on a mismatch rather than as a note, because
		 * every number this adapter would go on to return describes a different
		 * chain than the operator thinks is configured — the same reasoning the
		 * bitcoind adapter uses when it finds the node holds a custody key.
		 */
		if (this.cfg.chainId !== undefined) {
			try {
				const idHex = await this.rpc.call<string>("eth_chainId");
				const id = Number(BigInt(idHex));
				if (id !== this.cfg.chainId) {
					return {
						reachable: false,
						synced: false,
						height,
						decimals: this.cfg.decimals,
						canDeriveAddresses: false,
						canSend: false,
						notes: [
							...notes,
							`REFUSED: the endpoint reports chain id ${id} but this rail is ` +
								`configured for ${this.cfg.chainId}. The URL points at the ` +
								"wrong chain, and a scanner on the wrong chain has no symptom: " +
								"it reads valid blocks that never contain our addresses and " +
								"reports no deposits forever.",
						],
					};
				}
			} catch (e) {
				notes.push(
					`eth_chainId is unavailable, so the chain cannot be confirmed: ${
						e instanceof Error ? e.message : String(e)
					}`,
				);
			}
		}
		/*
		 * `eth_syncing` is false on a synced node and an object while catching
		 * up. A provider that does not implement it leaves this unknown, which
		 * is reported as not-synced — the conservative direction, because the
		 * consequence of believing a lagging node is crediting a deposit that
		 * later disappears in a reorg.
		 */
		let synced = false;
		try {
			const s = await this.rpc.call<unknown>("eth_syncing");
			synced = s === false;
			if (!synced) notes.push("eth_syncing reports the node is still catching up");
		} catch {
			notes.push("eth_syncing is unavailable, so sync state is unknown");
		}

		if (this.cfg.token !== undefined) {
			// Confirm the contract's own decimals rather than trusting config.
			// An 18-vs-6 mismatch on a token is a factor of a trillion.
			try {
				const d = await this.erc20Decimals();
				if (d !== this.cfg.decimals) {
					notes.push(
						`the contract reports ${d} decimals but this adapter is ` +
							`configured for ${this.cfg.decimals}`,
					);
				}
			} catch (e) {
				notes.push(`could not read the contract's decimals: ${String(e)}`);
			}
		}

		if (this.cfg.incomingSource !== undefined) {
			const halted = this.cfg.incomingSource.haltedReason();
			if (halted !== undefined) {
				notes.push(`THE DEPOSIT SCAN IS HALTED: ${halted}`);
			}
			/*
			 * REPORTED SEPARATELY FROM THE HALT, because an operator reading
			 * probe notes needs to tell "the endpoint lied to us" from "we have
			 * a sweep backlog". Both shut something; only one of them means the
			 * chain cannot be trusted, and treating a backlog as an integrity
			 * failure is how a real integrity failure gets waved through.
			 */
			const gated = this.cfg.incomingSource.issuanceShutReason();
			if (gated !== undefined) {
				notes.push(`NEW DEPOSIT ADDRESSES ARE NOT BEING ISSUED: ${gated}`);
			}
		} else {
			notes.push(
				"no deposit scanner is configured, so `incoming` refuses rather than " +
					"reporting an empty list. A rail can issue addresses and still not be " +
					"watching them, and that combination must not look like 'no deposits'.",
			);
		}

		return {
			reachable: true,
			synced,
			height,
			decimals: this.cfg.decimals,
			/*
			 * DRIVEN BY CONFIGURATION, NEVER HARDCODED TRUE.
			 *
			 * This was a constant `false`, with the reason "an EVM node holds no
			 * keys". The premise was wrong in one direction only: issuing an
			 * address needs no key on secp256k1. So it now reports whether an
			 * xpub-backed source is actually wired, which means an operator who
			 * configures a URL and forgets the xpub gets a shut rail rather than
			 * a rail that looks open. `canGoLive` reads this, so a rail cannot be
			 * promoted by a comment.
			 */
			canDeriveAddresses: this.cfg.depositAddresses !== undefined,
			/*
			 * STAYS FALSE. There is no configuration that can change it, and
			 * test/evmrailguards.test.ts asserts that structurally. An xpub
			 * confers zero spending authority, so holding one changes nothing
			 * about withdrawal; a rail with deposits open and no return path is
			 * the worst state available, which is what RAIL_BLOCKERS is for.
			 */
			canSend: false,
			notes,
		};
	}

	/**
	 * Every address whose balance is this venue's holding, at ONE pinned block.
	 *
	 * THREE THINGS CHANGED HERE AND ALL THREE ARE LOAD-BEARING.
	 *
	 * 1. THE ISSUED CUSTOMER ADDRESSES ARE INCLUDED. Coins sitting at a
	 *    customer's deposit address before a sweep ARE custody — the venue has
	 *    already credited that customer, so it owes the balance. Counting only
	 *    the declared treasury would show the liability without the asset, which
	 *    is a SHORTFALL, which has no tolerance at any size and halts the asset.
	 *    blockchain.ts:224-227 does the same union for BLOCK, for this reason.
	 *
	 * 2. THE READS ARE BATCHED. They were serial — one HTTP round trip per
	 *    address — which with one address per customer is one round trip per
	 *    customer per reconcile pass.
	 *
	 * 3. EVERY READ IS PINNED TO ONE EXPLICIT BLOCK NUMBER, never "latest". A
	 *    sum taken across moving blocks can count a sweep in flight at both ends
	 *    or at neither: the money leaves address A at block N and arrives at the
	 *    hot address at block N+1, so a read of A at N+1 and the hot address at
	 *    N misses it entirely and reports a shortfall that does not exist. One
	 *    block, one snapshot, one number.
	 *
	 * AND AN INCOMPLETE PASS THROWS RATHER THAN RETURNING A PARTIAL SUM. The
	 * reconciler already has an UNAVAILABLE path that alerts without halting;
	 * that is the correct destination for "we could not read it". A partial sum
	 * is indistinguishable from a real shortfall, and a real shortfall halts
	 * withdrawals for every customer holding that asset.
	 */
	async balance(): Promise<bigint> {
		const addresses = this.custodyAddresses();
		if (addresses.length === 0) {
			throw new ChainError(
				`${this.symbol}: no holding addresses are configured, so there is no ` +
					"balance to report. Refusing to return zero, which would read as " +
					"an empty treasury.",
			);
		}

		// Pin the block FIRST, so every balance below describes the same instant.
		const at = await this.rpc.call<string>("eth_blockNumber");
		if (typeof at !== "string" || !/^0x[0-9a-fA-F]+$/.test(at)) {
			throw new ChainError(
				`${this.symbol}: eth_blockNumber returned ${JSON.stringify(at)}, so there ` +
					"is no block to pin the custody read to. Refusing to fall back to " +
					"'latest': a sum read across moving blocks can miss a sweep in flight " +
					"and report a shortfall that does not exist.",
			);
		}

		// Chunked at 100: measured working on every endpoint this rail would
		// use, and small enough that one oversized request cannot be the thing
		// that fails a reconcile pass.
		const CHUNK = 100;
		let total = 0n;
		for (let i = 0; i < addresses.length; i += CHUNK) {
			const slice = addresses.slice(i, i + CHUNK);
			const calls = slice.map((a) =>
				this.cfg.token === undefined
					? { method: "eth_getBalance", params: [a, at] }
					: {
							method: "eth_call",
							params: [
								{
									to: this.cfg.token,
									data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0"),
								},
								at,
							],
						},
			);
			const results = await this.rpc.batch<string>(calls);
			if (results.length !== slice.length) {
				throw new ChainError(
					`${this.symbol}: asked for ${slice.length} balances at block ` +
						`${at} and got ${results.length}. Refusing to report a partial ` +
						"custody total — a partial sum is indistinguishable from a real " +
						"shortfall, and a shortfall halts withdrawals for this asset.",
					true,
				);
			}
			for (const hex of results) total += this.hexToBig(hex);
		}
		return total;
	}

	/**
	 * The declared treasury plus every issued customer address, de-duplicated.
	 *
	 * De-duplicated because the two sources can legitimately overlap — an
	 * operator may declare the hot address that the signer derived from a
	 * reserved index — and a duplicate would be counted twice, inventing custody
	 * that does not exist.
	 */
	private custodyAddresses(): readonly string[] {
		const issued = this.cfg.depositAddresses?.allAddresses() ?? [];
		const seen = new Map<string, string>();
		for (const a of [...this.cfg.addresses, ...issued]) {
			seen.set(a.toLowerCase(), a);
		}
		return [...seen.values()];
	}

	/**
	 * A per-customer deposit address, derived from an xpub, holding no key.
	 *
	 * `label` is the account id, matching the BLOCK route: the source keys on
	 * it, so a customer returning to the deposit screen gets the address they
	 * already have rather than consuming another index. That is not a nicety —
	 * a second address orphans any deposit already in flight to the first one,
	 * which then arrives somewhere nobody is attributed to.
	 *
	 * THE REFUSAL BELOW IS THE ORIGINAL ONE, WORD FOR WORD, AND IT STILL
	 * APPLIES. Without an xpub this route genuinely cannot issue an address, and
	 * an operator who has configured a URL but no xpub needs to read the same
	 * sentence they would have read before this rail existed.
	 */
	async newAddress(label: string): Promise<string> {
		const source = this.cfg.depositAddresses;
		if (source === undefined) {
			throw new ChainError(
				`${this.symbol}: an EVM node cannot issue a deposit address — it holds ` +
					"no keys. Per-customer addresses need an account xpub " +
					"(EVM_ACCOUNT_XPUB), derived on the signer host and configured here; " +
					"the xpub itself cannot sign, so it is safe on this box.",
			);
		}
		const owner = label.trim();
		if (owner === "") {
			throw new ChainError(
				`${this.symbol}: a deposit address needs an owner. An address issued ` +
					"against a blank label could not be attributed to anyone, and on a " +
					"chain with no memo field that is unrecoverable.",
			);
		}
		return source.take(owner).address;
	}

	/**
	 * Everything that has arrived, from the durable scanner.
	 *
	 * THE THROW IS PRESERVED, AND FOR THE ORIGINAL REASON. Without a scanner
	 * this returns an error, never an empty array: an empty array makes the
	 * deposit watcher report "no deposits" for a chain nobody is watching, which
	 * is the one failure mode that looks exactly like everything being fine.
	 * That is still true of a rail that has an xpub and no scanner, so holding
	 * an xpub does not soften it.
	 *
	 * `sinceHeight` IS IGNORED, DELIBERATELY, AND THAT IS NOT A SHORTCUT. The
	 * interface offers it, but the watcher calls `incoming()` with no argument
	 * and the watcher process is one-shot per systemd tick, so any watermark
	 * this adapter accepted from a caller would be re-derived from nothing every
	 * cycle. The real cursor is durable, in the scanner's own table, and it
	 * NEVER advances past `tip - confirmations`. Accepting a caller's height
	 * here would let a bug elsewhere ask this rail to re-scan from the tip and
	 * skip every block in between.
	 *
	 * PENDING ARRIVALS ARE RETURNED TOO, with their true confirmation counts.
	 * The watcher's existing confirmation gate records them as `pending` and
	 * credits nothing, which is what makes "3 of 32 confirmations" visible in
	 * the first minute. Nothing above the safe head can be credited, because the
	 * number reported is the real one.
	 */
	async incoming(_sinceHeight?: number): Promise<readonly IncomingPayment[]> {
		const source = this.cfg.incomingSource;
		if (source === undefined) {
			throw new ChainError(
				`${this.symbol}: incoming-transfer scanning is not configured for this ` +
					"EVM rail. Refusing to return an empty list, which would look like " +
					"'no deposits' rather than 'not watching'.",
			);
		}
		const r = await source.scan();
		return [...r.payments, ...r.pending];
	}

	/**
	 * PERMANENTLY A REJECTION, AND THE XPUB DID NOT CHANGE THAT.
	 *
	 * This is the guard most likely to be "fixed" by someone who has just read
	 * that this adapter can now issue addresses, so the reasoning is written out
	 * rather than assumed:
	 *
	 *   An xpub derives public keys. It cannot produce a signature — not with
	 *   more compute, not with a flaw in our code, not ever. So there is nothing
	 *   on this host for this method to sign WITH, and the fix is not a flag,
	 *   it is a key, and putting a key here is the one thing the whole design
	 *   exists to avoid. An attacker who fully owns this box can read the
	 *   ledger, read every customer record, read the xpub and enumerate every
	 *   deposit address — and still cannot move one wei.
	 *
	 * Withdrawal on this rail is an offline-signer loop: APPROVED withdrawals
	 * accumulate into an unsigned proposal, a human carries it to a host with no
	 * inbound network, that host re-derives every source from its OWN seed and
	 * checks every destination against its own compiled allow-list, and a signed
	 * blob comes back to be broadcast. That is a different shape from this
	 * synchronous `send`, which is why it is NOT implemented as this method with
	 * a key added.
	 */
	send(_args: {
		to: string;
		amount: bigint;
		idempotencyKey: string;
	}): Promise<{ txid: string }> {
		return Promise.reject(
			new ChainError(
				`${this.symbol}: this route cannot send. An EVM node signs nothing, and ` +
					"an xpub cannot sign either — the signer for this rail is on a host " +
					"with no inbound network. A withdrawal here is an offline-signed " +
					"batch, not a call to this method.",
			),
		);
	}

	private async erc20Decimals(): Promise<number> {
		// decimals() — selector 0x313ce567.
		const hex = await this.rpc.call<string>("eth_call", [
			{ to: this.cfg.token, data: "0x313ce567" },
			"latest",
		]);
		return Number(this.hexToBig(hex));
	}

	private hexToBig(hex: unknown): bigint {
		if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) {
			throw new ChainError(`${this.symbol}: not a hex quantity: ${JSON.stringify(hex)}`);
		}
		// "0x" alone means an empty return — a call to a contract that is not
		// there. Not zero.
		if (hex === "0x") {
			throw new ChainError(
				`${this.symbol}: the call returned no data. Usually a wrong contract ` +
					"address; reporting it rather than reading it as a zero balance.",
			);
		}
		return BigInt(hex);
	}
}

/* ------------------------------------------------------------ Monero family */

/**
 * The Monero-family adapter: Zephyr, and any other monerod descendant.
 *
 * SUBADDRESSES ARE THE BEST DEPOSIT ATTRIBUTION HERE. `create_address` returns
 * a fresh subaddress on the same wallet, and incoming transfers report which
 * subaddress received — so a deposit is attributable exactly, with no memo for
 * a customer to forget.
 *
 * This talks to a WALLET process (`monero-wallet-rpc`), not the daemon. That
 * process holds spending keys, so it is the single most sensitive thing on the
 * box, and this adapter still refuses to send unless built with allowSend.
 */
export class MoneroRpcAdapter implements ChainAdapter {
	readonly route = "monero-rpc";

	constructor(
		readonly symbol: string,
		private readonly rpc: JsonRpc,
		private readonly decimals: number,
		/** Subaddress account index. 0 unless the operator split accounts. */
		private readonly accountIndex = 0,
		/**
		 * The DAEMON's RPC, separate from the wallet's.
		 *
		 * Optional only because the type cannot force an operator to configure
		 * it — but every money-touching method below refuses without it. See
		 * `requireSynced`: a wallet alone cannot distinguish "you hold nothing"
		 * from "I have scanned nothing", and on this family that distinction is
		 * the whole of custody safety.
		 */
		private readonly daemon?: JsonRpc,
	) {}

	/**
	 * How far behind the daemon the wallet may be and still be trusted.
	 *
	 * Not zero: the wallet polls the daemon on an interval, so the two legs are
	 * never read at the same instant and an exact match would make this flap on
	 * a healthy pair. One block of slack costs nothing — a deposit needs
	 * confirmations before it is credited anyway.
	 */
	private static readonly SCAN_LAG_TOLERANCE = 1;

	/**
	 * Refuse unless the DAEMON is at the chain tip and the WALLET has scanned
	 * up to it.
	 *
	 * This exists because of what a Monero-family wallet returns when it is
	 * blind: a clean, well-formed, confident ZERO. There is no error, no empty
	 * marker, nothing for a caller to notice. Three different lies follow from
	 * trusting it, and only this check stops them:
	 *
	 *   - `balance` reads as a custody shortfall, which halts withdrawals for
	 *     every customer on the venue.
	 *   - `incoming` reports no deposits, so real money that arrived is never
	 *     credited.
	 *   - `newAddress` hands out a deposit subaddress on a chain the wallet
	 *     cannot see. The key exists, so the funds are not destroyed, but
	 *     nobody observes them arriving and the customer sees a black hole.
	 *
	 * ZEPH is the live case: its daemon sat at height 1 with zero peers for
	 * days because every one of the project's mainnet p2p seeds refuses
	 * connections (only its TESTNET seeds answer). Unreachable is not an error
	 * state this venue gets to paper over, so it is named and refused.
	 */
	private async requireSynced(what: string): Promise<void> {
		if (this.daemon === undefined) {
			throw new ChainError(
				`${this.symbol}: ${what} refused — no daemon RPC is configured, so ` +
					"there is no way to tell a true zero from an unscanned wallet. " +
					`Set CHAIN_${this.symbol.toUpperCase()}_DAEMON_URL.`,
			);
		}
		const info = await this.daemon.call<{
			height?: number;
			target_height?: number;
			synchronized?: boolean;
			offline?: boolean;
			outgoing_connections_count?: number;
			incoming_connections_count?: number;
		}>("get_info");
		const height = info.height ?? 0;
		// target_height is 0 on a daemon that believes it is caught up, so the
		// tip is the larger of the two rather than target alone.
		const tip = Math.max(height, info.target_height ?? 0);
		const peers =
			(info.outgoing_connections_count ?? 0) + (info.incoming_connections_count ?? 0);

		// `retryable: true` throughout — none of these are a bad request, they
		// are "ask again later", and the caller turns them into a 503 rather
		// than a 400 that a client would stop retrying.
		if (info.offline === true) {
			throw new ChainError(`${this.symbol}: ${what} refused — the daemon is offline`, true);
		}
		if (peers === 0) {
			throw new ChainError(
				`${this.symbol}: ${what} refused — the daemon has no peers, so its ` +
					`height of ${height} reflects nothing about the chain`,
				true,
			);
		}
		if (info.synchronized !== true || height < tip) {
			throw new ChainError(
				`${this.symbol}: ${what} refused — the daemon is still syncing ` +
					`(${height}/${tip})`,
				true,
			);
		}
		const w = await this.rpc.call<{ height?: number }>("get_height");
		const scanned = w.height ?? 0;
		if (scanned + MoneroRpcAdapter.SCAN_LAG_TOLERANCE < height) {
			throw new ChainError(
				`${this.symbol}: ${what} refused — the wallet has scanned to ` +
					`${scanned} but the chain is at ${height}`,
				true,
			);
		}
	}

	async probe(): Promise<ChainCapabilities> {
		const notes: string[] = [];
		let height: number | undefined;
		try {
			const h = await this.rpc.call<{ height?: number }>("get_height");
			height = h.height;
		} catch (e) {
			return {
				reachable: false,
				synced: false,
				height: undefined,
				decimals: this.decimals,
				canDeriveAddresses: false,
				canSend: false,
				notes: [e instanceof Error ? e.message : String(e)],
			};
		}
		/*
		 * A WALLET'S HEIGHT IS NOT THE CHAIN'S. The wallet reports how far it
		 * has scanned; the daemon knows the tip. Without the daemon's number
		 * this cannot be called synced, and it is not guessed — a wallet that is
		 * behind shows an understated balance, which reads as a shortfall and
		 * halts withdrawals.
		 */
		let synced = false;
		if (this.daemon === undefined) {
			notes.push(
				"no daemon RPC is configured, so sync cannot be confirmed and every " +
					"balance, deposit and credit call refuses. Set " +
					`CHAIN_${this.symbol.toUpperCase()}_DAEMON_URL.`,
			);
		} else {
			try {
				await this.requireSynced("probe");
				synced = true;
			} catch (e) {
				// Report the reason; never let a failure here read as synced.
				notes.push(e instanceof Error ? e.message : String(e));
			}
		}
		let canDeriveAddresses = false;
		try {
			await this.rpc.call<unknown>("get_address", { account_index: this.accountIndex });
			canDeriveAddresses = true;
		} catch (e) {
			notes.push(`get_address failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		return {
			reachable: true,
			synced,
			height,
			decimals: this.decimals,
			// A subaddress is only useful if a deposit to it would be SEEN. While
			// the pair is behind, deriving one is a trap, so this reports false
			// even though get_address answered.
			canDeriveAddresses: canDeriveAddresses && synced,
			canSend: this.rpc.canSend,
			notes,
		};
	}

	async balance(): Promise<bigint> {
		await this.requireSynced("balance");
		const b = await this.rpc.call<{ unlocked_balance?: number | string }>("get_balance", {
			account_index: this.accountIndex,
		});
		const v = b.unlocked_balance;
		if (v === undefined) throw new ChainError(`${this.symbol}: no balance in the response`);
		// Monero reports ATOMIC UNITS as an integer, so no decimal conversion —
		// but it can exceed 2^53, which is why the string form is preferred.
		return BigInt(typeof v === "string" ? v : Math.trunc(v));
	}

	async newAddress(label: string): Promise<string> {
		await this.requireSynced("deposit address");
		const r = await this.rpc.call<{ address?: string }>("create_address", {
			account_index: this.accountIndex,
			label: label.slice(0, 64),
		});
		if (r.address === undefined || r.address.trim() === "") {
			throw new ChainError(`${this.symbol}: create_address returned no address`);
		}
		return r.address.trim();
	}

	async incoming(sinceHeight?: number): Promise<readonly IncomingPayment[]> {
		await this.requireSynced("deposit scan");
		const r = await this.rpc.call<{
			in?: Array<{
				txid?: string;
				address?: string;
				amount?: number | string;
				confirmations?: number;
			}>;
		}>("get_transfers", {
			in: true,
			...(sinceHeight === undefined
				? { }
				: { filter_by_height: true, min_height: sinceHeight }),
		});
		const out: IncomingPayment[] = [];
		for (const t of r.in ?? []) {
			if (t.txid === undefined || t.address === undefined || t.amount === undefined) continue;
			out.push({
				txid: t.txid,
				address: t.address,
				amount: BigInt(typeof t.amount === "string" ? t.amount : Math.trunc(t.amount)),
				confirmations: typeof t.confirmations === "number" ? t.confirmations : 0,
			});
		}
		return out;
	}

	async send(args: {
		to: string;
		amount: bigint;
		idempotencyKey: string;
	}): Promise<{ txid: string }> {
		if (!this.rpc.canSend) {
			throw new ChainError(`${this.symbol}: this adapter is read-only`);
		}
		if (args.amount <= 0n) throw new ChainError("refusing to send a non-positive amount");
		const r = await this.rpc.call<{ tx_hash?: string }>("transfer", {
			destinations: [{ address: args.to.trim(), amount: args.amount.toString() }],
			account_index: this.accountIndex,
			// Ring size is the wallet's business; overriding it here would be
			// weakening someone else's privacy on a guess.
			get_tx_key: false,
		});
		if (r.tx_hash === undefined || r.tx_hash.trim() === "") {
			throw new ChainError(
				`${this.symbol}: transfer returned no hash. NOT treating it as sent.`,
			);
		}
		return { txid: r.tx_hash.trim() };
	}
}

/* ----------------------------------------------------------------- factories */

export interface AdapterEnv {
	/** e.g. CHAIN_RTM_URL, CHAIN_RTM_USER, CHAIN_RTM_PASS, CHAIN_RTM_SEND. */
	readonly [key: string]: string | undefined;
}

/**
 * Build an adapter for one coin from the environment.
 *
 * Returns undefined when nothing is configured, which is the normal state for
 * a `planned` coin — NOT an error. An operator adding a coin sets the variables
 * and this starts answering.
 */
export function adapterFromEnv(args: {
	symbol: string;
	route: string;
	decimals: number | undefined;
	env: AdapterEnv;
	fetchImpl?: typeof fetch;
	/**
	 * THE SELF-CUSTODIED EVM RAIL'S WIRING, PASSED AS ONE NAMED FIELD ON AN
	 * OPTIONS OBJECT — NOT AS A TRAILING PARAMETER.
	 *
	 * That is a direct response to a bug this repository has already paid for.
	 * `blockAdapterFromEnv(env, fetchImpl?, pool?)` was called with one
	 * argument, so the BLOCK address pool was loaded, logged at startup, and
	 * never reached the adapter: there is no arity error for a missing optional
	 * trailing argument, so the call compiled, ran, and silently disabled
	 * per-customer BLOCK deposits. A thousand addresses sat unused while
	 * customers were told the rail was shut.
	 *
	 * THE EVM VERSION OF THAT BUG WOULD BE THE MIRROR IMAGE AND IT LOSES MONEY
	 * RATHER THAN MERELY ANNOYING PEOPLE. A rail with an xpub wired and the
	 * scanner NOT wired looks fully open — it issues addresses, the gas check
	 * passes, the deposit screen works — and answers "no deposits" at HTTP 200
	 * forever. Hence: a named field, and `probe()` reports what this adapter
	 * actually holds (including the xpub fingerprint) rather than what some
	 * other reference to the same objects believes.
	 */
	evm?: {
		readonly depositAddresses?: EvmDepositAddresses;
		readonly incomingSource?: EvmIncomingSource;
		readonly chainId?: number;
	};
}): ChainAdapter | undefined {
	const pre = `CHAIN_${args.symbol.toUpperCase()}_`;
	const url = args.env[`${pre}URL`];
	if (url === undefined || url.trim() === "") return undefined;
	if (args.decimals === undefined) {
		throw new ChainError(
			`${args.symbol}: a node is configured but decimals are unconfirmed in ` +
				"the registry. Refusing to build an adapter that would report " +
				"balances at a guessed scale.",
		);
	}
	// Read once each, so the `!== undefined` check and the value cannot differ.
	const user = args.env[`${pre}USER`];
	const pass = args.env[`${pre}PASS`];
	const phrase = args.env[`${pre}PASSPHRASE`];
	const token = args.env[`${pre}TOKEN`];
	const cfg: RpcConfig = {
		url: url.trim(),
		...(user === undefined ? {} : { user }),
		...(pass === undefined ? {} : { password: pass }),
		...(phrase === undefined ? {} : { passphrase: phrase }),
		// OPT-IN, and spelled out: anything other than exactly "1" leaves this
		// read-only, so a typo cannot enable sending.
		allowSend: args.env[`${pre}SEND`] === "1",
		...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
	};
	const rpc = new JsonRpc(cfg);
	// Same spelling the EVM route already uses, so an operator configuring a
	// second chain does not have to learn a second name for the same idea.
	const declaredAddresses = (args.env[`${pre}ADDRESSES`] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	switch (args.route) {
		case "bitcoin-rpc":
			return new BitcoinRpcAdapter(args.symbol, rpc, args.decimals, declaredAddresses);
		case "monero-rpc": {
			/*
			 * The daemon is a SECOND endpoint, because on this family the wallet
			 * and the node are two processes and only the node knows the tip.
			 * Credentials fall back to the wallet's, since the usual deployment
			 * is both on one box behind the same auth — but the URL never does,
			 * so pointing the adapter at a wallet cannot accidentally be read as
			 * having configured a daemon.
			 */
			const dUrl = args.env[`${pre}DAEMON_URL`];
			let daemon: JsonRpc | undefined;
			if (dUrl !== undefined && dUrl.trim() !== "") {
				const dUser = args.env[`${pre}DAEMON_USER`] ?? user;
				const dPass = args.env[`${pre}DAEMON_PASS`] ?? pass;
				daemon = new JsonRpc({
					url: dUrl.trim(),
					...(dUser === undefined ? {} : { user: dUser }),
					...(dPass === undefined ? {} : { password: dPass }),
					...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
				});
			}
			return new MoneroRpcAdapter(args.symbol, rpc, args.decimals, 0, daemon);
		}
		case "evm-rpc": {
			/*
			 * THE CHAIN ID COMES FROM THE DECLARED RULES WHEN THE CALLER DID NOT
			 * SUPPLY ONE, so a rail for a chain this venue has measured cannot be
			 * configured without the chain-id assertion. An unlisted EVM chain
			 * (OctaSpace, Rethereum) simply has no rule and no assertion, which is
			 * the behaviour it has always had.
			 */
			const chainId = args.evm?.chainId ?? EVM_CHAIN_RULES[args.symbol.toUpperCase()]?.chainId;
			return new EvmRpcAdapter(args.symbol, rpc, {
				decimals: args.decimals,
				addresses: declaredAddresses,
				...(token === undefined ? {} : { token }),
				...(args.evm?.depositAddresses === undefined
					? {}
					: { depositAddresses: args.evm.depositAddresses }),
				...(args.evm?.incomingSource === undefined
					? {}
					: { incomingSource: args.evm.incomingSource }),
				...(chainId === undefined ? {} : { chainId }),
			});
		}
		default:
			throw new ChainError(
				`${args.symbol}: no adapter for route "${args.route}". A bespoke chain ` +
					"needs its own class here — that is the point of the custom route, " +
					"not something to approximate with the nearest family.",
			);
	}
}
