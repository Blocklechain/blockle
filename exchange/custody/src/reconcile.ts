// -----------------------------------------------------------------------------
// RECONCILIATION — the control that catches everything the others miss.
//
// Every other safeguard in this service is a check on our own code: the ledger
// proves it is internally consistent, the triggers prove nobody edited history,
// the amount module proves no precision was lost. None of them can detect the
// failure that actually bankrupts an exchange, which is that THE MONEY IS NOT
// THERE. Books can be perfectly self-consistent and still describe assets the
// venue does not hold.
//
// So this module compares two independently-derived numbers:
//
//   WHAT WE OWE   = sum(USER) + sum(FEES) + sum(INFLIGHT)   [from the ledger]
//   WHAT WE HOLD  = the custodian's confirmed balance        [from BitGo]
//
// and it does so in two separate steps, because conflating them hides which
// half is wrong:
//
//   INTERNAL  booksCustody - liabilities   must be EXACTLY zero.
//             A break here is a bug in how some flow posts its entries. It is
//             arithmetic on our own rows, so there is no tolerance to grant:
//             if this is non-zero, code is wrong.
//
//   EXTERNAL  providerHoldings - booksCustody   must be zero, or explained.
//             A break here means reality diverged from the books: a deposit we
//             never credited, a withdrawal that moved more than we recorded, an
//             unjournaled network fee, or an unauthorised outflow.
//
// THE DIRECTION OF AN EXTERNAL BREAK DETERMINES THE RESPONSE, and treating the
// two alike would be a serious mistake:
//
//   SHORTFALL (we hold LESS than the books say)  -> HALT WITHDRAWALS.
//       The venue is, on its own records, unable to honour its obligations.
//       Every further withdrawal paid out while short is paid out of some other
//       customer's assets. This is the one condition where doing nothing is
//       actively harmful.
//
//   SURPLUS (we hold MORE than the books say)    -> investigate, do NOT halt.
//       Usually an uncredited deposit, which is a customer waiting on money
//       that is already safely held. Halting withdrawals would punish every
//       other customer for one accounting lag.
//
// A NOTE ON NETWORK FEES, because this is the most common false alarm and it is
// worth recognising on sight: if a withdrawal sends `amount` but the chain also
// takes `fee` from the same custodial balance, holdings fall by `amount + fee`
// while the books fall by `amount`. That presents as a small, persistent,
// steadily-growing SHORTFALL. It is not a theft and it is not a tolerance to
// widen — it is an unjournaled expense, and the fix is to post the fee
// (normally FEES -> EXTERNAL, the venue absorbing it). The reconciler flagging
// it is correct behaviour.
// -----------------------------------------------------------------------------

import { AccountKind, type Ledger } from "./ledger";

/**
 * What a custodian must be able to tell us. Deliberately tiny: reconciliation
 * needs only the confirmed balance, and a narrow interface is one that a test
 * double can honestly satisfy.
 */
export interface HoldingsSource {
	/** Human-readable, for reports: "bitgo", "blockle-signer", "mock". */
	readonly name: string;
	/**
	 * Confirmed holdings for an asset, in the asset's base units.
	 *
	 * CONFIRMED ONLY. Including unconfirmed balance would make the reconciler
	 * agree with a deposit that can still be reorged away, which is precisely
	 * the moment it needs to disagree.
	 */
	holdings(asset: string): Promise<bigint>;
}

export enum Status {
	OK = "ok",
	/** Our own rows do not add up. A code bug. */
	INTERNAL_BREAK = "internal_break",
	/** We hold less than we owe. Halt withdrawals. */
	SHORTFALL = "shortfall",
	/** We hold more than we owe. Investigate; keep running. */
	SURPLUS = "surplus",
	/** The custodian could not be reached. Not a break — an unknown. */
	UNAVAILABLE = "unavailable",
}

export interface AssetReport {
	readonly asset: string;
	readonly source: string;
	/** sum(USER) + sum(FEES) + sum(INFLIGHT) */
	readonly liabilities: bigint;
	/** The CUSTODY account's ledger balance. */
	readonly booksCustody: bigint;
	/** The custodian's confirmed balance, or undefined if unreachable. */
	readonly providerHoldings: bigint | undefined;
	/** booksCustody - liabilities. Must be 0n. */
	readonly internalDelta: bigint;
	/** providerHoldings - booksCustody. Negative is a shortfall. */
	readonly externalDelta: bigint | undefined;
	readonly status: Status;
	/** Plain-language account of what was found, for the operator and the log. */
	readonly detail: string;
	/** True when withdrawals for this asset must stop. */
	readonly haltWithdrawals: boolean;
}

export interface Report {
	readonly checkedAt: string;
	readonly assets: readonly AssetReport[];
	/** True only if every asset is OK. */
	readonly ok: boolean;
	/** Assets whose withdrawals must be halted. */
	readonly halted: readonly string[];
}

export interface ReconcileOptions {
	/**
	 * Per-asset tolerance, in base units, for a SURPLUS only.
	 *
	 * Asymmetric on purpose. A surplus within tolerance is a benign accounting
	 * lag; a shortfall of ANY size means customer funds are missing, and a
	 * "tolerance" for that is just a configurable amount of unnoticed loss.
	 * There is deliberately no option to soften a shortfall or an internal
	 * break.
	 */
	readonly surplusTolerance?: Readonly<Record<string, bigint>>;
}

/**
 * Reconcile the ledger against a custodian.
 *
 * Reads the books FIRST, then the custodian — not the other way around. If a
 * deposit is credited between the two reads, the books are the older number and
 * the result is a surplus, which is the harmless classification. Reading the
 * custodian first would turn the same race into a spurious shortfall and halt
 * withdrawals for no reason.
 */
export async function reconcile(
	ledger: Ledger,
	source: HoldingsSource,
	assets: readonly string[],
	opts: ReconcileOptions = {},
): Promise<Report> {
	const reports: AssetReport[] = [];

	for (const asset of assets) {
		const balances = ledger.balances(asset);

		let liabilities = 0n;
		let booksCustody = 0n;
		for (const [id, amount] of balances) {
			// account_id is "kind:owner:asset"; the kind is the first field.
			const kind = id.slice(0, id.indexOf(":")) as AccountKind;
			switch (kind) {
				case AccountKind.USER:
				case AccountKind.FEES:
				case AccountKind.INFLIGHT:
					liabilities += amount;
					break;
				case AccountKind.CUSTODY:
					booksCustody += amount;
					break;
				case AccountKind.EXTERNAL:
					// The outside world is not a liability and not a holding.
					break;
			}
		}

		const internalDelta = booksCustody - liabilities;

		let providerHoldings: bigint | undefined;
		let unavailableReason = "";
		try {
			providerHoldings = await source.holdings(asset);
		} catch (e) {
			unavailableReason = e instanceof Error ? e.message : String(e);
		}

		reports.push(
			classify({
				asset,
				sourceName: source.name,
				liabilities,
				booksCustody,
				internalDelta,
				providerHoldings,
				unavailableReason,
				tolerance: opts.surplusTolerance?.[asset] ?? 0n,
			}),
		);
	}

	return {
		checkedAt: new Date().toISOString(),
		assets: reports,
		ok: reports.every((r) => r.status === Status.OK),
		halted: reports.filter((r) => r.haltWithdrawals).map((r) => r.asset),
	};
}

function classify(a: {
	asset: string;
	sourceName: string;
	liabilities: bigint;
	booksCustody: bigint;
	internalDelta: bigint;
	providerHoldings: bigint | undefined;
	unavailableReason: string;
	tolerance: bigint;
}): AssetReport {
	const base = {
		asset: a.asset,
		source: a.sourceName,
		liabilities: a.liabilities,
		booksCustody: a.booksCustody,
		providerHoldings: a.providerHoldings,
		internalDelta: a.internalDelta,
	};

	// INTERNAL FIRST. If our own rows do not add up we cannot trust either
	// number, so comparing them to the custodian would be reasoning from a
	// broken premise. Halt: a venue that cannot state what it owes must not
	// pay anything out.
	if (a.internalDelta !== 0n) {
		return {
			...base,
			externalDelta:
				a.providerHoldings === undefined
					? undefined
					: a.providerHoldings - a.booksCustody,
			status: Status.INTERNAL_BREAK,
			detail:
				`${a.asset}: the books do not add up — custody account holds ` +
				`${a.booksCustody} but liabilities total ${a.liabilities} ` +
				`(off by ${a.internalDelta}). This is a bug in how some flow ` +
				`posts its entries, not a custody discrepancy. Withdrawals halted.`,
			haltWithdrawals: true,
		};
	}

	if (a.providerHoldings === undefined) {
		// NOT a break. We do not know, and pretending otherwise in either
		// direction would be wrong: claiming OK hides a real shortfall, and
		// halting on every transient API error makes the venue unusable.
		// Withdrawals continue; the alert is the deliverable.
		return {
			...base,
			externalDelta: undefined,
			status: Status.UNAVAILABLE,
			detail:
				`${a.asset}: could not read holdings from ${a.sourceName} ` +
				`(${a.unavailableReason}). The books are internally consistent ` +
				`at ${a.liabilities}, but they are UNVERIFIED against custody. ` +
				`Investigate if this persists.`,
			haltWithdrawals: false,
		};
	}

	const externalDelta = a.providerHoldings - a.booksCustody;

	if (externalDelta === 0n) {
		return {
			...base,
			externalDelta,
			status: Status.OK,
			detail:
				`${a.asset}: ${a.liabilities} owed, ${a.providerHoldings} held — ` +
				`books and custody agree exactly.`,
			haltWithdrawals: false,
		};
	}

	if (externalDelta < 0n) {
		// SHORTFALL. No tolerance, by design — see ReconcileOptions.
		return {
			...base,
			externalDelta,
			status: Status.SHORTFALL,
			detail:
				`${a.asset}: SHORTFALL of ${-externalDelta} base units — the books ` +
				`say ${a.booksCustody} is held but ${a.sourceName} reports ` +
				`${a.providerHoldings}. Customer funds are missing or an expense ` +
				`(commonly a network fee) was never journaled. WITHDRAWALS HALTED: ` +
				`paying out while short spends other customers' assets.`,
			haltWithdrawals: true,
		};
	}

	if (externalDelta <= a.tolerance) {
		return {
			...base,
			externalDelta,
			status: Status.OK,
			detail:
				`${a.asset}: ${externalDelta} base units held above the books, ` +
				`within the ${a.tolerance} tolerance — treated as an accounting lag.`,
			haltWithdrawals: false,
		};
	}

	return {
		...base,
		externalDelta,
		status: Status.SURPLUS,
		detail:
			`${a.asset}: SURPLUS of ${externalDelta} base units — ${a.sourceName} ` +
			`reports ${a.providerHoldings} but the books only account for ` +
			`${a.booksCustody}. Most likely a deposit that was never credited, ` +
			`meaning a customer is waiting on money we already hold. Withdrawals ` +
			`continue: halting them would penalise everyone else for one lag.`,
		haltWithdrawals: false,
	};
}

/** One-line-per-asset rendering, for logs and the operator console. */
export function formatReport(r: Report): string {
	const head = `reconciliation ${r.ok ? "OK" : "ATTENTION"} at ${r.checkedAt}`;
	const lines = r.assets.map((a) => `  [${a.status.toUpperCase()}] ${a.detail}`);
	const tail =
		r.halted.length > 0
			? [`  WITHDRAWALS HALTED: ${r.halted.join(", ")}`]
			: [];
	return [head, ...lines, ...tail].join("\n");
}
