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
    // NEVER include any key material (there is none in Stage 1; this guards
    // Stage 2 too — the key stays server-internal and is never serialized out).
    return {
      botId: d.botId, chain: d.chain, capUsd: d.capUsd,
      address: d.address, createdAt: d.createdAt, expiresAt: d.expiresAt,
    };
  }

  // Register (or refresh) a delegation for a running bot. Returns its view.
  function put(uid, { botId, chain, capUsd, address, ttl } = {}) {
    if (!uid) throw new Error('no user');
    if (!botId || !chain) throw new Error('botId and chain are required');
    const cap = Number(capUsd);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('capUsd must be > 0');
    const m = _userMap(uid);
    if (!m.has(botId) && m.size >= MAX_PER_USER) throw new Error('delegation limit reached');
    const t = now();
    const life = Math.min(Number(ttl) > 0 ? Number(ttl) : ttlMs, ttlMs);
    const d = {
      botId: String(botId), chain: String(chain), capUsd: cap,
      address: address ? String(address) : null,
      createdAt: t, expiresAt: t + life,
    };
    m.set(d.botId, d);
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

  return { put, list, get, revoke, revokeAll, sweep };
}
