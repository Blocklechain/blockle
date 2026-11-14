import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// ---- harness: live server + a cookie jar (same shape as game.test.js) ----------------------
function freshApp(configExtra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-acct-'));
  const clock = { t: 1_700_000_000_000 };
  const app = createApp({
    now: () => clock.t,
    config: {
      dataDir, prod: false, cookieSecure: false, mailTransport: 'stub', paypalEnv: 'stub',
      publicOrigin: 'http://127.0.0.1', adminEmail: 'admin@example.test', adminPassword: 'test-admin-passphrase-123',
      planName: 'Blockle Pro', sessionSecret: 'test-secret',
      ...configExtra,
    },
  });
  return { app, dataDir, clock };
}

async function withServer(fn, configExtra = {}) {
  const { app, dataDir, clock } = freshApp(configExtra);
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

// A plausibly-shaped (base64) fake StoreKit receipt — structural validity only.
const RECEIPT = Buffer.from('fake-storekit-receipt-payload-for-tests-0001').toString('base64');

// ---- GOLD: server-authoritative IAP-only premium currency ----------------------------------
test('gold endpoints require auth', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('GET', '/account/api/game/gold')).status, 401);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_100' })).status, 401);
    assert.equal((await call('POST', '/account/api/game/gold/spend', { amount: 1, reason: 'x' })).status, 401);
  });
});

test('gold balance starts at zero and IAP 503s when not configured (never credits)', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const g0 = await call('GET', '/account/api/game/gold');
    assert.equal(g0.status, 200);
    assert.equal(g0.data.balance, 0);

    // APPLE_IAP_ENABLED is off by default -> fail closed, no credit.
    const iap = await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_100' }, { 'X-CSRF-Token': csrf });
    assert.equal(iap.status, 503);
    assert.equal(iap.data.error, 'IAP not configured');
    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 0, 'no credit while disabled');
  });
});

test('gold IAP credits once per receipt when enabled; bad sku/receipt rejected', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };

    // unknown sku + malformed receipts are rejected before any crediting
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_999' }, h)).status, 400);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: 'short', sku: 'gold_100' }, h)).status, 400);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: 'not valid chars!!! ' + RECEIPT, sku: 'gold_100' }, h)).status, 400);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { sku: 'gold_100' }, h)).status, 400);

    const ok = await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_100' }, h);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { ok: true, granted: 100, balance: 100 });

    // replaying the SAME receipt must not double-credit
    const dup = await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_100' }, h);
    assert.equal(dup.status, 409);
    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 100);

    // a different receipt credits again (bigger pack)
    const r2 = Buffer.from('fake-storekit-receipt-payload-for-tests-0002').toString('base64');
    const ok2 = await call('POST', '/account/api/game/gold/iap', { receipt: r2, sku: 'gold_2600' }, h);
    assert.equal(ok2.status, 200);
    assert.equal(ok2.data.balance, 2700);
  }, { appleIapEnabled: true });
});

test('gold spend is atomic, rejects bad amounts, never goes negative', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };
    await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_550' }, h);

    // rejected shapes: negative, zero, non-integer, missing reason
    for (const bad of [{ amount: -5, reason: 'x' }, { amount: 0, reason: 'x' }, { amount: 1.5, reason: 'x' }, { amount: '50', reason: 'x' }, { amount: 50 }]) {
      const r = await call('POST', '/account/api/game/gold/spend', bad, h);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 550, 'rejected spends did not debit');

    const s1 = await call('POST', '/account/api/game/gold/spend', { amount: 150, reason: 'market:listing-abc' }, h);
    assert.equal(s1.status, 200);
    assert.deepEqual(s1.data, { ok: true, balance: 400 });

    // overspend fails and leaves the balance untouched
    const over = await call('POST', '/account/api/game/gold/spend', { amount: 401, reason: 'market:too-much' }, h);
    assert.equal(over.status, 400);
    assert.equal(over.data.balance, 400);
    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 400);

    // spend-to-zero is fine
    const s2 = await call('POST', '/account/api/game/gold/spend', { amount: 400, reason: 'market:rest' }, h);
    assert.equal(s2.status, 200);
    assert.equal(s2.data.balance, 0);
  }, { appleIapEnabled: true });
});

test('gold spend requires CSRF on cookie sessions', async () => {
  await withServer(async ({ call, loginFresh }) => {
    await loginFresh();
    const r = await call('POST', '/account/api/game/gold/spend', { amount: 1, reason: 'x' });
    assert.equal(r.status, 403);
  });
});
