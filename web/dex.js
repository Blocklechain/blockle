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
        '<div class="chead">' + avatar +
          '<div><div class="csym">' + sym + '</div><div class="cname">' + (p.name || 'BLOCK-20 token') + '</div></div>' +
          '<span style="margin-left:auto" class="lock ' + (locked ? 'locked' : 'open') + '">' +
            (locked ? '🔒 ' + dur(lockBlocks) : '🔓 unlocked') + '</span>' +
        '</div>' +
        '<div class="crow"><span class="k">Price</span><span class="v">' + (pr != null ? fmt(pr, 8) + ' BLOCK' : '—') + '</span></div>' +
        '<div class="crow"><span class="k">Liquidity</span><span class="v">' + fmt(tvlBlock(p), 2) + ' BLOCK</span></div>' +
        '<div class="crow"><span class="k">Token reserve</span><span class="v">' + fmt(p.tokenReserve / Math.pow(10, Number(p.decimals || 0)), 2) + ' ' + sym + '</span></div>' +
        '<div class="crow"><span class="k">Created</span><span class="v">block #' + (p.createdHeight || 0) + '</span></div>' +
        '<div class="caddr">' + p.token + '</div>' +
      '</div>';
    }).join('');
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
