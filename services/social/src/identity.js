// Identity bridge: resolve the shared accounts session (blk_sess cookie) by reading the accounts
// service's session/user store read-only and fresh (so logins/logouts there take effect here
// immediately). One account spans wallet + site + social. We never write the accounts store.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../accounts/src/crypto.js';
import { parseCookies } from '../../accounts/src/http.js';

function readStore(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')) || {}; }
  catch { return {}; }
}

// Returns { uid, email, role, csrf } or null. `now` injectable for tests.
export function resolveSession(req, config, now = () => Date.now()) {
  const cookie = parseCookies(req)[config.sessionCookie];
  if (!cookie) return null;
  const sessions = readStore(config.accountsDataDir, 'sessions');
  const rec = sessions[sha256(cookie)];
  if (!rec) return null;
  const t = now();
  if (t - rec.lastSeen > config.sessionIdleMs) return null;
  if (t - rec.createdAt > config.sessionAbsoluteMs) return null;
  const users = readStore(config.accountsDataDir, 'users');
  const u = users[rec.uid];
  if (!u) return null;
  return { uid: u.id, email: u.email, username: u.username || null, role: u.role || 'user', csrf: rec.csrf };
}
