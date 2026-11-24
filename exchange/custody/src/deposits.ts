// -----------------------------------------------------------------------------
// DEPOSIT ADDRESSES — the one screen where making something up loses money.
//
// A deposit address is the only piece of data in this service where an
// invented, stale or wrong value means the customer's funds go somewhere
// nobody controls and cannot be recovered by anyone. Not refunded, not delayed
// — gone. So this module's whole design is "produce an address that is
// certainly right, or produce no address and say why".
//
// WHAT IT DOES NOT DO:
//
//   * It does not generate addresses. Address derivation belongs to the
//     custodian that holds the keys; a service that derived its own would be
//     deriving them from key material it does not have.
//   * It does not fall back. No "use the omnibus address", no "any chain will
//     do", no last-known-good from a cache. Each of those is a plausible way
//     to lose a deposit.
//   * It does not reuse one customer's address for another. Deposits are
//     credited by the address they arrived at, so a shared address means two
//     customers' money is indistinguishable.
//
// WHAT IT DOES: holds a registry of addresses provisioned by an operator (or
// by a provisioning job talking to BitGo), hands out the one belonging to this
// customer on this chain, and returns a clear refusal when there is not one.
//
// THE REFUSAL IS A FEATURE. "No deposit address is provisioned for USDT on
// Solana yet — use Tron, which is available" is a useful sentence. A blank box
// looks broken, and a guess is a disaster.
//
// MEMO CHAINS. Some chains (XRP most relevantly here) credit by a memo/tag on
// a shared address rather than by a unique address. Those deposits are lost if
// the tag is omitted, so the tag is stored beside the address and the API
// marks it REQUIRED rather than optional.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { assetDef, networkOf, settlementAsset } from "./assets";

export class DepositError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "DepositError";
	}
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS deposit_address (
  -- The customer this address credits. Deposits are matched by address, so an
  -- address shared between customers makes their funds indistinguishable.
  user_id   TEXT NOT NULL,
  -- Settlement asset, e.g. 'USDT'.
  asset     TEXT NOT NULL,
  -- Chain id, e.g. 'TRC20'. Empty string for a single-chain asset, rather than
  -- NULL, so the primary key is total and a lookup cannot miss.
  network   TEXT NOT NULL,
  address   TEXT NOT NULL,
  -- Memo/destination tag, where the chain credits by tag on a shared address.
  -- A deposit to such a chain WITHOUT the tag cannot be credited.
  memo      TEXT,
  -- Who or what provisioned it, for the audit trail.
  source    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, asset, network)
);

-- One address belongs to one customer. Without this, a provisioning bug could
-- hand the same address to two people and their deposits would be credited to
-- whichever row was read first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_address_unique
  ON deposit_address(asset, network, address, COALESCE(memo, ''));

-- Addresses are not edited. A changed address means deposits already in flight
-- to the old one are credited to nobody, so a correction is a new row plus a
-- deliberate retirement, not an UPDATE.
CREATE TRIGGER IF NOT EXISTS deposit_address_no_update
BEFORE UPDATE ON deposit_address
BEGIN SELECT RAISE(ABORT, 'deposit_address rows are not edited — retire and re-provision'); END;
`;

export interface DepositAddress {
	readonly asset: string;
	readonly network: string | undefined;
	readonly address: string;
	readonly memo: string | undefined;
	readonly source: string;
	readonly createdAt: string;
}

export class Deposits {
	constructor(private readonly db: Database) {
		db.exec(SCHEMA);
	}

	/**
	 * The address for this customer on this chain, or undefined.
	 *
	 * Validates the asset/network pair against the registry first, so a request
	 * for a chain an asset does not exist on is a clear error rather than a
	 * silent "not provisioned".
	 */
	addressFor(
		userId: string,
		asset: string,
		network: string | undefined,
	): DepositAddress | undefined {
		const sym = settlementAsset(asset);
		if (networkOf(asset) !== undefined) {
			throw new DepositError(
				`ask for the asset and the network separately, not "${asset}"`,
			);
		}
		const def = assetDef(sym);
		if (def.networks.length > 0) {
			if (network === undefined || network === "") {
				throw new DepositError(
					`${sym} exists on ${def.networks.length} chains — choose one: ` +
						def.networks.map((n) => n.id).join(", "),
				);
			}
			if (!def.networks.some((n) => n.id === network)) {
				throw new DepositError(
					`${sym} is not available on ${network} — choose one of: ` +
						def.networks.map((n) => n.id).join(", "),
				);
			}
		} else if (network !== undefined && network !== "") {
			throw new DepositError(`${sym} is single-chain; do not name a network`);
		}

		const row = this.db
			.prepare(
				`SELECT address, memo, source, created_at FROM deposit_address
				  WHERE user_id = ? AND asset = ? AND network = ?`,
			)
			.get(userId, sym, network ?? "") as
			| { address: string; memo: string | null; source: string; created_at: string }
			| undefined;
		if (row === undefined) return undefined;
		return {
			asset: sym,
			network: network === "" ? undefined : network,
			address: row.address,
			memo: row.memo ?? undefined,
			source: row.source,
			createdAt: row.created_at,
		};
	}

	/**
	 * Which chains this customer CAN deposit an asset on right now.
	 *
	 * Returned alongside a refusal so the answer to "I cannot deposit USDT on
	 * Solana" is "deposit it on Tron" rather than a dead end.
	 */
	availableNetworks(userId: string, asset: string): readonly string[] {
		const sym = settlementAsset(asset);
		const rows = this.db
			.prepare(
				`SELECT network FROM deposit_address WHERE user_id = ? AND asset = ?`,
			)
			.all(userId, sym) as { network: string }[];
		return rows.map((r) => r.network).filter((n) => n !== "");
	}

	/**
	 * Record an address provisioned by the custodian.
	 *
	 * REFUSES TO OVERWRITE. An address already on file for this customer and
	 * chain is returned as-is rather than replaced: re-provisioning would
	 * orphan any deposit already on its way to the old one. Replacing an
	 * address is therefore a deliberate two-step job, not something a retried
	 * provisioning run can do by accident.
	 */
	provision(args: {
		userId: string;
		asset: string;
		network: string | undefined;
		address: string;
		memo?: string;
		source: string;
	}): DepositAddress {
		const sym = settlementAsset(args.asset);
		const net = args.network ?? "";
		if (args.address.trim() === "") {
			throw new DepositError("an address is required");
		}
		if (args.source.trim() === "") {
			throw new DepositError(
				"a source is required — an address with no provenance cannot be audited",
			);
		}

		const existing = this.addressFor(args.userId, sym, net === "" ? undefined : net);
		if (existing !== undefined) {
			if (existing.address !== args.address.trim()) {
				throw new DepositError(
					`${args.userId} already has a ${sym}${net === "" ? "" : "." + net} ` +
						"deposit address. Replacing it would orphan deposits already in " +
						"flight to the old one — retire it deliberately instead.",
					409,
				);
			}
			return existing;
		}

		this.db
			.prepare(
				`INSERT INTO deposit_address
				   (user_id, asset, network, address, memo, source, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				args.userId,
				sym,
				net,
				args.address.trim(),
				args.memo !== undefined && args.memo.trim() !== "" ? args.memo.trim() : null,
				args.source,
				new Date().toISOString(),
			);
		return this.addressFor(args.userId, sym, net === "" ? undefined : net)!;
	}

	/** Count, for the admin view: how much of the registry is populated. */
	provisionedCount(): number {
		const r = this.db
			.prepare(`SELECT COUNT(*) AS n FROM deposit_address`)
			.get() as { n: number };
		return r.n;
	}
}

/**
 * The API shape for a deposit-address request — address, or a usable refusal.
 *
 * One function so the endpoint cannot accidentally return a half-answer, and so
 * the refusal wording lives beside the logic that produces it.
 */
export function describeDeposit(
	deposits: Deposits,
	userId: string,
	asset: string,
	network: string | undefined,
): {
	asset: string;
	network: string | null;
	address: string | null;
	memo: string | null;
	memoRequired: boolean;
	reason: string | null;
	alternatives: readonly string[];
} {
	const sym = settlementAsset(asset);
	const found = deposits.addressFor(userId, sym, network);
	if (found !== undefined) {
		return {
			asset: sym,
			network: found.network ?? null,
			address: found.address,
			memo: found.memo ?? null,
			// If a memo exists it is NOT optional — the chains that use them
			// cannot credit a deposit without it.
			memoRequired: found.memo !== undefined,
			reason: null,
			alternatives: [],
		};
	}

	const others = deposits.availableNetworks(userId, sym);
	return {
		asset: sym,
		network: network ?? null,
		address: null,
		memo: null,
		memoRequired: false,
		reason:
			`No ${sym} deposit address is provisioned` +
			(network === undefined || network === "" ? "" : ` on ${network}`) +
			" for this account yet. We will not show you an address we are not " +
			"certain of — a deposit to a wrong address cannot be recovered by " +
			"anyone." +
			(others.length > 0
				? ` ${sym} is available on: ${others.join(", ")}.`
				: ""),
		alternatives: others,
	};
}
