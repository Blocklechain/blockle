// -----------------------------------------------------------------------------
// WHICH CUSTODIAN HOLDS WHICH COIN.
//
// Two custody models now coexist, and they are not interchangeable:
//
//   BitGo         BTC, ETH, the stablecoins, the majors. Key shares are
//                 theirs; a send needs their policy to agree.
//   our own node  Raptoreum, Pepecoin, Neoxa, BLOCK… — everything BitGo will
//                 not touch. The hot wallet is a file on a box we run.
//
// Every part of the custody stack — reconciliation, deposit addresses,
// payouts — has to ask "who holds this one" before it can do anything, and
// getting that wrong is not a degraded answer, it is a wrong one: reconciling
// RTM against BitGo reports zero holdings against real liabilities, which is
// an instant permanent halt on a coin that is perfectly fine.
//
// THE RULE THIS FILE ENFORCES: AN ASSET WITH NO CUSTODIAN IS UNKNOWN, NEVER
// ZERO.
//
// It would be easy to make `holdings()` return 0n for a coin nobody holds.
// Reconciliation would then read "we owe 400 RTM and hold none" and halt
// withdrawals — or, for an asset with no liabilities yet, read as perfectly
// balanced and create the impression that a coin is custodied when nothing is
// watching it. Both are worse than an explicit "I cannot answer", which the
// reconciler already classifies as UNAVAILABLE and reports as such.
// -----------------------------------------------------------------------------

import { settlementAsset } from "./assets";
import { blockAdapterFromEnv, type AddressPool } from "./blockchain";
import { adapterFromEnv, type ChainAdapter } from "./chains";
import { LISTED, type ListedCoin } from "./listed";
import type { HoldingsSource } from "./reconcile";

export class RoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutingError";
	}
}

/** Where a given asset's coins actually sit. */
export type Custodian = "bitgo" | "node" | "none";

/**
 * Build the adapter set for every listed coin that is NOT on BitGo.
 *
 * A coin with no `CHAIN_<SYM>_URL` yields no adapter, which is the normal
 * state of a planned listing — it is absent from the map rather than present
 * and broken. `onSkip` is called for each so a caller can log what is missing
 * without this deciding that for it.
 */
export function nodeAdapters(args: {
	env: NodeJS.ProcessEnv;
	coins?: readonly ListedCoin[];
	onSkip?: (symbol: string, why: string) => void;
	/**
	 * BLOCK's deposit-address pool, where one is loaded. Absent — as in the
	 * reconciler, which only reads — leaves BLOCK able to report balances and
	 * unable to issue addresses, which is exactly right for a job that has no
	 * business issuing them.
	 */
	blockPool?: AddressPool;
	/**
	 * DOES THIS PROCESS PAY MONEY OUT? Default NO, and only the payout runner
	 * passes true.
	 *
	 * The send permission used to come from `CHAIN_<SYM>_SEND=1` alone, and
	 * that flag lives in the ONE env file every exchange unit loads — so the
	 * internet-facing API, the watcher and the reconciler each built a
	 * send-capable hot-wallet adapter for every self-custodied coin. None of
	 * them has ever called `send`. Now the capability has to be asked for, and
	 * the three read-only jobs do not ask.
	 *
	 * It does NOT make the credential safe: a daemon with no `rpcwhitelist`
	 * honours `sendtoaddress` and `dumpwallet` from anyone who can read that
	 * file, whatever this object refuses. See `adapterFromEnv.canSend`.
	 */
	canSend?: boolean;
}): Map<string, ChainAdapter> {
	const out = new Map<string, ChainAdapter>();
	for (const coin of args.coins ?? LISTED) {
		if (coin.custody === "bitgo") continue;
		let adapter: ChainAdapter | undefined;
		try {
			/*
			 * BLOCK IS ITS OWN CASE, because the venue's own chain is the one
			 * coin nobody else will ever custody. It has no bitcoind-style RPC
			 * and no wallet on the node; what it has is an explorer API that
			 * can answer "how much is at this address". See blockchain.ts.
			 */
			adapter = coin.symbol === "BLOCK"
				/*
				 * THE POOL HAS TO BE FORWARDED, and for a while it was not.
				 *
				 * This read `blockAdapterFromEnv(args.env)` — one argument —
				 * while the signature is (env, fetchImpl?, pool?). So
				 * `nodeAdapters` accepted a `blockPool`, used it for nothing,
				 * and handed BLOCK an adapter with no pool.
				 *
				 * The symptom was maddening precisely because the pool WAS
				 * loaded: the API logged "block pool: 999 free of 1000" at
				 * startup from its own reference, and the deposit route then
				 * refused every request with "no address pool is loaded, derive
				 * a batch on the wallet host" — advice to do the thing that had
				 * already been done. 1000 addresses sat in the database while
				 * customers were told BLOCK deposits were closed.
				 *
				 * An optional trailing parameter is what made it silent: there
				 * is no arity error, so the call compiles, runs, and quietly
				 * disables per-customer BLOCK deposits.
				 */
				? blockAdapterFromEnv(args.env, undefined, args.blockPool)
				: adapterFromEnv({
					symbol: coin.symbol,
					route: coin.custody,
					decimals: coin.decimals,
					env: args.env,
					// Forwarded EXPLICITLY, not defaulted from the environment.
					// The BLOCK pool above is in this file because an optional
					// trailing argument was dropped once; a dropped `canSend`
					// fails in the SAFE direction (a payout runner that cannot
					// pay, which is loud) rather than the dangerous one.
					canSend: args.canSend === true,
				});
		} catch (e) {
			/*
			 * A MISCONFIGURED ADAPTER IS SKIPPED HERE AND UNKNOWN LATER.
			 *
			 * Throwing would take down the whole process over one coin's
			 * environment typo, and that is a worse failure than the coin being
			 * unavailable: the other eleven are fine. The asset ends up with no
			 * custodian, so `holdings()` refuses to answer for it and the
			 * reconciler reports UNAVAILABLE — visible, specific, and not a
			 * number anyone can act on by mistake.
			 */
			args.onSkip?.(coin.symbol, e instanceof Error ? e.message : String(e));
			continue;
		}
		if (adapter === undefined) {
			args.onSkip?.(coin.symbol, "no node configured");
			continue;
		}
		out.set(coin.symbol, adapter);
	}
	return out;
}

/**
 * Holdings across both custody models.
 *
 * `bitgo` may be absent (no token configured), which is not an error — it just
 * means every BitGo-custodied asset is unknown, and says so per asset rather
 * than failing the whole pass.
 */
export function routedHoldings(args: {
	bitgo?: HoldingsSource;
	nodes: ReadonlyMap<string, ChainAdapter>;
	/** Which assets BitGo is responsible for. Defaults to the registry's view. */
	custodianOf?: (asset: string) => Custodian;
}): HoldingsSource {
	const custodianOf = args.custodianOf ?? defaultCustodianOf(args.nodes);
	const names = [
		args.bitgo === undefined ? undefined : args.bitgo.name,
		args.nodes.size === 0 ? undefined : `nodes(${[...args.nodes.keys()].join(",")})`,
	].filter((s): s is string => s !== undefined);

	return {
		// The report carries ONE source name, so it names both. A report that
		// said "bitgo" while half its figures came from our own daemons would
		// misdescribe where the money is.
		name: names.length === 0 ? "no-custodian" : names.join("+"),

		async holdings(asset: string): Promise<bigint> {
			// Network-qualified ids settle to one coin: USDT.TRC20 is USDT.
			const symbol = settlementAsset(asset);
			switch (custodianOf(symbol)) {
				case "bitgo": {
					if (args.bitgo === undefined) {
						throw new RoutingError(
							`${symbol} is custodied by BitGo but no BitGo client is ` +
								"configured, so its holdings are unknown. Reporting " +
								"unknown rather than zero: zero would read as a shortfall " +
								"against real liabilities and halt the asset.",
						);
					}
					return args.bitgo.holdings(asset);
				}
				case "node": {
					const adapter = args.nodes.get(symbol);
					/* istanbul ignore next — custodianOf and nodes agree by construction */
					if (adapter === undefined) {
						throw new RoutingError(`${symbol}: no adapter, despite being routed to one`);
					}
					/*
					 * A NODE THAT IS BEHIND MUST NOT BE BELIEVED.
					 *
					 * A syncing daemon reports the balance as of the block it has
					 * reached, which is lower than the truth — indistinguishable
					 * from coins having left. That is a shortfall, and a shortfall
					 * halts withdrawals. So sync is checked before the number is
					 * used, and an unsynced node is "unknown" instead.
					 */
					const cap = await adapter.probe();
					if (!cap.reachable) {
						throw new RoutingError(
							`${symbol}: its node did not answer (${cap.notes.join("; ")})`,
						);
					}
					if (!cap.synced) {
						throw new RoutingError(
							`${symbol}: its node is not synced, so any balance it reports ` +
								"is understated and would read as a shortfall. " +
								`(${cap.notes.join("; ")})`,
						);
					}
					return adapter.balance();
				}
				default:
					throw new RoutingError(
						`${symbol} has no custodian configured, so its holdings are ` +
							"unknown. This is reported rather than treated as zero — a " +
							"zero here is indistinguishable from 'the coins are gone'.",
					);
			}
		},
	};
}

/** The registry's view: BitGo coins, node coins, and everything else unknown. */
export function defaultCustodianOf(
	nodes: ReadonlyMap<string, ChainAdapter>,
): (asset: string) => Custodian {
	const listed = new Map(LISTED.map((c) => [c.symbol, c]));
	return (asset: string): Custodian => {
		const symbol = settlementAsset(asset);
		if (nodes.has(symbol)) return "node";
		const coin = listed.get(symbol);
		/*
		 * NOT IN THE LISTING REGISTRY MEANS BITGO.
		 *
		 * The registry exists for the small coins we integrate ourselves; BTC,
		 * ETH and the stablecoins are not in it and never will be. So the
		 * default for an unlisted asset is the custodian, and a listed coin
		 * whose node is not configured falls through to "none" — unknown —
		 * rather than quietly being asked of BitGo, which does not hold it.
		 */
		if (coin === undefined) return "bitgo";
		return coin.custody === "bitgo" ? "bitgo" : "none";
	};
}

/**
 * Issue a deposit address for a node-custodied coin.
 *
 * Mirrors what the BitGo path does, with the same two guarantees: the address
 * comes from the chain itself (never generated here, never reused), and the
 * label carries the account id so an operator looking at the daemon's wallet
 * can see whose address it is.
 */
export async function nodeDepositAddress(args: {
	adapter: ChainAdapter;
	userId: string;
}): Promise<{ address: string; source: string }> {
	const address = await args.adapter.newAddress(`blockle-ex:${args.userId}`);
	if (address.trim() === "") {
		throw new RoutingError(
			`${args.adapter.symbol}: the node returned an empty address. Refusing to ` +
				"hand that to a customer — a deposit to it could not be credited.",
		);
	}
	return { address: address.trim(), source: `${args.adapter.route}:${args.adapter.symbol}` };
}
