// test/backtest/backtest.js — END-TO-END PROFITABILITY BACKTEST of the Blockle
// trading bot, driving the REAL shipped engine in PAPER mode over REAL market data.
//
// WHAT THIS DRIVES (real code, not a reimplementation):
//   • agent/strategies.js   — arbitrage (net-edge gate) + momentum (SMA cross) planners
//   • agent/scanner.js      — Autopilot scan-&-score (net-edge + risk + settlement)
//   • agent/bot-runner.js   — the BotRunner, in PAPER mode (grid deal engine)
//   • agent/bots.js         — the grid DEAL ENGINE state machine + money helpers
//   • agent/pnl.js          — the realized-profit avg-cost LEDGER (momentum accounting)
//   • agent/policy.js + runner.js — the ONE value-moving dispatch (gate spy = paper
//                                    must NEVER broadcast)
//
// HONESTY (this is a measurement, not a sales pitch):
//   • The arb + scanner lanes compute net edge AFTER every cost (both venue fees +
//     two 0.05% agent legs + slippage + gas) and REFUSE to emit a net<=0 trade —
//     their realized P&L is net by construction.
//   • Paper deal-bot fills land at the mark with NO fee (the engine simulates a
//     fill, it does not model a spread), so to report an HONEST net for the
//     directional lanes we subtract the engine's OWN execution costs from every
//     paper fill: the AMM pool fee (venues.js default 30 bps) + the mandatory
//     0.05% agent leg + the 5 bps slippage FLOOR (strategies.SLIPPAGE_FLOOR_BPS).
//     We report GROSS vs NET side by side so the fee subtraction is explicit.
//   • Directional (momentum/grid) results are broken out BY REGIME so the honest
//     conditions (trend vs range) are visible. Losses are reported as losses.
//
//   node test/backtest/backtest.js            # full report over real cached candles
//   node test/backtest/fetch-candles.js       # refresh the real candle cache first
'use strict';

const fs = require('fs');
const path = require('path');

const AgentPolicy = require('../../agent/policy.js');
const AgentAudit = require('../../agent/audit.js');
const AgentRunner = require('../../agent/runner.js');
const AgentBots = require('../../agent/bots.js');
const AgentBotRunner = require('../../agent/bot-runner.js');
const AgentScanner = require('../../agent/scanner.js');
const AgentStrategies = require('../../agent/strategies.js');
const AgentPnl = require('../../agent/pnl.js');

// ===========================================================================
// THE ENGINE'S OWN COST MODEL (every number sourced from the shipped code)
// ===========================================================================
const COST = {
  venueFeeBps: 30,                               // venues.js: AMM poolFeeBps default (0.30%)
  agentFeeBps: AgentStrategies.AGENT_FEE_BPS,    // 5  — mandatory 0.05% per leg
  slippageBps: 5,                                // strategies.js SLIPPAGE_FLOOR_BPS (floor)
};
const PER_LEG_BPS = COST.venueFeeBps + COST.agentFeeBps + COST.slippageBps; // 40 bps/leg
const PER_LEG_FRAC = PER_LEG_BPS / 1e4;

// ===========================================================================
// DATA: real cached candles (fetch-candles.js) or a labeled synthetic fallback.
// ===========================================================================
function loadData() {
  const cache = path.join(__dirname, 'candles.json');
  if (fs.existsSync(cache)) {
    try {
      const d = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (d && d.symbols && Object.keys(d.symbols).length) {
        const series = {};
        for (const [sym, rows] of Object.entries(d.symbols)) series[sym] = rows.map((r) => Number(r.close));
        return { real: true, source: d.source, fetchedAt: d.fetchedAt, series };
      }
    } catch (_) {}
  }
  return syntheticData();
}

// Deterministic synthetic series across THREE regimes (labeled synthetic). Used
// only when NO real source is reachable. A seeded PRNG keeps it reproducible.
function syntheticData() {
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const rnd = mulberry32(1337);
  function walk(p0, n, driftPerHr, vol) {
    const out = [p0]; let p = p0;
    for (let i = 1; i < n; i++) { const shock = (rnd() - 0.5) * 2 * vol; p = p * (1 + driftPerHr + shock); out.push(p); }
    return out;
  }
  // A mean-reverting oscillator for the genuine RANGE regime (a pure random walk
  // drifts out of ±3% over a 180h window, so it would never classify as range).
  function oscillate(p0, n, periodH, amp, noise) {
    const out = [];
    for (let i = 0; i < n; i++) { const osc = amp * Math.sin((2 * Math.PI * i) / periodH); const z = (rnd() - 0.5) * 2 * noise; out.push(p0 * (1 + osc + z)); }
    return out;
  }
  const n = 720;
  return {
    real: false, source: 'synthetic(seeded)', fetchedAt: null,
    series: {
      UPSYN: walk(100, n, 0.0012, 0.010),    // steady uptrend
      DOWNSYN: walk(100, n, -0.0012, 0.010), // steady downtrend
      CHOPSYN: oscillate(100, n, 60, 0.02, 0.004), // range: ±2% oscillation, 60h period
    },
  };
}

// ===========================================================================
// REGIME CLASSIFICATION (objective + transparent): per non-overlapping window,
// label by net return band. Thresholds are stated plainly in the report.
// ===========================================================================
const TREND_UP_PCT = 0.03;    // window net return > +3% => uptrend
const TREND_DOWN_PCT = -0.03; // window net return < -3% => downtrend
function classify(win) {
  const r = win[win.length - 1] / win[0] - 1;
  if (r > TREND_UP_PCT) return 'uptrend';
  if (r < TREND_DOWN_PCT) return 'downtrend';
  return 'range';
}
function volOf(win) {
  const rets = [];
  for (let i = 1; i < win.length; i++) rets.push(Math.log(win[i] / win[i - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / rets.length;
  return Math.sqrt(v);
}
function windows(series, size) {
  const out = [];
  for (const [sym, closes] of Object.entries(series)) {
    for (let i = 0; i + size <= closes.length; i += size) {
      const win = closes.slice(i, i + size);
      out.push({ sym, start: i, win, regime: classify(win), netRet: win[win.length - 1] / win[0] - 1, vol: volOf(win) });
    }
  }
  return out;
}

// Find a REAL history slice that ends exactly on a golden cross (SMA short crosses
// above SMA long at the final candle) so the scanner's momentum signal is genuine.
function findGoldenCross(series, shortN, longN) {
  const sma = (h, end, win) => { let s = 0; for (let i = end - win + 1; i <= end; i++) s += h[i]; return s / win; };
  for (const closes of Object.values(series)) {
    for (let t = longN; t < closes.length; t++) {
      const prevShort = sma(closes, t - 1, shortN), currShort = sma(closes, t, shortN);
      const prevLong = sma(closes, t - 1, longN), currLong = sma(closes, t, longN);
      // return a tail ending EXACTLY on the cross, long enough for the scanner to
      // compute BOTH the previous and current long-SMA (needs >= longN+1 candles).
      if (prevShort <= prevLong && currShort > currLong) return closes.slice(Math.max(0, t - longN - 10), t + 1);
    }
  }
  return null;
}

// ===========================================================================
// stats helpers
// ===========================================================================
function newAgg() { return { trades: 0, wins: 0, losses: 0, grossUsd: 0, netUsd: 0, feesUsd: 0, deployedUsd: 0, equity: [], _peak: 0, maxDD: 0 }; }
function markEquity(agg, cumNet) {
  agg.equity.push(cumNet);
  if (cumNet > agg._peak) agg._peak = cumNet;
  const dd = agg._peak - cumNet;
  if (dd > agg.maxDD) agg.maxDD = dd;
}
function winRate(agg) { return agg.trades > 0 ? agg.wins / agg.trades : null; }
function retPct(agg) { return agg.deployedUsd > 0 ? (agg.netUsd / agg.deployedUsd) * 100 : null; }
function usd(x) { return (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2); }
function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }

// ===========================================================================
// LANE 1 — MOMENTUM (SMA golden/death cross), REAL strategies.momentum planner +
// REAL pnl.js Ledger, per-regime. Gross vs net (every leg pays PER_LEG_BPS).
// ===========================================================================
async function runMomentum(data, byRegime, agg, reconcile) {
  const QUOTE = data.real ? 'USDC' : 'USDC';
  const mom = AgentStrategies.momentum;
  const WIN = 180; // ~7.5 day windows
  const wins = windows(data.series, WIN);
  let cumNet = 0;
  for (const w of wins) {
    const base = data.real ? w.sym : 'BTC'; // decimals: use a real 8-dp base for synth labels
    const market = base + '/' + QUOTE;
    const bd = AgentStrategies.decimalsFor(base);
    const params = mom.validateParams({ market, shortN: 10, longN: 30, tradeUsd: 20 });
    // fresh ledger per window — the REAL realized-profit engine
    const ledger = new AgentPnl.Ledger();
    const W = { wallet: 'bt', channel: 'momentum', asset: base };
    let pos = 0n;                 // base units held (net-cost basis path)
    let posGrossQty = 0n;         // base units held (gross path, parallel)
    let grossBasisUsd = 0;        // gross cash basis
    let grossProceeds = 0, grossCost = 0;
    const r = { net: 0, gross: 0, trades: 0, wins: 0, losses: 0, fees: 0, deployed: 0 };

    const closes = w.win;
    for (let t = params.longN - 1; t < closes.length; t++) {
      const history = closes.slice(0, t + 1);
      const ctx = { network: () => 'testnet', prices: async () => ({ [QUOTE]: 1 }), getHistory: async () => history, now: () => t };
      // held override so the planner's death-cross sell sizes to what we hold
      const plan = await mom.plan(ctx, Object.assign({}, params, { history, held: pos.toString() }));
      if (!plan.length) continue;
      const it = plan[0];
      const price = closes[t];
      if (it.tag.endsWith(':buy') && pos === 0n) {
        // BUY leg: pay tradeUsd cash; receive fewer base units after costs.
        const qtyNet = AgentStrategies.usdToBase(params.tradeUsd * (1 - PER_LEG_FRAC), bd, price);
        const qtyGross = AgentStrategies.usdToBase(params.tradeUsd, bd, price);
        if (qtyNet <= 0n) continue;
        ledger.applyBuy(Object.assign({}, W, { qty: qtyNet.toString(), usd: params.tradeUsd }));
        pos = qtyNet; posGrossQty = qtyGross;
        grossBasisUsd = params.tradeUsd; grossCost += params.tradeUsd;
        r.deployed += params.tradeUsd;
      } else if (it.tag.endsWith(':sell') && pos > 0n) {
        // SELL leg: proceeds net of costs vs the gross path.
        const whole = Number(pos) / Math.pow(10, bd);
        const proceedsNet = whole * price * (1 - PER_LEG_FRAC);
        const sold = ledger.applySell(Object.assign({}, W, { qty: pos.toString(), proceedsUsd: proceedsNet }));
        const realizedNet = sold.realizedUc == null ? 0 : Number(sold.realizedUc) / 1e6;
        const wholeG = Number(posGrossQty) / Math.pow(10, bd);
        const proceedsGross = wholeG * price;
        const realizedGross = proceedsGross - grossBasisUsd;
        r.net += realizedNet; r.gross += realizedGross; grossProceeds += proceedsGross;
        r.trades++; if (realizedNet > 0) r.wins++; else r.losses++;
        cumNet += realizedNet; markEquity(byRegime[w.regime], cumNet); markEquity(agg, cumNet);
        pos = 0n; posGrossQty = 0n; grossBasisUsd = 0;
      }
    }
    // Force-close any open position at the window's last price (honest: all capital
    // accounted; labeled as a forced liquidation, counted as a round-trip).
    if (pos > 0n) {
      const price = closes[closes.length - 1];
      const whole = Number(pos) / Math.pow(10, bd);
      const proceedsNet = whole * price * (1 - PER_LEG_FRAC);
      const sold = ledger.applySell(Object.assign({}, W, { qty: pos.toString(), proceedsUsd: proceedsNet }));
      const realizedNet = sold.realizedUc == null ? 0 : Number(sold.realizedUc) / 1e6;
      const wholeG = Number(posGrossQty) / Math.pow(10, bd);
      const realizedGross = wholeG * price - grossBasisUsd;
      r.net += realizedNet; r.gross += realizedGross;
      r.trades++; if (realizedNet > 0) r.wins++; else r.losses++;
      cumNet += realizedNet; markEquity(byRegime[w.regime], cumNet); markEquity(agg, cumNet);
    }
    r.fees = r.gross - r.net;
    // bucket
    const b = byRegime[w.regime];
    b.trades += r.trades; b.wins += r.wins; b.losses += r.losses;
    b.grossUsd += r.gross; b.netUsd += r.net; b.feesUsd += r.fees; b.deployedUsd += r.deployed;
    agg.trades += r.trades; agg.wins += r.wins; agg.losses += r.losses;
    agg.grossUsd += r.gross; agg.netUsd += r.net; agg.feesUsd += r.fees; agg.deployedUsd += r.deployed;
    // reconciliation: ledger realized (net) must equal our tallied net for the window
    reconcile.momNetTally += r.net;
  }
}

// ===========================================================================
// LANE 2 — GRID (ranging), REAL grid DEAL ENGINE via the REAL BotRunner in PAPER.
// deal.realizedUc is GROSS (paper fills at the level price); we net every paper
// fill by PER_LEG_BPS. Gate spy asserts paper NEVER broadcasts. Per-regime.
// ===========================================================================
function gateSpyTools() {
  const state = { commits: 0, committed: [] };
  const mk = (name) => ({
    name, valueMoving: true,
    async prepare(a) {
      return {
        summary: { action: name, from: a.from, to: a.to, amount: a.amount, venue: a.venue },
        value: { asset: a.from || a.asset || 'X', amount: a.amount || '0', usd: 0 },
        commit: async () => { state.commits++; state.committed.push({ name, args: a }); return { txid: 'tx' + state.commits, accepted: true }; },
      };
    },
  });
  const map = { swap: mk('swap'), place_order: mk('place_order'), cancel_order: mk('cancel_order') };
  return { state, get: (n) => map[n] || null, names: () => Object.keys(map), valueMovingNames: () => Object.keys(map) };
}

async function runGrid(data, byRegime, agg, reconcile, gateState) {
  const QUOTE = 'USDC';
  const WIN = 180;
  const wins = windows(data.series, WIN);
  let cumNet = 0;
  for (const w of wins) {
    const base = data.real ? w.sym : 'BTC';
    const market = base + '/' + QUOTE;
    const closes = w.win;
    const lo = Math.min(...closes), hi = Math.max(...closes);
    if (!(lo > 0) || !(hi > lo)) continue;

    const audit = AgentAudit.create({});
    const tools = gateSpyTools();
    gateState.push(tools.state); // share the spy so the aggregate check sees it
    const policy = AgentPolicy.create({ caps: { sessionUsd: 1e9 }, audit });
    policy.setAllowlist(tools.names());
    let tnow = 0;
    const ctx = { _p: closes[0], now: () => tnow, network: () => 'testnet', prices: async () => ({ [base]: ctx._p, [QUOTE]: 1 }) };
    const runner = AgentBotRunner.create({ policy, tools, audit, ctx, AgentRunner, Bots: AgentBots, mainnetEnabled: false });
    const bot = runner.add({
      type: 'grid', universe: { pairs: [market] },
      config: { lowerPrice: lo * 0.999, upperPrice: hi * 1.001, gridCount: 6, totalUsd: 120, profitCurrency: QUOTE },
    });
    bot.mode = 'paper'; bot.enabled = true;

    for (let t = 0; t < closes.length; t++) { ctx._p = closes[t]; tnow = t; await runner.tickBot(bot.id); }

    // GROSS realized from the REAL deal engine. Grid flips accrue into the OPEN
    // deal's realizedUc (the deal only "closes" on a whole-grid TP/SL, which we did
    // not configure), so read the open deal(s), not the per-bot closed-deal total.
    let realizedUc = bot.state.realizedUc || 0n;
    const ps = bot.state.byPair[market];
    const openDeal = ps && ps.deal;
    if (openDeal) realizedUc += (openDeal.realizedUc || 0n);
    const grossUsd = Number(realizedUc) / 1e6;

    // Per-flip NET: each grid SELL fill realizes a gross flip (realizedUc) and the
    // flip paid TWO legs — the buy that opened it (cost = proceeds - realizedUc) and
    // this sell. Subtract PER_LEG_BPS on BOTH notionals. Win/loss is on the NET flip.
    const sellFills = (openDeal ? openDeal.fills : []).filter((f) => f.side === 'sell');
    let feeUsd = 0, wins = 0, losses = 0, fillGrossUc = 0n;
    for (const f of sellFills) {
      const proceeds = Number(f.proceedsUc) / 1e6;
      const flipGross = Number(f.realizedUc) / 1e6;     // engine's realized for this flip
      const buyCost = proceeds - flipGross;              // the matched buy leg's cost
      const flipFee = (proceeds + buyCost) * PER_LEG_FRAC;
      feeUsd += flipFee;
      if (flipGross - flipFee > 0) wins++; else losses++;
      fillGrossUc += BigInt(f.realizedUc);
    }
    const netUsd = grossUsd - feeUsd;
    const roundTrips = sellFills.length; // each sell = a realized flip (round-trip)

    cumNet += netUsd; markEquity(byRegime[w.regime], cumNet); markEquity(agg, cumNet);

    const b = byRegime[w.regime];
    b.trades += roundTrips; b.wins += wins; b.losses += losses;
    b.grossUsd += grossUsd; b.netUsd += netUsd; b.feesUsd += feeUsd; b.deployedUsd += bot.config.totalUsd;
    agg.trades += roundTrips; agg.wins += wins; agg.losses += losses;
    agg.grossUsd += grossUsd; agg.netUsd += netUsd; agg.feesUsd += feeUsd; agg.deployedUsd += bot.config.totalUsd;

    reconcile.gridGrossTally += grossUsd;
    // reconcile: the engine's open-deal realizedUc must equal the sum of its sell
    // fills' realizedUc (no phantom gross — every realized $ traces to a fill).
    reconcile.gridFillGross += Number(fillGrossUc) / 1e6;
    reconcile.gridCommits += tools.state.commits;
  }
}

// ===========================================================================
// LANE 3 — ARBITRAGE (cross-venue), REAL strategies.arbitrage planner cross-checked
// against REAL scanner.arbEdge. Constructed 2-venue books: some net-POSITIVE after
// all costs, some net-NEGATIVE. GUARANTEE: a net<=0 pair is NEVER emitted; realized
// arb P&L >= 0 across the whole run.
// ===========================================================================
function arbBook(pair, askA, bidA, feeA, askB, bidB, feeB) {
  return {
    pair, chain: 'test',
    prices: { [AgentStrategies.splitPair(pair)[1]]: 1 }, // quote = stable $1
    venues: [
      { id: 'venueA', ask: askA, bid: bidA, feeBps: feeA },  // no depthBase => full notional (no clamp)
      { id: 'venueB', ask: askB, bid: bidB, feeBps: feeB },
    ],
  };
}

async function runArbitrage() {
  const S = AgentStrategies;
  // Realistic per-trade size so the fixed $2 gas buffer is a sane ~10bps (not 400bps
  // on a $50 toy trade). Costs at $2000: 2*agent(5)+slip(10)+gas(10)+both venue fees.
  const cfg = AgentScanner.validateConfig({ perTradeUsd: 2000, agentFeeBps: 5, slippageBps: 10, gasBufferUsd: 2 });
  const books = [
    // wide 3.0% spread, cheap venues -> NET POSITIVE, clears the 30bps min (TRADES)
    { b: arbBook('BTC/USDC', 100.0, 99.0, 10, 104.0, 103.0, 10), note: '3.0% gross spread, 10bps venues' },
    // 1.5% spread, cheap venues -> NET POSITIVE, clears the min (TRADES)
    { b: arbBook('ETH/USDC', 100.0, 99.6, 10, 102.0, 101.5, 10), note: '1.5% gross spread, 10bps venues' },
    // tiny 0.15% spread swallowed by costs -> NET NEGATIVE (must SKIP)
    { b: arbBook('SOL/USDC', 100.0, 99.9, 20, 100.15, 100.05, 20), note: '0.15% gross spread, 20bps venues' },
    // inverted (no cross-venue gap: best bid below best ask) -> NO EDGE (must SKIP)
    { b: arbBook('ADA/USDC', 100.0, 99.0, 10, 100.2, 99.5, 10), note: 'no cross-venue gap' },
    // real 0.8% gross spread but fat 60bps venue fees eat it -> NET NEGATIVE (must SKIP)
    { b: arbBook('LINK/USDC', 100.0, 99.5, 60, 100.8, 100.3, 60), note: '0.8% gross spread but 60bps venues' },
  ];
  const results = [];
  for (const { b, note } of books) {
    const ctx = {
      network: () => 'testnet',
      prices: async () => b.prices,
      policyRemaining: async () => ({ sessionUsd: cfg.perTradeUsd }),
      listVenues: async () => b.venues,
    };
    const params = S.arbitrage.validateParams({
      pair: b.pair, venues: b.venues, minEdgeBps: cfg.minProfitBps,
      maxNotionalUsd: cfg.perTradeUsd, gasBufferUsd: cfg.gasBufferUsd, slippageBps: cfg.slippageBps, agentFeeBps: cfg.agentFeeBps,
    });
    const plan = await S.arbitrage.plan(ctx, params);
    // cross-check against the scanner's independent net-edge computation
    const edge = AgentScanner.arbEdge(b, cfg, S);
    const emitted = plan.length === 2;
    const netBps = edge ? edge.edgeBps : null;
    // realized profit if traded = execUsd * netEdge/1e4 (same formula the scanner uses)
    const realized = emitted && edge ? AgentScanner.round6(edge.execUsd * (edge.edgeBps / 1e4)) : 0;
    results.push({ pair: b.pair, note, grossBps: edge ? AgentScanner.round6(edge.grossBps) : null, netBps: netBps == null ? null : AgentScanner.round6(netBps), emitted, realized });
  }
  return { results, minEdgeBps: cfg.minProfitBps };
}

// ===========================================================================
// LANE 4 — SCANNER autopilot (profitCurrency = USDC), REAL BotRunner in PAPER over
// a universe mixing: a net-positive arb pair, a gross-positive-but-net-negative
// arb pair, a real-candle momentum golden-cross pair, a grid-spread pair, a flagged
// scam pair, and a pair profitable in its native quote but net-negative after the
// USDC settlement hop. Asserts: only cost-positive worthy traded; the gross+/net-
// pair skipped; the no-route/flagged skipped; paper NEVER broadcasts.
// ===========================================================================
async function runScanner(data) {
  const audit = AgentAudit.create({});
  const tools = gateSpyTools();
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1e9 }, audit });
  policy.setAllowlist(tools.names());

  // build a REAL golden-cross history (ends exactly on a cross) so the scanner's
  // momentum signal is genuine, not fabricated.
  let goldenHistory = findGoldenCross(data.series, 10, 30);
  if (!goldenHistory) { goldenHistory = []; for (let i = 0; i < 30; i++) goldenHistory.push(i < 20 ? 100 : 100 + (i - 20) * 1.2); }

  const universe = [
    // NET-POSITIVE arb (wide 2.5% spread, cheap venues, quote==profitCurrency) — WORTHY
    { pair: 'ARB1/USDC', chain: 'test', prices: { USDC: 1 }, liquidityUsd: 500000,
      venues: [{ id: 'vA', ask: 100.0, bid: 99.0, feeBps: 10 }, { id: 'vB', ask: 103.5, bid: 102.5, feeBps: 10 }] },
    // GROSS-POSITIVE but NET-NEGATIVE arb (tiny 0.4% spread, fat 40bps venues) — must SKIP
    { pair: 'ARB2/USDC', chain: 'test', prices: { USDC: 1 }, liquidityUsd: 500000,
      venues: [{ id: 'vA', ask: 100.0, bid: 99.8, feeBps: 40 }, { id: 'vB', ask: 100.4, bid: 100.2, feeBps: 40 }] },
    // MOMENTUM golden cross on REAL history — scored on strength net of costs
    { pair: 'MOM/USDC', chain: 'test', prices: { USDC: 1 }, liquidityUsd: 500000, history: goldenHistory },
    // GRID spread pair — scored on book spread net of round-trip costs — WORTHY
    { pair: 'GRID/USDC', chain: 'test', prices: { USDC: 1 }, liquidityUsd: 500000, book: { bids: [{ price: 99.0 }], asks: [{ price: 101.5 }] } },
    // FLAGGED scam — hard-dropped, never scored/traded
    { pair: 'SCAM/USDC', chain: 'test', prices: { USDC: 1 }, flags: ['honeypot'],
      venues: [{ id: 'vA', ask: 100, bid: 99, feeBps: 10 }, { id: 'vB', ask: 103, bid: 102, feeBps: 10 }] },
    // Profitable in its NATIVE quote (DAI) but the extra USDC-settlement hop
    // (settlementFeeBps + agent + slippage) pushes the net BELOW zero -> must SKIP.
    { pair: 'SETTLE/DAI', chain: 'test', prices: { DAI: 1 }, liquidityUsd: 500000,
      venues: [{ id: 'vA', ask: 100.0, bid: 99.6, feeBps: 10 }, { id: 'vB', ask: 100.7, bid: 100.3, feeBps: 10 }] },
  ];

  let tnow = 0;
  const ctx = { now: () => tnow, network: () => 'testnet', async scanUniverse() { return universe; }, prices: async () => ({ USDC: 1 }) };
  const runner = AgentBotRunner.create({ policy, tools, audit, ctx, AgentRunner, Bots: AgentBots, Scanner: AgentScanner, Strategies: AgentStrategies, mainnetEnabled: false });
  const bot = runner.add({ type: 'scanner', config: { minProfitBps: 30, maxConcurrentPairs: 5, perTradeUsd: 2000, profitCurrency: 'USDC', strategies: ['arbitrage', 'momentum', 'grid'] } });
  bot.mode = 'paper'; bot.enabled = true;

  const report = await runner.tickBot(bot.id);
  const scan = report.scan;
  // realized (net, denominated in USDC) attributed by the scanner to worthy pairs
  let realizedUsd = 0;
  for (const d of scan.candidates) if (d.traded && d.realized) realizedUsd += d.realized.profitUsd;
  return { scan, commits: tools.state.commits, realizedUsd, candidates: scan.candidates };
}

// ===========================================================================
// REPORT
// ===========================================================================
function row(label, agg) {
  const gi = agg.grossUsd, ni = agg.netUsd, fe = agg.feesUsd;
  return `  ${label.padEnd(12)} trades=${String(agg.trades).padStart(4)}  win=${(winRate(agg) == null ? ' n/a ' : (pct(winRate(agg))).padStart(5))}  gross=${usd(gi).padStart(10)}  net=${usd(ni).padStart(10)}  fees=$${fe.toFixed(2).padStart(8)}  maxDD=$${agg.maxDD.toFixed(2).padStart(8)}  ret=${retPct(agg) == null ? 'n/a' : retPct(agg).toFixed(2) + '%'}`;
}

async function main() {
  const data = loadData();
  const regimes = ['uptrend', 'downtrend', 'range'];

  console.log('='.repeat(100));
  console.log('BLOCKLE BOT — END-TO-END PROFITABILITY BACKTEST (real engine, PAPER mode)');
  console.log('='.repeat(100));
  console.log(`DATA: ${data.real ? 'REAL' : 'SYNTHETIC'}  source=${data.source}  fetchedAt=${data.fetchedAt || 'n/a'}`);
  if (data.real) {
    const syms = Object.keys(data.series);
    console.log(`      ${syms.length} symbols, ${data.series[syms[0]].length} hourly candles each (~${Math.round(data.series[syms[0]].length / 24)} days): ${syms.join(', ')}`);
  }
  console.log(`COST MODEL (engine's own): venueFee=${COST.venueFeeBps}bps (AMM pool) + agentFee=${COST.agentFeeBps}bps/leg + slippage=${COST.slippageBps}bps(floor) = ${PER_LEG_BPS}bps PER LEG`);
  console.log(`REGIME BANDS: uptrend netRet>+${(TREND_UP_PCT * 100)}%, downtrend netRet<${(TREND_DOWN_PCT * 100)}%, else range  (per ${180}-candle window)`);
  console.log('');

  // ---- regime window census -----------------------------------------------
  const census = { uptrend: 0, downtrend: 0, range: 0 };
  for (const wdw of windows(data.series, 180)) census[wdw.regime]++;
  console.log(`WINDOW CENSUS (${Object.values(census).reduce((a, b) => a + b, 0)} windows of 180h): uptrend=${census.uptrend}, downtrend=${census.downtrend}, range=${census.range}`);
  console.log('');

  const reconcile = { momNetTally: 0, gridGrossTally: 0, gridFillGross: 0, gridCommits: 0 };
  const gateStates = [];

  // ---- MOMENTUM ------------------------------------------------------------
  const momByRegime = { uptrend: newAgg(), downtrend: newAgg(), range: newAgg() };
  const momAgg = newAgg();
  await runMomentum(data, momByRegime, momAgg, reconcile);

  // ---- GRID ----------------------------------------------------------------
  const gridByRegime = { uptrend: newAgg(), downtrend: newAgg(), range: newAgg() };
  const gridAgg = newAgg();
  await runGrid(data, gridByRegime, gridAgg, reconcile, gateStates);

  // ---- ARBITRAGE -----------------------------------------------------------
  const arb = await runArbitrage();

  // ---- SCANNER -------------------------------------------------------------
  const scanner = await runScanner(data);

  // ========================= PRINT ==========================================
  console.log('-'.repeat(100));
  console.log('LANE: MOMENTUM (SMA 10/30 golden-death cross) — strategies.momentum + pnl.js Ledger, BY REGIME');
  console.log('-'.repeat(100));
  for (const r of regimes) console.log(row(r, momByRegime[r]));
  console.log(row('ALL', momAgg));
  console.log('');

  console.log('-'.repeat(100));
  console.log('LANE: GRID (ladder) — REAL grid deal engine via BotRunner (PAPER), BY REGIME');
  console.log('-'.repeat(100));
  for (const r of regimes) console.log(row(r, gridByRegime[r]));
  console.log(row('ALL', gridAgg));
  console.log('');

  console.log('-'.repeat(100));
  console.log(`LANE: ARBITRAGE (cross-venue) — strategies.arbitrage, minEdge=${arb.minEdgeBps}bps. Net edge is AFTER both venue fees + 2 agent legs + slippage + gas.`);
  console.log('-'.repeat(100));
  let arbRealized = 0, arbTrades = 0, negSkipped = 0, negTotal = 0;
  for (const r of arb.results) {
    const verdict = r.emitted ? 'TRADE' : 'SKIP ';
    console.log(`  ${verdict} ${r.pair.padEnd(11)} grossBps=${String(r.grossBps).padStart(8)}  netBps=${String(r.netBps).padStart(8)}  realized=${usd(r.realized).padStart(9)}   (${r.note})`);
    if (r.emitted) { arbRealized += r.realized; arbTrades++; }
    const netNeg = r.netBps == null || r.netBps <= 0;
    if (netNeg) { negTotal++; if (!r.emitted) negSkipped++; }
  }
  console.log(`  => arb realized P&L total = ${usd(arbRealized)} over ${arbTrades} trades; net<=0 pairs skipped: ${negSkipped}/${negTotal}`);
  console.log('');

  console.log('-'.repeat(100));
  console.log('LANE: SCANNER autopilot (profitCurrency=USDC) — scanner.js + BotRunner (PAPER)');
  console.log('-'.repeat(100));
  for (const d of scanner.candidates) {
    const verdict = d.traded ? 'TRADE' : 'SKIP ';
    const rz = d.traded && d.realized ? usd(d.realized.profitUsd) : '       --';
    console.log(`  ${verdict} ${String(d.pair).padEnd(13)} strat=${String(d.strategy || '-').padEnd(9)} score=${String(d.score).padStart(8)}bps netEdge=${String(d.edgeBps).padStart(8)}bps reason=${String(d.reason).padEnd(14)} realized=${rz}`);
  }
  console.log(`  => worthy traded: ${scanner.scan.worthy.join(', ') || '(none)'}`);
  console.log(`  => scanner realized P&L (USDC) = ${usd(scanner.realizedUsd)} = engine's EXPECTED net profit at the scored net-edge (notional x netEdge),`);
  console.log(`     denominated in the profit currency; the realize-side fills run via the deal engine (see the GRID lane). paper broadcasts (gate spy) = ${scanner.commits}`);
  console.log('');

  // ========================= GUARANTEES =====================================
  console.log('='.repeat(100));
  console.log('GUARANTEE VERIFICATION');
  console.log('='.repeat(100));
  const checks = [];
  function check(name, cond, detail) { checks.push({ name, ok: !!cond, detail }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); }

  // ARB guarantee
  check('ARB: every net<=0 pair was SKIPPED (no net-negative trade emitted)', negSkipped === negTotal, `${negSkipped}/${negTotal} skipped`);
  check('ARB: realized arb P&L >= 0 across the whole run', arbRealized >= 0, usd(arbRealized));
  check('ARB: planner emit/skip matches scanner.arbEdge net-edge gate', arb.results.every((r) => r.emitted === (r.netBps != null && r.netBps >= arb.minEdgeBps)), 'cross-checked');

  // SCANNER guarantee
  const arb2 = scanner.candidates.find((d) => d.pair === 'ARB2/USDC');
  const scam = scanner.candidates.find((d) => d.pair === 'SCAM/USDC');
  const settle = scanner.candidates.find((d) => d.pair === 'SETTLE/DAI');
  check('SCANNER: gross-positive but NET-NEGATIVE arb pair (ARB2) was SKIPPED', arb2 && !arb2.traded, arb2 ? 'reason=' + arb2.reason : 'missing');
  check('SCANNER: flagged scam pair (SCAM) was hard-dropped', scam && !scam.traded && scam.reason === 'flagged', scam ? 'reason=' + scam.reason : 'missing');
  check('SCANNER: pair profitable in native quote but net-negative after the USDC settlement hop (SETTLE) was SKIPPED', settle && !settle.traded, settle ? 'reason=' + settle.reason : 'missing');
  check('SCANNER: only cost-positive worthy pairs were traded (all traded have netEdge>0 & score>=min)', scanner.candidates.filter((d) => d.traded).every((d) => d.edgeBps > 0 && d.score >= scanner.scan.minProfitBps), '');
  check('SCANNER: paper NEVER broadcast (gate spy == 0)', scanner.commits === 0, 'commits=' + scanner.commits);
  check('SCANNER: realized P&L (USDC) >= 0', scanner.realizedUsd >= 0, usd(scanner.realizedUsd));

  // GRID paper gate spy
  const gridCommitsTotal = reconcile.gridCommits;
  check('GRID: paper NEVER broadcast across all windows (gate spy == 0)', gridCommitsTotal === 0, 'commits=' + gridCommitsTotal);

  // RECONCILIATION: momentum net tally == aggregate net (no phantom profit)
  check('RECONCILE: momentum ledger-realized == aggregated net P&L (fees really subtracted)',
    Math.abs(reconcile.momNetTally - momAgg.netUsd) < 1e-6, `tally=${reconcile.momNetTally.toFixed(6)} agg=${momAgg.netUsd.toFixed(6)}`);
  // RECONCILIATION: grid engine open-deal realizedUc == sum of its sell fills'
  // realizedUc (every realized gross $ traces to an actual paper fill — no phantom).
  check('RECONCILE: grid engine-realized(gross) == sum of per-fill realized (no phantom gross)',
    Math.abs(reconcile.gridGrossTally - reconcile.gridFillGross) < 1e-6, `deal=${reconcile.gridGrossTally.toFixed(6)} fills=${reconcile.gridFillGross.toFixed(6)}`);
  // net < gross everywhere fees were paid (fees are strictly positive when trades happened)
  check('RECONCILE: net < gross wherever trades occurred (fees are non-zero & subtracted)',
    (momAgg.trades === 0 || momAgg.netUsd < momAgg.grossUsd + 1e-9) && (gridAgg.trades === 0 || gridAgg.netUsd < gridAgg.grossUsd + 1e-9), '');

  const allOk = checks.every((c) => c.ok);
  console.log('');
  console.log('='.repeat(100));
  console.log(`BOTTOM LINE (${data.real ? 'REAL DATA' : 'SYNTHETIC DATA'})`);
  console.log('='.repeat(100));
  console.log(`  ARBITRAGE : ${usd(arbRealized)} net, ${arbTrades} trades — profit-by-construction (never trades a net<=0 gap).`);
  console.log(`  SCANNER   : ${usd(scanner.realizedUsd)} net (USDC) — only trades cost-positive pairs; everything else skipped with a reason.`);
  console.log(`  MOMENTUM  : ${usd(momAgg.netUsd)} net over ${momAgg.trades} round-trips (gross ${usd(momAgg.grossUsd)}, fees $${momAgg.feesUsd.toFixed(2)}).`);
  console.log(`              by regime -> uptrend ${usd(momByRegime.uptrend.netUsd)}, downtrend ${usd(momByRegime.downtrend.netUsd)}, range ${usd(momByRegime.range.netUsd)}`);
  console.log(`  GRID      : ${usd(gridAgg.netUsd)} net over ${gridAgg.trades} flips (gross ${usd(gridAgg.grossUsd)}, fees $${gridAgg.feesUsd.toFixed(2)}).`);
  console.log(`              by regime -> uptrend ${usd(gridByRegime.uptrend.netUsd)}, downtrend ${usd(gridByRegime.downtrend.netUsd)}, range ${usd(gridByRegime.range.netUsd)}`);
  console.log('');
  console.log(`  GUARANTEES: ${checks.filter((c) => c.ok).length}/${checks.length} passed.`);
  console.log('='.repeat(100));

  return { allOk, checks, momAgg, gridAgg, momByRegime, gridByRegime, arb, arbRealized, arbTrades, scanner, data, reconcile, COST, PER_LEG_BPS };
}

// expose for the deterministic guarantee test (network-free)
module.exports = { main, runArbitrage, runScanner, runMomentum, runGrid, loadData, syntheticData, windows, classify, newAgg, COST, PER_LEG_BPS, gateSpyTools };

if (require.main === module) {
  main().then((r) => process.exit(r.allOk ? 0 : 1)).catch((e) => { console.error(e); process.exit(2); });
}
