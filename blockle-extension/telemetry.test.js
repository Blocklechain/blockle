// telemetry.test.js — unit tests for the anonymized agent-performance emitter.
// Run: node --test blockle-extension/telemetry.test.js
//
// Contract focus (from the PASS-2 task):
//   * payload contains NO secrets / seeds / creds / raw addresses,
//   * size (and fee) amounts are BUCKETED, never exact,
//   * disabled (the default) => no emit / no network call,
//   * identity is a rotating pseudonymous hash, not a wallet/account id,
//   * collector URL is configurable and defaults to the site,
//   * network failures never throw into the trading path.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentTelemetry = require('./telemetry.js');

// A fetch spy that records calls and can be made to fail.
function spyFetch(opts) {
  opts = opts || {};
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    if (opts.fail) throw new Error('network down');
    return { ok: true, status: 200 };
  };
  fn.calls = calls;
  return fn;
}

// A deterministic store shim (like the chrome.storage get/set shape).
function memStore(seed) {
  const data = Object.assign({}, seed);
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    _data: data,
  };
}

// A representative "closed trade" event carrying things that MUST NOT leak:
// a real-looking EVM address, a bech32 address, a mnemonic, and an API key.
const DIRTY_EVENT = {
  strategy: 'mean-reversion',
  venue: 'blockle-exchange',
  chain: 'base',
  pair: 'BLOCK/USDC',
  side: 'buy',
  sizeUsd: 3427.19,
  pnlPct: 4.237,
  holdTimeSec: 5400,
  result: 'win',
  slippagePct: 0.1234,
  feePaidUsd: 1.71,
  feePct: 0.05,
  intent: 'accumulate',
  outcome: 'filled',
  metIntent: true,
  // --- hostile fields that the whitelist must ignore / the scrubber must catch:
  fromAddress: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  toAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  seedPhrase: 'abandon abandon abandon ability able about above absent',
  apiKey: 'sk-ant-SHOULD-NEVER-APPEAR',
  privateKey: 'deadbeef'.repeat(8),
};

const SECRET_NEEDLES = [
  '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'abandon abandon abandon',
  'sk-ant-SHOULD-NEVER-APPEAR',
  'deadbeefdeadbeef',
];

// ---------------------------------------------------------------------------
// 1. DEFAULT OFF — no emit, no network
// ---------------------------------------------------------------------------
test('disabled by default => no emit and no network call', async () => {
  const fetchImpl = spyFetch();
  const t = AgentTelemetry.create({ fetchImpl, store: memStore() });
  assert.strictEqual(t.isEnabled(), false, 'telemetry must default to OFF');
  const r = await t.emit(DIRTY_EVENT);
  assert.strictEqual(r.emitted, false);
  assert.strictEqual(r.reason, 'disabled');
  assert.strictEqual(fetchImpl.calls.length, 0, 'no HTTP call when disabled');
});

test('explicitly disabled also never calls fetch', async () => {
  const fetchImpl = spyFetch();
  const t = AgentTelemetry.create({ enabled: false, fetchImpl });
  await t.emit(DIRTY_EVENT);
  await t.emit(DIRTY_EVENT);
  assert.strictEqual(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 2. NO SECRETS / ADDRESSES IN THE PAYLOAD
// ---------------------------------------------------------------------------
test('enabled emit payload contains NO secrets, seeds, creds, or raw addresses', async () => {
  const fetchImpl = spyFetch();
  const sink = [];
  const t = AgentTelemetry.create({
    enabled: true, fetchImpl, store: memStore(), sink: (p) => sink.push(p),
  });
  const r = await t.emit(DIRTY_EVENT);
  assert.strictEqual(r.emitted, true);
  assert.strictEqual(fetchImpl.calls.length, 1);

  const sent = fetchImpl.calls[0].body;
  const serialized = JSON.stringify(sent);
  for (const needle of SECRET_NEEDLES) {
    assert.ok(!serialized.includes(needle), 'payload must not contain: ' + needle);
  }
  // the hostile keys must not appear as fields at all
  for (const k of ['fromAddress', 'toAddress', 'seedPhrase', 'apiKey', 'privateKey', 'from', 'to', 'address']) {
    assert.ok(!(k in sent), 'payload must not carry field ' + k);
  }
  // sanity: the legit coarse fields DID make it through
  assert.strictEqual(sent.strategy, 'mean-reversion');
  assert.strictEqual(sent.venue, 'blockle-exchange');
  assert.strictEqual(sent.pair, 'BLOCK/USDC');
  assert.strictEqual(sent.result, 'win');
});

test('a disallowed field name anywhere trips the scrubber (emit refused, no throw)', async () => {
  const fetchImpl = spyFetch();
  const t = AgentTelemetry.create({ enabled: true, fetchImpl });
  // monkey-smuggle: force a bad field onto a built payload via the public builder
  const base = await t.buildPayload({ strategy: 's', venue: 'v', chain: 'c' });
  base.address = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  assert.throws(() => AgentTelemetry.assertNoSecrets(base), /disallowed field name/);
});

test('scrubber catches address/secret-shaped VALUES in whitelisted fields', async () => {
  // if a raw address were ever smuggled into e.g. venue, the scrubber rejects it
  assert.throws(
    () => AgentTelemetry.assertNoSecrets({ venue: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c' }),
    /secret\/address-like/,
  );
  assert.throws(
    () => AgentTelemetry.assertNoSecrets({ strategy: 'sk-antABCDEFGH12345678' }),
    /secret\/address-like/,
  );
  // a clean payload passes
  assert.doesNotThrow(() => AgentTelemetry.assertNoSecrets({ strategy: 'momentum', pair: 'BTC/USDC' }));
});

test('address-shaped label inputs are redacted, not passed through', async () => {
  const t = AgentTelemetry.create({ enabled: true });
  const p = await t.buildPayload({
    strategy: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    venue: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    pair: 'BLOCK/USDC',
  });
  assert.strictEqual(p.strategy, 'redacted');
  assert.strictEqual(p.venue, 'redacted');
  // and the scrubber is satisfied with the redacted result
  assert.doesNotThrow(() => AgentTelemetry.assertNoSecrets(p));
});

// ---------------------------------------------------------------------------
// 3. AMOUNTS ARE BUCKETED, NOT EXACT
// ---------------------------------------------------------------------------
test('size and fee are emitted as buckets, never the exact amount', async () => {
  const t = AgentTelemetry.create({ enabled: true });
  const p = await t.buildPayload(DIRTY_EVENT);
  assert.strictEqual(p.sizeBucket, '1k-10k');   // 3427.19 -> bucket
  assert.strictEqual(p.feeBucket, '<10');        // 1.71 -> bucket
  // the exact notional / fee must be absent anywhere in the payload
  const s = JSON.stringify(p);
  assert.ok(!s.includes('3427'), 'exact size must not appear');
  assert.ok(!s.includes('1.71'), 'exact fee must not appear');
  assert.ok(!('sizeUsd' in p) && !('notionalUsd' in p), 'raw size fields must be dropped');
  assert.ok(!('feePaidUsd' in p), 'raw fee field must be dropped');
});

test('bucketUsd boundaries', () => {
  const b = AgentTelemetry.bucketUsd;
  assert.strictEqual(b(0), '0');
  assert.strictEqual(b(5), '<10');
  assert.strictEqual(b(10), '10-100');
  assert.strictEqual(b(99.99), '10-100');
  assert.strictEqual(b(100), '100-1k');
  assert.strictEqual(b(999), '100-1k');
  assert.strictEqual(b(1000), '1k-10k');
  assert.strictEqual(b(250000), '100k-1m');
  assert.strictEqual(b(5000000), '1m+');
  assert.strictEqual(b(-1), 'unknown');
  assert.strictEqual(b('nope'), 'unknown');
});

test('hold time is bucketed', () => {
  const b = AgentTelemetry.bucketHoldTime;
  assert.strictEqual(b(30), '<1m');
  assert.strictEqual(b(1800), '1m-1h');
  assert.strictEqual(b(7200), '1h-1d');
  assert.strictEqual(b(200000), '1d-1w');
  assert.strictEqual(b(1000000), '1w+');
});

// ---------------------------------------------------------------------------
// 4. ROTATING PSEUDONYMOUS ID (no wallet/account identity)
// ---------------------------------------------------------------------------
test('agentId is a short hash, rotates with the clock, and is not derived from any account', async () => {
  let now = 1_700_000_000_000;
  const store = memStore();
  const t = AgentTelemetry.create({ enabled: true, store, clock: () => now, rotateMs: 86400000 });

  const id1 = await t.agentId();
  assert.match(id1, /^[0-9a-f]{16}$/, 'id is a 16-hex truncated sha256');

  // same rotation window => stable
  now += 1000;
  assert.strictEqual(await t.agentId(), id1);

  // next window => different id (uncorrelated)
  now += 86400000;
  const id2 = await t.agentId();
  assert.notStrictEqual(id2, id1);

  // the salt stays local — it is NOT in the emitted payload
  const fetchImpl = spyFetch();
  t.fetchImpl = fetchImpl;
  await t.emit({ strategy: 's', venue: 'v', chain: 'c' });
  const body = JSON.stringify(fetchImpl.calls[0].body);
  assert.ok(!body.includes(store._data.agentTelemetrySalt), 'local salt must never be transmitted');
});

test('two installs with different salts produce different ids for the same window', async () => {
  const clock = () => 1_700_000_000_000;
  const a = AgentTelemetry.create({ enabled: true, salt: 'aaaa', clock });
  const b = AgentTelemetry.create({ enabled: true, salt: 'bbbb', clock });
  assert.notStrictEqual(await a.agentId(), await b.agentId());
});

// ---------------------------------------------------------------------------
// 5. CONFIGURABLE COLLECTOR + SAFE FAILURE
// ---------------------------------------------------------------------------
test('collector URL defaults to the site and is configurable', async () => {
  assert.strictEqual(AgentTelemetry.DEFAULT_COLLECTOR, 'https://blockle.org/api/agent-telemetry');

  const d = AgentTelemetry.create({ enabled: true, fetchImpl: spyFetch() });
  assert.strictEqual(d.collectorUrl, 'https://blockle.org/api/agent-telemetry');

  const fetchImpl = spyFetch();
  const c = AgentTelemetry.create({ enabled: true, fetchImpl, collectorUrl: 'https://collector.example/t' });
  await c.emit({ strategy: 's', venue: 'v', chain: 'c' });
  assert.strictEqual(fetchImpl.calls[0].url, 'https://collector.example/t');
});

test('network failure is swallowed — emit never throws into the trading path', async () => {
  const fetchImpl = spyFetch({ fail: true });
  const t = AgentTelemetry.create({ enabled: true, fetchImpl });
  const r = await t.emit({ strategy: 's', venue: 'v', chain: 'c' });
  assert.strictEqual(r.emitted, false);
  assert.strictEqual(r.reason, 'network');
});

// ---------------------------------------------------------------------------
// 6. OPT-IN TOGGLE PERSISTS + DISCLOSURE PRESENT
// ---------------------------------------------------------------------------
test('setEnabled persists through the store and loadEnabled restores it', async () => {
  const store = memStore();
  const t1 = AgentTelemetry.create({ store });
  assert.strictEqual(t1.isEnabled(), false);
  await t1.setEnabled(true);
  assert.strictEqual(store._data.agentTelemetryEnabled, true);

  const t2 = AgentTelemetry.create({ store });
  await t2.loadEnabled();
  assert.strictEqual(t2.isEnabled(), true);
});

test('a clear opt-out/disclosure string is exported', () => {
  assert.ok(typeof AgentTelemetry.DISCLOSURE === 'string' && AgentTelemetry.DISCLOSURE.length > 40);
  assert.match(AgentTelemetry.DISCLOSURE, /off by default/i);
});

// ---------------------------------------------------------------------------
// 7. FIELD NORMALIZATION
// ---------------------------------------------------------------------------
test('win/loss, side, assetClass and outcome-vs-intent normalize correctly', async () => {
  const t = AgentTelemetry.create({ enabled: true });
  const p = await t.buildPayload({
    strategy: 'x', venue: 'v', chain: 'ethereum',
    pair: 'USDC/USDT', side: 'long', win: false, metIntent: false,
  });
  assert.strictEqual(p.side, 'buy');
  assert.strictEqual(p.result, 'loss');
  assert.strictEqual(p.assetClass, 'stablecoin');
  assert.strictEqual(p.outcomeMetIntent, false);
  // coarse minute-resolution timestamp
  assert.strictEqual(p.ts % 60000, 0);
});
