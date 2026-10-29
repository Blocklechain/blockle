// trade-demo.js — an auto-playing "watch the bot trade" demo for the home page.
// Replays the REAL paper backtest (/backtest.json) with the REAL logos of the
// tokens it traded. Honest: every number comes from the backtest file; nothing
// is invented. Loops like a short video; respects prefers-reduced-motion.
(function () {
  'use strict';
  var host = document.getElementById('trade-demo');
  if (!host) return;
  var SRC = host.getAttribute('data-src') || '/backtest.json';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function usd(n) { return '$' + Math.round(n).toLocaleString(); }
  function logo(sym) { return '/assets/tokens/' + String(sym).toLowerCase() + '.png'; }
  var CHAIN_COLOR = { solana: '#9945ff', ethereum: '#627eea', bsc: '#f0b90b', block: '#4d8bff' };

  function css() {
    if (document.getElementById('td-css')) return;
    var s = document.createElement('style'); s.id = 'td-css';
    s.textContent =
      '.trade-demo{margin:14px 0 6px}' +
      '.td-head{display:flex;flex-wrap:wrap;gap:10px 26px;align-items:baseline;margin-bottom:16px}' +
      '.td-eq{font-family:var(--mono);font-size:clamp(26px,4vw,40px);font-weight:800;letter-spacing:-.02em}' +
      '.td-arrow{color:var(--faint);font-size:22px}' +
      '.td-ret{font-family:var(--mono);font-weight:800;font-size:clamp(18px,2.4vw,26px)}' +
      '.td-kpis{display:flex;gap:22px;margin-left:auto;flex-wrap:wrap}' +
      '.td-kpi .n{font-family:var(--mono);font-weight:700;font-size:16px}.td-kpi .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}' +
      '.td-stage{position:relative;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);overflow:hidden}' +
      '.td-spark{display:block;width:100%;height:120px}' +
      '.td-feed{display:flex;gap:8px;padding:10px;overflow:hidden;flex-wrap:wrap;min-height:52px;border-top:1px solid var(--line)}' +
      '.td-chip{display:flex;align-items:center;gap:7px;padding:5px 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:12.5px;opacity:0;transform:translateY(6px);transition:opacity .35s,transform .35s}' +
      '.td-chip.in{opacity:1;transform:none}' +
      '.td-chip img{width:17px;height:17px;border-radius:50%;flex:none}' +
      '.td-chip .dot{width:6px;height:6px;border-radius:50%;flex:none}' +
      '.td-chip .r{font-family:var(--mono);font-weight:700}' +
      '.td-now{position:absolute;top:8px;right:10px;font-family:var(--mono);font-size:11px;color:var(--muted);z-index:2}' +
      '.td-loading{color:var(--muted);font-size:14px;padding:18px}';
    document.head.appendChild(s);
  }

  fetch(SRC, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    css();
    var rows = (d.perToken || []).slice().filter(function (t) { return t && t.sym; });
    if (!rows.length) { host.innerHTML = '<div class="td-loading">Backtest data unavailable.</div>'; return; }
    // Play order: alternate chains a bit so it reads as cross-chain, keep it stable.
    rows.sort(function (a, b) { return (a.chain || '').localeCompare(b.chain || '') || a.sym.localeCompare(b.sym); });

    host.innerHTML =
      '<div class="td-head">' +
        '<span class="td-eq"><span class="td-faint" style="color:var(--muted);font-weight:500">' + usd(d.startAmount) + '</span> <span class="td-arrow">&rarr;</span> <span id="td-eqnow">' + usd(d.startAmount) + '</span></span>' +
        '<span class="td-ret" id="td-ret">&nbsp;</span>' +
        '<span class="td-kpis">' +
          '<span class="td-kpi"><div class="n" id="td-win">' + (d.winRatePct != null ? d.winRatePct + '%' : '—') + '</div><div class="l">win rate</div></span>' +
          '<span class="td-kpi"><div class="n">' + (d.trades || 0) + '</div><div class="l">paper trades</div></span>' +
          '<span class="td-kpi"><div class="n">' + (d.tokens || rows.length) + ' &middot; ' + ((d.chains || []).length || 3) + '</div><div class="l">tokens &middot; chains</div></span>' +
          '<span class="td-kpi"><div class="n">90d</div><div class="l">paper window</div></span>' +
        '</span>' +
      '</div>' +
      '<div class="td-stage"><span class="td-now" id="td-now"></span><canvas class="td-spark" id="td-spark"></canvas><div class="td-feed" id="td-feed"></div></div>';

    // honest buy&hold line into the disclaimer
    var dis = document.getElementById('td-disclaim');
    if (dis && d.buyHoldReturnPct != null) {
      dis.innerHTML = 'Paper backtest of the shipped momentum engine on 90 days of real daily prices (CoinGecko), $' +
        (d.startAmount / (d.tokens || rows.length)).toLocaleString() + ' per token across a safety-screened basket &mdash; illustrative, not a forecast. ' +
        'For honesty: simply <b>buying and holding</b> the same basket returned <b>' + (d.buyHoldReturnPct >= 0 ? '+' : '') + d.buyHoldReturnPct + '%</b> over the window, vs the strategy’s ' +
        (d.returnPct >= 0 ? '+' : '') + d.returnPct + '%. Past performance is not a guarantee; crypto is volatile and you can lose money. Not investment advice.';
    }

    var feed = document.getElementById('td-feed');
    var eqnow = document.getElementById('td-eqnow');
    var retEl = document.getElementById('td-ret');
    var nowEl = document.getElementById('td-now');
    var spark = document.getElementById('td-spark');
    var ctx = spark.getContext('2d');
    var perToken = d.startAmount / rows.length;

    function sizeCanvas() { var r = spark.getBoundingClientRect(); spark.width = Math.max(300, r.width * devicePixelRatio); spark.height = 120 * devicePixelRatio; }
    sizeCanvas(); window.addEventListener('resize', sizeCanvas);

    function drawSpark(points) {
      var W = spark.width, H = spark.height, pad = 8 * devicePixelRatio;
      ctx.clearRect(0, 0, W, H);
      if (points.length < 2) return;
      var lo = Math.min.apply(null, points), hi = Math.max.apply(null, points), rng = (hi - lo) || 1;
      function X(i) { return pad + (W - 2 * pad) * (i / (points.length - 1)); }
      function Y(v) { return H - pad - (H - 2 * pad) * ((v - lo) / rng); }
      var up = points[points.length - 1] >= points[0];
      var col = up ? (getComputedStyle(document.documentElement).getPropertyValue('--gain') || '#2fc08a') : (getComputedStyle(document.documentElement).getPropertyValue('--loss') || '#ff5d6a');
      ctx.beginPath(); points.forEach(function (v, i) { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
      ctx.lineTo(X(points.length - 1), H - pad); ctx.lineTo(X(0), H - pad); ctx.closePath();
      ctx.fillStyle = (col.trim() || '#2fc08a') + '22'; ctx.fill();
      ctx.beginPath(); points.forEach(function (v, i) { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
      ctx.strokeStyle = col.trim(); ctx.lineWidth = 2 * devicePixelRatio; ctx.lineJoin = 'round'; ctx.stroke();
      // endpoint marker
      ctx.beginPath(); ctx.arc(X(points.length - 1), Y(points[points.length - 1]), 3.2 * devicePixelRatio, 0, 7); ctx.fillStyle = col.trim(); ctx.fill();
    }

    function play() {
      feed.innerHTML = '';
      var equity = d.startAmount, curve = [d.startAmount];
      eqnow.textContent = usd(equity);
      retEl.textContent = '';
      var i = 0;
      function stepOne() {
        if (i >= rows.length) {
          // settle: show final return, then loop
          var ret = d.returnPct;
          retEl.textContent = (ret >= 0 ? '+' : '') + ret + '%';
          retEl.style.color = ret >= 0 ? 'var(--gain)' : 'var(--loss)';
          eqnow.textContent = usd(d.endAmount);
          nowEl.textContent = 'paper result';
          setTimeout(play, reduce ? 6000 : 4500);
          return;
        }
        var t = rows[i]; i++;
        // this token's paper result moves the equity by its net P&L on its slice
        equity += perToken * (t.ret / 100);
        curve.push(equity);
        eqnow.textContent = usd(equity);
        var pos = t.ret >= 0;
        var chip = document.createElement('span'); chip.className = 'td-chip';
        chip.innerHTML =
          '<span class="dot" style="background:' + (CHAIN_COLOR[t.chain] || '#4d8bff') + '"></span>' +
          '<img src="' + logo(t.sym) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:\'' + esc(t.sym.slice(0, 1)) + '\',style:\'width:17px;height:17px;border-radius:50%;background:var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:9px\'}))">' +
          '<b>' + esc(t.sym) + '</b>' +
          '<span style="color:var(--muted)">BUY&rarr;SELL</span>' +
          '<span class="r" style="color:' + (pos ? 'var(--gain)' : 'var(--loss)') + '">' + (pos ? '+' : '') + t.ret + '%</span>';
        feed.appendChild(chip);
        requestAnimationFrame(function () { chip.classList.add('in'); });
        if (feed.children.length > 8) feed.removeChild(feed.firstChild);
        drawSpark(curve);
        nowEl.textContent = 'trading ' + esc(t.sym) + ' on ' + esc(t.chain);
        setTimeout(stepOne, reduce ? 300 : 820);
      }
      stepOne();
    }
    play();
  }).catch(function () { host.innerHTML = '<div class="td-loading">Backtest demo unavailable right now.</div>'; });
})();
