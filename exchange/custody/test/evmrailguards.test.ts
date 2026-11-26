// -----------------------------------------------------------------------------
// EVM RAIL STRUCTURAL GUARDS — the tests that defend an ABSENCE.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE BEHAVIOURAL TESTS.
//
// The security property of this rail is not something it does. It is something
// that is NOT PRESENT: there is no private key, no seed, no mnemonic and no
// xprv anywhere the custody process can reach, so an attacker who fully owns
// the exchange host can read the ledger, read every customer record, read the
// xpub and enumerate every deposit address — and still cannot move one wei.
//
// ABSENCES ROT, AND THEY ROT SILENTLY. Nothing fails when someone adds a
// convenience that reintroduces a key. The suite stays green, the rail keeps
// working, and the property is simply gone. Every other test in this package
// would still pass. So the absence is asserted directly, and these tests are
// deliberately written to fail LOUDLY and to explain what they are protecting,
// because the person who trips one will be mid-way through something that looks
// entirely reasonable.
//
// THE MOST LIKELY WAY THIS DESIGN DIES, NAMED SO IT CAN BE RECOGNISED: someone
// needs an unattended sweep, notices the offline-signer loop costs an operator
// session, and adds "a small hot key, just for sweeps". That hands back the
// entire attack surface to save ten minutes a day. If a design needs a key on
// this box, the design is wrong — not this test.
//
// WHAT THESE TESTS CANNOT DO, STATED HONESTLY: a source scan is a coarse
// instrument. It cannot prove the absence of a key reached through some
// indirection it does not know to look for, and a determined author can defeat
// any of it. It is a tripwire against drift and accident, not a proof.
// -----------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ChainError, EvmRpcAdapter, JsonRpc, adapterFromEnv } from "../src/chains";
import { EvmAddressIndex } from "../src/evmaddressindex";
import { parseXpub } from "../src/evmxpub";

/** Compiled tests live in dist/test, so the sources are two levels up. */
const SRC = join(__dirname, "../../src");

function source(name: string): string {
	return readFileSync(join(SRC, name), "utf8");
}

/**
 * Every custody source, with a NON-VACUITY FLOOR.
 *
 * The floor is the whole point. A source scan that silently finds no files
 * passes every assertion below — the loop body never runs — and the suite stays
 * green while protecting nothing. That is the specific way a test like this
 * dies: someone moves the build output, `__dirname` resolves somewhere else,
 * and the guard becomes decoration without anybody editing it.
 *
 * So the count is asserted. The number is a floor rather than an exact figure
 * because files are added legitimately and pinning the exact count would just
 * train people to bump it.
 */
function everySource(): ReadonlyArray<readonly [string, string]> {
	const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
	assert.ok(
		files.length >= 40,
		`only ${files.length} sources found under ${SRC} — this scan has stopped looking ` +
			"at the code it is supposed to be guarding, so every assertion over it is " +
			"passing vacuously",
	);
	assert.ok(files.includes("chains.ts") && files.includes("withdrawals.ts"));
	return files.map((f) => [f, source(f)] as const);
}

const ANVIL =
	"xpub6DyUKdwoLWmUJ4Tn9Bbsdtx7B5Ws18mEN19e5HT52ikE53FiUheSQXrZUNPovqfyKmw4579A1Mm3GXXKM39N64uooBfJ4tNAzFsEbodRTx4";

type EvmCfg = ConstructorParameters<typeof EvmRpcAdapter>[2];

/**
 * An endpoint that answers the handful of calls `probe()` makes, so the
 * capability assertions below are unconditional.
 *
 * A stub that errored would make `probe()` return the unreachable shape, and
 * every `canSend === false` assertion would then pass for the WRONG REASON —
 * because nothing was reachable, not because the guard holds. A guard test that
 * passes when the subject never ran is worse than no test.
 */
function okRpc(): JsonRpc {
	const answers: Record<string, unknown> = {
		eth_blockNumber: "0x100",
		eth_chainId: "0x1",
		eth_syncing: false,
	};
	const fetchImpl = (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { method: string; id?: unknown };
		return new Response(
			JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answers[body.method] ?? null }),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return new JsonRpc({ url: "http://127.0.0.1:8545", fetchImpl });
}

function evm(cfg: Partial<EvmCfg> = {}): EvmRpcAdapter {
	return new EvmRpcAdapter("ETH", okRpc(), {
		decimals: 18,
		addresses: [],
		...cfg,
	} as EvmCfg);
}

function addressIndex(): EvmAddressIndex {
	return new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
}

/* ------------------------------------------- the send guard, three ways */

test("canSend IS FALSE even with an xpub and a scanner fully wired", async () => {
	/*
	 * THE GUARD MOST LIKELY TO BE "FIXED" BY SOMEONE WHO HAS JUST LEARNED THAT
	 * THIS ADAPTER CAN NOW ISSUE ADDRESSES.
	 *
	 * The reasoning, written out so it does not have to be rediscovered: an
	 * xpub derives public keys. It cannot produce a signature — not with more
	 * compute, not through a flaw in our code, not ever. So there is nothing on
	 * this host for `send` to sign WITH, and the fix is not a flag, it is a key,
	 * and putting a key here is the one thing the whole design exists to avoid.
	 *
	 * Asserted with the address source present, because "it has an xpub now" is
	 * exactly the premise under which someone would flip this.
	 */
	const addresses = addressIndex();
	addresses.take("cust-1");
	const adapter = evm({ depositAddresses: addresses });

	const caps = await adapter.probe();
	assert.equal(caps.reachable, true, "the stub endpoint must be reachable");
	// The capability that is allowed to turn on, and the one that is not.
	assert.equal(caps.canDeriveAddresses, true, "an xpub IS wired, so this is true");
	assert.equal(caps.canSend, false, "and it changes nothing about signing");
	// And the notes must say so, because probe().notes is what an operator
	// actually reads when deciding whether a rail is safe.
	assert.ok(caps.notes.some((n) => /CANNOT send/.test(n)));

	await assert.rejects(
		() => adapter.send({ to: "0x" + "1".repeat(40), amount: 1n, idempotencyKey: "k" }),
		(e: unknown) => {
			assert.ok(e instanceof ChainError);
			assert.match(e.message, /cannot send/);
			assert.match(e.message, /an xpub cannot sign either/);
			return true;
		},
	);
});

test("NO allowSend OR ENV FLAG CAN TURN ON EVM SENDING", () => {
	/*
	 * The bitcoind-family routes have a deliberate `CHAIN_<SYM>_SEND=1` opt-in,
	 * so the obvious assumption is that the EVM route has one too. It does not,
	 * and this test is what keeps that true: setting every plausible flag must
	 * still produce an adapter that refuses.
	 *
	 * The exact string "1" spelling is asserted on the shared config path as
	 * well, because that is what stops a typo ("true", "yes", "TRUE") from
	 * enabling sending on the routes that DO support it.
	 */
	const built = adapterFromEnv({
		symbol: "ETH",
		route: "evm-rpc",
		decimals: 18,
		env: {
			CHAIN_ETH_URL: "http://127.0.0.1:8545",
			CHAIN_ETH_SEND: "1",
			CHAIN_ETH_ADDRESSES: "0x" + "1".repeat(40),
		},
	});
	assert.ok(built !== undefined);
	assert.rejects(
		() => built.send({ to: "0x" + "2".repeat(40), amount: 1n, idempotencyKey: "k" }),
		/cannot send/,
	);

	// The opt-in is spelled as an exact comparison against "1" — not a truthy
	// check, not a case-insensitive parse.
	const chains = source("chains.ts");
	assert.match(
		chains,
		/allowSend:\s*args\.env\[`\$\{pre\}SEND`\]\s*===\s*"1"/,
		"the send opt-in must stay an exact === \"1\" comparison, so a typo cannot enable it",
	);
});

test("the EVM adapter's source contains no signing primitive at all", () => {
	/*
	 * A behavioural test can only prove that `send` refuses TODAY. This asserts
	 * there is nothing present that a future `send` could be implemented WITH,
	 * which is the property that actually matters: the refusal is cheap to
	 * delete, a missing signer is not.
	 */
	const chains = source("chains.ts");
	for (const forbidden of [
		"eth_sendRawTransaction",
		"eth_sign",
		"eth_signTransaction",
		"personal_sign",
		"privateKey",
		"signTransaction",
	]) {
		assert.ok(
			!chains.includes(forbidden),
			`chains.ts must not reference ${forbidden}: this host signs nothing, and the ` +
				"presence of a signing primitive is the first half of a key ending up here",
		);
	}
});

/* -------------------------------------- no key material anywhere in custody */

test("NO CUSTODY SOURCE DERIVES A PRIVATE KEY OR CONSUMES A SEED", () => {
	/*
	 * THE CENTRAL ASSERTION OF THE WHOLE RAIL.
	 *
	 * Scanned across every source file rather than just the EVM ones, because
	 * the rule is about the PROCESS, not about one module: if any file the
	 * custody service compiles can turn a secret into a signature, then the
	 * exchange host holds spending authority and the offline signer is theatre.
	 *
	 * Note what is deliberately NOT forbidden: the word "seed". It appears
	 * legitimately in comments explaining why a seed is NOT here, in the
	 * bootstrap sense ("seed the market"), and in the signer-host procedure
	 * documentation. Forbidding a word that must appear in the explanation of
	 * its own absence would teach the next person to delete the explanation.
	 * What is forbidden is CODE THAT WOULD WORK: a BIP-39 mnemonic converter, a
	 * master-key derivation, a private-key signer.
	 */
	const forbidden: ReadonlyArray<readonly [string, string]> = [
		["mnemonicToSeed", "turning a mnemonic into a seed is key derivation"],
		["masterFromSeed", "deriving a master key means holding spending authority"],
		["deriveHardened", "a hardened child needs the parent PRIVATE key"],
		["createSign", "node's signing API has no business in custody"],
		["secp256k1.sign", "a secp256k1 signature requires a private scalar"],
		["generateKeyPairSync", "custody must never mint key material"],
	];
	for (const [file, text] of everySource()) {
		for (const [needle, why] of forbidden) {
			assert.ok(
				!text.includes(needle),
				`src/${file} references ${needle} — ${why}. No custody source may hold or ` +
					"derive spending authority for the EVM or Solana rails; the signer is on " +
					"a host with no inbound network.",
			);
		}
	}
});

test("AN xprv IN CONFIG IS AN INCIDENT: refuse to start, and do not echo it", () => {
	/*
	 * The version-byte check is the one that catches the worst operator error in
	 * the whole design — pasting the extended PRIVATE key where the public one
	 * belongs. By the time the process sees it, the seed has been in a file and
	 * probably in a shell history and a terminal scrollback too, on a box that
	 * faces the internet. So the response is not "strip it and carry on": it is
	 * refuse to start and declare the seed disclosed.
	 *
	 * The scrub half matters just as much and is easier to lose in a refactor:
	 * an error message ends up in a journal, and the standing security audit on
	 * this box already found secrets readable by any local user that way.
	 */
	const xprv =
		"xprv9s21ZrQH143K24Mfq5zL5MhWK9hUhhGbd45hLXo2Pq2oqzMMo63oStZzFGTQQD3dC4H2D5GBj7vWvSQaaBv5cxi9gafk7NF3pnBju6dwKvH";
	assert.throws(
		() => parseXpub(xprv),
		(e: unknown) => {
			const message = (e as Error).message;
			assert.match(message, /REFUSING TO START/);
			assert.match(message, /DISCLOSED/);
			assert.ok(!message.includes(xprv), "the refusal must not echo the private key");
			return true;
		},
	);
});

/* ------------------------------- the withdrawal path reaches no signer */

test("THE WITHDRAWAL PATH CANNOT REACH A SIGNING CREDENTIAL OR A SWEEPER", () => {
	/*
	 * Withdrawals are the venue's legitimate outflow, so the withdrawal code is
	 * where a key would be MOST useful and therefore most likely to be added.
	 * The design instead stops at APPROVED: an unsigned proposal accumulates, a
	 * human carries it to a host with no inbound network, and a signed blob
	 * comes back to be broadcast.
	 *
	 * This asserts the withdrawal and payout modules import nothing that could
	 * sign or sweep. If the offline-signer loop is ever built, it belongs in its
	 * own module with its own guard — not threaded through here, where a
	 * compromised host composing a withdrawal batch would be one step from
	 * composing one to itself.
	 */
	for (const file of ["withdrawals.ts", "payoutrunner.ts"]) {
		const text = source(file);
		for (const needle of [
			"evmxpub",
			"EVM_ACCOUNT_XPUB",
			"privateKey",
			"eth_sendRawTransaction",
			"signTransaction",
		]) {
			assert.ok(
				!text.includes(needle),
				`src/${file} references ${needle}. The withdrawal path must not reach key ` +
					"material or derivation: it stops at APPROVED, and everything beyond that " +
					"happens on a host this one cannot talk to.",
			);
		}
	}
});

/* ------------------------------- the xpub is secret-grade, never logged */

test("THE XPUB IS NEVER LOGGED, PRINTED OR PUT IN AN ERROR", () => {
	/*
	 * The xpub cannot steal anything. What it CAN do is enumerate every customer
	 * deposit address on every EVM chain, retroactively and forever, and link
	 * them to each other — a permanent deanonymisation and targeting list.
	 *
	 * So the obvious debugging line, "log the xpub so the operator can see which
	 * one is loaded", is exactly the one that must not exist. The fingerprint
	 * answers the same question and discloses nothing. This test asserts that
	 * operator-facing output goes through the fingerprint rather than the key:
	 * no source may interpolate the parsed node's `publicKey`/serialized form
	 * into a log or an error.
	 */
	const xpubSrc = source("evmxpub.ts");
	// safeDescribe is the sanctioned accessor and must stay fingerprint-only.
	assert.match(
		xpubSrc,
		/export function safeDescribe[\s\S]*?fingerprint \$\{account\.fingerprint\}/,
		"safeDescribe must report the fingerprint, never the key",
	);

	for (const [file, text] of everySource()) {
		// `serializeXpub` re-emits the key material. It exists for the golden
		// vector comparison; nothing in the live path may call it.
		if (file === "evmxpub.ts") continue;
		assert.ok(
			!text.includes("serializeXpub"),
			`src/${file} calls serializeXpub, which re-emits the key material. The live ` +
				"path must use safeDescribe (a fingerprint) instead — an xpub in a journal " +
				"is a permanent map of every customer's deposit addresses.",
		);
	}
});

test("the issued-address attestation carries no customer identity", () => {
	/*
	 * The attestation is meant to be PUBLISHED — to an off-host monitor, and on
	 * the deposit screen so a customer can verify their own address off our
	 * infrastructure. If it carried the user id alongside the address it would
	 * stop being an integrity artefact and become a disclosure of who banks
	 * here and at which address.
	 */
	const ix = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	ix.take("customer-with-a-recognisable-name");
	const rows = ix.attestation();
	assert.equal(rows.length, 1);
	const serialized = JSON.stringify(rows);
	assert.ok(
		!serialized.includes("customer-with-a-recognisable-name"),
		"the attestation must not name customers",
	);
	assert.deepEqual(Object.keys(rows[0]!).sort(), ["address", "index", "xpubFingerprint"]);
});

/* ------------------------------------------- wiring that must not be silent */

test("THE ADAPTER, NOT THE LOADER, REPORTS WHAT IT HOLDS", async () => {
	/*
	 * THE BUG THIS REPOSITORY HAS ALREADY PAID FOR, IN ITS EVM FORM.
	 *
	 * `blockAdapterFromEnv(env, fetchImpl?, pool?)` was once called with one
	 * argument, so the BLOCK address pool was loaded, logged at startup, and
	 * never reached the adapter. There is no arity error for a missing optional
	 * trailing argument, so it compiled, ran, and silently disabled per-customer
	 * BLOCK deposits. A thousand addresses sat unused while customers were told
	 * the rail was shut. The startup log said "block pool: 999 free of 1000" —
	 * from the API's OWN reference, describing a different object.
	 *
	 * The EVM version of that bug is the MIRROR IMAGE and it loses money instead
	 * of merely annoying people: an xpub wired and the scanner NOT wired looks
	 * fully open — addresses issue, the gas check passes, the deposit screen
	 * works — and answers "no deposits" at HTTP 200 forever.
	 *
	 * Two structural defences are asserted. First, the wiring is a NAMED FIELD
	 * on an options object, so omitting it is a type error rather than silence.
	 * Second, the only thing allowed to claim an address source is loaded is the
	 * object that would issue from it.
	 */
	const chains = source("chains.ts");
	assert.match(
		chains,
		/evm\?:\s*\{/,
		"the EVM wiring must be a named field on an options object, not a trailing argument",
	);

	/*
	 * An adapter with NO source must SAY SO and must report
	 * canDeriveAddresses: false, so an operator who sets a URL and forgets the
	 * xpub gets a correctly shut rail rather than one that looks open. `canGoLive`
	 * reads this capability, so a rail cannot be promoted by a comment.
	 */
	const bare = await evm().probe();
	assert.equal(bare.canDeriveAddresses, false);
	assert.ok(
		bare.notes.some((n) => /no deposit-address source is configured/.test(n)),
		`a bare adapter must name the missing xpub, got ${JSON.stringify(bare.notes)}`,
	);
	assert.ok(
		bare.notes.some((n) => /no deposit scanner is configured/.test(n)),
		"and the missing scanner, which is a SEPARATE wiring",
	);

	/*
	 * And the two wirings are genuinely independent, which is the whole lesson
	 * of the BLOCK bug: an xpub present with a scanner absent must still report
	 * the scanner absent, because that combination is the money-losing one.
	 */
	const halfWired = await evm({ depositAddresses: addressIndex() }).probe();
	assert.equal(halfWired.canDeriveAddresses, true);
	assert.ok(
		halfWired.notes.some((n) => /no deposit scanner is configured/.test(n)),
		"an xpub must not mask a missing scanner",
	);
});

test("AN ERC-20 RAIL WITH PER-CUSTOMER ADDRESSES IS REFUSED AT CONSTRUCTION", () => {
	/*
	 * TOKEN SUPPORT IS DEFERRED, NOT HALF-SHIPPED, AND THIS IS WHAT MAKES THAT
	 * TRUE IN CODE RATHER THAN IN A COMMENT.
	 *
	 * Issuing per-customer addresses for a token is the same derivation, so the
	 * combination is one config line away and would look like it worked:
	 * addresses would issue and the deposit screen would render. But DETECTING a
	 * token deposit is a different problem — Transfer-event scanning, with
	 * log-index idempotency and a log backfill window that, measured, none of
	 * the free endpoints has (Ethereum prunes logs at ~32 hours failing loudly,
	 * BSC at ~59 hours failing SILENTLY with HTTP 200 and an empty array).
	 *
	 * And separately, the deposit watcher resolves a node feed by SETTLEMENT
	 * asset inside a loop over all four of USDT's custody ids, so one token
	 * adapter would be polled four times and the custody posting would land
	 * under whichever network ran first — a Polygon USDC deposit booked as
	 * USDC.ERC20 inventory.
	 *
	 * So the combination is refused where it is cheapest to refuse: at
	 * construction, with the reason attached.
	 */
	const addresses = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	assert.throws(
		() =>
			new EvmRpcAdapter(
				"USDT",
				new JsonRpc({ url: "http://127.0.0.1:8545" }),
				{
					decimals: 6,
					addresses: [],
					token: "0x" + "a".repeat(40),
					depositAddresses: addresses,
				} as EvmCfg,
			),
		(e: unknown) => {
			assert.ok(e instanceof ChainError);
			assert.match(e.message, /NATIVE coin\s+only/);
			assert.match(e.message, /Refusing to half-ship it/);
			return true;
		},
	);
});

test("incoming() REFUSES rather than returning [] when no scanner is wired", async () => {
	/*
	 * An empty array is the single most dangerous value this method could
	 * return: the deposit watcher would report "no deposits" for a chain nobody
	 * is watching, which is the one failure mode that looks exactly like
	 * everything being fine.
	 *
	 * Still true of a rail that HAS an xpub, which is the point — issuing
	 * addresses and watching them are separate wirings, and the combination
	 * "addresses yes, scanner no" must be loud.
	 */
	const addresses = new EvmAddressIndex(new Database(":memory:"), parseXpub(ANVIL));
	const adapter = evm({ depositAddresses: addresses });
	await assert.rejects(
		() => adapter.incoming(),
		/Refusing to return an empty list, which would look like\s+'no deposits' rather than 'not watching'/,
	);
});

test("balance() REFUSES rather than returning zero when nothing is configured", async () => {
	// Zero reads as an empty treasury, which is indistinguishable from "the
	// coins are gone" — and a custody figure of zero against real liabilities
	// is a shortfall, which halts the asset for every customer holding it.
	await assert.rejects(() => evm().balance(), /Refusing to return zero/);
});

test("THE HEARTBEAT IS WRITTEN LAST, so a half-finished pass cannot look healthy", () => {
	/*
	 * The go-live preflight reads heartbeat rows rather than systemd state,
	 * precisely so a process that is running but not working is visible. That
	 * only holds if the beat is the LAST thing a complete pass does: a runner
	 * that beats on entry reports itself healthy while failing every cycle, and
	 * the alarm that was supposed to catch a stalled deposit scan never fires.
	 *
	 * Asserted structurally because it is an ordering property, and ordering is
	 * what gets lost when someone adds an early return.
	 */
	const watcher = source("depositwatcher.ts");
	const beatAt = watcher.lastIndexOf("beat(");
	assert.ok(beatAt > 0, "the deposit watcher must write a heartbeat");
	// Nothing that reads a feed or posts to the ledger may follow the beat.
	const after = watcher.slice(beatAt);
	for (const needle of ["nodeFeeds", "incomingTransfers", "ledger.post"]) {
		assert.ok(
			!after.includes(needle),
			`src/depositwatcher.ts does ${needle} AFTER writing its heartbeat. The beat ` +
				"must be last, or a pass that dies midway reports itself healthy and the " +
				"go-live preflight's staleness check is defeated.",
		);
	}
});
