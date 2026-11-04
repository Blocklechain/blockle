// agent/candles.js — CANDLE-BASED EXIT TRIGGERS for the bot engine. The deal
// engines (bots.js) exit on FIXED percentages (take-profit / stop-loss), which
// is honest but slow: a +6% target can take days while the token runs +4% and
// gives it all back. This module turns the bot's own tick stream into OHLC
// candles and fires a SMART TAKE-PROFIT the moment a winning position shows a
// reversal on a CLOSED candle:
//
//   lowerLow  — the last closed candle is bearish AND closes below the previous
//               candle's low (the run just printed a lower low)
//   emaCross  — the fast EMA of closes crosses under the slow EMA
//   wick      — a long upper wick (≥60% of the candle's range) with a red close:
//               buyers were rejected at the top
//   giveback  — the deal has handed back more than `giveback` (fraction) of its
//               peak profit since the trigger armed
//
// All four only fire while the deal is IN PROFIT by at least `minProfitPct`, so
// a losing position is never dumped by a wiggle (the engine's own stop-loss and
// the bot's max-loss rail handle losses). Evaluated on CLOSED candles only — a
// forming candle never triggers, so a single spike can't fake a reversal.
//
// PURE: no I/O, no clock (the caller passes `now`). Shared by every wallet
// (JS here, Dart candles.dart) — same math, same decisions.
//
// Exposed as global `AgentCandles`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: false,   // engines stay fixture-identical unless a bot opts in
    sec: 60,          // candle length in seconds
    minProfitPct: 1.5,// arm only once the deal is up this much
    lowerLow: true,
    emaCross: true,
    wick: true,
    giveback: 0.5,    // 0 disables; 0.5 = exit after giving back half the peak gain
    emaFast: 5,
    emaSlow: 13,
    maxCandles: 120,
  };

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Normalize a bot's `candle` config (undefined → disabled defaults).
  function validate(c) {
    c = c && typeof c === 'object' ? c : {};
    const on = c.enabled === true || c.enabled === 'true' || c.enabled === 1;
    return {
      enabled: on,
      sec: Math.round(clamp(num(c.sec, DEFAULTS.sec), 15, 86400)),
      minProfitPct: clamp(num(c.minProfitPct, DEFAULTS.minProfitPct), 0, 1000),
      lowerLow: c.lowerLow !== false,
      emaCross: c.emaCross !== false,
      wick: c.wick !== false,
      giveback: clamp(num(c.giveback, DEFAULTS.giveback), 0, 0.95),
      emaFast: Math.round(clamp(num(c.emaFast, DEFAULTS.emaFast), 2, 50)),
      emaSlow: Math.round(clamp(num(c.emaSlow, DEFAULTS.emaSlow), 3, 200)),
      maxCandles: Math.round(clamp(num(c.maxCandles, DEFAULTS.maxCandles), 20, 2000)),
    };
  }

  // Fold a price sample into the series. Returns { series, closed } where
  // `closed` is the candle that just finalized (a new bucket began), else null.
  function update(series, price, nowMs, sec, maxCandles) {
    const s = Array.isArray(series) ? series : [];
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return { series: s, closed: null };
    const width = Math.max(1, Math.round(Number(sec) || DEFAULTS.sec)) * 1000;
    const bucket = Math.floor(Number(nowMs) / width) * width;
    const last = s[s.length - 1];
    let closed = null;
    if (!last || last.t !== bucket) {
      if (last && last.t < bucket) closed = last;
      s.push({ t: bucket, o: p, h: p, l: p, c: p, n: 1 });
      const max = Math.max(20, Number(maxCandles) || DEFAULTS.maxCandles);
      if (s.length > max) s.splice(0, s.length - max);
    } else {
      if (p > last.h) last.h = p;
      if (p < last.l) last.l = p;
      last.c = p; last.n = (last.n || 0) + 1;
    }
    return { series: s, closed };
  }

  // Exponential moving average series of `values` with period n (seeded by SMA).
  function ema(values, n) {
    const out = [];
    if (!values.length) return out;
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      if (i < n - 1) { out.push(null); continue; }
      if (prev == null) {
        let sum = 0; for (let j = i - n + 1; j <= i; j++) sum += values[j];
        prev = sum / n;
      } else {
        prev = values[i] * k + prev * (1 - k);
      }
      out.push(prev);
    }
    return out;
  }

  // Decide whether a profitable deal should exit NOW. `state` is a small mutable
  // bag the caller persists per pair ({ peakProfitPct }) so the giveback rule
  // survives restarts. Returns { exit, reason, profitPct, peakProfitPct }.
  function evaluateExit(series, entryUsd, markUsd, cfg, state) {
    cfg = validate(cfg);
    state = state || {};
    const entry = Number(entryUsd), mark = Number(markUsd);
    const res = { exit: false, reason: null, profitPct: null, peakProfitPct: state.peakProfitPct || 0 };
    if (!cfg.enabled || !(entry > 0) || !(mark > 0)) return res;
    const profitPct = (mark / entry - 1) * 100;
    res.profitPct = profitPct;
    if (profitPct > (state.peakProfitPct || 0)) state.peakProfitPct = profitPct;
    res.peakProfitPct = state.peakProfitPct || 0;
    if (profitPct < cfg.minProfitPct) return res;

    // only CLOSED candles count: the last element is the forming candle.
    const closed = (Array.isArray(series) ? series : []).slice(0, -1);
    const last = closed[closed.length - 1], prev = closed[closed.length - 2];

    if (cfg.giveback > 0 && state.peakProfitPct >= cfg.minProfitPct * 2 && profitPct <= state.peakProfitPct * (1 - cfg.giveback)) {
      return Object.assign(res, { exit: true, reason: 'giveback' });
    }
    if (last && prev && cfg.lowerLow && last.c < last.o && last.c < prev.l) {
      return Object.assign(res, { exit: true, reason: 'lower-low' });
    }
    if (last && cfg.wick) {
      const range = last.h - last.l;
      const upper = last.h - Math.max(last.o, last.c);
      if (range > 0 && last.c < last.o && upper / range >= 0.6) return Object.assign(res, { exit: true, reason: 'wick-rejection' });
    }
    if (cfg.emaCross && closed.length >= cfg.emaSlow + 1) {
      const closes = closed.map((c) => c.c);
      const f = ema(closes, cfg.emaFast), s = ema(closes, cfg.emaSlow);
      const i = closes.length - 1;
      if (f[i] != null && s[i] != null && f[i - 1] != null && s[i - 1] != null && f[i] < s[i] && f[i - 1] >= s[i - 1]) {
        return Object.assign(res, { exit: true, reason: 'ema-cross' });
      }
    }
    return res;
  }

  const LABELS = { 'lower-low': 'lower low on the candle', 'wick-rejection': 'wick rejection', 'ema-cross': 'EMA cross down', giveback: 'gave back half the gain' };
  function label(reason) { return LABELS[reason] || reason || ''; }

  const AgentCandles = { DEFAULTS, validate, update, ema, evaluateExit, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentCandles;
  root.AgentCandles = AgentCandles;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
