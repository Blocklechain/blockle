// -----------------------------------------------------------------------------
// SENDING MONEY OUT. The one client in this service that can lose funds.
//
// Everything else here reads. This writes, and the specific disaster it has to
// rule out is PAYING A CUSTOMER TWICE: send succeeds, the process dies before
// recording the provider reference, the next pass sees an APPROVED withdrawal
// and sends again. The customer has their money twice and the venue is short
// the difference, permanently, with no on-chain way to claw it back.
//
// THE GUARD IS A DETERMINISTIC `sequenceId`.
//
// BitGo accepts a client-supplied sequence id on a send and rejects a duplicate.
// Deriving it from the withdrawal's own id — `blockle-wd-<id>` — means a retry
// after a crash presents the SAME id, so BitGo refuses it rather than sending
// again, and the existing transfer can then be looked up by that id to recover
// the reference we failed to write. The crash window becomes recoverable
// instead of expensive.
//
// So the order of operations is: look up the sequence id FIRST, send only if
// nothing is there, and treat a duplicate-rejection as success-already-happened
// rather than as an error.
//
// WHAT THIS WILL NOT DO:
//
//  * It will not send without a configured signing passphrase. BitGo needs it
//    to decrypt the key share; without one the call would fail anyway, and
//    failing EARLY with a clear message beats a half-attempted payout.
//  * It will not retry a send on a timeout. A timeout means we do not know
//    whether it went out, and "do not know" must never resolve to "send it
//    again". The sequence-id lookup on the next pass settles it.
//  * It will not infer a failure. Only BitGo's own statement that a transfer
//    failed or was removed justifies reversing a customer's debit; a reversal
//    on a guess pays them back for money that is also on its way to them.
// -----------------------------------------------------------------------------

import { parseBaseUnits } from "./bitgo";
import { BitGoError, BitGoHttp, type BitGoEnv } from "./bitgohttp";

export interface PayoutClientConfig {
	readonly env: BitGoEnv;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	/**
	 * Decrypts the wallet's key share so BitGo can sign.
	 *
	 * Held only in memory, from the environment. Absent means this client
	 * refuses to send rather than attempting and failing — see the header.
	 */
	readonly passphrase?: string;
}

/** What a send or a lookup tells us about one outgoing transfer. */
export interface OutgoingTransfer {
	/** BitGo's transfer id. Stored as the withdrawal's provider reference. */
	readonly id: string;
	readonly txid: string;
	readonly state: string;
	readonly confirmations: number;
	/**
	 * The chain fee, in base units OF THE GAS ASSET.
	 *
	 * For an ERC-20 send this is ETH, not the token. Booking it against the
	 * token would invent a shortfall in an asset that never moved — see
	 * withdrawals.ts `confirm`.
	 */
	readonly feeBaseUnits: bigint;
	readonly sequenceId: string | undefined;
}

interface TransferJson {
	id?: string;
	txid?: string;
	state?: string;
	confirmations?: number;
	feeString?: string;
	sequenceId?: string;
}

interface SendJson {
	transfer?: TransferJson;
	txid?: string;
	status?: string;
}

export class BitGoPayouts {
	private readonly http: BitGoHttp;
	private readonly passphrase: string;

	constructor(token: string, cfg: PayoutClientConfig) {
		this.http = new BitGoHttp(token, {
			env: cfg.env,
			...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
			...(cfg.fetchImpl === undefined ? {} : { fetchImpl: cfg.fetchImpl }),
		});
		this.passphrase = (cfg.passphrase ?? "").trim();
	}

	get canSend(): boolean {
		return this.passphrase !== "";
	}

	/**
	 * The sequence id for a withdrawal. DETERMINISTIC — that is the whole point.
	 *
	 * A random id per attempt would make every retry a fresh send, which is
	 * exactly the double-payment this guards against.
	 */
	static sequenceId(withdrawalId: number): string {
		return `blockle-wd-${withdrawalId}`;
	}

	/**
	 * Has this withdrawal already been sent? Answered by its sequence id.
	 *
	 * Called BEFORE every send, so a crash between "BitGo accepted it" and "we
	 * recorded the reference" is recoverable rather than a double payment.
	 *
	 * Returns undefined only when BitGo positively has no such transfer. A
	 * failure to ask THROWS — "I could not check" must not read as "nothing is
	 * there", which would green-light a second send.
	 */
	async findBySequenceId(args: {
		coin: string;
		walletId: string;
		sequenceId: string;
	}): Promise<OutgoingTransfer | undefined> {
		const qs = new URLSearchParams({ sequenceId: args.sequenceId, limit: "10" });
		const body = await this.http.request<{ transfers?: TransferJson[] }>(
			"GET",
			`/${args.coin}/wallet/${encodeURIComponent(args.walletId)}/transfer?${qs}`,
		);
		const rows = body.transfers ?? [];
		// Match explicitly rather than trusting the filter: if BitGo ever
		// ignores the parameter, an unfiltered list would otherwise look like a
		// match and we would skip a send that never happened.
		const hit = rows.find((t) => t.sequenceId === args.sequenceId);
		if (hit === undefined) return undefined;
		return this.hydrate(hit, args.coin);
	}

	/**
	 * Send. Idempotent on the sequence id.
	 *
	 * `alreadySent` distinguishes "BitGo accepted this now" from "BitGo says it
	 * has this already", because the caller must not treat the second as a new
	 * payment — the amount is the same but the accounting already happened.
	 */
	async send(args: {
		coin: string;
		walletId: string;
		address: string;
		/** Base units. Sent as a string; BitGo's numeric field is lossy. */
		amount: bigint;
		sequenceId: string;
		/** Memo/destination tag, on chains that need one. */
		memo?: string;
		comment?: string;
	}): Promise<{ transfer: OutgoingTransfer; alreadySent: boolean }> {
		if (!this.canSend) {
			throw new BitGoError(
				"no signing passphrase is configured, so this payout cannot be sent. " +
					"Refusing early rather than attempting a send that would fail " +
					"halfway. Set BITGO_WALLET_PASSPHRASE.",
			);
		}
		if (args.amount <= 0n) {
			throw new BitGoError(`refusing to send a non-positive amount (${args.amount})`);
		}
		if (args.address.trim() === "") {
			throw new BitGoError("refusing to send to an empty address");
		}

		const payload: Record<string, unknown> = {
			address: args.address.trim(),
			// STRING, always. An 18-decimal amount does not survive a JSON
			// number, and this is the field that decides how much leaves.
			amount: args.amount.toString(),
			walletPassphrase: this.passphrase,
			sequenceId: args.sequenceId,
		};
		if (args.memo !== undefined && args.memo !== "") {
			// Chains that credit by tag need it on the way out too.
			payload.memo = { type: "text", value: args.memo };
		}
		if (args.comment !== undefined) payload.comment = args.comment;

		let body: SendJson;
		try {
			body = await this.http.request<SendJson>(
				"POST",
				`/${args.coin}/wallet/${encodeURIComponent(args.walletId)}/sendcoins`,
				payload,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			/*
			 * A DUPLICATE SEQUENCE ID IS NOT A FAILURE — it is proof the send
			 * already happened. Recover the transfer rather than reporting an
			 * error the caller would retry.
			 */
			if (/sequence ?id/i.test(msg) && /duplicat|exist|already/i.test(msg)) {
				const found = await this.findBySequenceId({
					coin: args.coin,
					walletId: args.walletId,
					sequenceId: args.sequenceId,
				});
				if (found !== undefined) return { transfer: found, alreadySent: true };
				// BitGo says the id is taken but will not show us the transfer.
				// That is genuinely ambiguous, so it stays an error: the caller
				// leaves the withdrawal where it is and tries again later rather
				// than marking it sent on a guess.
				throw new BitGoError(
					`BitGo rejected sequence id ${args.sequenceId} as a duplicate but ` +
						"returned no matching transfer. NOT treating this as sent — the " +
						"withdrawal stays put until the transfer can be found.",
				);
			}
			throw e;
		}

		const t = body.transfer;
		if (t === undefined || (t.id ?? "").trim() === "") {
			/*
			 * ACCEPTED BUT UNIDENTIFIED. The coins may well be on their way and
			 * we have no reference to track them by. Deliberately an error:
			 * marking the withdrawal submitted with a blank reference would make
			 * it unreconcilable forever, and the sequence-id lookup on the next
			 * pass will find it.
			 */
			throw new BitGoError(
				"BitGo accepted the send but returned no transfer id. The payout may " +
					`be in flight; it will be recovered by sequence id ${args.sequenceId} ` +
					"on the next pass rather than re-sent.",
			);
		}
		return { transfer: this.hydrate(t, args.coin), alreadySent: false };
	}

	/** Current state of one transfer, for the confirmation step. */
	async transfer(args: {
		coin: string;
		walletId: string;
		transferId: string;
	}): Promise<OutgoingTransfer> {
		const body = await this.http.request<TransferJson>(
			"GET",
			`/${args.coin}/wallet/${encodeURIComponent(args.walletId)}/transfer/` +
				encodeURIComponent(args.transferId),
		);
		return this.hydrate(body, args.coin);
	}

	private hydrate(t: TransferJson, coin: string): OutgoingTransfer {
		let fee = 0n;
		if (t.feeString !== undefined) {
			try {
				fee = parseBaseUnits(t.feeString, coin);
			} catch {
				/*
				 * A FEE WE CANNOT PARSE IS REPORTED AS ZERO, and that is the
				 * conservative direction here. The fee is journalled against the
				 * venue's own gas float; under-booking it understates our cost
				 * and reconciliation will show the gap. Over-booking it, or
				 * guessing, would debit a float by an invented amount.
				 */
				fee = 0n;
			}
		}
		return {
			id: (t.id ?? "").trim(),
			txid: (t.txid ?? "").trim(),
			state: t.state ?? "unknown",
			confirmations: typeof t.confirmations === "number" ? t.confirmations : 0,
			feeBaseUnits: fee,
			sequenceId: t.sequenceId,
		};
	}
}
