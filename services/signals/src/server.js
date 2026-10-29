// Blockle cross-chain token signals (loopback; nginx proxies /api/signals/*).
//
// Produces ONE normalized due-diligence report per token so the trading bots can
// make safe, profit-oriented decisions across chains. Pure read-only: it never
// holds keys or moves funds. Sources per chain:
//   BLOCK    — local node/biz: LP lock, reserves/liquidity, market cap, price series.
//   solana   — DexScreener (liq/mcap/vol/age/price) + Solana RPC
//              (getTokenLargestAccounts/getTokenSupply → top-holder %, getAccountInfo
//               → mint/freeze authority renounced?).
//   ethereum — DexScreener + GoPlus token_security (holders, top-holder %, honeypot,
//   bsc        buy/sell tax, LP-lock %, mintable, open-source).
//
// A report carries raw metrics + a hard SAFETY GATE (`safe`, `flags`) and a 0–100
// `score` (higher = better buy). The bot rejects unsafe tokens and ranks the rest.
import http from 'node:http';

const PORT = Number(process.env.SIGNALS_PORT || 8808 + 1); // 8809
const BIZ = (process.env.SIGNALS_BIZ_URL || 'http://127.0.0.1:8900').replace(/\/+$/, '');
const SOL_RPC = (process.env.SIGNALS_SOL_RPC || 'https://solana-rpc.publicnode.com').replace(/\/+$/, '');
const DEXSCREENER = 'https://api.dexscreener.com';
const GOPLUS = 'https://api.gopluslabs.io/api/v1';
const GOPLUS_CHAIN = { ethereum: '1', bsc: '56' };
const DEX_CHAIN = { solana: 'solana', ethereum: 'ethereum', bsc: 'bsc' };
const CACHE_MS = Number(process.env.SIGNALS_CACHE_MS || 60_000);

// --- gate / score thresholds (operator-tunable) ------------------------------
const CFG = {
  minLiquidityUsd: Number(process.env.SIGNALS_MIN_LIQ_USD || 5_000),
  minAgeSec: Number(process.env.SIGNALS_MIN_AGE_SEC || 3 * 3600), // >= 3h old
  maxTopHolderPct: Number(process.env.SIGNALS_MAX_TOP_HOLDER_PCT || 30),
  maxTop10Pct: Number(process.env.SIGNALS_MAX_TOP10_PCT || 70),
  minHolders: Number(process.env.SIGNALS_MIN_HOLDERS || 50),
  maxSellTaxPct: Number(process.env.SIGNALS_MAX_SELL_TAX_PCT || 10),
  mcapSweetLowUsd: Number(process.env.SIGNALS_MCAP_SWEET_LOW || 50_000),
  mcapSweetHighUsd: Number(process.env.SIGNALS_MCAP_SWEET_HIGH || 5_000_000),
};

// Risk MODES — each tightens or relaxes the gate + reshapes the mcap sweet-spot.
// safe: blue-chips only. medium: balanced (≈ base CFG). high: microcap/social.
// sniper: brand-new launches — relax the age gate (that's the point) but KEEP
// the hard rug checks (honeypot / lp-unlock / mintable / extreme concentration).
const MODES = {
  safe:   { minLiquidityUsd: 1_000_000, minAgeSec: 30 * 86400, maxTopHolderPct: 20, maxTop10Pct: 60, minHolders: 10_000, maxSellTaxPct: 5,  mcapSweetLowUsd: 1e9,    mcapSweetHighUsd: 1e13,     sniper: false },
  medium: { minLiquidityUsd: 100_000,   minAgeSec: 14 * 86400, maxTopHolderPct: 25, maxTop10Pct: 65, minHolders: 1_000,  maxSellTaxPct: 8,  mcapSweetLowUsd: 1e7,    mcapSweetHighUsd: 2e9,      sniper: false },
  high:   { minLiquidityUsd: 15_000,    minAgeSec: 6 * 3600,   maxTopHolderPct: 35, maxTop10Pct: 75, minHolders: 150,    maxSellTaxPct: 10, mcapSweetLowUsd: 50_000, mcapSweetHighUsd: 5_000_000, sniper: false },
  sniper: { minLiquidityUsd: 4_000,     minAgeSec: 0,          maxTopHolderPct: 40, maxTop10Pct: 85, minHolders: 30,     maxSellTaxPct: 12, mcapSweetLowUsd: 10_000, mcapSweetHighUsd: 2_000_000, sniper: true },
};
const DEFAULT_MODE = 'medium';
function modeCfg(mode) { return { ...CFG, ...(MODES[mode] || MODES[DEFAULT_MODE]) }; }

const now = () => Date.now();
const cache = new Map(); // key -> {at, data}
function cached(key) { const v = cache.get(key); return v && now() - v.at < CACHE_MS ? v.data : null; }
function put(key, data) { cache.set(key, { at: now(), data }); return data; }

async function jget(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}
async function rpc(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    return j.result;
  } catch { return null; } finally { clearTimeout(t); }
}

// --- DexScreener: pick the deepest pair for this token on the chain ----------
async function dexscreener(chain, token) {
  const j = await jget(`${DEXSCREENER}/latest/dex/tokens/${encodeURIComponent(token)}`);
  const pairs = (j && j.pairs) || [];
  const dc = DEX_CHAIN[chain];
  const mine = pairs.filter((p) => p.chainId === dc);
  if (!mine.length) return null;
  mine.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = mine[0];
  const createdMs = p.pairCreatedAt || 0;
  const buys = Number(p.txns?.h24?.buys) || 0;
  const sells = Number(p.txns?.h24?.sells) || 0;
  const socials = Array.isArray(p.info?.socials) ? p.info.socials.map((s) => s.type || s.platform).filter(Boolean) : [];
  const websites = Array.isArray(p.info?.websites) ? p.info.websites.length : 0;
  return {
    priceUsd: Number(p.priceUsd) || null,
    liquidityUsd: Number(p.liquidity?.usd) || 0,
    marketCapUsd: Number(p.marketCap || p.fdv) || null,
    fdvUsd: Number(p.fdv) || null,
    volume24hUsd: Number(p.volume?.h24) || 0,
    volume1hUsd: Number(p.volume?.h1) || 0,
    priceChange24hPct: Number(p.priceChange?.h24) || 0,
    priceChange1hPct: Number(p.priceChange?.h1) || 0,
    buys24h: buys,
    sells24h: sells,
    buySellRatio: sells > 0 ? +(buys / sells).toFixed(2) : (buys > 0 ? buys : null),
    socials,                              // e.g. ['twitter','telegram']
    socialCount: socials.length,
    websites,
    boosts: Number(p.boosts?.active) || 0, // DexScreener paid-promo boosts (hype proxy)
    ageSec: createdMs ? Math.max(0, Math.floor((now() - createdMs) / 1000)) : null,
    dex: p.dexId || null,
    pair: p.pairAddress || null,
    symbol: p.baseToken?.symbol || null,
    name: p.baseToken?.name || null,
  };
}

// --- Solana safety via GoPlus (holders, top-holder %, LP lock, authorities) --
// GoPlus's Solana endpoint gives the same depth as EVM without a paid indexing
// RPC (the public Solana RPC blocks getTokenLargestAccounts/getTokenSupply).
async function solanaSafety(mint) {
  const j = await jget(`${GOPLUS}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`, { timeout: 10000 });
  const res = j && j.result;
  const d = res && (res[mint] || Object.values(res)[0]);
  if (!d) {
    // fallback: mint/freeze authority only (getAccountInfo isn't an indexed request)
    const acct = await rpc(SOL_RPC, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = acct?.value?.data?.parsed?.info || {};
    return { topHolderPct: null, top10Pct: null, holders: null, mintRenounced: info.mintAuthority == null, freezeRenounced: info.freezeAuthority == null, honeypot: false };
  }
  const hs = Array.isArray(d.holders) ? d.holders : [];
  const lp = Array.isArray(d.lp_holders) ? d.lp_holders : [];
  const mintable = !!(d.mintable && String(d.mintable.status) === '1');
  const freezable = !!(d.freezable && String(d.freezable.status) === '1');
  return {
    holders: Number(d.holder_count) || null,
    topHolderPct: hs[0] ? +(Number(hs[0].percent) * 100).toFixed(2) : null,
    top10Pct: hs.length ? +(hs.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100).toFixed(2) : null,
    lpLockedPct: lp.length ? +(lp.filter((h) => h.is_locked == 1).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100).toFixed(2) : null,
    mintable,
    freezable,
    mintRenounced: !mintable,
    freezeRenounced: !freezable,
    honeypot: d.non_transferable === true || String(d.non_transferable) === '1' || !!(d.transfer_hook && String(d.transfer_hook.status) === '1'),
  };
}

// --- GoPlus token security (EVM: ethereum / bsc) -----------------------------
async function goplus(chain, token) {
  const id = GOPLUS_CHAIN[chain];
  if (!id) return null;
  const j = await jget(`${GOPLUS}/token_security/${id}?contract_addresses=${encodeURIComponent(token.toLowerCase())}`, { timeout: 10000 });
  const d = j && j.result && j.result[token.toLowerCase()];
  if (!d) return null;
  const holders = Number(d.holder_count) || null;
  const topHolderPct = d.holders && d.holders[0] ? +(Number(d.holders[0].percent) * 100).toFixed(2) : null;
  const top10Pct = Array.isArray(d.holders) ? +(d.holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100).toFixed(2) : null;
  const lpLockedPct = Array.isArray(d.lp_holders)
    ? +(d.lp_holders.filter((h) => h.is_locked == 1 || /burn|dead|0x0{40}/i.test(h.address || '')).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100).toFixed(2)
    : null;
  return {
    holders,
    topHolderPct,
    top10Pct,
    honeypot: d.is_honeypot == 1,
    buyTaxPct: d.buy_tax != null ? +(Number(d.buy_tax) * 100).toFixed(2) : null,
    sellTaxPct: d.sell_tax != null ? +(Number(d.sell_tax) * 100).toFixed(2) : null,
    lpLockedPct,
    mintable: d.is_mintable == 1,
    openSource: d.is_open_source == 1,
    ownerRenounced: !d.owner_address || /0x0{40}|0xdead/i.test(d.owner_address),
  };
}

// --- BLOCK: local node/biz --------------------------------------------------
async function blockSignals(token) {
  const [poolsR, tok, hist] = await Promise.all([
    jget(`${BIZ}/api/dex/pools`),
    jget(`${BIZ}/api/token/${encodeURIComponent(token)}`),
    jget(`${BIZ}/api/dex/history?token=${encodeURIComponent(token)}`),
  ]);
  const pools = (poolsR && poolsR.pools) || [];
  const height = (poolsR && poolsR.height) || 0;
  const pool = pools.find((p) => (p.token || '').toLowerCase() === token.toLowerCase());
  const info = (tok && (tok.result || tok)) || {};
  const dec = Number(pool?.decimals ?? info.decimals ?? 8);
  const blockReserve = pool ? Number(pool.blockReserve) / 1e8 : 0;
  const tokenReserve = pool ? Number(pool.tokenReserve) / 10 ** dec : 0;
  const priceBlock = tokenReserve > 0 ? blockReserve / tokenReserve : null;
  const supply = info.totalSupply != null ? Number(info.totalSupply) / 10 ** dec : null;
  const lockBlocks = pool ? (Number(pool.lockedUntil) || 0) - height : 0;
  const series = Array.isArray(hist) ? hist.map((h) => Number(h.price)).filter(Number.isFinite) : [];
  const change = series.length >= 2 ? (series[series.length - 1] - series[0]) / series[0] * 100 : 0;
  return {
    chain: 'block',
    priceBlock,
    liquidityBlock: blockReserve * 2,
    liquidityUsd: null, // no BLOCK/USD oracle here — liquidity reported in BLOCK
    marketCapBlock: priceBlock != null && supply != null ? priceBlock * supply : null,
    marketCapUsd: null,
    volume24hUsd: null, // no swap-volume index on BLOCK yet
    priceChange24hPct: +change.toFixed(2),
    ageSec: null,
    ageBlocks: pool ? height - (Number(pool.createdHeight) || height) : null,
    liquidityLocked: lockBlocks > 0,
    lockDaysLeft: lockBlocks > 0 ? +(lockBlocks * 600 / 86400).toFixed(2) : 0,
    holders: null,       // BLOCK-20 has no holder index yet (hashed balance keys)
    topHolderPct: null,
    top10Pct: null,
    symbol: pool?.symbol || info.symbol || null,
    name: pool?.name || info.name || null,
    hasPool: !!pool,
  };
}

// --- social / hype sub-score (0–100) -----------------------------------------
// A transparent proxy for "social activity and popularity" from the free data we
// have: buyer velocity (buys vs sells), DexScreener boosts, declared socials, and
// volume churned relative to liquidity. NOTE: true Twitter/Telegram engagement
// needs a paid API (LunarCrush/Twitter) — this is a best-effort on-chain proxy,
// and that limitation is reported in the output as `hypeBasis`.
function hypeScore(m) {
  let h = 0;
  if (m.buySellRatio != null) h += Math.min(28, Math.max(0, (m.buySellRatio - 0.8) * 28)); // buy pressure
  h += Math.min(22, (Number(m.boosts) || 0) * 7);                                           // paid promo boosts
  h += Math.min(16, (Number(m.socialCount) || 0) * 7 + (m.websites ? 2 : 0));               // declared presence
  const churn = (m.liquidityUsd > 0) ? (m.volume24hUsd || 0) / m.liquidityUsd : 0;          // vol/liq churn
  h += Math.min(20, churn * 10);
  h += Math.min(14, Math.max(0, (m.priceChange1hPct || 0)));                                 // very-recent momentum
  return Math.max(0, Math.min(100, Math.round(h)));
}

// --- unify + gate + score ----------------------------------------------------
function assess(chain, token, m, mode = DEFAULT_MODE) {
  const C = modeCfg(mode);
  const flags = [];
  const hype = hypeScore(m);
  // Hard safety gate (mode-tuned thresholds; sniper relaxes the age gate only).
  if (chain === 'block') {
    if (!m.hasPool) flags.push('no-liquidity-pool');
    else if (!m.liquidityLocked) flags.push('lp-unlocked');
  } else {
    if ((m.liquidityUsd || 0) < C.minLiquidityUsd) flags.push('low-liquidity');
    if (!C.sniper && m.ageSec != null && m.ageSec < C.minAgeSec) flags.push('too-new');
    if (m.honeypot) flags.push('honeypot');
    if (m.sellTaxPct != null && m.sellTaxPct > C.maxSellTaxPct) flags.push('high-sell-tax');
    if (m.topHolderPct != null && m.topHolderPct > C.maxTopHolderPct) flags.push('holder-concentration');
    if (m.top10Pct != null && m.top10Pct > C.maxTop10Pct) flags.push('top10-concentration');
    if (m.holders != null && m.holders < C.minHolders) flags.push('few-holders');
    if (chain === 'solana') {
      if (m.mintRenounced === false) flags.push('mint-not-renounced');
      if (m.lpLockedPct != null && m.lpLockedPct < 50) flags.push('lp-unlocked');
    }
    if ((chain === 'ethereum' || chain === 'bsc')) {
      if (m.lpLockedPct != null && m.lpLockedPct < 50) flags.push('lp-unlocked');
      if (m.mintable) flags.push('mintable');
    }
  }
  // Rug checks are hard-fail in EVERY mode — sniper never bypasses them.
  const hardFail = flags.some((f) => ['no-liquidity-pool', 'honeypot', 'lp-unlocked', 'holder-concentration', 'top10-concentration', 'mintable', 'low-liquidity'].includes(f));
  const safe = !hardFail;

  // Profit-oriented 0–100 score (only meaningful when safe).
  let score = 0;
  const liq = m.liquidityUsd ?? (m.liquidityBlock ? m.liquidityBlock * 1000 : 0); // rough BLOCK→proxy
  score += Math.min(25, Math.log10(Math.max(1, liq)) / Math.log10(1e7) * 25);      // liquidity depth
  score += Math.min(20, Math.log10(Math.max(1, m.volume24hUsd || 0)) / Math.log10(1e6) * 20); // popularity (volume)
  if (m.holders != null) score += Math.min(15, Math.log10(Math.max(1, m.holders)) / Math.log10(5000) * 15); // holder base
  else score += 7;                                                                 // unknown → neutral
  const mcap = m.marketCapUsd || 0;
  if (mcap > 0) {                                                                   // favor the mode's growth sweet-spot
    score += (mcap >= C.mcapSweetLowUsd && mcap <= C.mcapSweetHighUsd) ? 20 : 8;
  } else score += 8;
  score += Math.max(0, Math.min(15, (m.priceChange24hPct || 0) / 2));              // upward momentum (capped)
  if (m.ageSec != null) score += Math.min(5, m.ageSec / (7 * 86400) * 5);          // survival/age
  else if (m.ageBlocks != null) score += Math.min(5, m.ageBlocks / 1008 * 5);
  if (m.topHolderPct != null) score -= Math.max(0, (m.topHolderPct - 10) / 2);     // concentration penalty
  // High/sniper modes weight social hype more heavily (social-driven by design).
  const hypeW = C.sniper ? 0.35 : (mode === 'high' ? 0.25 : 0.1);
  score = score * (1 - hypeW) + hype * hypeW;
  score = Math.max(0, Math.min(100, Math.round(score)));
  if (!safe) score = 0;

  return {
    chain, token, mode, safe, score, hype,
    hypeBasis: 'on-chain proxy (buy/sell velocity, DexScreener boosts, declared socials, vol/liq churn); not Twitter/Telegram engagement',
    flags, metrics: m, assessedAt: now(),
  };
}

async function report(chain, token, mode = DEFAULT_MODE) {
  const key = `${chain}:${token}:${mode}`;
  const hit = cached(key);
  if (hit) return hit;
  let m;
  if (chain === 'block') {
    m = await blockSignals(token);
  } else if (chain === 'solana') {
    const [dex, saf] = await Promise.all([dexscreener('solana', token), solanaSafety(token)]);
    m = { chain, ...(dex || {}), ...(saf || {}) };
  } else if (chain === 'ethereum' || chain === 'bsc') {
    const [dex, gp] = await Promise.all([dexscreener(chain, token), goplus(chain, token)]);
    m = { chain, ...(dex || {}), ...(gp || {}) };
  } else {
    throw new Error('unsupported chain');
  }
  return put(key, assess(chain, token, m, mode));
}

// --- discovery: freshly-promoted / trending tokens for sniper & high modes ----
// DexScreener's token-boosts feeds surface newly-promoted tokens (a strong proxy
// for "just launched + getting attention"). We filter to the requested chain,
// run each candidate through the mode gate, and return the ones that PASS, best
// score first. Honest: this is a discovery aid, not a guarantee — most brand-new
// tokens still fail the gate or go to zero.
const CHAIN_OF = { solana: 'solana', ethereum: 'ethereum', bsc: 'bsc' };
async function boostFeed(path) {
  const j = await jget(`${DEXSCREENER}/${path}`, { timeout: 9000 });
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
  return arr || [];
}
async function discover(mode = 'sniper', chain = null, limit = 12) {
  const [latest, top] = await Promise.all([
    boostFeed('token-boosts/latest/v1'),
    boostFeed('token-boosts/top/v1'),
  ]);
  const seen = new Set();
  const cands = [];
  for (const b of [...latest, ...top]) {
    const ch = CHAIN_OF[(b.chainId || '').toLowerCase()];
    const addr = b.tokenAddress || b.address;
    if (!ch || !addr) continue;
    if (chain && ch !== chain) continue;
    const k = `${ch}:${addr}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push({ chain: ch, token: addr });
    if (cands.length >= 40) break;
  }
  // Assess candidates (bounded concurrency to be gentle on the free APIs).
  const out = [];
  const BATCH = 5;
  for (let i = 0; i < cands.length; i += BATCH) {
    const slice = cands.slice(i, i + BATCH);
    const reps = await Promise.all(slice.map((c) => report(c.chain, c.token, mode).catch(() => null)));
    for (const r of reps) if (r && r.safe) out.push(r);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => b.score - a.score);
  return { mode, chain: chain || 'all', generatedAt: now(), count: Math.min(out.length, limit), candidates: out.slice(0, limit) };
}

const SUPPORTED = ['block', 'solana', 'ethereum', 'bsc'];
function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return j(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.replace(/^\/api\/signals\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'health' || url.pathname === '/api/signals/health') return j(res, 200, { ok: true, chains: SUPPORTED, modes: Object.keys(MODES) });
    if (parts[0] === 'config') return j(res, 200, { chains: SUPPORTED, modes: MODES, thresholds: CFG, defaultMode: DEFAULT_MODE });
    const mode = (url.searchParams.get('mode') || DEFAULT_MODE).toLowerCase();
    const useMode = MODES[mode] ? mode : DEFAULT_MODE;
    // /api/signals/discover?mode=sniper&chain=solana&limit=12 — new-launch / trending feed
    if (parts[0] === 'discover' || parts[0] === 'trending' || parts[0] === 'new-launches') {
      const dchain = (url.searchParams.get('chain') || '').toLowerCase();
      const lim = Math.max(1, Math.min(25, Number(url.searchParams.get('limit')) || 12));
      const m2 = parts[0] === 'new-launches' ? 'sniper' : useMode;
      return j(res, 200, await discover(m2, CHAIN_OF[dchain] || null, lim));
    }
    // /api/signals/:chain/token/:id?mode=high
    const chain = (parts[0] || '').toLowerCase();
    if (!SUPPORTED.includes(chain)) return j(res, 400, { error: 'unsupported chain', supported: SUPPORTED });
    if (parts[1] === 'token' && parts[2]) return j(res, 200, await report(chain, parts[2], useMode));
    return j(res, 404, { error: 'not found — use /api/signals/<chain>/token/<address>?mode=<safe|medium|high|sniper> or /api/signals/discover?mode=sniper&chain=<chain>' });
  } catch (e) {
    return j(res, 500, { error: (e && e.message) || String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[signals] on 127.0.0.1:${PORT} chains=${SUPPORTED.join(',')} sol_rpc=${SOL_RPC}`));
