// -----------------------------------------------------------------------------
// THE SHUT-RAIL RECORD, AND THE INVARIANTS THAT KEEP IT HONEST.
//
// `settlement.ts` is the only place this venue writes down WHY a customer gets
// no deposit address. Two customers asked three times, so the answer is now
// code (RAIL_BLOCKERS), a customer sentence (RAIL_REFUSALS), a measured funding
// figure (SOL_ACTIVATION) and a runbook (ops/bitgo-deposit-rails.md). Four
// artefacts that must agree, which is four chances to drift.
//
// These are structural assertions, not behavioural ones — `deposits.test.ts`
// already covers the routing. What is tested here is the thing that actually
// went wrong: the record describing reality, and the record describing itself.
// -----------------------------------------------------------------------------

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	PROVEN_RAILS,
	RAIL_BLOCKERS,
	RAIL_REFUSALS,
	SOL_ACTIVATION,
	blockedRails,
	railBlocker,
} from "../src/settlement";

/*
 * THE PACKAGE ROOT, FOUND RATHER THAN ASSUMED.
 *
 * `npm test` builds to dist/ and runs `node --test dist/test/`, so __dirname is
 * `dist/test` under the suite and `test` when a single file is run with tsx.
 * A relative `../src` therefore resolves to two different places and these
 * tests passed standalone while failing in the suite. Walking up to the
 * directory that owns package.json is true under both.
 */
function pkgRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 6; i += 1) {
		if (existsSync(join(dir, "package.json"))) return dir;
		dir = join(dir, "..");
	}
	throw new Error(`could not find the package root above ${__dirname}`);
}

const ROOT = pkgRoot();
const SRC = join(ROOT, "src");
const OPS = join(ROOT, "ops");

/*
 * THIS IS THE ONE THAT CAUGHT A REAL DEFECT.
 *
 * `bitgodeposits.ts` told the operator to "run ops/activate-sol-wallet.sh" and
 * `settlement.ts` cited "ops/bitgo-deposit-rails.md" — in an error message a
 * human reads at the exact moment deposits are broken — and NEITHER FILE
 * EXISTED. A runbook reference that goes nowhere is worse than none: it costs
 * the reader their remaining trust in the message, while they go looking.
 *
 * So every ops path mentioned anywhere in src/ must resolve. Cheap, total, and
 * it fails the moment someone renames a runbook.
 */
test("every ops/ file referenced from src/ actually exists", () => {
	const cited = new Map<string, string[]>();

	for (const name of readdirSync(SRC)) {
		if (!name.endsWith(".ts")) continue;
		const text = readFileSync(join(SRC, name), "utf8");
		// ops/<file>.<ext> — the form every call site and comment uses.
		for (const m of text.matchAll(/ops\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g)) {
			const file = m[1] as string;
			cited.set(file, [...(cited.get(file) ?? []), name]);
		}
	}

	assert.ok(
		cited.size > 0,
		"found no ops/ references in src/ at all — the regex has rotted, and " +
			"this test would now pass by testing nothing",
	);

	const missing = [...cited.entries()]
		.filter(([file]) => !existsSync(join(OPS, file)))
		.map(([file, where]) => `ops/${file} (cited by ${where.join(", ")})`);

	assert.deepEqual(
		missing,
		[],
		"src/ points an operator at runbooks that do not exist:\n  " +
			missing.join("\n  "),
	);
});

test("the SOL activation runbook and script are executable artefacts", () => {
	const doc = join(OPS, "bitgo-deposit-rails.md");
	const sh = join(OPS, "activate-sol-wallet.sh");
	const js = join(OPS, "activate-sol-wallet.js");

	for (const p of [doc, sh, js]) {
		assert.ok(existsSync(p), `${p} is missing`);
	}

	// The wrapper is the entry point, so it has to be runnable.
	// eslint-disable-next-line no-bitwise
	assert.ok(
		(statSync(sh).mode & 0o111) !== 0,
		"ops/activate-sol-wallet.sh is not executable, and the error message " +
			"tells the operator to run it",
	);

	/*
	 * THE FIGURES MUST MATCH THE CODE, NOT BE RETYPED NEAR IT.
	 *
	 * The runbook, the shell script and SOL_ACTIVATION all name the same
	 * destination address and the same amount. An operator sends money on the
	 * strength of that agreement, and a stale copy in a markdown file is how
	 * funds go to an address nobody owns. (The script re-reads the address from
	 * live BitGo and aborts on a mismatch, which is the real safeguard; this
	 * keeps the documents from disagreeing in the first place.)
	 */
	for (const [label, p] of [["runbook", doc], ["script", js]] as const) {
		const text = readFileSync(p, "utf8");
		assert.ok(
			text.includes(SOL_ACTIVATION.rootAddress),
			`the ${label} does not name SOL_ACTIVATION.rootAddress — one of them ` +
				"is stale, and the operator cannot tell which",
		);
		assert.ok(
			text.includes(String(SOL_ACTIVATION.recommendedLamports)),
			`the ${label} does not name the recommended ${SOL_ACTIVATION.recommendedLamports} ` +
				"lamports",
		);
	}
});

test("the recommended SOL funding clears BitGo's unspendable reserve", () => {
	/*
	 * NOT A TAUTOLOGY — IT IS THE BUG THE OLD MESSAGE HAD. BitGo's
	 * `minimumFunding` must STAY on the wallet and cannot be spent, so sending
	 * exactly the minimum activates a wallet with no fee headroom. "Send a
	 * small amount" was the previous wording and it is not an amount.
	 */
	assert.ok(
		SOL_ACTIVATION.recommendedLamports > SOL_ACTIVATION.minimumFundingLamports,
		"the recommended send must exceed the unspendable reserve, or the wallet " +
			"activates with nothing to pay a fee with",
	);

	// Base58: no 0, O, I or l. A typo'd destination is unrecoverable, so the
	// shape is asserted even though the script also checks it against BitGo.
	assert.match(SOL_ACTIVATION.rootAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
	assert.match(SOL_ACTIVATION.walletId, /^[0-9a-f]{32}$/);
});

test("every blocked rail has at least one cause, with an owner and a remedy", () => {
	assert.ok(Object.keys(RAIL_BLOCKERS).length > 0);

	for (const [key, b] of Object.entries(RAIL_BLOCKERS)) {
		assert.equal(b.rail, key, `RAIL_BLOCKERS["${key}"].rail is "${b.rail}"`);

		/*
		 * A RAIL IS SHUT WHILE `causes` IS NON-EMPTY, so an entry with no cause
		 * is a rail that is recorded as blocked while claiming nothing blocks
		 * it. Emptying the list is how a rail gets REOPENED, and that must be a
		 * deliberate edit (delete the entry) rather than an accident.
		 */
		assert.ok(
			b.causes.length > 0,
			`${key} has no causes. If it is open, remove the entry; an entry with ` +
				"an empty cause list is a rail nobody can explain",
		);

		for (const c of b.causes) {
			assert.ok(
				["commercial", "operator", "engineering"].includes(c.owner),
				`${key}: unknown owner "${c.owner}"`,
			);
			assert.ok(c.evidence.length > 40, `${key}: evidence is too thin to act on`);
			assert.ok(c.remedy.length > 20, `${key}: remedy is not a step`);
			// Dated, because "we measured this once" rots. ISO, so it sorts.
			assert.match(c.observedAt, /^\d{4}-\d{2}-\d{2}$/, `${key}: observedAt`);
		}
	}
});

test("SOL keeps BOTH causes, so funding alone cannot open the rail", () => {
	/*
	 * THE LOAD-BEARING ASSERTION IN THIS FILE.
	 *
	 * SOL is shut for two independent reasons that clear at different times by
	 * different people: the wallet is not activated on chain (~$2, operator),
	 * and there is no code to consolidate per-account deposits back out
	 * (~1 week, engineering). Funding the wallet makes BitGo mint addresses and
	 * the gas gate already passes, because SOL pays its own gas — so if someone
	 * deletes the SOL entry the day the funding lands, the venue starts taking
	 * Solana deposits it has no code to send back. A one-way door.
	 *
	 * This test is the tripwire on that specific mistake.
	 */
	const sol = RAIL_BLOCKERS.SOL;
	assert.ok(sol !== undefined, "SOL is no longer recorded as blocked");

	const owners = new Set(sol.causes.map((c) => c.owner));
	assert.ok(
		owners.has("operator"),
		"the SOL activation payment (operator) is no longer recorded",
	);
	assert.ok(
		owners.has("engineering"),
		"SOL'S SECOND BLOCKER IS GONE. Solana credits each receive address's own " +
			"account, and `grep -n consolidat src/` still has to find a call site " +
			"before this rail can open. If consolidation now exists, delete this " +
			"assertion deliberately and say so in the commit; if it does not, this " +
			"is a one-way door and the rail must stay shut.",
	);
});

test("ETH and BNB are recorded as commercial, because no code unblocks them", () => {
	for (const rail of ["ETH", "BNB"] as const) {
		const b = RAIL_BLOCKERS[rail];
		assert.ok(b !== undefined, `${rail} is no longer recorded as blocked`);
		assert.deepEqual(
			[...new Set(b.causes.map((c) => c.owner))],
			["commercial"],
			`${rail} must be owned purely by the commercial decision. An ` +
				"engineering cause here would send someone to write code for a " +
				"403 that says \"a pricing plan is required\".",
		);
	}
});

test("a blocked rail is never also recorded as proven", () => {
	/*
	 * The two tables answer opposite questions and are maintained by hand.
	 * A rail in both is a contradiction that would resolve differently
	 * depending on which one a caller happened to consult.
	 */
	const both = Object.keys(RAIL_BLOCKERS).filter((r) => r in PROVEN_RAILS);
	assert.deepEqual(
		both,
		[],
		`recorded as both blocked and proven: ${both.join(", ")}`,
	);
});

test("the customer sentence never invites a retry or leaks the evidence", () => {
	for (const [rail, text] of Object.entries(RAIL_REFUSALS)) {
		assert.ok(text.length > 60, `${rail}: too terse to explain anything`);

		/*
		 * NO WALLET IDS, NO HTTP STATUSES, NO ENDPOINT PATHS. The operator's
		 * evidence is deliberately a separate field from the customer's
		 * sentence, because this string is printed in the web UI and the app.
		 * A customer does not need our custody wallet ids to understand that a
		 * chain is shut, and publishing them is free reconnaissance.
		 */
		for (const leak of [/\b[0-9a-f]{32}\b/, /\b40[13]\b/, /\/api\/v2\//, /\bwallet [0-9a-f]/i]) {
			assert.ok(
				!leak.test(text),
				`${rail}: the customer sentence leaks operator detail (${leak}): ${text}`,
			);
		}

		/*
		 * AND IT MUST NOT IMPLY A DEFECT THE CUSTOMER CAN RETRY AWAY. "Try
		 * again later" on a rail blocked by a pricing plan is a lie with a
		 * refresh button, and it is what sends someone back a third time.
		 */
		for (const bad of [/try again/i, /refresh/i, /temporar/i, /please retry/i]) {
			assert.ok(
				!bad.test(text),
				`${rail}: the customer sentence hints at a retry: ${text}`,
			);
		}
	}

	// Derived, not a parallel table — every blocker contributes exactly one.
	assert.deepEqual(
		Object.keys(RAIL_REFUSALS).sort(),
		Object.keys(RAIL_BLOCKERS).sort(),
	);
});

test("railBlocker resolves tokens to their chain, and never throws", () => {
	// A token inherits its chain's blocker: a USDT.ERC20 deposit address IS an
	// Ethereum address, so Ethereum's 403 shuts it.
	assert.equal(railBlocker("USDT", "ERC20")?.rail, "ETH");
	assert.equal(railBlocker("USDC", "ERC20")?.rail, "ETH");
	assert.equal(railBlocker("USDT", "BEP20")?.rail, "BNB");
	assert.equal(railBlocker("ETH")?.rail, "ETH");

	// TRC-20 is admitted: the TRX wallet demonstrably derives addresses.
	assert.equal(railBlocker("USDT", "TRC20"), undefined);

	// UNKNOWN IS NOT BLOCKED. A rail with no entry returns undefined and the
	// caller goes on to ask the custodian, so silence never shuts a live chain.
	assert.equal(railBlocker("BTC"), undefined);
	assert.equal(railBlocker("DOGE"), undefined);

	/*
	 * TOTAL ON PURPOSE. This is called with raw query parameters on the deposit
	 * route, and `gasAssetFor`/`assetDef` throw on nonsense. A throw here would
	 * turn a cosmetic lookup into a 500 on the one screen the customer is
	 * already struggling with.
	 */
	for (const junk of ["", "NOPE", "USDT", "../etc/passwd", "ETH"]) {
		assert.doesNotThrow(() => railBlocker(junk, "NOT_A_NETWORK"));
		assert.doesNotThrow(() => railBlocker(junk));
	}
});

test("blockedRails reports every rail with an outstanding cause", () => {
	const rails = blockedRails().map((b) => b.rail).sort();
	assert.deepEqual(rails, ["BNB", "ETH", "SOL"]);
});
