// backtest-demo.js — home-page "which algorithm made the most money" animation.
// Loads /backtest.json (a paper backtest of each bot strategy on REAL historical prices across
// three real market regimes — a bull run, a choppy range, a bear market; see
// scripts/backtest-snapshot.mjs) and, for the selected regime, races the four strategies' equity
// curves and crowns the top earner. HONEST: real prices + the real paper simulator, identical
// budget/params; a backtest, not a live account and not a guarantee. No strategy wins every regime.
(function () {
  'use strict';
  var host = document.getElementById('backtest-demo');
  if (!host) return;
  var SRC = host.getAttribute('data-src') || '/backtest.json';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var COLOR = { grid: '#4d8bff', dca: '#28c08a', smarttrade: '#f0a92b', signal: '#ff5d8f' };
  var SHORT = { grid: 'Grid', dca: 'DCA', smarttrade: 'Smart Trade', signal: 'Signal' };
  var REGIMES = [['bull', 'Bull run'], ['chop', 'Choppy range'], ['bear', 'Bear market']];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
  function regimeName(k) { var r = REGIMES.find(function (x) { return x[0] === k; }); return r ? r[1] : k; }

  function css() {
    if (document.getElementById('bt-css')) return;
    var s = document.createElement('style'); s.id = 'bt-css';
    s.textContent = [
      '.bt{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -30px rgba(0,0,0,.6)}',
      '.bt .bhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 16px;border-bottom:1px solid var(--line)}',
      '.bt .bhead .ttl{font-weight:700;font-size:14px}',
      '.bt .seg{margin-left:auto;display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;font-family:var(--mono);font-size:11.5px}',
      '.bt .seg button{appearance:none;background:transparent;border:0;color:var(--faint);padding:6px 13px;cursor:pointer;letter-spacing:.02em}',
      '.bt .seg button.on{background:var(--accent);color:#fff}',
      '.bt .sub{padding:9px 16px 0;font-family:var(--mono);font-size:11.5px;color:var(--faint)}',
      '.bt .sub b{color:var(--ink,inherit)}.bt .up{color:var(--gain)}.bt .down{color:var(--loss)}',
      '.bt .chart{position:relative;padding:10px 16px 4px}',
      '.bt svg{display:block;width:100%;height:188px;overflow:visible}',
      '.bt .zero{stroke:var(--faint);stroke-width:1;stroke-dasharray:3 4;opacity:.6}',
      '.bt .curve{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;opacity:.45;transition:opacity .3s}',
      '.bt .curve.win{stroke-width:3.4;opacity:1;filter:drop-shadow(0 2px 7px rgba(0,0,0,.35))}',
      '.bt .board{display:flex;flex-direction:column;gap:7px;padding:10px 16px 8px}',
      '.bt .row{display:flex;align-items:center;gap:11px;padding:9px 11px;border:1px solid var(--line);border-radius:11px;background:color-mix(in srgb,var(--line) 14%,transparent);transition:border-color .3s,background .3s}',
      '.bt .row.win{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}',
      '.bt .sw{width:11px;height:11px;border-radius:3px;flex:none}',
      '.bt .nm{font-weight:600;font-size:13px}.bt .nm .crown{margin-left:6px}',
      '.bt .meta{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:2px}',
      '.bt .ret{margin-left:auto;font-family:var(--mono);font-weight:700;font-size:14px;font-variant-numeric:tabular-nums}',
      '.bt .bfoot{padding:9px 16px 13px;font-size:11px;color:var(--faint);border-top:1px solid var(--line)}',
      '@media(prefers-reduced-motion:reduce){.bt .curve{transition:none}}',
    ].join('');
    document.head.appendChild(s);
  }

  function pathFor(curve, lo, hi, W, H, pad) {
    var n = curve.length, span = (hi - lo) || 1, d = '';
    for (var i = 0; i < n; i++) {
      var x = pad + (i / (n - 1)) * (W - 2 * pad);
      var y = pad + (1 - (curve[i] - lo) / span) * (H - 2 * pad);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    return d.trim();
  }

  function render(data, key) {
    var r = data.regimes[key];
    if (!r) { host.innerHTML = '<div class="bt"><div class="bfoot">No backtest for this regime yet.</div></div>'; return; }
    var strat = r.strategies, W = 520, H = 188, pad = 10;
    var lo = 0, hi = 0;
    strat.forEach(function (s) { s.curve.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; }); });
    lo -= 0.6; hi += 0.6;
    var zeroY = pad + (1 - (0 - lo) / ((hi - lo) || 1)) * (H - 2 * pad);

    var paths = strat.map(function (s) {
      return '<path class="curve' + (s.type === r.winner ? ' win' : '') + '" d="' + pathFor(s.curve, lo, hi, W, H, pad) + '" stroke="' + COLOR[s.type] + '"/>';
    }).join('');
    var rows = strat.map(function (s) {
      var win = s.type === r.winner, cls = s.pnlPct >= 0 ? 'up' : 'down';
      return '<div class="row' + (win ? ' win' : '') + '"><span class="sw" style="background:' + COLOR[s.type] + '"></span>' +
        '<span class="nm">' + esc(SHORT[s.type] || s.type) + (win ? '<span class="crown">👑</span>' : '') + '</span>' +
        '<span class="meta">' + s.trades + ' trades</span>' +
        '<span class="ret ' + cls + '">' + pct(s.pnlPct) + '</span></div>';
    }).join('');
    var seg = REGIMES.filter(function (x) { return data.regimes[x[0]]; }).map(function (x) {
      return '<button data-k="' + x[0] + '"' + (x[0] === key ? ' class="on"' : '') + '>' + esc(x[1]) + '</button>';
    }).join('');

    var moveCls = r.assetMovePct >= 0 ? 'up' : 'down';
    host.innerHTML =
      '<div class="bt">' +
        '<div class="bhead"><span class="ttl">Which bot strategy made the most money?</span><span class="seg">' + seg + '</span></div>' +
        '<div class="sub">A real <b>' + esc(regimeName(key)) + '</b> in <b>' + esc(data.symbol) + '</b>, ' + esc(r.from) + ' → ' + esc(r.to) +
          ' — ' + esc(data.symbol) + ' itself moved <span class="' + moveCls + '">' + pct(r.assetMovePct) + '</span>.</div>' +
        '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
          '<line class="zero" x1="' + pad + '" y1="' + zeroY.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + zeroY.toFixed(1) + '"/>' + paths +
        '</svg></div>' +
        '<div class="board">' + rows + '</div>' +
        '<div class="bfoot">Paper backtest of each bot strategy on <b>real ' + esc(data.symbol) + '/USD daily prices</b> over this window — identical $' + (data.budget || 1000) + ' budget + default params, the same engine the wallet runs. ' +
          'No strategy wins every regime; in a bear market the stops cut the loss far below the asset&rsquo;s. ' +
          'A simulation on historical data, <b>not a live account and not a guarantee</b>. Crypto is volatile; you can lose money. Not investment advice.</div>' +
      '</div>';

    if (!reduce) {
      host.querySelectorAll('.curve').forEach(function (el) {
        var len = el.getTotalLength ? el.getTotalLength() : 0; if (!len) return;
        el.style.strokeDasharray = len; el.style.strokeDashoffset = len; el.getBoundingClientRect();
        el.style.transition = 'stroke-dashoffset 1.1s ease-out'; el.style.strokeDashoffset = 0;
      });
    }
    host.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () { render(data, b.getAttribute('data-k')); });
    });
  }

  css();
  fetch(SRC, { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.regimes) throw new Error('bad data');
      var start = data.regimes.bull ? 'bull' : Object.keys(data.regimes)[0];
      render(data, start);
    })
    .catch(function () {
      host.innerHTML = '<div class="bt"><div class="bfoot">Backtest board is warming up — check back shortly.</div></div>';
    });
})();
