// -----------------------------------------------------------------------------
// TRADING FEES — 0.2% maker, 0.2% taker.
//
// WHY THIS LIVES HERE AND NOT IN OrderCostService.
//
// TradeXPro computes fees through `app/Helper/bcMath.php`, whose helpers pass
// both operands through `floatval()` before calling bcmath (see the
// characterization suite in the TradeXPro fork). In that layer
// `bcaddx("99999999.99999999", "0")` returns `99999999.99999998` — adding zero
// loses a unit. A fee calculated there is approximately right, which is not a
// standard a venue can hold itself to when the difference accrues to the house.
//
// So fees are computed here, in integer base units, with conservation asserted
// rather than assumed.
//
// EACH SIDE PAYS A FEE ON WHAT IT RECEIVES, IN THE ASSET IT RECEIVES.
//
// A buyer receiving base pays the fee in base; a seller receiving quote pays it
// in quote. The alternative — charging both fees in the quote asset — requires
// the buyer to hold quote they were not spending, and silently fails when they
// spent their whole balance. Taking the fee from the proceeds cannot fail.
//
// ROUNDING FAVOURS THE CUSTOMER, ALWAYS. `applyFeeBps` truncates the fee, so a
// sub-unit remainder stays with the trader rather than accruing to the venue.
// Over millions of fills that is a rounding loss the house absorbs, and it is
// the correct direction: the party that wrote the software should not profit
// from its rounding.
//
// MAKER AND TAKER ARE THE SAME RATE TODAY (20 bps each). The distinction is
// still modelled, because a tiered or maker-rebate schedule is the normal next
// step and retrofitting the distinction later means reworking every posting.
// -----------------------------------------------------------------------------

import { applyFeeBps } from "./amount";
import { AccountKind, Reason, type Posting } from "./ledger";
import { settlementAsset } from "./assets";

/** 0.2% = 20 basis points. */
export const DEFAULT_MAKER_BPS = 20;
export const DEFAULT_TAKER_BPS = 20;

export interface FeeSchedule {
	readonly makerBps: number;
	readonly takerBps: number;
}

export const DEFAULT_FEES: FeeSchedule = {
	makerBps: DEFAULT_MAKER_BPS,
	takerBps: DEFAULT_TAKER_BPS,
};

export class FeeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FeeError";
	}
}

/** Which side of the book a participant was on. Decides their rate. */
export enum Side {
	/** Rested on the book; provided liquidity. */
	MAKER = "maker",
	/** Crossed the spread; removed liquidity. */
	TAKER = "taker",
}

export interface FillParty {
	readonly userId: string;
	readonly side: Side;
}

export interface Fill {
	/** The asset being bought and sold, e.g. "BTC". */
	readonly base: string;
	/** The asset it is priced in, e.g. "USDC". */
	readonly quote: string;
	/** Base units of `base` changing hands. */
	readonly baseAmount: bigint;
	/** Base units of `quote` changing hands. */
	readonly quoteAmount: bigint;
	/** Receives `base`, pays `quote`. */
	readonly buyer: FillParty;
	/** Receives `quote`, pays `base`. */
	readonly seller: FillParty;
	/** Unique per fill — the ledger's idempotency key is derived from it. */
	readonly fillId: string;
}

export interface FeeBreakdown {
	/** Fee taken from the buyer's base proceeds. */
	readonly buyerFee: bigint;
	/** Fee taken from the seller's quote proceeds. */
	readonly sellerFee: bigint;
	readonly buyerBps: number;
	readonly sellerBps: number;
	/** What the buyer actually receives. */
	readonly buyerNetBase: bigint;
	/** What the seller actually receives. */
	readonly sellerNetQuote: bigint;
}

function bpsFor(side: Side, s: FeeSchedule): number {
	return side === Side.MAKER ? s.makerBps : s.takerBps;
}

/** Compute the fees for a fill without touching the ledger. */
export function feesFor(fill: Fill, schedule: FeeSchedule = DEFAULT_FEES): FeeBreakdown {
	validate(fill);

	const buyerBps = bpsFor(fill.buyer.side, schedule);
	const sellerBps = bpsFor(fill.seller.side, schedule);

	const b = applyFeeBps(fill.baseAmount, buyerBps);
	const q = applyFeeBps(fill.quoteAmount, sellerBps);

	return {
		buyerFee: b.fee,
		sellerFee: q.fee,
		buyerBps,
		sellerBps,
		buyerNetBase: b.net,
		sellerNetQuote: q.net,
	};
}

function validate(fill: Fill): void {
	if (fill.baseAmount <= 0n || fill.quoteAmount <= 0n) {
		throw new FeeError("a fill must move a positive amount of both assets");
	}
	if (settlementAsset(fill.base) === settlementAsset(fill.quote)) {
		throw new FeeError(
			`base and quote are the same settlement asset (${fill.base}/${fill.quote})`,
		);
	}
	if (fill.base.includes(".") || fill.quote.includes(".")) {
		// Trading happens against the fungible liability, not a chain-specific
		// inventory. "USDT.TRC20/BTC" is not a market.
		throw new FeeError(
			"trade assets must not name a network — trading is against the " +
				"fungible balance, not per-chain inventory",
		);
	}
	if (fill.buyer.userId === fill.seller.userId) {
		// Self-trading is a wash trade. It inflates volume, and with fees on
		// both sides it quietly drains the trader, so refusing is both the
		// honest and the kind choice.
		throw new FeeError("self-trade: buyer and seller are the same account");
	}
	if (fill.fillId.trim() === "") throw new FeeError("fillId is required");
}

/**
 * The ledger postings for a fill, fees included.
 *
 * Conservation is ASSERTED here, not trusted: the postings must sum to zero per
 * settlement asset, which the ledger will also check. Checking twice is cheap
 * and this is the one function where an arithmetic slip hands money to the
 * wrong party.
 */
export function fillPostings(
	fill: Fill,
	schedule: FeeSchedule = DEFAULT_FEES,
): { postings: Posting[]; fees: FeeBreakdown } {
	const fees = feesFor(fill, schedule);

	const u = (id: string, asset: string): Posting["account"] => ({
		kind: AccountKind.USER,
		owner: id,
		asset,
	});
	const f = (asset: string): Posting["account"] => ({
		kind: AccountKind.FEES,
		owner: "",
		asset,
	});

	const postings: Posting[] = [
		// Base leg: seller gives, buyer receives net, venue takes the fee.
		{ account: u(fill.seller.userId, fill.base), delta: -fill.baseAmount },
		{ account: u(fill.buyer.userId, fill.base), delta: fees.buyerNetBase },
		// Quote leg: buyer gives, seller receives net, venue takes the fee.
		{ account: u(fill.buyer.userId, fill.quote), delta: -fill.quoteAmount },
		{ account: u(fill.seller.userId, fill.quote), delta: fees.sellerNetQuote },
	];

	// Zero-delta postings are refused by the ledger, so a zero fee — which
	// happens on amounts small enough that 20 bps truncates away — must be
	// omitted rather than posted.
	if (fees.buyerFee > 0n) postings.push({ account: f(fill.base), delta: fees.buyerFee });
	if (fees.sellerFee > 0n) postings.push({ account: f(fill.quote), delta: fees.sellerFee });

	assertConserved(postings, fill);
	return { postings, fees };
}

/** Per-asset sums must be exactly zero. */
function assertConserved(postings: readonly Posting[], fill: Fill): void {
	const sums = new Map<string, bigint>();
	for (const p of postings) {
		const k = settlementAsset(p.account.asset);
		sums.set(k, (sums.get(k) ?? 0n) + p.delta);
	}
	for (const [asset, sum] of sums) {
		if (sum !== 0n) {
			throw new FeeError(
				`fill ${fill.fillId} does not conserve ${asset}: sums to ${sum}. ` +
					"Refusing to post — this would create or destroy value.",
			);
		}
	}
}

/** The idempotency key for a fill. Derived, so a replay is a no-op. */
export function fillKey(fillId: string): string {
	return `trade:${fillId}`;
}

export const TRADE_REASON = Reason.TRADE;

/**
 * Human-readable fee disclosure, for the fee page and the order ticket.
 *
 * Returns both the rate and a worked example, because "0.2%" alone leaves a
 * customer unsure whether it applies to the amount, the proceeds, or both
 * sides. Showing the arithmetic removes the doubt.
 */
export function disclose(schedule: FeeSchedule = DEFAULT_FEES): {
	makerPct: string;
	takerPct: string;
	note: string;
} {
	const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
	return {
		makerPct: pct(schedule.makerBps),
		takerPct: pct(schedule.takerBps),
		note:
			`Each side pays a fee on what it receives, in the asset it receives. ` +
			`Buy 1 BTC and the ${pct(schedule.takerBps)} fee is taken from the BTC ` +
			`you receive, not charged separately. Fees round down, so a ` +
			`sub-unit remainder stays with you.`,
	};
}
