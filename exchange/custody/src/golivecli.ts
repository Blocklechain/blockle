// -----------------------------------------------------------------------------
// `node dist/src/golivecli.js` — run the go-live preflight.
//
// With `--flip` it also turns the venue live, but ONLY if every check passes.
// Separated from golive.ts so the checks are importable (the admin console
// shows them) without a module that can write the gate file being pulled into
// the web process.
// -----------------------------------------------------------------------------

import Database from "better-sqlite3";

import { ASSETS, custodyIds, settlementAsset } from "./assets";
import { BitGoHoldings } from "./bitgo";
import { pinAndVerify } from "./ipv4";
import { MARKETS } from "./venue";
import { flipLive, format, preflight, type PreflightDeps } from "./golive";
import { Ledger } from "./ledger";

/**
 * Every chain-qualified custody id the venue needs a BITGO wallet for.
 *
 * EXCLUDES OUR OWN CHAINS. BLOCK and PERBUG are self-custodied — BitGo does
 * not list them and the adapter refuses them outright with a reason. Demanding
 * a BitGo wallet for them made the coverage check impossible to pass, which
 * would have left a permanent red line that an operator learns to ignore. They
 * need their own holdings source; that is a separate check to add when the
 * self-custody signer is wired, not a BitGo one.
 */
const SELF_CUSTODIED = new Set(["BLOCK", "PERBUG"]);

const CUSTODY_IDS: readonly string[] = (() => {
	const assets = new Set<string>();
	for (const m of MARKETS) {
		assets.add(settlementAsset(m.base));
		assets.add(settlementAsset(m.quote));
	}
	return [...assets]
		.filter((a) => ASSETS[a] !== undefined && !SELF_CUSTODIED.has(a))
		.flatMap((a) => custodyIds(a));
})();

async function main(): Promise<void> {
	/*
	 * PIN IPv4 BEFORE TOUCHING BITGO.
	 *
	 * The access token is whitelisted to this host's IPv4 address and the box
	 * also has IPv6, so an unpinned request can leave over v6 and come back as
	 * a 401 that is indistinguishable from a bad token. The web service already
	 * does this at startup; this CLI did not, and the result was a preflight
	 * that reported "this token authenticates against NEITHER installation"
	 * while `curl -4` with the same token succeeded. A check that produces a
	 * false alarm about a credential is worse than no check — it sends you
	 * looking for the wrong problem.
	 */
	try {
		await pinAndVerify("app.bitgo.com");
	} catch (e) {
		console.error(
			`WARNING: could not verify IPv4 egress (${
				e instanceof Error ? e.message : String(e)
			}). Custody checks below may report a false 401.`,
		);
	}

	const dbPath = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";
	const configPath = process.env.EXCHANGE_CONFIG ?? "/etc/blockle/exchange.json";
	const db = new Database(dbPath);
	db.pragma("busy_timeout = 5000");
	const ledger = new Ledger(db);

	// The custodian is optional ONLY in the sense that its absence is reported
	// as a failed check rather than a crash. It is never treated as a pass.
	let holdings: PreflightDeps["holdings"];
	let verify: PreflightDeps["verifyCustodyEnv"];
	try {
		const bg = BitGoHoldings.fromEnv();
		verify = async () => {
			const v = await bg.verifyEnvironment();
			return { ok: v.ok, detail: v.detail };
		};
		holdings = {
			name: bg.name,
			// Built from the per-chain holdings call, so a chain the custodian
			// does not know about is ABSENT from the map rather than present
			// with a zero — the preflight distinguishes "no wallet" from "an
			// empty wallet", and only the first is a blocker.
			byCustodyId: async () => {
				const out = new Map<string, bigint>();
				for (const id of CUSTODY_IDS) {
					try {
						out.set(id, await bg.holdings(id));
					} catch {
						// Leave it absent. Reported as a missing wallet.
					}
				}
				return out;
			},
		};
	} catch (e) {
		console.error(
			`note: no custodian configured (${e instanceof Error ? e.message : String(e)})`,
		);
	}

	const deps: PreflightDeps = {
		db,
		ledger,
		configPath,
		expectCustodyIds: CUSTODY_IDS,
		haltFile: process.env.HALT_FILE ?? "/run/blockle/exchange-halts.json",
		...(holdings === undefined ? {} : { holdings }),
		...(verify === undefined ? {} : { verifyCustodyEnv: verify }),
		env: process.env,
	};

	if (process.argv.includes("--flip")) {
		const { flipped, report } = await flipLive(deps);
		process.stdout.write(format(report));
		if (flipped) {
			process.stdout.write(
				`\n  FLIPPED. ${configPath} now has mainnetEnabled=true.\n` +
					"  Restart exchange-public-api for it to take effect.\n\n",
			);
			process.exit(0);
		}
		process.stdout.write("\n  NOT FLIPPED — see the failures above.\n\n");
		process.exit(2);
	}

	const report = await preflight(deps);
	process.stdout.write(format(report));
	// Exit 2 for "not ready" so a deploy script can gate on it, and 0 only when
	// the venue could genuinely go live.
	process.exit(report.ready ? 0 : 2);
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
