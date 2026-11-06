// MoonPay Commerce — server-verified grant flow. The client NEVER confirms its own purchase:
// /commerce only creates a pending checkout; the entitlement/grant flips ONLY when the verified
// webhook lands (identical trust model to PayPal/IAP). These tests drive that end to end with a
// mock MoonPay module so no real network/secret is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// A mock MoonPay that records the metadata handed to the checkout (so we can prove the webhook
// recovers userId/product/refId) and verifies every webhook.
function mockMoonpay() {
  const checkouts = {};
  let n = 0;
  return {
    enabled: true, live: true, commercePublicKey: 'commerce_pub_test',
    publicConfig: () => ({ enabled: true, live: true, publishableKey: 'pk_live_test', commercePublicKey: 'commerce_pub_test', features: { buy: true, sell: true, swap: true, commerce: true } }),
    signUrl: (u) => ({ signature: 'sig', url: u + '&signature=sig' }),
    verifyWebhook: () => ({ ok: true, reason: '' }),
    apiRequest: async () => ({ status: 200, body: {} }),
    commerceRequest: async () => ({ status: 200, body: {} }),
    commerceCheckout: async ({ amountUsd, currency, metadata }) => { const id = 'chk_' + (++n); checkouts[id] = { amountUsd, currency, metadata }; return { status: 200, body: { id, hostedUrl: 'https://commerce.moonpay.com/' + id } }; },
    commerceStatus: async (id) => ({ status: 200, body: { status: checkouts[id] ? 'pending' : 'unknown' } }),
    _checkouts: checkouts,
  };
}

function freshApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-mpc-'));
  const clock = { t: 1_700_000_000_000 };
  const moonpay = mockMoonpay();
  const app = createApp({
    now: () => clock.t, moonpay,
    config: {
      dataDir, prod: false, cookieSecure: false, mailTransport: 'stub', paypalEnv: 'stub',
      publicOrigin: 'http://127.0.0.1', adminEmail: 'admin@example.test', adminPassword: 'test-admin-passphrase-123',
      planName: 'Blockle Pro', sessionSecret: 'test-secret',
    },
  });
  return { app, dataDir, clock, moonpay };
}

async function withServer(fn) {
  const { app, dataDir, clock, moonpay } = freshApp();
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
  // Register → verify → login; returns the csrf for cookie mutations.
  async function signIn(email) {
    await call('POST', '/account/api/register', { email, password: 'longenough1' });
    const mail = app.mailer.sent.find((m) => m.to === email);
    const token = mail.text.match(/token=([^\s]+)/)[1];
    await call('GET', '/account/api/verify?token=' + token);
    const login = await call('POST', '/account/api/login', { email, password: 'longenough1' });
    return login.data.csrf;
  }
  try { await fn({ app, call, clock, moonpay, signIn }); }
  finally { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('config exposes the commerce public key + feature flag, never a secret', async () => {
  await withServer(async ({ call }) => {
    const c = await call('GET', '/account/api/moonpay/config');
    assert.equal(c.status, 200);
    assert.equal(c.data.commercePublicKey, 'commerce_pub_test');
    assert.equal(c.data.features.commerce, true);
    // no secret leaks
    assert.ok(!JSON.stringify(c.data).match(/sk_live|secret|webhook/i));
  });
});

test('/commerce is authed — anonymous create is rejected', async () => {
  await withServer(async ({ call }) => {
    const r = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'copilot', amountUsd: 9 });
    assert.equal(r.status, 401);
  });
});

test('copilot: create checkout does NOT grant; only the verified webhook flips the tier', async () => {
  await withServer(async ({ call, signIn, moonpay }) => {
    const csrf = await signIn('a@b.com');
    // create
    const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'copilot', amountUsd: 9 }, { 'X-CSRF-Token': csrf });
    assert.equal(mk.status, 200);
    const id = mk.data.checkoutId;
    assert.ok(id, 'returns a checkoutId');
    assert.ok(/commerce\.moonpay\.com/.test(mk.data.hostedUrl), 'returns the hosted url');
    // the metadata we signed server-side carries userId + product (client never supplied userId)
    assert.equal(moonpay._checkouts[id].metadata.product, 'copilot');
    assert.ok(moonpay._checkouts[id].metadata.userId);

    // still free before the webhook — the client cannot self-authorize
    let me = await call('GET', '/account/api/me');
    assert.notEqual((me.data.user.sub && me.data.user.sub.tier) || 'free', 'copilot');

    // status poll reflects pending, not granted
    const st = await call('POST', '/account/api/moonpay/commerce', { action: 'status', checkoutId: id }, { 'X-CSRF-Token': csrf });
    assert.equal(st.data.granted, false);

    // the VERIFIED webhook completes the checkout → grant applied
    const wh = await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed' } });
    assert.equal(wh.status, 200);

    me = await call('GET', '/account/api/me');
    assert.equal(me.data.user.sub.tier, 'copilot');
    assert.equal(me.data.user.sub.active, true);
    assert.equal(me.data.user.sub.provider, 'moonpay-commerce');

    // status now reports granted
    const st2 = await call('POST', '/account/api/moonpay/commerce', { action: 'status', checkoutId: id }, { 'X-CSRF-Token': csrf });
    assert.equal(st2.data.granted, true);
  });
});

test('launch_fee: webhook records a server-verified grant readable by the owning service', async () => {
  await withServer(async ({ call, signIn }) => {
    const csrf = await signIn('dev@b.com');
    const refId = 'mpc_order_123';
    const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'launch_fee', refId, amountUsd: 5 }, { 'X-CSRF-Token': csrf });
    const id = mk.data.checkoutId;

    // before the webhook the launchpad grant-check is false
    let g = await call('GET', '/account/api/moonpay/grant?product=launch_fee&refId=' + refId);
    assert.equal(g.data.granted, false);

    await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed' } });

    g = await call('GET', '/account/api/moonpay/grant?product=launch_fee&refId=' + refId);
    assert.equal(g.data.granted, true);
    assert.equal(g.data.amountUsd, 5);

    // a copilot-style sub was NOT created for a launch fee
    const me = await call('GET', '/account/api/me');
    assert.notEqual((me.data.user.sub && me.data.user.sub.tier) || 'free', 'copilot');
  });
});

test('webhook grant is idempotent (a replayed delivery does not double-apply)', async () => {
  await withServer(async ({ call, signIn }) => {
    const csrf = await signIn('c@b.com');
    const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'copilot_pro', amountUsd: 29 }, { 'X-CSRF-Token': csrf });
    const id = mk.data.checkoutId;
    await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed' } });
    await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed' } });
    const me = await call('GET', '/account/api/me');
    assert.equal(me.data.user.sub.tier, 'copilot_pro');
    assert.equal(me.data.user.sub.active, true);
  });
});

test('an unknown product is rejected and a bad amount is rejected (variable-price product)', async () => {
  await withServer(async ({ call, signIn }) => {
    const csrf = await signIn('d@b.com');
    const bad1 = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'free_money', amountUsd: 1 }, { 'X-CSRF-Token': csrf });
    assert.equal(bad1.status, 400);
    // bad amount only applies to VARIABLE-price products — a fixed product ignores the client
    // amount entirely (see the server-owned-price test), so the 0 check is exercised via nft.
    const bad2 = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'nft', refId: 'tok1', amountUsd: 0 }, { 'X-CSRF-Token': csrf });
    assert.equal(bad2.status, 400);
  });
});

// PRICE-HOLE FIX: for FIXED-price products the server OWNS the price. Whatever amount the client
// sends is IGNORED and the canonical server price (mirroring the PayPal/IAP tier prices + the
// launchpad $5 fee) is the amount actually charged by the MoonPay checkout.
test('fixed products: the server ignores client amountUsd and charges the canonical price', async () => {
  await withServer(async ({ call, signIn, moonpay }) => {
    const csrf = await signIn('price@b.com');
    const cases = [
      { product: 'copilot', client: 1, server: 19 },
      { product: 'copilot_pro', client: 1, server: 49 },
      { product: 'launch_fee', client: 1, refId: 'lf1', server: 5 },
    ];
    for (const c of cases) {
      const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: c.product, refId: c.refId, amountUsd: c.client }, { 'X-CSRF-Token': csrf });
      assert.equal(mk.status, 200, c.product + ' create ok');
      const id = mk.data.checkoutId;
      // the amount handed to MoonPay is the SERVER price, not the client's $1
      assert.equal(moonpay._checkouts[id].amountUsd, c.server, c.product + ' charged server price');
    }
  });
});

// UNDERPAYMENT GUARD — the core of the fix. A VERIFIED webhook that reports a paid amount BELOW
// the server price for a fixed product must NOT grant. (Even though the create path already
// forces the server price, a tampered/under-settled webhook amount is still rejected here.)
test('underpaid copilot / copilot_pro: verified-but-underpaid webhook does NOT grant the tier', async () => {
  await withServer(async ({ call, signIn }) => {
    for (const product of ['copilot', 'copilot_pro']) {
      const email = product + '@under.com';
      const csrf = await signIn(email);
      const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product, amountUsd: 1 }, { 'X-CSRF-Token': csrf });
      const id = mk.data.checkoutId;
      // webhook completes but reports only $1 paid — below the $19/$49 server price
      const wh = await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed', amount: 1 } });
      assert.equal(wh.status, 200);
      const me = await call('GET', '/account/api/me');
      assert.notEqual((me.data.user.sub && me.data.user.sub.tier) || 'free', product, product + ' NOT granted on underpayment');
      const st = await call('POST', '/account/api/moonpay/commerce', { action: 'status', checkoutId: id }, { 'X-CSRF-Token': csrf });
      assert.equal(st.data.granted, false, product + ' status not granted');
    }
  });
});

test('underpaid launch_fee: verified-but-underpaid webhook does NOT record a granted grant', async () => {
  await withServer(async ({ call, signIn }) => {
    const csrf = await signIn('lf@under.com');
    const refId = 'mpc_underpaid_launch';
    const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product: 'launch_fee', refId, amountUsd: 5 }, { 'X-CSRF-Token': csrf });
    const id = mk.data.checkoutId;
    // webhook reports $1 paid — below the $5 launch fee
    await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed', amount: 1 } });
    const g = await call('GET', '/account/api/moonpay/grant?product=launch_fee&refId=' + refId);
    assert.equal(g.data.granted, false, 'underpaid launch_fee is NOT granted');
    assert.equal(g.data.status, 'underpaid');
    assert.equal(g.data.amountUsd, 1, 'records the real (short) paid amount');
    assert.equal(g.data.requiredUsd, 5, 'records the required price for the owning service');
  });
});

// VARIABLE products (raid, nft): the accounts service cannot know the price, so it records the
// REAL paid amount in the grant. A consumer that enforces grant.amountUsd >= its own price will
// reject an underpayment — proven here by the recorded amount being the short amount.
test('underpaid raid / nft: the grant records the real short paid amount for the owning service to reject', async () => {
  await withServer(async ({ call, signIn }) => {
    for (const product of ['raid', 'nft']) {
      const csrf = await signIn(product + '@under.com');
      const refId = product + '_item_1';
      // the item's real server-side price (known to the owning service) is $50; the attacker
      // creates the checkout for $1 and the webhook confirms $1 paid.
      const ITEM_PRICE = 50;
      const mk = await call('POST', '/account/api/moonpay/commerce', { action: 'create', product, refId, amountUsd: 1 }, { 'X-CSRF-Token': csrf });
      const id = mk.data.checkoutId;
      await call('POST', '/account/api/moonpay/webhook', { type: 'checkout.completed', data: { id, status: 'completed', amount: 1 } });
      const g = await call('GET', '/account/api/moonpay/grant?product=' + product + '&refId=' + refId);
      // accounts records it granted (it can't know the price) BUT with the real short amount —
      // the owning service's check (amountUsd >= ITEM_PRICE) therefore fails and goods stay held.
      assert.equal(g.data.amountUsd, 1, product + ' records the short paid amount');
      assert.ok(!(Number(g.data.amountUsd) >= ITEM_PRICE), product + ' owning-service price check rejects');
    }
  });
});
