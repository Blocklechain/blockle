// ledger.ts — persistent idempotency + payout ledger.
//
// INVARIANT: one BLOCK txid -> at most one USDC payout. We achieve this with
// write-before-send + mark-settled-after:
//
//   1. begin(txid)        writes a `pending` row to disk BEFORE any payout.
//                         A second begin() for the same txid throws — so a
//                         concurrent or retried request can never start a
//                         second payout.
//   2. <send USDC>
//   3. settle(txid, …)    rewrites the row `settled` with the tx hash.
//
// If the process crashes between (1) and (3) the row is stuck `pending`; on
// retry begin() refuses and the request is told the payout is in-flight — a
// crash therefore NEVER double-pays (it may, at worst, require operator
// reconciliation of a single stuck row, which is the safe direction).
//
// Persistence is a single JSON file, rewritten atomically (write temp + rename)
// on every state change. In-process a lock set guards the read-modify-write so
// overlapping async requests serialise on a txid.

import * as fs from "fs";
import * as path from "path";

export type LedgerStatus = "pending" | "settled" | "failed";

export interface LedgerEntry {
  blockTxid: string;
  status: LedgerStatus;
  userUsdcAddr: string;
  /** USDC paid out, base units (string for JSON safety) */
  usdcOutBase?: string;
  /** BLOCK received, base units */
  blockInBase?: string;
  txHash?: string;
  explorer?: string;
  reason?: string;
  createdAt: number; // unix seconds
  updatedAt: number;
}

export class Ledger {
  private entries: Map<string, LedgerEntry> = new Map();
  private inflight: Set<string> = new Set();

  constructor(private filePath: string) {
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const arr: LedgerEntry[] = Array.isArray(raw) ? raw : raw.entries ?? [];
      for (const e of arr) this.entries.set(e.blockTxid, e);
    } catch {
      this.entries = new Map();
    }
  }

  private persist() {
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const tmp = this.filePath + ".tmp";
    const data = JSON.stringify({ entries: [...this.entries.values()] }, null, 2);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  get(txid: string): LedgerEntry | undefined {
    return this.entries.get(txid);
  }

  /**
   * Claim `txid` for processing by writing a `pending` row. Throws if a row
   * already exists (settled, failed, or pending) OR if the txid is currently
   * in-flight in this process. This is the single dedupe chokepoint.
   */
  begin(txid: string, userUsdcAddr: string, blockInBase: bigint): LedgerEntry {
    if (this.inflight.has(txid)) {
      throw new LedgerConflict(txid, "pending", "a settlement for this txid is already in progress");
    }
    const existing = this.entries.get(txid);
    if (existing) {
      throw new LedgerConflict(txid, existing.status, "this txid has already been submitted");
    }
    this.inflight.add(txid);
    const now = Math.floor(Date.now() / 1000);
    const entry: LedgerEntry = {
      blockTxid: txid,
      status: "pending",
      userUsdcAddr,
      blockInBase: blockInBase.toString(),
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(txid, entry);
    this.persist();
    return entry;
  }

  settle(txid: string, usdcOutBase: bigint, txHash: string, explorer: string): LedgerEntry {
    const e = this.entries.get(txid);
    if (!e) throw new Error(`ledger.settle: no pending entry for ${txid}`);
    e.status = "settled";
    e.usdcOutBase = usdcOutBase.toString();
    e.txHash = txHash;
    e.explorer = explorer;
    e.updatedAt = Math.floor(Date.now() / 1000);
    this.inflight.delete(txid);
    this.persist();
    return e;
  }

  /** Mark failed and RELEASE the row so the seller can legitimately retry
   *  (nothing was paid). Used only when payout never left the building. */
  fail(txid: string, reason: string): void {
    const e = this.entries.get(txid);
    this.inflight.delete(txid);
    if (e && e.status === "pending") {
      // remove the pending claim entirely: no payout happened, retry is safe
      this.entries.delete(txid);
      this.persist();
    } else if (e) {
      e.reason = reason;
      this.persist();
    }
  }

  /** Total USDC base units settled at or after `sinceUnix` — for the daily cap. */
  settledSince(sinceUnix: number): bigint {
    let total = 0n;
    for (const e of this.entries.values()) {
      if (e.status === "settled" && e.updatedAt >= sinceUnix && e.usdcOutBase) {
        total += BigInt(e.usdcOutBase);
      }
    }
    return total;
  }
}

export class LedgerConflict extends Error {
  constructor(
    public txid: string,
    public status: LedgerStatus,
    message: string,
  ) {
    super(message);
    this.name = "LedgerConflict";
  }
}
