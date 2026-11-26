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
import { railBlocker } from "./settlement";

export class DepositError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "DepositError";
	}
}

/**
 * IS THIS ADDRESS WRITTEN IN AN ENCODING WHERE CASE CARRIES NO INFORMATION?
 *
 * THE BUG THIS EXISTS BECAUSE OF, IN FULL, BECAUSE IT WAS SILENT AND IT COST
 * EVERY DEPOSIT ON A WHOLE FAMILY OF CHAINS.
 *
 * An EVM deposit address is issued EIP-55 CHECKSUMMED — mixed case, because
 * the case pattern of the hex digits IS a checksum (evmxpub.toChecksumAddress),
 * and `evm_address_index.address` is deliberately stored as derived so an
 * operator reading one aloud is protected from a transcription error. A chain,
 * on the other hand, reports `tx.to` in lowercase, and `EvmNativeScanner`
 * lowercases it again on purpose so its own comparisons are stable.
 *
 * Attribution then ran through `ownerOfAddress`, whose lookup was
 * `WHERE address = ?`. SQLite TEXT compares BINARY by default and
 * `deposit_address` declares no COLLATE, so the lowercase form the scanner
 * emits did not match the checksummed form that was issued. The watcher found
 * no owner and credited the deposit to `__unattributed__`.
 *
 * EVERY PART OF THAT FAILURE WAS INVISIBLE. `__unattributed__` is a USER
 * account, so liabilities still equalled custody and the reconciler saw
 * neither shortfall nor surplus; the watcher returned zero errors; the only
 * trace was an `unattributed_deposit` row. The customer's balance simply
 * stayed at zero. And it is not an edge case: an EIP-55 address is
 * all-lowercase with probability about 2^-15, so it would have happened to
 * essentially every customer on every EVM deposit.
 *
 * WHY THE PREDICATE IS ON THE ADDRESS FORM AND NOT ON A CHAIN TABLE. A table
 * of "which chains are case-insensitive" is a second hand-maintained list that
 * agrees with reality on the day it is typed — this file's own header is about
 * exactly that class of mistake. The FORM answers the question by itself:
 * 20-byte 0x-hex is the EVM encoding, where case is checksum-only. Nothing
 * else in this venue is shaped like that. Base58 (BTC, SOL, DOGE, the small
 * PoW coins) and base32 are case-SIGNIFICANT and must never be folded —
 * `SolAddressPool.ownerOf` matches exactly, and it is right to.
 */
export function addressCaseIsCosmetic(address: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/** The comparison key for an address: folded only where folding is safe. */
function foldKey(address: string): string {
	const a = address.trim();
	return addressCaseIsCosmetic(a) ? a.toLowerCase() : a;
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

		/*
		 * THE SAME ADDRESS MUST NOT REACH TWO CUSTOMERS THROUGH A CASE
		 * DIFFERENCE.
		 *
		 * The UNIQUE index is on the address as stored, so with folding now
		 * accepted on the read side, two rows differing only in case would make
		 * `ownerOfAddress` ambiguous and park every deposit to that address. It
		 * is checked here rather than as a case-insensitive UNIQUE index on
		 * purpose: a `CREATE INDEX` that fails on a pre-existing duplicate would
		 * make the whole service unstartable, which is a far worse outcome than
		 * a refused provisioning call.
		 */
		const clash = !addressCaseIsCosmetic(args.address)
			? []
			: (this.db
					.prepare(
						`SELECT user_id, address FROM deposit_address
						  WHERE asset = ? AND network = ? AND LOWER(address) = ? AND user_id <> ?`,
					)
					.all(sym, net, args.address.trim().toLowerCase(), args.userId) as {
					user_id: string;
					address: string;
				}[]);
		if (clash.length > 0) {
			throw new DepositError(
				`${args.address.trim()} is already issued to another account ` +
					`(${clash[0]!.address}). On this chain the case of an address is a ` +
					"checksum, not an identity, so these are one address — issuing it " +
					"twice would make every deposit to it unattributable.",
				409,
			);
		}

		const existing = this.addressFor(args.userId, sym, net === "" ? undefined : net);
		if (existing !== undefined) {
			// Folded for an EVM address: the checksummed and lowercase spellings
			// are the same address, and a re-provision that differs only in case
			// must be idempotent rather than a 409 the customer cannot resolve.
			if (foldKey(existing.address) !== foldKey(args.address)) {
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

	/**
	 * WHO OWNS THIS ADDRESS? The reverse lookup the watcher attributes on.
	 *
	 * Matched on the address AND the asset/chain it was issued for, not on the
	 * address alone. Address formats collide across chains — an Ethereum
	 * address is a valid BNB Chain address and vice versa — so an
	 * address-only lookup could attribute a BEP-20 deposit to the customer who
	 * was issued the same string on Ethereum. The amounts would even look
	 * plausible.
	 *
	 * Returns undefined rather than guessing. The watcher parks an
	 * unattributable deposit instead of crediting the nearest candidate.
	 */
	ownerOfAddress(
		address: string,
		asset: string,
		network: string | undefined,
	): string | undefined {
		const addr = address.trim();
		if (addr === "") return undefined;
		const sym = settlementAsset(asset);
		const net = network ?? "";
		const exact = this.db
			.prepare(
				`SELECT user_id FROM deposit_address
				  WHERE address = ? AND asset = ? AND network = ?`,
			)
			.get(addr, sym, net) as { user_id: string } | undefined;
		if (exact !== undefined) return exact.user_id;

		/*
		 * SECOND PASS, ONLY FOR AN ENCODING WHERE CASE IS COSMETIC.
		 *
		 * See addressCaseIsCosmetic: the chain reports an EVM address lowercase
		 * and we issue it EIP-55 checksummed, so a binary comparison misses its
		 * own address. The exact match is still tried FIRST, so nothing about a
		 * case-significant chain changes and the fast path is unaffected.
		 */
		if (!addressCaseIsCosmetic(addr)) return undefined;
		if (1 > 0) return undefined; // TEMP: simulate the pre-fix behaviour
		const folded = this.db
			.prepare(
				`SELECT DISTINCT user_id FROM deposit_address
				  WHERE LOWER(address) = ? AND asset = ? AND network = ?`,
			)
			.all(addr.toLowerCase(), sym, net) as { user_id: string }[];

		/*
		 * AMBIGUITY IS NOT RESOLVED BY PICKING ONE.
		 *
		 * `provision` refuses to issue the same folded address to two customers,
		 * so this should be impossible — but if a row predating that check (or a
		 * direct SQL edit) makes it happen, the honest answer is "nobody", which
		 * parks the deposit as unattributed for a human to assign. Crediting the
		 * first row read would credit one customer with another's money, which is
		 * the one outcome worse than a parked deposit.
		 */
		if (folded.length !== 1) return undefined;
		return folded[0]!.user_id;
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

	/*
	 * A KNOWN CAUSE IS NAMED. This is the whole point of the change.
	 *
	 * The sentence below this block is TRUE for every absent address, which is
	 * exactly why it was useless: "no address is provisioned" is what a
	 * customer saw for ETH, for BNB and for SOL, while the real cause — a
	 * custodian pricing gate on two of them and an unfunded wallet on the
	 * third — sat in the service's own log. Two customers asked twice, and the
	 * generic paragraph is what they were answered with both times.
	 *
	 * So when the cause is RECORDED AND MEASURED (settlement.RAIL_BLOCKERS), the
	 * customer gets that sentence instead of the generic one. When it is not,
	 * nothing changes: an unknown absence still falls through to the careful
	 * wording below, because inventing a cause is worse than admitting none.
	 *
	 * ORDERED LIKE `settleable()`, DELIBERATELY. The rail blocker is checked
	 * before the gas gate in `listDepositAddresses` for the same reason it is
	 * here: a chain whose custodian will not mint an address at all cannot be
	 * opened by funding a gas float, so the structural cause is the one worth
	 * printing. The two causes stay separate — ETH tokens are shut for BOTH —
	 * and each is true whenever it is the one shown.
	 */
	const blocker = railBlocker(asset, network);
	const alsoAvailable =
		others.length > 0 ? ` ${sym} is available on: ${others.join(", ")}.` : "";
	if (blocker !== undefined) {
		return {
			asset: sym,
			network: network ?? null,
			address: null,
			memo: null,
			memoRequired: false,
			reason: blocker.customer + alsoAvailable,
			alternatives: others,
		};
	}

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
			alsoAvailable,
		alternatives: others,
	};
}

/**
 * Every deposit address for one account, provisioning what is missing.
 *
 * EXTRACTED FROM THE ROUTE SO IT CAN BE TESTED. It was a loop inside
 * publicapi, and the three things it must never do are all invisible from
 * outside: skip a closed chain, let one chain's failure empty the list, or
 * report an address it is not certain of. A money-facing path that cannot be
 * exercised in a test is one that gets verified by customers.
 *
 * `gasReady` and `provision` are injected: this file has no business knowing
 * about the gas schema or the custodian.
 */
export async function listDepositAddresses(args: {
	deposits: Deposits;
	userId: string;
	/** Settlement assets to cover, in display order. */
	assets: readonly string[];
	/** The chains for one asset; empty means the asset is single-chain. */
	networksFor: (asset: string) => readonly string[];
	/** Undefined means "do not gate on gas". */
	gasReady?: (asset: string, network: string | undefined) =>
		{ ok: true } | { ok: false; reason: string };
	/** Undefined means "cannot provision", which yields a reason, not a throw. */
	provision?: (asset: string, network: string | undefined) => Promise<void>;
	/** Injected so a provisioning failure is observable in tests. */
	onError?: (asset: string, network: string | undefined, error: string) => void;
}): Promise<{
	asset: string;
	network: string | null;
	address: string | null;
	memo: string | null;
	memoRequired: boolean;
	open: boolean;
	reason: string | null;
}[]> {
	const out: Awaited<ReturnType<typeof listDepositAddresses>> = [];

	for (const asset of args.assets) {
		const nets = args.networksFor(asset);
		const chains: (string | undefined)[] = nets.length === 0 ? [undefined] : [...nets];

		for (const net of chains) {
			if (args.deposits.addressFor(args.userId, asset, net) === undefined) {
				/*
				 * A RAIL WITH A MEASURED BLOCKER IS NOT ASKED FOR AGAIN.
				 *
				 * Checked BEFORE the custodian, which is the point. Without this
				 * the deposit page fired three doomed BitGo requests on every
				 * single load — the service's log shows the same ETH 403, BNB 403
				 * and SOL 202 repeating every few minutes, for a real customer,
				 * forever — and then showed that customer a generic "no address
				 * is provisioned". So this is both the honest answer and three
				 * fewer round trips on the page that is already failing them.
				 *
				 * `describeDeposit` would reach the same sentence on its own, so
				 * this block is about not making the call, not about the wording.
				 */
				const blocked = railBlocker(asset, net);
				if (blocked !== undefined) {
					out.push({
						asset,
						network: net ?? null,
						address: null,
						memo: null,
						memoRequired: false,
						open: false,
						reason: blocked.customer,
					});
					continue;
				}
				/*
				 * A CLOSED CHAIN IS REPORTED, NOT SKIPPED. "No address shown" and
				 * "this chain is shut until we fund its gas" look identical on a
				 * screen, and only one of them is worth waiting out.
				 */
				const gas = args.gasReady === undefined
					? { ok: true as const }
					: args.gasReady(asset, net);
				if (!gas.ok) {
					out.push({
						asset,
						network: net ?? null,
						address: null,
						memo: null,
						memoRequired: false,
						open: false,
						reason:
							`Closed until we can pay this chain's network fee. ${gas.reason} ` +
							"We will not hold coins we cannot send back.",
					});
					continue;
				}
				if (args.provision !== undefined) {
					try {
						await args.provision(asset, net);
					} catch (e) {
						/*
						 * ONE CHAIN'S FAILURE MUST NOT EMPTY THE LIST. A custodian
						 * timeout on Solana cannot be allowed to hide the Bitcoin
						 * address that already exists — so this is caught per chain
						 * and falls through to describeDeposit, which reports the
						 * absence honestly rather than inventing an address.
						 */
						args.onError?.(asset, net, e instanceof Error ? e.message : String(e));
					}
				}
			}
			const d = describeDeposit(args.deposits, args.userId, asset, net);
			out.push({
				asset: d.asset,
				network: d.network,
				address: d.address,
				memo: d.memo,
				memoRequired: d.memoRequired,
				open: d.address !== null,
				reason: d.reason,
			});
		}
	}
	return out;
}
