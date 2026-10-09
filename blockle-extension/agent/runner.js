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

      this.messages = [];
      this._aborted = false;

      // Enforce the allowlist from the catalog unless the host narrowed it.
      this.policy.setAllowlist(deps.allowlist || this.tools.names());
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

      // ---- value-moving path: build -> cap -> confirm -> commit ----
      this.policy.assertLive();
      const prep = await tool.prepare(call.arguments || {});
      this.emit({ type: 'prepared', name: call.name, summary: prep.summary });

      // hard cap pre-check (throws CapExceeded -> recoverable tool error)
      this.policy.assessValue(prep.value);
      if (this.audit) await this.audit.record({ type: 'cap_check', name: call.name, value: prep.value, ok: true });

      const gate = await this.policy.gateConfirm(prep.summary, { usd: prep.value && prep.value.usd });
      if (this.audit) {
        await this.audit.record({ type: 'confirmation', name: call.name, summary: prep.summary, approved: gate.approved, auto: !!gate.auto });
      }
      if (!gate.approved) {
        this.emit({ type: 'declined', name: call.name, summary: prep.summary });
        return this._toolResult(call, { rejected: true, reason: 'user declined confirmation', summary: prep.summary }, false);
      }

      this.policy.assertLive(); // a kill during confirm must still block commit
      const res = await prep.commit();
      this.policy.recordSpend(prep.value);
      const txid = res && (res.txid || (res.settlement && res.settlement.txid));
      if (this.audit) await this.audit.record({ type: 'executed', name: call.name, valueMoving: true, result: res, txid });
      this.emit({ type: 'executed', name: call.name, result: res, txid });
      return this._toolResult(call, res, false);
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

  const AgentRunner = { create(deps) { return new Runner(deps); }, Runner, DEFAULT_SYSTEM };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentRunner;
  root.AgentRunner = AgentRunner;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
