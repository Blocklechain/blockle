// Blockle accounts service — auth, 2FA, sessions, zero-knowledge wallet backup, PayPal paid
// tier, support tickets, and a role-gated admin surface. Non-custodial: the server never holds
// a key/seed/plaintext wallet — /backup stores opaque client-encrypted ciphertext only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, resolveSecrets } from './config.js';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { RateLimiter } from './ratelimit.js';
import { makeMailer } from './email.js';
import { makePaypal, entitlementFromEvent } from './paypal.js';
import { makeAppleStore, makeGoogleStore, productTier } from './iap.js';
import { makeBacktester } from './backtest.js';
import { makeMoonpay } from './moonpay.js';
import { makeLiquidity } from './liquidity.js';
import { settleSwap, liquidityMainnet, settleableCoins } from './liquidity_relayer.js';
import { solRpcSender } from './liquidity_sol.js';
import { rpcSenderFor } from './liverunner.js';
import { makePrices } from './prices.js';
import { makeBotDelegations } from './botdelegate.js';
import { MAINNET_CHAIN_IDS, mainnetEnabled } from './liveexec.js';
import { runOnce as liveRunOnce } from './liverunner.js';
import {
  hashPassword, verifyPassword, randomToken, sha256, timingSafeEqualStr,
  totpSecret, totpVerify, totpUri, genRecoveryCodes, safeNow,
} from './crypto.js';
import {
  securityHeaders, readJson, readBody, parseCookies, parseCookieValues, setCookie, clearCookie,
  json, html, redirect, sameOrigin, EMAIL_RE,
} from './http.js';
import { renderPage } from './pages.js';
import { makeChain } from './chain.js';
import { newBot, botView, step as botStep, BOT_TYPES } from './bots.js';
import { CURATED_DAPPS, CURATED_DAPP_IDS } from './dapps.js';
import { trafficReport } from './traffic.js';

const SESSION_COOKIE = 'blk_sess';
const APP_JS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');
// A fixed dummy hash to verify against when an account is absent, so login/register response
// time does not reveal whether an email exists (constant-work path).
const DUMMY_HASH = hashPassword(randomToken(16));

export function createApp(overrides = {}) {
  resolveSecrets();
  const cfg = { ...config, ...overrides.config };
  const now = overrides.now || safeNow;
  const store = overrides.store || new Store(cfg.dataDir);
  const sessions = new Sessions(store, cfg, now);
  const mailer = overrides.mailer || makeMailer(cfg);
  const paypal = overrides.paypal || makePaypal(cfg, overrides.paypalDeps);
  const appleStore = overrides.appleStore || makeAppleStore(cfg, overrides.appleDeps);
  const backtester = overrides.backtester || makeBacktester(overrides.backtestDeps);
  const moonpay = overrides.moonpay || makeMoonpay(process.env);
  const liquidity = overrides.liquidity || makeLiquidity({ store, env: process.env, now, chainBase: cfg.chainApiBase });
  const prices = overrides.prices || makePrices({});
  // Ephemeral server-side bot-delegation registry (Stage 1: lifecycle only, no
  // key material). In-memory → a restart fail-closes every delegation.
  const botDelegations = overrides.botDelegations || makeBotDelegations({});
  const googleStore = overrides.googleStore || makeGoogleStore(cfg, overrides.googleDeps);
  const chain = overrides.chain || makeChain(cfg, overrides.chainDeps || {});
  let lastKnownPrice = null; // latest BLOCK price for paper-bot marking (best-effort)
  const loginIpRl = new RateLimiter({ windowMs: cfg.rateWindowMs, max: cfg.maxLoginPerIp, lockoutBaseMs: cfg.lockoutBaseMs, lockThreshold: 10 }, now);
  const acctRl = new RateLimiter({ windowMs: cfg.rateWindowMs, max: cfg.maxLoginPerAccount, lockoutBaseMs: cfg.lockoutBaseMs, lockThreshold: 4 }, now);
  // Per-recipient cap so register/reset can't be used to mail-bomb an address.
  const mailRl = new RateLimiter({ windowMs: cfg.rateWindowMs, max: 5, lockoutBaseMs: cfg.lockoutBaseMs }, now);
  // Liquidity /settle is POLLED by wallets (every ~15 s per pending swap, plus an
  // auto-resume on app open), so it gets its own generous window — sharing the
  // 30-per-15-min login limiter starved the polling and left swaps un-settled.
  const liqSettleRl = new RateLimiter({ windowMs: 60 * 1000, max: 120, lockoutBaseMs: 0 }, now);

  const emailIndex = {
    get: (email) => store.get('emails', email.toLowerCase()),
    set: (email, uid) => store.put('emails', email.toLowerCase(), uid),
    del: (email) => store.del('emails', email.toLowerCase()),
  };
  // Unique, public usernames (the @handle shown across the site + social). 3–20 chars a–z0–9_.
  const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
  const usernameIndex = {
    get: (n) => store.get('usernames', String(n).toLowerCase()),
    set: (n, uid) => store.put('usernames', String(n).toLowerCase(), uid),
    del: (n) => store.del('usernames', String(n).toLowerCase()),
  };
  const userByEmail = (email) => {
    const uid = emailIndex.get(email || '');
    return uid ? store.get('users', uid) : null;
  };

  // --- admin seed ---------------------------------------------------------------------------
  async function ensureAdmin() {
    if (!cfg.adminEmail || !cfg.adminPassword) return;
    if (emailIndex.get(cfg.adminEmail)) return;
    const uid = randomToken(9);
    await store.put('users', uid, {
      id: uid, email: cfg.adminEmail, pwHash: hashPassword(cfg.adminPassword),
      verified: true, role: 'admin', createdAt: now(),
      totpEnabled: false, totpSecret: null, recoveryHashes: [],
      sub: { active: false, subId: null, plan: null },
    });
    await emailIndex.set(cfg.adminEmail, uid);
  }

  // --- helpers ------------------------------------------------------------------------------
  // Trust ONLY the right-most X-Forwarded-For hop — the one our own nginx appends via
  // $proxy_add_x_forwarded_for. The left-most values are attacker-controlled and must never be
  // used for rate-limit/lockout keys (else XFF spoofing defeats every per-IP control).
  function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return (req.socket.remoteAddress || '').trim();
  }
  async function currentSession(req) {
    // Native wallet clients authenticate with a bearer token (the session id) instead of the
    // browser cookie, since the SameSite=Lax cookie won't ride cross-site fetches.
    const authz = req.headers['authorization'];
    if (authz && /^Bearer\s+/i.test(authz)) {
      const id = authz.replace(/^Bearer\s+/i, '').trim();
      const sess = await sessions.get(id);
      if (!sess) return null;
      await sessions.touch(id);
      return { id, viaBearer: true, ...sess };
    }
    // The cookie name can appear more than once — a stale host-only blk_sess sent
    // alongside the newer Domain=.blockle.org one. Header order is browser-defined, so
    // try every value and use the first that resolves to a live session (otherwise a
    // stale duplicate wins and the user bounces back to the login screen).
    for (const id of parseCookieValues(req, SESSION_COOKIE)) {
      const sess = await sessions.get(id);
      if (sess) {
        await sessions.touch(id);
        return { id, viaBearer: false, ...sess };
      }
    }
    return null;
  }
  function requireCsrf(req, sess) {
    if (!sameOrigin(req, cfg)) return false;
    const token = req.headers['x-csrf-token'];
    return sessions.checkCsrf(sess, token);
  }
  // The single entitlement decision, folding a paid subscription AND a running free trial into
  // one effective tier. `active` keeps its strict meaning (a paid, verified subscription); a
  // trial grants `trialTier` until `trialEnd`. EVERY consumer (gas-sponsor, the clients' bot
  // gate) must read `entitledTier`, never `active`+`tier` alone, or trials won't unlock anything.
  // How many LIVE (real-money) bots a tier may run at once. Free gets 1, Copilot 3, Pro
  // unlimited (-1). Paper/Arena bots are never capped. The clients enforce this cap in their
  // armLive gate; the server exposes it so every wallet shows the same number.
  const LIVE_BOT_LIMITS = { free: 1, copilot: 3, copilot_pro: -1 };
  const entitlement = (sub) => {
    sub = sub || {};
    const t = now();
    const trialActive = !!sub.trialEnd && t < sub.trialEnd;
    let tier = 'free';
    if (sub.active && sub.tier && sub.tier !== 'free') tier = sub.tier;      // paid wins
    else if (trialActive) tier = sub.trialTier || cfg.trialTier || 'copilot'; // else trial
    const liveBotLimit = LIVE_BOT_LIMITS[tier] != null ? LIVE_BOT_LIMITS[tier] : 1;
    return { entitledTier: tier, liveBotLimit, paid: !!(sub.active && sub.tier && sub.tier !== 'free'), trialActive, trialEnd: sub.trialEnd || null };
  };
  const subView = (sub) => {
    const e = entitlement(sub);
    return { ...(sub || { active: false }), entitledTier: e.entitledTier, liveBotLimit: e.liveBotLimit, trialActive: e.trialActive, trialEnd: e.trialEnd };
  };
  const publicUser = (u) => u && ({
    id: u.id, email: u.email, username: u.username || null, verified: u.verified, role: u.role, createdAt: u.createdAt || null,
    totpEnabled: !!u.totpEnabled, recoveryLeft: (u.recoveryHashes || []).length,
    sub: subView(u.sub), onboarded: !!u.onboarded,
  });

  // Best-effort read of the user's social profile (handle/karma/BLOCK) from the social store.
  function socialProfile(uid) {
    try {
      const raw = fs.readFileSync(path.join(cfg.socialDataDir, 'profiles.json'), 'utf8');
      const p = JSON.parse(raw)[uid];
      return p ? { handle: p.handle, karma: p.karma, blockUnits: p.blockUnits } : null;
    } catch { return null; }
  }

  // --- handlers -----------------------------------------------------------------------------
  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });

  on('POST', /^\/account\/api\/register$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    if (!loginIpRl.allow('reg:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024);
    const email = String(b.email || '').toLowerCase().trim();
    const password = String(b.password || '');
    if (!EMAIL_RE.test(email) || password.length < 10)
      return json(res, 400, { error: 'Enter a valid email and a password of at least 10 characters.' });
    // Optional username — public + unique, so (unlike email) a collision is safe to report.
    const username = b.username != null ? String(b.username).toLowerCase().trim() : '';
    if (username) {
      if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'Username must be 3–20 chars: letters, numbers, underscore.' });
      if (usernameIndex.get(username)) return json(res, 409, { error: 'That username is taken.' });
    }
    // Always hash (even if the account exists) so timing can't reveal account existence.
    const pwHash = hashPassword(password);
    // Generic success even if the email exists — never reveal account existence.
    if (!userByEmail(email)) {
      const uid = randomToken(9);
      await store.put('users', uid, {
        id: uid, email, username: username || null, pwHash, verified: false, role: 'user',
        createdAt: now(), totpEnabled: false, totpSecret: null, recoveryHashes: [],
        sub: { active: false, subId: null, plan: null },
      });
      await emailIndex.set(email, uid);
      if (username) await usernameIndex.set(username, uid);
      const token = randomToken(32);
      await store.put('tokens', sha256(token), { type: 'verify', uid, exp: now() + cfg.tokenTtlMs });
      const url = `${cfg.publicOrigin}/account/verify?token=${token}`;
      if (mailRl.allow('mail:' + email))
        await mailer.send({ to: email, subject: 'Verify your Blockle account',
          text: `Confirm your email to finish signing up:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't request this, ignore it.` });
    }
    return json(res, 200, { ok: true, message: 'If that email is new, a verification link is on its way.' });
  });

  on('GET', /^\/account\/api\/verify$/, async (req, res, url) => {
    const token = url.searchParams.get('token') || '';
    const rec = store.get('tokens', sha256(token));
    if (!rec || rec.type !== 'verify' || rec.exp < now()) return json(res, 400, { error: 'Invalid or expired link.' });
    await store.del('tokens', sha256(token));
    await store.update('users', rec.uid, (u) => { if (u) u.verified = true; return u; });
    return json(res, 200, { ok: true });
  });

  on('POST', /^\/account\/api\/login$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    const ip = clientIp(req);
    if (loginIpRl.lockedFor('ip:' + ip) || !loginIpRl.allow('login:' + ip)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const b = await readJson(req, 64 * 1024);
    const email = String(b.email || '').toLowerCase().trim();
    const acctKey = 'acct:' + email;
    if (acctRl.lockedFor(acctKey)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const u = userByEmail(email);
    // Always run scrypt (against a dummy hash when absent) so timing can't enumerate accounts.
    const ok = verifyPassword(String(b.password || ''), u ? u.pwHash : DUMMY_HASH) && !!u;
    if (!ok) { acctRl.recordFailure(acctKey); loginIpRl.recordFailure('ip:' + ip); return json(res, 401, { error: 'Email or password is incorrect.' }); }
    if (!u.verified) return json(res, 403, { error: 'Please verify your email first — check your inbox.' });
    if (u.totpEnabled) {
      const code = String(b.totp || '');
      const recoveryOk = await tryRecovery(u, code);
      if (!totpVerify(u.totpSecret, code, now()) && !recoveryOk)
        { acctRl.recordFailure(acctKey); return json(res, 401, { error: '2fa', message: 'Enter your 6-digit code.' }); }
    }
    acctRl.reset(acctKey);
    const { id, csrf } = await sessions.create(u.id, { ip, ua: req.headers['user-agent'] });
    // migrating to a Domain-scoped cookie? drop any stale host-only blk_sess first so the
    // browser doesn't keep sending two values for the same name.
    if (cfg.cookieDomain) clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure });
    setCookie(res, SESSION_COOKIE, id, { maxAgeMs: cfg.sessionAbsoluteMs, secure: cfg.cookieSecure, domain: cfg.cookieDomain });
    const resp = { ok: true, csrf, user: publicUser(u) };
    // Native wallet clients (not browsers) get the session id as a bearer token. Browsers never
    // send this header, so the token stays out of any JS-readable response in the web context.
    if (req.headers['x-blockle-client']) resp.token = id;
    return json(res, 200, resp);
  });

  // Atomic check-and-consume: the membership test and removal happen inside the same store.update
  // so two concurrent logins can't both spend one recovery code.
  async function tryRecovery(u, code) {
    const h = sha256(code);
    let consumed = false;
    await store.update('users', u.id, (x) => {
      if (!x || !(x.recoveryHashes || []).includes(h)) return undefined; // no change
      x.recoveryHashes = x.recoveryHashes.filter((v) => v !== h);
      consumed = true;
      return x;
    });
    return consumed;
  }

  on('POST', /^\/account\/api\/logout$/, async (req, res) => {
    const sess = await currentSession(req);
    if (sess && requireCsrf(req, sess)) await sessions.destroy(sess.id);
    clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure, domain: cfg.cookieDomain });
    return json(res, 200, { ok: true });
  });

  on('POST', /^\/account\/api\/onboarded$/, authed(async (req, res, { u }) => {
    await store.update('users', u.id, (x) => { if (x) x.onboarded = true; return x; });
    return json(res, 200, { ok: true });
  }));

  on('GET', /^\/account\/api\/me$/, async (req, res) => {
    const sess = await currentSession(req);
    if (!sess) return json(res, 401, { error: 'auth' });
    const u = store.get('users', sess.uid);
    return json(res, 200, { user: publicUser(u), csrf: sess.csrf });
  });

  // Dashboard overview — non-secret account facts. Reveals backup COUNT/time (never ciphertext),
  // active-session count, and the linked social profile. Powers the expanded dashboard.
  on('GET', /^\/account\/api\/overview$/, authed(async (req, res, { u }) => {
    const bk = store.get('backups', u.id);
    const sessionCount = store.entries('sessions').filter(([, r]) => r.uid === u.id).length;
    return json(res, 200, {
      user: publicUser(u),
      hasBackup: !!(bk && bk.versions && bk.versions.length),
      backupCount: bk && bk.versions ? bk.versions.length : 0,
      lastBackupAt: bk && bk.versions && bk.versions[0] ? bk.versions[0].createdAt : null,
      lastBackupDevice: bk && bk.versions && bk.versions[0] && bk.versions[0].meta ? (bk.versions[0].meta.device || bk.versions[0].meta.app || null) : null,
      sessions: sessionCount,
      social: socialProfile(u.id),
    });
  }));

  // ===== Coinbase-style portfolio (non-custodial hosted vault) =============================
  const vaultMeta = (uid) => { const bk = store.get('backups', uid); return (bk && bk.versions && bk.versions[0] && bk.versions[0].meta) || {}; };

  on('GET', /^\/account\/api\/vault\/address$/, authed((req, res, { u }) => json(res, 200, { address: vaultMeta(u.id).address || null })));

  on('GET', /^\/account\/api\/vault\/balance$/, authed(async (req, res, { u }) => {
    const addr = vaultMeta(u.id).address;
    if (!addr) return json(res, 200, { address: null, balance: null, tokens: [], note: 'Back up your wallet to link its address.' });
    return json(res, 200, await chain.balance(addr));
  }));

  // The encrypted vault blob (session + 2FA) — the browser decrypts + signs locally; never here.
  on('GET', /^\/account\/api\/vault$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled ? { error: '2fa' } : { error: '2fa_setup_required' });
    const bk = store.get('backups', u.id);
    if (!bk || !bk.versions.length) return json(res, 404, { error: 'No vault stored.' });
    return json(res, 200, { latest: bk.versions[0] });
  }));

  // Relay an opaque, client-SIGNED raw transaction. The server forwards bytes; it cannot sign.
  on('POST', /^\/account\/api\/vault\/broadcast$/, authed(async (req, res) => {
    const b = await readJson(req, 256 * 1024);
    const rawtx = String(b.rawtx || '');
    if (!rawtx || !/^[A-Za-z0-9+/=_-]+$/.test(rawtx)) return json(res, 400, { error: 'Invalid transaction.' });
    try { return json(res, 200, { ok: true, result: await chain.broadcast(rawtx) }); }
    catch { return json(res, 502, { error: 'Broadcast failed. Please try again.' }); }
  }));

  on('GET', /^\/account\/api\/markets$/, async (req, res) => {
    const sess = await currentSession(req);
    if (!sess) return json(res, 401, { error: 'auth' });
    try { return json(res, 200, { markets: await chain.markets(), price: lastKnownPrice }); }
    catch { return json(res, 200, { markets: [], price: lastKnownPrice }); }
  });

  // Public USD price proxy for the wallet — resolves {assets:[{chain,symbol,kind,
  // address?}]} to { prices:{ key: usd } }, server-cached + rate-limit-safe, so
  // clients don't each hammer CoinGecko/DeFiLlama. No auth (prices are public);
  // BLOCK/BLOCK-20 are never priced (handled inside the resolver).
  on('POST', /^\/account\/api\/prices$/, async (req, res) => {
    const b = await readJson(req, 64 * 1024).catch(() => ({}));
    try { return json(res, 200, { prices: await prices.resolve(b.assets || []) }); }
    catch { return json(res, 200, { prices: {} }); }
  });

  // ===== Server-side live-bot delegation (Stage 1: lifecycle only; NO signing) =
  // A live bot that keeps running while the app is closed registers an EPHEMERAL,
  // per-active-chain, capped delegation here; stopping it / Kill-all revokes it.
  // No key material is accepted or stored in Stage 1 (signing arrives in Stage 2).
  on('POST', /^\/account\/api\/bots\/delegate$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024).catch(() => ({}));
    try {
      // Defense-in-depth: refuse to even STORE a signing key for a mainnet chain
      // unless the operator has turned mainnet trading on. Testnet keys + no-key
      // (Stage 1) registrations are always accepted.
      const cid = b.chainId != null ? Number(b.chainId) : null;
      const isMainnetKey = (cid != null && MAINNET_CHAIN_IDS.has(cid)) || b.chain === 'solana';
      if (b.key && isMainnetKey && !mainnetEnabled(process.env)) {
        // Solana sniper keys are mainnet (the discovery feed is live SPL tokens),
        // so gate them behind the operator flag exactly like a mainnet EVM key.
        return json(res, 400, { error: 'mainnet bot keys are disabled on this server' });
      }
      const d = botDelegations.put(u.id, {
        botId: b.botId, chain: b.chain, chainId: cid, capUsd: b.capUsd,
        address: b.address, ttl: b.ttl, key: b.key, plan: b.plan,
      });
      return json(res, 200, { delegation: d }); // view carries hasKey, never the key
    } catch (e) { return json(res, 400, { error: String(e.message || 'delegate failed') }); }
  }));
  on('POST', /^\/account\/api\/bots\/revoke$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 4 * 1024).catch(() => ({}));
    // { botId } revokes one; omit botId to revoke ALL (Kill-all).
    const n = b.botId ? (botDelegations.revoke(u.id, String(b.botId)) ? 1 : 0)
                      : botDelegations.revokeAll(u.id);
    return json(res, 200, { revoked: n });
  }));
  on('GET', /^\/account\/api\/bots\/delegations$/, authed((req, res, { u }) =>
    json(res, 200, { delegations: botDelegations.list(u.id) })));

  // ===== 3Commas-style paper bots (play money; live trading stays client-signed in the wallet) =
  const priceFor = () => (lastKnownPrice || 1);
  on('GET', /^\/account\/api\/bots$/, authed((req, res, { u }) => {
    const bots = store.all('bots').filter((x) => x.uid === u.id).map((x) => botView(x, priceFor()));
    return json(res, 200, { bots, price: lastKnownPrice, types: BOT_TYPES });
  }));

  on('POST', /^\/account\/api\/bots$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 8 * 1024);
    if (!BOT_TYPES.includes(b.type)) return json(res, 400, { error: 'Unknown bot type.' });
    if (store.all('bots').filter((x) => x.uid === u.id).length >= 25) return json(res, 400, { error: 'Bot limit reached (25).' });
    const id = randomToken(8);
    const bot = newBot({ id, uid: u.id, type: b.type, pair: b.pair, params: b.params, now: now() });
    await store.put('bots', id, bot);
    return json(res, 200, { ok: true, bot: botView(bot, priceFor()) });
  }));

  on('POST', /^\/account\/api\/bots\/([^/]+)\/(pause|resume|delete)$/, authed(async (req, res, { u, m }) => {
    const bot = store.get('bots', m[1]);
    if (!bot || bot.uid !== u.id) return json(res, 404, { error: 'No such bot.' });
    if (m[2] === 'delete') { await store.del('bots', m[1]); return json(res, 200, { ok: true }); }
    await store.update('bots', m[1], (x) => { if (x) x.status = m[2] === 'pause' ? 'paused' : 'running'; return x; });
    return json(res, 200, { ok: true });
  }));

  // Quick backtest of a CONFIGURED strategy on recent real prices (the wallet's tune-and-test
  // loop). Play-money simulation, cached price feed — fast. { type, params, asset } -> result.
  on('POST', /^\/account\/api\/backtest$/, authed(async (req, res) => {
    const b = await readJson(req, 8 * 1024).catch(() => ({}));
    if (!BOT_TYPES.includes(b.type)) return json(res, 400, { error: 'Unknown strategy.' });
    try { return json(res, 200, await backtester.run({ type: b.type, params: b.params, asset: b.asset })); }
    catch { return json(res, 503, { error: 'Backtest price feed is unavailable right now.' }); }
  }));

  // --- MoonPay (fiat on/off-ramp + swap + commerce) -----------------------------------------
  // Public config: the PUBLISHABLE key + commerce public key + feature flags only — never a
  // secret. Clients fetch this to configure the widget. No auth (wallets are non-custodial and
  // may have no account); CORS-open so every wallet (extension/app/desktop) can read it.
  on('GET', /^\/account\/api\/moonpay\/config$/, (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    return json(res, 200, moonpay.publicConfig());
  });
  // Sign a buy/sell widget URL with the secret key (the secret NEVER leaves the server). The
  // module refuses to sign anything that isn't a MoonPay URL carrying our publishable key, so an
  // open endpoint can only ever mint the signature a user needs to ramp into their own wallet.
  // Rate-limited per IP. CORS-open for the native/extension wallets.
  on('POST', /^\/account\/api\/moonpay\/sign$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (!loginIpRl.allow('mpsign:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 8 * 1024).catch(() => ({}));
    try {
      // Explicit variant = the old direct path (debug/override). Default = the
      // ROBUST signer: auto-append allowedIpAddress=<caller's IP> (this account
      // requires IP-pinned signed URLs — 5_PARTNERS_IP_MISSING otherwise), sign,
      // and VERIFY against MoonPay's own verify_widget_signature before
      // returning, falling back across every variant if one is rejected.
      if (b.variant) return json(res, 200, moonpay.signUrl(String(b.url || ''), b.variant));
      const r = await moonpay.signUrlRobust(String(b.url || ''), { clientIp: clientIp(req) });
      return json(res, 200, r);
    }
    catch (e) { return json(res, 400, { error: String(e.message || 'sign failed') }); }
  });
  // ---- Solana JSON-RPC proxy (same-origin, fixes browser 403) ---------------
  // The browser wallets (web + extension) can't hit public Solana RPCs directly:
  // api.mainnet-beta blocks sendTransaction and solana-rpc.publicnode.com returns
  // 403 to browser origins. This same-origin relay forwards the JSON-RPC body to
  // the server-side SOLANA_RPC (publicnode works server-to-server). Native wallets
  // (Flutter/Qt) can keep calling an RPC directly. No auth (public RPC data only).
  on('POST', /^\/account\/api\/sol\/rpc$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (!loginIpRl.allow('solrpc:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024).catch(() => null);
    if (!b || typeof b.method !== 'string') return json(res, 400, { error: 'bad request' });
    const SOL = process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com';
    try {
      const r = await fetch(SOL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: b.id ?? 1, method: b.method, params: b.params || [] }),
      });
      const jr = await r.json().catch(() => null);
      return json(res, r.ok ? 200 : 502, jr ?? { error: 'upstream rpc error' });
    } catch (e) { return json(res, 502, { error: String((e && e.message) || 'rpc failed') }); }
  });
  // ---- Same-origin REST proxy for browser-blocked chain providers -----------
  // The browser wallets can't reach some public providers directly: Koios blocks
  // CORS, toncenter rate-limits keyless (429), and the old BCH host is dead. This
  // allow-listed relay forwards /account/api/px/<name>/<path> to the upstream
  // (preserving method, body, content-type, query), injecting the toncenter API
  // key server-side. Native wallets call providers directly. Public chain data only.
  const PX_UPSTREAM = {
    koios: 'https://api.koios.rest',
    toncenter: 'https://toncenter.com',
    // BCH: no live public Esplora host remains (old hosts dead/bot-walled); this
    // alive upstream keeps BCH failing QUIETLY (no connection-refused) until the
    // web UTXO adapter is ported to a Blockbook/Haskoin shape. See notes.
    bch: 'https://bchblockexplorer.com',
  };
  async function pxHandler(req, res, _url, m) {
    res.setHeader('access-control-allow-origin', '*');
    const name = m[1];
    const base = PX_UPSTREAM[name];
    if (!base) return json(res, 404, { error: 'unknown upstream' });
    if (!loginIpRl.allow('px:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const tail = m[2] + (_url.search || '');
    const headers = { accept: 'application/json' };
    const ct = req.headers['content-type']; if (ct) headers['content-type'] = ct;
    if (name === 'toncenter' && process.env.TONCENTER_API_KEY) headers['X-API-Key'] = process.env.TONCENTER_API_KEY;
    let body;
    if (req.method === 'POST') { try { body = await readBody(req, 256 * 1024); } catch { return json(res, 413, { error: 'too large' }); } }
    try {
      const r = await fetch(base + '/' + tail, { method: req.method, headers, body: req.method === 'POST' ? body : undefined });
      const buf = Buffer.from(await r.arrayBuffer());
      res.statusCode = r.status;
      res.setHeader('access-control-allow-origin', '*');
      const rct = r.headers.get('content-type'); if (rct) res.setHeader('content-type', rct);
      return res.end(buf);
    } catch (e) { return json(res, 502, { error: String((e && e.message) || 'proxy failed') }); }
  }
  on('GET', /^\/account\/api\/px\/([a-z]+)\/(.+)$/, pxHandler);
  on('POST', /^\/account\/api\/px\/([a-z]+)\/(.+)$/, pxHandler);
  // ---- Blockle Liquidity treasury (server-authoritative reserves) ----------
  // Shared reserves, one BLOCK price across every currency, fed by the 0.05% bot
  // fees. State + quote are open reads (CORS-open for the wallets); swap applies
  // authoritative accounting (on-chain settlement is gated by LIQUIDITY_MAINNET).
  on('GET', /^\/account\/api\/liquidity\/state$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    // Includes the live on-chain treasury BLOCK balance (cached explorer read).
    const s = liquidity.stateWithOnchain ? await liquidity.stateWithOnchain() : liquidity.state();
    s.settleable = settleableCoins(); // coins whose legs settle on-chain (wallets read this)
    return json(res, 200, s);
  });
  on('POST', /^\/account\/api\/liquidity\/quote$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const b = await readJson(req, 8 * 1024).catch(() => ({}));
    return json(res, 200, liquidity.quote(b.from, b.to, b.amountIn, b.coinUsd));
  });
  on('POST', /^\/account\/api\/liquidity\/swap$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (!loginIpRl.allow('liqswap:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 8 * 1024).catch(() => ({}));
    try {
      const r = await liquidity.swap({ from: b.from, to: b.to, amountIn: b.amountIn, coinUsd: b.coinUsd, userAddress: b.userAddress });
      return json(res, r.ok ? 200 : 400, r);
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || 'swap failed') }); }
  });
  // Record a bot fee into the treasury. Rate-limited; coinUsd required for non-
  // stable coins so a pool is never seeded at a wrong price.
  on('POST', /^\/account\/api\/liquidity\/fee$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (!loginIpRl.allow('liqfee:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 4 * 1024).catch(() => ({}));
    try { return json(res, 200, await liquidity.accrueFee(b.coin, b.feeUsd, b.coinUsd)); }
    catch (e) { return json(res, 400, { ok: false, error: String(e.message || 'fee failed') }); }
  });
  // SETTLE a swap on-chain: the user posts the txid of their deposit to the
  // treasury hot wallet; the relayer verifies it + pays out the output asset.
  // GATED by LIQUIDITY_MAINNET (returns 503 while the gate is off — no funds move).
  on('POST', /^\/account\/api\/liquidity\/settle$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (!liquidityMainnet(process.env)) return json(res, 503, { ok: false, error: 'on-chain settlement is off' });
    if (!liqSettleRl.allow('liqsettle:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 4 * 1024).catch(() => ({}));
    try {
      const rec = await settleSwap(String(b.id || ''), String(b.depositTxid || ''), {
        store,
        rpcFor: (chainId) => chainId === 'solana'
          ? solRpcSender(process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com')
          : rpcSenderFor(chainId),
        seedHex: process.env.LIQUIDITY_TREASURY_SEED || '',
        chainBase: cfg.chainApiBase,
        env: process.env,
        now,
        // A truly failed payout refunds the deposit; the accounting is reverted.
        onRefund: (r) => liquidity.revertSwap(r),
      });
      return json(res, 200, rec);
    } catch (e) { return json(res, 400, { ok: false, error: String(e.message || 'settle failed') }); }
  });

  // MoonPay transaction webhook: verify the HMAC signature with the webhook key, then record the
  // event. MoonPay calls this; no session. We only trust a verified payload.
  on('POST', /^\/account\/api\/moonpay\/webhook$/, async (req, res) => {
    const raw = await readBody(req, 256 * 1024).catch(() => '');
    const v = moonpay.verifyWebhook(raw, req.headers['moonpay-signature-v2'] || req.headers['moonpay-signature'] || '');
    if (!v.ok) return json(res, 400, { error: 'invalid signature', reason: v.reason });
    let evt = null; try { evt = JSON.parse(raw); } catch {}
    const key = (evt && evt.data && evt.data.id) || (now() + ':' + Math.random().toString(36).slice(2, 8));
    try { await store.put('moonpay_events', String(key), { at: now(), type: evt && evt.type, data: evt && evt.data }); } catch {}
    // SERVER-VERIFIED GRANT: a verified Commerce "checkout completed" event is the ONLY thing that
    // flips a paid entitlement — identical trust model to the PayPal webhook + IAP verify below.
    // The client never confirms its own purchase; it only polls /commerce action:'status' for UI.
    try { await applyCommerceGrant(evt); } catch (e) { /* never 500 a webhook on a grant hiccup */ }
    return json(res, 200, { ok: true });
  });

  // SERVER-AUTHORITATIVE on/off-ramp status. The client polls THIS for a buy/sell
  // transaction instead of trusting the redirect URL's transactionStatus (which
  // the user's browser controls). We return ONLY what a VERIFIED MoonPay webhook
  // recorded in `moonpay_events` (keyed by transaction id). No account needed —
  // the MoonPay transaction id is an unguessable UUID, so holding it is the
  // capability (on-ramp works signed-out). `known:false` => no webhook yet (still
  // pending). Covers buy (transaction_*) and sell (sell_transaction_*) alike.
  on('GET', /^\/account\/api\/moonpay\/transaction\/([^/]+)$/, async (req, res, url, m) => {
    const id = String(m[1] || '');
    const rec = id ? store.get('moonpay_events', id) : null;
    if (!rec) return json(res, 200, { id, known: false, status: 'pending' });
    const d = rec.data || {};
    const type = String(rec.type || '');
    return json(res, 200, {
      id,
      known: true,
      status: d.status || 'pending',            // pending | waitingPayment | completed | failed | …
      type: rec.type || null,
      kind: /sell/i.test(type) ? 'sell' : 'buy',
      failed: /fail/i.test(type) || /fail/i.test(String(d.status || '')),
      completed: String(d.status || '') === 'completed',
      cryptoAmount: d.quoteCurrencyAmount ?? d.cryptoAmount ?? null,
      fiatAmount: d.baseCurrencyAmount ?? d.fiatAmount ?? null,
      currency: d.currencyCode ?? d.baseCurrencyCode ?? null,
      walletAddress: d.walletAddress ?? null,
      cryptoTxHash: d.cryptoTransactionId ?? null,
      at: rec.at || null,
    });
  });

  // Apply a commerce grant from a VERIFIED webhook event. Copilot tiers flip the same user.sub the
  // PayPal/IAP paths write (setStoreSub); launch/raid/nft record a replay-guarded, server-verified
  // grant in `moonpay_grants` that the owning service (launchpad / raid / marketplace) claims — the
  // grant is written ONLY here, never by a client. Idempotent (a second delivery is a no-op).
  // SERVER-OWNED USD price for FIXED-price Commerce products. The client NEVER sets these —
  // they mirror the canonical PayPal/IAP subscription prices (copilot / copilot_pro) and the
  // launchpad promo launch fee. VARIABLE-price products (raid, nft) return null: the accounts
  // service cannot know their price, so the OWNING service re-validates grant.amountUsd at
  // claim time. This is the single server-side source of truth for the underpayment guard.
  const MOONPAY_FIXED_PRICE = {
    copilot: Number(cfg.moonpayPriceCopilot) || 0,
    copilot_pro: Number(cfg.moonpayPriceCopilotPro) || 0,
    launch_fee: Number(cfg.moonpayPriceLaunchFee) || 0,
  };
  function moonpayServerPrice(product) {
    const p = MOONPAY_FIXED_PRICE[product];
    return (p && p > 0) ? p : null; // null => variable-price product (owning service enforces)
  }
  const MOONPAY_PRICE_TOL = 0.01; // rounding tolerance (USD) for the paid >= price assertion

  async function applyCommerceGrant(evt) {
    if (!evt) return;
    const data = evt.data || {};
    const blob = (String(evt.type || '') + ' ' + String(data.status || '')).toLowerCase();
    if (!/complet|paid|succeed/.test(blob)) return; // only a finished checkout grants
    const checkoutId = data.id || data.checkoutId || null;
    const rec = checkoutId ? store.get('moonpay_commerce', String(checkoutId)) : null;
    const meta = (data.metadata && typeof data.metadata === 'object') ? data.metadata : {};
    const product = meta.product || (rec && rec.product) || null;
    const refId = meta.refId != null ? String(meta.refId) : (rec ? String(rec.refId || '') : '');
    const userId = meta.userId || (rec && rec.userId) || null;
    if (!product) return;
    if (rec && rec.granted) return; // already applied — idempotent
    // PAID amount, in USD: trust what the VERIFIED webhook reports was actually paid; fall
    // back to the recorded checkout amount. For FIXED products the recorded amount is itself
    // server-owned (set at create, client amount ignored), so it cannot be lowered by a client.
    const paidUsd = Number(data.amount) > 0 ? Number(data.amount) : Number((rec && rec.amountUsd) || 0);
    const serverPrice = moonpayServerPrice(product);
    // UNDERPAYMENT GUARD (fixed-price products): a verified-but-underpaid checkout records the
    // event but does NOT grant. The $1-for-Copilot-Pro attack lands here and is rejected.
    if (serverPrice != null && !(paidUsd + MOONPAY_PRICE_TOL >= serverPrice)) {
      if (rec && checkoutId) await store.update('moonpay_commerce', String(checkoutId), (x) => { if (x) { x.status = 'underpaid'; x.paidUsd = paidUsd; x.requiredUsd = serverPrice; } return x; });
      if (product === 'launch_fee') {
        // record for the owning service so it, too, sees the shortfall (never granted)
        await store.put('moonpay_grants', product + ':' + refId, { product, refId, userId, checkoutId, amountUsd: paidUsd, requiredUsd: serverPrice, status: 'underpaid', at: now() });
      }
      return;
    }
    if (product === 'copilot' || product === 'copilot_pro') {
      if (userId) await setStoreSub(userId, { tier: product, active: true, subId: 'mpc_' + (checkoutId || refId), provider: 'moonpay-commerce' });
    } else if (product === 'launch_fee' || product === 'raid' || product === 'nft') {
      // amountUsd = the server-verified PAID amount; requiredUsd = the server price (fixed) or
      // the checkout amount the user was asked to pay (variable). The owning service compares
      // amountUsd to ITS OWN server-side price before releasing goods.
      await store.put('moonpay_grants', product + ':' + refId, {
        product, refId, userId, checkoutId,
        amountUsd: paidUsd || (rec && rec.amountUsd) || null,
        requiredUsd: serverPrice != null ? serverPrice : ((rec && rec.requiredUsd) || (rec && rec.amountUsd) || null),
        status: 'granted', at: now(),
      });
    }
    if (rec && checkoutId) await store.update('moonpay_commerce', String(checkoutId), (x) => { if (x) { x.status = 'completed'; x.granted = true; x.grantedAt = now(); } return x; });
  }

  // MoonPay Commerce (crypto checkout) — AUTHED. Mirrors the /swap proxy but ALSO records a pending
  // checkout keyed by its MoonPay id; the webhook above is what later flips the grant. The client
  // only ever (a) creates a checkout + opens the hosted URL, or (b) polls its status for UI.
  // Body: { action:'create'|'status', product, refId, amountUsd, ccy, checkoutId }.
  on('POST', /^\/account\/api\/moonpay\/commerce$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024).catch(() => ({}));
    const PRODUCTS = ['copilot', 'copilot_pro', 'launch_fee', 'raid', 'nft'];
    try {
      if (b.action === 'status') {
        // The client helper passes the id as either checkoutId or refId — accept both.
        const checkoutId = String(b.checkoutId || b.refId || '');
        if (!checkoutId) return json(res, 400, { error: 'missing checkoutId' });
        const rec = store.get('moonpay_commerce', checkoutId);
        if (!rec || rec.userId !== u.id) return json(res, 404, { error: 'unknown checkout' });
        let remote = null;
        try { const r = await moonpay.commerceStatus(checkoutId); remote = (r.body && (r.body.status || r.body.state)) || null; } catch {}
        return json(res, 200, { status: rec.status, granted: !!rec.granted, product: rec.product, refId: rec.refId, remote });
      }
      const product = String(b.product || '');
      if (!PRODUCTS.includes(product)) return json(res, 400, { error: 'unknown product' });
      // SERVER OWNS the price for FIXED products (copilot / copilot_pro / launch_fee): the client
      // amountUsd is IGNORED and the server price is used — this closes the underpayment hole
      // (pay $1 for Copilot Pro). For VARIABLE products (raid, nft) the accounts service cannot
      // know the price, so the client amount is used ONLY as the checkout amount and the owning
      // service re-validates grant.amountUsd at claim time.
      const serverPrice = moonpayServerPrice(product);
      let amountUsd;
      if (serverPrice != null) {
        amountUsd = serverPrice;
      } else {
        amountUsd = Number(b.amountUsd || 0);
        if (!(amountUsd > 0)) return json(res, 400, { error: 'bad amount' });
      }
      const refId = b.refId != null ? String(b.refId) : '';
      const ccy = String(b.ccy || 'usd').toLowerCase();
      const r = await moonpay.commerceCheckout({ amountUsd, currency: ccy, metadata: { userId: u.id, product, refId } });
      const out = r.body || {};
      const checkoutId = out.id || out.checkoutId || null;
      const hostedUrl = out.hostedUrl || out.url || out.checkoutUrl || null;
      if (!checkoutId) return json(res, r.status || 502, { error: 'commerce checkout failed' });
      // requiredUsd records the amount the user was asked to pay (= server price for fixed
      // products) so the webhook grant and any owning service can re-assert it.
      await store.put('moonpay_commerce', String(checkoutId), { checkoutId: String(checkoutId), userId: u.id, product, refId, amountUsd, requiredUsd: amountUsd, ccy, status: 'pending', granted: false, at: now() });
      return json(res, 200, { checkoutId, hostedUrl });
    } catch (e) { return json(res, 400, { error: String(e.message || 'commerce failed') }); }
  }));

  // Read-only grant check for the OWNING services (launchpad / marketplace / raid). They call this
  // server-to-server to confirm a launch_fee / nft / raid purchase was settled by the VERIFIED
  // MoonPay webhook before releasing their own goods — the grant is written only by the webhook, so
  // this never lets a client self-authorize. Returns only { granted } (+ amount/at) for a product+
  // refId the caller already holds; CORS-open like /config, no secret exposed.
  on('GET', /^\/account\/api\/moonpay\/grant$/, (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const q = new URL(req.url, 'http://x').searchParams;
    const product = String(q.get('product') || '');
    const refId = String(q.get('refId') || '');
    if (!['launch_fee', 'raid', 'nft', 'copilot', 'copilot_pro'].includes(product) || !refId) return json(res, 400, { error: 'bad product/refId' });
    const g = store.get('moonpay_grants', product + ':' + refId);
    // granted + the server-verified PAID amount (amountUsd) + what was required (requiredUsd) so
    // the OWNING service can re-assert amountUsd >= its own price before releasing goods.
    return json(res, 200, { granted: !!(g && g.status === 'granted'), amountUsd: (g && g.amountUsd) || null, requiredUsd: (g && g.requiredUsd) || null, status: (g && g.status) || null, at: (g && g.at) || null });
  });
  // Authenticated proxy for the Trade (swap) API — gated to logged-in users so our trade key
  // can't be abused anonymously. Body: { method, path, query, body }.
  on('POST', /^\/account\/api\/moonpay\/swap$/, authed(async (req, res) => {
    const b = await readJson(req, 16 * 1024).catch(() => ({}));
    const method = b.method === 'POST' ? 'POST' : 'GET';
    if (typeof b.path !== 'string' || !b.path.startsWith('/')) return json(res, 400, { error: 'bad path' });
    try { const r = await moonpay.apiRequest(method, b.path, { query: b.query || {}, body: b.body || null }); return json(res, r.status, r.body); }
    catch (e) { return json(res, 400, { error: String(e.message || 'swap failed') }); }
  }));

  // Copy-trade = clone another trader's bot CONFIG into your own account (compliant: your keys +
  // your gate still apply; the clone lands as a fresh paper bot). Body: { fromBotId }.
  on('POST', /^\/account\/api\/bots\/copy$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 4 * 1024).catch(() => ({}));
    const src = b.fromBotId ? store.get('bots', b.fromBotId) : null;
    const spec = src ? { type: src.type, pair: src.pair, params: src.params } : { type: b.type, pair: b.pair, params: b.params };
    if (!BOT_TYPES.includes(spec.type)) return json(res, 400, { error: 'Unknown strategy.' });
    if (store.all('bots').filter((x) => x.uid === u.id).length >= 25) return json(res, 400, { error: 'Bot limit reached (25).' });
    const id = randomToken(8);
    const bot = newBot({ id, uid: u.id, type: spec.type, pair: spec.pair, params: spec.params, now: now() });
    if (src) bot.copiedFrom = src.uid;
    await store.put('bots', id, bot);
    return json(res, 200, { ok: true, bot: botView(bot, priceFor()) });
  }));

  // Read every social profile once (uid -> {handle,karma}) for the leaderboard join.
  function allProfiles() {
    try { return JSON.parse(fs.readFileSync(path.join(cfg.socialDataDir, 'profiles.json'), 'utf8')); } catch { return {}; }
  }
  // PUBLIC top-trader leaderboard — ranks accounts by their best PAPER bot P&L (play money, so a
  // public board is safe and can't be faked into real-return claims). Only traders with a public
  // @handle appear (public by default once you pick a handle). Honest: these are paper results.
  on('GET', /^\/account\/api\/leaderboard$/, (req, res) => {
    const profiles = allProfiles();
    const byUid = new Map();
    for (const bot of store.all('bots')) {
      const prof = profiles[bot.uid]; if (!prof || !prof.handle) continue; // public identity only
      const v = botView(bot, priceFor());
      let e = byUid.get(bot.uid);
      if (!e) { e = { uid: bot.uid, handle: prof.handle, karma: prof.karma || 0, bots: [] }; byUid.set(bot.uid, e); }
      e.bots.push({ id: bot.id, type: bot.type, pair: bot.pair, pnlPct: v.pnlPct, trades: v.trades, status: bot.status });
    }
    const traders = [...byUid.values()].map((t) => {
      const best = t.bots.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a), t.bots[0]);
      const avg = t.bots.reduce((s, b) => s + b.pnlPct, 0) / t.bots.length;
      const user = store.all('users').find((x) => x.id === t.uid);
      const tier = user ? entitlement(user.sub).entitledTier : 'free';
      return { handle: t.handle, karma: t.karma, tier, botCount: t.bots.length,
        bestPnlPct: Math.round(best.pnlPct * 100) / 100, avgPnlPct: Math.round(avg * 100) / 100,
        bestStrategy: best.type, bots: t.bots.sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5) };
    }).sort((a, b) => b.bestPnlPct - a.bestPnlPct).slice(0, 50);
    return json(res, 200, { traders, metric: 'paper P&L (play money)', generatedAt: now() });
  });

  // --- Curated trusted-dApp directory (#129) ------------------------------------------------
  // PUBLIC, CORS-open, no auth — the in-app browser homepage fetches + caches this on every
  // wallet (extension/app/desktop), exactly like /moonpay/config and /leaderboard above. Only
  // the vetted set in dapps.js is ever featured, so it is a safe default pairing with the
  // connect-time security screening (#127). The order is the CURATED base rank until user opens
  // accrue, then becomes user-popularity-driven: we overlay live per-dapp open counts (kept in
  // the pseudonymous 'dapp_opens' collection — a per-id integer, no uid/PII) on the base and
  // sort by the combined score, with the curated array order as a stable tiebreak.
  on('GET', /^\/account\/api\/dapps$/, (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const counts = {};
    for (const [id, v] of store.entries('dapp_opens')) counts[id] = (v && Number(v.count)) || 0;
    const ranked = CURATED_DAPPS
      .map((d, i) => ({ dapp: d, order: i, opens: counts[d.id] || 0 }))
      // Effective score = curated base rank + live opens. A dApp with real user traffic can rise
      // above a higher-seeded one once it accrues enough opens; ties keep the curated order.
      .sort((a, b) => (b.dapp.popularity + b.opens) - (a.dapp.popularity + a.opens) || a.order - b.order)
      .map(({ dapp, opens }) => ({
        id: dapp.id, name: dapp.name, url: dapp.url, chains: dapp.chains, icon: dapp.icon,
        popularity: dapp.popularity + opens,
      }));
    return json(res, 200, ranked);
  });
  // Increment a dApp's pseudonymous open counter. CORS-open + per-IP rate-limited like
  // /moonpay/sign — no auth, no body beyond { id }. The id MUST be in the curated seed, so the
  // counter can never be seeded with arbitrary keys. Fire-and-forget from the client.
  on('POST', /^\/account\/api\/dapps\/open$/, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (!loginIpRl.allow('dappopen:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 4 * 1024).catch(() => ({}));
    const id = String(b.id || '');
    if (!CURATED_DAPP_IDS.has(id)) return json(res, 400, { error: 'unknown dapp' });
    await store.update('dapp_opens', id, (x) => ({ count: ((x && Number(x.count)) || 0) + 1 }));
    return json(res, 200, { ok: true });
  });

  // PUBLIC trader profile by @handle — their public bots + paper P&L, for the /u/:handle page and
  // the copy-trade flow (bot ids feed POST /account/api/bots/copy).
  on('GET', /^\/account\/api\/trader\/([a-z0-9_]{3,20})$/, (req, res, url, m) => {
    const handle = m[1];
    const profiles = allProfiles();
    const uid = Object.keys(profiles).find((k) => (profiles[k].handle || '').toLowerCase() === handle.toLowerCase());
    if (!uid) return json(res, 404, { error: 'No such trader.' });
    const prof = profiles[uid];
    const bots = store.all('bots').filter((b) => b.uid === uid).map((b) => {
      const v = botView(b, priceFor());
      return { id: b.id, type: b.type, pair: b.pair, pnlPct: v.pnlPct, trades: v.trades, status: b.status, params: b.params };
    }).sort((a, b) => b.pnlPct - a.pnlPct);
    const user = store.all('users').find((x) => x.id === uid);
    return json(res, 200, { handle: prof.handle, karma: prof.karma || 0, tier: user ? entitlement(user.sub).entitledTier : 'free', bots });
  });

  // Background stepper: fetch the BLOCK price + advance every running paper bot. Best-effort —
  // if no price is available, bots simply hold. Started only in the live run (not in tests).
  async function stepAllBots() {
    try {
      const mk = await chain.markets();
      const block = mk.find((t) => /^block$/i.test(t.symbol));
      const price = block && block.price ? Number(block.price) : lastKnownPrice;
      if (!price) return;
      lastKnownPrice = price;
      for (const [id, bot] of store.entries('bots')) {
        if (bot.status !== 'running') continue;
        botStep(bot, price);
        await store.put('bots', id, bot);
      }
    } catch { /* best-effort */ }
  }

  // Sign out of every device (revoke all sessions for this user).
  on('POST', /^\/account\/api\/logout-all$/, authed(async (req, res, { u }) => {
    await sessions.destroyAllForUser(u.id);
    clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure, domain: cfg.cookieDomain });
    return json(res, 200, { ok: true });
  }));

  // List this user's active sessions (devices). The `sid` returned is the stored HASH of the
  // cookie — safe to expose (it can't be turned back into a usable cookie) and used only to
  // revoke that specific session below. The current device is flagged.
  // Active DEVICES, not raw sessions — multiple logins from the same browser (same UA + IP)
  // collapse into one device entry (with a session count), so a device isn't shown repeatedly.
  on('GET', /^\/account\/api\/sessions$/, async (req, res) => {
    const sess = await currentSession(req);
    if (!sess) return json(res, 401, { error: 'auth' });
    const hereKey = sha256(sess.id);
    const groups = new Map();
    for (const [key, r] of store.entries('sessions')) {
      if (r.uid !== sess.uid) continue;
      const gk = (r.ua || '') + '|' + (r.ip || '');
      let g = groups.get(gk);
      if (!g) { g = { ua: r.ua || '', ip: r.ip || '', sids: [], count: 0, lastSeen: 0, createdAt: r.createdAt || 0, current: false }; groups.set(gk, g); }
      g.sids.push(key); g.count += 1;
      g.lastSeen = Math.max(g.lastSeen, r.lastSeen || 0);
      g.createdAt = Math.min(g.createdAt || r.createdAt || 0, r.createdAt || g.createdAt);
      if (key === hereKey) g.current = true;
    }
    const devices = [...groups.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    return json(res, 200, { devices });
  });

  // Revoke a device (all its sessions). Owner-scoped; signing out the current device clears the cookie.
  on('POST', /^\/account\/api\/sessions\/revoke$/, authed(async (req, res, { sess, u }) => {
    const b = await readJson(req, 8 * 1024);
    const sids = Array.isArray(b.sids) ? b.sids.map(String) : (b.sid ? [String(b.sid)] : []);
    if (!sids.length) return json(res, 400, { error: 'No device specified.' });
    const hereKey = sha256(sess.id);
    let revokedSelf = false, any = false;
    for (const sid of sids) {
      const t = store.get('sessions', sid);
      if (t && t.uid === u.id) { await store.del('sessions', sid); any = true; if (sid === hereKey) revokedSelf = true; }
    }
    if (!any) return json(res, 404, { error: 'No such device.' });
    if (revokedSelf) clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure, domain: cfg.cookieDomain });
    return json(res, 200, { ok: true, revokedSelf });
  }));

  // Set / change the unique username (the public @handle).
  on('POST', /^\/account\/api\/username$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 8 * 1024);
    const name = String(b.username || '').toLowerCase().trim();
    if (!USERNAME_RE.test(name)) return json(res, 400, { error: 'Username must be 3–20 chars: letters, numbers, underscore.' });
    if (name === (u.username || '')) return json(res, 200, { ok: true, username: name });
    const taken = usernameIndex.get(name);
    if (taken && taken !== u.id) return json(res, 409, { error: 'That username is taken.' });
    const old = u.username;
    await store.update('users', u.id, (x) => { if (x) x.username = name; return x; });
    if (old) await usernameIndex.del(old);
    await usernameIndex.set(name, u.id);
    return json(res, 200, { ok: true, username: name });
  }));

  // Change email: verify the password, then email a confirmation link to the NEW address. The
  // swap only happens when that link is clicked (so a typo/attacker can't move your login).
  on('POST', /^\/account\/api\/change-email$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024);
    const newEmail = String(b.newEmail || '').toLowerCase().trim();
    if (!EMAIL_RE.test(newEmail)) return json(res, 400, { error: 'Enter a valid email address.' });
    if (!verifyPassword(String(b.password || ''), u.pwHash)) return json(res, 401, { error: 'Password is incorrect.' });
    if (newEmail === u.email) return json(res, 400, { error: 'That is already your email.' });
    // Generic response; only send if the address is free (no enumeration of existing accounts).
    if (!userByEmail(newEmail)) {
      const token = randomToken(32);
      await store.put('tokens', sha256(token), { type: 'email-change', uid: u.id, newEmail, exp: now() + cfg.tokenTtlMs });
      const url = `${cfg.publicOrigin}/account/verify-email?token=${token}`;
      if (mailRl.allow('mail:' + newEmail))
        await mailer.send({ to: newEmail, subject: 'Confirm your new Blockle email',
          text: `Confirm this address for your Blockle account:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't request this, you can ignore it.` });
    }
    return json(res, 200, { ok: true, message: 'Check the new address for a confirmation link.' });
  }));

  on('GET', /^\/account\/api\/verify-email$/, async (req, res, url) => {
    const token = url.searchParams.get('token') || '';
    const rec = store.get('tokens', sha256(token));
    if (!rec || rec.type !== 'email-change' || rec.exp < now()) return json(res, 400, { error: 'Invalid or expired link.' });
    if (userByEmail(rec.newEmail)) { await store.del('tokens', sha256(token)); return json(res, 409, { error: 'That email is now in use.' }); }
    const u = store.get('users', rec.uid);
    if (!u) { await store.del('tokens', sha256(token)); return json(res, 400, { error: 'Account not found.' }); }
    await store.del('tokens', sha256(token));
    const old = u.email;
    await store.update('users', rec.uid, (x) => { if (x) x.email = rec.newEmail; return x; });
    await emailIndex.del(old);
    await emailIndex.set(rec.newEmail, rec.uid);
    return json(res, 200, { ok: true });
  });

  // Change password: verify the current one, set the new one, and re-issue THIS device's session
  // (every other session is revoked). Keeps the user signed in here without a round-trip to login.
  on('POST', /^\/account\/api\/change-password$/, authed(async (req, res, { sess, u }) => {
    const b = await readJson(req, 16 * 1024);
    if (!verifyPassword(String(b.current || ''), u.pwHash)) return json(res, 401, { error: 'Current password is incorrect.' });
    const next = String(b.next || '');
    if (next.length < 10) return json(res, 400, { error: 'New password must be at least 10 characters.' });
    await store.update('users', u.id, (x) => { if (x) x.pwHash = hashPassword(next); return x; });
    await sessions.destroyAllForUser(u.id); // revoke everything, incl. this one…
    const { id, csrf } = await sessions.create(u.id, { ip: clientIp(req), ua: req.headers['user-agent'] }); // …then re-issue here
    // migrating to a Domain-scoped cookie? drop any stale host-only blk_sess first so the
    // browser doesn't keep sending two values for the same name.
    if (cfg.cookieDomain) clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure });
    setCookie(res, SESSION_COOKIE, id, { maxAgeMs: cfg.sessionAbsoluteMs, secure: cfg.cookieSecure, domain: cfg.cookieDomain });
    const resp = { ok: true, csrf };
    if (req.headers['x-blockle-client']) resp.token = id;
    return json(res, 200, resp);
  }));

  // Delete the account (danger zone): requires the password, and a 2FA code if 2FA is on. Wipes
  // the user, email index, all sessions, the encrypted backup blob, and any pending tokens. The
  // social profile lives in a separate service and is not touched here.
  on('POST', /^\/account\/api\/delete-account$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024);
    if (!verifyPassword(String(b.password || ''), u.pwHash)) return json(res, 401, { error: 'Password is incorrect.' });
    if (u.totpEnabled && !totpVerify(u.totpSecret, String(b.totp || ''), now())) return json(res, 401, { error: 'Enter your 2FA code to delete the account.' });
    await sessions.destroyAllForUser(u.id);
    await store.del('backups', u.id);
    await store.del('users', u.id);
    await emailIndex.del(u.email);
    if (u.username) await usernameIndex.del(u.username);
    for (const [k, rec] of store.entries('tokens')) if (rec.uid === u.id) await store.del('tokens', k);
    clearCookie(res, SESSION_COOKIE, { secure: cfg.cookieSecure, domain: cfg.cookieDomain });
    return json(res, 200, { ok: true });
  }));

  on('POST', /^\/account\/api\/request-reset$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    if (!loginIpRl.allow('reset:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024);
    const email = String(b.email || '').toLowerCase().trim();
    const u = userByEmail(email);
    if (u) {
      const token = randomToken(32);
      await store.put('tokens', sha256(token), { type: 'reset', uid: u.id, exp: now() + cfg.tokenTtlMs });
      const url = `${cfg.publicOrigin}/account/reset?token=${token}`;
      if (mailRl.allow('mail:' + email))
        await mailer.send({ to: email, subject: 'Reset your Blockle password',
          text: `Reset your password:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't request this, ignore it — your password is unchanged.` });
    }
    return json(res, 200, { ok: true, message: 'If that account exists, a reset link is on its way.' });
  });

  on('POST', /^\/account\/api\/reset$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    const b = await readJson(req, 64 * 1024);
    const token = String(b.token || '');
    const password = String(b.password || '');
    const rec = store.get('tokens', sha256(token));
    if (!rec || rec.type !== 'reset' || rec.exp < now()) return json(res, 400, { error: 'Invalid or expired link.' });
    if (password.length < 10) return json(res, 400, { error: 'Password must be at least 10 characters.' });
    await store.del('tokens', sha256(token));
    await store.update('users', rec.uid, (u) => { if (u) u.pwHash = hashPassword(password); return u; });
    await sessions.destroyAllForUser(rec.uid); // every existing session is revoked
    return json(res, 200, { ok: true });
  });

  // --- 2FA ----------------------------------------------------------------------------------
  on('POST', /^\/account\/api\/2fa\/setup$/, authed(async (req, res, { sess, u }) => {
    const secret = totpSecret();
    await store.update('users', u.id, (x) => { if (x) x.pendingTotp = secret; return x; });
    return json(res, 200, { secret, uri: totpUri(secret, u.email) });
  }));

  on('POST', /^\/account\/api\/2fa\/enable$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024);
    const secret = u.pendingTotp;
    if (!secret || !totpVerify(secret, String(b.totp || ''), now())) return json(res, 400, { error: 'Code did not match. Try again.' });
    const recovery = genRecoveryCodes();
    await store.update('users', u.id, (x) => {
      if (!x) return x;
      x.totpSecret = secret; x.totpEnabled = true; x.pendingTotp = null;
      x.recoveryHashes = recovery.map((c) => sha256(c)); return x;
    });
    return json(res, 200, { ok: true, recovery });
  }));

  // Regenerate recovery codes (requires a current 2FA code). Invalidates the old set.
  on('POST', /^\/account\/api\/2fa\/recovery$/, authed(async (req, res, { u }) => {
    if (!u.totpEnabled) return json(res, 400, { error: 'Turn on two-factor first.' });
    const b = await readJson(req, 16 * 1024);
    if (!totpVerify(u.totpSecret, String(b.totp || ''), now())) return json(res, 401, { error: 'Enter a valid 2FA code.' });
    const recovery = genRecoveryCodes();
    await store.update('users', u.id, (x) => { if (x) x.recoveryHashes = recovery.map((c) => sha256(c)); return x; });
    return json(res, 200, { ok: true, recovery });
  }));

  on('POST', /^\/account\/api\/2fa\/disable$/, authed(async (req, res, { u }) => {
    const b = await readJson(req, 16 * 1024);
    if (!verifyPassword(String(b.password || ''), u.pwHash)) return json(res, 401, { error: 'Password is incorrect.' });
    await store.update('users', u.id, (x) => { if (x) { x.totpEnabled = false; x.totpSecret = null; x.recoveryHashes = []; } return x; });
    return json(res, 200, { ok: true });
  }));

  // --- zero-knowledge wallet backup ---------------------------------------------------------
  // The body is opaque ciphertext the client produced; the server stores and returns it and
  // CANNOT decrypt it. No passphrase/key ever reaches here.
  // Backup ops are step-up protected: 2FA must be enrolled AND a fresh code supplied. Fails
  // closed — a session alone can never read/overwrite/delete the (opaque) backup blob.
  function require2fa(req, u) {
    if (!u.totpEnabled) return false;
    return totpVerify(u.totpSecret, String(req.headers['x-totp'] || ''), now());
  }

  on('PUT', /^\/account\/api\/backup$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled
      ? { error: '2fa', message: 'Enter your 2FA code.' }
      : { error: '2fa_setup_required', message: 'Enable two-factor authentication to use encrypted backup.' });
    const b = await readJson(req, cfg.backupMaxBytes);
    const ct = String(b.ciphertext || '');
    if (!ct || !/^[A-Za-z0-9+/=_-]+$/.test(ct) || ct.length > cfg.backupMaxBytes)
      return json(res, 400, { error: 'Backup payload invalid.' });
    const meta = b.meta && typeof b.meta === 'object' ? sanitizeMeta(b.meta) : {};
    await store.update('backups', u.id, (rec) => {
      rec = rec || { versions: [] };
      rec.versions.unshift({ ciphertext: ct, meta, createdAt: now() });
      rec.versions = rec.versions.slice(0, 10); // keep last 10
      return rec;
    });
    return json(res, 200, { ok: true });
  }));

  on('GET', /^\/account\/api\/backup$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled
      ? { error: '2fa', message: 'Enter your 2FA code.' }
      : { error: '2fa_setup_required', message: 'Enable two-factor authentication to use encrypted backup.' });
    const rec = store.get('backups', u.id);
    if (!rec || !rec.versions.length) return json(res, 404, { error: 'No backup stored.' });
    return json(res, 200, { latest: rec.versions[0], versions: rec.versions.map((v, i) => ({ i, meta: v.meta, createdAt: v.createdAt })) });
  }));

  on('DELETE', /^\/account\/api\/backup$/, authed(async (req, res, { u }) => {
    if (!require2fa(req, u)) return json(res, 403, u.totpEnabled
      ? { error: '2fa', message: 'Enter your 2FA code.' }
      : { error: '2fa_setup_required', message: 'Enable two-factor authentication to use encrypted backup.' });
    await store.del('backups', u.id);
    return json(res, 200, { ok: true });
  }));

  // --- paid tier ----------------------------------------------------------------------------
  // The purchasable tiers: Blockle Copilot and Copilot Pro only. A tier is offered ONLY when
  // its PayPal plan id is configured, so the catalog is empty until the live plans exist —
  // nothing to buy, no broken checkout. Order = how they're shown (entry tier first).
  const planCatalog = () => [
    { tier: 'copilot', name: 'Blockle Alien', price: cfg.copilotPrice, ccy: cfg.planCurrency, planId: cfg.copilotPlanId },
    { tier: 'copilot_pro', name: 'Blockle Alien Pro', price: cfg.copilotProPrice, ccy: cfg.planCurrency, planId: cfg.copilotProPlanId },
  ].filter((p) => p.planId);
  const planByTier = (tier) => planCatalog().find((p) => p.tier === tier) || null;
  const planByPlanId = (id) => planCatalog().find((p) => p.planId === id) || null;

  on('GET', /^\/account\/api\/plans$/, (req, res) =>
    json(res, 200, { plans: planCatalog().map(({ tier, name, price, ccy }) => ({ tier, name, price, ccy })), billing: !paypal.disabled }));

  on('POST', /^\/account\/api\/subscribe$/, authed(async (req, res, { u }) => {
    if (paypal.disabled) return json(res, 503, { error: 'Billing is not configured yet.' });
    const b = await readJson(req, 4 * 1024).catch(() => ({}));
    // Pick the requested tier's plan; fall back to the catalog's entry tier (or the legacy Pro plan).
    const chosen = (b && b.tier && planByTier(b.tier)) || planCatalog()[0] || null;
    const planId = chosen ? chosen.planId : cfg.paypalPlanId;
    if (!planId) return json(res, 503, { error: 'That plan is not available yet.' });
    try {
      const sub = await paypal.createSubscription(u.id,
        `${cfg.publicOrigin}/account?sub=ok`, `${cfg.publicOrigin}/account?sub=cancel`, planId);
      return json(res, 200, { approveUrl: sub.approveUrl, id: sub.id, tier: chosen ? chosen.tier : null });
    } catch { return json(res, 502, { error: 'Could not start checkout. Please try again.' }); }
  }));

  // Entitlement changes ONLY here, and only after the webhook signature verifies.
  on('POST', /^\/account\/api\/paypal\/webhook$/, async (req, res) => {
    const raw = (await readBody(req, 512 * 1024)).toString('utf8');
    let verified = false;
    try { verified = await paypal.verifyWebhook(req.headers, raw); } catch { verified = false; }
    if (!verified) return json(res, 400, { error: 'unverified' });
    let event; try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad' }); }
    // Atomic idempotency: record the event id and detect a duplicate in one write.
    let dup = false;
    if (event.id) {
      await store.update('webhookEvents', event.id, (existing) => {
        if (existing) { dup = true; return undefined; }
        return { at: now(), type: event.event_type };
      });
    }
    if (dup) return json(res, 200, { ok: true, dup: true });
    const ent = entitlementFromEvent(event);
    if (ent && ent.userId) {
      const plan = ent.planId ? planByPlanId(ent.planId) : null;
      await store.update('users', ent.userId, (u) => {
        if (!u) return u;
        u.sub = {
          active: ent.active,
          subId: ent.subId,
          plan: plan ? plan.name : cfg.planName,
          tier: plan ? plan.tier : (u.sub && u.sub.tier) || 'pro',
          planId: ent.planId || (u.sub && u.sub.planId) || null,
        };
        return u;
      });
    }
    return json(res, 200, { ok: true });
  });

  // --- free trial ---------------------------------------------------------------------------
  // Start the one-time 7-day Copilot trial (no payment method). Idempotent-ish: returns the
  // live trial if one is already running; refuses a second trial once used, and is a no-op for
  // a paid subscriber (they're already entitled). This is what the wallet calls the first time a
  // user tries to arm a LIVE bot without entitlement.
  on('POST', /^\/account\/api\/trial\/start$/, authed(async (req, res, { u }) => {
    if (cfg.trialDays <= 0) return json(res, 403, { error: 'Trials are not available.' });
    const cur = u.sub || {};
    if (cur.active && cur.tier && cur.tier !== 'free')
      return json(res, 200, { sub: subView(cur), already: 'subscribed' });
    if (cur.trialStartedAt)
      return json(res, 409, { error: 'Your free trial has already been used.', sub: subView(cur) });
    const trialEnd = now() + cfg.trialDays * 24 * 60 * 60 * 1000;
    let saved = null;
    await store.update('users', u.id, (x) => {
      if (!x) return x;
      x.sub = { ...(x.sub || {}), active: !!(x.sub && x.sub.active), tier: (x.sub && x.sub.tier) || 'free',
        trialTier: cfg.trialTier, trialStartedAt: now(), trialEnd };
      saved = x.sub; return x;
    });
    return json(res, 200, { sub: subView(saved), trialDays: cfg.trialDays });
  }));

  // --- in-app purchase (Apple StoreKit / Google Play) ---------------------------------------
  // A verified store purchase updates the SAME user.sub the PayPal webhook writes, so the whole
  // app reads one entitlement regardless of where the user paid. Writes go through here only
  // after cryptographic verification (Apple JWS) or an authenticated Play API lookup (Google).
  // Store webhooks (Apple/Google) don't reliably carry our user id, so renewals/revocations are
  // matched back to the user by the subId recorded at verify time (originalTransactionId / Play
  // purchaseToken). Small-scale linear scan over the flat user store.
  const findUserBySubId = (subId) => subId ? store.all('users').find((u) => u.sub && u.sub.subId === subId) || null : null;
  const setStoreSub = (userId, { tier, active, subId, provider, expiresMs, productId }) =>
    store.update('users', userId, (u) => {
      if (!u) return u;
      u.sub = {
        ...(u.sub || {}),
        active: !!active, tier: active ? tier : 'free', subId: subId || (u.sub && u.sub.subId) || null,
        plan: tier === 'copilot_pro' ? 'Blockle Alien Pro' : tier === 'copilot' ? 'Blockle Alien' : (u.sub && u.sub.plan) || null,
        provider: provider || 'store', productId: productId || (u.sub && u.sub.productId) || null,
        expiresAt: expiresMs || null,
      };
      // A real paid subscription supersedes any leftover trial window.
      if (active) u.sub.trialEnd = u.sub.trialEnd && u.sub.trialEnd > now() ? u.sub.trialEnd : u.sub.trialEnd;
      return u;
    });

  on('POST', /^\/account\/api\/iap\/apple\/verify$/, authed(async (req, res, { u }) => {
    if (appleStore.disabled) return json(res, 503, { error: 'Apple purchases are not configured.' });
    const b = await readJson(req, 64 * 1024).catch(() => ({}));
    const receipt = b && (b.receiptData || b.signedTransactionInfo || b.jws || b.transaction);
    if (!receipt) return json(res, 400, { error: 'Missing receipt.' });
    let txn; try { txn = await appleStore.verifyTransaction(receipt); } catch { return json(res, 400, { error: 'Could not verify that purchase.' }); }
    const tier = productTier(cfg, txn.productId);
    if (!tier) return json(res, 400, { error: 'Unknown product.' });
    await setStoreSub(u.id, { tier, active: txn.active, subId: txn.originalTransactionId, provider: 'apple', expiresMs: txn.expiresMs, productId: txn.productId });
    return json(res, 200, { sub: subView(store.get('users', u.id).sub) });
  }));

  on('POST', /^\/account\/api\/iap\/google\/verify$/, authed(async (req, res, { u }) => {
    if (googleStore.disabled) return json(res, 503, { error: 'Google purchases are not configured.' });
    const b = await readJson(req, 16 * 1024).catch(() => ({}));
    if (!b || !b.purchaseToken || !b.productId) return json(res, 400, { error: 'Missing purchase token or product.' });
    let r; try { r = await googleStore.verifyPurchase(b.productId, b.purchaseToken); } catch { return json(res, 400, { error: 'Could not verify that purchase.' }); }
    const tier = productTier(cfg, r.productId || b.productId);
    if (!tier) return json(res, 400, { error: 'Unknown product.' });
    await setStoreSub(u.id, { tier, active: r.active, subId: b.purchaseToken, provider: 'google', expiresMs: r.expiresMs, productId: r.productId || b.productId });
    return json(res, 200, { sub: subView(store.get('users', u.id).sub) });
  }));

  // Apple App Store Server Notifications V2 — a signed JWS; the custom_id/appAccountToken isn't
  // always present, so we key renewals/revocations off the originalTransactionId recorded at
  // verify time. notificationType REFUND/REVOKE/EXPIRED -> deactivate.
  on('POST', /^\/account\/api\/iap\/apple\/webhook$/, async (req, res) => {
    const raw = (await readBody(req, 512 * 1024)).toString('utf8');
    let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad' }); }
    let ent; try { ent = await appleStore.entitlementFromNotification(body.signedPayload); } catch { ent = null; }
    if (!ent) return json(res, 200, { ok: true, ignored: true });
    const tier = productTier(cfg, ent.productId);
    const target = findUserBySubId(ent.originalTransactionId);
    if (target && tier) {
      const active = ent.active && !/REFUND|REVOKE|EXPIRED|GRACE_PERIOD_EXPIRED/i.test(ent.notificationType || '');
      await setStoreSub(target.id, { tier, active, subId: ent.originalTransactionId, provider: 'apple', expiresMs: ent.expiresMs, productId: ent.productId });
    }
    return json(res, 200, { ok: true });
  });

  // Google Real-time Developer Notifications (Pub/Sub push). Guard the public push URL with a
  // shared ?token= (Google lets you append a query string to the push endpoint). Re-verify via
  // the API inside entitlementFromRtdn — never trust the push body alone.
  on('POST', /^\/account\/api\/iap\/google\/webhook$/, async (req, res, url) => {
    if (cfg.googleRtdnToken && (url.searchParams.get('token') || '') !== cfg.googleRtdnToken)
      return json(res, 403, { error: 'forbidden' });
    const raw = (await readBody(req, 512 * 1024)).toString('utf8');
    let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad' }); }
    let ent; try { ent = await googleStore.entitlementFromRtdn(body); } catch { ent = null; }
    if (ent) {
      const tier = productTier(cfg, ent.productId);
      const target = findUserBySubId(ent.purchaseToken);
      if (target && tier) await setStoreSub(target.id, { tier, active: ent.active, subId: ent.purchaseToken, provider: 'google', expiresMs: ent.expiresMs, productId: ent.productId });
    }
    return json(res, 200, { ok: true });
  });

  // --- support tickets ----------------------------------------------------------------------
  on('POST', /^\/account\/api\/tickets$/, async (req, res) => {
    if (!sameOrigin(req, cfg)) return json(res, 403, { error: 'origin' });
    if (!loginIpRl.allow('ticket:' + clientIp(req))) return json(res, 429, { error: 'rate' });
    const b = await readJson(req, 64 * 1024);
    const sess = await currentSession(req);
    const email = sess ? store.get('users', sess.uid)?.email : String(b.email || '').toLowerCase().trim();
    const subject = String(b.subject || '').slice(0, 200);
    const body = String(b.body || '').slice(0, 8000);
    if (!EMAIL_RE.test(email || '') || !subject || !body) return json(res, 400, { error: 'Add a valid email, subject, and message.' });
    const id = randomToken(8);
    await store.put('tickets', id, {
      id, email, subject, status: 'open', createdAt: now(),
      messages: [{ from: 'user', body, at: now() }],
    });
    // notify support mailbox
    try { await mailer.send({ to: 'support@blockle.org', subject: `[ticket ${id}] ${subject}`, text: `From: ${email}\n\n${body}` }); } catch {}
    return json(res, 200, { ok: true, id });
  });

  // --- admin (role-gated) -------------------------------------------------------------------
  on('GET', /^\/account\/api\/admin\/stats$/, adminOnly((req, res) => {
    const users = store.all('users');
    const tickets = store.all('tickets');
    return json(res, 200, {
      users: users.length,
      verified: users.filter((u) => u.verified).length,
      subscribers: users.filter((u) => u.sub?.active).length,
      with2fa: users.filter((u) => u.totpEnabled).length,
      backups: store.all('backups').length,
      tickets: { open: tickets.filter((t) => t.status === 'open').length, total: tickets.length },
    });
  }));

  on('GET', /^\/account\/api\/admin\/traffic$/, adminOnly((req, res) => {
    try { return json(res, 200, trafficReport()); } catch (e) { return json(res, 500, { error: String(e && e.message) }); }
  }));

  on('GET', /^\/account\/api\/admin\/tickets$/, adminOnly((req, res) => {
    return json(res, 200, { tickets: store.all('tickets').sort((a, b) => b.createdAt - a.createdAt) });
  }));

  on('POST', /^\/account\/api\/admin\/ticket-reply$/, adminOnly(async (req, res) => {
    const b = await readJson(req, 64 * 1024);
    const t = store.get('tickets', String(b.id || ''));
    if (!t) return json(res, 404, { error: 'no ticket' });
    const reply = String(b.body || '').slice(0, 8000);
    if (!reply) return json(res, 400, { error: 'empty' });
    t.messages.push({ from: 'support', body: reply, at: now() });
    t.status = b.close ? 'closed' : 'open';
    await store.put('tickets', t.id, t);
    try { await mailer.send({ to: t.email, subject: `Re: [${t.id}] ${t.subject}`, text: reply }); } catch {}
    return json(res, 200, { ok: true });
  }));

  // --- middleware wrappers ------------------------------------------------------------------
  function authed(fn) {
    return async (req, res, url, m) => {
      const sess = await currentSession(req);
      if (!sess) return json(res, 401, { error: 'auth' });
      // Bearer-token (native wallet) requests aren't ambient, so CSRF doesn't apply to them;
      // cookie-based (browser) mutations still require the CSRF token + same-origin.
      if (req.method !== 'GET' && !sess.viaBearer && !requireCsrf(req, sess)) return json(res, 403, { error: 'csrf' });
      const u = store.get('users', sess.uid);
      if (!u) return json(res, 401, { error: 'auth' });
      return fn(req, res, { sess, u, url, m });
    };
  }
  // Hidden surface: ANY non-admin (including unauthenticated) gets an indistinguishable 404 —
  // never a 401, so the existence of admin routes can't be probed.
  function adminOnly(fn) {
    return async (req, res) => {
      const sess = await currentSession(req);
      const u = sess ? store.get('users', sess.uid) : null;
      if (!u || u.role !== 'admin') return json(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && !requireCsrf(req, sess)) return json(res, 403, { error: 'csrf' });
      return fn(req, res, { sess, u });
    };
  }

  // --- page routes (self-contained HTML) ----------------------------------------------------
  const pageRoutes = {
    '/account/login': 'login', '/account/register': 'register', '/account': 'account',
    '/account/verify': 'verify', '/account/reset': 'reset', '/account/forgot': 'forgot',
    '/account/support': 'support', '/account/admin': 'admin', '/account/welcome': 'welcome',
    '/account/verify-email': 'verifyEmail',
  };

  const server = http.createServer(async (req, res) => {
    const base = securityHeaders(cfg);
    for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
    if (cfg.killed) return json(res, 503, { error: 'maintenance' });
    let url;
    try { url = new URL(req.url, cfg.publicOrigin); } catch { return json(res, 400, { error: 'bad url' }); }
    const pathn = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && pathn === '/account/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(APP_JS);
      }
      if (req.method === 'GET' && pageRoutes[pathn]) {
        if (pathn === '/account/admin') {
          const sess = await currentSession(req);
          const u = sess ? store.get('users', sess.uid) : null;
          if (!u || u.role !== 'admin') return json(res, 404, { error: 'not found' }); // don't leak the admin shell
        }
        return html(res, 200, renderPage(pageRoutes[pathn], cfg));
      }
      if (pathn === '/healthz') return json(res, 200, { ok: true });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathn);
        if (m) return await r.fn(req, res, url, m); // pass the regex match (param routes need it)
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (/payload too large/.test(e.message)) return json(res, 413, { error: 'too large' });
      if (/bad json/.test(e.message)) return json(res, 400, { error: 'bad json' });
      // Never leak internals.
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  return { server, store, sessions, mailer, paypal, chain, cfg, ensureAdmin, stepAllBots, botDelegations, prices, _internal: { loginIpRl, acctRl, userByEmail } };
}

function sanitizeMeta(meta) {
  const out = {};
  for (const k of ['version', 'kdf', 'salt', 'nonce', 'device', 'walletKind', 'createdAt', 'app', 'address', 'scheme']) {
    if (meta[k] != null) out[k] = String(meta[k]).slice(0, 256);
  }
  return out;
}

// Direct run.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Wire the Google Play provider-auth token minter (RS256 JWT) from OUTSIDE src/ so the
  // service code itself stays free of asymmetric crypto (post-quantum guard). Only when a
  // service-account JSON is configured; otherwise Google IAP stays disabled (fails closed).
  let googleDeps;
  if (config.googleServiceAccountJson) {
    const { makeGoogleAccessToken } = await import('../google-token.mjs');
    googleDeps = { googleAccessToken: makeGoogleAccessToken(config) };
  }
  const app = createApp({ googleDeps });
  await app.ensureAdmin();
  app.server.listen(app.cfg.port, app.cfg.host, () =>
    console.log(`[accounts] listening on ${app.cfg.host}:${app.cfg.port} (prod=${app.cfg.prod}, mail=${app.cfg.mailTransport}, paypal=${app.paypal.stub ? 'stub' : app.cfg.paypalEnv})`));
  // Advance paper bots on an interval (best-effort price feed).
  const timer = setInterval(() => { app.stepAllBots().catch(() => {}); }, app.cfg.botStepMs);
  if (timer.unref) timer.unref();
  // Drop expired bot delegations so a key is never held past its lifetime.
  const sweep = setInterval(() => { try { app.botDelegations.sweep(); } catch { /* best-effort */ } }, 60_000);
  if (sweep.unref) sweep.unref();
  // Server-side live bot loop — evaluates each active delegation's plan and
  // executes due trades (gated: testnet-only unless BLOCKLE_BOT_MAINNET=1).
  const SIGNALS_BASE = process.env.SIGNALS_BASE || 'https://blockle.org';
  const SOLANA_RPC = process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com';
  const liveRun = setInterval(() => {
    liveRunOnce({
      delegations: app.botDelegations,
      // USD price for a native symbol via the server price resolver.
      prices: async (sym) => {
        try {
          const m = await app.prices.resolve([{ chain: '', kind: 'native', symbol: sym }]);
          return m[':native:' + String(sym).toUpperCase()] ?? Object.values(m)[0] ?? null;
        } catch { return null; }
      },
      // SNIPER deps: the signals discovery feed + a Solana JSON-RPC sender. The
      // autopilot buys the top safety-screened token via Jupiter (inside runOnce).
      discover: async ({ mode } = {}) => {
        try {
          const r = await fetch(`${SIGNALS_BASE}/api/signals/discover?mode=${encodeURIComponent(mode || 'sniper')}`, { headers: { accept: 'application/json' } });
          const j = await r.json();
          return (j && j.candidates) || [];
        } catch { return []; }
      },
      solRpc: async (method, params) => {
        try {
          const r = await fetch(SOLANA_RPC, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          const j = await r.json();
          return j && (j.result !== undefined ? j.result : j);
        } catch (e) { return { error: { message: String(e && e.message || e) } }; }
      },
    }).catch(() => {});
  }, 60_000);
  if (liveRun.unref) liveRun.unref();
}
