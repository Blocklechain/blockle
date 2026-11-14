import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// ---- harness: live server + a cookie jar (same shape as accounts.test.js) ------------------
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
  async function loginFresh(email = 'q@b.com') {
    await call('POST', '/account/api/register', { email, password: 'longenough1' });
    const token = app.mailer.sent.find((m) => m.to === email).text.match(/token=([^\s]+)/)[1];
    await call('GET', '/account/api/verify?token=' + token);
    const login = await call('POST', '/account/api/login', { email, password: 'longenough1' });
    return login.data.csrf;
  }
  try { await fn({ app, call, clock, dataDir, base, loginFresh }); }
  finally { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

// ---- game character storage ----------------------------------------------------------------
test('game character requires auth', async () => {
  await withServer(async ({ call }) => {
    const g = await call('GET', '/account/api/game/character');
    assert.equal(g.status, 401);
    const p = await call('PUT', '/account/api/game/character', { character: { name: 'Zed' } });
    assert.equal(p.status, 401);
  });
});

test('game character put then get roundtrips', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();

    const g0 = await call('GET', '/account/api/game/character');
    assert.equal(g0.status, 200);
    assert.equal(g0.data.character, null, 'null before any save');

    const char = { name: 'Zed', class: 'mage', level: 7, inventory: ['staff', 'potion'], pos: { x: 12, y: 34 } };
    const put = await call('PUT', '/account/api/game/character', { character: char }, { 'X-CSRF-Token': csrf });
    assert.equal(put.status, 200);
    assert.deepEqual(put.data, { ok: true });

    const g1 = await call('GET', '/account/api/game/character');
    assert.equal(g1.status, 200);
    assert.deepEqual(g1.data.character, char, 'returns exactly what was stored');
  });
});

test('game character rejects oversize and non-object payloads', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();

    // > 16384 chars when stringified
    const big = { blob: 'x'.repeat(16385) };
    const over = await call('PUT', '/account/api/game/character', { character: big }, { 'X-CSRF-Token': csrf });
    assert.equal(over.status, 400);
    assert.ok(over.data.error);

    // arrays and primitives are not plain objects
    const arr = await call('PUT', '/account/api/game/character', { character: [1, 2, 3] }, { 'X-CSRF-Token': csrf });
    assert.equal(arr.status, 400);
    const prim = await call('PUT', '/account/api/game/character', { character: 'nope' }, { 'X-CSRF-Token': csrf });
    assert.equal(prim.status, 400);
    const missing = await call('PUT', '/account/api/game/character', {}, { 'X-CSRF-Token': csrf });
    assert.equal(missing.status, 400);

    // nothing was persisted by the rejected writes
    const g = await call('GET', '/account/api/game/character');
    assert.equal(g.data.character, null);
  });
});
