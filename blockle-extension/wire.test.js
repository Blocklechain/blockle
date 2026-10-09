// wire.test.js — PASS-3 WIRE: proves the agent now ACTUALLY trades through a
// venue AND collects the mandatory 0.05% fee as part of the SAME gated action.
//
//   node wire.test.js
//
// No network/browser: a fake venue registry + a stubbed ctx stand in for the
// live wiring. We drive the real runner/tools/policy so the enforced ordering
// (prepare -> cap -> confirm -> commit trade -> commit fee -> record + audit) is
// exercised exactly as it runs in the popup.

const { test } = require('node:test');
const assert = require('node:assert');

require('./agent/policy.js');
require('./agent/audit.js');
require('./agent/tools.js');
require('./agent/runner.js');
const AgentTools = require('./agent/tools.js');
const AgentPolicy = require('./agent/policy.js');
const AgentAudit = require('./agent/audit.js');
const AgentRunner = require('./agent/runner.js');

// A fake venue that returns an EVM-style BuiltSwap with a routable fee. Mirrors
// the real venues.js contract: buildSwap returns {chain, from, to, amountIn,
// amountOut, minOut, tx, fee, feeTransfer}.
function fakeVenues(calls) {
  const venue = {
    id: 'evmdex', kind: 'aggregator', chains: ['base'],
    supports: (c) => c === 'base',
    async buildSwap(req) {
      calls.build.push(req);
      const feeAmount = (BigInt(req.amount) * 5n / 10000n).toString(); // 0.05%
      return {
        venue: 'evmdex', chain: 'base',
        from: req.from, to: req.to,
        amountIn: String(req.amount), amountOut: '990000', minOut: '985000',
        tx: { chain: 'base', to: '0xRouter', data: '0xdeadbeef', value: '0' },
        allowanceTarget: '0xRouter',
        fee: { bps: 5, chain: 'base', asset: req.from, amount: feeAmount, treasury: '0xTreasury' },
        feeTransfer: { chain: 'base', to: '0xTreasury', amount: feeAmount, asset: req.from },
        autoSend: false,
      };
    },
  };
  return {
    list: () => [venue],
    get: (id) => (id === 'evmdex' ? venue : null),
    forChain: (c) => (c === 'base' ? [venue] : []),
  };
}

function scripted(turns) {
  let i = 0;
  return { async turn() { return turns[i++] || { text: 'done' }; } };
}

test('swap routes through the venue, signs via executeSwap, and collects the 0.05% fee in the SAME action', async () => {
  const calls = { build: [], exec: [], fee: [] };
  const ctx = {
    estimateUsd: async (asset, amt) => Number(amt) / 1e6, // treat as 6dp USD
    getAddress: async () => '0xMe',
    venues: fakeVenues(calls),
    executeSwap: async (built) => { calls.exec.push(built); return { txid: 'swaptx', chain: built.chain, accepted: true }; },
    sendFee: async (ft) => { calls.fee.push(ft); return { txid: 'feetx', chain: ft.chain, asset: ft.asset, amount: ft.amount, treasury: ft.to }; },
    explorerTx: (c, t) => 'https://ex/' + t,
  };
  const tools = AgentTools.build(ctx);
  const audit = AgentAudit.create({});
  const confirms = [];
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async (s) => { confirms.push(s); return true; }, audit });
  const events = [];
  const runner = AgentRunner.create({
    provider: scripted([
      { text: 'swapping', toolCalls: [{ id: 't1', name: 'swap', arguments: { from: 'USDC', to: 'DAI', amount: '1000000', chain: 'base' } }] },
      { text: 'done' },
    ]),
    tools, policy, audit, onEvent: (ev) => events.push(ev),
  });

  const res = await runner.run('swap 1 USDC for DAI on base');
  assert.equal(res.reason, 'end_turn');

  // routed through the venue (NOT exchange.swap), then signed+broadcast
  assert.equal(calls.build.length, 1, 'venue.buildSwap was called');
  assert.equal(calls.exec.length, 1, 'executeSwap signed + broadcast the built tx');
  assert.equal(calls.exec[0].tx.to, '0xRouter');

  // ONE confirmation covered BOTH legs; its summary names the fee
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].feeBps, 5);
  assert.equal(confirms[0].feeTo, '0xTreasury');
  assert.equal(confirms[0].fee, '500'); // floor(1_000_000 * 5 / 10_000)

  // the fee was actually sent to the treasury
  assert.equal(calls.fee.length, 1, 'the 0.05% fee transfer was broadcast');
  assert.equal(calls.fee[0].to, '0xTreasury');
  assert.equal(calls.fee[0].amount, '500');

  // audit carries a dedicated 'fee' record with the txid + treasury
  const feeRec = audit.list().find((e) => e.type === 'fee');
  assert.ok(feeRec, 'audit has a fee record');
  assert.equal(feeRec.treasury, '0xTreasury');
  assert.equal(feeRec.amount, '500');
  assert.equal(feeRec.txid, 'feetx');
  assert.equal(feeRec.bps, 5);
  assert.equal((await audit.verify()).ok, true);

  // BOTH legs counted in spend accounting (trade 1_000_000 + fee 500 base units)
  assert.equal(policy.spentByAsset.USDC.toString(), '1000500');

  // a 'fee' event was emitted for the UI/telemetry
  assert.ok(events.some((e) => e.type === 'fee' && e.fee && e.fee.treasury === '0xTreasury'));
});

test('swap OVER CAP blocks BOTH the trade and the fee (nothing commits, no fee audit)', async () => {
  const calls = { build: [], exec: [], fee: [] };
  const ctx = {
    estimateUsd: async (asset, amt) => Number(amt) / 1e6, // 6dp USD
    getAddress: async () => '0xMe',
    venues: fakeVenues(calls),
    executeSwap: async (built) => { calls.exec.push(built); return { txid: 'swaptx' }; },
    sendFee: async (ft) => { calls.fee.push(ft); return { txid: 'feetx' }; },
  };
  const tools = AgentTools.build(ctx);
  const audit = AgentAudit.create({});
  const confirms = [];
  // cap $0.50; trade 1_000_000 (=$1.00) + fee 500 (=$0.0005) => over cap.
  const policy = AgentPolicy.create({ caps: { sessionUsd: 0.5 }, confirm: async (s) => { confirms.push(s); return true; }, audit });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'swap', arguments: { from: 'USDC', to: 'DAI', amount: '1000000', chain: 'base' } }] },
      { text: 'blocked by cap' },
    ]),
    tools, policy, audit,
  });

  await runner.run('swap over the cap');

  assert.equal(calls.build.length, 1, 'the swap was built (prepare) for the cap pre-check');
  assert.equal(calls.exec.length, 0, 'NO trade committed over cap');
  assert.equal(calls.fee.length, 0, 'NO fee sent over cap');
  assert.equal(confirms.length, 0, 'cap pre-check rejects BEFORE the human is ever prompted');
  assert.equal(policy.spentUsd, 0, 'nothing recorded as spent');
  const toolMsg = runner.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.results[0].isError, true);
  assert.match(toolMsg.results[0].content, /cap/i);
  assert.ok(!audit.list().some((e) => e.type === 'fee'), 'no fee audit record');
  assert.ok(!audit.list().some((e) => e.type === 'executed' && e.valueMoving), 'no value-moving executed record');
  assert.equal((await audit.verify()).ok, true);
});

test('a KILL during confirmation blocks BOTH the trade and the fee', async () => {
  const calls = { build: [], exec: [], fee: [] };
  let policyRef = null;
  const ctx = {
    estimateUsd: async (asset, amt) => Number(amt) / 1e6,
    getAddress: async () => '0xMe',
    venues: fakeVenues(calls),
    executeSwap: async (built) => { calls.exec.push(built); return { txid: 'swaptx' }; },
    sendFee: async (ft) => { calls.fee.push(ft); return { txid: 'feetx' }; },
  };
  const tools = AgentTools.build(ctx);
  const audit = AgentAudit.create({});
  // The user hits KILL while the confirm modal is up: even if the handler then
  // "approves", assertLive() after the await must abort before anything commits.
  const policy = AgentPolicy.create({
    caps: { sessionUsd: 1000 },
    confirm: async () => { await policyRef.kill('user hit kill during confirm'); return true; },
    audit,
  });
  policyRef = policy;
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'swap', arguments: { from: 'USDC', to: 'DAI', amount: '1000000', chain: 'base' } }] },
      { text: 'should never be reached' },
    ]),
    tools, policy, audit,
  });

  const res = await runner.run('swap then kill mid-confirm');
  assert.equal(res.reason, 'killed');
  assert.equal(calls.exec.length, 0, 'kill during confirm blocked the trade');
  assert.equal(calls.fee.length, 0, 'kill during confirm blocked the fee');
  assert.ok(!audit.list().some((e) => e.type === 'fee'), 'no fee audit record after kill');
  assert.equal((await audit.verify()).ok, true);
});

test('swap FAILS CLOSED (no trade, no sign) when the venue cannot route the fee', async () => {
  const calls = { exec: 0, fee: 0 };
  const venues = {
    list: () => [{ id: 'blockle' }],
    get: () => ({ id: 'blockle', kind: 'native', async buildSwap() { throw new Error('no treasury address configured for chain "block" (fail-closed)'); } }),
    forChain: () => [],
  };
  const ctx = {
    estimateUsd: async () => 1,
    getAddress: async () => 'addr',
    venues,
    executeSwap: async () => { calls.exec++; return { txid: 'x' }; },
    sendFee: async () => { calls.fee++; return { txid: 'f' }; },
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ caps: { sessionUsd: 1000 }, confirm: async () => true });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'swap', arguments: { from: 'BLOCK', to: 'USDC', amount: '100' } }] },
      { text: 'could not route the fee' },
    ]),
    tools, policy,
  });

  await runner.run('swap BLOCK for USDC');
  assert.equal(calls.exec, 0, 'no trade executed');
  assert.equal(calls.fee, 0, 'no fee sent');
  const toolMsg = runner.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.results[0].content, /fail-closed|treasury/);
  assert.equal(toolMsg.results[0].isError, true);
});

test('swap without a venue registry falls back to the non-custodial exchange (no external skim)', async () => {
  let swapped = null;
  const ctx = {
    estimateUsd: async () => 3,
    exchange: { async quote() { return { amountOut: '9' }; }, async swap(f, t, a, o) { swapped = { f, t, a, o }; return { orderId: 'o1' }; } },
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ caps: { sessionUsd: 100 }, confirm: async () => true });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't1', name: 'swap', arguments: { from: 'BLOCK', to: 'USDC', amount: '5' } }] },
      { text: 'done' },
    ]),
    tools, policy,
  });
  await runner.run('swap');
  assert.ok(swapped, 'fell back to exchange.swap');
  assert.equal(swapped.f, 'BLOCK');
});
