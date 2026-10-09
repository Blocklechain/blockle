// Wallet-signature sign-in. A server-issued, single-use, expiring nonce is
// signed by the user's wallet (EVM personal_sign, Solana ed25519, or BLOCK
// ML-DSA); the relay verifies the signature, proving address ownership, and
// issues a session token. AGENTS authenticate IDENTICALLY — there is no
// custodial password path anywhere.

import * as crypto from "crypto";
import type { DB } from "./db";
import { audit } from "./db";
import type { Config } from "./config";
import { verifySignature, type ChainKind } from "./sigverify";

export interface Session {
  token: string;
  address: string;
  chain: string;
  publicKey?: string;
  expires: number;
}

export class Auth {
  constructor(
    private db: DB,
    private cfg: Config,
  ) {}

  /** Issue a fresh nonce bound to (address, chain). */
  issueNonce(address: string, chain: string): string {
    const nonce = `blockle-exchange login: ${crypto.randomBytes(24).toString("hex")}`;
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare("INSERT INTO nonces (nonce, address, chain, created, expires, used) VALUES (?,?,?,?,?,0)")
      .run(nonce, address, chain, now, now + this.cfg.nonceTtlSec);
    return nonce;
  }

  /** Verify a signature over a previously-issued nonce and open a session. */
  verify(args: {
    address: string;
    chain: ChainKind;
    signature: string;
    publicKey?: string;
    /** the nonce the client signed; if omitted we use the latest unused one */
    nonce?: string;
  }): Session {
    const now = Math.floor(Date.now() / 1000);
    const row = (
      args.nonce
        ? this.db.prepare("SELECT * FROM nonces WHERE nonce=?").get(args.nonce)
        : this.db
            .prepare(
              "SELECT * FROM nonces WHERE address=? AND chain=? AND used=0 ORDER BY created DESC LIMIT 1",
            )
            .get(args.address, args.chain)
    ) as any;

    if (!row) throw new AuthError("no matching nonce — request one via /auth/nonce first");
    if (row.used) throw new AuthError("nonce already used");
    if (row.expires < now) throw new AuthError("nonce expired");
    if (row.address !== args.address || row.chain !== args.chain) {
      throw new AuthError("nonce does not match address/chain");
    }

    const ok = verifySignature({
      chain: args.chain,
      message: row.nonce,
      signature: args.signature,
      address: args.address,
      publicKey: args.publicKey,
    });
    if (!ok) {
      audit(this.db, "auth.verify.fail", args.address, { chain: args.chain });
      throw new AuthError("signature verification failed");
    }

    // single-use nonce
    this.db.prepare("UPDATE nonces SET used=1 WHERE nonce=?").run(row.nonce);

    const token = crypto.randomBytes(32).toString("hex");
    const expires = now + this.cfg.sessionTtlSec;
    this.db
      .prepare(
        "INSERT INTO sessions (token, address, chain, public_key, created, expires) VALUES (?,?,?,?,?,?)",
      )
      .run(token, args.address, args.chain, args.publicKey ?? null, now, expires);
    audit(this.db, "auth.verify.ok", args.address, { chain: args.chain });
    return { token, address: args.address, chain: args.chain, publicKey: args.publicKey, expires };
  }

  /** Resolve a bearer token to a live session, or null. */
  session(token: string | undefined): Session | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token=?").get(token) as any;
    if (!row) return null;
    if (row.expires < Math.floor(Date.now() / 1000)) return null;
    return {
      token: row.token,
      address: row.address,
      chain: row.chain,
      publicKey: row.public_key ?? undefined,
      expires: row.expires,
    };
  }
}

export class AuthError extends Error {}
