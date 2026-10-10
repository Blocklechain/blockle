/* trade.js — the trading view. Market selector, live order book + recent
 * trades (websocket), signed limit/market orders, cancel, "my orders", and a
 * "my swaps" panel that walks the atomic-swap handshake, prompting the correct
 * wallet to sign each on-chain HTLC step. All signing happens in the user's
 * wallet; the relay only coordinates. */
(function () {
  'use strict';
  var EX = window.EX, $ = EX.$, esc = EX.esc;
  var markets = [], market = null, book = { bids: [], asks: [] };
  var side = 'buy', otype = 'limit', ws = null, lastPx = null;

  function curMarket() { return markets.filter(function (m) { return m.market === market; })[0]; }
  function baseDec() { var m = curMarket(); return (m && m.baseAsset && m.baseAsset.decimals) || 0; }
  function quoteDec() { var m = curMarket(); return (m && m.quoteAsset && m.quoteAsset.decimals) || 0; }
  function baseSym() { var m = curMarket(); return (m && m.base) || 'BASE'; }
  function quoteSym() { var m = curMarket(); return (m && m.quote) || 'QUOTE'; }

  // ---- bootstrap ---------------------------------------------------------
  async function init() {
    EX.mountWalletBar($('walletBar'));
    // Re-render on wallet connect/disconnect: my-orders AND the MoonPay bar
    // (so a freshly connected address flows into the widget links).
    EX.onChange(function () { refreshMine(); renderMoonPay(); });
    try {
      markets = await EX.api.markets() || [];
    } catch (e) { EX.toast('Could not load markets: ' + e.message, 'err'); markets = []; }
    var sel = $('marketSel');
    if (!markets.length) {
      sel.innerHTML = '<option>No markets</option>';
      $('book').innerHTML = '<div class="empty">No markets listed yet. <a href="/list.html">List an asset →</a></div>';
      return;
    }
    sel.innerHTML = markets.map(function (m) {
      return '<option value="' + esc(m.market) + '">' + esc(m.market) + '</option>';
    }).join('');
    sel.onchange = function () { selectMarket(sel.value); };
    selectMarket(markets[0].market);
    wireForm();
  }

  function selectMarket(m) {
    market = m;
    $('bookMarket').textContent = m;
    $('marketMeta').textContent = '';
    var cm = curMarket();
    if (cm) {
      $('marketMeta').textContent = baseSym() + ' (' + cm.baseAsset.chain + ') / ' +
        quoteSym() + ' (' + cm.quoteAsset.chain + ')';
    }
    updateFormLabels();
    loadBook(); loadTrades(); refreshMine();
    renderMoonPay();
    subscribe();
    quoteOrder();
  }

  // ---- MoonPay fiat on/off-ramp -----------------------------------------
  // "Buy with card" + "Sell" for the current market's MoonPay-supported assets
  // (BLOCK is never supported). Links open MoonPay's hosted widget in a new
  // tab; the connected wallet address (for the asset's chain) is passed through
  // as walletAddress when available. Publishable key only — see moonpay.js.
  var MP = window.MoonPay;

  // exchange chain label -> connected wallet kind (core.js keys connected[] by
  // kind). solana/block are their own kinds; everything else is the EVM wallet.
  function kindForChain(chain) {
    if (chain === 'solana') return 'solana';
    if (chain === 'block') return 'block';
    if (chain === 'bitcoin' || chain === 'btc') return 'btc';
    if (chain === 'sui') return 'sui';
    return 'evm';
  }
  function addressForChain(chain) {
    var st = EX.state();
    var c = st.connected && st.connected[kindForChain(chain)];
    return (c && c.address) || '';
  }

  function renderMoonPay() {
    var bar = $('moonpayBar');
    if (!bar || !MP) return;
    bar.innerHTML = '';
    var cm = curMarket();
    if (!cm) return;
    // Candidate assets: the market's base and quote. Dedup by resolved MoonPay
    // code so a market like USDC/USDT doesn't double a button, and skip any
    // asset MoonPay doesn't list (BLOCK, unknown chains/tokens).
    var map = MP.effectiveMap(MP.loadConfig());
    var assets = [
      { chain: cm.baseAsset && cm.baseAsset.chain, symbol: baseSym() },
      { chain: cm.quoteAsset && cm.quoteAsset.chain, symbol: quoteSym() }
    ];
    var seen = {};
    assets.forEach(function (a) {
      if (!a.chain || !a.symbol) return;
      var code = MP.codeForAsset(map, a.chain, a.symbol);
      if (!code || seen[code]) return;
      seen[code] = true;
      bar.appendChild(moonpayGroup(a));
    });
  }

  function moonpayGroup(asset) {
    var wrap = EX.el('span', 'mp-group');
    wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
    var buy = EX.el('button', 'btn ghost sm', 'Buy ' + esc(asset.symbol) + ' with card');
    var sell = EX.el('button', 'btn ghost sm', 'Sell ' + esc(asset.symbol));
    buy.onclick = function () { openMoonPay('buy', asset); };
    sell.onclick = function () { openMoonPay('sell', asset); };
    wrap.appendChild(buy);
    wrap.appendChild(sell);
    return wrap;
  }

  async function openMoonPay(mode, asset) {
    try {
      var wallet = addressForChain(asset.chain) || undefined;
      var fn = mode === 'sell' ? MP.sellUrl : MP.buyUrl;
      var res = await fn({ chain: asset.chain, symbol: asset.symbol, walletAddress: wallet });
      if (!res || !res.ok || !res.url) {
        EX.toast(asset.symbol + ' is not available on MoonPay', 'err');
        return;
      }
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      EX.toast((e && e.message) || 'MoonPay unavailable', 'err');
    }
  }

  // ---- order book --------------------------------------------------------
  async function loadBook() {
    try { book = await EX.api.book(market) || { bids: [], asks: [] }; }
    catch (e) { book = { bids: [], asks: [] }; }
    renderBook();
  }
  function renderBook() {
    var bids = book.bids || [], asks = book.asks || [];
    if (!bids.length && !asks.length) {
      $('book').innerHTML = '<div class="empty" style="grid-column:1/3">No resting orders. Place one — it posts to the book for others (or the relay) to match.</div>';
      return;
    }
    var maxAmt = 0;
    bids.concat(asks).forEach(function (l) { maxAmt = Math.max(maxAmt, Number(l.amount) || 0); });
    function levels(arr, cls) {
      return arr.slice(0, 12).map(function (l) {
        var w = maxAmt ? ((Number(l.amount) || 0) / maxAmt * 100) : 0;
        return '<div class="lvl" data-px="' + esc(l.price) + '" data-amt="' + esc(l.amount) + '">' +
          '<span class="depth" style="width:' + w + '%"></span>' +
          '<span class="px">' + esc(l.price) + '</span>' +
          '<span>' + esc(EX.fmtNum(EX.toHuman(l.amount, baseDec()), 6)) + '</span>' +
        '</div>';
      }).join('') || '<div class="muted" style="padding:6px 8px;font-size:12px">—</div>';
    }
    var bestBid = bids[0] && Number(bids[0].price), bestAsk = asks[0] && Number(asks[0].price);
    var spread = (bestBid && bestAsk) ? (bestAsk - bestBid) : null;
    $('book').innerHTML =
      '<div class="col asks"><h4>Asks · ' + esc(quoteSym()) + '</h4>' + levels(asks.slice().reverse(), 'asks') + '</div>' +
      '<div class="col bids"><h4>Bids · ' + esc(quoteSym()) + '</h4>' + levels(bids, 'bids') + '</div>' +
      (spread != null ? '<div class="spread">spread ' + EX.fmtNum(spread, 8) + ' ' + esc(quoteSym()) + '</div>' : '');
    [].forEach.call($('book').querySelectorAll('.lvl'), function (row) {
      row.onclick = function () {
        $('price').value = row.getAttribute('data-px');
        $('amount').value = EX.toHuman(row.getAttribute('data-amt'), baseDec());
        quoteOrder();
      };
    });
    if (bestBid && bestAsk) setLast((bestBid + bestAsk) / 2);
  }
  function setLast(px) { lastPx = px; $('lastPrice').textContent = EX.fmtNum(px, 8) + ' ' + quoteSym(); }

  // ---- trades ------------------------------------------------------------
  async function loadTrades() {
    var t = [];
    try { t = await EX.api.trades(market) || []; } catch (e) { t = []; }
    renderTrades(t);
  }
  function renderTrades(list) {
    if (!list.length) { $('trades').innerHTML = '<div class="empty">No trades yet</div>'; return; }
    $('trades').innerHTML = list.slice(0, 40).map(function (t) {
      var s = (t.side || '').toLowerCase();
      var when = t.time ? new Date(t.time * (t.time < 1e12 ? 1000 : 1)).toLocaleTimeString() : '';
      return '<div class="t"><span class="' + (s === 'sell' ? 'bad' : 'good') + '">' + esc(t.price != null ? t.price : '—') + '</span>' +
        '<span>' + esc(EX.fmtNum(EX.toHuman(t.amount, baseDec()), 6)) + '</span>' +
        '<span class="muted">' + esc(when) + '</span></div>';
    }).join('');
    if (list[0] && list[0].price != null) setLast(Number(list[0].price));
  }

  // ---- websocket ---------------------------------------------------------
  function subscribe() {
    if (ws) ws.close();
    ws = EX.stream(market, function (msg) {
      if (!msg) return;
      if (msg.market && market && msg.market !== market) return;
      if (msg.type === 'book') { if (msg.book) { book = msg.book; } else if (msg.bids || msg.asks) { book = { bids: msg.bids || [], asks: msg.asks || [] }; } renderBook(); }
      else if (msg.type === 'trade') { prependTrade(msg.trade || msg); }
      else if (msg.type === 'swap') { refreshMine(); }
    });
  }
  var recentTrades = [];
  function prependTrade(t) {
    recentTrades.unshift(t); recentTrades = recentTrades.slice(0, 40); renderTrades(recentTrades);
  }

  // ---- order form --------------------------------------------------------
  function wireForm() {
    [].forEach.call($('sideSeg').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        side = b.getAttribute('data-side');
        [].forEach.call($('sideSeg').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        updateFormLabels(); quoteOrder();
      };
    });
    [].forEach.call($('typeSeg').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        otype = b.getAttribute('data-type');
        [].forEach.call($('typeSeg').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        updateFormLabels(); quoteOrder();
      };
    });
    $('price').oninput = quoteOrder;
    $('amount').oninput = quoteOrder;
    $('placeBtn').onclick = placeOrder;
    updateFormLabels();
  }
  function updateFormLabels() {
    var mkt = otype === 'market';
    $('priceLbl').style.display = mkt ? 'none' : 'block';
    $('price').style.display = mkt ? 'none' : 'block';
    $('priceLbl').textContent = 'Price (' + quoteSym() + ' per ' + baseSym() + ')';
    $('amountLbl').textContent = 'Amount (' + baseSym() + ')';
    var b = $('placeBtn');
    b.className = 'btn ' + (side === 'buy' ? 'buy' : 'sell');
    b.style.width = '100%'; b.style.marginTop = '12px';
    b.textContent = 'Sign & place ' + side + ' ' + (mkt ? 'market' : 'limit') + ' order';
  }
  function quoteOrder() {
    var amt = parseFloat($('amount').value) || 0;
    var px = otype === 'market' ? (lastPx || 0) : (parseFloat($('price').value) || 0);
    var total = amt * px;
    $('orderTotal').textContent = total > 0 ? EX.fmtNum(total, 8) + ' ' + quoteSym() : '—';
    $('orderFee').textContent = total > 0 ? EX.fmtNum(total * EX.PROTOCOL_FEE_BPS / 10000, 8) + ' ' + quoteSym() : '—';
  }

  async function placeOrder() {
    var err = $('orderErr'); err.textContent = ''; err.className = 'err';
    var amtHuman = $('amount').value.trim();
    var pxHuman = $('price').value.trim();
    if (!(parseFloat(amtHuman) > 0)) { err.textContent = 'Enter an amount.'; return; }
    if (otype === 'limit' && !(parseFloat(pxHuman) > 0)) { err.textContent = 'Enter a limit price.'; return; }
    var btn = $('placeBtn'); var orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Confirm in wallet…';
    try {
      await EX.ensureSignedIn();
      var st = EX.state();
      // Intent mirrors the SDK's placeOrder shape so the relay verifies the
      // same canonical bytes. amount = base-asset base units; price = string.
      var intent = {
        market: market,
        side: side,
        type: otype,
        price: otype === 'market' ? null : pxHuman,
        amount: EX.toBase(amtHuman, baseDec()),
        expiry: Math.floor(Date.now() / 1000) + (parseInt($('expiry').value, 10) || 3600),
        maker: st.activeAddress,
        nonce: Date.now() + '-' + Math.random().toString(16).slice(2)
      };
      var signed = await EX.signIntent(intent);
      var body = {};
      for (var k in intent) body[k] = intent[k];
      body.intent = intent;
      body.signature = signed.signature;
      body.chain = signed.chain;      // tells the relay which sig scheme
      var res = await EX.api.placeOrder(body);
      EX.toast('Order placed: ' + ((res && res.orderId) || 'ok'), 'ok');
      $('amount').value = ''; quoteOrder();
      loadBook(); refreshMine();
    } catch (e) {
      err.textContent = (e && e.message) || 'Order rejected.';
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // ---- my orders + swaps -------------------------------------------------
  async function refreshMine() {
    var st = EX.state();
    if (!st.signedIn) {
      $('myOrders').innerHTML = '<div class="empty">Connect a wallet and sign in to see your orders</div>';
      $('mySwaps').innerHTML = '<div class="empty">No swaps yet</div>';
      return;
    }
    try {
      var orders = await EX.api.myOrders() || [];
      renderMyOrders(orders);
    } catch (e) { $('myOrders').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
    try {
      var swaps = await EX.api.mySwaps() || [];
      renderSwaps(swaps);
    } catch (e) { $('mySwaps').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  function renderMyOrders(orders) {
    if (!orders.length) { $('myOrders').innerHTML = '<div class="empty">No open orders</div>'; return; }
    var rows = orders.map(function (o) {
      var status = (o.status || 'open').toLowerCase();
      return '<tr><td>' + esc(o.market) + '</td>' +
        '<td class="' + (o.side === 'sell' ? 'bad' : 'good') + '">' + esc(o.side) + '</td>' +
        '<td class="mono r">' + esc(o.price != null ? o.price : 'mkt') + '</td>' +
        '<td class="mono r">' + esc(EX.fmtNum(EX.toHuman(o.amount, baseDec()), 6)) + '</td>' +
        '<td><span class="tag ' + status + '">' + esc(status) + '</span></td>' +
        '<td class="r">' + (status === 'open' || status === 'pending'
          ? '<button class="btn ghost sm" data-cancel="' + esc(o.orderId) + '">Cancel</button>' : '') + '</td></tr>';
    }).join('');
    $('myOrders').innerHTML = '<div style="overflow-x:auto"><table><thead><tr><th>Market</th><th>Side</th>' +
      '<th class="r">Price</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    [].forEach.call($('myOrders').querySelectorAll('[data-cancel]'), function (b) {
      b.onclick = function () { cancelOrder(b.getAttribute('data-cancel')); };
    });
  }
  async function cancelOrder(orderId) {
    try {
      await EX.ensureSignedIn();
      var signed = await EX.signIntent({ action: 'cancel', orderId: orderId });
      await EX.api.cancelOrder(orderId, { signature: signed.signature, chain: signed.chain });
      EX.toast('Order cancelled', 'ok');
      refreshMine(); loadBook();
    } catch (e) { EX.toast((e && e.message) || 'Cancel failed', 'err'); }
  }

  // ---- atomic-swap stepper ----------------------------------------------
  function renderSwaps(swaps) {
    if (!swaps.length) { $('mySwaps').innerHTML = '<div class="empty">No swaps yet — a filled order starts one here</div>'; return; }
    $('mySwaps').innerHTML = swaps.map(function (s) {
      var state = (s.state || 'pending').toLowerCase();
      var legs = (s.legs || []).map(function (l) {
        return '<div class="leg"><span>' + esc((l.role || '') + ' · ' + (l.chain || '')) + '</span>' +
          '<span>' + esc(EX.fmtNum(l.amount, 6)) + ' ' + esc(l.asset || '') +
          (l.status ? ' <span class="muted">(' + esc(l.status) + ')</span>' : '') + '</span></div>';
      }).join('');
      var done = state === 'done' || state === 'completed' || state === 'refunded';
      return '<div class="swap" data-swap="' + esc(s.swapId) + '">' +
        '<div class="shead"><b>' + esc(s.market || '') + '</b>' +
          '<span class="tag ' + (done ? 'done' : 'pending') + '">' + esc(state) + '</span></div>' +
        (s.hashlock ? '<div class="muted mono" style="font-size:11px;word-break:break-all">H: ' + esc(s.hashlock) + '</div>' : '') +
        '<div class="legs">' + legs + '</div>' +
        '<div class="step-actions">' +
          (done ? '' : '<button class="btn primary sm" data-advance="' + esc(s.swapId) + '">Continue swap</button>') +
          (!done ? '<button class="btn ghost sm" data-refund="' + esc(s.swapId) + '">Refund</button>' : '') +
        '</div>' +
        '<div class="muted step-msg" style="font-size:12px;margin-top:6px"></div>' +
      '</div>';
    }).join('');
    [].forEach.call($('mySwaps').querySelectorAll('[data-advance]'), function (b) {
      b.onclick = function () { advanceSwap(b.getAttribute('data-advance'), 'poll'); };
    });
    [].forEach.call($('mySwaps').querySelectorAll('[data-refund]'), function (b) {
      b.onclick = function () { advanceSwap(b.getAttribute('data-refund'), 'refund-request'); };
    });
  }
  function swapMsg(id, text) {
    var card = $('mySwaps').querySelector('[data-swap="' + id + '"]');
    if (card) card.querySelector('.step-msg').textContent = text;
  }

  // Advance ONE handshake step. Each on-chain action prompts the matching
  // wallet; the client performs the HTLC lock/withdraw/refund itself and
  // reports the receipt back to the relay. (Mirrors ExchangeClient.executeSwap,
  // but button-driven so the user explicitly confirms each wallet signature.)
  async function advanceSwap(id, kick) {
    try {
      await EX.ensureSignedIn();
      swapMsg(id, 'Asking relay for the next step…');
      var step = await EX.api.swapStep(id, { action: kick === 'refund-request' ? 'refund' : 'poll' });
      var act = step && step.action;
      if (act === 'done') { swapMsg(id, 'Swap complete.'); refreshMine(); return; }
      if (act === 'wait') { swapMsg(id, 'Waiting on the counterparty… click Continue again shortly.'); refreshMine(); return; }
      if (act === 'lock' || act === 'withdraw' || act === 'refund') {
        var w = EX.walletForChain(step.chain);
        if (!w.sendStep) throw new Error('No on-chain executor for ' + step.chain + ' in this wallet');
        swapMsg(id, 'Confirm the ' + act + ' on ' + step.chain + ' in your wallet…');
        var receipt = await w.sendStep(step.payload || {});
        var reportAction = act === 'lock' ? 'locked' : act === 'withdraw' ? 'withdrawn' : 'refunded';
        swapMsg(id, 'Reporting ' + reportAction + ' to relay…');
        await EX.api.swapStep(id, { action: reportAction, payload: receipt });
        swapMsg(id, act === 'lock' ? 'Locked. Continue when the counterparty has locked.'
          : act === 'withdraw' ? 'Claimed! Continue to finish.' : 'Refund submitted.');
        refreshMine();
        return;
      }
      swapMsg(id, 'Relay state: ' + (step && step.swap && step.swap.state || 'unknown') + '. Continue to retry.');
      refreshMine();
    } catch (e) {
      swapMsg(id, (e && e.message) || 'Step failed.');
    }
  }

  init();
})();
