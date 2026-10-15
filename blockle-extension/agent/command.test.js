// agent/command.test.js — the NATURAL-LANGUAGE COMMAND BAR router.
// Run: node --test blockle-extension/agent/
//
// The command bar adds NO new power: a MOCK agent only PROPOSES tool-calls over
// the EXISTING registry, and the EXISTING gate (policy + runner.dispatchValueMoving)
// enforces every fund move. These tests inject a mock agent (canned tool-calls /
// answers) and assert the safety contract holds end-to-end:
//   1. a send intent routes through dispatchValueMoving; a declined confirm => zero commits
//   2. "alice.eth" is resolved and the RESOLVED address is inspected/confirmed/sent
//   3. a "rebalance" yielding multiple swaps gates EACH step
//   4. a bot-P&L query answers from the real dashboard/ledger for a 7-day window,
//      and an unavailable source => honest "unavailable" (never fabricated)
//   5. a query cannot invoke send/swap (runner read-only tool set)
//   6. THE INVARIANT — a huge send proposed via NL is hard-capped by the gate and
//      never commits, exactly like any other agent call.

const { test } = require('node:test');
const assert = require('node:assert');

const AgentPolicy = require('./policy.js');
const AgentTools = require('./tools.js');
const AgentRunner = require('./runner.js');
const AgentCommand = require('./command.js');

const DAY_MS = 86400000;
const RAW_EOA = '0x' + 'a'.repeat(40);
const RESOLVED = '0x' + 'b'.repeat(40);

// A mock agent (provider). A classification call offers NO tools -> we answer with
// the scripted `intent`. Any call that offers tools replays the next scripted turn
// ({ text?, toolCalls? }), exactly like a real provider.turn would.
function mockAgent(opts) {
  opts = opts || {};
  const turns = opts.turns || [];
  let i = 0;
  return {
    name: 'mock',
    async turn({ tools }) {
      if (!tools || tools.length === 0) return { intent: opts.intent || 'query' };
      return turns[i++] || { text: 'done' };
    },
  };
}

// A minimal wallet wiring ctx for AgentTools.build. Counts broadcasts/commits so a
// test can prove nothing moved. Overridable per test.
function makeCtx(over) {
  over = over || {};
  const calls = { broadcast: 0, buildSend: 0, swap: 0, confirm: 0 };
  const ctx = {
    getAddress: async () => '0xADDR',
    getBalance: async (chain) => [{ asset: { symbol: String(chain).toUpperCase(), decimals: 18 }, confirmed: '5000000000000000000' }],
    estimateUsd: over.estimateUsd || (async () => 100),
    buildSend: async (chain, p) => {
      calls.buildSend++;
      if (over.buildSend) return over.buildSend(chain, p);
      return { fee: '21000', txid: '0xbuilt' };
    },
    broadcast: async (chain, built) => {
      calls.broadcast++;
      if (over.broadcast) return over.broadcast(chain, built);
      return { txid: '0xtx', accepted: true };
    },
    inspect: over.inspect || (async () => null),
    exchange: over.exchange || null,
  };
  ctx._calls = calls;
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. a send intent routes through dispatchValueMoving; declined confirm => zero commits
// ---------------------------------------------------------------------------
test('send intent goes through the ONE gate; a declined confirm commits nothing', async () => {
  const ctx = makeCtx();
  const policy = AgentPolicy.create({ confirm: async () => { ctx._calls.confirm++; return false; } });
  const provider = mockAgent({
    intent: 'action',
    turns: [
      { toolCalls: [{ id: '1', name: 'send', arguments: { chain: 'ethereum', to: RAW_EOA, amount: '100000000000000000' } }] },
      { text: 'I did not send anything — you declined.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(ctx), policy });

  const r = await router.run('send 0.1 ETH to ' + RAW_EOA);
  assert.equal(r.intent, 'action');
  assert.equal(ctx._calls.confirm, 1, 'the human was asked to confirm');
  assert.equal(ctx._calls.broadcast, 0, 'a declined confirm must broadcast NOTHING');
  const step = r.steps.find((s) => s.name === 'send');
  assert.equal(step.status, 'declined');
});

// ---------------------------------------------------------------------------
// 2. a name is resolved and the RESOLVED address is inspected/confirmed/sent
// ---------------------------------------------------------------------------
test('alice.eth is resolved and the RESOLVED address (not the raw name) is used throughout', async () => {
  const seen = {};
  const ctx = makeCtx({
    buildSend: (chain, p) => { seen.built = p.to; return { fee: '21000', txid: '0xbuilt' }; },
    inspect: async (chain, intent) => { seen.inspected = intent.to; return null; },
    broadcast: (chain, built) => { seen.broadcastTxid = built.txid; return { txid: '0xtx', accepted: true }; },
  });
  const policy = AgentPolicy.create({ confirm: async (s) => { seen.confirmed = s.to; return true; } });
  const resolveName = async (input, chain) => (input === 'alice.eth' ? { address: RESOLVED, source: 'ens', name: input } : null);
  const events = [];
  const provider = mockAgent({
    intent: 'action',
    turns: [
      { toolCalls: [{ id: '1', name: 'send', arguments: { chain: 'ethereum', to: 'alice.eth', amount: '100000000000000000' } }] },
      { text: 'Sent to alice.eth.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(ctx), policy, resolveName, onEvent: (e) => events.push(e) });

  await router.run('send 0.1 ETH to alice.eth');

  assert.equal(seen.built, RESOLVED, 'the built tx goes to the RESOLVED address');
  assert.equal(seen.inspected, RESOLVED, 'the security inspection sees the RESOLVED address');
  assert.equal(seen.confirmed, RESOLVED, 'the human confirms the RESOLVED address');
  assert.equal(ctx._calls.broadcast, 1);
  const res = events.find((e) => e.type === 'resolved');
  assert.ok(res && res.input === 'alice.eth' && res.address === RESOLVED && res.source === 'ens',
    'a resolved event surfaced the name -> address mapping to the UI');
});

test('a recipient NAME that does not resolve is a hard error — never sent to the raw name', async () => {
  const ctx = makeCtx();
  const policy = AgentPolicy.create({ confirm: async () => true });
  const resolveName = async () => null; // nothing resolves
  const provider = mockAgent({
    intent: 'action',
    turns: [
      { toolCalls: [{ id: '1', name: 'send', arguments: { chain: 'ethereum', to: 'nobody.eth', amount: '1' } }] },
      { text: 'Could not resolve the recipient.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(ctx), policy, resolveName });
  const r = await router.run('send 1 wei to nobody.eth');
  assert.equal(ctx._calls.broadcast, 0);
  const step = r.steps.find((s) => s.name === 'send');
  assert.equal(step.status, 'error');
  assert.match(step.error, /resolve/i);
});

// ---------------------------------------------------------------------------
// 3. a "rebalance" yielding multiple swaps gates EACH step
// ---------------------------------------------------------------------------
test('rebalance -> a SEQUENCE of swaps, and EACH swap gets its own confirm gate', async () => {
  let swapCount = 0;
  const ctx = makeCtx({
    estimateUsd: async () => 10,
    exchange: {
      quote: async () => ({ out: '1' }),
      swap: async () => { swapCount++; return { txid: '0xswap' + swapCount, accepted: true }; },
    },
  });
  let gateCount = 0;
  const policy = AgentPolicy.create({ confirm: async () => { gateCount++; return true; } });
  const events = [];
  const provider = mockAgent({
    intent: 'action',
    turns: [
      { toolCalls: [
        { id: '1', name: 'swap', arguments: { from: 'USDC', to: 'ETH', amount: '60000000' } },
        { id: '2', name: 'swap', arguments: { from: 'ETH', to: 'USDC', amount: '40000000' } },
      ] },
      { text: 'Rebalanced to 60/40.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(ctx), policy, onEvent: (e) => events.push(e) });

  const r = await router.run('rebalance to 60/40 stables');
  assert.equal(gateCount, 2, 'EACH of the two swaps triggered its OWN confirm sheet');
  assert.equal(swapCount, 2, 'both legs committed after their individual confirms');
  const plan = events.find((e) => e.type === 'plan');
  assert.ok(plan && plan.steps.length === 2, 'the multi-step plan was surfaced before executing');
  assert.equal(r.steps.filter((s) => s.status === 'committed').length, 2);
});

// ---------------------------------------------------------------------------
// 4. a bot-P&L query answers from the real dashboard/ledger for a 7-day window,
//    and an unavailable source => honest "unavailable" (never fabricated)
// ---------------------------------------------------------------------------
test('bot-P&L query reads the real engine over a 7-day window and never fabricates', async () => {
  const NOW = 1_700_000_000_000;
  let sinceSeen = null;
  // the REAL bots dashboard/ledger stand-in: realizedUsd/unrealizedUsd per bot,
  // windowed by the sinceMs the router passes.
  const engines = {
    botsPnl: async ({ sinceMs, days }) => {
      sinceSeen = { sinceMs, days };
      return {
        realizedUsd: 42.5,
        bots: [
          { id: 'b1', name: 'DCA BLOCK', realizedUsd: 42.5, unrealizedUsd: 3.0 },
          { id: 'b2', name: 'Grid ETH', realizedUsd: -5.0, unrealizedUsd: 1.0 },
        ],
      };
    },
  };
  const policy = AgentPolicy.create({ confirm: async () => true });
  const provider = mockAgent({
    intent: 'query',
    turns: [
      { toolCalls: [{ id: '1', name: 'bots_pnl', arguments: { days: 7 } }] },
      { text: 'DCA BLOCK made the most this week: +$42.50 realized.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(makeCtx()), policy, engines, now: () => NOW });

  const r = await router.run('which bot made money this week?');
  assert.equal(r.intent, 'query');
  assert.ok(sinceSeen, 'the real bot-P&L engine was consulted');
  assert.equal(sinceSeen.days, 7, 'a 7-day "this week" window');
  assert.equal(sinceSeen.sinceMs, NOW - 7 * DAY_MS, 'window start = now - 7 days (clock injected, not fabricated)');

  // the engine tool returns ONLY the engine's own numbers (no fabrication).
  const tool = router._queryRegistry().get('bots_pnl');
  const out = await tool.run({ days: 7 });
  assert.equal(out.available, true);
  assert.equal(out.windowDays, 7);
  assert.equal(out.realizedUsd, 42.5);
  assert.equal(out.bots[0].realizedUsd, 42.5);
});

test('bot-P&L query with NO engine wired answers an honest "unavailable", never a made-up number', async () => {
  const policy = AgentPolicy.create({ confirm: async () => true });
  const provider = mockAgent({
    intent: 'query',
    turns: [
      { toolCalls: [{ id: '1', name: 'bots_pnl', arguments: { days: 7 } }] },
      { text: 'I cannot tell right now — bot P&L is unavailable.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(makeCtx()), policy, engines: {} /* none wired */ });

  await router.run('which bot made money this week?');
  const tool = router._queryRegistry().get('bots_pnl');
  const out = await tool.run({ days: 7 });
  assert.equal(out.available, false, 'an unavailable source is reported honestly');
  assert.ok(!('realizedUsd' in out), 'no fabricated P&L number is invented when the source is unavailable');
  assert.match(out.reason, /unavailable|not available/i);
});

// ---------------------------------------------------------------------------
// 5. a query cannot invoke send/swap (runner read-only tool set)
// ---------------------------------------------------------------------------
test('a QUERY runs in the read-only tool set — a proposed send is blocked, nothing commits', async () => {
  const ctx = makeCtx();
  const policy = AgentPolicy.create({ confirm: async () => true }); // would approve, but send is unreachable
  const events = [];
  // the mock agent MISBEHAVES: during a query it proposes a value-moving send.
  const provider = mockAgent({
    intent: 'query',
    turns: [
      { toolCalls: [{ id: '1', name: 'send', arguments: { chain: 'ethereum', to: RAW_EOA, amount: '1' } }] },
      { text: 'I can only answer questions here.' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(ctx), policy, onEvent: (e) => events.push(e) });

  await router.run('how much ETH do I have?');
  assert.equal(ctx._calls.broadcast, 0, 'a query can never reach a value-moving tool');
  const err = events.find((e) => e.type === 'tool_error' && e.name === 'send');
  assert.ok(err, 'the stripped send tool was rejected by the allowlist');
  assert.match(err.error, /allow/i);

  // and the read-only registry never even OFFERS a value-moving tool to the model.
  const schemas = router._queryRegistry().schemas().map((s) => s.name);
  assert.ok(!schemas.includes('send') && !schemas.includes('swap'), 'value tools are not offered during a query');
});

// ---------------------------------------------------------------------------
// 6. THE INVARIANT — a huge send proposed via NL is hard-capped and never commits
// ---------------------------------------------------------------------------
test('INVARIANT: a huge NL send is hard-capped by the gate and commits nothing (even if the human would approve)', async () => {
  const ctx = makeCtx({ estimateUsd: async (sym, amt) => (Number(amt) / 1e18) * 2000 }); // ~$2000/ETH
  const policy = AgentPolicy.create({ caps: { sessionUsd: 100 }, confirm: async () => { ctx._calls.confirm++; return true; } });
  const events = [];
  const provider = mockAgent({
    intent: 'action',
    turns: [
      // 1000 ETH == ~$2,000,000, far over the $100 session cap
      { toolCalls: [{ id: '1', name: 'send', arguments: { chain: 'ethereum', to: RAW_EOA, amount: '1000000000000000000000' } }] },
      { text: 'done' },
    ],
  });
  const router = AgentCommand.create({ provider, tools: AgentTools.build(ctx), policy, onEvent: (e) => events.push(e) });

  const r = await router.run('send 1000 ETH to ' + RAW_EOA);
  assert.equal(ctx._calls.broadcast, 0, 'the hard cap blocked the send BEFORE any broadcast');
  assert.equal(ctx._calls.confirm, 0, 'the cap rejects pre-confirm — the human is never even asked to approve an over-cap move');
  const err = events.find((e) => e.type === 'step_error' && e.name === 'send');
  assert.ok(err, 'the step errored');
  assert.match(err.error, /cap/i, 'it failed with a cap-exceeded error, same as any other agent call');
  const step = r.steps.find((s) => s.name === 'send');
  assert.equal(step.status, 'error');
});

// A sanity check that the shared gate used here is the SAME dispatchValueMoving the
// runner uses — no second broadcast path was introduced by the command bar.
test('the command router drives value through runner.dispatchValueMoving (no second path)', () => {
  assert.equal(typeof AgentRunner.dispatchValueMoving, 'function');
  assert.ok(String(AgentCommand.CommandRouter).includes('dispatchValueMoving'));
});
