// agent/index.js — wiring facade for the in-wallet AI agent. Assembles the
// provider adapter, the tool allowlist, the safety policy, the audit log, and
// the runner into one object the UI drives.
//
// The LLM credential comes from the unlocked vault only (VaultPlaintext.agent)
// and is held in memory for the session; it is wiped on lock/kill. It is sent
// only to the chosen provider's API, never to any Blockle server.
//
// Usage (extension popup):
//   const agent = Agent.start({
//     credential: vaultPlaintext.agent,     // { provider, apiKey, model? }
//     caps: { sessionUsd: 50, perAsset: { BLOCK: '5000000000' } },
//     confirm: async (summary) => showConfirmDialog(summary), // returns boolean
//     onKill: async () => { await Wallet.lock(); exchange.signOut(); },
//     ctx: wiring,                            // adapters / exchange / sdk
//     store: Store,                           // chrome.storage shim (audit persist)
//     onEvent: (ev) => renderAgentEvent(ev),
//   });
//   await agent.run('swap 10 BLOCK for USDC');
//   agent.kill();                             // the always-visible kill switch
//
// Exposed as global `Agent`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(name) {
    if (root[name]) return root[name];
    if (typeof require === 'function') {
      try { return require('./' + name.replace(/^Agent/, '').toLowerCase() + '.js'); } catch (_) {}
    }
    throw new Error('agent dependency not loaded: ' + name);
  }

  const Agent = {
    start(opts) {
      opts = opts || {};
      const cred = opts.credential || {};
      if (!cred.apiKey || !cred.provider) {
        throw new Error('AI agent is not configured — enable it and add an LLM credential first');
      }

      const AgentProviders = dep('AgentProviders');
      const AgentTools = dep('AgentTools');
      const AgentPolicy = dep('AgentPolicy');
      const AgentAudit = dep('AgentAudit');
      const AgentRunner = dep('AgentRunner');

      const audit = AgentAudit.create({ store: opts.store, sink: opts.onAudit });

      const policy = AgentPolicy.create({
        caps: opts.caps || {},
        confirm: opts.confirm,            // default-on confirmation handler
        onKill: opts.onKill,              // wipes keys + credential, locks vault
        audit,
        requireConfirm: opts.requireConfirm !== false,
        autoApproveUnderUsd: opts.autoApproveUnderUsd,
      });

      const provider = AgentProviders.create({
        provider: cred.provider,
        apiKey: cred.apiKey,
        model: cred.model || opts.model,
        baseUrl: cred.baseUrl,
        fetchImpl: opts.fetchImpl,
      });

      const tools = AgentTools.build(opts.ctx || {});

      const runner = AgentRunner.create({
        provider,
        tools,
        policy,
        audit,
        system: opts.system,
        maxTurns: opts.maxTurns,
        allowlist: opts.allowlist,        // optionally narrow the catalog
        readOnly: opts.readOnly,          // enforce read-only by capability
        onEvent: opts.onEvent,
      });

      return {
        runner,
        policy,
        audit,
        tools,
        run: (prompt, o) => runner.run(prompt, o),
        kill: (reason) => runner.kill(reason),
        setCaps: (caps) => policy.setCaps(caps),
        resetSpend: () => policy.resetSpend(),
        remaining: () => policy.remaining(),
        reset: () => runner.reset(),
      };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Agent;
  root.Agent = Agent;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
