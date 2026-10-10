// agent/channels.js — the multi-CHANNEL manager. A "channel" is one independent
// agent instance bound to a SPECIFIC wallet/account, with its OWN provider
// connection, venue/strategy config, spend/risk caps, kill switch, audit log,
// and P&L. A user can run several at once (e.g. a conservative BTC channel and
// an aggressive BLOCK channel) and each is fully isolated from the others: a cap
// hit or a kill on one never touches another.
//
// Each channel wraps an agent/runner instance (via agent/index.js `Agent.start`).
// The safety rails from agent/policy.js still apply per channel, unchanged — this
// layer adds isolation + persistence + lifecycle, it does NOT weaken them.
//
// PERSISTENT CONNECTION: for every channel we persist a small record
//   { id, label, walletId, accountId, provider, model, baseUrl, credRef,
//     enabled, config, caps, pnl, createdAt }
// in the Store (chrome.storage) so channels survive a popup close and AUTO-RESUME
// on the next unlock. They stay connected until the user explicitly stops
// (disconnects) or deletes them.
//
// CREDENTIAL HANDLING (hard rule): the LLM API key is NEVER persisted here. The
// record holds only a `credRef` — an opaque pointer the host resolves against the
// unlocked vault (`resolveCredential(credRef) -> { provider, apiKey, model?,
// baseUrl? }`). The key lives in memory only while the channel is running and is
// dropped on stop/kill/lock. Keys are never logged or sent to a Blockle server.
//
// Exposed as global `AgentChannels`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  const STORE_KEY = 'agentChannels';

  // Sane default caps the host can apply when creating a channel (RED-3): a
  // value-moving channel must have caps before it can start. These are a floor
  // the user is expected to review, not a blank cheque.
  const DEFAULT_CAPS = { sessionUsd: 100, perAsset: {} };

  // "How do I get credentials" guidance shown in the UI for each provider, so a
  // user can connect a channel without leaving the wallet to hunt for docs.
  // `provider` maps the human label to the internal AgentProviders key.
  const PROVIDER_GUIDES = {
    claude: {
      label: 'Claude (Anthropic)',
      provider: 'claude',
      needs: ['apiKey'],
      defaultModel: 'claude-sonnet-4-5',
      url: 'https://console.anthropic.com/settings/keys',
      how: 'Sign in to the Anthropic Console, open Settings → API Keys, create a key (starts with sk-ant-), and paste it here. The key is stored encrypted in your vault and sent only to api.anthropic.com.',
    },
    chatgpt: {
      label: 'ChatGPT (OpenAI)',
      provider: 'openai',
      needs: ['apiKey'],
      defaultModel: 'gpt-4.1',
      url: 'https://platform.openai.com/api-keys',
      how: 'Sign in to the OpenAI platform, open API keys, create a secret key (starts with sk-), and paste it here. The key is stored encrypted in your vault and sent only to api.openai.com.',
    },
    copilot: {
      label: 'GitHub Copilot',
      provider: 'copilot',
      needs: ['apiKey'],
      defaultModel: 'gpt-4.1',
      url: 'https://github.com/settings/tokens',
      how: 'Authorize via GitHub device/OAuth sign-in, or paste a GitHub token that has Copilot access. The token is stored encrypted in your vault and sent only to the Copilot endpoint.',
    },
    other: {
      label: 'Other (OpenAI-compatible)',
      provider: 'openai',
      needs: ['baseUrl', 'model', 'apiKey'],
      defaultModel: '',
      url: '',
      how: 'Point at any OpenAI-compatible endpoint: enter the base URL (e.g. https://host/v1 — your wallet appends /chat/completions), the exact model name, and the API key. Everything is stored encrypted in your vault and sent only to the base URL you provide.',
    },
  };

  function dep(name, fallbackFile) {
    if (root[name]) return root[name];
    if (typeof require === 'function') {
      try { return require(fallbackFile); } catch (_) {}
    }
    throw new Error('channels dependency not loaded: ' + name);
  }

  // A value-moving channel MUST have a session USD cap (a catch-all that covers
  // EVERY asset). A per-asset cap alone would leave every OTHER asset uncapped
  // (audit-finding #2), so it is no longer sufficient on its own to arm a channel.
  function hasCaps(caps) {
    if (!caps) return false;
    return caps.sessionUsd != null;
  }

  function rid() {
    return 'ch' + Math.random().toString(36).slice(2, 10);
  }

  // A thin Store wrapper that prefixes every key with `ch:<id>:`. Passed to the
  // per-channel Agent so its audit log persists under its OWN key — channels do
  // not clobber each other's audit trail in storage.
  function namespacedStore(store, id) {
    if (!store) return null;
    const pfx = 'ch:' + id + ':';
    const wrap = (k) => pfx + k;
    const unwrap = (k) => (k.startsWith(pfx) ? k.slice(pfx.length) : k);
    return {
      async get(keys) {
        if (keys == null) {
          const all = await store.get(null);
          const out = {};
          for (const [k, v] of Object.entries(all || {})) {
            if (k.startsWith(pfx)) out[unwrap(k)] = v;
          }
          return out;
        }
        const list = Array.isArray(keys) ? keys : [keys];
        const got = await store.get(list.map(wrap));
        const out = {};
        for (const k of list) if (wrap(k) in (got || {})) out[k] = got[wrap(k)];
        return out;
      },
      async set(obj) {
        const next = {};
        for (const [k, v] of Object.entries(obj)) next[wrap(k)] = v;
        return store.set(next);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return store.remove(list.map(wrap));
      },
    };
  }

  // One running (or stopped) channel. Holds its persisted meta + the live Agent
  // instance when running. All value/safety enforcement lives inside the Agent's
  // own policy — this class owns lifecycle, isolation, and P&L bookkeeping.
  class Channel {
    constructor(manager, meta) {
      this.manager = manager;
      this.meta = meta;            // persisted record (NO apiKey)
      this.instance = null;        // Agent.start() result when running
      this.killed = false;
      this.pnl = Object.assign({ realizedUsd: 0, tradeCount: 0, trades: [] }, meta.pnl || {});
      this.pnl.trades = this.pnl.trades || [];
    }

    get id() { return this.meta.id; }
    get running() { return !!this.instance; }

    // Public, secret-free view for the UI / list().
    describe() {
      const m = this.meta;
      const live = this.instance;
      return {
        id: m.id,
        label: m.label,
        walletId: m.walletId,
        accountId: m.accountId,
        provider: m.provider,
        model: m.model,
        baseUrl: m.baseUrl || null,
        credRef: m.credRef || null,
        enabled: !!m.enabled,
        running: this.running,
        killed: this.killed,
        readOnly: !!m.readOnly,
        config: m.config || {},
        caps: m.caps || {},
        pnl: { realizedUsd: this.pnl.realizedUsd, tradeCount: this.pnl.tradeCount },
        remaining: live && live.remaining ? live.remaining() : null,
        createdAt: m.createdAt,
      };
    }

    // Record realized P&L for this channel (host-computed, in a USD reference).
    recordPnl(entry) {
      entry = entry || {};
      if (entry.realizedUsd != null) this.pnl.realizedUsd += Number(entry.realizedUsd);
      this.pnl.trades.push(Object.assign({ ts: Date.now() }, entry));
      this.meta.pnl = { realizedUsd: this.pnl.realizedUsd, tradeCount: this.pnl.tradeCount };
      return this.manager._persist();
    }

    async run(prompt, opts) {
      if (!this.instance) throw new Error('channel not started: ' + this.id);
      return this.instance.run(prompt, opts);
    }

    setCaps(caps) {
      this.meta.caps = Object.assign({}, this.meta.caps, caps || {});
      if (this.instance && this.instance.setCaps) this.instance.setCaps(this.meta.caps);
      return this.manager._persist();
    }

    remaining() {
      return this.instance && this.instance.remaining ? this.instance.remaining() : null;
    }

    audit() {
      return this.instance ? this.instance.audit : null;
    }

    // Kill THIS channel only: abort its loop, revoke its session, wipe its live
    // credential. Other channels are untouched. Marks it disabled so it does not
    // auto-resume until the user explicitly reconnects.
    async kill(reason) {
      this.killed = true;
      this.meta.enabled = false;
      if (this.instance) {
        try { await this.instance.kill(reason || 'channel kill'); } catch (_) {}
      }
      this.instance = null; // drop the only ref that holds the decrypted key
      await this.manager._persist();
    }
  }

  class ChannelManager {
    constructor(opts) {
      opts = opts || {};
      this.store = opts.store || root.Store || null;
      this.agentFactory = opts.agentFactory || dep('Agent', './index.js');
      // resolveCredential(credRef) -> { provider, apiKey, model?, baseUrl? } | null
      this.resolveCredential = typeof opts.resolveCredential === 'function' ? opts.resolveCredential : null;
      this.confirm = typeof opts.confirm === 'function' ? opts.confirm : null;      // required for value-moving
      this.onKill = typeof opts.onKill === 'function' ? opts.onKill : null;         // global kill hook
      this.onChannelKill = typeof opts.onChannelKill === 'function' ? opts.onChannelKill : null;
      this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;      // (id, ev) => ...
      this.ctxFor = typeof opts.ctxFor === 'function' ? opts.ctxFor : null;         // (channelMeta) -> adapters/ctx
      this.defaults = opts.defaults || {};
      this.fetchImpl = opts.fetchImpl;
      this.channels = new Map(); // id -> Channel
    }

    // Load persisted records into memory (does NOT start them — call resume()).
    async load() {
      let recs = [];
      if (this.store) {
        try { recs = (await this.store.get(STORE_KEY))[STORE_KEY] || []; } catch (_) { recs = []; }
      }
      this.channels.clear();
      for (const rec of recs) this.channels.set(rec.id, new Channel(this, rec));
      return this.list();
    }

    async _persist() {
      if (!this.store) return;
      const recs = [];
      for (const ch of this.channels.values()) recs.push(ch.meta);
      try { await this.store.set({ [STORE_KEY]: recs }); } catch (_) {}
    }

    list() {
      return Array.from(this.channels.values()).map((c) => c.describe());
    }

    get(id) {
      return this.channels.get(id) || null;
    }

    // Create a new channel record (does NOT start it unless `start: true` and a
    // credential can be resolved). Persists immediately so it survives reload.
    async create(spec) {
      spec = spec || {};
      if (!spec.provider) throw new Error('channel requires a provider');
      if (!spec.walletId && !spec.accountId) {
        throw new Error('channel must be bound to a wallet/account (walletId or accountId)');
      }
      const guide = PROVIDER_GUIDES[spec.provider] || null;
      const meta = {
        id: spec.id || rid(),
        label: spec.label || ('Channel ' + (this.channels.size + 1)),
        walletId: spec.walletId || null,
        accountId: spec.accountId || null,
        provider: spec.provider,                 // 'claude' | 'openai' | 'copilot' | guide key
        model: spec.model || (guide && guide.defaultModel) || this.defaults.model || null,
        baseUrl: spec.baseUrl || null,
        credRef: spec.credRef || null,           // pointer into the vault; NEVER the key
        enabled: false,
        readOnly: !!spec.readOnly,               // read-only channels can run without caps
        config: spec.config || {},               // venue/strategy knobs (exchange, pairs, allowlist…)
        caps: spec.caps || (spec.readOnly ? {} : Object.assign({}, DEFAULT_CAPS)),
        pnl: { realizedUsd: 0, tradeCount: 0 },
        createdAt: Date.now(),
      };
      if (this.channels.has(meta.id)) throw new Error('channel already exists: ' + meta.id);
      const ch = new Channel(this, meta);
      this.channels.set(meta.id, ch);
      await this._persist();
      if (spec.start) await this.start(meta.id);
      return ch.describe();
    }

    // Start (connect) a channel: resolve its credential, build its isolated Agent
    // instance, and mark it enabled so it auto-resumes on the next unlock.
    async start(id) {
      const ch = this.channels.get(id);
      if (!ch) throw new Error('no such channel: ' + id);
      if (ch.instance) return ch.describe(); // already running

      const meta = ch.meta;

      // RED-3: refuse to arm a value-moving channel without caps + a confirm
      // handler the host enforces. Read-only channels are exempt.
      if (!meta.readOnly) {
        if (!hasCaps(meta.caps)) {
          throw new Error('refusing to start "' + meta.label + '": set spend/risk caps first — a value-moving channel requires a catch-all caps.sessionUsd that covers every asset');
        }
        if (!this.confirm) {
          throw new Error('refusing to start "' + meta.label + '": a confirmation handler is required for value-moving channels');
        }
      }

      // Resolve the credential from the vault via the host. Never persisted here.
      let cred = null;
      if (this.resolveCredential) cred = await this.resolveCredential(meta.credRef, meta);
      if (!cred || !cred.apiKey) {
        throw new Error('cannot start "' + meta.label + '": no LLM credential available (unlock the wallet and connect this channel)');
      }
      const credential = {
        provider: meta.provider || cred.provider,
        apiKey: cred.apiKey,
        model: meta.model || cred.model,
        baseUrl: meta.baseUrl || cred.baseUrl,
      };

      // Per-channel kill wiring: wipe the live cred, run the per-channel hook,
      // and (for the terminal/global case) the host-wide hook is run by killAll.
      const onKill = async (reason) => {
        if (this.onChannelKill) { try { await this.onChannelKill(id, reason); } catch (_) {} }
      };

      const onEvent = (ev) => {
        // P&L bookkeeping: count committed value-moving executions.
        if (ev && ev.type === 'executed' && ev.txid) {
          ch.pnl.tradeCount += 1;
          ch.pnl.trades.push({ ts: Date.now(), name: ev.name, txid: ev.txid });
          ch.meta.pnl = { realizedUsd: ch.pnl.realizedUsd, tradeCount: ch.pnl.tradeCount };
          this._persist();
        }
        if (this.onEvent) { try { this.onEvent(id, ev); } catch (_) {} }
      };

      ch.instance = this.agentFactory.start({
        credential,
        caps: meta.caps || {},
        confirm: this.confirm,
        onKill,
        ctx: this.ctxFor ? this.ctxFor(meta) : (this.defaults.ctx || {}),
        store: namespacedStore(this.store, id), // isolated audit persistence
        onEvent,
        model: credential.model,
        allowlist: (meta.config && meta.config.allowlist) || this.defaults.allowlist,
        readOnly: !!meta.readOnly,        // enforce read-only by capability (strips value tools)
        system: (meta.config && meta.config.system) || this.defaults.system,
        maxTurns: (meta.config && meta.config.maxTurns) || this.defaults.maxTurns,
        requireConfirm: meta.readOnly ? undefined : true,
        autoApproveUnderUsd: meta.config && meta.config.autoApproveUnderUsd,
        fetchImpl: this.fetchImpl,
      });
      ch.killed = false;
      meta.enabled = true;
      await this._persist();
      return ch.describe();
    }

    // Stop (disconnect) a channel: tear down the live instance and its decrypted
    // credential, and mark it disabled so it will not auto-resume. The record +
    // its caps/config/P&L are kept so the user can reconnect later.
    async stop(id) {
      const ch = this.channels.get(id);
      if (!ch) throw new Error('no such channel: ' + id);
      if (ch.instance) {
        try { ch.instance.reset(); } catch (_) {}
      }
      ch.instance = null;
      ch.meta.enabled = false;
      await this._persist();
      return ch.describe();
    }

    // Permanently remove a channel: stop it, then drop its record and its
    // persisted audit log.
    async delete(id) {
      const ch = this.channels.get(id);
      if (!ch) return false;
      await this.stop(id).catch(() => {});
      this.channels.delete(id);
      await this._persist();
      if (this.store) {
        try { await this.store.remove('ch:' + id + ':agentAuditLog'); } catch (_) {}
      }
      return true;
    }

    // Auto-resume every enabled channel after an unlock. Channels that cannot be
    // resumed (missing credential, caps cleared) are skipped and reported, not
    // thrown — one bad channel must not block the others.
    async resume() {
      const started = [];
      const skipped = [];
      for (const ch of this.channels.values()) {
        if (!ch.meta.enabled || ch.instance) continue;
        try {
          await this.start(ch.id);
          started.push(ch.id);
        } catch (e) {
          skipped.push({ id: ch.id, reason: e.message });
        }
      }
      return { started, skipped };
    }

    // The always-visible global kill: stop every channel AND run the host-wide
    // kill hook (locks the vault, revokes exchange sessions). One tap, everything
    // across every channel stops.
    async killAll(reason) {
      for (const ch of this.channels.values()) {
        try { await ch.kill(reason || 'kill all'); } catch (_) {}
      }
      if (this.onKill) { try { await this.onKill(reason || 'kill all'); } catch (_) {} }
      await this._persist();
    }
  }

  const AgentChannels = {
    create(opts) { return new ChannelManager(opts); },
    ChannelManager,
    Channel,
    PROVIDER_GUIDES,
    DEFAULT_CAPS,
    STORE_KEY,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentChannels;
  root.AgentChannels = AgentChannels;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
