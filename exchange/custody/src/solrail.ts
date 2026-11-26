// -----------------------------------------------------------------------------
// THE SOL RAIL'S GATE — the precondition in code rather than in a comment.
//
// WHY THIS FILE EXISTS AT ALL.
//
// There are now two halves of a self-custodied Solana rail in this service: an
// address pool (soladdresspool.ts) and a consolidation planner
// (solconsolidation.ts). Neither one opens the rail, and the dangerous moment
// is the one where somebody reasonably concludes that they do. The code is
// there, the tests pass, the pool has a thousand addresses in it — and nothing
// has ever been signed, no endpoint can read the history honestly, and no
// operator has ever carried a batch to a signer host.
//
// settlement.ts already names this failure for the BitGo version of the same
// rail: "funding the wallet makes BitGo mint addresses, the gas check already
// passes (SOL pays its own gas), and the venue would then be taking deposits
// it has no code to send back. One-way doors are what this module exists to
// prevent." The self-custodied version has exactly the same shape, except the
// cheap half is now ours: loading a pool is one command, and it is the half
// that LOOKS like the rail working.
//
// So the gate is mechanical. `solRailReadiness()` asks every requirement, and
// `SolDepositRail.issue()` refuses while any one is unmet — not with a comment
// saying it should, with a throw. `assertSolRailBlockedUnlessProven()` then
// checks the OTHER direction: that while the rail is unready, settlement.ts
// still records it as blocked and does not record it as proven. Deleting the
// RAIL_BLOCKERS entry is not enough to open the rail, and opening the rail is
// not enough to stop advertising it as shut; both have to be true together or
// the service refuses to start.
//
// WHAT WOULD BE WRONG WITH TRUSTING THE BLOCKERS TABLE ALONE: it is a
// hand-maintained record of measurements, and the one thing it cannot know is
// whether the code it describes has since been written. A table that says "no
// consolidation path exists" is a lie the moment somebody adds one, and the
// lie is in the safe direction only by luck.
// -----------------------------------------------------------------------------

import { checkSolAddress } from "./soladdress";
import { SOL_MINIMUM_DEPOSIT_LAMPORTS, formatSol, type SolConsolidation } from "./solconsolidation";
import type { SolAddressPool, SolPoolStatus } from "./soladdresspool";
import { PROVEN_RAILS, RAIL_BLOCKERS, type BlockerOwner } from "./settlement";

export class SolRailError extends Error {
	constructor(
		message: string,
		readonly status = 503,
	) {
		super(message);
		this.name = "SolRailError";
	}
}

/* ------------------------------------------------------------ requirements */

/**
 * One thing that must be true before SOL deposits may open.
 *
 * `half` is recorded because rule 4 ties them together and a reader will
 * otherwise assume the deposit half can ship alone: it cannot. A rail that can
 * take a deposit and not send it back is the worst state available, so a
 * WITHDRAWAL requirement blocks DEPOSITS too, and this is where that is
 * written down.
 */
export interface SolRailRequirement {
	readonly id: string;
	readonly half: "deposit" | "withdrawal" | "both";
	readonly owner: BlockerOwner;
	/** What has to be true. */
	readonly what: string;
	/** What goes wrong if the rail opens without it. The reason, not the rule. */
	readonly why: string;
}

export const SOL_RAIL_REQUIREMENTS: readonly SolRailRequirement[] = Object.freeze([
	{
		id: "pool-loaded",
		half: "deposit",
		owner: "operator",
		what:
			"a batch of addresses derived on the signer host from m/44'/501'/i'/0' " +
			"has been loaded into sol_address_pool",
		why:
			"with an empty pool `take()` refuses, so the rail cannot issue an " +
			"address at all. This is the one requirement whose absence is loud.",
	},
	{
		id: "endpoint-keyed",
		half: "both",
		owner: "commercial",
		what:
			"CHAIN_SOL_URL names a keyed Solana endpoint that is not on " +
			"SOL_ENDPOINT_DENYLIST",
		why:
			"every endpoint the house has today either lies about history or " +
			"throttles. solana-rpc.publicnode.com returns n=3 signatures at HTTP 200 " +
			"where api.mainnet-beta returns n=1000, and getTransaction returns null " +
			"rather than an error for transactions 18 to 160 days old; it also caps " +
			"getMultipleAccounts at 10 accounts, which is 100 round trips per pass " +
			"over a 1,000-address pool. A scanner on it reads 'no deposits' and " +
			"loses the money with no error in any log.",
	},
	{
		id: "hot-address",
		half: "withdrawal",
		owner: "operator",
		what:
			"CHAIN_SOL_HOT_ADDRESS names the sweep destination and fee payer — an " +
			"address, never a key, whose key is on the signer host",
		why:
			"without it no sweep can even be COMPOSED, so the sweeper cannot be " +
			"constructed and nothing could ever leave a customer's deposit account. " +
			"There is deliberately no fallback: a placeholder destination is a real " +
			"curve point nobody controls, and the pool's own first address is worse " +
			"— sweeping into a customer's deposit address credits the venue's whole " +
			"balance to that customer, because that is the address set the scanner " +
			"attributes by.",
	},
	{
		id: "scanner",
		half: "deposit",
		owner: "engineering",
		what:
			"a deposit scanner that attributes a balance delta to a specific " +
			"transaction signature, at `finalized` commitment, gated on " +
			"getFirstAvailableBlock",
		why:
			"IncomingPayment.txid is required and idempotency depends on it. A " +
			"balance delta on its own has no transaction id, so crediting one would " +
			"break rule 3 (exactly once) on day one. Nothing is credited without an " +
			"attributed signature.",
	},
	{
		id: "sweep-proof",
		half: "withdrawal",
		owner: "engineering",
		what:
			"sweep-to-close demonstrated end to end on devnet and then with a real " +
			"small amount on mainnet",
		why:
			"the entire economics of this rail — a 15,000-lamport dust floor and a " +
			"0.001 SOL published minimum instead of ten times that — rests on a " +
			"full-balance transfer closing a 0-byte account and recovering every " +
			"lamport. That behaviour is documented and MEASURED NOWHERE BY US, " +
			"because this work may not submit a transaction.",
	},
	{
		id: "broadcast",
		half: "withdrawal",
		owner: "engineering",
		what:
			"a broadcast runner that submits signed batches idempotently and posts " +
			"BOTH movements of every sweep to the ledger, including the fee",
		why:
			"PayoutRail assumes a synchronous send; an offline signer makes canSend " +
			"mean 'a signed batch is available', which is a different shape and is " +
			"new code. And a sweep whose fee is not posted produces a growing " +
			"shortfall, which has no tolerance at any size and halts the asset.",
	},
	{
		id: "signer-procedure",
		half: "withdrawal",
		owner: "operator",
		what:
			"a signer host holding the SOL seed, with a compiled hot-address " +
			"allow-list, that re-derives every source from its own seed at the " +
			"claimed index before signing",
		why:
			"without source re-derivation and a destination allow-list the offline " +
			"step is theatre: a compromised exchange host simply proposes a sweep of " +
			"every customer account to the attacker's address and the human presses " +
			"yes.",
	},
]);

/** A dated, named observation that a requirement has actually been met. */
export interface SolProof {
	readonly provenAt: string;
	readonly network: "devnet" | "mainnet-beta";
	/** What was observed. Verbatim where possible, like every other table here. */
	readonly evidence: string;
}

/**
 * THE EVIDENCE, AND IT IS EMPTY.
 *
 * Keyed by requirement id, every value undefined, because not one of these has
 * been demonstrated. Written as a table rather than a boolean so that filling
 * it in is the same kind of act as adding to PROVEN_RAILS: dated, specific,
 * and a deliberate edit that a reviewer can see in a diff.
 *
 * `pool-loaded` and `endpoint-keyed` are deliberately NOT here — they are
 * facts about the live machine, read at runtime from the database and the
 * environment. Recording a runtime fact as a static proof is how a table
 * starts lying.
 */
export const SOL_RAIL_EVIDENCE: Readonly<Record<string, SolProof | undefined>> =
	Object.freeze({
		scanner: undefined,
		"sweep-proof": undefined,
		broadcast: undefined,
		"signer-procedure": undefined,
	});

/* -------------------------------------------------------------- endpoints */

/**
 * ENDPOINTS A DEPOSIT RAIL MUST NOT USE, with what was measured.
 *
 * A denylist and not an allowlist, on purpose: an allowlist would shut a
 * perfectly good endpoint the day somebody forgot to add it, which is the same
 * reasoning `railBlocker` uses for treating silence as "not blocked". What is
 * recorded here is what was MEASURED to be unsafe.
 *
 * The third entry is the uncomfortable one: our OWN relay. It is not excluded
 * because it is third-party — it is excluded because SOLANA_RPC is unset on
 * the box, so it forwards to publicnode and inherits every truncation
 * verbatim, AND because it sits behind `loginIpRl`, the shared account-login
 * limiter at 30 requests per 15 minutes per IP with a lock threshold of 10. A
 * polling custody scanner sharing the host's IP could trip the login lockout
 * for real users. Custody must never sit behind the login limiter.
 */
export const SOL_ENDPOINT_DENYLIST: readonly {
	readonly match: string;
	readonly why: string;
}[] = Object.freeze([
	{
		match: "solana-rpc.publicnode.com",
		why:
			"silently truncates its signature index to ~2.5 days: n=3 at HTTP 200 " +
			"where api.mainnet-beta returns n=1000 for the same account, and " +
			"getTransaction returns null (not an error) at 17.9d, 68.5d, 150.7d and " +
			"160.5d. It also caps getMultipleAccounts at 10 accounts. A plausible " +
			"wrong answer is more dangerous than an error.",
	},
	{
		match: "api.mainnet-beta.solana.com",
		why:
			"the only endpoint we have with honest history, and it rate-limits: 11 " +
			"of 25 burst getSlot calls returned HTTP 429 'Connection rate limits " +
			"exceeded', and signature pagination died at page 10. Fit for low-rate " +
			"repair queries, not for a polling custody scanner.",
	},
	{
		match: "/account/api/sol/rpc",
		why:
			"our own browser relay. SOLANA_RPC is unset on the box so it forwards to " +
			"publicnode and inherits the truncation, and it is throttled by the " +
			"shared login limiter (30 requests / 15 min / IP, lock threshold 10) — a " +
			"custody scanner could lock real users out of their accounts.",
	},
]);

export function checkSolEndpoint(url: string): { ok: boolean; why?: string } {
	const u = url.trim();
	if (u === "") {
		return { ok: false, why: "CHAIN_SOL_URL is not set, so there is nothing to read the chain with" };
	}
	if (!/^https?:\/\//.test(u)) {
		return { ok: false, why: `CHAIN_SOL_URL must be http(s): ${u}` };
	}
	for (const d of SOL_ENDPOINT_DENYLIST) {
		if (u.includes(d.match)) {
			return {
				ok: false,
				why: `${d.match} must not carry a deposit rail: ${d.why}`,
			};
		}
	}
	return { ok: true };
}

/* -------------------------------------------------------------- readiness */

export interface UnmetRequirement {
	readonly requirement: SolRailRequirement;
	/** What was actually observed, now, on this machine. */
	readonly observed: string;
}

export interface SolRailReadiness {
	readonly open: boolean;
	readonly unmet: readonly UnmetRequirement[];
	/** Everything met, for operator output that is not only bad news. */
	readonly met: readonly string[];
}

/**
 * Ask every requirement, against runtime facts where they exist and the
 * evidence table where they do not.
 *
 * NO SHORT-CIRCUIT. Every requirement is evaluated even once one has failed,
 * because the operator output is the point: "the rail is shut" is useless and
 * "the rail is shut for four reasons owned by three different people" is
 * actionable. This is the same reasoning behind `RailBlocker.causes` being a
 * list.
 */
export function solRailReadiness(args: {
	readonly poolStatus: { readonly total: number; readonly free: number };
	readonly endpointUrl: string;
	/**
	 * The sweep destination, as the sweeper that exists reports it — or "" when
	 * no sweeper could be built. Passed in rather than read from the
	 * environment here, because this function is also asked the question on
	 * behalf of a process that could NOT construct a sweeper, and that is a
	 * legitimate state with its own answer rather than a crash.
	 */
	readonly hotAddress: string;
	readonly evidence?: Readonly<Record<string, SolProof | undefined>>;
}): SolRailReadiness {
	const evidence = args.evidence ?? SOL_RAIL_EVIDENCE;
	const unmet: UnmetRequirement[] = [];
	const met: string[] = [];

	for (const requirement of SOL_RAIL_REQUIREMENTS) {
		let observed: string | undefined;
		switch (requirement.id) {
			case "pool-loaded":
				if (args.poolStatus.total === 0) {
					observed = "sol_address_pool is empty: no batch has ever been loaded";
				} else if (args.poolStatus.free === 0) {
					observed =
						`all ${args.poolStatus.total} pool addresses are issued, so the next ` +
						"customer cannot be given one";
				}
				break;
			case "endpoint-keyed": {
				const e = checkSolEndpoint(args.endpointUrl);
				if (!e.ok) observed = e.why ?? "unusable endpoint";
				break;
			}
			case "hot-address": {
				const hot = args.hotAddress.trim();
				if (hot === "") {
					observed =
						"CHAIN_SOL_HOT_ADDRESS is not set, so no sweeper could be built and " +
						"no sweep could be composed";
				} else {
					const v = checkSolAddress(hot);
					if (!v.ok) observed = `CHAIN_SOL_HOT_ADDRESS is not usable: ${v.why}`;
				}
				break;
			}
			default: {
				const p = evidence[requirement.id];
				if (p === undefined) {
					observed = "no dated proof is recorded in SOL_RAIL_EVIDENCE";
				}
				break;
			}
		}
		if (observed === undefined) met.push(requirement.id);
		else unmet.push({ requirement, observed });
	}

	return { open: unmet.length === 0, unmet, met };
}

/** One line per unmet requirement, for a log or a CLI. */
export function formatSolRailReadiness(r: SolRailReadiness): string {
	if (r.open) return "SOL rail: every requirement met";
	const lines = r.unmet.map(
		(u) =>
			`  - [${u.requirement.owner}/${u.requirement.half}] ${u.requirement.id}: ` +
			`${u.observed}`,
	);
	return [
		`SOL rail SHUT — ${r.unmet.length} of ${SOL_RAIL_REQUIREMENTS.length} ` +
			"requirements unmet:",
		...lines,
	].join("\n");
}

/* ------------------------------------------------------------- the rail */

/**
 * WHY THIS IS NOT A `ChainAdapter`, SAID BEFORE SOMEBODY MAKES IT ONE.
 *
 * `ChainAdapter` promises `balance()` and `incoming()`. This object can
 * honestly answer NEITHER: there is no Solana endpoint configured, and the
 * ones available cannot be polled over a pool without either lying or
 * throttling. A half-implemented adapter would be worse than none, because
 * `routedHoldings` would route SOL to it and ask it for a custody figure —
 * and `custodyrouting.ts`'s whole rule is that an asset with no custodian must
 * be UNKNOWN, never zero. An adapter that threw from `balance()` would at
 * least be honest; an adapter that summed an empty address set would report an
 * empty treasury against real liabilities, which is a shortfall, which halts a
 * healthy asset.
 *
 * So this is the ISSUANCE half only, and it refuses to issue until the whole
 * rail is ready. When the scanner and the broadcast runner exist, this becomes
 * the natural place to grow into a real adapter — with `canSend` still false,
 * because the keys are not here and never will be.
 */
export interface SolRailOptions {
	readonly env: NodeJS.ProcessEnv;
	/**
	 * REQUIRED, AND THAT IS THE POINT.
	 *
	 * BLOCK's pool reached its adapter through an OPTIONAL TRAILING PARAMETER
	 * (`blockAdapterFromEnv(env, fetchImpl?, pool?)`) and for a while the
	 * router called it with one argument. There is no arity error for that: it
	 * compiled, it ran, and per-customer BLOCK deposits were silently off while
	 * the API logged "block pool: 999 free of 1000" from its own separate
	 * reference. A thousand addresses sat unused while customers were told the
	 * rail was shut.
	 *
	 * An options object with a required field makes the same omission a TYPE
	 * ERROR at the call site. See test/solpoolwiring.test.ts, which reproduces
	 * the original bug's shape deliberately.
	 */
	readonly pool: SolAddressPool;
	/**
	 * Also required. A rail that can issue addresses and has no sweeper is the
	 * one-way door rule 4 forbids, so the two arrive together or not at all.
	 */
	readonly consolidation: SolConsolidation;
	/**
	 * Evidence override, FOR TESTS ONLY.
	 *
	 * The production constructor is `solRailFromEnv`, which deliberately does
	 * not accept this — so no deployment path can inject a proof that was never
	 * observed. A test needs it to exercise the opened rail at all, and the
	 * alternative (editing the module constant) would make the test order
	 * dependent and the production default untestable.
	 */
	readonly evidence?: Readonly<Record<string, SolProof | undefined>>;
}

export class SolDepositRail {
	readonly symbol = "SOL";

	constructor(private readonly opts: SolRailOptions) {}

	/**
	 * Pool runway AS THIS OBJECT SEES IT.
	 *
	 * Not as the process that loaded the pool sees it — that distinction is the
	 * entire lesson of the BLOCK bug, where two references to the same database
	 * reported the same healthy numbers while only one of them was wired to the
	 * deposit route. Startup logging must call THIS, not the loader.
	 */
	poolStatus(): SolPoolStatus {
		return this.opts.pool.status();
	}

	/** Identity, not equality: see assertSolRailUsesPool. */
	sharesPoolWith(pool: unknown): boolean {
		return this.opts.pool === pool;
	}

	readiness(): SolRailReadiness {
		const s = this.opts.pool.status();
		return solRailReadiness({
			poolStatus: { total: s.total, free: s.free },
			endpointUrl: this.opts.env.CHAIN_SOL_URL ?? "",
			hotAddress: this.opts.consolidation.hotAddress(),
			...(this.opts.evidence === undefined ? {} : { evidence: this.opts.evidence }),
		});
	}

	/** The published minimum, so the deposit screen and the sweeper agree. */
	minimumDepositLamports(): bigint {
		return SOL_MINIMUM_DEPOSIT_LAMPORTS;
	}

	/** The floor in force on this machine, from the sweeper that enforces it. */
	dustFloorLamports(): bigint {
		return this.opts.consolidation.dustFloor();
	}

	/**
	 * Issue a deposit address, or refuse with every reason it cannot.
	 *
	 * THE REFUSAL IS THE FEATURE. A loaded pool makes this function able to
	 * return an address long before the venue can send one back, and the only
	 * thing standing between those two states is this check.
	 */
	issue(userId: string): { address: string; index: number } {
		const r = this.readiness();
		if (!r.open) {
			throw new SolRailError(
				"SOL deposits are not open. " +
					formatSolRailReadiness(r) +
					"\nA deposit address could be issued right now — the pool is the easy " +
					"half — and that is exactly why this refuses: a credited SOL deposit " +
					"the venue cannot sweep or send back is a liability with no " +
					"retrievable asset behind it.",
			);
		}
		const e = this.opts.pool.take(userId);
		return { address: e.address, index: e.index };
	}

	/** Every pool address, for a scanner or a reconciler to watch. */
	watchedAddresses(): readonly string[] {
		return this.opts.pool.allAddresses();
	}

	/** Operator-facing lines. Never a reason to proceed anyway. */
	notes(): readonly string[] {
		const s = this.poolStatus();
		const notes: string[] = [];
		if (s.total === 0) {
			notes.push("no SOL address pool is loaded, so SOL deposits are closed");
		} else {
			notes.push(`SOL deposit addresses: ${s.free} free of ${s.total}`);
			if (s.low) {
				notes.push(
					"the SOL address pool is running low — refill it before it empties, " +
						"which needs the signer host and an operator, not a command here",
				);
			}
			if (s.daysOfRunway !== undefined && s.daysOfRunway < 7) {
				notes.push(
					`at the trailing rate (${s.issuedPerDay?.toFixed(1)}/day) the pool ` +
						`empties in ${s.daysOfRunway.toFixed(1)} days`,
				);
			}
		}
		const stranded = this.opts.consolidation.stranded();
		if (stranded.length > 0) {
			notes.push(
				`${stranded.length} SOL account(s) hold ` +
					`${formatSol(this.opts.consolidation.strandedLamports())} SOL below the ` +
					`${formatSol(this.dustFloorLamports())} SOL dust floor and are not swept`,
			);
		}
		const r = this.readiness();
		if (!r.open) notes.push(formatSolRailReadiness(r));
		return notes;
	}
}

/**
 * Build the rail from the environment. THE PRODUCTION CONSTRUCTOR.
 *
 * Takes an options object with no optional members, so the omission that broke
 * BLOCK cannot be expressed here. Note what it does NOT take: an evidence
 * override. The rail's readiness on a live box is a function of the live box.
 */
export function solRailFromEnv(opts: {
	readonly env: NodeJS.ProcessEnv;
	readonly pool: SolAddressPool;
	readonly consolidation: SolConsolidation;
}): SolDepositRail {
	return new SolDepositRail({
		env: opts.env,
		pool: opts.pool,
		consolidation: opts.consolidation,
	});
}

/* ------------------------------------------------------------ the tripwires */

/**
 * THE POOL THE PROCESS LOADED MUST BE THE POOL THE RAIL USES.
 *
 * This is the BLOCK bug, expressed as an assertion instead of a post-mortem.
 * It compares IDENTITY, not status, and the reason is the exact shape of what
 * happened: two `BlockAddressPool` objects over the SAME database file report
 * identical totals, so the startup log said "999 free of 1000" and was
 * perfectly accurate — about an object nothing was wired to. A status
 * comparison would have passed. Only identity catches it.
 */
export function assertSolRailUsesPool(rail: SolDepositRail, pool: SolAddressPool): void {
	if (!rail.sharesPoolWith(pool)) {
		throw new SolRailError(
			"the SOL rail is holding a DIFFERENT address pool object from the one " +
				"this process loaded. Two pools over the same database file report " +
				"identical status, so logging 'N free of M' would look correct while " +
				"the rail issued from somewhere else — or from nothing. This is the " +
				"BLOCK pool-forwarding bug, where 1000 addresses sat unused while " +
				"customers were told the rail was shut. Refusing to start.",
			500,
		);
	}
}

/**
 * WHILE THE RAIL IS NOT READY, SETTLEMENT MUST STILL SAY SO.
 *
 * Two tables and one runtime check have to agree, and each of them can be
 * edited without the others:
 *
 *   RAIL_BLOCKERS.SOL  the reasons shown to customers and operators
 *   PROVEN_RAILS.SOL   the claim that a deposit address has actually been minted
 *   readiness          what is true on this machine right now
 *
 * The failure this catches is the plausible one: somebody reads the new pool
 * and sweeper code, concludes the engineering cause is stale, and deletes the
 * SOL entry from RAIL_BLOCKERS. The deposit screen would then fall through to
 * the generic "no address is provisioned" paragraph that RAIL_BLOCKERS exists
 * to replace, and nothing anywhere would say why.
 *
 * Deliberately one-directional. A READY rail that is still recorded as blocked
 * does NOT throw: that state is merely conservative — the rail stays shut — and
 * refusing to start over it would turn a cautious table into an outage.
 */
export function assertSolRailBlockedUnlessProven(
	readiness: SolRailReadiness,
	/**
	 * The tables to read, defaulting to the real ones.
	 *
	 * A parameter rather than a hard reference purely so the REFUSAL path is
	 * testable: the alternative is mutating a module-level table that every
	 * other test in the process shares, which trades a tested safety check for
	 * an order-dependent test suite. Production passes nothing, and the test
	 * that proves the default is the one asserting the live tables are
	 * consistent.
	 */
	tables?: {
		readonly blockers?: Readonly<Record<string, { readonly causes: readonly unknown[] } | undefined>>;
		readonly proven?: Readonly<Record<string, unknown>>;
	},
): void {
	if (readiness.open) return;

	const blockers = tables?.blockers ?? RAIL_BLOCKERS;
	const proven = tables?.proven ?? PROVEN_RAILS;
	const blocker = blockers.SOL;
	if (blocker === undefined || blocker.causes.length === 0) {
		throw new SolRailError(
			"RAIL_BLOCKERS has no outstanding cause for SOL, but the SOL rail is not " +
				`ready:\n${formatSolRailReadiness(readiness)}\n` +
				"An empty blocker means the deposit route stops refusing and the " +
				"customer gets the generic 'no address is provisioned' paragraph with " +
				"no cause attached. If the rail really is ready, the readiness check " +
				"above would say so. Refusing to start.",
			500,
		);
	}
	if ("SOL" in proven) {
		throw new SolRailError(
			"PROVEN_RAILS claims SOL while the rail is not ready:\n" +
				`${formatSolRailReadiness(readiness)}\n` +
				"PROVEN_RAILS is evidence that a customer deposit address exists AND " +
				"the payout side has a route. Adding SOL to it on the strength of a " +
				"loaded address pool is the one-way door. Refusing to start.",
			500,
		);
	}
}
