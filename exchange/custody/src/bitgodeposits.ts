// -----------------------------------------------------------------------------
// PER-USER DEPOSIT ADDRESSES ON A POOLED WALLET.
//
// THE MODEL. One BitGo wallet per chain holds everything; each customer gets
// their own RECEIVE ADDRESS on that wallet. Coins sent to any of those
// addresses land in the same pooled balance — there is no sweep, no internal
// transfer, no second signature — and BitGo tells us which address each
// transfer arrived at. So attribution is exact without custody being
// fragmented.
//
// THAT PARAGRAPH IS ONLY TRUE OF UTXO AND EVM CHAINS, AND THE MISSING CAVEAT
// COST US A RAIL. On an ACCOUNT-MODEL chain — Solana is the one that matters
// here — a receive address is its own on-chain account, and a deposit to it
// does NOT join a pooled balance. It sits there until an explicit
// CONSOLIDATION moves it, which BitGo documents as a manual operation on
// Solana (fees paid in SOL by each receive address, up to 25 owner addresses
// per transaction). This service has no consolidation code — `grep -n
// consolidat src/` finds comments and no call site — so for Solana the three
// clauses above are each false: there IS a sweep, it IS an internal transfer,
// and it DOES need a second signature.
//
// Two consequences, both recorded in settlement.RAIL_BLOCKERS.SOL so they
// cannot be lost again: activating the Solana wallet would open a rail that
// takes deposits it cannot send back, and `BitGoHoldings.holdings` may read
// per-account deposit balances as a SHORTFALL rather than as custody. The
// sentence this comment replaces is why nobody built the consolidation path:
// it said, in the file that creates the addresses, that no sweep was needed.
//
// WHY NOT ONE ADDRESS FOR EVERYONE. Because then two customers depositing the
// same amount in the same hour are indistinguishable, and the venue is reduced
// to asking people for transaction hashes and believing them. Every exchange
// that has done this has lost deposits and credited the wrong account.
//
// WHY NOT A WALLET PER CUSTOMER. Because gas. A wallet per customer means
// sweeping each one before a withdrawal can be funded, which on Ethereum costs
// a transfer's gas per customer per sweep, and on UTXO chains produces a
// consolidation transaction that costs more than the deposit. Pooling is the
// whole reason BitGo offers receive addresses.
//
// WHAT THIS FILE WILL NOT DO:
//
//  * It will not create an address on a wallet it was not told to use. The
//    exchange's wallet scope (see bitgo.ts) decides, and an ambiguous scope is
//    an error, not a guess — an address created on the wrong wallet is a
//    deposit credited into somebody else's project.
//  * It will not reuse one customer's address for another, and `Deposits`
//    refuses to overwrite an existing one, so a retried provision is
//    idempotent rather than destructive.
//  * It will not report a transfer as credited. That is the watcher's job and
//    it is keyed on the transfer id, so a replayed feed credits once.
//
// AMOUNTS COME FROM `valueString`. BitGo also returns `value` as a JSON number,
// and for an 18-decimal token that number is already wrong by the time it
// reaches us. Reading it would be the precision bug this whole service is
// built to avoid.
// -----------------------------------------------------------------------------

import { parseBaseUnits } from "./bitgo";
import { BitGoError, BitGoHttp, type BitGoEnv } from "./bitgohttp";
import { SOL_ACTIVATION } from "./settlement";

export interface DepositClientConfig {
	readonly env: BitGoEnv;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
}

/** A receive address on the pooled wallet, belonging to one customer. */
export interface ReceiveAddress {
	readonly address: string;
	readonly id: string;
	readonly label: string;
	/** Memo/destination tag, on chains that credit by tag. */
	readonly memo: string | undefined;
}

/** One incoming transfer, as BitGo reports it. */
export interface IncomingTransfer {
	/** BitGo's transfer id. THE IDEMPOTENCY KEY for crediting. */
	readonly id: string;
	readonly txid: string;
	readonly coin: string;
	readonly confirmations: number;
	readonly state: string;
	/** Addresses credited by this transfer, with per-address amounts. */
	readonly credits: readonly { address: string; amount: bigint }[];
	/** Total credited to this wallet, in base units. */
	readonly total: bigint;
	readonly createdAt: string | undefined;
}

interface AddressResponse {
	address?: string;
	id?: string;
	label?: string;
	coinSpecific?: { memoId?: string; destinationTag?: number | string };
	/**
	 * BitGo answers a 202 with an `error` field and NO address — the request
	 * was accepted but nothing was created. See createReceiveAddress.
	 */
	error?: string;
	pendingChainInitialization?: boolean;
}

interface TransferListResponse {
	transfers?: {
		id?: string;
		txid?: string;
		coin?: string;
		confirmations?: number;
		state?: string;
		type?: string;
		valueString?: string;
		value?: number;
		createdDate?: string;
		entries?: {
			address?: string;
			valueString?: string;
			value?: number;
			wallet?: string;
			isPayGo?: boolean;
		}[];
	}[];
	nextBatchPrevId?: string;
}

export class BitGoDeposits {
	private readonly http: BitGoHttp;

	constructor(token: string, cfg: DepositClientConfig) {
		this.http = new BitGoHttp(token, {
			env: cfg.env,
			...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
			...(cfg.fetchImpl === undefined ? {} : { fetchImpl: cfg.fetchImpl }),
		});
	}

	/**
	 * Create a receive address on the pooled wallet.
	 *
	 * The label carries the account id, so an operator looking at BitGo's own
	 * UI can see whose address it is without consulting our database — which
	 * matters precisely when our database is the thing being investigated.
	 */
	async createReceiveAddress(args: {
		coin: string;
		walletId: string;
		label: string;
	}): Promise<ReceiveAddress> {
		if (args.walletId.trim() === "") {
			throw new BitGoError(
				"a wallet id is required to create a receive address — refusing to " +
					"let BitGo pick, because an address on the wrong wallet is a " +
					"deposit credited into another project",
			);
		}
		const body = await this.http.request<AddressResponse>(
			"POST",
			`/${args.coin}/wallet/${encodeURIComponent(args.walletId)}/address`,
			{ label: args.label },
		);
		const address = (body.address ?? "").trim();
		if (address === "") {
			/*
			 * ACCEPTED IS NOT CREATED.
			 *
			 * BitGo answers this POST with **HTTP 202 and an `error` field** when
			 * the wallet cannot mint an address yet — for Solana,
			 * `{"error":"wallet pending on-chain initialization"}`, because a
			 * Solana account does not exist until it is rent-funded, so there is
			 * nothing to derive from. 202 is a success status, so the response
			 * sails through to here and the only symptom is a missing address.
			 *
			 * The old message blamed BitGo for returning a blank, which sent me
			 * looking for a parsing bug in a response that was telling me plainly
			 * what was wrong. The remedy is on the operator's side and specific
			 * (fund the wallet's root address), so it is reported rather than
			 * guessed at.
			 */
			const reason = (body.error ?? "").trim();
			if (reason !== "" || body.pendingChainInitialization === true) {
				/*
				 * "A SMALL AMOUNT" IS NOT AN AMOUNT. That is what this message used
				 * to say, and an operator cannot act on it: too little and the
				 * wallet activates with nothing left to pay a fee with, because
				 * BitGo's `minimumFunding` must STAY on the wallet and cannot be
				 * spent. So for the one coin whose figures have actually been
				 * measured, the message names them — see settlement.SOL_ACTIVATION
				 * and ops/bitgo-deposit-rails.md. For any other coin it stays
				 * vague, honestly, rather than inventing a number for a chain
				 * nobody has read the reserve of.
				 */
				const how =
					args.coin === "sol"
						? `send ${SOL_ACTIVATION.recommendedLamports} lamports (0.01 SOL) ` +
							`to ${SOL_ACTIVATION.rootAddress} — the wallet's own root ` +
							`address, and the only correct destination. BitGo's ` +
							`unspendable reserve is ${SOL_ACTIVATION.minimumFundingLamports} ` +
							`lamports, so sending exactly the minimum leaves no fee ` +
							`headroom. Run ops/activate-sol-wallet.sh to verify first`
						: `send a small amount to the ${args.coin} wallet's own receive ` +
							"address to activate it";
				throw new BitGoError(
					`BitGo cannot issue a ${args.coin} receive address yet: ` +
						`${reason === "" ? "wallet pending on-chain initialization" : reason}. ` +
						"Account-based chains must exist on-chain before they can derive " +
						`addresses — ${how}, then this will succeed. No customer address ` +
						"is stored in the meantime.",
				);
			}
			throw new BitGoError(
				`BitGo created an address for ${args.coin} but returned no address ` +
					"string — refusing to store a blank, which would be shown to a " +
					"customer as somewhere to send money",
			);
		}
		// XRP-style chains return a shared address plus a tag; the tag is NOT
		// optional, so it is carried through and `Deposits` marks it required.
		const cs = body.coinSpecific ?? {};
		const memoRaw = cs.memoId ?? cs.destinationTag;
		return {
			address,
			id: (body.id ?? "").trim(),
			label: body.label ?? args.label,
			memo:
				memoRaw === undefined || String(memoRaw).trim() === ""
					? undefined
					: String(memoRaw).trim(),
		};
	}

	/**
	 * Incoming transfers for a wallet, newest first.
	 *
	 * `type=receive` only: a withdrawal we sent is not a deposit, and crediting
	 * one would hand a customer their own outgoing payment back.
	 */
	async incomingTransfers(args: {
		coin: string;
		walletId: string;
		limit?: number;
		/** BitGo paging cursor, from a previous call's `nextPrevId`. */
		prevId?: string;
	}): Promise<{ transfers: IncomingTransfer[]; nextPrevId: string | undefined }> {
		const qs = new URLSearchParams({
			type: "receive",
			limit: String(args.limit ?? 100),
		});
		if (args.prevId !== undefined && args.prevId !== "") {
			qs.set("prevId", args.prevId);
		}
		const body = await this.http.request<TransferListResponse>(
			"GET",
			`/${args.coin}/wallet/${encodeURIComponent(args.walletId)}/transfer?${qs}`,
		);

		const out: IncomingTransfer[] = [];
		for (const t of body.transfers ?? []) {
			const id = (t.id ?? "").trim();
			if (id === "") continue; // nothing to key idempotency on
			if (t.type !== undefined && t.type !== "receive") continue;

			// Per-address credits. An entry without a positive valueString is
			// either a change output, a fee entry, or the sending side; none of
			// those credit a customer.
			const credits: { address: string; amount: bigint }[] = [];
			for (const e of t.entries ?? []) {
				const addr = (e.address ?? "").trim();
				if (addr === "") continue;
				if (e.isPayGo === true) continue; // BitGo's own fee entry
				const vs = e.valueString;
				if (vs === undefined) continue;
				let amount: bigint;
				try {
					amount = parseBaseUnits(vs, t.coin ?? args.coin);
				} catch {
					// A malformed entry must not be guessed at. Skipping it means
					// the transfer's credits will not sum to its total, which the
					// watcher treats as unattributable rather than ignoring.
					continue;
				}
				if (amount <= 0n) continue;
				credits.push({ address: addr, amount });
			}

			let total = 0n;
			if (t.valueString !== undefined) {
				try {
					total = parseBaseUnits(t.valueString, t.coin ?? args.coin);
				} catch {
					total = 0n;
				}
			}
			// If BitGo gave no transfer-level total, the sum of the credits is
			// the best available figure — and it is the one we would credit
			// anyway, so using it cannot over-credit.
			if (total === 0n) {
				for (const c of credits) total += c.amount;
			}

			out.push({
				id,
				txid: (t.txid ?? "").trim(),
				coin: t.coin ?? args.coin,
				confirmations: typeof t.confirmations === "number" ? t.confirmations : 0,
				state: t.state ?? "unknown",
				credits,
				total,
				createdAt: t.createdDate,
			});
		}
		return { transfers: out, nextPrevId: body.nextBatchPrevId };
	}

	/** Wallets for a coin, so the watcher can resolve the scope to an id. */
	async wallets(
		coin: string,
	): Promise<{ id: string; label: string }[]> {
		const body = await this.http.request<{
			wallets?: { id?: string; label?: string }[];
		}>("GET", `/${coin}/wallet`);
		return (body.wallets ?? [])
			.filter((w): w is { id: string; label?: string } => typeof w.id === "string")
			.map((w) => ({ id: w.id, label: w.label ?? "" }));
	}
}

/**
 * How many confirmations before a deposit is credited.
 *
 * SET PER CHAIN, and erring long. Crediting early means crediting a deposit
 * that a reorg can take back — at which point the customer has already traded
 * or withdrawn it and the venue is short. The cost of waiting is a customer
 * seeing "pending" for a few minutes; the cost of not waiting is paid in coins.
 *
 * These are the figures a project applying to be listed is asked for (see
 * listings.ts), because the honest number depends on the chain's own reorg
 * behaviour and its current hashrate, not on a rule of thumb.
 */
export const CONFIRMATIONS: Readonly<Record<string, number>> = {
	BTC: 2,
	ETH: 32, // a full epoch: finalised, not merely deep
	SOL: 32,
	TRX: 20,
	XRP: 1, // consensus is final, not probabilistic
	DOGE: 20,
	/*
	 * BNB RAISED FROM 20 TO 40, AND THIS IS A JUDGEMENT CALL RATHER THAN A
	 * MEASUREMENT — SAID OUT LOUD SO IT CAN BE ARGUED WITH ON THE RIGHT TERMS.
	 *
	 * BEP-126 fast finality is about two blocks in theory. The extra margin is
	 * bought because this is the chain whose only free endpoint demonstrably
	 * under-reports its own history (it answers eth_getLogs with HTTP 200 and an
	 * empty array for pruned ranges rather than erroring), and 40 blocks at
	 * 0.75s costs about thirty seconds of customer-visible latency. Thirty
	 * seconds is not a product problem; crediting on a lie is.
	 *
	 * The right way to disagree with this number is reorg-depth data, not a
	 * deadline.
	 */
	BNB: 40,
	/*
	 * POLYGON, NEW. 128 blocks — about 4.3 minutes at a 2s block.
	 *
	 * Not 32, which is the figure the Ethereum habit suggests: Polygon has had
	 * multi-block reorgs well past 64, and 128 FAST blocks is cheap in
	 * wall-clock terms precisely because the blocks are fast. Heimdall finality
	 * via the `finalized` tag is preferred where the endpoint serves it, with
	 * this count as a hard floor — see EVM_CHAIN_RULES in evmscan.ts, which is
	 * the table the self-custodied scanner reads.
	 *
	 * POL is NOT a listed asset on this venue. The number is here because the
	 * confirmation rule belongs with the other confirmation rules, not because a
	 * market exists; listing POL would be a separate, deliberate edit.
	 */
	POL: 128,
	USDT: 32, // governed by the chain it arrives on; see confirmationsFor
	USDC: 32,
	BLOCK: 10,
	PERBUG: 10,
};

/**
 * Confirmations for a chain-qualified asset.
 *
 * A token inherits the confirmation rule of the CHAIN IT ARRIVED ON, not of
 * the token. USDT on Tron is not as final as USDT on Ethereum, and a single
 * per-token number would be wrong for every chain but one.
 */
export function confirmationsFor(
	asset: string,
	network: string | undefined,
): number {
	const byNetwork: Readonly<Record<string, number>> = {
		TRC20: CONFIRMATIONS.TRX!,
		ERC20: CONFIRMATIONS.ETH!,
		SOL: CONFIRMATIONS.SOL!,
		BEP20: CONFIRMATIONS.BNB!,
	};
	if (network !== undefined && byNetwork[network] !== undefined) {
		return byNetwork[network]!;
	}
	const n = CONFIRMATIONS[asset.toUpperCase()];
	if (n === undefined) {
		// FAIL LONG, not short. An unlisted chain gets the most conservative
		// number here rather than zero, because zero would credit on sight.
		return 64;
	}
	return n;
}
