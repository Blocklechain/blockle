// -----------------------------------------------------------------------------
// THE DEPOSIT WATCHER — the rail that was missing.
//
// Until this existed, a customer's coins could arrive in custody and never be
// credited to them. The books would not know, the site would look perfect, and
// the only symptom would be a support ticket saying "where is my deposit". It
// is the single worst state a custodial venue can be in, which is why the
// go-live preflight refuses to open the gate without this runner reporting.
//
// WHAT IT DOES. Polls BitGo's incoming transfers for each pooled wallet, maps
// each credited ADDRESS to the customer it was issued to, and posts a deposit
// to the ledger once the transfer is deep enough.
//
// THE FOUR RULES IT IS BUILT ON:
//
// 1. CREDIT EXACTLY ONCE. The ledger's idempotency key is derived from BitGo's
//    transfer id and the address, so a replayed feed — which is the normal case,
//    since every poll re-reads recent transfers — credits nothing twice.
//
// 2. WAIT FOR CONFIRMATIONS. A deposit credited early is a deposit a reorg can
//    take back, after the customer has traded or withdrawn it. The venue, not
//    the customer, is short at that point. Thresholds are per chain and err
//    long; see bitgodeposits.ts.
//
// 3. AN UNATTRIBUTABLE DEPOSIT IS QUARANTINED, NEVER GUESSED AND NEVER
//    DROPPED. Money arriving at an address we did not issue is still money we
//    now hold: ignoring it leaves custody above the books (a surplus that masks
//    a shortfall), and guessing an owner credits the wrong person. It is booked
//    to an UNATTRIBUTED holding so reconciliation stays exact, and surfaced for
//    an operator to resolve.
//
// 4. CUSTODY AND THE CUSTOMER MOVE TOGETHER. One transaction credits the
//    customer's balance AND the chain-specific custody holding, because the
//    ledger's invariant is that a liability is backed. A deposit that credited
//    only the customer would be an instant, permanent shortfall.
//
// WHAT IT DELIBERATELY DOES NOT DO: decide anything about a transfer it cannot
// read. A malformed amount, a missing address, a transfer whose per-address
// credits do not sum to its total — each is left uncredited and reported, not
// patched up with an assumption. Everything in this file would rather stop than
// be approximately right about somebody's money.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { assetDef, custodyIds, networkOf, qualify, settlementAsset } from "./assets";
import { confirmationsFor, type BitGoDeposits, type IncomingTransfer } from "./bitgodeposits";
import type { ChainAdapter } from "./chains";
import { Deposits } from "./deposits";
import { beat } from "./golive";
import { AccountKind, Reason, type Ledger } from "./ledger";

export class WatcherError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WatcherError";
	}
}

export const SCHEMA = `
-- Every transfer the watcher has SEEN, credited or not, with why.
--
-- Separate from the ledger on purpose: the ledger records money that moved,
-- this records what the custodian told us and what we concluded. A deposit
-- held back for confirmations has a row here and no ledger entry, which is
-- exactly the state a customer asking "where is my deposit" needs explained.
CREATE TABLE IF NOT EXISTS deposit_seen (
  transfer_id TEXT NOT NULL,
  address     TEXT NOT NULL,
  asset       TEXT NOT NULL,
  network     TEXT NOT NULL,
  amount      TEXT NOT NULL,
  txid        TEXT,
  confirmations INTEGER NOT NULL,
  -- 'credited' | 'pending' | 'unattributed' | 'unreadable' | 'disappeared'
  --
  -- 'disappeared' is the only one of these that is written by something other
  -- than a crediting decision. See expireVanishedPending: a transaction can be
  -- seen, recorded 'pending', and then leave the chain entirely — dropped from
  -- a mempool, or replaced by a higher fee — at which point the row would
  -- otherwise read "N of 32 confirmations" forever. That is rare on a
  -- custodian's feed and routine on EVM.
  outcome     TEXT NOT NULL,
  user_id     TEXT,
  detail      TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  credited_at TEXT,
  PRIMARY KEY (transfer_id, address)
);

CREATE INDEX IF NOT EXISTS idx_deposit_seen_outcome ON deposit_seen(outcome);
CREATE INDEX IF NOT EXISTS idx_deposit_seen_user ON deposit_seen(user_id);
`;

export interface WatcherResult {
	readonly scanned: number;
	readonly credited: number;
	readonly pending: number;
	readonly unattributed: number;
	readonly unreadable: number;
	/**
	 * Pending rows written off because their transaction left the chain.
	 *
	 * Reported rather than merely counted: it is the only visible signal that a
	 * chain is dropping or replacing transactions, and a rail that starts
	 * producing these every pass is a rail whose feed or confirmation policy
	 * needs looking at.
	 */
	readonly disappeared: number;
	readonly errors: readonly string[];
}

/**
 * HOW LONG A PENDING ROW MAY GO UNMENTIONED BEFORE IT IS WRITTEN OFF, PER
 * CHAIN — and why it is per chain rather than one constant.
 *
 * A transaction can be seen, recorded `pending`, and then leave the chain
 * entirely: dropped from a mempool, or replaced by a higher-fee version of
 * itself. The row would otherwise read "3 of 32 confirmations" forever, which
 * is the single most alarming thing a customer can be shown about money they
 * sent, and it is not true.
 *
 * The threshold cannot be shared, because "the feed stopped mentioning it" is
 * evidence at wildly different speeds: a custodian's feed pages over a window
 * measured in days, while an EVM scanner re-reads a handful of blocks and a
 * dropped transaction is absent within a minute. Set it too low on a slow feed
 * and a live deposit is written off while it is still confirming.
 *
 * NOTHING HERE MOVES MONEY. `disappeared` is a statement about a RECORD, not a
 * reversal: a pending row has no ledger entry behind it by construction, so
 * writing it off posts nothing. If the transaction comes back, the next pass
 * records it again under the same (transfer_id, address) primary key and it
 * confirms normally.
 */
export interface VanishPolicy {
	/** Seconds a pending row may go unmentioned by a feed that DID answer. */
	readonly staleSeconds: number;
}

/**
 * Write off the pending rows of one chain whose transaction the feed no longer
 * mentions. Returns how many were written off.
 *
 * SAFE ONLY BECAUSE OF TWO CONDITIONS THE CALLER ENFORCES, both worth stating
 * where the UPDATE is:
 *
 *   1. The feed for this chain ANSWERED this pass. "The feed did not mention
 *      it" is evidence; "the feed did not answer" is nothing at all, and
 *      treating them alike would write off every in-flight deposit on a chain
 *      during an endpoint outage.
 *   2. `seen` is complete for the whole pass before this is called, because one
 *      transfer can pay two of our addresses and both rows must be spared.
 *
 * A `credited` row is never touched: the WHERE clause names `pending` only, so
 * a chain whose feed forgets a credited deposit cannot un-credit it.
 */
export function expireVanishedPending(
	db: Database,
	args: {
		custodyId: string;
		staleSeconds: number;
		/** `${custodyId}\u0000${transferId}` for every transfer seen this pass. */
		seen: ReadonlySet<string>;
		nowMs: number;
	},
): number {
	const asset = settlementAsset(args.custodyId);
	const network = networkOf(args.custodyId) ?? "";
	const rows = db
		.prepare(
			`SELECT transfer_id, address, last_seen FROM deposit_seen
			  WHERE outcome = 'pending' AND asset = ? AND network = ?`,
		)
		.all(asset, network) as {
		transfer_id: string;
		address: string;
		last_seen: string;
	}[];

	const cutoff = args.nowMs - Math.max(0, args.staleSeconds) * 1000;
	const mark = db.prepare(
		`UPDATE deposit_seen
		    SET outcome = 'disappeared', last_seen = ?, detail = ?
		  WHERE transfer_id = ? AND address = ? AND outcome = 'pending'`,
	);
	let n = 0;
	for (const r of rows) {
		if (args.seen.has(`${args.custodyId}\u0000${r.transfer_id}`)) continue;
		const last = Date.parse(r.last_seen);
		// AN UNPARSEABLE TIMESTAMP IS LEFT ALONE. It cannot be shown to be
		// stale, and writing off a row on a date we could not read would be
		// deciding about a customer's deposit from a field we do not trust.
		if (!Number.isFinite(last) || last > cutoff) continue;
		mark.run(
			new Date(args.nowMs).toISOString(),
			`the ${args.custodyId} feed answered and no longer reports this ` +
				`transaction, and it has not been seen for ${args.staleSeconds}s. ` +
				"It was dropped or replaced before confirming. Nothing was credited " +
				"and nothing is owed; a new transaction would be recorded afresh.",
			r.transfer_id,
			r.address,
		);
		n++;
	}
	return n;
}

export interface WatcherDeps {
	readonly db: Database;
	readonly ledger: Ledger;
	readonly client: BitGoDeposits;
	/**
	 * Resolve a custody id to the pooled wallet that holds it.
	 *
	 * Injected because the wallet scope lives in the holdings adapter's
	 * configuration, and a watcher that picked its own wallet could poll one
	 * the exchange does not own.
	 */
	readonly walletFor: (custodyId: string) => Promise<{ coin: string; walletId: string } | undefined>;
	/**
	 * Chains we watch ourselves, keyed by CUSTODY ID.
	 *
	 * BitGo will not custody the small proof-of-work coins, so their deposits
	 * arrive at a daemon we run and have to be read from it. Without this the
	 * address and payout paths were wired for those coins while the crediting
	 * path was not — an address a customer could deposit to and a deposit
	 * nothing would ever credit.
	 *
	 * Absent means BitGo for everything, which is the old behaviour exactly.
	 *
	 * KEYED BY CUSTODY ID, NOT BY SETTLEMENT ASSET, AND THE DIFFERENCE IS A
	 * LATENT MIS-POSTING THAT WOULD HAVE SURFACED ON THE FIRST TOKEN RAIL.
	 *
	 * This map used to be keyed by settlement asset and read with
	 * `nodeFeeds.get(asset)` from inside the loop below — a loop that iterates
	 * every CHAIN-QUALIFIED custody id of each asset, of which USDT has four.
	 * So a single self-custodied USDT adapter would have been polled four
	 * times, once per network, each pass attributing its rows to whichever
	 * network the loop happened to be on. The ledger's replay check would have
	 * prevented a double credit, because the idempotency key is identical
	 * across those four passes — so nothing would have looked broken. But the
	 * CUSTODY posting lands under whichever network ran FIRST, which means an
	 * ERC-20 deposit booked as TRC-20 inventory: reconciliation still balances
	 * in total while every per-network figure is wrong, and the per-network
	 * figures are what a shortfall is measured against. `deposit_seen`'s
	 * (transfer_id, address) primary key would have collided across networks
	 * for the same reason.
	 *
	 * It was harmless ONLY because no token has ever been node-fed: every
	 * current entry is a single-chain native coin, where the custody id and the
	 * settlement asset are the same string, so this change moves no existing
	 * rail. It is fixed now rather than when the first token rail is built,
	 * because a defect that costs nothing today and corrupts inventory the day
	 * someone adds a token is exactly the kind that gets discovered by the
	 * reconciler halting a healthy asset.
	 */
	readonly nodeFeeds?: ReadonlyMap<string, ChainAdapter>;
	/**
	 * PER-CHAIN WRITE-OFF POLICY FOR PENDING ROWS WHOSE TRANSACTION IS GONE.
	 *
	 * Keyed by CUSTODY ID, like `nodeFeeds`, so a token rail cannot inherit its
	 * chain's threshold by accident. Absent — the default — means no row is
	 * ever written off, which is the behaviour every live rail has today: an
	 * opt-in per chain whose feed's forgetting speed has actually been
	 * measured. See `VanishPolicy` for why one shared constant cannot work.
	 */
	readonly vanishPolicy?: ReadonlyMap<string, VanishPolicy>;
	readonly assets: readonly string[];
	readonly now?: () => number;
	/** Per-poll page size. */
	readonly limit?: number;
}

/**
 * Read a node's arrivals in the shape the crediting loop already consumes.
 *
 * ONE CREDIT PER TRANSFER here, unlike BitGo, whose transfer can credit
 * several addresses at once. A daemon reports per (txid, address) already, so
 * the mapping is one-to-one — and the idempotency key downstream is
 * `deposit:<transferId>:<address>`, which stays unique as long as the
 * transfer id carries the address. It does: the id is the txid, and a txid
 * paying two of our addresses yields two rows with different addresses.
 *
 * EXCEPT ON EVM, WHERE THAT LAST SENTENCE IS FALSE TWICE OVER — WHICH IS WHAT
 * `ref` IS FOR.
 *
 * One EVM transaction can pay the SAME address more than once through internal
 * calls, and one can emit several ERC-20 Transfer events to the same address.
 * Both produce two arrivals sharing a (txid, address) pair, so the second one
 * would be swallowed by the ledger's replay check and the customer
 * under-credited WITH NO ERROR ANYWHERE. And the same secp256k1 address
 * receives on Ethereum, BSC and Polygon by construction, so (txid, address) is
 * not unique across chains either.
 *
 * So an adapter that knows its arrivals need a finer identity sets `ref` to a
 * chain-qualified one, and THAT becomes the transfer id — which makes both the
 * ledger's idempotency key and `deposit_seen`'s (transfer_id, address) primary
 * key unique, with no migration and no second code path.
 *
 * WHY THE OLD SPELLING IS KEPT WHEN `ref` IS ABSENT, RATHER THAN SWITCHING
 * EVERYTHING TO THE BETTER KEY: the idempotency key is what stops a deposit
 * being paid twice. Changing it for the rails already live would mean every
 * already-credited deposit still inside the custodian's recent window arriving
 * under a NEW key, unrecognised by the ledger's replay check, and credited a
 * second time. On a live mainnet venue. The better key therefore applies only
 * where a rail asks for it.
 */
async function nodeTransfers(
	adapter: ChainAdapter,
): Promise<{ transfers: IncomingTransfer[]; nextPrevId: string | undefined }> {
	const rows = await adapter.incoming();
	return {
		transfers: rows.map((r): IncomingTransfer => ({
			id: r.ref ?? r.txid,
			txid: r.txid,
			coin: adapter.symbol.toLowerCase(),
			// The daemon reports a confirmation depth, not a wall-clock time.
			// This field is for display only; inventing a timestamp would make
			// a deposit look like it arrived when we happened to poll.
			createdAt: "",
			// A daemon reports what it has accepted; anything it has rejected
			// is simply absent, so there is no "failed" state to filter.
			state: "confirmed",
			confirmations: r.confirmations,
			total: r.amount,
			credits: [{ address: r.address, amount: r.amount }],
		})),
		nextPrevId: undefined,
	};
}

/**
 * The account unattributable deposits are parked in.
 *
 * A USER account owned by a reserved id rather than a new AccountKind, so it is
 * covered by the ledger's existing invariants and shows up in reconciliation
 * without any special casing. Nobody can sign in as it.
 */
export const UNATTRIBUTED = "__unattributed__";

export async function runOnce(deps: WatcherDeps): Promise<WatcherResult> {
	deps.db.exec(SCHEMA);
	const now = (deps.now ?? (() => Date.now()))();
	const stamp = new Date(now).toISOString();
	const deposits = new Deposits(deps.db);

	let scanned = 0;
	let credited = 0;
	let pending = 0;
	let unattributed = 0;
	let unreadable = 0;
	let disappeared = 0;
	const errors: string[] = [];

	/*
	 * WHAT THIS PASS ACTUALLY SAW, and which chains answered at all.
	 *
	 * Both are inputs to `expireVanishedPending`, and the second one is the
	 * reason it is safe. A feed that throws leaves its chain OUT of
	 * `feedReadThisPass`, so none of its pending rows are judged — because the
	 * evidence that a transaction has left the chain is "the feed answered and
	 * did not mention it", and a feed that did not answer is not evidence of
	 * anything. Without that distinction a two-hour endpoint outage would mark
	 * every in-flight deposit on that chain as having vanished.
	 */
	const seenThisPass = new Set<string>();
	const feedReadThisPass = new Set<string>();

	// Every chain-qualified custody id across the listed assets. USDT has four.
	const chains: string[] = [];
	for (const a of deps.assets) {
		try {
			for (const id of custodyIds(a)) chains.push(id);
		} catch (e) {
			errors.push(`${a}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	for (const custodyId of chains) {
		const asset = settlementAsset(custodyId);
		const network = networkOf(custodyId);

		/*
		 * WHO REPORTS THIS COIN'S ARRIVALS? A daemon we run, or BitGo.
		 *
		 * Resolved before the wallet lookup, because a node-custodied coin has
		 * no custodian wallet and asking for one would skip it entirely —
		 * which is exactly the bug this fixes.
		 *
		 * BY CUSTODY ID, which is the loop variable rather than the settlement
		 * asset derived from it. See `WatcherDeps.nodeFeeds` for the mis-posting
		 * the old `get(asset)` would have produced the day a token rail was
		 * node-fed. For every feed that exists today the two strings are
		 * identical, so this is a no-op on the live rails and a correctness fix
		 * for the next one.
		 */
		const node = deps.nodeFeeds?.get(custodyId);

		let wallet: { coin: string; walletId: string } | undefined =
			node === undefined ? undefined : { coin: asset, walletId: "node" };
		if (node !== undefined) {
			// The daemon is the wallet; the fields above are placeholders the
			// node path ignores.
		} else {
		try {
			wallet = await deps.walletFor(custodyId);
		} catch (e) {
			errors.push(
				`${custodyId}: cannot resolve a wallet (${
					e instanceof Error ? e.message : String(e)
				})`,
			);
			continue;
		}
		}
		if (wallet === undefined) {
			// Not an error worth shouting about on every poll: a listed asset
			// with no wallet yet is already a preflight failure.
			continue;
		}

		let page: { transfers: IncomingTransfer[]; nextPrevId: string | undefined };
		try {
			page = node === undefined
				? await deps.client.incomingTransfers({
						coin: wallet.coin,
						walletId: wallet.walletId,
						...(deps.limit === undefined ? {} : { limit: deps.limit }),
					})
				: await nodeTransfers(node);
		} catch (e) {
			// A CUSTODIAN OUTAGE IS NOT A DEPOSIT DECISION. Nothing is credited
			// and nothing is marked; the next poll tries again. Same for a
			// daemon that will not answer.
			errors.push(
				`${custodyId}: transfer feed unavailable (${
					e instanceof Error ? e.message : String(e)
				})`,
			);
			continue;
		}
		feedReadThisPass.add(custodyId);

		const needed = confirmationsFor(asset, network);

		for (const t of page.transfers) {
			seenThisPass.add(`${custodyId}\u0000${t.id}`);
			// A transfer BitGo itself calls failed or removed is not a deposit.
			if (t.state === "failed" || t.state === "removed") continue;

			if (t.credits.length === 0) {
				scanned++;
				unreadable++;
				record(deps.db, {
					transferId: t.id,
					address: "(none)",
					asset,
					network: network ?? "",
					amount: t.total,
					txid: t.txid,
					confirmations: t.confirmations,
					outcome: "unreadable",
					userId: null,
					detail:
						"the transfer credited no readable address — BitGo reported no " +
						"usable entries, so there is nothing to attribute it to",
					stamp,
				});
				continue;
			}

			for (const c of t.credits) {
				scanned++;

				// WHO DOES THIS ADDRESS BELONG TO? The whole point of per-user
				// receive addresses on a pooled wallet.
				const owner = deposits.ownerOfAddress(c.address, asset, network);

				if (t.confirmations < needed) {
					pending++;
					record(deps.db, {
						transferId: t.id,
						address: c.address,
						asset,
						network: network ?? "",
						amount: c.amount,
						txid: t.txid,
						confirmations: t.confirmations,
						outcome: "pending",
						userId: owner ?? null,
						detail: `${t.confirmations} of ${needed} confirmations`,
						stamp,
					});
					continue;
				}

				const target = owner ?? UNATTRIBUTED;
				if (owner === undefined) unattributed++;

				try {
					// CREDIT ONCE. Keyed on BitGo's transfer id and the address, so
					// the same arrival seen on every poll posts a single time.
					const qualified = network === undefined ? asset : qualify(asset, network);
					deps.ledger.post({
						reason: Reason.DEPOSIT,
						postings: [
							{
								account: { kind: AccountKind.EXTERNAL, owner: "", asset: qualified },
								delta: -c.amount,
							},
							{
								account: { kind: AccountKind.CUSTODY, owner: "", asset: qualified },
								delta: c.amount,
							},
							// The customer's balance is in the FUNGIBLE asset: a
							// deposit on any chain credits one USDT balance.
							{
								account: { kind: AccountKind.USER, owner: target, asset },
								delta: c.amount,
							},
							{
								account: { kind: AccountKind.EXTERNAL, owner: "", asset: qualified },
								delta: -c.amount,
							},
						],
						idempotencyKey: `deposit:${t.id}:${c.address}`,
						actor: "deposit-watcher",
						...(owner === undefined
							? {
									note:
										`UNATTRIBUTED: ${c.address} was not issued to any ` +
										"account. Parked pending investigation.",
								}
							: {}),
					});
					credited++;
					record(deps.db, {
						transferId: t.id,
						address: c.address,
						asset,
						network: network ?? "",
						amount: c.amount,
						txid: t.txid,
						confirmations: t.confirmations,
						outcome: owner === undefined ? "unattributed" : "credited",
						userId: owner ?? null,
						detail:
							owner === undefined
								? "credited to the unattributed holding — custody and the " +
									"books agree, but nobody owns it yet"
								: null,
						stamp,
						creditedAt: stamp,
					});
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e);
					// An already-posted transfer is the normal case on a re-poll;
					// the ledger returns the existing tx rather than throwing, so
					// reaching here means something else went wrong.
					errors.push(`${custodyId} transfer ${t.id}: ${why}`);
					record(deps.db, {
						transferId: t.id,
						address: c.address,
						asset,
						network: network ?? "",
						amount: c.amount,
						txid: t.txid,
						confirmations: t.confirmations,
						outcome: "unreadable",
						userId: owner ?? null,
						detail: `posting failed: ${why.slice(0, 200)}`,
						stamp,
					});
				}
			}
		}
	}

	/*
	 * PENDING ROWS WHOSE TRANSACTION HAS LEFT THE CHAIN.
	 *
	 * Run after the whole pass rather than inside the per-chain loop, because
	 * `seenThisPass` has to be complete first: a transfer paying two of our
	 * addresses touches two rows, and a chain whose feed failed must not have its
	 * rows judged at all.
	 */
	for (const [custodyId, policy] of deps.vanishPolicy ?? []) {
		if (!feedReadThisPass.has(custodyId)) continue;
		disappeared += expireVanishedPending(deps.db, {
			custodyId,
			staleSeconds: policy.staleSeconds,
			seen: seenThisPass,
			nowMs: now,
		});
	}

	// THE HEARTBEAT IS THE LAST THING. Written only after a full pass, so a
	// runner that dies mid-cycle does not report itself healthy — which is the
	// whole reason the preflight reads heartbeats rather than unit state.
	beat(
		deps.db,
		"deposit-watcher",
		`${scanned} seen, ${credited} credited, ${pending} pending, ` +
			`${unattributed} unattributed` +
			(disappeared > 0 ? `, ${disappeared} disappeared` : "") +
			(errors.length > 0 ? `, ${errors.length} error(s)` : ""),
	);

	return {
		scanned,
		credited,
		pending,
		unattributed,
		unreadable,
		disappeared,
		errors,
	};
}

function record(
	db: Database,
	r: {
		transferId: string;
		address: string;
		asset: string;
		network: string;
		amount: bigint;
		txid: string;
		confirmations: number;
		outcome: string;
		userId: string | null;
		detail: string | null;
		stamp: string;
		creditedAt?: string;
	},
): void {
	db.prepare(
		`INSERT INTO deposit_seen
		   (transfer_id, address, asset, network, amount, txid, confirmations,
		    outcome, user_id, detail, first_seen, last_seen, credited_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(transfer_id, address) DO UPDATE SET
		   confirmations = excluded.confirmations,
		   last_seen     = excluded.last_seen,
		   -- A CREDITED ROW IS NEVER DOWNGRADED. A later poll seeing fewer
		   -- confirmations (a node lagging, a reorg in progress) must not turn
		   -- "credited" back into "pending": the money is already in the
		   -- customer's balance, and only a deliberate correction reverses that.
		   outcome   = CASE WHEN deposit_seen.outcome = 'credited'
		                    THEN 'credited' ELSE excluded.outcome END,
		   user_id   = COALESCE(deposit_seen.user_id, excluded.user_id),
		   detail    = excluded.detail,
		   credited_at = COALESCE(deposit_seen.credited_at, excluded.credited_at)`,
	).run(
		r.transferId,
		r.address,
		r.asset,
		r.network,
		r.amount.toString(),
		r.txid,
		r.confirmations,
		r.outcome,
		r.userId,
		r.detail,
		r.stamp,
		r.stamp,
		r.creditedAt ?? null,
	);
}

/**
 * A customer's deposits in flight, for the deposit screen.
 *
 * This is what makes "where is my deposit" answerable without an operator:
 * the row exists from the first time the custodian mentions the transfer, so a
 * deposit waiting for confirmations can be shown as waiting, with how many
 * more.
 */
export function depositsFor(
	db: Database,
	userId: string,
	limit = 25,
): readonly {
	asset: string;
	network: string | null;
	amount: string;
	txid: string;
	confirmations: number;
	outcome: string;
	detail: string | null;
	firstSeen: string;
}[] {
	db.exec(SCHEMA);
	const rows = db
		.prepare(
			`SELECT asset, network, amount, txid, confirmations, outcome, detail, first_seen
			   FROM deposit_seen WHERE user_id = ?
			  ORDER BY first_seen DESC LIMIT ?`,
		)
		.all(userId, limit) as {
		asset: string;
		network: string;
		amount: string;
		txid: string;
		confirmations: number;
		outcome: string;
		detail: string | null;
		first_seen: string;
	}[];
	return rows.map((r) => ({
		asset: r.asset,
		network: r.network === "" ? null : r.network,
		amount: formatFor(r.asset, r.amount),
		txid: r.txid,
		confirmations: r.confirmations,
		outcome: r.outcome,
		detail: r.detail,
		firstSeen: r.first_seen,
	}));
}

/** Deposits nobody owns, for the admin console. */
export function unattributedDeposits(
	db: Database,
): readonly {
	transferId: string;
	address: string;
	asset: string;
	network: string | null;
	amount: string;
	txid: string;
	firstSeen: string;
}[] {
	db.exec(SCHEMA);
	const rows = db
		.prepare(
			`SELECT transfer_id, address, asset, network, amount, txid, first_seen
			   FROM deposit_seen WHERE outcome IN ('unattributed', 'unreadable')
			  ORDER BY first_seen DESC LIMIT 200`,
		)
		.all() as {
		transfer_id: string;
		address: string;
		asset: string;
		network: string;
		amount: string;
		txid: string;
		first_seen: string;
	}[];
	return rows.map((r) => ({
		transferId: r.transfer_id,
		address: r.address,
		asset: r.asset,
		network: r.network === "" ? null : r.network,
		amount: formatFor(r.asset, r.amount),
		txid: r.txid,
		firstSeen: r.first_seen,
	}));
}

/** Base units to a decimal string, tolerant of an asset that has been delisted. */
function formatFor(asset: string, base: string): string {
	let decimals = 0;
	try {
		decimals = assetDef(asset).decimals;
	} catch {
		return base;
	}
	const neg = base.startsWith("-");
	const digits = (neg ? base.slice(1) : base).padStart(decimals + 1, "0");
	const whole = digits.slice(0, digits.length - decimals) || "0";
	const frac = decimals === 0 ? "" : digits.slice(digits.length - decimals);
	const trimmed = frac.replace(/0+$/, "");
	return (neg ? "-" : "") + whole + (trimmed === "" ? "" : "." + trimmed);
}
