// Blockle accounts service — auth, 2FA, sessions, zero-knowledge wallet backup, PayPal paid
// tier, support tickets, and a role-gated admin surface. Non-custodial: the server never holds
// a key/seed/plaintext wallet — /backup stores opaque client-encrypted ciphertext only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, resolveSecrets } from './config.js';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { RateLimiter } from './ratelimit.js';
import { makeMailer } from './email.js';
import { makePaypal, entitlementFromEvent } from './paypal.js';
import {
  hashPassword, verifyPassword, randomToken, sha256, timingSafeEqualStr,
  totpSecret, totpVerify, totpUri, genRecoveryCodes, safeNow,
} from './crypto.js';
import {
  securityHeaders, readJson, readBody, parseCookies, setCookie, clearCookie,
  json, html, redirect, sameOrigin, EMAIL_RE,
} from './http.js';
import { renderPage } from './pages.js';

const SESSION_COOKIE = 'blk_sess';
const APP_JS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');
// A fixed dummy hash to verify against when an account is absent, so login/register response
// time does not reveal whether an email exists (constant-work path).
const DUMMY_HASH = hashPassword(randomToken(16));

export function createApp(overrides = {}) {
  resolveSecrets();
  const cfg = { ...config, ...overrides.config };
  const now = overrides.now || safeNow;
  const store = overrides.store || new Store(cfg.dataDir);
  const sessions = new Sessions(store, cfg, now);
  const mailer = overrides.mailer || makeMailer(cfg);
  const paypal = overrides.paypal || makePaypal(cfg, overrides.paypalDeps);
  const loginIpRl = new RateLimiter({ windowMs: cfg.rateWindowMs, max: cfg.maxLoginPerIp, lockoutBaseMs: cfg.lockoutBaseMs, lockThreshold: 10 }, now);
  const acctRl = new RateLimiter({ windowMs: cfg.rateWindowMs, max: cfg.maxLoginPerAccount, lockoutBaseMs: cfg.lockoutBaseMs, lockThreshold: 4 }, now);
  // Per-recipient cap so register/reset can't be used to mail-bomb an address.
  const mailRl = new RateLimiter({ windowMs: cfg.rateWindowMs, max: 5, lockoutBaseMs: cfg.lockoutBaseMs }, now);

  const emailIndex = {
    get: (email) => store.get('emails', email.toLowerCase()),
    set: (email, uid) => store.put('emails', email.toLowerCase(), uid),
  };
  const userByEmail = (email) => {
    const uid = emailIndex.get(email || '');
    return uid ? store.get('users', uid) : null;
  };

  // --- admin seed ---------------------------------------------------------------------------
  async function ensureAdmin() {
    if (!cfg.adminEmail || !cfg.adminPassword) return;
    if (emailIndex.get(cfg.adminEmail)) return;
    const uid = randomToken(9);
    await store.put('users', uid, {
      id: uid, email: cfg.adminEmail, pwHash: hashPassword(cfg.adminPassword),
      verified: true, role: 'admin', createdAt: now(),
      totpEnabled: false, totpSecret: null, recoveryHashes: [],
      sub: { active: false, subId: null, plan: null },
    });
    await emailIndex.set(cfg.adminEmail, uid);
  }

  // --- helpers ------------------------------------------------------------------------------
  // Trust ONLY the right-most X-Forwarded-For hop — the one our own nginx appends via
  // $proxy_add_x_forwarded_for. The left-most values are attacker-controlled and must never be
  // used for rate-limit/lockout keys (else XFF spoofing defeats every per-IP control).
  function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return (req.socket.remoteAddress || '').trim();
  }
  async function currentSession(req) {
    const cookies = parseCookies(req);
    const id = cookies[SESSION_COOKIE];
    const sess = await sessions.get(id);
    if (!sess) return null;
    await sessions.touch(id);
    return { id, ...sess };
  }
  function requireCsrf(req, sess) {
    if (!sameOrigin(req, cfg)) return false;
    const token = req.headers['x-csrf-token'];
    return sessions.checkCsrf(sess, token);
  }
  const publicUser = (u) => u && ({
    id: u.id, email: u.email, verified: u.verified, role: u.role,
    totpEnabled: !!u.totpEnabled, sub: u.sub || { active: false }, onboarded: !!u.onboarded,
  });

  // --- handlers -----------------------------------------------------------------------------
  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });

  on('POST', /^\/account\/api\/register$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    if (!loginIpRl.allow('reg:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024);
    const email = String(b.email || '').toLowerCase().trim();
    const password = String(b.password || '');
    if (!EMAIL_RE.test(email) || password.length < 10)
      return json(res, 400, { error: 'Enter a valid email and a password of at least 10 characters.' });
    // Always hash (even if the account exists) so timing can't reveal account existence.
    const pwHash = hashPassword(password);
    // Generic success even if the email exists — never reveal account existence.
    if (!userByEmail(email)) {
      const uid = randomToken(9);
      await store.put('users', uid, {
        id: uid, email, pwHash, verified: false, role: 'user',
        createdAt: now(), totpEnabled: false, totpSecret: null, recoveryHashes: [],
        sub: { active: false, subId: null, plan: null },
      });
      await emailIndex.set(email, uid);
      const token = randomToken(32);
      await store.put('tokens', sha256(token), { type: 'verify', uid, exp: now() + cfg.tokenTtlMs });
      const url = `${cfg.publicOrigin}/account/verify?token=${token}`;
      if (mailRl.allow('mail:' + email))
        await mailer.send({ to: email, subject: 'Verify your Blockle account',
          text: `Confirm your email to finish signing up:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't request this, ignore it.` });
    }
    return json(res, 200, { ok: true, message: 'If that email is new, a verification link is on its way.' });
  });

  on('GET', /^\/account\/api\/verify$/, async (req, res, url) => {
    const token = url.searchParams.get('token') || '';
    const rec = store.get('tokens', sha256(token));
    if (!rec || rec.type !== 'verify' || rec.exp < now()) return json(res, 400, { error: 'Invalid or expired link.' });
    await store.del('tokens', sha256(token));
    await store.update('users', rec.uid, (u) => { if (u) u.verified = true; return u; });
    return json(res, 200, { ok: true });
  });

  on('POST', /^\/account\/api\/login$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    const ip = clientIp(req);
    if (loginIpRl.lockedFor('ip:' + ip) || !loginIpRl.allow('login:' + ip)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const b = await readJson(req, 64 * 1024);
    const email = String(b.email || '').toLowerCase().trim();
    const acctKey = 'acct:' + email;
    if (acctRl.lockedFor(acctKey)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const u = userByEmail(email);
    // Always run scrypt (against a dummy hash when absent) so timing can't enumerate accounts.
    const ok = verifyPassword(String(b.password || ''), u ? u.pwHash : DUMMY_HASH) && !!u;
    if (!ok) { acctRl.recordFailure(acctKey); loginIpRl.recordFailure('ip:' + ip); return json(res, 401, { error: 'Email or password is incorrect.' }); }
    if (!u.verified) return json(res, 403, { error: 'Please verify your email first — check your inbox.' });
    if (u.totpEnabled) {
      const code = String(b.totp || '');
      const recoveryOk = await tryRecovery(u, code);
      if (!totpVerify(u.totpSecret, code, now()) && !recoveryOk)
        { acctRl.recordFailure(acctKey); return json(res, 401, { error: '2fa', message: 'Enter your 6-digit code.' }); }
    }
    acctRl.reset(acctKey);
    const { id, csrf } = await sessions.create(u.id, { ip, ua: req.headers['user-agent'] });
    setCookie(res, SESSION_COOKIE, id, { maxAgeMs: cfg.sessionAbsoluteMs, secure: cfg.cookieSecure });
    return json(res, 200, { ok: true, csrf, user: publicUser(u) });
  });

  // Atomic check-and-consume: the membership test and removal happen inside the same store.update
  // so two concurrent logins can't both spend one recovery code.
  async function tryRecovery(u, code) {
    const h = sha256(code);
    let consumed = false;
    await store.update('users', u.id, (x) => {
      if (!x || !(x.recoveryHashes || []).includes(h)) return undefined; // no change
      x.recoveryHashes = x.recoveryHashes.filter((v) => v !== h);
      consumed = true;
      return x;
    });
    return consumed;
  }

  on('POST', /^\/account\/api\/logout$/, async (req, res) => {
    const sess = await currentSession(req);
    if (sess && requireCsrf(req, sess)) await sessions.destroy(sess.id);
    clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure });
    return json(res, 200, { ok: true });
  });

  on('POST', /^\/account\/api\/onboarded$/, authed(async (req, res, { u }) => {
    await store.update('users', u.id, (x) => { if (x) x.onboarded = true; return x; });
    return json(res, 200, { ok: true });
  }));

  on('GET', /^\/account\/api\/me$/, async (req, res) => {
    const sess = await currentSession(req);
    if (!sess) return json(res, 401, { error: 'auth' });
    const u = store.get('users', sess.uid);
    return json(res, 200, { user: publicUser(u), csrf: sess.csrf });
  });

  on('POST', /^\/account\/api\/request-reset$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    if (!loginIpRl.allow('reset:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024);
    const email = String(b.email || '').toLowerCase().trim();
    const u = userByEmail(email);
    if (u) {
      const token = randomToken(32);
      await store.put('tokens', sha256(token), { type: 'reset', uid: u.id, exp: now() + cfg.tokenTtlMs });
      const url = `${cfg.publicOrigin}/account/reset?token=${token}`;
      if (mailRl.allow('mail:' + email))
        await mailer.send({ to: email, subject: 'Reset your Blockle password',
          text: `Reset your password:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't request this, ignore it — your password is unchanged.` });
    }
    return json(res, 200, { ok: true, message: 'If that account exists, a reset link is on its way.' });
  });

  on('POST', /^\/account\/api\/reset$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    const b = await readJson(req, 64 * 1024);
    const token = String(b.token || '');
    const password = String(b.password || '');
    const rec = store.get('tokens', sha256(token));
    if (!rec || rec.type !== 'reset' || rec.exp < now()) return json(res, 400, { error: 'Invalid or expired link.' });
    if (password.length < 10) return json(res, 400, { error: 'Password must be at least 10 characters.' });
    await store.del('tokens', sha256(token));
    await store.update('users', rec.uid, (u) => { if (u) u.pwHash = hashPassword(password); return u; });
    await sessions.destroyAllForUser(rec.uid); // every existing session is revoked
    return json(res, 200, { ok: true });
  });

  // --- 2FA ----------------------------------------------------------------------------------
  on('POST', /^\/account\/api\/2fa\/setup$/, authed(async (req, res, { sess, u }) => {
    const secret = totpSecret();
    await store.update('users', u.id, (x) => { if (x) x.pendingTotp = secret; return x; });
    return json(res, 200, { secret, uri: totpUri(secret, u.email) });
  }));

  on('POST', /^\/account\/api\/2fa\/enable$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024);
    const secret = u.pendingTotp;
    if (!secret || !totpVerify(secret, String(b.totp || ''), now())) return json(res, 400, { error: 'Code did not match. Try again.' });
    const recovery = genRecoveryCodes();
    await store.update('users', u.id, (x) => {
      if (!x) return x;
      x.totpSecret = secret; x.totpEnabled = true; x.pendingTotp = null;
      x.recoveryHashes = recovery.map((c) => sha256(c)); return x;
    });
    return json(res, 200, { ok: true, recovery });
  }));

  on('POST', /^\/account\/api\/2fa\/disable$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024);
    if (!verifyPassword(String(b.password || ''), u.pwHash)) return json(res, 401, { error: 'Password is incorrect.' });
    await store.update('users', u.id, (x) => { if (x) { x.totpEnabled = false; x.totpSecret = null; x.recoveryHashes = []; } return x; });
    return json(res, 200, { ok: true });
  }));

  // --- zero-knowledge wallet backup ---------------------------------------------------------
  // The body is opaque ciphertext the client produced; the server stores and returns it and
  // CANNOT decrypt it. No passphrase/key ever reaches here.
  // Backup ops are step-up protected: 2FA must be enrolled AND a fresh code supplied. Fails
  // closed — a session alone can never read/overwrite/delete the (opaque) backup blob.
  function require2fa(req, u) {
    if (!u.totpEnabled) return false;
    return totpVerify(u.totpSecret, String(req.headers['x-totp'] || ''), now());
  }

  on('PUT', /^\/account\/api\/backup$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled
      ? { error: '2fa', message: 'Enter your 2FA code.' }
      : { error: '2fa_setup_required', message: 'Enable two-factor authentication to use encrypted backup.' });
    const b = await readJson(req, cfg.backupMaxBytes);
    const ct = String(b.ciphertext || '');
    if (!ct || !/^[A-Za-z0-9+/=_-]+$/.test(ct) || ct.length > cfg.backupMaxBytes)
      return json(res, 400, { error: 'Backup payload invalid.' });
    const meta = b.meta && typeof b.meta === 'object' ? sanitizeMeta(b.meta) : {};
    await store.update('backups', u.id, (rec) => {
      rec = rec || { versions: [] };
      rec.versions.unshift({ ciphertext: ct, meta, createdAt: now() });
      rec.versions = rec.versions.slice(0, 10); // keep last 10
      return rec;
    });
    return json(res, 200, { ok: true });
  }));

  on('GET', /^\/account\/api\/backup$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled
      ? { error: '2fa', message: 'Enter your 2FA code.' }
      : { error: '2fa_setup_required', message: 'Enable two-factor authentication to use encrypted backup.' });
    const rec = store.get('backups', u.id);
    if (!rec || !rec.versions.length) return json(res, 404, { error: 'No backup stored.' });
    return json(res, 200, { latest: rec.versions[0], versions: rec.versions.map((v, i) => ({ i, meta: v.meta, createdAt: v.createdAt })) });
  }));

  on('DELETE', /^\/account\/api\/backup$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled
      ? { error: '2fa', message: 'Enter your 2FA code.' }
      : { error: '2fa_setup_required', message: 'Enable two-factor authentication to use encrypted backup.' });
    await store.del('backups', u.id);
    return json(res, 200, { ok: true });
  }));

  // --- paid tier ----------------------------------------------------------------------------
  on('POST', /^\/account\/api\/subscribe$/, authed(async (req, res, { u }) => {
    if (paypal.disabled) return json(res, 503, { error: 'Billing is not configured yet.' });
    try {
      const sub = await paypal.createSubscription(u.id,
        `${cfg.publicOrigin}/account?sub=ok`, `${cfg.publicOrigin}/account?sub=cancel`);
      return json(res, 200, { approveUrl: sub.approveUrl, id: sub.id });
    } catch { return json(res, 502, { error: 'Could not start checkout. Please try again.' }); }
  }));

  // Entitlement changes ONLY here, and only after the webhook signature verifies.
  on('POST', /^\/account\/api\/paypal\/webhook$/, async (req, res) => {
    const raw = (await readBody(req, 512 * 1024)).toString('utf8');
    let verified = false;
    try { verified = await paypal.verifyWebhook(req.headers, raw); } catch { verified = false; }
    if (!verified) return json(res, 400, { error: 'unverified' });
    let event; try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad' }); }
    // Atomic idempotency: record the event id and detect a duplicate in one write.
    let dup = false;
    if (event.id) {
      await store.update('webhookEvents', event.id, (existing) => {
        if (existing) { dup = true; return undefined; }
        return { at: now(), type: event.event_type };
      });
    }
    if (dup) return json(res, 200, { ok: true, dup: true });
    const ent = entitlementFromEvent(event);
    if (ent && ent.userId) {
      await store.update('users', ent.userId, (u) => {
        if (!u) return u;
        u.sub = { active: ent.active, subId: ent.subId, plan: cfg.planName }; return u;
      });
    }
    return json(res, 200, { ok: true });
  });

  // --- support tickets ----------------------------------------------------------------------
  on('POST', /^\/account\/api\/tickets$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    if (!loginIpRl.allow('ticket:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024);
    const sess = await currentSession(req);
    const email = sess ? store.get('users', sess.uid)?.email : String(b.email || '').toLowerCase().trim();
    const subject = String(b.subject || '').slice(0, 200);
    const body = String(b.body || '').slice(0, 8000);
    if (!EMAIL_RE.test(email || '') || !subject || !body) return json(res, 400, { error: 'Add a valid email, subject, and message.' });
    const id = randomToken(8);
    await store.put('tickets', id, {
      id, email, subject, status: 'open', createdAt: now(),
      messages: [{ from: 'user', body, at: now() }],
    });
    // notify support mailbox
    try { await mailer.send({ to: 'support@blockle.org', subject: `[ticket ${id}] ${subject}`, text: `From: ${email}\n\n${body}` }); } catch {}
    return json(res, 200, { ok: true, id });
  });

  // --- admin (role-gated) -------------------------------------------------------------------
  on('GET', /^\/account\/api\/admin\/stats$/, adminOnly((req, res) => {
    const users = store.all('users');
    const tickets = store.all('tickets');
    return json(res, 200, {
      users: users.length,
      verified: users.filter((u) => u.verified).length,
      subscribers: users.filter((u) => u.sub?.active).length,
      with2fa: users.filter((u) => u.totpEnabled).length,
      backups: store.all('backups').length,
      tickets: { open: tickets.filter((t) => t.status === 'open').length, total: tickets.length },
    });
  }));

  on('GET', /^\/account\/api\/admin\/tickets$/, adminOnly((req, res) => {
    return json(res, 200, { tickets: store.all('tickets').sort((a, b) => b.createdAt - a.createdAt) });
  }));

  on('POST', /^\/account\/api\/admin\/ticket-reply$/, adminOnly(async (req, res) => {
    const b = await readJson(req, 64 * 1024);
    const t = store.get('tickets', String(b.id || ''));
    if (!t) return json(res, 404, { error: 'no ticket' });
    const reply = String(b.body || '').slice(0, 8000);
    if (!reply) return json(res, 400, { error: 'empty' });
    t.messages.push({ from: 'support', body: reply, at: now() });
    t.status = b.close ? 'closed' : 'open';
    await store.put('tickets', t.id, t);
    try { await mailer.send({ to: t.email, subject: `Re: [${t.id}] ${t.subject}`, text: reply }); } catch {}
    return json(res, 200, { ok: true });
  }));

  // --- middleware wrappers ------------------------------------------------------------------
  function authed(fn) {
    return async (req, res) => {
      const sess = await currentSession(req);
      if (!sess) return json(res, 401, { error: 'auth' });
      if (req.method !== 'GET' && !requireCsrf(req, sess)) return json(res, 403, { error: 'csrf' });
      const u = store.get('users', sess.uid);
      if (!u) return json(res, 401, { error: 'auth' });
      return fn(req, res, { sess, u });
    };
  }
  // Hidden surface: ANY non-admin (including unauthenticated) gets an indistinguishable 404 —
  // never a 401, so the existence of admin routes can't be probed.
  function adminOnly(fn) {
    return async (req, res) => {
      const sess = await currentSession(req);
      const u = sess ? store.get('users', sess.uid) : null;
      if (!u || u.role !== 'admin') return json(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && !requireCsrf(req, sess)) return json(res, 403, { error: 'csrf' });
      return fn(req, res, { sess, u });
    };
  }

  // --- page routes (self-contained HTML) ----------------------------------------------------
  const pageRoutes = {
    '/account/login': 'login', '/account/register': 'register', '/account': 'account',
    '/account/verify': 'verify', '/account/reset': 'reset', '/account/forgot': 'forgot',
    '/account/support': 'support', '/account/admin': 'admin', '/account/welcome': 'welcome',
  };

  const server = http.createServer(async (req, res) => {
    const base = securityHeaders(cfg);
    for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
    if (cfg.killed) return json(res, 503, { error: 'maintenance' });
    let url;
    try { url = new URL(req.url, cfg.publicOrigin); } catch { return json(res, 400, { error: 'bad url' }); }
    const pathn = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && pathn === '/account/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(APP_JS);
      }
      if (req.method === 'GET' && pageRoutes[pathn]) {
        if (pathn === '/account/admin') {
          const sess = await currentSession(req);
          const u = sess ? store.get('users', sess.uid) : null;
          if (!u || u.role !== 'admin') return json(res, 404, { error: 'not found' }); // don't leak the admin shell
        }
        return html(res, 200, renderPage(pageRoutes[pathn], cfg));
      }
      if (pathn === '/healthz') return json(res, 200, { ok: true });
      for (const r of routes) {
        if (r.method === req.method && r.re.test(pathn)) return await r.fn(req, res, url);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (/payload too large/.test(e.message)) return json(res, 413, { error: 'too large' });
      if (/bad json/.test(e.message)) return json(res, 400, { error: 'bad json' });
      // Never leak internals.
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  return { server, store, sessions, mailer, paypal, cfg, ensureAdmin, _internal: { loginIpRl, acctRl, userByEmail } };
}

function sanitizeMeta(meta) {
  const out = {};
  for (const k of ['version', 'kdf', 'salt', 'nonce', 'device', 'walletKind', 'createdAt', 'app']) {
    if (meta[k] != null) out[k] = String(meta[k]).slice(0, 256);
  }
  return out;
}

// Direct run.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  await app.ensureAdmin();
  app.server.listen(app.cfg.port, app.cfg.host, () =>
    console.log(`[accounts] listening on ${app.cfg.host}:${app.cfg.port} (prod=${app.cfg.prod}, mail=${app.cfg.mailTransport}, paypal=${app.paypal.stub ? 'stub' : app.cfg.paypalEnv})`));
}
