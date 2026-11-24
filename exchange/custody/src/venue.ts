// -----------------------------------------------------------------------------
// THE CUSTODIAL VENUE — accounts, balances, a matching engine, and settlement.
//
// This is what makes it an exchange rather than a landing page. Everything
// settles through the double-entry ledger in ledger.ts, with the 0.2% fees from
// fees.ts, so every property already proven there holds here: conservation,
// no negative balances, idempotency, an append-only audit trail.
//
// WHAT IS DELIBERATELY NOT HERE.
//
// No real deposits. On testnet, funding is an explicit, clearly-labelled
// testnet credit. Wiring real BitGo deposit webhooks is a separate change and
// it must not be possible to confuse the two — so the testnet credit refuses
// to run at all when the mainnet gate is on. A venue that can mint balances
// in production is not a venue, it is a rug.
//
// THE MATCHING ENGINE IS PRICE-TIME PRIORITY, AND IT RUNS INSIDE ONE SQLITE
// TRANSACTION PER INCOMING ORDER. That matters more than its sophistication:
// an order that half-matches and then fails must leave no trace, or balances
// and the book disagree. Taking the write lock for the whole match is what
// makes "all fills or none" true rather than aspirational.
//
// PRICES ARE INTEGERS, SCALED. A price is "quote base-units per ONE whole unit
// of base", held as a bigint. No floats anywhere: the whole point of this
// service existing separately from TradeXPro's PHP is that
// `bcaddx(x, "0") !== x` over there.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "better-sqlite3";

import { assetDef } from "./assets";
import { DEFAULT_FEES, Side, fillKey, fillPostings, type FeeSchedule } from "./fees";
import { AccountKind, InsufficientFunds, Reason, type Ledger } from "./ledger";

export class VenueError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "VenueError";
	}
}

export type OrderSide = "buy" | "sell";

export interface Market {
	readonly symbol: string;
	readonly base: string;
	readonly quote: string;
	/** Smallest tradable base amount, in base units. */
	readonly minBase: bigint;
}

/**
 * Smallest tradable amount, PER BASE ASSET rather than per market.
 *
 * It is a property of the asset: the dust floor for BTC is the same whether it
 * is priced in USDT or in BLOCK. Keeping it per-market meant the figure had to
 * be repeated for every new pair, which is how one pair ends up with a floor a
 * thousand times off and nobody notices until an order behaves oddly.
 *
 * Each is roughly "the smallest amount worth the gas of eventually moving it",
 * erring large: a market full of dust orders is a market nobody can read.
 */
const MIN_BASE: Readonly<Record<string, bigint>> = {
	BTC: 1_000n,                  // 0.00001 BTC
	ETH: 10n ** 13n,              // 0.00001 ETH
	USDT: 1_000_000n,             // 1 USDT
	USDC: 1_000_000n,             // 1 USDC
	SOL: 1_000_000n,              // 0.001 SOL
	DOGE: 100_000_000n,           // 1 DOGE
	TRX: 1_000_000n,              // 1 TRX
	XRP: 1_000_000n,              // 1 XRP
	BNB: 10n ** 15n,              // 0.001 BNB
	BLOCK: 100_000n,              // 0.001 BLOCK
	PERBUG: 100_000n,             // 0.001 PERBUG
};

/**
 * EVERY LISTED ASSET TRADES AGAINST USDT AND AGAINST BLOCK.
 *
 * USDT is the senior quote because that is what people price things in. BLOCK
 * is the second quote on purpose: it is the chain's own asset, and a venue that
 * lists its own token only against a stablecoin gives nobody a reason to hold
 * it.
 *
 * GENERATED RATHER THAN LISTED, because a hand-written table is how an asset
 * ends up listed with one market instead of two — the pair that is missing is
 * never the one anybody notices. The generator also refuses to emit a pair
 * against itself, and emits BLOCK-USDT rather than both that and USDT-BLOCK,
 * which would be the same market twice with the prices inverted.
 */
const QUOTES = ["USDT", "BLOCK"] as const;

function buildMarkets(): readonly Market[] {
	const out: Market[] = [];
	const seen = new Set<string>();
	for (const quote of QUOTES) {
		for (const base of Object.keys(MIN_BASE)) {
			if (base === quote) continue;
			// Skip the inverse of a pair already emitted: once BLOCK-USDT
			// exists, USDT-BLOCK is the same market read backwards.
			if (seen.has(`${quote}-${base}`)) continue;
			const symbol = `${base}-${quote}`;
			out.push({ symbol, base, quote, minBase: MIN_BASE[base]! });
			seen.add(symbol);
		}
	}
	return out;
}

export const MARKETS: readonly Market[] = buildMarkets();

export function market(symbol: string): Market {
	const m = MARKETS.find((x) => x.symbol === symbol);
	if (m === undefined) throw new VenueError(`unknown market ${symbol}`, 404);
	return m;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  pw_salt       TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ord (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES account(id),
  market      TEXT NOT NULL,
  side        TEXT NOT NULL,
  -- quote base-units per ONE WHOLE unit of base, as an integer string
  price       TEXT NOT NULL,
  base_total  TEXT NOT NULL,
  base_filled TEXT NOT NULL DEFAULT '0',
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seq         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ord_book ON ord(market, side, state);
CREATE INDEX IF NOT EXISTS idx_ord_acct ON ord(account_id);

CREATE TABLE IF NOT EXISTS trade (
  id          TEXT PRIMARY KEY,
  market      TEXT NOT NULL,
  price       TEXT NOT NULL,
  base_amount TEXT NOT NULL,
  taker_side  TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_mkt ON trade(market, at);

-- Orders and trades are the venue's record of what it agreed to. Amending one
-- after the fact would make the ledger and the book disagree about history.
CREATE TRIGGER IF NOT EXISTS trade_no_update
BEFORE UPDATE ON trade
BEGIN SELECT RAISE(ABORT, 'trade is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_no_delete
BEFORE DELETE ON trade
BEGIN SELECT RAISE(ABORT, 'trade is append-only'); END;
`;

interface OrderRow {
	id: string;
	account_id: string;
	market: string;
	side: string;
	price: string;
	base_total: string;
	base_filled: string;
	state: string;
	created_at: string;
	seq: number | null;
}

export interface Order {
	readonly id: string;
	readonly market: string;
	readonly side: OrderSide;
	readonly price: bigint;
	readonly baseTotal: bigint;
	readonly baseFilled: bigint;
	readonly state: "open" | "filled" | "cancelled";
	readonly createdAt: string;
}

function hydrate(r: OrderRow): Order {
	return {
		id: r.id,
		market: r.market,
		side: r.side as OrderSide,
		price: BigInt(r.price),
		baseTotal: BigInt(r.base_total),
		baseFilled: BigInt(r.base_filled),
		state: r.state as Order["state"],
		createdAt: r.created_at,
	};
}

/**
 * Quote amount for a base amount at a price.
 *
 * price is quote-units per WHOLE base unit, so the base amount must be divided
 * by the base asset's scale. Integer division truncates, which rounds the quote
 * DOWN — in the seller's favour on a buy and the buyer's on a sell. That
 * asymmetry is sub-unit and is preferable to rounding up, which would let a
 * fill cost more than the order authorised.
 */
export function quoteFor(baseAmount: bigint, price: bigint, baseDecimals: number): bigint {
	return (baseAmount * price) / 10n ** BigInt(baseDecimals);
}

export class Venue {
	constructor(
		private readonly db: Database,
		private readonly ledger: Ledger,
		private readonly fees: FeeSchedule = DEFAULT_FEES,
		private readonly opts: {
			mainnetEnabled?: boolean;
			/**
			 * True when a LIVE CUSTODIAN backs this venue — a real BitGo
			 * account, whether it holds mainnet or testnet coins.
			 *
			 * Separate from `mainnetEnabled` because it gates a different
			 * thing. See `testnetCredit`.
			 */
			liveCustodian?: boolean;
			now?: () => number;
		} = {},
	) {
		db.exec(SCHEMA);
	}

	/** The venue's own connection — withdrawals must share it, not open another. */
	get database(): Database {
		return this.db;
	}
	get book_ledger(): Ledger {
		return this.ledger;
	}

	private now(): string {
		return new Date(this.opts.now?.() ?? Date.now()).toISOString();
	}

	// ------------------------------------------------------------- accounts

	/**
	 * Register an account.
	 *
	 * scrypt, not a bare hash: a password database is going to leak eventually
	 * and the only question is how expensive it is to crack afterwards. 16-byte
	 * random salt per account, so one rainbow table cannot serve two users.
	 */
	register(email: string, password: string): { id: string } {
		const e = email.trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
			throw new VenueError("that does not look like an email address");
		}
		// A LENGTH FLOOR, NOT COMPOSITION RULES. "One capital and a symbol"
		// produces Password1! and measurably does not help; length does.
		if (password.length < 12) {
			throw new VenueError("password must be at least 12 characters");
		}
		if (this.db.prepare(`SELECT 1 FROM account WHERE email = ?`).get(e) !== undefined) {
			// Deliberately the same shape of error as a bad login would give,
			// so this endpoint is not an account-enumeration oracle.
			throw new VenueError("that email cannot be registered", 409);
		}
		const id = `u_${randomBytes(9).toString("hex")}`;
		const salt = randomBytes(16).toString("hex");
		const hash = scryptSync(password, salt, 64).toString("hex");
		this.db
			.prepare(
				`INSERT INTO account (id, email, pw_salt, pw_hash, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, e, salt, hash, this.now());
		return { id };
	}

	/** Log in, returning an opaque bearer token. */
	login(email: string, password: string): { token: string; accountId: string } {
		const row = this.db
			.prepare(`SELECT id, pw_salt, pw_hash FROM account WHERE email = ?`)
			.get(email.trim().toLowerCase()) as
			| { id: string; pw_salt: string; pw_hash: string }
			| undefined;

		// CONSTANT-TIME, AND THE SAME WORK WHETHER OR NOT THE ACCOUNT EXISTS.
		// Returning early on an unknown email makes login timing an account
		// enumeration oracle.
		const salt = row?.pw_salt ?? "0".repeat(32);
		const expect = Buffer.from(row?.pw_hash ?? "0".repeat(128), "hex");
		const got = scryptSync(password, salt, 64);
		const ok =
			row !== undefined &&
			expect.length === got.length &&
			timingSafeEqual(expect, got);
		if (!ok) throw new VenueError("wrong email or password", 401);

		const token = randomBytes(32).toString("hex");
		const expires = new Date(
			(this.opts.now?.() ?? Date.now()) + 12 * 3600 * 1000,
		).toISOString();
		this.db
			.prepare(
				`INSERT INTO session (token_hash, account_id, created_at, expires_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(sha(token), row.id, this.now(), expires);
		return { token, accountId: row.id };
	}

	/** Resolve a bearer token to an account, or throw 401. */
	authenticate(token: string): string {
		const row = this.db
			.prepare(`SELECT account_id, expires_at FROM session WHERE token_hash = ?`)
			.get(sha(token)) as { account_id: string; expires_at: string } | undefined;
		if (row === undefined) throw new VenueError("not signed in", 401);
		if (row.expires_at < this.now()) {
			this.db.prepare(`DELETE FROM session WHERE token_hash = ?`).run(sha(token));
			throw new VenueError("session expired", 401);
		}
		return row.account_id;
	}

	logout(token: string): void {
		this.db.prepare(`DELETE FROM session WHERE token_hash = ?`).run(sha(token));
	}

	// ------------------------------------------------------------- balances

	/**
	 * Funds an account's OPEN ORDERS have already laid claim to, per asset.
	 *
	 * A resting buy has claimed quote for the part of it still unfilled, at its
	 * own limit price; a resting sell has claimed that much base. Derived from
	 * the order rows rather than tracked in a column, so it cannot drift out of
	 * step with the book.
	 */
	reserved(accountId: string): Map<string, bigint> {
		const rows = this.db
			.prepare(
				`SELECT market, side, price, base_total, base_filled FROM ord
				  WHERE account_id = ? AND state = 'open'`,
			)
			.all(accountId) as {
			market: string;
			side: string;
			price: string;
			base_total: string;
			base_filled: string;
		}[];

		const out = new Map<string, bigint>();
		for (const r of rows) {
			const m = MARKETS.find((x) => x.symbol === r.market);
			if (m === undefined) continue;
			const left = BigInt(r.base_total) - BigInt(r.base_filled);
			if (left <= 0n) continue;
			const asset = r.side === "buy" ? m.quote : m.base;
			const amount =
				r.side === "buy"
					? quoteFor(left, BigInt(r.price), assetDef(m.base).decimals)
					: left;
			out.set(asset, (out.get(asset) ?? 0n) + amount);
		}
		return out;
	}

	/**
	 * Balances, with what is already committed to resting orders separated out.
	 *
	 * THE FIRST VERSION REPORTED THE LEDGER BALANCE AS "available" AND RESERVED
	 * NOTHING, which was not merely cosmetic. `placeOrder` checked that same
	 * raw balance, so one account holding 1 BTC could rest five separate 1 BTC
	 * asks — each individually passing the check — and every incoming buy that
	 * reached past the first then failed, because settling the second fill
	 * overdrew a balance the ledger correctly refused. One account could make a
	 * whole market unusable for the price of one BTC, and nothing was stolen,
	 * which is exactly why it would have taken a while to notice.
	 */
	balances(accountId: string): {
		asset: string;
		/** Ledger balance: everything the account owns. */
		total: bigint;
		/** Committed to resting orders. */
		reserved: bigint;
		/** total − reserved. What a new order may use. */
		available: bigint;
		decimals: number;
	}[] {
		const assets = new Set<string>();
		for (const m of MARKETS) {
			assets.add(m.base);
			assets.add(m.quote);
		}
		const held = this.reserved(accountId);
		return [...assets].sort().map((asset) => {
			const total = this.ledger.balance({
				kind: AccountKind.USER,
				owner: accountId,
				asset,
			});
			const reserved = held.get(asset) ?? 0n;
			return {
				asset,
				total,
				reserved,
				// Clamped at zero. A negative "available" could only come from a
				// legacy overcommitted order, and rendering it negative would be
				// alarming without being actionable.
				available: total > reserved ? total - reserved : 0n,
				decimals: assetDef(asset).decimals,
			};
		});
	}

	/**
	 * TESTNET-ONLY funding.
	 *
	 * REFUSES OUTRIGHT when the mainnet gate is on. A venue with an endpoint
	 * that can conjure balances in production is not an exchange, and the guard
	 * belongs in the code rather than in a deployment checklist — checklists
	 * are not enforced at 3am.
	 */
	testnetCredit(accountId: string, asset: string, amount: bigint, custodyId: string): void {
		if (this.opts.mainnetEnabled === true) {
			throw new VenueError(
				"testnet funding is disabled on mainnet — deposits must arrive on chain",
				403,
			);
		}
		/*
		 * AND REFUSED WHENEVER A LIVE CUSTODIAN BACKS THE VENUE, mainnet or not.
		 *
		 * Look at what this method posts: it credits CUSTODY as well as the
		 * user, because the ledger's invariant requires the liability to be
		 * backed. But no coins arrive. So the books claim custody holds
		 * something the custodian does not, and reconciliation — comparing
		 * books against what the custodian actually reports — correctly calls
		 * that a SHORTFALL and halts withdrawals of that asset. Permanently,
		 * since nothing ever un-credits it.
		 *
		 * That is why this is NOT covered by the mainnet gate alone. A
		 * production BitGo account holding testnet coins is exactly the setup
		 * an operator wants for a dry run, and it is exactly the setup where
		 * one faucet click silently bricks reconciliation for that asset.
		 *
		 * The faucet is for a venue reconciling against a declared treasury
		 * file. Once a real custodian is wired, deposits come from the chain.
		 */
		if (this.opts.liveCustodian === true) {
			throw new VenueError(
				"testnet funding is disabled because a live custodian is " +
					"configured. This endpoint credits CUSTODY as well as your " +
					"balance, and the custodian would not report those coins — " +
					"reconciliation would read the difference as a shortfall and " +
					"halt withdrawals of that asset. Deposit on chain instead.",
				403,
			);
		}
		if (amount <= 0n) throw new VenueError("amount must be positive");
		this.ledger.post({
			reason: Reason.DEPOSIT,
			postings: [
				{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amount },
				{ account: { kind: AccountKind.CUSTODY, owner: "", asset: custodyId }, delta: amount },
				{ account: { kind: AccountKind.USER, owner: accountId, asset }, delta: amount },
				{ account: { kind: AccountKind.EXTERNAL, owner: "", asset: custodyId }, delta: -amount },
			],
			idempotencyKey: `testnet-credit:${accountId}:${asset}:${randomBytes(6).toString("hex")}`,
			actor: "testnet-faucet",
		});
	}

	// -------------------------------------------------------------- trading

	/**
	 * Place a limit order and match it against the book.
	 *
	 * THE WHOLE THING IS ONE IMMEDIATE TRANSACTION. A partially-matched order
	 * that then fails must leave nothing behind: otherwise the book says one
	 * thing, the ledger says another, and reconciliation reports a break whose
	 * cause is three layers away. Taking the write lock up front is what makes
	 * "all fills or none" true.
	 */
	placeOrder(args: {
		accountId: string;
		market: string;
		side: OrderSide;
		price: bigint;
		baseAmount: bigint;
	}): { order: Order; fills: number } {
		const m = market(args.market);
		if (args.price <= 0n) throw new VenueError("price must be positive");
		if (args.baseAmount < m.minBase) {
			throw new VenueError(
				`minimum order is ${m.minBase} base units of ${m.base}`,
			);
		}

		const baseDec = assetDef(m.base).decimals;
		const run = this.db.transaction((): { order: Order; fills: number } => {
			// FUNDS CHECK FIRST, against the ledger, inside the lock. A buy
			// needs quote for the full order at its limit price; a sell needs
			// the base.
			const need = args.side === "buy"
				? quoteFor(args.baseAmount, args.price, baseDec)
				: args.baseAmount;
			const needAsset = args.side === "buy" ? m.quote : m.base;
			// AGAINST AVAILABLE, NOT THE RAW BALANCE. Checking the ledger
			// balance alone lets the same funds back any number of resting
			// orders — see the note on `balances`.
			const total = this.ledger.balance({
				kind: AccountKind.USER,
				owner: args.accountId,
				asset: needAsset,
			});
			const committed = this.reserved(args.accountId).get(needAsset) ?? 0n;
			const have = total > committed ? total - committed : 0n;
			if (have < need) {
				throw new VenueError(
					`insufficient ${needAsset}: need ${need}, have ${have}` +
						(committed > 0n
							? ` (${total} held, ${committed} already committed to open orders)`
							: ""),
				);
			}

			const id = `o_${randomBytes(9).toString("hex")}`;
			const now = this.now();
			this.db
				.prepare(
					`INSERT INTO ord (id, account_id, market, side, price, base_total,
					                  base_filled, state, created_at, seq)
					 VALUES (?, ?, ?, ?, ?, ?, '0', 'open', ?,
					         (SELECT COALESCE(MAX(seq), 0) + 1 FROM ord))`,
				)
				.run(id, args.accountId, args.market, args.side, args.price.toString(),
					args.baseAmount.toString(), now);

			const fills = this.match(id, m, baseDec);
			return { order: this.order(id)!, fills };
		});
		return run.immediate();
	}

	/**
	 * Match an order against the resting book, price-time priority.
	 *
	 * Fills at the RESTING order's price, not the incoming one — the maker
	 * posted first and set the terms. Filling at the taker's price would hand
	 * the taker any gap between the two, which is a silent wealth transfer away
	 * from the person who provided the liquidity.
	 */
	private match(orderId: string, m: Market, baseDec: number): number {
		const incoming = this.order(orderId)!;
		const opposite: OrderSide = incoming.side === "buy" ? "sell" : "buy";

		// A buy crosses sells at or below its limit, cheapest first. A sell
		// crosses buys at or above its limit, dearest first. `seq` breaks ties
		// by arrival, which is the "time" in price-time priority.
		const rows = this.db
			.prepare(
				`SELECT * FROM ord
				  WHERE market = ? AND side = ? AND state = 'open'
				    AND account_id != ?
				    AND (? = 'buy' AND CAST(price AS INTEGER) <= CAST(? AS INTEGER)
				      OR ? = 'sell' AND CAST(price AS INTEGER) >= CAST(? AS INTEGER))
				  ORDER BY CAST(price AS INTEGER) ${incoming.side === "buy" ? "ASC" : "DESC"}, seq ASC`,
			)
			.all(
				m.symbol, opposite, incoming.account_id ?? "",
				incoming.side, incoming.price.toString(),
				incoming.side, incoming.price.toString(),
			) as OrderRow[];

		let remaining = incoming.baseTotal - incoming.baseFilled;
		let fills = 0;

		for (const r of rows) {
			if (remaining <= 0n) break;
			const resting = hydrate(r);
			const restingLeft = resting.baseTotal - resting.baseFilled;
			if (restingLeft <= 0n) continue;

			const qty = remaining < restingLeft ? remaining : restingLeft;
			const price = resting.price; // maker's price — see above
			const quote = quoteFor(qty, price, baseDec);
			if (quote <= 0n) continue; // dust that prices to nothing

			const buyerId = incoming.side === "buy" ? incoming.account_id! : r.account_id;
			const sellerId = incoming.side === "buy" ? r.account_id : incoming.account_id!;
			const tradeId = `t_${randomBytes(9).toString("hex")}`;

			// Settlement goes through the tested fee + ledger path.
			const { postings } = fillPostings(
				{
					base: m.base,
					quote: m.quote,
					baseAmount: qty,
					quoteAmount: quote,
					buyer: {
						userId: buyerId,
						side: incoming.side === "buy" ? Side.TAKER : Side.MAKER,
					},
					seller: {
						userId: sellerId,
						side: incoming.side === "buy" ? Side.MAKER : Side.TAKER,
					},
					fillId: tradeId,
				},
				this.fees,
			);
			// A MAKER WHO CANNOT DELIVER IS REMOVED FROM THE BOOK, AND THE
			// TAKER IS NOT PUNISHED.
			//
			// Reservation (see `balances`) is what stops an account resting more
			// than it holds, so this should be unreachable for any order placed
			// after that fix. It is here because it was NOT unreachable before:
			// a throw at this point unwound the entire incoming order, so one
			// overcommitted resting order made every buy that reached it fail,
			// and the person whose order failed had done nothing wrong and
			// could not tell why.
			//
			// Orders that predate the fix are still on the live book, and a
			// maker can also be left short by an operator correction. So the
			// failure is contained rather than propagated: cancel the maker,
			// skip the fill, carry on down the book.
			try {
				this.ledger.post({
					reason: Reason.TRADE,
					postings,
					idempotencyKey: fillKey(tradeId),
					actor: "engine",
				});
			} catch (e) {
				if (e instanceof InsufficientFunds) {
					// SAVEPOINT, not the outer transaction: we are inside one
					// already and must undo only this fill's attempt.
					this.db
						.prepare(`UPDATE ord SET state = 'cancelled' WHERE id = ?`)
						.run(r.id);
					console.error(
						`matching ${m.symbol}: cancelled resting order ${r.id} — its ` +
							`owner cannot cover the fill (${e.message}). The incoming ` +
							"order continues against the rest of the book.",
					);
					continue;
				}
				throw e;
			}

			this.db
				.prepare(
					`INSERT INTO trade (id, market, price, base_amount, taker_side, at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(tradeId, m.symbol, price.toString(), qty.toString(), incoming.side, this.now());

			this.bump(r.id, BigInt(r.base_filled) + qty, BigInt(r.base_total));
			remaining -= qty;
			fills++;
		}

		this.bump(orderId, incoming.baseTotal - remaining, incoming.baseTotal);
		return fills;
	}

	private bump(id: string, filled: bigint, total: bigint): void {
		this.db
			.prepare(`UPDATE ord SET base_filled = ?, state = ? WHERE id = ?`)
			.run(filled.toString(), filled >= total ? "filled" : "open", id);
	}

	cancelOrder(accountId: string, orderId: string): Order {
		const row = this.db.prepare(`SELECT * FROM ord WHERE id = ?`).get(orderId) as
			| OrderRow
			| undefined;
		if (row === undefined) throw new VenueError("no such order", 404);
		if (row.account_id !== accountId) throw new VenueError("not your order", 403);
		if (row.state !== "open") throw new VenueError(`order is already ${row.state}`);
		this.db.prepare(`UPDATE ord SET state = 'cancelled' WHERE id = ?`).run(orderId);
		return this.order(orderId)!;
	}

	order(id: string): (Order & { account_id?: string }) | undefined {
		const r = this.db.prepare(`SELECT * FROM ord WHERE id = ?`).get(id) as
			| OrderRow
			| undefined;
		return r === undefined ? undefined : { ...hydrate(r), account_id: r.account_id };
	}

	myOrders(accountId: string, limit = 50): readonly Order[] {
		const rows = this.db
			.prepare(`SELECT * FROM ord WHERE account_id = ? ORDER BY seq DESC LIMIT ?`)
			.all(accountId, limit) as OrderRow[];
		return rows.map(hydrate);
	}

	/** Aggregated depth, best price first. */
	book(symbol: string, depth = 20): {
		bids: { price: bigint; base: bigint }[];
		asks: { price: bigint; base: bigint }[];
	} {
		market(symbol);
		const side = (s: OrderSide, dir: "DESC" | "ASC") =>
			(
				this.db
					.prepare(
						`SELECT price,
						        SUM(CAST(base_total AS INTEGER) - CAST(base_filled AS INTEGER)) AS base
						   FROM ord
						  WHERE market = ? AND side = ? AND state = 'open'
						  GROUP BY price
						 HAVING base > 0
						  ORDER BY CAST(price AS INTEGER) ${dir}
						  LIMIT ?`,
					)
					.all(symbol, s, depth) as { price: string; base: number | bigint }[]
			).map((r) => ({ price: BigInt(r.price), base: BigInt(r.base) }));
		return { bids: side("buy", "DESC"), asks: side("sell", "ASC") };
	}

	recentTrades(symbol: string, limit = 30): {
		price: bigint;
		base: bigint;
		takerSide: OrderSide;
		at: string;
	}[] {
		market(symbol);
		const rows = this.db
			.prepare(
				`SELECT price, base_amount, taker_side, at FROM trade
				  WHERE market = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
			)
			.all(symbol, limit) as {
			price: string;
			base_amount: string;
			taker_side: string;
			at: string;
		}[];
		return rows.map((r) => ({
			price: BigInt(r.price),
			base: BigInt(r.base_amount),
			takerSide: r.taker_side as OrderSide,
			at: r.at,
		}));
	}

	/** Last traded price, or undefined if the market has never traded. */
	lastPrice(symbol: string): bigint | undefined {
		const r = this.db
			.prepare(
				`SELECT price FROM trade WHERE market = ? ORDER BY at DESC, rowid DESC LIMIT 1`,
			)
			.get(symbol) as { price: string } | undefined;
		return r === undefined ? undefined : BigInt(r.price);
	}
}

function sha(s: string): string {
	// Sessions are stored hashed so a database read does not yield live
	// bearer tokens.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require("node:crypto").createHash("sha256").update(s).digest("hex");
}
