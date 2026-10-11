// agent/arena.test.js — the Blockle ARENA (arena.js), the play-money gamified
// sandbox (docs/BLOCKLE-BOTS.md §9). Proves:
//   • an Arena run NEVER touches commit/broadcast/gate/reserve (spies stay at 0);
//     arena.js structurally depends only on the PURE deal engine + templates.
//   • PLAY funds can never convert/withdraw/exchange for anything real.
//   • the canonical (scenario, botConfig) -> score vectors match the shared
//     fixture docs/arena-vectors.json EXACTLY (byte-for-byte integer math).
//   • the score penalizes drawdown: a reckless high-return/high-DD run scores
//     BELOW a steadier one.
//   • "use this for real" yields a paper + disabled + testnet bot (never auto-live).
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const A = require('./arena.js');
const B = require('./bots.js');
const T = require('./bot-templates.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/arena-vectors.json'), 'utf8'));

// ===========================================================================
// honesty + labels
// ===========================================================================
test('disclaimer is a persistent, honest, non-empty constant', () => {
  assert.equal(typeof A.DISCLAIMER, 'string');
  assert.ok(A.DISCLAIMER.toLowerCase().includes('simulation'));
  assert.ok(A.DISCLAIMER.toLowerCase().includes('not financial advice'));
  assert.equal(A.DISCLAIMER, V.disclaimer);
  assert.equal(A.PLAY_LABEL, 'PLAY');
  assert.equal(A.DEFAULT_GRANT, 10000);
  assert.equal(A.SIMULATION_ONLY, true);
});

// ===========================================================================
// PLAY balance can NEVER become real
// ===========================================================================
test('PlayBalance starts at the labeled grant and can never convert to real', () => {
  const pb = new A.PlayBalance();
  assert.equal(pb.label, 'PLAY');
  assert.equal(pb.real, false);
  assert.equal(pb.convertible, false);
  assert.equal(pb.grantUc.toString(), B.microUsd(10000).toString());
  assert.equal(pb.balanceUc.toString(), B.microUsd(10000).toString());
  // the three real-world off-ramps all throw — structurally impossible to exit.
  assert.throws(() => pb.convertToReal(), /never be converted/);
  assert.throws(() => pb.withdraw(), /never be converted/);
  assert.throws(() => pb.exchange(), /never be converted/);
  // custom grant is labeled + virtual too
  const pb2 = new A.PlayBalance(500);
  assert.equal(pb2.grantUc.toString(), B.microUsd(500).toString());
  assert.equal(pb2.toJSON().real, false);
  assert.equal(pb2.toJSON().convertible, false);
});

test('applying play PnL moves only the PLAY balance; it is never real money', () => {
  const pb = new A.PlayBalance(1000);
  pb.applyPnl(B.microUsd(250));
  assert.equal(pb.balanceUc.toString(), B.microUsd(1250).toString());
  pb.applyPnl(-B.microUsd(400));
  assert.equal(pb.balanceUc.toString(), B.microUsd(850).toString());
  assert.equal(pb.real, false);
});

// ===========================================================================
// STRUCTURAL safety — Arena never calls commit/broadcast/gate/reserve
// ===========================================================================
test('arena.js depends ONLY on the pure engine + templates (no runner/gate/broadcast)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'arena.js'), 'utf8');
  // it must not pull in the live dispatch / gate / runner modules
  assert.ok(!/require\(['"]\.\/bot-runner/.test(src), 'arena must not require bot-runner');
  assert.ok(!/require\(['"]\.\/runner/.test(src), 'arena must not require runner');
  assert.ok(!/require\(['"]\.\/policy/.test(src), 'arena must not require policy');
  assert.ok(!/require\(['"]\.\/tools/.test(src), 'arena must not require tools');
  // and it must expose no commit/broadcast/reserve surface
  for (const k of Object.keys(A)) {
    assert.ok(!/commit|broadcast|reserve|dispatch/i.test(k), 'arena exposes no gate surface: ' + k);
  }
});

test('an Arena run never invokes any commit/broadcast/gate/recordSpend/reserve spy', () => {
  // Poison the environment: pass spies for every value-moving fn. Arena has no
  // code path to them, so each must stay at ZERO calls.
  const calls = { commit: 0, broadcast: 0, gateConfirm: 0, recordSpend: 0, reserve: 0, dispatch: 0, sign: 0 };
  const guard = {};
  for (const k of Object.keys(calls)) guard[k] = () => { calls[k]++; throw new Error('Arena must never call ' + k); };

  const prof = new A.ArenaProfile();
  for (const scenario of A.SCENARIOS) {
    prof.run({ scenario, vectors: V, bot: { type: 'dca', config: V.canonical[0].botConfig, pair: 'BLOCK/USDC', decimals: 8 }, guard });
  }
  for (const k of Object.keys(calls)) assert.equal(calls[k], 0, k + ' was called');
  // every run is labeled PLAY and not real
  assert.equal(prof.playBalance.real, false);
});

// ===========================================================================
// scenario feed — loaded from the authoritative fixture (not RNG-regenerated)
// ===========================================================================
test('scenario paths load from the shared fixture (5 scenarios, ~120 pts each)', () => {
  const paths = A.loadScenarios(V);
  assert.deepEqual(Object.keys(paths).sort(), A.SCENARIOS.slice().sort());
  for (const s of A.SCENARIOS) {
    assert.ok(Array.isArray(paths[s]) && paths[s].length >= 100, s + ' has a full path');
    assert.deepEqual(A.pricePath(V, s), V.scenarios[s]);
  }
});

// ===========================================================================
// CANONICAL score vectors — identical integer math across all three wallets
// ===========================================================================
test('canonical (scenario, botConfig) -> score vectors match the fixture EXACTLY', () => {
  assert.ok(V.canonical.length >= 1, 'fixture has at least one canonical vector');
  for (const vec of V.canonical) {
    const res = A.runScenario({
      scenario: vec.scenario, prices: V.scenarios[vec.scenario],
      bot: { type: vec.type, config: vec.botConfig, pair: vec.pair, decimals: vec.decimals },
    });
    assert.strictEqual(res.score, vec.expectedScore, vec.scenario + ' score');
    assert.strictEqual(res.scoreTenths.toString(), vec.expectedScoreTenths, vec.scenario + ' scoreTenths');
    assert.strictEqual(res.finalPnlUc.toString(), vec.expectedPnlUc, vec.scenario + ' pnlUc');
    assert.strictEqual(res.maxDrawdownUc.toString(), vec.expectedMaxDdUc, vec.scenario + ' maxDdUc');
    assert.strictEqual(res.maxCostBasisUc.toString(), vec.expectedMaxCostBasisUc, vec.scenario + ' maxCostBasisUc');
    assert.strictEqual(res.fills.length, vec.expectedFillCount, vec.scenario + ' fillCount');
    assert.strictEqual(res.dealCount, vec.expectedDealCount, vec.scenario + ' dealCount');
  }
});

test('score formula is the pinned round1(retPct - 0.5*ddPct) integer math', () => {
  // +10% return, 0 drawdown -> 10.0
  assert.deepEqual(A.score(B.microUsd(100), 0n, B.microUsd(1000)), { scoreTenths: 100n, score: 10 });
  // +10% return, 20% drawdown -> 10 - 0.5*20 = 0.0
  assert.deepEqual(A.score(B.microUsd(100), B.microUsd(200), B.microUsd(1000)), { scoreTenths: 0n, score: 0 });
  // -5% return, 10% drawdown -> -5 - 5 = -10.0
  assert.deepEqual(A.score(-B.microUsd(50), B.microUsd(100), B.microUsd(1000)), { scoreTenths: -100n, score: -10 });
  // no capital deployed -> 0 (no division by zero)
  assert.deepEqual(A.score(0n, 0n, 0n), { scoreTenths: 0n, score: 0 });
  // half-away-from-zero rounding to tenths: ret 3.33% -> 3.3
  const r = A.score(B.microUsd(100), 0n, B.microUsd(3000));
  assert.equal(r.score, 3.3);
});

// ===========================================================================
// the score PENALIZES DRAWDOWN — reckless high-DD scores below steady
// ===========================================================================
test('a reckless high-return/high-DD run scores BELOW a steadier one (fixture-pinned)', () => {
  const dp = V.ddPenalty;
  const steady = A.runScenario({ prices: dp.prices, maxDeals: dp.maxDeals, bot: { type: 'dca', config: dp.steady.botConfig, pair: dp.pair, decimals: dp.decimals } });
  const reckless = A.runScenario({ prices: dp.prices, maxDeals: dp.maxDeals, bot: { type: 'dca', config: dp.reckless.botConfig, pair: dp.pair, decimals: dp.decimals } });

  // exact fixture match
  assert.strictEqual(steady.score, dp.steady.expectedScore);
  assert.strictEqual(reckless.score, dp.reckless.expectedScore);
  assert.strictEqual(steady.finalPnlUc.toString(), dp.steady.expectedPnlUc);
  assert.strictEqual(reckless.finalPnlUc.toString(), dp.reckless.expectedPnlUc);

  // the property: reckless OUT-RETURNS but UNDER-SCORES (because of its drawdown)
  assert.ok(reckless.finalPnlUc > steady.finalPnlUc, 'reckless out-returns (raw PnL)');
  assert.ok(reckless.retTenthPct > steady.retTenthPct, 'reckless out-returns (retPct)');
  assert.ok(reckless.maxDrawdownUc > steady.maxDrawdownUc, 'reckless has the larger drawdown');
  assert.ok(reckless.score < steady.score, 'yet reckless scores BELOW steady');
});

// ===========================================================================
// XP + levels (advisory), missions, badges
// ===========================================================================
test('XP accrues from runs + missions; levels unlock advanced params (advisory)', () => {
  assert.equal(A.levelForXp(0).level, 1);
  assert.ok(A.levelForXp(0).unlocks.includes('dca'));
  assert.equal(A.levelForXp(50).level, 2);
  assert.ok(A.levelForXp(150).unlocks.includes('advanced-params'));
  assert.equal(A.levelForXp(1000).level, 5);
  // a run always grants at least the participation XP
  const res = A.runScenario({ scenario: 'bull', prices: V.scenarios.bull, bot: { type: 'dca', config: V.canonical[2].botConfig, pair: 'BLOCK/USDC', decimals: 8 } });
  res.scenario = 'bull';
  assert.ok(A.xpForRun(res) >= 10);
});

test('missions have clear win conditions; a crash-survivor run completes the mission', () => {
  assert.ok(A.MISSIONS.length >= 3);
  // reckless on crash finishes green -> survive_crash_green
  const reck = A.runScenario({ scenario: 'crash', prices: V.scenarios.crash, bot: { type: 'dca', config: V.canonical[1].botConfig, pair: 'BLOCK/USDC', decimals: 8 } });
  reck.scenario = 'crash';
  assert.ok(reck.finalPnlUc > 0n, 'reckless crash run is green');
  assert.ok(A.checkMission('survive_crash_green', reck), 'survive_crash_green completes');
  assert.ok(A.completedMissions(reck).includes('survive_crash_green'));
});

test('badges unlock over a profile; first run + all-scenarios award badges', () => {
  const prof = new A.ArenaProfile();
  const first = prof.run({ scenario: 'bull', vectors: V, bot: { type: 'dca', config: V.canonical[2].botConfig, pair: 'BLOCK/USDC', decimals: 8 } });
  assert.ok(prof.badges.has('first_run'));
  assert.ok(first.xpGained >= 10);
  // play every remaining scenario -> Globetrotter
  for (const s of ['crab', 'bear', 'crash', 'pump']) {
    prof.run({ scenario: s, vectors: V, bot: { type: 'dca', config: V.canonical[0].botConfig, pair: 'BLOCK/USDC', decimals: 8 } });
  }
  assert.ok(prof.badges.has('all_scenarios'));
});

// ===========================================================================
// local-first leaderboard (NO network/global board in v1)
// ===========================================================================
test('leaderboard is local-first: personal best + on-device board, no global', () => {
  const lb = new A.Leaderboard();
  lb.add({ scenario: 'bull', score: 12.3, scoreTenths: 123n, name: 'a' });
  lb.add({ scenario: 'bull', score: 44.0, scoreTenths: 440n, name: 'b' });
  lb.add({ scenario: 'bull', score: 7.1, scoreTenths: 71n, name: 'c' });
  assert.equal(lb.personalBest('bull').name, 'b');            // highest score first
  assert.equal(lb.top('bull', 2).length, 2);
  assert.equal(lb.top('bull')[0].name, 'b');
  assert.equal(lb.toJSON().local, true);
  assert.equal(lb.toJSON().global, false);                    // v1: no global board
});

test('ArenaProfile records a personal best on the local board', () => {
  const prof = new A.ArenaProfile();
  prof.run({ scenario: 'bull', vectors: V, bot: { type: 'dca', config: V.canonical[2].botConfig, pair: 'BLOCK/USDC', decimals: 8 } });
  const pb = prof.leaderboard.personalBest('bull');
  assert.ok(pb, 'has a personal best for bull');
  assert.equal(typeof pb.score, 'number');
});

// ===========================================================================
// "USE THIS FOR REAL" — exports a template; import lands paper+disabled+testnet
// ===========================================================================
test('"use this for real" yields a paper + disabled + testnet bot (never auto-live)', () => {
  // design an Arena config, export it, then use-for-real
  const template = A.exportAsTemplate({ type: 'dca', config: V.canonical[0].botConfig, pair: 'BLOCK/USDC' });
  assert.equal(template.kind, 'blockle-bot-template');

  const bot = A.useForReal(template);
  assert.equal(bot.mode, 'paper', 'imported bot is paper');
  assert.equal(bot.enabled, false, 'imported bot is disabled');
  assert.equal(bot.network, 'testnet', 'imported bot is testnet');
  assert.equal(bot.allocationUsd, 0, 'imported bot has zero allocation');

  // even a template that LIES about being live lands paper+disabled+testnet
  const liar = Object.assign({}, template, { mode: 'live', enabled: true, network: 'mainnet', allocationUsd: 999999 });
  const bot2 = A.useForReal(liar);
  assert.equal(bot2.mode, 'paper');
  assert.equal(bot2.enabled, false);
  assert.equal(bot2.network, 'testnet');
  assert.equal(bot2.allocationUsd, 0);
});

// ===========================================================================
// determinism — a given (scenario, config) always yields the same fills + score
// ===========================================================================
test('runs are deterministic: identical (scenario, config) -> identical score + fills', () => {
  const mk = () => A.runScenario({ scenario: 'pump', prices: V.scenarios.pump, bot: { type: 'dca', config: V.canonical[0].botConfig, pair: 'BLOCK/USDC', decimals: 8 } });
  const a = mk(), b = mk();
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.finalPnlUc.toString(), b.finalPnlUc.toString());
  assert.strictEqual(a.maxDrawdownUc.toString(), b.maxDrawdownUc.toString());
  assert.strictEqual(JSON.stringify(a.fills), JSON.stringify(b.fills));
});
