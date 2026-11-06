// agent/rag.test.js — the CLIENT-SIDE RAG layer + local-LLM provider + the
// no-silent-hosted-default contract. Run: node --test blockle-extension/agent/
//
// Covers the three changes wired into the extension wallet:
//   1. LOCAL provider preset — keyless OpenAI-compatible (Ollama/LM Studio): it is
//      selectable with NO apiKey, defaults to http://localhost:11434, and omits the
//      Authorization header when the key is empty.
//   2. NO SILENT HOSTED DEFAULT — the agent refuses to start without a configured
//      credential (it never falls back to the hosted gateway on its own); hosted is
//      only used when explicitly configured.
//   3. CLIENT RAG — the offline retriever is deterministic (fixed top-K for a
//      sample query), always force-includes the 'custody' safety fact, and the
//      command router injects the grounding block into BOTH assembly sites
//      (runAction + runQuery) without granting any new tool power.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentRAG = require('./rag.js');
const AgentProviders = require('./providers.js');
const AgentPolicy = require('./policy.js');
const AgentTools = require('./tools.js');
const AgentRunner = require('./runner.js');
const AgentCommand = require('./command.js');
const Agent = require('./index.js');

// ---------------------------------------------------------------------------
// 1. LOCAL provider preset — keyless, localhost default, no Authorization header
// ---------------------------------------------------------------------------
test('local provider is selectable with NO apiKey and defaults to localhost:11434', () => {
  const p = AgentProviders.create({ provider: 'local' });
  assert.equal(p.name, 'local');
  assert.equal(p.local, true);
  assert.equal(p.baseUrl, 'http://localhost:11434');
  assert.equal(p.model, 'qwen2.5:3b-instruct');
  assert.equal(p.apiKey, ''); // keyless — tolerated, never required
});

test('local provider accepts the LM Studio preset base URL + a custom model', () => {
  const p = AgentProviders.create({ provider: 'local', baseUrl: 'http://localhost:1234', model: 'llama3.2' });
  assert.equal(p.baseUrl, 'http://localhost:1234');
  assert.equal(p.model, 'llama3.2');
});

test('local provider OMITS the Authorization header when keyless', async () => {
  let seenHeaders = null;
  const p = AgentProviders.create({
    provider: 'local',
    fetchImpl: async (_url, opts) => { seenHeaders = opts.headers; return { ok: true, json: async () => ({ choices: [{ message: { content: 'ready' } }] }) }; },
  });
  await p.turn({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [] });
  assert.ok(!('authorization' in seenHeaders), 'no Authorization header for a keyless local server');
});

test('a BYO-key OpenAI provider STILL sends the Authorization header', async () => {
  let seenHeaders = null;
  const p = AgentProviders.create({
    provider: 'openai', apiKey: 'sk-test',
    fetchImpl: async (_url, opts) => { seenHeaders = opts.headers; return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; },
  });
  await p.turn({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [] });
  assert.equal(seenHeaders.authorization, 'Bearer sk-test');
});

// ---------------------------------------------------------------------------
// 2. NO SILENT HOSTED DEFAULT — unconfigured agent refuses to start
// ---------------------------------------------------------------------------
test('Agent.start refuses (does NOT fall back to hosted) when no credential is configured', () => {
  assert.throws(() => Agent.start({ credential: {} }), /not configured/i);
  assert.throws(() => Agent.start({ credential: { provider: 'openai' } }), /not configured/i); // no apiKey
});

test('local credential starts the agent WITHOUT any apiKey or hosted gateway', () => {
  const inst = Agent.start({
    credential: { provider: 'local', baseUrl: 'http://localhost:11434', model: 'qwen2.5:3b-instruct' },
    ctx: {}, confirm: async () => true,
  });
  assert.ok(inst && typeof inst.run === 'function');
  assert.equal(inst.runner.provider.name, 'local');
});

// ---------------------------------------------------------------------------
// 3a. RETRIEVER — deterministic top-K + forced custody fact
// ---------------------------------------------------------------------------
test('retriever returns a deterministic, ranked top-K for a sample query', () => {
  const q = 'which grid strategy made money and what are its knobs';
  const ids = AgentRAG.retrieve(q).map((c) => c.id);
  // exact, reproducible output (BM25-lite k1=1.5 b=0.75, K=5, custody forced):
  assert.deepEqual(ids, ['nl-commands', 'strat-grid', 'strat-meanrev', 'strat-macd', 'planners-pure', 'custody']);
  // running it again yields the IDENTICAL order (no randomness, cached index)
  assert.deepEqual(AgentRAG.retrieve(q).map((c) => c.id), ids);
});

test("retrieve ALWAYS force-includes the 'custody' safety fact", () => {
  for (const q of ['how do I do a DCA bot', 'what is my net worth', 'install ollama locally', 'rebalance my portfolio']) {
    const ids = AgentRAG.retrieve(q).map((c) => c.id);
    assert.ok(ids.includes('custody'), "custody must be present for: " + q);
  }
});

test('a query with no corpus hit returns [] (live-only, never padded)', () => {
  assert.deepEqual(AgentRAG.retrieve('zzzxqq nomatch gibberish'), []);
});

// The shared corpus carries the dApp-SECURITY chunks (#127) so the local AI can
// screen a connect request. A dApp-connect/security query must surface them.
test('dApp-security chunks are present and retrievable for a connect/security query', () => {
  const ids = new Set(AgentRAG.CORPUS.map((c) => c.id));
  for (const id of ['dapp-connect-screening', 'dapp-phishing', 'dapp-drainer',
    'dapp-approval-abuse', 'dapp-malicious-signature', 'dapp-airdrop-seed-theft',
    'dapp-protector-guidance']) {
    assert.ok(ids.has(id), 'corpus has ' + id);
  }
  const hits = AgentRAG.retrieve('dApp connect security screening phishing drainer approval signature permit')
    .map((c) => c.id);
  // at least a few of the dApp-security chunks rank into the top-K for this query
  const surfaced = hits.filter((id) => id.startsWith('dapp-'));
  assert.ok(surfaced.length >= 3, 'dApp-security chunks surface: ' + JSON.stringify(hits));
  assert.ok(hits.includes('custody'), 'custody safety floor still rides along');
});

// ---------------------------------------------------------------------------
// 3b. groundSystem — prepends a read-only block carrying facts + live context
// ---------------------------------------------------------------------------
test('groundSystem prepends the grounding block (facts + custody + live) to the base system', () => {
  const base = 'BASE_SYSTEM_PROMPT';
  const out = AgentRAG.groundSystem(base, 'how does the grid strategy work', {
    live: { chain: 'mainnet', balances: [{ symbol: 'USDC', amount: 100 }], bots: [{ strategy: 'grid', market: 'SOL/USDC', budget: 50 }] },
  });
  assert.ok(out.startsWith(base), 'the base prompt stays first');
  assert.ok(out.includes('[Blockle knowledge'), 'the knowledge header is present');
  assert.ok(out.includes('[Live context]'), 'the live-context section is present');
  assert.ok(/Custody and signing never depend on the LLM/.test(out), 'the custody safety fact rides along');
  assert.ok(out.includes('USDC 100') && out.includes('grid SOL/USDC $50'), 'live balances + bots are formatted in');
});

test('groundSystem degrades to the base prompt when nothing grounds', () => {
  const base = 'ONLY_BASE';
  // empty corpus + no live => no block
  assert.equal(AgentRAG.groundSystem(base, 'anything', { corpus: [], live: null }), base);
});

// ---------------------------------------------------------------------------
// 3c. COMMAND ROUTER injects grounding at BOTH assembly sites
// ---------------------------------------------------------------------------
// A provider that records the `system` of the first tool-offering turn.
function capturingProvider(opts) {
  opts = opts || {};
  const seen = { classifySystem: null, systems: [] };
  const turns = opts.turns || [];
  let i = 0;
  const p = {
    name: 'capture', seen,
    async turn({ system, tools }) {
      if (!tools || tools.length === 0) { seen.classifySystem = system; return { intent: opts.intent || 'query' }; }
      seen.systems.push(system);
      return turns[i++] || { text: 'done' };
    },
  };
  return p;
}

function makeCtx() {
  const calls = { broadcast: 0 };
  return {
    getAddress: async () => '0xADDR',
    getBalance: async () => [{ asset: { symbol: 'ETH', decimals: 18 }, confirmed: '1' }],
    estimateUsd: async () => 10,
    buildSend: async () => ({ fee: '21000', txid: '0xbuilt' }),
    broadcast: async () => { calls.broadcast++; return { txid: '0xtx', accepted: true }; },
    inspect: async () => null,
    _calls: calls,
  };
}

test('runAction grounds the ACTION system prompt (facts + custody) — no new tools', async () => {
  const provider = capturingProvider({ intent: 'action', turns: [{ text: 'nothing to do' }] });
  const policy = AgentPolicy.create({ confirm: async () => false });
  const tools = AgentTools.build(makeCtx());
  const router = AgentCommand.create({
    provider, tools, policy,
    liveContext: () => ({ chain: 'mainnet', bots: [{ strategy: 'dca', market: 'SOL/USDC', budget: 10 }] }),
  });
  await router.run('do a dca buy', { intent: 'action' });
  const sys = provider.seen.systems[0];
  assert.ok(sys.includes(AgentCommand.ACTION_SYSTEM), 'the base ACTION prompt is preserved');
  assert.ok(sys.includes('[Blockle knowledge'), 'grounding facts injected');
  assert.ok(/Custody and signing never depend on the LLM/.test(sys), 'custody safety fact injected');
  assert.ok(sys.includes('[Live context]') && sys.includes('dca SOL/USDC $10'), 'live snapshot injected');
  // classification is NOT grounded — it stays a bare one-word router
  assert.equal(provider.seen.classifySystem, undefined);
});

test('runQuery grounds the QUERY system prompt exactly ONCE (no double-grounding via the runner)', async () => {
  const provider = capturingProvider({ intent: 'query', turns: [{ text: 'your net worth is unavailable' }] });
  const policy = AgentPolicy.create({ confirm: async () => true });
  const tools = AgentTools.build(makeCtx());
  const router = AgentCommand.create({ provider, tools, policy, liveContext: () => ({ chain: 'mainnet' }) });
  await router.run('what is my net worth', { intent: 'query' });
  const sys = provider.seen.systems[0];
  assert.ok(sys.includes(AgentCommand.QUERY_SYSTEM), 'the base QUERY prompt is preserved');
  assert.ok(sys.includes('[Blockle knowledge'), 'grounding facts injected into the query loop');
  // the grounding header appears ONCE — the runner must not re-ground the already-grounded system
  const occurrences = sys.split('[Blockle knowledge').length - 1;
  assert.equal(occurrences, 1, 'grounded exactly once');
});

// ---------------------------------------------------------------------------
// 3d. The runner grounds per-turn ONLY when a rag is explicitly supplied (opt-in)
// ---------------------------------------------------------------------------
test('runner grounds per-turn when a rag is supplied; leaves the system bare otherwise', async () => {
  const policy = AgentPolicy.create({ confirm: async () => true });
  const tools = AgentTools.build(makeCtx());

  // opt-in: rag supplied -> grounded
  let groundedSys = null;
  const p1 = { name: 'm', async turn({ system }) { groundedSys = system; return { text: 'ok' }; } };
  const r1 = AgentRunner.create({ provider: p1, tools, policy, system: 'BASE', rag: AgentRAG, liveContext: () => ({ chain: 'mainnet' }) });
  await r1.run('how does the grid strategy work');
  assert.ok(groundedSys.includes('BASE') && groundedSys.includes('[Blockle knowledge'), 'rag-equipped runner grounds');

  // default: no rag -> the system is passed through untouched
  let bareSys = null;
  const p2 = { name: 'm', async turn({ system }) { bareSys = system; return { text: 'ok' }; } };
  const r2 = AgentRunner.create({ provider: p2, tools, policy, system: 'BASE_ONLY' });
  await r2.run('how does the grid strategy work');
  assert.equal(bareSys, 'BASE_ONLY', 'no rag => no grounding');
});
