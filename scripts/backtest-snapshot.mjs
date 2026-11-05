// Writes a cached paper-BACKTEST of EVERY strategy over the last month, ranked most-profitable
// first, for the home-page "which strategy made the most money" board with one-click USE THIS
// STRATEGY. Runs the REAL bot simulator (services/accounts/src/bots.js — the same engine the
// wallet's paper bots use) on REAL historical hourly prices, identical budget + default params.
//
// HONEST: a paper backtest on real past prices, NOT a live account and NOT a guarantee. Output
// → /opt/blockle/web/backtest.json, refreshed by a systemd timer. Keeps the last good file if
// the price feed is unavailable.
import fs from 'node:fs';
import { newBot, step, BOT_TYPES, BOT_LABELS } from '../services/accounts/src/bots.js';

const OUT = process.env.BACKTEST_OUT || '/opt/blockle/web/backtest.json';
const ASSET = process.env.BACKTEST_ASSET || 'solana';   // CoinGecko id
const SYMBOL = process.env.BACKTEST_SYMBOL || 'SOL';
const BUDGET = Number(process.env.BACKTEST_BUDGET || 1000);
const CURVE_POINTS = 40;

// Real 30-day hourly prices (keyless). 1<days<=90 => hourly granularity.
async function fetchPrices() {
  const url = `https://api.coingecko.com/api/v3/coins/${ASSET}/market_chart?vs_currency=usd&days=30`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const prices = ((await r.json()).prices || []).map((p) => Number(p[1])).filter((n) => Number.isFinite(n) && n > 0);
        if (prices.length > 48) return prices;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

// Default params per strategy (the engine's own defaults; grid band from the window's range).
function paramsFor(type, series) {
  if (type === 'grid') return { lower: Math.min(...series), upper: Math.max(...series) };
  return {};
}

function runStrategy(type, series) {
  const bot = newBot({ id: type, uid: 'demo', type, pair: `${SYMBOL}/USD`, params: paramsFor(type, series), now: 0 });
  const values = [];
  for (const price of series) values.push(step(bot, price).value);
  const n = values.length;
  const curve = [];
  let peak = -Infinity, maxDd = 0;
  for (const v of values) { if (v > peak) peak = v; const dd = (peak - v) / peak * 100; if (dd > maxDd) maxDd = dd; }
  for (let i = 0; i < CURVE_POINTS; i++) {
    const idx = Math.min(n - 1, Math.round((i / (CURVE_POINTS - 1)) * (n - 1)));
    curve.push(Math.round(((values[idx] - BUDGET) / BUDGET) * 10000) / 100);
  }
  return {
    type, label: BOT_LABELS[type] || type, pnlPct: curve[curve.length - 1], trades: bot.state.trades.length,
    maxDrawdownPct: Math.round(maxDd * 100) / 100, curve, params: bot.params,
  };
}

async function main() {
  const prices = await fetchPrices();
  if (!prices) { console.error('price feed unavailable; keeping last backtest.json'); process.exit(0); }
  const assetMovePct = Math.round(((prices[prices.length - 1] - prices[0]) / prices[0]) * 10000) / 100;
  const strategies = BOT_TYPES.map((t) => runStrategy(t, prices)).sort((a, b) => b.pnlPct - a.pnlPct);
  for (const s of strategies) console.error(`${s.type.padEnd(11)} pnl=${String(s.pnlPct).padStart(7)}%  dd=${s.maxDrawdownPct}%  trades=${s.trades}`);
  const out = {
    generatedAt: new Date().toISOString(), asset: ASSET, symbol: SYMBOL, budget: BUDGET,
    windowLabel: '30 days', assetMovePct,
    source: `paper backtest of every strategy on real ${SYMBOL}/USD hourly prices over 30 days, identical $${BUDGET} budget + default params`,
    strategies,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.error(`wrote ${OUT} (${strategies.length} strategies, winner ${strategies[0].type} ${strategies[0].pnlPct}%)`);
}

main();
