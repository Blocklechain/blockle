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

  // OPTIONAL dependency: never throws if absent (RAG grounding simply stays off).
  function optDep(name, rel) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(rel); } catch (_) {} }
    return null;
  }

  const Agent = {
    start(opts) {
      opts = opts || {};
      const cred = opts.credential || {};
      if (!cred.provider) {
        throw new Error('AI agent is not configured — enable it and add an LLM credential first');
      }
      // KEYLESS modes: HOSTED needs a gatewayUrl + sessionToken (the wallet never
      // holds the upstream LLM key); LOCAL needs only a baseUrl (a server on the
      // user's OWN machine — nothing leaves the device). Every other (BYO-key)
      // provider still requires an apiKey from the unlocked vault.
      if (cred.provider === 'hosted') {
        if (!cred.gatewayUrl || !cred.sessionToken) {
          throw new Error('hosted agent is not configured — connect "Use Blockle hosted agent" first');
        }
      } else if (cred.provider === 'local') {
        // keyless local server — no apiKey required.
      } else if (!cred.apiKey) {
        throw new Error('AI agent is not configured — enable it and add an LLM credential first');
      }

      const AgentProviders = dep('AgentProviders');
      const AgentTools = dep('AgentTools');
      const AgentPolicy = dep('AgentPolicy');
      const AgentAudit = dep('AgentAudit');
      const AgentRunner = dep('AgentRunner');
      const AgentPnl = dep('AgentPnl');
      const AgentNotify = dep('AgentNotify');

      const audit = AgentAudit.create({ store: opts.store, sink: opts.onAudit });

      // Realized-profit engine (spec §8): the ledger persists ALONGSIDE the audit
      // (no key material), and pops a native notification on a positive gain into
      // a stablecoin. The notifier's emitter is injectable (chrome.notifications
      // with an in-page toast fallback by default); the whole thing hangs off the
      // ONE post-commit hook in runner.js, never a second commit path.
      const notifier = AgentNotify.create({ emit: opts.notifyEmit, sink: opts.onNotify });
      const pnl = AgentPnl.create({
        audit, notifier, store: opts.store,
        onEvent: opts.onEvent,
        config: opts.pnlConfig || {},
        wallet: opts.wallet, channel: opts.channel,
      });

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
        // hosted-only: keyless transport fields + transparent token refresh.
        gatewayUrl: cred.gatewayUrl,
        sessionToken: cred.sessionToken,
        refresh: cred.refresh || opts.refresh,
        fetchImpl: opts.fetchImpl,
      });

      const tools = AgentTools.build(opts.ctx || {});

      // Client-side RAG grounding (agent/rag.js) for this channel's NL turns —
      // ON by default, opt-out via `rag:false`. It only augments the system prompt
      // with read-only facts + a live snapshot; it grants NO tools and cannot touch
      // the signing gate. `liveContext()` pulls EXISTING wallet state (no network).
      const rag = opts.rag === false ? null : (opts.rag || optDep('AgentRAG', './rag.js'));

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
        pnl,                              // post-commit realized-profit hook
        channel: opts.channel,
        rag,                              // per-turn grounding (opt-in on the runner)
        liveContext: opts.liveContext,    // () -> { chain, pair, balances, bots, signals }
      });

      return {
        runner,
        policy,
        audit,
        tools,
        pnl,
        notifier,
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
