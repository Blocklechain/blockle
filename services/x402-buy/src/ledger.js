// Persistent, idempotent payment ledger. Anything that moves value is written
// BEFORE it is sent and marked settled AFTER — so a crash can never double-pay.
//
// Idempotency key = a stable hash of the X-PAYMENT header (the facilitator
// already makes the underlying EIP-3009 authorization single-use, so one
// header == one payment). On a retry we look the row up and resume from where
// we left off (e.g. settled-but-not-yet-released) instead of paying twice.
//
// Row lifecycle:  verifying -> settled -> released       (happy path)
//                 verifying -> failed                    (verify/settle fail)
//
// SQLite via better-sqlite3 (synchronous, embedded, no server).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

function paymentIdFromHeader(xPaymentHeader) {
  return crypto.createHash("sha256").update(String(xPaymentHeader)).digest("hex");
}

class Ledger {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        network     TEXT,
        usdc_micro  TEXT,
        payer       TEXT,
        pay_to      TEXT,
        status      TEXT NOT NULL,
        settle_txhash TEXT,
        result_txid TEXT,
        request_json TEXT,
        receipt_json TEXT,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
      CREATE INDEX IF NOT EXISTS idx_payments_kind ON payments(kind);
    `);
  }

  get(id) {
    return this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  }

  /** Insert a new row in 'verifying' status, or return the existing one. */
  begin({ id, kind, network, usdcMicro, payTo, request }) {
    const now = Date.now();
    const existing = this.get(id);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO payments (id, kind, network, usdc_micro, pay_to, status, request_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'verifying', ?, ?, ?)`,
      )
      .run(id, kind, network || null, usdcMicro || null, payTo || null, JSON.stringify(request || {}), now, now);
    return this.get(id);
  }

  markSettled(id, { payer, settleTxhash }) {
    this.db
      .prepare(
        `UPDATE payments SET status='settled', payer=?, settle_txhash=?, updated_at=? WHERE id=?`,
      )
      .run(payer || null, settleTxhash || null, Date.now(), id);
    return this.get(id);
  }

  markReleased(id, { resultTxid, receipt }) {
    this.db
      .prepare(
        `UPDATE payments SET status='released', result_txid=?, receipt_json=?, updated_at=? WHERE id=?`,
      )
      .run(resultTxid || null, receipt ? JSON.stringify(receipt) : null, Date.now(), id);
    return this.get(id);
  }

  markFailed(id, error) {
    this.db
      .prepare(`UPDATE payments SET status='failed', error=?, updated_at=? WHERE id=?`)
      .run(String(error).slice(0, 500), Date.now(), id);
    return this.get(id);
  }

  /** Total micro-USDC settled/released today (UTC) — for the daily cap. */
  todayMicro() {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const rows = this.db
      .prepare(
        `SELECT usdc_micro FROM payments WHERE created_at >= ? AND status IN ('settled','released')`,
      )
      .all(startOfDay.getTime());
    let sum = 0n;
    for (const r of rows) {
      if (r.usdc_micro) sum += BigInt(r.usdc_micro);
    }
    return sum;
  }

  recent(limit = 100) {
    return this.db
      .prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }
}

module.exports = { Ledger, paymentIdFromHeader };
