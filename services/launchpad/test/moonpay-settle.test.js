// Launchpad MoonPay settle — AMOUNT re-validation (price-hole fix). The crypto launch-fee settle
// must not release a launch on a grant alone: it re-asserts that the accounts-recorded PAID amount
// covers THIS order's required fee (ord.usd). A mock accounts service serves a configurable grant
// so we can drive the underpaid/overpaid/exact cases with no real network or secret.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mutable grant table the mock accounts service serves at /account/api/moonpay/grant.
const grants = {}; // refId -> { granted, amountUsd, requiredUsd, status }
const accounts = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/account/api/moonpay/grant') {
    const refId = u.searchParams.get('refId') || '';
    const g = grants[refId] || null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ granted: !!(g && g.granted), amountUsd: (g && g.amountUsd) || null, requiredUsd: (g && g.requiredUsd) || null, status: (g && g.status) || null }));
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => accounts.listen(0, '127.0.0.1', r));
const accPort = accounts.address().port;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-lp-'));
process.env.LAUNCHPAD_PORT = '0';            // ephemeral port
process.env.LAUNCHPAD_DATA = dataDir;        // isolated state
process.env.LAUNCHPAD_COMMERCE = '1';        // crypto fee enabled
process.env.LAUNCHPAD_ACCOUNTS_URL = 'http://127.0.0.1:' + accPort;
process.env.LAUNCHPAD_KEYPAIR = path.join(dataDir, 'nope.json'); // preseed stays unavailable

const { server } = await import('../src/server.js');
await new Promise((r) => { if (server.listening) r(); else server.once('listening', r); });
const base = 'http://127.0.0.1:' + server.address().port;

async function call(method, p, body) {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}

after(() => { try { server.close(); } catch {} try { accounts.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });

test('settle releases only when granted AND paid >= the order fee', async () => {
  const start = await call('POST', '/api/launch/moonpay/start', {});
  assert.equal(start.status, 200);
  const orderId = start.data.orderId;
  assert.ok(orderId, 'returns an orderId');
  assert.equal(start.data.usd, 5, 'promo launch fee is $5');

  // 1) no grant yet -> pending (unchanged behavior)
  let s = await call('POST', '/api/launch/moonpay/settle', { orderId });
  assert.equal(s.data.pending, true);

  // 2) underpaid as the accounts webhook records it (granted:false) -> pending
  grants[orderId] = { granted: false, amountUsd: 1, requiredUsd: 5, status: 'underpaid' };
  s = await call('POST', '/api/launch/moonpay/settle', { orderId });
  assert.equal(s.data.ok, false);
  assert.equal(s.data.pending, true);

  // 3) DEFENSE IN DEPTH: even if the grant somehow said granted:true, a short paid amount
  //    ($1 < $5 fee) must still be rejected by the launchpad's own amount re-validation.
  grants[orderId] = { granted: true, amountUsd: 1, requiredUsd: 5, status: 'granted' };
  s = await call('POST', '/api/launch/moonpay/settle', { orderId });
  assert.equal(s.data.pending, true, 'underpaid grant is NOT settled even if granted:true');

  // 4) correct price -> settled
  grants[orderId] = { granted: true, amountUsd: 5, requiredUsd: 5, status: 'granted' };
  s = await call('POST', '/api/launch/moonpay/settle', { orderId });
  assert.equal(s.data.ok, true, 'exact-fee grant settles');
  assert.equal(s.data.paid, 5);
});
