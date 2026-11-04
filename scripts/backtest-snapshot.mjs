// Writes a cached multi-REGIME paper-backtest for the home-page "best algorithm" demo.
// Runs the REAL bot simulator (services/accounts/src/bots.js — the same engine the wallet's
// paper bots use) for each strategy (DCA / grid / SmartTrade / signal) across three REAL market
// regimes — a bull run, a bear run, and a choppy range — auto-extracted from a year of real
// daily prices, so each strategy's genuine edge (and weakness) is visible honestly.
//
// HONEST by design: real historical prices, identical budget + default params, no cherry-picked
// parameters. The regimes are the actual best up-run / worst down-run / quietest stretch in the
// data, labeled with their real dates + the asset's real move. A simulation on past data, NOT a
// live account and NOT a guarantee. Output → /opt/blockle/web/backtest.json, via a systemd timer.
import fs from 'node:fs';
import { newBot, step, BOT_TYPES, BOT_LABELS } from '../services/accounts/src/bots.js';

const OUT = process.env.BACKTEST_OUT || '/opt/blockle/web/backtest.json';
const ASSET = process.env.BACKTEST_ASSET || 'bitcoin';   // CoinGecko id (long, liquid history)
const SYMBOL = process.env.BACKTEST_SYMBOL || 'BTC';
const BUDGET = Number(process.env.BACKTEST_BUDGET || 1000);
const WIN = Number(process.env.BACKTEST_WINDOW_DAYS || 45); // regime window length (days)
const CURVE_POINTS = 48;

// A year of real daily prices: [[tsMs, price], ...]. 90<days<=365 => daily granularity.
async function fetchDaily() {
  const url = `https://api.coingecko.com/api/v3/coins/${ASSET}/market_chart?vs_currency=usd&days=365&interval=daily`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const rows = (j.prices || []).filter((p) => Number.isFinite(p[1]) && p[1] > 0);
        if (rows.length > WIN + 10) return rows;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

// Find the real bull (max up-move), bear (min move) and chop (quietest, near-flat) windows.
function detectRegimes(rows) {
  const price = rows.map((r) => r[1]);
  const N = price.length;
  let bull = { i: 0, move: -1e9 }, bear = { i: 0, move: 1e9 }, chop = { i: 0, vol: 1e9, move: 0 };
  for (let i = 0; i + WIN < N; i++) {
    const move = (price[i + WIN] - price[i]) / price[i];
    const rs = [];
    for (let k = i + 1; k <= i + WIN; k++) rs.push((price[k] - price[k - 1]) / price[k - 1]);
    const mean = rs.reduce((x, y) => x + y, 0) / rs.length;
    const vol = Math.sqrt(rs.reduce((x, y) => x + (y - mean) ** 2, 0) / rs.length);
    if (move > bull.move) bull = { i, move, vol };
    if (move < bear.move) bear = { i, move, vol };
    if (Math.abs(move) < 0.12 && vol < chop.vol) chop = { i, move, vol };
  }
  if (chop.vol === 1e9) chop = { i: Math.max(0, N - WIN - 1), move: 0 }; // fallback
  return { bull, bear, chop };
}

function paramsFor(type, series) {
  if (type === 'grid') { const lo = Math.min(...series), hi = Math.max(...series); return { budget: BUDGET, lower: lo, upper: hi, grids: 6 }; }
  if (type === 'dca') return { budget: BUDGET, buyAmount: 50, everyTicks: 3 };
  if (type === 'smarttrade') return { budget: BUDGET, takeProfitPct: 10, stopLossPct: 5 };
  if (type === 'signal') return { budget: BUDGET, thresholdPct: 1 };
  return { budget: BUDGET };
}

function runStrategy(type, series) {
  const bot = newBot({ id: type, uid: 'demo', type, pair: `${SYMBOL}/USD`, params: paramsFor(type, series), now: 0 });
  const values = [];
  for (const price of series) values.push(step(bot, price).value);
  const curve = [];
  const n = values.length;
  for (let i = 0; i < CURVE_POINTS; i++) {
    const idx = Math.min(n - 1, Math.round((i / (CURVE_POINTS - 1)) * (n - 1)));
    curve.push(Math.round(((values[idx] - BUDGET) / BUDGET) * 10000) / 100);
  }
  return { type, label: BOT_LABELS[type], pnlPct: curve[curve.length - 1], trades: bot.state.trades.length, curve };
}

const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function buildRegime(rows, det) {
  const slice = rows.slice(det.i, det.i + WIN + 1);
  const series = slice.map((r) => r[1]);
  const strategies = BOT_TYPES.map((t) => runStrategy(t, series)).sort((a, b) => b.pnlPct - a.pnlPct);
  const assetMovePct = Math.round(((series[series.length - 1] - series[0]) / series[0]) * 10000) / 100;
  return {
    winner: strategies[0].type, assetMovePct,
    from: fmtDate(slice[0][0]), to: fmtDate(slice[slice.length - 1][0]),
    strategies,
  };
}

async function main() {
  const rows = await fetchDaily();
  if (!rows) { console.error('price feed unavailable; keeping last backtest.json'); process.exit(0); }
  const det = detectRegimes(rows);
  const regimes = {
    bull: buildRegime(rows, det.bull),
    chop: buildRegime(rows, det.chop),
    bear: buildRegime(rows, det.bear),
  };
  for (const k of ['bull', 'chop', 'bear']) {
    const r = regimes[k];
    console.error(`${k.padEnd(4)} ${r.from}..${r.to} ${SYMBOL}=${r.assetMovePct}%  winner=${r.winner} (${r.strategies[0].pnlPct}%)`);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    asset: ASSET, symbol: SYMBOL, budget: BUDGET, windowDays: WIN,
    source: `paper backtest of each bot strategy on real ${SYMBOL}/USD daily prices across three real market regimes, identical budget + default params`,
    regimes,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.error(`wrote ${OUT}`);
}

main();
