// agent/channels.test.js — unit tests for the multi-channel manager.
// Run: node --test blockle-extension/agent/
//
// Focus (per the PASS-2 contract): channel ISOLATION (caps + kill are
// independent per channel), PERSISTENCE roundtrip (records survive a reload and
// auto-resume, with the API key never persisted), and PROVIDER_GUIDES present.
// Plus the RED-3 guards: a value-moving channel refuses to start without caps
// and a confirmation handler.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentChannels = require('./channels.js');
const Agent = require('./index.js');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// In-memory Store matching storage.js's interface (get/set/remove).
function memStore() {
  const data = {};
  return {
    _data: data,
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete data[k];
    },
  };
}

// A credential resolver backed by a ref->cred map (stands in for the vault).
function resolver(map) {
  return async (credRef) => map[credRef] || null;
}

function baseOpts(store, overrides) {
  return Object.assign({
    store,
    resolveCredential: resolver({ main: { apiKey: 'sk-test', provider: 'claude' } }),
    confirm: async () => true,
    ctxFor: () => ({}),
    agentFactory: Agent,
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// PROVIDER_GUIDES present
// ---------------------------------------------------------------------------

test('guides: Claude/ChatGPT/Copilot/Other each expose how + url + provider', () => {
  const g = AgentChannels.PROVIDER_GUIDES;
  for (const key of ['claude', 'chatgpt', 'copilot', 'other']) {
    assert.ok(g[key], 'missing guide: ' + key);
    assert.equal(typeof g[key].how, 'string');
    assert.ok(g[key].how.length > 10, 'how text too short for ' + key);
    assert.equal(typeof g[key].url, 'string'); // 'other' may be empty
    assert.ok(Array.isArray(g[key].needs));
    assert.ok(g[key].provider, 'guide maps to an internal provider: ' + key);
  }
  // The three named providers point at real credential pages.
  assert.match(g.claude.url, /console\.anthropic\.com/);
  assert.match(g.chatgpt.url, /platform\.openai\.com/);
  assert.match(g.copilot.url, /github\.com/);
  // YELLOW-2: defaults must be valid current model ids, not the invalid ones.
  assert.notEqual(g.claude.defaultModel, 'claude-opus-5');
  assert.notEqual(g.chatgpt.defaultModel, 'gpt-4o');
});

// ---------------------------------------------------------------------------
// CHANNEL ISOLATION — caps are independent
// ---------------------------------------------------------------------------

test('isolation: per-channel caps do not bleed across channels', async () => {
  const mgr = AgentChannels.create(baseOpts(memStore()));
  await mgr.create({ id: 'a', label: 'tight', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });
  await mgr.create({ id: 'b', label: 'loose', walletId: 'w2', provider: 'claude', credRef: 'main', caps: { sessionUsd: 1000 }, start: true });

  const a = mgr.get('a');
  const b = mgr.get('b');

  // The tight channel rejects a $50 action; the loose one accepts it.
  assert.throws(() => a.instance.policy.assessValue({ asset: 'X', amount: '1', usd: 50 }), /session USD cap exceeded/);
  b.instance.policy.assessValue({ asset: 'X', amount: '1', usd: 50 }); // fine under 1000

  // Spending on one channel never accrues against the other.
  b.instance.policy.recordSpend({ asset: 'X', amount: '1', usd: 900 });
  assert.equal(a.instance.policy.spentUsd, 0);
});

// ---------------------------------------------------------------------------
// CHANNEL ISOLATION — kill is independent
// ---------------------------------------------------------------------------

test('isolation: killing one channel leaves the others live', async () => {
  const killed = [];
  const mgr = AgentChannels.create(baseOpts(memStore(), {
    onChannelKill: async (id) => { killed.push(id); },
  }));
  await mgr.create({ id: 'a', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });
  await mgr.create({ id: 'b', walletId: 'w2', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });

  const a = mgr.get('a');
  const b = mgr.get('b');
  assert.ok(a.running && b.running);

  await mgr.get('a').kill('test');

  // A is dead and its live credential/instance is gone; B is untouched.
  assert.equal(a.running, false);
  assert.equal(a.killed, true);
  assert.equal(a.instance, null);
  assert.deepEqual(killed, ['a']);          // only A's hook fired
  assert.equal(b.running, true);
  assert.equal(b.killed, false);
  assert.equal(b.instance.policy.isKilled(), false);
});

test('killAll: stops every channel and runs the global kill hook once', async () => {
  let globalKills = 0;
  const mgr = AgentChannels.create(baseOpts(memStore(), {
    onKill: async () => { globalKills++; },
  }));
  await mgr.create({ id: 'a', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });
  await mgr.create({ id: 'b', walletId: 'w2', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });

  await mgr.killAll('panic');
  assert.equal(globalKills, 1);
  for (const c of mgr.list()) {
    assert.equal(c.running, false);
    assert.equal(c.killed, true);
  }
});

// ---------------------------------------------------------------------------
// PERSISTENCE roundtrip
// ---------------------------------------------------------------------------

test('persistence: records survive a reload; the API key is never stored', async () => {
  const store = memStore();
  const mgr1 = AgentChannels.create(baseOpts(store));
  await mgr1.create({
    id: 'keep', label: 'BLOCK scalper', walletId: 'w9', accountId: 'block',
    provider: 'claude', model: 'claude-sonnet-4-5', credRef: 'main',
    caps: { sessionUsd: 25, perAsset: { BLOCK: '5000000000' } },
    config: { exchange: 'exchange.blockle.org', pairs: ['BLOCK/USDC'], allowlist: ['get_markets', 'swap'] },
    start: true,
  });

  // The persisted blob holds the record but no secret material.
  const raw = JSON.stringify(store._data);
  assert.ok(raw.includes('BLOCK scalper'));
  assert.ok(!raw.includes('sk-test'), 'API key must never be persisted');

  // A fresh manager over the same store reconstructs the channel identically.
  const mgr2 = AgentChannels.create(baseOpts(store));
  const loaded = await mgr2.load();
  assert.equal(loaded.length, 1);
  const c = mgr2.get('keep').describe();
  assert.equal(c.label, 'BLOCK scalper');
  assert.equal(c.walletId, 'w9');
  assert.equal(c.accountId, 'block');
  assert.equal(c.provider, 'claude');
  assert.equal(c.model, 'claude-sonnet-4-5');
  assert.equal(c.caps.sessionUsd, 25);
  assert.equal(c.caps.perAsset.BLOCK, '5000000000');
  assert.deepEqual(c.config.pairs, ['BLOCK/USDC']);
  assert.equal(c.enabled, true);          // was started => flagged for auto-resume
  assert.equal(c.running, false);         // but not live until resume()
});

test('persistence: resume() auto-starts enabled channels on unlock', async () => {
  const store = memStore();
  const mgr1 = AgentChannels.create(baseOpts(store));
  await mgr1.create({ id: 'on', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });
  await mgr1.create({ id: 'off', walletId: 'w2', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 } }); // never started

  const mgr2 = AgentChannels.create(baseOpts(store));
  await mgr2.load();
  const res = await mgr2.resume();
  assert.deepEqual(res.started, ['on']);
  assert.equal(mgr2.get('on').running, true);
  assert.equal(mgr2.get('off').running, false);
});

test('persistence: resume() skips (not throws) channels whose credential is gone', async () => {
  const store = memStore();
  const mgr1 = AgentChannels.create(baseOpts(store));
  await mgr1.create({ id: 'on', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });

  // New manager with an EMPTY resolver (as if the vault is locked / cred revoked).
  const mgr2 = AgentChannels.create(baseOpts(store, { resolveCredential: resolver({}) }));
  await mgr2.load();
  const res = await mgr2.resume();
  assert.deepEqual(res.started, []);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].id, 'on');
  assert.match(res.skipped[0].reason, /credential/);
});

// ---------------------------------------------------------------------------
// RED-3 guards — refuse value-moving until caps + confirm are set
// ---------------------------------------------------------------------------

test('guard: a value-moving channel refuses to start without caps', async () => {
  const mgr = AgentChannels.create(baseOpts(memStore()));
  await mgr.create({ id: 'nocaps', walletId: 'w1', provider: 'claude', credRef: 'main', caps: {} });
  await assert.rejects(() => mgr.start('nocaps'), /caps/);
});

test('guard: a value-moving channel refuses to start without a confirm handler', async () => {
  const mgr = AgentChannels.create(baseOpts(memStore(), { confirm: undefined }));
  await mgr.create({ id: 'noconfirm', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 } });
  await assert.rejects(() => mgr.start('noconfirm'), /confirmation handler/);
});

test('guard: a read-only channel may start without caps', async () => {
  const mgr = AgentChannels.create(baseOpts(memStore(), { confirm: undefined }));
  await mgr.create({ id: 'ro', walletId: 'w1', provider: 'claude', credRef: 'main', readOnly: true, caps: {} });
  const d = await mgr.start('ro');
  assert.equal(d.running, true);
  assert.equal(d.readOnly, true);
});

// ---------------------------------------------------------------------------
// Lifecycle: stop keeps the record, delete removes it
// ---------------------------------------------------------------------------

test('lifecycle: stop disconnects but keeps the record; delete removes it', async () => {
  const store = memStore();
  const mgr = AgentChannels.create(baseOpts(store));
  await mgr.create({ id: 'x', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 10 }, start: true });

  await mgr.stop('x');
  assert.equal(mgr.get('x').running, false);
  assert.equal(mgr.get('x').describe().enabled, false); // won't auto-resume
  assert.equal(mgr.list().length, 1);                   // record kept

  assert.equal(await mgr.delete('x'), true);
  assert.equal(mgr.get('x'), null);
  assert.equal(mgr.list().length, 0);
  assert.ok(!(AgentChannels.STORE_KEY in store._data) || store._data[AgentChannels.STORE_KEY].length === 0);
});

// ---------------------------------------------------------------------------
// P&L tracking is per channel
// ---------------------------------------------------------------------------

test('pnl: realized P&L is recorded per channel and persisted in the summary', async () => {
  const store = memStore();
  const mgr = AgentChannels.create(baseOpts(store));
  await mgr.create({ id: 'p', walletId: 'w1', provider: 'claude', credRef: 'main', caps: { sessionUsd: 100 }, start: true });

  await mgr.get('p').recordPnl({ realizedUsd: 12.5, label: 'BLOCK/USDC swap' });
  await mgr.get('p').recordPnl({ realizedUsd: -3.0, label: 'fee' });

  const d = mgr.get('p').describe();
  assert.equal(d.pnl.realizedUsd, 9.5);

  // Survives reload via the persisted summary.
  const mgr2 = AgentChannels.create(baseOpts(store));
  await mgr2.load();
  assert.equal(mgr2.get('p').describe().pnl.realizedUsd, 9.5);
});
