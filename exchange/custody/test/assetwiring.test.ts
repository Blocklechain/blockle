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
import { MARKETS } from "../src/venue";
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

test("each traded asset has both a USDT and a BLOCK market", () => {
	// The generator's whole purpose. Asserted because the symptom of it
	// regressing — one missing pair — is the kind nobody notices.
	for (const a of tradedAssets()) {
		const pairs = MARKETS.filter((m) => m.base === a).map((m) => m.quote);
		if (a === "USDT" || a === "BLOCK") continue; // quotes themselves
		assert.deepEqual(
			[...pairs].sort(),
			["BLOCK", "USDT"],
			`${a} should trade against both quotes, got ${pairs.join(",") || "none"}`,
		);
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
