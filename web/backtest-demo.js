// backtest-demo.js — home-page "which strategy made the most money?" board.
// Loads /backtest.json (a paper backtest of EVERY strategy over the last 30 days on REAL prices,
// see scripts/backtest-snapshot.mjs), ranks most-profitable first, draws a sparkline per strategy,
// and offers one-click USE THIS STRATEGY (deep-links the wallet's bot-create flow, pre-filled).
// HONEST: real prices + the real paper simulator; a backtest, not a live account, not a guarantee.
(function () {
  'use strict';
  var host = document.getElementById('backtest-demo');
  if (!host) return;
  var SRC = host.getAttribute('data-src') || '/backtest.json';
  var WALLET = host.getAttribute('data-wallet') || '/wallet';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }

  function css() {
    if (document.getElementById('bt-css')) return;
    var s = document.createElement('style'); s.id = 'bt-css';
    s.textContent = [
      '.bt{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(0,0,0,.6)}',
      '.bt .bhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:13px 16px;border-bottom:1px solid var(--line)}',
      '.bt .ttl{font-weight:700;font-size:14px}.bt .sub{font-family:var(--mono);font-size:11.5px;color:var(--faint)}',
      '.bt .up{color:var(--gain)}.bt .down{color:var(--loss)}',
      '.bt .list{max-height:420px;overflow-y:auto}',
      '.bt .row{display:grid;grid-template-columns:26px 1fr 84px 70px auto;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--line)}',
      '.bt .row:last-child{border-bottom:0}.bt .row.win{background:color-mix(in srgb,var(--accent) 9%,transparent)}',
      '.bt .rk{font-family:var(--mono);font-size:12px;color:var(--faint);text-align:center}',
      '.bt .nm{font-weight:600;font-size:13px;line-height:1.15}.bt .nm small{display:block;font-weight:400;color:var(--faint);font-size:10.5px;font-family:var(--mono)}',
      '.bt .spark{width:84px;height:28px;display:block}',
      '.bt .ret{font-family:var(--mono);font-weight:700;font-size:14px;text-align:right;font-variant-numeric:tabular-nums}',
      '.bt .ret small{display:block;font-weight:400;font-size:10px;color:var(--faint)}',
      '.bt .use{appearance:none;border:1px solid var(--accent);background:transparent;color:var(--accent);font:inherit;font-size:11.5px;font-weight:600;padding:6px 11px;border-radius:999px;cursor:pointer;white-space:nowrap;text-decoration:none}',
      '.bt .use:hover{background:var(--accent);color:#fff}',
      '.bt .bfoot{padding:9px 16px 13px;font-size:11px;color:var(--faint);border-top:1px solid var(--line)}',
      '@media(max-width:560px){.bt .row{grid-template-columns:22px 1fr 60px auto;gap:8px}.bt .spark{display:none}}',
    ].join('');
    document.head.appendChild(s);
  }

  function spark(curve) {
    var W = 84, H = 28, n = curve.length, lo = Math.min.apply(null, curve), hi = Math.max.apply(null, curve);
    var span = (hi - lo) || 1, d = '';
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * (W - 2) + 1, y = (1 - (curve[i] - lo) / span) * (H - 4) + 2;
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    var up = curve[curve.length - 1] >= 0;
    var zeroY = (1 - (0 - lo) / span) * (H - 4) + 2;
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<line x1="1" y1="' + zeroY.toFixed(1) + '" x2="' + (W - 1) + '" y2="' + zeroY.toFixed(1) + '" stroke="var(--faint)" stroke-width="0.6" stroke-dasharray="2 3" opacity="0.5"/>' +
      '<path d="' + d.trim() + '" fill="none" stroke="' + (up ? 'var(--gain)' : 'var(--loss)') + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function render(data) {
    var strat = data.strategies || [];
    var rows = strat.map(function (s, i) {
      var cls = s.pnlPct >= 0 ? 'up' : 'down';
      var useUrl = WALLET + '?strategy=' + encodeURIComponent(s.type);
      return '<div class="row' + (i === 0 ? ' win' : '') + '">' +
        '<div class="rk">' + (i + 1) + '</div>' +
        '<div class="nm">' + esc((s.label || s.type).split(' — ')[0]) + '<small>' + esc((s.label || '').split(' — ')[1] || '') + ' · ' + s.trades + ' trades</small></div>' +
        spark(s.curve) +
        '<div class="ret ' + cls + '">' + pct(s.pnlPct) + '<small>−' + Number(s.maxDrawdownPct).toFixed(1) + '% dd</small></div>' +
        '<a class="use" href="' + useUrl + '">USE THIS →</a>' +
        '</div>';
    }).join('');
    var mv = data.assetMovePct, mvCls = mv >= 0 ? 'up' : 'down';
    host.innerHTML = '<div class="bt">' +
      '<div class="bhead"><span class="ttl">Which strategy made the most money?</span>' +
      '<span class="sub">last ' + esc(data.windowLabel || '30 days') + ' · real ' + esc(data.symbol) + '/USD · ' + esc(data.symbol) + ' itself <span class="' + mvCls + '">' + pct(mv) + '</span></span></div>' +
      '<div class="list">' + rows + '</div>' +
      '<div class="bfoot">Paper backtest of all ' + strat.length + ' strategies on <b>real ' + esc(data.symbol) + '/USD prices</b> over the last ' + esc(data.windowLabel || '30 days') + ' — identical $' + (data.budget || 1000) + ' budget + default settings, the same engine the wallet runs. ' +
      'Past performance is <b>not a guarantee</b>; a backtest, not a live account. Crypto is volatile; you can lose money. Not investment advice.</div></div>';
    if (!reduce) host.querySelectorAll('.spark path').forEach(function (el) {
      var L = el.getTotalLength ? el.getTotalLength() : 0; if (!L) return;
      el.style.strokeDasharray = L; el.style.strokeDashoffset = L; el.getBoundingClientRect();
      el.style.transition = 'stroke-dashoffset .9s ease-out'; el.style.strokeDashoffset = 0;
    });
  }

  css();
  fetch(SRC, { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (data) { if (!data || !data.strategies) throw new Error('bad'); render(data); })
    .catch(function () { host.innerHTML = '<div class="bt"><div class="bfoot">Backtest board is warming up — check back shortly.</div></div>'; });
})();
