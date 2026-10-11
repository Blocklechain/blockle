// agent/arena_test.dart — the Blockle ARENA (arena.dart), the play-money gamified
// sandbox (docs/BLOCKLE-BOTS.md §9). Dart port of blockle-extension/agent/
// arena.test.js. Proves:
//   • an Arena run NEVER touches commit/broadcast/gate/reserve (spies stay at 0);
//     arena.dart structurally depends only on the PURE deal engine + templates.
//   • PLAY funds can never convert/withdraw/exchange for anything real.
//   • the canonical (scenario, botConfig) -> score vectors match the shared
//     fixture docs/arena-vectors.json EXACTLY (byte-for-byte integer math).
//   • the score penalizes drawdown: a reckless high-return/high-DD run scores
//     BELOW a steadier one.
//   • "use this for real" yields a paper + disabled + testnet bot (never auto-live).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/arena.dart' as A;
import 'package:blockle_app/agent/bots.dart' as B;
import 'package:blockle_app/agent/bot_templates.dart' as T;

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/arena-vectors.json',
    'docs/arena-vectors.json',
    '../../docs/arena-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('arena-vectors.json not found (cwd=${Directory.current.path})');
}

final V = _loadVectors();

String? _arenaSrc() {
  for (final p in const [
    'lib/agent/arena.dart',
    '../blockle-app/lib/agent/arena.dart',
  ]) {
    final f = File(p);
    if (f.existsSync()) return f.readAsStringSync();
  }
  return null;
}

void main() {
  // =========================================================================
  // honesty + labels
  // =========================================================================
  test('disclaimer is a persistent, honest, non-empty constant', () {
    expect(A.kDisclaimer, isA<String>());
    expect(A.kDisclaimer.toLowerCase(), contains('simulation'));
    expect(A.kDisclaimer.toLowerCase(), contains('not financial advice'));
    expect(A.kDisclaimer, V['disclaimer']);
    expect(A.kPlayLabel, 'PLAY');
    expect(A.kDefaultGrant, 10000);
    expect(A.kSimulationOnly, true);
  });

  // =========================================================================
  // PLAY balance can NEVER become real
  // =========================================================================
  test('PlayBalance starts at the labeled grant and can never convert to real', () {
    final pb = A.PlayBalance();
    expect(pb.label, 'PLAY');
    expect(pb.real, false);
    expect(pb.convertible, false);
    expect(pb.grantUc.toString(), B.microUsd(10000).toString());
    expect(pb.balanceUc.toString(), B.microUsd(10000).toString());
    // the three real-world off-ramps all throw — structurally impossible to exit.
    expect(() => pb.convertToReal(), throwsA(predicate((e) => '$e'.contains('never be converted'))));
    expect(() => pb.withdraw(), throwsA(predicate((e) => '$e'.contains('never be converted'))));
    expect(() => pb.exchange(), throwsA(predicate((e) => '$e'.contains('never be converted'))));
    // custom grant is labeled + virtual too
    final pb2 = A.PlayBalance(500);
    expect(pb2.grantUc.toString(), B.microUsd(500).toString());
    expect(pb2.toJson()['real'], false);
    expect(pb2.toJson()['convertible'], false);
  });

  test('applying play PnL moves only the PLAY balance; it is never real money', () {
    final pb = A.PlayBalance(1000);
    pb.applyPnl(B.microUsd(250));
    expect(pb.balanceUc.toString(), B.microUsd(1250).toString());
    pb.applyPnl(-B.microUsd(400));
    expect(pb.balanceUc.toString(), B.microUsd(850).toString());
    expect(pb.real, false);
  });

  // =========================================================================
  // STRUCTURAL safety — Arena never calls commit/broadcast/gate/reserve
  // =========================================================================
  test('arena.dart depends ONLY on the pure engine + templates (no runner/gate/broadcast)', () {
    final src = _arenaSrc();
    expect(src, isNotNull, reason: 'arena.dart source must be readable');
    // it must not pull in the live dispatch / gate / runner modules
    expect(RegExp(r'''import\s+['"]bot_runner''').hasMatch(src!), isFalse,
        reason: 'arena must not import bot_runner');
    expect(RegExp(r'''import\s+['"]runner''').hasMatch(src), isFalse,
        reason: 'arena must not import runner');
    expect(RegExp(r'''import\s+['"]policy''').hasMatch(src), isFalse,
        reason: 'arena must not import policy');
    expect(RegExp(r'''import\s+['"]tools''').hasMatch(src), isFalse,
        reason: 'arena must not import tools');
  });

  test('an Arena run never invokes any commit/broadcast/gate/recordSpend/reserve spy', () {
    // Poison the environment: pass spies for every value-moving fn. Arena has no
    // code path to them, so each must stay at ZERO calls.
    final calls = {
      'commit': 0, 'broadcast': 0, 'gateConfirm': 0, 'recordSpend': 0,
      'reserve': 0, 'dispatch': 0, 'sign': 0,
    };
    final guard = <String, dynamic>{};
    for (final k in calls.keys) {
      guard[k] = () {
        calls[k] = calls[k]! + 1;
        throw StateError('Arena must never call $k');
      };
    }

    final prof = A.ArenaProfile();
    for (final scenario in A.kScenarios) {
      prof.run({
        'scenario': scenario,
        'vectors': V,
        'bot': {'type': 'dca', 'config': V['canonical'][0]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
        'guard': guard,
      });
    }
    for (final k in calls.keys) {
      expect(calls[k], 0, reason: '$k was called');
    }
    // every run is labeled PLAY and not real
    expect(prof.playBalance.real, false);
  });

  // =========================================================================
  // scenario feed — loaded from the authoritative fixture (not RNG-regenerated)
  // =========================================================================
  test('scenario paths load from the shared fixture (5 scenarios, ~120 pts each)', () {
    final paths = A.loadScenarios(V);
    expect(paths.keys.toList()..sort(), A.kScenarios.toList()..sort());
    for (final s in A.kScenarios) {
      expect(paths[s]!.length >= 100, isTrue, reason: '$s has a full path');
      expect(A.pricePath(V, s), (V['scenarios'][s] as List).map((e) => e as num).toList());
    }
  });

  // =========================================================================
  // CANONICAL score vectors — identical integer math across all three wallets
  // =========================================================================
  test('canonical (scenario, botConfig) -> score vectors match the fixture EXACTLY', () {
    final canonical = (V['canonical'] as List);
    expect(canonical.length >= 1, isTrue, reason: 'fixture has at least one canonical vector');
    for (final vec in canonical) {
      final res = A.runScenario({
        'scenario': vec['scenario'],
        'prices': V['scenarios'][vec['scenario']],
        'bot': {'type': vec['type'], 'config': vec['botConfig'], 'pair': vec['pair'], 'decimals': vec['decimals']},
      });
      expect(res.score, vec['expectedScore'], reason: '${vec['scenario']} score');
      expect(res.scoreTenths.toString(), vec['expectedScoreTenths'], reason: '${vec['scenario']} scoreTenths');
      expect(res.finalPnlUc.toString(), vec['expectedPnlUc'], reason: '${vec['scenario']} pnlUc');
      expect(res.maxDrawdownUc.toString(), vec['expectedMaxDdUc'], reason: '${vec['scenario']} maxDdUc');
      expect(res.maxCostBasisUc.toString(), vec['expectedMaxCostBasisUc'], reason: '${vec['scenario']} maxCostBasisUc');
      expect(res.fills.length, vec['expectedFillCount'], reason: '${vec['scenario']} fillCount');
      expect(res.dealCount, vec['expectedDealCount'], reason: '${vec['scenario']} dealCount');
    }
  });

  test('score formula is the pinned round1(retPct - 0.5*ddPct) integer math', () {
    // +10% return, 0 drawdown -> 10.0
    expect(A.score(B.microUsd(100), BigInt.zero, B.microUsd(1000)),
        A.ArenaScore(BigInt.from(100), 10));
    // +10% return, 20% drawdown -> 10 - 0.5*20 = 0.0
    expect(A.score(B.microUsd(100), B.microUsd(200), B.microUsd(1000)),
        A.ArenaScore(BigInt.zero, 0));
    // -5% return, 10% drawdown -> -5 - 5 = -10.0
    expect(A.score(-B.microUsd(50), B.microUsd(100), B.microUsd(1000)),
        A.ArenaScore(BigInt.from(-100), -10));
    // no capital deployed -> 0 (no division by zero)
    expect(A.score(BigInt.zero, BigInt.zero, BigInt.zero), A.ArenaScore(BigInt.zero, 0));
    // half-away-from-zero rounding to tenths: ret 3.33% -> 3.3
    final r = A.score(B.microUsd(100), BigInt.zero, B.microUsd(3000));
    expect(r.score, 3.3);
  });

  // =========================================================================
  // the score PENALIZES DRAWDOWN — reckless high-DD scores below steady
  // =========================================================================
  test('a reckless high-return/high-DD run scores BELOW a steadier one (fixture-pinned)', () {
    final dp = V['ddPenalty'] as Map<String, dynamic>;
    final steady = A.runScenario({
      'prices': dp['prices'], 'maxDeals': dp['maxDeals'],
      'bot': {'type': 'dca', 'config': dp['steady']['botConfig'], 'pair': dp['pair'], 'decimals': dp['decimals']},
    });
    final reckless = A.runScenario({
      'prices': dp['prices'], 'maxDeals': dp['maxDeals'],
      'bot': {'type': 'dca', 'config': dp['reckless']['botConfig'], 'pair': dp['pair'], 'decimals': dp['decimals']},
    });

    // exact fixture match
    expect(steady.score, dp['steady']['expectedScore']);
    expect(reckless.score, dp['reckless']['expectedScore']);
    expect(steady.finalPnlUc.toString(), dp['steady']['expectedPnlUc']);
    expect(reckless.finalPnlUc.toString(), dp['reckless']['expectedPnlUc']);

    // the property: reckless OUT-RETURNS but UNDER-SCORES (because of its drawdown)
    expect(reckless.finalPnlUc > steady.finalPnlUc, isTrue, reason: 'reckless out-returns (raw PnL)');
    expect(reckless.retTenthPct > steady.retTenthPct, isTrue, reason: 'reckless out-returns (retPct)');
    expect(reckless.maxDrawdownUc > steady.maxDrawdownUc, isTrue, reason: 'reckless has the larger drawdown');
    expect(reckless.score < steady.score, isTrue, reason: 'yet reckless scores BELOW steady');
  });

  // =========================================================================
  // XP + levels (advisory), missions, badges
  // =========================================================================
  test('XP accrues from runs + missions; levels unlock advanced params (advisory)', () {
    expect(A.levelForXp(0).level, 1);
    expect(A.levelForXp(0).unlocks, contains('dca'));
    expect(A.levelForXp(50).level, 2);
    expect(A.levelForXp(150).unlocks, contains('advanced-params'));
    expect(A.levelForXp(1000).level, 5);
    // a run always grants at least the participation XP
    final res = A.runScenario({
      'scenario': 'bull', 'prices': V['scenarios']['bull'],
      'bot': {'type': 'dca', 'config': V['canonical'][2]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
    });
    res.scenario = 'bull';
    expect(A.xpForRun(res) >= 10, isTrue);
  });

  test('missions have clear win conditions; a crash-survivor run completes the mission', () {
    expect(A.kMissions.length >= 3, isTrue);
    // reckless on crash finishes green -> survive_crash_green
    final reck = A.runScenario({
      'scenario': 'crash', 'prices': V['scenarios']['crash'],
      'bot': {'type': 'dca', 'config': V['canonical'][1]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
    });
    reck.scenario = 'crash';
    expect(reck.finalPnlUc > BigInt.zero, isTrue, reason: 'reckless crash run is green');
    expect(A.checkMission('survive_crash_green', reck), isTrue, reason: 'survive_crash_green completes');
    expect(A.completedMissions(reck), contains('survive_crash_green'));
  });

  test('badges unlock over a profile; first run + all-scenarios award badges', () {
    final prof = A.ArenaProfile();
    final first = prof.run({
      'scenario': 'bull', 'vectors': V,
      'bot': {'type': 'dca', 'config': V['canonical'][2]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
    });
    expect(prof.badges.contains('first_run'), isTrue);
    expect((first['xpGained'] as int) >= 10, isTrue);
    // play every remaining scenario -> Globetrotter
    for (final s in const ['crab', 'bear', 'crash', 'pump']) {
      prof.run({
        'scenario': s, 'vectors': V,
        'bot': {'type': 'dca', 'config': V['canonical'][0]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
      });
    }
    expect(prof.badges.contains('all_scenarios'), isTrue);
  });

  // =========================================================================
  // local-first leaderboard (NO network/global board in v1)
  // =========================================================================
  test('leaderboard is local-first: personal best + on-device board, no global', () {
    final lb = A.Leaderboard();
    lb.add({'scenario': 'bull', 'score': 12.3, 'scoreTenths': BigInt.from(123), 'name': 'a'});
    lb.add({'scenario': 'bull', 'score': 44.0, 'scoreTenths': BigInt.from(440), 'name': 'b'});
    lb.add({'scenario': 'bull', 'score': 7.1, 'scoreTenths': BigInt.from(71), 'name': 'c'});
    expect(lb.personalBest('bull')!['name'], 'b'); // highest score first
    expect(lb.top('bull', 2).length, 2);
    expect(lb.top('bull')[0]['name'], 'b');
    expect(lb.toJson()['local'], true);
    expect(lb.toJson()['global'], false); // v1: no global board
  });

  test('ArenaProfile records a personal best on the local board', () {
    final prof = A.ArenaProfile();
    prof.run({
      'scenario': 'bull', 'vectors': V,
      'bot': {'type': 'dca', 'config': V['canonical'][2]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
    });
    final pb = prof.leaderboard.personalBest('bull');
    expect(pb, isNotNull, reason: 'has a personal best for bull');
    expect(pb!['score'], isA<num>());
  });

  // =========================================================================
  // "USE THIS FOR REAL" — exports a template; import lands paper+disabled+testnet
  // =========================================================================
  test('"use this for real" yields a paper + disabled + testnet bot (never auto-live)', () {
    // design an Arena config, export it, then use-for-real
    final template = A.exportAsTemplate({'type': 'dca', 'config': V['canonical'][0]['botConfig'], 'pair': 'BLOCK/USDC'});
    expect(template['kind'], 'blockle-bot-template');

    final bot = A.useForReal(template);
    expect(bot.mode, 'paper', reason: 'imported bot is paper');
    expect(bot.enabled, false, reason: 'imported bot is disabled');
    expect(bot.network, 'testnet', reason: 'imported bot is testnet');
    expect(bot.allocationUsd, 0, reason: 'imported bot has zero allocation');

    // even a template that LIES about being live lands paper+disabled+testnet
    final liar = {...template, 'mode': 'live', 'enabled': true, 'network': 'mainnet', 'allocationUsd': 999999};
    final bot2 = A.useForReal(liar);
    expect(bot2.mode, 'paper');
    expect(bot2.enabled, false);
    expect(bot2.network, 'testnet');
    expect(bot2.allocationUsd, 0);
  });

  // =========================================================================
  // determinism — a given (scenario, config) always yields the same fills + score
  // =========================================================================
  test('runs are deterministic: identical (scenario, config) -> identical score + fills', () {
    A.ArenaResult mk() => A.runScenario({
          'scenario': 'pump', 'prices': V['scenarios']['pump'],
          'bot': {'type': 'dca', 'config': V['canonical'][0]['botConfig'], 'pair': 'BLOCK/USDC', 'decimals': 8},
        });
    final a = mk(), b = mk();
    expect(a.score, b.score);
    expect(a.finalPnlUc.toString(), b.finalPnlUc.toString());
    expect(a.maxDrawdownUc.toString(), b.maxDrawdownUc.toString());
    expect(jsonEncode(a.fills), jsonEncode(b.fills));
  });
}
