// Honest paper backtest across THREE risk modes, using a FAST intraday strategy
// (hourly EMA crossover) for rapid daily returns. Real hourly prices from
// CoinGecko (90d → hourly on the free tier). $1000 paper per token, long-only.
// Output: backtest.json { modes: { safe, medium, high } } — every number real.
//
// Honesty: the high-risk (microcap) basket is survivorship-biased — it only
// contains tokens that still exist today; tokens that rugged/died in the window
// are not here. That is disclosed in the UI and in `.survivorshipNote`.

const MODES = {
  safe: {   // large-cap blue chips — the huge market caps are fine here
    label: 'Safe', risk: 'Large-cap · lower volatility',
    tokens: [['solana','solana','SOL'],['ethereum','ethereum','ETH'],['binancecoin','bsc','BNB'],['chainlink','ethereum','LINK'],['uniswap','ethereum','UNI'],['aave','ethereum','AAVE']],
    fast: 20, slow: 50, // slower crossover on the steadier names
  },
  medium: { // mid-caps — more movement, still established
    label: 'Medium', risk: 'Mid-cap · balanced',
    tokens: [['jupiter-exchange-solana','solana','JUP'],['raydium','solana','RAY'],['arbitrum','ethereum','ARB'],['optimism','ethereum','OP'],['injective-protocol','ethereum','INJ'],['sei-network','ethereum','SEI'],['pancakeswap-token','bsc','CAKE'],['pepe','ethereum','PEPE']],
    fast: 12, slow: 26,
  },
  high: {   // micro / meme caps — high risk, social-driven
    label: 'High risk', risk: 'Microcap · social-driven · degen',
    tokens: [['bonk','solana','BONK'],['dogwifcoin','solana','WIF'],['popcat','solana','POPCAT'],['cat-in-a-dogs-world','solana','MEW'],['based-brett','ethereum','BRETT'],['book-of-meme','solana','BOME'],['turbo','ethereum','TURBO'],['mog-coin','ethereum','MOG']],
    fast: 9, slow: 21, // fastest crossover — rapid in/out
  },
};
const START = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import fs from 'node:fs';
const CACHE = '/tmp/cg-cache';
try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}

async function hourly(id) {
  const cf = `${CACHE}/${id}.json`;
  try { const c = JSON.parse(fs.readFileSync(cf, 'utf8')); if (Array.isArray(c) && c.length > 60) return c; } catch {}
  // no `interval` → free tier returns hourly for 90d
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=90`;
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(9000); continue; }
      if (!r.ok) return null;
      const p = ((await r.json()).prices || []).map((x) => x[1]).filter(Number.isFinite);
      if (p.length > 60) { try { fs.writeFileSync(cf, JSON.stringify(p)); } catch {} return p; }
      return null;
    } catch { await sleep(3000); }
  }
  return null;
}

function ema(prices, n) {
  const k = 2 / (n + 1); const out = new Array(prices.length); let e = prices[0];
  for (let i = 0; i < prices.length; i++) { e = i ? prices[i] * k + e * (1 - k) : prices[i]; out[i] = e; }
  return out;
}

function backtest(prices, fastN, slowN) {
  // EMA crossover entries/exits, PLUS risk management: a trend filter (only go
  // long when price is above its long-term EMA — don't buy downtrends/chop) and
  // an 8% stop-loss (cut losers fast). Both are standard, disclosed components.
  const TREND = Math.min(prices.length - 2, slowN * 4);
  const STOP = 0.08;
  const f = ema(prices, fastN), s = ema(prices, slowN), tr = ema(prices, TREND);
  let cash = START, units = 0, inPos = false, entry = 0, trades = 0, wins = 0;
  let peak = START, maxDD = 0;
  for (let i = slowN; i < prices.length; i++) {
    const px = prices[i];
    const golden = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const death = f[i - 1] >= s[i - 1] && f[i] < s[i];
    const stopped = inPos && px <= entry * (1 - STOP);
    if (golden && !inPos && px > tr[i]) { units = cash / px; cash = 0; inPos = true; entry = px; }
    else if ((death || stopped) && inPos) { cash = units * px; units = 0; inPos = false; trades++; if (px > entry) wins++; }
    const eq = cash + units * px; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  const last = prices[prices.length - 1];
  if (inPos) { trades++; if (last > entry) wins++; }
  const end = cash + units * last;
  const hold = START * (last / prices[0]);
  return { start: START, end: +end.toFixed(2), ret: +((end / START - 1) * 100).toFixed(2), trades, wins, winRate: trades ? +((wins / trades) * 100).toFixed(1) : null, maxDDpct: +(maxDD * 100).toFixed(1), holdRet: +((last / prices[0] - 1) * 100).toFixed(2), holdEnd: +hold.toFixed(2) };
}

const out = { generatedAt: new Date().toISOString(), windowDays: 90, granularity: 'hourly', perTokenStart: START, modes: {} };
for (const [key, m] of Object.entries(MODES)) {
  const rows = [];
  for (const [id, chain, sym] of m.tokens) {
    const p = await hourly(id);
    if (!p) { console.error(`  skip ${sym}`); await sleep(2500); continue; }
    const r = backtest(p, m.fast, m.slow);
    rows.push({ sym, chain, ...r });
    console.error(`  ${m.label.padEnd(10)} ${sym.padEnd(6)} ${chain.padEnd(9)} $${r.start}->$${r.end} (${r.ret >= 0 ? '+' : ''}${r.ret}%) trades=${r.trades} win=${r.winRate}% DD=${r.maxDDpct}% hold=${r.holdRet}%`);
    await sleep(2800);
  }
  const n = rows.length, startTotal = n * START;
  const endTotal = +rows.reduce((s, r) => s + r.end, 0).toFixed(2);
  const holdTotal = +rows.reduce((s, r) => s + r.holdEnd, 0).toFixed(2);
  const trades = rows.reduce((s, r) => s + r.trades, 0), wins = rows.reduce((s, r) => s + r.wins, 0);
  const retPct = +((endTotal / startTotal - 1) * 100).toFixed(2);
  out.modes[key] = {
    label: m.label, risk: m.risk, strategy: `EMA ${m.fast}/${m.slow} crossover (hourly)`,
    tokens: n, chains: [...new Set(rows.map((r) => r.chain))],
    startAmount: startTotal, endAmount: endTotal, returnPct: retPct,
    avgDailyPct: +(retPct / 90).toFixed(3),
    winRatePct: trades ? +((wins / trades) * 100).toFixed(1) : null, trades,
    buyHoldEndAmount: holdTotal, buyHoldReturnPct: +((holdTotal / startTotal - 1) * 100).toFixed(2),
    best: rows.slice().sort((a, b) => b.ret - a.ret)[0], worst: rows.slice().sort((a, b) => a.ret - b.ret)[0],
    perToken: rows,
  };
  if (key === 'high') out.modes[key].survivorshipNote = 'Microcap basket is survivorship-biased — only tokens that survived the window are included; many microcaps rug or die. Treat as illustrative of behavior on volatile small-caps, not expected returns.';
}

// Sniper mode: brand-new launches only. There is NO honest historical backtest
// for this — tokens that are new by definition have no price history, and any
// that survived long enough to backtest are pure survivorship bias. So we ship
// it as live-only with a loud warning and NO fabricated return number.
out.modes.sniper = {
  label: 'Sniper', risk: 'Brand-new launches · maximum risk',
  strategy: 'New-listing sniper (live-only, paper by default)',
  noBacktest: true,
  chains: ['solana', 'ethereum', 'bsc'],
  watchlist: ['WIF', 'POPCAT', 'BOME', 'MEW', 'BRETT', 'TURBO', 'MOG', 'BONK', 'PEPE'],
  note: 'Brand-new tokens have no price history to backtest, and the ones that survive are survivorship bias — so there is NO honest historical return to show here. Sniper is live-only: it watches freshly-launched microcaps, buys only those that clear a relaxed rug/liquidity/holder gate, sizes tiny, and takes profit or stops out fast. Expect most positions to go to zero. Paper mode by default; real trading only after you set a budget and pass the gate.',
};
console.log(JSON.stringify(out, null, 2));
