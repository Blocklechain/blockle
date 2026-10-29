// trade-demo.js — auto-playing "watch the bot trade" demo for the home page.
// Replays the REAL paper backtest (/backtest.json) across THREE risk modes
// (Safe / Medium / High) with the REAL logos of the tokens it traded.
//
// Honest by construction: every number comes from the backtest file; nothing is
// invented. Each mode shows the strategy return AND the buy&hold return for the
// same basket, so the comparison is always visible. Loops like a short video;
// respects prefers-reduced-motion.
//
// Lane framing: the bot trades ONE lane at a time — you hold a single base asset
// (SOL on Solana, ETH on Ethereum, BNB on BSC) and it only trades same-chain
// tokens quoted in that base. The demo labels every trade with its lane.
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
  var CHAIN_NAME = { solana: 'Solana', ethereum: 'Ethereum', bsc: 'BSC', block: 'BLOCK' };
  var BASE_ASSET = { solana: 'SOL', ethereum: 'ETH', bsc: 'BNB', block: 'BLOCK' };
  // Per-mode visual identity + animation pacing.
  var MODE_STYLE = {
    safe:   { accent: '#4d8bff', tag: 'Large-cap', beat: 980, flavor: 'blue-chip momentum' },
    medium: { accent: '#f0a92b', tag: 'Mid-cap',   beat: 720, flavor: 'balanced rotation' },
    high:   { accent: '#ff5d8f', tag: 'Microcap',  beat: 420, flavor: 'social-driven degen' },
    sniper: { accent: '#ff3b3b', tag: 'New launches', beat: 240, flavor: 'live-only · no backtest' },
  };
  var ORDER = ['safe', 'medium', 'high', 'sniper'];

  function css() {
    if (document.getElementById('td-css')) return;
    var s = document.createElement('style'); s.id = 'td-css';
    s.textContent =
      '.trade-demo{margin:14px 0 6px}' +
      '.td-modes{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}' +
      '.td-mode{display:flex;flex-direction:column;gap:2px;padding:9px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);cursor:pointer;transition:border-color .2s,background .2s;min-width:118px}' +
      '.td-mode .mt{font-weight:700;font-size:14px;display:flex;align-items:center;gap:7px}' +
      '.td-mode .ms{font-size:11px;color:var(--muted)}' +
      '.td-mode .md{width:8px;height:8px;border-radius:50%;flex:none}' +
      '.td-mode.on{background:var(--surface-2)}' +
      '.td-progress{height:2px;border-radius:2px;background:var(--line);margin-top:7px;overflow:hidden}' +
      '.td-progress>i{display:block;height:100%;width:0;background:var(--accent-dyn, #4d8bff);transition:width .25s linear}' +
      '.td-lanes{display:flex;gap:7px 16px;flex-wrap:wrap;align-items:center;margin-bottom:12px;font-size:12.5px;color:var(--muted)}' +
      '.td-lane{display:inline-flex;align-items:center;gap:6px}' +
      '.td-lane .ld{width:8px;height:8px;border-radius:50%}' +
      '.td-lane.dim{opacity:.32}' +
      '.td-lanenote{color:var(--faint)}' +
      '.td-head{display:flex;flex-wrap:wrap;gap:10px 26px;align-items:baseline;margin-bottom:14px}' +
      '.td-eq{font-family:var(--mono);font-size:clamp(26px,4vw,40px);font-weight:800;letter-spacing:-.02em}' +
      '.td-arrow{color:var(--faint);font-size:22px}' +
      '.td-ret{font-family:var(--mono);font-weight:800;font-size:clamp(18px,2.4vw,26px)}' +
      '.td-kpis{display:flex;gap:22px;margin-left:auto;flex-wrap:wrap}' +
      '.td-kpi .n{font-family:var(--mono);font-weight:700;font-size:16px}.td-kpi .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}' +
      '.td-kpi .hold{color:var(--muted)}' +
      '.td-stage{position:relative;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);overflow:hidden}' +
      '.td-spark{display:block;width:100%;height:120px}' +
      '.td-feed{display:flex;gap:8px;padding:10px;overflow:hidden;flex-wrap:wrap;min-height:52px;border-top:1px solid var(--line)}' +
      '.td-chip{display:flex;align-items:center;gap:7px;padding:5px 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:12.5px;opacity:0;transform:translateY(6px);transition:opacity .35s,transform .35s}' +
      '.td-chip.in{opacity:1;transform:none}' +
      '.td-chip img{width:17px;height:17px;border-radius:50%;flex:none}' +
      '.td-chip .dot{width:6px;height:6px;border-radius:50%;flex:none}' +
      '.td-chip .r{font-family:var(--mono);font-weight:700}' +
      '.td-now{position:absolute;top:8px;right:10px;font-family:var(--mono);font-size:11px;color:var(--muted);z-index:2}' +
      '.td-scan{position:absolute;top:8px;left:10px;font-size:11px;color:var(--muted);z-index:2;opacity:0;transition:opacity .3s}' +
      '.td-scan.on{opacity:1}' +
      '.td-note{font-size:11.5px;color:var(--faint);margin-top:8px}' +
      '.td-loading{color:var(--muted);font-size:14px;padding:18px}';
    document.head.appendChild(s);
  }

  fetch(SRC, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    css();
    var modes = d.modes || null;
    if (!modes) { host.innerHTML = '<div class="td-loading">Backtest data unavailable.</div>'; return; }
    var keys = ORDER.filter(function (k) { return modes[k] && ((modes[k].perToken || []).length || modes[k].noBacktest); });
    if (!keys.length) { host.innerHTML = '<div class="td-loading">Backtest data unavailable.</div>'; return; }

    // Build shell: mode tabs + head + lanes + stage.
    var tabs = keys.map(function (k) {
      var m = modes[k], st = MODE_STYLE[k] || {};
      return '<div class="td-mode" data-mode="' + k + '">' +
        '<span class="mt"><span class="md" style="background:' + (st.accent || '#4d8bff') + '"></span>' + esc(m.label || k) + '</span>' +
        '<span class="ms">' + esc((st.tag || '') + ' · ' + (st.flavor || '')) + '</span>' +
        '<span class="td-progress"><i></i></span></div>';
    }).join('');

    host.innerHTML =
      '<div class="td-modes">' + tabs + '</div>' +
      '<div class="td-lanes" id="td-lanes"></div>' +
      '<div class="td-head">' +
        '<span class="td-eq"><span style="color:var(--muted);font-weight:500" id="td-eqstart"></span> <span class="td-arrow">&rarr;</span> <span id="td-eqnow"></span></span>' +
        '<span class="td-ret" id="td-ret">&nbsp;</span>' +
        '<span class="td-kpis">' +
          '<span class="td-kpi"><div class="n" id="td-win">—</div><div class="l">win rate</div></span>' +
          '<span class="td-kpi"><div class="n" id="td-tr">—</div><div class="l">paper trades</div></span>' +
          '<span class="td-kpi"><div class="n hold" id="td-hold">—</div><div class="l">buy &amp; hold</div></span>' +
          '<span class="td-kpi"><div class="n">90d</div><div class="l">paper window</div></span>' +
        '</span>' +
      '</div>' +
      '<div class="td-stage"><span class="td-now" id="td-now"></span><span class="td-scan" id="td-scan">◉ scanning social + on-chain signals…</span>' +
      '<canvas class="td-spark" id="td-spark"></canvas><div class="td-feed" id="td-feed"></div></div>' +
      '<div class="td-note" id="td-note"></div>';

    var elEqStart = document.getElementById('td-eqstart');
    var elEqNow = document.getElementById('td-eqnow');
    var elRet = document.getElementById('td-ret');
    var elWin = document.getElementById('td-win');
    var elTr = document.getElementById('td-tr');
    var elHold = document.getElementById('td-hold');
    var elNow = document.getElementById('td-now');
    var elScan = document.getElementById('td-scan');
    var elNote = document.getElementById('td-note');
    var elLanes = document.getElementById('td-lanes');
    var feed = document.getElementById('td-feed');
    var spark = document.getElementById('td-spark');
    var ctx = spark.getContext('2d');
    var tabEls = {};
    Array.prototype.forEach.call(host.querySelectorAll('.td-mode'), function (el) { tabEls[el.getAttribute('data-mode')] = el; });

    function sizeCanvas() { var r = spark.getBoundingClientRect(); spark.width = Math.max(300, r.width * devicePixelRatio); spark.height = 120 * devicePixelRatio; }
    sizeCanvas(); window.addEventListener('resize', sizeCanvas);

    function drawSpark(points, accent) {
      var W = spark.width, H = spark.height, pad = 8 * devicePixelRatio;
      ctx.clearRect(0, 0, W, H);
      if (points.length < 2) return;
      var lo = Math.min.apply(null, points), hi = Math.max.apply(null, points), rng = (hi - lo) || 1;
      function X(i) { return pad + (W - 2 * pad) * (i / (points.length - 1)); }
      function Y(v) { return H - pad - (H - 2 * pad) * ((v - lo) / rng); }
      ctx.beginPath(); points.forEach(function (v, i) { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
      ctx.lineTo(X(points.length - 1), H - pad); ctx.lineTo(X(0), H - pad); ctx.closePath();
      ctx.fillStyle = accent + '22'; ctx.fill();
      ctx.beginPath(); points.forEach(function (v, i) { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
      ctx.strokeStyle = accent; ctx.lineWidth = 2 * devicePixelRatio; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(X(points.length - 1), Y(points[points.length - 1]), 3.2 * devicePixelRatio, 0, 7); ctx.fillStyle = accent; ctx.fill();
    }

    var timer = null, cur = null;
    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

    function renderLanes(mode, activeChain) {
      var chains = modes[mode].chains || [];
      elLanes.innerHTML = chains.map(function (c) {
        return '<span class="td-lane' + (activeChain && activeChain !== c ? ' dim' : '') + '" data-chain="' + c + '">' +
          '<span class="ld" style="background:' + (CHAIN_COLOR[c] || '#888') + '"></span>' +
          esc(CHAIN_NAME[c] || c) + ' <span style="color:var(--faint)">(' + esc(BASE_ASSET[c] || '?') + ')</span></span>';
      }).join('') +
        '<span class="td-lanenote">— one lane at a time: the bot holds your base asset and only trades that chain</span>';
    }

    function play(mode) {
      clearTimer();
      cur = mode;
      var m = modes[mode], st = MODE_STYLE[mode] || {};
      var accent = st.accent || '#4d8bff';
      var beat = reduce ? 260 : (st.beat || 800);
      document.documentElement.style.setProperty('--accent-dyn', accent);
      // tab state
      ORDER.forEach(function (k) { if (tabEls[k]) tabEls[k].classList.toggle('on', k === mode); });
      Array.prototype.forEach.call(host.querySelectorAll('.td-progress>i'), function (i) { i.style.width = '0'; });

      // Live-only mode (sniper): NO historical backtest exists. Show the scanning
      // behaviour + a loud warning instead of any fabricated return.
      if (m.noBacktest) {
        document.documentElement.style.setProperty('--accent-dyn', accent);
        var watch = (m.watchlist || []).slice();
        var laneByIdx = (m.chains || ['solana', 'ethereum', 'bsc']);
        elEqStart.textContent = 'live only';
        elEqNow.textContent = '—';
        elRet.textContent = 'no backtest';
        elRet.style.color = 'var(--muted)';
        elWin.textContent = '—'; elTr.textContent = '—'; elHold.textContent = '—';
        elScan.classList.add('on');
        renderLanes(mode, null);
        elNote.innerHTML = '⚠ ' + esc(m.note || '');
        ctx.clearRect(0, 0, spark.width, spark.height);
        feed.innerHTML = '';
        var prog2 = tabEls[mode] ? tabEls[mode].querySelector('.td-progress>i') : null;
        var j = 0;
        (function scanOne() {
          if (j >= watch.length) {
            elNow.textContent = 'watching for new launches';
            if (prog2) prog2.style.width = '100%';
            var next2 = keys[(keys.indexOf(mode) + 1) % keys.length];
            timer = setTimeout(function () { play(next2); }, reduce ? 3200 : 3800);
            return;
          }
          var sym = watch[j]; var ch = laneByIdx[j % laneByIdx.length]; j++;
          renderLanes(mode, ch);
          var chip2 = document.createElement('span'); chip2.className = 'td-chip';
          chip2.innerHTML =
            '<span class="dot" style="background:' + (CHAIN_COLOR[ch] || '#888') + '"></span>' +
            '<img src="' + logo(sym) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:\'' + esc(sym.slice(0, 1)) + '\',style:\'width:17px;height:17px;border-radius:50%;background:var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:9px\'}))">' +
            '<b>' + esc(sym) + '</b><span style="color:var(--muted)">scanning…</span>';
          feed.appendChild(chip2);
          requestAnimationFrame(function () { chip2.classList.add('in'); });
          if (feed.children.length > 8) feed.removeChild(feed.firstChild);
          elNow.textContent = 'sniffing ' + esc(sym) + ' on ' + esc(CHAIN_NAME[ch] || ch);
          if (prog2) prog2.style.width = Math.round((j / watch.length) * 100) + '%';
          timer = setTimeout(scanOne, beat);
        })();
        return;
      }

      // KPIs for this mode
      elEqStart.textContent = usd(m.startAmount);
      elEqNow.textContent = usd(m.startAmount);
      elWin.textContent = (m.winRatePct != null ? m.winRatePct + '%' : '—');
      elTr.textContent = (m.trades || 0);
      elHold.textContent = (m.buyHoldReturnPct >= 0 ? '+' : '') + m.buyHoldReturnPct + '%';
      elRet.textContent = '';
      elScan.classList.toggle('on', mode === 'high'); // only high mode "scans socials"
      renderLanes(mode, null);

      var note = '$' + (m.startAmount / (m.perToken.length || 1)).toLocaleString() + ' paper per token · ' +
        esc(m.strategy || '') + ' · trend filter + 8% stop. ' +
        'Strategy ' + (m.returnPct >= 0 ? '+' : '') + m.returnPct + '% vs buy&hold ' +
        (m.buyHoldReturnPct >= 0 ? '+' : '') + m.buyHoldReturnPct + '% this window.';
      if (mode === 'high' && m.survivorshipNote) note += ' ⚠ ' + esc(m.survivorshipNote);
      elNote.innerHTML = note;

      // play order: group by lane (chain) so it reads as one-lane-at-a-time
      var rows = m.perToken.slice().sort(function (a, b) {
        return (a.chain || '').localeCompare(b.chain || '') || a.sym.localeCompare(b.sym);
      });
      feed.innerHTML = '';
      var equity = m.startAmount, curve = [equity], perToken = m.startAmount / rows.length, i = 0;
      var prog = tabEls[mode] ? tabEls[mode].querySelector('.td-progress>i') : null;

      function stepOne() {
        if (i >= rows.length) {
          elRet.textContent = (m.returnPct >= 0 ? '+' : '') + m.returnPct + '%';
          elRet.style.color = m.returnPct >= 0 ? 'var(--gain)' : 'var(--loss)';
          elEqNow.textContent = usd(m.endAmount);
          elNow.textContent = 'paper result';
          if (prog) prog.style.width = '100%';
          // advance to next mode after a beat
          var next = keys[(keys.indexOf(mode) + 1) % keys.length];
          timer = setTimeout(function () { play(next); }, reduce ? 3200 : 3600);
          return;
        }
        var t = rows[i]; i++;
        equity += perToken * (t.ret / 100);
        curve.push(equity);
        elEqNow.textContent = usd(equity);
        renderLanes(mode, t.chain);
        var pos = t.ret >= 0;
        var chip = document.createElement('span'); chip.className = 'td-chip';
        chip.innerHTML =
          '<span class="dot" style="background:' + (CHAIN_COLOR[t.chain] || '#4d8bff') + '"></span>' +
          '<img src="' + logo(t.sym) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:\'' + esc(t.sym.slice(0, 1)) + '\',style:\'width:17px;height:17px;border-radius:50%;background:var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:9px\'}))">' +
          '<b>' + esc(t.sym) + '</b>' +
          '<span style="color:var(--muted)">' + esc(BASE_ASSET[t.chain] || '') + '&rarr;' + esc(t.sym) + '&rarr;' + esc(BASE_ASSET[t.chain] || '') + '</span>' +
          '<span class="r" style="color:' + (pos ? 'var(--gain)' : 'var(--loss)') + '">' + (pos ? '+' : '') + t.ret + '%</span>';
        feed.appendChild(chip);
        requestAnimationFrame(function () { chip.classList.add('in'); });
        if (feed.children.length > 8) feed.removeChild(feed.firstChild);
        drawSpark(curve, accent);
        elNow.textContent = 'trading ' + esc(t.sym) + ' on ' + esc(CHAIN_NAME[t.chain] || t.chain);
        if (prog) prog.style.width = Math.round((i / rows.length) * 100) + '%';
        timer = setTimeout(stepOne, beat);
      }
      stepOne();
    }

    // click a mode tab to jump to it
    Array.prototype.forEach.call(host.querySelectorAll('.td-mode'), function (el) {
      el.addEventListener('click', function () { play(el.getAttribute('data-mode')); });
    });

    // honest buy&hold line into the external disclaimer
    var dis = document.getElementById('td-disclaim');
    if (dis) {
      dis.innerHTML = 'Paper backtest of the shipped momentum engine (EMA crossover + trend filter + 8% stop) on 90 days of real hourly prices (CoinGecko), across Safe / Medium / High baskets &mdash; illustrative, not a forecast. ' +
        'For honesty, each mode shows the strategy return <b>and</b> the buy&amp;hold return for the same basket; over this particular bull window, simply holding often did better. ' +
        'The microcap (High) basket is survivorship-biased. Past performance is not a guarantee; crypto is volatile and you can lose money. Not investment advice.';
    }

    play(keys[0]);
  }).catch(function () { host.innerHTML = '<div class="td-loading">Backtest demo unavailable right now.</div>'; });
})();
