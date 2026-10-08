// buy.js — the Blockle purchase hub. BLOCK is priced by a rising primary-sale
// curve whose price is a pure function of the USDC actually raised into the
// reserve (verifiable on Base):
//
//     price(R) = max(p0, sqrt(p0^2 + 2*k*R))         // p0 = $0.10 floor
//     blockSold(R) = (price - p0) / k
//     k = 2*(targetUsdc - p0*allocation) / allocation^2
//
// At R = 0 the price is exactly the $0.10 floor; it only rises as USDC
// accumulates, and reaches the configured target (e.g. $2,000,000) exactly
// when the whole allocation (e.g. 210,000 BLOCK) has been sold. 5% fee on
// every quote. USDC->bank cash-out is handled by a licensed off-ramp (Transak).
(function () {
  'use strict';
  var cfg = null, R = null, FEE = 0.05, side = 'buy';
  var P0 = 0.10, K = 0, TARGET = 2000000, ALLOC = 210000;
  var ethBal = 0, sellOpen = false, lastBlockIn = 0, lastUsdcOut = 0;
  var BASE_ADDR = /^0x[0-9a-fA-F]{40}$/;

  var $ = function (id) { return document.getElementById(id); };
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 6 : d });
  }

  // ---- curve ------------------------------------------------------------
  function priceAt(r) { return Math.max(P0, Math.sqrt(P0 * P0 + 2 * K * r)); }
  function soldAt(r) { return (priceAt(r) - P0) / K; }          // BLOCK sold at reserve r
  function reserveForN(n) { n = Math.max(0, n); return P0 * n + K * n * n / 2; }
  function funded() { return R != null; }

  // ---- load config + reserve -------------------------------------------
  async function load() {
    try { cfg = await (await fetch('/api/buy/config')).json(); } catch (e) { cfg = {}; }
    FEE = (cfg.feeBps != null ? cfg.feeBps : 500) / 10000;
    var cv = cfg.curve || {};
    P0 = cv.startPrice != null ? cv.startPrice : 0.10;
    TARGET = cv.targetUsdc != null ? cv.targetUsdc : 2000000;
    ALLOC = cv.allocation != null ? cv.allocation : 210000;
    K = 2 * (TARGET - P0 * ALLOC) / (ALLOC * ALLOC);

    // USDC reserve (Base) via eth_call balanceOf — this single number drives price.
    var u = cfg.usdc || {};
    R = 0; // floor applies even at zero reserve
    if (u.reserveAddr && u.rpc && u.contract) {
      try {
        var addr = u.reserveAddr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
        var body = { jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: u.contract, data: '0x70a08231' + addr }, 'latest'] };
        var r = await (await fetch(u.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
        if (r.result && r.result !== '0x') R = parseInt(r.result, 16) / Math.pow(10, u.decimals || 6);
        $('rUsdcLink').href = 'https://basescan.org/address/' + u.reserveAddr;
        // Base ETH balance of the hot wallet (gas) — sells need gas + USDC.
        var eb = await (await fetch(u.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [u.reserveAddr, 'latest'] }) })).json();
        if (eb.result && eb.result !== '0x') ethBal = parseInt(eb.result, 16) / 1e18;
      } catch (e) {}
    }
    // Buying is open immediately; selling unlocks only when the hot wallet
    // holds both Base ETH (gas) and USDC (to pay sellers out).
    sellOpen = ethBal > 0 && (R || 0) > 0;
    if (cfg.blockReserveAddr) $('rBlockLink').href = '/explorer/address/' + cfg.blockReserveAddr;
    render();
    chart();
    setSide(side);
  }

  // ---- render -----------------------------------------------------------
  function render() {
    var price = priceAt(R || 0);
    var sold = soldAt(R || 0);
    var remaining = Math.max(0, ALLOC - sold);
    var raisedPct = Math.min(100, (R || 0) / TARGET * 100);
    $('price').textContent = fmt(price, 4);
    $('rUsdc').textContent = '$' + fmt(R || 0, 2);
    $('raised').textContent = '$' + fmt(R || 0, 0) + ' / $' + fmt(TARGET, 0);
    $('raisedBar').style.width = raisedPct.toFixed(2) + '%';
    $('sold').textContent = fmt(sold, 2) + ' BLOCK';
    $('remain').textContent = fmt(remaining, 2) + ' BLOCK';
    $('sellStatus').textContent = sellOpen ? 'Open' : 'Opens when funded';
    $('sellStatus').style.color = sellOpen ? 'var(--good)' : 'var(--muted)';
    quote();
  }

  // ---- quote (5% fee, floored at $0.10) ---------------------------------
  function quote() {
    var raw = parseFloat($('amt').value);
    var price = priceAt(R || 0);
    $('spot').textContent = fmt(price, 4) + ' USDC';
    if (!raw || raw <= 0) {
      $('fee').textContent = '—'; $('avg').textContent = '—'; $('out').textContent = '—';
      $('cta').disabled = true; $('cta').textContent = side === 'buy' ? 'Enter USDC amount' : 'Enter BLOCK amount';
      return;
    }
    var out, feeAmt, avg;
    if (side === 'buy') {
      var net = raw * (1 - FEE);
      var r2 = (R || 0) + net;
      out = soldAt(r2) - soldAt(R || 0);              // BLOCK delivered
      feeAmt = raw * FEE;
      avg = out > 0 ? net / out : price;
      avg = Math.max(P0, avg);                        // never below the $0.10 floor
      $('fee').textContent = '$' + fmt(feeAmt, 2) + ' USDC';
      $('avg').textContent = '$' + fmt(avg, 4) + ' / BLOCK';
      $('out').textContent = fmt(out, 6) + ' BLOCK';
      $('cta').textContent = 'Buy BLOCK';
    } else {
      var n = soldAt(R || 0);
      var n2 = Math.max(0, n - raw);
      var gross = (R || 0) - reserveForN(n2);
      feeAmt = gross * FEE;
      out = gross * (1 - FEE);                         // USDC proceeds
      avg = raw > 0 ? gross / raw : price;
      lastBlockIn = raw; lastUsdcOut = out;
      $('fee').textContent = '$' + fmt(feeAmt, 2) + ' USDC';
      $('avg').textContent = '$' + fmt(avg, 4) + ' / BLOCK';
      $('out').textContent = '$' + fmt(out, 2) + ' USDC';
      $('cta').textContent = sellOpen ? 'Sell BLOCK' : 'Selling opens when funded';
    }
    $('cta').disabled = (side === 'sell' && !sellOpen);
  }

  // ---- tabs -------------------------------------------------------------
  function setSide(s) {
    side = s;
    $('tabBuy').classList.toggle('on', s === 'buy');
    $('tabSell').classList.toggle('on', s === 'sell');
    $('inLabel').textContent = s === 'buy' ? 'You pay (USDC)' : 'You sell (BLOCK)';
    $('inCur').textContent = s === 'buy' ? 'USDC' : 'BLOCK';
    $('offramp').hidden = (s !== 'sell') || !offrampReady();
    quote();
  }

  // ---- Transak off-ramp (licensed third party) --------------------------
  function offrampReady() { return !!(cfg && cfg.offramp && cfg.offramp.apiKey); }
  function transakUrl(product) {
    var o = cfg.offramp;
    var base = (o.environment === 'PRODUCTION') ? 'https://global.transak.com' : 'https://staging-global.transak.com';
    var q = new URLSearchParams({
      apiKey: o.apiKey, productsAvailed: product,
      defaultCryptoCurrency: o.defaultCryptoCurrency || 'USDC', network: o.network || 'base',
    });
    return base + '?' + q.toString();
  }

  function wireActions() {
    $('tabBuy').onclick = function () { setSide('buy'); };
    $('tabSell').onclick = function () { setSide('sell'); };
    $('amt').addEventListener('input', quote);
    $('cta').onclick = function () {
      if (side === 'buy') {
        if (offrampReady()) window.open(transakUrl('BUY'), '_blank', 'noopener');
        $('execnote').textContent = offrampReady()
          ? 'Opening the on-ramp (Transak) to fund USDC; BLOCK is released from the reserve at the curve price.'
          : 'On-ramp not configured yet — set a Transak API key to enable card buys.';
      } else {
        if (!sellOpen) { $('execnote').textContent = 'Selling opens once the reserve hot wallet holds Base ETH (gas) and USDC.'; return; }
        openSellModal();
      }
    };
    $('offramp').onclick = function () { if (offrampReady()) window.open(transakUrl('SELL'), '_blank', 'noopener'); };
  }

  // ---- sell settlement modal (automated USDC payout) --------------------
  function openSellModal() {
    if (!sellOpen || lastBlockIn <= 0) return;
    var reserve = cfg.blockReserveAddr;
    var sheet = $('sellSheet');
    sheet.innerHTML =
      '<h3>Sell ' + fmt(lastBlockIn, 6) + ' BLOCK</h3>' +
      '<p class="step">You receive <b>$' + fmt(lastUsdcOut, 2) + ' USDC</b> (5% fee included), paid to your Base address.</p>' +
      '<p class="step">1 · Send exactly <b>' + fmt(lastBlockIn, 6) + ' BLOCK</b> from your wallet to the reserve:</p>' +
      '<div class="addrbox"><span>' + reserve + '</span><button id="cpy">Copy</button></div>' +
      '<p class="step">2 · Your Base USDC payout address:</p>' +
      '<input class="t" id="uaddr" placeholder="0x… (Base)">' +
      '<p class="step">3 · The BLOCK transaction id you just sent:</p>' +
      '<input class="t" id="btxid" placeholder="BLOCK txid">' +
      '<div id="serr" class="err" hidden></div>' +
      '<div class="act"><button class="cancel" id="scancel">Cancel</button>' +
      '<button class="go" id="sgo">Confirm &amp; get USDC</button></div>';
    $('sellModal').classList.add('show');
    $('cpy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(reserve); $('cpy').textContent = 'Copied'; };
    $('scancel').onclick = closeModal;
    // live validate the Base address as they type
    $('uaddr').addEventListener('input', function () {
      var v = $('uaddr').value.trim();
      $('uaddr').style.borderColor = v === '' ? '' : (BASE_ADDR.test(v) ? 'var(--good)' : 'var(--bad)');
    });
    $('sgo').onclick = confirmSettle;
  }
  function closeModal() { $('sellModal').classList.remove('show'); }

  async function confirmSettle() {
    var txid = ($('btxid').value || '').trim();
    var uaddr = ($('uaddr').value || '').trim();
    var err = $('serr'); err.hidden = true;
    if (!BASE_ADDR.test(uaddr)) { err.textContent = 'Enter a valid Base (0x…) address — 42 chars.'; err.hidden = false; return; }
    if (!txid) { err.textContent = 'Enter the BLOCK transaction id you sent.'; err.hidden = false; return; }
    $('sellSheet').innerHTML =
      '<h3>Sending your USDC…</h3><div class="spin"></div>' +
      '<p class="step" style="text-align:center">Verifying your BLOCK on-chain and paying out on Base. Keep this open.</p>';
    try {
      var resp = await (await fetch('/api/buy/settle', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockTxid: txid, userUsdcAddr: uaddr })
      })).json();
      if (resp.error) {
        $('sellSheet').innerHTML =
          '<div class="result err"><div class="big">Couldn’t complete</div><p class="step">' + resp.error + '</p></div>' +
          '<div class="act"><button class="cancel" id="sclose">Close</button></div>';
      } else {
        $('sellSheet').innerHTML =
          '<div class="result ok"><div class="big">Sent ✓ $' + fmt(resp.usdcOut, 2) + ' USDC</div>' +
          '<p class="step">Paid to your Base wallet. Transaction:</p>' +
          '<a href="' + resp.explorer + '" target="_blank" rel="noopener">' + resp.txHash + '</a></div>' +
          '<div class="act"><button class="go" id="sclose">Done</button></div>';
      }
    } catch (e) {
      $('sellSheet').innerHTML =
        '<div class="result err"><div class="big">Network error</div>' +
        '<p class="step">The settlement service didn’t respond. Your BLOCK is safe; try again shortly.</p></div>' +
        '<div class="act"><button class="cancel" id="sclose">Close</button></div>';
    }
    var cl = document.getElementById('sclose'); if (cl) cl.onclick = function () { closeModal(); load(); };
  }

  // ---- price chart ------------------------------------------------------
  async function chart() {
    var hist = [];
    try { hist = await (await fetch('/api/buy/history')).json(); } catch (e) {}
    var c = $('chart'), ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!hist || hist.length < 2) {
      $('chartnote').textContent = 'Price starts at the $' + fmt(P0, 2) + ' floor and rises as USDC is raised. The chart fills in as snapshots record.';
      return;
    }
    var ps = hist.map(function (h) { return Number(h.price); });
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps), rng = (hi - lo) || 1, pad = 6;
    ctx.beginPath();
    hist.forEach(function (h, i) {
      var x = pad + (W - 2 * pad) * (i / (hist.length - 1));
      var y = H - pad - (H - 2 * pad) * ((Number(h.price) - lo) / rng);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    var g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#8B6DFF'); g.addColorStop(1, '#37E0C8');
    ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(W - pad, H - pad); ctx.lineTo(pad, H - pad); ctx.closePath();
    ctx.fillStyle = 'rgba(139,109,255,.10)'; ctx.fill();
    var chg = ((ps[ps.length - 1] - ps[0]) / ps[0]) * 100;
    var el = $('chg'); el.textContent = (chg >= 0 ? '+' : '') + fmt(chg, 2) + '%';
    el.className = 'chg ' + (chg >= 0 ? 'pos' : 'neg');
    $('chartnote').textContent = hist.length + ' snapshots · $' + fmt(lo, 4) + '–$' + fmt(hi, 4);
  }

  wireActions();
  load();
})();
