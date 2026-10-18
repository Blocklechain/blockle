// bridge.js — Blockle BLOCK <-> wBLOCK bridge UI.
//
// Honest, custodial-bridge front end. It connects a Blockle wallet and a Solana
// wallet, quotes a transfer from live /api/bridge/* figures, and tracks EXPLICIT
// status states. It never implies a transfer is done just because a wallet
// signed something — completion requires source confirmations + the
// mint/release landing on the destination chain, surfaced via the status stages.
//
// No operator credentials or keys ever touch this page. Every figure comes from
// the bridge API; if the API is not live the page renders an honest empty state.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var COIN = 100000000; // both BLOCK and wBLOCK use 8 decimals

  // ---- config pulled from the bridge API (honest defaults until live) -------
  var cfg = {
    live: false,
    feeBps: null,          // fee in basis points, from the API
    minFlatBlock: null,    // optional flat fee in BLOCK base units
    confirmations: 100,    // reuse the chain's 100-block reorg-safety default
    minAmount: null,
    maxAmount: null,
    bridgeAddress: null,   // BLOCK deposit address (shown, never a key)
    paused: false
  };

  var dir = 'b2s'; // 'b2s' = BLOCK->wBLOCK, 's2b' = wBLOCK->BLOCK
  var blk = { addr: null, bal: null };
  var sol = { addr: null, bal: null };
  var state = 'awaiting_wallet';

  // Explicit, ordered status states. We NEVER skip straight to completed.
  var FLOW = ['submitted', 'confirming_source', 'awaiting_verification', 'crediting', 'completed'];
  var STAGE_LABEL = {
    submitted: 'Transaction submitted to source chain',
    confirming_source: 'Waiting for source-chain confirmations',
    awaiting_verification: 'Bridge verifying the deposit',
    crediting: '',                 // filled per direction (minting / releasing)
    completed: 'Transfer complete'
  };

  function fmt(n, d) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: d == null ? 8 : d });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function shorten(a) { return !a ? '' : (a.length > 20 ? a.slice(0, 10) + '…' + a.slice(-8) : a); }

  // which asset/chain is the source for the current direction
  function src() {
    return dir === 'b2s'
      ? { tok: 'BLOCK', chain: 'blk', destTok: 'wBLOCK', destChain: 'sol', destName: 'Solana', verb: 'minting', verbLabel: 'Minting wBLOCK on Solana' }
      : { tok: 'wBLOCK', chain: 'sol', destTok: 'BLOCK', destChain: 'blk', destName: 'Blockle', verb: 'releasing', verbLabel: 'Releasing BLOCK from reserve' };
  }

  // ---- address validation (format-only; the API is the source of truth) -----
  function validBlock(a) { return /^block1[0-9a-z]{20,}$/.test(a || ''); }
  function validSol(a) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || ''); }
  function validDest(a) { return src().destChain === 'blk' ? validBlock(a) : validSol(a); }

  // ---- fee / quote ----------------------------------------------------------
  function feeFor(amount) {
    if (cfg.feeBps == null) return null;
    var fee = amount * (cfg.feeBps / 10000);
    if (cfg.minFlatBlock != null) fee = Math.max(fee, cfg.minFlatBlock / COIN);
    return fee;
  }

  function renderQuote() {
    var s = src();
    var raw = parseFloat($('amt').value);
    var fee = (raw > 0) ? feeFor(raw) : null;
    var out = (raw > 0 && fee != null) ? Math.max(0, raw - fee) : null;
    $('q-fee').textContent = fee != null ? fmt(fee) + ' ' + s.tok : (cfg.feeBps == null ? 'not live' : '—');
    $('q-out').textContent = out != null ? fmt(out) + ' ' + s.destTok : '—';
    $('q-conf').textContent = s.chain === 'blk' ? (cfg.confirmations + ' blocks') : 'Solana finalized';
    updateGo();
  }

  // ---- direction + labels ---------------------------------------------------
  function applyDirection() {
    var s = src();
    $('dir-from').textContent = s.tok;
    $('dir-to').textContent = s.destTok;
    $('amt-label').textContent = 'Amount to send (' + s.tok + ')';
    $('dest-label').textContent = 'Destination ' + (s.destChain === 'blk' ? 'Blockle (block1…)' : 'Solana') + ' address';
    $('dest').placeholder = s.destChain === 'blk' ? 'block1…' : 'Recipient Solana address';
    STAGE_LABEL.crediting = s.verbLabel;
    // source balance hint
    var w = s.chain === 'blk' ? blk : sol;
    $('amt-hint').textContent = w.bal != null ? ('Balance: ' + fmt(w.bal) + ' ' + s.tok) : '';
    validateAll();
    renderQuote();
  }

  // ---- wallet connect --------------------------------------------------------
  async function connectBlk() {
    try {
      if (typeof window.blockle === 'undefined') { setErr('Install the Blockle wallet extension to connect.'); return; }
      var r = await window.blockle.connect();
      blk.addr = (r && (r.address || r.addr)) || (window.blockle.address) || null;
      $('blk-addr').textContent = blk.addr ? shorten(blk.addr) : 'Connected';
      $('blk-connect').textContent = 'Connected'; $('blk-connect').classList.add('conn');
      try { var b = await window.blockle.getBalance(); blk.bal = (typeof b === 'object' ? (b.block || b.amount) : b) / COIN; } catch (e) { blk.bal = null; }
      $('blk-bal').textContent = blk.bal != null ? fmt(blk.bal, 4) + ' BLOCK' : '';
      afterWallet();
    } catch (e) { setErr((e && e.message) || 'Blockle connection rejected.'); }
  }
  async function connectSol() {
    try {
      var p = window.solana || window.phantom && window.phantom.solana;
      if (!p) { setErr('Install a Solana wallet (e.g. Phantom) to connect.'); return; }
      var r = await p.connect();
      sol.addr = (r && r.publicKey ? r.publicKey.toString() : (p.publicKey && p.publicKey.toString())) || null;
      $('sol-addr').textContent = sol.addr ? shorten(sol.addr) : 'Connected';
      $('sol-connect').textContent = 'Connected'; $('sol-connect').classList.add('conn');
      // wBLOCK SPL balance is fetched from the bridge API (needs the mint); left blank if not live.
      if (cfg.live && sol.addr) { try { var j = await getJSON('/api/bridge/balance?owner=' + encodeURIComponent(sol.addr)); if (j && j.solblock != null) { sol.bal = Number(j.solblock) / COIN; } } catch (e) {} }
      $('sol-bal').textContent = sol.bal != null ? fmt(sol.bal, 4) + ' wBLOCK' : '';
      afterWallet();
    } catch (e) { setErr((e && e.message) || 'Solana connection rejected.'); }
  }
  function afterWallet() {
    setErr('');
    applyDirection();
    // auto-fill a sensible destination if the far wallet is connected
    autoDest();
    updateGo();
  }
  function autoDest() {
    if ($('dest').value.trim()) return;
    var dchain = src().destChain;
    var w = dchain === 'blk' ? blk : sol;
    if (w.addr) { $('dest').value = w.addr; validateDest(); }
  }

  // ---- validation + gating ---------------------------------------------------
  function validateAll() { validateAmount(); validateDest(); }
  function validateAmount() {
    var el = $('amt'), raw = parseFloat(el.value);
    el.classList.remove('err');
    if (!el.value) return true;
    if (!(raw > 0)) { el.classList.add('err'); return false; }
    if (cfg.minAmount != null && raw < cfg.minAmount / COIN) { el.classList.add('err'); return false; }
    if (cfg.maxAmount != null && raw > cfg.maxAmount / COIN) { el.classList.add('err'); return false; }
    return true;
  }
  function validateDest() {
    var el = $('dest'), v = el.value.trim();
    el.classList.remove('err');
    if (!v) { $('dest-hint').textContent = ' '; return false; }
    var ok = validDest(v);
    el.classList.toggle('err', !ok);
    $('dest-hint').textContent = ok ? 'Address format looks valid' : ('Not a valid ' + src().destName + ' address');
    $('dest-hint').style.color = ok ? 'var(--good)' : 'var(--bad)';
    return ok;
  }
  function updateGo() {
    var go = $('go');
    var s = src();
    var srcWallet = s.chain === 'blk' ? blk : sol;
    if (!srcWallet.addr) { go.disabled = true; go.textContent = 'Connect your ' + (s.chain === 'blk' ? 'Blockle' : 'Solana') + ' wallet'; return; }
    if (!cfg.live) { go.disabled = true; go.textContent = 'Bridge not yet live'; return; }
    if (cfg.paused) { go.disabled = true; go.textContent = 'Bridge paused by operator'; return; }
    var raw = parseFloat($('amt').value);
    var amtOk = validateAmount() && raw > 0;
    var destOk = validateDest();
    go.disabled = !(amtOk && destOk);
    go.textContent = 'Bridge ' + s.tok + ' → ' + s.destTok;
  }
  function setErr(m) { $('err').textContent = m || ''; }

  // ---- submit flow -----------------------------------------------------------
  async function submit() {
    setErr('');
    var s = src();
    var raw = parseFloat($('amt').value);
    var dest = $('dest').value.trim();
    if (!(raw > 0) || !validDest(dest)) { updateGo(); return; }
    var go = $('go'); go.disabled = true; go.textContent = 'Confirm in your wallet…';

    var amountBase = BigInt(Math.round(raw * COIN)).toString();
    var sourceTxid = null;
    try {
      if (dir === 'b2s') {
        // Send BLOCK to the bridge deposit address from the Blockle wallet.
        if (!cfg.bridgeAddress) throw new Error('Bridge deposit address unavailable.');
        var r = await window.blockle.send(cfg.bridgeAddress, amountBase);
        sourceTxid = (r && r.txid) || null;
      } else {
        // Burn/transfer wBLOCK to the bridge on Solana. The server wires the
        // exact instruction; we surface whatever txid the wallet returns.
        var p = window.solana || (window.phantom && window.phantom.solana);
        if (!p) throw new Error('Solana wallet not connected.');
        // Ask the bridge service to build the burn transaction, then sign it.
        var built = await postJSON('/api/bridge/burn/build', { owner: sol.addr, amountBase: amountBase, to: dest });
        if (!built || !built.txBase64) throw new Error((built && built.error) || 'Bridge could not build the transaction.');
        // Signing happens in the wallet; completion still depends on the bridge.
        var sig = await signSolana(p, built.txBase64);
        sourceTxid = sig || null;
      }
    } catch (e) {
      go.disabled = false; updateGo();
      setErr((e && e.message) || 'Wallet rejected the transaction.');
      return;
    }

    // Register the transfer with the bridge so it can verify + credit.
    var reg;
    try {
      reg = await postJSON('/api/bridge/transfer', {
        direction: dir, amountBase: amountBase, to: dest, sourceTxid: sourceTxid
      });
    } catch (e) { reg = null; }
    if (!reg || !reg.id) {
      // We submitted a source tx but the bridge did not register it. Be honest.
      renderStages('submitted', { sourceTxid: sourceTxid });
      setErr('Your source transaction was sent (' + shorten(sourceTxid || '') + ') but the bridge has not acknowledged it yet. It will be picked up once the bridge indexes the deposit — track it on the transactions explorer.');
      go.textContent = 'Submitted — see status below';
      return;
    }
    // Poll the bridge for authoritative status; the signature alone proves nothing.
    trackTransfer(reg.id, sourceTxid);
  }

  async function signSolana(p, txBase64) {
    // Decode base64 -> Uint8Array, hand to the wallet's signAndSendTransaction.
    var bin = atob(txBase64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    if (p.signAndSendTransaction) { var r = await p.signAndSendTransaction(arr); return (r && (r.signature || r)) || null; }
    throw new Error('Connected Solana wallet cannot sign transactions.');
  }

  function trackTransfer(id, sourceTxid) {
    $('go').textContent = 'Tracking transfer…';
    renderStages('submitted', { id: id, sourceTxid: sourceTxid });
    var tries = 0;
    var poll = async function () {
      tries++;
      var t = await getJSON('/api/bridge/transactions/' + encodeURIComponent(id));
      if (t && t.state) {
        renderStages(t.state, t);
        if (t.state === 'completed' || t.state === 'failed' || t.state === 'refunded') { return; }
      }
      if (tries < 600) setTimeout(poll, 5000); // ~50 min of polling
    };
    poll();
  }

  function renderStages(curState, info) {
    state = curState;
    var el = $('stages'); el.hidden = false;
    info = info || {};
    var failed = curState === 'failed';
    var refund = curState === 'refund_pending' || curState === 'refunded';
    var idx = FLOW.indexOf(curState);
    var html = FLOW.map(function (st, i) {
      var cls = '';
      if (failed && i > (idx < 0 ? 0 : idx)) cls = '';
      if (i < idx || curState === 'completed' && i <= idx) cls = 'done';
      else if (i === idx) cls = (curState === 'completed') ? 'done' : 'active';
      if (failed && i === Math.max(idx, 0)) cls = 'fail';
      return '<li class="' + cls + '"><span class="dot"></span>' + esc(STAGE_LABEL[st]) + '</li>';
    }).join('');
    var extra = '';
    if (info.sourceTxid) extra += '<li style="color:var(--muted);font:11px var(--mono)"><span class="dot" style="opacity:0"></span>src: ' + esc(info.sourceTxid) + '</li>';
    if (info.destTxid) extra += '<li style="color:var(--muted);font:11px var(--mono)"><span class="dot" style="opacity:0"></span>dst: ' + esc(info.destTxid) + '</li>';
    if (refund) extra += '<li class="fail"><span class="dot"></span>' + (curState === 'refunded' ? 'Refunded to source' : 'Refund pending') + '</li>';
    if (failed) extra += '<li class="fail"><span class="dot"></span>Transfer failed' + (info.error ? ' — ' + esc(info.error) : '') + '</li>';
    el.innerHTML = '<li style="color:var(--text);font-weight:700;padding-bottom:6px"><span class="dot" style="opacity:0"></span>Status: <span class="statepill" style="margin-left:6px">' + esc(curState) + '</span></li>' + html + extra;
  }

  // ---- reserves panel --------------------------------------------------------
  function renderReserves(r) {
    var el = $('reserves');
    if (!r) { el.innerHTML = '<div class="empty">Bridge not yet live — reserve data will appear here once the service is online.</div>'; return; }
    var reserve = r.reserveBlock != null ? Number(r.reserveBlock) / COIN : null;
    var wrapped = r.wrappedSupply != null ? Number(r.wrappedSupply) / COIN : null;
    var ratio = (reserve != null && wrapped != null && wrapped > 0) ? (reserve / wrapped) : (wrapped === 0 ? 1 : null);
    var html = '';
    html += '<div style="text-align:center;margin:2px 0 14px">';
    html += '<div class="ratio">' + (ratio != null ? (ratio * 100).toFixed(1) + '%' : '—') + '</div>';
    html += '<small>backing ratio (reserve BLOCK ÷ wBLOCK supply)</small></div>';
    html += '<div class="rrow"><span class="k">BLOCK in reserve</span><span class="v">' + (reserve != null ? fmt(reserve, 4) : '—') + '</span></div>';
    html += '<div class="rrow"><span class="k">wBLOCK in circulation</span><span class="v">' + (wrapped != null ? fmt(wrapped, 4) : '—') + '</span></div>';
    if (r.feeBps != null) html += '<div class="rrow"><span class="k">Bridge fee</span><span class="v">' + (r.feeBps / 100) + '%</span></div>';
    if (r.minAmount != null) html += '<div class="rrow"><span class="k">Min per transfer</span><span class="v">' + fmt(Number(r.minAmount) / COIN, 4) + '</span></div>';
    if (r.maxAmount != null) html += '<div class="rrow"><span class="k">Max per transfer</span><span class="v">' + fmt(Number(r.maxAmount) / COIN, 4) + '</span></div>';
    if (r.dailyRemaining != null) html += '<div class="rrow"><span class="k">Daily headroom left</span><span class="v">' + fmt(Number(r.dailyRemaining) / COIN, 4) + '</span></div>';
    if (r.bridgeAddress) html += '<div class="rrow"><span class="k">Deposit address</span><span class="v" style="font-size:11px;word-break:break-all">' + esc(r.bridgeAddress) + '</span></div>';
    html += '<div style="font-size:11px;color:var(--muted);margin-top:12px">Figures read live from the bridge service. A backing ratio below 100% means not all wBLOCK is currently covered by reserve BLOCK.</div>';
    el.innerHTML = html;
  }

  // ---- api helpers -----------------------------------------------------------
  async function getJSON(u) { try { var r = await fetch(u, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
  async function postJSON(u, body) {
    var r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { var j = null; try { j = await r.json(); } catch (e) {} throw new Error((j && j.error) || ('Bridge error ' + r.status)); }
    return await r.json();
  }

  function setBanner() {
    var b = $('banner');
    if (!cfg.live) {
      b.className = 'banner off';
      b.innerHTML = '<span>🚧</span><div><b>Bridge not yet live.</b> You can connect wallets and review how it works, but transfers are disabled until the bridge service is online. Figures below are omitted until then.</div>';
    } else if (cfg.paused) {
      b.className = 'banner warn';
      b.innerHTML = '<span>⏸</span><div><b>Bridge paused.</b> The operator has temporarily paused new transfers. In-flight transfers continue to process.</div>';
    } else {
      b.className = 'banner live';
      b.innerHTML = '<span>✓</span><div><b>Bridge is live.</b> Custodial, trusted-operator design — wBLOCK is backed by BLOCK held in the operator reserve. Confirm the direction and destination carefully; transfers are irreversible.</div>';
    }
  }

  async function loadConfig() {
    var info = await getJSON('/api/bridge/info');
    if (info) {
      cfg.live = info.live !== false && info.enabled !== false;
      if (info.feeBps != null) cfg.feeBps = Number(info.feeBps);
      if (info.minFlatBlock != null) cfg.minFlatBlock = Number(info.minFlatBlock);
      if (info.confirmations != null) cfg.confirmations = Number(info.confirmations);
      if (info.minAmount != null) cfg.minAmount = Number(info.minAmount);
      if (info.maxAmount != null) cfg.maxAmount = Number(info.maxAmount);
      if (info.bridgeAddress) cfg.bridgeAddress = info.bridgeAddress;
      cfg.paused = !!info.paused;
    } else {
      cfg.live = false;
    }
    setBanner();
    renderReserves(await getJSON('/api/bridge/reserves'));
    applyDirection();
    updateGo();
  }

  // ---- wiring ----------------------------------------------------------------
  $('blk-connect').onclick = connectBlk;
  $('sol-connect').onclick = connectSol;
  $('dir-swap').onclick = function () { dir = dir === 'b2s' ? 's2b' : 'b2s'; $('dest').value = ''; applyDirection(); autoDest(); updateGo(); };
  $('amt').addEventListener('input', function () { applyDirection(); renderQuote(); });
  $('dest').addEventListener('input', function () { validateDest(); updateGo(); });
  $('amt-max').onclick = function () { var w = src().chain === 'blk' ? blk : sol; if (w.bal != null) { $('amt').value = w.bal; applyDirection(); renderQuote(); } };
  $('dest-self').onclick = function () { var w = src().destChain === 'blk' ? blk : sol; if (w.addr) { $('dest').value = w.addr; validateDest(); updateGo(); } };
  $('go').onclick = submit;

  loadConfig();
  setInterval(function () { getJSON('/api/bridge/reserves').then(renderReserves); }, 30000);
})();
