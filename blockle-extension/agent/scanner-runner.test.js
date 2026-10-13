// agent/scanner-runner.test.js — the `scanner` bot type routes its chosen Intents
// through the SAME value-moving gate as every other bot (docs/AGENT-SCAN.md §3-4):
// PAPER never broadcasts; LIVE within allocation auto-approves + commits; the hard
// allocation cap still blocks an over-allocation scanner trade; kill stops it
// instantly; the tool allowlist still governs (an unapproved/blocked tool is an
// audit note, never an ungated trade); a DANGER-severity pre-sign still forces a
// confirm (declined => no broadcast); the mainnet gate still refuses a mainnet
// trade. No synthetic prices.
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AgentPolicy = require('./policy.js');
const AgentAudit = require('./audit.js');
const AgentRunner = require('./runner.js');
const AgentBots = require('./bots.js');
const AgentBotRunner = require('./bot-runner.js');
const AgentScanner = require('./scanner.js');
const AgentStrategies = require('./strategies.js');

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'scan-vectors.json'), 'utf8'));
const UNIVERSE = VEC.scanner.universe;
const SCANNER_CFG = VEC.scanner.config;

// A value-moving tools registry whose commit() counts broadcasts. A tool can be
// told to force a DANGER confirm for a given `to` symbol (security pre-sign).
function fakeTools(opts) {
  opts = opts || {};
  const state = { commits: 0, committed: [] };
  const mk = (name) => ({
    name, valueMoving: true,
    async prepare(a) {
      const from = a.from || a.asset || 'X';
      const usd = 1000; // every vector leg is ~$1000
      const danger = opts.dangerTo && a.to === opts.dangerTo;
      return {
        summary: { action: name, from, to: a.to, amount: a.amount, venue: a.venue },
        value: { asset: from, amount: a.amount || '0', usd },
        forceConfirm: danger,
        security: danger ? { severity: 'danger', warnings: [{ code: 'known-drainer' }] } : null,
        commit: async () => { state.commits++; state.committed.push({ name, args: a }); return { txid: 'tx' + state.commits, accepted: true }; },
      };
    },
  });
  const map = { swap: mk('swap'), place_order: mk('place_order'), cancel_order: mk('cancel_order') };
  return { state, get: (n) => map[n] || null, names: () => Object.keys(map), valueMovingNames: () => Object.keys(map) };
}

function mkCtx(extra) {
  return Object.assign({
    _t: 0,
    now() { return this._t; },
    network() { return 'testnet'; },
    async scanUniverse() { return UNIVERSE; },
  }, extra || {});
}

function setup(opts) {
  opts = opts || {};
  const audit = AgentAudit.create({});
  const policy = AgentPolicy.create({ caps: { sessionUsd: opts.sessionUsd != null ? opts.sessionUsd : 100000 }, confirm: opts.confirm, audit, onKill: opts.onKill });
  const tools = opts.tools || fakeTools();
  policy.setAllowlist(opts.allowlist || tools.names());
  const runner = AgentBotRunner.create({
    policy, tools, audit, ctx: opts.ctx || mkCtx(), AgentRunner, Bots: AgentBots,
    Scanner: AgentScanner, Strategies: AgentStrategies,
    mainnetEnabled: opts.mainnetEnabled === true,
  });
  return { runner, policy, tools, audit };
}

function addScanner(runner, overrides) {
  return runner.add(Object.assign({ type: 'scanner', config: Object.assign({}, SCANNER_CFG) }, overrides || {}));
}

const auditTypes = (audit, type) => audit.list().filter((e) => e.type === type);

// ===========================================================================
// PAPER: the scanner scans + records paper intents but NEVER broadcasts
// ===========================================================================
test('scanner PAPER: scans the worthy pairs but never broadcasts', async () => {
  const { runner, tools, audit } = setup();
  const bot = addScanner(runner);
  bot.mode = 'paper'; bot.enabled = true;

  const report = await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 0, 'PAPER must never broadcast');
  assert.ok(auditTypes(audit, 'scanner_scan').length === 1, 'the scan was recorded');
  assert.ok(auditTypes(audit, 'bot_paper_intent').length === 3, 'the 3 worthy Intents were simulated (paper)');
  assert.deepEqual(report.scan.worthy, ['MOM/USDC', 'ETH/USDC']);
});

// ===========================================================================
// LIVE within allocation: auto-approves + broadcasts the worthy pairs' Intents
// ===========================================================================
test('scanner LIVE within allocation: the worthy pairs broadcast through the ONE gate', async () => {
  let asked = 0;
  const { runner, tools } = setup({ confirm: async () => { asked++; return true; } });
  const bot = addScanner(runner);
  await runner.armLive(bot.id, { allocationUsd: 5000 });

  await runner.tickBot(bot.id);
  assert.equal(asked, 0, 'within allocation auto-approves — confirm is NOT asked');
  assert.equal(tools.state.commits, 3, 'MOM buy + ETH arb buy + ETH arb sell all broadcast');
});

// ===========================================================================
// ALLOCATION CAP: an over-allocation scanner trade is refused exactly like any bot
// ===========================================================================
test('scanner allocation cap: a worthy pair that does not fit is NOT traded (audited skipped:allocation downstream)', async () => {
  const { runner, tools, audit } = setup();
  const bot = addScanner(runner);
  // ~$1000.5 room: the scanner selects only MOM ($1000.5); ETH ($2001) is skipped
  // at selection — and the ledger would block it at dispatch regardless.
  await runner.armLive(bot.id, { allocationUsd: 1200 });

  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 1, 'only the pair that fits the allocation broadcast');
  assert.equal(tools.state.committed[0].args.to, 'MOM');
  const scan = auditTypes(audit, 'scanner_scan')[0];
  assert.ok(scan.skipped.some((s) => s === 'ETH/USDC:allocation'), 'ETH skipped for allocation at scan time');
});

// ===========================================================================
// KILL: stops the scanner instantly — no scan, no broadcast
// ===========================================================================
test('scanner KILL: a killed runner never scans or trades', async () => {
  const { runner, tools, audit } = setup();
  const bot = addScanner(runner);
  await runner.armLive(bot.id, { allocationUsd: 5000 });
  await runner.killAll('test');

  const report = await runner.tickBot(bot.id);
  assert.equal(report.skipped, 'disabled');
  assert.equal(tools.state.commits, 0, 'kill blocks all scanner trades');
  assert.equal(auditTypes(audit, 'scanner_scan').length, 0, 'no scan ran after kill');
});

// ===========================================================================
// ALLOWLIST: an un-allowlisted tool is an audit note, never an ungated trade
// ===========================================================================
test('scanner allowlist: a worthy pair whose tool is not allowlisted is blocked, never traded', async () => {
  const { runner, tools, audit } = setup({ allowlist: ['cancel_order'] }); // swap NOT allowed
  const bot = addScanner(runner);
  await runner.armLive(bot.id, { allocationUsd: 5000 });

  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 0, 'no ungated trade when the tool is off the allowlist');
  assert.ok(auditTypes(audit, 'bot_blocked').length >= 1, 'blocked audit note recorded');
});

// ===========================================================================
// DANGER pre-sign: a danger forces a confirm; declined => no broadcast
// ===========================================================================
test('scanner danger pre-sign: a DANGER inspection forces a confirm and a decline blocks the trade', async () => {
  // the MOM buy targets `to: MOM` — mark it dangerous; confirm handler declines.
  let asked = 0;
  const tools = fakeTools({ dangerTo: 'MOM' });
  const { runner, audit } = setup({ tools, confirm: async () => { asked++; return false; } });
  const bot = addScanner(runner);
  await runner.armLive(bot.id, { allocationUsd: 5000 });

  await runner.tickBot(bot.id);
  assert.ok(asked >= 1, 'the danger forced an explicit confirm even within allocation');
  // the dangerous MOM leg was declined; only the non-dangerous ETH arb legs commit.
  assert.ok(!tools.state.committed.some((c) => c.args.to === 'MOM'), 'the declined dangerous trade never broadcast');
  assert.ok(auditTypes(audit, 'security_inspection').some((e) => e.severity === 'danger'), 'the danger was audited');
});

// ===========================================================================
// MAINNET gate: a mainnet scanner trade is refused when mainnetEnabled=false
// ===========================================================================
test('scanner mainnet gate: a mainnet-context scanner never trades when the mainnet gate is off', async () => {
  const ctx = mkCtx({ network() { return 'mainnet'; } });
  const { runner, tools, audit } = setup({ ctx, mainnetEnabled: false });
  const bot = addScanner(runner);
  await runner.armLive(bot.id, { allocationUsd: 5000 }).catch(() => {});
  // armLive on a testnet-default bot is fine; the mainnet CONTEXT drives the skip.
  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 0, 'no mainnet trade with the mainnet gate off');
  assert.ok(auditTypes(audit, 'bot_skip').some((e) => e.reason === 'mainnet'));
});
