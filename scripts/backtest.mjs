// Honest paper backtest of the bot's momentum strategy over real 90-day history.
// Data: CoinGecko market_chart (daily closes). Strategy: SMA(short/long) crossover,
// long-only, the same golden/death-cross logic the live momentum strategy uses.
// Per token: start $1000 paper → end value (liquidated at last close). Reports
// start/end amounts, return %, trades, win rate; aggregate + buy&hold comparison.

const BASKET = [
  // id (CoinGecko), chain, symbol
  ['solana', 'solana', 'SOL'],
  ['jupiter-exchange-solana', 'solana', 'JUP'],
  ['bonk', 'solana', 'BONK'],
  ['raydium', 'solana', 'RAY'],
  ['jito-governance-token', 'solana', 'JTO'],
  ['ethereum', 'ethereum', 'ETH'],
  ['chainlink', 'ethereum', 'LINK'],
  ['uniswap', 'ethereum', 'UNI'],
  ['pepe', 'ethereum', 'PEPE'],
  ['aave', 'ethereum', 'AAVE'],
  ['binancecoin', 'bsc', 'BNB'],
  ['pancakeswap-token', 'bsc', 'CAKE'],
  ['trust-wallet-token', 'bsc', 'TWT'],
];
const DAYS = 90, SHORT = 5, LONG = 20, START = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function history(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${DAYS}&interval=daily`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(8000); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const p = (j.prices || []).map((x) => x[1]).filter(Number.isFinite);
      return p.length > LONG + 2 ? p : null;
    } catch { await sleep(3000); }
  }
  return null;
}
const sma = (arr, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k]; return s / n; };

function backtest(prices) {
  let cash = START, units = 0, inPos = false, entry = 0, trades = 0, wins = 0;
  for (let i = 1; i < prices.length; i++) {
    const sPrev = sma(prices, i - 1, SHORT), lPrev = sma(prices, i - 1, LONG);
    const sNow = sma(prices, i, SHORT), lNow = sma(prices, i, LONG);
    if (sPrev == null || lPrev == null || sNow == null || lNow == null) continue;
    const golden = sPrev <= lPrev && sNow > lNow;
    const death = sPrev >= lPrev && sNow < lNow;
    const px = prices[i];
    if (golden && !inPos) { units = cash / px; cash = 0; inPos = true; entry = px; }
    else if (death && inPos) { cash = units * px; units = 0; inPos = false; trades++; if (px > entry) wins++; }
  }
  const last = prices[prices.length - 1];
  const end = cash + units * last;
  if (inPos) { trades++; if (last > entry) wins++; } // count the open round-trip at liquidation
  const hold = START * (last / prices[0]);
  return { start: START, end: +end.toFixed(2), ret: +((end / START - 1) * 100).toFixed(2), trades, wins, winRate: trades ? +((wins / trades) * 100).toFixed(1) : null, holdEnd: +hold.toFixed(2), holdRet: +((last / prices[0] - 1) * 100).toFixed(2) };
}

const rows = [];
for (const [id, chain, sym] of BASKET) {
  const p = await history(id);
  if (!p) { console.error(`skip ${sym} (no data)`); await sleep(2500); continue; }
  const r = backtest(p);
  rows.push({ sym, chain, ...r });
  console.error(`${sym.padEnd(5)} ${chain.padEnd(9)} start $${r.start} -> end $${r.end} (${r.ret >= 0 ? '+' : ''}${r.ret}%)  trades=${r.trades} win=${r.winRate}%  hold ${r.holdRet}%`);
  await sleep(2500);
}
const n = rows.length;
const startTotal = n * START;
const endTotal = +rows.reduce((s, r) => s + r.end, 0).toFixed(2);
const holdTotal = +rows.reduce((s, r) => s + r.holdEnd, 0).toFixed(2);
const tradesTotal = rows.reduce((s, r) => s + r.trades, 0);
const winsTotal = rows.reduce((s, r) => s + r.wins, 0);
const out = {
  generatedAt: new Date().toISOString(),
  method: `Momentum SMA ${SHORT}/${LONG} crossover, long-only, paper. ${DAYS}-day daily closes (CoinGecko). $${START} per token.`,
  tokens: n,
  chains: [...new Set(rows.map((r) => r.chain))],
  startAmount: startTotal,
  endAmount: endTotal,
  returnPct: +((endTotal / startTotal - 1) * 100).toFixed(2),
  winRatePct: tradesTotal ? +((winsTotal / tradesTotal) * 100).toFixed(1) : null,
  trades: tradesTotal,
  buyHoldEndAmount: holdTotal,
  buyHoldReturnPct: +((holdTotal / startTotal - 1) * 100).toFixed(2),
  best: rows.slice().sort((a, b) => b.ret - a.ret)[0],
  worst: rows.slice().sort((a, b) => a.ret - b.ret)[0],
  perToken: rows,
};
console.log(JSON.stringify(out, null, 2));
