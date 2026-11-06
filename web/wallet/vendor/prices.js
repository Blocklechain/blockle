// prices.js — the wallet's PRICE FEED. One keyless, cached, multi-source USD
// price oracle for everything the wallet can hold or trade:
//
//   • stablecoins                 → $1 (USDC/USDT/DAI/USDB/…)
//   • BLOCK                        → USDB/BLOCK AMM pool when one exists, else the
//                                    primary-sale curve snapshot (/api/buy/history)
//   • BLOCK-20 tokens              → native AMM pool reserves × BLOCK/USD
//   • native coins + blue chips    → CoinGecko simple/price (no key)
//   • any EVM/SPL token by address → DexScreener tokens/v1 (no key), Jupiter
//                                    lite price for Solana as a second source
//
// The in-wallet signals proxy (/api/signals/prices) is tried FIRST so one shared
// server cache serves every wallet; every direct provider is a fallback. A price
// is NEVER fabricated: unknown symbols are simply absent from the result, and the
// bot engine then audits `skipped: price` instead of trading on a guess.
//
// Symbols are resolved to on-chain ids through `remember(symbol, ref)` — the
// discovery feed, auto-import and the registry register what they know, so a bot
// pair like "GATO/SOL" prices by mint rather than by an ambiguous ticker.
//
// Global `PriceFeed`; module.exports for tests (fetch is injectable).
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const Lists = inNode ? require('./chains/token-lists.js') : global.TokenLists;

  const STABLES = { USDC: 1, USDT: 1, DAI: 1, USD: 1, USDB: 1, USDBC: 1, PYUSD: 1, FDUSD: 1, TUSD: 1, BUSD: 1, USDE: 1, FRAX: 1, LUSD: 1, GUSD: 1, USDP: 1, USDS: 1, 'USDC.E': 1, 'USDT.E': 1, 'DAI.E': 1, CUSD: 1 };
  const COINGECKO = 'https://api.coingecko.com/api/v3';
  const DEXSCREENER = 'https://api.dexscreener.com';
  const JUPITER = 'https://lite-api.jup.ag';

  function up(s) { return String(s == null ? '' : s).toUpperCase(); }
  function lc(s) { return String(s == null ? '' : s).toLowerCase(); }
  function isAddr(s) { return /^0x[0-9a-fA-F]{40}$/.test(s) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^[0-9a-f]{64}$/i.test(s); }

  // ---- BLOCK-denominated guard ---------------------------------------------
  // There is NO BLOCK/USD oracle. The native BLOCK coin, every BLOCK-20 /
  // BLOCK-20S token (all chain:'block', INCLUDING the USD-pegged USDB), and the
  // Solana wrap WBLOCK (whose only price source is blockUsd()) must NEVER be
  // emitted as a USD figure derived from a BLOCK price — the one place USD is
  // actually synthesized from BLOCK. blockUsd()/block20Usd() are KEPT (they still
  // price BLOCK-denominated tokens in BLOCK), they are just no longer surfaced as
  // USD by prices()/priceOf(). USDB falls here too → shown in USDB units, never a
  // fabricated BLOCK-derived USD (STABLES still carries USDB=1 for the internal
  // stable-pool math inside blockUsd(), which is not a displayed value).
  function isBlockDenominated(asset) {
    if (!asset) return false;
    if (typeof asset === 'string') { const s = up(asset); return s === 'BLOCK' || s === 'WBLOCK'; }
    if (lc(asset.chain) === 'block') return true;
    const s = up(asset.symbol);
    return s === 'BLOCK' || s === 'WBLOCK';
  }

  function create(opts) {
    opts = opts || {};
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(global) : null);
    const cacheMs = opts.cacheMs != null ? Number(opts.cacheMs) : 60000;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const proxyUrl = opts.proxyUrl === undefined ? '/api/signals/prices' : opts.proxyUrl; // null disables
    const blockApi = opts.blockApi || '';          // '' = same-origin relative paths
    const timeoutMs = opts.timeoutMs || 9000;

    const cache = new Map();      // key -> { v, at }
    const inflight = new Map();   // key -> Promise
    const tokenMap = new Map();   // SYMBOL -> { chain, address, decimals, name }
    const byAddr = new Map();     // chain:addr -> SYMBOL
    const change = new Map();     // SYMBOL -> 24h change pct (when known)

    // seed the symbol map with the well-known lists so tickers resolve by address.
    try {
      for (const id of (Lists ? Lists.chains() : [])) for (const t of Lists.forChain(id)) remember(t.symbol, t, true);
    } catch (_) {}

    function remember(symbol, ref, soft) {
      const sym = up(symbol);
      if (!sym || !ref) return;
      const address = ref.address || ref.mint || ref.contract || ref.id || ref.token;
      if (!address || !ref.chain) return;
      // a hard registration (discovery / holdings) wins over the seed list.
      if (soft && tokenMap.has(sym)) return;
      const entry = { chain: lc(ref.chain), address: String(address), decimals: ref.decimals != null ? Number(ref.decimals) : null, name: ref.name || null, soft: !!soft };
      tokenMap.set(sym, entry);
      byAddr.set(entry.chain + ':' + lc(entry.address), sym);
    }
    function lookup(symbol) { return tokenMap.get(up(symbol)) || null; }
    function decimalsOf(symbol) {
      const t = tokenMap.get(up(symbol));
      if (t && t.decimals != null) return t.decimals;
      const n = Lists && Lists.NATIVE ? Object.values(Lists.NATIVE).find((x) => x.symbol === up(symbol)) : null;
      return n ? n.decimals : null;
    }

    function cget(key) { const c = cache.get(key); return c && (now() - c.at) < cacheMs ? c.v : undefined; }
    function cset(key, v) { cache.set(key, { v, at: now() }); return v; }
    function dedupe(key, fn) {
      const hit = cget(key); if (hit !== undefined) return Promise.resolve(hit);
      if (inflight.has(key)) return inflight.get(key);
      const p = Promise.resolve().then(fn).then((v) => { inflight.delete(key); return cset(key, v); }, (e) => { inflight.delete(key); throw e; });
      inflight.set(key, p); return p;
    }

    async function jget(url, init) {
      if (!fetchImpl) throw new Error('no fetch');
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const r = await fetchImpl(url, Object.assign({ headers: { accept: 'application/json' } }, init || {}, ctrl ? { signal: ctrl.signal } : {}));
        if (!r.ok) throw new Error('http ' + r.status);
        return await r.json();
      } finally { if (t) clearTimeout(t); }
    }

    // ---- BLOCK / USD ---------------------------------------------------------
    async function blockUsd() {
      return dedupe('block:usd', async () => {
        // 1) a USDB (or any $1-stable) pool on the native AMM is the live market
        try {
          const pools = await pools_();
          const p = pools.find((x) => STABLES[up(x.symbol)] != null && Number(x.blockReserve) > 0 && Number(x.tokenReserve) > 0);
          if (p) {
            const dec = Number(p.decimals != null ? p.decimals : 6);
            const blk = Number(p.blockReserve) / 1e8, tok = Number(p.tokenReserve) / Math.pow(10, dec);
            if (blk > 0 && tok > 0) return tok / blk;
          }
        } catch (_) {}
        // 2) the primary-sale curve's latest snapshot
        try {
          const hist = await jget(blockApi + '/api/buy/history');
          const last = Array.isArray(hist) && hist.length ? hist[hist.length - 1] : null;
          const v = last && Number(last.price);
          if (v > 0) return v;
        } catch (_) {}
        return null;
      });
    }
    async function pools_() {
      return dedupe('block:pools', async () => {
        const j = await jget(blockApi + '/api/dex/pools');
        return (j && j.pools) || [];
      });
    }
    // BLOCK-20 token price (USD) by contract id, via its AMM pool.
    async function block20Usd(contract) {
      const pools = await pools_();
      const p = pools.find((x) => lc(x.token) === lc(contract));
      if (!p || !(Number(p.tokenReserve) > 0)) return null;
      const dec = Number(p.decimals != null ? p.decimals : 8);
      const priceBlock = (Number(p.blockReserve) / 1e8) / (Number(p.tokenReserve) / Math.pow(10, dec));
      const b = await blockUsd();
      return (b != null && priceBlock > 0) ? priceBlock * b : null;
    }

    // ---- providers ---------------------------------------------------------
    async function coingecko(ids) {
      if (!ids.length) return {};
      const key = 'cg:' + ids.slice().sort().join(',');
      return dedupe(key, async () => {
        const j = await jget(COINGECKO + '/simple/price?ids=' + encodeURIComponent(ids.join(',')) + '&vs_currencies=usd&include_24hr_change=true');
        const out = {};
        for (const id of Object.keys(j || {})) { const v = j[id] && Number(j[id].usd); if (v > 0) out[id] = { usd: v, change24h: j[id].usd_24h_change }; }
        return out;
      });
    }
    // DexScreener: best (deepest) pair per base token → { addrLower: {priceUsd, symbol, name, liquidityUsd, change24h, ...} }
    async function dexscreener(chainId, addrs) {
      const ds = Lists ? Lists.dexscreenerChain(chainId) : null;
      if (!ds || !addrs.length) return {};
      const out = {};
      for (let i = 0; i < addrs.length; i += 30) {
        const slice = addrs.slice(i, i + 30);
        const key = 'ds:' + ds + ':' + slice.map(lc).sort().join(',');
        const part = await dedupe(key, async () => {
          const j = await jget(DEXSCREENER + '/tokens/v1/' + ds + '/' + slice.join(','));
          const best = {};
          for (const p of (Array.isArray(j) ? j : [])) {
            const base = p && p.baseToken && lc(p.baseToken.address);
            if (!base || !slice.some((a) => lc(a) === base)) continue;
            const liq = Number(p.liquidity && p.liquidity.usd) || 0;
            const price = Number(p.priceUsd);
            if (!(price > 0)) continue;
            if (!best[base] || liq > best[base].liquidityUsd) {
              best[base] = {
                priceUsd: price, liquidityUsd: liq, symbol: p.baseToken.symbol || null, name: p.baseToken.name || null,
                change24h: p.priceChange && Number(p.priceChange.h24), change1h: p.priceChange && Number(p.priceChange.h1),
                volume24hUsd: p.volume && Number(p.volume.h24), marketCapUsd: Number(p.marketCap) || null, fdvUsd: Number(p.fdv) || null,
                dex: p.dexId || null, pair: p.pairAddress || null, logo: (p.info && p.info.imageUrl) || null, createdAt: p.pairCreatedAt || null,
              };
            }
          }
          return best;
        }).catch(() => ({}));
        Object.assign(out, part);
      }
      return out;
    }
    async function jupiter(mints) {
      if (!mints.length) return {};
      const key = 'jup:' + mints.slice().sort().join(',');
      return dedupe(key, async () => {
        const j = await jget(JUPITER + '/price/v3?ids=' + encodeURIComponent(mints.join(',')));
        const out = {};
        for (const m of Object.keys(j || {})) { const v = j[m] && Number(j[m].usdPrice); if (v > 0) out[m] = { usd: v, change24h: j[m].priceChange24h, decimals: j[m].decimals }; }
        return out;
      }).catch(() => ({}));
    }
    // shared server cache (one call for everything); null → not available.
    async function proxy(symbols, tokens) {
      if (!proxyUrl) return null;
      const qs = [];
      if (symbols.length) qs.push('symbols=' + encodeURIComponent(symbols.join(',')));
      if (tokens.length) qs.push('tokens=' + encodeURIComponent(tokens.join(',')));
      if (!qs.length) return null;
      const key = 'proxy:' + qs.join('&');
      return dedupe(key, async () => { try { return await jget(proxyUrl + '?' + qs.join('&')); } catch (_) { return null; } });
    }

    // ---- the main entry: prices(symbols) → { SYM: usd } ----------------------
    async function prices(symbols) {
      const want = Array.from(new Set((symbols || []).map(up).filter(Boolean)));
      const out = {};
      const needCg = [], cgOf = {};
      const needTok = {};   // chain -> [addr]
      const tokSym = {};    // chain:addrLower -> SYM

      for (const s of want) {
        const t = tokenMap.get(s);
        // NO BLOCK/USD oracle — never emit a USD figure for BLOCK / WBLOCK / any
        // BLOCK-20/BLOCK-20S (incl. USDB). They render in BLOCK units; the UI
        // prices them via blockUsd()/block20Usd() in BLOCK terms, not here.
        if (isBlockDenominated({ symbol: s, chain: t && t.chain })) continue;
        if (STABLES[s] != null) { out[s] = STABLES[s]; continue; }
        const cg = Lists ? Lists.coingeckoId(s) : null;
        // a ticker with a CoinGecko id that is only SOFT-registered (seed list,
        // e.g. the bridged ETH on BNB Chain) prices as the major it names; a HARD
        // registration (discovery / holdings) prices by its on-chain address.
        if (t && t.chain && t.address && !(t.soft && cg)) {
          (needTok[t.chain] = needTok[t.chain] || []).push(t.address);
          tokSym[t.chain + ':' + lc(t.address)] = s;
          continue;
        }
        if (cg) { needCg.push(cg); cgOf[s] = cg; }
      }

      const jobs = [];
      // (BLOCK / WBLOCK / BLOCK-20 are intentionally omitted — no BLOCK/USD oracle.)

      // the shared proxy first (one round-trip), then direct providers for gaps.
      const tokList = [];
      for (const chain of Object.keys(needTok)) for (const a of needTok[chain]) tokList.push(chain + ':' + a);
      const symList = Object.keys(cgOf);
      const px = await proxy(symList, tokList).catch(() => null);
      if (px) {
        for (const s of symList) { const v = px.prices && Number(px.prices[s]); if (v > 0) { out[s] = v; if (px.change && px.change[s] != null) change.set(s, Number(px.change[s])); } }
        for (const k of tokList) {
          const row = px.tokens && px.tokens[k];
          const v = row && Number(row.priceUsd);
          const [chain, addr] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
          const sym = tokSym[chain + ':' + lc(addr)];
          if (v > 0 && sym) { out[sym] = v; if (row.change24h != null) change.set(sym, Number(row.change24h)); }
        }
      }
      const cgMissing = Array.from(new Set(symList.filter((s) => out[s] == null).map((s) => cgOf[s])));
      if (cgMissing.length) jobs.push(coingecko(cgMissing).then((m) => {
        for (const s of symList) { const r = m[cgOf[s]]; if (r && r.usd > 0 && out[s] == null) { out[s] = r.usd; if (r.change24h != null) change.set(s, Number(r.change24h)); } }
      }).catch(() => {}));
      for (const chain of Object.keys(needTok)) {
        const missing = needTok[chain].filter((a) => out[tokSym[chain + ':' + lc(a)]] == null);
        if (!missing.length) continue;
        jobs.push(dexscreener(chain, missing).then(async (m) => {
          for (const a of missing) {
            const sym = tokSym[chain + ':' + lc(a)];
            const r = m[lc(a)];
            if (r && r.priceUsd > 0) { out[sym] = r.priceUsd; if (r.change24h != null) change.set(sym, Number(r.change24h)); }
          }
          if (chain === 'solana') {
            const still = missing.filter((a) => out[tokSym[chain + ':' + lc(a)]] == null);
            if (still.length) { const jm = await jupiter(still); for (const a of still) { const r = jm[a]; if (r && r.usd > 0) out[tokSym[chain + ':' + lc(a)]] = r.usd; } }
          }
        }).catch(() => {}));
      }
      await Promise.all(jobs);
      return out;
    }

    // Price of ONE asset ref: a symbol string, or {chain, address|mint|contract, symbol}.
    async function priceOf(asset) {
      if (!asset) return null;
      if (typeof asset === 'string') {
        if (isAddr(asset)) { for (const [k, sym] of byAddr) if (k.endsWith(':' + lc(asset))) { asset = sym; break; } }
        if (isBlockDenominated(asset)) return null; // no BLOCK/USD oracle
        const m = await prices([asset]);
        return m[up(asset)] != null ? m[up(asset)] : null;
      }
      // NO BLOCK/USD oracle — block-denominated assets (BLOCK, WBLOCK, every
      // BLOCK-20/BLOCK-20S incl. USDB) are never priced in USD. This runs BEFORE
      // the STABLES=1 shortcut so USDB is shown in USDB units, not a $1 figure.
      if (isBlockDenominated(asset)) return null;
      const sym = up(asset.symbol);
      if (sym && STABLES[sym] != null) return 1;
      if (asset.stablecoin) return 1;
      const chain = lc(asset.chain);
      const addr = asset.address || asset.mint || asset.contract || asset.id;
      if (chain === 'block' && addr && !asset.native) { const v = await block20Usd(addr); if (v != null) return v; }
      if (addr && chain && chain !== 'block') {
        // register so the symbol resolves next time, then price by address.
        if (sym) remember(sym, Object.assign({ chain }, asset));
        const m = await dexscreener(chain, [addr]);
        const r = m[lc(addr)];
        if (r && r.priceUsd > 0) return r.priceUsd;
        if (chain === 'solana') { const jm = await jupiter([addr]); if (jm[addr]) return jm[addr].usd; }
      }
      if (!sym) return null;
      const m = await prices([sym]);
      return m[sym] != null ? m[sym] : null;
    }

    // Token METADATA by address (symbol/name/logo/liquidity/price) — used by auto-import
    // to label discovered tokens and by the Moon/bots UIs. { addrLower: meta }.
    async function tokenMeta(chain, addrs) {
      const list = Array.from(new Set((addrs || []).filter(Boolean)));
      if (!list.length) return {};
      if (lc(chain) === 'block') return {};
      const m = await dexscreener(chain, list);
      if (lc(chain) === 'solana') {
        const missing = list.filter((a) => !m[lc(a)]);
        if (missing.length) {
          for (const mint of missing.slice(0, 10)) {
            try {
              const j = await dedupe('jupmeta:' + mint, () => jget(JUPITER + '/tokens/v2/search?query=' + encodeURIComponent(mint)));
              const row = Array.isArray(j) ? j.find((x) => x.id === mint) : null;
              if (row) m[lc(mint)] = { symbol: row.symbol, name: row.name, logo: row.icon || null, decimals: row.decimals, priceUsd: Number(row.usdPrice) || null, liquidityUsd: Number(row.liquidity) || null };
            } catch (_) {}
          }
        }
      }
      return m;
    }

    function change24h(symbol) { const v = change.get(up(symbol)); return v == null ? null : v; }
    function clear() { cache.clear(); inflight.clear(); }

    return { prices, priceOf, blockUsd, block20Usd, tokenMeta, remember, lookup, decimalsOf, change24h, clear, STABLES, isBlockDenominated, _tokenMap: tokenMap };
  }

  const API = { create, STABLES };
  global.PriceFeed = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
