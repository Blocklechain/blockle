// Server-side sessions. The cookie carries an opaque random id; the session record (incl. a
// per-session CSRF token) lives server-side so logout/password-change can revoke instantly.
import { randomToken, sha256, timingSafeEqualStr } from './crypto.js';

export class Sessions {
  constructor(store, config, now = () => Date.now()) {
    this.store = store; this.config = config; this.now = now;
  }

  async create(userId, { ip, ua } = {}) {
    const id = randomToken(32);
    const csrf = randomToken(24);
    const t = this.now();
    // Store only the HASH of the session id; a DB leak can't resurrect a live cookie.
    await this.store.put('sessions', sha256(id), {
      uid: userId, csrf, createdAt: t, lastSeen: t, ip: ip || null, ua: (ua || '').slice(0, 200),
    });
    return { id, csrf };
  }

  async get(id) {
    if (!id) return null;
    const rec = this.store.get('sessions', sha256(id));
    if (!rec) return null;
    const t = this.now();
    if (t - rec.lastSeen > this.config.sessionIdleMs) { await this.destroy(id); return null; }
    if (t - rec.createdAt > this.config.sessionAbsoluteMs) { await this.destroy(id); return null; }
    return rec;
  }

  async touch(id) {
    await this.store.update('sessions', sha256(id), (rec) => {
      if (!rec) return undefined;
      rec.lastSeen = this.now(); return rec;
    });
  }

  async destroy(id) { if (id) await this.store.del('sessions', sha256(id)); }

  // Revoke every session for a user (on password reset/change, or admin action).
  async destroyAllForUser(userId) {
    for (const [key, rec] of this.store.entries('sessions')) {
      if (rec.uid === userId) await this.store.del('sessions', key);
    }
  }

  checkCsrf(session, token) {
    return !!session && timingSafeEqualStr(session.csrf, token || '');
  }
}
