// agent/arena.js — the Blockle ARENA: a gamified, play-money sandbox (spec
// docs/BLOCKLE-BOTS.md §9). A safe test/learn mode where anyone designs and runs
// strategies with FAKE funds against SIMULATED markets. This is the REFERENCE
// implementation; the Dart (blockle-app) and Python (python/blockle) wallets must
// match its numbers EXACTLY (checked against the shared fixture
// docs/arena-vectors.json).
//
// ===========================================================================
// HARD SAFETY RULE (non-negotiable, structural):
//   Arena touches NO keys, NO vault, NO policy gate, NO broadcast, NO reserve.
//   It is PURE in-memory simulation with VIRTUAL funds labeled PLAY/TEST that can
//   NEVER be converted, withdrawn, or exchanged for anything real. There is no
//   code path from an Arena run to commit/broadcast/recordSpend/the reserve — this
//   module depends ONLY on the PURE deal engine (bots.js) + the template
//   export/import (bot-templates.js), never on bot-runner.js / runner.js / the
//   gate. The one honest on-ramp ("use this for real") goes through the existing
//   template import, which ALWAYS lands a bot paper + disabled + testnet.
// ===========================================================================
//
// Pieces (all money base-unit/BigInt-exact, micro-dollar integer basis):
//   • PlayBalance    — a virtual, labeled grant (default 🪙10,000 PLAY) that can
//                      never become real (convertToReal throws).
//   • scenario feed  — canonical price paths LOADED from docs/arena-vectors.json
//                      (bull/crab/bear/crash/pump); never regenerated for the
//                      tested/leaderboard-comparable scenarios.
//   • runScenario    — drive the PURE deal engine over a price path in SIM mode ->
//                      deterministic fills -> equity curve, play PnL, max drawdown,
//                      max cost basis.
//   • score          — the pinned §9 formula (round1(retPct - 0.5·ddPct)), all in
//                      micro-dollar integer math off the deal engine's own fills.
//   • XP + levels    — advisory UX progression (gating is NOT a safety control).
//   • missions       — clear win condition + reward.
//   • badges         — milestone achievements.
//   • Leaderboard    — LOCAL-first only (personal best + on-device board; NO
//                      network/global board in v1).
//   • use-for-real   — export the Arena config as a Bot template (§6); import lands
//                      paper + disabled + testnet, NEVER auto-live.
//
// Exposed as global `AgentArena`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(name, file) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    throw new Error('arena dependency not loaded: ' + name);
  }

  // Honesty guardrail (§9): a persistent, never-removed disclaimer. Arena must
  // NEVER imply simulated results predict real profit.
  var DISCLAIMER = 'Simulation — not financial advice; simulated performance does not predict real results.';

  // Everything in the Arena is PLAY money. These labels appear everywhere a
  // balance or PnL is shown. They are not a currency with any real value.
  var PLAY_LABEL = 'PLAY';
  var PLAY_SYMBOL = '🪙';
  var DEFAULT_GRANT = 10000; // play dollars
  var SIMULATION_ONLY = true; // structural marker; Arena can never go live

  var SCENARIOS = ['bull', 'crab', 'bear', 'crash', 'pump'];

  // ===========================================================================
  // PlayBalance — a virtual, labeled grant. CANNOT become real.
  // ===========================================================================
  function PlayBalance(grantUsd) {
    var B = dep('AgentBots', './bots.js');
    this.label = PLAY_LABEL;
    this.symbol = PLAY_SYMBOL;
    this.real = false;             // hard: PLAY is never real
    this.convertible = false;      // hard: can never convert/withdraw/exchange
    this.grantUc = B.microUsd(grantUsd != null ? grantUsd : DEFAULT_GRANT);
    this.balanceUc = this.grantUc; // current play equity (grant + play PnL)
  }
  // Apply a run's realized+unrealized play PnL to the play balance. PLAY only.
  PlayBalance.prototype.applyPnl = function (pnlUc) {
    this.balanceUc = this.balanceUc + (pnlUc == null ? 0n : pnlUc);
    return this;
  };
  PlayBalance.prototype.reset = function () { this.balanceUc = this.grantUc; return this; };
  // HARD RULE enforced in code: there is NO path to make PLAY funds real.
  PlayBalance.prototype.convertToReal = function () {
    throw new Error('PLAY funds can never be converted, withdrawn, or exchanged for anything real');
  };
  PlayBalance.prototype.withdraw = PlayBalance.prototype.convertToReal;
  PlayBalance.prototype.exchange = PlayBalance.prototype.convertToReal;
  PlayBalance.prototype.toJSON = function () {
    return { label: this.label, real: false, convertible: false, grantUc: this.grantUc.toString(), balanceUc: this.balanceUc.toString() };
  };

  // ===========================================================================
  // scenario feed — LOAD canonical price paths from docs/arena-vectors.json.
  // The fixture is AUTHORITATIVE; we never regenerate the tested scenarios from a
  // cross-language RNG. A live generator (below) may add extra variety only.
  // ===========================================================================
  function loadScenarios(vectors) {
    if (!vectors || !vectors.scenarios) throw new Error('arena: vectors.scenarios missing');
    var out = {};
    for (var i = 0; i < SCENARIOS.length; i++) {
      var name = SCENARIOS[i];
      var s = vectors.scenarios[name];
      var arr = s && (Array.isArray(s) ? s : s.priceSeriesUsd);
      if (!Array.isArray(arr) || !arr.length) throw new Error('arena: scenario missing in fixture: ' + name);
      out[name] = arr.slice();
    }
    return out;
  }
  function pricePath(vectors, name) {
    var s = loadScenarios(vectors);
    if (!s[name]) throw new Error('arena: unknown scenario: ' + name);
    return s[name];
  }

  // Optional LIVE generator for EXTRA variety only (never the canonical scenarios).
  // A tiny deterministic LCG so a (seed) reproduces, but these paths are NOT the
  // fixture and are NOT leaderboard-comparable.
  function lcg(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function generatePath(shape, seed, n, start) {
    n = n || 120; start = start || 100;
    var rnd = lcg(seed || 1);
    var out = []; var p = start;
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      var drift = 0, shock = 0;
      if (shape === 'bull') drift = 0.006;
      else if (shape === 'bear') drift = -0.006;
      else if (shape === 'crab') drift = 0;
      else if (shape === 'crash') drift = (i === Math.floor(n * 0.5)) ? -0.35 : 0.001;
      else if (shape === 'pump') drift = (t < 0.4) ? 0.02 : -0.012;
      shock = (rnd() - 0.5) * 0.02;
      p = Math.max(0.01, p * (1 + drift + shock));
      out.push(Math.round(p * 1e6) / 1e6);
    }
    return out;
  }

  // ===========================================================================
  // run a bot config over a scenario path -> fills + equity curve (PURE sim).
  // Mirrors BotRunner's PAPER fill math EXACTLY (execPrice = level price for grid,
  // else the mark; qty FLOORS; value/cost = divRound) but NEVER the gate/broadcast.
  // ===========================================================================
  function paperFill(order, markUc, bd) {
    var B = dep('AgentBots', './bots.js');
    var execPriceUc = (order._levelPriceUc != null) ? order._levelPriceUc : markUc;
    if (order.side === 'buy') {
      var qty = (order.usdSizeUc != null)
        ? (order._qtyOverride != null ? order._qtyOverride : B.qtyForUsd(order.usdSizeUc, markUc, bd))
        : order.qty;
      return { side: 'buy', qty: qty, priceUc: execPriceUc, costUc: B.valueOf(qty, execPriceUc, bd), bd: bd, paper: true };
    }
    return { side: 'sell', qty: order.qty, priceUc: execPriceUc, proceedsUc: B.valueOf(order.qty, execPriceUc, bd), bd: bd, paper: true };
  }

  function engineStep(B, type, deal, bcfg, cfg, markUc) {
    if (type === 'dca') return B.dcaStep(deal, bcfg, markUc);
    if (type === 'grid') return B.gridStep(deal, markUc, bcfg);
    if (type === 'smarttrade') return B.smartStep(deal, cfg, markUc);
    return null;
  }
  function engineApply(B, type, deal, bcfg, cfg, order, fill, now) {
    if (type === 'dca') return B.dcaApply(deal, bcfg, order, fill, now);
    if (type === 'grid') return B.gridApply(deal, order, fill, now);
    if (type === 'smarttrade') return B.smartApply(deal, cfg, order, fill, now);
  }
  function newDeal(B, type, id, cfg, midUc, bd, now) {
    if (type === 'grid') return B.newGridDeal(id, cfg, midUc, bd, now);
    if (type === 'smarttrade') return B.newSmartTradeDeal(id, cfg, now);
    return B.newDcaDeal(id, now);
  }

  // Current held-inventory cost + mark + realized for a deal, per engine type.
  function dealAgg(B, type, deal, markUc, bd) {
    if (!deal) return { openCostUc: 0n, openMarkUc: 0n, realizedUc: 0n };
    var realized = deal.realizedUc || 0n;
    if (type === 'grid') {
      var cost = 0n, mark = 0n;
      for (var i = 0; i < deal.levels.length; i++) {
        var lv = deal.levels[i];
        if (lv.heldQty > 0n) { cost += (lv._costUc || 0n); mark += B.valueOf(lv.heldQty, markUc, bd); }
      }
      return { openCostUc: cost, openMarkUc: mark, realizedUc: realized };
    }
    if (type === 'smarttrade') {
      var open = deal.status !== 'closed' && deal.remainingQty > 0n;
      return {
        openCostUc: open ? B.valueOf(deal.remainingQty, deal.avgEntryUc, bd) : 0n,
        openMarkUc: open ? B.valueOf(deal.remainingQty, markUc, bd) : 0n,
        realizedUc: realized,
      };
    }
    // dca
    var dopen = deal.status !== 'closed';
    return {
      openCostUc: dopen ? deal.costUc : 0n,
      openMarkUc: dopen ? B.valueOf(deal.filledQty, markUc, bd) : 0n,
      realizedUc: realized,
    };
  }

  // Resolve a bot SPEC/instance/config into { type, cfg, bcfg, bd, pair }.
  function resolveBot(B, spec) {
    var bot = (spec && spec.type && spec.config && spec.describe) ? spec : B.create({
      type: (spec && spec.type) || 'dca',
      name: spec && spec.name,
      universe: { pairs: (spec && spec.pair) ? [String(spec.pair).toUpperCase()] : ((spec && spec.universe && spec.universe.pairs) || []) },
      config: (spec && spec.config) || {},
    });
    var pair = bot.pairs()[0] || (spec && spec.pair) || 'BLOCK/USDC';
    var base = B.splitPair(pair)[0];
    var bd = (spec && spec.decimals != null) ? Number(spec.decimals) : B.decimalsFor(base, bot.config && bot.config.decimals);
    var cfg = bot.config;
    var bcfg = bot.type === 'dca' ? B.dcaBps(cfg) : (bot.type === 'grid' ? B.gridBcfg(cfg) : cfg);
    return { bot: bot, type: bot.type, cfg: cfg, bcfg: bcfg, bd: bd, pair: pair };
  }

  // Run a bot config over a price path. PURE: returns fills + equity curve + the
  // score inputs. opts.guard (spies) is accepted but NEVER called — Arena has no
  // gate/broadcast path, so any such spy stays at zero (asserted by tests).
  function runScenario(opts) {
    opts = opts || {};
    var B = dep('AgentBots', './bots.js');
    var prices = opts.prices;
    if (!prices && opts.vectors && opts.scenario) prices = pricePath(opts.vectors, opts.scenario);
    if (!Array.isArray(prices) || !prices.length) throw new Error('arena.runScenario: need a price path (prices[] or vectors+scenario)');

    var r = resolveBot(B, opts.bot || opts);
    var type = r.type, cfg = r.cfg, bcfg = r.bcfg, bd = r.bd;

    var midUc = B.microUsd(prices[0]);
    var dealSeq = 0;
    var current = newDeal(B, type, 'arena:' + type + ':' + (++dealSeq), cfg, midUc, bd, 0);
    var closedDeals = [];
    var fills = [];
    var equityCurveUc = [];

    var realizedClosedUc = 0n;   // sum of realized from CLOSED deals
    var maxCostBasisUc = 0n;     // peak cost deployed (held-inventory basis)
    var peakEquityUc = null;     // running peak of the equity curve
    var maxDrawdownUc = 0n;      // largest peak-to-trough drop of equity
    var lastEquityUc = 0n;

    // DCA/smarttrade reopen a fresh deal after a close (grid is one deal). An
    // optional maxDeals caps how many deals a run opens (realistic: some bots run
    // a fixed number of deals; also lets a single-deal config be studied cleanly).
    var maxDeals = (opts.maxDeals != null && isFinite(opts.maxDeals)) ? Math.max(1, Math.trunc(opts.maxDeals)) : Infinity;
    var reopen = (type === 'dca' || type === 'smarttrade'); // grid is one deal

    for (var ti = 0; ti < prices.length; ti++) {
      var markUc = B.microUsd(prices[ti]);
      var now = ti + 1; // synthetic monotonic sim clock (NOT wall time)

      if (!current && reopen && dealSeq < maxDeals) {
        current = newDeal(B, type, 'arena:' + type + ':' + (++dealSeq), cfg, midUc, bd, now);
      }

      if (current && B.dcaObserve && type === 'dca') B.dcaObserve(current, markUc);

      var guard = 0;
      while (current && guard++ < 512) {
        var order = engineStep(B, type, current, bcfg, cfg, markUc);
        if (!order) break;
        if (order.action === 'arm') { order._markUc = markUc; engineApply(B, type, current, bcfg, cfg, order, null, now); continue; }
        var fill = paperFill(order, markUc, bd);
        if (!fill.qty || fill.qty <= 0n) break; // rounds to zero — nothing fires
        engineApply(B, type, current, bcfg, cfg, order, fill, now);
        fills.push({
          t: ti, kind: order.kind, side: order.side,
          priceUc: fill.priceUc.toString(), qty: fill.qty.toString(),
          costUc: fill.costUc != null ? fill.costUc.toString() : null,
          proceedsUc: fill.proceedsUc != null ? fill.proceedsUc.toString() : null,
          paper: true,
        });
        // A closed deal is booked IMMEDIATELY (its realized PnL folds into the
        // curve) regardless of reopen/maxDeals; a new deal (if allowed) opens on
        // the next tick. This never loses a closed deal's realized profit.
        if (current.status === 'closed') {
          closedDeals.push(current); realizedClosedUc += (current.realizedUc || 0n); current = null; break;
        }
      }

      // --- equity curve + score inputs at this tick -------------------------
      var agg = dealAgg(B, type, (current && current.status !== 'closed') ? current : null, markUc, bd);
      // realized from the still-open current deal (grid books incrementally)
      var openRealized = (current && current.status !== 'closed') ? (current.realizedUc || 0n) : 0n;
      var unrealizedUc = agg.openMarkUc - agg.openCostUc;
      var equityUc = realizedClosedUc + openRealized + unrealizedUc;
      lastEquityUc = equityUc;

      if (agg.openCostUc > maxCostBasisUc) maxCostBasisUc = agg.openCostUc;
      if (peakEquityUc === null || equityUc > peakEquityUc) peakEquityUc = equityUc;
      var dd = peakEquityUc - equityUc;
      if (dd > maxDrawdownUc) maxDrawdownUc = dd;

      equityCurveUc.push(equityUc);
    }

    var finalPnlUc = lastEquityUc;
    var sc = score(finalPnlUc, maxDrawdownUc, maxCostBasisUc);

    return {
      type: type, pair: r.pair, decimals: bd,
      fills: fills,
      equityCurveUc: equityCurveUc,
      finalPnlUc: finalPnlUc,
      maxDrawdownUc: maxDrawdownUc,
      maxCostBasisUc: maxCostBasisUc,
      retTenthPct: maxCostBasisUc > 0n ? B.divRound(finalPnlUc * 1000n, maxCostBasisUc) : 0n,
      ddTenthPct: maxCostBasisUc > 0n ? B.divRound(maxDrawdownUc * 1000n, maxCostBasisUc) : 0n,
      scoreTenths: sc.scoreTenths,
      score: sc.score,
      dealCount: closedDeals.length + (current && current.status !== 'closed' ? 1 : 0),
      closedDealCount: closedDeals.length,
      playLabel: PLAY_LABEL,
      real: false,
      disclaimer: DISCLAIMER,
    };
  }

  // ===========================================================================
  // SCORE (§9 pinned formula) — risk-adjusted, drawdown-penalized.
  //   retPct = finalPnl / maxCostBasis · 100
  //   ddPct  = maxDrawdown / maxCostBasis · 100
  //   score  = round1(retPct − 0.5 · ddPct)
  // All micro-dollar integer math (no float decides money). To avoid double
  // rounding we fold the formula into ONE half-away-from-zero division to tenths:
  //   scoreTenths = round( (finalPnl·1000 − maxDrawdown·500) / maxCostBasis )
  // (·1000 = ·100·10 for retPct tenths; ·500 = 0.5··100·10 for the dd term).
  // A no-trade run (maxCostBasis = 0) scores 0.
  // ===========================================================================
  function score(finalPnlUc, maxDrawdownUc, maxCostBasisUc) {
    var B = dep('AgentBots', './bots.js');
    finalPnlUc = finalPnlUc || 0n; maxDrawdownUc = maxDrawdownUc || 0n; maxCostBasisUc = maxCostBasisUc || 0n;
    if (maxCostBasisUc <= 0n) return { scoreTenths: 0n, score: 0 };
    var scoreTenths = B.divRound(finalPnlUc * 1000n - maxDrawdownUc * 500n, maxCostBasisUc);
    return { scoreTenths: scoreTenths, score: Number(scoreTenths) / 10 };
  }

  // ===========================================================================
  // XP + LEVELS — advisory UX progression (NOT a safety control; §9/§5).
  // Levels gently UNLOCK advanced params/bot types, mirroring the real product's
  // progressive disclosure. Gating here is UX only and never blocks a safety rail.
  // ===========================================================================
  var LEVELS = [
    { level: 1, minXp: 0, unlocks: ['dca', 'simple-create'] },
    { level: 2, minXp: 50, unlocks: ['grid'] },
    { level: 3, minXp: 150, unlocks: ['advanced-params', 'safety-ladder'] },
    { level: 4, minXp: 350, unlocks: ['smarttrade', 'trailing-tp'] },
    { level: 5, minXp: 700, unlocks: ['martingale', 'signal'] },
  ];
  // XP for one completed run: a flat participation grant + a bonus for a POSITIVE
  // risk-adjusted score (deterministic integer; reckless negative runs earn only
  // the participation XP, never a penalty below zero).
  function xpForRun(result) {
    var base = 10;
    var tenths = result && result.scoreTenths != null ? Number(result.scoreTenths) : Math.round((result && result.score || 0) * 10);
    var bonus = tenths > 0 ? Math.round(tenths / 10) : 0; // +1 XP per whole positive score point
    return base + bonus;
  }
  function levelForXp(xp) {
    xp = Number(xp) || 0;
    var cur = LEVELS[0];
    for (var i = 0; i < LEVELS.length; i++) if (xp >= LEVELS[i].minXp) cur = LEVELS[i];
    var next = null;
    for (var j = 0; j < LEVELS.length; j++) if (LEVELS[j].minXp > xp) { next = LEVELS[j]; break; }
    var unlocks = [];
    for (var k = 0; k < LEVELS.length; k++) if (xp >= LEVELS[k].minXp) unlocks = unlocks.concat(LEVELS[k].unlocks);
    return { level: cur.level, unlocks: unlocks, xp: xp, nextLevel: next ? next.level : null, xpToNext: next ? (next.minXp - xp) : 0 };
  }

  // ===========================================================================
  // MISSIONS — clear win condition + reward (XP). Deterministic checks off a run
  // result. (More can be added; these cover the §9 examples.)
  // ===========================================================================
  var MISSIONS = [
    {
      id: 'survive_crash_green', name: 'Survive the Flash-crash',
      desc: 'Finish the Flash-crash scenario in the green (positive play PnL).',
      scenario: 'crash', rewardXp: 40,
      check: function (res) { return res.scenario === 'crash' && res.finalPnlUc > 0n; },
    },
    {
      id: 'crab_grid_ten', name: 'Range Rider',
      desc: 'Beat +10% with a grid bot in a Crab (ranging) market.',
      scenario: 'crab', rewardXp: 35,
      check: function (res) { return res.scenario === 'crab' && res.type === 'grid' && res.retTenthPct >= 100n; },
    },
    {
      id: 'deep_ladder_survivor', name: 'Deep Ladder',
      desc: 'Build a 4+ safety-order ladder that finishes non-negative through a Bear/Crash drop.',
      rewardXp: 50,
      check: function (res) {
        return (res.scenario === 'bear' || res.scenario === 'crash') &&
          res.type === 'dca' && (res.configSnapshot && res.configSnapshot.maxSafetyOrders >= 4) &&
          res.finalPnlUc >= 0n;
      },
    },
    {
      id: 'steady_hand', name: 'Steady Hand',
      desc: 'Finish any scenario with a positive score AND a drawdown under 15%.',
      rewardXp: 25,
      check: function (res) { return res.scoreTenths > 0n && res.ddTenthPct < 150n; },
    },
  ];
  function missionById(id) { for (var i = 0; i < MISSIONS.length; i++) if (MISSIONS[i].id === id) return MISSIONS[i]; return null; }
  function checkMission(id, res) { var m = missionById(id); return !!(m && m.check(res)); }
  function completedMissions(res) {
    var out = [];
    for (var i = 0; i < MISSIONS.length; i++) { try { if (MISSIONS[i].check(res)) out.push(MISSIONS[i].id); } catch (_) {} }
    return out;
  }

  // ===========================================================================
  // BADGES / achievements — milestones over a profile's history.
  // ===========================================================================
  var BADGES = [
    { id: 'first_run', name: 'First Steps', desc: 'Complete your first Arena run.', check: function (p) { return p.runs >= 1; } },
    { id: 'green_run', name: 'In the Green', desc: 'Finish a run with positive play PnL.', check: function (p) { return p.greenRuns >= 1; } },
    { id: 'high_score', name: 'Sharp Shooter', desc: 'Score 10 or higher on any run.', check: function (p) { return p.bestScoreTenths >= 100n; } },
    { id: 'diamond_hands', name: 'Diamond Hands', desc: 'Survive the Flash-crash in the green.', check: function (p) { return !!p.survivedCrash; } },
    { id: 'all_scenarios', name: 'Globetrotter', desc: 'Run every scenario at least once.', check: function (p) { return p.scenariosPlayed && p.scenariosPlayed.size >= SCENARIOS.length; } },
    { id: 'veteran', name: 'Veteran', desc: 'Complete 25 runs.', check: function (p) { return p.runs >= 25; } },
  ];

  // ===========================================================================
  // Leaderboard — LOCAL-FIRST ONLY (personal best + on-device board). NO network,
  // NO global board in v1 (deferred: needs server + anti-cheat + fairness review).
  // ===========================================================================
  function Leaderboard() { this.entries = {}; } // scenario -> [entry] sorted desc
  Leaderboard.prototype.add = function (entry) {
    var s = entry && entry.scenario; if (!s) return null;
    var e = {
      scenario: s, score: entry.score, scoreTenths: (entry.scoreTenths != null ? entry.scoreTenths.toString() : String(Math.round((entry.score || 0) * 10))),
      type: entry.type || null, name: entry.name || null, at: entry.at != null ? entry.at : Date.now(),
    };
    if (!this.entries[s]) this.entries[s] = [];
    this.entries[s].push(e);
    this.entries[s].sort(function (a, b) { return Number(b.scoreTenths) - Number(a.scoreTenths) || a.at - b.at; });
    if (this.entries[s].length > 100) this.entries[s].length = 100;
    return e;
  };
  Leaderboard.prototype.personalBest = function (scenario) { var a = this.entries[scenario]; return a && a.length ? a[0] : null; };
  Leaderboard.prototype.top = function (scenario, n) { var a = this.entries[scenario] || []; return a.slice(0, n || 10); };
  Leaderboard.prototype.toJSON = function () { return { local: true, global: false, entries: this.entries }; };

  // ===========================================================================
  // ArenaProfile — ties it together: play balance, XP/level, missions, badges,
  // local leaderboard, run history. LOCAL-first; optional store shim (no keys).
  // ===========================================================================
  function ArenaProfile(opts) {
    opts = opts || {};
    this.playBalance = new PlayBalance(opts.grantUsd);
    this.xp = 0;
    this.runs = 0;
    this.greenRuns = 0;
    this.bestScoreTenths = -1000000000n;
    this.survivedCrash = false;
    this.scenariosPlayed = new Set();
    this.missionsCompleted = new Set();
    this.badges = new Set();
    this.leaderboard = new Leaderboard();
    this.history = [];
  }
  // Run a scenario and record it into the profile (XP, missions, badges, board).
  // opts: { bot|type/config/pair, scenario, vectors } — PURE sim; no gate.
  ArenaProfile.prototype.run = function (opts) {
    opts = opts || {};
    var res = runScenario(opts);
    res.scenario = opts.scenario || (opts.bot && opts.bot.scenario) || null;
    res.configSnapshot = snapshotConfig(opts);
    res.name = (opts.name) || (opts.bot && opts.bot.name) || null;

    // play balance moves ONLY by play PnL — still PLAY, never real.
    this.playBalance.applyPnl(res.finalPnlUc);
    this.runs += 1;
    if (res.finalPnlUc > 0n) this.greenRuns += 1;
    if (res.scoreTenths > this.bestScoreTenths) this.bestScoreTenths = res.scoreTenths;
    if (res.scenario) this.scenariosPlayed.add(res.scenario);
    if (res.scenario === 'crash' && res.finalPnlUc > 0n) this.survivedCrash = true;

    // XP: run grant + any newly-completed mission rewards.
    var gained = xpForRun(res);
    var newlyDone = [];
    var done = completedMissions(res);
    for (var i = 0; i < done.length; i++) {
      if (!this.missionsCompleted.has(done[i])) {
        this.missionsCompleted.add(done[i]);
        newlyDone.push(done[i]);
        var m = missionById(done[i]);
        if (m) gained += m.rewardXp;
      }
    }
    this.xp += gained;

    // badges
    var newBadges = [];
    for (var b = 0; b < BADGES.length; b++) {
      if (!this.badges.has(BADGES[b].id) && BADGES[b].check(this)) { this.badges.add(BADGES[b].id); newBadges.push(BADGES[b].id); }
    }

    // local leaderboard
    if (res.scenario) this.leaderboard.add({ scenario: res.scenario, score: res.score, scoreTenths: res.scoreTenths, type: res.type, name: res.name });

    this.history.push({ scenario: res.scenario, score: res.score, finalPnlUc: res.finalPnlUc.toString(), at: Date.now() });

    return {
      result: res,
      xpGained: gained, xp: this.xp, level: levelForXp(this.xp),
      missionsCompleted: newlyDone, badgesEarned: newBadges,
      playBalance: this.playBalance.toJSON(),
      disclaimer: DISCLAIMER,
    };
  };
  ArenaProfile.prototype.level = function () { return levelForXp(this.xp); };

  function snapshotConfig(opts) {
    var src = (opts.bot && opts.bot.config) ? opts.bot.config : (opts.config || (opts.bot || {}).config || {});
    // shallow numeric snapshot for mission checks
    return Object.assign({}, src);
  }

  // ===========================================================================
  // USE THIS FOR REAL — the ONE honest on-ramp (§9 / §6). Export the Arena config
  // as a Bot TEMPLATE, then import it. Import ALWAYS lands paper + disabled +
  // testnet with zero allocation — NEVER auto-live. Reuses the existing template
  // import which structurally enforces that; Arena adds no bypass.
  // ===========================================================================
  function exportAsTemplate(botOrSpec) {
    var B = dep('AgentBots', './bots.js');
    var T = dep('AgentBotTemplates', './bot-templates.js');
    var bot = (botOrSpec && botOrSpec.toJSON && botOrSpec.type) ? botOrSpec : resolveBot(B, botOrSpec).bot;
    return T.exportBot(bot);
  }
  // Import an Arena config into a REAL (but paper + disabled + testnet) bot spec.
  // Returns the Bot produced by the existing non-bypassable template import.
  function useForReal(botOrSpecOrTemplate) {
    var T = dep('AgentBotTemplates', './bot-templates.js');
    var template = (botOrSpecOrTemplate && botOrSpecOrTemplate.kind === 'blockle-bot-template')
      ? botOrSpecOrTemplate
      : exportAsTemplate(botOrSpecOrTemplate);
    var bot = T.importTemplate(template); // ALWAYS paper + disabled + testnet + alloc 0
    return bot;
  }

  var AgentArena = {
    // honesty + labels
    DISCLAIMER: DISCLAIMER, PLAY_LABEL: PLAY_LABEL, PLAY_SYMBOL: PLAY_SYMBOL,
    DEFAULT_GRANT: DEFAULT_GRANT, SIMULATION_ONLY: SIMULATION_ONLY, SCENARIOS: SCENARIOS,
    // play balance
    PlayBalance: PlayBalance,
    // scenario feed
    loadScenarios: loadScenarios, pricePath: pricePath, generatePath: generatePath,
    // run + score
    runScenario: runScenario, score: score,
    // xp/levels/missions/badges
    LEVELS: LEVELS, xpForRun: xpForRun, levelForXp: levelForXp,
    MISSIONS: MISSIONS, missionById: missionById, checkMission: checkMission, completedMissions: completedMissions,
    BADGES: BADGES,
    // leaderboard + profile
    Leaderboard: Leaderboard, ArenaProfile: ArenaProfile,
    // use-for-real on-ramp
    exportAsTemplate: exportAsTemplate, useForReal: useForReal,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentArena;
  root.AgentArena = AgentArena;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
