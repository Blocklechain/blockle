// -----------------------------------------------------------------------------
// APPEND-ONLY DOUBLE-ENTRY LEDGER.
//
// WHY DOUBLE ENTRY, AND NOT A BALANCE COLUMN.
//
// The schema we are building on records what a customer owns in exactly one
// place: `wallets.balance`, a mutable decimal column. That design cannot answer
// the two questions an exchange is always eventually asked —
//
//   "why is this balance what it is?"        (there is no history to read)
//   "do our books add up to what we hold?"   (there is nothing to add up)
//
// — and it cannot survive a bug, because once a wrong UPDATE lands there is no
// record of what the value was or what moved it.
//
// Here every movement of value is a TRANSACTION containing two or more
// POSTINGS. Postings are immutable: no UPDATE, no DELETE, enforced by SQLite
// triggers rather than by convention, because "we agreed not to" is not a
// control. A balance is not stored as authoritative state, it is DERIVED as
// the sum of an account's postings.
//
// THE CENTRAL INVARIANT: within one transaction, the postings for each asset
// sum to exactly zero. Value is never created or destroyed, only moved between
// accounts. Checked in code before insert AND re-checkable over the whole
// ledger afterwards (`verify()`). This is what makes reconciliation against
// BitGo meaningful: if the books are internally consistent and the books match
// custody, the venue is solvent, and both halves are mechanically provable.
//
// A correction is never an edit. It is a new, equal-and-opposite transaction
// that references the original. The mistake stays visible, which is the point.
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

import { assertCustodyId, settlementAsset } from "./assets";

/**
 * Accounts are typed, because the invariants differ per type and a flat
 * namespace would let a bug credit the wrong KIND of account unnoticed.
 */
export enum AccountKind {
	/** A customer's entitlement to an asset. Must never go negative. */
	USER = "user",
	/** What we actually hold with the custodian. Must never go negative. */
	CUSTODY = "custody",
	/** Venue fee revenue. */
	FEES = "fees",
	/** Withdrawals debited from a user but not yet confirmed on chain. */
	INFLIGHT = "inflight",
	/**
	 * The counter-account for value entering or leaving the venue entirely.
	 * Deliberately UNBOUNDED and expected to be large and negative: it is the
	 * outside world, not a pot of money. Every deposit is
	 * (external -> custody), every withdrawal ends (inflight -> external).
	 */
	EXTERNAL = "external",
}

/** Accounts that may never hold a negative balance. */
const NON_NEGATIVE: ReadonlySet<AccountKind> = new Set([
	AccountKind.USER,
	AccountKind.CUSTODY,
	AccountKind.FEES,
	AccountKind.INFLIGHT,
]);

export interface AccountRef {
	readonly kind: AccountKind;
	/** Customer id for USER accounts; empty for venue-level accounts. */
	readonly owner: string;
	readonly asset: string;
}

/** Canonical account identity. Stable, because it is written into every row. */
export function accountId(a: AccountRef): string {
	return `${a.kind}:${a.owner}:${a.asset}`;
}

export interface Posting {
	readonly account: AccountRef;
	/** Signed base units. Positive credits the account, negative debits it. */
	readonly delta: bigint;
}

export enum Reason {
	DEPOSIT = "deposit",
	WITHDRAWAL_REQUEST = "withdrawal_request",
	WITHDRAWAL_SETTLE = "withdrawal_settle",
	WITHDRAWAL_REVERSE = "withdrawal_reverse",
	TRADE = "trade",
	FEE = "fee",
	/**
	 * Moving accrued fee revenue out of FEES into an account the venue can
	 * actually trade or withdraw from.
	 *
	 * Its own reason rather than an ADJUSTMENT so that the profit report can
	 * tell a transfer apart from income. Classified as neither: a sweep moves
	 * money the venue already owned, and counting it as revenue would let the
	 * same earnings be reported twice.
	 */
	FEE_SWEEP = "fee_sweep",
	/** Treasury putting its own funds in — notably to top up a gas float. */
	TREASURY_FUNDING = "treasury_funding",
	/** Operator-initiated. Always requires `actor` to name a human. */
	ADJUSTMENT = "adjustment",
	/** Equal-and-opposite reversal of a prior transaction. */
	CORRECTION = "correction",
}

export interface PostRequest {
	readonly reason: Reason;
	readonly postings: readonly Posting[];
	/**
	 * Caller-supplied uniqueness key. A retry with the same key is a NO-OP that
	 * returns the original transaction. This is how a replayed BitGo webhook,
	 * or a retried internal HTTP call, cannot double-credit.
	 *
	 * Must be derived from the EVENT, not from the attempt: for a deposit, the
	 * chain reference (`chain:txid:index`), never a random id or a timestamp.
	 */
	readonly idempotencyKey: string;
	/** Who caused this: a user id, "engine", or a named operator. */
	readonly actor: string;
	/** The transaction being corrected, for Reason.CORRECTION. */
	readonly correctsTxId?: number;
	readonly note?: string;
}

/**
 * What the venue owes in one settlement asset, split by whom it is owed to.
 *
 * `total` is the figure reconciliation compares against custody. The three
 * parts are what an operator needs in order to read that figure: a rising
 * `fees` is revenue, a rising `user` is deposits, and they are not the same
 * news. See `Ledger.liabilityBreakdown`.
 */
export interface LiabilityBreakdown {
	readonly user: bigint;
	readonly fees: bigint;
	readonly inflight: bigint;
	readonly total: bigint;
}

export interface LedgerTx {
	readonly id: number;
	readonly reason: Reason;
	readonly idempotencyKey: string;
	readonly actor: string;
	readonly createdAt: string;
	readonly hash: string;
	readonly prevHash: string;
	readonly postings: readonly Posting[];
	/**
	 * The transaction this one reverses, for CORRECTION.
	 *
	 * Readable, not just stored: an auditor tracing a balance needs to get from
	 * a correction back to what it corrected.
	 */
	readonly correctsTxId: number | undefined;
	/**
	 * The operator's explanation, for ADJUSTMENT and CORRECTION.
	 *
	 * `post()` requires a note on an ADJUSTMENT, so it must also be readable —
	 * an explanation that can be written but never retrieved satisfies the
	 * check and fails the purpose.
	 */
	readonly note: string | undefined;
	/** True when this call matched an existing key and wrote nothing. */
	readonly replayed: boolean;
}

export class LedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerError";
	}
}

/** Insufficient funds is distinguishable, because callers must handle it. */
export class InsufficientFunds extends LedgerError {
	constructor(
		readonly account: string,
		readonly balance: bigint,
		readonly requested: bigint,
	) {
		super(`${account} has ${balance} but ${requested} was debited`);
		this.name = "InsufficientFunds";
	}
}

const GENESIS = "0".repeat(64);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_tx (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reason           TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  actor            TEXT    NOT NULL,
  corrects_tx_id   INTEGER REFERENCES ledger_tx(id),
  note             TEXT,
  created_at       TEXT    NOT NULL,
  prev_hash        TEXT    NOT NULL,
  hash             TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_posting (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id       INTEGER NOT NULL REFERENCES ledger_tx(id),
  account_id  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  owner       TEXT    NOT NULL,
  asset       TEXT    NOT NULL,
  -- Base units as TEXT, not INTEGER: SQLite's INTEGER is 64-bit and 10^18-scale
  -- token amounts overflow it. TEXT holds the exact bigint decimal string.
  delta       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posting_account ON ledger_posting(account_id);
CREATE INDEX IF NOT EXISTS idx_posting_tx      ON ledger_posting(tx_id);

-- APPEND-ONLY, ENFORCED BY THE DATABASE. Code can be bypassed by the next
-- developer in a hurry; a trigger cannot.
CREATE TRIGGER IF NOT EXISTS ledger_tx_no_update
BEFORE UPDATE ON ledger_tx
BEGIN SELECT RAISE(ABORT, 'ledger_tx is append-only'); END;

CREATE TRIGGER IF NOT EXISTS ledger_tx_no_delete
BEFORE DELETE ON ledger_tx
BEGIN SELECT RAISE(ABORT, 'ledger_tx is append-only'); END;

CREATE TRIGGER IF NOT EXISTS ledger_posting_no_update
BEFORE UPDATE ON ledger_posting
BEGIN SELECT RAISE(ABORT, 'ledger_posting is append-only'); END;

CREATE TRIGGER IF NOT EXISTS ledger_posting_no_delete
BEFORE DELETE ON ledger_posting
BEGIN SELECT RAISE(ABORT, 'ledger_posting is append-only'); END;
`;

interface TxRow {
	id: number;
	reason: string;
	idempotency_key: string;
	actor: string;
	corrects_tx_id: number | null;
	note: string | null;
	created_at: string;
	prev_hash: string;
	hash: string;
}

interface PostingRow {
	account_id: string;
	kind: string;
	owner: string;
	asset: string;
	delta: string;
}

export class Ledger {
	constructor(private readonly db: Database) {
		db.exec(SCHEMA);
	}

	/**
	 * Append a transaction.
	 *
	 * Runs entirely inside one IMMEDIATE SQLite transaction, so the balance
	 * checks below cannot be raced: a concurrent writer is blocked until this
	 * commits. Checking a balance and then debiting it in two separate
	 * transactions is the classic double-spend in an exchange, and the reason
	 * `better-sqlite3`'s synchronous API is an asset here rather than a
	 * limitation.
	 */
	post(req: PostRequest): LedgerTx {
		const run = this.db.transaction((r: PostRequest): LedgerTx => {
			const existing = this.byIdempotencyKey(r.idempotencyKey);
			if (existing !== undefined) {
				// A replay. Returning the original rather than throwing is what
				// makes callers safe to retry blindly, which is what makes a
				// webhook or an internal HTTP call safe at all.
				return { ...existing, replayed: true };
			}

			this.validate(r);

			// Every account that loses value must be able to afford it. Read the
			// balance INSIDE the transaction; see the note above.
			const net = new Map<string, { ref: AccountRef; delta: bigint }>();
			for (const p of r.postings) {
				const id = accountId(p.account);
				const cur = net.get(id);
				if (cur === undefined) net.set(id, { ref: p.account, delta: p.delta });
				else cur.delta += p.delta;
			}
			for (const [id, { ref, delta }] of net) {
				if (delta >= 0n || !NON_NEGATIVE.has(ref.kind)) continue;
				const bal = this.balance(ref);
				if (bal + delta < 0n) throw new InsufficientFunds(id, bal, -delta);
			}

			const prevHash = this.headHash();
			const createdAt = new Date().toISOString();
			const hash = txHash({
				prevHash,
				reason: r.reason,
				idempotencyKey: r.idempotencyKey,
				actor: r.actor,
				createdAt,
				postings: r.postings,
			});

			const info = this.db
				.prepare(
					`INSERT INTO ledger_tx
					   (reason, idempotency_key, actor, corrects_tx_id, note,
					    created_at, prev_hash, hash)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					r.reason,
					r.idempotencyKey,
					r.actor,
					r.correctsTxId ?? null,
					r.note ?? null,
					createdAt,
					prevHash,
					hash,
				);
			const txId = Number(info.lastInsertRowid);

			const ins = this.db.prepare(
				`INSERT INTO ledger_posting
				   (tx_id, account_id, kind, owner, asset, delta)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const p of r.postings) {
				ins.run(
					txId,
					accountId(p.account),
					p.account.kind,
					p.account.owner,
					p.account.asset,
					p.delta.toString(),
				);
			}

			return {
				id: txId,
				reason: r.reason,
				idempotencyKey: r.idempotencyKey,
				actor: r.actor,
				createdAt,
				hash,
				prevHash,
				correctsTxId: r.correctsTxId,
				note: r.note,
				postings: r.postings,
				replayed: false,
			};
		});

		// `immediate` takes the write lock up front rather than upgrading from a
		// read lock mid-transaction, which is what produces SQLITE_BUSY under
		// concurrency.
		return run.immediate(req);
	}

	/** Reject malformed transactions before any row is written. */
	private validate(r: PostRequest): void {
		if (r.postings.length < 2) {
			throw new LedgerError(
				`a transaction needs at least two postings, got ${r.postings.length}` +
					" — value must move between accounts, not appear",
			);
		}
		if (r.idempotencyKey.trim() === "") {
			throw new LedgerError("idempotencyKey is required");
		}
		if (r.actor.trim() === "") {
			throw new LedgerError("actor is required — every movement is attributable");
		}
		if (r.reason === Reason.ADJUSTMENT && !r.note) {
			throw new LedgerError("an ADJUSTMENT must carry a note explaining it");
		}
		if (r.reason === Reason.CORRECTION && r.correctsTxId === undefined) {
			throw new LedgerError("a CORRECTION must name the transaction it corrects");
		}

		// THE CENTRAL INVARIANT: zero sum per SETTLEMENT ASSET.
		//
		// Not per raw asset id. A USDT deposit arriving over Tron credits
		// `custody::USDT.TRC20` (inventory, chain-specific) and
		// `user:alice:USDT` (liability, fungible). Those are different asset
		// ids but the same settlement asset, and the transaction balances at
		// that level — which is the level at which fungibility is actually
		// true. See assets.ts for why USDT on two chains is two tokens.
		//
		// The invariant is not weakened: value still cannot be created or
		// destroyed. It is stated where it is meaningful.
		const perAsset = new Map<string, bigint>();
		for (const p of r.postings) {
			if (p.delta === 0n) {
				throw new LedgerError("a zero-delta posting records nothing; omit it");
			}
			if (p.account.kind === AccountKind.USER && p.account.owner.trim() === "") {
				throw new LedgerError("a USER posting must name its owner");
			}
			if (p.account.asset.trim() === "") throw new LedgerError("asset is required");

			// CUSTODY and EXTERNAL postings name a chain; USER, FEES and
			// INFLIGHT do not. An unqualified custody holding cannot be
			// reconciled against any chain, and a qualified user balance would
			// fragment a liability that is fungible to the customer.
			if (
				p.account.kind === AccountKind.CUSTODY ||
				p.account.kind === AccountKind.EXTERNAL
			) {
				assertCustodyId(p.account.asset);
			} else if (p.account.asset.includes(".")) {
				throw new LedgerError(
					`${p.account.kind} balances are fungible to the customer, so ` +
						`"${p.account.asset}" must not name a network — use ` +
						`${settlementAsset(p.account.asset)}`,
				);
			}

			const key = settlementAsset(p.account.asset);
			perAsset.set(key, (perAsset.get(key) ?? 0n) + p.delta);
		}
		for (const [asset, sum] of perAsset) {
			if (sum !== 0n) {
				throw new LedgerError(
					`postings for ${asset} sum to ${sum}, not zero — ` +
						"value would be created or destroyed",
				);
			}
		}
	}

	/** An account's balance, derived from its postings. Never cached state. */
	balance(a: AccountRef): bigint {
		const rows = this.db
			.prepare(`SELECT delta FROM ledger_posting WHERE account_id = ?`)
			.all(accountId(a)) as { delta: string }[];
		let sum = 0n;
		for (const r of rows) sum += BigInt(r.delta);
		return sum;
	}

	/** Every account holding a non-zero balance in an asset. */
	balances(asset: string): Map<string, bigint> {
		const rows = this.db
			.prepare(
				`SELECT account_id, delta FROM ledger_posting WHERE asset = ?`,
			)
			.all(asset) as { account_id: string; delta: string }[];
		const out = new Map<string, bigint>();
		for (const r of rows) {
			out.set(r.account_id, (out.get(r.account_id) ?? 0n) + BigInt(r.delta));
		}
		for (const [k, v] of out) if (v === 0n) out.delete(k);
		return out;
	}

	/**
	 * Custody inventory per network for a settlement asset.
	 *
	 *     custodyByNetwork("USDT") -> { "USDT.TRC20": 150n, "USDT.ERC20": 300n }
	 *     custodyByNetwork("BTC")  -> { "BTC": 42n }
	 *
	 * This is the number that decides whether a withdrawal over a given chain
	 * can actually be paid, and it is what the public liquidity view publishes.
	 * A single total would be a lie: holding 450 USDT across three chains does
	 * not mean a 400 USDT withdrawal over Tron can be honoured.
	 */
	custodyByNetwork(symbol: string): Map<string, bigint> {
		const rows = this.db
			.prepare(
				`SELECT asset, delta FROM ledger_posting
				  WHERE kind = ? AND (asset = ? OR asset LIKE ?)`,
			)
			.all(AccountKind.CUSTODY, symbol, `${symbol}.%`) as {
			asset: string;
			delta: string;
		}[];
		const out = new Map<string, bigint>();
		for (const r of rows) {
			out.set(r.asset, (out.get(r.asset) ?? 0n) + BigInt(r.delta));
		}
		return out;
	}

	/**
	 * Liability for a settlement asset, SPLIT BY WHO IS OWED.
	 *
	 *   user      what customers are entitled to
	 *   fees      the venue's own accrued revenue, not yet swept
	 *   inflight  withdrawals already debited from a customer but not yet
	 *             confirmed on chain — still ours to hold, not yet gone
	 *   total     the sum, and the number the reconciler compares to custody
	 *
	 * WHY THIS EXISTS AND WHY `liabilities()` NOW DELEGATES TO IT.
	 *
	 * The operator treasury view has to show "owed to customers" and "ours"
	 * separately — an operator who cannot tell those apart cannot tell a
	 * healthy fee balance from a customer liability. The obvious way to get
	 * that is a second query per kind, and that is precisely the trap: there
	 * would then be two independent derivations of the same figure, and the
	 * day they disagreed an operator would have no way to know which to
	 * believe. Two numbers that can disagree is how someone stops trusting
	 * both.
	 *
	 * So the lump sum is DERIVED from the breakdown rather than computed
	 * beside it. One query, one set of rows, one summation; `liabilities()` is
	 * `breakdown.total` by construction, so reconcile.ts and the treasury
	 * panel cannot drift apart even if someone later changes the kind list.
	 *
	 * SUMMED IN JAVASCRIPT OVER BIGINTS, NOT IN SQL. `delta` is TEXT because
	 * an 18-decimal amount does not fit SQLite's 64-bit INTEGER, and SQLite's
	 * CAST CLAMPS INSTEAD OF ERRORING: `CAST('9300000000000000000' AS
	 * INTEGER)` and `CAST('9500000000000000000' AS INTEGER)` are both
	 * 9223372036854775807 and compare EQUAL. A `SUM(delta)` here would coerce
	 * to a float and round the venue's own solvency figure. This project has
	 * already been bitten by exactly that in the order book's depth
	 * aggregation (see venue.ts) — about 9.2 ETH in wei is where it starts,
	 * which is one ordinary price level.
	 */
	liabilityBreakdown(symbol: string): LiabilityBreakdown {
		const rows = this.db
			.prepare(
				`SELECT kind, delta FROM ledger_posting
				  WHERE kind IN (?, ?, ?) AND (asset = ? OR asset LIKE ?)`,
			)
			.all(
				AccountKind.USER,
				AccountKind.FEES,
				AccountKind.INFLIGHT,
				symbol,
				`${symbol}.%`,
			) as { kind: string; delta: string }[];
		let user = 0n;
		let fees = 0n;
		let inflight = 0n;
		for (const r of rows) {
			const d = BigInt(r.delta);
			if (r.kind === AccountKind.USER) user += d;
			else if (r.kind === AccountKind.FEES) fees += d;
			else inflight += d;
		}
		return { user, fees, inflight, total: user + fees + inflight };
	}

	/** Total liability for a settlement asset: users + fees + in-flight. */
	liabilities(symbol: string): bigint {
		return this.liabilityBreakdown(symbol).total;
	}

	/**
	 * Every customer's balance in a settlement asset, INCLUDING THE ZEROES.
	 *
	 * NOT `balances()`, and the difference is load-bearing twice over:
	 *
	 *   1. `balances()` matches the asset column EXACTLY and returns every
	 *      kind keyed by account id — custody, fees and external included. A
	 *      caller that wanted "what do customers hold" and reached for it
	 *      would get the venue's own accounts mixed in with the customers'.
	 *      This filters to USER and groups by SETTLEMENT asset, which is the
	 *      level at which a customer's USDT is one balance rather than three.
	 *
	 *   2. `balances()` deletes zero entries. For a customer-facing view that
	 *      is right; for an operator drill-down it hides the finding. An
	 *      account at zero that still has funds reserved against resting
	 *      orders is an overcommitted account, and dropping the row is exactly
	 *      how that stays invisible. An empty rail must read as empty, not as
	 *      absent.
	 *
	 * Summed in JavaScript over bigints for the reason spelt out on
	 * `liabilityBreakdown` above: a SQL SUM over this TEXT column clamps at
	 * int64 without saying so.
	 */
	userBalances(symbol: string): Map<string, bigint> {
		const rows = this.db
			.prepare(
				`SELECT owner, delta FROM ledger_posting
				  WHERE kind = ? AND (asset = ? OR asset LIKE ?)`,
			)
			.all(AccountKind.USER, symbol, `${symbol}.%`) as {
			owner: string;
			delta: string;
		}[];
		const out = new Map<string, bigint>();
		for (const r of rows) {
			out.set(r.owner, (out.get(r.owner) ?? 0n) + BigInt(r.delta));
		}
		return out;
	}

	byIdempotencyKey(key: string): LedgerTx | undefined {
		const row = this.db
			.prepare(`SELECT * FROM ledger_tx WHERE idempotency_key = ?`)
			.get(key) as TxRow | undefined;
		if (row === undefined) return undefined;
		return this.hydrate(row);
	}

	get(id: number): LedgerTx | undefined {
		const row = this.db.prepare(`SELECT * FROM ledger_tx WHERE id = ?`).get(id) as
			| TxRow
			| undefined;
		return row === undefined ? undefined : this.hydrate(row);
	}

	/** An account's movements, newest first — the "why is my balance this?" answer. */
	history(a: AccountRef, limit = 100): readonly (LedgerTx & { delta: bigint })[] {
		const rows = this.db
			.prepare(
				`SELECT t.*, p.delta AS p_delta
				   FROM ledger_posting p
				   JOIN ledger_tx t ON t.id = p.tx_id
				  WHERE p.account_id = ?
				  ORDER BY p.id DESC
				  LIMIT ?`,
			)
			.all(accountId(a), limit) as (TxRow & { p_delta: string })[];
		return rows.map((r) => ({ ...this.hydrate(r), delta: BigInt(r.p_delta) }));
	}

	private hydrate(row: TxRow): LedgerTx {
		const ps = this.db
			.prepare(
				`SELECT account_id, kind, owner, asset, delta
				   FROM ledger_posting WHERE tx_id = ? ORDER BY id`,
			)
			.all(row.id) as PostingRow[];
		return {
			id: row.id,
			reason: row.reason as Reason,
			idempotencyKey: row.idempotency_key,
			actor: row.actor,
			createdAt: row.created_at,
			hash: row.hash,
			prevHash: row.prev_hash,
			correctsTxId: row.corrects_tx_id ?? undefined,
			note: row.note ?? undefined,
			postings: ps.map((p) => ({
				account: {
					kind: p.kind as AccountKind,
					owner: p.owner,
					asset: p.asset,
				},
				delta: BigInt(p.delta),
			})),
			replayed: false,
		};
	}

	private headHash(): string {
		const row = this.db
			.prepare(`SELECT hash FROM ledger_tx ORDER BY id DESC LIMIT 1`)
			.get() as { hash: string } | undefined;
		return row?.hash ?? GENESIS;
	}

	/**
	 * Reverse a transaction with an equal-and-opposite one.
	 *
	 * The original is never touched. A ledger whose history can be edited is
	 * not evidence of anything, and the whole purpose of this table is to be
	 * evidence.
	 */
	reverse(txId: number, actor: string, note: string): LedgerTx {
		const orig = this.get(txId);
		if (orig === undefined) throw new LedgerError(`no transaction ${txId}`);
		return this.post({
			reason: Reason.CORRECTION,
			postings: orig.postings.map((p) => ({ account: p.account, delta: -p.delta })),
			idempotencyKey: `correction:${txId}`,
			actor,
			correctsTxId: txId,
			note,
		});
	}

	/**
	 * Re-prove the whole ledger: the hash chain is intact, and every
	 * transaction still sums to zero per asset.
	 *
	 * Catches tampering (a row changed out-of-band, around the triggers, via a
	 * direct file edit or a restored backup) and catches any future code path
	 * that manages to write an unbalanced transaction. Meant to run on a timer
	 * in production, not just in tests.
	 */
	verify(): { ok: true; transactions: number } | { ok: false; errors: string[] } {
		const errors: string[] = [];
		const rows = this.db
			.prepare(`SELECT * FROM ledger_tx ORDER BY id`)
			.all() as TxRow[];

		let prev = GENESIS;
		for (const row of rows) {
			const tx = this.hydrate(row);

			if (row.prev_hash !== prev) {
				errors.push(
					`tx ${row.id}: prev_hash ${row.prev_hash.slice(0, 12)} ` +
						`breaks the chain (expected ${prev.slice(0, 12)})`,
				);
			}
			const expect = txHash({
				prevHash: row.prev_hash,
				reason: tx.reason,
				idempotencyKey: tx.idempotencyKey,
				actor: tx.actor,
				createdAt: tx.createdAt,
				postings: tx.postings,
			});
			if (expect !== row.hash) {
				errors.push(`tx ${row.id}: contents do not match its hash — altered`);
			}

			// Same grouping as post(). If these two disagreed, verify() would
			// condemn transactions that post() correctly accepted.
			const perAsset = new Map<string, bigint>();
			for (const p of tx.postings) {
				const key = settlementAsset(p.account.asset);
				perAsset.set(key, (perAsset.get(key) ?? 0n) + p.delta);
			}
			for (const [asset, sum] of perAsset) {
				if (sum !== 0n) errors.push(`tx ${row.id}: ${asset} sums to ${sum}, not zero`);
			}

			prev = row.hash;
		}

		// No bounded account may be negative. Cheap, and the failure it catches
		// (a customer owing the venue money) is one we must never ship.
		const negatives = this.db
			.prepare(
				`SELECT account_id, kind, SUM(CAST(delta AS REAL)) AS approx
				   FROM ledger_posting
				  GROUP BY account_id
				 HAVING approx < 0`,
			)
			.all() as { account_id: string; kind: string; approx: number }[];
		for (const n of negatives) {
			if (!NON_NEGATIVE.has(n.kind as AccountKind)) continue;
			// REAL is only a prefilter — re-sum exactly before accusing anyone.
			const exact = this.db
				.prepare(`SELECT delta FROM ledger_posting WHERE account_id = ?`)
				.all(n.account_id) as { delta: string }[];
			let sum = 0n;
			for (const r of exact) sum += BigInt(r.delta);
			if (sum < 0n) errors.push(`${n.account_id} is negative (${sum})`);
		}

		return errors.length === 0
			? { ok: true, transactions: rows.length }
			: { ok: false, errors };
	}
}

/**
 * Hash over the transaction's semantic content, with the postings in a
 * canonical order so that an equivalent transaction hashes the same regardless
 * of the order the caller happened to list them in.
 */
function txHash(t: {
	prevHash: string;
	reason: string;
	idempotencyKey: string;
	actor: string;
	createdAt: string;
	postings: readonly Posting[];
}): string {
	const sorted = [...t.postings]
		.map((p) => `${accountId(p.account)}=${p.delta.toString()}`)
		.sort();
	const h = createHash("sha256");
	h.update(
		[t.prevHash, t.reason, t.idempotencyKey, t.actor, t.createdAt, ...sorted].join("\n"),
	);
	return h.digest("hex");
}
