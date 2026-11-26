// -----------------------------------------------------------------------------
// GETTING SOLANA DEPOSITS BACK OUT AGAIN — the half BLOCK does not need.
//
// WHY THIS FILE IS PART OF OPENING THE RAIL AND NOT A LATER PHASE.
//
// BLOCK's pool needs no counterpart to this: the operator sweeps the wallet
// and every address in it moves together. Solana is ACCOUNT-PER-ADDRESS. A
// deposit to a per-customer address lands in that address's own account and
// joins no pooled balance, so "we received 4 SOL" and "we can send 4 SOL" are
// different statements until something consolidates. Design rule 4 is blunt
// about which way that cuts: NEVER CREDIT WHAT CANNOT BE RETURNED. A venue
// that opens Solana deposits before this code exists has built a one-way door,
// and settlement.ts already records that this is precisely why the BitGo SOL
// rail stayed shut — "no consolidation path exists: `grep -n consolidat src/`
// returns comments and no call site".
//
// WHAT THIS FILE IS: THE PLANNER. It turns "here are the balances at the
// issued pool addresses" into unsigned sweep proposals, and it records the
// accounts that must not be swept. It holds no key, composes no signature,
// touches no network and submits nothing. It cannot: the keys for these
// accounts are on the signer host, derived from m/44'/501'/idx'/0', and that
// is the entire point of the address pool.
//
// ---------------------------------------------------------------------------
// THE LOAD-BEARING LAMPORT FACT, AND WHY IT INVERTS THE OBVIOUS DESIGN
// ---------------------------------------------------------------------------
//
// `getMinimumBalanceForRentExemption(0)` = 650,240 lamports, measured
// identically on solana-rpc.publicnode.com, api.mainnet-beta.solana.com and
// api.devnet.solana.com. Solana REJECTS a transfer that would leave a source
// account with a NONZERO balance below that figure.
//
// The conclusion everyone reaches first is that 650,240 lamports is a
// permanent per-address tax: park it, never sweep it, raise the minimum
// deposit to cover it. That conclusion is wrong, and expensively so — at a
// thousand customers it strands 0.65 SOL forever and it pushes the published
// minimum deposit an order of magnitude higher than it needs to be.
//
// The actual rule has a second branch: a transfer of the EXACT FULL BALANCE
// leaves zero, which is allowed, CLOSES the account, and recovers every
// lamport. The address is not destroyed by this — it is a public key, and the
// next deposit re-creates the account. So this design SWEEPS TO CLOSE: the
// amount is always the entire balance, and the only cost of the rail is the
// signature fee.
//
// That is only possible because the FEE PAYER IS THE HOT ACCOUNT. An account
// cannot pay its own fee and also reach zero in one transaction: the fee comes
// off the fee payer, and `SystemProgram::transfer` fixes the lamport amount at
// signing time, so self-paying means guessing a fee and leaving dust, or
// leaving 650,240 behind. (A per-source fee payer also forbids batching
// outright — a transaction has exactly one fee payer, so "each account pays
// its own fee" means one transaction per account, 5,000 lamports each, instead
// of one transaction per eight.) The venue pays the fee and recovers the
// balance; the DUST FLOOR below is what stops that from being a subsidy.
//
// MEASURED AND NOT MEASURED, STATED HONESTLY: the 650,240 figure is read from
// three live endpoints. The close-to-zero behaviour is NOT verified here,
// because this work may not submit a transaction. Two things must be
// demonstrated on devnet before the rail opens, and solrail.ts refuses to open
// it until they are: (1) a full-balance transfer out of a 0-byte system
// account recovers everything and closes it; (2) a partial sweep leaving a
// nonzero balance under 650,240 fails for rent, as documented. If (2) is
// wrong, the dust floor is wrong. If (1) is wrong, the published 0.001 SOL
// minimum collapses back toward 0.01.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DO, AND WHY THAT IS NOT A GAP BUT A BOUNDARY
// ---------------------------------------------------------------------------
//
// No signing, no broadcast, no ledger posting. The sweep's ledger shape is
// decided and written down here so the broadcast runner cannot get it wrong —
// ONE movement, CUSTODY(source) -> CUSTODY(hot) for the amount AND
// FEES -> EXTERNAL for the fee actually burned. Omitting the fee posting is
// the specific self-inflicted failure reconcile.ts names: holdings fall by
// amount+fee while books fall by amount, which is a small, persistent,
// steadily GROWING shortfall, and a shortfall has no tolerance at any size and
// halts the asset. See `sweepLedgerShape`.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { checkSolAddress } from "./soladdress";

export class SolConsolidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SolConsolidationError";
	}
}

/* ------------------------------------------------------------- the numbers */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Solana's fee is per SIGNATURE, not per byte and not per instruction: 5,000
 * lamports each at the base rate. A sweep of eight sources is nine signatures
 * (the hot fee payer plus one per source), so ~45,000 lamports — about
 * $0.009 at any plausible SOL price. This is the whole operating cost of the
 * rail.
 */
export const SOL_LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * `getMinimumBalanceForRentExemption(0)`, measured on three endpoints
 * 2026-11-26. Recorded for the comparison it makes possible, NOT as a floor:
 * under sweep-to-close nothing has to stay behind, and confusing this number
 * with the dust floor is the difference between a 0.001 SOL published minimum
 * and a 0.01 SOL one that turns away real deposits.
 *
 * It is also the right number to compare BitGo's against: SOL_ACTIVATION in
 * settlement.ts records BitGo quoting 2,447,136 lamports of `minimumFunding`
 * that its own documentation says can never be spent. That is its multi-sig
 * account's size, not a 0-byte system account's, and it is 3.7x this — so the
 * self-custodied pool is CHEAPER per address than the custodian path it
 * replaces, not merely more private.
 */
export const SOL_RENT_EXEMPT_MINIMUM_LAMPORTS = 650_240n;

/**
 * THE DUST FLOOR: 3 x the signature fee = 15,000 lamports.
 *
 * Three, for the same reason the EVM floor is 3x its gas estimate: a deposit
 * has to be able to afford (a) being swept in, (b) being moved again by the
 * venue, and (c) being withdrawn. One signature fee of headroom would make a
 * deposit sweepable and then unmovable, which is a liability with no
 * retrievable asset behind it — the state rule 4 forbids.
 *
 * Note what it is NOT derived from: rent. Under sweep-to-close the rent
 * minimum never has to be left behind, so it does not enter the floor.
 */
export const SOL_SWEEP_DUST_FLOOR_LAMPORTS = 3n * SOL_LAMPORTS_PER_SIGNATURE;

/**
 * THE PUBLISHED MINIMUM DEPOSIT: 0.001 SOL = 1,000,000 lamports.
 *
 * 10x the floor, rounded up to a number a human can read and type. Ten and not
 * one because the customer chooses their amount minutes or hours before the
 * sweep runs, and a fee-rate spike in between must not strand a deposit that
 * was comfortably above the floor when it left. At 0.001 SOL the margin is
 * ~66x the floor, which is dead cheap to offer and removes the whole class of
 * "I deposited and nothing happened".
 *
 * A MINIMUM NOBODY CAN SEE IS NOT A MINIMUM: this constant is what the deposit
 * screen must print, next to the address, before the customer sends.
 */
export const SOL_MINIMUM_DEPOSIT_LAMPORTS = 1_000_000n;

/**
 * Sources per sweep transaction. 8, where the hard ceiling is 9.
 *
 * Solana's limit is the 1,232-byte packet, not a gas budget, and each extra
 * source costs a 64-byte signature plus a 32-byte account key plus a 17-byte
 * instruction — see `sweepTxBytes`, which this file asserts against. The
 * arithmetic allows 9; the policy is 8, and the spare slot is deliberate: a
 * compute-budget instruction, a different destination encoding, or a versioned
 * transaction with an address-lookup table all change the header, and
 * discovering that at submit time means an operator has already carried a
 * proposal to the signer host for nothing.
 *
 * 8 IS ALSO UNVERIFIED ON CHAIN, and the honest way to raise it is to measure
 * a real transaction on devnet, not to recompute the arithmetic.
 */
export const SOL_MAX_SOURCES_PER_SWEEP = 8;

/** The packet limit. A transaction above this is not merely expensive, it is rejected. */
export const SOL_TX_SIZE_LIMIT = 1232;

/**
 * Bytes a sweep transaction with `n` sources occupies on the wire.
 *
 * Written out term by term because the ceiling that matters is derived from
 * it, and a number like "8 sources" with no arithmetic behind it is the kind
 * of constant that gets doubled by somebody in a hurry:
 *
 *   signatures      shortvec(1) + 64 * (n sources + 1 fee payer)
 *   message header  3
 *   account keys    shortvec(1) + 32 * (n + 1 fee payer + 1 destination
 *                                        + 1 SystemProgram)
 *   blockhash       32
 *   instructions    shortvec(1) + n * (1 program index + shortvec(1) + 2
 *                                      account indexes + shortvec(1)
 *                                      + 12 bytes of transfer data)
 *
 * = 113n + 198. Nine sources is 1,215 bytes; ten is 1,328 and would be
 * rejected by the cluster.
 */
export function sweepTxBytes(sources: number): number {
	const signatures = 1 + 64 * (sources + 1);
	const header = 3;
	const accountKeys = 1 + 32 * (sources + 3);
	const blockhash = 32;
	const instructions = 1 + sources * 17;
	return signatures + header + accountKeys + blockhash + instructions;
}

/** The largest source count that still fits in a packet. */
export function maxSourcesByTxSize(): number {
	let n = 1;
	while (sweepTxBytes(n + 1) <= SOL_TX_SIZE_LIMIT) n += 1;
	return n;
}

/* --------------------------------------------------------------- the plan */

/** A balance read for one pool account. */
export interface SolAccountBalance {
	/** The pool's derivation index. Carried so the signer can re-derive. */
	readonly index: number;
	readonly address: string;
	readonly lamports: bigint;
}

export interface SweepSource {
	readonly index: number;
	readonly address: string;
	/** Swept in full: sweep-to-close leaves exactly zero. */
	readonly lamports: bigint;
}

export interface SweepBatch {
	/** The hot account. Never a customer address, never a pool address. */
	readonly feePayer: string;
	readonly destination: string;
	readonly sources: readonly SweepSource[];
	/** Total moved, which is the sum of the sources' entire balances. */
	readonly lamports: bigint;
	/** What the venue pays: one signature per source plus the fee payer's. */
	readonly feeLamports: bigint;
	/** Bytes on the wire, asserted under the packet limit before it is emitted. */
	readonly bytes: number;
	/** The slot the balances were read at. For the human comparison at the signer. */
	readonly atSlot: number;
	/**
	 * The batch's identity across the offline gap.
	 *
	 * A signed batch that is broadcast twice must be a no-op rather than a
	 * second payment. On Solana the blockhash expiry window and the signature
	 * itself give that for free — but only if the broadcaster can RECOGNISE the
	 * batch it already submitted, which is what this key is for. It is
	 * deterministic in the sources and the slot, so re-planning the same read
	 * produces the same key.
	 */
	readonly proposalKey: string;
}

/**
 * Why an account was left alone.
 *
 * `below_dust_floor` is the interesting one and it is NOT an error: it is a
 * deposit smaller than the cost of moving it, which is unrecoverable in
 * practice rather than in principle.
 */
export type StrandedReason = "below_dust_floor";

export interface StrandedAccount {
	readonly index: number;
	readonly address: string;
	readonly lamports: bigint;
	readonly reason: StrandedReason;
	readonly firstSeenAt: string;
	readonly lastSeenAt: string;
	/** How many planning passes have seen it. Not how many sweeps were tried: none were. */
	readonly observations: number;
	readonly resolvedAt: string | null;
}

export interface ConsolidationPlan {
	readonly batches: readonly SweepBatch[];
	/** Accounts recorded and excluded, with the amount and the reason. */
	readonly stranded: readonly StrandedAccount[];
	readonly totalLamports: bigint;
	readonly totalFeeLamports: bigint;
	/** Accounts with a zero balance, counted and otherwise ignored. */
	readonly emptyAccounts: number;
}

const SCHEMA = `
-- ACCOUNTS WE WILL NOT SWEEP, AND THE NUMBER THAT SAYS WHY.
--
-- "Recorded and reported, not retried forever" is the requirement, and the
-- distinction is the point: nothing is ever SUBMITTED for these accounts, so
-- there is no retry loop to back off. The row exists so that the amount is
-- answerable when a customer asks, so the reconciler's surplus has a name,
-- and so an operator can see the aggregate before deciding whether to spend a
-- manual sweep on it.
--
-- It is also self-healing, which is only possible because a pool address
-- belongs to one customer forever: if the balance later clears the floor — the
-- customer deposited again to the same address — the next pass sweeps it and
-- stamps resolved_at. That is why the customer-facing sentence is "it is still
-- there, deposit more to the same address and we will sweep the combined
-- balance" rather than "contact support".
CREATE TABLE IF NOT EXISTS sol_stranded_account (
  address       TEXT PRIMARY KEY,
  idx           INTEGER NOT NULL,
  -- Lamports as TEXT, matching ledger_posting.delta: SQLite INTEGER is 64-bit
  -- signed and better-sqlite3 hands back a JS number, which has already lost
  -- precision above 2^53 — well inside SOL's total supply in lamports.
  lamports      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  observations  INTEGER NOT NULL DEFAULT 1,
  last_slot     INTEGER,
  -- Set when a later pass found the balance above the floor and swept it.
  resolved_at   TEXT
);
`;

interface StrandedRaw {
	address: string;
	idx: number;
	lamports: string;
	reason: string;
	first_seen_at: string;
	last_seen_at: string;
	observations: number;
	last_slot: number | null;
	resolved_at: string | null;
}

/** What the planner needs from the address pool. Structural, so it stays testable. */
export interface SweepablePool {
	indexOf(address: string): number | undefined;
	allAddresses(): readonly string[];
}

export interface SolConsolidationConfig {
	/**
	 * The hot account: the sweep destination AND the fee payer.
	 *
	 * Its key lives on the signer host with everything else. It is named in
	 * configuration here only so a proposal can be composed; this process
	 * cannot spend from it either.
	 */
	readonly hotAddress: string;
	readonly maxSourcesPerSweep?: number;
	readonly dustFloorLamports?: bigint;
	readonly lamportsPerSignature?: bigint;
}

export class SolConsolidation {
	private readonly maxSources: number;
	private readonly floor: bigint;
	private readonly feePerSignature: bigint;

	constructor(
		private readonly db: Database,
		private readonly pool: SweepablePool,
		private readonly cfg: SolConsolidationConfig,
		private readonly now: () => Date = () => new Date(),
	) {
		db.exec(SCHEMA);

		const hot = checkSolAddress(cfg.hotAddress);
		if (!hot.ok) {
			throw new SolConsolidationError(
				`the SOL hot address is not usable (${cfg.hotAddress}): ${hot.why}`,
			);
		}
		/*
		 * THE HOT ACCOUNT MUST NOT BE A POOL ADDRESS.
		 *
		 * Sweeping into a customer's deposit address would (a) credit the whole
		 * venue's balance to that customer, because the deposit scanner watches
		 * exactly these addresses and attributes anything arriving at one of
		 * them to its owner, and (b) make the next sweep move it again. It is a
		 * one-character configuration mistake with no on-chain symptom, so it is
		 * refused at construction rather than discovered in a reconciliation
		 * report.
		 */
		if (pool.indexOf(cfg.hotAddress) !== undefined) {
			throw new SolConsolidationError(
				`the configured SOL hot address ${cfg.hotAddress} is a POOL address. ` +
					"Sweeping into a customer's deposit address would credit the venue's " +
					"own balance to that customer, because that is exactly the address " +
					"set the deposit scanner attributes by.",
			);
		}

		this.maxSources = cfg.maxSourcesPerSweep ?? SOL_MAX_SOURCES_PER_SWEEP;
		if (!Number.isInteger(this.maxSources) || this.maxSources < 1) {
			throw new SolConsolidationError(`maxSourcesPerSweep must be >= 1: ${this.maxSources}`);
		}
		if (sweepTxBytes(this.maxSources) > SOL_TX_SIZE_LIMIT) {
			throw new SolConsolidationError(
				`${this.maxSources} sources is ${sweepTxBytes(this.maxSources)} bytes, over ` +
					`Solana's ${SOL_TX_SIZE_LIMIT}-byte packet limit. The cluster would ` +
					`reject it; the ceiling is ${maxSourcesByTxSize()}.`,
			);
		}
		this.floor = cfg.dustFloorLamports ?? SOL_SWEEP_DUST_FLOOR_LAMPORTS;
		if (this.floor <= 0n) {
			throw new SolConsolidationError(
				"the dust floor must be positive: a floor of zero sweeps accounts that " +
					"cost more to move than they hold, which spends the venue's SOL to " +
					"recover less than the fee.",
			);
		}
		this.feePerSignature = cfg.lamportsPerSignature ?? SOL_LAMPORTS_PER_SIGNATURE;
	}

	/** The floor in force, so callers publish the same number this enforces. */
	dustFloor(): bigint {
		return this.floor;
	}

	/**
	 * The hot account this would sweep INTO, from the object that would compose
	 * the transaction.
	 *
	 * Asked rather than re-read from the environment on purpose: readiness
	 * checks and operator output must describe the sweeper that exists, not the
	 * configuration someone edited after it was built. Those diverge on exactly
	 * the deploy where it matters.
	 */
	hotAddress(): string {
		return this.cfg.hotAddress;
	}

	/**
	 * Turn a set of balance reads into unsigned sweep proposals.
	 *
	 * SIDE EFFECT, AND IT IS DELIBERATE: this records the accounts it refuses
	 * to sweep. A planner that returned them without writing them down would
	 * make "how much is stranded" a question only answerable by re-reading the
	 * chain, which is the question a customer asks and the one the reconciler's
	 * surplus needs an explanation for.
	 */
	plan(args: {
		readonly balances: readonly SolAccountBalance[];
		readonly atSlot: number;
	}): ConsolidationPlan {
		if (!Number.isInteger(args.atSlot) || args.atSlot < 0) {
			throw new SolConsolidationError(
				`a plan must name the slot its balances were read at, got ${args.atSlot}. ` +
					"Without it the signer and the operator have nothing to compare, and a " +
					"stale proposal is indistinguishable from a fresh one.",
			);
		}

		const sweepable: SweepSource[] = [];
		const stranded: StrandedAccount[] = [];
		let emptyAccounts = 0;

		for (const b of args.balances) {
			if (b.lamports < 0n) {
				throw new SolConsolidationError(
					`${b.address}: a negative balance (${b.lamports}) is not a chain read, ` +
						"it is a decoding bug. Refusing to plan against it.",
				);
			}
			/*
			 * EVERY SOURCE MUST BE A POOL ADDRESS AT THE CLAIMED INDEX.
			 *
			 * This mirrors online the check the signer host performs offline: it
			 * re-derives each source from its own seed at the claimed index and
			 * rejects the whole BATCH on any mismatch. Doing it here as well is
			 * not redundancy for its own sake — it is the difference between an
			 * operator discovering the problem now and discovering it after
			 * walking a file to an air-gapped machine. And it refuses the
			 * dangerous direction first: an address we cannot map to an index is
			 * an address nobody can sign for.
			 */
			const known = this.pool.indexOf(b.address);
			if (known === undefined) {
				throw new SolConsolidationError(
					`${b.address} is not in the SOL address pool, so no index maps to it ` +
						"and no key can be re-derived for it. A sweep of it could never be " +
						"signed; refusing to put it in a proposal.",
				);
			}
			if (known !== b.index) {
				throw new SolConsolidationError(
					`${b.address} is pool index ${known} but the balance read says ` +
						`${b.index}. The signer re-derives from the index, so a wrong one ` +
						"produces a different address and the batch is rejected there. " +
						"Refusing to compose it.",
				);
			}

			if (b.lamports === 0n) {
				emptyAccounts += 1;
				continue;
			}
			if (b.lamports < this.floor) {
				stranded.push(this.recordStranded(b, args.atSlot));
				continue;
			}
			// SWEEP TO CLOSE: the entire balance, leaving exactly zero.
			sweepable.push({ index: b.index, address: b.address, lamports: b.lamports });
			this.resolveStranded(b.address);
		}

		// Lowest index first, so successive plans over the same pool are stable
		// and an operator comparing two proposals is comparing like with like.
		sweepable.sort((a, b) => a.index - b.index);

		const batches: SweepBatch[] = [];
		for (let i = 0; i < sweepable.length; i += this.maxSources) {
			const sources = sweepable.slice(i, i + this.maxSources);
			const lamports = sources.reduce((t, s) => t + s.lamports, 0n);
			const feeLamports = this.feePerSignature * BigInt(sources.length + 1);
			batches.push({
				feePayer: this.cfg.hotAddress,
				destination: this.cfg.hotAddress,
				sources,
				lamports,
				feeLamports,
				bytes: sweepTxBytes(sources.length),
				atSlot: args.atSlot,
				proposalKey: `solsweep:${args.atSlot}:${sources.map((s) => s.index).join("-")}`,
			});
		}

		return {
			batches,
			stranded,
			totalLamports: batches.reduce((t, b) => t + b.lamports, 0n),
			totalFeeLamports: batches.reduce((t, b) => t + b.feeLamports, 0n),
			emptyAccounts,
		};
	}

	/**
	 * Should this account be swept at all?
	 *
	 * Exported as its own question because the deposit side needs the same
	 * answer BEFORE crediting: a deposit that cannot be swept must not be
	 * credited (rule 4), so the watcher and the sweeper have to agree on the
	 * floor, and the only way to guarantee that is to ask the same function.
	 */
	sweepable(lamports: bigint): boolean {
		return lamports >= this.floor;
	}

	private recordStranded(b: SolAccountBalance, slot: number): StrandedAccount {
		const stamp = this.now().toISOString();
		/*
		 * UPSERT, counting observations and keeping first_seen_at.
		 *
		 * `resolved_at` is cleared on re-observation: an account that was swept
		 * and then received another sub-floor deposit is stranded again, and a
		 * stale resolution would hide it from the report that exists to make it
		 * visible.
		 */
		this.db
			.prepare(
				`INSERT INTO sol_stranded_account
				   (address, idx, lamports, reason, first_seen_at, last_seen_at,
				    observations, last_slot, resolved_at)
				 VALUES (?, ?, ?, 'below_dust_floor', ?, ?, 1, ?, NULL)
				 ON CONFLICT(address) DO UPDATE SET
				   lamports     = excluded.lamports,
				   last_seen_at = excluded.last_seen_at,
				   last_slot    = excluded.last_slot,
				   observations = sol_stranded_account.observations + 1,
				   resolved_at  = NULL`,
			)
			.run(b.address, b.index, b.lamports.toString(), stamp, stamp, slot);
		const row = this.db
			.prepare(`SELECT * FROM sol_stranded_account WHERE address = ?`)
			.get(b.address) as StrandedRaw;
		return hydrateStranded(row);
	}

	private resolveStranded(address: string): void {
		this.db
			.prepare(
				`UPDATE sol_stranded_account SET resolved_at = ?
				 WHERE address = ? AND resolved_at IS NULL`,
			)
			.run(this.now().toISOString(), address);
	}

	/** Accounts currently below the floor. The operator's and the support reply's input. */
	stranded(): readonly StrandedAccount[] {
		return strandedAccounts(this.db);
	}

	/** Everything ever recorded, including resolved rows. For the report. */
	strandedHistory(): readonly StrandedAccount[] {
		return strandedAccounts(this.db, { includeResolved: true });
	}

	/** Total lamports sitting below the floor right now. */
	strandedLamports(): bigint {
		return this.stranded().reduce((t, s) => t + s.lamports, 0n);
	}
}

/**
 * Read the stranded accounts without constructing a sweeper.
 *
 * Separate from the class because REPORTING MUST NOT REQUIRE THE CONFIGURATION
 * THAT SWEEPS. The CLI an operator runs to answer "what is stranded" would
 * otherwise need a hot address configured, and would therefore fail on exactly
 * the box where the rail is not set up yet — which is the box where the
 * question gets asked. The capability to read is not the capability to plan a
 * movement, and keeping them apart is the same instinct as the read-only
 * adapters elsewhere in this service.
 */
export function strandedAccounts(
	db: Database,
	opts?: { readonly includeResolved?: boolean },
): readonly StrandedAccount[] {
	db.exec(SCHEMA);
	const sql =
		opts?.includeResolved === true
			? `SELECT * FROM sol_stranded_account ORDER BY idx`
			: `SELECT * FROM sol_stranded_account WHERE resolved_at IS NULL ORDER BY idx`;
	return (db.prepare(sql).all() as StrandedRaw[]).map(hydrateStranded);
}

function hydrateStranded(r: StrandedRaw): StrandedAccount {
	return {
		index: r.idx,
		address: r.address,
		lamports: BigInt(r.lamports),
		reason: "below_dust_floor",
		firstSeenAt: r.first_seen_at,
		lastSeenAt: r.last_seen_at,
		observations: r.observations,
		resolvedAt: r.resolved_at,
	};
}

/* ------------------------------------------------------- customer wording */

/**
 * WHAT A CUSTOMER IS TOLD ABOUT A SUB-FLOOR DEPOSIT.
 *
 * In code next to the floor that produced it, because the two have already
 * drifted once elsewhere in this service: RAIL_BLOCKERS exists because the
 * real cause of a refusal sat in a log while the customer read a generic
 * paragraph.
 *
 * The sentence says the three things that are true and nothing that is not:
 * the money arrived, it has not been credited, and IT IS STILL THERE. The last
 * part is only honest because a pool address belongs to one customer
 * permanently — so "deposit more to the same address" genuinely works, and the
 * combined balance is swept by the next pass. The two wrong answers are
 * silently keeping it (theft) and silently crediting it (a liability with no
 * retrievable asset).
 */
export function strandedDepositMessage(lamports: bigint): string {
	return (
		`${formatSol(lamports)} SOL arrived at your deposit address. It is below ` +
		`our ${formatSol(SOL_MINIMUM_DEPOSIT_LAMPORTS)} SOL minimum and costs more ` +
		"to move than it is worth, so we have not credited it. It is still there: " +
		"deposit more to the same address and we will sweep the combined balance."
	);
}

/** Lamports as a plain decimal SOL string. Operator and customer output only. */
export function formatSol(lamports: bigint): string {
	const whole = lamports / LAMPORTS_PER_SOL;
	const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
	return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/* ---------------------------------------------------- the ledger's shape */

/**
 * THE POSTINGS A SWEEP MUST PRODUCE, described rather than performed.
 *
 * Described, because nothing in this service may post a sweep yet: no
 * transaction has been signed, so there is nothing to book, and a ledger entry
 * for a movement that did not happen is worse than none. Described rather than
 * left to the broadcast runner's author, because the fee posting is the piece
 * that gets forgotten and the consequence is not a cosmetic one:
 *
 *   holdings fall by amount + fee
 *   books fall by amount
 *   => a small, persistent, steadily GROWING shortfall
 *
 * and reconcile.ts gives a shortfall NO tolerance at any size — it halts
 * withdrawals for the asset. The venue would have halted itself, with no
 * attacker and no chain fault, by not writing down a 5,000-lamport fee.
 *
 * `gasgate.checkGas` cannot save anyone here: both of its numbers are ledger
 * reads, not chain reads, and it short-circuits `ok: true, selfFunding: true`
 * whenever the gas asset is the asset itself — which SOL is. The gas check
 * passes for SOL today while SOL cannot take a deposit at all.
 */
export function sweepLedgerShape(batch: SweepBatch): {
	readonly idempotencyKey: string;
	readonly movements: readonly string[];
} {
	return {
		idempotencyKey: batch.proposalKey,
		movements: [
			...batch.sources.map(
				(s) =>
					`CUSTODY[SOL.SOL @ ${s.address}] -${s.lamports} -> ` +
					`CUSTODY[SOL.SOL @ ${batch.destination}] +${s.lamports}`,
			),
			`FEES[SOL] -${batch.feeLamports} -> EXTERNAL +${batch.feeLamports}`,
		],
	};
}
