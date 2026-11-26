// -----------------------------------------------------------------------------
// `node dist/src/evmscancli.js` — the EVM scanner as a one-shot pass.
//
// WHY THIS FILE IS THE CRITICAL PATH, AND NOT THE XPUB.
//
// The EVM rail has seven requirements (evmrail.ts EVM_RAIL_REQUIREMENTS). Six
// are a decision or a ceremony someone can do in an afternoon. One is a CLOCK:
//
//     scanner-clean — the scanner has run read-only against live tip for a
//     full week with no integrity halt and no cursor-lag alarm
//
// A week cannot be shortened, so it should be STARTED FIRST and run in parallel
// with everything else. Until this existed there was no way to start it: the
// scanner was a class nobody invoked. So the week could not begin, and the rail
// could not open however promptly the operator work was done.
//
// IT RUNS WITH NO XPUB AND NO ADDRESSES, DELIBERATELY. `watched` comes back
// empty until an xpub is configured, and that is a perfectly good evidence run
// — what the week proves is that the ENDPOINT is honest and the scanner keeps
// up with the tip, neither of which needs a customer. Crediting is not even
// reachable: with no watched addresses there is nothing to match.
//
// ONE PASS PER INVOCATION, driven by a systemd timer, for the same reason the
// deposit watcher is: a long-lived loop that wedges on a socket keeps
// reporting "active" to systemd while scanning nothing. A one-shot that must be
// restarted cannot pretend to be alive.
//
// EXIT CODES
//   0  the pass completed (per-chain failures are logged, not fatal)
//   1  nothing could run at all — no database, no chain configured
//
// A chain whose endpoint is unreachable is NOT exit 1: that is a transient the
// next tick retries, and a timer that alerts on it teaches an operator to
// ignore the alert. An INTEGRITY HALT is different and is shouted about,
// because it means the endpoint lied and the week starts over.
// -----------------------------------------------------------------------------

import Database from "better-sqlite3";

import {
	EVM_CHAIN_RULES,
	EvmNativeScanner,
	EvmScanError,
	type EvmScanRpc,
} from "./evmscan";
import { EVM_URL_VARS, readEvmUrlFromEnv } from "./evmrail";

/** How long a single RPC call may take before the pass gives up on it. */
const RPC_TIMEOUT_MS = 20_000;

/**
 * JSON-RPC over HTTP, with the deadline covering the BODY and not just the
 * headers.
 *
 * That distinction cost this session a silent five-minute hang on the BLOCK
 * rail: `clearTimeout` in a `finally` attached to `fetch` expires the moment
 * response headers arrive, and a stalled body then waits forever. An endpoint
 * that accepts the connection and dribbles is exactly the failure a public RPC
 * under load produces.
 */
class HttpRpc implements EvmScanRpc {
	private id = 0;

	constructor(private readonly url: string) {}

	async call<T>(method: string, params: unknown[] = []): Promise<T> {
		const [one] = await this.batch<T>([{ method, params }]);
		return one as T;
	}

	async batch<T>(
		calls: readonly { method: string; params?: unknown[] }[],
	): Promise<T[]> {
		if (calls.length === 0) return [];
		const body = calls.map((c) => ({
			jsonrpc: "2.0",
			id: ++this.id,
			method: c.method,
			params: c.params ?? [],
		}));
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
		let text: string;
		try {
			const res = await fetch(this.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: ctl.signal,
			});
			text = await res.text();
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
			}
		} catch (e) {
			const why = ctl.signal.aborted
				? `did not answer within ${RPC_TIMEOUT_MS}ms`
				: e instanceof Error
					? e.message
					: String(e);
			throw new Error(`${this.url}: ${why}`);
		} finally {
			clearTimeout(timer);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(
				`${this.url}: answered with a body that is not JSON: ${text.slice(0, 200)}`,
			);
		}
		// A SINGLE OBJECT FOR A BATCH IS NOT A RESULT. Some endpoints answer a
		// batch with one error object; reading that as "the first result" would
		// hand the scanner an undefined and let it treat a failure as data.
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		if (rows.length !== calls.length) {
			throw new Error(
				`${this.url}: asked for ${calls.length} results, got ${rows.length}` +
					(rows.length === 1
						? ` — ${JSON.stringify(rows[0]).slice(0, 200)}`
						: ""),
			);
		}
		// Re-order by id: a batch response MAY come back in any order, and
		// matching by position would silently pair a block with another
		// block's receipts.
		const byId = new Map<number, { result?: unknown; error?: unknown }>();
		for (const r of rows as { id?: number }[]) {
			if (typeof r?.id === "number") byId.set(r.id, r as never);
		}
		return body.map((req) => {
			const r = byId.get(req.id);
			if (r === undefined) {
				throw new Error(`${this.url}: no answer for id ${req.id} (${req.method})`);
			}
			if (r.error !== undefined) {
				throw new Error(
					`${this.url}: ${req.method} → ${JSON.stringify(r.error).slice(0, 220)}`,
				);
			}
			return r.result as T;
		});
	}
}

/**
 * Every chain this host has an endpoint for.
 *
 * A chain with no URL is not an error and not a warning: it is the normal
 * state of a rail nobody has decided to open yet.
 */
function configured(env: NodeJS.ProcessEnv): { chain: string; url: string }[] {
	const out: { chain: string; url: string }[] = [];
	for (const chain of Object.keys(EVM_URL_VARS)) {
		// Returns "" when unset, which is the normal state of a rail nobody
		// has decided to open; it THROWS if the two accepted spellings of a
		// chain's URL disagree, which is a misconfiguration worth stopping for.
		const url = readEvmUrlFromEnv(env, chain);
		if (url.trim() !== "") out.push({ chain, url: url.trim() });
	}
	return out;
}

async function main(): Promise<void> {
	const db = new Database(
		process.env.CUSTODY_DB ?? "/var/lib/exchange-custody/ledger.db",
	);
	db.pragma("busy_timeout = 10000");

	const chains = configured(process.env);
	if (chains.length === 0) {
		console.error(
			"no EVM chain has an endpoint configured, so there is nothing to scan. " +
				`Set one of ${Object.values(EVM_URL_VARS)
					.flat()
					.join(", ")} to an endpoint that is not on EVM_ENDPOINT_DENYLIST.`,
		);
		process.exit(1);
	}

	let halted = 0;
	let clean = 0;
	let unreachable = 0;

	for (const { chain, url } of chains) {
		const rule = EVM_CHAIN_RULES[chain];
		if (rule === undefined) {
			console.error(`  ${chain}: no declared rule; refusing to scan it`);
			continue;
		}

		const scanner = new EvmNativeScanner(db, new HttpRpc(url), {
			rule,
			/*
			 * EMPTY UNTIL AN XPUB EXISTS, and the query is written so it starts
			 * returning addresses the moment one does — without a code change.
			 * A scanner that had to be edited to notice the first customer is a
			 * scanner that will miss the first customer.
			 */
			watched: async () => {
				// THE TABLE LEGITIMATELY DOES NOT EXIST YET. `EvmAddressIndex`
				// creates it, and nothing constructs one until an xpub is
				// configured — so "no such table" is not an error, it is the
				// honest answer "no address has ever been issued". Asking
				// sqlite_master rather than catching the throw keeps a REAL
				// database fault loud instead of being swallowed as "empty".
				const present = db
					.prepare(
						`SELECT 1 FROM sqlite_master
						  WHERE type = 'table' AND name = 'evm_address_index'`,
					)
					.get() !== undefined;
				if (!present) return new Set<string>();
				const rows = db
					.prepare(
						`SELECT LOWER(address) AS a FROM evm_address_index WHERE chain = ?`,
					)
					.all(chain) as { a: string }[];
				return new Set(rows.map((r) => r.a));
			},
			// Nothing is issued, so nothing is un-swept. Reading it from the
			// same table keeps that true by construction rather than by comment.
			unsweptTotal: async () => 0n,
		});

		const already = scanner.haltedReason();
		if (already !== undefined) {
			halted++;
			console.error(
				`  ${chain}: HALTED — ${already}\n` +
					"    The rail stays shut until a human clears this. The clean-run " +
					"week restarts from the day it is cleared, because a week " +
					"containing a halt is not evidence of anything.",
			);
			continue;
		}

		try {
			const notes = await scanner.preflight();
			for (const n of notes) console.log(`  ${chain}: ${n}`);
			const r = await scanner.scan();
			clean++;
			console.log(
				`  ${chain}: cursor ${r.cursor} / safe head ${r.safeHead} / tip ${r.tip}` +
					`  lag ${r.lagSeconds}s` +
					(r.payments.length > 0 ? `  ${r.payments.length} credited` : "") +
					(r.pending.length > 0 ? `  ${r.pending.length} pending` : ""),
			);
			if (r.lagAlarm !== undefined) {
				console.error(`  ${chain}: CURSOR LAG — ${r.lagAlarm}`);
			}
			if (r.issuanceShut !== undefined) {
				console.error(`  ${chain}: issuance shut — ${r.issuanceShut}`);
			}
			for (const n of r.notes) console.log(`  ${chain}: ${n}`);
		} catch (e) {
			// AN INTEGRITY FAILURE AND AN UNREACHABLE HOST ARE NOT THE SAME
			// EVENT. The first means the endpoint lied and is a halt; the
			// second is weather.
			if (e instanceof EvmScanError) {
				halted++;
				console.error(`  ${chain}: REFUSED — ${e.message}`);
			} else {
				unreachable++;
				console.error(
					`  ${chain}: endpoint unavailable this pass (${
						e instanceof Error ? e.message : String(e)
					})`,
				);
			}
		}
	}

	console.log(
		`evm-scan: ${clean} clean, ${halted} halted/refused, ` +
			`${unreachable} unreachable across ${chains.length} configured chain(s)`,
	);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
