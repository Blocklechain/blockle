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
      this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
      this.pnl = deps.pnl || null;              // post-commit realized-profit tracker (LIVE)
      this.store = deps.store || new this.Bots.BotStore({ store: deps.persist, wallet: deps.wallet, channel: deps.channel });
      this.discovery = deps.discovery || this.ctx.discovery || null;
      this.Strategies = deps.Strategies || null; // optional injection (tests); else lazy-required
      this.wallet = deps.wallet || 'default';
      this.channel = deps.channel || 'default';
      this._killed = false;
      // the ONE shared value-moving routine (no second broadcast path)
      this.dispatchValueMoving = (deps.AgentRunner || dep('AgentRunner', './runner.js')).dispatchValueMoving;
    }

    emit(ev) { if (this.onEvent) { try { this.onEvent(ev); } catch (_) {} } }
    async _audit(rec) { if (this.audit) { try { return await this.audit.record(rec); } catch (_) {} } }

    // ---- bot lifecycle ------------------------------------------------------
    add(spec) { const b = this.store.add(spec); return b; }
    get(id) { return this.store.get(id); }
    list() { return this.store.list(); }

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
      bot.allocationUsd = alloc;
      bot.mode = 'live';
      bot.enabled = true;
      await this._audit({ type: 'bot_armed', bot: id, mode: 'live', allocationUsd: alloc, network: bot.network });
      this.emit({ type: 'bot_armed', bot: id, mode: 'live', allocationUsd: alloc });
      await this.store.persist();
      return bot;
    }

    async enablePaper(id) {
      const bot = this.store.get(id);
      if (!bot) throw new Error('unknown bot: ' + id);
      bot.mode = 'paper'; bot.enabled = true;
      await this._audit({ type: 'bot_armed', bot: id, mode: 'paper' });
      await this.store.persist();
      return bot;
    }
    async pause(id) {
      const bot = this.store.get(id);
      if (bot) { bot.enabled = false; await this._audit({ type: 'bot_paused', bot: id }); await this.store.persist(); }
      return bot;
    }

    // ---- KILL (§5): stop ALL bots, best-effort cancel open orders, lock vault --
    async killAll(reason) {
      this._killed = true;
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
        if (bot.type === 'rebalance' || bot.type === 'momentum') report = await this._tickScheduled(bot, now, opts);
        else if (bot.type === 'signal') report = await this._tickSignal(bot, now, opts);
        else report = await this._tickDealBot(bot, bot.type, bot.config, bot.pairs(), now, opts);
      } catch (e) {
        if (e && e.halted) { this._killed = true; await this._audit({ type: 'bot_abort', bot: bot.id, reason: 'killed' }); return { bot: bot.id, killed: true }; }
        await this._audit({ type: 'bot_error', bot: bot.id, error: e.message });
        report = { bot: bot.id, error: e.message };
      }
      await this.store.persist();
      return report;
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
        const bd = B.decimalsFor(base, cfg.decimals);
        const quoteDec = B.decimalsFor(quote, cfg.decimals);
        const quoteUc = this._unitUc(prices, quote);

        let ps = bot.state.byPair[pair] || (bot.state.byPair[pair] = { deal: null, lastCloseAt: 0 });

        // (re)open a deal if needed (dca/smarttrade). grid keeps one persistent deal.
        if (type === 'grid') {
          if (!ps.deal) ps.deal = engine.newDeal(bot.id + ':' + pair, cfg, markUc, bd, now);
        } else {
          if (!ps.deal || ps.deal.status === 'closed') {
            if (!this._canStart(bot, ps, now)) { events.push({ pair, waiting: true }); continue; }
            ps.deal = type === 'smarttrade' ? engine.newDeal(bot.id + ':' + pair + ':' + (bot.state.dealCount + 1), cfg, now)
              : engine.newDeal(bot.id + ':' + pair + ':' + (bot.state.dealCount + 1), now);
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
          events.push({ pair, action: order.kind, side: order.side, qty: fill.qty.toString(), priceUc: fill.priceUc.toString(), paper: !!fill.paper });

          if (ps.deal.status === 'closed') { this._bookClose(bot, ps, now); break; }
        }
      }
      return { bot: bot.id, type, events, dashboard: this.dashboard(bot.id) };
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

    _canStart(bot, ps, now) {
      // cooldown since last close
      if (bot.cooldownSec > 0 && ps.lastCloseAt && (now - ps.lastCloseAt) < bot.cooldownSec * 1000) return false;
      const sc = bot.config && bot.config.startCondition;
      if (sc === 'signal') return !!ps.signalArmed;   // a signal must have armed this pair
      // 'asap' (and 'dip' once its trigger logic is wired) start immediately
      return true;
    }

    // Book a closed deal into the bot's dashboard stats + archive.
    _bookClose(bot, ps, now) {
      const deal = ps.deal;
      const r = deal.realizedUc || 0n;
      bot.state.realizedUc = (bot.state.realizedUc || 0n) + r;
      bot.state.dealCount = (bot.state.dealCount || 0) + 1;
      if (r > 0n) bot.state.winCount = (bot.state.winCount || 0) + 1;
      else if (r < 0n) bot.state.lossCount = (bot.state.lossCount || 0) + 1;
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
      const execPriceUc = (order._levelPriceUc != null) ? order._levelPriceUc : markUc;

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

        // --- allocation gate (LIVE buys only; BigInt-exact, non-bypassable) ---
        let remainingUc = null;
        if (bot.mode === 'live') {
          const allocUc = B.microUsd(bot.allocationUsd);
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
          await this._audit({ type: 'bot_paper_fill', bot: bot.id, side: 'buy', kind: order.kind, pair: m.base + '/' + m.quote, qty: qty.toString(), priceUc: execPriceUc.toString(), costUc: costUc.toString() });
          return { side: 'buy', qty, priceUc: execPriceUc, costUc, paper: true };
        }

        // --- LIVE: route through the ONE value-moving dispatch ---------------
        const quoteUc = m.quoteUc != null ? m.quoteUc : B.microUsd(1);
        const amount = (toolName === 'place_order')
          ? qty.toString()
          : B.qtyForUsd(usdSizeUc, quoteUc, m.quoteDec).toString(); // quote base units to spend
        const args = (toolName === 'place_order')
          ? { market: m.base + '/' + m.quote, side: 'buy', type: 'limit', amount: qty.toString(), price: B.ucToUsd(order._levelPriceUc || markUc) }
          : { from: m.quote, to: m.base, amount, venue: (bot.venuePrefs && bot.venuePrefs.venue) || 'blockle' };
        const r = await this._dispatch(bot, toolName, args, remainingUc);
        if (!r || r.rejected || !r.result) { await this._audit({ type: 'bot_order_rejected', bot: bot.id, reason: r && r.reason }); return null; }
        bot.state.committedUc = (bot.state.committedUc || 0n) + usdSizeUc + feeUc; // accrue trade + fee, ONLY on broadcast
        const outQty = r.result && r.result.amountOut != null ? BigInt(String(r.result.amountOut)) : qty;
        return { side: 'buy', qty: outQty, priceUc: execPriceUc, costUc, txid: r.txid, orderId: r.result && r.result.orderId };
      }

      // ---- SELL (take-profit / stop-loss / grid flip): proceeds, no allocation --
      const qty = order.qty;
      if (!qty || qty <= 0n) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'size', detail: 'sell qty zero' }); return null; }
      const proceedsUc = B.valueOf(qty, execPriceUc, m.bd);
      if (mainnet && !this.mainnetEnabled) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'mainnet' }); return null; }
      if (!this.policy.isAllowed(toolName)) { await this._audit({ type: 'bot_blocked', bot: bot.id, tool: toolName, reason: 'not on allowlist' }); return null; }

      if (bot.mode === 'paper') {
        await this._audit({ type: 'bot_paper_fill', bot: bot.id, side: 'sell', kind: order.kind, pair: m.base + '/' + m.quote, qty: qty.toString(), priceUc: execPriceUc.toString(), proceedsUc: proceedsUc.toString() });
        return { side: 'sell', qty, priceUc: execPriceUc, proceedsUc, paper: true };
      }
      const args = (toolName === 'place_order')
        ? { market: m.base + '/' + m.quote, side: 'sell', type: 'limit', amount: qty.toString(), price: B.ucToUsd(order._levelPriceUc || markUc) }
        : { from: m.base, to: m.quote, amount: qty.toString(), venue: (bot.venuePrefs && bot.venuePrefs.venue) || 'blockle' };
      // sells do not consume allocation; keep the auto-approve envelope at remaining
      // allocation so the sell still auto-approves within the same ONE gate.
      const remainingUc = B.microUsd(bot.allocationUsd) - (bot.state.committedUc || 0n);
      const r = await this._dispatch(bot, toolName, args, remainingUc > 0n ? remainingUc : B.microUsd(bot.allocationUsd));
      if (!r || r.rejected || !r.result) { await this._audit({ type: 'bot_order_rejected', bot: bot.id, reason: r && r.reason }); return null; }
      const outQty = r.result && r.result.amountOut != null ? qty : qty;
      return { side: 'sell', qty: outQty, priceUc: execPriceUc, proceedsUc, txid: r.txid, orderId: r.result && r.result.orderId };
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
        try { cands = (await this.discovery.scan()) || []; } catch (_) { cands = []; }
        for (const c of cands) {
          if (c.approved === true && (c.score == null || c.score >= cfg.minScore) && c.pair) signals.push({ pair: c.pair, score: c.score, source: 'discovery' });
        }
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
        await this._audit({ type: 'bot_signal', bot: bot.id, pair, source: sig.source, template: spawn.type });
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
      const B = this.Bots;
      const Strategies = this.Strategies || dep('AgentStrategies', './strategies.js');
      const strat = Strategies.createRegistry().get(bot.type);
      if (!strat) return { bot: bot.id, error: 'no strategy ' + bot.type };
      const params = strat.validateParams(Object.assign({}, bot.config));
      const intents = await strat.plan(this.ctx, params);
      const ctxMainnet = this._ctxMainnet();
      const events = [];
      for (const it of (intents || [])) {
        if (this.policy.isKilled()) break;
        if (bot.mode === 'live') {
          // FIX-EST: a LIVE scheduled order must carry a FINITE, POSITIVE USD
          // estimate or it FAILS CLOSED. null/NaN/Infinity would coerce to $0 and
          // slip past the cap; a NEGATIVE estimate would even accrue negative and
          // EXPAND the allocation ledger — both bypass the hard cap, so reject all.
          if (!Number.isFinite(it.estUsd) || it.estUsd <= 0) {
            await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'allocation-unknown', tag: it.tag });
            events.push({ tag: it.tag, skipped: 'allocation-unknown' });
            continue;
          }
          const estUsdUc = B.microUsd(it.estUsd);
          const feeUc = B.agentFeeUc(estUsdUc); // allocation bounds the trade + 0.05% fee
          const remainingUc = B.microUsd(bot.allocationUsd) - (bot.state.committedUc || 0n);
          if (estUsdUc + feeUc > remainingUc) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'allocation', tag: it.tag }); events.push({ tag: it.tag, skipped: 'allocation' }); continue; }
          if ((it.mainnet || ctxMainnet) && !this.mainnetEnabled) { await this._audit({ type: 'bot_skip', bot: bot.id, reason: 'mainnet', tag: it.tag }); events.push({ tag: it.tag, skipped: 'mainnet' }); continue; }
          if (!this.policy.isAllowed(it.tool)) { await this._audit({ type: 'bot_blocked', bot: bot.id, tool: it.tool }); events.push({ tag: it.tag, blocked: true }); continue; }
          const r = await this._dispatch(bot, it.tool, it.args, remainingUc);
          if (r && r.result) { bot.state.committedUc = (bot.state.committedUc || 0n) + estUsdUc + feeUc; events.push({ tag: it.tag, executed: true }); }
          else events.push({ tag: it.tag, rejected: r && r.reason });
        } else {
          if ((it.mainnet || ctxMainnet) && !this.mainnetEnabled) { events.push({ tag: it.tag, skipped: 'mainnet' }); continue; }
          await this._audit({ type: 'bot_paper_intent', bot: bot.id, tag: it.tag, estUsd: it.estUsd });
          events.push({ tag: it.tag, paper: true });
        }
      }
      return { bot: bot.id, type: bot.type, events };
    }

    // ===========================================================================
    // per-bot dashboard DATA (§4) — accessors only, no UI.
    // ===========================================================================
    dashboard(id, marksOverride) {
      const B = this.Bots;
      const bot = typeof id === 'object' ? id : this.store.get(id);
      if (!bot) return null;
      const openDeals = [];
      let unrealizedUc = 0n;
      let safetyUsed = 0;
      for (const pair of Object.keys(bot.state.byPair || {})) {
        const ps = bot.state.byPair[pair];
        const deal = ps && ps.deal;
        if (!deal || deal.status === 'closed') continue;
        const [base] = B.splitPair(pair);
        let markUc = null;
        if (marksOverride && marksOverride[base] != null) markUc = B.microUsd(marksOverride[base]);
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
            safetyOrdersUsed: deal.safetyOrdersUsed || 0,
            unrealizedUsd: markUc != null ? B.ucToUsd(uc) : null,
          });
        }
      }
      const dealCount = bot.state.dealCount || 0;
      const wins = bot.state.winCount || 0;
      return {
        bot: bot.id, name: bot.name, type: bot.type, mode: bot.mode, enabled: bot.enabled, network: bot.network,
        status: this._killed ? 'killed' : (bot.enabled ? 'running' : 'paused'),
        allocationUsd: bot.allocationUsd,
        committedUsd: B.ucToUsd(bot.state.committedUc || 0n),
        remainingUsd: bot.mode === 'live' ? B.ucToUsd(B.microUsd(bot.allocationUsd) - (bot.state.committedUc || 0n)) : null,
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
      for (const bot of this.store.list()) {
        realizedUc += bot.state.realizedUc || 0n;
        rows.push(this.dashboard(bot.id));
      }
      return { realizedUsd: B.ucToUsd(realizedUc), bots: rows, killed: this._killed };
    }
  }

  const AgentBotRunner = { create(deps) { return new BotRunner(deps); }, BotRunner };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentBotRunner;
  root.AgentBotRunner = AgentBotRunner;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
