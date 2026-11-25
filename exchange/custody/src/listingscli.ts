#!/usr/bin/env node
// -----------------------------------------------------------------------------
// LISTING STATUS — what each coin needs before it can trade.
//
//     node dist/src/listingscli.js            every coin, one line each
//     node dist/src/listingscli.js --coin RTM  one coin, in full
//
// THIS IS THE ONLY HONEST ANSWER TO "IS RTM READY YET".
//
// The registry records an intention. This asks the node. A coin shows as ready
// only when a daemon answered, said it was synced, offered an address, and the
// venue's own configuration agrees about decimals and markets — which is the
// list in `canGoLive`, applied to a live probe rather than to hope.
//
// It does not promote anything. Promotion edits the registry and regenerates
// the pages, and that is a commit someone makes on purpose after reading this.
// A tool that flipped a coin to "live" on the strength of one probe would be
// a tool that opened deposits at 3am because a node happened to answer.
// -----------------------------------------------------------------------------

import { ASSETS } from "./assets";
import { type ChainCapabilities } from "./chains";
import { nodeAdapters } from "./custodyrouting";
import { LISTED, canGoLive, coinBySymbol, marketsFor, type ListedCoin } from "./listed";
import { MARKETS } from "./venue";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

const UNREACHABLE: ChainCapabilities = {
	reachable: false,
	synced: false,
	height: undefined,
	decimals: undefined,
	canDeriveAddresses: false,
	canSend: false,
	notes: ["no node is configured for this coin"],
};

/*
 * ONE ADAPTER BUILDER, SHARED WITH THE SERVICES.
 *
 * This used to call `adapterFromEnv` directly, which was a second path that
 * did not know about the coins with bespoke adapters — so it reported "the
 * node does not answer" about a BLOCK node that answers perfectly well. An
 * operator readiness tool that is wrong about readiness is worse than no tool.
 * `nodeAdapters` is what the reconciler and the payout runner use, so what
 * this reports is what they will actually do.
 */
const built = new Map<string, ReturnType<typeof nodeAdapters> extends Map<string, infer A>
	? A
	: never>();
const skipped = new Map<string, string>();

function buildAll(): void {
	for (const [symbol, adapter] of nodeAdapters({
		env: process.env,
		onSkip: (symbol, why) => skipped.set(symbol, why),
	})) {
		built.set(symbol, adapter);
	}
}

async function probe(coin: ListedCoin): Promise<ChainCapabilities> {
	const adapter = built.get(coin.symbol);
	if (adapter === undefined) {
		const why = skipped.get(coin.symbol) ?? "no node is configured for this coin";
		return { ...UNREACHABLE, notes: [why] };
	}
	try {
		return await adapter.probe();
	} catch (e) {
		return { ...UNREACHABLE, notes: [e instanceof Error ? e.message : String(e)] };
	}
}

function marketDefined(coin: ListedCoin): boolean {
	// The venue's market table, not the registry's intention.
	return MARKETS.some((m) => m.base === coin.symbol || m.quote === coin.symbol);
}

async function one(
	coin: ListedCoin,
	verbose: boolean,
): Promise<{ promotable: boolean; degraded: boolean }> {
	const cap = await probe(coin);
	const blockers = canGoLive(coin, {
		reachable: cap.reachable,
		synced: cap.synced,
		decimals: cap.decimals,
		canDeriveAddresses: cap.canDeriveAddresses,
		canSend: cap.canSend,
		marketDefined: marketDefined(coin),
		ledgerKnowsAsset: ASSETS[coin.symbol] !== undefined,
	});
	/*
	 * "ALREADY LIVE" IS NOT A FAULT, AND MUST NOT BE DISPLAYED AS ONE.
	 *
	 * canGoLive answers "may this be promoted", so for a coin that already IS
	 * live it correctly returns the single reason "it is already marked live".
	 * Rendered naively that printed `LIVE PEP … 1 blocker`, which reads as a
	 * healthy coin with something wrong with it — and a status tool that cries
	 * wolf on its happy path is a status tool people stop reading.
	 *
	 * So the tautology is separated from the real blockers. A live coin shows
	 * none, and the summary counts only coins that are genuinely promotable.
	 */
	const realBlockers = blockers.filter((b) => !/already marked live/.test(b));
	const promotable = blockers.length === 0;
	const healthy = realBlockers.length === 0;
	const mark = coin.status === "live" ? (healthy ? "LIVE" : "DEGRADED") : promotable ? "READY" : "    ";
	console.log(
		`  ${mark.padEnd(9)}${coin.symbol.padEnd(8)}${coin.custody.padEnd(13)}` +
			`${coin.status.padEnd(13)}${healthy ? "" : `${realBlockers.length} blocker` +
				`${realBlockers.length === 1 ? "" : "s"}`}`,
	);
	if (verbose || (!healthy && process.argv.includes("--why"))) {
		for (const b of realBlockers) console.log(`           - ${b}`);
		for (const n of cap.notes) console.log(`           note: ${n}`);
		if (cap.height !== undefined) console.log(`           height: ${cap.height}`);
		if (coin.status === "live") {
			console.log(`           markets: ${marketsFor(coin).join(", ") || "none"}`);
		}
	}
	return { promotable, degraded: coin.status === "live" && !healthy };
}

async function main(): Promise<void> {
	const only = arg("coin");
	const coins = only === undefined
		? LISTED
		: [coinBySymbol(only)].filter((c): c is ListedCoin => c !== undefined);
	if (coins.length === 0) {
		console.error(`unknown coin ${only}. Known: ${LISTED.map((c) => c.symbol).join(" ")}`);
		process.exit(64);
	}

	buildAll();
	console.log("Listing readiness — the registry's claim, checked against the node.\n");
	console.log("  STATE    SYMBOL  CUSTODY      REGISTRY     BLOCKERS");
	let ready = 0;
	let degraded = 0;
	let live = 0;
	for (const c of coins) {
		const r = await one(c, only !== undefined);
		if (r.promotable) ready += 1;
		if (r.degraded) degraded += 1;
		if (c.status === "live") live += 1;
	}
	console.log(
		`\n${live} live, ${ready} ready to promote, ${coins.length - live - ready} not ready.`,
	);
	if (degraded > 0) {
		// LOUD, because this is the only line here that means something is wrong
		// RIGHT NOW with a coin customers can already deposit.
		console.log(
			`\n  ** ${degraded} LIVE coin(s) DEGRADED — a chain customers can deposit to is\n` +
				"     failing a check it passed at promotion. Run --why for which, and\n" +
				"     expect deposits or withdrawals on it to be refusing.",
		);
	}
	console.log("Use --why for reasons, or --coin <SYMBOL> for one in full.");
	console.log(
		"Promotion is a registry edit plus a page regeneration, done deliberately — " +
			"this command does not do it.",
	);
}

void main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
