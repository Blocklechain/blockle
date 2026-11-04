import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// Identity is injected: a request carrying x-test-uid "logs in" as that user (csrf = "t").
function testResolve(req) {
  const uid = req.headers['x-test-uid'];
  if (!uid) return null;
  return { uid, email: `${uid}@example.test`, role: req.headers['x-test-role'] || 'user', csrf: 't' };
}

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-social-'));
  const clock = { t: 1_700_000_000_000 };
  const app = createApp({
    now: () => clock.t,
    resolveSession: (req) => testResolve(req),
    config: { dataDir, prod: false, publicOrigin: 'http://127.0.0.1', basePath: '/social', settleSecret: 'sek', minTipBlock: 1, platformFeeBps: 100 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port, baseUrl = `http://127.0.0.1:${port}`;
  async function call(method, p, body, headers = {}) {
    const h = { ...headers }; if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(baseUrl + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  // helper: act as a user (adds identity + csrf headers on mutations)
  const as = (uid, extra = {}) => ({ 'x-test-uid': uid, 'x-csrf-token': 't', ...extra });
  try { await fn({ app, call, clock, as, dataDir }); }
  finally { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test('me is null without a session; creating a profile is automatic + handles are unique', async () => {
  await withServer(async ({ call, app }) => {
    assert.equal((await call('GET', '/social/api/me')).data.user, null);
    const a = await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'alice' });
    assert.equal(a.data.user.handle, 'alice');
    // a second different uid whose email local-part is also "alice" gets a distinct handle
    await app.store.drain();
    // simulate collision by seeding another user with same base
    app.ensureProfile({ uid: 'alice2', email: 'alice@other.test', role: 'user' });
    await app.store.drain();
    assert.equal(app.store.get('profiles', 'alice2').handle, 'alice1');
  });
});

test('creating a community is gated by the Member tier', async () => {
  await withServer(async ({ call, app, as }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'bob' }); // bootstrap profile (karma 0)
    const denied = await call('POST', '/social/api/communities', { name: 'trade', title: 'Trading' }, as('bob'));
    assert.equal(denied.status, 403);
    await app.store.update('profiles', 'bob', (p) => { p.karma = 150; return p; }); // promote to Member
    const ok = await call('POST', '/social/api/communities', { name: 'trade', title: 'Trading' }, as('bob'));
    assert.equal(ok.status, 200);
  });
});

test('mutations require a CSRF token', async () => {
  await withServer(async ({ call, app }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'carol' });
    await app.store.update('profiles', 'carol', (p) => { p.karma = 150; return p; });
    const noCsrf = await call('POST', '/social/api/communities', { name: 'x', title: 'X' }, { 'x-test-uid': 'carol' });
    assert.equal(noCsrf.status, 403);
  });
});

test('post appears in the feed; voting changes score + author karma; toggle/switch reverse exactly', async () => {
  await withServer(async ({ call, app, as, clock }) => {
    // author creates a community + post
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'auth' });
    await app.store.update('profiles', 'auth', (p) => { p.karma = 150; return p; });
    await call('POST', '/social/api/communities', { name: 'gen', title: 'General' }, as('auth'));
    const pr = await call('POST', '/social/api/posts', { cid: 'gen', kind: 'text', title: 'Hello', body: 'world' }, as('auth'));
    assert.equal(pr.status, 200); const pid = pr.data.id;
    const feed = await call('GET', '/social/api/feed?sort=new');
    assert.equal(feed.data.posts[0].id, pid);

    // a Member-tier, week-old voter → weight 2.0
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'vot' });
    await app.store.update('profiles', 'vot', (p) => { p.karma = 150; p.createdAt = clock.t - 8 * 86400000; return p; });

    // can't vote own post
    const self = await call('POST', '/social/api/vote', { targetType: 'post', targetId: pid, dir: 1 }, as('auth'));
    assert.equal(self.status, 400);

    await call('POST', '/social/api/vote', { targetType: 'post', targetId: pid, dir: 1 }, as('vot'));
    await app.store.drain();
    assert.equal(app.store.get('posts', pid).score, 2);
    assert.equal(app.store.get('profiles', 'auth').karma, 152);

    // switch to downvote → net swing of -4 from +2 to -2
    await call('POST', '/social/api/vote', { targetType: 'post', targetId: pid, dir: -1 }, as('vot'));
    await app.store.drain();
    assert.equal(app.store.get('posts', pid).score, -2);
    assert.equal(app.store.get('profiles', 'auth').karma, 148);

    // clear → back to 0 / 150
    await call('POST', '/social/api/vote', { targetType: 'post', targetId: pid, dir: 0 }, as('vot'));
    await app.store.drain();
    assert.equal(app.store.get('posts', pid).score, 0);
    assert.equal(app.store.get('profiles', 'auth').karma, 150);
  });
});

test('tipping moves BLOCK with a fee to the pool; conserves total; guards self-tip + balance', async () => {
  await withServer(async ({ call, app, as }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'rich' });
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'poor' });
    await app.store.update('profiles', 'rich', (p) => { p.karma = 150; return p; });
    await app.store.update('profiles', 'rich', (p) => { p.blockUnits = 1000; return p; });
    await call('POST', '/social/api/communities', { name: 'gg', title: 'G' }, as('rich'));
    const pid = (await call('POST', '/social/api/posts', { cid: 'gg', kind: 'text', title: 'T', body: 'b' }, as('rich'))).data.id;

    // poor tips rich's post? poor has 0 balance → 402
    const broke = await call('POST', '/social/api/tip', { targetType: 'post', targetId: pid, amount: 10 }, as('poor'));
    assert.equal(broke.status, 402);

    // rich can't tip own post
    const selfTip = await call('POST', '/social/api/tip', { targetType: 'post', targetId: pid, amount: 10 }, as('rich'));
    assert.equal(selfTip.status, 400);

    // give poor a balance, then poor tips rich 100 (fee 1% = 1 → rich +99, pool +1)
    await app.store.update('profiles', 'poor', (p) => { p.blockUnits = 500; return p; });
    const tip = await call('POST', '/social/api/tip', { targetType: 'post', targetId: pid, amount: 100 }, as('poor'));
    assert.equal(tip.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('profiles', 'poor').blockUnits, 400);
    assert.equal(app.store.get('profiles', 'rich').blockUnits, 1099);
    assert.equal(app.store.get('meta', 'pool').units, 1);
    // conservation: 400 + 1099 + 1(pool) = 1500 = original (500 + 1000)
  });
});

test('deposit endpoint is hidden without the settle secret and credits with it', async () => {
  await withServer(async ({ call, app }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'dep' });
    const no = await call('POST', '/social/api/deposit', { uid: 'dep', units: 50 });
    assert.equal(no.status, 404);
    const yes = await call('POST', '/social/api/deposit', { uid: 'dep', units: 50 }, { 'x-settle-secret': 'sek' });
    assert.equal(yes.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('profiles', 'dep').blockUnits, 50);
  });
});

test('seed creates boards + pinned welcome posts once, and reserves official handles', async () => {
  const { seed, BOARDS, HOUSE } = await import('../src/seed.js');
  await withServer(async ({ app, call }) => {
    const first = await seed(app.store, () => 1_700_000_000_000);
    assert.equal(first.boards.length, BOARDS.length);
    assert.equal(first.posts.length, BOARDS.length);
    const again = await seed(app.store, () => 1_700_000_000_000);
    assert.deepEqual([again.boards.length, again.posts.length, again.house], [0, 0, false]);
    assert.equal(app.store.get('handles', 'admin'), HOUSE.uid);
    // a user whose account username is a reserved handle does not get it
    const p = app.ensureProfile({ uid: 'u1', email: 'x@example.test', username: 'blockle', role: 'user' });
    assert.notEqual(p.handle, 'blockle');
    const feed = await call('GET', '/social/api/feed?c=mining');
    assert.equal(feed.data.posts[0].pinned, true);
    assert.equal(feed.data.posts[0].author.official, true);
    const stats = await call('GET', '/social/api/stats');
    assert.equal(stats.data.boards, BOARDS.length);
  });
});

test('restricted boards, flairs, join/leave, pinning and no tipping the house account', async () => {
  const { seed } = await import('../src/seed.js');
  await withServer(async ({ app, call, as }) => {
    await seed(app.store, () => 1_700_000_000_000);
    // only staff post to announcements
    assert.equal((await call('POST', '/social/api/posts', { cid: 'announcements', title: 'hi' }, as('bob'))).status, 403);
    assert.equal((await call('POST', '/social/api/posts', { cid: 'announcements', title: 'v1', flair: 'Release' }, as('root', { 'x-test-role': 'admin' }))).status, 200);
    // flair is kept only if the board defines it
    const ok = await call('POST', '/social/api/posts', { cid: 'mining', title: 'rig', flair: 'Hardware' }, as('bob'));
    const bad = await call('POST', '/social/api/posts', { cid: 'mining', title: 'x', flair: 'Nope' }, as('bob'));
    assert.equal(app.store.get('posts', ok.data.id).flair, 'Hardware');
    assert.equal(app.store.get('posts', bad.data.id).flair, null);
    assert.equal((await call('GET', '/social/api/feed?c=mining&flair=Hardware')).data.posts.length, 1);
    // join toggles membership + count
    const j1 = await call('POST', '/social/api/community/mining/join', undefined, as('bob'));
    assert.equal(j1.data.joined, true);
    assert.equal((await call('GET', '/social/api/community/mining', undefined, as('bob'))).data.community.members, 1);
    await call('POST', '/social/api/community/mining/join', undefined, as('bob'));
    assert.equal(app.store.get('communities', 'mining').members, 0);
    // pin: non-staff refused, admin allowed
    assert.equal((await call('POST', '/social/api/pin', { id: ok.data.id, pinned: true }, as('carol'))).status, 403);
    assert.equal((await call('POST', '/social/api/pin', { id: ok.data.id, pinned: true }, as('root', { 'x-test-role': 'admin' }))).status, 200);
    // house posts can't be tipped
    await app.store.update('profiles', 'bob', (p) => { if (p) p.blockUnits = 50; return p; });
    const house = app.store.find('posts', (p) => p.seed && p.cid === 'help');
    const tip = await call('POST', '/social/api/tip', { targetType: 'post', targetId: house.id, amount: 5 }, as('bob'));
    assert.equal(tip.status, 400);
    assert.equal(app.store.get('profiles', 'bob').blockUnits, 50);
  });
});
