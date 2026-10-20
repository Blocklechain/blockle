// agent/providers.js — LLM provider adapters for the in-wallet agent.
//
// One interface, three implementations: Claude (Anthropic Messages API), OpenAI
// (Chat Completions function-calling), and a Copilot stub (OpenAI-compatible).
// Each normalizes the provider's native tool-call format to the internal shape so
// agent/runner.js stays provider-agnostic.
//
// CREDENTIAL HANDLING: the apiKey comes from the encrypted vault only. It is used
// solely to call the chosen provider's own API over TLS, and is NEVER written to
// disk unencrypted or sent to any Blockle server. Wiped from memory on lock/kill.
//
// Internal interface:
//   provider.turn({ system, messages, tools }) -> { text?, toolCalls? }
//   messages: [{role:'user', text} | {role:'assistant', text?, toolCalls?} | {role:'tool', results:[{id,name,content,isError}]}]
//   tools:    [{ name, description, parameters /* JSON schema */ }]
//   toolCalls:[{ id, name, arguments /* object */ }]
//
// Exposed as global `AgentProviders`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  const DEFAULT_MAX_TOKENS = 4096;
  // Operator-overridable default for the keyless hosted-agent gateway.
  const DEFAULT_GATEWAY_URL = 'https://agent.blockle.org';

  function pickFetch(fetchImpl) {
    if (fetchImpl) return fetchImpl;
    if (typeof fetch !== 'undefined') return fetch.bind(globalThis);
    throw new Error('no fetch available for LLM provider');
  }

  // ---- Claude (Anthropic Messages API) --------------------------------------
  class ClaudeProvider {
    constructor(opts) {
      this.name = 'claude';
      this.apiKey = opts.apiKey;
      this.model = opts.model || 'claude-sonnet-4-5';
      this.baseUrl = (opts.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
      this.maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
      this.version = opts.anthropicVersion || '2023-06-01';
      this.fetch = pickFetch(opts.fetchImpl);
    }
    _messages(messages) {
      const out = [];
      for (const m of messages) {
        if (m.role === 'user') {
          out.push({ role: 'user', content: [{ type: 'text', text: m.text }] });
        } else if (m.role === 'assistant') {
          const content = [];
          if (m.text) content.push({ type: 'text', text: m.text });
          for (const tc of m.toolCalls || []) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
          }
          out.push({ role: 'assistant', content });
        } else if (m.role === 'tool') {
          const content = (m.results || []).map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
            is_error: !!r.isError,
          }));
          out.push({ role: 'user', content });
        }
      }
      return out;
    }
    async turn({ system, messages, tools }) {
      const body = {
        model: this.model,
        max_tokens: this.maxTokens,
        messages: this._messages(messages),
      };
      if (system) body.system = system;
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters || { type: 'object', properties: {} },
        }));
      }
      const r = await this.fetch(this.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
          // required to call the API directly from the extension (browser) context
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('Claude API ' + r.status + ': ' + t.slice(0, 500));
      }
      const j = await r.json();
      let text = '';
      const toolCalls = [];
      for (const b of j.content || []) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: b.input || {} });
      }
      return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
  }

  // ---- OpenAI (Chat Completions function-calling) ---------------------------
  class OpenAIProvider {
    constructor(opts) {
      this.name = opts.name || 'openai';
      this.apiKey = opts.apiKey;
      this.model = opts.model || 'gpt-4.1';
      this.baseUrl = (opts.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
      this.maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
      this.extraHeaders = opts.extraHeaders || {};
      this.fetch = pickFetch(opts.fetchImpl);
    }
    _messages(system, messages) {
      const out = [];
      if (system) out.push({ role: 'system', content: system });
      for (const m of messages) {
        if (m.role === 'user') {
          out.push({ role: 'user', content: m.text });
        } else if (m.role === 'assistant') {
          const msg = { role: 'assistant', content: m.text || null };
          if (m.toolCalls && m.toolCalls.length) {
            msg.tool_calls = m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
            }));
          }
          out.push(msg);
        } else if (m.role === 'tool') {
          for (const r of m.results || []) {
            out.push({
              role: 'tool',
              tool_call_id: r.id,
              content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
            });
          }
        }
      }
      return out;
    }
    async turn({ system, messages, tools }) {
      const body = {
        model: this.model,
        max_tokens: this.maxTokens,
        messages: this._messages(system, messages),
      };
      if (tools && tools.length) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        }));
      }
      const r = await this.fetch(this.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: Object.assign(
          { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
          this.extraHeaders
        ),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(this.name + ' API ' + r.status + ': ' + t.slice(0, 500));
      }
      const j = await r.json();
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const toolCalls = [];
      for (const tc of msg.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) { args = { _raw: tc.function.arguments }; }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
      }
      return { text: msg.content || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
  }

  // ---- Blockle HOSTED gateway (keyless) -------------------------------------
  // The BRAIN lives on Blockle's server; this provider is a thin transport. It
  // POSTs the agent conversation to ${gatewayUrl}/agent/turn with a SESSION TOKEN
  // (NOT an apiKey — the wallet never holds the upstream LLM key) and returns the
  // ALREADY-normalized { text?, toolCalls? } the gateway produces. The runner and
  // the client policy gate are UNCHANGED: a hosted proposal is gated client-side
  // exactly like a BYO-key proposal — the gateway/LLM can never move funds.
  //
  // Short-lived sessions are transparently refreshed: on a 401 we call the
  // injected `refresh()` once (which re-signs the gateway challenge) and retry.
  class HostedProvider {
    constructor(opts) {
      this.name = 'hosted';
      this.gatewayUrl = (opts.gatewayUrl || '').replace(/\/$/, '');
      if (!this.gatewayUrl) throw new Error('hosted provider requires a gatewayUrl');
      this.sessionToken = opts.sessionToken || null;
      if (!this.sessionToken) throw new Error('hosted provider requires a sessionToken (no apiKey)');
      this.model = opts.model || null;
      this.fetch = pickFetch(opts.fetchImpl);
      // refresh() => Promise<newSessionToken|null>; re-signs the challenge on expiry.
      this.refresh = typeof opts.refresh === 'function' ? opts.refresh : null;
    }
    async _post(payload, attempt) {
      // NOTE: we send ONLY sessionToken + the conversation. Never an apiKey, never
      // any wallet key/seed. The gateway injects the upstream key server-side.
      const body = {
        sessionToken: this.sessionToken,
        system: payload.system,
        messages: payload.messages,
        tools: payload.tools,
      };
      if (this.model) body.model = this.model;
      const r = await this.fetch(this.gatewayUrl + '/agent/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 401 && this.refresh && attempt < 1) {
        const tok = await this.refresh();
        if (tok) { this.sessionToken = tok; return this._post(payload, attempt + 1); }
      }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('hosted agent gateway ' + r.status + ': ' + t.slice(0, 500));
      }
      const j = await r.json();
      // The gateway already returns the common shape; re-normalize defensively so
      // the runner always sees { text?, toolCalls? } with the exact field names.
      const toolCalls = Array.isArray(j.toolCalls)
        ? j.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments || {} }))
        : [];
      return { text: j.text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
    async turn({ system, messages, tools }) {
      return this._post({ system, messages, tools }, 0);
    }
  }

  // ---- EIP-191 personal_sign (identity proof the gateway VERIFIES) ----------
  // Produces a 65-byte `0x` r||s||v signature over the EIP-191 "Ethereum Signed
  // Message" digest, using the same secp256k1 + keccak256 the wallet uses for EVM.
  // This is the ONLY scheme the hosted gateway can verify for a per-address
  // session (it ecrecovers the signer and requires it to equal the 0x address);
  // signing the gateway challenge with the BLOCK (ML-DSA) key instead produced a
  // chain the gateway cannot verify -> a hard 401 (FIX-401). It is identity-only
  // (never a spend) and never touches a wallet key beyond the provided EVM key.
  function _crypto(deps) {
    deps = deps || {};
    const C = deps.crypto || (typeof BLKCrypto !== 'undefined' ? BLKCrypto : null) ||
      (typeof require === 'function' ? (() => { try { return require('../crypto-core.js'); } catch (_) { return null; } })() : null);
    const S = deps.secp || (typeof Secp256k1 !== 'undefined' ? Secp256k1 : null) ||
      (typeof require === 'function' ? (() => { try { return require('../secp256k1.js'); } catch (_) { return null; } })() : null);
    if (!C || !S) throw new Error('eip191 personal_sign requires crypto-core + secp256k1');
    return { C, S };
  }
  function eip191PersonalSign(privKey, message, deps) {
    const { C, S } = _crypto(deps);
    const priv = typeof privKey === 'string' ? C.hexToBytes(String(privKey).replace(/^0x/, '')) : privKey;
    const msgBytes = typeof message === 'string' ? C.utf8(message) : message;
    const prefix = C.utf8('\x19Ethereum Signed Message:\n' + msgBytes.length);
    const digest = C.keccak256(C.concatBytes(prefix, msgBytes));
    const sig = S.sign(digest, priv); // { compact: r||s (64B), recovery }
    const out = new Uint8Array(65);
    out.set(sig.compact, 0);
    out[64] = sig.recovery + 27; // EIP-191 v
    return '0x' + C.bytesToHex(out);
  }

  // Resolve an EVM signing capability from the opts, if the caller supplied one.
  // Accepts opts.evm = { address, sign|personalSign } OR opts.evm = { address,
  // privateKey } (we build the EIP-191 signer ourselves). Returns null when no EVM
  // key/signer is available -> the caller falls back to an anonymous session.
  function _resolveEvm(opts) {
    const e = opts && opts.evm;
    if (!e || !e.address || !/^0x[0-9a-fA-F]{40}$/.test(String(e.address))) return null;
    if (typeof e.sign === 'function' || typeof e.personalSign === 'function') {
      return { address: e.address, sign: e.sign || e.personalSign };
    }
    if (e.privateKey) {
      return { address: e.address, sign: (msg) => eip191PersonalSign(e.privateKey, msg, opts.cryptoDeps) };
    }
    return null;
  }

  // Wallet-signature session handshake against the gateway. Returns the stored
  // hosted connection fields. The scheme is chosen so the gateway ALWAYS verifies
  // it (never a 401):
  //   1. PREFERRED — an EVM key (opts.evm): sign the challenge with EIP-191
  //      personal_sign and open a real per-address session (chain "evm", 0x
  //      address + signature; the gateway ecrecovers the signer).
  //   2. an EXPLICIT { chain, sign, address } the gateway verifies (e.g. the
  //      reference ed25519/solana path) — `sign(message)` returns
  //      { signature, publicKey } and proves control of an address (NOT a spend).
  //   3. FALLBACK — no EVM key and no explicit signer (or opts.anon): the
  //      anonymous, rate-limited free-tier session (step "anon", no signature).
  async function hostedSession(opts) {
    opts = opts || {};
    const f = pickFetch(opts.fetchImpl);
    const base = (opts.gatewayUrl || '').replace(/\/$/, '');
    if (!base) throw new Error('hostedSession requires a gatewayUrl');
    const postJson = async (bodyObj) => {
      const r = await f(base + '/agent/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('hosted session ' + r.status + ': ' + (j && j.error ? j.error : ''));
      return j;
    };
    const anonSession = async () => {
      const a = await postJson({ step: 'anon' });
      return { gatewayUrl: base, sessionToken: a.sessionToken, expiresAt: a.expiresAt, quota: a.quota, chain: 'anon', label: opts.label || 'Blockle hosted (anon)' };
    };

    // 3. explicit anon request.
    if (opts.anon === true) return anonSession();

    // 1. PREFERRED — EVM key via EIP-191 personal_sign (the gateway verifies it).
    const evm = _resolveEvm(opts);
    if (evm) {
      const ch = await postJson({ step: 'challenge', address: evm.address, chain: 'evm' });
      const signed = await evm.sign(ch.challenge);
      const signature = typeof signed === 'string' ? signed : (signed && (signed.signature || signed.sig)) || '';
      const v = await postJson({ step: 'verify', address: evm.address, chain: 'evm', challenge: ch.challenge, signature });
      return {
        gatewayUrl: base, sessionToken: v.sessionToken, expiresAt: v.expiresAt, quota: v.quota,
        address: evm.address, chain: 'evm', label: opts.label || 'Blockle hosted agent',
      };
    }

    // 2. an EXPLICIT gateway-verifiable signer (chain + sign + address).
    if (opts.sign && opts.address && opts.chain) {
      const chain = opts.chain;
      const ch = await postJson({ step: 'challenge', address: opts.address, chain });
      const signed = await opts.sign(ch.challenge);
      const signature = typeof signed === 'string' ? signed : (signed && (signed.signature || signed.sig)) || '';
      const publicKey = (signed && signed.publicKey) || opts.publicKey || '';
      const v = await postJson({ step: 'verify', address: opts.address, chain, challenge: ch.challenge, signature, publicKey });
      return {
        gatewayUrl: base, sessionToken: v.sessionToken, expiresAt: v.expiresAt, quota: v.quota,
        address: opts.address, chain, publicKey, label: opts.label || 'Blockle hosted agent',
      };
    }

    // 4. FALLBACK — no EVM key / signer available -> anonymous session.
    return anonSession();
  }

  // ---- GitHub Copilot (OpenAI-compatible tool calls) — stub -----------------
  // Copilot's chat endpoint speaks the OpenAI tool-call shape with its own base
  // URL + auth headers. Thin subclass; fill in the exact editor headers your
  // Copilot token requires.
  class CopilotProvider extends OpenAIProvider {
    constructor(opts) {
      super(Object.assign({}, opts, {
        name: 'copilot',
        baseUrl: opts.baseUrl || 'https://api.githubcopilot.com',
        model: opts.model || 'gpt-4.1',
        extraHeaders: Object.assign(
          { 'editor-version': 'blockle-wallet/0.1', 'copilot-integration-id': 'blockle-wallet' },
          opts.extraHeaders || {}
        ),
      }));
    }
  }

  const AgentProviders = {
    create(opts) {
      opts = opts || {};
      // The HOSTED provider is keyless: it needs a gatewayUrl + sessionToken, NOT
      // an apiKey. Every other (BYO-key) provider still requires an apiKey from the
      // vault. This is the ONLY place a provider is instantiated.
      if (opts.provider === 'hosted') return new HostedProvider(opts);
      if (!opts.apiKey) throw new Error('provider requires an apiKey (from the vault)');
      switch (opts.provider) {
        case 'claude': return new ClaudeProvider(opts);
        case 'openai': return new OpenAIProvider(opts);
        case 'copilot': return new CopilotProvider(opts);
        default: throw new Error('unknown provider: ' + opts.provider);
      }
    },
    hostedSession,
    eip191PersonalSign,
    DEFAULT_GATEWAY_URL,
    ClaudeProvider,
    OpenAIProvider,
    CopilotProvider,
    HostedProvider,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentProviders;
  root.AgentProviders = AgentProviders;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
