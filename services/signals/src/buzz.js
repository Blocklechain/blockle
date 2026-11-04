// Blockle signals — ONLINE-PRESENCE ("buzz") feed for the trading bots.
//
// Answers one question for the bots: "which tokens is the internet piling into
// RIGHT NOW, and is that attention still converting into price?"  It gathers
// traffic/attention signals from free, keyless sources, merges them per
// chain:token, and scores three things:
//
//   attention 0–100  how much online presence/traffic the token has right now
//                    (search trending rank, trending-pool rank, unique buyers,
//                    paid promo boosts/profiles, watchlist users, sentiment).
//   velocity  0–100  how fast that attention is turning into price + volume
//                    (1h vs 24h volume acceleration, 5m/1h/6h price moves,
//                    buyer/seller balance), with a penalty for moves that look
//                    already-chased (blown-out 1h spikes).
//   quick     0–100  "quick immediate profit" potential = attention × velocity
//                    × exit feasibility (liquidity depth), ZERO when the safety
//                    gate fails. This is the ranking key for the Buzz Hunter.
//
// HONEST LIMITS (reported as `basis` in every row): Twitter/X, Telegram and
// Reddit engagement APIs are paid or blocked for servers, so social reach is a
// proxy: CoinGecko search-trending (what people are looking up), GeckoTerminal
// trending pools (what people are actually trading), DexScreener boosts/profiles
// (what projects are paying to promote), CoinGecko watchlist/sentiment counts.
// Attention is NOT a guarantee of profit — most spikes mean-revert. The bots keep
// their full safety gate, risk presets, allocation caps and the paper default.
//
// The scoring functions are PURE (deterministic for a given input) and exported
// for tests. Network gathering is separate and takes an injected `jget`.

export const SOURCES = ['coingeckoTrending', 'geckoTerminalTrending', 'dexscreenerBoosts', 'dexscreenerProfiles'];

// CoinGecko asset-platform id -> signals chain id.
const CG_PLATFORM = { ethereum: 'ethereum', 'binance-smart-chain': 'bsc', solana: 'solana' };
// CoinGecko native coin id -> wrapped token the bots can actually trade.
const CG_NATIVE = {
  ethereum: { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH' },
  binancecoin: { chain: 'bsc', token: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB' },
  solana: { chain: 'solana', token: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
};
// GeckoTerminal network id -> signals chain id (and back).
export const GT_NETWORK = { eth: 'ethereum', bsc: 'bsc', solana: 'solana' };
export const GT_OF_CHAIN = { ethereum: 'eth', bsc: 'bsc', solana: 'solana' };
// Base tokens that are quote/major assets — a "trending pool" whose base is one
// of these is really about its other side, so it is skipped.
const MAJORS = new Set(['WETH', 'ETH', 'WBNB', 'BNB', 'USDC', 'USDT', 'USDBC', 'DAI', 'WSOL', 'SOL', 'USD1', 'FDUSD', 'BUSD', 'WBTC', 'CBBTC']);

export const BASIS = 'search trending (CoinGecko) + trending pools & unique buyers (GeckoTerminal) + paid boosts/profiles (DexScreener) + watchlist/sentiment counts; NOT Twitter/Telegram/Reddit engagement (paid/blocked APIs)';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
// log-scaled 0..1 where `full` maps to 1.
const logn = (v, full) => (v == null || v <= 0 ? 0 : clamp(Math.log10(1 + v) / Math.log10(1 + full), 0, 1));

export function keyOf(chain, token) {
  const t = String(token || '');
  return chain + ':' + (chain === 'solana' ? t : t.toLowerCase());
}

// ---- pure scoring ----------------------------------------------------------

// sig: { searchRank, searchTotal, poolRank, poolTotal, buyers1h, buyers24h, boosts,
//        profile, watchlistUsers, sentimentUp }
export function attentionScore(sig) {
  const s = sig || {};
  let a = 0;
  if (s.searchRank != null && s.searchRank > 0) {                         // what people are LOOKING UP
    const total = Math.max(1, s.searchTotal || 15);
    a += 30 * (1 - (s.searchRank - 1) / total);
  }
  if (s.poolRank != null && s.poolRank > 0) {                             // what people are actually TRADING
    const total = Math.max(1, s.poolTotal || 20);
    a += 25 * (1 - (s.poolRank - 1) / total);
  }
  a += 20 * logn(num(s.buyers1h), 500);                                   // unique buyer traffic, last hour
  a += 10 * logn(num(s.buyers24h), 5000);                                 // unique buyer traffic, last day
  a += Math.min(8, (num(s.boosts) || 0) * 2) + (s.profile ? 3 : 0);       // paid promotion push (capped: it is bought)
  a += 4 * logn(num(s.watchlistUsers), 500000);                           // CoinGecko watchlists (established interest)
  if (s.sentimentUp != null) a += 3 * clamp((num(s.sentimentUp) - 50) / 50, -1, 1); // crowd sentiment ± 3
  return Math.round(clamp(a, 0, 100));
}

// sig: { vol1h, vol24h, chg5m, chg1h, chg6h, chg24h, buys1h, sells1h }
export function velocityScore(sig) {
  const s = sig || {};
  let v = 0;
  const vol1h = num(s.vol1h), vol24h = num(s.vol24h);
  if (vol1h != null && vol24h != null && vol24h > 0) {                    // volume ACCELERATION: 1h pace vs 24h pace
    const accel = (vol1h * 24) / vol24h;                                  // 1 = steady, 3 = three times the daily pace
    v += 30 * clamp((accel - 0.5) / 3, 0, 1);
  }
  const c5 = num(s.chg5m), c1 = num(s.chg1h), c6 = num(s.chg6h), c24 = num(s.chg24h);
  if (c5 != null) v += 15 * clamp(c5 / 5, -1, 1);                        // very fresh move (±5% full scale)
  if (c1 != null) v += 20 * clamp(c1 / 15, -1, 1);                       // last hour (±15%)
  if (c6 != null) v += 10 * clamp(c6 / 40, -1, 1);                       // last 6h (±40%)
  if (c24 != null) v += 5 * clamp(c24 / 100, -1, 1);                     // day (±100%)
  const b = num(s.buys1h), sl = num(s.sells1h);
  if (b != null && sl != null && b + sl > 0) v += 20 * clamp(((b / (b + sl)) - 0.5) / 0.3, -1, 1); // buyer dominance
  // Already-chased penalty: a > 60% one-hour spike is late to enter for a QUICK trade.
  if (c1 != null && c1 > 60) v -= Math.min(30, (c1 - 60) / 4);
  // Dumping penalty: attention with a falling price is exit liquidity, not entry.
  if (c1 != null && c1 < -10 && c5 != null && c5 < 0) v -= 10;
  return Math.round(clamp(v, 0, 100));
}

// Exit feasibility 0..1 from liquidity depth (can a small bot get in AND out fast).
export function feasibility(liquidityUsd) {
  const l = num(liquidityUsd);
  if (l == null) return 0.5;
  if (l < 5000) return 0.1;
  return clamp(0.3 + 0.7 * logn(l, 1_000_000), 0, 1);
}

export function quickScore({ attention, velocity, liquidityUsd, safe }) {
  if (safe === false) return 0;
  const a = clamp(num(attention) || 0, 0, 100), v = clamp(num(velocity) || 0, 0, 100);
  // Geometric blend: needs BOTH attention and velocity (attention alone is a
  // crowd watching; velocity alone is a move nobody is talking about).
  const core = Math.sqrt(a * v);
  return Math.round(clamp(core * feasibility(liquidityUsd), 0, 100));
}

// ---- merge -----------------------------------------------------------------
// Each source yields rows { chain, token, symbol?, name?, ...signal fields }.
// Rows for the same chain:token are merged (first non-null wins per field,
// numeric traffic fields take the max). Returns an array of candidates.
export function mergeSources(bySource) {
  const out = new Map();
  const add = (source, row) => {
    if (!row || !row.chain || !row.token) return;
    const k = keyOf(row.chain, row.token);
    let c = out.get(k);
    if (!c) { c = { chain: row.chain, token: row.token, symbol: null, name: null, sources: [], signals: {} }; out.set(k, c); }
    if (!c.sources.includes(source)) c.sources.push(source);
    if (!c.symbol && row.symbol) c.symbol = String(row.symbol).toUpperCase();
    if (!c.name && row.name) c.name = row.name;
    for (const [f, v] of Object.entries(row)) {
      if (['chain', 'token', 'symbol', 'name'].includes(f) || v == null) continue;
      const cur = c.signals[f];
      if (cur == null) c.signals[f] = v;
      else if (typeof v === 'number' && typeof cur === 'number' && ['buyers1h', 'buyers24h', 'boosts', 'vol1h', 'vol24h', 'buys1h', 'sells1h', 'liquidityUsd'].includes(f)) c.signals[f] = Math.max(cur, v);
      else if (f === 'searchRank' || f === 'poolRank') c.signals[f] = Math.min(cur, v); // best rank wins
    }
  };
  for (const [source, rows] of Object.entries(bySource || {})) for (const r of (rows || [])) add(source, r);
  return [...out.values()];
}

// ---- gatherers (network; `jget(url) -> json|null`) -------------------------

// CoinGecko /search/trending: the ~15 coins people searched for most in 24h.
// Needs a platforms lookup per coin (cached by the caller via `resolveCoin`).
export async function fetchCoinGeckoTrending(jget, resolveCoin) {
  const j = await jget('https://api.coingecko.com/api/v3/search/trending');
  const coins = (j && Array.isArray(j.coins)) ? j.coins.map((c) => c.item).filter(Boolean) : [];
  const total = coins.length || 15;
  const rows = [];
  let rank = 0;
  for (const c of coins) {
    rank += 1;
    const d = c.data || {};
    const chg24 = d.price_change_percentage_24h && num(d.price_change_percentage_24h.usd);
    const base = { symbol: c.symbol, name: c.name, searchRank: rank, searchTotal: total, chg24h: chg24 == null ? undefined : chg24, marketCapRank: c.market_cap_rank };
    const nat = CG_NATIVE[c.id];
    if (nat) { rows.push({ ...base, chain: nat.chain, token: nat.token, symbol: nat.symbol }); continue; }
    const info = resolveCoin ? await resolveCoin(c.id) : null; // { platforms, watchlistUsers, sentimentUp, chg1h }
    if (!info || !info.platforms) continue;
    for (const [plat, addr] of Object.entries(info.platforms)) {
      const chain = CG_PLATFORM[plat];
      if (!chain || !addr) continue;
      rows.push({ ...base, chain, token: addr, watchlistUsers: info.watchlistUsers, sentimentUp: info.sentimentUp, chg1h: info.chg1h == null ? undefined : info.chg1h });
    }
  }
  return rows;
}

// Parse one CoinGecko /coins/{id} payload to the bits we keep (pure).
export function parseCoinGeckoCoin(j) {
  if (!j || typeof j !== 'object') return null;
  const md = j.market_data || {};
  const c1 = md.price_change_percentage_1h_in_currency && num(md.price_change_percentage_1h_in_currency.usd);
  return {
    platforms: j.platforms && typeof j.platforms === 'object' ? j.platforms : {},
    watchlistUsers: num(j.watchlist_portfolio_users),
    sentimentUp: num(j.sentiment_votes_up_percentage),
    chg1h: c1 == null ? null : c1,
  };
}

// GeckoTerminal trending pools for one network (20 pools; buyers/volume/price
// change per window). `included` carries the base token symbol/address.
export async function fetchGeckoTerminalTrending(jget, network) {
  const j = await jget(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?include=base_token&page=1`);
  const chain = GT_NETWORK[network];
  if (!chain || !j || !Array.isArray(j.data)) return [];
  const tokens = new Map();
  for (const t of (j.included || [])) if (t && t.type === 'token' && t.attributes) tokens.set(t.id, t.attributes);
  const rows = [];
  const total = j.data.length || 20;
  let rank = 0;
  for (const p of j.data) {
    rank += 1;
    const a = p.attributes || {};
    const baseId = p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
    const tok = baseId ? tokens.get(baseId) : null;
    const address = (tok && tok.address) || (baseId ? baseId.split('_').slice(1).join('_') : null);
    if (!address) continue;
    const symbol = tok && tok.symbol ? String(tok.symbol).toUpperCase() : null;
    if (symbol && MAJORS.has(symbol)) continue;
    const tx = a.transactions || {};
    const vol = a.volume_usd || {};
    const pc = a.price_change_percentage || {};
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    rows.push({
      chain, token: address, symbol, name: tok && tok.name,
      poolRank: rank, poolTotal: total,
      buyers1h: num(tx.h1 && tx.h1.buyers), buyers24h: num(tx.h24 && tx.h24.buyers),
      buys1h: num(tx.h1 && tx.h1.buys), sells1h: num(tx.h1 && tx.h1.sells),
      vol1h: num(vol.h1), vol24h: num(vol.h24),
      chg5m: num(pc.m5), chg1h: num(pc.h1), chg6h: num(pc.h6), chg24h: num(pc.h24),
      liquidityUsd: num(a.reserve_in_usd), fdvUsd: num(a.fdv_usd),
      poolAgeSec: Number.isFinite(created) ? Math.max(0, Math.floor((Date.now() - created) / 1000)) : null,
      pool: a.address || null,
    });
  }
  return rows;
}

// DexScreener paid boosts (top + latest) and freshly-paid token profiles.
const DS_CHAIN = { solana: 'solana', ethereum: 'ethereum', bsc: 'bsc' };
function dsRows(arr, extra) {
  const rows = [];
  for (const b of (Array.isArray(arr) ? arr : [])) {
    const chain = DS_CHAIN[String(b.chainId || '').toLowerCase()];
    const token = b.tokenAddress || b.address;
    if (!chain || !token) continue;
    rows.push({ chain, token, ...extra(b) });
  }
  return rows;
}
export async function fetchDexscreenerBoosts(jget) {
  const [top, latest] = await Promise.all([
    jget('https://api.dexscreener.com/token-boosts/top/v1'),
    jget('https://api.dexscreener.com/token-boosts/latest/v1'),
  ]);
  const list = [...(Array.isArray(top) ? top : []), ...(Array.isArray(latest) ? latest : [])];
  return dsRows(list, (b) => ({ boosts: num(b.totalAmount) || num(b.amount) || 1 }));
}
export async function fetchDexscreenerProfiles(jget) {
  const j = await jget('https://api.dexscreener.com/token-profiles/latest/v1');
  return dsRows(j, () => ({ profile: true }));
}

// Everything above, merged. `resolveCoin(id)` is the caller's cached CoinGecko
// coin lookup; chains limits the GeckoTerminal networks fetched.
export async function gatherBuzz(jget, { resolveCoin, chains } = {}) {
  const nets = (chains && chains.length ? chains : Object.keys(GT_OF_CHAIN)).map((c) => GT_OF_CHAIN[c]).filter(Boolean);
  const safe = (p) => p.catch(() => []);
  const [cg, ...rest] = await Promise.all([
    safe(fetchCoinGeckoTrending(jget, resolveCoin)),
    ...nets.map((n) => safe(fetchGeckoTerminalTrending(jget, n))),
    safe(fetchDexscreenerBoosts(jget)),
    safe(fetchDexscreenerProfiles(jget)),
  ]);
  const gt = rest.slice(0, nets.length).flat();
  const [boosts, profiles] = rest.slice(nets.length);
  const bySource = { coingeckoTrending: cg, geckoTerminalTrending: gt, dexscreenerBoosts: boosts, dexscreenerProfiles: profiles };
  return { candidates: mergeSources(bySource), counts: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])) };
}

// Score one merged candidate against its (optional) safety report metrics.
export function scoreCandidate(c, report) {
  const s = c.signals || {};
  const m = (report && report.metrics) || {};
  const liq = s.liquidityUsd != null ? s.liquidityUsd : m.liquidityUsd;
  const attention = attentionScore(s);
  const velocity = velocityScore({
    vol1h: s.vol1h != null ? s.vol1h : m.volume1hUsd, vol24h: s.vol24h != null ? s.vol24h : m.volume24hUsd,
    chg5m: s.chg5m, chg1h: s.chg1h != null ? s.chg1h : m.priceChange1hPct, chg6h: s.chg6h,
    chg24h: s.chg24h != null ? s.chg24h : m.priceChange24hPct,
    buys1h: s.buys1h, sells1h: s.sells1h,
  });
  const safe = report ? report.safe === true : null;
  const quick = quickScore({ attention, velocity, liquidityUsd: liq, safe });
  return { attention, velocity, quick, feasibility: +feasibility(liq).toFixed(2), safe, basis: BASIS };
}
