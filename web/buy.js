// buy.js — the Blockle purchase hub. Prices BLOCK off a treasury-backed
// constant-product reserve (USDC on Base × BLOCK on the Blockle chain), reads
// both reserves live from their own chains (proof-of-reserves), quotes buys/
// sells with a flat 5% fee, charts recorded price snapshots, and launches a
// licensed third-party off-ramp (Transak) for the USDC→bank leg.
(function () {
  'use strict';
  var cfg = null, R = null, B = null, FEE = 0.05, side = 'buy';
  var lastBlockIn = 0, lastUsdcOut = 0;

  var $ = function (id) { return document.getElementById(id); };
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 6 : d });
  }

  function spot() { return (R != null && B > 0) ? R / B : null; }
  function live() { return R != null && B != null && R > 0 && B > 0; }

  // ---- load config + reserves -------------------------------------------
  async function load() {
    try { cfg = await (await fetch('/api/buy/config')).json(); } catch (e) { cfg = {}; }
    FEE = (cfg.feeBps != null ? cfg.feeBps : 500) / 10000;
    var api = cfg.explorerApi || 'https://blockle.org/api/explorer';

    // BLOCK reserve (on the Blockle chain)
    if (cfg.blockReserveAddr) {
      try {
        var a = await (await fetch(api + '/address/' + cfg.blockReserveAddr)).json();
        var bal = a.balance != null ? a.balance : (a.confirmed != null ? a.confirmed : null);
        if (bal != null) B = Number(bal) / 1e8;
        $('rBlockLink').href = '/explorer/address/' + cfg.blockReserveAddr;
      } catch (e) {}
    }
    // USDC reserve (Base) via eth_call balanceOf
    var u = cfg.usdc || {};
    if (u.reserveAddr && u.rpc && u.contract) {
      try {
        var addr = u.reserveAddr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
        var body = { jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: u.contract, data: '0x70a08231' + addr }, 'latest'] };
        var r = await (await fetch(u.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
        if (r.result && r.result !== '0x') R = parseInt(r.result, 16) / Math.pow(10, u.decimals || 6);
        $('rUsdcLink').href = 'https://basescan.org/address/' + u.reserveAddr;
      } catch (e) {}
    }
    render();
    chart();
  }

  // ---- render reserves / price ------------------------------------------
  function render() {
    $('rBlock').textContent = B == null ? 'not funded' : fmt(B, 4) + ' BLOCK';
    $('rUsdc').textContent = R == null ? 'not funded' : '$' + fmt(R, 2);
    $('kval').textContent = live() ? fmt(R * B, 0) : '—';
    var s = spot();
    $('price').textContent = s == null ? '—' : fmt(s, 6);
    $('coverage').textContent = R == null ? '—' : '$' + fmt(R, 2) + ' USDC';
    if (!live()) {
      $('zerobanner').hidden = false;
      $('cta').disabled = true; $('cta').textContent = 'Not available yet';
    }
    quote();
  }

  // ---- quote (constant product, 5% fee) ---------------------------------
  function quote() {
    var raw = parseFloat($('amt').value);
    var s = spot();
    if (!live() || !raw || raw <= 0) {
      $('spot').textContent = s == null ? '—' : fmt(s, 6) + ' USDC';
      $('fee').textContent = '—'; $('impact').textContent = '—'; $('out').textContent = '—';
      if (live()) { $('cta').disabled = true; $('cta').textContent = 'Enter an amount'; }
      return;
    }
    var out, feeAmt, impact;
    if (side === 'buy') {
      // pay `raw` USDC, receive BLOCK
      var dxEff = raw * (1 - FEE);
      out = B * dxEff / (R + dxEff);                 // BLOCK out
      feeAmt = raw * FEE;
      var newSpot = (R + dxEff) / (B - out);
      impact = (newSpot / s - 1) * 100;
      $('fee').textContent = '$' + fmt(feeAmt, 2) + ' USDC';
      $('out').textContent = fmt(out, 6) + ' BLOCK';
      $('cta').textContent = 'Buy BLOCK';
    } else {
      // sell `raw` BLOCK, receive USDC
      var dBEff = raw * (1 - FEE);
      out = R * dBEff / (B + dBEff);                 // USDC out
      feeAmt = raw * FEE;
      lastBlockIn = raw; lastUsdcOut = out;
      var newSpot2 = (R - out) / (B + dBEff);
      impact = (1 - newSpot2 / s) * 100;
      $('fee').textContent = fmt(feeAmt, 6) + ' BLOCK';
      $('out').textContent = '$' + fmt(out, 2) + ' USDC';
      $('cta').textContent = 'Sell BLOCK';
    }
    $('spot').textContent = fmt(s, 6) + ' USDC';
    $('impact').textContent = fmt(impact, 2) + '%';
    $('cta').disabled = false;
  }

  // ---- tabs --------------------------------------------------------------
  function setSide(s) {
    side = s;
    $('tabBuy').classList.toggle('on', s === 'buy');
    $('tabSell').classList.toggle('on', s === 'sell');
    $('inLabel').textContent = s === 'buy' ? 'You pay (USDC)' : 'You sell (BLOCK)';
    $('inCur').textContent = s === 'buy' ? 'USDC' : 'BLOCK';
    $('outLbl').textContent = 'You receive';
    $('offramp').hidden = (s !== 'sell') || !offrampReady();
    quote();
  }

  // ---- Transak off-ramp (licensed third party) --------------------------
  function offrampReady() { return !!(cfg && cfg.offramp && cfg.offramp.apiKey); }
  function transakUrl(product) {
    var o = cfg.offramp;
    var base = (o.environment === 'PRODUCTION') ? 'https://global.transak.com' : 'https://staging-global.transak.com';
    var q = new URLSearchParams({
      apiKey: o.apiKey,
      productsAvailed: product,                       // BUY | SELL
      defaultCryptoCurrency: o.defaultCryptoCurrency || 'USDC',
      network: o.network || 'base',
    });
    return base + '?' + q.toString();
  }

  function wireActions() {
    $('tabBuy').onclick = function () { setSide('buy'); };
    $('tabSell').onclick = function () { setSide('sell'); };
    $('amt').addEventListener('input', quote);

    $('cta').onclick = function () {
      if (!live()) return;
      if (side === 'buy') {
        // First leg: acquire USDC (on-ramp). Then the BLOCK is settled from the
        // reserve. On-ramp via the licensed provider when configured.
        if (offrampReady()) { window.open(transakUrl('BUY'), '_blank', 'noopener'); }
        $('execnote').textContent = offrampReady()
          ? 'Opening the on-ramp to fund USDC. BLOCK is then settled from the reserve to your wallet.'
          : 'On-ramp provider not configured yet — set a Transak API key to enable card/bank buys.';
      } else {
        // Partner-first: the USDC->bank cash-out is handled by the licensed
        // off-ramp (Transak). No custodial hot key on our side.
        if (offrampReady()) { window.open(transakUrl('SELL'), '_blank', 'noopener'); }
        $('execnote').textContent = offrampReady()
          ? 'Opening the licensed off-ramp (Transak) to pay your USDC proceeds to your bank. BLOCK↔USDC is settled against the reserve shown above.'
          : 'Off-ramp not configured yet — set a Transak API key to enable bank cash-out.';
      }
    };
    $('offramp').onclick = function () {
      if (offrampReady()) window.open(transakUrl('SELL'), '_blank', 'noopener');
    };
  }

  // ---- sell settlement modal (automated USDC payout) --------------------
  function openSellModal() {
    if (!live() || lastBlockIn <= 0) return;
    var reserve = cfg.blockReserveAddr;
    var sheet = $('sellSheet');
    sheet.innerHTML =
      '<h3>Sell ' + fmt(lastBlockIn, 6) + ' BLOCK</h3>' +
      '<p class="step">You receive <b>$' + fmt(lastUsdcOut, 2) + ' USDC</b> (5% fee included). ' +
      'Automated payout on Base.</p>' +
      '<p class="step">1 · Send exactly <b>' + fmt(lastBlockIn, 6) + ' BLOCK</b> from your wallet to the reserve:</p>' +
      '<div class="addrbox"><span>' + reserve + '</span><button id="cpy">Copy</button></div>' +
      '<p class="step">2 · Paste the BLOCK transaction id you just sent:</p>' +
      '<input class="t" id="btxid" placeholder="BLOCK txid">' +
      '<p class="step">3 · Your Base USDC address to receive the payout:</p>' +
      '<input class="t" id="uaddr" placeholder="0x…">' +
      '<div id="serr" class="err" hidden></div>' +
      '<div class="act"><button class="cancel" id="scancel">Cancel</button>' +
      '<button class="go" id="sgo">Confirm &amp; get USDC</button></div>';
    $('sellModal').classList.add('show');
    $('cpy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(reserve); $('cpy').textContent = 'Copied'; };
    $('scancel').onclick = closeModal;
    $('sgo').onclick = confirmSettle;
  }
  function closeModal() { $('sellModal').classList.remove('show'); }

  async function confirmSettle() {
    var txid = ($('btxid').value || '').trim();
    var uaddr = ($('uaddr').value || '').trim();
    var err = $('serr');
    err.hidden = true;
    if (!txid) { err.textContent = 'Enter the BLOCK transaction id.'; err.hidden = false; return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(uaddr)) { err.textContent = 'Enter a valid Base (0x…) USDC address.'; err.hidden = false; return; }
    // loading state
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
          '<div class="result err"><div class="big">Couldn’t complete</div>' +
          '<p class="step">' + resp.error + '</p></div>' +
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

  // ---- price chart -------------------------------------------------------
  async function chart() {
    var hist = [];
    try { hist = await (await fetch('/api/buy/history')).json(); } catch (e) {}
    var c = $('chart'), ctx = c.getContext('2d');
    var W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!hist || hist.length < 2) {
      $('chartnote').textContent = live()
        ? 'Collecting price history — the chart fills in as snapshots are recorded.'
        : 'No price history yet — the reserve is not funded.';
      return;
    }
    var ps = hist.map(function (h) { return Number(h.price); });
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps), rng = (hi - lo) || 1;
    var pad = 6;
    ctx.beginPath();
    hist.forEach(function (h, i) {
      var x = pad + (W - 2 * pad) * (i / (hist.length - 1));
      var y = H - pad - (H - 2 * pad) * ((Number(h.price) - lo) / rng);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    var g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#8B6DFF'); g.addColorStop(1, '#37E0C8');
    ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    // area fill
    ctx.lineTo(W - pad, H - pad); ctx.lineTo(pad, H - pad); ctx.closePath();
    ctx.fillStyle = 'rgba(139,109,255,.10)'; ctx.fill();

    var first = ps[0], last = ps[ps.length - 1], chg = ((last - first) / first) * 100;
    var el = $('chg');
    el.textContent = (chg >= 0 ? '+' : '') + fmt(chg, 2) + '%';
    el.className = 'chg ' + (chg >= 0 ? 'pos' : 'neg');
    $('chartnote').textContent = hist.length + ' snapshots · range $' + fmt(lo, 6) + '–$' + fmt(hi, 6);
  }

  wireActions();
  load();
})();
