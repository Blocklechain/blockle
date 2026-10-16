import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { hashPassword, verifyPassword, totpCode } from '../src/crypto.js';

// ---- harness: live server + a cookie jar + a mutable clock ---------------------------------
function freshApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-acct-'));
  const clock = { t: 1_700_000_000_000 };
  const app = createApp({
    now: () => clock.t,
    config: {
      dataDir, prod: false, cookieSecure: false, mailTransport: 'stub', paypalEnv: 'stub',
      publicOrigin: 'http://127.0.0.1', adminEmail: 'admin@example.test', adminPassword: 'test-admin-passphrase-123',
      planName: 'Blockle Pro', sessionSecret: 'test-secret',
    },
  });
  return { app, dataDir, clock };
}

async function withServer(fn) {
  const { app, dataDir, clock } = freshApp();
  await app.ensureAdmin();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  async function call(method, p, body, headers = {}) {
    const h = { ...headers };
    if (body) h['Content-Type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h['Cookie'] = cookie;
    const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    for (const c of setc) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (v === '' || /Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v; }
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data, raw: r };
  }
  try { await fn({ app, call, clock, dataDir, base }); }
  finally { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

const readStore = (dataDir, name) => { try { return fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'); } catch { return ''; } };

// ---- unit: password hashing ----------------------------------------------------------------
test('scrypt hash verifies and rejects', () => {
  const h = hashPassword('correct horse battery staple');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse battery staple', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.equal(verifyPassword('correct horse battery staple', 'garbage'), false);
});

// ---- register + verify + login -------------------------------------------------------------
test('register emails a verify link; verify is single-use; login gated on verification', async () => {
  await withServer(async ({ app, call }) => {
    const r = await call('POST', '/api/register', { email: 'a@b.com', password: 'longenough1' });
    assert.equal(r.status, 200);
    const mail = app.mailer.sent.find((m) => m.to === 'a@b.com');
    assert.ok(mail, 'verification email sent');
    const token = mail.text.match(/token=([^\s]+)/)[1];

    // login before verify → 403
    const pre = await call('POST', '/api/login', { email: 'a@b.com', password: 'longenough1' });
    assert.equal(pre.status, 403);

    const v1 = await call('GET', '/api/verify?token=' + token);
    assert.equal(v1.status, 200);
    const v2 = await call('GET', '/api/verify?token=' + token); // reuse
    assert.equal(v2.status, 400);

    const ok = await call('POST', '/api/login', { email: 'a@b.com', password: 'longenough1' });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.csrf);
  });
});

test('register never reveals existing accounts (identical response)', async () => {
  await withServer(async ({ call }) => {
    const r1 = await call('POST', '/api/register', { email: 'dup@b.com', password: 'longenough1' });
    const r2 = await call('POST', '/api/register', { email: 'dup@b.com', password: 'otherlong12' });
    assert.equal(r1.status, 200); assert.equal(r2.status, 200);
    assert.deepEqual(r1.data, r2.data);
  });
});

// ---- lockout -------------------------------------------------------------------------------
test('account lockout engages after repeated failures', async () => {
  await withServer(async ({ app, call }) => {
    await call('POST', '/api/register', { email: 'c@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await call('POST', '/api/login', { email: 'c@b.com', password: 'wrongpass123' });
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, 'lockout returns 429');
  });
});

// ---- tokens stored hashed ------------------------------------------------------------------
test('verification/reset tokens are stored only as hashes', async () => {
  await withServer(async ({ app, call, dataDir }) => {
    await call('POST', '/api/register', { email: 'h@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await app.store.drain();
    const raw = readStore(dataDir, 'tokens');
    assert.ok(raw.length, 'tokens file exists');
    assert.ok(!raw.includes(token), 'raw token is NOT present on disk');
  });
});

// ---- zero-knowledge backup -----------------------------------------------------------------
test('backup stores opaque ciphertext the server cannot decrypt', async () => {
  await withServer(async ({ app, call, dataDir, clock }) => {
    await call('POST', '/api/register', { email: 'z@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    const login = await call('POST', '/api/login', { email: 'z@b.com', password: 'longenough1' });
    const csrf = login.data.csrf;
    // backup requires 2FA (fails closed) — enrol it
    const secret = (await call('POST', '/api/2fa/setup', {}, { 'X-CSRF-Token': csrf })).data.secret;
    await call('POST', '/api/2fa/enable', { totp: totpCode(secret, clock.t) }, { 'X-CSRF-Token': csrf });

    const CIPHERTEXT = 'q1W2e3R4t5Y6u7I8o9P0aAsSdDfFgG_-Base64urlOpaqueBlob==';
    const put = await call('PUT', '/api/backup', { ciphertext: CIPHERTEXT, meta: { version: 1, kdf: 'scrypt', device: 'test' } }, { 'X-CSRF-Token': csrf, 'x-totp': totpCode(secret, clock.t) });
    assert.equal(put.status, 200);

    const get = await call('GET', '/api/backup', undefined, { 'x-totp': totpCode(secret, clock.t) });
    assert.equal(get.status, 200);
    assert.equal(get.data.latest.ciphertext, CIPHERTEXT, 'returns exactly what was stored');

    await app.store.drain();
    const raw = readStore(dataDir, 'backups');
    assert.ok(raw.includes(CIPHERTEXT), 'stored verbatim');
    // the server stores only the ciphertext + non-secret meta — there is no key/passphrase field
    const parsed = JSON.parse(raw);
    const rec = Object.values(parsed)[0].versions[0];
    assert.deepEqual(Object.keys(rec).sort(), ['ciphertext', 'createdAt', 'meta']);
    assert.ok(!('key' in rec) && !('passphrase' in rec) && !('plaintext' in rec));
  });
});

test('backup download survives a lapsed subscription', async () => {
  await withServer(async ({ app, call, clock }) => {
    await call('POST', '/api/register', { email: 'lap@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    const login = await call('POST', '/api/login', { email: 'lap@b.com', password: 'longenough1' });
    const csrf = login.data.csrf;
    const secret = (await call('POST', '/api/2fa/setup', {}, { 'X-CSRF-Token': csrf })).data.secret;
    await call('POST', '/api/2fa/enable', { totp: totpCode(secret, clock.t) }, { 'X-CSRF-Token': csrf });
    await call('PUT', '/api/backup', { ciphertext: 'blobBlobBlob==', meta: {} }, { 'X-CSRF-Token': csrf, 'x-totp': totpCode(secret, clock.t) });
    // force sub inactive
    const uid = app._internal.userByEmail('lap@b.com').id;
    await app.store.update('users', uid, (u) => { u.sub = { active: false }; return u; });
    const get = await call('GET', '/api/backup', undefined, { 'x-totp': totpCode(secret, clock.t) });
    assert.equal(get.status, 200, 'backup still downloadable when plan lapsed');
  });
});

test('backup is refused without 2FA enrolled (fails closed)', async () => {
  await withServer(async ({ app, call }) => {
    await call('POST', '/api/register', { email: 'no2fa@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    const login = await call('POST', '/api/login', { email: 'no2fa@b.com', password: 'longenough1' });
    const put = await call('PUT', '/api/backup', { ciphertext: 'abc==' }, { 'X-CSRF-Token': login.data.csrf });
    assert.equal(put.status, 403);
    assert.equal(put.data.error, '2fa_setup_required');
  });
});

// ---- CSRF ----------------------------------------------------------------------------------
test('authenticated mutation without CSRF token is rejected', async () => {
  await withServer(async ({ app, call }) => {
    await call('POST', '/api/register', { email: 'x@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    await call('POST', '/api/login', { email: 'x@b.com', password: 'longenough1' });
    const noCsrf = await call('PUT', '/api/backup', { ciphertext: 'abc==' }); // no X-CSRF-Token
    assert.equal(noCsrf.status, 403);
  });
});

// ---- password reset revokes sessions -------------------------------------------------------
test('reset changes password and revokes all sessions', async () => {
  await withServer(async ({ app, call }) => {
    await call('POST', '/api/register', { email: 'r@b.com', password: 'longenough1' });
    const vtok = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + vtok);
    await call('POST', '/api/login', { email: 'r@b.com', password: 'longenough1' });
    const meBefore = await call('GET', '/api/me');
    assert.equal(meBefore.status, 200);

    await call('POST', '/api/request-reset', { email: 'r@b.com' });
    const rtok = app.mailer.sent.find((m) => /Reset/.test(m.subject)).text.match(/token=([^\s]+)/)[1];
    const done = await call('POST', '/api/reset', { token: rtok, password: 'brandnewpass1' });
    assert.equal(done.status, 200);

    const meAfter = await call('GET', '/api/me');
    assert.equal(meAfter.status, 401, 'old session revoked');
    const relog = await call('POST', '/api/login', { email: 'r@b.com', password: 'brandnewpass1' });
    assert.equal(relog.status, 200);
  });
});

// ---- entitlement only via verified webhook -------------------------------------------------
test('entitlement flips only on a verified webhook, and is idempotent', async () => {
  await withServer(async ({ app, call }) => {
    await call('POST', '/api/register', { email: 'pay@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    await call('POST', '/api/login', { email: 'pay@b.com', password: 'longenough1' });
    const uid = app._internal.userByEmail('pay@b.com').id;

    const event = { id: 'EVT-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'SUB-9', custom_id: uid } };
    // unverified → rejected, no entitlement
    const bad = await call('POST', '/api/paypal/webhook', event);
    assert.equal(bad.status, 400);
    assert.equal(app.store.get('users', uid).sub.active, false);
    // verified → entitlement on
    const good = await call('POST', '/api/paypal/webhook', event, { 'x-stub-verified': 'yes' });
    assert.equal(good.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('users', uid).sub.active, true);
    // duplicate event id → idempotent no-op
    const dup = await call('POST', '/api/paypal/webhook', event, { 'x-stub-verified': 'yes' });
    assert.equal(dup.data.dup, true);
  });
});

// ---- admin is hidden (404 to non-admins) ---------------------------------------------------
test('admin endpoints 404 for non-admins, work for the seeded admin', async () => {
  await withServer(async ({ app, call }) => {
    await call('POST', '/api/register', { email: 'u@b.com', password: 'longenough1' });
    const token = app.mailer.sent.find((m) => m.to === 'u@b.com').text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    await call('POST', '/api/login', { email: 'u@b.com', password: 'longenough1' });
    const asUser = await call('GET', '/api/admin/stats');
    assert.equal(asUser.status, 404, 'hidden from normal users');

    await call('POST', '/api/logout', {});
    const asAnon = await call('GET', '/api/admin/stats'); // unauthenticated must also 404, not 401
    assert.equal(asAnon.status, 404, 'admin routes indistinguishable from nonexistent to anon');

    const adminLogin = await call('POST', '/api/login', { email: 'admin@example.test', password: 'test-admin-passphrase-123' });
    assert.equal(adminLogin.status, 200);
    const asAdmin = await call('GET', '/api/admin/stats');
    assert.equal(asAdmin.status, 200);
    assert.equal(typeof asAdmin.data.users, 'number');
  });
});

// ---- TOTP end to end -----------------------------------------------------------------------
test('2FA: enable, then login requires a valid code', async () => {
  await withServer(async ({ app, call, clock }) => {
    await call('POST', '/api/register', { email: 't@b.com', password: 'longenough1' });
    const token = app.mailer.sent[0].text.match(/token=([^\s]+)/)[1];
    await call('GET', '/api/verify?token=' + token);
    const login = await call('POST', '/api/login', { email: 't@b.com', password: 'longenough1' });
    const csrf = login.data.csrf;
    const setup = await call('POST', '/api/2fa/setup', {}, { 'X-CSRF-Token': csrf });
    const secret = setup.data.secret;
    const en = await call('POST', '/api/2fa/enable', { totp: totpCode(secret, clock.t) }, { 'X-CSRF-Token': csrf });
    assert.equal(en.status, 200);
    assert.ok(Array.isArray(en.data.recovery) && en.data.recovery.length === 10);

    await call('POST', '/api/logout', {}, { 'X-CSRF-Token': csrf });
    const noCode = await call('POST', '/api/login', { email: 't@b.com', password: 'longenough1' });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.data.error, '2fa');
    const withCode = await call('POST', '/api/login', { email: 't@b.com', password: 'longenough1', totp: totpCode(secret, clock.t) });
    assert.equal(withCode.status, 200);
  });
});
