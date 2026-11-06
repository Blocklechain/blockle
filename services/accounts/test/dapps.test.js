import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { CURATED_DAPPS } from '../src/dapps.js';

// Minimal live-server harness (mirrors accounts.test.js), no auth needed for these public routes.
async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-dapps-'));
  const clock = { t: 1_700_000_000_000 };
  const app = createApp({
    now: () => clock.t,
    config: {
      dataDir, prod: false, cookieSecure: false, mailTransport: 'stub', paypalEnv: 'stub',
      publicOrigin: 'http://127.0.0.1', adminEmail: 'admin@example.test', adminPassword: 'test-admin-passphrase-123',
      sessionSecret: 'test-secret',
    },
  });
  await app.ensureAdmin();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(method, p, body) {
    const r = await fetch(base + p, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data, raw: r };
  }
  try { await fn({ app, call }); }
  finally { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('GET /account/api/dapps returns the curated seed, CORS-open, in curated order', async () => {
  await withServer(async ({ call }) => {
    const r = await call('GET', '/account/api/dapps');
    assert.equal(r.status, 200);
    assert.equal(r.raw.headers.get('access-control-allow-origin'), '*');
    assert.ok(Array.isArray(r.data));
    assert.equal(r.data.length, CURATED_DAPPS.length);
    // Shape of each entry.
    for (const d of r.data) {
      assert.ok(typeof d.id === 'string' && d.id);
      assert.ok(typeof d.name === 'string' && d.name);
      assert.ok(typeof d.url === 'string' && d.url.startsWith('https://'));
      assert.ok(Array.isArray(d.chains) && d.chains.length >= 1);
      assert.equal(typeof d.popularity, 'number');
    }
    // Sparse counts → curated default order (highest base popularity first = uniswap).
    assert.equal(r.data[0].id, 'uniswap');
    // Spans multiple chains / families.
    const chainSet = new Set(r.data.flatMap((d) => d.chains));
    for (const c of ['ethereum', 'solana', 'bnb', 'ton', 'tron']) assert.ok(chainSet.has(c), `features ${c}`);
  });
});

test('POST /account/api/dapps/open increments a pseudonymous counter and reranks', async () => {
  await withServer(async ({ call, app }) => {
    // Open the LOWEST-seeded dApp enough times to overtake the top curated one.
    const top = CURATED_DAPPS[0];           // uniswap, popularity 100
    const low = CURATED_DAPPS[CURATED_DAPPS.length - 1]; // sunswap, popularity 76
    const need = top.popularity - low.popularity + 1;    // opens required to overtake
    for (let i = 0; i < need; i++) {
      const o = await call('POST', '/account/api/dapps/open', { id: low.id });
      assert.equal(o.status, 200);
      assert.equal(o.data.ok, true);
    }
    // Counter is pseudonymous: a single per-id integer, no uid/PII.
    await app.store.drain();
    const rec = app.store.get('dapp_opens', low.id);
    assert.equal(rec.count, need);
    assert.deepEqual(Object.keys(rec), ['count']);

    // GET now ranks the heavily-opened dApp first.
    const r = await call('GET', '/account/api/dapps');
    assert.equal(r.status, 200);
    assert.equal(r.data[0].id, low.id, 'opens overlay onto the curated base rank');
    assert.equal(r.data[0].popularity, low.popularity + need);
  });
});

test('POST /account/api/dapps/open rejects unknown ids so the counter cannot be polluted', async () => {
  await withServer(async ({ call, app }) => {
    const r = await call('POST', '/account/api/dapps/open', { id: 'evil-phishing-dapp' });
    assert.equal(r.status, 400);
    await app.store.drain();
    assert.equal(app.store.get('dapp_opens', 'evil-phishing-dapp'), null);
    // Missing id is rejected too.
    const r2 = await call('POST', '/account/api/dapps/open', {});
    assert.equal(r2.status, 400);
  });
});
