// -----------------------------------------------------------------------------
// ONE EVM DEPOSIT INDEX PER CUSTOMER — the recoverability ledger for the rail.
//
// WHAT THIS TABLE IS FOR, IN ONE SENTENCE: the integer in it is the only thing
// that lets the offline signer re-derive the key that spends whatever arrived
// at a customer's deposit address. Lose the index and the coins are not stolen,
// they are unreachable, which is worse because it looks like an accounting
// problem rather than a loss.
//
// ONE INDEX PER CUSTOMER, NOT PER CHAIN, AND THE DIFFERENCE MATTERS TWICE.
//
// Derivation is `m/44'/60'/0'/0/i` on secp256k1, which is the SAME account on
// Ethereum, BSC and Polygon — the house's own wallet code says so outright
// (services/accounts/src/vendor/evm.js:3, "SAME key across all EVM chains").
// So customer N has ONE address that is simultaneously their ETH, their BNB and
// their POL deposit address, and issuing a second index per chain would create
// three rows describing one address.
//
//   (a) THE ROW IS PER CUSTOMER. `user_id` is UNIQUE, so a customer who returns
//       to the deposit screen is handed the address they already have. The
//       alternative — a fresh address each visit — orphans any deposit already
//       in flight to the previous one, which then arrives at an address nobody
//       is attributed to and lands in `__unattributed__` as a liability owed to
//       nobody. That has already happened once on this venue, to XRP, via
//       BitGo's activation reserve, and ops/unbook-unattributed.js exists
//       because of it.
//
//   (b) ATTRIBUTION IS STILL PER (ASSET, NETWORK), downstream. The address goes
//       into `deposit_address` once per (asset, network) through
//       Deposits.provision, because `Deposits.ownerOfAddress` matches on address
//       AND asset AND network. An Ethereum address is a syntactically valid BSC
//       address; an address-only lookup would credit a BSC arrival against an
//       Ethereum deposit record, and the two have different confirmation rules.
//
// WHY INDEX 0 IS NOT GIVEN TO A CUSTOMER. The signer host holds the venue's own
// hot/gas address at a reserved index, and `m/44'/60'/0'/0/0` is the index
// every tool, every tutorial and every wallet picks for an account's first
// address. If a customer were issued index 0 and the signer's hot address were
// also index 0, the venue's gas drips and sweep change would land at a
// CUSTOMER's deposit address and be credited to that customer as a deposit.
// Reserving the low indices costs nothing and removes the whole class.
//
// WHAT THIS TABLE IS *NOT*: it is not the custody record and it is not the
// attribution record. It is the derivation record. `deposit_address` is still
// the attribution source of truth (it has the ABORT trigger that forbids
// editing an address in place), and the reconciler reads
// `allAddresses()` from here because coins sitting at a customer's address
// before a sweep are the venue's custody.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import {
	deriveChildPublic,
	evmAddressFromPublicKey,
	EVM_ACCOUNT_PATH,
	type EvmXpub,
	XpubError,
} from "./evmxpub";

export class EvmAddressError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "EvmAddressError";
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS evm_address_index (
  -- The BIP32 child index under m/44'/60'/0'/0. The primary key, for the same
  -- reason it is the primary key of block_address_pool: with the seed and this
  -- number the signer re-derives the spending key, and a UNIQUE index cannot
  -- be handed out twice by two concurrent requests.
  idx         INTEGER PRIMARY KEY,
  -- EIP-55 checksummed. Stored as derived, never lowercased in place: the
  -- checksum is the only protection against a transcription error if an
  -- operator ever has to read one of these aloud.
  address     TEXT NOT NULL UNIQUE,
  -- One index per CUSTOMER, enforced here rather than by convention. See the
  -- file header: a second address for a returning customer orphans deposits
  -- already in flight to the first one.
  user_id     TEXT NOT NULL UNIQUE,
  -- WHICH XPUB DERIVED THIS ROW. Four bytes of hash160 of the account public
  -- key — discloses nothing, and it is what makes an xpub rotation safe: if
  -- the configured xpub does not match the rows already issued, this module
  -- refuses to start rather than issuing addresses from a second account into
  -- the same index space, which would produce two different addresses claiming
  -- the same recorded index.
  xpub_fp     TEXT NOT NULL,
  derived_at  TEXT NOT NULL
);
`;

export interface EvmIssuedAddress {
	readonly address: string;
	readonly index: number;
}

interface Raw {
	idx: number;
	address: string;
	user_id: string;
	xpub_fp: string;
	derived_at: string;
}

/**
 * Indices below this are the venue's own, derived on the signer host.
 *
 * Sixteen rather than one: the signer may want a hot address, a gas drip
 * source and room for a future per-chain split without ever renumbering
 * customers. Sixteen addresses is a rounding error against a customer base and
 * the cost of getting this wrong later is a migration of live deposit
 * addresses, which `deposit_address`'s ABORT trigger deliberately makes
 * impossible.
 */
export const FIRST_CUSTOMER_INDEX = 16;

export class EvmAddressIndex {
	constructor(
		private readonly db: Database,
		private readonly account: EvmXpub,
		private readonly now: () => Date = () => new Date(),
	) {
		db.exec(SCHEMA);
		this.assertSameAccount();
	}

	/** The loaded account's fingerprint — safe to log, safe to publish. */
	get fingerprint(): string {
		return this.account.fingerprint;
	}

	/**
	 * REFUSE TO RUN AGAINST SOMEONE ELSE'S INDEX SPACE.
	 *
	 * This is the EVM analogue of blockaddresspool.ts's "same index, different
	 * address means two master seeds — refusing, because the pool would then
	 * contain addresses nobody can match to a key". Here the mixing would be
	 * even quieter: nothing about address 0xA at index 40 looks wrong until a
	 * sweep is attempted from the wrong seed and the signer reports that index
	 * 40 derives something else. By then the money is at 0xA.
	 */
	private assertSameAccount(): void {
		const row = this.db
			.prepare(`SELECT xpub_fp FROM evm_address_index ORDER BY idx LIMIT 1`)
			.get() as { xpub_fp: string } | undefined;
		if (row === undefined) return;
		if (row.xpub_fp !== this.account.fingerprint) {
			throw new EvmAddressError(
				`REFUSING TO START: the addresses already issued were derived from ` +
					`xpub ${row.xpub_fp} but the configured xpub is ${this.account.fingerprint}. ` +
					"Two accounts in one index space means some recorded index derives a " +
					"different address on the signer than the one holding a customer's " +
					"coins. If this is a deliberate rotation, do NOT point the new xpub at " +
					"this table: retire the old addresses and reprovision, because " +
					"deposits will keep arriving at the retired ones for months.",
				500,
			);
		}
	}

	/**
	 * PROVE THE XPUB BEFORE ANY ADDRESS IS ISSUED FROM IT.
	 *
	 * The signer host ships, alongside the xpub, a short list of addresses it
	 * derived from the SEED. This re-derives the same indices from the xpub and
	 * refuses on any mismatch. It is the only check that can tell "this is the
	 * xpub of the seed the signer holds" from "this is a valid xpub of some
	 * other seed" — both parse, both derive beautiful checksummed addresses, and
	 * only one of them is sweepable. Everything else in this rail is downstream
	 * of that distinction.
	 *
	 * Deliberately NOT optional and deliberately NOT a warning. A warning in a
	 * log is how 1000 loaded BLOCK addresses sat unused while customers were
	 * told the rail was shut: the log was read by nobody and proved nothing
	 * about the object actually in use.
	 */
	assertVectors(vectors: readonly EvmIssuedAddress[]): void {
		if (vectors.length === 0) {
			throw new EvmAddressError(
				"no derivation vectors were supplied, so there is nothing proving the " +
					"configured xpub belongs to the seed on the signer host. Generate " +
					`them on the signer (${EVM_ACCOUNT_PATH}/0 .. /4) and ship them with ` +
					"the xpub. Opening the rail without this means discovering a wrong " +
					"xpub at the first sweep, by which time customer coins are sitting at " +
					"addresses the signer cannot derive.",
				500,
			);
		}
		for (const v of vectors) {
			const derived = this.derive(v.index);
			if (derived.toLowerCase() !== v.address.toLowerCase()) {
				throw new EvmAddressError(
					`REFUSING TO START: ${EVM_ACCOUNT_PATH}/${v.index} derives ${derived} ` +
						`from the configured xpub, but the signer host says ${v.address}. ` +
						"The xpub does not belong to the seed that will have to sweep these " +
						"deposits. Re-export the xpub from the signer; do not 'fix' the " +
						"vector file.",
					500,
				);
			}
		}
	}

	/** Derive one index without touching the database. */
	derive(index: number): string {
		return evmAddressFromPublicKey(deriveChildPublic(this.account, index).publicKey);
	}

	/**
	 * The address for this customer, deriving and recording one if needed.
	 *
	 * RETURNS THE INDEX, NOT JUST THE ADDRESS. The AddressPool interface in
	 * blockchain.ts returns `{ address }` and drops the index, which is
	 * survivable for BLOCK because the operator sweeps the whole wallet. It is
	 * not survivable here: an EVM sweep is per address, so the index must reach
	 * the caller and be persisted next to the deposit record, or nobody can
	 * re-derive the key for that specific address.
	 *
	 * Allocation is `MAX(idx)+1` inside a transaction, with the INSERT's own
	 * UNIQUE constraints as the real guard. Two concurrent requests for two
	 * customers cannot take the same index (idx is the primary key) and two
	 * concurrent requests for the SAME customer cannot produce two rows
	 * (user_id is unique) — the loser of either race re-reads and gets the
	 * winner's row, which is the same answer it would have given anyway.
	 */
	take(userId: string): EvmIssuedAddress {
		const owner = userId.trim();
		if (owner === "") throw new EvmAddressError("a deposit address needs an owner");

		const mine = this.forUser(owner);
		if (mine !== undefined) return mine;

		const stamp = this.now().toISOString();
		const claim = this.db.transaction((): EvmIssuedAddress => {
			const existing = this.db
				.prepare(`SELECT * FROM evm_address_index WHERE user_id = ?`)
				.get(owner) as Raw | undefined;
			if (existing !== undefined) return { address: existing.address, index: existing.idx };

			const top = this.db.prepare(`SELECT MAX(idx) AS m FROM evm_address_index`).get() as {
				m: number | null;
			};
			let index = top.m === null ? FIRST_CUSTOMER_INDEX : top.m + 1;

			/*
			 * ADVANCE DELIBERATELY PAST AN INVALID CHILD, AND RECORD THE INDEX
			 * ACTUALLY USED.
			 *
			 * `deriveChildPublic` throws on the BIP32 `IL >= n` case rather than
			 * silently deriving index+1 the way the house's hd.js does — see
			 * evmxpub.ts for why a silently shifted index breaks recoverability.
			 * The skip therefore happens HERE, where the index that is stored is
			 * the index that was derived. Probability is about 2^-127 per index;
			 * the loop exists so that the one time it ever happens it is handled
			 * rather than being a five-year-old unexplained outage.
			 */
			let address: string | undefined;
			for (let attempt = 0; attempt < 8; attempt++) {
				try {
					address = this.derive(index);
					break;
				} catch (e) {
					if (!(e instanceof XpubError)) throw e;
					index += 1;
				}
			}
			if (address === undefined) {
				throw new EvmAddressError(
					`eight consecutive indices from ${index - 8} failed to derive. That is ` +
						"not chance — it means the configured xpub is wrong in a way the " +
						"parser accepted. The rail refuses to issue an address rather than " +
						"handing out one it cannot stand behind.",
					500,
				);
			}

			this.db
				.prepare(
					`INSERT INTO evm_address_index (idx, address, user_id, xpub_fp, derived_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(index, address, owner, this.account.fingerprint, stamp);
			return { address, index };
		});

		return claim();
	}

	/** The address this customer already has, if any. */
	forUser(userId: string): EvmIssuedAddress | undefined {
		const row = this.db
			.prepare(`SELECT * FROM evm_address_index WHERE user_id = ?`)
			.get(userId.trim()) as Raw | undefined;
		return row === undefined ? undefined : { address: row.address, index: row.idx };
	}

	/**
	 * Who owns an address. Case-insensitive, because an EIP-55 address and its
	 * lowercase form are the same address and a chain reports the lowercase one.
	 */
	ownerOf(address: string): string | undefined {
		const row = this.db
			.prepare(`SELECT user_id FROM evm_address_index WHERE LOWER(address) = LOWER(?)`)
			.get(address.trim()) as { user_id: string } | undefined;
		return row?.user_id;
	}

	/** The index behind an address, for composing a sweep proposal. */
	indexOf(address: string): number | undefined {
		const row = this.db
			.prepare(`SELECT idx FROM evm_address_index WHERE LOWER(address) = LOWER(?)`)
			.get(address.trim()) as { idx: number } | undefined;
		return row?.idx;
	}

	/**
	 * Every issued address — what custody must watch AND what the reconciler
	 * must count.
	 *
	 * Both, and the second one is the one that gets forgotten. Coins at a
	 * customer's deposit address before a sweep ARE the venue's holding; a
	 * reconciler that counted only the hot address would see the liability
	 * without the asset, which is a SHORTFALL, which has no tolerance at any
	 * size and halts the asset. blockchain.ts:224-227 does the same union for
	 * BLOCK for exactly this reason.
	 */
	allAddresses(): readonly string[] {
		return (
			this.db.prepare(`SELECT address FROM evm_address_index ORDER BY idx`).all() as Array<{
				address: string;
			}>
		).map((r) => r.address);
	}

	/** Issued count and the next index, for operator output. */
	status(): { issued: number; nextIndex: number; fingerprint: string } {
		const r = this.db
			.prepare(`SELECT COUNT(*) AS n, MAX(idx) AS m FROM evm_address_index`)
			.get() as { n: number; m: number | null };
		return {
			issued: r.n,
			nextIndex: r.m === null ? FIRST_CUSTOMER_INDEX : r.m + 1,
			fingerprint: this.account.fingerprint,
		};
	}

	/**
	 * THE OFF-HOST MONITOR'S INPUT, and the reason it is a method rather than a
	 * report someone writes by hand.
	 *
	 * No key design closes this attack: root on this host does not need to sign
	 * anything to steal a NEW customer's first deposit — it only has to change
	 * what that customer is SHOWN as their deposit address. The xpub model does
	 * not help, because the display is downstream of derivation.
	 *
	 * What does help is that every issued address is deterministic from PUBLIC
	 * data: the xpub fingerprint plus the index. So this emits (index, address,
	 * fingerprint) for every row, a monitor running somewhere this host cannot
	 * reach or rewrite re-derives each one from its own copy of the xpub, and
	 * any mismatch is an alarm. The same triple is what the deposit screen
	 * publishes so a customer can verify their own address off our
	 * infrastructure entirely.
	 */
	attestation(): readonly { index: number; address: string; xpubFingerprint: string }[] {
		return (
			this.db
				.prepare(`SELECT idx, address, xpub_fp FROM evm_address_index ORDER BY idx`)
				.all() as Raw[]
		).map((r) => ({ index: r.idx, address: r.address, xpubFingerprint: r.xpub_fp }));
	}
}
