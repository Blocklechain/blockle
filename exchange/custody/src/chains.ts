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
 * The EVM adapter. Any Ethereum-compatible JSON-RPC: OctaSpace, Rethereum,
 * Ethereum Classic, HyperEVM, and whatever else arrives.
 *
 * WHAT IT CANNOT DO, STATED FIRST: an EVM node holds no keys. There is no
 * `getnewaddress` and no `sendtoaddress`. So this adapter READS, and both
 * deposits-per-customer and withdrawals need a signer that lives elsewhere.
 * `probe()` reports that as a capability, which makes `canGoLive` refuse — a
 * coin on this route cannot be promoted until the signer exists.
 *
 * That is the honest outcome. An adapter that generated addresses from a key it
 * invented would be generating addresses nobody can spend from.
 */
export class EvmRpcAdapter implements ChainAdapter {
	readonly route = "evm-rpc";

	constructor(
		readonly symbol: string,
		private readonly rpc: JsonRpc,
		private readonly cfg: {
			readonly decimals: number;
			/** Addresses whose balances together are this venue's holding. */
			readonly addresses: readonly string[];
			/** Token contract, for an ERC-20 rather than the native coin. */
			readonly token?: string;
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
	}

	async probe(): Promise<ChainCapabilities> {
		const notes: string[] = [
			"an EVM node holds no keys: this route reads balances only. Deposit " +
				"addresses and withdrawals need a signer, which is not wired here.",
		];
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

		return {
			reachable: true,
			synced,
			height,
			decimals: this.cfg.decimals,
			canDeriveAddresses: false,
			canSend: false,
			notes,
		};
	}

	async balance(): Promise<bigint> {
		if (this.cfg.addresses.length === 0) {
			throw new ChainError(
				`${this.symbol}: no holding addresses are configured, so there is no ` +
					"balance to report. Refusing to return zero, which would read as " +
					"an empty treasury.",
			);
		}
		let total = 0n;
		for (const a of this.cfg.addresses) {
			total += this.cfg.token === undefined
				? await this.nativeBalance(a)
				: await this.tokenBalance(a);
		}
		return total;
	}

	// The parameters are declared though unused: this class implements
	// ChainAdapter, and a reader checking the shape should see the same
	// signature here as on the interface rather than wondering if it diverged.
	newAddress(_label: string): Promise<string> {
		return Promise.reject(
			new ChainError(
				`${this.symbol}: an EVM node cannot issue a deposit address — it holds ` +
					"no keys. Per-customer addresses need a signer (an HD key or a " +
					"custodian), which this route does not have.",
			),
		);
	}

	async incoming(): Promise<readonly IncomingPayment[]> {
		/*
		 * Deliberately empty AND loud. Finding incoming transfers on an EVM
		 * chain means scanning logs or blocks per watched address, which is a
		 * real piece of work — and returning [] quietly would make the deposit
		 * watcher report "no deposits" for a chain it is not actually watching.
		 */
		throw new ChainError(
			`${this.symbol}: incoming-transfer scanning is not implemented for the ` +
				"EVM route. Refusing to return an empty list, which would look like " +
				"'no deposits' rather than 'not watching'.",
		);
	}

	send(_args: {
		to: string;
		amount: bigint;
		idempotencyKey: string;
	}): Promise<{ txid: string }> {
		return Promise.reject(
			new ChainError(
				`${this.symbol}: this route cannot send. An EVM node signs nothing; ` +
					"a withdrawal needs a signer this service does not hold.",
			),
		);
	}

	private async nativeBalance(address: string): Promise<bigint> {
		const hex = await this.rpc.call<string>("eth_getBalance", [address, "latest"]);
		return this.hexToBig(hex);
	}

	private async tokenBalance(address: string): Promise<bigint> {
		// balanceOf(address) — selector 0x70a08231, argument left-padded to 32.
		const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
		const hex = await this.rpc.call<string>("eth_call", [
			{ to: this.cfg.token, data },
			"latest",
		]);
		return this.hexToBig(hex);
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
	) {}

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
		notes.push(
			"a wallet RPC reports only its own scan height; sync is confirmed " +
				"against the daemon, not here",
		);
		let canDeriveAddresses = false;
		try {
			await this.rpc.call<unknown>("get_address", { account_index: this.accountIndex });
			canDeriveAddresses = true;
		} catch (e) {
			notes.push(`get_address failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		return {
			reachable: true,
			synced: false,
			height,
			decimals: this.decimals,
			canDeriveAddresses,
			canSend: this.rpc.canSend,
			notes,
		};
	}

	async balance(): Promise<bigint> {
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
		case "monero-rpc":
			return new MoneroRpcAdapter(args.symbol, rpc, args.decimals);
		case "evm-rpc": {
			return new EvmRpcAdapter(args.symbol, rpc, {
				decimals: args.decimals,
				addresses: declaredAddresses,
				...(token === undefined ? {} : { token }),
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
