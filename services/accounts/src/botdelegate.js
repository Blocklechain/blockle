// botdelegate.js — the EPHEMERAL delegation registry for the server-side live
// bot runner (Stage 1: lifecycle only, NO key material, NO signing).
//
// Security model (promised to users in the live-arm notice, enforced here):
//   • A delegation exists ONLY while its bot is running. Arming a live bot with
//     "keep running while closed" registers one; stopping the bot / Kill-all /
//     expiry / a server restart removes it. There is no disk persistence — the
//     registry is process memory only, so a crash/restart fail-CLOSES (every
//     bot stops until re-armed from the device).
//   • SCOPED per active chain: one delegation = { botId, chain, capUsd, address,
//     expiresAt }. A bot only ever delegates the chain it actually trades; no
//     other chain is represented.
//   • The actual signing key is NOT handled in Stage 1 (field reserved, never
//     accepted/stored yet) — so nothing sensitive can leak while we build and
//     verify the lifecycle. Stage 2 adds an encrypted, in-memory-only key here.
//   • list()/view never expose key material.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h hard ceiling per delegation
const MAX_PER_USER = 25; // matches the bot-count ceiling

export function makeBotDelegations({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  // uid -> Map<botId, { botId, chain, capUsd, address, createdAt, expiresAt }>
  const byUser = new Map();

  function _userMap(uid) {
    let m = byUser.get(uid);
    if (!m) { m = new Map(); byUser.set(uid, m); }
    return m;
  }

  function _view(d) {
    // NEVER include key material or the raw plan — the key/plan stay
    // server-internal and are never serialized out (to a response or a log).
    return {
      botId: d.botId, chain: d.chain, chainId: d.chainId, capUsd: d.capUsd,
      spentUsd: d.spentUsd, remainingUsd: Math.max(0, d.capUsd - d.spentUsd),
      address: d.address, hasKey: !!d.key, createdAt: d.createdAt, expiresAt: d.expiresAt,
    };
  }

  // Register (or refresh) a delegation for a running bot. Returns its view.
  // Stage 2b: optionally carries `key` (0x secp256k1, IN-MEMORY ONLY), `chainId`
  // (for the testnet/mainnet gate) and `plan` (server-evaluated trade plan).
  // Refreshing an existing bot PRESERVES its spent ledger (never resets the cap).
  function put(uid, { botId, chain, chainId, capUsd, address, ttl, key, plan } = {}) {
    if (!uid) throw new Error('no user');
    if (!botId || !chain) throw new Error('botId and chain are required');
    const cap = Number(capUsd);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('capUsd must be > 0');
    const m = _userMap(uid);
    const prior = m.get(String(botId));
    if (!prior && m.size >= MAX_PER_USER) throw new Error('delegation limit reached');
    const t = now();
    const life = Math.min(Number(ttl) > 0 ? Number(ttl) : ttlMs, ttlMs);
    const d = {
      botId: String(botId), chain: String(chain),
      chainId: chainId != null ? Number(chainId) : (prior ? prior.chainId : null),
      capUsd: cap,
      spentUsd: prior ? prior.spentUsd : 0, // preserve ledger across refresh
      address: address ? String(address) : (prior ? prior.address : null),
      key: key != null ? String(key) : (prior ? prior.key : null), // in-memory only
      plan: plan !== undefined ? plan : (prior ? prior.plan : null),
      createdAt: prior ? prior.createdAt : t,
      expiresAt: t + life,
    };
    m.set(d.botId, d);
    return _view(d);
  }

  // Record USD spent by a delegation's trade (gates further trades against the
  // cap). Returns the updated view, or null if the delegation is gone.
  function recordSpend(uid, botId, usd) {
    const d = get(uid, botId);
    if (!d) return null;
    d.spentUsd += Math.max(0, Number(usd) || 0);
    return _view(d);
  }

  // Active (non-expired) delegations for a user — metadata only.
  function list(uid) {
    const m = byUser.get(uid);
    if (!m) return [];
    const t = now();
    const out = [];
    for (const [botId, d] of [...m.entries()]) {
      if (d.expiresAt <= t) { m.delete(botId); continue; } // lazy sweep
      out.push(_view(d));
    }
    return out;
  }

  // INTERNAL (Stage 2 signing will call this): the live delegation or null.
  function get(uid, botId) {
    const m = byUser.get(uid);
    const d = m && m.get(botId);
    if (!d) return null;
    if (d.expiresAt <= now()) { m.delete(botId); return null; }
    return d;
  }

  // Revoke ONE bot's delegation (bot stopped). Returns true if one was removed.
  function revoke(uid, botId) {
    const m = byUser.get(uid);
    return !!(m && m.delete(botId));
  }

  // Revoke EVERY delegation for a user (Kill-all). Returns the count removed.
  function revokeAll(uid) {
    const m = byUser.get(uid);
    const n = m ? m.size : 0;
    if (m) m.clear();
    return n;
  }

  // Drop expired delegations across all users (periodic + fail-safe).
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [uid, m] of byUser) {
      for (const [botId, d] of [...m.entries()]) {
        if (d.expiresAt <= t) { m.delete(botId); removed++; }
      }
      if (m.size === 0) byUser.delete(uid);
    }
    return removed;
  }

  // INTERNAL: every live delegation across all users, WITH key + plan — for the
  // runner loop only. Never routed/serialized. Drops expired entries first.
  function allActive() {
    sweep();
    const out = [];
    for (const [uid, m] of byUser) {
      for (const d of m.values()) out.push({ uid, d });
    }
    return out;
  }

  return { put, list, get, recordSpend, revoke, revokeAll, sweep, allActive };
}
