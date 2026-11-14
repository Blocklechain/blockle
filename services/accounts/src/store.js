// Append/replace JSON store with atomic writes + an in-process write queue so concurrent
// requests can't corrupt a collection. Collections are plain files under dataDir. This is
// deliberately swappable for Postgres/SQLite later (see docs/ACCOUNTS.md §6) — every caller
// goes through these methods, never the filesystem directly.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();   // name -> object
    this.queue = Promise.resolve();
  }

  _file(name) { return path.join(this.dir, `${name}.json`); }

  _load(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(this._file(name), 'utf8')) || {}; }
    catch { obj = {}; }
    this.cache.set(name, obj);
    return obj;
  }

  // Atomic: write to a temp file in the same dir, then rename over the target.
  _flush(name) {
    const obj = this.cache.get(name) || {};
    const tmp = this._file(name) + `.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, this._file(name));
  }

  get(name, key) {
    const v = this._load(name)[key];
    return v === undefined ? null : structuredClone(v);
  }

  all(name) { return Object.values(this._load(name)).map((v) => structuredClone(v)); }

  entries(name) { return Object.entries(this._load(name)).map(([k, v]) => [k, structuredClone(v)]); }

  find(name, pred) { return this.all(name).find(pred) ?? null; }

  // Serialize mutations through a queue. Each op's result/rejection is returned to ITS caller,
  // but the shared chain is kept alive regardless of outcome — one failed flush (ENOSPC, EACCES)
  // must never poison the queue and silently drop every subsequent write.
  _enqueue(fn) {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {}); // chain continues even if this op rejected
    return result;
  }

  put(name, key, value) {
    return this._enqueue(() => { this._load(name)[key] = value; this._flush(name); });
  }

  del(name, key) {
    return this._enqueue(() => { delete this._load(name)[key]; this._flush(name); });
  }

  // Read-modify-write under the queue to avoid lost updates. The callback can return undefined
  // to signal "no change" (used for atomic check-and-consume, e.g. single-use recovery codes).
  update(name, key, fn) {
    return this._enqueue(() => {
      const coll = this._load(name);
      const next = fn(coll[key] ? structuredClone(coll[key]) : null);
      if (next === undefined) return;
      coll[key] = next;
      this._flush(name);
    });
  }

  // Atomic multi-collection transaction under the same write queue. `fn` receives a
  // synchronous view {get,set,del} and runs as ONE queued op. Writes are BUFFERED and only
  // applied + flushed after `fn` returns without throwing, so a mid-transaction error leaves
  // every collection untouched (all-or-nothing). `get` sees the transaction's own pending
  // writes. Used by the game marketplace for gold settlement (debit buyer + credit seller +
  // flip the listing as one op).
  txn(fn) {
    return this._enqueue(() => {
      const writes = []; // [name, key, value] — value===undefined means delete
      const view = {
        get: (name, key) => {
          for (let i = writes.length - 1; i >= 0; i--) {
            const [n, k, v] = writes[i];
            if (n === name && k === key) return v === undefined ? null : structuredClone(v);
          }
          const v = this._load(name)[key];
          return v === undefined ? null : structuredClone(v);
        },
        set: (name, key, value) => { writes.push([name, key, structuredClone(value)]); },
        del: (name, key) => { writes.push([name, key, undefined]); },
      };
      const out = fn(view); // throws => nothing below runs => no mutation at all
      const touched = new Set();
      for (const [name, key, value] of writes) {
        const coll = this._load(name);
        if (value === undefined) delete coll[key]; else coll[key] = value;
        touched.add(name);
      }
      for (const name of touched) this._flush(name);
      return out;
    });
  }

  async drain() { await this.queue; }
}
