// security.test.js — the Wallet Security Suite (docs/WALLET-SECURITY.md).
// Run: node --test security.test.js
//
// Asserts the reference implementation against the AUTHORITATIVE shared vectors
// (docs/security-vectors.json) — the exact decode / warning / revoke / gate-
// composition cases the Dart + Python ports must reproduce — plus unit tests for
// the pre-sign gate and the policy-gate composition (a danger inspection forces a
// human confirm even within the auto-approve envelope, and never weakens it).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const S = require('./security.js');
const EVM = require('./chains/evm.js');
const AgentPolicy = require('./agent/policy.js');
const AgentTools = require('./agent/tools.js');
const AgentRunner = require('./agent/runner.js');

const vectors = require(path.join('..', 'docs', 'security-vectors.json'));

// ---- build an injected ctx from a PLAIN vector ctxSpec (no functions) -------
function buildCtx(spec) {
  spec = spec || {};
  const ctx = { config: spec.config || {} };
  if (spec.codeByAddress) {
    ctx.getCode = async (addr) => {
      const k = String(addr).toLowerCase();
      return spec.codeByAddress[k] != null ? spec.codeByAddress[k] : spec.codeByAddress[addr];
    };
  }
  if (spec.balances) ctx.getBalance = async (asset) => {
    const k = asset && asset.symbol;
    return spec.balances[k] != null ? spec.balances[k] : '0';
  };
  if (spec.usd) ctx.estimateUsd = async (asset) => {
    const k = asset && asset.symbol;
    return spec.usd[k] != null ? spec.usd[k] : null;
  };
  if (spec.seenRecipients) ctx.seenRecipients = new Set(spec.seenRecipients.map(S.norm));
  if (spec.priorApprovals) ctx.priorApprovals = new Set(spec.priorApprovals.map(S.norm));
  return ctx;
}
function detailMap(details) {
  const m = {};
  for (const d of (details || [])) m[d.label] = d.value;
  return m;
}
const codesOf = (ws) => ws.map((w) => w.code).sort();

// ===========================================================================
// 1. CANONICAL VECTORS — decode + warnings + severity (shared across ports)
// ===========================================================================
for (const vec of vectors.cases) {
  test('vector: ' + vec.name, async () => {
    const insp = await S.inspectTransaction(vec.tx, buildCtx(vec.ctxSpec));
    const e = vec.expect;

    assert.equal(insp.kind, e.kind, 'kind');
    assert.equal(insp.severity, e.severity, 'severity');
    assert.deepEqual(codesOf(insp.warnings), (e.warnings || []).slice().sort(), 'warning codes');

    // max severity must equal the max over the fired warnings (never fabricated)
    assert.equal(insp.severity, S.maxSeverity(insp.warnings), 'severity == max(warnings)');

    if (e.fields) {
      const m = detailMap(insp.details);
      for (const [k, v] of Object.entries(e.fields)) {
        assert.equal(String(m[k]), String(v), 'detail field ' + k);
      }
    }
    if (e.checksRan) {
      for (const c of e.checksRan) assert.ok(insp.checks.ran.includes(c), 'check ran: ' + c);
    }
    if (e.checksSkipped) {
      const sk = insp.checks.skipped.map((x) => x.code);
      for (const c of e.checksSkipped) assert.ok(sk.includes(c), 'check skipped: ' + c);
    }
    // NEVER claims "safe": a clean result is warnings:[] + severity none + a
    // transparent record of which checks ran / were skipped.
    if (e.severity === 'none' && (e.warnings || []).length === 0) {
      assert.ok(Array.isArray(insp.checks.ran) && Array.isArray(insp.checks.skipped));
      assert.ok(insp.checks.ran.length + insp.checks.skipped.length > 0, 'a clean result still lists its checks');
    }
  });
}

// unlimited flag sits exactly at the threshold boundary (base-unit/BigInt exact)
test('unlimited flag: threshold boundary is exact', async () => {
  const T = S.DEFAULT_UNLIMITED_THRESHOLD;
  const at = await S.inspectTransaction({ chain: 'ethereum', to: '0xtok', data: EVM.erc20ApproveData('0x1111111111111111111111111111111111111111', T) }, {});
  const below = await S.inspectTransaction({ chain: 'ethereum', to: '0xtok', data: EVM.erc20ApproveData('0x1111111111111111111111111111111111111111', T - 1n) }, {});
  assert.ok(at.warnings.some((w) => w.code === 'unlimited-approval'), 'at threshold is unlimited');
  assert.ok(!below.warnings.some((w) => w.code === 'unlimited-approval'), 'one below threshold is NOT unlimited');
});

// ===========================================================================
// 2. APPROVAL MANAGER — revoke calldata + read-only list (audited unavailable)
// ===========================================================================
test('vector: buildRevoke emits approve(spender,0) calldata exactly', () => {
  const v = vectors.revoke;
  const tx = S.buildRevoke(v.chain, v.token, v.spender);
  assert.equal(tx.kind, v.expect.kind);
  assert.equal(tx.to, v.expect.to);
  assert.equal(tx.value, v.expect.value);
  assert.equal(tx.data, v.expect.data);
  // it reuses the EXISTING chains/evm.js builder — identical bytes
  assert.equal(tx.data, EVM.erc20ApproveData(v.spender, 0));
});

test('listApprovals: no indexer => empty list + audited unavailable note (never a fake all-clear)', async () => {
  const r = await S.listApprovals('ethereum', '0x2222222222222222222222222222222222222222', {});
  assert.deepEqual(r.approvals, []);
  assert.equal(r.available, false);
  assert.match(r.note, /NOT a safety claim/);
});

test('listApprovals: indexer rows => unlimited flag computed from the threshold', async () => {
  const MAX = (1n << 256n) - 1n;
  const indexer = {
    getApprovals: async () => ([
      { token: '0xtok', symbol: 'USDC', spender: '0x1111', allowance: MAX.toString() },
      { token: '0xtok', symbol: 'USDC', spender: '0x2222', allowance: '100' },
    ]),
  };
  const r = await S.listApprovals('ethereum', '0xowner', { indexer });
  assert.equal(r.available, true);
  assert.equal(r.approvals.length, 2);
  assert.equal(r.approvals[0].unlimited, true);
  assert.equal(r.approvals[0].allowanceBase, MAX.toString());
  assert.equal(r.approvals[1].unlimited, false);
});

test('listApprovals: indexer error => empty + audited note (fails safe, not a fake all-clear)', async () => {
  const indexer = { getApprovals: async () => { throw new Error('rate limited'); } };
  const r = await S.listApprovals('ethereum', '0xowner', { indexer });
  assert.deepEqual(r.approvals, []);
  assert.equal(r.available, false);
  assert.match(r.note, /unavailable/);
});

// ===========================================================================
// 4. PRE-SIGN GATE — danger forces an explicit confirm; fail-closed; never signs
// ===========================================================================
const SET_APPROVAL_FOR_ALL_TRUE = '0xa22cb46500000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000001';

test('presign: a danger tx is BLOCKED when no confirm handler is wired (fail closed)', async () => {
  const tx = { chain: 'ethereum', to: '0xtok', data: SET_APPROVAL_FOR_ALL_TRUE };
  await assert.rejects(() => S.presign({ tx, ctx: {} }), /danger/);
});

test('presign: a danger tx proceeds only after an explicit confirm, and a decline throws', async () => {
  const tx = { chain: 'ethereum', to: '0xtok', data: SET_APPROVAL_FOR_ALL_TRUE };
  const ok = await S.presign({ tx, ctx: {}, confirm: async () => true });
  assert.equal(ok.cleared, true);
  assert.equal(ok.inspection.severity, 'danger');
  await assert.rejects(() => S.presign({ tx, ctx: {}, confirm: async () => false }), /declined/);
});

test('presign: a clean tx passes through with no confirm required', async () => {
  const tx = { chain: 'ethereum', to: '0x2222222222222222222222222222222222222222', value: '1000' };
  const r = await S.presign({ tx, ctx: {} });
  assert.equal(r.cleared, true);
  assert.equal(r.inspection.severity, 'none');
});

// ===========================================================================
// GATE COMPOSITION — the suite composes with, never weakens, the policy gate
// ===========================================================================
test('policy.gateConfirm: forceConfirm overrides auto-approve + requireConfirm=false, never grants on its own', async () => {
  let asked = 0;
  const p = AgentPolicy.create({ autoApproveUnderUsd: 100, confirm: async () => { asked++; return true; } });
  const auto = await p.gateConfirm({}, { usd: 1 });
  assert.equal(auto.auto, true); assert.equal(asked, 0); // normally auto-approved

  const forced = await p.gateConfirm({}, { usd: 1, forceConfirm: true });
  assert.equal(forced.auto, false);
  assert.equal(forced.approved, true);
  assert.equal(asked, 1); // the human WAS asked despite being under the envelope

  // never weakens: forceConfirm with no confirm handler fails closed
  const p2 = AgentPolicy.create({ requireConfirm: false }); // would normally skip
  const g = await p2.gateConfirm({}, { forceConfirm: true });
  assert.equal(g.approved, false); // forced to confirm, no handler -> denied
});

function scripted(script) {
  let i = 0;
  return { name: 'scripted', async turn() { return script[i++] || { text: 'done' }; } };
}
function dangerInspect() {
  return {
    chain: 'ethereum', kind: 'token-approval', severity: 'danger',
    warnings: [{ code: 'approval-to-eoa', severity: 'danger', message: 'EOA spender' }],
    checks: { ran: ['approval-to-eoa'], skipped: [] },
  };
}

test('runner: a DANGER inspection forces a human confirm even within the auto-approve envelope', async () => {
  let asked = 0, broadcast = 0;
  const ctx = {
    estimateUsd: async () => 1, // well under the $100 auto-approve envelope
    buildSend: async () => ({ raw: '00', txid: 'tx', fee: '1' }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
    inspect: async () => dangerInspect(),
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ autoApproveUnderUsd: 100, confirm: async () => { asked++; return true; } });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't', name: 'send', arguments: { chain: 'ethereum', to: '0x2222222222222222222222222222222222222222', amount: '1' } }] },
      { text: 'done' },
    ]),
    tools, policy,
  });
  await runner.run('send under the envelope but dangerous');
  assert.equal(asked, 1, 'human was asked despite usd(1) <= autoApprove(100)');
  assert.equal(broadcast, 1, 'committed only after the explicit confirm');
});

test('runner: a DANGER inspection + declined confirm never commits', async () => {
  let broadcast = 0;
  const ctx = {
    estimateUsd: async () => 1,
    buildSend: async () => ({ raw: '00', txid: 'tx', fee: '1' }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
    inspect: async () => dangerInspect(),
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ autoApproveUnderUsd: 100, confirm: async () => false });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't', name: 'send', arguments: { chain: 'ethereum', to: '0x2222222222222222222222222222222222222222', amount: '1' } }] },
      { text: 'ok, cancelled' },
    ]),
    tools, policy,
  });
  await runner.run('dangerous');
  assert.equal(broadcast, 0, 'a declined danger never broadcasts');
  const toolMsg = runner.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.results[0].content, /user declined/);
});

test('runner: a THROWING inspector fails CLOSED (forces a confirm, never auto-approves)', async () => {
  let asked = 0, broadcast = 0;
  const ctx = {
    estimateUsd: async () => 1, // under the auto-approve envelope
    buildSend: async () => ({ raw: '00', txid: 'tx', fee: '1' }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
    inspect: async () => { throw new Error('indexer down'); }, // a WIRED inspector that throws
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ autoApproveUnderUsd: 100, confirm: async () => { asked++; return true; } });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't', name: 'send', arguments: { chain: 'ethereum', to: '0x2222222222222222222222222222222222222222', amount: '1' } }] },
      { text: 'done' },
    ]),
    tools, policy,
  });
  await runner.run('inspector error must not auto-approve');
  assert.equal(asked, 1, 'a wired inspector that threw still forced a human confirm (no silent auto-approve)');
  assert.equal(broadcast, 1, 'committed only after the forced confirm');
});

test('runner: a non-danger (warn) inspection does NOT force a confirm — composition only tightens', async () => {
  let asked = 0, broadcast = 0;
  const ctx = {
    estimateUsd: async () => 1,
    buildSend: async () => ({ raw: '00', txid: 'tx', fee: '1' }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
    inspect: async () => ({ chain: 'ethereum', kind: 'token-approval', severity: 'warn', warnings: [{ code: 'unlimited-approval', severity: 'warn' }], checks: { ran: [], skipped: [] } }),
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ autoApproveUnderUsd: 100, confirm: async () => { asked++; return true; } });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't', name: 'send', arguments: { chain: 'ethereum', to: '0x2222222222222222222222222222222222222222', amount: '1' } }] },
      { text: 'done' },
    ]),
    tools, policy,
  });
  await runner.run('send a warn-level tx under the envelope');
  assert.equal(asked, 0, 'a warn does not force a confirm (auto-approve still applies)');
  assert.equal(broadcast, 1);
});

test('backward compatible: no ctx.inspect wired => prepare behaves exactly as before', async () => {
  let broadcast = 0, asked = 0;
  const ctx = {
    estimateUsd: async () => 1,
    buildSend: async () => ({ raw: '00', txid: 'tx', fee: '1' }),
    broadcast: async () => { broadcast++; return { txid: 'tx', accepted: true }; },
    // no inspect
  };
  const tools = AgentTools.build(ctx);
  const policy = AgentPolicy.create({ autoApproveUnderUsd: 100, confirm: async () => { asked++; return true; } });
  const runner = AgentRunner.create({
    provider: scripted([
      { toolCalls: [{ id: 't', name: 'send', arguments: { chain: 'ethereum', to: '0x2222222222222222222222222222222222222222', amount: '1' } }] },
      { text: 'done' },
    ]),
    tools, policy,
  });
  await runner.run('send');
  assert.equal(asked, 0, 'auto-approved as before (no security inspector)');
  assert.equal(broadcast, 1);
});

// gate-composition vector sanity (the shared numbers the ports assert too)
test('vector: gateComposition scenario matches', async () => {
  const gc = vectors.gateComposition;
  const p = AgentPolicy.create({ autoApproveUnderUsd: gc.scenario.autoApproveUnderUsd, confirm: async () => true });
  const without = await p.gateConfirm({}, { usd: gc.scenario.actionUsd });
  assert.equal(without.auto, gc.expect.withoutSecurity.auto);
  let asked = 0;
  const p2 = AgentPolicy.create({ autoApproveUnderUsd: gc.scenario.autoApproveUnderUsd, confirm: async () => { asked++; return true; } });
  const forced = await p2.gateConfirm({}, { usd: gc.scenario.actionUsd, forceConfirm: gc.scenario.inspectionSeverity === 'danger' });
  assert.equal(forced.auto, gc.expect.withDangerForceConfirm.auto);
  assert.equal(asked === 1, gc.expect.withDangerForceConfirm.humanConfirmCalled);
});
