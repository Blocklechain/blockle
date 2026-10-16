// Paper-trading bot engine for the dashboard's 3Commas-style "Bots" tab. PLAY MONEY ONLY —
// this never touches real funds (that stays client-signed in the wallet). Pure + deterministic
// so it's fully testable. Supports DCA and grid strategies; marks a simulated portfolio to market.
//
// A bot = { id, uid, type, pair, params, paper:true, createdAt, state }. `state` carries the
// simulated { cash, base, trades, avgCost }. step(bot, price) advances one tick and returns pnl.

export const BOT_TYPES = ['dca', 'grid'];

export function newBot({ id, uid, type, pair, params, now }) {
  type = BOT_TYPES.includes(type) ? type : 'dca';
  const p = sanitizeParams(type, params || {});
  return {
    id, uid, type, pair: String(pair || 'BLOCK/USD').slice(0, 20), params: p, paper: true,
    createdAt: now, status: 'running',
    state: { cash: p.budget, base: 0, trades: [], avgCost: 0, lastGrid: null, tick: 0 },
  };
}

function sanitizeParams(type, p) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  if (type === 'dca') return {
    budget: num(p.budget, 1000, 1, 1e9),
    buyAmount: num(p.buyAmount, 50, 1, 1e9),
    everyTicks: Math.round(num(p.everyTicks, 3, 1, 1000)),
  };
  // grid
  return {
    budget: num(p.budget, 1000, 1, 1e9),
    lower: num(p.lower, 0, 0, 1e12),
    upper: num(p.upper, 0, 0, 1e12),
    grids: Math.round(num(p.grids, 6, 2, 100)),
  };
}

// Advance the bot one price tick. Mutates bot.state, returns { value, pnl, pnlPct }.
export function step(bot, price) {
  const s = bot.state; s.tick += 1;
  if (bot.status !== 'running') return mark(bot, price);
  if (bot.type === 'dca') {
    if (s.tick % bot.params.everyTicks === 0 && s.cash >= bot.params.buyAmount) {
      const spend = bot.params.buyAmount; const qty = spend / price;
      s.avgCost = (s.avgCost * s.base + spend) / (s.base + qty);
      s.base += qty; s.cash -= spend;
      s.trades.push({ side: 'buy', qty, price, tick: s.tick });
    }
  } else { // grid: buy when price crosses a level down, sell when it crosses up
    const { lower, upper, grids } = bot.params;
    if (upper > lower && grids >= 2) {
      const stepSize = (upper - lower) / grids;
      const level = Math.round((price - lower) / stepSize);
      if (s.lastGrid != null && level < s.lastGrid && s.cash > 0) {
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
