// trade-demo.js — an auto-playing "watch the bot hunt arbitrage" demo for the home
// page. Replays a LIVE cross-DEX spread board (/arb.json) across four modes
// (Safe / Medium / High / Sniper). Every number is REAL: same-chain cross-DEX price
// gaps from DexScreener, net of a conservative round-trip cost. HONEST by design —
// this is a real-time snapshot, not a historical backtest; spreads are fleeting,
// size-limited, compete with MEV bots, and many are net-negative (shown as-is).
// Loops like a short video; respects prefers-reduced-motion.
(function () {
  'use strict';
  var host = document.getElementById('trade-demo');
  if (!host) return;
  var SRC = host.getAttribute('data-src') || '/arb.json';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function usd(n) { return '$' + Math.round(n).toLocaleString(); }
  function pct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(3) + '%'; }
  function logo(sym) { return '/assets/tokens/' + String(sym).toLowerCase() + '.png'; }
  var CHAIN_COLOR = { solana: '#9945ff', ethereum: '#627eea', bsc: '#f0b90b', block: '#4d8bff' };
  var CHAIN_NAME = { solana: 'Solana', ethereum: 'Ethereum', bsc: 'BSC', block: 'BLOCK' };
  var BASE_ASSET = { solana: 'SOL', ethereum: 'ETH', bsc: 'BNB', block: 'BLOCK' };
  var MODE_STYLE = {
    safe:   { accent: '#4d8bff', tag: 'Large-cap', beat: 620, flavor: 'deep pools · tight spreads' },
    medium: { accent: '#f0a92b', tag: 'Mid-cap',   beat: 480, flavor: 'balanced depth' },
    high:   { accent: '#ff5d8f', tag: 'Microcap',  beat: 340, flavor: 'less-efficient · wider gaps' },
    sniper: { accent: '#ff3b3b', tag: 'New launches', beat: 220, flavor: 'freshest · widest gaps' },
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
      '.td-eq{font-family:var(--mono);font-size:clamp(24px,3.6vw,38px);font-weight:800;letter-spacing:-.02em}' +
      '.td-eqlbl{font-size:12px;color:var(--muted);font-weight:500;letter-spacing:.04em;text-transform:uppercase}' +
      '.td-kpis{display:flex;gap:22px;margin-left:auto;flex-wrap:wrap}' +
      '.td-kpi .n{font-family:var(--mono);font-weight:700;font-size:16px}.td-kpi .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}' +
      '.td-stage{position:relative;border:1px solid var(--line);border-radius:14px;background:var(--surface-2);overflow:hidden}' +
      '.td-spark{display:block;width:100%;height:120px}' +
      '.td-feed{display:flex;flex-direction:column;gap:6px;padding:10px;overflow:hidden;min-height:52px;border-top:1px solid var(--line)}' +
      '.td-row{display:flex;align-items:center;gap:9px;font-size:12.5px;opacity:0;transform:translateY(6px);transition:opacity .3s,transform .3s}' +
      '.td-row.in{opacity:1;transform:none}' +
      '.td-row img{width:18px;height:18px;border-radius:50%;flex:none}' +
      '.td-row .dot{width:6px;height:6px;border-radius:50%;flex:none}' +
      '.td-row .sym{font-weight:700;min-width:62px}' +
      '.td-row .route{color:var(--muted);font-family:var(--mono);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.td-row .net{font-family:var(--mono);font-weight:700;margin-left:auto}' +
      '.td-row .sz{font-family:var(--mono);color:var(--faint);font-size:11px}' +
      '.td-row .tag{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--line)}' +
      '.td-now{position:absolute;top:8px;right:10px;font-family:var(--mono);font-size:11px;color:var(--muted);z-index:2}' +
      '.td-scan{position:absolute;top:8px;left:10px;font-size:11px;color:var(--muted);z-index:2}' +
      '.td-note{font-size:11.5px;color:var(--faint);margin-top:8px}' +
      '.td-loading{color:var(--muted);font-size:14px;padding:18px}';
    document.head.appendChild(s);
  }

  fetch(SRC, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    css();
    var modes = d.modes || null;
    if (!modes) { host.innerHTML = '<div class="td-loading">Arbitrage board unavailable.</div>'; return; }
    var keys = ORDER.filter(function (k) { return modes[k] && (modes[k].opportunities || []).length; });
    if (!keys.length) { host.innerHTML = '<div class="td-loading">No live spreads in this snapshot — markets are efficient right now.</div>'; return; }

    var tabs = keys.map(function (k) {
      var m = modes[k], st = MODE_STYLE[k] || {};
      return '<div class="td-mode" data-mode="' + k + '">' +
        '<span class="mt"><span class="md" style="background:' + (st.accent || '#4d8bff') + '"></span>' + esc((st.tag || k)) + '</span>' +
        '<span class="ms">' + esc(st.flavor || '') + '</span>' +
        '<span class="td-progress"><i></i></span></div>';
    }).join('');

    host.innerHTML =
      '<div class="td-modes">' + tabs + '</div>' +
      '<div class="td-lanes" id="td-lanes"></div>' +
      '<div class="td-head">' +
        '<span class="td-eq"><span id="td-cap">$0</span></span> <span class="td-eqlbl">net captured &middot; this snapshot</span>' +
        '<span class="td-kpis">' +
          '<span class="td-kpi"><div class="n" id="td-scanned">—</div><div class="l">pairs scanned</div></span>' +
          '<span class="td-kpi"><div class="n" id="td-prof">—</div><div class="l">profitable net of fees</div></span>' +
          '<span class="td-kpi"><div class="n" id="td-best">—</div><div class="l">best net spread</div></span>' +
          '<span class="td-kpi"><div class="n" id="td-fees">—</div><div class="l">round-trip cost</div></span>' +
        '</span>' +
      '</div>' +
      '<div class="td-stage"><span class="td-now" id="td-now"></span><span class="td-scan" id="td-scan">◉ scanning cross-DEX spreads…</span>' +
      '<canvas class="td-spark" id="td-spark"></canvas><div class="td-feed" id="td-feed"></div></div>' +
      '<div class="td-note" id="td-note"></div>';

    var elCap = document.getElementById('td-cap');
    var elScanned = document.getElementById('td-scanned');
    var elProf = document.getElementById('td-prof');
    var elBest = document.getElementById('td-best');
    var elFees = document.getElementById('td-fees');
    var elNow = document.getElementById('td-now');
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

    function renderLanes(activeChain) {
      var chains = ['solana', 'ethereum', 'bsc'];
      elLanes.innerHTML = chains.map(function (c) {
        return '<span class="td-lane' + (activeChain && activeChain !== c ? ' dim' : '') + '">' +
          '<span class="ld" style="background:' + (CHAIN_COLOR[c] || '#888') + '"></span>' +
          esc(CHAIN_NAME[c] || c) + ' <span style="color:var(--faint)">(' + esc(BASE_ASSET[c] || '?') + ')</span></span>';
      }).join('') + '<span class="td-lanenote">— one lane at a time: buy on the cheaper DEX, sell on the dearer, same chain</span>';
    }

    var timer = null, raf = null;
    function clearTimers() { if (timer) { clearTimeout(timer); timer = null; } if (raf) { cancelAnimationFrame(raf); raf = null; } }

    function odometer(el, target, durationMs, fmt) {
      if (reduce || !window.requestAnimationFrame) { el.textContent = fmt(target); return; }
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      (function tick(now) {
        now = now || ((window.performance && performance.now) ? performance.now() : Date.now());
        var p = Math.min(1, (now - t0) / durationMs), e = 1 - Math.pow(1 - p, 2);
        el.textContent = fmt(target * e);
        if (p < 1) raf = requestAnimationFrame(tick);
      })();
    }

    function play(mode) {
      clearTimers();
      var m = modes[mode], st = MODE_STYLE[mode] || {};
      var accent = st.accent || '#4d8bff';
      var beat = reduce ? 240 : (st.beat || 500);
      document.documentElement.style.setProperty('--accent-dyn', accent);
      ORDER.forEach(function (k) { if (tabEls[k]) tabEls[k].classList.toggle('on', k === mode); });
      Array.prototype.forEach.call(host.querySelectorAll('.td-progress>i'), function (i) { i.style.width = '0'; });

      var ops = (m.opportunities || []).slice().sort(function (a, b) { return b.netPct - a.netPct; });
      var best = ops.length ? ops[0].netPct : 0;
      var profitable = ops.filter(function (o) { return o.profitable; });
      var totalCapture = profitable.reduce(function (s, o) { return s + (o.netPct / 100) * (o.sizeCapUsd || 0); }, 0);

      elScanned.textContent = '—'; elProf.textContent = (m.profitableAfterFees != null ? m.profitableAfterFees : profitable.length);
      elBest.textContent = pct(best); elBest.style.color = best > 0 ? 'var(--gain)' : 'var(--muted)';
      elFees.textContent = '−' + (m.feesPct != null ? m.feesPct : 0.8) + '%';
      elCap.textContent = '$0';
      renderLanes(null);
      odometer(elScanned, (m.scanned || ops.length), Math.max(2000, ops.length * beat), function (v) { return Math.round(v).toLocaleString(); });

      elNote.innerHTML = 'Live same-chain cross-DEX spreads (DexScreener), net of a ~' + (m.feesPct != null ? m.feesPct : 0.8) +
        '% round-trip cost (two swaps + 0.05% agent fee + slippage). <b>Real-time snapshot, not a backtest</b> — spreads are fleeting, ' +
        'capped by the shallower pool, and compete with MEV bots, so most are below cost (shown as-is). The bot only fires the ones that clear fees. Not investment advice.';

      feed.innerHTML = '';
      var captured = 0, curve = [0], i = 0;
      var prog = tabEls[mode] ? tabEls[mode].querySelector('.td-progress>i') : null;

      function step() {
        if (i >= ops.length) {
          elCap.textContent = usd(totalCapture);
          elNow.textContent = profitable.length + ' of ' + ops.length + ' cleared fees';
          if (prog) prog.style.width = '100%';
          var next = keys[(keys.indexOf(mode) + 1) % keys.length];
          timer = setTimeout(function () { play(next); }, reduce ? 3200 : 4200);
          return;
        }
        var o = ops[i]; i++;
        if (o.profitable) { captured += (o.netPct / 100) * (o.sizeCapUsd || 0); }
        curve.push(captured);
        elCap.textContent = usd(captured);
        renderLanes(o.chain);
        var row = document.createElement('div'); row.className = 'td-row';
        var pos = o.netPct > 0;
        row.innerHTML =
          '<span class="dot" style="background:' + (CHAIN_COLOR[o.chain] || '#888') + '"></span>' +
          '<img src="' + logo(o.sym) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:\'' + esc(String(o.sym).slice(0, 1)) + '\',style:\'width:18px;height:18px;border-radius:50%;background:var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:9px\'}))">' +
          '<span class="sym">' + esc(o.sym) + '</span>' +
          '<span class="route">buy ' + esc(o.buyDex) + ' &rarr; sell ' + esc(o.sellDex) + '</span>' +
          '<span class="sz">~' + usd(o.sizeCapUsd || 0) + '</span>' +
          '<span class="net" style="color:' + (pos ? 'var(--gain)' : 'var(--loss)') + '">' + pct(o.netPct) + '</span>' +
          '<span class="tag" style="color:' + (pos ? 'var(--gain)' : 'var(--muted)') + '">' + (pos ? 'fire' : 'skip') + '</span>';
        feed.appendChild(row);
        requestAnimationFrame(function () { row.classList.add('in'); });
        if (feed.children.length > 7) feed.removeChild(feed.firstChild);
        drawSpark(curve, accent);
        elNow.textContent = 'checking ' + esc(o.sym) + ' on ' + esc(CHAIN_NAME[o.chain] || o.chain);
        if (prog) prog.style.width = Math.round((i / ops.length) * 100) + '%';
        timer = setTimeout(step, beat);
      }
      step();
    }

    Array.prototype.forEach.call(host.querySelectorAll('.td-mode'), function (el) {
      el.addEventListener('click', function () { play(el.getAttribute('data-mode')); });
    });

    var dis = document.getElementById('td-disclaim');
    if (dis) {
      dis.innerHTML = 'Live <b>arbitrage</b> board: real same-chain cross-DEX price gaps (DexScreener), net of a conservative round-trip cost (two swaps + the 0.05% agent fee + slippage). ' +
        'This is a <b>real-time snapshot, not a historical backtest</b>. Spreads are fleeting, capped by the shallower pool, and compete with MEV bots — so most pairs are below cost and the bot only fires the few that clear fees. ' +
        'Edge concentrates in the less-efficient (microcap / new-launch) tiers; majors are near-efficient. Past performance is not a guarantee; crypto is volatile and you can lose money. Not investment advice.';
    }

    play(keys[0]);
  }).catch(function () { host.innerHTML = '<div class="td-loading">Arbitrage demo unavailable right now.</div>'; });
})();
