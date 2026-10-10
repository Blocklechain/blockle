// agent/audit.js — append-only, local, tamper-evident action log for the agent.
// Records every prompt, tool call (args + result + decision), confirmation, cap
// check, kill, and broadcast txid. The user can review and export it; it is the
// accountability backstop. Nothing here is ever sent to a Blockle server.
//
// Tamper-evidence: each entry is chained with a SHA-256 head hash
//   head_n = sha256(head_{n-1} + canonical(entry_n))
// so any later edit/removal/reorder of a past entry breaks verify(). The log is
// persisted locally (chrome.storage via the injected `store`, or in-memory).
//
// Exposed as global `AgentAudit`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function bigintReplacer(_k, v) { return typeof v === 'bigint' ? v.toString() : v; }
  function canonical(entry) {
    // stable stringify: sort keys so the hash is deterministic
    return JSON.stringify(entry, (k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {});
      }
      return v;
    });
  }

  const subtle = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) || null;
  // Tamper-evidence is cryptographic ONLY when WebCrypto SHA-256 is available.
  // When it is not, the chain degrades to a NON-cryptographic marker — callers
  // must treat the log as non-tamper-evident (surfaced via verify()/export so a
  // value-moving host can refuse rather than silently trust it; audit-finding #7).
  const CRYPTOGRAPHIC = !!subtle;
  async function sha256hex(str) {
    if (!subtle) {
      // extremely unlikely in extension/Node20; degrade to a non-crypto marker
      let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
      return 'nocrypto:' + h.toString(16);
    }
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  class Audit {
    constructor(opts) {
      opts = opts || {};
      this.entries = [];
      this.head = 'genesis';
      this.seq = 0;
      this.store = opts.store || null;      // { set(obj), get(keys) } — chrome.storage shim
      this.storeKey = opts.key || 'agentAuditLog';
      this.sink = typeof opts.sink === 'function' ? opts.sink : null; // live UI callback
      this.max = opts.max || 2000;
    }

    async record(data) {
      const entry = Object.assign({ seq: this.seq++, ts: Date.now() }, data);
      this.head = await sha256hex(this.head + canonical(entry));
      entry.hash = this.head;
      this.entries.push(entry);
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
      if (this.sink) { try { this.sink(entry); } catch (_) {} }
      if (this.store) { try { await this.store.set({ [this.storeKey]: { head: this.head, entries: this.entries } }); } catch (_) {} }
      return entry;
    }

    // Recompute the chain and confirm it matches the stored head hashes.
    async verify() {
      let head = 'genesis';
      for (const e of this.entries) {
        const { hash, ...rest } = e;
        head = await sha256hex(head + canonical(rest));
        if (head !== hash) return { ok: false, at: e.seq };
      }
      return { ok: head === this.head, head, cryptographic: CRYPTOGRAPHIC };
    }

    // True only when the chain is cryptographically tamper-evident (WebCrypto
    // present). A value-moving host should refuse to proceed when this is false.
    isCryptographic() { return CRYPTOGRAPHIC; }

    list() { return this.entries.slice(); }
    export() { return JSON.stringify({ head: this.head, cryptographic: CRYPTOGRAPHIC, entries: this.entries }, bigintReplacer, 2); }
    clear() { this.entries = []; this.head = 'genesis'; this.seq = 0; }
  }

  const AgentAudit = { create(opts) { return new Audit(opts); }, Audit };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentAudit;
  root.AgentAudit = AgentAudit;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
