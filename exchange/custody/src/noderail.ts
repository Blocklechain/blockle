// -----------------------------------------------------------------------------
// PAYING OUT A COIN WE CUSTODY OURSELVES.
//
// The payout runner was written against BitGo, whose `sequenceId` makes a
// retry safe: present the same id twice and the custodian refuses the second
// send. That one guarantee is what turns "the process died, did the money go
// out?" from a disaster into a lookup.
//
// A BITCOIND-FAMILY DAEMON GIVES NO SUCH GUARANTEE. `sendtoaddress` will
// happily send twice. So the protection has to be reconstructed from what the
// daemon does offer, and it is weaker in one specific way that is written down
// here rather than discovered later.
//
// WHAT REPLACES THE SEQUENCE ID.
//
// Every send carries the withdrawal's deterministic id in its COMMENT, which
// bitcoind stores in the wallet alongside the transaction, in the same write.
// So:
//
//   * before sending, `listtransactions` is scanned for that comment. A hit
//     means the send already happened and is recovered rather than repeated.
//   * a crash between the broadcast and our recording it is therefore
//     recoverable: the daemon has the comment even though we never got the
//     reply.
//
// THE REMAINING WINDOW, STATED PLAINLY.
//
// Two runners executing at the same instant could both check, both find
// nothing, and both send. BitGo would reject the second; bitcoind will not.
// What rules that out is that the runner is a systemd one-shot — systemd will
// not start a second instance of a unit while the first is running — and this
// rail is only ever driven by that unit. If anyone ever runs it by hand
// alongside the timer, that protection is gone. Hence `SINGLE_INSTANCE_NOTE`,
// which the runner prints, so the assumption is visible to whoever is reading
// the logs at the time.
//
// This is a real difference in safety between the two custody models, and it
// is a reason to keep self-custodied coins on small balances.
// -----------------------------------------------------------------------------

import { BitcoinRpcAdapter, ChainError } from "./chains";

export const SINGLE_INSTANCE_NOTE =
	"node payouts rely on exactly one runner at a time: a bitcoind-family " +
	"daemon cannot refuse a duplicate send the way BitGo's sequence id does. " +
	"Run this only from its systemd unit.";

/** One outgoing transfer, in the shape the payout runner already consumes. */
export interface RailTransfer {
	readonly id: string;
	readonly txid: string;
	readonly state: string;
	readonly confirmations: number;
	readonly feeBaseUnits: bigint;
	readonly sequenceId: string | undefined;
}

/**
 * What the payout runner needs from a custodian.
 *
 * Extracted from what it was already doing with BitGoPayouts, so that class
 * satisfies it unchanged — this interface describes the existing contract
 * rather than inventing a new one for the node rail to be special in.
 */
export interface PayoutRail {
	readonly canSend: boolean;
	/**
	 * What to configure when `canSend` is false.
	 *
	 * Optional so a test double need not supply it, but every real rail does:
	 * the refusal message is read by an operator with debited customers
	 * waiting, and "no signing credential is configured" without saying WHICH
	 * one sends them to the source. The first version of this hardcoded
	 * BITGO_WALLET_PASSPHRASE, which became wrong the moment a second
	 * custodian existed.
	 */
	readonly credentialHint?: string;
	findBySequenceId(args: {
		coin: string;
		walletId: string;
		sequenceId: string;
	}): Promise<RailTransfer | undefined>;
	send(args: {
		coin: string;
		walletId: string;
		address: string;
		amount: bigint;
		sequenceId: string;
		memo?: string;
		comment?: string;
	}): Promise<{ transfer: RailTransfer; alreadySent: boolean }>;
	transfer(args: {
		coin: string;
		walletId: string;
		transferId: string;
	}): Promise<RailTransfer>;
}

/**
 * A payout rail over a daemon we run.
 *
 * `coin` and `walletId` are accepted and ignored: there is one wallet, it is
 * the daemon's. They stay in the signature so this is a drop-in for the BitGo
 * rail rather than a second code path through the runner.
 *
 * THE TRANSFER ID IS THE TXID. BitGo has its own identifier; a daemon does
 * not, and inventing one would mean keeping a mapping that could drift from
 * the chain. The txid is already unique, already stored as the withdrawal's
 * provider reference, and is what an operator would search for anyway.
 */
export class NodePayoutRail implements PayoutRail {
	constructor(
		private readonly adapter: BitcoinRpcAdapter,
		/** Confirmations before a payout counts as settled. */
		private readonly confirmationsRequired: number,
	) {
		if (!Number.isInteger(confirmationsRequired) || confirmationsRequired < 1) {
			throw new ChainError(
				`${adapter.symbol}: a payout cannot settle at ` +
					`${confirmationsRequired} confirmations`,
			);
		}
	}

	get credentialHint(): string {
		const sym = this.adapter.symbol.toUpperCase();
		return `CHAIN_${sym}_SEND=1 and, if the wallet is encrypted, CHAIN_${sym}_PASSPHRASE`;
	}

	get canSend(): boolean {
		// The adapter refuses to send unless it was built with allowSend, and
		// this must report the same answer — the runner uses it to decide
		// whether to refuse loudly instead of silently idling with customers'
		// funds already debited.
		return this.adapter.canSend;
	}

	// `coin` and `walletId` are declared though unused — see the class comment:
	// there is one wallet and it is the daemon's. Declaring them keeps this a
	// true drop-in, including for a caller holding a concrete reference.
	async findBySequenceId(args: {
		coin?: string;
		walletId?: string;
		sequenceId: string;
	}): Promise<RailTransfer | undefined> {
		const hit = await this.adapter.findSend(args.sequenceId);
		if (hit === undefined) return undefined;
		// Found by comment. Its current state comes from the chain, not from
		// the assumption that a found transaction is a confirmed one.
		return this.transfer({ transferId: hit.txid });
	}

	async send(args: {
		coin?: string;
		walletId?: string;
		address: string;
		amount: bigint;
		sequenceId: string;
		memo?: string;
		comment?: string;
	}): Promise<{ transfer: RailTransfer; alreadySent: boolean }> {
		const { txid } = await this.adapter.send({
			to: args.address,
			amount: args.amount,
			// THE COMMENT IS THE IDEMPOTENCY KEY. See the header: it is the only
			// thing that makes a crashed send recoverable on this rail.
			idempotencyKey: args.sequenceId,
		});
		return {
			transfer: {
				id: txid,
				txid,
				// Freshly broadcast. Not "confirmed", and not "unknown" — the
				// runner distinguishes these, and a wrong word here would either
				// settle a payout that has not confirmed or strand one that has.
				state: "unconfirmed",
				confirmations: 0,
				feeBaseUnits: 0n,
				sequenceId: args.sequenceId,
			},
			// A daemon cannot tell us it had already sent this; the pre-check is
			// the only place that can know, and it reports its own recovery.
			alreadySent: false,
		};
	}

	async transfer(args: {
		coin?: string;
		walletId?: string;
		transferId: string;
	}): Promise<RailTransfer> {
		const tx = await this.adapter.transaction(args.transferId);
		return {
			id: tx.txid,
			txid: tx.txid,
			/*
			 * THE STATE WORDS ARE THE RUNNER'S, NOT THE DAEMON'S.
			 *
			 * The runner reverses a customer's debit on "failed" or "removed"
			 * and on nothing else. A daemon reports a conflicted transaction
			 * with NEGATIVE confirmations — it was replaced or reorged out and
			 * is not coming back — which is exactly the custodian's-own-word
			 * condition, so it maps to "failed". Anything else maps to a
			 * neutral word, because a payout the daemon is unsure about must
			 * not refund a customer who may still receive the coins.
			 */
			state:
				tx.confirmations < 0 ? "failed"
				: tx.confirmations >= this.confirmationsRequired ? "confirmed"
				: "unconfirmed",
			confirmations: Math.max(0, tx.confirmations),
			feeBaseUnits: tx.feeBaseUnits,
			sequenceId: tx.comment,
		};
	}
}

/**
 * Pick the rail for one asset.
 *
 * Returns undefined when nothing can pay that asset out, which the runner
 * reports as "no wallet" — the existing path for a withdrawal it cannot
 * action — rather than attempting it on the wrong custodian.
 */
export function railFor(args: {
	asset: string;
	bitgo?: PayoutRail;
	nodeRails: ReadonlyMap<string, PayoutRail>;
}): PayoutRail | undefined {
	const node = args.nodeRails.get(args.asset);
	if (node !== undefined) return node;
	return args.bitgo;
}
