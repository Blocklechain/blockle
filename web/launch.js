// launch.js — the Blockle meme-token launchpad. Builds a BLOCK-20 token,
// deploys it through the wallet, registers its logo for the DEX, mints the
// supply, and creates a 1-week-locked liquidity pool — step by step.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var wasmReady = null;
  function initWasm() {
    if (wasmReady) return wasmReady;
    if (typeof wasm_bindgen !== 'function') { wasmReady = Promise.reject(new Error('engine failed to load')); return wasmReady; }
    wasmReady = wasm_bindgen('/blockle.wasm');
    return wasmReady;
  }

  // The prototype mempool has no unconfirmed-tx chaining: a step that spends the
  // previous step's change (or calls a contract that step just deployed) is
  // rejected until that previous tx is mined. So between on-chain steps we wait
  // for the wallet's confirmed UTXO set to change before firing the next one.
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
  // Poll until the confirmed UTXO set differs from `prev` (the prior step mined
  // and produced/spent outputs). Resolves true on change, false on timeout —
  // the caller then lets the user retry that single step manually.
  async function waitConfirmed(addr, prev, k, label) {
    // No address to poll (shouldn't happen) — still hold ~2.5 min so we never
    // fire the next step into the same block as the previous unconfirmed tx.
    if (!addr) {
      if (k) setStep(k, 'active', (label || '') + ' — waiting for confirmation…');
      await sleep(150000);
      return true;
    }
    var deadline = Date.now() + 240000; // ~4 min — a few block intervals
    while (Date.now() < deadline) {
      await sleep(5000);
      var now = await utxoSig(addr);
      if (now !== null && now !== prev) return true;
      if (k) setStep(k, 'active', label + ' — waiting for confirmation…');
    }
    return false;
  }

  // Poll the DEX until the pool for `contract` is listed (created), or time out.
  async function waitPoolListed(contract) {
    var deadline = Date.now() + 180000; // ~3 min
    while (Date.now() < deadline) {
      try {
        var r = await fetch('/api/dex/pools', { cache: 'no-store' });
        if (r.ok) {
          var j = await r.json();
          var ps = (j && j.pools) || [];
          if (ps.some(function (p) { return (p.token || p.contract) === contract; })) return true;
        }
      } catch (_) {}
      await sleep(5000);
    }
    return false;
  }

  function setStep(k, state, sub) {
    var li = document.querySelector('.steps li[data-k="' + k + '"]');
    if (!li) return;
    li.classList.remove('active', 'done');
    if (state) li.classList.add(state);
    var sm = $('s-' + k);
    if (sub && sm) {
      // A "waiting…" substatus animates its trailing dots via CSS — strip any
      // literal ellipsis so it isn't doubled.
      var waiting = /waiting/i.test(sub);
      sm.classList.toggle('waiting', waiting);
      sm.textContent = waiting ? sub.replace(/[.…]+\s*$/, '') : sub;
    }
  }

  // logo preview + file -> data URL
  $('pick').onclick = function () { $('file').click(); };
  $('file').onchange = function (e) {
    var f = e.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { $('logo').value = r.result; showPrev(r.result); };
    r.readAsDataURL(f);
  };
  $('logo').addEventListener('input', function () { showPrev($('logo').value.trim()); });
  function logoUrl(v) {
    if (!v) return null;
    if (v.indexOf('ipfs://') === 0) return 'https://ipfs.io/ipfs/' + v.slice(7);
    if (/^[a-zA-Z0-9]{46,}$/.test(v)) return 'https://ipfs.io/ipfs/' + v;
    return v;
  }
  function showPrev(v) {
    var u = logoUrl(v);
    $('prev').innerHTML = u ? '<img src="' + u + '" alt="">' : 'logo';
  }

  $('go').onclick = run;

  async function run() {
    var err = $('err'); err.textContent = '';
    var name = $('name').value.trim(), symbol = $('symbol').value.trim();
    var decimals = parseInt($('decimals').value, 10);
    var supply = ($('supply').value || '').replace(/[^0-9]/g, '');
    var logo = $('logo').value.trim();
    var seedBlock = ($('seedBlock').value || '0').replace(/[^0-9]/g, '');
    var seedToken = ($('seedToken').value || '0').replace(/[^0-9]/g, '');
    if (!name || !symbol || !supply) { err.textContent = 'Name, symbol and supply are required.'; return; }
    if (BigInt(seedToken) > BigInt(supply)) { err.textContent = 'Seed tokens cannot exceed total supply.'; return; }
    if (typeof window.blockle === 'undefined') { err.textContent = 'Install/enable the Blockle wallet extension to launch a token.'; return; }

    $('form').hidden = true;
    $('progress').hidden = false;
    $('perr').textContent = '';

    try {
      // 1. connect
      setStep('connect', 'active');
      var conn = await window.blockle.connect();
      // connect() resolves to an EIP-1193-style address array ['block1…']; also
      // accept {address}/string shapes, and fall back to selectedAddress.
      var addr = Array.isArray(conn) ? conn[0]
        : (conn && (conn.address || conn.addr)) || (typeof conn === 'string' ? conn : null);
      if (!addr && window.blockle.selectedAddress) addr = window.blockle.selectedAddress;
      setStep('connect', 'done');

      // 2. launch — ONE atomic transaction: deploy + mint + seed pool. No more
      // deploy→init→pool race (which refunded the seed BLOCK if the mint wasn't
      // on-chain yet). Amounts are whole coins; the wallet scales by decimals.
      if (typeof window.blockle.launchToken !== 'function') {
        throw new Error('Your Blockle extension is out of date — reload/update it (chrome://extensions → ↻) to launch in one transaction.');
      }
      setStep('launch', 'active', 'approve in your wallet…');
      var res = await window.blockle.launchToken(name, symbol, decimals, supply, seedBlock, seedToken, 300000);
      var contract = res && res.contractId;
      var txid = res && res.txid;
      if (!contract) throw new Error('launch did not return a contract id');
      setStep('launch', 'done', contract);

      // 3. register logo (DEX stores it by contract id)
      setStep('logo', 'active');
      try {
        await fetch('/api/dex/register', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: contract, logo: logo })
        });
      } catch (_) {}
      setStep('logo', 'done');

      // 4. confirm — the single tx mines and the pool appears on the DEX.
      setStep('confirm', 'active', 'waiting for the block, then the pool');
      var created = await waitPoolListed(contract);
      if (!created) {
        throw new Error('the launch didn’t confirm a pool within a few minutes — it may still be mining. Check /token/' + contract + ' shortly. Your BLOCK is safe (the chain refunds the seed if the pool can’t be created).');
      }
      setStep('confirm', 'done', txid || '');

      var done = $('done');
      done.href = '/token/' + contract;
      done.textContent = 'View your token →';
      done.hidden = false;
    } catch (e) {
      $('perr').textContent = (e && e.message) || String(e);
    }
  }
})();
