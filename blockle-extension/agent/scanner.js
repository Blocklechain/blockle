// agent/scanner.js — the SCAN-&-TRADE (Autopilot) evaluator. See docs/AGENT-SCAN.md
// and the shared fixture docs/scan-vectors.json. The three wallets (JS here, Dart,
// Python) MUST behave IDENTICALLY: same scoring formula, same ranking, same
// worthy/skip decisions, same emitted Intents — checked against that fixture.
//
// SAFETY MODEL (non-negotiable): the scanner is a PLANNER, never an executor. It
// NEVER signs/broadcasts/touches keys. Per tick it (1) SCANS a candidate universe,
// (2) EVALUATES each for cost-positive profit using the EXISTING strategy signals
// (arbitrage net edge, momentum crossover, grid spread) net of ALL costs (both
// venue fees + two 0.05% agent legs + slippage + gas), (3) SCORES + RANKS, (4)
// returns the worthy strategy Intents for the BotRunner to dispatch through the
// ONE value-moving gate (caps/allocation/confirm/allowlist/kill/audit/fee/mainnet
// + the security pre-sign). It NEVER fabricates a price/edge and NEVER emits a
// sub-threshold or net-negative Intent.
//
// ---- PINNED SCORING FORMULA (identical across all three wallets) -------------
// For a candidate c with market data (venues[], history[], book, prices, liquidity,
// flags), for EACH enabled strategy compute an expected edge in bps, net of costs:
//
//   arbitrage: buyV=min ask, sellV=max bid (distinct venues);
//     grossBps = (sellV.bid - buyV.ask)/buyV.ask * 1e4
//     baseUnits = usdToBase(perTradeUsd/quoteUsd, baseDec, buyV.ask), clamped to depth
//     execUsd   = baseUnits * buyV.ask * quoteUsd           (the ACTUAL notional)
//     gasBps    = gasBufferUsd/execUsd * 1e4
//     costsBps  = buyV.feeBps + sellV.feeBps + 2*agentFeeBps + slippageBps + gasBps
//     edge      = grossBps - costsBps            (exactly strategies.arbitrage's net)
//   momentum: on a GOLDEN cross only (SMA short crosses above SMA long):
//     strengthBps = (currShort - currLong)/currLong * 1e4
//     edge        = strengthBps - (agentFeeBps + slippageBps)      (single buy leg)
//   grid: on a positive spread:
//     spreadBps = (bestAsk - bestBid)/mid * 1e4
//     edge      = spreadBps - (2*agentFeeBps + slippageBps)        (round-trip)
//
//   rawEdgeBps = max over enabled strategies of their edge (the winning strategy).
//   A candidate with no signal / no distinct-venue edge contributes no result.
//
//   RISK ADJUSTMENT (penalize thinness / volatility / flags), each in [0,1]:
//     Lf = liquidityUsd==null ? 1 : min(1, liquidityUsd/liquidityNorm)
//     Vf = 1 / (1 + volPenaltyK * coeffVar(history))     (coeffVar = stdev/mean)
//     Ff = max(0, 1 - flagPenalty * nSoftFlags)
//   score = round6( max(0, rawEdgeBps) * Lf * Vf * Ff )      // bps, rounded to 1e-6
//
//   WORTHY  iff  rawEdgeBps > 0  AND  score >= minProfitBps.
//   Ranked by score desc, stable tiebreak by pair asc. The top maxConcurrentPairs
//   whose intents' total cost fits the remaining allocation are TRADED; the rest are
//   SKIPPED with a pinned reason (no-signal / net-negative / below-threshold /
//   flagged / max-concurrent / allocation).
//
// Exposed as global `AgentScanner`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(name, file) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    return null;
  }

  const STABLE_USD = { USDC: 1, USDT: 1, DAI: 1, USD: 1, USDBC: 1, PYUSD: 1 };

  // Pinned defaults — the fixture depends on these EXACT values.
  const DEFAULTS = {
    minProfitBps: 30,
    maxConcurrentPairs: 3,
    perTradeUsd: 20,
    allocationUsd: 0,
    strategies: ['arbitrage', 'momentum', 'grid'],
    // cost model (mirrors strategies.arbitrage defaults + floors)
    gasBufferUsd: 2,
    slippageBps: 10,
    agentFeeBps: 5,
    // momentum + grid sizing
    momentumShortN: 10,
    momentumLongN: 30,
    gridLevels: 2,
    gridStepBps: 50,
    // risk-adjustment normalizers (pinned)
    liquidityNorm: 100000,
    volPenaltyK: 2.0,
    flagPenalty: 0.25,
    // hard-drop flags (never scored, never traded)
    rejectFlags: ['honeypot', 'scam', 'rug', 'denylist'],
    maxCandidates: 50,
  };

  function num(v, dflt) { const n = Number(v); return isFinite(n) ? n : dflt; }
  function round6(x) { return Math.round(x * 1e6) / 1e6; }
  function lc(x) { return x == null ? '' : String(x).toLowerCase(); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // Coefficient of variation (population stdev / mean) of a price history. 0 when
  // there is too little data or a non-positive mean (never fabricated).
  function coeffVar(history) {
    const h = (history || []).map(Number).filter((x) => isFinite(x));
    if (h.length < 2) return 0;
    let sum = 0; for (const x of h) sum += x;
    const mean = sum / h.length;
    if (!(mean > 0)) return 0;
    let v = 0; for (const x of h) v += (x - mean) * (x - mean);
    v /= h.length;
    return Math.sqrt(v) / mean;
  }

  function validateConfig(params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    p.minProfitBps = Math.max(0, Math.trunc(num(p.minProfitBps, 30)));
    p.maxConcurrentPairs = Math.max(1, Math.trunc(num(p.maxConcurrentPairs, 3)));
    p.perTradeUsd = Math.max(0, num(p.perTradeUsd, 20));
    p.allocationUsd = Math.max(0, num(p.allocationUsd, 0));
    p.gasBufferUsd = Math.max(0, num(p.gasBufferUsd, 2));
    // Floors mirror strategies.arbitrage: slippage >= 5, agent fee >= 5 — a caller
    // can never price a loss-maker as a winner by configuring them below reality.
    p.slippageBps = Math.max(5, Math.trunc(num(p.slippageBps, 10)));
    p.agentFeeBps = Math.max(5, Math.trunc(num(p.agentFeeBps, 5)));
    p.momentumShortN = Math.max(1, Math.trunc(num(p.momentumShortN, 10)));
    p.momentumLongN = Math.max(2, Math.trunc(num(p.momentumLongN, 30)));
    if (p.momentumShortN >= p.momentumLongN) p.momentumShortN = Math.max(1, p.momentumLongN - 1);
    p.gridLevels = Math.max(2, Math.trunc(num(p.gridLevels, 2)));
    p.gridStepBps = Math.max(1, Math.trunc(num(p.gridStepBps, 50)));
    p.liquidityNorm = Math.max(1, num(p.liquidityNorm, 100000));
    p.volPenaltyK = Math.max(0, num(p.volPenaltyK, 2.0));
    p.flagPenalty = Math.max(0, num(p.flagPenalty, 0.25));
    p.strategies = Array.isArray(p.strategies) && p.strategies.length ? p.strategies.map(lc) : DEFAULTS.strategies.slice();
    p.rejectFlags = Array.isArray(p.rejectFlags) ? p.rejectFlags.map(lc) : DEFAULTS.rejectFlags.slice();
    p.maxCandidates = Math.max(1, Math.trunc(num(p.maxCandidates, 50)));
    return p;
  }

  // ---- per-strategy expected edge (bps), net of ALL costs. Returns null when the
  // strategy produces no real signal/edge (never fabricates one). -----------------

  function arbEdge(c, cfg, S) {
    const venues = (c.venues || [])
      .map((v) => ({
        id: v.id, ask: num(v.ask, NaN), bid: num(v.bid, NaN), feeBps: num(v.feeBps, 0),
        mainnet: !!(v.mainnet === true || v.network === 'mainnet'),
        depthBase: v.depthBase != null ? BigInt(String(v.depthBase)) : null,
      }))
      .filter((v) => v.id && v.ask > 0 && v.bid > 0);
    if (venues.length < 2) return null;
    let base, quote;
    try { [base, quote] = S.splitPair(c.pair); } catch (_) { return null; }
    const quoteUsd = c.prices && c.prices[quote] != null ? num(c.prices[quote], NaN)
      : (STABLE_USD[quote] != null ? STABLE_USD[quote] : NaN);
    if (!(quoteUsd > 0)) return null;
    const bd = S.decimalsFor(base), qd = S.decimalsFor(quote);
    const buyV = venues.reduce((a, b) => (b.ask < a.ask ? b : a));  // lowest ask
    const sellV = venues.reduce((a, b) => (b.bid > a.bid ? b : a)); // highest bid
    if (buyV.id === sellV.id) return null;
    const grossBps = ((sellV.bid - buyV.ask) / buyV.ask) * 10000;
    // size exactly like strategies.arbitrage (depth-clamped), then price costs on
    // the ACTUAL executed notional so gas bps are honest for a shallow book.
    const fullBase = S.usdToBase(cfg.perTradeUsd / quoteUsd, bd, buyV.ask);
    let baseUnits = fullBase;
    if (buyV.depthBase && buyV.depthBase < baseUnits) baseUnits = buyV.depthBase;
    if (sellV.depthBase && sellV.depthBase < baseUnits) baseUnits = sellV.depthBase;
    if (baseUnits <= 0n) return null;
    const execUsd = (Number(baseUnits) / Math.pow(10, bd)) * buyV.ask * quoteUsd;
    if (!(execUsd > 0)) return null;
    const gasBps = (cfg.gasBufferUsd / execUsd) * 10000;
    const costsBps = buyV.feeBps + sellV.feeBps + (2 * cfg.agentFeeBps) + cfg.slippageBps + gasBps;
    return {
      strategy: 'arbitrage', edgeBps: grossBps - costsBps,
      grossBps, costsBps, execUsd, buyVenue: buyV.id, sellVenue: sellV.id,
      mainnet: buyV.mainnet || sellV.mainnet,
    };
  }

  function momentumEdge(c, cfg) {
    const h = (c.history || []).map(Number).filter((x) => isFinite(x));
    const longN = cfg.momentumLongN, shortN = cfg.momentumShortN;
    if (h.length < longN) return null;
    const n = h.length;
    const sma = (end, win) => { let s = 0; for (let i = end - win + 1; i <= end; i++) s += h[i]; return s / win; };
    const prevShort = sma(n - 2, shortN), currShort = sma(n - 1, shortN);
    const prevLong = sma(n - 2, longN), currLong = sma(n - 1, longN);
    const golden = prevShort <= prevLong && currShort > currLong; // entry signal only
    if (!golden || !(currLong > 0)) return null;
    const strengthBps = ((currShort - currLong) / currLong) * 10000;
    const costsBps = cfg.agentFeeBps + cfg.slippageBps; // single buy leg
    return { strategy: 'momentum', edgeBps: strengthBps - costsBps, strengthBps, costsBps };
  }

  function gridEdge(c, cfg, S) {
    const book = c.book;
    let bestBid = NaN, bestAsk = NaN;
    if (book) {
      const bb = book.bids && book.bids[0];
      const ba = book.asks && book.asks[0];
      bestBid = bb ? num(bb.price != null ? bb.price : bb[0], NaN) : NaN;
      bestAsk = ba ? num(ba.price != null ? ba.price : ba[0], NaN) : NaN;
      if (book.mid != null && !(bestBid > 0 && bestAsk > 0)) { /* mid-only book has no spread */ }
    }
    if (!(bestBid > 0) || !(bestAsk > 0) || bestAsk <= bestBid) return null;
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / mid) * 10000;
    const costsBps = (2 * cfg.agentFeeBps) + cfg.slippageBps; // round-trip capture
    return { strategy: 'grid', edgeBps: spreadBps - costsBps, spreadBps, costsBps };
  }

  // Evaluate ONE candidate: compute the best (winning) net edge, the risk-adjusted
  // score, and the hard-flag / signal reason. PURE + deterministic.
  function evaluate(c, cfg, S) {
    const flags = (c.flags || []).map(lc);
    const reject = new Set(cfg.rejectFlags);
    if (flags.some((f) => reject.has(f))) {
      return { pair: c.pair, chain: c.chain || null, strategy: null, edgeBps: 0, score: 0, reason: 'flagged', flags, eval: null };
    }

    const evals = [];
    if (cfg.strategies.includes('arbitrage')) { const e = arbEdge(c, cfg, S); if (e) evals.push(e); }
    if (cfg.strategies.includes('momentum')) { const e = momentumEdge(c, cfg); if (e) evals.push(e); }
    if (cfg.strategies.includes('grid')) { const e = gridEdge(c, cfg, S); if (e) evals.push(e); }

    if (!evals.length) {
      return { pair: c.pair, chain: c.chain || null, strategy: null, edgeBps: 0, score: 0, reason: 'no-signal', flags, eval: null };
    }
    // winning strategy = highest net edge (stable: first-listed wins a tie)
    let best = evals[0];
    for (const e of evals) if (e.edgeBps > best.edgeBps) best = e;

    // risk adjustment
    const Lf = c.liquidityUsd == null ? 1 : clamp01(Number(c.liquidityUsd) / cfg.liquidityNorm);
    const Vf = 1 / (1 + cfg.volPenaltyK * coeffVar(c.history));
    const nSoft = flags.length; // soft flags (hard rejects already returned above)
    const Ff = Math.max(0, 1 - cfg.flagPenalty * nSoft);
    const rawEdge = best.edgeBps;
    const score = round6(Math.max(0, rawEdge) * Lf * Vf * Ff);

    let reason;
    if (rawEdge <= 0) reason = 'net-negative';
    else if (score < cfg.minProfitBps) reason = 'below-threshold';
    else reason = 'worthy';

    return {
      pair: c.pair, chain: c.chain || null, strategy: best.strategy,
      edgeBps: round6(rawEdge), score, reason, flags,
      factors: { Lf: round6(Lf), Vf: round6(Vf), Ff: round6(Ff) },
      eval: best, candidate: c,
    };
  }

  // Build a per-candidate READ-ONLY ctx + params and call the EXISTING strategy
  // planner so the emitted Intents match the shared strategy conventions exactly.
  async function emitIntents(row, cfg, S, mainnet) {
    const c = row.candidate;
    const reg = S.createRegistry();
    const net = () => (mainnet ? 'mainnet' : 'testnet');
    if (row.strategy === 'arbitrage') {
      const strat = reg.get('arbitrage');
      const ctx = {
        network: net,
        prices: async () => c.prices || {},
        policyRemaining: async () => ({ sessionUsd: cfg.perTradeUsd }),
        listVenues: async () => c.venues || [],
      };
      const params = strat.validateParams({
        pair: c.pair, venues: c.venues, minEdgeBps: 0, maxNotionalUsd: cfg.perTradeUsd,
        gasBufferUsd: cfg.gasBufferUsd, slippageBps: cfg.slippageBps, agentFeeBps: cfg.agentFeeBps,
      });
      return (await strat.plan(ctx, params)) || [];
    }
    if (row.strategy === 'momentum') {
      const strat = reg.get('momentum');
      const ctx = { network: net, prices: async () => c.prices || {}, getHistory: async () => c.history || [] };
      const params = strat.validateParams({
        market: c.pair, shortN: cfg.momentumShortN, longN: cfg.momentumLongN, tradeUsd: cfg.perTradeUsd,
        history: c.history || [],
      });
      return (await strat.plan(ctx, params)) || [];
    }
    if (row.strategy === 'grid') {
      const strat = reg.get('grid');
      const ctx = { network: net, prices: async () => c.prices || {}, getBook: async () => c.book || null, openOrders: async () => [] };
      const params = strat.validateParams({
        market: c.pair, levels: cfg.gridLevels, stepBps: cfg.gridStepBps, sizeUsdPerLevel: cfg.perTradeUsd,
        openOrders: [],
      });
      return (await strat.plan(ctx, params)) || [];
    }
    return [];
  }

  // The full per-tick pipeline over a candidate snapshot. Returns the ranked
  // evaluation of every candidate, the chosen worthy set WITH its emitted Intents,
  // and the flat Intent list the BotRunner dispatches. `opts.allocationUsd` +
  // `opts.committedUsd` bound the selection (the ledger is still authoritative at
  // dispatch); `opts.mainnet` flags the chain context. DETERMINISTIC.
  async function scanAndScore(universe, config, opts) {
    const cfg = validateConfig(config);
    opts = opts || {};
    const S = opts.Strategies || dep('AgentStrategies', './strategies.js');
    if (!S) throw new Error('scanner requires the strategies registry');

    // dedupe the universe by (chain, address|pair) — first-seen wins; cap it.
    const seen = new Map();
    for (const c of (universe || [])) {
      if (!c || !c.pair) continue;
      const key = lc(c.chain) + ':' + lc(c.address || c.mint || c.pair);
      if (!seen.has(key)) seen.set(key, c);
    }
    const candidates = [...seen.values()].slice(0, cfg.maxCandidates);

    // evaluate + score each
    const rows = candidates.map((c) => evaluate(c, cfg, S));
    // rank by score desc, stable tiebreak by pair asc
    rows.sort((a, b) => (b.score - a.score) || lc(a.pair).localeCompare(lc(b.pair)));

    // greedy selection: worthy, up to maxConcurrentPairs, whose total intent cost
    // (every leg's estUsd + its 0.05% fee) fits the remaining allocation.
    const allocationUsd = opts.allocationUsd != null ? Number(opts.allocationUsd) : cfg.allocationUsd;
    const committedUsd = opts.committedUsd != null ? Number(opts.committedUsd) : 0;
    const hasAllocationCap = allocationUsd > 0;
    let remainingUsd = hasAllocationCap ? Math.max(0, allocationUsd - committedUsd) : Infinity;
    const mainnet = !!opts.mainnet;

    const decisions = [];
    const allIntents = [];
    let picked = 0;

    for (const row of rows) {
      if (row.reason !== 'worthy') { decisions.push(trim(row, row.reason)); continue; }
      if (picked >= cfg.maxConcurrentPairs) { decisions.push(trim(row, 'max-concurrent')); continue; }
      const intents = await emitIntents(row, cfg, S, mainnet || (row.eval && row.eval.mainnet));
      if (!intents.length) { decisions.push(trim(row, 'no-intent')); continue; }
      // cost = sum of every leg's estUsd + the mandatory 0.05% agent fee (the SAME
      // bound the allocation ledger accrues at dispatch).
      let costUsd = 0;
      for (const it of intents) {
        const est = Number(it.estUsd) || 0;
        costUsd += est + est * (cfg.agentFeeBps / 10000);
      }
      if (hasAllocationCap && costUsd > remainingUsd + 1e-9) { decisions.push(trim(row, 'allocation')); continue; }
      remainingUsd -= costUsd;
      picked += 1;
      const tagged = intents.map((it) => Object.assign({}, it, { scannerPair: row.pair, scannerScore: row.score, scannerStrategy: row.strategy }));
      for (const it of tagged) allIntents.push(it);
      decisions.push(Object.assign(trim(row, 'worthy'), { traded: true, intents: tagged, costUsd: Math.round(costUsd * 1e6) / 1e6 }));
    }

    return {
      candidates: decisions,          // ranked, each with decision + reason
      worthy: decisions.filter((d) => d.traded),
      skipped: decisions.filter((d) => !d.traded).map((d) => ({ pair: d.pair, reason: d.reason, score: d.score, edgeBps: d.edgeBps })),
      intents: allIntents,            // flat list the runner dispatches through the gate
      allocationUsd: hasAllocationCap ? allocationUsd : null,
      committedUsd, remainingUsd: hasAllocationCap ? Math.max(0, Math.round(remainingUsd * 1e6) / 1e6) : null,
      minProfitBps: cfg.minProfitBps, maxConcurrentPairs: cfg.maxConcurrentPairs,
    };
  }

  // Strip the heavy candidate/eval refs for the decision list (reason is final).
  function trim(row, reason) {
    return {
      pair: row.pair, chain: row.chain, strategy: row.strategy,
      edgeBps: row.edgeBps, score: row.score, reason, flags: row.flags,
      factors: row.factors || null, traded: false,
    };
  }

  const AgentScanner = {
    DEFAULTS, validateConfig, evaluate, scanAndScore,
    arbEdge, momentumEdge, gridEdge, coeffVar, round6,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentScanner;
  root.AgentScanner = AgentScanner;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
