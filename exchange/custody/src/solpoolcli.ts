#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Load pre-derived SOLANA deposit addresses into the exchange.
//
//     # on the SIGNER host (the one with the seed, no inbound network):
//     blockle-sol-derive --from 0 --count 1000 --json > /tmp/sol-batch.json
//     sha256sum /tmp/sol-batch.json
//
//     # on the EXCHANGE host:
//     node dist/src/solpoolcli.js --from /tmp/sol-batch.json
//     node dist/src/solpoolcli.js --status
//     node dist/src/solpoolcli.js --stranded
//
// TWO HOSTS ON PURPOSE, AND ON SOLANA THERE IS NO ALTERNATIVE. ed25519 under
// SLIP-0010 derives children from the PRIVATE key — the HMAC input is
// `0x00 || privateKey || index` and every path segment is hardened, so there
// is no watch-only derivation to fall back on. Deriving a Solana address IS
// holding the authority to spend it. The exchange API is the most exposed
// process in this system and must never hold that, so derivation happens where
// the seed is and only the resulting addresses travel. See soladdresspool.ts.
//
// THE OPERATOR COMPARES THE SHA-256 BY EYE BEFORE LOADING. The file crosses a
// trust boundary; the hash is the only thing that makes "the same file arrived"
// a checkable statement. A corrupted entry that still decodes to a valid
// 32-byte curve point would be an address nobody holds the key to, and the
// load-time validation cannot catch that — only the hash can.
//
// The file is the exact JSON the deriver emits — no reformatting step for an
// operator to get wrong at 2am.
//
// AND LOADING A BATCH DOES NOT OPEN THE RAIL. It is the cheap half, and it is
// the half that looks like success, so every command here prints what is still
// outstanding. See solrail.ts.
// -----------------------------------------------------------------------------

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import { SolAddressPool, type DerivedSolAddress } from "./soladdresspool";
import {
	SOL_MINIMUM_DEPOSIT_LAMPORTS,
	SOL_SWEEP_DUST_FLOOR_LAMPORTS,
	formatSol,
	strandedAccounts,
} from "./solconsolidation";
import { formatSolRailReadiness, solRailReadiness } from "./solrail";

const DB_PATH = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Accept the deriver's envelope or a bare array, because both are things a
 * person reasonably ends up with — identical to blockpoolcli, deliberately.
 */
function parseBatch(raw: string): DerivedSolAddress[] {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`not JSON (${e instanceof Error ? e.message : String(e)}). Produce the ` +
				"file on the signer host with the SOL deriver's --json output.",
		);
	}
	const list = Array.isArray(doc) ? doc : (doc as { addresses?: unknown }).addresses;
	if (!Array.isArray(list)) {
		throw new Error(
			'expected {"addresses":[{"index":0,"address":"<base58>"}]} or a bare array',
		);
	}
	return list.map((row, i) => {
		const r = row as { index?: unknown; address?: unknown };
		if (typeof r.address !== "string" || typeof r.index !== "number") {
			throw new Error(`entry ${i} needs a numeric "index" and a string "address"`);
		}
		return { index: r.index, address: r.address };
	});
}

/** The readiness block every command prints, so nobody has to ask separately. */
function printReadiness(pool: SolAddressPool): void {
	const s = pool.status();
	const readiness = solRailReadiness({
		poolStatus: { total: s.total, free: s.free },
		endpointUrl: process.env.CHAIN_SOL_URL ?? "",
		// The CLI reads the configured destination rather than constructing a
		// sweeper: loading a batch must work on a box where the rail is not set
		// up yet, which is the box where it is loaded FIRST.
		hotAddress: process.env.CHAIN_SOL_HOT_ADDRESS ?? "",
	});
	console.log("");
	console.log(formatSolRailReadiness(readiness));
}

function main(): void {
	const db = new Database(DB_PATH);
	// The live API holds the same file. Without this, a load during a request
	// burst fails on SQLITE_BUSY and an operator concludes the batch was bad.
	db.pragma("busy_timeout = 5000");
	const pool = new SolAddressPool(db);

	if (process.argv.includes("--stranded")) {
		/*
		 * ACCOUNTS WE WILL NOT SWEEP, WHICH IS A REPORT AND NOT AN ERROR LOG.
		 *
		 * A sub-floor deposit costs more to move than it is worth. Nothing is
		 * ever submitted for these accounts, so there is no retry to inspect —
		 * what an operator needs is the list, the total, and the fact that it is
		 * self-healing: the customer can top the same address up and the next
		 * pass sweeps the combined balance.
		 */
		const rows = strandedAccounts(db, { includeResolved: true });
		const open = rows.filter((r) => r.resolvedAt === null);
		console.log(`SOL accounts below the dust floor (${DB_PATH})`);
		console.log(
			`  floor:   ${formatSol(SOL_SWEEP_DUST_FLOOR_LAMPORTS)} SOL ` +
				`(published minimum deposit ${formatSol(SOL_MINIMUM_DEPOSIT_LAMPORTS)} SOL)`,
		);
		console.log(`  stranded: ${open.length}`);
		console.log(
			`  total:    ${formatSol(open.reduce((t, r) => t + r.lamports, 0n))} SOL`,
		);
		for (const r of rows) {
			console.log(
				`  idx ${r.index}  ${r.address}  ${formatSol(r.lamports)} SOL  ` +
					`seen ${r.observations}x  ${r.resolvedAt === null ? "stranded" : `resolved ${r.resolvedAt}`}`,
			);
		}
		if (rows.length === 0) {
			console.log("  (nothing recorded — no plan has run, or none was below the floor)");
		}
		return;
	}

	if (process.argv.includes("--status") || process.argv.length <= 2) {
		const s = pool.status();
		console.log(`SOL deposit address pool (${DB_PATH})`);
		console.log(`  loaded: ${s.total}`);
		console.log(`  issued: ${s.issued}`);
		console.log(`  free:   ${s.free}${s.low ? "   <= LOW, refill" : ""}`);
		if (s.daysOfRunway !== undefined) {
			console.log(
				`  runway: ${s.daysOfRunway.toFixed(1)} days at ` +
					`${s.issuedPerDay?.toFixed(1)}/day (trailing 7d)` +
					(s.daysOfRunway < 7 ? "   <= REFILL NOW, this needs the signer host" : ""),
			);
		}
		if (s.total === 0) {
			console.log(
				"\nSOL deposits are closed until a batch is loaded. On the signer " +
					"host:\n  blockle-sol-derive --from 0 --count 1000 --json > batch.json\n" +
					"  sha256sum batch.json\nthen here:\n" +
					"  node dist/src/solpoolcli.js --from batch.json",
			);
		}
		printReadiness(pool);
		return;
	}

	const from = arg("from");
	if (from === undefined) {
		console.error("usage: solpoolcli --from <batch.json> | --status | --stranded");
		process.exit(64); // EX_USAGE
	}

	const entries = parseBatch(readFileSync(from, "utf8"));
	const r = pool.load(entries);
	const s = pool.status();
	console.log(
		`loaded ${r.added} new address${r.added === 1 ? "" : "es"}` +
			(r.alreadyPresent > 0 ? `, ${r.alreadyPresent} already present` : "") +
			`. Pool: ${s.free} free of ${s.total}.`,
	);
	printReadiness(pool);
}

try {
	main();
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
