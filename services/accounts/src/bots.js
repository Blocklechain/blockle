// Paper-trading bot engine for the dashboard's 3Commas-style "Bots" tab. PLAY MONEY ONLY —
// this never touches real funds (that stays client-signed in the wallet). Pure + deterministic
// so it's fully testable. Supports DCA and grid strategies; marks a simulated portfolio to market.
//
// A bot = { id, uid, type, pair, params, paper:true, createdAt, state }. `state` carries the
// simulated { cash, base, trades, avgCost }. step(bot, price) advances one tick and returns pnl.

export const BOT_TYPES = ['dca', 'grid', 'smarttrade', 'signal'];

export const BOT_LABELS = {
  dca: 'DCA — buy on a schedule',
  grid: 'Grid — buy low / sell high in a band',
  smarttrade: 'Smart Trade — entry + take-profit / stop-loss',
  signal: 'Signal — follow momentum signals',
};

export function newBot({ id, uid, type, pair, params, now }) {
  type = BOT_TYPES.includes(type) ? type : 'dca';
  const p = sanitizeParams(type, params || {});
  return {
    id, uid, type, pair: String(pair || 'BLOCK/USD').slice(0, 20), params: p, paper: true,
    createdAt: now, status: 'running',
    state: { cash: p.budget, base: 0, trades: [], avgCost: 0, lastGrid: null, tick: 0, entry: 0, entered: false, lastPrice: null, peak: 0, high: 0, halted: false },
  };
}

function sanitizeParams(type, p) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  if (type === 'dca') return {
    budget: num(p.budget, 1000, 1, 1e9),
    buyAmount: num(p.buyAmount, 50, 1, 1e9),
    everyTicks: Math.round(num(p.everyTicks, 3, 1, 1000)),
    // Risk management: bank the position when the portfolio is up takeProfitPct, and protect
    // open gains with a trailing stop that only arms once the position is in profit. Both are
    // no-ops at a flat or losing price, so plain accumulation is unchanged.
    takeProfitPct: num(p.takeProfitPct, 12, 0, 1000),   // 0 disables
    trailPct: num(p.trailPct, 7, 0, 100),               // 0 disables
  };
  if (type === 'smarttrade') return {
    budget: num(p.budget, 1000, 1, 1e9),
    takeProfitPct: num(p.takeProfitPct, 10, 0.1, 1000),
    // stopLossPct is now a TRAILING stop distance below the high-water mark — it ratchets up
    // as the trade gains, locking in profit instead of only cutting at a fixed level.
    stopLossPct: num(p.stopLossPct, 5, 0.1, 100),
  };
  if (type === 'signal') return {
    budget: num(p.budget, 1000, 1, 1e9),
    thresholdPct: num(p.thresholdPct, 1, 0.1, 100),
    // Hard stop: cut a signal position that falls stopPct below its entry, so a bad entry
    // can't bleed while waiting for the opposite signal. 0 disables.
    stopPct: num(p.stopPct, 6, 0, 100),
  };
  // grid
  return {
    budget: num(p.budget, 1000, 1, 1e9),
    lower: num(p.lower, 0, 0, 1e12),
    upper: num(p.upper, 0, 0, 1e12),
    grids: Math.round(num(p.grids, 6, 2, 100)),
    // Risk-off: if price breaks breakoutStopPct below the band, liquidate and pause buying
    // until it re-enters the band — grid's worst case is a sustained breakdown it keeps buying.
    breakoutStopPct: num(p.breakoutStopPct, 8, 0, 100),  // 0 disables
  };
}

// Advance the bot one price tick. Mutates bot.state, returns { value, pnl, pnlPct }.
export function step(bot, price) {
  const s = bot.state; s.tick += 1;
  if (bot.status !== 'running') return mark(bot, price);
  if (bot.type === 'dca') {
    const { everyTicks, buyAmount, budget, takeProfitPct, trailPct } = bot.params;
    if (s.tick % everyTicks === 0 && s.cash >= buyAmount) {
      const spend = buyAmount; const qty = spend / price;
      s.avgCost = (s.avgCost * s.base + spend) / (s.base + qty);
      s.base += qty; s.cash -= spend;
      s.trades.push({ side: 'buy', qty, price, tick: s.tick });
    }
    // Profit management on the accumulated position. Both arm only once value is ABOVE budget,
    // so a flat or losing price path is pure accumulation (unchanged).
    if (s.base > 0) {
      const value = s.cash + s.base * price;
      if (value > s.peak) s.peak = value;
      const tpHit = takeProfitPct > 0 && value >= budget * (1 + takeProfitPct / 100);
      const trailHit = trailPct > 0 && s.peak > budget && value <= s.peak * (1 - trailPct / 100);
      if (tpHit || trailHit) {
        const qty = s.base; s.cash += qty * price; s.base = 0; s.avgCost = 0; s.peak = 0;
        s.trades.push({ side: 'sell', qty, price, tick: s.tick, reason: tpHit ? 'take-profit' : 'trailing-stop' });
      }
    }
  } else if (bot.type === 'smarttrade') { // enter once, exit on take-profit or a TRAILING stop
    const { takeProfitPct, stopLossPct } = bot.params;
    if (!s.entered && s.cash > 0) {
      const spend = s.cash; const qty = spend / price;
      s.avgCost = price; s.base += qty; s.cash -= spend; s.entry = price; s.entered = true; s.high = price;
      s.trades.push({ side: 'buy', qty, price, tick: s.tick });
    } else if (s.entered && s.base > 0) {
      if (price > s.high) s.high = price;                         // ratchet the high-water mark
      const tp = s.entry * (1 + takeProfitPct / 100);
      const trail = s.high * (1 - stopLossPct / 100);             // trailing stop (was fixed)
      if (price >= tp || price <= trail) {
        const qty = s.base; s.cash += qty * price; s.base = 0;
        s.trades.push({ side: 'sell', qty, price, tick: s.tick, reason: price >= tp ? 'take-profit' : 'trailing-stop' });
        bot.status = 'done';
      }
    }
  } else if (bot.type === 'signal') { // momentum: buy a rise past threshold; sell a drop OR a stop
    const thr = bot.params.thresholdPct / 100;
    const stop = bot.params.stopPct / 100;
    // Protective stop first: cut a losing position rather than wait for the down-signal.
    if (s.base > 0 && stop > 0 && s.avgCost > 0 && price <= s.avgCost * (1 - stop)) {
      const qty = s.base; s.cash += qty * price; s.base = 0; s.avgCost = 0;
      s.trades.push({ side: 'sell', qty, price, tick: s.tick, reason: 'stop' });
    } else if (s.lastPrice != null && s.lastPrice > 0) {
      const chg = (price - s.lastPrice) / s.lastPrice;
      if (chg >= thr && s.cash > 0) {
        const spend = Math.min(s.cash, bot.params.budget / 5); const qty = spend / price;
        s.avgCost = (s.avgCost * s.base + spend) / (s.base + qty || 1);
        s.base += qty; s.cash -= spend; s.trades.push({ side: 'buy', qty, price, tick: s.tick });
      } else if (chg <= -thr && s.base > 0) {
        const qty = s.base; s.cash += qty * price; s.base = 0; s.avgCost = 0;
        s.trades.push({ side: 'sell', qty, price, tick: s.tick });
      }
    }
    s.lastPrice = price;
  } else { // grid: buy a level crossed down, sell a level crossed up — with a breakdown stop
    const { lower, upper, grids, breakoutStopPct } = bot.params;
    if (upper > lower && grids >= 2) {
      const breakdown = breakoutStopPct > 0 && price < lower * (1 - breakoutStopPct / 100);
      if (breakdown) {
        if (s.base > 0) { // risk-off: dump + pause buying until price re-enters the band
          const qty = s.base; s.cash += qty * price; s.base = 0; s.avgCost = 0;
          s.trades.push({ side: 'sell', qty, price, tick: s.tick, reason: 'breakdown-stop' });
        }
        s.halted = true;
      } else if (price >= lower && price <= upper) {
        s.halted = false; // back inside the band → resume
      }
      const stepSize = (upper - lower) / grids;
      const level = Math.round((price - lower) / stepSize);
      if (!s.halted && s.lastGrid != null && level < s.lastGrid && s.cash > 0) {
        const spend = Math.min(s.cash, bot.params.budget / grids); const qty = spend / price;
        s.avgCost = (s.avgCost * s.base + spend) / (s.base + qty || 1);
        s.base += qty; s.cash -= spend; s.trades.push({ side: 'buy', qty, price, tick: s.tick });
      } else if (s.lastGrid != null && level > s.lastGrid && s.base > 0) {
        const qty = s.base / Math.max(1, grids - level); const proceeds = qty * price;
        s.base -= qty; s.cash += proceeds; s.trades.push({ side: 'sell', qty, price, tick: s.tick });
      }
      s.lastGrid = level;
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
