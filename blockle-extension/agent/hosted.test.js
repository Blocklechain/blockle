// agent/hosted.test.js — the KEYLESS hosted provider + the SAFETY INVARIANT.
// Run: node --test agent/
//
// Proves:
//   * the `hosted` provider yields a working turn() with ONLY a session token
//     (no apiKey ever sent), and returns the normalized { text?, toolCalls? }
//   * the session is transparently refreshed (re-sign) on a 401
//   * the hosted connection persists (vault-sealed) + refreshes in agent-store
//   * THE INVARIANT: a hosted provider returning a MALICIOUS toolCall is still
//     blocked by the CLIENT policy gate (cap/confirm) exactly like a BYO
//     provider — the gateway/LLM can never move funds, and a danger-severity
//     security pre-sign still forces a human confirm.
const { test } = require('node:test');
const assert = require('node:assert');

// ---- in-memory chrome.storage shim (BEFORE requiring storage.js) -----------
function memArea() {
  const m = new Map();
  return {
    async get(keys) {
      if (keys == null) { const o = {}; for (const [k, v] of m) o[k] = v; return o; }
      const list = Array.isArray(keys) ? keys : typeof keys === 'object' ? Object.keys(keys) : [keys];
      const out = {};
      for (const k of list) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); },
    _map: m,
  };
}
globalThis.chrome = { storage: { local: memArea(), session: memArea() } };

require('../storage.js');     // -> Store, Session
require('../vault.js');       // -> Vault
require('../agent-store.js'); // -> AgentStore
const AgentProviders = require('./providers.js');
const AgentPolicy = require('./policy.js');
const AgentRunner = require('./runner.js');

// A mock fetch: given a router (url,init) -> { status, json }.
function mockFetch(router) {
  const calls = [];
  const f = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, headers: (init && init.headers) || {}, body });
    const r = router(url, body, calls.length);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async json() { return r.json || {}; },
      async text() { return JSON.stringify(r.json || {}); },
    };
  };
  f.calls = calls;
  return f;
}

// ---------------------------------------------------------------------------
// 1. HOSTED PROVIDER — keyless turn()
// ---------------------------------------------------------------------------

test('hosted provider: turn() works with ONLY a session token (no apiKey sent)', async () => {
  const fetchImpl = mockFetch((url) => {
    assert.ok(url.endsWith('/agent/turn'));
    return { status: 200, json: { text: 'proposing a swap', toolCalls: [{ id: 't1', name: 'swap', arguments: { amount: '10' } }] } };
  });
  const p = AgentProviders.create({ provider: 'hosted', gatewayUrl: 'https://gw.test/', sessionToken: 'sess-abc', fetchImpl });
  const out = await p.turn({ system: 's', messages: [{ role: 'user', text: 'swap 10' }], tools: [{ name: 'swap' }] });
  assert.equal(out.text, 'proposing a swap');
  assert.equal(out.toolCalls[0].name, 'swap');
  // the request carried the sessionToken and NEVER an apiKey
  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.sessionToken, 'sess-abc');
  assert.ok(!('apiKey' in sent), 'hosted turn must not send an apiKey');
  assert.ok(!('x-api-key' in (fetchImpl.calls[0].headers || {})));
  assert.ok(!('authorization' in (fetchImpl.calls[0].headers || {})));
});

test('hosted provider: requires gatewayUrl + sessionToken, never an apiKey', () => {
  assert.throws(() => AgentProviders.create({ provider: 'hosted', sessionToken: 'x' }), /gatewayUrl/);
  assert.throws(() => AgentProviders.create({ provider: 'hosted', gatewayUrl: 'https://gw' }), /sessionToken/);
  // create() must NOT demand an apiKey for hosted (the BYO guard is bypassed)
  const p = AgentProviders.create({ provider: 'hosted', gatewayUrl: 'https://gw', sessionToken: 't' });
  assert.equal(p.name, 'hosted');
});

test('hosted provider: a 401 triggers ONE transparent refresh + retry', async () => {
  let refreshed = 0;
  const fetchImpl = mockFetch((url, body) => {
    if (body.sessionToken === 'stale') return { status: 401, json: { error: 'expired' } };
    return { status: 200, json: { text: 'ok after refresh' } };
  });
  const p = AgentProviders.create({
    provider: 'hosted', gatewayUrl: 'https://gw', sessionToken: 'stale', fetchImpl,
    refresh: async () => { refreshed++; return 'fresh'; },
  });
  const out = await p.turn({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [] });
  assert.equal(refreshed, 1);
  assert.equal(out.text, 'ok after refresh');
  assert.equal(p.sessionToken, 'fresh');
});

// ---------------------------------------------------------------------------
// 2. HOSTED SESSION HANDSHAKE + AGENT-STORE PERSISTENCE/REFRESH
// ---------------------------------------------------------------------------

test('hostedSession: challenge -> sign -> verify yields a stored connection', async () => {
  const fetchImpl = mockFetch((url, body) => {
    assert.ok(url.endsWith('/agent/session'));
    if (body.step === 'challenge') return { status: 200, json: { challenge: 'nonce-123', expiresAt: Date.now() + 1000 } };
    if (body.step === 'verify') {
      assert.equal(body.challenge, 'nonce-123');
      assert.equal(body.signature, 'sig-of-nonce-123');
      return { status: 200, json: { sessionToken: 'tok-1', expiresAt: Date.now() + 900000, quota: { reqPerMin: 20 } } };
    }
    throw new Error('unexpected step ' + body.step);
  });
  const sess = await AgentProviders.hostedSession({
    gatewayUrl: 'https://gw.test', address: 'block1abc', chain: 'block', fetchImpl,
    sign: async (msg) => ({ signature: 'sig-of-' + msg, publicKey: 'pub-hex' }),
  });
  assert.equal(sess.sessionToken, 'tok-1');
  assert.equal(sess.gatewayUrl, 'https://gw.test');
  assert.equal(sess.address, 'block1abc');
  assert.equal(sess.publicKey, 'pub-hex');
});

test('agent-store: hosted connection persists (sealed, no apiKey) + refreshes', async () => {
  const fetchImpl = mockFetch((url, body) => {
    if (body.step === 'challenge') return { status: 200, json: { challenge: 'n1' } };
    return { status: 200, json: { sessionToken: 'tok-A', expiresAt: 111, quota: {} } };
  });
  await AgentStore.unlock('wallet-pw');
  const view = await AgentStore.connectHosted({
    gatewayUrl: 'https://gw.test', address: 'block1abc', chain: 'block', fetchImpl,
    sign: async (msg) => ({ signature: 's', publicKey: 'pub' }),
  });
  assert.equal(view.provider, 'hosted');
  // secret-free list: NO sessionToken leaks into the UI view
  const listed = AgentStore.list().find((c) => c.credRef === view.credRef);
  assert.equal(listed.provider, 'hosted');
  assert.equal(listed.gatewayUrl, 'https://gw.test');
  assert.ok(!('sessionToken' in listed), 'the session token must never be in the secret-free list');
  assert.ok(!('apiKey' in listed));
  // resolve() returns the transport fields (incl. token) for the provider
  const cred = AgentStore.resolve(view.credRef);
  assert.equal(cred.provider, 'hosted');
  assert.equal(cred.sessionToken, 'tok-A');
  assert.ok(!('apiKey' in cred), 'a hosted cred has NO apiKey');

  // persists across a lock/reopen (sealed to disk under the wallet password)
  await AgentStore.lock();
  await AgentStore.unlock('wallet-pw');
  const reopened = AgentStore.resolve(view.credRef);
  assert.equal(reopened.sessionToken, 'tok-A');

  // transparent refresh updates the token in place
  const ok = await AgentStore.refreshHosted(view.credRef, 'tok-B', 222);
  assert.equal(ok, true);
  assert.equal(AgentStore.resolve(view.credRef).sessionToken, 'tok-B');
  assert.equal(AgentStore.resolve(view.credRef).expiresAt, 222);
});

// ---------------------------------------------------------------------------
// 3. THE SAFETY INVARIANT — hosted proposals are STILL gated client-side
// ---------------------------------------------------------------------------

// A minimal value-moving tools registry whose commit() records if it ran.
function harness(toolCallScript, prepareOver) {
  const committed = [];
  const tool = {
    name: 'send',
    valueMoving: true,
    async prepare(args) {
      return Object.assign({
        summary: { action: 'send', to: args.to, amount: args.amount },
        value: { asset: 'BLOCK', amount: String(args.amount), usd: args.usd != null ? args.usd : 1e9 },
        commit: async () => { committed.push(args); return { txid: 'SHOULD_NOT_HAPPEN' }; },
      }, prepareOver ? prepareOver(args) : {});
    },
  };
  const tools = {
    names: () => ['send'],
    valueMovingNames: () => ['send'],
    schemas: () => [{ name: 'send', description: 'send funds', parameters: { type: 'object' } }],
    get: (n) => (n === 'send' ? tool : null),
  };
  // a hosted provider wired to a mock gateway that returns the malicious toolCall
  const fetchImpl = mockFetch(() => ({ status: 200, json: toolCallScript.shift() || { text: 'done' } }));
  const provider = AgentProviders.create({ provider: 'hosted', gatewayUrl: 'https://evil-gw', sessionToken: 'sess', fetchImpl });
  return { tool, tools, provider, committed };
}

test('INVARIANT: a hosted provider proposing a huge send is HARD-REJECTED by the client cap (never commits)', async () => {
  const h = harness([
    { text: 'I will send everything', toolCalls: [{ id: 't1', name: 'send', arguments: { to: 'block1attacker', amount: '99999999999', usd: 5000000 } }] },
  ]);
  const policy = AgentPolicy.create({ caps: { sessionUsd: 10 }, confirm: async () => true });
  const runner = AgentRunner.create({ provider: h.provider, tools: h.tools, policy, maxTurns: 2 });
  await runner.run('do something');
  // The gateway/LLM PROPOSED a fund-moving call; the CLIENT gate refused it.
  assert.equal(h.committed.length, 0, 'a compromised gateway/LLM must NEVER cause a commit');
});

test('INVARIANT: a hosted malicious call is gated IDENTICALLY to a BYO provider (declined confirm -> no commit)', async () => {
  let asked = 0;
  const h = harness([
    { toolCalls: [{ id: 't1', name: 'send', arguments: { to: 'block1attacker', amount: '5', usd: 1 } }] },
  ]);
  // under cap, but the user DECLINES the mandatory confirmation
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => { asked++; return false; } });
  const runner = AgentRunner.create({ provider: h.provider, tools: h.tools, policy, maxTurns: 2 });
  await runner.run('do something');
  assert.ok(asked >= 1, 'the client confirm gate still runs for a hosted proposal');
  assert.equal(h.committed.length, 0, 'declining the confirm blocks the commit');
});

test('INVARIANT: a DANGER-severity security pre-sign FORCES a confirm even under auto-approve', async () => {
  let forced = null;
  const h = harness([
    { toolCalls: [{ id: 't1', name: 'send', arguments: { to: 'block1attacker', amount: '1', usd: 0.01 } }] },
  ], () => ({
    // the tool's prepare() attaches a DANGER inspection (security pre-sign gate)
    security: { severity: 'danger', warnings: [{ code: 'drainer' }] },
    forceConfirm: true,
  }));
  // auto-approve tiny spends — but a danger inspection must STILL force a confirm
  const policy = AgentPolicy.create({
    caps: { sessionUsd: 1000 }, autoApproveUnderUsd: 100,
    confirm: async (summary) => { forced = summary; return false; },
  });
  const runner = AgentRunner.create({ provider: h.provider, tools: h.tools, policy, maxTurns: 2 });
  await runner.run('tiny send');
  assert.ok(forced, 'the danger pre-sign forced a human confirm despite auto-approve');
  assert.ok(forced.security && forced.security.severity === 'danger');
  assert.equal(h.committed.length, 0);
});
