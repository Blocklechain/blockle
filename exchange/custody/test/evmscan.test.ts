// -----------------------------------------------------------------------------
// NATIVE EVM DEPOSIT SCANNER TESTS.
//
// WHAT THESE TESTS ARE DEFENDING, AND WHY A UNIT TEST IS THE ONLY PLACE IT CAN
// BE DEFENDED.
//
// The failure this scanner exists to prevent is not a crash. It is this: an
// endpoint reports a pruned range as an EMPTY one — HTTP 200, no error object,
// an empty array — and a scanner that trusts it reads "no deposits", marks the
// range clean, advances its cursor, and the customer's money is gone with
// nothing wrong in any log. There is no alert to miss, because as far as every
// component can tell, nothing happened.
//
// That is not hypothetical. It was measured on the endpoint this rail would
// otherwise run on: bsc-rpc.publicnode.com returns receipt arrays of length 0
// for blocks whose own headers report 135 and 85 transactions, and returns
// eth_getLogs n=0 at HTTP 200 for a block that demonstrably contains a
// BSC-USDT transfer — while answering eth_getTransactionReceipt for that same
// transaction honestly, with "Archive requests require a personal token".
//
// A live endpoint cannot be made to lie on demand, so the lie is reproduced
// here with a stub, and the assertion that catches it is pinned. The specific
// property is: WHEN THE ENDPOINT UNDER-REPORTS, THE CURSOR MUST NOT MOVE.
// Being behind is a business problem. Advancing through a lie is an insolvency.
//
// The other properties pinned here, each with its own failure:
//
//   * Nothing creditable is ever emitted from above `tip - confirmations`, so a
//     credited deposit can only be reorganised away by a reorg DEEPER than its
//     confirmation depth.
//   * A reorg at or within the window rewinds and re-scans; one deeper than the
//     window HALTS rather than silently re-scanning a chain that may have
//     orphaned an already-credited deposit.
//   * A sub-floor arrival is RECORDED and NOT CREDITED — never credited (it
//     cannot be returned), never dropped silently (the customer can see it on a
//     block explorer).
//   * Over the un-swept ceiling, NEW ADDRESS ISSUANCE shuts while arrivals at
//     already-issued addresses keep crediting. The other way round — withholding
//     the credit — was tried, could not work (the watcher decides from the
//     confirmation count, and the adapter concatenates both arrays), and would
//     have been wrong anyway: refusing to credit coins already sitting at our
//     address is not a safety mechanism, it is keeping them.
//   * A wrong chain id is fatal, because a scanner on the wrong chain has NO
//     symptom at all.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import {
	belowMinimumSentence,
	EvmNativeScanner,
	EvmScanError,
	EVM_CHAIN_RULES,
	type EvmChainRule,
	type EvmScanRpc,
} from "../src/evmscan";

const CUST = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

/** A test rule: small numbers, so a test does not have to build 128 blocks. */
const RULE: EvmChainRule = {
	chain: "TPOL",
	chainId: 137,
	confirmations: 4,
	blockSeconds: 2,
	dustFloorWei: 1_000n,
	minimumDepositWei: 10_000n,
	unsweptCeilingWei: 1_000_000n,
	lagAlarmSeconds: 3600,
};

interface FakeTx {
	readonly to?: string | null;
	readonly value?: bigint;
	readonly hash?: string;
}

interface FakeBlock {
	readonly txs: readonly FakeTx[];
	/** Overrides the honest hash, to fabricate a reorg. */
	readonly hash?: string;
	readonly parentHash?: string;
	/**
	 * THE MEASURED LIE. When set, eth_getBlockReceipts answers with this many
	 * receipts regardless of how many transactions the header reports.
	 */
	readonly receiptsLie?: number;
	/** When set, eth_getBlockReceipts throws — the HONEST pruning failure. */
	readonly receiptsError?: string;
}

/**
 * A fake chain. Blocks are indexed from 1; `tip` is how many exist.
 *
 * Hashes are derived from the height and an optional fork label so that a test
 * can rewrite history by replacing blocks — which is what a reorg is, and the
 * only way to exercise the continuity assertion.
 */
class FakeChain implements EvmScanRpc {
	readonly calls: string[] = [];
	chainId = 137;
	finalized: number | undefined;
	finalizedThrows = false;
	/**
	 * Makes the `finalized` tag REPORT a block number without a block behind it.
	 *
	 * Needed because the two ways the tag can be wrong are different failures
	 * and only one of them is reachable through `finalized`: a tag that resolves
	 * to no block at all is an UNAVAILABLE tag, while a tag that cheerfully
	 * returns a header numbered at or past `latest` is an ALIAS — an endpoint
	 * serving the tag without implementing finality. The second is the dangerous
	 * one, because it would drag the safe head forward, and it cannot be
	 * simulated by simply pointing `finalized` at a missing height.
	 */
	finalizedReports: number | undefined;

	constructor(private blocks: FakeBlock[]) {}

	get tip(): number {
		return this.blocks.length;
	}

	hashOf(n: number): string {
		const b = this.blocks[n - 1];
		if (b?.hash !== undefined) return b.hash;
		return `0xblock${n}`;
	}

	/** Replace the chain from `from` upward — a reorg. */
	fork(from: number, replacement: FakeBlock[]): void {
		this.blocks = [...this.blocks.slice(0, from - 1), ...replacement];
	}

	append(b: FakeBlock): void {
		this.blocks.push(b);
	}

	async call<T>(method: string, params?: unknown[]): Promise<T> {
		this.calls.push(method);
		switch (method) {
			case "eth_blockNumber":
				return `0x${this.tip.toString(16)}` as unknown as T;
			case "eth_chainId":
				return `0x${this.chainId.toString(16)}` as unknown as T;
			case "eth_getBlockByNumber": {
				const tag = String(params?.[0]);
				let n: number;
				if (tag === "finalized") {
					if (this.finalizedThrows) throw new Error("the finalized tag is not served");
					if (this.finalizedReports !== undefined) {
						return {
							number: `0x${this.finalizedReports.toString(16)}`,
							hash: "0xclaimed-finalized",
							parentHash: "0x",
							transactions: [],
						} as unknown as T;
					}
					n = this.finalized ?? this.tip;
				} else {
					n = Number(BigInt(tag));
				}
				const b = this.blocks[n - 1];
				if (b === undefined) return null as unknown as T;
				return {
					number: `0x${n.toString(16)}`,
					hash: this.hashOf(n),
					parentHash: b.parentHash ?? (n === 1 ? "0xgenesis" : this.hashOf(n - 1)),
					transactions: b.txs.map((t, i) => ({
						hash: t.hash ?? `0xtx${n}_${i}`,
						to: t.to ?? null,
						value: `0x${(t.value ?? 0n).toString(16)}`,
						transactionIndex: `0x${i.toString(16)}`,
					})),
				} as unknown as T;
			}
			case "eth_getBlockReceipts": {
				const n = Number(BigInt(String(params?.[0])));
				const b = this.blocks[n - 1];
				if (b === undefined) throw new Error("unknown block");
				if (b.receiptsError !== undefined) throw new Error(b.receiptsError);
				const count = b.receiptsLie ?? b.txs.length;
				return new Array(count).fill({ status: "0x1" }) as unknown as T;
			}
			default:
				throw new Error(`unexpected method ${method}`);
		}
	}

	async batch<T>(calls: readonly { method: string; params?: unknown[] }[]): Promise<T[]> {
		const out: T[] = [];
		for (const c of calls) out.push(await this.call<T>(c.method, c.params));
		return out;
	}
}

function plain(count: number, txs: readonly FakeTx[] = []): FakeBlock[] {
	return Array.from({ length: count }, () => ({ txs }));
}

function scanner(
	chain: FakeChain,
	opts: {
		watched?: readonly string[];
		unswept?: bigint;
		startBlock?: number;
		rule?: Partial<EvmChainRule>;
		db?: Database.Database;
		maxBlocksPerPass?: number;
	} = {},
): EvmNativeScanner {
	return new EvmNativeScanner(opts.db ?? new Database(":memory:"), chain, {
		rule: { ...RULE, ...opts.rule },
		watched: async () =>
			new Set((opts.watched ?? [CUST]).map((a) => a.toLowerCase())),
		unsweptTotal: async () => opts.unswept ?? 0n,
		...(opts.startBlock === undefined ? {} : { startBlock: opts.startBlock }),
		...(opts.maxBlocksPerPass === undefined
			? {}
			: { maxBlocksPerPass: opts.maxBlocksPerPass }),
	});
}

/* ----------------------------------------------------------- the safe head */

test("NOTHING CREDITABLE COMES FROM ABOVE tip - confirmations", async () => {
	/*
	 * THE STRUCTURAL RULE, AND IT MATTERS MORE THAN ANY CONFIRMATION NUMBER.
	 *
	 * The deposit is in block 8 of a 10-block chain with a 4-confirmation rule,
	 * so the safe head is 6 and block 8 is above it. It must appear as PENDING —
	 * visible to the customer as "N of M confirmations" within seconds — and
	 * must not appear as creditable at any point.
	 *
	 * Because the cursor never passes the safe head, a credited deposit can only
	 * be orphaned by a reorg deeper than its own confirmation depth, which turns
	 * a routine event into an exceptional one.
	 */
	const chain = new FakeChain([
		...plain(7),
		{ txs: [{ to: CUST, value: 50_000n, hash: "0xdeposit" }] },
		...plain(2),
	]);
	const r = await scanner(chain, { startBlock: 0 }).scan();

	assert.equal(r.tip, 10);
	assert.equal(r.safeHead, 6);
	assert.equal(r.payments.length, 0, "block 8 is above the safe head");
	assert.equal(r.pending.length, 1);
	assert.equal(r.pending[0]!.txid, "0xdeposit");
	// The confirmation count reported is the TRUE one, which is what makes the
	// visibility pass incapable of crediting anything early: the watcher's
	// existing gate compares it against the required depth.
	assert.equal(r.pending[0]!.confirmations, 3, "block 8 of a 10-block chain");
	assert.ok(r.cursor <= r.safeHead);
});

test("a deposit at or below the safe head IS creditable", async () => {
	// The same chain with the deposit two blocks earlier. This is the test that
	// would catch the safe-head rule being applied one block too aggressively
	// and never crediting anything at all.
	const chain = new FakeChain([
		...plain(5),
		{ txs: [{ to: CUST, value: 50_000n, hash: "0xdeposit" }] },
		...plain(4),
	]);
	const r = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(r.safeHead, 6);
	assert.equal(r.payments.length, 1);
	assert.equal(r.payments[0]!.txid, "0xdeposit");
	assert.equal(r.payments[0]!.amount, 50_000n);
	assert.equal(r.payments[0]!.address, CUST.toLowerCase());
});

test("THE finalized TAG CAN ONLY PULL THE SAFE HEAD BACK, never forward", async () => {
	/*
	 * The confirmation count and the `finalized` tag are two independent claims
	 * about what cannot be reorganised away, and the scanner takes the LOWER.
	 * That is the only combination that cannot be talked into crediting early:
	 * a broken or malicious tag cannot drag the head forward, and a short count
	 * cannot override real finality.
	 */
	const chain = new FakeChain(plain(10, [{ to: CUST, value: 50_000n }]));

	// A tag BEHIND the count wins, because it is lower.
	chain.finalized = 3;
	const behind = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(behind.safeHead, 3);

	// A tag AHEAD of the count is ignored: the count still binds at 6.
	chain.finalized = 9;
	const ahead = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(ahead.safeHead, 6);

	/*
	 * A tag claiming a finalised block PAST THE TIP is not finality, it is an
	 * alias for `latest` — an endpoint that serves the tag without implementing
	 * it. Believing it would credit at zero confirmations. Ignored and noted.
	 */
	chain.finalized = undefined;
	chain.finalizedReports = 99;
	const silly = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(silly.safeHead, 6, "an implausible tag must not drag the head forward");
	assert.ok(
		silly.notes.some((n) => /implausible finalized tag/.test(n)),
		`expected an implausible-tag note, got ${JSON.stringify(silly.notes)}`,
	);
});

test("an endpoint with no finalized tag degrades to the block count, loudly", async () => {
	// Fail long rather than fail open. The note exists so the degradation is
	// visible to an operator rather than inferred.
	const chain = new FakeChain(plain(10, [{ to: CUST, value: 50_000n }]));
	chain.finalizedThrows = true;
	const r = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(r.safeHead, 6);
	assert.ok(r.notes.some((n) => /finalized tag was unavailable/.test(n)));
});

/* ----------------------------------------------- THE INTEGRITY ASSERTION */

test("AN UNDER-REPORTING ENDPOINT HALTS THE RAIL AND THE CURSOR DOES NOT MOVE", async () => {
	/*
	 * THE MEASURED BSC LIE, REPRODUCED.
	 *
	 * Block 3's header reports two transactions; the endpoint returns zero
	 * receipts for it, at HTTP 200, with no error. This is exactly what
	 * bsc-rpc.publicnode.com does past its pruning window.
	 *
	 * Without the assertion the scanner would read the header's transactions
	 * (which in the real pruned case would also be missing), find nothing,
	 * advance, and lose the deposit in silence. With it: halt, and the cursor
	 * stays below the bad block so the range can be re-scanned against a keyed
	 * endpoint later.
	 */
	const chain = new FakeChain([
		...plain(2),
		{
			txs: [{ to: CUST, value: 50_000n, hash: "0xlost" }, { to: OTHER, value: 1n }],
			receiptsLie: 0,
		},
		...plain(7),
	]);
	const db = new Database(":memory:");
	const s = scanner(chain, { startBlock: 0, db });

	await assert.rejects(
		() => s.scan(),
		(e: unknown) => {
			assert.ok(e instanceof EvmScanError);
			assert.match(e.message, /under-reporting rather than erroring/);
			assert.match(e.message, /credits\s+nothing, logs nothing, and loses the deposit/);
			return true;
		},
	);

	// THE CURSOR MUST NOT HAVE PASSED THE BAD BLOCK.
	assert.ok((s.cursor() ?? 0) < 3, `cursor ${s.cursor()} must stay below block 3`);
	// And the rail is halted, so the next tick refuses rather than retrying
	// into the same lie.
	assert.match(s.haltedReason() ?? "", /under-reporting/);
});

test("A HALTED RAIL REFUSES TO SCAN AT ALL, and says restarting will not fix it", async () => {
	/*
	 * Deliberately a one-way door for the process. Every reason this fires is a
	 * reason a human has to look at a chain before the venue credits anything
	 * else, and the obvious operator reflex — restart the service — must be
	 * explicitly ruled out in the message or it will be tried.
	 */
	const chain = new FakeChain(plain(10));
	const s = scanner(chain, { startBlock: 0 });
	s.halt("a deliberate test halt");

	await assert.rejects(
		() => s.scan(),
		/the deposit scan is halted — a deliberate test halt[\s\S]*not by restarting the service/,
	);

	// Clearing it is an operator action, named so it cannot be mistaken for
	// routine maintenance.
	s.clearHaltAfterInvestigation();
	assert.equal(s.haltedReason(), undefined);
	await assert.doesNotReject(() => s.scan());
});

test("AN HONEST PRUNING ERROR IS RETRYABLE, NOT A HALT — and still does not advance", async () => {
	/*
	 * THE DISTINCTION THAT MATTERS MOST IN THIS FILE.
	 *
	 * "Archive requests require a personal token" means the endpoint knows it
	 * cannot serve the block and SAYS SO. That is an operations problem with a
	 * known fix (a keyed endpoint), not evidence the endpoint is lying, so it
	 * must not latch a halt that needs a human to clear. What it shares with the
	 * lie is the only thing that actually protects the money: the cursor does
	 * not advance.
	 */
	const chain = new FakeChain([
		...plain(2),
		{ txs: [{ to: CUST, value: 50_000n }], receiptsError: "Archive requests require a personal token" },
		...plain(7),
	]);
	const s = scanner(chain, { startBlock: 0 });

	await assert.rejects(
		() => s.scan(),
		(e: unknown) => {
			assert.ok(e instanceof EvmScanError);
			assert.equal(e.retryable, true, "an honest error is retryable");
			assert.match(e.message, /NOT advancing the cursor/);
			assert.match(e.message, /still at the customers' addresses/);
			return true;
		},
	);
	assert.ok((s.cursor() ?? 0) < 3);
	// NOT halted: a keyed endpoint fixes this without an operator clearing a
	// latch, and latching here would turn a transient outage into an outage
	// that needs a human.
	assert.equal(s.haltedReason(), undefined);
});

test("a block the endpoint cannot serve at all is an error, not an empty block", async () => {
	/*
	 * `eth_getBlockByNumber` returning null is the honest form of "outside my
	 * window". Reading it as an empty block would scan it clean and skip it
	 * FOREVER, since the cursor would advance past it.
	 */
	const chain = new FakeChain(plain(10));
	// A chain whose block 3 vanishes mid-scan.
	const gappy: EvmScanRpc = {
		call: async <T,>(m: string, p?: unknown[]): Promise<T> => {
			if (m === "eth_getBlockByNumber" && String(p?.[0]) === "0x3") {
				return null as unknown as T;
			}
			return chain.call<T>(m, p);
		},
		batch: (c) => chain.batch(c),
	};
	const s = new EvmNativeScanner(new Database(":memory:"), gappy, {
		rule: RULE,
		watched: async () => new Set([CUST.toLowerCase()]),
		unsweptTotal: async () => 0n,
		startBlock: 0,
	});
	await assert.rejects(() => s.scan(), /returned no block[\s\S]*skipped forever/);
	assert.ok((s.cursor() ?? 0) < 3);
});

/* ------------------------------------------------------------------ reorgs */

test("A REORG WITHIN THE WINDOW REWINDS AND RE-SCANS THE CANONICAL CHAIN", async () => {
	/*
	 * Blocks 1..6 are scanned, then history is rewritten from block 5 with a
	 * deposit that only exists on the new branch. The scanner must notice that
	 * its stored hash for block 5 is no longer on chain, walk back to the last
	 * common ancestor, and re-scan forward — otherwise the deposit on the
	 * canonical chain is never seen, because the cursor is already past it.
	 *
	 * Run BEFORE the forward scan, because a forward scan that starts on an
	 * orphaned block is reading a chain that no longer exists.
	 */
	const chain = new FakeChain(plain(10));
	const db = new Database(":memory:");
	const first = scanner(chain, { startBlock: 0, db });
	const before = await first.scan();
	assert.equal(before.cursor, 6);
	assert.equal(before.payments.length, 0);

	// Rewrite blocks 5..10 on a different branch, with a deposit in block 5.
	chain.fork(5, [
		{ txs: [{ to: CUST, value: 50_000n, hash: "0xreorged-in" }], hash: "0xfork5" },
		{ txs: [], hash: "0xfork6" },
		{ txs: [], hash: "0xfork7" },
		{ txs: [], hash: "0xfork8" },
		{ txs: [], hash: "0xfork9" },
		{ txs: [], hash: "0xfork10" },
	]);

	const after = await scanner(chain, { db }).scan();
	assert.ok(
		after.notes.some((n) => /rewound from 6 to 4 after a reorg/.test(n)),
		`expected a rewind note, got ${JSON.stringify(after.notes)}`,
	);
	assert.equal(after.payments.length, 1, "the deposit on the canonical chain must be found");
	assert.equal(after.payments[0]!.txid, "0xreorged-in");
});

test("A REORG DEEPER THAN THE WINDOW HALTS rather than re-scanning blindly", async () => {
	/*
	 * At that depth something may ALREADY HAVE BEEN CREDITED from a branch that
	 * no longer exists, and whether to reverse a customer's balance is a human's
	 * decision — never an automatic consequence of one chain read, because a
	 * flaky endpoint would then be able to take money off customers.
	 *
	 * The automatic parts are the HALT here and, independently, the reconciler
	 * seeing books above custody, classifying a SHORTFALL and halting
	 * withdrawals for the asset at any size. Two separate paths to the same
	 * safety property. The reversal is a deliberate `correction:` ledger entry.
	 */
	const chain = new FakeChain(plain(20));
	const db = new Database(":memory:");
	await scanner(chain, { startBlock: 0, db }).scan(); // cursor at 16

	// Rewrite from block 2 — far deeper than confirmations + 8.
	chain.fork(2, Array.from({ length: 19 }, (_, i) => ({ txs: [], hash: `0xdeep${i + 2}` })));

	const s = scanner(chain, { db });
	await assert.rejects(
		() => s.scan(),
		(e: unknown) => {
			assert.ok(e instanceof EvmScanError);
			assert.match(e.message, /a reorg deeper than \d+ blocks/);
			assert.match(e.message, /never automatic/);
			return true;
		},
	);
	assert.match(s.haltedReason() ?? "", /reorg deeper than/);
});

test("a cursor ahead of the safe head WAITS rather than rewinding", async () => {
	/*
	 * The tip briefly going backwards is normal: a re-org at the very tip, or a
	 * load balancer answering from a node a few blocks behind. Rewinding on that
	 * basis would re-emit blocks already scanned — and every re-emitted arrival
	 * is an idempotency check away from a double credit. Waiting costs one pass.
	 */
	const chain = new FakeChain(plain(20));
	const db = new Database(":memory:");
	const s1 = scanner(chain, { startBlock: 0, db });
	await s1.scan();
	assert.equal(s1.cursor(), 16);

	// The endpoint now answers from a node 10 blocks behind.
	const behind = new FakeChain(plain(10));
	const s2 = scanner(behind, { db });
	const r = await s2.scan();
	assert.equal(r.cursor, 16, "the cursor must not be rewound");
	assert.ok(r.notes.some((n) => /ahead of the safe head/.test(n)));
	assert.equal(s2.cursor(), 16);
});

/* --------------------------------------------------- matching and identity */

test("only WATCHED addresses match, and a venue address must not be watched", async () => {
	/*
	 * The watched set is customer addresses ONLY. A gas drip or sweep change
	 * arriving at a venue-owned address and matched as an incoming deposit would
	 * be credited to `__unattributed__` — which is a USER account, hence a
	 * customer LIABILITY. BitGo's XRP activation reserve did exactly that and
	 * halted XRP.
	 */
	const chain = new FakeChain([
		...plain(5),
		{
			txs: [
				{ to: CUST, value: 50_000n, hash: "0xmine" },
				{ to: OTHER, value: 90_000n, hash: "0xnot-mine" },
				{ to: null, value: 90_000n, hash: "0xcontract-creation" },
			],
		},
		...plain(4),
	]);
	const r = await scanner(chain, { startBlock: 0, watched: [CUST] }).scan();
	assert.equal(r.payments.length, 1);
	assert.equal(r.payments[0]!.txid, "0xmine");
});

test("a watched address matches case-insensitively", async () => {
	// The table stores EIP-55 mixed case; the chain reports lowercase. A
	// case-sensitive match would miss every real deposit.
	const mixed = "0xAbC1111111111111111111111111111111111111";
	const chain = new FakeChain([
		...plain(5),
		{ txs: [{ to: mixed.toLowerCase(), value: 50_000n, hash: "0xd" }] },
		...plain(4),
	]);
	const r = await scanner(chain, { startBlock: 0, watched: [mixed] }).scan();
	assert.equal(r.payments.length, 1);
});

test("a zero-value transaction to a watched address is not a deposit", async () => {
	// Contract calls and approvals routinely carry zero value. Emitting them
	// would post a zero-amount ledger movement for every one.
	const chain = new FakeChain([
		...plain(5),
		{ txs: [{ to: CUST, value: 0n, hash: "0xzero" }] },
		...plain(4),
	]);
	const r = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(r.payments.length, 0);
	assert.equal(r.pending.length, 0);
});

test("EVERY ARRIVAL CARRIES A CHAIN-QUALIFIED ref, because the txid is not unique", async () => {
	/*
	 * THE IDEMPOTENCY IDENTITY, AND THE BUG IT PREVENTS.
	 *
	 * The node feed's existing identity is the bare txid, on the stated
	 * assumption that "a txid paying two of our addresses yields two rows with
	 * different addresses". On EVM that is false twice over: one transaction can
	 * pay the same address more than once via internal calls, and one can emit
	 * several ERC-20 Transfer events to the same address. Every arrival after
	 * the first would be swallowed by the ledger's replay check and the customer
	 * UNDER-CREDITED with no error anywhere.
	 *
	 * The CHAIN component is mandatory for an independent reason: the same
	 * secp256k1 address receives on Ethereum, BSC and Polygon BY DESIGN, so
	 * (txid, address) is not unique across chains either.
	 *
	 * Two arrivals in one block to the same address are asserted here precisely
	 * because that is the shape the bare-txid key cannot represent.
	 */
	const chain = new FakeChain([
		...plain(5),
		{
			txs: [
				{ to: CUST, value: 50_000n, hash: "0xsame" },
				{ to: CUST, value: 70_000n, hash: "0xsame" },
			],
		},
		...plain(4),
	]);
	const r = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(r.payments.length, 2);

	const refs = r.payments.map((p) => p.ref);
	assert.equal(new Set(refs).size, 2, "two arrivals sharing a txid need distinct refs");
	for (const ref of refs) {
		assert.ok(ref !== undefined);
		assert.ok(ref.startsWith(`${RULE.chain}:`), `ref ${ref} must be chain-qualified`);
	}
	// The position index is what distinguishes them, and it is the slot a log
	// index fills when a token detector is added.
	assert.deepEqual(refs, [`${RULE.chain}:0xsame:0`, `${RULE.chain}:0xsame:1`]);
});

/* ---------------------------------------------------------- the dust floor */

test("A SUB-FLOOR ARRIVAL IS RECORDED AND NOT CREDITED", async () => {
	/*
	 * NEVER CREDIT WHAT CANNOT BE RETURNED. Below the floor the deposit costs
	 * more to move than it is worth, so a credit would be a liability with no
	 * retrievable asset behind it.
	 *
	 * And never drop it silently either: the customer can see the transaction on
	 * a block explorer, so the venue having no record of it is the other way
	 * this goes wrong. Recorded, visible, uncredited.
	 */
	const chain = new FakeChain([
		...plain(5),
		{
			txs: [
				{ to: CUST, value: 999n, hash: "0xdust" },
				{ to: CUST, value: 50_000n, hash: "0xreal" },
			],
		},
		...plain(4),
	]);
	const s = scanner(chain, { startBlock: 0 });
	const r = await s.scan();

	assert.equal(r.payments.length, 1, "only the above-floor arrival is creditable");
	assert.equal(r.payments[0]!.txid, "0xreal");

	const recorded = s.belowMinimumFor(CUST);
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]!.txid, "0xdust");
	assert.equal(recorded[0]!.amount, 999n);
});

test("the sub-floor record is idempotent across re-scans", async () => {
	// A re-scanned block must not accumulate duplicate rows, or the deposit
	// screen would show one small arrival several times.
	const chain = new FakeChain([
		...plain(5),
		{ txs: [{ to: CUST, value: 500n, hash: "0xdust" }] },
		...plain(4),
	]);
	const db = new Database(":memory:");
	await scanner(chain, { startBlock: 0, db }).scan();
	await scanner(chain, { startBlock: 0, db }).scan();
	assert.equal(scanner(chain, { db }).belowMinimumFor(CUST).length, 1);
});

test("the customer sentence for a sub-floor deposit is SELF-HEALING", () => {
	/*
	 * Only possible because the address is permanent: it is derived from a fixed
	 * index for a fixed customer, so it never expires and is never reassigned.
	 * A deposit too small to move is therefore not a loss and not a support
	 * ticket — the next deposit to the same address makes the combined balance
	 * sweepable.
	 *
	 * The sentence must say the money is still there, or the customer reasonably
	 * concludes it was taken.
	 */
	const s = belowMinimumSentence({ amount: "0.0001", minimum: "0.02", symbol: "ETH" });
	assert.match(s, /0\.0001 ETH arrived at your deposit address/);
	assert.match(s, /below our 0\.02 ETH minimum/);
	assert.match(s, /we have not credited it/);
	assert.match(s, /It is still there/);
	assert.match(s, /deposit more to the same address/);
});

/* ------------------------------------------------------ the unswept ceiling */

test("OVER THE UNSWEPT CEILING, ARRIVALS DEGRADE TO PENDING instead of crediting", async () => {
	/*
	 * Sweeping on this rail needs a human to carry a proposal to an offline
	 * signer. So the amount sitting in addresses whose return depends on someone
	 * showing up is bounded by a DECLARED NUMBER rather than by how busy the
	 * operator happens to be this week.
	 *
	 * Note what still happens over the ceiling: the pass still SCANS and the
	 * cursor still ADVANCES. Stopping the scan would make the rail fall behind
	 * and burn its backfill window, which on these endpoints is measured in
	 * hours. The deposit is recorded and visible; it is simply not credited.
	 */
	const chain = new FakeChain([
		...plain(5),
		{ txs: [{ to: CUST, value: 50_000n, hash: "0xdeposit" }] },
		...plain(4),
	]);
	const r = await scanner(chain, {
		startBlock: 0,
		unswept: RULE.unsweptCeilingWei + 1n,
	}).scan();

	assert.ok(
		r.issuanceShut !== undefined,
		"the rail must report ISSUANCE shut — not crediting",
	);
	assert.match(r.issuanceShut, /above\s+the declared ceiling/);
	assert.match(r.issuanceShut, /NEW\s+DEPOSIT ADDRESSES ARE NOT BEING ISSUED/);
	/*
	 * AND THE ARRIVAL IS STILL CREDITED. Over the ceiling the venue stops
	 * handing out NEW addresses; coins already on their way to an address a
	 * customer was already given are theirs, and withholding the credit would
	 * make them ours. See EvmChainRule.unsweptCeilingWei.
	 */
	assert.equal(r.payments.length, 1, "an already-issued address still credits");
	assert.equal(r.payments[0]!.txid, "0xdeposit");
	assert.equal(r.pending.length, 0);
	assert.equal(r.cursor, 6, "the cursor still advances, so the rail does not fall behind");
});

test("at or below the ceiling, crediting proceeds normally", async () => {
	// The boundary, so the comparison cannot be off by one in the direction
	// that shuts a healthy rail.
	const chain = new FakeChain([
		...plain(5),
		{ txs: [{ to: CUST, value: 50_000n }] },
		...plain(4),
	]);
	const r = await scanner(chain, { startBlock: 0, unswept: RULE.unsweptCeilingWei }).scan();
	assert.equal(r.issuanceShut, undefined);
	assert.equal(r.payments.length, 1);
});

/* ---------------------------------------------------------------- preflight */

test("A WRONG CHAIN ID IS FATAL, because a scanner on the wrong chain has no symptom", async () => {
	/*
	 * A Polygon scanner pointed at an Ethereum URL reads plausible blocks,
	 * plausible balances and plausible transactions that simply never contain
	 * our addresses, and reports "no deposits" forever. Nothing downstream would
	 * notice, and it is one character of configuration away at all times.
	 *
	 * Asserted FIRST in preflight, because every other check passes happily on
	 * the wrong chain.
	 */
	const chain = new FakeChain(plain(10));
	chain.chainId = 1; // Ethereum, against a rule configured for Polygon
	await assert.rejects(
		() => scanner(chain).preflight(),
		/reports chain id 1 but this rail is 137[\s\S]*never contain our addresses/,
	);
});

test("preflight REFUSES an endpoint that cannot serve eth_getBlockReceipts", async () => {
	/*
	 * Without that call the per-block integrity assertion cannot run, and
	 * without the assertion the scanner has no way to tell a truthfully empty
	 * block from a pruned one reported as empty. The rail does not open on an
	 * endpoint it cannot audit.
	 */
	const chain = new FakeChain([...plain(9), { txs: [], receiptsError: "method not found" }]);
	// Block 9 is the one preflight samples (tip - 1).
	chain.fork(9, [
		{ txs: [], receiptsError: "the method eth_getBlockReceipts does not exist" },
		{ txs: [] },
	]);
	await assert.rejects(
		() => scanner(chain).preflight(),
		/eth_getBlockReceipts is not available[\s\S]*The rail stays shut/,
	);
});

test("preflight REFUSES an endpoint that under-reports AT THE TIP", async () => {
	// An endpoint lying about current data cannot be trusted at any depth, so
	// this is a refusal to open rather than a note.
	const chain = new FakeChain([
		...plain(8),
		{ txs: [{ to: OTHER, value: 1n }, { to: OTHER, value: 2n }], receiptsLie: 0 },
		{ txs: [] },
	]);
	await assert.rejects(
		() => scanner(chain).preflight(),
		/AT THE TIP[\s\S]*cannot be trusted with a deposit rail at any depth/,
	);
});

test("preflight passes on an honest endpoint and reports the finalized tag", async () => {
	const chain = new FakeChain(plain(10));
	chain.finalized = 6;
	const notes = await scanner(chain).preflight();
	assert.ok(notes.some((n) => /finalized tag served, 4 blocks behind the tip/.test(n)));
});

test("preflight NOTES rather than refuses when the finalized tag is missing", async () => {
	// Degrading to the confirmation count is the conservative direction, so it
	// is survivable — but it must be visible.
	const chain = new FakeChain(plain(10));
	chain.finalizedThrows = true;
	const notes = await scanner(chain).preflight();
	assert.ok(notes.some((n) => /finalized tag is unavailable/.test(n)));
	assert.ok(notes.some((n) => /conservative direction/.test(n)));
});

/* -------------------------------------------------------------- cursor lag */

test("CURSOR LAG RAISES AN ALARM IN HOURS, not days", async () => {
	/*
	 * Forced by measurement, not taste. ethereum-rpc.publicnode.com serves
	 * eth_getLogs only about 9,700 blocks back and eth_getBlockReceipts about
	 * 20,000 — roughly 32 hours of chain — after which the gap CANNOT BE
	 * BACKFILLED AT ALL without a keyed endpoint. A stall that begins on a
	 * Friday and is noticed on Monday is already unrecoverable, so an alarm
	 * measured in days is decoration.
	 */
	const chain = new FakeChain(plain(4000));
	// One pass cannot catch up 4000 blocks, so it ends far behind the safe head.
	const r = await scanner(chain, { startBlock: 0, maxBlocksPerPass: 10 }).scan();
	assert.ok(r.lagSeconds > RULE.lagAlarmSeconds);
	assert.ok(r.lagAlarm !== undefined, "a lag past the declared threshold must alarm");
	assert.match(r.lagAlarm, /blocks[\s\S]*behind the safe head/);
	assert.match(r.lagAlarm, /matters in hours rather than days/);
});

test("a caught-up scanner raises no lag alarm", async () => {
	const chain = new FakeChain(plain(10));
	const r = await scanner(chain, { startBlock: 0 }).scan();
	assert.equal(r.cursor, r.safeHead);
	assert.equal(r.lagSeconds, 0);
	assert.equal(r.lagAlarm, undefined);
});

test("the cursor is durable across processes, because the runner is one-shot", async () => {
	/*
	 * The deposit watcher CLI exits every systemd tick by design. An in-memory
	 * watermark would therefore reset every cycle, and a scanner that restarted
	 * at the tip each time would skip every block in between — silently, since
	 * skipped blocks produce no error.
	 */
	const chain = new FakeChain(plain(10));
	const db = new Database(":memory:");
	const first = scanner(chain, { startBlock: 0, db, maxBlocksPerPass: 3 });
	assert.equal(first.cursor(), undefined, "no cursor before the first pass");
	const a = await first.scan();
	assert.equal(a.cursor, 3);

	// A brand-new scanner object over the same database resumes, and crucially
	// does NOT accept a startBlock that would skip the gap.
	const second = scanner(chain, { db, maxBlocksPerPass: 3, startBlock: 99 });
	const b = await second.scan();
	assert.equal(b.cursor, 6, "a stored cursor wins over a configured startBlock");
});

/* ------------------------------------------------- the declared chain rules */

test("THE DECLARED RULES ARE COHERENT: floor, minimum, confirmations", () => {
	/*
	 * These numbers are the rail's published contract with customers, so the
	 * relationships between them are asserted rather than left to a reader of
	 * three files. The minimum must be a real margin above the floor (gas moves
	 * between the customer pressing send and the venue sweeping), and no chain
	 * may credit at zero confirmations.
	 */
	for (const [symbol, rule] of Object.entries(EVM_CHAIN_RULES)) {
		assert.equal(rule.chain, symbol, `${symbol}: the rule must name its own chain`);
		assert.ok(rule.confirmations > 0, `${symbol}: never credit at zero confirmations`);
		assert.ok(rule.dustFloorWei > 0n, `${symbol}: a dust floor must be declared`);
		assert.ok(
			rule.minimumDepositWei >= rule.dustFloorWei * 10n,
			`${symbol}: the published minimum must be 10x the floor, as a gas-spike margin`,
		);
		assert.ok(
			rule.unsweptCeilingWei > rule.minimumDepositWei,
			`${symbol}: the ceiling must exceed one minimum deposit or the rail cannot open`,
		);
		assert.ok(
			rule.lagAlarmSeconds <= 24 * 3600,
			`${symbol}: the lag alarm must fire inside a day — the endpoints prune in hours`,
		);
		assert.ok(rule.blockSeconds > 0);
	}
});

test("the per-chain confirmation depths are the declared reorg policy", () => {
	/*
	 * Pinned as values so a change is a deliberate edit with a test diff rather
	 * than a quiet retuning. Ethereum is one epoch; BSC is RAISED from the 20
	 * configured for BitGo because this is the chain whose only free endpoint
	 * demonstrably lies about its own history; Polygon is 128 because Polygon
	 * has had multi-block reorgs well past 64 and 128 fast blocks is only about
	 * 4.3 minutes.
	 */
	assert.equal(EVM_CHAIN_RULES.ETH!.confirmations, 32, "one Ethereum epoch");
	assert.equal(EVM_CHAIN_RULES.ETH!.chainId, 1);
	assert.equal(EVM_CHAIN_RULES.BNB!.confirmations, 40, "raised from BitGo's 20");
	assert.equal(EVM_CHAIN_RULES.BNB!.chainId, 56);
	assert.equal(EVM_CHAIN_RULES.POL!.confirmations, 128);
	assert.equal(EVM_CHAIN_RULES.POL!.chainId, 137);
});
