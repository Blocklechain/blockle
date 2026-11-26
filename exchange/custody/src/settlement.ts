// -----------------------------------------------------------------------------
// CAN THIS ASSET ACTUALLY SETTLE, AND CAN A PRICE FOR THIS PAIR BE WRITTEN DOWN?
//
// WHY THIS FILE EXISTS.
//
// The market generator in venue.ts used to throw its reasons away. It crossed
// two quotes with fourteen assets and had two bare `continue` statements, so
// nothing downstream could say why a pair was absent — and "absent" is
// indistinguishable from "bug" to the person looking for it. Expanding to six
// quotes makes that fatal rather than untidy: 63 unordered pairs are possible
// and 29 of them cannot settle today, so the venue has to be able to say which,
// and why, in a sentence a customer can read.
//
// TWO SEPARATE QUESTIONS, AND CONFLATING THEM IS THE TRAP.
//
//   1. SETTLEMENT. Can a deposit of this asset be credited and a withdrawal of
//      it be paid? If not, a market in it is a one-way door.
//   2. EXPRESSIBILITY. Can a price for this pair be written as an integer at
//      all? A market whose honest price rounds to zero is a market in which
//      every order is rejected, discovered by a miner trying to sell.
//
// Both are answered here, both are pure, and both are derived from tables that
// already exist (ASSETS, LIVE_FEES, the custody routes) rather than from a
// hand-written `settles: true` flag. That choice is not stylistic. This
// codebase has twice recorded the cost of a parallel hand-maintained list:
// listed.ts's header describes the registry and assets.ts drifting until a coin
// was promotable while the ledger refused every posting for it, and
// publicapi.ts's LISTED comment records a hand-written asset list naming eight
// assets while the venue traded six markets. A boolean agrees with reality on
// the day it is typed.
//
// WHAT IS *NOT* HERE: ANY LIVE STATE.
//
// Nothing in this file reads a balance, a float or a service. That is the
// deliberate split:
//
//   STRUCTURAL facts (is there a rail, is it priced, is the arithmetic
//   possible) decide which market SYMBOLS EXIST, and which of them are OPEN.
//   That verdict is computed once, at module load, in venue.ts's buildMarkets.
//
//   LIVE facts (is there gas in the float right now, is reconciliation halted)
//   gate the MONEY MOVEMENTS — a withdrawal on a chain whose float is empty,
//   a deposit address on a chain we could not pay out of. They are checked per
//   request in withdrawals.ts and deposits.ts.
//
// NOTHING CLOSES A MARKET AT REQUEST TIME, and that is worth saying plainly
// because an earlier draft of this comment claimed otherwise. `/public/markets`
// serves the load-time verdict; an empty TRX gas float does not shut TRX-USDT.
// A book whose proceeds cannot be withdrawn today is still a book whose orders
// can be cancelled and whose balances are real, and the withdrawal path is
// where that condition is reported, with the figure and the remedy.
//
// Admission must not track a float. A 0 TRX gas float is an operational
// condition a top-up fixes in minutes; if a market's existence tracked it,
// USDT's markets would be minted and deleted daily — and deleting a symbol
// orphans every resting order in it. `market()` then throws 404, `reserved()`
// silently stops counting those orders, and the customer is handed a balance
// that is still committed to a book nobody can see or cancel. So symbols are
// append-only and closure is a state, never a deletion. See venue.ts.
// -----------------------------------------------------------------------------

import { ASSETS, custodyIds, gasAssetFor, networkOf, settlementAsset } from "./assets";
/*
 * The SOL blocker quotes the published minimum deposit and the dust floor, and
 * it quotes them from the module that ENFORCES them rather than retyping the
 * numbers. The two have already drifted once in this service — the SOL
 * activation remedy used to tell an operator to "send a small amount", which is
 * not an amount — and a customer-facing minimum that disagrees with the floor
 * the sweeper applies is the same class of mistake with a worse outcome.
 */
import {
	SOL_MINIMUM_DEPOSIT_LAMPORTS,
	SOL_SWEEP_DUST_FLOOR_LAMPORTS,
} from "./solconsolidation";
import { LIVE_FEES } from "./withdrawalfees";

/**
 * THE QUOTE ASSETS, MOST SENIOR FIRST.
 *
 * Seniority decides nothing about whether a pair exists — settlement and
 * arithmetic do that. It decides only which way round a NEW pair is written
 * when both orientations would work: the senior asset becomes the quote.
 * USDT is first because it is what people price in; BLOCK is last because it is
 * the asset being priced, not the yardstick.
 *
 * It lives in this file rather than venue.ts so that `orient()` is
 * self-contained and venue.ts can import it without a cycle. venue.ts
 * re-exports it, because that is where callers expect to find it.
 */
export const QUOTE_SENIORITY = ["USDT", "USDC", "BTC", "ETH", "SOL", "BLOCK"] as const;

export function isQuoteAsset(symbol: string): boolean {
	return (QUOTE_SENIORITY as readonly string[]).includes(symbol);
}

/** Lower is more senior. Non-quotes sort after every quote. */
export function seniority(symbol: string): number {
	const i = (QUOTE_SENIORITY as readonly string[]).indexOf(symbol);
	return i === -1 ? QUOTE_SENIORITY.length : i;
}

/* -------------------------------------------------------------- settlement */

/**
 * A RAIL ON WHICH A CUSTOMER DEPOSIT ADDRESS HAS ACTUALLY BEEN MINTED.
 *
 * This is the clause that matters, and it is the one a gas-only gate gets
 * wrong. Probed against the live venue on 2026-11-26: ETH and BSC return BitGo
 * `403 "A pricing plan is required to create receive addresses"`, and SOL
 * returns a `202` carrying `wallet pending on-chain initialization` — yet all
 * three pass `checkGas` with `ok=true selfFunding=true`, because a send on a
 * self-funding chain needs no separate float. A gate built on the gas check
 * alone would therefore admit exactly the three assets that cannot take a
 * deposit, which is the one-way market this whole mechanism exists to prevent.
 *
 * So the evidence required is narrower than "the chain works": a deposit
 * address for a real customer exists in `deposit_address`, and the payout side
 * has a route. Each entry is dated and says where it came from, like every
 * other measured table in this service.
 */
export interface ProvenRail {
	/** The custody id (chain) the evidence is about. */
	readonly rail: string;
	/** When the evidence was taken. */
	readonly provenAt: string;
	/** What was observed. Published in operator output, not to customers. */
	readonly evidence: string;
}

export const PROVEN_RAILS: Readonly<Record<string, ProvenRail>> = {
	/*
	 * The eight chains with a customer deposit address on record. Taken from
	 * `SELECT asset, network, COUNT(*) FROM deposit_address GROUP BY 1,2` on
	 * the live ledger, which returned exactly these eight and nothing else.
	 *
	 * BTC additionally shows two derived addresses on its BitGo wallet (the
	 * root plus the issued customer address), which is what distinguishes it
	 * from ETH and SOL, where only the wallet root exists.
	 */
	BTC: {
		rail: "BTC",
		provenAt: "2026-11-26",
		evidence: "a customer deposit address exists; BitGo shows 2 derived addresses on wallet 6b06f01b",
	},
	DOGE: { rail: "DOGE", provenAt: "2026-11-26", evidence: "a customer deposit address exists" },
	TRX: { rail: "TRX", provenAt: "2026-11-26", evidence: "a customer deposit address exists; BitGo shows 2 derived addresses on wallet 6b06f062" },
	XRP: { rail: "XRP", provenAt: "2026-11-26", evidence: "a customer deposit address exists" },

	/*
	 * The self-custodied small-PoW coins. Addresses come from our own daemons
	 * and the payout runner reports these four as its live node rails every
	 * cycle ("node rails: PERBUG, RTM, PEP, DINGO"), which is the withdrawal
	 * half of the same claim.
	 */
	PERBUG: { rail: "PERBUG", provenAt: "2026-11-26", evidence: "a customer deposit address exists; payout runner lists it as a live node rail" },
	PEP: { rail: "PEP", provenAt: "2026-11-26", evidence: "a customer deposit address exists; payout runner lists it as a live node rail" },
	DINGO: { rail: "DINGO", provenAt: "2026-11-26", evidence: "a customer deposit address exists; payout runner lists it as a live node rail" },
	RTM: { rail: "RTM", provenAt: "2026-11-26", evidence: "a customer deposit address exists; payout runner lists it as a live node rail" },
};

/* --------------------------------------------------------- known blockers */

/**
 * WHOSE ACTION CLEARS A BLOCKER.
 *
 * Recorded because the three shut rails are shut for three different KINDS of
 * reason, and a reader who cannot tell them apart will wait for the wrong
 * person. "BitGo wants money" is not something an engineer can fix by trying
 * harder, and "we have not written the consolidation code" is not something
 * the operator can fix by funding a wallet.
 */
export type BlockerOwner =
	/** Someone has to agree to pay, or to accept terms. No code unblocks it. */
	| "commercial"
	/** A one-off on-chain or console action by the operator. */
	| "operator"
	/** Code that does not exist yet. */
	| "engineering";

/** One reason a rail is shut, with the single step that clears THAT reason. */
export interface BlockerCause {
	readonly owner: BlockerOwner;
	/** What was actually observed, verbatim where possible. Operator-facing. */
	readonly evidence: string;
	/** When it was last observed. */
	readonly observedAt: string;
	/** The one step that clears this cause. Operator-facing. */
	readonly remedy: string;
}

/**
 * WHY A RAIL IS KNOWN TO BE SHUT — the operator's record and the customer's
 * sentence, kept in one place so they cannot disagree.
 *
 * Absence from PROVEN_RAILS is already a refusal, but "no deposit address has
 * ever been minted" is a true sentence that explains nothing, and that is
 * exactly what a customer saw: `describeDeposit` composed a generic "no address
 * is provisioned" paragraph while the real cause sat in the service's own log.
 * Two customers asked twice. So the cause now travels to the screen.
 *
 * `causes` IS A LIST, AND THAT IS THE LOAD-BEARING PART. A rail is open only
 * when EVERY cause is gone. SOL has two independent ones — the wallet is not
 * activated on chain, AND there is no code to consolidate per-account deposits
 * back out again — and they clear at different times by different people.
 * Flattening them to one string is how a rail gets opened by the cheaper half
 * of its fix: funding the wallet makes BitGo mint addresses, the gas check
 * already passes (SOL pays its own gas), and the venue would then be taking
 * deposits it has no code to send back. One-way doors are what this module
 * exists to prevent, so the second cause is written down next to the first.
 */
export interface RailBlocker {
	/** The chain this is about — the anchor, not the token. */
	readonly rail: string;
	/**
	 * Every outstanding reason. The rail is shut while this is non-empty, and
	 * emptying it is a deliberate edit here, never a side effect elsewhere.
	 */
	readonly causes: readonly BlockerCause[];
	/**
	 * THE SENTENCE A CUSTOMER READS. Says what is true, whether it is us or the
	 * custodian, and what they can do in the meantime. It never blames the
	 * customer, never implies a defect they should retry, and never hints that
	 * an address might appear if they reload.
	 */
	readonly customer: string;
}

/**
 * THE EXACT, MEASURED FIGURES FOR ACTIVATING THE SOLANA CUSTODY WALLET.
 *
 * In code rather than only in the runbook because the runbook and the error
 * message have already drifted once: `createReceiveAddress` used to tell the
 * operator to "send a small amount", which is not an amount. Re-read live from
 * `GET /api/v2/sol/wallet/6b06f053…` on 2026-11-26 (IPv4-pinned; the token is
 * IP-restricted and an IPv6 egress returns a 401 that reads as a bad token).
 *
 * `minimumFunding` is BitGo's own figure and, per BitGo's docs, must STAY on
 * the wallet and cannot be spent — so the recommended send is larger than the
 * minimum rather than equal to it, or the wallet is activated with nothing to
 * pay a fee with.
 */
export const SOL_ACTIVATION = {
	walletId: "6b06f0530242e6aa1edd125b16f521fe",
	walletLabel: "Blockle Exchange SOL",
	/** The wallet's own root address. The ONLY correct destination. */
	rootAddress: "HRdvYQ2StLnLNRHFeyBoDMgBVbCqjAJTm5vAmbmBqEwP",
	/** BitGo's `coinSpecific.minimumFunding`, in lamports. Unspendable. */
	minimumFundingLamports: 2_447_136n,
	/** What to actually send, in lamports: the reserve plus fee headroom. */
	recommendedLamports: 10_000_000n,
	observedAt: "2026-11-26",
	source: "GET /api/v2/sol/wallet/6b06f0530242e6aa1edd125b16f521fe",
} as const;

export const RAIL_BLOCKERS: Readonly<Record<string, RailBlocker>> = {
	/*
	 * ETH AND BNB: THE CUSTODY MODEL UNDER THESE CHANGED, AND THE OLD CAUSE IS
	 * NO LONGER THE REASON THEY ARE SHUT.
	 *
	 * WHAT THIS ENTRY USED TO SAY, AND WHY IT IS GONE. It recorded one
	 * commercial cause: BitGo answers `POST /{eth,bsc}/wallet/{id}/address` with
	 * 403 and "A pricing plan is required to create receive addresses", the
	 * enterprise is on the free self-serve tier (activePricingType.name
	 * "starter", isContractedClient false), and not one EVM receive address has
	 * ever been created on the account (lastChainIndex {"0":0,"1":-1}) while an
	 * equally unprovisioned LTC wallet mints them on request. Every word of that
	 * is still TRUE and it is still MEASURED. It is simply no longer the
	 * blocker, because the venue is not asking BitGo for these addresses any
	 * more. The BitGo pricing conversation is now optional rather than
	 * load-bearing, and that is the whole point of what replaced it.
	 *
	 * WHAT REPLACED IT. ETH, BSC and Polygon are now SELF-CUSTODIED rails built
	 * on an account-level xpub: this host holds an extended PUBLIC key, derives
	 * `m/44'/60'/0'/0/i` per customer with zero spending authority, and the
	 * seed never comes near the box. That is possible because secp256k1 HAS
	 * watch-only derivation — a non-hardened child public key is
	 * `parentPub + IL*G`, arithmetic on public values — which is exactly what
	 * BLOCK cannot do and the reason blockaddresspool.ts has to ship addresses
	 * in from an offline machine.
	 *
	 * SAY THE UNCOMFORTABLE PART OUT LOUD, BECAUSE IT IS THE ARGUMENT FOR DOING
	 * IT THIS WAY: these new rails will be MORE secure than the six BitGo rails
	 * already live. BitGo's spending authority on this venue is a bearer token
	 * (BITGO_ACCESS_TOKEN) sitting in a file on this internet-facing host. The
	 * new rails' spending authority is not on this host at all, in any form, and
	 * cannot be — an xpub is mathematically incapable of producing a signature.
	 *
	 * AND THE SHARED ROOT ADDRESS IS STILL NOT A STOPGAP, which is worth
	 * keeping because it will be proposed again every time this takes a week
	 * longer than someone hoped. Both BitGo wallets already expose a working
	 * root receiveAddress, and neither chain has any memo or tag mechanism, so
	 * two customers depositing the same asset would be permanently
	 * indistinguishable while reconciliation still balanced. That is how a venue
	 * credits the wrong account and never finds out.
	 *
	 * WHY THE CAUSES BELOW ARE NO LONGER PURELY COMMERCIAL. test/settlement.test
	 * .ts asserted exactly that — "ETH and BNB are recorded as commercial,
	 * because no code unblocks them" — and it was right when the only path was a
	 * bill. It is wrong now: there is code to write, and pretending otherwise
	 * would send the next reader to negotiate a pricing plan that would not open
	 * these rails. That assertion was replaced deliberately, not relaxed.
	 *
	 * THE ORDER OF THE CAUSES IS NOT THE ORDER OF THEIR COST. The cheapest one
	 * to clear is pasting an xpub into an env file, and it is the one that makes
	 * the rail LOOK open — derivation needs no key, no ceremony, no second host
	 * and no human, so one env line turns this process into something that can
	 * hand a deposit address to every customer on three chains in an instant.
	 * That is the one-way door in its modern form, and evmrail.ts refuses to
	 * issue while any requirement is unmet. The gate is in code, not in this
	 * comment. See EVM_RAIL_REQUIREMENTS, which names these same facts as
	 * checkable preconditions.
	 */
	ETH: {
		rail: "ETH",
		causes: [
			{
				owner: "engineering",
				evidence:
					"The withdrawal half does not exist, and rule 4 makes that a DEPOSIT " +
					"blocker: nothing signs, submits or books a sweep. EvmRpcAdapter.send " +
					"is a permanent rejection and probe().canSend is false — correctly, " +
					"because an xpub cannot sign — so every outbound movement needs the " +
					"offline signer host, and PayoutRail assumes a SYNCHRONOUS send, which " +
					"is a different shape and is new code. No proposal has ever been " +
					"composed, carried, signed or broadcast.",
				observedAt: "2026-11-26",
				remedy:
					"Build the APPROVED -> proposal -> signed-blob -> SUBMITTED path: the " +
					"signer re-derives every source from its OWN seed at the claimed index, " +
					"checks every destination against an allow-list compiled into the " +
					"signer, enforces per-batch ceilings and nonce monotonicity, and prints " +
					"four lines for a human. Without source re-derivation and the " +
					"allow-list the offline step is theatre. Then a broadcast runner, " +
					"idempotent per entry, posting BOTH movements of every sweep INCLUDING " +
					"the gas fee — omitting the fee grows a steady shortfall that halts the " +
					"asset and would be entirely self-inflicted. Record it in " +
					"EVM_RAIL_EVIDENCE.",
			},
			{
				owner: "engineering",
				evidence:
					"The deposit half is built but unproven in two specific places. " +
					"EvmNativeScanner has never run a week against live tip, so sustained " +
					"fitness is unknown — every endpoint measurement behind this rail is a " +
					"burst of 25 to 30 calls, while a per-block scan is a permanent duty " +
					"cycle. And no monitor exists OUTSIDE this host re-deriving issued " +
					"addresses from the xpub: root here needs no key to steal a new " +
					"customer's first deposit, only the ability to change what that " +
					"customer is SHOWN, and a keyless design does not close that.",
				observedAt: "2026-11-26",
				remedy:
					"Run the scanner read-only against tip for seven days and alarm on " +
					"CURSOR LAG, not only on errors — ethereum-rpc.publicnode.com serves " +
					"logs ~9,700 blocks back and receipts ~20,000, about 32 hours, so a " +
					"stall that starts Friday and is found Monday is already past " +
					"backfilling. Then stand up the off-host address monitor and publish " +
					"the (index, address, xpub fingerprint) triple on the deposit screen so " +
					"a customer can verify their own address off our infrastructure.",
			},
			{
				owner: "commercial",
				evidence:
					"Ethereum's only free endpoint is shallow. ethereum-rpc.publicnode.com " +
					"prunes state and logs: eth_getLogs serves ~9,687 blocks and ERRORS " +
					"from ~10,156 back, eth_getBlockReceipts returns null from ~20,000 " +
					"back, headers exist only from block 15,500,000, and a deep read says " +
					'"Archive requests require a personal token". It fails LOUDLY, which ' +
					"is what makes native ETH safe to build on at all — but it leaves about " +
					"32 hours of repair budget and no contractual rate limit.",
				observedAt: "2026-11-26",
				remedy:
					"Buy one keyed endpoint — an Allnodes personal token works on the SAME " +
					"hostname already in the config — and note that a credential-only fix " +
					"is INVISIBLE IN A CODE DIFF, which is why EvmNativeScanner.preflight " +
					"verifies depth against the live endpoint at startup rather than " +
					"trusting an invoice. Until then the 32-hour ceiling is the operational " +
					"constraint and the lag alarm must fire in hours.",
			},
		],
		customer:
			"ETH deposits are not open yet. We are building our own Ethereum deposit " +
			"addresses rather than renting them, so that the machine facing the " +
			"internet can create your address without being able to spend from it. " +
			"Deposits open when we can also pay ETH back out — we do not hold coins " +
			"we cannot send. We will not hand everyone one shared address either: " +
			"Ethereum has no memo or tag, so we could not tell whose money had " +
			"arrived.",
	},
	BNB: {
		/*
		 * BNB CARRIES ONE EXTRA CAUSE THAT ETH DOES NOT, AND IT IS THE REASON
		 * BSC STAYS SHUT EVEN AFTER THE ENGINEERING IS DONE.
		 *
		 * The per-block receipts-versus-header integrity assertion catches
		 * BSC's lie on a FORWARD scan. It cannot protect a BACKFILL, and the
		 * only free independent second source (bsc-dataseed1/2) returns "limit
		 * exceeded" for eth_getLogs at any range including a single block. So
		 * there is no way to check a suspect historical range at all. BNB opens
		 * on a keyed endpoint, not on a cleverer scanner — and that is a
		 * deliberate refusal of the "open it behind a week of clean
		 * assertions" option, because a clean week of forward scanning says
		 * nothing about the day the scanner falls behind.
		 */
		rail: "BNB",
		causes: [
			{
				owner: "commercial",
				evidence:
					"bsc-rpc.publicnode.com SILENTLY LIES ABOUT ITS OWN HISTORY, measured " +
					"2026-11-26. eth_getLogs returns HTTP 200 with an empty array past " +
					"~285,546 blocks (~59.5h, bisected), and eth_getBlockReceipts returns a " +
					"zero-length array for blocks whose headers report 135 and 85 " +
					"transactions. The proof it is a lie and not a quiet range: block " +
					"134,786,112 contains tx 0xddd38fbd1d679586… whose `to` IS the BSC-USDT " +
					"contract, getLogs for that single block returns n=0, and " +
					"eth_getTransactionReceipt for that very tx honestly errors \"Archive " +
					"requests require a personal token\". A scanner more than ~2.5 days " +
					"behind reads 'no deposits', marks the range clean, advances, and the " +
					"money is gone with no error in any log.",
				observedAt: "2026-11-26",
				remedy:
					"Buy a keyed BSC endpoint. Do NOT clear this by pointing at " +
					"bsc-dataseed1/2 — they are honest for balances and blocks but return " +
					"'limit exceeded' for eth_getLogs at any range, so they cannot audit a " +
					"historical window either. EVM_ENDPOINT_DENYLIST refuses both by name, " +
					"so the rail cannot be opened by re-pointing a URL at what we already " +
					"have.",
			},
			{
				owner: "engineering",
				evidence:
					"Everything in the ETH entry applies unchanged: no signer loop, no " +
					"broadcast runner, no fee postings, no week of clean scanning and no " +
					"off-host address monitor. One signer procedure and one runner cover " +
					"all three EVM chains, because the same secp256k1 account serves all " +
					"of them — customer N's ETH, BNB and POL deposit address is the SAME " +
					"address by construction.",
				observedAt: "2026-11-26",
				remedy: "Same work as ETH; it is not duplicated per chain.",
			},
		],
		customer:
			"BNB deposits are not open yet. We are building our own BNB Chain deposit " +
			"addresses rather than renting them, so that the machine facing the " +
			"internet can create your address without being able to spend from it. " +
			"BNB Chain also needs a paid data provider before we will trust what we " +
			"read from it: the free one we have can report an empty history as though " +
			"nothing had arrived, and we will not run a deposit rail on that. We will " +
			"not use one shared address either — BNB Chain has no memo or tag, so we " +
			"could not tell whose money had arrived.",
	},

	/*
	 * SOL: FOUR CAUSES, AND THE CUSTODY MODEL UNDER THEM HAS CHANGED.
	 *
	 * WHAT THIS ENTRY USED TO SAY, AND WHY IT NO LONGER DOES. It recorded two
	 * BitGo facts: the SOL wallet answers the address POST with HTTP 202 and
	 * `{"error":"wallet pending on-chain initialization"}` until it is
	 * rent-funded (SOL_ACTIVATION still holds those figures, and they are still
	 * accurate), and this service had no consolidation code at all. Both were
	 * true. Neither is the reason the rail is shut any more, because SOL is no
	 * longer going to BitGo: SOL is now a SELF-CUSTODIED rail built on an
	 * address pool (soladdresspool.ts) and an offline signer, for the same
	 * reason BLOCK is — ed25519 under SLIP-0010 has no watch-only derivation,
	 * so deriving an address IS holding the key that spends it, and the
	 * internet-facing host must not hold that.
	 *
	 * THE SECOND OLD CAUSE WOULD NOW BE A LIE, WHICH IS WHY IT IS REWRITTEN
	 * RATHER THAN LEFT ALONE. `grep -n consolidat src/` no longer "returns
	 * comments and no call site": solconsolidation.ts exists, plans batched
	 * sweep-to-close transactions, declares a dust floor, and records the
	 * accounts it refuses to sweep. A blocker that describes code which has
	 * since been written is a record nobody can trust, and it was true in the
	 * safe direction only by luck. What is STILL missing is everything between
	 * a plan and a confirmed transaction — a signer, a broadcast runner, ledger
	 * postings — plus the chain reads the deposit half needs.
	 *
	 * THE ORDER OF THESE CAUSES IS NOT THE ORDER OF THEIR COST. The cheapest
	 * one to clear (load a pool batch) is the one that makes the rail LOOK
	 * open, because a loaded pool can issue addresses immediately. That is the
	 * one-way door in its modern form, and solrail.ts refuses to start if this
	 * entry is emptied while the rail is still unready — the gate is in code,
	 * not in this comment. See SOL_RAIL_REQUIREMENTS, which names the same
	 * facts as checkable preconditions.
	 */
	SOL: {
		rail: "SOL",
		causes: [
			{
				owner: "engineering",
				evidence:
					"The withdrawal half stops at a plan. solconsolidation.ts composes " +
					"UNSIGNED sweep batches (8 sources per transaction, fee payer = the hot " +
					"account, amount = the full balance so the account closes), and nothing " +
					"signs, submits or books them. PayoutRail assumes a synchronous send, " +
					"so an offline signer is a different shape and is new code. Sweep-to- " +
					"close itself is unverified by us: `getMinimumBalanceForRentExemption(0)` " +
					"= 650240 lamports is measured on three endpoints, but that a " +
					"full-balance transfer closes a 0-byte account and recovers every " +
					"lamport is documented behaviour we have not reproduced, because the " +
					"work that designed this rail was not permitted to submit a transaction.",
				observedAt: "2026-11-26",
				remedy:
					"Demonstrate sweep-to-close on devnet (full-balance transfer closes the " +
					"account; a partial sweep leaving under 650240 lamports fails for rent), " +
					"then once with a real small amount on mainnet, then build the broadcast " +
					"runner — idempotent on the batch's proposalKey, and posting BOTH " +
					"movements of every sweep including the fee, or reconciliation grows a " +
					"shortfall that halts the asset. Record the result in SOL_RAIL_EVIDENCE.",
			},
			{
				owner: "engineering",
				evidence:
					"The deposit half does not exist. There is no SOL ChainAdapter: nothing " +
					"reads a balance, nothing attributes an arrival, and a balance delta " +
					"carries no transaction signature — which IncomingPayment.txid requires " +
					"and idempotency depends on. Crediting an unattributed delta would break " +
					"'credited exactly once' on the first day.",
				observedAt: "2026-11-26",
				remedy:
					"Build the scanner: getMultipleAccounts over ISSUED pool addresses only, " +
					"at `finalized` commitment pinned to a slot, with getSignaturesForAddress " +
					"used solely to attribute a detected delta to a signature, every history " +
					"read gated on resumeSlot >= getFirstAvailableBlock() and halting " +
					"otherwise. A delta with no attributed signature is recorded unreadable " +
					"and credits nothing.",
			},
			{
				owner: "commercial",
				evidence:
					"No Solana endpoint we have can carry a deposit rail, measured " +
					"2026-11-26. solana-rpc.publicnode.com silently truncates its signature " +
					"index to ~2.5 days — n=3 at HTTP 200 for an account where " +
					"api.mainnet-beta returns n=1000, and getTransaction returns null rather " +
					"than an error at 17.9d/68.5d/150.7d/160.5d — and caps " +
					"getMultipleAccounts at 10 accounts, i.e. 100 round trips per pass over " +
					"a 1000-address pool. api.mainnet-beta accepts 100 accounts but returned " +
					"HTTP 429 on 11 of 25 burst calls. Our own /account/api/sol/rpc relay " +
					"inherits publicnode (SOLANA_RPC is unset) AND sits behind the shared " +
					"login limiter, where a polling scanner could lock real users out.",
				observedAt: "2026-11-26",
				remedy:
					"Buy one keyed Solana endpoint and set CHAIN_SOL_URL to it. " +
					"SOL_ENDPOINT_DENYLIST in solrail.ts refuses the three unsafe ones by " +
					"name, so this cannot be cleared by pointing at what we already have.",
			},
			{
				owner: "operator",
				evidence:
					"sol_address_pool is empty and there is no signer-host procedure: no " +
					"batch has been derived from m/44'/501'/i'/0', and no compiled " +
					"hot-address allow-list exists for the host that would sign sweeps. " +
					"Without source re-derivation and that allow-list the offline step is " +
					"theatre — a compromised exchange host would simply propose a sweep of " +
					"every customer account to the attacker's address.",
				observedAt: "2026-11-26",
				remedy:
					"Stand the SOL signer host up alongside the BLOCK wallet host that " +
					"already runs this procedure, derive a batch, compare its SHA-256 by " +
					"eye, and load it with `node dist/src/solpoolcli.js --from batch.json`. " +
					`Publish the ${SOL_MINIMUM_DEPOSIT_LAMPORTS} lamport minimum deposit ` +
					`(derived from the ${SOL_SWEEP_DUST_FLOOR_LAMPORTS} lamport dust floor) ` +
					"on the deposit screen at the same time.",
			},
		],
		customer:
			"SOL deposits are not open yet. We are building our own Solana deposit " +
			"addresses rather than renting them, because on Solana the ability to " +
			"create an address is the ability to spend from it, and that must not sit " +
			"on an internet-facing machine. Deposits open when we can also pay SOL " +
			"back out — we do not hold coins we cannot send.",
	},
};

/**
 * The customer sentence per rail, which is all `settleable()` ever wanted.
 *
 * DERIVED, not a second table. It was the only table here, and growing it in
 * place would have put the operator's evidence into a string the UI prints.
 */
export const RAIL_REFUSALS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(
		Object.entries(RAIL_BLOCKERS).map(([rail, b]) => [rail, b.customer]),
	),
);

/**
 * IS A DEPOSIT ADDRESS ON THIS RAIL KNOWN TO BE REFUSED?
 *
 * Asked BEFORE the custodian is called, which is the point. Until this existed
 * the deposit page fired three doomed BitGo requests on every load — the
 * service's log shows the same ETH 403, BNB 403 and SOL 202 repeating every
 * few minutes, for a real customer, forever — and then showed that customer a
 * generic "no address is provisioned". So this is both the honest answer and
 * three fewer round trips on the page that is already failing them.
 *
 * A TOKEN INHERITS ITS CHAIN'S BLOCKER, by the same rule `settleable` uses: a
 * USDT.ERC20 deposit address IS an Ethereum address, so it is blocked by
 * Ethereum's 403. `USDT.TRC20` is not blocked, because the TRX wallet
 * demonstrably derives addresses (lastChainIndex {"0":1}, one of them labelled
 * for a real account).
 *
 * UNKNOWN IS NOT BLOCKED. A rail with no entry here returns undefined and the
 * caller goes on to ask the custodian, exactly as before. This table records
 * what has been MEASURED; it is not an allowlist, and treating silence as a
 * refusal would shut working chains the day someone forgot to add one.
 *
 * TOTAL ON PURPOSE — IT CANNOT THROW. `gasAssetFor` and `assetDef` both throw
 * on an unknown asset or a mismatched network, and this is called with raw
 * query parameters on the deposit route. A throw here would turn a cosmetic
 * lookup into a 500 on the one screen a customer is already struggling with,
 * and the request's real error (handled downstream, with the right status and
 * the right wording) would never be reached. So a lookup it cannot resolve
 * degrades to "nothing known", which is the honest answer.
 */
export function railBlocker(
	asset: string,
	network?: string | undefined,
): RailBlocker | undefined {
	let sym: string;
	try {
		sym = settlementAsset(asset);
	} catch {
		return undefined;
	}
	let anchor = sym;
	try {
		const net =
			network === undefined || network === "" ? networkOf(asset) : network;
		anchor = gasAssetFor(sym, net);
	} catch {
		// A bad asset/network pair is someone else's error to report. Fall back
		// to the settlement asset so a single-chain rail is still recognised.
		anchor = sym;
	}
	return RAIL_BLOCKERS[anchor] ?? RAIL_BLOCKERS[sym];
}

/** Every rail with an outstanding blocker, for operator output. */
export function blockedRails(): readonly RailBlocker[] {
	return Object.values(RAIL_BLOCKERS).filter((b) => b.causes.length > 0);
}

/**
 * ASSETS ADMITTED BY NAMED EXCEPTION, each carrying the reason it is one.
 *
 * BLOCK does not pass the honest test and is admitted anyway. Both halves are
 * currently broken: deposits were closed at the probe ("our BLOCK node is
 * unreachable"), and the payout runner reports every cycle that "BLOCK: custom
 * has no payout rail yet — withdrawals for it stay unactioned". A strictly
 * honest gate closes all twelve BLOCK markets, which would be a severe
 * regression on the one quote this venue is built around.
 *
 * THE EXCEPTION IS NAMED RATHER THAN ABSENT ON PURPOSE. An absent check would
 * mean the new gate's first act was to lie about BLOCK; a named one keeps the
 * caveat attached to the verdict, so operator output and the UI can say "open,
 * with a known payout gap" instead of "open". The missing BLOCK payout rail is
 * a real bug and is not fixed by listing it here.
 *
 * WHY THIS IS A RECORD AND NOT A STRING, WHICH IS WHAT IT WAS.
 *
 * The paragraph above was already written and the caveat was already produced
 * by `settleable()` — and then DROPPED. `buildMarkets` read `.ok` and `.why`
 * and nothing else, `Market` had no field to put it in, and `grep -rn caveat
 * src/` found one producer and no consumer. So the nine BLOCK-quoted open
 * markets plus BLOCK-USDT published `state:"open", closed:null` with no
 * qualification anywhere — the exception had been taken and the promise that
 * justified it had not been kept.
 *
 * It is also two different sentences to two different readers, which is the
 * other half of why one string could not work:
 *
 *   `caveat` is the qualification that travels WITH THE VERDICT, onto the
 *   market row and the order ticket. It is what is true about trading the
 *   asset, in the words a customer reads.
 *
 *   `deposit` is what the DEPOSIT SCREEN says. Separate because the deposit
 *   question is narrower ("why is there no address") and because that screen's
 *   alternative was the generic "no address is provisioned for this account
 *   yet" paragraph that RAIL_BLOCKERS exists to replace — BLOCK reached it by
 *   falling through both tables.
 *
 *   `rationale` is the operator's record of why the exception was granted. It
 *   is never shown to a customer; it explains a decision, not a condition.
 *
 * NOT A RAIL_BLOCKERS ENTRY, DELIBERATELY. A blocker shuts the rail: deposits.ts
 * answers from it BEFORE asking the custodian, so putting BLOCK there would
 * make a loaded address pool unreachable and turn a rail that works whenever
 * the node is up into one that is shut by a table. BLOCK's deposit state is a
 * live condition, measured per request by the node probe (see publicapi's
 * `provisionFromNode`); this is the sentence for when that probe has left the
 * customer with nothing.
 */
export interface SettlementException {
	/** Operator-facing: why the exception was granted at all. */
	readonly rationale: string;
	/**
	 * Customer-facing: the qualification published beside the open verdict, on
	 * every market with this asset as a leg.
	 */
	readonly caveat: string;
	/** Customer-facing: what the deposit screen says when there is no address. */
	readonly deposit: string;
	readonly observedAt: string;
}

export const SETTLEMENT_EXCEPTIONS: Readonly<Record<string, SettlementException>> = {
	BLOCK: {
		rationale:
			"BLOCK is this venue's own asset and its markets predate this gate. A " +
			"strictly honest gate would close all ten of them, which is a worse " +
			"outcome than publishing the gap. The missing automated payout rail is " +
			"a real bug (payoutrunnercli skips every non-BitcoinRpcAdapter, and " +
			"BLOCK uses blockAdapterFromEnv) and is not fixed by this entry.",
		caveat:
			"BLOCK moves on our own chain, and that rail is only half automatic. " +
			"Deposits depend on our BLOCK node being reachable and on a loaded " +
			"address pool, and withdrawals are released by an operator rather than " +
			"by a payout runner, so they are not instant. Trading, balances and " +
			"cancels are unaffected.",
		deposit:
			"BLOCK deposit addresses come from our own node, and we could not get " +
			"one for you just now — either the node is unreachable or its address " +
			"pool is empty. Nothing is lost and nothing is pending: there is simply " +
			"no address to show, and we will not show one we are not certain of. " +
			"BLOCK withdrawals are released by an operator rather than " +
			"automatically, so they can take longer than other assets.",
		observedAt: "2026-11-26",
	},
};

/**
 * The exception record for an asset, resolving a token to its settlement asset.
 *
 * Total, like `railBlocker` and for the same reason: it is reached from HTTP
 * handlers holding raw query parameters, where a throw would turn a cosmetic
 * lookup into a 500 on a screen that is already failing someone.
 */
export function settlementException(
	asset: string,
): SettlementException | undefined {
	try {
		return SETTLEMENT_EXCEPTIONS[settlementAsset(asset)];
	} catch {
		return undefined;
	}
}

export type Settleable =
	| {
			readonly ok: true;
			readonly rail: string;
			/**
			 * "OPEN, WITH A KNOWN GAP" — and it must reach a reader.
			 *
			 * Present only for an asset admitted by SETTLEMENT_EXCEPTIONS. A
			 * verdict with a caveat its consumer discards is worse than no
			 * caveat: it reads as a check that was performed. So `buildMarkets`
			 * copies it onto `Market.caveat`, `/public/markets` publishes it,
			 * the market row and the order ticket print it, and a test asserts
			 * that an open market with a caveated leg carries it all the way to
			 * the wire. That chain is the whole reason the field exists.
			 */
			readonly caveat?: string;
	  }
	| { readonly ok: false; readonly why: string };

/**
 * CAN THIS ASSET BE CREDITED AND PAID?
 *
 * Four clauses, in order, each failing with the sentence the UI will print:
 *
 *   (a) the ledger knows it, with integer decimals;
 *   (b) every one of its chains is priced in LIVE_FEES, so a withdrawal cannot
 *       throw "not priced" after the customer already holds the balance;
 *   (c) at least one of its rails is PROVEN — a deposit address has been minted
 *       on it and a payout route exists;
 *   (d) the asset that pays that rail's gas is either the asset itself or an
 *       asset that is itself settleable. A token whose gas asset we cannot
 *       custody is a token we cannot send.
 *
 * TOKEN RAILS INHERIT THEIR GAS ASSET'S ADDRESS DERIVATION, and that is not an
 * assumption — it is how the live custodian behaves. USDT.ERC20 and USDC.ERC20
 * share BitGo wallet 6b06f02a with ETH and inherit its 403; USDT.SOL and
 * USDC.SOL share 6b06f053 and inherit SOL's "pending initialization". The
 * converse is what admits the stablecoins: the TRX wallet demonstrably derives
 * addresses, so the TRC-20 rail that hangs off it does too.
 */
export function settleable(symbol: string, seen: readonly string[] = []): Settleable {
	const sym = settlementAsset(symbol);
	const def = ASSETS[sym];
	if (def === undefined) {
		return { ok: false, why: `${sym} is not an asset this ledger can account for.` };
	}
	if (!Number.isInteger(def.decimals) || def.decimals < 0) {
		return { ok: false, why: `${sym} has no confirmed decimals, so no balance in it can be trusted.` };
	}

	const rails = custodyIds(sym);
	const unpriced = rails.filter((id) => LIVE_FEES[id] === undefined);
	if (unpriced.length > 0) {
		return {
			ok: false,
			why:
				`${sym} cannot be withdrawn over ${unpriced.join(", ")}: that chain has ` +
				"no fee priced, so a withdrawal would be refused after the balance was credited.",
		};
	}

	const exception = SETTLEMENT_EXCEPTIONS[sym];
	if (exception !== undefined) {
		return { ok: true, rail: rails[0]!, caveat: exception.caveat };
	}

	// GUARD AGAINST A GAS CYCLE. Two tokens that each paid the other's gas
	// would recurse forever; no such pairing exists today, and the day someone
	// adds one this should refuse rather than hang.
	if (seen.includes(sym)) {
		return { ok: false, why: `${sym}'s gas asset chain is circular, so no rail can be proven.` };
	}

	const refusals: string[] = [];
	for (const id of rails) {
		const gas = gasAssetFor(sym, networkOf(id));
		// A token rail is proven by its gas asset's chain — the deposit address
		// is an address on that chain. A single-chain asset is proven by itself.
		const anchor = gas === sym ? sym : gas;
		const proven = PROVEN_RAILS[anchor];
		if (proven === undefined) {
			refusals.push(
				RAIL_REFUSALS[anchor] ??
					`no deposit address has ever been minted on ${anchor}, so ${id} cannot take a deposit.`,
			);
			continue;
		}
		if (gas !== sym) {
			const g = settleable(gas, [...seen, sym]);
			if (!g.ok) {
				refusals.push(`${id} pays its gas in ${gas}, and ${g.why}`);
				continue;
			}
		}
		return { ok: true, rail: id };
	}

	return {
		ok: false,
		// One sentence per rail, because "USDT is closed" is useless when the
		// three rails are shut for three different reasons.
		why: refusals.join(" "),
	};
}

/* ------------------------------------------------------------ expressibility */

/**
 * HOW BIG ONE WHOLE UNIT OF AN ASSET IS, AS A POWER OF TEN, IN SATOSHIS.
 *
 * READ THIS BEFORE USING IT FOR ANYTHING. It is an ORDER OF MAGNITUDE, accurate
 * to a factor of ten. It exists for exactly one purpose: so the market
 * generator can decide whether a price for a pair is EXPRESSIBLE as an integer
 * at all, and how many price decimals the pair needs. A price computed from it
 * would be wrong by up to 10x. It is never served over HTTP and never reaches a
 * generated page, and a test asserts that.
 *
 * DENOMINATED IN SATOSHIS, NOT DOLLARS, AND BLOCK HAS NO ENTRY. Both of those
 * are the hard product rule — "never render a USD price for BLOCK or any
 * BLOCK-20 token, including via a crypto conversion" — enforced by
 * construction rather than by a reviewer noticing. A dollar table would put a
 * number for BLOCK in the repository, one multiplication away from the thing
 * that must not exist. Omitting BLOCK also has a useful second effect: since
 * `orient()` refuses any pair whose magnitude it does not know, BLOCK can only
 * appear in pairs that are already pinned, so this change mints NO new BLOCK
 * market and the forbidden surface cannot widen by one pair through an array
 * reorder.
 *
 * (The pre-existing BLOCK-USDT and USDC-BLOCK markets are each a USD price for
 * BLOCK by one inversion. That tension predates this file and is raised with
 * the operator rather than quietly settled here.)
 */
export interface Magnitude {
	/** log10 of one whole unit, measured in satoshis, rounded to an integer. */
	readonly value: number;
	readonly asOf: string;
	readonly source: string;
}

const EST = "operator's working price table, BTC basis $90,000";

export const UNIT_SCALE: Readonly<Record<string, Magnitude>> = {
	// 1 BTC is 10^8 satoshi by definition. The only exact entry here.
	BTC: { value: 8, asOf: "2026-11-25", source: "definition: 1 BTC = 10^8 satoshi" },
	ETH: { value: 7, asOf: "2026-11-25", source: EST },   // ~3.3e6 sat
	SOL: { value: 5, asOf: "2026-11-25", source: EST },   // ~1.6e5 sat
	BNB: { value: 6, asOf: "2026-11-25", source: EST },   // ~6.7e5 sat
	USDT: { value: 3, asOf: "2026-11-25", source: EST },  // ~1.1e3 sat
	USDC: { value: 3, asOf: "2026-11-25", source: EST },
	XRP: { value: 3, asOf: "2026-11-25", source: EST },   // ~5.6e2 sat
	TRX: { value: 3, asOf: "2026-11-25", source: EST },   // ~3.3e2 sat
	DOGE: { value: 2, asOf: "2026-11-25", source: EST },  // ~1.1e2 sat
	PERBUG: { value: 0, asOf: "2026-11-25", source: EST },// ~1 sat
	RTM: { value: 0, asOf: "2026-11-25", source: EST },   // ~0.6 sat
	PEP: { value: -1, asOf: "2026-11-25", source: EST },  // ~0.2 sat
	DINGO: { value: -4, asOf: "2026-11-25", source: EST },// ~1e-4 sat
	// BLOCK: deliberately absent. See the note above.
};

/**
 * THE PRICE WINDOW, AND WHY IT HAS BOTH ENDS.
 *
 * A price is "quote base-units per ONE WHOLE unit of base, scaled by
 * 10^priceDecimals" (venue.ts). So log10 of a market's price is
 *
 *     UNIT_SCALE[base] - UNIT_SCALE[quote] + decimals(quote) + priceDecimals
 *
 * THE FLOOR, 2, is about tick resolution. At an exponent of 2 the only prices
 * available span 100 ticks, so one tick is ~1% of the price; below 0 the honest
 * price is less than one base unit of the quote, `parse()` refuses it rather
 * than rounding (amount.ts), and `placeOrder` refuses zero — a market in which
 * no order can be entered at all. That is not hypothetical: DINGO-USDT is live
 * today at an exponent of -1 and no order has ever been priceable in it.
 *
 * THE CEILING, 18, is about the matcher. Order prices are compared in SQLite,
 * whose INTEGER is int64 and which CLAMPS rather than erroring: verified
 * against this repo's better-sqlite3, both '9300000000000000000' and
 * '9500000000000000000' CAST to 9223372036854775807 and therefore compare
 * EQUAL. A buy would cross a sell priced above its own limit while having
 * reserved only its own lower limit. venue.ts no longer compares prices that
 * way — it uses a fixed-width `price_key` — but the ceiling stays, because a
 * price needs headroom above the estimate this table provides and because
 * 10^18 quote base-units is already an absurd price.
 *
 * NEW markets are given priceDecimals to land at or above TARGET, which is four
 * decades — about four significant digits of tick resolution. Existing markets
 * keep priceDecimals 0 whatever their exponent; see PINNED_PRICE_DECIMALS.
 */
export const PRICE_EXP_FLOOR = 2;
export const PRICE_EXP_TARGET = 4;
export const PRICE_EXP_CEILING = 18;

/** log10 of the price of `base` in `quote`, at priceDecimals 0. undefined if unknown. */
export function priceExponent(base: string, quote: string): number | undefined {
	const b = UNIT_SCALE[base];
	const q = UNIT_SCALE[quote];
	const qd = ASSETS[quote]?.decimals;
	if (b === undefined || q === undefined || qd === undefined) return undefined;
	return b.value - q.value + qd;
}

/**
 * The priceDecimals a NEW market needs: enough to lift a cheap base's price off
 * the floor, and zero whenever the pair is already comfortable.
 *
 * Never negative. Scaling a price DOWN would discard resolution the quote's own
 * decimals already provide, and there is no market where that is wanted.
 */
export function scaleFor(exponent: number): number {
	return exponent >= PRICE_EXP_TARGET ? 0 : PRICE_EXP_TARGET - exponent;
}

export type Orientation =
	| {
			readonly ok: true;
			readonly base: string;
			readonly quote: string;
			readonly priceDecimals: number;
			/** log10 of the price, including priceDecimals. For operator output. */
			readonly exponent: number;
	  }
	| { readonly ok: false; readonly why: string };

/**
 * WHICH WAY ROUND SHOULD THIS PAIR BE WRITTEN?
 *
 * Replaces first-orientation-wins deduplication, which was safe only by
 * accident of `Object.keys(MIN_BASE)` order. It happened to emit ETH-BTC rather
 * than BTC-ETH, and that mattered: BTC-ETH prices at ~3e19 wei, past the int64
 * clamp above, while ETH-BTC prices at ~3e6 satoshi. The old generator picked
 * the safe side by luck; this picks it by construction.
 *
 * At least one side must be a quote asset — a pair of two tail coins is not a
 * market this venue offers. Where both sides are quotes, the senior one becomes
 * the quote. Where an orientation's price would exceed the ceiling, the other
 * one is used; where both would, the pair is refused and the arithmetic is the
 * reason.
 */
export function orient(a: string, b: string): Orientation {
	if (a === b) return { ok: false, why: `${a} cannot trade against itself.` };
	if (!isQuoteAsset(a) && !isQuoteAsset(b)) {
		return {
			ok: false,
			why: `neither ${a} nor ${b} is a quote asset, so this venue does not list the pair.`,
		};
	}

	const candidates: { base: string; quote: string; exponent: number }[] = [];
	for (const [base, quote] of [
		[a, b],
		[b, a],
	] as const) {
		if (!isQuoteAsset(quote)) continue;
		const e = priceExponent(base, quote);
		if (e === undefined) continue;
		if (e > PRICE_EXP_CEILING) continue;
		candidates.push({ base, quote, exponent: e });
	}

	if (candidates.length === 0) {
		const known = UNIT_SCALE[a] !== undefined && UNIT_SCALE[b] !== undefined;
		if (!known) {
			const missing = UNIT_SCALE[a] === undefined ? a : b;
			return {
				ok: false,
				why:
					`${missing} has no declared magnitude, so the generator cannot tell ` +
					"whether a price for this pair is expressible. Only pairs pinned by " +
					"an existing live symbol are listed.",
			};
		}
		const ea = priceExponent(a, b);
		const eb = priceExponent(b, a);
		return {
			ok: false,
			why:
				`no price for ${a}/${b} fits: ${b}-quoted it needs 10^${String(eb)} and ` +
				`${a}-quoted 10^${String(ea)}, both past the 10^${PRICE_EXP_CEILING} ` +
				"ceiling the matcher can compare safely.",
		};
	}

	// Both work: seniority decides, so the yardstick is the quote.
	candidates.sort((x, y) => seniority(x.quote) - seniority(y.quote));
	const pick = candidates[0]!;
	const p = scaleFor(pick.exponent);
	return {
		ok: true,
		base: pick.base,
		quote: pick.quote,
		priceDecimals: p,
		exponent: pick.exponent + p,
	};
}

/**
 * Is a market's price expressible with the priceDecimals it was given?
 *
 * Used as the CHECK that priceDecimals was chosen correctly, not as a reason to
 * refuse a pair — the whole point of priceDecimals is that almost nothing has
 * to be refused. Returns a sentence when it is not, so the refusal is
 * publishable; `undefined` when the magnitude is unknown and the question
 * cannot be asked (BLOCK, by design).
 */
export function expressible(
	base: string,
	quote: string,
	priceDecimals: number,
): { readonly ok: boolean; readonly exponent: number; readonly why: string } | undefined {
	const e = priceExponent(base, quote);
	if (e === undefined) return undefined;
	const exp = e + priceDecimals;
	if (exp < PRICE_EXP_FLOOR) {
		return {
			ok: false,
			exponent: exp,
			why:
				`a ${base} price cannot be expressed in ${quote}: one ${base} is worth ` +
				`about 10^${String(exp)} of the smallest unit this market prices in, so ` +
				"the honest price rounds to nothing.",
		};
	}
	if (exp > PRICE_EXP_CEILING) {
		return {
			ok: false,
			exponent: exp,
			why:
				`a ${base} price in ${quote} needs 10^${String(exp)} units, past the ` +
				"range the matcher can compare safely.",
		};
	}
	return { ok: true, exponent: exp, why: "" };
}
