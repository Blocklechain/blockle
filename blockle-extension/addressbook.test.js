// addressbook.test.js — WALLET ADDRESS BOOK + name resolution (§3).
//   node --test addressbook.test.js
//
// Asserts the reference implementation against the AUTHORITATIVE shared fixture
// docs/portfolio-vectors.json (ens / sns / book / raw + a null for an
// unresolvable name) plus unit tests for the book CRUD (dedup by label), the
// never-guess rule, reverse display preference (book > forward-verified ENS/SNS >
// null), and the in-memory store wrapper.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const AB = require('./addressbook.js');
const vectors = require(path.join('..', 'docs', 'portfolio-vectors.json'));

function resCtx(rn) {
  return {
    book: rn.book,
    resolveEns: async (name) => rn.ensMap[name] || null,
    resolveSns: async (name) => rn.snsMap[name] || null,
  };
}

// ===========================================================================
// CANONICAL RESOLUTION VECTOR — ens / sns / book / raw / null
// ===========================================================================
test('vector: resolveName covers ens, sns, book, raw, and null (never a guessed address)', async () => {
  const rn = vectors.resolveName;
  for (const c of rn.cases) {
    const got = await AB.resolveName(c.input, c.chain, resCtx(rn));
    if (c.expect === null) {
      assert.equal(got, null, c.name + ' resolves to null');
    } else {
      assert.ok(got, c.name + ' resolves');
      assert.equal(got.address, c.expect.address, c.name + ' address');
      assert.equal(got.source, c.expect.source, c.name + ' source');
    }
  }
});

test('resolveName: a .eth name with NO injected resolver returns null (never guessed)', async () => {
  const got = await AB.resolveName('alice.eth', 'ethereum', {});
  assert.equal(got, null);
});

test('resolveName: raw address is returned verbatim, never transformed', async () => {
  const addr = '0x1234567890abcdef1234567890ABCDEF12345678';
  const got = await AB.resolveName(addr, 'ethereum', {});
  assert.equal(got.source, 'raw');
  assert.equal(got.address, addr, 'exact bytes preserved (no case/format change)');

  // a malformed address for the chain is NOT echoed back as a guess
  assert.equal(await AB.resolveName('0xdeadbeef', 'ethereum', {}), null, 'too short => null');
  assert.equal(await AB.resolveName('randomword', 'ethereum', {}), null, 'not address-like => null');
});

// ===========================================================================
// BOOK CRUD — pure list ops, dedup by label
// ===========================================================================
test('book: add/edit/remove dedups by label (case-insensitive) and stays sorted', () => {
  let list = [];
  list = AB.upsertEntry(list, { label: 'Mom', address: '0xM0M0000000000000000000000000000000000000', chain: 'ethereum' });
  list = AB.upsertEntry(list, { label: 'Dad', address: '0xDAD0000000000000000000000000000000000000' });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.label), ['Dad', 'Mom'], 'sorted by label');

  // editing the same label (different case) REPLACES, never duplicates
  list = AB.upsertEntry(list, { label: 'mom', address: '0xNEW0000000000000000000000000000000000000' });
  assert.equal(list.length, 2, 'no duplicate label');
  assert.equal(AB.findByLabel(list, 'Mom').address, '0xNEW0000000000000000000000000000000000000', 'edited in place');

  list = AB.removeEntry(list, 'Dad');
  assert.equal(list.length, 1);
  assert.equal(AB.findByLabel(list, 'Dad'), null);
});

test('book: normalizeEntry requires label + address', () => {
  assert.throws(() => AB.normalizeEntry({ address: '0xabc' }), /label/);
  assert.throws(() => AB.normalizeEntry({ label: 'x' }), /address/);
});

// ===========================================================================
// REVERSE DISPLAY — book label > forward-verified ENS/SNS > null
// ===========================================================================
test('reverseName: book label wins', async () => {
  const book = [{ label: 'Mom', address: '0xM0M0000000000000000000000000000000000000', chain: 'ethereum' }];
  const r = await AB.reverseName('0xM0M0000000000000000000000000000000000000', 'ethereum', { book });
  assert.deepEqual(r, { label: 'Mom', source: 'book' });
});

test('reverseName: ENS reverse is trusted ONLY when it forward-verifies', async () => {
  const addr = '0xA11CE00000000000000000000000000000000000';
  // honest: reverse(addr)->alice.eth, forward(alice.eth)->addr  => trusted
  const good = await AB.reverseName(addr, 'ethereum', {
    book: [],
    reverseEns: async () => 'alice.eth',
    resolveEns: async () => addr,
  });
  assert.deepEqual(good, { label: 'alice.eth', source: 'ens' });

  // spoof: reverse(addr)->evil.eth but forward(evil.eth)->someone else => rejected
  const spoof = await AB.reverseName(addr, 'ethereum', {
    book: [],
    reverseEns: async () => 'evil.eth',
    resolveEns: async () => '0x9999999999999999999999999999999999999999',
  });
  assert.equal(spoof, null, 'unverified reverse name is not shown (anti-spoof)');
});

test('reverseName: no book hit and no resolver => null (caller shows truncated hex)', async () => {
  assert.equal(await AB.reverseName('0xabc', 'ethereum', { book: [] }), null);
});

// ===========================================================================
// STORE WRAPPER — persists via an injected Store (in-memory here)
// ===========================================================================
function memStore() {
  const data = {};
  return {
    data,
    async get(keys) { const out = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in data) out[k] = data[k]; return out; },
    async set(obj) { Object.assign(data, obj); },
  };
}

test('createBook: add/list/remove persist through the injected store; resolveName reads the live book', async () => {
  const store = memStore();
  const book = AB.createBook({ store });
  await book.add({ label: 'Mom', address: '0xM0M0000000000000000000000000000000000000', chain: 'ethereum' });
  await book.add({ label: 'Exchange', address: '0xEXCHANGE000000000000000000000000000000000' });
  assert.equal((await book.list()).length, 2);

  // resolveName via the wrapper sees the stored book by label
  const r = await book.resolveName('Mom', 'ethereum', {});
  assert.deepEqual(r, { address: '0xM0M0000000000000000000000000000000000000', source: 'book', label: 'Mom' });

  await book.remove('Exchange');
  assert.equal((await book.list()).length, 1);
  assert.ok(Array.isArray(store.data[AB.STORE_KEY]), 'persisted under the settings-adjacent key');
});
