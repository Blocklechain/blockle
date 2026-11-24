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
import { MARKETS } from "./venue";
import { flipLive, format, preflight, type PreflightDeps } from "./golive";
import { Ledger } from "./ledger";

/** Every chain-qualified custody id the venue needs a wallet for. */
const CUSTODY_IDS: readonly string[] = (() => {
	const assets = new Set<string>();
	for (const m of MARKETS) {
		assets.add(settlementAsset(m.base));
		assets.add(settlementAsset(m.quote));
	}
	return [...assets]
		.filter((a) => ASSETS[a] !== undefined)
		.flatMap((a) => custodyIds(a));
})();

async function main(): Promise<void> {
	const dbPath = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";
	const configPath = process.env.EXCHANGE_CONFIG ?? "/etc/blockle/exchange.json";
	const db = new Database(dbPath);
	db.pragma("busy_timeout = 5000");
	const ledger = new Ledger(db);

	// The custodian is optional ONLY in the sense that its absence is reported
	// as a failed check rather than a crash. It is never treated as a pass.
	let holdings: PreflightDeps["holdings"];
	try {
		const bg = BitGoHoldings.fromEnv();
		holdings = {
			name: `bitgo:${process.env.BITGO_ENV ?? "?"}`,
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
		...(holdings === undefined ? {} : { holdings }),
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
