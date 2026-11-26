// -----------------------------------------------------------------------------
// SOLANA DEPOSIT ADDRESSES — a pool the exchange draws from, never derives.
//
// SOL IS IN BLOCK'S POSITION, AND FOR THE SAME CRYPTOGRAPHIC REASON.
//
// The EVM rails can hold an account-level xpub and derive a per-customer
// address online with no spending authority at all, because secp256k1 has
// watch-only child derivation: `pointAdd(parentPub, IL*G)` needs no secret.
// Solana does not. Solana is ed25519 under SLIP-0010, where child derivation
// is `HMAC-SHA512(chainCode, 0x00 || PRIVATE_KEY || index)` — the secret IS
// the input. There is no public-key variant, and every wallet in this house
// implements it the same way and refuses anything else:
//
//   blockle-app/lib/multichain/chains/solana.dart — the HMAC key is documented
//     as the 32-byte ed25519 seed, and `_parsePath` throws outright on any
//     non-hardened segment ("ed25519 derivation requires hardened segments").
//     The standard path is m/44'/501'/0'/0' — every segment hardened.
//   python/blockle/multichain/crypto/slip10.py, and the extension and web
//     wallets, agree.
//
// So "derive the next address" and "be able to spend every address" are the
// same capability on Solana, exactly as they are on BLOCK with ML-DSA. The
// exchange host must therefore never do it, and the answer is the pattern this
// repo already runs in production: derive a batch OFFLINE on the host that
// holds the seed, ship only the ADDRESSES in, hand them out one per customer.
// See blockaddresspool.ts, which this file deliberately mirrors.
//
// WHAT MUST NOT BE REUSED HERE, NAMED SO NOBODY DOES IT BY ACCIDENT:
// services/accounts/src/vendor/solana.js. It has `publicKey`,
// `addressFromSeed`, `signMessage` and `signTransaction`, and every one of
// them takes a 32-byte SECRET seed — it is the bot runner's delegated signer,
// not a derivation library. If a SOL rail ever imports that file to make an
// address, a seed has arrived on the exchange host and the entire reason this
// pool exists has been undone. The only idea in it worth borrowing is
// `assertFeePayer`, and that belongs on the signer host.
//
// WHAT DIFFERS FROM BLOCK, AND IT IS ONE THING THAT MATTERS:
//
//   BLOCK's `AddressPool.take()` returns only `{address}` and the derivation
//   index is dropped on the floor. BLOCK survives that because the operator
//   sweeps the whole wallet — the index is never needed again. SOLANA IS
//   ACCOUNT-PER-ADDRESS: every deposit sits in its own account, and composing
//   the transaction that empties it requires the key for THAT account, which
//   the signer re-derives from `m/44'/501'/idx'/0'`. Lose the index and the
//   coins are unreachable even with the seed in hand — you would be searching
//   a space you cannot enumerate. So `take()` here returns the index, this
//   table is the authoritative address->index map, and `indexOf()` exists for
//   the sweeper. (The index is NOT duplicated into `deposit_address`: that
//   table has a BEFORE UPDATE trigger that ABORTs edits, it is keyed
//   (user_id, asset, network), and a second copy of a recoverability-critical
//   number is a second thing to drift. This table lives in the same database
//   file, so a join is free.)
//
// WHAT THIS COSTS, SAID PLAINLY, same as BLOCK: the pool runs out, and when it
// does deposits STOP rather than degrade. `take()` refuses and says how to
// refill. Reusing an address would make two customers' deposits
// indistinguishable on a chain with no memo field, which is how a venue
// credits the wrong person and never finds out.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { checkSolAddress } from "./soladdress";

export class SolAddressPoolError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "SolAddressPoolError";
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sol_address_pool (
  -- The HARDENED ACCOUNT INDEX of m/44'/501'/idx'/0'. On Solana this is not a
  -- convenience, it is the recoverability contract: the account holding a
  -- customer's deposit can only be emptied by the key at this index, and the
  -- signer re-derives it from the seed before it will sign a sweep.
  --
  -- It is the primary key so that loading the same batch twice cannot
  -- duplicate a row, and so that the same index arriving with a different
  -- address is a detectable contradiction rather than a second entry.
  idx        INTEGER PRIMARY KEY,
  address    TEXT NOT NULL UNIQUE,
  loaded_at  TEXT NOT NULL,
  -- Set when handed to a customer. An address is issued at most once; see
  -- take().
  issued_to  TEXT,
  issued_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sol_pool_free
  ON sol_address_pool(issued_to) WHERE issued_to IS NULL;
`;

export interface SolPoolEntry {
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

/** A derived address as the offline deriver emits it. */
export interface DerivedSolAddress {
	readonly index: number;
	readonly address: string;
}

/**
 * How runway is reported.
 *
 * Structurally a superset of BLOCK's `{total, issued, free, low}` so the same
 * consumers work, plus the one signal BLOCK does not have — see `status()`.
 */
export interface SolPoolStatus {
	readonly total: number;
	readonly issued: number;
	readonly free: number;
	readonly low: boolean;
	/**
	 * Days until the pool is empty at the trailing issuance rate, or undefined
	 * when nothing has been issued recently (no rate, no projection).
	 */
	readonly daysOfRunway?: number;
	/** The trailing issuance rate the projection used, addresses per day. */
	readonly issuedPerDay?: number;
}

export class SolAddressPool {
	constructor(
		private readonly db: Database,
		private readonly now: () => Date = () => new Date(),
	) {
		db.exec(SCHEMA);
	}

	/**
	 * Load a batch derived on the signer host.
	 *
	 * IDEMPOTENT ON THE INDEX, for the reason blockaddresspool.ts records: the
	 * realistic operator mistake is running the load twice, and failing the
	 * whole batch for that pushes people toward `--force`-shaped workarounds.
	 *
	 * An index already present with a DIFFERENT address is refused outright —
	 * that means two master seeds, and a pool mixing two seeds contains
	 * addresses nobody can match to a key. On Solana that is worse than on
	 * BLOCK: there is no wallet-wide sweep to fall back on, so an address whose
	 * seed is unknown is a permanently stranded account.
	 *
	 * VALIDATION HAPPENS HERE AND NOT AT USE, also like BLOCK — but the check
	 * is a real base58 decode plus an on-curve test rather than a regex,
	 * because base58 is unchecksummed and about half of all 32-byte strings are
	 * off-curve and therefore unspendable. See soladdress.ts.
	 */
	load(entries: readonly DerivedSolAddress[]): { added: number; alreadyPresent: number } {
		if (entries.length === 0) throw new SolAddressPoolError("nothing to load");
		const stamp = this.now().toISOString();
		const existing = this.db.prepare(`SELECT address FROM sol_address_pool WHERE idx = ?`);
		const insert = this.db.prepare(
			`INSERT INTO sol_address_pool (idx, address, loaded_at) VALUES (?, ?, ?)`,
		);

		let added = 0;
		let alreadyPresent = 0;
		const tx = this.db.transaction(() => {
			for (const e of entries) {
				assertSolPoolAddress(e.address);
				if (!Number.isInteger(e.index) || e.index < 0) {
					throw new SolAddressPoolError(`not a derivation index: ${e.index}`);
				}
				/*
				 * BIP32'S HARDENED CEILING APPLIES TO SLIP-0010 TOO. A hardened
				 * index is i + 2^31, so i must be below 2^31; a number above that
				 * is not a path segment the signer can re-derive, and the batch
				 * file that produced it is wrong in a way no later step detects.
				 */
				if (e.index >= 2 ** 31) {
					throw new SolAddressPoolError(
						`index ${e.index} is beyond the hardened range (2^31). The signer ` +
							"derives m/44'/501'/idx'/0', and a segment this large is not a " +
							"path it can reproduce.",
					);
				}
				const row = existing.get(e.index) as { address: string } | undefined;
				if (row !== undefined) {
					if (row.address !== e.address) {
						throw new SolAddressPoolError(
							`index ${e.index} is already loaded as ${row.address} but this ` +
								`batch says ${e.address}. That means two different master ` +
								"seeds — refusing, because the pool would then contain " +
								"addresses nobody can match to a key, and on Solana there is " +
								"no wallet-wide sweep that could recover them anyway.",
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
	 * given, or a deposit in flight to the old one looks unattributed. On a
	 * chain with no memo field there is no second way to attribute it.
	 *
	 * The claim is a conditional UPDATE inside a transaction, so two
	 * simultaneous requests cannot both take the same row — the second sees it
	 * taken and moves on.
	 */
	take(userId: string): SolPoolEntry {
		const owner = userId.trim();
		if (owner === "") throw new SolAddressPoolError("an address needs an owner");

		const mine = this.forUser(owner);
		if (mine !== undefined) return mine;

		const stamp = this.now().toISOString();
		const claim = this.db.transaction((): Raw | undefined => {
			const free = this.db
				.prepare(
					`SELECT * FROM sol_address_pool WHERE issued_to IS NULL
					 ORDER BY idx LIMIT 1`,
				)
				.get() as Raw | undefined;
			if (free === undefined) return undefined;
			const done = this.db
				.prepare(
					`UPDATE sol_address_pool SET issued_to = ?, issued_at = ?
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
			throw new SolAddressPoolError(
				"no SOL deposit addresses are left in the pool. Deposits are paused " +
					"rather than reusing one, which would credit two customers' coins " +
					"to the same account with no memo field to tell them apart. Refill " +
					"by deriving a batch on the signer host and loading it here: " +
					"`node dist/src/solpoolcli.js --from batch.json`.",
				503,
			);
		}
		return hydrate(got);
	}

	/** The address this customer already has, if any. */
	forUser(userId: string): SolPoolEntry | undefined {
		const row = this.db
			.prepare(`SELECT * FROM sol_address_pool WHERE issued_to = ? ORDER BY idx LIMIT 1`)
			.get(userId.trim()) as Raw | undefined;
		return row === undefined ? undefined : hydrate(row);
	}

	/** Who owns an address, for attributing an incoming deposit. */
	ownerOf(address: string): string | undefined {
		const row = this.db
			.prepare(`SELECT issued_to FROM sol_address_pool WHERE address = ?`)
			.get(address.trim()) as { issued_to: string | null } | undefined;
		return row?.issued_to ?? undefined;
	}

	/**
	 * The derivation index behind an address.
	 *
	 * THE SWEEPER CANNOT WORK WITHOUT THIS. A sweep proposal names, per source,
	 * the index the signer must re-derive to produce that address; a source
	 * with no index is a source the signer will refuse, and refusing is correct
	 * — it is the check that stops a compromised exchange host from proposing a
	 * sweep of an address it does not actually own.
	 */
	indexOf(address: string): number | undefined {
		const row = this.db
			.prepare(`SELECT idx FROM sol_address_pool WHERE address = ?`)
			.get(address.trim()) as { idx: number } | undefined;
		return row?.idx;
	}

	/** Every address in the pool, issued or not — what custody should watch. */
	allAddresses(): readonly string[] {
		return (
			this.db.prepare(`SELECT address FROM sol_address_pool ORDER BY idx`).all() as Array<{
				address: string;
			}>
		).map((r) => r.address);
	}

	/**
	 * Every ISSUED address with its index — the sweeper's and the scanner's
	 * input.
	 *
	 * Separate from `allAddresses()` because an unissued pool address cannot
	 * hold coins: nobody has been told about it. Polling it costs a round trip
	 * on an endpoint that caps `getMultipleAccounts` at 10 accounts, so the
	 * distinction between 1,000 loaded and 12 issued is the difference between
	 * 100 calls a pass and 2.
	 */
	issued(): readonly SolPoolEntry[] {
		return (
			this.db
				.prepare(`SELECT * FROM sol_address_pool WHERE issued_to IS NOT NULL ORDER BY idx`)
				.all() as Raw[]
		).map(hydrate);
	}

	/**
	 * How much runway is left.
	 *
	 * `low` keeps BLOCK's share-with-a-floor rule — `free <= max(16, 10%)` —
	 * because "50 left" means something different for a 100-address pool than
	 * for a 10,000-address one, and `low` is deliberately FALSE for an empty
	 * pool: total 0 is "closed", which is a different operator conversation and
	 * is surfaced separately.
	 *
	 * AND ONE SIGNAL BLOCK DOES NOT HAVE: PROJECTED EXHAUSTION. Refilling this
	 * pool is not a command, it is a ceremony — an operator, a seed, an offline
	 * host, a file carried between the two. "16 addresses left" discovered on a
	 * Saturday is already too late, and the failure it produces is the worst
	 * one available: customers being told a live rail is shut. So the trailing
	 * 7-day issuance rate is projected forward and reported in days.
	 *
	 * Seven days of history, not one: issuance is bursty — a listing, a
	 * promotion, a bot signing up two hundred accounts — and a one-day window
	 * would alternate between "no runway" and "infinite runway" with nothing in
	 * between for anyone to act on.
	 */
	status(): SolPoolStatus {
		const r = this.db
			.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN issued_to IS NULL THEN 0 ELSE 1 END) AS issued
				 FROM sol_address_pool`,
			)
			.get() as { total: number; issued: number | null };
		const total = r.total;
		const issued = r.issued ?? 0;
		const free = total - issued;
		const low = total > 0 && free <= Math.max(16, total * 0.1);

		const since = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
		const recent = (
			this.db
				.prepare(
					`SELECT COUNT(*) AS n FROM sol_address_pool
					 WHERE issued_at IS NOT NULL AND issued_at >= ?`,
				)
				.get(since) as { n: number }
		).n;
		if (recent === 0) return { total, issued, free, low };
		const issuedPerDay = recent / 7;
		return {
			total,
			issued,
			free,
			low,
			issuedPerDay,
			daysOfRunway: free / issuedPerDay,
		};
	}
}

function hydrate(r: Raw): SolPoolEntry {
	return {
		index: r.idx,
		address: r.address,
		issuedTo: r.issued_to,
		issuedAt: r.issued_at,
	};
}

/**
 * A Solana address, checked properly.
 *
 * Throws with the specific fault rather than "not a SOL address", because the
 * four ways this fails have four different causes and three of them are
 * recoverable by the operator in a different way: a non-base58 character is a
 * copy-paste, a wrong byte length is a truncated file, and an off-curve value
 * means the deriver emitted something that is not a public key at all — which
 * is a bug in the deriver, not in the file.
 */
export function assertSolPoolAddress(address: string): void {
	const v = checkSolAddress(address);
	if (!v.ok) {
		throw new SolAddressPoolError(
			`not a usable SOL deposit address ${JSON.stringify(address)}: ${v.why}`,
		);
	}
}
