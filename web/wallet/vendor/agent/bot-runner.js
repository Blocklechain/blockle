// agent/bot-runner.js — the BotRunner: ticks enabled bots, runs their deal-engine
// state machines (bots.js), and routes every LIVE order through the SAME value-
// moving dispatch as the NL runner and the StrategyRunner (runner.js
// dispatchValueMoving). There is exactly ONE commit path — no second broadcast
// path exists. See docs/BLOCKLE-BOTS.md §2-6.
//
// THE FULLY-AUTO-WITHIN-ALLOCATION GATE (§5), made non-bypassable:
//   • `allocationUsd` is a hard per-bot cap enforced by a per-bot committed-spend
//     ledger (bot.state.committedUc) IN ADDITION to the policy session/per-asset
//     caps — the tighter bound wins. A live BUY that would push cumulative live
//     spend over allocationUsd is NOT auto-approved and NOT prompted: it simply
//     does not fire (audited `skipped: allocation`). Accrual is BigInt-exact and
//     only counts orders that actually broadcast.
//   • Arming a LIVE bot REQUIRES allocationUsd > 0 AND <= the policy session USD
//     cap (fail-closed otherwise).
//   • Auto-approve reuses the EXISTING policy.autoApproveUnderUsd, which the runner
//     sets to the bot's REMAINING allocation around each dispatch — so "auto within
//     allocation" is the ONE gate, not a new path. Above remaining allocation the
//     policy falls back to its normal confirm (fail-closed with no handler).
//   • Caps, allowlist, kill, hash-chained audit, the 0.05% fee, and the mainnet
//     gate (default off) are NEVER skipped. Bots default paper + disabled + testnet.
//   • PAPER mode simulates fills at the ctx quote: it does NOT broadcast, does NOT
//     call the gate, and does NOT consume allocation — it records a simulated deal +
//     pnl tagged `paper`.
//   • No synthetic prices: a missing mark skips the tick (audited `skipped: price`).
//
// Exposed as global `AgentBotRunner`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(name, file) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    throw new Error('bot-runner dependency not loaded: ' + name);
  }

  const STABLE_USD = { USDC: 1, USDT: 1, DAI: 1, USD: 1, USDBC: 1, PYUSD: 1 };

  // Bot types that run through the shared scheduled planner path (_tickScheduled →
  // registry.get(type).validateParams/plan) rather than the deal-bot engine. The
  // pre-existing rebalance/momentum plus the 9 ported indicator/systematic planners
  // (strategies.js). dca/grid/smarttrade keep their rich deal-bot state machines.
  const SCHEDULED_TYPES = new Set([
    'rebalance', 'momentum',
    'rsi', 'macd', 'bollinger', 'breakout', 'emacross', 'momentum_roc', 'meanrev', 'rebalance_hold', 'hodl',
  ]);

  class BotRunner {
    constructor(deps) {
      deps = deps || {};
      if (!deps.policy) throw new Error('BotRunner requires a policy');
      if (!deps.tools) throw new Error('BotRunner requires a tools registry');
      this.Bots = deps.Bots || dep('AgentBots', './bots.js');
      this.policy = deps.policy;
      this.tools = deps.tools;
      this.audit = deps.audit || null;
      this.ctx = deps.ctx || {};
      this.mainnetEnabled = deps.mainnetEnabled === true; // default false
      // Max LIVE bots at once, by plan (Free 1 / Copilot 3 / Pro unlimited). -1 = unlimited.
      // The host sets this from the account's sub.liveBotLimit; default -1 preserves behavior.
      this.liveBotLimit = (deps.liveBotLimit != null) ? deps.liveBotLimit : -1;
      this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
      this.pnl = deps.pnl || null;              // post-commit realized-profit tracker (LIVE)
      // OS-notification surface (notify.js) for the bot_profit ping — optional:
      // a host without it still runs, it just never pops (mirrors Flutter's
      // `notifier == null` no-op).
      this.Notify = deps.Notify || root.AgentNotify ||
        (typeof require === 'function' ? (() => { try { return require('./notify.js'); } catch (_) { return null; } })() : null);
      this.store = deps.store || new this.Bots.BotStore({ store: deps.persist, wallet: deps.wallet, channel: deps.channel });
      this.discovery = deps.discovery || this.ctx.discovery || null;
      this.Strategies = deps.Strategies || null; // optional injection (tests); else lazy-required
      this.Scanner = deps.Scanner || null;        // optional injection (tests); else lazy-required
      this.wallet = deps.wallet || 'default';
      this.channel = deps.channel || 'default';
      this._killed = false;
      // ---- background scheduler (FIX-KILL (a)) --------------------------------
      // A single interval that TICKS every enabled bot on its pollSec cadence. It
      // is started when a bot is enabled/armed and stopped on kill / when the last
      // enabled bot is removed or paused. Timers are injectable so tests drive it
      // deterministically; the default interval is unref'd so it never keeps a host
      // process (or `node --test`) alive on its own.
      this._scheduler = null;
      this._ticking = false; // reentrancy guard for an in-flight scheduled tickAll
      const T = deps.timers || {};
      this._setInterval = typeof T.set === 'function' ? T.set
        : (typeof setInterval === 'function' ? (fn, ms) => setInterval(fn, ms) : null);
      this._clearInterval = typeof T.clear === 'function' ? T.clear
        : (typeof clearInterval === 'function' ? (h) => clearInterval(h) : null);
      this._pollMs = deps.pollMs != null ? Number(deps.pollMs) : null; // cadence override (tests)
      // the ONE shared value-moving routine (no second broadcast path)
      this.dispatchValueMoving = (deps.AgentRunner || dep('AgentRunner', './runner.js')).dispatchValueMoving;
    }

    // ---- background scheduler ------------------------------------------------
    schedulerRunning() { return this._scheduler != null; }

    _schedulerCadenceMs() {
      if (this._pollMs != null && this._pollMs > 0) return this._pollMs;
      let min = Infinity;
      for (const b of this.store.enabled()) { const p = Number(b.pollSec) || 60; if (p < min) min = p; }
      if (!isFinite(min)) min = 60;
      return Math.max(1, Math.trunc(min)) * 1000;
    }

    // Start (idempotent). No-op after a kill or when no bot is enabled.
    _startScheduler() {
      if (this._killed || this._scheduler != null || !this._setInterval) return;
      if (!this.store.enabled().length) return;
      const h = this._setInterval(() => this._schedulerTick(), this._schedulerCadenceMs());
      if (h && typeof h.unref === 'function') { try { h.unref(); } catch (_) {} }
      this._scheduler = h;
    }

    _stopScheduler() {
      if (this._scheduler != null && this._clearInterval) { try { this._clearInterval(this._scheduler); } catch (_) {} }
      this._scheduler = null;
    }

    // Pick up a new cadence (e.g. a just-armed bot with a shorter pollSec).
    _restartScheduler() { this._stopScheduler(); this._startScheduler(); }

    // One scheduled sweep: tick every enabled bot that is DUE (now - lastTick >=
    // pollSec). A killed runner stops itself; an empty roster stops itself.
    async _schedulerTick() {
      if (this._killed || this._ticking) return;
      const due = this.store.enabled();
      if (!due.length) { this._stopScheduler(); return; }
      this._ticking = true;
      try {
        const now = Number(this.ctx.now ? this.ctx.now() : Date.now());
        for (const bot of due) {
          const last = (bot.state && bot.state.lastTickAt) || 0;
          if (now - last >= (Number(bot.pollSec) || 60) * 1000) {
            await this.tickBot(bot.id);
          }
        }
      } catch (_) { /* a scheduled sweep never throws out of the interval */ }
      finally { this._ticking = false; }
    }

    emit(ev) { if (this.onEvent) { try { this.onEvent(ev); } catch (_) {} } }
    async _audit(rec) { if (this.audit) { try { return await this.audit.record(rec); } catch (_) {} } }

    // ---- bot lifecycle ------------------------------------------------------
    add(spec) { const b = this.store.add(spec); return b; }
    get(id) { return this.store.get(id); }
    list() { return this.store.list(); }

    // Host hook: set the account's LIVE-bot cap. Accepts a number (-1 = unlimited) or the
    // server's sub.liveBotLimit. Does not touch already-armed bots.
    setLiveBotLimit(n) { this.liveBotLimit = (n == null) ? -1 : Number(n); return this.liveBotLimit; }

    // Arm a bot LIVE (§5). Fail-closed: requires a finite allocationUsd in (0, sessionCap].
    async armLive(id, opts) {
      opts = opts || {};
      const bot = this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      const alloc = opts.allocationUsd != null ? Number(opts.allocationUsd) : bot.allocationUsd;
      const sessionCap = this.policy.caps && this.policy.caps.sessionUsd;
      if (!(alloc > 0)) {
        await this._audit({ type: 'bot_arm_refused', bot: id, reason: 'allocationUsd must be > 0' });
        throw new Error('cannot arm live: allocationUsd must be > 0 (fail-closed)');
      }
      if (sessionCap == null) {
        await this._audit({ type: 'bot_arm_refused', bot: id, reason: 'no policy session USD cap set' });
        throw new Error('cannot arm live: a policy session USD cap is required (fail-closed)');
      }
      if (!(alloc <= sessionCap)) {
        await this._audit({ type: 'bot_arm_refused', bot: id, reason: 'allocationUsd > session cap' });
        throw new Error('cannot arm live: allocationUsd (' + alloc + ') exceeds the policy session cap ($' + sessionCap + ')');
      }
      if (bot.network === 'mainnet' && !this.mainnetEnabled) {
        await this._audit({ type: 'bot_arm_refused', bot: id, reason: 'mainnet disabled' });
        throw new Error('cannot arm live on mainnet: set mainnetEnabled=true (operator sign-off)');
      }
      // Per-plan LIVE-bot cap (Free 1 / Copilot 3 / Pro unlimited). Count other already-live bots.
      if (this.liveBotLimit >= 0) {
        var liveNow = this.store.list().filter(function (b) { return b.id !== id && b.mode === 'live' && b.enabled; }).length;
        if (liveNow >= this.liveBotLimit) {
          await this._audit({ type: 'bot_arm_refused', bot: id, reason: 'live bot limit reached', limit: this.liveBotLimit });
          var e = new Error('Live-bot limit reached for your plan (' + this.liveBotLimit + '). Upgrade to run more.');
          e.code = 'LIVE_LIMIT'; throw e;
        }
      }
      bot.allocationUsd = alloc;
      bot.mode = 'live';
      bot.enabled = true;
      await this._audit({ type: 'bot_armed', bot: id, mode: 'live', allocationUsd: alloc, network: bot.network });
      this.emit({ type: 'bot_armed', bot: id, mode: 'live', allocationUsd: alloc });
      await this.store.persist();
      this._requestNotifyPermission(); // lazy, at-most-once OS-notification prompt
      this._restartScheduler(); // arming a bot starts/refreshes the background ticker
      return bot;
    }

    async enablePaper(id, opts) {
      opts = opts || {};
      const bot = this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      // Optional paper BUDGET: when provided (>0) it bounds cumulative paper spend
      // exactly like the live allocation cap — a sandbox the same size as the real
      // one. Omitted → unbounded paper (legacy/arena behavior, allocationUsd stays 0).
      if (opts.allocationUsd != null && Number(opts.allocationUsd) > 0) {
        bot.allocationUsd = Number(opts.allocationUsd);
      }
      bot.mode = 'paper'; bot.enabled = true;
      await this._audit({ type: 'bot_armed', bot: id, mode: 'paper', allocationUsd: bot.allocationUsd || 0 });
      await this.store.persist();
      this._requestNotifyPermission(); // lazy, at-most-once OS-notification prompt
      this._restartScheduler(); // enabling a bot starts/refreshes the background ticker
      return bot;
    }

    // Per-bot STOP (FIX-KILL (b)): halt it (enabled=false, persisted); the
    // scheduler skips it; status shows paused. Stops the ticker if none remain.
    async pause(id) {
      const bot = this.store.get(id);
      if (bot) {
        bot.enabled = false;
        await this._audit({ type: 'bot_paused', bot: id });
        this.emit({ type: 'bot_paused', bot: id });
        await this.store.persist();
        if (!this.store.enabled().length) this._stopScheduler();
      }
      return bot;
    }

    // Per-bot REMOVE/delete (FIX-KILL (b)): disable it, best-effort cancel its open
    // LIVE orders, then DELETE it from the store so the UI drops it. Stops the
    // ticker if it was the last enabled bot. Returns true when a bot was removed.
    async remove(id) {
      const bot = this.store.get(id);
      if (!bot) return false;
      bot.enabled = false;
      if (bot.mode === 'live') { try { await this._cancelOpenOrders(bot); } catch (_) {} }
      const ok = this.store.remove(id);
      await this._audit({ type: 'bot_removed', bot: id });
      this.emit({ type: 'bot_removed', bot: id });
      await this.store.persist();
      if (!this.store.enabled().length) this._stopScheduler();
      return ok;
    }

    // ---- STOP ALL: pause every bot + cancel open live orders, WITHOUT the kill
    // switch (keys stay unlocked, the runner stays usable). The bots tab's
    // "Stop all" — kill (below) is the agent-wide emergency switch that also locks.
    async stopAll(reason) {
      this._stopScheduler();
      for (const bot of this.store.list()) {
        if (!bot.enabled) continue;
        bot.enabled = false;
        if (bot.mode === 'live') { try { await this._cancelOpenOrders(bot); } catch (_) {} }
        await this._audit({ type: 'bot_paused', bot: bot.id, reason: reason || 'stop-all' });
        this._feed(bot, { kind: 'halt', text: '⏹ Stopped' + (reason ? ' (' + reason + ')' : '') });
      }
      await this.store.persist();
      this.emit({ type: 'bot_stop_all', reason: reason || 'user' });
    }

    // ---- FLATTEN: close every OPEN deal of a bot at the current mark (paper
    // simulates, live routes each sell through the ONE gate), book the results,
    // and pause it — a real "stop", not a frozen position. Returns the closes.
    async flatten(id, reason) {
      const B = this.Bots;
      const bot = typeof id === 'object' ? id : this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      const closes = [];
      if (bot.type === 'auto') {
        for (const c of this._autoChildren(bot)) { try { closes.push(...(await this.flatten(c, reason))); } catch (_) {} }
        this._autoPersistChildren(bot);
      } else {
        const now = Number(this.ctx.now ? this.ctx.now() : Date.now());
        const ctxMainnet = this._ctxMainnet();
        const type = bot.type === 'signal' ? ((bot.config.onSignal && bot.config.onSignal.type) || 'dca') : bot.type;
        const cfg = bot.type === 'signal' ? ((bot.config.onSignal && bot.config.onSignal.config) || {}) : bot.config;
        const engine = B.ENGINES[type];
        for (const pair of Object.keys(bot.state.byPair || {})) {
          const ps = bot.state.byPair[pair];
          const deal = ps && ps.deal;
          if (!deal || deal.status === 'closed' || !engine) continue;
          const [base, quote] = B.splitPair(pair);
          const prices = await this._prices([base, quote]);
          const markUc = this._unitUc(prices, base);
          if (markUc == null) { closes.push({ pair, skipped: 'price' }); continue; }
          const bd = this._decimals(base, cfg), quoteDec = this._decimals(quote, cfg), quoteUc = this._unitUc(prices, quote);
          const m = { base, quote, bd, quoteDec, quoteUc };
          const bcfg = engine.bcfg ? engine.bcfg(cfg) : cfg;
          if (type === 'grid') {
            // sell every held rung as a grid exit
            let guard = 0;
            while (guard++ < 200) {
              const lv = (deal.levels || []).find((l) => l.heldQty > 0n);
              if (!lv) break;
              const order = { action: 'sell', side: 'sell', kind: 'grid_exit', exit: true, levelIndex: lv.i, qty: lv.heldQty, _levelPriceUc: markUc };
              const fill = await this._executeOrder(bot, m, order, markUc, ctxMainnet);
              if (!fill) break;
              fill.bd = bd; this._engineApply(type, deal, bcfg, cfg, order, fill, now);
              closes.push({ pair, qty: fill.qty.toString(), priceUc: fill.priceUc.toString(), paper: !!fill.paper });
            }
            if (!(deal.levels || []).some((l) => l.heldQty > 0n)) { deal.status = 'closed'; deal.closedAt = now; deal.reason = 'manual'; }
          } else {
            const qty = deal.filledQty != null ? deal.filledQty : deal.remainingQty;
            if (qty > 0n) {
              const order = { action: 'sl', side: 'sell', kind: 'manual', qty };
              const fill = await this._executeOrder(bot, m, order, markUc, ctxMainnet);
              if (fill) { fill.bd = bd; this._engineApply(type, deal, bcfg, cfg, order, fill, now); closes.push({ pair, qty: fill.qty.toString(), priceUc: fill.priceUc.toString(), paper: !!fill.paper }); }
            } else { deal.status = 'closed'; deal.closedAt = now; deal.reason = 'manual'; }
          }
          if (deal.status === 'closed') this._bookClose(bot, ps, now, pair, markUc);
        }
      }
      bot.enabled = false;
      await this._audit({ type: 'bot_flatten', bot: bot.id, closes: closes.length, reason: reason || 'user' });
      this._feed(bot, { kind: 'halt', text: '⏹ Stopped & flattened — ' + closes.filter((c) => !c.skipped).length + ' position(s) closed at market' });
      await this.store.persist();
      if (!this.store.enabled().length) this._stopScheduler();
      this.emit({ type: 'bot_flattened', bot: bot.id, closes: closes.length });
      return closes;
    }

    // ---- KILL (§5): stop ALL bots, best-effort cancel open orders, lock vault --
    async killAll(reason) {
      this._killed = true;
      this._stopScheduler(); // the ticker stops immediately — no further sweeps
      // best-effort cancel any live open grid orders we hold ids for
      for (const bot of this.store.list()) {
        bot.enabled = false;
        if (bot.mode === 'live') { try { await this._cancelOpenOrders(bot); } catch (_) {} }
      }
      await this._audit({ type: 'bot_kill', reason: reason || 'user', bots: this.store.list().length });
      this.emit({ type: 'bot_kill', reason: reason || 'user' });
      // policy.kill wipes decrypted keys + the LLM credential and locks the vault.
      await this.policy.kill(reason || 'bot kill');
      await this.store.persist();
    }

    async _cancelOpenOrders(bot) {
      const B = this.Bots;
      // a Full Auto parent holds no orders itself — cancel through its children
      if (bot.type === 'auto') { for (const c of this._autoChildren(bot)) { try { await this._cancelOpenOrders(c); } catch (_) {} } return; }
      const tool = this.tools.get('cancel_order');
      if (!tool || !this.policy.isAllowed('cancel_order')) return;
      // Route cancels through the ONE shared value-moving dispatch (the SAME audited
      // commit routine every order uses) — NOT a bare prepare().commit() second path.
      // Best-effort: a failed cancel never blocks the kill (which locks the vault next).
      const remainingUc = B.microUsd(bot.allocationUsd) - (bot.state.committedUc || 0n);
      const envelope = remainingUc > 0n ? remainingUc : B.microUsd(bot.allocationUsd);
      for (const pair of Object.keys(bot.state.byPair || {})) {
        const ps = bot.state.byPair[pair];
        const levels = ps && ps.deal && ps.deal.levels;
        for (const lv of (levels || [])) {
          if (lv.orderId) {
            try { await this._dispatch(bot, 'cancel_order', { orderId: lv.orderId }, envelope); } catch (_) {}
          }
        }
      }
    }

    // ---- read helpers -------------------------------------------------------
    _ctxMainnet() {
      try { return !!(this.ctx && typeof this.ctx.network === 'function' && this.ctx.network() === 'mainnet'); }
      catch (_) { return false; }
    }
    async _prices(symbols) {
      try { return (await (this.ctx.prices ? this.ctx.prices(symbols) : null)) || {}; }
      catch (_) { return {}; }
    }
    _unitUc(prices, sym) {
      const B = this.Bots;
      const v = prices[sym];
      if (v != null && isFinite(Number(v)) && Number(v) > 0) return B.microUsd(v);
      if (STABLE_USD[String(sym).toUpperCase()] != null) return B.microUsd(STABLE_USD[String(sym).toUpperCase()]);
      return null; // no synthetic price
    }

    // ===========================================================================
    // tick ONE bot (public: tickBot) — runs its schedule once. Returns a report.
    // ===========================================================================
    async tickAll(opts) {
      const out = [];
      for (const bot of this.store.enabled()) out.push(await this.tickBot(bot.id, opts));
      return out;
    }

    async tickBot(id, opts) {
      opts = opts || {};
      const bot = typeof id === 'object' ? id : this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      // a kill (or a paused bot) is a no-op BEFORE we assert liveness, so a killed
      // runner reports cleanly instead of throwing out of the tick.
      if (this._killed || !bot.enabled) return { bot: bot.id, skipped: 'disabled' };
      this.policy.assertLive();                 // a live-but-unkilled sanity check
      const now = Number(this.ctx.now ? this.ctx.now() : Date.now());
      bot.state.lastTickAt = now;

      let report;
      try {
        if (bot.type === 'auto') report = await this._tickAuto(bot, now, opts);
        else if (SCHEDULED_TYPES.has(bot.type)) report = await this._tickScheduled(bot, now, opts);
        else if (bot.type === 'scanner') report = await this._tickScanner(bot, now, opts);
        else if (bot.type === 'signal') report = await this._tickSignal(bot, now, opts);
        else report = await this._tickDealBot(bot, bot.type, bot.config, bot.pairs(), now, opts);
        bot.state.lastError = null;
      } catch (e) {
        if (e && e.halted) { this._killed = true; await this._audit({ type: 'bot_abort', bot: bot.id, reason: 'killed' }); return { bot: bot.id, killed: true }; }
        await this._audit({ type: 'bot_error', bot: bot.id, error: e.message });
        bot.state.lastError = { at: now, message: String(e.message || e) };
        report = { bot: bot.id, error: e.message };
      }
      // Pop a profit notification on any realized-gain since the last one (paper or
      // live, any profit currency). This is the user-visible "you made money" ping.
      try { this._maybeNotifyProfit(bot); } catch (_) {}
      bot.state.lastReport = { at: now, events: (report && report.events ? report.events.length : 0), error: report && report.error ? String(report.error) : null };
      await this.store.persist();
      this.emit({ type: 'bot_tick', bot: bot.id, at: now, report });
      return report;
    }

    // Force a tick right now (UI "Tick now" button), ignoring the pollSec cadence.
    async tickNow(id) { return this.tickBot(id, { forced: true }); }

    // Push a human-readable event onto the bot's live ticker (bounded ring).
    _feed(bot, ev) {
      const f = bot.state.feed = bot.state.feed || [];
      f.push(Object.assign({ at: Number(this.ctx.now ? this.ctx.now() : Date.now()) }, ev));
      if (f.length > 60) f.splice(0, f.length - 60);
      this.emit(Object.assign({ type: 'bot_feed', bot: bot.id, name: bot.name }, ev));
    }

    // ---- deal bots (dca / grid / smarttrade), also reused by signal-spawned ---
    async _tickDealBot(bot, type, cfg, pairs, now, opts) {
      const B = this.Bots;
      const engine = B.ENGINES[type];
      if (!engine) return { bot: bot.id, error: 'no engine for ' + type };
      const bcfg = engine.bcfg ? engine.bcfg(cfg) : cfg;
      const ctxMainnet = this._ctxMainnet();
      const events = [];

      for (const pair of pairs) {
        const [base, quote] = B.splitPair(pair);
        const prices = await this._prices([base, quote]);
        const markUc = this._unitUc(prices, base);
        if (markUc == null) {
          await this._audit({ type: 'bot_skip', bot: bot.id, pair, reason: 'price', detail: 'no mark for ' + base });
          events.push({ pair, skipped: 'price' });
          continue;
        }
        // decimals: the host's asset map (discovery / holdings) beats the static table.
        const bd = this._decimals(base, cfg);
        const quoteDec = this._decimals(quote, cfg);
        const quoteUc = this._unitUc(prices, quote);
        bot.state.lastMarks = bot.state.lastMarks || {};
        bot.state.lastMarks[base] = B.ucToUsd(markUc);

        let ps = bot.state.byPair[pair] || (bot.state.byPair[pair] = { deal: null, lastCloseAt: 0 });

        // (re)open a deal if needed (dca/smarttrade). grid keeps one persistent deal.
        if (type === 'grid') {
          if (!ps.deal) {
            // AUTO-RANGE: freeze a ±pct band around the first mark into this deal.
            let gcfg = cfg;
            if (!(cfg.lowerPrice > 0 && cfg.upperPrice > cfg.lowerPrice) && cfg.autoRangePct > 0) {
              const mark = B.ucToUsd(markUc);
              gcfg = Object.assign({}, cfg, { lowerPrice: mark * (1 - cfg.autoRangePct / 100), upperPrice: mark * (1 + cfg.autoRangePct / 100) });
            }
            ps.deal = engine.newDeal(bot.id + ':' + pair, gcfg, markUc, bd, now);
            ps.deal.range = { lower: gcfg.lowerPrice, upper: gcfg.upperPrice };
            this._feed(bot, { kind: 'open', pair, text: 'Grid armed ' + fmtUsdShort(gcfg.lowerPrice) + ' → ' + fmtUsdShort(gcfg.upperPrice) + ' (' + gcfg.gridCount + ' rungs)' });
          }
        } else {
          if (!ps.deal || ps.deal.status === 'closed') {
            if (!this._canStart(bot, ps, now, markUc)) { events.push({ pair, waiting: true }); continue; }
            ps.deal = type === 'smarttrade' ? engine.newDeal(bot.id + ':' + pair + ':' + (bot.state.dealCount + 1), cfg, now)
              : engine.newDeal(bot.id + ':' + pair + ':' + (bot.state.dealCount + 1), now);
            bot.state.dealOpens = (bot.state.dealOpens || []).filter((t) => now - t < 86400000).concat([now]);
          }
        }

        // CANDLE EXITS (candles.js): fold this tick into the pair's candle series and,
        // when the deal is in profit, bank it on a closed-candle reversal — long before
        // a fixed take-profit would. Same sell path, same gate, same audit as any exit.
        const cc = cfg.candle && cfg.candle.enabled ? cfg.candle : null;
        if (cc) {
          const Candles = this._candlesMod();
          if (Candles) {
            const u = Candles.update(ps.candles, B.ucToUsd(markUc), now, cc.sec, cc.maxCandles);
            ps.candles = u.series;
            if (ps.deal && ps.deal.status === 'open') {
              const qty = ps.deal.filledQty != null ? ps.deal.filledQty : ps.deal.remainingQty;
              const entryUc = ps.deal.avgEntryUc || 0n;
              if (qty > 0n && entryUc > 0n) {
                ps.candleState = ps.candleState || {};
                const ev = Candles.evaluateExit(ps.candles, B.ucToUsd(entryUc), B.ucToUsd(markUc), cc, ps.candleState);
                if (ev.exit) {
                  const order = { action: 'tp', side: 'sell', kind: 'ctp', qty, candleReason: ev.reason };
                  const fill = await this._executeOrder(bot, { base, quote, bd, quoteDec, quoteUc }, order, markUc, ctxMainnet);
                  if (fill) {
                    fill.bd = bd;
                    this._engineApply(type, ps.deal, bcfg, cfg, order, fill, now);
                    events.push({ pair, action: 'ctp', side: 'sell', qty: fill.qty.toString(), priceUc: fill.priceUc.toString(), paper: !!fill.paper, candle: ev.reason });
                    this._feed(bot, { kind: 'sell', pair, action: 'ctp', paper: !!fill.paper, priceUsd: B.ucToUsd(fill.priceUc), usd: B.ucToUsd(fill.proceedsUc || 0n),
                      text: 'Banked ' + base + ' +' + ev.profitPct.toFixed(1) + '% — ' + Candles.label(ev.reason) + (fill.paper ? ' (paper)' : '') });
                    if (ps.deal.status === 'closed') { this._bookClose(bot, ps, now, pair, markUc); continue; }
                  }
                }
              }
            }
          }
        }

        // TIME STOP (dca/smarttrade): a deal older than maxDealSec is closed at
        // the mark through the SAME gate as any sell — it is just another exit.
        if (type !== 'grid' && cfg.maxDealSec > 0 && ps.deal.status === 'open' && (now - (ps.deal.openedAt || now)) >= cfg.maxDealSec * 1000) {
          const qty = ps.deal.filledQty != null ? ps.deal.filledQty : ps.deal.remainingQty;
          if (qty > 0n) {
            const order = { action: 'sl', side: 'sell', kind: 'time', qty };
            const fill = await this._executeOrder(bot, { base, quote, bd, quoteDec, quoteUc }, order, markUc, ctxMainnet);
            if (fill) {
              fill.bd = bd;
              this._engineApply(type, ps.deal, bcfg, cfg, order, fill, now);
              events.push({ pair, action: 'time', side: 'sell', qty: fill.qty.toString(), priceUc: fill.priceUc.toString(), paper: !!fill.paper });
              if (ps.deal.status === 'closed') { this._bookClose(bot, ps, now, pair, markUc); continue; }
            }
          }
        }

        // observe (trailing peak) then step the engine until it returns null,
        // interposing the gate on each fill.
        if (engine.observe) engine.observe(ps.deal, markUc);
        let guard = 0;
        while (guard++ < 128) {
          const order = this._engineStep(type, ps.deal, bcfg, cfg, markUc);
          if (!order) break;

          if (order.action === 'arm') { order._markUc = markUc; this._engineApply(type, ps.deal, bcfg, cfg, order, null, now); continue; }

          const fill = await this._executeOrder(bot, { base, quote, bd, quoteDec, quoteUc }, order, markUc, ctxMainnet);
          if (!fill) break; // skipped/blocked/declined — stop this pair's cascade this tick
          fill.bd = bd;
          this._engineApply(type, ps.deal, bcfg, cfg, order, fill, now);
          const ev = { pair, action: order.kind, side: order.side, qty: fill.qty.toString(), priceUc: fill.priceUc.toString(), paper: !!fill.paper };
          // a realized exit carries its FINAL settled currency (profitCurrency when
          // settled; the native quote when there is no route — never a false label).
          if (fill.side === 'sell' && fill.settledCurrency) { ev.settledCurrency = fill.settledCurrency; ev.realized = { currency: fill.settledCurrency }; }
          events.push(ev);
          this._feed(bot, {
            kind: order.side, pair, action: order.kind, paper: !!fill.paper, priceUsd: B.ucToUsd(fill.priceUc),
            usd: B.ucToUsd(fill.side === 'buy' ? (fill.costUc || 0n) : (fill.proceedsUc || 0n)),
            text: (order.side === 'buy' ? 'Bought ' : 'Sold ') + base + ' @ ' + fmtUsdShort(B.ucToUsd(fill.priceUc)) + ' · ' + labelFor(order.kind) + (fill.paper ? ' (paper)' : ''),
          });

          if (ps.deal.status === 'closed') { this._bookClose(bot, ps, now, pair, markUc); break; }
        }
      }
      return { bot: bot.id, type, events, dashboard: this.dashboard(bot.id) };
    }

    _candlesMod() {
      if (this._Candles === undefined) {
        this._Candles = root.AgentCandles || (typeof require === 'function' ? (() => { try { return require('./candles.js'); } catch (_) { return null; } })() : null);
      }
      return this._Candles;
    }
    _decimals(sym, cfg) {
      try {
        if (this.ctx && typeof this.ctx.decimalsFor === 'function') { const d = this.ctx.decimalsFor(sym); if (d != null && Number.isFinite(Number(d))) return Number(d); }
      } catch (_) {}
      return this.Bots.decimalsFor(sym, cfg && cfg.decimals);
    }

    _engineStep(type, deal, bcfg, cfg, markUc) {
      if (type === 'dca') return this.Bots.dcaStep(deal, bcfg, markUc);
      if (type === 'grid') return this.Bots.gridStep(deal, markUc, bcfg);
      if (type === 'smarttrade') return this.Bots.smartStep(deal, cfg, markUc);
      return null;
    }
    _engineApply(type, deal, bcfg, cfg, order, fill, now) {
      if (type === 'dca') return this.Bots.dcaApply(deal, bcfg, order, fill, now);
      if (type === 'grid') return this.Bots.gridApply(deal, order, fill, now);
      if (type === 'smarttrade') return this.Bots.smartApply(deal, cfg, order, fill, now);
    }

    _canStart(bot, ps, now, markUc) {
      // bot-level halt (max-loss rail tripped) — nothing new opens until the user resumes
      if (bot.state.haltReason) return false;
      // cooldown since last close
      if (bot.cooldownSec > 0 && ps.lastCloseAt && (now - ps.lastCloseAt) < bot.cooldownSec * 1000) return false;
      // daily deal cap (rolling 24h)
      const cap = bot.risk && bot.risk.maxDailyDeals;
      if (cap > 0) {
        const opens = (bot.state.dealOpens || []).filter((t) => now - t < 86400000);
        if (opens.length >= cap) return false;
      }
      const sc = bot.config && bot.config.startCondition;
      if (sc === 'signal') return !!ps.signalArmed;   // a signal must have armed this pair
      if (sc === 'dip') {
        // DIP ENTRY: track the high-water mark since the last close; open only once
        // the mark has fallen dipPct below it. A 0 dipPct starts immediately.
        const dip = Number(bot.config.dipPct) || 0;
        if (!(dip > 0) || markUc == null) return true;
        if (ps.refHighUc == null || markUc > ps.refHighUc) ps.refHighUc = markUc;
        const trigger = this.Bots.applyBps(ps.refHighUc, -Math.round(dip * 100));
        if (markUc <= trigger) { ps.refHighUc = null; return true; }
        return false;
      }
      return true; // 'asap'
    }

    // Book a closed deal into the bot's dashboard stats + archive.
    _bookClose(bot, ps, now, pair, markUc) {
      const B = this.Bots;
      const deal = ps.deal;
      const r = deal.realizedUc || 0n;
      bot.state.realizedUc = (bot.state.realizedUc || 0n) + r;
      bot.state.dealCount = (bot.state.dealCount || 0) + 1;
      if (r > 0n) { bot.state.winCount = (bot.state.winCount || 0) + 1; bot.state.streak = (bot.state.streak || 0) > 0 ? bot.state.streak + 1 : 1; }
      else if (r < 0n) { bot.state.lossCount = (bot.state.lossCount || 0) + 1; bot.state.streak = (bot.state.streak || 0) < 0 ? bot.state.streak - 1 : -1; }
      if ((bot.state.streak || 0) > (bot.state.bestStreak || 0)) bot.state.bestStreak = bot.state.streak;
      // running peak-to-trough drawdown on cumulative realized
      bot.state._peakRealizedUc = bot.state._peakRealizedUc != null ? bot.state._peakRealizedUc : 0n;
      if (bot.state.realizedUc > bot.state._peakRealizedUc) bot.state._peakRealizedUc = bot.state.realizedUc;
      const dd = bot.state._peakRealizedUc - bot.state.realizedUc;
      if (dd > (bot.state.maxDrawdownUc || 0n)) bot.state.maxDrawdownUc = dd;
      bot.state.closedDeals.push(deal);
      if (bot.state.closedDeals.length > 500) bot.state.closedDeals.splice(0, bot.state.closedDeals.length - 500);
      ps.lastCloseAt = now;
      ps.deal = null;
      ps.signalArmed = false;
      ps.refHighUc = null;
      ps.candleState = null;
      const usd = B.ucToUsd(r);
      this._feed(bot, { kind: 'close', pair: pair || null, realizedUsd: usd, reason: deal.reason || null, paper: bot.mode === 'paper',
        text: 'Closed ' + (pair || deal.type) + ' ' + (usd >= 0 ? '+' : '') + fmtUsdShort(usd) + ' · ' + labelFor(deal.reason) + ((bot.state.streak || 0) >= 3 ? ' · ' + bot.state.streak + ' win streak' : '') });
      // MAX-LOSS RAIL: cumulative realized loss ≥ maxLossPct of the budget ⇒ auto-pause.
      const pct = bot.risk && bot.risk.maxLossPct;
      if (pct > 0 && bot.allocationUsd > 0 && bot.state.realizedUc < 0n) {
        const limitUc = B.divRound(B.microUsd(bot.allocationUsd) * BigInt(Math.round(pct * 100)), 10000n);
        if (-bot.state.realizedUc >= limitUc) {
          bot.enabled = false;
          bot.state.haltReason = 'max-loss';
          this._audit({ type: 'bot_paused', bot: bot.id, reason: 'max-loss', realizedUsd: usd, maxLossPct: pct });
          this._feed(bot, { kind: 'halt', text: 'Max-loss rail hit (' + pct + '% of budget) — bot paused. Review and restart when ready.' });
          this.emit({ type: 'bot_paused', bot: bot.id, reason: 'max-loss' });
          if (!this.store.enabled().length) this._stopScheduler();
        }
      }
    }

    // Effective deploy cap (micro-dollars). PROFIT MODE governs it:
    //   off / take → the fixed budget (allocationUsd). Realized profit settles out;
    //                losses just consume the budget. (Byte-for-byte the legacy cap —
    //                the deterministic fixtures all run here.)
    //   compound   → budget + cumulative realized PROFIT. Gains raise the cap so the
    //                next orders can be larger (reinvested); losses are floored at 0
    //                so the cap NEVER drops below the budget and NEVER pulls from the
    //                wallet. The budget is a hard floor; profit is the only thing that
    //                can lift it.
    _effectiveCapUc(bot) {
      const B = this.Bots;
      const base = B.microUsd(bot.allocationUsd);
      if (bot.profitMode === 'compound') {
        const r = bot.state.realizedUc || 0n;
        return r > 0n ? base + r : base;
      }
      return base;
    }

    // ===========================================================================
    // execute a single order — PAPER simulates; LIVE routes through the ONE gate.
    // Returns a fill { side, qty, priceUc, costUc|proceedsUc, paper?, txid? } or
    // null when the order did not fire (skipped/blocked/declined — all audited).
    // ===========================================================================
    async _executeOrder(bot, m, order, markUc, ctxMainnet) {
      const B = this.Bots;
      const mainnet = !!(bot.network === 'mainnet' || ctxMainnet);
      const toolName = bot.type === 'grid' ? 'place_order' : 'swap';
      // Grid orders are LIMIT orders at a specific ladder price; DCA/smarttrade fill
      // at the current mark. Use the level price for grid so size = qty*levelPrice.
      // PAPER SLIPPAGE: market fills (not grid limits) are moved against the bot by
      // risk.paperSlippageBps so the sandbox prices in spread + impact honestly.
      let execPriceUc = (order._levelPriceUc != null) ? order._levelPriceUc : markUc;
      const slipBps = (bot.mode === 'paper' && order._levelPriceUc == null && bot.risk && bot.risk.paperSlippageBps > 0) ? bot.risk.paperSlippageBps : 0;
      if (slipBps > 0) execPriceUc = B.applyBps(execPriceUc, order.side === 'buy' ? slipBps : -slipBps);

      if (order.side === 'buy') {
        // DCA/smarttrade buys carry a USD size; GRID buys carry only a fixed base
        // qty + its level price (FIX-GRID). Derive usdSizeUc/costUc from qty*levelPrice
        // (base-unit/BigInt-exact) so the SAME allocation cap-check + committed-spend
        // accrual + ONE dispatch apply to grid EXACTLY like DCA.
        let usdSizeUc, qty;
        if (order.usdSizeUc != null) {
          usdSizeUc = order.usdSizeUc;
          qty = order._qtyOverride != null ? order._qtyOverride : B.qtyForUsd(usdSizeUc, markUc, m.bd);
        } else {
          qty = order.qty;
          usdSizeUc = B.valueOf(qty, execPriceUc, m.bd); // grid: fixed qty * level price
        }
        const costUc = B.valueOf(qty, execPriceUc, m.bd);
        if (!qty || qty <= 0n) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'size', detail: 'buy rounds to zero' }); return null; }

        // The mandatory 0.05% agent fee rides EVERY live trade; the allocation ledger
        // bounds the TRUE outflow = trade + fee (FIX-ALLOC-FEE), so cap-check AND
        // accrue trade+fee — cumulative live spend can never exceed allocationUsd.
        const feeUc = B.agentFeeUc(usdSizeUc);

        // --- allocation gate (BigInt-exact, non-bypassable) ------------------
        // LIVE always enforces the per-bot budget. PAPER enforces it too WHEN a
        // budget was set (allocationUsd > 0) — so a paper run is a sandbox the same
        // size as the real one. Legacy/arena paper bots (allocationUsd === 0) are
        // unbounded, preserving the deterministic fixtures exactly.
        let remainingUc = null;
        const enforceBudget = bot.mode === 'live' || (bot.mode === 'paper' && bot.allocationUsd > 0);
        if (enforceBudget) {
          const allocUc = this._effectiveCapUc(bot); // budget, + realized profit when compounding
          remainingUc = allocUc - (bot.state.committedUc || 0n);
          if (usdSizeUc + feeUc > remainingUc) {
            // does NOT fire, is NOT prompted — the hard per-bot cap (trade + fee).
            await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'allocation', wantUc: (usdSizeUc + feeUc).toString(), remainingUc: remainingUc.toString(), allocationUsd: bot.allocationUsd });
            this.emit({ type: 'bot_skip', bot: bot.id, reason: 'allocation' });
            return null;
          }
        }

        // --- mainnet gate (never skipped) ------------------------------------
        if (mainnet && !this.mainnetEnabled) {
          await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'mainnet', detail: 'mainnetEnabled=false' });
          return null;
        }
        // --- allowlist -------------------------------------------------------
        if (!this.policy.isAllowed(toolName)) {
          await this._audit({ type: 'bot_blocked', bot: bot.id, tool: toolName, reason: 'not on allowlist' });
          return null;
        }

        if (bot.mode === 'paper') {
          // Mirror the live ledger in paper WHEN a budget is set, so the sandbox
          // depletes its budget identically. No-op when unbounded (alloc 0).
          if (enforceBudget) bot.state.committedUc = (bot.state.committedUc || 0n) + usdSizeUc + feeUc;
          await this._audit({ type: 'bot_paper_fill', bot: bot.id, side: 'buy', kind: order.kind, pair: m.base + '/' + m.quote, qty: qty.toString(), priceUc: execPriceUc.toString(), costUc: costUc.toString() });
          this._emitTradeFee(bot, m.quote, B.ucToUsd(usdSizeUc), m.quoteUc != null ? B.ucToUsd(m.quoteUc) : null); // 0.05% -> liquidity
          return { side: 'buy', qty, priceUc: execPriceUc, costUc, paper: true };
        }

        // --- LIVE: route through the ONE value-moving dispatch ---------------
        const quoteUc = m.quoteUc != null ? m.quoteUc : B.microUsd(1);
        const amount = (toolName === 'place_order')
          ? qty.toString()
          : B.qtyForUsd(usdSizeUc, quoteUc, m.quoteDec).toString(); // quote base units to spend
        const buyVenue = (toolName === 'place_order') ? null : await this._resolveVenue(bot, m.quote, m.base, B.ucToUsd(usdSizeUc), null);
        const args = (toolName === 'place_order')
          ? { market: m.base + '/' + m.quote, side: 'buy', type: 'limit', amount: qty.toString(), price: B.ucToUsd(order._levelPriceUc || markUc) }
          : { from: m.quote, to: m.base, amount, venue: buyVenue };
        const r = await this._dispatch(bot, toolName, args, remainingUc);
        if (!r || r.rejected || !r.result) { await this._audit({ type: 'bot_order_rejected', bot: bot.id, reason: r && r.reason }); return null; }
        bot.state.committedUc = (bot.state.committedUc || 0n) + usdSizeUc + feeUc; // accrue trade + fee, ONLY on broadcast
        const outQty = r.result && r.result.amountOut != null ? BigInt(String(r.result.amountOut)) : qty;
        this._emitTradeFee(bot, m.quote, B.ucToUsd(usdSizeUc), m.quoteUc != null ? B.ucToUsd(m.quoteUc) : null); // 0.05% -> liquidity
        return { side: 'buy', qty: outQty, priceUc: execPriceUc, costUc, txid: r.txid, orderId: r.result && r.result.orderId };
      }

      // ---- SELL (take-profit / stop-loss / grid flip): proceeds, no allocation --
      const qty = order.qty;
      if (!qty || qty <= 0n) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'size', detail: 'sell qty zero' }); return null; }
      const proceedsUc = B.valueOf(qty, execPriceUc, m.bd);
      if (mainnet && !this.mainnetEnabled) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'mainnet' }); return null; }
      if (!this.policy.isAllowed(toolName)) { await this._audit({ type: 'bot_blocked', bot: bot.id, tool: toolName, reason: 'not on allowlist' }); return null; }

      // proceeds land in the pair's native quote; the UNIFORM settlement step then
      // converts them into the bot's profitCurrency (skipped when quote===pc / no
      // route). quote base units = proceeds priced in the quote asset.
      const quoteUnitUc = m.quoteUc != null ? m.quoteUc : B.microUsd(1);
      const proceedsQuoteUnits = B.qtyForUsd(proceedsUc, quoteUnitUc, m.quoteDec);

      if (bot.mode === 'paper') {
        await this._audit({ type: 'bot_paper_fill', bot: bot.id, side: 'sell', kind: order.kind, pair: m.base + '/' + m.quote, qty: qty.toString(), priceUc: execPriceUc.toString(), proceedsUc: proceedsUc.toString() });
        const st = await this._settleToProfitCurrency(bot, { fromAsset: m.quote, amount: proceedsQuoteUnits, mainnet, remainingUc: null });
        this._releaseCommitted(bot, proceedsUc);
        return { side: 'sell', qty, priceUc: execPriceUc, proceedsUc, paper: true, settledCurrency: st.currency };
      }
      const sellVenue = (toolName === 'place_order') ? null : await this._resolveVenue(bot, m.base, m.quote, B.ucToUsd(proceedsUc), null);
      const args = (toolName === 'place_order')
        ? { market: m.base + '/' + m.quote, side: 'sell', type: 'limit', amount: qty.toString(), price: B.ucToUsd(order._levelPriceUc || markUc) }
        : { from: m.base, to: m.quote, amount: qty.toString(), venue: sellVenue };
      // sells do not consume allocation; keep the auto-approve envelope at remaining
      // allocation so the sell still auto-approves within the same ONE gate.
      const remainingUc = B.microUsd(bot.allocationUsd) - (bot.state.committedUc || 0n);
      const envelope = remainingUc > 0n ? remainingUc : B.microUsd(bot.allocationUsd);
      const r = await this._dispatch(bot, toolName, args, envelope);
      if (!r || r.rejected || !r.result) { await this._audit({ type: 'bot_order_rejected', bot: bot.id, reason: r && r.reason }); return null; }
      const outQty = r.result && r.result.amountOut != null ? qty : qty;
      // UNIFORM SETTLEMENT: realize proceeds into the profitCurrency (ONE extra
      // gated swap; skipped when already the profit currency or no route exists).
      const st = await this._settleToProfitCurrency(bot, { fromAsset: m.quote, amount: proceedsQuoteUnits, mainnet, remainingUc: envelope });
      this._releaseCommitted(bot, proceedsUc);
      return { side: 'sell', qty: outQty, priceUc: execPriceUc, proceedsUc, txid: r.txid, orderId: r.result && r.result.orderId, settledCurrency: st.currency };
    }

    // The allocation ledger tracks capital CURRENTLY DEPLOYED, not lifetime
    // volume: proceeds that come back on a sell free up budget for the next deal
    // (floored at 0 so a profitable exit never "creates" budget beyond the cap —
    // compounding is the explicit profitMode for that). Without this a budgeted
    // bot would go silent after deploying its budget exactly once.
    _releaseCommitted(bot, proceedsUc) {
      const cur = bot.state.committedUc || 0n;
      const p = proceedsUc || 0n;
      bot.state.committedUc = p >= cur ? 0n : cur - p;
    }

    // ---- liquidity fee hook (Blockle Liquidity) ------------------------------
    // Every bot trade — paper OR live — contributes a 0.05% fee to the liquidity
    // treasury, keyed by the pair's QUOTE coin (USDC/SOL/ETH/…), so the pools
    // deepen with the exact mix of coins the bots actually trade. Mirrors the
    // Flutter BotRunner._emitTradeFee: the runner EMITS the `bot_fee` event (pure,
    // testable) and, when the Liquidity module is loaded, hands the fee straight
    // to the server treasury (fire-and-forget; never blocks a tick).
    _emitTradeFee(bot, quoteCoin, notionalUsd, quoteUsd) {
      const n = Number(notionalUsd || 0);
      const coin = String(quoteCoin || '').toUpperCase();
      if (!(n > 0) || !coin) return;
      const feeUsd = n * 0.0005; // kAgentFeeBps = 5bps per side
      this.emit({ type: 'bot_fee', bot: bot.id, coin, notionalUsd: n, feeUsd, mode: bot.mode });
      let coinUsd = (quoteUsd != null && isFinite(Number(quoteUsd)) && Number(quoteUsd) > 0) ? Number(quoteUsd) : null;
      if (coinUsd == null && STABLE_USD[coin] != null) coinUsd = STABLE_USD[coin];
      const L = (typeof Liquidity !== 'undefined' && Liquidity) || root.Liquidity || null;
      if (L && typeof L.takeFee === 'function') {
        try { L.takeFee(coin, feeUsd, coinUsd); } catch (_) { /* best-effort — never blocks a tick */ }
      }
    }

    // The QUOTE coin of an Intent's pair (from its `strat:BASE/QUOTE:side` tag,
    // else its swap `from`), which is the coin whose pool the fee deepens.
    _intentQuote(it) {
      try {
        const m = /:([A-Za-z0-9]+)\/([A-Za-z0-9]+):/.exec(String(it.tag || ''));
        if (m) return m[2].toUpperCase();
      } catch (_) {}
      try {
        const from = String((it.args && it.args.from) || '').toUpperCase();
        if (from) return from;
      } catch (_) {}
      return 'USDC';
    }

    // The bot's cumulative realized profit (micro-dollars): closed deals
    // (bot.state.realizedUc) PLUS the realized rungs of any still-open grid deal
    // (a running grid books profit per sell without ever closing the deal).
    _currentRealizedUc(bot) {
      let total = bot.state.realizedUc || 0n;
      const byPair = bot.state.byPair || {};
      for (const pair of Object.keys(byPair)) {
        const ps = byPair[pair];
        const deal = ps && ps.deal;
        if (deal && deal.status !== 'closed') total += deal.realizedUc || 0n;
      }
      return total;
    }

    // Pop ONE OS notification per fresh chunk of realized profit (mirrors the
    // Flutter BotRunner._maybeNotifyProfit). Fires on the POSITIVE delta since
    // the last notification (>= $0.01); sub-cent gains accumulate silently until
    // they cross the threshold (the baseline is NOT advanced below it, so no
    // profit is ever dropped — and no spam: one ping per fresh chunk). Works in
    // paper AND live, in any profit currency — unlike the PnlHook, which only
    // pops on a live stablecoin exit.
    _maybeNotifyProfit(bot) {
      const B = this.Bots;
      const N = this.Notify;
      if (!N || typeof N.defaultEmit !== 'function') return;
      const cur = this._currentRealizedUc(bot);
      const last = bot.state._notifiedRealizedUc || 0n;
      const delta = cur - last;
      if (delta <= 0n) {
        // Realized went DOWN (new deal reset, or a loss after the last ping) — re-
        // baseline so the NEXT gain is measured from here, never a stale high-water.
        if (cur < last) bot.state._notifiedRealizedUc = cur;
        return;
      }
      const deltaUsd = B.ucToUsd(delta) || 0;
      if (deltaUsd < 0.01) return; // too small yet; let it accumulate (baseline held)
      bot.state._notifiedRealizedUc = cur;
      const totalUsd = B.ucToUsd(cur) || 0;
      const pc = this._profitCurrency(bot);
      const tagMode = bot.mode === 'paper' ? ' (paper)' : '';
      const fmt = typeof N.fmtUsd === 'function' ? N.fmtUsd : (v) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
      this.emit({ type: 'bot_profit', bot: bot.id, name: bot.name, mode: bot.mode, deltaUsd, realizedUsd: totalUsd, currency: pc || undefined });
      try {
        N.defaultEmit({
          title: bot.name + ': ' + fmt(deltaUsd) + ' profit' + tagMode,
          message: pc ? 'Realized in ' + pc + ' · ' + fmt(totalUsd) + ' total' : fmt(totalUsd) + ' realized in total',
          subtitle: '',
          tag: 'botprofit:' + bot.id,
        });
      } catch (_) { /* notifications are best-effort — never block a tick */ }
    }

    // Lazy OS-notification permission (web Notification API): requested once, on
    // the first bot start — never at page load, never repeatedly.
    _requestNotifyPermission() {
      const N = this.Notify;
      if (N && typeof N.requestPermission === 'function') { try { N.requestPermission(); } catch (_) {} }
    }

    // The ONE gate call: temporarily set policy.autoApproveUnderUsd = remaining
    // allocation so an order WITHIN allocation auto-approves through the SAME gate
    // the NL runner uses; restore it afterward so bot state never leaks out.
    async _dispatch(bot, toolName, args, remainingUc) {
      const tool = this.tools.get(toolName);
      if (!tool || !tool.valueMoving) { await this._audit({ type: 'bot_blocked', bot: bot.id, tool: toolName, reason: 'not value-moving' }); return { rejected: true, reason: 'not value-moving' }; }
      const prevAuto = this.policy.autoApproveUnderUsd;
      if (remainingUc != null) this.policy.autoApproveUnderUsd = this.Bots.ucToUsd(remainingUc);
      try {
        await this._audit({ type: 'bot_dispatch', bot: bot.id, tool: toolName });
        const r = await this.dispatchValueMoving({
          tool, args, policy: this.policy, audit: this.audit, name: toolName,
          emit: (ev) => this.emit(ev), pnl: this.pnl, channel: bot.channel || this.channel, wallet: bot.wallet || this.wallet,
        });
        return r;
      } finally {
        this.policy.autoApproveUnderUsd = prevAuto;
      }
    }

    // ===========================================================================
    // UNIFORM PROFIT-CURRENCY SETTLEMENT (deal-engine exit/realize path, §8).
    // ---------------------------------------------------------------------------
    // Every lane realizes into the bot's profitCurrency through ONE place, not
    // per-strategy. After ANY realized SELL/exit (arb, momentum/take-profit, grid
    // sell) whose proceeds land in an asset != profitCurrency, emit ONE additional
    // SETTLEMENT swap (proceeds -> profitCurrency) dispatched through the SAME one
    // value-moving gate (allocation envelope, allowlist, security pre-sign, 0.05%
    // fee, mainnet gate). The realized-profit record + the pop-up then report the
    // FINAL settled currency. HONESTY OVER OPTIMISM: with no route (or the venue
    // rejects it) proceeds STAY in the native output and the returned currency is
    // the ACTUAL output — the label NEVER lies. The arb path already outputs the
    // profitCurrency, so the redundant hop is skipped (fromAsset === profitCurrency).
    // PAPER records the settlement but NEVER broadcasts. The scanner net-edge
    // already prices this leg — this is the realize-side execution of it.
    // ===========================================================================
    _profitCurrency(bot) {
      const pc = bot && bot.config && bot.config.profitCurrency;
      return (typeof pc === 'string' && pc.trim()) ? pc.trim().toUpperCase() : null;
    }

    // Does a route from `from` -> `to` exist? Injectable (tests/venue layer); the
    // default assumes the venue resolves the hop (the SAME assumption the scanner's
    // net-edge leg makes). A thrown/false result => NO route (we never fabricate).
    // LEVER 1+2 AT DISPATCH: resolve the cheapest fillable venue for THIS swap when
    // a route resolver is wired (ctx.routeCandidates -> route descriptors fed to the
    // shared Venues.chooseRoute; the internal Blockle rail is preferred when it can
    // actually fill the pair+size, never assumed). Falls back to the bot's configured
    // venue (default 'blockle'). Default-safe: with no resolver the venue is
    // unchanged, so every existing dispatch path behaves exactly as before.
    async _resolveVenue(bot, from, to, sizeUsd, chain) {
      const def = (bot.venuePrefs && bot.venuePrefs.venue) || 'blockle';
      try {
        if (this.ctx && typeof this.ctx.routeCandidates === 'function') {
          const cands = await this.ctx.routeCandidates({ from, to, sizeUsd, chain, bot: bot.id });
          if (Array.isArray(cands) && cands.length) {
            if (this._Venues === undefined) {
              this._Venues = root.Venues || (typeof require === 'function' ? (() => { try { return require('../venues.js'); } catch (_) { return null; } })() : null);
            }
            const V = this._Venues;
            const picked = (V && typeof V.chooseRoute === 'function') ? V.chooseRoute(cands) : null;
            if (picked && picked.venue) return picked.venue;
          }
        }
      } catch (_) {}
      return def;
    }

    async _settlementRoute(from, to) {
      if (this.ctx && typeof this.ctx.settlementRoute === 'function') {
        try { return !!(await this.ctx.settlementRoute(from, to)); } catch (_) { return false; }
      }
      return true;
    }

    // Convert realized proceeds into the bot's profitCurrency with ONE gated swap.
    // `s = { fromAsset, amount(BigInt base units), mainnet, remainingUc }`.
    // Returns { currency, settled, paper? } — currency is the FINAL settled asset
    // (profitCurrency on success; the ACTUAL native `fromAsset` on skip/no-route).
    async _settleToProfitCurrency(bot, s) {
      const B = this.Bots;
      const fromAsset = String(s.fromAsset || '').toUpperCase();
      const pc = this._profitCurrency(bot);
      // no profit currency chosen, or proceeds already ARE it -> no extra hop.
      if (!pc || !fromAsset || fromAsset === pc) return { currency: fromAsset || pc, settled: false };
      // REAL route check — never claim a conversion that cannot execute.
      const routable = await this._settlementRoute(fromAsset, pc);
      if (!routable || !s.amount || s.amount <= 0n) {
        await this._audit({ type: 'bot_settlement_skip', bot: bot.id, from: fromAsset, to: pc, reason: routable ? 'size' : 'no-route' });
        return { currency: fromAsset, settled: false, noRoute: !routable };
      }
      // mainnet gate + allowlist are NEVER skipped (same as every value move).
      if (s.mainnet && !this.mainnetEnabled) { await this._audit({ type: 'bot_settlement_skip', bot: bot.id, from: fromAsset, to: pc, reason: 'mainnet' }); return { currency: fromAsset, settled: false }; }
      if (!this.policy.isAllowed('swap')) { await this._audit({ type: 'bot_settlement_skip', bot: bot.id, from: fromAsset, to: pc, reason: 'allowlist' }); return { currency: fromAsset, settled: false }; }

      if (bot.mode === 'paper') {
        // PAPER: recorded, NEVER broadcast, NEVER consumes allocation.
        await this._audit({ type: 'bot_settlement', bot: bot.id, mode: 'paper', from: fromAsset, to: pc, amount: s.amount.toString() });
        return { currency: pc, settled: true, paper: true };
      }
      // LIVE: the ONE value-moving dispatch. A settlement is a realize-side move,
      // so (like every sell) it does not consume allocation; keep the auto-approve
      // envelope at remaining allocation so it clears the SAME gate.
      const envelope = (s.remainingUc != null && s.remainingUc > 0n) ? s.remainingUc : B.microUsd(bot.allocationUsd);
      const settleVenue = await this._resolveVenue(bot, fromAsset, pc, null, null);
      const args = { from: fromAsset, to: pc, amount: s.amount.toString(), venue: settleVenue };
      const r = await this._dispatch(bot, 'swap', args, envelope);
      if (!r || r.rejected || !r.result) {
        // the venue could not settle — honesty over optimism: keep native proceeds.
        await this._audit({ type: 'bot_settlement_skip', bot: bot.id, from: fromAsset, to: pc, reason: 'rejected' });
        return { currency: fromAsset, settled: false, noRoute: true };
      }
      await this._audit({ type: 'bot_settlement', bot: bot.id, mode: 'live', from: fromAsset, to: pc, amount: s.amount.toString(), txid: r.txid });
      return { currency: pc, settled: true, txid: r.txid };
    }

    // Settlement for an Intent-dispatched EXIT leg (momentum take-profit / scanner
    // arb sell). Only EXIT legs settle: a buy never does. The scanner already
    // rewrote the arb sell's OUTPUT to the profitCurrency, so fromAsset===pc there
    // and the redundant hop is skipped. Returns the realized currency or null when
    // the Intent is not an exit.
    async _maybeSettleIntent(bot, it, remainingUc) {
      const B = this.Bots;
      const isExit = it.exit === true || /:sell$/i.test(String(it.tag || ''));
      if (!isExit) return null;
      const fromAsset = (it.args && it.args.to) ? String(it.args.to).toUpperCase() : null;
      if (!fromAsset) return null;
      const pc = this._profitCurrency(bot);
      if (!pc || fromAsset === pc) return { currency: fromAsset, settled: false }; // no hop / redundant hop skipped
      // size the settlement from the exit's own USD estimate, priced in the
      // proceeds asset (no synthetic price: unknown price => treated as no route).
      const prices = await this._prices([fromAsset, pc]);
      const unitUc = this._unitUc(prices, fromAsset);
      const estUc = (Number.isFinite(it.estUsd) && it.estUsd > 0) ? B.microUsd(it.estUsd) : null;
      const amount = (unitUc && estUc) ? B.qtyForUsd(estUc, unitUc, B.decimalsFor(fromAsset)) : null;
      const ctxMainnet = this._ctxMainnet();
      return this._settleToProfitCurrency(bot, { fromAsset, amount, mainnet: (it.mainnet || ctxMainnet), remainingUc });
    }

    // ===========================================================================
    // FULL AUTO — "pick a chain, it does the rest". The parent bot hosts one CHILD
    // bot per algorithm (all on the parent's lane, mode and network) and acts as
    // a portfolio manager: every `rebalanceSec` it (1) classifies the lane's
    // market regime from the base coin's own price series, (2) scores each child
    // by its recent + lifetime return, and (3) re-weights the children's budgets
    // (regime prior × performance multiplier, floored at minWeight). A child whose
    // weight collapses can still MANAGE and EXIT its open deals — it just cannot
    // open new ones (its allocation sits at/below its committed spend), so the
    // switch between algorithms is always an orderly hand-off, never a dump.
    // Children never touch keys: every one of their orders goes through the SAME
    // _executeOrder / _dispatchIntents gates as a standalone bot.
    // ===========================================================================
    _autoAlgoSpecs(bot) {
      const B = this.Bots;
      const base = B.laneBase(bot.lane) || 'USDC';
      const quote = (bot.config && bot.config.quote) || (bot.lane === 'block' ? 'USDB' : 'USDC');
      const pair = base + '/' + quote;
      const risk = bot.riskMode || 'high';
      const pc = bot.config && bot.config.profitCurrency;
      const withPc = (c) => (pc ? Object.assign({}, c, { profitCurrency: pc }) : c);
      return {
        momentum: { name: 'Momentum', type: 'signal', riskMode: risk === 'sniper' ? 'high' : risk, universe: { pairs: [] },
          config: { source: 'discovery', maxConcurrent: 3, minScore: 0.5, onSignal: { type: 'dca', config: withPc({ baseOrderUsd: 0, safetyOrderUsd: 0, maxSafetyOrders: 2, safetyStepPct: 4, takeProfitPct: 8, trailingTpPct: 3, stopLossPct: 15, maxDealSec: 2 * 86400, candle: { enabled: true, sec: 120, minProfitPct: 2 } }) } } },
        // Buzz: what the internet is piling into right now (rank=buzz feed), quick exits.
        buzz: { name: 'Buzz', type: 'signal', riskMode: risk === 'sniper' ? 'high' : risk, universe: { pairs: [] },
          config: { source: 'discovery', rank: 'buzz', maxConcurrent: 3, minScore: 0.45, onSignal: { type: 'smarttrade', config: withPc({ amountUsd: 0, takeProfits: [{ pct: 8, sharePct: 50 }, { pct: 20, sharePct: 50 }], stopLoss: { pct: 10, trailing: true }, candle: { enabled: true, sec: 60, minProfitPct: 2 } }) } } },
        sniper: { name: 'Sniper', type: 'signal', riskMode: 'sniper', universe: { pairs: [] },
          config: { source: 'discovery', maxConcurrent: 3, minScore: 0.55, onSignal: { type: 'smarttrade', config: withPc({ amountUsd: 0, takeProfits: [{ pct: 25, sharePct: 50 }, { pct: 60, sharePct: 50 }], stopLoss: { pct: 18, trailing: true }, candle: { enabled: true, sec: 60, minProfitPct: 3 } }) } } },
        grid: { name: 'Grid', type: 'grid', riskMode: risk, universe: { pairs: [pair] },
          config: withPc({ autoRangePct: 5, gridCount: 10, totalUsd: 0, stopLossPct: 12 }) },
        dip: { name: 'Dip-buyer', type: 'dca', riskMode: risk, universe: { pairs: [pair] },
          config: withPc({ baseOrderUsd: 0, safetyOrderUsd: 0, maxSafetyOrders: 4, safetyStepPct: 2.5, safetyVolumeScale: 1.3, takeProfitPct: 5, trailingTpPct: 1.5, startCondition: 'dip', dipPct: 1.5, candle: { enabled: true, sec: 300, minProfitPct: 1.5 } }) },
        scanner: { name: 'Autopilot', type: 'scanner', riskMode: risk, universe: { pairs: [] },
          config: withPc({ minProfitBps: 10, maxConcurrentPairs: 6, perTradeUsd: 0, strategies: ['arbitrage', 'momentum', 'grid', 'sniper'], sniperMinScore: 0.45, gasBufferUsd: 1, slippageBps: 15, agentFeeBps: 5 }) },
      };
    }
    // Size a child's per-order amounts from its budget share (so a 20% child
    // places 20%-sized orders, not full-size orders it can only afford once).
    _autoSizeChild(child, algo, budgetUsd) {
      const c = child.config;
      const b = Math.max(0, budgetUsd);
      if (algo === 'momentum') { const per = Math.max(1, b / 3); c.onSignal.config.baseOrderUsd = round2(per / 2); c.onSignal.config.safetyOrderUsd = round2(per / 4); }
      else if (algo === 'sniper' || algo === 'buzz') { c.onSignal.config.amountUsd = round2(Math.max(1, b / 3)); }
      else if (algo === 'grid') { c.totalUsd = round2(b); }
      else if (algo === 'dip') { const per = Math.max(1, b / 5); c.baseOrderUsd = round2(per); c.safetyOrderUsd = round2(per); }
      else if (algo === 'scanner') { c.perTradeUsd = round2(Math.max(1, b / 3)); }
    }
    _autoChildren(bot) {
      if (bot._children) return bot._children;
      const B = this.Bots;
      const specs = this._autoAlgoSpecs(bot);
      const saved = {};
      for (const j of ((bot.state && bot.state.children) || [])) if (j && j.algo) saved[j.algo] = j;
      const kids = [];
      for (const algo of bot.config.algos) {
        const spec = specs[algo]; if (!spec) continue;
        let child;
        if (saved[algo]) { child = B.Bot.fromJSON(Object.assign({}, saved[algo], { state: saved[algo].state })); }
        else child = new B.Bot(Object.assign({ id: bot.id + ':' + algo, lane: bot.lane, profitMode: bot.profitMode, mode: bot.mode, network: bot.network, pollSec: bot.pollSec, risk: { paperSlippageBps: bot.risk && bot.risk.paperSlippageBps || 0 }, wallet: bot.wallet, channel: bot.channel }, spec));
        child.algo = algo; child.parent = bot.id; child.enabled = true;
        kids.push(child);
      }
      bot._children = kids;
      return kids;
    }
    _autoPersistChildren(bot) {
      if (!bot._children) return;
      bot.state.children = bot._children.map((c) => Object.assign(c.toJSON(), { algo: c.algo, parent: bot.id }));
    }
    // Market regime from the lane base's own recent price series. Returns
    // { regime: 'trend-up'|'trend-down'|'ranging'|'quiet'|'warming', ret, vol, strength }.
    _autoRegime(bot) {
      const cfg = bot.config;
      const s = (bot.state.series || []).slice(-cfg.regimeWindow);
      if (s.length < 8) return { regime: 'warming', n: s.length };
      const ps = s.map((x) => Number(x.p)).filter((p) => p > 0);
      const rets = []; for (let i = 1; i < ps.length; i++) rets.push(Math.log(ps[i] / ps[i - 1]));
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1));
      const ret = ps[ps.length - 1] / ps[0] - 1;
      const strength = vol > 0 ? Math.abs(ret) / (vol * Math.sqrt(rets.length)) : (ret !== 0 ? 9 : 0);
      let regime;
      if (vol < 0.0005 && Math.abs(ret) < 0.003) regime = 'quiet';
      else if (strength >= 1.2 && ret > 0.01) regime = 'trend-up';
      else if (strength >= 1.2 && ret < -0.01) regime = 'trend-down';
      else regime = 'ranging';
      return { regime, ret: round4(ret * 100), vol: round4(vol * 100), strength: round4(strength), n: ps.length };
    }
    _autoPriors(regime) {
      return ({
        // Buzz rides cross-token attention, so it keeps a floor even when the lane
        // base is quiet/ranging and leads with momentum in an up-trend.
        'trend-up':   { momentum: 0.35, buzz: 0.20, sniper: 0.15, scanner: 0.10, grid: 0.08, dip: 0.12 },
        'trend-down': { momentum: 0.10, buzz: 0.10, sniper: 0.05, scanner: 0.20, grid: 0.20, dip: 0.35 },
        ranging:      { momentum: 0.10, buzz: 0.15, sniper: 0.10, scanner: 0.15, grid: 0.35, dip: 0.15 },
        quiet:        { momentum: 0.15, buzz: 0.20, sniper: 0.10, scanner: 0.25, grid: 0.20, dip: 0.10 },
        warming:      { momentum: 1 / 6, buzz: 1 / 6, sniper: 1 / 6, scanner: 1 / 6, grid: 1 / 6, dip: 1 / 6 },
      })[regime] || { momentum: 1 / 6, buzz: 1 / 6, sniper: 1 / 6, scanner: 1 / 6, grid: 1 / 6, dip: 1 / 6 };
    }
    // Re-weight the children: prior(regime) × performance multiplier, floored.
    _autoRebalance(bot, kids, now, reg) {
      const B = this.Bots;
      const cfg = bot.config;
      const prior = this._autoPriors(reg.regime);
      const budgetUsd = B.ucToUsd(this._effectiveCapUc(bot));
      const scores = {};
      let total = 0;
      for (const c of kids) {
        const d = this.dashboard(c);
        const alloc = Math.max(1, c.allocationUsd || budgetUsd / kids.length);
        const life = ((d.realizedUsd || 0) + (d.unrealizedUsd || 0)) / alloc;             // lifetime return on its share
        const baseline = c.state._perfBaseUsd != null ? c.state._perfBaseUsd : 0;
        const recent = ((d.realizedUsd || 0) + (d.unrealizedUsd || 0) - baseline) / alloc; // since last rebalance
        const perf = 0.6 * recent + 0.4 * life;                                            // fraction, e.g. 0.05 = +5%
        const mult = Math.max(0.3, Math.min(3, 1 + perf * 10));                            // +10% ⇒ 2×, −7% ⇒ 0.3×
        const w = (prior[c.algo] || 0.2) * mult;
        scores[c.algo] = { prior: prior[c.algo] || 0.2, perf: round4(perf * 100), mult: round4(mult), raw: w };
        total += w;
      }
      const weights = {};
      let floorSum = 0;
      for (const c of kids) { const w = total > 0 ? scores[c.algo].raw / total : 1 / kids.length; weights[c.algo] = Math.max(cfg.minWeight, w); floorSum += weights[c.algo]; }
      for (const a of Object.keys(weights)) weights[a] = round4(weights[a] / floorSum);
      // 4-dp rounding can leave the shares a few bps off 1 (e.g. 6 × 0.1667); the
      // residual goes to the largest share so the budget split is exact.
      const residual = round4(1 - Object.values(weights).reduce((s, v) => s + v, 0));
      if (residual !== 0 && Object.keys(weights).length) {
        const top = Object.keys(weights).reduce((x, y) => (weights[x] >= weights[y] ? x : y));
        weights[top] = round4(weights[top] + residual);
      }
      const prev = bot.state.auto && bot.state.auto.weights;
      for (const c of kids) {
        const share = round2(budgetUsd * weights[c.algo]);
        c.allocationUsd = share;
        this._autoSizeChild(c, c.algo, share);
        const d = this.dashboard(c);
        c.state._perfBaseUsd = (d.realizedUsd || 0) + (d.unrealizedUsd || 0);
      }
      const lead = kids.slice().sort((a, b) => weights[b.algo] - weights[a.algo])[0];
      bot.state.auto = { at: now, regime: reg.regime, regimeInfo: reg, weights, scores, lead: lead ? lead.algo : null, rebalances: ((bot.state.auto && bot.state.auto.rebalances) || 0) + 1 };
      const changed = !prev || Object.keys(weights).some((a) => Math.abs((prev[a] || 0) - weights[a]) >= 0.1) || (bot.state.auto.lastRegime && bot.state.auto.lastRegime !== reg.regime);
      bot.state.auto.lastRegime = reg.regime;
      this._audit({ type: 'auto_rebalance', bot: bot.id, regime: reg.regime, weights, scores });
      if (changed) {
        const order = kids.slice().sort((a, b) => weights[b.algo] - weights[a.algo]);
        this._feed(bot, { kind: 'switch', regime: reg.regime, weights, text: 'Market looks ' + regimeLabel(reg.regime) + ' → ' + order.map((c) => c.name + ' ' + Math.round(weights[c.algo] * 100) + '%').join(' · ') });
      }
    }
    async _tickAuto(bot, now, opts) {
      const B = this.Bots;
      const cfg = bot.config;
      const kids = this._autoChildren(bot);
      // 1) sample the lane base for the regime series (its OWN price, no synthetic data)
      const base = B.laneBase(bot.lane) || 'USDC';
      const prices = await this._prices([base]);
      const markUc = this._unitUc(prices, base);
      if (markUc != null) {
        const s = bot.state.series = bot.state.series || [];
        if (!s.length || now - s[s.length - 1].t >= Math.min(60000, bot.pollSec * 1000)) { s.push({ t: now, p: B.ucToUsd(markUc) }); if (s.length > 500) s.splice(0, s.length - 500); }
        bot.state.lastMarks = bot.state.lastMarks || {}; bot.state.lastMarks[base] = B.ucToUsd(markUc);
      }
      // 2) rebalance when due, on the first tick, or when the regime flips
      const reg = this._autoRegime(bot);
      const a = bot.state.auto;
      const due = !a || (now - (a.at || 0)) >= cfg.rebalanceSec * 1000 || (a.regime !== reg.regime && reg.regime !== 'warming');
      if (due) this._autoRebalance(bot, kids, now, reg);
      // 3) tick every child through the normal path (same gates, same audit)
      const events = [];
      for (const c of kids) {
        c.mode = bot.mode; c.network = bot.network; c.enabled = true;
        if (bot.risk && bot.risk.paperSlippageBps != null) c.risk.paperSlippageBps = bot.risk.paperSlippageBps;
        const r = await this.tickBot(c, opts);
        events.push({ algo: c.algo, events: (r && r.events) || [], error: r && r.error ? r.error : undefined });
      }
      // 4) parent-level max-loss rail across ALL children
      const d = this.dashboard(bot);
      const pct = bot.risk && bot.risk.maxLossPct;
      if (pct > 0 && bot.allocationUsd > 0 && (d.realizedUsd || 0) < 0 && -(d.realizedUsd || 0) >= bot.allocationUsd * pct / 100) {
        bot.enabled = false; bot.state.haltReason = 'max-loss';
        await this._audit({ type: 'bot_paused', bot: bot.id, reason: 'max-loss', realizedUsd: d.realizedUsd, maxLossPct: pct });
        this._feed(bot, { kind: 'halt', text: 'Max-loss rail hit (' + pct + '% of budget) — Full Auto paused. Review and restart when ready.' });
        this.emit({ type: 'bot_paused', bot: bot.id, reason: 'max-loss' });
      }
      this._autoPersistChildren(bot);
      return { bot: bot.id, type: 'auto', regime: reg.regime, weights: bot.state.auto && bot.state.auto.weights, events, dashboard: d };
    }
    // Parent view of a Full Auto bot: the children's numbers rolled up.
    _autoDashboard(bot) {
      const B = this.Bots;
      const kids = this._autoChildren(bot);
      const ds = kids.map((c) => this.dashboard(c));
      let realized = 0, unrealized = 0, committed = 0, deals = 0, wins = 0, losses = 0, dd = 0;
      const active = [], closed = [], feed = (bot.state.feed || []).slice();
      ds.forEach((d, i) => {
        realized += d.realizedUsd || 0; unrealized += d.unrealizedUsd || 0; committed += d.committedUsd || 0;
        deals += d.totalDeals || 0; wins += d.winCount || 0; losses += d.lossCount || 0; dd += d.maxDrawdownUsd || 0;
        for (const x of (d.activeDeals || [])) active.push(Object.assign({}, x, { algo: kids[i].algo, pair: x.pair + ' · ' + kids[i].name.replace(/^\S+\s/, '') }));
        for (const x of (d.closedDeals || [])) closed.push(Object.assign({}, x, { algo: kids[i].algo }));
        for (const e of (kids[i].state.feed || [])) feed.push(Object.assign({}, e, { algo: kids[i].algo }));
      });
      closed.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
      feed.sort((a, b) => (b.at || 0) - (a.at || 0));
      const streak = kids.length ? Math.max.apply(null, kids.map((c) => c.state.streak || 0)) : 0;
      const bestStreak = kids.length ? Math.max.apply(null, kids.map((c) => c.state.bestStreak || 0)) : 0;
      const cap = B.ucToUsd(this._effectiveCapUc(bot));
      return {
        bot: bot.id, name: bot.name, type: 'auto', mode: bot.mode, enabled: bot.enabled, network: bot.network,
        status: this._killed ? 'killed' : (bot.state.haltReason ? 'halted' : (bot.enabled ? 'running' : 'paused')),
        haltReason: bot.state.haltReason || null,
        lastTickAt: bot.state.lastTickAt || 0, lastError: bot.state.lastError || null, pollSec: bot.pollSec,
        streak, bestStreak, feed: feed.slice(0, 20), risk: bot.risk || null, lastScan: null,
        closedDeals: closed.slice(0, 10),
        allocationUsd: bot.allocationUsd, lane: bot.lane || null, riskMode: bot.riskMode || null, profitMode: bot.profitMode || 'off',
        effectiveCapUsd: cap, committedUsd: committed, remainingUsd: (bot.mode === 'live' || bot.allocationUsd > 0) ? cap - committed : null,
        activeDeals: active, safetyOrdersUsed: ds.reduce((a, d) => a + (d.safetyOrdersUsed || 0), 0),
        realizedUsd: realized, unrealizedUsd: unrealized, totalDeals: deals, winCount: wins, lossCount: losses,
        winRate: deals > 0 ? wins / deals : null, maxDrawdownUsd: dd,
        auto: Object.assign({ regime: 'warming', weights: {}, lead: null }, bot.state.auto || {}, {
          children: kids.map((c, i) => ({ algo: c.algo, name: c.name, weight: bot.state.auto && bot.state.auto.weights ? bot.state.auto.weights[c.algo] : null, allocationUsd: c.allocationUsd, realizedUsd: ds[i].realizedUsd, unrealizedUsd: ds[i].unrealizedUsd, activeDeals: (ds[i].activeDeals || []).length, totalDeals: ds[i].totalDeals, winRate: ds[i].winRate, perf: bot.state.auto && bot.state.auto.scores && bot.state.auto.scores[c.algo] ? bot.state.auto.scores[c.algo].perf : null })),
          series: (bot.state.series || []).slice(-60).map((x) => x.p),
        }),
      };
    }

    // ---- signal bot (§2.4) --------------------------------------------------
    async _tickSignal(bot, now, opts) {
      const B = this.Bots;
      const cfg = bot.config;
      const spawn = cfg.onSignal; // { type, config }
      const openCount = Object.values(bot.state.byPair).filter((p) => p.deal && p.deal.status !== 'closed').length;
      let room = Math.max(0, cfg.maxConcurrent - openCount);

      // gather candidate pairs (READ-ONLY; discovery never trades/auto-allowlists)
      const signals = [];
      if ((cfg.source === 'discovery' || cfg.source === 'both') && this.discovery && typeof this.discovery.scan === 'function') {
        let cands = [];
        // Lane + risk-mode aware discovery: the feed returns only same-chain,
        // same-mode candidates that already cleared the safety gate.
        const byBuzz = cfg.rank === 'buzz';
        try { cands = (await this.discovery.scan({ lane: bot.lane, mode: bot.riskMode, rank: byBuzz ? 'buzz' : undefined })) || []; } catch (_) { cands = []; }
        const laneChain = bot.lane && B.laneChain ? B.laneChain(bot.lane) : null;
        const laneSig = bot.lane && B.laneSignalsChain ? B.laneSignalsChain(bot.lane) : laneChain;
        const preset = bot.riskMode && B.riskPreset ? B.riskPreset(bot.riskMode) : null;
        for (const c of cands) {
          if (laneChain && c.chain && c.chain !== laneChain && c.chain !== laneSig) continue; // never cross-lane
          if (!(c.approved === true && (c.score == null || c.score >= cfg.minScore) && c.pair)) continue;
          // RISK-MODE double-check on the candidate's own metrics (the feed already
          // gated them, but a stricter local preset must still win).
          if (preset) {
            if (c.honeypot === true) continue;
            if (c.liquidityUsd != null && Number(c.liquidityUsd) < preset.minLiquidityUsd) continue;
            if (!preset.allowNewLaunches && c.ageSec != null && Number(c.ageSec) < preset.minAgeSec) continue;
            if (c.score != null && c.score * 100 < preset.minSignalScore) continue;
          }
          const bz = c.buzz && typeof c.buzz === 'object' ? c.buzz : null;
          // Buzz rank: a candidate with NO buzz data (or quick 0 = unsafe/no traffic) is not a buzz signal.
          if (byBuzz && !(bz && Number(bz.quick) > 0)) continue;
          signals.push({ pair: c.pair, score: c.score, source: 'discovery', symbol: c.symbol, token: c.token, buzz: bz });
        }
        // best first so the limited concurrency slots go to the strongest signals:
        // buzz.quick for the online-presence rank, else the safety-weighted score.
        const rk = (s) => byBuzz ? (Number(s.buzz && s.buzz.quick) || 0) : (Number(s.score) || 0);
        signals.sort((a, b) => rk(b) - rk(a));
      }
      if (cfg.source === 'inbox' || cfg.source === 'both') {
        const inbox = bot.state.inbox || [];
        for (let i = bot.state.cursor || 0; i < inbox.length; i++) {
          const s = inbox[i];
          if (s && s.pair) signals.push({ pair: s.pair, source: 'inbox' });
        }
        bot.state.cursor = inbox.length;
      }

      // arm a spawned deal per NEW pair, up to maxConcurrent
      for (const sig of signals) {
        if (room <= 0) break;
        const pair = String(sig.pair).toUpperCase();
        if (bot.state.byPair[pair] && bot.state.byPair[pair].deal && bot.state.byPair[pair].deal.status !== 'closed') continue;
        if (!bot.state.byPair[pair]) bot.state.byPair[pair] = { deal: null, lastCloseAt: 0 };
        bot.state.byPair[pair].signalArmed = true;
        await this._audit({ type: 'bot_signal', bot: bot.id, pair, source: sig.source, template: spawn.type, buzz: sig.buzz ? { attention: sig.buzz.attention, velocity: sig.buzz.velocity, quick: sig.buzz.quick } : undefined });
        this._feed(bot, sig.buzz
          ? { kind: 'signal', pair, score: sig.score, buzz: sig.buzz, text: 'Buzz ' + pair + ' · attention ' + sig.buzz.attention + ' · velocity ' + sig.buzz.velocity + ' · quick ' + sig.buzz.quick + ' — arming ' + spawn.type }
          : { kind: 'signal', pair, score: sig.score, text: 'Signal ' + pair + (sig.score != null ? ' · score ' + Math.round(sig.score * 100) : '') + ' — arming ' + spawn.type });
        room -= 1;
      }

      // run the spawned deal engine over ALL armed pairs
      const pairs = Object.keys(bot.state.byPair);
      return this._tickDealBot(bot, spawn.type, spawn.config, pairs, now, opts);
    }

    // Post a local signal to a signal bot's inbox (user / NL agent). READ side only.
    async postSignal(id, signal) {
      const bot = this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      bot.state.inbox = bot.state.inbox || [];
      bot.state.inbox.push(signal);
      await this.store.persist();
      return bot;
    }

    // ---- scheduled bots (rebalance / momentum) reuse the strategy planners ----
    async _tickScheduled(bot, now, opts) {
      const Strategies = this.Strategies || dep('AgentStrategies', './strategies.js');
      const strat = Strategies.createRegistry().get(bot.type);
      if (!strat) return { bot: bot.id, error: 'no strategy ' + bot.type };
      const params = strat.validateParams(Object.assign({}, bot.config));
      const intents = await strat.plan(this.ctx, params);
      const events = await this._dispatchIntents(bot, intents || []);
      return { bot: bot.id, type: bot.type, events };
    }

    // The ONE shared Intent-dispatch loop used by scheduled bots AND the scanner:
    // every Intent passes the SAME non-bypassable gate — FINITE+positive estimate,
    // the hard per-bot allocation ledger (trade + 0.05% fee), the mainnet gate, the
    // tool allowlist, and the ONE value-moving dispatch (caps/confirm/kill/audit/
    // security pre-sign). PAPER records a paper_intent and NEVER broadcasts. Kill is
    // honored between Intents. Returns a per-Intent event list.
    async _dispatchIntents(bot, intents) {
      const B = this.Bots;
      const ctxMainnet = this._ctxMainnet();
      const events = [];
      for (const it of (intents || [])) {
        if (this.policy.isKilled()) break;
        if (bot.mode === 'live') {
          // FIX-EST: a LIVE order must carry a FINITE, POSITIVE USD estimate or it
          // FAILS CLOSED. null/NaN/Infinity would coerce to $0 and slip past the
          // cap; a NEGATIVE estimate would accrue negative and EXPAND the ledger —
          // both bypass the hard cap, so reject all.
          if (!Number.isFinite(it.estUsd) || it.estUsd <= 0) {
            await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'allocation-unknown', tag: it.tag });
            events.push({ tag: it.tag, skipped: 'allocation-unknown' });
            continue;
          }
          const estUsdUc = B.microUsd(it.estUsd);
          const feeUc = B.agentFeeUc(estUsdUc); // allocation bounds the trade + 0.05% fee
          const remainingUc = this._effectiveCapUc(bot) - (bot.state.committedUc || 0n); // + realized profit when compounding
          if (estUsdUc + feeUc > remainingUc) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'allocation', tag: it.tag }); events.push({ tag: it.tag, skipped: 'allocation' }); continue; }
          if ((it.mainnet || ctxMainnet) && !this.mainnetEnabled) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'mainnet', tag: it.tag }); events.push({ tag: it.tag, skipped: 'mainnet' }); continue; }
          if (!this.policy.isAllowed(it.tool)) { await this._audit({ type: 'bot_blocked', bot: bot.id, tool: it.tool }); events.push({ tag: it.tag, blocked: true }); continue; }
          const r = await this._dispatch(bot, it.tool, it.args, remainingUc);
          if (r && r.result) {
            bot.state.committedUc = (bot.state.committedUc || 0n) + estUsdUc + feeUc;
            const ev = { tag: it.tag, executed: true };
            this._emitTradeFee(bot, this._intentQuote(it), it.estUsd, null); // 0.05% fee -> liquidity treasury
            // UNIFORM SETTLEMENT: an executed EXIT leg realizes into the profitCurrency
            // (ONE extra gated swap; skipped for the arb sell whose output already IS it).
            const st = await this._maybeSettleIntent(bot, it, remainingUc);
            if (st) { ev.settledCurrency = st.currency; ev.realized = { currency: st.currency }; }
            events.push(ev);
          } else events.push({ tag: it.tag, rejected: r && r.reason });
        } else {
          if ((it.mainnet || ctxMainnet) && !this.mainnetEnabled) { events.push({ tag: it.tag, skipped: 'mainnet' }); continue; }
          await this._audit({ type: 'bot_paper_intent', bot: bot.id, tag: it.tag, estUsd: it.estUsd });
          const ev = { tag: it.tag, paper: true };
          if (Number.isFinite(it.estUsd) && it.estUsd > 0) this._emitTradeFee(bot, this._intentQuote(it), it.estUsd, null); // 0.05% fee -> liquidity treasury
          const st = await this._maybeSettleIntent(bot, it, null); // PAPER: records, never broadcasts
          if (st) { ev.settledCurrency = st.currency; ev.realized = { currency: st.currency }; }
          events.push(ev);
        }
      }
      return events;
    }

    // ---- scanner (scan-&-trade autopilot, docs/AGENT-SCAN.md) -----------------
    // Build the candidate universe (discovery feed ∪ exchange markets ∪ venue pairs,
    // enriched with market data), score every pair with the shared AgentScanner
    // evaluator, pick the worthy ones that fit the REMAINING allocation, and
    // dispatch each chosen Intent through the SAME _dispatchIntents gate as every
    // other bot. READ-ONLY until dispatch; never fabricates a price/edge; a
    // sub-threshold or net-negative pair is NEVER emitted. Returns the scored
    // candidate list (for the UI) + the dispatch events.
    async _tickScanner(bot, now, opts) {
      const B = this.Bots;
      const Scanner = this.Scanner || dep('AgentScanner', './scanner.js');
      const Strategies = this.Strategies || dep('AgentStrategies', './strategies.js');
      const universe = await this._scanUniverse(bot);
      const committedUsd = B.ucToUsd(bot.state.committedUc || 0n);
      const result = await Scanner.scanAndScore(universe, bot.config, {
        Strategies, allocationUsd: bot.allocationUsd, committedUsd, mainnet: this._ctxMainnet(),
      });
      await this._audit({
        type: 'scanner_scan', bot: bot.id, candidates: result.candidates.length,
        worthy: result.worthy.length, traded: result.worthy.map((w) => w.pair),
        skipped: result.skipped.map((s) => s.pair + ':' + s.reason),
      });
      // dispatch the chosen Intents through the ONE gate (same as scheduled bots).
      const events = await this._dispatchIntents(bot, result.intents);
      // last-scan snapshot for the UI cockpit card.
      bot.state.lastScan = {
        at: now, candidates: result.candidates, worthy: result.worthy.map((w) => w.pair),
        skipped: result.skipped, minProfitBps: result.minProfitBps,
        allocationUsd: result.allocationUsd, committedUsd, remainingUsd: result.remainingUsd,
        profitCurrency: result.profitCurrency,
      };
      return { bot: bot.id, type: 'scanner', scan: bot.state.lastScan, events };
    }

    // Assemble the scanner's candidate universe. Prefer an injected enriched feed
    // (ctx.scanUniverse — discovery ∪ exchange markets ∪ venue pairs WITH venue
    // prices/history/book), else fall back to the discovery feed. READ-ONLY.
    async _scanUniverse(bot) {
      if (this.ctx && typeof this.ctx.scanUniverse === 'function') {
        try { return (await this.ctx.scanUniverse(bot && bot.config)) || []; } catch (_) { return []; }
      }
      if (this.discovery && typeof this.discovery.scan === 'function') {
        try {
          const B = this.Bots;
          let rows = (await this.discovery.scan({ lane: bot && bot.lane, mode: bot && bot.riskMode })) || [];
          const laneChain = bot && bot.lane && B.laneChain ? B.laneChain(bot.lane) : null;
          if (laneChain) rows = rows.filter((r) => !r.chain || r.chain === laneChain); // never cross-lane
          return rows;
        } catch (_) { return []; }
      }
      return [];
    }

    // ===========================================================================
    // per-bot dashboard DATA (§4) — accessors only, no UI.
    // ===========================================================================
    dashboard(id, marksOverride) {
      const B = this.Bots;
      const bot = typeof id === 'object' ? id : this.store.get(id);
      if (!bot) return null;
      if (bot.type === 'auto') return this._autoDashboard(bot);
      const openDeals = [];
      let unrealizedUc = 0n;
      let safetyUsed = 0;
      const marks = marksOverride || bot.state.lastMarks || {};
      for (const pair of Object.keys(bot.state.byPair || {})) {
        const ps = bot.state.byPair[pair];
        const deal = ps && ps.deal;
        if (!deal || deal.status === 'closed') continue;
        const [base] = B.splitPair(pair);
        let markUc = null;
        if (marks && marks[base] != null) markUc = B.microUsd(marks[base]);
        if (deal.type === 'grid') {
          let uc = 0n;
          for (const lv of deal.levels) if (lv.heldQty > 0n && markUc != null) uc += B.valueOf(lv.heldQty, markUc, B.decimalsFor(base, bot.config.decimals)) - (lv._costUc || 0n);
          unrealizedUc += uc;
          openDeals.push({ pair, type: 'grid', levels: deal.levels.length, filledLevels: deal.levels.filter((l) => l.heldQty > 0n).length, realizedUc: (deal.realizedUc || 0n).toString() });
        } else {
          const qty = deal.filledQty != null ? deal.filledQty : deal.remainingQty;
          const cost = deal.costUc != null ? deal.costUc : deal.entryCostUc;
          safetyUsed += deal.safetyOrdersUsed || 0;
          let uc = 0n;
          if (markUc != null && qty > 0n) uc = B.valueOf(qty, markUc, B.decimalsFor(base, bot.config.decimals)) - (cost || 0n);
          unrealizedUc += uc;
          openDeals.push({
            pair, type: deal.type, status: deal.status,
            avgEntryUsd: B.ucToUsd(deal.avgEntryUc), filledQty: (qty || 0n).toString(),
            costUsd: B.ucToUsd(cost || 0n), markUsd: markUc != null ? B.ucToUsd(markUc) : null,
            safetyOrdersUsed: deal.safetyOrdersUsed || 0, openedAt: deal.openedAt || 0,
            unrealizedUsd: markUc != null ? B.ucToUsd(uc) : null,
            unrealizedPct: (markUc != null && cost > 0n) ? Number(uc * 10000n / cost) / 100 : null,
          });
        }
      }
      const dealCount = bot.state.dealCount || 0;
      const wins = bot.state.winCount || 0;
      return {
        bot: bot.id, name: bot.name, type: bot.type, mode: bot.mode, enabled: bot.enabled, network: bot.network,
        status: this._killed ? 'killed' : (bot.state.haltReason ? 'halted' : (bot.enabled ? 'running' : 'paused')),
        haltReason: bot.state.haltReason || null,
        lastTickAt: bot.state.lastTickAt || 0, lastError: bot.state.lastError || null, pollSec: bot.pollSec,
        streak: bot.state.streak || 0, bestStreak: bot.state.bestStreak || 0,
        feed: (bot.state.feed || []).slice(-20),
        risk: bot.risk || null, lastScan: bot.state.lastScan || null,
        closedDeals: (bot.state.closedDeals || []).slice(-10).map((d) => ({ id: d.id, type: d.type, reason: d.reason, realizedUsd: B.ucToUsd(d.realizedUc || 0n), openedAt: d.openedAt, closedAt: d.closedAt, fills: (d.fills || []).length })).reverse(),
        allocationUsd: bot.allocationUsd,
        lane: bot.lane || null, riskMode: bot.riskMode || null, profitMode: bot.profitMode || 'off',
        // compounding effective cap (budget + realized profit); equals the budget for off/take
        effectiveCapUsd: B.ucToUsd(this._effectiveCapUc(bot)),
        committedUsd: B.ucToUsd(bot.state.committedUc || 0n),
        // remaining budget shown whenever one is set (live always; paper when a budget was given)
        remainingUsd: (bot.mode === 'live' || bot.allocationUsd > 0) ? B.ucToUsd(this._effectiveCapUc(bot) - (bot.state.committedUc || 0n)) : null,
        activeDeals: openDeals,
        safetyOrdersUsed: safetyUsed,
        realizedUsd: B.ucToUsd(bot.state.realizedUc || 0n),
        unrealizedUsd: B.ucToUsd(unrealizedUc),
        totalDeals: dealCount,
        winCount: wins, lossCount: bot.state.lossCount || 0,
        winRate: dealCount > 0 ? wins / dealCount : null,
        maxDrawdownUsd: B.ucToUsd(bot.state.maxDrawdownUc || 0n),
      };
    }

    aggregate() {
      const B = this.Bots;
      let realizedUc = 0n; const rows = [];
      let unrealized = 0, allocation = 0, committed = 0, activeDeals = 0, running = 0, live = 0, deals = 0, wins = 0;
      const feed = [];
      for (const bot of this.store.list()) {
        realizedUc += bot.state.realizedUc || 0n;
        const d = this.dashboard(bot.id);
        rows.push(d);
        unrealized += d.unrealizedUsd || 0; allocation += d.allocationUsd || 0; committed += d.committedUsd || 0;
        activeDeals += (d.activeDeals || []).length; deals += d.totalDeals || 0; wins += d.winCount || 0;
        if (d.status === 'running') running += 1;
        if (bot.mode === 'live' && bot.enabled) live += 1;
        for (const ev of (bot.state.feed || [])) feed.push(Object.assign({ bot: bot.id, name: bot.name }, ev));
      }
      feed.sort((a, b) => (b.at || 0) - (a.at || 0));
      return {
        realizedUsd: B.ucToUsd(realizedUc), unrealizedUsd: unrealized, allocationUsd: allocation, committedUsd: committed,
        activeDeals, running, live, totalDeals: deals, winRate: deals > 0 ? wins / deals : null,
        bots: rows, feed: feed.slice(0, 40), killed: this._killed, scheduler: this.schedulerRunning(),
      };
    }

    // Resume a bot the max-loss rail halted (the user explicitly accepts the risk).
    async resume(id) {
      const bot = this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      bot.state.haltReason = null;
      bot.enabled = true;
      await this._audit({ type: 'bot_resumed', bot: id });
      await this.store.persist();
      this._restartScheduler();
      return bot;
    }
  }

  function round2(n) { return Math.round(Number(n) * 100) / 100; }
  function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
  function regimeLabel(r) { return ({ 'trend-up': 'TRENDING UP', 'trend-down': 'TRENDING DOWN', ranging: 'RANGING', quiet: 'QUIET', warming: 'still warming up' })[r] || r; }
  function fmtUsdShort(v) {
    const n = Number(v); if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const s = a >= 1000 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(4) : a.toExponential(2);
    return (n < 0 ? '-$' : '$') + s;
  }
  function labelFor(kind) {
    return ({ base: 'base order', safety: 'safety order', tp: 'take-profit', ctp: 'candle take-profit', sl: 'stop-loss', time: 'time stop', manual: 'stopped by you', grid: 'grid rung', grid_exit: 'grid exit', entry: 'entry', arm: 'trailing armed' })[kind] || (kind || '');
  }

  const AgentBotRunner = { create(deps) { return new BotRunner(deps); }, BotRunner };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentBotRunner;
  root.AgentBotRunner = AgentBotRunner;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
