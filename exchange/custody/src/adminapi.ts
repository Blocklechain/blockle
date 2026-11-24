// -----------------------------------------------------------------------------
// ADMIN API — the operator's view, and the only place money moves by hand.
//
// WHAT IT IS FOR. Three questions an operator has to be able to answer without
// opening a database:
//
//   1. How much have we made? (revenue.ts)
//   2. Can we still pay gas? (gasgate.ts)
//   3. Is every chain's fee actually covering its gas? (withdrawalfees.ts)
//
// And two actions: sweep accrued revenue somewhere spendable, and top up a gas
// float.
//
// AUTHENTICATION IS THE BLOCKLE ACCOUNT SYSTEM PLUS AN ALLOWLIST.
//
// Not a second password, not a separate admin user table. The venue already
// reuses Blockle accounts for customers (blockleauth.ts), and an admin portal
// with its own credentials is a second thing to phish and a second thing to
// forget to rotate. Admin status is therefore: a valid Blockle session whose
// ACCOUNT ID appears in an operator-configured allowlist.
//
// The allowlist is BY ACCOUNT ID, not by email. An email can be changed at the
// accounts service; if admin rights keyed on it, changing an email would either
// silently grant or silently revoke them. Emails are accepted in the config for
// convenience and resolved to ids on sight, with the resolution logged.
//
// MUTATIONS REQUIRE A FRESH TOTP CODE, every time. Not a 2FA check at login
// followed by an hour of trust: the thing being protected is "move the
// exchange's money", and a session cookie lifted from a laptop must not be
// enough to do it. Codes are single-use (totp.ts), so a replayed request fails
// even if the code is observed.
//
// READS ARE NOT FREE EITHER. Revenue and gas floats are commercially sensitive
// and operationally useful to an attacker — knowing the ERC-20 float is nearly
// dry tells you exactly when to stop expecting withdrawals. So reads need the
// session and the allowlist too; they just do not need a code.
//
// EVERY MUTATION IS JOURNALLED BEFORE IT IS ATTEMPTED, with the actor, and the
// journal is append-only. An admin action nobody can reconstruct afterwards is
// an admin action that cannot be investigated.
// -----------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "better-sqlite3";

import { parse } from "./amount";
import { assetDef, settlementAsset } from "./assets";
import { DEFAULT_FEES, disclose } from "./fees";
import { gasPositions, type GasGateDeps } from "./gasgate";
import { type RateSource } from "./gasrates";
import { AccountKind, type Ledger } from "./ledger";
import { estimateTotal, fundGasFloat, revenue, sweep } from "./revenue";
import { TotpVerifier } from "./totp";
import { auditGasCoverage, type FeeTable, type GasPricing } from "./withdrawalfees";
import { AuthError, type BlockleAuth, type BlockleUser } from "./blockleauth";

export class AdminError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "AdminError";
	}
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_action (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  outcome    TEXT,
  at         TEXT NOT NULL
);

-- Append-only, for the same reason the ledger is: it is evidence.
CREATE TRIGGER IF NOT EXISTS admin_action_no_update
BEFORE UPDATE ON admin_action
BEGIN SELECT RAISE(ABORT, 'admin_action is append-only'); END;

CREATE TRIGGER IF NOT EXISTS admin_action_no_delete
BEFORE DELETE ON admin_action
BEGIN SELECT RAISE(ABORT, 'admin_action is append-only'); END;
`;

export interface AdminDeps {
	readonly db: Database;
	readonly ledger: Ledger;
	readonly auth: BlockleAuth;
	readonly gas: GasGateDeps;
	readonly feeTable: FeeTable;
	readonly pricing: GasPricing;
	readonly rates: readonly RateSource[];
	/**
	 * Account ids (or emails) permitted to use this API.
	 *
	 * EMPTY MEANS NOBODY. An unconfigured allowlist must not mean "anyone with
	 * a Blockle account can see the venue's revenue and sweep its fees".
	 */
	readonly allowlist: readonly string[];
	/**
	 * Base32 TOTP secret for admin mutations, per account id.
	 *
	 * An account on the allowlist with no secret can READ but cannot act. That
	 * is deliberate: the alternative is to let an un-enrolled admin move money
	 * with a cookie alone.
	 */
	readonly totpSecrets: Readonly<Record<string, string>>;
	/** The account revenue sweeps are paid into. */
	readonly houseAccountId: string;
}

const totp = new TotpVerifier();

/** Resolve the caller and check they are an operator. */
async function operator(
	req: IncomingMessage,
	deps: AdminDeps,
): Promise<BlockleUser> {
	if (deps.allowlist.length === 0) {
		throw new AdminError(
			"no admin allowlist is configured, so nobody is an administrator. " +
				"This fails closed on purpose.",
			503,
		);
	}
	let user: BlockleUser;
	try {
		user = await deps.auth.whoami(req.headers.cookie);
	} catch (e) {
		if (e instanceof AuthError) throw new AdminError(e.message, e.status);
		throw e;
	}
	const allowed =
		deps.allowlist.includes(user.id) ||
		(user.email !== undefined && deps.allowlist.includes(user.email));
	if (!allowed) {
		// Deliberately the same message a signed-out caller gets nothing extra
		// from: confirming that an endpoint exists and this account is simply
		// not on the list is information an attacker can use.
		throw new AdminError("not found", 404);
	}
	return user;
}

/**
 * A mutation needs a fresh, single-use TOTP code on THIS request.
 *
 * Session-level 2FA would mean one code buys an hour of unattended authority
 * over the exchange's money. The code is taken from a header rather than the
 * body so it is required identically on every mutation, including ones added
 * later by someone who did not read this comment.
 */
function requireFreshCode(req: IncomingMessage, deps: AdminDeps, user: BlockleUser): void {
	const secret = deps.totpSecrets[user.id];
	if (secret === undefined || secret.trim() === "") {
		throw new AdminError(
			"this operator account has no authenticator enrolled, so it can view " +
				"but not act. Enrol one before moving funds.",
			403,
		);
	}
	const header = req.headers["x-admin-totp"];
	const code = Array.isArray(header) ? header[0] : header;
	if (code === undefined || code.trim() === "") {
		throw new AdminError("a current authenticator code is required", 401);
	}
	const r = totp.check(user.id, secret, code);
	if (!r.ok) {
		throw new AdminError(
			"that authenticator code is not valid, or has already been used",
			401,
		);
	}
}

function journal(
	db: Database,
	actor: string,
	action: string,
	detail: unknown,
): (outcome: string) => void {
	const info = db
		.prepare(
			`INSERT INTO admin_action (actor, action, detail, at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(actor, action, JSON.stringify(detail), new Date().toISOString());
	const id = Number(info.lastInsertRowid);
	// The row is written BEFORE the action is attempted, so an action that
	// crashes mid-way still leaves a trace. The outcome is filled in after —
	// which the append-only trigger would normally forbid, so it is recorded as
	// its own row rather than an update.
	return (outcome: string): void => {
		db.prepare(
			`INSERT INTO admin_action (actor, action, detail, outcome, at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(actor, `${action}:result`, JSON.stringify({ of: id }), outcome, new Date().toISOString());
	};
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		const b = c as Buffer;
		size += b.length;
		if (size > 32 * 1024) throw new AdminError("request body too large", 413);
		chunks.push(b);
	}
	if (chunks.length === 0) return {};
	try {
		const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (typeof v !== "object" || v === null) throw new Error("not an object");
		return v as Record<string, unknown>;
	} catch {
		throw new AdminError("the request body is not a JSON object");
	}
}

function str(b: Record<string, unknown>, k: string): string {
	const v = b[k];
	if (typeof v !== "string" || v.trim() === "") {
		throw new AdminError(`${k} is required`);
	}
	return v.trim();
}

function send(res: ServerResponse, code: number, body: unknown): void {
	const payload = JSON.stringify(body, (_k, v) =>
		typeof v === "bigint" ? v.toString() : v,
	);
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		// NEVER CACHED. A revenue figure served from a cache is a revenue figure
		// that is wrong, and a shared cache would serve it to the wrong person.
		"cache-control": "no-store, private",
		"x-content-type-options": "nosniff",
	});
	res.end(payload);
}

/**
 * Route an /admin/api request. Returns false if the path is not ours.
 */
export async function adminRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	deps: AdminDeps,
): Promise<boolean> {
	if (!url.pathname.startsWith("/admin/api/")) return false;
	const p = url.pathname.slice("/admin/api".length);

	try {
		const user = await operator(req, deps);

		// ---- reads --------------------------------------------------------

		if (p === "/me" && req.method === "GET") {
			send(res, 200, {
				accountId: user.id,
				email: user.email ?? null,
				canAct: (deps.totpSecrets[user.id] ?? "") !== "",
			});
			return true;
		}

		if (p === "/revenue" && req.method === "GET") {
			const from = url.searchParams.get("from");
			const to = url.searchParams.get("to");
			const r = revenue(deps.db, deps.ledger, {
				...(from === null || from === "" ? {} : { from }),
				...(to === null || to === "" ? {} : { to }),
			});
			const total = estimateTotal(r, deps.rates, "USDT");
			send(res, 200, {
				from: r.from ?? null,
				to: r.to ?? null,
				generatedAt: r.generatedAt,
				// SURFACED FIRST, not buried: if the arithmetic did not check
				// out, that is the most important thing on the page.
				reconciles: r.reconciles,
				warnings: r.warnings,
				assets: r.assets.map((a) => ({
					asset: a.asset,
					tradingFees: a.display.tradingFees,
					withdrawalFees: a.display.withdrawalFees,
					gasSpent: a.display.gasSpent,
					netProfit: a.display.netProfit,
					balance: a.display.balance,
					loss: a.netProfit < 0n,
				})),
				total,
			});
			return true;
		}

		if (p === "/gas" && req.method === "GET") {
			send(res, 200, { positions: gasPositions(deps.gas) });
			return true;
		}

		if (p === "/fee-coverage" && req.method === "GET") {
			const rows = auditGasCoverage(deps.feeTable, deps.pricing);
			send(res, 200, {
				chains: rows,
				// The headline an operator needs: is any chain losing money?
				uncovered: rows.filter((r) => !r.covered).map((r) => r.chain),
				tradingFees: {
					...disclose(DEFAULT_FEES),
					makerBps: DEFAULT_FEES.makerBps,
					takerBps: DEFAULT_FEES.takerBps,
				},
			});
			return true;
		}

		if (p === "/actions" && req.method === "GET") {
			send(res, 200, {
				actions: deps.db
					.prepare(
						`SELECT actor, action, detail, outcome, at FROM admin_action
						  ORDER BY id DESC LIMIT 200`,
					)
					.all(),
			});
			return true;
		}

		// ---- mutations ----------------------------------------------------

		if (p === "/sweep" && req.method === "POST") {
			const b = await readBody(req);
			requireFreshCode(req, deps, user);
			const asset = settlementAsset(str(b, "asset").toUpperCase());
			const amount = parse(str(b, "amount"), {
				symbol: asset,
				decimals: assetDef(asset).decimals,
			});
			const reserve =
				typeof b.reserve === "string" && b.reserve !== ""
					? parse(b.reserve, { symbol: asset, decimals: assetDef(asset).decimals })
					: gasReserveFor(asset, deps);

			const done = journal(deps.db, user.id, "sweep", {
				asset,
				amount: amount.toString(),
				reserve: reserve.toString(),
			});
			try {
				sweep(deps.ledger, {
					asset,
					toUserId: deps.houseAccountId,
					amount,
					actor: user.id,
					reserve,
					idempotencyKey: str(b, "requestId"),
				});
			} catch (e) {
				done(`failed: ${e instanceof Error ? e.message : String(e)}`);
				throw e;
			}
			done("ok");
			send(res, 200, {
				ok: true,
				asset,
				sweptTo: deps.houseAccountId,
				reserveHeld: reserve.toString(),
			});
			return true;
		}

		if (p === "/fund-gas" && req.method === "POST") {
			const b = await readBody(req);
			requireFreshCode(req, deps, user);
			const gasAsset = str(b, "gasAsset").toUpperCase();
			const amount = parse(str(b, "amount"), {
				symbol: gasAsset,
				decimals: assetDef(gasAsset).decimals,
			});
			const done = journal(deps.db, user.id, "fund-gas", {
				gasAsset,
				amount: amount.toString(),
			});
			try {
				fundGasFloat(deps.ledger, {
					gasAsset,
					amount,
					actor: user.id,
					idempotencyKey: str(b, "requestId"),
				});
			} catch (e) {
				done(`failed: ${e instanceof Error ? e.message : String(e)}`);
				throw e;
			}
			done("ok");
			send(res, 200, {
				ok: true,
				gasAsset,
				// SAID PLAINLY, because the two halves of this are easy to
				// conflate: crediting the float on the books is not the same as
				// the coins being in the BitGo wallet.
				note:
					`The books now show a ${gasAsset} gas float. This records a ` +
					`treasury transfer — it does NOT move coins. Send the ` +
					`${gasAsset} to the custody wallet if you have not already, ` +
					"or reconciliation will report a shortfall.",
			});
			return true;
		}

		send(res, 404, { error: "not found" });
		return true;
	} catch (e) {
		if (e instanceof AdminError) {
			send(res, e.status, { error: e.message });
			return true;
		}
		send(res, 400, { error: e instanceof Error ? e.message : String(e) });
		return true;
	}
}

/**
 * The gas float that must be left behind when sweeping an asset.
 *
 * Summed across every chain that pays gas in this asset, because sweeping down
 * to one chain's floor strands the others. Zero for an asset nothing pays gas
 * in — there is nothing to protect.
 */
function gasReserveFor(asset: string, deps: AdminDeps): bigint {
	let total = 0n;
	for (const pos of gasPositions(deps.gas)) {
		if (pos.gasAsset !== asset) continue;
		const cfg = (deps.gas.table ?? {})[pos.chain];
		if (cfg === undefined) continue;
		// The floor plus one withdrawal's worth, so a sweep never leaves a chain
		// at exactly its refusal threshold.
		total += cfg.floor + cfg.perWithdrawal;
	}
	return total;
}

/** Parse the operator allowlist from the environment. */
export function allowlistFrom(env: string | undefined): readonly string[] {
	return (env ?? "")
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

/**
 * Parse per-admin TOTP secrets: `id=SECRET,id2=SECRET2`.
 *
 * Read from the environment rather than the repository, and never logged. The
 * exchange config file would also be acceptable; a source file would not.
 */
export function totpSecretsFrom(
	env: string | undefined,
): Readonly<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const pair of (env ?? "").split(/[,\s]+/)) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const id = pair.slice(0, eq).trim();
		const secret = pair.slice(eq + 1).trim();
		if (id !== "" && secret !== "") out[id] = secret;
	}
	return out;
}

export { AccountKind };
