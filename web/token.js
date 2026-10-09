// token.js — the Blockle Launch per-token page: live price, chart, market cap,
// liquidity, the public LP-lock countdown (anti-rug), and an embedded trade
// panel (buy/sell via the wallet provider).
(function () {
  'use strict';
  var id = (location.pathname.split('/')[2] || '').toLowerCase();
  var COIN = 100000000, SWAP_FEE = 0.003, SLIP = 0.01, BLOCK_SECS = 600;
  var pool = null, meta = null, logo = null, tSide = 'buy';
  var $ = function (x) { return document.getElementById(x); };
  function setAttr(sel, attr, key, val) {
    var el = document.head.querySelector(sel);
    if (!el) { el = document.createElement(sel.indexOf('link') === 0 ? 'link' : 'meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
    el.setAttribute(sel.indexOf('link') === 0 ? 'href' : 'content', val);
  }
  function seo(sym, name) {
    var url = 'https://blockle.org/token/' + id;
    var title = sym + ' (' + name + ') — BLOCK-20 token on Blockle';
    var desc = name + ' ($' + sym + ') price, liquidity and live trades on Blockle’s native AMM DEX — a BLOCK-20 token on the post-quantum Blockle layer-1.';
    document.title = title;
    setAttr('meta[name="description"]', 'name', 'description', desc);
    setAttr('link[rel="canonical"]', 'rel', 'canonical', url);
    setAttr('meta[property="og:url"]', 'property', 'og:url', url);
    setAttr('meta[property="og:title"]', 'property', 'og:title', title);
    setAttr('meta[property="og:description"]', 'property', 'og:description', desc);
    setAttr('meta[name="twitter:title"]', 'name', 'twitter:title', title);
    setAttr('meta[name="twitter:description"]', 'name', 'twitter:description', desc);
    var lu = ipfs(logo);
    if (lu) { setAttr('meta[property="og:image"]', 'property', 'og:image', lu); setAttr('meta[name="twitter:image"]', 'name', 'twitter:image', lu); setAttr('meta[property="og:image:alt"]', 'property', 'og:image:alt', name + ' logo'); }
    var ld = document.getElementById('ld-token');
    if (!ld) { ld = document.createElement('script'); ld.type = 'application/ld+json'; ld.id = 'ld-token'; document.head.appendChild(ld); }
    ld.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'DEX', item: 'https://blockle.org/dex' },
        { '@type': 'ListItem', position: 2, name: sym + ' (' + name + ')', item: url }
      ]
    });
  }
  function fmt(n, d) { if (n == null || !isFinite(n)) return '—'; return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 6 : d }); }
  function ipfs(u) { if (!u) return null; if (u.indexOf('ipfs://') === 0) return 'https://ipfs.io/ipfs/' + u.slice(7); if (/^[a-zA-Z0-9]{46,}$/.test(u)) return 'https://ipfs.io/ipfs/' + u; return u; }
  function dur(b) { var s = b * BLOCK_SECS; if (s <= 0) return 'unlocked'; var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d > 0 ? d + 'd ' + h + 'h' : (h > 0 ? h + 'h ' + m + 'm' : m + 'm'); }
  function dec() { return Number((pool && pool.decimals) || (meta && meta.decimals) || 0); }
  function price() { if (!pool || !pool.tokenReserve) return null; return (pool.blockReserve / COIN) / (pool.tokenReserve / Math.pow(10, dec())); }
  function amountOut(a, ri, ro) { if (a <= 0 || ri <= 0 || ro <= 0) return 0; var ain = a * (1 - SWAP_FEE); return ro * ain / (ri + ain); }

  async function load() {
    if (!/^[0-9a-f]{64}$/.test(id)) { $('body').innerHTML = '<div class="empty">Invalid token id.</div>'; return; }
    try { pool = await (await fetch('/api/dex/pool/' + id)).json(); } catch (e) {}
    try { meta = await (await fetch('/api/token/' + id)).json(); meta = meta.result || meta; } catch (e) {}
    try { var t = await (await fetch('/api/dex/tokens')).json(); logo = t[id] && t[id].logo; } catch (e) {}
    if (!pool || pool.exists === false) {
      var sym0 = (meta && meta.symbol) || 'token';
      seo(sym0, (meta && meta.name) || 'BLOCK-20 token');
      $('body').innerHTML = '<div class="empty"><h2>' + sym0 + '</h2><p>No liquidity pool for this token yet.</p>'
        + '<p><a href="/launch">Create one on Launch →</a></p></div>';
      return;
    }
    render();
    chart();
  }

  function render() {
    var sym = pool.symbol || (meta && meta.symbol) || '?';
    var name = pool.name || (meta && meta.name) || 'BLOCK-20 token';
    seo(sym, name);
    var d = dec();
    var p = price();
    var height = pool.height || 0;
    var lockBlocks = (pool.lockedUntil || 0) - height;
    var locked = lockBlocks > 0;
    var supply = meta && meta.totalSupply != null ? meta.totalSupply / Math.pow(10, d) : null;
    var mcap = p != null && supply != null ? p * supply : null;
    var liq = (pool.blockReserve || 0) / COIN * 2;
    var tokRes = (pool.tokenReserve || 0) / Math.pow(10, d);
    var lu = ipfs(logo);
    var avatar = lu ? '<span class="logo"><img src="' + lu + '" onerror="this.parentNode.textContent=\'' + sym.slice(0, 2).toUpperCase() + '\'"></span>'
      : '<span class="logo">' + sym.slice(0, 2).toUpperCase() + '</span>';

    $('body').innerHTML =
      '<div class="grid"><div>' +
        '<div class="card"><div class="hero">' + avatar +
          '<div><div class="hname">' + name + '</div><div class="hsym">$' + sym + '</div>' +
          '<div class="price"><span class="v" id="price">' + (p != null ? fmt(p, 8) : '—') + '</span><span class="u">BLOCK</span><span class="chg" id="chg"></span></div>' +
          '<span class="badge ' + (locked ? 'locked' : 'unlocked') + '">' + (locked ? '🔒 LP locked · ' + dur(lockBlocks) + ' left' : '🔓 LP unlocked') + '</span>' +
          '</div></div></div>' +
        '<div class="card"><canvas id="chart" width="600" height="200"></canvas><p class="note" id="chartnote">Loading price history…</p></div>' +
        '<div class="card"><div class="stats">' +
          stat('Market cap', mcap != null ? fmt(mcap, 2) + ' BLOCK' : '—') +
          stat('Liquidity', fmt(liq, 2) + ' BLOCK') +
          stat('Total supply', supply != null ? fmt(supply, 0) + ' ' + sym : '—') +
          stat('In pool', fmt(tokRes, 2) + ' ' + sym) +
          stat('Decimals', String(d)) +
          stat('Created', 'block #' + (pool.createdHeight || 0)) +
        '</div><div class="caddr">contract ' + id + ' · <a href="/explorer/address/' + (pool.token || id) + '">explorer ↗</a></div></div>' +
      '</div><div>' +
        '<div class="card"><div class="tabs"><button id="t-buy" class="on">Buy</button><button id="t-sell">Sell</button></div>' +
          '<label class="fld" id="t-inlabel">You pay (BLOCK)</label>' +
          '<input class="t" id="t-amt" inputmode="decimal" placeholder="0.00">' +
          '<div style="margin-top:10px">' +
            '<div class="qrow"><span>Price</span><b id="t-rate">—</b></div>' +
            '<div class="qrow"><span>You receive ≈</span><b id="t-out">—</b></div>' +
            '<div class="qrow"><span>Min received (1%)</span><b id="t-min">—</b></div>' +
          '</div>' +
          '<div class="terr" id="t-err"></div>' +
          '<button class="cta" id="t-go">Buy ' + sym + '</button>' +
          '<div class="note">Trades are approved in the Blockle wallet extension.</div>' +
        '</div>' +
        '<div class="card"><div class="fld">Share this token</div><div class="sharebar">' +
          '<button id="sh-copy">Copy link</button><button id="sh-x">Share on X</button></div></div>' +
      '</div></div>';

    $('t-buy').onclick = function () { tSide = 'buy'; syncSide(); };
    $('t-sell').onclick = function () { tSide = 'sell'; syncSide(); };
    $('t-amt').oninput = quote;
    $('t-go').onclick = doTrade;
    $('sh-copy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(location.href); $('sh-copy').textContent = 'Copied!'; };
    $('sh-x').onclick = function () { window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent('$' + sym + ' on Blockle — quantum-safe, LP-locked. ') + '&url=' + encodeURIComponent(location.href), '_blank'); };
    syncSide();
  }
  function stat(k, v) { return '<div class="stat"><div class="k">' + k + '</div><div class="val">' + v + '</div></div>'; }

  function syncSide() {
    var sym = pool.symbol || 'token';
    $('t-buy').classList.toggle('on', tSide === 'buy');
    $('t-sell').classList.toggle('on', tSide === 'sell');
    $('t-inlabel').textContent = tSide === 'buy' ? 'You pay (BLOCK)' : 'You pay (' + sym + ')';
    $('t-go').textContent = (tSide === 'buy' ? 'Buy ' : 'Sell ') + sym;
    quote();
  }
  function quote() {
    var raw = parseFloat($('t-amt').value), d = dec(), sym = pool.symbol || 'token';
    var br = (pool.blockReserve || 0) / COIN, tr = (pool.tokenReserve || 0) / Math.pow(10, d);
    if (!(raw > 0)) { $('t-rate').textContent = '—'; $('t-out').textContent = '—'; $('t-min').textContent = '—'; return; }
    var out, rate, outSym;
    if (tSide === 'buy') { out = amountOut(raw, br, tr); rate = '1 BLOCK ≈ ' + fmt(amountOut(1, br, tr)) + ' ' + sym; outSym = sym; }
    else { out = amountOut(raw, tr, br); rate = '1 ' + sym + ' ≈ ' + fmt(amountOut(1, tr, br)) + ' BLOCK'; outSym = 'BLOCK'; }
    $('t-rate').textContent = rate;
    $('t-out').textContent = fmt(out) + ' ' + outSym;
    $('t-min').textContent = fmt(out * (1 - SLIP)) + ' ' + outSym;
  }
  async function doTrade() {
    var raw = parseFloat($('t-amt').value), d = dec(), err = $('t-err'); err.textContent = '';
    var br = (pool.blockReserve || 0) / COIN, tr = (pool.tokenReserve || 0) / Math.pow(10, d);
    if (!(raw > 0)) { err.textContent = 'Enter an amount.'; return; }
    if (typeof window.blockle === 'undefined') { err.textContent = 'Install the Blockle wallet extension to trade.'; return; }
    var btn = $('t-go'); btn.disabled = true; btn.textContent = 'Confirm in wallet…';
    try {
      await window.blockle.connect();
      var amountIn, minOut;
      if (tSide === 'buy') {
        amountIn = BigInt(Math.round(raw * COIN)).toString();
        minOut = BigInt(Math.floor(amountOut(raw, br, tr) * (1 - SLIP) * Math.pow(10, d))).toString();
      } else {
        amountIn = BigInt(Math.round(raw * Math.pow(10, d))).toString();
        minOut = BigInt(Math.floor(amountOut(raw, tr, br) * (1 - SLIP) * COIN)).toString();
      }
      var res = await window.blockle.swap(id, tSide, amountIn, minOut, 200000);
      btn.textContent = 'Submitted ✓';
      setTimeout(function () { btn.disabled = false; syncSide(); load(); }, 1500);
    } catch (e) {
      btn.disabled = false; syncSide();
      err.textContent = (e && e.message) || 'Swap rejected.';
    }
  }

  async function chart() {
    var hist = [];
    try { hist = await (await fetch('/api/dex/history?token=' + id)).json(); } catch (e) {}
    var c = $('chart'); if (!c) return; var ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!hist || hist.length < 2) { if ($('chartnote')) $('chartnote').textContent = 'Price history fills in as snapshots record (every ~15 min).'; return; }
    var ps = hist.map(function (h) { return Number(h.price); });
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps), rng = (hi - lo) || 1, pad = 6;
    ctx.beginPath();
    hist.forEach(function (h, i) { var x = pad + (W - 2 * pad) * (i / (hist.length - 1)); var y = H - pad - (H - 2 * pad) * ((Number(h.price) - lo) / rng); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    var g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#8B6DFF'); g.addColorStop(1, '#37E0C8');
    ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(W - pad, H - pad); ctx.lineTo(pad, H - pad); ctx.closePath(); ctx.fillStyle = 'rgba(139,109,255,.10)'; ctx.fill();
    var chg = ((ps[ps.length - 1] - ps[0]) / ps[0]) * 100, el = $('chg');
    if (el) { el.textContent = (chg >= 0 ? '+' : '') + fmt(chg, 2) + '%'; el.className = 'chg ' + (chg >= 0 ? 'pos' : 'neg'); }
    if ($('chartnote')) $('chartnote').textContent = hist.length + ' snapshots';
  }

  load();
})();
