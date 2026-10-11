// agent/bot-templates.js — starter bot presets + template export/import (§6).
//
// A bot config is an exportable/importable JSON "Blockle Bot template". The
// starter set lets a first-timer create a working bot in seconds (§5a). IMPORT
// NEVER auto-starts a live bot — it always lands as `paper` + `disabled` +
// `testnet` with a zero allocation, so the user must explicitly review + arm it
// (the arming + allocation + mainnet gates are never skipped).
//
// Exposed as global `AgentBotTemplates`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  function dep(name, file) {
    if (root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    throw new Error('bot-templates dependency not loaded: ' + name);
  }

  const TEMPLATE_VERSION = 1;

  // Each template is a safe, paper-friendly preset. `pair` is a placeholder the
  // create flow / a signal substitutes. All default paper + disabled + testnet.
  const TEMPLATES = {
    conservative_dca: {
      name: 'Conservative DCA',
      type: 'dca',
      blurb: 'Steady accumulation: small base order, patient safety ladder, modest take-profit.',
      universe: { pairs: ['SOL/USDC'] },
      config: {
        baseOrderUsd: 20, safetyOrderUsd: 20, maxSafetyOrders: 3,
        safetyStepPct: 2, safetyStepScale: 1.0, safetyVolumeScale: 1.0,
        takeProfitPct: 2, trailingTpPct: 0, stopLossPct: 0,
        cooldownSec: 0, startCondition: 'asap',
      },
    },
    aggressive_dca: {
      name: 'Aggressive DCA',
      type: 'dca',
      blurb: 'Wider steps, martingale sizing, higher take-profit. Higher risk.',
      universe: { pairs: ['SOL/USDC'] },
      config: {
        baseOrderUsd: 25, safetyOrderUsd: 25, maxSafetyOrders: 4,
        safetyStepPct: 3, safetyStepScale: 1.2, safetyVolumeScale: 1.5,
        takeProfitPct: 3, trailingTpPct: 1, stopLossPct: 0,
        cooldownSec: 0, startCondition: 'asap',
      },
    },
    wide_grid: {
      name: 'Wide Grid',
      type: 'grid',
      blurb: 'A broad ladder for ranging markets — buy low, sell a grid up, repeat.',
      universe: { pairs: ['BLOCK/USDC'] },
      config: { lowerPrice: 0.8, upperPrice: 1.2, gridCount: 8, totalUsd: 80, takeProfitPct: 0, stopLossPct: 0 },
    },
    scalp_grid: {
      name: 'Scalp Grid',
      type: 'grid',
      blurb: 'A tight ladder for small, frequent moves.',
      universe: { pairs: ['BLOCK/USDC'] },
      config: { lowerPrice: 0.97, upperPrice: 1.03, gridCount: 12, totalUsd: 60, takeProfitPct: 0, stopLossPct: 0 },
    },
    block_accumulator: {
      name: 'BLOCK Accumulator',
      type: 'dca',
      blurb: 'Accumulate BLOCK on dips with a deep safety ladder; no stop-loss, no rush.',
      universe: { pairs: ['BLOCK/USDC'] },
      config: {
        baseOrderUsd: 15, safetyOrderUsd: 15, maxSafetyOrders: 5,
        safetyStepPct: 4, safetyStepScale: 1.1, safetyVolumeScale: 1.2,
        takeProfitPct: 5, trailingTpPct: 2, stopLossPct: 0,
        cooldownSec: 3600, startCondition: 'dip', dipPct: 3,
      },
    },
  };

  function list() {
    return Object.keys(TEMPLATES).map((key) => ({
      key, name: TEMPLATES[key].name, type: TEMPLATES[key].type, blurb: TEMPLATES[key].blurb,
    }));
  }

  // Build a Bot spec from a template. The caller supplies pair + allocationUsd;
  // the result is ALWAYS paper + disabled + testnet (never auto-armed).
  function fromTemplate(key, opts) {
    opts = opts || {};
    const t = TEMPLATES[key];
    if (!t) throw new Error('unknown template: ' + key);
    const pairs = opts.pair ? [String(opts.pair).toUpperCase()] : (t.universe && t.universe.pairs) || [];
    return {
      name: opts.name || t.name,
      type: t.type,
      universe: { pairs: pairs.slice() },
      config: Object.assign({}, t.config),
      allocationUsd: 0,          // must be set explicitly at live-arm time
      mode: 'paper',
      enabled: false,
      network: 'testnet',
      template: key,
    };
  }

  // Export a bot's config as a portable template JSON (NO state, NO keys, NO
  // allocation/mode/enabled — a template is a recipe, not a running bot).
  function exportBot(bot) {
    const b = bot && typeof bot.toJSON === 'function' ? bot : bot;
    return {
      kind: 'blockle-bot-template',
      version: TEMPLATE_VERSION,
      name: b.name,
      type: b.type,
      universe: b.universe || { pairs: [] },
      chainPrefs: b.chainPrefs || null,
      venuePrefs: b.venuePrefs || null,
      config: b.config,
    };
  }

  // Import a template JSON into a fresh Bot SPEC. ALWAYS lands paper + disabled +
  // testnet with zero allocation, regardless of what the JSON claimed — import can
  // never auto-arm or carry live funds. Returns a spec for BotStore.add / Bot.
  function importTemplate(json) {
    const Bots = dep('AgentBots', './bots.js');
    let obj = json;
    if (typeof json === 'string') { obj = JSON.parse(json); }
    if (!obj || typeof obj !== 'object') throw new Error('invalid template JSON');
    if (obj.kind && obj.kind !== 'blockle-bot-template') throw new Error('not a blockle-bot-template');
    if (!Bots.TYPES.includes(obj.type)) throw new Error('unknown bot type in template: ' + obj.type);
    const spec = {
      name: obj.name || (obj.type + ' bot'),
      type: obj.type,
      universe: obj.universe || { pairs: [] },
      chainPrefs: obj.chainPrefs || null,
      venuePrefs: obj.venuePrefs || null,
      config: obj.config || {},
      // HARD safety: import is always paper + disabled + testnet + no allocation.
      allocationUsd: 0,
      mode: 'paper',
      enabled: false,
      network: 'testnet',
      imported: true,
    };
    return new Bots.Bot(spec);
  }

  const AgentBotTemplates = {
    TEMPLATES, TEMPLATE_VERSION, list, fromTemplate, exportBot, importTemplate,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentBotTemplates;
  root.AgentBotTemplates = AgentBotTemplates;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
