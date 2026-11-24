// -----------------------------------------------------------------------------
// THE DECLARED TESTNET TREASURY — and keeping it honest when the faucet moves.
//
// On testnet there is no custodian to ask, so reconciliation compares the books
// against a FILE that states what the venue holds. That is a fiction, and it is
// a useful one: it proves the books are internally consistent and that the
// reconciler works, which is the whole point of a dry run.
//
// THE BUG THIS FIXES.
//
// The faucet credits a customer's balance AND custody — it has to, or the
// ledger's invariant fails. But the declared file never heard about it. So
// every faucet click moved the books further from the declaration, and the
// reconciler — correctly — called the difference a SHORTFALL and halted that
// asset's withdrawals. Permanently, because nothing ever un-credits it.
//
// On this box that had happened to BLOCK: the books said 15,000 held, the file
// said 5,000, and the reconciler had been reporting a halt on every pass for a
// day. Not a false alarm in the reconciler — a true statement about an
// inconsistency the faucet created.
//
// THE ORDER OF OPERATIONS IS THE WHOLE DESIGN.
//
// The declaration is bumped BEFORE the credit is posted, never after:
//
//   bump then post, and a failed post leaves the file OVERSTATING holdings —
//     a surplus, which reconciliation treats as benign;
//   post then bump, and a failed bump leaves the file UNDERSTATING them —
//     a shortfall, which halts the asset.
//
// Same asymmetry the reconciler itself is built on: an error in the direction
// of "we appear to hold more than we do" costs a log line, and an error the
// other way stops customers being paid.
// -----------------------------------------------------------------------------

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class TreasuryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TreasuryError";
	}
}

/** Read the declaration. A missing file is an empty one, not an error. */
export function readDeclared(path: string): Record<string, bigint> {
	if (!existsSync(path)) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new TreasuryError(
			`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
				"Refusing to guess at it: this file is what reconciliation compares " +
				"the books against.",
		);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new TreasuryError(`${path} must be a JSON object of asset -> amount`);
	}
	const out: Record<string, bigint> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		// Strings only. A JSON number cannot hold an 18-decimal balance, and a
		// treasury declaration that rounds is not a declaration.
		if (typeof v !== "string" || !/^\d+$/.test(v)) {
			throw new TreasuryError(
				`${path}: ${k} must be a decimal string of base units, got ` +
					`${JSON.stringify(v)}`,
			);
		}
		out[k] = BigInt(v);
	}
	return out;
}

/**
 * Add to one asset's declared holdings, atomically.
 *
 * Called by the faucet BEFORE it credits — see the header for why that order
 * is the safe one.
 */
export function bumpDeclared(path: string, custodyId: string, delta: bigint): bigint {
	if (delta <= 0n) throw new TreasuryError("a treasury bump must be positive");
	const current = readDeclared(path);
	const next = (current[custodyId] ?? 0n) + delta;
	current[custodyId] = next;

	const body = JSON.stringify(
		Object.fromEntries(
			Object.entries(current)
				// Sorted, so a diff of this file shows what changed rather than
				// what moved.
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, v.toString()]),
		),
		null,
		1,
	);
	// Temp file then rename: a reader sees the old file or the new one, never
	// a half-written one that would fail to parse and read as "no holdings".
	const tmp = join(dirname(path), `.treasury.${process.pid}.tmp`);
	writeFileSync(tmp, `${body}\n`, { mode: 0o644 });
	renameSync(tmp, path);
	return next;
}
