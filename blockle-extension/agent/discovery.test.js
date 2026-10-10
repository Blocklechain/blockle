// agent/discovery.test.js — the READ-ONLY, configurable candidate feed (spec §7).
//
//   node --test blockle-extension/agent/
//
// Covers: the CANONICAL scoring vector (EXACTLY 0.98); monotonicity in liquidity
// + volume; hard filters (min liquidity / min age / chains / quoteAssets /
// requireVerified / allowlist / denylist / maxCandidates); rug/scam FLAGS (never
// fabricate safety) + rejectFlags hard-drop; sources individually disable-able;
// token-list fetch is READ-ONLY and sends NO wallet data; every Candidate leaves
// approved===false; and a discovered-but-unapproved token never reaches commit.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentDiscovery = require('./discovery.js');
const AgentPolicy = require('./policy.js');
const AgentStrategyRunner = require('./strategy-runner.js');

// ---------------------------------------------------------------------------
// Scoring: the pinned canonical vector + monotonicity
// ---------------------------------------------------------------------------
test('CANONICAL scoring vector lands on EXACTLY 0.98', () => {
  const c = { liquidityUsd: 100000, volume24hUsd: 50000, ageSec: 86400, trust: 0.8, flags: [] };
  const s = AgentDiscovery.scoreOf(c, AgentDiscovery.DEFAULT_WEIGHTS, AgentDiscovery.DEFAULT_NORM);
  assert.strictEqual(s, 0.98); // 0.40 + 0.30 + 0.20 + 0.08
});

test('score is monotonic in liquidity and in volume', () => {
  const W = AgentDiscovery.DEFAULT_WEIGHTS, N = AgentDiscovery.DEFAULT_NORM;
  const base = { volume24hUsd: 10000, ageSec: 86400, trust: 0.5, flags: [] };
  const lo = AgentDiscovery.scoreOf({ ...base, liquidityUsd: 20000 }, W, N);
  const hi = AgentDiscovery.scoreOf({ ...base, liquidityUsd: 80000 }, W, N);
  assert.ok(hi > lo, 'more liquidity => higher score');
  const base2 = { liquidityUsd: 50000, ageSec: 86400, trust: 0.5, flags: [] };
  const vlo = AgentDiscovery.scoreOf({ ...base2, volume24hUsd: 10000 }, W, N);
  const vhi = AgentDiscovery.scoreOf({ ...base2, volume24hUsd: 40000 }, W, N);
  assert.ok(vhi > vlo, 'more volume => higher score');
});

test('a missing feature contributes 0 (never fabricated)', () => {
  const W = AgentDiscovery.DEFAULT_WEIGHTS, N = AgentDiscovery.DEFAULT_NORM;
  // only trust present
  const s = AgentDiscovery.scoreOf({ trust: 1.0, flags: [] }, W, N);
  assert.strictEqual(s, 0.1); // just the 0.10 trust weight
});

test('flag penalties subtract 0.25 each', () => {
  const W = AgentDiscovery.DEFAULT_WEIGHTS, N = AgentDiscovery.DEFAULT_NORM;
  const c = { liquidityUsd: 100000, volume24hUsd: 50000, ageSec: 86400, trust: 0.8, flags: ['new', 'unverified'] };
  const s = AgentDiscovery.scoreOf(c, W, N);
  assert.strictEqual(s, 0.48); // 0.98 - 2*0.25
});

// ---------------------------------------------------------------------------
// The scan() pipeline — build a fake read-only ctx
// ---------------------------------------------------------------------------
function ctxWithMarkets(markets) {
  return { exchange: { getMarkets: async () => markets } };
}

test('filters drop sub-threshold liquidity, too-new, and bad quote asset', async () => {
  const d = AgentDiscovery.create({
    ctx: ctxWithMarkets([
      { base: 'GOOD', quote: 'USDC', liquidityUsd: 50000, volume24hUsd: 20000, ageSec: 86400, verified: true, address: '0x1' },
      { base: 'THIN', quote: 'USDC', liquidityUsd: 500, volume24hUsd: 20000, ageSec: 86400, verified: true, address: '0x2' },   // < min liquidity
      { base: 'NEW', quote: 'USDC', liquidityUsd: 50000, volume24hUsd: 20000, ageSec: 60, verified: true, address: '0x3' },     // < min age
      { base: 'ODDQ', quote: 'PEPE', liquidityUsd: 50000, volume24hUsd: 20000, ageSec: 86400, verified: true, address: '0x4' }, // quote not allowed
    ]),
    config: { sources: { exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: false } },
  });
  const out = await d.scan();
  const syms = out.map((c) => c.symbol).sort();
  assert.deepStrictEqual(syms, ['GOOD']);
});

test('denylist drops; allowlist keeps only matches', async () => {
  const markets = [
    { base: 'AAA', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xa' },
    { base: 'BBB', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xb' },
    { base: 'EVIL', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xe' },
  ];
  const srcOnly = { sources: { exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: false } };

  const deny = AgentDiscovery.create({ ctx: ctxWithMarkets(markets), config: { ...srcOnly, filters: { denylist: ['EVIL'] } } });
  const d1 = (await deny.scan()).map((c) => c.symbol).sort();
  assert.deepStrictEqual(d1, ['AAA', 'BBB']);

  const allow = AgentDiscovery.create({ ctx: ctxWithMarkets(markets), config: { ...srcOnly, filters: { allowlist: ['BBB'] } } });
  const d2 = (await allow.scan()).map((c) => c.symbol);
  assert.deepStrictEqual(d2, ['BBB']);
});

test('requireVerified drops external unverified; watchlist is always trusted', async () => {
  const d = AgentDiscovery.create({
    ctx: ctxWithMarkets([
      { base: 'UNVER', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: false, address: '0xu' },
    ]),
    config: {
      sources: { exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: true },
      // a watchlist token with NO verified flag must still survive (trusted as candidate)
      watchlist: [{ chain: 'solana', symbol: 'WATCH', address: 'MintW', pair: 'WATCH/USDC', liquidityUsd: 50000, ageSec: 86400 }],
    },
  });
  const syms = (await d.scan()).map((c) => c.symbol).sort();
  assert.deepStrictEqual(syms, ['WATCH'], 'external unverified dropped; watchlist kept');
});

test('rug heuristics add FLAGS; rejectFlags (honeypot) hard-drops', async () => {
  const d = AgentDiscovery.create({
    ctx: ctxWithMarkets([
      { base: 'LOCKBAD', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0x1', liquidityLocked: false },
      { base: 'TRAP', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0x2', honeypot: true },
    ]),
    config: { sources: { exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: false } },
  });
  const out = await d.scan();
  const syms = out.map((c) => c.symbol).sort();
  assert.deepStrictEqual(syms, ['LOCKBAD'], 'honeypot hard-dropped, other kept');
  const lockbad = out.find((c) => c.symbol === 'LOCKBAD');
  assert.ok(lockbad.flags.includes('liquidity-not-locked'), 'flag surfaced, not fabricated-safe');
  assert.strictEqual(lockbad.approved, false);
});

test('sources can be individually disabled', async () => {
  const cfg = (sources) => ({
    ctx: {
      exchange: { getMarkets: async () => [{ base: 'EX', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xex' }] },
      getBlockLaunches: async () => [{ chain: 'blockle', symbol: 'LAUNCH', pair: 'LAUNCH/BLOCK', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xln' }],
    },
    config: { sources },
  });
  const both = await AgentDiscovery.create(cfg({ exchangeListings: true, blockLaunches: true, venuePairs: false, tokenLists: false, watchlist: false })).scan();
  assert.deepStrictEqual(both.map((c) => c.symbol).sort(), ['EX', 'LAUNCH']);
  const exOnly = await AgentDiscovery.create(cfg({ exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: false })).scan();
  assert.deepStrictEqual(exOnly.map((c) => c.symbol), ['EX']);
});

test('maxCandidates caps the ranked output', async () => {
  const markets = [];
  for (let i = 0; i < 10; i++) markets.push({ base: 'T' + i, quote: 'USDC', liquidityUsd: 10000 + i * 5000, volume24hUsd: 20000, ageSec: 86400, verified: true, address: '0x' + i });
  const d = AgentDiscovery.create({
    ctx: ctxWithMarkets(markets),
    config: { sources: { exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: false }, filters: { maxCandidates: 3 } },
  });
  const out = await d.scan();
  assert.strictEqual(out.length, 3);
  // ranked desc by score (higher liquidity first)
  assert.ok(out[0].score >= out[1].score && out[1].score >= out[2].score);
});

test('token lists: READ-ONLY GET, sends NO wallet data; parses Uniswap-style list', async () => {
  let sawBody = false, sawGet = false;
  const fetchImpl = async (url, init) => {
    if (init && init.method === 'GET') sawGet = true;
    if (init && init.body != null) sawBody = true;
    return { async json() { return { tokens: [
      { chainId: 1, symbol: 'LIST', address: '0xlist', quote: 'USDC', liquidityUsd: 50000, volume24hUsd: 20000, ageSec: 86400 },
    ] }; } };
  };
  const d = AgentDiscovery.create({
    ctx: {},
    fetchImpl,
    config: {
      sources: { exchangeListings: false, blockLaunches: false, venuePairs: false, tokenLists: true, watchlist: false },
      tokenListUrls: ['https://example.test/tokens.json'],
    },
  });
  const out = await d.scan();
  assert.strictEqual(sawGet, true, 'GET');
  assert.strictEqual(sawBody, false, 'no wallet data sent');
  assert.deepStrictEqual(out.map((c) => c.symbol), ['LIST']);
  assert.strictEqual(out[0].chain, 'ethereum'); // chainId 1 resolved
});

test('dedupe collapses the same (chain,address) seen from two sources', async () => {
  const d = AgentDiscovery.create({
    ctx: {
      exchange: { getMarkets: async () => [{ base: 'DUP', quote: 'USDC', chain: 'ethereum', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xdup' }] },
      getBlockLaunches: async () => [{ chain: 'ethereum', symbol: 'DUP', pair: 'DUP/USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xdup' }],
    },
    config: { sources: { exchangeListings: true, blockLaunches: true, venuePairs: false, tokenLists: false, watchlist: false } },
  });
  const out = await d.scan();
  assert.strictEqual(out.filter((c) => (c.address || '').toLowerCase() === '0xdup').length, 1);
});

test('every Candidate leaves scan() approved===false', async () => {
  const d = AgentDiscovery.create({
    ctx: ctxWithMarkets([{ base: 'X', quote: 'USDC', liquidityUsd: 50000, ageSec: 86400, verified: true, address: '0xx' }]),
    config: { sources: { exchangeListings: true, blockLaunches: false, venuePairs: false, tokenLists: false, watchlist: false } },
  });
  for (const c of await d.scan()) assert.strictEqual(c.approved, false);
});

// ---------------------------------------------------------------------------
// SAFETY: a discovered-but-unapproved token never reaches commit
// ---------------------------------------------------------------------------
test('StrategyRunner.candidates() is approved-only by default', async () => {
  const fakeDiscovery = {
    async scan() {
      return [
        { symbol: 'APPROVED', approved: true, score: 0.9 },
        { symbol: 'RAW', approved: false, score: 0.8 },
      ];
    },
  };
  const policy = AgentPolicy.create({ caps: { sessionUsd: 100 }, requireConfirm: false });
  const sr = AgentStrategyRunner.create({
    tools: { get() { return null; }, names() { return []; } },
    policy, discovery: fakeDiscovery,
  });
  const def = await sr.candidates();
  assert.deepStrictEqual(def.map((c) => c.symbol), ['APPROVED'], 'default = approved-only');
  const all = await sr.candidates({ includeUnapproved: true });
  assert.deepStrictEqual(all.map((c) => c.symbol).sort(), ['APPROVED', 'RAW']);
});

test('SAFETY: an unapproved discovered token fed to a strategy is BLOCKED (never trades)', async () => {
  // A strategy whose plan targets a discovered token's tool that is NOT on the
  // policy allowlist. The dispatch gate must drop it with a `blocked` audit note
  // and NEVER call commit — discovery cannot bypass the allowlist.
  const commits = [];
  const tool = {
    name: 'swap', valueMoving: true,
    async prepare() { return { summary: { action: 'swap' }, value: { asset: 'RAW', amount: '1', usd: 1 }, commit: async () => { commits.push(1); return { txid: '0x' }; } }; },
  };
  const tools = { get: (n) => (n === 'swap' ? tool : null), names: () => ['swap'] };

  const strat = {
    validateParams: (p) => p,
    describe: () => ({}),
    async plan() { return [{ tool: 'swap', args: { token: 'RAW' }, tag: 'discovered', estUsd: 1 }]; },
  };
  const registry = { get: (n) => (n === 'disc' ? strat : null), names: () => ['disc'] };

  // allowlist does NOT include 'swap' => the discovered-token trade is blocked
  const policy = AgentPolicy.create({ caps: { sessionUsd: 100 }, requireConfirm: false });
  policy.setAllowlist([]); // nothing allowlisted

  const audited = [];
  const sr = AgentStrategyRunner.create({
    tools, policy, registry,
    audit: { record: async (r) => { audited.push(r); } },
  });

  const results = await sr.tick('disc', {}, { mode: 'auto' });
  assert.strictEqual(commits.length, 0, 'commit NEVER called for an unapproved/non-allowlisted token');
  assert.ok(results.some((r) => r.blocked), 'produced a blocked result');
  assert.ok(audited.some((a) => a.type === 'blocked'), 'recorded a blocked audit note');
});
