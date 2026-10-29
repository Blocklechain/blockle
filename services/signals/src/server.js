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
  return {
    priceUsd: Number(p.priceUsd) || null,
    liquidityUsd: Number(p.liquidity?.usd) || 0,
    marketCapUsd: Number(p.marketCap || p.fdv) || null,
    fdvUsd: Number(p.fdv) || null,
    volume24hUsd: Number(p.volume?.h24) || 0,
    priceChange24hPct: Number(p.priceChange?.h24) || 0,
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

// --- unify + gate + score ----------------------------------------------------
function assess(chain, token, m) {
  const flags = [];
  // Hard safety gate.
  if (chain === 'block') {
    if (!m.hasPool) flags.push('no-liquidity-pool');
    else if (!m.liquidityLocked) flags.push('lp-unlocked');
  } else {
    if ((m.liquidityUsd || 0) < CFG.minLiquidityUsd) flags.push('low-liquidity');
    if (m.ageSec != null && m.ageSec < CFG.minAgeSec) flags.push('too-new');
    if (m.honeypot) flags.push('honeypot');
    if (m.sellTaxPct != null && m.sellTaxPct > CFG.maxSellTaxPct) flags.push('high-sell-tax');
    if (m.topHolderPct != null && m.topHolderPct > CFG.maxTopHolderPct) flags.push('holder-concentration');
    if (m.top10Pct != null && m.top10Pct > CFG.maxTop10Pct) flags.push('top10-concentration');
    if (m.holders != null && m.holders < CFG.minHolders) flags.push('few-holders');
    if (chain === 'solana') {
      if (m.mintRenounced === false) flags.push('mint-not-renounced');
      if (m.lpLockedPct != null && m.lpLockedPct < 50) flags.push('lp-unlocked');
    }
    if ((chain === 'ethereum' || chain === 'bsc')) {
      if (m.lpLockedPct != null && m.lpLockedPct < 50) flags.push('lp-unlocked');
      if (m.mintable) flags.push('mintable');
    }
  }
  const hardFail = flags.some((f) => ['no-liquidity-pool', 'honeypot', 'lp-unlocked', 'holder-concentration', 'top10-concentration', 'mintable'].includes(f));
  const safe = !hardFail;

  // Profit-oriented 0–100 score (only meaningful when safe).
  let score = 0;
  const liq = m.liquidityUsd ?? (m.liquidityBlock ? m.liquidityBlock * 1000 : 0); // rough BLOCK→proxy
  score += Math.min(25, Math.log10(Math.max(1, liq)) / Math.log10(1e7) * 25);      // liquidity depth
  score += Math.min(20, Math.log10(Math.max(1, m.volume24hUsd || 0)) / Math.log10(1e6) * 20); // popularity (volume)
  if (m.holders != null) score += Math.min(15, Math.log10(Math.max(1, m.holders)) / Math.log10(5000) * 15); // holder base
  else score += 7;                                                                 // unknown → neutral
  const mcap = m.marketCapUsd || 0;
  if (mcap > 0) {                                                                   // favor the growth sweet-spot
    score += (mcap >= CFG.mcapSweetLowUsd && mcap <= CFG.mcapSweetHighUsd) ? 20 : 8;
  } else score += 8;
  score += Math.max(0, Math.min(15, (m.priceChange24hPct || 0) / 2));              // upward momentum (capped)
  if (m.ageSec != null) score += Math.min(5, m.ageSec / (7 * 86400) * 5);          // survival/age
  else if (m.ageBlocks != null) score += Math.min(5, m.ageBlocks / 1008 * 5);
  if (m.topHolderPct != null) score -= Math.max(0, (m.topHolderPct - 10) / 2);     // concentration penalty
  score = Math.max(0, Math.min(100, Math.round(score)));
  if (!safe) score = 0;

  return { chain, token, safe, score, flags, metrics: m, assessedAt: now() };
}

async function report(chain, token) {
  const key = `${chain}:${token}`;
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
  return put(key, assess(chain, token, m));
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
    if (parts[0] === 'health' || url.pathname === '/api/signals/health') return j(res, 200, { ok: true, chains: SUPPORTED });
    if (parts[0] === 'config') return j(res, 200, { chains: SUPPORTED, thresholds: CFG });
    // /api/signals/:chain/token/:id
    const chain = (parts[0] || '').toLowerCase();
    if (!SUPPORTED.includes(chain)) return j(res, 400, { error: 'unsupported chain', supported: SUPPORTED });
    if (parts[1] === 'token' && parts[2]) return j(res, 200, await report(chain, parts[2]));
    return j(res, 404, { error: 'not found — use /api/signals/<chain>/token/<address>' });
  } catch (e) {
    return j(res, 500, { error: (e && e.message) || String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[signals] on 127.0.0.1:${PORT} chains=${SUPPORTED.join(',')} sol_rpc=${SOL_RPC}`));
