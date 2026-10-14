// agent/scanner_test.dart — the Scan-&-Trade (Autopilot) evaluator. Pins the
// shared contract (docs/scan-vectors.json): a cost-positive arb pair is traded; a
// gross-positive-but-net-negative pair is NOT; a sub-minProfitBps pair is skipped;
// a flagged token is never scored/traded; ranking + emitted Intents are exact; the
// maxConcurrentPairs + allocation bounds hold. No synthetic prices. These are the
// SAME numbers the JS reference + Python wallet assert against.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/scanner.dart';

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/scan-vectors.json',
    'docs/scan-vectors.json',
    '../../docs/scan-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('scan-vectors.json not found (cwd=${Directory.current.path})');
}

final vectors = _loadVectors();

ScanResult run(List<dynamic> universe, Map<String, dynamic> config,
    Map<String, dynamic> opts) {
  return AgentScanner.scanAndScore(
    universe,
    config,
    allocationUsd: opts['allocationUsd'] as num?,
    committedUsd: (opts['committedUsd'] as num?) ?? 0,
    mainnet: opts['mainnet'] == true,
  );
}

void main() {
  final sv = (vectors['scanner'] as Map).cast<String, dynamic>();
  final universe = sv['universe'] as List;
  final config = (sv['config'] as Map).cast<String, dynamic>();
  final opts = (sv['opts'] as Map).cast<String, dynamic>();
  final expect0 = (sv['expect'] as Map).cast<String, dynamic>();

  // =========================================================================
  // SHARED VECTOR: the snapshot -> the exact ranked worthy set + scores + Intents
  // =========================================================================
  test('scan-vectors: the pinned snapshot produces the exact ranked set + scores + Intents',
      () {
    final result = run(universe, config, opts);
    final ranked = expect0['ranked'] as List;

    expect(result.candidates.length, ranked.length);
    for (var i = 0; i < ranked.length; i++) {
      final exp = (ranked[i] as Map).cast<String, dynamic>();
      final got = result.candidates[i];
      expect(got['pair'], exp['pair'], reason: 'rank $i pair');
      expect(got['strategy'], exp['strategy'], reason: '${exp['pair']} strategy');
      expect(got['edgeBps'], exp['edgeBps'], reason: '${exp['pair']} edgeBps');
      expect(got['score'], exp['score'], reason: '${exp['pair']} score');
      expect(got['reason'], exp['reason'], reason: '${exp['pair']} reason');
      expect(got['traded'] == true, exp['traded'] == true, reason: '${exp['pair']} traded');
    }

    // worthy set + skipped reasons
    expect(result.worthy.map((w) => w['pair']).toList(),
        (expect0['worthy'] as List));
    expect(result.skipped, (expect0['skipped'] as List));

    // the emitted Intents (tool/args/estUsd/tag/strategy/scannerPair) match exactly
    final expIntents = expect0['intents'] as List;
    expect(result.intents.length, expIntents.length, reason: 'intent count');
    for (var i = 0; i < expIntents.length; i++) {
      final exp = (expIntents[i] as Map).cast<String, dynamic>();
      final got = result.intents[i];
      expect(got.tool, exp['tool'], reason: 'intent $i tool');
      expect(got.args, (exp['args'] as Map).cast<String, dynamic>(),
          reason: 'intent $i args');
      expect(got.estUsd, exp['estUsd'], reason: 'intent $i estUsd');
      expect(got.tag, exp['tag'], reason: 'intent $i tag');
      expect(got.strategy, exp['strategy'], reason: 'intent $i strategy');
      expect(got.scannerPair, exp['scannerPair'], reason: 'intent $i scannerPair');
      expect(got.scannerScore, exp['scannerScore'], reason: 'intent $i scannerScore');
      expect(got.group, exp['group'], reason: 'intent $i group');
    }

    expect(result.allocationUsd, expect0['allocationUsd']);
    expect(result.remainingUsd, expect0['remainingUsd']);
  });

  // =========================================================================
  // SAFETY: a cost-positive arb is traded; gross-positive-but-net-negative is NOT
  // =========================================================================
  test('a cost-positive arbitrage pair is traded', () {
    final result = run(universe, config, opts);
    final eth = result.candidates.firstWhere((c) => c['pair'] == 'ETH/USDC');
    expect(eth['reason'], 'worthy');
    expect(eth['traded'], true);
    expect((eth['edgeBps'] as num) > (config['minProfitBps'] as num), true);
    expect(result.intents.any((it) => it.tag == 'arb:ETH/USDC:dexA->dexB:buy'), true);
    expect(result.intents.any((it) => it.tag == 'arb:ETH/USDC:dexA->dexB:sell'), true);
  });

  test('a gross-positive but net-negative pair is NEVER traded (net-negative)', () {
    final result = run(universe, config, opts);
    final blk = result.candidates.firstWhere((c) => c['pair'] == 'BLOCK/USDC');
    expect(blk['reason'], 'net-negative');
    expect(blk['edgeBps'], -15);
    expect(blk['score'], 0);
    expect(blk['traded'], false);
    expect(result.intents.any((it) => it.scannerPair == 'BLOCK/USDC'), false);
  });

  test('a sub-minProfitBps pair is skipped (below-threshold)', () {
    final result = run(universe, config, opts);
    final sol = result.candidates.firstWhere((c) => c['pair'] == 'SOL/USDC');
    expect(sol['reason'], 'below-threshold');
    expect((sol['edgeBps'] as num) > 0 &&
        (sol['score'] as num) < (config['minProfitBps'] as num), true);
    expect(sol['traded'], false);
    expect(result.intents.any((it) => it.scannerPair == 'SOL/USDC'), false);
  });

  test('a flagged (honeypot) candidate is never scored or traded', () {
    final result = run(universe, config, opts);
    final scam = result.candidates.firstWhere((c) => c['pair'] == 'SCAM/USDC');
    expect(scam['reason'], 'flagged');
    expect(scam['strategy'], null);
    expect(scam['score'], 0);
    expect(result.intents.any((it) => it.scannerPair == 'SCAM/USDC'), false);
  });

  // =========================================================================
  // NEVER FABRICATE: no venue data / no history => no signal, score 0, no Intent
  // =========================================================================
  test('a candidate with no market data produces no signal and no Intent (never fabricated)',
      () {
    final result = run([
      {'chain': 'ethereum', 'pair': 'NODATA/USDC', 'prices': {'USDC': 1}}
    ], config, {'allocationUsd': 5000});
    expect(result.candidates[0]['reason'], 'no-signal');
    expect(result.candidates[0]['score'], 0);
    expect(result.intents.length, 0);
  });

  // =========================================================================
  // maxConcurrentPairs + allocation bound the selection
  // =========================================================================
  test('maxConcurrentPairs caps the number of traded pairs', () {
    final cfg = {...config, 'maxConcurrentPairs': 1};
    final result = run(universe, cfg, {'allocationUsd': 5000});
    expect(result.worthy.length, 1);
    expect(result.worthy[0]['pair'], 'MOM/USDC');
    final eth = result.candidates.firstWhere((c) => c['pair'] == 'ETH/USDC');
    expect(eth['reason'], 'max-concurrent');
  });

  test('the remaining allocation bounds how many worthy pairs can trade', () {
    final result = run(universe, config, {'allocationUsd': 1500, 'committedUsd': 0});
    expect(result.worthy.map((w) => w['pair']).toList(), ['MOM/USDC']);
    final eth = result.candidates.firstWhere((c) => c['pair'] == 'ETH/USDC');
    expect(eth['reason'], 'allocation');
  });

  // =========================================================================
  // config floors: slippage/agent-fee can never be configured below reality
  // =========================================================================
  test('slippage + agent-fee floors cannot be configured below the real swap cost', () {
    final cfg = AgentScanner.validateConfig({'slippageBps': 0, 'agentFeeBps': 0});
    expect((cfg['slippageBps'] as int) >= 5, true);
    expect((cfg['agentFeeBps'] as int) >= 5, true);
  });

  // =========================================================================
  // PROFIT CURRENCY — the settlement/quote asset the autopilot realizes profit
  // INTO, denominates P&L in, and routes take-profit exits to. Defaults to USDC.
  // =========================================================================
  test('profitCurrency defaults to USDC and normalizes a user choice', () {
    expect(AgentScanner.validateConfig({})['profitCurrency'], 'USDC');
    expect(AgentScanner.validateConfig({'profitCurrency': 'usdt'})['profitCurrency'], 'USDT');
    expect(AgentScanner.validateConfig({'profitCurrency': '  dai '})['profitCurrency'], 'DAI');
    expect(AgentScanner.validateConfig({'profitCurrency': ''})['profitCurrency'], 'USDC');
  });

  test('profitCurrency=USDC: the EXIT leg OUTPUT asset is USDC and P&L reads that real output', () {
    final cfg = {...config, 'profitCurrency': 'USDC'};
    final result = run(universe, cfg, opts);

    expect(result.profitCurrency, 'USDC');
    expect(result.worthy.isNotEmpty, true, reason: 'there is at least one worthy pair to realize');

    // the take-profit EXIT legs (the sell legs) ROUTE their OUTPUT into USDC — the
    // actual swap `to` asset is the profit currency, not merely a label.
    final exits = result.intents.where((it) => it.exit).toList();
    expect(exits.isNotEmpty, true, reason: 'at least one take-profit / realize exit leg exists');
    for (final e in exits) {
      expect(e.args['to'], 'USDC', reason: 'the exit swap OUTPUT asset == the profit currency');
      expect(e.settleTo, 'USDC', reason: 'the exit settles into the profit currency');
      expect(RegExp(r':sell$').hasMatch(e.tag), true, reason: 'the exit is the sell / take-profit leg');
    }

    // POP-UP + P&L read the REAL committed output: realized currency == the actual
    // exit OUTPUT asset (USDC here), kept consistent — not a separate label.
    for (final w in result.worthy) {
      final realized = w['realized'] as Map<String, dynamic>?;
      expect(realized, isNotNull, reason: '${w['pair']} carries a realized-P&L block');
      expect(realized!['currency'], 'USDC', reason: '${w['pair']} realizes into USDC');
      expect((realized['profit'] as num) > 0, true, reason: '${w['pair']} realizes a net-positive profit');
    }
    final exitByPair = {for (final e in exits) e.scannerPair: e};
    for (final w in result.worthy) {
      final exit = exitByPair[w['pair']];
      if (exit != null) {
        expect((w['realized'] as Map)['currency'], exit.args['to'],
            reason: 'the pop-up currency == the real exit OUTPUT asset');
      }
    }
    for (final it in result.intents) {
      expect(it.settleTo, 'USDC');
    }
  });

  // =========================================================================
  // EXIT ROUTING IS REAL: a DIFFERENT profit currency actually CHANGES the emitted
  // swap args — the exit OUTPUT asset becomes the chosen currency (routed via the
  // venue layer's extra hop), NOT the pair's native quote. The pop-up follows.
  // =========================================================================
  test('a non-native profitCurrency changes the EXIT output asset to that currency', () {
    final base = run(universe, config, opts); // default USDC (== quote)
    final usdt = run(universe, {...config, 'profitCurrency': 'USDT'}, opts);

    expect(usdt.profitCurrency, 'USDT');

    // the ETH arb pair's sell leg quote is USDC natively; under profitCurrency=USDT
    // its OUTPUT asset is routed to USDT — the args genuinely differ from the native
    // run (this is NOT a deepEqual-unchanged relationship).
    final baseExit = base.intents.firstWhere((it) => it.tag.endsWith(':sell'));
    final usdtExit = usdt.intents.firstWhere((it) => it.tag.endsWith(':sell'));
    expect(baseExit.args['to'], 'USDC');
    expect(usdtExit.args['to'], 'USDT', reason: 'the exit OUTPUT asset == the chosen profit currency');
    expect(usdtExit.args != baseExit.args, true, reason: 'the emitted swap args actually changed');

    // every exit settles into USDT and the realized pop-up reports the real output.
    for (final e in usdt.intents.where((it) => it.exit)) {
      expect(e.args['to'], 'USDT');
      expect(e.settleTo, 'USDT');
    }
    for (final w in usdt.worthy) {
      expect((w['realized'] as Map)['currency'], 'USDT');
    }
  });

  // =========================================================================
  // SCORE INCLUDES SETTLEMENT COST: a pair profitable in its native quote but
  // net-negative AFTER settling into the chosen profit currency is NOT traded.
  // =========================================================================
  test('a pair net-negative AFTER settlement into the profit currency is skipped', () {
    // ARB pair quoted in USDC: gross 80bps - costs 45bps = +35bps native (worthy,
    // >= minProfitBps 30). Settling into USDT adds settleFeeBps(30) + agentFeeBps(5)
    // + slippageBps(5) = 40bps, flipping the +35bps native edge to -5bps.
    final uni = [
      {
        'chain': 'ethereum', 'symbol': 'THIN', 'pair': 'THIN/USDC',
        'liquidityUsd': 500000, 'prices': {'USDC': 1, 'USDT': 1},
        'venues': [
          {'id': 'dexA', 'ask': '100', 'bid': '99.9', 'feeBps': 10, 'depthBase': '1000000000000000000000'},
          {'id': 'dexB', 'ask': '100.1', 'bid': '100.8', 'feeBps': 10, 'depthBase': '1000000000000000000000'},
        ],
      }
    ];
    // native (USDC == quote): the pair is worthy.
    final native = run(uni, config, {'allocationUsd': 5000});
    final natRow = native.candidates.firstWhere((c) => c['pair'] == 'THIN/USDC');
    expect(natRow['reason'], 'worthy', reason: 'profitable in its native quote');
    expect(natRow['traded'], true);

    // settling into USDT: the extra settlement leg flips it net-negative -> skipped.
    final settled = run(uni, {...config, 'profitCurrency': 'USDT'}, {'allocationUsd': 5000});
    final setRow = settled.candidates.firstWhere((c) => c['pair'] == 'THIN/USDC');
    expect(setRow['reason'], 'net-negative',
        reason: 'only profitable in the native quote; net-negative after settlement');
    expect(setRow['traded'], false);
    expect(settled.intents.any((it) => it.scannerPair == 'THIN/USDC'), false,
        reason: 'no Intent emitted for the net-negative-after-settlement pair');
    expect((setRow['edgeBps'] as num) < (natRow['edgeBps'] as num), true,
        reason: 'the settlement cost reduced the net edge');
  });

  // =========================================================================
  // NEVER FABRICATE A ROUTE: if there is NO route to the profit currency for a
  // candidate, it is skipped (audited) — a price is never invented to force it.
  // =========================================================================
  test('a candidate with no route to the profit currency is skipped (no-route), never fabricated', () {
    // ETH/USDC but the profit currency is an exotic with NO known price on this
    // candidate -> no route -> skipped, no Intent (never a fabricated $1 fallback).
    final result = run(universe, {...config, 'profitCurrency': 'WZRD'}, {'allocationUsd': 5000});
    final eth = result.candidates.firstWhere((c) => c['pair'] == 'ETH/USDC');
    expect(eth['reason'], 'no-route');
    expect(eth['score'], 0);
    expect(eth['traded'], false);
    expect(result.intents.any((it) => it.scannerPair == 'ETH/USDC'), false);
  });

  test('the DEFAULT config leaves the pinned scan vectors unchanged (parity intact)', () {
    final base = run(universe, config, opts);
    final withUsdc = run(universe, {...config, 'profitCurrency': 'USDC'}, opts);
    // USDC is the quote of every pinned pair, so settling into it is a direct, zero
    // -cost sell: the ranking, scores + emitted args are identical to the default.
    expect(withUsdc.worthy.map((w) => w['pair']).toList(),
        base.worthy.map((w) => w['pair']).toList());
    expect(
        withUsdc.candidates.map((c) => [c['pair'], c['score'], c['reason']]).toList(),
        base.candidates.map((c) => [c['pair'], c['score'], c['reason']]).toList());
    expect(withUsdc.intents.length, base.intents.length);
    for (var i = 0; i < withUsdc.intents.length; i++) {
      expect(withUsdc.intents[i].args, base.intents[i].args);
    }
  });
}
