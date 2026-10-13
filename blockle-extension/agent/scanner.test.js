// agent/scanner.test.js — the Scan-&-Trade (Autopilot) evaluator. Pins the shared
// contract (docs/scan-vectors.json): a cost-positive arb pair is traded; a
// gross-positive-but-net-negative pair is NOT; a sub-minProfitBps pair is skipped;
// a flagged token is never scored/traded; ranking + emitted Intents are exact; the
// maxConcurrentPairs + allocation bounds hold. No synthetic prices.
//
//   node --test blockle-extension/agent/

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AgentScanner = require('./scanner.js');
const AgentStrategies = require('./strategies.js');

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'scan-vectors.json'), 'utf8'));

function run(universe, config, opts) {
  return AgentScanner.scanAndScore(universe, config, Object.assign({ Strategies: AgentStrategies }, opts || {}));
}

// ===========================================================================
// SHARED VECTOR: the snapshot -> the exact ranked worthy set + scores + Intents
// ===========================================================================
test('scan-vectors: the pinned snapshot produces the exact ranked set + scores + Intents', async () => {
  const sv = VEC.scanner;
  const result = await run(sv.universe, sv.config, sv.opts);

  // ranked candidates (pair/strategy/edgeBps/score/reason/traded) match exactly
  assert.equal(result.candidates.length, sv.expect.ranked.length);
  sv.expect.ranked.forEach((exp, i) => {
    const got = result.candidates[i];
    assert.equal(got.pair, exp.pair, 'rank ' + i + ' pair');
    assert.equal(got.strategy, exp.strategy, exp.pair + ' strategy');
    assert.equal(got.edgeBps, exp.edgeBps, exp.pair + ' edgeBps');
    assert.equal(got.score, exp.score, exp.pair + ' score');
    assert.equal(got.reason, exp.reason, exp.pair + ' reason');
    assert.equal(!!got.traded, !!exp.traded, exp.pair + ' traded');
  });

  // worthy set + skipped reasons
  assert.deepEqual(result.worthy.map((w) => w.pair), sv.expect.worthy);
  assert.deepEqual(result.skipped, sv.expect.skipped);

  // the emitted Intents (tool/args/estUsd/tag/strategy) match exactly
  assert.equal(result.intents.length, sv.expect.intents.length, 'intent count');
  sv.expect.intents.forEach((exp, i) => {
    const got = result.intents[i];
    assert.equal(got.tool, exp.tool, 'intent ' + i + ' tool');
    assert.deepEqual(got.args, exp.args, 'intent ' + i + ' args');
    assert.equal(got.estUsd, exp.estUsd, 'intent ' + i + ' estUsd');
    assert.equal(got.tag, exp.tag, 'intent ' + i + ' tag');
    assert.equal(got.strategy, exp.strategy, 'intent ' + i + ' strategy');
    assert.equal(got.scannerPair, exp.scannerPair, 'intent ' + i + ' scannerPair');
  });

  assert.equal(result.allocationUsd, sv.expect.allocationUsd);
  assert.equal(result.remainingUsd, sv.expect.remainingUsd);
});

// ===========================================================================
// SAFETY: a cost-positive arb is traded; gross-positive-but-net-negative is NOT
// ===========================================================================
test('a cost-positive arbitrage pair is traded', async () => {
  const sv = VEC.scanner;
  const result = await run(sv.universe, sv.config, sv.opts);
  const eth = result.candidates.find((c) => c.pair === 'ETH/USDC');
  assert.equal(eth.reason, 'worthy');
  assert.ok(eth.traded);
  assert.ok(eth.edgeBps > sv.config.minProfitBps, 'net edge clears the threshold');
  assert.ok(result.intents.some((it) => it.tag === 'arb:ETH/USDC:dexA->dexB:buy'));
  assert.ok(result.intents.some((it) => it.tag === 'arb:ETH/USDC:dexA->dexB:sell'));
});

test('a gross-positive but net-negative pair is NEVER traded (net-negative)', async () => {
  const sv = VEC.scanner;
  const result = await run(sv.universe, sv.config, sv.opts);
  const blk = result.candidates.find((c) => c.pair === 'BLOCK/USDC');
  assert.equal(blk.reason, 'net-negative');
  assert.equal(blk.edgeBps, -15, 'gross +30bps - costs 45bps = -15bps');
  assert.equal(blk.score, 0);
  assert.ok(!blk.traded);
  assert.ok(!result.intents.some((it) => String(it.scannerPair) === 'BLOCK/USDC'), 'no Intent emitted for the net-negative pair');
});

test('a sub-minProfitBps pair is skipped (below-threshold)', async () => {
  const sv = VEC.scanner;
  const result = await run(sv.universe, sv.config, sv.opts);
  const sol = result.candidates.find((c) => c.pair === 'SOL/USDC');
  assert.equal(sol.reason, 'below-threshold');
  assert.ok(sol.edgeBps > 0 && sol.score < sv.config.minProfitBps);
  assert.ok(!sol.traded);
  assert.ok(!result.intents.some((it) => String(it.scannerPair) === 'SOL/USDC'));
});

test('a flagged (honeypot) candidate is never scored or traded', async () => {
  const sv = VEC.scanner;
  const result = await run(sv.universe, sv.config, sv.opts);
  const scam = result.candidates.find((c) => c.pair === 'SCAM/USDC');
  assert.equal(scam.reason, 'flagged');
  assert.equal(scam.strategy, null, 'a flagged candidate is not even evaluated');
  assert.equal(scam.score, 0);
  assert.ok(!result.intents.some((it) => String(it.scannerPair) === 'SCAM/USDC'));
});

// ===========================================================================
// NEVER FABRICATE: no venue data / no history => no signal, score 0, no Intent
// ===========================================================================
test('a candidate with no market data produces no signal and no Intent (never fabricated)', async () => {
  const result = await run([{ chain: 'ethereum', pair: 'NODATA/USDC', prices: { USDC: 1 } }], VEC.scanner.config, { allocationUsd: 5000 });
  assert.equal(result.candidates[0].reason, 'no-signal');
  assert.equal(result.candidates[0].score, 0);
  assert.equal(result.intents.length, 0);
});

// ===========================================================================
// maxConcurrentPairs + allocation bound the selection
// ===========================================================================
test('maxConcurrentPairs caps the number of traded pairs', async () => {
  const sv = VEC.scanner;
  const cfg = Object.assign({}, sv.config, { maxConcurrentPairs: 1 });
  const result = await run(sv.universe, cfg, { allocationUsd: 5000 });
  assert.equal(result.worthy.length, 1, 'only the top-ranked worthy pair trades');
  assert.equal(result.worthy[0].pair, 'MOM/USDC', 'the highest-score pair wins the single slot');
  const eth = result.candidates.find((c) => c.pair === 'ETH/USDC');
  assert.equal(eth.reason, 'max-concurrent', 'the next worthy pair is skipped for max-concurrent');
});

test('the remaining allocation bounds how many worthy pairs can trade', async () => {
  const sv = VEC.scanner;
  // only ~$1000.5 of room: MOM ($1000.5) fits, ETH ($2001) does not.
  const result = await run(sv.universe, sv.config, { allocationUsd: 1500, committedUsd: 0 });
  assert.deepEqual(result.worthy.map((w) => w.pair), ['MOM/USDC']);
  const eth = result.candidates.find((c) => c.pair === 'ETH/USDC');
  assert.equal(eth.reason, 'allocation', 'ETH is worthy but does not fit the remaining allocation');
});

// ===========================================================================
// config floors: slippage/agent-fee can never be configured below reality
// ===========================================================================
test('slippage + agent-fee floors cannot be configured below the real swap cost', async () => {
  const cfg = AgentScanner.validateConfig({ slippageBps: 0, agentFeeBps: 0 });
  assert.ok(cfg.slippageBps >= 5, 'slippage floored at 5bps');
  assert.ok(cfg.agentFeeBps >= 5, 'agent fee floored at 5bps');
});
