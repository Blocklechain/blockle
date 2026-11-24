// -----------------------------------------------------------------------------
// REVENUE — what the exchange actually earned, and what it cost to earn it.
//
// WHERE THE MONEY IS. Every fee this venue charges lands in a FEES account:
// 0.20% from each side of every trade (fees.ts), and the withheld portion of
// every withdrawal (withdrawalfees.ts). FEES is the venue's own balance. It is
// not a customer's, and it is not an accounting fiction — it is spendable, and
// `sweep()` moves it into an ordinary account that can trade and withdraw like
// any other.
//
// THIS FILE DERIVES THE PROFIT FROM THE LEDGER, AND DERIVES NOTHING ELSE.
//
// There is no revenue table, no running total, no counter incremented on each
// fill. Those drift: a counter that misses a rollback or double-counts a replay
// is wrong forever and nothing contradicts it. The ledger already records every
// fee posting with its reason, immutably and hash-chained, so the profit is a
// query over evidence rather than a number we maintain.
//
// THE SELF-CHECK IS THE POINT.
//
// Every FEES posting is classified into exactly one bucket by its reason. The
// buckets must then sum to the FEES account balance:
//
//     trading + withdrawal − refunds − gas + funding − swept  ==  balance
//
// If they do not, some posting carries a reason this file does not understand,
// and the honest conclusion is that the profit figure is INCOMPLETE — which the
// report says, in those words, rather than quietly reporting a wrong total. A
// financial report whose arithmetic is not checked is a guess with a table
// around it.
//
// WHY THERE IS NO SINGLE PROFIT NUMBER BY DEFAULT.
//
// Fees accrue in the asset traded: BTC from BTC trades, USDT from USDT trades,
// and gas is spent in ETH and TRX. Adding those requires prices, and a price is
// a judgement. So the per-asset figures are EXACT, and the combined total is
// offered separately, explicitly labelled an estimate, with the rate and its
// source attached to each line — and with any asset we cannot price listed as
// unpriced rather than silently treated as zero.
// -----------------------------------------------------------------------------

import { format, type AssetUnit } from "./amount";
import { assetDef, settlementAsset } from "./assets";
import { AccountKind, Reason, type Ledger } from "./ledger";
import {
	convertCeil,
	worstRate,
	type Rate,
	type RateSource,
} from "./gasrates";

import type { Database } from "better-sqlite3";

export class RevenueError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RevenueError";
	}
}

const unit = (asset: string): AssetUnit => {
	try {
		return { symbol: asset, decimals: assetDef(asset).decimals };
	} catch {
		// An asset that has left the registry must still be reportable: its
		// earnings are real whether or not it is still listed.
		return { symbol: asset, decimals: 0 };
	}
};

/** Exact, per-asset. Every figure is base units; the strings are for display. */
export interface AssetRevenue {
	readonly asset: string;
	/** 0.20% maker and taker, from both sides of every fill. */
	readonly tradingFees: bigint;
	/** The withheld portion of withdrawals. */
	readonly withdrawalFees: bigint;
	/** Fees given back when a withdrawal was rejected or failed. */
	readonly withdrawalFeesRefunded: bigint;
	/** Chain fees paid out of our own holding. THE COST OF DOING BUSINESS. */
	readonly gasSpent: bigint;
	/** Treasury money put in. NOT revenue. */
	readonly treasuryFunding: bigint;
	/** Moved out to a spendable account. NOT an expense. */
	readonly swept: bigint;
	/**
	 * trading + withdrawal − refunds − gas. The actual profit on this asset.
	 *
	 * Can be NEGATIVE, and is allowed to be: a chain whose gas outran its fees
	 * is exactly what this report exists to reveal.
	 */
	readonly netProfit: bigint;
	/** What is left sitting in FEES right now. */
	readonly balance: bigint;
	/**
	 * Postings this file could not classify. MUST BE ZERO.
	 *
	 * Non-zero means the profit above is incomplete — see the header.
	 */
	readonly unclassified: bigint;
	readonly display: {
		readonly tradingFees: string;
		readonly withdrawalFees: string;
		readonly gasSpent: string;
		readonly netProfit: string;
		readonly balance: string;
	};
}

export interface RevenueReport {
	readonly from: string | undefined;
	readonly to: string | undefined;
	readonly assets: readonly AssetRevenue[];
	/**
	 * True when every asset classified cleanly and the buckets reconcile to the
	 * balances. False means READ `warnings` BEFORE QUOTING ANY FIGURE.
	 */
	readonly reconciles: boolean;
	readonly warnings: readonly string[];
	readonly generatedAt: string;
}

interface Row {
	asset: string;
	reason: string;
	kind: string;
	delta: string;
}

/**
 * The profit report.
 *
 * `from`/`to` are ISO timestamps bounding the ledger transactions counted.
 * Omitting both reports since inception, which is the figure that matches the
 * FEES balances; a windowed report deliberately does NOT reconcile to the
 * balance, because the balance includes everything before the window. That is
 * stated in the warnings rather than hidden.
 */
export function revenue(
	db: Database,
	ledger: Ledger,
	opts: { from?: string; to?: string } = {},
): RevenueReport {
	const windowed = opts.from !== undefined || opts.to !== undefined;
	const clauses: string[] = [`p.kind = ?`];
	const params: unknown[] = [AccountKind.FEES];
	if (opts.from !== undefined) {
		clauses.push(`t.created_at >= ?`);
		params.push(opts.from);
	}
	if (opts.to !== undefined) {
		clauses.push(`t.created_at <= ?`);
		params.push(opts.to);
	}

	const rows = db
		.prepare(
			`SELECT p.asset AS asset, t.reason AS reason, p.kind AS kind,
			        p.delta AS delta
			   FROM ledger_posting p
			   JOIN ledger_tx t ON t.id = p.tx_id
			  WHERE ${clauses.join(" AND ")}`,
		)
		.all(...params) as Row[];

	interface Acc {
		trading: bigint;
		withdrawal: bigint;
		refunded: bigint;
		gas: bigint;
		funding: bigint;
		swept: bigint;
		unclassified: bigint;
	}
	const zero = (): Acc => ({
		trading: 0n,
		withdrawal: 0n,
		refunded: 0n,
		gas: 0n,
		funding: 0n,
		swept: 0n,
		unclassified: 0n,
	});
	const byAsset = new Map<string, Acc>();

	for (const r of rows) {
		// Settlement asset, so fee revenue on USDT is one line rather than four.
		// Fees are never charged per-chain — they are charged on the fungible
		// balance — but booking a chain-qualified fee is not impossible, and
		// splitting the report by chain would misrepresent one earning as four.
		const key = settlementAsset(r.asset);
		const a = byAsset.get(key) ?? zero();
		const d = BigInt(r.delta);

		switch (r.reason as Reason) {
			case Reason.TRADE:
			case Reason.FEE:
				a.trading += d;
				break;
			case Reason.WITHDRAWAL_REQUEST:
				// The fee withheld at request time.
				a.withdrawal += d;
				break;
			case Reason.WITHDRAWAL_REVERSE:
				// Given back. Stored as a positive "refunded" figure and
				// subtracted, rather than netted into `withdrawal`, so that a
				// venue with heavy withdrawal failures can see that rather than
				// seeing a quietly smaller revenue line.
				a.refunded += -d;
				break;
			case Reason.WITHDRAWAL_SETTLE:
				// Gas, debited from our own holding of the gas asset.
				a.gas += -d;
				break;
			case Reason.TREASURY_FUNDING:
			case Reason.DEPOSIT:
				a.funding += d;
				break;
			case Reason.FEE_SWEEP:
				a.swept += -d;
				break;
			default:
				// ADJUSTMENT, CORRECTION, or anything added later. Deliberately
				// NOT folded into a bucket: an operator adjustment is not
				// revenue, and guessing which bucket it belongs in is how a
				// profit figure becomes fiction.
				a.unclassified += d;
				break;
		}
		byAsset.set(key, a);
	}

	const warnings: string[] = [];
	let reconciles = true;

	const assets: AssetRevenue[] = [];
	for (const [asset, a] of [...byAsset.entries()].sort()) {
		const u = unit(asset);
		const netProfit = a.trading + a.withdrawal - a.refunded - a.gas;
		const balance = ledger.balance({
			kind: AccountKind.FEES,
			owner: "",
			asset,
		});

		// THE SELF-CHECK. Only meaningful since-inception: a windowed report
		// counts a slice of the postings and the balance counts all of them.
		if (!windowed) {
			const expected = netProfit + a.funding - a.swept + a.unclassified;
			if (expected !== balance) {
				reconciles = false;
				warnings.push(
					`${asset}: the classified postings sum to ${format(expected, u)} ` +
						`but the FEES balance is ${format(balance, u)} — a difference ` +
						`of ${format(balance - expected, u)}. The profit figure for ` +
						`${asset} is INCOMPLETE until this is explained.`,
				);
			}
		}
		if (a.unclassified !== 0n) {
			reconciles = false;
			warnings.push(
				`${asset}: ${format(a.unclassified, u)} of fee-account movement ` +
					"carries a reason the revenue report does not classify " +
					"(an operator adjustment or correction). It is excluded from " +
					"profit, so profit understates or overstates by that amount.",
			);
		}
		if (netProfit < 0n) {
			warnings.push(
				`${asset}: NET LOSS of ${format(-netProfit, u)} — gas spent ` +
					`(${format(a.gas, u)}) exceeds fees earned. Raise the fee or ` +
					"reduce the gas budget for the chains that spend this asset.",
			);
		}
		// A BACKSTOP FOR SOMETHING THE LEDGER ALREADY PREVENTS. Internal accounts
		// cannot go negative — a posting that would overdraw FEES is refused, so
		// gas can never actually be paid out of customer holdings. This stays
		// because the check costs nothing and a report that trusts an invariant
		// it does not verify is how an invariant quietly stops holding.
		if (balance < 0n) {
			reconciles = false;
			warnings.push(
				`${asset}: the FEES balance is NEGATIVE (${format(balance, u)}), ` +
					"which the ledger is supposed to make impossible. Either an " +
					"invariant has been bypassed or this database has been edited " +
					"outside the service. Stop accepting withdrawals and investigate.",
			);
		}

		assets.push({
			asset,
			tradingFees: a.trading,
			withdrawalFees: a.withdrawal,
			withdrawalFeesRefunded: a.refunded,
			gasSpent: a.gas,
			treasuryFunding: a.funding,
			swept: a.swept,
			netProfit,
			balance,
			unclassified: a.unclassified,
			display: {
				tradingFees: format(a.trading, u),
				withdrawalFees: format(a.withdrawal, u),
				gasSpent: format(a.gas, u),
				netProfit: format(netProfit, u),
				balance: format(balance, u),
			},
		});
	}

	if (windowed) {
		warnings.push(
			"This is a windowed report, so the figures cover the window while the " +
				"FEES balances cover all time. They are not expected to agree.",
		);
	}

	return {
		from: opts.from,
		to: opts.to,
		assets,
		reconciles,
		warnings,
		generatedAt: new Date().toISOString(),
	};
}

export interface TotalEstimate {
	/** The numeraire everything was converted into, e.g. "USDT". */
	readonly currency: string;
	readonly netProfit: string;
	readonly tradingFees: string;
	readonly withdrawalFees: string;
	readonly gasSpent: string;
	/** Per-asset conversions, so a surprising total can be traced to a rate. */
	readonly lines: readonly {
		asset: string;
		netProfit: string;
		rate: string;
		source: string;
	}[];
	/** Assets with no usable rate. EXCLUDED from the total, not zeroed. */
	readonly unpriced: readonly string[];
	/** Always present. This is an estimate and must read as one. */
	readonly caveat: string;
}

/**
 * One number, for the people who need one number.
 *
 * Converted at whatever rates are available and labelled accordingly. The
 * per-asset report above is the exact one; this exists because "how much did we
 * make" is a reasonable question and refusing to answer it is not helpful.
 *
 * Assets that cannot be priced are LISTED, not dropped silently. A total that
 * quietly omits the asset you earn most in is worse than no total.
 */
export function estimateTotal(
	report: RevenueReport,
	sources: readonly RateSource[],
	currency = "USDT",
): TotalEstimate {
	const u = unit(currency);
	let net = 0n;
	let trading = 0n;
	let withdrawal = 0n;
	let gas = 0n;
	const lines: { asset: string; netProfit: string; rate: string; source: string }[] = [];
	const unpriced: string[] = [];

	// Negative amounts cannot go through convertCeil (it refuses them, on
	// purpose), so convert the magnitude and reapply the sign. Rounding a loss
	// up in magnitude is the conservative direction for a loss, exactly as
	// rounding a cost up is for a cost.
	const conv = (v: bigint, rate: Rate): bigint =>
		v < 0n ? -convertCeil(-v, rate) : convertCeil(v, rate);

	for (const a of report.assets) {
		let rate: Rate | undefined;
		if (a.asset === currency) {
			rate = {
				from: currency,
				to: currency,
				num: 10n ** BigInt(u.decimals),
				den: 10n ** BigInt(u.decimals),
				asOf: Number.MAX_SAFE_INTEGER,
				source: "identity",
			};
		} else {
			rate = worstRate(a.asset, currency, sources);
		}
		if (rate === undefined) {
			unpriced.push(a.asset);
			continue;
		}
		net += conv(a.netProfit, rate);
		trading += conv(a.tradingFees, rate);
		withdrawal += conv(a.withdrawalFees, rate);
		gas += conv(a.gasSpent, rate);
		lines.push({
			asset: a.asset,
			netProfit: format(conv(a.netProfit, rate), u),
			rate: format(rate.num, u),
			source: rate.source,
		});
	}

	return {
		currency,
		netProfit: format(net, u),
		tradingFees: format(trading, u),
		withdrawalFees: format(withdrawal, u),
		gasSpent: format(gas, u),
		lines,
		unpriced,
		caveat:
			`An ESTIMATE. Earnings accrue in ${report.assets.length} assets and ` +
			`were converted to ${currency} at the rates shown; the per-asset ` +
			`figures are exact and these are not.` +
			(unpriced.length > 0
				? ` ${unpriced.join(", ")} could not be priced and ${
						unpriced.length === 1 ? "is" : "are"
					} EXCLUDED from this total.`
				: "") +
			(report.reconciles ? "" : " The underlying report did not reconcile."),
	};
}

/**
 * Move accrued revenue out of FEES into an account that can spend it.
 *
 * Why this exists rather than letting FEES sit there: a FEES balance cannot be
 * traded or withdrawn, because every path in this service that moves money
 * operates on USER accounts. So "the fees are the exchange's" is only true in
 * the accounting sense until the balance is swept somewhere usable.
 *
 * WHAT IT REFUSES TO DO:
 *
 *   * Sweep more than the balance. The ledger would refuse the resulting
 *     negative anyway, but failing here names the real problem.
 *   * Sweep the GAS FLOAT out from under the gas gate. `reserve` is held back,
 *     and a sweep of fee revenue in ETH must leave enough ETH to keep paying
 *     for the ERC-20 withdrawals that earned it. Sweeping that is how a venue
 *     books a profit and then cannot pay out.
 */
export function sweep(
	ledger: Ledger,
	args: {
		asset: string;
		/** USER account that receives it — the venue's own trading account. */
		toUserId: string;
		amount: bigint;
		actor: string;
		/** Gas float to leave behind. See gasgate.ts. */
		reserve?: bigint;
		idempotencyKey: string;
	},
): void {
	const u = unit(args.asset);
	if (args.amount <= 0n) throw new RevenueError("a sweep must be positive");
	if (args.actor.trim() === "") {
		throw new RevenueError("a sweep must name the operator who made it");
	}
	if (args.toUserId.trim() === "") {
		throw new RevenueError("a sweep must name the destination account");
	}

	const balance = ledger.balance({
		kind: AccountKind.FEES,
		owner: "",
		asset: args.asset,
	});
	const reserve = args.reserve ?? 0n;
	const sweepable = balance - reserve;
	if (args.amount > sweepable) {
		throw new RevenueError(
			`cannot sweep ${format(args.amount, u)} ${args.asset}: the fee balance ` +
				`is ${format(balance, u)}` +
				(reserve > 0n
					? `, of which ${format(reserve, u)} is reserved as a gas float — ` +
						`${format(sweepable < 0n ? 0n : sweepable, u)} is sweepable. ` +
						"Sweeping the gas float would book a profit the venue then " +
						"cannot pay withdrawals out of."
					: ""),
		);
	}

	ledger.post({
		reason: Reason.FEE_SWEEP,
		postings: [
			{ account: { kind: AccountKind.FEES, owner: "", asset: args.asset }, delta: -args.amount },
			{ account: { kind: AccountKind.USER, owner: args.toUserId, asset: args.asset }, delta: args.amount },
		],
		idempotencyKey: `sweep:${args.idempotencyKey}`,
		actor: args.actor,
	});
}

/**
 * Treasury putting its own money into the gas float.
 *
 * Credits FEES (the venue's own claim) rather than a customer account, and
 * requires the matching custody inflow to be recorded in the same transaction
 * — because a claim on ETH that is not matched by ETH arriving is a claim that
 * reconciliation will correctly call a shortfall.
 */
export function fundGasFloat(
	ledger: Ledger,
	args: {
		gasAsset: string;
		amount: bigint;
		actor: string;
		idempotencyKey: string;
	},
): void {
	if (args.amount <= 0n) throw new RevenueError("funding must be positive");
	if (args.actor.trim() === "") {
		throw new RevenueError("funding must name the operator");
	}
	ledger.post({
		reason: Reason.TREASURY_FUNDING,
		postings: [
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: args.gasAsset }, delta: -args.amount },
			{ account: { kind: AccountKind.CUSTODY, owner: "", asset: args.gasAsset }, delta: args.amount },
			{ account: { kind: AccountKind.FEES, owner: "", asset: args.gasAsset }, delta: args.amount },
			{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: args.gasAsset }, delta: -args.amount },
		],
		idempotencyKey: `gasfund:${args.idempotencyKey}`,
		actor: args.actor,
	});
}
