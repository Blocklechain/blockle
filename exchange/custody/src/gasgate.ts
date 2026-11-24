// -----------------------------------------------------------------------------
// THE GAS GATE — refuse a token withdrawal we cannot pay the gas for.
//
// THE FAILURE THIS PREVENTS, CONCRETELY.
//
// A customer withdraws 500 USDT over Ethereum. We hold plenty of USDT.ERC20, so
// the liquidity check passes. BitGo builds the transfer and it fails, because
// sending an ERC-20 token requires ETH in the sending wallet and there is none.
//
// What the customer has at that moment is a withdrawal that was accepted,
// debited, and is stuck. With withdrawals automatic there is no operator in the
// loop to notice; the honest outcome is a FAILED withdrawal and a refund, which
// means we accepted money, held it, and gave it back having achieved nothing.
// The dishonest outcome is that it sits in SUBMITTED forever.
//
// So the check belongs BEFORE the debit, next to the liquidity check, where a
// refusal is just a refusal.
//
// WHERE THE GAS COMES FROM, AND WHY IT IS NOT CUSTOMER ETH.
//
// We hold ETH for customers. Burning it as gas for someone else's USDT
// withdrawal spends one customer's asset to service another's — the exact thing
// the ledger exists to make impossible. Gas therefore comes from the venue's
// OWN ETH: the FEES account balance in the gas asset, funded by fee revenue and
// topped up from the treasury.
//
// That makes the gas float a number the books already track, with two
// consequences worth stating:
//
//   * `FEES[ETH]` going negative means we spent gas we did not own — i.e. we
//     dipped into customer ETH. This gate's job is to make that unreachable,
//     and revenue.ts surfaces it as a deficit if it ever happens anyway.
//
//   * A claim on ETH is not ETH. The FEES balance says we are owed it; the
//     custody holding says it exists. BOTH are required, and the gate reports
//     whichever is the binding constraint rather than a single blended figure.
//
// EVERY UNKNOWN IS A REFUSAL. An unpriced chain, an unreadable balance, a gas
// asset that is not in the registry — all refuse. The alternative is a gate
// that opens when it is confused, which is not a gate.
// -----------------------------------------------------------------------------

import { format, type AssetUnit } from "./amount";
import { assetDef, gasAssetFor, settlementAsset } from "./assets";
import { AccountKind, type Ledger } from "./ledger";

export class GasGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GasGateError";
	}
}

/** What one withdrawal over one chain burns, in the GAS ASSET's base units. */
export interface GasCost {
	/**
	 * Gas for a single transfer, in base units of the gas asset.
	 *
	 * Generous on purpose. Under-estimating here does not cost a customer a few
	 * cents — it lets through a withdrawal that then cannot be sent.
	 */
	readonly perWithdrawal: bigint;
	/**
	 * A reserve held back beyond what pending withdrawals need.
	 *
	 * Without it the float runs to exactly zero and the next withdrawal is
	 * refused with nothing in hand — and more importantly, a chain whose gas
	 * price doubles between the check and the send has no headroom at all. The
	 * floor is that headroom.
	 */
	readonly floor: bigint;
}

/** Keyed by qualified asset id, e.g. "USDT.ERC20". */
export type GasCostTable = Readonly<Record<string, GasCost>>;

/**
 * Gas costs per chain, in the gas asset's own base units.
 *
 * ETH and BNB are 18 decimals, TRX 6, SOL 9 — so these numbers are not
 * comparable to each other and are not meant to be.
 *
 * ONE NUMBER, TWO JOBS. Each `perWithdrawal` figure is both what the gate
 * reserves and what the fee is computed from (withdrawalfees.ts converts it at
 * a live rate). Keeping them the same number is what makes "the fee covers the
 * gas" a structural fact rather than two configurations that agree today.
 *
 * It also means padding here is padding the customer pays, so these are p95
 * figures — comfortably above typical, not above conceivable. The rate floor
 * and the fee buffer each add their own margin on top; stacking a third would
 * triple a fee to guard against the same event once.
 */
export const LIVE_GAS_COSTS: GasCostTable = {
	// ERC-20 transfer ≈ 65k gas. p95 gas price ~40 gwei → 0.0026 ETH.
	"USDT.ERC20": { perWithdrawal: 2_600_000_000_000_000n, floor: 15_000_000_000_000_000n },
	"USDC.ERC20": { perWithdrawal: 2_600_000_000_000_000n, floor: 15_000_000_000_000_000n },
	/*
	 * TRC-20 transfers burn ENERGY, which an unstaked account buys with TRX at
	 * roughly 30 TRX a transfer. Staking TRX for energy cuts this to nearly
	 * nothing and is the single biggest fee reduction available to this venue —
	 * worth doing, and worth re-deriving this number afterwards rather than
	 * leaving customers paying for energy we no longer buy.
	 */
	"USDT.TRC20": { perWithdrawal: 30_000_000n, floor: 150_000_000n },
	"USDC.TRC20": { perWithdrawal: 30_000_000n, floor: 150_000_000n },
	// SPL transfer: a signature (5k lamports) plus ~0.00204 SOL of rent for an
	// associated token account the first time a destination is seen. Budget for
	// the account, since we cannot know in advance whether it exists.
	"USDT.SOL": { perWithdrawal: 2_100_000n, floor: 20_000_000n },
	"USDC.SOL": { perWithdrawal: 2_100_000n, floor: 20_000_000n },
	// BEP-20 transfer ≈ 65k gas at ~3 gwei.
	"USDT.BEP20": { perWithdrawal: 200_000_000_000_000n, floor: 1_000_000_000_000_000n },
};

export interface GasVerdict {
	/** False means the withdrawal must be refused. */
	readonly ok: boolean;
	/** The gas asset, e.g. "ETH". Equal to the withdrawn asset when self-funding. */
	readonly gasAsset: string;
	/** Gas needed for this withdrawal plus everything already committed. */
	readonly required: bigint;
	/** The venue's own claim on the gas asset: the FEES balance. */
	readonly ownedFloat: bigint;
	/** Gas that physically exists in custody. */
	readonly custodyHeld: bigint;
	/** How many pending withdrawals this chain's gas is already spoken for by. */
	readonly committedWithdrawals: number;
	/** Why, when refused. Empty when ok. */
	readonly reason: string;
	/** True when gas and the withdrawn asset are the same coin. */
	readonly selfFunding: boolean;
}

export interface GasGateDeps {
	readonly ledger: Ledger;
	/**
	 * How many withdrawals over this chain are already accepted and unsent.
	 *
	 * Each of those will burn gas before this one does, so ignoring them lets a
	 * burst of withdrawals each individually pass a check that the batch as a
	 * whole fails. Injected rather than queried here so this file does not need
	 * the withdrawal schema.
	 */
	readonly pendingOnChain: (asset: string, network: string | undefined) => number;
	readonly table?: GasCostTable;
}

/**
 * Can we pay the gas to send this withdrawal?
 *
 * Returns a verdict rather than throwing, because the caller composes it with
 * the liquidity gate and wants to report both.
 */
export function checkGas(
	args: { asset: string; network: string | undefined },
	deps: GasGateDeps,
): GasVerdict {
	const { asset, network } = args;
	const table = deps.table ?? LIVE_GAS_COSTS;

	let gasAsset: string;
	try {
		gasAsset = gasAssetFor(asset, network);
	} catch (e) {
		return refuse(
			asset,
			asset,
			`cannot determine which asset pays gas for ${asset}` +
				(network === undefined ? "" : ` on ${network}`) +
				`: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// SELF-FUNDING CHAINS NEED NO FLOAT. A BTC withdrawal's fee is taken out of
	// the BTC being sent, so the holding that pays the gas is the same holding
	// the liquidity check already verified. Gating it again on a separate float
	// would refuse withdrawals for want of a balance that does not need to
	// exist.
	if (gasAsset === asset) {
		return {
			ok: true,
			gasAsset,
			required: 0n,
			ownedFloat: 0n,
			custodyHeld: 0n,
			committedWithdrawals: 0,
			reason: "",
			selfFunding: true,
		};
	}

	const key = network === undefined ? asset : `${asset}.${network}`;
	const cost = table[key];
	if (cost === undefined) {
		// FAIL CLOSED. A newly-listed token with no gas budget is a token we do
		// not know the cost of sending, and guessing is how a float runs dry.
		return refuse(
			asset,
			gasAsset,
			`${key} has no gas budget configured. It pays gas in ${gasAsset}, and ` +
				"until we know how much, withdrawals over this chain cannot be " +
				"accepted — a wrong guess means accepting a withdrawal we cannot send.",
		);
	}
	if (cost.perWithdrawal <= 0n || cost.floor < 0n) {
		return refuse(asset, gasAsset, `${key} has a nonsensical gas budget`);
	}

	let pending: number;
	let ownedFloat: bigint;
	let custodyHeld: bigint;
	try {
		pending = deps.pendingOnChain(asset, network);
		if (!Number.isInteger(pending) || pending < 0) {
			throw new GasGateError(`pendingOnChain returned ${pending}`);
		}
		// The venue's own claim on the gas asset.
		ownedFloat = deps.ledger.balance({
			kind: AccountKind.FEES,
			owner: "",
			asset: gasAsset,
		});
		// And whether the coins exist. Summed across networks because a gas
		// asset may itself be multi-network in principle; today they are not.
		custodyHeld = 0n;
		for (const v of deps.ledger.custodyByNetwork(gasAsset).values()) {
			custodyHeld += v;
		}
	} catch (e) {
		// A GATE THAT CANNOT READ ITS INPUTS REFUSES. Treating an unreadable
		// balance as "probably fine" is how the float goes negative.
		return refuse(
			asset,
			gasAsset,
			`cannot establish the ${gasAsset} gas position ` +
				`(${e instanceof Error ? e.message : String(e)}), so this withdrawal ` +
				"cannot be accepted",
		);
	}

	// This withdrawal plus the ones already queued ahead of it, plus headroom.
	const required = cost.perWithdrawal * BigInt(pending + 1) + cost.floor;
	const u = unitOf(gasAsset);
	const base = {
		gasAsset,
		required,
		ownedFloat,
		custodyHeld,
		committedWithdrawals: pending,
		selfFunding: false,
	};

	if (ownedFloat < required) {
		return {
			...base,
			ok: false,
			reason:
				`${asset} withdrawals over ${network ?? "this chain"} are paused: ` +
				`sending the token costs ${gasAsset}, and our ${gasAsset} gas float ` +
				`is ${format(ownedFloat, u)} against the ${format(required, u)} ` +
				`needed for this withdrawal plus ${pending} already queued. ` +
				`Another chain may be available, or try again once the float is ` +
				`topped up.`,
		};
	}
	if (custodyHeld < required) {
		// The claim exists but the coin does not. Distinct message, because the
		// fix is different: this one is a treasury transfer into custody, not a
		// credit.
		return {
			...base,
			ok: false,
			reason:
				`${asset} withdrawals over ${network ?? "this chain"} are paused: ` +
				`we are owed ${format(ownedFloat, u)} ${gasAsset} of gas float but ` +
				`only ${format(custodyHeld, u)} ${gasAsset} is actually in custody, ` +
				`against ${format(required, u)} needed.`,
		};
	}

	return { ...base, ok: true, reason: "" };
}

function refuse(asset: string, gasAsset: string, reason: string): GasVerdict {
	return {
		ok: false,
		gasAsset,
		required: 0n,
		ownedFloat: 0n,
		custodyHeld: 0n,
		committedWithdrawals: 0,
		reason,
		selfFunding: false,
	};
}

function unitOf(asset: string): AssetUnit {
	try {
		return { symbol: asset, decimals: assetDef(asset).decimals };
	} catch {
		// An unregistered gas asset should be impossible — gasAssetFor resolves
		// from the same registry — but formatting must not be the thing that
		// throws inside a refusal path.
		return { symbol: asset, decimals: 0 };
	}
}

/**
 * The gas position per chain, for the admin page and the public status view.
 *
 * `runway` is the number of withdrawals the float can still pay for after the
 * floor is respected. That is the figure an operator actually needs: "0.9 ETH"
 * means nothing without knowing what a send costs, and "11 more withdrawals"
 * means everything.
 */
export function gasPositions(deps: GasGateDeps): readonly {
	chain: string;
	asset: string;
	network: string | undefined;
	gasAsset: string;
	float: string;
	custody: string;
	perWithdrawal: string;
	floor: string;
	runway: number;
	healthy: boolean;
}[] {
	const table = deps.table ?? LIVE_GAS_COSTS;
	const out: {
		chain: string;
		asset: string;
		network: string | undefined;
		gasAsset: string;
		float: string;
		custody: string;
		perWithdrawal: string;
		floor: string;
		runway: number;
		healthy: boolean;
	}[] = [];

	for (const key of Object.keys(table)) {
		const asset = settlementAsset(key);
		const network = key === asset ? undefined : key.slice(asset.length + 1);
		const cost = table[key]!;
		const v = checkGas({ asset, network }, deps);
		const u = unitOf(v.gasAsset);
		const spendable =
			(v.ownedFloat < v.custodyHeld ? v.ownedFloat : v.custodyHeld) - cost.floor;
		const runway =
			spendable <= 0n ? 0 : Number(spendable / cost.perWithdrawal);
		out.push({
			chain: key,
			asset,
			network,
			gasAsset: v.gasAsset,
			float: format(v.ownedFloat, u),
			custody: format(v.custodyHeld, u),
			perWithdrawal: format(cost.perWithdrawal, u),
			floor: format(cost.floor, u),
			runway,
			healthy: v.ok,
		});
	}
	return out;
}
