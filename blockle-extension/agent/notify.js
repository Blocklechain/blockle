// agent/notify.js — the realized-profit pop-up surface (shared spec §8).
//
// A thin, non-blocking notifier. The ACTUAL platform call sits behind an
// injectable `emit(message)` so the whole thing runs headless in tests. The
// default emitter prefers `chrome.notifications` (the extension surface) and
// falls back to an in-page toast (a transient DOM element) when the
// notifications API is unavailable — e.g. the popup/content context.
//
// It only ever renders numbers the P&L engine computed from executed trades; it
// never sees or logs keys/seeds/creds. Copy (spec §8):
//   title    "+$45.00"
//   message  "+$45.00 — sold 1.5 SOL → USDC"
//   subtitle "basis $180.00 → proceeds $225.00"
//
// Exposed as global `AgentNotify`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  // ---- number/quantity formatting (deterministic) ----------------------------

  // signed USD with 2 decimals, from a Number of dollars. +$45.00 / -$1.20
  function fmtUsd(usd) {
    const n = Number(usd);
    const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
    return sign + '$' + Math.abs(n).toFixed(2);
  }
  // plain USD (no sign) for the basis→proceeds subtitle
  function fmtUsdPlain(usd) { return '$' + Math.abs(Number(usd)).toFixed(2); }

  // render a BigInt base-unit quantity with `decimals`, trimming trailing zeros.
  // decimals unknown => show the raw integer base units.
  function fmtQty(qty, decimals) {
    let q;
    try { q = BigInt(qty); } catch (_) { return String(qty); }
    const neg = q < 0n; if (neg) q = -q;
    if (decimals == null || decimals <= 0) return (neg ? '-' : '') + q.toString();
    const base = 10n ** BigInt(decimals);
    const whole = q / base;
    let frac = (q % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
  }

  // Build the pop-up copy from a realized_profit event (+ optional decimals for
  // the sold asset). Pure; no side effects.
  function format(event, decimals) {
    const qty = fmtQty(event.soldQty, decimals);
    const hasRealized = event.realizedUsd != null;
    // realized profit leads with a signed figure; proceeds-only (unknown basis)
    // leads with the plain proceeds and NEVER a fabricated "+$" profit.
    const lead = hasRealized
      ? fmtUsd(event.realizedUsd)
      : (event.proceedsUsd != null ? fmtUsdPlain(event.proceedsUsd) : '');
    const title = lead;
    let message = lead + ' — sold ' + qty + ' ' + event.asset + ' → ' + event.stable;
    if (!hasRealized) message += ' (basis unknown)';
    let subtitle = '';
    if (event.basisUsd != null && event.proceedsUsd != null) {
      subtitle = 'basis ' + fmtUsdPlain(event.basisUsd) + ' → proceeds ' + fmtUsdPlain(event.proceedsUsd);
    } else if (event.proceedsUsd != null) {
      subtitle = 'proceeds ' + fmtUsdPlain(event.proceedsUsd);
    }
    return { title, message, subtitle };
  }

  // ---- default emitters ------------------------------------------------------

  // chrome.notifications surface. Returns true if it fired.
  function chromeEmit(msg) {
    const c = (typeof chrome !== 'undefined' && chrome) || (typeof self !== 'undefined' && self.chrome) || null;
    if (!c || !c.notifications || typeof c.notifications.create !== 'function') return false;
    try {
      c.notifications.create('', {
        type: 'basic',
        iconUrl: (c.runtime && c.runtime.getURL) ? c.runtime.getURL('icons/icon128.png') : 'icons/icon128.png',
        title: msg.title,
        message: msg.message + (msg.subtitle ? '\n' + msg.subtitle : ''),
        priority: 1,
      });
      return true;
    } catch (_) { return false; }
  }

  // in-page toast fallback: a transient DOM element, auto-removed. Returns true
  // if a document was present to host it.
  function toastEmit(msg) {
    const doc = (typeof document !== 'undefined' && document) || null;
    if (!doc || !doc.body) return false;
    try {
      const el = doc.createElement('div');
      el.className = 'blockle-agent-toast';
      el.setAttribute('role', 'status');
      el.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:280px;' +
        'padding:12px 14px;border-radius:10px;background:#0b8f4f;color:#fff;' +
        'font:13px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);';
      const t = doc.createElement('div'); t.style.fontWeight = '700'; t.textContent = msg.message;
      el.appendChild(t);
      if (msg.subtitle) {
        const sub = doc.createElement('div'); sub.style.cssText = 'margin-top:3px;opacity:.85;';
        sub.textContent = msg.subtitle; el.appendChild(sub);
      }
      doc.body.appendChild(el);
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 7000);
      return true;
    } catch (_) { return false; }
  }

  // The real default emitter: chrome.notifications, else in-page toast, else
  // no-op. Overridable via Notifier({ emit }) so tests capture headlessly.
  function defaultEmit(msg) {
    if (chromeEmit(msg)) return true;
    if (toastEmit(msg)) return true;
    return false;
  }

  class Notifier {
    constructor(opts) {
      opts = opts || {};
      // injectable emitter: (message:{title,message,subtitle}) => any
      this.emit = typeof opts.emit === 'function' ? opts.emit : defaultEmit;
      this.sink = typeof opts.sink === 'function' ? opts.sink : null; // raw-event tap
    }

    // payload: { event: realized_profit event, decimals?: number }
    notify(payload) {
      payload = payload || {};
      const event = payload.event || payload;
      const msg = format(event, payload.decimals);
      if (this.sink) { try { this.sink(event, msg); } catch (_) {} }
      return this.emit(msg);
    }
  }

  const AgentNotify = {
    create(opts) { return new Notifier(opts); },
    Notifier, format, fmtUsd, fmtUsdPlain, fmtQty,
    chromeEmit, toastEmit, defaultEmit,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentNotify;
  root.AgentNotify = AgentNotify;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
