#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Load pre-derived BLOCK deposit addresses into the exchange.
//
//     # on the WALLET host (the one with the seed):
//     blockle-chain --json wallet derive --count 1000 > /tmp/batch.json
//
//     # on the EXCHANGE host:
//     node dist/src/blockpoolcli.js --from /tmp/batch.json
//     node dist/src/blockpoolcli.js --status
//
// TWO HOSTS ON PURPOSE. Deriving a BLOCK address requires the master seed,
// which can spend every address it derives; the exchange API is the most
// exposed process here and must never hold it. So the derivation happens
// where the wallet is, and only the resulting addresses travel. See
// blockaddresspool.ts.
//
// The file is the exact JSON the wallet CLI emits — no reformatting step for
// an operator to get wrong at 2am.
// -----------------------------------------------------------------------------

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import { BlockAddressPool, type DerivedAddress } from "./blockaddresspool";

const DB_PATH = process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

function parseBatch(raw: string): DerivedAddress[] {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`not JSON (${e instanceof Error ? e.message : String(e)}). Produce the ` +
				"file with `blockle-chain --json wallet derive --count N`.",
		);
	}
	// Accept the wallet's envelope or a bare array, because both are things a
	// person reasonably ends up with.
	const list = Array.isArray(doc)
		? doc
		: (doc as { addresses?: unknown }).addresses;
	if (!Array.isArray(list)) {
		throw new Error(
			'expected {"addresses":[{"index":0,"address":"block1…"}]} or a bare array',
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

function main(): void {
	const db = new Database(DB_PATH);
	db.pragma("busy_timeout = 5000");
	const pool = new BlockAddressPool(db);

	if (process.argv.includes("--status") || process.argv.length <= 2) {
		const s = pool.status();
		console.log(`BLOCK deposit address pool (${DB_PATH})`);
		console.log(`  loaded: ${s.total}`);
		console.log(`  issued: ${s.issued}`);
		console.log(`  free:   ${s.free}${s.low ? "   <= LOW, refill" : ""}`);
		if (s.total === 0) {
			console.log(
				"\nBLOCK deposits are closed until a batch is loaded. On the wallet " +
					"host:\n  blockle-chain --json wallet derive --count 1000 > batch.json\n" +
					"then here:\n  node dist/src/blockpoolcli.js --from batch.json",
			);
		}
		return;
	}

	const from = arg("from");
	if (from === undefined) {
		console.error("usage: blockpoolcli --from <batch.json> | --status");
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
}

try {
	main();
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
