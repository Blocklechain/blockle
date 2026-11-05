// Paper-trading bot engine for the dashboard's 3Commas-style "Bots" tab. PLAY MONEY ONLY —
// this never touches real funds (that stays client-signed in the wallet). Pure + deterministic
// so it's fully testable. Supports DCA and grid strategies; marks a simulated portfolio to market.
//
// A bot = { id, uid, type, pair, params, paper:true, createdAt, state }. `state` carries the
// simulated { cash, base, trades, avgCost }. step(bot, price) advances one tick and returns pnl.

export const BOT_TYPES = [
  'dca', 'grid', 'smarttrade', 'signal',
  // Indicator / systematic strategies (added for a richer, more configurable engine).
  'rsi', 'macd', 'bollinger', 'breakout', 'emacross', 'momentum',
  'meanrev', 'rebalance', 'scalp', 'hodl', 'martingale',
];

export const BOT_LABELS = {
  dca: 'DCA — buy on a schedule',
  grid: 'Grid — buy low / sell high in a band',
  smarttrade: 'Smart Trade — entry + take-profit / stop-loss',
  signal: 'Signal — follow momentum breaks',
  rsi: 'RSI — buy oversold, sell overbought',
  macd: 'MACD — trade the signal-line crossover',
  bollinger: 'Bollinger — fade the bands',
  breakout: 'Breakout — ride new range highs (Donchian)',
  emacross: 'EMA Cross — fast/slow trend follow',
  momentum: 'Momentum — follow rate-of-change',
  meanrev: 'Mean Reversion — buy below / sell above the average',
  rebalance: 'Rebalance — hold a target allocation',
  scalp: 'Scalp — many small quick trades',
  hodl: 'HODL — buy once and hold (benchmark)',
  martingale: 'Martingale — scale into dips, exit on profit',
};

// One-line descriptions of each tunable param, for config UIs (knobs & dials).
export const PARAM_HELP = {
  budget: 'Starting play-money budget ($)',
  buyAmount: 'Amount to buy each interval ($)',
  everyTicks: 'Buy every N ticks',
  takeProfitPct: 'Take profit at +% ',
  trailPct: 'Trailing stop giveback (%)',
  stopLossPct: 'Trailing stop distance (%)',
  stopPct: 'Hard stop below entry (%)',
  dipPct: 'Only buy after a dip of at least (%)',
  maxBuys: 'Cap the number of buys',
  lower: 'Grid lower bound ($)',
  upper: 'Grid upper bound ($)',
  grids: 'Number of grid levels',
  geometric: 'Geometric (ratio) grid spacing',
  breakoutStopPct: 'Liquidate if price breaks below band by (%)',
  trailActivatePct: 'Arm the trailing stop only after +% ',
  cooldownTicks: 'Wait N ticks between trades',
  positionPct: 'Position size per entry (% of budget)',
  period: 'Indicator lookback period',
  oversold: 'RSI oversold level (buy below)',
  overbought: 'RSI overbought level (sell above)',
  fast: 'Fast EMA period',
  slow: 'Slow EMA period',
  signalP: 'MACD signal-line period',
  k: 'Band width (std-devs)',
  lookback: 'Breakout / momentum lookback',
  thresholdPct: 'Trigger threshold (%)',
  bandPct: 'Deviation from the average to trade (%)',
  targetPct: 'Target % of value held in the asset',
  driftPct: 'Rebalance when allocation drifts (%)',
  stepPct: 'Add to the position every drop of (%)',
  scale: 'Each add multiplies size by',
  maxLevels: 'Max martingale add levels',
};

export function newBot({ id, uid, type, pair, params, now }) {
  type = BOT_TYPES.includes(type) ? type : 'dca';
  const p = sanitizeParams(type, params || {});
  return {
    id, uid, type, pair: String(pair || 'BLOCK/USD').slice(0, 20), params: p, paper: true,
    createdAt: now, status: 'running',
    state: {
      cash: p.budget, base: 0, trades: [], avgCost: 0, lastGrid: null, tick: 0,
      entry: 0, entered: false, lastPrice: null, peak: 0, high: 0, halted: false,
      hist: [], rel: 0, lastBuyPrice: null, buys: 0, lastTradeTick: -1e9, level: 0, armed: false,
    },
  };
}

function sanitizeParams(type, p) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const int = (v, d, lo, hi) => Math.round(num(v, d, lo, hi));
  const B = num(p.budget, 1000, 1, 1e9);
  switch (type) {
    case 'dca': return {
      budget: B, buyAmount: num(p.buyAmount, 50, 1, 1e9), everyTicks: int(p.everyTicks, 3, 1, 1000),
      takeProfitPct: num(p.takeProfitPct, 12, 0, 1000),   // bank the position when up this %
      trailPct: num(p.trailPct, 7, 0, 100),               // trailing-stop giveback once in profit
      dipPct: num(p.dipPct, 0, 0, 100),                   // only buy after a dip of ≥ this % from last buy
      maxBuys: int(p.maxBuys, 0, 0, 100000),              // 0 = unlimited
    };
    case 'smarttrade': return {
      budget: B, takeProfitPct: num(p.takeProfitPct, 10, 0.1, 1000),
      stopLossPct: num(p.stopLossPct, 5, 0.1, 100),        // trailing-stop distance below high-water
      trailActivatePct: num(p.trailActivatePct, 0, 0, 1000), // arm the trailing stop only after +%
      entryDipPct: num(p.entryDipPct, 0, 0, 100),          // wait for a dip of ≥ % before entering
    };
    case 'signal': return {
      budget: B, thresholdPct: num(p.thresholdPct, 1, 0.1, 100), stopPct: num(p.stopPct, 6, 0, 100),
      takeProfitPct: num(p.takeProfitPct, 0, 0, 1000),     // optional profit target
      cooldownTicks: int(p.cooldownTicks, 0, 0, 1000),     // min ticks between trades
      positionPct: num(p.positionPct, 20, 1, 100),         // size per entry, % of budget
    };
    case 'grid': return {
      budget: B, lower: num(p.lower, 0, 0, 1e12), upper: num(p.upper, 0, 0, 1e12), grids: int(p.grids, 6, 2, 100),
      breakoutStopPct: num(p.breakoutStopPct, 8, 0, 100),
      geometric: p.geometric ? 1 : 0,                      // geometric (ratio) vs arithmetic spacing
    };
    case 'rsi': return {
      budget: B, period: int(p.period, 14, 2, 200), oversold: num(p.oversold, 30, 1, 50),
      overbought: num(p.overbought, 70, 50, 99), positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'macd': return {
      budget: B, fast: int(p.fast, 12, 2, 100), slow: int(p.slow, 26, 3, 300), signalP: int(p.signalP, 9, 1, 100),
      positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'bollinger': return {
      budget: B, period: int(p.period, 20, 2, 200), k: num(p.k, 2, 0.5, 5), positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'breakout': return {
      budget: B, lookback: int(p.lookback, 20, 2, 300), stopPct: num(p.stopPct, 8, 0, 100),
      positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'emacross': return {
      budget: B, fast: int(p.fast, 10, 2, 200), slow: int(p.slow, 30, 3, 400), positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'momentum': return {
      budget: B, lookback: int(p.lookback, 10, 2, 300), thresholdPct: num(p.thresholdPct, 3, 0, 100),
      positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'meanrev': return {
      budget: B, period: int(p.period, 20, 2, 300), bandPct: num(p.bandPct, 5, 0.1, 100), positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'rebalance': return {
      budget: B, targetPct: num(p.targetPct, 50, 1, 99), driftPct: num(p.driftPct, 10, 1, 100),
    };
    case 'scalp': return {
      budget: B, tpPct: num(p.tpPct, 1, 0.1, 50), slPct: num(p.slPct, 1, 0.1, 50),
      everyTicks: int(p.everyTicks, 1, 1, 100), positionPct: num(p.positionPct, 100, 1, 100),
    };
    case 'hodl': return { budget: B };
    case 'martingale': return {
      budget: B, baseAmount: num(p.baseAmount, 50, 1, 1e9), stepPct: num(p.stepPct, 5, 0.5, 100),
      scale: num(p.scale, 1.5, 1, 5), takeProfitPct: num(p.takeProfitPct, 10, 0.1, 1000), maxLevels: int(p.maxLevels, 5, 1, 50),
    };
    default: return { budget: B };
  }
}

// ---- deterministic technical indicators (pure; null until enough history) ----
const HIST_CAP = 400;
function sma(h, n) { if (h.length < n) return null; let t = 0; for (let i = h.length - n; i < h.length; i++) t += h[i]; return t / n; }
function stdev(h, n) { const m = sma(h, n); if (m == null) return null; let t = 0; for (let i = h.length - n; i < h.length; i++) t += (h[i] - m) ** 2; return Math.sqrt(t / n); }
function ema(h, n) { if (h.length < n) return null; const k = 2 / (n + 1); let e = h[0]; for (let i = 1; i < h.length; i++) e = h[i] * k + e * (1 - k); return e; }
// MACD line + signal line. Needs ~slow+signalP points; returns null otherwise.
function macd(h, fast, slow, signalP) {
  if (h.length < slow + signalP) return null;
  const kf = 2 / (fast + 1), ks = 2 / (slow + 1), kg = 2 / (signalP + 1);
  let ef = h[0], es = h[0], sig = null;
  for (let i = 1; i < h.length; i++) {
    ef = h[i] * kf + ef * (1 - kf); es = h[i] * ks + es * (1 - ks);
    const m = ef - es; sig = sig == null ? m : m * kg + sig * (1 - kg);
  }
  return { macd: ef - es, signal: sig };
}
function rsi(h, n) {
  if (h.length < n + 1) return null;
  let up = 0, dn = 0;
  for (let i = h.length - n; i < h.length; i++) { const d = h[i] - h[i - 1]; if (d >= 0) up += d; else dn -= d; }
  if (dn === 0) return 100;
  const rs = (up / n) / (dn / n);
  return 100 - 100 / (1 + rs);
}
const donHigh = (h, n) => h.length < n + 1 ? null : Math.max(...h.slice(h.length - 1 - n, h.length - 1)); // excl. current
const donLow = (h, n) => h.length < n + 1 ? null : Math.min(...h.slice(h.length - 1 - n, h.length - 1));
const roc = (h, n) => h.length < n + 1 ? null : (h[h.length - 1] - h[h.length - 1 - n]) / h[h.length - 1 - n] * 100;

// Buy/sell helpers for the indicator strategies (mutate state). spend a $ amount / sell all base.
function buyUsd(s, price, usd) {
  const spend = Math.min(s.cash, usd); if (spend <= 0) return;
  const qty = spend / price; s.avgCost = (s.avgCost * s.base + spend) / (s.base + qty || 1);
  s.base += qty; s.cash -= spend; s.trades.push({ side: 'buy', qty, price, tick: s.tick });
}
function sellAll(s, price, reason) {
  if (s.base <= 0) return; const qty = s.base; s.cash += qty * price; s.base = 0; s.avgCost = 0;
  s.trades.push({ side: 'sell', qty, price, tick: s.tick, ...(reason ? { reason } : {}) });
}
// $ to deploy per entry for the indicator strategies: positionPct of the budget (default 100%).
const posUsd = (bot) => bot.params.budget * (bot.params.positionPct != null ? bot.params.positionPct : 100) / 100;

// Advance the bot one price tick. Mutates bot.state, returns { value, pnl, pnlPct }.
export function step(bot, price) {
  const s = bot.state; s.tick += 1;
  // Keep a bounded price history for indicator strategies (deterministic).
  s.hist.push(price); if (s.hist.length > HIST_CAP) s.hist.shift();
  if (bot.status !== 'running') return mark(bot, price);
  if (bot.type === 'dca') {
    const { everyTicks, buyAmount, budget, takeProfitPct, trailPct, dipPct, maxBuys } = bot.params;
    const dipOk = dipPct <= 0 || s.lastBuyPrice == null || price <= s.lastBuyPrice * (1 - dipPct / 100);
    const buysOk = maxBuys <= 0 || s.buys < maxBuys;
    if (s.tick % everyTicks === 0 && s.cash >= buyAmount && dipOk && buysOk) {
      buyUsd(s, price, buyAmount); s.lastBuyPrice = price; s.buys += 1;
    }
    if (s.base > 0) { // profit management — arms only once value is ABOVE budget (flat/loss = pure accumulation)
      const value = s.cash + s.base * price;
      if (value > s.peak) s.peak = value;
      const tpHit = takeProfitPct > 0 && value >= budget * (1 + takeProfitPct / 100);
      const trailHit = trailPct > 0 && s.peak > budget && value <= s.peak * (1 - trailPct / 100);
      if (tpHit || trailHit) { sellAll(s, price, tpHit ? 'take-profit' : 'trailing-stop'); s.peak = 0; }
    }
  } else if (bot.type === 'smarttrade') { // entry (optionally after a dip) + take-profit + trailing stop
    const { takeProfitPct, stopLossPct, trailActivatePct, entryDipPct } = bot.params;
    if (!s.entered) {
      if (s.high === 0 || price > s.high) s.high = price;          // pre-entry high for the dip-entry
      const dipOk = entryDipPct <= 0 || price <= s.high * (1 - entryDipPct / 100);
      if (dipOk && s.cash > 0) { buyUsd(s, price, s.cash); s.entry = price; s.entered = true; s.high = price; }
    } else if (s.base > 0) {
      if (price > s.high) s.high = price;
      const tp = s.entry * (1 + takeProfitPct / 100);
      const trailArmed = trailActivatePct <= 0 || s.high >= s.entry * (1 + trailActivatePct / 100);
      const trail = s.high * (1 - stopLossPct / 100);
      if (price >= tp || (trailArmed && price <= trail)) { sellAll(s, price, price >= tp ? 'take-profit' : 'trailing-stop'); bot.status = 'done'; }
    }
  } else if (bot.type === 'signal') { // momentum breaks: buy a rise, sell a drop, with stop/TP/cooldown
    const thr = bot.params.thresholdPct / 100, stop = bot.params.stopPct / 100;
    const { takeProfitPct, cooldownTicks, positionPct, budget } = bot.params;
    if (s.base > 0 && takeProfitPct > 0 && s.avgCost > 0 && price >= s.avgCost * (1 + takeProfitPct / 100)) {
      sellAll(s, price, 'take-profit'); s.lastTradeTick = s.tick;
    } else if (s.base > 0 && stop > 0 && s.avgCost > 0 && price <= s.avgCost * (1 - stop)) {
      sellAll(s, price, 'stop'); s.lastTradeTick = s.tick;
    } else if (s.lastPrice != null && s.lastPrice > 0 && (s.tick - s.lastTradeTick) >= cooldownTicks) {
      const chg = (price - s.lastPrice) / s.lastPrice;
      if (chg >= thr && s.cash > 0) { buyUsd(s, price, budget * positionPct / 100); s.lastTradeTick = s.tick; }
      else if (chg <= -thr && s.base > 0) { sellAll(s, price); s.lastTradeTick = s.tick; }
    }
    s.lastPrice = price;
  } else if (bot.type === 'grid') { // buy a level crossed down, sell up — arithmetic or geometric band + breakdown stop
    const { lower, upper, grids, breakoutStopPct, geometric } = bot.params;
    if (upper > lower && grids >= 2) {
      if (breakoutStopPct > 0 && price < lower * (1 - breakoutStopPct / 100)) { if (s.base > 0) sellAll(s, price, 'breakdown-stop'); s.halted = true; }
      else if (price >= lower && price <= upper) s.halted = false;
      const level = geometric
        ? Math.round(Math.log(Math.max(price, 1e-12) / lower) / (Math.log(upper / lower) / grids))
        : Math.round((price - lower) / ((upper - lower) / grids));
      if (!s.halted && s.lastGrid != null && level < s.lastGrid && s.cash > 0) buyUsd(s, price, bot.params.budget / grids);
      else if (s.lastGrid != null && level > s.lastGrid && s.base > 0) {
        const qty = s.base / Math.max(1, grids - level); s.cash += qty * price; s.base -= qty; s.trades.push({ side: 'sell', qty, price, tick: s.tick });
      }
      s.lastGrid = level;
    }
  }
  // ---- indicator / systematic strategies ----
  else if (bot.type === 'rsi') {
    const r = rsi(s.hist, bot.params.period);
    if (r != null) {
      if (r <= bot.params.oversold && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (r >= bot.params.overbought && s.base > 0) sellAll(s, price, 'overbought');
    }
  } else if (bot.type === 'macd') {
    const m = macd(s.hist, bot.params.fast, bot.params.slow, bot.params.signalP);
    if (m != null) {
      const rel = m.macd > m.signal ? 1 : -1;
      if (rel === 1 && s.rel <= 0 && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (rel === -1 && s.rel >= 0 && s.base > 0) sellAll(s, price, 'cross-down');
      s.rel = rel;
    }
  } else if (bot.type === 'bollinger') {
    const m = sma(s.hist, bot.params.period), sd = stdev(s.hist, bot.params.period);
    if (m != null && sd != null) {
      if (price <= m - bot.params.k * sd && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (price >= m + bot.params.k * sd && s.base > 0) sellAll(s, price, 'upper-band');
    }
  } else if (bot.type === 'breakout') {
    const hi = donHigh(s.hist, bot.params.lookback), lo = donLow(s.hist, bot.params.lookback);
    if (hi != null) {
      if (price > hi && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (s.base > 0) {
        const stopHit = bot.params.stopPct > 0 && s.avgCost > 0 && price <= s.avgCost * (1 - bot.params.stopPct / 100);
        if ((lo != null && price < lo) || stopHit) sellAll(s, price, stopHit ? 'stop' : 'range-exit');
      }
    }
  } else if (bot.type === 'emacross') {
    const f = ema(s.hist, bot.params.fast), sl = ema(s.hist, bot.params.slow);
    if (f != null && sl != null) {
      const rel = f > sl ? 1 : -1;
      if (rel === 1 && s.rel <= 0 && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (rel === -1 && s.rel >= 0 && s.base > 0) sellAll(s, price, 'cross-down');
      s.rel = rel;
    }
  } else if (bot.type === 'momentum') {
    const r = roc(s.hist, bot.params.lookback);
    if (r != null) {
      if (r >= bot.params.thresholdPct && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (r < 0 && s.base > 0) sellAll(s, price, 'momentum-fade');
    }
  } else if (bot.type === 'meanrev') {
    const m = sma(s.hist, bot.params.period);
    if (m != null) {
      if (price <= m * (1 - bot.params.bandPct / 100) && s.cash > 0) buyUsd(s, price, posUsd(bot));
      else if (price >= m * (1 + bot.params.bandPct / 100) && s.base > 0) sellAll(s, price, 'reverted');
    }
  } else if (bot.type === 'rebalance') { // keep targetPct of VALUE in the asset; act on drift
    const value = s.cash + s.base * price;
    if (value > 0) {
      const target = bot.params.targetPct / 100, held = (s.base * price) / value;
      if (Math.abs(held - target) * 100 >= bot.params.driftPct) {
        const wantUsd = value * target, haveUsd = s.base * price;
        if (wantUsd > haveUsd) buyUsd(s, price, wantUsd - haveUsd);
        else { const qty = (haveUsd - wantUsd) / price; s.cash += qty * price; s.base -= qty; s.trades.push({ side: 'sell', qty, price, tick: s.tick, reason: 'rebalance' }); }
      }
    }
  } else if (bot.type === 'scalp') { // enter small on schedule, exit on a tight TP/SL
    const { tpPct, slPct, everyTicks, positionPct, budget } = bot.params;
    if (s.base > 0 && s.avgCost > 0) {
      if (price >= s.avgCost * (1 + tpPct / 100)) sellAll(s, price, 'take-profit');
      else if (price <= s.avgCost * (1 - slPct / 100)) sellAll(s, price, 'stop');
    } else if (s.tick % everyTicks === 0 && s.cash > 0) buyUsd(s, price, budget * positionPct / 100);
  } else if (bot.type === 'hodl') { // buy once, hold — the benchmark
    if (!s.entered && s.cash > 0) { buyUsd(s, price, s.cash); s.entered = true; }
  } else if (bot.type === 'martingale') { // scale into dips; exit the whole position on profit
    const { baseAmount, stepPct, scale, takeProfitPct, maxLevels } = bot.params;
    if (s.base > 0 && s.avgCost > 0 && price >= s.avgCost * (1 + takeProfitPct / 100)) { sellAll(s, price, 'take-profit'); s.level = 0; s.lastBuyPrice = null; }
    else if (s.base === 0 && s.cash > 0) { buyUsd(s, price, baseAmount); s.level = 1; s.lastBuyPrice = price; }
    else if (s.level < maxLevels && s.lastBuyPrice != null && price <= s.lastBuyPrice * (1 - stepPct / 100) && s.cash > 0) {
      buyUsd(s, price, baseAmount * Math.pow(scale, s.level)); s.level += 1; s.lastBuyPrice = price;
    }
  }
  return mark(bot, price);
}

// Mark-to-market: portfolio value + P&L vs the starting budget.
export function mark(bot, price) {
  const s = bot.state;
  const value = s.cash + s.base * price;
  const pnl = value - bot.params.budget;
  return { value, pnl, pnlPct: (pnl / bot.params.budget) * 100, base: s.base, cash: s.cash, trades: s.trades.length };
}

// Public view for the API (no internal churn beyond the marked numbers).
export function botView(bot, price) {
  const m = mark(bot, price);
  return {
    id: bot.id, type: bot.type, pair: bot.pair, status: bot.status, paper: true,
    params: bot.params, createdAt: bot.createdAt,
    value: round2(m.value), pnl: round2(m.pnl), pnlPct: round2(m.pnlPct), trades: m.trades,
  };
}
const round2 = (n) => Math.round(n * 100) / 100;
