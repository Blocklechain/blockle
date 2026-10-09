// agent/policy.js — the MANDATORY, non-bypassable safety layer for the in-wallet
// AI agent. Enforced in code, never by prompt. Four rails live here:
//
//   1. Per-session spending caps      (hard-reject over cap; reset only by the user)
//   2. Confirmation gate (default-on) (every value-moving action awaits a human OK)
//   3. Tool allowlist check           (only named tools may run)
//   4. Kill switch                    (abort + revoke session + lock the vault)
//
// A full audit log (agent/audit.js) is driven by the runner around these checks.
//
// Values are tracked two ways, both independently enforced:
//   - per-asset cumulative spend, in BASE UNITS (BigInt-safe decimal strings)
//   - an optional session cap in a USD-equivalent reference number
// A value-moving action reports { asset, amount, usd? }. If a session USD cap is
// set, an action with no `usd` estimate is REJECTED (cannot be verified) — safety
// over convenience. Per-asset caps are checked whenever a cap exists for the asset.
//
// Exposed as global `AgentPolicy`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  // --- typed errors so the runner can distinguish halt vs. recoverable --------
  class AgentHalted extends Error {
    constructor(msg) { super(msg || 'agent halted'); this.name = 'AgentHalted'; this.halted = true; }
  }
  class CapExceeded extends Error {
    constructor(msg) { super(msg); this.name = 'CapExceeded'; this.cap = true; }
  }
  class ToolNotAllowed extends Error {
    constructor(name) { super('tool not on allowlist: ' + name); this.name = 'ToolNotAllowed'; this.toolName = name; }
  }

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null || v === '') return 0n;
    // base-unit decimal strings only; reject anything non-integer
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) throw new Error('amount must be a base-unit integer string: ' + s);
    return BigInt(s);
  }

  class Policy {
    constructor(opts) {
      opts = opts || {};
      const caps = opts.caps || {};
      this.caps = {
        sessionUsd: caps.sessionUsd != null ? Number(caps.sessionUsd) : null,
        perAsset: {},
      };
      if (caps.perAsset) {
        for (const [k, v] of Object.entries(caps.perAsset)) this.caps.perAsset[k] = toBig(v);
      }
      // confirmFn(summary) -> Promise<boolean>; absence means fail-safe (deny).
      this.confirmFn = typeof opts.confirm === 'function' ? opts.confirm : null;
      this.onKill = typeof opts.onKill === 'function' ? opts.onKill : null;
      this.audit = opts.audit || null;
      this.requireConfirm = opts.requireConfirm !== false; // default ON
      // optional per-session opt-in: auto-approve value-moving actions whose USD
      // estimate is <= this (still bounded by the caps). Off by default.
      this.autoApproveUnderUsd = opts.autoApproveUnderUsd != null ? Number(opts.autoApproveUnderUsd) : null;

      this.spentUsd = 0;
      this.spentByAsset = {}; // symbol -> BigInt
      this.killed = false;
      this.allowlist = null;  // Set<string> | null
    }

    // ---- allowlist ----------------------------------------------------------
    setAllowlist(names) {
      this.allowlist = new Set(names || []);
      return this;
    }
    checkAllowed(name) {
      if (this.allowlist && !this.allowlist.has(name)) throw new ToolNotAllowed(name);
      return true;
    }

    // ---- kill switch --------------------------------------------------------
    isKilled() { return this.killed; }
    assertLive() {
      if (this.killed) throw new AgentHalted('agent killed');
    }
    async kill(reason) {
      if (this.killed) return;
      this.killed = true;
      if (this.audit) { try { await this.audit.record({ type: 'kill', reason: reason || 'user' }); } catch (_) {} }
      // onKill wipes decrypted keys + the LLM credential from memory (vault lock)
      // and revokes the exchange session token. One tap, everything stops.
      if (this.onKill) { try { await this.onKill(reason); } catch (_) {} }
    }

    // ---- spending caps ------------------------------------------------------
    // Pre-check WITHOUT recording. Throws CapExceeded on violation.
    assessValue(value) {
      value = value || {};
      const asset = value.asset;
      const amount = value.amount != null ? toBig(value.amount) : 0n;
      const usd = value.usd != null ? Number(value.usd) : null;

      // per-asset cap
      if (asset && this.caps.perAsset[asset] != null) {
        const cap = this.caps.perAsset[asset];
        const next = (this.spentByAsset[asset] || 0n) + amount;
        if (next > cap) {
          throw new CapExceeded(
            `per-asset cap exceeded for ${asset}: would spend ${next} base units, cap is ${cap}`);
        }
      }

      // session USD cap
      if (this.caps.sessionUsd != null) {
        if (usd == null) {
          throw new CapExceeded(
            `session cap is set ($${this.caps.sessionUsd}) but this action has no USD estimate — cannot verify, rejecting`);
        }
        const next = this.spentUsd + usd;
        if (next > this.caps.sessionUsd) {
          throw new CapExceeded(
            `session USD cap exceeded: would spend $${next.toFixed(2)}, cap is $${this.caps.sessionUsd}`);
        }
      }
      return true;
    }

    // Record a committed spend. Called only AFTER a successful broadcast/execute.
    recordSpend(value) {
      value = value || {};
      if (value.usd != null) this.spentUsd += Number(value.usd);
      if (value.asset && value.amount != null) {
        this.spentByAsset[value.asset] = (this.spentByAsset[value.asset] || 0n) + toBig(value.amount);
      }
    }

    // Caps reset only by explicit user action — never by the agent.
    resetSpend() { this.spentUsd = 0; this.spentByAsset = {}; }
    setCaps(caps) {
      caps = caps || {};
      if ('sessionUsd' in caps) this.caps.sessionUsd = caps.sessionUsd != null ? Number(caps.sessionUsd) : null;
      if (caps.perAsset) {
        for (const [k, v] of Object.entries(caps.perAsset)) this.caps.perAsset[k] = toBig(v);
      }
    }
    remaining() {
      const perAsset = {};
      for (const [k, cap] of Object.entries(this.caps.perAsset)) {
        perAsset[k] = (cap - (this.spentByAsset[k] || 0n)).toString();
      }
      return {
        sessionUsd: this.caps.sessionUsd != null ? this.caps.sessionUsd - this.spentUsd : null,
        perAsset,
      };
    }

    // ---- confirmation gate --------------------------------------------------
    // Returns { approved: bool, auto: bool }. Fail-safe: no handler => denied.
    async gateConfirm(summary, meta) {
      this.assertLive();
      meta = meta || {};
      const usd = meta.usd != null ? Number(meta.usd) : null;

      if (this.autoApproveUnderUsd != null && usd != null && usd <= this.autoApproveUnderUsd) {
        return { approved: true, auto: true };
      }
      if (!this.requireConfirm) return { approved: true, auto: false };
      if (!this.confirmFn) return { approved: false, auto: false }; // fail closed
      const ok = await this.confirmFn(summary);
      this.assertLive(); // a kill during the await must still block the action
      return { approved: !!ok, auto: false };
    }
  }

  const AgentPolicy = {
    create(opts) { return new Policy(opts); },
    Policy,
    AgentHalted,
    CapExceeded,
    ToolNotAllowed,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentPolicy;
  root.AgentPolicy = AgentPolicy;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
