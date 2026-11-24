// -----------------------------------------------------------------------------
// MARKET-MAKER POSITIONS — what "add liquidity" means on an order book.
//
// A position is a LADDER of resting limit orders around a reference price: rungs
// of bids below it and asks above it, funded from the user's own balance.
// Adding liquidity places the ladder; removing it cancels whatever has not
// filled and frees the balance.
//
// WHAT THE USER ACTUALLY EARNS, STATED HONESTLY.
//
// They earn THE SPREAD, not the fee. On this venue a maker pays the same 0.20%
// a taker does — there is no maker rebate (see fees.ts). So a round trip only
// makes money if:
//
//     spread > makerFee + makerFee      (paid on the buy AND on the sell)
//
// At 20 bps a side, any spread under ~40 bps LOSES MONEY on every completed
// round trip. That is not a detail to bury in a tooltip: someone who picks a
// 10 bps spread because it looks competitive will bleed steadily and never know
// why. So `quote()` computes the break-even, says so in words, and `open()`
// REFUSES to create a losing position unless the caller explicitly accepts it.
//
// WHY THE LADDER IS ORDINARY ORDERS.
//
// Because they are ordinary orders. A position is bookkeeping over real resting
// orders, not a pool with its own matching rules. The existing engine prices and
// settles them, the existing ledger proves conservation, and the maker's
// inventory is just their balance — always withdrawable, never locked, no
// impermanent loss to explain.
//
// And self-trading is impossible for free: the matcher already excludes an
// account's own orders, so a two-sided ladder cannot cross itself and wash the
// owner's capital away in fees.
// -----------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";

import { assetDef } from "./assets";
import { DEFAULT_FEES, type FeeSchedule } from "./fees";
import { VenueError, market, quoteFor, type OrderSide, type Venue } from "./venue";

export class MmError extends VenueError {
	constructor(message: string, status = 400) {
		super(message, status);
		this.name = "MmError";
	}
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_position (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  market        TEXT NOT NULL,
  mid           TEXT NOT NULL,
  spread_bps    INTEGER NOT NULL,
  rungs         INTEGER NOT NULL,
  base_capital  TEXT NOT NULL,
  quote_capital TEXT NOT NULL,
  state         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);

CREATE TABLE IF NOT EXISTS mm_order (
  position_id TEXT NOT NULL REFERENCES mm_position(id),
  order_id    TEXT NOT NULL,
  side        TEXT NOT NULL,
  PRIMARY KEY (position_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_mm_order_pos ON mm_order(position_id);
`;

export interface Quote {
	/** Round-trip cost in basis points: the maker fee, paid twice. */
	readonly breakEvenBps: number;
	/** True when the chosen spread cannot cover those fees. */
	readonly loses: boolean;
	/** Plain-language explanation. Shown whether it loses or not. */
	readonly note: string;
	readonly bids: readonly { price: bigint; base: bigint }[];
	readonly asks: readonly { price: bigint; base: bigint }[];
	readonly baseNeeded: bigint;
	readonly quoteNeeded: bigint;
}

export interface Position {
	readonly id: string;
	readonly market: string;
	readonly mid: bigint;
	readonly spreadBps: number;
	readonly rungs: number;
	readonly state: "open" | "closed";
	readonly createdAt: string;
	readonly orderIds: readonly string[];
}

/**
 * Price a ladder without placing it.
 *
 * Separate from creation deliberately: the UI must show the break-even and the
 * real rung prices BEFORE funds are committed, and a preview computed by
 * different code than the real thing is a preview that will eventually lie.
 */
export function quote(args: {
	market: string;
	mid: bigint;
	spreadBps: number;
	rungs: number;
	baseCapital: bigint;
	quoteCapital: bigint;
	fees?: FeeSchedule;
}): Quote {
	const m = market(args.market);
	const fees = args.fees ?? DEFAULT_FEES;
	const baseDec = assetDef(m.base).decimals;

	if (args.mid <= 0n) throw new MmError("the reference price must be positive");
	if (!Number.isInteger(args.rungs) || args.rungs < 1 || args.rungs > 20) {
		throw new MmError("rungs must be a whole number from 1 to 20");
	}
	if (!Number.isInteger(args.spreadBps) || args.spreadBps < 1 || args.spreadBps > 5_000) {
		throw new MmError("spread must be a whole number of basis points, 1 to 5000");
	}
	if (args.baseCapital < 0n || args.quoteCapital < 0n) {
		throw new MmError("capital cannot be negative");
	}
	if (args.baseCapital === 0n && args.quoteCapital === 0n) {
		throw new MmError("commit some capital to at least one side");
	}

	// A MAKER PAYS ON EACH LEG, so a round trip costs twice the maker fee.
	const breakEvenBps = fees.makerBps * 2;
	const loses = args.spreadBps <= breakEvenBps;

	const half = args.spreadBps / 2;
	const bids: { price: bigint; base: bigint }[] = [];
	const asks: { price: bigint; base: bigint }[] = [];

	// Capital splits evenly across rungs. Integer division truncates, so the
	// remainder stays unspent rather than overcommitting the balance.
	const perRungBase = args.baseCapital / BigInt(args.rungs);
	const perRungQuote = args.quoteCapital / BigInt(args.rungs);

	let baseNeeded = 0n;
	let quoteNeeded = 0n;

	for (let i = 1; i <= args.rungs; i++) {
		const offBps = Math.round((half * i) / args.rungs);
		const delta = (args.mid * BigInt(offBps)) / 10_000n;

		if (perRungQuote > 0n) {
			const price = args.mid - delta;
			if (price > 0n) {
				const base = (perRungQuote * 10n ** BigInt(baseDec)) / price;
				if (base >= m.minBase) {
					bids.push({ price, base });
					quoteNeeded += quoteFor(base, price, baseDec);
				}
			}
		}
		if (perRungBase >= m.minBase) {
			asks.push({ price: args.mid + delta, base: perRungBase });
			baseNeeded += perRungBase;
		}
	}

	if (bids.length === 0 && asks.length === 0) {
		throw new MmError(
			`every rung came out below the ${m.minBase} ${m.base} minimum — ` +
				"commit more capital or use fewer rungs",
		);
	}

	const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
	const note = loses
		? `A ${pct(args.spreadBps)} spread does not cover fees. You pay ` +
			`${pct(fees.makerBps)} on the buy and ${pct(fees.makerBps)} on the sell, ` +
			`so a round trip needs more than ${pct(breakEvenBps)} to make money. At ` +
			`this spread each completed round trip LOSES about ` +
			`${pct(breakEvenBps - args.spreadBps)}.`
		: `You earn the spread and pay ${pct(fees.makerBps)} per fill. Break-even is ` +
			`${pct(breakEvenBps)}; at ${pct(args.spreadBps)} a completed round trip ` +
			`nets roughly ${pct(args.spreadBps - breakEvenBps)} before the price moves ` +
			`against you.`;

	return { breakEvenBps, loses, note, bids, asks, baseNeeded, quoteNeeded };
}

export class MarketMaker {
	constructor(
		private readonly db: Database,
		private readonly venue: Venue,
		private readonly fees: FeeSchedule = DEFAULT_FEES,
		private readonly now: () => number = () => Date.now(),
	) {
		db.exec(SCHEMA);
	}

	/**
	 * Place a ladder.
	 *
	 * ONE TRANSACTION for the whole thing. A half-placed ladder is worse than
	 * none: one side of the capital is committed and the other is not, so the
	 * spread the user chose is not the spread they have.
	 */
	open(args: {
		accountId: string;
		market: string;
		mid: bigint;
		spreadBps: number;
		rungs: number;
		baseCapital: bigint;
		quoteCapital: bigint;
		/**
		 * Required to create a position whose spread cannot cover fees.
		 *
		 * Not a checkbox for show. Without it the venue would be quietly
		 * taking money from someone who misread the arithmetic, which is the
		 * one thing a fee-charging venue must not do.
		 */
		acceptLoss?: boolean;
	}): { position: Position; quote: Quote } {
		const q = quote({ ...args, fees: this.fees });
		if (q.loses && args.acceptLoss !== true) throw new MmError(q.note);

		const run = this.db.transaction((): Position => {
			const id = `mm_${randomBytes(9).toString("hex")}`;
			const nowIso = new Date(this.now()).toISOString();
			this.db
				.prepare(
					`INSERT INTO mm_position (id, account_id, market, mid, spread_bps,
					   rungs, base_capital, quote_capital, state, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
				)
				.run(
					id, args.accountId, args.market, args.mid.toString(), args.spreadBps,
					args.rungs, args.baseCapital.toString(), args.quoteCapital.toString(),
					nowIso,
				);

			const link = this.db.prepare(
				`INSERT INTO mm_order (position_id, order_id, side) VALUES (?, ?, ?)`,
			);
			const place = (side: OrderSide, price: bigint, base: bigint): void => {
				const r = this.venue.placeOrder({
					accountId: args.accountId,
					market: args.market,
					side,
					price,
					baseAmount: base,
				});
				link.run(id, r.order.id, side);
			};

			for (const a of q.asks) place("sell", a.price, a.base);
			for (const b of q.bids) place("buy", b.price, b.base);

			return this.get(args.accountId, id)!;
		});

		return { position: run.immediate(), quote: q };
	}

	/**
	 * Stop quoting: cancel everything still resting and close the position.
	 *
	 * Filled orders are NOT reversed. Those were real trades at real prices and
	 * the resulting inventory belongs to the user. "Remove liquidity" means
	 * stop quoting, not undo history.
	 */
	close(
		accountId: string,
		positionId: string,
	): { cancelled: number; alreadyGone: number } {
		const run = this.db.transaction(() => {
			const pos = this.get(accountId, positionId);
			if (pos === undefined) throw new MmError("no such position", 404);
			if (pos.state === "closed") throw new MmError("that position is already closed");

			let cancelled = 0;
			let alreadyGone = 0;
			for (const oid of pos.orderIds) {
				try {
					this.venue.cancelOrder(accountId, oid);
					cancelled++;
				} catch {
					// Filled or already cancelled — NOT an error. A ladder that
					// has done its job is mostly filled, and failing the close
					// because of that would leave the user unable to stop
					// quoting at all.
					alreadyGone++;
				}
			}
			this.db
				.prepare(`UPDATE mm_position SET state = 'closed', closed_at = ? WHERE id = ?`)
				.run(new Date(this.now()).toISOString(), positionId);
			return { cancelled, alreadyGone };
		});
		return run.immediate();
	}

	get(accountId: string, id: string): Position | undefined {
		const r = this.db
			.prepare(`SELECT * FROM mm_position WHERE id = ? AND account_id = ?`)
			.get(id, accountId) as
			| {
					id: string;
					market: string;
					mid: string;
					spread_bps: number;
					rungs: number;
					state: string;
					created_at: string;
			  }
			| undefined;
		if (r === undefined) return undefined;
		const ids = (
			this.db
				.prepare(`SELECT order_id FROM mm_order WHERE position_id = ?`)
				.all(id) as { order_id: string }[]
		).map((x) => x.order_id);
		return {
			id: r.id,
			market: r.market,
			mid: BigInt(r.mid),
			spreadBps: r.spread_bps,
			rungs: r.rungs,
			state: r.state as Position["state"],
			createdAt: r.created_at,
			orderIds: ids,
		};
	}

	/** A user's positions, with live fill progress. */
	list(
		accountId: string,
	): readonly (Position & { filledBase: bigint; restingBase: bigint })[] {
		const rows = this.db
			.prepare(
				`SELECT id FROM mm_position WHERE account_id = ?
				  ORDER BY created_at DESC LIMIT 50`,
			)
			.all(accountId) as { id: string }[];
		return rows.map((r) => {
			const p = this.get(accountId, r.id)!;
			let filled = 0n;
			let resting = 0n;
			for (const oid of p.orderIds) {
				const o = this.venue.order(oid);
				if (o === undefined) continue;
				filled += o.baseFilled;
				if (o.state === "open") resting += o.baseTotal - o.baseFilled;
			}
			return { ...p, filledBase: filled, restingBase: resting };
		});
	}
}
