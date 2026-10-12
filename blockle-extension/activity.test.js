// activity.test.js — WALLET ACTIVITY merged cross-chain feed (§2).
//   node --test activity.test.js
//
// Asserts the reference implementation against the AUTHORITATIVE shared fixture
// docs/portfolio-vectors.json: the merge/sort order, the security-decoder-reused
// `kind` per item, the counterparty flag (a denylisted recipient stays flagged in
// history), and STABLE paging with a cursor — plus the "unavailable indexer =>
// audited note, never a fabricated empty feed" rule.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const A = require('./activity.js');
const vectors = require(path.join('..', 'docs', 'portfolio-vectors.json'));

function actCtx(av) {
  return {
    securityConfig: av.securityConfig,
    history: async (chain) => (av.history[chain] || []),
  };
}
const idsOf = (items) => items.map((i) => i.txid);

// ===========================================================================
// CANONICAL MERGE/SORT VECTOR — newest-first, decoded kinds, flagged counterparty
// ===========================================================================
test('vector: merged feed is time-sorted with security-decoded kinds + counterparty flag', async () => {
  const av = vectors.activity;
  const r = await A.activity(av.accounts, actCtx(av), { limit: 100 });
  const e = av.expect.merged;
  assert.equal(r.items.length, e.length, 'all items merged');
  for (let i = 0; i < e.length; i++) {
    assert.equal(r.items[i].chain, e[i].chain, 'item[' + i + '].chain');
    assert.equal(r.items[i].txid, e[i].txid, 'item[' + i + '].txid (sort order)');
    assert.equal(r.items[i].ts, e[i].ts, 'item[' + i + '].ts');
    assert.equal(r.items[i].kind, e[i].kind, 'item[' + i + '].kind (reused security decoder)');
    assert.equal(r.items[i].direction, e[i].direction, 'item[' + i + '].direction');
    assert.equal(r.items[i].flagged, e[i].flagged, 'item[' + i + '].flagged');
  }
  // the flagged item carries the security warning code, matching the pre-sign suite
  const flagged = r.items.find((i) => i.flagged);
  assert.ok(flagged.warnings.includes('send-to-flagged'), 'flag reason comes from the security suite');
});

// ===========================================================================
// STABLE PAGING — cursor-based, deterministic across calls
// ===========================================================================
test('vector: paging is stable — page1 cursor yields exactly the remaining items', async () => {
  const av = vectors.activity;
  const ctx = actCtx(av);

  const p1 = await A.activity(av.accounts, ctx, { limit: av.expect.page1.limit });
  assert.deepEqual(idsOf(p1.items), av.expect.page1.ids, 'page1 ids');
  assert.equal(p1.nextCursor, av.expect.page1.nextCursor, 'page1 stable cursor');

  const p2 = await A.activity(av.accounts, ctx, { limit: av.expect.page2.limit, cursor: p1.nextCursor });
  assert.deepEqual(idsOf(p2.items), av.expect.page2.ids, 'page2 ids (no overlap, no gap)');
  assert.equal(p2.nextCursor == null, av.expect.page2.nextCursor === null, 'page2 has no further cursor');

  // no item appears on both pages (stable, non-overlapping)
  const overlap = p1.items.filter((a) => p2.items.some((b) => b.txid === a.txid));
  assert.equal(overlap.length, 0, 'pages do not overlap');
});

// ===========================================================================
// UNAVAILABLE INDEXER — audited note, never a fabricated empty "no activity"
// ===========================================================================
test('an unavailable indexer contributes nothing + an audited note (not a fake empty feed)', async () => {
  // ctx with NO history function at all => every chain is unavailable + noted
  const r = await A.activity([{ chain: 'ethereum', address: '0xE' }], {}, {});
  assert.equal(r.items.length, 0);
  assert.equal(r.notes.length, 1, 'one audited note for the unavailable chain');
  assert.match(r.notes[0].note, /not a claim of no activity/);
});

test('a throwing indexer is noted (fails safe), a real empty list is NOT noted', async () => {
  const throwing = await A.activity([{ chain: 'ethereum', address: '0xE' }],
    { history: async () => { throw new Error('rate limited'); } }, {});
  assert.equal(throwing.items.length, 0);
  assert.equal(throwing.notes.length, 1);
  assert.match(throwing.notes[0].note, /indexer error/);

  const emptyReal = await A.activity([{ chain: 'ethereum', address: '0xE' }],
    { history: async () => [] }, {});
  assert.equal(emptyReal.items.length, 0);
  assert.equal(emptyReal.notes.length, 0, 'a genuine empty history is not an audited unavailability');
});

// ===========================================================================
// order is a strict stable total order (ts desc, chain asc, txid asc)
// ===========================================================================
test('cmp: stable total order ts-desc, chain-asc, txid-asc', () => {
  const a = { ts: 100, chain: 'ethereum', txid: '0xaa' };
  const b = { ts: 100, chain: 'ethereum', txid: '0xbb' };
  const c = { ts: 200, chain: 'solana', txid: '0xaa' };
  assert.ok(A.cmp(c, a) < 0, 'newer first');
  assert.ok(A.cmp(a, b) < 0, 'same ts+chain: txid ascending');
  const list = [a, c, b].slice().sort(A.cmp);
  assert.deepEqual(list.map((x) => x.txid), ['0xaa', '0xaa', '0xbb']); // c(200), then a,b(100)
});
