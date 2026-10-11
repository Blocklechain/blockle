// agent/bots.dart — the Blockle Bots ENGINE CORE (Dart port of
// blockle-extension/agent/bots.js; shared spec docs/BLOCKLE-BOTS.md §1-6). A
// persistent, non-custodial "3Commas for DEXes" layered on the in-wallet agent +
// strategy engine. This file is numerically IDENTICAL to the JS reference and the
// Python wallet — checked against the AUTHORITATIVE fixture docs/bot-vectors.json.
//
// SAFETY MODEL (non-negotiable, inherited from AGENT-STRATEGIES.md §0):
//   A bot is a PLANNER + a deal STATE MACHINE. It NEVER signs, broadcasts, or
//   touches keys. Every LIVE order is routed by the BotRunner (bot_runner.dart)
//   through the ONE value-moving dispatch (runner.dart dispatchValueMoving:
//   prepare -> assessValue -> gateConfirm -> commit -> recordSpend, with the
//   mandatory 0.05% fee + caps + allowlist + kill + hash-chained audit + mainnet
//   gate). There is no second broadcast path. PAPER mode simulates fills at the
//   ctx quote and touches NONE of that.
//
// This file holds the pure, deterministic pieces:
//   • money/qty helpers (base-unit BigInt qty, micro-dollar integer basis — the
//     SAME rounding as the §8 pnl ledger, so JS/Dart/Python reproduce the fixture).
//   • the DEAL ENGINE state machines (dca / grid / smarttrade), expressed as a
//     pure step(state, markUc) -> order? + apply(state, order, fill) pair so the
//     BotRunner can interpose the gate between "decide" and "apply fill".
//   • the Bot model + BotStore (persist bots + deal state per wallet/channel;
//     survives restart; NEVER any key/seed/LLM-cred material).
//
// Deal/level/order/fill state is carried as Map<String, dynamic> with BigInt money
// values — mirroring the JS reference object shapes exactly so the shared vectors
// reproduce digit-for-digit and the BigInt (de)serialization is trivial.

import 'dart:math' as math;

// ===========================================================================
// exact integer money + qty helpers (match pnl.dart / strategies.dart semantics)
// ===========================================================================
// Micro-dollars: uc = round(usd · 1e6)  (1e6 per $1, so $200 -> 200000000).
// Prices are carried as USD-per-whole-coin in micro-dollars (priceUc).
// Quantities are base units (BigInt), scaled by 10^decimals.

BigInt microUsd(num? usd) {
  if (usd == null || !usd.isFinite) return BigInt.zero;
  return BigInt.from((usd.toDouble() * 1e6).round());
}

double? ucToUsd(BigInt? uc) => uc == null ? null : uc.toDouble() / 1e6;

/// round(num / den), half-away-from-zero. [den] must be > 0.
BigInt divRound(BigInt num, BigInt den) {
  if (den <= BigInt.zero) throw ArgumentError('divRound: denominator must be > 0');
  final half = den ~/ BigInt.two;
  if (num >= BigInt.zero) return (num + half) ~/ den;
  return -(((-num) + half) ~/ den);
}

BigInt pow10(int n) => BigInt.from(10).pow(n);

/// percent (human, e.g. 2 means 2%) -> integer basis points (200). Deterministic.
int pctToBps(num pct) => (pct.toDouble() * 100).round();

/// The mandatory agent fee is 0.05% (= 5 bps) of the trade, skimmed on-chain to
/// the treasury as part of the SAME gated action (tools.dart swap / runner.dart
/// fee leg). The per-bot allocation ledger must bound the TRUE outflow = trade +
/// fee, so it cap-checks + accrues trade+fee. BigInt-exact, half-away-from-zero.
const int kAgentFeeBps = 5;
BigInt agentFeeUc(BigInt? tradeUc) {
  if (tradeUc == null || tradeUc <= BigInt.zero) return BigInt.zero;
  return divRound(tradeUc * BigInt.from(kAgentFeeBps), BigInt.from(10000));
}

/// base units bought/sold for [usdSizeUc] at [priceUc] (USD/coin), base dec [bd].
/// FLOORS — the SAME floor convention as strategies.usdToBase.
BigInt qtyForUsd(BigInt usdSizeUc, BigInt priceUc, int bd) {
  if (priceUc <= BigInt.zero || usdSizeUc <= BigInt.zero) return BigInt.zero;
  return (usdSizeUc * pow10(bd)) ~/ priceUc;
}

/// exact micro-dollar value of [qty] base units at [priceUc] (USD/coin), dec [bd].
BigInt valueOf(BigInt qty, BigInt priceUc, int bd) {
  if (qty <= BigInt.zero || priceUc <= BigInt.zero) return BigInt.zero;
  return divRound(qty * priceUc, pow10(bd));
}

/// weighted average entry (USD/coin, micro-dollars) of [costUc] over [qty] units.
BigInt avgEntryOf(BigInt costUc, BigInt qty, int bd) {
  if (qty <= BigInt.zero) return BigInt.zero;
  return divRound(costUc * pow10(bd), qty);
}

/// apply a bps delta to a price: priceUc · (10000 + bps) / 10000. bps may be < 0.
BigInt applyBps(BigInt priceUc, int bps) =>
    divRound(priceUc * BigInt.from(10000 + bps), BigInt.from(10000));

/// scale a USD size by volumeScale^k and return micro-dollars. Documented rounding
/// so Dart/Python land on the same integer as the JS reference.
BigInt scaledUsdUc(num usd, num volumeScale, int k) {
  final f = usd.toDouble() * math.pow(volumeScale.toDouble(), k).toDouble();
  return BigInt.from((f * 1e6).round());
}

List<String> splitPair(dynamic pair) {
  final parts = '${pair ?? ''}'.toUpperCase().split('/');
  if (parts.length != 2 || parts[0].isEmpty || parts[1].isEmpty) {
    throw ArgumentError('bad pair (want BASE/QUOTE): $pair');
  }
  return [parts[0], parts[1]];
}

const Map<String, int> kDefaultDecimals = {
  'BLOCK': 8, 'BTC': 8, 'LTC': 8, 'DOGE': 8,
  'USDC': 6, 'USDT': 6, 'DAI': 6, 'USD': 2, 'USDBC': 6, 'PYUSD': 6,
  'ETH': 18, 'WETH': 18, 'SOL': 9,
};

int decimalsFor(String sym, [Map<String, dynamic>? overrides]) {
  final up = sym.toUpperCase();
  final o = overrides == null ? null : overrides[up];
  if (o != null) return (o as num).toInt();
  final d = kDefaultDecimals[up];
  return d ?? 8;
}

// ===========================================================================
// config validation + defaults per bot type
// ===========================================================================

const List<String> kBotTypes = [
  'dca', 'grid', 'smarttrade', 'signal', 'rebalance', 'momentum',
];

num _num(dynamic v, num dflt) {
  if (v == null) return dflt;
  final n = v is num ? v : num.tryParse('$v');
  return (n == null || !n.isFinite) ? dflt : n;
}

num _clampNum(dynamic v, num lo, num hi, num dflt) {
  var n = _num(v, dflt);
  return math.max(lo, math.min(hi, n));
}

int _clampInt(dynamic v, num lo, num hi, num dflt) =>
    _clampNum(v, lo, hi, dflt).truncate();

Map<String, dynamic> _validateDcaConfig(Map<String, dynamic>? c) {
  c = c ?? const {};
  return {
    'baseOrderUsd': math.max(0, _num(c['baseOrderUsd'], 20)),
    'safetyOrderUsd': math.max(0, _num(c['safetyOrderUsd'], 20)),
    'maxSafetyOrders': _clampInt(c['maxSafetyOrders'] ?? 3, 0, 50, 3),
    'safetyStepPct': math.max(0, _num(c['safetyStepPct'], 2)),
    'safetyStepScale': math.max(0.01, _num(c['safetyStepScale'], 1.0)),
    'safetyVolumeScale': _clampNum(c['safetyVolumeScale'] ?? 1.0, 0.01, 3, 1.0),
    'takeProfitPct': math.max(0, _num(c['takeProfitPct'], 2)),
    'trailingTpPct': math.max(0, _num(c['trailingTpPct'], 0)),
    'stopLossPct': math.max(0, _num(c['stopLossPct'], 0)),
    'cooldownSec': math.max(0, _num(c['cooldownSec'], 0).truncate()),
    'startCondition': const ['asap', 'signal', 'dip'].contains(c['startCondition'])
        ? c['startCondition']
        : 'asap',
    'dipPct': math.max(0, _num(c['dipPct'], 0)),
  };
}

Map<String, dynamic> _validateGridConfig(Map<String, dynamic>? c) {
  c = c ?? const {};
  if (c['lowerPrice'] == null || c['upperPrice'] == null) {
    throw ArgumentError('grid requires lowerPrice and upperPrice');
  }
  final lower = _num(c['lowerPrice'], 0).toDouble();
  final upper = _num(c['upperPrice'], 0).toDouble();
  if (!(lower > 0) || !(upper > lower)) {
    throw ArgumentError('grid requires 0 < lowerPrice < upperPrice');
  }
  return {
    'lowerPrice': lower,
    'upperPrice': upper,
    'gridCount': _clampInt(c['gridCount'] ?? 6, 2, 50, 6),
    'totalUsd': math.max(0, _num(c['totalUsd'], 60)),
    'takeProfitPct': math.max(0, _num(c['takeProfitPct'], 0)),
    'stopLossPct': math.max(0, _num(c['stopLossPct'], 0)),
  };
}

Map<String, dynamic> _validateSmartTradeConfig(Map<String, dynamic>? c) {
  c = c ?? const {};
  final entry = c['entry'] is Map
      ? (c['entry'] as Map).cast<String, dynamic>()
      : <String, dynamic>{'kind': 'market'};
  final kind = const ['market', 'limit', 'ladder'].contains(entry['kind'])
      ? entry['kind']
      : 'market';
  var tps = (c['takeProfits'] is List && (c['takeProfits'] as List).isNotEmpty)
      ? (c['takeProfits'] as List)
      : [
          {'pct': 5, 'sharePct': 100}
        ];
  final tpsOut = tps
      .map((t) => {
            'pct': math.max(0, _num((t as Map)['pct'], 0)),
            'sharePct': _clampNum(t['sharePct'], 0, 100, 100),
          })
      .toList();
  final sl = c['stopLoss'] is Map
      ? (c['stopLoss'] as Map).cast<String, dynamic>()
      : <String, dynamic>{'pct': 0, 'trailing': false};
  return {
    'amountUsd': math.max(0, _num(c['amountUsd'], 20)),
    'entry': {'kind': kind, 'price': entry['price'] != null ? _num(entry['price'], 0) : null},
    'takeProfits': tpsOut,
    'stopLoss': {'pct': math.max(0, _num(sl['pct'], 0)), 'trailing': sl['trailing'] == true},
  };
}

Map<String, dynamic> _validateSignalConfig(Map<String, dynamic>? c) {
  c = c ?? const {};
  final onSignal = c['onSignal'] is Map
      ? (c['onSignal'] as Map).cast<String, dynamic>()
      : <String, dynamic>{'type': 'dca', 'config': <String, dynamic>{}};
  final t = kBotTypes.contains(onSignal['type']) ? onSignal['type'] as String : 'dca';
  return {
    'source': const ['discovery', 'inbox', 'both'].contains(c['source']) ? c['source'] : 'discovery',
    'maxConcurrent': _clampInt(c['maxConcurrent'] ?? 3, 1, 50, 3),
    'minScore': _clampNum(c['minScore'] ?? 0, 0, 1, 0),
    'onSignal': {
      'type': t,
      'config': validateConfig(
          t, (onSignal['config'] as Map?)?.cast<String, dynamic>() ?? const {}),
    },
  };
}

Map<String, dynamic> _validateScheduledConfig(Map<String, dynamic>? c) =>
    {...?c};

Map<String, dynamic> validateConfig(String type, Map<String, dynamic>? c) {
  switch (type) {
    case 'dca':
      return _validateDcaConfig(c);
    case 'grid':
      return _validateGridConfig(c);
    case 'smarttrade':
      return _validateSmartTradeConfig(c);
    case 'signal':
      return _validateSignalConfig(c);
    case 'rebalance':
    case 'momentum':
      return _validateScheduledConfig(c);
    default:
      throw ArgumentError('unknown bot type: $type');
  }
}

/// bps-converted copy of a dca config (internal engine use).
Map<String, dynamic> dcaBps(Map<String, dynamic> cfg) => {
      'baseOrderUsd': cfg['baseOrderUsd'],
      'safetyOrderUsd': cfg['safetyOrderUsd'],
      'maxSafetyOrders': cfg['maxSafetyOrders'],
      'safetyStepBps': pctToBps(cfg['safetyStepPct'] as num),
      'safetyStepScale': cfg['safetyStepScale'],
      'safetyVolumeScale': cfg['safetyVolumeScale'],
      'takeProfitBps': pctToBps(cfg['takeProfitPct'] as num),
      'trailingTpBps': pctToBps((cfg['trailingTpPct'] ?? 0) as num),
      'stopLossBps': pctToBps((cfg['stopLossPct'] ?? 0) as num),
    };

// ===========================================================================
// DEAL ENGINE — DCA (§2.1 flagship)
// ===========================================================================

Map<String, dynamic> newDcaDeal(String id, int now) => {
      'id': id, 'type': 'dca', 'status': 'pending', 'openedAt': now, 'closedAt': null,
      'fills': <dynamic>[], 'filledQty': BigInt.zero, 'costUc': BigInt.zero,
      'avgEntryUc': BigInt.zero, 'safetyOrdersUsed': 0, 'curStepBps': 0,
      'nextTriggerUc': BigInt.zero, 'peakUc': BigInt.zero, 'tpArmed': false,
      'realizedUc': BigInt.zero, 'reason': null,
    };

/// Update peak while a trailing stop is armed (no fill).
Map<String, dynamic> dcaObserve(Map<String, dynamic> deal, BigInt markUc) {
  if (deal['tpArmed'] == true && markUc > (deal['peakUc'] as BigInt)) {
    deal['peakUc'] = markUc;
  }
  return deal;
}

/// Decide the SINGLE next action for a DCA deal at [markUc]. Returns an order map
/// or null when nothing to do. `action:'arm'` carries no side — a pure trailing-
/// stop arming (apply records it with fill=null).
Map<String, dynamic>? dcaStep(
    Map<String, dynamic> deal, Map<String, dynamic> bcfg, BigInt markUc) {
  if (deal['status'] == 'closed') return null;
  if (deal['status'] == 'pending' || (deal['filledQty'] as BigInt) <= BigInt.zero) {
    return {'action': 'base', 'side': 'buy', 'kind': 'base', 'usdSizeUc': microUsd(bcfg['baseOrderUsd'] as num)};
  }

  final avgEntryUc = deal['avgEntryUc'] as BigInt;
  final tpBps = bcfg['takeProfitBps'] as int;
  final trailBps = bcfg['trailingTpBps'] as int;
  final tpTarget = applyBps(avgEntryUc, tpBps);

  // --- take-profit (plain or trailing) ------------------------------------
  if (trailBps > 0) {
    if (deal['tpArmed'] == true) {
      final stop = applyBps(deal['peakUc'] as BigInt, -trailBps);
      if (markUc <= stop) return {'action': 'tp', 'side': 'sell', 'kind': 'tp', 'qty': deal['filledQty']};
    } else if (markUc >= tpTarget) {
      return {'action': 'arm', 'side': null, 'kind': 'arm'};
    }
  } else if (markUc >= tpTarget) {
    return {'action': 'tp', 'side': 'sell', 'kind': 'tp', 'qty': deal['filledQty']};
  }

  // --- stop-loss ----------------------------------------------------------
  final slBps = bcfg['stopLossBps'] as int;
  if (slBps > 0) {
    final sl = applyBps(avgEntryUc, -slBps);
    if (markUc <= sl) return {'action': 'sl', 'side': 'sell', 'kind': 'sl', 'qty': deal['filledQty']};
  }

  // --- safety order ladder ------------------------------------------------
  final used = deal['safetyOrdersUsed'] as int;
  if (used < (bcfg['maxSafetyOrders'] as int) && markUc <= (deal['nextTriggerUc'] as BigInt)) {
    return {
      'action': 'safety', 'side': 'buy', 'kind': 'safety',
      'usdSizeUc': scaledUsdUc(bcfg['safetyOrderUsd'] as num, bcfg['safetyVolumeScale'] as num, used),
    };
  }
  return null;
}

/// Record a completed fill into the DCA deal. For a buy fill:
///   fill = { qty, priceUc, costUc, bd }. For a sell (tp/sl): { qty, priceUc, proceedsUc, bd }.
/// For an 'arm' order, fill is null.
Map<String, dynamic> dcaApply(Map<String, dynamic> deal, Map<String, dynamic> bcfg,
    Map<String, dynamic> order, Map<String, dynamic>? fill, int now) {
  if (order['action'] == 'arm') {
    deal['tpArmed'] = true;
    final mk = order['_markUc'] as BigInt;
    if ((deal['peakUc'] as BigInt) < mk) deal['peakUc'] = mk;
    return deal;
  }
  if (order['side'] == 'buy') {
    final bd = fill!['bd'] as int;
    deal['status'] = 'open';
    deal['filledQty'] = (deal['filledQty'] as BigInt) + (fill['qty'] as BigInt);
    deal['costUc'] = (deal['costUc'] as BigInt) + (fill['costUc'] as BigInt);
    deal['avgEntryUc'] = avgEntryOf(deal['costUc'] as BigInt, deal['filledQty'] as BigInt, bd);
    if (order['kind'] == 'base') {
      deal['openedAt'] = now;
      deal['safetyOrdersUsed'] = 0;
      deal['curStepBps'] = bcfg['safetyStepBps'];
    } else {
      deal['safetyOrdersUsed'] = (deal['safetyOrdersUsed'] as int) + 1;
      deal['curStepBps'] =
          ((deal['curStepBps'] as int) * (bcfg['safetyStepScale'] as num)).round();
    }
    deal['nextTriggerUc'] = applyBps(fill['priceUc'] as BigInt, -(deal['curStepBps'] as int));
    (deal['fills'] as List).add({
      'side': 'buy', 'kind': order['kind'], 'priceUc': fill['priceUc'], 'qty': fill['qty'],
      'costUc': fill['costUc'], 'ts': now, 'paper': fill['paper'] == true, 'txid': fill['txid'],
    });
  } else {
    deal['status'] = 'closed';
    deal['closedAt'] = now;
    deal['reason'] = order['kind'];
    deal['realizedUc'] =
        ((fill!['proceedsUc'] as BigInt?) ?? BigInt.zero) - (deal['costUc'] as BigInt);
    (deal['fills'] as List).add({
      'side': 'sell', 'kind': order['kind'], 'priceUc': fill['priceUc'], 'qty': fill['qty'],
      'proceedsUc': fill['proceedsUc'], 'ts': now, 'paper': fill['paper'] == true, 'txid': fill['txid'],
    });
  }
  return deal;
}

// ===========================================================================
// DEAL ENGINE — GRID (§2.2)
// ===========================================================================

List<Map<String, dynamic>> gridBuild(Map<String, dynamic> cfg, BigInt midUc, int bd) {
  final n = cfg['gridCount'] as int;
  final lowerUc = microUsd(cfg['lowerPrice'] as num);
  final upperUc = microUsd(cfg['upperPrice'] as num);
  final spanUc = upperUc - lowerUc;
  final sizeUc = divRound(microUsd(cfg['totalUsd'] as num), BigInt.from(n));
  final levels = <Map<String, dynamic>>[];
  for (var i = 0; i < n; i++) {
    final priceUc = lowerUc + divRound(spanUc * BigInt.from(i), BigInt.from(n - 1));
    String? side;
    if (priceUc < midUc) {
      side = 'buy';
    } else if (priceUc > midUc) {
      side = 'sell';
    }
    final qty = qtyForUsd(sizeUc, priceUc, bd);
    levels.add({
      'i': i, 'priceUc': priceUc, 'sizeUc': sizeUc, 'qty': qty, 'side': side,
      'status': side != null ? 'open' : 'idle', 'heldQty': BigInt.zero,
    });
  }
  return levels;
}

Map<String, dynamic> newGridDeal(
        String id, Map<String, dynamic> cfg, BigInt midUc, int bd, int now) =>
    {
      'id': id, 'type': 'grid', 'status': 'open', 'openedAt': now, 'closedAt': null, 'bd': bd,
      'levels': gridBuild(cfg, midUc, bd), 'fills': <dynamic>[], 'realizedUc': BigInt.zero,
    };

/// bps-converted copy of a grid config (for the optional whole-grid TP/SL exit).
Map<String, dynamic> gridBcfg(Map<String, dynamic> cfg) => {
      ...cfg,
      '_tpBps': pctToBps((cfg['takeProfitPct'] ?? 0) as num),
      '_slBps': pctToBps((cfg['stopLossPct'] ?? 0) as num),
    };

/// Decide the next fillable grid level at [markUc] (or null).
Map<String, dynamic>? gridStep(
    Map<String, dynamic> deal, BigInt markUc, [Map<String, dynamic>? bcfg]) {
  if (deal['status'] == 'closed') return null;
  final levels = (deal['levels'] as List).cast<Map<String, dynamic>>();
  final bd = deal['bd'] as int;

  // --- optional whole-grid TP/SL exit -------------------------------------
  final tpBps = (bcfg?['_tpBps'] ?? 0) as int;
  final slBps = (bcfg?['_slBps'] ?? 0) as int;
  if (tpBps > 0 || slBps > 0) {
    var held = BigInt.zero, basis = BigInt.zero;
    for (final lv in levels) {
      if ((lv['heldQty'] as BigInt) > BigInt.zero) {
        held += lv['heldQty'] as BigInt;
        basis += (lv['_costUc'] as BigInt?) ?? BigInt.zero;
      }
    }
    if (held > BigInt.zero && basis > BigInt.zero) {
      final val = valueOf(held, markUc, bd);
      final tpHit = tpBps > 0 && val >= divRound(basis * BigInt.from(10000 + tpBps), BigInt.from(10000));
      final slHit = slBps > 0 && val <= divRound(basis * BigInt.from(10000 - slBps), BigInt.from(10000));
      if (tpHit || slHit) {
        for (final lv in levels) {
          if ((lv['heldQty'] as BigInt) > BigInt.zero) {
            return {
              'action': 'sell', 'side': 'sell', 'kind': 'grid_exit', 'exit': true,
              'levelIndex': lv['i'], 'qty': lv['heldQty'], '_levelPriceUc': lv['priceUc'],
            };
          }
        }
      }
    }
  }

  // buys first (deterministic order): lowest index that is fillable.
  for (final lv in levels) {
    if (lv['status'] == 'open' && lv['side'] == 'buy' && markUc <= (lv['priceUc'] as BigInt)) {
      return {
        'action': 'buy', 'side': 'buy', 'kind': 'grid', 'levelIndex': lv['i'],
        'qty': lv['qty'], '_levelPriceUc': lv['priceUc'],
      };
    }
  }
  for (final lv in levels) {
    if (lv['status'] == 'open' &&
        lv['side'] == 'sell' &&
        markUc >= (lv['priceUc'] as BigInt) &&
        (lv['heldQty'] as BigInt) > BigInt.zero) {
      return {
        'action': 'sell', 'side': 'sell', 'kind': 'grid', 'levelIndex': lv['i'],
        'qty': lv['heldQty'], '_levelPriceUc': lv['priceUc'],
      };
    }
  }
  return null;
}

/// Record a grid fill + perform the fill-flip.
Map<String, dynamic> gridApply(
    Map<String, dynamic> deal, Map<String, dynamic> order, Map<String, dynamic> fill, int now) {
  final levels = (deal['levels'] as List).cast<Map<String, dynamic>>();
  final lv = levels[order['levelIndex'] as int];
  // Record the exchange orderId of the live order we just placed onto its level
  // so KILL's best-effort _cancelOpenOrders can find + cancel it (paper = null).
  if (fill['orderId'] != null) lv['orderId'] = fill['orderId'];
  if (order['exit'] == true) {
    final realized = ((fill['proceedsUc'] as BigInt?) ?? BigInt.zero) - ((lv['_costUc'] as BigInt?) ?? BigInt.zero);
    deal['realizedUc'] = (deal['realizedUc'] as BigInt) + realized;
    lv['status'] = 'exited';
    lv['heldQty'] = BigInt.zero;
    lv['_costUc'] = BigInt.zero;
    (deal['fills'] as List).add({
      'side': 'sell', 'kind': 'grid_exit', 'level': lv['i'], 'priceUc': fill['priceUc'],
      'qty': fill['qty'], 'proceedsUc': fill['proceedsUc'], 'realizedUc': realized, 'ts': now,
      'paper': fill['paper'] == true, 'txid': fill['txid'],
    });
    if (!levels.any((l) => (l['heldQty'] as BigInt) > BigInt.zero)) {
      deal['status'] = 'closed';
      deal['closedAt'] = now;
      deal['reason'] = 'grid_exit';
    }
    return deal;
  }
  if (order['side'] == 'buy') {
    lv['status'] = 'filled';
    lv['heldQty'] = BigInt.zero;
    lv['_costUc'] = BigInt.zero;
    (deal['fills'] as List).add({
      'side': 'buy', 'kind': 'grid', 'level': lv['i'], 'priceUc': fill['priceUc'],
      'qty': fill['qty'], 'costUc': fill['costUc'], 'ts': now, 'paper': fill['paper'] == true, 'txid': fill['txid'],
    });
    final up = (order['levelIndex'] as int) + 1 < levels.length ? levels[(order['levelIndex'] as int) + 1] : null;
    if (up != null) {
      up['side'] = 'sell';
      up['status'] = 'open';
      up['heldQty'] = fill['qty'];
      up['_costUc'] = fill['costUc'];
    }
  } else {
    lv['status'] = 'open';
    lv['side'] = 'sell';
    final realized = ((fill['proceedsUc'] as BigInt?) ?? BigInt.zero) - ((lv['_costUc'] as BigInt?) ?? BigInt.zero);
    deal['realizedUc'] = (deal['realizedUc'] as BigInt) + realized;
    lv['heldQty'] = BigInt.zero;
    lv['_costUc'] = BigInt.zero;
    (deal['fills'] as List).add({
      'side': 'sell', 'kind': 'grid', 'level': lv['i'], 'priceUc': fill['priceUc'],
      'qty': fill['qty'], 'proceedsUc': fill['proceedsUc'], 'realizedUc': realized, 'ts': now,
      'paper': fill['paper'] == true, 'txid': fill['txid'],
    });
    final down = (order['levelIndex'] as int) - 1 >= 0 ? levels[(order['levelIndex'] as int) - 1] : null;
    if (down != null) {
      down['side'] = 'buy';
      down['status'] = 'open';
    }
  }
  return deal;
}

// ===========================================================================
// DEAL ENGINE — SMARTTRADE (§2.3)
// ===========================================================================

Map<String, dynamic> newSmartTradeDeal(String id, Map<String, dynamic> cfg, int now) => {
      'id': id, 'type': 'smarttrade', 'status': 'pending', 'openedAt': now, 'closedAt': null,
      'fills': <dynamic>[], 'entryQty': BigInt.zero, 'entryCostUc': BigInt.zero,
      'avgEntryUc': BigInt.zero, 'remainingQty': BigInt.zero,
      'tpsHit': List<bool>.filled((cfg['takeProfits'] as List).length, false),
      'peakUc': BigInt.zero, 'slArmed': false, 'realizedUc': BigInt.zero, 'reason': null,
    };

Map<String, dynamic>? smartStep(
    Map<String, dynamic> deal, Map<String, dynamic> cfg, BigInt markUc) {
  if (deal['status'] == 'closed') return null;
  if (deal['status'] == 'pending' || (deal['entryQty'] as BigInt) <= BigInt.zero) {
    return {'action': 'entry', 'side': 'buy', 'kind': 'entry', 'usdSizeUc': microUsd(cfg['amountUsd'] as num)};
  }
  final sl = (cfg['stopLoss'] as Map).cast<String, dynamic>();
  final slBps = pctToBps(sl['pct'] as num);
  if (sl['trailing'] == true && slBps > 0 && markUc > (deal['peakUc'] as BigInt)) {
    deal['peakUc'] = markUc;
  }
  final tps = (cfg['takeProfits'] as List).cast<Map<String, dynamic>>();
  final tpsHit = (deal['tpsHit'] as List).cast<bool>();
  for (var t = 0; t < tps.length; t++) {
    if (tpsHit[t]) continue;
    final target = applyBps(deal['avgEntryUc'] as BigInt, pctToBps(tps[t]['pct'] as num));
    if (markUc >= target) {
      final shareBps = pctToBps(tps[t]['sharePct'] as num);
      var qty = divRound((deal['entryQty'] as BigInt) * BigInt.from(shareBps), BigInt.from(10000));
      if (qty > (deal['remainingQty'] as BigInt)) qty = deal['remainingQty'] as BigInt;
      return {'action': 'tp', 'side': 'sell', 'kind': 'tp', 'qty': qty, 'tpIndex': t};
    }
  }
  if (slBps > 0 && (deal['remainingQty'] as BigInt) > BigInt.zero) {
    final stop = sl['trailing'] == true
        ? applyBps(deal['peakUc'] as BigInt, -slBps)
        : applyBps(deal['avgEntryUc'] as BigInt, -slBps);
    if (markUc <= stop) return {'action': 'sl', 'side': 'sell', 'kind': 'sl', 'qty': deal['remainingQty']};
  }
  return null;
}

Map<String, dynamic> smartApply(Map<String, dynamic> deal, Map<String, dynamic> cfg,
    Map<String, dynamic> order, Map<String, dynamic> fill, int now) {
  final bd = fill['bd'] as int;
  if (order['side'] == 'buy') {
    deal['status'] = 'open';
    deal['entryQty'] = fill['qty'];
    deal['entryCostUc'] = fill['costUc'];
    deal['remainingQty'] = fill['qty'];
    deal['avgEntryUc'] = avgEntryOf(fill['costUc'] as BigInt, fill['qty'] as BigInt, bd);
    deal['peakUc'] = fill['priceUc'];
    deal['openedAt'] = now;
    (deal['fills'] as List).add({
      'side': 'buy', 'kind': 'entry', 'priceUc': fill['priceUc'], 'qty': fill['qty'],
      'costUc': fill['costUc'], 'ts': now, 'paper': fill['paper'] == true, 'txid': fill['txid'],
    });
    return deal;
  }
  final basisUc = valueOf(fill['qty'] as BigInt, deal['avgEntryUc'] as BigInt, bd);
  final realized = ((fill['proceedsUc'] as BigInt?) ?? BigInt.zero) - basisUc;
  deal['realizedUc'] = (deal['realizedUc'] as BigInt) + realized;
  deal['remainingQty'] = (deal['remainingQty'] as BigInt) - (fill['qty'] as BigInt);
  if (order['kind'] == 'tp') (deal['tpsHit'] as List)[order['tpIndex'] as int] = true;
  (deal['fills'] as List).add({
    'side': 'sell', 'kind': order['kind'], 'priceUc': fill['priceUc'], 'qty': fill['qty'],
    'proceedsUc': fill['proceedsUc'], 'basisUc': basisUc, 'realizedUc': realized, 'ts': now,
    'paper': fill['paper'] == true, 'txid': fill['txid'],
  });
  if ((deal['remainingQty'] as BigInt) <= BigInt.zero) {
    deal['status'] = 'closed';
    deal['closedAt'] = now;
    deal['reason'] = order['kind'];
  }
  return deal;
}

// ===========================================================================
// Bot model
// ===========================================================================

int _idSeq = 0;
String _genId(String prefix) {
  _idSeq += 1;
  return '${prefix}_${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}_${_idSeq.toRadixString(36)}';
}

class Bot {
  String id;
  String name;
  String type;
  Map<String, dynamic> universe;
  dynamic chainPrefs;
  dynamic venuePrefs;
  Map<String, dynamic> config;
  double allocationUsd;
  String mode; // 'paper' | 'live'
  bool enabled;
  String network; // 'testnet' | 'mainnet'
  int pollSec;
  int cooldownSec;
  int createdAt;
  String wallet;
  String channel;
  Map<String, dynamic> state;

  Bot(Map<String, dynamic> spec)
      : id = spec['id'] as String? ?? _genId('${spec['type']}'),
        name = spec['name'] as String? ?? '${spec['type']} bot',
        type = spec['type'] as String,
        universe = (spec['universe'] as Map?)?.cast<String, dynamic>() ?? {'pairs': <dynamic>[]},
        chainPrefs = spec['chainPrefs'],
        venuePrefs = spec['venuePrefs'],
        config = validateConfig(
            spec['type'] as String, (spec['config'] as Map?)?.cast<String, dynamic>()),
        allocationUsd = spec['allocationUsd'] != null ? (spec['allocationUsd'] as num).toDouble() : 0,
        mode = spec['mode'] == 'live' ? 'live' : 'paper',
        enabled = spec['enabled'] == true,
        network = spec['network'] == 'mainnet' ? 'mainnet' : 'testnet',
        pollSec = spec['pollSec'] != null ? math.max(1, (spec['pollSec'] as num).truncate()) : 60,
        cooldownSec = spec['cooldownSec'] != null ? math.max(0, (spec['cooldownSec'] as num).truncate()) : 0,
        createdAt = spec['createdAt'] != null
            ? (spec['createdAt'] as num).toInt()
            : DateTime.now().millisecondsSinceEpoch,
        wallet = spec['wallet'] as String? ?? 'default',
        channel = spec['channel'] as String? ?? 'default',
        state = (spec['state'] as Map?)?.cast<String, dynamic>() ?? Bot.freshState() {
    if (!kBotTypes.contains(type)) throw ArgumentError('unknown bot type: $type');
  }

  static Map<String, dynamic> freshState() => {
        'byPair': <String, dynamic>{},
        'closedDeals': <dynamic>[],
        'realizedUc': BigInt.zero,
        'committedUc': BigInt.zero,
        'dealCount': 0, 'winCount': 0, 'lossCount': 0,
        'maxDrawdownUc': BigInt.zero,
        'inbox': <dynamic>[],
        'cursor': 0,
        'lastTickAt': 0,
      };

  List<String> pairs() {
    final p = universe['pairs'];
    if (p is List) return p.map((e) => '$e').toList();
    return const [];
  }

  /// Plain-language one-liner for the create preview (§5a).
  String describe() {
    final c = config;
    switch (type) {
      case 'dca':
        final p = pairs().isNotEmpty ? pairs()[0] : '?';
        final base = splitPair(p)[0];
        final trailing = (c['trailingTpPct'] as num) > 0 ? ' (trailing ${c['trailingTpPct']}%)' : '';
        return 'Buys \$${c['baseOrderUsd']} of $base, adds up to ${c['maxSafetyOrders']} '
            'times if it dips ${c['safetyStepPct']}%, takes profit at +${c['takeProfitPct']}%$trailing.';
      case 'grid':
        return 'Grid of ${c['gridCount']} levels from ${c['lowerPrice']} to ${c['upperPrice']}, \$${c['totalUsd']} total.';
      case 'smarttrade':
        return 'Buys \$${c['amountUsd']}, takes profit in ${(c['takeProfits'] as List).length} step(s).';
      case 'signal':
        return 'Launches a ${(c['onSignal'] as Map)['type']} bot per matching ${c['source']} signal.';
      default:
        return '$type bot.';
    }
  }

  Map<String, dynamic> toJson() => {
        'id': id, 'name': name, 'type': type, 'universe': universe,
        'chainPrefs': chainPrefs, 'venuePrefs': venuePrefs, 'config': config,
        'allocationUsd': allocationUsd, 'mode': mode, 'enabled': enabled,
        'network': network, 'pollSec': pollSec, 'cooldownSec': cooldownSec,
        'createdAt': createdAt, 'wallet': wallet, 'channel': channel,
        'state': encodeState(state),
      };

  static Bot fromJson(Map<String, dynamic> obj) => Bot({
        ...obj,
        'state': obj['state'] != null
            ? decodeState((obj['state'] as Map).cast<String, dynamic>())
            : Bot.freshState(),
      });
}

// ---- state (de)serialization: BigInt <-> string on known money keys ---------
const Set<String> _bigIntKeys = {
  'priceUc', 'qty', 'costUc', 'proceedsUc', 'avgEntryUc', 'nextTriggerUc', 'peakUc',
  'realizedUc', 'usdSizeUc', 'filledQty', 'sizeUc', 'committedUc', 'maxDrawdownUc',
  'heldQty', 'entryQty', 'entryCostUc', 'remainingQty', 'basisUc', '_costUc',
  '_levelPriceUc', '_markUc',
};

dynamic encodeState(dynamic o) {
  if (o is BigInt) return o.toString();
  if (o is Map) return {for (final e in o.entries) '${e.key}': encodeState(e.value)};
  if (o is List) return o.map(encodeState).toList();
  return o;
}

dynamic decodeState(dynamic o) {
  if (o is List) return o.map(decodeState).toList();
  if (o is Map) {
    final r = <String, dynamic>{};
    o.forEach((k, v) {
      final kk = '$k';
      if (_bigIntKeys.contains(kk) && v != null && v is! Map && v is! List) {
        r[kk] = BigInt.parse('$v');
      } else {
        r[kk] = decodeState(v);
      }
    });
    return r;
  }
  return o;
}

// ===========================================================================
// BotStore — persists bots + deal state per (wallet, channel). NO key material.
// ===========================================================================

/// A minimal key/value store shim (the chrome.storage get/set shape), duck-typed:
///   Future<void> set(Map<String,dynamic> obj);
///   Future<Map<String,dynamic>> get(List<String> keys);
class BotStore {
  final dynamic store;
  final String storeKey;
  final String wallet;
  final String channel;
  final Map<String, Bot> bots = {};

  BotStore({this.store, String? key, String? wallet, String? channel})
      : storeKey = key ?? 'agentBots',
        wallet = wallet ?? 'default',
        channel = channel ?? 'default';

  String _scopeKey() => '$storeKey:$wallet:$channel';

  Bot add(dynamic bot) {
    final b = bot is Bot ? bot : Bot((bot as Map).cast<String, dynamic>());
    bots[b.id] = b;
    return b;
  }

  Bot? get(String id) => bots[id];
  bool remove(String id) => bots.remove(id) != null;
  List<Bot> list() => bots.values.toList();
  List<Bot> enabled() => list().where((b) => b.enabled).toList();

  Map<String, dynamic> snapshot() =>
      {'wallet': wallet, 'channel': channel, 'bots': list().map((b) => b.toJson()).toList()};

  BotStore load(Map<String, dynamic>? snap) {
    bots.clear();
    if (snap == null || snap['bots'] is! List) return this;
    for (final o in (snap['bots'] as List)) {
      final b = Bot.fromJson((o as Map).cast<String, dynamic>());
      bots[b.id] = b;
    }
    return this;
  }

  Future<void> persist() async {
    if (store == null) return;
    try {
      await store.set({_scopeKey(): snapshot()});
    } catch (_) {}
  }

  Future<BotStore> restore() async {
    if (store == null) return this;
    try {
      final got = await store.get([_scopeKey()]);
      final snap = got is Map ? got[_scopeKey()] : null;
      if (snap is Map) load(snap.cast<String, dynamic>());
    } catch (_) {}
    return this;
  }
}

Bot createBot(Map<String, dynamic> spec) => Bot(spec);
