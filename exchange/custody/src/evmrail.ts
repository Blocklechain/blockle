// -----------------------------------------------------------------------------
// THE EVM RAIL'S GATE — assembly, preconditions, and the refusal in code.
//
// WHY THIS FILE EXISTS AT ALL.
//
// Three pieces of a self-custodied EVM rail now exist in this service: an xpub
// parser and deriver (evmxpub.ts), a per-customer index (evmaddressindex.ts),
// and a durable native-value scanner (evmscan.ts). Every one of them is tested.
// None of them opens the rail, and the dangerous moment is the one where
// somebody reasonably concludes that together they do.
//
// It is a much easier mistake to make here than it was for SOL, and the reason
// is the thing that makes this design good. SOL needs an operator ceremony
// before it can issue even one address, so an un-ready SOL rail is visibly
// un-ready. EVM needs nothing but a string: paste `EVM_ACCOUNT_XPUB` into an
// env file and this process can derive a correct, checksummed, per-customer
// deposit address for every customer on Ethereum, BSC and Polygon, instantly,
// with no human in the loop and no second host involved. The cheap half is
// free, infinite and silent. That is precisely the one-way door rule 4 exists
// to prevent: issuing an address is taking a deposit, and taking a deposit the
// venue cannot send back is the worst state available.
//
// So the gate is mechanical rather than advisory. `evmRailReadiness()` asks
// every requirement, `EvmDepositRail.issue()` throws while any one is unmet,
// and `assertEvmRailBlockedUnlessProven()` checks the other direction — that
// while the rail is unready, settlement.ts still records it as blocked and does
// not record it as proven. Deleting the RAIL_BLOCKERS entry does not open the
// rail; opening the rail does not stop the venue advertising it as shut. Both
// have to be true together or the service refuses to start. This mirrors
// solrail.ts deliberately: one shape, learned once.
//
// WHAT WOULD BE WRONG WITH TRUSTING THE BLOCKERS TABLE ALONE: it is a
// hand-maintained record of measurements, and the one thing a measurement
// cannot know is whether the code it describes has since been written. The ETH
// blocker said for weeks that the custodian would not mint an address — true,
// measured, and no longer the reason the rail is shut. A table that describes
// superseded code is a lie in whichever direction the next edit happens to
// take it.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO.
//
//   * It does not read any wallet registry's DEFAULT_ENDPOINTS. The four
//     Blockle wallets each ship their own EVM endpoint defaults and they
//     DISAGREE with each other; one of them (services/accounts/src/
//     liverunner.js, the Polygon entry) still ships https://polygon-rpc.com,
//     which answers "API key disabled, reason: tenant disabled" today. A
//     wallet showing a stale balance is a cosmetic bug. A deposit scanner on a
//     dead endpoint credits nothing and reports nothing. Custody declares its
//     own URL or it has none — see `EVM_URL_VARS`.
//   * It does not hold, read, accept or derive a private key, an xprv, a seed
//     or a mnemonic, and `readEvmAccountFromEnv` treats an xprv in the xpub
//     variable as a DISCLOSURE INCIDENT rather than a typo. See that function.
//   * It does not open ERC-20. See `ERC20_DEFERRAL`, which is a record of a
//     decision rather than a TODO.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";

import type { Database } from "better-sqlite3";

import { ASSETS } from "./assets";
import {
	ChainError,
	EvmRpcAdapter,
	JsonRpc,
	type ChainAdapter,
	type EvmIncomingSource,
} from "./chains";
import { EvmAddressIndex, FIRST_CUSTOMER_INDEX } from "./evmaddressindex";
import { EvmNativeScanner, EVM_CHAIN_RULES, type EvmChainRule } from "./evmscan";
import { parseXpub, safeDescribe, EVM_ACCOUNT_PATH, type EvmXpub } from "./evmxpub";

import { PROVEN_RAILS, RAIL_BLOCKERS, type BlockerOwner } from "./settlement";

export class EvmRailError extends Error {
	constructor(
		message: string,
		readonly status = 503,
	) {
		super(message);
		this.name = "EvmRailError";
	}
}

/* ------------------------------------------------------------ configuration */

/**
 * WHERE EACH CHAIN'S ENDPOINT COMES FROM, declared here and nowhere else.
 *
 * Two spellings are accepted for BSC and that is a deliberate concession to
 * how people actually type: the SETTLEMENT ASSET is BNB, so the existing
 * `CHAIN_<SYM>_URL` convention in chains.ts would make it CHAIN_BNB_URL, while
 * every operator, every provider's documentation and every URL on earth calls
 * the chain BSC. Rather than pick one and watch somebody set the other and get
 * a silently absent rail, both are read — and if both are set to DIFFERENT
 * values the rail refuses to start, because at that point nobody knows which
 * chain the scanner is reading and "probably the same one" is not a custody
 * answer.
 */
export const EVM_URL_VARS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	ETH: Object.freeze(["CHAIN_ETH_URL"]),
	BNB: Object.freeze(["CHAIN_BSC_URL", "CHAIN_BNB_URL"]),
	POL: Object.freeze(["CHAIN_POL_URL", "CHAIN_POLYGON_URL"]),
});

/** The account xpub, and the proof that it belongs to the signer's seed. */
export const EVM_XPUB_VAR = "EVM_ACCOUNT_XPUB";
export const EVM_VECTORS_VAR = "EVM_ACCOUNT_VECTORS";

/**
 * The venue's own declared addresses per chain — hot, gas, sweep destination.
 *
 * ADDRESSES, NEVER KEYS. The keys for these live on the signer host. They are
 * declared rather than derived here for the same reason the BLOCK treasury is
 * declared: the reconciler must count them as custody, and an operator typing
 * the address they actually funded is more trustworthy than this process
 * guessing which reserved index the signer used.
 */
export const EVM_HOT_VARS: Readonly<Record<string, string>> = Object.freeze({
	ETH: "CHAIN_ETH_HOT_ADDRESS",
	BNB: "CHAIN_BSC_HOT_ADDRESS",
	POL: "CHAIN_POL_HOT_ADDRESS",
});

/* ----------------------------------------------------------- the deferral */

/**
 * ERC-20 IS DEFERRED, AND THIS IS THE RECORD OF THAT DECISION.
 *
 * Written as an exported, dated record rather than a comment or a TODO because
 * the question "why can I deposit ETH but not USDT on Ethereum?" will be asked
 * by a customer, an operator and a reviewer, and all three deserve the same
 * answer. The task that produced this rail was explicit: ship token scanning or
 * defer it on the record, do not half-ship it.
 *
 * It is deferred for THREE reasons and no one of them is sufficient alone:
 *
 *   1. CHAIN READS. Transfer-event scanning needs a usable log backfill
 *      window. Measured on the endpoints this venue has: Ethereum prunes
 *      `eth_getLogs` at about 9,700 blocks (~32h) and then ERRORS, which is
 *      survivable; BSC returns HTTP 200 and an EMPTY ARRAY past about 285,500
 *      blocks (~59.5h), which is not. The BSC proof is specific and it is why
 *      token scanning is not merely unfinished but unsafe there: block
 *      134,786,112 contains a transaction whose `to` IS the BSC-USDT contract,
 *      `eth_getLogs` for that single block returns n=0 at HTTP 200, and
 *      `eth_getTransactionReceipt` for that same transaction honestly errors
 *      "Archive requests require a personal token".
 *
 *   2. IDEMPOTENCY. One transaction can emit several Transfer events to the
 *      same address, so the credit identity must include a log index. The
 *      plumbing for that now exists (IncomingPayment.ref, honoured by
 *      depositwatcher's node path) but nothing has ever exercised it on a
 *      token.
 *
 *   3. THE WATCHER'S FEED KEY. `runOnce` resolves a node feed by CUSTODY ID
 *      now, which it did not when this was written — that was the blocking
 *      defect and it is fixed. What is still unproven is a token adapter
 *      actually being driven through it.
 *
 * AND THE SWEEP IS STRICTLY HARDER, which is the reason it is behind native
 * even once the reads are fixed: a token deposit address holds no native coin,
 * so the hot account must DRIP gas to it before the token can move. Two
 * transactions, two signatures, two trips through the offline signer, and
 * native dust stranded at the address afterwards. Native sweeps pay their own
 * gas out of the deposit and need none of that.
 */
export const ERC20_DEFERRAL = Object.freeze({
	decidedAt: "2026-11-26",
	shipped: false,
	/** What IS proven: native-value scanning, and only that. */
	provenInstead: "native-value scanning from a durable cursor with a per-block " +
		"receipts-versus-header integrity assertion and a parentHash continuity check",
	reason:
		"ERC-20 deposit detection is Transfer-event scanning, which is a different " +
		"problem from native-balance scanning and is not proven on any endpoint this " +
		"venue has. Ethereum prunes logs at ~32h and errors; BSC returns HTTP 200 " +
		"with an empty array past ~59.5h, which a scanner cannot distinguish from a " +
		"genuinely quiet range. A token sweep additionally needs a native gas drip " +
		"to each deposit address first, which is two offline-signer trips per sweep.",
	clearsWith:
		"a keyed endpoint (an Allnodes personal token on the same hostnames, or " +
		"dRPC/Alchemy/QuickNode), the per-block integrity assertion armed as a " +
		"runtime precondition, log-index idempotency exercised end to end, and a " +
		"gas-drip step in the sweep proposal.",
} as const);

/* ------------------------------------------------------------ requirements */

/**
 * One thing that must be true before EVM deposits may open, for one chain.
 *
 * `half` is recorded because rule 4 ties the two halves together and a reader
 * will otherwise assume the deposit half can ship alone. It cannot: a rail that
 * takes a deposit it cannot send back is the worst state available. So a
 * WITHDRAWAL requirement blocks DEPOSITS too, and this field is where that is
 * written down rather than remembered.
 */
export interface EvmRailRequirement {
	readonly id: string;
	readonly half: "deposit" | "withdrawal" | "both";
	readonly owner: BlockerOwner;
	/** What has to be true. */
	readonly what: string;
	/** What goes wrong if the rail opens without it. The reason, not the rule. */
	readonly why: string;
}

export const EVM_RAIL_REQUIREMENTS: readonly EvmRailRequirement[] = Object.freeze([
	{
		id: "xpub-configured",
		half: "deposit",
		owner: "operator",
		what:
			`${EVM_XPUB_VAR} holds the account-level xpub for ${EVM_ACCOUNT_PATH}, ` +
			"exported from the signer host",
		why:
			"without it no address can be derived at all, so this is the one " +
			"requirement whose absence is loud. It is listed anyway because its " +
			"PRESENCE is what makes every other requirement here urgent: one env " +
			"line turns this process into something that can hand a deposit address " +
			"to every customer on three chains, months before anything can sweep one.",
	},
	{
		id: "xpub-proven",
		half: "deposit",
		owner: "operator",
		what:
			`${EVM_VECTORS_VAR} supplies addresses the SIGNER derived from its seed ` +
			`for ${EVM_ACCOUNT_PATH}/0..4, and they re-derive identically from the xpub`,
		why:
			"a valid xpub for the WRONG seed parses, derives and checksums " +
			"beautifully. Every address it produces is a real Ethereum address that " +
			"no key on this planet can spend. There is no symptom until a sweep is " +
			"attempted weeks later, with the deposits already stranded, and no " +
			"recovery at all. BUT BE EXACT ABOUT WHAT THIS REQUIREMENT BUYS, " +
			"because it used to claim more: the vectors are re-derived from the " +
			"CONFIGURED xpub, so vectors exported from the same wrong host pass. It " +
			"catches a stale, truncated, transposed or hand-edited vector file and a " +
			"wrong account path — not provenance. Proving provenance needs the " +
			"signer to SIGN a challenge with the key at the claimed index and this " +
			"host to verify it against the public key it derived itself, which is " +
			"new code on both sides and is part of `signer-procedure`.",
	},
	{
		id: "endpoint-usable",
		half: "both",
		owner: "commercial",
		what:
			"the chain's URL variable names an endpoint that is not on " +
			"EVM_ENDPOINT_DENYLIST",
		why:
			"the denylist is measurement, not taste. A deposit rail on an endpoint " +
			"that answers a pruned range with HTTP 200 and an empty array reads 'no " +
			"deposits', marks the range clean, advances, and loses the money with no " +
			"error in any log. There is no alert to miss because, as far as every " +
			"component can tell, nothing went wrong.",
	},
	{
		id: "scanner-clean",
		half: "deposit",
		owner: "engineering",
		what:
			"the scanner has run read-only against live tip for a full week with no " +
			"integrity halt and no cursor-lag alarm, recorded in EVM_RAIL_EVIDENCE",
		why:
			"every endpoint measurement behind this rail is a burst of 25 to 30 " +
			"calls. Sustained fitness is a different question: a per-block scan on " +
			"BSC is about 1.3 requests per second forever against a free endpoint " +
			"with no published limit, and on Ethereum a multi-hour throttle eats " +
			"directly into a 32-hour pruning budget. A week of clean reading is the " +
			"cheapest honest evidence, and it costs nothing but patience.",
	},
	{
		id: "address-monitor",
		half: "deposit",
		owner: "engineering",
		what:
			"a monitor OUTSIDE this host re-derives every issued address from its own " +
			"copy of the xpub and alarms on any mismatch with evm_address_index",
		why:
			"THIS IS THE ATTACK NO KEY DESIGN CLOSES, and the xpub model's 'it is " +
			"only a privacy artefact' framing hides it. Root on this host does not " +
			"need to sign anything to steal a new customer's first deposit: it only " +
			"has to change what that customer is SHOWN. Derivation being keyless does " +
			"not help, because the display is downstream of derivation. What does " +
			"help is that every issued address is deterministic from PUBLIC data, so " +
			"a watcher this host cannot reach or rewrite can check all of them — and " +
			"the same triple (index, address, xpub fingerprint) lets a customer verify " +
			"their own address off our infrastructure entirely.",
	},
	{
		id: "signer-procedure",
		half: "withdrawal",
		owner: "operator",
		what:
			"a signer host exists holding the seed, with a COMPILED hot-address " +
			"allow-list and per-batch value ceilings, and an operator has carried a " +
			"proposal through it end to end",
		why:
			"a signer that signs whatever the online host hands it makes the offline " +
			"step theatre: a compromised exchange host simply proposes a sweep of " +
			"every customer address to the attacker's address and the human presses " +
			"yes. Source re-derivation from the signer's own seed and a destination " +
			"allow-list compiled into the signer are not features of this design, " +
			"they ARE the design.",
	},
	{
		id: "broadcast-runner",
		half: "withdrawal",
		owner: "engineering",
		what:
			"a runner submits signed batches, idempotently on each entry's " +
			"sequenceId, and posts BOTH movements of every sweep including the gas fee",
		why:
			"PayoutRail assumes a synchronous send, so an offline signer is a " +
			"different shape and is new code. And the fee posting is not bookkeeping " +
			"neatness: omitting it makes holdings fall by amount-plus-fee while books " +
			"fall by amount, which is a small, persistent, steadily GROWING shortfall " +
			"— and a shortfall has no tolerance at any size and halts the asset. It " +
			"would be entirely self-inflicted.",
	},
]);

/** A dated, named observation that a requirement has actually been met. */
export interface EvmProof {
	readonly provenAt: string;
	readonly chain: string;
	/** What was observed. Verbatim where possible, like every other table here. */
	readonly evidence: string;
}

/**
 * THE EVIDENCE, AND IT IS EMPTY.
 *
 * Keyed by requirement id, every value undefined, because not one of these has
 * been demonstrated. A table rather than a boolean so that filling it in is the
 * same kind of act as adding to PROVEN_RAILS: dated, specific, and a deliberate
 * edit a reviewer can see in a diff.
 *
 * `xpub-configured`, `xpub-proven` and `endpoint-usable` are deliberately NOT
 * here — they are facts about the live machine, read at runtime from the
 * environment. Recording a runtime fact as a static proof is how a table starts
 * lying, and it is how a rail gets opened by an edit to a constant.
 */
export const EVM_RAIL_EVIDENCE: Readonly<Record<string, EvmProof | undefined>> = Object.freeze({
	"scanner-clean": undefined,
	"address-monitor": undefined,
	"signer-procedure": undefined,
	"broadcast-runner": undefined,
});

/* ---------------------------------------------------------------- endpoints */

/**
 * ENDPOINTS A DEPOSIT RAIL MUST NOT USE, with what was measured on each.
 *
 * A denylist and not an allowlist, for the same reason `railBlocker` treats
 * silence as "not blocked": an allowlist shuts a perfectly good endpoint the
 * day somebody forgets to add it, and the failure mode of this list is supposed
 * to be a refusal to open, not an outage. What is recorded here is what was
 * MEASURED to be unsafe, on 2026-11-26, from the box the rail would run on.
 *
 * NOTE WHICH ENDPOINT IS NOT ON THIS LIST AND WHY. ethereum-rpc.publicnode.com
 * is shallow — logs about 32 hours, receipts about 20,000 blocks — but it fails
 * LOUDLY at depth, with an error rather than an empty array. Shallow and honest
 * is survivable behind a cursor-lag alarm measured in hours. Deep and lying is
 * not survivable at all, which is the entire distinction this list encodes.
 */
export const EVM_ENDPOINT_DENYLIST: readonly {
	readonly match: string;
	readonly why: string;
}[] = Object.freeze([
	{
		match: "bsc-rpc.publicnode.com",
		why:
			"SILENTLY LIES ABOUT ITS OWN HISTORY. eth_getLogs returns HTTP 200 with " +
			"an empty array past ~285,546 blocks (~59.5h), and eth_getBlockReceipts " +
			"returns a zero-length array for blocks whose headers report 135 and 85 " +
			"transactions. The proof: block 134,786,112 contains tx " +
			"0xddd38fbd1d679586… whose `to` IS the BSC-USDT contract, getLogs for " +
			"that single block returns n=0, and eth_getTransactionReceipt for that " +
			"very tx honestly errors 'Archive requests require a personal token'. The " +
			"endpoint knows the data is pruned and reports an empty result anyway. " +
			"The per-block integrity assertion catches this on a FORWARD scan and " +
			"cannot protect a backfill, so an assertion is not enough: BSC needs a " +
			"keyed endpoint, not a cleverer scanner.",
	},
	{
		match: "bsc-dataseed",
		why:
			"Binance's official data seeds are honest and fast for balances, blocks " +
			"and receipts, and they return 'limit exceeded' for eth_getLogs at ANY " +
			"range including a single block. Keep them as an independent second " +
			"source for cross-checking a suspect range — a different operator is " +
			"exactly what you want for that — but a rail cannot be primary here.",
	},
	{
		match: "polygon-rpc.com",
		why:
			"DEAD. Answers 'API key disabled, reason: tenant disabled' with json-rpc " +
			"code -32051 and HTTP 403. It is still shipped as the chainId-137 " +
			"endpoint in services/accounts/src/liverunner.js, which is worth fixing " +
			"there regardless, and is the concrete reason custody declares its own " +
			"URL instead of inheriting a wallet registry's defaults.",
	},
	{
		match: "eth.llamarpc.com",
		why: "gone — returns a Cloudflare HTML interstitial rather than JSON.",
	},
	{
		match: "rpc.ankr.com",
		why:
			"keyless Ankr no longer exists: 'Unauthorized: You must authenticate your " +
			"request with an API key'.",
	},
	{
		match: "bsc.drpc.org",
		why:
			"'You reached Public endpoint rate limit, please upgrade to paid plan' on " +
			"the very first call.",
	},
	{
		match: "1rpc.io",
		why:
			"unfit on every axis: rate-limited after one call, rejects " +
			"eth_getBlockReceipts as a disallowed method, and caps eth_getLogs to a " +
			"50-block range.",
	},
	{
		match: "eth.drpc.org",
		why:
			"the ARCHIVE REPAIR TOOL, not a rail. Fastest endpoint measured and real " +
			"archive state works, but eth_getLogs is hard-capped at 'ranges over 100 " +
			"blocks are not supported on free plan' — about 20 minutes of chain per " +
			"call. Right for backfilling a gap by hand, wrong for following tip.",
	},
	{
		match: "/account/api/",
		why:
			"our own same-origin browser relays. They exist to solve browser CORS and " +
			"403 problems and they sit behind the shared account-login rate limiter " +
			"(30 requests / 15 min / IP, lock threshold 10) — a polling custody " +
			"scanner could trip the login lockout for real users. Custody must never " +
			"sit behind the login limiter.",
	},
	{
		match: "/px/",
		why:
			"the same-origin coin-explorer proxies. Same reasoning as /account/api/, " +
			"and none of them front an EVM chain anyway.",
	},
]);

export function checkEvmEndpoint(chain: string, url: string): { ok: boolean; why?: string } {
	const vars = EVM_URL_VARS[chain]?.join(" / ") ?? `CHAIN_${chain}_URL`;
	const u = url.trim();
	if (u === "") {
		return { ok: false, why: `${vars} is not set, so there is no chain to read` };
	}
	if (!/^https?:\/\//.test(u)) {
		return { ok: false, why: `${vars} must be http(s): ${u}` };
	}
	for (const d of EVM_ENDPOINT_DENYLIST) {
		if (u.includes(d.match)) {
			return { ok: false, why: `${d.match} must not carry a deposit rail: ${d.why}` };
		}
	}
	return { ok: true };
}

/* ---------------------------------------------------------------- readiness */

export interface EvmUnmetRequirement {
	readonly requirement: EvmRailRequirement;
	/** What was actually observed, now, on this machine. */
	readonly observed: string;
}

export interface EvmRailReadiness {
	readonly chain: string;
	readonly open: boolean;
	readonly unmet: readonly EvmUnmetRequirement[];
	/** Everything met, so operator output is not only bad news. */
	readonly met: readonly string[];
}

/**
 * Ask every requirement, against runtime facts where they exist and the
 * evidence table where they do not.
 *
 * NO SHORT-CIRCUIT. Every requirement is evaluated even after one has failed,
 * because the operator output is the point: "the rail is shut" is useless and
 * "the rail is shut for four reasons owned by three different people" is
 * actionable. Same reasoning as `RailBlocker.causes` being a list rather than a
 * single cause — a rail must not be openable by fixing the cheapest half.
 */
export function evmRailReadiness(args: {
	readonly chain: string;
	readonly endpointUrl: string;
	/**
	 * The loaded account's fingerprint, or undefined when none is configured.
	 *
	 * A FINGERPRINT RATHER THAN THE NODE, deliberately. This function is also
	 * asked the question on behalf of a process that has no account at all —
	 * the unconfigured case, which is a legitimate state with its own answer
	 * rather than a crash — so the parameter has to be optional. Making it the
	 * four-byte fingerprint rather than the parsed node means the one thing
	 * this function can accidentally put in a log line or an error string is
	 * the one value that discloses nothing: the xpub itself is a targeting list
	 * (it enumerates every customer deposit address on every EVM chain,
	 * retroactively and forever) and must stay out of readiness output.
	 */
	readonly accountFingerprint?: string | undefined;
	/** Did the signer's vector file verify against that account? */
	readonly vectorsProven: boolean;
	/** Non-undefined when the scanner has halted on an integrity failure. */
	readonly scannerHalted?: string | undefined;
	readonly evidence?: Readonly<Record<string, EvmProof | undefined>>;
}): EvmRailReadiness {
	const evidence = args.evidence ?? EVM_RAIL_EVIDENCE;
	const unmet: EvmUnmetRequirement[] = [];
	const met: string[] = [];

	for (const requirement of EVM_RAIL_REQUIREMENTS) {
		let observed: string | undefined;
		switch (requirement.id) {
			case "xpub-configured":
				if (args.accountFingerprint === undefined) {
					observed = `${EVM_XPUB_VAR} is not set, so no address can be derived`;
				}
				break;
			case "xpub-proven":
				if (args.accountFingerprint === undefined) {
					observed = "there is no account to prove";
				} else if (!args.vectorsProven) {
					observed =
						`${EVM_VECTORS_VAR} did not supply signer-derived addresses, so ` +
						"nothing shows the configured xpub belongs to the seed that will " +
						"have to sweep these deposits";
				}
				break;
			case "endpoint-usable": {
				const e = checkEvmEndpoint(args.chain, args.endpointUrl);
				if (!e.ok) observed = e.why ?? "unusable endpoint";
				break;
			}
			case "scanner-clean": {
				const p = evidence[requirement.id];
				if (p === undefined) {
					observed = "no dated proof is recorded in EVM_RAIL_EVIDENCE";
				} else if (args.scannerHalted !== undefined) {
					/*
					 * A RECORDED WEEK DOES NOT SURVIVE A LIVE HALT. The proof is
					 * about the past; the halt is about now, and a halted cursor
					 * means the endpoint has been caught under-reporting since.
					 * Letting dated evidence outvote a live integrity failure is
					 * exactly how a stale table opens a broken rail.
					 */
					observed = `the scanner is halted: ${args.scannerHalted}`;
				}
				break;
			}
			default: {
				const p = evidence[requirement.id];
				if (p === undefined) observed = "no dated proof is recorded in EVM_RAIL_EVIDENCE";
				break;
			}
		}
		if (observed === undefined) met.push(requirement.id);
		else unmet.push({ requirement, observed });
	}

	return { chain: args.chain, open: unmet.length === 0, unmet, met };
}

/** One line per unmet requirement, for a log or a CLI. */
export function formatEvmRailReadiness(r: EvmRailReadiness): string {
	if (r.open) return `${r.chain} rail: every requirement met`;
	const lines = r.unmet.map(
		(u) => `  - [${u.requirement.owner}/${u.requirement.half}] ${u.requirement.id}: ${u.observed}`,
	);
	return [
		`${r.chain} rail SHUT — ${r.unmet.length} of ${EVM_RAIL_REQUIREMENTS.length} ` +
			"requirements unmet:",
		...lines,
	].join("\n");
}

/* --------------------------------------------------------- reading the env */

export interface EvmAccountFromEnv {
	readonly account: EvmXpub;
	/** The signer's own derivations, already verified against the account. */
	readonly vectors: readonly { index: number; address: string }[];
	readonly vectorsProven: boolean;
	readonly notes: readonly string[];
}

/**
 * Parse the configured xpub and the signer's vector file.
 *
 * AN XPRV HERE IS AN INCIDENT, NOT A TYPO, and that is why this function is
 * where the check lives rather than deep in the parser. `parseXpub` already
 * refuses version 0x0488ade4 with that wording, and this adds the operational
 * half: the message names the seed as DISCLOSED and requiring rotation, and the
 * value is never echoed, never logged and never included in the error. The
 * whole security argument for this rail is that no spending authority is on
 * this host; a pasted xprv ends that argument for that seed permanently, and
 * pretending a restart fixes it would be the most expensive possible way to be
 * polite about a mistake.
 *
 * Vectors are accepted as EITHER inline JSON or a file path, and as either the
 * signer's envelope `{"path":…,"addresses":[…]}` or a bare array — both are
 * things a person reasonably ends up with, which is the same concession
 * blockpoolcli.ts makes for the BLOCK pool and for the same reason: an operator
 * reformatting JSON at 2am is a step that can go wrong.
 */
export function readEvmAccountFromEnv(
	env: NodeJS.ProcessEnv,
	readFile?: (path: string) => string,
): EvmAccountFromEnv | undefined {
	const raw = (env[EVM_XPUB_VAR] ?? "").trim();
	if (raw === "") return undefined;

	if (raw.startsWith("xprv")) {
		throw new EvmRailError(
			`${EVM_XPUB_VAR} contains an EXTENDED PRIVATE KEY, not an xpub. Treat this ` +
				"as a disclosure incident, not a typo: that seed has been written to a " +
				"file on an internet-facing host, so it must be considered compromised " +
				"and ROTATED, and any funds derived from it moved. Scrub the value from " +
				"the env file, the shell history and any systemd unit (an " +
				"`Environment=` line is readable by every local user on this box — the " +
				"standing security audit already found that), derive a fresh seed on the " +
				"signer host, and configure its PUBLIC account key here. The value is " +
				"deliberately not echoed anywhere in this message.",
			500,
		);
	}

	const account = parseXpub(raw);
	const notes: string[] = [`EVM account ${safeDescribe(account)}`];

	const vectorsRaw = (env[EVM_VECTORS_VAR] ?? "").trim();
	if (vectorsRaw === "") {
		return { account, vectors: [], vectorsProven: false, notes };
	}

	let text = vectorsRaw;
	if (!vectorsRaw.startsWith("{") && !vectorsRaw.startsWith("[")) {
		const read = readFile ?? ((p: string): string => readFileSync(p, "utf8"));
		try {
			text = read(vectorsRaw);
		} catch (e) {
			throw new EvmRailError(
				`${EVM_VECTORS_VAR} names ${vectorsRaw}, which could not be read (${
					e instanceof Error ? e.message : String(e)
				}). The rail will not open without the signer's own derivations, so this ` +
					"is a refusal rather than a warning: an unproven xpub derives perfect " +
					"addresses nobody can sweep.",
				500,
			);
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new EvmRailError(
			`${EVM_VECTORS_VAR} is not JSON (${e instanceof Error ? e.message : String(e)}). ` +
				"Ship the signer's file verbatim — there is deliberately no reformatting " +
				"step here for an operator to get wrong.",
			500,
		);
	}

	const list = Array.isArray(parsed)
		? parsed
		: (parsed as { addresses?: unknown }).addresses;
	if (!Array.isArray(list) || list.length === 0) {
		throw new EvmRailError(
			`${EVM_VECTORS_VAR} contains no addresses. Expected the signer's envelope ` +
				`{"path":"${EVM_ACCOUNT_PATH}","addresses":[{"index":0,"address":"0x…"}]} ` +
				"or a bare array of the same entries.",
			500,
		);
	}

	const vectors: { index: number; address: string }[] = [];
	list.forEach((entry, n) => {
		const e = entry as { index?: unknown; address?: unknown };
		if (typeof e.index !== "number" || !Number.isInteger(e.index) || e.index < 0) {
			throw new EvmRailError(
				`${EVM_VECTORS_VAR} entry ${n} has no integer index. The index is the ` +
					"whole point of the file: it is what the signer will re-derive from.",
				500,
			);
		}
		if (typeof e.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(e.address)) {
			throw new EvmRailError(
				`${EVM_VECTORS_VAR} entry ${n} (index ${e.index}) is not an EVM address.`,
				500,
			);
		}
		vectors.push({ index: e.index, address: e.address });
	});

	notes.push(`${vectors.length} signer-derived vector(s) supplied for verification`);
	return { account, vectors, vectorsProven: true, notes };
}

/**
 * The endpoint for one chain, refusing an ambiguous pair rather than picking.
 *
 * Both BSC spellings set to DIFFERENT values is the case worth refusing: at
 * that point nobody knows which chain the scanner reads, and the whole failure
 * mode of a mis-pointed scanner is that it has no symptom — valid blocks,
 * valid balances, no deposits, forever.
 */
export function readEvmUrlFromEnv(env: NodeJS.ProcessEnv, chain: string): string {
	const names = EVM_URL_VARS[chain] ?? [`CHAIN_${chain}_URL`];
	const set = names
		.map((n) => ({ name: n, value: (env[n] ?? "").trim() }))
		.filter((v) => v.value !== "");
	if (set.length === 0) return "";
	const distinct = new Set(set.map((v) => v.value));
	if (distinct.size > 1) {
		throw new EvmRailError(
			`${chain}: ${set.map((v) => v.name).join(" and ")} are set to different URLs. ` +
				"Both spellings are accepted because the settlement asset and the chain " +
				"have different names, but two different values means nobody knows which " +
				"chain the scanner is reading — and a scanner on the wrong chain reports " +
				"no deposits forever, with no error. Set one.",
			500,
		);
	}
	return set[0]!.value;
}

/* -------------------------------------------------------------- the rail */

export interface EvmRailOptions {
	readonly chain: string;
	readonly env: NodeJS.ProcessEnv;
	/**
	 * REQUIRED, AND THAT IS THE POINT.
	 *
	 * BLOCK's address pool reached its adapter through an OPTIONAL TRAILING
	 * PARAMETER (`blockAdapterFromEnv(env, fetchImpl?, pool?)`) and for a while
	 * the router called it with one argument. There is no arity error for that:
	 * it compiled, it ran, and per-customer BLOCK deposits were silently off
	 * while the API logged "block pool: 999 free of 1000" from its own separate
	 * reference. A thousand addresses sat unused while customers were told the
	 * rail was shut.
	 *
	 * That bug was the BENIGN direction — a loaded pool and a shut rail. The EVM
	 * analogue is the mirror image and it loses money: an xpub configured but
	 * the scanner not forwarded gives a rail that looks fully OPEN and answers
	 * "no deposits" at HTTP 200. So every collaborator is a required field of an
	 * options object, which makes the same omission a TYPE ERROR at the call
	 * site rather than a silent behaviour change.
	 */
	readonly addresses: EvmAddressIndex;
	/**
	 * Also required. A rail that can issue addresses and is not watching them
	 * is the shape that answers "no deposits" while the money arrives.
	 */
	readonly scanner: EvmIncomingSource;
	/** The adapter the rest of the service will actually route through. */
	readonly adapter: EvmRpcAdapter;
	readonly rule: EvmChainRule;
	/** Whether the signer's vectors verified. Decided by the builder, not here. */
	readonly vectorsProven: boolean;
	/**
	 * Evidence override, FOR TESTS ONLY.
	 *
	 * `evmRailFromEnv` deliberately does not accept it, so no deployment path
	 * can inject a proof that was never observed. A test needs it to exercise
	 * the opened rail at all, and the alternative — mutating the module
	 * constant — trades a tested safety check for an order-dependent suite.
	 */
	readonly evidence?: Readonly<Record<string, EvmProof | undefined>>;
}

/**
 * The issuance + watching half of one chain's rail, with the gate on it.
 *
 * WHY THIS WRAPS THE ADAPTER RATHER THAN REPLACING IT. `EvmRpcAdapter` is the
 * ChainAdapter the reconciler, the deposit watcher and the router already know
 * how to talk to, and it has been extended honestly: it derives addresses when
 * an xpub source is wired, counts every issued address in `balance()` at one
 * pinned block, and still refuses to send because an xpub cannot sign. What it
 * does NOT know is whether the rail is allowed to be open — that is a venue
 * policy question spanning settlement tables, operator ceremonies and dated
 * evidence, and burying it in a chain adapter is how it would get forgotten.
 *
 * So the adapter answers "can I?" and this object answers "may I?".
 */
export class EvmDepositRail {
	constructor(private readonly opts: EvmRailOptions) {
		if (opts.adapter.symbol !== opts.chain) {
			throw new EvmRailError(
				`the ${opts.chain} rail was handed an adapter for ${opts.adapter.symbol}. ` +
					"A rail whose adapter reads a different chain would issue addresses on " +
					"one and watch another, and the addresses would be IDENTICAL because " +
					"the same secp256k1 account serves every EVM chain — so nothing " +
					"downstream would look wrong.",
				500,
			);
		}
	}

	get chain(): string {
		return this.opts.chain;
	}

	get rule(): EvmChainRule {
		return this.opts.rule;
	}

	/** The adapter the router should use. Identity matters: see the asserts. */
	get adapter(): EvmRpcAdapter {
		return this.opts.adapter;
	}

	/** Identity, not equality — see assertEvmRailUsesIndex. */
	sharesAddressIndexWith(index: unknown): boolean {
		return this.opts.addresses === index;
	}

	/** Identity, not equality — see assertEvmRailWatchesWith. */
	sharesScannerWith(scanner: unknown): boolean {
		return this.opts.scanner === scanner;
	}

	readiness(): EvmRailReadiness {
		/*
		 * THE FINGERPRINT COMES FROM THE ADDRESS INDEX, not from a field on this
		 * object, because the index is what will actually derive the next
		 * customer's address. Caching the fingerprint here would be a second
		 * copy of the same fact, and the whole lesson of the BLOCK bug is that a
		 * second copy reads correctly while describing the wrong object.
		 */
		return evmRailReadiness({
			chain: this.opts.chain,
			endpointUrl: readEvmUrlFromEnv(this.opts.env, this.opts.chain),
			accountFingerprint: this.opts.addresses.fingerprint,
			vectorsProven: this.opts.vectorsProven,
			scannerHalted: this.opts.scanner.haltedReason(),
			...(this.opts.evidence === undefined ? {} : { evidence: this.opts.evidence }),
		});
	}

	/** The published minimum, so the deposit screen and the sweeper agree. */
	minimumDepositWei(): bigint {
		return this.opts.rule.minimumDepositWei;
	}

	/** The dust floor the sweeper enforces. Stated, because a hidden one is not. */
	dustFloorWei(): bigint {
		return this.opts.rule.dustFloorWei;
	}

	/**
	 * Issue a deposit address, or refuse with every reason it cannot.
	 *
	 * THE REFUSAL IS THE FEATURE, and on EVM it is the whole feature. One env
	 * variable makes this function able to return a correct address for every
	 * customer on three chains, with no ceremony and no second host, long before
	 * anything can sweep one. This check is the only thing standing between
	 * those two states.
	 */
	issue(userId: string): { address: string; index: number } {
		const r = this.readiness();
		if (!r.open) {
			throw new EvmRailError(
				`${this.opts.chain} deposits are not open. ` +
					formatEvmRailReadiness(r) +
					"\nAn address could be derived right now — derivation needs no key and " +
					"no operator, which is what makes this rail cheap and what makes this " +
					"refusal necessary. A credited deposit the venue cannot sweep or send " +
					"back is a liability with no retrievable asset behind it.",
			);
		}

		/*
		 * THE UN-SWEPT CEILING, AND ISSUANCE IS WHERE IT IS ENFORCED.
		 *
		 * Checked AFTER readiness and BEFORE `take`, and it is deliberately not
		 * part of readiness: readiness answers "may this rail exist", which is a
		 * static question about evidence and configuration, and this answers "may
		 * it take on more right now", which is a live measurement that changes
		 * every pass and clears itself when a sweep lands. Folding a self-clearing
		 * backlog into the requirement list would make `formatEvmRailReadiness`
		 * report a rail as structurally unproven because an operator was a day
		 * late with a sweep.
		 *
		 * NOTE WHAT IS NOT REFUSED: a customer who ALREADY HAS an address still
		 * gets it, because `take` returns their existing row before allocating
		 * anything. Refusing a returning customer their own address would send
		 * them to a deposit screen with no address while a deposit was already in
		 * flight to the one they wrote down — and the whole reason this table is
		 * keyed per customer is that such a deposit arrives unattributed.
		 */
		const existing = this.opts.addresses.forUser(userId.trim());
		if (existing === undefined) {
			const gated = this.opts.scanner.issuanceShutReason();
			if (gated !== undefined) {
				throw new EvmRailError(
					`${this.opts.chain} is not issuing new deposit addresses: ${gated}`,
				);
			}
		}

		return this.opts.addresses.take(userId);
	}

	/**
	 * Every address whose balance is this venue's, for a scanner or reconciler.
	 *
	 * Note what is NOT here: the venue's own hot and gas addresses. They belong
	 * in the adapter's declared `addresses` (so `balance()` counts them) and
	 * MUST NOT be in the scanner's watched set, because a gas drip or sweep
	 * change matched as an incoming deposit is credited to `__unattributed__` —
	 * a USER account, hence a customer LIABILITY owed to nobody. BitGo's XRP
	 * activation reserve did exactly that and halted XRP.
	 */
	watchedAddresses(): readonly string[] {
		return this.opts.addresses.allAddresses();
	}

	/**
	 * (index, address, fingerprint) for every issued address.
	 *
	 * The off-host monitor's input and the deposit screen's proof, from the same
	 * method so the two can never disagree. See the `address-monitor`
	 * requirement for why a monitor outside this host is the only answer to the
	 * one attack a keyless design does not close.
	 */
	attestation(): readonly { index: number; address: string; xpubFingerprint: string }[] {
		return this.opts.addresses.attestation();
	}

	/** Operator-facing lines. Never a reason to proceed anyway. */
	notes(): readonly string[] {
		const notes: string[] = [];
		/*
		 * EMITTED BY THE OBJECT THAT WILL USE IT, which is the structural fix
		 * for the BLOCK bug rather than a style preference. The API logged
		 * "block pool: 999 free of 1000" from a reference nothing was wired to;
		 * the log was accurate and proved nothing. This reads through the same
		 * index the rail issues from, so if they ever differ the line is wrong
		 * in the direction that gets noticed.
		 */
		const s = this.opts.addresses.status();
		notes.push(
			`${this.opts.chain} deposit addresses: ${s.issued} issued from xpub ` +
				`${s.fingerprint}, next index ${s.nextIndex} (customers start at ` +
				`${FIRST_CUSTOMER_INDEX})`,
		);
		const halted = this.opts.scanner.haltedReason();
		if (halted !== undefined) {
			notes.push(`THE ${this.opts.chain} DEPOSIT SCAN IS HALTED: ${halted}`);
		}
		const gated = this.opts.scanner.issuanceShutReason();
		if (gated !== undefined) notes.push(gated);
		const r = this.readiness();
		if (!r.open) notes.push(formatEvmRailReadiness(r));
		return notes;
	}
}

/* ----------------------------------------------------------- construction */

/**
 * Build one chain's rail from the environment. THE PRODUCTION CONSTRUCTOR.
 *
 * Returns undefined when the chain has no URL configured, which is the normal
 * state of a planned rail — absent rather than present and broken, exactly as
 * `adapterFromEnv` treats a missing `CHAIN_<SYM>_URL`. It THROWS, rather than
 * returning undefined, when configuration is present but wrong: an unparseable
 * xpub, an unreadable vector file, a vector that does not match, or a denied
 * endpoint. The distinction is deliberate — "not configured" is a decision and
 * "configured wrongly" is an incident.
 *
 * Takes an options object with no optional members for the same reason
 * `EvmRailOptions` does. Note what it does NOT take: an evidence override.
 * Readiness on a live box is a function of the live box.
 */
export function evmRailFromEnv(opts: {
	readonly chain: string;
	readonly env: NodeJS.ProcessEnv;
	readonly db: Database;
	readonly fetchImpl?: typeof fetch;
	readonly readFile?: (path: string) => string;
	readonly now?: () => Date;
}): EvmDepositRail | undefined {
	const rule = EVM_CHAIN_RULES[opts.chain];
	if (rule === undefined) {
		throw new EvmRailError(
			`${opts.chain} has no entry in EVM_CHAIN_RULES, so its confirmation depth, ` +
				"dust floor, published minimum, un-swept ceiling and lag alarm are all " +
				"undeclared. Refusing to build a rail on defaults: every one of those " +
				"numbers is a customer-visible or solvency-visible promise.",
			500,
		);
	}

	/*
	 * A DECLARED CHAIN IS NOT A LISTED ASSET, AND POLYGON IS THE LIVE EXAMPLE.
	 *
	 * EVM_CHAIN_RULES declares POL — confirmations 128, its own dust floor, its
	 * own minimum, its own lag budget — because polygon-bor-rpc.publicnode.com
	 * was the only EVM endpoint measured that was honest AND deep AND
	 * unthrottled: receipt counts matched header transaction counts at 5, 1k,
	 * 20k, 300k and 1M blocks back, and getLogs served a 2000-block window a
	 * million blocks deep. On the chain-reading axis it is the best rail
	 * available to this venue, better than Ethereum's.
	 *
	 * POL IS NEVERTHELESS NOT IN `ASSETS`, so the ledger has no decimals for it,
	 * `custodyIds` yields nothing, LIVE_FEES has no withdrawal fee, no market
	 * quotes it, and `settleable()` would refuse it. Building a rail anyway would
	 * produce the worst-shaped failure in this service: an adapter that derives
	 * correct addresses, a scanner that finds real deposits, and a watcher that
	 * cannot book any of them — a deposit credited nowhere, which reconciles as a
	 * surplus and looks like nothing.
	 *
	 * So the refusal is here, at construction, naming the listing work rather
	 * than leaving it to be discovered. Listing POL is a VENUE decision with a
	 * blast radius (an ASSETS entry, a LIVE_FEES entry, a decimals ladder, at
	 * least one market, SEO pages), not a side effect of an operator setting
	 * CHAIN_POL_URL.
	 */
	if (ASSETS[opts.chain] === undefined) {
		throw new EvmRailError(
			`${opts.chain} has declared chain rules but is NOT a listed settlement ` +
				"asset: there is no ASSETS entry, so the ledger has no decimals for it, " +
				"no withdrawal fee is derived for it, and no market quotes it. A rail " +
				"built now would derive correct addresses and find real deposits that " +
				"nothing could book — which reconciles as a surplus and therefore looks " +
				"like nothing at all. Listing it is a venue decision (ASSETS, LIVE_FEES, " +
				"a decimals entry, a market, and a RAIL_BLOCKERS entry saying why it is " +
				"shut), and it is deliberately not something setting a URL can do.",
			500,
		);
	}

	const url = readEvmUrlFromEnv(opts.env, opts.chain);
	if (url === "") return undefined;

	const endpoint = checkEvmEndpoint(opts.chain, url);
	if (!endpoint.ok) {
		throw new EvmRailError(
			`${opts.chain}: refusing to build a deposit rail on ${url}. ${endpoint.why}`,
			500,
		);
	}

	const loaded = readEvmAccountFromEnv(opts.env, opts.readFile);
	if (loaded === undefined) {
		throw new EvmRailError(
			`${opts.chain}: ${EVM_URL_VARS[opts.chain]?.[0] ?? "the chain URL"} is set but ` +
				`${EVM_XPUB_VAR} is not. That combination is the one worth refusing rather ` +
				"than degrading: the adapter would be reachable, the probe would pass, and " +
				"the rail would be unable to issue a single address — which reads to an " +
				"operator as a broken rail rather than an unconfigured one. Export the " +
				`account xpub for ${EVM_ACCOUNT_PATH} from the signer host.`,
			500,
		);
	}

	const addresses =
		opts.now === undefined
			? new EvmAddressIndex(opts.db, loaded.account)
			: new EvmAddressIndex(opts.db, loaded.account, opts.now);
	/*
	 * PROVE THE XPUB BEFORE THE RAIL IS ASSEMBLED, not before it is used.
	 *
	 * `assertVectors` throws, so a mismatch stops construction — which means a
	 * process with a wrong xpub does not come up at all rather than coming up
	 * and refusing per request. The difference matters because the per-request
	 * refusal would be indistinguishable from the rail simply not being ready,
	 * and this particular wrongness is the one that strands money.
	 */
	if (loaded.vectorsProven) addresses.assertVectors(loaded.vectors);

	const rpc = new JsonRpc({
		url,
		...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
	});

	const hotVar = EVM_HOT_VARS[opts.chain];
	const hot = ((hotVar === undefined ? "" : opts.env[hotVar]) ?? "").trim();
	const declared = hot === "" ? [] : [hot];

	const scanner = new EvmNativeScanner(opts.db, rpc, {
		rule,
		/*
		 * REBUILT EVERY PASS, and from the index rather than from a snapshot.
		 * A customer can deposit within seconds of being shown an address, so
		 * an address issued while the process was running has to be watched on
		 * the very next pass. A set captured at construction would miss exactly
		 * the deposits most likely to arrive.
		 *
		 * The venue's own hot address is deliberately NOT in here — see
		 * EvmDepositRail.watchedAddresses for what that would cost.
		 */
		watched: async () =>
			new Set(addresses.allAddresses().map((a) => a.toLowerCase())),
		/*
		 * THE UN-SWEPT TOTAL, read from the chain through the adapter's own
		 * balance path so the ceiling is measured against the same number the
		 * reconciler sees. Deriving it from the ledger instead would measure
		 * what the venue BELIEVES it holds, and the whole purpose of the
		 * ceiling is to bound what is actually sitting out there waiting for an
		 * operator to carry a proposal to a signer.
		 */
		unsweptTotal: async () => {
			const issued = addresses.allAddresses();
			if (issued.length === 0) return 0n;
			return await balanceOfSet(rpc, issued);
		},
		...(opts.now === undefined ? {} : { now: opts.now }),
	});

	const adapter = new EvmRpcAdapter(opts.chain, rpc, {
		decimals: 18,
		addresses: declared,
		depositAddresses: addresses,
		incomingSource: scanner,
		chainId: rule.chainId,
	});

	return new EvmDepositRail({
		chain: opts.chain,
		env: opts.env,
		addresses,
		scanner,
		adapter,
		rule,
		vectorsProven: loaded.vectorsProven,
	});
}

/**
 * Sum native balances over a set of addresses at ONE pinned block.
 *
 * Duplicated in spirit from `EvmRpcAdapter.balance()` and NOT shared with it on
 * purpose: that method sums the venue's whole custody (declared treasury plus
 * issued addresses) and this one must sum ONLY the customer addresses, because
 * the un-swept ceiling asks "how much is waiting for a sweep" and the hot
 * address is where sweeps go. Sharing the method would make the ceiling include
 * its own destination, so it would never be crossed by the thing it measures.
 *
 * A short read THROWS rather than returning a partial sum, for the same reason
 * it does in the adapter: a partial sum here would under-report the un-swept
 * total, which silently raises the ceiling it exists to enforce.
 */
async function balanceOfSet(
	rpc: { call<T>(m: string, p?: unknown[]): Promise<T>; batch<T>(c: readonly { method: string; params?: unknown[] }[]): Promise<T[]> },
	addresses: readonly string[],
): Promise<bigint> {
	const at = await rpc.call<string>("eth_blockNumber");
	if (typeof at !== "string" || !/^0x[0-9a-fA-F]+$/.test(at)) {
		throw new ChainError(
			`eth_blockNumber returned ${JSON.stringify(at)}, so the un-swept total has ` +
				"no block to pin to. Refusing 'latest': a sum across moving blocks can " +
				"double-count a sweep in flight or miss it entirely.",
		);
	}
	const CHUNK = 100;
	let total = 0n;
	for (let i = 0; i < addresses.length; i += CHUNK) {
		const slice = addresses.slice(i, i + CHUNK);
		const out = await rpc.batch<string>(
			slice.map((a) => ({ method: "eth_getBalance", params: [a, at] })),
		);
		if (out.length !== slice.length) {
			throw new ChainError(
				`asked for ${slice.length} balances at ${at} and got ${out.length}. ` +
					"Refusing a partial un-swept total, which would silently raise the " +
					"ceiling it is measured against.",
				true,
			);
		}
		for (const h of out) {
			if (typeof h !== "string" || h === "0x" || !/^0x[0-9a-fA-F]+$/.test(h)) {
				throw new ChainError(
					`a balance read returned ${JSON.stringify(h)}, which is not a quantity. ` +
						"Treating it as zero would under-report the un-swept total.",
					true,
				);
			}
			total += BigInt(h);
		}
	}
	return total;
}

/* ------------------------------------------------------------ the tripwires */

/**
 * THE INDEX THE PROCESS BUILT MUST BE THE INDEX THE RAIL ISSUES FROM.
 *
 * The BLOCK pool-forwarding bug, expressed as an assertion instead of a
 * post-mortem. It compares IDENTITY, not status, and the reason is the exact
 * shape of what happened: two objects over the SAME database file report
 * identical numbers, so a startup log saying "16 issued, next index 17" would
 * be perfectly accurate about an object nothing was wired to. A status
 * comparison would have passed. Only identity catches it.
 */
export function assertEvmRailUsesIndex(rail: EvmDepositRail, index: EvmAddressIndex): void {
	if (!rail.sharesAddressIndexWith(index)) {
		throw new EvmRailError(
			`the ${rail.chain} rail is holding a DIFFERENT address index object from the ` +
				"one this process built. Two indices over the same database file report " +
				"identical status, so logging 'N issued' would look correct while the rail " +
				"issued from somewhere else. This is the BLOCK pool-forwarding bug, where " +
				"1000 addresses sat unused while customers were told the rail was shut — " +
				"except the EVM version loses money instead of merely refusing. Refusing " +
				"to start.",
			500,
		);
	}
}

/**
 * THE SCANNER THE PROCESS BUILT MUST BE THE ONE THE RAIL AND ADAPTER USE.
 *
 * The mirror-image of the BLOCK bug and the dangerous direction. If the scanner
 * is not forwarded, `incoming()` throws and the watcher logs an error — loud,
 * recoverable. If a DIFFERENT scanner is forwarded, it has its own cursor,
 * which starts at the safe head: every block between the real cursor and now is
 * skipped in silence, the rail looks fully open, and it answers "no deposits"
 * at HTTP 200 while customer money arrives.
 */
export function assertEvmRailWatchesWith(rail: EvmDepositRail, scanner: EvmIncomingSource): void {
	if (!rail.sharesScannerWith(scanner)) {
		throw new EvmRailError(
			`the ${rail.chain} rail is holding a DIFFERENT scanner object from the one ` +
				"this process built. A second scanner has a second cursor, and a fresh " +
				"cursor starts at the safe head — so every block in between is skipped " +
				"with no error anywhere, and the rail reports 'no deposits' while the " +
				"money is already on chain. Refusing to start.",
			500,
		);
	}
}

/**
 * WHILE THE RAIL IS NOT READY, SETTLEMENT MUST STILL SAY SO.
 *
 * Three records have to agree and each of them can be edited without the
 * others:
 *
 *   RAIL_BLOCKERS[chain]  the reasons shown to customers and operators
 *   PROVEN_RAILS[chain]   the claim that a deposit address has actually been minted
 *   readiness             what is true on this machine right now
 *
 * The failure this catches is the plausible one, and for EVM it is more
 * plausible than it was for SOL: somebody reads evmxpub.ts, evmaddressindex.ts
 * and evmscan.ts, sees the tests pass, concludes the ETH blocker is stale, and
 * deletes it. The deposit screen then falls through to the generic "no address
 * is provisioned" paragraph that RAIL_BLOCKERS exists to replace, and nothing
 * anywhere says why.
 *
 * Deliberately one-directional. A READY rail still recorded as blocked does NOT
 * throw: that state is merely conservative — the rail stays shut — and refusing
 * to start over it would turn a cautious table into an outage.
 */
export function assertEvmRailBlockedUnlessProven(
	readiness: EvmRailReadiness,
	tables?: {
		readonly blockers?: Readonly<
			Record<string, { readonly causes: readonly unknown[] } | undefined>
		>;
		readonly proven?: Readonly<Record<string, unknown>>;
	},
): void {
	if (readiness.open) return;

	const blockers = tables?.blockers ?? RAIL_BLOCKERS;
	const proven = tables?.proven ?? PROVEN_RAILS;
	const chain = readiness.chain;
	const blocker = blockers[chain];
	if (blocker === undefined || blocker.causes.length === 0) {
		throw new EvmRailError(
			`RAIL_BLOCKERS has no outstanding cause for ${chain}, but the ${chain} rail ` +
				`is not ready:\n${formatEvmRailReadiness(readiness)}\n` +
				"An empty blocker means the deposit route stops refusing and the customer " +
				"gets the generic 'no address is provisioned' paragraph with no cause " +
				"attached. If the rail really is ready, the readiness check above would " +
				"say so. Refusing to start.",
			500,
		);
	}
	if (chain in proven) {
		throw new EvmRailError(
			`PROVEN_RAILS claims ${chain} while the rail is not ready:\n` +
				`${formatEvmRailReadiness(readiness)}\n` +
				"PROVEN_RAILS is evidence that a customer deposit address exists AND the " +
				"payout side has a route. Adding a chain to it on the strength of a " +
				"configured xpub is the one-way door: derivation is the cheap half and it " +
				"is free and infinite. Refusing to start.",
			500,
		);
	}
}
