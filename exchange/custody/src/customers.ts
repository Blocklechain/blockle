// -----------------------------------------------------------------------------
// THE CUSTOMER DIRECTORY — who is on this venue, and what is theirs.
//
// WHY AN OPERATOR NEEDS THIS AND WHY IT IS CAREFUL.
//
// Someone writes in: "my deposit never arrived". Today answering that means
// three SQL queries against a production database by hand, at the exact moment
// the person asking is least patient. That is how mistakes get made, so it
// becomes a screen.
//
// But a customer directory is also the single most sensitive read in the
// system — every balance, every address, every withdrawal, for everyone. So:
//
//  * IT IS READ-ONLY. There is no operation here that changes a customer's
//    state. Freezing, crediting and reversing are deliberately absent: each
//    one deserves its own audited, TOTP-gated endpoint, and bundling them
//    into a browsing screen is how a mis-click becomes a loss.
//  * IT IS DERIVED, NEVER STORED. There is no customer table to drift out of
//    sync with the ledger. Everything is computed from postings, deposit
//    addresses and withdrawal rows at read time, so the directory cannot
//    disagree with the books — it IS the books, grouped by account.
//  * IDENTITY STAYS WITH THE ACCOUNTS SERVICE. This knows account IDS; it
//    does not hold names, emails or passwords, and does not fetch them. An
//    operator who needs the email looks it up where accounts live, which
//    keeps one copy of that data rather than two.
//
// The lookup accepts whatever an operator has to hand — an account id, a
// deposit address, a withdrawal id, a transaction id — because in a support
// conversation you rarely have the one key the schema happens to use.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { settlementAsset } from "./assets";
import type { Ledger } from "./ledger";

export interface CustomerSummary {
	readonly accountId: string;
	/** Settlement-asset balances with anything in them. */
	readonly balances: ReadonlyArray<{ asset: string; amount: string }>;
	readonly depositAddresses: number;
	readonly withdrawals: { readonly total: number; readonly pending: number };
	/** Most recent ledger activity, ISO, or null for an account with none. */
	readonly lastActivity: string | null;
}

export interface CustomerDetail extends CustomerSummary {
	readonly addresses: ReadonlyArray<{
		asset: string;
		network: string | null;
		address: string;
		memo: string | null;
		createdAt: string;
	}>;
	readonly recentWithdrawals: ReadonlyArray<{
		id: number;
		asset: string;
		network: string | null;
		amount: string;
		net: string;
		state: string;
		address: string;
		providerRef: string | null;
		requestedAt: string;
	}>;
	readonly recentEntries: ReadonlyArray<{
		at: string;
		reason: string;
		asset: string;
		delta: string;
	}>;
}

/** What an operator typed, and what it turned out to be. */
export interface LookupResult {
	readonly query: string;
	readonly matchedBy:
		| "account"
		| "deposit-address"
		| "withdrawal-id"
		| "withdrawal-address"
		| "provider-ref"
		| null;
	readonly accountId: string | null;
	readonly detail: CustomerDetail | null;
}

interface BalRow {
	owner: string;
	asset: string;
	delta: string;
}

export class Customers {
	constructor(
		private readonly db: Database,
		private readonly ledger: Ledger,
	) {}

	/**
	 * Everyone with a balance, an address or a withdrawal.
	 *
	 * UNION of three sources rather than one table: an account that deposited
	 * and withdrew everything has a zero balance but is still a customer, and
	 * one that has only ever been issued an address is still someone an
	 * operator may be asked about.
	 */
	list(args: { limit?: number; offset?: number } = {}): {
		customers: readonly CustomerSummary[];
		total: number;
	} {
		const limit = clamp(args.limit ?? 50, 1, 500);
		const offset = Math.max(0, args.offset ?? 0);

		const ids = this.db
			.prepare(
				`SELECT owner AS id FROM ledger_posting WHERE kind = 'user' AND owner <> ''
				 UNION
				 SELECT user_id FROM deposit_address
				 UNION
				 SELECT user_id FROM withdrawal
				 ORDER BY id`,
			)
			.all() as Array<{ id: string }>;

		const page = ids.slice(offset, offset + limit);
		return {
			total: ids.length,
			customers: page.map((r) => this.summary(r.id)),
		};
	}

	/** One account, at a glance. */
	summary(accountId: string): CustomerSummary {
		const balances = this.balancesOf(accountId);
		const addresses = (
			this.db
				.prepare(`SELECT COUNT(*) AS n FROM deposit_address WHERE user_id = ?`)
				.get(accountId) as { n: number }
		).n;
		const wd = this.db
			.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN state IN ('requested','screening','approved','submitted')
				                 THEN 1 ELSE 0 END) AS pending
				 FROM withdrawal WHERE user_id = ?`,
			)
			.get(accountId) as { total: number; pending: number | null };
		// The timestamp lives on the transaction, not the posting, so this
		// joins rather than reading a column that does not exist.
		const last = this.db
			.prepare(
				`SELECT MAX(t.created_at) AS at
				 FROM ledger_posting p JOIN ledger_tx t ON t.id = p.tx_id
				 WHERE p.kind = 'user' AND p.owner = ?`,
			)
			.get(accountId) as { at: string | null };

		return {
			accountId,
			balances,
			depositAddresses: addresses,
			withdrawals: { total: wd.total, pending: wd.pending ?? 0 },
			lastActivity: last.at,
		};
	}

	/** One account, in full — the support screen. */
	detail(accountId: string): CustomerDetail {
		const addresses = (
			this.db
				.prepare(
					`SELECT asset, network, address, memo, created_at
					 FROM deposit_address WHERE user_id = ? ORDER BY created_at DESC`,
				)
				.all(accountId) as Array<{
				asset: string;
				network: string | null;
				address: string;
				memo: string | null;
				created_at: string;
			}>
		).map((r) => ({
			asset: r.asset,
			network: r.network,
			address: r.address,
			memo: r.memo,
			createdAt: r.created_at,
		}));

		const recentWithdrawals = (
			this.db
				.prepare(
					`SELECT id, asset, network, amount, net, state, address,
					        provider_ref, created_at
					 FROM withdrawal WHERE user_id = ?
					 ORDER BY id DESC LIMIT 25`,
				)
				.all(accountId) as Array<Record<string, unknown>>
		).map((r) => ({
			id: Number(r.id),
			asset: String(r.asset),
			network: (r.network as string | null) ?? null,
			amount: String(r.amount),
			net: String(r.net),
			state: String(r.state),
			address: String(r.address),
			providerRef: (r.provider_ref as string | null) ?? null,
			requestedAt: String(r.created_at),
		}));

		const recentEntries = (
			this.db
				.prepare(
					`SELECT t.created_at AS at, t.reason AS reason, p.asset AS asset,
					        p.delta AS delta
					 FROM ledger_posting p JOIN ledger_tx t ON t.id = p.tx_id
					 WHERE p.kind = 'user' AND p.owner = ?
					 ORDER BY p.id DESC LIMIT 40`,
				)
				.all(accountId) as Array<Record<string, unknown>>
		).map((r) => ({
			at: String(r.at),
			reason: String(r.reason),
			asset: String(r.asset),
			delta: String(r.delta),
		}));

		return { ...this.summary(accountId), addresses, recentWithdrawals, recentEntries };
	}

	/**
	 * Find an account from whatever the operator has.
	 *
	 * EXACT MATCHES ONLY, in a fixed order. No prefix or fuzzy matching: a
	 * near-miss that silently resolves to the wrong customer is worse than no
	 * answer, and every identifier here is something copied and pasted rather
	 * than typed from memory.
	 */
	lookup(query: string): LookupResult {
		const q = query.trim();
		const miss: LookupResult = { query: q, matchedBy: null, accountId: null, detail: null };
		if (q === "") return miss;

		const found = (
			matchedBy: NonNullable<LookupResult["matchedBy"]>,
			accountId: string,
		): LookupResult => ({
			query: q,
			matchedBy,
			accountId,
			detail: this.detail(accountId),
		});

		// A deposit address is the most common thing to be handed, because it
		// is what the customer can see.
		const byAddress = this.db
			.prepare(`SELECT user_id FROM deposit_address WHERE address = ?`)
			.get(q) as { user_id: string } | undefined;
		if (byAddress !== undefined) return found("deposit-address", byAddress.user_id);

		// A withdrawal id, as shown on their withdrawals screen.
		if (/^\d+$/.test(q)) {
			const byId = this.db
				.prepare(`SELECT user_id FROM withdrawal WHERE id = ?`)
				.get(Number(q)) as { user_id: string } | undefined;
			if (byId !== undefined) return found("withdrawal-id", byId.user_id);
		}

		// A destination address or a chain txid, from someone asking where
		// their payout went.
		const byDest = this.db
			.prepare(`SELECT user_id FROM withdrawal WHERE address = ? ORDER BY id DESC LIMIT 1`)
			.get(q) as { user_id: string } | undefined;
		if (byDest !== undefined) return found("withdrawal-address", byDest.user_id);

		const byRef = this.db
			.prepare(
				`SELECT user_id FROM withdrawal WHERE provider_ref = ? ORDER BY id DESC LIMIT 1`,
			)
			.get(q) as { user_id: string } | undefined;
		if (byRef !== undefined) return found("provider-ref", byRef.user_id);

		// An account id last: it is the least likely thing a customer quotes,
		// and checking it first would shadow the others for numeric-looking
		// ids.
		const known = this.db
			.prepare(
				`SELECT 1 AS hit FROM ledger_posting
				 WHERE kind = 'user' AND owner = ? LIMIT 1`,
			)
			.get(q) as { hit: number } | undefined;
		const hasAddr = this.db
			.prepare(`SELECT 1 AS hit FROM deposit_address WHERE user_id = ? LIMIT 1`)
			.get(q) as { hit: number } | undefined;
		const hasWd = this.db
			.prepare(`SELECT 1 AS hit FROM withdrawal WHERE user_id = ? LIMIT 1`)
			.get(q) as { hit: number } | undefined;
		if (known !== undefined || hasAddr !== undefined || hasWd !== undefined) {
			return found("account", q);
		}

		return miss;
	}

	/**
	 * Balances by settlement asset, skipping zeros.
	 *
	 * Grouped the way the ledger's invariant is stated — `USDT.TRC20` and
	 * `USDT.ERC20` are one USDT balance to the customer — so this screen
	 * cannot disagree with what they see on theirs.
	 */
	private balancesOf(accountId: string): Array<{ asset: string; amount: string }> {
		const rows = this.db
			.prepare(
				`SELECT owner, asset, delta FROM ledger_posting
				 WHERE kind = 'user' AND owner = ?`,
			)
			.all(accountId) as BalRow[];
		/*
		 * SUMMED IN BIGINT, NOT IN SQL.
		 *
		 * `delta` is TEXT precisely because an 18-decimal amount overflows
		 * SQLite's 64-bit INTEGER — so `SUM(delta)` would coerce to a float
		 * and quietly round the customer's balance. Same reason the ledger
		 * stores it as TEXT in the first place.
		 */
		const byAsset = new Map<string, bigint>();
		for (const r of rows) {
			const key = settlementAsset(r.asset);
			byAsset.set(key, (byAsset.get(key) ?? 0n) + BigInt(String(r.delta)));
		}
		return [...byAsset.entries()]
			.filter(([, v]) => v !== 0n)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([asset, v]) => ({ asset, amount: v.toString() }));
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
