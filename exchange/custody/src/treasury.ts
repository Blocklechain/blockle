// -----------------------------------------------------------------------------
// THE TREASURY VIEW — one screen that answers "is the venue solvent?"
//
// WHAT THIS IS FOR. Everything else in the operator console answers a business
// question: how much have we made, can we pay gas, is a chain losing money.
// None of them can answer the only question whose wrong answer ends the
// company, which is whether the money we say we are holding is the money we
// are holding. That is what this module computes, per asset, and it puts the
// one number that can say "no" in front of everything else.
//
// THE NUMBER THAT MATTERS IS A DIFFERENCE, NOT A BALANCE.
//
//   custody     what the books say the venue holds with its custodians
//   owed        what the books say the venue owes: customers + its own accrued
//               fees + withdrawals already debited but not yet on chain
//   solvency    custody - owed
//
// `solvency` must be EXACTLY zero. Not "close to zero": it is arithmetic over
// our own rows, every one of which was written by this codebase, so a non-zero
// value is a bug in how some flow posts its entries and there is no tolerance
// to grant it. A venue that cannot state what it owes must not pay anything
// out, which is why reconcile.ts halts withdrawals on it.
//
// IT IS THE RECONCILER'S OWN NUMBER, NOT A SECOND OPINION.
//
// This module does not compute custody-minus-books itself. It calls
// `reconcile()` — the same function the every-two-minutes job calls, over the
// same `Ledger.liabilities()` and `Ledger.custodyByNetwork()` — and reports
// what that returns. A parallel query would have been shorter and would have
// been wrong: two derivations of solvency that can disagree leave an operator
// with no way to decide which to believe, and the practical result is that
// they stop believing either. If the panel and the reconciler ever disagree,
// the panel is the thing that is broken, so the panel does not get its own
// arithmetic.
//
// WHAT IT DELIBERATELY DOES NOT DO: CALL A CUSTODIAN.
//
// `reconcile()` takes a HoldingsSource and compares two halves — INTERNAL
// (books against books) and EXTERNAL (books against the custodian). Only the
// internal half is computed here, by handing it a source that refuses. Three
// reasons, in order of weight:
//
//   1. BitGo is IP-restricted, rate-limited and slow, and its failure mode is
//      `UNAVAILABLE` on every asset. An operator console that calls it on
//      every page load turns a diagnostic screen into a dependency on the
//      thing being diagnosed, and it would be at its least reliable during
//      precisely the incident someone opened the page for.
//   2. The external half is already being computed every two minutes by a job
//      that runs under a read-only database handle and a systemd unit that
//      cannot write anything but the halt file. Duplicating it in a web
//      request means a second answer with a different timestamp.
//   3. Rendering a screen must never be able to move money or provision an
//      address. A previous agent POSTed a receive address onto the live LTC
//      wallet; a read path that holds no custodian client cannot repeat it.
//
// So the external half is SURFACED, not recomputed: the halt file the
// reconcile job writes carries the reconciler's own verdict and its own words,
// and the file's modification time is the only liveness proof that job emits.
// This module reports both, including how stale they are, rather than
// rendering a green tick that means "we did not look".
//
// TWO THINGS AN OPERATOR WILL OTHERWISE CONCLUDE WRONGLY, SAID OUT LOUD HERE
// AND IN THE PAYLOAD:
//
//   * AN EMPTY HALT SET IS NOT A CLEAN BILL OF HEALTH. The reconcile job
//     filters its asset list down to assets with non-zero custody or non-zero
//     liabilities, because reporting 0 == 0 for twenty unlisted assets buries
//     the two that matter. On a flat ledger that filter selects NOTHING, the
//     job logs "reconciliation OK" with no per-asset lines, and writes `{}`.
//     That is a vacuously green pass: evidence that there was nothing to be
//     solvent about, not evidence of solvency. The payload therefore carries
//     `externallyVerified` per asset, which is false whenever the reconciler
//     cannot be shown to have looked at it.
//
//   * ZERO IS NOT THE SAME AS MISSING. Every asset in the registry gets a row
//     even when every figure on it is zero, and the job's non-zero filter is
//     deliberately NOT inherited. An operator needs to see that a rail is
//     empty; a rail that is absent from the table reads as a rail that was
//     forgotten, and on the most sensitive screen in the product those must
//     not look alike.
//
// AND THE HARD PRODUCT RULE: NO FIAT FIGURE, EVER, FOR ANY ASSET ON THIS
// SCREEN. Not a USD total, not a converted subtotal, not a "≈ $" hint. BLOCK
// and BLOCK-20 tokens must never be shown a dollar price, including by
// conversion, and the existing `/admin/api/revenue` route already launders one
// in by passing its report through `estimateTotal(..., "USDT")` — USDT is a
// dollar stablecoin, so BLOCK fee revenue priced off the live BLOCK-USDT book
// becomes a dollar figure for BLOCK. Nothing in this module imports a rate
// source at all, which is the only version of that rule that cannot rot: a
// future edit cannot accidentally add a currency column to a payload that has
// no currency in it.
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from "node:fs";

import { format } from "./amount";
import { ASSETS, assetDef, networkOf, settlementAsset } from "./assets";
import type { LiabilityBreakdown, Ledger } from "./ledger";
import { Status, reconcile, type HoldingsSource } from "./reconcile";

/**
 * Where the treasury view gets reservations from.
 *
 * Narrow on purpose: this is the whole of what the view needs from the trading
 * engine, and a one-method interface is one a test double can satisfy
 * honestly. In the service it is `Venue.reservationsByAsset` — the same
 * derivation `placeOrder` and the withdrawal path enforce against, so the
 * console cannot tell an operator an account has funds available that the
 * withdrawal endpoint will refuse.
 */
export interface ReservationSource {
	/** asset -> accountId -> base units committed to resting orders. */
	reservationsByAsset(): {
		byAsset: Map<string, Map<string, bigint>>;
		/** Open orders on an unlisted market, whose claim could not be priced. */
		skipped: number;
	};
}

/**
 * What the reconcile job last left behind, read fresh on every request.
 *
 * The halt file is the job's ONLY output: it is rewritten on every completed
 * pass, empty set included, under a systemd unit whose ReadWritePaths grant
 * covers /run/blockle alone. So its contents are the verdict and its mtime is
 * the liveness, and there is nothing else to read — see the long comment in
 * reconcilejob.ts about two failed attempts to make that job write a heartbeat
 * row to the ledger it is judging.
 */
export interface ReconcilerState {
	/** asset -> the reconciler's own words about why it halted that asset. */
	readonly halted: Readonly<Record<string, string>>;
	/** The halt file's mtime: when a pass last COMPLETED. */
	readonly lastPassAt: string | undefined;
	/** Why we cannot say, when we cannot. */
	readonly unavailableReason: string | undefined;
}

/**
 * Read the halt file.
 *
 * AN UNREADABLE FILE IS REPORTED, NOT TREATED AS "NOTHING HALTED".
 *
 * `haltsFrom()` in publicapi.ts falls back to NOTHING_HALTED on any error, and
 * for the withdrawal path that is the correct bias — a missing halt file must
 * not stop a healthy venue trading. On THIS screen the same fallback would be
 * a lie of a worse kind: it would render "no assets halted, last pass
 * unknown" identically to "no assets halted, pass completed ninety seconds
 * ago". The absence of a check and the passing of a check have to look
 * different here, so the reason travels with the answer.
 */
export function reconcilerStateFrom(path?: string): ReconcilerState {
	const p = path ?? process.env.HALT_FILE ?? "/run/blockle/exchange-halts.json";
	try {
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				halted: {},
				lastPassAt: undefined,
				unavailableReason: `${p} is not a JSON object of asset -> reason`,
			};
		}
		const halted: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "string") halted[k] = v;
		}
		return {
			halted,
			lastPassAt: statSync(p).mtime.toISOString(),
			unavailableReason: undefined,
		};
	} catch (e) {
		return {
			halted: {},
			lastPassAt: undefined,
			unavailableReason: e instanceof Error ? e.message : String(e),
		};
	}
}

/**
 * The HoldingsSource handed to `reconcile()` from here: it always refuses.
 *
 * This is not a stub standing in for work left undone — it is the mechanism by
 * which this module runs the INTERNAL half of reconciliation and provably not
 * the external half. `reconcile()` classifies an unreadable custodian as
 * UNAVAILABLE and explicitly does NOT halt on it, after having already checked
 * the internal arithmetic first, so handing it a refusing source yields
 * exactly the half that costs nothing and is exact.
 *
 * The message is written for the operator who will eventually see it in a log
 * or a payload, because "undefined" or "not implemented" there would read as a
 * fault.
 */
const BOOKS_ONLY: HoldingsSource = {
	name: "books-only",
	holdings(): Promise<bigint> {
		return Promise.reject(
			new Error(
				"the treasury view does not read custodians; external verification " +
					"comes from the reconcile job's last pass",
			),
		);
	},
};

export interface TreasuryNetworkRow {
	readonly network: string;
	readonly held: string;
	readonly heldBase: string;
}

export interface TreasuryAssetRow {
	readonly asset: string;
	readonly decimals: number;

	// ---- exact base units, as decimal strings ------------------------------
	// STRINGS, NOT NUMBERS, ALL THE WAY TO THE BROWSER. A balance past ~9e15
	// base units does not survive a JavaScript double, and `JSON.parse` on the
	// other end would round it before any code of ours touched it. The console
	// renders these verbatim and does no parseFloat anywhere.
	readonly custodyBase: string;
	readonly owedToCustomersBase: string;
	readonly feesBase: string;
	readonly inflightBase: string;
	readonly liabilitiesBase: string;
	readonly reservedBase: string;
	/** custody - liabilities. MUST be "0". This is the solvency figure. */
	readonly solvencyBase: string;

	// ---- the same figures scaled for a human, in the asset's OWN units -----
	readonly custody: string;
	readonly owedToCustomers: string;
	readonly fees: string;
	readonly inflight: string;
	readonly liabilities: string;
	readonly reserved: string;
	readonly solvency: string;

	readonly perNetwork: readonly TreasuryNetworkRow[];

	/** True when custody - liabilities is exactly zero, i.e. the books add up. */
	readonly balanced: boolean;
	/** The reconciler's status for the internal half. */
	readonly status: Status;
	/** The reconciler's own words, when it has something to say. */
	readonly detail: string;

	/** The reconcile job has this asset's withdrawals halted. */
	readonly halted: boolean;
	readonly haltReason: string;
	/**
	 * Whether the last reconcile pass can be shown to have CHECKED this asset
	 * against a custodian.
	 *
	 * False does NOT mean a problem was found; it means no answer exists. See
	 * the header: the job skips assets with nothing in them, and the halt file
	 * only names assets it halted, so "absent from the halt file" conflates
	 * "checked and fine" with "never looked at". Rather than guess, this is
	 * true only for an asset the pass demonstrably touched — one it halted —
	 * and otherwise false with `externalNote` saying why.
	 */
	readonly externallyVerified: boolean;
	readonly externalNote: string;

	/** Accounts with a non-zero balance in this asset. */
	readonly holders: number;
	/**
	 * Accounts whose reserved exceeds their balance.
	 *
	 * Non-zero is a finding, not a cosmetic issue. The customer-facing path
	 * clamps `available` at zero (see Venue.balances) because rendering a
	 * negative number to a customer is alarming without being actionable; for
	 * an operator the clamp is the thing that hides a legacy overcommitted
	 * order, so the count is surfaced here instead.
	 */
	readonly overcommitted: number;
}

export interface TreasuryReport {
	readonly generatedAt: string;
	readonly assets: readonly TreasuryAssetRow[];

	// ---- the headline, pre-computed so the page cannot get it wrong --------
	/** True only when every asset's custody minus books is exactly zero. */
	readonly booksBalance: boolean;
	/** Assets whose books do not add up. */
	readonly unbalanced: readonly string[];
	/** Assets the reconciler has halted. */
	readonly halted: readonly string[];

	/** When a reconcile pass last completed, from the halt file's mtime. */
	readonly lastPassAt: string | undefined;
	/** Why the reconciler's state could not be read, when it could not. */
	readonly reconcilerUnavailable: string | undefined;

	/**
	 * Open orders on an unlisted market. Non-zero means `reserved` is
	 * UNDERSTATED venue-wide by whatever those orders hold.
	 */
	readonly unpricedOpenOrders: number;

	/**
	 * Stated in the payload, not just in a comment, so it travels with the
	 * numbers into whatever renders them.
	 */
	readonly caveats: readonly string[];
}

/** A `format()` call that is honest about an unknown asset. */
function show(base: bigint, symbol: string, decimals: number): string {
	return format(base, { symbol, decimals });
}

/**
 * Build the per-asset treasury report.
 *
 * Async only because `reconcile()` is: the refusing holdings source settles
 * immediately and nothing here touches a network.
 */
export async function treasury(args: {
	ledger: Ledger;
	reservations: ReservationSource;
	reconciler: ReconcilerState;
	/** Overridable for tests; defaults to the whole registry. */
	assets?: readonly string[];
}): Promise<TreasuryReport> {
	const { ledger, reservations, reconciler } = args;
	/*
	 * EVERY REGISTRY ASSET, AND THE RECONCILE JOB'S FILTER IS NOT INHERITED.
	 *
	 * reconcilejob.ts narrows to assets with a non-zero position, for a good
	 * reason of its own (twenty 0 == 0 lines bury the two that matter in a log
	 * someone skims). Applying it here would render an EMPTY TABLE on a live
	 * venue whose ledger happens to be flat — which is the current state of
	 * this deployment — and an empty table on the solvency screen is the worst
	 * possible way to say "nothing is wrong".
	 */
	const assets = args.assets ?? Object.keys(ASSETS);

	// ONE query for the whole venue's reservations, not one per account. See
	// Venue.reservationsByAsset on why it shares its arithmetic with the
	// per-account `reserved()` the withdrawal path enforces.
	const res = reservations.reservationsByAsset();

	// reconcile() over a source that refuses: the internal half, exactly, from
	// the same code the every-two-minutes job runs. Not re-derived here.
	const report = await reconcile(ledger, BOOKS_ONLY, assets);
	const byAsset = new Map(report.assets.map((a) => [a.asset, a]));

	const rows: TreasuryAssetRow[] = [];
	const caveats: string[] = [];

	for (const asset of assets) {
		const def = ASSETS[asset];
		const decimals = def?.decimals ?? assetDef(asset).decimals;
		const r = byAsset.get(asset);
		if (r === undefined) {
			// reconcile() returns one row per requested asset, so this is
			// unreachable — which is why it throws rather than filling in
			// zeros. A silently-zeroed row on this screen would read as a
			// solvent rail.
			throw new Error(
				`reconcile() returned no row for ${asset}; refusing to render a ` +
					"treasury figure that did not come from the reconciler",
			);
		}

		const parts: LiabilityBreakdown = ledger.liabilityBreakdown(asset);
		/*
		 * OWED-TO-CUSTOMERS IS A SUBTRACTION, NOT AN INDEPENDENT SUM.
		 *
		 * `liabilities` is the figure reconciliation compares against custody,
		 * and it is a lump of user + fees + inflight. Splitting it by
		 * subtracting the two venue-level parts keeps the three displayed
		 * components adding up to the reconciled total BY CONSTRUCTION. Had
		 * this summed USER postings separately it would be a fourth derivation
		 * of the same rows, and a posting bug would then show up as two
		 * plausible totals on one screen instead of one number that is visibly
		 * wrong in one place.
		 *
		 * `liabilityBreakdown()` is itself what `liabilities()` delegates to,
		 * so `parts.total === r.liabilities` is an identity rather than a
		 * coincidence — but it is asserted below anyway, because an identity
		 * that nobody checks is an assumption.
		 */
		const owed = parts.total - parts.fees - parts.inflight;
		if (parts.total !== r.liabilities) {
			// Only reachable if the ledger changed between the two reads (WAL
			// lets a writer commit mid-request). Reported rather than hidden:
			// the figures on this row are then from two instants and an
			// operator should refresh before quoting them.
			caveats.push(
				`${asset}: the ledger changed while this page was being built, so ` +
					"its parts and its total are from different instants. Refresh " +
					"before quoting these figures.",
			);
		}

		const inv = ledger.custodyByNetwork(asset);
		let perNetworkTotal = 0n;
		for (const v of inv.values()) perNetworkTotal += v;
		if (perNetworkTotal !== r.booksCustody) {
			caveats.push(
				`${asset}: the custody total and its per-network breakdown were read ` +
					"at different instants and do not agree. The total shown is the " +
					"reconciler's; refresh before quoting the breakdown.",
			);
		}

		const perAccount = res.byAsset.get(asset) ?? new Map<string, bigint>();
		let reserved = 0n;
		for (const v of perAccount.values()) reserved += v;

		const balances = ledger.userBalances(asset);
		let holders = 0;
		let overcommitted = 0;
		for (const [, v] of balances) if (v !== 0n) holders++;
		for (const [owner, claim] of perAccount) {
			if (claim > (balances.get(owner) ?? 0n)) overcommitted++;
		}

		const haltReason = reconciler.halted[asset] ?? "";
		const halted = haltReason !== "";
		const externallyVerified = halted;
		const externalNote = halted
			? "The reconcile job halted this asset; the reason is its own words " +
				"from the last pass."
			: reconciler.unavailableReason !== undefined
				? `The reconciler's state could not be read (${reconciler.unavailableReason}), ` +
					"so nothing here has been checked against a custodian."
				: "Not named in the halt set. That is NOT the same as verified: the " +
					"reconcile job skips assets with nothing in them, and the halt " +
					"file lists only what it halted, so this row's custody has not " +
					"been shown to have been compared against a custodian.";

		rows.push({
			asset,
			decimals,
			custodyBase: r.booksCustody.toString(),
			owedToCustomersBase: owed.toString(),
			feesBase: parts.fees.toString(),
			inflightBase: parts.inflight.toString(),
			liabilitiesBase: r.liabilities.toString(),
			reservedBase: reserved.toString(),
			solvencyBase: r.internalDelta.toString(),
			custody: show(r.booksCustody, asset, decimals),
			owedToCustomers: show(owed, asset, decimals),
			fees: show(parts.fees, asset, decimals),
			inflight: show(parts.inflight, asset, decimals),
			liabilities: show(r.liabilities, asset, decimals),
			reserved: show(reserved, asset, decimals),
			solvency: show(r.internalDelta, asset, decimals),
			perNetwork: [...inv.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, held]) => ({
					network: networkOf(id) ?? settlementAsset(id),
					held: show(held, asset, decimals),
					heldBase: held.toString(),
				})),
			balanced: r.internalDelta === 0n,
			status: r.status,
			// For the UNAVAILABLE case reconcile's own detail talks about not
			// having reached a custodian named "books-only", which is true but
			// reads as a fault on a screen that never intended to reach one.
			// The INTERNAL_BREAK detail is the one worth passing through
			// verbatim, because it is the finding.
			detail:
				r.status === Status.INTERNAL_BREAK
					? r.detail
					: `${asset}: the books add up — custody ${r.booksCustody} equals ` +
						`liabilities ${r.liabilities} exactly.`,
			halted,
			haltReason,
			externallyVerified,
			externalNote,
			holders,
			overcommitted,
		});
	}

	if (res.skipped > 0) {
		caveats.push(
			`${res.skipped} open order(s) rest on a market that is no longer listed. ` +
				"Their claim cannot be priced, so RESERVED is understated by whatever " +
				"they hold — and the customer-facing available balance is overstated " +
				"by the same amount.",
		);
	}
	if (reconciler.unavailableReason !== undefined) {
		caveats.push(
			`The reconciler's halt file could not be read (${reconciler.unavailableReason}). ` +
				"No asset on this page has been compared against a custodian, and an " +
				"empty halt set here means 'unknown', not 'clear'.",
		);
	} else if (reconciler.lastPassAt === undefined) {
		caveats.push(
			"The reconciler's last-pass time is unknown, so the halt set below " +
				"cannot be dated.",
		);
	}
	caveats.push(
		"Custody figures are what the BOOKS say is held. This page does not read " +
			"a custodian — external verification is the reconcile job's, dated above.",
	);

	return {
		generatedAt: new Date().toISOString(),
		assets: rows,
		booksBalance: rows.every((a) => a.balanced),
		unbalanced: rows.filter((a) => !a.balanced).map((a) => a.asset),
		halted: rows.filter((a) => a.halted).map((a) => a.asset),
		lastPassAt: reconciler.lastPassAt,
		reconcilerUnavailable: reconciler.unavailableReason,
		unpricedOpenOrders: res.skipped,
		caveats,
	};
}

export interface TreasuryHolderRow {
	readonly accountId: string;
	readonly balanceBase: string;
	readonly reservedBase: string;
	readonly availableBase: string;
	readonly balance: string;
	readonly reserved: string;
	readonly available: string;
	/** reserved > balance: a legacy overcommitted order. A finding. */
	readonly overcommitted: boolean;
}

export interface TreasuryDrilldown {
	readonly asset: string;
	readonly decimals: number;
	readonly generatedAt: string;
	readonly holders: readonly TreasuryHolderRow[];
	readonly total: number;
	readonly limit: number;
	readonly offset: number;
	/**
	 * The sum of EVERY holder's balance — the whole set, not this page.
	 *
	 * Shown next to the asset row's `owedToCustomers` so an operator can check
	 * the one thing a drill-down is for: that the names below add up to the
	 * total above. They are derived from the same postings through different
	 * groupings, so a mismatch is a real finding and not a rounding artefact.
	 */
	readonly sumOfHoldersBase: string;
	readonly sumOfHolders: string;
	readonly owedToCustomersBase: string;
	readonly owedToCustomers: string;
	readonly agrees: boolean;
	readonly overcommitted: number;
}

/**
 * Every account's position in ONE asset: balance, reserved, available.
 *
 * THE MOST SENSITIVE READ IN THE PRODUCT. It is every customer's balance in
 * one response, so: it is reachable only through the operator allowlist, it is
 * never mounted under /public or /v1, and NOTHING here logs. Not the asset,
 * not a count, and above all not an account id — an identifier that reaches a
 * log line has left the access-controlled surface for one with different
 * retention and different readers. There are existing log lines in this
 * service that print a raw account id (publicapi.ts does it on the
 * deposit-address routes); that is a wrong this module does not extend.
 *
 * ZERO BALANCES ARE INCLUDED. A customer at zero who still has funds reserved
 * against resting orders is an overcommitted account, and filtering zeroes —
 * which `Ledger.balances()` does, and which is right for a customer's own
 * screen — is exactly how that stays invisible to the only person who could
 * act on it.
 */
export function treasuryHolders(args: {
	ledger: Ledger;
	reservations: ReservationSource;
	asset: string;
	limit?: number;
	offset?: number;
}): TreasuryDrilldown {
	const symbol = settlementAsset(args.asset.toUpperCase());
	const def = ASSETS[symbol];
	if (def === undefined) {
		// The asset, never a customer identifier. This string reaches an HTTP
		// body and may reach a log; the caller's input is the only thing in it.
		throw new Error(`unknown asset ${symbol}`);
	}
	const decimals = def.decimals;

	/*
	 * PAGED, AND THE CAP IS ENFORCED HERE RATHER THAN TRUSTED FROM THE QUERY
	 * STRING.
	 *
	 * `GET /admin/api/customers` accepts `?limit=` guarded by `Number.isFinite`
	 * alone, so one request can dump the entire customer directory. That is
	 * behind the same allowlist, so it is not a breach — but an unbounded page
	 * size on the screen that shows every balance is an unnecessary way for one
	 * mis-typed URL to become one enormous response, and this is the newer of
	 * the two endpoints, so it does not copy the older one's mistake. 500
	 * matches the ceiling Customers.list already uses.
	 */
	const limit = clamp(args.limit ?? 100, 1, 500);
	const offset = Math.max(0, Math.trunc(args.offset ?? 0));

	const balances = args.ledger.userBalances(symbol);
	const perAccount =
		args.reservations.reservationsByAsset().byAsset.get(symbol) ??
		new Map<string, bigint>();

	// THE UNION OF BOTH SOURCES. An account with open orders but no posting in
	// this asset cannot happen today, but if it ever did it would be the single
	// most interesting row on the page, so it is not quietly dropped.
	const ids = new Set<string>([...balances.keys(), ...perAccount.keys()]);

	let sum = 0n;
	let overcommitted = 0;
	const all: TreasuryHolderRow[] = [];
	for (const accountId of ids) {
		const balance = balances.get(accountId) ?? 0n;
		const reserved = perAccount.get(accountId) ?? 0n;
		sum += balance;
		const over = reserved > balance;
		if (over) overcommitted++;
		all.push({
			accountId,
			balanceBase: balance.toString(),
			reservedBase: reserved.toString(),
			/*
			 * NOT CLAMPED AT ZERO, UNLIKE THE CUSTOMER-FACING FIGURE.
			 *
			 * Venue.balances clamps `available` because a negative number shown
			 * to a customer is alarming without being actionable. For an
			 * operator the clamp is the bug-concealer: a negative available is
			 * precisely the signature of an account resting more than it holds,
			 * and that is a thing to investigate, not to tidy away.
			 */
			availableBase: (balance - reserved).toString(),
			balance: show(balance, symbol, decimals),
			reserved: show(reserved, symbol, decimals),
			available: show(balance - reserved, symbol, decimals),
			overcommitted: over,
		});
	}

	/*
	 * SORTED IN BIGINT, DESCENDING. `Array.sort` with a numeric comparator
	 * would need these as Numbers, and an 18-decimal balance does not survive
	 * that conversion — two different large balances can compare equal as
	 * doubles, which is the same clamping failure as SQL's CAST wearing a
	 * different hat. Comparison operators work directly on bigints.
	 *
	 * An overcommitted account sorts first regardless of size: it is the row
	 * someone opened this page to find, and burying it under a page of larger
	 * balances would make the flag useless.
	 */
	all.sort((a, b) => {
		if (a.overcommitted !== b.overcommitted) return a.overcommitted ? -1 : 1;
		const x = BigInt(a.balanceBase);
		const y = BigInt(b.balanceBase);
		if (x > y) return -1;
		if (x < y) return 1;
		return a.accountId.localeCompare(b.accountId);
	});

	// ONE breakdown, read once. Calling it per component would read the ledger
	// at three instants and could produce an "owed" that is not any total the
	// books ever held — and the whole point of the figure is to be compared
	// against the sum of the rows above it.
	const parts = args.ledger.liabilityBreakdown(symbol);
	const owed = parts.total - parts.fees - parts.inflight;

	return {
		asset: symbol,
		decimals,
		generatedAt: new Date().toISOString(),
		holders: all.slice(offset, offset + limit),
		total: all.length,
		limit,
		offset,
		sumOfHoldersBase: sum.toString(),
		sumOfHolders: show(sum, symbol, decimals),
		owedToCustomersBase: owed.toString(),
		owedToCustomers: show(owed, symbol, decimals),
		agrees: sum === owed,
		overcommitted,
	};
}

function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo;
	return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
