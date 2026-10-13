// chains/autoimport.test.js — auto-detect + auto-import held tokens on EVERY chain.
// Pins the shared contract (docs/scan-vectors.json → tokenImport): a real positive
// balance is auto-imported; a default / zero-balance row is not; dedupe by
// (chain, contract|mint); the security suite (denylist / scam flags / spam) MARKS a
// token instead of importing it; re-running imports nothing (idempotent). The
// orchestrator persists into the SAME store keys a manual import writes.
//
//   node --test blockle-extension/chains/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TokenAutoImport = require('./autoimport.js');

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'scan-vectors.json'), 'utf8')).tokenImport;

function keyOf(t) { return TokenAutoImport.tokenKey(t); }

// ===========================================================================
// SHARED VECTOR: detected balances -> the exact imported / flagged / skipped sets
// ===========================================================================
test('token-import vector: ethereum detected balances classify exactly', () => {
  const r = TokenAutoImport.filterForImport(VEC.detected.ethereum, [], { denylist: VEC.denylist, spamFilter: VEC.spamFilter });
  assert.deepEqual(r.toImport.map((x) => x.token), [VEC.expect.imported[0]], 'only DAI (real positive balance, not flagged) is imported');
  // flagged: CLAIM (spam) + EVIL (denylist), with their reasons
  assert.deepEqual(r.flagged.map((f) => ({ symbol: f.token.symbol, reason: f.reason })),
    [{ symbol: 'CLAIM', reason: 'spam' }, { symbol: 'EVIL', reason: 'denylist' }]);
  // skipped: USDC (default) + ZERO (zero-balance)
  assert.deepEqual(r.skipped.map((s) => ({ symbol: s.token.symbol, reason: s.reason })),
    [{ symbol: 'USDC', reason: 'default' }, { symbol: 'ZERO', reason: 'zero-balance' }]);
});

test('token-import vector: solana SPL detected balance is imported', () => {
  const r = TokenAutoImport.filterForImport(VEC.detected.solana, [], { denylist: VEC.denylist, spamFilter: VEC.spamFilter });
  assert.deepEqual(r.toImport.map((x) => x.token), [VEC.expect.imported[1]]);
});

// ===========================================================================
// NEVER FABRICATE: a token with no (or zero) detected balance is never imported
// ===========================================================================
test('a zero-balance / no-balance token is never auto-imported (never fabricate)', () => {
  const discovered = [
    { chain: 'ethereum', kind: 'erc20', symbol: 'ZERO', decimals: 18, address: '0xaaa', balance: '0' },
    { chain: 'ethereum', kind: 'erc20', symbol: 'NOBAL', decimals: 18, address: '0xbbb' }, // no balance field
  ];
  const r = TokenAutoImport.filterForImport(discovered, [], {});
  assert.equal(r.toImport.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['zero-balance', 'zero-balance']);
});

// ===========================================================================
// SECURITY: a flagged / denylisted / spam token is MARKED, never imported/traded
// ===========================================================================
test('a denylisted token is flagged, never imported', () => {
  const discovered = [{ chain: 'ethereum', kind: 'erc20', symbol: 'BAD', decimals: 18, address: '0xBAD', balance: '100' }];
  const r = TokenAutoImport.filterForImport(discovered, [], { denylist: ['0xbad'] });
  assert.equal(r.toImport.length, 0);
  assert.equal(r.flagged[0].reason, 'denylist');
});

test('a scam/honeypot-flagged token is flagged, never imported', () => {
  const discovered = [{ chain: 'ethereum', kind: 'erc20', symbol: 'HP', decimals: 18, address: '0xhp', balance: '100', flags: ['honeypot'] }];
  const r = TokenAutoImport.filterForImport(discovered, [], {});
  assert.equal(r.toImport.length, 0);
  assert.equal(r.flagged[0].reason, 'honeypot');
});

// ===========================================================================
// DEDUPE + IDEMPOTENT: re-running with the import already persisted adds nothing
// ===========================================================================
test('re-running is idempotent — an already-imported token is not imported again', () => {
  const first = TokenAutoImport.filterForImport(VEC.detected.ethereum, [], { denylist: VEC.denylist, spamFilter: true });
  const persisted = first.toImport.map((x) => x.token);
  const second = TokenAutoImport.filterForImport(VEC.detected.ethereum, persisted, { denylist: VEC.denylist, spamFilter: true });
  assert.deepEqual(second.toImport, VEC.expect.idempotent_rerun_imports, 'nothing new on re-run');
  assert.ok(second.skipped.some((s) => s.token.symbol === 'DAI' && s.reason === 'already-imported'));
});

// ===========================================================================
// ORCHESTRATOR: runs discovery for EVERY chain + persists into the manual-import
// store keys (chainTokens for EVM/Solana, tokens for BLOCK-20).
// ===========================================================================
function fakeStore(initial) {
  const data = Object.assign({ chainTokens: {}, tokens: [], flaggedTokens: {} }, initial || {});
  return {
    data,
    async get(keys) { const out = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) out[k] = data[k]; return out; },
    async set(obj) { Object.assign(data, obj); },
  };
}

function fakeRegistry(perChainDiscovered) {
  return {
    enabled() { return Object.keys(perChainDiscovered); },
    async discoverTokens(chain, _addr, _opts) { return perChainDiscovered[chain] || []; },
  };
}

test('orchestrator: auto-imports across every chain into the persisted lists', async () => {
  const store = fakeStore();
  const registry = fakeRegistry({
    ethereum: VEC.detected.ethereum,
    solana: VEC.detected.solana,
  });
  const summary = await TokenAutoImport.autoImport({
    registry, store, denylist: VEC.denylist, spamFilter: true,
    addressFor: async () => '0xMyAddress',
  });

  // persisted chainTokens has DAI (ethereum) + the SPL (solana), nothing flagged.
  assert.deepEqual(store.data.chainTokens.ethereum, [VEC.expect.imported[0]]);
  assert.deepEqual(store.data.chainTokens.solana, [VEC.expect.imported[1]]);
  // flagged tokens are MARKED, not imported.
  assert.equal(store.data.flaggedTokens.ethereum.length, 2);
  assert.deepEqual(store.data.flaggedTokens.ethereum.map((f) => f.reason).sort(), ['denylist', 'spam']);
  assert.equal(summary.imported.length, 2);
  assert.equal(summary.changed, true);
});

test('orchestrator: a second run changes nothing (incremental + idempotent)', async () => {
  const registry = fakeRegistry({ ethereum: VEC.detected.ethereum, solana: VEC.detected.solana });
  const store = fakeStore();
  await TokenAutoImport.autoImport({ registry, store, denylist: VEC.denylist, addressFor: async () => '0xMe' });
  const snapshot = JSON.stringify(store.data);
  const summary2 = await TokenAutoImport.autoImport({ registry, store, denylist: VEC.denylist, addressFor: async () => '0xMe' });
  assert.equal(summary2.changed, false, 're-run imports nothing new');
  assert.equal(JSON.stringify(store.data), snapshot, 'the persisted store is unchanged');
});

test('orchestrator: a BLOCK-20 discovered token persists into the `tokens` id array', async () => {
  const store = fakeStore();
  const registry = fakeRegistry({
    block: [{ chain: 'block', kind: 'block20', symbol: 'MEME', decimals: 8, id: 'abc123', address: 'abc123', balance: '500' }],
  });
  await TokenAutoImport.autoImport({ registry, store, addressFor: async () => 'block1addr' });
  assert.deepEqual(store.data.tokens, ['abc123'], 'the BLOCK-20 contract id is persisted into `tokens`');
});
