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

// ===========================================================================
// PROFIT CURRENCY — the settlement/quote asset the autopilot realizes INTO,
// denominates P&L in, and routes take-profit exits to. Defaults to USDC.
// ===========================================================================
test('profitCurrency defaults to USDC and normalizes a user choice', () => {
  assert.equal(AgentScanner.validateConfig({}).profitCurrency, 'USDC');
  assert.equal(AgentScanner.validateConfig({ profitCurrency: 'usdt' }).profitCurrency, 'USDT');
  assert.equal(AgentScanner.validateConfig({ profitCurrency: '  dai ' }).profitCurrency, 'DAI');
  assert.equal(AgentScanner.validateConfig({ profitCurrency: '' }).profitCurrency, 'USDC');
});

test('a scanner with profitCurrency=USDC realizes P&L + take-profit exits in USDC', async () => {
  const sv = VEC.scanner;
  const cfg = Object.assign({}, sv.config, { profitCurrency: 'USDC' });
  const result = await run(sv.universe, cfg, sv.opts);

  // the run denominates everything into the profit currency.
  assert.equal(result.profitCurrency, 'USDC');
  assert.ok(result.worthy.length >= 1, 'there is at least one worthy pair to realize');

  // EVERY worthy pair realizes its (net-positive) expected P&L INTO USDC.
  for (const w of result.worthy) {
    assert.ok(w.realized, w.pair + ' carries a realized-P&L block');
    assert.equal(w.realized.currency, 'USDC', w.pair + ' realizes into USDC');
    assert.ok(w.realized.profit > 0, w.pair + ' realizes a net-positive profit (worthy)');
  }

  // the take-profit EXIT legs (the realize/sell legs) settle to USDC. The ETH arb
  // pair has a sell leg; it is the exit and it routes proceeds to the profit currency.
  const exits = result.intents.filter((it) => it.exit);
  assert.ok(exits.length >= 1, 'at least one take-profit / realize exit leg exists');
  for (const e of exits) {
    assert.equal(e.settleTo, 'USDC', 'the exit settles into the profit currency');
    assert.ok(/:sell$/.test(e.tag), 'the exit is the sell / take-profit leg');
  }
  // every emitted intent is tagged with the settlement currency.
  for (const it of result.intents) assert.equal(it.settleTo, 'USDC');
});

// EXIT ROUTING IS REAL (not a label): when the profit currency differs from the
// pair's native quote, the take-profit exit's OUTPUT asset actually CHANGES to the
// profit currency — the emitted swap args differ. (A matching quote is a direct
// sell, so only the quote=profitCurrency case leaves args untouched.)
test('the take-profit exit OUTPUT asset equals the chosen profitCurrency (args actually change)', async () => {
  const sv = VEC.scanner;
  const AgentPnl = require('./pnl.js');
  const usdc = await run(sv.universe, Object.assign({}, sv.config, { profitCurrency: 'USDC' }), sv.opts);
  const usdt = await run(sv.universe, Object.assign({}, sv.config, { profitCurrency: 'USDT' }), sv.opts);

  // the ETH arb pair has a take-profit (sell) exit in both runs.
  const exitUsdc = usdc.intents.find((it) => it.exit && it.scannerPair === 'ETH/USDC');
  const exitUsdt = usdt.intents.find((it) => it.exit && it.scannerPair === 'ETH/USDC');
  assert.ok(exitUsdc && exitUsdt, 'both runs emit the ETH take-profit exit');

  // USDC == the pair's quote: a DIRECT sell, output asset is USDC.
  assert.equal(exitUsdc.args.to, 'USDC', 'quote==profitCurrency routes directly to USDC');
  assert.equal(exitUsdc.settleTo, 'USDC');

  // USDT != the pair's quote (USDC): the exit OUTPUT asset is routed INTO USDT —
  // the emitted swap args genuinely change (NOT deepEqual-unchanged).
  assert.equal(exitUsdt.args.to, 'USDT', 'quote!=profitCurrency routes the exit INTO USDT');
  assert.equal(exitUsdt.settleTo, 'USDT');
  assert.equal(exitUsdt.args.from, exitUsdc.args.from, 'the sold asset (input) is unchanged — only the output settles differently');
  assert.notDeepEqual(exitUsdt.args, exitUsdc.args, 'the exit swap args DIFFER across profit currencies');

  // POP-UP + P&L READ THE REAL OUTPUT: the realized-profit pop-up derives its
  // settlement asset from the committed swap's actual OUTPUT (summary.to). Feeding
  // the emitted exit through the pnl deriver yields the profit currency, so the
  // pop-up reports the REAL settled currency — consistent with settleTo + realized.
  const derived = AgentPnl.deriveTrade({
    summary: { action: 'swap', from: exitUsdt.args.from, to: exitUsdt.args.to, amount: exitUsdt.args.amount },
    value: { asset: exitUsdt.args.from, amount: exitUsdt.args.amount, usd: exitUsdt.estUsd },
  }, 'swap');
  assert.equal(derived.outAsset, 'USDT', 'the pop-up settlement asset is the REAL output = the profit currency');
  const ethRow = usdt.worthy.find((w) => w.pair === 'ETH/USDC');
  assert.equal(ethRow.realized.currency, 'USDT', 'realized P&L is denominated in the same real settled currency');
});

// SCORE ACCOUNTS FOR THE SETTLEMENT COST: a pair profitable in its native quote
// but net-negative AFTER converting into the profit currency is NOT traded.
test('a pair net-negative AFTER settlement into the profit currency is skipped (not traded)', async () => {
  // native arb edge ~ +35bps (gross 60 - costs 25) => worthy in its native USDC
  // quote; a settlement hop into USDT costs settlementFeeBps(30)+agentFeeBps(5)+
  // slippageBps(5) = 40bps, so the USDT-settled net edge is -5bps => NOT traded.
  const universe = [{
    chain: 'ethereum', symbol: 'TST', pair: 'TST/USDC', liquidityUsd: 500000, prices: { USDC: 1, USDT: 1 },
    venues: [
      { id: 'dexA', chain: 'ethereum', ask: '100', bid: '99', feeBps: 0, depthBase: '100000000000000' },
      { id: 'dexB', chain: 'ethereum', ask: '101', bid: '100.6', feeBps: 0, depthBase: '100000000000000' },
    ],
  }];
  const base = Object.assign({}, VEC.scanner.config);

  // native quote (USDC): worthy and traded.
  const inQuote = await run(universe, Object.assign({}, base, { profitCurrency: 'USDC' }), { allocationUsd: 5000 });
  const tQuote = inQuote.candidates.find((c) => c.pair === 'TST/USDC');
  assert.equal(tQuote.reason, 'worthy', 'profitable in its native quote');
  assert.equal(tQuote.edgeBps, 35);
  assert.ok(tQuote.traded);

  // settled into USDT: the settlement cost pushes it net-negative => skipped.
  const inUsdt = await run(universe, Object.assign({}, base, { profitCurrency: 'USDT' }), { allocationUsd: 5000 });
  const tUsdt = inUsdt.candidates.find((c) => c.pair === 'TST/USDC');
  assert.equal(tUsdt.reason, 'net-negative', 'net-negative after settling into USDT');
  assert.equal(tUsdt.edgeBps, -5, 'native 35bps - 40bps settlement = -5bps');
  assert.ok(!tUsdt.traded);
  assert.ok(!inUsdt.intents.some((it) => it.scannerPair === 'TST/USDC'), 'no Intent emitted for the net-negative-after-settlement pair');
});

// NEVER FABRICATE A ROUTE: if the candidate has no price/route into the chosen
// profit currency, it is skipped (audited 'no-route'), never traded on an invented price.
test('a candidate with no route into the profit currency is skipped (never fabricated)', async () => {
  const universe = [{
    chain: 'ethereum', symbol: 'ETH', pair: 'ETH/USDC', liquidityUsd: 500000, prices: { USDC: 1 },
    venues: [
      { id: 'dexA', chain: 'ethereum', ask: '2000', bid: '1999', feeBps: 10, depthBase: '1000000000000000000000' },
      { id: 'dexB', chain: 'ethereum', ask: '2010', bid: '2030', feeBps: 10, depthBase: '1000000000000000000000' },
    ],
  }];
  // WOOF is a non-stable profit currency with NO price anywhere in the candidate.
  const result = await run(universe, Object.assign({}, VEC.scanner.config, { profitCurrency: 'WOOF' }), { allocationUsd: 5000 });
  const eth = result.candidates.find((c) => c.pair === 'ETH/USDC');
  assert.equal(eth.reason, 'no-route', 'no route into the profit currency => skipped, not fabricated');
  assert.ok(!eth.traded);
  assert.equal(result.intents.length, 0, 'nothing traded on an invented conversion price');
});

// the pinned scan vectors (default/USDC profit currency == the pairs\' quote) are a
// DIRECT settle, so the ranking, worthy set, scores + emitted args are untouched.
test('a matching profitCurrency (== the quote) leaves the pinned vectors unchanged (direct settle)', async () => {
  const sv = VEC.scanner;
  const base = await run(sv.universe, sv.config, sv.opts);
  const withUsdc = await run(sv.universe, Object.assign({}, sv.config, { profitCurrency: 'USDC' }), sv.opts);
  assert.deepEqual(withUsdc.worthy.map((w) => w.pair), base.worthy.map((w) => w.pair));
  assert.deepEqual(withUsdc.candidates.map((c) => [c.pair, c.score, c.reason]), base.candidates.map((c) => [c.pair, c.score, c.reason]));
  assert.equal(withUsdc.intents.length, base.intents.length);
  withUsdc.intents.forEach((it, i) => assert.deepEqual(it.args, base.intents[i].args));
});
