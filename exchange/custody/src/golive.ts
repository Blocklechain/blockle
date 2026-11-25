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

import {
	chmodSync,
	chownSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	/**
	 * The account the public API runs as, for the config:service-readable
	 * check. Defaults to www-data, which is what the unit on the box uses.
	 */
	readonly serviceUser?: string;
	/** Reads live custody holdings. Undefined when no custodian is configured. */
	readonly holdings?: {
		readonly name: string;
		byCustodyId(): Promise<Map<string, bigint>>;
	};
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * Confirms the custody token belongs to the configured installation.
	 * Absent means UNKNOWN, which this preflight treats as a failure.
	 */
	readonly verifyCustodyEnv?: () => Promise<{ ok: boolean; detail: string }>;
	/**
	 * Custody ids a CUSTODIAN wallet is expected for. Supplied by the caller
	 * because it knows which assets are self-custodied; deriving it here would
	 * demand a BitGo wallet for our own chains, which BitGo refuses.
	 */
	readonly expectCustodyIds?: readonly string[];
	/**
	 * Where the reconciler writes its halt set. Its mtime is that runner's
	 * liveness evidence — see the note in the runner loop.
	 */
	readonly haltFile?: string;
	readonly now?: () => number;
}

/** Does the gate file already say live? Used only to reason about the faucet. */
function gateIsLive(path: string): boolean {
	const g = readGate(path);
	const o = (g.value ?? {}) as Record<string, unknown>;
	return (
		o.mainnetEnabled === true &&
		(o.legalReview as Record<string, unknown> | undefined)?.completed === true
	);
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
		let row = deps.db
			.prepare(`SELECT at, detail, cycles FROM runner_heartbeat WHERE runner = ?`)
			.get(r.name) as { at: string; detail: string | null; cycles: number } | undefined;

		/*
		 * THE RECONCILER PROVES ITSELF WITH AN ARTEFACT, NOT A ROW.
		 *
		 * It is denied write access to the ledger on purpose — read-only
		 * handle AND a systemd unit whose only writable path is /run/blockle —
		 * because the component judging solvency must not be able to alter the
		 * books. So it cannot write a heartbeat row, and demanding one made
		 * this check report "NEVER REPORTED" for a reconciler that was running
		 * every two minutes and correctly halting an asset.
		 *
		 * It writes the halt file on every completed pass, empty set included.
		 * That file's mtime is the evidence, and it is better evidence than a
		 * row: it is the thing the rest of the system actually consumes, so a
		 * stale one means the interlock is stale too.
		 */
		if (row === undefined && r.name === "reconciler" && deps.haltFile !== undefined) {
			try {
				const st = statSync(deps.haltFile);
				row = {
					at: new Date(st.mtimeMs).toISOString(),
					detail: `halt file written at ${new Date(st.mtimeMs).toISOString()}`,
					cycles: 1,
				};
			} catch {
				// Absent: leave row undefined and fail the check below.
			}
		}

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

	const bitgoEnv = (deps.env.BITGO_ENV ?? "").trim().toLowerCase();
	const bitgoCoins = (deps.env.BITGO_COINS ?? "").trim().toLowerCase() ||
		(bitgoEnv === "prod" ? "mainnet" : "testnet");
	// REAL MONEY IS THE CONJUNCTION. The production installation holding
	// testnet coins is a perfectly good dry run and is NOT a live venue; the
	// mainnet gate must not open on it, or the books would record real
	// liabilities against test assets.
	const realMoney = bitgoEnv === "prod" && bitgoCoins === "mainnet";
	checks.push(realMoney
		? ok("custody:env", "Custodian holds real assets",
			"BITGO_ENV=prod, BITGO_COINS=mainnet", true)
		: no("custody:env", "Custodian holds real assets",
			`BITGO_ENV=${bitgoEnv || "(unset)"}, BITGO_COINS=${bitgoCoins}. ` +
				"A live venue needs the production installation AND mainnet coins. " +
				"Either alone is a dry run: going live against testnet coins means " +
				"the books record real customer liabilities backed by worthless " +
				"test assets.", true));

	checks.push((deps.env.BITGO_ACCESS_TOKEN ?? "") !== ""
		? ok("custody:token", "Custodian credentials present", "token is set", true)
		: no("custody:token", "Custodian credentials present",
			"BITGO_ACCESS_TOKEN is unset — nothing can be sent or read.", true));

	// THE TOKEN BELONGS TO THE ENVIRONMENT IT IS POINTED AT. BitGo's two
	// installations return an indistinguishable 401 for "wrong environment",
	// "IP not whitelisted" and "revoked", so without this the commonest
	// misconfiguration there is reads as a broken token.
	if (deps.verifyCustodyEnv !== undefined) {
		try {
			const v = await deps.verifyCustodyEnv();
			checks.push(v.ok
				? ok("custody:envmatch", "Token matches the configured environment",
					v.detail, true)
				: no("custody:envmatch", "Token matches the configured environment",
					v.detail, true));
		} catch (e) {
			checks.push(no("custody:envmatch", "Token matches the configured environment",
				e instanceof Error ? e.message : String(e), true));
		}
	} else {
		checks.push(no("custody:envmatch", "Token matches the configured environment",
			"not checked — no custodian was constructed, so this is UNKNOWN, " +
				"which is a failure here rather than a pass.", true));
	}

	// ---- THE FAUCET MUST BE SHUT ------------------------------------------
	//
	// It credits CUSTODY alongside the user's balance, and a live custodian
	// would not report those coins. Reconciliation reads the difference as a
	// shortfall and halts that asset permanently. One click is enough.
	// Keyed on the RECONCILE SOURCE, which is the precise condition — a token
	// being configured while the reconciler still reads a declared file leaves
	// the faucet harmless.
	const effectiveSource =
		(deps.env.RECONCILE_SOURCE ?? "").trim().toLowerCase() ||
		(gateIsLive(deps.configPath) ? "bitgo" : "declared");
	const faucetShut = effectiveSource === "bitgo";
	checks.push(faucetShut
		? ok("faucet:shut", "The testnet faucet is disabled",
			`RECONCILE_SOURCE is ${effectiveSource}, so the venue refuses it ` +
				"outright", true)
		: no("faucet:shut", "The testnet faucet is disabled",
			"the faucet is still reachable because reconciliation reads a " +
				"DECLARED FILE rather than the custodian. Set " +
				"RECONCILE_SOURCE=bitgo: that both reconciles for real and shuts " +
				"the faucet, which credits custody the custodian does not hold.",
			true));

	// AND RECONCILING AGAINST A FILE IS NOT RECONCILING. A live venue checked
	// against numbers a human typed proves the books are self-consistent and
	// nothing about solvency.
	checks.push(effectiveSource === "bitgo"
		? ok("reconcile:source", "Reconciliation compares against the custodian",
			"RECONCILE_SOURCE=bitgo", true)
		: no("reconcile:source", "Reconciliation compares against the custodian",
			`source is "${effectiveSource}" — holdings come from a file a human ` +
				"writes, which is tautological for a live venue. It proves the " +
				"books are internally consistent and nothing about solvency.", true));

	if (deps.holdings !== undefined) {
		try {
			const held = await deps.holdings.byCustodyId();
			const wanted = deps.expectCustodyIds ?? listed.flatMap((a) => custodyIds(a));
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

	// ---- 3b. WHOSE MONEY IS IT? -------------------------------------------
	//
	// The production account this venue uses also holds wallets for other
	// projects and a personal one, with real balances. Without a wallet scope
	// the holdings adapter would count those as exchange custody: books below
	// custody, read as a tolerated SURPLUS, hiding a genuine shortfall of up to
	// that size. The adapter now refuses outright, so this check exists to say
	// WHY before an operator meets the refusal.
	const scoped =
		(deps.env.BITGO_WALLETS ?? "").trim() !== "" ||
		(deps.env.BITGO_WALLET_PREFIX ?? "").trim() !== "";
	checks.push(scoped
		? ok("custody:scope", "Exchange wallets are identified",
			(deps.env.BITGO_WALLETS ?? "").trim() !== ""
				? `BITGO_WALLETS lists ${(deps.env.BITGO_WALLETS ?? "").split(/[,\s]+/).filter((x) => x !== "").length} wallet id(s)`
				: `BITGO_WALLET_PREFIX="${(deps.env.BITGO_WALLET_PREFIX ?? "").trim()}"`,
			true)
		: no("custody:scope", "Exchange wallets are identified",
			"neither BITGO_WALLETS nor BITGO_WALLET_PREFIX is set. The custody " +
				"account is shared with other projects, so without this the " +
				"reconciler cannot tell the exchange's coins from anyone else's — " +
				"and the direction of that error (books below custody) is the one " +
				"reconcile tolerates, which would hide a real shortfall.", true));

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
		/*
		 * THE ARITHMETIC IS THE GATE; AN OPERATOR CORRECTION IS A NOTE.
		 *
		 * This used to key off `r.reconciles`, which is false both when the
		 * books do not add up AND when any fee movement carries a reason the
		 * revenue report declines to classify — an operator adjustment or a
		 * CORRECTION. Those are not the same claim, and only the first is a
		 * defect.
		 *
		 * Because corrections are permanent (the ledger is append-only on
		 * purpose), the old form meant a venue that had ever reversed anything
		 * failed this check for the rest of its life. The clearing of the faucet
		 * liabilities on 2026-11-25 did exactly that: the fee accounts net to
		 * zero, nothing is wrong, and the line went red forever.
		 *
		 * So: FAIL when the buckets do not sum to the balance. PASS, with the
		 * amount named, when they do and some of it is simply not revenue.
		 */
		const unclassified = Object.entries(r.unclassifiedByAsset);
		checks.push(!r.arithmeticHolds
			? no("books:revenue", "Fee accounting reconciles",
				r.warnings.join(" | "))
			: unclassified.length === 0
			? ok("books:revenue", "Fee accounting reconciles", "every posting classified")
			: ok("books:revenue", "Fee accounting reconciles",
				`buckets reconcile. ${unclassified.length} asset(s) carry ` +
					`unclassified movement (${unclassified.map(([a, v]) => `${a} ${v}`).join(", ")}) ` +
					"from an operator adjustment or correction — excluded from " +
					"profit, so read the revenue report before quoting a figure."));
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
	/*
	 * AN UNFUNDED GAS FLOAT CLOSES ITS CHAIN; IT DOES NOT BLOCK THE VENUE.
	 *
	 * This used to be a fund-loss check, which made every gas float a
	 * precondition for opening at all. That is the wrong shape: a chain with no
	 * float is not dangerous, it is SHUT — withdrawals refuse (withdrawals.ts)
	 * and, since 2026-11-25, deposits refuse too, so no customer can hand over
	 * coins on a chain the venue cannot send from. The chain opens by itself the
	 * moment the float arrives.
	 *
	 * SO THE DOWNGRADE IS ONLY HONEST BECAUSE DEPOSITS CLOSE AS WELL. With
	 * withdrawals-only refusal, opening unfunded would have invited deposits on
	 * a chain whose coins could not leave — stranded, not lost, which is still
	 * not a position to put a customer in. If that deposit gate is ever removed,
	 * this must go back to fund-loss.
	 */
	const positions = gasPositions(gasDeps);
	const dry = positions.filter((p) => !p.healthy);
	checks.push(dry.length === 0
		? ok("gas:floats", "Every token chain can pay its gas",
			`${positions.length} chains funded`, true)
		: ok("gas:floats", "Chains without gas are closed, not broken",
			`${positions.length - dry.length}/${positions.length} chains funded. ` +
				`CLOSED until funded: ${dry.map((p) => p.chain + " (needs " + p.gasAsset + ")").join(", ")}. ` +
				"Both deposits and withdrawals refuse on those chains, so nothing " +
				"can be stranded; each opens automatically when its float arrives."));

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

	/*
	 * READABLE BY THE SERVICE, NOT JUST BY ME.
	 *
	 * This check exists because `config:readable` above passed on a gate file
	 * the venue could not open. The preflight runs as root; root ignores the
	 * permission bits; the API runs as www-data. A 0640 root:root gate is
	 * therefore fully readable here and EACCES there, so a genuine flip —
	 * mainnetEnabled true, written and read back — left the site serving
	 * "Testnet" with every check green. Nothing in the report pointed at the
	 * cause, because no check was asking the question from the consumer's side.
	 *
	 * Not funds-critical: the failure direction is closed (the venue refuses to
	 * be live), which strands nobody's money. It is a liveness bug, and the
	 * cost is entirely in operator confusion — which is what the evidence
	 * string is for.
	 */
	const svc = readableByService(deps.configPath, deps.serviceUser ?? "www-data");
	checks.push(svc.ok
		? ok("config:service-readable", "The API service can read the gate", svc.why)
		: no("config:service-readable", "The API service can read the gate",
			`${svc.why}. The service fails closed on an unreadable gate, so the ` +
				"venue will serve testnet no matter what the file says. Fix with " +
				`chgrp ${deps.serviceUser ?? "www-data"} ${deps.configPath} (keep it 0640 — ` +
				"it stays unreadable to every other local account)."));

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

/**
 * Resolve a username to its uid and the full set of gids it holds.
 *
 * Parsed out of /etc/passwd and /etc/group rather than taken from a syscall
 * because node exposes no getpwnam, and because the question being asked is
 * about a DIFFERENT user than the one running this process.
 *
 * Returns null when the user does not exist, which the caller must treat as
 * "cannot answer" rather than "readable" — see readableByService.
 */
function resolveUser(user: string): { uid: number; gids: number[] } | null {
	try {
		const line = readFileSync("/etc/passwd", "utf8")
			.split("\n")
			.find((l) => l.startsWith(`${user}:`));
		if (line === undefined) return null;
		const f = line.split(":");
		const uid = Number(f[2]);
		const primary = Number(f[3]);
		if (!Number.isInteger(uid) || !Number.isInteger(primary)) return null;
		const gids = new Set<number>([primary]);
		// Supplementary groups: the member list is the 4th field, comma-separated.
		for (const g of readFileSync("/etc/group", "utf8").split("\n")) {
			const gf = g.split(":");
			const members = gf[3];
			if (members === undefined) continue;
			if (members.split(",").some((m) => m.trim() === user)) {
				const gid = Number(gf[2]);
				if (Number.isInteger(gid)) gids.add(gid);
			}
		}
		return { uid, gids: [...gids] };
	} catch {
		return null;
	}
}

/**
 * Could `user` read this path, judging by the permission bits?
 *
 * WHY THIS EXISTS AND WHY IT IS NOT access(). The preflight runs as root, and
 * **root bypasses the permission bits entirely** — access(R_OK) returns true
 * for a 0640 root:root file no matter who the service runs as. So the original
 * `config:readable` check reported PASS on a gate file the venue itself could
 * not open, and the venue, correctly failing closed, kept serving "testnet"
 * after a flip that had genuinely written `mainnetEnabled: true`. The operator
 * sees a flipped file, a green check, and a testnet banner, with nothing
 * connecting them.
 *
 * So the bits are evaluated against the service account directly. Every parent
 * directory needs +x too, or the open fails before the file's own mode is ever
 * consulted — that is a real and easy way to lock a service out of a file whose
 * mode looks fine.
 */
export function readableByService(path: string, user: string): { ok: boolean; why: string } {
	const u = resolveUser(user);
	if (u === null) return { ok: false, why: `user ${user} does not exist on this host` };
	/** The read bit that applies to this user: owner 0400, group 0040, other 0004. */
	const canRead = (mode: number, uid: number, gid: number): boolean => {
		const bit = u.uid === uid ? 0o400 : u.gids.includes(gid) ? 0o040 : 0o004;
		return (mode & bit) !== 0;
	};
	try {
		for (let d = dirname(path); ; d = dirname(d)) {
			const st = statSync(d);
			// Search permission on a directory is the x bit, at the same
			// owner/group/other offset as r.
			const xb = u.uid === st.uid ? 0o100 : u.gids.includes(st.gid) ? 0o010 : 0o001;
			if ((st.mode & xb) === 0) {
				return { ok: false, why: `${user} cannot traverse ${d} (mode ${(st.mode & 0o777).toString(8)})` };
			}
			if (d === "/" || dirname(d) === d) break;
		}
		const st = statSync(path);
		if (!canRead(st.mode, st.uid, st.gid)) {
			return {
				ok: false,
				why:
					`${path} is mode ${(st.mode & 0o777).toString(8)} uid ${st.uid} gid ${st.gid}; ` +
					`${user} (uid ${u.uid}, gids ${u.gids.join(",")}) has no read bit`,
			};
		}
		return { ok: true, why: `${user} can read ${path} (mode ${(st.mode & 0o777).toString(8)})` };
	} catch (e) {
		return { ok: false, why: e instanceof Error ? e.message : String(e) };
	}
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
	/*
	 * PRESERVE THE OWNERSHIP OF THE FILE BEING REPLACED.
	 *
	 * temp-then-rename creates a NEW inode, owned by whoever ran the flip
	 * (root) with whatever mode is passed here. So a gate file that had been
	 * chgrp'd to the service account — the thing that lets the API read it at
	 * all — silently reverts to root:root on the next flip, and the venue drops
	 * back to serving testnet with no error anywhere. A fix applied by hand
	 * once is a fix that expires at the next flip, so the write carries the
	 * ownership forward instead.
	 */
	const tmp = join(dirname(deps.configPath), `.${Date.now()}.gate.tmp`);
	writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o640 });
	try {
		const prev = statSync(deps.configPath);
		chownSync(tmp, prev.uid, prev.gid);
		chmodSync(tmp, prev.mode & 0o777);
	} catch {
		// No previous file, or not permitted to chown. 0640 root:root stands;
		// config:service-readable reports it on the next run.
	}
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

	/*
	 * AND CHECK THE SERVICE CAN STILL READ IT. The read-back above runs as
	 * root, which proves nothing about the account that actually serves the
	 * flag: the first time this venue went live the file said mainnetEnabled
	 * true and the site still said Testnet, because www-data got EACCES. A
	 * flip the consumer cannot observe is not a flip, so it is reported as the
	 * failure it is rather than as success.
	 */
	const reach = readableByService(deps.configPath, deps.serviceUser ?? "www-data");
	if (!reach.ok) {
		throw new Error(
			`wrote ${deps.configPath} and it reads back live, but ${reach.why}. The ` +
				"API fails closed on an unreadable gate, so the venue would keep " +
				"serving testnet. Refusing to report this as a flip.",
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
