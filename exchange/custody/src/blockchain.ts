// -----------------------------------------------------------------------------
// CUSTODY FOR BLOCK — the venue's own chain.
//
// BLOCK is the other half of every market here, so it is the one coin the
// exchange cannot outsource. There is no custodian for it and there never will
// be; what there is, is a node we run, with an HTTP explorer API that answers
// per-address questions:
//
//     /explorer/stats              height, lanes
//     /explorer/address/<addr>     confirmed balance, recent history
//     /explorer/peers              connectivity
//
// READ-ONLY, AND THAT IS A FEATURE, NOT A SHORTFALL.
//
// Those endpoints hold no keys and can move nothing. A reconciliation job that
// only needs to ask "how much is there" should not be running with the ability
// to spend, and with this adapter it cannot — the capability is absent rather
// than merely unused.
//
// WHAT THIS DELIBERATELY DOES NOT DO, AND WHY.
//
// `newAddress()` and `send()` refuse, because the chain as it stands cannot
// support them safely in this context:
//
//   * PER-CUSTOMER DEPOSIT ADDRESSES. The wallet is one key per wallet file —
//     no HD derivation — and the transaction format carries no memo or
//     destination tag. So attributing a BLOCK deposit to a customer would mean
//     one wallet file per customer, i.e. N spendable hot keys on the box. That
//     is a real design with real trade-offs and it is the operator's call, not
//     something to adopt silently inside an adapter.
//   * SENDING. Same reason, plus: the signing path is the `blockle-chain send`
//     CLI with a passphrase, which is a different trust boundary from an HTTP
//     read. Wiring it here would put spending authority into the same object
//     the public API holds for reading balances.
//
// So `canDeriveAddresses` and `canSend` are false, `canGoLive` refuses to
// promote BLOCK on exactly those two grounds, and the operator sees the real
// decision in the readiness report instead of discovering it when a customer
// asks where their deposit went.
//
// WHAT IT DOES BUY TODAY: BLOCK's custody figure comes from the chain rather
// than from a file someone maintains by hand. That is the difference between
// reconciliation proving something and reconciliation agreeing with itself.
// -----------------------------------------------------------------------------

import type { ChainAdapter, ChainCapabilities, IncomingPayment } from "./chains";
import { ChainError } from "./chains";

/**
 * What this needs from the address pool. A structural type rather than an
 * import of the class, so the adapter stays testable without a database and
 * cannot reach anything else on it.
 */
export interface AddressPool {
	take(userId: string): { address: string };
	allAddresses(): readonly string[];
	status(): { total: number; issued: number; free: number; low: boolean };
}

export interface BlockExplorerConfig {
	/** Base URL of the node's aux/explorer HTTP listener. */
	readonly url: string;
	/**
	 * Addresses whose balances together are the venue's BLOCK custody.
	 *
	 * Explicit, never discovered. An adapter that summed "every address we
	 * have ever seen" would fold a customer's own wallet into the venue's
	 * holdings the moment they withdrew to it.
	 */
	readonly addresses: readonly string[];
	/**
	 * Pre-derived deposit addresses, when BLOCK deposits are open.
	 *
	 * Absent means `newAddress` refuses and says how to load one. The pool
	 * also contributes its addresses to the custody total — coins sitting at
	 * a customer's deposit address before a sweep are still the venue's
	 * holding, and leaving them out would read as a shortfall.
	 */
	readonly pool?: AddressPool;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	/**
	 * How far behind the best known height still counts as synced.
	 *
	 * Not zero: this chain has ten lanes and a three-minute native interval, so
	 * a node one block behind at the instant of the read is normal, not a
	 * custody emergency. Two blocks is under ten minutes of drift.
	 */
	readonly toleranceBlocks?: number;
}

interface AddressJson {
	address?: string;
	balance?: number | string;
	history?: Array<{
		txid?: string;
		height?: number;
		time?: number;
		kind?: string;
		net?: number | string;
	}>;
}

interface StatsJson {
	height?: number;
	lanes?: Array<{ lane?: string; last_block_height?: number }>;
}

/** BLOCK, read from the chain the venue runs. */
export class BlockExplorerAdapter implements ChainAdapter {
	readonly symbol = "BLOCK";
	readonly route = "custom";
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly cfg: BlockExplorerConfig) {
		if (!/^https?:\/\//.test(cfg.url)) {
			throw new ChainError(`BLOCK explorer url must be http(s): ${cfg.url}`);
		}
		for (const a of cfg.addresses) {
			// Bech32-style, as the chain encodes them. Checked here so a typo is
			// a startup error rather than a silently-missing holding — an
			// address that 404s would otherwise just read as less money.
			if (!/^block1[0-9a-z]{20,}$/.test(a)) {
				throw new ChainError(`not a BLOCK address: ${JSON.stringify(a)}`);
			}
		}
		this.timeoutMs = cfg.timeoutMs ?? 15_000;
		this.fetchImpl = cfg.fetchImpl ?? fetch;
	}

	async probe(): Promise<ChainCapabilities> {
		const notes = [
			"read-only: this adapter talks to the node's explorer API, which holds " +
				"no keys and can move nothing",
		];
		const pool = this.cfg.pool?.status();
		if (pool === undefined) {
			notes.push(
				"no deposit-address pool is loaded, so BLOCK deposits are closed",
			);
		} else {
			notes.push(`deposit addresses: ${pool.free} free of ${pool.total}`);
			if (pool.low) {
				// Said at probe time so it reaches the operator before the pool
				// empties and deposits stop.
				notes.push(
					"the address pool is running low — refill it before it empties, " +
						"or BLOCK deposits will stop",
				);
			}
		}
		let stats: StatsJson;
		try {
			stats = await this.get<StatsJson>("/explorer/stats");
		} catch (e) {
			return {
				reachable: false,
				synced: false,
				height: undefined,
				decimals: 8,
				canDeriveAddresses: false,
				canSend: false,
				notes: [e instanceof Error ? e.message : String(e)],
			};
		}
		const height = typeof stats.height === "number" ? stats.height : undefined;

		/*
		 * SYNCED AGAINST THE LANES, because there is no other yardstick here.
		 *
		 * A single-chain node can compare its blocks to its headers. This one
		 * reports a height plus the last height each merge-mined lane saw, and
		 * the highest of those is the best block anyone has told us about. A
		 * node lagging its own lanes is behind; one at the top of them is as
		 * current as it can know it is.
		 */
		const best = Math.max(
			height ?? 0,
			...(stats.lanes ?? []).map((l) =>
				typeof l.last_block_height === "number" ? l.last_block_height : 0,
			),
		);
		const tolerance = this.cfg.toleranceBlocks ?? 2;
		const synced = height !== undefined && best - height <= tolerance;
		if (!synced) notes.push(`at height ${height ?? "?"}, lanes report ${best}`);

		// Connectivity is reported but is NOT part of "synced": a node with no
		// peers that is already at the tip is current, and one with fifty peers
		// that is behind is not.
		try {
			const peers = await this.get<{ count?: number }>("/explorer/peers");
			if ((peers.count ?? 0) === 0) {
				notes.push("the node has no peers, so it may not learn of new blocks");
			}
		} catch {
			// Not worth failing a probe over — the height already came back.
			notes.push("peer count unavailable");
		}

		return {
			reachable: true,
			synced,
			height,
			decimals: 8,
			// Addresses come from the pool, not from this process — but to
			// everything downstream the capability is the same question: can a
			// customer be given somewhere to deposit?
			canDeriveAddresses: (pool?.free ?? 0) > 0,
			canSend: false,
			notes,
		};
	}

	/**
	 * Every address whose coins are the venue's: the treasury addresses from
	 * configuration, plus every issued deposit address.
	 *
	 * Deposits sitting at a customer's address before a sweep ARE custody —
	 * the venue owes that customer the balance it credited. Counting only the
	 * treasury would show the liability without the asset, which is a
	 * shortfall, which halts BLOCK.
	 */
	private custodyAddresses(): readonly string[] {
		const pooled = this.cfg.pool?.allAddresses() ?? [];
		return [...new Set([...this.cfg.addresses, ...pooled])];
	}

	async balance(): Promise<bigint> {
		if (this.custodyAddresses().length === 0) {
			throw new ChainError(
				"no BLOCK custody addresses are configured, so there is no balance " +
					"to report. Refusing to return zero, which reconciliation would " +
					"read as an empty treasury against real liabilities.",
			);
		}
		let total = 0n;
		for (const address of this.custodyAddresses()) {
			const r = await this.get<AddressJson>(
				`/explorer/address/${encodeURIComponent(address)}`,
			);
			if (r.balance === undefined) {
				throw new ChainError(`${address}: the explorer returned no balance`);
			}
			total += toBase(r.balance, address);
		}
		return total;
	}

	/**
	 * Hand out a pre-derived address.
	 *
	 * The chain can derive unlimited addresses from one seed now, but ML-DSA
	 * has no watch-only derivation — anything that derives also holds spending
	 * authority. So this process never derives: an operator does it offline
	 * and loads the addresses into a pool, and this takes the next one. See
	 * blockaddresspool.ts for why that division is the point.
	 *
	 * `label` is the account id; the pool keys on it, so a customer coming
	 * back gets the address they already have rather than consuming another.
	 */
	newAddress(label: string): Promise<string> {
		if (this.cfg.pool === undefined) {
			return Promise.reject(
				new ChainError(
					"BLOCK deposits are not open: no address pool is loaded. Derive a " +
						"batch on the wallet host with `blockle-chain wallet derive " +
						"--count 1000 --json` and load it here — this process " +
						"deliberately cannot derive addresses itself, because deriving " +
						"requires the seed that can spend them.",
				),
			);
		}
		try {
			return Promise.resolve(this.cfg.pool.take(label).address);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : new ChainError(String(e)));
		}
	}

	async incoming(sinceHeight?: number): Promise<readonly IncomingPayment[]> {
		const tip = (await this.probe()).height;
		const out: IncomingPayment[] = [];
		for (const address of this.custodyAddresses()) {
			const r = await this.get<AddressJson>(
				`/explorer/address/${encodeURIComponent(address)}`,
			);
			for (const h of r.history ?? []) {
				if (typeof h.txid !== "string" || typeof h.height !== "number") continue;
				if (sinceHeight !== undefined && h.height < sinceHeight) continue;
				let net: bigint;
				try {
					net = toBase(h.net ?? 0, address);
				} catch {
					// A row we cannot read is skipped, not guessed: it will be
					// picked up next pass, and crediting a wrong amount cannot be
					// taken back.
					continue;
				}
				// NET, so a transaction that spent more than it received is not a
				// deposit. Only money arriving counts.
				if (net <= 0n) continue;
				out.push({
					txid: h.txid,
					address,
					amount: net,
					// Depth from the tip. The explorer reports the height a
					// transaction landed at, not how deep it is now.
					confirmations: tip === undefined ? 0 : Math.max(0, tip - h.height + 1),
				});
			}
		}
		return out;
	}

	send(_args: {
		to: string;
		amount: bigint;
		idempotencyKey: string;
	}): Promise<{ txid: string }> {
		return Promise.reject(
			new ChainError(
				"this adapter cannot send BLOCK. It speaks to the node's read-only " +
					"explorer API; signing goes through the wallet CLI with a " +
					"passphrase, which is a different trust boundary and is " +
					"deliberately not reachable from the object the public API holds " +
					"for reading balances.",
			),
		);
	}

	private async get<T>(path: string): Promise<T> {
		const url = `${this.cfg.url.replace(/\/$/, "")}${path}`;
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				signal: ctl.signal,
				headers: { accept: "application/json" },
			});
		} catch (e) {
			throw new ChainError(
				`BLOCK explorer ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`,
				true,
			);
		} finally {
			clearTimeout(timer);
		}
		const text = await res.text();
		if (!res.ok) {
			throw new ChainError(`BLOCK explorer ${path}: HTTP ${res.status} ${text.slice(0, 120)}`);
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new ChainError(
				`BLOCK explorer ${path} returned a body that is not JSON: ${text.slice(0, 120)}`,
			);
		}
	}
}

/**
 * The explorer reports BLOCK in BASE UNITS already — the chain's internal u64,
 * not a decimal figure.
 *
 * Worth stating because every other adapter here converts from decimal coins,
 * and treating this one the same way would multiply every balance by 10^8. The
 * giveaway in the live data is a coinbase of `45000000`: the subsidy is 0.45
 * BLOCK at this height, not forty-five million.
 */
function toBase(v: number | string, address: string): bigint {
	if (typeof v === "string") {
		if (!/^-?\d+$/.test(v)) {
			throw new ChainError(`${address}: not an integer amount: ${JSON.stringify(v)}`);
		}
		return BigInt(v);
	}
	if (!Number.isFinite(v) || !Number.isInteger(v)) {
		throw new ChainError(`${address}: not an integer amount: ${v}`);
	}
	if (!Number.isSafeInteger(v)) {
		// Past 2^53 a JSON number has already lost the low digits — about 90
		// million BLOCK. The treasury could reach that; refusing beats quietly
		// reporting an approximate custody figure.
		throw new ChainError(
			`${address}: the explorer reported ${v}, which is beyond what a JSON ` +
				"number carries exactly. Refusing an approximate custody balance.",
		);
	}
	return BigInt(v);
}

/** Build from the environment, or undefined when BLOCK custody is not wired. */
export function blockAdapterFromEnv(
	env: NodeJS.ProcessEnv,
	fetchImpl?: typeof fetch,
	pool?: AddressPool,
): BlockExplorerAdapter | undefined {
	const url = (env.BLOCK_EXPLORER_URL ?? "").trim();
	if (url === "") return undefined;
	const addresses = (env.BLOCK_CUSTODY_ADDRESSES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return new BlockExplorerAdapter({
		url,
		addresses,
		...(pool === undefined ? {} : { pool }),
		...(fetchImpl === undefined ? {} : { fetchImpl }),
	});
}
