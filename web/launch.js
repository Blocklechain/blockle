// launch.js — the Blockle token launchpad.
//
// Flow: connect wallet → pay the launch fee (PayPal; a developer deploy + listing
// SERVICE charge, not a token/BLOCK sale) → optionally receive the promo BLOCK
// preseed → the user signs ONE on-chain LaunchToken (deploy + mint + seed pool)
// in their own non-custodial wallet → we register the logo/listing and confirm
// the pool. Also sells Featured/Boost placement (pure advertising).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var CFG = null;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function utxoSig(addr) {
    try {
      var r = await fetch('/api/explorer/utxos/' + encodeURIComponent(addr), { cache: 'no-store' });
      if (!r.ok) return null;
      var j = await r.json();
      var ids = (j.utxos || []).map(function (u) { return u.txid + ':' + u.vout; }).sort().join(',');
      return (j.count || 0) + '|' + (j.spendable || 0) + '|' + ids;
    } catch (_) { return null; }
  }
  async function waitConfirmed(addr, prev, k, label) {
    if (!addr) { if (k) setStep(k, 'active', (label || '') + ' — waiting for confirmation…'); await sleep(150000); return true; }
    var deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await sleep(5000);
      var now = await utxoSig(addr);
      if (now !== null && now !== prev) return true;
      if (k) setStep(k, 'active', label + ' — waiting for confirmation…');
    }
    return false;
  }
  async function waitPoolListed(contract) {
    var deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      try {
        var r = await fetch('/api/dex/pools', { cache: 'no-store' });
        if (r.ok) { var j = await r.json(); if (((j && j.pools) || []).some(function (p) { return (p.token || p.contract) === contract; })) return true; }
      } catch (_) {}
      await sleep(5000);
    }
    return false;
  }
  function setStep(k, state, sub) {
    var li = document.querySelector('.steps li[data-k="' + k + '"]');
    if (!li) return;
    li.classList.remove('active', 'done'); if (state) li.classList.add(state);
    var sm = $('s-' + k);
    if (sub && sm) { var waiting = /waiting|approve/i.test(sub); sm.classList.toggle('waiting', waiting); sm.textContent = waiting ? sub.replace(/[.…]+\s*$/, '') : sub; }
  }

  // ---- logo preview ----
  $('pick').onclick = function () { $('file').click(); };
  $('file').onchange = function (e) { var f = e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { $('logo').value = r.result; showPrev(r.result); }; r.readAsDataURL(f); };
  $('logo').addEventListener('input', function () { showPrev($('logo').value.trim()); });
  function logoUrl(v) { if (!v) return null; if (v.indexOf('ipfs://') === 0) return 'https://ipfs.io/ipfs/' + v.slice(7); if (/^[a-zA-Z0-9]{46,}$/.test(v)) return 'https://ipfs.io/ipfs/' + v; return v; }
  function showPrev(v) { var u = logoUrl(v); $('prev').innerHTML = u ? '<img src="' + u + '" alt="">' : 'logo'; }

  // ---- config / launch terms ----
  async function loadConfig() {
    try { CFG = await (await fetch('/api/launch/config', { cache: 'no-store' })).json(); }
    catch (_) { CFG = null; }
    var fb = $('feebanner'), go = $('go');
    if (!CFG) { fb.textContent = 'Launch terms are unavailable right now — please retry shortly.'; return; }
    var fee = CFG.feeUsd;
    if (CFG.preseedAvailable) {
      $('preseedRow').style.display = 'block';
      $('preseedAmt').textContent = CFG.preseedBlock;
      fb.innerHTML = 'Promo: <b>$' + fee + '</b> to launch, with an optional free <b>' + CFG.preseedBlock + ' BLOCK</b> preseed for your pool. ' + CFG.promoRemaining + ' promo launches left; after that it’s $' + (CFG.addonPrices ? 1 : 1) + ' and no preseed.';
    } else {
      $('preseedRow').style.display = 'none';
      fb.innerHTML = '<b>$' + fee + '</b> to launch (developer deploy &amp; listing service). You seed your own pool liquidity.';
    }
    go.textContent = CFG.paymentsEnabled ? ('Pay $' + fee + ' & launch') : 'Launch (payments coming soon)';
    // promote add-on labels
    if (CFG.addonPrices) refreshPromotePrice();
  }
  function refreshPromotePrice() {
    try {
      var tier = $('pmTier').value, dur = $('pmDur').value;
      var p = CFG && CFG.addonPrices && CFG.addonPrices[tier] && CFG.addonPrices[tier][dur];
      $('pmGo').textContent = p ? ('Buy placement — $' + p) : 'Buy placement';
    } catch (_) {}
  }

  // ---- PayPal: create order, open approval popup, poll capture ----
  async function payOrder(payload, stepKey, labelFee) {
    if (!CFG || !CFG.paymentsEnabled) throw new Error('Payments are not enabled yet.');
    var r = await fetch('/api/launch/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    var o = await r.json();
    if (!r.ok || !o.approveUrl) throw new Error(o.error || 'could not start the payment');
    var pop = window.open(o.approveUrl, 'blockle_pay', 'width=460,height=720');
    if (stepKey) setStep(stepKey, 'active', 'approve the $' + o.usd + ' payment in the PayPal window…');
    var deadline = Date.now() + 10 * 60000;
    while (Date.now() < deadline) {
      await sleep(3000);
      var cr = await fetch('/api/launch/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: o.orderId }) });
      var cj = await cr.json().catch(function () { return {}; });
      if (cr.ok && cj.ok) { try { pop && pop.close(); } catch (_) {} return Object.assign({ orderId: o.orderId }, cj); }
      if (cj && cj.pending) { if (stepKey) setStep(stepKey, 'active', 'approve the $' + o.usd + ' payment in the PayPal window…'); continue; }
      if (cr.status === 402) { if (stepKey) setStep(stepKey, 'active', 'finishing payment…'); continue; }
      throw new Error((cj && cj.error) || 'payment did not complete');
    }
    throw new Error('payment timed out — if you paid, your fee is recorded; retry to continue');
  }

  // ---- launch ----
  $('go').onclick = run;
  async function run() {
    var err = $('err'); err.textContent = '';
    var name = $('name').value.trim(), symbol = $('symbol').value.trim();
    var decimals = parseInt($('decimals').value, 10);
    var supply = ($('supply').value || '').replace(/[^0-9]/g, '');
    var logo = $('logo').value.trim();
    var seedBlock = ($('seedBlock').value || '0').replace(/[^0-9]/g, '');
    var seedToken = ($('seedToken').value || '0').replace(/[^0-9]/g, '');
    var wantPreseed = CFG && CFG.preseedAvailable && $('preseed') && $('preseed').checked;
    if (!name || !symbol || !supply) { err.textContent = 'Name, symbol and supply are required.'; return; }
    if (BigInt(seedToken) > BigInt(supply)) { err.textContent = 'Seed tokens cannot exceed total supply.'; return; }
    if (typeof window.blockle === 'undefined') { err.textContent = 'Launching a token needs the Blockle wallet extension (the Web Wallet can’t deploy contracts yet). Install it, then retry.'; return; }
    if (!CFG || !CFG.paymentsEnabled) { err.textContent = 'Payments are not enabled yet — launches are paused.'; return; }
    // If taking the free preseed, make sure it actually goes into the pool.
    if (wantPreseed && BigInt(seedBlock) < BigInt(CFG.preseedBlock)) { seedBlock = String(CFG.preseedBlock); }

    $('form').hidden = true; $('progress').hidden = false; $('perr').textContent = '';
    try {
      // 1. connect
      setStep('connect', 'active');
      var conn = await window.blockle.connect();
      var addr = Array.isArray(conn) ? conn[0] : (conn && (conn.address || conn.addr)) || (typeof conn === 'string' ? conn : null);
      if (!addr && window.blockle.selectedAddress) addr = window.blockle.selectedAddress;
      setStep('connect', 'done', addr || '');
      var preSig = addr ? await utxoSig(addr) : null;

      // 2. pay the launch fee (service charge)
      setStep('pay', 'active');
      var pay = await payOrder({ tier: 'launch', address: addr, preseed: !!wantPreseed }, 'pay');
      var orderId = pay.orderId;
      setStep('pay', 'done', 'paid $' + (CFG.feeUsd) + (pay.preseedTxid ? ' · +' + CFG.preseedBlock + ' BLOCK preseed sent' : (pay.preseedNote ? ' · ' + pay.preseedNote : '')));

      // 2b. if a preseed was sent, wait for it to confirm so it's spendable
      if (pay.preseedTxid) { setStep('launch', 'active', 'waiting for the ' + CFG.preseedBlock + ' BLOCK preseed to confirm…'); await waitConfirmed(addr, preSig, 'launch', 'preseed'); }

      // 3. launch — ONE atomic transaction: deploy + mint + seed pool.
      if (typeof window.blockle.launchToken !== 'function') { throw new Error('Your Blockle extension is out of date — reload/update it (chrome://extensions → ↻) to launch in one transaction.'); }
      setStep('launch', 'active', 'approve the launch in your wallet…');
      var res = await window.blockle.launchToken(name, symbol, decimals, supply, seedBlock, seedToken, 300000);
      var contract = res && res.contractId; var txid = res && res.txid;
      if (!contract) throw new Error('launch did not return a contract id');
      setStep('launch', 'done', contract);

      // 4. register logo + listing (also advances the launch counter / phase)
      setStep('register', 'active');
      try { await fetch('/api/launch/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: orderId, token: contract, logo: logo }) }); } catch (_) {}
      setStep('register', 'done');

      // 5. confirm the pool appears on the DEX
      setStep('confirm', 'active', 'waiting for the block, then the pool');
      var created = await waitPoolListed(contract);
      if (!created) { throw new Error('the launch didn’t confirm a pool within a few minutes — it may still be mining. Check /token/' + contract + ' shortly. Your BLOCK is safe (the chain refunds the seed if the pool can’t be created).'); }
      setStep('confirm', 'done', txid || '');

      var done = $('done'); done.href = '/token/' + contract; done.textContent = 'View your token →'; done.hidden = false;
    } catch (e) { $('perr').textContent = (e && e.message) || String(e); }
  }

  // ---- promote (Featured / Boost) ----
  if ($('pmTier')) { $('pmTier').onchange = refreshPromotePrice; $('pmDur').onchange = refreshPromotePrice; }
  if ($('pmGo')) $('pmGo').onclick = async function () {
    var errEl = $('pmErr'), okEl = $('pmOk'); errEl.textContent = ''; okEl.textContent = '';
    var token = ($('pmToken').value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(token)) { errEl.textContent = 'Enter a valid 64-hex token contract id.'; return; }
    if (!CFG || !CFG.paymentsEnabled) { errEl.textContent = 'Payments are not enabled yet.'; return; }
    var tier = $('pmTier').value, dur = $('pmDur').value;
    $('pmGo').disabled = true;
    try {
      var r = await payOrder({ tier: tier, token: token, duration: dur });
      okEl.textContent = (tier === 'featured' ? 'Featured' : 'Boosted') + ' placement active for ' + dur + '. It shows on the DEX shortly.';
    } catch (e) { errEl.textContent = (e && e.message) || String(e); }
    finally { $('pmGo').disabled = false; refreshPromotePrice(); }
  };

  loadConfig();
})();
