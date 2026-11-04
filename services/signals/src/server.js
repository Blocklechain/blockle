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
import * as Buzz from './buzz.js';

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

// --- BUZZ: online presence / traffic feed (buzz.js) ---------------------------
// "Which tokens is the internet piling into right now?" — merges CoinGecko
// search-trending, GeckoTerminal trending pools (unique buyers, volume pace),
// DexScreener boosts/profiles and watchlist/sentiment counts, runs every
// candidate through the SAME mode safety gate as /discover, and ranks by
// `buzz.quick` (attention × velocity × exit feasibility; 0 when unsafe). The
// Buzz Hunter bot (signal bot, rank=buzz) consumes it. READ-ONLY, cached.
const BUZZ_CACHE_MS = Number(process.env.SIGNALS_BUZZ_CACHE_MS || 90_000);
const COIN_CACHE_MS = 6 * 3600_000;   // CoinGecko platforms/watchlist change slowly
const COIN_FAIL_MS = 10 * 60_000;     // back off on a 429/empty for 10 min
function cachedFor(key, ms) { const v = cache.get(key); return v && now() - v.at < ms ? v.data : null; }
let coinQueue = Promise.resolve();
// One CoinGecko /coins/{id} lookup at a time, 350 ms apart (free tier ~30/min).
function resolveCoin(id) {
  const key = 'cg:coin:' + id;
  const hit = cachedFor(key, COIN_CACHE_MS);
  if (hit) return Promise.resolve(hit.v);
  const miss = cachedFor(key + ':fail', COIN_FAIL_MS);
  if (miss) return Promise.resolve(null);
  const run = coinQueue.then(async () => {
    const again = cachedFor(key, COIN_CACHE_MS); if (again) return again.v;
    const j = await jget(`${COINGECKO}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`, { timeout: 9000 });
    const v = Buzz.parseCoinGeckoCoin(j);
    if (v) put(key, { v }); else put(key + ':fail', { v: null });
    await new Promise((r) => setTimeout(r, 350));
    return v;
  });
  coinQueue = run.catch(() => null);
  return run;
}
async function buzzFeed(mode = 'high', chain = null, limit = 12) {
  const key = `buzz:${mode}:${chain || 'all'}`;
  const hit = cachedFor(key, BUZZ_CACHE_MS);
  if (hit) return { ...hit, limit, candidates: hit.candidates.slice(0, limit) };
  const chains = chain ? [chain] : Object.keys(CHAIN_OF);
  const { candidates, counts } = await Buzz.gatherBuzz(jget, { resolveCoin, chains });
  const mine = candidates.filter((c) => !chain || c.chain === chain).slice(0, 60);
  // Safety-gate every candidate (bounded concurrency; report() is cached 60 s).
  const rows = [];
  const BATCH = 5;
  for (let i = 0; i < mine.length; i += BATCH) {
    const slice = mine.slice(i, i + BATCH);
    const reps = await Promise.all(slice.map((c) => report(c.chain, c.token, mode).catch(() => null)));
    slice.forEach((c, k) => {
      const r = reps[k];
      const buzz = Buzz.scoreCandidate(c, r);
      const m = (r && r.metrics) || {};
      rows.push({
        chain: c.chain, token: c.token, mode,
        symbol: c.symbol || m.symbol || null, name: c.name || m.name || null,
        safe: r ? r.safe : false, score: r ? r.score : 0, hype: r ? r.hype : null, flags: r ? r.flags : ['no-report'],
        buzz, sources: c.sources, signals: c.signals, metrics: r ? r.metrics : {},
        hypeBasis: r ? r.hypeBasis : null, assessedAt: now(),
      });
    });
  }
  const safeRows = rows.filter((r) => r.safe).sort((a, b) => (b.buzz.quick - a.buzz.quick) || (b.buzz.attention - a.buzz.attention));
  const rejected = rows.filter((r) => !r.safe).sort((a, b) => b.buzz.attention - a.buzz.attention).slice(0, 10)
    .map((r) => ({ chain: r.chain, token: r.token, symbol: r.symbol, attention: r.buzz.attention, velocity: r.buzz.velocity, flags: r.flags }));
  const out = { feed: 'buzz', mode, chain: chain || 'all', generatedAt: now(), sources: counts, basis: Buzz.BASIS,
    count: safeRows.length, candidates: safeRows, rejected };
  put(key, out);
  return { ...out, limit, candidates: safeRows.slice(0, limit) };
}

// --- ARBITRAGE board: REAL current same-chain cross-DEX spreads -----------------
// For a token, DexScreener lists every DEX pair with its current priceUsd. Buying on
// the cheaper pool and selling on the dearer is a genuine, currently-observable
// arbitrage. We take the min/max priced LIQUID pools on the SAME chain, subtract a
// conservative round-trip cost (two swap fees + the 0.05% agent fee + a slippage
// buffer), and report the NET spread. HONEST: this is a live snapshot, not a
// historical backtest; spreads are fleeting, size-limited, and compete with MEV
// bots, so many opportunities are net-negative (shown as-is). No arb is executed here.
const ARB_FEE_PCT = Number(process.env.SIGNALS_ARB_FEE_PCT || 0.80); // 2×~0.3% swap + 0.05% agent + ~0.15% slip
// Liquid majors per chain — they have many deep DEX pools, so safe/medium modes
// always have real (usually tight, often sub-fee) cross-DEX spreads to show.
const ARB_MAJORS = {
  solana: ['So11111111111111111111111111111111111111112', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'],
  ethereum: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0x514910771AF9Ca656af840dff83E8264EcF986CA', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', '0x6982508145454Ce325dDbE47a25d4ec3d2311933', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9'],
  bsc: ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', '0x4B0F1812e5Df2A09796481Ff14017e6005508003'],
};
const ARB_MIN_VOL_USD = Number(process.env.SIGNALS_ARB_MIN_VOL || 3_000); // both legs must be ACTIVE
const ARB_MAX_PCT = Number(process.env.SIGNALS_ARB_MAX_PCT || 5);          // > this ⇒ stale/dead pool, not real arb
async function arbPairs(chain, token) {
  const j = await jget(`${DEXSCREENER}/latest/dex/tokens/${encodeURIComponent(token)}`, { timeout: 9000 });
  const dc = DEX_CHAIN[chain];
  return ((j && j.pairs) || [])
    .filter((p) => p.chainId === dc && Number(p.priceUsd) > 0 && Number(p.liquidity?.usd) > 0)
    .map((p) => ({ dex: p.dexId || '?', priceUsd: Number(p.priceUsd), liqUsd: Number(p.liquidity?.usd) || 0, volUsd: Number(p.volume?.h24) || 0, sym: p.baseToken?.symbol || null, quote: p.quoteToken?.symbol || null }));
}
function arbOpp(chain, token, pairs, minLiqUsd) {
  // both legs must be DEEP (liquidity) AND ACTIVE (real 24h volume) — dead/stale
  // pools carry garbage prices that look like huge fake spreads.
  const liq = pairs.filter((p) => p.liqUsd >= minLiqUsd && p.volUsd >= ARB_MIN_VOL_USD);
  if (liq.length < 2) return null;
  liq.sort((a, b) => a.priceUsd - b.priceUsd);
  const lo = liq[0], hi = liq[liq.length - 1];
  const grossPct = (hi.priceUsd - lo.priceUsd) / lo.priceUsd * 100;
  // reject implausible spreads — a persistent double-digit same-chain gap on active
  // pools doesn't exist; it's a mispriced/stale pool, not a capturable arb.
  if (!(grossPct > 0) || grossPct > ARB_MAX_PCT) return null;
  const netPct = +(grossPct - ARB_FEE_PCT).toFixed(3);
  return {
    chain, token, sym: lo.sym || String(token).slice(0, 6),
    buyDex: lo.dex, sellDex: hi.dex, buyPrice: lo.priceUsd, sellPrice: hi.priceUsd,
    grossPct: +grossPct.toFixed(3), feesPct: ARB_FEE_PCT, netPct, profitable: netPct > 0,
    buyLiqUsd: Math.round(lo.liqUsd), sellLiqUsd: Math.round(hi.liqUsd),
    // size the capture by the shallower pool (you can't arb more than the pool holds)
    sizeCapUsd: Math.round(Math.min(lo.liqUsd, hi.liqUsd) * 0.01), // ~1% of the shallower pool
  };
}
async function arbBoard(mode = 'medium', chain = null, limit = 12) {
  const C = modeCfg(mode);
  const minLiqUsd = Math.max(10_000, Math.round(C.minLiquidityUsd / 5)); // need real depth on BOTH legs
  const [latest, top] = await Promise.all([boostFeed('token-boosts/top/v1'), boostFeed('token-boosts/latest/v1')]);
  const seen = new Set(), cands = [];
  // Seed with liquid majors (deep pools → safe/medium always have real spreads),
  // then add freshly-boosted microcaps (wider, less-efficient gaps for high/sniper).
  const majorChains = chain ? [chain] : ['solana', 'ethereum', 'bsc'];
  for (const ch of majorChains) for (const addr of (ARB_MAJORS[ch] || [])) {
    const k = `${ch}:${addr}`; if (seen.has(k)) continue; seen.add(k); cands.push({ chain: ch, token: addr });
  }
  for (const b of [...top, ...latest]) {
    const ch = CHAIN_OF[(b.chainId || '').toLowerCase()];
    const addr = b.tokenAddress || b.address;
    if (!ch || !addr) continue;
    if (chain && ch !== chain) continue;
    const k = `${ch}:${addr}`; if (seen.has(k)) continue; seen.add(k);
    cands.push({ chain: ch, token: addr });
    if (cands.length >= 46) break;
  }
  const out = []; let scanned = 0;
  const BATCH = 5;
  for (let i = 0; i < cands.length; i += BATCH) {
    const slice = cands.slice(i, i + BATCH);
    const res = await Promise.all(slice.map(async (c) => {
      const ps = await arbPairs(c.chain, c.token).catch(() => []);
      scanned++;
      return arbOpp(c.chain, c.token, ps, minLiqUsd);
    }));
    for (const o of res) if (o) out.push(o);
    if (out.length >= limit * 3) break;
  }
  out.sort((a, b) => b.netPct - a.netPct);
  return {
    mode, chain: chain || 'all', generatedAt: now(), scanned,
    profitableAfterFees: out.filter((o) => o.profitable).length,
    feesPct: ARB_FEE_PCT, minLiquidityUsd: minLiqUsd,
    note: 'Live same-chain cross-DEX spreads, net of a conservative round-trip cost. Real-time snapshot, not a backtest — spreads are fleeting, size-limited, and compete with MEV bots; many are net-negative.',
    opportunities: out.slice(0, limit),
  };
}

// =============================================================================
// PRICE PROXY — /api/signals/prices?symbols=ETH,SOL&tokens=ethereum:0x..,solana:<mint>
// One shared 60s cache in front of CoinGecko (natives/blue chips by symbol) and
// DexScreener (any token by address) for every wallet, plus BLOCK/USD from the
// native rail. The wallet's PriceFeed tries this first and falls back to the
// providers directly. Symbol→CoinGecko-id and chain→DexScreener-id maps come
// from the wallet's own token-lists module (single source of truth).
// =============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
const TOKEN_LISTS_PATH = process.env.SIGNALS_TOKEN_LISTS || '/opt/blockle/web/wallet/vendor/chains/token-lists.js';
let TokenLists = null;
try { TokenLists = createRequire(import.meta.url)(TOKEN_LISTS_PATH); } catch (e) { console.warn('[signals] token-lists unavailable:', e.message); }
const COINGECKO = 'https://api.coingecko.com/api/v3';
const STABLE1 = new Set(['USDC', 'USDT', 'DAI', 'USD', 'USDB', 'USDBC', 'PYUSD', 'FDUSD', 'TUSD', 'BUSD', 'USDE', 'USDC.E', 'USDT.E', 'DAI.E', 'CUSD']);

async function coingeckoPrices(ids) {
  const uniq = [...new Set(ids)].sort();
  if (!uniq.length) return {};
  const key = 'cg:' + uniq.join(',');
  const hit = cached(key); if (hit) return hit;
  const j = await jget(`${COINGECKO}/simple/price?ids=${encodeURIComponent(uniq.join(','))}&vs_currencies=usd&include_24hr_change=true`, { timeout: 9000 });
  return put(key, j || {});
}
async function dexscreenerTokens(dsChain, addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const slice = addrs.slice(i, i + 30);
    const key = 'dst:' + dsChain + ':' + slice.map((a) => a.toLowerCase()).sort().join(',');
    let best = cached(key);
    if (!best) {
      const j = await jget(`${DEXSCREENER}/tokens/v1/${dsChain}/${slice.join(',')}`, { timeout: 9000 });
      best = {};
      for (const p of (Array.isArray(j) ? j : [])) {
        const base = p?.baseToken?.address?.toLowerCase();
        if (!base || !slice.some((a) => a.toLowerCase() === base)) continue;
        const liq = Number(p.liquidity?.usd) || 0, price = Number(p.priceUsd);
        if (!(price > 0)) continue;
        if (!best[base] || liq > best[base].liquidityUsd) {
          best[base] = { priceUsd: price, liquidityUsd: liq, symbol: p.baseToken.symbol || null, name: p.baseToken.name || null, change24h: Number(p.priceChange?.h24) || 0, change1h: Number(p.priceChange?.h1) || 0, volume24hUsd: Number(p.volume?.h24) || 0, marketCapUsd: Number(p.marketCap) || null, logo: p.info?.imageUrl || null, dex: p.dexId || null };
        }
      }
      put(key, best);
    }
    Object.assign(out, best);
  }
  return out;
}
async function blockUsdPrice() {
  const hit = cached('block:usd'); if (hit != null) return hit;
  let v = null;
  const poolsR = await jget(`${BIZ}/api/dex/pools`);
  const pools = (poolsR && poolsR.pools) || [];
  const stable = pools.find((p) => STABLE1.has(String(p.symbol || '').toUpperCase()) && Number(p.blockReserve) > 0 && Number(p.tokenReserve) > 0);
  if (stable) {
    const dec = Number(stable.decimals ?? 6);
    const blk = Number(stable.blockReserve) / 1e8, tok = Number(stable.tokenReserve) / 10 ** dec;
    if (blk > 0 && tok > 0) v = tok / blk;
  }
  if (v == null) {
    const hist = await jget(`${BIZ}/api/buy/history`);
    const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
    if (last && Number(last.price) > 0) v = Number(last.price);
  }
  return put('block:usd', v);
}
async function pricesProxy(symbolsCsv, tokensCsv) {
  const symbols = String(symbolsCsv || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
  const tokens = String(tokensCsv || '').split(',').map((s) => s.trim()).filter((s) => s.includes(':')).slice(0, 90);
  const prices = {}, change = {};
  const cgOf = {};
  for (const s of symbols) {
    if (STABLE1.has(s)) { prices[s] = 1; continue; }
    if (s === 'BLOCK' || s === 'WBLOCK') continue;
    const id = TokenLists ? TokenLists.coingeckoId(s) : null;
    if (id) cgOf[s] = id;
  }
  const byChain = {};
  for (const t of tokens) { const i = t.indexOf(':'); const chain = t.slice(0, i).toLowerCase(), addr = t.slice(i + 1); const ds = TokenLists ? TokenLists.dexscreenerChain(chain) : DEX_CHAIN[chain]; if (ds && addr) (byChain[chain] = byChain[chain] || { ds, addrs: [] }).addrs.push(addr); }
  const [cg, blockUsd, ...dsParts] = await Promise.all([
    coingeckoPrices(Object.values(cgOf)),
    (symbols.includes('BLOCK') || symbols.includes('WBLOCK')) ? blockUsdPrice().catch(() => null) : Promise.resolve(null),
    ...Object.keys(byChain).map((chain) => dexscreenerTokens(byChain[chain].ds, byChain[chain].addrs).then((m) => [chain, m]).catch(() => [chain, {}])),
  ]);
  for (const s of Object.keys(cgOf)) { const r = cg[cgOf[s]]; if (r && Number(r.usd) > 0) { prices[s] = Number(r.usd); if (r.usd_24h_change != null) change[s] = Number(r.usd_24h_change); } }
  if (blockUsd > 0) { if (symbols.includes('BLOCK')) prices.BLOCK = blockUsd; if (symbols.includes('WBLOCK')) prices.WBLOCK = blockUsd; }
  const tokOut = {};
  for (const [chain, m] of dsParts) for (const addr of byChain[chain].addrs) { const r = m[addr.toLowerCase()]; if (r) tokOut[chain + ':' + addr] = r; }
  return { at: now(), prices, change, tokens: tokOut, blockUsd: blockUsd ?? null };
}

// =============================================================================
// MOON — the Moonshot-style BLOCK-20 feed shared by the web + mobile wallets
// (docs/MOONSHOT.md). One ranked list of every tradable BLOCK-20 token with
// price (BLOCK + USD), liquidity, lock status, age, 1h/24h/7d change and a
// sparkline from the 15-minute snapshot history. Cached 60s. Read-only.
// =============================================================================
const DEXHIST_FILE = process.env.SIGNALS_DEXHIST || '/var/lib/blockle-biz/dex-history.json';
function readDexHistory() {
  const hit = cached('moon:hist'); if (hit) return hit;
  let h = {};
  try { h = JSON.parse(fs.readFileSync(DEXHIST_FILE, 'utf8')) || {}; } catch { h = {}; }
  return put('moon:hist', h);
}
function changeSince(series, secAgo, nowSec) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = series[series.length - 1];
  const cutoff = nowSec - secAgo;
  let ref = null;
  for (const pt of series) { if (Number(pt.t) >= cutoff) { ref = pt; break; } }
  if (!ref || ref === last) ref = series[0];
  if (Number(series[series.length - 1].t) - Number(ref.t) < Math.min(secAgo, 600)) return null; // not enough span
  const a = Number(ref.price), b = Number(last.price);
  return a > 0 ? +(((b - a) / a) * 100).toFixed(2) : null;
}
function moonScore(t) {
  const liq = Math.max(0, Number(t.liquidityBlock) || 0);
  const liqScore = Math.min(40, Math.log10(1 + liq) * 10);
  const c24 = Number(t.change24hPct) || 0, c1 = Number(t.change1hPct) || 0;
  const momentum = Math.max(-20, Math.min(35, c24 * 0.5 + c1 * 1.5));
  const age = Number(t.ageBlocks);
  const fresh = Number.isFinite(age) ? Math.max(0, 15 - age / 48) : 0;
  const lock = t.lpLocked ? 8 : 0;
  const vol = Number(t.volume24hBlock) || 0;
  const volScore = Math.min(12, Math.log10(1 + vol) * 4);
  const penalty = (t.flags || []).some((f) => /honeypot|rug|scam|denylist/i.test(f)) ? -100 : 0;
  return Math.round((liqScore + momentum + fresh + lock + volScore + penalty) * 100) / 100;
}
async function moonFeed() {
  const hit = cached('moon:feed'); if (hit) return hit;
  const [poolsR, tokensR, blockUsd] = await Promise.all([jget(`${BIZ}/api/dex/pools`), jget(`${BIZ}/api/dex/tokens`), blockUsdPrice().catch(() => null)]);
  const pools = (poolsR && poolsR.pools) || [];
  const height = Number(poolsR && poolsR.height) || 0;
  const hist = readDexHistory();
  const nowSec = Math.floor(now() / 1000);
  const logos = tokensR && typeof tokensR === 'object' ? tokensR : {};
  const tokens = [];
  for (const p of pools) {
    const id = String(p.token || '').toLowerCase();
    if (!id) continue;
    const dec = Number(p.decimals ?? 8);
    const blk = Number(p.blockReserve) / 1e8, tok = Number(p.tokenReserve) / 10 ** dec;
    if (!(blk > 0) || !(tok > 0)) continue;
    const priceBlock = blk / tok;
    const series = Array.isArray(hist[p.token]) ? hist[p.token] : (Array.isArray(hist[id]) ? hist[id] : []);
    const spark = series.slice(-48).map((x) => Number(x.price)).filter(Number.isFinite);
    const lockLeft = (Number(p.lockedUntil) || 0) - height;
    const ageBlocks = p.createdHeight != null ? Math.max(0, height - Number(p.createdHeight)) : null;
    const row = {
      contract: p.token, poolId: p.poolId || null, symbol: p.symbol || null, name: p.name || null, decimals: dec,
      logo: (logos[p.token] && logos[p.token].logo) || (logos[id] && logos[id].logo) || null,
      priceBlock, priceUsd: blockUsd > 0 ? priceBlock * blockUsd : null,
      blockReserve: String(p.blockReserve), tokenReserve: String(p.tokenReserve), poolFeeBps: p.poolFeeBps != null ? Number(p.poolFeeBps) : 30,
      liquidityBlock: blk * 2, liquidityUsd: blockUsd > 0 ? blk * 2 * blockUsd : null,
      lpLocked: lockLeft > 0, lockDaysLeft: lockLeft > 0 ? +((lockLeft * 600) / 86400).toFixed(2) : 0,
      ageBlocks, createdHeight: p.createdHeight != null ? Number(p.createdHeight) : null,
      change1hPct: changeSince(series, 3600, nowSec), change24hPct: changeSince(series, 86400, nowSec), change7dPct: changeSince(series, 7 * 86400, nowSec),
      volume24hBlock: null, snapshots: series.length, spark, flags: lockLeft > 0 ? [] : ['lp-unlocked'],
    };
    row.score = moonScore(row);
    tokens.push(row);
  }
  tokens.sort((a, b) => b.score - a.score || String(a.symbol).localeCompare(String(b.symbol)));
  return put('moon:feed', { generatedAt: now(), height, blockUsd: blockUsd ?? null, count: tokens.length, tokens });
}
async function moonToken(id) {
  const feed = await moonFeed();
  const row = feed.tokens.find((t) => String(t.contract).toLowerCase() === String(id).toLowerCase());
  if (!row) return null;
  const hist = readDexHistory();
  const series = Array.isArray(hist[row.contract]) ? hist[row.contract] : [];
  let diligence = null;
  try { diligence = await report('block', row.contract, 'high'); } catch { diligence = null; }
  return { ...row, blockUsd: feed.blockUsd, history: series.slice(-500), diligence };
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
    if (parts[0] === 'health' || url.pathname === '/api/signals/health') return j(res, 200, { ok: true, chains: SUPPORTED, modes: Object.keys(MODES), feeds: ['discover', 'buzz', 'arb', 'moon', 'prices'] });
    if (parts[0] === 'config') return j(res, 200, { chains: SUPPORTED, modes: MODES, thresholds: CFG, defaultMode: DEFAULT_MODE });
    // /api/signals/prices?symbols=ETH,SOL,BLOCK&tokens=solana:<mint>,base:0x.. — shared price cache
    if (parts[0] === 'prices') return j(res, 200, await pricesProxy(url.searchParams.get('symbols'), url.searchParams.get('tokens')));
    // /api/signals/moon/feed | /api/signals/moon/token/<contract> — the Moonshot-style BLOCK-20 feed
    if (parts[0] === 'moon') {
      if (parts[1] === 'token' && parts[2]) { const t = await moonToken(parts[2]); return t ? j(res, 200, t) : j(res, 404, { error: 'no pool for that token' }); }
      const feed = await moonFeed();
      const tab = (url.searchParams.get('tab') || 'trending').toLowerCase();
      const lim = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 100));
      let rows = feed.tokens.slice();
      if (tab === 'new') rows.sort((a, b) => (a.ageBlocks ?? 1e12) - (b.ageBlocks ?? 1e12));
      else if (tab === 'gainers') rows.sort((a, b) => (b.change24hPct ?? -1e9) - (a.change24hPct ?? -1e9));
      else if (tab === 'liquid') rows.sort((a, b) => b.liquidityBlock - a.liquidityBlock);
      return j(res, 200, { ...feed, tab, tokens: rows.slice(0, lim) });
    }
    const mode = (url.searchParams.get('mode') || DEFAULT_MODE).toLowerCase();
    const useMode = MODES[mode] ? mode : DEFAULT_MODE;
    // /api/signals/discover?mode=sniper&chain=solana&limit=12 — new-launch / trending feed
    if (parts[0] === 'discover' || parts[0] === 'trending' || parts[0] === 'new-launches') {
      const dchain = (url.searchParams.get('chain') || '').toLowerCase();
      const lim = Math.max(1, Math.min(25, Number(url.searchParams.get('limit')) || 12));
      const m2 = parts[0] === 'new-launches' ? 'sniper' : useMode;
      // rank=buzz: the online-presence feed in the discover row shape (Buzz Hunter bots)
      if ((url.searchParams.get('rank') || '').toLowerCase() === 'buzz') return j(res, 200, await buzzFeed(useMode, CHAIN_OF[dchain] || null, lim));
      return j(res, 200, await discover(m2, CHAIN_OF[dchain] || null, lim));
    }
    // /api/signals/buzz?mode=high&chain=solana&limit=12 — online presence / traffic board
    if (parts[0] === 'buzz') {
      const dchain = (url.searchParams.get('chain') || '').toLowerCase();
      const lim = Math.max(1, Math.min(40, Number(url.searchParams.get('limit')) || 12));
      return j(res, 200, await buzzFeed(useMode, CHAIN_OF[dchain] || null, lim));
    }
    // /api/signals/arb?mode=&chain=&limit= — live cross-DEX spread board
    if (parts[0] === 'arb') {
      const dchain = (url.searchParams.get('chain') || '').toLowerCase();
      const lim = Math.max(1, Math.min(25, Number(url.searchParams.get('limit')) || 12));
      return j(res, 200, await arbBoard(useMode, CHAIN_OF[dchain] || null, lim));
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
