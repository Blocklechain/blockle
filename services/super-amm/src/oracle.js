// oracle.js — USD price feed for the quote currencies (model B needs these to
// normalise every deposit into the single shared USD price curve).
//
// PAPER mode: static prices from config/env — deterministic, no network, used to
// prove the engine without real feeds. LIVE mode: refreshes from CoinGecko (free,
// no key) every `ttlMs`, falling back to the last good values on a fetch failure.
// Prices are returned as micro-USD per WHOLE unit (BigInt) to match the engine.
'use strict';

const COINGECKO_IDS = {
  SOL: 'solana', ETH: 'ethereum', BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin',
};
const STABLE = { USDC: 1_000_000n, USDT: 1_000_000n };

function createOracle(opts = {}) {
  const mode = opts.mode || 'paper';
  const ttlMs = opts.ttlMs || 60_000;
  // BLOCK's USD price is the AMM itself (not an external feed) — it is NOT oracled.
  let prices = { ...STABLE, ...(opts.static || {}) }; // micro-USD per whole unit
  let last = 0;

  async function refreshLive() {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('coingecko ' + r.status);
    const j = await r.json();
    const next = { ...STABLE };
    for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
      const usd = j[id] && j[id].usd;
      if (usd != null) next[sym] = BigInt(Math.round(Number(usd) * 1e6));
    }
    prices = { ...prices, ...next };
    last = Date.now();
  }

  return {
    mode,
    // snapshot map the engine consumes: { SYM: microUsdPerWhole }
    map() { return prices; },
    get(sym) { return prices[sym]; },
    async ensureFresh() {
      if (mode !== 'live') return;
      if (Date.now() - last < ttlMs) return;
      try { await refreshLive(); } catch (e) { /* keep last good */ }
    },
    set(sym, microUsd) { prices[sym] = BigInt(microUsd); }, // paper/admin override
  };
}

module.exports = { createOracle, COINGECKO_IDS };
