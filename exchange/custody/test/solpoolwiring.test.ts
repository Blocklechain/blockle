// -----------------------------------------------------------------------------
// THE SOL ADDRESS POOL HAS TO REACH THE THING THAT ISSUES ADDRESSES —
// AND WHILE THE RAIL IS SHUT, IT MUST NOT ISSUE AT ALL.
//
// This is test/blockpoolwiring.test.ts's sibling, and it exists because the bug
// that file guards is one this design can reproduce exactly.
//
// WHAT HAPPENED TO BLOCK. `nodeAdapters` took a `blockPool` and never forwarded
// it: the call was `blockAdapterFromEnv(args.env)` against a signature of
// (env, fetchImpl?, pool?). An optional trailing parameter makes that silent —
// no arity error, it compiles, it runs, and per-customer deposits are off. It
// was maddening to find because the pool WAS loaded and the service said so:
// publicapi held its own reference and logged "block pool: 999 free of 1000"
// at startup while every deposit request was refused with "no address pool is
// loaded. Derive a batch on the wallet host..." — instructing an operator to do
// the thing already done. A thousand addresses sat unused for hours.
//
// WHY THE SOL VERSION WOULD BE WORSE THAN THE BLOCK ONE. BLOCK's failure was
// in the benign direction: a loaded pool with a shut rail. Refuse-when-you-can
// is a visible, loud, non-money-losing bug. The dangerous direction is the
// mirror image — a rail that LOOKS open, issues addresses, and has no way to
// sweep what arrives. So this file tests both:
//
//   * the pool reaches the rail, and the rail that reports is the rail that
//     issues (identity, not agreeing numbers: two pools over one database file
//     always agree, which is why the original log proved nothing);
//   * the rail REFUSES to issue while any precondition is unmet, even with a
//     full pool in front of it.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";

import Database from "better-sqlite3";

import { RAIL_BLOCKERS, PROVEN_RAILS } from "../src/settlement";
import { base58Encode } from "../src/soladdress";
import { SolAddressPool } from "../src/soladdresspool";
import { SolConsolidation } from "../src/solconsolidation";
import {
	SOL_ENDPOINT_DENYLIST,
	SOL_RAIL_EVIDENCE,
	SOL_RAIL_REQUIREMENTS,
	SolDepositRail,
	SolRailError,
	assertSolRailBlockedUnlessProven,
	assertSolRailUsesPool,
	checkSolEndpoint,
	solRailFromEnv,
	solRailReadiness,
} from "../src/solrail";

function freshAddress(): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" });
	return base58Encode(new Uint8Array(der.subarray(der.length - 32)));
}

const HOT = freshAddress();

/** A keyed endpoint, in the shape a paid provider hands over. */
const KEYED_URL = "https://sol.example-provider.net/v1/abcdef0123456789";

/** Every requirement the evidence table can satisfy, as if all were proven. */
const ALL_PROVEN = Object.freeze(
	Object.fromEntries(
		Object.keys(SOL_RAIL_EVIDENCE).map((id) => [
			id,
			{
				provenAt: "2026-11-26",
				network: "devnet" as const,
				evidence: `test fixture for ${id}`,
			},
		]),
	),
);

interface Rig {
	readonly db: Database.Database;
	readonly pool: SolAddressPool;
	readonly consolidation: SolConsolidation;
	readonly env: NodeJS.ProcessEnv;
}

function rig(opts?: { addresses?: number; env?: NodeJS.ProcessEnv }): Rig {
	const db = new Database(":memory:");
	const pool = new SolAddressPool(db);
	const n = opts?.addresses ?? 4;
	if (n > 0) {
		pool.load(
			Array.from({ length: n }, (_, i) => ({ index: i, address: freshAddress() })),
		);
	}
	return {
		db,
		pool,
		consolidation: new SolConsolidation(db, pool, { hotAddress: HOT }),
		env:
			opts?.env ??
			({
				CHAIN_SOL_URL: KEYED_URL,
				CHAIN_SOL_HOT_ADDRESS: HOT,
			} as NodeJS.ProcessEnv),
	};
}

// --------------------------------------------------------------- the wiring

test("A POOL PASSED TO THE RAIL REACHES THE THING THAT ISSUES", async () => {
	/*
	 * The observable consequence, not the plumbing — same choice
	 * blockpoolwiring makes. A rail that received the pool takes an address out
	 * of it; one that did not could not. Asserting the behaviour means this
	 * keeps working if the pool is ever threaded through differently.
	 *
	 * The evidence override is what lets an OPEN rail exist in a test at all.
	 * `solRailFromEnv`, the production constructor, cannot accept it.
	 */
	const r = rig();
	const before = r.pool.status();
	assert.equal(before.free, 4, "the fixture must start with addresses");

	const rail = new SolDepositRail({
		env: r.env,
		pool: r.pool,
		consolidation: r.consolidation,
		evidence: ALL_PROVEN,
	});
	assert.equal(rail.readiness().open, true, rail.readiness().unmet.map((u) => u.observed).join("; "));

	const issued = rail.issue("blockle-ex:wiring-test");
	assert.equal(issued.index, 0);
	assert.ok(issued.address.length >= 32);
	assert.equal(r.pool.status().issued, 1, "and it must come out of the pool");
	assert.equal(r.pool.status().free, 3);
	await Promise.resolve();
});

test("the pool is not consumed merely by constructing the rail", () => {
	// Wiring must not issue. If construction took an address, every service
	// restart would burn one and the pool would drain silently — and a SOL
	// refill is an operator ceremony, not a command.
	const r = rig();
	solRailFromEnv({ env: r.env, pool: r.pool, consolidation: r.consolidation });
	assert.equal(r.pool.status().free, 4);
	assert.equal(r.pool.status().issued, 0);
});

test("THE RAIL THAT REPORTS MUST BE THE RAIL THAT ISSUES — identity, not numbers", () => {
	/*
	 * THE BLOCK BUG, REPRODUCED DELIBERATELY.
	 *
	 * Two pool objects over the SAME database file report identical status. So
	 * the original startup log ("999 free of 1000") was perfectly accurate
	 * about an object nothing was wired to, and a status comparison would have
	 * passed. Only identity catches it.
	 */
	const r = rig();
	const rail = solRailFromEnv({
		env: r.env,
		pool: r.pool,
		consolidation: r.consolidation,
	});
	assertSolRailUsesPool(rail, r.pool); // the correct wiring

	const impostor = new SolAddressPool(r.db);
	assert.deepEqual(
		{ ...impostor.status() },
		{ ...r.pool.status() },
		"the premise of this test: two pools over one file agree completely",
	);
	assert.throws(
		() => assertSolRailUsesPool(rail, impostor),
		(e: unknown) => {
			assert.ok(e instanceof SolRailError);
			assert.match(e.message, /DIFFERENT address pool object/);
			assert.match(e.message, /1000 addresses sat unused/);
			return true;
		},
		"a second reference must not be mistaken for the wired one",
	);
});

test("the rail reports pool status from its OWN reference", () => {
	// So a startup log line cannot describe an object the rail does not hold.
	const r = rig();
	const rail = solRailFromEnv({
		env: r.env,
		pool: r.pool,
		consolidation: r.consolidation,
	});
	assert.equal(rail.poolStatus().total, 4);
	r.pool.take("acct-1");
	assert.equal(rail.poolStatus().issued, 1, "the rail sees the pool it was given change");
	assert.ok(rail.sharesPoolWith(r.pool));
	assert.ok(!rail.sharesPoolWith(new SolAddressPool(r.db)));
});

// ------------------------------------------------- the rail stays shut

test("A FULL POOL DOES NOT OPEN THE RAIL — the precondition is in code", () => {
	/*
	 * The one-way door, in its modern form. Loading a pool is one command and
	 * is the half that LOOKS like the rail working: the rail could return an
	 * address immediately. It refuses, because nothing can sweep or send SOL
	 * back out yet, and a credited deposit with no retrievable asset behind it
	 * is the state rule 4 exists to forbid.
	 */
	const r = rig({ addresses: 1000 });
	const rail = solRailFromEnv({
		env: r.env,
		pool: r.pool,
		consolidation: r.consolidation,
	});
	const readiness = rail.readiness();
	assert.equal(readiness.open, false, "the live evidence table must still be empty");
	assert.throws(
		() => rail.issue("acct-1"),
		(e: unknown) => {
			assert.ok(e instanceof SolRailError);
			assert.match(e.message, /SOL deposits are not open/);
			assert.match(e.message, /could be issued right now/);
			return true;
		},
	);
	assert.equal(r.pool.status().issued, 0, "and the refusal must not consume an address");
});

test("every unmet requirement is reported, with an owner, not just the first", () => {
	// "The rail is shut" is useless; "shut for four reasons owned by three
	// different people" is actionable. Same reasoning as RailBlocker.causes
	// being a list.
	const r = rig({ addresses: 0, env: {} as NodeJS.ProcessEnv });
	const readiness = solRailReadiness({
		poolStatus: { total: 0, free: 0 },
		endpointUrl: "",
		hotAddress: "",
	});
	assert.equal(readiness.open, false);
	assert.equal(
		readiness.unmet.length,
		SOL_RAIL_REQUIREMENTS.length,
		"a bare box meets nothing",
	);
	assert.ok(readiness.unmet.some((u) => u.requirement.id === "pool-loaded"));
	assert.ok(readiness.unmet.some((u) => u.requirement.owner === "commercial"));
	assert.ok(readiness.unmet.some((u) => u.requirement.owner === "operator"));
	assert.ok(readiness.unmet.some((u) => u.requirement.owner === "engineering"));
	// A withdrawal-side requirement blocks deposits too: rule 4 ties them.
	assert.ok(readiness.unmet.some((u) => u.requirement.half === "withdrawal"));
	void r;
});

test("an exhausted pool is unmet even though a batch was once loaded", () => {
	const r = rig({ addresses: 1 });
	r.pool.take("acct-1");
	const readiness = solRailReadiness({
		poolStatus: { total: 1, free: 0 },
		endpointUrl: KEYED_URL,
		hotAddress: HOT,
		evidence: ALL_PROVEN,
	});
	assert.equal(readiness.open, false);
	assert.match(
		readiness.unmet.find((u) => u.requirement.id === "pool-loaded")?.observed ?? "",
		/all 1 pool addresses are issued/,
	);
});

// ------------------------------------------------------------- endpoints

test("THE ENDPOINTS WE ACTUALLY HAVE ARE REFUSED BY NAME", () => {
	/*
	 * Each of these was measured, and each fails in a way a scanner cannot
	 * detect: publicnode returns n=3 signatures at HTTP 200 where mainnet-beta
	 * returns n=1000; mainnet-beta 429s under burst; our own relay inherits
	 * publicnode AND sits behind the shared login limiter, where a polling
	 * scanner could lock real users out of their accounts.
	 */
	for (const d of SOL_ENDPOINT_DENYLIST) {
		const url = d.match.startsWith("/")
			? `https://blockle.org${d.match}`
			: `https://${d.match}`;
		const v = checkSolEndpoint(url);
		assert.equal(v.ok, false, url);
		assert.match(v.why ?? "", /must not carry a deposit rail/);
	}
	assert.equal(checkSolEndpoint(KEYED_URL).ok, true);
	assert.equal(checkSolEndpoint("").ok, false);
	assert.equal(checkSolEndpoint("ws://sol.example.net").ok, false);
});

test("a denylisted endpoint keeps the rail shut even with everything else proven", () => {
	const r = rig();
	const rail = new SolDepositRail({
		env: {
			CHAIN_SOL_URL: "https://solana-rpc.publicnode.com",
			CHAIN_SOL_HOT_ADDRESS: HOT,
		} as NodeJS.ProcessEnv,
		pool: r.pool,
		consolidation: r.consolidation,
		evidence: ALL_PROVEN,
	});
	assert.equal(rail.readiness().open, false);
	assert.throws(() => rail.issue("acct-1"), /silently truncates/);
});

// ----------------------------------------------- settlement must agree

test("WHILE THE RAIL IS UNREADY, SETTLEMENT STILL SAYS SO", () => {
	/*
	 * The plausible mistake this catches: somebody reads the new pool and
	 * sweeper code, concludes the engineering cause is stale, and deletes the
	 * SOL entry from RAIL_BLOCKERS. The deposit screen would then fall through
	 * to the generic "no address is provisioned" paragraph that RAIL_BLOCKERS
	 * exists to replace, with no cause attached anywhere.
	 */
	const shut = solRailReadiness({
		poolStatus: { total: 0, free: 0 },
		endpointUrl: "",
		hotAddress: "",
	});
	assert.doesNotThrow(() => assertSolRailBlockedUnlessProven(shut));

	const blocker = RAIL_BLOCKERS.SOL;
	assert.ok(blocker !== undefined, "SOL must still be recorded as blocked");
	assert.ok(blocker.causes.length >= 1);
	assert.equal("SOL" in PROVEN_RAILS, false, "and must not be claimed as proven");

	/*
	 * The assertion's own failure paths, exercised against substituted tables
	 * rather than by mutating the real ones — a safety check that can only be
	 * tested by making the whole suite order-dependent is not worth having.
	 */
	assert.throws(
		() => assertSolRailBlockedUnlessProven(shut, { blockers: { SOL: { causes: [] } } }),
		/no outstanding cause for SOL/,
		"an emptied blocker with an unready rail must refuse to start",
	);
	assert.throws(
		() => assertSolRailBlockedUnlessProven(shut, { blockers: { SOL: undefined } }),
		/Refusing to start/,
		"a deleted blocker is the same mistake",
	);
	assert.throws(
		() => assertSolRailBlockedUnlessProven(shut, { proven: { SOL: { rail: "SOL" } } }),
		/PROVEN_RAILS claims SOL/,
		"and claiming it proven on the strength of a loaded pool is the one-way door",
	);
});

test("a READY rail that is still recorded as blocked does NOT refuse to start", () => {
	// Deliberately one-directional. That state is merely conservative — the
	// rail stays shut — and refusing to start over a cautious table would turn
	// caution into an outage.
	const open = solRailReadiness({
		poolStatus: { total: 10, free: 10 },
		endpointUrl: KEYED_URL,
		hotAddress: HOT,
		evidence: ALL_PROVEN,
	});
	assert.equal(open.open, true);
	assert.doesNotThrow(() => assertSolRailBlockedUnlessProven(open));
});

test("the production constructor cannot be handed fabricated evidence", () => {
	/*
	 * `solRailFromEnv` takes {env, pool, consolidation} and nothing else, so
	 * no deployment path can inject a proof that was never observed. This is
	 * asserted structurally — the rail built from the environment is shut on
	 * this machine, because the live evidence table is empty.
	 */
	const r = rig();
	const rail = solRailFromEnv({
		env: r.env,
		pool: r.pool,
		consolidation: r.consolidation,
	});
	assert.equal(rail.readiness().open, false);
	assert.deepEqual(
		Object.values(SOL_RAIL_EVIDENCE).filter((p) => p !== undefined),
		[],
		"SOL_RAIL_EVIDENCE must stay empty until something is actually proven",
	);
});
