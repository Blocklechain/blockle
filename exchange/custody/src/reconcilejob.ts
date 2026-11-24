// -----------------------------------------------------------------------------
// THE RECONCILIATION JOB — the thing that makes the interlock real.
//
// reconcile.ts can detect a shortfall and liquidity.ts / withdrawals.ts both
// consult a HaltSource, but until something RUNS the check and WRITES the halt
// file, the interlock is inert decoration. This is that something.
//
// WHICH CUSTODY SOURCE, AND WHY IT MATTERS ENOUGH TO SAY OUT LOUD.
//
// On mainnet the comparison is against BitGo: what we owe versus what the
// custodian confirms it holds. That is the only comparison that proves
// solvency.
//
// On testnet there is no BitGo balance behind a seeded ledger, so comparing
// against BitGo would report a total shortfall for every asset and halt every
// withdrawal — correctly, but uselessly, because the "missing" funds were never
// supposed to exist. The naive fix is to skip reconciliation on testnet, and
// that is the wrong fix: it switches off the check precisely while the code is
// being developed, which is when it would catch the most bugs.
//
// So on testnet the external comparison is made against a DECLARED TESTNET
// TREASURY (a file a human writes), and the report says explicitly which source
// was used. The INTERNAL check — do our own books add up — runs identically in
// both modes, and that is the check that catches posting bugs. What testnet
// cannot prove is solvency, and the report refuses to imply otherwise.
//
// THE HALT FILE IS WRITTEN ATOMICALLY. Write to a temp path, then rename.
// Without that, a reader can see a half-written file, fail to parse it, and
// fall back to NOTHING_HALTED — resuming payouts in the middle of a shortfall
// because a JSON file was briefly truncated.
//
// FAILING TO REACH CUSTODY IS NOT A SHORTFALL. An unreachable custodian means
// "we do not know", which is reported as UNAVAILABLE and deliberately does NOT
// halt: a venue that freezes withdrawals on every transient API error is
// unusable, and the alert is the deliverable.
// -----------------------------------------------------------------------------

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { format } from "./amount";
import { ASSETS, custodyIds } from "./assets";
import { Ledger } from "./ledger";
import { Status, formatReport, reconcile, type HoldingsSource } from "./reconcile";

export interface JobConfig {
	readonly haltFile: string;
	readonly assets: readonly string[];
	/** True only when both gate flags are set. Decides the custody source. */
	readonly mainnetEnabled: boolean;
	/** Declared testnet holdings, keyed by qualified custody id. */
	readonly testnetTreasuryFile: string;
}

/**
 * Testnet holdings from a declared file.
 *
 * Deliberately a FILE A HUMAN WRITES rather than "whatever the ledger says".
 * Reading holdings from the same ledger the liabilities come from would make
 * the external check tautological — it would pass by construction and detect
 * nothing, while looking exactly like a real reconciliation in the logs. That
 * is worse than no check, because it is a check that cannot fail.
 *
 * A missing file means holdings are unknown, which reports UNAVAILABLE rather
 * than inventing a number.
 */
export function testnetTreasury(path: string): HoldingsSource {
	return {
		name: "testnet-declared",
		async holdings(assetId: string): Promise<bigint> {
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch {
				throw new Error(
					`no declared testnet treasury at ${path} — holdings unknown`,
				);
			}
			const o = JSON.parse(raw) as Record<string, unknown>;
			const v = o[assetId];
			if (typeof v !== "string") {
				throw new Error(
					`${assetId} is not declared in ${path} — holdings unknown`,
				);
			}
			if (!/^\d+$/.test(v)) {
				throw new Error(`${assetId} in ${path} is not an integer base-unit string`);
			}
			return BigInt(v);
		},
	};
}

export interface JobResult {
	readonly ok: boolean;
	readonly halted: readonly string[];
	readonly report: string;
	readonly source: string;
}

/**
 * Run one reconciliation pass and publish the halt set.
 *
 * Reconciles each ASSET (not each chain) because a liability is per-asset, then
 * sums that asset's per-chain holdings — a venue holding 300 USDT on Ethereum
 * and 150 on Tron is holding 450 USDT, and is solvent against a 450 liability
 * even though no single chain covers it. Per-chain shortfalls are a LIQUIDITY
 * question, which liquidity.ts answers; this is a SOLVENCY question.
 */
export async function runOnce(
	ledger: Ledger,
	cfg: JobConfig,
	log: (s: string) => void = console.log,
): Promise<JobResult> {
	const source: HoldingsSource = cfg.mainnetEnabled
		? bitgoSummed()
		: testnetTreasury(cfg.testnetTreasuryFile);

	const report = await reconcile(ledger, source, cfg.assets, {
		// A surplus within one base unit is rounding noise from a chain's own
		// fee accounting, not a discrepancy worth an alert. A SHORTFALL of any
		// size is still a shortfall — see reconcile.ts on why that asymmetry is
		// deliberate rather than lazy.
		surplusTolerance: Object.fromEntries(cfg.assets.map((a) => [a, 1n])),
	});

	const halts: Record<string, string> = {};
	for (const a of report.assets) {
		if (a.haltWithdrawals) halts[a.asset] = a.detail;
	}
	writeHalts(cfg.haltFile, halts);

	const text = formatReport(report);
	log(text);
	if (!cfg.mainnetEnabled) {
		log(
			"  NOTE: external holdings came from the DECLARED TESTNET TREASURY, " +
				"not from a custodian. This pass proves the books are internally " +
				"consistent; it does NOT prove solvency.",
		);
	}
	return {
		ok: report.ok,
		halted: report.halted,
		report: text,
		source: source.name,
	};
}

/**
 * BitGo holdings, SUMMED ACROSS CHAINS for an asset.
 *
 * reconcile() asks for one number per asset, and a multi-network asset lives
 * on several. Summing here keeps the solvency question ("do we hold enough
 * USDT at all") separate from the liquidity question ("can we pay it out over
 * Tron"), which are genuinely different and have different answers.
 *
 * If ANY chain's read fails, the whole asset is reported unknown rather than
 * partially summed. A partial sum looks like a shortfall and would halt
 * withdrawals on the strength of an incomplete read.
 */
function bitgoSummed(): HoldingsSource {
	// Imported lazily so a testnet run never needs a BitGo token to exist.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { BitGoHoldings } = require("./bitgo") as typeof import("./bitgo");
	const bg = BitGoHoldings.fromEnv();
	return {
		name: bg.name,
		async holdings(symbol: string): Promise<bigint> {
			let total = 0n;
			for (const id of custodyIds(symbol)) {
				// Throws on failure, which propagates — see above.
				total += await bg.holdings(id);
			}
			return total;
		},
	};
}

/** Write the halt set atomically: temp file, then rename. */
export function writeHalts(path: string, halts: Record<string, string>): void {
	const tmp = join(dirname(path), `.${Date.now()}.halts.tmp`);
	writeFileSync(tmp, JSON.stringify(halts, null, 1), { mode: 0o644 });
	// rename(2) is atomic within a filesystem, so a reader sees either the old
	// file or the new one — never a partial write that would fail to parse and
	// be treated as "nothing halted".
	renameSync(tmp, path);
}

/** Entry point for the systemd timer. */
export async function main(): Promise<void> {
	const dbPath = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";
	const cfgPath = process.env.EXCHANGE_CONFIG ?? "/etc/blockle/exchange.json";

	let mainnetEnabled = false;
	try {
		const o = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
		mainnetEnabled =
			o.mainnetEnabled === true &&
			(o.legalReview as Record<string, unknown> | undefined)?.completed === true;
	} catch {
		// Unreadable config means testnet. Never the other way round.
	}

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Database = require("better-sqlite3") as typeof import("better-sqlite3");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	const ledger = new Ledger(db);

	const assets = Object.keys(ASSETS).filter((a) => {
		// Only reconcile assets the venue actually has a position in. Reporting
		// 0 == 0 for twenty unlisted assets buries the two that matter.
		const held = [...ledger.custodyByNetwork(a).values()].reduce((x, y) => x + y, 0n);
		return held !== 0n || ledger.liabilities(a) !== 0n;
	});

	const res = await runOnce(ledger, {
		haltFile: process.env.HALT_FILE ?? "/run/blockle/exchange-halts.json",
		assets,
		mainnetEnabled,
		testnetTreasuryFile:
			process.env.TESTNET_TREASURY ?? "/etc/blockle/testnet-treasury.json",
	});

	// EXIT NON-ZERO ON A HALT, so systemd records a failure and the operator's
	// usual tooling notices. A reconciliation break that only appears in a log
	// nobody reads is a break nobody acts on.
	if (res.halted.length > 0) {
		console.error(`HALTED: ${res.halted.join(", ")}`);
		process.exit(2);
	}
	process.exit(res.ok ? 0 : 1);
}

if (require.main === module) {
	void main().catch((e: unknown) => {
		console.error(`reconciliation failed to run: ${e instanceof Error ? e.message : String(e)}`);
		// Exit 1, NOT 2: failing to run is not the same as finding a shortfall,
		// and conflating them would make a network blip look like missing funds.
		process.exit(1);
	});
}

export { Status, format };
