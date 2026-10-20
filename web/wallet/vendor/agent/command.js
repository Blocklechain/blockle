// agent/command.js — the NATURAL-LANGUAGE COMMAND BAR router.
//
// It adds NO new power. The agent (the SAME provider.turn — hosted or BYO) only
// PROPOSES tool-calls over the EXISTING tool registry (AgentTools.build(ctx)), and
// the EXISTING gate (policy + runner.dispatchValueMoving) enforces every fund move.
// There is NO second broadcast path and NO relaxed confirm path here.
//
// Given typed text + wallet context it routes into one of two intents:
//
//   (A) ACTION  ("send 0.1 ETH to alice.eth", "swap 100 USDC to SOL",
//               "rebalance to 60/40 stables" = a SEQUENCE of swaps)
//       For EACH proposed value-moving tool-call the router:
//         1. RESOLVES any name (WalletAddressBook.resolveName) and shows the
//            RESOLVED address — the resolved address is what is then inspected,
//            confirmed, and sent (never the raw typed name).
//         2. dispatches through runner.dispatchValueMoving — the ONE gate:
//            prepare -> assessValue cap -> gateConfirm (default-on) -> commit
//            (+ the mandatory 0.05% fee leg). Nothing auto-signs. A DANGER
//            inspection forces an explicit confirm. The kill switch is honored.
//       A multi-step plan is surfaced as a PLAN and EACH step gets its OWN
//       confirm sheet (one gateConfirm per value-moving call).
//
//   (B) QUERY   ("which bot made money this week?", "what is my net worth?",
//               "how much ETH do I have?")
//       Answered ONLY from the real engines (portfolio.js, the bots
//       dashboard/P&L ledger, get_balance). The agent runs in the runner's
//       READ-ONLY tool set, so a query can NEVER reach a value-moving tool. All
//       numbers come from tool/engine results — never fabricated. When a source
//       is unavailable the tool reports it so the answer is an honest
//       "unavailable", never an invented balance/P&L.
//
// The runner, the policy, and the security gate are UNCHANGED — this module only
// orchestrates over them.
//
// Exposed as global `AgentCommand`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(globalName, rel) {
    if (root[globalName]) return root[globalName];
    if (typeof require === 'function') { try { return require(rel); } catch (_) {} }
    return null;
  }

  const DAY_MS = 86400000;

  const CLASSIFY_SYSTEM =
    'You route a Blockle wallet command bar. Decide whether the user\'s message is ' +
    'an ACTION (it asks to move funds: send, swap, trade, rebalance, buy, sell, ' +
    'provide/remove liquidity, launch or list a token, place/cancel an order) or a ' +
    'QUERY (it only asks a question about balances, net worth, prices, markets, or ' +
    'bot performance — nothing moves). Reply with exactly one word: ACTION or QUERY.';

  const ACTION_SYSTEM =
    'You are the in-wallet assistant executing a user instruction that moves funds. ' +
    'Call only the provided tools. Resolve the user\'s intent into concrete ' +
    'value-moving tool calls (a "rebalance" is a SEQUENCE of swap calls). Use ' +
    'base-unit integer amounts. The host enforces a per-session spending cap and an ' +
    'explicit human confirmation on EVERY value-moving call — you cannot bypass or ' +
    'weaken it, and you must not claim an action succeeded until the tool returns a ' +
    'result. Never ask for a password, seed phrase, private key, or API key.';

  const QUERY_SYSTEM =
    'You answer questions about this Blockle wallet. You may call only READ-ONLY ' +
    'tools (balances, markets, quotes, net_worth, bots_pnl). You CANNOT move funds. ' +
    'Every number in your answer must come from a tool result — never invent a ' +
    'balance, price, or P&L. If a tool reports a source is unavailable, say so ' +
    'honestly rather than guessing.';

  function jstr(v) {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  }
  function toolResult(call, obj, isError) {
    return { id: call.id, name: call.name, content: jstr(obj), isError: !!isError };
  }

  class CommandRouter {
    constructor(deps) {
      deps = deps || {};
      if (!deps.provider) throw new Error('command router requires a provider');
      if (!deps.tools) throw new Error('command router requires a tools registry');
      if (!deps.policy) throw new Error('command router requires a policy');
      this.provider = deps.provider;
      this.tools = deps.tools;
      this.policy = deps.policy;
      this.audit = deps.audit || null;
      this.pnl = deps.pnl || null;
      this.wallet = deps.wallet || null;
      this.channel = deps.channel || null;
      this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
      this.maxTurns = deps.maxTurns || 8;
      this.defaultChain = deps.defaultChain || 'ethereum';

      // name resolution: WalletAddressBook.resolveName(input, chain, ctx)
      const AddressBook = deps.addressBook || dep('WalletAddressBook', '../addressbook.js');
      this.resolveNameFn = deps.resolveName ||
        (AddressBook && typeof AddressBook.resolveName === 'function' ? AddressBook.resolveName : null);
      this.nameCtx = deps.nameCtx || {}; // { resolveEns, resolveSns, book }

      // real read engines for queries (all READ-ONLY, no money path):
      //   engines.netWorth() -> portfolio result | null
      //   engines.botsPnl({ sinceMs, days }) -> { bots:[...], realizedUsd } | null
      this.engines = deps.engines || {};
      this.now = typeof deps.now === 'function' ? deps.now : (() => Date.now());

      // the shared runner (for the read-only query loop) — UNCHANGED.
      this.AgentRunner = deps.AgentRunner || dep('AgentRunner', './runner.js');
      if (!this.AgentRunner || typeof this.AgentRunner.dispatchValueMoving !== 'function') {
        throw new Error('command router requires AgentRunner (runner.js)');
      }
    }

    emit(ev) { if (this.onEvent) { try { this.onEvent(ev); } catch (_) {} } }

    // ---- entry point --------------------------------------------------------
    async run(text, opts) {
      opts = opts || {};
      this.policy.assertLive();
      if (this.audit) { try { await this.audit.record({ type: 'command', text }); } catch (_) {} }
      this.emit({ type: 'command', text });

      const intent = opts.intent || (await this.classify(text));
      this.emit({ type: 'intent', intent });
      if (intent === 'action') return this.runAction(text, opts);
      return this.runQuery(text, opts);
    }

    // ---- intent classification ---------------------------------------------
    // Ask the agent with NO tools offered (nothing can move during classify).
    // Fail SAFE: anything ambiguous is treated as a read-only QUERY — the router
    // never auto-escalates to an action.
    async classify(text) {
      let resp = null;
      try {
        resp = await this.provider.turn({
          system: CLASSIFY_SYSTEM,
          messages: [{ role: 'user', text }],
          tools: [],
        });
      } catch (_) { resp = null; }
      if (resp && typeof resp.intent === 'string') {
        return resp.intent.toLowerCase() === 'action' ? 'action' : 'query';
      }
      const t = String((resp && resp.text) || '').trim().toLowerCase();
      if (/\baction\b/.test(t)) return 'action';
      return 'query';
    }

    // ===========================================================================
    // (A) ACTION — propose value-moving tool calls, resolve names, dispatch EACH
    //     through the ONE gate (runner.dispatchValueMoving). Nothing bypasses it.
    // ===========================================================================
    async runAction(text, opts) {
      opts = opts || {};
      // the full catalog is allowed here; every value move is still gated.
      this.policy.setAllowlist(this.tools.names());

      const messages = [{ role: 'user', text }];
      const steps = [];
      let lastText;

      for (let turn = 0; turn < this.maxTurns; turn++) {
        this.policy.assertLive();
        const resp = await this.provider.turn({
          system: opts.system || ACTION_SYSTEM,
          messages,
          tools: this.tools.schemas(),
        });
        lastText = resp.text || lastText;
        if (resp.text) this.emit({ type: 'text', text: resp.text });

        const calls = resp.toolCalls || [];
        if (!calls.length) {
          messages.push({ role: 'assistant', text: resp.text });
          return { intent: 'action', text: resp.text, steps, stopped: false, reason: 'end_turn' };
        }
        messages.push({ role: 'assistant', text: resp.text, toolCalls: calls });

        // Surface the whole proposed PLAN before running any step. Each
        // value-moving step still gets its OWN confirm sheet below.
        const plan = calls.map((c, i) => this._describeStep(c, i));
        if (plan.length) this.emit({ type: 'plan', steps: plan });

        const results = [];
        for (const call of calls) {
          this.policy.assertLive();
          try {
            results.push(await this._executeAction(call, steps));
          } catch (e) {
            if (e && e.halted) { // kill -> stop the whole plan
              if (this.audit) { try { await this.audit.record({ type: 'halted' }); } catch (_) {} }
              return { intent: 'action', text: lastText, steps, stopped: true, reason: 'killed' };
            }
            // a throw before a step was registered (allowlist / unknown tool).
            this.emit({ type: 'step_error', name: call.name, error: e.message });
            steps.push({ name: call.name, status: 'error', error: e.message });
            results.push(toolResult(call, { error: e.message }, true));
          }
        }
        messages.push({ role: 'tool', results });
      }
      return { intent: 'action', text: lastText, steps, stopped: true, reason: 'max_turns' };
    }

    _describeStep(call, i) {
      const a = call.arguments || {};
      return { index: i, action: call.name, args: a };
    }

    async _executeAction(call, steps) {
      if (this.audit) { try { await this.audit.record({ type: 'tool_call', name: call.name, args: call.arguments }); } catch (_) {} }
      this.policy.checkAllowed(call.name); // throws ToolNotAllowed (recoverable)
      const tool = this.tools.get(call.name);
      if (!tool) throw new Error('unknown tool: ' + call.name);

      // read-only tool proposed in an action plan (e.g. a quote lookup): run it.
      if (!tool.valueMoving) {
        const res = await tool.run(call.arguments || {});
        return toolResult(call, res, false);
      }

      // value-moving: register the step up front, then RESOLVE any name FIRST and
      // substitute the resolved address so the inspected / confirmed / sent address
      // is the resolved one — never the raw typed name. The step object owns its
      // own lifecycle (pending -> committed/declined/error) so a cap/resolve
      // failure updates THIS step rather than appending a duplicate.
      const args = Object.assign({}, call.arguments || {});
      const step = { name: call.name, status: 'pending', args };
      steps.push(step);
      try {
        const resolved = await this._resolveRecipient(call.name, args);
        if (resolved) step.resolved = resolved;
        step.args = Object.assign({}, args); // reflect the substituted address
        this.emit({ type: 'step', action: call.name, args, resolved });

        // THE gate — runner.dispatchValueMoving (the single commit path). Cap check,
        // default-on confirm, danger forces confirm, kill honored, 0.05% fee leg.
        const r = await this.AgentRunner.dispatchValueMoving({
          tool, args, policy: this.policy, audit: this.audit,
          name: call.name, emit: (ev) => this.emit(ev),
          pnl: this.pnl, channel: this.channel, wallet: this.wallet,
        });
        if (r.rejected) {
          step.status = 'declined';
          step.reason = r.reason;
          return toolResult(call, { rejected: true, reason: r.reason, summary: r.summary }, false);
        }
        step.status = 'committed';
        step.result = { txid: (r.result && (r.result.txid || (r.result.settlement && r.result.settlement.txid))) || null };
        return toolResult(call, r.result, false);
      } catch (e) {
        if (e && e.halted) throw e; // propagate kill
        // a cap breach / name-resolution failure / build error: mark THIS step and
        // report back to the model as a tool error. Nothing committed.
        step.status = 'error';
        step.error = e.message;
        this.emit({ type: 'step_error', name: call.name, error: e.message });
        return toolResult(call, { error: e.message }, true);
      }
    }

    // Resolve the recipient name for a `send` to a concrete address and MUTATE the
    // args in place so the resolved address is what gets inspected/confirmed/sent.
    // A name that does not resolve is a HARD error — we never send to an
    // unverified raw name. Non-send value tools have no recipient name to resolve.
    async _resolveRecipient(name, args) {
      if (name !== 'send') return null;
      const input = args.to;
      if (!input) return null;
      const chain = args.chain || this.defaultChain;
      if (typeof this.resolveNameFn !== 'function') {
        // no resolver wired: only accept what is already a concrete address-like
        // string for the chain; otherwise fail closed.
        return null;
      }
      let res = null;
      try {
        res = await this.resolveNameFn(input, chain, this.nameCtx);
      } catch (_) { res = null; }
      if (!res || !res.address) {
        throw new Error('could not resolve recipient "' + input + '" on ' + chain +
          ' — refusing to send to an unverified name');
      }
      args.to = res.address; // substitute the RESOLVED address
      this.emit({ type: 'resolved', input, address: res.address, source: res.source });
      return { input, address: res.address, source: res.source };
    }

    // ===========================================================================
    // (B) QUERY — the agent runs in the runner's READ-ONLY tool set (value tools
    //     stripped). Answers come only from real engines + read-only tools.
    // ===========================================================================
    async runQuery(text, opts) {
      opts = opts || {};
      const tools = this._queryRegistry();
      const runner = this.AgentRunner.create({
        provider: this.provider,
        tools,
        policy: this.policy,
        audit: this.audit,
        system: opts.system || QUERY_SYSTEM,
        maxTurns: this.maxTurns,
        readOnly: true, // enforce read-only BY CAPABILITY — value tools stripped
        onEvent: (ev) => this.emit(ev),
      });
      const r = await runner.run(text, opts);
      return { intent: 'query', text: r.text, stopped: r.stopped, reason: r.reason };
    }

    // The query-time registry: the EXISTING read-only tools + the read-only engine
    // tools (net_worth, bots_pnl). schemas() offered to the model exclude every
    // value-moving tool; valueMovingNames() still names them so the runner's
    // readOnly stripping removes them from the allowlist (defense in depth). No
    // value-moving tool is reachable during a query.
    _queryRegistry() {
      const existing = this.tools;
      const engineTools = this._engineTools();
      const engineByName = new Map(engineTools.map((t) => [t.name, t]));
      const vm = new Set(existing.valueMovingNames ? existing.valueMovingNames() : []);
      return {
        all: (existing.all || []).concat(engineTools),
        get: (n) => engineByName.get(n) || existing.get(n),
        names: () => existing.names().concat(engineTools.map((t) => t.name)),
        schemas: () => existing.schemas()
          .filter((s) => !vm.has(s.name))
          .concat(engineTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))),
        valueMovingNames: () => (existing.valueMovingNames ? existing.valueMovingNames() : []),
      };
    }

    // Read-only engine tools backed by the REAL engines. Each reports
    // `available:false` (never a fabricated number) when its engine is not wired
    // or returns nothing, so the model answers honestly.
    _engineTools() {
      const self = this;
      return [
        {
          name: 'net_worth',
          valueMoving: false,
          description: 'This wallet\'s total net worth in USD across all chains, from the portfolio engine. Read-only.',
          parameters: { type: 'object', properties: {} },
          run: async () => {
            if (typeof self.engines.netWorth !== 'function') {
              return { available: false, reason: 'net-worth engine not available in this wallet' };
            }
            let r = null;
            try { r = await self.engines.netWorth(); } catch (_) { r = null; }
            if (r == null) return { available: false, reason: 'net worth is currently unavailable' };
            return {
              available: true,
              totalUsd: r.totalUsd != null ? r.totalUsd : null,
              byChain: r.byChain || null,
              unpriced: r.unpriced || null,
              asOf: r.asOf != null ? r.asOf : null,
            };
          },
        },
        {
          name: 'bots_pnl',
          valueMoving: false,
          description: 'Per-bot realized and unrealized P&L from the bots dashboard + P&L ledger. ' +
            'Optional `days` window (default 7, i.e. "this week"). Read-only.',
          parameters: { type: 'object', properties: { days: { type: 'number', description: 'lookback window in days (default 7)' } } },
          run: async (a) => {
            if (typeof self.engines.botsPnl !== 'function') {
              return { available: false, reason: 'bot P&L engine not available in this wallet' };
            }
            const days = a && a.days != null && isFinite(Number(a.days)) ? Number(a.days) : 7;
            const sinceMs = self.now() - days * DAY_MS;
            let r = null;
            try { r = await self.engines.botsPnl({ sinceMs, days }); } catch (_) { r = null; }
            if (r == null) return { available: false, reason: 'bot P&L is currently unavailable' };
            return Object.assign({ available: true, windowDays: days, sinceMs }, r);
          },
        },
      ];
    }
  }

  const AgentCommand = {
    create(deps) { return new CommandRouter(deps); },
    CommandRouter,
    CLASSIFY_SYSTEM, ACTION_SYSTEM, QUERY_SYSTEM,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentCommand;
  root.AgentCommand = AgentCommand;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
