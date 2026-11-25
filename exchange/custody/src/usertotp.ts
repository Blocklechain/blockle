// -----------------------------------------------------------------------------
// CUSTOMER SECOND FACTOR — the one a withdrawal needs.
//
// WHY THIS EXISTS. The admin console has required a fresh, single-use
// authenticator code on every mutation since it was written. Customer
// withdrawals required only a session, which the 2026-11-25 audit flagged as
// the largest gap in the venue's posture: a stolen session cookie or bearer
// token drained an account to any address, auto-approved, bounded only by the
// 24h velocity cap. For a custodial venue that is the whole ballgame — sessions
// leak through shared machines, stolen phones and XSS, and none of those should
// be enough to move money.
//
// THREE RULES, each of which a naive implementation gets wrong:
//
//   1. ENROLMENT IS TWO STEPS. `begin` hands out a secret but does NOT arm it;
//      only `confirm`, with a working code, does. Arming on `begin` would let a
//      user who never actually scanned the QR lock themselves out of their own
//      funds, and would let a half-finished enrolment count as protection.
//
//   2. RE-ENROLMENT NEEDS THE CURRENT CODE. This is the rule that makes the
//      factor worth having. If a confirmed account could re-enrol with only a
//      session, then a stolen session simply replaces the authenticator and
//      withdraws — the second factor would be theatre. So once armed, changing
//      it requires proving you hold the existing one.
//
//   3. A CODE IS SPENT WHEN IT IS USED. TOTP is replayable for its whole ±1-step
//      window, so anyone who observes a code (shoulder-surfing, a proxy, a
//      screenshot) can reuse it for up to ninety seconds. `TotpVerifier` keys
//      its spent-code set by identity, and the identity used here is the
//      account id.
//
// THE SECRET IS STORED IN PLAINTEXT, and it has to be: TOTP is a shared-secret
// scheme, so verification needs the secret itself, exactly like the HMAC signing
// keys in apikeys.ts. That makes the custody database's file permissions part of
// this feature's threat model — see the audit note about ledger.db having been
// world-readable.
// -----------------------------------------------------------------------------

import type { Database } from "better-sqlite3";

import {
	TotpVerifier,
	generateSecret,
	provisioningUri,
} from "./totp";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_totp (
  account_id   TEXT PRIMARY KEY,
  secret       TEXT NOT NULL,
  -- NULL until the customer has proved a code. An unconfirmed row is NOT a
  -- second factor and must never be treated as one.
  confirmed_at TEXT,
  created_at   TEXT NOT NULL
);
`;

export class TwoFactorError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
		this.name = "TwoFactorError";
	}
}

/** Per-customer TOTP enrolment and verification. */
export class UserTotp {
	private readonly verifier: TotpVerifier;

	constructor(
		private readonly db: Database,
		private readonly now: () => number = () => Date.now(),
	) {
		db.exec(SCHEMA);
		this.verifier = new TotpVerifier(this.now);
	}

	private row(accountId: string):
		| { account_id: string; secret: string; confirmed_at: string | null }
		| undefined {
		return this.db
			.prepare(`SELECT account_id, secret, confirmed_at FROM user_totp WHERE account_id = ?`)
			.get(accountId) as
			| { account_id: string; secret: string; confirmed_at: string | null }
			| undefined;
	}

	/** True when this account has a CONFIRMED authenticator. */
	enrolled(accountId: string): boolean {
		const r = this.row(accountId);
		return r !== undefined && r.confirmed_at !== null;
	}

	/**
	 * Start (or restart) enrolment. Returns the secret and an otpauth:// URI.
	 *
	 * Restarting a CONFIRMED enrolment requires a current code — see rule 2 in
	 * the header. Without that check a stolen session could swap the factor.
	 */
	begin(args: {
		accountId: string;
		issuer: string;
		/** Shown in the authenticator app beside the issuer — the account's email. */
		account: string;
		/** Required only when an authenticator is already confirmed. */
		currentCode?: string;
	}): { secret: string; uri: string } {
		const existing = this.row(args.accountId);
		if (existing !== undefined && existing.confirmed_at !== null) {
			if (args.currentCode === undefined || args.currentCode.trim() === "") {
				throw new TwoFactorError(
					"this account already has an authenticator. Replacing it requires a " +
						"current code from the one you have, so that a stolen session " +
						"cannot swap your second factor.",
					401,
				);
			}
			const r = this.verifier.check(args.accountId, existing.secret, args.currentCode);
			if (!r.ok) {
				throw new TwoFactorError(
					"that code is not valid, or has already been used",
					401,
				);
			}
		}
		const secret = generateSecret();
		const stamp = new Date(this.now()).toISOString();
		// REPLACE, and confirmed_at goes back to NULL: a restarted enrolment is
		// unarmed until proved, so a half-finished swap cannot leave the account
		// protected by a secret nobody holds.
		this.db
			.prepare(
				`INSERT INTO user_totp (account_id, secret, confirmed_at, created_at)
				 VALUES (?, ?, NULL, ?)
				 ON CONFLICT(account_id) DO UPDATE SET
				   secret = excluded.secret,
				   confirmed_at = NULL,
				   created_at = excluded.created_at`,
			)
			.run(args.accountId, secret, stamp);
		return {
			secret,
			uri: provisioningUri({ secret, issuer: args.issuer, account: args.account }),
		};
	}

	/** Arm an enrolment by proving a code. */
	confirm(accountId: string, code: string): void {
		const r = this.row(accountId);
		if (r === undefined) {
			throw new TwoFactorError("there is no enrolment in progress for this account");
		}
		if (r.confirmed_at !== null) {
			throw new TwoFactorError("this account's authenticator is already confirmed");
		}
		const v = this.verifier.check(accountId, r.secret, code);
		if (!v.ok) {
			throw new TwoFactorError(
				"that code is not valid, or has already been used. Check your device's " +
					"clock if it keeps failing.",
				401,
			);
		}
		this.db
			.prepare(`UPDATE user_totp SET confirmed_at = ? WHERE account_id = ?`)
			.run(new Date(this.now()).toISOString(), accountId);
	}

	/**
	 * Require a fresh, single-use code. Throws otherwise.
	 *
	 * NOT ENROLLED IS A REFUSAL, not a pass. The alternative — letting an
	 * un-enrolled account skip the check — means the factor protects only the
	 * customers who opted in, and an attacker with a stolen session would simply
	 * target accounts that had not. See `requireTotpForWithdrawal`.
	 */
	requireCode(accountId: string, code: string | undefined, what: string): void {
		const r = this.row(accountId);
		if (r === undefined || r.confirmed_at === null) {
			throw new TwoFactorError(
				`${what} requires an authenticator. Set one up in your account ` +
					"security settings first — this is what stops a stolen session from " +
					"moving your funds.",
				403,
			);
		}
		if (code === undefined || code.trim() === "") {
			throw new TwoFactorError(`${what} requires a current authenticator code`, 401);
		}
		const v = this.verifier.check(accountId, r.secret, code);
		if (!v.ok) {
			throw new TwoFactorError(
				"that authenticator code is not valid, or has already been used",
				401,
			);
		}
	}

	/** Remove the factor. Requires a current code, for the reason in rule 2. */
	disable(accountId: string, code: string): void {
		const r = this.row(accountId);
		if (r === undefined) return;
		if (r.confirmed_at !== null) {
			const v = this.verifier.check(accountId, r.secret, code);
			if (!v.ok) {
				throw new TwoFactorError(
					"turning off your authenticator requires a current code from it",
					401,
				);
			}
		}
		this.db.prepare(`DELETE FROM user_totp WHERE account_id = ?`).run(accountId);
	}
}
