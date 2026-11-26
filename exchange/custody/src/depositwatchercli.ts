// -----------------------------------------------------------------------------
// `node dist/src/depositwatchercli.js` — the deposit watcher as a service.
//
// Polls once per invocation and exits, driven by a systemd timer rather than an
// internal loop. That is deliberate: a long-lived loop that wedges on a socket
// read keeps reporting "active" to systemd while crediting nothing, which is
// precisely the failure the heartbeat exists to catch. A one-shot that must be
// restarted every cycle cannot pretend to be alive.
//
// EXIT CODES
//   0  the pass completed (possibly with per-chain errors, which are logged)
//   1  the pass could not run at all — no custodian, no database, no scope
//
// It does NOT exit non-zero merely because a chain's feed was unavailable. That
// is a transient the next tick retries, and a timer unit that alerts on it
// teaches an operator to ignore the alert.
// -----------------------------------------------------------------------------

import Database from "better-sqlite3";

import { ASSETS, custodyIds, settlementAsset } from "./assets";
import { BitGoHoldings } from "./bitgo";
import { BitGoDeposits } from "./bitgodeposits";
import { BlockAddressPool } from "./blockaddresspool";
import type { AddressPool } from "./blockchain";
import { nodeAdapters } from "./custodyrouting";
import { runOnce } from "./depositwatcher";
import { pinAndVerify } from "./ipv4";
import { Ledger } from "./ledger";
import { MARKETS } from "./venue";

/** Assets a BitGo wallet is expected for; our own chains are self-custodied. */
/**
 * Assets to poll, and who reports each one's arrivals.
 *
 * `SELF_CUSTODIED` used to be an exclusion list: BLOCK and PERBUG were
 * dropped because BitGo has no feed for them — correct at the time, and it
 * also meant a deposit to either could never be credited. They are included
 * now, routed to the daemon that actually sees them.
 *
 * An asset with no custodian AND no node is still excluded: polling BitGo for
 * a coin it does not hold returns nothing useful on every pass.
 */
function listedAssets(nodeFeeds: ReadonlyMap<string, unknown>): string[] {
	const out = new Set<string>();
	for (const m of MARKETS) {
		out.add(settlementAsset(m.base));
		out.add(settlementAsset(m.quote));
	}
	/*
	 * THE FEED MAP IS KEYED BY CUSTODY ID AND THIS QUESTION IS ABOUT AN ASSET,
	 * so the keys are collapsed rather than looked up directly.
	 *
	 * `nodeFeeds.has(a)` was right while every key was a single-chain native
	 * coin, where the custody id IS the settlement asset. It would silently
	 * stop being right the day a feed is keyed `USDC.POLYGON`: the asset would
	 * fail this test, be treated as having no node, and — if it is also in
	 * SELF_CUSTODIED — be dropped from the poll list entirely. A configured
	 * rail that the watcher never polls is the failure mode this whole file
	 * exists to have fixed once already.
	 */
	const fed = new Set([...nodeFeeds.keys()].map((id) => settlementAsset(id)));
	return [...out].filter(
		(a) => ASSETS[a] !== undefined && (fed.has(a) || !SELF_CUSTODIED.has(a)),
	);
}

const SELF_CUSTODIED = new Set(["BLOCK", "PERBUG"]);

async function main(): Promise<void> {
	// IPv4 FIRST. The token is whitelisted to this host's IPv4 address and the
	// box also has IPv6, so an unpinned request comes back as a 401 that reads
	// exactly like a bad token.
	try {
		await pinAndVerify("app.bitgo.com");
	} catch (e) {
		console.error(
			`IPv4 pin failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	const token = process.env.BITGO_ACCESS_TOKEN ?? "";
	if (token.trim() === "") {
		console.error(
			"BITGO_ACCESS_TOKEN is not set — the watcher cannot read deposits. " +
				"Customer coins would arrive and never be credited, so this is a " +
				"hard failure rather than an idle pass.",
		);
		process.exit(1);
	}
	const env = (process.env.BITGO_ENV ?? "test").trim().toLowerCase();
	if (env !== "test" && env !== "prod") {
		console.error(`BITGO_ENV must be "test" or "prod", got "${env}"`);
		process.exit(1);
	}

	const db = new Database(
		process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db",
	);
	db.pragma("busy_timeout = 10000");
	const ledger = new Ledger(db);

	const client = new BitGoDeposits(token, { env });
	// The holdings adapter owns the wallet scope, so it is what resolves a
	// custody id to the exchange's own pooled wallet. A watcher that picked its
	// own wallet could poll one the exchange does not own — and credit
	// deposits that are not ours.
	const holdings = BitGoHoldings.fromEnv();

	const walletCache = new Map<string, { coin: string; walletId: string } | undefined>();
	const walletFor = async (
		custodyId: string,
	): Promise<{ coin: string; walletId: string } | undefined> => {
		if (walletCache.has(custodyId)) return walletCache.get(custodyId);
		let resolved: { coin: string; walletId: string } | undefined;
		try {
			const coin = holdings.ticker(custodyId);
			const mine = await holdings.exchangeWallets(custodyId);
			// EXACTLY ONE pooled wallet per chain is the model. More than one is
			// not an error — a hot/cold split is legitimate — but deposits are
			// issued against one, so the first by label order is used and the
			// rest are reported so the choice is never silent.
			if (mine.length > 1) {
				console.error(
					`${custodyId}: ${mine.length} exchange wallets in scope ` +
						`(${mine.map((w) => w.label).join(", ")}). Issuing and polling ` +
						`against "${mine[0]!.label}" only.`,
				);
			}
			resolved = mine[0] === undefined
				? undefined
				: { coin, walletId: mine[0].id };
		} catch (e) {
			// Logged once per chain thanks to the cache, rather than every tick.
			console.error(
				`${custodyId}: no exchange wallet (${
					e instanceof Error ? e.message : String(e)
				})`,
			);
			resolved = undefined;
		}
		walletCache.set(custodyId, resolved);
		return resolved;
	};

	/*
	 * THE COINS WE WATCH OURSELVES.
	 *
	 * Read-only adapters: this job credits deposits, so it has no business
	 * being able to spend. `nodeAdapters` builds them from the environment
	 * and skips anything unconfigured.
	 */
	/*
	 * BLOCK'S POOL, READ-ONLY — AND WITHOUT IT THIS JOB IS BLIND.
	 *
	 * BLOCK has no wallet on the node. The adapter learns which addresses are
	 * the venue's by being told: `BLOCK_CUSTODY_ADDRESSES` plus the pool. That
	 * env var is empty (nothing is swept to a fixed address yet), so with no
	 * pool `incoming()` iterated an EMPTY address list and reported, perfectly
	 * calmly, that no BLOCK had arrived. On 2026-11-26 a real 2.1 BLOCK
	 * deposit sat confirmed on-chain, at an address the pool had issued to a
	 * real account, uncredited, while this job logged a clean pass. The same
	 * bug as `nodeAdapters` dropping the pool argument, one process over.
	 *
	 * `take` is deliberately severed. Issuing is the API's job; a credit job
	 * that could also hand out addresses could hand one out and credit it in
	 * the same tick, and the pool's "issued to whom" record is the only thing
	 * that makes a deposit attributable.
	 */
	const pool = new BlockAddressPool(db);
	const readOnlyPool: AddressPool = {
		allAddresses: () => pool.allAddresses(),
		// What deposit scanning actually walks: one explorer request each, so
		// the cost tracks customers rather than pool size.
		issuedAddresses: () => pool.issuedAddresses(),
		status: () => pool.status(),
		take: () => {
			throw new Error(
				"the deposit watcher must not issue addresses: it credits " +
					"deposits, and issuing is the API's job",
			);
		},
	};
	const nodeFeeds = nodeAdapters({
		env: process.env,
		blockPool: readOnlyPool,
		onSkip: (symbol, why) => console.log(`  ${symbol}: not watched (${why})`),
	});
	{
		const s = readOnlyPool.status();
		console.log(
			`  BLOCK deposit-address pool: ${s.issued} issued of ${s.total} ` +
				`(${s.free} free)${s.low ? " — LOW, load more" : ""}`,
		);
	}
	if (nodeFeeds.size > 0) {
		console.log(`  watching our own nodes for: ${[...nodeFeeds.keys()].join(", ")}`);
	}

	const assets = listedAssets(nodeFeeds);
	const r = await runOnce({ db, ledger, client, walletFor, assets, nodeFeeds });

	console.log(
		`deposit-watcher: ${r.scanned} seen, ${r.credited} credited, ` +
			`${r.pending} pending, ${r.unattributed} unattributed, ` +
			`${r.unreadable} unreadable across ${assets.length} assets ` +
			`(${assets.flatMap((a) => custodyIds(a)).length} chains)`,
	);
	for (const e of r.errors) console.error(`  ${e}`);
	if (r.unattributed > 0) {
		console.error(
			`  ${r.unattributed} deposit(s) arrived at addresses we did not issue. ` +
				"They are parked in the unattributed holding so the books still " +
				"balance; resolve them in the admin console.",
		);
	}
	process.exit(0);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
