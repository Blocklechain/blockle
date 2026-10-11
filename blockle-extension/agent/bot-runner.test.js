// agent/bot-runner.test.js — the BotRunner routes bot orders through the SAME
// value-moving gate as the NL runner + StrategyRunner. The important tests
// (docs/BLOCKLE-BOTS.md §5-7): the FULLY-AUTO-WITHIN-ALLOCATION gate is
// non-bypassable — a live order that would exceed allocationUsd does NOT fire and
// is NEVER prompted (audited skipped:allocation); arming live without a finite
// allocation (<= the session cap) fails closed; kill stops ALL bots + locks the
// vault; PAPER never broadcasts; a mainnet bot is refused when mainnetEnabled=false.
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');

const AgentPolicy = require('./policy.js');
const AgentAudit = require('./audit.js');
const AgentRunner = require('./runner.js');
const AgentBots = require('./bots.js');
const AgentBotRunner = require('./bot-runner.js');
const AgentBotTemplates = require('./bot-templates.js');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// A value-moving tools registry whose commit() counts broadcasts. It derives a
// USD value from the amount (stable `from` => amount/1e6, else amount/1e8) so the
// policy's USD-cap + auto-approve path exercises exactly as with the real swap.
function fakeTools() {
  const state = { commits: 0, committed: [] };
  const STABLE = new Set(['USDC', 'USDT', 'DAI', 'USD']);
  const mk = (name) => ({
    name, valueMoving: true,
    async prepare(a) {
      const from = a.from || a.asset || 'X';
      const amt = a.amount != null ? Number(a.amount) : 0;
      const usd = STABLE.has(String(from).toUpperCase()) ? amt / 1e6 : amt / 1e8;
      return {
        summary: { action: name, from, to: a.to, amount: a.amount, venue: a.venue },
        value: { asset: from, amount: a.amount || '0', usd },
        commit: async () => { state.commits++; state.committed.push({ name, args: a, usd }); return { txid: 'tx' + state.commits, accepted: true, orderId: name === 'place_order' ? 'ord' + state.commits : undefined }; },
      };
    },
  });
  const map = { swap: mk('swap'), place_order: mk('place_order'), cancel_order: mk('cancel_order') };
  return { state, get: (n) => map[n] || null, names: () => Object.keys(map), valueMovingNames: () => Object.keys(map) };
}

function mkCtx(priceSeq) {
  let i = 0;
  const marks = priceSeq.slice();
  return {
    _t: 0,
    now() { return this._t; },
    network() { return 'testnet'; },
    async prices() { const p = marks[Math.min(i, marks.length - 1)]; i++; return { BLOCK: p, USDC: 1 }; },
  };
}

function setup(opts) {
  opts = opts || {};
  const audit = AgentAudit.create({});
  const sessionUsd = ('sessionUsd' in opts) ? opts.sessionUsd : 1000; // explicit null means "no cap"
  const policy = AgentPolicy.create({ caps: { sessionUsd }, confirm: opts.confirm, audit, onKill: opts.onKill });
  const tools = fakeTools();
  policy.setAllowlist(tools.names());
  const runner = AgentBotRunner.create({
    policy, tools, audit, ctx: opts.ctx || mkCtx([100]), AgentRunner, Bots: AgentBots,
    mainnetEnabled: opts.mainnetEnabled === true, discovery: opts.discovery || null,
  });
  return { runner, policy, tools, audit };
}

const skips = (audit, reason) => audit.list().filter((e) => e.type === 'bot_skip' && e.reason === reason);

// ===========================================================================
// PAPER mode never broadcasts (and still records a simulated deal + pnl)
// ===========================================================================
test('paper: a DCA bot fills simulated at the quote and NEVER broadcasts', async () => {
  const ctx = mkCtx([100, 90, 97]); // base @100, SO @90 (trigger 98), TP @97 (avg ~94.74, target ~96.63)
  const { runner, tools, audit } = setup({ ctx });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 100, safetyOrderUsd: 100, maxSafetyOrders: 1, safetyStepPct: 2, takeProfitPct: 2 } });
  bot.mode = 'paper'; bot.enabled = true;

  await runner.tickBot(bot.id); // base order
  await runner.tickBot(bot.id); // safety order
  await runner.tickBot(bot.id); // take-profit close

  assert.equal(tools.state.commits, 0, 'PAPER must never broadcast');
  assert.ok(audit.list().some((e) => e.type === 'bot_paper_fill'), 'simulated fills were recorded + tagged paper');
  const d = runner.dashboard(bot.id, { BLOCK: 94.2 });
  assert.equal(d.mode, 'paper');
  assert.ok(d.totalDeals >= 1, 'a simulated deal completed');
});

// ===========================================================================
// LIVE within allocation: auto-approves through the ONE gate (no prompt), commits
// ===========================================================================
test('live within allocation: order auto-approves via policy.autoApproveUnderUsd (no confirm asked) and commits', async () => {
  let asked = 0;
  const ctx = mkCtx([100]);
  const { runner, tools } = setup({ ctx, sessionUsd: 1000, confirm: async () => { asked++; return true; } });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 20, maxSafetyOrders: 0, takeProfitPct: 5 } });
  await runner.armLive(bot.id, { allocationUsd: 50 });

  await runner.tickBot(bot.id); // base order $20 <= remaining $50 -> auto
  assert.equal(asked, 0, 'within allocation auto-approves — confirm is NOT asked');
  assert.equal(tools.state.commits, 1, 'the base order broadcast through the ONE dispatch');
  const d = runner.dashboard(bot.id, { BLOCK: 100 });
  assert.equal(Math.round(d.committedUsd), 20, 'committed-spend ledger accrued the broadcast order');
  assert.equal(Math.round(d.remainingUsd), 30);
});

// ===========================================================================
// ALLOCATION GATE (critical): an order over remaining allocation does NOT fire,
// is NEVER prompted, and is audited skipped:allocation
// ===========================================================================
test('allocation gate: a live order exceeding remaining allocation is refused (never prompted, audited skipped:allocation)', async () => {
  let asked = 0;
  const ctx = mkCtx([100, 90]); // base @100 then a dip to 90 (triggers a safety order)
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000, confirm: async () => { asked++; return true; } });
  // base $8 fits in $10 alloc; the $5 safety order would push to $13 > $10 -> refused
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 8, safetyOrderUsd: 5, maxSafetyOrders: 3, safetyStepPct: 2, takeProfitPct: 50 } });
  await runner.armLive(bot.id, { allocationUsd: 10 });

  await runner.tickBot(bot.id); // base $8 -> commits (auto)
  await runner.tickBot(bot.id); // safety $5 -> would exceed $10 -> skipped:allocation

  assert.equal(tools.state.commits, 1, 'only the base order fired; the over-allocation safety order did not');
  assert.equal(asked, 0, 'the refused order was NEVER prompted');
  assert.equal(skips(audit, 'allocation').length, 1, 'audited skipped:allocation');
  const d = runner.dashboard(bot.id, { BLOCK: 90 });
  assert.equal(Math.round(d.committedUsd), 8, 'committed-spend did not move for the refused order');
});

test('allocation gate: the backstop holds even if a confirm handler would say yes', async () => {
  // Even with autoApprove defaulting low, the BotRunner pre-check refuses the
  // over-allocation order BEFORE any dispatch — confirm is never reached.
  const ctx = mkCtx([100, 90]);
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000, confirm: async () => true });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 8, safetyOrderUsd: 5, maxSafetyOrders: 3, safetyStepPct: 2, takeProfitPct: 50 } });
  await runner.armLive(bot.id, { allocationUsd: 10 });
  await runner.tickBot(bot.id);
  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 1);
  assert.equal(skips(audit, 'allocation').length, 1);
});

// ===========================================================================
// Arming a LIVE bot fails closed without a finite allocation <= session cap
// ===========================================================================
test('arm live: fails closed when allocationUsd <= 0', async () => {
  const { runner } = setup({ sessionUsd: 1000 });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] } });
  await assert.rejects(() => runner.armLive(bot.id, { allocationUsd: 0 }), /allocationUsd must be > 0/);
  assert.equal(bot.mode, 'paper'); // unchanged
  assert.equal(bot.enabled, false);
});

test('arm live: fails closed when there is no policy session USD cap', async () => {
  const { runner } = setup({ sessionUsd: null });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] } });
  await assert.rejects(() => runner.armLive(bot.id, { allocationUsd: 50 }), /session USD cap is required/);
});

test('arm live: fails closed when allocationUsd exceeds the session cap', async () => {
  const { runner } = setup({ sessionUsd: 50 });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] } });
  await assert.rejects(() => runner.armLive(bot.id, { allocationUsd: 100 }), /exceeds the policy session cap/);
});

test('arm live: fails closed on a mainnet bot when mainnetEnabled=false', async () => {
  const { runner } = setup({ sessionUsd: 1000, mainnetEnabled: false });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, network: 'mainnet' });
  await assert.rejects(() => runner.armLive(bot.id, { allocationUsd: 50 }), /mainnet/);
});

// ===========================================================================
// mainnet gate: a live mainnet bot's order is refused when mainnetEnabled=false
// ===========================================================================
test('mainnet gate: a live mainnet bot order does not fire when mainnetEnabled=false', async () => {
  const ctx = mkCtx([100]);
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000, mainnetEnabled: false, confirm: async () => true });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 20, maxSafetyOrders: 0 } });
  // force a live mainnet bot directly (arming would fail closed — that's tested above)
  bot.mode = 'live'; bot.enabled = true; bot.network = 'mainnet'; bot.allocationUsd = 50;
  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 0, 'nothing broadcast on mainnet with the gate off');
  assert.equal(skips(audit, 'mainnet').length, 1, 'audited skipped:mainnet');
});

// ===========================================================================
// KILL: stops ALL bots, (best-effort) cancels orders, and locks the vault
// ===========================================================================
test('kill: stops all bots, blocks further commits, and locks the vault via policy.kill', async () => {
  let vaultLocked = false;
  const ctx = mkCtx([100]);
  const { runner, policy, tools } = setup({ ctx, sessionUsd: 1000, confirm: async () => true, onKill: async () => { vaultLocked = true; } });
  const a = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 20, maxSafetyOrders: 0 } });
  const b = runner.add({ type: 'grid', universe: { pairs: ['BLOCK/USDC'] }, config: { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 4, totalUsd: 40 } });
  await runner.armLive(a.id, { allocationUsd: 50 });
  await runner.enablePaper(b.id);

  await runner.killAll('panic');

  assert.equal(policy.isKilled(), true, 'policy kill fired');
  assert.equal(vaultLocked, true, 'the vault was locked (keys + LLM cred wiped)');
  assert.equal(a.enabled, false);
  assert.equal(b.enabled, false);
  const commitsBefore = tools.state.commits;
  const r = await runner.tickBot(a.id); // a tick after kill must not broadcast
  assert.equal(tools.state.commits, commitsBefore, 'no commit after kill');
  assert.ok(r.killed || r.skipped, 'tick is a no-op after kill');
});

// ===========================================================================
// import lands paper + disabled (and never auto-armed) — at the runner boundary
// ===========================================================================
test('import: a template added to the runner lands paper + disabled + zero allocation', async () => {
  const { runner, tools } = setup({ sessionUsd: 1000 });
  const tpl = { kind: 'blockle-bot-template', type: 'dca', name: 'x', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 20 }, mode: 'live', enabled: true, allocationUsd: 999 };
  const bot = AgentBotTemplates.importTemplate(tpl);
  runner.add(bot);
  assert.equal(bot.mode, 'paper');
  assert.equal(bot.enabled, false);
  assert.equal(bot.allocationUsd, 0);
  // a disabled bot is never ticked by tickAll
  await runner.tickAll();
  assert.equal(tools.state.commits, 0);
});

// ===========================================================================
// signal bot: consumes the discovery feed and spawns a template per signal
// (still paper here => no broadcast)
// ===========================================================================
test('signal bot: an approved discovery candidate spawns a paper DCA deal (no broadcast)', async () => {
  const ctx = mkCtx([100, 100, 100]);
  const discovery = { async scan() { return [{ pair: 'BLOCK/USDC', approved: true, score: 0.9 }, { pair: 'SCAM/USDC', approved: false, score: 0.9 }]; } };
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000, discovery });
  const bot = runner.add({ type: 'signal', config: { source: 'discovery', maxConcurrent: 2, onSignal: { type: 'dca', config: { baseOrderUsd: 10, maxSafetyOrders: 0 } } } });
  bot.mode = 'paper'; bot.enabled = true;
  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 0, 'paper signal bot never broadcasts');
  assert.ok(audit.list().some((e) => e.type === 'bot_signal' && e.pair === 'BLOCK/USDC'), 'the approved candidate armed a spawned deal');
  assert.ok(!audit.list().some((e) => e.type === 'bot_signal' && e.pair === 'SCAM/USDC'), 'the UNapproved candidate did NOT');
});

// ===========================================================================
// no synthetic prices: a missing mark skips the tick (audited)
// ===========================================================================
test('no synthetic prices: a bot with no mark skips the tick, audited', async () => {
  const ctx = { _t: 0, now() { return 0; }, network() { return 'testnet'; }, async prices() { return {}; } };
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000 });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 20 } });
  bot.mode = 'paper'; bot.enabled = true;
  await runner.tickBot(bot.id);
  assert.equal(tools.state.commits, 0);
  assert.ok(skips(audit, 'price').length >= 1, 'skipped:price recorded; no fabricated mark');
});

// ===========================================================================
// FIX-GRID: grid bots fill end-to-end (paper) — a buy level now simulates a fill
// instead of throwing (it used to read order.usdSizeUc, which a grid buy lacks).
// ===========================================================================
test('grid (paper): a buy level fills simulated at the level and NEVER broadcasts (FIX-GRID)', async () => {
  const ctx = mkCtx([1.00, 0.95]); // seed the ladder at mid 1.00, then dip to 0.95
  const { runner, tools, audit } = setup({ ctx });
  const bot = runner.add({ type: 'grid', universe: { pairs: ['BLOCK/USDC'] }, config: { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 4, totalUsd: 40 } });
  bot.mode = 'paper'; bot.enabled = true;

  await runner.tickBot(bot.id); // seeds the ladder (mid 1.00, no fill)
  await runner.tickBot(bot.id); // dip to 0.95 -> a grid BUY fills (used to throw -> bot_error)

  assert.equal(tools.state.commits, 0, 'PAPER grid never broadcasts');
  assert.ok(!audit.list().some((e) => e.type === 'bot_error'), 'a grid buy no longer throws + is swallowed as bot_error');
  assert.ok(audit.list().some((e) => e.type === 'bot_paper_fill' && e.side === 'buy' && e.kind === 'grid'), 'a grid buy simulated a fill');
  const ps = bot.state.byPair['BLOCK/USDC'];
  assert.ok(ps.deal.levels.some((l) => l.heldQty > 0n), 'inventory is held on the armed sell one grid up');
});

// ===========================================================================
// FIX-GRID + allocation: a LIVE grid routes through the ONE dispatch and can
// never spend past allocationUsd (the same hard cap DCA respects).
// ===========================================================================
test('grid (live): routes through the ONE dispatch and cannot exceed allocationUsd (FIX-GRID)', async () => {
  const ctx = mkCtx([1.00, 0.80]); // seed at 1.00, then crash: every buy level is fillable
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000, confirm: async () => true });
  const bot = runner.add({ type: 'grid', universe: { pairs: ['BLOCK/USDC'] }, config: { lowerPrice: 0.80, upperPrice: 1.20, gridCount: 10, totalUsd: 100 } });
  await runner.armLive(bot.id, { allocationUsd: 25 }); // only ~2 x $10 levels fit

  await runner.tickBot(bot.id); // seed ladder (mid 1.00)
  await runner.tickBot(bot.id); // crash: fill until allocation is exhausted, then refuse

  assert.ok(tools.state.commits >= 1, 'a live grid buy broadcast through place_order');
  assert.ok(tools.state.committed.every((c) => c.name === 'place_order'), 'every grid order went through the ONE value-moving dispatch (place_order)');
  const d = runner.dashboard(bot.id, { BLOCK: 0.80 });
  assert.ok(d.committedUsd <= 25 + 1e-9, 'cumulative live spend never exceeds allocationUsd, got ' + d.committedUsd);
  assert.ok(skips(audit, 'allocation').length >= 1, 'an over-allocation level was refused (audited skipped:allocation)');
});

// ===========================================================================
// FIX-ALLOC-FEE: the committed-spend ledger bounds the TRUE outflow = trade +
// the mandatory 0.05% agent fee (checked before firing, accrued after broadcast).
// ===========================================================================
test('allocation ledger accrues trade + the 0.05% agent fee, not the trade alone (FIX-ALLOC-FEE)', async () => {
  const ctx = mkCtx([100]);
  const { runner, tools } = setup({ ctx, sessionUsd: 1000 });
  const bot = runner.add({ type: 'dca', universe: { pairs: ['BLOCK/USDC'] }, config: { baseOrderUsd: 200, maxSafetyOrders: 0, takeProfitPct: 50 } });
  await runner.armLive(bot.id, { allocationUsd: 300 });

  await runner.tickBot(bot.id); // base $200 + 0.05% fee ($0.10) -> committed $200.10
  assert.equal(tools.state.commits, 1);
  const d = runner.dashboard(bot.id, { BLOCK: 100 });
  assert.ok(Math.abs(d.committedUsd - 200.10) < 1e-6, 'committed = trade + fee ($200.10), got ' + d.committedUsd);
  assert.ok(Math.abs(d.remainingUsd - 99.90) < 1e-6, 'remaining reflects trade + fee, got ' + d.remainingUsd);
});

// ===========================================================================
// FIX-CANCEL: a LIVE fill records its exchange orderId onto the level, and KILL
// cancels it through the ONE audited dispatch (never a bare prepare().commit()).
// ===========================================================================
test('kill: a live grid fill records an orderId and kill cancels it through the ONE gate (FIX-CANCEL)', async () => {
  const ctx = mkCtx([1.00, 0.95]);
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000, confirm: async () => true, onKill: async () => {} });
  const bot = runner.add({ type: 'grid', universe: { pairs: ['BLOCK/USDC'] }, config: { lowerPrice: 0.9, upperPrice: 1.1, gridCount: 4, totalUsd: 40 } });
  await runner.armLive(bot.id, { allocationUsd: 50 });

  await runner.tickBot(bot.id); // seed ladder
  await runner.tickBot(bot.id); // a buy level fills LIVE via place_order -> orderId recorded

  const ps = bot.state.byPair['BLOCK/USDC'];
  const withId = ps.deal.levels.filter((l) => l.orderId);
  assert.ok(withId.length >= 1, 'the live fill STORED its exchange orderId onto the level (was never written before)');
  const orderId = withId[0].orderId;

  const commitsBefore = tools.state.commits;
  await runner.killAll('panic');

  assert.ok(audit.list().some((e) => e.type === 'bot_dispatch' && e.tool === 'cancel_order'), 'the cancel routed through the ONE audited dispatch (not a bare prepare().commit())');
  assert.ok(tools.state.committed.some((c) => c.name === 'cancel_order' && c.args.orderId === orderId), 'kill cancelled exactly the recorded orderId');
  assert.ok(tools.state.commits > commitsBefore, 'the cancel went through the one shared commit path');
});

// ===========================================================================
// FIX-EST: a LIVE scheduled-strategy order with NO usd estimate must FAIL CLOSED
// (null estUsd must NOT be treated as $0, which would pass the cap + accrue nothing).
// ===========================================================================
test('scheduled (live): a null USD estimate fails closed (skipped:allocation-unknown); a finite one accrues trade+fee (FIX-EST)', async () => {
  const ctx = mkCtx([100]);
  const Strategies = {
    createRegistry() {
      return {
        get(type) {
          if (type !== 'momentum') return null;
          return {
            validateParams: (p) => p,
            async plan() {
              return [
                { tool: 'swap', args: { from: 'USDC', to: 'BLOCK', amount: '1' }, tag: 'no-est', estUsd: null, mainnet: false },
                { tool: 'swap', args: { from: 'USDC', to: 'BLOCK', amount: '9' }, tag: 'neg-est', estUsd: -1000, mainnet: false },
                { tool: 'swap', args: { from: 'USDC', to: 'BLOCK', amount: '9' }, tag: 'nan-est', estUsd: NaN, mainnet: false },
                { tool: 'swap', args: { from: 'USDC', to: 'BLOCK', amount: '2' }, tag: 'has-est', estUsd: 10, mainnet: false },
              ];
            },
          };
        },
      };
    },
  };
  const { runner, tools, audit } = setup({ ctx, sessionUsd: 1000 });
  runner.Strategies = Strategies;
  const bot = runner.add({ type: 'momentum', universe: { pairs: ['BLOCK/USDC'] }, config: {} });
  await runner.armLive(bot.id, { allocationUsd: 100 });

  const rep = await runner.tickBot(bot.id);
  const ev = rep.events;
  assert.ok(ev.some((e) => e.tag === 'no-est' && e.skipped === 'allocation-unknown'), 'the null-estimate order failed closed (not treated as $0)');
  assert.ok(ev.some((e) => e.tag === 'neg-est' && e.skipped === 'allocation-unknown'), 'a NEGATIVE estimate fails closed (must not accrue negative + expand the ledger)');
  assert.ok(ev.some((e) => e.tag === 'nan-est' && e.skipped === 'allocation-unknown'), 'a non-finite (NaN) estimate fails closed (must not coerce to $0)');
  assert.ok(ev.some((e) => e.tag === 'has-est' && e.executed), 'the finite-estimate order executed');
  assert.equal(skips(audit, 'allocation-unknown').length, 3, 'audited skipped:allocation-unknown x3');
  assert.equal(tools.state.commits, 1, 'only the finite-estimate order broadcast');
  const d = runner.dashboard(bot.id, { BLOCK: 100 });
  assert.ok(Math.abs(d.committedUsd - 10.005) < 1e-6, 'only the finite order accrued (trade $10 + fee $0.005), got ' + d.committedUsd);
});
