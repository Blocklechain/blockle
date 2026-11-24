// -----------------------------------------------------------------------------
// THE PAYOUT RUNNER — the other half of the rail.
//
// Withdrawals are auto-approved by policy, and until now nothing picked them up
// afterwards. A customer's balance was debited, moved to INFLIGHT, marked
// APPROVED — and sat there. They had neither funds nor payment, which is worse
// than a refusal, because a refusal at least tells them to try something else.
//
// THREE PHASES, in this order, every pass:
//
//   1. APPROVED  -> send, then markSubmitted with BitGo's transfer id.
//   2. SUBMITTED -> if confirmed deeply enough, settle: INFLIGHT and custody
//                   fall, and the gas is journalled against the venue's own
//                   float in the GAS asset.
//   3. SUBMITTED -> if BitGo itself says the transfer failed or was removed,
//                   reverse the debit so the customer gets their balance back.
//
// WHY THE ORDER MATTERS: sending first means a withdrawal approved this minute
// goes out this minute rather than waiting a cycle, and settlement is cheap
// (one read per in-flight payout). Phase 3 is last because it is the only one
// that undoes anything, and it must only ever act on BitGo's own assertion.
//
// THE RULE THE WHOLE FILE IS BUILT ON: "I DO NOT KNOW" NEVER RESOLVES TO
// "SEND IT AGAIN". A timeout, an unreadable response, an ambiguous duplicate —
// every one of those leaves the withdrawal exactly where it is and reports.
// The deterministic sequence id (see bitgopayouts.ts) makes that safe, because
// the next pass can ask BitGo whether the send already happened instead of
// guessing.
//
// AND IT WILL NOT SETTLE ON SIGHT. A payout is settled only once it is deep
// enough that a reorg cannot take it back, using the same per-chain thresholds
// as deposits. Settling early releases our custody holding for coins that may
// come back.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import { gasAssetFor, networkOf, settlementAsset } from "./assets";
import { confirmationsFor } from "./bitgodeposits";
import { BitGoPayouts } from "./bitgopayouts";
import { beat } from "./golive";
import type { Ledger } from "./ledger";
import { State, type Withdrawal, type Withdrawals } from "./withdrawals";

export const SCHEMA = `
-- What the runner attempted, and what came back. Separate from the withdrawal
-- row because that holds the venue's STATE while this holds the custodian's
-- story — and when a payout goes wrong, the difference between the two is the
-- investigation.
CREATE TABLE IF NOT EXISTS payout_attempt (
  -- AN APPEND-ONLY LOG, keyed on nothing but its own order.
  --
  -- The first version keyed on (withdrawal_id, attempt_at) with an
  -- INSERT OR REPLACE. Two attempts in the same millisecond — a send and a
  -- settle in one fast pass, which is the normal case — collided, so the
  -- "sent" row was overwritten by "settled" and the timeline that support
  -- actually needs disappeared. Found by a test asserting the history had two
  -- entries and getting one.
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  withdrawal_id INTEGER NOT NULL,
  sequence_id   TEXT    NOT NULL,
  attempt_at    TEXT    NOT NULL,
  -- 'sent' | 'recovered' | 'refused' | 'error' | 'settled' | 'failed'
  outcome       TEXT    NOT NULL,
  transfer_id   TEXT,
  txid          TEXT,
  detail        TEXT
);

CREATE INDEX IF NOT EXISTS idx_payout_attempt_wd ON payout_attempt(withdrawal_id);
`;

export interface PayoutResult {
	readonly sent: number;
	readonly recovered: number;
	readonly settled: number;
	readonly failed: number;
	readonly waiting: number;
	readonly refused: number;
	readonly errors: readonly string[];
}

export interface PayoutDeps {
	readonly db: Database;
	readonly ledger: Ledger;
	readonly withdrawals: Withdrawals;
	readonly client: BitGoPayouts;
	readonly walletFor: (
		custodyId: string,
	) => Promise<{ coin: string; walletId: string } | undefined>;
	readonly now?: () => number;
	/** Cap per pass, so one bad chain cannot starve the rest. */
	readonly maxPerPass?: number;
}

export async function runOnce(deps: PayoutDeps): Promise<PayoutResult> {
	deps.db.exec(SCHEMA);
	const stamp = new Date((deps.now ?? (() => Date.now()))()).toISOString();

	let sent = 0;
	let recovered = 0;
	let settled = 0;
	let failed = 0;
	let waiting = 0;
	let refused = 0;
	const errors: string[] = [];

	const cap = deps.maxPerPass ?? 25;
	const all = deps.withdrawals.pending();
	const approved = all.filter((w) => w.state === State.APPROVED).slice(0, cap);
	const submitted = all.filter((w) => w.state === State.SUBMITTED).slice(0, cap);

	/*
	 * NO PASSPHRASE IS A LOUD REFUSAL, NOT A QUIET IDLE PASS.
	 *
	 * Customers' balances are already debited and sitting in INFLIGHT. A runner
	 * that shrugs and reports success would leave them stranded while every
	 * dashboard looked green, which is the exact failure mode the heartbeat
	 * exists to prevent — so the heartbeat says so too.
	 */
	if (approved.length > 0 && !deps.client.canSend) {
		const why =
			`${approved.length} withdrawal(s) are approved and cannot be sent: no ` +
			"signing passphrase is configured (BITGO_WALLET_PASSPHRASE). Customer " +
			"funds are debited and waiting.";
		errors.push(why);
		refused = approved.length;
		for (const w of approved) {
			record(deps.db, w.id, BitGoPayouts.sequenceId(w.id), stamp, "refused", null, null, why);
		}
		beat(deps.db, "payout-runner", `REFUSED: ${why}`);
		return { sent, recovered, settled, failed, waiting, refused, errors };
	}

	// ---- phase 1: send ----------------------------------------------------

	for (const w of approved) {
		const custodyId = w.network === undefined ? w.asset : `${w.asset}.${w.network}`;
		const seq = BitGoPayouts.sequenceId(w.id);

		let wallet: { coin: string; walletId: string } | undefined;
		try {
			wallet = await deps.walletFor(custodyId);
		} catch (e) {
			errors.push(`wd ${w.id}: cannot resolve a wallet: ${msg(e)}`);
			continue;
		}
		if (wallet === undefined) {
			errors.push(
				`wd ${w.id}: no exchange wallet for ${custodyId}, so this payout ` +
					"cannot be sent. The customer is debited and waiting.",
			);
			continue;
		}

		/*
		 * ASK BEFORE SENDING. If a previous pass sent this and died before
		 * recording the reference, the transfer is already out there under this
		 * same sequence id — and sending again would pay the customer twice.
		 *
		 * A failure to ask is a reason NOT to send. "I could not check" must
		 * never read as "nothing is there".
		 */
		try {
			const existing = await deps.client.findBySequenceId({
				coin: wallet.coin,
				walletId: wallet.walletId,
				sequenceId: seq,
			});
			if (existing !== undefined) {
				deps.withdrawals.markSubmitted(w.id, existing.id, "payout-runner");
				recovered++;
				record(deps.db, w.id, seq, stamp, "recovered", existing.id, existing.txid,
					"a transfer already existed under this sequence id — recovered " +
						"rather than sent again");
				continue;
			}
		} catch (e) {
			errors.push(
				`wd ${w.id}: could not check whether it was already sent (${msg(e)}) — ` +
					"NOT sending, to rule out a double payment",
			);
			record(deps.db, w.id, seq, stamp, "error", null, null, `precheck failed: ${msg(e)}`);
			continue;
		}

		try {
			const { transfer, alreadySent } = await deps.client.send({
				coin: wallet.coin,
				walletId: wallet.walletId,
				address: w.address,
				// THE NET, not the gross. The fee was withheld at request time
				// and never leaves custody.
				amount: w.net,
				sequenceId: seq,
				comment: `blockle withdrawal ${w.id}`,
			});
			deps.withdrawals.markSubmitted(w.id, transfer.id, "payout-runner");
			if (alreadySent) {
				recovered++;
				record(deps.db, w.id, seq, stamp, "recovered", transfer.id, transfer.txid,
					"BitGo reported the sequence id as already used");
			} else {
				sent++;
				record(deps.db, w.id, seq, stamp, "sent", transfer.id, transfer.txid, null);
			}
		} catch (e) {
			// LEFT IN APPROVED. The next pass's sequence-id check decides
			// whether it went out, which is the only safe way to find out.
			errors.push(`wd ${w.id}: send failed: ${msg(e)}`);
			record(deps.db, w.id, seq, stamp, "error", null, null, `send failed: ${msg(e)}`);
		}
	}

	// ---- phases 2 and 3: settle, or reverse on the custodian's word -------

	for (const w of submitted) {
		if (w.providerRef === undefined || w.providerRef === "") {
			// Should be unreachable: markSubmitted requires a reference.
			errors.push(`wd ${w.id}: submitted with no provider reference`);
			continue;
		}
		const custodyId = w.network === undefined ? w.asset : `${w.asset}.${w.network}`;
		let wallet: { coin: string; walletId: string } | undefined;
		try {
			wallet = await deps.walletFor(custodyId);
		} catch (e) {
			errors.push(`wd ${w.id}: ${msg(e)}`);
			continue;
		}
		if (wallet === undefined) continue;

		let t;
		try {
			t = await deps.client.transfer({
				coin: wallet.coin,
				walletId: wallet.walletId,
				transferId: w.providerRef,
			});
		} catch (e) {
			// An outage is not a settlement decision.
			errors.push(`wd ${w.id}: cannot read transfer ${w.providerRef}: ${msg(e)}`);
			continue;
		}

		if (t.state === "failed" || t.state === "removed") {
			/*
			 * THE ONLY GROUND FOR REVERSING A DEBIT: the custodian's own
			 * statement that the transfer did not and will not go out. Never a
			 * timeout, never an inference — a reversal on a guess refunds a
			 * customer who is also being paid on chain.
			 */
			try {
				deps.withdrawals.fail(
					w.id,
					"payout-runner",
					`BitGo reports transfer ${w.providerRef} as ${t.state}`,
				);
				failed++;
				record(deps.db, w.id, BitGoPayouts.sequenceId(w.id), stamp, "failed",
					t.id, t.txid, `custodian reported ${t.state}; debit reversed`);
			} catch (e) {
				errors.push(`wd ${w.id}: could not reverse: ${msg(e)}`);
			}
			continue;
		}

		const needed = confirmationsFor(settlementAsset(w.asset), w.network);
		if (t.confirmations < needed) {
			waiting++;
			continue;
		}

		try {
			/*
			 * THE GAS FEE IS IN THE GAS ASSET, and `confirm` books it there.
			 * For an ERC-20 payout BitGo reports the fee in ETH; charging it to
			 * the token would invent a token shortfall that no on-chain event
			 * matches, and a shortfall halts withdrawals of that asset.
			 */
			deps.withdrawals.confirm(w.id, "payout-runner", t.feeBaseUnits);
			settled++;
			record(deps.db, w.id, BitGoPayouts.sequenceId(w.id), stamp, "settled",
				t.id, t.txid,
				`${t.confirmations} confirmations; fee ${t.feeBaseUnits} ` +
					gasAssetFor(settlementAsset(w.asset), w.network));
		} catch (e) {
			// A settlement that will not post is serious: the coins are gone and
			// the books still show them. Reported, never retried blindly.
			errors.push(
				`wd ${w.id}: SENT BUT NOT SETTLED — ${msg(e)}. The payout is on ` +
					"chain and the books still hold it in INFLIGHT; reconciliation " +
					"will show the gap until this is resolved.",
			);
			record(deps.db, w.id, BitGoPayouts.sequenceId(w.id), stamp, "error",
				t.id, t.txid, `settle failed: ${msg(e)}`);
		}
	}

	beat(
		deps.db,
		"payout-runner",
		`${sent} sent, ${recovered} recovered, ${settled} settled, ` +
			`${failed} reversed, ${waiting} confirming` +
			(errors.length > 0 ? `, ${errors.length} error(s)` : ""),
	);

	return { sent, recovered, settled, failed, waiting, refused, errors };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function record(
	db: Database,
	withdrawalId: number,
	sequenceId: string,
	at: string,
	outcome: string,
	transferId: string | null,
	txid: string | null,
	detail: string | null,
): void {
	/*
	 * APPENDED, but not endlessly. A withdrawal stuck on the same error would
	 * otherwise gain a row every minute forever; an unchanged outcome is left
	 * as the single row it already is. A CHANGE is always appended, because
	 * that is the part of the timeline worth having.
	 */
	const last = db
		.prepare(
			`SELECT outcome, detail FROM payout_attempt
			  WHERE withdrawal_id = ? ORDER BY id DESC LIMIT 1`,
		)
		.get(withdrawalId) as { outcome: string; detail: string | null } | undefined;
	if (last !== undefined && last.outcome === outcome && last.detail === detail) {
		return;
	}
	db.prepare(
		`INSERT INTO payout_attempt
		   (withdrawal_id, sequence_id, attempt_at, outcome, transfer_id, txid, detail)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(withdrawalId, sequenceId, at, outcome, transferId, txid, detail);
}

/** The attempt history for one withdrawal, for support and the admin console. */
export function attemptsFor(
	db: Database,
	withdrawalId: number,
): readonly {
	at: string;
	outcome: string;
	transferId: string | null;
	txid: string | null;
	detail: string | null;
}[] {
	db.exec(SCHEMA);
	return db
		.prepare(
			`SELECT attempt_at AS at, outcome, transfer_id AS transferId,
			        txid, detail
			   FROM payout_attempt WHERE withdrawal_id = ? ORDER BY id`,
		)
		.all(withdrawalId) as {
		at: string;
		outcome: string;
		transferId: string | null;
		txid: string | null;
		detail: string | null;
	}[];
}

/**
 * Payouts that need a person: refused, errored, or sent-but-unsettled.
 *
 * Deliberately includes "sent but not settled". That is the state where the
 * coins have left and the books have not caught up, and it is the one an
 * operator must never have to discover from a customer.
 */
export function stuckPayouts(
	db: Database,
): readonly { withdrawalId: number; outcome: string; detail: string | null; at: string }[] {
	db.exec(SCHEMA);
	return db
		.prepare(
			`SELECT withdrawal_id AS withdrawalId, outcome, detail, attempt_at AS at
			   FROM payout_attempt a
			  WHERE outcome IN ('refused', 'error')
			    AND NOT EXISTS (
			      SELECT 1 FROM payout_attempt b
			       WHERE b.withdrawal_id = a.withdrawal_id
			         AND b.outcome IN ('settled', 'failed')
			    )
			  ORDER BY a.id DESC LIMIT 200`,
		)
		.all() as { withdrawalId: number; outcome: string; detail: string | null; at: string }[];
}

export type { Withdrawal };
