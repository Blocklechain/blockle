/* list.js — self-serve "List an asset" form. One short form with a live price
 * ($5 base + $1/extra pair), the BLOCK pair pre-checked and non-removable, and
 * a non-custodial fee payment (pay from your wallet to the treasury, or paste a
 * txid you already sent). The relay verifies the payment before activating. */
(function () {
  'use strict';
  var EX = window.EX, $ = EX.$, esc = EX.esc;

  var EXTRA_PAIRS = ['USDC', 'USDT', 'ETH', 'SOL'];
  var LISTING_FEE_USD = 5, PER_PAIR_USD = 1;
  var selected = {};               // extra pair symbol -> true
  var payMode = 'wallet';
  var lastQuote = null, quoteTimer = null;

  // ERC-20 transfer selector for direct USDC/token fee payments from wallet.
  var ERC20_TRANSFER = '0xa9059cbb';

  function kindForChain(chain) {
    return chain === 'solana' ? 'spl' : chain === 'block' ? 'block20' : 'erc20';
  }
  function sym() { return ($('symbol').value || '').trim().toUpperCase(); }
  function assetSpec() {
    var chain = $('chain').value;
    return {
      symbol: sym(),
      chain: chain,
      kind: kindForChain(chain),
      addr: ($('addr').value || '').trim(),
      decimals: parseInt($('decimals').value, 10) || 0,
      logo: ($('logo').value || '').trim() || undefined
    };
  }
  function extraList() { return EXTRA_PAIRS.filter(function (p) { return selected[p]; }); }

  // ---- pair checkboxes ---------------------------------------------------
  function renderPairs() {
    var s = sym() || '<asset>';
    var html = '<label class="pairchk locked"><input type="checkbox" checked disabled>' +
      '<span>BLOCK / ' + esc(s) + '</span><span class="req">Required</span></label>';
    EXTRA_PAIRS.forEach(function (p) {
      html += '<label class="pairchk"><input type="checkbox" data-pair="' + p + '"' + (selected[p] ? ' checked' : '') + '>' +
        '<span>' + esc(s) + ' / ' + p + '</span><span class="muted">+$1</span></label>';
    });
    $('pairs').innerHTML = html;
    [].forEach.call($('pairs').querySelectorAll('[data-pair]'), function (cb) {
      cb.onchange = function () { selected[cb.getAttribute('data-pair')] = cb.checked; recompute(); };
    });
  }

  // ---- quote -------------------------------------------------------------
  function localTotal() { return LISTING_FEE_USD + PER_PAIR_USD * extraList().length; }
  function markets() {
    var s = sym() || '<asset>';
    var ms = ['BLOCK/' + s];
    extraList().forEach(function (p) { ms.push(s + '/' + p); });
    return ms;
  }
  function renderQuoteLocal() {
    var bd = '<div class="quote-row"><span>Asset + BLOCK pair</span><span class="mono">$' + LISTING_FEE_USD.toFixed(2) + '</span></div>';
    extraList().forEach(function (p) {
      bd += '<div class="quote-row"><span>' + (sym() || '<asset>') + '/' + p + ' pair</span><span class="mono">$' + PER_PAIR_USD.toFixed(2) + '</span></div>';
    });
    $('breakdown').innerHTML = bd;
    $('total').textContent = '$' + localTotal().toFixed(2);
    $('marketsPreview').textContent = markets().join('   ·   ');
  }
  function recompute() {
    renderPairs(); renderQuoteLocal();
    if (quoteTimer) clearTimeout(quoteTimer);
    if (!sym()) { $('payTo').textContent = '—'; $('payAmount').textContent = '—'; lastQuote = null; return; }
    quoteTimer = setTimeout(fetchQuote, 400);
  }
  async function fetchQuote() {
    try {
      var q = await EX.api.listingQuote({ asset: assetSpec(), extraPairs: extraList() });
      lastQuote = q;
      if (q.breakdown && q.breakdown.length) {
        $('breakdown').innerHTML = q.breakdown.map(function (b) {
          return '<div class="quote-row"><span>' + esc(b.item) + '</span><span class="mono">$' + Number(b.usd).toFixed(2) + '</span></div>';
        }).join('');
      }
      if (q.totalUsd != null) $('total').textContent = '$' + Number(q.totalUsd).toFixed(2);
      if (q.markets && q.markets.length) $('marketsPreview').textContent = q.markets.join('   ·   ');
      $('payTo').textContent = q.payTo || '—';
      var amt = q.payAmount != null ? q.payAmount : (q.payAsset && q.payAsset.extra && q.payAsset.extra.amount);
      if (amt != null && q.payAsset) {
        $('payAmount').textContent = EX.fmtNum(EX.toHuman(amt, q.payAsset.decimals), 6) + ' ' + (q.payAsset.symbol || '');
      } else {
        $('payAmount').textContent = '$' + Number(q.totalUsd || localTotal()).toFixed(2) + ' equivalent';
      }
    } catch (e) {
      // relay quote unavailable — keep the local estimate, no treasury address.
      lastQuote = null;
      $('payTo').textContent = '(relay unavailable — paste a txid instead)';
    }
  }

  // ---- fee payment -------------------------------------------------------
  function hex32(hexNo0x) { while (hexNo0x.length < 64) hexNo0x = '0' + hexNo0x; return hexNo0x; }
  function erc20TransferData(to, amountBase) {
    var addr = to.toLowerCase().replace(/^0x/, '');
    var amt = BigInt(amountBase).toString(16);
    return ERC20_TRANSFER + hex32(addr) + hex32(amt);
  }

  // Pay the fee from the connected wallet, non-custodially, to the treasury
  // address the relay returned. Returns the payment txid.
  async function payFromWallet() {
    if (!lastQuote || !lastQuote.payTo) throw new Error('No treasury address yet — the relay quote is unavailable; use "I already paid" and paste your txid.');
    var pa = lastQuote.payAsset || {};
    var amt = lastQuote.payAmount != null ? lastQuote.payAmount : (pa.extra && pa.extra.amount);
    if (amt == null) throw new Error('Quote has no exact base-unit amount; pay the fee manually and paste the txid.');

    var chain = pa.chain || 'base';
    if (chain === 'block') {
      if (!window.blockle) throw new Error('Blockle wallet not found');
      await window.blockle.connect();
      var fn = window.blockle.transfer || window.blockle.send;
      if (!fn) throw new Error('Blockle wallet cannot send BLOCK from here; pay manually and paste the txid.');
      var r = await fn.call(window.blockle, lastQuote.payTo, String(amt));
      return (r && (r.txid || r.hash)) || r;
    }
    if (chain === 'solana') {
      throw new Error('Direct SOL/SPL fee payment from the browser is not supported here — pay manually and paste the txid (or list via the SDK over x402).');
    }
    // EVM chains: native coin -> value transfer; token -> ERC-20 transfer call.
    if (!window.ethereum) throw new Error('MetaMask / EVM wallet not found');
    var accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    var from = accts[0];
    var tx;
    if (pa.kind === 'erc20' && pa.addr) {
      tx = { from: from, to: pa.addr, data: erc20TransferData(lastQuote.payTo, amt) };
    } else {
      tx = { from: from, to: lastQuote.payTo, value: '0x' + BigInt(amt).toString(16) };
    }
    var hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
    return hash;
  }

  async function submitListing() {
    var err = $('listErr'); err.textContent = ''; err.className = 'err';
    if (!sym()) { err.textContent = 'Enter a symbol.'; return; }
    if ($('chain').value !== 'block' && !assetSpec().addr) { err.textContent = 'Enter the contract / mint address.'; return; }
    var btn = $('listBtn'); var orig = btn.textContent;
    btn.disabled = true;
    try {
      var paymentTxid;
      if (payMode === 'txid') {
        paymentTxid = ($('txidInput').value || '').trim();
        if (!paymentTxid) throw new Error('Paste the txid of your fee payment.');
      } else {
        btn.textContent = 'Confirm payment in wallet…';
        paymentTxid = await payFromWallet();
        EX.toast('Fee sent: ' + EX.shortAddr(paymentTxid), 'ok');
      }
      btn.textContent = 'Activating listing…';
      var res = await EX.api.createListing({
        asset: assetSpec(),
        extraPairs: extraList(),
        paymentTxid: paymentTxid
      });
      err.className = 'ok';
      err.textContent = 'Listed! ' + ((res && res.markets && res.markets.join(', ')) || '');
      EX.toast('Asset listed — markets are live', 'ok');
      loadListings();
    } catch (e) {
      err.textContent = (e && e.message) || 'Listing failed.';
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // ---- live listings -----------------------------------------------------
  async function loadListings() {
    try {
      var ls = await EX.api.listings() || [];
      if (!ls.length) { $('listings').innerHTML = '<div class="empty">No listings yet — be the first.</div>'; return; }
      $('listings').innerHTML = ls.map(function (l) {
        var a = l.asset || {};
        return '<div class="listing-row"><b>' + esc(a.symbol || '?') + '</b>' +
          '<span class="muted">' + esc(a.chain || '') + '/' + esc(a.kind || '') + '</span>' +
          '<span class="muted mono" style="margin-left:auto;font-size:11px">' + esc((l.markets || []).join(' · ')) + '</span></div>';
      }).join('');
    } catch (e) { $('listings').innerHTML = '<div class="empty">Could not load listings</div>'; }
  }

  // ---- wire up -----------------------------------------------------------
  function init() {
    EX.mountWalletBar($('walletBar'));
    $('symbol').addEventListener('input', recompute);
    $('chain').addEventListener('change', function () {
      // default decimals + address label hint per chain
      var c = $('chain').value;
      $('addrLbl').textContent = c === 'solana' ? 'Mint address' : c === 'block' ? 'Contract id' : 'Contract address';
      if (c === 'solana') $('decimals').value = '9';
      else if (c === 'block') $('decimals').value = '8';
      else $('decimals').value = '18';
      recompute();
    });
    ['addr', 'decimals', 'logo'].forEach(function (id) { $(id).addEventListener('input', recompute); });
    [].forEach.call($('payOpts').querySelectorAll('button'), function (b) {
      b.onclick = function () {
        payMode = b.getAttribute('data-pay');
        [].forEach.call($('payOpts').querySelectorAll('button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        $('payWallet').style.display = payMode === 'wallet' ? 'block' : 'none';
        $('payTxid').style.display = payMode === 'txid' ? 'block' : 'none';
      };
    });
    $('listBtn').onclick = submitListing;
    recompute();
    loadListings();
  }
  init();
})();
