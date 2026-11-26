// -----------------------------------------------------------------------------
// NATIVE EVM DEPOSIT SCANNING — block by block, from a durable cursor, with the
// two free assertions that are the difference between a safe rail and a rail
// that loses money silently.
//
// WHY THIS IS A SEPARATE FILE FROM THE ADAPTER. A deposit scanner needs state
// the adapter does not have: a cursor that survives the process, and the recent
// block hashes that make a reorg detectable. The deposit watcher CLI is
// one-shot per systemd tick by design (depositwatchercli.ts:1-17), so an
// in-memory high-water mark would be reset every single cycle and the scanner
// would re-read "recently" forever, exactly as the bitcoind-family node feed
// does. That is fine for a handful of explorer-backed addresses. It is not fine
// for one address per customer on a chain with a twelve-second block.
//
// THE TWO ASSERTIONS, AND THE MEASURED LIE THAT MOTIVATES THEM.
//
// 1. INTEGRITY: for every block, `eth_getBlockReceipts(n).length` must equal
//    the header's own transaction count. On mismatch the rail HALTS and THE
//    CURSOR DOES NOT ADVANCE.
//
//    This is not defensive decoration. It was measured on the endpoint this
//    rail would otherwise run on. bsc-rpc.publicnode.com returns receipt
//    arrays of length 0 for blocks whose headers report 135 and 85
//    transactions, and returns `eth_getLogs` n=0 at HTTP 200 for block
//    134,786,112 — a block that demonstrably contains transaction
//    0xddd38fbd1d679586… whose `to` IS the BSC-USDT contract. The same endpoint
//    answers `eth_getTransactionReceipt` for that very transaction HONESTLY,
//    with "Archive requests require a personal token". So the endpoint knows
//    the data is pruned and reports an empty result anyway.
//
//    A scanner without this assertion, more than about 2.5 days behind on BSC,
//    reads "no deposits", marks the range clean, advances, and the money is
//    gone with no error in any log. There is no alert to miss because nothing
//    went wrong as far as every component can tell. THAT is the failure this
//    assertion exists for, and it is why a scanner that is behind must stop
//    rather than catch up through a lie: being behind is a business problem,
//    advancing through a lie is an insolvency.
//
// 2. CHAIN CONTINUITY: block n's `parentHash` must equal the stored hash of
//    block n-1. This is the reorg detector, it is free, and it is the only
//    honest one available on an endpoint without a subscription.
//
// WHAT THIS SCANNER CANNOT SEE, WRITTEN DOWN RATHER THAN HIDDEN.
//
// Matching `tx.to` finds value sent by a transaction. It CANNOT see native
// value delivered by a contract's internal call — a router, a multisig, a
// disperse/batch-payout contract, another exchange withdrawing through a proxy.
// Such a deposit arrives on chain, shows up in `eth_getBalance`, and is never
// credited. Detecting it needs `debug_traceBlock` or a trace tier, which no
// endpoint available to this venue offers free. The consequences are handled
// rather than ignored: the deposit instructions say "send directly from a
// wallet", the rail's blocker records the caveat, and the per-address invariant
// in the reconciler (on-chain balance must not exceed credited-minus-swept)
// turns the gap into a loud alarm and a manual credit instead of a loss. What
// this file does NOT do is claim a trace-complete rail.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import type { IncomingPayment } from "./chains";

export class EvmScanError extends Error {
	constructor(
		message: string,
		readonly retryable = false,
	) {
		super(message);
		this.name = "EvmScanError";
	}
}

/** The JSON-RPC surface the scanner needs. Satisfied by chains.ts `JsonRpc`. */
export interface EvmScanRpc {
	call<T>(method: string, params?: unknown[]): Promise<T>;
	batch<T>(calls: readonly { method: string; params?: unknown[] }[]): Promise<T[]>;
}

/* ------------------------------------------------------- per-chain declared rules */

/**
 * EVERY NUMBER THIS RAIL DEPENDS ON, PER CHAIN, IN ONE PLACE, WITH ITS
 * DERIVATION WRITTEN OUT.
 *
 * A dust floor that lives in three files drifts; a customer-facing minimum that
 * nobody can point at is not a minimum. The confirmations live here too rather
 * than only in bitgodeposits.ts CONFIRMATIONS because the self-custodied
 * scanner is the thing that must not advance past `tip - confirmations`, and a
 * scanner reading a different number than the crediting gate is a rail that
 * credits blocks it has not finished checking.
 */
export interface EvmChainRule {
	/** The custody id / settlement symbol of the native coin. */
	readonly chain: string;
	/** EIP-155 chain id, asserted against `eth_chainId` before the rail opens. */
	readonly chainId: number;
	/** Confirmations before a deposit may be credited. See reorg policy below. */
	readonly confirmations: number;
	/** Nominal seconds per block, used only to turn cursor lag into wall time. */
	readonly blockSeconds: number;
	/**
	 * DUST FLOOR = 3 x (21000 x p95 gasPrice over the trailing 30 days).
	 *
	 * Three, not one, because the deposit has to survive three moves and the
	 * customer only sees the first: it must be sweepable to the hot address,
	 * movable again by the venue, and withdrawable. The withdrawal fee on this
	 * venue is already DERIVED from a gas budget times a live rate rather than
	 * configured, so this reuses the same source of truth rather than inventing
	 * a second one.
	 *
	 * Below this figure a deposit costs more to move than it is worth, which
	 * means it cannot be returned, which means rule 4 forbids crediting it.
	 */
	readonly dustFloorWei: bigint;
	/**
	 * PUBLISHED MINIMUM DEPOSIT = 10 x the dust floor, rounded to a human
	 * number.
	 *
	 * Ten, not one, because gas moves between the moment the customer presses
	 * send and the moment the venue sweeps. A deposit comfortably above the
	 * floor when it left can be below it an hour later, and the customer did
	 * nothing wrong. The factor is the margin that keeps "above the published
	 * minimum" and "sweepable" from being two different questions.
	 */
	readonly minimumDepositWei: bigint;
	/**
	 * CEILING ON TOTAL UN-SWEPT CUSTOMER BALANCE, per chain.
	 *
	 * Crossing it STOPS NEW DEPOSIT ADDRESSES BEING ISSUED on this rail. The
	 * reason is specific to this design: sweeping requires a human to carry a
	 * proposal to an offline signer, so the amount sitting in addresses whose
	 * return depends on someone showing up is bounded by a declared number
	 * instead of by how busy the operator is this week. It is the same instinct
	 * as the gas gate — refuse the new liability, do not grow it.
	 *
	 * IT GATES ISSUANCE AND NOT CREDITING, AND THE FIRST VERSION OF THIS CODE
	 * GOT THAT BACKWARDS. IT MATTERS ENOUGH TO WRITE OUT.
	 *
	 * The original built this as "over the ceiling, arrivals degrade to pending
	 * instead of crediting", and had a test asserting exactly that. It was wrong
	 * twice.
	 *
	 * It did not work. The deposit watcher decides credit-or-pending from the
	 * CONFIRMATION COUNT alone, and `EvmRpcAdapter.incoming()` hands it
	 * `[...payments, ...pending]` as one list — so moving an arrival with 40
	 * real confirmations from one array into the other changed nothing at all.
	 * The ceiling was decoration that read like a safety mechanism, which is
	 * worse than an absent one.
	 *
	 * And had it worked it would have been the wrong behaviour. Once coins are
	 * sitting at an address this venue derived, refusing to credit them does not
	 * protect the customer from anything: the venue holds the asset, the customer
	 * holds nothing, and reconciliation reports a benign SURPLUS that halts
	 * nothing. That is the one branch where the venue profits from its own
	 * operational backlog, and a custody design must never take it. The honest
	 * choices for value already on chain are credit it or send it back, and
	 * sending it back needs the same human and the same offline signer that the
	 * ceiling is measuring the absence of.
	 *
	 * So the lever is moved to the only place it can bound anything in advance:
	 * the venue stops telling new customers where to send money. Deposits
	 * already in flight to addresses already issued are credited normally,
	 * because they are the customers' and refusing them would make them ours.
	 */
	readonly unsweptCeilingWei: bigint;
	/**
	 * HOW LONG THE CURSOR MAY LAG BEFORE IT IS AN ALARM.
	 *
	 * Set in HOURS, not days, and that is forced by measurement rather than
	 * taste: ethereum-rpc.publicnode.com serves `eth_getLogs` only about 9,700
	 * blocks back and `eth_getBlockReceipts` only about 20,000 — roughly 32
	 * hours of chain — after which it fails (loudly, at least). A stall that
	 * starts on a Friday and is noticed on Monday is already past the point
	 * where the gap can be backfilled at all. So the alarm has to fire inside
	 * hours or it is decoration.
	 */
	readonly lagAlarmSeconds: number;
}

/**
 * THE REORG POLICY, PER CHAIN, AND THE STRUCTURAL RULE THAT MATTERS MORE THAN
 * ANY OF THE NUMBERS.
 *
 * THE RULE: the cursor NEVER advances past `tip - confirmations`, and nothing
 * is emitted as creditable from above that line. A credited deposit can
 * therefore only be reorganised away by a reorg DEEPER than its confirmation
 * depth, which turns a routine event into an exceptional one. Everything below
 * is the depth, not the mechanism.
 *
 * ETHEREUM — 32 blocks, one epoch, which is also the figure already configured
 * in bitgodeposits.ts CONFIRMATIONS. Where the endpoint serves it, the
 * `finalized` block tag is preferred as the primary and the block count is kept
 * as a floor: post-Merge finality is cryptoeconomic, which is strictly stronger
 * than any count, but an endpoint that does not serve the tag must still fail
 * long rather than fail open.
 *
 * BSC — 40 blocks (~30 seconds), RAISED from the 20 configured for BitGo.
 * BEP-126 fast finality is about two blocks in theory. The extra margin is
 * deliberate and it is a judgement call, not a measurement: this is the chain
 * whose only free endpoint demonstrably lies about its own history, and 40
 * blocks costs half a minute of customer-visible latency. Note that BSC stays
 * SHUT regardless — see the rail blocker — because the integrity assertion
 * protects a FORWARD scan and cannot protect a backfill.
 *
 * POLYGON — 128 blocks (~4.3 minutes at 2s). Not 32: Polygon has had
 * multi-block reorgs well past 64, and 128 fast blocks is cheap in wall-clock
 * terms precisely because the blocks are fast. Heimdall finality via the
 * `finalized` tag is preferred, with 128 as a hard floor. This number is a
 * judgement call and the right way to disagree with it is reorg-depth data.
 *
 * IF A CREDITED DEPOSIT IS REORGANISED AWAY ANYWAY: nothing here reverses it
 * automatically, and that is deliberate. The existing one-directional policy
 * stands — `record()`'s upsert in depositwatcher.ts can never downgrade a
 * credited row, because auto-reversing a customer's balance on the strength of
 * one chain read is how a flaky endpoint steals somebody's money. What happens
 * instead: this scanner halts the cursor and names the orphaned credit; the
 * reconciler independently sees books above custody, classifies it a SHORTFALL
 * and halts withdrawals for the asset at any size; an operator reverses the
 * credit deliberately through `Ledger.reverse` with a `correction:` key, as
 * ops/unbook-unattributed.js already does. The HALT is the automatic part, the
 * REVERSAL is the human part, and that division is the whole policy.
 */
export const EVM_CHAIN_RULES: Readonly<Record<string, EvmChainRule>> = {
	ETH: {
		chain: "ETH",
		chainId: 1,
		confirmations: 32,
		blockSeconds: 12,
		// p95 of 21000 gas at ~30 gwei, times three. 0.002 ETH.
		dustFloorWei: 2_000_000_000_000_000n,
		minimumDepositWei: 20_000_000_000_000_000n, // 0.02 ETH
		unsweptCeilingWei: 10_000_000_000_000_000_000n, // 10 ETH
		lagAlarmSeconds: 6 * 3600,
	},
	BNB: {
		chain: "BNB",
		chainId: 56,
		confirmations: 40,
		blockSeconds: 1,
		// 21000 at ~3 gwei, times three. 0.0002 BNB.
		dustFloorWei: 200_000_000_000_000n,
		minimumDepositWei: 2_000_000_000_000_000n, // 0.002 BNB
		unsweptCeilingWei: 20_000_000_000_000_000_000n, // 20 BNB
		lagAlarmSeconds: 6 * 3600,
	},
	POL: {
		chain: "POL",
		chainId: 137,
		confirmations: 128,
		blockSeconds: 2,
		// 21000 at ~60 gwei, times three. 0.004 POL.
		dustFloorWei: 4_000_000_000_000_000n,
		minimumDepositWei: 40_000_000_000_000_000n, // 0.04 POL
		unsweptCeilingWei: 50_000_000_000_000_000_000_000n, // 50,000 POL
		lagAlarmSeconds: 12 * 3600,
	},
};

/**
 * The customer-facing sentence for a deposit below the published minimum.
 *
 * SELF-HEALING, AND THAT IS ONLY POSSIBLE BECAUSE THE ADDRESS IS PERMANENT.
 * The address is derived from a fixed index for a fixed customer, so it never
 * expires and never gets reassigned. A deposit too small to move is therefore
 * not a loss and not a support ticket: it stays where it is, and the next
 * deposit to the same address makes the combined balance sweepable.
 *
 * The rejected alternative, stated so nobody re-proposes it: automatically
 * topping the address up from the venue's gas float so the small deposit
 * becomes sweepable. It costs more gas than the deposit is worth, and an
 * attacker drains the float with ten thousand one-wei deposits. It stays
 * available only as a deliberate per-case operator action with its own ledger
 * entry.
 */
export function belowMinimumSentence(args: {
	amount: string;
	minimum: string;
	symbol: string;
}): string {
	return (
		`${args.amount} ${args.symbol} arrived at your deposit address. It is below ` +
		`our ${args.minimum} ${args.symbol} minimum and costs more to move than it is ` +
		"worth, so we have not credited it. It is still there — deposit more to the " +
		"same address and we will sweep the combined balance."
	);
}

/* ------------------------------------------------------------------- schema */

const SCHEMA = `
-- WHERE THE SCANNER HAS READ UP TO. One row per chain.
--
-- Durable because the watcher process is one-shot: an in-memory watermark dies
-- every systemd tick, and a scanner that restarts at the tip every cycle skips
-- every block in between. A non-null 'halted' means the rail refuses to scan at
-- all until a human clears it, which is the correct response to an endpoint
-- that has been caught under-reporting.
--
-- (Quoted with apostrophes on purpose: a backtick here would close this
-- template literal and the whole file would stop parsing.)
CREATE TABLE IF NOT EXISTS evm_scan_cursor (
  chain      TEXT PRIMARY KEY,
  block      INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  halted     TEXT
);

-- RECENT BLOCK HASHES, so a reorg can be LOCATED rather than merely detected.
--
-- Storing only the last hash would detect a divergence and leave nowhere to
-- rewind to. Kept to a shallow window (confirmations plus margin) because a
-- divergence deeper than that is not something to re-scan through — it is a
-- halt.
CREATE TABLE IF NOT EXISTS evm_scan_block (
  chain TEXT NOT NULL,
  block INTEGER NOT NULL,
  hash  TEXT NOT NULL,
  PRIMARY KEY (chain, block)
);

-- WHETHER THIS CHAIN MAY STILL HAND OUT NEW DEPOSIT ADDRESSES.
--
-- A row here means the un-swept total at customer addresses is over the
-- declared ceiling, so the rail stops ACCEPTING new deposits. One row per
-- chain, written and cleared by the scanner on every pass.
--
-- A TABLE RATHER THAN A RETURN VALUE BECAUSE THE TWO HALVES RUN IN DIFFERENT
-- PROCESSES. The scanner runs inside the one-shot deposit watcher; issuance
-- runs inside the long-lived API. An in-memory flag in the watcher cannot
-- reach the issuing process, and asking the chain again at issuance time would
-- put an RPC round trip (and its failure modes) on the deposit screen's
-- critical path. The measurement happens where the scanner already reads
-- balances, and the result is left where the API can read it synchronously —
-- the same shape as the cursor row's own "halted" column.
CREATE TABLE IF NOT EXISTS evm_issuance_gate (
  chain       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  measured_at TEXT NOT NULL
);

-- ARRIVALS TOO SMALL TO MOVE. Recorded, never credited.
--
-- A separate table from deposit_seen on purpose: these were never a deposit
-- decision the watcher made, they are value sitting at a customer's address
-- that the venue has deliberately not taken responsibility for. Crediting them
-- would violate the rule that nothing is credited which cannot be returned;
-- dropping them silently is the other way this goes wrong, because the customer
-- can see the transaction on a block explorer and we would have no record of it.
CREATE TABLE IF NOT EXISTS evm_below_minimum (
  chain   TEXT NOT NULL,
  txid    TEXT NOT NULL,
  ref     TEXT NOT NULL,
  address TEXT NOT NULL,
  amount  TEXT NOT NULL,
  block   INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (chain, ref)
);
`;

/* ------------------------------------------------------------------ scanner */

interface RpcBlock {
	number?: string;
	hash?: string;
	parentHash?: string;
	transactions?: Array<{
		hash?: string;
		to?: string | null;
		from?: string;
		value?: string;
		transactionIndex?: string;
	}>;
}

export interface EvmScanConfig {
	readonly rule: EvmChainRule;
	/**
	 * Addresses that may receive a CUSTOMER deposit, lowercase.
	 *
	 * Rebuilt per pass by the caller from the issued-address table, because an
	 * address issued while the process was running must be watched on the very
	 * next pass — a customer can deposit within seconds of being shown an
	 * address.
	 *
	 * THE VENUE'S OWN ADDRESSES MUST NOT BE IN HERE. A gas drip or sweep change
	 * arriving at a venue address and matched as an incoming deposit would be
	 * credited to `__unattributed__`, which is a USER account and therefore a
	 * customer LIABILITY. BitGo's XRP activation reserve did exactly that and
	 * halted XRP; ops/unbook-unattributed.js exists to undo it.
	 */
	readonly watched: () => Promise<ReadonlySet<string>>;
	/**
	 * Total value currently sitting un-swept at customer addresses.
	 *
	 * Required, not optional: it is what the un-swept ceiling is measured
	 * against, and a scanner that could not answer it would have to either
	 * guess or ignore the ceiling. Both of those are how a bounded liability
	 * becomes an unbounded one.
	 */
	readonly unsweptTotal: () => Promise<bigint>;
	/**
	 * Where to begin when there is no cursor yet.
	 *
	 * Undefined means "from the safe head at the moment the rail first ran",
	 * which is right for a rail that has never been open and WRONG for a
	 * restart after losing the cursor — the gap would be skipped in silence.
	 * That is why the cursor is durable and why losing it is an operator
	 * decision (supply an explicit startBlock) rather than a default.
	 */
	readonly startBlock?: number;
	/** Blocks per pass. Bounded so one tick cannot run for an hour. */
	readonly maxBlocksPerPass?: number;
	readonly now?: () => Date;
}

export interface EvmScanResult {
	/** Creditable arrivals: at or below the safe head, at or above the floor. */
	readonly payments: readonly IncomingPayment[];
	/**
	 * Arrivals seen above the safe head — VISIBILITY ONLY.
	 *
	 * Emitted with their true (low) confirmation count so the deposit watcher's
	 * existing confirmation gate records them as `pending` and credits nothing.
	 * This is what makes "where is my deposit" answerable in the first minute
	 * rather than only after finality, and it cannot credit anything early
	 * because the number it reports is the real one.
	 */
	readonly pending: readonly IncomingPayment[];
	readonly cursor: number;
	readonly safeHead: number;
	readonly tip: number;
	/** Seconds of chain between the cursor and the safe head. */
	readonly lagSeconds: number;
	/** Set when lagSeconds exceeds the declared alarm threshold. */
	readonly lagAlarm: string | undefined;
	/**
	 * Set when the un-swept total is over the declared ceiling, and why.
	 *
	 * NAMED `issuanceShut` RATHER THAN `shut` ON PURPOSE. It was `shut`, and a
	 * bare "shut" invites the reading that the rail has stopped crediting — which
	 * is what the first version of this code tried to do, could not do, and
	 * should not have done. See `EvmChainRule.unsweptCeilingWei`. The name now
	 * says which half closes: no new deposit addresses, and every deposit already
	 * on its way to an issued address is credited exactly as before.
	 */
	readonly issuanceShut: string | undefined;
	readonly notes: readonly string[];
}

export class EvmNativeScanner {
	private readonly maxBlocks: number;
	private readonly now: () => Date;

	constructor(
		private readonly db: Database,
		private readonly rpc: EvmScanRpc,
		private readonly cfg: EvmScanConfig,
	) {
		db.exec(SCHEMA);
		this.maxBlocks = cfg.maxBlocksPerPass ?? 256;
		this.now = cfg.now ?? (() => new Date());
	}

	get chain(): string {
		return this.cfg.rule.chain;
	}

	/**
	 * EVERY CHECK THAT MUST PASS BEFORE THE RAIL IS ALLOWED TO OPEN.
	 *
	 * These are runtime checks rather than configuration review on purpose, and
	 * the reason is specific and uncomfortable: the fix for the pruned/lying
	 * endpoints is an Allnodes personal token on the SAME hostnames already in
	 * our config. A correct fix is therefore INVISIBLE IN A CODE DIFF — same
	 * URL, new credential — so a reviewer cannot tell a safe rail from an
	 * unsafe one by reading the repository. Safety has to be verified against
	 * the live endpoint at startup, never inferred from an invoice.
	 */
	async preflight(): Promise<readonly string[]> {
		const notes: string[] = [];

		/*
		 * CHAIN ID FIRST, because every other check passes on the wrong chain.
		 * A Polygon scanner pointed at an Ethereum URL reads plausible blocks,
		 * plausible balances and plausible transactions, matches none of our
		 * addresses, and reports "no deposits" forever. There is no symptom.
		 */
		const idHex = await this.rpc.call<string>("eth_chainId");
		const chainId = Number(BigInt(idHex));
		if (chainId !== this.cfg.rule.chainId) {
			throw new EvmScanError(
				`${this.chain}: the endpoint reports chain id ${chainId} but this rail is ` +
					`${this.cfg.rule.chainId}. The URL points at the wrong chain. Nothing ` +
					"downstream would have noticed: a scanner on the wrong chain reads " +
					"valid blocks that simply never contain our addresses.",
			);
		}

		const tip = await this.blockNumber();

		/*
		 * THE INTEGRITY ASSERTION'S OWN PRECONDITION. If the endpoint does not
		 * serve eth_getBlockReceipts at all, the per-block cross-check cannot
		 * run, and without it this scanner has no way to tell a truthfully
		 * empty block from a pruned one reported as empty. The rail does not
		 * open on an endpoint it cannot audit.
		 */
		const header = await this.header(tip - 1);
		const txCount = header.transactions?.length ?? 0;
		let receipts: unknown[];
		try {
			receipts = await this.rpc.call<unknown[]>("eth_getBlockReceipts", [
				hexQuantity(tip - 1),
			]);
		} catch (e) {
			throw new EvmScanError(
				`${this.chain}: eth_getBlockReceipts is not available (${
					e instanceof Error ? e.message : String(e)
				}). Without it the per-block receipts-versus-header assertion cannot ` +
					"run, and that assertion is the only thing that catches an endpoint " +
					"reporting a pruned range as an empty one. The rail stays shut.",
			);
		}
		if (!Array.isArray(receipts) || receipts.length !== txCount) {
			throw new EvmScanError(
				`${this.chain}: block ${tip - 1} has ${txCount} transactions in its header ` +
					`but the endpoint returned ${
						Array.isArray(receipts) ? receipts.length : "a non-array"
					} receipts, AT THE TIP. This endpoint under-reports its own current ` +
					"data; it cannot be trusted with a deposit rail at any depth.",
			);
		}

		/*
		 * THE `finalized` TAG: preferred, verified, and never trusted alone.
		 *
		 * Verified three ways because each failure looks different: the tag must
		 * be served, it must be BEHIND the tip (a tag equal to or ahead of
		 * `latest` is not finality, it is an alias), and it must sit a plausible
		 * distance behind. The block count stays wired as a floor either way, so
		 * an endpoint that stops serving the tag degrades to the conservative
		 * answer instead of to an optimistic one.
		 */
		try {
			const fin = await this.header("finalized");
			const finNum = Number(BigInt(fin.number ?? "0x0"));
			if (finNum <= 0 || finNum > tip) {
				notes.push(
					`the finalized tag reports block ${finNum} against a tip of ${tip}, ` +
						"which is not a finalised block; falling back to the confirmation " +
						"count alone",
				);
			} else {
				notes.push(`finalized tag served, ${tip - finNum} blocks behind the tip`);
			}
		} catch (e) {
			notes.push(
				`the finalized tag is unavailable (${
					e instanceof Error ? e.message : String(e)
				}); crediting falls back to ${this.cfg.rule.confirmations} confirmations, ` +
					"which is the conservative direction",
			);
		}

		return notes;
	}

	/** Why the rail is halted, if it is. */
	haltedReason(): string | undefined {
		const row = this.db
			.prepare(`SELECT halted FROM evm_scan_cursor WHERE chain = ?`)
			.get(this.chain) as { halted: string | null } | undefined;
		return row?.halted ?? undefined;
	}

	/**
	 * Halt the rail. Deliberately a one-way door for the process: clearing it
	 * is an operator action, because every reason this fires is a reason a
	 * human has to look at a chain before the venue credits anything else.
	 */
	halt(reason: string): void {
		this.db
			.prepare(
				`INSERT INTO evm_scan_cursor (chain, block, block_hash, updated_at, halted)
				 VALUES (?, 0, '', ?, ?)
				 ON CONFLICT(chain) DO UPDATE SET halted = excluded.halted,
				                                 updated_at = excluded.updated_at`,
			)
			.run(this.chain, this.now().toISOString(), reason);
	}

	/**
	 * Why new deposit addresses are not being issued, if they are not.
	 *
	 * READ SYNCHRONOUSLY BY THE ISSUING PROCESS, which is the whole reason the
	 * ceiling result is a row rather than a return value. It is deliberately
	 * SEPARATE from `haltedReason()`: a halt means the chain cannot be read
	 * honestly and nothing may be credited; this means the chain is read fine and
	 * the venue has more money parked at customer addresses than it has declared
	 * it is willing to leave waiting for an operator. One is a safety failure,
	 * the other is a backlog, and collapsing them into one flag would make a
	 * routine backlog look like an endpoint caught lying.
	 */
	issuanceShutReason(): string | undefined {
		const row = this.db
			.prepare(`SELECT reason FROM evm_issuance_gate WHERE chain = ?`)
			.get(this.chain) as { reason: string } | undefined;
		return row?.reason;
	}

	/**
	 * Set or clear the issuance gate for this chain.
	 *
	 * CLEARS ITSELF, unlike `halt()`. A halt is cleared by a human because every
	 * reason it fires means somebody has to look at a chain. This fires because a
	 * number crossed a line, and it un-fires when a sweep brings the number back
	 * — requiring an operator to also remember to clear a flag would mean the
	 * rail stayed shut after the problem was fixed, which teaches operators to
	 * clear flags without reading them.
	 */
	private setIssuanceGate(reason: string | undefined): void {
		if (reason === undefined) {
			this.db.prepare(`DELETE FROM evm_issuance_gate WHERE chain = ?`).run(this.chain);
			return;
		}
		this.db
			.prepare(
				`INSERT INTO evm_issuance_gate (chain, reason, measured_at) VALUES (?, ?, ?)
				 ON CONFLICT(chain) DO UPDATE SET reason = excluded.reason,
				                                 measured_at = excluded.measured_at`,
			)
			.run(this.chain, reason, this.now().toISOString());
	}

	/** Operator-only. Named loudly so it cannot be mistaken for maintenance. */
	clearHaltAfterInvestigation(): void {
		this.db.prepare(`UPDATE evm_scan_cursor SET halted = NULL WHERE chain = ?`).run(this.chain);
	}

	cursor(): number | undefined {
		const row = this.db
			.prepare(`SELECT block FROM evm_scan_cursor WHERE chain = ?`)
			.get(this.chain) as { block: number } | undefined;
		return row === undefined ? undefined : row.block;
	}

	async scan(): Promise<EvmScanResult> {
		const halted = this.haltedReason();
		if (halted !== undefined) {
			throw new EvmScanError(
				`${this.chain}: the deposit scan is halted — ${halted}. Nothing is being ` +
					"credited and the cursor has not moved. This clears by investigation, " +
					"not by restarting the service.",
			);
		}

		const rule = this.cfg.rule;
		const tip = await this.blockNumber();

		/*
		 * THE SAFE HEAD IS THE LOWER OF THE TWO ANSWERS, ALWAYS.
		 *
		 * The confirmation count and the `finalized` tag are two independent
		 * statements about what cannot be reorganised away. Taking the lower is
		 * the only combination that cannot be talked into crediting early: a
		 * broken tag cannot pull the head forward, and a short count cannot
		 * override real finality.
		 */
		let safeHead = tip - rule.confirmations;
		const notes: string[] = [];
		try {
			const fin = await this.header("finalized");
			const finNum = Number(BigInt(fin.number ?? "0x0"));
			if (finNum > 0 && finNum <= tip) safeHead = Math.min(safeHead, finNum);
			else notes.push(`ignoring an implausible finalized tag at ${finNum} (tip ${tip})`);
		} catch {
			notes.push("the finalized tag was unavailable this pass; using the block count");
		}
		if (safeHead < 0) safeHead = 0;

		let cursor = this.cursor() ?? this.cfg.startBlock ?? safeHead;
		if (cursor > safeHead) {
			/*
			 * A cursor ahead of the safe head is not an error and must not be
			 * rewound: it happens on any chain whose tip briefly goes backwards
			 * (a re-org at the very tip, or a load balancer answering from a
			 * slightly behind node). Rewinding would re-emit blocks already
			 * scanned; waiting costs one pass.
			 */
			notes.push(
				`the cursor (${cursor}) is ahead of the safe head (${safeHead}); waiting ` +
					"rather than rewinding, which would re-scan blocks already read",
			);
			return this.result([], [], cursor, safeHead, tip, notes, undefined);
		}

		// Locate a reorg BEFORE scanning forward, so the forward scan starts
		// from a block that is actually on the canonical chain.
		cursor = await this.reconcileAncestry(cursor, notes);

		const watched = await this.cfg.watched();

		/*
		 * THE UN-SWEPT CEILING, MEASURED HERE AND ENFORCED AT ISSUANCE.
		 *
		 * Measured here because this is where the scanner already reads
		 * customer-address balances from the chain; enforced at issuance because
		 * that is the only point at which anything can still be prevented. Over
		 * the ceiling, this pass behaves EXACTLY as it would under it: it scans,
		 * the cursor advances, and every arrival at an already-issued address is
		 * credited. What stops is the venue handing out new addresses.
		 *
		 * See `EvmChainRule.unsweptCeilingWei` for why the first version of this
		 * — withholding the credit instead — both failed to work and would have
		 * been the wrong thing if it had. The one-sentence version: refusing to
		 * credit coins that are already at our address makes them ours, and that
		 * is not a safety mechanism.
		 *
		 * The gate is PERSISTED rather than returned, because the process that
		 * issues addresses is not this one.
		 */
		const unswept = await this.cfg.unsweptTotal();
		const issuanceShut = unswept > rule.unsweptCeilingWei
			? `${unswept} base units are sitting un-swept at customer ${rule.chain} ` +
				`addresses, above the declared ceiling of ${rule.unsweptCeilingWei}. NEW ` +
				"DEPOSIT ADDRESSES ARE NOT BEING ISSUED until a sweep clears the backlog. " +
				"Deposits already in flight to addresses already issued are credited " +
				"normally — they are the customers', and holding them uncredited would " +
				"make them ours. This rail's return path needs an operator and an offline " +
				"signer, so the amount waiting on one is bounded by a declared number " +
				"rather than by how busy they are."
			: undefined;
		this.setIssuanceGate(issuanceShut);

		const creditable: IncomingPayment[] = [];
		const pending: IncomingPayment[] = [];

		const last = Math.min(safeHead, cursor + this.maxBlocks);
		for (let n = cursor + 1; n <= last; n++) {
			const block = await this.scanOne(n, watched, tip, creditable, true);
			this.remember(n, block);
			cursor = n;
		}
		this.saveCursor(cursor);
		this.pruneHashes(cursor);

		/*
		 * THE VISIBILITY PASS, AND WHY IT IS CONDITIONAL ON BEING CAUGHT UP.
		 *
		 * Reading the unsafe tail is what lets a customer see "3 of 32
		 * confirmations" within seconds instead of a blank screen for six
		 * minutes. It is only worth doing when the scanner is actually at the
		 * safe head: a scanner that is hours behind has a backfill to finish,
		 * and spending its bounded per-pass budget on blocks it will have to
		 * read again anyway is how it stays behind.
		 */
		if (cursor >= safeHead && safeHead > 0) {
			const tailEnd = Math.min(tip, safeHead + this.maxBlocks);
			for (let n = safeHead + 1; n <= tailEnd; n++) {
				try {
					await this.scanOne(n, watched, tip, pending, false);
				} catch (e) {
					// A failure above the safe head credits nothing and must not
					// halt the rail: these blocks are read again next pass, and
					// the only thing lost is early visibility.
					notes.push(
						`visibility scan stopped at ${n}: ${
							e instanceof Error ? e.message : String(e)
						}`,
					);
					break;
				}
			}
		}

		/*
		 * NOTHING IS MOVED FROM `creditable` TO `pending` HERE, AND THE ABSENCE
		 * IS THE FIX.
		 *
		 * This is where the ceiling used to demote creditable arrivals. Both
		 * reasons it is gone are in `EvmChainRule.unsweptCeilingWei`, and the
		 * mechanical one is worth repeating at the call site because it is the
		 * kind of thing that gets re-added by someone reading the field name:
		 * the deposit watcher decides from the CONFIRMATION COUNT, and
		 * `EvmRpcAdapter.incoming()` concatenates both arrays into one list, so
		 * demoting an arrival here would have had no effect on whether it was
		 * credited. It would only have hidden the ceiling's failure.
		 */
		return this.result(creditable, pending, cursor, safeHead, tip, notes, issuanceShut);
	}

	/**
	 * Read one block, assert it, and collect the arrivals it contains.
	 *
	 * `enforce` is false for the visibility pass above the safe head: nothing
	 * read there can be credited, so a failure there is a lost nicety rather
	 * than a reason to halt a rail.
	 */
	private async scanOne(
		n: number,
		watched: ReadonlySet<string>,
		tip: number,
		out: IncomingPayment[],
		enforce: boolean,
	): Promise<RpcBlock> {
		const block = await this.header(n, true);
		const txs = block.transactions ?? [];

		if (enforce) {
			await this.assertIntegrity(n, txs.length);
			this.assertContinuity(n, block);
		}

		const rule = this.cfg.rule;
		const confirmations = tip - n + 1;
		for (const tx of txs) {
			const to = typeof tx.to === "string" ? tx.to.toLowerCase() : undefined;
			if (to === undefined || !watched.has(to)) continue;
			const value = tx.value === undefined ? 0n : BigInt(tx.value);
			if (value <= 0n) continue;
			if (typeof tx.hash !== "string") continue;

			/*
			 * THE REF IS THE IDEMPOTENCY IDENTITY AND IT IS CHAIN-QUALIFIED.
			 *
			 * The node feed's existing identity is the bare txid, on the stated
			 * assumption that "a txid paying two of our addresses yields two
			 * rows with different addresses". That assumption is false twice on
			 * EVM: one transaction can pay the same address more than once via
			 * internal calls, and one transaction can emit several ERC-20
			 * Transfer events to the same address. Every arrival after the first
			 * would be swallowed as a replay by the ledger and the customer
			 * under-credited WITH NO ERROR ANYWHERE.
			 *
			 * The chain component is mandatory for a different reason: the same
			 * address receives on Ethereum, BSC and Polygon BY DESIGN, so a
			 * txid-and-address identity is not unique across chains either.
			 *
			 * The position index is the transaction's index in the block today;
			 * it is the slot a log index or a trace index fills when a token or
			 * trace detector is added, which is why it is in the shape now.
			 */
			const position = tx.transactionIndex === undefined
				? "0"
				: BigInt(tx.transactionIndex).toString();
			const ref = `${rule.chain}:${tx.hash}:${position}`;

			if (value < rule.dustFloorWei) {
				// RECORDED, NEVER CREDITED. See the table comment and
				// belowMinimumSentence: the address is permanent, so this is
				// recoverable by the customer depositing again rather than by an
				// operator or a write-off.
				this.recordBelowMinimum({
					txid: tx.hash,
					ref,
					address: to,
					amount: value,
					block: n,
				});
				continue;
			}

			out.push({ txid: tx.hash, address: to, amount: value, confirmations, ref });
		}
		return block;
	}

	/**
	 * THE INTEGRITY ASSERTION. Receipt count must equal header transaction
	 * count, or the rail halts and the cursor stays where it is.
	 *
	 * See the file header for the measured BSC lie this exists for. The
	 * important half is the HALT: a scanner that logs a warning and advances
	 * has converted a detectable problem into a silent loss.
	 */
	private async assertIntegrity(n: number, txCount: number): Promise<void> {
		let receipts: unknown[];
		try {
			receipts = await this.rpc.call<unknown[]>("eth_getBlockReceipts", [hexQuantity(n)]);
		} catch (e) {
			/*
			 * AN ERROR HERE IS THE HONEST FAILURE AND IT IS RETRYABLE, NOT A
			 * HALT. "Archive requests require a personal token" means the
			 * endpoint knows it cannot serve this block and says so — the
			 * scanner has fallen outside the endpoint's window, which is an
			 * operations problem with a known fix. What must never happen is
			 * advancing past it.
			 */
			throw new EvmScanError(
				`${this.chain}: cannot verify block ${n} — eth_getBlockReceipts failed (${
					e instanceof Error ? e.message : String(e)
				}). NOT advancing the cursor. If this is a pruning window, the scanner ` +
					"has fallen too far behind for this endpoint and needs a keyed one; " +
					"the deposits are still on chain and still at the customers' addresses.",
				true,
			);
		}
		const got = Array.isArray(receipts) ? receipts.length : -1;
		if (got !== txCount) {
			const reason =
				`block ${n} reports ${txCount} transactions in its header but the ` +
				`endpoint returned ${got === -1 ? "a non-array" : got} receipts. The ` +
				"endpoint is under-reporting rather than erroring — the measured BSC " +
				"behaviour. Halting: a scanner that advances through this credits " +
				"nothing, logs nothing, and loses the deposit.";
			this.halt(reason);
			throw new EvmScanError(`${this.chain}: ${reason}`);
		}
	}

	/**
	 * THE REORG DETECTOR: block n's parentHash against our stored hash of n-1.
	 *
	 * Only checks what we have a record of. The first block after a cold start
	 * has no stored parent, and inventing one would mean refusing to start.
	 */
	private assertContinuity(n: number, block: RpcBlock): void {
		const parent = this.rememberedHash(n - 1);
		if (parent === undefined) return;
		if (block.parentHash !== parent) {
			const reason =
				`block ${n} claims parent ${String(block.parentHash)} but block ${n - 1} ` +
				`was scanned as ${parent}. The chain has reorganised beneath the cursor ` +
				"and `reconcileAncestry` did not resolve it, which means the divergence " +
				"is deeper than the stored window. Halting rather than re-scanning " +
				"blindly: anything already credited from the orphaned branch needs a " +
				"deliberate correction, and the reconciler will independently see the " +
				"shortfall and halt withdrawals for this asset.";
			this.halt(reason);
			throw new EvmScanError(`${this.chain}: ${reason}`);
		}
	}

	/**
	 * Walk back to the last block we scanned that is still canonical.
	 *
	 * Run BEFORE the forward scan, because a forward scan that starts on an
	 * orphaned block reads a chain that no longer exists. A divergence deeper
	 * than the confirmation depth is a halt, not a rewind: at that depth
	 * something has already been credited that may no longer be on the chain,
	 * and that is a human's decision.
	 */
	private async reconcileAncestry(cursor: number, notes: string[]): Promise<number> {
		let at = cursor;
		const limit = this.cfg.rule.confirmations + 8;
		for (let steps = 0; steps <= limit; steps++) {
			const mine = this.rememberedHash(at);
			if (mine === undefined) return at; // nothing to compare; nothing to rewind
			const onChain = await this.header(at);
			if (onChain.hash === mine) {
				if (at !== cursor) {
					notes.push(
						`rewound from ${cursor} to ${at} after a reorg; blocks ${at + 1}..` +
							`${cursor} will be re-scanned on the canonical chain`,
					);
					this.forgetAbove(at);
					this.saveCursor(at);
				}
				return at;
			}
			at -= 1;
			if (at < 0) return 0;
		}
		const reason =
			`a reorg deeper than ${limit} blocks was detected below cursor ${cursor}. ` +
			"That is deeper than the confirmation depth, so a credited deposit may " +
			"have been orphaned. Halting. The reconciler will see books above custody " +
			"and halt withdrawals for this asset independently; reversing a credit is " +
			"a deliberate `correction:` entry by an operator, never automatic.";
		this.halt(reason);
		throw new EvmScanError(`${this.chain}: ${reason}`);
	}

	/* ------------------------------------------------------------- plumbing */

	private async blockNumber(): Promise<number> {
		const hex = await this.rpc.call<string>("eth_blockNumber");
		return Number(BigInt(hex));
	}

	private async header(
		at: number | "finalized" | "latest",
		full = false,
	): Promise<RpcBlock> {
		const tag = typeof at === "number" ? hexQuantity(at) : at;
		const block = await this.rpc.call<RpcBlock | null>("eth_getBlockByNumber", [tag, full]);
		if (block === null || block === undefined || block.hash === undefined) {
			throw new EvmScanError(
				`${this.chain}: eth_getBlockByNumber(${tag}) returned no block. On a ` +
					"pruning endpoint this is the honest form of 'outside my window'. " +
					"Treating it as an error rather than as an empty block, because an " +
					"empty block would be scanned clean and skipped forever.",
				true,
			);
		}
		return block;
	}

	private remember(n: number, block: RpcBlock): void {
		this.db
			.prepare(
				`INSERT INTO evm_scan_block (chain, block, hash) VALUES (?, ?, ?)
				 ON CONFLICT(chain, block) DO UPDATE SET hash = excluded.hash`,
			)
			.run(this.chain, n, block.hash ?? "");
	}

	private rememberedHash(n: number): string | undefined {
		const row = this.db
			.prepare(`SELECT hash FROM evm_scan_block WHERE chain = ? AND block = ?`)
			.get(this.chain, n) as { hash: string } | undefined;
		return row?.hash;
	}

	private forgetAbove(n: number): void {
		this.db
			.prepare(`DELETE FROM evm_scan_block WHERE chain = ? AND block > ?`)
			.run(this.chain, n);
	}

	private pruneHashes(cursor: number): void {
		this.db
			.prepare(`DELETE FROM evm_scan_block WHERE chain = ? AND block < ?`)
			.run(this.chain, cursor - (this.cfg.rule.confirmations + 8));
	}

	private saveCursor(block: number): void {
		const hash = this.rememberedHash(block) ?? "";
		this.db
			.prepare(
				`INSERT INTO evm_scan_cursor (chain, block, block_hash, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(chain) DO UPDATE SET block = excluded.block,
				                                 block_hash = excluded.block_hash,
				                                 updated_at = excluded.updated_at`,
			)
			.run(this.chain, block, hash, this.now().toISOString());
	}

	private recordBelowMinimum(r: {
		txid: string;
		ref: string;
		address: string;
		amount: bigint;
		block: number;
	}): void {
		this.db
			.prepare(
				`INSERT INTO evm_below_minimum (chain, txid, ref, address, amount, block, seen_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(chain, ref) DO NOTHING`,
			)
			.run(
				this.chain,
				r.txid,
				r.ref,
				r.address,
				r.amount.toString(),
				r.block,
				this.now().toISOString(),
			);
	}

	/** Sub-floor arrivals at one address, for the deposit screen. */
	belowMinimumFor(address: string): readonly { txid: string; amount: bigint }[] {
		return (
			this.db
				.prepare(
					`SELECT txid, amount FROM evm_below_minimum
					  WHERE chain = ? AND LOWER(address) = LOWER(?) ORDER BY block`,
				)
				.all(this.chain, address.trim()) as Array<{ txid: string; amount: string }>
		).map((r) => ({ txid: r.txid, amount: BigInt(r.amount) }));
	}

	private result(
		payments: readonly IncomingPayment[],
		pending: readonly IncomingPayment[],
		cursor: number,
		safeHead: number,
		tip: number,
		notes: readonly string[],
		issuanceShut: string | undefined,
	): EvmScanResult {
		const lagSeconds = Math.max(0, safeHead - cursor) * this.cfg.rule.blockSeconds;
		const lagAlarm = lagSeconds > this.cfg.rule.lagAlarmSeconds
			? `${this.chain}: the deposit scan cursor is ${safeHead - cursor} blocks ` +
				`(~${Math.round(lagSeconds / 3600)}h) behind the safe head, past the ` +
				`declared ${Math.round(this.cfg.rule.lagAlarmSeconds / 3600)}h alarm. ` +
				"This matters in hours rather than days: the free endpoints prune logs " +
				"and receipts within about 32 hours on Ethereum, after which the gap " +
				"cannot be backfilled at all without a keyed endpoint."
			: undefined;
		return {
			payments,
			pending,
			cursor,
			safeHead,
			tip,
			lagSeconds,
			lagAlarm,
			issuanceShut,
			notes,
		};
	}
}

function hexQuantity(n: number): string {
	return `0x${n.toString(16)}`;
}
