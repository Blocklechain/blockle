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
	/**
	 * Explicit source of external holdings. Omit to derive it from
	 * `mainnetEnabled`, which is the historical behaviour.
	 *
	 * `"bitgo"` with the gate still shut is the dry run: reconcile for real
	 * against the custodian before any customer money is involved.
	 */
	readonly source?: "bitgo" | "declared";
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
/**
 * RECONCILE_SOURCE, validated. An unrecognised value is refused rather than
 * silently falling back to the declared file, which would turn a typo into a
 * reconciliation that proves nothing.
 */
export function sourceFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): "bitgo" | "declared" | undefined {
	const raw = (env.RECONCILE_SOURCE ?? "").trim().toLowerCase();
	if (raw === "") return undefined;
	if (raw === "bitgo" || raw === "declared") return raw;
	throw new Error(
		`RECONCILE_SOURCE must be "bitgo" or "declared", got "${raw}"`,
	);
}

export async function runOnce(
	ledger: Ledger,
	cfg: JobConfig,
	log: (s: string) => void = console.log,
): Promise<JobResult> {
	/*
	 * WHICH SOURCE OF TRUTH, chosen explicitly where it is set.
	 *
	 * The original rule was "mainnet reconciles against BitGo, testnet against
	 * a declared file", which is right for both of the states that existed
	 * then. It cannot express the one in between: a PRODUCTION BitGo account
	 * holding TESTNET coins, reconciled against for real, while the venue's
	 * mainnet gate is still shut. That is the dry run worth doing before going
	 * live — real account, real API, real wallet policies — and under the old
	 * rule it would have silently compared the books against a file a human
	 * wrote, which proves nothing about the custodian.
	 *
	 * So RECONCILE_SOURCE selects it, and when unset the old derivation stands.
	 */
	const source: HoldingsSource =
		cfg.source === "bitgo" ? bitgoAndNodes(log)
		: cfg.source === "declared" ? testnetTreasury(cfg.testnetTreasuryFile)
		: cfg.mainnetEnabled ? bitgoAndNodes(log)
		: testnetTreasury(cfg.testnetTreasuryFile);
	// ANY source that is not the declared file is a real custodian — including
	// the composite, whose name now lists both. Comparing against "bitgo"
	// would have quietly reclassified every node-custodied pass as unproven.
	const usedCustodian = source.name !== "testnet-declared";

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
	// THE CAVEAT TRACKS THE SOURCE ACTUALLY USED, not the mainnet flag. A dry
	// run against a real custodian DOES prove solvency against it, and saying
	// otherwise would undersell the only check that matters.
	if (!usedCustodian) {
		log(
			"  NOTE: external holdings came from the DECLARED TESTNET TREASURY, " +
				"not from a custodian. This pass proves the books are internally " +
				"consistent; it does NOT prove solvency.",
		);
	} else if (!cfg.mainnetEnabled) {
		log(
			`  NOTE: reconciled against ${source.name} while the venue's mainnet ` +
				"gate is still shut — a deliberate dry run against the real " +
				"custodian. These figures DO reflect what the custodian reports.",
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
/**
 * Holdings across BOTH custody models: BitGo for the majors, our own daemons
 * for the small proof-of-work coins BitGo will not hold.
 *
 * Previously this was BitGo or nothing, which was right while BitGo held
 * everything. The moment one coin is custodied on a node we run, asking BitGo
 * about it returns nothing useful — and an asset routed to the wrong custodian
 * reconciles as a shortfall and halts a coin that is perfectly fine. See
 * custodyrouting.ts; an asset with no custodian is reported UNKNOWN, never
 * zero.
 */
function bitgoAndNodes(log: (s: string) => void): HoldingsSource {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const routing = require("./custodyrouting") as typeof import("./custodyrouting");
	const nodes = routing.nodeAdapters({
		env: process.env,
		onSkip: (symbol, why) => {
			// Logged, not silent: "this coin has no node" is the normal state of
			// a planned listing, and it is also exactly what a misconfiguration
			// looks like. The operator gets to tell them apart.
			log(`  note: ${symbol} has no usable node (${why})`);
		},
	});
	return routing.routedHoldings({ bitgo: bitgoSummed(), nodes });
}

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
		...(sourceFromEnv() === undefined ? {} : { source: sourceFromEnv()! }),
	});

	/*
	 * HEARTBEAT FIRST, BEFORE THE EXIT CODE.
	 *
	 * A halt is a SUCCESSFUL detection, not a failure to run — the job did
	 * exactly its job. Beating only on a clean pass would mean the go-live
	 * preflight reported "reconciler is running: NEVER REPORTED" for a
	 * reconciler that was running every two minutes and correctly halting an
	 * asset. Which it did: the check was added after this job was written and
	 * nothing here ever called it.
	 *
	 * So the beat records that a pass COMPLETED, and says what it found. The
	 * exit code below is the separate question of whether anyone needs to act.
	 */
	/*
	 * NO HEARTBEAT ROW IS WRITTEN HERE, AND THAT IS CORRECT.
	 *
	 * Two layers deliberately stop this job writing to the ledger: the handle
	 * above is opened read-only, and the systemd unit grants ReadWritePaths for
	 * /run/blockle ALONE. The component that decides whether the venue is
	 * solvent cannot alter the books it is judging — at the filesystem level,
	 * not merely by convention.
	 *
	 * I tried twice to write a liveness row from here. The first attempt used
	 * the read-only handle and threw out of main(), so a pass that had
	 * correctly detected a shortfall and halted BLOCK was reported as
	 * "reconciliation failed to run". The second opened its own writable
	 * connection and hit the unit's filesystem restriction instead. Both were
	 * the wrong shape: the fix is not to let this job write more, it is to read
	 * liveness from what it is already allowed to produce.
	 *
	 * `writeHalts` above runs on EVERY completed pass, empty set included, so
	 * the halt file's modification time is proof a pass finished. The preflight
	 * reads that for the reconciler (see golive.ts) and needs nothing else.
	 */

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
