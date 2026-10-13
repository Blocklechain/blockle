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
}
