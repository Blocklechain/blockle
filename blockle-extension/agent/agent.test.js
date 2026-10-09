// agent/agent.test.js — unit tests for the mandatory safety layer.
// Run: node --test blockle-extension/agent/
//
// Focus (per the PASS-1 contract): spending cap enforced, confirmation required,
// kill switch halts. Plus allowlist enforcement, audit tamper-evidence, the
// runner build->cap->confirm->commit ordering, and provider tool-call mapping.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentPolicy = require('./policy.js');
const AgentAudit = require('./audit.js');
const AgentTools = require('./tools.js');
const AgentRunner = require('./runner.js');
const AgentProviders = require('./providers.js');

// A provider that replays a fixed script of { text, toolCalls } turns.
function scripted(script) {
  let i = 0;
  return { name: 'scripted', async turn() { return script[i++] || { text: 'done' }; } };
}

// ---------------------------------------------------------------------------
// 1. SPENDING CAP ENFORCED
// ---------------------------------------------------------------------------

test('cap: per-asset cap hard-rejects an over-cap action', () => {
  const p = AgentPolicy.create({ caps: { perAsset: { BTC: '1000' } } });
  assert.throws(() => p.assessValue({ asset: 'BTC', amount: '1500' }), /per-asset cap exceeded/);
  // under cap is fine, and cumulative spend accrues
  p.assessValue({ asset: 'BTC', amount: '600' });
  p.recordSpend({ asset: 'BTC', amount: '600' });
  assert.throws(() => p.assessValue({ asset: 'BTC', amount: '500' }), /per-asset cap exceeded/);
  p.assessValue({ asset: 'BTC', amount: '400' }); // 600 + 400 = 1000, exactly at cap
});

test('cap: session USD cap hard-rejects and accrues cumulatively', () => {
  const p = AgentPolicy.create({ caps: { sessionUsd: 50 } });
  assert.throws(() => p.assessValue({ asset: 'X', amount: '1', usd: 60 }), /session USD cap exceeded/);
  p.assessValue({ asset: 'X', amount: '1', usd: 40 });
  p.recordSpend({ asset: 'X', amount: '1', usd: 40 });
  assert.throws(() => p.assessValue({ asset: 'X', amount: '1', usd: 20 }), /session USD cap exceeded/);
});

test('cap: with a session USD cap, an unpriced action is rejected (cannot verify)', () => {
  const p = AgentPolicy.create({ caps: { sessionUsd: 50 } });
  assert.throws(() => p.assessValue({ asset: 'X', amount: '1', usd: null }), /cannot verify/);
});

test('cap: caps reset only via explicit resetSpend, never implicitly', () => {
  const p = AgentPolicy.create({ caps: { sessionUsd: 50 } });
  p.recordSpend({ asset: 'X', amount: '1', usd: 50 });
  assert.throws(() => p.assessValue({ asset: 'X', amount: '1', usd: 1 }));
  p.resetSpend();
  p.assessValue({ asset: 'X', amount: '1', usd: 1 }); // ok again after explicit reset
});

// ---------------------------------------------------------------------------
// 2. CONFIRMATION REQUIRED
// ---------------------------------------------------------------------------

test('confirm: default-on gate denies when the user declines', async () => {
  const p = AgentPolicy.create({ confirm: async () => false });
  const g = await p.gateConfirm({ action: 'send' }, { usd: 5 });
  assert.equal(g.approved, false);
});

test('confirm: gate approves when the user accepts', async () => {
  const seen = [];
  const p = AgentPolicy.create({ confirm: async (s) => { seen.push(s); return true; } });
  const g = await p.gateConfirm({ action: 'send', amount: '10' }, { usd: 5 });
  assert.equal(g.approved, true);
  assert.equal(seen.length, 1); // the summary was shown to the human
});

test('confirm: FAIL-SAFE — no confirmation handler means denied', async () => {
  const p = AgentPolicy.create({ requireConfirm: true }); // no confirm fn
  const g = await p.gateConfirm({ action: 'send' }, { usd: 5 });
  assert.equal(g.approved, false);
});

test('confirm: auto-approve under threshold is opt-in and bounded', async () => {
  let asked = 0;
  const p = AgentPolicy.create({ confirm: async () => { asked++; return true; }, autoApproveUnderUsd: 10 });
  const under = await p.gateConfirm({ action: 'send' }, { usd: 5 });
  assert.equal(under.approved, true);
  assert.equal(under.auto, true);
  assert.equal(asked, 0); // auto-approved, human not asked
  const over = await p.gateConfirm({ action: 'send' }, { usd: 25 });
  assert.equal(over.auto, false);
  assert.equal(asked, 1); // over threshold -> human asked
});

// ---------------------------------------------------------------------------
// 3. KILL SWITCH HALTS
// ---------------------------------------------------------------------------

test('kill: sets killed, runs onKill, and assertLive throws thereafter', async () => {
  let locked = 0;
  const p = AgentPolicy.create({ onKill: async () => { locked++; } });
  assert.equal(p.isKilled(), false);
  await p.kill('test');
  assert.equal(p.isKilled(), true);
  assert.equal(locked, 1); // vault-lock hook fired
  assert.throws(() => p.assertLive(), /killed/);
  await p.kill('again');
  assert.equal(locked, 1); // idempotent — onKill not re-run
});

test('kill: a kill during the confirmation await still blocks the commit', async () => {
  let committed = 0;
  const ctx = {
    estimateUsd: async () => 1,
    buildSend: async () => ({ raw: '00', txid: 'abc', fee: '1000' }),
    broadcast: async () => { committed++; return { txid: 'abc', accepted: true }; },
  };
  const tools = AgentTools.build(ctx);
  const audit = AgentAudit.create({});
  const policy = AgentPolicy.create({ audit, confirm: async () => { await runner.kill('user'); return true; } });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'send', arguments: { chain: 'block', to: 'block1x', amount: '1' } }] },
      { text: 'should never get here' },
    ]),
    tools, policy, audit,
  });

  const res = await runner.run('send 1');
  assert.equal(res.stopped, true);
  assert.equal(res.reason, 'killed');
  assert.equal(committed, 0); // broadcast NEVER ran despite confirm returning true
  assert.equal(policy.isKilled(), true);
});

// ---------------------------------------------------------------------------
// Runner integration: build -> cap -> confirm -> commit ordering
// ---------------------------------------------------------------------------

test('runner: approved value-moving call builds, confirms, commits, and records spend', async () => {
  const calls = { build: 0, broadcast: 0 };
  const ctx = {
    estimateUsd: async () => 5,
    buildSend: async (chain, req) => { calls.build++; return { raw: 'de', txid: 'tx123', fee: '1000', summary: req }; },
    broadcast: async () => { calls.broadcast++; return { txid: 'tx123', accepted: true }; },
    explorerTx: (chain, txid) => 'https://ex/' + txid,
  };
  const tools = AgentTools.build(ctx);
  const audit = AgentAudit.create({});
  const confirms = [];
  const policy = AgentPolicy.create({ caps: { sessionUsd: 100 }, confirm: async (s) => { confirms.push(s); return true; }, audit });
  const runner = AgentRunner.create({
    provider: scripted([
      { text: 'sending now', toolCalls: [{ id: 't1', name: 'send', arguments: { chain: 'block', to: 'block1y', amount: '7' } }] },
      { text: 'all done' },
    ]),
    tools, policy, audit,
  });

  const res = await runner.run('send 7 BLOCK to block1y');
  assert.equal(res.reason, 'end_turn');
  assert.equal(calls.build, 1);
  assert.equal(calls.broadcast, 1);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].txid, 'tx123'); // the built tx was shown before broadcast
  // spend recorded
  assert.equal(policy.spentUsd, 5);
  // audit has the full decision trail and verifies
  const kinds = audit.list().map((e) => e.type);
  assert.ok(kinds.includes('cap_check'));
  assert.ok(kinds.includes('confirmation'));
  assert.ok(kinds.includes('executed'));
  const v = await audit.verify();
  assert.equal(v.ok, true);
});

test('runner: an over-cap value-moving call errors to the model and never commits', async () => {
  let broadcast = 0;
  const ctx = {
    estimateUsd: async () => 999, // way over the $10 session cap
    buildSend: async (chain, req) => ({ raw: 'de', txid: 'tx', fee: '1000', summary: req }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ caps: { sessionUsd: 10 }, confirm: async () => true });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'send', arguments: { chain: 'block', to: 'block1z', amount: '1' } }] },
      { text: 'ok, cancelled' },
    ]),
    tools, policy,
  });

  const res = await runner.run('send a fortune');
  assert.equal(res.reason, 'end_turn');
  assert.equal(broadcast, 0); // cap blocked it before any confirm/commit
  // the tool result fed back to the model marks the failure
  const toolMsg = runner.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg);
  assert.match(toolMsg.results[0].content, /cap exceeded/);
  assert.equal(toolMsg.results[0].isError, true);
});

test('runner: a declined confirmation returns a rejection and does not commit', async () => {
  let broadcast = 0;
  const ctx = {
    estimateUsd: async () => 1,
    buildSend: async (chain, req) => ({ raw: 'de', txid: 'tx', fee: '1000', summary: req }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ confirm: async () => false });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'send', arguments: { chain: 'block', to: 'block1z', amount: '1' } }] },
      { text: 'understood, not sending' },
    ]),
    tools, policy,
  });
  const res = await runner.run('maybe send');
  assert.equal(broadcast, 0);
  const toolMsg = runner.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.results[0].content, /user declined/);
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

test('allowlist: a tool not on the allowlist is rejected before execution', async () => {
  const tools = AgentTools.build({});
  const policy = AgentPolicy.create({});
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'get_markets', arguments: {} }] },
      { text: 'ok' },
    ]),
    tools, policy,
    allowlist: ['get_balance', 'get_address'], // narrowed — get_markets excluded
  });
  const res = await runner.run('list markets');
  assert.equal(res.reason, 'end_turn');
  const toolMsg = runner.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.results[0].content, /not on allowlist/);
  assert.equal(toolMsg.results[0].isError, true);
});

test('allowlist: policy.checkAllowed throws ToolNotAllowed for unknown names', () => {
  const p = AgentPolicy.create({}).setAllowlist(['send']);
  assert.throws(() => p.checkAllowed('rm_rf'), /not on allowlist/);
  p.checkAllowed('send');
});

// ---------------------------------------------------------------------------
// Audit tamper-evidence
// ---------------------------------------------------------------------------

test('audit: verify() detects a tampered entry', async () => {
  const audit = AgentAudit.create({});
  await audit.record({ type: 'prompt', text: 'hi' });
  await audit.record({ type: 'executed', name: 'send', txid: 'abc' });
  assert.equal((await audit.verify()).ok, true);
  audit.entries[0].text = 'edited after the fact';
  const v = await audit.verify();
  assert.equal(v.ok, false);
  assert.equal(v.at, 0);
});

// ---------------------------------------------------------------------------
// Provider normalization
// ---------------------------------------------------------------------------

test('provider(claude): maps tool_use blocks to internal toolCalls', async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /\/v1\/messages$/);
    assert.equal(init.headers['x-api-key'], 'sk-test');
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].input_schema.type, 'object'); // schema passed through
    return {
      ok: true,
      async json() {
        return { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'u1', name: 'send', input: { amount: '5' } }] };
      },
    };
  };
  const p = AgentProviders.create({ provider: 'claude', apiKey: 'sk-test', fetchImpl: fakeFetch });
  const out = await p.turn({
    system: 's', messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'send', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(out.text, 'ok');
  assert.equal(out.toolCalls[0].name, 'send');
  assert.deepEqual(out.toolCalls[0].arguments, { amount: '5' });
});

test('provider(openai): maps function tool_calls and stringifies args', async () => {
  let sentBody;
  const fakeFetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'swap', arguments: '{"from":"BLOCK","to":"USDC","amount":"3"}' } }] } }] };
      },
    };
  };
  const p = AgentProviders.create({ provider: 'openai', apiKey: 'sk', fetchImpl: fakeFetch });
  const out = await p.turn({
    system: 'sys',
    messages: [
      { role: 'user', text: 'swap' },
      { role: 'assistant', text: null, toolCalls: [{ id: 'c0', name: 'quote', arguments: { from: 'BLOCK' } }] },
      { role: 'tool', results: [{ id: 'c0', name: 'quote', content: '{"ok":true}' }] },
    ],
    tools: [{ name: 'swap', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(out.toolCalls[0].name, 'swap');
  assert.deepEqual(out.toolCalls[0].arguments, { from: 'BLOCK', to: 'USDC', amount: '3' });
  // round-trip of assistant tool_calls + tool result into OpenAI wire shape
  assert.equal(sentBody.messages[0].role, 'system');
  const asst = sentBody.messages.find((m) => m.role === 'assistant');
  assert.equal(asst.tool_calls[0].function.name, 'quote');
  const toolRole = sentBody.messages.find((m) => m.role === 'tool');
  assert.equal(toolRole.tool_call_id, 'c0');
});

test('provider: credential is required (never silently absent)', () => {
  assert.throws(() => AgentProviders.create({ provider: 'claude' }), /apiKey/);
  assert.throws(() => AgentProviders.create({ provider: 'nope', apiKey: 'x' }), /unknown provider/);
});
