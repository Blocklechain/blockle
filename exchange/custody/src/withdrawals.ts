// -----------------------------------------------------------------------------
// WITHDRAWAL STATE MACHINE — the only path by which customer funds leave.
//
// Everything here is ordered around one rule: THE CUSTOMER IS DEBITED BEFORE
// ANYTHING IS SENT. The tempting order is to send first and debit on
// confirmation, because then a failed send needs no cleanup. It is also how
// exchanges get drained: two concurrent requests for the same balance both read
// "sufficient funds", both pass, and both get paid. Debiting first, inside the
// ledger's row lock, makes the second request fail on arithmetic rather than on
// a race.
//
// THE DEBIT IS NOT A DELETION. It moves the balance from the customer's account
// into INFLIGHT, which is still a liability of the venue — the money is ours to
// honour until it is on chain. That is why INFLIGHT counts toward liabilities in
// reconciliation: a withdrawal in progress is not a withdrawal completed, and a
// venue that stopped counting it would appear to hold a surplus.
//
// THE TRANSITION TABLE IS THE SAFETY PROPERTY, not a formality. Two edges in
// particular are the whole point of having a machine at all:
//
//   * SUBMITTED is a POINT OF NO RETURN for reversal. Once the custodian has
//     been told to send, the funds may already be on chain and irreversible.
//     From there the only honest outcomes are CONFIRMED or a provider-asserted
//     FAILED. Code that "cancels" a submitted withdrawal by crediting the
//     customer back has just paid them twice.
//
//   * REJECTED and FAILED must reverse the debit EXACTLY ONCE. A reversal that
//     can run twice refunds twice; one that can run zero times silently keeps
//     the customer's money. Both are enforced here by the state machine plus
//     the ledger's idempotency key, which is derived from the withdrawal id.
//
// SCREENING AND CLEARANCE ARE SEPARATE from submission on purpose. Screening is
// a compliance obligation (sanctioned-address checks); clearance is a financial
// control. Collapsing either into the send path means a bug in it becomes a bug
// that moves money.
//
// WITHDRAWALS ARE AUTOMATIC. No operator reviews one, and nothing ever waits in
// a queue for a person — that is a deliberate product decision. What it does
// NOT mean is unbounded: the human approver has been replaced by machine
// controls, not deleted. Three of them, all enforced in code:
//
//   1. `maxPerRequest` — bounds any single withdrawal.
//   2. `velocityCap24h` — bounds the rolling-day TOTAL per account per asset.
//      This is the one that matters, because a per-request limit alone is
//      trivially defeated by issuing many requests. Without it, a stolen
//      session empties the venue at machine speed.
//   3. The reconciliation `Interlock` — refuses payouts for any asset whose
//      books and custody disagree. No human sets or clears it.
//
// All three FAIL CLOSED: an asset with no limit configured cannot be withdrawn
// at all, because with nobody in the loop a missing config entry would
// otherwise mean "no limit". And a breach AUTO-REJECTS and refunds rather than
// queueing, since queueing for a human is exactly what automation removes.
//
// Screening still runs first, and REQUESTED has no edge to SUBMITTED, so
// skipping it is structurally impossible rather than merely discouraged.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { assetDef, gasAssetFor } from "./assets";
import { checkGas, type GasGateDeps } from "./gasgate";
import {
	LIVE_FEES,
	quoteWithdrawal,
	type FeeTable,
	type GasPricing,
	type WithdrawalQuote,
} from "./withdrawalfees";
import {
	AccountKind,
	InsufficientFunds,
	Reason,
	type AccountRef,
	type Ledger,
} from "./ledger";

export enum State {
	/** Requested by the customer; funds debited to INFLIGHT. */
	REQUESTED = "requested",
	/** Destination address being screened. */
	SCREENING = "screening",
	/** Over the policy threshold; needs a second human. */
	AWAITING_APPROVAL = "awaiting_approval",
	/** Cleared to submit. Nothing has been sent yet. */
	APPROVED = "approved",
	/** Handed to the custodian. NO LONGER REVERSIBLE BY US. */
	SUBMITTED = "submitted",
	/** Final on chain; ledger settled. */
	CONFIRMED = "confirmed",
	/** Refused before submission; debit reversed. */
	REJECTED = "rejected",
	/** Submission or confirmation failed; debit reversed. */
	FAILED = "failed",
}

/** Terminal states. Nothing leaves these. */
const TERMINAL: ReadonlySet<State> = new Set([
	State.CONFIRMED,
	State.REJECTED,
	State.FAILED,
]);

/**
 * Legal transitions, written out rather than inferred.
 *
 * Note what is deliberately ABSENT: there is no SUBMITTED -> REJECTED edge.
 * A submitted withdrawal cannot be "cancelled" — only confirmed, or failed on
 * the custodian's own assertion that it never went out.
 */
const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
	[State.REQUESTED]: [State.SCREENING, State.REJECTED],
	[State.SCREENING]: [State.AWAITING_APPROVAL, State.APPROVED, State.REJECTED],
	[State.AWAITING_APPROVAL]: [State.APPROVED, State.REJECTED],
	[State.APPROVED]: [State.SUBMITTED, State.REJECTED],
	[State.SUBMITTED]: [State.CONFIRMED, State.FAILED],
	[State.CONFIRMED]: [],
	[State.REJECTED]: [],
	[State.FAILED]: [],
};

export class WithdrawalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WithdrawalError";
	}
}

/** An illegal transition is its own error type — callers branch on it. */
export class IllegalTransition extends WithdrawalError {
	constructor(
		readonly id: number,
		readonly from: State,
		readonly to: State,
	) {
		super(
			`withdrawal ${id} cannot go ${from} -> ${to}` +
				(from === State.SUBMITTED && to === State.REJECTED
					? " — a submitted withdrawal may already be on chain; " +
						"reversing it here would pay the customer twice"
					: ""),
		);
		this.name = "IllegalTransition";
	}
}

export interface ScreenResult {
	readonly allowed: boolean;
	/** Required when not allowed, so a refusal is always explainable. */
	readonly reason?: string;
}

export interface AddressScreener {
	readonly name: string;
	screen(asset: string, address: string): Promise<ScreenResult>;
}

export interface Policy {
	/**
	 * WITHDRAWALS RUN WITHOUT HUMAN INVOLVEMENT when true (the default and the
	 * configured behaviour for this venue). Screening passing sends a
	 * withdrawal straight to APPROVED; no operator sees it, and nothing ever
	 * sits in a queue waiting for one.
	 *
	 * WHAT REPLACES THE HUMAN. The second-approver threshold used to be the
	 * brake on a compromised session draining the venue at machine speed.
	 * Removing the human does not remove the need for a brake, so the brake is
	 * now mechanical: `maxPerRequest` bounds any single withdrawal and
	 * `velocityCap24h` bounds the total a single account can move in a rolling
	 * day. Both are enforced in code with no operator in the loop, and a
	 * breach AUTO-REJECTS rather than queueing — queueing for a human is
	 * exactly what this setting exists to avoid.
	 *
	 * Set false only if a human-approval tier is deliberately reintroduced.
	 */
	readonly autoApprove: boolean;
	/**
	 * Per-asset threshold above which a second human must approve. Consulted
	 * ONLY when `autoApprove` is false. Absent then means every withdrawal of
	 * that asset needs approval — failing CLOSED.
	 */
	readonly approvalThreshold: Readonly<Record<string, bigint>>;
	/** Per-asset hard ceiling. Absent means the asset cannot be withdrawn. */
	readonly maxPerRequest: Readonly<Record<string, bigint>>;
	/**
	 * Rolling 24-hour ceiling on the TOTAL a single account may withdraw per
	 * asset. Absent means the asset cannot be withdrawn — the same fail-closed
	 * rule as `maxPerRequest`, because with no human in the loop an
	 * unconfigured cap is an unbounded one.
	 *
	 * This is the control that matters most once approval is automatic:
	 * `maxPerRequest` alone is trivially defeated by issuing many requests.
	 */
	readonly velocityCap24h: Readonly<Record<string, bigint>>;
	/** Destination addresses must be pre-registered by the customer. */
	readonly requireAllowlistedAddress: boolean;
}

/**
 * Assets whose withdrawals are currently suspended by an operational
 * interlock — in practice, a reconciliation SHORTFALL or INTERNAL_BREAK.
 *
 * THIS IS NOT ADMIN OVERSIGHT. No human decides it and no human clears it by
 * judgement: the reconciler sets it mechanically when the books and custody
 * disagree, and it lifts when they agree again. It exists because paying out
 * while short spends other customers' assets, which stays true whether or not
 * a person is watching.
 */
export interface Interlock {
	/** True when withdrawals of this asset must not be submitted. */
	halted(asset: string): boolean;
	/** Why, for the rejection reason. */
	reason(asset: string): string;
}

/** The default interlock: nothing halted. Replaced by the reconciler in prod. */
export const OPEN: Interlock = {
	halted: () => false,
	reason: () => "",
};

export interface Withdrawal {
	readonly id: number;
	readonly userId: string;
	readonly asset: string;
	/** The chain it is routed over; undefined for single-chain assets. */
	readonly network: string | undefined;
	/** GROSS — what the customer asked for and what was debited. */
	readonly amount: bigint;
	/** Withheld by the venue: gas allowance plus margin. */
	readonly fee: bigint;
	/** What goes on chain. `amount - fee`. */
	readonly net: bigint;
	readonly address: string;
	readonly state: State;
	readonly requestTxId: number;
	readonly settleTxId: number | undefined;
	readonly reverseTxId: number | undefined;
	readonly providerRef: string | undefined;
	readonly reason: string | undefined;
	readonly approvedBy: string | undefined;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS withdrawal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT    NOT NULL,
  asset          TEXT    NOT NULL,
  -- WHICH CHAIN this withdrawal is routed over, e.g. 'TRC20'. NULL for
  -- single-chain assets. Without this column the liquidity view cannot tell
  -- how much of each chain's inventory is already spoken for, and would
  -- over-report availability — promising the same units to two customers.
  network        TEXT,
  -- base units as TEXT; see ledger.ts on SQLite's 64-bit INTEGER limit
  -- GROSS: what the customer asked for and what was debited.
  amount         TEXT    NOT NULL,
  -- The fee withheld, and the amount that actually goes on chain. Stored
  -- rather than recomputed because the fee depends on a rate observed at
  -- request time: recomputing it later would produce a different number and
  -- make the settlement postings fail to balance.
  fee            TEXT    NOT NULL DEFAULT '0',
  net            TEXT    NOT NULL DEFAULT '0',
  address        TEXT    NOT NULL,
  state          TEXT    NOT NULL,
  request_tx_id  INTEGER NOT NULL,
  settle_tx_id   INTEGER,
  reverse_tx_id  INTEGER,
  provider_ref   TEXT,
  reason         TEXT,
  approved_by    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_state ON withdrawal(state);
CREATE INDEX IF NOT EXISTS idx_withdrawal_user  ON withdrawal(user_id);

CREATE TABLE IF NOT EXISTS withdrawal_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  withdrawal_id INTEGER NOT NULL REFERENCES withdrawal(id),
  from_state  TEXT,
  to_state    TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  note        TEXT,
  at          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlisted_address (
  user_id  TEXT NOT NULL,
  asset    TEXT NOT NULL,
  address  TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, asset, address)
);

-- The audit trail of state changes is append-only for the same reason the
-- ledger is: it is evidence, and evidence that can be edited is not evidence.
CREATE TRIGGER IF NOT EXISTS withdrawal_event_no_update
BEFORE UPDATE ON withdrawal_event
BEGIN SELECT RAISE(ABORT, 'withdrawal_event is append-only'); END;

CREATE TRIGGER IF NOT EXISTS withdrawal_event_no_delete
BEFORE DELETE ON withdrawal_event
BEGIN SELECT RAISE(ABORT, 'withdrawal_event is append-only'); END;
`;

interface Row {
	id: number;
	user_id: string;
	asset: string;
	network: string | null;
	amount: string;
	fee: string | null;
	net: string | null;
	address: string;
	state: string;
	request_tx_id: number;
	settle_tx_id: number | null;
	reverse_tx_id: number | null;
	provider_ref: string | null;
	reason: string | null;
	approved_by: string | null;
	created_at: string;
	updated_at: string;
}

const userAcct = (id: string, asset: string): AccountRef => ({
	kind: AccountKind.USER,
	owner: id,
	asset,
});
const inflight = (asset: string): AccountRef => ({
	kind: AccountKind.INFLIGHT,
	owner: "",
	asset,
});
const custodyAcct = (asset: string): AccountRef => ({
	kind: AccountKind.CUSTODY,
	owner: "",
	asset,
});
const externalAcct = (asset: string): AccountRef => ({
	kind: AccountKind.EXTERNAL,
	owner: "",
	asset,
});

export class Withdrawals {
	private readonly interlock: Interlock;
	private readonly now: () => number;

	private readonly feeTable: FeeTable;
	private readonly pricing: GasPricing | undefined;
	private readonly gas: GasGateDeps | undefined;
	private readonly reservedOf:
		| ((userId: string, asset: string) => bigint)
		| undefined;
	private readonly requireReservedCheck: boolean;

	constructor(
		private readonly db: Database,
		private readonly ledger: Ledger,
		private readonly policy: Policy,
		opts: {
			/** Reconciliation interlock. Defaults to OPEN (nothing halted). */
			interlock?: Interlock;
			/** Clock, injectable so the velocity window is testable. */
			now?: () => number;
			/** Fee schedule. Defaults to the live table. */
			feeTable?: FeeTable;
			/** Gas pricing for the fee. Defaults to the configured policy floor. */
			pricing?: GasPricing;
			/**
			 * Gas-float gate. When supplied, a token withdrawal is refused unless
			 * we hold enough of the GAS asset to send it — see gasgate.ts.
			 *
			 * Optional only so that tests about other things need not construct a
			 * gas position. In production it is always wired, and
			 * `requireGasGate` makes its absence loud rather than silent.
			 */
			gas?: GasGateDeps;
			/**
			 * Refuse every withdrawal when no gas gate is configured.
			 *
			 * The live service sets this. Without it, forgetting to wire the gate
			 * means tokens withdraw with no gas check at all — a silent
			 * regression that only shows up as stuck withdrawals.
			 */
			requireGasGate?: boolean;
			/**
			 * How much of an asset this account has RESERVED against open orders.
			 *
			 * The ledger cannot answer this. A reservation is not a posting — it
			 * is derived from the open-order table — so `ledger.post` only ever
			 * enforces that the TOTAL stays non-negative. Without this, a
			 * customer can withdraw the collateral behind their own live orders.
			 */
			reserved?: (userId: string, asset: string) => bigint;
			/**
			 * Refuse every withdrawal when no reservation source is configured.
			 *
			 * Same reasoning as `requireGasGate`: the live service sets this, so
			 * that forgetting to wire `reserved` is a loud refusal rather than a
			 * silent return to overcommitment.
			 */
			requireReservedCheck?: boolean;
		} = {},
	) {
		db.exec(SCHEMA);
		this.migrate();
		this.interlock = opts.interlock ?? OPEN;
		this.now = opts.now ?? ((): number => Date.now());
		this.feeTable = opts.feeTable ?? LIVE_FEES;
		this.pricing = opts.pricing;
		this.gas = opts.gas;
		this.requireGasGate = opts.requireGasGate ?? false;
		this.reservedOf = opts.reserved;
		this.requireReservedCheck = opts.requireReservedCheck ?? false;
	}

	private readonly requireGasGate: boolean;

	/**
	 * Add columns that post-date the first deployment.
	 *
	 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
	 * so a new column in SCHEMA is invisible to any database that has already
	 * been created — which, for a venue that is already taking withdrawals,
	 * means every real one.
	 */
	private migrate(): void {
		const cols = (
			this.db.prepare(`PRAGMA table_info(withdrawal)`).all() as { name: string }[]
		).map((c) => c.name);
		const add = (name: string, def: string): void => {
			if (!cols.includes(name)) {
				this.db.exec(`ALTER TABLE withdrawal ADD COLUMN ${name} ${def}`);
			}
		};
		add("network", "TEXT");
		add("fee", "TEXT NOT NULL DEFAULT '0'");
		add("net", "TEXT NOT NULL DEFAULT '0'");
		// Backfill rows that predate fees: nothing was withheld, so the whole
		// amount was the net. A zero net on a non-zero amount is not a real
		// state — it can only be an unmigrated row.
		this.db
			.prepare(
				`UPDATE withdrawal SET net = amount
				  WHERE net = '0' AND fee = '0' AND amount != '0'`,
			)
			.run();
	}

	/**
	 * THE ONLY CLOCK READ IN THIS CLASS.
	 *
	 * Every timestamp — row creation, state events, allowlist entries — comes
	 * from here, so the velocity window in `rolling24h` is measured against the
	 * same clock that stamped the rows it is summing. The first version read
	 * `Date.now()` directly in four places while `rolling24h` used the injected
	 * clock, which made the 24-hour window straddle two different clocks. The
	 * test for the rolling window then passed or failed depending on the time
	 * of day it ran — a flake, and a sign that the production code was
	 * measuring an interval against two sources of truth.
	 */
	private stamp(): string {
		return new Date(this.now()).toISOString();
	}

	/** Register a destination address the customer is allowed to withdraw to. */
	/**
	 * How long a newly allowlisted address must age before it can be paid.
	 *
	 * THE COOLING-OFF PERIOD IS THE POINT OF AN ALLOWLIST. Without it, someone
	 * holding a stolen session adds their own address and withdraws in the same
	 * minute, and the control has cost them one extra request. With it, the
	 * theft needs the session to stay live for a day — long enough for the
	 * "a new withdrawal address was added" mail to reach a human who did not
	 * add it.
	 *
	 * Note the asymmetry this creates and keep it: adding is slow, REMOVING is
	 * immediate, because removal only ever narrows what can be paid.
	 */
	static readonly ALLOWLIST_COOLDOWN_MS = 24 * 60 * 60 * 1000;

	allowlist(userId: string, asset: string, address: string): void {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO allowlisted_address
				   (user_id, asset, address, added_at) VALUES (?, ?, ?, ?)`,
			)
			.run(userId, asset, address, this.stamp());
	}

	/** Membership only. For "can this be paid NOW", use `allowlistStatus`. */
	isAllowlisted(userId: string, asset: string, address: string): boolean {
		const row = this.db
			.prepare(
				`SELECT 1 FROM allowlisted_address
				  WHERE user_id = ? AND asset = ? AND address = ?`,
			)
			.get(userId, asset, address);
		return row !== undefined;
	}

	/**
	 * Membership AND maturity, which are different questions — an address can be
	 * on the list and still not payable yet.
	 */
	allowlistStatus(
		userId: string,
		asset: string,
		address: string,
	): { listed: boolean; usableAt: number | undefined } {
		const row = this.db
			.prepare(
				`SELECT added_at FROM allowlisted_address
				  WHERE user_id = ? AND asset = ? AND address = ?`,
			)
			.get(userId, asset, address) as { added_at: string } | undefined;
		if (row === undefined) return { listed: false, usableAt: undefined };
		const added = Date.parse(row.added_at);
		// An unparseable timestamp must not read as "mature". Treating it as
		// freshly added is the safe direction: it delays a withdrawal rather
		// than permitting one.
		const base = Number.isFinite(added) ? added : this.now();
		return { listed: true, usableAt: base + Withdrawals.ALLOWLIST_COOLDOWN_MS };
	}

	/** The customer's own addresses, with when each becomes usable. */
	listAllowlist(userId: string): {
		asset: string;
		address: string;
		addedAt: string;
		usableAt: string;
		usable: boolean;
	}[] {
		const rows = this.db
			.prepare(
				`SELECT asset, address, added_at FROM allowlisted_address
				  WHERE user_id = ? ORDER BY added_at DESC`,
			)
			.all(userId) as { asset: string; address: string; added_at: string }[];
		const now = this.now();
		return rows.map((r) => {
			const added = Date.parse(r.added_at);
			const base = Number.isFinite(added) ? added : now;
			const usableAt = base + Withdrawals.ALLOWLIST_COOLDOWN_MS;
			return {
				asset: r.asset,
				address: r.address,
				addedAt: r.added_at,
				usableAt: new Date(usableAt).toISOString(),
				usable: now >= usableAt,
			};
		});
	}

	/** Remove one. Immediate by design — see ALLOWLIST_COOLDOWN_MS. */
	removeFromAllowlist(userId: string, asset: string, address: string): boolean {
		const r = this.db
			.prepare(
				`DELETE FROM allowlisted_address
				  WHERE user_id = ? AND asset = ? AND address = ?`,
			)
			.run(userId, asset, address);
		return r.changes > 0;
	}

	/**
	 * Request a withdrawal. Debits the customer immediately.
	 *
	 * The entire thing — limit checks, the ledger debit, and the withdrawal row
	 * — runs in ONE immediate transaction. If the row were written outside the
	 * debit's transaction, a crash between them would leave either a debited
	 * customer with no withdrawal to pay them, or a withdrawal with no funds
	 * behind it.
	 */
	request(args: {
		userId: string;
		asset: string;
		/**
		 * The chain to pay over. REQUIRED for multi-network assets, refused
		 * for single-chain ones.
		 *
		 * This is not a preference. USDT on Tron and USDT on Ethereum are
		 * different tokens and are paid from different inventories, so a
		 * withdrawal that does not name a chain is not a withdrawal anyone can
		 * execute. See assets.ts.
		 */
		network?: string;
		amount: bigint;
		address: string;
		/** Derived from the customer's request, so a double-submit is one row. */
		idempotencyKey: string;
		/**
		 * Liquidity gate, injected. Returns a refusal reason when this chain
		 * cannot pay the amount right now. Omitted in tests that are not about
		 * liquidity.
		 */
		checkLiquidity?: (asset: string, network: string | undefined, amount: bigint) =>
			{ ok: true } | { ok: false; reason: string };
	}): Withdrawal {
		const run = this.db.transaction((): Withdrawal => {
			const existing = this.byIdempotencyKey(args.idempotencyKey);
			if (existing !== undefined) return existing;

			if (args.amount <= 0n) {
				throw new WithdrawalError("withdrawal amount must be positive");
			}

			// FAIL CLOSED on an unconfigured asset. A newly-listed asset with no
			// policy entry must not be withdrawable without limits.
			const max = this.policy.maxPerRequest[args.asset];
			if (max === undefined) {
				throw new WithdrawalError(
					`${args.asset} has no withdrawal limit configured, so it cannot be ` +
						"withdrawn — configure maxPerRequest first",
				);
			}
			if (args.amount > max) {
				throw new WithdrawalError(
					`${args.amount} exceeds the ${args.asset} per-request limit of ${max}`,
				);
			}

			// THE CHAIN MUST BE NAMED WHEN THERE IS A CHOICE, and must not be
			// when there is not. Accepting an unqualified multi-network
			// withdrawal would leave the payer guessing which inventory to
			// draw from; accepting a qualified single-chain one invents a
			// route that does not exist.
			const def = assetDef(args.asset);
			if (def.networks.length > 0) {
				if (args.network === undefined) {
					throw new WithdrawalError(
						`${args.asset} exists on ${def.networks.length} chains — choose one: ` +
							def.networks.map((n) => n.id).join(", "),
					);
				}
				if (!def.networks.some((n) => n.id === args.network)) {
					throw new WithdrawalError(
						`${args.asset} is not available on ${args.network} — choose one of: ` +
							def.networks.map((n) => n.id).join(", "),
					);
				}
			} else if (args.network !== undefined) {
				throw new WithdrawalError(`${args.asset} is single-chain; do not name a network`);
			}

			// THE FEE. Quoted here, inside the transaction, so that the rate it
			// was priced at is the rate that gets stored — and refusing outright
			// if the chain cannot be priced, because a fee we cannot compute is
			// gas we cannot prove we covered.
			const quote = quoteWithdrawal({
				asset: args.asset,
				network: args.network,
				amount: args.amount,
				table: this.feeTable,
				...(this.pricing === undefined ? {} : { pricing: this.pricing }),
			});

			// THE GAS GATE. Before the debit, because a withdrawal we cannot pay
			// the gas for has to be a refusal and not a stuck payment. See
			// gasgate.ts.
			if (this.gas !== undefined) {
				const g = checkGas({ asset: args.asset, network: args.network }, this.gas);
				if (!g.ok) throw new WithdrawalError(g.reason);
			} else if (this.requireGasGate) {
				throw new WithdrawalError(
					"no gas gate is configured, so we cannot tell whether this " +
						"withdrawal can actually be sent — refusing rather than " +
						"accepting one that may get stuck",
				);
			}

			// LIQUIDITY, before the debit. Telling a customer afterwards that
			// the chain they chose cannot pay is the failure this whole model
			// exists to avoid.
			//
			// Checked against the NET, since that is what leaves custody. The fee
			// stays with us and never needs to be on the chain.
			if (args.checkLiquidity !== undefined) {
				const liq = args.checkLiquidity(args.asset, args.network, quote.net);
				if (!liq.ok) throw new WithdrawalError(liq.reason);
			}

			if (this.policy.requireAllowlistedAddress) {
				const st = this.allowlistStatus(args.userId, args.asset, args.address);
				if (!st.listed) {
					throw new WithdrawalError(
						`${args.address} is not an allowlisted ${args.asset} destination ` +
							`for this account`,
					);
				}
				/*
				 * ON THE LIST IS NOT THE SAME AS PAYABLE YET.
				 *
				 * An allowlist with no cooling-off period costs an attacker one
				 * extra request: add their address, withdraw to it, done. The
				 * delay is the control — it forces a theft to hold the session
				 * long enough for the customer to notice an address they did not
				 * add. See ALLOWLIST_COOLDOWN_MS.
				 */
				if (st.usableAt !== undefined && this.now() < st.usableAt) {
					const mins = Math.ceil((st.usableAt - this.now()) / 60_000);
					throw new WithdrawalError(
						`${args.address} was added too recently to withdraw to. New ` +
							`addresses become usable ` +
							`${Withdrawals.ALLOWLIST_COOLDOWN_MS / 3_600_000} hours after ` +
							`being added — about ${mins} minute(s) left. This delay is ` +
							"what stops someone who has taken over a session from adding " +
							"their own address and emptying the account before you notice.",
					);
				}
			}

			/*
			 * AVAILABLE, NOT TOTAL. The ledger cannot enforce this one.
			 *
			 * A reservation against an open order is NOT a ledger posting — it is
			 * derived from the order table — so `ledger.post` below only checks
			 * that the account's TOTAL stays non-negative. Which means a customer
			 * with 1,000 USDT entirely committed to a live bid could withdraw all
			 * 1,000: the ledger saw 1000 - 1000 = 0 and allowed it.
			 *
			 * What that produced was not theft — the matching engine refuses a
			 * fill the owner cannot cover, cancels the resting order and lets the
			 * taker continue down the book, and the ledger stays consistent. What
			 * it produced was a FREE SPOOF: post a large bid, withdraw the
			 * collateral, and the public book advertises depth that costs nothing
			 * to abandon and can never be hit. Takers route against it and get a
			 * worse fill than the book promised.
			 *
			 * Checked against the GROSS, since the fee leaves the balance too.
			 */
			if (this.reservedOf === undefined) {
				if (this.requireReservedCheck) {
					throw new WithdrawalError(
						"no reservation source is configured, so we cannot tell how much " +
							"of this balance is committed to open orders — refusing rather " +
							"than letting a withdrawal spend an order's collateral",
					);
				}
			} else {
				const total = this.ledger.balance(userAcct(args.userId, args.asset));
				const held = this.reservedOf(args.userId, args.asset);
				const spendable = total - held > 0n ? total - held : 0n;
				if (args.amount > spendable) {
					throw new WithdrawalError(
						`${args.amount} exceeds the ${args.asset} available to withdraw: ` +
							`${total} held, ${held} reserved against open orders, ` +
							`${spendable} available. Cancel an order to free it.`,
					);
				}
			}

			// THE DEBIT. Inside the ledger's row lock, so a concurrent request for
			// the same balance fails here rather than racing through.
			//
			// THE FEE IS RECOGNISED HERE, NOT ON CONFIRMATION. The customer is
			// debited the gross; the net becomes a liability we owe the chain
			// (INFLIGHT) and the fee becomes ours (FEES). Deferring the fee to
			// settlement would mean a reversal has to know whether the fee had
			// been taken yet, and a half-reversed withdrawal is how a customer
			// gets refunded 100 having been debited 100 and charged 1.
			const tx = this.ledger.post({
				reason: Reason.WITHDRAWAL_REQUEST,
				postings: [
					{ account: userAcct(args.userId, args.asset), delta: -args.amount },
					{ account: inflight(args.asset), delta: quote.net },
					...(quote.fee > 0n
						? [
								{
									account: {
										kind: AccountKind.FEES,
										owner: "",
										asset: args.asset,
									},
									delta: quote.fee,
								},
							]
						: []),
				],
				idempotencyKey: `wd:req:${args.idempotencyKey}`,
				actor: args.userId,
			});

			const now = this.stamp();
			const info = this.db
				.prepare(
					`INSERT INTO withdrawal
					   (user_id, asset, network, amount, fee, net, address, state,
					    request_tx_id, idempotency_key, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					args.userId,
					args.asset,
					args.network ?? null,
					args.amount.toString(),
					quote.fee.toString(),
					quote.net.toString(),
					args.address,
					State.REQUESTED,
					tx.id,
					args.idempotencyKey,
					now,
					now,
				);
			const id = Number(info.lastInsertRowid);
			this.event(id, undefined, State.REQUESTED, args.userId, undefined);
			return this.get(id)!;
		});
		return run.immediate();
	}

	/**
	 * Screen the destination, then route to approval or straight through.
	 *
	 * A screener that throws does NOT silently allow. An unreachable sanctions
	 * provider means we do not know whether this address is sanctioned, and
	 * "we do not know" must not resolve to "send it".
	 */
	async screen(id: number, screener: AddressScreener): Promise<Withdrawal> {
		const w = this.require(id);
		this.transition(id, w.state, State.SCREENING, screener.name, undefined);

		let result: ScreenResult;
		try {
			result = await screener.screen(w.asset, w.address);
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			// Left in SCREENING, not rejected: a provider outage is not the
			// customer's fault and should be retried, not punished. But it does
			// not advance either.
			throw new WithdrawalError(
				`screening ${id} failed via ${screener.name} (${why}) — the ` +
					"withdrawal stays in screening and must not be submitted",
			);
		}

		if (!result.allowed) {
			return this.reject(
				id,
				screener.name,
				result.reason ?? `refused by ${screener.name}`,
			);
		}

		// THE OPERATIONAL INTERLOCK, checked before anything is cleared to send.
		// Not oversight — the reconciler sets this mechanically when the books
		// and custody disagree, and paying out while short spends other
		// customers' assets.
		if (this.interlock.halted(w.asset)) {
			return this.reject(
				id,
				"interlock",
				`${w.asset} withdrawals are halted: ${this.interlock.reason(w.asset)}`,
			);
		}

		// THE VELOCITY CAP — the control that replaces the human approver.
		// maxPerRequest alone is trivially defeated by issuing many requests, so
		// the rolling-day total is what actually bounds a compromised account.
		const cap = this.policy.velocityCap24h[w.asset];
		if (cap === undefined) {
			return this.reject(
				id,
				"policy",
				`${w.asset} has no 24h velocity cap configured; with approval ` +
					"automatic an unconfigured cap is an unbounded one, so this " +
					"fails closed",
			);
		}
		const used = this.rolling24h(w.userId, w.asset, id);
		if (used + w.amount > cap) {
			// AUTO-REJECTED, not queued. Queueing for a human is precisely what
			// automatic approval exists to avoid.
			return this.reject(
				id,
				"policy",
				`this would put ${w.userId} at ${used + w.amount} of ${w.asset} ` +
					`withdrawn in 24h, over the ${cap} cap`,
			);
		}

		if (this.policy.autoApprove) {
			this.transition(
				id,
				State.SCREENING,
				State.APPROVED,
				"policy",
				`auto-approved: screened clean, ${used + w.amount}/${cap} of the 24h cap`,
			);
			return this.require(id);
		}

		// Manual tier, retained for the case where it is deliberately switched
		// back on. Absent threshold => everything needs a human. Fail closed.
		const threshold = this.policy.approvalThreshold[w.asset];
		const needsHuman = threshold === undefined || w.amount > threshold;
		this.transition(
			id,
			State.SCREENING,
			needsHuman ? State.AWAITING_APPROVAL : State.APPROVED,
			screener.name,
			needsHuman
				? `over the ${w.asset} approval threshold` +
					(threshold === undefined ? " (none configured — failing closed)" : "")
				: "under the approval threshold",
		);
		return this.require(id);
	}

	/**
	 * Total of this account's withdrawals of an asset in the last 24 hours,
	 * excluding `excludeId` and excluding anything that was reversed.
	 *
	 * REJECTED and FAILED withdrawals are excluded because their funds were
	 * returned to the customer — counting them would let one declined request
	 * lock an account out of its own balance for a day. Everything else counts,
	 * including requests still in flight, because those funds are committed.
	 */
	private rolling24h(userId: string, asset: string, excludeId: number): bigint {
		const since = new Date(this.now() - 24 * 60 * 60 * 1000).toISOString();
		const rows = this.db
			.prepare(
				`SELECT amount FROM withdrawal
				  WHERE user_id = ? AND asset = ? AND id != ?
				    AND created_at >= ?
				    AND state NOT IN (?, ?)`,
			)
			.all(userId, asset, excludeId, since, State.REJECTED, State.FAILED) as {
			amount: string;
		}[];
		let sum = 0n;
		for (const r of rows) sum += BigInt(r.amount);
		return sum;
	}

	/**
	 * Approve a withdrawal awaiting a human.
	 *
	 * The approver may not be the requesting customer. A control that the
	 * beneficiary can satisfy themselves is not a control.
	 */
	approve(id: number, approver: string): Withdrawal {
		const w = this.require(id);
		if (approver.trim() === "") {
			throw new WithdrawalError("an approver must be named");
		}
		if (approver === w.userId) {
			throw new WithdrawalError(
				`${approver} cannot approve their own withdrawal — a second human is ` +
					"the point of the threshold",
			);
		}
		this.transition(id, w.state, State.APPROVED, approver, "approved");
		this.db
			.prepare(`UPDATE withdrawal SET approved_by = ? WHERE id = ?`)
			.run(approver, id);
		return this.require(id);
	}

	/**
	 * Record that the custodian has been handed the transfer.
	 *
	 * Called AFTER the provider accepts it, with the provider's reference. From
	 * here the withdrawal is no longer reversible by us.
	 */
	markSubmitted(id: number, providerRef: string, actor: string): Withdrawal {
		const w = this.require(id);
		if (providerRef.trim() === "") {
			throw new WithdrawalError(
				"a provider reference is required to mark a withdrawal submitted — " +
					"without one there is no way to reconcile it later",
			);
		}
		this.transition(id, w.state, State.SUBMITTED, actor, `ref ${providerRef}`);
		this.db
			.prepare(`UPDATE withdrawal SET provider_ref = ? WHERE id = ?`)
			.run(providerRef, id);
		return this.require(id);
	}

	/**
	 * Settle a confirmed withdrawal: INFLIGHT and CUSTODY both fall, the
	 * outside world rises.
	 *
	 * Idempotent on the withdrawal id, so a replayed custodian webhook settles
	 * once.
	 */
	confirm(id: number, actor: string, networkFee = 0n): Withdrawal {
		const run = this.db.transaction((): Withdrawal => {
			const w = this.require(id);
			if (w.state === State.CONFIRMED) return w; // replayed webhook
			if (networkFee < 0n) {
				throw new WithdrawalError("a network fee cannot be negative");
			}

			// THE NET IS WHAT WENT ON CHAIN. The fee never left — it was moved to
			// FEES at request time and stays there.
			const custodyId =
				w.network === undefined ? w.asset : `${w.asset}.${w.network}`;
			// THE EXTERNAL LEGS NAME THE CHAIN TOO. Both sides of an on-chain
			// movement happened on a specific chain, and the ledger refuses an
			// unqualified multi-network custody or external holding — see
			// assets.ts. The first version of this used the bare symbol and
			// every token withdrawal failed to settle.
			const postings = [
				{ account: inflight(w.asset), delta: -w.net },
				{ account: externalAcct(custodyId), delta: w.net },
				{ account: custodyAcct(custodyId), delta: -w.net },
				{ account: externalAcct(custodyId), delta: w.net },
			];

			// JOURNAL THE NETWORK FEE. Omitting it is the most common cause of a
			// persistent, slowly-growing reconciliation shortfall: the chain took
			// it from custody and the books never recorded it.
			//
			// BOOKED IN THE GAS ASSET, which for a token is NOT the asset being
			// sent. Sending USDT over Ethereum burns ETH, so debiting USDT
			// custody by the gas would invent a USDT shortfall that no on-chain
			// event matches — and a shortfall halts withdrawals. The venue
			// absorbs the cost out of its own holding of the gas asset: the FEES
			// balance, which is what the gas gate checks before accepting the
			// withdrawal in the first place.
			if (networkFee > 0n) {
				const gasAsset = gasAssetFor(w.asset, w.network);
				postings.push(
					{ account: custodyAcct(gasAsset), delta: -networkFee },
					{ account: externalAcct(gasAsset), delta: networkFee },
					{
						account: { kind: AccountKind.FEES, owner: "", asset: gasAsset },
						delta: -networkFee,
					},
					{ account: externalAcct(gasAsset), delta: networkFee },
				);
			}

			const tx = this.ledger.post({
				reason: Reason.WITHDRAWAL_SETTLE,
				postings,
				idempotencyKey: `wd:settle:${id}`,
				actor,
			});

			this.transition(id, w.state, State.CONFIRMED, actor, undefined);
			this.db
				.prepare(`UPDATE withdrawal SET settle_tx_id = ? WHERE id = ?`)
				.run(tx.id, id);
			return this.require(id);
		});
		return run.immediate();
	}

	/** Refuse before submission, reversing the debit exactly once. */
	reject(id: number, actor: string, reason: string): Withdrawal {
		return this.unwind(id, State.REJECTED, actor, reason);
	}

	/**
	 * The custodian asserts it never went out. Reverses the debit.
	 *
	 * Only legal from SUBMITTED, and only on the provider's word — calling this
	 * because a request timed out, when the transfer may in fact have gone
	 * through, refunds a customer who was also paid on chain.
	 */
	fail(id: number, actor: string, reason: string): Withdrawal {
		return this.unwind(id, State.FAILED, actor, reason);
	}

	private unwind(id: number, to: State, actor: string, reason: string): Withdrawal {
		const run = this.db.transaction((): Withdrawal => {
			const w = this.require(id);
			if (w.state === to) return w; // already unwound; do not refund twice
			if (reason.trim() === "") {
				throw new WithdrawalError(`a ${to} must carry a reason`);
			}

			// Transition FIRST, so an illegal edge (notably SUBMITTED -> REJECTED)
			// is refused before any money moves.
			this.transition(id, w.state, to, actor, reason);

			// THE WHOLE THING COMES BACK, FEE INCLUDED. Nothing was sent, so there
			// is no gas to recover and no service to charge for. Keeping the fee
			// on a failed withdrawal would be charging a customer for a payment
			// they never received.
			const tx = this.ledger.post({
				reason: Reason.WITHDRAWAL_REVERSE,
				postings: [
					{ account: inflight(w.asset), delta: -w.net },
					...(w.fee > 0n
						? [
								{
									account: {
										kind: AccountKind.FEES,
										owner: "",
										asset: w.asset,
									},
									delta: -w.fee,
								},
							]
						: []),
					{ account: userAcct(w.userId, w.asset), delta: w.amount },
				],
				// Keyed on the withdrawal, so a second reversal is a replay rather
				// than a second refund.
				idempotencyKey: `wd:reverse:${id}`,
				actor,
			});

			this.db
				.prepare(`UPDATE withdrawal SET reverse_tx_id = ?, reason = ? WHERE id = ?`)
				.run(tx.id, reason, id);
			return this.require(id);
		});
		return run.immediate();
	}

	/** Enforce the transition table and record the edge. */
	private transition(
		id: number,
		from: State,
		to: State,
		actor: string,
		note: string | undefined,
	): void {
		if (from === to) return;
		if (TERMINAL.has(from)) {
			throw new IllegalTransition(id, from, to);
		}
		if (!TRANSITIONS[from].includes(to)) {
			throw new IllegalTransition(id, from, to);
		}
		if (actor.trim() === "") {
			throw new WithdrawalError("every transition must name an actor");
		}
		const now = this.stamp();
		this.db
			.prepare(`UPDATE withdrawal SET state = ?, updated_at = ? WHERE id = ?`)
			.run(to, now, id);
		this.event(id, from, to, actor, note);
	}

	private event(
		id: number,
		from: State | undefined,
		to: State,
		actor: string,
		note: string | undefined,
	): void {
		this.db
			.prepare(
				`INSERT INTO withdrawal_event
				   (withdrawal_id, from_state, to_state, actor, note, at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, from ?? null, to, actor, note ?? null, this.stamp());
	}

	get(id: number): Withdrawal | undefined {
		const row = this.db.prepare(`SELECT * FROM withdrawal WHERE id = ?`).get(id) as
			| Row
			| undefined;
		return row === undefined ? undefined : hydrate(row);
	}

	private require(id: number): Withdrawal {
		const w = this.get(id);
		if (w === undefined) throw new WithdrawalError(`no withdrawal ${id}`);
		return w;
	}

	byIdempotencyKey(key: string): Withdrawal | undefined {
		const row = this.db
			.prepare(`SELECT * FROM withdrawal WHERE idempotency_key = ?`)
			.get(key) as Row | undefined;
		return row === undefined ? undefined : hydrate(row);
	}

	/** The audit trail: every state change, in order. */
	history(id: number): readonly {
		from: State | undefined;
		to: State;
		actor: string;
		note: string | undefined;
		at: string;
	}[] {
		const rows = this.db
			.prepare(
				`SELECT from_state, to_state, actor, note, at
				   FROM withdrawal_event WHERE withdrawal_id = ? ORDER BY id`,
			)
			.all(id) as {
			from_state: string | null;
			to_state: string;
			actor: string;
			note: string | null;
			at: string;
		}[];
		return rows.map((r) => ({
			from: (r.from_state ?? undefined) as State | undefined,
			to: r.to_state as State,
			actor: r.actor,
			note: r.note ?? undefined,
			at: r.at,
		}));
	}

	pending(): readonly Withdrawal[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM withdrawal WHERE state NOT IN (?, ?, ?) ORDER BY id`,
			)
			.all(State.CONFIRMED, State.REJECTED, State.FAILED) as Row[];
		return rows.map(hydrate);
	}
}

function hydrate(r: Row): Withdrawal {
	return {
		id: r.id,
		userId: r.user_id,
		asset: r.asset,
		network: r.network ?? undefined,
		amount: BigInt(r.amount),
		// Rows written before fees existed have no fee; treating that as zero is
		// correct — nothing was withheld from them.
		fee: BigInt(r.fee ?? "0"),
		net: BigInt(r.net ?? r.amount),
		address: r.address,
		state: r.state as State,
		requestTxId: r.request_tx_id,
		settleTxId: r.settle_tx_id ?? undefined,
		reverseTxId: r.reverse_tx_id ?? undefined,
		providerRef: r.provider_ref ?? undefined,
		reason: r.reason ?? undefined,
		approvedBy: r.approved_by ?? undefined,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export { InsufficientFunds };
