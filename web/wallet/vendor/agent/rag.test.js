// agent/rag.test.js — the OFFLINE client-side RAG (web wallet mirror).
// Run: node --test web/wallet/vendor/agent/
//
// The RAG only builds a read-only grounding block prepended to the system prompt.
// These tests assert the deterministic retriever contract that must be identical
// across every wallet:
//   1. the bundled corpus loads (37 shared chunks incl. dApp-security)
//   2. a sample query returns a stable, deterministic top-K ranking
//   3. the 'custody' safety fact ("the LLM never signs") is ALWAYS included
//   4. a no-hit query returns [] (live-only; never padded)
//   5. groundSystem prepends the block and tolerates missing corpus/live
//   6. retrieval is purely a function of the query (no hidden state between runs)

const { test } = require('node:test');
const assert = require('node:assert');

const AgentRAG = require('./rag.js');
const CORPUS = require('./rag-corpus.json');

test('bundled corpus loads with the shared 37 chunks and a custody fact', () => {
  assert.ok(Array.isArray(CORPUS));
  assert.strictEqual(CORPUS.length, 37);
  assert.ok(CORPUS.some((c) => c.id === 'custody'));
  // rag.js auto-loads the same corpus via require()
  assert.strictEqual(AgentRAG.CORPUS.length, 37);
});

// dApp-security chunks (#127) ship in the SAME shared corpus; a connect/security
// query must surface them so the local AI can screen the site.
test('dApp-security chunks are retrievable for a connect/security query', () => {
  const ids = new Set(CORPUS.map((c) => c.id));
  for (const id of ['dapp-connect-screening', 'dapp-phishing', 'dapp-drainer',
    'dapp-approval-abuse', 'dapp-malicious-signature', 'dapp-airdrop-seed-theft',
    'dapp-protector-guidance']) {
    assert.ok(ids.has(id), 'corpus has ' + id);
  }
  const hits = AgentRAG.retrieve('dApp connect security screening phishing drainer approval signature permit')
    .map((c) => c.id);
  assert.ok(hits.filter((id) => id.startsWith('dapp-')).length >= 3, JSON.stringify(hits));
  assert.ok(hits.includes('custody'));
});

test('deterministic top-K for a sample query (grid / sideways market)', () => {
  const ids1 = AgentRAG.retrieve('grid sideways range market').map((c) => c.id);
  const ids2 = AgentRAG.retrieve('grid sideways range market').map((c) => c.id);
  assert.deepStrictEqual(ids1, ids2, 'retrieval must be deterministic across calls');
  assert.strictEqual(ids1[0], 'strat-grid', 'the grid fact ranks first for a grid query');
  assert.ok(ids1.includes('custody'), 'custody fact is force-included');
  assert.ok(ids1.length <= AgentRAG.K + 1, 'top-K capped at K+1 (forced custody)');
});

test('deterministic top-K for the local-LLM setup query', () => {
  const ids = AgentRAG.retrieve('run a local model on my own computer ollama').map((c) => c.id);
  assert.strictEqual(ids[0], 'local-llm', 'the local-LLM fact ranks first');
  assert.ok(ids.includes('custody'));
});

test('a no-hit query returns [] (live-only, never padded)', () => {
  const out = AgentRAG.retrieve('zzzxyq qwertypop nonsensetoken');
  assert.deepStrictEqual(out, []);
});

test('groundSystem prepends the block and never drops the base', () => {
  const base = 'BASE_SYSTEM_PROMPT';
  const grounded = AgentRAG.groundSystem(base, 'what is my net worth and bot pnl', {
    live: { chain: 'ethereum', balances: [{ symbol: 'ETH', amount: 1.5 }], bots: [{ strategy: 'rsi', market: 'ETH/USDC', budget: 100 }] },
  });
  assert.ok(grounded.startsWith(base + '\n\n'), 'base prompt stays first');
  assert.ok(grounded.includes('[Blockle knowledge'), 'knowledge header present');
  assert.ok(grounded.includes('[Live context]'), 'live context present');
  assert.ok(grounded.includes('ETH 1.5'), 'live balances rendered');
  assert.ok(grounded.includes('the LLM') || grounded.toLowerCase().includes('custody') || grounded.includes('never'), 'custody safety floor carried');
});

test('groundSystem is a no-op passthrough with no corpus and no live', () => {
  const base = 'ONLY_BASE';
  // force an empty corpus + no live -> nothing to inject
  const grounded = AgentRAG.groundSystem(base, 'anything', { corpus: [], live: null });
  assert.strictEqual(grounded, base);
});

test('live-only block injects when the query has no corpus hit', () => {
  const block = AgentRAG.buildGroundingBlock('zzzxyq nonsense', {
    live: { chain: 'solana', pair: 'SOL/USDC' },
  });
  assert.ok(block.includes('[Live context]'));
  assert.ok(block.includes('solana'));
  assert.ok(!block.includes('[Blockle knowledge'), 'no knowledge header when nothing retrieved');
});
