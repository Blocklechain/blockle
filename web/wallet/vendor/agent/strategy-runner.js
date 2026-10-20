// agent/strategy-runner.js — the thin driver that turns a strategy's planned
// Intents into actual actions, WITHOUT a second broadcast path. See the shared
// spec docs/AGENT-STRATEGIES.md section 4.
//
// It reuses the ONE value-moving routine from runner.js
// (AgentRunner.dispatchValueMoving): prepare -> policy.assessValue ->
// policy.gateConfirm -> commit -> policy.recordSpend, all audited. So every
// strategy Intent is subject to the SAME caps / confirm / allowlist / kill /
// audit / 0.05% fee rails as a hand-typed instruction — a strategy cannot bypass
// the safety layer.
//
// Modes:
//   'propose' (DEFAULT) — emit Intents + audit them as strategy_proposal, dispatch
//                         NOTHING. The host confirms each later through the gate.
//   'auto'              — dispatch within the policy caps + autoApproveUnderUsd;
//                         still honors confirm above the auto threshold, still
//                         honors caps, still honors kill between Intents.
//
// Other guards enforced per Intent, in BOTH modes:
//   - allowlist: an Intent for a non-allowlisted tool is dropped (audited
//     'blocked'). Paired legs (same `group`, e.g. arbitrage) are all-or-nothing:
//     if ANY leg's tool is not allowlisted, the WHOLE group is dropped.
//   - mainnet gate: an Intent that routes through a mainnet venue is refused
//     unless mainnetEnabled === true (default false).
//   - kill: checked before each Intent; a kill mid-tick aborts the rest. A kill
//     during a confirm still blocks that commit (policy already enforces this).
//
// Exposed as global `AgentStrategyRunner`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(name, file) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    throw new Error('strategy-runner dependency not loaded: ' + name);
  }

  class StrategyRunner {
    constructor(deps) {
      deps = deps || {};
      if (!deps.tools) throw new Error('StrategyRunner requires a tools registry');
      if (!deps.policy) throw new Error('StrategyRunner requires a policy');
      this.tools = deps.tools;
      this.policy = deps.policy;
      this.audit = deps.audit || null;
      this.ctx = deps.ctx || {};
      this.mainnetEnabled = deps.mainnetEnabled === true; // default false
      this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
      this.registry = deps.registry || dep('AgentStrategies', './strategies.js').createRegistry();
      this.pnl = deps.pnl || null;              // realized-profit tracker (post-commit)
      this.channel = deps.channel || null;      // ledger key component
      // Optional READ-ONLY candidate feed (§7). Discovery NEVER trades, signs, or
      // auto-allowlists; it only returns ranked, approved:false suggestions. The
      // dispatch gate below is unchanged, so an unapproved token still produces a
      // `blocked` audit note (never a trade).
      this.discovery = deps.discovery || null;
      this.useDiscovery = deps.useDiscovery === true;
      this.autoConsiderUnapproved = deps.autoConsiderUnapproved === true; // default off
      // the ONE shared value-moving routine (no second broadcast path)
      this.dispatchValueMoving = (deps.AgentRunner || dep('AgentRunner', './runner.js')).dispatchValueMoving;
    }

    emit(ev) { if (this.onEvent) { try { this.onEvent(ev); } catch (_) {} } }
    async _audit(rec) { if (this.audit) { try { return await this.audit.record(rec); } catch (_) {} } }

    list() { return this.registry.names(); }
    describe(name) { const s = this.registry.get(name); return s ? s.describe() : null; }

    // READ-ONLY candidate feed passthrough (§7). Returns ranked Candidates from
    // discovery.scan(), filtered to approved===true by DEFAULT. Only when
    // autoConsiderUnapproved is explicitly enabled are unapproved candidates
    // included — and even then any resulting trade STILL passes the dispatch gate
    // (an unapproved, non-allowlisted token produces a `blocked` note, never a
    // trade). This method never trades, signs, or mutates the allowlist.
    async candidates(opts) {
      opts = opts || {};
      if (!this.discovery || typeof this.discovery.scan !== 'function') return [];
      const all = await this.discovery.scan();
      const includeUnapproved = opts.includeUnapproved != null ? !!opts.includeUnapproved : this.autoConsiderUnapproved;
      return includeUnapproved ? all : all.filter((c) => c.approved === true);
    }

    // Run ONE tick of a strategy. Returns an array of per-Intent outcomes.
    async tick(strategyName, params, opts) {
      opts = opts || {};
      const mode = opts.mode === 'auto' ? 'auto' : 'propose';
      this.policy.assertLive(); // a kill before the tick aborts immediately

      const strat = this.registry.get(strategyName);
      if (!strat) throw new Error('unknown strategy: ' + strategyName);
      const p = strat.validateParams(params || {});

      const intents = await strat.plan(this.ctx, p);
      const skipped = intents && intents.skipped;

      // FIX-3: CHAIN-LEVEL mainnet backstop. The mainnet gate must not depend only
      // on venue descriptors or the per-Intent flag a planner set — a mainnet venue
      // missing its marker, or a venue-less auto-routed swap (dca/grid/rebalance/
      // momentum) that resolves to mainnet at commit, must still be caught here. If
      // ctx.network() reports mainnet, EVERY Intent this tick is treated as mainnet.
      const ctxMainnet = (() => {
        try { return !!(this.ctx && typeof this.ctx.network === 'function' && this.ctx.network() === 'mainnet'); }
        catch (_) { return false; }
      })();
      await this._audit({ type: 'strategy_plan', strategy: strategyName, count: intents.length, mode, mainnetEnabled: this.mainnetEnabled, skipped: skipped || undefined });
      this.emit({ type: 'strategy_plan', strategy: strategyName, count: intents.length, mode, skipped: skipped || null });

      // Pre-compute which paired groups must be dropped wholesale because at least
      // one leg's tool is not allowlisted (arbitrage: both legs or neither).
      const dropGroup = new Set();
      const groups = {};
      for (const it of intents) { if (it.group) (groups[it.group] = groups[it.group] || []).push(it); }
      for (const [g, legs] of Object.entries(groups)) {
        if (legs.some((it) => !this.policy.isAllowed(it.tool))) dropGroup.add(g);
      }

      const results = [];
      for (const it of intents) {
        // kill between Intents aborts the whole remaining tick
        if (this.policy.isKilled()) {
          await this._audit({ type: 'strategy_abort', strategy: strategyName, reason: 'killed' });
          this.emit({ type: 'strategy_abort', strategy: strategyName, reason: 'killed' });
          break;
        }

        // allowlist (individual + paired-group)
        if (!this.policy.isAllowed(it.tool) || (it.group && dropGroup.has(it.group))) {
          const reason = (it.group && dropGroup.has(it.group) && this.policy.isAllowed(it.tool))
            ? 'paired leg not allowlisted (group dropped)'
            : 'tool not on allowlist: ' + it.tool;
          await this._audit({ type: 'blocked', strategy: strategyName, tool: it.tool, tag: it.tag, reason });
          this.emit({ type: 'blocked', tool: it.tool, tag: it.tag, reason });
          results.push({ blocked: it, reason });
          continue;
        }

        // mainnet gate (per-Intent flag OR the chain-level backstop)
        if ((it.mainnet || ctxMainnet) && !this.mainnetEnabled) {
          const reason = 'mainnet disabled (set mainnetEnabled=true to route through a mainnet venue)';
          await this._audit({ type: 'blocked', strategy: strategyName, tool: it.tool, tag: it.tag, reason });
          this.emit({ type: 'blocked', tool: it.tool, tag: it.tag, reason });
          results.push({ blocked: it, reason });
          continue;
        }

        // ---- propose: emit + audit, dispatch NOTHING -------------------------
        if (mode === 'propose') {
          await this._audit({ type: 'strategy_proposal', strategy: strategyName, intent: redactIntent(it) });
          this.emit({ type: 'strategy_proposal', intent: it });
          results.push({ proposed: it });
          continue;
        }

        // ---- auto: dispatch through the SHARED value-moving routine ----------
        const tool = this.tools.get(it.tool);
        if (!tool) {
          const reason = 'unknown tool: ' + it.tool;
          await this._audit({ type: 'blocked', strategy: strategyName, tool: it.tool, tag: it.tag, reason });
          results.push({ blocked: it, reason });
          continue;
        }
        if (!tool.valueMoving) {
          // FIX-6: NEVER call tool.run() for a strategy Intent in auto mode. A
          // non-value-moving (or mis-flagged) tool is nonsensical for a value-
          // moving strategy; DROP it with an audited 'blocked' note. The shared
          // value-moving dispatch below stays the only commit path.
          const reason = 'tool is not value-moving (dropped): ' + it.tool;
          await this._audit({ type: 'blocked', strategy: strategyName, tool: it.tool, tag: it.tag, reason });
          this.emit({ type: 'blocked', tool: it.tool, tag: it.tag, reason });
          results.push({ blocked: it, reason });
          continue;
        }

        try {
          await this._audit({ type: 'strategy_dispatch', strategy: strategyName, tool: it.tool, tag: it.tag });
          const r = await this.dispatchValueMoving({
            tool, args: it.args, policy: this.policy, audit: this.audit,
            name: it.tool, emit: (ev) => this.emit(ev),
            pnl: this.pnl, channel: this.channel,
          });
          if (r.rejected) results.push({ rejected: it, reason: r.reason });
          else results.push({ executed: it, result: r.result });
        } catch (e) {
          if (e && e.halted) {
            await this._audit({ type: 'strategy_abort', strategy: strategyName, reason: 'killed' });
            this.emit({ type: 'strategy_abort', strategy: strategyName, reason: 'killed' });
            break; // kill mid-tick: stop dispatching the rest
          }
          // caps / build errors are recoverable: record and move on
          await this._audit({ type: 'error', strategy: strategyName, tool: it.tool, tag: it.tag, error: e.message });
          this.emit({ type: 'strategy_error', tool: it.tool, tag: it.tag, error: e.message });
          results.push({ error: it, message: e.message });
        }
      }
      return results;
    }
  }

  // The audit holds the plan/why; keep the (already non-secret) Intent but drop
  // the bulky rationale duplication into a compact form.
  function redactIntent(it) {
    return { tool: it.tool, args: it.args, estUsd: it.estUsd, strategy: it.strategy, tag: it.tag, group: it.group, mainnet: it.mainnet };
  }

  const AgentStrategyRunner = { create(deps) { return new StrategyRunner(deps); }, StrategyRunner };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentStrategyRunner;
  root.AgentStrategyRunner = AgentStrategyRunner;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
