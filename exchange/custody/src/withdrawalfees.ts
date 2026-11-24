// -----------------------------------------------------------------------------
// WITHDRAWAL FEES — the venue charges enough to cover gas and make a margin.
//
// A withdrawal costs the venue real money: the chain takes a fee out of custody
// every single time, whether or not we charged for it. A venue that pays that
// out of its own pocket is subsidising withdrawals, and the subsidy scales with
// exactly the behaviour that is cheapest to abuse — deposit, withdraw, repeat.
// So the fee is not optional and it is not cosmetic.
//
// THREE THINGS THIS FILE HAS TO GET RIGHT, in descending order of how much they
// cost if they are wrong:
//
// 1. THE FEE IS DENOMINATED IN THE ASSET WITHDRAWN; THE GAS IS NOT.
//
//    Sending USDT over Ethereum costs ETH. We charge the customer in USDT —
//    because charging them in ETH would require them to hold ETH they never
//    asked for — and we spend ETH. Those are different assets and they DO NOT
//    NET within one asset's books. The configured `gas` figure below is
//    therefore "what this chain's fee costs, expressed in the withdrawn asset
//    at the time an operator configured it". It is an estimate converted at a
//    stale price, and nothing here pretends otherwise.
//
//    The honest consequence: whether the fee actually covered the gas is a
//    question about two different ledgers, answerable only by comparing fee
//    revenue in USDT against gas spent in ETH. revenue.ts reports both, side by
//    side, and deliberately does not add them into one number.
//
// 2. A GAS SPIKE MUST NOT TURN A FEE INTO A LOSS. Chain fees move by an order
//    of magnitude in an hour. `gasBufferBps` is the headroom; the margin sits
//    on top of the buffered figure, not of the raw estimate, so a busy day eats
//    the buffer and not the profit.
//
// 3. THE FEE COMES OUT OF THE AMOUNT, NOT ON TOP OF IT.
//
//    "Withdraw 100 USDT" debits 100 and sends 100 − fee. The alternative —
//    debiting 100 + fee — fails whenever a customer withdraws their whole
//    balance, which is the single most common withdrawal there is. Taking it
//    from the amount can never fail for want of an extra balance, which is the
//    same reason trading fees come out of each side's proceeds (see fees.ts).
//
// AND ONE REFUSAL. If the fee would eat more than half of what the customer
// asked for, the withdrawal is REFUSED rather than processed. We could happily
// take it — it is the most profitable withdrawal on the book — but a customer
// who pays 60% to move 10 USDT has been treated badly, and "we told you in the
// confirmation" is not a defence. They are told the minimum instead.
// -----------------------------------------------------------------------------

import { format, type AssetUnit } from "./amount";
import { assetDef, gasAssetFor, networkOf, settlementAsset } from "./assets";
import { LIVE_GAS_COSTS, type GasCostTable } from "./gasgate";
import {
	convertCeil,
	worstRate,
	GAS_PRICE_FLOOR,
	StaticRates,
	type RateSource,
} from "./gasrates";

/** The unit `format` needs, built from the registry rather than passed around. */
const unit = (asset: string): AssetUnit => ({
	symbol: asset,
	decimals: assetDef(asset).decimals,
});

export class WithdrawalFeeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WithdrawalFeeError";
	}
}

/** What one withdrawal over one chain costs, and what we add to it. */
export interface NetworkFeeConfig {
	/**
	 * A FLOOR on the gas allowance, in base units of the withdrawn asset.
	 *
	 * For a self-funding chain (BTC paying its fee in BTC) this IS the gas
	 * allowance — there is no cross-asset conversion to do.
	 *
	 * For a token it is only a floor. The allowance actually charged is derived
	 * from the chain's gas budget and a live rate, so it tracks the cost instead
	 * of drifting away from it; this figure stops the fee collapsing to nothing
	 * if a price source reports an implausibly cheap gas asset.
	 */
	readonly gas: bigint;
	/**
	 * Headroom over the gas estimate, in basis points. 5_000 = +50%.
	 *
	 * This is what a fee survives a congested chain on. Set it to zero and the
	 * first busy hour is paid for out of margin.
	 */
	readonly gasBufferBps: number;
	/** The venue's flat margin per withdrawal, in base units. THE PROFIT. */
	readonly margin: bigint;
	/**
	 * Optional proportional margin on the amount, in basis points.
	 *
	 * Zero for most assets: a withdrawal costs the same to send whether it
	 * carries 10 or 10,000, so charging by size is charging for nothing. Kept
	 * because it is the normal lever for assets where size genuinely does cost
	 * more (UTXO consolidation on a busy BTC day).
	 */
	readonly marginBps: number;
	/**
	 * DELIBERATELY FREE OR BELOW COST — the venue pays the gas.
	 *
	 * Required to configure a zero margin, which is otherwise refused: a fee
	 * with no margin is a standing commitment to lose money on every
	 * withdrawal, and that must be a decision somebody wrote down rather than a
	 * missing field. Free withdrawals as a promotion are a legitimate reason to
	 * write it down.
	 *
	 * It does NOT suppress the accounting. `gasCoverage` still reports the chain
	 * as uncovered and the admin page still shows the loss, because a subsidy
	 * you cannot see the cost of is indistinguishable from a bug.
	 */
	readonly subsidised?: boolean;
}

export type FeeTable = Readonly<Record<string, NetworkFeeConfig>>;

/**
 * Key for the fee table: the qualified asset id, so each chain is priced
 * separately. `USDT.ERC20` and `USDT.TRC20` are not remotely the same cost.
 */
export function feeKey(asset: string, network: string | undefined): string {
	return network === undefined ? asset : `${asset}.${network}`;
}

/**
 * Minimum fraction of the requested amount the customer must actually receive,
 * in basis points. 5_000 = they keep at least half.
 *
 * See the refusal note in the header. This is a floor on fairness, not on
 * revenue.
 */
export const MIN_NET_SHARE_BPS = 5_000;

/**
 * Everything needed to price a token's gas in the asset being withdrawn.
 *
 * Injected rather than read from module state so a test can pin a rate, and so
 * the admin page can quote the same chain at a hypothetical price without
 * touching the live configuration.
 */
export interface GasPricing {
	/** Gas budget per withdrawal, in the GAS ASSET's base units. */
	readonly gasTable?: GasCostTable;
	/** Rate sources, worst-of. Defaults to the configured policy floor alone. */
	readonly sources?: readonly RateSource[];
	readonly now?: number;
	readonly maxAgeMs?: number;
}

/** The policy-floor-only pricing used when no live source is supplied. */
export const FLOOR_PRICING: GasPricing = {
	sources: [new StaticRates(GAS_PRICE_FLOOR)],
};

export interface WithdrawalQuote {
	readonly asset: string;
	readonly network: string | undefined;
	/** What the customer asked for, and what is debited. */
	readonly amount: bigint;
	/** Total fee withheld. */
	readonly fee: bigint;
	/** What actually goes on chain. `amount - fee`. */
	readonly net: bigint;
	/** The breakdown, because an unexplained fee reads as an arbitrary one. */
	readonly gasAllowance: bigint;
	readonly margin: bigint;
	/** Which asset the gas will really be spent in. */
	readonly gasAsset: string;
	/**
	 * Gas budgeted for this send, in the GAS ASSET's base units, and the rate
	 * the allowance was computed at. Zero/undefined on a self-funding chain.
	 *
	 * Carried on the quote so that the one number that decides whether we make
	 * or lose money on this withdrawal is auditable after the fact, rather than
	 * being an intermediate value nobody kept.
	 */
	readonly gasBudget: bigint;
	readonly rateUsed:
		| { readonly price: string; readonly source: string; readonly asOf: number }
		| undefined;
	/** Smallest amount that passes the half-share rule, for the error text. */
	readonly minimum: bigint;
	/** Customer-facing wording. Decimal strings, never floats. */
	readonly display: {
		readonly amount: string;
		readonly fee: string;
		readonly net: string;
		readonly minimum: string;
		readonly note: string;
	};
}

/**
 * Quote a withdrawal.
 *
 * FAILS CLOSED on an unpriced chain. A newly-listed asset with no fee entry
 * must not be withdrawable for free — that is a direct, automated drain on the
 * venue, and since withdrawals need no human approval nobody would notice until
 * the gas bill arrived.
 */
export function quoteWithdrawal(args: {
	asset: string;
	network: string | undefined;
	amount: bigint;
	table: FeeTable;
	/** Gas pricing. Defaults to the configured policy floor. */
	pricing?: GasPricing;
}): WithdrawalQuote {
	const { asset, network, amount, table } = args;
	const pricing = args.pricing ?? FLOOR_PRICING;

	if (settlementAsset(asset) !== asset || networkOf(asset) !== undefined) {
		throw new WithdrawalFeeError(
			`quote the settlement asset and the network separately, not "${asset}"`,
		);
	}
	if (amount <= 0n) {
		throw new WithdrawalFeeError("a withdrawal amount must be positive");
	}

	const key = feeKey(asset, network);
	const cfg = table[key];
	if (cfg === undefined) {
		throw new WithdrawalFeeError(
			`${key} has no withdrawal fee configured, so it cannot be withdrawn. ` +
				"Every chain must be priced before it pays out — an unpriced chain " +
				"would send at our expense, automatically and unnoticed.",
		);
	}
	assertSane(key, cfg);

	const u = unit(asset);
	const gasAsset = gasAssetFor(asset, network);

	// THE GAS ALLOWANCE. For a cross-asset chain this is derived from the gas
	// budget at a live rate, so that it is by CONSTRUCTION at least the cost of
	// the gas rather than a figure we hope still covers it.
	const priced = priceGas(asset, network, gasAsset, cfg, pricing);
	const gasAllowance = priced.allowance;
	const proportional = (amount * BigInt(cfg.marginBps)) / 10_000n;
	const margin = cfg.margin + proportional;
	const fee = gasAllowance + margin;

	// The smallest amount where the customer still keeps MIN_NET_SHARE_BPS.
	//   net >= amount * share  <=>  amount - fee >= amount * share
	// With a proportional component the fee itself grows with the amount, so
	// solve for it rather than dividing a fixed fee:
	//   amount*(1 - share - marginBps) >= gasAllowance + flatMargin
	const scale = 10_000n - BigInt(MIN_NET_SHARE_BPS) - BigInt(cfg.marginBps);
	if (scale <= 0n) {
		// Only reachable with a proportional margin at or above the share floor,
		// which assertSane already refuses. Kept as a belt-and-braces guard: a
		// division by a non-positive scale would silently produce a nonsense
		// minimum and let through withdrawals that are almost all fee.
		throw new WithdrawalFeeError(
			`${key}: marginBps ${cfg.marginBps} leaves no room for the ` +
				`${MIN_NET_SHARE_BPS / 100}% minimum net share`,
		);
	}
	const base = gasAllowance + cfg.margin;
	// Ceiling division, so the minimum itself passes the rule rather than
	// landing one unit under it.
	const minimum = (base * 10_000n + scale - 1n) / scale;

	if (amount < minimum) {
		throw new WithdrawalFeeError(
			`the ${format(fee, u)} ${asset} ${label(network)}fee would take ` +
				`more than half of ${format(amount, u)} ${asset}. The minimum ` +
				`withdrawal on this chain is ${format(minimum, u)} ${asset}` +
				suggestion(asset, network, table, u),
		);
	}

	const net = amount - fee;
	// Unreachable given the minimum check above; asserted because a zero or
	// negative send is the one outcome that must never reach the custodian.
	if (net <= 0n) {
		throw new WithdrawalFeeError(
			`internal: fee ${fee} >= amount ${amount} for ${key}`,
		);
	}

	const f = (v: bigint): string => format(v, u);
	return {
		asset,
		network,
		amount,
		fee,
		net,
		gasAllowance,
		margin,
		gasAsset,
		gasBudget: priced.budget,
		rateUsed: priced.rateUsed,
		minimum,
		display: {
			amount: f(amount),
			fee: f(fee),
			net: f(net),
			minimum: f(minimum),
			note:
				`You will receive ${f(net)} ${asset}. The ${f(fee)} ${asset} fee is ` +
				`withheld from the amount, not charged separately — ${f(gasAllowance)} ` +
				`covers the ${label(network)}network cost (paid in ${gasAsset}) and ` +
				`${f(margin)} is our fee.`,
		},
	};
}

/**
 * THE CORE OF THE "NEVER SPEND MORE ON GAS THAN WE TAKE IN" GUARANTEE.
 *
 * For a cross-asset chain the allowance is
 *
 *     ceil(gasBudget converted at the worst available rate) × (1 + buffer)
 *
 * and the fee is that allowance plus a strictly positive margin. So
 *
 *     fee  >  allowance  >=  cost of the budgeted gas
 *
 * holds by CONSTRUCTION, for every quote, with no reliance on a configured
 * figure being up to date. There is no path through this function that returns
 * an allowance below the converted gas cost: the conversion rounds up, the
 * buffer only adds, and the configured floor is applied with `max`, never as a
 * substitute.
 *
 * The residual risks are named rather than papered over:
 *
 *   * THE RATE COULD BE WRONG. Mitigated by taking the worst of every source,
 *     requiring freshness, and keeping a deliberately-high configured floor.
 *   * GAS COULD EXCEED THE BUDGET. Mitigated by budgeting generously and by the
 *     buffer; detected by revenue.ts, which compares gas actually spent against
 *     fees actually earned.
 *   * THE PRICE COULD MOVE BETWEEN QUOTE AND SEND. That window is the buffer's
 *     entire purpose.
 *
 * UNPRICEABLE MEANS UNWITHDRAWABLE. If no fresh rate exists, this throws, and
 * the chain stops paying out. That is the correct failure: we would not know
 * whether the fee covered the gas, and finding out afterwards means finding out
 * from the books that we lost.
 */
function priceGas(
	asset: string,
	network: string | undefined,
	gasAsset: string,
	cfg: NetworkFeeConfig,
	pricing: GasPricing,
): {
	allowance: bigint;
	budget: bigint;
	rateUsed: { price: string; source: string; asOf: number } | undefined;
} {
	const buffer = (v: bigint): bigint => v + (v * BigInt(cfg.gasBufferBps)) / 10_000n;

	// SELF-FUNDING: the fee is taken out of the same coin the chain burns, so
	// there is nothing to convert and the configured figure is the figure.
	if (gasAsset === asset) {
		return { allowance: buffer(cfg.gas), budget: 0n, rateUsed: undefined };
	}

	// A SUBSIDISED CHAIN NEEDS NO RATE. We have already decided to pay the gas,
	// so there is nothing to price and no coverage to prove. Still priced off
	// the configured floor so a partial subsidy charges what it says it does.
	if (cfg.subsidised === true) {
		return { allowance: buffer(cfg.gas), budget: 0n, rateUsed: undefined };
	}

	const key = feeKey(asset, network);
	const gasTable = pricing.gasTable ?? LIVE_GAS_COSTS;
	const budget = gasTable[key]?.perWithdrawal;
	if (budget === undefined || budget <= 0n) {
		throw new WithdrawalFeeError(
			`${key} pays gas in ${gasAsset} but has no gas budget configured, so ` +
				"the fee cannot be shown to cover the cost of sending. Withdrawals " +
				"over this chain are refused until it is set.",
		);
	}

	const sources = pricing.sources ?? [new StaticRates(GAS_PRICE_FLOOR)];
	const rate = worstRate(gasAsset, asset, sources, {
		now: pricing.now,
		maxAgeMs: pricing.maxAgeMs,
	});
	if (rate === undefined) {
		throw new WithdrawalFeeError(
			`no fresh ${gasAsset}/${asset} rate is available, so the gas cost of a ` +
				`${key} withdrawal cannot be priced. Rather than guess — and risk ` +
				"paying more in gas than we charge — withdrawals over this chain are " +
				"refused until a rate is available.",
		);
	}

	const converted = convertCeil(budget, rate);
	const derived = buffer(converted);
	// The configured floor is a FLOOR, applied with max. Using it as an
	// alternative — "configured OR derived" — is how a cheap-looking rate turns
	// into a fee below cost.
	const floor = buffer(cfg.gas);
	const allowance = derived > floor ? derived : floor;

	return {
		allowance,
		budget,
		rateUsed: {
			// num is already in the target asset's base units per whole source
			// unit, so it formats directly as the price.
			price: format(rate.num, unit(asset)),
			source: rate.source,
			asOf: rate.asOf,
		},
	};
}

/**
 * Prove, for one chain, that the fee covers the gas — with the arithmetic shown.
 *
 * This is what the admin page renders and what the test suite asserts over every
 * configured chain. A structural guarantee that nobody can read is a guarantee
 * nobody will maintain.
 */
export function gasCoverage(args: {
	asset: string;
	network: string | undefined;
	table?: FeeTable;
	pricing?: GasPricing;
	/** Amount to quote at; defaults to the chain's minimum. */
	amount?: bigint;
}): {
	chain: string;
	gasAsset: string;
	selfFunding: boolean;
	/** Intentionally below cost. See NetworkFeeConfig.subsidised. */
	subsidised: boolean;
	covered: boolean;
	/** Gas cost in the withdrawn asset at the rate used. */
	gasCost: string;
	gasAllowance: string;
	margin: string;
	fee: string;
	/** allowance − gasCost: the cushion before a withdrawal loses money. */
	headroom: string;
	rate: string;
	rateSource: string;
	note: string;
} {
	const table = args.table ?? LIVE_FEES;
	const asset = args.asset;
	const network = args.network;
	const chain = feeKey(asset, network);
	const u = unit(asset);
	const cfg = table[chain];
	if (cfg === undefined) throw new WithdrawalFeeError(`${chain} is not priced`);

	const gasAsset = gasAssetFor(asset, network);
	const pricing = args.pricing ?? FLOOR_PRICING;
	const priced = priceGas(asset, network, gasAsset, cfg, pricing);
	const selfFunding = gasAsset === asset;

	// On a self-funding chain the "gas cost" is the unbuffered configured
	// figure; on a token chain it is the converted budget.
	const subsidised = cfg.subsidised === true;
	const gasCost = selfFunding || subsidised
		? cfg.gas
		: convertCeil(
				priced.budget,
				worstRate(gasAsset, asset, pricing.sources ?? [new StaticRates(GAS_PRICE_FLOOR)], {
					now: pricing.now,
					maxAgeMs: pricing.maxAgeMs,
				})!,
			);

	const amount = args.amount ?? 0n;
	const proportional = (amount * BigInt(cfg.marginBps)) / 10_000n;
	const margin = cfg.margin + proportional;
	const fee = priced.allowance + margin;
	const headroom = priced.allowance - gasCost;

	return {
		chain,
		gasAsset,
		selfFunding,
		subsidised,
		// The inequality, evaluated rather than asserted in prose. A subsidised
		// chain is NOT reported as covered — it is a loss we chose, and calling
		// it covered would hide the one thing an operator needs to see.
		covered: !subsidised && headroom >= 0n && margin > 0n,
		gasCost: format(gasCost, u),
		gasAllowance: format(priced.allowance, u),
		margin: format(margin, u),
		fee: format(fee, u),
		headroom: format(headroom, u),
		rate: priced.rateUsed?.price ?? "—",
		rateSource: priced.rateUsed?.source ?? (selfFunding ? "self-funding" : "—"),
		note: subsidised
			? `DELIBERATELY SUBSIDISED: ${chain} charges ${format(fee, u)} against ` +
				`a ${format(gasCost, u)} cost, so the venue pays the difference on ` +
				"every withdrawal. Intentional, and still a loss."
			: selfFunding
			? `${asset} pays its own network fee, so the fee and the cost are in ` +
				"the same asset and no conversion is involved."
			: `Sending ${asset} on ${network} burns ${gasAsset}. We budget ` +
				`${priced.budget} base units of ${gasAsset}, price it at ` +
				`${priced.rateUsed?.price ?? "?"} ${asset} per ${gasAsset} from ` +
				`${priced.rateUsed?.source ?? "?"}, add ${cfg.gasBufferBps / 100}% ` +
				`headroom, then add our margin on top.`,
	};
}

/** The coverage proof for every configured chain. Red rows are losses. */
export function auditGasCoverage(
	table: FeeTable = LIVE_FEES,
	pricing: GasPricing = FLOOR_PRICING,
): readonly ReturnType<typeof gasCoverage>[] {
	const out: ReturnType<typeof gasCoverage>[] = [];
	for (const key of Object.keys(table)) {
		const asset = settlementAsset(key);
		const network = networkOf(key);
		try {
			out.push(gasCoverage({ asset, network, table, pricing }));
		} catch (e) {
			out.push({
				chain: key,
				gasAsset: "?",
				selfFunding: false,
				subsidised: false,
				covered: false,
				gasCost: "—",
				gasAllowance: "—",
				margin: "—",
				fee: "—",
				headroom: "—",
				rate: "—",
				rateSource: "—",
				note: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return out;
}

/**
 * Refuse a nonsensical fee configuration at the point of use.
 *
 * Checked on every quote rather than once at startup, because the table is
 * plain data that an operator edits and a typo in it moves money. A zero margin
 * in particular is caught here: it looks like a generous setting and is in fact
 * a standing promise to lose money on every busy-chain withdrawal.
 */
function assertSane(key: string, cfg: NetworkFeeConfig): void {
	if (cfg.gas < 0n || cfg.margin < 0n) {
		throw new WithdrawalFeeError(`${key}: negative fee components`);
	}
	if (cfg.gasBufferBps < 0 || !Number.isInteger(cfg.gasBufferBps)) {
		throw new WithdrawalFeeError(`${key}: gasBufferBps must be a whole number ≥ 0`);
	}
	if (cfg.marginBps < 0 || !Number.isInteger(cfg.marginBps)) {
		throw new WithdrawalFeeError(`${key}: marginBps must be a whole number ≥ 0`);
	}
	if (cfg.margin === 0n && cfg.marginBps === 0 && cfg.subsidised !== true) {
		throw new WithdrawalFeeError(
			`${key}: the fee has no margin — it only reimburses gas, and a stale ` +
				"gas estimate then makes every withdrawal a loss. Set margin or " +
				"marginBps, or set subsidised: true to say that the loss is " +
				"intentional.",
		);
	}
	if (cfg.marginBps >= 10_000 - MIN_NET_SHARE_BPS) {
		throw new WithdrawalFeeError(
			`${key}: marginBps ${cfg.marginBps} would breach the ` +
				`${MIN_NET_SHARE_BPS / 100}% minimum net share on every withdrawal`,
		);
	}
}

const label = (network: string | undefined): string =>
	network === undefined ? "" : `${network} `;

/**
 * When a chain's minimum is too high, name a cheaper one.
 *
 * A bare "minimum is 20 USDT" leaves someone with 15 USDT stuck, when Tron
 * would have sent it for a fraction of the cost. Telling them is the difference
 * between a refusal and a dead end.
 */
function suggestion(
	asset: string,
	network: string | undefined,
	table: FeeTable,
	u: AssetUnit,
): string {
	if (network === undefined) return ".";
	let best: { net: string; min: bigint } | undefined;
	for (const n of assetDef(asset).networks) {
		if (n.id === network) continue;
		const cfg = table[feeKey(asset, n.id)];
		if (cfg === undefined) continue;
		const gasAllowance = cfg.gas + (cfg.gas * BigInt(cfg.gasBufferBps)) / 10_000n;
		const scale = 10_000n - BigInt(MIN_NET_SHARE_BPS) - BigInt(cfg.marginBps);
		if (scale <= 0n) continue;
		const min = ((gasAllowance + cfg.margin) * 10_000n + scale - 1n) / scale;
		if (best === undefined || min < best.min) best = { net: n.id, min };
	}
	if (best === undefined) return ".";
	return `. ${best.net} is cheaper: ${format(best.min, u)} ${asset} minimum.`;
}

/**
 * Fee table for the live venue.
 *
 * The gas figures are deliberately GENEROUS rather than tight. Being 30% over
 * on a $0.80 Ethereum fee costs a customer a quarter; being 30% under on a
 * congested day costs us the difference on every withdrawal that hour, and
 * nobody is watching because withdrawals are automatic.
 *
 * Margins are flat per withdrawal because that is what the cost actually is.
 */
export const LIVE_FEES: FeeTable = {
	/*
	 * TOKENS. `gas` here is only a collapse floor — the allowance charged is
	 * derived from the chain's gas budget at a live rate (see priceGas), so
	 * these entries do not need maintaining as gas prices move. The buffer is
	 * 20%: the budget is already p95 and the rate source is already biased
	 * high, so this covers movement between quoting and sending, nothing more.
	 */
	"USDT.TRC20": { gas: 1_000_000n, gasBufferBps: 2_000, margin: 1_000_000n, marginBps: 0 },
	"USDT.ERC20": { gas: 2_000_000n, gasBufferBps: 2_000, margin: 2_000_000n, marginBps: 0 },
	"USDT.SOL": { gas: 200_000n, gasBufferBps: 2_000, margin: 500_000n, marginBps: 0 },
	"USDT.BEP20": { gas: 200_000n, gasBufferBps: 2_000, margin: 500_000n, marginBps: 0 },
	"USDC.ERC20": { gas: 2_000_000n, gasBufferBps: 2_000, margin: 2_000_000n, marginBps: 0 },
	"USDC.SOL": { gas: 200_000n, gasBufferBps: 2_000, margin: 500_000n, marginBps: 0 },
	"USDC.TRC20": { gas: 1_000_000n, gasBufferBps: 2_000, margin: 1_000_000n, marginBps: 0 },

	/*
	 * SELF-FUNDING CHAINS. No conversion is involved — the fee and the cost are
	 * the same coin — so `gas` is the real estimate and has to be maintained.
	 * The buffer is wider here for exactly that reason.
	 */
	// BTC, 8 decimals. ~3k sat for a 1-in-2-out send at 15 sat/vB. The
	// proportional component is for a large send that must consolidate inputs,
	// which genuinely does cost more.
	BTC: { gas: 3_000n, gasBufferBps: 5_000, margin: 2_000n, marginBps: 2 },
	// ETH, 18 decimals. 21k gas at ~28 gwei.
	ETH: { gas: 600_000_000_000_000n, gasBufferBps: 5_000, margin: 300_000_000_000_000n, marginBps: 0 },
	SOL: { gas: 10_000n, gasBufferBps: 10_000, margin: 5_000_000n, marginBps: 0 },
	TRX: { gas: 1_100_000n, gasBufferBps: 5_000, margin: 1_000_000n, marginBps: 0 },
	BNB: { gas: 105_000_000_000_000n, gasBufferBps: 5_000, margin: 50_000_000_000_000n, marginBps: 0 },
	DOGE: { gas: 100_000_000n, gasBufferBps: 5_000, margin: 100_000_000n, marginBps: 0 },
	XRP: { gas: 12_000n, gasBufferBps: 5_000, margin: 100_000n, marginBps: 0 },
	// BLOCK and PERBUG are our own chains, so gas is negligible and the margin
	// is the entire point of the fee.
	BLOCK: { gas: 100_000n, gasBufferBps: 5_000, margin: 1_000_000n, marginBps: 0 },
	PERBUG: { gas: 100_000n, gasBufferBps: 5_000, margin: 1_000_000n, marginBps: 0 },
};

/**
 * Public fee-schedule disclosure, for the fees page and the withdraw ticket.
 *
 * PRICED THE SAME WAY THE REAL FEE IS. The first version of this computed the
 * allowance from `cfg.gas` — the collapse floor — because it had no rate
 * source to hand. It therefore published 2.20 USDT for a TRC-20 withdrawal
 * that would actually be charged around 13, which is precisely the kind of
 * quietly-wrong number a published schedule exists to prevent. It now calls
 * the same `priceGas` the charge goes through.
 *
 * A chain that cannot be priced is marked UNAVAILABLE rather than quoted
 * cheaply. It cannot be withdrawn over either, so saying so is just accurate.
 */
export function discloseWithdrawalFees(
	table: FeeTable = LIVE_FEES,
	pricing: GasPricing = FLOOR_PRICING,
): readonly {
	asset: string;
	network: string | undefined;
	fee: string;
	minimum: string;
	gasAsset: string;
	available: boolean;
	plusBps?: number;
	note?: string;
}[] {
	const out: {
		asset: string;
		network: string | undefined;
		fee: string;
		minimum: string;
		gasAsset: string;
		available: boolean;
		plusBps?: number;
		note?: string;
	}[] = [];

	for (const key of Object.keys(table)) {
		const asset = settlementAsset(key);
		const network = networkOf(key);
		const u = unit(asset);
		const cfg = table[key]!;
		const gasAsset = gasAssetFor(asset, network);

		try {
			assertSane(key, cfg);
			const priced = priceGas(asset, network, gasAsset, cfg, pricing);
			// Solve for the minimum FIRST — the fee grows with the amount
			// wherever there is a proportional component, so the minimum and the
			// fee are mutually dependent — then quote the fee AT that minimum.
			// Quoting `allowance + flat margin` and calling the proportional
			// part negligible is how a published figure ends up a hair under
			// what is charged, which is the same class of error as publishing it
			// wildly under.
			const scale = 10_000n - BigInt(MIN_NET_SHARE_BPS) - BigInt(cfg.marginBps);
			const base = priced.allowance + cfg.margin;
			const minimum = (base * 10_000n + scale - 1n) / scale;
			const fee = base + (minimum * BigInt(cfg.marginBps)) / 10_000n;
			out.push({
				asset,
				network,
				fee: format(fee, u),
				minimum: format(minimum, u),
				gasAsset,
				available: true,
				// Stated rather than left implicit: on these chains a larger
				// withdrawal pays slightly more, because a larger send genuinely
				// costs more to build.
				...(cfg.marginBps > 0 ? { plusBps: cfg.marginBps } : {}),
				...(cfg.subsidised === true
					? { note: "currently subsidised — we are paying the network cost" }
					: {}),
			});
		} catch (e) {
			// Published as unavailable WITH the reason, rather than omitted. A
			// chain missing from the table reads as "not offered"; a chain shown
			// as unavailable reads as "offered, not right now", which is true.
			out.push({
				asset,
				network,
				fee: "—",
				minimum: "—",
				gasAsset,
				available: false,
				note: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return out;
}
