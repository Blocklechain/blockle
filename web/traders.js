// traders.js — the public "top traders" social board. Loads /account/api/leaderboard (ranked by
// real PAPER bot P&L — play money, so it's safe to publish and can't be faked into real returns)
// and renders a leaderboard + per-trader profiles (#/u/<handle>). Each bot has a one-click Copy
// that deep-links the wallet to clone the config into your own account (your keys + gate apply).
(function () {
  'use strict';
  var host = document.getElementById('traders');
  if (!host) return;
  var API = host.getAttribute('data-api') || '/account/api';
  var WALLET = host.getAttribute('data-wallet') || '/wallet';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
  var LBL = { dca: 'DCA', grid: 'Grid', smarttrade: 'Smart Trade', signal: 'Signal', rsi: 'RSI', macd: 'MACD', bollinger: 'Bollinger', breakout: 'Breakout', emacross: 'EMA Cross', momentum: 'Momentum', meanrev: 'Mean Rev', rebalance: 'Rebalance', scalp: 'Scalp', hodl: 'HODL', martingale: 'Martingale' };
  var TIER = { free: 'Free', copilot: 'Copilot', copilot_pro: 'Copilot Pro' };

  function get(path) { return fetch(API + path, { headers: { accept: 'application/json' } }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  function leaderboard() {
    host.innerHTML = '<div class="tload">Loading the leaderboard…</div>';
    get('/leaderboard').then(function (d) {
      var rows = (d.traders || []).map(function (t, i) {
        var cls = t.bestPnlPct >= 0 ? 'up' : 'down';
        return '<a class="trow" href="#/u/' + encodeURIComponent(t.handle) + '">' +
          '<span class="rk">' + (i + 1) + '</span>' +
          '<span class="who">@' + esc(t.handle) + '<small>' + (TIER[t.tier] || 'Free') + ' · ' + t.botCount + ' bot' + (t.botCount === 1 ? '' : 's') + ' · best: ' + esc(LBL[t.bestStrategy] || t.bestStrategy) + '</small></span>' +
          '<span class="ret ' + cls + '">' + pct(t.bestPnlPct) + '<small>avg ' + pct(t.avgPnlPct) + '</small></span></a>';
      }).join('');
      host.innerHTML = '<div class="thead"><h2>Top traders</h2><p>Ranked by their best bot&rsquo;s <b>paper P&amp;L</b> (play money — a public, honest board; not real-money returns, not a guarantee).</p></div>' +
        '<div class="tlist">' + (rows || '<div class="empty">No public traders yet — spin up a bot, pick a public @handle, and climb the board.</div>') + '</div>';
    }).catch(function () { host.innerHTML = '<div class="empty">Leaderboard is warming up — check back shortly.</div>'; });
  }

  function profile(handle) {
    host.innerHTML = '<div class="tload">Loading @' + esc(handle) + '…</div>';
    get('/trader/' + encodeURIComponent(handle)).then(function (t) {
      var bots = (t.bots || []).map(function (b) {
        var cls = b.pnlPct >= 0 ? 'up' : 'down';
        return '<div class="brow"><span class="bnm">' + esc(LBL[b.type] || b.type) + '<small>' + esc(b.pair) + ' · ' + b.trades + ' trades · ' + esc(b.status) + '</small></span>' +
          '<span class="ret ' + cls + '">' + pct(b.pnlPct) + '</span>' +
          '<a class="copy" href="' + WALLET + '?copyBot=' + encodeURIComponent(b.id) + '">Copy</a></div>';
      }).join('');
      host.innerHTML = '<div class="thead"><a class="back" href="#/">&larr; Leaderboard</a><h2>@' + esc(t.handle) + '</h2>' +
        '<p>' + (TIER[t.tier] || 'Free') + ' · ' + (t.karma || 0) + ' karma · ' + (t.bots || []).length + ' bots. <b>Paper results</b> (play money). Copy clones the config into your own wallet — your keys and safety gate still apply.</p></div>' +
        '<div class="tlist">' + (bots || '<div class="empty">No public bots.</div>') + '</div>';
    }).catch(function () { host.innerHTML = '<div class="empty">No such trader. <a href="#/">Back to the leaderboard</a>.</div>'; });
  }

  function route() {
    var m = (location.hash || '').match(/^#\/u\/(.+)$/);
    if (m) profile(decodeURIComponent(m[1])); else leaderboard();
  }
  window.addEventListener('hashchange', route);
  route();
})();
