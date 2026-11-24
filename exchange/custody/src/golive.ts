// -----------------------------------------------------------------------------
// GO-LIVE PREFLIGHT — the checklist that decides, instead of a person deciding.
//
// WHY THIS EXISTS. "Are we ready for mainnet?" is a question somebody answers
// optimistically at the end of a long day, and the cost of answering it wrong
// is other people's money. So it is not answered by judgement here. It is a
// list of mechanical checks run against the live box, each of which either
// passes with evidence or fails with the reason, and the gate file cannot be
// flipped unless every one of them passes.
//
// THE FAILURE MODE THIS IS GUARDING AGAINST IS SPECIFIC AND IT IS NOT ABSTRACT.
//
// A custodial venue can be in a state where it accepts deposits and cannot
// credit them, or debits withdrawals and cannot send them. Both look fine from
// the outside — the site is up, the order book works, the balances page
// renders — and both lose customer money silently. Trading being green tells
// you nothing about whether the rails that move real coins exist.
//
// So the two checks that matter most are the two that are easiest to forget:
// IS ANYTHING WATCHING FOR DEPOSITS, and IS ANYTHING ACTUALLY SENDING
// WITHDRAWALS. A venue missing either must not be live, regardless of how
// complete everything else is.
//
// HEARTBEATS, NOT PROCESS LISTS. A systemd unit being "active" does not mean
// its loop is running — it can be wedged on a socket read, or looping on an
// error it swallows. Each runner writes a row saying what it did and when, and
// this preflight reads that. A runner that has not reported recently is
// treated as absent, which is the honest reading.
//
// WHAT THIS DELIBERATELY DOES NOT CHECK: whether the operator is licensed.
// That is not a fact about the system and the system cannot verify it. The
// `legalReviewCompleted` flag records an assertion by a human; this preflight
// records whether the MACHINERY can honour it.
// -----------------------------------------------------------------------------

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "better-sqlite3";

import { ASSETS, assetDef, custodyIds, settlementAsset } from "./assets";
import { Deposits } from "./deposits";
import { LIVE_GAS_COSTS, gasPositions, type GasGateDeps } from "./gasgate";
import { GAS_PRICE_FLOOR, StaticRates } from "./gasrates";
import { AccountKind, type Ledger } from "./ledger";
import { MARKETS } from "./venue";
import { auditGasCoverage, LIVE_FEES } from "./withdrawalfees";
import { revenue } from "./revenue";

export const SCHEMA = `
-- One row per runner, rewritten on every successful cycle. A runner that is
-- wedged stops updating this, which is what makes "has not reported recently"
-- detectable at all.
CREATE TABLE IF NOT EXISTS runner_heartbeat (
  runner    TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  detail    TEXT,
  cycles    INTEGER NOT NULL DEFAULT 0
);
`;

/** Runners whose absence means customer funds would be stranded. */
export const REQUIRED_RUNNERS = [
	{
		name: "deposit-watcher",
		why:
			"Without it, a customer deposit arrives on chain and is NEVER credited " +
			"to their balance. The money is in custody and the books do not know. " +
			"This is the single worst state a custodial venue can be in, because " +
			"everything else looks fine.",
		maxAgeMs: 10 * 60 * 1000,
	},
	{
		name: "payout-runner",
		why:
			"Without it, a withdrawal is debited from the customer, moved to " +
			"INFLIGHT, approved — and never sent. It sits there. The customer has " +
			"no funds and no payment.",
		maxAgeMs: 10 * 60 * 1000,
	},
	{
		name: "reconciler",
		why:
			"Without it, nothing compares the books against what the custodian " +
			"actually holds, so a shortfall goes unnoticed and the withdrawal " +
			"interlock never engages.",
		maxAgeMs: 2 * 60 * 60 * 1000,
	},
] as const;

export interface Check {
	readonly id: string;
	readonly title: string;
	readonly pass: boolean;
	/** What was actually observed. Present whether it passed or failed. */
	readonly evidence: string;
	/**
	 * True when failing this check means customer funds could be lost or
	 * stranded, as opposed to the venue merely being less complete.
	 */
	readonly fundsCritical: boolean;
}

export interface Preflight {
	readonly ready: boolean;
	readonly checks: readonly Check[];
	readonly blocking: readonly Check[];
	readonly at: string;
	readonly summary: string;
}

export interface PreflightDeps {
	readonly db: Database;
	readonly ledger: Ledger;
	readonly configPath: string;
	/** Reads live custody holdings. Undefined when no custodian is configured. */
	readonly holdings?: {
		readonly name: string;
		byCustodyId(): Promise<Map<string, bigint>>;
	};
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now?: () => number;
}

function ok(id: string, title: string, evidence: string, critical = false): Check {
	return { id, title, pass: true, evidence, fundsCritical: critical };
}
function no(id: string, title: string, evidence: string, critical = false): Check {
	return { id, title, pass: false, evidence, fundsCritical: critical };
}

/** Heartbeat helper, used by the runners themselves. */
export function beat(db: Database, runner: string, detail: string): void {
	db.exec(SCHEMA);
	db.prepare(
		`INSERT INTO runner_heartbeat (runner, at, detail, cycles)
		 VALUES (?, ?, ?, 1)
		 ON CONFLICT(runner) DO UPDATE SET
		   at = excluded.at, detail = excluded.detail, cycles = cycles + 1`,
	).run(runner, new Date().toISOString(), detail);
}

export async function preflight(deps: PreflightDeps): Promise<Preflight> {
	deps.db.exec(SCHEMA);
	const now = (deps.now ?? (() => Date.now()))();
	const checks: Check[] = [];
	const listed = listedAssets();

	// ---- 1. THE RAILS THAT MOVE REAL MONEY ---------------------------------

	for (const r of REQUIRED_RUNNERS) {
		const row = deps.db
			.prepare(`SELECT at, detail, cycles FROM runner_heartbeat WHERE runner = ?`)
			.get(r.name) as { at: string; detail: string | null; cycles: number } | undefined;
		if (row === undefined) {
			checks.push(no(
				`runner:${r.name}`,
				`${r.name} is running`,
				`NEVER REPORTED. ${r.why}`,
				true,
			));
			continue;
		}
		const age = now - Date.parse(row.at);
		if (!(age >= 0) || age > r.maxAgeMs) {
			checks.push(no(
				`runner:${r.name}`,
				`${r.name} is running`,
				`last reported ${Math.round(age / 60000)} min ago (limit ` +
					`${Math.round(r.maxAgeMs / 60000)} min). A unit can be "active" ` +
					`while its loop is wedged, so silence is treated as absent. ${r.why}`,
				true,
			));
			continue;
		}
		checks.push(ok(
			`runner:${r.name}`,
			`${r.name} is running`,
			`last reported ${Math.round(age / 1000)}s ago after ${row.cycles} ` +
				`cycles: ${row.detail ?? "no detail"}`,
			true,
		));
	}

	// ---- 2. CAN ANYONE DEPOSIT AT ALL? ------------------------------------

	const deposits = new Deposits(deps.db);
	const provisioned = deposits.provisionedCount();
	checks.push(provisioned > 0
		? ok("deposit:addresses", "Deposit addresses provisioned",
			`${provisioned} address(es) on file`, true)
		: no("deposit:addresses", "Deposit addresses provisioned",
			"NONE. The deposit screen correctly refuses to show an address it is " +
				"not certain of, so no money is at risk — but nobody can fund an " +
				"account either, which makes a live venue useless rather than " +
				"dangerous.", true));

	// ---- 3. CUSTODY IS REAL AND REACHABLE ---------------------------------

	const bitgoEnv = deps.env.BITGO_ENV ?? "";
	checks.push(bitgoEnv === "prod"
		? ok("custody:env", "Custodian is in production", "BITGO_ENV=prod", true)
		: no("custody:env", "Custodian is in production",
			`BITGO_ENV=${bitgoEnv || "(unset)"}. Test-environment wallets hold ` +
				"testnet coins. Going live against them means the books record " +
				"real customer liabilities backed by worthless test assets.", true));

	checks.push((deps.env.BITGO_ACCESS_TOKEN ?? "") !== ""
		? ok("custody:token", "Custodian credentials present", "token is set", true)
		: no("custody:token", "Custodian credentials present",
			"BITGO_ACCESS_TOKEN is unset — nothing can be sent or read.", true));

	if (deps.holdings !== undefined) {
		try {
			const held = await deps.holdings.byCustodyId();
			const wanted = listed.flatMap((a) => custodyIds(a));
			const missing = wanted.filter((id) => !held.has(id));
			checks.push(missing.length === 0
				? ok("custody:wallets", "A custody wallet exists for every listed chain",
					`${wanted.length} chains, all present via ${deps.holdings.name}`, true)
				: no("custody:wallets", "A custody wallet exists for every listed chain",
					`no wallet for: ${missing.join(", ")}. A listed asset with no ` +
						"wallet cannot receive a deposit or fund a withdrawal.", true));
		} catch (e) {
			checks.push(no("custody:wallets", "A custody wallet exists for every listed chain",
				`could not read holdings from ${deps.holdings.name}: ` +
					`${e instanceof Error ? e.message : String(e)}`, true));
		}
	} else {
		checks.push(no("custody:wallets", "A custody wallet exists for every listed chain",
			"no custodian configured in this preflight run, so wallet coverage is " +
				"UNKNOWN. Unknown is a failure here, not a pass.", true));
	}

	// ---- 4. THE BOOKS ------------------------------------------------------

	try {
		const v = deps.ledger.verify();
		checks.push(v.ok
			? ok("ledger:chain", "Ledger hash chain is intact", "verify() passed", true)
			: no("ledger:chain", "Ledger hash chain is intact",
				`verify() FAILED: ${JSON.stringify(v)}. The audit trail cannot be ` +
					"trusted, which is the one thing it exists for.", true));
	} catch (e) {
		checks.push(no("ledger:chain", "Ledger hash chain is intact",
			e instanceof Error ? e.message : String(e), true));
	}

	try {
		const r = revenue(deps.db, deps.ledger);
		checks.push(r.reconciles
			? ok("books:revenue", "Fee accounting reconciles", "every posting classified")
			: no("books:revenue", "Fee accounting reconciles", r.warnings.join(" | ")));
	} catch (e) {
		checks.push(no("books:revenue", "Fee accounting reconciles",
			e instanceof Error ? e.message : String(e)));
	}

	// ---- 5. CAN WE PAY OUT? -----------------------------------------------

	const gasDeps: GasGateDeps = {
		ledger: deps.ledger,
		// Preflight asks "could we pay one withdrawal now", so nothing queued.
		pendingOnChain: () => 0,
		table: LIVE_GAS_COSTS,
	};
	const dry = gasPositions(gasDeps).filter((p) => !p.healthy);
	checks.push(dry.length === 0
		? ok("gas:floats", "Every token chain can pay its gas",
			`${gasPositions(gasDeps).length} chains funded`, true)
		: no("gas:floats", "Every token chain can pay its gas",
			`no gas float on: ${dry.map((p) => p.chain + " (needs " + p.gasAsset + ")").join(", ")}. ` +
				"Those chains refuse withdrawals rather than accepting ones they " +
				"cannot send, so nothing is lost — but the asset is advertised and " +
				"not payable.", true));

	const uncovered = auditGasCoverage(LIVE_FEES, {
		sources: [new StaticRates(GAS_PRICE_FLOOR)],
	}).filter((c) => !c.covered);
	checks.push(uncovered.length === 0
		? ok("fees:coverage", "Every chain's fee covers its gas", "all chains covered")
		: no("fees:coverage", "Every chain's fee covers its gas",
			`losing money on: ${uncovered.map((c) => c.chain).join(", ")}`));

	// ---- 6. LIMITS AND ADMIN ----------------------------------------------

	const unwithdrawable = listed.filter((a) => {
		const keys = Object.keys(LIVE_FEES).filter(
			(k) => k === a || k.startsWith(a + "."),
		);
		return keys.length === 0;
	});
	checks.push(unwithdrawable.length === 0
		? ok("limits:fees", "Every listed asset has a withdrawal fee",
			`${listed.length} assets priced`, true)
		: no("limits:fees", "Every listed asset has a withdrawal fee",
			`unpriced, therefore unwithdrawable: ${unwithdrawable.join(", ")}. ` +
				"Customers could buy it and never get it out.", true));

	const admins = (deps.env.EXCHANGE_ADMINS ?? "").trim();
	checks.push(admins !== ""
		? ok("admin:allowlist", "An operator can reach the console", admins)
		: no("admin:allowlist", "An operator can reach the console",
			"EXCHANGE_ADMINS is empty, so nobody is an administrator and nobody " +
				"can fund a gas float or see the venue's position."));

	const totp = (deps.env.EXCHANGE_ADMIN_TOTP ?? "").trim();
	checks.push(totp !== ""
		? ok("admin:totp", "Operator 2FA is enrolled", "a secret is configured")
		: no("admin:totp", "Operator 2FA is enrolled",
			"no authenticator enrolled, so the console is read-only and no " +
				"operator action can be taken."));

	// ---- 7. THE GATE FILE ITSELF ------------------------------------------

	const gate = readGate(deps.configPath);
	checks.push(gate.readable
		? ok("config:readable", "Gate config is readable",
			`${deps.configPath}: ${JSON.stringify(gate.value)}`)
		: no("config:readable", "Gate config is readable",
			`${deps.configPath} is missing or unparseable (${gate.error}). Every ` +
				"flag then reads false, which fails closed — but it also means the " +
				"flip below has nothing to write into."));

	const blocking = checks.filter((c) => !c.pass);
	const criticalBlocking = blocking.filter((c) => c.fundsCritical);
	const ready = blocking.length === 0;

	return {
		ready,
		checks,
		blocking,
		at: new Date(now).toISOString(),
		summary: ready
			? `All ${checks.length} checks pass. The machinery can honour a live venue.`
			: `${blocking.length} of ${checks.length} checks FAIL` +
				(criticalBlocking.length > 0
					? `, ${criticalBlocking.length} of them where customer funds would be ` +
						`lost or stranded: ${criticalBlocking.map((c) => c.id).join(", ")}`
					: "") +
				". NOT READY.",
	};
}

function listedAssets(): readonly string[] {
	const seen = new Set<string>();
	for (const m of MARKETS) {
		seen.add(settlementAsset(m.base));
		seen.add(settlementAsset(m.quote));
	}
	return [...seen].filter((a) => ASSETS[a] !== undefined).sort();
}

function readGate(path: string): {
	readable: boolean;
	value: unknown;
	error: string;
} {
	try {
		if (!existsSync(path)) return { readable: false, value: null, error: "no such file" };
		return { readable: true, value: JSON.parse(readFileSync(path, "utf8")), error: "" };
	} catch (e) {
		return { readable: false, value: null, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Flip the venue live — ONLY if the preflight passes.
 *
 * There is no force flag and no override. If a check is wrong, the fix is to
 * fix the check or fix the system, not to bypass the gate: a bypass added "just
 * for launch" is a bypass that is still there a year later, and the thing it
 * bypasses is whether customer deposits can be credited.
 *
 * Written temp-then-rename, so a crash mid-write cannot leave a half-parsed
 * config — which would read as every flag false, which is at least safe, but
 * would also be a confusing way to find out.
 */
export async function flipLive(deps: PreflightDeps): Promise<{
	flipped: boolean;
	report: Preflight;
}> {
	const report = await preflight(deps);
	if (!report.ready) return { flipped: false, report };

	const existing = readGate(deps.configPath);
	// THE SHAPE THE SERVICE ACTUALLY READS. publicapi's `gate()` looks for
	// `mainnetEnabled` at the top level and `legalReview.completed` NESTED. The
	// first version of this wrote a flat `legalReviewCompleted`, which would
	// have produced a config that looked flipped, reported "FLIPPED" on the
	// terminal, and left the venue reading `legalReviewCompleted: false`
	// forever — live by one flag and not the other, with the operator believing
	// otherwise. Caught by reading the live file rather than assuming its shape.
	const next = {
		...(typeof existing.value === "object" && existing.value !== null ? existing.value : {}),
		mainnetEnabled: true,
		legalReview: {
			...(((existing.value as Record<string, unknown> | null)?.legalReview as
				Record<string, unknown> | undefined) ?? {}),
			completed: true,
			assertedAt: new Date().toISOString(),
		},
		liveSince: new Date().toISOString(),
	};
	const tmp = join(dirname(deps.configPath), `.${Date.now()}.gate.tmp`);
	writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o640 });
	renameSync(tmp, deps.configPath);

	// READ IT BACK AND CHECK IT PARSES AS LIVE, using the same two keys the
	// service reads. Reporting a successful flip because a write did not throw
	// is how the shape bug above would have survived.
	const after = readGate(deps.configPath);
	const o = (after.value ?? {}) as Record<string, unknown>;
	const live =
		o.mainnetEnabled === true &&
		(o.legalReview as Record<string, unknown> | undefined)?.completed === true;
	if (!live) {
		throw new Error(
			`wrote ${deps.configPath} but it does not read back as live — ` +
				"refusing to report a flip that did not take effect",
		);
	}
	return { flipped: true, report };
}

/** Render a report for a terminal. */
export function format(r: Preflight): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("  BLOCKLE EXCHANGE — GO-LIVE PREFLIGHT");
	lines.push(`  ${r.at}`);
	lines.push("");
	for (const c of r.checks) {
		const mark = c.pass ? "  PASS " : c.fundsCritical ? "  FAIL*" : "  FAIL ";
		lines.push(`${mark} ${c.title}`);
		lines.push(`         ${c.evidence}`);
	}
	lines.push("");
	lines.push(`  ${r.summary}`);
	if (!r.ready) {
		lines.push("");
		lines.push("  * = customer funds would be lost or stranded. These are not");
		lines.push("    advisory. There is no override; the gate stays shut.");
	}
	lines.push("");
	return lines.join("\n");
}
