// social.blockle.org — contribution-gated social layer. Identity is the shared Blockle account
// (resolved from the blk_sess cookie, read-only, via identity.js). BLOCK is the "gold": tips move
// real circulating balance through an off-chain ledger (nothing is minted — BLOCK is fixed-supply).
// Reuses the hardened accounts primitives (Store, RateLimiter, crypto, HTTP helpers, CSP).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, privileges } from './config.js';
import { resolveSession } from './identity.js';
import { tierOf, can, voteWeight } from './reputation.js';
import { Store } from '../../accounts/src/store.js';
import { RateLimiter } from '../../accounts/src/ratelimit.js';
import { randomToken, sha256, timingSafeEqualStr, safeNow } from '../../accounts/src/crypto.js';
import {
  securityHeaders, readJson, parseCookies, json, html, sameOrigin,
} from '../../accounts/src/http.js';
import { renderShell } from './pages.js';
import { CATEGORIES } from './seed.js';
import { AWARDS, AWARD_BY_ID, AWARD_FEE_BPS, BOOST_DURATION_MS, MIN_BOOST } from './awards.js';

const APP_JS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');
const handleRe = /^[a-z0-9_]{3,20}$/;
const nameRe = /^[a-z0-9_]{2,24}$/;

export function createApp(overrides = {}) {
  const cfg = { ...config, ...overrides.config };
  const now = overrides.now || safeNow;
  const store = overrides.store || new Store(cfg.dataDir);
  const session = (req) => (overrides.resolveSession || resolveSession)(req, cfg, now);
  const rl = new RateLimiter({ windowMs: 60 * 1000, max: 20, lockoutBaseMs: 10 * 1000 }, now);
  const voteRl = new RateLimiter({ windowMs: 60 * 1000, max: 100, lockoutBaseMs: 5 * 1000 }, now);

  // --- profile bootstrap -------------------------------------------------------------------
  function ensureProfile(sess) {
    let p = store.get('profiles', sess.uid);
    if (p) {
      // keep the social @handle in sync with the account username the user chose/changed
      const want = sess.username && String(sess.username).toLowerCase();
      if (want && p.handle !== want) {
        const owner = store.get('handles', want);
        if (!owner || owner === sess.uid) {
          store.del('handles', p.handle);
          store.put('handles', want, sess.uid);
          p.handle = want;
          store.put('profiles', sess.uid, p);
        }
      }
      return p;
    }
    // new profile: prefer the account username; else derive a unique handle from the email
    let handle = sess.username && String(sess.username).toLowerCase();
    if (!handle || store.get('handles', handle)) {
      let base = (sess.email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18) || 'user';
      if (base.length < 3) base = base + 'xyz'.slice(0, 3 - base.length);
      handle = base; let n = 1;
      while (store.get('handles', handle)) handle = `${base}${n++}`;
    }
    p = { uid: sess.uid, handle, displayName: handle, bio: '', karma: 0, blockUnits: 0, createdAt: now() };
    store.put('profiles', sess.uid, p);
    store.put('handles', handle, sess.uid);
    return p;
  }
  const ageDays = (p) => Math.max(0, (now() - p.createdAt) / 86400000);
  const pubProfile = (p) => p && ({ handle: p.handle, displayName: p.displayName, bio: p.bio,
    karma: p.karma, tier: tierOf(p.karma), blockUnits: p.blockUnits });

  // --- agent identity ----------------------------------------------------------------------
  // An agent authenticates with a scoped bearer token (never a cookie), so its requests carry
  // NO CSRF/same-origin — the secret token IS the capability. A deactivated agent's token stops
  // authenticating immediately (we gate on profile.active), so revoke == deactivate.
  const agentTokenRe = /^blk_agent_[A-Za-z0-9]+$/;
  function agentFromReq(req) {
    const authz = req.headers['authorization'] || '';
    const m = /^Bearer\s+(\S+)$/i.exec(authz);
    const raw = (m && m[1]) || req.headers['x-blockle-agent-token'] || '';
    if (!agentTokenRe.test(raw)) return null;
    const rec = store.get('agentTokens', sha256(raw));
    if (!rec || rec.revoked) return null;
    const p = store.get('profiles', rec.uid);
    if (!p || p.kind !== 'agent' || p.active === false) return null;
    return { sess: { uid: rec.uid, kind: 'agent', ownerUid: rec.ownerUid, csrf: null }, profile: p };
  }

  // --- auth middleware ---------------------------------------------------------------------
  // allowAgent=true lets a bearer-token agent through; EVERY other endpoint stays human-only by
  // default, which is exactly why agents are blocked from all value actions (tip/award/boost/
  // vote/deposit) without a per-endpoint guard — they simply never authenticate there.
  function auth(req, res, { mutating = true, allowAgent = false } = {}) {
    const sess = session(req);
    if (sess) {
      if (mutating) {
        if (!sameOrigin(req, cfg)) { json(res, 403, { error: 'origin' }); return null; }
        if (!timingSafeEqualStr(sess.csrf, req.headers['x-csrf-token'] || '')) { json(res, 403, { error: 'csrf' }); return null; }
      }
      return { sess: { ...sess, kind: 'user' }, profile: ensureProfile(sess) };
    }
    if (allowAgent) {
      const ag = agentFromReq(req);
      if (ag) return ag;
    }
    json(res, 401, { error: 'Sign in at blockle.org/account to join the conversation.' });
    return null;
  }
  const gate = (karma, action) => can(karma, action);

  // --- routes ------------------------------------------------------------------------------
  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });

  on('GET', /^\/social\/api\/me$/, (req, res) => {
    const sess = session(req);
    if (!sess) return json(res, 200, { user: null });
    const p = ensureProfile(sess);
    return json(res, 200, { user: { ...pubProfile(p), email: sess.email, role: sess.role }, csrf: sess.csrf });
  });

  on('POST', /^\/social\/api\/profile$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    const b = await readJson(req, 16 * 1024);
    await store.update('profiles', a.sess.uid, (p) => {
      if (!p) return p;
      if (typeof b.displayName === 'string') p.displayName = b.displayName.slice(0, 40);
      if (typeof b.bio === 'string') p.bio = b.bio.slice(0, 280);
      return p;
    });
    return json(res, 200, { ok: true });
  });

  // --- agents-as-members -------------------------------------------------------------------
  // A Member-tier human registers an AI agent as a first-class member. The agent posts/comments
  // under a scoped bearer token (returned ONCE at creation) and can NEVER move value — it holds
  // no keys and every value endpoint is human-only. Agent authorship is always labeled in the UI.
  on('GET', /^\/social\/api\/agents$/, (req, res) => {
    const a = auth(req, res, { mutating: false }); if (!a) return;
    if (a.sess.kind === 'agent') return json(res, 403, { error: 'Agents cannot manage agents.' });
    const mine = store.all('profiles')
      .filter((p) => p.kind === 'agent' && p.ownerUid === a.sess.uid)
      .map((p) => ({ uid: p.uid, handle: p.handle, displayName: p.displayName, bio: p.bio,
        karma: p.karma, tier: tierOf(p.karma), active: p.active !== false, createdAt: p.createdAt }))
      .sort((x, y) => y.createdAt - x.createdAt);
    return json(res, 200, { agents: mine, max: cfg.maxAgentsPerOwner });
  });

  on('POST', /^\/social\/api\/agents$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    if (a.sess.kind === 'agent') return json(res, 403, { error: 'Agents cannot register agents.' });
    if (!gate(a.profile.karma, 'registerAgent'))
      return json(res, 403, { error: `Reach the Member tier (${config.tiers.member} karma) to register an agent.` });
    const active = store.all('profiles').filter((p) => p.kind === 'agent' && p.ownerUid === a.sess.uid && p.active !== false);
    if (active.length >= cfg.maxAgentsPerOwner)
      return json(res, 409, { error: `You can run up to ${cfg.maxAgentsPerOwner} agents. Revoke one first.` });
    const b = await readJson(req, 8 * 1024);
    const handle = String(b.handle || '').toLowerCase().trim();
    if (!handleRe.test(handle)) return json(res, 400, { error: 'Handle must be 3–20 chars: a–z, 0–9, _' });
    if (store.get('handles', handle)) return json(res, 409, { error: 'That handle is taken.' });
    const uid = 'agent:' + randomToken(10);
    const raw = 'blk_agent_' + randomToken(24);
    const p = { uid, handle, displayName: String(b.name || handle).slice(0, 40), bio: String(b.bio || '').slice(0, 280),
      kind: 'agent', ownerUid: a.sess.uid, active: true, karma: 0, blockUnits: 0, createdAt: now() };
    await store.put('profiles', uid, p);
    await store.put('handles', handle, uid);
    await store.put('agentTokens', sha256(raw), { uid, ownerUid: a.sess.uid, createdAt: now() });
    // the raw token is returned ONCE and never stored in the clear
    return json(res, 200, { ok: true, agent: { uid, handle, displayName: p.displayName }, token: raw });
  });

  on('POST', /^\/social\/api\/agents\/([^/]+)\/revoke$/, async (req, res, url, m) => {
    const a = auth(req, res); if (!a) return;
    if (a.sess.kind === 'agent') return json(res, 403, { error: 'Agents cannot manage agents.' });
    const agentUid = decodeURIComponent(m[1]);
    const p = store.get('profiles', agentUid);
    if (!p || p.kind !== 'agent' || p.ownerUid !== a.sess.uid) return json(res, 404, { error: 'No such agent.' });
    await store.update('profiles', agentUid, (pp) => { if (pp) pp.active = false; return pp; });
    return json(res, 200, { ok: true });
  });

  on('GET', /^\/social\/api\/categories$/, (req, res) => json(res, 200, { categories: CATEGORIES }));

  on('GET', /^\/social\/api\/communities$/, (req, res) =>
    json(res, 200, {
      categories: CATEGORIES,
      // official + pinned first, then by members
      communities: store.all('communities').sort((a, b) =>
        (b.official - a.official) || (b.members - a.members)),
    }));

  on('POST', /^\/social\/api\/communities$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    if (!gate(a.profile.karma, 'createCommunity'))
      return json(res, 403, { error: `Reach the Member tier (${config.tiers.member} karma) to create a community.` });
    const b = await readJson(req, 16 * 1024);
    const name = String(b.name || '').toLowerCase().trim();
    if (!nameRe.test(name)) return json(res, 400, { error: 'Name must be 2–24 chars: a–z, 0–9, _' });
    if (store.get('communities', name)) return json(res, 409, { error: 'That community already exists.' });
    const category = CATEGORIES.includes(b.category) ? b.category : 'Culture';
    const c = { id: name, name, title: String(b.title || name).slice(0, 60), desc: String(b.desc || '').slice(0, 280),
      category, official: false, pinned: false, ownerUid: a.sess.uid, members: 1, createdAt: now() };
    await store.put('communities', name, c);
    return json(res, 200, { ok: true, community: c });
  });

  on('GET', /^\/social\/api\/feed$/, (req, res, url) => {
    const sort = url.searchParams.get('sort') || 'hot';
    const c = url.searchParams.get('c');
    let posts = store.all('posts');
    if (c) posts = posts.filter((p) => p.cid === c);
    posts = rank(posts, sort, now());
    const withAuthors = posts.slice(0, 60).map((p) => decorate(p, store));
    return json(res, 200, { posts: withAuthors });
  });

  on('POST', /^\/social\/api\/posts$/, async (req, res) => {
    const a = auth(req, res, { allowAgent: true }); if (!a) return;
    if (!rl.allow('post:' + a.sess.uid)) return json(res, 429, { error: 'Slow down a moment.' });
    const b = await readJson(req, cfg.postMaxBytes);
    const cid = String(b.cid || '').toLowerCase();
    if (!store.get('communities', cid)) return json(res, 400, { error: 'Pick a community.' });
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return json(res, 400, { error: 'Add a title.' });
    const kind = b.kind === 'link' ? 'link' : (b.kind === 'token' ? 'token' : 'text');
    const body = String(b.body || '').slice(0, cfg.postMaxBytes);
    if (kind === 'link' && !/^https?:\/\/\S+$/.test(body)) return json(res, 400, { error: 'Enter a valid URL.' });
    // A token card embeds a live BLOCK-20 reference (symbol or contract) that renders
    // an inline trade card linking out to the user's own non-custodial DEX — social
    // never holds keys or routes an order.
    let token;
    if (kind === 'token') {
      token = normalizeTokenRef(b.token);
      if (!token) return json(res, 400, { error: 'Enter a token symbol (e.g. BLOCK) or 0x contract address.' });
    }
    const id = randomToken(8);
    const post = { id, cid, uid: a.sess.uid, kind, title, body, score: 0, up: 0, down: 0, comments: 0, createdAt: now() };
    if (token) post.token = token;
    await store.put('posts', id, post);
    return json(res, 200, { ok: true, id });
  });

  on('GET', /^\/social\/api\/post\/([^/]+)$/, (req, res, url, m) => {
    const post = store.get('posts', m[1]);
    if (!post) return json(res, 404, { error: 'Not found.' });
    const comments = store.all('comments').filter((c) => c.pid === post.id)
      .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
      .map((c) => ({ ...c, author: authorOf(c.uid, store) }));
    return json(res, 200, { post: decorate(post, store), comments });
  });

  on('POST', /^\/social\/api\/comments$/, async (req, res) => {
    const a = auth(req, res, { allowAgent: true }); if (!a) return;
    if (!rl.allow('comment:' + a.sess.uid)) return json(res, 429, { error: 'Slow down a moment.' });
    const b = await readJson(req, cfg.postMaxBytes);
    const post = store.get('posts', String(b.pid || ''));
    if (!post) return json(res, 400, { error: 'No such post.' });
    const body = String(b.body || '').trim().slice(0, 8000);
    if (!body) return json(res, 400, { error: 'Write something.' });
    const id = randomToken(8);
    await store.put('comments', id, { id, pid: post.id, uid: a.sess.uid,
      parent: b.parent ? String(b.parent).slice(0, 16) : null, body, score: 0, createdAt: now() });
    await store.update('posts', post.id, (p) => { if (p) p.comments = (p.comments || 0) + 1; return p; });
    return json(res, 200, { ok: true, id });
  });

  // One weighted vote per user per target; changing/clearing reverses the prior effect exactly.
  on('POST', /^\/social\/api\/vote$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    if (!voteRl.allow('vote:' + a.sess.uid)) return json(res, 429, { error: 'Slow down a moment.' });
    const b = await readJson(req, 4 * 1024);
    const type = b.targetType === 'comment' ? 'comments' : 'posts';
    const target = store.get(type, String(b.targetId || ''));
    if (!target) return json(res, 404, { error: 'Not found.' });
    if (target.uid === a.sess.uid) return json(res, 400, { error: 'You can’t vote on your own post.' });
    const dir = b.dir === 1 ? 1 : b.dir === -1 ? -1 : 0;
    const key = `${a.sess.uid}:${type}:${target.id}`;
    const prev = store.get('votes', key);
    const weight = voteWeight(a.profile.karma, ageDays(a.profile));
    // reverse previous
    let dScore = 0, dKarma = 0;
    if (prev) { dScore -= prev.dir * prev.weight; dKarma -= prev.dir * prev.weight; }
    if (dir !== 0) { dScore += dir * weight; dKarma += dir * weight; await store.put('votes', key, { dir, weight }); }
    else await store.del('votes', key);
    await store.update(type, target.id, (t) => { if (t) t.score = round1((t.score || 0) + dScore); return t; });
    await store.update('profiles', target.uid, (p) => { if (p) p.karma = round1((p.karma || 0) + dKarma); return p; });
    return json(res, 200, { ok: true });
  });

  // Tip BLOCK (integer units) — moves real balance; nothing minted. Fee to the rewards pool.
  on('POST', /^\/social\/api\/tip$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    if (!rl.allow('tip:' + a.sess.uid)) return json(res, 429, { error: 'Slow down a moment.' });
    const b = await readJson(req, 4 * 1024);
    const type = b.targetType === 'comment' ? 'comments' : 'posts';
    const target = store.get(type, String(b.targetId || ''));
    if (!target) return json(res, 404, { error: 'Not found.' });
    if (target.uid === a.sess.uid) return json(res, 400, { error: 'You can’t tip yourself.' });
    const amount = Math.floor(Number(b.amount));
    if (!Number.isFinite(amount) || amount < cfg.minTipBlock) return json(res, 400, { error: `Minimum tip is ${cfg.minTipBlock} BLOCK.` });
    const sender = store.get('profiles', a.sess.uid);
    if ((sender.blockUnits || 0) < amount) return json(res, 402, { error: 'Not enough BLOCK — fund your balance from your wallet.' });
    const fee = Math.floor((amount * cfg.platformFeeBps) / 10000);
    const net = amount - fee;
    // atomic-ish sequence through the serialized store queue
    await store.update('profiles', a.sess.uid, (p) => { if (p) p.blockUnits -= amount; return p; });
    // Tips move BLOCK only — they do NOT grant karma. Reputation is earned (votes/awards),
    // never bought, so money can't buy privilege (see docs/SOCIAL.md §2).
    await store.update('profiles', target.uid, (p) => { if (p) p.blockUnits += net; return p; });
    await store.update('meta', 'pool', (m) => ({ units: ((m && m.units) || 0) + fee }));
    const id = randomToken(8);
    await store.put('tips', id, { id, fromUid: a.sess.uid, toUid: target.uid, type, targetId: target.id, amount, fee, at: now() });
    return json(res, 200, { ok: true, net, fee });
  });

  // BLOCK gold — the award catalog (for the UI).
  on('GET', /^\/social\/api\/awards$/, (req, res) => json(res, 200, { awards: AWARDS }));

  // Give an AWARD: spend BLOCK, tip the creator (minus a pool fee), stamp a badge. No karma.
  on('POST', /^\/social\/api\/award$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    if (!rl.allow('award:' + a.sess.uid)) return json(res, 429, { error: 'Slow down a moment.' });
    const b = await readJson(req, 4 * 1024);
    const type = b.targetType === 'comment' ? 'comments' : 'posts';
    const target = store.get(type, String(b.targetId || ''));
    if (!target) return json(res, 404, { error: 'Not found.' });
    if (target.uid === a.sess.uid) return json(res, 400, { error: 'You can’t award your own post.' });
    const award = AWARD_BY_ID[String(b.award || '')];
    if (!award) return json(res, 400, { error: 'Unknown award.' });
    const sender = store.get('profiles', a.sess.uid);
    if ((sender.blockUnits || 0) < award.cost) return json(res, 402, { error: 'Not enough BLOCK — fund your balance from your wallet.' });
    const fee = Math.floor((award.cost * AWARD_FEE_BPS) / 10000);
    const net = award.cost - fee;
    await store.update('profiles', a.sess.uid, (p) => { if (p) p.blockUnits -= award.cost; return p; });
    await store.update('profiles', target.uid, (p) => { if (p) p.blockUnits += net; return p; });
    await store.update('meta', 'pool', (m) => ({ units: ((m && m.units) || 0) + fee }));
    await store.update(type, target.id, (t) => { if (t) { t.awards = t.awards || {}; t.awards[award.id] = (t.awards[award.id] || 0) + 1; } return t; });
    await store.put('tips', randomToken(8), { id: randomToken(8), kind: 'award', award: award.id, fromUid: a.sess.uid, toUid: target.uid, type, targetId: target.id, amount: award.cost, fee, at: now() });
    return json(res, 200, { ok: true, net, fee });
  });

  // BOOST a post: pay BLOCK (to the rewards pool) to extend its reach for a window. Always labeled.
  on('POST', /^\/social\/api\/boost$/, async (req, res) => {
    const a = auth(req, res); if (!a) return;
    if (!rl.allow('boost:' + a.sess.uid)) return json(res, 429, { error: 'Slow down a moment.' });
    const b = await readJson(req, 4 * 1024);
    const target = store.get('posts', String(b.targetId || ''));
    if (!target) return json(res, 404, { error: 'Not found.' });
    const amount = Math.floor(Number(b.amount));
    if (!Number.isFinite(amount) || amount < MIN_BOOST) return json(res, 400, { error: `Minimum boost is ${MIN_BOOST} BLOCK.` });
    const sender = store.get('profiles', a.sess.uid);
    if ((sender.blockUnits || 0) < amount) return json(res, 402, { error: 'Not enough BLOCK — fund your balance from your wallet.' });
    await store.update('profiles', a.sess.uid, (p) => { if (p) p.blockUnits -= amount; return p; });
    await store.update('meta', 'pool', (m) => ({ units: ((m && m.units) || 0) + amount })); // boosts fund the rewards pool
    await store.update('posts', target.id, (t) => { if (t) { t.boost = (t.boost || 0) + amount; t.boostedUntil = now() + BOOST_DURATION_MS; } return t; });
    return json(res, 200, { ok: true });
  });

  // Deposit hook: the wallet credits social BLOCK after an on-chain deposit is confirmed.
  // Guarded so only the trusted settlement caller (shared secret) can credit — NEVER a browser.
  on('POST', /^\/social\/api\/deposit$/, async (req, res) => {
    const secret = req.headers['x-settle-secret'] || '';
    if (!cfg.settleSecret || !timingSafeEqualStr(cfg.settleSecret, secret)) return json(res, 404, { error: 'not found' });
    const b = await readJson(req, 4 * 1024);
    const uid = String(b.uid || ''); const units = Math.floor(Number(b.units));
    if (!store.get('profiles', uid) || !Number.isFinite(units) || units <= 0) return json(res, 400, { error: 'bad' });
    await store.update('profiles', uid, (p) => { if (p) p.blockUnits += units; return p; });
    return json(res, 200, { ok: true });
  });

  // --- server ------------------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(cfg))) res.setHeader(k, v);
    if (cfg.killed) return json(res, 503, { error: 'maintenance' });
    let url; try { url = new URL(req.url, cfg.publicOrigin); } catch { return json(res, 400, { error: 'bad url' }); }
    const pathn = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && pathn === `${cfg.basePath}/app.js`) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(APP_JS);
      }
      if (pathn === `${cfg.basePath}/healthz`) return json(res, 200, { ok: true });
      for (const r of routes) {
        const m = pathn.match(r.re);
        if (m && r.method === req.method) return await r.fn(req, res, url, m);
      }
      // Any other GET under the base path → the SPA shell (client routes by pathname).
      if (req.method === 'GET' && (pathn === cfg.basePath || pathn.startsWith(cfg.basePath + '/')))
        return html(res, 200, renderShell(cfg));
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (/payload too large/.test(e.message)) return json(res, 413, { error: 'too large' });
      if (/bad json/.test(e.message)) return json(res, 400, { error: 'bad json' });
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  return { server, store, cfg, ensureProfile, _internal: { rl } };
}

// --- helpers --------------------------------------------------------------------------------
function round1(n) { return Math.round(n * 10) / 10; }

// A token reference is either a ticker symbol (1–12 alphanumerics, a leading $ allowed
// and stripped) or a BLOCK-20 / EVM-style 0x contract address. Symbols are upper-cased so
// cards dedupe; anything else is rejected. Returns null when the ref is unusable.
function normalizeTokenRef(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('$')) s = s.slice(1);
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(s)) return s.toUpperCase();
  return null;
}

function authorOf(uid, store) {
  const p = store.get('profiles', uid);
  if (!p) return { handle: '[deleted]', tier: 'new' };
  const out = { handle: p.handle, tier: tierOf(p.karma) };
  if (p.kind === 'agent') {
    // transparency: an agent author is always labeled with its human owner's handle
    out.kind = 'agent';
    const owner = store.get('profiles', p.ownerUid);
    out.ownerHandle = owner ? owner.handle : null;
  }
  return out;
}
function decorate(post, store) {
  const c = store.get('communities', post.cid);
  return { ...post, author: authorOf(post.uid, store), community: c ? { name: c.name, title: c.title } : null };
}
// Hot ranking: score decayed by age (Reddit-style gravity). new = recency, top = raw score.
function rank(posts, sort, t) {
  if (sort === 'new') return posts.sort((a, b) => b.createdAt - a.createdAt);
  if (sort === 'top') return posts.sort((a, b) => b.score - a.score);
  // Hot = score decayed by age; a currently-boosted post gets a bounded reach bump (labeled in UI).
  const boosted = (p) => p.boostedUntil && p.boostedUntil > t;
  const hot = (p) => ((p.score + 1) / Math.pow(((t - p.createdAt) / 3600000) + 2, 1.5)) * (boosted(p) ? 3 : 1);
  return posts.sort((a, b) => hot(b) - hot(a));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.server.listen(app.cfg.port, app.cfg.host, () =>
    console.log(`[social] listening on ${app.cfg.host}:${app.cfg.port} base=${app.cfg.basePath} (prod=${app.cfg.prod})`));
}
