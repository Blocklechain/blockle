// Blockle CLOUD BOTS — a server-side runner for PAPER bots, so a bot keeps
// trading after the user closes the wallet. It runs the SAME engine the web
// wallet ships (web/wallet/vendor/agent/{bots,bot-runner,candles}.js — pure JS,
// node-compatible), with the same price feed, the same signals discovery feed
// and the same persistence shape, one BotStore + BotRunner per Blockle account.
//
// NON-CUSTODIAL BY CONSTRUCTION: this service holds no keys and has no
// broadcast path. `armLive` is refused at the API (403) and the engine's
// value-moving dispatch is a stub that rejects, so a cloud bot can only ever be
// paper. Live bots run on the user's device, where the keys are.
//
// Auth: the caller's Blockle account session (the blk_sess cookie or a bearer
// token), resolved through the accounts service's /account/api/me. Bots are
// scoped per account id and persisted under /var/lib/blockle-bots/users/<uid>.json.
//
// API (nginx proxies /api/bots/ here):
//   GET  /api/bots                 → { bots:[{...spec, dashboard}], aggregate, limits }
//   POST /api/bots                 { spec, allocationUsd } → add + enablePaper
//   POST /api/bots/import          { bots:[toJSON…] } → import paper bots (state kept)
//   POST /api/bots/stop-all        { flatten?: bool }
//   GET  /api/bots/:id             → dashboard
//   GET  /api/bots/:id/export      → template JSON
//   POST /api/bots/:id/:action     pause | start | resume | remove | tick | flatten
//   POST /api/bots/:id/live        → 403 (device-only)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.BOTS_PORT || 8835);
const DATA = process.env.BOTS_DATA || '/var/lib/blockle-bots';
const VENDOR = process.env.BOTS_VENDOR || '/opt/blockle/web/wallet/vendor';
const ACCOUNTS = (process.env.BOTS_ACCOUNTS_URL || 'http://127.0.0.1:8930').replace(/\/+$/, '');
const SIGNALS = (process.env.BOTS_SIGNALS_URL || 'http://127.0.0.1:8809').replace(/\/+$/, '');
const BIZ = (process.env.BOTS_BIZ_URL || 'http://127.0.0.1:8900').replace(/\/+$/, '');
const MIN_POLL_SEC = Number(process.env.BOTS_MIN_POLL_SEC || 15);
const LIMITS = { free: 2, pro: 5, copilot: 5, copilot_pro: 25 };

// ---- the shared engine (the exact files the wallet runs) ---------------------
const Bots = require(path.join(VENDOR, 'agent/bots.js'));
require(path.join(VENDOR, 'agent/candles.js'));
const Runner = require(path.join(VENDOR, 'agent/bot-runner.js'));
const Templates = require(path.join(VENDOR, 'agent/bot-templates.js'));
const PriceFeed = require(path.join(VENDOR, 'prices.js'));

const prices = PriceFeed.create({
  fetchImpl: fetch, cacheMs: 15000,
  proxyUrl: SIGNALS + '/api/signals/prices', blockApi: BIZ,
});

// READ-ONLY lane/mode-aware candidate feed (mirrors wiring.js _signalsDiscovery).
const discovery = {
  async scan(opts) {
    opts = opts || {};
    const lane = Bots.validateLane(opts.lane);
    const mode = Bots.validateRiskMode(opts.mode) || 'medium';
    const sigChain = lane ? Bots.laneSignalsChain(lane) : (opts.chain || '');
    const base = lane ? Bots.laneBase(lane) : (opts.base || 'USDC');
    const rank = String(opts.rank || '').toLowerCase() === 'buzz' ? 'buzz' : null; // online-presence feed
    const key = 'disc:' + mode + ':' + sigChain + ':' + (rank || 'score');
    const hit = cache.get(key); if (hit && Date.now() - hit.at < 45000) return hit.v;
    let j = null;
    try {
      const r = await fetch(SIGNALS + '/api/signals/discover?mode=' + encodeURIComponent(mode) + (sigChain ? '&chain=' + encodeURIComponent(sigChain) : '') + '&limit=15' + (rank ? '&rank=buzz' : ''), { signal: AbortSignal.timeout(20000) });
      if (r.ok) j = await r.json();
    } catch (_) { j = null; }
    const cands = (j && Array.isArray(j.candidates)) ? j.candidates : [];
    const rows = cands.map((c) => {
      const m = c.metrics || {};
      const sym = (m.symbol || String(c.token).slice(0, 6)).toUpperCase();
      const regChain = c.chain === 'bsc' ? 'bnb' : c.chain;
      if (c.token) { try { prices.remember(sym, { chain: regChain, address: c.token, decimals: m.decimals, name: m.name }); } catch (_) {} }
      return {
        pair: sym + '/' + (base || 'USDC').toUpperCase(), token: c.token, chain: c.chain, symbol: sym, lane,
        approved: c.safe === true, score: Math.max(0, Math.min(1, (Number(c.score) || 0) / 100)), hype: c.hype,
        buzz: c.buzz && typeof c.buzz === 'object' ? c.buzz : null,
        liquidityUsd: m.liquidityUsd, volume24hUsd: m.volume24hUsd, marketCapUsd: m.marketCapUsd, ageSec: m.ageSec,
        topHolderPct: m.topHolderPct, honeypot: m.honeypot === true,
        liquidityLocked: (m.lpLockedPct != null ? m.lpLockedPct >= 50 : undefined), mintAuthorityRenounced: m.mintRenounced, flags: c.flags || [],
      };
    });
    cache.set(key, { at: Date.now(), v: rows });
    return rows;
  },
};
const cache = new Map();

// ---- per-user persistence + runners -------------------------------------------
fs.mkdirSync(path.join(DATA, 'users'), { recursive: true });
function userFile(uid) { return path.join(DATA, 'users', uid.replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
function storeFor(uid) {
  const file = userFile(uid);
  return {
    async get(keys) {
      let obj = {};
      try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { obj = {}; }
      const out = {}; for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]; return out;
    },
    async set(patch) {
      let obj = {};
      try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { obj = {}; }
      Object.assign(obj, patch);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file);
    },
  };
}
const runners = new Map(); // uid -> BotRunner
const policy = { caps: { sessionUsd: 0 }, autoApproveUnderUsd: null, assertLive() {}, isKilled() { return false; }, isAllowed() { return true; }, async kill() {} };
const tools = { get() { return null; } };
const AgentRunnerStub = { dispatchValueMoving: async () => ({ rejected: true, reason: 'cloud bots are paper-only (keys live on your device)' }) };

async function runnerFor(uid) {
  if (runners.has(uid)) return runners.get(uid);
  const r = Runner.create({
    policy, tools, audit: null, persist: storeFor(uid), wallet: uid, channel: 'cloud', mainnetEnabled: false, discovery,
    AgentRunner: AgentRunnerStub,
    ctx: {
      now: () => Date.now(), network: () => 'testnet', discovery,
      prices: (syms) => prices.prices(syms), decimalsFor: (s) => prices.decimalsOf(s),
    },
    onEvent: () => {},
  });
  await r.store.restore();
  // every persisted bot is PAPER on the server, whatever the file claims.
  for (const b of r.store.list()) { b.mode = 'paper'; b.network = 'testnet'; if (b.pollSec < MIN_POLL_SEC) b.pollSec = MIN_POLL_SEC; }
  if (r.store.enabled().length) r._restartScheduler();
  runners.set(uid, r);
  return r;
}
async function bootAll() {
  let n = 0, enabled = 0;
  for (const f of fs.readdirSync(path.join(DATA, 'users'))) {
    if (!f.endsWith('.json')) continue;
    const uid = f.slice(0, -5);
    try { const r = await runnerFor(uid); n += r.store.list().length; enabled += r.store.enabled().length; } catch (e) { console.warn('[bots] boot', uid, e.message); }
  }
  console.log(`[bots] restored ${n} bot(s), ${enabled} running, across ${runners.size} account(s)`);
}

// ---- auth: resolve the caller's Blockle account through /account/api/me -------
const authCache = new Map(); // tokenHash -> { at, user }
async function whoami(req) {
  const cookie = req.headers.cookie || '', authz = req.headers.authorization || '';
  if (!cookie && !authz) return null;
  const key = crypto.createHash('sha256').update(cookie + '|' + authz).digest('hex');
  const hit = authCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.user;
  try {
    const r = await fetch(ACCOUNTS + '/account/api/me', { headers: { cookie, authorization: authz, 'x-blockle-client': 'cloud-bots', accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) { authCache.set(key, { at: Date.now(), user: null }); return null; }
    const j = await r.json();
    const u = j && j.user && j.user.id ? j.user : null;
    authCache.set(key, { at: Date.now(), user: u });
    return u;
  } catch (_) { return null; }
}
function tierOf(user) { const s = user && user.sub; return (s && s.active) ? (s.tier || 'pro') : 'free'; }
function limitFor(user) { return LIMITS[tierOf(user)] || LIMITS.free; }

// ---- JSON views (BigInt-free) ----------------------------------------------------
function botView(r, b) {
  let describe = ''; try { describe = b.describe(); } catch (_) {}
  return {
    id: b.id, name: b.name, type: b.type, lane: b.lane, riskMode: b.riskMode, profitMode: b.profitMode, preset: b.preset || null,
    universe: b.universe, config: b.config, risk: b.risk, pollSec: b.pollSec, mode: b.mode, enabled: b.enabled, network: b.network,
    allocationUsd: b.allocationUsd, createdAt: b.createdAt, cloud: true, describe,
    dashboard: r.dashboard(b.id),
  };
}
function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function sanitizeSpec(spec) {
  spec = spec && typeof spec === 'object' ? spec : {};
  const out = {
    name: String(spec.name || '').slice(0, 60) || undefined, type: spec.type, lane: spec.lane, riskMode: spec.riskMode, profitMode: spec.profitMode,
    preset: spec.preset ? String(spec.preset).slice(0, 30) : undefined, universe: spec.universe, config: spec.config, risk: spec.risk,
    pollSec: Math.max(MIN_POLL_SEC, Number(spec.pollSec) || 60), cooldownSec: spec.cooldownSec,
    mode: 'paper', network: 'testnet', enabled: false, allocationUsd: 0,
  };
  if (spec.id && typeof spec.id === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(spec.id)) out.id = spec.id;
  if (spec.state && typeof spec.state === 'object') out.state = spec.state;
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.replace(/^\/api\/bots\/?/, '').split('/').filter(Boolean);
  if (url.pathname === '/api/bots/health') return j(res, 200, { ok: true, accounts: runners.size, minPollSec: MIN_POLL_SEC });
  try {
    const user = await whoami(req);
    if (!user) return j(res, 401, { error: 'sign in to your Blockle account to run cloud bots' });
    const uid = String(user.id);
    const r = await runnerFor(uid);
    const limit = limitFor(user);

    if (req.method === 'GET' && parts.length === 0) {
      return j(res, 200, { bots: r.store.list().map((b) => botView(r, b)), aggregate: r.aggregate(), limits: { maxBots: limit, tier: tierOf(user), minPollSec: MIN_POLL_SEC }, now: Date.now() });
    }
    if (req.method === 'POST' && parts.length === 0) {
      const body = await readBody(req);
      if (r.store.list().length >= limit) return j(res, 402, { error: 'your plan allows ' + limit + ' cloud bot' + (limit === 1 ? '' : 's') + ' — upgrade for more', limit });
      const spec = sanitizeSpec(body.spec || body);
      let bot;
      try { bot = r.add(spec); } catch (e) { return j(res, 400, { error: 'invalid bot: ' + e.message }); }
      const alloc = Number(body.allocationUsd || spec.allocationUsd || 0);
      await r.enablePaper(bot.id, { allocationUsd: alloc > 0 ? alloc : undefined });
      try { await r.tickNow(bot.id); } catch (_) {}
      return j(res, 200, { bot: botView(r, bot) });
    }
    if (req.method === 'POST' && parts[0] === 'import') {
      const body = await readBody(req);
      const list = Array.isArray(body.bots) ? body.bots : [];
      const imported = [], skipped = [];
      for (const raw of list) {
        if (r.store.list().length >= limit) { skipped.push({ id: raw && raw.id, reason: 'limit' }); continue; }
        if (!raw || raw.mode === 'live') { skipped.push({ id: raw && raw.id, reason: 'live bots stay on your device' }); continue; }
        if (raw.id && r.store.get(raw.id)) { skipped.push({ id: raw.id, reason: 'already in the cloud' }); continue; }
        try {
          const spec = sanitizeSpec(raw);
          const bot = Bots.Bot.fromJSON(Object.assign({}, spec, { state: raw.state }));
          bot.mode = 'paper'; bot.network = 'testnet'; bot.allocationUsd = Number(raw.allocationUsd) || 0; bot.preset = spec.preset;
          r.store.add(bot);
          if (raw.enabled) await r.enablePaper(bot.id, {});
          imported.push(bot.id);
        } catch (e) { skipped.push({ id: raw && raw.id, reason: e.message }); }
      }
      await r.store.persist();
      return j(res, 200, { imported, skipped });
    }
    if (req.method === 'POST' && parts[0] === 'stop-all') {
      const body = await readBody(req);
      if (body.flatten) for (const b of r.store.list()) { try { await r.flatten(b.id, 'stop-all'); } catch (_) {} }
      await r.stopAll(body.flatten ? 'flatten' : 'user');
      return j(res, 200, { ok: true });
    }
    const id = parts[0];
    const bot = id ? r.store.get(id) : null;
    if (!bot) return j(res, 404, { error: 'unknown bot' });
    if (req.method === 'GET' && parts.length === 1) return j(res, 200, { bot: botView(r, bot) });
    if (req.method === 'GET' && parts[1] === 'export') return j(res, 200, Templates.exportBot(bot));
    if (req.method === 'POST') {
      const action = parts[1];
      const body = await readBody(req).catch(() => ({}));
      switch (action) {
        case 'pause': await r.pause(id); break;
        case 'start': await r.enablePaper(id, body.allocationUsd ? { allocationUsd: Number(body.allocationUsd) } : {}); break;
        case 'resume': await r.resume(id); break;
        case 'remove': await r.remove(id); return j(res, 200, { ok: true });
        case 'tick': { const rep = await r.tickNow(id); return j(res, 200, { report: rep, bot: botView(r, bot) }); }
        case 'flatten': { const closes = await r.flatten(id, 'user'); return j(res, 200, { closes, bot: botView(r, bot) }); }
        case 'live': return j(res, 403, { error: 'live bots run on your device (keys never leave it) — use the wallet\'s local mode to arm live' });
        default: return j(res, 404, { error: 'unknown action' });
      }
      return j(res, 200, { bot: botView(r, bot) });
    }
    return j(res, 404, { error: 'not found' });
  } catch (e) {
    return j(res, 500, { error: (e && e.message) || String(e) });
  }
});

bootAll().then(() => {
  server.listen(PORT, '127.0.0.1', () => console.log(`[bots] cloud bot runner on 127.0.0.1:${PORT} data=${DATA}`));
});
