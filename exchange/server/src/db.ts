// SQLite persistence. Orders, trades, swap state machines, dynamic asset
// listings, auth nonces/sessions, and an append-only audit log all live here
// so a crash never loses state. Everything that could move value is keyed to
// survive restarts; the relay itself never holds funds.

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export type DB = Database.Database;

export function openDb(dbPath: string): DB {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nonces (
      nonce      TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      chain      TEXT NOT NULL,
      created    INTEGER NOT NULL,
      expires    INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      chain      TEXT NOT NULL,
      public_key TEXT,
      created    INTEGER NOT NULL,
      expires    INTEGER NOT NULL
    );

    -- dynamic, self-serve-listed assets (base assets are code-defined)
    CREATE TABLE IF NOT EXISTS assets (
      symbol     TEXT PRIMARY KEY,
      chain      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      addr       TEXT,
      decimals   INTEGER NOT NULL,
      logo       TEXT,
      active     INTEGER NOT NULL DEFAULT 0,
      listing_id TEXT,
      created    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listings (
      listing_id    TEXT PRIMARY KEY,
      symbol        TEXT NOT NULL,
      extra_pairs   TEXT NOT NULL,     -- JSON array
      markets       TEXT NOT NULL,     -- JSON array
      total_usd     REAL NOT NULL,
      pay_to        TEXT,
      payment_txid  TEXT,
      payment_kind  TEXT,              -- 'onchain' | 'x402'
      active        INTEGER NOT NULL DEFAULT 0,
      lister        TEXT,
      created       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id   TEXT PRIMARY KEY,
      market     TEXT NOT NULL,
      side       TEXT NOT NULL,        -- buy | sell
      type       TEXT NOT NULL,        -- limit | market
      price      TEXT,                 -- quote per base, base-unit string (null = market)
      amount     TEXT NOT NULL,        -- base asset, base-unit string
      filled     TEXT NOT NULL DEFAULT '0',
      maker      TEXT NOT NULL,        -- maker address (identity; BLOCK addr via SDK)
      maker_chain TEXT NOT NULL,
      expiry     INTEGER NOT NULL,
      nonce      TEXT NOT NULL,
      intent     TEXT NOT NULL,        -- canonical signed intent (JSON)
      signature  TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'open', -- open|filled|cancelled|expired
      created    INTEGER NOT NULL,
      seq        INTEGER                -- time priority tiebreak (rowid-like)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_book ON orders(market, status);

    CREATE TABLE IF NOT EXISTS trades (
      trade_id    TEXT PRIMARY KEY,
      market      TEXT NOT NULL,
      price       TEXT NOT NULL,
      amount      TEXT NOT NULL,
      maker_order TEXT NOT NULL,
      taker_order TEXT NOT NULL,
      fee_bps     INTEGER NOT NULL,
      swap_id     TEXT,
      created     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market, created);

    CREATE TABLE IF NOT EXISTS swaps (
      swap_id      TEXT PRIMARY KEY,
      market       TEXT NOT NULL,
      state        TEXT NOT NULL,      -- proposed|makerLocked|takerLocked|makerWithdrew|claimed|refunded
      hashlock     TEXT,
      maker        TEXT NOT NULL,
      taker        TEXT NOT NULL,
      maker_order  TEXT,
      taker_order  TEXT,
      legs         TEXT NOT NULL,      -- JSON [{chain,asset,amount,recipient,role,timelock,lockRef,status}]
      fee_bps      INTEGER NOT NULL,
      expiry       INTEGER NOT NULL,
      created      INTEGER NOT NULL,
      updated      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      actor   TEXT,
      action  TEXT NOT NULL,
      detail  TEXT
    );

    -- idempotency ledger: dedupe any value-moving verification by key
    CREATE TABLE IF NOT EXISTS idempotency (
      key     TEXT PRIMARY KEY,
      scope   TEXT NOT NULL,
      result  TEXT,
      ts      INTEGER NOT NULL
    );
  `);
}

/** Append-only audit row. Everything of consequence is logged. */
export function audit(db: DB, action: string, actor: string | null, detail?: unknown): void {
  db.prepare("INSERT INTO audit_log (ts, actor, action, detail) VALUES (?,?,?,?)").run(
    Date.now(),
    actor,
    action,
    detail == null ? null : JSON.stringify(detail),
  );
}

/** Returns true the FIRST time a key is seen (claimed); false if already used.
 *  Write-before-send dedupe for value-moving operations. */
export function claimIdempotencyKey(db: DB, scope: string, key: string): boolean {
  try {
    db.prepare("INSERT INTO idempotency (key, scope, ts) VALUES (?,?,?)").run(key, scope, Date.now());
    return true;
  } catch {
    return false; // UNIQUE violation => already claimed
  }
}

export function recordIdempotencyResult(db: DB, key: string, result: unknown): void {
  db.prepare("UPDATE idempotency SET result=? WHERE key=?").run(JSON.stringify(result), key);
}
