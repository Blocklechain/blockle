// Blockle Bots DEAL ENGINE (bots.dart) + model/store + templates. The deal-engine
// tests assert the Dart engine reproduces the AUTHORITATIVE shared fixture
// docs/bot-vectors.json EXACTLY (base-unit BigInt qty, micro-dollar integer
// basis) — the SAME numbers the JS reference and Python wallet assert against.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/agent/bots.dart';
import 'package:blockle_app/agent/bot_templates.dart';

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/bot-vectors.json',
    'docs/bot-vectors.json',
    '../../docs/bot-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('bot-vectors.json not found (cwd=${Directory.current.path})');
}

final vectors = _loadVectors();

String? s(dynamic x) => x == null ? null : x.toString();

// paper-fill a decided order exactly as BotRunner._executeOrder does (paper path)
Map<String, dynamic> fillBuy(Map<String, dynamic> order, BigInt markUc, int bd) {
  final qty = qtyForUsd(order['usdSizeUc'] as BigInt, markUc, bd);
  return {'side': 'buy', 'qty': qty, 'priceUc': markUc, 'costUc': valueOf(qty, markUc, bd), 'bd': bd, 'paper': true};
}

Map<String, dynamic> fillSell(Map<String, dynamic> order, BigInt markUc, int bd) {
  final qty = order['qty'] as BigInt;
  return {'side': 'sell', 'qty': qty, 'priceUc': markUc, 'proceedsUc': valueOf(qty, markUc, bd), 'bd': bd, 'paper': true};
}

void main() {
  group('money/qty helpers — the pinned rounding (shared with pnl.dart semantics)', () {
    test('microUsd, qtyForUsd floors, valueOf + avgEntry round half-away', () {
      expect(microUsd(200).toString(), '200000000');
      expect(microUsd(0.01).toString(), '10000');
      expect(qtyForUsd(microUsd(100), microUsd(90), 8).toString(), '111111111');
      expect(valueOf(BigInt.parse('111111111'), microUsd(90), 8).toString(), '100000000');
      expect(avgEntryOf(microUsd(200), BigInt.parse('200000000'), 8).toString(), '100000000');
      expect(applyBps(microUsd(100), -1000).toString(), '90000000');
      expect(pctToBps(2.5), 250);
    });
  });

  test('vector dca_deal: base + 2 safety orders + TP close reproduces the fixture exactly', () {
    final v = vectors['dca_deal'] as Map<String, dynamic>;
    final cfg = validateConfig('dca', (v['config'] as Map).cast<String, dynamic>());
    final bcfg = dcaBps(cfg);
    final bd = v['decimals'] as int;
    final deal = newDcaDeal('t', 0);
    final got = <Map<String, dynamic>>[];
    for (final mUsd in (v['priceSeriesUsd'] as List)) {
      final markUc = microUsd(mUsd as num);
      dcaObserve(deal, markUc);
      var guard = 0;
      while (guard++ < 64) {
        final order = dcaStep(deal, bcfg, markUc);
        if (order == null) break;
        if (order['action'] == 'arm') {
          order['_markUc'] = markUc;
          dcaApply(deal, bcfg, order, null, 0);
          continue;
        }
        final fill = order['side'] == 'buy' ? fillBuy(order, markUc, bd) : fillSell(order, markUc, bd);
        dcaApply(deal, bcfg, order, fill, 0);
        got.add({
          'kind': order['kind'], 'side': order['side'], 'priceUc': s(markUc), 'qty': s(fill['qty']),
          'costUc': s(fill['costUc']), 'proceedsUc': s(fill['proceedsUc']),
          'avgEntryUc': s(deal['avgEntryUc']), 'filledQty': s(deal['filledQty']),
        });
        if (deal['status'] == 'closed') break;
      }
    }
    expect(got, v['fills']);
    expect(s(deal['realizedUc']), v['realizedUc']);
    expect(deal['reason'], v['closedReason']);
    expect(got.where((f) => f['side'] == 'buy').length, 3);
    expect(got.where((f) => f['side'] == 'sell').length, 1);
  });

  test('vector trailing_tp: arms at take-profit then sells on the trailing pullback', () {
    final v = vectors['trailing_tp'] as Map<String, dynamic>;
    final cfg = validateConfig('dca', (v['config'] as Map).cast<String, dynamic>());
    final bcfg = dcaBps(cfg);
    final bd = v['decimals'] as int;
    final deal = newDcaDeal('t', 0);
    final got = <Map<String, dynamic>>[];
    final events = <Map<String, dynamic>>[];
    for (final mUsd in (v['priceSeriesUsd'] as List)) {
      final markUc = microUsd(mUsd as num);
      dcaObserve(deal, markUc);
      var guard = 0;
      while (guard++ < 64) {
        final order = dcaStep(deal, bcfg, markUc);
        if (order == null) break;
        if (order['action'] == 'arm') {
          order['_markUc'] = markUc;
          dcaApply(deal, bcfg, order, null, 0);
          events.add({'at': mUsd, 'event': 'trailing-armed', 'peakUc': s(deal['peakUc'])});
          continue;
        }
        final fill = order['side'] == 'buy' ? fillBuy(order, markUc, bd) : fillSell(order, markUc, bd);
        dcaApply(deal, bcfg, order, fill, 0);
        got.add({
          'kind': order['kind'], 'side': order['side'], 'priceUc': s(markUc), 'qty': s(fill['qty']),
          'costUc': s(fill['costUc']), 'proceedsUc': s(fill['proceedsUc']), 'avgEntryUc': s(deal['avgEntryUc']),
        });
        if (deal['status'] == 'closed') break;
      }
    }
    expect(got, v['fills']);
    expect(events, v['events']);
    expect(s(deal['realizedUc']), v['realizedUc']);
    expect(got.last['priceUc'], '114000000');
  });

  test('vector grid_ladder: computed ladder + a buy->sell fill-flip reproduce the fixture', () {
    final v = vectors['grid_ladder'] as Map<String, dynamic>;
    final cfg = validateConfig('grid', (v['config'] as Map).cast<String, dynamic>());
    final bd = v['decimals'] as int;
    final midUc = BigInt.parse(v['midUc'] as String);
    final deal = newGridDeal('t', cfg, midUc, bd, 0);
    final ladder = (deal['levels'] as List)
        .map((l) => {
              'i': l['i'], 'priceUc': s(l['priceUc']), 'sizeUc': s(l['sizeUc']),
              'qty': s(l['qty']), 'side': l['side'], 'status': l['status'],
            })
        .toList();
    expect(ladder, v['ladder']);

    final steps = <Map<String, dynamic>>[];
    for (final st in (v['steps'] as List)) {
      final markUc = microUsd(st['markUsd'] as num);
      var guard = 0;
      final tickFills = <Map<String, dynamic>>[];
      while (guard++ < 64) {
        final order = gridStep(deal, markUc);
        if (order == null) break;
        final qty = order['qty'] as BigInt;
        final fill = order['side'] == 'buy'
            ? {'side': 'buy', 'qty': qty, 'priceUc': markUc, 'costUc': valueOf(qty, markUc, bd), 'paper': true}
            : {'side': 'sell', 'qty': qty, 'priceUc': markUc, 'proceedsUc': valueOf(qty, markUc, bd), 'paper': true};
        gridApply(deal, order, fill, 0);
        tickFills.add({
          'level': order['levelIndex'], 'side': order['side'], 'priceUc': s(markUc),
          'qty': s(fill['qty']), 'costUc': s(fill['costUc']), 'proceedsUc': s(fill['proceedsUc']),
        });
      }
      steps.add({
        'markUsd': st['markUsd'],
        'fills': tickFills,
        'levels': (deal['levels'] as List)
            .map((l) => {'i': l['i'], 'side': l['side'], 'status': l['status'], 'heldQty': s(l['heldQty'])})
            .toList(),
        'realizedUc': s(deal['realizedUc']),
      });
    }
    expect(steps, v['steps']);
    expect(s(deal['realizedUc']), v['realizedUc']);
  });

  test('vector smarttrade_split_tp: entry then two 50% take-profits reproduce the fixture', () {
    final v = vectors['smarttrade_split_tp'] as Map<String, dynamic>;
    final cfg = validateConfig('smarttrade', (v['config'] as Map).cast<String, dynamic>());
    final bd = v['decimals'] as int;
    final deal = newSmartTradeDeal('t', cfg, 0);
    final got = <Map<String, dynamic>>[];
    for (final mUsd in (v['priceSeriesUsd'] as List)) {
      final markUc = microUsd(mUsd as num);
      var guard = 0;
      while (guard++ < 64) {
        final order = smartStep(deal, cfg, markUc);
        if (order == null) break;
        final fill = order['side'] == 'buy' ? fillBuy(order, markUc, bd) : fillSell(order, markUc, bd);
        smartApply(deal, cfg, order, fill, 0);
        got.add({
          'kind': order['kind'], 'side': order['side'], 'priceUc': s(markUc), 'qty': s(fill['qty']),
          'costUc': s(fill['costUc']), 'proceedsUc': s(fill['proceedsUc']), 'avgEntryUc': s(deal['avgEntryUc']),
          'remainingQty': s(deal['remainingQty']), 'realizedUc': s(deal['realizedUc']),
        });
        if (deal['status'] == 'closed') break;
      }
    }
    expect(got, v['fills']);
    expect(s(deal['realizedUc']), v['realizedUc']);
    expect((deal['remainingQty'] as BigInt).toString(), '0');
  });

  test('grid: an optional whole-grid take-profit liquidates all held inventory and closes the deal', () {
    final cfg = validateConfig('grid', {'lowerPrice': 0.90, 'upperPrice': 1.10, 'gridCount': 5, 'totalUsd': 50, 'takeProfitPct': 10});
    final bcfg = gridBcfg(cfg);
    const bd = 8;
    final deal = newGridDeal('g', cfg, microUsd(1.00), bd, 0);
    Map<String, dynamic> paperFill(Map<String, dynamic> order, BigInt markUc) {
      final qty = order['qty'] as BigInt;
      return order['side'] == 'buy'
          ? {'side': 'buy', 'qty': qty, 'priceUc': markUc, 'costUc': valueOf(qty, markUc, bd), 'paper': true}
          : {'side': 'sell', 'qty': qty, 'priceUc': markUc, 'proceedsUc': valueOf(qty, markUc, bd), 'paper': true};
    }

    void run(num mUsd) {
      final markUc = microUsd(mUsd);
      var g = 0;
      while (g++ < 64) {
        final o = gridStep(deal, markUc, bcfg);
        if (o == null) break;
        gridApply(deal, o, paperFill(o, markUc), 0);
      }
    }

    run(0.95);
    expect((deal['levels'] as List).any((l) => (l['heldQty'] as BigInt) > BigInt.zero), isTrue);
    run(1.20);
    expect(deal['status'], 'closed');
    expect(deal['reason'], 'grid_exit');
    expect((deal['realizedUc'] as BigInt) > BigInt.zero, isTrue);
    expect((deal['levels'] as List).any((l) => (l['heldQty'] as BigInt) > BigInt.zero), isFalse);
  });

  group('Bot model + BotStore', () {
    test('Bot defaults: paper + disabled + testnet, validated config', () {
      final b = Bot({'type': 'dca', 'universe': {'pairs': ['SOL/USDC']}});
      expect(b.mode, 'paper');
      expect(b.enabled, false);
      expect(b.network, 'testnet');
      expect(b.allocationUsd, 0);
      expect(b.config['maxSafetyOrders'], 3);
      expect(b.config['takeProfitPct'], 2);
    });

    test('Bot: unknown type throws; grid requires a valid price range', () {
      expect(() => Bot({'type': 'nope'}), throwsA(predicate((e) => '$e'.contains('unknown bot type'))));
      expect(() => Bot({'type': 'grid', 'config': {'lowerPrice': 2, 'upperPrice': 1}}),
          throwsA(predicate((e) => '$e'.contains('lowerPrice < upperPrice'))));
    });

    test('BotStore: snapshot + load survives a restart with BigInt deal state intact', () async {
      final mem = <String, dynamic>{};
      final store = _MemStore(mem);
      final s1 = BotStore(store: store, wallet: 'w', channel: 'c');
      final bot = s1.add({'type': 'dca', 'universe': {'pairs': ['BLOCK/USDC']}, 'allocationUsd': 50});
      final byPair = bot.state['byPair'] as Map<String, dynamic>;
      final deal = newDcaDeal('d', 0);
      deal['filledQty'] = BigInt.parse('123456789');
      deal['costUc'] = BigInt.parse('987654321');
      byPair['BLOCK/USDC'] = {'deal': deal, 'lastCloseAt': 0};
      bot.state['committedUc'] = BigInt.parse('25000000');
      await s1.persist();

      final s2 = BotStore(store: store, wallet: 'w', channel: 'c');
      await s2.restore();
      final got = s2.get(bot.id);
      expect(got, isNotNull);
      final gd = (got!.state['byPair'] as Map)['BLOCK/USDC']['deal'] as Map;
      expect(gd['filledQty'], BigInt.parse('123456789'));
      expect(gd['costUc'], BigInt.parse('987654321'));
      expect(got.state['committedUc'], BigInt.parse('25000000'));
      expect(got.allocationUsd, 50);
    });

    test('BotStore: scoping keeps different (wallet,channel) stores separate', () async {
      final mem = <String, dynamic>{};
      final store = _MemStore(mem);
      final a = BotStore(store: store, wallet: 'w1', channel: 'c');
      final bb = BotStore(store: store, wallet: 'w2', channel: 'c');
      a.add({'type': 'dca', 'universe': {'pairs': ['X/USDC']}});
      await a.persist();
      await bb.persist();
      final a2 = BotStore(store: store, wallet: 'w1', channel: 'c');
      await a2.restore();
      final b2 = BotStore(store: store, wallet: 'w2', channel: 'c');
      await b2.restore();
      expect(a2.list().length, 1);
      expect(b2.list().length, 0);
    });

    test('persisted bot state carries NO key/seed/credential material', () {
      final bot = Bot({'type': 'dca', 'universe': {'pairs': ['X/USDC']}});
      final json = jsonEncode(bot.toJson());
      expect(RegExp(r'seed|mnemonic|privateKey|apiKey|secret|password', caseSensitive: false).hasMatch(json), isFalse);
    });
  });

  group('Templates: starter set + export/import', () {
    test('starter set builds valid paper+disabled bots', () {
      final names = templateList().map((t) => t['key']).toList();
      for (final key in const ['conservative_dca', 'aggressive_dca', 'wide_grid', 'scalp_grid', 'block_accumulator']) {
        expect(names.contains(key), isTrue, reason: 'has $key');
        final spec = fromTemplate(key, pair: 'BLOCK/USDC');
        final bot = Bot(spec);
        expect(bot.mode, 'paper');
        expect(bot.enabled, false);
        expect(bot.allocationUsd, 0);
      }
    });

    test('export then import round-trips the config and lands paper+disabled+testnet', () {
      final src = Bot({
        'type': 'dca', 'name': 'My DCA', 'universe': {'pairs': ['SOL/USDC']},
        'config': {'baseOrderUsd': 42, 'takeProfitPct': 3}, 'mode': 'live', 'enabled': true,
        'allocationUsd': 100, 'network': 'mainnet',
      });
      final tpl = exportBot(src);
      expect(tpl['kind'], 'blockle-bot-template');
      expect(tpl.containsKey('allocationUsd'), isFalse);
      expect(tpl.containsKey('mode'), isFalse);

      final imported = importTemplate(jsonEncode(tpl));
      expect(imported.type, 'dca');
      expect(imported.config['baseOrderUsd'], 42);
      expect(imported.config['takeProfitPct'], 3);
      expect(imported.mode, 'paper');
      expect(imported.enabled, false);
      expect(imported.network, 'testnet');
      expect(imported.allocationUsd, 0);
    });

    test('importing a malicious "live+funded" JSON still lands paper+disabled+zero alloc', () {
      final evil = {
        'kind': 'blockle-bot-template', 'type': 'dca', 'name': 'evil', 'universe': {'pairs': ['X/USDC']},
        'config': {}, 'mode': 'live', 'enabled': true, 'allocationUsd': 1000000, 'network': 'mainnet',
      };
      final b = importTemplate(evil);
      expect(b.mode, 'paper');
      expect(b.enabled, false);
      expect(b.allocationUsd, 0);
      expect(b.network, 'testnet');
    });
  });
}

class _MemStore {
  final Map<String, dynamic> mem;
  _MemStore(this.mem);
  Future<void> set(Map<String, dynamic> obj) async => mem.addAll(obj);
  Future<Map<String, dynamic>> get(List<String> keys) async {
    final r = <String, dynamic>{};
    for (final k in keys) {
      r[k] = mem[k];
    }
    return r;
  }
}
