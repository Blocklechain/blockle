// Quick on-demand backtest of a CONFIGURED strategy — powers the wallet's "test this config"
// button. Runs the real paper engine (bots.js) over recent REAL hourly prices (cached in memory
// so a tune-and-test loop is sub-second) and returns the P&L, trade count, max drawdown and an
// equity curve. Play-money simulation on past data — honest, never a guarantee.
import { newBot, step, BOT_TYPES } from './bots.js';

// Reference price feeds (CoinGecko ids) covering every supported chain's native asset. The paper
// engine is chain-agnostic (it runs on any price series), and LIVE bots route per chain through
// the wallet's venues — this map is just the backtest reference. BLOCK isn't on CoinGecko (its
// 30-day history comes from the chain explorer), so it falls back to SOL for the reference curve.
const ASSETS = {
  sol: 'solana', btc: 'bitcoin', eth: 'ethereum', base: 'ethereum', bnb: 'binancecoin',
  doge: 'dogecoin', ltc: 'litecoin', block: 'solana',
};
const CURVE_POINTS = 48;

export function makeBacktester(deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const ttlMs = deps.ttlMs || 10 * 60 * 1000;      // cache a price series for 10 min
  const now = deps.now || Date.now;
  const cache = new Map();                          // asset -> { at, prices }

  async function pricesFor(asset) {
    const id = ASSETS[asset] || ASSETS.sol;
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs) return hit.prices;
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30`;
    const r = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`price feed ${r.status}`);
    const prices = ((await r.json()).prices || []).map((p) => Number(p[1])).filter((n) => Number.isFinite(n) && n > 0);
    if (prices.length < 48) throw new Error('insufficient price history');
    cache.set(id, { at: now(), prices });
    return prices;
  }

  // { type, params, asset } -> backtest result. `params` are the user's knobs; grid auto-bands
  // from the window if the caller didn't set them.
  async function run({ type, params, asset }) {
    type = BOT_TYPES.includes(type) ? type : 'dca';
    const prices = await pricesFor(asset || 'sol');
    const p = { ...(params || {}) };
    if (type === 'grid' && !(p.upper > p.lower)) { p.lower = Math.min(...prices); p.upper = Math.max(...prices); }
    const bot = newBot({ id: 'bt', uid: 'bt', type, pair: `${(asset || 'SOL').toUpperCase()}/USD`, params: p, now: 0 });
    const budget = bot.params.budget;
    const values = [];
    for (const price of prices) values.push(step(bot, price).value);
    const n = values.length;
    let peak = -Infinity, maxDd = 0;
    for (const v of values) { if (v > peak) peak = v; const dd = (peak - v) / peak * 100; if (dd > maxDd) maxDd = dd; }
    const curve = [];
    for (let i = 0; i < CURVE_POINTS; i++) {
      const idx = Math.min(n - 1, Math.round((i / (CURVE_POINTS - 1)) * (n - 1)));
      curve.push(Math.round(((values[idx] - budget) / budget) * 10000) / 100);
    }
    // win rate across completed round-trips (each sell realizes the buys since the last flat).
    const sells = bot.state.trades.filter((t) => t.side === 'sell');
    const judged = sells.filter((t) => typeof t.win === 'boolean');
    const wins = judged.filter((t) => t.win).length;
    const winRatePct = judged.length ? Math.round((wins / judged.length) * 1000) / 10 : null;
    const assetMovePct = Math.round(((prices[prices.length - 1] - prices[0]) / prices[0]) * 10000) / 100;
    // vs buy-and-hold (HODL) over the same window — the honest baseline.
    const vsHodlPct = Math.round((curve[curve.length - 1] - assetMovePct) * 100) / 100;
    // Risk-adjusted return: mean / stddev of per-step portfolio returns (unitless,
    // not annualized — a comparable number across strategies on the same window).
    let sharpe = null;
    if (n > 2) {
      const rets = [];
      for (let i = 1; i < n; i++) if (values[i - 1] > 0) rets.push((values[i] - values[i - 1]) / values[i - 1]);
      if (rets.length > 1) {
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
        const sd = Math.sqrt(variance);
        if (sd > 0) sharpe = Math.round((mean / sd) * 100) / 100;
      }
    }
    return {
      type, asset: asset || 'sol', params: bot.params, budget,
      pnlPct: curve[curve.length - 1], trades: bot.state.trades.length, sells: sells.length,
      wins, winRatePct, sharpe, vsHodlPct,
      maxDrawdownPct: Math.round(maxDd * 100) / 100, assetMovePct, windowLabel: '30 days', curve,
    };
  }

  return { run, assets: () => Object.keys(ASSETS) };
}
