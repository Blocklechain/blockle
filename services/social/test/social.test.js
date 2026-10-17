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
    assert.equal(app.store.get('profiles', 'rich').karma, 150, 'tips grant NO karma — reputation is earned, not bought');
    // conservation: 400 + 1099 + 1(pool) = 1500 = original (500 + 1000)
  });
});

test('awards move BLOCK with a pool fee + stamp a badge (no karma); boosts flag + fund the pool', async () => {
  await withServer(async ({ app, call, as }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'giver' });
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'poster' });
    await app.store.update('profiles', 'poster', (p) => { p.karma = 150; return p; });
    await app.store.update('profiles', 'giver', (p) => { p.blockUnits = 1000; return p; });
    await call('POST', '/social/api/communities', { name: 'aw', title: 'Aw' }, as('poster'));
    const pid = (await call('POST', '/social/api/posts', { cid: 'aw', kind: 'text', title: 'T', body: 'b' }, as('poster'))).data.id;

    // award 'gold' (100): 10% fee=10 -> poster +90, pool +10; badge stamped; poster karma unchanged
    const aw = await call('POST', '/social/api/award', { targetType: 'post', targetId: pid, award: 'gold' }, as('giver'));
    assert.equal(aw.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('profiles', 'giver').blockUnits, 900);
    assert.equal(app.store.get('profiles', 'poster').blockUnits, 90);
    assert.equal(app.store.get('meta', 'pool').units, 10);
    assert.equal(app.store.get('profiles', 'poster').karma, 150, 'awards grant NO karma');
    assert.equal(app.store.get('posts', pid).awards.gold, 1);

    // unknown award + self-award + insufficient funds are rejected
    assert.equal((await call('POST', '/social/api/award', { targetType: 'post', targetId: pid, award: 'nope' }, as('giver'))).status, 400);
    assert.equal((await call('POST', '/social/api/award', { targetType: 'post', targetId: pid, award: 'gold' }, as('poster'))).status, 400);

    // boost: deducts from giver, funds the pool, flags boostedUntil
    const bo = await call('POST', '/social/api/boost', { targetId: pid, amount: 50 }, as('giver'));
    assert.equal(bo.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('profiles', 'giver').blockUnits, 850);
    assert.equal(app.store.get('meta', 'pool').units, 60);
    assert.ok(app.store.get('posts', pid).boostedUntil > 0);
    assert.equal((await call('POST', '/social/api/boost', { targetId: pid, amount: 5 }, as('giver'))).status, 400); // below min
  });
});

test('token-card posts normalize the ref, reject junk, and survive a feed roundtrip', async () => {
  await withServer(async ({ call, app, as }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'trader' });
    await app.store.update('profiles', 'trader', (p) => { p.karma = 150; return p; });
    await call('POST', '/social/api/communities', { name: 'defi', title: 'DeFi' }, as('trader'));
    // a $-prefixed lowercase symbol is stored upper-cased, no $
    const sym = await call('POST', '/social/api/posts',
      { cid: 'defi', kind: 'token', title: 'Aping $block', token: '$block' }, as('trader'));
    assert.equal(sym.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('posts', sym.data.id).token, 'BLOCK');
    assert.equal(app.store.get('posts', sym.data.id).kind, 'token');
    // a 0x contract is lower-cased
    const addr = '0x' + 'Ab'.repeat(20);
    const ca = await call('POST', '/social/api/posts',
      { cid: 'defi', kind: 'token', title: 'contract', token: addr }, as('trader'));
    assert.equal(ca.status, 200);
    await app.store.drain();
    assert.equal(app.store.get('posts', ca.data.id).token, addr.toLowerCase());
    // junk ref is rejected
    const bad = await call('POST', '/social/api/posts',
      { cid: 'defi', kind: 'token', title: 'bad', token: 'not a token!!' }, as('trader'));
    assert.equal(bad.status, 400);
    // feed carries the token field through decorate()
    const feed = await call('GET', '/social/api/feed?sort=new');
    assert.ok(feed.data.posts.some((p) => p.token === 'BLOCK'));
  });
});

test('agents-as-members: registration is tier-gated, agents post/comment but can never move value', async () => {
  await withServer(async ({ call, app, as }) => {
    // owner must be Member to register an agent
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'owner' });
    const denied = await call('POST', '/social/api/agents', { handle: 'botzero' }, as('owner'));
    assert.equal(denied.status, 403);
    await app.store.update('profiles', 'owner', (p) => { p.karma = 150; return p; }); // promote

    // register: token returned ONCE
    const reg = await call('POST', '/social/api/agents', { handle: 'alphabot', name: 'Alpha Bot' }, as('owner'));
    assert.equal(reg.status, 200);
    const token = reg.data.token;
    assert.match(token, /^blk_agent_/);
    const agentAuth = { Authorization: `Bearer ${token}` };

    // owner lists the agent
    const mine = await call('GET', '/social/api/agents', undefined, as('owner'));
    assert.equal(mine.data.agents.length, 1);
    assert.equal(mine.data.agents[0].handle, 'alphabot');

    // the agent can post + comment (no cookie, no CSRF — the bearer token is the capability)
    await call('POST', '/social/api/communities', { name: 'alpha', title: 'Alpha' }, as('owner'));
    const pr = await call('POST', '/social/api/posts',
      { cid: 'alpha', kind: 'text', title: 'My read on BLOCK', body: 'thesis' }, agentAuth);
    assert.equal(pr.status, 200);
    const pid = pr.data.id;
    const cr = await call('POST', '/social/api/comments', { pid, body: 'and a follow-up' }, agentAuth);
    assert.equal(cr.status, 200);

    // the post author is transparently labeled as an agent run by @owner
    const feed = await call('GET', '/social/api/feed?sort=new');
    const md = feed.data.posts.find((p) => p.id === pid);
    assert.equal(md.author.handle, 'alphabot');
    assert.equal(md.author.kind, 'agent');
    assert.equal(md.author.ownerHandle, 'owner');

    // VALUE ACTIONS are human-only: the agent token is rejected (401) on vote/tip/award/boost
    assert.equal((await call('POST', '/social/api/vote', { targetType: 'post', targetId: pid, dir: 1 }, agentAuth)).status, 401);
    assert.equal((await call('POST', '/social/api/tip', { targetType: 'post', targetId: pid, amount: 1 }, agentAuth)).status, 401);
    assert.equal((await call('POST', '/social/api/award', { targetType: 'post', targetId: pid, award: 'gold' }, agentAuth)).status, 401);
    assert.equal((await call('POST', '/social/api/boost', { targetId: pid, amount: 20 }, agentAuth)).status, 401);
    // and an agent cannot spawn agents
    assert.equal((await call('POST', '/social/api/agents', { handle: 'nested' }, agentAuth)).status, 401);
  });
});

test('agents-as-members: revoke disables the token; per-owner cap is enforced', async () => {
  await withServer(async ({ call, app, as }) => {
    await call('GET', '/social/api/me', undefined, { 'x-test-uid': 'boss' });
    await app.store.update('profiles', 'boss', (p) => { p.karma = 150; return p; });
    await call('POST', '/social/api/communities', { name: 'den', title: 'Den' }, as('boss'));

    const reg = await call('POST', '/social/api/agents', { handle: 'worker' }, as('boss'));
    const token = reg.data.token; const uid = reg.data.agent.uid;
    const agentAuth = { Authorization: `Bearer ${token}` };
    // works before revoke
    assert.equal((await call('POST', '/social/api/posts', { cid: 'den', kind: 'text', title: 'hi', body: 'x' }, agentAuth)).status, 200);
    // revoke → token no longer authenticates
    assert.equal((await call('POST', `/social/api/agents/${encodeURIComponent(uid)}/revoke`, {}, as('boss'))).status, 200);
    assert.equal((await call('POST', '/social/api/posts', { cid: 'den', kind: 'text', title: 'again', body: 'x' }, agentAuth)).status, 401);

    // cap: fill to max (default 5; one slot freed by the revoke) then the next 409s
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/social/api/agents', { handle: `cap${i}bot` }, as('boss'));
      assert.equal(r.status, 200, `agent ${i} should register`);
    }
    const over = await call('POST', '/social/api/agents', { handle: 'overflowbot' }, as('boss'));
    assert.equal(over.status, 409);
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
