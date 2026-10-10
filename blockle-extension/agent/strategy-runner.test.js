// agent/strategy-runner.test.js — the StrategyRunner drives planned Intents
// through the SAME value-moving pipeline as the NL runner. These are the
// important tests (spec section 6): a strategy Intent in `auto` mode is STILL
// (a) rejected by a cap, (b) aborted by kill mid-tick, (c) forced through confirm
// above the auto threshold, and (d) refused on a mainnet venue when the mainnet
// gate is off. Proves strategies cannot bypass the safety layer.
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');

const AgentPolicy = require('./policy.js');
const AgentAudit = require('./audit.js');
const AgentRunner = require('./runner.js');
const AgentStrategies = require('./strategies.js');
const AgentStrategyRunner = require('./strategy-runner.js');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// A fake value-moving tools registry whose commit() just counts broadcasts.
function fakeTools() {
  const state = { commits: 0, prepared: [], committedNames: [] };
  const mk = (name) => ({
    name, valueMoving: true,
    async prepare(a) {
      state.prepared.push(name);
      return {
        summary: { action: name, args: a },
        value: { asset: a.from || a.asset || 'X', amount: a.amount || '0', usd: a.usd != null ? a.usd : null },
        commit: async () => { state.commits++; state.committedNames.push(name); return { txid: 'tx' + state.commits, accepted: true }; },
      };
    },
  });
  const map = { swap: mk('swap'), place_order: mk('place_order'), send: mk('send') };
  return {
    state,
    get: (n) => map[n] || null,
    names: () => Object.keys(map),
    valueMovingNames: () => Object.keys(map),
  };
}

// A registry with one `manual` strategy that returns whatever Intents the test
// hands it — so we can exercise the gate with precise inputs.
function manualRegistry() {
  return {
    names: () => ['manual'],
    has: (n) => n === 'manual',
    get: (n) => (n === 'manual' ? {
      name: 'manual', describe: () => 'manual test strategy',
      validateParams: (p) => p || {},
      plan: async (_ctx, p) => (p.intents || []).slice(),
    } : null),
  };
}

function intent(tool, args, extra) {
  return Object.assign({ tool, args, rationale: 'test', estUsd: args.usd != null ? args.usd : null, strategy: 'manual', tag: tool + ':t', group: null, mainnet: false }, extra || {});
}

function makeRunner(policy, overrides) {
  const tools = fakeTools();
  const runner = AgentStrategyRunner.create(Object.assign({
    tools, policy, audit: AgentAudit.create({}), ctx: {}, registry: manualRegistry(), AgentRunner,
  }, overrides || {}));
  return { runner, tools };
}

// ===========================================================================
// DEFAULT MODE = propose (emit + audit, dispatch NOTHING)
// ===========================================================================
test('propose (default): emits proposals and dispatches nothing', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 100 }, confirm: async () => true });
  const { runner, tools } = makeRunner(policy);
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', { intents: [intent('swap', { from: 'USDC', amount: '1', usd: 5 })] });
  assert.equal(res.length, 1);
  assert.ok(res[0].proposed, 'returned a proposal');
  assert.equal(tools.state.commits, 0); // NOTHING broadcast in propose mode
});

// ===========================================================================
// (a) a cap still rejects an auto Intent
// ===========================================================================
test('auto: a per-session USD cap still rejects an over-cap Intent (no commit)', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 10 }, confirm: async () => true });
  const { runner, tools } = makeRunner(policy);
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', { intents: [intent('swap', { from: 'USDC', amount: '1', usd: 50 })] }, { mode: 'auto' });
  assert.equal(tools.state.commits, 0);
  assert.ok(res[0].error, 'the cap error surfaced');
  assert.match(res[0].message, /cap exceeded/);
});

// ===========================================================================
// (b) kill aborts the tick mid-flight
// ===========================================================================
test('auto: a kill mid-tick aborts the rest and blocks the in-flight commit', async () => {
  let asked = 0;
  const policy = AgentPolicy.create({
    caps: { sessionUsd: 1000 },
    confirm: async () => { asked++; if (asked === 2) await policy.kill('user'); return true; },
  });
  const { runner, tools } = makeRunner(policy);
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', {
    intents: [
      intent('swap', { from: 'USDC', amount: '1', usd: 5 }),   // commits
      intent('swap', { from: 'USDC', amount: '2', usd: 5 }),   // confirm -> kill -> blocked
      intent('swap', { from: 'USDC', amount: '3', usd: 5 }),   // never reached
    ],
  }, { mode: 'auto' });
  assert.equal(tools.state.commits, 1);         // only the first committed
  assert.equal(policy.isKilled(), true);
  assert.ok(res.length < 3, 'the third Intent was never dispatched');
});

// ===========================================================================
// (c) confirm is required above the auto-approve threshold
// ===========================================================================
test('auto: Intents above autoApproveUnderUsd still require confirm', async () => {
  let asked = 0;
  const policy = AgentPolicy.create({
    caps: { sessionUsd: 1000 },
    autoApproveUnderUsd: 10,
    confirm: async () => { asked++; return false; }, // decline the one it asks about
  });
  const { runner, tools } = makeRunner(policy);
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', {
    intents: [
      intent('swap', { from: 'USDC', amount: '1', usd: 5 }),    // under threshold -> auto commit
      intent('swap', { from: 'USDC', amount: '2', usd: 50 }),   // over threshold -> confirm asked -> declined
    ],
  }, { mode: 'auto' });
  assert.equal(asked, 1);                 // confirm asked ONCE (only the large one)
  assert.equal(tools.state.commits, 1);   // only the auto-approved small one committed
  assert.ok(res[1].rejected, 'the large Intent was rejected at the confirm gate');
});

// ===========================================================================
// (d) mainnet gate refuses a mainnet-venue Intent when mainnetEnabled=false
// ===========================================================================
test('mainnet gate: a mainnet-venue Intent is refused when mainnetEnabled=false', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  const { runner, tools } = makeRunner(policy, { mainnetEnabled: false });
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', {
    intents: [intent('swap', { from: 'USDC', amount: '1', usd: 5 }, { mainnet: true })],
  }, { mode: 'auto' });
  assert.equal(tools.state.commits, 0);
  assert.ok(res[0].blocked);
  assert.match(res[0].reason, /mainnet/);
});

test('mainnet gate: the SAME Intent dispatches once mainnetEnabled=true', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  const { runner, tools } = makeRunner(policy, { mainnetEnabled: true });
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', {
    intents: [intent('swap', { from: 'USDC', amount: '1', usd: 5 }, { mainnet: true })],
  }, { mode: 'auto' });
  assert.equal(tools.state.commits, 1);
  assert.ok(res[0].executed);
});

// ===========================================================================
// FIX-3: CHAIN-LEVEL mainnet backstop (not only venue descriptors / a param)
// ===========================================================================
test('mainnet backstop (FIX-3): a venue-less auto-routed dca swap is refused when ctx.network()==mainnet', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  const tools = fakeTools();
  const ctx = {
    now: () => 86400000, network: () => 'mainnet', // chain context is MAINNET
    async prices() { return { USDC: 1 }; },
  };
  const runner = AgentStrategyRunner.create({
    tools, policy, audit: AgentAudit.create({}), ctx, AgentRunner,
    registry: AgentStrategies.createRegistry(), mainnetEnabled: false,
  });
  policy.setAllowlist(tools.names());
  // dca emits a `swap` on the generic 'blockle' venue (auto-routed at commit).
  const res = await runner.tick('dca', { asset: 'BLOCK', quote: 'USDC', usdPerBuy: 10, intervalSec: 86400, lastRunAt: 0 }, { mode: 'auto' });
  assert.equal(tools.state.commits, 0, 'nothing commits on mainnet when the gate is off');
  assert.ok(res[0].blocked, 'the auto-routed swap is refused by the chain-level backstop');
  assert.match(res[0].reason, /mainnet/);
});

test('mainnet backstop (FIX-3): the backstop fires even when the Intent flag is mainnet=false', async () => {
  // A planner (or a mainnet venue missing its marker) can leave mainnet=false on
  // the Intent; the chain-level backstop must still refuse it when the network is
  // mainnet and the gate is off.
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  const { runner, tools } = makeRunner(policy, { ctx: { network: () => 'mainnet' }, mainnetEnabled: false });
  policy.setAllowlist(tools.names());
  const res = await runner.tick('manual', {
    intents: [intent('swap', { from: 'USDC', amount: '1', usd: 5 }, { mainnet: false })],
  }, { mode: 'auto' });
  assert.equal(tools.state.commits, 0);
  assert.ok(res[0].blocked);
  assert.match(res[0].reason, /mainnet/);
});

// ===========================================================================
// FIX-6: structural gate invariant — a non-value-moving tool is DROPPED (blocked),
// never run, and never crashes the tick.
// ===========================================================================
test('structural gate (FIX-6): an Intent naming a read-only tool in auto mode is blocked, not run', async () => {
  let ran = 0;
  const readTool = { name: 'get_quote', valueMoving: false, async run() { ran++; return { ok: true }; } };
  const map = { swap: { name: 'swap', valueMoving: true, async prepare() { throw new Error('should not prepare'); } }, get_quote: readTool };
  const tools = { state: { commits: 0 }, get: (n) => map[n] || null, names: () => Object.keys(map), valueMovingNames: () => ['swap'] };
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  policy.setAllowlist(['swap', 'get_quote']); // allowlisted, so it reaches the value-moving gate
  const runner = AgentStrategyRunner.create({ tools, policy, audit: AgentAudit.create({}), ctx: {}, registry: manualRegistry(), AgentRunner });
  const res = await runner.tick('manual', {
    intents: [intent('get_quote', { market: 'A/B' })],
  }, { mode: 'auto' });
  assert.equal(ran, 0, 'tool.run() must NEVER be called for a strategy Intent in auto mode');
  assert.ok(res[0].blocked, 'the read-only tool Intent is dropped as blocked');
  assert.match(res[0].reason, /not value-moving/);
});

// ===========================================================================
// allowlist: non-allowlisted tool dropped; paired legs are all-or-nothing
// ===========================================================================
test('allowlist: an Intent for a non-allowlisted tool is dropped (blocked)', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true }).setAllowlist(['swap']);
  const { runner, tools } = makeRunner(policy);
  const res = await runner.tick('manual', { intents: [intent('place_order', { market: 'A/B', side: 'buy', amount: '1', usd: 5 })] }, { mode: 'auto' });
  assert.equal(tools.state.commits, 0);
  assert.ok(res[0].blocked);
  assert.match(res[0].reason, /allowlist/);
});

test('arbitrage pairing: if ONE leg\'s tool is not allowlisted, BOTH legs are dropped', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true }).setAllowlist(['swap']);
  const { runner, tools } = makeRunner(policy);
  // two legs in one group; the sell leg uses a tool that is NOT allowlisted
  const group = 'arb:X/Y:a->b';
  const res = await runner.tick('manual', {
    intents: [
      intent('swap', { from: 'Y', to: 'X', amount: '1', usd: 5 }, { group, tag: group + ':buy' }),
      intent('place_order', { market: 'X/Y', side: 'sell', amount: '1', usd: 5 }, { group, tag: group + ':sell' }),
    ],
  }, { mode: 'auto' });
  assert.equal(tools.state.commits, 0);                 // neither leg executed
  assert.ok(res.every((r) => r.blocked), 'both legs blocked');
});

// ===========================================================================
// end-to-end: a real arbitrage plan proposes a balanced pair (no dispatch)
// ===========================================================================
test('e2e: real arbitrage strategy proposes a balanced 2-leg pair in propose mode', async () => {
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  const tools = fakeTools();
  const ctx = {
    now: () => 0, network: () => 'testnet',
    async prices() { return { USDC: 1 }; },
    async listVenues() {
      return [
        { id: 'dexA', mainnet: false, ask: '2000', bid: '1999', feeBps: 10 },
        { id: 'dexB', mainnet: false, ask: '2010', bid: '2030', feeBps: 10 },
      ];
    },
    async policyRemaining() { return policy.remaining(); },
  };
  const runner = AgentStrategyRunner.create({ tools, policy, audit: AgentAudit.create({}), ctx, AgentRunner, registry: AgentStrategies.createRegistry() });
  policy.setAllowlist(tools.names());
  const res = await runner.tick('arbitrage', { pair: 'ETH/USDC', maxNotionalUsd: 1000, gasBufferUsd: 1, slippageBps: 5 }, { mode: 'propose' });
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.proposed));
  assert.equal(res[0].proposed.args.venue, 'dexA'); // buy cheapest ask
  assert.equal(res[1].proposed.args.venue, 'dexB'); // sell highest bid
  assert.equal(tools.state.commits, 0);             // propose => nothing broadcast
});
