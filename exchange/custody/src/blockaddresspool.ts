// -----------------------------------------------------------------------------
// BLOCK DEPOSIT ADDRESSES — a pool the exchange draws from, never derives.
//
// THE POINT OF THIS FILE IS WHAT IT DOES NOT HOLD.
//
// The chain can now derive unlimited addresses from one master seed
// (`blockle-chain wallet derive`). But ML-DSA has no watch-only derivation —
// there is no public key from which addresses follow without the secret — so
// anything that derives BLOCK addresses necessarily holds spending authority
// for every one of them.
//
// The public API must not hold that. It is the most exposed process in the
// system: it parses untrusted input on every request, and a flaw in it would
// otherwise reach the seed behind every customer's deposit address.
//
// So the split is:
//
//   OFFLINE, by an operator, on a machine with the wallet:
//       blockle-chain wallet derive --count 1000 --json  >  addresses.json
//
//   ONLINE, here:
//       the exchange loads that list and hands them out one at a time.
//
// The exchange therefore knows which address belongs to which customer, can
// watch them all, and cannot spend any of them. Sweeping and payouts stay with
// whoever holds the wallet, which is the correct division: the thing that
// faces the internet does not face the money.
//
// WHAT THIS COSTS, SAID PLAINLY: the pool runs out. When it does, deposits
// stop rather than degrade — `take()` refuses and says how to refill. That is
// the right failure: the alternative, reusing an address, silently attributes
// one customer's deposit to another.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

export class AddressPoolError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "AddressPoolError";
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS block_address_pool (
  -- The derivation index, which is what makes an address recoverable: with
  -- the seed and this number, the operator can re-derive the key that spends
  -- whatever arrived here. It is the primary key so loading the same batch
  -- twice cannot duplicate an entry.
  idx        INTEGER PRIMARY KEY,
  address    TEXT NOT NULL UNIQUE,
  loaded_at  TEXT NOT NULL,
  -- Set when handed to a customer. An address is issued at most once; see
  -- take().
  issued_to  TEXT,
  issued_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_block_pool_free
  ON block_address_pool(issued_to) WHERE issued_to IS NULL;
`;

export interface PoolEntry {
	readonly index: number;
	readonly address: string;
	readonly issuedTo: string | null;
	readonly issuedAt: string | null;
}

interface Raw {
	idx: number;
	address: string;
	loaded_at: string;
	issued_to: string | null;
	issued_at: string | null;
}

/** A derived address as the wallet CLI emits it. */
export interface DerivedAddress {
	readonly index: number;
	readonly address: string;
}

export class BlockAddressPool {
	constructor(
		private readonly db: Database,
		private readonly now: () => Date = () => new Date(),
	) {
		db.exec(SCHEMA);
	}

	/**
	 * Load a batch produced by `blockle-chain wallet derive --json`.
	 *
	 * IDEMPOTENT ON THE INDEX. Re-running the same load is a no-op rather than
	 * an error, because the realistic operator mistake is running it twice,
	 * and failing the whole batch for that would push someone toward
	 * `--force`-shaped workarounds.
	 *
	 * An index that is already present with a DIFFERENT address is refused
	 * outright: that means the batch came from another seed, and mixing two
	 * seeds in one pool produces addresses nobody can match to a key.
	 */
	load(entries: readonly DerivedAddress[]): { added: number; alreadyPresent: number } {
		if (entries.length === 0) throw new AddressPoolError("nothing to load");
		const stamp = this.now().toISOString();
		const existing = this.db.prepare(
			`SELECT address FROM block_address_pool WHERE idx = ?`,
		);
		const insert = this.db.prepare(
			`INSERT INTO block_address_pool (idx, address, loaded_at) VALUES (?, ?, ?)`,
		);

		let added = 0;
		let alreadyPresent = 0;
		const tx = this.db.transaction(() => {
			for (const e of entries) {
				assertAddress(e.address);
				if (!Number.isInteger(e.index) || e.index < 0) {
					throw new AddressPoolError(`not a derivation index: ${e.index}`);
				}
				const row = existing.get(e.index) as { address: string } | undefined;
				if (row !== undefined) {
					if (row.address !== e.address) {
						throw new AddressPoolError(
							`index ${e.index} is already loaded as ${row.address} but this ` +
								`batch says ${e.address}. That means two different master ` +
								"seeds — refusing, because the pool would then contain " +
								"addresses nobody can match to a key.",
						);
					}
					alreadyPresent += 1;
					continue;
				}
				insert.run(e.index, e.address, stamp);
				added += 1;
			}
		});
		tx();
		return { added, alreadyPresent };
	}

	/**
	 * Take the lowest unissued address for a customer.
	 *
	 * ONE ADDRESS PER CUSTOMER, and the same one every time: a customer who
	 * returns to the deposit screen must see the address they were already
	 * given, or a deposit in flight to the old one looks unattributed.
	 *
	 * The claim is a conditional UPDATE inside a transaction, so two
	 * simultaneous requests cannot both take the same row — the second one
	 * sees it taken and moves on.
	 */
	take(userId: string): PoolEntry {
		const owner = userId.trim();
		if (owner === "") throw new AddressPoolError("an address needs an owner");

		const mine = this.forUser(owner);
		if (mine !== undefined) return mine;

		const stamp = this.now().toISOString();
		const claim = this.db.transaction((): Raw | undefined => {
			const free = this.db
				.prepare(
					`SELECT * FROM block_address_pool WHERE issued_to IS NULL
					 ORDER BY idx LIMIT 1`,
				)
				.get() as Raw | undefined;
			if (free === undefined) return undefined;
			const done = this.db
				.prepare(
					`UPDATE block_address_pool SET issued_to = ?, issued_at = ?
					 WHERE idx = ? AND issued_to IS NULL`,
				)
				.run(owner, stamp, free.idx);
			// Lost the race to another request: the caller retries, which is
			// cheap, rather than receiving an address someone else now owns.
			if (done.changes === 0) return undefined;
			return { ...free, issued_to: owner, issued_at: stamp };
		});

		const got = claim();
		if (got === undefined) {
			// Try once more in case the only failure was a lost race.
			const second = claim();
			if (second !== undefined) return hydrate(second);
			throw new AddressPoolError(
				"no BLOCK deposit addresses are left in the pool. Deposits are " +
					"paused rather than reusing one, which would credit two " +
					"customers' coins to the same place. Refill with: " +
					"`blockle-chain wallet derive --count 1000 --json` on the wallet " +
					"host, then load the output here.",
				503,
			);
		}
		return hydrate(got);
	}

	/** The address this customer already has, if any. */
	forUser(userId: string): PoolEntry | undefined {
		const row = this.db
			.prepare(`SELECT * FROM block_address_pool WHERE issued_to = ? ORDER BY idx LIMIT 1`)
			.get(userId.trim()) as Raw | undefined;
		return row === undefined ? undefined : hydrate(row);
	}

	/** Who owns an address, for attributing an incoming deposit. */
	ownerOf(address: string): string | undefined {
		const row = this.db
			.prepare(`SELECT issued_to FROM block_address_pool WHERE address = ?`)
			.get(address.trim()) as { issued_to: string | null } | undefined;
		return row?.issued_to ?? undefined;
	}

	/** Every address in the pool, issued or not — what custody should watch. */
	allAddresses(): readonly string[] {
		return (
			this.db.prepare(`SELECT address FROM block_address_pool ORDER BY idx`).all() as Array<{
				address: string;
			}>
		).map((r) => r.address);
	}

	/**
	 * Only the addresses that have actually been handed to somebody.
	 *
	 * THE DIFFERENCE FROM `allAddresses` IS NOT COSMETIC. Custody wants every
	 * address — coins we control are ours wherever they sit, and a pool entry
	 * omitted from the total reads as a shortfall. Deposit SCANNING wants only
	 * the issued ones, for two separate reasons:
	 *
	 *  - Cost. The explorer answers one address per request, so scanning the
	 *    whole pool is one request per entry. A 1000-entry pool with four
	 *    customers made 1000 sequential requests and blew the watcher's
	 *    5-minute start timeout, which is how this was found.
	 *  - Meaning. Nobody has been told an unissued address, so money cannot
	 *    legitimately arrive at one. If it ever did, it is not a deposit to
	 *    credit; it is an anomaly, and the reconciler is what should surface
	 *    it, via `allAddresses` in the custody total.
	 */
	issuedAddresses(): readonly string[] {
		return (
			this.db
				.prepare(
					`SELECT address FROM block_address_pool
					  WHERE issued_to IS NOT NULL ORDER BY idx`,
				)
				.all() as Array<{ address: string }>
		).map((r) => r.address);
	}

	/**
	 * How much runway is left.
	 *
	 * `low` is the signal an operator acts on. A pool that empties stops
	 * deposits, so the warning has to come early enough to refill calmly —
	 * and the threshold is a share of the pool, not a constant, because
	 * "50 left" means something different for a 100-address pool than for a
	 * 10,000-address one.
	 */
	status(): { total: number; issued: number; free: number; low: boolean } {
		const r = this.db
			.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN issued_to IS NULL THEN 0 ELSE 1 END) AS issued
				 FROM block_address_pool`,
			)
			.get() as { total: number; issued: number | null };
		const total = r.total;
		const issued = r.issued ?? 0;
		const free = total - issued;
		return { total, issued, free, low: total > 0 && free <= Math.max(16, total * 0.1) };
	}
}

function hydrate(r: Raw): PoolEntry {
	return {
		index: r.idx,
		address: r.address,
		issuedTo: r.issued_to,
		issuedAt: r.issued_at,
	};
}

/**
 * A BLOCK address, as the chain encodes them: bech32m, `block1…`.
 *
 * Checked on load rather than on use. A malformed address in the pool is a
 * deposit address handed to a customer that no coins can ever reach, and
 * finding that out at load time costs nothing.
 */
export function assertAddress(address: string): void {
	if (!/^block1[0-9a-z]{20,}$/.test(address)) {
		throw new AddressPoolError(`not a BLOCK address: ${JSON.stringify(address)}`);
	}
}
