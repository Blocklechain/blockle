// -----------------------------------------------------------------------------
// Listing an asset means editing FOUR tables, in three files. Nothing tied them
// together, so a coin could be half-added and every existing test would pass.
//
// The failure is not hypothetical and it is not symmetric:
//   - in MIN_BASE but not ASSETS   -> the market exists and the ledger cannot
//                                     account for the asset it trades
//   - in ASSETS but not MIN_BASE   -> listed, custodied, undepositable: no
//                                     market is generated, so it is dead weight
//   - in MIN_BASE but not LIVE_FEES-> a withdrawal throws "<X> is not priced"
//                                     AFTER the customer has the balance
//   - decimals absent              -> adapterFromEnv refuses to build, and the
//                                     asset is silently unavailable
//
// So these are invariants over the real tables rather than examples. They do not
// care which assets exist, only that each one is wired everywhere or nowhere —
// which means they keep working for the next coin without being edited.
// -----------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSETS, custodyIds, settlementAsset } from "../src/assets";
import { QUOTE_SENIORITY, settleable } from "../src/settlement";
import { MARKETS, NOT_LISTED, PENDING_SETTLEMENT, type Market } from "../src/venue";
import { LIVE_FEES } from "../src/withdrawalfees";

/** Every settlement asset that actually appears in a generated market. */
function tradedAssets(): string[] {
	const seen = new Set<string>();
	for (const m of MARKETS) {
		seen.add(settlementAsset(m.base));
		seen.add(settlementAsset(m.quote));
	}
	return [...seen].sort();
}

test("every traded asset is in the registry", () => {
	for (const a of tradedAssets()) {
		assert.ok(
			ASSETS[a] !== undefined,
			`${a} has a market but no entry in ASSETS — the ledger cannot account ` +
				"for it, so the market is unopenable",
		);
	}
});

test("every traded asset has confirmed decimals", () => {
	// adapterFromEnv throws rather than guess a scale, so a missing or
	// nonsensical decimals makes the chain quietly unavailable instead of loud.
	for (const a of tradedAssets()) {
		const d = ASSETS[a]?.decimals;
		assert.equal(typeof d, "number", `${a} has no decimals`);
		assert.ok(
			Number.isInteger(d) && d! >= 0 && d! <= 24,
			`${a} decimals ${String(d)} is not a plausible scale`,
		);
	}
});

test("every traded asset is priced for withdrawal on every one of its chains", () => {
	// Keyed per CHAIN, not per asset: USDT is priced four times because a
	// TRC-20 withdrawal and an ERC-20 withdrawal cost wildly different amounts.
	for (const a of tradedAssets()) {
		for (const id of custodyIds(a)) {
			assert.ok(
				LIVE_FEES[id] !== undefined,
				`${id} has no LIVE_FEES entry — a withdrawal would throw "not priced" ` +
					"only after the customer already holds the balance",
			);
		}
	}
});

test("every withdrawal fee covers more than nothing", () => {
	for (const [chain, cfg] of Object.entries(LIVE_FEES)) {
		assert.ok(cfg.gas > 0n, `${chain} gas must be positive`);
		assert.ok(
			cfg.margin > 0n || cfg.marginBps > 0,
			`${chain} charges no margin at all, so every withdrawal on it is a ` +
				"loss — if that is intended it belongs behind the `subsidised` flag",
		);
	}
});

test("every priced chain belongs to a real asset", () => {
	// The reverse direction: a fee table entry for an asset that was renamed or
	// removed is dead config that reads as coverage.
	for (const chain of Object.keys(LIVE_FEES)) {
		const sym = settlementAsset(chain);
		assert.ok(ASSETS[sym] !== undefined, `LIVE_FEES prices ${chain}, but ${sym} is not an asset`);
		assert.ok(
			custodyIds(sym).includes(chain),
			`LIVE_FEES prices ${chain}, which is not one of ${sym}'s custody ids ` +
				`(${custodyIds(sym).join(", ")})`,
		);
	}
});

/* -------------------------------------------------- no asset is half-listed */

/*
 * WHAT HAPPENED TO "each traded asset has both a USDT and a BLOCK market".
 *
 * That test asserted the old generator's whole purpose, and its INTENT — no
 * asset is listed against some quotes and silently missing against others — is
 * what the four tests below carry. The literal assertion could not survive the
 * quote expansion, and not only because the array grew:
 *
 *   1. IT WAS UNSATISFIABLE FOR A QUOTE ASSET. It read `m.base === a`, so it
 *      asked which quotes an asset trades against as a BASE. Pairs are emitted
 *      once, in one orientation, so BTC's pair with BLOCK is `BTC-BLOCK` and
 *      USDT's pair with USDC is `USDC-USDT` — USDT is a base in nothing at all.
 *      "Does a market for this unordered pair exist" is the question that has
 *      an answer; "which quotes is it a base against" does not.
 *
 *   2. IT WAS ASSERTING THINGS THAT WERE NOT TRUE. As of the probe behind
 *      settlement.ts, ETH, SOL and BNB cannot take a deposit at all, so their
 *      USDT and BLOCK markets were one-way doors — and the test demanded them.
 *      A market that cannot settle is worse than no market, so the new rule has
 *      to be able to say "deliberately absent, here is why", which a deepEqual
 *      against a fixed array cannot express.
 *
 * So the invariant is now: for every pair of settleable assets where one side
 * is a quote, there is either an OPEN market or a published REASON there is
 * not. Absence without a reason is the half-listing, and it fails. That is
 * strictly stronger than the old assertion, because it also covers the pairs
 * the old one never looked at and it refuses silence.
 */

/** Unordered key, so {a,b} and {b,a} collide. */
function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

test("NO ASSET IS HALF-LISTED: every settleable pair is open, or refused in writing", () => {
	const open = new Map<string, Market>();
	const refused = new Map<string, string>();
	for (const m of MARKETS) {
		if (m.closed === undefined) open.set(pairKey(m.base, m.quote), m);
		else refused.set(pairKey(m.base, m.quote), m.closed);
	}
	for (const p of [...NOT_LISTED, ...PENDING_SETTLEMENT]) {
		refused.set(pairKey(p.base, p.quote), p.why);
	}

	const settleableAssets = tradedAssets().filter((a) => settleable(a).ok);
	for (const a of settleableAssets) {
		for (const q of QUOTE_SENIORITY) {
			if (a === q || !settleable(q).ok) continue;
			const key = pairKey(a, q);
			if (open.has(key)) continue;
			const why = refused.get(key);
			assert.ok(
				why !== undefined,
				`${a}/${q} has no open market and no reason — a pair that is absent ` +
					"without a published reason is indistinguishable from a bug",
			);
			assert.ok(
				why!.trim().length > 20,
				`${a}/${q} is refused with "${why!}", which does not explain anything`,
			);
		}
	}
});

test("EVERY UNORDERED PAIR HAS AT MOST ONE SYMBOL", () => {
	// The same book twice with the prices inverted is the worst outcome
	// available: two order books over one pair, each arbitrageable against the
	// other, both real. The old generator avoided it by `Object.keys` order,
	// which a cosmetic alphabetisation of MIN_BASE would have broken.
	const seen = new Map<string, string>();
	for (const m of MARKETS) {
		const key = pairKey(m.base, m.quote);
		const first = seen.get(key);
		assert.equal(
			first,
			undefined,
			`${m.symbol} and ${String(first)} are the same pair in both directions`,
		);
		seen.set(key, m.symbol);
	}
});

test("EVERY PAIR WITH A SYMBOL HAS EXACTLY ONE STATE, and no pair is in two lists", () => {
	// MARKETS, NOT_LISTED and PENDING_SETTLEMENT are three different claims to a
	// customer ("refuses orders", "never will exist", "will appear when a rail
	// opens"). A pair in two of them makes the UI's answer depend on which list
	// it read first.
	const symbols = new Set(MARKETS.map((m) => pairKey(m.base, m.quote)));
	for (const p of [...NOT_LISTED, ...PENDING_SETTLEMENT]) {
		assert.ok(
			!symbols.has(pairKey(p.base, p.quote)),
			`${p.base}/${p.quote} has a market symbol AND is listed as unavailable`,
		);
	}
	const unlisted = new Set(NOT_LISTED.map((p) => pairKey(p.base, p.quote)));
	for (const p of PENDING_SETTLEMENT) {
		assert.ok(
			!unlisted.has(pairKey(p.base, p.quote)),
			`${p.base}/${p.quote} is both "waiting on settlement" and "never listed"`,
		);
	}
});

test("AN OPEN MARKET NEVER HAS AN UNSETTLEABLE LEG", () => {
	// The one-way-door check, stated from the other direction: a book that can
	// be sold into but never funded costs the customer a deposit, where an empty
	// book costs them nothing. BLOCK passes via SETTLEMENT_EXCEPTIONS, which is
	// named and carries its caveat rather than being an absent check.
	for (const m of MARKETS) {
		if (m.closed !== undefined) continue;
		for (const leg of [m.base, m.quote]) {
			const s = settleable(leg);
			assert.ok(s.ok, `${m.symbol} is open but ${leg} cannot settle: ${s.ok ? "" : s.why}`);
		}
	}
});

test("the measured small-PoW coins are listed at 8 decimals", () => {
	// Pinned because each of these was MEASURED off its own daemon's raw block
	// hex (see the comment in assets.ts), and a later "tidy-up" that changes one
	// to a guessed value would misreport customer balances by orders of
	// magnitude with nothing else failing.
	for (const sym of ["PEP", "DINGO", "RTM", "PERBUG", "BLOCK"]) {
		assert.equal(ASSETS[sym]?.decimals, 8, `${sym} was measured at 8 decimals`);
	}
});
