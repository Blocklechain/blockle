// agent/runner.js — the natural-language loop that turns a user instruction into
// allowlisted wallet/exchange/SDK actions, with the safety rails enforced AROUND
// every tool call (not inside the tools, and not by the model's discretion):
//
//   prompt -> provider.turn(system, history, allowlisted schemas)
//     text      -> emit to the user
//     toolCall  -> policy.checkAllowed            (allowlist)
//                  if valueMoving:
//                     tool.prepare()              (build + sign, no broadcast)
//                     policy.assessValue()        (hard cap check)
//                     policy.gateConfirm(summary) (default-on human confirm)
//                     tool.commit()               (broadcast / execute)
//                     policy.recordSpend()
//                  audit.record() around each step
//                  feed tool_result back to provider.turn
//   repeat until the model returns a final text answer, maxTurns is hit, or the
//   user hits the kill switch.
//
// The caps + confirmation gate are applied here by the runner/policy regardless
// of how a tool is written — a tool CANNOT opt out. kill() aborts the loop,
// revokes the session, and locks the vault via policy.onKill.
//
// Exposed as global `AgentRunner`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  const DEFAULT_SYSTEM =
    'You are the in-wallet assistant for a Blockle multi-chain wallet. You can ' +
    'call only the tools provided. Value-moving actions (sends, swaps, orders, ' +
    'buys, token launches, liquidity, listings) are gated by the host: each is ' +
    'subject to a per-session spending cap and requires explicit human ' +
    'confirmation that the host enforces — not you. Do not claim an action ' +
    'succeeded until the tool returns a result. Never ask the user for their ' +
    'password, seed phrase, private keys, or API credentials; you do not need ' +
    'them and must refuse if asked to reveal or transmit them.';

  function jstr(v) {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  }

  // Combine the trade value with the mandatory fee for ONE cap pre-check so the
  // trade can never commit if the trade+fee together breach a cap. The fee rides
  // the same input asset in practice, so amounts sum exactly; USD sums always.
  function withFee(value, feeValue) {
    value = value || { asset: null, amount: '0', usd: null };
    if (!feeValue) return value;
    let amount = value.amount;
    const sameAsset = feeValue.asset && value.asset && feeValue.asset === value.asset;
    if (sameAsset && value.amount != null && feeValue.amount != null) {
      try { amount = (BigInt(String(value.amount)) + BigInt(String(feeValue.amount))).toString(); } catch (_) {}
    }
    let usd = value.usd;
    if (value.usd != null || feeValue.usd != null) usd = Number(value.usd || 0) + Number(feeValue.usd || 0);
    // carry a usd-exempt flag forward so a zero-/unpriceable-transfer action is
    // not rejected by the session-USD rule (see policy.assessValue).
    const out = { asset: value.asset, amount, usd };
    if (value.usdExempt) out.usdExempt = true;
    return out;
  }
  function confirmUsd(value, feeValue) {
    const a = value && value.usd != null ? Number(value.usd) : null;
    const b = feeValue && feeValue.usd != null ? Number(feeValue.usd) : null;
    if (a == null && b == null) return undefined;
    return Number(a || 0) + Number(b || 0);
  }

  // A commit result that EXPLICITLY reports failure must throw so we never record
  // a spend for a broadcast that did not happen (audit-finding #9b). A non-throw
  // with no failure marker is treated as success, as before.
  function assertCommitOk(res) {
    if (res && typeof res === 'object') {
      if (res.accepted === false || res.ok === false || res.success === false || res.error) {
        throw new Error('commit failed: ' + (res.error ? String(res.error) : 'rejected by execution layer'));
      }
    }
    return res;
  }

  // THE one and only value-moving routine: prepare -> cap -> confirm -> commit ->
  // recordSpend (+ the mandatory 0.05% agent-fee leg). Both the NL Runner and the
  // StrategyRunner drive value through THIS function — there is no second
  // broadcast path. Returns { result } on commit, or { rejected, reason, summary }
  // when the confirmation gate denies. Throws CapExceeded / AgentHalted upward.
  async function dispatchValueMoving(opts) {
    const tool = opts.tool;
    const args = opts.args || {};
    const policy = opts.policy;
    const audit = opts.audit || null;
    const name = opts.name || (tool && tool.name) || 'value';
    const emit = typeof opts.emit === 'function' ? opts.emit : null;

    policy.assertLive();
    const prep = await tool.prepare(args);
    if (emit) emit({ type: 'prepared', name, summary: prep.summary });

    // A tool may attach a MANDATORY agent fee leg (the 0.05% venue-swap skim).
    const feeValue = prep.feeValue || null;

    // hard cap pre-check — trade + mandatory fee must BOTH fit before anything
    // moves (throws CapExceeded -> recoverable to the caller).
    policy.assessValue(withFee(prep.value, feeValue));
    if (audit) await audit.record({ type: 'cap_check', name, value: prep.value, fee: prep.fee || null, ok: true });

    const gate = await policy.gateConfirm(prep.summary, { usd: confirmUsd(prep.value, feeValue) });
    if (audit) await audit.record({ type: 'confirmation', name, summary: prep.summary, approved: gate.approved, auto: !!gate.auto });
    if (!gate.approved) {
      if (emit) emit({ type: 'declined', name, summary: prep.summary });
      return { rejected: true, reason: 'user declined confirmation', summary: prep.summary };
    }

    policy.assertLive(); // a kill during confirm must still block commit
    const res = assertCommitOk(await prep.commit());
    policy.recordSpend(prep.value);
    const txid = res && (res.txid || (res.settlement && res.settlement.txid));
    if (audit) await audit.record({ type: 'executed', name, valueMoving: true, result: res, txid });
    if (emit) emit({ type: 'executed', name, result: res, txid, summary: prep.summary, value: prep.value, fee: prep.fee || null });

    // ---- mandatory fee leg: a second treasury send in the SAME action --------
    let agentFee = null;
    if (prep.commitFee && prep.fee) {
      policy.assertLive();
      let feeRes = null, feeErr = null;
      try { feeRes = assertCommitOk(await prep.commitFee()); }
      catch (e) { feeErr = e; }
      const feeTxid = feeRes && (feeRes.txid || null);
      // Only record the fee spend when the fee ACTUALLY broadcast (a real txid).
      // A zero-amount skip or a failed send records no spend (audit-finding #9a).
      const feeSuccess = !feeErr && feeTxid != null;
      if (feeSuccess && feeValue) policy.recordSpend(feeValue);
      agentFee = {
        type: 'fee', name,
        bps: prep.fee.bps, chain: prep.fee.chain, asset: prep.fee.asset,
        amount: prep.fee.amount, treasury: prep.fee.treasury, txid: feeTxid,
      };
      if (feeErr) agentFee.error = String(feeErr.message || feeErr);
      if (audit) await audit.record(agentFee);
      if (emit) emit({ type: 'fee', name, fee: agentFee, txid: feeTxid });
    }

    // ---- THE one post-commit hook (spec §8): realized-profit ledger + pop-up.
    // Hung off the single commit path — NOT a second broadcast/execution path. It
    // only reads trade quantities + the trade's own executed USD value, updates
    // the avg-cost ledger, and (on a positive gain into a stablecoin) notifies.
    // Guarded so a ledger/notify error can never disturb a settled trade.
    if (opts.pnl && typeof opts.pnl.onCommit === 'function') {
      try { await opts.pnl.onCommit({ prep, res, name, txid, wallet: opts.wallet, channel: opts.channel }); }
      catch (_) {}
    }

    const out = (agentFee && res && typeof res === 'object') ? Object.assign({}, res, { agentFee }) : res;
    return { result: out };
  }

  class Runner {
    constructor(deps) {
      deps = deps || {};
      if (!deps.provider) throw new Error('runner requires a provider');
      if (!deps.tools) throw new Error('runner requires a tools registry');
      if (!deps.policy) throw new Error('runner requires a policy');
      this.provider = deps.provider;
      this.tools = deps.tools;
      this.policy = deps.policy;
      this.audit = deps.audit || null;
      this.system = deps.system || DEFAULT_SYSTEM;
      this.maxTurns = deps.maxTurns || 12;
      this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
      this.pnl = deps.pnl || null;          // realized-profit tracker (post-commit)
      this.channel = deps.channel || null;  // ledger key component

      this.messages = [];
      this._aborted = false;

      // Enforce the allowlist from the catalog unless the host narrowed it. For a
      // READ-ONLY channel, enforce read-only BY CAPABILITY: strip every
      // value-moving tool from the allowlist so value can never move, regardless
      // of whether the host also narrowed the list (audit-finding #1).
      let allow = deps.allowlist || this.tools.names();
      if (deps.readOnly && typeof this.tools.valueMovingNames === 'function') {
        const vm = new Set(this.tools.valueMovingNames());
        allow = allow.filter((n) => !vm.has(n));
      }
      this.policy.setAllowlist(allow);
    }

    emit(ev) { if (this.onEvent) { try { this.onEvent(ev); } catch (_) {} } }

    // Kill switch: abort the loop + revoke session + lock the vault.
    async kill(reason) {
      this._aborted = true;
      await this.policy.kill(reason || 'kill switch');
      this.emit({ type: 'killed', reason: reason || 'kill switch' });
    }

    _toolResult(call, obj, isError) {
      return { id: call.id, name: call.name, content: jstr(obj), isError: !!isError };
    }

    async _execute(call) {
      if (this.audit) await this.audit.record({ type: 'tool_call', name: call.name, args: call.arguments });
      this.emit({ type: 'tool_call', name: call.name, args: call.arguments });

      this.policy.checkAllowed(call.name); // throws ToolNotAllowed (recoverable)
      const tool = this.tools.get(call.name);
      if (!tool) throw new Error('unknown tool: ' + call.name);

      if (!tool.valueMoving) {
        const res = await tool.run(call.arguments || {});
        if (this.audit) await this.audit.record({ type: 'executed', name: call.name, valueMoving: false });
        return this._toolResult(call, res, false);
      }

      // ---- value-moving path: THE shared build -> cap -> confirm -> commit (+fee)
      // routine. The StrategyRunner drives value through the SAME function, so
      // there is exactly one commit path (no second broadcast path exists).
      const r = await dispatchValueMoving({
        tool, args: call.arguments || {}, policy: this.policy, audit: this.audit,
        name: call.name, emit: (ev) => this.emit(ev),
        pnl: this.pnl, channel: this.channel,
      });
      if (r.rejected) {
        return this._toolResult(call, { rejected: true, reason: r.reason, summary: r.summary }, false);
      }
      return this._toolResult(call, r.result, false);
    }

    // Run one user instruction to completion. Returns { text, stopped, reason }.
    async run(prompt, opts) {
      opts = opts || {};
      const signal = opts.signal || null;

      if (this.audit) await this.audit.record({ type: 'prompt', text: prompt });
      this.emit({ type: 'prompt', text: prompt });
      this.messages.push({ role: 'user', text: prompt });

      let lastText;
      try {
        for (let turn = 0; turn < this.maxTurns; turn++) {
          this.policy.assertLive();
          if (this._aborted || (signal && signal.aborted)) {
            return { text: lastText, stopped: true, reason: 'aborted' };
          }

          const resp = await this.provider.turn({
            system: this.system,
            messages: this.messages,
            tools: this.tools.schemas(),
          });

          lastText = resp.text || lastText;
          if (resp.text) {
            if (this.audit) await this.audit.record({ type: 'assistant_text', text: resp.text });
            this.emit({ type: 'text', text: resp.text });
          }

          const calls = resp.toolCalls || [];
          if (calls.length === 0) {
            this.messages.push({ role: 'assistant', text: resp.text });
            return { text: resp.text, stopped: false, reason: 'end_turn' };
          }

          this.messages.push({ role: 'assistant', text: resp.text, toolCalls: calls });

          const results = [];
          for (const call of calls) {
            this.policy.assertLive(); // halts mid-batch if the user hit kill
            try {
              results.push(await this._execute(call));
            } catch (e) {
              if (e && e.halted) throw e; // propagate kill to stop the loop
              if (this.audit) await this.audit.record({ type: 'error', name: call.name, error: e.message });
              this.emit({ type: 'tool_error', name: call.name, error: e.message });
              results.push(this._toolResult(call, { error: e.message }, true));
            }
          }
          this.messages.push({ role: 'tool', results });
        }
        return { text: lastText, stopped: true, reason: 'max_turns' };
      } catch (e) {
        if (e && e.halted) {
          if (this.audit) await this.audit.record({ type: 'halted' });
          return { text: lastText, stopped: true, reason: 'killed' };
        }
        throw e;
      }
    }

    reset() { this.messages = []; }
  }

  const AgentRunner = {
    create(deps) { return new Runner(deps); },
    Runner, DEFAULT_SYSTEM,
    // the single shared value-moving routine + its helpers (reused by StrategyRunner)
    dispatchValueMoving, withFee, confirmUsd, assertCommitOk,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentRunner;
  root.AgentRunner = AgentRunner;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
