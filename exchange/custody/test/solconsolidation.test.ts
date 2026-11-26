// -----------------------------------------------------------------------------
// SOLANA CONSOLIDATION TESTS — the half that makes a SOL deposit returnable.
//
// WHAT IS BEING DEFENDED, IN THE ORDER IT WOULD COST MONEY:
//
//   1. SWEEP TO CLOSE. The amount must be the ENTIRE balance. Solana rejects a
//      transfer that leaves a nonzero balance below 650,240 lamports, so a
//      "leave a little behind" sweep either fails outright or strands the rent
//      minimum at every address forever. Zero is allowed and recovers
//      everything.
//   2. THE PACKET LIMIT. A batch over 1,232 bytes is rejected by the cluster.
//      The arithmetic is tested here rather than discovered at submit time,
//      after an operator has carried a proposal to an air-gapped machine.
//   3. THE DUST FLOOR. An account holding less than the cost of moving it is
//      recorded and left alone — not retried, not credited, not silently kept.
//   4. THE SOURCES ARE OURS, AT THE INDEX WE CLAIM. The signer re-derives
//      every source from its own seed and rejects the whole batch on any
//      mismatch; this mirrors that check online so the failure happens before
//      the walk to the signer, and so a source we cannot map to an index never
//      reaches a proposal at all.
//   5. THE FEE IS POSTED. A sweep whose fee is not booked makes holdings fall
//      by amount+fee while books fall by amount — a small, persistent, GROWING
//      shortfall, which has no tolerance at any size and halts the asset. The
//      venue would have halted itself over a 5,000-lamport omission.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import Database from "better-sqlite3";

import { base58Encode } from "../src/soladdress";
import { SolAddressPool } from "../src/soladdresspool";
import {
	SOL_LAMPORTS_PER_SIGNATURE,
	SOL_MAX_SOURCES_PER_SWEEP,
	SOL_MINIMUM_DEPOSIT_LAMPORTS,
	SOL_RENT_EXEMPT_MINIMUM_LAMPORTS,
	SOL_SWEEP_DUST_FLOOR_LAMPORTS,
	SOL_TX_SIZE_LIMIT,
	SolConsolidation,
	SolConsolidationError,
	formatSol,
	maxSourcesByTxSize,
	strandedAccounts,
	strandedDepositMessage,
	sweepLedgerShape,
	sweepTxBytes,
} from "../src/solconsolidation";

function freshAddress(): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" });
	return base58Encode(new Uint8Array(der.subarray(der.length - 32)));
}

const HOT = freshAddress();

interface Rig {
	readonly db: Database.Database;
	readonly pool: SolAddressPool;
	readonly sweeper: SolConsolidation;
	readonly addresses: readonly string[];
}

/** A pool of `n` loaded addresses plus a sweeper pointed at a hot account. */
function rig(n: number, now?: () => Date): Rig {
	const db = new Database(":memory:");
	const pool = new SolAddressPool(db);
	const entries = Array.from({ length: n }, (_, i) => ({
		index: i,
		address: freshAddress(),
	}));
	pool.load(entries);
	const sweeper =
		now === undefined
			? new SolConsolidation(db, pool, { hotAddress: HOT })
			: new SolConsolidation(db, pool, { hotAddress: HOT }, now);
	return { db, pool, sweeper, addresses: entries.map((e) => e.address) };
}

/** A balance read, as the (not yet written) scanner would hand it over. */
function bal(r: Rig, index: number, lamports: bigint) {
	return { index, address: r.addresses[index] as string, lamports };
}

// ----------------------------------------------------------- the arithmetic

test("THE PACKET LIMIT IS ARITHMETIC, NOT A GUESS", () => {
	/*
	 * 113n + 198 bytes. Nine sources is 1,215 and fits; ten is 1,328 and the
	 * cluster rejects it. The policy cap is eight, and the spare slot is
	 * deliberate: a compute-budget instruction or a versioned transaction
	 * changes the header, and finding that out at submit time wastes a trip to
	 * the signer host.
	 */
	assert.equal(sweepTxBytes(1), 311);
	assert.equal(sweepTxBytes(8), 1102);
	assert.equal(sweepTxBytes(9), 1215);
	assert.equal(sweepTxBytes(10), 1328);
	assert.ok(sweepTxBytes(9) <= SOL_TX_SIZE_LIMIT);
	assert.ok(sweepTxBytes(10) > SOL_TX_SIZE_LIMIT);
	assert.equal(maxSourcesByTxSize(), 9);
	assert.ok(
		SOL_MAX_SOURCES_PER_SWEEP < maxSourcesByTxSize(),
		"the policy cap must keep margin under the hard ceiling",
	);
});

test("a configured batch size over the packet limit is refused at construction", () => {
	const r = rig(1);
	assert.throws(
		() =>
			new SolConsolidation(r.db, r.pool, {
				hotAddress: HOT,
				maxSourcesPerSweep: 20,
			}),
		/over Solana's 1232-byte packet limit/,
	);
});

test("THE DUST FLOOR AND THE PUBLISHED MINIMUM ARE DERIVED, and rent is not the floor", () => {
	/*
	 * The floor is 3x the signature fee, because a deposit must afford being
	 * swept in, moved, and withdrawn. It is NOT the rent-exempt minimum: under
	 * sweep-to-close nothing stays behind, and confusing the two is the
	 * difference between a 0.001 SOL published minimum and a 0.01 SOL one that
	 * turns real deposits away.
	 */
	assert.equal(SOL_SWEEP_DUST_FLOOR_LAMPORTS, 3n * SOL_LAMPORTS_PER_SIGNATURE);
	assert.equal(SOL_SWEEP_DUST_FLOOR_LAMPORTS, 15_000n);
	assert.ok(
		SOL_MINIMUM_DEPOSIT_LAMPORTS >= 10n * SOL_SWEEP_DUST_FLOOR_LAMPORTS,
		"the published minimum carries at least 10x the floor, so a fee spike " +
			"between sending and sweeping cannot strand a deposit",
	);
	assert.ok(
		SOL_SWEEP_DUST_FLOOR_LAMPORTS < SOL_RENT_EXEMPT_MINIMUM_LAMPORTS,
		"if the floor ever reaches the rent minimum, sweep-to-close has been " +
			"abandoned and the published minimum must be revisited",
	);
	assert.equal(formatSol(SOL_MINIMUM_DEPOSIT_LAMPORTS), "0.001");
	assert.equal(formatSol(1_000_000_000n), "1");
	assert.equal(formatSol(0n), "0");
});

// --------------------------------------------------------------- planning

test("SWEEP TO CLOSE: the amount is the entire balance, always", () => {
	const r = rig(3);
	const plan = r.sweeper.plan({
		balances: [bal(r, 0, 2_000_000n), bal(r, 1, 500_000n), bal(r, 2, 1n * 10n ** 9n)],
		atSlot: 474_000_000,
	});
	assert.equal(plan.batches.length, 1);
	const batch = plan.batches[0];
	assert.ok(batch !== undefined);
	assert.equal(batch.sources.length, 3);
	for (const s of batch.sources) {
		const read = [2_000_000n, 500_000n, 10n ** 9n][s.index];
		assert.equal(s.lamports, read, "a partial sweep would fail for rent or strand it");
	}
	assert.equal(batch.lamports, 2_000_000n + 500_000n + 10n ** 9n);
	assert.equal(plan.totalLamports, batch.lamports);
});

test("the fee payer and the destination are the hot account, never a source", () => {
	/*
	 * A source cannot pay its own fee and also reach zero: the fee comes off
	 * the fee payer and SystemProgram::transfer fixes the amount at signing
	 * time. A per-source fee payer would also forbid batching outright, since
	 * a transaction has exactly one.
	 */
	const r = rig(2);
	const plan = r.sweeper.plan({ balances: [bal(r, 0, 1_000_000n)], atSlot: 1 });
	const batch = plan.batches[0];
	assert.ok(batch !== undefined);
	assert.equal(batch.feePayer, HOT);
	assert.equal(batch.destination, HOT);
	assert.ok(!batch.sources.some((s) => s.address === HOT));
	// One signature per source plus the fee payer's.
	assert.equal(batch.feeLamports, 2n * SOL_LAMPORTS_PER_SIGNATURE);
	assert.equal(plan.totalFeeLamports, batch.feeLamports);
});

test("batches respect the source cap, and every batch fits in a packet", () => {
	const r = rig(20);
	const plan = r.sweeper.plan({
		balances: Array.from({ length: 20 }, (_, i) => bal(r, i, 1_000_000n)),
		atSlot: 7,
	});
	assert.equal(plan.batches.length, 3, "20 sources at 8 per transaction");
	assert.deepEqual(
		plan.batches.map((b) => b.sources.length),
		[8, 8, 4],
	);
	for (const b of plan.batches) {
		assert.ok(b.bytes <= SOL_TX_SIZE_LIMIT, `${b.bytes} bytes`);
		assert.equal(b.bytes, sweepTxBytes(b.sources.length));
	}
	// Lowest index first, so two plans over the same pool are comparable.
	assert.deepEqual(
		plan.batches[0]?.sources.map((s) => s.index),
		[0, 1, 2, 3, 4, 5, 6, 7],
	);
});

test("the proposal key is deterministic in the sources and the slot", () => {
	// A signed batch re-broadcast must be recognisable as one already
	// submitted, or it becomes a second payment. The key is what the
	// broadcaster will dedupe on across the offline gap.
	const r = rig(4);
	const balances = [bal(r, 0, 1_000_000n), bal(r, 2, 2_000_000n)];
	const first = r.sweeper.plan({ balances, atSlot: 99 });
	const again = r.sweeper.plan({ balances, atSlot: 99 });
	assert.equal(first.batches[0]?.proposalKey, again.batches[0]?.proposalKey);
	assert.equal(first.batches[0]?.proposalKey, "solsweep:99:0-2");
	const later = r.sweeper.plan({ balances, atSlot: 100 });
	assert.notEqual(first.batches[0]?.proposalKey, later.batches[0]?.proposalKey);
});

test("a plan without a slot is refused", () => {
	// Without it the operator and the signer have nothing to compare, and a
	// stale proposal is indistinguishable from a fresh one.
	const r = rig(1);
	assert.throws(
		() => r.sweeper.plan({ balances: [bal(r, 0, 1_000_000n)], atSlot: -1 }),
		/must name the slot/,
	);
});

test("empty accounts are counted and otherwise ignored", () => {
	const r = rig(3);
	const plan = r.sweeper.plan({
		balances: [bal(r, 0, 0n), bal(r, 1, 0n), bal(r, 2, 1_000_000n)],
		atSlot: 5,
	});
	assert.equal(plan.emptyAccounts, 2);
	assert.equal(plan.batches.length, 1);
	assert.equal(plan.batches[0]?.sources.length, 1);
	assert.equal(plan.stranded.length, 0, "an empty account is not stranded, it is empty");
});

// ------------------------------------------------------- the stranded cases

test("AN ACCOUNT THAT CANNOT AFFORD ITS OWN SWEEP IS RECORDED, NOT RETRIED", () => {
	/*
	 * 9,000 lamports is under the 15,000 floor: moving it costs more than it is
	 * worth. Nothing is submitted for it — there is no retry loop to back off
	 * — and the row is what makes the amount answerable when the customer
	 * asks, and what gives the reconciler's surplus a name.
	 */
	const r = rig(2);
	const plan = r.sweeper.plan({
		balances: [bal(r, 0, 9_000n), bal(r, 1, 1_000_000n)],
		atSlot: 11,
	});
	assert.equal(plan.batches.length, 1);
	assert.equal(plan.batches[0]?.sources.length, 1, "only the fundable account is swept");
	assert.equal(plan.stranded.length, 1);
	const s = plan.stranded[0];
	assert.ok(s !== undefined);
	assert.equal(s.index, 0);
	assert.equal(s.lamports, 9_000n);
	assert.equal(s.reason, "below_dust_floor");
	assert.equal(s.observations, 1);
	// And it is durable: the report does not depend on holding the plan.
	assert.equal(r.sweeper.stranded().length, 1);
	assert.equal(r.sweeper.strandedLamports(), 9_000n);
	assert.equal(strandedAccounts(r.db).length, 1);
	assert.equal(r.sweeper.sweepable(9_000n), false);
	assert.equal(r.sweeper.sweepable(15_000n), true);
});

test("re-observing a stranded account counts it rather than duplicating it", () => {
	const r = rig(1);
	for (let i = 0; i < 3; i += 1) {
		r.sweeper.plan({ balances: [bal(r, 0, 9_000n)], atSlot: 100 + i });
	}
	const open = r.sweeper.stranded();
	assert.equal(open.length, 1);
	assert.equal(open[0]?.observations, 3);
	assert.equal(open[0]?.firstSeenAt !== undefined, true);
});

test("STRANDING IS SELF-HEALING, which is only true because the address is permanent", () => {
	/*
	 * The customer-facing promise is "it is still there — deposit more to the
	 * same address and we will sweep the combined balance". That is honest
	 * only because a pool address belongs to one customer forever, so the next
	 * pass over a topped-up account sweeps it and resolves the row. Without
	 * this the honest sentence would have to be "contact support".
	 */
	const r = rig(1);
	r.sweeper.plan({ balances: [bal(r, 0, 9_000n)], atSlot: 1 });
	assert.equal(r.sweeper.stranded().length, 1);

	const plan = r.sweeper.plan({ balances: [bal(r, 0, 9_000n + 1_000_000n)], atSlot: 2 });
	assert.equal(plan.batches[0]?.sources[0]?.lamports, 1_009_000n, "the COMBINED balance");
	assert.equal(r.sweeper.stranded().length, 0, "and the row is resolved");
	assert.equal(r.sweeper.strandedHistory().length, 1, "but not forgotten");

	// A later sub-floor deposit strands it again rather than staying resolved.
	r.sweeper.plan({ balances: [bal(r, 0, 100n)], atSlot: 3 });
	assert.equal(r.sweeper.stranded().length, 1);
});

test("the stranded sentence tells the customer the money is still theirs", () => {
	const msg = strandedDepositMessage(9_000n);
	assert.match(msg, /0\.000009 SOL arrived/);
	assert.match(msg, /below our 0\.001 SOL minimum/);
	assert.match(msg, /It is still there/);
	assert.match(msg, /deposit more to the same address/);
});

// ---------------------------------------------------- refusals that matter

test("A SOURCE THAT IS NOT IN THE POOL NEVER REACHES A PROPOSAL", () => {
	// No index means no key can be re-derived, so the signer would reject the
	// batch. Refusing here means the operator finds out before the trip, and
	// it is the same check the signer makes from its own seed.
	const r = rig(1);
	assert.throws(
		() =>
			r.sweeper.plan({
				balances: [{ index: 0, address: freshAddress(), lamports: 1_000_000n }],
				atSlot: 1,
			}),
		/not in the SOL address pool/,
	);
});

test("A CLAIMED INDEX THAT DISAGREES WITH THE POOL IS REFUSED", () => {
	const r = rig(3);
	assert.throws(
		() =>
			r.sweeper.plan({
				balances: [{ index: 2, address: r.addresses[0] as string, lamports: 1_000_000n }],
				atSlot: 1,
			}),
		/is pool index 0 but the balance read says 2/,
	);
});

test("THE HOT ADDRESS MUST NOT BE A POOL ADDRESS", () => {
	/*
	 * A one-character configuration mistake with no on-chain symptom: sweeping
	 * into a customer's deposit address credits the venue's whole balance to
	 * that customer, because that is exactly the address set the scanner
	 * attributes by. Refused at construction rather than discovered in a
	 * reconciliation report.
	 */
	const r = rig(2);
	assert.throws(
		() => new SolConsolidation(r.db, r.pool, { hotAddress: r.addresses[0] as string }),
		/is a POOL address/,
	);
});

test("an unusable hot address is refused at construction", () => {
	const r = rig(1);
	for (const bad of ["", "ComputeBudget111111111111111111111111111111", "not base58 0O"]) {
		assert.throws(
			() => new SolConsolidation(r.db, r.pool, { hotAddress: bad }),
			/hot address is not usable/,
			JSON.stringify(bad),
		);
	}
});

test("a negative balance is a decoding bug, not a plan input", () => {
	const r = rig(1);
	assert.throws(
		() => r.sweeper.plan({ balances: [bal(r, 0, -1n)], atSlot: 1 }),
		(e: unknown) => {
			assert.ok(e instanceof SolConsolidationError);
			assert.match(e.message, /not a chain read/);
			return true;
		},
	);
});

test("a dust floor of zero is refused", () => {
	const r = rig(1);
	assert.throws(
		() => new SolConsolidation(r.db, r.pool, { hotAddress: HOT, dustFloorLamports: 0n }),
		/floor of zero sweeps accounts that cost more to move than they hold/,
	);
});

// ------------------------------------------------------------ the ledger

test("THE LEDGER SHAPE INCLUDES THE FEE, which is the posting that gets forgotten", () => {
	/*
	 * Omit it and holdings fall by amount+fee while books fall by amount: a
	 * small, persistent, steadily growing shortfall, no tolerance at any size,
	 * withdrawals halted for the asset. Entirely self-inflicted, by not
	 * writing down 5,000 lamports.
	 */
	const r = rig(2);
	const plan = r.sweeper.plan({
		balances: [bal(r, 0, 1_000_000n), bal(r, 1, 2_000_000n)],
		atSlot: 42,
	});
	const batch = plan.batches[0];
	assert.ok(batch !== undefined);
	const shape = sweepLedgerShape(batch);
	assert.equal(shape.idempotencyKey, batch.proposalKey);
	assert.equal(shape.movements.length, 3, "two custody movements and one fee movement");
	assert.ok(
		shape.movements.some((m) => m.startsWith("FEES[SOL]")),
		"the fee movement must be part of the same shape, not an afterthought",
	);
	assert.ok(shape.movements.every((m) => m.includes("CUSTODY") || m.includes("FEES")));
});
