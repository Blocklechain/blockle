// dex.js — Blockle native-AMM pool explorer. Auto-lists every BLOCK/BLOCK-20
// pool with live reserves, IPFS logos, search, sorting, and the public
// 1-week LP-lock countdown.
(function () {
  'use strict';
  var pools = [], logos = {}, sort = 'lp', q = '';
  var BLOCK_SECS = 600;
  var $ = function (id) { return document.getElementById(id); };

  function ipfs(uri) {
    if (!uri) return null;
    if (uri.indexOf('ipfs://') === 0) return 'https://ipfs.io/ipfs/' + uri.slice(7);
    if (/^[a-zA-Z0-9]{46,}$/.test(uri)) return 'https://ipfs.io/ipfs/' + uri;
    return uri; // already a URL
  }
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 4 : d });
  }
  function dur(blocks) {
    var secs = blocks * BLOCK_SECS;
    if (secs <= 0) return 'unlocked';
    var d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
    if (d > 0) return d + 'd ' + h + 'h';
    var m = Math.floor((secs % 3600) / 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  async function load() {
    try {
      var r = await (await fetch('/api/dex/pools')).json();
      pools = r.pools || [];
      window.__height = r.height || 0;
    } catch (e) { pools = []; }
    try { logos = await (await fetch('/api/dex/tokens')).json(); } catch (e) { logos = {}; }
    render();
  }

  function price(p) {
    // BLOCK per token, decimals-adjusted display
    if (!p.tokenReserve) return null;
    var dec = Number(p.decimals || 0);
    return (p.blockReserve / 1e8) / (p.tokenReserve / Math.pow(10, dec));
  }
  function tvlBlock(p) { return (p.blockReserve || 0) / 1e8 * 2; } // both sides ≈ 2× BLOCK reserve

  function render() {
    var grid = $('grid');
    var height = window.__height || 0;
    var list = pools.filter(function (p) {
      if (!q) return true;
      var hay = ((p.symbol || '') + ' ' + (p.name || '') + ' ' + (p.token || '')).toLowerCase();
      return hay.indexOf(q.toLowerCase()) >= 0;
    });
    list.sort(function (a, b) {
      if (sort === 'new') return (b.createdHeight || 0) - (a.createdHeight || 0);
      if (sort === 'price') return (price(b) || 0) - (price(a) || 0);
      return (b.lpTotal || 0) - (a.lpTotal || 0);
    });
    if (!list.length) {
      grid.innerHTML = '<div class="empty">' + (pools.length ? 'No pools match your search.' : 'No liquidity pools yet — be the first to <a href="/launch">launch a token</a>.') + '</div>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      var sym = p.symbol || '?';
      var logo = ipfs(logos[p.token] && logos[p.token].logo);
      var lockBlocks = (p.lockedUntil || 0) - height;
      var locked = lockBlocks > 0;
      var pr = price(p);
      var avatar = logo
        ? '<span class="logo"><img src="' + logo + '" alt="" onerror="this.parentNode.textContent=\'' + sym.slice(0, 2).toUpperCase() + '\'"></span>'
        : '<span class="logo">' + sym.slice(0, 2).toUpperCase() + '</span>';
      return '<div class="card">' +
        '<a class="chead" href="/token/' + p.token + '" style="color:inherit;text-decoration:none">' + avatar +
          '<div><div class="csym">' + sym + '</div><div class="cname">' + (p.name || 'BLOCK-20 token') + '</div></div>' +
          '<span style="margin-left:auto" class="lock ' + (locked ? 'locked' : 'open') + '">' +
            (locked ? '🔒 ' + dur(lockBlocks) : '🔓 unlocked') + '</span>' +
        '</a>' +
        '<div class="crow"><span class="k">Price</span><span class="v">' + (pr != null ? fmt(pr, 8) + ' BLOCK' : '—') + '</span></div>' +
        '<div class="crow"><span class="k">Liquidity</span><span class="v">' + fmt(tvlBlock(p), 2) + ' BLOCK</span></div>' +
        '<div class="crow"><span class="k">Token reserve</span><span class="v">' + fmt(p.tokenReserve / Math.pow(10, Number(p.decimals || 0)), 2) + ' ' + sym + '</span></div>' +
        '<div class="crow"><span class="k">Created</span><span class="v">block #' + (p.createdHeight || 0) + '</span></div>' +
        '<div class="caddr">' + p.token + '</div>' +
        '<button class="trade" data-t="' + p.token + '">Trade ⇄</button>' +
      '</div>';
    }).join('');
    [].forEach.call(grid.querySelectorAll('.trade'), function (b) {
      b.onclick = function () { openTrade(b.getAttribute('data-t')); };
    });
  }

  // ---- in-page swap (via the wallet provider) ---------------------------
  var SWAP_FEE = 0.003, SLIP = 0.01, COIN = 100000000, tSide = 'buy', tPool = null;
  function amountOut(inAmt, inRes, outRes) {
    if (inAmt <= 0 || inRes <= 0 || outRes <= 0) return 0;
    var ain = inAmt * (1 - SWAP_FEE);
    return (outRes * ain) / (inRes + ain);
  }
  function openTrade(token) {
    tPool = pools.filter(function (p) { return p.token === token; })[0];
    if (!tPool) return;
    tSide = 'buy';
    renderTrade();
    $('tradeModal').classList.add('show');
  }
  function closeTrade() { $('tradeModal').classList.remove('show'); }
  function renderTrade() {
    var p = tPool, sym = p.symbol || 'token';
    $('tradeSheet').innerHTML =
      '<h3>Trade ' + sym + '</h3>' +
      '<div class="tabs2"><button id="t-buy" class="' + (tSide === 'buy' ? 'on' : '') + '">Buy ' + sym + '</button>' +
      '<button id="t-sell" class="' + (tSide === 'sell' ? 'on' : '') + '">Sell ' + sym + '</button></div>' +
      '<label class="tnote" id="t-inlabel"></label>' +
      '<input class="t" id="t-amt" inputmode="decimal" placeholder="0.00">' +
      '<div style="margin-top:10px">' +
        '<div class="qrow"><span>Rate</span><b id="t-rate">—</b></div>' +
        '<div class="qrow"><span>You receive ≈</span><b id="t-out">—</b></div>' +
        '<div class="qrow"><span>Min received (1%)</span><b id="t-min">—</b></div>' +
      '</div>' +
      '<div class="terr" id="t-err"></div>' +
      '<div class="act"><button class="cancel" id="t-cancel">Cancel</button><button class="go" id="t-go">Swap</button></div>' +
      '<div class="tnote">Approve in the Blockle wallet extension. Needs the extension installed &amp; connected.</div>';
    $('t-inlabel').textContent = tSide === 'buy' ? 'You pay (BLOCK)' : 'You pay (' + sym + ')';
    $('t-buy').onclick = function () { tSide = 'buy'; renderTrade(); };
    $('t-sell').onclick = function () { tSide = 'sell'; renderTrade(); };
    $('t-cancel').onclick = closeTrade;
    $('t-amt').oninput = tradeQuote;
    $('t-go').onclick = doTrade;
    tradeQuote();
  }
  function tradeReserves() {
    var p = tPool, dec = Number(p.decimals || 0);
    return { dec: dec, block: p.blockReserve / COIN, tok: p.tokenReserve / Math.pow(10, dec), sym: p.symbol || 'token' };
  }
  function tradeQuote() {
    var raw = parseFloat($('t-amt').value), r = tradeReserves();
    if (!(raw > 0)) { $('t-rate').textContent = '—'; $('t-out').textContent = '—'; $('t-min').textContent = '—'; return; }
    var out, rate, outSym;
    if (tSide === 'buy') { out = amountOut(raw, r.block, r.tok); rate = '1 BLOCK ≈ ' + fmt(amountOut(1, r.block, r.tok)) + ' ' + r.sym; outSym = r.sym; }
    else { out = amountOut(raw, r.tok, r.block); rate = '1 ' + r.sym + ' ≈ ' + fmt(amountOut(1, r.tok, r.block)) + ' BLOCK'; outSym = 'BLOCK'; }
    $('t-rate').textContent = rate;
    $('t-out').textContent = fmt(out) + ' ' + outSym;
    $('t-min').textContent = fmt(out * (1 - SLIP)) + ' ' + outSym;
  }
  async function doTrade() {
    var raw = parseFloat($('t-amt').value), r = tradeReserves(), err = $('t-err');
    err.textContent = '';
    if (!(raw > 0)) { err.textContent = 'Enter an amount.'; return; }
    if (typeof window.blockle === 'undefined') { err.textContent = 'Install the Blockle wallet extension to trade.'; return; }
    var btn = $('t-go'); btn.disabled = true; btn.textContent = 'Confirm in wallet…';
    try {
      await window.blockle.connect();
      var amountIn, minOut;
      if (tSide === 'buy') {
        amountIn = BigInt(Math.round(raw * COIN)).toString();
        minOut = BigInt(Math.floor(amountOut(raw, r.block, r.tok) * (1 - SLIP) * Math.pow(10, r.dec))).toString();
      } else {
        amountIn = BigInt(Math.round(raw * Math.pow(10, r.dec))).toString();
        minOut = BigInt(Math.floor(amountOut(raw, r.tok, r.block) * (1 - SLIP) * COIN)).toString();
      }
      var res = await window.blockle.swap(tPool.token, tSide, amountIn, minOut, 200000);
      $('tradeSheet').innerHTML = '<h3>Swap submitted ✓</h3><div class="qrow"><span>Transaction</span></div>' +
        '<div class="caddr">' + ((res && res.txid) || '') + '</div>' +
        '<div class="act"><button class="go" id="t-done">Done</button></div>';
      $('t-done').onclick = function () { closeTrade(); load(); };
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Swap';
      err.textContent = (e && e.message) || 'Swap rejected.';
    }
  }

  $('q').addEventListener('input', function (e) { q = e.target.value.trim(); render(); });
  [].forEach.call(document.querySelectorAll('#sort button'), function (b) {
    b.onclick = function () {
      sort = b.getAttribute('data-s');
      [].forEach.call(document.querySelectorAll('#sort button'), function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      render();
    };
  });
  load();
})();
