// prices.js — server-side USD spot-price resolver + proxy for the wallet.
//
// The wallet POSTs a list of assets ({chain, symbol, kind, address?}) and gets
// back { prices: { <key>: usd } } keyed the SAME way the client keys them
// (priceKey): a token is "<chain>:<addrLower>", a native is
// "<chain>:native:<SYM>". We resolve server-side from DeFiLlama (one batched
// call: tokens by contract + natives by coingecko id) then fill gaps from
// CoinGecko, with a short in-memory cache so a burst of clients hits the
// upstreams at most once per TTL. Stablecoins pin to $1; BLOCK and every
// BLOCK-20 are NEVER priced (no BLOCK/USD oracle). Never fabricates: an asset
// we can't price is simply absent (no guessed 0).

const COINGECKO_IDS = {
  ETH: 'ethereum', BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin',
  BCH: 'bitcoin-cash', SOL: 'solana', TRX: 'tron', TON: 'the-open-network',
  XRP: 'ripple', XLM: 'stellar', XTZ: 'tezos', ADA: 'cardano', BNB: 'binancecoin',
  AVAX: 'avalanche-2', POL: 'matic-network', MATIC: 'matic-network', HYPE: 'hyperliquid',
};
const COINGECKO_PLATFORMS = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum', polygon: 'polygon-pos',
  bnb: 'binance-smart-chain', avalanche: 'avalanche', solana: 'solana', tron: 'tron',
};
const LLAMA_CHAINS = {
  ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism',
  polygon: 'polygon', bnb: 'bsc', avalanche: 'avax', solana: 'solana', tron: 'tron',
};
const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USD', 'USDBC', 'PYUSD', 'TUSD', 'FDUSD', 'USDP']);

const isNative = (a) => a.kind === 'native' || !a.address;
const priceKey = (a) =>
  a.address ? `${a.chain}:${String(a.address).toLowerCase()}` : `${a.chain}:native:${String(a.symbol || '').toUpperCase()}`;
const isBlock = (a) => String(a.chain || '').toLowerCase() === 'block';
const numOf = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function makePrices({ ttlMs = 60_000, fetchFn = fetch } = {}) {
  const cache = new Map(); // key -> { usd, at }
  const now = () => Date.now();

  async function getJson(url) {
    const r = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('upstream ' + r.status);
    return r.json();
  }

  async function fromLlama(pending) {
    const byId = {}; // llama id -> key
    for (const a of pending) {
      if (isNative(a)) {
        const cg = COINGECKO_IDS[String(a.symbol || '').toUpperCase()];
        if (cg) byId[`coingecko:${cg}`] = priceKey(a);
      } else {
        const lc = LLAMA_CHAINS[a.chain];
        if (lc) byId[`${lc}:${a.address}`] = priceKey(a);
      }
    }
    const ids = Object.keys(byId);
    if (!ids.length) return {};
    const out = {};
    const j = await getJson('https://coins.llama.fi/prices/current/' + ids.join(','));
    const coins = j && j.coins ? j.coins : {};
    const lcIndex = {};
    for (const [k, v] of Object.entries(byId)) lcIndex[k.toLowerCase()] = v;
    for (const [llamaKey, v] of Object.entries(coins)) {
      const usd = numOf(v && v.price);
      const key = byId[llamaKey] || lcIndex[llamaKey.toLowerCase()];
      if (usd && key) out[key] = usd;
    }
    return out;
  }

  async function fromCoingecko(pending) {
    const out = {};
    const keyById = {};
    const tokensByPlatform = {};
    for (const a of pending) {
      if (isNative(a)) {
        const id = COINGECKO_IDS[String(a.symbol || '').toUpperCase()];
        if (id) keyById[id] = priceKey(a);
      } else {
        const p = COINGECKO_PLATFORMS[a.chain];
        if (p) (tokensByPlatform[p] ||= {})[String(a.address).toLowerCase()] = priceKey(a);
      }
    }
    const ids = Object.keys(keyById);
    if (ids.length) {
      try {
        const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=' + ids.join(',') + '&vs_currencies=usd');
        for (const [id, v] of Object.entries(j || {})) {
          const usd = numOf(v && v.usd);
          if (usd && keyById[id]) out[keyById[id]] = usd;
        }
      } catch { /* best-effort */ }
    }
    for (const [platform, map] of Object.entries(tokensByPlatform)) {
      try {
        const j = await getJson('https://api.coingecko.com/api/v3/simple/token_price/' + platform + '?contract_addresses=' + Object.keys(map).join(',') + '&vs_currencies=usd');
        for (const [addr, v] of Object.entries(j || {})) {
          const usd = numOf(v && v.usd);
          const key = map[String(addr).toLowerCase()];
          if (usd && key) out[key] = usd;
        }
      } catch { /* best-effort */ }
    }
    return out;
  }

  // Resolve a list of {chain, symbol, kind, address?} to { key: usd }.
  async function resolve(assets) {
    const t = now();
    const out = {};
    const pending = [];
    for (const a of Array.isArray(assets) ? assets : []) {
      if (!a || isBlock(a)) continue; // never price BLOCK / BLOCK-20
      const key = priceKey(a);
      if (STABLES.has(String(a.symbol || '').toUpperCase())) { out[key] = 1; continue; }
      const c = cache.get(key);
      if (c && t - c.at < ttlMs) { out[key] = c.usd; continue; }
      pending.push(a);
    }
    if (!pending.length) return out;

    const run = async (fn) => {
      const left = pending.filter((a) => !(priceKey(a) in out));
      if (!left.length) return;
      try {
        const got = await fn(left);
        for (const [k, v] of Object.entries(got)) {
          if (numOf(v)) { out[k] = v; cache.set(k, { usd: v, at: t }); }
        }
      } catch { /* fall through to next source */ }
    };

    // DeFiLlama covers natives + tokens in one call; CoinGecko fills the rest.
    await run(fromLlama);
    await run(fromCoingecko);
    return out;
  }

  return { resolve, priceKey };
}
