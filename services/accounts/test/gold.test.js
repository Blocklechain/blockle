import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// ---- harness: live server + a cookie jar (same shape as game.test.js) ----------------------
function freshApp(configExtra = {}, overrides = {}) {
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
    ...overrides,
  });
  return { app, dataDir, clock };
}

async function withServer(fn, configExtra = {}, overrides = {}) {
  const { app, dataDir, clock } = freshApp(configExtra, overrides);
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

// ---- fake Apple verifier (injected via overrides.goldVerifier) -----------------------------
// Test "receipts" are base64-encoded Apple verifyReceipt RESPONSES; the fake verifier just
// decodes them — so each test states exactly what Apple would have answered, and the route's
// policy (status/bundle/sku/txn-id replay guard) is what's under test. A receipt whose JSON
// says {throw:true} simulates Apple being unreachable.
const fakeVerifier = async (receipt) => {
  const j = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'));
  if (j.throw) throw new Error('network down');
  return j;
};
const enc = (resp) => Buffer.from(JSON.stringify(resp)).toString('base64');
function appleResp({ sku = 'gold_100', txn = 'TX-0001', bundle = 'org.blockle.blocklings', env = 'production', status = 0, inApp } = {}) {
  return enc({ status, environment: env, receipt: { bundle_id: bundle, in_app: inApp ?? [{ product_id: sku, transaction_id: txn }] } });
}
const GOLD_ON = { appleIapEnabled: true };
const VERIFIER = { goldVerifier: fakeVerifier };

// A plausibly-shaped (base64) receipt for tests that never reach the verifier.
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

    // APPLE_IAP_ENABLED is off by default -> fail closed, no credit, even for a receipt
    // the (injected) verifier WOULD accept.
    const iap = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({}), sku: 'gold_100' }, { 'X-CSRF-Token': csrf });
    assert.equal(iap.status, 503);
    assert.equal(iap.data.error, 'IAP not configured');
    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 0, 'no credit while disabled');
  }, {}, VERIFIER);
});

test('gold IAP happy path: Apple-verified receipt credits once; txn id + env recorded', async () => {
  await withServer(async ({ call, loginFresh, dataDir }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };

    // unknown sku + malformed receipts are rejected before verification
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: RECEIPT, sku: 'gold_999' }, h)).status, 400);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: 'short', sku: 'gold_100' }, h)).status, 400);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { receipt: 'not valid chars!!! ' + RECEIPT, sku: 'gold_100' }, h)).status, 400);
    assert.equal((await call('POST', '/account/api/game/gold/iap', { sku: 'gold_100' }, h)).status, 400);

    const ok = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ sku: 'gold_100', txn: 'TX-A', env: 'sandbox' }), sku: 'gold_100' }, h);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { ok: true, credited: 100, balance: 100 });

    // replay guard persisted: goldTxns holds the claimed transaction_id with env for audit
    const txns = JSON.parse(fs.readFileSync(path.join(dataDir, 'goldTxns.json'), 'utf8'));
    assert.ok(txns['apple:TX-A'], 'transaction_id claimed in goldTxns');
    assert.equal(txns['apple:TX-A'].sku, 'gold_100');
    assert.equal(txns['apple:TX-A'].gold, 100);
    assert.equal(txns['apple:TX-A'].env, 'sandbox');

    // a different transaction credits again (bigger pack)
    const ok2 = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ sku: 'gold_2600', txn: 'TX-B' }), sku: 'gold_2600' }, h);
    assert.equal(ok2.status, 200);
    assert.deepEqual(ok2.data, { ok: true, credited: 2600, balance: 2700 });
  }, GOLD_ON, VERIFIER);
});

test('gold IAP replayed transaction_id credits zero', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };
    const first = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ txn: 'TX-DUP' }), sku: 'gold_100' }, h);
    assert.equal(first.status, 200);

    // same receipt bytes replayed -> 409, no credit
    const dup = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ txn: 'TX-DUP' }), sku: 'gold_100' }, h);
    assert.equal(dup.status, 409);
    assert.equal(dup.data.ok, false);

    // DIFFERENT receipt bytes carrying the SAME transaction_id -> still 409 (the guard is
    // per transaction_id, not per receipt hash)
    const dup2 = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ txn: 'TX-DUP', env: 'sandbox' }), sku: 'gold_100' }, h);
    assert.equal(dup2.status, 409);
    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 100, 'replays credited zero');
  }, GOLD_ON, VERIFIER);
});

test('gold IAP: wrong bundle, sku mismatch, Apple-rejected, and unreachable all refuse to credit', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };

    // receipt from a different app's bundle
    const wrongBundle = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ bundle: 'org.evil.other' }), sku: 'gold_100' }, h);
    assert.equal(wrongBundle.status, 400);
    assert.match(wrongBundle.data.error, /different app/);

    // receipt is real but for a DIFFERENT product than the claimed sku
    const mismatch = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ sku: 'gold_100', txn: 'TX-M' }), sku: 'gold_2600' }, h);
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.data.error, /no purchase of this SKU/);

    // Apple says the receipt is invalid (nonzero status)
    const bad = await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ status: 21002 }), sku: 'gold_100' }, h);
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /21002/);

    // Apple unreachable -> 502, honest, nothing credited
    const down = await call('POST', '/account/api/game/gold/iap', { receipt: enc({ throw: true, pad: 'x'.repeat(32) }), sku: 'gold_100' }, h);
    assert.equal(down.status, 502);
    assert.equal(down.data.ok, false);
    assert.match(down.data.error, /unreachable/);

    assert.equal((await call('GET', '/account/api/game/gold')).data.balance, 0, 'no rejected path credited');
  }, GOLD_ON, VERIFIER);
});

test('gold IAP credits per NEW transaction when a receipt carries several', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };
    // first receipt: one gold_550 purchase
    const r1 = appleResp({ sku: 'gold_550', txn: 'TX-1' });
    assert.deepEqual((await call('POST', '/account/api/game/gold/iap', { receipt: r1, sku: 'gold_550' }, h)).data, { ok: true, credited: 550, balance: 550 });

    // updated unified receipt: the old TX-1 plus two new gold_550 purchases -> only the two
    // new transaction_ids credit (TX-1 already claimed)
    const r2 = appleResp({
      inApp: [
        { product_id: 'gold_550', transaction_id: 'TX-1' },
        { product_id: 'gold_550', transaction_id: 'TX-2' },
        { product_id: 'gold_550', transaction_id: 'TX-3' },
        { product_id: 'gold_100', transaction_id: 'TX-OTHER-SKU' }, // not the claimed sku — ignored
      ],
    });
    const ok = await call('POST', '/account/api/game/gold/iap', { receipt: r2, sku: 'gold_550' }, h);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { ok: true, credited: 1100, balance: 1650 });
  }, GOLD_ON, VERIFIER);
});

test('gold spend is atomic, rejects bad amounts, never goes negative', async () => {
  await withServer(async ({ call, loginFresh }) => {
    const csrf = await loginFresh();
    const h = { 'X-CSRF-Token': csrf };
    await call('POST', '/account/api/game/gold/iap', { receipt: appleResp({ sku: 'gold_550', txn: 'TX-SPEND' }), sku: 'gold_550' }, h);

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
  }, GOLD_ON, VERIFIER);
});

test('gold spend requires CSRF on cookie sessions', async () => {
  await withServer(async ({ call, loginFresh }) => {
    await loginFresh();
    const r = await call('POST', '/account/api/game/gold/spend', { amount: 1, reason: 'x' });
    assert.equal(r.status, 403);
  });
});
