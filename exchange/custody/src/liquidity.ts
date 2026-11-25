// -----------------------------------------------------------------------------
// WITHDRAWAL LIQUIDITY — what can actually be withdrawn, per chain, right now.
//
// WHY THIS IS PUBLISHED RATHER THAN HIDDEN.
//
// A customer holding 500 USDT does not hold "500 USDT". They hold a claim on
// inventory that physically sits on specific chains. If the venue has 500 units
// on Tron and nothing on BNB Smart Chain, a BSC withdrawal cannot be paid — and
// no conversion exists to fix that at the custody layer (see assets.ts).
//
// The dishonest options are: show the network picker anyway and fail after the
// customer commits, or silently queue them with no explanation. Both read to a
// customer as "the exchange has lost my money".
//
// The honest option is to say, up front and per chain, how much is available.
// That turns an inventory problem into an informed choice: the customer picks a
// chain that can actually pay, gets their funds immediately, and never sees a
// failure. It is also a live proof-of-reserves, which is worth something on its
// own for a venue nobody has heard of yet.
//
// AVAILABILITY IS NOT INVENTORY. Two deductions matter:
//
//   COMMITTED  withdrawals already approved for this chain but not yet on it.
//              Those units are spoken for. Ignoring them is how a venue
//              promises the same coins to two people.
//
//   HALTED     the reconciliation interlock. If books and custody disagree for
//              an asset, nothing is available on any of its chains, whatever
//              the inventory says — because the inventory number is exactly
//              what is in question.
//
// WHAT IS DELIBERATELY NOT PUBLISHED: customer balances, address-level
// holdings, or anything that identifies who holds what. Aggregate inventory per
// chain is a treasury fact; per-customer data is not.
// -----------------------------------------------------------------------------

import { ASSETS, custodyIds, networkOf, withdrawalNetworks } from "./assets";
import { AccountKind, type Ledger } from "./ledger";

/** Where pending per-network commitments come from. Injected, so testable. */
export interface CommitmentSource {
	/**
	 * Units already committed to each network by withdrawals that are
	 * requested/screened/approved/submitted but not yet settled.
	 *
	 * Keyed by qualified custody id, e.g. "USDT.TRC20".
	 */
	committedByNetwork(symbol: string): Map<string, bigint>;
}

/** Assets whose withdrawals the reconciler has halted. */
export interface HaltSource {
	halted(symbol: string): boolean;
	reason(symbol: string): string;
}

export const NOTHING_HALTED: HaltSource = {
	halted: () => false,
	reason: () => "",
};

export interface NetworkLiquidity {
	/**
	 * The chain id — or, for a SINGLE-CHAIN asset, the asset symbol.
	 *
	 * The fallback is deliberate here: this view needs one row per holding and
	 * a row needs a name. But it is NOT a network id a caller may pass back,
	 * and `native` below is how to tell.
	 */
	readonly network: string;
	/**
	 * TRUE WHEN THE ASSET HAS NO NETWORKS AT ALL, so `network` above is a label
	 * rather than a chain.
	 *
	 * Added because the deposit screen could not tell the difference. It read
	 * `network: "BTC"` from /v1/withdrawal-options, put it in the chain
	 * dropdown, and sent `?asset=BTC&network=BTC` — which the deposit path
	 * refuses outright, correctly: a qualified id for a single-chain coin means
	 * the caller has confused it with a token. Every single-chain asset was
	 * therefore impossible to provision an address for, 578 requests all
	 * 400-ing, which is what kept `deposit:addresses` at NONE and the go-live
	 * gate shut.
	 *
	 * A caller that sees `native: true` must send NO network.
	 */
	readonly native: boolean;
	readonly label: string;
	/** Confirmed inventory on this chain, in base units. */
	readonly held: bigint;
	/** Already promised to other withdrawals on this chain. */
	readonly committed: bigint;
	/** held - committed, floored at zero. What a customer can take now. */
	readonly available: bigint;
	/** False when nothing can be withdrawn over this chain. */
	readonly open: boolean;
	/** Why it is closed, in words a customer can act on. */
	readonly closedReason: string | undefined;
}

export interface AssetLiquidity {
	readonly asset: string;
	readonly decimals: number;
	/** Total owed to customers and fees across all chains. */
	readonly liabilities: bigint;
	/** Sum of inventory across all chains. */
	readonly totalHeld: bigint;
	/** Cheapest-first, which is the order a picker should offer. */
	readonly networks: readonly NetworkLiquidity[];
	/** The largest single withdrawal payable right now, on any one chain. */
	readonly maxSingleWithdrawal: bigint;
	readonly halted: boolean;
}

/**
 * Dust floor: below this a chain is treated as empty.
 *
 * A chain holding 3 base units is not usefully "open" — the withdrawal would
 * cost more in network fees than it moves, and showing it as available invites
 * a customer to pick a chain that will immediately reject them for being under
 * the minimum. Expressed in base units per asset's decimals.
 */
function dustFloor(decimals: number): bigint {
	// ~0.001 of a whole unit, which is a cent for a stablecoin.
	return decimals >= 3 ? 10n ** BigInt(decimals - 3) : 1n;
}

export function assetLiquidity(
	ledger: Ledger,
	symbol: string,
	commitments: CommitmentSource,
	halts: HaltSource = NOTHING_HALTED,
): AssetLiquidity {
	const def = ASSETS[symbol];
	if (def === undefined) throw new Error(`unknown asset ${symbol}`);

	const inventory = ledger.custodyByNetwork(symbol);
	const committed = commitments.committedByNetwork(symbol);
	const halted = halts.halted(symbol);
	const haltReason = halts.reason(symbol);
	const floor = dustFloor(def.decimals);

	// Single-chain assets still get one "network" row, so a caller never has
	// to branch on whether an asset is multi-chain. The label is the asset
	// itself, which is what a customer expects to see for BTC.
	const ids =
		def.networks.length === 0
			? [{ id: symbol, label: symbol }]
			: withdrawalNetworks(symbol).map((n) => ({
					id: `${symbol}.${n.id}`,
					label: n.label,
				}));

	const networks: NetworkLiquidity[] = ids.map(({ id, label }) => {
		const held = inventory.get(id) ?? 0n;
		const promised = committed.get(id) ?? 0n;
		const available = held - promised > 0n ? held - promised : 0n;

		let open = true;
		let closedReason: string | undefined;
		if (halted) {
			open = false;
			closedReason = `temporarily unavailable: ${haltReason}`;
		} else if (available < floor) {
			open = false;
			closedReason =
				promised > 0n && held >= floor
					? "fully committed to withdrawals already in progress"
					: "no liquidity on this network right now";
		}

		const chain = networkOf(id);
		return {
			network: chain ?? symbol,
			native: chain === undefined,
			label,
			held,
			committed: promised,
			available,
			open,
			closedReason,
		};
	});

	let totalHeld = 0n;
	for (const v of inventory.values()) totalHeld += v;

	const maxSingle = networks.reduce(
		(m, n) => (n.open && n.available > m ? n.available : m),
		0n,
	);

	return {
		asset: symbol,
		decimals: def.decimals,
		liabilities: ledger.liabilities(symbol),
		totalHeld,
		networks,
		maxSingleWithdrawal: maxSingle,
		halted,
	};
}

/**
 * Can this exact withdrawal be paid over this exact chain?
 *
 * The question `withdrawals.request()` must ask before accepting, and the
 * question the UI must ask before offering a network. Returning a reason rather
 * than a boolean is deliberate: "insufficient liquidity" with no number tells a
 * customer nothing, and they will try again immediately.
 */
export function canPay(
	liq: AssetLiquidity,
	networkId: string,
	amount: bigint,
): { ok: true } | { ok: false; reason: string; available: bigint } {
	const net = liq.networks.find((n) => n.network === networkId);
	if (net === undefined) {
		return {
			ok: false,
			reason: `${liq.asset} is not withdrawable over ${networkId}`,
			available: 0n,
		};
	}
	if (!net.open) {
		return {
			ok: false,
			reason: `${net.label}: ${net.closedReason ?? "unavailable"}`,
			available: net.available,
		};
	}
	if (amount > net.available) {
		return {
			ok: false,
			reason:
				`${net.label} has ${net.available} available, which is less than ` +
				`the ${amount} requested. Another network may have more.`,
			available: net.available,
		};
	}
	return { ok: true };
}

/**
 * The public projection — what gets served to a browser.
 *
 * Amounts are rendered as decimal STRINGS, never JSON numbers. A JSON number
 * is a double, and a USDT balance above ~9e15 base units would be silently
 * mangled on the way out — the exact class of bug found in TradeXPro's PHP
 * helpers. Strings cost nothing and cannot be wrong.
 */
export interface PublicLiquidity {
	readonly asset: string;
	readonly decimals: number;
	readonly networks: readonly {
		network: string;
		label: string;
		available: string;
		open: boolean;
		note?: string;
	}[];
	readonly maxSingleWithdrawal: string;
	readonly updatedAt: string;
}

export function publish(
	liq: AssetLiquidity,
	format: (base: bigint, decimals: number) => string,
	now: () => number = () => Date.now(),
): PublicLiquidity {
	return {
		asset: liq.asset,
		decimals: liq.decimals,
		networks: liq.networks.map((n) => ({
			network: n.network,
			label: n.label,
			available: format(n.available, liq.decimals),
			open: n.open,
			...(n.closedReason !== undefined ? { note: n.closedReason } : {}),
		})),
		maxSingleWithdrawal: format(liq.maxSingleWithdrawal, liq.decimals),
		updatedAt: new Date(now()).toISOString(),
	};
}

/**
 * Reserves disclosure: what we owe against what we hold, per asset.
 *
 * Deliberately reports BOTH numbers rather than a ratio. A ratio of "100%"
 * invites rounding and hides a small shortfall; two exact figures a reader can
 * subtract do not. Publishing this is the venue's own claim, not an audit —
 * labelled as such, because calling self-reported figures "proof of reserves"
 * is the kind of overstatement that destroys the trust it was meant to build.
 */
export interface ReservesStatement {
	readonly asset: string;
	readonly owed: string;
	readonly held: string;
	readonly fullyBacked: boolean;
	readonly perNetwork: readonly { network: string; held: string }[];
}

export function reserves(
	ledger: Ledger,
	symbol: string,
	format: (base: bigint, decimals: number) => string,
): ReservesStatement {
	const def = ASSETS[symbol];
	if (def === undefined) throw new Error(`unknown asset ${symbol}`);
	const inv = ledger.custodyByNetwork(symbol);
	let held = 0n;
	for (const v of inv.values()) held += v;
	const owed = ledger.liabilities(symbol);

	return {
		asset: symbol,
		owed: format(owed, def.decimals),
		held: format(held, def.decimals),
		// >= not ==: a surplus is still fully backed. Only a shortfall is not.
		fullyBacked: held >= owed,
		perNetwork: custodyIds(symbol).map((id) => ({
			network: networkOf(id) ?? symbol,
			held: format(inv.get(id) ?? 0n, def.decimals),
		})),
	};
}

/** Accounts that count as a liability — exported so callers cannot disagree. */
export const LIABILITY_KINDS: readonly AccountKind[] = [
	AccountKind.USER,
	AccountKind.FEES,
	AccountKind.INFLIGHT,
];
