// agent/bot_templates.dart — starter bot presets + template export/import (§6;
// Dart port of blockle-extension/agent/bot-templates.js).
//
// A bot config is an exportable/importable JSON "Blockle Bot template". The
// starter set lets a first-timer create a working bot in seconds (§5a). IMPORT
// NEVER auto-starts a live bot — it always lands as `paper` + `disabled` +
// `testnet` with a zero allocation, so the user must explicitly review + arm it
// (the arming + allocation + mainnet gates are never skipped).

import 'dart:convert';

import 'bots.dart';

const int kTemplateVersion = 1;

/// Each template is a safe, paper-friendly preset. `pair` is a placeholder the
/// create flow / a signal substitutes. All default paper + disabled + testnet.
const Map<String, Map<String, dynamic>> kTemplates = {
  'conservative_dca': {
    'name': 'Conservative DCA',
    'type': 'dca',
    'blurb': 'Steady accumulation: small base order, patient safety ladder, modest take-profit.',
    'universe': {
      'pairs': ['SOL/USDC']
    },
    'config': {
      'baseOrderUsd': 20, 'safetyOrderUsd': 20, 'maxSafetyOrders': 3,
      'safetyStepPct': 2, 'safetyStepScale': 1.0, 'safetyVolumeScale': 1.0,
      'takeProfitPct': 2, 'trailingTpPct': 0, 'stopLossPct': 0,
      'cooldownSec': 0, 'startCondition': 'asap',
    },
  },
  'aggressive_dca': {
    'name': 'Aggressive DCA',
    'type': 'dca',
    'blurb': 'Wider steps, martingale sizing, higher take-profit. Higher risk.',
    'universe': {
      'pairs': ['SOL/USDC']
    },
    'config': {
      'baseOrderUsd': 25, 'safetyOrderUsd': 25, 'maxSafetyOrders': 4,
      'safetyStepPct': 3, 'safetyStepScale': 1.2, 'safetyVolumeScale': 1.5,
      'takeProfitPct': 3, 'trailingTpPct': 1, 'stopLossPct': 0,
      'cooldownSec': 0, 'startCondition': 'asap',
    },
  },
  'wide_grid': {
    'name': 'Wide Grid',
    'type': 'grid',
    'blurb': 'A broad ladder for ranging markets — buy low, sell a grid up, repeat.',
    'universe': {
      'pairs': ['BLOCK/USDC']
    },
    'config': {'lowerPrice': 0.8, 'upperPrice': 1.2, 'gridCount': 8, 'totalUsd': 80, 'takeProfitPct': 0, 'stopLossPct': 0},
  },
  'scalp_grid': {
    'name': 'Scalp Grid',
    'type': 'grid',
    'blurb': 'A tight ladder for small, frequent moves.',
    'universe': {
      'pairs': ['BLOCK/USDC']
    },
    'config': {'lowerPrice': 0.97, 'upperPrice': 1.03, 'gridCount': 12, 'totalUsd': 60, 'takeProfitPct': 0, 'stopLossPct': 0},
  },
  'block_accumulator': {
    'name': 'BLOCK Accumulator',
    'type': 'dca',
    'blurb': 'Accumulate BLOCK on dips with a deep safety ladder; no stop-loss, no rush.',
    'universe': {
      'pairs': ['BLOCK/USDC']
    },
    'config': {
      'baseOrderUsd': 15, 'safetyOrderUsd': 15, 'maxSafetyOrders': 5,
      'safetyStepPct': 4, 'safetyStepScale': 1.1, 'safetyVolumeScale': 1.2,
      'takeProfitPct': 5, 'trailingTpPct': 2, 'stopLossPct': 0,
      'cooldownSec': 3600, 'startCondition': 'dip', 'dipPct': 3,
    },
  },
};

List<Map<String, dynamic>> templateList() => kTemplates.entries
    .map((e) => {
          'key': e.key, 'name': e.value['name'], 'type': e.value['type'], 'blurb': e.value['blurb'],
        })
    .toList();

/// Build a Bot spec from a template. The caller supplies pair + allocationUsd;
/// the result is ALWAYS paper + disabled + testnet (never auto-armed).
Map<String, dynamic> fromTemplate(String key, {String? pair, String? name}) {
  final t = kTemplates[key];
  if (t == null) throw ArgumentError('unknown template: $key');
  final pairs = pair != null
      ? [pair.toUpperCase()]
      : List<String>.from((t['universe'] as Map?)?['pairs'] as List? ?? const []);
  return {
    'name': name ?? t['name'],
    'type': t['type'],
    'universe': {'pairs': List.of(pairs)},
    'config': Map<String, dynamic>.from(t['config'] as Map),
    'allocationUsd': 0,
    'mode': 'paper',
    'enabled': false,
    'network': 'testnet',
    'template': key,
  };
}

/// Export a bot's config as a portable template JSON (NO state, NO keys, NO
/// allocation/mode/enabled — a template is a recipe, not a running bot).
Map<String, dynamic> exportBot(Bot bot) => {
      'kind': 'blockle-bot-template',
      'version': kTemplateVersion,
      'name': bot.name,
      'type': bot.type,
      'universe': bot.universe,
      'chainPrefs': bot.chainPrefs,
      'venuePrefs': bot.venuePrefs,
      'config': bot.config,
    };

/// Import a template JSON into a fresh [Bot]. ALWAYS lands paper + disabled +
/// testnet with zero allocation, regardless of what the JSON claimed — import can
/// never auto-arm or carry live funds.
Bot importTemplate(dynamic json) {
  dynamic obj = json;
  if (json is String) obj = jsonDecode(json);
  if (obj is! Map) throw ArgumentError('invalid template JSON');
  final o = obj.cast<String, dynamic>();
  if (o['kind'] != null && o['kind'] != 'blockle-bot-template') {
    throw ArgumentError('not a blockle-bot-template');
  }
  if (!kBotTypes.contains(o['type'])) {
    throw ArgumentError('unknown bot type in template: ${o['type']}');
  }
  return Bot({
    'name': o['name'] ?? '${o['type']} bot',
    'type': o['type'],
    'universe': o['universe'] ?? {'pairs': <dynamic>[]},
    'chainPrefs': o['chainPrefs'],
    'venuePrefs': o['venuePrefs'],
    'config': o['config'] ?? <String, dynamic>{},
    // HARD safety: import is always paper + disabled + testnet + no allocation.
    'allocationUsd': 0,
    'mode': 'paper',
    'enabled': false,
    'network': 'testnet',
    'imported': true,
  });
}
