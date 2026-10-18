// server.test.js — the /api/bridge/* HTTP surface the frontend + explorer consume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { BridgeStore } from '../src/store.js';
import { BridgeEngine } from '../src/statemachine.js';
import { createApp } from '../src/server.js';

function makeApp(cfgOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-srv-'));
  const cfg = loadConfig({
    dataDir: dir, confirmationDepth: 3,
    blockBridgeAddr: 'block1bridgereserveaddress00000000000000',
    ...cfgOverrides,
  });
  const store = new BridgeStore(dir);
  const engine = new BridgeEngine({ store, config: cfg });
  return createApp({ config: cfg, store, engine });
}

async function withServer(app, fn) {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try { await fn({ get, post }); } finally { app.stop(); }
}

test('info: not live without a wBLOCK mint; live once configured', async () => {
  await withServer(makeApp(), async ({ get }) => {
    const r = await get('/api/bridge/info');
    assert.equal(r.status, 200);
    assert.equal(r.body.live, false, 'not live without a mint');
    assert.equal(r.body.bridgeAddress, 'block1bridgereserveaddress00000000000000');
    assert.equal(r.body.confirmations, 3);
  });
  await withServer(makeApp({ solblockMint: 'So1b1ockMintPubkey1111111111111111111111111' }), async ({ get }) => {
    assert.equal((await get('/api/bridge/info')).body.live, true, 'live with a mint');
  });
});

test('reserves: zeros on a fresh bridge', async () => {
  await withServer(makeApp(), async ({ get }) => {
    const r = await get('/api/bridge/reserves');
    assert.equal(r.status, 200);
    assert.equal(r.body.reserveBlock, '0');
    assert.equal(r.body.wrappedSupply, '0');
  });
});

test('transfer: rejects before live; registers an intent once live and is fetchable', async () => {
  await withServer(makeApp(), async ({ post }) => {
    assert.equal((await post('/api/bridge/transfer', { direction: 'b2s', sourceTxid: 'a'.repeat(64), to: 'So1Dest11111111111111111111111111111111111', amountBase: '1000000000' })).status, 503);
  });
  await withServer(makeApp({ solblockMint: 'So1b1ockMintPubkey1111111111111111111111111' }), async ({ post, get }) => {
    const reg = await post('/api/bridge/transfer', { direction: 'b2s', sourceTxid: 'a'.repeat(64), to: 'So1Dest11111111111111111111111111111111111', amountBase: '1000000000' });
    assert.equal(reg.status, 200);
    assert.ok(reg.body.id, 'returns an id');
    const t = await get('/api/bridge/transactions/' + reg.body.id);
    assert.equal(t.status, 200);
    assert.equal(t.body.state, 'submitted');
    assert.equal(t.body.direction, 'deposit');
  });
});

test('transactions/{id}: 404 for unknown id', async () => {
  await withServer(makeApp(), async ({ get }) => {
    assert.equal((await get('/api/bridge/transactions/nope')).status, 404);
  });
});

test('health: reports reconciliation + cursors', async () => {
  await withServer(makeApp(), async ({ get }) => {
    const r = await get('/api/bridge/health');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.ok, 'boolean');
    assert.ok('reconciliation' in r.body);
  });
});
