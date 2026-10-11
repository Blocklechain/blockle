// agent/bots.js — the Blockle Bots ENGINE CORE (shared spec docs/BLOCKLE-BOTS.md
// §1-6). A persistent, non-custodial "3Commas for DEXes" layered on the in-wallet
// agent + strategy engine. This file is the REFERENCE implementation; the Dart
// (blockle-app) and Python (python/blockle) wallets must match its numbers
// EXACTLY (checked against the shared fixture docs/bot-vectors.json).
//
// SAFETY MODEL (non-negotiable, inherited from AGENT-STRATEGIES.md §0):
//   A bot is a PLANNER + a deal STATE MACHINE. It NEVER signs, broadcasts, or
//   touches keys. Every LIVE order is routed by the BotRunner (bot-runner.js)
//   through the ONE value-moving dispatch (runner.js dispatchValueMoving:
//   prepare -> assessValue -> gateConfirm -> commit -> recordSpend, with the
//   mandatory 0.05% fee + caps + allowlist + kill + hash-chained audit + mainnet
//   gate). There is no second broadcast path. PAPER mode simulates fills at the
//   ctx quote and touches NONE of that.
//
// This file holds the pure, deterministic pieces:
//   • money/qty helpers (base-unit BigInt qty, micro-dollar integer basis — the
//     SAME rounding as the §8 pnl ledger, so JS/Dart/Python reproduce the fixture).
//   • the DEAL ENGINE state machines (dca / grid / smarttrade), expressed as a pure
//     stepOnce(state, markUc) -> order? + applyFill(state, order, fill) pair so the
//     BotRunner can interpose the gate between "decide" and "apply fill".
//   • the Bot model + BotStore (persist bots + deal state per wallet/channel;
//     survives restart; NEVER any key/seed/LLM-cred material).
//
// NO key material, seeds, or LLM credentials are ever stored here — only bot
// config + deal state + the per-bot committed-spend allocation ledger, persisted
// ALONGSIDE the audit log.
//
// Exposed as global `AgentBots`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  // ===========================================================================
  // exact integer money + qty helpers (match pnl.js / strategies.js semantics)
  // ===========================================================================
  // Micro-dollars: uc = round(usd · 1e6)  (1e6 per $1, so $200 -> 200000000).
  // Prices are carried as USD-per-whole-coin in micro-dollars (priceUc).
  // Quantities are base units (BigInt), scaled by 10^decimals.

  function microUsd(usd) {
    if (usd == null || !isFinite(Number(usd))) return 0n;
    return BigInt(Math.round(Number(usd) * 1e6));
  }
  function ucToUsd(uc) { return uc == null ? null : Number(uc) / 1e6; }

  // round(num / den), half-away-from-zero. den must be > 0.
  function divRound(num, den) {
    if (den <= 0n) throw new Error('divRound: denominator must be > 0');
    if (num >= 0n) return (num + den / 2n) / den;
    return -(((-num) + den / 2n) / den);
  }
  function pow10(n) { return 10n ** BigInt(n); }

  // percent (human, e.g. 2 means 2%) -> integer basis points (200). Deterministic.
  function pctToBps(pct) { return Math.round(Number(pct) * 100); }

  // The mandatory agent fee is 0.05% (= 5 bps) of the trade, skimmed on-chain to
  // the treasury as part of the SAME gated action (tools.js swap / runner.js fee
  // leg). The per-bot allocation ledger must bound the TRUE outflow = trade + fee,
  // so it cap-checks + accrues trade+fee. BigInt-exact, half-away-from-zero.
  const AGENT_FEE_BPS = 5;
  function agentFeeUc(tradeUc) {
    if (tradeUc == null || tradeUc <= 0n) return 0n;
    return divRound(tradeUc * BigInt(AGENT_FEE_BPS), 10000n);
  }

  // base units bought/sold for `usdSizeUc` at `priceUc` (USD/coin), base dec `bd`.
  // FLOORS (BigInt division truncates toward zero for a positive numerator) — the
  // SAME floor convention as strategies.usdToBase.
  function qtyForUsd(usdSizeUc, priceUc, bd) {
    if (priceUc <= 0n || usdSizeUc <= 0n) return 0n;
    return (usdSizeUc * pow10(bd)) / priceUc;
  }
  // exact micro-dollar value of `qty` base units at `priceUc` (USD/coin), dec `bd`.
  function valueOf(qty, priceUc, bd) {
    if (qty <= 0n || priceUc <= 0n) return 0n;
    return divRound(qty * priceUc, pow10(bd));
  }
  // weighted average entry (USD/coin, micro-dollars) of `costUc` over `qty` units.
  function avgEntryOf(costUc, qty, bd) {
    if (qty <= 0n) return 0n;
    return divRound(costUc * pow10(bd), qty);
  }
  // apply a bps delta to a price: priceUc · (10000 + bps) / 10000. bps may be < 0.
  function applyBps(priceUc, bps) {
    return divRound(priceUc * BigInt(10000 + Math.round(bps)), 10000n);
  }
  // scale a USD size by volumeScale^k and return micro-dollars. volumeScale is a
  // double clamped (<=3 for the martingale leg); k is a small integer. Documented
  // rounding so Dart/Python land on the same integer.
  function scaledUsdUc(usd, volumeScale, k) {
    const f = Number(usd) * Math.pow(Number(volumeScale), k);
    return BigInt(Math.round(f * 1e6));
  }

  function splitPair(pair) {
    const parts = String(pair || '').toUpperCase().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('bad pair (want BASE/QUOTE): ' + pair);
    return [parts[0], parts[1]];
  }

  const DEFAULT_DECIMALS = {
    BLOCK: 8, BTC: 8, LTC: 8, DOGE: 8,
    USDC: 6, USDT: 6, DAI: 6, USD: 2, USDBC: 6, PYUSD: 6,
    ETH: 18, WETH: 18, SOL: 9,
  };
  function decimalsFor(sym, overrides) {
    const o = overrides && overrides[String(sym).toUpperCase()];
    if (o != null) return Number(o);
    const d = DEFAULT_DECIMALS[String(sym).toUpperCase()];
    return d != null ? d : 8;
  }

  // ===========================================================================
  // config validation + defaults per bot type
  // ===========================================================================

  const TYPES = ['dca', 'grid', 'smarttrade', 'signal', 'rebalance', 'momentum'];

  function clampNum(v, lo, hi, dflt) {
    let n = Number(v); if (!isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  function clampInt(v, lo, hi, dflt) { return Math.trunc(clampNum(v, lo, hi, dflt)); }

  function validateDcaConfig(c) {
    c = c || {};
    const out = {
      baseOrderUsd: Math.max(0, Number(c.baseOrderUsd != null ? c.baseOrderUsd : 20)),
      safetyOrderUsd: Math.max(0, Number(c.safetyOrderUsd != null ? c.safetyOrderUsd : 20)),
      maxSafetyOrders: clampInt(c.maxSafetyOrders != null ? c.maxSafetyOrders : 3, 0, 50, 3),
      safetyStepPct: Math.max(0, Number(c.safetyStepPct != null ? c.safetyStepPct : 2)),
      safetyStepScale: Math.max(0.01, Number(c.safetyStepScale != null ? c.safetyStepScale : 1.0)),
      safetyVolumeScale: clampNum(c.safetyVolumeScale != null ? c.safetyVolumeScale : 1.0, 0.01, 3, 1.0),
      takeProfitPct: Math.max(0, Number(c.takeProfitPct != null ? c.takeProfitPct : 2)),
      trailingTpPct: Math.max(0, Number(c.trailingTpPct != null ? c.trailingTpPct : 0)),
      stopLossPct: Math.max(0, Number(c.stopLossPct != null ? c.stopLossPct : 0)),
      cooldownSec: Math.max(0, Math.trunc(Number(c.cooldownSec != null ? c.cooldownSec : 0))),
      startCondition: ['asap', 'signal', 'dip'].includes(c.startCondition) ? c.startCondition : 'asap',
      dipPct: Math.max(0, Number(c.dipPct != null ? c.dipPct : 0)),
    };
    return out;
  }
  function validateGridConfig(c) {
    c = c || {};
    if (c.lowerPrice == null || c.upperPrice == null) throw new Error('grid requires lowerPrice and upperPrice');
    const lower = Number(c.lowerPrice), upper = Number(c.upperPrice);
    if (!(lower > 0) || !(upper > lower)) throw new Error('grid requires 0 < lowerPrice < upperPrice');
    return {
      lowerPrice: lower, upperPrice: upper,
      gridCount: clampInt(c.gridCount != null ? c.gridCount : 6, 2, 50, 6),
      totalUsd: Math.max(0, Number(c.totalUsd != null ? c.totalUsd : 60)),
      takeProfitPct: Math.max(0, Number(c.takeProfitPct != null ? c.takeProfitPct : 0)),
      stopLossPct: Math.max(0, Number(c.stopLossPct != null ? c.stopLossPct : 0)),
    };
  }
  function validateSmartTradeConfig(c) {
    c = c || {};
    const entry = c.entry && typeof c.entry === 'object' ? c.entry : { kind: 'market' };
    const kind = ['market', 'limit', 'ladder'].includes(entry.kind) ? entry.kind : 'market';
    let tps = Array.isArray(c.takeProfits) && c.takeProfits.length ? c.takeProfits : [{ pct: 5, sharePct: 100 }];
    tps = tps.map((t) => ({ pct: Math.max(0, Number(t.pct)), sharePct: clampNum(t.sharePct, 0, 100, 100) }));
    const sl = c.stopLoss && typeof c.stopLoss === 'object' ? c.stopLoss : { pct: 0, trailing: false };
    return {
      amountUsd: Math.max(0, Number(c.amountUsd != null ? c.amountUsd : 20)),
      entry: { kind, price: entry.price != null ? Number(entry.price) : null },
      takeProfits: tps,
      stopLoss: { pct: Math.max(0, Number(sl.pct || 0)), trailing: !!sl.trailing },
    };
  }
  function validateSignalConfig(c) {
    c = c || {};
    const onSignal = c.onSignal && typeof c.onSignal === 'object' ? c.onSignal : { type: 'dca', config: {} };
    const t = TYPES.includes(onSignal.type) ? onSignal.type : 'dca';
    return {
      source: ['discovery', 'inbox', 'both'].includes(c.source) ? c.source : 'discovery',
      maxConcurrent: clampInt(c.maxConcurrent != null ? c.maxConcurrent : 3, 1, 50, 3),
      minScore: clampNum(c.minScore != null ? c.minScore : 0, 0, 1, 0),
      onSignal: { type: t, config: validateConfig(t, onSignal.config || {}) },
    };
  }
  function validateScheduledConfig(c) {
    // rebalance / momentum reuse the strategy planners; carry their params through.
    c = c || {};
    return Object.assign({}, c);
  }
  function validateConfig(type, c) {
    switch (type) {
      case 'dca': return validateDcaConfig(c);
      case 'grid': return validateGridConfig(c);
      case 'smarttrade': return validateSmartTradeConfig(c);
      case 'signal': return validateSignalConfig(c);
      case 'rebalance':
      case 'momentum': return validateScheduledConfig(c);
      default: throw new Error('unknown bot type: ' + type);
    }
  }

  // bps-converted copy of a dca config (internal engine use).
  function dcaBps(cfg) {
    return {
      baseOrderUsd: cfg.baseOrderUsd,
      safetyOrderUsd: cfg.safetyOrderUsd,
      maxSafetyOrders: cfg.maxSafetyOrders,
      safetyStepBps: pctToBps(cfg.safetyStepPct),
      safetyStepScale: cfg.safetyStepScale,
      safetyVolumeScale: cfg.safetyVolumeScale,
      takeProfitBps: pctToBps(cfg.takeProfitPct),
      trailingTpBps: pctToBps(cfg.trailingTpPct),
      stopLossBps: pctToBps(cfg.stopLossPct),
    };
  }

  // ===========================================================================
  // DEAL ENGINE — DCA (§2.1 flagship)
  // ===========================================================================
  // A deal is one open->manage->close lifecycle. The engine is PURE: stepOnce
  // reads (deal, markUc) and returns the next order (or null); applyFill records a
  // completed fill into the deal. The BotRunner interposes the gate between them.

  function newDcaDeal(id, now) {
    return {
      id, type: 'dca', status: 'pending', openedAt: now || 0, closedAt: null,
      fills: [], filledQty: 0n, costUc: 0n, avgEntryUc: 0n,
      safetyOrdersUsed: 0, curStepBps: 0, nextTriggerUc: 0n,
      peakUc: 0n, tpArmed: false, realizedUc: 0n, reason: null,
    };
  }

  // Update peak while a trailing stop is armed (no fill). Pure-ish (mutates copy).
  function dcaObserve(deal, markUc) {
    if (deal.tpArmed && markUc > deal.peakUc) deal.peakUc = markUc;
    return deal;
  }

  // Decide the SINGLE next action for a DCA deal at `markUc`. Returns an order:
  //   { action, side, usdSizeUc?, qty?, kind }  or null when nothing to do.
  // `action:'arm'` carries no side — it is a pure trailing-stop arming (applyFill
  // records it with fill=null). The BotRunner loops stepOnce until it returns null.
  function dcaStep(deal, bcfg, markUc) {
    if (deal.status === 'closed') return null;
    if (deal.status === 'pending' || deal.filledQty <= 0n) {
      // open the deal with the base order
      return { action: 'base', side: 'buy', kind: 'base', usdSizeUc: microUsd(bcfg.baseOrderUsd) };
    }

    // --- take-profit (plain or trailing) ------------------------------------
    const tpTarget = applyBps(deal.avgEntryUc, bcfg.takeProfitBps);
    if (bcfg.trailingTpBps > 0) {
      if (deal.tpArmed) {
        const stop = applyBps(deal.peakUc, -bcfg.trailingTpBps);
        if (markUc <= stop) return { action: 'tp', side: 'sell', kind: 'tp', qty: deal.filledQty };
      } else if (markUc >= tpTarget) {
        return { action: 'arm', side: null, kind: 'arm' }; // arm trailing, no fill
      }
    } else if (markUc >= tpTarget) {
      return { action: 'tp', side: 'sell', kind: 'tp', qty: deal.filledQty };
    }

    // --- stop-loss ----------------------------------------------------------
    if (bcfg.stopLossBps > 0) {
      const sl = applyBps(deal.avgEntryUc, -bcfg.stopLossBps);
      if (markUc <= sl) return { action: 'sl', side: 'sell', kind: 'sl', qty: deal.filledQty };
    }

    // --- safety order ladder ------------------------------------------------
    if (deal.safetyOrdersUsed < bcfg.maxSafetyOrders && markUc <= deal.nextTriggerUc) {
      const k = deal.safetyOrdersUsed; // first SO uses volumeScale^0
      return { action: 'safety', side: 'buy', kind: 'safety', usdSizeUc: scaledUsdUc(bcfg.safetyOrderUsd, bcfg.safetyVolumeScale, k) };
    }
    return null;
  }

  // Record a completed fill into the DCA deal. For a buy fill:
  //   fill = { qty, priceUc, costUc }. For a sell (tp/sl): { qty, priceUc, proceedsUc }.
  // For an 'arm' order, fill is null.
  function dcaApply(deal, bcfg, order, fill, now) {
    if (order.action === 'arm') {
      deal.tpArmed = true;
      if (deal.peakUc < order._markUc) deal.peakUc = order._markUc;
      return deal;
    }
    if (order.side === 'buy') {
      deal.status = 'open';
      deal.filledQty += fill.qty;
      deal.costUc += fill.costUc;
      deal.avgEntryUc = avgEntryOf(deal.costUc, deal.filledQty, fill.bd);
      if (order.kind === 'base') {
        deal.openedAt = now || deal.openedAt;
        deal.safetyOrdersUsed = 0;
        deal.curStepBps = bcfg.safetyStepBps;
      } else {
        deal.safetyOrdersUsed += 1;
        deal.curStepBps = Math.round(deal.curStepBps * bcfg.safetyStepScale);
      }
      deal.nextTriggerUc = applyBps(fill.priceUc, -deal.curStepBps);
      deal.fills.push({ side: 'buy', kind: order.kind, priceUc: fill.priceUc, qty: fill.qty, costUc: fill.costUc, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
    } else {
      // close: whole position sold
      deal.status = 'closed';
      deal.closedAt = now || 0;
      deal.reason = order.kind; // 'tp' | 'sl'
      deal.realizedUc = (fill.proceedsUc || 0n) - deal.costUc;
      deal.fills.push({ side: 'sell', kind: order.kind, priceUc: fill.priceUc, qty: fill.qty, proceedsUc: fill.proceedsUc, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
    }
    return deal;
  }

  // ===========================================================================
  // DEAL ENGINE — GRID (§2.2)
  // ===========================================================================
  // A ladder of limit levels between lower/upper. A buy level that fills arms a
  // sell one grid UP; a sell that fills arms a buy one grid DOWN (fill-flip).
  // Level state persists. No market orders.

  function gridBuild(cfg, midUc, bd) {
    const n = cfg.gridCount;
    const lowerUc = microUsd(cfg.lowerPrice);
    const upperUc = microUsd(cfg.upperPrice);
    const spanUc = upperUc - lowerUc;
    const sizeUc = divRound(microUsd(cfg.totalUsd), BigInt(n));
    const levels = [];
    for (let i = 0; i < n; i++) {
      const priceUc = lowerUc + divRound(spanUc * BigInt(i), BigInt(n - 1));
      // seed: buy below mid, sell above mid; skip a level exactly at mid.
      let side = null;
      if (priceUc < midUc) side = 'buy';
      else if (priceUc > midUc) side = 'sell';
      const qty = qtyForUsd(sizeUc, priceUc, bd);
      levels.push({ i, priceUc, sizeUc, qty, side, status: side ? 'open' : 'idle', heldQty: 0n });
    }
    return levels;
  }

  function newGridDeal(id, cfg, midUc, bd, now) {
    return {
      id, type: 'grid', status: 'open', openedAt: now || 0, closedAt: null, bd,
      levels: gridBuild(cfg, midUc, bd), fills: [], realizedUc: 0n,
    };
  }
  // bps-converted copy of a grid config (for the optional whole-grid TP/SL exit).
  function gridBcfg(cfg) {
    return Object.assign({}, cfg, { _tpBps: pctToBps(cfg.takeProfitPct || 0), _slBps: pctToBps(cfg.stopLossPct || 0) });
  }

  // Decide the next fillable grid level at `markUc`:
  //   a BUY level fills when markUc <= its price; a SELL level when markUc >= its price.
  // Returns { action:'buy'|'sell', side, levelIndex, qty, kind:'grid' } or null.
  // An optional WHOLE-GRID take-profit/stop-loss (cfg._tpBps/_slBps) liquidates all
  // held levels (kind:'grid_exit', no re-arm) and closes the deal.
  function gridStep(deal, markUc, bcfg) {
    if (deal.status === 'closed') return null;

    // --- optional whole-grid TP/SL exit -------------------------------------
    if (bcfg && ((bcfg._tpBps > 0) || (bcfg._slBps > 0))) {
      let held = 0n, basis = 0n;
      for (const lv of deal.levels) if (lv.heldQty > 0n) { held += lv.heldQty; basis += (lv._costUc || 0n); }
      if (held > 0n && basis > 0n) {
        const val = valueOf(held, markUc, deal.bd);
        const tpHit = bcfg._tpBps > 0 && val >= divRound(basis * BigInt(10000 + bcfg._tpBps), 10000n);
        const slHit = bcfg._slBps > 0 && val <= divRound(basis * BigInt(10000 - bcfg._slBps), 10000n);
        if (tpHit || slHit) {
          for (const lv of deal.levels) {
            if (lv.heldQty > 0n) return { action: 'sell', side: 'sell', kind: 'grid_exit', exit: true, levelIndex: lv.i, qty: lv.heldQty, _levelPriceUc: lv.priceUc };
          }
        }
      }
    }

    // buys first (deterministic order): lowest index that is fillable.
    for (const lv of deal.levels) {
      if (lv.status === 'open' && lv.side === 'buy' && markUc <= lv.priceUc) {
        return { action: 'buy', side: 'buy', kind: 'grid', levelIndex: lv.i, qty: lv.qty, _levelPriceUc: lv.priceUc };
      }
    }
    for (const lv of deal.levels) {
      if (lv.status === 'open' && lv.side === 'sell' && markUc >= lv.priceUc && lv.heldQty > 0n) {
        return { action: 'sell', side: 'sell', kind: 'grid', levelIndex: lv.i, qty: lv.heldQty, _levelPriceUc: lv.priceUc };
      }
    }
    return null;
  }

  // Record a grid fill + perform the fill-flip. fill = { qty, priceUc, costUc|proceedsUc }.
  function gridApply(deal, order, fill, now) {
    const lv = deal.levels[order.levelIndex];
    // Record the exchange orderId of the live order we just placed onto its level
    // so KILL's best-effort _cancelOpenOrders can find + cancel it (paper = null).
    if (fill && fill.orderId != null) lv.orderId = fill.orderId;
    if (order.exit) {
      // whole-grid liquidation: realize, free the level, DO NOT re-arm.
      const realized = (fill.proceedsUc || 0n) - (lv._costUc || 0n);
      deal.realizedUc += realized;
      lv.status = 'exited'; lv.heldQty = 0n; lv._costUc = 0n;
      deal.fills.push({ side: 'sell', kind: 'grid_exit', level: lv.i, priceUc: fill.priceUc, qty: fill.qty, proceedsUc: fill.proceedsUc, realizedUc: realized, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
      if (!deal.levels.some((l) => l.heldQty > 0n)) { deal.status = 'closed'; deal.closedAt = now || 0; deal.reason = 'grid_exit'; }
      return deal;
    }
    if (order.side === 'buy') {
      lv.status = 'filled';
      lv.heldQty = 0n;          // inventory moves to the armed SELL one grid up
      lv._costUc = 0n;          //   (held ONCE — never double-counted in aggregation)
      deal.fills.push({ side: 'buy', kind: 'grid', level: lv.i, priceUc: fill.priceUc, qty: fill.qty, costUc: fill.costUc, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
      // arm a SELL one grid up carrying the bought inventory + its cost basis
      const up = deal.levels[order.levelIndex + 1];
      if (up) { up.side = 'sell'; up.status = 'open'; up.heldQty = fill.qty; up._costUc = fill.costUc; }
    } else {
      lv.status = 'open';     // level is freed, ready to buy again if flipped back
      lv.side = 'sell';
      const realized = (fill.proceedsUc || 0n) - (lv._costUc || 0n);
      deal.realizedUc += realized;
      lv.heldQty = 0n; lv._costUc = 0n;
      deal.fills.push({ side: 'sell', kind: 'grid', level: lv.i, priceUc: fill.priceUc, qty: fill.qty, proceedsUc: fill.proceedsUc, realizedUc: realized, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
      // arm a BUY one grid down
      const down = deal.levels[order.levelIndex - 1];
      if (down) { down.side = 'buy'; down.status = 'open'; }
    }
    return deal;
  }

  // ===========================================================================
  // DEAL ENGINE — SMARTTRADE (§2.3)
  // ===========================================================================
  // One managed position: an entry fill, then split take-profits (each sells a
  // share of the ORIGINAL position), plus an optional stop-loss (trailing opt.).

  function newSmartTradeDeal(id, cfg, now) {
    return {
      id, type: 'smarttrade', status: 'pending', openedAt: now || 0, closedAt: null,
      fills: [], entryQty: 0n, entryCostUc: 0n, avgEntryUc: 0n, remainingQty: 0n,
      tpsHit: cfg.takeProfits.map(() => false), peakUc: 0n, slArmed: false,
      realizedUc: 0n, reason: null,
    };
  }

  function smartStep(deal, cfg, markUc) {
    if (deal.status === 'closed') return null;
    if (deal.status === 'pending' || deal.entryQty <= 0n) {
      return { action: 'entry', side: 'buy', kind: 'entry', usdSizeUc: microUsd(cfg.amountUsd) };
    }
    // staged take-profits (in configured order)
    const slBps = pctToBps(cfg.stopLoss.pct);
    if (cfg.stopLoss.trailing && slBps > 0 && markUc > deal.peakUc) deal.peakUc = markUc;
    for (let t = 0; t < cfg.takeProfits.length; t++) {
      if (deal.tpsHit[t]) continue;
      const target = applyBps(deal.avgEntryUc, pctToBps(cfg.takeProfits[t].pct));
      if (markUc >= target) {
        const shareBps = pctToBps(cfg.takeProfits[t].sharePct);
        let qty = divRound(deal.entryQty * BigInt(shareBps), 10000n);
        if (qty > deal.remainingQty) qty = deal.remainingQty;
        return { action: 'tp', side: 'sell', kind: 'tp', qty, tpIndex: t };
      }
    }
    // stop-loss (plain from avg, or trailing from peak)
    if (slBps > 0 && deal.remainingQty > 0n) {
      const stop = cfg.stopLoss.trailing ? applyBps(deal.peakUc, -slBps) : applyBps(deal.avgEntryUc, -slBps);
      if (markUc <= stop) return { action: 'sl', side: 'sell', kind: 'sl', qty: deal.remainingQty };
    }
    return null;
  }

  function smartApply(deal, cfg, order, fill, now) {
    if (order.side === 'buy') {
      deal.status = 'open';
      deal.entryQty = fill.qty;
      deal.entryCostUc = fill.costUc;
      deal.remainingQty = fill.qty;
      deal.avgEntryUc = avgEntryOf(fill.costUc, fill.qty, fill.bd);
      deal.peakUc = fill.priceUc;
      deal.openedAt = now || deal.openedAt;
      deal.fills.push({ side: 'buy', kind: 'entry', priceUc: fill.priceUc, qty: fill.qty, costUc: fill.costUc, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
      return deal;
    }
    // a sell: TP share or SL remainder
    const basisUc = valueOf(fill.qty, deal.avgEntryUc, fill.bd);
    const realized = (fill.proceedsUc || 0n) - basisUc;
    deal.realizedUc += realized;
    deal.remainingQty -= fill.qty;
    if (order.kind === 'tp') deal.tpsHit[order.tpIndex] = true;
    deal.fills.push({ side: 'sell', kind: order.kind, priceUc: fill.priceUc, qty: fill.qty, proceedsUc: fill.proceedsUc, basisUc, realizedUc: realized, ts: now || 0, paper: !!fill.paper, txid: fill.txid || null });
    if (deal.remainingQty <= 0n) {
      deal.status = 'closed';
      deal.closedAt = now || 0;
      deal.reason = order.kind;
    }
    return deal;
  }

  // ===========================================================================
  // engine registry — a uniform surface the BotRunner drives
  // ===========================================================================
  const ENGINES = {
    dca: {
      newDeal: newDcaDeal, observe: dcaObserve, step: dcaStep, apply: dcaApply,
      bcfg: dcaBps,
    },
    grid: {
      newDeal: newGridDeal, observe: (d) => d, step: gridStep, apply: gridApply, bcfg: gridBcfg,
    },
    smarttrade: {
      newDeal: newSmartTradeDeal, observe: (d) => d, step: smartStep, apply: smartApply,
    },
  };

  // ===========================================================================
  // Bot model
  // ===========================================================================

  let _idSeq = 0;
  function genId(prefix) { _idSeq += 1; return (prefix || 'bot') + '_' + Date.now().toString(36) + '_' + _idSeq.toString(36); }

  class Bot {
    constructor(spec) {
      spec = spec || {};
      if (!TYPES.includes(spec.type)) throw new Error('unknown bot type: ' + spec.type);
      this.id = spec.id || genId(spec.type);
      this.name = spec.name || (spec.type + ' bot');
      this.type = spec.type;
      this.universe = spec.universe || { pairs: [] };
      this.chainPrefs = spec.chainPrefs || null;
      this.venuePrefs = spec.venuePrefs || null;
      this.config = validateConfig(spec.type, spec.config || {});
      this.allocationUsd = spec.allocationUsd != null ? Number(spec.allocationUsd) : 0;
      // SAFETY DEFAULTS (§5): paper + disabled + testnet.
      this.mode = spec.mode === 'live' ? 'live' : 'paper';
      this.enabled = spec.enabled === true ? true : false;
      this.network = spec.network === 'mainnet' ? 'mainnet' : 'testnet';
      this.pollSec = spec.pollSec != null ? Math.max(1, Math.trunc(Number(spec.pollSec))) : 60;
      this.cooldownSec = spec.cooldownSec != null ? Math.max(0, Math.trunc(Number(spec.cooldownSec))) : 0;
      this.createdAt = spec.createdAt != null ? Number(spec.createdAt) : Date.now();
      this.wallet = spec.wallet || 'default';
      this.channel = spec.channel || 'default';
      this.state = spec.state || Bot.freshState();
    }

    static freshState() {
      return {
        byPair: {},         // pairKey -> { deal, levels, lastCloseAt }
        closedDeals: [],    // archived closed deals (dashboard history)
        realizedUc: 0n,     // cumulative realized (micro-dollars)
        committedUc: 0n,    // per-bot committed LIVE spend (allocation ledger)
        dealCount: 0, winCount: 0, lossCount: 0,
        maxDrawdownUc: 0n,
        inbox: [],          // signal bot local inbox
        cursor: 0,          // signal bot processed-count cursor
        lastTickAt: 0,
      };
    }

    pairs() {
      if (this.universe && Array.isArray(this.universe.pairs)) return this.universe.pairs.slice();
      return [];
    }

    // Plain-language one-liner for the create preview (§5a).
    describe() {
      const c = this.config;
      switch (this.type) {
        case 'dca': {
          const p = this.pairs()[0] || '?';
          const base = splitPair(p + '')[0];
          return 'Buys $' + c.baseOrderUsd + ' of ' + base + ', adds up to ' + c.maxSafetyOrders +
            ' times if it dips ' + c.safetyStepPct + '%, takes profit at +' + c.takeProfitPct + '%' +
            (c.trailingTpPct > 0 ? ' (trailing ' + c.trailingTpPct + '%)' : '') + '.';
        }
        case 'grid':
          return 'Grid of ' + c.gridCount + ' levels from ' + c.lowerPrice + ' to ' + c.upperPrice + ', $' + c.totalUsd + ' total.';
        case 'smarttrade':
          return 'Buys $' + c.amountUsd + ', takes profit in ' + c.takeProfits.length + ' step(s).';
        case 'signal':
          return 'Launches a ' + c.onSignal.type + ' bot per matching ' + c.source + ' signal.';
        default:
          return this.type + ' bot.';
      }
    }

    toJSON() {
      return {
        id: this.id, name: this.name, type: this.type, universe: this.universe,
        chainPrefs: this.chainPrefs, venuePrefs: this.venuePrefs, config: this.config,
        allocationUsd: this.allocationUsd, mode: this.mode, enabled: this.enabled,
        network: this.network, pollSec: this.pollSec, cooldownSec: this.cooldownSec,
        createdAt: this.createdAt, wallet: this.wallet, channel: this.channel,
        state: encodeState(this.state),
      };
    }

    static fromJSON(obj) {
      obj = obj || {};
      const b = new Bot(Object.assign({}, obj, { state: obj.state ? decodeState(obj.state) : Bot.freshState() }));
      return b;
    }
  }

  // ---- state (de)serialization: BigInt <-> string on known money keys ---------
  const BIGINT_KEYS = new Set([
    'priceUc', 'qty', 'costUc', 'proceedsUc', 'avgEntryUc', 'nextTriggerUc', 'peakUc',
    'realizedUc', 'usdSizeUc', 'filledQty', 'sizeUc', 'committedUc', 'maxDrawdownUc',
    'heldQty', 'entryQty', 'entryCostUc', 'remainingQty', 'basisUc', '_costUc', '_levelPriceUc', '_markUc',
  ]);
  function encodeState(o) {
    return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  function decodeState(o) {
    if (Array.isArray(o)) return o.map(decodeState);
    if (o && typeof o === 'object') {
      const r = {};
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (BIGINT_KEYS.has(k) && v != null && typeof v !== 'object') r[k] = BigInt(v);
        else r[k] = decodeState(v);
      }
      return r;
    }
    return o;
  }

  // ===========================================================================
  // BotStore — persists bots + deal state per (wallet, channel). NO key material.
  // ===========================================================================
  class BotStore {
    constructor(opts) {
      opts = opts || {};
      this.store = opts.store || null;         // { set(obj), get(keys) } — chrome.storage shim
      this.storeKey = opts.key || 'agentBots';
      this.wallet = opts.wallet || 'default';
      this.channel = opts.channel || 'default';
      this.bots = new Map();                   // id -> Bot
    }

    _scopeKey() { return this.storeKey + ':' + this.wallet + ':' + this.channel; }

    add(bot) {
      if (!(bot instanceof Bot)) bot = new Bot(bot);
      bot.wallet = bot.wallet || this.wallet;
      bot.channel = bot.channel || this.channel;
      this.bots.set(bot.id, bot);
      return bot;
    }
    get(id) { return this.bots.get(id) || null; }
    remove(id) { return this.bots.delete(id); }
    list() { return Array.from(this.bots.values()); }
    enabled() { return this.list().filter((b) => b.enabled); }

    snapshot() {
      return { wallet: this.wallet, channel: this.channel, bots: this.list().map((b) => b.toJSON()) };
    }
    load(snap) {
      this.bots.clear();
      if (!snap || !Array.isArray(snap.bots)) return this;
      for (const o of snap.bots) { const b = Bot.fromJSON(o); this.bots.set(b.id, b); }
      return this;
    }
    async persist() {
      if (!this.store) return;
      try { await this.store.set({ [this._scopeKey()]: this.snapshot() }); } catch (_) {}
    }
    async restore() {
      if (!this.store || typeof this.store.get !== 'function') return this;
      try {
        const got = await this.store.get([this._scopeKey()]);
        const snap = got && got[this._scopeKey()];
        if (snap) this.load(snap);
      } catch (_) {}
      return this;
    }
  }

  const AgentBots = {
    Bot, BotStore, ENGINES, TYPES,
    // money/qty helpers (exported for the shared-vector test + the runner)
    microUsd, ucToUsd, divRound, pow10, pctToBps, qtyForUsd, valueOf, avgEntryOf,
    applyBps, scaledUsdUc, splitPair, decimalsFor, DEFAULT_DECIMALS,
    AGENT_FEE_BPS, agentFeeUc,
    // config
    validateConfig, dcaBps,
    // deal engines (pure)
    newDcaDeal, dcaObserve, dcaStep, dcaApply,
    newGridDeal, gridBuild, gridBcfg, gridStep, gridApply,
    newSmartTradeDeal, smartStep, smartApply,
    encodeState, decodeState,
    create(spec) { return new Bot(spec); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentBots;
  root.AgentBots = AgentBots;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
