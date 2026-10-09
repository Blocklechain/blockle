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
      this.model = opts.model || 'claude-opus-5';
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
      this.model = opts.model || 'gpt-4o';
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

  // ---- GitHub Copilot (OpenAI-compatible tool calls) — stub -----------------
  // Copilot's chat endpoint speaks the OpenAI tool-call shape with its own base
  // URL + auth headers. Thin subclass; fill in the exact editor headers your
  // Copilot token requires.
  class CopilotProvider extends OpenAIProvider {
    constructor(opts) {
      super(Object.assign({}, opts, {
        name: 'copilot',
        baseUrl: opts.baseUrl || 'https://api.githubcopilot.com',
        model: opts.model || 'gpt-4o',
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
      if (!opts.apiKey) throw new Error('provider requires an apiKey (from the vault)');
      switch (opts.provider) {
        case 'claude': return new ClaudeProvider(opts);
        case 'openai': return new OpenAIProvider(opts);
        case 'copilot': return new CopilotProvider(opts);
        default: throw new Error('unknown provider: ' + opts.provider);
      }
    },
    ClaudeProvider,
    OpenAIProvider,
    CopilotProvider,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentProviders;
  root.AgentProviders = AgentProviders;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
