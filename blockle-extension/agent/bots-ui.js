// agent/bots-ui.js — the BLOCKLE BOTS cockpit for the popup (docs/BLOCKLE-BOTS.md
// + the shared design reference docs/design/bots/index.html). FOUR surfaces in one
// screen, each wired to the REAL engine — NEVER mock data, NEVER a new money path:
//
//   COCKPIT   — aggregate P&L hero + sparkline, KILL-ALL, Paper/Live filter, bot
//               cards (type chip + mode badge + allocation-used-vs-cap bar + P&L +
//               minispark). Data from BotRunner.aggregate()/dashboard() (real marks).
//   CREATE    — template gallery -> pair -> one amount -> plain-language preview ->
//               Start in paper / Go live, with an ADVANCED drawer driving a live
//               deal-ladder canvas. Builds a Bot spec from AgentBotTemplates and
//               starts it via the gated BotRunner (enablePaper / armLive only).
//   DETAIL    — deal stepper (base -> safety fills -> TP), realized/unrealized P&L
//               tiles, allocation-used-vs-cap, controls + per-bot pause/kill.
//   ARENA     — play-money sandbox (AgentArena): play balance, scenario picker, Run
//               with animation, score/XP/level, mission, badges, local leaderboard,
//               always-visible disclaimer, "use this for real" (lands paper+disabled).
//
// SAFETY (non-bypassable): the UI calls ONLY the BotRunner gated methods — it never
// signs or broadcasts. Live orders run fully-auto WITHIN the per-bot allocation cap
// through the ONE value-moving dispatch; the paper->live / testnet->mainnet REVIEW
// sheet restates allocation + auto + kill + mainnet before a single confirm; Kill-all
// routes BotRunner.killAll (cancels open orders + locks the vault). Arena touches no
// keys/gate/broadcast and shows the honesty disclaimer everywhere.
//
// PRICE/MARK SOURCE (shared gap, §5/§7): the engine is fed REAL marks, never {}.
// `makePriceAccessor` reuses the SAME source the agent runner ctx uses — the live
// Exchange (getMarkets/getBook: book mid, else getTrades: last trade, per BASE/QUOTE
// market) plus the configured USD price map (settings.agent.priceUsd). A market with
// no data yields no mark, so the engine correctly skips that tick (never fabricated).
//
// Global `BotsUI`; pure helpers also on module.exports for the DOM-level test.
(function (global) {
  'use strict';

  var UI = null;                 // BlockleUI (show/toast/route/$/$$)
  var runner = null;             // AgentBotRunner instance (built on unlock)
  var activeTab = 'cockpit';
  var modeFilter = 'all';        // 'all' | 'paper' | 'live'
  var selectedBotId = null;
  var arena = null;              // { profile, vectors, scen, last }
  var raf = 0;

  // create-flow state (mirrors the design reference)
  var create = {
    tplKey: 'conservative_dca',
    // PAIR SELECTION MODE — defaults to 'ai' ("Let the AI choose pairs": the
    // scanner/autopilot scans + picks worthy pairs). 'manual' ("I'll pick a pair")
    // is opt-in and brings back the manual pair picker.
    pairMode: 'ai',
    pair: 'BLOCK/USDC',
    // PROFIT CURRENCY — the settlement/quote asset realized profit settles INTO
    // (AI mode: user-chosen; manual mode: derived from the pair quote).
    profitCurrency: 'USDC',
    // LANE (one chain + base asset the bot trades) + RISK MODE (safe/medium/high/
    // sniper). The lane's base asset is the settlement/quote asset.
    lane: 'solana',
    riskMode: 'medium',
    alloc: 500,
    base: 20, tp: 2, so: 3, step: 2, vol: 1.0, tr: 0,
    type: 'dca',
    markUsd: null,               // live mark for the pair base (display only)
  };

  // Profit-currency choices (settlement/quote assets). USDC is the default.
  var PROFIT_CURRENCIES = ['USDC', 'USDT', 'DAI', 'USD'];

  // The policy session USD cap for live bots. allocationUsd must be > 0 AND <= this
  // (BotRunner.armLive fail-closes otherwise). The allocation cap is the real bound.
  var SESSION_CAP_USD = 100000;

  var STABLES = { USDC: 1, USDT: 1, DAI: 1, USD: 1, USDBC: 1, PYUSD: 1 };

  function dep(name, file) {
    if (global[name]) return global[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    return null;
  }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); };
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  // ===========================================================================
  // PRICE / MARK accessor — REAL marks for the engine (never {}). Exported pure.
  // opts: { exchange, priceUsd }  (priceUsd: symbol->usd map OR async()=>map)
  // Returns async prices(symbols) -> { SYM: usdPrice }. Omits a symbol when there
  // is no live market data AND no configured USD price (engine then skips the tick).
  // ===========================================================================
  function makePriceAccessor(opts) {
    opts = opts || {};
    var exchange = opts.exchange || null;
    var priceUsdSrc = opts.priceUsd || {};
    var stables = opts.stables || STABLES;

    function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
    function usdOf(map, sym) {
      var up = String(sym || '').toUpperCase();
      if (stables[up] != null) return stables[up];
      if (map && map[up] != null) { var n = num(map[up]); if (n != null && n > 0) return n; }
      return null;
    }
    // mid of the top of book (quote-per-base), else last trade; null if neither.
    function markFromBook(book) {
      if (!book) return null;
      var bids = book.bids || [], asks = book.asks || [];
      var bb = bids[0] && num(bids[0].price);
      var ba = asks[0] && num(asks[0].price);
      if (bb != null && bb > 0 && ba != null && ba > 0) return (bb + ba) / 2;
      if (bb != null && bb > 0) return bb;
      if (ba != null && ba > 0) return ba;
      return null;
    }
    function markFromTrades(trades) {
      if (!Array.isArray(trades) || !trades.length) return null;
      // last trade — try the newest end first, then the head (feeds vary in order).
      var a = num(trades[trades.length - 1] && trades[trades.length - 1].price);
      if (a != null && a > 0) return a;
      var b = num(trades[0] && trades[0].price);
      return (b != null && b > 0) ? b : null;
    }

    return async function prices(symbols) {
      var want = {};
      (symbols || []).forEach(function (s) { want[String(s).toUpperCase()] = true; });
      var map = typeof priceUsdSrc === 'function' ? (await priceUsdSrc()) || {} : priceUsdSrc;
      // normalize the configured map to uppercase keys
      var pm = {};
      Object.keys(map || {}).forEach(function (k) { pm[String(k).toUpperCase()] = map[k]; });

      var out = {};
      // stablecoins + configured map first (cheap, always available)
      Object.keys(want).forEach(function (sym) {
        var u = usdOf(pm, sym);
        if (u != null) out[sym] = u;
      });

      // then prefer a LIVE Exchange mark (book mid, else last trade) per BASE/QUOTE.
      if (exchange && typeof exchange.getMarkets === 'function') {
        var markets = [];
        try { markets = (await exchange.getMarkets()) || []; } catch (_) { markets = []; }
        for (var i = 0; i < markets.length; i++) {
          var m = markets[i];
          var base = String(m.base || '').toUpperCase();
          if (!want[base]) continue;
          var quoteUsd = usdOf(pm, m.quote);
          if (quoteUsd == null) continue;        // can't convert quote->USD; skip this market
          var markQuote = null;
          try { markQuote = markFromBook(await exchange.getBook(m.market)); } catch (_) {}
          if (markQuote == null && typeof exchange.getTrades === 'function') {
            try { markQuote = markFromTrades(await exchange.getTrades(m.market)); } catch (_) {}
          }
          if (markQuote != null && markQuote > 0) out[base] = markQuote * quoteUsd; // live mark wins
        }
      }
      return out;
    };
  }

  // ===========================================================================
  // lifecycle (called by popup.js, mirrors AgentUI)
  // ===========================================================================
  function init(ui) {
    UI = ui;
    var kill = $('#bots-kill');
    if (kill) kill.addEventListener('click', killAll);
  }
  async function onUnlock() { await buildRunner(); }
  async function onResume() { await buildRunner(); }
  async function onLock() { stopAnim(); runner = null; }

  function Wallet() { return global.Wallet; }
  function unlocked() { try { return !!(Wallet() && Wallet().isUnlocked && Wallet().isUnlocked()); } catch (_) { return false; } }

  async function buildRunner() {
    try {
      var Wiring = dep('Wiring', '../wiring.js');
      var AgentAudit = dep('AgentAudit', './audit.js');
      var AgentPolicy = dep('AgentPolicy', './policy.js');
      var AgentTools = dep('AgentTools', './tools.js');
      var AgentRunner = dep('AgentRunner', './runner.js');
      var AgentBots = dep('AgentBots', './bots.js');
      var AgentBotRunner = dep('AgentBotRunner', './bot-runner.js');
      var AgentPnl = dep('AgentPnl', './pnl.js');
      if (!Wiring || !AgentBotRunner) return;

      await Wiring.ensureAgentDeps();
      var ctx = Wiring.agentCtx();

      // Reuse the SAME price source the agent ctx uses: the live Exchange + the
      // settings.agent.priceUsd map. Feed the engine REAL marks (never {}).
      var settings = {};
      try { settings = await Wiring.settings(); } catch (_) {}
      var priceUsd = (settings && settings.agent && settings.agent.priceUsd) || {};
      ctx.prices = makePriceAccessor({ exchange: ctx.exchange, priceUsd: priceUsd });
      // Bots are testnet-first; the mainnet gate stays off unless explicitly enabled.
      if (typeof ctx.network !== 'function') ctx.network = function () { return 'testnet'; };
      if (typeof ctx.now !== 'function') ctx.now = function () { return Date.now(); };

      var Store = global.Store;
      var audit = AgentAudit ? AgentAudit.create({ store: Store }) : null;
      var policy = AgentPolicy.create({
        caps: { sessionUsd: SESSION_CAP_USD },
        confirm: async function () { return false; }, // fail-closed: within-allocation auto-approves; anything needing a tap is declined
        onKill: async function () { await globalKill(); },
        audit: audit,
        requireConfirm: true,
      });
      var tools = AgentTools.build(ctx);
      policy.setAllowlist(tools.names());
      var pnl = AgentPnl ? AgentPnl.create({ audit: audit, store: Store }) : null;

      var rec = null;
      try { rec = await Wallet().selected(); } catch (_) {}
      var walletId = (rec && rec.id) || (Wallet() && Wallet().activeId) || 'active';

      runner = AgentBotRunner.create({
        policy: policy, tools: tools, audit: audit, ctx: ctx, pnl: pnl,
        persist: Store, wallet: walletId, channel: 'bots',
        discovery: ctx.discovery || null, mainnetEnabled: false,
        AgentRunner: AgentRunner, Bots: AgentBots,
      });
      try { await runner.store.restore(); } catch (_) {}
    } catch (_) { runner = null; }
  }

  // ===========================================================================
  // KILL — Kill-all (BotRunner.killAll: cancel open orders + lock vault) ----------
  // ===========================================================================
  async function killAll() {
    if (!global.confirm('Kill ALL bots, cancel their open orders, and lock the wallet now?')) return;
    try { if (runner) await runner.killAll('user kill'); else await globalKill(); } catch (_) {}
    UI.toast('Bots stopped · wallet locked');
    stopAnim();
    runner = null;
    UI.route('unlock');
  }
  async function globalKill() {
    try { await global.Exchange.signOut(); } catch (_) {}
    try { await Wallet().lock(); } catch (_) {}
    try { if (global.Wiring) global.Wiring.reset(); } catch (_) {}
  }

  // ===========================================================================
  // marks for the dashboard — one batched read of every base symbol in use.
  // ===========================================================================
  async function currentMarks() {
    var out = {};
    if (!runner) return out;
    var B = runner.Bots;
    var syms = {};
    runner.list().forEach(function (b) {
      (b.pairs() || []).forEach(function (p) { try { var bq = B.splitPair(p); syms[bq[0]] = true; syms[bq[1]] = true; } catch (_) {} });
    });
    var list = Object.keys(syms);
    if (!list.length) return out;
    try { out = (await runner.ctx.prices(list)) || {}; } catch (_) { out = {}; }
    return out;
  }

  // ===========================================================================
  // main render
  // ===========================================================================
  async function enter() {
    UI.show('bots');
    var body = $('#bots-body');
    if (!body) return;
    if (!unlocked()) {
      body.innerHTML = '<div class="notice">Unlock your wallet to run trading bots. Bots are non-custodial and default to paper + disabled + testnet.</div>';
      return;
    }
    if (!runner) await buildRunner();
    body.innerHTML = renderShell();
    wireShell();
    await renderActiveTab();
  }

  function renderShell() {
    return '' +
      '<div class="bots-root" data-theme-scope>' +
        '<div class="bots-bar">' +
          '<div class="bseg" role="group" aria-label="Trading mode filter">' +
            '<button data-mode="all" aria-pressed="' + (modeFilter === 'all') + '">All</button>' +
            '<button data-mode="paper" aria-pressed="' + (modeFilter === 'paper') + '"><span class="bdot paper"></span>Paper</button>' +
            '<button data-mode="live" aria-pressed="' + (modeFilter === 'live') + '"><span class="bdot live"></span>Live</button>' +
          '</div>' +
          '<span class="bspacer"></span>' +
          '<button class="bkill" id="bots-killall">⏻ Kill all</button>' +
        '</div>' +
        '<div class="btabs" role="tablist">' +
          tabBtn('cockpit', 'Cockpit') + tabBtn('create', 'Create') +
          tabBtn('detail', 'Detail') + tabBtn('arena', 'Arena <span class="play-pill">PLAY</span>') +
        '</div>' +
        '<div id="bots-panel"></div>' +
        '<div id="bots-sheet"></div>' +
      '</div>';
  }
  function tabBtn(id, label) {
    return '<button role="tab" data-tab="' + id + '" aria-selected="' + (activeTab === id) + '">' + label + '</button>';
  }

  function wireShell() {
    $$('.bseg button').forEach(function (b) {
      b.addEventListener('click', function () { modeFilter = b.getAttribute('data-mode'); enter(); });
    });
    var k = $('#bots-killall'); if (k) k.addEventListener('click', killAll);
    $$('.btabs [role=tab]').forEach(function (t) {
      t.addEventListener('click', function () { activeTab = t.getAttribute('data-tab'); enter(); });
    });
  }

  async function renderActiveTab() {
    stopAnim();
    var panel = $('#bots-panel');
    if (!panel) return;
    if (activeTab === 'cockpit') return renderCockpit(panel);
    if (activeTab === 'create') return renderCreate(panel);
    if (activeTab === 'detail') return renderDetail(panel);
    if (activeTab === 'arena') return renderArena(panel);
  }

  // ===========================================================================
  // helpers (money / html) — some exported pure for the test
  // ===========================================================================
  function money(n) {
    n = Number(n) || 0;
    return (n < 0 ? '−$' : '+$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function plain(n) { return '$' + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function pct01(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function cls(n) { return Number(n) > 0 ? 'pos' : Number(n) < 0 ? 'neg' : ''; }

  // cumulative-realized series from a bot's closed deals (REAL data, like agent-ui)
  function botSeries(bot) {
    var B = runner && runner.Bots;
    var pts = [0], cum = 0;
    var closed = (bot && bot.state && bot.state.closedDeals) || [];
    for (var i = 0; i < closed.length; i++) {
      var r = closed[i] && closed[i].realizedUc;
      if (r != null && B) cum += Number(B.ucToUsd(typeof r === 'bigint' ? r : BigInt(r)));
      pts.push(cum);
    }
    return pts;
  }

  // Build a Bot SPEC from the create-flow state via the engine's template.
  // AI mode ("Let the AI choose pairs") -> the scan-&-trade autopilot, realizing
  // profit INTO the chosen profit currency. Manual mode -> the selected template
  // on the chosen pair.
  function specFromCreate() {
    var T = dep('AgentBotTemplates', './bot-templates.js');
    if (create.pairMode !== 'manual') {
      var sc = T.fromTemplate('scan_and_trade', {});
      // The settlement/quote currency is the user's chosen profitCurrency (the lane
      // selector keeps this synced to the lane's base asset). Carry it through.
      sc.config = Object.assign({}, sc.config, { profitCurrency: (create.profitCurrency || 'USDC') });
      sc.name = (T.TEMPLATES.scan_and_trade && T.TEMPLATES.scan_and_trade.name) || sc.name;
      sc.lane = create.lane; sc.riskMode = create.riskMode;
      return sc;
    }
    var spec = T.fromTemplate(create.tplKey, { pair: create.pair });
    spec.lane = create.lane; spec.riskMode = create.riskMode;
    // overlay the (simple + advanced) create controls onto the template config
    if (spec.type === 'dca') {
      spec.config = Object.assign({}, spec.config, {
        baseOrderUsd: create.base,
        safetyOrderUsd: create.base,
        maxSafetyOrders: create.so,
        safetyStepPct: create.step,
        safetyVolumeScale: create.vol,
        takeProfitPct: create.tp,
        trailingTpPct: create.tr,
      });
    }
    spec.name = (T.TEMPLATES[create.tplKey] && T.TEMPLATES[create.tplKey].name) || spec.name;
    return spec;
  }

  // The create-flow bot config as an Arena run spec (reuses the create UI, §9).
  function arenaBotSpec() {
    var cfg = { baseOrderUsd: create.base, safetyOrderUsd: create.base, maxSafetyOrders: create.so, safetyStepPct: create.step, safetyVolumeScale: create.vol, takeProfitPct: create.tp, trailingTpPct: create.tr };
    return { type: 'dca', name: 'Arena strategy', pair: create.pair, decimals: 8, config: cfg };
  }

  // ===========================================================================
  // COCKPIT
  // ===========================================================================
  async function renderCockpit(panel) {
    var marks = await currentMarks();
    var bots = runner ? runner.list() : [];
    var shown = bots.filter(function (b) { return modeFilter === 'all' || b.mode === modeFilter; });

    var totalReal = 0, totalUnreal = 0, allocUsed = 0, allocCap = 0, wins = 0, deals = 0, live = 0, paper = 0;
    var cards = [];
    for (var i = 0; i < shown.length; i++) {
      var b = shown[i];
      var d = runner.dashboard(b.id, marks) || {};
      totalReal += Number(d.realizedUsd) || 0;
      totalUnreal += Number(d.unrealizedUsd) || 0;
      allocUsed += Number(d.committedUsd) || 0;
      allocCap += Number(b.allocationUsd) || 0;
      wins += d.winCount || 0; deals += d.totalDeals || 0;
      if (b.mode === 'live') live++; else paper++;
      cards.push(botCardHtml(b, d));
    }
    var totalPnl = totalReal + totalUnreal;

    if (!shown.length) {
      panel.innerHTML = renderCockpitHero(0, 0, 0, 0, 0, 0, 0, bots.length, 0) +
        '<div class="bempty">No bots' + (modeFilter !== 'all' ? ' in ' + modeFilter + ' mode' : '') + ' yet.' +
        ' <button class="blink" id="b-empty-create">Create your first bot →</button></div>' +
        safetyNote();
      var ec = $('#b-empty-create'); if (ec) ec.addEventListener('click', function () { activeTab = 'create'; enter(); });
      drawHeroSpark([0]);
      return;
    }

    panel.innerHTML = renderCockpitHero(totalPnl, totalReal, totalUnreal, allocUsed, allocCap, deals ? wins / deals : null, deals, shown.length, 0, live, paper) +
      '<div class="bsec-head"><h3>Your bots</h3><span class="bcount">' + shown.length + '</span></div>' +
      '<div class="bgrid" id="b-grid">' + cards.join('') + '</div>' +
      safetyNote();

    $$('#b-grid .bcard').forEach(function (c) {
      var id = c.getAttribute('data-bot');
      var go = function () { selectedBotId = id; activeTab = 'detail'; enter(); };
      c.addEventListener('click', go);
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    });
    // sparklines (real cumulative-realized series)
    var heroPts = aggregateSeries(shown);
    drawHeroSpark(heroPts);
    $$('#b-grid .bcard').forEach(function (c) {
      var id = c.getAttribute('data-bot');
      var bot = runner.get(id);
      drawSpark(c.querySelector('canvas'), botSeries(bot), true);
    });
  }

  function aggregateSeries(bots) {
    // element-wise sum of per-bot cumulative-realized series (REAL data)
    var all = bots.map(botSeries);
    var len = all.reduce(function (m, s) { return Math.max(m, s.length); }, 1);
    var out = [];
    for (var i = 0; i < len; i++) {
      var v = 0;
      for (var j = 0; j < all.length; j++) v += (all[j][Math.min(i, all[j].length - 1)] || 0);
      out.push(v);
    }
    return out.length ? out : [0];
  }

  function renderCockpitHero(totalPnl, real, unreal, allocUsed, allocCap, winRate, deals, active, _x, live, paper) {
    return '' +
      '<div class="bhero card">' +
        '<span class="beyebrow">Portfolio P&amp;L · all bots</span>' +
        '<div class="bbig num ' + cls(totalPnl) + '">' + money(totalPnl) + '</div>' +
        '<div class="bsub">realized ' + money(real) + ' · unrealized ' + money(unreal) + '</div>' +
        '<div class="bspark"><canvas id="b-hero-spark"></canvas></div>' +
      '</div>' +
      '<div class="btiles">' +
        tile('Active bots', String(active), (paper || 0) + ' paper · ' + (live || 0) + ' live') +
        tile('Allocation in use', plain(allocUsed), 'of ' + plain(allocCap) + ' capped') +
        tile('Total P&L', money(real + unreal), 'across ' + deals + ' deals', cls(real + unreal)) +
        tile('Win rate', winRate == null ? '—' : pct01(winRate), deals + ' deals') +
      '</div>';
  }
  function tile(eyebrow, v, t, vcls) {
    return '<div class="btile"><div class="beyebrow">' + esc(eyebrow) + '</div><div class="bv num ' + (vcls || '') + '">' + esc(v) + '</div><div class="bt">' + esc(t) + '</div></div>';
  }

  // Exported-pure: a cockpit bot card from (bot, dashboard).
  function botCardHtml(bot, d) {
    d = d || {};
    var used = Number(d.committedUsd) || 0;
    var cap = Number(bot.allocationUsd) || 0;
    var pctUsed = cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0;
    var pnl = (Number(d.realizedUsd) || 0) + (Number(d.unrealizedUsd) || 0);
    var mode = bot.mode === 'live' ? 'live' : 'paper';
    var pair = (bot.pairs() && bot.pairs()[0]) || (bot.universe && bot.universe.pairs && bot.universe.pairs[0]) || '—';
    return '' +
      '<article class="bcard card" tabindex="0" data-bot="' + esc(bot.id) + '">' +
        '<div class="bcard-top"><div><div class="bcard-name">' + esc(bot.name) + '</div>' +
          '<div class="bcard-pair num">' + esc(pair) + '</div></div>' +
          '<span class="bbadge ' + mode + '"><span class="bd"></span>' + (mode === 'live' ? 'Live' : 'Paper') + '</span></div>' +
        '<div class="bchips"><span class="bchip type">' + esc(String(bot.type).toUpperCase()) + '</span>' +
          '<span class="bchip">' + (mode === 'live' ? 'auto · within cap' : 'simulated') + '</span></div>' +
        '<div class="balloc"><div class="balloc-row"><span>Allocation</span><span class="num">' + plain(used) + ' / ' + plain(cap) + '</span></div>' +
          '<div class="bbar"><span style="width:' + pctUsed + '%"></span></div></div>' +
        '<div class="bcard-foot"><div><div class="blabel">P&amp;L</div><div class="num ' + cls(pnl) + '" style="font-weight:650">' + money(pnl) + '</div></div>' +
          '<canvas class="bminispark"></canvas></div>' +
      '</article>';
  }

  // Exported-pure: the "Scan & trade (Autopilot)" card — the last scan's candidates
  // with scores + traded/skipped reasons, the allocation-used bar, and the kill. Reads
  // bot.state.lastScan (set by the BotRunner scanner tick). No DOM, no I/O.
  function scannerCardHtml(bot) {
    var scan = bot && bot.state && bot.state.lastScan;
    var cap = Number(bot.allocationUsd) || 0;
    var used = scan ? Number(scan.committedUsd) || 0 : 0;
    var pctUsed = cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0;
    var rows = '';
    var cands = (scan && scan.candidates) || [];
    if (!cands.length) {
      rows = '<li class="bstep"><span class="bring">•</span><div><div class="blead">No scan yet</div>' +
        '<div class="bmeta">the autopilot scans the discovery feed + venue pairs each tick (paper + disabled by default)</div></div></li>';
    } else {
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        var worthy = c.reason === 'worthy';
        var tag = worthy ? 'traded' : esc(String(c.reason));
        var ring = worthy ? '✓' : '○';
        rows += '<li class="bstep' + (worthy ? ' done' : '') + '"><span class="bring">' + ring + '</span>' +
          '<div><div class="blead num">' + esc(String(c.pair || '—')) + ' <span class="bchip">' + esc(String(c.strategy || '—')) + '</span></div>' +
          '<div class="bmeta num">score ' + esc(fmtBps(c.score)) + 'bps · edge ' + esc(fmtBps(c.edgeBps)) + 'bps · <b>' + tag + '</b></div></div></li>';
      }
    }
    var minBps = (scan && scan.minProfitBps != null) ? scan.minProfitBps : (bot.config && bot.config.minProfitBps);
    var profitCur = (scan && scan.profitCurrency) || (bot.config && bot.config.profitCurrency) || 'USDC';
    return '' +
      '<div class="bpane card">' +
        '<div class="bdt-head"><span class="beyebrow">Scan &amp; trade (Autopilot)</span>' +
          '<span class="bchip" id="b-profit-cur-chip" title="profit is realized &amp; take-profit exits settle into this">↳ settles ' + esc(String(profitCur).toUpperCase()) + '</span>' +
          '<button class="bkill" id="b-d-kill2" style="margin-left:auto">⏻ Kill</button></div>' +
        '<p class="bhint">Scores every discoverable pair; trades the worthy (score ≥ ' + esc(String(minBps)) + 'bps) up to ' +
          esc(String((bot.config && bot.config.maxConcurrentPairs) || 3)) + ' at $' + esc(String((bot.config && bot.config.perTradeUsd) || 20)) + ' each, within allocation. Take-profit exits settle into <b>' + esc(String(profitCur).toUpperCase()) + '</b>.</p>' +
        '<div class="bpnl-tile"><div class="beyebrow">Allocation used</div><div class="bv num">' + plain(used) + '<span style="color:var(--b-ink-faint);font-size:13px"> / ' + plain(cap) + '</span></div>' +
          '<div class="bbar" style="margin-top:8px"><span style="width:' + pctUsed + '%"></span></div></div>' +
        '<ol class="bsteps" style="margin-top:12px">' + rows + '</ol>' +
      '</div>';
  }
  function fmtBps(x) { var n = Number(x); return isFinite(n) ? (Math.round(n * 10) / 10).toString() : '0'; }

  function safetyNote() {
    return '<div class="bnote"><b>Non-custodial &amp; gated.</b> Keys never leave your device. Live bots trade <b>fully auto within their allocation cap</b> — no per-order tap inside the cap — but every order still passes session caps, the allowlist, the hash-chained audit, the 0.05% fee, and the kill switch. Mainnet stays off until you enable it.</div>';
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================
  var TPL_META = {
    conservative_dca: { icon: '🛡', ty: 'DCA' },
    aggressive_dca: { icon: '⚡', ty: 'DCA' },
    wide_grid: { icon: '▦', ty: 'Grid' },
    scalp_grid: { icon: '⚡', ty: 'Grid' },
    block_accumulator: { icon: '◆', ty: 'DCA' },
    scan_and_trade: { icon: '🛰', ty: 'Scanner' },
  };

  // The profit-currency <option> list, with the current selection marked.
  function profitCurOptions(sel) {
    sel = (sel || 'USDC').toUpperCase();
    return PROFIT_CURRENCIES.map(function (c) {
      return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
  }

  // Exported-pure: STEP 2 of the create flow — the pair-selection mode toggle plus
  // EITHER the profit-currency selector (AI chooses pairs; the manual pair picker is
  // HIDDEN) OR the manual pair picker ("I'll pick a pair"). Defaults to AI.
  function pairSelectHtml() {
    var ai = create.pairMode !== 'manual';
    var modeToggle =
      '<div class="bpairmode bseg" role="group" aria-label="Pair selection mode">' +
        '<button type="button" data-pairmode="ai" aria-pressed="' + ai + '">🤖 Let the AI choose pairs</button>' +
        '<button type="button" data-pairmode="manual" aria-pressed="' + (!ai) + '">✎ I\'ll pick a pair</button>' +
      '</div>';
    if (ai) {
      // AI chooses pairs: NO manual pair picker — a profit-currency selector instead.
      return '<div class="bfield" id="b-pair-field"><label>2 · Pairs <span class="fhint">the autopilot scans &amp; picks worthy pairs</span></label>' +
        modeToggle +
        '<div class="bhint" id="b-ai-note" style="margin:8px 0">The AI scanner scores every discoverable pair and auto-trades the worthy ones within your cap — no pair to pick. Paper + disabled by default.</div>' +
        '<label>Profit currency <span class="fhint">what profit is realized &amp; settled into</span></label>' +
        '<div class="bcontrol"><select id="b-profit-cur" class="num" aria-label="Profit currency">' + profitCurOptions(create.profitCurrency) + '</select>' +
          '<span class="bsuffix">settles P&amp;L</span></div></div>';
    }
    // Manual: the pair picker returns; profit currency derives from the pair quote.
    return '<div class="bfield" id="b-pair-field"><label>2 · Pair <span class="fhint">what to trade</span></label>' +
      modeToggle +
      '<div class="bcontrol"><input id="b-pair" value="' + esc(create.pair) + '" aria-label="Trading pair"><span class="bsuffix">BASE/QUOTE</span></div></div>';
  }

  // profit currency derived from a BASE/QUOTE pair's quote (manual mode).
  function quoteOf(pair) {
    try { return dep('AgentBots', './bots.js').splitPair(String(pair))[1].toUpperCase(); } catch (_) { return create.profitCurrency || 'USDC'; }
  }

  async function renderCreate(panel) {
    var T = dep('AgentBotTemplates', './bot-templates.js');
    var tpls = T.list();
    var cards = tpls.map(function (t) {
      var meta = TPL_META[t.key] || { icon: '●' };
      return '<button class="btpl" data-key="' + esc(t.key) + '" aria-pressed="' + (create.tplKey === t.key) + '">' +
        '<span class="btpl-nm"><span class="btpl-ic">' + meta.icon + '</span>' + esc(t.name) + '</span>' +
        '<span class="btpl-ds">' + esc(t.blurb) + '</span></button>';
    }).join('');

    panel.innerHTML = '' +
      '<div class="bpane card">' +
        '<h3>Create a bot</h3><p class="bhint">Pick a starting point, choose a pair, set one amount. Tune the rest under Advanced.</p>' +
        '<span class="beyebrow">1 · Template</span><div class="btpl-grid">' + cards + '</div>' +
        '<div class="bfield"><label>Lane <span class="fhint">one chain · one base asset</span></label>' +
          '<select id="b-lane" class="bselect" aria-label="Lane">' +
            '<option value="solana"' + (create.lane === 'solana' ? ' selected' : '') + '>Solana · hold SOL</option>' +
            '<option value="ethereum"' + (create.lane === 'ethereum' ? ' selected' : '') + '>Ethereum · hold ETH</option>' +
            '<option value="bsc"' + (create.lane === 'bsc' ? ' selected' : '') + '>BSC · hold BNB</option>' +
            '<option value="block"' + (create.lane === 'block' ? ' selected' : '') + '>BLOCK · hold BLOCK</option>' +
          '</select></div>' +
        '<div class="bfield"><label>Risk mode <span class="fhint">how aggressive</span></label>' +
          '<select id="b-riskmode" class="bselect" aria-label="Risk mode">' +
            '<option value="safe"' + (create.riskMode === 'safe' ? ' selected' : '') + '>Safe — large-cap only</option>' +
            '<option value="medium"' + (create.riskMode === 'medium' ? ' selected' : '') + '>Medium — mid-cap, balanced</option>' +
            '<option value="high"' + (create.riskMode === 'high' ? ' selected' : '') + '>High — microcap, social-driven</option>' +
            '<option value="sniper"' + (create.riskMode === 'sniper' ? ' selected' : '') + '>Sniper — brand-new launches</option>' +
          '</select>' +
          '<div id="b-risk-warn" class="bhint" style="color:var(--b-warn,#c47d00);margin-top:6px"></div></div>' +
        pairSelectHtml() +
        '<div class="bfield"><label>3 · Amount to allocate <span class="fhint">the bot\'s hard cap</span></label>' +
          '<div class="bcontrol"><span class="bcur">$</span><input id="b-alloc" class="num" value="' + esc(create.alloc) + '" inputmode="decimal" aria-label="Allocation in US dollars"><span class="bsuffix">USD</span></div></div>' +
        '<div class="bpreview" id="b-preview"></div>' +
        '<button class="badv-toggle" id="b-adv-toggle" aria-expanded="false">Advanced — safety orders, take-profit, trailing <span class="chev">▾</span></button>' +
        '<div class="badv" id="b-adv" hidden>' +
          miniRange('base', 'Base order', '$' + create.base, 25, 300, 25, create.base) +
          miniRange('tp', 'Take-profit', create.tp.toFixed(1) + '%', 0.5, 8, 0.5, create.tp) +
          miniRange('so', 'Safety orders', String(create.so), 0, 6, 1, create.so) +
          miniRange('step', 'Price step', create.step.toFixed(1) + '%', 0.5, 6, 0.5, create.step) +
          miniRange('vol', 'Volume scale', create.vol.toFixed(1) + '×', 1, 2.5, 0.1, create.vol) +
          miniRange('tr', 'Trailing', create.tr.toFixed(1) + '%', 0, 3, 0.2, create.tr) +
        '</div>' +
        '<div class="bactions"><button class="bbtn primary" id="b-start-paper">▶ Start in paper</button>' +
          '<button class="bbtn ghost" id="b-go-live">⚡ Go live…</button></div>' +
      '</div>' +
      '<div class="bpane card">' +
        '<div class="bladder-head"><div><span class="beyebrow">Deal preview</span><h3 id="b-ladder-title">' + esc(create.pair) + '</h3></div>' +
          '<span class="bchip type" id="b-ladder-type">DCA</span></div>' +
        '<div class="bladder"><canvas id="b-ladder"></canvas></div>' +
        '<div class="blegend"><span class="it"><span class="sw base"></span>◆ Base</span>' +
          '<span class="it"><span class="sw safety"></span>● Safety</span>' +
          '<span class="it"><span class="sw tp"></span>▲ Take-profit</span></div>' +
        '<div class="bladder-stats"><div><div class="beyebrow">Max deal size</div><div class="bv num" id="b-s-max">—</div></div>' +
          '<div><div class="beyebrow">Avg entry</div><div class="bv num" id="b-s-avg">—</div></div>' +
          '<div><div class="beyebrow">Covers a dip</div><div class="bv num" id="b-s-dip">—</div></div></div>' +
        '<div class="bmark-note num" id="b-mark-note"></div>' +
      '</div>';

    wireCreate();
    // fetch a live mark for the pair base (DISPLAY ONLY — the engine gets its own
    // real marks at tick time; the ladder preview uses this or a neutral anchor).
    await refreshCreateMark();
    renderCreatePreview();
  }

  function miniRange(key, label, valTxt, min, max, step, val) {
    return '<div class="bmini"><label>' + esc(label) + ' <span class="num" id="b-v-' + key + '">' + esc(valTxt) + '</span></label>' +
      '<input type="range" id="b-r-' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"></div>';
  }

  function wireCreate() {
    $$('.btpl').forEach(function (b) {
      b.addEventListener('click', function () {
        create.tplKey = b.getAttribute('data-key');
        applyTemplateDefaults(create.tplKey);
        enter();
      });
    });
    // pair-selection mode: AI chooses (default) vs manual pair picker.
    $$('[data-pairmode]').forEach(function (b) {
      b.addEventListener('click', function () {
        create.pairMode = b.getAttribute('data-pairmode');
        if (create.pairMode === 'manual') create.profitCurrency = quoteOf(create.pair); // derive from quote
        enter();
      });
    });
    var laneSel = $('#b-lane');
    if (laneSel) laneSel.addEventListener('change', function () {
      create.lane = laneSel.value;
      var B3 = dep('AgentBots', './bots.js');
      if (create.pairMode !== 'manual' && B3 && B3.laneBase) create.profitCurrency = B3.laneBase(create.lane) || create.profitCurrency;
    });
    var riskSel = $('#b-riskmode');
    function syncRiskWarn() {
      var el = $('#b-risk-warn'); if (!el) return;
      el.textContent = create.riskMode === 'sniper'
        ? 'Sniper trades brand-new microcaps — no track record, most go to zero. Risk only what you can lose.'
        : (create.riskMode === 'high' ? 'High mode trades volatile, hype-driven microcaps. High risk of loss.' : '');
    }
    if (riskSel) riskSel.addEventListener('change', function () { create.riskMode = riskSel.value; syncRiskWarn(); });
    syncRiskWarn();
    var pcur = $('#b-profit-cur');
    if (pcur) pcur.addEventListener('change', function () { create.profitCurrency = (pcur.value || 'USDC').toUpperCase(); });
    var pair = $('#b-pair');
    if (pair) pair.addEventListener('input', function () {
      create.pair = pair.value.toUpperCase();
      create.profitCurrency = quoteOf(create.pair);  // manual: profit currency = the pair quote
      refreshCreateMark().then(renderCreatePreview);
    });
    var alloc = $('#b-alloc');
    if (alloc) alloc.addEventListener('input', function () { var n = parseFloat(alloc.value); create.alloc = isFinite(n) ? n : 0; renderCreatePreview(); });
    var adv = $('#b-adv-toggle');
    if (adv) adv.addEventListener('click', function () {
      var d = $('#b-adv'); var open = d.hidden; d.hidden = !open;
      adv.setAttribute('aria-expanded', String(open));
    });
    var R = { base: 'base', tp: 'tp', so: 'so', step: 'step', vol: 'vol', tr: 'tr' };
    Object.keys(R).forEach(function (k) {
      var el = $('#b-r-' + k);
      if (el) el.addEventListener('input', function () { create[k] = parseFloat(el.value); renderCreatePreview(); });
    });
    var sp = $('#b-start-paper'); if (sp) sp.addEventListener('click', startPaper);
    var gl = $('#b-go-live'); if (gl) gl.addEventListener('click', openReviewSheet);
  }

  function applyTemplateDefaults(key) {
    var T = dep('AgentBotTemplates', './bot-templates.js');
    var t = T.TEMPLATES[key]; if (!t) return;
    create.type = t.type;
    if (t.type === 'dca') {
      var c = t.config;
      create.base = c.baseOrderUsd; create.so = c.maxSafetyOrders; create.step = c.safetyStepPct;
      create.vol = c.safetyVolumeScale; create.tp = c.takeProfitPct; create.tr = c.trailingTpPct || 0;
    }
    if (t.universe && t.universe.pairs && t.universe.pairs[0]) create.pair = t.universe.pairs[0];
  }

  async function refreshCreateMark() {
    create.markUsd = null;
    if (!runner) return;
    try {
      var B = runner.Bots, bq = B.splitPair(create.pair);
      var p = (await runner.ctx.prices([bq[0], bq[1]])) || {};
      var v = p[bq[0].toUpperCase()];
      if (v != null && isFinite(v) && v > 0) create.markUsd = Number(v);
    } catch (_) {}
  }

  // Exported-pure: the DCA deal-ladder math used by the preview chart + stats.
  function dealLadder(st, priceAnchor) {
    var price = priceAnchor || 100;
    var legs = [], size = st.base, step = st.step, totalQty = 0, totalUsd = 0, p = price;
    legs.push({ k: 'base', price: price, usd: size });
    totalQty += size / price; totalUsd += size;
    for (var i = 0; i < st.so; i++) {
      p = p * (1 - step / 100);
      size = size * st.vol;
      legs.push({ k: 'safety', price: p, usd: size });
      totalQty += size / p; totalUsd += size;
    }
    var avg = totalUsd / totalQty;
    var tp = avg * (1 + st.tp / 100);
    var dip = (price - p) / price * 100;
    return { legs: legs, avg: avg, tp: tp, totalUsd: totalUsd, dip: dip, lo: p, hi: tp };
  }

  function renderCreatePreview() {
    var T = dep('AgentBotTemplates', './bot-templates.js');
    var vset = { base: '$' + create.base, tp: create.tp.toFixed(1) + '%', so: String(create.so), step: create.step.toFixed(1) + '%', vol: create.vol.toFixed(1) + '×', tr: create.tr.toFixed(1) + '%' };
    Object.keys(vset).forEach(function (k) { var el = $('#b-v-' + k); if (el) el.textContent = vset[k]; });
    var B = runner && runner.Bots;
    var base = 'the base asset';
    try { base = B.splitPair(create.pair)[0]; } catch (_) {}
    var lt = $('#b-ladder-title'); if (lt) lt.textContent = create.pair;
    var lty = $('#b-ladder-type'); if (lty) lty.textContent = String(create.type).toUpperCase();

    var trail = create.tr > 0 ? (' with a ' + create.tr.toFixed(1) + '% trailing stop') : '';
    var pv = $('#b-preview');
    if (pv) pv.innerHTML = 'Buys <b>$' + create.base + '</b> of <b>' + esc(base) + '</b> now, then adds up to <span class="num">' + create.so +
      '</span> more time' + (create.so === 1 ? '' : 's') + ' if price dips (every <span class="num">' + create.step.toFixed(1) +
      '%</span>). Takes profit at <span class="num">+' + create.tp.toFixed(1) + '%</span> from the average entry' + trail +
      '. Capped at <b>' + plain(create.alloc) + '</b>.';

    var d = dealLadder(create, create.markUsd || 100);
    var sm = $('#b-s-max'); if (sm) sm.textContent = plain(Math.round(d.totalUsd));
    var sa = $('#b-s-avg'); if (sa) sa.textContent = create.markUsd ? '$' + d.avg.toFixed(2) : '—';
    var sd = $('#b-s-dip'); if (sd) sd.textContent = '−' + d.dip.toFixed(1) + '%';
    var mn = $('#b-mark-note');
    if (mn) mn.textContent = create.markUsd ? ('live mark $' + create.markUsd.toFixed(4)) : 'no live mark for this pair — preview uses a neutral anchor; the bot only trades when a real mark is available';
    drawLadder(create.markUsd || 100);
  }

  async function startPaper() {
    if (!runner) return UI.toast('Unlock first');
    try {
      var spec = specFromCreate();
      var bot = runner.add(spec);
      await runner.enablePaper(bot.id, { allocationUsd: Number(create.alloc) || 0 });
      selectedBotId = bot.id;
      UI.toast('Paper bot started');
      activeTab = 'cockpit'; enter();
    } catch (e) { UI.toast(e.message || String(e)); }
  }

  // ===========================================================================
  // REVIEW SHEET — the one deliberate moment (paper->live / testnet->mainnet).
  // Restates allocation + auto-within-cap + kill + mainnet before ONE confirm.
  // Exported-pure text builder for the test.
  // ===========================================================================
  function reviewSheetText(opts) {
    opts = opts || {};
    var alloc = Number(opts.allocationUsd) || 0;
    var net = opts.network === 'mainnet' ? 'mainnet' : 'testnet';
    var lines = [
      'Allocation cap: ' + plain(alloc) + ' — the hard limit on this bot\'s live spend (trade + 0.05% fee). It can never exceed this.',
      'Fully auto within the cap: orders run with NO further taps as long as they stay inside the allocation AND your session caps.',
      'Kill switch: Kill all stops every bot, cancels open orders, and locks the wallet.',
      net === 'mainnet'
        ? 'MAINNET: real funds. Requires mainnetEnabled (operator sign-off) — off by default.'
        : 'Network: testnet — no real funds move. Switching to mainnet is a separate, explicit step.',
    ];
    return lines;
  }

  function openReviewSheet() {
    var sheet = $('#bots-sheet');
    if (!sheet) return;
    var spec;
    try { spec = specFromCreate(); } catch (e) { return UI.toast(e.message || String(e)); }
    var alloc = Number(create.alloc) || 0;
    var net = spec.network || 'testnet';
    var warn = '';
    if (!(alloc > 0)) warn = 'Set an allocation greater than $0 to go live (fail-closed).';
    else if (!(alloc <= SESSION_CAP_USD)) warn = 'Allocation exceeds the session cap of ' + plain(SESSION_CAP_USD) + '.';
    var lines = reviewSheetText({ allocationUsd: alloc, network: net });
    sheet.innerHTML = '' +
      '<div class="bsheet-backdrop" id="b-sheet-x"></div>' +
      '<div class="bsheet card" role="dialog" aria-label="Review before going live">' +
        '<div class="bsheet-h">Go live — review</div>' +
        '<p class="bhint">' + esc(spec.name) + ' · ' + esc(create.pair) + '</p>' +
        '<ul class="bsheet-list">' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
        (warn ? '<div class="berr">' + esc(warn) + '</div>' : '') +
        '<div class="bactions"><button class="bbtn ghost" id="b-sheet-cancel">Cancel</button>' +
        '<button class="bbtn primary" id="b-sheet-confirm"' + (warn ? ' disabled' : '') + '>Arm live bot</button></div>' +
      '</div>';
    var close = function () { sheet.innerHTML = ''; };
    var x = $('#b-sheet-x'); if (x) x.addEventListener('click', close);
    var c = $('#b-sheet-cancel'); if (c) c.addEventListener('click', close);
    var ok = $('#b-sheet-confirm');
    if (ok && !warn) ok.addEventListener('click', async function () {
      ok.disabled = true;
      try {
        var bot = runner.add(spec);
        await runner.armLive(bot.id, { allocationUsd: alloc });
        selectedBotId = bot.id;
        close();
        UI.toast('Live bot armed · ' + plain(alloc) + ' cap');
        activeTab = 'detail'; enter();
      } catch (e) { UI.toast(e.message || String(e)); ok.disabled = false; }
    });
  }

  // ===========================================================================
  // BOT DETAIL
  // ===========================================================================
  async function renderDetail(panel) {
    var bots = runner ? runner.list() : [];
    if (!selectedBotId && bots.length) selectedBotId = bots[0].id;
    var bot = selectedBotId && runner ? runner.get(selectedBotId) : null;
    if (!bot) { panel.innerHTML = '<div class="bempty">No bot selected. <button class="blink" id="b-d-create">Create one →</button></div>'; var dc = $('#b-d-create'); if (dc) dc.addEventListener('click', function () { activeTab = 'create'; enter(); }); return; }

    var marks = await currentMarks();
    var d = runner.dashboard(bot.id, marks) || {};
    var mode = bot.mode === 'live' ? 'live' : 'paper';
    var pair = (bot.pairs() && bot.pairs()[0]) || '—';
    var used = Number(d.committedUsd) || 0, cap = Number(bot.allocationUsd) || 0;
    var pctUsed = cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0;

    panel.innerHTML = '' +
      '<div class="bpane card">' +
        '<div class="bdt-head"><span class="bchip type">' + esc(String(bot.type).toUpperCase()) + '</span>' +
          '<h3>' + esc(bot.name) + '</h3><span class="bbadge ' + mode + '" style="margin-left:auto"><span class="bd"></span>' + (mode === 'live' ? 'Live' : 'Paper') + '</span></div>' +
        '<p class="bhint num">' + esc(pair) + ' · ' + esc(bot.network) + ' · ' + esc(d.status || '') + '</p>' +
        '<ol class="bsteps">' + dealStepsHtml(bot, d) + '</ol>' +
        '<div class="bctrls">' +
          (bot.enabled ? '<button class="bbtn ghost" id="b-d-pause">Pause</button>' : '<button class="bbtn ghost" id="b-d-resume">Resume (paper)</button>') +
          '<button class="bbtn ghost" id="b-d-clone">Clone</button>' +
          '<button class="bbtn ghost" id="b-d-edit">Edit</button>' +
          '<button class="bbtn ghost" id="b-d-remove">Delete</button>' +
          '<button class="bkill" id="b-d-kill" style="margin-left:auto">⏻ Stop bot</button>' +
        '</div>' +
      '</div>' +
      (bot.type === 'scanner' ? scannerCardHtml(bot) : '') +
      '<div class="bpane card">' +
        '<span class="beyebrow">Performance</span>' +
        '<div class="bpnl-tiles">' +
          '<div class="bpnl-tile"><div class="beyebrow">Unrealized</div><div class="bv num ' + cls(d.unrealizedUsd) + '">' + money(d.unrealizedUsd) + '</div></div>' +
          '<div class="bpnl-tile"><div class="beyebrow">Realized (' + (d.totalDeals || 0) + ' deals)</div><div class="bv num ' + cls(d.realizedUsd) + '">' + money(d.realizedUsd) + '</div></div>' +
          '<div class="bpnl-tile"><div class="beyebrow">Allocation used</div><div class="bv num">' + plain(used) + '<span style="color:var(--b-ink-faint);font-size:13px"> / ' + plain(cap) + '</span></div><div class="bbar" style="margin-top:8px"><span style="width:' + pctUsed + '%"></span></div></div>' +
          '<div class="bpnl-tile"><div class="beyebrow">Win rate</div><div class="bv num">' + (d.winRate == null ? '—' : pct01(d.winRate)) + '</div><div class="bt">' + (d.winCount || 0) + ' of ' + (d.totalDeals || 0) + ' · max DD ' + (d.maxDrawdownUsd != null ? plain(Math.abs(d.maxDrawdownUsd)) : '—') + '</div></div>' +
        '</div>' +
        '<div class="bnote" style="margin-top:14px"><b>Profit pop-ups are on.</b> When a deal closes into a stablecoin in profit you get a notification.</div>' +
      '</div>';

    var pause = $('#b-d-pause'); if (pause) pause.addEventListener('click', async function () { await runner.pause(bot.id); UI.toast('Paused'); enter(); });
    var resume = $('#b-d-resume'); if (resume) resume.addEventListener('click', async function () { await runner.enablePaper(bot.id); UI.toast('Resumed (paper)'); enter(); });
    var clone = $('#b-d-clone'); if (clone) clone.addEventListener('click', async function () {
      try { var T = dep('AgentBotTemplates', './bot-templates.js'); var b = runner.add(T.importTemplate(T.exportBot(bot))); UI.toast('Cloned as paper'); selectedBotId = b.id; enter(); } catch (e) { UI.toast(e.message || String(e)); }
    });
    var edit = $('#b-d-edit'); if (edit) edit.addEventListener('click', function () { activeTab = 'create'; enter(); });
    var remove = $('#b-d-remove'); if (remove) remove.addEventListener('click', async function () {
      if (!global.confirm('Delete this bot? Its open orders are cancelled and it is removed permanently.')) return;
      await runner.remove(bot.id);
      if (selectedBotId === bot.id) selectedBotId = null;
      UI.toast('Bot deleted'); enter();
    });
    var kill = $('#b-d-kill'); if (kill) kill.addEventListener('click', async function () {
      if (!global.confirm('Stop this bot? (Use Kill all to also lock the wallet.)')) return;
      await runner.pause(bot.id); UI.toast('Bot stopped'); enter();
    });
    // the scanner card's dedicated kill: KILL-ALL (stop every bot + lock the wallet).
    var kill2 = $('#b-d-kill2'); if (kill2) kill2.addEventListener('click', killAll);
  }

  // vertical deal stepper from the open deal's fills + armed next step
  function dealStepsHtml(bot, d) {
    var B = runner && runner.Bots;
    var pair = (bot.pairs() && bot.pairs()[0]);
    var ps = pair && bot.state.byPair[pair];
    var deal = ps && ps.deal;
    if (!deal) return '<li class="bstep"><span class="bring">•</span><div><div class="blead">No open deal</div><div class="bmeta">waiting for a start condition / mark</div></div></li>';
    var items = [];
    var fills = deal.fills || [];
    for (var i = 0; i < fills.length; i++) {
      var f = fills[i];
      var price = B ? B.ucToUsd(typeof f.priceUc === 'bigint' ? f.priceUc : BigInt(f.priceUc || 0)) : 0;
      var label = f.kind === 'base' ? 'Base order filled' : f.kind === 'safety' ? 'Safety order filled' : f.kind === 'tp' ? 'Take-profit sold' : f.kind === 'sl' ? 'Stop-loss sold' : (f.side + ' ' + f.kind);
      items.push('<li class="bstep done"><span class="bring">✓</span><div><div class="blead">' + esc(label) + '</div><div class="bmeta num">@ $' + Number(price).toFixed(4) + (f.paper ? ' · paper' : '') + '</div></div></li>');
    }
    // the next armed step
    if (deal.status !== 'closed') {
      if (deal.type === 'dca' || deal.type === undefined) {
        var avg = B ? B.ucToUsd(deal.avgEntryUc) : 0;
        var trig = B ? B.ucToUsd(deal.nextTriggerUc) : 0;
        if (deal.safetyOrdersUsed < (bot.config.maxSafetyOrders || 0)) {
          items.push('<li class="bstep active"><span class="bring">' + (deal.safetyOrdersUsed + 1) + '</span><div><div class="blead">Safety order ' + (deal.safetyOrdersUsed + 1) + ' armed</div><div class="bmeta num">triggers at $' + Number(trig).toFixed(4) + '</div></div></li>');
        }
        items.push('<li class="bstep"><span class="bring">▲</span><div><div class="blead">Take-profit</div><div class="bmeta num">+' + bot.config.takeProfitPct + '% from avg $' + Number(avg).toFixed(4) + '</div></div></li>');
      } else {
        items.push('<li class="bstep active"><span class="bring">●</span><div><div class="blead">Managing position</div><div class="bmeta">' + esc(bot.describe ? bot.describe() : '') + '</div></div></li>');
      }
    }
    return items.join('');
  }

  // ===========================================================================
  // ARENA — play-money sandbox (AgentArena). No keys/gate/broadcast.
  // ===========================================================================
  async function ensureArena() {
    if (arena && arena.vectors) return arena;
    var A = dep('AgentArena', './arena.js');
    var vectors = null;
    try {
      if (typeof fetch === 'function') {
        var r = await fetch('agent/arena-vectors.json');
        if (r && r.ok) vectors = await r.json();
      }
    } catch (_) {}
    if (!vectors && typeof require === 'function') { try { vectors = require('./arena-vectors.json'); } catch (_) {} }
    arena = {
      profile: new A.ArenaProfile(), vectors: vectors, scen: 'bull', last: null,
      // ARENA MODE — 'live' (play money on REAL marks, DEFAULT) vs 'demo' (fixed
      // fixture replay, the cross-wallet parity contract). liveMarks accumulates the
      // real marks sampled from ctx.prices; liveResult is the latest runLive output.
      mode: 'live', liveMarks: [], liveResult: null, liveTimer: 0,
    };
    return arena;
  }

  async function renderArena(panel) {
    var A = dep('AgentArena', './arena.js');
    await ensureArena();
    var lvl = arena.profile.level();
    var xpToNext = lvl.xpToNext || 0;
    var xpSpan = xpToNext + (lvl.xp - 0);
    var xpPct = lvl.nextLevel ? Math.min(100, Math.round((lvl.xp / (lvl.xp + xpToNext || 1)) * 100)) : 100;
    var playBal = arena.profile.playBalance;
    var balUsd = A && runner ? Number(runner.Bots.ucToUsd(playBal.balanceUc)) : Number(playBal.balanceUc) / 1e6;

    panel.innerHTML = '' +
      '<div class="barena-top">' +
        '<div class="bplaybal"><span class="bcoin">🪙</span><div><div class="bplay-t">Play balance</div><div class="bv num" id="b-playbal">' + balUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }) + '</div></div></div>' +
        '<div class="blvl"><div class="blvl-row"><b>Lv ' + lvl.level + '</b><span class="num">' + lvl.xp + ' XP' + (lvl.nextLevel ? ' · ' + xpToNext + ' to Lv ' + lvl.nextLevel : '') + '</span></div>' +
          '<div class="bbar"><span style="width:' + xpPct + '%"></span></div></div>' +
      '</div>' +
      arenaMarketPaneHtml(A) +
      '<div class="bpane card">' +
        missionHtml(A) +
        '<div style="margin-top:16px"><span class="beyebrow">Badges</span><div class="bbadges">' + badgesHtml(A) + '</div></div>' +
        '<div style="margin-top:16px"><span class="beyebrow">Leaderboard · local</span>' + leaderboardHtml() + '</div>' +
        '<div class="bdisclaim" style="margin-top:8px">Global leaderboard &amp; shareable runs — coming later.</div>' +
        '<button class="bbtn primary" id="b-use-real" style="width:100%;justify-content:center;margin-top:14px">✓ Use this strategy for real (starts in paper)</button>' +
      '</div>';

    // mode toggle (Live market vs Demo scenario) — stop any live poll on switch.
    $$('[data-arenamode]').forEach(function (b) {
      b.addEventListener('click', function () { stopLivePoll(); arena.mode = b.getAttribute('data-arenamode'); enter(); });
    });
    var useReal = $('#b-use-real'); if (useReal) useReal.addEventListener('click', useForReal);
    var mc = $('#b-mission-create'); if (mc) mc.addEventListener('click', function () { activeTab = 'create'; enter(); });

    if (arena.mode === 'demo') {
      // DEMO SCENARIO — the fixed-fixture replay (cross-wallet parity contract).
      $$('.bscen button').forEach(function (b) {
        b.addEventListener('click', function () { arena.scen = b.getAttribute('data-scen'); enter(); });
      });
      var run = $('#b-run'); if (run) run.addEventListener('click', runArena);
      // Preserve the most recent run's chart + score across re-renders.
      if (arena.last && arena.last.scenario === arena.scen) {
        drawSim(simPath(), arena.last, simPath().length - 1);
        setSimScore(arena.last);
        var st = $('#b-sim-state'); if (st) st.textContent = 'Done · ' + (arena.last.score >= 0 ? '+' : '') + arena.last.score.toFixed(1);
      } else {
        drawSimIdle();
      }
    } else {
      // LIVE MARKET (play money) — tick the strategy on REAL marks from ctx.prices.
      var resetBtn = $('#b-live-reset'); if (resetBtn) resetBtn.addEventListener('click', function () { arena.liveMarks = []; arena.liveResult = null; enter(); });
      renderLiveResult();
      startLivePoll();
    }
  }

  // ===========================================================================
  // ARENA · LIVE MARKET pane (play money on REAL marks) vs DEMO SCENARIO pane.
  // ===========================================================================
  function arenaModeToggleHtml() {
    var live = arena.mode !== 'demo';
    return '<div class="barena-mode bseg" role="group" aria-label="Arena market mode">' +
      '<button type="button" data-arenamode="live" aria-pressed="' + live + '">Live market <span class="play-pill">PLAY</span></button>' +
      '<button type="button" data-arenamode="demo" aria-pressed="' + (!live) + '">Demo scenario</button>' +
    '</div>';
  }

  function arenaMarketPaneHtml(A) {
    if (arena.mode === 'demo') {
      return '<div class="bpane card">' +
        '<div class="bladder-head"><div><span class="beyebrow">Demo scenario · fixed fixture, seeded &amp; replayable</span><h3>Your strategy · ' + esc(create.pair) + '</h3></div><span class="bchip type" id="b-sim-state">Ready</span></div>' +
        arenaModeToggleHtml() +
        '<div class="bscen" role="group" aria-label="Market scenario">' +
          scenBtn('bull', '📈 Bull') + scenBtn('crab', '🦀 Crab') + scenBtn('bear', '📉 Bear') + scenBtn('crash', '💥 Flash-crash') + scenBtn('pump', '🚀 Pump') +
        '</div>' +
        '<div class="bsimwrap"><canvas id="b-sim"></canvas></div>' +
        '<div class="bsim-foot"><button class="bbtn primary" id="b-run">▶ Run simulation</button>' +
          scoreTilesHtml() + '</div>' +
        '<div class="bdisclaim">⚠ ' + esc(A.DISCLAIMER) + '</div>' +
      '</div>';
    }
    // LIVE MARKET (play money) — real marks, no scenario picker.
    return '<div class="bpane card">' +
      '<div class="bladder-head"><div><span class="beyebrow">Live market · play money on REAL marks</span><h3>Your strategy · ' + esc(create.pair) + '</h3></div><span class="bchip type" id="b-sim-state">Awaiting data…</span></div>' +
      arenaModeToggleHtml() +
      '<div class="bhint" id="b-live-note" style="margin:8px 0">Ticks your strategy on the SAME live marks the real bots use — play balances only. It never broadcasts and never touches real funds. A market with no data is skipped (awaiting data); prices are never invented.</div>' +
      '<div class="bsimwrap"><canvas id="b-sim"></canvas></div>' +
      '<div class="bsim-foot"><button class="bbtn ghost" id="b-live-reset">↻ Reset play run</button>' +
        scoreTilesHtml() + '</div>' +
      '<div class="bdisclaim">⚠ ' + esc(A.DISCLAIMER) + '</div>' +
    '</div>';
  }
  function scoreTilesHtml() {
    return '<div class="bscore"><div><div class="beyebrow">Play P&amp;L</div><div class="bv num" id="b-sim-pnl">+$0.00</div></div>' +
      '<div><div class="beyebrow">Score</div><div class="bv num" id="b-sim-score">—</div></div>' +
      '<div><div class="beyebrow">Max DD</div><div class="bv num" id="b-sim-dd">—</div></div></div>';
  }

  // Sample the CURRENT real mark for the create.pair base from ctx.prices (the same
  // source the live bots + scanner use), append it (or null when NO data), re-run
  // the PURE play-money engine on the accumulated marks, and redraw. NEVER broadcasts.
  async function liveTick() {
    var A = dep('AgentArena', './arena.js');
    if (!arena || arena.mode === 'demo') return;
    var base = null;
    try { base = runner.Bots.splitPair(create.pair)[0].toUpperCase(); } catch (_) {}
    var mark = null;
    if (runner && base) {
      try { var p = (await runner.ctx.prices([base])) || {}; var v = p[base]; if (v != null && isFinite(v) && v > 0) mark = Number(v); } catch (_) {}
    }
    arena.liveMarks.push(mark); // null => awaiting data this tick (never fabricated)
    if (arena.liveMarks.length > 600) arena.liveMarks.shift();
    try { arena.liveResult = A.runLive({ bot: arenaBotSpec(), marks: arena.liveMarks }); } catch (_) { arena.liveResult = null; }
    renderLiveResult();
  }
  function renderLiveResult() {
    var res = arena.liveResult;
    var st = $('#b-sim-state');
    var marks = (arena && arena.liveMarks) || [];
    var series = marks.filter(function (m) { return m != null && isFinite(m) && m > 0; });
    if (!res || !series.length) {
      if (st) st.textContent = 'Awaiting data…';
      drawSim(series.length > 1 ? series : [1, 1], null, null);
      return;
    }
    if (st) st.textContent = 'Live · ' + (res.score >= 0 ? '+' : '') + res.score.toFixed(1);
    drawSim(series.length > 1 ? series : [series[0], series[0]], null, null);
    setSimScore(res);
  }
  function startLivePoll() {
    stopLivePoll();
    if (!arena || arena.mode === 'demo') return;
    if (typeof setInterval !== 'function') { liveTick(); return; }
    liveTick();
    arena.liveTimer = setInterval(function () { if (activeTab === 'arena' && arena && arena.mode !== 'demo') liveTick(); else stopLivePoll(); }, 5000);
  }
  function stopLivePoll() {
    if (arena && arena.liveTimer) { try { clearInterval(arena.liveTimer); } catch (_) {} arena.liveTimer = 0; }
  }

  function scenBtn(id, label) { return '<button data-scen="' + id + '" aria-pressed="' + (arena.scen === id) + '">' + label + '</button>'; }

  function missionHtml(A) {
    var done = arena.profile.missionsCompleted;
    var m = null;
    for (var i = 0; i < A.MISSIONS.length; i++) { if (!done.has(A.MISSIONS[i].id)) { m = A.MISSIONS[i]; break; } }
    if (!m) m = A.MISSIONS[0];
    return '<h3 style="display:flex;align-items:center;gap:8px">🎯 Mission <span class="bchip" style="margin-left:auto">+' + m.rewardXp + ' XP</span></h3>' +
      '<div class="bhint" style="margin:7px 0 10px">' + esc(m.desc) + '</div>' +
      '<button class="bbtn ghost" id="b-mission-create" style="width:100%;justify-content:center">Design your strategy →</button>';
  }
  function badgesHtml(A) {
    var have = arena.profile.badges;
    return A.BADGES.map(function (bd) {
      var earned = have.has(bd.id);
      var ic = { first_run: '🎓', green_run: '🟢', high_score: '🎯', diamond_hands: '💎', all_scenarios: '🌍', veteran: '🎖' }[bd.id] || '🏅';
      return '<div class="bbadge2' + (earned ? '' : ' locked') + '" title="' + esc(bd.name + ' — ' + bd.desc) + '">' + ic + '</div>';
    }).join('');
  }
  function leaderboardHtml() {
    var rows = arena.profile.leaderboard.top(arena.scen, 6);
    if (!rows.length) return '<div class="bhint">No runs on this scenario yet — run one to set a personal best.</div>';
    return '<ol class="blb">' + rows.map(function (e, i) {
      var sc = (Number(e.scoreTenths) / 10);
      return '<li><span class="brk">' + (i + 1) + '</span><span class="me">you · ' + esc(e.type || '') + '</span><span class="sc num ' + cls(sc) + '">' + (sc >= 0 ? '+' : '') + sc.toFixed(1) + '</span></li>';
    }).join('') + '</ol>';
  }

  async function runArena() {
    var A = dep('AgentArena', './arena.js');
    await ensureArena();
    if (!arena.vectors) { UI.toast('Scenario data unavailable'); return; }
    var st = $('#b-sim-state'); if (st) st.textContent = 'Running…';
    var outcome;
    try {
      outcome = arena.profile.run({ scenario: arena.scen, vectors: arena.vectors, bot: arenaBotSpec() });
    } catch (e) { UI.toast(e.message || String(e)); if (st) st.textContent = 'Error'; return; }
    arena.last = outcome.result;
    animateSim(outcome.result, function () {
      setSimScore(outcome.result);
      if (st) st.textContent = 'Done · ' + (outcome.result.score >= 0 ? '+' : '') + outcome.result.score.toFixed(1);
      // refresh xp/level/badges/leaderboard without clobbering the canvas mid-anim
      enter();
    });
  }

  function setSimScore(res) {
    var B = runner && runner.Bots;
    var pnl = B ? Number(B.ucToUsd(res.finalPnlUc)) : Number(res.finalPnlUc) / 1e6;
    var p = $('#b-sim-pnl'); if (p) { p.textContent = money(pnl); p.className = 'bv num ' + cls(pnl); }
    var s = $('#b-sim-score'); if (s) { s.textContent = (res.score >= 0 ? '+' : '') + res.score.toFixed(1); s.className = 'bv num ' + cls(res.score); }
    var dd = $('#b-sim-dd'); if (dd) dd.textContent = '−' + (Number(res.ddTenthPct) / 10).toFixed(1) + '%';
  }

  async function useForReal() {
    var A = dep('AgentArena', './arena.js');
    if (!runner) return UI.toast('Unlock first');
    try {
      var bot = A.useForReal(arenaBotSpec()); // ALWAYS paper + disabled + testnet
      runner.add(bot);
      selectedBotId = bot.id;
      UI.toast('Added as a paper bot (disabled) — review + arm it when ready');
      activeTab = 'cockpit'; enter();
    } catch (e) { UI.toast(e.message || String(e)); }
  }

  // ===========================================================================
  // canvas helpers (ported from the design reference; no-op without a 2d context)
  // ===========================================================================
  function cssv(n) {
    try { return getComputedStyle(document.querySelector('.bots-root') || document.documentElement).getPropertyValue(n).trim() || fallbackVar(n); }
    catch (_) { return fallbackVar(n); }
  }
  function fallbackVar(n) {
    var m = { '--b-gain': '#2fd39b', '--b-loss': '#f0536a', '--b-accent': '#4c8dff', '--b-k-base': '#4c8dff', '--b-k-safety': '#f0a732', '--b-k-tp': '#2fd39b', '--b-line-soft': '#1f2932', '--b-ink-faint': '#5d6b79', '--b-ink-muted': '#8795a4', '--b-surface': '#141b24' };
    return m[n] || '#4c8dff';
  }
  function fit(cv) {
    if (!cv || typeof cv.getContext !== 'function') return null;
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: cv.width || 280, height: cv.height || 120 };
    var w = r.width || cv.width || 280, h = r.height || cv.height || 120;
    if (!w) return null;
    var d = Math.max(1, (global.devicePixelRatio || 1));
    cv.width = w * d; cv.height = h * d;
    var ctx = cv.getContext('2d'); if (!ctx) return null;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function drawSpark(cv, data, up) {
    var f = fit(cv); if (!f) return; var ctx = f.ctx, w = f.w, h = f.h, pad = 3;
    if (!data || data.length < 2) return;
    var min = Math.min.apply(null, data), max = Math.max.apply(null, data), rng = (max - min) || 1;
    var col = up ? cssv('--b-gain') : cssv('--b-loss');
    var X = function (i) { return pad + i / (data.length - 1) * (w - pad * 2); };
    var Y = function (v) { return h - pad - (v - min) / rng * (h - pad * 2); };
    ctx.beginPath(); ctx.moveTo(X(0), Y(data[0]));
    for (var i = 1; i < data.length; i++) ctx.lineTo(X(i), Y(data[i]));
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  }
  function drawHeroSpark(data) { drawSpark($('#b-hero-spark'), data, (data[data.length - 1] || 0) >= 0); }

  function drawLadder(price) {
    var cv = $('#b-ladder'); var f = fit(cv); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h, padL = 46, padR = 12, padT = 12, padB = 18;
    var d = dealLadder(create, price);
    var lo = Math.min(d.lo, d.avg) * 0.995, hi = d.hi * 1.004, rng = (hi - lo) || 1;
    var Y = function (v) { return padT + (hi - v) / rng * (h - padT - padB); };
    var plotW = w - padL - padR;
    ctx.font = '10px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var val = lo + rng * g / 4, y = Y(val);
      ctx.strokeStyle = cssv('--b-line-soft'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = cssv('--b-ink-faint'); ctx.fillText('$' + val.toFixed(1), padL - 6, y);
    }
    function marker(y, color, label) {
      ctx.strokeStyle = color; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW * 0.6, y); ctx.stroke();
      ctx.fillStyle = cssv('--b-ink-muted'); ctx.textAlign = 'left'; ctx.font = '10px monospace';
      ctx.fillText(label, padL + plotW * 0.6 + 8, y);
      ctx.textAlign = 'right';
    }
    marker(Y(d.tp), cssv('--b-k-tp'), 'TP +' + create.tp.toFixed(1) + '%');
    d.legs.forEach(function (lg, i) { marker(Y(lg.price), lg.k === 'base' ? cssv('--b-k-base') : cssv('--b-k-safety'), lg.k === 'base' ? 'Base' : 'SO' + i); });
  }

  function simPath() {
    if (!arena || !arena.vectors) return [100];
    try { return dep('AgentArena', './arena.js').pricePath(arena.vectors, arena.scen); } catch (_) { return [100]; }
  }
  function drawSimIdle() { drawSim(simPath(), null, (simPath().length - 1)); }
  function drawSim(path, res, upto) {
    var cv = $('#b-sim'); var f = fit(cv); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h, padL = 40, padR = 12, padT = 10, padB = 14;
    var N = path.length, lo = Math.min.apply(null, path), hi = Math.max.apply(null, path), rng = (hi - lo) || 1;
    lo -= rng * 0.08; hi += rng * 0.08; rng = hi - lo;
    var X = function (i) { return padL + i / (N - 1) * (w - padL - padR); };
    var Y = function (v) { return padT + (hi - v) / rng * (h - padT - padB); };
    var up = upto == null ? N - 1 : upto;
    ctx.beginPath(); ctx.moveTo(X(0), Y(path[0]));
    for (var i = 1; i <= up; i++) ctx.lineTo(X(i), Y(path[i]));
    ctx.strokeStyle = cssv('--b-accent'); ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
    if (res && res.fills) {
      res.fills.forEach(function (fl) {
        if (fl.t > up) return;
        var x = X(fl.t), y = Y(Number(fl.priceUc) / 1e6);
        ctx.fillStyle = fl.side === 'buy' ? cssv('--b-k-base') : cssv('--b-k-tp');
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
      });
    }
  }
  function animateSim(res, done) {
    var path = simPath(), N = path.length;
    var reduce = false; try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    if (reduce || typeof requestAnimationFrame !== 'function') { drawSim(path, res, N - 1); if (done) done(); return; }
    var i = 0;
    var step = function () {
      i += 2; if (i >= N - 1) i = N - 1;
      drawSim(path, res, i);
      if (i < N - 1) raf = requestAnimationFrame(step); else { raf = 0; if (done) done(); }
    };
    raf = requestAnimationFrame(step);
  }
  function stopAnim() { if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); raf = 0; stopLivePoll(); }

  // ===========================================================================
  global.BotsUI = {
    init: init, enter: enter, onUnlock: onUnlock, onResume: onResume, onLock: onLock,
    // pure helpers (DOM-level test + reuse)
    makePriceAccessor: makePriceAccessor,
    dealLadder: dealLadder,
    reviewSheetText: reviewSheetText,
    botCardHtml: botCardHtml,
    scannerCardHtml: scannerCardHtml,
    pairSelectHtml: pairSelectHtml,
    specFromCreate: specFromCreate,
    money: money,
    _setRunner: function (r) { runner = r; },
    _state: function () { return { activeTab: activeTab, modeFilter: modeFilter, create: create }; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.BotsUI;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
