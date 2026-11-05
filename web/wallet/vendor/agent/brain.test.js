// agent/brain.test.js — provider selection + the "no silent hosted default" rule
// for the web wallet brain. Run: node --test web/wallet/vendor/agent/
//
// Change 1: a first-class keyless LOCAL provider (Ollama / LM Studio, OpenAI-
// compatible). Change 2: nothing silently becomes the hosted gateway — a provider
// must be explicitly chosen; the factory never defaults to hosted.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentProviders = require('./providers.js');
const AgentCommand = require('./command.js');
const AgentRunner = require('./runner.js');

test('local provider is keyless and points at Ollama by default', () => {
  const p = AgentProviders.create({ provider: 'local' });
  assert.strictEqual(p.constructor.name, 'LocalProvider');
  assert.strictEqual(p.local, true);
  assert.strictEqual(p.baseUrl, 'http://localhost:11434');
  assert.ok(p.model, 'has a default instruct model');
  assert.strictEqual(p.apiKey, '', 'no API key required for a local server');
});

test('local presets include Ollama and LM Studio', () => {
  const P = AgentProviders.LOCAL_PRESETS;
  assert.ok(P.ollama && P.ollama.baseUrl === 'http://localhost:11434');
  assert.ok(P.lmstudio && P.lmstudio.baseUrl === 'http://localhost:1234');
});

test('a BYO provider still requires an apiKey from the vault', () => {
  assert.throws(() => AgentProviders.create({ provider: 'openai' }), /apiKey/);
  assert.throws(() => AgentProviders.create({ provider: 'claude' }), /apiKey/);
});

test('NO silent hosted default: the factory never invents a provider', () => {
  // An empty/unknown selection must FAIL rather than quietly become hosted — this
  // is the module-level guarantee behind the app's "show setup prompt" behaviour.
  assert.throws(() => AgentProviders.create({}), /apiKey|provider/);
  assert.throws(() => AgentProviders.create({ provider: 'mystery' }), /unknown provider|apiKey/);
  // hosted is reachable ONLY when explicitly named (and stays keyless).
  const h = AgentProviders.create({ provider: 'hosted', gatewayUrl: 'https://agent.blockle.org', sessionToken: 't' });
  assert.strictEqual(h.constructor.name, 'HostedProvider');
});

test('the command router requires an injected provider (no built-in fallback)', () => {
  assert.throws(() => AgentCommand.create({ tools: {}, policy: {} }), /provider/);
});

test('the runner requires an injected provider (no built-in fallback)', () => {
  assert.throws(() => AgentRunner.create({ tools: {}, policy: {} }), /provider/);
});
