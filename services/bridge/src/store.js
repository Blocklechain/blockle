// store.js — durable, atomic, write-queued JSON store for the bridge.
//
// We REUSE the accounts service's proven store (atomic temp-file + rename, an
// in-process write queue so concurrent requests can't corrupt a collection, and
// a cache). Mirroring one storage primitive across services means one place to
// harden and one place to later swap for SQLite/Postgres.
//
// Collections (namespaces):
//   deposits  — BLOCK->wBLOCK transfers (the state-machine record), keyed by
//               the canonical transfer id derived from (direction, BLOCK txid).
//   burns     — wBLOCK->BLOCK transfers (the state-machine record), keyed by
//               the canonical transfer id derived from (direction, Solana burn sig).
//   mints     — FINALIZED wBLOCK mint ledger (one row per completed deposit),
//               keyed by depositId. This is immutable backing truth.
//   releases  — FINALIZED BLOCK release ledger (one row per completed burn),
//               keyed by burnId. Immutable truth.
//   meta      — counters, day-rollups, intents, kill-switch echo, misc.
//
// BigInt note: JSON can't hold BigInt, so amounts are persisted as decimal
// STRINGS of integer base units (e.g. "123456789"). Callers convert with BigInt().

import { Store } from '../../accounts/src/store.js';

export const NAMESPACES = ['deposits', 'burns', 'mints', 'releases', 'meta'];

export class BridgeStore {
  constructor(dataDir) {
    this.db = new Store(dataDir);
  }

  // --- reads (sync) ---
  get(ns, key) { return this.db.get(ns, key); }
  all(ns) { return this.db.all(ns); }
  entries(ns) { return this.db.entries(ns); }
  find(ns, pred) { return this.db.find(ns, pred); }
  has(ns, key) { return this.db.get(ns, key) != null; }

  // --- writes (async, serialized through the queue) ---
  put(ns, key, value) { return this.db.put(ns, key, value); }
  del(ns, key) { return this.db.del(ns, key); }
  update(ns, key, fn) { return this.db.update(ns, key, fn); }

  // Put-if-absent: returns true if written, false if the key already existed.
  // This is how the FINALIZED ledgers (mints/releases) enforce one-mint-per-deposit
  // and one-release-per-burn even under a replayed completion event.
  async putIfAbsent(ns, key, value) {
    let wrote = false;
    await this.db.update(ns, key, (cur) => {
      if (cur != null) return undefined; // exists -> no change
      wrote = true;
      return value;
    });
    return wrote;
  }

  async drain() { return this.db.drain(); }
}

export default BridgeStore;
